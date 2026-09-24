// Phones: every call saved, linked and coached (PH1-PH7, docs/workflows/specs/PH-phones.md).
// Auto-link by number (family and office scope), the recording disclosure, protocol scoring in the sandbox with the
// transcript's words as evidence, the numbers (answer rate, time to answer, missed/abandoned by hour in the practice's
// time zone, attributed to whoever was on shift), the leaderboard and who may see it, reasons for not booking,
// upset-caller alerts (raise, notify, acknowledge), the live request parser, slot filtering and one-click booking.
// The routes aren't mounted in app.js by this file's author, so they're mounted on a small app here (pattern:
// chartaudit.test.js); the phone line's own webhooks (routes/phones.js) come through the full app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';
import phoneCoachRoutes, { phoneCoachWebhooks } from '../src/routes/phonecoach.js';
import { authenticate, HttpError, PERMISSION_CATALOG } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, localNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { createCallScorer } from '../src/ai/callscore.js';
import { createLiveTranscription } from '../src/livecall.js';
import {
  parseRequest, filterSlots, scoreSteps, detectCallType, detectUpset, suggestNoBookReason, reviewCall, phoneMetrics, runMissedCallCheck, addDays, STARTER_PROTOCOLS, cleanSteps,
} from '../src/phonecoach.js';

