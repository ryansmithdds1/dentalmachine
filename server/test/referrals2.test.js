// Referral tracker (backlog RT1–RT5; docs/workflows/specs/RT-referrals.md). The signed-in routes are added to the
// app's own /api router (sign-in, the actor, the AI guard, idempotency and office access apply as in production)
// until app.js mounts them; the specialist's secure link runs on a small side server on the same database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { actorMiddleware } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { randomUUID } from 'node:crypto';
import { HttpError, signToken } from '../src/auth.js';
import { readsIdle } from '../src/docfiles.js';
import referralTrackerRoutes, { referralPublicRoutes } from '../src/routes/referraltracker.js';
import { runReferralJobs, scoreCandidate, expectedBy, DEFAULTS, addDays, todayFor } from '../src/referraltracker.js';

const h = harness();
let pub;
let pubOrigin;
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};
before(async () => {
  while (!h.origin) await new Promise((r) => setTimeout(r, 10));
  const has = (stack) => stack.some((l) => l.route?.path === '/referral-tracker/board' || (l.handle?.stack && has(l.handle.stack)));
  if (!has(h.app.router.stack)) {
    const api = h.app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0].handle;
    api.use(referralTrackerRoutes({ db: h.db, storage: h.app.locals.storage, config: h.config, messenger: h.messenger }));
  }
  const app = express();
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json());
  app.use('/api/public', referralPublicRoutes({ db, storage: h.app.locals.storage, config: h.config }));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => { pub = app.listen(0, resolve); });
  pubOrigin = `http://127.0.0.1:${pub.address().port}`;
});
after(() => pub?.close());

