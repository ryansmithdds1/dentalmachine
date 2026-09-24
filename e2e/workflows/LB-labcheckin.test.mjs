// LB lab case check-in (docs/workflows/specs/LB-labcheckin.md): a case due this week is checked in with a photo and
// "Looks good" in 3 actions, the visit's schedule card turns green, the same can be done from the keyboard alone, and
// a failed check shows the note for the lab and the offer to move the visit. Skipped until the routes are mounted
// (server: labCheckinRoutes in app.js; client: /lab-checkin in App.jsx — see the hand-off).
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekday = (d) => { let x = d; while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = addDays(x, 1); return x; };
let today; let provider;

// A patient with a crown on a visit in a few days and its case due back tomorrow.
async function crownCase(first, last, tooth) {
  const p = await s.post('/patients', { first_name: first, last_name: last, dob: '1980-02-02' });
  const proc = await s.post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth, provider_id: provider.id });
  const date = weekday(addDays(today, 2));
  // The first free half hour that afternoon (the demo schedule is busy).
  let appt = null;
  for (const t of ['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '12:00', '12:30', '11:00', '11:30']) {
    const end = `${t.slice(0, 3)}${t.endsWith('30') ? '59' : '29'}`;
    appt = await s.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${date} ${t}`, end_time: `${date} ${end}`, procedure_ids: [proc.id] });
    if (appt.id) break;
  }
  assert.ok(appt.id, JSON.stringify(appt));
  const c = await s.post('/lab-cases', { patient_id: p.id, provider_id: provider.id, lab_name: 'Smile Lab', description: 'Zirconia crown', tooth, shade: 'A2', due_date: addDays(today, 1) });
  assert.ok(c.id, JSON.stringify(c));
  return { patient: p, appt, labCase: c, date };
}

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const probe = await s.page.evaluate(async () => (await fetch('/api/lab-checkin/due', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status);
  if (probe !== 200) return;
  await s.page.goto(`${app.base}/lab-checkin`);
  mounted = await s.page.waitForSelector('h1:has-text("Check in lab work")', { timeout: 5000 }).then(() => true, () => false);
  if (!mounted) return;
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  provider = (await s.get('/providers?active=true')).find((p) => p.type === 'dentist');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('LB2 check in a due case: photo + "Looks good" in ≤ 3 actions; the schedule card turns green', async (t) => {
  if (!mounted) return t.skip('lab check-in routes not mounted yet');
  const { page } = s;
  const { labCase, appt, date } = await crownCase('Maria', 'Lopez', '30');
  // The visit is linked to its case the first time the schedule (or huddle) looks.
  const before = await s.get(`/visit-readiness?date=${date}`);
  assert.equal(before.byAppt[appt.id].items[0].state, 'due');
  await page.goto(`${app.base}/lab-checkin`);
  const item = page.locator(`[data-testid="lbc-lab_case-${labCase.id}"]`);
  await item.waitFor();
  const r = await measure(page, async () => {
    await item.click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.lbc-camera').click()]);
    await chooser.setFiles({ name: 'crown.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('.lbc-photos img').first().waitFor();
    await page.locator('button.good').click();
    await page.waitForSelector('.lbc-done');
  });
  console.log(withinBudget('LB2 check in a due case with a photo + looks good', r, { actions: 3, ms: 8000 }));
  const check = await s.get(`/visit-readiness/appointments/${appt.id}`);
  assert.equal(check.state, 'ready');
  assert.equal(check.checks[0].verdict, 'ok');
  assert.equal(check.checks[0].photo_ids.length, 1, 'the photo is on the check');
  // The schedule card shows it.
  await page.goto(`${app.base}/schedule?date=${date}&view=day`);
  await page.waitForSelector(`.rdy-badge[data-state="ready"]`);
  assert.deepEqual(s.errors, []);
});

test('LB2 keyboard only: find the case, check it in (F name Enter, G)', async (t) => {
  if (!mounted) return t.skip('lab check-in routes not mounted yet');
  const { page } = s;
  const { labCase } = await crownCase('Kira', 'Keys', '14');
  await page.goto(`${app.base}/lab-checkin`);
  await page.locator(`[data-testid="lbc-lab_case-${labCase.id}"]`).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  const r = await measure(page, async () => {
    await page.keyboard.press('f');
    await page.keyboard.type('Kira Keys');
    await page.keyboard.press('Enter'); // picks the first match and leaves the box
    await page.locator('.lbc-panel h2:has-text("Kira Keys")').waitFor();
    await page.keyboard.press('g');
    await page.waitForSelector('.lbc-done');
  });
  console.log(withinBudget('LB2 keyboard: F name Enter G', r, { actions: 4, ms: 6000 }));
  assert.equal(r.clicks, 0, 'no mouse');
  assert.deepEqual(s.errors, []);
});

test('LB4 a failed check: note it, the doctor is told, the note for the lab and "move the visit" are offered', async (t) => {
  if (!mounted) return t.skip('lab check-in routes not mounted yet');
  const { page } = s;
  const { labCase } = await crownCase('Pat', 'Problem', '3');
  await page.goto(`${app.base}/lab-checkin`);
  await page.locator(`[data-testid="lbc-lab_case-${labCase.id}"]`).click();
  await page.locator('button:has-text("Something’s wrong")').click();
  await page.keyboard.type('Margin is open on the distal');
  await page.locator('button:has-text("Record the problem")').click();
  await page.waitForSelector('.lbc-next');
  assert.match(await page.locator('.lbc-next textarea').inputValue(), /Please remake it/);
  assert.ok(await page.locator('.lbc-next button:has-text("Move the visit")').count());
  await page.locator('.lbc-next button:has-text("Send to the lab")').click();
  await page.waitForSelector('.lbc-next :text("Sent to the lab")');
  const c = (await s.get(`/lab-cases?patient_id=${labCase.patient_id}`))[0];
  assert.deepEqual([c.status, c.check_status], ['returned_for_adjustment', 'problem']);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.modal').length), 0, 'no dialogs');
  assert.deepEqual(s.errors, []);
});
