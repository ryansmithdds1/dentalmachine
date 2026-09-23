import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('hygiene report: production, reappointment, perio vs prophy, recall follow-through', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const hyg = (await api.post('/providers', { name: 'Hyg. Anne', type: 'hygienist' })).data;
  const today = new Date().toISOString().slice(0, 10);
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, start_time: `${today} 08:00`, end_time: `${today} 09:00` })).data;
  // Booked their next cleaning before leaving.
  const next = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, start_time: `${next} 08:00`, end_time: `${next} 09:00`, override_hours: true, override_blockout: true });
  for (const code of ['D1110', 'D4910']) {
    const pr = (await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: hyg.id, appointment_id: visit.id, ...(code === 'D4910' ? {} : {}) })).data;
    assert.equal((await api.post(`/procedures/${pr.id}/complete`)).status, 200);
  }
  await api.put(`/appointments/${visit.id}`, { status: 'completed' });
  // Completing the cleaning set up a recall; pretend it came due today.
  await h.db.run("UPDATE recalls SET due_date = ?, status = 'due' WHERE patient_id = ?", today, patient.id);

  const r = (await api.get(`/reports/hygiene?from=${today}&to=${today}`)).data;
  const row = r.hygienists.find((x) => x.provider_id === hyg.id);
  assert.equal(row.visits, 1);
  assert.equal(row.reappointed, 1);
  assert.equal(row.reappointment_rate, 100);
  assert.ok(row.production > 0);
  assert.deepEqual([r.perio.perio, r.perio.prophy, r.perio.perio_pct], [1, 1, 50]);
  assert.deepEqual([r.recall.due, r.recall.seen, r.recall.booked], [1, 1, 1]);
});

test('treatment plan report: presented, accepted, scheduled, completed by provider', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, {
    name: 'Phase 1', procedures: [
      { code: 'D1110', provider_id: provider.id },
      { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id },
      { code: 'D2740', tooth: '3', provider_id: provider.id },
    ],
  })).data;
  const [a, b, c] = plan.procedures;
  const other = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Maybe later', procedures: [{ code: 'D2750', tooth: '14', provider_id: provider.id }] })).data;
  await api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' });
  await api.post(`/procedures/${a.id}/complete`);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-02-03 09:00', end_time: '2031-02-03 10:00' })).data;
  await api.put(`/procedures/${b.id}`, { appointment_id: appt.id });
  const today = new Date().toISOString().slice(0, 10);
  const r = (await api.get(`/reports/treatment-plans?from=${today}&to=${today}`)).data;
  const row = r.providers.find((x) => x.provider_id === provider.id);
  const fee = (p) => p.fee;
  assert.equal(row.plans, 2);
  assert.equal(row.presented, fee(a) + fee(b) + fee(c) + other.procedures[0].fee);
  assert.equal(row.accepted, fee(a) + fee(b) + fee(c));
  assert.equal(row.completed, fee(a));
  assert.equal(row.scheduled, fee(b));
  assert.equal(row.unscheduled, fee(c));
  assert.equal(r.total.presented, row.presented);
});
