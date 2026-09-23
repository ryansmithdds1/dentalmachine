// Two real API server processes sharing one database and one Redis: a change on one reaches live screens on the other.
// Runs when TEST_REDIS_URL is set (e.g. redis://localhost:6379).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const redisUrl = process.env.TEST_REDIS_URL;
const skip = !redisUrl && 'set TEST_REDIS_URL to run the multi-server test';
const dir = mkdtempSync(join(tmpdir(), 'dm-cluster-'));
const servers = [];
const prefix = `dmtest${process.pid}${Date.now()}`;

const start = (port) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    env: {
      ...process.env, PORT: String(port), JWT_SECRET: 'cluster-secret', REDIS_URL: redisUrl, REDIS_PREFIX: prefix, REMINDERS: 'off',
      DATABASE_URL: process.env.TEST_DATABASE_URL || '', DATABASE_PATH: join(dir, 'shared.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    if (out.includes('listening')) resolve(`http://localhost:${port}`);
  });
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
});

let a;
let b;
before(async () => {
  if (skip) return;
  a = await start(4611);
  b = await start(4612);
});
after(() => {
  for (const s of servers) s.kill();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (base, method, path, body, token) => {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('live updates and rate limits are shared across servers', { skip }, async () => {
  const email = `cluster-${Date.now()}@example.com`;
  const reg = await call(a, 'POST', '/auth/register', { practice_name: 'Cluster Dental', name: 'Admin', email, password: 'correct-horse-battery' });
  assert.equal(reg.status, 201);
  const token = reg.data.token;
  const provider = (await call(a, 'POST', '/providers', { name: 'Dr. A', type: 'dentist' }, token)).data;
  const patient = (await call(a, 'POST', '/patients', { first_name: 'Pat', last_name: 'Ient' }, token)).data;

  // Listen on server B.
  const controller = new AbortController();
  const res = await fetch(`${b}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
      const m = buf.match(/data: (.+)\n\n/);
      if (m) return JSON.parse(m[1]);
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  // Change the schedule on server A.
  const appt = await call(a, 'POST', '/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-03-05 09:00', end_time: '2031-03-05 10:00' }, token);
  assert.equal(appt.status, 201);
  const event = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no event on server B')), 3000))]);
  controller.abort();
  assert.equal(event.type, 'schedule');
  assert.deepEqual(event.dates, ['2031-03-05']);

  // Login limiter (20 per 15 min) counts attempts on both servers together.
  let limited = false;
  for (let i = 0; i < 24 && !limited; i++) {
    const r = await call(i % 2 ? a : b, 'POST', '/auth/login', { email, password: 'wrong-password' });
    limited = r.status === 429;
  }
  assert.ok(limited, 'attempts spread over two servers are still limited');
});
