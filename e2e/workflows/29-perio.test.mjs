// #29 perio charting on the keyboard: a digit per site, B/U/P for bleeding, pus and plaque on the site just probed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let patient;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  patient = await s.post('/patients', { first_name: 'Perry', last_name: `Odont${Date.now() % 10000}`, dob: '1970-05-05' });
});
after(async () => { await browser?.close(); await app?.stop(); });

test('#29 six sites and two markers on the keyboard: one action per reading, then save', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=perio`);
  await page.waitForSelector('.perio-table');
  const r = await measure(page, async () => {
    await page.locator('.chart-toolbar button:has-text("Depths")').click(); // focuses the first site (#1 DB)
    for (const d of '324') await page.keyboard.type(d);
    await page.keyboard.type('b');           // bleeding on the site just probed (#1 MB)
    for (const d of '535') await page.keyboard.type(d);
    await page.keyboard.type('B');           // Shift+B: bleeding on that whole side of #2
  });
  // 1 click + 6 readings + 2 markers; digits move on by themselves, so each lands in a new box.
  console.log(withinBudget('#29 six perio sites + markers', r, { actions: 9, ms: 5000 }));
  await page.locator('.page-header button.primary:has-text("Save exam")').click();
  await page.waitForSelector('.page-header :text("Perio exam")');
  const [exam] = await s.get(`/patients/${patient.id}/perio`);
  assert.deepEqual(exam.readings['1'].pd.slice(0, 3), [3, 2, 4]);
  assert.equal(exam.readings['1'].bop[2], true, 'B marks the site just probed');
  assert.deepEqual(exam.readings['2'].pd.slice(0, 3), [5, 3, 5]);
  assert.deepEqual(exam.readings['2'].bop.slice(0, 3), [true, true, true], 'Shift+B marks the whole side');
  // The drawing shows the pockets.
  assert.ok(await page.locator('.perio-tooth2 .pt2-pocket').count() > 0);
  assert.deepEqual(s.errors, []);
});
