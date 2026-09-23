import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('deposit slips: undeposited checks and cash go on a deposit, which reconciles with the bank', async () => {
  const { api, patient } = await h.practice();
  const pay = (amount, method) => api.post(`/patients/${patient.id}/payments`, { amount, method, reference: method === 'check' ? '1042' : undefined });
  await pay(5000, 'cash');
  await pay(12000, 'check');
  await pay(3000, 'credit_card');
  let waiting = (await api.get('/deposits/undeposited')).data;
  assert.deepEqual(waiting.map((e) => [e.method, e.amount]), [['cash', 5000], ['check', 12000]], 'cards settle separately');
  assert.equal((await api.get('/deposits/undeposited?methods=credit_card')).data.length, 1);

  const dep = await api.post('/deposits', { entry_ids: waiting.map((e) => e.id), reference: 'Slip 7' });
  assert.equal(dep.status, 201);
  assert.equal(dep.data.total, 17000);
  assert.equal((await api.get('/deposits/undeposited')).data.length, 0);
  assert.equal((await api.post('/deposits', { entry_ids: [waiting[0].id] })).status, 409, 'already deposited');
  const slip = (await api.get(`/deposits/${dep.data.id}`)).data;
  assert.deepEqual(slip.by_method, { cash: 5000, check: 12000 });

  // The bank shows $169.00: flagged; then the right figure reconciles it.
  assert.equal((await api.post(`/deposits/${dep.data.id}/reconcile`, { bank_amount: 16900 })).data.status, 'discrepancy');
  assert.equal((await api.post(`/deposits/${dep.data.id}/reconcile`, { bank_amount: 17000, bank_date: '2031-01-03' })).data.status, 'reconciled');
  assert.equal((await api.del(`/deposits/${dep.data.id}`)).status, 409);

  // An unreconciled deposit can be undone.
  await pay(2500, 'check');
  waiting = (await api.get('/deposits/undeposited')).data;
  const d2 = (await api.post('/deposits', { entry_ids: waiting.map((e) => e.id) })).data;
  await api.del(`/deposits/${d2.id}`);
  assert.equal((await api.get('/deposits/undeposited')).data.length, 1);
  assert.equal((await api.get('/deposits')).data.length, 1);
});
