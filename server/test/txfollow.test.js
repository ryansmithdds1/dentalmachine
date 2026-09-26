// Treatment follow-up (TF1–TF4, docs/workflows/specs/TF-treatment-followup.md): the cadence engine's 'treatment'
// type — who is picked up (diagnosed, not scheduled) and from when (the diagnosis date), the sequence per urgency,
// the stop rules, no clinical detail in texts — and the doctor's letter: a draft that waits for the doctor, sent
// once on approval (email with the PDF, mail), filed on the chart and recorded as the informed notice, the picture
// with the area marked, practice isolation, permissions and the AI's limits.
// The routes aren't mounted in app.js by this file's author, so the tests mount them on a small app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.js';
import { runCadences, addDays } from '../src/cadence.js';
import cadenceRoutes from '../src/routes/cadence.js';
import txFollowRoutes, { txFollowPublicRoutes } from '../src/routes/txfollow.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { createStorage } from '../src/storage.js';
import { encodePng } from '../src/dicomimage.js';
import { toothWords } from '../src/txwords.js';

const box = { sent: [], mail: [] };
const messenger = {
  status: { sms: 'test', email: 'test' },
  send: async (m) => {
    box.sent.push(m);
    return { provider_id: `t-${box.sent.length}` };
  },
};
const mailer = { enabled: true, name: 'Test mail', sendLetter: async (x) => { box.mail.push(x); return { reference: `ltr_${box.mail.length}`, expected_delivery_date: null }; } };
const aiCalls = [];
const fakeAi = async (_config, args) => {
  aiCalls.push(args);
  return { diagnosis: 'a small crack in a back tooth', why: 'It keeps the tooth strong.', risk: 'It can split.', reason: 'Based on the crown on the plan.' };
};
const h = harness({ messenger });
const SECRET = 'test-secret';
const APP = 'https://app.example.com';
const D0 = new Date().toISOString().slice(0, 10); // links are checked against the real clock
const at = (date, hm = '15:00') => new Date(`${date}T${hm}:00Z`);
// Birthdays well away from every day these tests run (D0 to D0 + 120, and D0 + 400): the birthday journey is on by
// default, and its text would be counted with the treatment follow-ups (a Jan 1 birth date broke this on Dec 31).
const DOB = `1972${addDays(D0, 200).slice(4)}`;
const dir = mkdtempSync(join(tmpdir(), 'dm-txf-'));
const storage = createStorage({ dir, key: 'txfollow-test-key', s3: null });

