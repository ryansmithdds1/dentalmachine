// Training records (routes/training.js): everyone keeps their own — a walkthrough started, how far they got, how it
// ended — and managers (training:manage) give people sets of walkthroughs and see everyone's progress. Records can't
// be changed after they end, nobody can touch someone else's, and starts, finishes and assignments are audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { tourIndex } from '../src/routes/training.js';
import { accountPortion } from '../src/autobill.js';

const h = harness();
const TOURS = Object.keys(tourIndex().tours);

async function staff(api, role, name) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const made = await api.post('/users', { email, name, role, password: `${role}-password-123` });
  const login = await h.client().post('/auth/login', { email, password: `${role}-password-123` });
  return { ...h.client(login.data.token), id: made.data.id ?? made.data.user?.id };
}

test('my training: start, progress, finish — once, only my own, and audited', async () => {
  const { api } = await h.practice();
  assert.ok(TOURS.length > 20, 'the tour index is there');
  const desk = await staff(api, 'front_desk', 'Dana Desk');
  const tess = (await desk.post('/training/patient')).data;
  const tour = TOURS[0];
  const start = await desk.post('/training/runs', { tour_id: tour, on_training: true, patient_id: tess.id, steps_total: 3, client_key: 'k1' });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.equal((await desk.post('/training/runs', { tour_id: tour, on_training: true, patient_id: tess.id, steps_total: 3, client_key: 'k1' })).data.id, start.data.id, 'asked twice: one record');
  assert.equal((await desk.post('/training/runs', { tour_id: 'A999x', steps_total: 1 })).status, 400, 'only tours that exist');
  assert.equal((await desk.post('/training/runs', { tour_id: tour, steps_total: 999 })).status, 400);
  // "On the training patient" must really be the training patient.
  const real = (await api.get('/patients')).data.rows[0];
  assert.equal((await desk.post('/training/runs', { tour_id: tour, on_training: true, patient_id: real.id, steps_total: 2 })).status, 400);
  assert.equal((await desk.post('/training/runs', { tour_id: tour, on_training: false, patient_id: real.id, steps_total: 2 })).status, 201, 'a tour on a real chart is recorded as such');
  // Progress, then the end.
  assert.equal((await desk.patch(`/training/runs/${start.data.id}`, { steps_done: 2, steps_shown: 1 })).data.steps_done, 2);
  assert.equal((await desk.patch(`/training/runs/${start.data.id}`, { steps_done: 9 })).status, 400);
  const done = await desk.patch(`/training/runs/${start.data.id}`, { status: 'completed', steps_done: 3, steps_shown: 1 });
  assert.equal(done.data.status, 'completed');
  assert.ok(done.data.finished_at);
  assert.equal((await desk.patch(`/training/runs/${start.data.id}`, { status: 'exited' })).status, 409, 'never changed after it ends');
  // Someone else's run can't be touched.
  const other = await staff(api, 'billing', 'Bo Billing');
  const theirs = (await other.post('/training/runs', { tour_id: tour, steps_total: 2 })).data;
  assert.equal((await desk.patch(`/training/runs/${theirs.id}`, { status: 'completed' })).status, 403);
  // My training: what I've completed.
  const me = (await desk.get('/training/me')).data;
  assert.ok(me.completed[tour]);
  assert.equal(me.can_manage, false);
  assert.equal(me.training_patient.id, tess.id);
  // Audited: the start and the finish.
  const actions = (await h.db.all("SELECT action FROM audit_log WHERE entity = 'tour_runs' AND entity_id = ? ORDER BY id", String(start.data.id))).map((a) => a.action);
  assert.ok(actions.includes('training.tour.start') && actions.includes('training.tour.complete'), actions.join(', '));
  // Another practice can't see or touch it.
  const elsewhere = await h.practice();
  assert.equal((await elsewhere.api.patch(`/training/runs/${start.data.id}`, { steps_done: 1 })).status, 404);
});