const pdfWith = (text) => {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const stream = Buffer.from(content, 'latin1');
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n', 'latin1')]);
};
// Files go up as the raw body (the harness client would turn a Buffer into JSON).
const upload = async (who, patientId, bytes, filename, category) => {
  const res = await fetch(`${h.origin}/api/patients/${patientId}/documents?${new URLSearchParams({ filename, category })}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/pdf' }, body: bytes });
  return { status: res.status, data: await res.json() };
};
// A session for a new staff member without the login form (its rate limit is per address).
async function staff(api, role) {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
  const made = await api.post('/users', { email, name: `${role} person`, role, password: `${role}-password-123` });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const u = await h.db.get('SELECT id, practice_id, role, token_version FROM users WHERE id = ?', made.data.id);
  const sid = `test-${randomUUID()}`;
  await h.db.run('INSERT INTO staff_sessions (sid, user_id, practice_id, last_seen_at) VALUES (?, ?, ?, ?)', sid, u.id, u.practice_id, new Date().toISOString());
  const token = signToken({ sub: u.id, pid: u.practice_id, role: u.role, aud: 'staff', tv: u.token_version ?? 0, sid }, 'test-secret');
  return { id: u.id, token, api: h.client(token) };
}
async function setup() {
  const p = await h.practice();
  const kim = (await p.api.post('/referral-contacts', { name: 'Dr. Grace Kim', practice_name: 'Riverside Endodontics', specialty: 'Endodontics', phone: '512-555-0199', email: 'kim@riverside.example.com' })).data;
  const lopez = (await p.api.post('/referral-contacts', { name: 'Dr. Mark Lopez', practice_name: 'Hill Oral Surgery', specialty: 'Oral surgery', phone: '512-555-0177' })).data;
  const dentistUser = await staff(p.api, 'dentist');
  await db.run('UPDATE providers SET user_id = ? WHERE id = ?', dentistUser.id, p.provider.id);
  const desk = await staff(p.api, 'front_desk');
  return { ...p, kim, lopez, dentistUser, desk };
}
const create = (api, patientId, body) => api.post(`/referral-tracker/patients/${patientId}/referrals`, body);

test('RT1 create: validated on the server (patient, specialist, codes, teeth, dates, files, planned work)', async () => {
  const a = await setup();
  const b = await setup();
  const pid = a.patient.id;
  const today = await todayFor(h.db, a.practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', pid)).practice_id);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id })).status, 400, 'a reason or a procedure is needed');
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', urgency: 'whenever' })).status, 400);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', referral_date: addDays(today, 3) })).status, 400, 'no future dates');
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', referral_date: '2026-02-31' })).status, 400);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, items: [{ code: 'X123' }] })).status, 400);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, items: [{ code: 'D3330', tooth: '45' }] })).status, 400);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, items: [{ code: 'D9999' }] })).status, 400, 'code not in the practice');
  assert.equal((await create(a.api, pid, { contact_id: b.kim.id, reason: 'x' })).status, 404, 'another practice’s specialist');
  assert.equal((await create(a.api, b.patient.id, { contact_id: a.kim.id, reason: 'x' })).status, 404, 'another practice’s patient');
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', send: 'pigeon' })).status, 400);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', client_key: 'bad key!' })).status, 400);
  assert.equal((await create(a.api, pid, { new_contact: { name: '' }, reason: 'x' })).status, 400);
  // A file from another patient can't ride along.
  const other = (await a.api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01' })).data;
  const doc = (await upload(a, other.id, pdfWith('xray notes'), 'notes.pdf', 'document')).data;
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, reason: 'x', document_ids: [doc.id] })).status, 404);
  // A procedure that isn't planned can't be referred out.
  const plan = (await a.api.post(`/patients/${pid}/treatment-plans`, { name: 'Endo', procedures: [{ code: 'D3330', tooth: '19', provider_id: a.provider.id }] })).data;
  await h.db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ?", plan.procedures[0].id);
  assert.equal((await create(a.api, pid, { contact_id: a.kim.id, items: [{ procedure_id: plan.procedures[0].id }] })).status, 409);
  // A new specialist typed inline is created once, and typed again is the same contact.
  const n1 = await create(a.api, pid, { new_contact: { name: 'Dr. New Perio', practice_name: 'Perio Place', specialty: 'Periodontics' }, reason: 'Perio eval', send: 'none', text_patient: false });
  const n2 = await create(a.api, pid, { new_contact: { name: 'dr. new perio', practice_name: 'perio place' }, reason: 'Perio eval 2', send: 'none', text_patient: false });
  assert.equal(n1.status, 201, JSON.stringify(n1.data));
  assert.equal(n1.data.referral.contact_id, n2.data.referral.contact_id);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM referral_contacts WHERE name = 'Dr. New Perio'")).n, 1);
});

test('RT1 create: one step — items priced, files attached, letter emailed as a secure link, patient texted; idempotent', async () => {
  const a = await setup();
  const pid = a.patient.id;
  // A PPO plan at 80% of the office fee: the item keeps both prices from today.
  const carrier = (await a.api.post('/carriers', { name: 'Delta PPO', payer_id: '94276' })).data;
  const fs = (await a.api.post('/fee-schedules', { name: 'Delta PPO', percent_of_ucr: 80 })).data;
  await a.api.put(`/fee-schedules/${fs.id}`, { carrier_ids: [carrier.id] });
  await a.api.post(`/patients/${pid}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'X1' });
  const plan = (await a.api.post(`/patients/${pid}/treatment-plans`, { name: 'Endo', procedures: [{ code: 'D3330', tooth: '19', provider_id: a.provider.id }] })).data;
  const xray = (await upload(a, pid, pdfWith('periapical 19'), 'pa-19.pdf', 'document')).data;
  const before = h.sent.length;
  const body = { contact_id: a.kim.id, items: [{ procedure_id: plan.procedures[0].id }], urgency: 'soon', document_ids: [xray.id], send: 'email', client_key: 'form-key-0001' };
  const [r1, r2] = await Promise.all([create(a.api, pid, body), create(a.api, pid, body)]);
  const made = [r1, r2].find((r) => r.status === 201);
  assert.ok(made, JSON.stringify([r1.data, r2.data]));
  const ref = made.data.referral;
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM referrals WHERE client_key = 'form-key-0001'")).n, 1, 'one referral for two identical submissions');
  const again = await create(a.api, pid, body);
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(again.data.referral.id, ref.id);
  assert.equal(ref.items.length, 1);
  assert.equal(ref.items[0].code, 'D3330');
  assert.equal(ref.items[0].tooth, '19');
  assert.equal(ref.items[0].office_fee, 125000);
  assert.equal(ref.items[0].ppo_fee, 100000);
  assert.equal(ref.teeth, '19');
  assert.equal(ref.reason, null);
  assert.equal(ref.documents.length, 1);
  assert.equal(ref.expected_by, expectedBy(ref.referral_date, 'soon', DEFAULTS));
  assert.equal(made.data.letter.status, 'sent');
  const email = h.sent.slice(before).find((m) => m.to === 'kim@riverside.example.com');
  assert.ok(email, 'the specialist got an email');
  assert.match(email.body, /\/api\/public\/referral\/[\w-]+\/view/);
  assert.ok(!email.body.includes('Jane') && !email.body.includes('Doe'), 'no patient name in the email itself');
  const text = h.sent.slice(before).find((m) => m.channel === 'sms');
  assert.ok(text, 'the patient was texted');
  assert.match(text.body, /Dr\. Grace Kim/);
  assert.match(text.body, /512-555-0199/);
  assert.equal(made.data.patient_text.status, 'sent');
  // Timeline and audit: who created it, the letter, the text.
  const kinds = ref.events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 3), ['created', 'letter', 'patient_text']);
  assert.ok(ref.events[0].who);
  const aud = await h.db.get("SELECT * FROM audit_log WHERE action = 'referral.create' AND entity_id = ?", ref.id);
  assert.equal(aud.source, 'human');
  assert.equal(aud.patient_id, pid);
  // The specialist's secure link: the letter, the file, "scheduled", and the report upload.
  const token = email.body.match(/referral\/([\w-]+)\/view/)[1];
  const page = await fetch(`${pubOrigin}/api/public/referral/${token}/view`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Jane Doe/);
  assert.match(html, /D3330/);
  assert.match(page.headers.get('content-security-policy'), /nonce-/);
  const file = await fetch(`${pubOrigin}/api/public/referral/${token}/files/${xray.id}`);
  assert.equal(file.status, 200);
  const notMine = (await upload(a, pid, pdfWith('other'), 'other.pdf', 'document')).data;
  assert.equal((await fetch(`${pubOrigin}/api/public/referral/${token}/files/${notMine.id}`)).status, 404, 'only the attached files');
  assert.equal((await fetch(`${pubOrigin}/api/public/referral/nope-token/view`)).status, 404);
  const sch = await fetch(`${pubOrigin}/api/public/referral/${token}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'scheduled', date: addDays(ref.referral_date, 5) }) });
  assert.equal(sch.status, 200);
  const up = await fetch(`${pubOrigin}/api/public/referral/${token}/report?filename=report.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfWith('Endodontic treatment completed tooth 19') });
  assert.equal(up.status, 201, await up.text());
  const after = (await a.api.get(`/referral-tracker/referrals/${ref.id}`)).data;
  assert.equal(after.status, 'report_received');
  assert.ok(after.report_document_id);
  assert.equal(after.scheduled_on, addDays(ref.referral_date, 5));
  const linkAudit = await h.db.get("SELECT * FROM audit_log WHERE action = 'referral.report_linked' AND entity_id = ?", ref.id);
  assert.equal(linkAudit.source, 'integration');
  // The dentist is asked to review it.
  const task = await h.db.get('SELECT * FROM tasks WHERE id = ?', after.review_task_id);
  assert.equal(task.assigned_to, a.dentistUser.id);
  assert.match(task.title, /Review Dr\. Grace Kim’s report/);
});

