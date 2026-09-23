import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4, createStorage } from '../src/storage.js';
import { toPostgres } from '../src/db.js';

test('S3 request signing matches the AWS Signature V4 reference example', () => {
  const h = signV4({
    method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('S3 storage uploads encrypted files and reads them back', async () => {
  const bucket = new Map();
  const fakeFetch = async (url, { method, headers, body }) => {
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 /);
    if (method === 'PUT') {
      bucket.set(url.pathname, Buffer.from(body));
      return new Response(null, { status: 200 });
    }
    const data = bucket.get(url.pathname);
    return data ? new Response(data) : new Response('missing', { status: 404 });
  };
  const storage = createStorage({ key: 'k', s3: { bucket: 'b', region: 'us-west-2', accessKeyId: 'a', secretAccessKey: 's', prefix: 'documents/' }, fetchImpl: fakeFetch });
  const { storageKey, encrypted } = await storage.save(7, Buffer.from('x-ray bytes'));
  assert.ok(encrypted);
  const [stored] = [...bucket.values()];
  assert.ok(!stored.includes(Buffer.from('x-ray bytes')), 'stored ciphertext only');
  assert.equal((await storage.read(storageKey, true)).toString(), 'x-ray bytes');
  assert.equal(await storage.read('7/00000000-0000-0000-0000-000000000000', true), null);
});

test('SQLite SQL is translated for Postgres', () => {
  assert.equal(toPostgres("SELECT * FROM t WHERE a = ? AND b = '?' AND c LIKE ?"), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c ILIKE $2");
  assert.match(toPostgres("UPDATE t SET x = datetime('now')"), /to_char\(timezone\('UTC', now\(\)\)/);
  assert.equal(toPostgres("GROUP_CONCAT(code, ', ')"), "string_agg(code, ', ')");
});