const TOKEN = 'twilio-secret';
const h = harness({ config: { twilioAuthToken: TOKEN, twilioAccountSid: 'AC1' } });
const scorer = createCallScorer({ mode: 'sandbox' });
const live = createLiveTranscription({ config: { liveTranscription: 'sandbox' } });
let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const config = { ...h.config, twilioAuthToken: TOKEN, appUrl: 'https://app.example.com' };
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(phoneCoachWebhooks({ db: h.db, config, messenger: h.messenger, live, scorer }));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(phoneCoachRoutes({ db: h.db, config, messenger: h.messenger, scorer, live }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(err instanceof HttpError ? err.status : /UNIQUE|unique/.test(err.message) ? 409 : 500).json({ error: err.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (token) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
};
const client = (token) => { const c = call(token); return { get: (p) => c('GET', p), post: (p, b) => c('POST', p, b ?? {}), put: (p, b) => c('PUT', p, b) }; };
const twilio = (path, params, base = h.origin) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature(TOKEN, `https://app.example.com${path}`, params) },
  body: new URLSearchParams(params),
}).then(async (r) => ({ status: r.status, text: await r.text() }));
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['08:00', '17:00']]]));
let seq = 0;
// Sign-ins come from different addresses so the login rate limit doesn't trip across this file's many people.
const anon = () => h.client(null, { 'X-Forwarded-For': `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

async function office(extra = {}) {
  const p = await h.practice({ timezone: 'UTC', ...extra });
  p.practiceId = (await h.db.get('SELECT practice_id FROM users WHERE email = ?', p.email)).practice_id;
  const voice = `+1512666${String(1000 + (++seq)).slice(-4)}`;
  await p.api.put('/practice', { voice_number: voice, forward_to: '+15125551111', office_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]])) });
  const admin = client(p.token);
  const person = async (name, role, perms) => {
    const email = `${name.toLowerCase().replace(/\W/g, '')}-${seq}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const u = (await p.api.post('/users', { email, name, role, password: 'correct-horse-battery' })).data;
    if (perms) await h.db.run('UPDATE users SET permissions_add = ? WHERE id = ?', JSON.stringify(perms), u.id);
    const token = (await anon().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
    return { ...u, token, c: client(token) };
  };
  return { ...p, voice, admin, person };
}
const ring = (voice, from, sid) => twilio('/api/webhooks/twilio/voice/inbound', { CallSid: sid, From: from, To: voice });
const callBySid = (sid) => h.db.get('SELECT * FROM calls WHERE provider_id = ?', sid);
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

test('the permission to coach is offered in Settings → Roles', () => {
  assert.ok(PERMISSION_CATALOG['phones:coach']);
});

test('PH1: calls link to the patient by number — the family’s account holder for a shared number, never another practice’s or an archived chart', async () => {
  const o = await office();
  const kid = (await o.api.post('/patients', { first_name: 'Tim', last_name: 'Doe', dob: '2015-02-02', phone: '(512) 555-0100', guarantor_id: o.patient.id })).data;
  const solo = (await o.api.post('/patients', { first_name: 'Sol', last_name: 'One', dob: '1970-01-01', phone: '(512) 555-0142' })).data;
  const gone = (await o.api.post('/patients', { first_name: 'Arch', last_name: 'Ived', dob: '1970-01-01', phone: '(512) 555-0143' })).data;
  await h.db.run("UPDATE patients SET status = 'archived' WHERE id = ?", gone.id);
  const other = await office();
  await other.api.post('/patients', { first_name: 'Else', last_name: 'Where', dob: '1980-01-01', phone: '(512) 555-0144' });

  await ring(o.voice, '+15125550100', 'CAL-FAM');
  await ring(o.voice, '+15125550142', 'CAL-SOLO');
  await ring(o.voice, '+15125550143', 'CAL-GONE');
  await ring(o.voice, '+15125550144', 'CAL-OTHER');
  const fam = await callBySid('CAL-FAM');
  assert.equal(fam.patient_id, o.patient.id, 'the account holder');
  assert.equal(fam.linked_via, 'family_number');
  assert.ok(kid.id);
  const one = await callBySid('CAL-SOLO');
  assert.deepEqual([one.patient_id, one.linked_via], [solo.id, 'number']);
  assert.equal((await callBySid('CAL-GONE')).patient_id, null, 'archived charts are not linked');
  assert.equal((await callBySid('CAL-OTHER')).patient_id, null, 'another practice’s patient is never linked');

  // The chart's call history, with the household on request; an office-restricted person can't see it.
  const history = (await o.admin.get(`/patients/${kid.id}/calls?family=1`)).data;
  assert.ok(history.some((c) => c.id === fam.id));
  assert.equal((await o.admin.get(`/patients/${kid.id}/calls`)).data.length, 0, 'the call is filed under the account holder');
  const north = (await o.api.post('/locations', { name: 'North' })).data;
  const south = (await o.api.post('/locations', { name: 'South' })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', north.id, solo.id);
  const email = `south-${Date.now()}@example.com`;
  await o.api.post('/users', { email, name: 'Sam South', role: 'front_desk', password: 'correct-horse-battery', location_ids: [south.id] });
  const sam = client((await anon().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await sam.get(`/patients/${solo.id}/calls`)).status, 404);
  assert.equal((await sam.get(`/phones/calls/${one.id}/review`)).status, 404);
  assert.ok(!(await sam.get('/phones/calls')).data.calls.some((c) => c.id === one.id), 'search hides other offices’ patients');
  // Another practice can't reach this practice's calls at all.
  assert.equal((await other.admin.get(`/phones/calls/${one.id}/review`)).status, 404);
});

test('PH1: recording with the office’s own disclosure (admins only, audited); search by topic, person and date', async () => {
  const o = await office();
  const desk = await o.person('Dana Desk', 'front_desk');
  assert.equal((await desk.c.put('/phones/settings', { record_calls: true })).status, 403);
  const set = await o.admin.put('/phones/settings', { record_calls: true, recording_disclosure: 'Hi! Calls are recorded so we can serve you better.' });
  assert.equal(set.status, 200);
  assert.equal(set.data.record_calls, true);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'phone_settings.update' AND practice_id = ?", o.practiceId));
  const twiml = (await ring(o.voice, '+15125550100', 'CAREC1')).text;
  assert.match(twiml, /Calls are recorded so we can serve you better/);
  assert.match(twiml, /record="record-from-answer-dual"/);
  // Off again: no disclosure and no recording.
  await o.admin.put('/phones/settings', { record_calls: false });
  const plain = (await ring(o.voice, '+15125550100', 'CAREC2')).text;
  assert.doesNotMatch(plain, /record=|recorded/);

  const c = await callBySid('CAREC1');
  await h.db.run("UPDATE calls SET transcript = ?, summary = 'Asked about whitening', agent_id = ? WHERE id = ?", 'Caller: Do you do teeth whitening?\nOffice: Yes we do.', desk.id, c.id);
  const today = localNow('UTC').slice(0, 10);
  const byTopic = (await o.admin.get(`/phones/calls?q=whitening&from=${today}&to=${today}`)).data.calls;
  assert.deepEqual(byTopic.map((x) => x.id), [c.id]);
  assert.deepEqual((await o.admin.get(`/phones/calls?agent_id=${desk.id}`)).data.calls.map((x) => x.id), [c.id]);
  assert.deepEqual((await o.admin.get(`/phones/calls?patient_id=${o.patient.id}&q=whitening`)).data.calls.map((x) => x.id), [c.id]);
  assert.equal((await o.admin.get('/phones/calls?from=2026-02-30')).status, 400);
});

const NP_CALL = [
  'Caller: Hi, I am a new patient looking for a dentist.',
  'Office: Thank you for calling Bright Smiles, this is Dana.',
  'Office: Welcome! What brings you in?',
  'Caller: My tooth is a bit sensitive.',
  'Office: Do you have dental insurance?',
  'Caller: Delta Dental.',
  'Office: Would you like to come in Thursday? I can book you for 10:30 am.',
  'Caller: Hmm, how much does a new patient exam cost? That sounds expensive.',
  'Caller: Let me think about it and get back to you.',
].join('\n');

test('PH2/PH3: starter protocols, a sandbox score with the transcript’s own words as evidence, labelled AI; only when AI is on', async () => {
  const o = await office();
  const protos = (await o.admin.get('/phones/protocols')).data;
  assert.deepEqual(protos.protocols.map((p) => p.call_type).sort(), ['billing', 'emergency', 'general', 'new_patient', 'scheduling']);
  const desk = await o.person('Dana Desk', 'front_desk');
  const { id } = await h.db.run("INSERT INTO calls (practice_id, direction, purpose, status, outcome, desk_result, transcript, agent_id, new_caller, from_number) VALUES (?, 'inbound', 'inbound', 'completed', 'answered', 'answered', ?, ?, 1, '+15125550999')", o.practiceId, NP_CALL, desk.id);
  // AI off (no scorer): nothing is scored.
  assert.equal((await reviewCall(h.db, { scorer: null }, id)).score, undefined);
  assert.equal(await h.db.get('SELECT id FROM call_scores WHERE call_id = ?', id), undefined);

  const out = await reviewCall(h.db, { scorer, messenger: h.messenger }, id);
  const row = await h.db.get("SELECT * FROM call_scores WHERE call_id = ? AND status = 'current'", id);
  assert.equal(row.call_type, 'new_patient');
  assert.equal(row.model, 'AI (sandbox)');
  assert.equal(row.score, out.score);
  const steps = JSON.parse(row.steps);
  for (const st of steps.filter((x) => x.met)) assert.ok(NP_CALL.includes(st.quote), `quote for ${st.key} is in the transcript`);
  const met = Object.fromEntries(steps.map((x) => [x.key, x.met]));
  assert.equal(met.greeting, true);
  assert.equal(met.reason, true);
  assert.equal(met.close_time, true);
  assert.equal(met.how_heard, false);
  // Weighted: new_patient steps weigh 2+1+1+2+1+1+2+3+1 = 14; missed how_heard(1) and referrals(1) → 12/14.
  assert.equal(row.score, Math.round((100 * 12) / 14));
  assert.equal((await h.db.get('SELECT call_type FROM calls WHERE id = ?', id)).call_type, 'new_patient');
  // It didn't book: the AI suggests a reason with the caller's words, waiting for a person.
  const nb = await h.db.get('SELECT * FROM call_no_book WHERE call_id = ?', id);
  assert.equal(nb.suggested_reason, 'cost');
  assert.ok(NP_CALL.includes(nb.suggested_quote));
  assert.equal(nb.reason, null);

  // The review screen: labelled AI, with the coaching note; the person themself can see their own.
  const mine = (await desk.c.get(`/phones/calls/${id}/review`)).data;
  assert.equal(mine.visible, true);
  assert.match(mine.score.label, /AI/);
  assert.match(mine.coaching_note, /coaching/i);

  // Scoring again supersedes (kept), never duplicates the current one.
  await o.admin.post(`/phones/calls/${id}/score`);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM call_scores WHERE call_id = ? AND status = 'current'", id)).n, 1);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM call_scores WHERE call_id = ? AND status = 'superseded'", id)).n, 1);

  // Editing a protocol makes a new version (old kept for past scores); bad steps are refused.
  assert.equal((await o.admin.put('/phones/protocols/new_patient', { name: 'NP', steps: [{ label: '', weight: 1 }] })).status, 400);
  const v2 = (await o.admin.put('/phones/protocols/new_patient', { name: 'New patient v2', steps: [{ label: 'Greets warmly', weight: 3, required: true, hints: ['thank you for calling'] }, { label: 'Books a time', weight: 2, hints: ['/at \\d/'] }] })).data;
  assert.equal(v2.version, 2);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM phone_protocols WHERE practice_id = ? AND call_type = 'new_patient'", o.practiceId)).n, 2);
  assert.equal((await desk.c.put('/phones/protocols/new_patient', { name: 'x', steps: [{ label: 'x' }] })).status, 403);
});

