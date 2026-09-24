// Daily deposits and cash handling (DC1-DC3): deposit totals against the ledger, locking, verification by a second
// person, reopening, idempotent submit, blind drawer counts, numbered cash receipts, cash controls on voids and
// refunds, separation of duties, bank matching and exceptions, isolation and permissions.
// The routes aren't mounted in app.js by this file's author, so the tests mount them (with the cash guards in front
// of the ledger's own routes, as app.js should) on a small app of their own over the harness's database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { harness } from './helpers.js';
import cashDepositRoutes, { cashGuardRoutes } from '../src/routes/cashdeposits.js';
import billingRoutes from '../src/routes/billing.js';
import { randomUUID } from 'node:crypto';
import { authenticate, HttpError, signToken } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, practiceNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { createStorage } from '../src/storage.js';
import { autoMatch, recordMatch } from '../src/finance/service.js';
import { countCash, reconcileDeposit, overShort, businessDaysAfter, separationFlags } from '../src/deposits.js';

const h = harness();
let origin;
let server;
const dir = mkdtempSync(join(tmpdir(), 'dm-deposits-'));
before(async () => {
  for (let i = 0; !h.db && i < 1500; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(cashGuardRoutes({ db: h.db }));
  api.use(billingRoutes({ db: h.db }));
  api.use(cashDepositRoutes({ db: h.db, storage: createStorage({ dir, key: 'a'.repeat(64), s3: null }) }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, details: err.details }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

// A client for the small app (the harness's own client talks to the full app).
const client = (token, headers = {}) => {
  const call = async (method, path, body, extra = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`${origin}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers, ...extra },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b ?? {}, x), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
};
// A session for a new staff member without going through the login form (its rate limit is per IP).
const signIn = async (email) => {
  const u = await h.db.get('SELECT id, practice_id, role, token_version FROM users WHERE lower(email) = lower(?)', email);
  const sid = `test-${randomUUID()}`;
  await h.db.run('INSERT INTO staff_sessions (sid, user_id, practice_id, last_seen_at) VALUES (?, ?, ?, ?)', sid, u.id, u.practice_id, new Date().toISOString());
  return signToken({ sub: u.id, pid: u.practice_id, role: u.role, aud: 'staff', tv: u.token_version ?? 0, sid }, 'test-secret');
};
let seq = 0;
async function staff(p, role, extra = {}) {
  const email = `${role}${++seq}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const u = await p.api.post('/users', { email, name: `${role} ${seq}`, role, password: 'correct-horse-battery', ...extra });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  return { ...u.data, token: await signIn(email) };
}
const key = () => `k-${Math.random().toString(36).slice(2)}${Date.now()}`;

async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const admin = client(p.token);
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const pay = async (c, amount, method, extra = {}) => {
    const r = await c.post(`/patients/${extra.patient_id || p.patient.id}/payments`, { amount, method, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.entry;
  };
  return { ...p, pid, admin, today, pay };
}

// ---- Pure arithmetic ----

test('arithmetic: counting by denomination, reconciling, over/short, business days, separation of duties', () => {
  assert.deepEqual(countCash({ b20: 3, c25: '4', b1: '' }), { detail: { b20: 3, c25: 4 }, total: 6100 });
  assert.throws(() => countCash({ b20: -1 }), /whole number/);
  assert.throws(() => countCash({ b3: 1 }), /Unknown/);
  assert.throws(() => countCash({ b20: 1.5 }), /whole number/);
  const entries = [{ id: 1, kind: 'cash', amount: 5000 }, { id: 2, kind: 'check', amount: 12000 }, { id: 3, kind: 'cash_refund', amount: -1000 }, { id: 4, kind: 'check', amount: 700 }];
  const r = reconcileDeposit({ entries, included: [1, 2, 3], cashCounted: 4000 });
  assert.equal(r.cash_expected, 4000);
  assert.equal(r.total, 16000);
  assert.equal(r.difference, 0);
  assert.equal(r.left_out_total, 700);
  assert.equal(r.balanced, false, 'a payment left off needs a reason');
  assert.equal(reconcileDeposit({ entries, included: [1, 2, 3, 4], cashCounted: 3900 }).difference, -100);
  assert.equal(reconcileDeposit({ entries, included: [1, 2, 3, 4], cashCounted: 4000 }).balanced, true);
  assert.equal(overShort(12900, 13000), -100);
  assert.equal(overShort(13050, 13000), 50);
  assert.equal(businessDaysAfter('2026-09-25', '2026-09-28'), 1, 'Friday to Monday is one business day');
  assert.equal(businessDaysAfter('2026-09-21', '2026-09-24'), 3);
  const flags = separationFlags({ items: [{ kind: 'cash', patient_id: 9, taken_by: 1 }], adjustments: [{ patient_id: 9, created_by: 1, amount: -500 }], preparedBy: 1, names: { 1: 'Sam' } });
  assert.deepEqual(flags.map((f) => f.kind), ['took_adjusted_prepared', 'took_and_prepared']);
  assert.match(flags[0].text, /Sam took payments, posted adjustments/);
  assert.deepEqual(separationFlags({ items: [{ kind: 'cash', patient_id: 9, taken_by: 2 }], adjustments: [{ patient_id: 9, created_by: 1, amount: -500 }], preparedBy: 1 }), []);
});

// ---- DC1 ----

test('the deposit equals the ledger (voided payments excluded), balances or needs a reason, and locks', async () => {
  const s = await setUp();
  await s.pay(s.admin, 5000, 'cash');
  const check = await s.pay(s.admin, 12000, 'check', { reference: '1042' });
  const wrong = await s.pay(s.admin, 2000, 'cash');
  await s.pay(s.admin, 3000, 'credit_card');
  assert.equal((await s.admin.post(`/ledger/${wrong.id}/void`, { reason: 'Keyed twice' })).status, 201);

  const build = (await s.admin.get('/daily-deposits/build')).data;
  assert.equal(build.cash_expected, 5000, 'the voided $20 is not expected');
  assert.deepEqual(build.checks.map((c) => [c.payer, c.check_number, c.amount]), [['Jane Doe', '1042', 12000]]);
  assert.equal(build.day_ledger.total, 17000);
  assert.equal(build.electronic.length, 1, 'the card batch is its own deposit type');
  assert.equal(build.electronic[0].amount, 3000);
  const ids = build.entries.map((e) => e.id);

  // $49 in the bag against $50 on the ledger: refused without a reason.
  const short = await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b20: 2, b5: 1, b1: 4 }, bag_number: 'B-1' });
  assert.equal(short.status, 400);
  assert.equal(short.data.details.needs_reason, true);
  assert.equal(short.data.details.difference, -100);
  assert.equal((await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b50: 1 } })).status, 400, 'bag number required');

  const ok = await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b20: 2, b10: 1 }, bag_number: 'B-1' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.total, 17000);
  assert.equal(ok.data.ledger_total, 17000);
  assert.equal(ok.data.difference, 0);
  assert.equal(ok.data.stage, 'submitted');
  assert.equal(ok.data.checks[0].check_number, '1042');
  const dep = await h.db.get('SELECT * FROM deposits WHERE id = ?', ok.data.id);
  assert.equal(dep.total, 17000, 'a deposits row, so the bank feed matching sees it');
  assert.equal((await h.db.get('SELECT deposit_id FROM ledger_entries WHERE id = ?', check.id)).deposit_id, ok.data.id);

  // Locked: no edits, the same payments can't go on another deposit.
  assert.equal((await s.admin.patch(`/daily-deposits/${ok.data.id}`, { bag_number: 'B-2' })).status, 409);
  assert.equal((await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: [check.id], cash_count: {}, bag_number: 'B-3' })).status, 409);
  assert.equal((await s.admin.get('/daily-deposits/build')).data.entries.length, 0);

  // Short with a reason: kept, flagged for the owner.
  await s.pay(s.admin, 1500, 'cash');
  const b2 = (await s.admin.get('/daily-deposits/build')).data;
  const withReason = await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: b2.entries.map((e) => e.id), cash_count: { b10: 1 }, bag_number: 'B-2', difference_reason: 'Counted twice; $5 missing, manager told' });
  assert.equal(withReason.status, 201);
  assert.equal(withReason.data.difference, -500);
  assert.equal(withReason.data.difference_reason, 'Counted twice; $5 missing, manager told');
  assert.ok(await h.db.get("SELECT id FROM cash_flags WHERE kind = 'deposit_difference' AND deposit_id = ?", withReason.data.id));
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'deposit.submit' AND entity_id = ?", withReason.data.id);
  assert.equal(a.reason, 'Counted twice; $5 missing, manager told');

  // The slip prints.
  const pdf = await fetch(`${origin}/api/daily-deposits/${ok.data.id}/slip.pdf`, { headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('submit is idempotent: the same key (even twice at once) makes one deposit', async () => {
  const s = await setUp();
  await s.pay(s.admin, 4000, 'cash');
  const ids = (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id);
  const body = { submit_key: key(), entry_ids: ids, cash_count: { b20: 2 }, bag_number: 'X1' };
  const [a, b] = await Promise.all([s.admin.post('/daily-deposits', body), s.admin.post('/daily-deposits', body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.data.id, b.data.id);
  const again = await s.admin.post('/daily-deposits', body);
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM deposit_slips WHERE practice_id = ?', s.pid)).n), 1);
});

test('verification by a different manager; a manager reopens with a reason and the original is kept', async () => {
  const s = await setUp();
  const other = await staff(s, 'admin');
  const billing = await staff(s, 'billing');
  const bill = client(billing.token);
  await s.pay(bill, 6000, 'cash');
  const ids = (await bill.get('/daily-deposits/build')).data.entries.map((e) => e.id);
  const dep = (await bill.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b50: 1, b10: 1 }, bag_number: 'V1' })).data;
  assert.equal(dep.prepared_by, billing.id);

  assert.equal((await bill.post(`/daily-deposits/${dep.id}/verify`)).status, 403, 'billing staff can’t verify');
  assert.equal((await bill.post(`/daily-deposits/${dep.id}/reopen`, { reason: 'x' })).status, 403, 'nor reopen');
  const v = await s.admin.post(`/daily-deposits/${dep.id}/verify`);
  assert.equal(v.status, 200);
  assert.equal(v.data.verified_by_name, s.admin && v.data.verified_by_name);
  assert.equal((await s.admin.post(`/daily-deposits/${dep.id}/verify`)).status, 409);

  // The preparer can't verify their own even as a manager.
  await s.pay(s.admin, 1000, 'cash');
  const mine = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id), cash_count: { b10: 1 }, bag_number: 'V2' })).data;
  assert.equal((await s.admin.post(`/daily-deposits/${mine.id}/verify`)).status, 403);
  assert.equal((await client(other.token).post(`/daily-deposits/${mine.id}/verify`)).status, 200);

  // Reopen: reason required; the deposit is voided and kept with its items; its payments wait again.
  assert.equal((await s.admin.post(`/daily-deposits/${dep.id}/reopen`, {})).status, 400);
  const re = await s.admin.post(`/daily-deposits/${dep.id}/reopen`, { reason: 'Bag held a $10 that belonged to tomorrow' });
  assert.equal(re.status, 200);
  assert.equal(re.data.stage, 'reopened');
  assert.equal(re.data.items.length, 1, 'the original slip keeps its items');
  const kept = await h.db.get('SELECT * FROM deposits WHERE id = ?', dep.id);
  assert.ok(kept.voided_at);
  assert.match(kept.void_reason, /Reopened: Bag held/);
  const audit = await h.db.get("SELECT * FROM audit_log WHERE action = 'deposit.reopen' AND entity_id = ?", dep.id);
  assert.equal(audit.reason, 'Bag held a $10 that belonged to tomorrow');
  assert.equal(audit.user_id, (await h.db.get('SELECT id FROM users WHERE practice_id = ? AND role = ? ORDER BY id LIMIT 1', s.pid, 'admin')).id);
  const waiting = (await bill.get('/daily-deposits/build')).data;
  assert.deepEqual(waiting.entries.map((e) => e.id), ids);
  assert.equal(waiting.reopened[0].deposit_id, dep.id);
  const fixed = await bill.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b50: 1, b10: 1 }, bag_number: 'V1b', replaces_deposit_id: dep.id });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.data.replaces_deposit_id, dep.id);
  assert.equal((await s.admin.get(`/daily-deposits/${dep.id}`)).data.replaced_by, fixed.data.id);
  assert.equal((await s.admin.post(`/daily-deposits/${dep.id}/reopen`, { reason: 'again' })).status, 409);
});

