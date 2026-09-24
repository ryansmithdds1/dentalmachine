// Fixes from the internal security review that aren't covered by a feature's own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { localUrlsAllowed } from '../src/netguard.js';

const h = harness();

test('a "text" upload has to be text, and is never saved under a page or script name', async () => {
  const { patient, token } = await h.practice();
  const up = (filename, body) => fetch(`${h.origin}/api/patients/${patient.id}/documents?filename=${filename}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body });
  const html = await up('page.html', 'hello there');
  assert.equal(html.status, 201);
  assert.equal((await html.json()).filename, 'page.txt');
  const scan = await up('crown.stl', 'solid crown\nendsolid crown\n');
  assert.equal((await scan.json()).filename, 'crown.stl', 'text-format scans keep their names');
  assert.equal((await up('bad.txt', Buffer.from([0xff, 0xfe, 0x00, 0x41]))).status, 415);
});

test('the public status page does not say which code version is running', async () => {
  process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567';
  try {
    const s = (await h.client().get('/public/status')).data;
    assert.equal(typeof s.status, 'string');
    assert.equal(s.version, undefined);
    assert.equal(JSON.stringify(s).includes('abcdef1'), false);
  } finally {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  }
});

test('local addresses (for SSO and webhooks) are only allowed on a developer machine', () => {
  assert.equal(localUrlsAllowed({ NODE_ENV: 'test' }), true);
  assert.equal(localUrlsAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(localUrlsAllowed({ APP_ENV: 'staging' }), false);
  assert.equal(localUrlsAllowed({ APP_ENV: 'demo', NODE_ENV: 'development' }), false);
  assert.equal(localUrlsAllowed({ VERCEL: '1' }), false);
});

test('the Plaid webhook turns away junk key ids without asking Plaid', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: '../../etc' })).toString('base64url');
  const res = await fetch(`${h.origin}/api/webhooks/plaid`, { method: 'POST', headers: { 'Plaid-Verification': `${header}.e30.sig`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok([401, 403, 501].includes(res.status), `got ${res.status}`);
});
