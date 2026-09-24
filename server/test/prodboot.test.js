// Production-config boot: starts the real serverless entry (api/index.js) the way Vercel runs it, with the
// live demo site's settings (VERCEL=1, NODE_ENV=production, DEMO_SEED=on, sandbox drivers, no REDIS_URL,
// no APP_ENV), and checks the site actually answers and staff can sign in. A copy that says it holds real
// patients (APP_ENV=production) without Redis must still refuse to start.
//
// Why: the live demo once refused to start because the pre-flight checks demanded REDIS_URL on Vercel, and no
// test ever booted with Vercel-like settings. Runs on SQLite, and on Postgres when TEST_DATABASE_URL is set
// (a private schema per case, dropped afterwards).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { productionProblems, isDemoOrStaging } from '../src/preflight.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/vercel-host.js');
const PASSWORD = 'demo-password-123';
const ROLES = ['admin', 'dr.chen', 'sam', 'frontdesk', 'billing'];

// The live Vercel project's environment (dentalmachine-server), with fresh random secrets.
const vercelDemoEnv = () => ({
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'dentalmachine-server.vercel.app',
  NODE_ENV: 'production', DEMO_SEED: 'on',
  EDI_MODE: 'sandbox', PAYMENTS: 'sandbox', ERX: 'sandbox', PLAID: 'sandbox', QBO: 'sandbox', MAIL_DRIVER: 'log', SMS_DRIVER: 'log',
  LIVE_UPDATES: 'off', REMINDERS: 'off',
  JWT_SECRET: randomBytes(32).toString('hex'), DOCUMENT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

// A database for one boot: a temporary SQLite file, or a fresh schema in the test Postgres.
async function database() {
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (!pgUrl) {
    const dir = mkdtempSync(join(tmpdir(), 'dm-prodboot-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { DATABASE_URL: '', DATABASE_PATH: join(dir, 'prodboot.db') };
  }
  const { default: pg } = await import('pg');
  const schema = `prodboot_${process.pid}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  cleanups.push(async () => {
    const c = new pg.Client({ connectionString: pgUrl });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });
  const sep = pgUrl.includes('?') ? '&' : '?';
  return { DATABASE_URL: `${pgUrl}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`, DATABASE_PATH: '' };
}

// Starts the Vercel-style host with exactly `env` (plus PATH) — nothing leaks in from the test runner's own
// environment (REDIS_URL, APP_ENV…), so the case is the configuration it says it is.
async function boot(env) {
  const cwd = mkdtempSync(join(tmpdir(), 'dm-prodboot-')); // like /var/task: default ./data/uploads lands here
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST], {
    cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`host exited (${code}): ${stderr}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  }).then(() => rmSync(cwd, { recursive: true, force: true }));
  cleanups.push(stop);
  return { base: `http://127.0.0.1:${port}`, stderr: () => stderr, stop };
}

const signIn = (base, email) => fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
});

test('the live demo configuration passes the pre-flight checks', () => {
  const env = vercelDemoEnv();
  assert.deepEqual(productionProblems(env), [], 'the demo site must be allowed to start');
  assert.ok(isDemoOrStaging(env), 'DEMO_SEED=on with no APP_ENV counts as a demo copy');
});

test('a real-data configuration on Vercel without Redis is refused by the pre-flight checks', () => {
  const env = { ...vercelDemoEnv(), APP_ENV: 'production', DEMO_SEED: '' };
  for (const k of ['EDI_MODE', 'PAYMENTS', 'ERX', 'PLAID', 'QBO', 'MAIL_DRIVER', 'SMS_DRIVER']) delete env[k];
  assert.match(productionProblems(env).join('; '), /REDIS_URL must be set/);
  assert.deepEqual(productionProblems({ ...env, REDIS_URL: 'redis://cache:6379' }), [], 'with Redis it may start');
});

test('the Vercel entry boots with the live demo settings: health answers and every demo role signs in', { timeout: 180_000 }, async () => {
  const app = await boot({ ...vercelDemoEnv(), ...(await database()) });
  // The first request boots the app (migrations and the demo practice), like a cold start.
  const health = await fetch(`${app.base}/api/health`);
  assert.equal(health.status, 200, `health failed: ${await health.clone().text()}\n${app.stderr()}`);
  assert.equal((await health.json()).ok, true);
  assert.doesNotMatch(app.stderr(), /Refusing to start|Startup failed/);
  assert.match(app.stderr(), /REDIS_URL is not set/, 'the missing Redis is warned about, not fatal');

  for (const who of ROLES) {
    const res = await signIn(app.base, `${who}@demo.dentalmachine.app`);
    const body = await res.json();
    assert.equal(res.status, 200, `${who} could not sign in: ${JSON.stringify(body)}`);
    assert.ok(body.token, `${who} got a session token`);
    // The session works: the signed-in user and a patient list come back.
    const me = await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${body.token}` } });
    assert.equal(me.status, 200, `${who}: /auth/me`);
  }
  const admin = (await (await signIn(app.base, 'admin@demo.dentalmachine.app')).json()).token;
  const patients = await fetch(`${app.base}/api/patients`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(patients.status, 200);
  assert.ok((await patients.json()).total > 0, 'the demo practice was seeded');
  // A wrong password is still refused in production.
  const wrong = await fetch(`${app.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.dentalmachine.app', password: 'wrong-password' }),
  });
  assert.equal(wrong.status, 401);
  await app.stop();
});

test('the Vercel entry refuses to start a real-data configuration (APP_ENV=production) without Redis', { timeout: 60_000 }, async () => {
  const env = { ...vercelDemoEnv(), APP_ENV: 'production', DEMO_SEED: '', ...(await database()) };
  // Real integrations would be configured here; leave them unset so the only problem is the missing Redis.
  for (const k of ['EDI_MODE', 'PAYMENTS', 'ERX', 'PLAID', 'QBO', 'MAIL_DRIVER', 'SMS_DRIVER']) delete env[k];
  const app = await boot(env);
  const health = await fetch(`${app.base}/api/health`);
  assert.equal(health.status, 503, 'it must not serve');
  assert.match(app.stderr(), /Refusing to start: .*REDIS_URL must be set/);
  const login = await signIn(app.base, 'admin@demo.dentalmachine.app');
  assert.equal(login.status, 503, 'no sign-in on a server that refused to start');
  await app.stop();
});
