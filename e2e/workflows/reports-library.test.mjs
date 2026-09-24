// Reports → Report library: find a report by name from the command bar, filter it, sort it, star it, print view.
// Skips itself until the server mounts the report library routes (routes/reportlibrary.js).
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  mounted = Array.isArray((await s.get('/report-library').catch(() => null))?.reports);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('open "Production by provider" by name from the command bar in 3 actions', async (t) => {
  if (!mounted) return t.skip('report library routes not mounted');
  const { page } = s;
  await page.goto(`${app.base}/reports?tab=library`);
  await page.waitForSelector('.rl-card');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('production by provider');
    await page.waitForSelector('.palette-item:has-text("Report: Production by provider")');
    await page.keyboard.press('Enter');
    await page.waitForURL(/report=production-by-provider/);
  });
  console.log(withinBudget('open a library report by name', r, { actions: 3, ms: 4000 }));
  await page.waitForSelector('.rl-table tbody tr');
  assert.match(await page.textContent('.rl-title'), /Production by provider/);
  // Totals row, and sorting by a column.
  await page.waitForSelector('.rl-table tfoot .totals-row');
  await page.click('.rl-table th:has-text("Production") button');
  assert.equal(await page.getAttribute('.rl-table th:has-text("Production")', 'aria-sort'), 'ascending');
});

test('search the library, star a report, and find it under Favourites', async (t) => {
  if (!mounted) return t.skip('report library routes not mounted');
  const { page } = s;
  await page.goto(`${app.base}/reports?tab=library`);
  await page.waitForSelector('.rl-search input');
  await page.fill('.rl-search input', 'no-show');
  await page.waitForSelector('.rl-card-name:has-text("No-show & cancellation rate")');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/report=no-show-cancel-rate/);
  await page.waitForSelector('.rl-table');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('f');
  await page.waitForSelector('.rl-title .rl-star.on');
  await page.keyboard.press('Escape');
  await page.click('.rl-cat:has-text("Favourites")');
  await page.waitForSelector('.rl-card-name:has-text("No-show & cancellation rate")');
  // Tidy up: unstar it again.
  await page.click('.rl-card:has-text("No-show & cancellation rate") .rl-star');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.rl-card').length), 0);
});
