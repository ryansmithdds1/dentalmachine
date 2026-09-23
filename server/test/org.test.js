import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('practice groups: create, join with a one-time code, numbers side by side, copy setup across, leave', async () => {
  const north = await h.practice();
  const south = await h.practice();
  const outsider = await h.practice();
  assert.equal((await north.api.get('/org')).data.org, null);
  const org = await north.api.post('/org', { name: 'Bright Smiles Group' });
  assert.equal(org.status, 201);
  assert.equal((await north.api.post('/org', { name: 'Again' })).status, 409);

  // South's administrator joins with the owner's code; the code works once.
  const { code } = (await north.api.post('/org/join-code')).data;
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.equal((await south.api.post('/org/join', { code: 'WRONG123' })).status, 400);
  assert.equal((await south.api.post('/org/join', { code })).status, 200);
  assert.equal((await outsider.api.post('/org/join', { code })).status, 400, 'used up');
  // South's people aren't owners of the group until added, and can't see the rollup.
  const southView = (await south.api.get('/org')).data;
  assert.deepEqual([southView.org.name, southView.role, southView.practice_in_group, southView.practices.length], ['Bright Smiles Group', null, true, 0]);
  assert.equal((await south.api.get('/org/rollup')).status, 403);

  // Work at each office, then the rollup.
  await north.api.post(`/patients/${north.patient.id}/procedures`, { code: 'D1110', provider_id: north.provider.id, complete: true });
  await south.api.post(`/patients/${south.patient.id}/procedures`, { code: 'D2740', provider_id: south.provider.id, tooth: '3', complete: true });
  const roll = (await north.api.get('/org/rollup')).data;
  assert.equal(roll.practices.length, 2);
  const byId = Object.fromEntries(roll.practices.map((p) => [p.practice_id, p]));
  assert.ok(byId[north.practiceId].production > 0 && byId[south.practiceId].production > byId[north.practiceId].production);
  assert.equal(roll.totals.production, byId[north.practiceId].production + byId[south.practiceId].production);
  assert.equal(roll.totals.ar_total, byId[north.practiceId].ar_total + byId[south.practiceId].ar_total);

  // Copy North's templates, appointment types, messaging and fees to South.
  await north.api.post('/note-templates', { name: 'Crown prep', body: 'Tooth #: \nShade: ' });
  const northCrown = await h.db.get("SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = 'D2740'", north.practiceId);
  await h.db.run("UPDATE procedure_codes SET fee = ? WHERE practice_id = ? AND code = 'D2740'", northCrown.fee + 5000, north.practiceId);
  await north.api.put('/practice', { send_from: '09:00', send_until: '19:00' });
  assert.equal((await north.api.post('/org/push', { kinds: ['nope'] })).status, 400);
  assert.equal((await north.api.post('/org/push', { kinds: ['fees'], to_practice_ids: [outsider.practiceId] })).status, 400);
  const pushed = await north.api.post('/org/push', { kinds: ['note_templates', 'messaging', 'fees', 'appointment_types'] });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.deepEqual(pushed.data.results.map((r) => r.practice_id), [south.practiceId]);
  assert.ok((await h.db.get("SELECT id FROM note_templates WHERE practice_id = ? AND name = 'Crown prep'", south.practiceId)));
  assert.equal((await h.db.get("SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = 'D2740'", south.practiceId)).fee, northCrown.fee + 5000);
  assert.ok(await h.db.get("SELECT id FROM fee_history WHERE practice_id = ? AND code = 'D2740'", south.practiceId));
  assert.equal((await h.db.get('SELECT send_from FROM practices WHERE id = ?', south.practiceId)).send_from, '09:00');
  // Pushing again updates rather than duplicates.
  await north.api.post('/org/push', { kinds: ['note_templates'] });
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM note_templates WHERE practice_id = ? AND name = 'Crown prep'", south.practiceId)).n, 1);

  // Owners add a viewer from a member practice; nobody outside the group.
  assert.equal((await north.api.post('/org/members', { email: outsider.email, role: 'viewer' })).status, 404);
  assert.equal((await north.api.post('/org/members', { email: south.email, role: 'viewer' })).status, 200);
  assert.equal((await south.api.get('/org/rollup')).status, 200);
  assert.equal((await south.api.post('/org/push', { kinds: ['fees'] })).status, 403, 'viewers can’t push');

  // South's administrator takes the practice out; it drops from the rollup.
  assert.equal((await south.api.post('/org/leave')).status, 200);
  assert.equal((await north.api.get('/org/rollup')).data.practices.length, 1);
  assert.equal((await south.api.get('/org')).data.org, null);
});
