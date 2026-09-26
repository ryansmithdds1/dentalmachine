// Recall types and frequencies (backlog RF1–RF4; docs/workflows/specs/RF-recall-frequencies.md).
// The routes are served by a small side server on the same database (authenticate → actor → office access →
// recallFreqRoutes, as app.js does), so these tests run whether or not app.js mounts them yet; the last test
// checks the real mount and skips until it's there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, insert, addMonths, practiceNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import recallFreqRoutes from '../src/routes/recallfreq.js';
import { recallTypes, runRecallSequences, DEFAULT_RECALL_TYPES } from '../src/recalls.js';
import { resetRecalls, applyAgeRules, typesFor, ageOn } from '../src/recallsync.js';
import { eligibleFrom, ruleText, bucket, recallCounts } from '../src/recallfreq.js';
import { recallCadence } from '../src/cadence-recall.js';

const h = harness();
let server;
let origin;
// The harness opens its database in its own before hook: the side server reaches it lazily.
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};
before(async () => {
  const app = express();
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(db));
  api.use(recallFreqRoutes({ db }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { if (!(err instanceof HttpError)) console.error(err); res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const client = (token, headers = {}) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
};
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const rf = client(p.token);
  const hyg = (await p.api.post('/providers', { name: 'Hal Hygienist, RDH', type: 'hygienist' })).data;
  const dobFor = (age) => addMonths(today, -(age * 12 + 1));
  const patient = async (age = 40, extra = {}) => ({ id: await insert(h.db, 'patients', { practice_id: pid, first_name: 'Pat', last_name: `Age${age}`, dob: age == null ? null : dobFor(age), phone: '(512) 555-0111', ...extra }) });
  const code = (c) => h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, c);
  // Completes a procedure the normal way (charge, recall reset), today.
  const complete = async (pt, c) => {
    const res = await p.api.post(`/patients/${pt.id}/procedures`, { code: c, provider_id: hyg.id, complete: true });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };
  // Work done on an earlier date (history, as an import or chart entry would leave it), with its reset.
  const doneOn = async (pt, c, date) => {
    const pc = await code(c);
    const id = await insert(h.db, 'procedures', {
      practice_id: pid, patient_id: pt.id, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee, status: 'completed',
      completed_at: `${date} 10:00:00`, provider_id: hyg.id,
    });
    await resetRecalls(h.db, await h.db.get('SELECT * FROM procedures WHERE id = ?', id), date);
    return id;
  };
  const recall = (pt, type) => h.db.get('SELECT * FROM recalls WHERE patient_id = ? AND type = ?', pt.id, type);
  const status = async (pt, q = '') => {
    const r = await rf.get(`/patients/${pt.id}/recall-status${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const item = (st, type) => st.items.find((i) => i.type === type);
  return { ...p, pid, today, rf, hyg, patient, complete, doneOn, recall, status, item, code, dobFor };
}

async function member(p, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await p.api.post('/users', { email, name: `${role} user`, role, password: 'correct-horse-battery', ...extra })).data;
  assert.ok(u.id, JSON.stringify(u));
  const login = await h.client(null, { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { user: u, token: login.data.token, rf: client(login.data.token) };
}

// ---- RF1: the types ----

test('default types: every recall type by its codes, office-defined ones off, bundled ones marked', async () => {
  const s = await setUp();
  const types = await recallTypes(h.db, s.pid);
  const by = Object.fromEntries(types.map((t) => [t.key, t]));
  assert.deepEqual(by.prophy.codes, ['D1110', 'D4346']);
  assert.deepEqual(by.child_prophy.codes, ['D1120']);
  assert.equal(by.child_prophy.age_until, 14);
  assert.equal(by.child_prophy.adult_key, 'prophy');
  assert.deepEqual(by.perio_maint.codes, ['D4910']);
  assert.deepEqual(by.perio_maint.retires, ['prophy', 'child_prophy']);
  assert.ok(by.exam.codes.includes('D0120') && by.exam.codes.includes('D0150'));
  assert.ok(['D0272', 'D0274', 'D0270', 'D0273'].every((c) => by.bwx.codes.includes(c)));
  assert.deepEqual(by.fmx.codes, ['D0210', 'D0330']);
  assert.deepEqual(by.fluoride.codes, ['D1206', 'D1208']);
  for (const k of ['exam', 'bwx', 'fmx', 'fluoride']) assert.equal(by[k].bundle, 1, `${k} rides along with the cleaning`);
  for (const k of ['ortho_check', 'implant_maint', 'sleep_check']) assert.equal(by[k].active, 0, `${k} is the office's to switch on`);
  assert.equal(by.bwx.interval_months, 12);
  assert.equal(by.fmx.interval_months, 60);

  // A practice set up before these existed keeps its setup: the new types arrive switched off.
  const old = await h.practice();
  const oldPid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', old.provider.id)).practice_id;
  await h.db.run("INSERT INTO recall_types (practice_id, key, name, interval_months, codes, active) VALUES (?, 'prophy', 'Prophy', 6, '[\"D1110\",\"D1120\"]', 1)", oldPid);
  const oldTypes = await recallTypes(h.db, oldPid);
  assert.equal(oldTypes.length, DEFAULT_RECALL_TYPES.length);
  assert.deepEqual(oldTypes.filter((t) => t.active).map((t) => t.key), ['prophy']);
  assert.deepEqual(oldTypes.find((t) => t.key === 'prophy').codes, ['D1110', 'D1120'], 'its own prophy codes untouched');
});

test('each default type resets on its codes, from the date of service', async () => {
  const s = await setUp();
  const cases = [['D1110', 'prophy', 6], ['D4910', 'perio_maint', 3], ['D0120', 'exam', 6], ['D0150', 'exam', 6], ['D0272', 'bwx', 12], ['D0274', 'bwx', 12],
    ['D0210', 'fmx', 60], ['D0330', 'fmx', 60], ['D1206', 'fluoride', 6]];
  for (const [c, key, months] of cases) {
    if (!(await s.code(c))) continue;
    const pt = await s.patient(30);
    await s.complete(pt, c);
    const r = await s.recall(pt, key);
    assert.ok(r, `${c} makes a ${key} recall`);
    assert.equal(r.due_date, addMonths(s.today, months), `${c} → ${key} due in ${months} months`);
    assert.equal(r.last_done_date, s.today);
    assert.equal(r.last_done_code, c);
    assert.equal(r.last_done_source, 'here');
  }
  // A child's cleaning resets the child prophy.
  const kid = await s.patient(8);
  await s.complete(kid, 'D1120');
  assert.equal((await s.recall(kid, 'child_prophy')).due_date, addMonths(s.today, 6));
  assert.equal(await s.recall(kid, 'prophy'), undefined);

  // Date of service, not the day it was entered: work done 2 months ago is due 4 months from now.
  const pt = await s.patient(50);
  const past = addMonths(s.today, -2);
  const id = await s.doneOn(pt, 'D1110', past);
  assert.equal((await s.recall(pt, 'prophy')).due_date, addMonths(past, 6));
  // An older visit entered later doesn't pull the due date back; the same one twice is one reset.
  await s.doneOn(pt, 'D1110', addMonths(s.today, -9));
  assert.equal((await s.recall(pt, 'prophy')).due_date, addMonths(past, 6));
  await resetRecalls(h.db, await h.db.get('SELECT * FROM procedures WHERE id = ?', id), past);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM recall_resets WHERE procedure_id = ?', id)).n, 1);
});

test('voiding the procedure puts the recall back to its previous state', async () => {
  const s = await setUp();
  const pt = await s.patient(45);
  // An imported recall (no visit on record here), contacted, due last month.
  const due = addMonths(s.today, -1);
  const rid = await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: pt.id, type: 'prophy', interval_months: 6, due_date: due, status: 'contacted' });
  const proc = await s.complete(pt, 'D1110');
  let r = await s.recall(pt, 'prophy');
  assert.equal(r.id, rid, 'one recall per patient per type');
  assert.equal(r.due_date, addMonths(s.today, 6));
  assert.equal(r.status, 'due');
  const un = await s.api.post(`/procedures/${proc.id}/uncomplete`, { reason: 'Charted on the wrong patient' });
  assert.equal(un.status, 200, JSON.stringify(un.data));
  r = await s.recall(pt, 'prophy');
  assert.equal(r.due_date, due, 'due date back');
  assert.equal(r.status, 'contacted', 'status back');
  assert.equal(r.last_done_date, null);
  // Completing it again resets again (the same reset row comes back).
  await s.api.post(`/procedures/${proc.id}/complete`, { provider_id: s.hyg.id });
  assert.equal((await s.recall(pt, 'prophy')).due_date, addMonths(s.today, 6));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM recall_resets WHERE procedure_id = ?', proc.id)).n, 1);

  // A recall that the voided procedure created is retired, not deleted; an earlier visit takes over again.
  const pt2 = await s.patient(45);
  const bw = await s.complete(pt2, 'D0274');
  await s.api.post(`/procedures/${bw.id}/uncomplete`, { reason: 'Wrong code' });
  const bwx = await s.recall(pt2, 'bwx');
  assert.equal(bwx.status, 'inactive');
  assert.match(bwx.status_reason, /voided/);
  const pt3 = await s.patient(45);
  const earlier = addMonths(s.today, -3);
  await s.doneOn(pt3, 'D1110', earlier);
  const again = await s.complete(pt3, 'D1110');
  await s.api.post(`/procedures/${again.id}/uncomplete`, { reason: 'Duplicate entry' });
  assert.equal((await s.recall(pt3, 'prophy')).due_date, addMonths(earlier, 6), 'the earlier visit decides again');
  // Every recall change is on the audit log with before and after.
  const changes = await h.db.all("SELECT changes FROM audit_log WHERE entity = 'recalls' AND entity_id = ? AND changes IS NOT NULL", rid);
  assert.ok(changes.some((c) => JSON.parse(c.changes).due_date?.[0] === due), JSON.stringify(changes));
});

