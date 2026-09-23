import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('report builder: columns, filters, grouping, practice isolation and no SQL from the client', async () => {
  const a = await h.practice();
  const b = await h.practice();
  for (const [ctx, codes] of [[a, ['D1110', 'D0120', 'D0120']], [b, ['D1110']]]) {
    for (const code of codes) await ctx.api.post(`/patients/${ctx.patient.id}/procedures`, { code, provider_id: ctx.provider.id, complete: true });
  }
  const meta = (await a.api.get('/query-builder')).data;
  assert.ok(meta.datasets.procedures.columns.fee);

  const run = (spec, ctx = a) => ctx.api.post('/query-builder/run', spec);
  const list = (await run({ dataset: 'procedures', columns: ['code', 'fee', 'patient'], filters: [{ column: 'status', op: 'eq', value: 'completed' }], sort: { column: 'code', dir: 'asc' } })).data;
  assert.deepEqual(list.headers.map((x) => x.label), ['Code', 'Fee', 'Patient']);
  assert.deepEqual(list.rows.map((r) => r[0]), ['D0120', 'D0120', 'D1110'], 'only this practice');

  const grouped = (await run({ dataset: 'procedures', group_by: 'code', aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'fee' }], sort: { column: 'agg0', dir: 'desc' } })).data;
  assert.deepEqual(grouped.rows.map((r) => [r[0], r[1]]), [['D0120', 2], ['D1110', 1]]);
  const fee = grouped.rows[0][2];
  // Money filters are in dollars.
  const over = (await run({ dataset: 'procedures', columns: ['code'], filters: [{ column: 'fee', op: 'gt', value: fee / 2 / 100 - 1 }] })).data;
  assert.ok(over.rows.every((r) => r[0] === 'D0120' || r[0] === 'D1110'));
  assert.equal((await run({ dataset: 'procedures', columns: ['code'], filters: [{ column: 'code', op: 'contains', value: "0120' OR 1=1 --" }] })).data.rows.length, 0, 'values are bound, not pasted');

  // Only known datasets and columns.
  assert.equal((await run({ dataset: 'users', columns: ['password_hash'] })).status, 400);
  assert.equal((await run({ dataset: 'patients', columns: ['id; DROP TABLE patients'] })).status, 400);
  assert.equal((await run({ dataset: 'procedures', group_by: 'code', aggregates: [{ fn: 'sum', column: 'code' }] })).status, 400);

  const saved = (await a.api.post('/query-builder/saved', { name: 'Codes', spec: { dataset: 'procedures', group_by: 'code' } })).data;
  assert.equal((await a.api.get('/query-builder')).data.saved[0].name, 'Codes');
  assert.equal((await b.api.del(`/query-builder/saved/${saved.id}`)).status, 404);
});
