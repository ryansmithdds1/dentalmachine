// K3: one definition per KPI (docs/metrics.md). Each test pins what a metric counts and what it leaves out.
// Routes are expected at /api (routes/metrics.js mounted in app.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { computeMetrics, compareMetrics, goalsFor, metricRows, recordSnapshots, previousRange, lastYear, standing } from '../src/metrics.js';

const h = harness();
const MARCH = { from: '2026-03-01', to: '2026-03-31', today: '2026-09-24' };

const pidOf = async (api) => (await api.get('/auth/me')).data.user?.practice_id ?? (await api.get('/auth/me')).data.practice.id;
async function ctx(extra = {}) {
  const c = await h.practice({ timezone: 'UTC', ...extra });
  c.pid = c.practiceId || await pidOf(c.api);
  return c;
}
const ledger = (c, row) => h.db.run(
  `INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date, provider_id, location_id, adjustment_type, voided_at, reverses_id, method)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  c.pid, row.patient_id ?? c.patient.id, row.type, row.amount, row.description || row.type, row.date, row.provider_id ?? c.provider.id, row.location_id ?? null,
  row.adjustment_type ?? null, row.voided_at ?? null, row.reverses_id ?? null, row.method ?? null,
);
const patient = async (c, first, last, extra = {}) => (await h.db.run('INSERT INTO patients (practice_id, first_name, last_name, status, referral_source, merged_into_id, location_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  c.pid, first, last, extra.status || 'active', extra.referral_source ?? null, extra.merged_into_id ?? null, extra.location_id ?? null)).id;
const appt = async (c, { patient_id, provider_id, start, end, status = 'completed', created_at = null, location_id = null }) => (await h.db.run(
  `INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, location_id${created_at ? ', created_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?${created_at ? ', ?' : ''})`,
  c.pid, patient_id ?? c.patient.id, provider_id ?? c.provider.id, start, end, status, location_id, ...(created_at ? [created_at] : []),
)).id;
const codeId = async (c) => (await h.db.get('SELECT id FROM procedure_codes WHERE practice_id = ? LIMIT 1', c.pid)).id;
const proc = async (c, { patient_id, fee, status = 'planned', appointment_id = null, treatment_plan_id = null, provider_id = null }) => (await h.db.run(
  `INSERT INTO procedures (practice_id, patient_id, provider_id, code_id, code, description, category, fee, status, appointment_id, treatment_plan_id)
   VALUES (?, ?, ?, ?, 'D2392', 'Resin', 'restorative', ?, ?, ?, ?)`, c.pid, patient_id ?? c.patient.id, provider_id ?? c.provider.id, await codeId(c), fee, status, appointment_id, treatment_plan_id,
)).id;

