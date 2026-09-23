import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const login = (email, password) => h.client().post('/auth/login', { email, password });

test('password changes, 2FA resets and "sign out everywhere" end other sessions', async () => {
  const { api, email } = await h.practice();
  const other = h.client((await login(email, 'correct-horse-battery')).data.token);
  assert.equal((await other.get('/patients')).status, 200);
  const changed = await api.post('/auth/change-password', { current_password: 'correct-horse-battery', new_password: 'a-brand-new-password' });
  assert.equal(changed.status, 200);
  assert.equal((await other.get('/patients')).status, 401, 'the other device is signed out');
  assert.equal((await api.get('/patients')).status, 401, 'the old token too');
  const fresh = h.client(changed.data.token);
  assert.equal((await fresh.get('/patients')).status, 200, 'this device keeps a new session');

  const out = await fresh.post('/auth/logout-all');
  assert.equal((await fresh.get('/patients')).status, 401);
  const me = h.client(out.data.token);
  assert.equal((await me.get('/patients')).status, 200);

  // An admin resetting a colleague's 2FA (lost phone) ends that colleague's sessions.
  const desk = (await me.post('/users', { email: `desk-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'front-desk-password' })).data;
  const deskApi = h.client((await login(desk.email, 'front-desk-password')).data.token);
  assert.equal((await deskApi.get('/patients')).status, 200);
  await me.put(`/users/${desk.id}`, { reset_mfa: true });
  assert.equal((await deskApi.get('/patients')).status, 401);
});

test('accounts lock after repeated failed sign-ins; a password reset link unlocks them', async () => {
  const { api } = await h.practice();
  const email = `lock-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Lockable', role: 'billing', password: 'billing-password-1' });
  for (let i = 0; i < 10; i++) assert.equal((await login(email, 'wrong-password')).status, 401);
  const locked = await login(email, 'billing-password-1');
  assert.equal(locked.status, 429, 'even the right password waits');
  assert.match(locked.data.error, /reset your password/);

  // Forgot password: the same answer for unknown emails; a one-time link for real ones.
  assert.deepEqual((await h.client().post('/auth/forgot-password', { email: 'nobody@example.com' })).data, { ok: true });
  const before = h.sent.length;
  await h.client().post('/auth/forgot-password', { email: email.toUpperCase() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.sent.length, before + 1);
  const token = h.sent.at(-1).body.match(/#reset=([\w-]+)/)[1];
  assert.equal((await h.client().post('/auth/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await h.client().post('/auth/reset-password', { token, password: 'my-new-billing-password' })).status, 200);
  assert.equal((await h.client().post('/auth/reset-password', { token, password: 'my-new-billing-password' })).status, 400, 'single use');
  assert.equal((await login(email, 'my-new-billing-password')).status, 200);
});

test('non-admins see only what they need of users and practice settings; family edits stay in the family', async () => {
  const { api, patient } = await h.practice();
  await api.put('/practice/sso', { provider: 'google', client_id: 'x.apps.googleusercontent.com', client_secret: 'secret' });
  const email = `hyg-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Hy Gienist', role: 'hygienist', password: 'hygienist-password' });
  const hyg = h.client((await login(email, 'hygienist-password')).data.token);
  const practice = (await hyg.get('/practice')).data;
  assert.ok(practice.name);
  assert.ok(!Object.keys(practice).some((k) => k.startsWith('sso_')));
  assert.equal((await hyg.get('/auth/me')).data.practice.sso_client_id, undefined);
  const users = (await hyg.get('/users')).data;
  assert.ok(users.length >= 2);
  assert.equal(users[0].email, undefined);
  assert.ok((await api.get('/users')).data[0].email, 'admins still see emails');

  // Unlinking someone from a family they aren't in is refused.
  const stranger = (await api.post('/patients', { first_name: 'Not', last_name: 'Family' })).data;
  const kid = (await api.post('/patients', { first_name: 'Kid', last_name: 'Doe' })).data;
  await api.post(`/patients/${patient.id}/family`, { patient_id: kid.id });
  assert.equal((await api.del(`/patients/${stranger.id}/family/${kid.id}`)).status, 400);
  assert.equal((await api.del(`/patients/${patient.id}/family/${kid.id}`)).status, 200);
});

test('the app page is served with a content security policy that matches vercel.json', async () => {
  const { CSP } = await import('../src/app.js');
  const { readFileSync } = await import('node:fs');
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const header = vercel.headers[0].headers.find((x) => x.key === 'Content-Security-Policy');
  assert.equal(header.value, CSP);
  // Our own scripts only, plus Plaid's bank-connection script: nothing inline.
  assert.match(CSP, /script-src 'self' https:\/\/cdn\.plaid\.com\/link\/v2\/stable\/link-initialize\.js;/);
  assert.doesNotMatch(CSP, /script-src [^;]*unsafe/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('names are saved as one line of plain text', async () => {
  const { api } = await h.practice();
  const p = (await api.post('/patients', { first_name: 'Jane\r\nNM1*IL*1*EVIL', last_name: 'Doe\u0000' })).data;
  assert.equal(p.first_name, 'Jane NM1*IL*1*EVIL');
  assert.equal(p.last_name, 'Doe');
  const upd = (await api.put(`/patients/${p.id}`, { last_name: 'Smith\n' })).data;
  assert.equal(upd.last_name, 'Smith');
});
