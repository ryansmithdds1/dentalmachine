// Predictions as staff saw them (predict/log.js): written when a percentage is served to a person, once per subject,
// percentage and day however often the screen is opened, never holding up the response, a write that keeps failing
// shows up in Needs attention; the accuracy report's "What staff saw" joins them to what happened; the CSV export is
// reports-only and audited; one practice never sees another's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { practiceNow } from '../src/util.js';
import { addDays } from '../src/predict/noshow.js';
import { clearPredictCache } from '../src/predict/index.js';
import { logShown, flushPredictionLog, resetPredictionLog, loggedAccuracy, LOG_ISSUE_KEY, FAILS_BEFORE_ISSUE, MIN_LOGGED } from '../src/predict/log.js';
import { MODEL_VERSION } from '../src/predict/builtin.js';

const h = harness();
const count = async (pid, extra = '') => Number((await h.db.get(`SELECT COUNT(*) AS n FROM prediction_log WHERE practice_id = ?${extra}`, pid)).n);
async function visit(p, patientId, date, status, extra = {}) {
  return (await h.db.run(
    'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, created_at, confirmed_at, broken_reason, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    p.practiceId, patientId, p.provider.id, `${date} ${extra.time || '09:00'}`, `${date} ${extra.end || '10:00'}`, status, `${addDays(date, -30)} 12:00:00`, extra.confirmed_at ?? null,
    extra.broken_reason ?? null, extra.cancelled_at ?? null,
  )).id;
}
const login = async (p, role) => {
  const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
  assert.equal((await p.api.post('/users', { name: role, email, password: 'correct-horse-battery', role })).status, 201);
  return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
};

test('the schedule notes what was shown, once per visit, percentage and day; a new percentage is a new row', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const today = (await practiceNow(h.db, p.practiceId)).slice(0, 10);
  const tomorrow = addDays(today, 1);
  for (const d of [-90, -50, -20]) await visit(p, p.patient.id, addDays(today, d), 'no_show');
  const v1 = await visit(p, p.patient.id, tomorrow, 'scheduled', { time: '09:00', end: '09:30' });
  const other = (await p.api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01' })).data;
  const v2 = await visit(p, other.id, tomorrow, 'scheduled', { time: '10:00', end: '10:30' });
  clearPredictCache();

  const res = await p.api.get(`/schedule?from=${tomorrow}`);
  assert.equal(res.status, 200);
  await flushPredictionLog();
  const rows = await h.db.all('SELECT * FROM prediction_log WHERE practice_id = ? ORDER BY subject_id', p.practiceId);
  assert.deepEqual(rows.map((r) => r.subject_id), [v1, v2]);
  const by = Object.fromEntries(res.data.appointments.map((a) => [a.id, a.no_show_risk]));
  const r1 = rows.find((r) => r.subject_id === v1);
  assert.deepEqual([r1.kind, r1.subject_type, r1.percent, r1.driver, r1.model_version, r1.screen, r1.shown_on], ['no_show', 'appointment', by[v1].percent, 'builtin', MODEL_VERSION, 'schedule', today]);
  assert.equal(Number(r1.probability), by[v1].probability);
  assert.deepEqual(JSON.parse(r1.reasons), by[v1].reasons);
  assert.ok(r1.shown_to, 'who was shown it');

  // Opened again (and again, and from the visit panel): nothing new — the memo, and without it the unique key.
  await p.api.get(`/schedule?from=${tomorrow}`);
  await p.api.get(`/appointments/${v1}`);
  await flushPredictionLog();
  assert.equal(await count(p.practiceId), 2);
  resetPredictionLog();
  await p.api.get(`/schedule?from=${tomorrow}`);
  await flushPredictionLog();
  assert.equal(await count(p.practiceId), 2, 'the unique key keeps one row per subject, percentage and day');

  // Confirmed: a different percentage, so a new row.
  await p.api.patch(`/appointments/${v1}/status`, { status: 'confirmed' });
  clearPredictCache();
  const again = await p.api.get(`/schedule?from=${tomorrow}`);
  await flushPredictionLog();
  const now = again.data.appointments.find((a) => a.id === v1).no_show_risk;
  assert.notEqual(now.percent, by[v1].percent);
  assert.equal(await count(p.practiceId, ` AND subject_id = ${v1}`), 2);

  // Another practice's rows are its own.
  const q = await h.practice();
  assert.equal(await count(q.practiceId), 0);
  // Nothing is logged for a request without a person (an API key), nor for no predictions.
  assert.equal(logShown(h.db, { user: { id: null, practice_id: p.practiceId } }, [{ kind: 'no_show', subject_type: 'appointment', subject_id: v1, prediction: now }], 'x'), null);
  assert.equal(logShown(h.db, { user: { id: 5, role: 'api', practice_id: p.practiceId } }, [{ kind: 'no_show', subject_type: 'appointment', subject_id: v1, prediction: now }], 'x'), null);
});

