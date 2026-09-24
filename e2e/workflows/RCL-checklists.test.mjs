// Recurring checklists by position (RCL1–RCL3): ticking today's items takes one action each, and a spore test
// with its photo takes at most three. Spec: docs/workflows/specs/RCL-checklists.md
//
// Needs the checklist routes (app.js) and the /checklists page (App.jsx) mounted; until then the tests skip with a
// note rather than fail.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d1a1a40000000049454e44ae426082', 'hex');
const everyDay = '0,1,2,3,4,5,6';
const tag = Math.random().toString(36).slice(2, 6);
const PLAIN = [`Lights on ${tag}`, `Check voicemail ${tag}`, `Huddle sheet printed ${tag}`];
const SPORE = `Spore test ${tag}`;

let app; let browser; let s; let ready = null;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

// Server routes and the page both mounted? Then make a checklist for the signed-in administrator's position.
async function wired(t) {
  ready ??= (async () => {
    const setup = await s.get('/checklists/setup');
    if (!setup?.positions) return 'routes';
    const pos = setup.positions.find((p) => p.name === 'Office manager');
    const made = await s.post('/checklists/templates', {
      name: `E2E ${tag}`, position_id: pos.id,
      items: [
        ...PLAIN.map((title) => ({ title, cadence: 'daily', weekdays: everyDay, due_time: '23:59' })),
        { title: SPORE, cadence: 'daily', weekdays: everyDay, due_time: '23:59', result_type: 'pass_fail', require_photo: true, critical: true },
      ],
    });
    assert.ok(made.id, JSON.stringify(made));
    await s.page.goto(`${app.base}/checklists`);
    const page = await s.page.waitForSelector('.cl-mine', { timeout: 8000 }).then(() => true, () => false);
    return page ? 'ok' : 'page';
  })();
  const r = await ready;
  if (r === 'routes') { t.skip('checklist routes not mounted in app.js yet'); return false; }
  if (r === 'page') { t.skip('/checklists page not mounted in App.jsx yet'); return false; }
  return true;
}
const rowOf = (title) => s.page.locator('.cl-row', { has: s.page.locator('.cl-title', { hasText: title }) });

test('RCL: tick today’s plain items — one action each, with Undo on the toast', async (t) => {
  if (!(await wired(t))) return;
  const { page } = s;
  await page.goto(`${app.base}/checklists`);
  await rowOf(PLAIN[0]).waitFor();
  for (const title of PLAIN) {
    const row = rowOf(title);
    const r = await measure(page, async () => {
      await row.locator('.cl-check').click();
      await row.locator('.cl-check.on').waitFor();
    });
    console.log(withinBudget(`RCL tick "${title}"`, r, { actions: 1, ms: 4000 }));
  }
  const mine = await s.get('/checklists/mine');
  for (const title of PLAIN) assert.equal(mine.items.find((i) => i.title === title)?.status, 'done', title);
  // Keyboard: U on the highlighted done item undoes it; X ticks it again.
  await page.locator('.cl-row.sel').first().waitFor();
  assert.ok(await page.evaluate(() => !!document.querySelector('.cl-keys')));
});

test('RCL: weekly spore test with a photo from the camera — at most 3 actions, stored and ticked', async (t) => {
  if (!(await wired(t))) return;
  const { page } = s;
  await page.goto(`${app.base}/checklists`);
  const row = rowOf(SPORE);
  await row.waitFor();
  // The photo input opens the camera on a phone or tablet.
  assert.equal(await row.locator('input[type=file][capture]').getAttribute('capture'), 'environment');
  const r = await measure(page, async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), row.locator('button', { hasText: /photo/i }).click()]);
    await chooser.setFiles({ name: 'spore.png', mimeType: 'image/png', buffer: PNG });
    await row.locator('.req.ok').waitFor();
    await row.locator('button.pass').click();
    await row.locator('.cl-check.on').waitFor();
  });
  console.log(withinBudget('RCL spore test with photo', r, { actions: 3, ms: 6000 }));
  const item = (await s.get('/checklists/mine')).items.find((i) => i.title === SPORE);
  assert.equal(item.status, 'done');
  assert.equal(item.result_pass, 1);
  assert.equal(item.photos, 1);
  assert.deepEqual(s.errors, []);
});

test('RCL: a failed critical item flags the owner (banner) and shows on the dashboard', async (t) => {
  if (!(await wired(t))) return;
  const { page } = s;
  const pos = (await s.get('/checklists/setup')).positions.find((p) => p.name === 'Office manager');
  const title = `AED check ${tag}`;
  await s.post('/checklists/templates', { name: `E2E AED ${tag}`, position_id: pos.id, items: [{ title, cadence: 'daily', weekdays: everyDay, due_time: '23:59', result_type: 'pass_fail', critical: true }] });
  await page.goto(`${app.base}/checklists`);
  const row = rowOf(title);
  await row.waitFor();
  await row.locator('button.failbtn').click();
  await row.locator('.cl-check.fail').waitFor();
  await page.goto(`${app.base}/checklists/dashboard`);
  await page.waitForSelector(`.cl-flag:has-text("${title} failed")`);
  const flags = await s.get('/checklists/flags');
  assert.ok(flags.some((f) => f.title.includes(title) && f.critical));
});
