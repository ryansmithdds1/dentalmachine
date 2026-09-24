// Patient preferences (PP1), personal connection notes (PP2), the doctor's notes on the schedule (DN1), "we moved
// them" strikes and the provider-out tool (S8), and customizable appointment cards (S6).
// docs/workflows/specs/PP-DN-S8-S6.md. The new routers are served in front of the harness's app the way app.js
// will mount them (authenticate → actor → office access → routes), so these run whether or not app.js has them yet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError, signToken, hashPassword } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, practiceNow, addMonths } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { listen, unlisten } from '../src/cluster.js';
import cardRoutes from '../src/routes/cards.js';
import doctorNoteRoutes from '../src/routes/doctornotes.js';
import officeMoveRoutes from '../src/routes/officemoves.js';
import { cleanLayout, DEFAULT_LAYOUT, strikeWarning, apologyText } from '../src/cards.js';

const h = harness();
let server;
let mine; // this file's server (the harness sets its own origin in its before hook, which may run after ours)
const OURS = /^\/(preference-options|patient-preferences|personal-notes|schedule-cards|card-layout|me\/card-layout|schedule-notes|office-reasons|office-moves|provider-out)(\/|$)|^\/patients\/\d+\/(preferences|personal-notes|connection|office-moves)$|^\/appointments\/\d+\/(labels|office-move)$/;
before(async () => {
  const db = {
    all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
    get dialect() { return h.db.dialect; },
  };
  const outer = express();
  outer.use(actorMiddleware(db, flushChanges));
  const api = express.Router();
  api.use(express.json());
  api.use(authenticate(db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(db));
  api.use(cardRoutes({ db }));
  api.use(doctorNoteRoutes({ db }));
  // The harness makes its messenger and config in its own before hook: reach them when used.
  const messenger = { send: (m) => h.messenger.send(m), get status() { return h.messenger.status; } };
  const config = { get appUrl() { return h.config.appUrl; } };
  api.use(officeMoveRoutes({ db, messenger, config }));
  outer.use('/api', (req, res, next) => (OURS.test(req.path) ? api(req, res, next) : next()));
  outer.use((req, res, next) => h.app(req, res, next));
  // eslint-disable-next-line no-unused-vars
  outer.use((err, _req, res, _next) => { if (!(err instanceof HttpError)) console.error(err); res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, ...(err.details || {}) }); });
  await new Promise((resolve) => { server = outer.listen(0, resolve); });
  mine = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const ALWAYS = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['07:00', '19:00']]]));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// A signed-in person with a role (made directly: signing in through /auth for every test would hit its rate limit).
async function tokenFor(pid, role, name) {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const id = (await h.db.run('INSERT INTO users (practice_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)', pid, email, name, role, hashPassword('unused-password-1'))).id;
  const sid = `test-${Math.random().toString(36).slice(2)}`;
  await h.db.run('INSERT INTO staff_sessions (sid, user_id, practice_id, last_seen_at) VALUES (?, ?, ?, ?)', sid, id, pid, new Date().toISOString());
  const token = signToken({ sub: id, pid, role, aud: 'staff', tv: 0, sid }, 'test-secret');
  return { api: h.client(token), id, token };
}

