import { localNow } from './util.js';

// Reconciliation: wherever money or data crosses a boundary, the two sides are compared and every difference
// is listed. Nothing is changed here — it's a report for someone to act on.
const DAY = 86400_000;
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
// The UTC instant a practice-local day starts (created_at columns are UTC; the range is the practice's dates).
const dayStart = (tz, date) => {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const shown = Date.parse(`${localNow(tz, new Date(guess)).replace(' ', 'T')}:00Z`);
  return guess - (shown - guess);
};
const utcRange = async (db, practiceId, from, to) => {
  const { timezone } = await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId);
  return [utc(dayStart(timezone, from)), utc(dayStart(timezone, to) + DAY - 1000)];
};

// Card payments at the processor vs card payments in the ledger, matched by the processor's payment id.
export async function reconcileCards(db, payments, practiceId, from, to) {
  if (!payments?.listCharges) return { available: false, note: payments?.mode === 'sandbox' ? 'Sandbox card payments: there is no processor to compare with.' : 'Card processing isn’t connected.' };
  const { timezone } = await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId);
  // A day either side of the range at the processor (its clock is UTC), then kept by the practice's own date.
  const charges = (await payments.listCharges({ practiceId, fromTs: Math.floor((Date.parse(`${from}T00:00:00Z`) - DAY) / 1000), toTs: Math.floor((Date.parse(`${to}T00:00:00Z`) + 2 * DAY) / 1000) }))
    .map((c) => ({ ...c, date: localNow(timezone, new Date(c.created * 1000)).slice(0, 10) }))
    .filter((c) => c.date >= from && c.date <= to);
  const ledger = await db.all(
    `SELECT l.id, l.patient_id, l.amount, l.entry_date, l.reference, l.voided_at, p.first_name, p.last_name FROM real_ledger_entries l LEFT JOIN real_patients p ON p.id = l.patient_id
     WHERE l.practice_id = ? AND l.type = 'payment' AND l.method = 'credit_card' AND l.reverses_id IS NULL AND l.entry_date BETWEEN ? AND ?`, practiceId, from, to,
  );
  const byRef = new Map(ledger.filter((l) => l.reference).map((l) => [l.reference, l]));
  const seen = new Set();
  const out = { available: true, processor_total: 0, ledger_total: 0, matched: 0, charged_not_posted: [], posted_not_charged: [], amount_differs: [], voided_but_charged: [] };
  for (const c of charges) {
    out.processor_total += c.amount;
    const l = byRef.get(c.id);
    if (!l) { out.charged_not_posted.push(c); continue; }
    seen.add(l.id);
    if (l.voided_at) out.voided_but_charged.push({ ...c, entry_id: l.id, patient: `${l.first_name} ${l.last_name}` });
    else if (-l.amount !== c.amount) out.amount_differs.push({ ...c, entry_id: l.id, ledger_amount: -l.amount, patient: `${l.first_name} ${l.last_name}` });
    else out.matched++;
  }
  for (const l of ledger) {
    if (l.voided_at) continue;
    out.ledger_total += -l.amount;
    // Card payments taken outside this system (a separate terminal) have no processor id to match.
    if (!seen.has(l.id)) out.posted_not_charged.push({ entry_id: l.id, amount: -l.amount, date: l.entry_date, reference: l.reference, patient: `${l.first_name} ${l.last_name}` });
  }
  return out;
}

// Insurance checks and EFTs vs what was posted to patients' ledgers from them.
export async function reconcileInsuranceChecks(db, practiceId, from, to) {
  const rows = await db.all(
    `SELECT ic.id, ic.payer_name, ic.check_number, ic.check_date, ic.amount, ic.era_import_id,
       COALESCE((SELECT -SUM(l.amount) FROM real_ledger_entries l WHERE l.insurance_check_id = ic.id AND l.type = 'insurance_payment'), 0) AS posted
     FROM insurance_checks ic WHERE ic.practice_id = ? AND ic.check_date BETWEEN ? AND ? ORDER BY ic.check_date, ic.id`, practiceId, from, to,
  );
  const checks = rows.map((r) => ({ ...r, posted: Number(r.posted), unposted: r.amount - Number(r.posted) }));
  return { checks: checks.length, total: checks.reduce((s, c) => s + c.amount, 0), posted: checks.reduce((s, c) => s + c.posted, 0), differences: checks.filter((c) => c.unposted !== 0) };
}

// (submitted_at is an ISO time; created_at is the database's "YYYY-MM-DD HH:MM:SS" UTC.)
// Claims: how many were created, sent, acknowledged by the payer and paid — and the ones stuck between steps.
export async function reconcileClaims(db, practiceId, from, to, now = Date.now()) {
  const range = [practiceId, ...(await utcRange(db, practiceId, from, to))];
  const count = async (extra) => Number((await db.get(`SELECT COUNT(*) AS n FROM real_claims c WHERE c.practice_id = ? AND c.created_at BETWEEN ? AND ?${extra}`, ...range)).n);
  const answered = " AND (c.status IN ('paid','partially_paid','denied') OR EXISTS (SELECT 1 FROM claim_events e WHERE e.claim_id = c.id AND e.status IN ('accepted','paid','denied','rejected')))";
  const funnel = {
    created: await count(''),
    sent: await count(" AND c.submitted_at IS NOT NULL"),
    acknowledged: await count(answered),
    paid: await count(" AND c.status IN ('paid','partially_paid')"),
    denied: await count(" AND c.status = 'denied'"),
    void: await count(" AND c.status = 'void'"),
  };
  const list = (where, ...args) => db.all(
    `SELECT c.id, c.status, c.total_fee, c.created_at, c.submitted_at, c.ch_status, c.ch_message, p.first_name || ' ' || p.last_name AS patient, ic.name AS carrier
     FROM real_claims c JOIN real_patients p ON p.id = c.patient_id LEFT JOIN real_patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
     WHERE c.practice_id = ? AND ${where} ORDER BY c.id LIMIT 200`, practiceId, ...args,
  );
  const stuck = {
    not_sent: await list("c.status = 'draft' AND c.created_at < ?", utc(now - 3 * DAY)),
    rejected: await list("c.status = 'submitted' AND c.ch_status = 'rejected'"),
    no_acknowledgement: await list(
      "c.status = 'submitted' AND c.batch_id IS NOT NULL AND c.submitted_at < ? AND COALESCE(c.ch_status, 'sent') = 'sent' AND NOT EXISTS (SELECT 1 FROM claim_events e WHERE e.claim_id = c.id AND e.status IN ('accepted','paid','denied','rejected','request'))",
      new Date(now - 3 * DAY).toISOString(),
    ),
    unpaid_30_days: await list("c.status = 'submitted' AND c.submitted_at < ?", new Date(now - 30 * DAY).toISOString()),
  };
  return { funnel, stuck };
}

// Imports: rows in the file vs rows brought in, updated, skipped or refused.
export async function reconcileImports(db, practiceId, from, to) {
  const rows = await db.all(
    `SELECT id, source, kind, filename, status, total_rows, created_count, updated_count, skipped_count, error_count, created_at, finished_at
     FROM import_batches WHERE practice_id = ? AND created_at BETWEEN ? AND ? ORDER BY id DESC`, practiceId, ...(await utcRange(db, practiceId, from, to)),
  );
  return rows.map((b) => {
    const accounted = b.created_count + b.updated_count + b.skipped_count + b.error_count;
    return { ...b, accounted, missing: b.total_rows ? b.total_rows - accounted : null, ok: b.status === 'done' && !b.error_count && (!b.total_rows || accounted === b.total_rows) };
  });
}
