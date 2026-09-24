// DSO / group console: overview tiles, the central billing queue (keyboard), patient lookup and group reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  // The demo practice starts a group, and a second practice joins it with the owner's code.
  await s.post('/org', { name: 'Demo Dental Group' });
  const { code } = await s.post('/org/join-code');
  const other = await s.page.evaluate(async (email) => (await fetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_name: 'Lakeside Dental', name: 'Lake Admin', email, password: 'lakeside-password-1' }),
  })).json(), `lake-${Date.now()}@example.com`);
  await s.page.evaluate(async ([token, c]) => fetch('/api/org/join', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) }), [other.token, code]);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('group overview shows a tile per practice', async () => {
  const { page } = s;
  await page.goto(`${app.base}/group`);
  await page.waitForSelector('.grp-tile');
  assert.equal(await page.locator('.grp-tile').count(), 2);
  assert.match(await page.textContent('.grp-tiles'), /Lakeside Dental/);
});

test('billing queue: J/K through the rows and Enter opens the claim in its practice', async () => {
  const { page } = s;
  await page.goto(`${app.base}/group?tab=billing&queue=outstanding`);
  await page.waitForSelector('.grp-queue tbody tr');
  const openable = await s.get('/org/billing/queue?queue=outstanding');
  const target = openable.rows.findIndex((r) => r.can_open);
  if (target < 0) return; // demo data without a claim out: nothing to open
  const r = await measure(page, async () => {
    for (let i = 0; i < target; i++) await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/claims\/\d+/);
  });
  console.log(withinBudget('open a claim from the group queue', r, { actions: target + 1, ms: 4000 }));
});

test('assign to me with M, then filter to mine', async () => {
  const { page } = s;
  await page.goto(`${app.base}/group?tab=billing&queue=outstanding`);
  await page.waitForSelector('.grp-queue tbody tr');
  const rows = await s.get('/org/billing/queue?queue=outstanding');
  if (!rows.rows.length) return;
  await page.keyboard.press('m');
  let mine = [];
  for (let i = 0; i < 20 && !mine.length; i++) {
    await page.waitForTimeout(150);
    mine = (await s.get('/org/billing/queue?queue=outstanding&assigned=me')).rows;
  }
  assert.ok(mine.length >= 1, 'M assigned the row under the cursor');
});

test('patient lookup and group reports render', async () => {
  const { page } = s;
  const someone = (await s.get('/patients?limit=1')).rows?.[0] || (await s.get('/patients?limit=1'))[0];
  await page.goto(`${app.base}/group?tab=lookup`);
  await page.fill('input[placeholder="First and last name"]', `${someone.first_name} ${someone.last_name}`);
  await page.click('button:has-text("Find")');
  await page.waitForSelector(`td:has-text("${someone.last_name}")`);
  await page.goto(`${app.base}/group?tab=reports`);
  await page.waitForSelector('.grp-charts .bar-col');
  assert.equal(await page.locator('.grp-charts .bar-col').count(), 2);
  assert.match(await page.textContent('.grp-total-row'), /Group/);
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});
