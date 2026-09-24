// The shared pieces every workflow leans on: command bar, active patient, shortcuts, undo, smart defaults.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let patient;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  patient = (await s.get('/patients?limit=5')).rows?.[2] || (await s.get('/patients?limit=5'))[2];
});
after(async () => { await browser?.close(); await app?.stop(); });

test('command bar: find a patient by a misspelled name and open the chart in 3 actions', async () => {
  const { page } = s;
  const typo = `${patient.last_name.slice(0, 2)}${patient.last_name[3]}${patient.last_name[2]}${patient.last_name.slice(4)}`; // two letters swapped
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type(`${patient.first_name.slice(0, 3)} ${typo}`);
    await page.waitForSelector(`.palette-item:has-text("${patient.last_name}")`).catch(async (e) => { await page.screenshot({ path: '/tmp/claude-0/pal.png' }); throw e; });
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/patients/${patient.id}`));
  });
  console.log(withinBudget('open a patient', r, { actions: 3, ms: 4000 }));
});

test('the active patient follows you: bar on the schedule, Alt+L opens their ledger in 1 action', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');
  assert.match(await page.textContent('.patient-bar'), new RegExp(patient.last_name));
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+l');
    await page.waitForURL(/tab=ledger/);
  });
  console.log(withinBudget('ledger for the active patient', r, { actions: 1, ms: 2000 }));
  // An empty command bar offers the active patient's actions and recent patients.
  await page.keyboard.press(`${MOD}+k`);
  await page.waitForSelector('.palette-item:has-text("Active patient")');
  await page.keyboard.press('Escape');
});

test('? lists the shortcuts, including the ones screens register', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  const text = await page.textContent('.shortcuts');
  assert.match(text, /Active patient/);
  assert.match(text, /Ledger for the active patient/);
  assert.match(text, /Undo the last change/);
  await page.keyboard.press('Escape');
});

test('clearing the active patient removes the bar everywhere', async () => {
  const { page } = s;
  await page.keyboard.press('Alt+x');
  await page.waitForFunction(() => !document.querySelector('.patient-bar'));
  assert.deepEqual(s.errors, []);
});
