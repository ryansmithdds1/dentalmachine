import { autoReceipt } from './receipts.js';
import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { preferredChannel, sendMessage } from './messaging.js';
import { messageText, patientLang, subjectFor } from './templates.js';

// In-house membership plans for patients without insurance: a monthly or yearly fee, some services
// included each membership year (cleanings, exams, x-rays), and a discount on everything else.
// The fee posts to the ledger each period and is charged to the card on file; the benefits come off
// each procedure as it's completed.

export const INTERVALS = ['month', 'year'];

export function cleanIncluded(list) {
  if (list == null) return '[]';
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'included must be a list');
  return JSON.stringify(list.map((x, i) => {
    const codes = [...new Set(String(x?.codes || '').toUpperCase().split(/[\s,]+/).filter((c) => /^D\d{1,4}$/.test(c)))];
    const perYear = Number(x?.per_year);
    if (!codes.length) throw new HttpError(400, `Included service ${i + 1}: add procedure codes`);
    if (!Number.isInteger(perYear) || perYear < 1 || perYear > 52) throw new HttpError(400, `Included service ${i + 1}: times per year must be 1-52`);
    return { label: String(x.label || codes.join(', ')).slice(0, 80), codes, per_year: perYear };
  }));
}

export const addInterval = (date, interval, n = 1) => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  // The 31st in a 30-day month becomes the 30th, not the 1st of the next month.
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

// The membership year a date falls in: from the latest anniversary of the start date.
export function membershipYear(startDate, onDate) {
  let from = startDate;
  while (addInterval(from, 'year') <= onDate) from = addInterval(from, 'year');
  return { from, to: addInterval(from, 'year') };
}

// The membership whose benefits apply on a date: active or past due, or cancelled but already paid through it.
export async function membershipOn(db, patientId, date) {
  return await db.get(
    `SELECT m.*, p.name AS plan_name, p.discount_pct, p.included, p.price, p.interval
     FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
     WHERE m.patient_id = ? AND m.start_date <= ? AND (m.status IN ('active','past_due') OR (m.status = 'cancelled' AND m.paid_through > ?))
     ORDER BY m.id DESC LIMIT 1`,
    patientId, date, date,
  );
}

const ruleFor = (m, code) => JSON.parse(m.included || '[]').find((r) => r.codes.some((c) => String(code).startsWith(c)));

// How many times an included service has been used this membership year.
async function usedThisYear(db, m, rule, date) {
  const { from } = membershipYear(m.start_date, date);
  const rows = await db.all(
    `SELECT pr.code FROM ledger_entries l JOIN procedures pr ON pr.id = l.procedure_id
     WHERE l.membership_id = ? AND l.adjustment_type = 'Membership included' AND l.entry_date >= ? AND l.voided_at IS NULL AND l.reverses_id IS NULL`,
    m.id, from,
  );
  return rows.filter((r) => rule.codes.some((c) => r.code.startsWith(c))).length;
}

// What a member saves on a procedure: included (the patient's whole share) or the plan discount.
export async function memberBenefit(db, m, procedure, patientShare, date, extraUsed = 0) {
  if (!m || patientShare <= 0) return null;
  const rule = ruleFor(m, procedure.code);
  if (rule && (await usedThisYear(db, m, rule, date)) + extraUsed < rule.per_year) {
    return { type: 'Membership included', off: patientShare, label: `${rule.label} included with ${m.plan_name}`, rule };
  }
  if (m.discount_pct > 0) {
    const off = Math.round((patientShare * m.discount_pct) / 100);
    if (off > 0) return { type: 'Membership discount', off, label: `${m.discount_pct}% ${m.plan_name} discount` };
  }
  return null;
}

// Posts the benefit when a procedure is completed (inside completeProcedure's transaction).
export async function applyMemberBenefit(db, procedure, patientShare, { date, userId, providerId }) {
  const m = await membershipOn(db, procedure.patient_id, date);
  const b = await memberBenefit(db, m, procedure, patientShare, date);
  if (!b) return false;
  await insert(db, 'ledger_entries', {
    practice_id: procedure.practice_id, patient_id: procedure.patient_id, type: 'adjustment', adjustment_type: b.type, amount: -b.off,
    description: `${b.label} — ${procedure.code}${procedure.tooth ? ` #${procedure.tooth}` : ''}`,
    procedure_id: procedure.id, provider_id: providerId, entry_date: date, created_by: userId, membership_id: m.id,
  });
  return true;
}

// Member savings on planned work, for treatment plan estimates.
export async function memberSavings(db, patientId, items, date) {
  const m = await membershipOn(db, patientId, date);
  if (!m) return null;
  const used = new Map();
  const out = [];
  for (const it of items) {
    const rule = ruleFor(m, it.code);
    const key = rule ? rule.codes.join() : null;
    const b = await memberBenefit(db, m, it, it.patient, date, key ? used.get(key) || 0 : 0);
    if (b?.type === 'Membership included') used.set(key, (used.get(key) || 0) + 1);
    out.push({ procedure_id: it.procedure_id, off: b?.off || 0, included: b?.type === 'Membership included' });
  }
  return { plan_name: m.plan_name, discount_pct: m.discount_pct, items: out, total: out.reduce((s, x) => s + x.off, 0) };
}