test('a write that keeps failing becomes a Needs attention item, resolved by the next one that works; the screen never waits', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  let broken = true;
  const flaky = {
    ...h.db, dialect: h.db.dialect, get: h.db.get, all: h.db.all, tx: h.db.tx,
    run: (sql, ...args) => (broken && /INSERT INTO prediction_log/.test(sql) ? Promise.reject(new Error('disk full')) : h.db.run(sql, ...args)),
  };
  const req = { user: { id: 1, role: 'admin', practice_id: p.practiceId } };
  const entry = (id) => [{ kind: 'no_show', subject_type: 'appointment', subject_id: id, prediction: { probability: 0.2, percent: 20, confidence: 'low', reasons: [], driver: 'builtin' } }];
  const open = () => h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", p.practiceId, LOG_ISSUE_KEY);
  for (let i = 1; i < FAILS_BEFORE_ISSUE; i++) await logShown(flaky, req, entry(1000 + i), 'schedule');
  assert.equal(await open(), undefined, 'one or two failures are only logged');
  await logShown(flaky, req, entry(1100), 'schedule');
  const issue = await open();
  assert.ok(issue, 'raised after repeated failures');
  assert.match(issue.title, /aren’t being saved/);
  broken = false;
  await logShown(flaky, req, entry(1200), 'schedule');
  assert.equal(await open(), undefined, 'resolved by the next write that works');
  assert.equal(await count(p.practiceId), 1);
});

test('“What staff saw”: the last percentage shown for each visit against what happened; the default once there are enough', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const today = (await practiceNow(h.db, p.practiceId)).slice(0, 10);
  const pid = p.practiceId;
  const shown = (id, pct, day) => h.db.run(
    "INSERT INTO prediction_log (practice_id, kind, subject_type, subject_id, probability, percent, confidence, driver, model_version, reasons, screen, shown_on) VALUES (?, 'no_show', 'appointment', ?, ?, ?, 'medium', 'builtin', ?, '[]', 'schedule', ?)",
    pid, id, pct / 100, pct, MODEL_VERSION, day,
  );
  // 20 visits: shown 10% then 40% (the last one counts); the 40% ones missed half the time.
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const d = addDays(today, -10 - i);
    const status = i % 2 ? 'completed' : 'no_show';
    const id = await visit(p, p.patient.id, d, status, { time: `${String(8 + (i % 8)).padStart(2, '0')}:00`, end: `${String(8 + (i % 8)).padStart(2, '0')}:30` });
    ids.push(id);
    await shown(id, 10, addDays(d, -3));
    await shown(id, 40, addDays(d, -1));
  }
  // An early cancellation (no outcome either way), a late one (missed), and a visit still ahead (not known yet).
  const early = await visit(p, p.patient.id, addDays(today, -5), 'cancelled', { broken_reason: 'sick', cancelled_at: `${addDays(today, -9)} 10:00` });
  const late = await visit(p, p.patient.id, addDays(today, -4), 'cancelled', { broken_reason: 'sick', cancelled_at: `${addDays(today, -5)} 20:00` });
  const ahead = await visit(p, p.patient.id, addDays(today, 3), 'scheduled');
  for (const id of [early, late, ahead]) await shown(id, 25, addDays(today, -6));

  const acc = await loggedAccuracy(h.db, pid, 'no_show', { months: 3 });
  assert.equal(acc.source, 'logged');
  assert.equal(acc.n, 21, '20 visits and the late cancellation');
  const b40 = acc.bins.find((b) => b.from === 40);
  assert.deepEqual([b40.n, b40.predicted, b40.actual], [20, 40, 50]);
  assert.equal(acc.bins.find((b) => b.from === 20).n, 1);
  assert.equal(acc.bins.find((b) => b.from === 0).n, 0, 'the earlier 10% was replaced by the last one shown');

  // Under MIN_LOGGED: the report defaults to the backtest and says how many it has; asked for, it shows them anyway.
  const auto = await p.api.get('/predict/accuracy?kind=no_show&months=3');
  assert.equal(auto.status, 200);
  assert.equal(auto.data.source, 'backtest');
  assert.equal(auto.data.available.logged, 21);
  assert.equal(auto.data.available.min_logged, MIN_LOGGED);
  const asked = await p.api.get('/predict/accuracy?kind=no_show&months=3&source=logged');
  assert.equal(asked.data.source, 'logged');
  assert.equal(asked.data.n, 21);
  assert.equal((await p.api.get('/predict/accuracy?source=vibes')).status, 400);
  // With enough, it's the default.
  for (let i = 0; i < 12; i++) {
    const d = addDays(today, -40 - i);
    const id = await visit(p, p.patient.id, d, 'completed', { time: '12:00', end: '12:30' });
    await shown(id, 5, addDays(d, -1));
  }
  const enough = await p.api.get('/predict/accuracy?kind=no_show&months=3');
  assert.equal(enough.data.source, 'logged');
  assert.ok(enough.data.n >= MIN_LOGGED);
  // Another practice sees none of it.
  const q = await h.practice();
  const theirs = await q.api.get('/predict/accuracy?kind=no_show&months=3&source=logged');
  assert.equal(theirs.data.n, 0);
});

