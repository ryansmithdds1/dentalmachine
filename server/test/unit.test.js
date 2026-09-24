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

test('allergy screening catches drug classes, not just exact names', async () => {
  const { allergyWarning } = await import('../src/drugs.js');
  assert.match(allergyWarning('Codeine', 'Hydrocodone/acetaminophen 5/325'), /opioid/);
  assert.match(allergyWarning('Penicillin', 'Amoxicillin 500 mg'), /penicillin/);
  assert.match(allergyWarning('penicillin (hives)', 'Cephalexin 500 mg'), /cross-react/);
  assert.match(allergyWarning('Aspirin', 'Ibuprofen 600 mg'), /NSAID/);
  assert.match(allergyWarning('Latex, Clindamycin', 'Clindamycin 300 mg'), /allergic to clindamycin/);
  assert.equal(allergyWarning('Sulfa', 'Ibuprofen 600 mg'), null);
  assert.equal(allergyWarning('NKDA', 'Amoxicillin'), null);
  assert.equal(allergyWarning(null, 'Amoxicillin'), null);
});

test('queries outside a transaction neither see nor join its uncommitted work', async () => {
  const { openDb } = await import('../src/db.js');
  const db = await openDb(':memory:');
  try {
    const pid = (await db.run("INSERT INTO practices (name) VALUES ('Iso')")).id;
    let resolveInside;
    const inside = new Promise((r) => { resolveInside = r; });
    const tx = db.tx(async () => {
      await db.run("UPDATE practices SET name = 'Uncommitted' WHERE id = ?", pid);
      resolveInside();
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('roll back');
    }).catch(() => 'rolled back');
    await inside;
    // Runs after the transaction, so it sees the committed name and its own write survives the rollback.
    const seen = (await db.get('SELECT name FROM practices WHERE id = ?', pid)).name;
    await db.run("UPDATE practices SET phone = '555' WHERE id = ?", pid);
    assert.equal(await tx, 'rolled back');
    assert.equal(seen, 'Iso');
    assert.equal((await db.get('SELECT phone FROM practices WHERE id = ?', pid)).phone, '555');
  } finally {
    await db.close();
  }
});

test('medical history merges keep what staff recorded', async () => {
  const { mergeList } = await import('../src/forms.js');
  assert.equal(mergeList('Latex', 'None'), 'Latex', 'a rushed "none" never erases an allergy');
  assert.equal(mergeList('Penicillin; latex', 'penicillin, Codeine'), 'Penicillin, latex, Codeine');
  assert.equal(mergeList(null, 'NKDA'), 'None');
  assert.equal(mergeList(null, null), null);
});

test('Postgres translation survives an unmatched quote', () => {
  assert.equal(toPostgres("-- the provider's hours\nSELECT ? AS x"), "-- the provider's hours\nSELECT $1 AS x");
  assert.equal(toPostgres("SELECT 'it"), "SELECT 'it", 'an unterminated string ends the scan');
  assert.equal(toPostgres("SELECT ? WHERE a = 'it''s'"), "SELECT $1 WHERE a = 'it''s'");
});

test('voice perio: numbers, homophones and commands from what the recognizer heard', async () => {
  const { parseSpeech } = await import('../../client/src/components/patient/voicePerio.js');
  assert.deepEqual(parseSpeech('3 2 3 4 bleeding'), [{ n: 3 }, { n: 2 }, { n: 3 }, { n: 4 }, { cmd: 'bop' }]);
  assert.deepEqual(parseSpeech('three to for, 323. Twelve! next tooth pus back skip missing stop'), [
    { n: 3 }, { n: 2 }, { n: 4 }, { n: 3 }, { n: 2 }, { n: 3 }, { n: 12 }, { cmd: 'next_tooth' }, { cmd: 'sup' }, { cmd: 'back' }, { cmd: 'skip' }, { cmd: 'missing' }, { cmd: 'stop' },
  ]);
  assert.deepEqual(parseSpeech('um the patient'), []);
  // Moving around by voice, margins above the CEJ, and the whole side bleeding.
  assert.deepEqual(parseSpeech('tooth 14 3 2 3'), [{ cmd: 'tooth', n: 14 }, { n: 3 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(parseSpeech('go to three, lingual. 4 5'), [{ cmd: 'tooth', n: 3 }, { cmd: 'side', side: 'l' }, { n: 4 }, { n: 5 }]);
  assert.deepEqual(parseSpeech('gingival margin minus two 1 0'), [{ cmd: 'row', row: 'gm' }, { n: -2 }, { n: 1 }, { n: 0 }]);
  assert.deepEqual(parseSpeech('bleeding all, depths'), [{ cmd: 'bop_all' }, { cmd: 'row', row: 'pd' }]);
  assert.deepEqual(parseSpeech('tooth 40'), [{ n: 4 }, { n: 0 }], 'not a tooth: read as numbers');
});
