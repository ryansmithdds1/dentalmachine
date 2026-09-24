// Post-deploy smoke test against a running site — READ-ONLY. Signs in as each demo role, opens every page in
// the menu and a few key screens (a schedule day, a patient's chart, the Billing tabs), and fails on a 5xx,
// a page error or console error, the offline banner ("can't be saved offline"), a crash screen or a blank page.
//
// It never changes anything: every request that could write (anything but GET/HEAD/OPTIONS) is intercepted
// in the browser. Sign-in is let through; a short list of writes the app makes by itself just by showing a
// screen (marking a conversation read…) are held in the browser and never reach the server; anything
// else is blocked and fails the test.
//
//   npm run smoke -- https://dentalmachine-server.vercel.app
//   SMOKE_URL=https://… node --test e2e/smoke/live.test.mjs
// Deployments behind Vercel Deployment Protection: set SMOKE_BYPASS_SECRET to the project's "Protection Bypass
// for Automation" secret. E2E_SHOTS=dir keeps screenshots of failures.
// Behind a TLS-inspecting proxy (a corporate network, a sandbox): SMOKE_TRUST_CA=/path/to/proxy-ca.pem trusts
// that one CA's key (Chromium's SPKI list) — certificate checks stay on for everything else.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { ROLES, PASSWORD, watch, settle, screenProblems, quiet, shoot, writeReport } from '../lib/watch.mjs';

const arg = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
const base = (process.env.SMOKE_URL || arg || '').replace(/\/$/, '');
const SLOW = Number(process.env.SMOKE_TIMEOUT_SECONDS || 20) * 1000;

// Writes the app makes on its own when a screen opens. They are held in the browser — never sent, never
// answered (answering would make the screen think it worked and try again) — so the live data stays untouched.
// Each says why it is here.
const AUTOMATIC_WRITES = [
  { method: 'POST', path: /^\/api\/patients\/\d+\/conversation\/read$/, why: 'Messages marks the open conversation as read' },
  { method: 'POST', path: /^\/api\/client-errors$/, why: 'browser errors are reported to the server (the error itself fails the test)' },
];
const SIGN_IN = { method: 'POST', path: /^\/api\/auth\/login$/ };

const blocked = []; // writes that were stopped: each one fails the test
const held = []; // automatic writes held in the browser (never sent)
let browser;

before(async () => {
  if (!base) throw new Error('Set SMOKE_URL (or pass the URL: npm run smoke -- https://…)');
  // Trust one extra CA by its key (see above), rather than turning certificate checks off.
  const pems = process.env.SMOKE_TRUST_CA ? readFileSync(process.env.SMOKE_TRUST_CA, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [] : [];
  const spki = pems.map((pem) => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    ...(spki.length ? { args: [`--ignore-certificate-errors-spki-list=${spki.join(',')}`] } : {}),
  });
});
after(async () => { await browser?.close(); });

async function signedIn(email) {
  const headers = process.env.SMOKE_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.SMOKE_BYPASS_SECRET, 'x-vercel-set-bypass-cookie': 'true' } : {};
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, extraHTTPHeaders: headers });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    const url = new URL(req.url());
    if (url.origin === base && method === SIGN_IN.method && SIGN_IN.path.test(url.pathname)) return route.continue();
    const auto = url.origin === base && AUTOMATIC_WRITES.find((a) => a.method === method && a.path.test(url.pathname));
    if (auto) {
      held.push(`${email}: ${method} ${url.pathname} (${auto.why})`);
      return undefined; // held: the request stays pending until the page closes
    }
    blocked.push(`${email}: ${method} ${url.href}`);
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(SLOW);
  const w = watch(page, { base });
  await page.goto(base);
  await page.fill('input[autocomplete=username]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button.primary');
  await page.waitForSelector('main', { timeout: SLOW * 2 });
  await quiet(page);
  return { ctx, page, w };
}

