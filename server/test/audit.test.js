import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { twilioSignature } from '../src/routes/sms.js';
import { runExclusive } from '../src/cluster.js';
import { insert } from '../src/util.js';

const h = harness({ config: { twilioAuthToken: 'tw' }, messenger: { status: { sms: 'test', email: 'test' }, send: async () => ({ provider_id: 'x' }) } });
const rows = (pid, where = '', ...args) => h.db.all(`SELECT * FROM audit_log WHERE practice_id = ? ${where} ORDER BY id`, pid, ...args);
const parse = (r) => (r.changes ? JSON.parse(r.changes) : null);

test('edits record before and after, who did it, and why — once per action', async () => {
  const { api, patient, practiceId } = await h.practice();
  const r = await api.put(`/patients/${patient.id}`, { phone: '(512) 555-0199', email: 'jane@example.com', change_reason: 'Patient called with a new number' });
  assert.equal(r.status, 200);
  const edits = await rows(practiceId, "AND entity = 'patients' AND entity_id = ? AND action != 'patient.create' AND changes IS NOT NULL", patient.id);
  assert.equal(edits.length, 1, 'the changes ride on the route’s own entry');
  const e = edits[0];
  assert.deepEqual(parse(e).phone, ['(512) 555-0100', '(512) 555-0199']);
  assert.equal(parse(e).email, undefined, 'unchanged fields aren’t listed');
  assert.deepEqual([e.source, e.patient_id, e.reason], ['human', patient.id, 'Patient called with a new number']);
  assert.ok(e.actor && e.user_id);
});

test('money: a payment is recorded when posted, a void keeps the original with who and why; amounts can’t be edited', async () => {
  const { api, patient, practiceId } = await h.practice();
  const pay = (await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'cash' })).data.entry;
  const created = (await rows(practiceId, "AND entity = 'ledger_entries' AND entity_id = ?", pay.id)).find((x) => x.changes);
  assert.equal(parse(created).amount, -5000);
  assert.equal(created.patient_id, patient.id);
  const v = await api.post(`/ledger/${pay.id}/void`, { reason: 'Entered on the wrong account' });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  const voided = (await rows(practiceId, "AND entity = 'ledger_entries' AND entity_id = ? AND changes LIKE '%voided_at%'", pay.id))[0];
  assert.ok(voided, 'the void is recorded with its before and after');
  assert.deepEqual(parse(voided).void_reason, [null, 'Entered on the wrong account']);
  // The database refuses edits of a ledger amount, and any change to the audit trail.
  await assert.rejects(h.db.run('UPDATE ledger_entries SET amount = 1 WHERE id = ?', pay.id), /cannot be edited/);
  await assert.rejects(h.db.run("UPDATE audit_log SET action = 'x' WHERE id = ?", voided.id), /cannot be changed/);
  await assert.rejects(h.db.run('DELETE FROM audit_log WHERE id = ?', voided.id), /cannot be changed/);
  assert.equal((await h.db.get('SELECT amount FROM ledger_entries WHERE id = ?', pay.id)).amount, -5000);
});

test('the source is always clear: the AI assistant for a person, an API key, an automation, a patient', async () => {
  const { api, token, patient, provider, practiceId } = await h.practice({ sms_number: '+15125557788', timezone: 'UTC' });
  // The assistant, acting for the signed-in person.
  const res = await fetch(`${h.origin}/api/patients/${patient.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Acting-For': 'assistant' }, body: JSON.stringify({ preferred_name: 'Janie' }) });
  assert.equal(res.status, 200);
  const ai = (await rows(practiceId, "AND entity = 'patients' AND changes LIKE '%Janie%'"))[0];
  assert.equal(ai.source, 'ai');
  assert.match(ai.actor, /^Assistant \(for .+\)$/);
  assert.ok(ai.user_id, 'and who it acted for');

  // An API key.
  const key = (await api.post('/api-keys', { name: 'Website', scopes: ['patients:write', 'patients:read'] })).data.key;
  await fetch(`${h.origin}/api/v1/patients/${patient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ city: 'Boerne' }) });
  const viaApi = (await rows(practiceId, "AND changes LIKE '%Boerne%'"))[0];
  assert.deepEqual([viaApi?.source, viaApi?.actor, viaApi?.user_id], ['api', 'API: Website', null]);

  // A scheduled job.
  await runExclusive('test-job', 1000, () => insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: patient.id, type: 'charge', amount: 1200, entry_date: '2030-01-01', description: 'Membership fee' }));
  const job = (await rows(practiceId, "AND entity = 'ledger_entries' AND changes LIKE '%Membership fee%'"))[0];
  assert.deepEqual([job.source, job.actor, job.action], ['automation', 'Job: test-job', 'ledger.create']);

  // A patient confirming by text.
  const d = new Date(Date.now() + 26 * 3600_000).toISOString();
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${d.slice(0, 10)} 10:00`, end_time: `${d.slice(0, 10)} 11:00`, override_blockout: true, notify: false })).data;
  const params = { From: '+15125550100', To: '+15125557788', Body: 'C', MessageSid: 'SMa' };
  await fetch(`${h.origin}/api/webhooks/twilio/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('tw', 'https://app.example.com/api/webhooks/twilio/sms', params) }, body: new URLSearchParams(params) });
  const confirmed = (await rows(practiceId, "AND entity = 'appointments' AND entity_id = ? AND changes LIKE '%confirmed%'", appt.id))[0];
  assert.deepEqual([confirmed?.source, confirmed?.actor], ['patient', 'Patient (text message)']);
  assert.deepEqual(parse(confirmed).status, ['scheduled', 'confirmed']);

  // The audit log search finds them by source and by patient.
  const found = (await api.get(`/audit-log?source=ai&patient_id=${patient.id}`)).data;
  assert.ok(found.length >= 1 && found.every((x) => x.source === 'ai'));
  assert.equal((await api.get('/audit-log?source=robot')).status, 400);
  const csv = await (await fetch(`${h.origin}/api/audit-log?format=csv&patient_id=${patient.id}`, { headers: { Authorization: `Bearer ${token}` } })).text();
  assert.match(csv.split('\n')[0], /Source,Who,User,Action,Record,Record ID,Patient #,Office,Reason,Before → after/);
});
