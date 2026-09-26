// Treatment plans presented on a screen and followed through (spec: docs/workflows/specs/22-present-treatment.md,
// "Where the plan stands"): the patient's plan fills a computer screen with the mouth beside the costs, a
// procedure and its tooth light up together, Print gives a compact document; staff note "Going home to discuss"
// with a follow-up date in ≤ 3 actions, and the plan's status follows the work — scheduled, in progress, completed,
// paid — without anyone setting it. Notes never reach the patient's page.
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let plan;
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base, { viewport: { width: 1920, height: 1080 } });
  await trackActions(s.page);
  patient = await s.post('/patients', { first_name: 'Nora', last_name: 'Statusley', dob: '1981-07-09', phone: '(512) 555-0161', email: 'nora@example.com' });
  const dentist = (await s.get('/providers')).find((p) => p.type === 'dentist');
  plan = await s.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crown and filling', procedures: [{ code: 'D2740', tooth: '19', provider_id: dentist.id }, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: dentist.id }] });
  assert.ok(plan.id, JSON.stringify(plan));
});
after(async () => { await browser?.close(); await app?.stop(); });

const card = () => s.page.locator(`.card[data-plan="${plan.id}"]`);
const openTreatment = async () => {
  await s.page.goto(`${app.base}/patients/${patient.id}?tab=treatment`);
  await card().waitFor();
};
const stage = async () => (await card().locator('.plan-stage').first().getAttribute('data-stage'));

test('presented on a monitor: fills the screen, chart beside the costs, tooth ↔ procedure highlight, print layout', async () => {
  const { page } = s;
  await openTreatment();
  await card().locator('button:has-text("Present here for Nora to sign")').click();
  await page.waitForSelector('h1:has-text("Your treatment plan, Nora")');
  // Not a narrow column: the plan uses the width of a 1920 screen, with the drawing and the costs side by side.
  const main = await page.locator('.public-main').boundingBox();
  assert.ok(main.width > 1500, `main is ${main.width}px wide`);
  const chart = await page.locator('.cp-visual').boundingBox();
  const costs = await page.locator('.cp-details').boundingBox();
  assert.ok(chart.x + chart.width <= costs.x + 1 && Math.abs(chart.y - costs.y) < 40, 'chart left, costs right');
  assert.equal(await page.locator('.plan-chart .pc-tooth.on').count(), 2);
  assert.equal(await page.locator('.cp-line .pc-thumb').count(), 2, 'a small tooth beside each procedure');
  // Pointing at the crown lights up #19 on the drawing, and pointing at #30 lights up the filling.
  await page.locator('.cp-line[data-tooth="19"]').hover();
  await page.waitForSelector('.pc-tooth.active[data-tooth="19"]');
  await page.locator('.pc-tooth[data-tooth="30"]').hover();
  await page.waitForSelector('.cp-line.hl[data-tooth="30"]');
  // Keyboard: the teeth in the plan are buttons with plain labels.
  assert.match(await page.locator('.pc-tooth[data-tooth="19"]').getAttribute('aria-label'), /Tooth #19: Crown/);
  // Print and Download PDF are there; printing shows the compact document and hides the screen-only parts.
  await page.waitForSelector('.public-title-actions button:has-text("Print")');
  assert.match(await page.locator('.public-title-actions a:has-text("Download PDF")').getAttribute('href'), /\/api\/public\/tp\/.+\/pdf/);
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.cp-print-doc').isVisible(), true);
  assert.equal(await page.locator('.cp-accept').isVisible(), false);
  assert.equal(await page.locator('.public-title-actions').isVisible(), false);
  assert.equal(await page.locator('.cp-print-table tbody tr').count(), 2);
  const pdf = await page.pdf({ format: 'Letter' });
  assert.ok(pdf.length > 10_000);
  await page.emulateMedia({ media: 'screen' });
  // A phone gets one column.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(narrow <= 390, `no sideways scroll on a phone (${narrow})`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  assert.deepEqual(s.errors, []);
});

test('a note with a chip, a follow-up date and "thinking it over": ≤ 3 actions, never on the patient page', async () => {
  const { page } = s;
  await openTreatment();
  assert.equal(await stage(), 'presented');
  const r = await measure(page, async () => {
    await card().locator('.plan-notes-toggle').click();
    await card().locator('.plan-notes .chip:has-text("Going home to discuss")').click();
    // Picking it ticks "Thinking it over" and suggests a follow-up a week out (smart defaults, changeable).
    assert.equal(await card().locator('.plan-notes label:has-text("Thinking it over") input').isChecked(), true);
    const tz = (await s.get('/practice')).timezone || 'America/New_York';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    assert.equal(await card().locator('.plan-notes input[type=date]').inputValue(), new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400_000).toISOString().slice(0, 10));
    await card().locator('.plan-notes button:has-text("Save note")').click();
    await page.waitForSelector('.toast:has-text("Note saved")');
  });
  console.log(withinBudget('TP note + follow-up + thinking it over', r, { actions: 3 }));
  await card().locator('.plan-stage[data-stage="thinking"]').waitFor();
  await card().locator('.plan-followup:has-text("Follow up")').waitFor();
  await card().locator('.plan-notes-latest:has-text("Going home to discuss")').waitFor();
  // The patient header shows it on every tab.
  await page.locator('.plan-status-chip .plan-stage[data-stage="thinking"]').waitFor();
  // The office's list of plans in process.
  await page.goto(`${app.base}/followups?tab=plans`);
  const row = page.locator(`tr[data-plan="${plan.id}"]`);
  await row.waitFor();
  assert.match(await row.textContent(), /Thinking it over.*Going home to discuss/);
  // Not on the patient's page.
  const link = await s.post(`/treatment-plans/${plan.id}/present`, { here: true });
  await page.goto(`${app.base}${new URL(link.url).pathname}#here=${encodeURIComponent(link.handoff)}`);
  await page.waitForSelector('h1:has-text("Your treatment plan, Nora")');
  assert.ok(!(await page.textContent('body')).includes('Going home to discuss'));
  assert.deepEqual(s.errors, []);
});