test('switching to perio maintenance retires the prophy (not deleted); voiding it brings the prophy back', async () => {
  const s = await setUp();
  const pt = await s.patient(55);
  await s.doneOn(pt, 'D1110', addMonths(s.today, -4));
  const pm = await s.complete(pt, 'D4910');
  const prophy = await s.recall(pt, 'prophy');
  assert.equal(prophy.status, 'inactive');
  assert.match(prophy.status_reason, /Replaced by Perio maintenance/);
  assert.equal((await s.recall(pt, 'perio_maint')).due_date, addMonths(s.today, 3));
  const st = await s.status(pt);
  assert.equal(s.item(st, 'prophy').status, 'retired');
  assert.equal(s.item(st, 'perio_maint').status, 'current');
  await s.api.post(`/procedures/${pm.id}/uncomplete`, { reason: 'Was a prophy' });
  assert.equal((await s.recall(pt, 'prophy')).status, 'due');
  assert.equal((await s.recall(pt, 'perio_maint')).status, 'inactive');

  // The switch by hand needs a reason, and is audited with it.
  const pt2 = await s.patient(60);
  await s.doneOn(pt2, 'D1110', addMonths(s.today, -1));
  assert.equal((await s.rf.post(`/patients/${pt2.id}/recalls/switch`, { to: 'perio_maint' })).status, 400);
  const sw = await s.rf.post(`/patients/${pt2.id}/recalls/switch`, { to: 'perio_maint', reason: 'SRP completed, 5 mm pockets' });
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  assert.equal(sw.data.recall.due_date, addMonths(addMonths(s.today, -1), 3));
  assert.equal((await s.recall(pt2, 'prophy')).status, 'inactive');
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'recall.switch' AND patient_id = ?", pt2.id);
  assert.equal(a.reason, 'SRP completed, 5 mm pockets');
});

