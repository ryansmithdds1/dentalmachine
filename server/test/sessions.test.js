import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('signing out ends the session on the server, not just in the browser', async () => {
  const p = await h.practice();
  const login = await h.client().post('/auth/login', { email: p.email, password: 'correct-horse-battery' });
  const second = h.client(login.data.token);
  assert.equal((await second.get('/auth/me')).status, 200);
  assert.equal((await second.get('/auth/me')).status, 200);
  const rows = await h.db.get('SELECT COUNT(*) AS n FROM staff_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)', p.email);
  assert.equal(Number(rows.n), 2, 'one row per sign-in, not per page load');
  assert.equal((await second.post('/auth/logout')).status, 200);
  assert.equal((await second.get('/auth/me')).status, 401, 'a copied token is dead after sign-out');
  assert.equal((await p.api.get('/auth/me')).status, 200, 'other sign-ins carry on');
  const log = await h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.logout'");
  assert.equal(Number(log.n), 1);
});

test("the server refuses a session idle past the practice's timeout", async () => {
  const p = await h.practice();
  await p.api.put('/practice', { idle_timeout_minutes: 5 });
  assert.equal((await p.api.post('/auth/ping')).status, 200);
  // Six minutes of quiet: within the two-minute grace.
  await h.db.run('UPDATE staff_sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)', new Date(Date.now() - 6 * 60_000).toISOString(), p.email);
  assert.equal((await p.api.get('/auth/me')).status, 200);
  // Eight minutes: past it.
  await h.db.run('UPDATE staff_sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)', new Date(Date.now() - 8 * 60_000).toISOString(), p.email);
  const res = await p.api.get(`/patients/${p.patient.id}`);
  assert.equal(res.status, 401);
  assert.equal((await p.api.get('/auth/me')).status, 401, 'stays ended once activity resumes');
  const row = await h.db.get('SELECT end_reason FROM staff_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)', p.email);
  assert.equal(row.end_reason, 'idle');
});