test('status follows the work: scheduled → in progress → completed with a balance → paid in full', async () => {
  const { page } = s;
  const [crown, filling] = (await s.get(`/patients/${patient.id}/treatment-plans`)).find((p) => p.id === plan.id).procedures;
  const providers = await s.get('/providers');
  // A free hour on a quiet day well ahead (the demo schedule is busy this week).
  let appt;
  for (let d = 40; d < 60 && !appt?.id; d++) {
    appt = await s.post('/appointments', { patient_id: patient.id, provider_id: providers.at(-1).id, start_time: `${day(d)} 07:00`, end_time: `${day(d)} 08:00`, procedure_ids: [crown.id, filling.id], override_blockout: true });
  }
  assert.ok(appt.id, JSON.stringify(appt));
  await openTreatment();
  assert.equal(await stage(), 'scheduled');
  assert.equal((await s.post(`/procedures/${crown.id}/complete`)).status, 'completed');
  await openTreatment();
  assert.equal(await stage(), 'in_progress');
  await card().locator('.plan-balance.owed').waitFor();
  assert.equal((await s.post(`/procedures/${filling.id}/complete`)).status, 'completed');
  await openTreatment();
  assert.equal(await stage(), 'completed');
  const owed = (await s.get(`/patients/${patient.id}/treatment-plans`)).find((p) => p.id === plan.id).progress.balance;
  await s.post(`/patients/${patient.id}/payments`, { amount: owed, method: 'cash' });
  await openTreatment();
  assert.equal(await stage(), 'paid');
  await card().locator('.plan-balance.paid:has-text("Paid in full")').waitFor();
  assert.equal(await page.locator('.plan-status-chip').count(), 0, 'nothing in process any more');
  assert.deepEqual(s.errors, []);
});
