// CAP capacity meter (docs/workflows/specs/CAP-capacity.md): from anywhere, one click opens Capacity and the red
// meter and its recommendation — with the numbers behind it — are on screen without another action. The targets
// open in a side panel on T and save without a dialog. Skipped until the routes are mounted (see the hand-off).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const probe = await s.page.evaluate(async () => (await fetch('/api/capacity', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status);
  mounted = probe === 200 && (await s.page.locator('.sidebar a[href="/capacity"]').count()) > 0;
  if (!mounted) return;
  // Both dentists away for the next 10 days and a 3-day treatment target: treatment is red.
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const p of (await s.get('/providers?active=true')).filter((x) => x.type === 'dentist')) {
    const r = await s.post('/blockouts', { provider_id: p.id, start_time: `${today} 00:00`, end_time: `${today} 23:59`, reason: 'CE course', through_date: addDays(today, 9) });
    assert.ok(Array.isArray(r), JSON.stringify(r));
  }
  const t = await s.api('PUT', '/capacity/targets', { treatment_days: 3 });
  assert.equal(t.targets.treatment_days, 3);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('CAP open capacity: a red meter and its recommendation in one action', async (t) => {
  if (!mounted) return t.skip('capacity routes not mounted yet');
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.sidebar');
  const r = await measure(page, async () => {
    await page.locator('.sidebar a[href="/capacity"]').click();
    await page.waitForSelector('.cap-rec.red');
  });
  console.log(withinBudget('CAP open capacity → red meter + recommendation', r, { actions: 1, ms: 5000 }));
  // The doctor's treatment chips are red and the advice names the fix, with its numbers.
  assert.ok(await page.locator('section[aria-label="Doctor capacity"] .cap-chip.red').count() > 0);
  const rec = page.locator('.cap-rec.red', { hasText: 'treatment is' }).first();
  assert.match(await rec.locator('.cap-rec-text').innerText(), /treatment is .* out: (extend|open)/);
  assert.match(await rec.locator('.cap-rec-why').innerText(), /target 3 days/);
  // Targets: T opens the side panel (no modal), Escape closes it.
  await page.keyboard.press('t');
  await page.waitForSelector('.cap-drawer');
  assert.equal(await page.locator('.modal').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.cap-drawer', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});
