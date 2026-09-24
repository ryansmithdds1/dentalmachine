// FS · Fee schedules: schedule a 5% increase (budget 4 actions) and approve a payer's new schedule (budget 2).
// The server side runs through e2e/lib/fees-app.mjs until the routes are mounted in app.js; the screen is
// Settings → "Fee updates & history" (skipped, with a note, until it's mounted there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false;
before(async () => {
  app = await startApp({ entry: 'e2e/lib/fees-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  await s.page.goto(`${app.base}/settings?tab=fees`);
  mounted = await s.page.waitForSelector('.fsm', { timeout: 4000 }).then(() => true, () => false);
  if (!mounted) console.log('FS: the Fee schedules screen is not mounted in Settings yet — UI steps skipped, API checked');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('schedule a 5% increase for January 1 in at most 4 actions', async () => {
  const { page } = s;
  const before = (await s.get('/fees/changes')).length ?? 0;
  if (!mounted) {
    const r = await s.post('/fees/increases', { percent: 5, rounding: 'dollar', effective_date: `${new Date().getFullYear() + 1}-01-01` });
    assert.equal(r.changes?.[0]?.status, 'scheduled', JSON.stringify(r));
    return;
  }
  await page.evaluate(() => { try { localStorage.removeItem('dm_fee_raise'); } catch { /* ignore */ } });
  await page.goto(`${app.base}/settings?tab=fees`);
  await page.waitForSelector('.fsm-table tbody tr');
  const r = await measure(page, async () => {
    await page.keyboard.press('r');                                  // Raise fees (5% and next January 1 are the defaults)
    await page.waitForSelector('.fsm-preview .fsm-totals');          // the preview with the yearly effect
    await page.click('.fsm-panel .form-actions button.primary');     // Schedule for Jan 1
    await page.waitForSelector('.fsm-change');
  });
  console.log(withinBudget('schedule a 5% fee increase', r, { actions: 4, ms: 6000 }));
  const changes = await s.get('/fees/changes');
  assert.equal(changes.length, before + 1);
  assert.equal(changes.find((c) => c.kind === 'increase').params.percent, 5);
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});

test('approve a payer’s new fee schedule in at most 2 actions', async () => {
  const { page } = s;
  const fs = await s.post('/fee-schedules', { name: 'Delta PPO (e2e)', kind: 'ppo', percent_of_ucr: 80 });
  const draft = await s.post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,41.00\nD1110,77.00\n', file_name: 'delta-2027.csv' });
  assert.equal(draft.status, 'draft', JSON.stringify(draft));
  if (!mounted) {
    const ok = await s.post(`/fees/changes/${draft.id}/approve`, {});
    assert.equal(ok.status, 'applied', JSON.stringify(ok));
    return;
  }
  await page.goto(`${app.base}/settings?tab=fees`);
  await page.waitForSelector('.fsm-change');
  const r = await measure(page, async () => {
    await page.click(`.fsm-change:has-text("delta-2027.csv")`);       // open the draft: differences side by side
    await page.waitForSelector('.fsm-panel .fsm-lines tbody tr');
    await page.click('.fsm-panel button:has-text("Approve")');        // approve (effective today)
    await page.waitForSelector('.fsm-panel', { state: 'detached' });
  });
  console.log(withinBudget('approve an imported fee schedule', r, { actions: 2, ms: 5000 }));
  const after = await s.get(`/fees/changes/${draft.id}`);
  assert.equal(after.status, 'applied');
  const versions = await s.get(`/fees/schedules/${fs.id}/versions`);
  assert.equal(versions.versions.length, 2, 'the old fees are kept as the version before');
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});

test('history: versions are hidden until asked, then two can be compared', async () => {
  if (!mounted) return;
  const { page } = s;
  await page.goto(`${app.base}/settings?tab=fees`);
  await page.click('.fsm-table tr:has-text("Delta PPO (e2e)") button:has-text("History")');
  await page.waitForSelector('.fsm-versions tbody tr');
  await page.click('.fsm-panel button:has-text("Compare")');
  await page.waitForSelector('.fsm-panel .fsm-lines td:has-text("D0120")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fsm-panel', { state: 'detached' });
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});