test('production, adjustments, collections and collection rate come from the live ledger (voids and their reversals left out)', async () => {
  const c = await ctx();
  const other = (await c.api.post('/providers', { name: 'Dr. Two', type: 'dentist' })).data;
  await ledger(c, { type: 'charge', amount: 10000, date: '2026-03-02' });
  await ledger(c, { type: 'charge', amount: 5000, date: '2026-03-03', provider_id: other.id });
  const voided = (await ledger(c, { type: 'charge', amount: 2000, date: '2026-03-04', voided_at: '2026-03-20 10:00:00' })).id;
  await ledger(c, { type: 'charge', amount: -2000, date: '2026-03-20', reverses_id: voided });
  await ledger(c, { type: 'charge', amount: 99999, date: '2026-02-28' }); // outside the range
  await ledger(c, { type: 'payment', amount: -6000, date: '2026-03-05', method: 'cash' });
  await ledger(c, { type: 'insurance_payment', amount: -3000, date: '2026-03-06' });
  await ledger(c, { type: 'refund', amount: 500, date: '2026-03-07' });
  const vp = (await ledger(c, { type: 'payment', amount: -1000, date: '2026-03-08', voided_at: '2026-03-09 10:00:00' })).id;
  await ledger(c, { type: 'payment', amount: 1000, date: '2026-03-09', reverses_id: vp });
  await ledger(c, { type: 'adjustment', amount: -700, date: '2026-03-10', adjustment_type: 'Insurance write-off' });
  await ledger(c, { type: 'adjustment', amount: -300, date: '2026-03-10', adjustment_type: 'Courtesy discount' });
  await ledger(c, { type: 'adjustment', amount: -200, date: '2026-03-10', adjustment_type: 'Bad debt write-off' });
  await ledger(c, { type: 'adjustment', amount: 400, date: '2026-03-10', adjustment_type: 'Finance charge' }); // a debit: not a write-off

  const { values, parts } = await computeMetrics(h.db, c.pid, { ...MARCH, keys: ['production_gross', 'adjustments', 'production_net', 'collections', 'collection_rate'] });
  assert.equal(values.production_gross, 15000, 'charges only, the voided one and its reversal left out');
  assert.equal(values.adjustments, 1200);
  assert.deepEqual(parts.adjustments, { insurance_write_offs: 700, discounts: 300, other_write_offs: 200 });
  assert.equal(values.production_net, 13800);
  assert.equal(values.collections, 8500, 'payments + insurance payments − refunds; the voided payment left out');
  assert.equal(values.collection_rate, 61.6);

  // One provider: their production; collections are their share of payments (oldest charges first).
  const mine = (await computeMetrics(h.db, c.pid, { ...MARCH, providerId: other.id, keys: ['production_gross', 'collections'] })).values;
  assert.equal(mine.production_gross, 5000);
  assert.ok(mine.collections <= 5000);

  // Drill-down: the rows add up to the number.
  const rows = await metricRows(h.db, c.pid, 'production_gross', MARCH);
  assert.equal(rows.count, 2);
  assert.equal(rows.rows.reduce((s, r) => s + r.amount, 0), 15000);
});

test('new patients are counted on their first completed visit, not when the chart was made', async () => {
  const c = await ctx();
  const a = await patient(c, 'Ann', 'New', { referral_source: 'Google' });
  const b = await patient(c, 'Bea', 'Returning');
  const d = await patient(c, 'Dee', 'Walkin');
  await patient(c, 'Cal', 'Imported'); // a chart with no visit (an import, a phone enquiry)
  const m = await patient(c, 'Ann', 'Duplicate');
  await appt(c, { patient_id: a, start: '2026-03-10 09:00', end: '2026-03-10 10:00' });
  await appt(c, { patient_id: b, start: '2026-02-10 09:00', end: '2026-02-10 10:00' });
  await appt(c, { patient_id: b, start: '2026-03-15 09:00', end: '2026-03-15 10:00' });
  await ledger(c, { patient_id: d, type: 'charge', amount: 5000, date: '2026-03-12' });
  await h.db.run('UPDATE ledger_entries SET procedure_id = ? WHERE patient_id = ?', await proc(c, { patient_id: d, fee: 5000, status: 'completed' }), d);
  await appt(c, { patient_id: m, start: '2026-03-11 09:00', end: '2026-03-11 10:00' });
  await h.db.run('UPDATE patients SET merged_into_id = ?, status = ? WHERE id = ?', a, 'archived', m);
  // A cancelled visit isn't a visit.
  await appt(c, { patient_id: await patient(c, 'Nan', 'Noshow'), start: '2026-03-16 09:00', end: '2026-03-16 10:00', status: 'cancelled' });

  const { values, parts } = await computeMetrics(h.db, c.pid, { ...MARCH, keys: ['new_patients'] });
  assert.equal(values.new_patients, 2);
  assert.deepEqual(parts.new_patients.by_source.find((x) => x.source === 'Google'), { source: 'Google', n: 1 });
  const rows = await metricRows(h.db, c.pid, 'new_patients', MARCH);
  assert.deepEqual(rows.rows.map((r) => r.first_name).sort(), ['Ann', 'Dee']);
  // Not tracked per provider (a new patient belongs to the practice).
  assert.equal((await computeMetrics(h.db, c.pid, { ...MARCH, providerId: c.provider.id, keys: ['new_patients'] })).values.new_patients, null);
});