test('RT1 opt-outs: a patient who turned texts off isn’t texted (blocked, on the timeline)', async () => {
  const a = await setup();
  await h.db.run('UPDATE patients SET sms_opt_in = 0, email_opt_in = 0 WHERE id = ?', a.patient.id);
  const before = h.sent.length;
  const r = await create(a.api, a.patient.id, { contact_id: a.lopez.id, reason: 'Extraction #1', send: 'print' });
  assert.equal(r.status, 201);
  assert.equal(r.data.patient_text.status, 'skipped');
  assert.equal(h.sent.slice(before).length, 0);
  assert.equal(r.data.letter.status, 'print');
  assert.ok(r.data.referral.events.some((e) => e.kind === 'patient_text' && /Not sent/.test(e.note)));
});

test('RT2 statuses: dates and who on the timeline; closing needs a reason; closed can’t move; reopen needs a note', async () => {
  const a = await setup();
  const ref = (await create(a.api, a.patient.id, { contact_id: a.lopez.id, reason: 'Third molars', send: 'none', text_patient: false })).data.referral;
  const today = ref.referral_date;
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'seen', on: addDays(today, 2) })).status, 400, 'seen can’t be in the future');
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'closed' })).status, 400, 'closing goes through close');
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'scheduled', on: addDays(today, 7) })).status, 200);
  const seen = (await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'seen', note: 'Patient called' })).data;
  assert.equal(seen.status, 'seen');
  assert.equal(seen.seen_on, today);
  assert.equal(seen.scheduled_on, addDays(today, 7));
  const moves = seen.events.filter((e) => e.kind === 'status');
  assert.deepEqual(moves.map((e) => [e.from_status, e.to_status]), [['open', 'scheduled'], ['scheduled', 'seen']]);
  assert.ok(moves.every((e) => e.who === 'Admin'));
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/close`, {})).status, 400);
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/close`, { reason: 'other' })).status, 400, '"other" needs a note');
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/complete`, {})).status, 400, 'complete needs the report');
  const closed = (await a.api.post(`/referral-tracker/referrals/${ref.id}/close`, { reason: 'patient_declined', note: 'Wants to wait' })).data;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'patient_declined');
  const aud = await h.db.get("SELECT * FROM audit_log WHERE action = 'referral.close' AND entity_id = ?", ref.id);
  assert.match(aud.reason, /Patient declined — Wants to wait/);
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'seen' })).status, 409);
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/reopen`, {})).status, 400);
  const re = (await a.api.post(`/referral-tracker/referrals/${ref.id}/reopen`, { note: 'Changed their mind' })).data;
  assert.equal(re.status, 'seen');
  assert.equal(re.close_reason, null);
});

