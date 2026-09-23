import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';

const h = harness({ config: { twilioAuthToken: 'tw' }, messenger: { status: { sms: 'test', email: 'test' }, send: async () => ({ provider_id: 'x' }) } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the same request twice (double click, resend) posts one payment and gets the same answer', async () => {
  const { token, patient } = await h.practice();
  const pay = (key, amount = 2500) => fetch(`${h.origin}/api/patients/${patient.id}/payments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: JSON.stringify({ amount, method: 'cash' }),
  });
  const first = await pay('key-abc-123');
  assert.equal(first.status, 201);
  const a = await first.json();
  await wait(50);
  const again = await pay('key-abc-123');
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('Idempotent-Replay'), 'true');
  assert.equal((await again.json()).entry.id, a.entry.id);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", patient.id)).n, 1);
  assert.equal((await pay('key-abc-123', 9900)).status, 422, 'a key reused for a different request is refused');
  assert.equal((await pay('bad key')).status, 400);
  // Two genuinely separate payments (different keys) both post.
  assert.equal((await pay('key-def-456')).status, 201);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", patient.id)).n, 2);
});

test('the database refuses a second live charge for the same procedure', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  await assert.rejects(h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, procedure_id, type, amount, entry_date, description) VALUES (?, ?, ?, 'charge', 100, '2030-01-01', 'dup')", practiceId, patient.id, p.id));
});

test('a text Twilio delivers twice is handled once', async () => {
  const { practiceId } = await h.practice({ sms_number: '+15125556611' });
  const params = { From: '+15125550100', To: '+15125556611', Body: 'Hello there', MessageSid: 'SMdup1' };
  const send = () => fetch(`${h.origin}/api/webhooks/twilio/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('tw', 'https://app.example.com/api/webhooks/twilio/sms', params) }, body: new URLSearchParams(params) });
  await send();
  await send();
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM messages WHERE practice_id = ? AND provider_id = 'SMdup1'", practiceId)).n, 1);
});

test('an insurance check already posted is refused unless confirmed as a genuine second payment', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '1' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X' })).data;
  const claimFor = async () => {
    const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
    const c = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] })).data;
    await api.post(`/claims/${c.id}/submit`);
    return c;
  };
  const c1 = await claimFor();
  const c2 = await claimFor();
  assert.equal((await api.post('/insurance-checks', { carrier_id: carrier.id, check_number: '777', amount: 5000, claims: [{ claim_id: c1.id, paid: 5000 }] })).status, 201);
  const dup = await api.post('/insurance-checks', { carrier_id: carrier.id, check_number: '777', amount: 5000, claims: [{ claim_id: c2.id, paid: 5000 }] });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already posted/);
  assert.equal((await api.post('/insurance-checks', { carrier_id: carrier.id, check_number: '777', amount: 5000, confirm_duplicate: true, claims: [{ claim_id: c2.id, paid: 5000 }] })).status, 201);
});
