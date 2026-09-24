// DX1–DX2: treatment diagnosed at exams and the conversion funnel after it (server/src/diagnosis.js,
// docs/metrics.md "Diagnosis & conversion"). Each test pins one rule of the definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { examType, cleanRules, loadDiagnoses, diagnosisFunnel, diagnosisPatients, median } from '../src/diagnosis.js';
import { computeMetrics, metricRows, diagnosisRunning, examValues, examsForDay } from '../src/metrics.js';
import { runReport } from '../src/reportlibrary.js';
import { buildDigest } from '../src/digests.js';

const h = harness();
const MARCH = { from: '2026-03-01', to: '2026-03-31' };

const pidOf = async (api) => (await api.get('/auth/me')).data.user?.practice_id ?? (await api.get('/auth/me')).data.practice.id;
async function ctx(extra = {}) {
  const c = await h.practice({ timezone: 'UTC', ...extra });
  c.pid = c.practiceId || await pidOf(c.api);
  return c;
}
const provider = async (c, name, type = 'dentist') => (await c.api.post('/providers', { name, type })).data;
const patient = async (c, first, last, extra = {}) => (await h.db.run('INSERT INTO patients (practice_id, first_name, last_name, status, location_id) VALUES (?, ?, ?, ?, ?)',
  c.pid, first, last, 'active', extra.location_id ?? null)).id;
const codeRow = async (c, code) => (await h.db.get('SELECT id, category, fee FROM procedure_codes WHERE practice_id = ? AND code = ?', c.pid, code))
  || { ...(await h.db.get('SELECT id FROM procedure_codes WHERE practice_id = ? LIMIT 1', c.pid)), category: code.startsWith('D0') ? 'diagnostic' : 'restorative', fee: 10000 };
// A procedure with exact times: created_at is UTC (the practice is on UTC here), completed_at practice-local.
async function proc(c, { patient_id, code, fee, status = 'planned', created, completed = null, provider_id, appointment_id = null, plan = null, tooth = null, surfaces = null, location_id = null }) {
  const k = await codeRow(c, code);
  return (await h.db.run(
    `INSERT INTO procedures (practice_id, patient_id, provider_id, code_id, code, description, category, tooth, surfaces, fee, status, created_at, completed_at, appointment_id, treatment_plan_id, location_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.pid, patient_id, provider_id ?? c.provider.id, k.id, code, code, k.category, tooth, surfaces, fee ?? k.fee, status, created, completed, appointment_id, plan, location_id,
  )).id;
}
const exam = (c, o) => proc(c, { ...o, status: 'completed', created: `${o.date} 09:00:00`, completed: `${o.date} 09:30`, fee: 1000 });
const appt = async (c, { patient_id, provider_id, start, status = 'scheduled', created = null, location_id = null }) => (await h.db.run(
  `INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, location_id${created ? ', created_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?${created ? ', ?' : ''})`,
  c.pid, patient_id, provider_id ?? c.provider.id, start, `${start.slice(0, 11)}23:00`, status, location_id, ...(created ? [created] : []),
)).id;
const plan = async (c, patient_id, status = 'proposed', extra = {}) => (await h.db.run(
  'INSERT INTO treatment_plans (practice_id, patient_id, name, status, signed_at, option_group) VALUES (?, ?, ?, ?, ?, ?)', c.pid, patient_id, extra.name || 'Plan', status, extra.signed_at ?? null, extra.option_group ?? null,
)).id;

test('exam types come from the CDT code, with D0150 and D0180 configurable', () => {
  assert.equal(examType('D0150'), 'new_patient');
  assert.equal(examType('D0120'), 'recall');
  assert.equal(examType('D0180'), 'perio', 'comprehensive periodontal evaluation is its own type');
  assert.equal(examType('D0180', { D0180: 'recall' }), 'recall');
  for (const code of ['D0140', 'D0160', 'D0170', 'D9110']) assert.equal(examType(code), 'emergency', code);
  assert.equal(examType('D2392'), null, 'not an exam');
  assert.equal(examType('D0180', { D0180: 'new_patient' }), 'new_patient');
  assert.equal(examType('D0150', { D0150: 'first_exam' }, true), 'new_patient');
  assert.equal(examType('D0150', { D0150: 'first_exam' }, false), 'recall', 'a comprehensive exam for an existing patient');
  assert.equal(cleanRules({ D0180: 'nonsense' }), null);
  assert.deepEqual(cleanRules({ d0180: 'first_exam' }), { D0150: 'new_patient', D0180: 'first_exam' });
  assert.deepEqual(cleanRules({}), { D0150: 'new_patient', D0180: 'perio' });
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2]), 1.5);
  assert.equal(median([]), null);
});