let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20)); // Postgres takes longer to open
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/public', txFollowPublicRoutes({ db: h.db, config: { appUrl: APP }, secret: SECRET, storage }));
  const api = express.Router();
  api.use(authenticate(h.db, SECRET));
  api.use((req, _res, next) => {
    const ai = req.get('X-Acting-For') === 'assistant';
    setActor({ source: ai ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: ai ? `Assistant (for ${req.user.name})` : req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(cadenceRoutes({ db: h.db, messenger, mailer, config: { appUrl: APP }, secret: SECRET }));
  api.use(txFollowRoutes({ db: h.db, messenger, mailer, config: { appUrl: APP }, secret: SECRET, storage, structured: fakeAi }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (token, headers = {}) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const staff = call(p.token);
  await h.db.run('UPDATE patients SET dob = ? WHERE id = ?', DOB, p.patient.id);
  const on = await staff('PUT', '/txfollow/settings', { enabled: true, from_date: '2000-01-01' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  return { ...p, pid, staff };
}
async function makePlan(pid, patientId, { codes = ['D2740'], tooth = '30', created = D0, status = 'proposed', providerId = null } = {}) {
  const { id: planId } = await h.db.run('INSERT INTO treatment_plans (practice_id, patient_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)', pid, patientId, 'Plan', status, `${created} 15:00:00`);
  for (const code of codes) {
    const c = await h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code);
    await h.db.run(
      "INSERT INTO procedures (practice_id, patient_id, treatment_plan_id, provider_id, code_id, code, description, category, tooth, fee, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')",
      pid, patientId, planId, providerId, c.id, c.code, c.description, c.category, c.requires_tooth ? tooth : null, c.fee,
    );
  }
  return planId;
}
const newPatient = async (api, first, extra = {}) => (await api.post('/patients', { first_name: first, last_name: 'Tx', dob: DOB, phone: '(512) 555-0177', email: `${first.toLowerCase()}@example.com`, address: '1 Oak', city: 'Austin', state: 'TX', zip: '78701', ...extra })).data;
const run = (pid, date, hm) => runCadences(h.db, { messenger, mailer, appUrl: APP, secret: SECRET, now: at(date, hm), practiceIds: [pid] });
const enrollmentOf = (planId) => h.db.get("SELECT e.*, s.subtype FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.source_type = 'treatment_plan' AND e.source_id = ? ORDER BY e.id DESC LIMIT 1", planId);

test('plain words for a tooth', () => {
  assert.equal(toothWords('30'), 'lower right back tooth');
  assert.equal(toothWords('8'), 'upper right front tooth');
  assert.equal(toothWords('11'), 'upper left eye tooth');
  assert.equal(toothWords('24'), 'lower left front tooth');
  assert.equal(toothWords('A'), 'upper right back baby tooth');
  assert.equal(toothWords('x'), '');
});

test('TF1: a recommended sequence per urgency, editable in the sequence editor', async () => {
  const { staff, pid } = await setUp();
  const got = await staff('GET', '/cadence/sequences?type=treatment');
  assert.equal(got.status, 200);
  const by = Object.fromEntries(got.data.sequences.map((s) => [s.subtype, s]));
  assert.deepEqual(Object.keys(by).sort(), ['elective', 'soon', 'urgent']);
  assert.deepEqual(by.soon.steps.map((s) => `${s.offset_days}:${s.channel}`), ['2:text', '7:email', '14:task_call', '30:text', '60:email', '90:letter']);
  assert.ok(by.urgent.steps.some((s) => s.channel === 'letter' && s.offset_days === 30), 'urgent work gets the doctor’s letter sooner');
  assert.ok(!by.elective.steps.some((s) => s.channel === 'letter'), 'elective work gets no letter by default');
  for (const s of Object.values(by)) assert.equal(s.family_window_days, 0, 'treatment is never grouped into a family message');
  for (const s of Object.values(by).flatMap((x) => x.steps).filter((x) => x.channel === 'text')) assert.doesNotMatch(s.template, /\{visit\}/, 'texts never name the work');
  // The office edits a sequence (admin): day 2 text becomes day 3.
  const steps = by.soon.steps.map((s) => ({ id: s.id, offset_days: s.offset_days === 2 ? 3 : s.offset_days, channel: s.channel, template: s.template, subject: s.subject, conditions: s.conditions }));
  const saved = await staff('PUT', `/cadence/sequences/${by.soon.id}`, { steps });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.steps[0].offset_days, 3);
  const reset = await staff('POST', `/cadence/sequences/${by.soon.id}/reset`, {});
  assert.equal(reset.data.steps[0].offset_days, 2);
  // The switch is off until an administrator turns it on, and is audited.
  const off = await staff('PUT', '/txfollow/settings', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await h.db.get('SELECT treatment_cadence FROM practices WHERE id = ?', pid)).treatment_cadence, 0);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'cadence.treatment.off'", pid));
  await staff('PUT', '/txfollow/settings', { enabled: true, from_date: '2000-01-01' });
});

test('TF1/TF2: diagnosed, unscheduled work is picked up by urgency from the diagnosis date; texts carry no clinical detail, emails and calls name the work and the cost', async () => {
  const { staff, pid, patient, api } = await setUp();
  const crown = await makePlan(pid, patient.id, { codes: ['D2740'], tooth: '30' });
  const rctPatient = await newPatient(api, 'Rory');
  const rct = await makePlan(pid, rctPatient.id, { codes: ['D3330'], tooth: '19' });
  const orthoPatient = await newPatient(api, 'Olive');
  const ortho = await makePlan(pid, orthoPatient.id, { codes: ['D8080'] });
  const n = box.sent.length;
  await run(pid, addDays(D0, 1));
  const eCrown = await enrollmentOf(crown);
  assert.equal(eCrown.anchor_date, D0, 'anchored on the diagnosis date');
  assert.equal(eCrown.subtype, 'soon');
  assert.equal((await enrollmentOf(rct)).subtype, 'urgent');
  assert.equal((await enrollmentOf(ortho)).subtype, 'elective');
  // Day 1: only the urgent root canal's text.
  const day1 = box.sent.slice(n);
  assert.equal(day1.length, 1);
  assert.equal(day1[0].channel, 'sms');
  // Day 2: the crown's text. No treatment, tooth, code or money in any text — only the office and a link.
  await run(pid, addDays(D0, 2));
  const texts = box.sent.slice(n).filter((m) => m.channel === 'sms');
  assert.equal(texts.length, 2);
  for (const m of texts) {
    assert.doesNotMatch(m.body, /crown|root canal|tooth|#\d|D\d{4}|\$|braces|decay|infection/i, `no clinical detail in a text: ${m.body}`);
    assert.match(m.body, /https:\/\/app\.example\.com\/api\/public\/txf\/\d+\.[\w-]{22}/);
  }
  // Day 3: the root canal's call for the team.
  await run(pid, addDays(D0, 3));
  // Day 7: the crown's email names the work and the patient's cost (no insurance: the full fee).
  const n7 = box.sent.length;
  await run(pid, addDays(D0, 7));
  const email = box.sent.slice(n7).find((m) => m.channel === 'email' && m.to === 'jane@example.com');
  assert.ok(email, 'the day-7 email went');
  assert.match(email.body, /we recommended a crown \(your estimated cost: \$1,350\.00\)/);
  const msg = await h.db.get('SELECT kind FROM messages WHERE practice_id = ? AND to_address = ? ORDER BY id DESC LIMIT 1', pid, 'jane@example.com');
  assert.equal(msg.kind, 'treatment_followup');
  // Day 3 for the root canal was a call for the team: a task with the script, on the calls list.
  const task = await h.db.get("SELECT * FROM tasks WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 1", pid, rctPatient.id);
  assert.match(task.title, /^Treatment follow-up call: Rory — a root canal/);
  const calls = await staff('GET', '/txfollow/calls');
  const c = calls.data.calls.find((x) => x.patient_id === rctPatient.id);
  assert.ok(c);
  assert.match(c.script, /the doctor recommended a root canal \(your estimated cost: \$1,250\.00\)/);
  assert.equal(c.urgency, 'urgent');
  // One click logs the outcome (the existing cadence route); "left message" carries on.
  const logged = await staff('POST', `/cadence/runs/${c.id}/outcome`, { outcome: 'left_message' });
  assert.equal(logged.status, 200);
  assert.equal((await enrollmentOf(rct)).status, 'active');
  // Everything the job did was the automation, never a person.
  const audits = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action IN ('cadence.enroll','cadence.step.sent')", pid);
  assert.ok(audits.length >= 4);
  for (const a of audits) {
    assert.equal(a.source, 'automation');
    assert.equal(a.user_id, null);
  }
  // The link in the text opens the plan page (a fresh /tp/ link behind a date-of-birth check).
  const link = /https:\/\/app\.example\.com(\/api\/public\/txf\/[\w.-]+)/.exec(texts.find((m) => m.to.replace(/\D/g, '').endsWith('5550100')).body)[1];
  const opened = await fetch(`${origin}${link}`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  const tp = /\/tp\/([\w-]+)$/.exec(opened.headers.get('location'))[1];
  const view = await fetch(`${h.origin}/api/public/tp/${tp}`);
  assert.equal(view.status, 403, 'the plan page asks for the date of birth first');
  assert.match((await view.json()).error, /date of birth/);
});

test('TF1: stops when booked, done, declined in writing, other option chosen, urgency changed; held and opted-out patients are never enrolled', async () => {
  const { pid, api, provider } = await setUp();
  const mk = async (first) => newPatient(api, first);
  const [booked, done, declined, refused, held, quiet, moved] = [await mk('Booked'), await mk('Done'), await mk('Declined'), await mk('Refused'), await mk('Held'), await mk('Quiet'), await mk('Moved')];
  const pBooked = await makePlan(pid, booked.id);
  const pDone = await makePlan(pid, done.id);
  const pDeclined = await makePlan(pid, declined.id);
  const pRefused = await makePlan(pid, refused.id);
  await makePlan(pid, held.id);
  await makePlan(pid, quiet.id);
  const pMoved = await makePlan(pid, moved.id);
  // Two options for the same work (Option A / Option B): followed up once.
  const opt = await mk('Options');
  const optA = await makePlan(pid, opt.id);
  const optB = await makePlan(pid, opt.id, { codes: ['D6010'] });
  await h.db.run("UPDATE treatment_plans SET option_group = 'g1' WHERE id IN (?, ?)", optA, optB);
  await h.db.run("INSERT INTO cadence_holds (practice_id, patient_id, reason) VALUES (?, ?, 'no_contact')", pid, held.id);
  await h.db.run('UPDATE patients SET sms_opt_in = 0, email_opt_in = 0 WHERE id = ?', quiet.id);
  await run(pid, addDays(D0, 1));
  assert.ok(await enrollmentOf(pBooked));
  assert.ok(await enrollmentOf(optA));
  assert.equal(await enrollmentOf(optB), undefined, 'one follow-up for the two options');
  assert.equal(await h.db.get("SELECT id FROM cadence_enrollments WHERE patient_id = ?", held.id), undefined, 'held: never enrolled');
  assert.equal(await h.db.get("SELECT id FROM cadence_enrollments WHERE patient_id = ?", quiet.id), undefined, 'opted out of everything: never enrolled');

  // The work goes on the schedule; another is done; one plan is declined; one patient signs an informed refusal.
  const day = addDays(D0, 20);
  const { id: apptId } = await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, booked.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  await h.db.run('UPDATE procedures SET appointment_id = ? WHERE treatment_plan_id = ?', apptId, pBooked);
  await h.db.run("UPDATE procedures SET status = 'completed', completed_at = datetime('now') WHERE treatment_plan_id = ?", pDone);
  await h.db.run("UPDATE treatment_plans SET status = 'rejected' WHERE id = ?", pDeclined);
  const { id: tpl } = await h.db.run("INSERT INTO form_templates (practice_id, name, kind, fields) VALUES (?, 'Informed refusal', 'consent', '[]')", pid);
  await h.db.run("INSERT INTO patient_forms (practice_id, patient_id, template_id, kind, data, signature_name, signed_at) VALUES (?, ?, ?, 'consent', '{}', 'Refused Tx', ?)", pid, refused.id, tpl, `${addDays(D0, 3)} 10:00:00`);
  // The doctor marks one plan urgent: it moves to the urgent sequence.
  await h.db.run("UPDATE treatment_plans SET followup_urgency = 'urgent' WHERE id = ?", pMoved);
  // The patient accepts Option B: Option A's follow-up stops, B's starts.
  await h.db.run("UPDATE treatment_plans SET status = 'accepted' WHERE id = ?", optB);
  const lastMsg = Number((await h.db.get('SELECT MAX(id) AS id FROM messages')).id || 0);
  await run(pid, addDays(D0, 7));
  const reason = async (planId) => (await h.db.get("SELECT stop_reason FROM cadence_enrollments WHERE source_type = 'treatment_plan' AND source_id = ? ORDER BY id LIMIT 1", planId)).stop_reason;
  assert.equal(await reason(pBooked), 'booked');
  assert.equal((await enrollmentOf(pBooked)).booked_appointment_id, apptId);
  assert.equal(await reason(pDone), 'treatment_done');
  assert.equal(await reason(pDeclined), 'declined');
  assert.equal(await reason(pRefused), 'declined');
  assert.equal(await reason(pMoved), 'urgency_changed');
  assert.equal(await reason(optA), 'other_option');
  // Nobody who stopped got the day-7 email.
  for (const p of [booked, done, declined, refused]) {
    const got = await h.db.get("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND kind = 'treatment_followup' AND id > ?", p.id, lastMsg);
    assert.equal(Number(got.n), 0, `${p.first_name} got no treatment follow-up after stopping`);
  }
  await run(pid, addDays(D0, 8));
  const again = await enrollmentOf(pMoved);
  assert.equal(again.subtype, 'urgent', 'enrolled on its new sequence');
  assert.equal(again.status, 'active');
  assert.equal((await enrollmentOf(optB)).status, 'active', 'the chosen option is followed up now');
});

test('TF3: the letter step makes a draft that waits for the doctor — nothing is sent or mailed until it is approved', async () => {
  const { pid, patient, staff } = await setUp();
  const plan = await makePlan(pid, patient.id, { created: D0 });
  const n = box.sent.length;
  const m = box.mail.length;
  // A late start: the plan is 90 days old when the office switches on. The letter is the step that counts.
  await run(pid, addDays(D0, 90));
  const e = await enrollmentOf(plan);
  const runs = await h.db.all('SELECT r.*, s.channel AS step_channel FROM cadence_runs r JOIN cadence_steps s ON s.id = r.step_id WHERE r.enrollment_id = ? ORDER BY s.offset_days', e.id);
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'task']);
  assert.equal(runs[5].step_channel, 'letter');
  const letter = await h.db.get('SELECT * FROM txf_letters WHERE treatment_plan_id = ?', plan);
  assert.equal(letter.status, 'draft');
  assert.equal(letter.run_id, runs[5].id);
  assert.equal(letter.source, 'automation');
  assert.match(letter.diagnosis, /cracked or too weak to hold a filling/);
  assert.equal(letter.treatment, 'a crown on your lower right back tooth (#30)');
  assert.equal(letter.cost, 135000);
  assert.equal(box.sent.length, n, 'nothing sent to the patient');
  assert.equal(box.mail.length, m, 'nothing mailed');
  // More passes: still one draft, still nothing sent, the enrollment waits (not completed).
  await run(pid, addDays(D0, 91));
  await run(pid, addDays(D0, 120));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM txf_letters WHERE treatment_plan_id = ?', plan)).n, 1);
  assert.equal(box.sent.length, n);
  assert.equal(box.mail.length, m);
  assert.equal((await enrollmentOf(plan)).status, 'active');
  // It's on the doctor's list.
  const list = await staff('GET', '/txfollow/letters');
  const row = list.data.letters.find((l) => l.id === letter.id);
  assert.ok(row);
  assert.equal(row.status, 'draft');
  assert.equal(row.can_approve, true);
});

test('TF3: approving sends it once (email with the PDF, and mail), files it on the chart and records the informed notice', async () => {
  const { pid, patient, staff } = await setUp();
  const plan = await makePlan(pid, patient.id, { created: D0 });
  await run(pid, addDays(D0, 90));
  const letter = await h.db.get('SELECT * FROM txf_letters WHERE treatment_plan_id = ?', plan);
  // The doctor edits a sentence and asks for a paper copy too.
  const edited = await staff('PUT', `/txfollow/letters/${letter.id}`, { risk: 'It can break below the gum and then may not be savable.', send_mail: true });
  assert.equal(edited.status, 200);
  const n = box.sent.length;
  const m = box.mail.length;
  // A double click: two approvals at once, one letter.
  const [a, b] = await Promise.all([staff('POST', `/txfollow/letters/${letter.id}/approve`, {}), staff('POST', `/txfollow/letters/${letter.id}/approve`, {})]);
  const oks = [a, b].filter((x) => x.status === 200);
  assert.ok(oks.length >= 1);
  const emails = box.sent.slice(n);
  assert.equal(emails.length, 1, 'one email');
  assert.equal(emails[0].channel, 'email');
  assert.equal(emails[0].to, 'jane@example.com');
  assert.match(emails[0].subject, /A note from Dr\. Ann Lee about your care/);
  assert.equal(emails[0].attachments[0].type, 'application/pdf');
  assert.match(emails[0].attachments[0].content.subarray(0, 8).toString('latin1'), /^%PDF-1\.4/);
  assert.match(emails[0].html, /What I recommend/);
  assert.match(emails[0].body, /It can break below the gum/);
  assert.match(emails[0].body, /https:\/\/app\.example\.com\/api\/public\/txf\/l\./);
  assert.equal(box.mail.length - m, 1, 'one mailed letter');
  assert.equal(box.mail.at(-1).idempotencyKey, `txf-letter-${letter.id}`);
  assert.ok(box.mail.at(-1).html.length < 10_000, 'within the mail service’s page-source limit');
  const sent = await h.db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.email_status, 'sent');
  assert.equal(sent.mail_status, 'sent');
  assert.equal(sent.live_key, null);
  assert.ok(sent.approved_by);
  // Filed on the chart, next to the plan.
  const doc = await h.db.get('SELECT * FROM documents WHERE id = ?', sent.filed_document_id);
  assert.equal(doc.patient_id, patient.id);
  assert.equal(doc.treatment_plan_id, plan);
  assert.equal(doc.folder, 'Letters');
  assert.equal(doc.mime, 'application/pdf');
  assert.match((await storage.read(doc.storage_key, !!doc.encrypted)).subarray(0, 8).toString('latin1'), /^%PDF/);
  // The cadence step is done; the informed notice is on the record, by the approving person.
  const r = await h.db.get('SELECT * FROM cadence_runs WHERE id = ?', letter.run_id);
  assert.equal(r.status, 'sent');
  const notice = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'treatment_plan.informed_notice' AND entity_id = ?", pid, plan);
  assert.ok(notice);
  assert.equal(notice.source, 'human');
  assert.equal(notice.patient_id, patient.id);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'txf_letter.approve' AND entity_id = ?", pid, letter.id));
  // Approving again (or in a batch) sends nothing more.
  const again = await staff('POST', `/txfollow/letters/${letter.id}/approve`, {});
  assert.equal(again.data.already, true);
  const batch = await staff('POST', '/txfollow/letters/approve', { ids: [letter.id] });
  assert.equal(batch.data.results[0].already, true);
  assert.equal(box.sent.length - n, 1);
  assert.equal(box.mail.length - m, 1);
  // Edits after sending are refused (a sent letter is a record).
  assert.equal((await staff('PUT', `/txfollow/letters/${letter.id}`, { risk: 'x' })).status, 409);
  // The letter's link works for the patient.
  const link = /\/api\/public\/txf\/l\.[\w-]+/.exec(emails[0].body)[0];
  const opened = await fetch(`${origin}${link}`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
});

test('TF3: a letter no longer needed is cancelled at approval instead of sent; batch approve sends the rest', async () => {
  const { pid, api, staff, provider } = await setUp();
  const p1 = await newPatient(api, 'Ann');
  const p2 = await newPatient(api, 'Ben');
  const plan1 = await makePlan(pid, p1.id);
  const plan2 = await makePlan(pid, p2.id);
  const l1 = (await staff('POST', '/txfollow/letters', { treatment_plan_id: plan1 })).data;
  const l2 = (await staff('POST', '/txfollow/letters', { treatment_plan_id: plan2 })).data;
  assert.equal(l1.status, 'draft');
  assert.equal((await staff('POST', '/txfollow/letters', { treatment_plan_id: plan1 })).data.existing, true, 'one open letter per plan');
  // Ann books before the doctor gets to the list.
  const day = addDays(D0, 400);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, p1.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  const n = box.sent.length;
  const res = await staff('POST', '/txfollow/letters/approve', { ids: [l1.id, l2.id] });
  assert.equal(res.status, 200);
  const r1 = res.data.results.find((x) => x.id === l1.id);
  assert.equal(r1.cancelled, true);
  assert.match(r1.reason, /Booked/);
  assert.equal(res.data.sent, 1);
  assert.equal(box.sent.slice(n).filter((m) => m.to === p1.email).length, 0);
  assert.equal(box.sent.slice(n).filter((m) => m.to === p2.email).length, 1);
});

test('TF3: the picture with the area marked renders in the letter (HTML and PDF); the doctor can draw on it', async () => {
  const { pid, patient, staff } = await setUp();
  const plan = await makePlan(pid, patient.id, { tooth: '30' });
  // A small grey x-ray of tooth #30, stored like every document.
  const png = encodePng(40, 30, 1, Buffer.alloc(40 * 30, 128));
  const saved = await storage.save(pid, png);
  const { id: docId } = await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key, encrypted, tooth, annotations) VALUES (?, ?, 'xray', 'pa.png', 'image/png', ?, ?, ?, '30', ?)",
    pid, patient.id, png.length, saved.storageKey, saved.encrypted ? 1 : 0, JSON.stringify([{ type: 'arrow', points: [[2, 2], [18, 13]], color: '#facc15' }, { type: 'measure', points: [[0, 0], [5, 5]] }]));
  const created = await staff('POST', '/txfollow/letters', { treatment_plan_id: plan });
  assert.equal(created.status, 201);
  const id = created.data.id;
  let got = await staff('GET', `/txfollow/letters/${id}`);
  assert.equal(got.data.letter.document_id, docId, 'the x-ray of the tooth on the plan is chosen');
  assert.deepEqual(got.data.effective_markup.map((a) => a.type), ['arrow'], 'the viewer’s own arrow is used; measurements are not');
  assert.match(got.data.html, /data:image\/png;base64,/);
  assert.match(got.data.html, /<line x1="2" y1="2" x2="18" y2="13"/);
  // The doctor circles the spot instead.
  const put = await staff('PUT', `/txfollow/letters/${id}`, { markup: [{ type: 'circle', points: [[20, 15], [28, 15]] }] });
  assert.equal(put.status, 200);
  got = await staff('GET', `/txfollow/letters/${id}`);
  assert.match(got.data.html, /<circle cx="20" cy="15" r="8\.0" fill="none" stroke="#dc2626"/);
  assert.match(got.data.html, /the marked area is what concerns me/);
  const pdf = await staff('GET', `/txfollow/letters/${id}/pdf`);
  assert.equal(pdf.status, 200);
  const text = pdf.data.toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/Subtype \/Image \/Width 40 \/Height 30/);
  assert.match(text, /0\.863 0\.149 0\.149 RG/, 'the mark is drawn in red');
  assert.match(text, / c S/, 'the circle is drawn as curves over the picture');
  // Marks are checked; a picture must be this patient's.
  assert.equal((await staff('PUT', `/txfollow/letters/${id}`, { markup: [{ type: 'blob', points: [[1, 1]] }] })).status, 400);
  assert.equal((await staff('PUT', `/txfollow/letters/${id}`, { markup: [{ type: 'circle', points: [['x', 1], [2, 2]] }] })).status, 400);
});

test('TF3: AI may reword the draft (labelled, as the AI) but never sends; the assistant cannot approve without a yes on screen', async () => {
  const { pid, patient, staff, token } = await setUp();
  const plan = await makePlan(pid, patient.id);
  const l = (await staff('POST', '/txfollow/letters', { treatment_plan_id: plan })).data;
  const n = box.sent.length;
  const ai = await staff('POST', `/txfollow/letters/${l.id}/ai-draft`, {});
  assert.equal(ai.status, 200);
  assert.equal(ai.data.ai_drafted, true);
  assert.equal(ai.data.status, 'draft', 'still a draft');
  assert.equal(ai.data.risk, 'It can split.');
  assert.doesNotMatch(aiCalls.at(-1).content, /Jane|Doe|1985/, 'no name or birth date goes to the AI');
  assert.equal(box.sent.length, n, 'the AI sent nothing');
  const a = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'txf_letter.ai_draft' AND entity_id = ?", pid, l.id);
  assert.equal(a.source, 'ai');
  // The assistant asking to approve: refused without the on-screen yes.
  const assistant = call(token, { 'X-Acting-For': 'assistant' });
  const refused = await assistant('POST', `/txfollow/letters/${l.id}/approve`, {});
  assert.equal(refused.status, 428);
  assert.equal((await h.db.get('SELECT status FROM txf_letters WHERE id = ?', l.id)).status, 'draft');
  assert.equal(box.sent.length, n);
});

test('TF3: permissions — only the signing doctor (or, for a doctor without a login, anyone who signs notes) approves; front desk cannot', async () => {
  const { pid, patient, staff, api } = await setUp();
  const mkUser = async (role, name) => {
    const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const u = (await api.post('/users', { email, name, role, password: 'a-long-enough-password' })).data;
    const tok = (await h.client().post('/auth/login', { email, password: 'a-long-enough-password' })).data.token;
    return { id: u.id, call: call(tok) };
  };
  const desk = await mkUser('front_desk', 'Desk');
  const drA = await mkUser('dentist', 'Dr A');
  const drB = await mkUser('dentist', 'Dr B');
  const { id: provA } = await h.db.run("INSERT INTO providers (practice_id, user_id, name, type) VALUES (?, ?, 'Dr. Amy Ames, DDS', 'dentist')", pid, drA.id);
  const plan = await makePlan(pid, patient.id, { providerId: provA });
  const l = (await staff('POST', '/txfollow/letters', { treatment_plan_id: plan })).data;
  assert.equal(l.provider_id, provA, 'signed by the dentist on the plan');
  assert.equal((await desk.call('POST', `/txfollow/letters/${l.id}/approve`, {})).status, 403);
  assert.equal((await desk.call('GET', `/txfollow/letters/${l.id}`)).status, 200, 'front desk can read it');
  const other = await drB.call('POST', `/txfollow/letters/${l.id}/approve`, {});
  assert.equal(other.status, 403);
  assert.match(other.data.error, /Only Dr\. Amy Ames/);
  assert.equal((await staff('POST', `/txfollow/letters/${l.id}/approve`, {})).status, 403, 'not even an administrator signs for the doctor');
  const mine = await drA.call('POST', `/txfollow/letters/${l.id}/approve`, {});
  assert.equal(mine.status, 200);
  assert.equal(mine.data.letter.status, 'sent');
  // Doctors set their own signature; others can't.
  const sig = `data:image/png;base64,${encodePng(4, 2, 1, Buffer.alloc(8, 0)).toString('base64')}`;
  assert.equal((await drB.call('PUT', `/txfollow/doctors/${provA}`, { signature: sig })).status, 403);
  assert.equal((await drA.call('PUT', `/txfollow/doctors/${provA}`, { signature: sig, credentials: 'DDS', title: 'General dentist' })).status, 200);
  assert.equal((await drA.call('PUT', `/txfollow/doctors/${provA}`, { signature: 'data:image/png;base64,AAAA' })).status, 400, 'not a real image');
  // Settings: administrators only.
  assert.equal((await drA.call('PUT', '/txfollow/settings', { enabled: false })).status, 403);
  assert.equal((await desk.call('PUT', '/txfollow/letter-setup', { brand_color: '#123456' })).status, 403);
});

test('practice isolation: another practice can’t see, edit or approve a letter, or use its pictures', async () => {
  const one = await setUp();
  const two = await setUp();
  const plan = await makePlan(one.pid, one.patient.id);
  const l = (await one.staff('POST', '/txfollow/letters', { treatment_plan_id: plan })).data;
  assert.equal((await two.staff('GET', `/txfollow/letters/${l.id}`)).status, 404);
  assert.equal((await two.staff('PUT', `/txfollow/letters/${l.id}`, { risk: 'x' })).status, 404);
  assert.equal((await two.staff('POST', `/txfollow/letters/${l.id}/approve`, {})).status, 404);
  assert.equal((await two.staff('POST', '/txfollow/letters', { treatment_plan_id: plan })).status, 404);
  assert.ok(!(await two.staff('GET', '/txfollow/letters')).data.letters.some((x) => x.id === l.id));
  // A picture from the other practice's patient can't be put on this letter.
  const png = encodePng(4, 4, 1, Buffer.alloc(16, 9));
  const saved = await storage.save(two.pid, png);
  const { id: foreign } = await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key) VALUES (?, ?, 'xray', 'x.png', 'image/png', ?, ?)", two.pid, two.patient.id, png.length, saved.storageKey);
  assert.equal((await one.staff('PUT', `/txfollow/letters/${l.id}`, { document_id: foreign })).status, 400);
  // The board only counts this practice's patients.
  await run(one.pid, addDays(D0, 2));
  const b2 = await two.staff('GET', '/txfollow/board');
  assert.equal(b2.data.patients.filter((p) => p.patient_id === one.patient.id).length, 0);
});

