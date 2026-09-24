import { localNow } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { addDays, daysBetween } from './cadence.js';
import { money } from './eobauto.js';

// ---- Insurance reconciliation, day by day (backlog A5) ----
// Two chains are compared wherever money crosses a boundary, and every gap is listed (and raised in Needs
// attention by the daily pass, resolved when it closes):
//   remittances: ERA/EOB total → claim rows (+ provider adjustments) → posted to the ledger → deposited (bank feed);
//   claims:      billed → paid by insurance → written off → left to the patient → billed to the patient.
// Read-only: nothing here changes money.
const ERA_GRACE_DAYS = 1; // a remittance should be fully posted or decided within a day
const EFT_DAYS = 5; // an EFT should reach the bank within five days of its payment date

const liveSum = (col) => `COALESCE(SUM(CASE WHEN ${col} THEN -l.amount ELSE 0 END), 0)`;

// One row per remittance (ERA or posted paper EOB) whose payment date is in the range.
export async function remittanceChain(db, practiceId, from, to) {
  const hasBank = !!(await db.get('SELECT id FROM bank_accounts WHERE practice_id = ? AND deposits_here = 1 LIMIT 1', practiceId));
  const matched = new Set((await db.all('SELECT match_refs FROM bank_transactions WHERE practice_id = ? AND match_refs IS NOT NULL', practiceId)).flatMap((r) => {
    try { return JSON.parse(r.match_refs); } catch { return []; }
  }));
  const eras = await db.all(
    `SELECT e.id, e.payer_name, e.check_number, e.payment_date, e.total_paid, e.provider_adjustments, e.created_at, k.id AS check_id FROM era_imports e
     LEFT JOIN insurance_checks k ON k.era_import_id = e.id WHERE e.practice_id = ? AND COALESCE(e.payment_date, substr(e.created_at, 1, 10)) BETWEEN ? AND ? ORDER BY e.payment_date, e.id`,
    practiceId, from, to,
  );
  const out = [];
  for (const e of eras) {
    const lines = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN line_no >= 0 THEN paid ELSE 0 END), 0) AS paid,
         COALESCE(SUM(CASE WHEN line_no >= 0 AND state IN ('ready','exception') THEN paid ELSE 0 END), 0) AS waiting,
         COALESCE(SUM(CASE WHEN line_no >= 0 AND state = 'resolved' AND posted_at IS NULL THEN paid ELSE 0 END), 0) AS decided,
         COALESCE(SUM(CASE WHEN state = 'exception' THEN 1 ELSE 0 END), 0) AS exceptions, COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN line_no < 0 AND state = 'resolved' THEN 1 ELSE 0 END), 0) AS explained
       FROM remit_lines WHERE era_import_id = ?`, e.id,
    );
    const posted = e.check_id ? Number((await db.get(`SELECT ${liveSum("l.type = 'insurance_payment'")} AS n FROM ledger_entries l WHERE l.insurance_check_id = ?`, e.check_id)).n) : 0;
    let plb = 0;
    try { plb = (JSON.parse(e.provider_adjustments || '[]') || []).reduce((s, a) => s + (a.amount || 0), 0); } catch { plb = 0; }
    // What the check paid for claims = total + provider-level deductions. Each claim's money is posted, waiting
    // (ready or an exception), or decided without posting (refunded, not ours) — anything else is a gap.
    const forClaims = e.total_paid + plb;
    const unaccounted = forClaims - posted - Number(lines.waiting) - Number(lines.decided);
    const date = e.payment_date || String(e.created_at).slice(0, 10);
    out.push({
      kind: 'era', id: e.id, date, payer: e.payer_name, trace: e.check_number, total: e.total_paid, provider_adjustments: plb, claim_lines: Number(lines.n),
      posted, waiting: Number(lines.waiting), decided_without_posting: Number(lines.decided), exceptions: Number(lines.exceptions), unaccounted,
      // A person looked at the check-level row (interest, a recoupment, a total that doesn't match) and explained it.
      explained: Number(lines.explained) > 0, deposited: hasBank ? matched.has(`era:${e.id}`) : null,
    });
  }
  const papers = await db.all(
    `SELECT p.id, p.payer_name, p.check_number, COALESCE(p.check_date, substr(p.created_at, 1, 10)) AS date, p.total_paid, p.status, p.insurance_check_id
     FROM paper_eobs p WHERE p.practice_id = ? AND p.status <> 'void' AND COALESCE(p.check_date, substr(p.created_at, 1, 10)) BETWEEN ? AND ? ORDER BY date, p.id`, practiceId, from, to,
  );
  for (const p of papers) {
    const lines = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN state IN ('ready','exception') AND line_no >= 0 THEN paid ELSE 0 END), 0) AS waiting,
         COALESCE(SUM(CASE WHEN state = 'resolved' AND posted_at IS NULL AND line_no >= 0 THEN paid ELSE 0 END), 0) AS decided,
         COALESCE(SUM(CASE WHEN state = 'exception' THEN 1 ELSE 0 END), 0) AS exceptions, COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN line_no < 0 AND state = 'resolved' THEN 1 ELSE 0 END), 0) AS explained FROM remit_lines WHERE paper_eob_id = ?`, p.id,
    );
    const posted = p.insurance_check_id ? Number((await db.get(`SELECT ${liveSum("l.type = 'insurance_payment'")} AS n FROM ledger_entries l WHERE l.insurance_check_id = ?`, p.insurance_check_id)).n) : 0;
    out.push({
      kind: 'paper', id: p.id, date: p.date, payer: p.payer_name, trace: p.check_number, total: p.total_paid, provider_adjustments: 0, claim_lines: Number(lines.n),
      posted, waiting: Number(lines.waiting), decided_without_posting: Number(lines.decided), exceptions: Number(lines.exceptions),
      unaccounted: p.total_paid - posted - Number(lines.waiting) - Number(lines.decided), explained: Number(lines.explained) > 0, deposited: null, status: p.status,
    });
  }
  return out;
}

