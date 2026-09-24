import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('the server refuses impossible money, dates and cross-patient links, whatever the screen sent', async () => {
  const { api, patient, provider } = await h.practice();
  const other = (await api.post('/patients', { first_name: 'Other', last_name: 'Person' })).data;

  // Money: a typo of extra zeros, and fees below zero.
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 5_000_000_000, method: 'cash' })).status, 400);
  const codes = (await api.get('/procedure-codes')).data;
  assert.equal((await api.put(`/procedure-codes/${codes[0].id}`, { fee: -500 })).status, 400);

  // Dates that have the right shape but don't exist.
  const bad = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-02-31 09:00', end_time: '2031-02-31 10:00' });
  assert.equal(bad.status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { dob: '2999-01-01' })).status, 400, 'no birthdays in the future');
  assert.equal((await api.put(`/patients/${patient.id}`, { dob: '1990-13-01' })).status, 400);

  // Links between records must stay with the same patient.
  const visit = (await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: '2031-03-03 09:00', end_time: '2031-03-03 10:00', override_blockout: true })).data;
  assert.equal((await api.post('/lab-cases', { patient_id: patient.id, appointment_id: visit.id, lab_name: 'Lab', description: 'Crown' })).status, 400);

  // A transfer moves only what the account has.
  assert.equal((await api.post(`/patients/${patient.id}/transfer`, { to_patient_id: other.id, amount: 100 })).status, 400);

  // Prescriptions: a real quantity and whole refills.
  const rx = (body) => api.post(`/patients/${patient.id}/prescriptions`, { provider_id: provider.id, drug: 'Amoxicillin', strength: '500 mg', sig: 'One capsule three times a day', quantity: '21', ...body });
  assert.equal((await rx({ quantity: '-5' })).status, 400);
  assert.equal((await rx({ refills: 2.5 })).status, 400);

  // A denial needs its reason.
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '1', timely_filing_days: 'abc' })).data;
  assert.equal(carrier.timely_filing_days, null);
  assert.equal((await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X', pct_basic: 'abc' })).status, 400);
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X' })).data;
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] })).data;
  await api.post(`/claims/${claim.id}/submit`);
  assert.equal((await api.post(`/claims/${claim.id}/deny`, {})).status, 400);
  assert.equal((await api.post(`/claims/${claim.id}/deny`, { reason: 'Frequency' })).status, 200);
});
