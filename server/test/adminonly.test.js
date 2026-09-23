import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness({ config: { payments: 'sandbox' } });

test('sign-on and connection settings are for administrators only', async () => {
  const { api } = await h.practice();
  await api.put('/practice/sso', { provider: 'google', client_id: 'cid', client_secret: 'shh', domain: 'example.com' });
  await api.post('/users', { email: `desk-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const users = (await api.get('/users')).data;
  const deskUser = users.find((u) => u.role === 'front_desk');
  const desk = h.client((await h.client().post('/auth/login', { email: deskUser.email, password: 'front-desk-password' })).data.token);

  for (const path of ['/integrations', '/practice/sso', '/api-keys', '/webhooks', '/setup']) {
    assert.equal((await desk.get(path)).status, 403, path);
    assert.equal((await api.get(path)).status, 200, `${path} for the admin`);
  }
  assert.equal((await desk.post('/terminal/readers', { registration_code: 'simulated-wpe' })).status, 403);
  assert.equal((await desk.post('/imaging/agents', { name: 'Op 9' })).status, 403);
  assert.equal((await desk.put('/practice/sso', { provider: 'google' })).status, 403);
  assert.equal((await desk.put('/practice', { sms_number: '+15550000000' })).status, 403);
  // What the front desk sees of the practice: no sign-on details, no message wording.
  for (const p of [(await desk.get('/practice')).data, (await desk.get('/auth/me')).data.practice]) {
    assert.ok(p.name);
    assert.deepEqual(Object.keys(p).filter((k) => k.startsWith('sso_') || ['message_templates', 'stripe_terminal_location'].includes(k)), []);
  }
  assert.ok(Object.keys((await api.get('/practice')).data).includes('sso_provider'), 'the admin still sees them');
});
