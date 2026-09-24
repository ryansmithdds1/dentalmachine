import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runMigrations, rollbackLast } from '../src/migrations.js';

const h = harness();
const rows = (d) => (Array.isArray(d) ? d : d.rows);

test('work is stamped with the office it happened in, and office views show that office', async () => {
  const { api, token, patient, provider } = await h.practice();
  const north = (await api.post('/locations', { name: 'North' })).data;
  const south = (await api.post('/locations', { name: 'South' })).data;
  const atNorth = h.client(token, { 'X-Location-Id': String(north.id) });
  const atSouth = h.client(token, { 'X-Location-Id': String(south.id) });

  // A procedure charted and completed while working at North belongs to North, and so does its claim.
  const p = (await atNorth.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
  const proc = await h.db.get('SELECT location_id FROM procedures WHERE id = ?', p.id);
  assert.equal(proc.location_id, north.id);
  const charge = await h.db.get("SELECT location_id FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", p.id);
  assert.equal(charge.location_id, north.id);
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '1' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X' })).data;
  const claim = (await atSouth.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] })).data;
  assert.equal((await h.db.get('SELECT location_id FROM claims WHERE id = ?', claim.id)).location_id, north.id, 'the claim follows where the work was done');

  // Office views.
  assert.ok(rows((await atNorth.get('/claims')).data).some((c) => c.id === claim.id));
  assert.ok(!rows((await atSouth.get('/claims')).data).some((c) => c.id === claim.id));
  assert.ok(rows((await api.get('/claims')).data).some((c) => c.id === claim.id), 'all offices');
});

test('data migrations run once, in order, and are recorded; a step without an undo refuses to roll back', async () => {
  const seen = [];
  const list = [
    { id: 902, name: 'second', up: async () => { seen.push(902); }, down: null },
    { id: 901, name: 'first', up: async () => { seen.push(901); }, down: async () => { seen.push(-901); } },
  ];
  await runMigrations(h.db, list);
  await runMigrations(h.db, list);
  assert.deepEqual(seen, [901, 902]);
  assert.equal((await h.db.all('SELECT id FROM schema_migrations WHERE id IN (901, 902)')).length, 2);
  await assert.rejects(rollbackLast(h.db, list), /no undo/);
  await h.db.run('DELETE FROM schema_migrations WHERE id IN (901, 902)');
});
