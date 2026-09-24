// Workflows 24 (create and send claims) and 27 (update demographics or contact info). Specs in docs/workflows/specs/.
// (Workflow 26, filling openings, runs through the optimizer's routes: test/optimizer.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const auditRows = (practiceId, action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', practiceId, action);
async function login(api, role, name) {
  const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await api.post('/users', { name, email, password: 'correct-horse-battery', role });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const res = await h.client().post('/auth/login', { email, password: 'correct-horse-battery' });
  return h.client(res.data.token);
}
async function household(api) {
  const mom = (await api.post('/patients', { first_name: 'Maya', last_name: 'Mover', dob: '1980-01-01', address: '1 Old Rd', city: 'Austin', state: 'TX', zip: '78701' })).data;
  const kid = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Kit', dob: '2015-01-01', relationship: 'child' })).data;
  const dad = (await api.post('/patients', { first_name: 'Dan', last_name: 'Mover', dob: '1979-01-01', address: '1 OLD RD ', city: 'austin', state: 'tx', zip: '78701' })).data;
  await api.post(`/patients/${mom.id}/family`, { patient_id: dad.id, relationship: 'spouse' });
  // A grown child in the family file who lives elsewhere stays put.
  const away = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Ash', dob: '2000-01-01', relationship: 'child' })).data;
  await api.put(`/patients/${away.id}`, { address: '9 College Ave', city: 'Denton', state: 'TX', zip: '76201' });
  return { mom, kid, dad, away };
}

