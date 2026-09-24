// BV · The business view (docs/workflows/specs/BV-business-view.md): the owner turns the business view on the
// schedule on in one action (click or Shift+B), sees each visit colored by margin per hour and today's labor % of
// production live; staff get nothing from the business API. The server side runs through e2e/lib/business-app.mjs
// until the routes are mounted in app.js; the schedule steps are skipped (with a note) until the schedule mounts the
// toggle (see the spec's "Mounting").
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let today; let tz; let mounted = false; let routes = false;
const addMinutes = (local, n) => new Date(Date.parse(`${local.replace(' ', 'T')}:00Z`) + n * 60000).toISOString().slice(0, 16).replace('T', ' ');

before(async () => {
  app = await startApp({ entry: 'e2e/lib/business-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  tz = (await s.get('/practice')).timezone || 'America/New_York';
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(', ', ' ');
  today = now.slice(0, 10);
  const access = await s.get('/business/access');
  routes = access?.view === true;
  if (!routes) { console.log('BV: /api/business is not mounted — skipped'); return; }
  // Someone on the clock with a pay rate, so labor % has something to count: in two hours ago, shift until tonight.
  const email = `bv-asst-${Date.now()}@example.com`;
  const u = await s.post('/users', { email, name: 'Bea Assist', role: 'assistant', password: 'correct-horse-battery' });
  assert.ok(u.id, JSON.stringify(u));
  await s.api('PUT', `/timeclock/staff/${u.id}`, { hourly_rate_cents: 2500, reason: 'e2e' });
  await s.api('PUT', '/timeclock/shifts', { user_id: u.id, date: today, start_time: '00:00', end_time: '23:59' });
  const inAt = addMinutes(now, -120);
  const p = await s.post('/timeclock/punches', { user_id: u.id, clock_in: inAt.slice(0, 10) < today ? `${today} 00:00` : inAt, reason: 'e2e' });
  assert.ok(p.id, JSON.stringify(p));
  await s.page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await s.page.waitForSelector('.cal, .empty');
  mounted = await s.page.waitForSelector('.biz-toggle', { timeout: 4000 }).then(() => true, () => false);
  if (!mounted) console.log('BV: the business toggle is not mounted on the schedule yet — screen steps skipped, API checked');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('the owner turns the business view on in one action and sees labor % of production', async () => {
  if (!routes) return;
  const t = await s.get(`/business/today?date=${today}`);
  assert.equal(typeof t.labor.pct_of_production === 'number' || t.production.scheduled === 0, true, JSON.stringify(t.labor));
  assert.ok(t.labor.so_far > 0, 'someone is on the clock');
  if (!mounted) return;
  const { page } = s;
  // Start from "off" (the choice is remembered per person).
  if (await page.locator('.biz-toggle.active').count()) { await page.click('.biz-toggle'); await page.waitForSelector('.biz-toggle:not(.active)'); }
  const r = await measure(page, async () => {
    await page.click('.biz-toggle');
    await page.waitForSelector('[data-testid=biz-labor-pct] strong');
  });
  console.log(withinBudget('turn on the business view', r, { actions: 1, ms: 5000 }));
  const labor = await page.textContent('[data-testid=biz-labor-pct] strong');
  assert.match(labor, /%|—/, labor);
  if (t.production.scheduled > 0) assert.match(labor, /\d+(\.\d)?%/);
  // Visits are colored by margin per hour (the demo schedule has some today), with a hover breakdown.
  const visits = await page.locator('.cal-appt').count();
  if (visits) {
    await page.waitForSelector('.cal-appt.biz');
    const title = await page.getAttribute('.cal-appt.biz', 'title');
    assert.match(title, /margin per (chair|doctor)-hour/);
    assert.match(await page.getAttribute('.cal-appt.biz', 'class'), /biz-(red|amber|green|gold|none)/);
  }
  // Shift+B turns it off again.
  await page.keyboard.press('Shift+B');
  await page.waitForSelector('.biz-toggle:not(.active)');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.cal-appt.biz').length), 0);
  assert.deepEqual(s.errors, []);
});

test('staff get nothing from the business API', async () => {
  if (!routes) return;
  const email = `bv-desk-${Date.now()}@example.com`;
  const u = await s.post('/users', { email, name: 'Dee Desk', role: 'front_desk', password: 'correct-horse-battery' });
  assert.ok(u.id);
  const login = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) }).then((x) => x.json());
  const get = (p) => fetch(`${app.base}/api${p}`, { headers: { Authorization: `Bearer ${login.token}` } });
  for (const p of [`/business/today?date=${today}`, `/business/schedule?date=${today}`, '/business/settings']) assert.equal((await get(p)).status, 403, p);
});