// ---- Billing ----
// Posts the fee for one period and, with a card on file, charges it. Returns what happened.
async function billPeriod(db, payments, m, today, messenger) {
  const periodEnd = addInterval(m.next_bill_date, m.interval);
  const label = `${m.plan_name} membership ${m.next_bill_date} to ${periodEnd}`;
  await db.tx(async () => {
    if (await db.get("SELECT id FROM ledger_entries WHERE membership_id = ? AND type = 'charge' AND reference = ?", m.id, `period:${m.next_bill_date}`)) return;
    await insert(db, 'ledger_entries', {
      practice_id: m.practice_id, patient_id: m.patient_id, type: 'charge', amount: m.price, description: label,
      reference: `period:${m.next_bill_date}`, entry_date: today, membership_id: m.id,
    });
  });
  const result = { membership_id: m.id, period: m.next_bill_date, amount: m.price, charged: false };
  if (m.autopay && m.payment_method_id && payments?.enabled) {
    const method = await db.get('SELECT * FROM payment_methods WHERE id = ? AND removed_at IS NULL', m.payment_method_id);
    if (method) {
      const practice = await db.get('SELECT name FROM practices WHERE id = ?', m.practice_id);
      const out = await payments.charge({
        method, amount: m.price, description: `${practice.name} — ${label}`,
        idempotencyKey: `membership-${m.id}-${m.next_bill_date}-${m.billing_failures || 0}`, metadata: { membership_id: m.id, patient_id: m.patient_id },
      });
      if (out.ambiguous) return { ...result, pending: true, reason: out.reason };
      if (out.ok) {
        const entryId = await db.tx(async () => {
          if (await db.get("SELECT id FROM ledger_entries WHERE membership_id = ? AND type = 'payment' AND reference = ?", m.id, out.reference)) return null;
          return insert(db, 'ledger_entries', {
            practice_id: m.practice_id, patient_id: m.patient_id, type: 'payment', amount: -m.price, method: 'credit_card', reference: out.reference,
            description: `Membership autopay (${method.brand || 'card'} •••• ${method.last4})`, entry_date: today, membership_id: m.id,
          });
        });
        if (entryId) await autoReceipt(db, messenger, entryId);
        result.charged = true;
      } else {
        await db.run("UPDATE memberships SET status = 'past_due', billing_failures = billing_failures + 1, billing_message = ? WHERE id = ?", `${out.reason} (${today})`, m.id);
        // The office gets a task the first time; the patient gets a note asking them to update the card.
        if (!m.billing_failures) {
          const patient = await db.get('SELECT * FROM patients WHERE id = ?', m.patient_id);
          await insert(db, 'tasks', { practice_id: m.practice_id, patient_id: m.patient_id, priority: 'high', due_date: today, title: `Membership payment declined: ${patient.first_name} ${patient.last_name} — ${out.reason}` });
          const target = preferredChannel(patient);
          if (target && messenger) {
            await sendMessage(db, messenger, {
              practiceId: m.practice_id, patientId: patient.id, kind: 'payment_request', channel: target.channel, to: target.to,
              subject: subjectFor(patientLang(patient), 'card_declined', `Membership payment didn't go through — ${practice.name}`, practice.name),
              body: await messageText(db, m.practice_id, 'card_declined', { first_name: patient.first_name, amount: m.price, reason: out.reason }, patientLang(patient)),
            }).catch(() => {});
          }
        }
        return { ...result, declined: true, reason: out.reason };
      }
    }
  }
  await db.run(
    "UPDATE memberships SET next_bill_date = ?, paid_through = ?, status = 'active', billing_failures = 0, billing_message = ? WHERE id = ?",
    periodEnd, periodEnd, result.charged ? `Charged $${(m.price / 100).toFixed(2)} on ${today}` : `Billed $${(m.price / 100).toFixed(2)} to the account on ${today}`, m.id,
  );
  return result;
}

// Bills every membership that's due (catching up at most a year of missed periods), once a day.
export async function runMembershipBilling(db, payments, { membershipId = null, messenger = null } = {}) {
  const due = await db.all(
    `SELECT m.id, m.practice_id FROM memberships m WHERE m.status IN ('active','past_due')${membershipId ? ' AND m.id = ?' : ''}`,
    ...(membershipId ? [membershipId] : []),
  );
  const results = [];
  for (const { id, practice_id: pid } of due) {
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const lock = new Date(Date.now() + 10 * 60_000).toISOString();
    const took = await db.run('UPDATE memberships SET billing_lock = ? WHERE id = ? AND (billing_lock IS NULL OR billing_lock < ?)', lock, id, new Date().toISOString());
    if (!took.changes) continue;
    try {
      for (let i = 0; i < 13; i++) {
        const m = await db.get(
          'SELECT m.*, p.name AS plan_name, p.price, p.interval FROM memberships m JOIN membership_plans p ON p.id = m.plan_id WHERE m.id = ?', id,
        );
        if (m.next_bill_date > today || !['active', 'past_due'].includes(m.status)) break;
        // A declined card is retried once a day, not every run.
        if (m.status === 'past_due' && (m.billing_message || '').endsWith(`(${today})`)) break;
        // The card is charged between two short transactions, never inside one.
        const r = await billPeriod(db, payments, m, today, messenger);
        results.push(r);
        if (r.declined || r.pending) break;
      }
    } finally {
      await db.run('UPDATE memberships SET billing_lock = NULL WHERE id = ? AND billing_lock = ?', id, lock);
    }
  }
  return results;
}
