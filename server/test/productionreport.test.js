// Production & income (PR1): the one-screen report and its report-library entry. The route isn't mounted in
// app.js by this file's author, so the tests mount it on a small app of their own (as offline.test.js does).
// Every number is checked against the ledger itself and against the other library reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import productionReportRoutes from '../src/routes/productionreport.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, practiceNow, insert } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { runReport } from '../src/reportlibrary.js';
import { voidLedgerEntry } from '../src/services.js';

const h = harness();
let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
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
  api.use(productionReportRoutes({ db: h.db }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const get = (token) => async (path) => {
  const res = await fetch(`${origin}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, data };
};
const signIn = async (email, password) => (await h.client().post('/auth/login', { email, password })).data.token;

// Two providers, two offices, two patients; charges, write-offs, payments, and a voided charge and payment.
async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const { api, provider: ann } = p;
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', ann.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const first = `${today.slice(0, 7)}-01`;
  const hyg = (await api.post('/providers', { name: 'Hal Hygienist, RDH', type: 'hygienist' })).data;
  const north = (await api.post('/locations', { name: 'North' })).data;
  const south = (await api.post('/locations', { name: 'South' })).data;
  const jane = p.patient;
  const sam = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1970-02-03' })).data;
  const admin = await h.db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", pid);
  const entry = async (row) => insert(h.db, 'ledger_entries', { practice_id: pid, description: row.type, created_by: admin.id, location_id: north.id, entry_date: today, ...row });
  await entry({ patient_id: jane.id, type: 'charge', amount: 100000, provider_id: ann.id });
  await entry({ patient_id: jane.id, type: 'charge', amount: 20000, provider_id: hyg.id, entry_date: first });
  await entry({ patient_id: sam.id, type: 'charge', amount: 50000, provider_id: ann.id, location_id: south.id });
  const wrong = await entry({ patient_id: sam.id, type: 'charge', amount: 30000, provider_id: hyg.id });
  await entry({ patient_id: jane.id, type: 'adjustment', amount: -15000, adjustment_type: 'Insurance write-off' });
  await entry({ patient_id: sam.id, type: 'adjustment', amount: -5000, adjustment_type: 'Courtesy discount', location_id: south.id });
  await entry({ patient_id: jane.id, type: 'payment', amount: -10000, method: 'card' });
  await entry({ patient_id: jane.id, type: 'insurance_payment', amount: -40000, method: 'check' });
  await entry({ patient_id: sam.id, type: 'payment', amount: -20000, method: 'cash', location_id: south.id });
  const bounced = await entry({ patient_id: sam.id, type: 'payment', amount: -7000, method: 'check', location_id: south.id });
  // Last month: never in this month's numbers.
  const lastMonth = new Date(Date.parse(`${first}T12:00:00Z`) - 5 * 86400_000).toISOString().slice(0, 10);
  await entry({ patient_id: jane.id, type: 'charge', amount: 99900, provider_id: ann.id, entry_date: lastMonth });
  for (const id of [wrong, bounced]) await voidLedgerEntry(h.db, await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', id), { userId: admin.id, reason: 'Entered in error' });
  return { ...p, pid, today, first, hyg, north, south, sam, admin, adminUser: { practice_id: pid, role: 'admin', location_ids: null } };
}

const ledgerSum = async (pid, from, to, where) => Number((await h.db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND entry_date BETWEEN ? AND ? AND ${where}`, pid, from, to)).n);
const MONEY = ['gross', 'ppo_writeoffs', 'other_adjustments', 'adjustments', 'net', 'patient', 'insurance', 'collections', 'refunds'];

test('the numbers are the ledger: gross, write-offs split, net, collections and collection %, voided entries left out', async () => {
  const p = await setUp();
  const { status, data } = await get(p.token)(`/production-income?from=${p.first}&to=${p.today}`);
  assert.equal(status, 200);
  const t = data.totals;
  assert.equal(t.gross, 170000, 'the voided charge and last month are left out');
  assert.equal(t.ppo_writeoffs, -15000);
  assert.equal(t.other_adjustments, -5000);
  assert.equal(t.adjustments, -20000);
  assert.equal(t.net, 150000);
  assert.equal(t.patient, 30000, 'the voided payment is left out');
  assert.equal(t.insurance, 40000);
  assert.equal(t.collections, 70000);
  assert.equal(t.collection_pct, 46.7);
  // Straight from the ledger.
  assert.equal(t.gross, await ledgerSum(p.pid, p.first, p.today, "type = 'charge'"));
  assert.equal(t.adjustments, await ledgerSum(p.pid, p.first, p.today, "type = 'adjustment'"));
  assert.equal(t.collections, -(await ledgerSum(p.pid, p.first, p.today, "type IN ('payment','insurance_payment')")));
  // And the same as the other library reports over the same dates.
  const q = { from: p.first, to: p.today };
  assert.equal((await runReport(h.db, p.adminUser, 'production-by-provider', q)).totals.production, t.gross);
  const pct = (await runReport(h.db, p.adminUser, 'collection-percentage', q)).rows[0];
  assert.equal(pct.net, t.net);
  assert.equal(pct.collections, t.collections);
  assert.equal(pct.collection_pct, t.collection_pct);
  const adj = (await runReport(h.db, p.adminUser, 'adjustments-by-type', q)).rows;
  assert.equal(adj.find((r) => r.type === 'Insurance write-off').amount, t.ppo_writeoffs);
  // Daily rows with running totals ending at the totals.
  const lastDay = data.days.at(-1);
  assert.equal(lastDay.running_gross, t.gross);
  assert.equal(lastDay.running_net, t.net);
  assert.equal(lastDay.running_collections, t.collections);
  assert.equal(data.days.reduce((s, d) => s + d.gross, 0), t.gross);
});

test('the provider rows add up to the office total in every column', async () => {
  const p = await setUp();
  const { data } = await get(p.token)(`/production-income?from=${p.first}&to=${p.today}`);
  for (const k of MONEY) assert.equal(data.providers.reduce((s, r) => s + r[k], 0), data.totals[k], `${k} adds up`);
  const ann = data.providers.find((r) => r.provider_id === p.provider.id);
  const hyg = data.providers.find((r) => r.provider_id === p.hyg.id);
  assert.equal(ann.gross, 150000);
  assert.equal(hyg.gross, 20000);
  // The library's provider report agrees on who produced what.
  const lib = (await runReport(h.db, p.adminUser, 'production-by-provider', { from: p.first, to: p.today })).rows;
  assert.equal(lib.find((r) => r.provider_id === p.provider.id).production, ann.gross);
  // And the library entry itself lists the same rows, with totals equal to the office.
  const lr = await runReport(h.db, p.adminUser, 'production-income', { from: p.first, to: p.today });
  assert.equal(lr.totals.gross, 170000);
  assert.equal(lr.totals.collections, 70000);
  assert.equal(lr.totals.collection_pct, 46.7);
});

test('one office: only that office’s entries', async () => {
  const p = await setUp();
  const { data } = await get(p.token)(`/production-income?from=${p.first}&to=${p.today}&location_id=${p.south.id}`);
  assert.equal(data.totals.gross, 50000);
  assert.equal(data.totals.other_adjustments, -5000);
  assert.equal(data.totals.ppo_writeoffs, 0);
  assert.equal(data.totals.patient, 20000);
  assert.equal(data.totals.collections, 20000);
  for (const k of MONEY) assert.equal(data.providers.reduce((s, r) => s + r[k], 0), data.totals[k], `${k} adds up`);
  // Someone limited to North sees North's numbers, and can't pick South.
  const email = `north-${Date.now()}@example.com`;
  await p.api.post('/users', { email, name: 'North Desk', role: 'billing', password: 'correct-horse-battery', location_ids: [p.north.id] });
  const token = await signIn(email, 'correct-horse-battery');
  const mine = await get(token)(`/production-income?from=${p.first}&to=${p.today}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.totals.gross, 120000);
  assert.equal((await get(token)(`/production-income?location_id=${p.south.id}`)).status, 403);
});

test('the month projection: done so far + planned on this month’s visits from today, beside the goal', async () => {
  const p = await setUp();
  await p.api.put('/practice', { daily_goal: 100000 });
  const code = await h.db.get("SELECT * FROM procedure_codes WHERE practice_id = ? AND code = 'D2740'", p.pid);
  const visit = async (status) => insert(h.db, 'appointments', { practice_id: p.pid, patient_id: p.patient.id, provider_id: p.provider.id, start_time: `${p.today} 23:00`, end_time: `${p.today} 23:30`, status, location_id: p.north.id });
  const proc = async (appointment_id, status, fee) => insert(h.db, 'procedures', { practice_id: p.pid, patient_id: p.patient.id, appointment_id, provider_id: p.provider.id, code_id: code.id, code: code.code, description: code.description, category: code.category, fee, status });
  const booked = await visit('scheduled');
  await proc(booked, 'planned', 120000);
  await proc(booked, 'cancelled', 55500);
  await proc(await visit('cancelled'), 'planned', 77700);
  const { data } = await get(p.token)(`/production-income?from=${p.first}&to=${p.today}`);
  const pr = data.projection;
  assert.ok(pr, 'the dates run through today');
  assert.equal(pr.month_to_date, 170000);
  assert.equal(pr.scheduled, 120000, 'planned work on live visits only');
  assert.equal(pr.projected, pr.month_to_date + pr.scheduled);
  assert.ok(pr.goal > 0 && pr.goal % 100000 === 0, 'daily goal × open days');
  assert.match(pr.goal_source, /Daily goal/);
  const ann = data.providers.find((r) => r.provider_id === p.provider.id);
  assert.equal(ann.scheduled, 120000);
  assert.equal(ann.projected, ann.month_to_date + 120000);
  // The drill-down lists the planned work behind it.
  const drill = await get(p.token)(`/production-income/entries?metric=scheduled&from=${p.first}&to=${p.today}`);
  assert.equal(drill.data.total, 120000);
  // A past range doesn't project.
  const past = await get(p.token)(`/production-income?from=2020-01-01&to=2020-01-31`);
  assert.equal(past.data.projection, null);
});

test('drill-down: the entries behind each number add up to it', async () => {
  const p = await setUp();
  const g = get(p.token);
  const { data } = await g(`/production-income?from=${p.first}&to=${p.today}`);
  for (const metric of ['gross', 'ppo_writeoffs', 'other_adjustments', 'adjustments', 'net', 'patient', 'insurance', 'collections']) {
    const d = await g(`/production-income/entries?metric=${metric}&from=${p.first}&to=${p.today}`);
    assert.equal(d.status, 200);
    assert.equal(d.data.total, data.totals[metric], `${metric} drill adds up`);
  }
  const gross = await g(`/production-income/entries?metric=gross&from=${p.first}&to=${p.today}`);
  assert.ok(gross.data.rows.some((r) => r.status === 'Voided') && gross.data.rows.some((r) => r.status === 'Reversal'), 'a void and its reversal both show, and cancel out');
  // A provider's numbers.
  for (const row of data.providers.filter((r) => r.provider_id)) {
    for (const metric of ['gross', 'patient', 'insurance', 'collections', 'adjustments', 'ppo_writeoffs']) {
      const d = await g(`/production-income/entries?metric=${metric}&provider_id=${row.provider_id}&from=${p.first}&to=${p.today}`);
      assert.equal(d.data.total, row[metric], `${row.provider} ${metric}`);
    }
  }
  // One day.
  const day = data.days[0];
  assert.equal((await g(`/production-income/entries?metric=gross&day=${day.day}&from=${p.first}&to=${p.today}`)).data.total, day.gross);
  // Bad input is refused.
  assert.equal((await g(`/production-income/entries?metric=profit`)).status, 400);
  assert.equal((await g(`/production-income/entries?metric=gross&provider_id=abc`)).status, 400);
  const other = await h.practice();
  assert.equal((await g(`/production-income/entries?metric=gross&provider_id=${other.provider.id}`)).status, 404, 'another practice’s provider');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'report.drill'", p.pid), 'viewing entries is audited');
});

test('CSV export is audited; people without reports permission are refused; practices never mix', async () => {
  const p = await setUp();
  const csv = await get(p.token)(`/production-income?from=${p.first}&to=${p.today}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Gross production \(\$\)/);
  assert.match(csv.data, /Office total,Total,1700\.00/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'report.export'", p.pid));
  const email = `desk-${Date.now()}@example.com`;
  await p.api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  assert.equal((await get(await signIn(email, 'front-desk-password'))('/production-income')).status, 403);
  const other = await h.practice();
  const theirs = await get(other.token)(`/production-income?from=${p.first}&to=${p.today}`);
  assert.equal(theirs.data.totals.gross, 0);
  assert.equal((await get(p.token)('/production-income?from=2024-02-30')).status, 400);
});