test('managers assign sets of walkthroughs and see everyone; staff see only their own list', async () => {
  const { api } = await h.practice();
  const desk = await staff(api, 'front_desk', 'Dana Desk');
  const hyg = await staff(api, 'hygienist', 'Hana Hyg');
  // Permissions: staff can't assign or see the team.
  assert.equal((await desk.get('/training/team')).status, 403);
  assert.equal((await desk.post('/training/assignments', { user_id: hyg.id, tour_ids: TOURS.slice(0, 2) })).status, 403);
  // Given the permission (Settings → Users & roles), an office manager who isn't an admin can.
  await api.put(`/users/${desk.id}`, { permissions_add: ['training:manage'] });
  const lead = await h.client((await h.client().post('/auth/login', { email: (await h.db.get('SELECT email FROM users WHERE id = ?', desk.id)).email, password: 'front_desk-password-123' })).data.token);
  const sets = (await api.get('/training/sets')).data.sets;
  assert.ok(sets.length >= 3, 'ready-made sets');
  const set = sets.find((s) => s.key === 'front-desk-basics') || sets[0];
  // Validated: the person, the set, the tours, the date.
  assert.equal((await api.post('/training/assignments', { user_id: 999999, set_key: set.key })).status, 404);
  assert.equal((await api.post('/training/assignments', { user_id: hyg.id, set_key: 'nope' })).status, 400);
  assert.equal((await api.post('/training/assignments', { user_id: hyg.id, tour_ids: ['A999x'], title: 'x' })).status, 400);
  assert.equal((await api.post('/training/assignments', { user_id: hyg.id, set_key: set.key, due_on: '2026-02-31' })).status, 400);
  const other = await h.practice();
  const stranger = (await h.db.get("SELECT id FROM users WHERE practice_id = (SELECT practice_id FROM patients WHERE id = ?) AND role = 'admin'", other.patient.id)).id;
  assert.equal((await api.post('/training/assignments', { user_id: stranger, set_key: set.key })).status, 404, 'only my practice’s people');
  const a = await (lead.post ? lead : api).post('/training/assignments', { user_id: hyg.id, set_key: set.key, due_on: '2031-01-31', client_key: 'a1' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await api.post('/training/assignments', { user_id: hyg.id, set_key: set.key, due_on: '2031-01-31', client_key: 'a1' })).data.id, a.data.id, 'asked twice: one assignment');
  // It's on their to-do list, with progress.
  let mine = (await hyg.get('/training/me')).data;
  assert.equal(mine.assignments.length, 1);
  assert.equal(mine.assignments[0].pct, 0);
  const first = set.tours[0];
  const run = (await hyg.post('/training/runs', { tour_id: first, steps_total: 2 })).data;
  await hyg.patch(`/training/runs/${run.id}`, { status: 'completed', steps_done: 2 });
  mine = (await hyg.get('/training/me')).data;
  assert.deepEqual(mine.assignments[0].done, [first]);
  assert.equal(mine.assignments[0].pct, Math.round(100 / set.tours.length));
  // The team view.
  const team = (await api.get('/training/team')).data;
  const h1 = team.people.find((p) => p.id === hyg.id);
  assert.equal(h1.assignments[0].title, set.title);
  assert.ok(h1.completed[first]);
  assert.equal(h1.pct, Math.round(100 / set.tours.length));
  // Taken off the list (not deleted), audited both ways.
  const off = await api.post(`/training/assignments/${a.data.id}/cancel`);
  assert.equal(off.data.status, 'cancelled');
  assert.equal((await hyg.get('/training/me')).data.assignments.length, 0);
  assert.ok(await h.db.get("SELECT id FROM training_assignments WHERE id = ? AND status = 'cancelled'", a.data.id), 'kept, not deleted');
  const actions = (await h.db.all("SELECT action FROM audit_log WHERE entity = 'training_assignments' AND entity_id = ?", String(a.data.id))).map((x) => x.action);
  assert.ok(actions.includes('training.assign') && actions.includes('training.unassign'), actions.join(', '));
  // Staff can't cancel.
  assert.equal((await hyg.post(`/training/assignments/${a.data.id}/cancel`)).status, 403);
});