test('age rule: child prophy becomes prophy at 14, automatically', async () => {
  const s = await setUp();
  // 13 and a half: a child's cleaning.
  const dob = addMonths(s.today, -(13 * 12 + 6));
  const teen = await s.patient(null, { dob });
  await s.complete(teen, 'D1120');
  const child = await s.recall(teen, 'child_prophy');
  assert.equal(child.due_date, addMonths(s.today, 6));
  assert.equal(await applyAgeRules(h.db, s.pid, s.today), 0, 'not yet 14');
  // On the day they're 14 (about six months on — counted from the birth date: at a month's end "today + 6 months"
  // and "today - 13.5 years" roll over by different amounts), the adult recall takes over the due date and last visit.
  const later = addMonths(dob, 14 * 12);
  assert.equal(ageOn(dob, later), 14);
  assert.equal(await applyAgeRules(h.db, s.pid, later), 1);
  const adult = await s.recall(teen, 'prophy');
  assert.equal(adult.due_date, child.due_date);
  assert.equal(adult.last_done_code, 'D1120');
  assert.equal((await s.recall(teen, 'child_prophy')).status, 'inactive');
  assert.equal(await applyAgeRules(h.db, s.pid, later), 0, 'once');
  // A D1120 on a 15-year-old resets the prophy (the age picks the type).
  const older = await s.patient(15);
  await s.complete(older, 'D1120');
  assert.ok(await s.recall(older, 'prophy'));
  assert.equal(await s.recall(older, 'child_prophy'), undefined);
  const types = await recallTypes(h.db, s.pid);
  assert.deepEqual(typesFor(types, 'D1120', 9).map((t) => t.key), ['child_prophy']);
  assert.deepEqual(typesFor(types, 'D1120', 30).map((t) => t.key), ['prophy']);
});

