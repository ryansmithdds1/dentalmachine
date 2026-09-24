import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('duplicate check finds same name + birthday and same phone, not family members', async () => {
  const { api } = await h.practice();
  const a = (await api.post('/patients', { first_name: 'Ana', last_name: 'Lopez', dob: '1980-02-03', phone: '(512) 555-0199' })).data;
  await api.post('/patients', { first_name: 'Luis', last_name: 'Lopez', dob: '1978-05-05', phone: '512-555-0199' });
  let d = (await api.get('/patients/duplicates?first_name=ana&last_name=LOPEZ&dob=1980-02-03')).data;
  assert.deepEqual(d.map((x) => x.id), [a.id]);
  d = (await api.get('/patients/duplicates?first_name=Ana&last_name=Smith&phone=5125550199')).data;
  assert.deepEqual(d.map((x) => x.id), [a.id]);
  d = (await api.get('/patients/duplicates?first_name=Maria&last_name=Lopez&phone=5125550199&dob=2010-01-01')).data;
  assert.equal(d.length, 0);
  d = (await api.get(`/patients/duplicates?first_name=Ana&last_name=Lopez&dob=1980-02-03&exclude=${a.id}`)).data;
  assert.equal(d.length, 0);
  await api.post('/patients', { first_name: 'Ana', last_name: 'Lopez', dob: '1980-02-03' });
  const groups = (await api.get('/patients/duplicate-groups')).data;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('merge moves history to the kept chart and archives the duplicate (pointing at the kept one)', async () => {
  const { api, patient, provider } = await h.practice();
  const dup = (await api.post('/patients', { first_name: patient.first_name, last_name: patient.last_name, email: 'dup@example.com', allergies: 'Penicillin' })).data;
  await api.post(`/patients/${dup.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  await api.post(`/patients/${dup.id}/notes`, { body: 'From the duplicate' });
  const child = (await api.post('/patients', { first_name: 'Kid', last_name: 'Doe', guarantor_id: dup.id })).data;
  const before = (await api.get(`/patients/${dup.id}/ledger`)).data;

  const res = await api.post(`/patients/${patient.id}/merge`, { from_id: dup.id });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.moved['procedures.patient_id'] >= 1);
  const archived = await h.db.get('SELECT * FROM patients WHERE id = ?', dup.id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.merged_into_id, patient.id);
  const kept = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(kept.allergies, 'Penicillin');
  assert.ok(kept.email);
  assert.equal((await api.get(`/patients/${child.id}`)).data.guarantor_id, patient.id);
  const procs = (await api.get(`/patients/${patient.id}/procedures`)).data;
  assert.ok(procs.some((p) => p.code === 'D0150'));
  const after = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.ok((after.entries || after).length >= (before.entries || before).length);

  assert.equal((await api.post(`/patients/${patient.id}/merge`, { from_id: patient.id })).status, 400);
  const other = await h.practice();
  const theirs = other.patient;
  assert.equal((await api.post(`/patients/${patient.id}/merge`, { from_id: theirs.id })).status, 404);
});

test('custom patient fields: define, validate, save', async () => {
  const { api, patient } = await h.practice();
  const defs = await api.put('/custom-fields', { fields: [
    { label: 'Chart #', type: 'text' },
    { label: 'Shade', type: 'select', options: 'A1, A2, B1' },
    { label: 'Anxiety level', type: 'number' },
    { label: 'Last FMX', type: 'date' },
    { label: 'Nitrous OK', type: 'checkbox' },
  ] });
  assert.equal(defs.status, 200);
  assert.deepEqual(defs.data.map((d) => d.key), ['chart', 'shade', 'anxiety_level', 'last_fmx', 'nitrous_ok']);
  assert.deepEqual(defs.data[1].options, ['A1', 'A2', 'B1']);
  assert.equal((await api.put('/custom-fields', { fields: [{ label: 'Shade', type: 'select' }] })).status, 400);

  let res = await api.put(`/patients/${patient.id}`, { custom: { chart: 'OD-1234', shade: 'A2', anxiety_level: '3', last_fmx: '2025-01-02', nitrous_ok: 1 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(JSON.parse(res.data.custom), { chart: 'OD-1234', shade: 'A2', anxiety_level: 3, last_fmx: '2025-01-02', nitrous_ok: true });
  // Partial updates keep the other values; blank clears one.
  res = await api.put(`/patients/${patient.id}`, { custom: { chart: '' } });
  assert.equal(JSON.parse(res.data.custom).shade, 'A2');
  assert.equal(JSON.parse(res.data.custom).chart, undefined);
  assert.equal((await api.put(`/patients/${patient.id}`, { custom: { shade: 'Z9' } })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { custom: { anxiety_level: 'high' } })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { custom: { last_fmx: 'yesterday' } })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { custom: { unknown: 1 } })).status, 400);
  assert.equal((await api.post('/patients', { first_name: 'C', last_name: 'F', custom: { shade: 'B1' } })).status, 201);
  // Removing a field keeps saved values, and resending them unchanged is fine.
  await api.put('/custom-fields', { fields: [{ label: 'Anxiety level', type: 'number' }] });
  res = await api.put(`/patients/${patient.id}`, { custom: { shade: 'A2', anxiety_level: 4 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await api.put(`/patients/${patient.id}`, { custom: { shade: 'B1' } })).status, 400);
});
