import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('treatment plan: this year vs next — splitting at the annual maximum gets more paid', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 100000, deductible: 0, pct_major: 50 });
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crowns', procedures: [
    { code: 'D2740', tooth: '3', provider_id: provider.id },
    { code: 'D2740', tooth: '14', provider_id: provider.id },
  ] })).data;
  const r = (await api.get(`/treatment-plans/${plan.id}/benefit-years`)).data;
  // Two $1,350 crowns at 50% = $1,350, but the $1,000 maximum caps it this year.
  assert.equal(r.all_now.insurance, 100000);
  assert.equal(r.remaining_now, 100000);
  assert.ok(r.split, 'a split is suggested');
  assert.deepEqual(r.split.this_year.procedures.map((p) => p.tooth), ['3']);
  assert.deepEqual(r.split.next_year.procedures.map((p) => p.tooth), ['14']);
  assert.equal(r.split.insurance, 135000);
  assert.equal(r.split.saves, 35000);
  assert.ok(r.split.next_year.from > new Date().toISOString().slice(0, 10));

  // Under the maximum: nothing to split.
  const small = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Filling', procedures: [{ code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id }] })).data;
  assert.equal((await api.get(`/treatment-plans/${small.id}/benefit-years`)).data.split, null);
});

test('financing: in-house monthly quotes and lender links on the plan, for staff and the patient', async () => {
  const { api, patient, provider } = await h.practice();
  assert.equal((await api.put('/practice', { financing: { in_house_months: [6], links: [{ name: 'CareCredit', url: 'http://insecure' }] } })).status, 400);
  assert.equal((await api.put('/practice', { financing: { in_house_months: [6, 12, 99], in_house_apr: 0, links: [{ name: 'CareCredit', url: 'https://www.carecredit.com/apply/x' }] } })).status, 200);
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crown', procedures: [{ code: 'D2740', tooth: '3', provider_id: provider.id }] })).data;
  const view = (await api.get(`/treatment-plans/${plan.id}`)).data;
  assert.equal(view.financing.amount, 135000, 'no insurance: the whole fee');
  assert.deepEqual(view.financing.in_house.map((o) => [o.months, o.monthly]), [[6, 22500], [12, 11250]], '99 months is dropped');
  assert.equal(view.financing.links[0].name, 'CareCredit');

  // With interest, the monthly amount is amortized.
  await api.put('/practice', { financing: { in_house_months: [12], in_house_apr: 12 } });
  const withApr = (await api.get(`/treatment-plans/${plan.id}`)).data.financing.in_house[0];
  assert.ok(withApr.monthly > 11250 && withApr.monthly < 12100, String(withApr.monthly));

  // The patient sees it when reviewing the plan online.
  const url = (await api.post(`/treatment-plans/${plan.id}/present`, {})).data.url;
  const tok = url.split('/tp/')[1];
  const { pass } = (await h.client().post(`/public/tp/${tok}/verify`, { dob: '1985-04-12' })).data;
  const pub = (await h.client(null, { 'X-Plan-Pass': pass }).get(`/public/tp/${tok}`)).data;
  assert.equal(pub.financing.in_house[0].months, 12);
  assert.equal(pub.practice.financing, undefined);
});