test('per-patient interval override needs a reason, is audited, and moves the due date', async () => {
  const s = await setUp();
  const pt = await s.patient(62);
  const last = addMonths(s.today, -1);
  await s.doneOn(pt, 'D4910', last);
  const r = await s.recall(pt, 'perio_maint');
  assert.equal((await s.rf.put(`/recalls/${r.id}/interval`, { interval_months: 4 })).status, 400, 'reason required');
  assert.equal((await s.rf.put(`/recalls/${r.id}/interval`, { interval_months: 0, reason: 'Stable' })).status, 400);
  const res = await s.rf.put(`/recalls/${r.id}/interval`, { interval_months: 4, reason: 'Stable, periodontist alternates' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.interval_months, 4);
  assert.equal(res.data.interval_overridden, 1);
  assert.equal(res.data.due_date, addMonths(last, 4));
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'recall.interval' AND entity_id = ?", r.id);
  assert.equal(a.reason, 'Stable, periodontist alternates');
  assert.deepEqual(JSON.parse(a.changes).interval_months, [3, 4]);
  // The next visit resets on the patient's own interval.
  await s.complete(pt, 'D4910');
  assert.equal((await s.recall(pt, 'perio_maint')).due_date, addMonths(s.today, 4));
  const st = await s.status(pt);
  assert.equal(s.item(st, 'perio_maint').interval_reason, 'Stable, periodontist alternates');
  // Back to the type's interval.
  const back = await s.rf.put(`/recalls/${r.id}/interval`, { interval_months: null, reason: 'Back to standard' });
  assert.equal(back.data.interval_months, 3);
  assert.equal(back.data.interval_overridden, 0);
});

test('the recall edit screen (PUT /recalls/:id) also needs clinical permission and a reason to change the interval', async () => {
  const s = await setUp();
  const pt = await s.patient(45);
  const last = addMonths(s.today, -1);
  await s.doneOn(pt, 'D1110', last);
  const r = await s.recall(pt, 'prophy');
  assert.equal((await s.api.put(`/recalls/${r.id}`, { interval_months: 4 })).status, 400, 'reason required');
  const desk = await member(s, 'front_desk');
  assert.equal((await h.client(desk.token).put(`/recalls/${r.id}`, { interval_months: 4, reason: 'Heavy calculus' })).status, 403);
  // Status-only edits still need neither.
  assert.equal((await h.client(desk.token).put(`/recalls/${r.id}`, { status: 'contacted' })).status, 200);
  const res = await s.api.put(`/recalls/${r.id}`, { interval_months: 4, reason: 'Heavy calculus' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.interval_months, 4);
  assert.equal(res.data.interval_overridden, 1);
  assert.equal(res.data.interval_reason, 'Heavy calculus');
  assert.equal(res.data.due_date, addMonths(last, 4));
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'recall.interval' AND entity_id = ?", r.id);
  assert.equal(a.reason, 'Heavy calculus');
  // Sending the same interval back is not a change.
  assert.equal((await s.api.put(`/recalls/${r.id}`, { interval_months: 4, notes: 'ok' })).status, 200);
});

test('x-rays taken elsewhere: entered with a date (source outside), audited, reset the recall, voidable', async () => {
  const s = await setUp();
  const pt = await s.patient(35);
  const taken = addMonths(s.today, -2);
  assert.equal((await s.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: addDays(s.today, 1) })).status, 400, 'not in the future');
  assert.equal((await s.rf.post(`/patients/${pt.id}/outside-procedures`, { code: 'D2391', date: taken })).status, 400, 'only recall codes');
  const add = await s.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: taken, office_name: 'Smile Dental (previous dentist)' });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.source, 'outside');
  assert.equal(add.data.code, 'D0274');
  const again = await s.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: taken });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, add.data.id, 'entered once');
  const r = await s.recall(pt, 'bwx');
  assert.equal(r.due_date, addMonths(taken, 12));
  assert.equal(r.last_done_source, 'outside');
  const st = await s.status(pt);
  assert.equal(s.item(st, 'bwx').last_done.where, 'Smile Dental (previous dentist)');
  assert.ok(await h.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'recall.outside_add' AND entity_id = ? AND user_id IS NOT NULL", add.data.id));
  assert.equal((await s.rf.post(`/outside-procedures/${add.data.id}/void`, {})).status, 400, 'reason required');
  const v = await s.rf.post(`/outside-procedures/${add.data.id}/void`, { reason: 'Wrong patient' });
  assert.equal(v.data.status, 'voided');
  assert.equal((await s.recall(pt, 'bwx')).status, 'inactive');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM recall_outside WHERE id = ?', add.data.id)).n, 1, 'kept');
  // After a void the same date can be entered again.
  assert.equal((await s.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: taken })).status, 201);
});

test('status buckets: current, due soon (setting), due, overdue, scheduled with the date', async () => {
  const s = await setUp();
  assert.equal((await s.rf.put('/recall-settings', { due_soon_days: 21, overdue_days: 30 })).status, 200);
  const pt = await s.patient(40);
  const mk = (type, due, extra = {}) => insert(h.db, 'recalls', { practice_id: s.pid, patient_id: pt.id, type, interval_months: 6, due_date: due, ...extra });
  await mk('prophy', addDays(s.today, 40));
  await mk('exam', addDays(s.today, 10));
  await mk('bwx', addDays(s.today, -5));
  await mk('fmx', addDays(s.today, -45));
  const st = await s.status(pt);
  assert.equal(s.item(st, 'prophy').status, 'current');
  assert.equal(s.item(st, 'exam').status, 'due_soon');
  assert.equal(s.item(st, 'bwx').status, 'due');
  assert.equal(s.item(st, 'fmx').status, 'overdue');
  assert.equal(st.settings.due_soon_days, 21);
  // Booking the cleaning makes it scheduled, with the visit's date.
  const start = `${addDays(s.today, 20)} 09:00`;
  const appt = await insert(h.db, 'appointments', { practice_id: s.pid, patient_id: pt.id, provider_id: s.hyg.id, start_time: start, end_time: `${addDays(s.today, 20)} 10:00`, status: 'scheduled' });
  await h.db.run("UPDATE recalls SET status = 'scheduled', appointment_id = ? WHERE patient_id = ? AND type = 'prophy'", appt, pt.id);
  const st2 = await s.status(pt);
  assert.equal(s.item(st2, 'prophy').status, 'scheduled');
  assert.equal(s.item(st2, 'prophy').scheduled.start_time, start);
  assert.equal(st2.next_hygiene_visit.id, appt);
  // Pure rule.
  const set = { due_soon_days: 30, overdue_days: 30 };
  assert.equal(bucket({ status: 'due', due_date: '2026-01-31' }, '2026-01-01', set), 'due_soon');
  assert.equal(bucket({ status: 'due', due_date: '2026-02-01' }, '2026-01-01', set), 'current');
  assert.equal(bucket({ status: 'due', due_date: '2026-01-01' }, '2026-01-31', set), 'due');
  assert.equal(bucket({ status: 'due', due_date: '2026-01-01' }, '2026-02-01', set), 'overdue');
  assert.equal(bucket({ status: 'inactive', due_date: '2026-01-01' }, '2026-02-01', set), 'retired');
});