test('scoring rules: a quote that isn’t in the transcript doesn’t count; call types; upset words; no-book reasons', () => {
  const steps = cleanSteps(STARTER_PROTOCOLS.general.steps);
  const t = 'Office: Thank you for calling, this is Amy.\nCaller: Hi.';
  const r = scoreSteps(steps, [{ key: 'greeting', met: true, quote: 'Thank you for calling, this is Amy.' }, { key: 'own_name', met: true, quote: 'My name is Bob' }], t);
  assert.equal(r.steps.find((x) => x.key === 'greeting').met, true);
  assert.equal(r.steps.find((x) => x.key === 'own_name').met, false, 'an invented quote is dropped');
  assert.equal(r.score, Math.round((100 * 2) / 10));
  assert.ok(r.missed_required.includes('offer'));
  assert.equal(detectCallType('Caller: I have a toothache and some swelling'), 'emergency');
  assert.equal(detectCallType('Caller: I got a bill I don’t understand'), 'billing');
  assert.equal(detectCallType('Caller: I need to reschedule my cleaning'), 'scheduling');
  assert.equal(detectUpset('Caller: This is ridiculous. I want to speak to the manager!').upset, true);
  assert.equal(detectUpset('Caller: Thanks so much, see you then.').upset, false);
  assert.equal(detectUpset('Office: This is ridiculous.').upset, false, 'only the caller’s words');
  assert.equal(suggestNoBookReason('Caller: Do you take my insurance? I have Cigna.').reason, 'insurance');
  assert.equal(suggestNoBookReason('Caller: I am just shopping around.').reason, 'shopping');
});

