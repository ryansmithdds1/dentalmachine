// Nightly journey — the owner (admin@demo): the practice's numbers. Metrics (each period), the reports
// (every report tab), and the business view (every tab) all draw with real numbers and nothing broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey } from './lib.mjs';

const j = journey('owner', 'admin@demo.dentalmachine.app');

// Opens a page and each of its tabs, checking every screen along the way.
async function everyTab(path, heading) {
  const { page } = j;
  await j.goto(path, heading);
  await j.healthy(path);
  const tabs = await page.locator('.tabs').first().locator('button').allTextContents().catch(() => []);
  for (const t of tabs) {
    await j.step(`${path} tab ${t.trim()}`, async () => {
      await page.locator('.tabs').first().locator('button', { hasText: t.trim() }).first().click();
      await j.healthy(`${path} → ${t.trim()}`);
    });
  }
  return tabs.length;
}

test('metrics: the numbers are there', async () => {
  await j.step('metrics', () => everyTab('/metrics', 'h1'));
  const m = await j.s.get('/metrics?period=month');
  assert.ok(m && typeof m === 'object' && !m.error, JSON.stringify(m).slice(0, 200));
  assert.match(await j.page.textContent('main'), /\$\d/, 'money figures are shown');
});

test('reports: every report tab draws', async () => {
  const n = await j.step('reports', () => everyTab('/reports', 'h1'));
  assert.ok(n > 1, 'reports has several tabs');
});

test('business view: every tab draws', async () => {
  await j.step('business', () => everyTab('/business', 'h1'));
  assert.match(await j.page.textContent('main'), /\d/, 'numbers are shown');
});
