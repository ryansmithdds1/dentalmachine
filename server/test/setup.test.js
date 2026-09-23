import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('setup wizard: a new office starts pending; steps check off; fees and common payers in one go; go live', async () => {
  const fresh = h.client();
  const reg = (await fresh.post('/auth/register', { practice_name: 'New Smiles', name: 'Owner', email: `owner-${Date.now()}@example.com`, password: 'correct-horse-battery' })).data;
  const api = h.client(reg.token);
  let s = (await api.get('/setup')).data;
  assert.equal(s.status, 'pending');
  assert.equal(s.steps.practice.done, false);
  assert.ok(s.steps.practice.missing.includes('npi'));
  assert.deepEqual([s.steps.providers.done, s.steps.chairs.done, s.steps.fees.done, s.steps.insurance.done], [false, true, false, false], 'default chairs come with a new practice');

  await api.put('/practice', { address: '1 Main', city: 'Austin', state: 'TX', zip: '78701', phone: '(512) 555-0100', npi: '1234567893', tax_id: '74-1234567', reminder_hours: 24 });
  await api.post('/providers', { name: 'Dr. New', type: 'dentist', npi: '1987654321' });
  const before = (await api.get('/procedure-codes')).data.find((c) => c.code === 'D0150');
  assert.equal((await api.post('/setup/fees', { percent: 500 })).status, 400);
  await api.post('/setup/fees', { percent: 10 });
  const after = (await api.get('/procedure-codes')).data.find((c) => c.code === 'D0150');
  assert.equal(after.fee, Math.round((before.fee * 1.1) / 100) * 100);
  const added = (await api.post('/setup/carriers', { names: ['Delta Dental', 'MetLife', 'Not a payer'] })).data.added;
  assert.deepEqual(added, ['Delta Dental', 'MetLife']);
  assert.deepEqual((await api.post('/setup/carriers', { names: ['Delta Dental'] })).data.added, [], 'no duplicates');
  assert.equal((await api.get('/carriers')).data.find((c) => c.name === 'MetLife').payer_id, '65978');

  s = (await api.get('/setup')).data;
  assert.ok(Object.values(s.steps).every((x) => x.done), JSON.stringify(s.steps));
  await api.post('/setup/complete');
  assert.equal((await api.get('/setup')).data.status, 'done');
  // Practices from before the wizard (created without it) count as set up.
  await h.db.run("INSERT INTO practices (name) VALUES ('Older Practice')");
  assert.equal((await h.db.get("SELECT setup_status FROM practices WHERE name = 'Older Practice'")).setup_status, 'done');
});
