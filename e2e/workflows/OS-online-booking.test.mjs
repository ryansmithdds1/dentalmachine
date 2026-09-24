// Online scheduling (docs/workflows/specs/OS-online-scheduling.md): a new patient books from the practice's page in
// at most 5 taps (plus typing their name, birth date and phone), the front desk sees it the moment it happens
// (toast + the Online bookings list, with where it came from), and an emergency with bad pain is booked, flagged
// urgent and called out to the front desk. The page is also checked on a phone-sized screen and in Spanish.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let staff; let slug;

before(async () => {
  app = await startApp();
  browser = await launch();
  staff = await signIn(browser, app.base);
  const practice = await staff.get('/practice');
  slug = practice.slug || 'bright-smiles';
  if (!practice.online_booking || !practice.slug) await staff.api('PUT', '/practice', { online_booking: true, slug });
  const settings = await staff.get('/online-scheduling/settings');
  assert.ok(settings.visit_types, `online scheduling routes are mounted: ${JSON.stringify(settings).slice(0, 200)}`);
  // Emergencies look two weeks ahead here, so the test doesn't depend on how full the demo's next days are.
  const em = settings.visit_types.find((t) => t.kind === 'emergency');
  await staff.api('PUT', `/online-scheduling/visit-types/${em.id}`, { max_days: 14, lead_minutes: 0 });
  // The front desk is looking at the schedule when bookings come in.
  await staff.page.goto(`${app.base}/schedule`);
  await staff.page.waitForSelector('.sidebar');
});
after(async () => { await browser?.close(); await app?.stop(); });

async function patientPage(query = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: false });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await trackActions(page);
  await page.goto(`${app.base}/book/${slug}${query}`);
  await page.waitForSelector('.os-type');
  return { ctx, page, errors };
}
// Waits for the confirmation; a message on the form instead fails with what it said.
async function booked(page) {
  await page.waitForSelector('.os-done, form .error');
  const err = (await page.locator('form .error').count()) ? await page.locator('form .error').textContent() : null;
  assert.equal(err, null, `the booking was refused: ${err}`);
}
const uniq = () => Math.random().toString(36).slice(2, 7).replace(/\d/g, 'x');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

test('a new patient books online in at most 5 taps, and the front desk sees it straight away', async () => {
  const { ctx, page, errors } = await patientPage('?src=google&utm_campaign=fall');
  const last = `Newpt${cap(uniq())}`;
  const result = await measure(page, async () => {
    await page.locator('.os-type.kind-new_patient').click();
    await page.locator('.os-slot').first().click();
    // The first name box already has the focus: type, Tab to the next box, and so on.
    await page.keyboard.type('Nora');
    await page.keyboard.press('Tab');
    await page.keyboard.type(last);
    await page.keyboard.press('Tab');
    await page.keyboard.type('04121990');
    await page.keyboard.press('Tab');
    await page.keyboard.type('5125550188');
    await page.locator('.os-submit').click();
    await booked(page);
  });
  const detail = withinBudget('OS new patient books online', result, { actions: 11, ms: 8000 });
  assert.ok(result.clicks <= 5, `taps: ${detail}`);
  const done = await page.textContent('.public-main');
  assert.match(done, /You’re booked!|Request received/);
  assert.match(done, /Nora/);
  assert.deepEqual(errors, []);

  // The front desk: a toast on whatever screen they're on, then the Online bookings list with the source.
  await staff.page.waitForSelector(`.toast:has-text("${last}")`, { timeout: 10_000 });
  const toastText = await staff.page.textContent(`.toast:has-text("${last}")`);
  assert.match(toastText, /New patient/);
  await staff.page.goto(`${app.base}/requests?tab=online`);
  const row = staff.page.locator('table.online-bookings tr', { hasText: last });
  await row.waitFor();
  assert.match(await row.textContent(), /Google/);
  assert.match(await row.textContent(), /fall/);
  await row.getByRole('button', { name: 'Seen' }).click();
  await staff.page.waitForSelector(`table.online-bookings tr:has-text("${last}") >> text=Seen`);
  // It's on the schedule, marked as booked online.
  const appts = await staff.get(`/patients?q=${last}`);
  assert.equal(appts.rows?.length ?? appts.length, 1);
  await ctx.close();
});

test('emergency: triage questions, urgent flag, and the front desk is told to call', async () => {
  const { ctx, page, errors } = await patientPage();
  const last = `Ouch${cap(uniq())}`;
  await page.locator('.os-type.kind-emergency').click();
  await page.waitForSelector('.os-warn');
  assert.match(await page.textContent('.os-warn'), /911/);
  await page.locator('.os-slot').first().click();
  await page.keyboard.type('Eli');
  await page.keyboard.press('Tab');
  await page.keyboard.type(last);
  await page.keyboard.press('Tab');
  await page.keyboard.type('07071985');
  await page.keyboard.press('Tab');
  await page.keyboard.type('5125550177');
  // Pain 9, swelling yes, injury no.
  await page.locator('.os-q').nth(0).getByRole('button', { name: '9', exact: true }).click();
  await page.locator('.os-q').nth(1).getByRole('button', { name: 'Yes' }).click();
  await page.locator('.os-q').nth(2).getByRole('button', { name: 'No' }).click();
  await page.locator('.os-submit').click();
  await booked(page);
  assert.match(await page.textContent('.os-done'), /call you shortly/);
  assert.deepEqual(errors, []);

  await staff.page.goto(`${app.base}/schedule`);
  await staff.page.waitForSelector('.sidebar');
  await staff.page.goto(`${app.base}/requests?tab=online`);
  const row = staff.page.locator('table.online-bookings tr', { hasText: last });
  await row.waitFor();
  const text = await row.textContent();
  assert.match(text, /Urgent/);
  assert.match(text, /pain: 9/);
  const tasks = await staff.get('/tasks?status=open');
  assert.ok((tasks.rows || tasks).some((t) => t.title.includes(last) && t.priority === 'high'), 'a high-priority call task');
  await ctx.close();
});

test('the page works in Spanish and inside a website (embed)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${app.base}/book/${slug}?lang=es&embed=1`);
  await page.waitForSelector('.os-type');
  assert.match(await page.textContent('.public-main'), /¿Qué necesita\?/);
  // The loader for the practice's website, and the booking page is allowed inside a frame.
  const js = await page.request.get(`${app.base}/embed.js`);
  assert.equal(js.status(), 200);
  assert.match(await js.text(), /DentalMachineBooking/);
  const framed = await page.request.get(`${app.base}/book/${slug}?embed=1`);
  assert.equal(framed.headers()['x-frame-options'], undefined);
  assert.match(framed.headers()['content-security-policy'] || '', /frame-ancestors \*/);
  await page.setContent(`<html><body><h1>Smiles</h1><script src="${app.base}/embed.js" data-practice="${slug}"></script></body></html>`);
  await page.getByRole('button', { name: 'Book online' }).click();
  const frame = page.frameLocator('iframe[title="Book online"]');
  await frame.locator('.os-type').first().waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.querySelector('[role=dialog]').parentElement.style.display), 'none');
  await ctx.close();
});
