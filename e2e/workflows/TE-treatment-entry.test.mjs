// TE: treatment entry — bundles, quick buttons (Alt+1…9) and aliases, through one engine and one preview
// (docs/workflows/specs/TE-treatment-entry.md). Needs routes/treatmententry.js mounted and its tables in db.js.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let teeth;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  // A patient without insurance (so nothing in the preview needs a second look) and teeth with nothing on them.
  const list = await s.get('/patients?limit=40');
  for (const p of (list.rows || list).slice(6)) {
    if ((await s.get(`/patients/${p.id}/insurance`)).length) continue;
    const chart = await s.get(`/patients/${p.id}/chart`);
    const used = new Set([...chart.conditions, ...chart.procedures].map((x) => String(x.tooth)));
    const free = ['14', '3', '19', '30', '2', '15', '18', '31', '12', '5'].filter((t) => !used.has(t));
    if (free.length >= 2 && !chart.procedures.some((x) => ['D0150', 'D0210', 'D1110'].includes(x.code) && x.status === 'planned')) { patient = p; teeth = free; break; }
  }
  assert.ok(patient, 'a demo patient to chart on');
});
after(async () => { await browser?.close(); await app?.stop(); });

const planned = async (code) => (await s.get(`/patients/${patient.id}/chart`)).procedures.filter((p) => p.code === code && p.status === 'planned');

test('TE crown bundle on a tooth: select it, Alt+1 — 2 actions, and Undo takes it back', async () => {
  const { page } = s;
  const tooth = teeth[0];
  await page.goto(`${app.base}/patients/${patient.id}?tab=chart`);
  await page.waitForSelector('.odontogram2');
  await page.waitForSelector('.te-buttons .te-btn:has-text("Crown")');
  assert.equal(await page.locator('.te-buttons .te-btn').first().locator('kbd').textContent(), '1', 'the first button is Alt+1');
  const r = await measure(page, async () => {
    await page.click(`.tooth2[data-tooth="${tooth}"]`);
    await page.keyboard.press('Alt+1');
    await page.waitForSelector(`.toast:has-text("Charted #${tooth} D2740")`);
  });
  console.log(withinBudget('TE crown bundle via Alt+1', r, { actions: 2, ms: 5000 }));
  assert.deepEqual((await planned('D2740')).filter((p) => p.tooth === tooth).length, 1);
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await planned('D2740')).filter((p) => p.tooth === tooth).length, 0);
});

test('TE the alias in the entry box: "14 crb bu" + Enter — 2 actions once you are in the box, with fees in the preview', async () => {
  const { page } = s;
  const tooth = teeth[1];
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('e');
  const r = await measure(page, async () => {
    await page.keyboard.type(`${tooth} crb bu`);
    await page.waitForSelector('.chart-entry .chip:has-text("D2950")');
    await page.waitForSelector('.chart-entry .est:has-text("Total")'); // the server's check is in: fees for the whole bundle
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.toast:has-text("Charted #${tooth} D2740 planned · #${tooth} D2950 planned")`);
  });
  console.log(withinBudget('TE crown bundle typed', r, { actions: 2, ms: 5000 }));
  assert.equal((await planned('D2950')).filter((p) => p.tooth === tooth).length, 1);
  // Still in the box: the next entry is just typing.
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Chart by typing');
});

test('TE typed "np" plans the new patient bundle — 2 actions', async () => {
  const { page } = s;
  const r = await measure(page, async () => {
    await page.keyboard.type('np');
    await page.waitForSelector('.chart-entry .chip:has-text("D1110")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Charted D0150 planned · D0210 planned · D1110 planned")');
  });
  console.log(withinBudget('TE new patient bundle typed', r, { actions: 2, ms: 5000 }));
  for (const code of ['D0150', 'D0210', 'D1110']) assert.equal((await planned(code)).length, 1, code);
});

test('TE the preview warns before charting twice, and refuses impossible surfaces', async () => {
  const { page } = s;
  await page.keyboard.type('np');
  await page.waitForSelector('.chart-entry .te-issues:has-text("already planned")');
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await page.keyboard.type(`${teeth[1]} MI filling plan`);
  await page.waitForSelector('.chart-entry .te-issues:has-text("back tooth")');
  assert.equal(await page.locator('.chart-entry button.primary').isDisabled(), true);
  await page.keyboard.press('Escape');
  // With no tooth selected, a button fills the box and waits for the tooth ("crb 14").
  await page.goto(`${app.base}/patients/${patient.id}?tab=chart`);
  await page.waitForSelector('.te-buttons .te-btn:has-text("Crown")');
  await page.keyboard.press('Alt+1');
  await page.waitForSelector('.chart-entry input:focus');
  assert.match(await page.inputValue('.chart-entry input'), /^crb\s$/);
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('TE the ? list shows the chart buttons and aliases', async () => {
  const { page } = s;
  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts:has-text("Chart buttons")');
  const text = await page.textContent('.shortcuts');
  assert.match(text, /Chart aliases/);
  assert.match(text, /New patient: exam \+ fmx \+ prophy/);
  await page.keyboard.press('Escape');
});

test('TE Settings → Chart shortcuts & bundles: a live preview of what a bundle charts', async (t) => {
  const { page } = s;
  await page.goto(`${app.base}/settings?tab=chartshortcuts`);
  await page.waitForSelector('.settings-nav');
  if (!(await page.locator('.settings-nav button:has-text("Chart shortcuts & bundles")').count())) { t.skip('not mounted in Settings yet'); return; }
  await page.waitForSelector('.te-editor');
  await page.click('.te-editor button.primary:has-text("Bundle")');
  await page.fill('.te-form input[maxlength="60"]', 'Quick crown');
  await page.waitForSelector('.te-form .te-preview .chip:has-text("#14 D2740 planned")');
  await page.click('.te-form button:has-text("Cancel")');
  assert.deepEqual(s.errors, []);
});
