// #1 open a patient, #4 glance at their summary, #8 chart findings — on the keyboard, within budget.
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
  const list = await s.get('/patients?limit=10');
  patient = (list.rows || list)[4];
});
after(async () => { await browser?.close(); await app?.stop(); });

test('#1 open a patient by phone number: 3 actions', async () => {
  const { page } = s;
  const digits = patient.phone.replace(/\D/g, '').slice(-4);
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type(digits);
    await page.waitForSelector(`.palette-item:has-text("${patient.last_name}")`);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/patients/${patient.id}`));
  });
  console.log(withinBudget('#1 open a patient', r, { actions: 3, ms: 4000 }));
  // An office alert doesn't block: no dialog opens with the chart.
  assert.equal(await page.locator('.modal').count(), 0);
});

test('#4 the summary is on every screen: 0 actions', async () => {
  const { page } = s;
  const r = await measure(page, async () => {
    await page.goto(`${app.base}/claims`);
    await page.waitForSelector('.patient-bar .pb-name');
  });
  withinBudget('#4 patient summary', r, { actions: 0, ms: 6000 });
  const bar = await page.textContent('.patient-bar');
  assert.match(bar, new RegExp(patient.last_name));
  assert.match(bar, /Balance/);
  assert.match(bar, /Next|No visit booked/);
});

test('#8 chart a finding by typing: 3 actions, and Undo takes it back', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=chart`);
  await page.waitForSelector('.odontogram2');
  const before = (await s.get(`/patients/${patient.id}/chart`)).conditions.length;
  const r = await measure(page, async () => {
    await page.keyboard.type('3');          // any digit on the chart starts an entry
    await page.keyboard.type('0 MO caries');
    await page.waitForSelector('.chart-entry .chip:has-text("#30 MO caries")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Charted #30 MO caries")');
  });
  console.log(withinBudget('#8 chart a finding', r, { actions: 4, ms: 4000 }));
  let chart = await s.get(`/patients/${patient.id}/chart`);
  assert.equal(chart.conditions.length, before + 1);
  assert.ok(chart.conditions.some((c) => c.tooth === '30' && c.surfaces === 'MO' && c.condition === 'caries'));
  // The drawing shows it on #30.
  assert.match(await page.getAttribute('.tooth2[data-tooth="30"]', 'aria-label'), /caries MO/);
  // Undo from the keyboard.
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  chart = await s.get(`/patients/${patient.id}/chart`);
  assert.equal(chart.conditions.length, before);
});

test('#8 several teeth at once, and arrow keys move around the drawing', async () => {
  const { page } = s;
  const r = await measure(page, async () => {
    await page.keyboard.press('e');
    await page.keyboard.type('2-4 sealant plan');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Charted #2 D1351")');
  });
  withinBudget('#8 three sealants', r, { actions: 3, ms: 4000 });
  const planned = (await s.get(`/patients/${patient.id}/chart`)).procedures.filter((p) => p.code === 'D1351' && p.status === 'planned');
  assert.deepEqual(planned.map((p) => p.tooth).sort(), ['2', '3', '4']);
  await page.locator('.tooth2[data-tooth="8"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tooth), '9');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tooth), '24');
  assert.deepEqual(s.errors, []);
});
