/* global document, window, sessionStorage, localStorage, getComputedStyle */
// Shared checks for the bug-finding rig (smoke, sweep, chaos, journeys): watches a page for crashes, console
// errors and failed requests, and looks at what is on screen for the tell-tale signs of a broken page — blank,
// "undefined"/"NaN"/"Invalid Date"/"[object Object]" in the text, the page scrolling sideways, a loading line
// that never goes away, or the offline banner.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD = 'demo-password-123';
export const ROLES = {
  admin: 'admin@demo.dentalmachine.app',
  dentist: 'dr.chen@demo.dentalmachine.app',
  hygienist: 'sam@demo.dentalmachine.app',
  frontdesk: 'frontdesk@demo.dentalmachine.app',
  billing: 'billing@demo.dentalmachine.app',
};

// Console noise that isn't the app's fault. Each entry says why it's acceptable.
export const CONSOLE_ALLOW = [
  // Chrome logs every 4xx/5xx response to the console; responses are judged separately (see `responses`),
  // where expected 403/404s are told apart from real failures.
  /Failed to load resource: the server responded with a status of/,
  // React Router's notice about v7 behaviour flags: a library deprecation warning, not an app error.
  /React Router Future Flag Warning/,
];

// Watches one page. Returns live arrays of what went wrong; `reset()` starts a fresh step.
export function watch(page, { base = '' } = {}) {
  const w = { pageErrors: [], console: [], responses: [], failed: [], writes: [], dialogs: [], pending: new Set() };
  const own = (url) => !base || url.startsWith(base);
  page.on('pageerror', (e) => w.pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (CONSOLE_ALLOW.some((re) => re.test(text))) return;
    w.console.push(text.slice(0, 300));
  });
  page.on('dialog', (d) => { w.dialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  // Loading = reads still on their way. The live event stream (/api/events) stays open for as long as the page
  // does, so it isn't "loading"; nor is a write (the smoke test holds automatic writes and never answers them).
  const tracked = (r) => own(r.url()) && r.url().includes('/api/') && !r.url().includes('/api/events') && r.method() === 'GET';
  page.on('request', (r) => {
    if (own(r.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) w.writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    if (tracked(r)) w.pending.add(r);
  });
  const done = (r) => { w.pending.delete(r); };
  // A new page load abandons whatever the last one was still reading (not every browser reports each one).
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) w.pending.clear(); });
  // What is still being read, for messages ("GET /api/…").
  w.stillRunning = () => [...w.pending].map((r) => `${r.method()} ${new URL(r.url()).pathname}`).slice(0, 3).join(', ');
  page.on('requestfinished', done);
  page.on('requestfailed', (r) => {
    done(r);
    const why = r.failure()?.errorText || '';
    // Navigating away cancels what the last screen was still loading: that's normal.
    if (own(r.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(why)) w.failed.push(`${r.method()} ${r.url()} ${why}`);
  });
  page.on('response', (r) => {
    if (!own(r.url()) || r.status() < 400) return;
    w.responses.push({ status: r.status(), method: r.request().method(), path: new URL(r.url()).pathname + new URL(r.url()).search });
  });
  w.reset = () => { for (const k of ['pageErrors', 'console', 'responses', 'failed', 'writes', 'dialogs']) w[k].length = 0; };
  return w;
}

// What's wrong with the screen right now (run after it has settled).
export const SCREEN_CHECK = ({ loadingSelector }) => {
  const text = document.body?.innerText || '';
  const problems = [];
  const main = document.querySelector('main, #main, .auth-page, .card, #root > *');
  if (!text.trim() || !main || (main.innerText || '').trim().length < 2) problems.push('blank page');
  // Tell-tale values of a template that got the wrong data. Only visible text is checked (innerText).
  const bad = text.match(/(^|[\s(:$])(undefined|NaN|Invalid Date|\[object Object\]|null null)(?=$|[\s),.;:])/m);
  if (bad) {
    const i = text.indexOf(bad[0]);
    problems.push(`shows "${bad[2]}": …${text.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' ')}…`);
  }
  // The page itself scrolling sideways (a table or panel wider than the screen that isn't in a scroll box).
  const over = document.documentElement.scrollWidth - window.innerWidth;
  if (over > 2) {
    const wide = [...document.querySelectorAll('main *, .sidebar *, body > div *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > window.innerWidth + 2 && r.width > 0 && getComputedStyle(el).position !== 'fixed';
    }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`);
    problems.push(`page scrolls sideways by ${over}px (${wide.join(', ')})`);
  }
  if (document.querySelector('.offline-banner') || /can[’']t be saved offline|isn[’']t in the offline copy/.test(text)) problems.push('offline banner / "can’t be saved offline" shown');
  const stuck = [...document.querySelectorAll(loadingSelector)].filter((el) => el.offsetParent !== null && /^\s*Loading\b.{0,40}$/i.test(el.innerText || ''));
  if (stuck.length) problems.push(`still loading: "${stuck[0].innerText.trim().slice(0, 60)}"`);
  // The error boundary's "Something went wrong on this screen" (a component crashed while drawing).
  if (/Something went wrong on this screen/.test(text)) problems.push('error screen: "Something went wrong on this screen"');
  return problems;
};

const LOADING = '.empty, .loading, .muted, [aria-busy="true"], .spinner, main p, main div';

// Waits for the screen to settle: requests done and no "Loading…" line, up to `timeout` ms.
export async function settle(page, w, { timeout = 8000 } = {}) {
  const until = Date.now() + timeout;
  let quiet = 0;
  while (Date.now() < until) {
    const loading = await page.evaluate((sel) => [...document.querySelectorAll(sel)].some((el) => el.offsetParent !== null && /^\s*Loading\b.{0,40}$/i.test(el.innerText || '')), LOADING).catch(() => true);
    if (!loading && w.pending.size === 0) {
      quiet += 100;
      if (quiet >= 300) return true;
    } else quiet = 0;
    await page.waitForTimeout(100);
  }
  return false;
}

export const screenProblems = (page) => page.evaluate(SCREEN_CHECK, { loadingSelector: LOADING }).catch((e) => [`could not inspect the page: ${e.message}`]);

// A session token for a demo user (one sign-in per role: sign-in attempts are rate limited per address).
export async function tokenFor(base, email) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`Sign-in failed for ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

// A browser context already signed in with `token`, in light or dark mode, with the menu kept open.
export async function contextAs(browser, { token, theme = 'light', viewport = { width: 1400, height: 900 }, ...opts }) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, ...opts });
  await ctx.addInitScript(([t, th]) => {
    try {
      if (!sessionStorage.getItem('dm_token') && !sessionStorage.getItem('dm_rig_signed_out')) sessionStorage.setItem('dm_token', t);
      localStorage.setItem('dm_theme', th);
      localStorage.setItem('dm_nav_open', '1');
    } catch { /* storage unavailable */ }
  }, [token, theme]);
  return ctx;
}

// Closes office alerts and welcome notes that pop up on first load.
export async function quiet(page) {
  for (let i = 0; i < 6 && (await page.locator('.modal-backdrop').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
}

// Screenshot + trace-friendly failure evidence (E2E_SHOTS=dir keeps them; CI uploads that folder).
export async function shoot(page, name) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/[^a-z0-9-]+/gi, '_').slice(0, 120)}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

export function writeReport(name, data) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
}

// Runs `fn` over `items` with at most `n` at a time.
export async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}
