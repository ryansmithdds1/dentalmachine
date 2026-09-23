import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const login = async (email) => h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);

test('custom roles and per-person overrides decide what someone can do', async () => {
  const { api, provider, patient } = await h.practice();
  const cat = (await api.get('/permissions')).data;
  assert.ok(cat.catalog['reports:own']);
  assert.equal((await api.post('/roles', { name: 'Treatment coordinator', permissions: ['patients:read', 'nope'] })).status, 400);
  const tc = (await api.post('/roles', { name: 'Treatment coordinator', permissions: ['patients:read', 'schedule:read', 'clinical:read', 'billing:read'] })).data;

  const email = `tc${Date.now()}@example.com`;
  const created = await api.post('/users', { name: 'Tia', email, password: 'correct-horse-battery', role: 'front_desk', custom_role_id: tc.id });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  let tia = await login(email);
  let me = (await tia.get('/auth/me')).data;
  assert.deepEqual(me.user.permissions.sort(), ['billing:read', 'clinical:read', 'patients:read', 'schedule:read']);
  assert.equal((await tia.get(`/patients/${patient.id}`)).status, 200);
  assert.equal((await tia.put(`/patients/${patient.id}`, { notes: 'x' })).status, 403); // the base front-desk role could; the custom role can't

  // Just for Tia: may take payments, but not see clinical notes.
  await api.put(`/users/${created.data.id}`, { permissions_add: ['billing:write'], permissions_remove: ['clinical:read'] });
  assert.equal((await tia.get('/auth/me')).status, 401); // her session restarted
  tia = await login(email);
  me = (await tia.get('/auth/me')).data;
  assert.ok(me.user.permissions.includes('billing:write') && !me.user.permissions.includes('clinical:read'));
  assert.equal((await tia.get(`/patients/${patient.id}/procedures`)).status, 403);

  // Editing the role applies to everyone in it.
  await api.put(`/roles/${tc.id}`, { name: 'Treatment coordinator', permissions: ['patients:read', 'patients:write'] });
  tia = await login(email);
  assert.equal((await tia.put(`/patients/${patient.id}`, { notes: 'x' })).status, 200);
  assert.equal((await api.del(`/roles/${tc.id}`)).status, 409);

  // A hygienist allowed to see only their own production.
  const hygEmail = `hy${Date.now()}@example.com`;
  const hyg = (await api.post('/users', { name: 'Hana', email: hygEmail, password: 'correct-horse-battery', role: 'hygienist', permissions_add: ['reports:own'] })).data;
  const hygProv = (await api.post('/providers', { name: 'Hana RDH', type: 'hygienist', user_id: hyg.id })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: hygProv.id, complete: true });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const hana = await login(hygEmail);
  const mine = (await hana.get('/reports/my-production')).data;
  assert.equal(mine.providers[0].id, hygProv.id);
  assert.ok(mine.today > 0);
  const d1110 = (await api.get(`/patients/${patient.id}/procedures`)).data.find((p) => p.code === 'D1110');
  assert.equal(mine.today, d1110.fee);
  assert.equal((await hana.get('/reports/production')).status, 403);
  assert.equal((await hana.get('/roles')).status, 403);
});