test('TF4: the board shows who is at which step, what each step booked ($ scheduled), and who reached the end without booking; metrics add up', async () => {
  const { pid, api, staff, provider } = await setUp();
  const a = await newPatient(api, 'Amy');
  const b = await newPatient(api, 'Bob');
  const c = await newPatient(api, 'Cal');
  const planA = await makePlan(pid, a.id, { codes: ['D2391'], tooth: '3' });
  await makePlan(pid, b.id, { codes: ['D2740'], tooth: '14' });
  const planC = await makePlan(pid, c.id, { codes: ['D8080'] }); // elective: ends at day 180 without a letter
  await run(pid, addDays(D0, 2));
  await run(pid, addDays(D0, 7));
  // Amy books after the day-7 email: the email gets the credit, with the work's fee.
  const day = addDays(D0, 30);
  const { id: appt } = await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, a.id, provider.id, `${day} 09:00`, `${day} 10:00`);
  await h.db.run('UPDATE procedures SET appointment_id = ? WHERE treatment_plan_id = ?', appt, planA);
  await run(pid, addDays(D0, 8));
  const board = await staff('GET', '/txfollow/board?days=730');
  assert.equal(board.status, 200);
  assert.equal(board.data.totals.booked, 1);
  const credit = board.data.by_step.find((s) => s.label === 'Day 7 · Email');
  assert.ok(credit, JSON.stringify(board.data.by_step));
  assert.equal(credit.booked, 1);
  assert.equal(credit.scheduled, 18500);
  const bob = board.data.patients.find((p) => p.patient_id === b.id);
  assert.equal(bob.stage, 'Day 7 · Email');
  assert.equal(bob.treatment, 'a crown');
  assert.ok(board.data.stages.some((s) => s.label === 'Day 7 · Email' && s.count >= 1));
  // Cal runs out of steps (elective, last step day 180) without booking: at the end of the cadence.
  for (const d of [30, 60]) await run(pid, addDays(D0, d));
  // Cal's day-60 call: no answer, a message left (the call stays on the list until someone logs it).
  const calCall = (await staff('GET', '/txfollow/calls')).data.calls.find((x) => x.patient_id === c.id);
  assert.ok(calCall);
  assert.equal((await staff('POST', `/cadence/runs/${calCall.id}/outcome`, { outcome: 'left_message' })).status, 200);
  for (const d of [120, 180, 181]) await run(pid, addDays(D0, d));
  const end = await staff('GET', '/txfollow/board?days=730');
  const cal = end.data.end_of_cadence.find((p) => p.patient_id === c.id);
  assert.ok(cal, 'Cal is on the end-of-cadence list');
  assert.equal((await enrollmentOf(planC)).status, 'completed');
  const metrics = await staff('GET', '/txfollow/metrics?days=730');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.booked, 1);
  assert.ok(metrics.data.end_of_cadence >= 1);
  assert.equal(typeof metrics.data.booking_rate, 'number');
  // Front desk without billing sees counts but not money? (front desk has billing:read) — a hygienist doesn't.
  const email = `hyg-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: 'Hy', role: 'assistant', password: 'a-long-enough-password' });
  const asst = call((await h.client().post('/auth/login', { email, password: 'a-long-enough-password' })).data.token);
  const noMoney = await asst('GET', '/txfollow/board?days=730');
  assert.equal(noMoney.data.totals.scheduled, null, 'no dollars without billing access');
});