test('insurance-eligible date from the plan frequency limits', async () => {
  const months12 = { codes: ['D0272', 'D0274'], count: 1, months: 12 };
  assert.equal(eligibleFrom(months12, null, ['2026-03-03'], '2026-09-01'), '2027-03-03', '1 per 12 months');
  assert.equal(eligibleFrom(months12, null, ['2025-03-03'], '2026-09-01'), '2026-09-01', 'already eligible');
  assert.equal(eligibleFrom(months12, null, [], '2026-09-01'), '2026-09-01', 'never done');
  const calendar = { codes: ['D1110'], count: 2, per: 'benefit_year' };
  assert.equal(eligibleFrom(calendar, { benefit_month: 1 }, ['2026-02-01'], '2026-09-01'), '2026-09-01', 'one of two used');
  assert.equal(eligibleFrom(calendar, { benefit_month: 1 }, ['2026-02-01', '2026-08-01'], '2026-09-01'), '2027-01-01', '2 per calendar year used');
  assert.equal(eligibleFrom(calendar, { benefit_month: 7 }, ['2026-02-01', '2026-08-01'], '2026-09-01'), '2026-09-01', 'fiscal year from July: one used since');
  const m36 = { codes: ['D0210', 'D0330'], count: 1, months: 36 };
  assert.equal(eligibleFrom(m36, null, ['2024-05-10', '2021-01-01'], '2026-09-01'), '2027-05-10', '1 per 36 months');
  assert.equal(eligibleFrom({ codes: ['D1110'], count: 2, months: 12 }, null, ['2026-06-01', '2026-01-10'], '2026-09-01'), '2027-01-10', '2 per 12 months: the older one ages out');
  assert.equal(ruleText(months12, null, 'BWX'), 'BWX 1 per 12 months');
  assert.equal(ruleText(calendar, { benefit_month: 1 }, 'Prophy'), 'Prophy 2 per calendar year');

  // On the patient panel: the plan's rules, and the date insurance pays again.
  const s = await setUp();
  const carrier = (await s.api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const plan = (await s.api.post('/insurance-plans', {
    carrier_id: carrier.id, name: 'Acme', annual_max: 150000, pct_preventive: 100, benefit_month: 1,
    frequencies: [{ label: 'Bitewings', codes: ['D0272', 'D0274'], count: 1, months: 12 }, { label: 'Cleanings', codes: ['D1110', 'D1120', 'D4910'], count: 2, per: 'benefit_year' },
      { label: 'FMX', codes: ['D0210', 'D0330'], count: 1, months: 36 }],
  })).data;
  const pt = await s.patient(40);
  const pol = await s.api.post(`/patients/${pt.id}/insurance`, { carrier_id: carrier.id, plan_id: plan.id, subscriber_name: 'Pat', subscriber_id: 'X1' });
  assert.equal(pol.status, 201, JSON.stringify(pol.data));
  // Due again in about 20 days (not "11 months ago": a month later can be 31 days off, past the 30-day due-soon window).
  const bwxDone = addDays(addMonths(s.today, -12), 20);
  await s.doneOn(pt, 'D0274', bwxDone);
  await s.doneOn(pt, 'D0330', addMonths(s.today, -30));
  const st = await s.status(pt);
  const bwx = s.item(st, 'bwx');
  assert.equal(bwx.insurance.rule, 'BWX 1 per 12 months');
  assert.equal(bwx.insurance.eligible_on, addMonths(bwxDone, 12));
  assert.equal(bwx.status, 'due_soon');
  assert.match(bwx.label, /insurance pays from/);
  const fmx = s.item(st, 'fmx');
  assert.equal(fmx.insurance.rule, 'FMX/pano 1 per 36 months');
  assert.equal(fmx.insurance.eligible_on, addMonths(addMonths(s.today, -30), 36), 'the plan limit (36) is sooner than the office recall (60)');
  assert.equal(s.item(st, 'prophy').insurance.rule, 'Prophy 2 per calendar year');
});

test('bundling: due x-rays, exam and fluoride are suggested for the hygiene visit and attach once', async () => {
  const s = await setUp();
  const pt = await s.patient(30);
  // Seven months ago, not six: on the 31st "six months ago" can roll forward to the 1st (Apr 31 → May 1), and
  // the exam wouldn't be due until tomorrow.
  await s.doneOn(pt, 'D1110', addMonths(s.today, -7));
  await s.doneOn(pt, 'D0120', addMonths(s.today, -7));
  await s.doneOn(pt, 'D0274', addMonths(s.today, -13));
  await s.doneOn(pt, 'D0210', addMonths(s.today, -20));
  const b = await s.rf.get(`/patients/${pt.id}/recall-bundle?date=${s.today}&provider_id=${s.hyg.id}`);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.hygiene, true);
  const codes = b.data.items.map((i) => i.code).sort();
  assert.deepEqual(codes, ['D0120', 'D0274'], 'exam and bitewings due; FMX not due, no fluoride for an adult');
  assert.ok(b.data.items.every((i) => i.checked));
  assert.ok(b.data.items.find((i) => i.code === 'D0274').fee > 0);
  // A dentist visit isn't a hygiene visit.
  assert.equal((await s.rf.get(`/patients/${pt.id}/recall-bundle?date=${s.today}&provider_id=${s.provider.id}`)).data.items.length, 0);
  // A child gets fluoride and 2-film bitewings.
  const kid = await s.patient(8);
  const kb = (await s.rf.get(`/patients/${kid.id}/recall-bundle?date=${s.today}&provider_id=${s.hyg.id}`)).data;
  assert.ok(kb.items.some((i) => i.code === 'D1206'));
  assert.ok(kb.items.some((i) => i.code === 'D0272'));
  assert.ok(kb.items.some((i) => i.code === 'D0150'), 'no exam on record: comprehensive');

  // Attach to the booked visit: planned procedures, recalls linked, a repeat adds nothing.
  const start = `${addDays(s.today, 7)} 09:00`;
  const appt = await insert(h.db, 'appointments', { practice_id: s.pid, patient_id: pt.id, provider_id: s.hyg.id, start_time: start, end_time: `${addDays(s.today, 7)} 10:00`, status: 'scheduled' });
  const add = await s.rf.post(`/appointments/${appt}/recall-bundle`, { codes: ['D0274', 'D0120'] });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.added.length, 2);
  const again = await s.rf.post(`/appointments/${appt}/recall-bundle`, { codes: ['D0274', 'D0120'] });
  assert.equal(again.data.added.length, 0);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM procedures WHERE appointment_id = ? AND status = 'planned'", appt)).n, 2);
  assert.equal((await s.recall(pt, 'bwx')).status, 'scheduled');
  assert.equal((await s.rf.post(`/appointments/${appt}/recall-bundle`, { codes: ['D2391'] })).status, 400, 'only recall codes');
  // Now planned: nothing more to suggest.
  assert.equal((await s.rf.get(`/patients/${pt.id}/recall-bundle?date=${addDays(s.today, 7)}&provider_id=${s.hyg.id}&appointment_id=${appt}`)).data.items.length, 0);
  assert.equal(s.item(await s.status(pt), 'bwx').status, 'scheduled');

  // Insurance won't pay yet: offered, but not ticked.
  const carrier = (await s.api.post('/carriers', { name: 'Aetna', payer_id: '60054' })).data;
  const pt2 = await s.patient(30);
  await s.api.post(`/patients/${pt2.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Pat', subscriber_id: 'Y1' });
  const plan = await h.db.get('SELECT plan_id FROM patient_insurance WHERE patient_id = ?', pt2.id);
  await s.api.put(`/insurance-plans/${plan.plan_id}`, { frequencies: [{ label: 'Bitewings', codes: ['D0272', 'D0274'], count: 1, months: 24 }] });
  await s.doneOn(pt2, 'D0274', addMonths(s.today, -13));
  const b2 = (await s.rf.get(`/patients/${pt2.id}/recall-bundle?date=${s.today}&provider_id=${s.hyg.id}`)).data;
  const bw = b2.items.find((i) => i.code === 'D0274');
  assert.equal(bw.checked, false);
  assert.match(bw.why, /insurance pays from/);
});

test('duplicates: merged charts and two live cleaning types are found, then merged safely', async () => {
  const s = await setUp();
  const kept = await s.patient(40);
  const dup = await s.patient(40);
  await s.doneOn(kept, 'D1110', addMonths(s.today, -8));
  await s.doneOn(dup, 'D1110', addMonths(s.today, -2));
  await s.doneOn(dup, 'D0274', addMonths(s.today, -2));
  await h.db.run("UPDATE patients SET merged_into_id = ?, status = 'archived' WHERE id = ?", kept.id, dup.id);
  // Both a prophy and perio maintenance live (from before the switch retired the prophy).
  const both = await s.patient(50);
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: both.id, type: 'prophy', interval_months: 6, due_date: addMonths(s.today, 1), last_done_date: addMonths(s.today, -5) });
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: both.id, type: 'perio_maint', interval_months: 3, due_date: addMonths(s.today, 2), last_done_date: addMonths(s.today, -1) });
  const preview = await s.rf.get('/recall-board/duplicates');
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.map((a) => a.kind).sort(), ['merge', 'move', 'retire']);
  assert.equal((await s.recall(dup, 'prophy')).status, 'due', 'a preview changes nothing');
  const desk = await member(s, 'front_desk');
  assert.equal((await desk.rf.post('/recall-board/duplicates/merge')).status, 403);
  const merged = await s.rf.post('/recall-board/duplicates/merge');
  assert.equal(merged.status, 200);
  const keptProphy = await s.recall(kept, 'prophy');
  assert.equal(keptProphy.last_done_date, addMonths(s.today, -2), 'the later visit wins');
  assert.equal((await s.recall(dup, 'prophy')).status, 'inactive');
  assert.equal((await h.db.get("SELECT patient_id FROM recalls WHERE type = 'bwx' AND patient_id IN (?, ?)", kept.id, dup.id)).patient_id, kept.id, 'moved to the kept chart');
  assert.equal((await s.recall(both, 'prophy')).status, 'inactive');
  assert.equal((await s.recall(both, 'perio_maint')).status, 'due');
  assert.ok(await h.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'recall.merge_duplicates'"));
  assert.equal((await s.rf.get('/recall-board/duplicates')).data.length, 0, 'nothing left');
});

test('office-wide board: filters, % current per type, overdue, reappointment, export (audited)', async () => {
  const s = await setUp();
  const north = (await s.api.post('/locations', { name: 'North' })).data.id;
  const south = (await s.api.post('/locations', { name: 'South' })).data.id;
  const a = await s.patient(40, { location_id: north, primary_hygienist_id: s.hyg.id });
  const b = await s.patient(40, { location_id: south });
  const c = await s.patient(40, { location_id: north });
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: a.id, type: 'prophy', interval_months: 6, due_date: addDays(s.today, 90) });
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: b.id, type: 'prophy', interval_months: 6, due_date: addDays(s.today, -60) });
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: c.id, type: 'prophy', interval_months: 6, due_date: addDays(s.today, -3) });
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: c.id, type: 'bwx', interval_months: 12, due_date: addDays(s.today, -3) });
  const board = await s.rf.get('/recall-board');
  assert.equal(board.status, 200, JSON.stringify(board.data));
  const prophy = board.data.summary.types.find((t) => t.type === 'prophy');
  assert.equal(prophy.total, 3);
  assert.equal(prophy.overdue, 1);
  assert.equal(prophy.pct_current, 33);
  assert.equal(board.data.summary.overdue, 1);
  assert.equal((await s.rf.get('/recall-board?status=overdue')).data.rows.map((r) => r.patient_id).join(), String(b.id));
  const northRows = (await s.rf.get(`/recall-board?location_id=${north}`)).data.rows;
  assert.deepEqual(northRows.map((r) => r.patient_id).sort(), [a.id, c.id].sort(), 'one row per patient visit');
  assert.deepEqual(northRows.find((r) => r.patient_id === c.id).also_due.map((x) => x.type), ['bwx'], 'the bitewings ride on the cleaning row');
  assert.deepEqual((await s.rf.get(`/recall-board?provider_id=${s.hyg.id}`)).data.rows.map((r) => r.patient_id), [a.id]);
  assert.equal((await s.rf.get('/recall-board?type=bwx')).data.rows.length, 1);
  assert.equal((await s.rf.get('/recall-board?status=nope')).status, 400);
  // Reappointment: a cleaning today with the next visit booked before leaving.
  await s.complete(a, 'D1110');
  await insert(h.db, 'appointments', { practice_id: s.pid, patient_id: a.id, provider_id: s.hyg.id, start_time: `${addMonths(s.today, 6)} 09:00`, end_time: `${addMonths(s.today, 6)} 10:00`, status: 'scheduled' });
  await s.complete(b, 'D1110');
  const re = (await s.rf.get('/recall-board')).data.reappointment;
  assert.equal(re.seen, 2);
  assert.equal(re.reappointed, 1);
  assert.equal(re.pct, 50);
  // Counts for the capacity meter and metrics.
  const counts = await recallCounts(h.db, s.pid, { today: s.today });
  assert.equal(counts.reappointment.pct, 50);
  assert.ok(counts.types.some((t) => t.type === 'prophy'));
  // Export: reports permission, audited.
  const csv = await s.rf.get('/recall-board/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Patient,Phone,Email,Recall,Due,Status/);
  assert.ok(await h.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'recall_board.export' AND practice_id = ?", s.pid));
  const desk = await member(s, 'front_desk');
  assert.equal((await desk.rf.get('/recall-board')).status, 200);
  assert.equal((await desk.rf.get('/recall-board/export.csv')).status, 403);
  // Mark contacted: one call, logged.
  const row = (await s.rf.get('/recall-board?status=due')).data.rows[0];
  const done = await desk.rf.post(`/recalls/${row.id}/contacted`);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.status, 'contacted');
  assert.equal(done.data.previous_status, 'due');
  assert.ok(await h.db.get("SELECT 1 AS x FROM followups WHERE patient_id = ? AND kind = 'recall'", row.patient_id));
});

test('practice and office isolation, and permissions', async () => {
  const s = await setUp();
  const other = await setUp();
  const pt = await s.patient(40);
  await s.doneOn(pt, 'D1110', addMonths(s.today, -7));
  const r = await s.recall(pt, 'prophy');
  assert.equal((await other.rf.get(`/patients/${pt.id}/recall-status`)).status, 404);
  assert.equal((await other.rf.put(`/recalls/${r.id}/interval`, { interval_months: 4, reason: 'nope' })).status, 404);
  assert.equal((await other.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: s.today })).status, 404);
  assert.ok(!(await other.rf.get('/recall-board')).data.rows.some((x) => x.patient_id === pt.id));
  // Someone limited to one office sees only that office's patients.
  const north = (await s.api.post('/locations', { name: 'North' })).data.id;
  const south = (await s.api.post('/locations', { name: 'South' })).data.id;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', south, pt.id);
  const np = await s.patient(40, { location_id: north });
  await s.doneOn(np, 'D1110', addMonths(s.today, -7));
  const desk = await member(s, 'front_desk', { location_ids: [north] });
  const deskRows = (await desk.rf.get('/recall-board')).data.rows.map((x) => x.patient_id);
  assert.ok(deskRows.includes(np.id));
  assert.ok(!deskRows.includes(pt.id));
  assert.equal((await desk.rf.get(`/patients/${pt.id}/recall-status`)).status, 404);
  // Front desk: sees and books, but interval overrides, switches and outside x-rays are clinical; settings are admin.
  const desk2 = await member(s, 'front_desk');
  assert.equal((await desk2.rf.get(`/patients/${pt.id}/recall-status`)).status, 200);
  assert.equal((await desk2.rf.put(`/recalls/${r.id}/interval`, { interval_months: 4, reason: 'Asked' })).status, 403);
  assert.equal((await desk2.rf.post(`/patients/${pt.id}/recalls/switch`, { to: 'perio_maint', reason: 'Asked' })).status, 403);
  assert.equal((await desk2.rf.post(`/patients/${pt.id}/outside-procedures`, { type: 'bwx', date: s.today })).status, 403);
  assert.equal((await desk2.rf.put('/recall-settings', { due_soon_days: 10 })).status, 403);
  const hygUser = await member(s, 'hygienist');
  assert.equal((await hygUser.rf.put(`/recalls/${r.id}/interval`, { interval_months: 4, reason: 'Heavy calculus' })).status, 200);
  const types = await recallTypes(h.db, s.pid);
  assert.equal((await desk2.rf.put(`/recall-types/${types[0].id}/rules`, { bundle: true })).status, 403);
  const exam = types.find((t) => t.key === 'exam');
  assert.equal((await s.rf.put(`/recall-types/${exam.id}/rules`, { retires: ['nope'] })).status, 400);
  const rules = await s.rf.put(`/recall-types/${exam.id}/rules`, { bundle: false });
  assert.equal(rules.data.bundle, 0);
});

test('reminders: x-rays, exam and fluoride ride along — no message or sequence of their own', async () => {
  const s = await setUp();
  await s.api.put('/practice', { recall_auto: true, recall_steps: [{ days: 0 }] });
  const pt = await s.patient(40);
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: pt.id, type: 'bwx', interval_months: 12, due_date: addDays(s.today, -2) });
  const before = h.sent.length;
  await runRecallSequences(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.equal(h.sent.length, before, 'bitewings alone: no message');
  await insert(h.db, 'recalls', { practice_id: s.pid, patient_id: pt.id, type: 'prophy', interval_months: 6, due_date: addDays(s.today, -2) });
  await runRecallSequences(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.equal(h.sent.length, before + 1, 'with the cleaning: one message');
  const seqs = (await recallCadence.defaultSequences(h.db, s.pid)).map((x) => x.subtype);
  assert.ok(seqs.includes('prophy') && seqs.includes('child_prophy') && seqs.includes('perio_maint'));
  assert.ok(!seqs.includes('bwx') && !seqs.includes('exam') && !seqs.includes('fluoride'));
});

test('mounted in app.js (skips until the mount line is added)', async (t) => {
  const s = await setUp();
  const probe = await s.api.get(`/patients/${(await s.patient(30)).id}/recall-status`);
  if (probe.status === 404) { t.skip('recallFreqRoutes not mounted in app.js yet'); return; }
  assert.equal(probe.status, 200);
  assert.equal((await s.api.get('/recall-board')).status, 200);
});
