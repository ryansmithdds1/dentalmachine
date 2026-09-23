import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runExclusive } from '../src/cluster.js';

const h = harness({ messenger: { status: { sms: 'twilio', email: 'log' }, send: async () => ({}) } });

test('status page: database and storage checks, messaging connections and background jobs — no practice data', async () => {
  await runExclusive('reminders', 1000, async () => 1);
  await runExclusive('backups', 1000, async () => { throw new Error('disk full'); }).catch(() => {});
  const res = await fetch(`${h.origin}/api/public/status`);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.status, 'degraded', 'email not connected and a failed job');
  assert.deepEqual(s.checks.filter((c) => ['Database', 'File storage'].includes(c.name)).map((c) => c.ok), [true, true]);
  assert.equal(s.checks.find((c) => c.name === 'Texting').ok, true);
  assert.equal(s.checks.find((c) => c.name === 'Email').ok, false);
  assert.deepEqual(s.jobs.map((j) => [j.name, j.ok]).sort(), [['Backups', false], ['Reminders, recalls, forms, campaigns and fill offers', true]]);
  assert.doesNotMatch(JSON.stringify(s), /disk full/);
});

test('onboarding checklist: steps check themselves off from what the office has set up', async () => {
  const { api, provider } = await h.practice();
  let o = (await api.get('/onboarding')).data;
  assert.equal(o.total, o.steps.length);
  const step = (k) => o.steps.find((s) => s.key === k);
  assert.equal(step('texting').done, false, 'email is only logged in this test');
  await api.put('/practice', { npi: '1234567893', tax_id: '12-3456789', address: '1 Main St', zip: '78701' });
  await api.put(`/providers/${provider.id}`, { npi: '1234567893' });
  o = (await api.get('/onboarding')).data;
  assert.equal(step('practice').done, true);
  assert.equal(step('providers').done, true);
  assert.equal(o.dismissed, false);
  await api.post('/onboarding/dismiss');
  assert.equal((await api.get('/onboarding')).data.dismissed, true);
});