// One row per claim that closed (paid) in the range: billed = insurance paid + written off + the patient's part,
// and whether the patient's part went out to them (or why not).
export async function claimChain(db, practiceId, from, to) {
  const claims = await db.all(
    `SELECT c.id, c.patient_id, c.total_fee, c.paid_amount, c.paid_date, p.first_name, p.last_name,
       (SELECT ${liveSum("l.type = 'insurance_payment'")} FROM ledger_entries l WHERE l.claim_id = c.id) AS ledger_paid,
       (SELECT ${liveSum("l.type = 'adjustment'")} FROM ledger_entries l WHERE l.claim_id = c.id) AS written_off,
       (SELECT COALESCE(SUM(r.patient_resp), 0) FROM remit_lines r WHERE r.claim_id = c.id AND r.state = 'posted') AS payer_patient,
       (SELECT COUNT(*) FROM remit_lines r WHERE r.claim_id = c.id AND r.state = 'posted') AS remits,
       (SELECT b.status FROM balance_bills b WHERE b.claim_id = c.id) AS bill_status,
       (SELECT b.stop_reason FROM balance_bills b WHERE b.claim_id = c.id) AS bill_reason
     FROM claims c JOIN patients p ON p.id = c.patient_id
     WHERE c.practice_id = ? AND c.status = 'paid' AND c.paid_date BETWEEN ? AND ? ORDER BY c.paid_date, c.id`, practiceId, from, to,
  );
  return claims.map((c) => {
    const paid = Number(c.ledger_paid);
    const wo = Number(c.written_off);
    const patient = c.total_fee - paid - wo;
    const gaps = [];
    if (paid !== c.paid_amount) gaps.push(`the claim says ${money(c.paid_amount)} paid but the ledger has ${money(paid)}`);
    if (patient < 0) gaps.push(`paid plus written off is ${money(-patient)} more than billed`);
    // With a remittance on file, what's left for the patient should be exactly what the payer said they owe.
    if (Number(c.remits) && patient !== Number(c.payer_patient)) gaps.push(`the payer said the patient owes ${money(Number(c.payer_patient))} but ${money(patient)} was left to them`);
    return {
      claim_id: c.id, patient_id: c.patient_id, patient: `${c.first_name} ${c.last_name}`, date: c.paid_date, billed: c.total_fee, paid, written_off: wo, patient_part: patient,
      billed_to_patient: c.bill_status ? { status: c.bill_status, reason: c.bill_reason } : null, gaps,
    };
  });
}

