// RC2 — self-scheduling from a recall message: the signed, expiring link; open times that fit the recall
// visit's length and the patient's own hygienist; booking once however often it's tapped; recorded as the
// patient; confirmation sent; families back-to-back; and nothing crossing practices. The public router isn't
// mounted in app.js by this file's author, so the tests mount it on a small app (as app.js would, under /api/public).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { runCadences, addDays, createLink } from '../src/cadence.js';
import { recallTypes } from '../src/recalls.js';
import recallBookRoutes from '../src/routes/recallbook.js';
import { HttpError } from '../src/auth.js';
import { actorMiddleware } from '../src/actor.js';
import { flushChanges } from '../src/util.js';

const box = { sent: [] };
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { box.sent.push(m); return { provider_id: `t-${box.sent.length}` }; } };
const h = harness({ messenger });
const SECRET = 'test-secret';
const TODAY = new Date().toISOString().slice(0, 10);
const weekdayFrom = (d) => {
  let x = d;
  while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = addDays(x, 1);
  return x;
};

let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json());
  app.use('/api/public', recallBookRoutes({ db: h.db, messenger, config: { appUrl: 'https://app.example.com' }, secret: SECRET }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, ...(err.details || {}) }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const pub = async (method, path, body) => {
  const res = await fetch(`${origin}/api/public${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// A practice with two hygienists and a 50-minute cleaning type tied to the prophy recall; Jane's own
// hygienist is the second one. Her recall is due on a weekday 10+ days out; the cadence texts her the link.
async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const hy1 = (await p.api.post('/providers', { name: 'Hy One, RDH', type: 'hygienist' })).data;
  const hy2 = (await p.api.post('/providers', { name: 'Hy Two, RDH', type: 'hygienist' })).data;
  const typeId = (await h.db.run("INSERT INTO appointment_types (practice_id, name, duration, provider_type, active) VALUES (?, 'Adult cleaning', 50, 'hygienist', 1)", pid)).id;
  await recallTypes(h.db, pid);
  await h.db.run("UPDATE recall_types SET appointment_type_id = ? WHERE practice_id = ? AND key = 'prophy'", typeId, pid);
  await h.db.run('UPDATE patients SET primary_hygienist_id = ? WHERE id = ?', hy2.id, p.patient.id);
  await h.db.run('UPDATE practices SET recall_cadence = 1 WHERE id = ?', pid);
  const due = weekdayFrom(addDays(TODAY, 10));
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES (?, ?, 'prophy', 6, ?)", pid, p.patient.id, due);
  return { ...p, pid, hy1, hy2, due, typeId };
}
const sendLinks = async (pid) => {
  const n = box.sent.length;
  await runCadences(h.db, { messenger, appUrl: 'https://app.example.com', secret: SECRET, practiceIds: [pid], now: new Date(`${TODAY}T15:00:00Z`) });
  return box.sent.slice(n).map((m) => /\/rb\/(\d+\.[\w-]{22})/.exec(m.body)?.[1]).filter(Boolean);
};

test('the link is signed and expires: altered, unknown or old links are refused', async () => {
  const { pid, patient } = await setUp();
  const [token] = await sendLinks(pid);
  assert.ok(token, 'the recall text carries a booking link');
  const page = await pub('GET', `/recall/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.people[0].first_name, 'Jane');
  assert.equal(page.data.people[0].visit, 'checkup and cleaning');
  assert.equal(page.data.people[0].minutes, 50);
  assert.equal(page.data.people[0].provider_name, 'Hy Two, RDH');
  assert.equal(page.data.people[0].patient_id, undefined, 'no chart ids on a public page');

  const [id, sig] = token.split('.');
  const flip = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
  assert.equal((await pub('GET', `/recall/${id}.${flip}`)).status, 404, 'altered signature');
  assert.equal((await pub('GET', `/recall/${Number(id) + 1000}.${sig}`)).status, 404, 'someone else’s id');
  assert.equal((await pub('GET', '/recall/not-a-token')).status, 404);
  const [e] = await h.db.all('SELECT id FROM cadence_enrollments WHERE patient_id = ?', patient.id);
  const old = await createLink(h.db, SECRET, { practiceId: pid, recipientId: patient.id, enrollmentIds: [e.id], now: new Date(Date.now() - 100 * 86400_000) });
  assert.equal((await pub('GET', `/recall/${old.token}`)).status, 410, 'expired');
  const other = await createLink(h.db, 'another-secret', { practiceId: pid, recipientId: patient.id, enrollmentIds: [e.id] });
  assert.equal((await pub('GET', `/recall/${other.token}`)).status, 404, 'signed with another key');
});