test('PH6: the request parser — "Thursday afternoon with Dr Chen", "next week morning", "asap" — and slot filtering', () => {
  const providers = [{ id: 7, name: 'Dr. Wei Chen, DDS' }, { id: 8, name: 'Sarah Kim, RDH' }];
  const today = '2026-09-24'; // a Thursday
  const a = parseRequest('Do you have anything Thursday afternoon with Dr Chen?', { today, providers });
  assert.deepEqual([a.weekdays, a.part, a.provider_ids, a.asap], [[4], 'pm', [7], false]);
  const b = parseRequest('next week in the morning would be best', { today, providers });
  assert.deepEqual([b.date_from, b.date_to, b.part], ['2026-09-28', '2026-10-04', 'am']);
  const c = parseRequest('ASAP please, it hurts', { today, providers });
  assert.equal(c.asap, true);
  const d = parseRequest('tomorrow after 3 with Sarah', { today, providers });
  assert.deepEqual([d.date_from, d.after, d.provider_ids], ['2026-09-25', '15:00', [8]]);
  assert.deepEqual(parseRequest('hello there', { today, providers }).weekdays, []);

  const slots = [
    { start: '2026-09-28 09:00', provider_id: 7 }, { start: '2026-10-01 09:00', provider_id: 7 }, { start: '2026-10-01 14:00', provider_id: 8 },
    { start: '2026-10-01 15:30', provider_id: 7 }, { start: '2026-10-06 10:00', provider_id: 7 },
  ];
  assert.deepEqual(filterSlots(slots, a).map((x) => x.start), ['2026-10-01 15:30']);
  assert.deepEqual(filterSlots(slots, b).map((x) => x.start), ['2026-09-28 09:00', '2026-10-01 09:00']);
  assert.equal(filterSlots(slots, parseRequest('', { today })).length, 5, 'nothing asked: everything');
});

test('PH6: live phrases filter the openings; one click books through the schedule’s checks, once', async () => {
  const o = await office();
  const chen = (await o.api.post('/providers', { name: 'Dr. Wei Chen, DDS', type: 'dentist' })).data;
  const desk = await o.person('Dana Desk', 'front_desk');
  await ring(o.voice, '+15125550100', 'CABOOK');
  await o.api.put('/practice', { office_hours: ALL_DAY }); // bookable hours (the call itself came in while open)
  const c = await callBySid('CABOOK');

  const first = (await desk.c.get(`/phones/calls/${c.id}/openings`)).data;
  assert.equal(first.patient.id, o.patient.id);
  assert.ok(first.slots.length > 0, 'openings without any request');
  assert.ok(first.need.kind);

  // The caller speaks (sandbox live transcription): the request is parsed and published; openings filter.
  const spoke = await desk.c.post(`/phones/calls/${c.id}/sandbox-speech`, { script: [{ track: 'office', text: 'Thank you for calling.' }, { track: 'caller', text: 'Could I come in Thursday afternoon with Dr Chen?' }] });
  assert.equal(spoke.status, 200);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM call_segments WHERE call_id = ?", c.id)).n, 2);
  const heard = (await desk.c.get(`/phones/calls/${c.id}/request`)).data.request;
  assert.deepEqual([heard.weekdays, heard.part, heard.provider_ids], [[4], 'pm', [chen.id]]);
  const filtered = (await desk.c.get(`/phones/calls/${c.id}/openings`)).data;
  assert.ok(filtered.slots.length > 0);
  for (const s of filtered.slots) {
    assert.equal(new Date(`${s.start.slice(0, 10)}T12:00:00Z`).getUTCDay(), 4);
    assert.ok(s.start.slice(11) >= '12:00');
    assert.equal(s.provider_id, chen.id);
  }
  // The quick filter row overrides (Friday mornings).
  const quick = (await desk.c.get(`/phones/calls/${c.id}/openings?weekdays=5&part=am&provider_ids=${chen.id}`)).data;
  for (const s of quick.slots) assert.ok(new Date(`${s.start.slice(0, 10)}T12:00:00Z`).getUTCDay() === 5 && s.start.slice(11) < '12:00');
  assert.equal((await desk.c.get(`/phones/calls/${c.id}/openings?weekdays=9`)).status, 400);

  const pick = filtered.slots[0];
  const body = { patient_id: o.patient.id, provider_id: pick.provider_id, start_time: pick.start, duration: filtered.need.duration, reason: filtered.need.label };
  const booked = await desk.c.post(`/phones/calls/${c.id}/book`, body);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const again = await desk.c.post(`/phones/calls/${c.id}/book`, body);
  assert.equal(again.status, 200, 'the same click again returns the same visit');
  assert.equal(again.data.appointment.id, booked.data.appointment.id);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ? AND start_time = ?', o.patient.id, pick.start)).n, 1);
  const after = await h.db.get('SELECT * FROM calls WHERE id = ?', c.id);
  assert.deepEqual([after.appointment_id, after.outcome, after.agent_id], [booked.data.appointment.id, 'booked', desk.id]);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'call.book' AND entity_id = ?", c.id));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'appointment.create' AND entity_id = ?", booked.data.appointment.id), 'the visit itself is audited');
  // The slot is gone from the openings; another practice can't book on this call; a past time is refused.
  assert.ok(!(await desk.c.get(`/phones/calls/${c.id}/openings`)).data.slots.some((s) => s.start === pick.start && s.provider_id === pick.provider_id));
  const other = await office();
  assert.equal((await other.admin.post(`/phones/calls/${c.id}/book`, body)).status, 404);
  assert.equal((await desk.c.post(`/phones/calls/${c.id}/book`, { ...body, start_time: '2020-01-01 09:00' })).status, 400);
  // Booking needs schedule:write.
  const billing = await o.person('Bill Ing', 'billing');
  assert.equal((await billing.c.post(`/phones/calls/${c.id}/book`, body)).status, 403);
});

