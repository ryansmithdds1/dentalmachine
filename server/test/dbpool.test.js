// Database connection limits (live incident, 25 Sep 2026): warm serverless copies each held ten Postgres
// connections and ran the pooler out of its 200 slots, so sign-in and every screen answered 500/503 for half a
// minute. Serverless copies now keep a small pool that lets idle connections go, and a "database is full"
// refusal — which happens before any statement runs — is retried briefly instead of failing the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolOptions, isConnectionLimit, retryOnConnectionLimit } from '../src/db.js';

test('serverless copies keep a small pool and release idle connections quickly', () => {
  assert.deepEqual(poolOptions({ VERCEL: '1' }), { max: 3, idleTimeoutMillis: 5000 });
  assert.deepEqual(poolOptions({ SERVERLESS: '1' }), { max: 3, idleTimeoutMillis: 5000 });
  assert.deepEqual(poolOptions({}), { max: 10, idleTimeoutMillis: 10000 });
  assert.equal(poolOptions({ VERCEL: '1', PG_POOL_SIZE: '8' }).max, 8);
});

test('connection-limit refusals are recognised; other errors are not', () => {
  assert.ok(isConnectionLimit(Object.assign(new Error('(EMAXCONN) max client connections reached, limit: 200'), { code: 'XX000' })));
  assert.ok(isConnectionLimit(Object.assign(new Error('sorry, too many clients already'), { code: '53300' })));
  assert.ok(!isConnectionLimit(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })));
  assert.ok(!isConnectionLimit(new Error('relation "x" does not exist')));
  assert.ok(!isConnectionLimit(undefined));
});

const full = () => Object.assign(new Error('(EMAXCONN) max client connections reached, limit: 200'), { code: 'XX000' });

test('a full database is retried and the request then succeeds', async () => {
  let calls = 0;
  const out = await retryOnConnectionLimit(async () => { calls += 1; if (calls < 3) throw full(); return 'rows'; }, [1, 1, 1]);
  assert.equal(out, 'rows');
  assert.equal(calls, 3);
});

test('it gives up after the last wait and throws the refusal', async () => {
  let calls = 0;
  await assert.rejects(retryOnConnectionLimit(async () => { calls += 1; throw full(); }, [1, 1]), /EMAXCONN/);
  assert.equal(calls, 3);
});

test('any other error is thrown at once, never retried (a statement that ran is never run twice)', async () => {
  let calls = 0;
  const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
  await assert.rejects(retryOnConnectionLimit(async () => { calls += 1; throw dup; }, [1, 1, 1]), /duplicate key/);
  assert.equal(calls, 1);
});
