import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';
import { listen } from '../src/cluster.js';

// A stand-in for the Anthropic API: each reply is content blocks, or a function of the request.
const seen = [];
const queue = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    seen.push(parsed);
    const next = queue.shift() || [{ type: 'text', text: 'Okay.' }];
    const content = typeof next === 'function' ? next(parsed) : next;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: `t-${sent.length}` }; }, call: async () => ({ provider_id: 'CA0' }) };
const fetchImpl = async (url, opts) => (String(url).startsWith('https://api.twilio.com/rec/') ? new Response(Buffer.from('ID3-fake-mp3'), { status: 200 }) : fetch(url, opts));
const h = harness({
  config: { twilioAuthToken: 'twilio-secret', twilioAccountSid: 'AC1', transcribe: 'sandbox', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } },
  messenger, fetchImpl,
});
const post = (path, params) => fetch(`${h.origin}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', `https://app.example.com${path}`, params) },
  body: new URLSearchParams(params),
}).then((r) => r.text());
const pathOf = (twiml, attr) => new URL(twiml.match(new RegExp(`${attr}="([^"]+)"`))[1].replace(/&amp;/g, '&')).pathname + new URL(twiml.match(new RegExp(`${attr}="([^"]+)"`))[1].replace(/&amp;/g, '&')).search;
const wait = async (fn) => { for (let i = 0; i < 250; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));

test('an answered call: screen pop, recorded both sides, transcribed and summarized, with a follow-up task', async () => {
  const { api, token, patient, practiceId } = await h.practice({ timezone: 'UTC' });
  await api.put('/practice', { voice_number: '+1 512 555 9000', forward_to: '+15125551111', record_calls: true, office_hours: ALWAYS_OPEN });
  const events = [];
  listen(`practice:${practiceId}`, (e) => events.push(e));

  const twiml = await post('/api/webhooks/twilio/voice/inbound', { CallSid: 'CA100', From: '+15125550100', To: '+15125559000' });
  assert.match(twiml, /This call may be recorded/);
  assert.match(twiml, /<Dial timeout="20" action="[^"]+dial-done\?call=\d+" record="record-from-answer-dual" recordingStatusCallback="[^"]+"><Number>\+15125551111<\/Number><\/Dial>/);
  const call = await h.db.get("SELECT * FROM calls WHERE provider_id = 'CA100'");
  assert.deepEqual([call.patient_id, call.direction, call.status], [patient.id, 'inbound', 'ringing']);
  const pop = events.find((e) => e.type === 'call' && e.event === 'ringing');
  assert.deepEqual(pop.patient, { id: patient.id, name: 'Jane Doe' });
  const card = (await api.get(`/calls/${call.id}`)).data.card;
  assert.equal(card.first_name, 'Jane');

  assert.equal(await post(pathOf(twiml, 'action'), { DialCallStatus: 'completed', DialCallDuration: '95' }), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  queue.push([{ type: 'tool_use', id: 'tu1', name: 'call_summary', input: { summary: 'Jane asked to move her cleaning; offered Thursday at 10.', reason: 'reschedule', follow_up: true, follow_up_note: 'Move Jane’s cleaning to Thursday 10:00' } }]);
  await post(pathOf(twiml, 'recordingStatusCallback'), { RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingStatus: 'completed' });
  const done = await wait(async () => (await h.db.get('SELECT * FROM calls WHERE id = ? AND summary IS NOT NULL', call.id)));
  assert.ok(done, 'summarized');
  assert.deepEqual([done.outcome, done.duration, done.reason, done.follow_up], ['answered', 95, 'reschedule', 1]);
  assert.match(done.transcript, /^Caller: Hi, I need to move my cleaning/);
  assert.match(seen.at(-1).messages[0].content, /Jane Doe \(patient\)/);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Call from Jane Doe: Move Jane’s cleaning/.test(t.title)));
  const audio = await fetch(`${h.origin}/api/calls/${call.id}/recording`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'ID3-fake-mp3');
  const log = (await api.get('/calls')).data;
  assert.equal(log.calls[0].has_recording, 1);
  assert.equal(log.stats.inbound, 1);
});