test('hygiene reappointment, broken appointments and the no-show & cancel rate', async () => {
  const c = await ctx();
  const hyg = (await c.api.post('/providers', { name: 'Hyg. Bea', type: 'hygienist' })).data;
  const a = await patient(c, 'Al', 'Rebooked');
  const b = await patient(c, 'Bo', 'Notbooked');
  const late = await patient(c, 'Cy', 'Booklater');
  await appt(c, { patient_id: a, provider_id: hyg.id, start: '2026-03-10 09:00', end: '2026-03-10 10:00' });
  await appt(c, { patient_id: a, provider_id: hyg.id, start: '2026-09-10 09:00', end: '2026-09-10 10:00', status: 'scheduled', created_at: '2026-03-10 15:00:00' });
  await appt(c, { patient_id: b, provider_id: hyg.id, start: '2026-03-11 09:00', end: '2026-03-11 10:00' });
  await appt(c, { patient_id: late, provider_id: hyg.id, start: '2026-03-12 09:00', end: '2026-03-12 10:00' });
  // Booked weeks after the visit: doesn't count as leaving with the next visit booked.
  await appt(c, { patient_id: late, provider_id: hyg.id, start: '2026-10-12 09:00', end: '2026-10-12 10:00', status: 'scheduled', created_at: '2026-04-01 10:00:00' });
  await appt(c, { patient_id: b, start: '2026-03-13 09:00', end: '2026-03-13 10:00', status: 'no_show' });
  await appt(c, { patient_id: a, start: '2026-03-14 09:00', end: '2026-03-14 10:00', status: 'cancelled' });

  const { values, parts } = await computeMetrics(h.db, c.pid, { ...MARCH, keys: ['hygiene_reappointment', 'broken_appointments', 'broken_rate'] });
  assert.deepEqual(parts.hygiene_reappointment, { visits: 3, reappointed: 1 });
  assert.equal(values.hygiene_reappointment, 33.3);
  assert.equal(values.broken_appointments, 2);
  assert.deepEqual(parts.broken_appointments, { no_shows: 1, cancelled: 1 });
  assert.equal(values.broken_rate, 40, '2 broken of 5 kept + broken');
  const rows = await metricRows(h.db, c.pid, 'hygiene_reappointment', MARCH);
  assert.deepEqual(rows.rows.filter((r) => !r.reappointed).map((r) => r.first_name).sort(), ['Bo', 'Cy']);
  // One hygienist's numbers.
  assert.equal((await computeMetrics(h.db, c.pid, { ...MARCH, providerId: c.provider.id, keys: ['hygiene_reappointment'] })).values.hygiene_reappointment, null, 'no hygiene visits for the dentist');
});

test('case acceptance is accepted plan dollars over presented (plans made in the range, cancelled procedures left out)', async () => {
  const c = await ctx();
  const plan = async (status, created) => (await h.db.run('INSERT INTO treatment_plans (practice_id, patient_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)', c.pid, c.patient.id, `Plan ${status}`, status, created)).id;
  const yes = await plan('accepted', '2026-03-05 10:00:00');
  const maybe = await plan('proposed', '2026-03-06 10:00:00');
  const old = await plan('accepted', '2026-02-05 10:00:00');
  await proc(c, { fee: 1000, treatment_plan_id: yes });
  await proc(c, { fee: 2000, treatment_plan_id: yes, status: 'completed' });
  await proc(c, { fee: 3000, treatment_plan_id: maybe });
  await proc(c, { fee: 500, treatment_plan_id: maybe, status: 'cancelled' });
  await proc(c, { fee: 9000, treatment_plan_id: old });
  const { values, parts } = await computeMetrics(h.db, c.pid, { ...MARCH, keys: ['case_acceptance'] });
  assert.deepEqual(parts.case_acceptance, { presented: 6000, accepted: 3000, plans: 2, accepted_plans: 1 });
  assert.equal(values.case_acceptance, 50);
});