test('diagnosed = treatment charted on the exam day; diagnostic, preventive, cancelled and other days are left out', async () => {
  const c = await ctx();
  const p = await patient(c, 'Nia', 'New');
  await exam(c, { patient_id: p, code: 'D0150', date: '2026-03-10' });
  await exam(c, { patient_id: p, code: 'D0140', date: '2026-03-10' }); // same day: one exam, the new-patient one
  await proc(c, { patient_id: p, code: 'D2392', tooth: '30', surfaces: 'MO', fee: 23500, created: '2026-03-10 15:00:00' });
  await proc(c, { patient_id: p, code: 'D2740', tooth: '3', fee: 135000, created: '2026-03-10 15:01:00' });
  await proc(c, { patient_id: p, code: 'D1110', created: '2026-03-10 15:02:00' }); // preventive
  await proc(c, { patient_id: p, code: 'D0210', created: '2026-03-10 15:03:00' }); // x-rays
  await proc(c, { patient_id: p, code: 'D2391', tooth: '4', fee: 18500, status: 'cancelled', created: '2026-03-10 15:04:00' });
  await proc(c, { patient_id: p, code: 'D3330', tooth: '19', fee: 125000, created: '2026-03-12 10:00:00' }); // not an exam day
  const q = await patient(c, 'Quinn', 'Nothing');
  await proc(c, { patient_id: q, code: 'D0150', status: 'planned', created: '2026-03-10 09:00:00' }); // exam never done (or its charge voided)
  await proc(c, { patient_id: q, code: 'D2392', tooth: '2', fee: 23500, created: '2026-03-10 15:00:00' });

  const f = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(f.totals.exams, 1);
  assert.equal(f.totals.diagnosed, 158500);
  assert.equal(f.totals.procedures, 2);
  const np = f.by_exam_type.find((t) => t.exam_type === 'new_patient');
  assert.equal(np.exams, 1);
  assert.equal(np.diagnosed, 158500);
  assert.equal(f.by_exam_type.find((t) => t.exam_type === 'emergency').exams, 0, 'the same-day limited exam is not a second exam');
  // The KPI and its drill-down agree.
  const { values } = await computeMetrics(h.db, c.pid, { ...MARCH, today: '2026-09-24', keys: ['diagnosed'] });
  assert.equal(values.diagnosed, 158500);
  const rows = await metricRows(h.db, c.pid, 'diagnosed', { ...MARCH, today: '2026-09-24' });
  assert.equal(rows.rows.reduce((s, r) => s + r.amount, 0), 158500);
});

