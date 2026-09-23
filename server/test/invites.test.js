import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { newToken } from '../src/util.js';

const h = harness({ config: { registration: 'invite' } });

test('invite-only sign-up: a practice is created only from an unused, unexpired invitation', async () => {
  assert.equal((await h.client().get('/auth/registration')).data.mode, 'invite');
  const body = { practice_name: 'New Smiles', name: 'Dr New', email: `new-${Date.now()}@example.com`, password: 'correct-horse-battery' };
  assert.equal((await h.client().post('/auth/register', body)).status, 403);
  const make = async (email = null, days = 14) => {
    const { token, hash } = newToken();
    await h.db.run('INSERT INTO signup_invites (token_hash, email, expires_at) VALUES (?, ?, ?)', hash, email, new Date(Date.now() + days * 86400_000).toISOString());
    return token;
  };
  const forOther = await make('someone@else.com');
  assert.equal((await h.client().get(`/auth/invites/${forOther}`)).data.email, 'someone@else.com');
  assert.equal((await h.client().post('/auth/register', { ...body, invite: forOther })).status, 403, 'invitation names another email');
  assert.equal((await h.client().post('/auth/register', { ...body, invite: await make(null, -1) })).status, 403, 'expired');
  const good = await make();
  assert.equal((await h.client().post('/auth/register', { ...body, invite: good })).status, 201);
  assert.equal((await h.client().post('/auth/register', { ...body, email: `again-${Date.now()}@example.com`, invite: good })).status, 403, 'used once');
});
