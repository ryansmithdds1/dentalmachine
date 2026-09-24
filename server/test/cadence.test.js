// The cadence engine (cadence.js) with recall as its first type (RC1, RC3, RC4): due-step math, no double
// sends, stops checked right before sending, skip rules, opt-outs and quiet hours, channel fallback, failures
// in Needs attention, family grouping, AI calls and team calls, and the automation actor on everything.
// The staff routes aren't mounted in app.js by this file's author, so the tests mount them on a small app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { runCadences, dueOccurrences, addDays, practiceToday, createLink } from '../src/cadence.js';
import cadenceRoutes from '../src/routes/cadence.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { recordOptOut } from '../src/messaging.js';

const box = { sent: [], calls: [], fail: new Set(), noCall: false };
const messenger = {
  status: { sms: 'test', email: 'test', voice: 'test' },
  send: async (m) => {
    if (box.fail.has(m.channel)) throw new Error(`${m.channel} provider is down`);
    box.sent.push(m);
    return { provider_id: `t-${box.sent.length}` };
  },
  call: async (to, url) => {
    if (box.noCall) throw new Error('calls are down');
    box.calls.push({ to, url });
    return { provider_id: `CA${box.calls.length}` };
  },
};
const h = harness({ messenger });
const SECRET = 'test-secret';
const TODAY = new Date().toISOString().slice(0, 10);
const at = (date, hm = '15:00') => new Date(`${date}T${hm}:00Z`);

