// Starts the app on a fresh SQLite database seeded with the demo practice, for end-to-end tests.
// E2E_URL=http://localhost:4000 uses a server you started instead.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export async function startApp() {
  if (process.env.E2E_URL) return { base: process.env.E2E_URL, stop: async () => {} };
  if (!existsSync(join(root, 'client/dist/index.html'))) throw new Error('Build the client first: npm run build');
  const dir = mkdtempSync(join(tmpdir(), 'dm-e2e-'));
  const port = 5100 + Math.floor(Math.random() * 800);
  const env = {
    ...process.env, DATABASE_PATH: join(dir, 'e2e.db'), DATABASE_URL: '', JWT_SECRET: 'e2e-secret', PORT: String(port), APP_URL: `http://localhost:${port}`,
    UPLOAD_DIR: join(dir, 'uploads'), EDI_MODE: 'sandbox', PAYMENTS: 'sandbox', SMS_DRIVER: 'log', MAIL_DRIVER: 'log', REMINDERS: 'off', NODE_ENV: 'test',
  };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/seed.js'], { cwd: root, env, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(`Seeding failed: ${seeded.stderr}`);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.env.E2E_DEBUG && process.stderr.write(d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, stop: async () => { server.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

export const launch = () => chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});

// A signed-in page for one of the demo users.
export async function signIn(browser, base, { email = 'admin@demo.dentalmachine.app', viewport = { width: 1400, height: 900 }, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); d.accept(); });
  await page.goto(base);
  await page.fill('input[autocomplete=username]', email);
  await page.fill('input[type=password]', 'demo-password-123');
  await page.click('button.primary');
  await page.waitForSelector('.sidebar');
  // Office alerts and welcome notes pop up on first load; clear them so tests start from a quiet screen.
  await page.waitForTimeout(300);
  while (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/api${p}`, { method: m, headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  }, [method, path, body]);
  return { ctx, page, errors, api, get: (p) => api('GET', p), post: (p, b) => api('POST', p, b) };
}
