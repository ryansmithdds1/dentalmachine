import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { addInterval, membershipYear, runMembershipBilling } from '../src/memberships.js';

const h = harness({ config: { payments: 'sandbox' } });

const PLAN = {
  name: 'Adult Care Club', price: 3500, interval: 'month', discount_pct: 20,
  included: [{ label: 'Cleanings', codes: 'D1110', per_year: 2 }, { label: 'Exams', codes: 'D0120, D0150', per_year: 2 }],
};

async function member(api, patient, card = '4242424242424242') {
  const plan = (await api.post('/membership-plans', PLAN)).data;
  const pm = (await api.post(`/patients/${patient.id}/payment-methods`, { number: card })).data;
  const res = await api.post(`/patients/${patient.id}/memberships`, { plan_id: plan.id, payment_method_id: pm.id });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { plan, pm, membership: res.data };
}

test('dates: monthly billing keeps month ends, membership years run from the start date', () => {
  assert.equal(addInterval('2026-01-31', 'month'), '2026-02-28');
  assert.equal(addInterval('2026-03-15', 'year'), '2027-03-15');
  assert.deepEqual(membershipYear('2025-06-10', '2026-09-01'), { from: '2026-06-10', to: '2027-06-10' });
  assert.deepEqual(membershipYear('2025-06-10', '2026-06-09'), { from: '2025-06-10', to: '2026-06-10' });
});

test('enrolling bills and charges the first month; included services and the discount come off', async () => {
  const { api, patient, provider } = await h.practice();
  assert.equal((await api.post('/membership-plans', { ...PLAN, included: [{ codes: 'X', per_year: 2 }] })).status, 400);
  const { membership } = await member(api, patient);
  assert.equal(membership.status, 'active');
  assert.equal(membership.billing.length, 1);
  assert.equal(membership.billing[0].charged, true);
  assert.equal(membership.next_bill_date, addInterval(membership.start_date, 'month'));
  assert.equal((await api.get(`/patients/${patient.id}`)).data.balance, 0); // billed and paid
  assert.equal((await api.post(`/patients/${patient.id}/memberships`, { plan_id: membership.plan_id })).status, 409);

  // Planned cleaning: the estimate shows it as included.
  const planned = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id })).data;
  const tp = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Recall', procedure_ids: [planned.id] })).data;
  assert.equal(tp.estimate.membership.plan_name, 'Adult Care Club');
  assert.equal(tp.estimate.discount, planned.fee);
  assert.equal(tp.estimate.patient_after_discount, 0);

  const done = async (code) => (await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true, ...(code === 'D2391' ? { tooth: '30', surfaces: 'O' } : {}) })).data;
  await api.post(`/procedures/${planned.id}/complete`);
  await done('D1110');
  const third = await done('D1110');
  const crown = await done('D2391');
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  const entries = ledger.entries || ledger;
  const adj = (procId) => entries.filter((e) => e.procedure_id === procId && e.type === 'adjustment');
  assert.equal(adj(planned.id)[0].amount, -planned.fee);
  assert.match(adj(planned.id)[0].description, /Cleanings included with Adult Care Club/);
  assert.equal(adj(third.id)[0].amount, -Math.round(third.fee * 0.2)); // third cleaning this year: discount only
  assert.equal(adj(crown.id)[0].amount, -Math.round(crown.fee * 0.2));
  const detail = (await api.get(`/patients/${patient.id}/membership`)).data.current;
  assert.deepEqual(detail.usage.map((u) => [u.label, u.used, u.per_year]), [['Cleanings', 2, 2], ['Exams', 0, 2]]);
  assert.ok(detail.savings > 0);
});

test('renewals charge the card; a decline makes it past due until paid', async () => {
  const { api, patient } = await h.practice();
  const { membership } = await member(api, patient);
  // A month later…
  await h.db.run('UPDATE memberships SET next_bill_date = ? WHERE id = ?', '2020-01-01', membership.id);
  const r = await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: membership.id });
  assert.ok(r.length >= 1 && r.every((x) => x.charged));
  assert.equal((await api.get(`/patients/${patient.id}`)).data.balance, 0);

  // The card on file starts declining.
  const bad = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4000000000000002' })).data;
  await api.put(`/memberships/${membership.id}`, { payment_method_id: bad.id });
  await h.db.run('UPDATE memberships SET next_bill_date = ? WHERE id = ?', '2019-06-01', membership.id);
  const declined = await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: membership.id, messenger: h.messenger });
  assert.equal(declined[0].declined, true);
  let m = (await api.get(`/patients/${patient.id}/membership`)).data.current;
  assert.equal(m.status, 'past_due');
  assert.match(m.billing_message, /declined/);
  assert.equal(m.benefits_active, true); // benefits continue while the office sorts it out
  assert.ok((await api.get(`/tasks?patient_id=${patient.id}`)).data.some((t) => /Membership payment declined/.test(t.title)));
  assert.equal((await api.get(`/patients/${patient.id}`)).data.balance, PLAN.price);
  assert.equal((await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: membership.id })).length, 0); // once a day
  // Paid at the desk: the fee stays on the ledger, the membership moves on.
  m = (await api.post(`/memberships/${membership.id}/settle`)).data;
  assert.equal(m.status, 'active');
  assert.equal(m.next_bill_date, '2019-07-01');

  const report = (await api.get('/reports/memberships')).data;
  assert.equal(report.active, 1);
  assert.equal(report.monthly_recurring, PLAN.price);
});

test('cancelling stops billing; benefits last through the paid period', async () => {
  const { api, patient, provider } = await h.practice();
  const { membership } = await member(api, patient);
  const c = await api.post(`/memberships/${membership.id}/cancel`, { reason: 'Got insurance' });
  assert.equal(c.data.status, 'cancelled');
  assert.equal(c.data.benefits_active, true);
  const cleaning = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const entries = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.ok((entries.entries || entries).some((e) => e.procedure_id === cleaning.id && e.type === 'adjustment'));
  await h.db.run('UPDATE memberships SET paid_through = ? WHERE id = ?', '2020-01-01', membership.id);
  assert.equal((await api.get(`/patients/${patient.id}/membership`)).data.current, null);
  const later = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const after = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.ok(!(after.entries || after).some((e) => e.procedure_id === later.id && e.type === 'adjustment'));
  assert.equal((await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: membership.id })).length, 0);
});