// ---- DC3 ----

test('drawers: the count is blind until submitted; over/short needs a second person and a reason', async () => {
  const s = await setUp();
  const billing = await staff(s, 'billing');
  const bill = client(billing.token);
  assert.equal((await bill.post('/cash/drawers', { name: 'Front 1', default_float: 10000 })).status, 403, 'managers set up drawers');
  const drawer = (await s.admin.post('/cash/drawers', { name: 'Front 1', default_float: 10000 })).data;
  const open = await bill.post(`/cash/drawers/${drawer.id}/open`, {});
  assert.equal(open.status, 201);
  assert.equal(open.data.opening_float, 10000);
  assert.equal((await bill.post(`/cash/drawers/${drawer.id}/open`, {})).status, 409, 'one open session per drawer');
  await s.pay(bill, 3000, 'cash');
  await s.pay(bill, 450, 'cash');

  // Nothing the counter can see adds up to the expected $134.50.
  for (const path of [`/cash/sessions/${open.data.id}`, '/cash/drawers']) {
    const r = await bill.get(path);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /expected|13450|3450|"to_deposit"/, `${path} leaks the expected amount`);
  }
  const counted = await bill.post(`/cash/sessions/${open.data.id}/count`, { count: { b100: 1, b20: 1, b10: 1, b1: 4 } });
  assert.equal(counted.status, 200);
  assert.equal(counted.data.counted_total, 13400);
  assert.equal(counted.data.expected_total, 13450, 'shown only after the count is in');
  assert.equal(counted.data.over_short, -50);
  assert.equal(counted.data.over_short_label, 'short');
  assert.equal((await bill.post(`/cash/sessions/${open.data.id}/count`, { count: { b100: 2 } })).status, 409, 'one count');

  assert.equal((await bill.post(`/cash/sessions/${open.data.id}/verify`, { reason: 'x' })).status, 403);
  assert.equal((await s.admin.post(`/cash/sessions/${open.data.id}/verify`, {})).status, 400, 'short needs a reason');
  const v = await s.admin.post(`/cash/sessions/${open.data.id}/verify`, { reason: 'Gave 50¢ too much change', float_kept: 10000 });
  assert.equal(v.status, 200);
  assert.equal(v.data.status, 'closed');
  assert.equal(v.data.to_deposit, 3400);
  assert.equal(v.data.over_short_reason, 'Gave 50¢ too much change');

  // The day's deposit takes the verified drawer's cash (≤ 4 actions when it balances... here it's 50¢ short).
  const build = (await bill.get('/daily-deposits/build')).data;
  assert.deepEqual(build.drawers.map((d) => [d.id, d.to_deposit]), [[open.data.id, 3400]]);
  const dep = await bill.post('/daily-deposits', { submit_key: key(), entry_ids: build.entries.map((e) => e.id), drawer_session_ids: [open.data.id], bag_number: 'D1' });
  assert.equal(dep.status, 400, 'the drawer was short, so the deposit needs the reason too');
  const dep2 = await bill.post('/daily-deposits', { submit_key: key(), entry_ids: build.entries.map((e) => e.id), drawer_session_ids: [open.data.id], bag_number: 'D1', difference_reason: 'Drawer short 50¢ (see drawer)' });
  assert.equal(dep2.status, 201);
  assert.equal(dep2.data.cash_total, 3400);
  assert.equal(dep2.data.cash_source, 'drawers');
  assert.equal((await h.db.get('SELECT deposit_id FROM cash_drawer_sessions WHERE id = ?', open.data.id)).deposit_id, dep2.data.id);

  // Opening with a different float than the last close left is flagged.
  await bill.post(`/cash/drawers/${drawer.id}/open`, { opening_float: 9000 });
  assert.ok(await h.db.get("SELECT id FROM cash_flags WHERE practice_id = ? AND kind = 'float_mismatch'", s.pid));
});

