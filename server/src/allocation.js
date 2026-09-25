// Payment allocation: which charges (and so which providers) each payment, insurance payment and credit
// adjustment paid for. Worked out from the ledger when needed rather than stored, so it can't drift:
//  - insurance payments and write-offs go to the procedures on their claim, by what the payer paid per line;
//  - a payment or adjustment staff applied to a visit (applied_to_id → one of that visit's charges) pays that
//    visit's charges first;
//  - everything else pays the oldest open charges first;
//  - voided entries and their reversals cancel out and are left out;
//  - whatever a credit can't be applied to is unapplied credit on the account.

// Which visit a charge belongs to: its procedure's appointment, else the day it was posted. Rows carry the
// appointment as visit_appointment_id (joined from procedures); the same key groups the ledger by visit
// (ledgervisits.js) and "Why this balance" (billing.js), so all three agree.
export const chargeVisitKey = (e) => (e.visit_appointment_id ? `a${e.visit_appointment_id}` : `d${e.entry_date}`);

// entries: one patient's ledger rows; claimLines: [{ claim_id, procedure_id, paid_amount, adjusted_amount }].
// A gift certificate being used pays a charge like a payment would, but it isn't a collection (the money was collected
// when the certificate was sold) nor a write-off: it gets its own credit type, so neither total counts it.
const creditType = (e) => (e.type === 'adjustment' && e.gift_certificate_id ? 'gift_certificate' : e.type);
export function allocate(entries, claimLines = []) {
  const live = entries.filter((e) => !e.voided_at && !e.reverses_id).sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id));
  const charges = live.filter((e) => e.amount > 0 && e.type !== 'refund').map((e) => ({ ...e, open: e.amount }));
  const byProcedure = new Map(charges.filter((c) => c.procedure_id).map((c) => [c.procedure_id, c]));
  const allocations = [];
  const unapplied = [];
  const apply = (credit, charge, amount) => {
    if (amount <= 0) return 0;
    const part = Math.min(amount, charge.open);
    if (part <= 0) return 0;
    charge.open -= part;
    allocations.push({ credit_id: credit.id, credit_type: creditType(credit), credit_date: credit.entry_date, charge_id: charge.id, procedure_id: charge.procedure_id ?? null, provider_id: charge.provider_id ?? null, amount: part });
    return part;
  };
  for (const credit of live.filter((e) => e.amount < 0)) {
    let left = -credit.amount;
    if (credit.claim_id) {
      // Targeted: the claim's procedures, weighted by what the payer paid (or wrote off) on each line.
      const key = credit.type === 'insurance_payment' ? 'paid_amount' : 'adjusted_amount';
      const lines = claimLines.filter((l) => l.claim_id === credit.claim_id && byProcedure.has(l.procedure_id));
      const weight = lines.reduce((s, l) => s + (l[key] || 0), 0);
      for (const l of lines) {
        if (left <= 0) break;
        const want = weight > 0 ? Math.round((-credit.amount * (l[key] || 0)) / weight) : Math.ceil(-credit.amount / lines.length);
        left -= apply(credit, byProcedure.get(l.procedure_id), Math.min(want, left));
      }
      for (const l of lines) if (left > 0) left -= apply(credit, byProcedure.get(l.procedure_id), left);
    } else if (credit.applied_to_id) {
      // Applied to a visit by staff: that visit's charges first, oldest first; anything over goes on as usual.
      const anchor = charges.find((c) => c.id === credit.applied_to_id);
      const visit = anchor ? chargeVisitKey(anchor) : null;
      for (const c of charges) {
        if (left <= 0 || !visit) break;
        if (chargeVisitKey(c) === visit) left -= apply(credit, c, left);
      }
    }
    for (const c of charges) {
      if (left <= 0) break;
      left -= apply(credit, c, left);
    }
    if (left > 0) unapplied.push({ credit_id: credit.id, credit_type: creditType(credit), credit_date: credit.entry_date, amount: left });
  }
  // Refunds give back unapplied credit.
  let refunded = live.filter((e) => e.type === 'refund').reduce((s, e) => s + e.amount, 0);
  for (const u of unapplied) {
    const take = Math.min(u.amount, refunded);
    u.amount -= take;
    refunded -= take;
  }
  return {
    allocations,
    unapplied: unapplied.filter((u) => u.amount > 0),
    open_charges: charges.filter((c) => c.open > 0).map((c) => ({ id: c.id, procedure_id: c.procedure_id, provider_id: c.provider_id, entry_date: c.entry_date, open: c.open })),
  };
}

// Allocations for every patient with credits in [from, to] (for collections-by-provider reporting).
export async function allocationsForRange(db, practiceId, from, to) {
  const patientIds = (await db.all(
    'SELECT DISTINCT patient_id FROM ledger_entries WHERE practice_id = ? AND amount < 0 AND entry_date BETWEEN ? AND ?', practiceId, from, to,
  )).map((r) => r.patient_id);
  if (!patientIds.length) return [];
  const out = [];
  // In chunks, to keep each query's parameter list reasonable.
  for (let i = 0; i < patientIds.length; i += 500) {
    const ids = patientIds.slice(i, i + 500);
    const inList = ids.map(() => '?').join(',');
    const entries = await db.all(
      `SELECT l.*, pr.appointment_id AS visit_appointment_id FROM ledger_entries l LEFT JOIN procedures pr ON pr.id = l.procedure_id
       WHERE l.practice_id = ? AND l.patient_id IN (${inList})`, practiceId, ...ids,
    );
    const lines = await db.all(
      `SELECT ci.claim_id, ci.procedure_id, ci.paid_amount, ci.adjusted_amount FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.practice_id = ? AND c.patient_id IN (${inList})`,
      practiceId, ...ids,
    );
    const byPatient = new Map();
    for (const e of entries) {
      if (!byPatient.has(e.patient_id)) byPatient.set(e.patient_id, []);
      byPatient.get(e.patient_id).push(e);
    }
    for (const [pid, list] of byPatient) {
      const claimIds = new Set(list.map((e) => e.claim_id).filter(Boolean));
      const { allocations, unapplied } = allocate(list, lines.filter((l) => claimIds.has(l.claim_id)));
      for (const a of allocations) if (a.credit_date >= from && a.credit_date <= to) out.push({ ...a, patient_id: pid });
      for (const u of unapplied) if (u.credit_date >= from && u.credit_date <= to) out.push({ ...u, patient_id: pid, provider_id: null, unapplied: true });
    }
  }
  return out;
}
