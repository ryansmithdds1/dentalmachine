import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness({ config: { payments: 'sandbox' } });

test('family relationships and a second responsible party (shown on statements)', async () => {
  const { api, patient: mom } = await h.practice();
  const kid = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Kid', dob: '2016-01-01', relationship: 'child' })).data;
  assert.equal(kid.family_relationship, 'child');
  assert.equal((await api.post(`/patients/${mom.id}/family`, { first_name: 'X', relationship: 'cousin' })).status, 400);
  const dad = (await api.post('/patients', { first_name: 'Dan', last_name: 'Doe', dob: '1980-03-03' })).data;
  await api.post(`/patients/${mom.id}/family`, { patient_id: dad.id, relationship: 'spouse' });
  assert.equal((await api.put(`/patients/${mom.id}/family/${dad.id}`, { relationship: 'other' })).status, 200);

  const exDad = (await api.post('/patients', { first_name: 'Eric', last_name: 'Ex', dob: '1979-01-01' })).data;
  assert.equal((await api.put(`/patients/${kid.id}/family-responsible`, { patient_id: mom.id })).status, 400, 'not the head themselves');
  assert.equal((await api.put(`/patients/${kid.id}/family-responsible`, { patient_id: exDad.id })).status, 200);
  const fam = (await api.get(`/patients/${kid.id}/family`)).data;
  assert.equal(fam.second_responsible.first_name, 'Eric');
  assert.deepEqual(fam.members.map((m) => m.family_relationship).sort(), [null, 'child', 'other'].sort());
  const st = (await api.get(`/patients/${kid.id}/statement?family=1`)).data;
  assert.equal(st.also_responsible.first_name, 'Eric');
});

test('unlinking a member: warns about the household plan and moves card billing to their own account', async () => {
  const { api, patient: mom, provider } = await h.practice();
  const teen = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Teen', dob: '2008-01-01', relationship: 'child' })).data;
  await api.post(`/patients/${teen.id}/procedures`, { code: 'D1120', provider_id: provider.id, complete: true });
  await api.post(`/patients/${mom.id}/payment-plans`, { total: 8000, installments: 2, start_date: '2030-01-01' });
  const card = (await api.post(`/patients/${mom.id}/payment-methods`, { number: '4242424242424242' })).data;
  const plan = (await api.post('/membership-plans', { name: 'Kids club', price: 2000, interval: 'month', discount_pct: 10, included: [] })).data;
  const mem = await api.post(`/patients/${teen.id}/memberships`, { plan_id: plan.id, payment_method_id: card.id });
  assert.equal(mem.status, 201, JSON.stringify(mem.data));

  const impact = (await api.get(`/patients/${mom.id}/family/${teen.id}/unlink`)).data;
  assert.ok(impact.balance > 0);
  assert.equal(impact.plans.length, 1);
  assert.deepEqual(impact.card_charges.map((c) => c.kind), ['membership']);
  const blocked = await api.del(`/patients/${mom.id}/family/${teen.id}`);
  assert.equal(blocked.status, 409);
  const done = await api.del(`/patients/${mom.id}/family/${teen.id}?confirm=1`);
  assert.equal(done.status, 200);
  assert.equal(done.data.moved.length, 1);
  const after = (await api.get(`/patients/${teen.id}`)).data;
  assert.equal(after.guarantor_id, null);
  assert.equal((await h.db.get('SELECT payment_method_id FROM memberships WHERE id = ?', mem.data.id)).payment_method_id, null, "no longer charged to mom's card");

  // Nothing to warn about: unlinks straight away.
  const baby = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Baby', relationship: 'child' })).data;
  assert.equal((await api.del(`/patients/${mom.id}/family/${baby.id}`)).status, 200);
});
