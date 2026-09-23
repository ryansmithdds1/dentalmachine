import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('inventory: stock moves, procedures use supplies, low stock makes a to-do, counts and the reorder list', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  assert.equal((await api.post('/inventory', {})).status, 400);
  const angles = (await api.post('/inventory', { name: 'Prophy angles', unit: 'box', on_hand: 3, reorder_at: 2, reorder_qty: 10, supplier: 'Henry Schein', cost: 2500 })).data;
  assert.equal(angles.on_hand, 3);
  assert.equal(angles.low, false);
  await api.put(`/inventory/${angles.id}`, { used_by: [{ code: 'd1110', qty: 1 }] });
  assert.equal((await api.put(`/inventory/${angles.id}`, { used_by: [{ code: 'X1' }] })).status, 400);

  // A completed cleaning uses one; dropping to the reorder point makes a task once.
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id })).data;
  await api.post(`/procedures/${p.id}/complete`);
  let list = (await api.get('/inventory')).data.items;
  assert.equal(list[0].on_hand, 2);
  assert.equal(list[0].low, true);
  const tasks = (await api.get('/tasks')).data;
  assert.equal((tasks.tasks || tasks).filter((t) => /Reorder Prophy angles/.test(t.title)).length, 1);

  assert.equal((await api.post(`/inventory/${angles.id}/moves`, { reason: 'received', quantity: 10 })).data.on_hand, 12);
  assert.equal((await api.post(`/inventory/${angles.id}/moves`, { reason: 'expired', quantity: 2 })).data.on_hand, 10);
  assert.equal((await api.post(`/inventory/${angles.id}/moves`, { reason: 'bogus', quantity: 2 })).status, 400);
  assert.deepEqual((await api.post('/inventory/count', { counts: { [angles.id]: 1 } })).data, { changed: 1 });
  const moves = (await api.get(`/inventory/${angles.id}/moves`)).data;
  assert.deepEqual(moves.map((m) => [m.reason, m.change]), [['count', -9], ['expired', -2], ['received', 10], ['used', -1], ['adjusted', 3]]);

  const reorder = (await api.get('/inventory/reorder')).data;
  assert.deepEqual(reorder.rows.map((r) => [r.name, r.order_qty]), [['Prophy angles', 10]]);
  assert.equal(reorder.total, 25000);
});
