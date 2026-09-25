// Workflow 18 for the people who answer "how much will it cost?" — the front desk (scorecard bug 5, A025). They
// can't chart, so the chart's typing box works for them as an estimate only: Alt+E from anywhere (the patient bar)
// puts the cursor in it, "14 D2740" shows the fee and the insurance and patient shares, and nothing is charted.
// Spec: docs/workflows/specs/18-estimate.md.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let admin; let desk;
before(async () => {
  app = await startApp();
  browser = await launch();
  admin = await signIn(browser, app.base);
  desk = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await trackActions(desk.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('#18 front desk: Alt+E, "14 D2740" — the estimate in 2 actions, charting nothing', async () => {
  const carrier = await admin.post('/carriers', { name: 'Estimate Dental', payer_id: '99997' });
  const p = await admin.post('/patients', { first_name: 'Esti', last_name: 'Deskwell', dob: '1984-04-04' });
  await admin.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Esti Deskwell', subscriber_id: `ES${p.id}`, group_number: 'G1', pct_major: 50 });
  const { page } = desk;
  // The patient they're on the phone with is the active patient (opened once).
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForFunction((id) => document.querySelector('h1') && sessionStorage.getItem('dm_active_patient') === String(id), p.id);
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector(`.patient-bar:has-text("Deskwell")`);
  const before = (await admin.get(`/patients/${p.id}/chart`)).procedures.length;
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+e');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Estimate by typing');
    await page.keyboard.type('14 D2740');
    await page.waitForSelector('.chart-entry .est:has-text("Est. patient $")');
  });
  console.log(withinBudget('#18 estimate (front desk)', r, { actions: 2 }));
  assert.match(await page.locator('.chart-entry .est').innerText(), /Estimate Dental \$/, 'the insurance share too');
  assert.equal(await page.locator('.chart-entry .te-estimate-only').count(), 1, 'says it is an estimate only');
  // Enter charts nothing.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert.equal((await admin.get(`/patients/${p.id}/chart`)).procedures.length, before, 'nothing charted');
  assert.deepEqual(desk.errors, []);
});