test('PH6: the provider’s live transcription webhook (signed, matched to the call) feeds the same path', async () => {
  const o = await office();
  await ring(o.voice, '+15125550100', 'CALIVE');
  const c = await callBySid('CALIVE');
  const path = `/api/webhooks/twilio/voice/transcription?call=${c.id}`;
  const params = { CallSid: 'CALIVE', TranscriptionEvent: 'transcription-content', TranscriptionData: JSON.stringify({ transcript: 'Anything next week in the morning?' }), Final: 'true', Track: 'inbound_track', SequenceId: '1' };
  assert.equal((await twilio(path, params, origin)).status, 204);
  assert.equal((await h.db.get('SELECT text FROM call_segments WHERE call_id = ?', c.id)).text, 'Anything next week in the morning?');
  // Unsigned, or naming a different call: ignored.
  const bad = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, SequenceId: '2' }) });
  assert.equal(bad.status, 403);
  await twilio(path, { ...params, CallSid: 'CAOTHER', SequenceId: '3' }, origin);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM call_segments WHERE call_id = ?', c.id)).n, 1);
});

test('PH5: an upset caller alerts the owner and office manager at once (chat, live, text with no patient details) until acknowledged', async () => {
  const o = await office();
  const manager = await o.person('Olive Manager', 'front_desk', ['phones:coach']);
  await o.admin.put('/phones/settings', { alert_user_ids: [o.admin && (await h.db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", o.practiceId)).id, manager.id], alert_sms_to: ['+15125550177'] });
  await ring(o.voice, '+15125550100', 'CAUPSET');
  const c = await callBySid('CAUPSET');
  const sentBefore = h.sent.length;
  await manager.c.post(`/phones/calls/${c.id}/sandbox-speech`, { text: 'This is ridiculous, nobody called me back and I want to speak to the manager!' });
  const alert = await h.db.get("SELECT * FROM phone_alerts WHERE call_id = ? AND kind = 'upset'", c.id);
  assert.ok(alert, 'raised');
  assert.equal(alert.source, 'live');
  assert.match(alert.quote, /ridiculous/);
  assert.equal(alert.patient_id, o.patient.id);
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", o.practiceId, `phone-alert:${alert.id}`);
  assert.equal(issue.kind, 'phones');
  const msg = await h.db.get("SELECT m.* FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id WHERE c.practice_id = ? AND c.dm_key = 'phone-alerts'", o.practiceId);
  assert.equal(msg.patient_id, o.patient.id);
  assert.match(msg.body, new RegExp(`/calls\\?open=${c.id}`));
  const members = (await h.db.all("SELECT user_id FROM chat_members m JOIN chat_channels c ON c.id = m.channel_id WHERE c.practice_id = ? AND c.dm_key = 'phone-alerts'", o.practiceId)).map((m) => m.user_id);
  assert.ok(members.includes(manager.id));
  const texts = h.sent.slice(sentBefore);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, '+15125550177');
  assert.doesNotMatch(texts[0].body, /Jane|Doe|ridiculous/, 'no patient details in the text');

  // Said again: still one alert.
  await manager.c.post(`/phones/calls/${c.id}/sandbox-speech`, { text: 'Unacceptable. The worst.' });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM phone_alerts WHERE call_id = ?', c.id)).n, 1);

  // A front-desk person who isn't told about alerts can't list or acknowledge them.
  const desk = await o.person('Dana Desk', 'front_desk');
  assert.equal((await desk.c.get('/phones/alerts')).status, 403);
  assert.equal((await desk.c.post(`/phones/alerts/${alert.id}/ack`, {})).status, 403);
  assert.equal((await manager.c.get('/phones/alerts')).data.length, 1);
  const ack = await manager.c.post(`/phones/alerts/${alert.id}/ack`, { note: 'Called her back, rebooked.' });
  assert.equal(ack.data.status, 'acknowledged');
  assert.equal(ack.data.ack_by, manager.id);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'phone_alert.acknowledge' AND entity_id = ?", alert.id));
  assert.equal((await manager.c.get('/phones/alerts')).data.length, 0);
  // Another practice can't acknowledge it.
  const other = await office();
  assert.equal((await other.admin.post(`/phones/alerts/${alert.id}/ack`, {})).status, 404);
});

test('PH4: reasons for not booking — confirmed with one click, counted with frequencies and a weekly trend, drill-down to calls', async () => {
  const o = await office();
  const desk = await o.person('Dana Desk', 'front_desk');
  const mk = async (at, transcript) => (await h.db.run("INSERT INTO calls (practice_id, direction, purpose, status, desk_result, outcome, transcript, from_number, created_at) VALUES (?, 'inbound', 'inbound', 'completed', 'answered', 'answered', ?, '+15125550888', ?)", o.practiceId, transcript, at)).id;
  const today = localNow('UTC').slice(0, 10);
  const ids = [];
  for (const [d, reason] of [[0, 'cost'], [1, 'cost'], [2, 'insurance'], [8, 'cost'], [9, 'think']]) {
    const id = await mk(`${addDays(today, -d)} 15:00:00`, 'Caller: How much is it?');
    ids.push(id);
    const r = await desk.c.post(`/phones/calls/${id}/no-book`, { reason });
    assert.equal(r.status, 200);
  }
  assert.equal((await desk.c.post(`/phones/calls/${ids[0]}/no-book`, { reason: 'nope' })).status, 400);
  assert.equal((await desk.c.post(`/phones/calls/${ids[0]}/no-book`, { reason: 'other' })).status, 400, '“other” needs a few words');
  // Changing a reason is recorded before/after.
  await desk.c.post(`/phones/calls/${ids[4]}/no-book`, { reason: 'shopping' });
  const change = await h.db.get("SELECT changes FROM audit_log WHERE action = 'call.no_book.change' ORDER BY id DESC LIMIT 1");
  assert.match(change.changes, /think.*shopping/);

  const stats = (await o.admin.get(`/phones/no-book?from=${addDays(today, -30)}&to=${today}`)).data;
  assert.equal(stats.total, 5);
  const cost = stats.reasons.find((r) => r.reason === 'cost');
  assert.deepEqual([cost.count, cost.pct], [3, 60]);
  assert.equal(stats.reasons[0].reason, 'cost', 'most frequent first');
  assert.equal(stats.trend.reduce((n, w) => n + w.total, 0), 5);
  assert.ok(stats.trend.length >= 2, 'by week');
  const drill = (await o.admin.get(`/phones/calls?reason=cost&from=${addDays(today, -30)}&to=${today}`)).data.calls;
  assert.equal(drill.length, 3);
  assert.equal((await desk.c.get('/phones/no-book')).status, 403, 'the practice-wide numbers are for coaches and reports');
});

test('PH3/PH7: the numbers — answer rate, time to answer, missed and abandoned by local hour, attributed to whoever was on shift; leaderboard and who sees it', async () => {
  const o = await office({ timezone: 'America/Chicago' });
  const amy = await o.person('Amy Answer', 'front_desk');
  const ben = await o.person('Ben Backup', 'front_desk');
  const cara = await o.person('Cara Clinical', 'hygienist');
  const coach = await o.person('Olive Manager', 'front_desk', ['phones:coach']);
  await o.admin.put('/phones/settings', { answerer_ids: [amy.id, ben.id] });
  const day = '2026-03-10'; // a Tuesday, Central Daylight Time (UTC-5)
  // Amy is clocked in 08:00-12:00; Ben is scheduled 12:00-17:00 (no punches); Cara (not a phone person) all day.
  await h.db.run("INSERT INTO time_punches (practice_id, user_id, clock_in, clock_out, eff_in, eff_out) VALUES (?, ?, ?, ?, ?, ?)", o.practiceId, amy.id, `${day} 08:00`, `${day} 12:00`, `${day} 08:00`, `${day} 12:00`);
  await h.db.run("INSERT INTO staff_shifts (practice_id, user_id, date, status, start_time, end_time) VALUES (?, ?, ?, 'scheduled', '12:00', '17:00')", o.practiceId, ben.id, day);
  await h.db.run("INSERT INTO staff_shifts (practice_id, user_id, date, status, start_time, end_time) VALUES (?, ?, ?, 'scheduled', '07:00', '18:00')", o.practiceId, cara.id, day);
  const mk = (localHm, row) => h.db.run(
    `INSERT INTO calls (practice_id, direction, purpose, status, from_number, to_number, desk_result, outcome, agent_id, ring_seconds, call_type, new_caller, appointment_id, created_at)
     VALUES (?, 'inbound', 'inbound', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.practiceId, row.from || '+15125550300', o.voice, row.desk ?? null, row.outcome ?? null, row.agent ?? null, row.ring ?? null, row.type ?? null, row.np ? 1 : 0, row.appt ?? null,
    utc(new Date(Date.parse(`${day}T${localHm}:00Z`) + 5 * 3600_000)),
  );
  // 09:xx local (Amy's morning): 3 answered by Amy (ring 4, 6, 8 s), one missed, one abandoned.
  const a1 = (await mk('09:05', { desk: 'answered', outcome: 'answered', agent: amy.id, ring: 4, type: 'new_patient', np: 1 })).id;
  await mk('09:10', { desk: 'answered', outcome: 'answered', agent: amy.id, ring: 6, type: 'new_patient', np: 1 });
  await mk('09:20', { desk: 'answered', outcome: 'answered', agent: amy.id, ring: 8, type: 'scheduling' });
  const missed = (await mk('09:40', { desk: 'missed', outcome: 'missed', from: '+15125550411' })).id;
  await mk('09:50', { desk: 'abandoned', outcome: 'hung_up' });
  // 14:xx local (Ben's afternoon): one answered by Ben, one missed.
  await mk('14:15', { desk: 'answered', outcome: 'answered', agent: ben.id, ring: 12 });
  await mk('14:45', { desk: 'missed', outcome: 'voicemail' });
  // After hours (never rang the desk): counted in totals, not in the answer rate.
  await mk('19:00', { outcome: 'after_hours' });
  // One of Amy's new-patient calls booked.
  const appt = (await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, '2026-03-12 10:00', '2026-03-12 11:00', 'scheduled')", o.practiceId, o.patient.id, o.provider.id)).id;
  await h.db.run('UPDATE calls SET appointment_id = ? WHERE id = ?', appt, a1);
  // A callback to the missed caller 30 minutes later.
  await h.db.run("INSERT INTO calls (practice_id, direction, purpose, status, to_number, created_at) VALUES (?, 'outbound', 'logged', 'completed', '(512) 555-0411', ?)", o.practiceId, utc(new Date(Date.parse(`${day}T10:10:00Z`) + 5 * 3600_000)));
  // Scores: Amy 80 (AI) on one call, overridden to 90 by the owner; Ben 60.
  await h.db.run("INSERT INTO call_scores (practice_id, call_id, call_type, score, steps, model) VALUES (?, ?, 'new_patient', 80, '[]', 'AI (sandbox)')", o.practiceId, a1);
  const benCall = (await h.db.get('SELECT id FROM calls WHERE agent_id = ?', ben.id)).id;
  await h.db.run("INSERT INTO call_scores (practice_id, call_id, call_type, score, steps, model) VALUES (?, ?, 'general', 60, '[]', 'AI (sandbox)')", o.practiceId, benCall);
  assert.equal((await amy.c.post(`/phones/calls/${a1}/reviews`, { rating: 95 })).status, 403, 'rating calls is for coaches');
  assert.equal((await coach.c.post(`/phones/calls/${a1}/reviews`, { rating: 90, comment: 'Lovely welcome — offer two times next time.' })).status, 201);

  const m = await phoneMetrics(h.db, o.practiceId, { from: day, to: day });
  assert.equal(m.totals.total, 8);
  assert.equal(m.totals.rang, 7);
  assert.equal(m.totals.answered, 4);
  assert.equal(m.totals.missed, 3, 'missed + abandoned');
  assert.equal(m.totals.abandoned, 1);
  assert.equal(m.totals.voicemail, 1);
  assert.equal(m.totals.missed_pct, Math.round(1000 * 3 / 7) / 10);
  assert.equal(m.totals.callbacks, 1);
  assert.equal(m.totals.callback_median_minutes, 30);
  assert.deepEqual([m.totals.new_patient_calls, m.totals.new_patient_booked, m.totals.new_patient_booked_pct], [2, 1, 50]);
  // Hours are the practice's local hours (UTC-5 that day), not UTC.
  assert.equal(m.by_hour[9].total, 5);
  assert.equal(m.by_hour[9].missed, 2);
  assert.equal(m.by_hour[14].total, 2);
  assert.equal(m.by_hour[14].missed_pct, 50);
  assert.equal(m.by_hour[19].total, 1);
  assert.equal(m.by_hour[14 + 5].total, 1, '19:00 local is the after-hours call, not 14:00 UTC-shifted');
  assert.equal(m.heatmap[2][9].missed, 2, 'Tuesday 9am');
  assert.equal(m.by_day[0].date, day);
  // Attribution: the morning's missed and abandoned calls are Amy's (clocked in), the afternoon's is Ben's (scheduled);
  // Cara was on shift but doesn't answer phones.
  const amyRow = m.people.find((p) => p.user_id === amy.id);
  const benRow = m.people.find((p) => p.user_id === ben.id);
  assert.deepEqual([amyRow.rang, amyRow.answered, amyRow.missed, amyRow.abandoned], [5, 3, 2, 1]);
  assert.equal(amyRow.answer_rate, 60);
  assert.equal(amyRow.avg_seconds_to_answer, 6);
  assert.equal(amyRow.new_patient_booked_pct, 50);
  assert.equal(amyRow.avg_score, 90, 'the owner’s rating replaces the AI’s');
  assert.deepEqual([benRow.rang, benRow.answered, benRow.missed, benRow.voicemail, benRow.avg_score], [2, 1, 1, 1, 60]);
  assert.ok(!m.people.some((p) => p.user_id === cara.id));
  assert.equal(m.by_position.find((x) => x.position === 'front_desk').rang, 7);

  // The leaderboard: the coach sees everyone, ranked; Amy sees only her own row; the metrics likewise.
  const board = (await coach.c.get(`/phones/leaderboard?from=${day}&to=${day}`)).data;
  assert.equal(board.scope, 'team');
  assert.deepEqual(board.rows.map((r) => r.user_id), [amy.id, ben.id]);
  assert.match(board.note, /coaching/i);
  const own = (await amy.c.get(`/phones/leaderboard?from=${day}&to=${day}`)).data;
  assert.deepEqual([own.scope, own.rows.map((r) => r.user_id), own.team_size], ['own', [amy.id], 2]);
  const ownMetrics = (await amy.c.get(`/phones/metrics?from=${day}&to=${day}`)).data;
  assert.deepEqual(ownMetrics.people.map((p) => p.user_id), [amy.id]);
  assert.equal(ownMetrics.by_hour, undefined);
  // Ben can't see Amy's call's score or comments.
  const benView = (await ben.c.get(`/phones/calls/${a1}/review`)).data;
  assert.deepEqual([benView.visible, benView.score, benView.reviews.length], [false, null, 0]);
  const amyView = (await amy.c.get(`/phones/calls/${a1}/review`)).data;
  assert.deepEqual([amyView.effective_score, amyView.effective_by, amyView.reviews.length], [90, 'owner', 1]);
  // Only a coach corrects who took a call.
  assert.equal((await amy.c.put(`/phones/calls/${missed}/agent`, { user_id: amy.id })).status, 403);
  assert.equal((await coach.c.put(`/phones/calls/${missed}/agent`, { user_id: ben.id, reason: 'Ben was covering' })).status, 200);
  assert.equal((await coach.c.get(`/phones/metrics?from=${day}&to=${day}`)).data.people.find((p) => p.user_id === ben.id).missed, 2);
});

test('PH7: a day over the missed-call target raises one alert (Needs attention + the owner told), resolved when acknowledged', async () => {
  const o = await office();
  await o.admin.put('/phones/settings', { missed_target_pct: 20, missed_min_calls: 4 });
  const now = new Date();
  for (const d of ['answered', 'answered', 'missed', 'abandoned', 'missed']) {
    await h.db.run("INSERT INTO calls (practice_id, direction, purpose, status, desk_result, created_at) VALUES (?, 'inbound', 'inbound', 'completed', ?, ?)", o.practiceId, d, utc(new Date(now.getTime() - 60_000)));
  }
  const raised = await runMissedCallCheck(h.db, { messenger: h.messenger, practiceId: o.practiceId, now });
  assert.equal(raised.length, 1);
  assert.deepEqual(await runMissedCallCheck(h.db, { messenger: h.messenger, practiceId: o.practiceId, now }), [], 'once a day');
  const alert = await h.db.get("SELECT * FROM phone_alerts WHERE practice_id = ? AND kind = 'missed_rate'", o.practiceId);
  assert.match(alert.detail, /3 of 5 calls missed today \(60%; target 20%\)/);
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", o.practiceId, `phone-alert:${alert.id}`));
  assert.ok(await h.db.get("SELECT m.id FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id WHERE c.practice_id = ? AND c.dm_key = 'phone-alerts' AND m.body LIKE '%over target%'", o.practiceId));
  await o.admin.post(`/phones/alerts/${alert.id}/ack`, { note: 'Two out sick today' });
  assert.equal((await h.db.get("SELECT status FROM issues WHERE dedupe_key = ?", `phone-alert:${alert.id}`)).status, 'resolved');
  // Under target: nothing.
  const calm = await office();
  await calm.admin.put('/phones/settings', { missed_target_pct: 50, missed_min_calls: 1 });
  await h.db.run("INSERT INTO calls (practice_id, direction, purpose, status, desk_result, created_at) VALUES (?, 'inbound', 'inbound', 'completed', 'answered', ?)", calm.practiceId, utc(now));
  assert.deepEqual(await runMissedCallCheck(h.db, { practiceId: calm.practiceId, now }), []);
});

test('the desk phone’s answer: ring time recorded; a missed call and a caller who hung up while it rang are told apart', async () => {
  const o = await office();
  const desk = await o.person('Dana Desk', 'front_desk');
  const today = localNow('UTC').slice(0, 10);
  await h.db.run("INSERT INTO staff_shifts (practice_id, user_id, date, status, start_time, end_time) VALUES (?, ?, ?, 'scheduled', '00:00', '23:59')", o.practiceId, desk.id, today);
  const done = async (sid, params) => {
    const c = await callBySid(sid);
    return twilio(`/api/webhooks/twilio/voice/dial-done?call=${c.id}`, params);
  };
  await ring(o.voice, '+15125550100', 'CADESK1');
  await h.db.run("UPDATE calls SET created_at = ? WHERE provider_id = 'CADESK1'", utc(new Date(Date.now() - 70_000)));
  await done('CADESK1', { DialCallStatus: 'completed', DialCallDuration: '60' });
  await new Promise((r) => setTimeout(r, 100));
  const a = await callBySid('CADESK1');
  assert.equal(a.desk_result, 'answered');
  assert.ok(a.ring_seconds >= 9 && a.ring_seconds <= 12, `rang about 10s (${a.ring_seconds})`);
  assert.equal(a.agent_id, desk.id, 'the only phone person on shift');
  assert.equal(a.agent_source, 'shift');
  await ring(o.voice, '+15125550100', 'CADESK2');
  await done('CADESK2', { DialCallStatus: 'no-answer' });
  assert.equal((await callBySid('CADESK2')).desk_result, 'missed');
  await ring(o.voice, '+15125550100', 'CADESK3');
  await done('CADESK3', { DialCallStatus: 'canceled' });
  assert.equal((await callBySid('CADESK3')).desk_result, 'abandoned');
  // A claim on screen: the first person keeps it.
  await ring(o.voice, '+15125550100', 'CADESK4');
  const c4 = await callBySid('CADESK4');
  assert.equal((await desk.c.post(`/phones/calls/${c4.id}/claim`)).data.mine, true);
  const other = await o.person('Other Desk', 'front_desk');
  assert.equal((await other.c.post(`/phones/calls/${c4.id}/claim`)).data.mine, false);
});