test('RT2 nudges: off by default; when on, one task per overdue referral however often the job runs', async () => {
  const a = await setup();
  const ref = (await create(a.api, a.patient.id, { contact_id: a.lopez.id, reason: 'Extraction', send: 'none', text_patient: false })).data.referral;
  const pid = (await h.db.get('SELECT practice_id FROM referrals WHERE id = ?', ref.id)).practice_id;
  await h.db.run('UPDATE referrals SET referral_date = ?, expected_by = ? WHERE id = ?', addDays(ref.referral_date, -40), addDays(ref.referral_date, -10), ref.id);
  const storage = h.app.locals.storage;
  await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE practice_id = ? AND patient_id = ?', pid, a.patient.id)).n, 0, 'no nudge unless turned on');
  // It's still on the past-due report and the board's overdue list.
  const due = (await a.api.get('/referral-tracker/past-due')).data;
  assert.deepEqual(due.rows.map((r) => r.id), [ref.id]);
  assert.equal(due.rows[0].days_open, 40);
  assert.equal((await a.api.get('/referral-tracker/past-due?urgency=critical')).data.rows.length, 0);
  assert.equal((await a.api.get(`/referral-tracker/past-due?contact_id=${a.kim.id}`)).data.rows.length, 0);
  assert.equal((await a.api.get(`/referral-tracker/past-due?provider_id=${a.provider.id}`)).data.rows.length, 1);
  const csv = await a.api.get('/referral-tracker/past-due?format=csv');
  assert.match(csv.data, /Patient,Specialist/);
  assert.match(csv.data, /Jane Doe,Dr\. Mark Lopez/);
  const board = (await a.api.get('/referral-tracker/board?view=overdue')).data;
  assert.equal(board.counts.overdue, 1);
  assert.equal(board.counts.past_due, 1);
  assert.equal((await a.desk.api.put('/referral-tracker/settings', { nudge_noncritical: true })).status, 403, 'settings are for administrators');
  assert.equal((await a.api.put('/referral-tracker/settings', { past_due_days: 0 })).status, 400);
  assert.equal((await a.api.put('/referral-tracker/settings', { nudge_noncritical: true })).data.nudge_noncritical, 1);
  const r1 = await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid });
  const r2 = await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid });
  assert.equal(r1.nudges, 1);
  assert.equal(r2.nudges, 0);
  const tasks = await h.db.all('SELECT * FROM tasks WHERE practice_id = ? AND patient_id = ?', pid, a.patient.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /hasn’t been seen by Dr\. Mark Lopez/);
  // Done with the task but still not seen: the next day it comes back once.
  await h.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", tasks[0].id);
  await h.db.run('UPDATE referrals SET nudged_on = ? WHERE id = ?', addDays(ref.referral_date, -1), ref.id);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).nudges, 1);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).nudges, 0);
});

