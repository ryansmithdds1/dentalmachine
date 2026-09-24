// The screen pop (workflow 5): who's calling, a family sharing one number, attaching an unknown caller to a
// patient, and texting a caller back — plus replying again from the Messages inbox afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';

const h = harness({ config: { twilioAuthToken: 'twilio-secret', twilioAccountSid: 'AC1' } });
const ring = (params) => fetch(`${h.origin}/api/webhooks/twilio/voice/inbound`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', 'https://app.example.com/api/webhooks/twilio/voice/inbound', params) },
  body: new URLSearchParams(params),
}).then((r) => r.text());
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));
const callFor = (sid) => h.db.get('SELECT * FROM calls WHERE provider_id = ?', sid);
let sid = 0;
const setup = async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const voice = `+1512555${String(9100 + (++sid)).slice(-4)}`;
  await p.api.put('/practice', { voice_number: voice, forward_to: '+15125551111', office_hours: ALWAYS_OPEN });
  return { ...p, voice };
};

test('a family sharing one number: the pop lists everyone on file with it, the account holder first', async () => {
  const { api, patient, voice } = await setup();
  const kid = (await api.post('/patients', { first_name: 'Tim', last_name: 'Doe', dob: '2015-02-02', phone: '512-555-0100', guarantor_id: patient.id })).data;
  await api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01', phone: '(512) 555-0199' });
  await ring({ CallSid: 'CAFAM', From: '+15125550100', To: voice });
  const call = await callFor('CAFAM');
  const pop = (await api.get(`/calls/${call.id}`)).data;
  assert.equal(pop.card.id, patient.id);
  assert.deepEqual(pop.matches.map((m) => m.id), [patient.id, kid.id]);
  assert.equal(pop.matches[0].phone, undefined, 'no extra contact details in the list');
  assert.equal(pop.textable, true);
});

test('an unknown caller: attach to a patient (number saved when they had none), recorded and audited', async () => {
  const { api, voice, practiceId } = await setup();
  const nophone = (await api.post('/patients', { first_name: 'Nora', last_name: 'Nophone', dob: '1970-03-03' })).data;
  await ring({ CallSid: 'CAUNK', From: '+15125550777', To: voice });
  const call = await callFor('CAUNK');
  const pop = (await api.get(`/calls/${call.id}`)).data;
  assert.deepEqual([pop.card, pop.matches], [null, []]);

  // Another practice's patient can't be attached.
  const other = await setup();
  assert.equal((await api.patch(`/calls/${call.id}`, { patient_id: other.patient.id })).status, 404);

  assert.equal((await api.patch(`/calls/${call.id}`, { patient_id: nophone.id })).status, 200);
  assert.equal((await h.db.get('SELECT patient_id FROM calls WHERE id = ?', call.id)).patient_id, nophone.id);
  assert.equal((await h.db.get('SELECT phone FROM patients WHERE id = ?', nophone.id)).phone, '+15125550777');
  const row = await h.db.get("SELECT * FROM audit_log WHERE action = 'call.attach' AND entity_id = ? AND practice_id = ?", call.id, practiceId);
  assert.ok(row, 'audited');
  assert.match(row.changes, /patient_id/);
  const after = (await api.get(`/calls/${call.id}`)).data;
  assert.equal(after.card.id, nophone.id);
});

test('text back an unknown caller from the pop, once per click, then keep the conversation going from Messages', async () => {
  const { api, token, voice } = await setup();
  await ring({ CallSid: 'CATXT', From: '+15125550888', To: voice });
  const call = await callFor('CATXT');
  const n = h.sent.length;
  assert.equal((await api.post(`/calls/${call.id}/text`, { body: '  ' })).status, 400);
  // The same request twice (a double click) sends once.
  const send = () => fetch(`${h.origin}/api/calls/${call.id}/text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `calltext-${call.id}-1` }, body: JSON.stringify({ body: 'Hi, we just missed you — how can we help?' }),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const first = await send();
  const again = await send();
  assert.equal(first.status, 201);
  assert.equal(again.data.id, first.data.id);
  assert.equal(h.sent.length, n + 1);
  assert.equal(h.sent.at(-1).to, '+15125550888');
  assert.equal(first.data.thread, 'n5125550888');

  const threads = (await api.get('/conversations')).data;
  assert.ok(threads.some((t) => t.thread === 'n5125550888'), 'shows in the inbox');
  const reply = await api.post('/conversations/n5125550888/reply', { body: 'Still here if you need us.' });
  assert.equal(reply.status, 201);
  assert.equal(h.sent.at(-1).to, '+15125550888');
});

test('a caller from a number that can’t be texted gets no text-back option', async () => {
  const { api, voice } = await setup();
  await ring({ CallSid: 'CAINTL', From: '+442071234567', To: voice });
  const call = await callFor('CAINTL');
  assert.equal((await api.get(`/calls/${call.id}`)).data.textable, false);
  assert.equal((await api.post(`/calls/${call.id}/text`, { body: 'Hello' })).status, 400);
});
