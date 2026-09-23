import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';

const h = harness({ config: { twilioAuthToken: 'tw-secret' } });
const day = '2031-03-03';

test("a cancelled appointment can't be pointed at another practice's patient", async () => {
  const mine = await h.practice();
  const theirs = await h.practice();
  const appt = (await mine.api.post('/appointments', { patient_id: mine.patient.id, provider_id: mine.provider.id, start_time: `${day} 09:00`, end_time: `${day} 09:30` })).data;
  await mine.api.put(`/appointments/${appt.id}`, { status: 'cancelled' });
  for (const body of [{ status: 'cancelled', patient_id: theirs.patient.id }, { status: 'no_show', provider_id: theirs.provider.id }, { status: 'cancelled', patient_id: theirs.patient.id, video: true }]) {
    const res = await mine.api.put(`/appointments/${appt.id}`, body);
    assert.equal(res.status, 404, JSON.stringify(res.data));
  }
  const slip = (await mine.api.get(`/appointments/${appt.id}/route-slip`)).data;
  assert.equal(slip.patient.id, mine.patient.id);
});

test("completing a procedure can't attach it to another practice's (or patient's) visit", async () => {
  const mine = await h.practice();
  const theirs = await h.practice();
  const other = (await theirs.api.post('/appointments', { patient_id: theirs.patient.id, provider_id: theirs.provider.id, start_time: `${day} 10:00`, end_time: `${day} 10:30` })).data;
  const proc = (await mine.api.post(`/patients/${mine.patient.id}/procedures`, { code: 'D0150', provider_id: mine.provider.id })).data;
  assert.equal((await mine.api.post(`/procedures/${proc.id}/complete`, { appointment_id: other.id })).status, 404);
  const sibling = (await mine.api.post('/patients', { first_name: 'Sam', last_name: 'Doe' })).data;
  const siblingVisit = (await mine.api.post('/appointments', { patient_id: sibling.id, provider_id: mine.provider.id, start_time: `${day} 11:00`, end_time: `${day} 11:30` })).data;
  assert.equal((await mine.api.post(`/procedures/${proc.id}/complete`, { appointment_id: siblingVisit.id })).status, 404, "another patient's visit");
  assert.equal((await mine.api.put(`/procedures/${proc.id}`, { appointment_id: siblingVisit.id })).status, 400);
  assert.equal((await mine.api.post(`/procedures/${proc.id}/complete`, {})).status, 200);
});

test("a practice can't claim the shared or another practice's texting number; replies go to whoever texted the patient", async () => {
  process.env.TWILIO_FROM = '+15125550999';
  try {
    const a = await h.practice();
    const b = await h.practice();
    assert.equal((await b.api.put('/practice', { sms_number: '(512) 555-0999' })).status, 400, 'the shared number');
    assert.equal((await a.api.put('/practice', { sms_number: '+15125550777' })).status, 200);
    assert.equal((await b.api.put('/practice', { sms_number: '512-555-0777' })).status, 409, "someone else's number");
    // Practice B texted its patient last; the reply to the shared number lands in B, not A.
    const pat = (await b.api.post('/patients', { first_name: 'Rae', last_name: 'Lin', phone: '(512) 555-4321', sms_opt_in: true })).data;
    await b.api.post(`/patients/${pat.id}/messages`, { channel: 'sms', body: 'See you Tuesday' });
    const params = { From: '+15125554321', To: '+15125550999', Body: 'Thanks!', MessageSid: 'SM1' };
    const url = `${h.config.appUrl}/api/webhooks/twilio/sms`;
    const sig = createHmac('sha1', 'tw-secret').update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
    const res = await fetch(`${h.origin}/api/webhooks/twilio/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params) });
    assert.equal(res.status, 200);
    const inbound = await h.db.get("SELECT practice_id, patient_id FROM messages WHERE provider_id = 'SM1'");
    assert.deepEqual([inbound.practice_id, inbound.patient_id], [b.practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', pat.id)).practice_id, pat.id]);
  } finally {
    delete process.env.TWILIO_FROM;
  }
});
