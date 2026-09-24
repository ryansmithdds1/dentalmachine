// Working through an internet outage: the offline copy (GET /offline/snapshot), its keys, the "already sent?"
// check for queued changes and the sync report. The route isn't mounted in app.js by this file's author, so the
// tests mount it on a small app of their own in front of the real one (the snapshot reads the schedule
// through the real app, as it does in production).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import offlineRoutes, { idempotencyScope } from '../src/routes/offline.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, practiceNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';

const h = harness();
let origin;
let server;
before(async () => {
  // The harness opens its database in its own before hook; wait for it.
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
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
  api.use(offlineRoutes({ db: h.db, secret: 'test-secret', app: () => h.app }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const offline = (token, headers = {}) => async (path) => {
  const res = await fetch(`${origin}/api${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const offlinePost = (token) => async (path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const signIn = async (email, password = 'correct-horse-battery') => (await h.client().post('/auth/login', { email, password })).data.token;

// A practice on UTC with visits yesterday, today (two patients) and tomorrow, and clinical history for Jane.
async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const { api, patient, provider } = p;
  const today = (await practiceNow(h.db, p.practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id)).slice(0, 10);
  const shift = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  await api.put(`/patients/${patient.id}`, { allergies: 'Penicillin', medications: 'Lisinopril 10mg', medical_alerts: 'High blood pressure' });
  const sam = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1970-02-03' })).data;
  const tia = (await api.post('/patients', { first_name: 'Tia', last_name: 'Lo', dob: '1990-02-03' })).data;
  const old = (await api.post('/patients', { first_name: 'Old', last_name: 'Visit', dob: '1960-02-03' })).data;
  const book = async (pt, date, time) => (await api.post('/appointments', { patient_id: pt.id, provider_id: provider.id, start_time: `${date} ${time}`, end_time: `${date} ${time.replace(/^(\d\d)/, (h) => String(Number(h) + 1).padStart(2, '0'))}`, override_blockout: true, notify: false })).data;
  const visit = await book(patient, today, '09:00');
  await book(sam, today, '10:00');
  await book(tia, shift(1), '09:00');
  await book(old, shift(-1), '09:00');
  assert.ok(visit.id, 'booked today');
  await api.post(`/patients/${patient.id}/notes`, { body: 'Prophy, no complications', appointment_id: visit.id });
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '3', condition: 'caries', surfaces: 'MO' });
  await api.post(`/patients/${patient.id}/perio`, { readings: { 3: { pd: [3, 2, 3, 3, 2, 3] } }, exam_date: shift(-200) });
  await api.post(`/patients/${patient.id}/perio`, { readings: { 3: { pd: [4, 3, 4, 3, 2, 3] } }, exam_date: shift(-10) });
  return { ...p, today, tomorrow: shift(1), sam, tia, old, visit };
}

test('the offline copy: today and tomorrow, and today’s patients’ card, notes, chart and last perio exam', async () => {
  const p = await setUp();
  const { status, data } = await offline(p.token)('/offline/snapshot');
  assert.equal(status, 200);
  assert.equal(data.today, p.today);
  assert.equal(data.tomorrow, p.tomorrow);
  const dates = data.schedule.appointments.map((a) => a.start_time.slice(0, 10));
  assert.ok(dates.includes(p.today) && dates.includes(p.tomorrow), 'today and tomorrow');
  assert.ok(!dates.some((d) => d < p.today), 'not yesterday');
  assert.ok(data.schedule.hours && data.schedule.from === p.today, 'shaped like GET /schedule');
  assert.ok(Array.isArray(data.lookups['/providers?active=true']) && data.lookups['/providers?active=true'].length, 'providers for the schedule');

  // Today's patients only (Tia is tomorrow, the old visit was yesterday).
  assert.deepEqual(Object.keys(data.patients).map(Number).sort(), [p.patient.id, p.sam.id].sort());
  const jane = data.patients[p.patient.id];
  assert.equal(jane.card.allergies, 'Penicillin');
  assert.equal(jane.card.medications, 'Lisinopril 10mg');
  assert.equal(jane.card.medical_alerts, 'High blood pressure');
  assert.equal(jane.card.balance, 0);
  assert.equal(jane.notes.length, 1);
  assert.equal(jane.notes[0].body, 'Prophy, no complications');
  assert.deepEqual(jane.notes[0].addenda, []);
  assert.equal(jane.chart.conditions[0].condition, 'caries');
  assert.equal(jane.perio.length, 1, 'the last exam only');
  assert.deepEqual(jane.perio[0].readings[3].pd, [4, 3, 4, 3, 2, 3]);
  assert.equal(jane.patient.id, p.patient.id);
  assert.equal(jane.patient.photo, null);
  assert.equal(jane.patient.upcoming_appointments.length, 1);
  assert.equal(data.day_sheet.length, 2);
  assert.equal(data.day_sheet[0].name, 'Jane Doe');
  assert.equal(data.day_sheet[0].alert, true);
});

test('the offline copy is audited as one bulk read, and each patient at most once per 12 hours', async () => {
  const p = await setUp();
  await offline(p.token)('/offline/snapshot');
  await offline(p.token)('/offline/snapshot');
  const bulk = await h.db.all("SELECT * FROM audit_log WHERE action = 'offline.snapshot' AND practice_id = (SELECT practice_id FROM patients WHERE id = ?)", p.patient.id);
  assert.equal(bulk.length, 2, 'every fetch is recorded');
  const details = JSON.parse(bulk[0].details);
  assert.deepEqual(details.patient_ids.sort(), [p.patient.id, p.sam.id].sort());
  assert.equal(details.patient_count, 2);
  assert.ok(bulk[0].user_id, 'who');
  const each = await h.db.all("SELECT patient_id FROM audit_log WHERE action = 'offline.snapshot_patient' AND patient_id IN (?, ?)", p.patient.id, p.sam.id);
  assert.equal(each.length, 2, 'one line per patient, not per refresh');
});

test('the offline copy stays in its practice and follows permissions', async () => {
  const a = await setUp();
  const b = await h.practice({ timezone: 'UTC' });
  const theirs = (await offline(b.token)('/offline/snapshot')).data;
  assert.deepEqual(theirs.patients, {}, "another practice's patients never appear");
  assert.equal(theirs.schedule.appointments.length, 0);

  // No clinical access: the schedule and card, without notes, chart, perio or health details.
  const email = `desk-${Date.now()}@example.com`;
  const desk = (await a.api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' })).data;
  await a.api.put(`/users/${desk.id}`, { permissions_remove: ['clinical:read'] });
  const deskToken = await signIn(email);
  const d = (await offline(deskToken)('/offline/snapshot')).data;
  const jane = d.patients[a.patient.id];
  assert.ok(jane.card, 'the card');
  assert.equal(jane.notes, undefined);
  assert.equal(jane.chart, undefined);
  assert.equal(jane.perio, undefined);
  assert.equal(jane.card.allergies, undefined);
  assert.ok(d.omitted.some((o) => o.part === 'clinical'));

  // No schedule access: nothing at all.
  await a.api.put(`/users/${desk.id}`, { permissions_remove: ['clinical:read', 'schedule:read'] });
  assert.equal((await offline(await signIn(email))('/offline/snapshot')).status, 403);
  assert.equal((await offline(await signIn(email))('/offline/key')).status, 403);
  assert.equal((await offline(null)('/offline/snapshot')).status, 401);
});

test('someone limited to one office gets only that office’s visits and patients', async () => {
  const a = await setUp();
  const west = (await a.api.post('/locations', { name: 'Westside' })).data;
  const westie = (await a.api.post('/patients', { first_name: 'Wes', last_name: 'Tside', dob: '1980-01-01', location_id: west.id })).data;
  await a.api.post('/appointments', { patient_id: westie.id, provider_id: a.provider.id, start_time: `${a.today} 13:00`, end_time: `${a.today} 14:00`, location_id: west.id, override_blockout: true, notify: false });
  const main = (await a.api.post('/locations', { name: 'Main' })).data;
  await h.db.run('UPDATE appointments SET location_id = ? WHERE patient_id IN (?, ?)', main.id, a.patient.id, a.sam.id);
  const email = `west-${Date.now()}@example.com`;
  await a.api.post('/users', { email, name: 'West Desk', role: 'front_desk', password: 'correct-horse-battery', location_ids: [west.id] });
  const d = (await offline(await signIn(email), { 'X-Location-Id': String(west.id) })('/offline/snapshot')).data;
  assert.deepEqual(Object.keys(d.patients).map(Number), [westie.id]);
  assert.ok(d.schedule.appointments.every((x) => x.location_id === west.id));
  assert.equal(d.location_id, west.id);
});

test('keys: one for this sign-in’s copy, one for this person’s queued changes', async () => {
  const p = await h.practice();
  const k1 = (await offline(p.token)('/offline/key')).data;
  assert.equal(Buffer.from(k1.session_key, 'base64').length, 32);
  assert.equal(Buffer.from(k1.outbox_key, 'base64').length, 32);
  assert.equal((await offline(p.token)('/offline/key')).data.session_key, k1.session_key, 'stable within a sign-in');
  const k2 = (await offline(await signIn(p.email))('/offline/key')).data;
  assert.notEqual(k2.session_key, k1.session_key, 'a new sign-in cannot read the old copy');
  assert.notEqual(k2.key_id, k1.key_id);
  assert.equal(k2.outbox_key, k1.outbox_key, 'queued changes survive signing in again');
  // "Sign out everywhere" (a new token version) makes anything left on a lost computer unreadable.
  await h.db.run('UPDATE users SET token_version = token_version + 1 WHERE email = ?', p.email);
  const k3 = (await offline(await signIn(p.email))('/offline/key')).data;
  assert.notEqual(k3.outbox_key, k1.outbox_key);
});

test('already sent? a queued change that reached the server under an earlier sign-in is found, not posted twice', async () => {
  const p = await h.practice();
  const key = `offline-${Date.now()}-payment`;
  const pay = await h.client(p.token, { 'Idempotency-Key': key }).post(`/patients/${p.patient.id}/payments`, { amount: 2500, method: 'cash' });
  assert.equal(pay.status, 201);
  const session = await h.db.get('SELECT s.id, s.user_id FROM staff_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? ORDER BY s.id DESC LIMIT 1', p.email);
  assert.ok(await h.db.get('SELECT 1 FROM idempotency_keys WHERE scope = ? AND key = ?', idempotencyScope(session.user_id, session.id), key), 'same scope hash as the middleware');

  const later = await signIn(p.email);
  const other = 'offline-never-sent-1';
  const { data } = await offline(later)(`/offline/sent?keys=${key},${other}`);
  assert.deepEqual(data.sent, [{ key, status: 'done', response_status: 201 }]);
  // Another person's keys are never visible.
  const q = await h.practice();
  assert.deepEqual((await offline(q.token)(`/offline/sent?keys=${key}`)).data.sent, []);
  assert.equal((await offline(later)('/offline/sent?keys=bad key!')).status, 400);
  // The payment went in once.
  const n = await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", p.patient.id);
  assert.equal(n.n, 1);
});

test('the sync report is audited and a failure becomes a Needs attention item, resolved by a later clean sync', async () => {
  const p = await h.practice();
  const post = offlinePost(p.token);
  const r1 = await post('/offline/sync-report', {
    sent: [{ kind: 'status', key: 'k-status-0001', status: 200 }],
    failed: [{ kind: 'note', key: 'k-note-00001', status: 400, error: 'A note can be at most 20,000 characters' }],
    discarded: [{ kind: 'task', key: 'k-task-00001' }],
  });
  assert.equal(r1.status, 200);
  const issue = await h.db.get("SELECT * FROM issues WHERE dedupe_key LIKE 'offline-sync:%' AND status = 'open' AND practice_id = (SELECT practice_id FROM users WHERE email = ?)", p.email);
  assert.ok(issue, 'visible in Needs attention');
  assert.match(issue.title, /1 change made offline/);
  assert.equal(issue.severity, 'high');
  const row = await h.db.get("SELECT details FROM audit_log WHERE action = 'offline.sync' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(row.details).discarded[0].key, 'k-task-00001');
  assert.equal((await post('/offline/sync-report', { failed: [{ kind: 'refund', key: 'k-bad-000001' }] })).status, 400);
  assert.equal((await post('/offline/sync-report', {})).status, 400);
  await post('/offline/sync-report', { sent: [{ kind: 'note', key: 'k-note-00001', status: 201 }] });
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
});
