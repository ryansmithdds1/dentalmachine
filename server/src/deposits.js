// Daily deposits and cash handling (DC1-DC3; plain-words version for the owner in docs/cash-handling.md).
//
// The day's cash and checks go to the bank on a deposit (a `deposits` row, so the bank-feed matching in
// finance/service.js finds it) with a locked slip (`deposit_slips`): what was counted, what the ledger says was
// taken, any difference and why, who prepared it and who verified it. Card batches and insurance EFTs aren't
// built by hand: they come from the processor and ERA data and are followed to the bank the same way.
// Cash drawers are opened with a float and closed with a blind count; every cash payment gets a numbered receipt
// per office; cash voids, refunds and discounts need a manager; the owner's Cash integrity report shows the rest.
//
// This file holds the arithmetic (pure, tested on its own) and the database work the routes and jobs share.
import { HttpError, can } from './auth.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { change, practiceNow } from './util.js';
import { checkOffice } from './officeaccess.js';
import { expectedDeposits } from './finance/service.js';

// The stronger permission for verifying, reopening and approving cash exceptions. Administrators always have it.
export const MANAGE = 'deposits:manage';
export const isManager = (user) => user?.role === 'admin' || can(user, MANAGE);
export const requireManager = (req, _res, next) => (isManager(req.user)
  ? next() : next(new HttpError(403, 'A manager needs to do this (deposits:manage)', { manager_required: true })));
export const requireOwner = (req, _res, next) => (req.user?.role === 'admin' ? next() : next(new HttpError(403, 'Only the owner (an administrator) sees this report')));

// ---- Pure arithmetic ----

// US bills and coins, largest first: [key, cents, label].
export const DENOMINATIONS = [
  ['b100', 10000, '$100 bills'], ['b50', 5000, '$50 bills'], ['b20', 2000, '$20 bills'], ['b10', 1000, '$10 bills'], ['b5', 500, '$5 bills'],
  ['b2', 200, '$2 bills'], ['b1', 100, '$1 bills'], ['c100', 100, '$1 coins'], ['c50', 50, 'Half dollars'], ['c25', 25, 'Quarters'],
  ['c10', 10, 'Dimes'], ['c5', 5, 'Nickels'], ['c1', 1, 'Pennies'],
];
const VALUE = Object.fromEntries(DENOMINATIONS.map(([k, v]) => [k, v]));

// A count by denomination → { detail (only what was counted), total cents }. Anything odd is refused.
export function countCash(count) {
  if (count == null || typeof count !== 'object' || Array.isArray(count)) throw new HttpError(400, 'Count the cash by bills and coins');
  const detail = {};
  let total = 0;
  for (const [k, raw] of Object.entries(count)) {
    if (!(k in VALUE)) throw new HttpError(400, `Unknown bill or coin: ${k}`);
    if (raw === '' || raw == null) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, 'Each count must be a whole number of bills or coins');
    if (n) {
      detail[k] = n;
      total += n * VALUE[k];
    }
  }
  return { detail, total };
}

// Positive: more cash than expected (over); negative: less (short).
export const overShort = (counted, expected) => counted - expected;
export const overShortLabel = (n) => (n > 0 ? 'over' : n < 0 ? 'short' : 'even');

