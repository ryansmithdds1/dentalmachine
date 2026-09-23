import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('clinical notes: linked to a visit, searchable, and signed with the signer\'s credentials', async () => {
  const { api, patient, provider } = await h.practice();
  const me = (await api.get('/auth/me')).data;
  // The signing dentist's provider record carries their license and NPI.
  await h.db.run('UPDATE providers SET user_id = ?, license_number = ?, npi = ? WHERE id = ?', me.user?.id ?? me.id, 'TX-12345', '1234567893', provider.id);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2030-05-01 09:00', end_time: '2030-05-01 10:00', override_blockout: true })).data;
  const other = (await api.post('/patients', { first_name: 'O', last_name: 'Other', dob: '1990-01-01' })).data;
  const otherAppt = (await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: '2030-05-02 09:00', end_time: '2030-05-02 10:00', override_blockout: true })).data;

  const a = (await api.post(`/patients/${patient.id}/notes`, { body: 'Crown prep #3, anesthetic 2 carpules lidocaine', provider_id: provider.id })).data;
  const b = (await api.post(`/patients/${patient.id}/notes`, { body: 'Post-op call: no pain', provider_id: provider.id })).data;
  assert.equal((await api.put(`/notes/${a.id}`, { appointment_id: otherAppt.id })).status, 400, "another patient's visit");
  assert.equal((await api.put(`/notes/${a.id}`, { appointment_id: appt.id })).status, 200);
  await api.post(`/notes/${a.id}/sign`);

  const all = (await api.get(`/patients/${patient.id}/notes`)).data;
  const signed = all.find((n) => n.id === a.id);
  assert.equal(signed.visit_start, '2030-05-01 09:00');
  assert.match(signed.signature, /Electronically signed by .* · License TX-12345 · NPI 1234567893/);
  assert.equal(all.find((n) => n.id === b.id).signature, null);

  assert.deepEqual((await api.get(`/patients/${patient.id}/notes?q=lidocaine crown`)).data.map((n) => n.id), [a.id]);
  assert.deepEqual((await api.get(`/patients/${patient.id}/notes?unsigned=1`)).data.map((n) => n.id), [b.id]);
  assert.deepEqual((await api.get(`/patients/${patient.id}/notes?appointment_id=${appt.id}`)).data.map((n) => n.id), [a.id]);
  // Addenda are searched too.
  await api.post(`/notes/${a.id}/addenda`, { body: 'Temporary recemented' });
  assert.deepEqual((await api.get(`/patients/${patient.id}/notes?q=recemented`)).data.map((n) => n.id), [a.id]);
});