test('open times fit the visit length and the patient’s own hygienist, from the due date on, around what’s booked', async () => {
  const { pid, hy1, hy2, due, provider, api } = await setUp();
  // Hy Two is busy 8:00-9:40 on the due date; a 50-minute visit can't start before 9:40.
  const other = (await api.post('/patients', { first_name: 'Busy', last_name: 'Chair', dob: '1970-01-01' })).data;
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, other.id, hy2.id, `${due} 08:00`, `${due} 09:40`);
  const [token] = await sendLinks(pid);
  const { data } = await pub('GET', `/recall/${token}/slots`);
  assert.ok(data.days.length >= 1);
  assert.ok(data.days.every((d) => d.date >= due), 'not before the due date');
  const all = data.days.flatMap((d) => d.options.flatMap((o) => o.items));
  assert.ok(all.length > 0);
  assert.ok(all.every((i) => i.provider_id === hy2.id), 'her own hygienist when they have time');
  assert.equal(data.own_provider, true);
  const wider = (await pub('GET', `/recall/${token}/slots?any=1`)).data.days.flatMap((d) => d.options.flatMap((o) => o.items));
  assert.ok(wider.some((i) => i.provider_id === hy1.id), 'any hygienist when asked');
  assert.ok(all.every((i) => i.minutes === 50));
  assert.ok(!all.some((i) => i.provider_id === hy1.id || i.provider_id === provider.id), 'never the dentist');
  const first = data.days.find((d) => d.date === due);
  assert.ok(first, 'the due date has openings later in the day');
  assert.ok(first.options.every((o) => o.start >= `${due} 10:00`), 'nothing overlapping the busy morning (starts on the half hour)');
  assert.ok(first.options.every((o) => o.start <= `${due} 16:10`), 'finishes by closing');
});

test('booking: validated against real openings, idempotent, recorded as the patient, confirmed, stops the cadence', async () => {
  const { pid, patient, hy2, provider, due } = await setUp();
  const [token] = await sendLinks(pid);
  const [e] = await h.db.all('SELECT * FROM cadence_enrollments WHERE patient_id = ?', patient.id);
  const { data } = await pub('GET', `/recall/${token}/slots`);
  const pick = data.days[0].options[0].items[0];
  assert.equal((await pub('POST', `/recall/${token}/book`, { items: [{ ...pick, start: `${due} 03:00` }], key: 'x' })).status, 409, 'not an open time');
  assert.equal((await pub('POST', `/recall/${token}/book`, { items: [{ ...pick, provider_id: provider.id }], key: 'x' })).status, 400, 'not a hygienist');
  assert.equal((await pub('POST', `/recall/${token}/book`, { items: [{ ...pick, start: `${addDays(due, -3)} 10:00` }], key: 'x' })).status, 400, 'before the due date');
  assert.equal((await pub('POST', `/recall/${token}/book`, { items: [] })).status, 400);

  const n = box.sent.length;
  const [one, two] = await Promise.all([
    pub('POST', `/recall/${token}/book`, { items: [pick], key: 'tap-1' }),
    pub('POST', `/recall/${token}/book`, { items: [pick], key: 'tap-1' }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 201], 'a double tap books once');
  const again = await pub('POST', `/recall/${token}/book`, { items: [pick], key: 'tap-1' });
  assert.equal(again.status, 200);
  assert.equal(again.data.repeat, true);
  const appts = await h.db.all("SELECT * FROM appointments WHERE patient_id = ? AND status = 'scheduled'", patient.id);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].provider_id, hy2.id);
  assert.equal(appts[0].start_time, pick.start);
  assert.equal(appts[0].end_time.slice(11), new Date(Date.parse(`2000-01-01T${pick.start.slice(11)}:00Z`) + 50 * 60_000).toISOString().slice(11, 16));
  assert.equal(appts[0].reason, 'Adult cleaning');
  // A different key now: already booked.
  const late = await pub('POST', `/recall/${token}/book`, { items: [pick], key: 'tap-2' });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /already booked/);

  // Recorded as the patient.
  const self = await h.db.get("SELECT * FROM audit_log WHERE action = 'recall.self_book' AND entity_id = ?", appts[0].id);
  assert.equal(self.source, 'patient');
  assert.equal(self.user_id, null);
  assert.equal(self.patient_id, patient.id);
  const created = JSON.parse(self.changes);
  assert.equal(created.start_time, pick.start, 'the new visit’s fields ride on the same entry');
  // The cadence stops, credited to the text; the recall is scheduled; a confirmation went out.
  const done = await h.db.get('SELECT * FROM cadence_enrollments WHERE id = ?', e.id);
  assert.equal(done.status, 'stopped');
  assert.equal(done.stop_reason, 'booked');
  assert.equal(done.booked_via, 'self_schedule');
  assert.equal(done.booked_appointment_id, appts[0].id);
  assert.ok(done.booked_step_id);
  assert.equal((await h.db.get("SELECT status FROM recalls WHERE patient_id = ? AND type = 'prophy'", patient.id)).status, 'scheduled');
  const confirmations = box.sent.slice(n);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].body, /booked/);
  // The page now shows the visit.
  assert.equal((await pub('GET', `/recall/${token}`)).data.people[0].booked.id, appts[0].id);
});