// Weekdays after `from` up to and including `to` (weekends don't count against the bank).
export function businessDaysAfter(from, to) {
  let n = 0;
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let t = Date.parse(`${from}T12:00:00Z`) + 86400_000; t <= end; t += 86400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

// The deposit against the ledger. entries: what's waiting to go to the bank ({ id, kind cash|check|cash_refund,
// amount signed for the deposit: payments +, cash paid out −}); included: the ids going on this deposit;
// cashCounted: the cash in the bag. The deposit balances when the bag holds exactly what the ledger says for the
// payments on it and nothing waiting was left out.
export function reconcileDeposit({ entries, included, cashCounted }) {
  const inc = new Set(included);
  const on = entries.filter((e) => inc.has(e.id));
  const leftOut = entries.filter((e) => !inc.has(e.id));
  const sum = (list) => list.reduce((s, e) => s + e.amount, 0);
  const cashExpected = sum(on.filter((e) => e.kind !== 'check'));
  const checkTotal = sum(on.filter((e) => e.kind === 'check'));
  const total = cashCounted + checkTotal;
  const ledgerTotal = cashExpected + checkTotal;
  return {
    cash_expected: cashExpected, cash_counted: cashCounted, cash_difference: cashCounted - cashExpected,
    check_total: checkTotal, check_count: on.filter((e) => e.kind === 'check').length,
    total, ledger_total: ledgerTotal, difference: total - ledgerTotal,
    left_out: leftOut.length, left_out_total: sum(leftOut),
    balanced: total === ledgerTotal && leftOut.length === 0,
  };
}

// Separation of duties on a deposit: the person who prepared it also took payments from an account and posted
// a credit adjustment on that same account (the classic way cash goes missing: take the cash, write the balance
// off, and be the one who fills in the slip). A softer note when one person took all the cash and prepared it.
export function separationFlags({ items, adjustments, preparedBy, names = {} }) {
  const flags = [];
  const who = (id) => names[id] || `User #${id}`;
  const took = new Set(items.filter((i) => i.taken_by === preparedBy && i.patient_id).map((i) => i.patient_id));
  const adjusted = [...new Set(adjustments.filter((a) => a.created_by === preparedBy && took.has(a.patient_id)).map((a) => a.patient_id))];
  if (adjusted.length) {
    flags.push({
      kind: 'took_adjusted_prepared', severity: 'warn', user_id: preparedBy, patient_ids: adjusted,
      text: `${who(preparedBy)} took payments, posted adjustments on the same ${adjusted.length === 1 ? 'account' : `${adjusted.length} accounts`}, and prepared this deposit.`,
    });
  }
  const cash = items.filter((i) => i.kind === 'cash');
  if (cash.length && cash.every((i) => i.taken_by === preparedBy)) {
    flags.push({ kind: 'took_and_prepared', severity: 'note', user_id: preparedBy, text: `${who(preparedBy)} took all the cash on this deposit and prepared it — a second person should verify it.` });
  }
  return flags;
}

// ---- Offices ----

// The office a deposit or drawer is for: the one asked for (it must be the practice's and one of the person's),
// else the office the screen is working in, else the practice's only office. A practice with several offices
// has to say which.
export async function resolveOffice(db, user, raw, fallback = null) {
  const asked = raw != null && raw !== '' ? Number(raw) : fallback;
  if (asked != null) {
    if (!Number.isInteger(asked) || asked <= 0) throw new HttpError(400, 'location_id must be an office id');
    if (!(await db.get('SELECT id FROM locations WHERE id = ? AND practice_id = ?', asked, user.practice_id))) throw new HttpError(404, 'Office not found');
    checkOffice(user, asked);
    return asked;
  }
  const offices = await db.all('SELECT id FROM locations WHERE practice_id = ? AND active = 1', user.practice_id);
  if (offices.length > 1) throw new HttpError(400, 'Choose the office');
  if (offices.length === 1) {
    checkOffice(user, offices[0].id);
    return offices[0].id;
  }
  return null;
}

// SQL for "at this office" on a ledger alias. With one office (or none), entries not tied to an office count too.
async function officeWhere(db, pid, locationId, alias = 'l') {
  if (locationId == null) return { sql: '', args: [] };
  const many = Number((await db.get('SELECT COUNT(*) AS n FROM locations WHERE practice_id = ? AND active = 1', pid)).n) > 1;
  return many ? { sql: ` AND ${alias}.location_id = ?`, args: [locationId] } : { sql: ` AND (${alias}.location_id = ? OR ${alias}.location_id IS NULL)`, args: [locationId] };
}

// ---- What's waiting to go to the bank ----

const LIVE = 'l.voided_at IS NULL AND l.reverses_id IS NULL';
// Cash and check payments not yet on a deposit, and cash paid back out of the day's cash (a cash refund).
const WAITING = `${LIVE} AND l.deposit_id IS NULL AND (
  (l.type IN ('payment','insurance_payment') AND l.amount < 0 AND COALESCE(l.method, 'check') IN ('cash','check'))
  OR (l.type = 'refund' AND l.method = 'cash' AND l.amount > 0))`;

export async function waitingEntries(db, pid, locationId, date) {
  const office = await officeWhere(db, pid, locationId);
  const rows = await db.all(
    `SELECT l.id, l.type, l.method, l.amount, l.reference, l.entry_date, l.patient_id, l.created_by, l.description, l.location_id, l.insurance_check_id,
       p.first_name, p.last_name, u.name AS taken_by_name, ic.payer_name, ic.check_number
     FROM ledger_entries l JOIN patients p ON p.id = l.patient_id LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN insurance_checks ic ON ic.id = l.insurance_check_id
     WHERE l.practice_id = ? AND l.entry_date <= ? AND ${WAITING}${office.sql}
     ORDER BY l.entry_date, l.id`, pid, date, ...office.args,
  );
  return rows.map((l) => ({
    id: l.id,
    kind: l.type === 'refund' ? 'cash_refund' : (l.method || 'check') === 'cash' ? 'cash' : 'check',
    amount: -l.amount,
    entry_date: l.entry_date,
    earlier: l.entry_date < date,
    patient_id: l.patient_id,
    patient_name: `${l.first_name} ${l.last_name}`,
    payer: l.type === 'insurance_payment' ? l.payer_name || l.description : `${l.first_name} ${l.last_name}`,
    check_number: l.type === 'insurance_payment' ? l.check_number || l.reference : l.reference,
    insurance_check_id: l.insurance_check_id ?? null,
    taken_by: l.created_by,
    taken_by_name: l.taken_by_name,
    type: l.type,
  }));
}

// One line per physical check: an insurance check paid across several claims is one check on the slip.
export function checkLines(entries) {
  const lines = new Map();
  for (const e of entries.filter((x) => x.kind === 'check')) {
    const key = e.insurance_check_id ? `ic:${e.insurance_check_id}` : `e:${e.id}`;
    const line = lines.get(key) || { key, entry_ids: [], payer: e.payer, check_number: e.check_number, amount: 0, entry_date: e.entry_date, earlier: e.earlier, insurance: e.type === 'insurance_payment', patients: [] };
    line.entry_ids.push(e.id);
    line.amount += e.amount;
    if (!line.patients.includes(e.patient_name)) line.patients.push(e.patient_name);
    lines.set(key, line);
  }
  return [...lines.values()];
}

// What the ledger took at this office on the day (all cash and checks, deposited or not), for the header.
export async function dayLedger(db, pid, locationId, date) {
  const office = await officeWhere(db, pid, locationId);
  const rows = await db.all(
    `SELECT CASE WHEN l.type = 'refund' THEN 'cash_refund' WHEN COALESCE(l.method, 'check') = 'cash' THEN 'cash' ELSE 'check' END AS kind, COUNT(*) AS n, -SUM(l.amount) AS amount
     FROM ledger_entries l WHERE l.practice_id = ? AND l.entry_date = ? AND ${LIVE}
       AND ((l.type IN ('payment','insurance_payment') AND l.amount < 0 AND COALESCE(l.method, 'check') IN ('cash','check')) OR (l.type = 'refund' AND l.method = 'cash' AND l.amount > 0))${office.sql}
     GROUP BY CASE WHEN l.type = 'refund' THEN 'cash_refund' WHEN COALESCE(l.method, 'check') = 'cash' THEN 'cash' ELSE 'check' END`, pid, date, ...office.args,
  );
  const out = { cash: 0, check: 0, cash_refund: 0, count: 0 };
  for (const r of rows) {
    out[r.kind] = Number(r.amount);
    out.count += Number(r.n);
  }
  out.total = out.cash + out.check + out.cash_refund;
  return out;
}

// Card batches and insurance EFTs for a day: they come from the processor and the ERAs, not the desk. Shown next
// to the cash-and-check deposit, with whether the bank has them yet (bank-feed matching keys card:<date>, era:<id>).
export async function electronicDeposits(db, pid, locationId, date) {
  const office = await officeWhere(db, pid, locationId);
  const cards = await db.all(
    `SELECT CASE WHEN l.method IN ('care_credit','financing') THEN 'financing' WHEN l.method = 'ach' THEN 'ach' ELSE 'card' END AS kind, COUNT(*) AS n, -SUM(l.amount) AS amount
     FROM ledger_entries l WHERE l.practice_id = ? AND l.entry_date = ? AND ${LIVE} AND l.type IN ('payment','insurance_payment','refund')
       AND l.method IN ('credit_card','debit_card','care_credit','financing','ach')${office.sql}
     GROUP BY CASE WHEN l.method IN ('care_credit','financing') THEN 'financing' WHEN l.method = 'ach' THEN 'ach' ELSE 'card' END`, pid, date, ...office.args,
  );
  const eras = await db.all('SELECT id, payer_name, check_number, total_paid FROM era_imports WHERE practice_id = ? AND payment_date = ? AND total_paid > 0', pid, date);
  const matched = await matchedKeys(db, pid);
  const NAMES = { card: 'Card batch', financing: 'Financing payout', ach: 'Bank (ACH) payments' };
  return [
    ...cards.filter((c) => Number(c.amount) > 0).map((c) => ({ key: `${c.kind}:${date}`, type: c.kind, label: `${NAMES[c.kind]} (${Number(c.n)})`, amount: Number(c.amount), date, in_bank: matched.has(`${c.kind}:${date}`) })),
    ...eras.map((e) => ({ key: `era:${e.id}`, type: 'eft', label: `${e.payer_name || 'Insurance'} EFT${e.check_number ? ` · ${e.check_number}` : ''}`, amount: e.total_paid, date, in_bank: matched.has(`era:${e.id}`) })),
  ];
}

async function matchedKeys(db, pid) {
  const rows = await db.all('SELECT match_refs FROM bank_transactions WHERE practice_id = ? AND match_refs IS NOT NULL', pid);
  return new Set(rows.flatMap((r) => {
    try { return JSON.parse(r.match_refs); } catch { return []; }
  }));
}

// ---- Numbered cash receipts ----

// The drawer a cash payment went into: an open drawer at its office opened before it was taken, the taker's own
// drawer first, else the only one open. Several open and none theirs: left unassigned (shown as an exception).
async function drawerFor(db, e) {
  const open = (await db.all("SELECT id, opened_by, location_id FROM cash_drawer_sessions WHERE practice_id = ? AND status = 'open' AND opened_at <= ? ORDER BY id", e.practice_id, e.created_at))
    .filter((s) => s.location_id === e.location_id || s.location_id == null || e.location_id == null);
  return open.find((s) => s.opened_by === e.created_by)?.id ?? (open.length === 1 ? open[0].id : null);
}

// Gives a cash payment (or cash paid out) the next receipt number for its office. Safe to call any number of
// times and from several requests at once: one receipt per ledger entry, one entry per number (both unique),
// numbers taken as highest + 1 so none is skipped; a clash just tries the next number.
export async function assignCashReceipt(db, entryOrId) {
  const e = typeof entryOrId === 'object' ? entryOrId : await db.get('SELECT * FROM ledger_entries WHERE id = ?', Number(entryOrId));
  if (!e || e.method !== 'cash' || e.reverses_id) return null;
  const kind = e.type === 'payment' && e.amount < 0 ? 'payment' : e.type === 'refund' && e.amount > 0 ? 'payout' : null;
  if (!kind) return null;
  const have = await db.get('SELECT * FROM cash_receipts WHERE ledger_entry_id = ?', e.id);
  if (have) return have;
  const officeKey = e.location_id ?? 0;
  const session = await drawerFor(db, e);
  for (let attempt = 0; attempt < 25; attempt++) {
    const next = Number((await db.get('SELECT MAX(receipt_no) AS n FROM cash_receipts WHERE practice_id = ? AND office_key = ?', e.practice_id, officeKey))?.n || 0) + 1;
    const r = await db.run(
      `INSERT INTO cash_receipts (practice_id, location_id, office_key, receipt_no, kind, ledger_entry_id, drawer_session_id, patient_id, amount, taken_by, status, voided_at, voided_by, void_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      e.practice_id, e.location_id ?? null, officeKey, next, kind, e.id, session, e.patient_id, Math.abs(e.amount), e.created_by ?? null,
      e.voided_at ? 'voided' : 'issued', e.voided_at ?? null, e.voided_by ?? null, e.voided_at ? e.void_reason ?? null : null,
    );
    const row = await db.get('SELECT * FROM cash_receipts WHERE ledger_entry_id = ?', e.id);
    if (row) return row;
    if (r.changes) break;
  }
  throw new Error(`Could not number the cash receipt for ledger entry ${e.id}`);
}

// Numbers every cash payment that doesn't have a receipt yet (oldest first), and marks the receipts of payments
// voided since as voided — they stay on the list, so a missing number is never silent.
export async function syncCashReceipts(db, pid) {
  const missing = await db.all(
    `SELECT l.* FROM ledger_entries l LEFT JOIN cash_receipts r ON r.ledger_entry_id = l.id
     WHERE l.practice_id = ? AND r.id IS NULL AND l.method = 'cash' AND l.reverses_id IS NULL
       AND ((l.type = 'payment' AND l.amount < 0) OR (l.type = 'refund' AND l.amount > 0)) ORDER BY l.id LIMIT 500`, pid,
  );
  for (const e of missing) await assignCashReceipt(db, e);
  const voided = await db.all(
    `SELECT r.id, l.voided_at, l.voided_by, l.void_reason FROM cash_receipts r JOIN ledger_entries l ON l.id = r.ledger_entry_id
     WHERE r.practice_id = ? AND r.status = 'issued' AND l.voided_at IS NOT NULL`, pid,
  );
  for (const v of voided) await change(db, 'cash_receipts', v.id, { status: 'voided', voided_at: v.voided_at, voided_by: v.voided_by ?? null, void_reason: v.void_reason ?? null });
  return missing.length;
}

// ---- Drawers ----

// What should be in the drawer: the float, plus cash taken into it, less cash paid out of it (live entries only).
export async function drawerExpected(db, session) {
  await syncCashReceipts(db, session.practice_id);
  const rows = await db.all(
    `SELECT r.kind, COUNT(*) AS n, SUM(r.amount) AS amount FROM cash_receipts r JOIN ledger_entries l ON l.id = r.ledger_entry_id
     WHERE r.drawer_session_id = ? AND l.voided_at IS NULL GROUP BY r.kind`, session.id,
  );
  const by = Object.fromEntries(rows.map((r) => [r.kind, { n: Number(r.n), amount: Number(r.amount) }]));
  const taken = by.payment?.amount || 0;
  const paidOut = by.payout?.amount || 0;
  return { opening_float: session.opening_float, taken, paid_out: paidOut, payments: by.payment?.n || 0, payouts: by.payout?.n || 0, expected: session.opening_float + taken - paidOut };
}

// A drawer session as the screen may see it. Until the count is in, nothing that adds up to the expected amount
// is sent (no expected total, no payment amounts) — that's what makes the count blind.
export function sessionView(s, names = {}) {
  const base = {
    id: s.id, drawer_id: s.drawer_id, location_id: s.location_id, business_date: s.business_date, status: s.status,
    opening_float: s.opening_float, opened_by: s.opened_by, opened_by_name: names[s.opened_by] || null, opened_at: s.opened_at,
  };
  if (s.status === 'open') return { ...base, blind: true };
  return {
    ...base, counted_by: s.counted_by, counted_by_name: names[s.counted_by] || null, counted_at: s.counted_at, count_detail: parse(s.count_detail),
    counted_total: s.counted_total, expected_total: s.expected_total, over_short: s.over_short, over_short_label: overShortLabel(s.over_short),
    verified_by: s.verified_by, verified_by_name: names[s.verified_by] || null, verified_at: s.verified_at, verify_total: s.verify_total, verify_detail: parse(s.verify_detail),
    over_short_reason: s.over_short_reason, float_kept: s.float_kept, to_deposit: s.to_deposit, deposit_id: s.deposit_id, closed_at: s.closed_at,
  };
}

export const parse = (v, fallback = null) => {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

export async function userNames(db, pid) {
  return Object.fromEntries((await db.all('SELECT id, name FROM users WHERE practice_id = ?', pid)).map((u) => [u.id, u.name]));
}

// ---- Settings ----

export async function cashSettings(db, pid) {
  return (await db.get('SELECT late_business_days, over_short_alert FROM cash_settings WHERE practice_id = ?', pid)) || { late_business_days: 3, over_short_alert: 500 };
}

// ---- Flags the owner reviews ----

export async function flag(db, row) {
  await db.run(
    `INSERT INTO cash_flags (practice_id, location_id, kind, dedupe_key, user_id, approved_by, ledger_entry_id, deposit_id, session_id, patient_id, amount, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    row.practice_id, row.location_id ?? null, row.kind, row.dedupe_key, row.user_id ?? null, row.approved_by ?? null, row.ledger_entry_id ?? null,
    row.deposit_id ?? null, row.session_id ?? null, row.patient_id ?? null, row.amount ?? null, row.detail ? String(row.detail).slice(0, 500) : null,
  );
}

// ---- A deposit's state and exceptions ----

// Separation-of-duties flags for a deposit, worked out from its items and the adjustments on those accounts
// (30 days either side of the deposit's day).
export async function depositSeparation(db, slip, items, names) {
  const patients = [...new Set(items.map((i) => i.patient_id).filter(Boolean))];
  if (!patients.length) return [];
  const from = shift(slip.business_date, -30);
  const to = shift(slip.business_date, 30);
  const adjustments = await db.all(
    `SELECT patient_id, created_by, amount FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL AND l.amount < 0 AND ${LIVE}
       AND l.transfer_id IS NULL AND l.entry_date BETWEEN ? AND ? AND l.patient_id IN (${patients.map(() => '?').join(',')})`, slip.practice_id, from, to, ...patients,
  );
  return separationFlags({ items, adjustments, preparedBy: slip.prepared_by, names });
}

const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// Exceptions on one deposit today: late to the bank, short or over at the bank, a payment on it voided since.
export function slipExceptions(slip, deposit, { today, lateDays, voidedItems = 0 }) {
  const out = [];
  if (slip.stage === 'reopened') return out;
  const inBank = ['reconciled', 'discrepancy'].includes(deposit.status) && deposit.bank_amount != null;
  const days = businessDaysAfter(slip.business_date, today);
  if (!inBank && days > lateDays) out.push({ kind: 'late', text: `Not in the bank after ${days} business days` });
  if (deposit.status === 'discrepancy' && !slip.bank_note) {
    const diff = (deposit.bank_amount ?? 0) - deposit.total;
    out.push({ kind: diff < 0 ? 'short' : 'over', amount: diff, text: `The bank shows ${diff < 0 ? 'less' : 'more'} than the slip` });
  }
  if (voidedItems) out.push({ kind: 'item_voided', text: `${voidedItems} payment${voidedItems === 1 ? '' : 's'} on this deposit ${voidedItems === 1 ? 'was' : 'were'} voided after it was submitted` });
  return out;
}

export function nextStage(slip, deposit) {
  if (slip.stage === 'reopened') return 'reopened';
  const inBank = ['reconciled', 'discrepancy'].includes(deposit.status) && deposit.bank_amount != null;
  if (!inBank) return 'submitted';
  const agrees = deposit.status === 'reconciled' || !!slip.bank_note;
  return agrees && slip.verified_by ? 'reconciled' : 'in_bank';
}

const dollars = (c) => `$${(Math.abs(c) / 100).toFixed(2)}`;

// The watch: moves each deposit along (submitted → in bank → reconciled) from what the bank-feed matching found,
// and keeps Needs attention in step: raised while a deposit is late or short/over, resolved once it isn't.
// Card batches and insurance EFTs are watched too when a bank feed is connected (without one there's nothing to see).
export async function depositWatch(db, pid, today = null) {
  today ||= (await practiceNow(db, pid)).slice(0, 10);
  const { late_business_days: lateDays } = await cashSettings(db, pid);
  const slips = await db.all(
    `SELECT s.*, d.status AS bank_status, d.bank_amount, d.bank_date, d.total FROM deposit_slips s JOIN deposits d ON d.id = s.deposit_id
     WHERE s.practice_id = ? AND s.stage <> 'reopened'`, pid,
  );
  const stillLate = new Set();
  const stillOff = new Set();
  const stillVoided = new Set();
  for (const s of slips) {
    const deposit = { status: s.bank_status, bank_amount: s.bank_amount, total: s.total };
    const stage = nextStage(s, deposit);
    if (stage !== s.stage) await change(db, 'deposit_slips', s.id, { stage });
    const voidedItems = Number((await db.get(
      'SELECT COUNT(*) AS n FROM deposit_slip_items i JOIN ledger_entries l ON l.id = i.ledger_entry_id WHERE i.deposit_id = ? AND l.voided_at IS NOT NULL', s.deposit_id,
    )).n);
    for (const x of slipExceptions({ ...s, stage }, deposit, { today, lateDays, voidedItems })) {
      const base = { practiceId: pid, kind: 'payment', role: 'billing', entity: 'deposits', entityId: s.deposit_id, severity: 'high' };
      if (x.kind === 'late') {
        stillLate.add(`deposit-late:deposit:${s.deposit_id}`);
        await raiseIssue(db, { ...base, key: `deposit-late:deposit:${s.deposit_id}`, title: `Deposit of ${dollars(s.total)} from ${s.business_date} isn't in the bank yet`, detail: `${x.text}. Check the bag${s.bag_number ? ` (${s.bag_number})` : ''} went to the bank, or mark it in the bank.` });
      } else if (x.kind === 'short' || x.kind === 'over') {
        stillOff.add(`deposit-bank-diff:${s.deposit_id}`);
        await raiseIssue(db, { ...base, key: `deposit-bank-diff:${s.deposit_id}`, title: `Deposit from ${s.business_date}: the bank shows ${dollars(x.amount)} ${x.kind}`, detail: `Slip ${dollars(s.total)}, bank ${dollars(s.bank_amount)}. Find out why and record it on the deposit.` });
      } else if (x.kind === 'item_voided') {
        stillVoided.add(`deposit-item-voided:${s.deposit_id}`);
        await raiseIssue(db, { ...base, key: `deposit-item-voided:${s.deposit_id}`, title: `A payment on the ${s.business_date} deposit was voided after the deposit went in`, detail: x.text });
      }
    }
  }
  // Card batches and EFTs, when the bank feed is connected.
  if (await db.get('SELECT id FROM bank_accounts WHERE practice_id = ? AND active = 1 AND deposits_here = 1', pid)) {
    const since = shift(today, -60);
    for (const p of await expectedDeposits(db, pid, since, today)) {
      if (p.kind === 'deposit') continue;
      if (businessDaysAfter(p.date, today) <= lateDays) continue;
      const key = `deposit-late:${p.key}`;
      stillLate.add(key);
      await raiseIssue(db, { practiceId: pid, kind: 'payment', role: 'billing', severity: 'normal', key, title: `${p.label} (${dollars(p.amount)}) isn't in the bank yet`, detail: `Taken on ${p.date}. Check the processor's payouts or the insurance payment.` });
    }
  }
  // Anything no longer late, off or voided is resolved.
  const open = await db.all("SELECT dedupe_key FROM issues WHERE practice_id = ? AND status = 'open' AND (dedupe_key LIKE 'deposit-late:%' OR dedupe_key LIKE 'deposit-bank-diff:%' OR dedupe_key LIKE 'deposit-item-voided:%')", pid);
  for (const { dedupe_key: key } of open) {
    if (stillLate.has(key) || stillOff.has(key) || stillVoided.has(key)) continue;
    await resolveIssue(db, pid, key, key.startsWith('deposit-late:') ? 'Resolved: it reached the bank (or the deposit was reopened)' : 'Resolved: explained or corrected on the deposit');
  }
  return { slips: slips.length };
}

// Every practice with deposits or a bank feed (the scheduled job).
export async function depositWatchAll(db) {
  const rows = await db.all('SELECT DISTINCT practice_id FROM deposit_slips UNION SELECT DISTINCT practice_id FROM bank_accounts WHERE active = 1');
  for (const { practice_id: pid } of rows) {
    try {
      await depositWatch(db, pid);
    } catch (err) {
      await raiseIssue(db, { practiceId: pid, kind: 'payment', key: 'deposit-watch-failed', title: 'Checking deposits against the bank failed', detail: err.message, role: 'admin' });
      continue;
    }
    await resolveIssue(db, pid, 'deposit-watch-failed');
  }
}

// ---- The owner's Cash integrity report ----

const weekOf = (d) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86400_000).toISOString().slice(0, 10);
};

export async function cashIntegrity(db, pid, { from, to, today }) {
  const names = await userNames(db, pid);
  const who = (id) => (id ? names[id] || `User #${id}` : '—');
  const { late_business_days: lateDays, over_short_alert: alert } = await cashSettings(db, pid);

  // Drawer over/short by person, and the weekly trend.
  const sessions = await db.all(
    `SELECT s.id, s.business_date, s.counted_by, s.verified_by, s.over_short, s.over_short_reason, s.counted_total, s.expected_total, d.name AS drawer
     FROM cash_drawer_sessions s JOIN cash_drawers d ON d.id = s.drawer_id
     WHERE s.practice_id = ? AND s.status IN ('counted','closed') AND s.business_date BETWEEN ? AND ? ORDER BY s.business_date, s.id`, pid, from, to,
  );
  const people = new Map();
  const weeks = new Map();
  for (const s of sessions) {
    const p = people.get(s.counted_by) || { user_id: s.counted_by, name: who(s.counted_by), counts: 0, over: 0, short: 0, net: 0, flagged: 0 };
    p.counts++;
    if (s.over_short > 0) p.over += s.over_short;
    if (s.over_short < 0) p.short += s.over_short;
    p.net += s.over_short || 0;
    if (Math.abs(s.over_short || 0) >= alert) p.flagged++;
    people.set(s.counted_by, p);
    const w = weeks.get(weekOf(s.business_date)) || { week: weekOf(s.business_date), counts: 0, over: 0, short: 0, net: 0 };
    w.counts++;
    if (s.over_short > 0) w.over += s.over_short;
    if (s.over_short < 0) w.short += s.over_short;
    w.net += s.over_short || 0;
    weeks.set(w.week, w);
  }

  // Cash voids and refunds, and whether a manager approved them at the time (cash_flags from the guard).
  const approvals = new Map((await db.all("SELECT ledger_entry_id, approved_by, kind FROM cash_flags WHERE practice_id = ? AND ledger_entry_id IS NOT NULL AND kind IN ('cash_void','cash_refund','cash_discount')", pid))
    .map((f) => [`${f.kind}:${f.ledger_entry_id}`, f.approved_by]));
  const voids = (await db.all(
    `SELECT l.id, l.type, l.entry_date, l.amount, l.voided_at, l.void_reason, l.voided_by, l.created_by, p.first_name, p.last_name
     FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
     WHERE l.practice_id = ? AND l.method = 'cash' AND l.type IN ('payment','refund') AND l.voided_at IS NOT NULL AND l.reverses_id IS NULL
       AND substr(l.voided_at, 1, 10) BETWEEN ? AND ? ORDER BY l.voided_at`, pid, from, to,
  )).map((v) => ({
    id: v.id, type: v.type, entry_date: v.entry_date, amount: Math.abs(v.amount), voided_at: v.voided_at, reason: v.void_reason, patient: `${v.first_name} ${v.last_name}`,
    taken_by: who(v.created_by), voided_by: who(v.voided_by), same_person: v.created_by != null && v.created_by === v.voided_by,
    approved_by: approvals.has(`cash_void:${v.id}`) ? who(approvals.get(`cash_void:${v.id}`)) : null,
  }));
  const refunds = (await db.all(
    `SELECT l.id, l.entry_date, l.amount, l.created_by, l.description, p.first_name, p.last_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
     WHERE l.practice_id = ? AND l.type = 'refund' AND l.method = 'cash' AND ${LIVE} AND l.entry_date BETWEEN ? AND ? ORDER BY l.entry_date, l.id`, pid, from, to,
  )).map((r) => ({
    id: r.id, entry_date: r.entry_date, amount: r.amount, patient: `${r.first_name} ${r.last_name}`, by: who(r.created_by), description: r.description,
    approved_by: approvals.has(`cash_refund:${r.id}`) ? who(approvals.get(`cash_refund:${r.id}`)) : null,
  }));

  // Adjustments and write-offs by person (credits only; transfers between family members aren't money leaving).
  const adjustments = (await db.all(
    `SELECT l.created_by, COUNT(*) AS n, -SUM(l.amount) AS amount,
       -SUM(CASE WHEN LOWER(COALESCE(l.adjustment_type, '')) LIKE '%write%' THEN l.amount ELSE 0 END) AS write_offs
     FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL AND l.amount < 0 AND ${LIVE} AND l.transfer_id IS NULL AND l.entry_date BETWEEN ? AND ?
     GROUP BY l.created_by`, pid, from, to,
  )).map((a) => ({ user_id: a.created_by, name: who(a.created_by), count: Number(a.n), amount: Number(a.amount), write_offs: Number(a.write_offs), discounts: Number(a.amount) - Number(a.write_offs) }))
    .sort((a, b) => b.amount - a.amount);

  // Deposits late to the bank (or still not there), and differences at submission.
  const slips = await db.all(
    `SELECT s.*, d.total, d.status AS bank_status, d.bank_amount, d.bank_date FROM deposit_slips s JOIN deposits d ON d.id = s.deposit_id
     WHERE s.practice_id = ? AND s.business_date BETWEEN ? AND ? ORDER BY s.business_date, s.id`, pid, from, to,
  );
  const late = [];
  const differences = [];
  const separation = [];
  for (const s of slips) {
    if (s.stage !== 'reopened') {
      const days = s.bank_date ? businessDaysAfter(s.business_date, s.bank_date) : businessDaysAfter(s.business_date, today);
      if (days > lateDays) late.push({ deposit_id: s.deposit_id, business_date: s.business_date, total: s.total, bank_date: s.bank_date, business_days: days, prepared_by: who(s.prepared_by), still_missing: !s.bank_date });
      if (s.bank_status === 'discrepancy') differences.push({ deposit_id: s.deposit_id, business_date: s.business_date, kind: 'bank', amount: (s.bank_amount ?? 0) - s.total, reason: s.bank_note, prepared_by: who(s.prepared_by) });
    }
    if (s.difference || s.left_out_total) differences.push({ deposit_id: s.deposit_id, business_date: s.business_date, kind: 'slip', amount: s.difference, left_out: s.left_out_total, reason: s.difference_reason, prepared_by: who(s.prepared_by), reopened: s.stage === 'reopened' });
    if (s.stage === 'reopened') continue;
    const items = await db.all('SELECT * FROM deposit_slip_items WHERE deposit_id = ?', s.deposit_id);
    for (const f of await depositSeparation(db, s, items, names)) if (f.severity === 'warn') separation.push({ deposit_id: s.deposit_id, business_date: s.business_date, ...f, name: who(f.user_id) });
  }

  const receiptsVoided = (await db.all(
    `SELECT r.receipt_no, r.location_id, r.amount, r.kind, r.voided_at, r.void_reason, r.taken_by, r.voided_by FROM cash_receipts r
     WHERE r.practice_id = ? AND r.status = 'voided' AND substr(r.voided_at, 1, 10) BETWEEN ? AND ? ORDER BY r.voided_at`, pid, from, to,
  )).map((r) => ({ ...r, taken_by: who(r.taken_by), voided_by: who(r.voided_by) }));

  const reopened = slips.filter((s) => s.stage === 'reopened').map((s) => ({ deposit_id: s.deposit_id, business_date: s.business_date, reopened_by: who(s.reopened_by), reason: s.reopen_reason, prepared_by: who(s.prepared_by) }));
  const floats = (await db.all("SELECT created_at, user_id, amount, detail FROM cash_flags WHERE practice_id = ? AND kind = 'float_mismatch' AND substr(created_at, 1, 10) BETWEEN ? AND ?", pid, from, to))
    .map((f) => ({ ...f, name: who(f.user_id) }));

  return {
    from, to, settings: { late_business_days: lateDays, over_short_alert: alert },
    summary: {
      drawer_counts: sessions.length, net_over_short: sessions.reduce((s, x) => s + (x.over_short || 0), 0),
      cash_voids: voids.length, cash_refunds: refunds.length, cash_refund_total: refunds.reduce((s, r) => s + r.amount, 0),
      late_deposits: late.length, separation_warnings: separation.length, receipts_voided: receiptsVoided.length,
    },
    over_short_by_person: [...people.values()].sort((a, b) => a.net - b.net),
    over_short_trend: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    cash_voids: voids, cash_refunds: refunds, adjustments_by_person: adjustments,
    late_deposits: late, differences, separation, receipts_voided: receiptsVoided, reopened, float_mismatches: floats,
  };
}