test('cash receipts are numbered per office, unique and without gaps under concurrent requests; voided ones stay', async () => {
  const s = await setUp();
  const main = (await s.api.post('/locations', { name: 'Main' })).data;
  const west = (await s.api.post('/locations', { name: 'West' })).data;
  const atMain = client(s.token, { 'X-Location-Id': String(main.id) });
  const atWest = client(s.token, { 'X-Location-Id': String(west.id) });
  const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => s.pay(i % 3 === 2 ? atWest : atMain, 100 + i, 'cash')));
  // Everyone asks for a number at once.
  const res = await Promise.all([...entries, ...entries].map((e) => atMain.post('/cash/receipts', { ledger_entry_id: e.id })));
  assert.ok(res.every((r) => [200, 201].includes(r.status)), JSON.stringify(res.map((r) => r.data)));
  const rows = await h.db.all('SELECT * FROM cash_receipts WHERE practice_id = ? ORDER BY office_key, receipt_no', s.pid);
  assert.equal(rows.length, 12, 'one receipt per payment');
  const mainNos = rows.filter((r) => r.office_key === main.id).map((r) => r.receipt_no);
  const westNos = rows.filter((r) => r.office_key === west.id).map((r) => r.receipt_no);
  assert.deepEqual(mainNos, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(westNos, [1, 2, 3, 4]);
  // Same payment, same number.
  const again = await atMain.post('/cash/receipts', { ledger_entry_id: entries[0].id });
  assert.equal(again.status, 200);
  assert.equal(again.data.receipt_no, rows.find((r) => r.ledger_entry_id === entries[0].id).receipt_no);
  // Checks don't get cash receipts.
  const chk = await s.pay(atMain, 500, 'check');
  assert.equal((await atMain.post('/cash/receipts', { ledger_entry_id: chk.id })).status, 400);
  // A voided payment's receipt stays on the list, marked voided; the next payment takes the next number.
  assert.equal((await atMain.post(`/ledger/${entries[0].id}/void`, { reason: 'Wrong patient' })).status, 201);
  await new Promise((r) => setTimeout(r, 50));
  const list = (await atMain.get(`/cash/receipts?location_id=${main.id}`)).data;
  assert.equal(list.length, 8);
  assert.equal(list.find((r) => r.ledger_entry_id === entries[0].id).status, 'voided');
  const next = await s.pay(atMain, 999, 'cash');
  assert.equal((await atMain.post('/cash/receipts', { ledger_entry_id: next.id })).data.receipt_no, 9);
  // Another practice can't number this practice's payments.
  const other = await setUp();
  assert.equal((await other.admin.post('/cash/receipts', { ledger_entry_id: next.id })).status, 404);
});