test('denials: Ready to approve and the claim screen note lines and the claim; outcomes come from the payer’s answer', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = p.practiceId;
  const carrier = (await p.api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await p.api.post(`/patients/${p.patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'S-1', group_number: 'G1' })).data;
  const a = (await p.api.post(`/patients/${p.patient.id}/procedures`, { code: 'D2391', tooth: '19', surfaces: 'O', provider_id: p.provider.id, complete: true })).data;
  const b = (await p.api.post(`/patients/${p.patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: p.provider.id, complete: true })).data;
  const q = await p.api.get('/claim-queue');
  assert.equal(q.status, 200);
  const g = q.data.groups.find((x) => x.patient_id === p.patient.id);
  assert.ok(g?.denial?.claim);
  await flushPredictionLog();
  const rows = await h.db.all('SELECT subject_type, subject_id, percent, screen FROM prediction_log WHERE practice_id = ? ORDER BY subject_type, subject_id', pid);
  assert.deepEqual(rows.map((r) => [r.subject_type, r.subject_id, r.screen]), [
    ['claim_group', Math.min(a.id, b.id), 'ready_to_approve'], ['procedure', a.id, 'ready_to_approve'], ['procedure', b.id, 'ready_to_approve'],
  ]);
  assert.equal(rows.find((r) => r.subject_type === 'claim_group').percent, g.denial.claim.percent);

  // The claim is made; its screen notes the claim too.
  const claim = (await p.api.post('/claims', { patient_id: p.patient.id, patient_insurance_id: policy.id, procedure_ids: [a.id, b.id] })).data;
  assert.equal((await p.api.get(`/claims/${claim.id}/validate`)).status, 200);
  await flushPredictionLog();
  assert.equal(await count(pid, ` AND subject_type = 'claim' AND subject_id = ${claim.id} AND screen = 'claim'`), 1);

  // The payer denies it: every line and the claim count as denied in "What staff saw".
  await h.db.run("UPDATE claims SET status = 'denied' WHERE id = ?", claim.id);
  const acc = await loggedAccuracy(h.db, pid, 'denial', { months: 1 });
  assert.equal(acc.n, 2, 'two lines');
  assert.equal(acc.actual_rate, 100);
  assert.equal(acc.claims.n, 2, 'the claim, and the group it was made from');
  assert.equal(acc.claims.actual_rate, 100);
});

test('the CSV: reports permission, audited, what was shown and what happened, this practice only', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const today = (await practiceNow(h.db, p.practiceId)).slice(0, 10);
  const id = await visit(p, p.patient.id, addDays(today, -3), 'no_show');
  await h.db.run(
    "INSERT INTO prediction_log (practice_id, kind, subject_type, subject_id, probability, percent, confidence, driver, model_version, reasons, screen, shown_on) VALUES (?, 'no_show', 'appointment', ?, 0.34, 34, 'high', 'builtin', ?, ?, 'schedule', ?)",
    p.practiceId, id, MODEL_VERSION, JSON.stringify(['2 missed visits in the past year', 'not confirmed yet']), addDays(today, -4),
  );
  const csv = await fetch(`${h.origin}/api/predict/log.csv?kind=no_show&months=3`, { headers: { Authorization: `Bearer ${p.token}` } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  const [head, line] = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(head, /^Shown on,Shown at \(UTC\),Prediction,About,Record #,Percent,Confidence,Reasons,Screen,Shown to,Model,Model version,What happened$/);
  assert.match(line, new RegExp(`^${addDays(today, -4)},.*,No-show or late cancellation,Visit,${id},34,high,2 missed visits in the past year; not confirmed yet,schedule,,builtin,${MODEL_VERSION},Missed or cancelled late$`));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'report.export' AND entity = 'prediction_log'", p.practiceId), 'audited');
  assert.equal((await p.api.get('/predict/log.csv?kind=other')).status, 400);
  const desk = await login(p, 'front_desk');
  assert.equal((await desk.get('/predict/log.csv?kind=no_show')).status, 403);
  const q = await h.practice();
  const theirs = await fetch(`${h.origin}/api/predict/log.csv?kind=no_show&months=3`, { headers: { Authorization: `Bearer ${q.token}` } });
  assert.equal((await theirs.text()).replace(/^﻿/, '').trim().split('\r\n').length, 1, 'only the header');
});