test('RT2 critical: alerts the dentist and the front desk now and every 7 days until seen or closed', async () => {
  const a = await setup();
  const r = await create(a.api, a.patient.id, { contact_id: a.lopez.id, reason: 'Suspicious lesion — biopsy', urgency: 'critical', send: 'print', text_patient: false });
  assert.equal(r.status, 201);
  const ref = r.data.referral;
  const pid = (await h.db.get('SELECT practice_id FROM referrals WHERE id = ?', ref.id)).practice_id;
  assert.ok(r.data.alert, 'alerted straight away');
  assert.deepEqual([...r.data.alert.recipients].sort(), [a.dentistUser.id, a.desk.id].sort());
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", pid, `referral-critical:${ref.id}`);
  assert.ok(issue);
  assert.equal(issue.severity, 'high');
  assert.equal(issue.occurrences, 1);
  const chats = () => h.db.all("SELECT * FROM chat_messages WHERE practice_id = ? AND kind = 'system' AND patient_id = ?", pid, a.patient.id);
  assert.equal((await chats()).length, 1);
  const mentions = await h.db.all('SELECT user_id FROM chat_mentions WHERE message_id = ?', (await chats())[0].id);
  assert.deepEqual(mentions.map((m) => m.user_id).sort(), [a.dentistUser.id, a.desk.id].sort());
  // Running again the same day (or twice at once) doesn't alert again.
  const storage = h.app.locals.storage;
  const [j1, j2] = await Promise.all([runReferralJobs(h.db, { storage, config: h.config, practiceId: pid }), runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })]);
  assert.equal(j1.alerts + j2.alerts, 0);
  // Six days later: not yet. Seven days later: again (the same Needs attention item counts up).
  await h.db.run('UPDATE referrals SET critical_alerted_on = ? WHERE id = ?', addDays(ref.referral_date, -6), ref.id);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).alerts, 0);
  await h.db.run('UPDATE referrals SET critical_alerted_on = ? WHERE id = ?', addDays(ref.referral_date, -7), ref.id);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).alerts, 1);
  assert.equal((await h.db.get('SELECT occurrences FROM issues WHERE id = ?', issue.id)).occurrences, 2);
  assert.equal((await chats()).length, 2);
  // The setting changes the interval.
  await a.api.put('/referral-tracker/settings', { critical_alert_days: 3 });
  await h.db.run('UPDATE referrals SET critical_alerted_on = ? WHERE id = ?', addDays(ref.referral_date, -3), ref.id);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).alerts, 1);
  // Shown on the patient bar and in the huddle.
  const flags = (await a.api.get(`/referral-tracker/patients/${a.patient.id}/flags`)).data;
  assert.equal(flags.alerting, 1);
  const huddle = (await a.api.get('/referral-tracker/huddle')).data;
  assert.deepEqual(huddle.critical.map((x) => x.id), [ref.id]);
  // Seen: the alert is resolved and stops.
  await a.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'seen' });
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
  await h.db.run('UPDATE referrals SET critical_alerted_on = ? WHERE id = ?', addDays(ref.referral_date, -30), ref.id);
  assert.equal((await runReferralJobs(h.db, { storage, config: h.config, practiceId: pid })).alerts, 0);
  // A second critical one closed with a reason also stops.
  const r2 = (await create(a.api, a.patient.id, { contact_id: a.kim.id, reason: 'Abscess #30', urgency: 'critical', send: 'none', text_patient: false })).data.referral;
  await a.api.post(`/referral-tracker/referrals/${r2.id}/close`, { reason: 'treated_here', note: 'Dr. Lee will do it' });
  assert.equal((await h.db.get("SELECT status FROM issues WHERE dedupe_key = ?", `referral-critical:${r2.id}`)).status, 'resolved');
  // Made critical later: alerted at once.
  const r3 = (await create(a.api, a.patient.id, { contact_id: a.kim.id, reason: 'Recheck #3', send: 'none', text_patient: false })).data.referral;
  await a.api.post(`/referral-tracker/referrals/${r3.id}/urgency`, { urgency: 'critical', note: 'Swelling' });
  assert.ok(await h.db.get("SELECT id FROM issues WHERE dedupe_key = ? AND status = 'open'", `referral-critical:${r3.id}`));
});