test('cash voids, cash refunds and cash discounts need a manager and are recorded', async () => {
  const s = await setUp();
  const billing = await staff(s, 'billing');
  const bill = client(billing.token);
  const cash = await s.pay(bill, 2500, 'cash');
  const chk = await s.pay(bill, 2500, 'check', { reference: '77' });
  assert.equal((await bill.post(`/ledger/${cash.id}/void`, { reason: 'oops' })).status, 403, 'cash void needs a manager');
  assert.equal((await bill.post(`/ledger/${chk.id}/void`, { reason: 'bounced' })).status, 201, 'a check (not on a deposit) is ordinary');
  assert.equal((await s.admin.post(`/ledger/${cash.id}/void`, { reason: 'Patient paid by card instead' })).status, 201);
  await new Promise((r) => setTimeout(r, 50));
  const f = await h.db.get("SELECT * FROM cash_flags WHERE kind = 'cash_void' AND ledger_entry_id = ?", cash.id);
  assert.equal(f.approved_by, (await h.db.get('SELECT id FROM users WHERE practice_id = ? AND role = ? ORDER BY id LIMIT 1', s.pid, 'admin')).id);
  assert.equal(f.user_id, billing.id);

  // Refund in cash (the account has a credit).
  await s.pay(bill, 4000, 'cash');
  assert.equal((await bill.post(`/patients/${s.patient.id}/refunds`, { amount: 1000, method: 'cash' })).status, 403);
  // Card and check refunds need a manager too (owner decision: refunds are a sensitive action).
  const checkRefund = await bill.post(`/patients/${s.patient.id}/refunds`, { amount: 500, method: 'check', reference: '1001' });
  assert.equal(checkRefund.status, 403);
  assert.equal(checkRefund.data.details?.manager_required ?? checkRefund.data.manager_required ?? true, true);
  assert.equal((await s.admin.post(`/patients/${s.patient.id}/refunds`, { amount: 1000, method: 'cash' })).status, 201);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(await h.db.get("SELECT id FROM cash_flags WHERE kind = 'cash_refund' AND practice_id = ?", s.pid));
  assert.ok(await h.db.get("SELECT id FROM cash_receipts WHERE kind = 'payout' AND practice_id = ?", s.pid), 'cash paid out is numbered too');

  // A discount on an account the same person took cash from today.
  assert.equal((await bill.post(`/patients/${s.patient.id}/adjustments`, { amount: -500, description: 'Courtesy' })).status, 403);
  const sam = (await s.api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1970-02-03' })).data;
  assert.equal((await bill.post(`/patients/${sam.id}/adjustments`, { amount: -500, description: 'Courtesy' })).status, 201, 'no cash from Sam today: ordinary');

  // A payment on a submitted deposit can only be voided by a manager (and the deposit shows it).
  const c2 = await s.pay(bill, 1200, 'check', { reference: '88' });
  const ids = (await bill.get('/daily-deposits/build')).data.entries.map((e) => e.id);
  const dep = (await bill.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b20: 1, b10: 1 }, bag_number: 'G1' })).data;
  assert.equal((await bill.post(`/ledger/${c2.id}/void`, { reason: 'bounced' })).status, 403);
  assert.equal((await s.admin.post(`/ledger/${c2.id}/void`, { reason: 'Bounced' })).status, 201);
  const detail = (await s.admin.get(`/daily-deposits/${dep.id}`)).data;
  assert.equal(detail.status, 'exception');
  assert.ok(detail.exceptions.some((x) => x.kind === 'item_voided'));
  await s.admin.post('/daily-deposits/check');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", s.pid, `deposit-item-voided:${dep.id}`));
});