// Every page in this person's menu: the links in the sidebar, with any collapsed menu sections opened.
async function menuPages(page) {
  await page.evaluate(() => { for (const b of document.querySelectorAll('aside button[aria-expanded="false"]:not(.user-button)')) b.click(); });
  await page.waitForTimeout(300);
  const hrefs = await page.$$eval('aside a[href^="/"], nav a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href').split('#')[0]))]);
  await page.keyboard.press('Escape');
  return hrefs.filter((h) => !/^\/(api|logout)/.test(h));
}

// Looks at the current screen; returns what's wrong with it.
async function inspect(page, w) {
  const settled = await settle(page, w, { timeout: SLOW });
  const found = (await screenProblems(page)).filter((p) => !p.startsWith('page scrolls sideways')); // layout is the sweep's job
  if (!settled && !found.some((p) => p.startsWith('still loading'))) found.push(`requests still running after ${SLOW / 1000}s: ${w.stillRunning()}`);
  found.push(...w.pageErrors.map((e) => `page error: ${e}`), ...w.console.map((e) => `console error: ${e}`), ...w.dialogs.map((d) => `dialog: ${d}`));
  found.push(...w.responses.filter((r) => r.status >= 500 || r.status === 401).map((r) => `HTTP ${r.status} ${r.method} ${r.path}`));
  found.push(...w.failed.filter((f) => !/blockedbyclient|ERR_BLOCKED_BY_CLIENT/i.test(f)).map((f) => `request failed: ${f}`));
  w.reset();
  return found;
}

const report = {};
for (const [role, email] of Object.entries(ROLES)) {
  test(`${role} (${email}) signs in and every screen loads`, { timeout: 15 * 60_000 }, async () => {
    const { ctx, page, w } = await signedIn(email);
    const problems = [];
    const visit = async (label, go) => {
      try {
        await go();
      } catch (e) {
        w.pageErrors.push(`could not open: ${e.message.split('\n')[0]}`);
      }
      await quiet(page);
      const found = await inspect(page, w);
      if (found.length) {
        problems.push(`${label}: ${found.join(' | ')}`);
        await shoot(page, `smoke-${role}-${label}`);
      }
    };
    await visit('sign-in', async () => {});
    const pages = await menuPages(page);
    assert.ok(pages.length >= 3, `the menu shows pages (found ${pages.join(', ')})`);
    for (const p of pages) await visit(p, () => page.goto(`${base}${p}`));

    // Key screens: a schedule day, a patient's chart (each tab), and the Billing tabs.
    if (pages.includes('/schedule')) await visit('/schedule (today)', () => page.goto(`${base}/schedule`));
    const patient = await page.evaluate(async () => {
      const r = await fetch('/api/patients?limit=1', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } });
      return r.ok ? (await r.json()).rows?.[0]?.id : null;
    });
    if (patient) {
      await visit(`/patients/${patient}`, () => page.goto(`${base}/patients/${patient}`));
      for (const tab of await page.locator('.tabs').first().locator('button').allTextContents().catch(() => [])) {
        await visit(`/patients/${patient} tab "${tab.trim()}"`, () => page.locator('.tabs').first().locator('button', { hasText: tab.trim() }).first().click());
      }
    }
    if (pages.includes('/claims')) {
      await visit('/claims', () => page.goto(`${base}/claims`));
      for (const tab of await page.locator('.tabs').first().locator('button').allTextContents().catch(() => [])) {
        await visit(`/claims tab "${tab.trim()}"`, () => page.locator('.tabs').first().locator('button', { hasText: tab.trim() }).first().click());
      }
    }
    report[role] = { pages, problems };
    await ctx.close();
    assert.deepEqual(problems, []);
  });
}

test('nothing but sign-in tried to change data on the site', () => {
  writeReport('smoke-report.json', { base, report, blocked, held });
  if (held.length) console.log(`# automatic writes held in the browser (never sent): ${held.length}`);
  assert.deepEqual(blocked, [], 'these writes were blocked before reaching the server');
});
