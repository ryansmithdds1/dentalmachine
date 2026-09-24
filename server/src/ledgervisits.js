// The ledger grouped by visit: each visit's charges, the claim(s) for them, and the insurance payments,
// write-offs, patient payments and adjustments that belong to it, with what's left on the visit. Worked out
// from the ledger's own links every time — nothing here is stored:
//  - a charge belongs to its procedure's appointment (else the day it was posted) — chargeVisitKey;
//  - insurance payments and write-offs follow their claim to the visit of the claim's procedures;
//  - an entry tied to a procedure (a plan discount) goes with that procedure's charge;
//  - a payment or adjustment staff applied to a visit (applied_to_id) goes with that visit;
//  - a reversal goes with what it reverses, a refund with the payment it refunds;
//  - anything else is "Not applied to a visit".
// A visit's balance is SUM(amount) of its entries, so the visits plus the unapplied group always add up to
// the account balance.
import { chargeVisitKey } from './allocation.js';

export const UNAPPLIED = 'unapplied';

// What kind of line this is, for colour coding and the legend. Voided entries and reversals keep their kind
// (the screen mutes them separately).
export function entryKind(e) {
  if (e.type === 'charge') return 'charge';
  if (e.type === 'payment') return 'patient_payment';
  if (e.type === 'insurance_payment') return 'insurance_payment';
  if (e.type === 'refund') return 'refund';
  if (e.type === 'adjustment') {
    if (e.amount > 0) return 'debit_adjustment';
    return e.claim_id || e.adjustment_type === 'Insurance write-off' ? 'write_off' : 'credit_adjustment';
  }
  return 'other';
}

// Why an entry can't be applied to (or taken off) a visit, or null if it can. Only a patient's own payments
// and adjustments are moved; insurance entries follow their claim, and closed books don't change.
export function linkProblem(entry, lockDate) {
  if (!['payment', 'adjustment'].includes(entry.type)) return 'Only payments and adjustments can be applied to a visit';
  if (entry.claim_id) return `This came from insurance claim #${entry.claim_id} — it already belongs to that claim's visit`;
  if (entry.procedure_id) return 'This is already tied to a procedure';
  if (entry.voided_at || entry.reverses_id) return 'Voided entries and reversals stay where they are';
  if (entry.transfer_id) return 'Family transfers stay where they are';
  if (lockDate && entry.entry_date <= lockDate) return `The books are closed through ${lockDate} — this entry can't be moved`;
  return null;
}

// entries: the patient's ledger rows (with visit_appointment_id, visit_start, visit_reason, visit_provider joined
// from the procedure's appointment); claims: the patient's claims (id, status, carrier_name, estimated_amount,
// paid_amount, write_off_estimate); claimLines: [{ claim_id, procedure_id }].
export function groupByVisit(entries, claims = [], claimLines = []) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ordered = [...entries].sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id));
  const chargeOf = new Map();
  for (const e of ordered) {
    if (e.type !== 'charge' || !e.procedure_id) continue;
    const had = chargeOf.get(e.procedure_id);
    if (!had || (had.voided_at && !e.voided_at && !e.reverses_id)) chargeOf.set(e.procedure_id, e);
  }
  const claimCharge = new Map();
  for (const l of claimLines) {
    const c = chargeOf.get(l.procedure_id);
    const had = claimCharge.get(l.claim_id);
    if (c && (!had || c.entry_date < had.entry_date || (c.entry_date === had.entry_date && c.id < had.id))) claimCharge.set(l.claim_id, c);
  }
  const memo = new Map();
  const keyOf = (e, depth = 0) => {
    if (memo.has(e.id)) return memo.get(e.id);
    let key = UNAPPLIED;
    const follow = (id) => (byId.has(id) && depth < 5 ? keyOf(byId.get(id), depth + 1) : null);
    if (e.reverses_id && byId.has(e.reverses_id)) key = follow(e.reverses_id);
    else if (e.type === 'charge') key = chargeVisitKey(e);
    else if (e.applied_to_id && byId.get(e.applied_to_id)?.type === 'charge') key = follow(e.applied_to_id);
    else if (e.procedure_id && chargeOf.has(e.procedure_id)) key = chargeVisitKey(chargeOf.get(e.procedure_id));
    else if (e.claim_id && claimCharge.has(e.claim_id)) key = chargeVisitKey(claimCharge.get(e.claim_id));
    else if (e.refund_of_id && byId.has(e.refund_of_id)) key = follow(e.refund_of_id);
    key = key || UNAPPLIED;
    memo.set(e.id, key);
    return key;
  };

  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key, appointment_id: null, date: null, reason: null, provider_name: null, anchor_id: null, entry_ids: [], claims: [],
        totals: { charges: 0, fees: 0, insurance_paid: 0, write_off: 0, patient_paid: 0, adjusted: 0, refunded: 0 }, balance: 0,
        insurance_expected: 0, write_off_expected: 0,
      });
    }
    return groups.get(key);
  };
  const TOTAL = { charge: 'charges', debit_adjustment: 'fees', credit_adjustment: 'adjusted', write_off: 'write_off', insurance_payment: 'insurance_paid', patient_payment: 'patient_paid', refund: 'refunded' };
  for (const e of ordered) {
    const key = keyOf(e);
    const g = group(key);
    e.visit_key = key;
    g.entry_ids.push(e.id);
    g.balance += e.amount;
    // Totals show what's live; a void and its reversal cancel out and are left out (the balance already nets them).
    if (!e.voided_at && !e.reverses_id) {
      const t = TOTAL[entryKind(e)];
      // Shown as plain amounts ("insurance paid $150"); which way each moves the balance is in its name.
      if (t) g.totals[t] += Math.abs(e.amount);
    }
    if (key !== UNAPPLIED && e.type === 'charge' && !g.anchor_id && !e.voided_at && !e.reverses_id) {
      g.anchor_id = e.id;
      g.appointment_id = e.visit_appointment_id ?? null;
      g.date = e.visit_start ? String(e.visit_start).slice(0, 10) : e.entry_date;
      g.reason = e.visit_reason || null;
      g.provider_name = e.visit_provider || e.provider_name || null;
    }
    if (!g.date) g.date = e.visit_start ? String(e.visit_start).slice(0, 10) : e.entry_date;
  }
  // Each claim is shown once, on the visit of its procedures, with what's still expected from it.
  for (const c of claims) {
    const charge = claimCharge.get(c.id);
    if (!charge) continue;
    const g = groups.get(chargeVisitKey(charge));
    if (!g) continue;
    const open = ['draft', 'submitted', 'partially_paid'].includes(c.status);
    const expected = open ? Math.max(0, (c.estimated_amount || 0) - (c.paid_amount || 0)) : 0;
    const writeOff = ['draft', 'submitted'].includes(c.status) ? c.write_off_estimate || 0 : 0;
    g.claims.push({ id: c.id, status: c.status, carrier_name: c.carrier_name || null, priority: c.priority || null, expected, write_off_expected: writeOff });
    g.insurance_expected += expected;
    g.write_off_expected += writeOff;
  }
  const unapplied = groups.get(UNAPPLIED) || null;
  groups.delete(UNAPPLIED);
  const visits = [...groups.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.entry_ids[0] - a.entry_ids[0]));
  return { visits, unapplied };
}