test('separation of duties: took the cash, adjusted the account and prepared the deposit — on the deposit and in the owner report', async () => {
  const s = await setUp();
  await s.pay(s.admin, 8000, 'cash');
  assert.equal((await s.admin.post(`/patients/${s.patient.id}/adjustments`, { amount: -2000, description: 'Courtesy discount' })).status, 201);
  const ids = (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id);
  const dep = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: ids, cash_count: { b50: 1, b20: 1, b10: 1 }, bag_number: 'S1' })).data;
  assert.deepEqual(dep.separation.map((f) => f.kind), ['took_adjusted_prepared', 'took_and_prepared']);
  const report = await s.admin.get('/cash/integrity');
  assert.equal(report.status, 200);
  assert.equal(report.data.separation.length, 1);
  assert.equal(report.data.separation[0].deposit_id, dep.id);
  assert.equal(report.data.adjustments_by_person[0].amount, 2000);
  assert.ok(report.data.summary);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'report.cash_integrity' AND practice_id = ?", s.pid));
});

// ---- DC2 ----

test('bank: matched from the feed (in bank → reconciled when verified), short raises and resolves, late raises and resolves', async () => {
  const s = await setUp();
  const other = await staff(s, 'admin');
  const conn = await h.db.run("INSERT INTO bank_connections (practice_id, provider, status) VALUES (?, 'plaid', 'active')", s.pid);
  const acct = await h.db.run("INSERT INTO bank_accounts (practice_id, connection_id, external_id, name, deposits_here, active) VALUES (?, ?, 'acc1', 'Checking', 1, 1)", s.pid, conn.id);
  const credit = async (amount, date, ext) => (await h.db.get('SELECT * FROM bank_transactions WHERE id = ?',
    (await h.db.run('INSERT INTO bank_transactions (practice_id, account_id, external_id, date, amount, description) VALUES (?, ?, ?, ?, ?, ?)', s.pid, acct.id, ext, date, amount, 'DEPOSIT')).id));

  // An exact deposit is matched automatically by the existing matching.
  await s.pay(s.admin, 5000, 'cash');
  const d1 = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id), cash_count: { b50: 1 }, bag_number: 'K1' })).data;
  await credit(5000, s.today, 'tx1');
  assert.equal(await autoMatch(h.db, s.pid), 1);
  await s.admin.post('/daily-deposits/check');
  assert.equal((await s.admin.get(`/daily-deposits/${d1.id}`)).data.stage, 'in_bank', 'in the bank, waiting for the second person');
  await client(other.token).post(`/daily-deposits/${d1.id}/verify`);
  assert.equal((await s.admin.get(`/daily-deposits/${d1.id}`)).data.stage, 'reconciled');

  // Short at the bank: an exception in Needs attention until a manager records why.
  await s.pay(s.admin, 7000, 'cash');
  const d2 = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id), cash_count: { b50: 1, b20: 1 }, bag_number: 'K2' })).data;
  const t2 = await credit(6900, s.today, 'tx2');
  await recordMatch(h.db, t2, { keys: [`deposit:${d2.id}`], items: [{ key: `deposit:${d2.id}`, kind: 'deposit', amount: 7000, date: s.today }] }, { status: 'manual' });
  const list = (await s.admin.get('/daily-deposits')).data;
  const row = list.deposits.find((d) => d.id === d2.id);
  assert.equal(row.status, 'exception');
  assert.equal(row.exceptions[0].kind, 'short');
  const issueKey = `deposit-bank-diff:${d2.id}`;
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", s.pid, issueKey));
  assert.equal((await s.admin.post(`/daily-deposits/${d2.id}/reopen`, { reason: 'x' })).status, 409, 'in the bank: record the difference instead');
  const noted = await s.admin.post(`/daily-deposits/${d2.id}/bank-note`, { reason: 'Bank took a $1 coin-counting fee' });
  assert.equal(noted.status, 200);
  assert.equal(noted.data.exceptions.length, 0);
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'resolved'", s.pid, issueKey));

  // Late: a deposit from 10 days ago not in the bank.
  const old = new Date(Date.parse(`${s.today}T12:00:00Z`) - 10 * 86400_000).toISOString().slice(0, 10);
  await s.pay(s.admin, 3000, 'check', { reference: '555', entry_date: old });
  const b = (await s.admin.get(`/daily-deposits/build?date=${old}`)).data;
  const d3 = (await s.admin.post('/daily-deposits', { submit_key: key(), business_date: old, entry_ids: b.entries.map((e) => e.id), cash_count: {}, bag_number: 'K3' })).data;
  await s.admin.post('/daily-deposits/check');
  const lateKey = `deposit-late:deposit:${d3.id}`;
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", s.pid, lateKey));
  await credit(3000, s.today, 'tx3');
  assert.equal(await autoMatch(h.db, s.pid), 1);
  await s.admin.post('/daily-deposits/check');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'resolved'", s.pid, lateKey));
  // The owner report lists it as late to the bank.
  const report = (await s.admin.get(`/cash/integrity?from=${old}&to=${s.today}`)).data;
  assert.ok(report.late_deposits.some((d) => d.deposit_id === d3.id));
});