test('a missed call gets a text back, then the AI receptionist books a new patient’s request', async () => {
  const { api, provider } = await h.practice({ timezone: 'UTC', slug: 'smiles', online_booking: true });
  await api.put('/practice', { voice_number: '+15125559001', forward_to: '+15125551111', ai_receptionist: 'missed', office_hours: ALWAYS_OPEN });
  const n = sent.length;
  const ring = await post('/api/webhooks/twilio/voice/inbound', { CallSid: 'CA200', From: '+15125557777', To: '+15125559001' });
  const miss = await post(pathOf(ring, 'action'), { DialCallStatus: 'no-answer' });
  assert.match(miss, /<Redirect method="POST">[^<]+\/voice\/ai\?call=\d+<\/Redirect>/);
  const text = await wait(() => sent.slice(n).find((m) => /Sorry we missed your call/.test(m.body)));
  assert.equal(text.to, '(512) 555-7777');
  assert.match(text.body, /book online: https:\/\/app\.example\.com\/book\/smiles/);

  const call = await h.db.get("SELECT * FROM calls WHERE provider_id = 'CA200'");
  queue.push([{ type: 'text', text: 'Thanks for calling! How can I help?' }]);
  const hello = await post(`/api/webhooks/twilio/voice/ai?call=${call.id}`, {});
  assert.match(hello, /<Gather input="speech"[^>]+action="[^"]+\/ai\/turn\?call=\d+"[^>]*><Say[^>]*>Thanks for calling! How can I help\?<\/Say><\/Gather>/);
  assert.match(seen.at(-1).system, /isn’t on file: they may be new/);

  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  queue.push(
    [{ type: 'tool_use', id: 't1', name: 'open_times', input: { date: tomorrow } }],
    (req) => {
      const times = JSON.parse(req.messages.at(-1).content[0].content);
      const p = times.providers[0];
      return [{ type: 'tool_use', id: 't2', name: 'book_visit', input: { start: p.times[0], provider_id: p.provider_id, reason: 'Cleaning', first_name: 'Sam', last_name: 'New', dob: '1990-02-03', existing_patient: false } }];
    },
    [{ type: 'text', text: 'You’re all set — the team will text you to confirm.' }],
  );
  const turn = await post(`/api/webhooks/twilio/voice/ai/turn?call=${call.id}`, { SpeechResult: 'I would like a cleaning tomorrow. Sam New, February 3rd 1990.' });
  assert.match(turn, /You’re all set/);
  const request = await h.db.get('SELECT * FROM booking_requests WHERE phone = ?', '(512) 555-7777');
  assert.deepEqual([request.first_name, request.provider_id, request.status, request.requested_start.slice(0, 10)], ['Sam', provider.id, 'pending', tomorrow]);

  queue.push([{ type: 'text', text: 'Goodbye!' }, { type: 'tool_use', id: 't3', name: 'end_call', input: {} }], [{ type: 'tool_use', id: 's1', name: 'call_summary', input: { summary: 'New patient Sam New requested a cleaning.', reason: 'new_patient', follow_up: true, follow_up_note: 'Confirm Sam New’s request' } }]);
  const bye = await post(`/api/webhooks/twilio/voice/ai/turn?call=${call.id}`, { SpeechResult: 'That’s all, thanks' });
  assert.match(bye, /Goodbye!<\/Say><Hangup\/>/);
  const ended = await wait(async () => h.db.get('SELECT * FROM calls WHERE id = ? AND summary IS NOT NULL', call.id));
  assert.deepEqual([ended.purpose, ended.outcome, ended.reason], ['receptionist', 'requested', 'new_patient']);
  assert.match(ended.transcript, /Caller: I would like a cleaning tomorrow/);
  assert.match(ended.transcript, /Receptionist: You’re all set/);
  assert.equal((await api.get('/calls?filter=follow_up')).data.calls.length, 1);
});

test('after hours with the receptionist off: voicemail, and a text back', async () => {
  const { api } = await h.practice({ timezone: 'UTC' });
  await api.put('/practice', { voice_number: '+15125559002', forward_to: '+15125551111', office_hours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } });
  const n = sent.length;
  const twiml = await post('/api/webhooks/twilio/voice/inbound', { CallSid: 'CA300', From: '+15125556666', To: '+15125559002' });
  assert.match(twiml, /We can&apos;t take your call right now.*<Record maxLength="120"/);
  assert.ok(await wait(() => sent.slice(n).find((m) => /Sorry we missed your call/.test(m.body))));
  assert.equal((await h.db.get("SELECT outcome FROM calls WHERE provider_id = 'CA300'")).outcome, 'after_hours');
  assert.equal((await api.put('/practice', { ai_receptionist: 'sometimes' })).status, 400);
  assert.equal((await api.put('/practice', { forward_to: 'hello' })).status, 400);
  const forged = await fetch(`${h.origin}/api/webhooks/twilio/voice/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: 'From=1&To=2' });
  assert.equal(forged.status, 403);
});
