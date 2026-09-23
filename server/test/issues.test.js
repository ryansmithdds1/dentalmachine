import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { sendMessage } from '../src/messaging.js';
import { claimEvent } from '../src/era.js';
import { loggedFetch } from '../src/issues.js';

let fail = false;
const h = harness({ messenger: { status: { sms: 'test', email: 'test' }, send: async () => { if (fail) throw new Error('Carrier rejected the number'); return { provider_id: `ok-${Date.now()}` }; } } });

test('a text that fails becomes a front-desk item; the next one that goes through closes it', async () => {
  const { api, patient, practiceId } = await h.practice();
  const send = () => sendMessage(h.db, h.messenger, { practiceId, patientId: patient.id, channel: 'sms', to: '+15125550100', body: 'Hi', kind: 'custom' }).catch(() => null);
  fail = true;
  await send();
  await send();
  let list = (await api.get('/issues?role=front_desk')).data;
  assert.equal(list.issues.length, 1, 'the same failure twice is one item');
  assert.equal(list.issues[0].occurrences, 2);
  assert.match(list.issues[0].title, /didn't go/);
  assert.match(list.issues[0].detail, /Carrier rejected/);
  assert.equal(list.open.front_desk, 1);
  fail = false;
  await send();
  list = (await api.get('/issues?status=resolved')).data;
  assert.equal(list.issues.length, 1);
  assert.match(list.issues[0].resolution, /later message/);
});

test('a rejected claim is a billing item until it goes through; staff resolve with a note, and it is audited', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '1' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X' })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const made = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
  const c = await h.db.get('SELECT * FROM claims WHERE id = ?', made.id);
  await claimEvent(h.db, c, '277', 'rejected', 'Subscriber ID invalid');
  let [item] = (await api.get('/issues?kind=claim')).data.issues;
  assert.equal(item.role, 'billing');
  assert.equal(item.severity, 'high');
  await claimEvent(h.db, c, 'submit', 'sent', 'Resent');
  assert.equal((await api.get('/issues?kind=claim')).data.issues.length, 0);
  await claimEvent(h.db, c, '835', 'denied', 'Frequency');
  [item] = (await api.get('/issues?kind=claim')).data.issues;
  assert.equal((await api.patch(`/issues/${item.id}`, { status: 'resolved' })).status, 400, 'a note is required');
  const done = await api.patch(`/issues/${item.id}`, { status: 'resolved', note: 'Appealed with x-rays' });
  assert.equal(done.status, 200);
  assert.equal(done.data.resolution, 'Appealed with x-rays');
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'issue.resolved' AND entity_id = ?", item.id);
  assert.equal(log.reason, 'Appealed with x-rays');
});

test('calls to outside services are logged (host and path only) and summarized for administrators', async () => {
  const { api, practiceId } = await h.practice();
  const fake = async (url) => (String(url).includes('fail') ? { ok: false, status: 503, headers: new Map() } : { ok: true, status: 200, headers: new Map([['request-id', 'req_1']]) });
  const f = loggedFetch(h.db, fake);
  const { withActor } = await import('../src/actor.js');
  await withActor({ source: 'automation', actor: 'test', practiceId }, async () => {
    await f('https://api.twilio.com/2010-04-01/Accounts/AC1234567890abcdef1234/Messages.json?secret=1', { method: 'POST' });
    await f('https://api.twilio.com/fail');
    await f('http://localhost:9/skip');
  });
  const out = (await api.get('/integration-log')).data;
  assert.equal(out.rows.length, 2);
  assert.ok(out.rows.every((r) => r.service === 'Twilio' && !r.operation.includes('secret')));
  assert.match(out.rows[1].operation, /\/:id\//);
  assert.equal(out.summary[0].failures, 1);
});