test('photo of the stamped slip is stored encrypted and added, never replaced', async () => {
  const s = await setUp();
  await s.pay(s.admin, 1000, 'cash');
  const dep = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id), cash_count: { b10: 1 }, bag_number: 'P1' })).data;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const up = await s.admin.post(`/daily-deposits/${dep.id}/photos`, png, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 201);
  assert.equal((await s.admin.post(`/daily-deposits/${dep.id}/photos`, Buffer.from('<html>hello world....'), { 'Content-Type': 'image/png' })).status, 415);
  const row = await h.db.get('SELECT * FROM deposit_photos WHERE id = ?', up.data.id);
  assert.equal(row.encrypted, 1);
  const back = await fetch(`${origin}/api/daily-deposits/${dep.id}/photos/${up.data.id}`, { headers: { Authorization: `Bearer ${s.token}` } });
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), png);
});

test('isolation and permissions: other practices, other offices, roles', async () => {
  const s = await setUp();
  await s.pay(s.admin, 1000, 'cash');
  const dep = (await s.admin.post('/daily-deposits', { submit_key: key(), entry_ids: (await s.admin.get('/daily-deposits/build')).data.entries.map((e) => e.id), cash_count: { b10: 1 }, bag_number: 'I1' })).data;
  const other = await setUp();
  for (const path of [`/daily-deposits/${dep.id}`]) assert.equal((await other.admin.get(path)).status, 404);
  assert.equal((await other.admin.post(`/daily-deposits/${dep.id}/verify`)).status, 404);
  assert.equal((await other.admin.post(`/daily-deposits/${dep.id}/reopen`, { reason: 'x' })).status, 404);
  assert.equal((await other.admin.get('/cash/integrity')).data.separation.length, 0);

  // A dentist sees billing but can't take money to the bank; billing staff can't see the owner report.
  const dentist = client((await staff(s, 'dentist')).token);
  assert.equal((await dentist.get('/daily-deposits/build')).status, 200);
  assert.equal((await dentist.post('/daily-deposits', { submit_key: key(), entry_ids: [], cash_count: { b1: 1 }, bag_number: 'Z' })).status, 403);
  const bill = client((await staff(s, 'billing')).token);
  assert.equal((await bill.get('/cash/integrity')).status, 403);
  assert.equal((await bill.put('/cash/settings', { late_business_days: 5 })).status, 403);
  assert.equal((await s.admin.put('/cash/settings', { late_business_days: 5 })).data.late_business_days, 5);
  assert.equal((await s.admin.put('/cash/settings', { late_business_days: 0 })).status, 400);

  // Offices: someone limited to West doesn't see Main's deposit.
  const m = await setUp();
  const main = (await m.api.post('/locations', { name: 'Main' })).data;
  const west = (await m.api.post('/locations', { name: 'West' })).data;
  const atMain = client(m.token, { 'X-Location-Id': String(main.id) });
  await m.pay(atMain, 2000, 'cash');
  const b = (await atMain.get(`/daily-deposits/build?location_id=${main.id}`)).data;
  assert.equal(b.cash_expected, 2000);
  assert.equal((await atMain.get(`/daily-deposits/build?location_id=${west.id}`)).data.cash_expected, 0, 'each office its own deposit');
  assert.equal((await m.admin.get('/daily-deposits/build')).status, 400, 'several offices: say which');
  const mdep = (await atMain.post('/daily-deposits', { submit_key: key(), location_id: main.id, entry_ids: b.entries.map((e) => e.id), cash_count: { b20: 1 }, bag_number: 'M1' })).data;
  assert.equal(mdep.location_id, main.id);
  const westie = await staff(m, 'billing', { location_ids: [west.id] });
  const w = client(westie.token);
  { const x = await w.get(`/daily-deposits/${mdep.id}`); assert.equal(x.status, 404, x.text); }
  assert.equal((await w.get(`/daily-deposits/build?location_id=${main.id}`)).status, 403);
  assert.equal((await w.get('/daily-deposits')).data.deposits.length, 0);
  assert.equal((await atMain.get('/daily-deposits/build?location_id=99999')).status, 404);
  assert.equal((await atMain.get('/daily-deposits/build?date=2999-01-01')).status, 400);
  assert.equal((await atMain.get('/daily-deposits/build?date=2026-02-31')).status, 400);
});