let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(h.db, SECRET));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(cadenceRoutes({ db: h.db, messenger, config: { appUrl: 'https://app.example.com' }, secret: SECRET }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (token) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function setUp(extra = {}) {
  const p = await h.practice({ timezone: 'UTC', ...extra });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  await h.db.run('UPDATE practices SET recall_cadence = 1 WHERE id = ?', pid);
  return { ...p, pid, staff: call(p.token) };
}
const addRecall = async (pid, patientId, due, type = 'prophy') => (await h.db.run('INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES (?, ?, ?, 6, ?)', pid, patientId, type, due)).id;
const run = (pid, now, extra = {}) => runCadences(h.db, { messenger, appUrl: 'https://app.example.com', secret: SECRET, now, practiceIds: [pid], ...extra });
const enrollmentsOf = (patientId) => h.db.all('SELECT * FROM cadence_enrollments WHERE patient_id = ? ORDER BY id', patientId);
const runsOf = (enrollmentId) => h.db.all('SELECT r.*, s.offset_days FROM cadence_runs r JOIN cadence_steps s ON s.id = r.step_id WHERE r.enrollment_id = ? ORDER BY r.id', enrollmentId);
const sentSince = (n) => box.sent.slice(n);

test('due-step math: negative offsets, the due date itself, repeats and their order', () => {
  const steps = [
    { id: 1, position: 0, offset_days: -30 }, { id: 2, position: 1, offset_days: 0 },
    { id: 3, position: 2, offset_days: 180, repeat_days: 90, repeat_max: 2 }, { id: 4, position: 3, offset_days: 14, active: 0 },
  ];
  const ids = (today) => dueOccurrences(steps, '2026-03-01', today).map((o) => `${o.step.id}.${o.occurrence}@${o.due_date}`);
  assert.deepEqual(ids('2026-01-29'), []);
  assert.deepEqual(ids('2026-01-30'), ['1.0@2026-01-30'], '30 days before 1 March (February has 28 days)');
  assert.deepEqual(ids('2026-03-01'), ['1.0@2026-01-30', '2.0@2026-03-01']);
  assert.deepEqual(ids('2026-08-27'), ['1.0@2026-01-30', '2.0@2026-03-01'], 'a switched-off step never comes due');
  assert.deepEqual(ids('2027-06-01'), ['1.0@2026-01-30', '2.0@2026-03-01', '3.0@2026-08-28', '3.1@2026-11-26', '3.2@2027-02-24'], 'repeats stop at repeat_max');
  assert.equal(addDays('2026-03-08', -1), '2026-03-07', 'calendar days, not 24-hour steps (DST)');
  // "Today" is the practice's own date.
  const instant = new Date('2026-01-10T03:00:00Z');
  assert.equal(practiceToday({ timezone: 'America/New_York' }, instant), '2026-01-09');
  assert.equal(practiceToday({ timezone: 'Asia/Tokyo' }, instant), '2026-01-10');
});

test('the first step goes once: a text with a booking link, recall marked contacted, all recorded as automation', async () => {
  const { pid, patient } = await setUp();
  const recallId = await addRecall(pid, patient.id, addDays(TODAY, 30));
  const n = box.sent.length;
  const stats = await run(pid, at(TODAY));
  assert.equal(stats.enrolled, 1);
  const [msg] = sentSince(n);
  assert.equal(sentSince(n).length, 1);
  assert.equal(msg.channel, 'sms');
  assert.match(msg.body, /^Hi Jane, it’s time to book your checkup and cleaning at Practice \d+\. Pick a time that works for you: https:\/\/app\.example\.com\/rb\/\d+\.[\w-]{22} Reply STOP to opt out\.$/);
  const [e] = await enrollmentsOf(patient.id);
  assert.equal(e.anchor_date, addDays(TODAY, 30));
  assert.equal(e.status, 'active');
  const [r] = await runsOf(e.id);
  assert.equal(r.status, 'sent');
  assert.equal(r.offset_days, -30);
  assert.equal(r.channel, 'text');
  assert.ok(r.message_id);
  assert.equal((await h.db.get('SELECT status FROM recalls WHERE id = ?', recallId)).status, 'contacted');
  // Who did it: the automation, never a person.
  const audits = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action LIKE 'cadence.%'", pid);
  assert.ok(audits.some((a) => a.action === 'cadence.enroll'));
  assert.ok(audits.some((a) => a.action === 'cadence.step.sent'));
  for (const a of audits) {
    assert.equal(a.source, 'automation');
    assert.equal(a.user_id, null);
    assert.equal(a.actor, 'Recall autopilot');
  }
  // Running again (the next pass, or after a restart) sends nothing new.
  await run(pid, at(TODAY, '15:10'));
  await run(pid, at(TODAY, '18:00'));
  assert.equal(sentSince(n).length, 1);
  // Two weeks on, the next step.
  await run(pid, at(addDays(TODAY, 16)));
  assert.equal(sentSince(n).length, 2);
  assert.match(sentSince(n)[1].body, /^Reminder from Practice \d+: your checkup and cleaning is due/);
});

test('no double send when two job runs race, and a claim left by a crash is never re-sent', async () => {
  const { pid, patient } = await setUp();
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  const n = box.sent.length;
  await Promise.all([run(pid, at(TODAY)), run(pid, at(TODAY)), run(pid, at(TODAY))]);
  assert.equal(sentSince(n).length, 1, 'three concurrent passes, one text');
  const [e] = await enrollmentsOf(patient.id);
  assert.equal((await runsOf(e.id)).length, 1);

  // A crash between claiming and sending: the claim stays behind. It's never retried (it may have gone) — it
  // becomes a failure someone looks at.
  const step = await h.db.get('SELECT * FROM cadence_steps WHERE sequence_id = ? AND offset_days = -14', e.sequence_id);
  await h.db.run("INSERT INTO cadence_runs (practice_id, enrollment_id, step_id, occurrence, patient_id, due_date, status, created_at) VALUES (?, ?, ?, 0, ?, ?, 'claimed', '2000-01-01 00:00:00')",
    pid, e.id, step.id, patient.id, addDays(TODAY, 16));
  await run(pid, at(addDays(TODAY, 16)));
  assert.equal(sentSince(n).length, 1, 'the claimed step is not sent again');
  const left = await h.db.get('SELECT * FROM cadence_runs WHERE enrollment_id = ? AND step_id = ?', e.id, step.id);
  assert.equal(left.status, 'failed');
  assert.match(left.result, /Interrupted/);
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", pid, `cadence:${e.id}`));
  await run(pid, at(addDays(TODAY, 18)));
  assert.equal(sentSince(n).length, 1, 'and the retry pass leaves it alone');
});

test('a visit booked while the job is running stops the step right before it is sent', async () => {
  const { pid, patient, provider } = await setUp();
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  await run(pid, at(TODAY));
  const [e] = await enrollmentsOf(patient.id);
  const firstStep = (await runsOf(e.id))[0].step_id;
  const n = box.sent.length;
  // The booking lands between the job's pass over enrollments and the send (just after the step is claimed).
  let hook = async () => {
    const day = addDays(TODAY, 40);
    await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, patient.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  };
  const spy = {
    ...h.db,
    run: async (sql, ...args) => {
      const out = await h.db.run(sql, ...args);
      if (hook && /INSERT INTO cadence_runs[\s\S]*'claimed'/.test(sql) && out.changes) {
        const f = hook;
        hook = null;
        await f();
      }
      return out;
    },
  };
  await runCadences(spy, { messenger, appUrl: 'https://app.example.com', secret: SECRET, now: at(addDays(TODAY, 16)), practiceIds: [pid] });
  assert.equal(hook, null, 'the booking happened mid-run');
  assert.equal(sentSince(n).length, 0, 'nothing sent');
  const runs = await runsOf(e.id);
  assert.equal(runs[1].status, 'skipped');
  assert.match(runs[1].result, /Stopped before sending: Booked a visit/);
  const done = (await enrollmentsOf(patient.id))[0];
  assert.equal(done.status, 'stopped');
  assert.equal(done.stop_reason, 'booked');
  assert.ok(done.booked_appointment_id);
  assert.equal(done.booked_step_id, firstStep, 'the booking is credited to the step that reached them');
});

test('skip rules: pre-appointed, inactive, deceased (hold) and opted out of everything are never enrolled', async () => {
  const { pid, patient, provider, api } = await setUp();
  const mk = async (first) => (await api.post('/patients', { first_name: first, last_name: 'Skip', dob: '1970-01-01', phone: '(512) 555-0199', email: `${first.toLowerCase()}@example.com` })).data;
  const booked = await mk('Booked');
  const gone = await mk('Gone');
  const passed = await mk('Passed');
  const quiet = await mk('Quiet');
  for (const p of [patient, booked, gone, passed, quiet]) await addRecall(pid, p.id, addDays(TODAY, 20));
  const day = addDays(TODAY, 25);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, booked.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  await h.db.run("UPDATE patients SET status = 'inactive' WHERE id = ?", gone.id);
  await h.db.run("INSERT INTO cadence_holds (practice_id, patient_id, reason, note) VALUES (?, ?, 'deceased', 'Family called')", pid, passed.id);
  await h.db.run('UPDATE patients SET sms_opt_in = 0, email_opt_in = 0 WHERE id = ?', quiet.id);
  await run(pid, at(TODAY));
  assert.equal((await enrollmentsOf(patient.id)).length, 1);
  for (const p of [booked, gone, passed, quiet]) assert.equal((await enrollmentsOf(p.id)).length, 0, `${p.first_name} is not enrolled`);

  // A hold added later stops an active enrollment on the next pass.
  await h.db.run("INSERT INTO cadence_holds (practice_id, patient_id, reason) VALUES (?, ?, 'moved')", pid, patient.id);
  await run(pid, at(addDays(TODAY, 1)));
  const [e] = await enrollmentsOf(patient.id);
  assert.equal(e.status, 'stopped');
  assert.equal(e.stop_reason, 'moved');
});

test('quiet hours hold texts until the morning; a STOP reply switches the patient to email', async () => {
  const { pid, patient } = await setUp({ send_from: '08:00', send_until: '20:00' });
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  const n = box.sent.length;
  await run(pid, at(TODAY, '03:00'));
  assert.equal(sentSince(n).length, 0, 'nothing at 3am');
  const [e] = await enrollmentsOf(patient.id);
  assert.equal((await runsOf(e.id)).length, 0, 'not even claimed: it waits');
  // The number replied STOP overnight: the text step goes by email instead.
  await recordOptOut(h.db, pid, 'sms', patient.phone, 'reply');
  await run(pid, at(TODAY, '09:00'));
  const [msg] = sentSince(n);
  assert.equal(sentSince(n).length, 1);
  assert.equal(msg.channel, 'email');
  assert.equal(msg.to, 'jane@example.com');
  const [r] = await runsOf(e.id);
  assert.equal(r.channel, 'email');
  assert.equal(r.fallback_from, 'text');
});

test('channel fallback after a failed delivery; failures become a Needs-attention item that a later success resolves', async () => {
  const { pid, patient } = await setUp();
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  const n = box.sent.length;
  box.fail = new Set(['sms']);
  await run(pid, at(TODAY));
  assert.deepEqual(sentSince(n).map((m) => m.channel), ['email'], 'the text failed, so the email went');
  const [e] = await enrollmentsOf(patient.id);
  let [r] = await runsOf(e.id);
  assert.equal(r.status, 'sent');
  assert.equal(r.channel, 'email');
  assert.equal(r.fallback_from, 'text');

  // Everything fails: the step is failed and the front desk sees it.
  box.fail = new Set(['sms', 'email']);
  await run(pid, at(addDays(TODAY, 16)));
  r = (await runsOf(e.id))[1];
  assert.equal(r.status, 'failed');
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", pid, `cadence:${e.id}`);
  assert.ok(issue, 'raised');
  assert.match(issue.title, /didn’t go/);
  // An hour later it's tried again (attempt 2); this time it goes, and the item resolves itself.
  box.fail = new Set();
  await run(pid, new Date(at(addDays(TODAY, 16)).getTime() + 2 * 3600_000));
  r = (await runsOf(e.id))[1];
  assert.equal(r.status, 'sent');
  assert.equal(r.attempts, 2);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
});

test('family members due within the window get one message offering back-to-back times', async () => {
  const { pid, patient, api } = await setUp();
  const kid = (await api.post('/patients', { first_name: 'Mia', last_name: 'Doe', dob: '2018-05-01' })).data;
  const teen = (await api.post('/patients', { first_name: 'Leo', last_name: 'Doe', dob: '2012-05-01' })).data;
  await h.db.run('UPDATE patients SET guarantor_id = ? WHERE id IN (?, ?)', patient.id, kid.id, teen.id);
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  await addRecall(pid, kid.id, addDays(TODAY, 45));
  await addRecall(pid, teen.id, addDays(TODAY, 90)); // outside the 30-day window: on its own later
  const n = box.sent.length;
  await run(pid, at(TODAY));
  const msgs = sentSince(n);
  assert.equal(msgs.length, 1, 'one message for the family');
  assert.match(msgs[0].body, /^Hi Jane, it’s time to book Jane and Mia’s checkup and cleaning at Practice \d+\. We can book everyone back-to-back\./);
  const [mine] = await enrollmentsOf(patient.id);
  const [hers] = await enrollmentsOf(kid.id);
  const [leadRun] = await runsOf(mine.id);
  const [kidRun] = await runsOf(hers.id);
  assert.equal(kidRun.grouped_with, leadRun.id);
  assert.equal(kidRun.message_id, leadRun.message_id);
  assert.equal(kidRun.offset_days, -30);
  // The link books both.
  const link = await h.db.get('SELECT * FROM cadence_links WHERE run_id = ?', leadRun.id);
  assert.deepEqual(JSON.parse(link.enrollment_ids).sort(), [mine.id, hers.id].sort());
  // Mia's own -30 day comes and goes without a second message.
  await run(pid, at(addDays(TODAY, 15)));
  assert.equal(sentSince(n).length, 1);
  assert.equal((await enrollmentsOf(teen.id)).length, 0, 'Leo is further out');
});

test('AI call step is placed and labelled ai; without calling it becomes a team call with one-click outcomes', async () => {
  const { pid, patient, api, staff } = await setUp();
  await addRecall(pid, patient.id, addDays(TODAY, -30));
  const c = box.calls.length;
  const n = box.sent.length;
  await run(pid, at(TODAY));
  assert.equal(sentSince(n).length, 0, 'a late start sends only the latest step (the call), not the missed texts');
  const [e] = await enrollmentsOf(patient.id);
  const runs = await runsOf(e.id);
  assert.deepEqual(runs.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'skipped', 'sent']);
  const aiRun = runs.at(-1);
  assert.equal(aiRun.channel, 'ai_call');
  assert.equal(aiRun.source, 'ai');
  assert.equal(box.calls.length, c + 1);
  assert.match(box.calls.at(-1).url, /^https:\/\/app\.example\.com\/api\/webhooks\/twilio\/voice\/recall\/\d+\.[\w-]{22}$/);
  const callRow = await h.db.get('SELECT * FROM calls WHERE id = ?', aiRun.call_id);
  assert.equal(callRow.source, 'ai');
  assert.equal(callRow.purpose, 'recall');
  const audit = await h.db.get("SELECT * FROM audit_log WHERE entity = 'cadence_runs' AND entity_id = ? AND action = 'cadence.step.sent'", aiRun.id);
  assert.equal(audit.source, 'ai');
  assert.equal(audit.actor, 'AI recall call');

  // Another patient, calls not working: the team gets the call on its list, with the script.
  const sam = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1970-01-01', phone: '(512) 555-0111' })).data;
  await addRecall(pid, sam.id, addDays(TODAY, -30));
  box.noCall = true;
  await run(pid, at(TODAY));
  box.noCall = false;
  const [se] = await enrollmentsOf(sam.id);
  const task = (await runsOf(se.id)).at(-1);
  assert.equal(task.status, 'task');
  assert.equal(task.channel, 'task_call');
  assert.equal(task.fallback_from, 'ai_call');
  assert.ok(await h.db.get("SELECT id FROM tasks WHERE id = ? AND status = 'open'", task.task_id));
  const list = (await staff('GET', '/cadence/calls')).data;
  const row = list.calls.find((x) => x.id === task.id);
  assert.ok(row, 'on the call list');
  assert.match(row.script, /^Hi, this is Practice \d+\. It looks like your checkup and cleaning was due on/);

  // A front-desk person logs "left message" (the cadence carries on), then another call gets "declined" (it stops).
  const deskEmail = `desk-${Date.now()}@example.com`;
  await api.post('/users', { email: deskEmail, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const deskToken = (await h.client().post('/auth/login', { email: deskEmail, password: 'front-desk-password' })).data.token;
  const desk = call(deskToken);
  assert.equal((await desk('POST', `/cadence/runs/${task.id}/outcome`, { outcome: 'nope' })).status, 400);
  const logged = await desk('POST', `/cadence/runs/${task.id}/outcome`, { outcome: 'left_message', note: 'Voicemail' });
  assert.equal(logged.status, 200);
  assert.equal(logged.data.outcome, 'left_message');
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', task.task_id)).status, 'done');
  assert.equal((await enrollmentsOf(sam.id))[0].status, 'active');
  assert.equal((await desk('POST', `/cadence/runs/${task.id}/outcome`, { outcome: 'left_message' })).status, 200, 'the same click twice is fine');
  assert.equal((await desk('POST', `/cadence/runs/${task.id}/outcome`, { outcome: 'declined' })).status, 409);
  const outcomeAudit = await h.db.get("SELECT * FROM audit_log WHERE action = 'cadence.call_outcome' AND entity_id = ?", task.id);
  assert.equal(outcomeAudit.source, 'human');
  assert.equal(outcomeAudit.actor, 'Desk');
  // Front desk can't change the sequences.
  const seq = (await desk('GET', '/cadence/sequences')).data.sequences[0];
  assert.equal((await desk('PUT', `/cadence/sequences/${seq.id}`, { name: 'Mine' })).status, 403);
});

test('sequence editor: validated, removed steps are switched off (not deleted), audited before/after; dashboard counts results', async () => {
  const { pid, patient, staff, provider } = await setUp();
  const { data } = await staff('GET', '/cadence/sequences');
  const seq = data.sequences.find((s) => s.subtype === 'prophy');
  assert.equal(seq.steps.length, 8);
  assert.equal((await staff('PUT', `/cadence/sequences/${seq.id}`, { steps: [{ offset_days: 5000, channel: 'text', template: 'x' }] })).status, 400);
  assert.equal((await staff('PUT', `/cadence/sequences/${seq.id}`, { steps: [{ offset_days: 0, channel: 'fax', template: 'x' }] })).status, 400);
  const keep = seq.steps.slice(0, 2).map((s) => ({ ...s, template: `${s.template} (edited)` }));
  const saved = await staff('PUT', `/cadence/sequences/${seq.id}`, { steps: [...keep, { offset_days: 7, channel: 'task_call', template: 'Call {first_name}' }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.steps.map((s) => `${s.offset_days}:${s.channel}`), ['-30:text', '-14:text', '7:task_call']);
  assert.equal(saved.data.steps[0].id, seq.steps[0].id, 'edited steps keep their id');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM cadence_steps WHERE sequence_id = ? AND active = 0', seq.id)).n, 6);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'cadence.sequence.update' AND entity_id = ? ORDER BY id DESC", seq.id);
  const changes = JSON.parse(a.changes);
  assert.match(changes.steps[0], /\+180d text every 90d/);
  assert.doesNotMatch(changes.steps[1], /\+180d/);

  // Results: one booked (after the first text), counted by step and office.
  await addRecall(pid, patient.id, addDays(TODAY, 30));
  await run(pid, at(TODAY));
  const day = addDays(TODAY, 35);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, patient.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  await run(pid, at(addDays(TODAY, 1)));
  const dash = (await staff('GET', '/cadence/dashboard')).data;
  assert.equal(dash.booked, 1);
  assert.equal(dash.by_step[0].label, 'Day -30 · Text');
  assert.equal(dash.by_step[0].booked, 1);
  assert.equal(dash.channels.find((c) => c.channel === 'text').sent, 1);
  assert.equal(typeof dash.scheduled, 'number');
  // Per-patient status shows the finished cadence.
  const st = (await staff('GET', `/cadence/patients/${patient.id}`)).data;
  assert.equal(st.enrollments[0].stop_label, 'Booked a visit');
});

test('practice isolation: another practice’s links and records are out of reach', async () => {
  const a = await setUp();
  const b = await setUp();
  await addRecall(b.pid, b.patient.id, addDays(TODAY, 30));
  await run(b.pid, at(TODAY));
  const [e] = await enrollmentsOf(b.patient.id);
  const [r] = await runsOf(e.id);
  assert.equal((await a.staff('GET', `/cadence/patients/${b.patient.id}`)).status, 404);
  assert.equal((await a.staff('POST', `/cadence/runs/${r.id}/outcome`, { outcome: 'reached' })).status, 404);
  assert.equal((await a.staff('POST', `/cadence/enrollments/${e.id}/stop`, { reason: 'x' })).status, 404);
  const seq = (await b.staff('GET', '/cadence/sequences')).data.sequences[0];
  assert.equal((await a.staff('PUT', `/cadence/sequences/${seq.id}`, { name: 'Taken' })).status, 404);
  // A job run for practice A never touches B.
  const link = await createLink(h.db, SECRET, { practiceId: b.pid, recipientId: b.patient.id, enrollmentIds: [e.id] });
  assert.ok(link.token);
  const stats = await run(a.pid, at(addDays(TODAY, 16)));
  assert.equal(stats.sent, 0);
});