// The daily view: per day, the two chains added up, plus every row with a gap.
export async function reconciliation(db, practiceId, { from, to, today }) {
  const rem = await remittanceChain(db, practiceId, from, to);
  const cl = await claimChain(db, practiceId, from, to);
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, remittances: 0, remitted: 0, posted: 0, waiting: 0, deposited: 0, not_deposited: 0, claims_closed: 0, billed: 0, paid: 0, written_off: 0, patient_part: 0, billed_to_patient: 0, gaps: 0 });
    return days.get(d);
  };
  const gaps = [];
  for (const r of rem) {
    const d = day(r.date);
    d.remittances++;
    d.remitted += r.total;
    d.posted += r.posted;
    d.waiting += r.waiting;
    if (r.deposited === true) d.deposited += r.total;
    if (r.deposited === false) d.not_deposited += r.total;
    const late = today && daysBetween(r.date, today) >= EFT_DAYS;
    if (r.unaccounted !== 0 && !r.explained && today && daysBetween(r.date, today) >= ERA_GRACE_DAYS) gaps.push({ key: `eobrecon:${r.kind}:${r.id}`, kind: 'unposted', date: r.date, ref: r, text: `${r.payer || 'Payer'} ${r.trace || ''}: ${money(r.unaccounted)} of the ${money(r.total)} isn’t posted or decided` });
    if (r.kind === 'era' && r.deposited === false && r.total > 0 && late) gaps.push({ key: `eobrecon:eft:${r.id}`, kind: 'not_deposited', date: r.date, ref: r, text: `${r.payer || 'Payer'} EFT ${r.trace || ''} for ${money(r.total)} hasn’t shown up in the bank after ${EFT_DAYS} days` });
  }
  for (const c of cl) {
    const d = day(c.date);
    d.claims_closed++;
    d.billed += c.billed;
    d.paid += c.paid;
    d.written_off += c.written_off;
    d.patient_part += Math.max(0, c.patient_part);
    if (c.billed_to_patient?.status === 'active' || c.billed_to_patient?.status === 'paid' || c.billed_to_patient?.status === 'done' || c.billed_to_patient?.status === 'merged') d.billed_to_patient += Math.max(0, c.patient_part);
    if (c.gaps.length) gaps.push({ key: `eobrecon:claim:${c.claim_id}`, kind: 'claim', date: c.date, ref: c, text: `Claim #${c.claim_id} (${c.patient}): ${c.gaps.join('; ')}` });
  }
  for (const g of gaps) day(g.date).gaps++;
  return { from, to, days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)), remittances: rem, claims: cl, gaps };
}

// The daily pass: every gap is an open Needs attention item; one that closed is resolved.
export async function reconciliationPass(db, practice, { now = new Date() } = {}) {
  const today = localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
  const r = await reconciliation(db, practice.id, { from: addDays(today, -60), to: today, today });
  const open = new Set(r.gaps.map((g) => g.key));
  for (const g of r.gaps) {
    await raiseIssue(db, {
      practiceId: practice.id, kind: 'era', key: g.key, role: 'billing', severity: g.kind === 'claim' ? 'normal' : 'high',
      entity: g.kind === 'claim' ? 'claims' : g.ref.kind === 'paper' ? 'paper_eobs' : 'era_imports', entityId: g.kind === 'claim' ? g.ref.claim_id : g.ref.id,
      patientId: g.kind === 'claim' ? g.ref.patient_id : null, title: `Insurance reconciliation: ${g.text}`.slice(0, 300),
      detail: 'Open Insurance autopilot → Reconciliation to see the day.',
    });
  }
  const stale = await db.all("SELECT dedupe_key FROM issues WHERE practice_id = ? AND status = 'open' AND dedupe_key LIKE 'eobrecon:%'", practice.id);
  for (const s of stale) if (!open.has(s.dedupe_key)) await resolveIssue(db, practice.id, s.dedupe_key, 'Resolved: the reconciliation balances now');
  return { gaps: r.gaps.length };
}