test('re-diagnosis of the same tooth and code is not counted twice; later work is credited to the first exam (cohorts)', async () => {
  const c = await ctx();
  const p = await patient(c, 'Rae', 'Recall');
  await exam(c, { patient_id: p, code: 'D0120', date: '2026-03-10' });
  const first = await proc(c, { patient_id: p, code: 'D2392', tooth: '30', surfaces: 'MO', fee: 23500, created: '2026-03-10 15:00:00' });
  const done = await proc(c, { patient_id: p, code: 'D2392', tooth: '14', surfaces: 'O', fee: 20000, created: '2026-03-10 15:00:00', status: 'completed', completed: '2026-03-20 10:00' });
  assert.ok(first && done);
  await exam(c, { patient_id: p, code: 'D0120', date: '2026-04-15' });
  // Charted again at the next recall (surfaces in another order): the same finding, still open → not new.
  const again = await proc(c, { patient_id: p, code: 'D2392', tooth: '30', surfaces: 'OM', fee: 23500, created: '2026-04-15 15:00:00' });
  // Tooth 14 was filled in March; needing it again in April is new work.
  await proc(c, { patient_id: p, code: 'D2392', tooth: '14', surfaces: 'O', fee: 20000, created: '2026-04-15 15:05:00' });
  // The April copy of tooth 30 is the one that gets done, in May: credited to the March exam.
  const visit = await appt(c, { patient_id: p, start: '2026-05-05 10:00', status: 'completed', created: '2026-04-20 12:00:00' });
  await h.db.run("UPDATE procedures SET status = 'completed', completed_at = '2026-05-05 10:30', appointment_id = ? WHERE id = ?", visit, again);

  const march = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(march.totals.diagnosed, 43500);
  assert.equal(march.totals.completed, 43500, 'tooth 30 (done in May via the April copy) and tooth 14 both credited to March');
  assert.equal(march.totals.scheduled, 43500);
  assert.equal(march.totals.median_days_to_complete, 33, 'tooth 14 in 10 days, tooth 30 in 56 days');
  const april = await diagnosisFunnel(h.db, c.pid, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(april.totals.exams, 1);
  assert.equal(april.totals.diagnosed, 20000, 'only the new work on tooth 14');
  const may = await diagnosisFunnel(h.db, c.pid, { from: '2026-05-01', to: '2026-05-31' });
  assert.equal(may.totals.completed, 0, 'completion is never credited to the month it happened in');
  // A range over both months counts each finding once, by month of diagnosis.
  const both = await diagnosisFunnel(h.db, c.pid, { from: '2026-03-01', to: '2026-04-30' });
  assert.equal(both.totals.diagnosed, 63500);
  assert.deepEqual(both.by_month.map((m) => [m.month, m.total.diagnosed]), [['2026-03', 43500], ['2026-04', 20000]]);
});

test('presented, accepted, scheduled vs completed: plans, signatures, live visits; cancelled and missed visits are not scheduled', async () => {
  const c = await ctx();
  const p = await patient(c, 'Sam', 'Steps');
  await exam(c, { patient_id: p, code: 'D0150', date: '2026-03-03' });
  const proposed = await plan(c, p, 'proposed');
  const signed = await plan(c, p, 'proposed', { signed_at: '2026-03-04 10:00:00' });
  const accepted = await plan(c, p, 'accepted');
  const live = await appt(c, { patient_id: p, start: '2026-03-20 09:00', created: '2026-03-06 12:00:00' });
  const cancelled = await appt(c, { patient_id: p, start: '2026-03-21 09:00', status: 'cancelled', created: '2026-03-06 12:00:00' });
  const missed = await appt(c, { patient_id: p, start: '2026-03-22 09:00', status: 'no_show', created: '2026-03-06 12:00:00' });
  const t = '2026-03-03 16:00:00';
  await proc(c, { patient_id: p, code: 'D2391', tooth: '1', fee: 1000, created: t }); // diagnosed only
  await proc(c, { patient_id: p, code: 'D2391', tooth: '2', fee: 2000, created: t, plan: proposed }); // presented
  await proc(c, { patient_id: p, code: 'D2391', tooth: '3', fee: 4000, created: t, plan: signed }); // accepted (signed)
  await proc(c, { patient_id: p, code: 'D2391', tooth: '4', fee: 8000, created: t, plan: accepted }); // accepted
  await proc(c, { patient_id: p, code: 'D2391', tooth: '5', fee: 16000, created: t, appointment_id: live }); // scheduled (implies accepted)
  await proc(c, { patient_id: p, code: 'D2391', tooth: '6', fee: 32000, created: t, appointment_id: cancelled, plan: proposed });
  await proc(c, { patient_id: p, code: 'D2391', tooth: '7', fee: 64000, created: t, appointment_id: missed });
  await proc(c, { patient_id: p, code: 'D2391', tooth: '8', fee: 128000, created: t, status: 'completed', completed: '2026-03-03 11:00' }); // done at the exam visit

  const f = await diagnosisFunnel(h.db, c.pid, MARCH);
  const x = f.totals;
  assert.equal(x.diagnosed, 255000);
  assert.equal(x.presented, 2000 + 4000 + 8000 + 16000 + 32000 + 128000);
  assert.equal(x.accepted, 4000 + 8000 + 16000 + 128000);
  assert.equal(x.scheduled, 16000 + 128000);
  assert.equal(x.completed, 128000);
  assert.equal(x.still_open, 255000 - 128000);
  assert.equal(x.step_pct.completed, 88.9);
  assert.equal(x.median_days_to_schedule, 1.5, 'booked 3 days after the exam; done the same day');

  const open = await diagnosisPatients(h.db, c.pid, MARCH);
  assert.equal(open.count, 1);
  assert.equal(open.rows[0].open, 127000);
  assert.equal(open.rows[0].stage, 'diagnosed', 'the least advanced open item says what to do next');
  assert.equal(open.rows[0].items.length, 7, 'open items only');
  const stuck = await diagnosisPatients(h.db, c.pid, MARCH, { stage: 'accepted' });
  assert.equal(stuck.rows[0].items.length, 2);
});

test('alternative treatment options count once; a PPO fee schedule gives the expected amount', async () => {
  const c = await ctx();
  const p = await patient(c, 'Opal', 'Options');
  await exam(c, { patient_id: p, code: 'D0150', date: '2026-03-03' });
  const a = await plan(c, p, 'proposed', { option_group: 'tooth-19', name: 'Option A' });
  const b = await plan(c, p, 'proposed', { option_group: 'tooth-19', name: 'Option B' });
  await proc(c, { patient_id: p, code: 'D2740', tooth: '19', fee: 135000, created: '2026-03-03 16:00:00', plan: a });
  await proc(c, { patient_id: p, code: 'D2392', tooth: '19', surfaces: 'MO', fee: 23500, created: '2026-03-03 16:00:00', plan: b });
  let f = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(f.totals.diagnosed, 135000, 'the first option offered');
  await h.db.run("UPDATE treatment_plans SET status = 'accepted' WHERE id = ?", b);
  f = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(f.totals.diagnosed, 23500, 'the option the patient chose');
  assert.equal(f.totals.accepted, 23500);

  const fs = (await h.db.run('INSERT INTO fee_schedules (practice_id, name) VALUES (?, ?)', c.pid, 'Delta PPO')).id;
  await h.db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', fs, 'D2392', 15000);
  const carrier = (await h.db.run('INSERT INTO insurance_carriers (practice_id, name, fee_schedule_id) VALUES (?, ?, ?)', c.pid, 'Delta', fs)).id;
  await h.db.run("INSERT INTO patient_insurance (practice_id, patient_id, carrier_id, priority, subscriber_name, subscriber_id) VALUES (?, ?, ?, 'primary', 'Opal Options', 'X1')", c.pid, p, carrier);
  f = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(f.totals.diagnosed, 23500, 'office fee');
  assert.equal(f.totals.expected, 15000, 'capped at the PPO allowed amount');
});

test('provider attribution: the examining provider and the hygienist of the visit; practice totals count each exam once; offices', async () => {
  const c = await ctx();
  const drB = await provider(c, 'Dr. Bo Park');
  const hyg = await provider(c, 'Hana Hygienist', 'hygienist');
  const office2 = (await c.api.post('/locations', { name: 'North office' })).data;
  const p = await patient(c, 'Hal', 'Hygiene');
  const q = await patient(c, 'Emma', 'Emergency');
  const visit = await appt(c, { patient_id: p, provider_id: hyg.id, start: '2026-03-10 08:00', status: 'completed' });
  await proc(c, { patient_id: p, code: 'D0120', status: 'completed', created: '2026-03-10 09:00:00', completed: '2026-03-10 09:30', appointment_id: visit, provider_id: c.provider.id });
  await proc(c, { patient_id: p, code: 'D4341', fee: 26000, created: '2026-03-10 09:40:00' });
  await exam(c, { patient_id: q, code: 'D0140', date: '2026-03-11', provider_id: drB.id, location_id: office2.id });
  await proc(c, { patient_id: q, code: 'D3330', tooth: '30', fee: 125000, created: '2026-03-11 10:00:00', location_id: office2.id });

  const f = await diagnosisFunnel(h.db, c.pid, MARCH);
  assert.equal(f.totals.exams, 2);
  assert.equal(f.totals.diagnosed, 151000, 'each exam once');
  const by = Object.fromEntries(f.providers.map((x) => [x.name, x]));
  assert.equal(by['Dr. Ann Lee, DDS'].total.diagnosed, 26000);
  assert.equal(by['Hana Hygienist'].total.diagnosed, 26000, 'treatment found at her hygiene visit');
  assert.equal(by['Hana Hygienist'].at_hygiene_visits.diagnosed, 26000);
  assert.equal(by['Dr. Bo Park'].by_exam_type.find((t) => t.exam_type === 'emergency').diagnosed, 125000);
  assert.equal(by['Dr. Bo Park'].total.per_exam, 125000);

  const mine = await diagnosisFunnel(h.db, c.pid, { ...MARCH, providerId: hyg.id });
  assert.equal(mine.totals.diagnosed, 26000);
  assert.deepEqual(mine.providers.map((x) => x.name), ['Hana Hygienist']);
  const north = await diagnosisFunnel(h.db, c.pid, { ...MARCH, locationId: office2.id });
  assert.equal(north.totals.diagnosed, 125000);
  const emergencies = await loadDiagnoses(h.db, c.pid, { ...MARCH, examType: 'emergency' });
  assert.equal(emergencies.findings.length, 1);

  // The report library shows the same numbers.
  const admin = { id: 0, practice_id: c.pid, role: 'admin', location_ids: [] };
  const rep = await runReport(h.db, admin, 'diagnosis-conversion', { ...MARCH });
  assert.equal(rep.totals.diagnosed, 151000);
  assert.equal(rep.rows.find((r) => r.provider === 'Dr. Bo Park').completed_pct, 0);
});

test('running totals today / week / month against goals; un-completing the exam takes its diagnosis away', async () => {
  const c = await ctx();
  const res = await c.api.post(`/patients/${c.patient.id}/procedures`, { code: 'D0150', provider_id: c.provider.id, complete: true });
  assert.equal(res.status, 201);
  await c.api.post(`/patients/${c.patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: c.provider.id });
  // A monthly goal for the provider (cents), set like any other goal.
  const goal = await c.api.put('/metric-goals', { metric: 'diagnosed', scope: 'provider', provider_id: c.provider.id, value: 2200000 });
  assert.equal(goal.status, 201);

  const run = (await c.api.get(`/diagnosis/running?provider_id=${c.provider.id}`)).data;
  assert.deepEqual(run.periods.map((x) => x.key), ['today', 'week', 'month']);
  for (const x of run.periods) assert.equal(x.diagnosed, 23500, x.key);
  const month = run.periods[2];
  assert.ok(month.goal > 0 && month.goal <= 2200000, 'the month-to-date share of the goal');
  assert.equal(month.goal_source, 'provider goal');
  assert.ok(['good', 'watch', 'behind'].includes(month.standing));
  // Practice view with a row per provider; no practice goal → no borrowing of the provider's.
  const all = (await c.api.get('/diagnosis/running?scope=practice&per_provider=1')).data;
  assert.equal(all.periods[0].diagnosed, 23500);
  assert.equal(all.periods[2].goal, null);
  assert.equal(all.providers[0].month.diagnosed, 23500);
  assert.equal(all.providers[0].month_goal, month.goal, 'their month-to-date share of the goal');

  // The exam charged in error: un-completing it (the charge is voided) means there was no exam.
  const examRow = await h.db.get("SELECT id FROM procedures WHERE patient_id = ? AND code = 'D0150'", c.patient.id);
  assert.equal((await c.api.post(`/procedures/${examRow.id}/uncomplete`, { reason: 'Charted on the wrong patient' })).status, 200);
  const after = await diagnosisRunning(h.db, c.pid, { today: run.today, providerId: c.provider.id });
  assert.equal(after.periods[0].diagnosed, 0);
  assert.equal(after.periods[0].exams, 0);
});

test('permissions, practice isolation, CSV export and the emails', async () => {
  const c = await ctx();
  const hyg = await provider(c, 'Hana Hygienist', 'hygienist');
  const p = await patient(c, 'Iris', 'Iso');
  const visit = await appt(c, { patient_id: p, provider_id: hyg.id, start: '2026-03-10 08:00', status: 'completed' });
  await proc(c, { patient_id: p, code: 'D0120', status: 'completed', created: '2026-03-10 09:00:00', completed: '2026-03-10 09:30', appointment_id: visit });
  await proc(c, { patient_id: p, code: 'D4341', fee: 26000, created: '2026-03-10 09:40:00' });
  const q = await patient(c, 'Dora', 'Doctoronly');
  await exam(c, { patient_id: q, code: 'D0150', date: '2026-03-12' });
  await proc(c, { patient_id: q, code: 'D2740', tooth: '3', fee: 135000, created: '2026-03-12 12:00:00' });

  const funnel = await c.api.get('/diagnosis/funnel?from=2026-03-01&to=2026-03-31');
  assert.equal(funnel.status, 200);
  assert.equal(funnel.data.totals.diagnosed, 161000);
  assert.equal((await c.api.get('/diagnosis/funnel?from=2026-03-01&to=2026-03-31&exam_type=nope')).status, 400);
  assert.equal((await c.api.get('/diagnosis/funnel?period=last_6_months')).status, 200);
  const csv = await c.api.get('/diagnosis/funnel?from=2026-03-01&to=2026-03-31&format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Whole practice \(each exam once\),All exams,2,2,1610\.00/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'diagnosis.export'", c.pid), 'exports are audited');
  const pts = await c.api.get('/diagnosis/patients?from=2026-03-01&to=2026-03-31');
  assert.equal(pts.data.count, 2);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'metrics.drill_down'", c.pid));

  // A hygienist with reports:own sees only her own numbers, whatever she asks for.
  const email = `hana-${Date.now()}@example.com`;
  const u = (await c.api.post('/users', { name: 'Hana', email, password: 'correct-horse-battery', role: 'hygienist', permissions_add: ['reports:own'] })).data;
  await c.api.put(`/providers/${hyg.id}`, { user_id: u.id });
  const hana = h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  const hers = await hana.get(`/diagnosis/funnel?from=2026-03-01&to=2026-03-31&provider_id=${c.provider.id}`);
  assert.equal(hers.status, 200);
  assert.equal(hers.data.provider_id, hyg.id);
  assert.equal(hers.data.totals.diagnosed, 26000);
  assert.deepEqual(hers.data.providers.map((x) => x.name), ['Hana Hygienist']);
  const herChip = await hana.get('/diagnosis/running?per_provider=1');
  assert.equal(herChip.status, 200);
  assert.equal(herChip.data.provider.id, hyg.id);
  assert.equal(herChip.data.providers, undefined, 'no one else’s numbers');
  // Without any report permission: nothing.
  const e2 = `desk-${Date.now()}@example.com`;
  await c.api.post('/users', { name: 'Desk', email: e2, password: 'correct-horse-battery', role: 'front_desk' });
  const desk = h.client((await h.client().post('/auth/login', { email: e2, password: 'correct-horse-battery' })).data.token);
  assert.equal((await desk.get('/diagnosis/funnel')).status, 403);
  assert.equal((await desk.get('/diagnosis/running')).status, 403);
  assert.equal((await desk.get('/diagnosis/patients')).status, 403);

  // Another practice sees none of it and can't point at this practice's provider.
  const other = await ctx();
  assert.equal((await other.api.get('/diagnosis/funnel?from=2026-03-01&to=2026-03-31')).data.totals.diagnosed, 0);
  assert.equal((await other.api.get(`/diagnosis/funnel?provider_id=${hyg.id}`)).status, 404);
  assert.equal((await other.api.get(`/diagnosis/running?provider_id=${hyg.id}`)).status, 404);

  // Emails: the monthly summary carries the funnel (totals only, no patient names); end of day the running totals.
  const monthly = await buildDigest(h.db, { practiceId: c.pid, digest: 'monthly', audience: 'owner', date: '2026-04-01', today: '2026-04-01', appUrl: 'https://app.example.com' });
  assert.match(monthly.text, /Diagnosis & conversion/i);
  assert.match(monthly.text, /\$1,610 of treatment diagnosed/);
  assert.doesNotMatch(monthly.text.split('DIAGNOSIS & CONVERSION')[1].split('See diagnosis')[0], /Iris|Dora/);
  const eod = await buildDigest(h.db, { practiceId: c.pid, digest: 'end_of_day', audience: 'owner', date: '2026-03-12', today: '2026-03-12', appUrl: 'https://app.example.com' });
  assert.match(eod.text, /Treatment diagnosed at exams/i);
  assert.match(eod.text, /Today \$1,350 from 1 exam/);
  const billing = await buildDigest(h.db, { practiceId: c.pid, digest: 'monthly', audience: 'billing', date: '2026-04-01', today: '2026-04-01', appUrl: 'https://app.example.com' });
  assert.doesNotMatch(billing.text, /Diagnosis & conversion/i);
});

// ---- EX1–EX2: exams on a day, and the learned value of an exam ----
// The owner-override table as db.js declares it (created here too, so the tests run on a database made before it).
async function examValuesTable() {
  const pg = !!process.env.TEST_DATABASE_URL;
  await h.db.run(`CREATE TABLE IF NOT EXISTS exam_values (
  id ${pg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  exam_type TEXT NOT NULL CHECK (exam_type IN ('new_patient','recall','perio','emergency')),
  horizon_months INTEGER NOT NULL CHECK (horizon_months IN (1,3,5)),
  value_cents INTEGER NOT NULL,
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, exam_type, horizon_months)
)`);
}

test('the value of an exam: work completed within 1, 3 and 5 months of exams old enough to have had the time, per type and provider', async () => {
  const c = await ctx();
  const drB = await provider(c, 'Dr. Bo Park');
  const TODAY = '2026-09-24';
  const p1 = await patient(c, 'Pat', 'One');
  await exam(c, { patient_id: p1, code: 'D0150', date: '2026-01-10' });
  await proc(c, { patient_id: p1, code: 'D2740', tooth: '3', fee: 135000, created: '2026-01-10 15:00:00', status: 'completed', completed: '2026-03-01 10:00' });
  await proc(c, { patient_id: p1, code: 'D2392', tooth: '30', surfaces: 'MO', fee: 23500, created: '2026-01-10 15:00:00', status: 'completed', completed: '2026-01-20 10:00' });
  const p2 = await patient(c, 'Pat', 'Two');
  await exam(c, { patient_id: p2, code: 'D0150', date: '2026-02-01' }); // nothing found: counts as a $0 exam
  const p3 = await patient(c, 'Pat', 'Three');
  await exam(c, { patient_id: p3, code: 'D0120', date: '2026-03-01' });
  await proc(c, { patient_id: p3, code: 'D2392', tooth: '19', surfaces: 'O', fee: 20000, created: '2026-03-01 15:00:00', status: 'completed', completed: '2026-07-15 10:00' });
  const p4 = await patient(c, 'Pat', 'Four');
  await exam(c, { patient_id: p4, code: 'D0120', date: '2026-06-01' }); // too recent for the 5-month value
  const p5 = await patient(c, 'Pat', 'Five');
  await exam(c, { patient_id: p5, code: 'D0180', date: '2026-02-15', provider_id: drB.id });
  await proc(c, { patient_id: p5, code: 'D4341', fee: 26000, created: '2026-02-15 15:00:00', status: 'completed', completed: '2026-02-20 10:00' });

  const five = await examValues(h.db, c.pid, { today: TODAY });
  assert.deepEqual(five.new_patient.window, { from: '2025-04-24', to: '2026-04-23' });
  assert.equal(five.new_patient.exams, 2);
  assert.equal(five.new_patient.learned, 79250, '($1,350 + $235) over 2 exams');
  assert.equal(five.new_patient.used, 79250);
  assert.equal(five.new_patient.override, null);
  assert.equal(five.new_patient.low_sample, true);
  assert.equal(five.recall.exams, 1, 'the June exam hasn’t had 5 months yet');
  assert.equal(five.recall.learned, 20000);
  assert.equal(five.perio.learned, 26000);
  assert.equal(five.emergency.learned, null);
  const three = await examValues(h.db, c.pid, { today: TODAY, horizon: 3 });
  assert.equal(three.new_patient.learned, 79250);
  assert.equal(three.recall.exams, 2);
  assert.equal(three.recall.learned, 0, 'the filling was done 4½ months after the exam');
  assert.equal(three.recall.diagnosed_per_exam, 10000);
  const one = await examValues(h.db, c.pid, { today: TODAY, horizon: 1 });
  assert.equal(one.new_patient.learned, 11750, 'only the filling was done within a month');
  const bo = await examValues(h.db, c.pid, { today: TODAY, providerId: drB.id });
  assert.equal(bo.perio.learned, 26000);
  assert.equal(bo.new_patient.exams, 0);
  await assert.rejects(() => examValues(h.db, c.pid, { today: TODAY, horizon: 12 }));

  // The owner's own value wins; clearing it goes back to the learned one. Both audited, administrators only.
  await examValuesTable();
  assert.equal((await c.api.put('/exam-values', { exam_type: 'new_patient', horizon_months: 5, value_cents: 184000 })).status, 200);
  assert.equal((await c.api.put('/exam-values', { exam_type: 'new_patient', horizon_months: 5, value_cents: 190000 })).status, 200);
  const set = await examValues(h.db, c.pid, { today: TODAY });
  assert.equal(set.new_patient.override, 190000);
  assert.equal(set.new_patient.used, 190000);
  assert.equal(set.new_patient.learned, 79250);
  assert.equal((await examValues(h.db, c.pid, { today: TODAY, horizon: 3 })).new_patient.override, null, 'per horizon');
  const log = await h.db.all("SELECT action FROM audit_log WHERE practice_id = ? AND action LIKE 'exam_value.%' ORDER BY id", c.pid);
  assert.deepEqual(log.map((x) => x.action), ['exam_value.set', 'exam_value.change']);
  assert.equal((await c.api.put('/exam-values', { exam_type: 'new_patient', horizon_months: 12, value_cents: 1 })).status, 400);
  assert.equal((await c.api.put('/exam-values', { exam_type: 'cleaning', horizon_months: 5, value_cents: 1 })).status, 400);
  assert.equal((await c.api.put('/exam-values', { exam_type: 'recall', horizon_months: 5, value_cents: -5 })).status, 400);
  assert.equal((await c.api.put('/exam-values', { exam_type: 'new_patient', horizon_months: 5, value_cents: null })).status, 200);
  assert.equal((await examValues(h.db, c.pid, { today: TODAY })).new_patient.used, 79250);
  const view = await c.api.get('/exam-values?horizon=5');
  assert.equal(view.status, 200);
  assert.ok(view.data.values[5].new_patient);
  assert.equal((await c.api.get('/exam-values?horizon=2')).status, 400);
  const e2 = `desk-${Date.now()}@example.com`;
  await c.api.post('/users', { name: 'Desk', email: e2, password: 'correct-horse-battery', role: 'front_desk' });
  const desk = h.client((await h.client().post('/auth/login', { email: e2, password: 'correct-horse-battery' })).data.token);
  assert.equal((await desk.put('/exam-values', { exam_type: 'recall', horizon_months: 5, value_cents: 1 })).status, 403);
  assert.equal((await desk.get('/exam-values')).status, 403);
  // Another practice's overrides are its own.
  const other = await ctx();
  assert.equal((await examValues(h.db, other.pid, { today: TODAY })).new_patient.override, null);
});

test('exams on a day: from the codes on the day’s visits (or the visit type), walk-ins, one per patient, cancelled left out', async () => {
  const c = await ctx();
  const D = '2026-10-05';
  const typeId = async (name) => (await h.db.get('SELECT id FROM appointment_types WHERE practice_id = ? AND name = ?', c.pid, name))?.id ?? null;
  const pts = [];
  for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) pts.push(await patient(c, n, 'Day'));
  const a = await appt(c, { patient_id: pts[0], start: `${D} 08:00` });
  await proc(c, { patient_id: pts[0], code: 'D0150', created: '2026-09-20 10:00:00', appointment_id: a });
  await proc(c, { patient_id: pts[0], code: 'D0210', created: '2026-09-20 10:00:00', appointment_id: a });
  const b = await appt(c, { patient_id: pts[1], start: `${D} 09:00`, status: 'completed' });
  await proc(c, { patient_id: pts[1], code: 'D0120', created: '2026-09-20 10:00:00', status: 'completed', completed: `${D} 09:30`, appointment_id: b });
  const emergencyType = await typeId('Emergency / limited exam');
  const cId = await appt(c, { patient_id: pts[2], start: `${D} 10:00` });
  if (emergencyType) await h.db.run('UPDATE appointments SET appointment_type_id = ? WHERE id = ?', emergencyType, cId);
  const d = await appt(c, { patient_id: pts[3], start: `${D} 11:00`, status: 'cancelled' });
  await proc(c, { patient_id: pts[3], code: 'D0180', created: '2026-09-20 10:00:00', appointment_id: d });
  await proc(c, { patient_id: pts[4], code: 'D0180', created: `${D} 12:00:00`, status: 'completed', completed: `${D} 12:30` }); // walk-in, no visit
  const f = await appt(c, { patient_id: pts[5], start: `${D} 13:00` });
  await proc(c, { patient_id: pts[5], code: 'D0120', created: '2026-09-20 10:00:00', appointment_id: f });
  await proc(c, { patient_id: pts[5], code: 'D0180', created: '2026-09-20 10:00:00', appointment_id: f });

  const day = await examsForDay(h.db, c.pid, D);
  assert.ok(emergencyType, 'the default visit types include the emergency exam');
  assert.deepEqual(day.by_type, { new_patient: 1, recall: 1, perio: 2, emergency: 1 });
  assert.deepEqual(day.completed, { new_patient: 0, recall: 1, perio: 1, emergency: 0 });
  assert.equal(day.total, 5);
  const east = (await h.db.run('INSERT INTO locations (practice_id, name) VALUES (?, ?)', c.pid, 'East')).id;
  await h.db.run('UPDATE appointments SET location_id = ? WHERE id = ?', east, b);
  const atEast = await examsForDay(h.db, c.pid, D, { locationId: east });
  assert.deepEqual([atEast.total, atEast.by_type.recall], [1, 1], 'one office: its visits only');
  const other = await ctx();
  assert.equal((await examsForDay(h.db, other.pid, D)).total, 0);
});
