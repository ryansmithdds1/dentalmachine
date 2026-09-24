import { insert, practiceNow } from './util.js';
import { primaryPolicy } from './services.js';
import { withPlan } from './benefits.js';
import { addInterval } from './memberships.js';
import { trackedCharge, mayCharge, chargeDeclined, chargeSucceeded } from './billingauto.js';

// Orthodontic contracts: insurance pays up to the plan's lifetime ortho maximum (at its ortho percentage, if
// the patient is under the age limit); the patient's part is a down payment plus equal monthly charges,
// posted each month and charged to a saved card when autopay is on.
export async function orthoEstimate(db, practiceId, patient, { total_fee, down_payment = 0, months, excludeCaseId = null }) {
  const total = Math.round(Number(total_fee));
  const down = Math.round(Number(down_payment) || 0);
  const n = Math.round(Number(months));
  const policy = await primaryPolicy(db, practiceId, patient.id);
  let insurance = 0;
  let note = 'No insurance on file';
  if (policy) {
    const { plan } = await withPlan(db, policy);
    const today = (await practiceNow(db, practiceId)).slice(0, 10);
    const age = patient.dob ? Math.floor((new Date(today) - new Date(patient.dob)) / (365.25 * 86400_000)) : null;
    const used = (await db.get("SELECT COALESCE(SUM(insurance_estimate), 0) AS n FROM ortho_cases WHERE patient_id = ? AND status != 'cancelled' AND id != ?", patient.id, excludeCaseId ?? 0)).n;
    if (!plan.ortho_max) note = `${policy.carrier_name}: no orthodontic coverage`;
    else if (plan.ortho_age_limit != null && (age == null || age >= plan.ortho_age_limit)) note = `${policy.carrier_name}: ortho covered only under age ${plan.ortho_age_limit}`;
    else {
      insurance = Math.max(0, Math.min(plan.ortho_max - used, Math.round((total * (plan.ortho_pct ?? 50)) / 100)));
      note = `${policy.carrier_name}: ${plan.ortho_pct ?? 50}% up to a $${(plan.ortho_max / 100).toFixed(0)} lifetime maximum${used ? ` ($${(used / 100).toFixed(0)} already used)` : ''}`;
    }
  }
  const patientPart = Math.max(0, total - insurance);
  const financed = Math.max(0, patientPart - down);
  const monthly = n > 0 ? Math.floor(financed / n) : 0;
  return { total_fee: total, insurance_estimate: insurance, insurance_note: note, patient_portion: patientPart, down_payment: down, months: n, monthly_amount: monthly, last_month: financed - monthly * Math.max(0, n - 1) };
}

// Posts each month's charge that has come due, and charges the card when autopay is on.
export async function runOrthoBilling(db, payments, { caseId = null, messenger = null } = {}) {
  const results = [];
  const due = await db.all(`SELECT id, practice_id FROM ortho_cases WHERE status IN ('active','retention') AND billed_months < months${caseId ? ' AND id = ?' : ''}`, ...(caseId ? [caseId] : []));
  for (const { id, practice_id: pid } of due) {
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const lock = new Date(Date.now() + 10 * 60_000).toISOString();
    const took = await db.run('UPDATE ortho_cases SET billing_lock = ? WHERE id = ? AND (billing_lock IS NULL OR billing_lock < ?)', lock, id, new Date().toISOString());
    if (!took.changes) continue;
    try {
      for (let i = 0; i < 12; i++) {
        const c = await db.get('SELECT * FROM ortho_cases WHERE id = ?', id);
        if (c.billed_months >= c.months || !c.next_bill_date || c.next_bill_date > today) break;
        if (c.billing_failures && (c.billing_message || '').endsWith(`(${today})`)) break;
        const month = c.billed_months + 1;
        const amount = month === c.months ? c.total_fee - c.insurance_estimate - c.down_payment - c.monthly_amount * (c.months - 1) : c.monthly_amount;
        const ref = `ortho:${c.id}:${month}`;
        await db.tx(async () => {
          if (await db.get("SELECT id FROM ledger_entries WHERE ortho_case_id = ? AND type = 'charge' AND reference = ?", c.id, ref)) return;
          await insert(db, 'ledger_entries', {
            practice_id: c.practice_id, patient_id: c.patient_id, type: 'charge', amount, provider_id: c.provider_id,
            description: `Orthodontic treatment — month ${month} of ${c.months}`, reference: ref, entry_date: today, ortho_case_id: c.id,
          });
        });
        let charged = false;
        // While a declined month waits for its retry day (billingauto.js retries it), a new month isn't charged on top.
        if (c.autopay && c.payment_method_id && payments?.enabled && amount > 0 && (await mayCharge(db, 'ortho_case', c.id, c.payment_method_id, today))) {
          const method = await db.get('SELECT * FROM payment_methods WHERE id = ? AND removed_at IS NULL', c.payment_method_id);
          if (method) {
            const practice = await db.get('SELECT name FROM practices WHERE id = ?', c.practice_id);
            const out = await trackedCharge(db, payments, { method, amount, description: `${practice.name} — orthodontic payment ${month} of ${c.months}`, idempotencyKey: `ortho-${c.id}-${month}-${c.billing_failures}`, metadata: { ortho_case_id: c.id, patient_id: c.patient_id } },
              { practiceId: c.practice_id, patientId: c.patient_id, sourceType: 'ortho_case', sourceId: c.id });
            if (out.ambiguous) { results.push({ case_id: c.id, month, pending: true }); break; }
            if (!out.ok) {
              await db.run('UPDATE ortho_cases SET billing_failures = billing_failures + 1, billing_message = ? WHERE id = ?', `${out.reason} (${today})`, c.id);
              // Dunning (billingauto.js): Needs attention, the patient's update-card link, retries, then paused.
              await chargeDeclined(db, messenger, { practiceId: c.practice_id, patientId: c.patient_id, sourceType: 'ortho_case', sourceId: c.id, methodId: method.id, amount, reason: out.reason, today });
              results.push({ case_id: c.id, month, declined: true, reason: out.reason });
              // The month is still billed to the account; the card is tried again tomorrow.
            } else {
              await insert(db, 'ledger_entries', {
                practice_id: c.practice_id, patient_id: c.patient_id, type: 'payment', amount: -out.total, method: 'credit_card', reference: out.reference,
                description: `Ortho autopay (${method.brand || 'card'} •••• ${method.last4})`, entry_date: today, ortho_case_id: c.id,
              });
              await chargeSucceeded(db, { practiceId: c.practice_id, sourceType: 'ortho_case', sourceId: c.id, today });
              charged = true;
            }
          }
        }
        await db.run('UPDATE ortho_cases SET billed_months = ?, next_bill_date = ?, billing_failures = CASE WHEN ? THEN 0 ELSE billing_failures END, billing_message = ? WHERE id = ?',
          month, addInterval(c.start_date, 'month', month + 1), charged ? 1 : 0, charged ? `Charged $${(amount / 100).toFixed(2)} on ${today}` : c.billing_failures ? c.billing_message : `Billed $${(amount / 100).toFixed(2)} on ${today}`, c.id);
        results.push({ case_id: c.id, month, amount, charged });
      }
    } finally {
      await db.run('UPDATE ortho_cases SET billing_lock = NULL WHERE id = ? AND billing_lock = ?', id, lock);
    }
  }
  return results;
}