test('a family gets back-to-back times and books them together', async () => {
  const { pid, patient, api, hy2 } = await setUp();
  const kid = (await api.post('/patients', { first_name: 'Mia', last_name: 'Doe', dob: '2018-05-01' })).data;
  await h.db.run('UPDATE patients SET guarantor_id = ?, primary_hygienist_id = ? WHERE id = ?', patient.id, hy2.id, kid.id);
  const mine = await h.db.get('SELECT due_date FROM recalls WHERE patient_id = ?', patient.id);
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES (?, ?, 'prophy', 6, ?)", pid, kid.id, addDays(mine.due_date, 7));
  const tokens = await sendLinks(pid);
  assert.equal(tokens.length, 1, 'one message for both');
  const page = (await pub('GET', `/recall/${tokens[0]}`)).data;
  assert.deepEqual(page.people.map((p) => p.first_name).sort(), ['Jane', 'Mia']);
  const { data } = await pub('GET', `/recall/${tokens[0]}/slots`);
  assert.equal(data.together, true);
  const option = data.days[0].options[0];
  assert.equal(option.items.length, 2);
  assert.ok(data.days[0].date >= addDays(mine.due_date, 7), 'not before either one is due');
  const [a, b] = option.items;
  const end = new Date(Date.parse(`2000-01-01T${a.start.slice(11)}:00Z`) + a.minutes * 60_000).toISOString().slice(11, 16);
  assert.equal(b.start, `${a.start.slice(0, 10)} ${end}`, 'the second starts when the first finishes');
  const booked = await pub('POST', `/recall/${tokens[0]}/book`, { items: option.items, key: 'fam' });
  assert.equal(booked.status, 201);
  assert.equal(booked.data.visits.length, 2);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM cadence_enrollments WHERE patient_id IN (?, ?) AND stop_reason = 'booked'", patient.id, kid.id)).n, 2);
});

test('practice isolation: a link only ever reaches its own practice’s people', async () => {
  const a = await setUp();
  const b = await setUp();
  const [tokenB] = await sendLinks(b.pid);
  const [ea] = await h.db.all('SELECT id FROM cadence_enrollments WHERE patient_id = ?', a.patient.id);
  const { data } = await pub('GET', `/recall/${tokenB}/slots`);
  const pick = data.days[0].options[0].items[0];
  // B's link with A's enrollment in the request.
  assert.equal((await pub('POST', `/recall/${tokenB}/book`, { items: [{ ...pick, enrollment_id: ea?.id ?? 999999 }], key: 'k' })).status, 400);
  // B's link with A's hygienist.
  assert.equal((await pub('POST', `/recall/${tokenB}/book`, { items: [{ ...pick, provider_id: a.hy2.id }], key: 'k2' })).status, 400);
  // A link row in B that names A's enrollment finds nobody.
  await sendLinks(a.pid);
  const [ea2] = await h.db.all('SELECT id FROM cadence_enrollments WHERE patient_id = ?', a.patient.id);
  const forged = await createLink(h.db, SECRET, { practiceId: b.pid, recipientId: b.patient.id, enrollmentIds: [ea2.id] });
  assert.equal((await pub('GET', `/recall/${forged.token}`)).status, 404);
});