test('right-now metrics: unscheduled treatment, recall, claims waiting and A/R', async () => {
  const c = await ctx();
  const today = new Date().toISOString().slice(0, 10);
  const back = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const o = { from: today, to: today, today };
  const gone = await patient(c, 'Old', 'Archived', { status: 'archived' });
  await proc(c, { fee: 4000 });
  const cancelled = await appt(c, { start: '2031-01-08 09:00', end: '2031-01-08 10:00', status: 'cancelled' });
  await proc(c, { fee: 1000, appointment_id: cancelled }); // its visit was cancelled: unscheduled again
  const booked = await appt(c, { start: '2031-01-09 09:00', end: '2031-01-09 10:00', status: 'scheduled' });
  await proc(c, { fee: 7000, appointment_id: booked });
  const no = (await h.db.run("INSERT INTO treatment_plans (practice_id, patient_id, name, status) VALUES (?, ?, 'No', 'rejected')", c.pid, c.patient.id)).id;
  await proc(c, { fee: 8000, treatment_plan_id: no });
  await proc(c, { patient_id: gone, fee: 6000 });

  const r1 = await patient(c, 'Rae', 'Overdue');
  const r2 = await patient(c, 'Ray', 'Soon');
  const r3 = await patient(c, 'Rex', 'Booked');
  const r4 = await patient(c, 'Roy', 'Off');
  const recall = (p, due, status) => h.db.run('INSERT INTO recalls (practice_id, patient_id, due_date, status) VALUES (?, ?, ?, ?)', c.pid, p, due, status);
  await recall(r1, back(5), 'due');
  await recall(r2, new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), 'due');
  await recall(r3, back(3), 'scheduled');
  await recall(r4, back(100), 'inactive');

  const carrier = (await h.db.run("INSERT INTO insurance_carriers (practice_id, name) VALUES (?, 'Delta')", c.pid)).id;
  const policy = (await h.db.run("INSERT INTO patient_insurance (practice_id, patient_id, carrier_id, subscriber_name, subscriber_id) VALUES (?, ?, ?, 'Jane Doe', 'W1')", c.pid, c.patient.id, carrier)).id;
  const claim = (status, sent) => h.db.run('INSERT INTO claims (practice_id, patient_id, patient_insurance_id, status, submitted_at, estimated_amount) VALUES (?, ?, ?, ?, ?, 5000)', c.pid, c.patient.id, policy, status, `${sent} 10:00:00`);
  await claim('submitted', back(40));
  await claim('submitted', back(10));
  await claim('paid', back(60));

  const { values, parts } = await computeMetrics(h.db, c.pid, { ...o, keys: ['unscheduled_treatment', 'recall_due', 'recall_overdue', 'recall_current_rate', 'claims_over_30', 'ar_total'] });
  assert.equal(values.unscheduled_treatment, 5000, 'planned, not on a live visit, not on a turned-down plan, active patients only');
  assert.deepEqual(parts.unscheduled_treatment, { procedures: 2, patients: 1 });
  assert.equal(values.recall_overdue, 1);
  assert.equal(values.recall_due, 1);
  assert.equal(values.recall_current_rate, 66.7, 'the due-soon and the booked one are current; inactive recall left out');
  assert.equal(values.claims_over_30, 1);
  assert.equal(parts.claims_over_30.expected, 5000);
  assert.equal(values.ar_total, 0);
  const claims = await metricRows(h.db, c.pid, 'claims_over_30', o);
  assert.equal(claims.rows[0].days, 40);

  // Snapshots: stored once a day, read back for past dates (percentages kept in tenths).
  assert.ok(await recordSnapshots(h.db, c.pid, back(1)) > 0);
  assert.equal(await recordSnapshots(h.db, c.pid, back(1)), 0, 'a second run that day changes nothing');
  const past = (await computeMetrics(h.db, c.pid, { from: back(1), to: back(1), today, keys: ['unscheduled_treatment', 'recall_current_rate'] })).values;
  assert.equal(past.unscheduled_treatment, 5000);
  assert.equal(past.recall_current_rate, 66.7);
});