test('RT3 closing the loop: a filed letter is matched to the open referral, a person confirms, the dentist reviews', async () => {
  const a = await setup();
  const pid = a.patient.id;
  const kimRef = (await create(a.api, pid, { contact_id: a.kim.id, reason: 'Molar root canal', send: 'none', text_patient: false })).data.referral;
  const lopezRef = (await create(a.api, pid, { contact_id: a.lopez.id, reason: 'Extraction wisdom teeth', send: 'none', text_patient: false })).data.referral;
  // Filed as a referral letter: read, matched by the specialist's name in the text.
  const doc = (await upload(a, pid, pdfWith('Riverside Endodontics - Dr. Grace Kim. Consultation report: root canal therapy tooth 19 completed.'), 'scan-0001.pdf', 'referral')).data;
  await readsIdle();
  let d = (await a.api.get(`/referral-tracker/referrals/${kimRef.id}`)).data;
  assert.equal(d.matches.length, 1, JSON.stringify(d.events));
  assert.equal(d.matches[0].document_id, doc.id);
  assert.match(d.matches[0].reason, /Dr\. Grace Kim/);
  assert.equal((await a.api.get(`/referral-tracker/referrals/${lopezRef.id}`)).data.matches.length, 0);
  assert.equal(d.status, 'open', 'nothing changes until a person confirms');
  const board = (await a.api.get('/referral-tracker/board?view=awaiting')).data;
  assert.equal(board.rows[0].suggestion.document_id, doc.id);
  // Someone without chart access can't confirm it.
  const billing = await staff(a.api, 'billing');
  assert.equal((await billing.api.post(`/referral-tracker/matches/${d.matches[0].id}/confirm`, { complete: true })).status, 403);
  const done = (await a.api.post(`/referral-tracker/matches/${d.matches[0].id}/confirm`, { complete: true })).data;
  assert.equal(done.status, 'closed');
  assert.equal(done.close_reason, 'completed');
  assert.equal(done.report_document_id, doc.id);
  assert.ok(done.documents.some((x) => x.role === 'report' && x.id === doc.id));
  assert.equal((await a.api.post(`/referral-tracker/matches/${d.matches[0].id}/confirm`, {})).status, 409, 'confirmed once');
  const task = await h.db.get('SELECT * FROM tasks WHERE id = ?', done.review_task_id);
  assert.equal(task.assigned_to, a.dentistUser.id);
  // The dentist marks it reviewed (a clinical permission).
  assert.equal((await a.desk.api.post(`/referral-tracker/referrals/${kimRef.id}/reviewed`, {})).status, 403);
  const rev = (await a.dentistUser.api.post(`/referral-tracker/referrals/${kimRef.id}/reviewed`, {})).data;
  assert.ok(rev.report_reviewed_at);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', done.review_task_id)).status, 'done');
  // A letter that could be either of two referrals (no name): the sandbox AI adapter picks by what it says,
  // with its reason on record (source ai/sandbox), and a person still confirms.
  const again = (await create(a.api, pid, { contact_id: a.kim.id, reason: 'Retreatment evaluation', send: 'none', text_patient: false })).data.referral;
  const doc2 = (await upload(a, pid, pdfWith('Thank you for the referral. We extracted the wisdom teeth today without complications.'), 'letter.pdf', 'correspondence')).data;
  await readsIdle();
  const m = await h.db.get('SELECT * FROM referral_report_matches WHERE document_id = ?', doc2.id);
  assert.equal(m.referral_id, lopezRef.id);
  assert.equal(m.source, 'sandbox');
  assert.match(m.reason, /Sandbox/);
  assert.equal((await a.api.post(`/referral-tracker/matches/${m.id}/dismiss`, {})).data.status, 'dismissed');
  // Dismissed stays dismissed: the job's sweep doesn't suggest it again.
  await a.api.post('/referral-tracker/run', {});
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM referral_report_matches WHERE document_id = ?', doc2.id)).n, 1);
  // Linked by hand instead (with "complete").
  const byHand = (await a.api.post(`/referral-tracker/referrals/${lopezRef.id}/report`, { document_id: doc2.id, complete: true })).data;
  assert.equal(byHand.status, 'closed');
  // A document on another patient's chart can't be linked.
  const other = (await a.api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01' })).data;
  const odoc = (await upload(a, other.id, pdfWith('Dr. Grace Kim report'), 'x.pdf', 'referral')).data;
  assert.equal((await a.api.post(`/referral-tracker/referrals/${again.id}/report`, { document_id: odoc.id })).status, 400);
  // Re-filing a document's category as a referral letter also checks it (the documents PUT hook).
  const doc3 = (await upload(a, pid, pdfWith('Riverside Endodontics retreatment evaluation findings'), 'misc.pdf', 'document')).data;
  await readsIdle();
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM referral_report_matches WHERE document_id = ?', doc3.id)).n, 0);
  await a.api.put(`/documents/${doc3.id}`, { category: 'referral' });
  assert.equal((await h.db.get('SELECT referral_id FROM referral_report_matches WHERE document_id = ?', doc3.id)).referral_id, again.id);
});

test('RT3 matching rules: the specialist’s surname, practice and specialty', () => {
  const c = { contact_name: 'Dr. Grace Kim, DDS', contact_practice: 'Riverside Endodontics', specialty: 'Endodontics' };
  assert.equal(scoreCandidate('Report from Dr. Kim', '', c).score, 50);
  assert.equal(scoreCandidate('riverside endodontics consult', '', c).score, 45);
  assert.equal(scoreCandidate('Kimberly visited', '', c).score, 0, 'whole words only');
  assert.equal(scoreCandidate('', 'kim_report.pdf', c).score, 50, 'the file name counts');
});

test('RT4 inbound: thank-you letter (short name by email, once), report back when treatment is done, source stats', async () => {
  const a = await setup();
  const gp = (await a.api.post('/referral-contacts', { name: 'Dr. Paul Grant', practice_name: 'Grant Family Dental', email: 'grant@example.com' })).data;
  const r = await create(a.api, a.patient.id, { direction: 'in', contact_id: gp.id, reason: 'Implant consult' });
  assert.equal(r.status, 201);
  const ref = r.data.referral;
  assert.equal(ref.status, 'open');
  assert.equal((await h.db.get('SELECT referred_by_id FROM patients WHERE id = ?', a.patient.id)).referred_by_id, gp.id);
  const before = h.sent.length;
  const ty = await a.api.post(`/referral-tracker/referrals/${ref.id}/thank-you`, { channel: 'email' });
  assert.equal(ty.status, 200, JSON.stringify(ty.data));
  const mail = h.sent.slice(before).find((m) => m.to === 'grant@example.com');
  assert.match(mail.body, /Jane D\./);
  assert.ok(!/Jane Doe/.test(mail.body), 'the full name stays out of email');
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/thank-you`, { channel: 'email' })).status, 409, 'sent once');
  assert.equal((await a.api.post(`/referral-tracker/referrals/${ref.id}/thank-you`, { channel: 'print', resend: true })).status, 200);
  // Treatment done → ready to report back.
  const plan = (await a.api.post(`/patients/${a.patient.id}/treatment-plans`, { name: 'Implant', procedures: [{ code: 'D6010', tooth: '30', provider_id: a.provider.id }] })).data;
  let row = (await a.api.get('/referral-tracker/board?view=inbound')).data.rows.find((x) => x.id === ref.id);
  assert.equal(row.ready_to_report_back, false);
  await a.api.post(`/procedures/${plan.procedures[0].id}/complete`);
  row = (await a.api.get('/referral-tracker/board?view=inbound')).data.rows.find((x) => x.id === ref.id);
  assert.equal(row.ready_to_report_back, true);
  const letter = (await a.api.get(`/referral-tracker/referrals/${ref.id}/report-back`)).data;
  assert.match(letter.text, /D6010/);
  const back = (await a.api.post(`/referral-tracker/referrals/${ref.id}/report-back`, { channel: 'print', note: 'Healing well' })).data;
  assert.equal(back.status_after, 'closed');
  assert.match(back.text, /Healing well/);
  const out = (await create(a.api, a.patient.id, { contact_id: a.lopez.id, reason: 'Extraction', send: 'none', text_patient: false })).data.referral;
  assert.equal((await a.api.post(`/referral-tracker/referrals/${out.id}/thank-you`, { channel: 'print' })).status, 400, 'not for referrals out');
  const stats = (await a.api.get('/referral-tracker/sources')).data;
  const s = stats.sources.find((x) => x.id === gp.id);
  assert.equal(s.patients, 1);
  assert.equal(s.thanked, 1);
  assert.equal(s.reported_back, 1);
  assert.equal(s.production, 220000);
});

test('RT5 in-house opportunity: counts and revenue at office fees and after PPO write-offs, by category, month and specialist', async () => {
  const a = await setup();
  const pid = a.patient.id;
  const carrier = (await a.api.post('/carriers', { name: 'PPO', payer_id: '11111' })).data;
  const fs = (await a.api.post('/fee-schedules', { name: 'PPO', percent_of_ucr: 80 })).data;
  await a.api.put(`/fee-schedules/${fs.id}`, { carrier_ids: [carrier.id] });
  const insured = (await a.api.post('/patients', { first_name: 'Ivy', last_name: 'Insured', dob: '1980-02-02', phone: '5125550111' })).data;
  await a.api.post(`/patients/${insured.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Ivy Insured', subscriber_id: 'P1' });
  const mk = (patientId, contact, items) => create(a.api, patientId, { contact_id: contact.id, items, send: 'none', text_patient: false });
  await mk(pid, a.kim, [{ code: 'D3330', tooth: '19' }]); // cash: 1250.00 both ways
  await mk(insured.id, a.kim, [{ code: 'D3330', tooth: '30' }]); // PPO: 1250.00 office, 1000.00 allowed
  await mk(insured.id, a.lopez, [{ code: 'D7210', tooth: '1' }, { code: 'D7210', tooth: '16' }]);
  const oops = (await mk(pid, a.lopez, [{ code: 'D6010', tooth: '3' }])).data.referral;
  await a.api.post(`/referral-tracker/referrals/${oops.id}/close`, { reason: 'entered_in_error' });
  const r = (await a.api.get('/referral-tracker/opportunity')).data;
  assert.equal(r.totals.count, 4);
  assert.equal(r.totals.referrals, 3);
  assert.equal(r.totals.office, 125000 * 2 + 32000 * 2);
  assert.equal(r.totals.net, 125000 + 100000 + 25600 * 2);
  assert.equal(r.totals.write_off, 25000 + 6400 * 2);
  const endo = r.by_category.find((c) => c.key === 'endodontics');
  assert.deepEqual([endo.count, endo.office, endo.net], [2, 250000, 225000]);
  assert.equal(r.by_category[0].key, 'endodontics', 'largest first');
  assert.equal(r.by_code[0].key, 'D3330');
  assert.equal(r.by_month.length, 1);
  assert.equal(r.by_year[0].count, 4);
  assert.equal(r.top_specialists[0].label, 'Dr. Grace Kim (Endodontics)');
  assert.match(r.headline, /You referred out 2 × D3330/);
  assert.match(r.headline, /\$2,500/);
  // Fees are those of the day: a later fee change doesn't re-price past referrals.
  await h.db.run("UPDATE procedure_codes SET fee = 999900 WHERE code = 'D3330' AND practice_id = (SELECT practice_id FROM patients WHERE id = ?)", pid);
  assert.equal((await a.api.get('/referral-tracker/opportunity')).data.totals.office, r.totals.office);
  assert.equal((await a.api.get('/referral-tracker/opportunity?from=2026-05-01&to=2026-01-01')).status, 400);
  // reports:read is needed.
  const asst = await staff(a.api, 'assistant');
  assert.equal((await asst.api.get('/referral-tracker/opportunity')).status, 403);
  assert.equal((await asst.api.get('/referral-tracker/sources')).status, 403);
});

test('isolation and permissions: other practices, other offices, roles', async () => {
  const a = await setup();
  const b = await setup();
  const ref = (await create(a.api, a.patient.id, { contact_id: a.kim.id, reason: 'Endo', urgency: 'critical', send: 'none', text_patient: false })).data.referral;
  assert.equal((await b.api.get(`/referral-tracker/referrals/${ref.id}`)).status, 404);
  for (const path of ['status', 'close', 'reopen', 'urgency', 'note', 'send', 'report', 'reviewed']) {
    assert.equal((await b.api.post(`/referral-tracker/referrals/${ref.id}/${path}`, { status: 'seen', reason: 'other', note: 'x', urgency: 'soon', document_id: 1 })).status, 404, path);
  }
  assert.equal((await b.api.get('/referral-tracker/board?view=critical')).data.rows.length, 0);
  assert.equal((await b.api.get(`/referral-tracker/patients/${a.patient.id}/flags`)).status, 404);
  const m = await h.db.run("INSERT INTO referral_report_matches (practice_id, referral_id, document_id, score, source) VALUES ((SELECT practice_id FROM referrals WHERE id = ?), ?, (SELECT MIN(id) FROM documents), 1, 'rules')", ref.id, ref.id).catch(() => null);
  if (m?.id) assert.equal((await b.api.post(`/referral-tracker/matches/${m.id}/confirm`, {})).status, 404);
  // Billing can read but not create or move referrals.
  const billing = await staff(a.api, 'billing');
  assert.equal((await create(billing.api, a.patient.id, { contact_id: a.kim.id, reason: 'x' })).status, 403);
  assert.equal((await billing.api.post(`/referral-tracker/referrals/${ref.id}/status`, { status: 'seen' })).status, 403);
  assert.equal((await billing.api.get('/referral-tracker/board')).status, 200);
  assert.equal((await a.desk.api.post('/referral-tracker/run', {})).status, 403);
  // Someone limited to another office doesn't see this patient's referrals.
  const north = (await a.api.post('/locations', { name: 'North' })).data.id;
  const south = (await a.api.post('/locations', { name: 'South' })).data.id;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', north, a.patient.id);
  await h.db.run('UPDATE referrals SET location_id = ? WHERE id = ?', north, ref.id);
  const fd = await staff(a.api, 'front_desk');
  await h.db.run('UPDATE users SET location_ids = ? WHERE id = ?', JSON.stringify([south]), fd.id);
  assert.equal((await fd.api.get(`/referral-tracker/referrals/${ref.id}`)).status, 404);
  assert.equal((await fd.api.get('/referral-tracker/board?view=critical')).data.rows.length, 0);
  await h.db.run('UPDATE users SET location_ids = ? WHERE id = ?', JSON.stringify([north]), fd.id);
  assert.equal((await fd.api.get(`/referral-tracker/referrals/${ref.id}`)).status, 200);
  assert.equal((await fd.api.get('/referral-tracker/board?view=critical')).data.rows.length, 1);
});

test('suggest: the specialist used last for the same kind of work, and the planned procedures chosen', async () => {
  const a = await setup();
  const plan = (await a.api.post(`/patients/${a.patient.id}/treatment-plans`, { name: 'Endo', procedures: [{ code: 'D3330', tooth: '19', provider_id: a.provider.id }] })).data;
  await create(a.api, a.patient.id, { contact_id: a.kim.id, items: [{ code: 'D3330', tooth: '3' }], send: 'none', text_patient: false });
  await create(a.api, a.patient.id, { contact_id: a.lopez.id, items: [{ code: 'D7210', tooth: '1' }], send: 'none', text_patient: false });
  const s = (await a.api.get(`/referral-tracker/suggest?patient_id=${a.patient.id}&procedure_ids=${plan.procedures[0].id}`)).data;
  assert.equal(s.contact.id, a.kim.id, 'endo goes to the endodontist, not the last one used');
  assert.equal(s.items[0].code, 'D3330');
  assert.equal(s.send, 'email');
  assert.match(s.reason, /#19/);
  const none = (await a.api.get(`/referral-tracker/suggest?patient_id=${a.patient.id}`)).data;
  assert.equal(none.contact.id, a.lopez.id, 'otherwise the last specialist used');
});