test('the training patient routes need a signed-in person with patient access; prepare checks what it is asked', async () => {
  const { api } = await h.practice();
  assert.equal((await h.client().post('/training/patient')).status, 401);
  assert.equal((await api.post('/training/patient/reset')).status, 404, 'nothing to reset before there is one');
  await api.post('/training/patient');
  assert.equal((await api.post('/training/patient/prepare', { needs: ['launch_rockets'] })).status, 400);
  assert.equal((await api.post('/training/patient/prepare', { needs: ['visit_today:flying'] })).status, 400);
  assert.equal((await api.post('/training/patient/prepare', { needs: 'visit_today' })).status, 400);
  const ok = (await api.post('/training/patient/prepare', { needs: ['visit_today:in_chair'] })).data;
  assert.ok(ok.appt);
  assert.equal((await h.db.get('SELECT status FROM appointments WHERE id = ?', ok.appt)).status, 'in_chair');
  // Asked again with another status: the same visit moves (a tour's set-up is repeatable).
  const again = (await api.post('/training/patient/prepare', { needs: ['visit_today:checked_in'] })).data;
  assert.equal(again.appt, ok.appt);
  assert.equal((await h.db.get('SELECT status FROM appointments WHERE id = ?', ok.appt)).status, 'checked_in');
});

test('walkthrough set-ups: checkout owing or paid up, the recall open, a lab case, practice x-rays — and worklists show her only while practising', async () => {
  const { api, token } = await h.practice();
  const tess = (await api.post('/training/patient')).data;
  const { practice_id: practiceId } = await h.db.get('SELECT practice_id FROM patients WHERE id = ?', tess.id);
  const portion = async () => (await accountPortion(h.db, practiceId, tess.id));
  const paid = (await api.post('/training/patient/prepare', { needs: ['unbilled', 'paid_up', 'recall_open'] })).data;
  assert.ok(paid.appt, 'the finished visit to check out');
  assert.ok(await portion() <= 0, 'nothing due now');
  assert.ok(await h.db.get("SELECT id FROM recalls WHERE patient_id = ? AND status IN ('due','contacted')", tess.id), 'the cleaning still to book');
  // Asked again (the same tour started twice): the same visit, nothing doubled.
  assert.equal((await api.post('/training/patient/prepare', { needs: ['unbilled', 'paid_up'] })).data.appt, paid.appt);
  await api.post('/training/patient/prepare', { needs: ['owes'] });
  assert.ok(await portion() > 0, 'something due now');
  const lab = (await api.post('/training/patient/prepare', { needs: ['lab_case'] })).data;
  assert.equal((await h.db.get('SELECT patient_id, status FROM lab_cases WHERE id = ?', lab.lab_case)).patient_id, tess.id);
  await api.post('/training/patient/prepare', { needs: ['xrays'] });
  const mounts = (await api.get(`/patients/${tess.id}/mounts`)).data;
  assert.equal(Object.keys(mounts[0].slots).length, 4, 'four practice bitewings');
  assert.equal((await api.post('/training/patient/prepare', { needs: ['visit_future:99'] })).status, 400);
  const tomorrow = (await api.post('/training/patient/prepare', { needs: ['visit_future:1'] })).data;
  assert.ok(tomorrow.appt_date > paid.today);
  // The recall list: real patients only, unless the person is practising a walkthrough.
  const before = new Date(Date.parse(`${paid.today}T12:00:00Z`) + 60 * 86400_000).toISOString().slice(0, 10);
  const plain = (await api.get(`/recalls?before=${before}&status=due,contacted`)).data;
  assert.ok(!(plain.rows || plain).some((r) => r.patient_id === tess.id), 'not on the everyday recall list');
  const practising = (await h.client(token, { 'X-Practice-Mode': '1' }).get(`/recalls?before=${before}&status=due,contacted`)).data;
  assert.ok((practising.rows || practising).some((r) => r.patient_id === tess.id), 'on it while practising');
  // Reset takes the practice x-ray files with it.
  const keys = (await h.db.all('SELECT storage_key FROM documents WHERE patient_id = ?', tess.id)).map((d) => d.storage_key);
  assert.equal((await api.post('/training/patient/reset')).status, 200);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM documents WHERE patient_id = ?', tess.id)).n, 0);
  assert.ok(keys.length >= 4);
});
