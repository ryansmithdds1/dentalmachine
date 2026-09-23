import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';
import { sendMessage } from '../src/messaging.js';

const h = harness({ config: { twilioAuthToken: 'twilio-secret' } });

const inbound = (params) => fetch(`${h.origin}/api/webhooks/twilio/sms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', 'https://app.example.com/api/webhooks/twilio/sms', params) },
  body: new URLSearchParams(params),
});

test('STOP from any number blocks every later text to it, until the number texts START', async () => {
  const { api, provider } = await h.practice();
  await api.put('/practice', { sms_number: '+15125557001' });
  const base = { From: '+15125550199', To: '+15125557001' };
  // Someone who isn't a patient yet texts, then opts out.
  assert.equal((await inbound({ ...base, Body: 'Do you take Delta?', MessageSid: 'SM10' })).status, 200);
  await inbound({ ...base, Body: 'STOP', MessageSid: 'SM11' });
  const threads = (await api.get('/conversations')).data;
  const thread = threads.find((t) => !t.patient_id);
  assert.equal((await api.post(`/conversations/${encodeURIComponent(thread.thread)}/reply`, { body: 'Yes we do!' })).status, 409);

  // They become a patient with that number and texting switched on: still nothing goes out.
  const p = (await api.post('/patients', { first_name: 'Nia', last_name: 'New', phone: '(512) 555-0199', sms_opt_in: true })).data;
  assert.equal(p.sms_opt_in, 0, 'a number that said STOP starts opted out');
  await h.db.run('UPDATE patients SET sms_opt_in = 1 WHERE id = ?', p.id); // e.g. imported from another system
  const appt = (await api.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: '2030-05-01 09:00', end_time: '2030-05-01 10:00' })).data;
  await api.post(`/appointments/${appt.id}/remind`, { channel: 'sms' });
  const msgs = (await api.get(`/messages?patient_id=${p.id}`)).data;
  const sms = msgs.filter((m) => m.channel === 'sms' && m.direction !== 'inbound');
  assert.ok(sms.length >= 1);
  assert.ok(sms.every((m) => m.status === 'blocked'), JSON.stringify(sms.map((m) => [m.status, m.error])));
  assert.match(sms[0].error, /STOP/);
  assert.equal(h.sent.filter((s) => s.to === '(512) 555-0199').length, 0, 'nothing reached the carrier');

  // Staff can't switch texting back on for a number that said STOP.
  await h.db.run('UPDATE patients SET sms_opt_in = 0 WHERE id = ?', p.id);
  const again = await api.put(`/patients/${p.id}`, { sms_opt_in: true });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /text START/);

  // START clears it.
  await inbound({ ...base, Body: 'START', MessageSid: 'SM12' });
  assert.equal((await api.get(`/patients/${p.id}`)).data.sms_opt_in, 1);
  const before = h.sent.length;
  await api.post(`/appointments/${appt.id}/remind`, { channel: 'sms' });
  assert.equal(h.sent.length, before + 1);
});

test('every send path honours the patient preference; sign-in codes the patient asked for still go', async () => {
  const { api, patient } = await h.practice();
  await api.put(`/patients/${patient.id}`, { email_opt_in: false });
  const practiceId = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  const before = h.sent.length;
  const blocked = await sendMessage(h.db, h.messenger, { practiceId, patientId: patient.id, channel: 'email', to: patient.email, subject: 'Hi', body: 'Statement', kind: 'statement' });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error, /opted out of email/);
  const code = await sendMessage(h.db, h.messenger, { practiceId, patientId: patient.id, channel: 'email', to: patient.email, subject: 'Code', body: '123456', kind: 'portal_code' });
  assert.equal(code.status, 'sent');
  assert.equal(h.sent.length, before + 1);
  // Turning email back on (patient asked at the desk) works.
  assert.equal((await api.put(`/patients/${patient.id}`, { email_opt_in: true })).status, 200);
});