test('the day’s schedule: visits, scheduled production, unconfirmed, insurance to verify, balances and open gaps', async () => {
  const c = await ctx();
  const day = '2031-01-08'; // a Wednesday: the office's default hours, 8 to 5
  const bob = await patient(c, 'Bob', 'Uninsured');
  const v1 = await appt(c, { start: `${day} 09:00`, end: `${day} 10:00`, status: 'scheduled' });
  await proc(c, { fee: 23500, appointment_id: v1 });
  await appt(c, { patient_id: bob, start: `${day} 13:00`, end: `${day} 14:00`, status: 'confirmed' });
  await appt(c, { patient_id: bob, start: `${day} 14:00`, end: `${day} 15:00`, status: 'cancelled' });
  await h.db.run("INSERT INTO blockouts (practice_id, provider_id, start_time, end_time, reason) VALUES (?, ?, ?, ?, 'Lunch meeting')", c.pid, c.provider.id, `${day} 15:00`, `${day} 16:00`);
  const carrier = (await h.db.run("INSERT INTO insurance_carriers (practice_id, name) VALUES (?, 'Delta')", c.pid)).id;
  await h.db.run("INSERT INTO patient_insurance (practice_id, patient_id, carrier_id, subscriber_name, subscriber_id) VALUES (?, ?, ?, 'Jane Doe', 'W1')", c.pid, c.patient.id, carrier);
  await ledger(c, { type: 'charge', amount: 5000, date: '2026-03-02' });

  const o = { from: day, to: day, today: '2026-09-24' };
  const { values, parts } = await computeMetrics(h.db, c.pid, { ...o, keys: ['visits', 'scheduled_production', 'unconfirmed', 'insurance_to_verify', 'balances_due', 'open_gaps'] });
  assert.equal(values.visits, 2, 'the cancelled visit is left out');
  assert.equal(values.scheduled_production, 23500);
  assert.equal(values.unconfirmed, 1);
  assert.equal(values.insurance_to_verify, 1, 'Jane has insurance never checked; Bob has none');
  assert.equal(values.balances_due, 5000);
  const gaps = (await metricRows(h.db, c.pid, 'open_gaps', o)).rows.map((g) => `${g.start}-${g.end}`);
  assert.deepEqual(gaps, ['08:00-09:00', '10:00-13:00', '14:00-15:00', '16:00-17:00'], 'the cancelled visit is open time; the blocked hour is not');
  assert.equal(values.open_gaps, 4);
  assert.equal(parts.open_gaps.minutes, 360);
  // A day the office is closed has no gaps.
  assert.equal((await computeMetrics(h.db, c.pid, { from: '2031-01-11', to: '2031-01-11', today: o.today, keys: ['open_gaps'] })).values.open_gaps, 0);
});

test('goals: practice, office and provider goals; monthly goals prorated by open days; benchmarks otherwise', async () => {
  const c = await ctx();
  const put = (b) => c.api.put('/metric-goals', b);
  assert.equal((await put({ metric: 'production_gross', value: 2200000 })).status, 201);
  assert.equal((await put({ metric: 'production_gross', value: 2200000 })).status, 200, 'replaces the one there');
  assert.equal((await put({ metric: 'hygiene_reappointment', value: 95 })).status, 201);
  assert.equal((await put({ metric: 'hygiene_reappointment', value: 120 })).status, 400);
  assert.equal((await put({ metric: 'production_gross', value: 10.5 })).status, 400, 'money goals are whole cents');
  assert.equal((await put({ metric: 'visits', value: 3 })).status, 400, 'no goal for that one');
  assert.equal((await put({ metric: 'ar_total', value: 3, scope: 'provider', provider_id: c.provider.id })).status, 400, 'practice-wide only');
  await h.db.run('UPDATE providers SET daily_goal = 100000 WHERE id = ?', c.provider.id);

  const week = { from: '2026-03-02', to: '2026-03-06' }; // five open days of March's 22
  const g = await goalsFor(h.db, c.pid, week);
  assert.deepEqual(g.production_gross, { goal: 500000, source: 'practice goal' });
  assert.deepEqual(g.hygiene_reappointment, { goal: 95, source: 'practice goal' });
  assert.deepEqual(g.collection_rate, { goal: 98, source: 'benchmark' });
  const mine = await goalsFor(h.db, c.pid, { ...week, providerId: c.provider.id });
  assert.deepEqual(mine.production_gross, { goal: 500000, source: 'provider daily goal' });
  assert.equal(mine.production_net, undefined, 'a provider never borrows the practice’s goal');

  // Goals are listed, audited and removable; other practices can't touch them.
  const list = (await c.api.get('/metric-goals')).data;
  const hyg = list.goals.find((x) => x.metric === 'hygiene_reappointment');
  assert.equal(hyg.display_value, 95);
  const trail = await h.db.all("SELECT action FROM audit_log WHERE practice_id = ? AND action LIKE 'metric_goal.%'", c.pid);
  assert.ok(trail.some((a) => a.action === 'metric_goal.change'));
  const other = await ctx();
  assert.equal((await other.api.del(`/metric-goals/${hyg.id}`)).status, 404);
  assert.equal((await other.api.put('/metric-goals', { metric: 'production_gross', value: 1, scope: 'provider', provider_id: c.provider.id })).status, 404);
  assert.equal((await c.api.del(`/metric-goals/${hyg.id}`)).status, 200);
  assert.ok((await h.db.all("SELECT action FROM audit_log WHERE practice_id = ? AND action = 'metric_goal.delete'", c.pid)).length);

  assert.equal(standing('collection_rate', 97, 98), 'watch');
  assert.equal(standing('broken_rate', 15, 10), 'behind');
  assert.equal(standing('production_gross', 600, 500), 'good');
});