test('27 · a new address moves the household that lived there, each change recorded with before/after, and undo puts it back', async () => {
  const { api, practiceId } = await h.practice();
  const { mom, kid, dad, away } = await household(api);
  assert.equal(kid.address, '1 Old Rd', 'a new family member starts with the household address');

  const r = await api.put(`/patients/${kid.id}/address`, { address: ' 12  Oak St ', city: 'Round Rock', state: 'tx', zip: '78664' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.before, { address: '1 Old Rd', city: 'Austin', state: 'TX', zip: '78701' });
  assert.equal(r.data.patient.address, '12 Oak St', 'spaces tidied');
  assert.equal(r.data.patient.state, 'TX', 'state upper-cased');
  // Mom (the head) and Dad (same address, typed differently) move; Ash, who lives elsewhere, doesn't.
  assert.deepEqual(r.data.moved.map((m) => m.id).sort(), [mom.id, dad.id].sort());
  for (const id of [mom.id, dad.id]) assert.equal((await api.get(`/patients/${id}`)).data.zip, '78664');
  assert.equal((await api.get(`/patients/${away.id}`)).data.city, 'Denton');

  // Every chart's change is on its own audit row with before and after.
  const rows = await auditRows(practiceId, 'patient.address');
  assert.equal(rows.length, 3);
  const dadRow = rows.find((x) => x.entity_id === dad.id);
  assert.equal(JSON.parse(dadRow.details).household_of, kid.id);
  assert.deepEqual(JSON.parse(dadRow.changes).city, ['austin', 'Round Rock']);

  // Undo: the old address goes back to each chart, this chart only (no household sweep), recorded again.
  for (const [id, before] of [[kid.id, r.data.before], ...r.data.moved.map((m) => [m.id, m.before])]) {
    const u = await api.put(`/patients/${id}/address`, { ...before, household: false });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.deepEqual(u.data.moved, []);
  }
  assert.equal((await api.get(`/patients/${dad.id}`)).data.city, 'austin');
  assert.equal((await api.get(`/patients/${kid.id}`)).data.address, '1 Old Rd');
  assert.equal((await auditRows(practiceId, 'patient.address')).length, 6);

  // household: false, or a list of who moves.
  const solo = await api.put(`/patients/${kid.id}/address`, { address: '5 Elm St', household: false });
  assert.deepEqual(solo.data.moved, []);
  assert.equal(solo.data.patient.city, 'Austin', 'fields not sent are left alone');
  assert.equal((await api.get(`/patients/${mom.id}`)).data.address, '1 Old Rd');
  const some = await api.put(`/patients/${mom.id}/address`, { address: '7 Pine St', city: 'Austin', state: 'TX', zip: '78702', members: [dad.id] });
  assert.deepEqual(some.data.moved.map((m) => m.id), [dad.id]);
  // Sending the same address again changes nothing and records nothing (a double click).
  const n = (await auditRows(practiceId, 'patient.address')).length;
  const again = await api.put(`/patients/${mom.id}/address`, { address: '7 Pine St', city: 'Austin', state: 'TX', zip: '78702' });
  assert.deepEqual(again.data.moved, []);
  assert.equal((await auditRows(practiceId, 'patient.address')).length, n);
});

test('27 · the address is checked on the server; other practices, missing permission and blank addresses are refused', async () => {
  const { api } = await h.practice();
  const { mom } = await household(api);
  for (const bad of [{ zip: '7870' }, { zip: 'ABCDE' }, { state: 'Texas' }, { address: 'x'.repeat(201) }, { city: 'y'.repeat(101) }, {}]) {
    const r = await api.put(`/patients/${mom.id}/address`, bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status}`);
  }
  assert.equal((await api.put(`/patients/${mom.id}/address`, { zip: '78701-1234' })).status, 200, 'ZIP+4 is fine');
  // Another practice's patient: not found.
  const other = await h.practice();
  assert.equal((await other.api.put(`/patients/${mom.id}/address`, { address: '1 Main' })).status, 404);
  // Billing staff can't change charts.
  const billing = await login(api, 'billing', 'Bill Ing');
  assert.equal((await billing.put(`/patients/${mom.id}/address`, { address: '1 Main' })).status, 403);
  // A household with no address on file doesn't sweep everyone with no address along.
  const a = (await api.post('/patients', { first_name: 'No', last_name: 'Where', dob: '1990-01-01' })).data;
  const b = (await api.post(`/patients/${a.id}/family`, { first_name: 'Also', dob: '2012-01-01', relationship: 'child' })).data;
  const r = await api.put(`/patients/${a.id}/address`, { address: '3 New St', city: 'Austin', state: 'TX', zip: '78701' });
  assert.deepEqual(r.data.moved, []);
  assert.equal((await api.get(`/patients/${b.id}`)).data.address, null);
  // Signed out.
  assert.equal((await h.client().put(`/patients/${a.id}/address`, { address: '1 Main' })).status, 401);
});

test('27 · a phone or email change through the chart keeps before/after and resets a bad-number flag', async () => {
  const { api, patient, practiceId } = await h.practice();
  await h.db.run("UPDATE patients SET sms_bad_at = datetime('now'), sms_bad_reason = 'Landline' WHERE id = ?", patient.id);
  const r = await api.put(`/patients/${patient.id}`, { phone: '(512) 555-0199' });
  assert.equal(r.status, 200);
  assert.equal(r.data.sms_bad_at, null, 'a new number gets a fresh start');
  const [row] = (await auditRows(practiceId, 'patient.update')).slice(-1);
  assert.deepEqual(JSON.parse(row.changes).phone, [patient.phone, '(512) 555-0199']);
  assert.equal((await api.put(`/patients/${patient.id}`, { email: 'not-an-email' })).status, 400);
});

test('24 · one action: the claim for the finished work is made and sent; a second press never makes a second claim', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'W3 Dental', payer_id: '99999' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Pat', subscriber_id: 'W3-1', group_number: 'G1' })).data;
  const done = [];
  for (const code of ['D1110', 'D0120']) done.push((await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true })).data);
  const unbilled = (await api.get(`/patients/${patient.id}/unclaimed-procedures?patient_insurance_id=${policy.id}`)).data;
  assert.deepEqual(unbilled.map((p) => p.id).sort(), done.map((p) => p.id).sort());

  const claim = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: unbilled.map((p) => p.id) });
  assert.equal(claim.status, 201, JSON.stringify(claim.data));
  const sent = await api.post('/claims/submit', { claim_ids: [claim.data.id] });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal((await api.get(`/claims/${claim.data.id}`)).data.status, 'submitted');
  // Nothing left to bill, and the same work can't go on a second claim to this payer.
  assert.deepEqual((await api.get(`/patients/${patient.id}/unclaimed-procedures?patient_insurance_id=${policy.id}`)).data, []);
  assert.equal((await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [done[0].id] })).status, 409);
  // Sending it again is refused unless it's a deliberate resend (duplicate-claim denials).
  const twice = await api.post('/claims/submit', { claim_ids: [claim.data.id] });
  assert.equal(twice.status, 409);
  assert.equal(twice.data.details?.already_sent, true);
});

test('24 · a claim that fails the checks stays a draft (listed as ready to send) and says what to fix', async () => {
  const { api, patient, provider } = await h.practice();
  // No payer ID: the claim can be made but not sent electronically.
  const carrier = (await api.post('/carriers', { name: 'Paper Only Dental' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Pat', subscriber_id: 'W3-2' })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
  const sent = await api.post('/claims/submit', { claim_ids: [claim.id] });
  assert.equal(sent.status, 422, JSON.stringify(sent.data));
  assert.ok(sent.data.details?.problems?.length, 'the problems are listed');
  const draft = (await api.get(`/claims?patient_id=${patient.id}&status=draft`)).data;
  assert.deepEqual(draft.map((c) => c.id), [claim.id], 'still there, as a draft, to fix and send');
  // Billing staff can't be bypassed: an assistant can't make or send claims.
  const assistant = await login(api, 'assistant', 'Ann Assist');
  assert.equal((await assistant.post('/claims/submit', { claim_ids: [claim.id] })).status, 403);
});
