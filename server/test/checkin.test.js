import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';

const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: `t${sent.length}` }; } };
const h = harness({ config: { twilioAuthToken: 'twilio-secret' }, messenger });
const post = (path, params) => fetch(`${h.origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', `https://app.example.com${path}`, params) }, body: new URLSearchParams(params),
}).then((r) => r.text());

test('mobile check-in: text HERE, or the QR code with phone and birth date; then “we’re ready for you”', async () => {
  const { api, patient, provider, practiceId } = await h.practice({ timezone: 'UTC', sms_number: '+15125558800', slug: 'bright' });
  await api.put(`/patients/${patient.id}`, { dob: '1990-04-05' });
  const kid = (await api.post('/patients', { first_name: 'Kit', last_name: 'Doe', dob: '2016-01-01', guarantor_id: patient.id })).data;
  const now = new Date(Date.now() + 30 * 60_000).toISOString();
  const at = `${now.slice(0, 10)} ${now.slice(11, 16)}`;
  const end = new Date(Date.now() + 90 * 60_000).toISOString();
  const hygienist = (await api.post('/providers', { name: 'Hy Gienist', type: 'hygienist' })).data;
  const book = (p, prov = provider) => api.post('/appointments', { patient_id: p.id, provider_id: prov.id, start_time: at, end_time: `${end.slice(0, 10)} ${end.slice(11, 16)}`, override_blockout: true, notify: false }).then((r) => r.data);
  if (at.slice(0, 10) !== end.slice(0, 10)) return; // the test can't run in the last 90 minutes of a UTC day
  const mine = await book(patient);
  const theirs = await book(kid, hygienist);

  const reply = await post('/api/webhooks/twilio/sms', { From: '+15125550100', To: '+15125558800', Body: "I'm here", MessageSid: 'SM1' });
  assert.match(reply, /Jane and Kit are checked in\. We&apos;ll text you when we&apos;re ready for you\./);
  for (const a of [mine, theirs]) {
    const row = await h.db.get('SELECT status, arrived_at, checked_in_via FROM appointments WHERE id = ?', a.id);
    assert.deepEqual([row.status, row.checked_in_via], ['checked_in', 'text']);
    assert.ok(row.arrived_at);
  }
  assert.match(await post('/api/webhooks/twilio/sms', { From: '+15125550100', To: '+15125558800', Body: 'here', MessageSid: 'SM2' }), /couldn&apos;t find a visit for today/);

  // The QR code: the kid's visit again (reset), found by the parent's number and the kid's birth date.
  await h.db.run("UPDATE appointments SET status = 'scheduled', arrived_at = NULL WHERE id = ?", theirs.id);
  assert.equal((await (await fetch(`${h.origin}/api/public/checkin/bright`)).json()).name, (await h.db.get('SELECT name FROM practices WHERE id = ?', practiceId)).name);
  const qr = (body) => fetch(`${h.origin}/api/public/checkin/bright`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await qr({ phone: '512-555-0100', dob: '1999-09-09' })).status, 404);
  const ok = await qr({ phone: '(512) 555-0100', dob: '2016-01-01' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).checked_in.map((c) => c.name), ['Kit']);
  assert.equal((await h.db.get('SELECT checked_in_via FROM appointments WHERE id = ?', theirs.id)).checked_in_via, 'qr');

  const ready = await api.post(`/appointments/${mine.id}/ready-text`, {});
  assert.equal(ready.data.status, 'sent');
  assert.equal(sent.at(-1).body, "We're ready for Jane! Please come on in.");
});

test('call tracking: calls on a tracking number are tagged, and new patients are credited to the source', async () => {
  const { api } = await h.practice({ timezone: 'UTC' });
  await api.put('/practice', { voice_number: '+15125557000', forward_to: '+15125551111', office_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]])) });
  assert.equal((await api.post('/tracking-numbers', { number: '12', source: 'x' })).status, 400);
  await api.post('/tracking-numbers', { number: '+1 512 555 7001', source: 'Google Ads', monthly_cost: 300 });
  await post('/api/webhooks/twilio/voice/inbound', { CallSid: 'CAT1', From: '+15125553333', To: '+15125557001' });
  await post('/api/webhooks/twilio/voice/inbound', { CallSid: 'CAT2', From: '+15125550100', To: '+15125557000' });
  const tagged = await h.db.get("SELECT source, new_caller FROM calls WHERE provider_id = 'CAT1'");
  assert.deepEqual([tagged.source, tagged.new_caller], ['Google Ads', 1]);
  // The caller becomes a patient and has work done.
  const p = (await api.post('/patients', { first_name: 'Nia', last_name: 'New', phone: '(512) 555-3333' })).data;
  const prov = (await api.get('/providers')).data[0];
  await api.post(`/patients/${p.id}/procedures`, { code: 'D0150', provider_id: prov.id, complete: true });
  const report = (await api.get('/calls/sources?days=30')).data.sources;
  const ads = report.find((s) => s.source === 'Google Ads');
  assert.deepEqual([ads.calls, ads.new_callers, ads.new_patients, ads.spend], [1, 1, 1, 30000]);
  assert.ok(ads.production > 0 && ads.cost_per_new_patient === 30000);
  assert.equal(report.find((s) => s.source === 'Main number').new_patients, 0);
});