// A practice with an admin, a dentist user, a front desk user and a billing user; two chairs; office open every day.
async function setUp() {
  h.origin = mine;
  const p = await h.practice({ timezone: 'UTC', office_hours: ALWAYS });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const day = addDays(today, 7);
  const chairs = [(await p.api.post('/operatories', { name: 'Op 1' })).data, (await p.api.post('/operatories', { name: 'Op 2' })).data];
  const login = async (role) => tokenFor(pid, role, `${role} person`);
  const [doc, desk, biller] = [await login('dentist'), await login('front_desk'), await login('billing')];
  const newPatient = async (first) => (await p.api.post('/patients', { first_name: first, last_name: 'Cards', dob: '1990-05-06', phone: '(512) 555-0199' })).data;
  const book = async (patient, time, { chair = chairs[0], provider = p.provider, minutes = 60, date = day, extra = {} } = {}) => {
    const [hh, mm] = time.split(':').map(Number);
    const e = hh * 60 + mm + minutes;
    const r = await p.api.post('/appointments', {
      patient_id: patient.id, provider_id: provider.id, operatory_id: chair.id, start_time: `${date} ${time}`,
      end_time: `${date} ${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`, notify: false, ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const audits = (action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', pid, action);
  return { ...p, pid, today, day, chairs, doc, desk, biller, newPatient, book, audits };
}

// ======================= PP1 =======================
test('preferences: starter list, add urgent (twice = once), shown on the card and patient bar, change, soft remove, all audited', async () => {
  const s = await setUp();
  const opts = (await s.api.get('/preference-options')).data;
  assert.ok(opts.length >= 11, 'the starter set is there on first read');
  assert.deepEqual(opts.slice(0, 3).map((o) => o.label), ['Pillow behind the neck', 'Blanket', 'Headphones / music']);
  assert.equal((await s.api.get('/preference-options')).data.length, opts.length, 'reading again adds nothing');
  const blanket = opts.find((o) => o.label === 'Blanket');
  const pt = await s.newPatient('Paula');
  const a = await s.book(pt, '09:00');

  const add = await s.desk.api.post(`/patients/${pt.id}/preferences`, { option_id: blanket.id, urgent: true });
  assert.equal(add.status, 201);
  assert.equal(add.data.urgent, 1);
  const again = await s.desk.api.post(`/patients/${pt.id}/preferences`, { option_id: blanket.id, urgent: true });
  assert.equal(again.status, 200, 'a double click adds nothing');
  assert.equal(again.data.id, add.data.id);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM patient_prefs WHERE patient_id = ? AND status = 'active'", pt.id)).n, 1);
  await s.desk.api.post(`/patients/${pt.id}/preferences`, { option_id: opts.find((o) => o.label === 'Sunglasses').id });

  const cards = (await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data;
  const mine = cards.by_appt[a.id];
  assert.deepEqual(mine.prefs.filter((x) => x.urgent).map((x) => x.label), ['Blanket'], 'urgent ones come first, flagged');
  assert.equal(mine.prefs.length, 2);
  const bar = (await s.desk.api.get(`/patients/${pt.id}/connection`)).data;
  assert.equal(bar.prefs.find((x) => x.urgent).label, 'Blanket');

  const off = await s.desk.api.put(`/patient-preferences/${add.data.id}`, { urgent: false, note: 'the heavy one' });
  assert.equal(off.data.urgent, 0);
  assert.equal(off.data.note, 'the heavy one');
  const rm = await s.desk.api.post(`/patient-preferences/${add.data.id}/remove`, { reason: 'Not needed any more' });
  assert.equal(rm.status, 200);
  const row = await h.db.get('SELECT * FROM patient_prefs WHERE id = ?', add.data.id);
  assert.equal(row.status, 'removed', 'kept, marked removed');
  assert.equal(row.remove_reason, 'Not needed any more');
  assert.equal((await s.desk.api.get(`/patients/${pt.id}/preferences`)).data.length, 1);
  // Adding it back makes a new row (the removed one stays in history).
  assert.equal((await s.desk.api.post(`/patients/${pt.id}/preferences`, { option_id: blanket.id })).status, 201);

  const added = await s.audits('patient_preference.add');
  assert.equal(added.length, 3);
  assert.equal(added[0].patient_id, pt.id);
  assert.equal(added[0].user_id, s.desk.id);
  const changed = (await s.audits('patient_preference.change'))[0];
  assert.deepEqual(JSON.parse(changed.changes).urgent, [1, 0], 'before → after');
  assert.equal((await s.audits('patient_preference.remove'))[0].reason, 'Not needed any more');
});

test('preferences: the office adds its own (administrators), retires them; permissions', async () => {
  const s = await setUp();
  assert.equal((await s.desk.api.post('/preference-options', { label: 'Likes the window chair' })).status, 403, 'only an administrator changes the list');
  const own = await s.api.post('/preference-options', { label: 'Likes the window chair', category: 'comfort' });
  assert.equal(own.status, 201);
  assert.equal((await s.api.post('/preference-options', { label: 'likes the window chair' })).data.id, own.data.id, 'the same name twice is one');
  assert.equal((await s.api.post('/preference-options', { label: 'x', category: 'nonsense' })).status, 400);
  const pt = await s.newPatient('Wendy');
  assert.equal((await s.biller.api.post(`/patients/${pt.id}/preferences`, { option_id: own.data.id })).status, 403, 'billing can’t change patient preferences');
  await s.api.put(`/preference-options/${own.data.id}`, { active: false });
  assert.ok(!(await s.api.get('/preference-options')).data.some((o) => o.id === own.data.id), 'retired: off the list');
  assert.ok((await s.api.get('/preference-options?all=1')).data.some((o) => o.id === own.data.id && o.retired_at), 'kept with when');
  assert.equal((await s.desk.api.post(`/patients/${pt.id}/preferences`, { option_id: own.data.id })).status, 409);
  assert.equal((await s.audits('preference_option.retire')).length, 1);
});

// ======================= PP2 =======================
test('personal notes: timeline with who and when, latest shown, retry-safe, soft remove with history', async () => {
  const s = await setUp();
  const pt = await s.newPatient('Nora');
  const a = await s.book(pt, '10:00');
  const one = await s.desk.api.post(`/patients/${pt.id}/personal-notes`, { body: 'Went to Disneyland', client_key: 'k-1' });
  assert.equal(one.status, 201);
  assert.equal((await s.desk.api.post(`/patients/${pt.id}/personal-notes`, { body: 'Went to Disneyland', client_key: 'k-1' })).data.id, one.data.id, 'a retry is the same note');
  await h.db.run("UPDATE personal_notes SET created_at = '2020-01-01 00:00:00' WHERE id = ?", one.data.id);
  const two = await s.doc.api.post(`/patients/${pt.id}/personal-notes`, { body: 'New dog — a beagle called Max' });
  assert.equal((await s.desk.api.post(`/patients/${pt.id}/personal-notes`, { body: '   ' })).status, 400);
  const list = (await s.desk.api.get(`/patients/${pt.id}/personal-notes`)).data;
  assert.deepEqual(list.map((n) => n.body), ['New dog — a beagle called Max', 'Went to Disneyland'], 'newest first');
  assert.equal(list[0].by_name, 'dentist person');
  assert.ok(list[0].created_at);
  assert.equal((await s.desk.api.get(`/patients/${pt.id}/connection`)).data.personal.body, 'New dog — a beagle called Max');
  assert.equal((await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id].personal.body, 'New dog — a beagle called Max', 'on the seated card');

  const rm = await s.desk.api.post(`/personal-notes/${two.data.id}/remove`, { reason: 'Wrong patient' });
  assert.equal(rm.status, 200);
  assert.equal((await s.desk.api.get(`/patients/${pt.id}/connection`)).data.personal.body, 'Went to Disneyland', 'the one before shows again');
  const all = (await s.desk.api.get(`/patients/${pt.id}/personal-notes?all=1`)).data;
  assert.equal(all.length, 2, 'never deleted');
  assert.ok(all.find((n) => n.id === two.data.id).removed_at);
  assert.equal(all.find((n) => n.id === two.data.id).removed_by_name, 'front_desk person');
  assert.equal((await s.audits('personal_note.remove'))[0].reason, 'Wrong patient');
  assert.equal((await s.audits('personal_note.add')).length, 2);
  assert.equal((await s.biller.api.post(`/patients/${pt.id}/personal-notes`, { body: 'x' })).status, 403);
});

// ======================= DN1 =======================
test('doctor’s notes: on a slot and on a visit, live to the front desk, acknowledged, turned into a task or a booking', async () => {
  const s = await setUp();
  const events = [];
  const hear = (e) => events.push(e);
  listen(`practice:${s.pid}`, hear);
  try {
    const slot = await s.doc.api.post('/schedule-notes', { date: s.day, start_time: '14:00', end_time: '15:00', operatory_id: s.chairs[1].id, body: 'I have time 2–3 pm — fit an emergency', client_key: 'dn-1' });
    assert.equal(slot.status, 201, JSON.stringify(slot.data));
    assert.equal(slot.data.by, 'dentist person');
    assert.equal(slot.data.status, 'open');
    assert.equal((await s.doc.api.post('/schedule-notes', { date: s.day, start_time: '14:00', end_time: '15:00', body: 'x', client_key: 'dn-1' })).data.id, slot.data.id, 'retry-safe');
    const live = events.find((e) => e.type === 'doctor_note' && e.what === 'new');
    assert.ok(live, 'the front desk hears it straight away');
    assert.deepEqual(live.dates, [s.day]);
    assert.equal(live.by_name, 'dentist person');
    assert.equal((await s.doc.api.post('/schedule-notes', { date: s.day, start_time: '15:00', end_time: '14:00', body: 'x' })).status, 400);
    assert.equal((await s.biller.api.post('/schedule-notes', { date: s.day, start_time: '09:00', end_time: '10:00', body: 'x' })).status, 403);

    // On the card data, as a slot note.
    const cards = (await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data;
    assert.equal(cards.slot_notes[0].body, 'I have time 2–3 pm — fit an emergency');

    const ack = await s.desk.api.post(`/schedule-notes/${slot.data.id}/ack`);
    assert.equal(ack.data.status, 'acknowledged');
    assert.equal(ack.data.acked_by, 'front_desk person');
    // "Book it": the booking form gets the slot; booking into it closes the note.
    const conv = await s.desk.api.post(`/schedule-notes/${slot.data.id}/convert`, { kind: 'booking' });
    assert.deepEqual([conv.data.book.date, conv.data.book.start_time, conv.data.book.operatory_id], [s.day, '14:00', s.chairs[1].id]);
    const emergency = await s.newPatient('Ella');
    const booked = await s.book(emergency, '14:00', { chair: s.chairs[1], minutes: 30 });
    const closed = await h.db.get('SELECT * FROM schedule_notes WHERE id = ?', slot.data.id);
    assert.equal(closed.status, 'done');
    assert.deepEqual([closed.result_kind, closed.result_id], ['appointment', booked.id]);

    // On a visit: "book crown next" → a task in one click; asking twice gives the same task.
    const pt = await s.newPatient('Carl');
    const a = await s.book(pt, '09:00');
    const vn = await s.doc.api.post('/schedule-notes', { appointment_id: a.id, body: 'Book crown #30 next — 90 min' });
    assert.equal(vn.data.kind, 'visit');
    assert.equal((await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id].notes[0].body, 'Book crown #30 next — 90 min');
    const task = await s.desk.api.post(`/schedule-notes/${vn.data.id}/convert`, { kind: 'task' });
    assert.equal(task.data.result_kind, 'task');
    const t = await h.db.get('SELECT * FROM tasks WHERE id = ?', task.data.result_id);
    assert.equal(t.patient_id, pt.id);
    assert.match(t.title, /Book crown #30 next/);
    const twice = await s.desk.api.post(`/schedule-notes/${vn.data.id}/convert`, { kind: 'task' });
    assert.equal(twice.data.result_id, task.data.result_id);
    assert.equal(twice.data.already, true);
    assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE patient_id = ?', pt.id)).n, 1);
    assert.deepEqual((await s.desk.api.get(`/schedule-notes?date=${s.day}`)).data, [], 'handled notes leave the schedule');

    // Withdraw: only the author (or an administrator).
    const n3 = await s.doc.api.post('/schedule-notes', { date: s.day, start_time: '16:00', end_time: '16:30', body: 'Quick filling here?' });
    assert.equal((await s.desk.api.post(`/schedule-notes/${n3.data.id}/withdraw`)).status, 403);
    assert.equal((await s.doc.api.post(`/schedule-notes/${n3.data.id}/withdraw`)).data.status, 'withdrawn');
    assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schedule_notes WHERE practice_id = ?', s.pid)).n, 3, 'never deleted');
    for (const act of ['schedule_note.create', 'schedule_note.ack', 'schedule_note.done', 'schedule_note.withdraw']) assert.ok((await s.audits(act)).length, act);
  } finally {
    unlisten(`practice:${s.pid}`, hear);
  }
});

// ======================= S8 =======================
test('office moves: whose reason on move and cancel, strikes over 12 months, the warning, after-the-fact, void', async () => {
  const s = await setUp();
  const pt = await s.newPatient('Maria');
  const a = await s.book(pt, '09:00');
  // Moved by the office (from the move request itself).
  const moved = await s.api.put(`/appointments/${a.id}`, { start_time: `${s.day} 11:00`, end_time: `${s.day} 12:00`, moved_by: 'office', office_reason: 'equipment_down', notify: false });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  let row = await h.db.get('SELECT moved_by, office_reason FROM appointments WHERE id = ?', a.id);
  assert.deepEqual([row.moved_by, row.office_reason], ['office', 'equipment_down']);
  // Cancelled with "We had to move it" + the office's reason (as the cancel picker sends it).
  const b = await s.book(pt, '09:00', { date: addDays(s.day, 1) });
  const cx = await s.api.patch(`/appointments/${b.id}/status`, { status: 'cancelled', broken_reason: 'office', broken_note: 'Provider sick' });
  assert.equal(cx.status, 200);
  row = await h.db.get('SELECT moved_by, office_reason FROM appointments WHERE id = ?', b.id);
  assert.deepEqual([row.moved_by, row.office_reason], ['office', 'provider_sick']);
  // A patient's own reason isn't a strike.
  const c = await s.book(pt, '13:00', { date: addDays(s.day, 2) });
  await s.api.patch(`/appointments/${c.id}/status`, { status: 'cancelled', broken_reason: 'conflict' });
  assert.equal((await h.db.get('SELECT moved_by FROM appointments WHERE id = ?', c.id)).moved_by, 'patient');
  // An office move 13 months ago no longer counts.
  const old = await s.book(pt, '15:00', { date: addDays(s.day, 3) });
  await h.db.run("INSERT INTO office_moves (practice_id, appointment_id, patient_id, provider_id, kind, reason, from_time, happened_on) VALUES (?, ?, ?, ?, 'move', 'emergency', '2020-01-01 09:00', ?)",
    s.pid, old.id, pt.id, s.provider.id, addMonths(s.today, -13));

  const conn = (await s.desk.api.get(`/patients/${pt.id}/connection`)).data;
  assert.equal(conn.strikes.count, 2, 'two office moves in 12 months');
  assert.deepEqual(conn.strikes.list.map((x) => x.reason_label).sort(), ['Equipment down', 'Provider sick']);
  assert.match(conn.strike_warning, /^We moved Maria today \(2× in 12 months\)/);
  const cards = (await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data;
  assert.equal(cards.by_appt[a.id].strikes.count, 2, 'the badge on the card');

  // Dragged somewhere else, then "that was us" — once, however many clicks.
  const d = await s.book(pt, '09:00', { date: addDays(s.day, 4) });
  assert.equal((await s.desk.api.post(`/appointments/${d.id}/office-move`, { reason: 'emergency' })).status, 409, 'not moved yet');
  await s.desk.api.put(`/appointments/${d.id}/`.replace(/\/$/, ''), { start_time: `${addDays(s.day, 4)} 10:00`, end_time: `${addDays(s.day, 4)} 11:00`, notify: false });
  const after1 = await s.desk.api.post(`/appointments/${d.id}/office-move`, { reason: 'double_booked' });
  assert.equal(after1.status, 201, JSON.stringify(after1.data));
  assert.equal(after1.data.strikes.count, 3);
  assert.equal((await s.desk.api.post(`/appointments/${d.id}/office-move`, { reason: 'double_booked' })).status, 200, 'a second click adds nothing');
  assert.equal((await s.desk.api.post(`/appointments/${d.id}/office-move`, { reason: 'other' })).status, 400, 'other needs a few words');
  assert.equal((await s.audits('appointment.office_move')).length, 1);

  // Recorded by mistake: voided (kept), no longer counted.
  const hist = (await s.desk.api.get(`/patients/${pt.id}/office-moves`)).data;
  assert.equal(hist.moves.length, 4, 'everything, the old one too');
  assert.equal((await s.desk.api.post(`/office-moves/${after1.data.id}/void`, {})).status, 400, 'a reason is required');
  assert.equal((await s.desk.api.post(`/office-moves/${after1.data.id}/void`, { reason: 'It was the patient who asked' })).status, 200);
  assert.equal((await s.desk.api.get(`/patients/${pt.id}/connection`)).data.strikes.count, 2);
  assert.ok(await h.db.get('SELECT voided_at FROM office_moves WHERE id = ? AND voided_at IS NOT NULL', after1.data.id));
  assert.equal((await s.audits('office_move.void'))[0].reason, 'It was the patient who asked');

  // The report by reason and provider (practice reports permission).
  const rep = (await s.api.get(`/office-moves/report?from=${addMonths(s.today, -1)}&to=${addDays(s.today, 1)}`)).data;
  assert.equal(rep.total, 2);
  assert.deepEqual(rep.by_reason.map((x) => x.label).sort(), ['Equipment down', 'Provider sick']);
  assert.equal(rep.by_provider[0].total, 2);
  assert.equal((await s.desk.api.get('/office-moves/report')).status, 403);
  assert.match((await s.api.get('/office-moves/report?format=csv')).data, /Date,Kind,Reason/);
  assert.equal(strikeWarning('Al', null), null);
});

test('provider out today: keep with another provider who has room, reschedule those with no recent strikes first, apology text, retry-safe, the assistant needs a yes', async () => {
  const s = await setUp();
  const other = (await s.api.post('/providers', { name: 'Dr. Ben Ortiz, DDS', type: 'dentist' })).data;
  await s.api.post('/providers', { name: 'Hana Hygienist, RDH', type: 'hygienist' });
  const struck = await s.newPatient('Stella');
  const fresh = await s.newPatient('Frank');
  const sole = await s.newPatient('Solo');
  // Stella was moved by us before; Frank never. Their visits overlap (Dr. Lee's own time doesn't: the second half of
  // each is assistant time), so the one other dentist can only take one of them.
  const before1 = await s.book(struck, '08:00', { date: addDays(s.day, -3) });
  await s.api.patch(`/appointments/${before1.id}/status`, { status: 'cancelled', broken_reason: 'office', broken_note: 'Emergency' });
  const vFresh = await s.book(fresh, '09:00', { chair: s.chairs[0], extra: { pattern: 'XXX///' } });
  const vStruck = await s.book(struck, '09:30', { chair: s.chairs[1], extra: { pattern: 'XXX///' } });
  const vSole = await s.book(sole, '11:00', { chair: s.chairs[0] });
  await s.api.put('/practice', { online_booking: true, slug: `cards-${s.pid}` });

  const plan = (await s.desk.api.get(`/provider-out?provider_id=${s.provider.id}&date=${s.day}`)).data;
  assert.equal(plan.visits.length, 3);
  const byId = Object.fromEntries(plan.visits.map((v) => [v.appointment_id, v]));
  assert.equal(byId[vStruck.id].suggestion, 'keep', 'the patient we already moved keeps their time');
  assert.equal(byId[vStruck.id].keep_with.id, other.id, 'with the other dentist, not the hygienist');
  assert.equal(byId[vFresh.id].suggestion, 'reschedule', 'no recent strikes: asked to move');
  assert.equal(byId[vSole.id].suggestion, 'keep');
  assert.equal(plan.rebook_link, `https://app.example.com/book/cards-${s.pid}`);

  const visits = plan.visits.map((v) => ({ appointment_id: v.appointment_id, action: v.suggestion, provider_id: v.keep_with?.id }));
  const body = { provider_id: s.provider.id, date: s.day, reason: 'provider_sick', goodwill_note: 'Your next cleaning is on us.', client_key: 'out-1', visits };
  // The assistant can plan it but not do it without the person's yes.
  const ai = h.client(s.token, { 'X-Acting-For': 'assistant' });
  const refused = await ai.post('/provider-out', body);
  assert.equal(refused.status, 428);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM provider_out_runs WHERE practice_id = ?', s.pid)).n, 0);

  const sentBefore = h.sent.length;
  const run = await h.client(s.token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }).post('/provider-out', body);
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.deepEqual([run.data.kept, run.data.rescheduled, run.data.failed], [2, 1, 0]);
  const kept = await h.db.get('SELECT provider_id, status, start_time FROM appointments WHERE id = ?', vStruck.id);
  assert.deepEqual([kept.provider_id, kept.status, kept.start_time], [other.id, 'scheduled', `${s.day} 09:30`]);
  const cancelled = await h.db.get('SELECT * FROM appointments WHERE id = ?', vFresh.id);
  assert.deepEqual([cancelled.status, cancelled.broken_reason, cancelled.moved_by, cancelled.office_reason], ['cancelled', 'office', 'office', 'provider_sick']);
  const texts = h.sent.slice(sentBefore);
  assert.equal(texts.length, 3, 'an apology to the one rescheduled, a heads-up to the two kept');
  const apology = texts.find((m) => /so sorry/.test(m.body));
  assert.match(apology.body, /Hi Frank/);
  assert.match(apology.body, /Dr\. Ann Lee, DDS is out sick/);
  assert.match(apology.body, /Your next cleaning is on us\./);
  assert.match(apology.body, new RegExp(`/book/cards-${s.pid}`));
  const task = await h.db.get('SELECT * FROM tasks WHERE patient_id = ?', fresh.id);
  assert.match(task.title, /^Rebook Frank/);
  // Strikes: Frank now has one (the cancel); Stella's reassign isn't one.
  const strikes = Object.fromEntries((await h.db.all("SELECT patient_id, COUNT(*) AS n FROM office_moves WHERE practice_id = ? AND kind IN ('move','cancel') GROUP BY patient_id", s.pid)).map((r) => [r.patient_id, Number(r.n)]));
  assert.deepEqual([strikes[fresh.id], strikes[struck.id]], [1, 1]);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM office_moves WHERE kind = 'reassign' AND run_id = ?", run.data.run_id)).n, 2);
  const runAudit = (await s.audits('provider_out.run'))[0];
  assert.equal(runAudit.source, 'ai');
  assert.match(runAudit.actor, /approved by/);

  // A retry (same click) moves nobody twice and texts nobody twice.
  const retry = await s.api.post('/provider-out', body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.already, true);
  assert.equal(retry.data.run_id, run.data.run_id);
  assert.equal(h.sent.length, sentBefore + 3);
  assert.equal((await s.biller.api.post('/provider-out', { ...body, client_key: 'out-2' })).status, 403, 'billing can’t move visits');
  assert.match(apologyText({ patient: { first_name: 'A' }, practice: { name: 'P' }, visit: { start_time: '2030-01-02 14:30' }, reason: 'emergency' }), /2:30 PM/);
});

// ======================= S6 =======================
test('card layouts: the default reproduces today’s card; the office’s layout (administrators), a personal override, validation', async () => {
  const s = await setUp();
  const def = (await s.desk.api.get('/card-layout')).data;
  assert.equal(def.is_default, true);
  assert.deepEqual(def.effective, DEFAULT_LAYOUT);
  assert.deepEqual(def.effective.lines[1].slice(0, 2), ['time', 'visit_type']);
  assert.ok(def.items.includes('birthday') && def.items.includes('forms'));

  const office = { ...DEFAULT_LAYOUT, lines: [['name', 'age', 'birthday', 'new_patient'], ['time', 'visit_type'], ['balance', 'labels']], labels: [{ text: 'VIP', color: '#dc2626' }] };
  assert.equal((await s.desk.api.put('/card-layout', { layout: office })).status, 403, 'only administrators set the office’s layout');
  const saved = await s.api.put('/card-layout', { layout: office });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.effective.lines[0], ['name', 'age', 'birthday', 'new_patient']);
  assert.deepEqual(saved.data.effective.labels, [{ key: 'vip', text: 'VIP', color: '#dc2626' }]);
  assert.equal((await s.audits('card_layout.change')).length, 1);
  assert.equal((await s.desk.api.get('/card-layout')).data.effective.lines[0][1], 'age', 'everyone gets it');

  // A person's own layout wins for them; the office's labels still apply.
  const mine = await s.desk.api.put('/me/card-layout', { layout: { lines: [['name', 'time']] } });
  assert.deepEqual(mine.data.effective.lines, [['name', 'time']]);
  assert.equal(mine.data.effective.labels[0].key, 'vip');
  assert.deepEqual((await s.api.get('/card-layout')).data.effective.lines[0], ['name', 'age', 'birthday', 'new_patient'], 'not for anyone else');
  const cards = (await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data;
  assert.equal(cards.own_layout, true);
  await s.desk.api.put('/me/card-layout', { layout: null });
  assert.equal((await s.desk.api.get('/card-layout')).data.mine, null, 'back to the office’s');

  for (const bad of [{ lines: [['name', 'bogus']] }, { lines: [['name'], ['name']] }, { lines: [] }, { lines: [['name']], color_by: 'rainbow' }, { lines: [['name']], compact: { max_minutes: 5 } }]) {
    assert.equal((await s.api.put('/card-layout', { layout: bad })).status, 400, JSON.stringify(bad));
  }
  assert.throws(() => cleanLayout({ lines: [['name']], labels: [{ text: 'A' }, { text: 'a' }] }), /twice|called/);

  // Office labels on a visit: only the office's own, taken off without deleting.
  const pt = await s.newPatient('Lara');
  const a = await s.book(pt, '09:00');
  assert.equal((await s.desk.api.post(`/appointments/${a.id}/labels`, { label_key: 'nope' })).status, 400);
  assert.deepEqual((await s.desk.api.post(`/appointments/${a.id}/labels`, { label_key: 'vip' })).data.labels, ['vip']);
  assert.deepEqual((await s.desk.api.post(`/appointments/${a.id}/labels`, { label_key: 'vip' })).data.labels, ['vip'], 'twice is once');
  assert.deepEqual((await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id].labels, ['vip']);
  assert.deepEqual((await s.desk.api.post(`/appointments/${a.id}/labels`, { label_key: 'vip', on: false })).data.labels, []);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM appointment_labels WHERE appointment_id = ?', a.id)).n, 1);
});

test('card data: balance only for people who may see money, new patient, month limit', async () => {
  const s = await setUp();
  const pt = await s.newPatient('Newt');
  const a = await s.book(pt, '09:00');
  const desk = (await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id];
  assert.equal(desk.new_patient, true);
  assert.equal(desk.balance, 0, 'front desk sees billing');
  const doc = (await s.doc.api.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id];
  assert.equal(doc.balance, 0, 'the dentist role reads billing too');
  const asst = (await tokenFor(s.pid, 'assistant', 'Asst')).api;
  assert.equal((await asst.get(`/schedule-cards?from=${s.day}&to=${s.day}`)).data.by_appt[a.id].balance, undefined, 'no money for an assistant');
  assert.equal((await s.desk.api.get(`/schedule-cards?from=${s.day}&to=${addDays(s.day, 40)}`)).status, 400);
  assert.equal((await s.desk.api.get('/schedule-cards?from=2026-02-31')).status, 400);
});

// ======================= isolation =======================
test('practice isolation: another practice sees and changes none of it', async () => {
  const a = await setUp();
  const b = await setUp();
  const pt = await a.newPatient('Iris');
  const appt = await a.book(pt, '09:00');
  const opt = (await a.api.get('/preference-options')).data[0];
  const pref = (await a.api.post(`/patients/${pt.id}/preferences`, { option_id: opt.id, urgent: true })).data;
  const note = (await a.api.post(`/patients/${pt.id}/personal-notes`, { body: 'Loves hiking' })).data;
  const dn = (await a.doc.api.post('/schedule-notes', { appointment_id: appt.id, body: 'Needs 90 min' })).data;
  await a.api.put(`/appointments/${appt.id}`, { start_time: `${a.day} 10:00`, end_time: `${a.day} 11:00`, moved_by: 'office', office_reason: 'emergency', notify: false });
  const mv = await h.db.get('SELECT id FROM office_moves WHERE appointment_id = ?', appt.id);

  for (const path of [`/patients/${pt.id}/preferences`, `/patients/${pt.id}/personal-notes`, `/patients/${pt.id}/connection`, `/patients/${pt.id}/office-moves`]) {
    assert.equal((await b.api.get(path)).status, 404, path);
  }
  assert.equal((await b.api.post(`/patients/${pt.id}/preferences`, { option_id: opt.id })).status, 404);
  const bOpt = (await b.api.get('/preference-options')).data[0];
  assert.equal((await a.api.post(`/patients/${pt.id}/preferences`, { option_id: bOpt.id })).status, 404, 'another practice’s option');
  assert.equal((await b.api.put(`/patient-preferences/${pref.id}`, { urgent: false })).status, 404);
  assert.equal((await b.api.post(`/patient-preferences/${pref.id}/remove`)).status, 404);
  assert.equal((await b.api.post(`/personal-notes/${note.id}/remove`)).status, 404);
  assert.equal((await b.api.post(`/schedule-notes/${dn.id}/ack`)).status, 404);
  assert.equal((await b.api.post(`/schedule-notes/${dn.id}/convert`, { kind: 'task' })).status, 404);
  assert.equal((await b.doc.api.post('/schedule-notes', { appointment_id: appt.id, body: 'x' })).status, 404);
  assert.equal((await b.api.post(`/office-moves/${mv.id}/void`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.post(`/appointments/${appt.id}/office-move`, { reason: 'emergency' })).status, 404);
  assert.equal((await b.api.post(`/appointments/${appt.id}/labels`, { label_key: 'x' })).status, 404);
  const bCards = (await b.api.get(`/schedule-cards?from=${a.day}&to=${a.day}`)).data;
  assert.deepEqual(bCards.by_appt, {});
  assert.deepEqual(bCards.slot_notes, []);
  assert.deepEqual((await b.api.get(`/schedule-notes?date=${a.day}`)).data, []);
  assert.equal((await b.api.get(`/provider-out?provider_id=${a.provider.id}&date=${a.day}`)).status, 404);
  assert.equal((await b.api.post('/provider-out', { provider_id: a.provider.id, date: a.day, client_key: 'x', visits: [{ appointment_id: appt.id, action: 'reschedule' }] })).status, 404);
  assert.equal((await h.db.get("SELECT status FROM appointments WHERE id = ?", appt.id)).status, 'scheduled');
});
