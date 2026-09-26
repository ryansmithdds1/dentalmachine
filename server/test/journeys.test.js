// Patient journeys (PX1–PX7): each journey's trigger and who qualifies, once per period (one birthday text a
// year), opt-outs and quiet hours through the cadence engine, post-op replies and the doctor's alert, the
// handwritten-card threshold, milestones, the huddle's moments, newsletters, practice isolation, permissions,
// and no clinical detail in any message. The routes aren't mounted in app.js by this file's author, so the tests
// mount them on a small app (the inbound text webhook is the real one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { runCadences, addDays } from '../src/cadence.js';
import journeyRoutes, { journeyPublicRoutes } from '../src/routes/journeys.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { twilioSignature } from '../src/routes/sms.js';
import { runJourneyExtras, postopReply, ensureJourneySetup, CLINICAL, birthdayIn, markFirstVisits } from '../src/journeys.js';

const box = { sent: [] };
const messenger = {
  status: { sms: 'test', email: 'test' },
  send: async (m) => {
    box.sent.push(m);
    return { provider_id: `t-${box.sent.length}` };
  },
};
const mailer = { enabled: true, name: 'Mail log', letters: [], async sendLetter(l) { this.letters.push(l); return { reference: `ltr_${this.letters.length}` }; } };
const h = harness({ messenger, config: { twilioAuthToken: 'tw' } });
const SECRET = 'test-secret';
const APP = 'https://app.example.com';
const TODAY = new Date().toISOString().slice(0, 10);
const at = (date, hm = '10:00') => new Date(`${date}T${hm}:00Z`);