test('comparisons: the period before, the same dates last year, and whole months against whole months', async () => {
  assert.deepEqual(previousRange('2026-03-01', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousRange('2026-03-09', '2026-03-15'), { from: '2026-03-02', to: '2026-03-08' });
  assert.equal(lastYear('2028-02-29'), '2027-02-28');
  const c = await ctx();
  await ledger(c, { type: 'charge', amount: 10000, date: '2026-03-10' });
  await ledger(c, { type: 'charge', amount: 8000, date: '2026-02-10' });
  await ledger(c, { type: 'charge', amount: 5000, date: '2025-03-10' });
  const cmp = await compareMetrics(h.db, c.pid, { ...MARCH, keys: ['production_gross'] });
  const m = cmp.metrics[0];
  assert.deepEqual([m.value, m.previous, m.last_year, m.change, m.change_last_year], [10000, 8000, 5000, 25, 100]);
});

test('the Metrics screen: numbers, drill-down, permissions and practice isolation', async () => {
  const c = await ctx();
  await c.api.post(`/patients/${c.patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: c.provider.id, complete: true });
  await c.api.post(`/patients/${c.patient.id}/payments`, { amount: 10000, method: 'cash' });
  const res = await c.api.get('/metrics?period=month');
  assert.equal(res.status, 200);
  const prod = res.data.metrics.find((x) => x.key === 'production_gross');
  assert.equal(prod.value, 23500);
  assert.ok(Array.isArray(res.data.areas));
  // The same number the Analytics screen shows.
  const today = res.data.today;
  const a = (await c.api.get(`/analytics?from=${res.data.from}&to=${today}`)).data;
  assert.equal(a.production, prod.value);
  assert.equal(a.collections, res.data.metrics.find((x) => x.key === 'collections').value);

  const rows = await c.api.get('/metrics/production_gross/rows?period=month');
  assert.equal(rows.data.count, 1);
  assert.equal(rows.data.rows[0].first_name, 'Jane');
  assert.equal((await c.api.get('/metrics/nope/rows')).status, 404);
  assert.equal((await c.api.get('/metrics?from=2026-02-30&to=2026-03-01')).status, 400);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'metrics.drill_down'", c.pid), 'looking behind the numbers is logged');

  // Without report access: 403 (or only their own numbers with reports:own).
  await c.api.post('/users', { email: `hyg-${Date.now()}@example.com`, name: 'Hy Gienist', role: 'hygienist', password: 'hygienist-password-1' });
  const users = (await c.api.get('/users')).data;
  const hygUser = users.find((u) => u.role === 'hygienist');
  const hyg = h.client((await h.client().post('/auth/login', { email: hygUser.email, password: 'hygienist-password-1' })).data.token);
  assert.equal((await hyg.get('/metrics')).status, 403);
  assert.equal((await hyg.put('/metric-goals', { metric: 'production_gross', value: 1 })).status, 403);

  // Another practice sees none of it, and can't point at this practice's provider.
  const other = await ctx();
  const theirs = (await other.api.get('/metrics?period=month')).data;
  assert.equal(theirs.metrics.find((x) => x.key === 'production_gross').value, 0);
  assert.equal((await other.api.get(`/metrics?provider_id=${c.provider.id}`)).status, 404);
});
