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

test('provider filters: KPIs, hygiene, treatment plans, referrals and reviews narrow to one provider', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const other = (await api.post('/providers', { name: 'Dr. Other', type: 'dentist' })).data;
  const today = new Date().toISOString().slice(0, 10);
  // $235 by the practice's dentist (paid in full), $1350 by the other.
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: other.id, complete: true });
  await api.post(`/patients/${patient.id}/payments`, { amount: 23500, method: 'cash' });
  await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Next', procedures: [{ code: 'D2950', tooth: '3', provider_id: other.id }] });

  const all = (await api.get(`/analytics?from=${today}&to=${today}`)).data;
  const mine = (await api.get(`/analytics?from=${today}&to=${today}&provider_id=${provider.id}`)).data;
  const theirs = (await api.get(`/analytics?from=${today}&to=${today}&provider_id=${other.id}`)).data;
  assert.equal(all.production, 23500 + 135000);
  assert.deepEqual([mine.production, theirs.production], [23500, 135000]);
  // The payment pays off the oldest charge first: the dentist's filling.
  assert.equal(all.collections, 23500);
  assert.equal(mine.collections + theirs.collections, 23500);
  assert.equal(mine.by_provider.length, 1);
  assert.equal(theirs.case_acceptance.presented > 0, true);
  assert.equal(mine.case_acceptance.presented, 0);
  assert.ok(mine.monthly.every((m) => m.production <= 23500));

  const plans = (await api.get(`/reports/treatment-plans?from=${today}&to=${today}&provider_id=${provider.id}`)).data;
  assert.equal(plans.providers.length, 0);
  assert.equal((await api.get(`/reports/treatment-plans?from=${today}&to=${today}&provider_id=${other.id}`)).data.providers.length, 1);

  const hyg = (await api.post('/providers', { name: 'Hyg. Bea', type: 'hygienist' })).data;
  const h1 = (await api.get(`/reports/hygiene?from=${today}&to=${today}&provider_id=${hyg.id}`)).data;
  assert.deepEqual(h1.hygienists.map((x) => x.provider_id), [hyg.id]);

  await h.db.run("UPDATE patients SET referral_source = 'Google' WHERE id = ?", patient.id);
  const ref = (await api.get(`/reports/referrals?from=2000-01-01&to=${today}&provider_id=${other.id}`)).data;
  assert.equal(ref.free_text.find((x) => x.source === 'Google').production, 135000);
  assert.equal((await api.get(`/reports/reviews?from=${today}&to=${today}&provider_id=${other.id}`)).status, 200);
});

test('A/R aging groups families and splits what insurance still owes, in a fixed number of queries', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const kid = (await api.post(`/patients/${patient.id}/family`, { first_name: 'Kid', dob: '2015-01-01' })).data;
  await api.post(`/patients/${kid.id}/procedures`, { code: 'D1120', provider_id: provider.id, complete: true });
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80 })).data;
  await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  let queries = 0;
  const get = h.db.get.bind(h.db); const all = h.db.all.bind(h.db);
  h.db.get = (...a) => { queries++; return get(...a); };
  h.db.all = (...a) => { queries++; return all(...a); };
  const { agingReport } = await import('../src/aging.js');
  const pid = (await get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  let rep;
  try { rep = await agingReport(h.db, pid, new Date().toISOString().slice(0, 10), { family: true }); } finally { h.db.get = get; h.db.all = all; }
  assert.ok(queries <= 3, `${queries} queries`);
  const row = rep.rows.find((r) => r.id === patient.id);
  assert.equal(row.balance, 23500 + 8000);
  assert.equal(row.current, row.balance);
  assert.equal(row.insurance_pending, 18800);
  assert.equal(row.patient_portion, row.balance - 18800);
  assert.equal(row.first_name, 'Jane');
});