let origin;
let server;
before(async () => {
  // The harness opens the database in its own before(); Postgres takes a few seconds to build a fresh schema.
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/public', journeyPublicRoutes({ db: h.db }));
  const api = express.Router();
  api.use(authenticate(h.db, SECRET));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(journeyRoutes({ db: h.db, messenger, mailer, config: { appUrl: APP }, secret: SECRET }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (token) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

async function setUp(extra = {}) {
  const p = await h.practice({ timezone: 'UTC', ...extra });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const adminId = (await h.db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", pid)).id;
  await h.db.run('UPDATE providers SET user_id = ? WHERE id = ?', adminId, p.provider.id);
  await ensureJourneySetup(h.db, pid);
  return { ...p, pid, adminId, staff: call(p.token) };
}
const run = (pid, now) => runCadences(h.db, { messenger, mailer, appUrl: APP, secret: SECRET, now, practiceIds: [pid] });
const extras = (pid, now) => runJourneyExtras(h.db, { messenger, mailer, appUrl: APP, now, practiceIds: [pid] });
const sentSince = (n) => box.sent.slice(n);
const addPatient = async (api, extra) => (await api.post('/patients', { last_name: 'Test', phone: `(512) 555-${String(1000 + Math.floor(Math.random() * 8999))}`, email: `p${Math.random().toString(36).slice(2, 8)}@example.com`, ...extra })).data;
const appt = async (pid, patientId, providerId, start, status = 'scheduled') => (await h.db.get(
  `INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, pid, patientId, providerId, start, `${start.slice(0, 11)}${String(Number(start.slice(11, 13)) + 1).padStart(2, '0')}:00`, status,
)).id;
async function codeId(pid, code, category, description) {
  const had = await h.db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code);
  if (had) return had.id;
  return (await h.db.get('INSERT INTO procedure_codes (practice_id, code, description, category, fee) VALUES (?, ?, ?, ?, 10000) RETURNING id', pid, code, description, category)).id;
}
const procedure = async (pid, patientId, providerId, { code, category, description, fee, completedAt, status = 'completed', appointmentId = null }) => h.db.run(
  'INSERT INTO procedures (practice_id, patient_id, provider_id, appointment_id, code_id, code, description, category, fee, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  pid, patientId, providerId, appointmentId, await codeId(pid, code, category, description), code, description, category, fee, status, completedAt,
);
const enrollments = (patientId, key) => h.db.all("SELECT e.* FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.patient_id = ? AND s.type = 'journey' AND s.subtype = ? ORDER BY e.id", patientId, key);
const on = (staff, key, body = {}) => staff('PUT', `/journeys/${key}`, { enabled: true, ...body });

test('defaults: birthday and the new-patient welcome start on, everything else off; admin-only edits, validated and audited', async () => {
  const { staff, pid, api } = await setUp();
  const { data } = await staff('GET', '/journeys');
  const state = Object.fromEntries(data.journeys.map((j) => [j.key, j.enabled]));
  assert.equal(state.birthday, true);
  assert.equal(state.welcome, true);
  assert.equal(state.arrival, true);
  for (const k of ['thankyou', 'postop', 'summary', 'birthday_card', 'anniversary', 'milestone', 'reactivation', 'referral_thanks', 'card_task', 'survey', 'newsletter']) assert.equal(state[k], false, `${k} starts off`);
  const seqs = await h.db.all("SELECT subtype, active, family_window_days FROM cadence_sequences WHERE practice_id = ? AND type = 'journey'", pid);
  assert.equal(seqs.length, 11);
  assert.ok(seqs.every((s) => s.family_window_days === 0), 'a birthday is one person’s: never grouped');
  assert.equal(seqs.find((s) => s.subtype === 'thankyou').active, 0);
  const steps = await h.db.all("SELECT st.template FROM cadence_steps st JOIN cadence_sequences s ON s.id = st.sequence_id WHERE s.practice_id = ? AND s.type = 'journey'", pid);
  assert.ok(steps.every((s) => s.template === '{visit}'));

  // Wording: only known fields, nothing clinical.
  assert.equal((await staff('PUT', '/journeys/birthday', { template: 'Happy birthday {nickname}' })).status, 400);
  const clinical = await staff('PUT', '/journeys/postop', { template: 'How is your extraction healing, {first_name}?' });
  assert.equal(clinical.status, 400);
  assert.match(clinical.data.error, /clinical/);
  assert.equal((await staff('PUT', '/journeys/birthday', { channel: 'letter' })).status, 400, 'birthday goes by text or email');
  const saved = await staff('PUT', '/journeys/thankyou', { enabled: true, template: 'Thanks for today, {first_name}! — {doctor}' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.enabled, true);
  assert.equal((await h.db.get("SELECT active FROM cadence_sequences WHERE practice_id = ? AND type = 'journey' AND subtype = 'thankyou'", pid)).active, 1);
  const a = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'journey.on' ORDER BY id DESC", pid);
  assert.equal(a.source, 'human');
  const changes = JSON.parse(a.changes);
  assert.deepEqual(changes.enabled, [0, 1]);
  assert.match(changes.template[1], /Thanks for today/);

  // Preview on a phone: a pretend patient, never a real one.
  const pv = await staff('POST', '/journeys/thankyou/preview', {});
  assert.equal(pv.status, 200);
  assert.match(pv.data.text, /^Thanks for today, Alex! — Dr\. Ann Lee Reply STOP to opt out\.$/);
  assert.equal(pv.data.segments, 1);
  const n = box.sent.length;
  const t = await staff('POST', '/journeys/birthday/test', {});
  assert.equal(t.status, 200);
  assert.equal(t.data.channel, 'email');
  assert.match(sentSince(n)[0].body, /^\[Test\] Happy birthday, Alex!/);

  // Front desk can read, not change.
  const deskEmail = `desk-${Date.now()}@example.com`;
  await api.post('/users', { email: deskEmail, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const desk = call((await h.client().post('/auth/login', { email: deskEmail, password: 'front-desk-password' })).data.token);
  assert.equal((await desk('GET', '/journeys')).status, 200);
  assert.equal((await desk('PUT', '/journeys/birthday', { enabled: false })).status, 403);
  assert.equal((await desk('POST', '/journeys/broadcasts', { kind: 'holiday', title: 'x', body: 'y' })).status, 403);
  assert.equal((await desk('GET', '/journeys/delight')).status, 403, 'the delight score is a report');
});

test('PX1 new-patient welcome: email from the doctor with the visit, address, parking and a welcome page; the arrival text the day before; once', async () => {
  const { staff, pid, api, provider } = await setUp();
  const prof = await staff('PUT', '/journeys/profile', { parking: 'Park free in the lot behind the building.' });
  assert.equal(prof.status, 200, JSON.stringify(prof.data));
  const newbie = await addPatient(api, { first_name: 'Nina', dob: '1990-02-02' });
  const visit = addDays(TODAY, 3);
  const apptId = await appt(pid, newbie.id, provider.id, `${visit} 14:30`);
  // An existing patient's visit (seen before) gets nothing.
  const regular = await addPatient(api, { first_name: 'Rex', dob: '1980-03-03' });
  await appt(pid, regular.id, provider.id, `${addDays(TODAY, -200)} 09:00`, 'completed');
  await appt(pid, regular.id, provider.id, `${visit} 10:00`);
  const n = box.sent.length;
  await run(pid, at(TODAY));
  const mine = sentSince(n).filter((m) => m.to === newbie.email);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].channel, 'email');
  assert.match(mine[0].subject, /^Welcome to Practice \d+, Nina!$/);
  assert.match(mine[0].body, /^Hi Nina, I’m so glad you chose Practice \d+/);
  assert.match(mine[0].body, /at 2:30 PM/);
  assert.match(mine[0].body, /1 Main St, Austin/);
  assert.match(mine[0].body, /Park free in the lot behind the building\./);
  assert.match(mine[0].body, /— Dr\. Ann Lee$/);
  const link = /https:\/\/app\.example\.com\/welcome\/([\w-]+)/.exec(mine[0].body);
  assert.ok(link, 'a link to the welcome page');
  assert.equal(sentSince(n).filter((m) => m.to === regular.email || m.to === regular.phone).length, 0, 'not a new patient');
  const msg = await h.db.get("SELECT * FROM messages WHERE patient_id = ? AND kind = 'journey'", newbie.id);
  assert.ok(msg, 'logged as a journey message');

  // The welcome page: first name, the visit and the office — nothing clinical.
  const page = await call()('GET', `/public/journeys/welcome/${link[1]}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.first_name, 'Nina');
  assert.equal(page.data.time, '2:30 PM');
  assert.equal(page.data.parking, 'Park free in the lot behind the building.');
  assert.equal(page.data.active, true);
  assert.equal(page.data.dob, undefined);
  assert.equal((await call()('GET', '/public/journeys/welcome/not-a-real-token-at-all')).status, 404);

  // Again the same day, and the next: no second welcome.
  await run(pid, at(TODAY, '15:00'));
  await run(pid, at(addDays(TODAY, 1)));
  assert.equal(sentSince(n).filter((m) => m.to === newbie.email).length, 1);

  // The day before: the arrival text.
  await run(pid, at(addDays(TODAY, 2)));
  const arrival = sentSince(n).filter((m) => m.to === newbie.phone);
  assert.equal(arrival.length, 1);
  assert.match(arrival[0].body, /^Hi Nina! We can’t wait to meet you tomorrow at 2:30 PM at Practice \d+, 1 Main St, Austin\. Park free/);
  assert.match(arrival[0].body, /Reply STOP to opt out\.$/);

  // The schedule card can read first_visit.
  const rows = await markFirstVisits(h.db, pid, await h.db.all('SELECT * FROM appointments WHERE practice_id = ? AND start_time >= ?', pid, `${visit} 00:00`));
  assert.equal(rows.find((r) => r.id === apptId).first_visit, true);
  assert.equal(rows.find((r) => r.patient_id === regular.id).first_visit, false);

  // Moved to another day: the old enrollment stops; the new date gets its own arrival text.
  const later = await addPatient(api, { first_name: 'Otto' });
  const other = await appt(pid, later.id, provider.id, `${addDays(TODAY, 5)} 09:00`);
  await run(pid, at(TODAY));
  await h.db.run('UPDATE appointments SET start_time = ?, end_time = ? WHERE id = ?', `${addDays(TODAY, 8)} 09:00`, `${addDays(TODAY, 8)} 10:00`, other);
  await run(pid, at(addDays(TODAY, 4)));
  const [e] = await enrollments(later.id, 'welcome');
  assert.equal(e.status === 'completed' || e.status === 'stopped', true);
  assert.equal(sentSince(n).filter((m) => m.to === later.phone).length, 0, 'no arrival text for the old date');

  // Automation, never a person.
  const audits = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action LIKE 'cadence.%' AND patient_id = ?", pid, newbie.id);
  assert.ok(audits.length);
  for (const x of audits) {
    assert.equal(x.source, 'automation');
    assert.equal(x.actor, 'Patient journeys autopilot');
    assert.equal(x.user_id, null);
  }
});

test('PX1: a visit booked before the welcome was switched on is left alone', async () => {
  const { staff, pid, api, provider } = await setUp();
  await staff('PUT', '/journeys/welcome', { enabled: false });
  const early = await addPatient(api, { first_name: 'Early' });
  await appt(pid, early.id, provider.id, `${addDays(TODAY, 10)} 09:00`);
  await new Promise((r) => setTimeout(r, 1100));
  await staff('PUT', '/journeys/welcome', { enabled: true });
  const n = box.sent.length;
  await run(pid, at(TODAY));
  assert.equal(sentSince(n).filter((m) => m.to === early.email).length, 0);
});

test('PX4 birthday: one text on the day, once a year; quiet hours wait; opted out, inactive and “no celebrations” get nothing', async () => {
  const { pid, api, provider, staff } = await setUp({ send_from: '08:00', send_until: '20:00' });
  const md = TODAY.slice(5);
  const dob = md === '02-29' ? '2000-02-29' : `1990-${md}`;
  const bday = await addPatient(api, { first_name: 'Bea', dob });
  await appt(pid, bday.id, provider.id, `${addDays(TODAY, -30)} 09:00`, 'completed');
  const quiet = await addPatient(api, { first_name: 'Quinn', dob });
  await appt(pid, quiet.id, provider.id, `${addDays(TODAY, -30)} 10:00`, 'completed');
  await h.db.run('UPDATE patients SET sms_opt_in = 0, email_opt_in = 0 WHERE id = ?', quiet.id);
  const shy = await addPatient(api, { first_name: 'Shy', dob });
  await appt(pid, shy.id, provider.id, `${addDays(TODAY, -30)} 11:00`, 'completed');
  assert.equal((await staff('PUT', `/journeys/patients/${shy.id}/prefs`, { no_celebrations: true })).status, 200);

  const n = box.sent.length;
  await run(pid, at(TODAY, '06:00'));
  assert.equal(sentSince(n).length, 0, 'quiet hours: it waits for the morning');
  assert.equal((await enrollments(bday.id, 'birthday')).length, 1, 'enrolled, waiting');
  await run(pid, at(TODAY, '09:00'));
  const got = sentSince(n).filter((m) => m.to === bday.phone);
  assert.equal(got.length, 1);
  assert.match(got[0].body, /^Happy birthday, Bea! Everyone at Practice \d+ is wishing you a wonderful day and a year full of smiles\. Reply STOP to opt out\.$/);
  await run(pid, at(TODAY, '11:00'));
  await run(pid, at(TODAY, '19:00'));
  assert.equal(sentSince(n).filter((m) => m.to === bday.phone).length, 1, 'one a year, never more');
  for (const p of [quiet, shy]) assert.equal(sentSince(n).filter((m) => m.to === p.phone || m.to === p.email).length, 0, `${p.first_name} gets nothing`);
  assert.equal((await enrollments(quiet.id, 'birthday')).length, 0, 'opted out of everything: never enrolled');

  // Next year: another one.
  const next = birthdayIn(dob, Number(TODAY.slice(0, 4)) + 1);
  await run(pid, at(next, '09:00'));
  assert.equal(sentSince(n).filter((m) => m.to === bday.phone).length, 2);
  assert.equal(birthdayIn('2000-02-29', 2027), '2027-02-28');
});

test('PX4 mailed birthday card for kids arrives by the day (Lob, via the engine), and the anniversary says how many years', async () => {
  const { staff, pid, api, provider } = await setUp();
  await on(staff, 'birthday_card');
  await on(staff, 'anniversary');
  const cardDay = addDays(TODAY, 5);
  const kidDob = `${Number(cardDay.slice(0, 4)) - 7}${cardDay.slice(4)}`;
  const kid = await addPatient(api, { first_name: 'Kit', dob: kidDob, address: '5 Oak', city: 'Austin', state: 'TX', zip: '78704' });
  await appt(pid, kid.id, provider.id, `${addDays(TODAY, -60)} 09:00`, 'completed');
  const years5 = `${Number(TODAY.slice(0, 4)) - 5}${TODAY.slice(4)}`;
  const loyal = await addPatient(api, { first_name: 'Lou', dob: '1970-01-15' });
  await appt(pid, loyal.id, provider.id, `${years5} 09:00`, 'completed');
  await appt(pid, loyal.id, provider.id, `${addDays(TODAY, -100)} 09:00`, 'completed');
  const letters = mailer.letters.length;
  const n = box.sent.length;
  await run(pid, at(TODAY));
  const mailed = mailer.letters.slice(letters);
  assert.equal(mailed.length, 1);
  assert.equal(mailed[0].to.address, '5 Oak');
  assert.match(mailed[0].html, /Happy birthday, Kit!/);
  const anniv = sentSince(n).filter((m) => m.to === loyal.phone);
  assert.equal(anniv.length, 1);
  assert.match(anniv[0].body, /It’s been 5 years since your first visit/);
  await run(pid, at(TODAY, '12:00'));
  assert.equal(mailer.letters.length, letters + 1, 'mailed once');
});

test('PX4 the birthday card looks ahead across New Year: a Jan 2 birthday is mailed on Dec 28', async () => {
  const { staff, pid, api, provider } = await setUp();
  await on(staff, 'birthday_card');
  const kid = await addPatient(api, { first_name: 'Noel', dob: '2024-01-02', address: '9 Elm', city: 'Austin', state: 'TX', zip: '78704' });
  await appt(pid, kid.id, provider.id, '2030-10-30 09:00', 'completed');
  const letters = mailer.letters.length;
  await run(pid, at('2030-12-28')); // five days before, as the card is timed
  const mailed = mailer.letters.slice(letters);
  assert.equal(mailed.length, 1, 'next year’s birthday, not this year’s (already past)');
  assert.equal(mailed[0].to.address, '9 Elm');
  assert.match(mailed[0].html, /Happy birthday, Noel!/);
  const e = await h.db.get('SELECT anchor_date FROM cadence_enrollments WHERE patient_id = ?', kid.id);
  assert.equal(e?.anchor_date, '2031-01-02');
});

test('PX3 post-op check-in: the evening after surgery, nothing clinical in it; 3 and 2 alert the doctor and Needs attention, 1 doesn’t', async () => {
  const { staff, pid, patient, provider, adminId } = await setUp();
  await on(staff, 'postop');
  const visit = await appt(pid, patient.id, provider.id, `${TODAY} 09:00`, 'completed');
  await procedure(pid, patient.id, provider.id, { code: 'D7140', category: 'oral_surgery', description: 'Extraction, erupted tooth', fee: 25000, completedAt: `${TODAY} 09:40`, appointmentId: visit });
  const n = box.sent.length;
  await run(pid, at(TODAY, '15:00'));
  assert.equal(sentSince(n).filter((m) => m.to === patient.phone).length, 0, 'not before the evening');
  await run(pid, at(TODAY, '18:30'));
  const [msg] = sentSince(n).filter((m) => m.to === patient.phone);
  assert.ok(msg);
  assert.match(msg.body, /^Hi Jane, it’s Practice \d+ checking in after your visit today\. How are you feeling\? Reply 1/);
  assert.doesNotMatch(msg.body, /D7140|xtraction|tooth|surgery/i);
  const checkin = await h.db.get('SELECT * FROM journey_checkins WHERE patient_id = ?', patient.id);
  assert.ok(checkin);
  assert.equal(checkin.provider_id, provider.id);

  // Reply 3 through the real inbound-text webhook.
  const practice = await h.db.get('SELECT * FROM practices WHERE id = ?', pid);
  const params = { From: '+15125550100', To: '+15125559999', Body: '3', MessageSid: `SM${Date.now()}` };
  const res = await fetch(`${h.origin}/api/webhooks/twilio/sms`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('tw', `${APP}/api/webhooks/twilio/sms`, params) }, body: new URLSearchParams(params),
  });
  const twiml = await res.text();
  assert.match(twiml, /We’ve let Dr\. Ann Lee know and someone will call you shortly/);
  const after3 = await h.db.get('SELECT * FROM journey_checkins WHERE id = ?', checkin.id);
  assert.equal(after3.reply, 3);
  const task = await h.db.get('SELECT * FROM tasks WHERE id = ?', after3.task_id);
  assert.equal(task.priority, 'high');
  assert.equal(task.assigned_to, adminId, 'to the doctor');
  assert.doesNotMatch(task.title, /xtraction|D7140/);
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", pid, `postop:${checkin.id}`);
  assert.ok(issue, 'in Needs attention');
  assert.equal(issue.severity, 'high');
  const audit = await h.db.get("SELECT * FROM audit_log WHERE action = 'journey.postop.reply' AND entity_id = ?", checkin.id);
  assert.equal(audit.source, 'patient');
  // The same answer again changes nothing; a text that isn't an answer isn't treated as one.
  assert.match(await postopReply(h.db, { practice, from: '+15125550100', body: '3' }), /someone will call you/);
  assert.equal((await h.db.all('SELECT id FROM tasks WHERE patient_id = ? AND priority = ?', patient.id, 'high')).length, 1);
  assert.equal(await postopReply(h.db, { practice, from: '+15125550100', body: '31 Oak Street' }), null);
  assert.equal(await postopReply(h.db, { practice, from: '+15125550199', body: '2' }), null, 'no check-in went to this number');

  // Another patient answers 1: a kind reply, no alert.
  const { patient: p2, pid: pid2, provider: pr2, staff: s2 } = await setUp();
  await on(s2, 'postop');
  await appt(pid2, p2.id, pr2.id, `${TODAY} 09:00`, 'completed');
  await procedure(pid2, p2.id, pr2.id, { code: 'D3330', category: 'endodontics', description: 'Endodontic therapy, molar', fee: 110000, completedAt: `${TODAY} 10:00` });
  await run(pid2, at(TODAY, '18:30'));
  const practice2 = await h.db.get('SELECT * FROM practices WHERE id = ?', pid2);
  assert.match(await postopReply(h.db, { practice: practice2, from: '(512) 555-0100', body: '1' }), /^So glad to hear it, Jane!/);
  const c2 = await h.db.get('SELECT * FROM journey_checkins WHERE practice_id = ?', pid2);
  assert.equal(c2.reply, 1);
  assert.equal(c2.task_id, null);
  // …and later says 2: a worse answer still reaches the doctor.
  assert.match(await postopReply(h.db, { practice: practice2, from: '(512) 555-0100', body: '2 a bit sore' }), /We’ve told Dr\. Ann Lee/);
  assert.ok((await h.db.get('SELECT task_id FROM journey_checkins WHERE id = ?', c2.id)).task_id);
});

test('PX3 same-day thank-you names the provider; the “you’re all set” summary replaces it when both are on', async () => {
  const { staff, pid, patient, provider } = await setUp();
  await on(staff, 'thankyou');
  await appt(pid, patient.id, provider.id, `${TODAY} 09:00`, 'completed');
  const n = box.sent.length;
  await run(pid, at(TODAY, '11:00'));
  const [ty] = sentSince(n).filter((m) => m.to === patient.phone);
  assert.match(ty.body, /^Thank you for coming in today, Jane! It was a pleasure to see you\. — Dr\. Ann Lee and the team at Practice \d+/);

  const b = await setUp();
  await on(b.staff, 'thankyou');
  await on(b.staff, 'summary');
  await appt(b.pid, b.patient.id, b.provider.id, `${TODAY} 09:00`, 'completed');
  await appt(b.pid, b.patient.id, b.provider.id, `${addDays(TODAY, 180)} 09:00`);
  const m = box.sent.length;
  await run(b.pid, at(TODAY, '11:00'));
  const mine = sentSince(m).filter((x) => x.to === b.patient.phone);
  assert.equal(mine.length, 1, 'one message, not two');
  assert.match(mine[0].body, /^You’re all set, Jane! Thanks for coming in today\. Your next visit is .+ at 9:00 AM\. Your visit summary, forms and any balance are in your patient portal: https:\/\/app\.example\.com\/portal/);
  assert.doesNotMatch(mine[0].body, /\$/, 'no balance in the text itself');
});

test('PX3 handwritten card tasks: after a first visit and over the treatment threshold, once each; “card sent” ticks the task', async () => {
  const { staff, pid, api, provider } = await setUp();
  await on(staff, 'card_task', { options: { threshold_cents: 100000 } });
  const first = await addPatient(api, { first_name: 'Fay' });
  await appt(pid, first.id, provider.id, `${TODAY} 09:00`, 'completed');
  const big = await addPatient(api, { first_name: 'Ben' });
  await appt(pid, big.id, provider.id, `${addDays(TODAY, -300)} 09:00`, 'completed');
  await procedure(pid, big.id, provider.id, { code: 'D2740', category: 'restorative', description: 'Crown', fee: 120000, completedAt: `${TODAY} 10:00` });
  const small = await addPatient(api, { first_name: 'Sal' });
  await appt(pid, small.id, provider.id, `${addDays(TODAY, -300)} 09:00`, 'completed');
  await procedure(pid, small.id, provider.id, { code: 'D1110', category: 'preventive', description: 'Cleaning', fee: 12000, completedAt: `${TODAY} 10:00` });
  const stats = await extras(pid, at(TODAY, '17:00'));
  assert.equal(stats.cards, 2);
  await extras(pid, at(TODAY, '18:00'));
  const cards = (await staff('GET', '/journeys/cards')).data;
  assert.equal(cards.length, 2, 'once each');
  assert.ok(cards.some((c) => c.patient_id === first.id && /first visit/.test(c.title)));
  assert.ok(cards.some((c) => c.patient_id === big.id && /big treatment day/.test(c.title)));
  assert.ok(!cards.some((c) => c.patient_id === small.id), 'under the threshold');
  const done = await staff('POST', `/journeys/cards/${cards[0].id}/sent`);
  assert.equal(done.status, 200);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', cards[0].task_id)).status, 'done');
  assert.equal((await staff('GET', '/journeys/cards')).data.length, 1);
});

test('PX4 milestones: a child’s first cavity-free checkup and braces off, with a printable certificate; PX7 huddle moments', async () => {
  const { staff, pid, api, provider, patient } = await setUp();
  const kidDob = `${Number(TODAY.slice(0, 4)) - 8}-03-03`;
  const kid = await addPatient(api, { first_name: 'Cody', dob: kidDob });
  const k1 = await appt(pid, kid.id, provider.id, `${TODAY} 08:00`, 'completed');
  await procedure(pid, kid.id, provider.id, { code: 'D0120', category: 'diagnostic', description: 'Periodic oral evaluation', fee: 6000, completedAt: `${TODAY} 08:20`, appointmentId: k1 });
  const cavities = await addPatient(api, { first_name: 'Cara', dob: kidDob });
  await appt(pid, cavities.id, provider.id, `${TODAY} 08:30`, 'completed');
  await procedure(pid, cavities.id, provider.id, { code: 'D0120', category: 'diagnostic', description: 'Periodic oral evaluation', fee: 6000, completedAt: `${TODAY} 08:40` });
  await h.db.run("INSERT INTO tooth_conditions (practice_id, patient_id, tooth, condition) VALUES (?, ?, '19', 'caries')", pid, cavities.id);
  const teen = await addPatient(api, { first_name: 'Tia', dob: `${Number(TODAY.slice(0, 4)) - 15}-06-06` });
  await h.db.run("INSERT INTO ortho_cases (practice_id, patient_id, provider_id, status, start_date, total_fee, months, monthly_amount, debond_date) VALUES (?, ?, ?, 'retention', ?, 500000, 24, 20000, ?)",
    pid, teen.id, provider.id, addDays(TODAY, -700), TODAY);
  await appt(pid, teen.id, provider.id, `${TODAY} 13:00`, 'checked_in');

  // Today's schedule for the huddle: a birthday, a first visit, a hard last visit, a note to mention.
  const md = TODAY.slice(5);
  const bday = await addPatient(api, { first_name: 'Bo', dob: md === '02-29' ? '2000-02-29' : `1991-${md}` });
  await appt(pid, bday.id, provider.id, `${TODAY} 10:00`);
  const fresh = await addPatient(api, { first_name: 'Finn' });
  await appt(pid, fresh.id, provider.id, `${TODAY} 11:00`);
  await h.db.run("UPDATE patients SET office_alert = 'Just had a new baby girl, Ruby!' WHERE id = ?", patient.id);
  await appt(pid, patient.id, provider.id, `${TODAY} 15:00`);
  await h.db.run('INSERT INTO surveys (practice_id, name, questions) VALUES (?, ?, ?)', pid, 'S', '[]');
  const sv = (await h.db.get('SELECT id FROM surveys WHERE practice_id = ?', pid)).id;
  await h.db.run("INSERT INTO survey_responses (practice_id, survey_id, patient_id, token_hash, nps, answers, answered_at) VALUES (?, ?, ?, 'h1', 3, '{\"nps\":3}', datetime('now'))", pid, sv, patient.id);

  const stats = await extras(pid, at(TODAY, '17:00'));
  assert.ok(stats.moments >= 3);
  const moments = await h.db.all('SELECT * FROM journey_moments WHERE practice_id = ?', pid);
  assert.ok(moments.some((m) => m.patient_id === kid.id && m.kind === 'cavity_free'));
  assert.ok(!moments.some((m) => m.patient_id === cavities.id), 'caries charted: not cavity-free');
  assert.ok(moments.some((m) => m.patient_id === teen.id && m.kind === 'braces_off'));
  assert.ok(moments.some((m) => m.patient_id === patient.id && m.kind === 'life_event' && /New baby/.test(m.detail)));
  assert.ok(moments.some((m) => m.patient_id === patient.id && m.kind === 'hard_visit'));
  await extras(pid, at(TODAY, '18:00'));
  assert.equal((await h.db.all('SELECT id FROM journey_moments WHERE practice_id = ?', pid)).length, moments.length, 'detected once');

  const huddle = (await staff('GET', `/journeys/moments?date=${TODAY}`)).data;
  assert.ok(huddle.birthdays.some((b) => b.patient_id === bday.id));
  assert.ok(huddle.first_visits.some((f) => f.patient_id === fresh.id));
  assert.ok(huddle.milestones.some((m) => m.patient_id === kid.id && m.kind === 'cavity_free'));
  assert.ok(huddle.milestones.some((m) => m.patient_id === teen.id && m.kind === 'braces_off'));
  const hard = huddle.hard_visits.find((x) => x.patient_id === patient.id);
  assert.ok(hard);
  assert.match(hard.reasons[0], /Scored us 3\/10/);
  assert.ok(huddle.notes.some((x) => x.patient_id === patient.id && /new baby/.test(x.notes[0])));
  assert.ok(huddle.life_events.some((x) => x.patient_id === patient.id));

  // The certificate, and marking it done.
  const cert = moments.find((m) => m.kind === 'cavity_free');
  const pdf = await staff('GET', `/journeys/moments/${cert.id}/certificate`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await staff('POST', `/journeys/moments/${cert.id}/done`)).data.status, 'done');
  // A life event the team chooses: a card task, never a message.
  const life = moments.find((m) => m.kind === 'life_event');
  const n = box.sent.length;
  const card = await staff('POST', `/journeys/moments/${life.id}/card`);
  assert.equal(card.status, 200);
  assert.ok(card.data.task_id);
  assert.equal(box.sent.length, n, 'nothing sent to the patient');

  // Milestone congratulations text when switched on: warm, nothing clinical.
  await on(staff, 'milestone');
  await run(pid, at(TODAY, '17:30'));
  const congrats = sentSince(n).filter((m) => m.to === teen.phone);
  assert.equal(congrats.length, 1);
  assert.match(congrats[0].body, /^Congratulations, Tia!/);
  assert.doesNotMatch(congrats[0].body, CLINICAL);
});

test('PX5 “we miss you”: patients away a while with nothing booked; recall autopilot keeps its own; booking stops it', async () => {
  const { staff, pid, api, provider } = await setUp();
  await on(staff, 'reactivation');
  const away = await addPatient(api, { first_name: 'Ava' });
  await appt(pid, away.id, provider.id, `${addDays(TODAY, -620)} 09:00`, 'completed');
  const recallish = await addPatient(api, { first_name: 'Ray' });
  await appt(pid, recallish.id, provider.id, `${addDays(TODAY, -620)} 09:00`, 'completed');
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES (?, ?, 'prophy', 6, ?)", pid, recallish.id, addDays(TODAY, -440));
  await h.db.run('UPDATE practices SET recall_cadence = 1 WHERE id = ?', pid);
  const recent = await addPatient(api, { first_name: 'Rita' });
  await appt(pid, recent.id, provider.id, `${addDays(TODAY, -100)} 09:00`, 'completed');
  const n = box.sent.length;
  await run(pid, at(TODAY));
  const ava = sentSince(n).filter((m) => m.to === away.phone && /miss you/.test(m.body));
  assert.equal(ava.length, 1);
  assert.match(ava[0].body, /^Hi Ava, it’s been a while and we miss you at Practice \d+!/);
  assert.equal((await enrollments(recallish.id, 'reactivation')).length, 0, 'recall autopilot has them');
  assert.equal((await enrollments(recent.id, 'reactivation')).length, 0, 'seen recently');
  await appt(pid, away.id, provider.id, `${addDays(TODAY, 200)} 09:00`);
  await run(pid, at(addDays(TODAY, 130)));
  const [e] = await enrollments(away.id, 'reactivation');
  assert.equal(e.status, 'stopped');
  assert.equal(e.stop_reason, 'booked');
});

test('PX5 referral thank-you (the friend is never named) and the gift card task', async () => {
  const { staff, pid, api, provider, patient } = await setUp();
  await on(staff, 'referral_thanks');
  await on(staff, 'referral_gift', { options: { gift: '$25 coffee card' } });
  const friend = await addPatient(api, { first_name: 'Frida', last_name: 'Friendly' });
  assert.equal((await staff('POST', '/journeys/referrals', { referrer_patient_id: patient.id, referred_patient_id: patient.id })).status, 400);
  const ref = await staff('POST', '/journeys/referrals', { referrer_patient_id: patient.id, referred_patient_id: friend.id });
  assert.equal(ref.status, 201);
  assert.equal((await staff('POST', '/journeys/referrals', { referrer_patient_id: patient.id, referred_patient_id: friend.id })).status, 200, 'the same twice is fine');
  await appt(pid, friend.id, provider.id, `${TODAY} 09:00`, 'completed');
  const n = box.sent.length;
  await run(pid, at(TODAY, '12:00'));
  const [thanks] = sentSince(n).filter((m) => m.to === patient.phone);
  assert.match(thanks.body, /^Thank you so much, Jane! A friend of yours came to see us/);
  assert.doesNotMatch(thanks.body, /Frida|Friendly/);
  await extras(pid, at(TODAY, '12:00'));
  const gift = await h.db.get("SELECT t.* FROM journey_cards c JOIN tasks t ON t.id = c.task_id WHERE c.practice_id = ? AND c.reason = 'referral_gift'", pid);
  assert.match(gift.title, /\$25 coffee card/);
});

test('PX6 the one-question survey reuses Surveys; comments reach the owner; NPS by provider; the delight score', async () => {
  const { staff, pid, patient, provider, adminId } = await setUp();
  assert.equal((await on(staff, 'survey')).status, 200);
  const s = await h.db.get("SELECT * FROM surveys WHERE practice_id = ? AND name = 'Quick check-in (after visits)'", pid);
  assert.equal(s.auto_after_visit, 1);
  assert.deepEqual(JSON.parse(s.questions).map((q) => q.type), ['nps', 'text']);
  const v1 = await appt(pid, patient.id, provider.id, `${addDays(TODAY, -3)} 09:00`, 'completed');
  await h.db.run("INSERT INTO survey_responses (practice_id, survey_id, patient_id, appointment_id, token_hash, nps, answers, answered_at) VALUES (?, ?, ?, ?, 'a1', 10, '{\"nps\":10,\"comment\":\"Loved the warm blanket!\"}', datetime('now'))", pid, s.id, patient.id, v1);
  await h.db.run("INSERT INTO survey_responses (practice_id, survey_id, patient_id, appointment_id, token_hash, nps, answers, answered_at) VALUES (?, ?, ?, ?, 'a2', 4, '{\"nps\":4}', datetime('now'))", pid, s.id, patient.id, v1);
  const stats = await extras(pid, new Date());
  assert.equal(stats.comments, 1);
  const task = await h.db.get('SELECT * FROM tasks WHERE practice_id = ? AND title LIKE ?', pid, 'Patient comment%');
  assert.equal(task.assigned_to, adminId, 'to the owner');
  assert.match(task.title, /Loved the warm blanket/);
  const nps = (await staff('GET', `/journeys/feedback/nps?from=${addDays(TODAY, -30)}&to=${TODAY}`)).data;
  assert.equal(nps.responses, 2);
  assert.equal(nps.nps, 0, 'one promoter, one detractor');
  assert.equal(nps.groups[0].name, 'Dr. Ann Lee');
  const d = (await staff('GET', '/journeys/delight')).data;
  assert.equal(d.score, 50);
  assert.equal(d.parts[0].key, 'nps');
  assert.equal(d.unhappy, 1);
  await staff('PUT', '/journeys/survey', { enabled: false });
  assert.equal((await h.db.get('SELECT auto_after_visit FROM surveys WHERE id = ?', s.id)).auto_after_visit, 0);
});

test('PX5 newsletter: only opted-in patients, an unsubscribe link in each, sent once however many clicks', async () => {
  const { staff, pid, patient, api } = await setUp();
  const other = await addPatient(api, { first_name: 'Olive' });
  assert.equal((await staff('PUT', `/journeys/patients/${patient.id}/prefs`, { newsletter: true })).status, 200);
  const b = await staff('POST', '/journeys/broadcasts', { kind: 'newsletter', title: 'Fall news', subject: 'News from {practice}', body: 'Hi {first_name}! New hours this fall.' });
  assert.equal(b.status, 201);
  assert.equal((await staff('GET', `/journeys/broadcasts/${b.data.id}/audience`)).data.count, 1);
  const [s1, s2] = await Promise.all([staff('POST', `/journeys/broadcasts/${b.data.id}/send`), staff('POST', `/journeys/broadcasts/${b.data.id}/send`)]);
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  const n = box.sent.length;
  await extras(pid, new Date());
  await extras(pid, new Date());
  const mine = sentSince(n).filter((m) => m.to === patient.email);
  assert.equal(mine.length, 1);
  assert.equal(sentSince(n).filter((m) => m.to === other.email).length, 0, 'not opted in');
  assert.match(mine[0].body, /^Hi Jane! New hours this fall\./);
  const token = /unsubscribe-news\/([\w-]+)/.exec(mine[0].body)[1];
  assert.equal((await staff('GET', '/journeys/broadcasts')).data.broadcasts[0].status, 'sent');
  const un = await call()('POST', `/public/journeys/unsubscribe/${token}`);
  assert.equal(un.status, 200);
  assert.equal((await staff('GET', `/journeys/patients/${patient.id}/prefs`)).data.newsletter, false);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'journey.newsletter.unsubscribe' AND entity_id = ?", patient.id);
  assert.equal(a.source, 'patient');
});

test('practice isolation: another practice’s moments, certificates, cards, prefs and broadcasts are out of reach', async () => {
  const a = await setUp();
  const b = await setUp();
  const kid = await addPatient(a.api, { first_name: 'Iso', dob: `${Number(TODAY.slice(0, 4)) - 6}-01-01` });
  await appt(a.pid, kid.id, a.provider.id, `${TODAY} 08:00`, 'completed');
  await procedure(a.pid, kid.id, a.provider.id, { code: 'D0120', category: 'diagnostic', description: 'Periodic oral evaluation', fee: 6000, completedAt: `${TODAY} 08:20` });
  await extras(a.pid, at(TODAY, '12:00'));
  const m = await h.db.get('SELECT * FROM journey_moments WHERE patient_id = ?', kid.id);
  assert.ok(m);
  assert.equal((await b.staff('GET', `/journeys/moments/${m.id}/certificate`)).status, 404);
  assert.equal((await b.staff('POST', `/journeys/moments/${m.id}/dismiss`)).status, 404);
  assert.equal((await b.staff('GET', `/journeys/patients/${kid.id}/prefs`)).status, 404);
  assert.equal((await b.staff('POST', '/journeys/referrals', { referrer_patient_id: b.patient.id, referred_patient_id: kid.id })).status, 404);
  const bc = await a.staff('POST', '/journeys/broadcasts', { kind: 'holiday', title: 'Winter', body: 'Happy holidays!' });
  assert.equal((await b.staff('POST', `/journeys/broadcasts/${bc.data.id}/send`)).status, 404);
  const huddle = (await b.staff('GET', `/journeys/moments?date=${TODAY}`)).data;
  assert.ok(!huddle.milestones.some((x) => x.patient_id === kid.id));
  // Each practice's switches are its own.
  await on(a.staff, 'thankyou');
  assert.equal((await b.staff('GET', '/journeys')).data.journeys.find((j) => j.key === 'thankyou').enabled, false);
});

test('no clinical detail in any journey message sent by these tests', async () => {
  const rows = await h.db.all("SELECT body FROM messages WHERE kind = 'journey'");
  assert.ok(rows.length >= 10);
  for (const r of rows) assert.doesNotMatch(r.body, CLINICAL, r.body);
});
