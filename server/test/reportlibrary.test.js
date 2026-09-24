import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { officeAccess } from '../src/officeaccess.js';
import reportLibraryRoutes from '../src/routes/reportlibrary.js';
import { LIBRARY, getReport, savedQuery } from '../src/reportlibrary.js';
import { REPORTS } from '../src/savedreports.js';

const h = harness();

// The library's router, served the way app.js serves every staff route (sign-in, then office limits). When app.js
// already mounts it, the tests use the real app instead.
let origin = null;
let server = null;
after(() => server?.close());

async function lib(token) {
  if (!origin) {
    const probe = await h.client(token).get('/report-library');
    if (probe.status === 200) origin = h.origin;
    else {
      const app = express();
      const api = express.Router();
      api.use(authenticate(h.db, 'test-secret'));
      api.use(officeAccess(h.db));
      api.use(reportLibraryRoutes({ db: h.db }));
      app.use('/api', api);
      // eslint-disable-next-line no-unused-vars
      app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
      await new Promise((resolve) => { server = app.listen(0, resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
    }
  }
  return async (path) => {
    const res = await fetch(`${origin}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data, headers: res.headers };
  };
}

const ids = async (pid) => new Map((await h.db.all('SELECT code, id, description, category FROM procedure_codes WHERE practice_id = ?', pid)).map((c) => [c.code, c]));

// Known numbers: a practice with procedures, payments, adjustments, a void, a refund, claims, plans and visits.
async function seeded() {
  const { api, token, provider } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const d2 = (await api.post('/providers', { name: 'Dr. Two', type: 'dentist' })).data;
  const hyg = (await api.post('/providers', { name: 'Hyg. Anne', type: 'hygienist' })).data;
  const mk = async (first) => (await api.post('/patients', { first_name: first, last_name: 'Test', dob: '1980-03-15', phone: '(512) 555-0111' })).data;
  const jane = await mk('Jane');
  const bob = await mk('Bob');
  const cara = await mk('Cara');
  const dan = await mk('Dan');
  const codes = await ids(pid);
  const run = (sql, ...args) => h.db.run(sql, ...args);

  // Insurance: Delta for Jane and Bob, Cigna for Cara (and Bob as secondary).
  const delta = (await run("INSERT INTO insurance_carriers (practice_id, name) VALUES (?, 'Delta Dental')", pid)).id;
  const cigna = (await run("INSERT INTO insurance_carriers (practice_id, name) VALUES (?, 'Cigna')", pid)).id;
  const policy = async (patient, carrier, priority = 'primary') => (await run(
    "INSERT INTO patient_insurance (practice_id, patient_id, carrier_id, priority, subscriber_name, subscriber_id) VALUES (?, ?, ?, ?, 'Sub', 'M1')", pid, patient.id, carrier, priority,
  )).id;
  const pJane = await policy(jane, delta);
  const pCara = await policy(cara, cigna);
  const pBob = await policy(bob, delta);
  const pBob2 = await policy(bob, cigna, 'secondary');
  const today = new Date().toISOString().slice(0, 10);
  const ago = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const claim = async (patient, pol, status, fee, est, paid, submitted, extra = '') => (await run(
    `INSERT INTO claims (practice_id, patient_id, patient_insurance_id, status, total_fee, estimated_amount, paid_amount, submitted_at, denial_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pid, patient.id, pol, status, fee, est, paid, submitted, extra || null,
  )).id;
  const c1 = await claim(jane, pJane, 'partially_paid', 15000, 9000, 3000, ago(45)); // expects 6000 more, 31–60 days
  await claim(cara, pCara, 'submitted', 8000, 0, 0, ago(100)); // no estimate: the billed 8000, 90+
  await claim(bob, pBob, 'draft', 20000, 12000, 0, null);
  await claim(bob, pBob2, 'denied', 7000, 3000, 0, ago(20), 'Missing x-ray');

  // Ledger, March 2025.
  const proc = async (patient, prov, code, fee, extra = {}) => (await run(
    `INSERT INTO procedures (practice_id, patient_id, provider_id, code_id, code, description, category, fee, status, completed_at, treatment_plan_id, appointment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pid, patient.id, prov, codes.get(code).id, code, codes.get(code).description, codes.get(code).category, fee, extra.status || 'completed', extra.status === 'planned' ? null : '2025-03-01 12:00:00', extra.plan ?? null, extra.appt ?? null,
  )).id;
  const entry = async (patient, type, amount, date, f = {}) => (await run(
    `INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date, provider_id, procedure_id, method, claim_id, adjustment_type, voided_at, reverses_id, location_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pid, patient.id, type, amount, f.description || type, date, f.provider ?? null, f.procedure ?? null, f.method ?? null, f.claim ?? null, f.adjustment_type ?? null, f.voided_at ?? null, f.reverses ?? null, f.location ?? null,
  )).id;
  const charge = async (patient, prov, code, amount, date) => entry(patient, 'charge', amount, date, { provider: prov, procedure: await proc(patient, prov, code, amount) });
  await charge(jane, provider.id, 'D2392', 10000, '2025-03-03');
  await charge(jane, d2.id, 'D1110', 5000, '2025-03-04');
  await entry(jane, 'payment', -6000, '2025-03-05', { method: 'cash' });
  await entry(jane, 'insurance_payment', -3000, '2025-03-10', { method: 'check', claim: c1 });
  await entry(jane, 'adjustment', -1000, '2025-03-10', { claim: c1, adjustment_type: 'Insurance write-off' });
  await charge(bob, provider.id, 'D2740', 20000, '2025-03-06');
  await entry(bob, 'payment', -20000, '2025-03-06', { method: 'card' });
  // A crown charged to the wrong patient, voided: the charge and its reversal cancel out.
  const wrongProc = await proc(bob, d2.id, 'D2950', 7000);
  const wrong = await entry(bob, 'charge', 7000, '2025-03-07', { provider: d2.id, procedure: wrongProc, voided_at: '2025-03-08 10:00:00' });
  await entry(bob, 'charge', -7000, '2025-03-08', { provider: d2.id, procedure: wrongProc, reverses: wrong });
  await entry(bob, 'payment', -500, '2025-03-09', { method: 'card' });
  await entry(bob, 'refund', 500, '2025-03-12', { method: 'card', description: 'Overpayment returned' });
  await charge(cara, hyg.id, 'D1110', 8000, '2025-03-11');
  await entry(cara, 'adjustment', -800, '2025-03-11', { adjustment_type: 'Courtesy discount' });
  await charge(cara, provider.id, 'D2392', 3000, '2025-05-10');
  await entry(dan, 'payment', -2500, '2025-03-20', { method: 'cash' });

  // Treatment plans: Jane's proposed crown (unscheduled) and a booked buildup; Bob's accepted plan; Cara's rejected one.
  const plan = async (patient, status) => (await run("INSERT INTO treatment_plans (practice_id, patient_id, name, status) VALUES (?, ?, 'Plan', ?)", pid, patient.id, status)).id;
  const appt = async (patient, prov, start, status, extra = {}) => (await run(
    'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, asap, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    pid, patient.id, prov, start, `${start.slice(0, 11)}${String(Number(start.slice(11, 13)) + 1).padStart(2, '0')}${start.slice(13)}`, status, extra.asap ? 1 : 0, extra.location ?? null,
  )).id;
  const future = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
  const tpJ = await plan(jane, 'proposed');
  await proc(jane, provider.id, 'D2740', 120000, { status: 'planned', plan: tpJ });
  await proc(jane, provider.id, 'D2950', 30000, { status: 'planned', plan: tpJ, appt: await appt(jane, provider.id, `${future} 09:00`, 'scheduled') });
  await proc(bob, d2.id, 'D2740', 25000, { status: 'planned', plan: await plan(bob, 'accepted') });
  await proc(cara, provider.id, 'D2740', 50000, { status: 'planned', plan: await plan(cara, 'rejected') });

  // Visits in March 2025: Dr. Lee 2 kept, 1 cancelled, 1 no-show; Dr. Two 1 kept, 1 no-show.
  for (const [prov, day, status] of [[provider.id, 3, 'completed'], [provider.id, 4, 'completed'], [provider.id, 5, 'cancelled'], [provider.id, 6, 'no_show'], [d2.id, 3, 'completed'], [d2.id, 7, 'no_show']]) {
    await appt(bob, prov, `2025-03-${String(day).padStart(2, '0')} 10:00`, status);
  }
  // Recent visits: Cara was seen a month ago with nothing booked; Bob was seen and is booked again (ASAP).
  const lastMonth = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  await appt(cara, hyg.id, `${lastMonth} 08:00`, 'completed');
  await appt(bob, hyg.id, `${lastMonth} 08:00`, 'completed');
  await appt(bob, provider.id, `${future} 13:00`, 'scheduled', { asap: true });
  return { api, token, pid, provider, d2, hyg, jane, bob, cara, dan, today };
}

const row = (rows, key, value) => rows.find((r) => r[key] === value);
const march = 'from=2025-03-01&to=2025-03-31';

test('report library: production, collections, adjustments and aging numbers', async () => {
  const s = await seeded();
  const get = await lib(s.token);

  const prod = (await get(`/report-library/production-by-provider?${march}`)).data;
  assert.deepEqual(prod.rows.map((r) => [r.provider, r.procedures, r.production]), [['Dr. Ann Lee, DDS', 2, 30000], ['Hyg. Anne', 1, 8000], ['Dr. Two', 1, 5000]]);
  assert.equal(prod.totals.production, 43000);
  assert.equal(prod.totals.procedures, 4);
  assert.equal(row(prod.rows, 'provider', 'Dr. Two').share, 11.6);
  // Provider filter.
  assert.deepEqual((await get(`/report-library/production-by-provider?${march}&provider_id=${s.d2.id}`)).data.rows.map((r) => r.production), [5000]);

  const byCode = (await get(`/report-library/production-by-code?${march}`)).data;
  assert.deepEqual(byCode.rows.map((r) => [r.code, r.count, r.production]), [['D2740', 1, 20000], ['D1110', 2, 13000], ['D2392', 1, 10000]], 'the voided crown nets out');

  const coll = (await get(`/report-library/collections-by-provider?${march}`)).data;
  const lee = row(coll.rows, 'provider', 'Dr. Ann Lee, DDS');
  assert.deepEqual([lee.production, lee.patient, lee.insurance, lee.collections, lee.collection_pct], [30000, 26000, 3000, 29000, 96.7]);
  assert.equal(row(coll.rows, 'provider', 'Unapplied credit').patient, 2500, "Dan's payment with nothing to pay for");
  assert.equal(coll.totals.collections, 31500);

  const types = (await get(`/report-library/collections-by-payment-type?${march}`)).data;
  assert.deepEqual(types.rows.map((r) => [r.payment_type, r.count, r.amount]), [['Patient payment · Card', 2, 20500], ['Patient payment · Cash', 2, 8500], ['Insurance payment · Check', 1, 3000], ['Refund · Card', 1, -500]]);
  assert.equal(types.totals.amount, 31500);

  const gross = (await get(`/report-library/gross-vs-net-production?${march}`)).data;
  assert.deepEqual([row(gross.rows, 'provider', 'Dr. Ann Lee, DDS').adjustments, row(gross.rows, 'provider', 'Hyg. Anne').net], [-1000, 7200]);
  assert.equal(gross.totals.net, 41200);

  const adj = (await get(`/report-library/adjustments-by-type?${march}`)).data;
  assert.deepEqual(adj.rows.map((r) => [r.type, r.count, r.amount]), [['Insurance write-off', 1, -1000], ['Courtesy discount', 1, -800]]);

  const pct = (await get(`/report-library/collection-percentage?${march}`)).data;
  assert.deepEqual(pct.rows.map((r) => [r.month, r.production, r.adjustments, r.net, r.collections, r.collection_pct]), [['2025-03', 43000, -1800, 41200, 32000, 77.7]]);

  const refunds = (await get(`/report-library/refunds?${march}`)).data;
  assert.deepEqual(refunds.rows.map((r) => [r.patient, r.amount]), [['Bob Test', 500]]);

  // Aging (by family) as of May 20th: March debits are 61–90 days old, Cara's May filling is current.
  const aging = (await get('/report-library/aging-by-family?as_of=2025-05-20')).data;
  assert.deepEqual(aging.rows.map((r) => [r.patient, r.current, r.d31_60, r.d61_90, r.d90_plus, r.balance]), [['Cara Test', 3000, 0, 7200, 0, 10200], ['Jane Test', 0, 0, 5000, 0, 5000]]);
  assert.deepEqual([aging.totals.current, aging.totals.d61_90, aging.totals.balance], [3000, 12200, 15200]);
  assert.equal((await get('/report-library/aging-by-family?as_of=2999-01-01')).status, 400, 'not in the future');

  const credits = (await get('/report-library/credit-balances')).data;
  assert.deepEqual(credits.rows.map((r) => [r.patient, r.credit]), [['Dan Test', 2500]]);

  const carriers = (await get('/report-library/aging-by-carrier')).data;
  assert.deepEqual(carriers.rows.map((r) => [r.carrier, r.claims, r.d31_60, r.d90_plus, r.total]), [['Cigna', 1, 0, 8000, 8000], ['Delta Dental', 1, 6000, 0, 6000]]);
  assert.deepEqual((await get('/report-library/claims-not-sent')).data.rows.map((r) => [r.patient, r.total_fee]), [['Bob Test', 20000]]);
  assert.deepEqual((await get('/report-library/denied-claims')).data.rows.map((r) => r.denial_reason), ['Missing x-ray']);
  assert.deepEqual((await get('/report-library/outstanding-claims')).data.rows.map((r) => r.bucket), ['90+', '31–60']);
});

test('report library: unscheduled treatment, no-show rate, recall and schedule lists', async () => {
  const s = await seeded();
  const get = await lib(s.token);

  const unscheduled = (await get('/report-library/unscheduled-treatment')).data;
  assert.deepEqual(unscheduled.rows.map((r) => [r.patient, r.procedures, r.amount, r.accepted]), [['Jane Test', 1, 120000, 'No'], ['Bob Test', 1, 25000, 'Yes']]);
  assert.equal(unscheduled.totals.amount, 145000);
  assert.deepEqual((await get(`/report-library/unscheduled-treatment?provider_id=${s.provider.id}`)).data.totals.amount, 120000);

  const noshow = (await get(`/report-library/no-show-cancel-rate?${march}`)).data;
  const lee = row(noshow.rows, 'provider', 'Dr. Ann Lee, DDS');
  assert.deepEqual([lee.booked, lee.completed, lee.cancelled, lee.no_shows, lee.no_show_rate, lee.cancel_rate, lee.broken_rate], [4, 2, 1, 1, 25, 25, 50]);
  assert.deepEqual([noshow.totals.booked, noshow.totals.no_shows, noshow.totals.no_show_rate, noshow.totals.cancel_rate, noshow.totals.broken_rate], [6, 2, 33.3, 16.7, 50]);

  const broken = (await get(`/report-library/broken-appointments?${march}`)).data;
  assert.equal(broken.rows.length, 3);

  const recall = (await get('/report-library/patients-without-next-visit')).data;
  assert.ok(recall.rows.some((r) => r.patient === 'Cara Test'), 'seen, nothing booked');
  assert.ok(!recall.rows.some((r) => r.patient === 'Bob Test'), 'booked again');

  const asap = (await get('/report-library/asap-list')).data;
  assert.deepEqual(asap.rows.map((r) => [r.source, r.patient]), [['ASAP', 'Bob Test']]);

  const hygiene = (await get(`/report-library/hygiene-production?${march}`)).data;
  assert.equal(row(hygiene.rows, 'provider', 'Hyg. Anne').production, 8000);

  const birthdays = (await get('/report-library/birthdays?from=2025-03-01&to=2025-03-31')).data;
  assert.deepEqual(birthdays.rows.map((r) => [r.birthday, r.turning]).slice(0, 1), [['2025-03-15', 45]]);
  assert.equal(birthdays.rows.length, 4);

  const plans = (await get('/report-library/patients-by-insurance-plan')).data;
  assert.equal(plans.totals.patients, 3, 'Bob counted once with two plans');

  // A PPO paying $80 for the $100 filling (done once in March), and nothing listed for the crown.
  const ppo = (await h.db.run("INSERT INTO fee_schedules (practice_id, name, kind) VALUES (?, 'Delta PPO', 'ppo')", s.pid)).id;
  const office = (await h.db.get("SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = 'D2392'", s.pid)).fee;
  await h.db.run("INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, 'D2392', ?)", ppo, office - 2000);
  const fees = (await get(`/report-library/fee-schedule-comparison?${march}`)).data;
  assert.deepEqual(fees.rows.map((r) => [r.code, r.difference, r.done, r.lost]), [['D2392', 2000, 1, 2000]]);
  assert.equal(fees.params.fee_schedule_id, ppo);

  const eom = (await get('/report-library/month-end?month=2025-03')).data;
  const item = (name) => eom.rows.find((r) => r.item === name);
  assert.deepEqual([item('Gross production').amount, item('Net production').amount, item('Total collections').amount, item('Total collections').rate], [43000, 41200, 32000, 77.7]);
  assert.equal(eom.totals, null);

  const eod = (await get('/report-library/end-of-day?date=2025-03-06')).data;
  assert.deepEqual(eod.rows.filter((r) => r.section === 'Deposit').map((r) => [r.item, r.amount]), [['Card', 20000], ['Total to deposit', 20000]]);
});

test('report library: every report runs with its default filters', async () => {
  const s = await seeded();
  const get = await lib(s.token);
  const list = (await get('/report-library')).data;
  assert.equal(list.reports.length, LIBRARY.length, 'an administrator sees them all');
  assert.ok(LIBRARY.length >= 40);
  for (const r of list.reports) {
    const res = await get(`/report-library/${r.id}`);
    assert.equal(res.status, 200, `${r.id}: ${JSON.stringify(res.data)}`);
    assert.ok(Array.isArray(res.data.rows), r.id);
    for (const c of r.columns) assert.ok(c.key && c.label && c.type, `${r.id} column`);
    // And with a provider and the widest filters it takes.
    const q = new URLSearchParams({ ...(r.params.includes('provider') ? { provider_id: s.provider.id } : {}), ...(r.params.includes('range') ? { from: '2024-01-01', to: '2026-12-31' } : {}) });
    assert.equal((await get(`/report-library/${r.id}?${q}`)).status, 200, r.id);
  }
  // Bad filters are refused, not ignored.
  assert.equal((await get('/report-library/production-by-provider?from=2025-02-30')).status, 400);
  assert.equal((await get('/report-library/production-by-provider?from=2025-03-10&to=2025-03-01')).status, 400);
  assert.equal((await get('/report-library/production-by-provider?provider_id=abc')).status, 400);
  assert.equal((await get('/report-library/month-end?month=2025-13')).status, 400);
  assert.equal((await get('/report-library/nope')).status, 404);

  // CSV download: dollars, a totals line, and the export is audited.
  const csv = await get(`/report-library/production-by-provider?${march}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Production \(\$\)/);
  assert.match(csv.data, /"Dr\. Ann Lee, DDS",2,300\.00,69\.8/);
  assert.match(csv.data, /Total,4,430\.00/);
  const logged = await h.db.get("SELECT details FROM audit_log WHERE practice_id = ? AND action = 'report.export' ORDER BY id DESC", s.pid);
  assert.equal(JSON.parse(logged.details).report, 'production-by-provider');
});

test('report library: permissions, admin-only audit summary, practice isolation', async () => {
  const s = await seeded();
  const other = await h.practice({ timezone: 'UTC' });
  const otherPid = (await other.api.get('/practice')).data.id;
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, provider_id, type, amount, description, entry_date) VALUES (?, ?, ?, 'charge', 99999, 'Other', '2025-03-05')", otherPid, other.patient.id, other.provider.id);
  const theirs = await lib(other.token);
  assert.deepEqual((await theirs(`/report-library/production-by-provider?${march}`)).data.rows.map((r) => r.production), [99999]);
  const mine = await lib(s.token);
  assert.equal((await mine(`/report-library/production-by-provider?${march}`)).data.totals.production, 43000, 'the other practice is not counted');
  assert.equal((await mine(`/report-library/production-by-provider?${march}&provider_id=${other.provider.id}`)).status, 404, "another practice's provider");

  const login = async (role, extra = {}) => {
    const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    assert.ok((await s.api.post('/users', { email, name: role, role, password: 'correct-horse-battery', ...extra })).status < 300);
    return (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
  };
  const desk = await lib(await login('front_desk'));
  assert.equal((await desk('/report-library')).status, 403, 'front desk has no reports:read');
  assert.equal((await desk(`/report-library/production-by-provider?${march}`)).status, 403);
  const dentist = await lib(await login('dentist'));
  const list = (await dentist('/report-library')).data;
  assert.ok(!list.reports.some((r) => r.id === 'audit-summary'), 'admin-only report hidden');
  assert.equal((await dentist(`/report-library/production-by-provider?${march}`)).data.totals.production, 43000);
  assert.equal((await dentist('/report-library/audit-summary')).status, 403);
  const audit = (await mine('/report-library/audit-summary')).data;
  assert.ok(audit.rows.length > 0 && audit.rows.every((r) => r.who && r.action));
});

test('report library: someone limited to one office sees only that office', async () => {
  const { api, token, provider, patient } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  const west = (await api.post('/locations', { name: 'Westside' })).data;
  const wes = (await api.post('/patients', { first_name: 'Wes', last_name: 'West', dob: '1990-01-01', location_id: west.id })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', main.id, patient.id);
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', west.id, wes.id);
  for (const [p, loc, amt] of [[patient.id, main.id, 10000], [wes.id, west.id, 20000]]) {
    await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, provider_id, type, amount, description, entry_date, location_id) VALUES (?, ?, ?, 'charge', ?, 'Work', '2025-03-05', ?)", pid, p, provider.id, amt, loc);
  }
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date, location_id, method) VALUES (?, ?, 'payment', -30000, 'Paid ahead', '2025-03-06', ?, 'cash')", pid, wes.id, west.id);

  const admin = await lib(token);
  assert.equal((await admin(`/report-library/production-by-provider?${march}`)).data.totals.production, 30000);
  assert.equal((await admin(`/report-library/production-by-provider?${march}&location_id=${west.id}`)).data.totals.production, 20000);

  const email = `main-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Main Desk', role: 'billing', password: 'correct-horse-battery', location_ids: [main.id] });
  const desk = await lib((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await desk(`/report-library/production-by-provider?${march}`)).data.totals.production, 10000);
  assert.equal((await desk(`/report-library/production-by-provider?${march}&location_id=${west.id}`)).status, 403);
  assert.equal((await desk(`/report-library/production-by-provider?${march}&location_id=${main.id}`)).data.totals.production, 10000);
  // Patient lists hold to the office too: Wes's credit is at the other office.
  assert.equal((await admin('/report-library/credit-balances')).data.rows.length, 1);
  assert.equal((await desk('/report-library/credit-balances')).data.rows.length, 0);
  assert.equal((await desk('/report-library/audit-summary')).status, 403);
  assert.ok(!(await desk('/report-library')).data.reports.some((r) => r.id === 'audit-summary'));
});

test('report library: saved and scheduled through saved reports, without patient names in emails', async () => {
  const s = await seeded();
  assert.ok(REPORTS['lib.production-by-provider'], 'library reports are registered with saved reports');
  assert.ok(!REPORTS['lib.audit-summary'], 'admin-only reports are not');
  const body = (await REPORTS['lib.production-by-provider'].render(h.db, s.pid, { period: 'mtd' }, '2025-03-31')).join('\n');
  assert.match(body, /2025-03-01 to 2025-03-31/);
  assert.match(body, /Dr\. Ann Lee, DDS.*Production: \$300\.00/);
  assert.match(body, /Totals: .*Production \$430\.00/);
  const journal = (await REPORTS['lib.daily-payments'].render(h.db, s.pid, { period: 'mtd' }, '2025-03-31')).join('\n');
  assert.doesNotMatch(journal, /Jane|Bob|Dan/);
  assert.match(journal, /6 rows/);
  assert.deepEqual(savedQuery(getReport('month-end'), { period: 'last_month' }, '2025-04-10'), { month: '2025-03' });

  const saved = await s.api.post('/saved-reports', { name: 'Provider numbers', report: 'lib.production-by-provider', params: { period: 'last_month', provider_id: s.provider.id } });
  assert.equal(saved.status, 201);
  const preview = (await s.api.get(`/saved-reports/${saved.data.id}/preview`)).data;
  assert.match(preview.body, /^Production by provider · Last month/);
});
