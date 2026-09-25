// Nightly journey — the front desk (Jordan, frontdesk@demo): a new patient with insurance, booked, confirmed,
// checked in, pays; a later visit is moved and then cancelled. Driven through the screens, checked on the server.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey, addDays } from './lib.mjs';

const j = journey('frontdesk', 'frontdesk@demo.dentalmachine.app');
const last = `Journey${Date.now().toString(36)}`;
let patientId; let visitToday; let later; let DAY;

test('new patient with insurance', async () => {
  const { page } = j;
  await j.step('new patient', async () => {
    await j.goto('/patients?new=1', '.modal', { keep: true });
    await page.getByLabel('First name *').fill('Fran');
    await page.getByLabel('Last name *').fill(last);
    await page.getByLabel('Date of birth').fill('1986-05-14');
    await page.getByLabel('Mobile phone (texts go here)').fill(`(512) 555-${String(Date.now() % 10000).padStart(4, '0')}`);
    await page.locator('.modal button.primary').click();
    await page.waitForURL(/\/patients\/\d+/);
  });
  patientId = Number(page.url().match(/patients\/(\d+)/)[1]);
  await j.step('insurance', async () => {
    await j.goto(`/patients/${patientId}?tab=insurance`, 'text=+ Type it in');
    await page.click('text=+ Type it in');
    await page.locator('.modal label:has-text("Carrier *") select').selectOption({ index: 1 });
    await page.getByLabel('Subscriber name *').fill(`Fran ${last}`);
    await page.getByLabel('Member ID *').fill('JRN12345');
    await page.locator('.modal button.primary').click();
    await page.waitForSelector('.modal', { state: 'detached' });
  });
  assert.equal((await j.s.get(`/patients/${patientId}/insurance`)).length, 1);
  await j.healthy('patient chart');
});

async function book(date, time) {
  const { page } = j;
  await j.goto(`/schedule?book=${patientId}`, '.book-panel', { keep: true });
  const modal = page.locator('.book-panel');
  const type = modal.locator('label:has-text("Appointment type") select');
  const cleaning = await type.locator('option').filter({ hasText: /cleaning|exam/i }).first().getAttribute('value');
  if (cleaning) await type.selectOption(cleaning);
  await modal.getByLabel('Date', { exact: true }).fill(date);
  await modal.getByLabel('Start time').fill(time);
  const provider = modal.locator('label:has-text("Provider") select').first();
  if (!(await provider.inputValue())) await provider.selectOption({ index: 1 });
  await modal.locator('.form-actions button.primary').click();
  const anyway = page.locator('.book-panel button:has-text("Book it anyway")');
  await Promise.race([anyway.waitFor().then(() => anyway.click()), page.waitForSelector('.book-panel', { state: 'detached' })]).catch(() => {});
  await page.waitForSelector('.book-panel', { state: 'detached' });
}

test('book today and a visit later on', async () => {
  DAY = addDays(j.today, 150);
  while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 2) DAY = addDays(DAY, 1); // a quiet Tuesday
  // Late in the day so it's still ahead of "now" whenever this runs (the unconfirmed list leaves out visits
  // that have started); "Book it anyway" covers it being after hours.
  await j.step('book today', () => book(j.today, '22:30'));
  await j.step('book later', () => book(DAY, '10:00'));
  const visits = await j.s.get(`/appointments?patient_id=${patientId}&from=${j.today}&to=${addDays(DAY, 1)}`);
  visitToday = visits.find((v) => v.start_time.startsWith(j.today));
  later = visits.find((v) => v.start_time.startsWith(DAY));
  assert.ok(visitToday && later, JSON.stringify(visits));
});

test('confirm from the unconfirmed list', async () => {
  const { page } = j;
  await j.step('confirm', async () => {
    await j.goto(`/schedule?date=${j.today}&view=day`, '.cal-col-head');
    await page.click('.unconfirmed-link');
    const row = page.locator(`tr[data-appt-id="${visitToday.id}"]`);
    await row.waitFor();
    await row.locator('button:has-text("Confirmed")').click();
    await row.waitFor({ state: 'detached' });
  });
  await j.until(async () => (await j.s.get(`/appointments/${visitToday.id}`)).status === 'confirmed', 'the confirmation');
  await j.healthy('unconfirmed list');
});

test('check in from the schedule', async () => {
  const { page } = j;
  await j.step('check in', async () => {
    await j.goto(`/schedule?date=${j.today}`, '.cal-col-head');
    await page.locator('.cal-appt', { hasText: last }).first().click();
    await page.locator('.drawer button:has-text("Check in")').first().click();
  });
  await j.until(async () => ['checked_in', 'arrived'].includes((await j.s.get(`/appointments/${visitToday.id}`)).status), 'checked in');
});

test('take a payment', async () => {
  const { page } = j;
  const before = (await j.s.get(`/patients/${patientId}/ledger`)).entries.filter((e) => e.type === 'payment').length;
  await j.step('payment', async () => {
    await j.goto(`/patients/${patientId}?tab=ledger&pay=1`, '.inline-panel[aria-label="Take payment"]');
    await page.fill('[aria-label="Payment amount"]', '25.00');
    const method = page.locator('.inline-panel[aria-label="Take payment"] select').first();
    if (await method.count()) await method.selectOption('cash').catch(() => {});
    await page.locator('.inline-panel[aria-label="Take payment"] button.primary').click();
    await page.waitForSelector('.inline-panel[aria-label="Take payment"]', { state: 'detached' });
  });
  const paid = (await j.s.get(`/patients/${patientId}/ledger`)).entries.filter((e) => e.type === 'payment');
  assert.equal(paid.length, before + 1, 'one payment posted');
  assert.equal(-paid.at(-1).amount, 2500);
  await j.healthy('ledger');
});

test('reschedule the later visit, then handle its cancellation', async () => {
  const { page } = j;
  const card = `.cal [data-appt-id="${later.id}"]`;
  await j.step('reschedule', async () => {
    await j.goto(`/schedule?date=${DAY}&view=day`, card);
    await page.focus(card);
    await page.keyboard.press('m');
    await page.waitForSelector('.cal-ghost.carry');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast-undo');
  });
  await j.until(async () => (await j.s.get(`/appointments/${later.id}`)).start_time !== later.start_time, 'the move');
  await j.step('cancel', async () => {
    await page.waitForSelector(`${card}:not(.pending)`);
    await page.focus(card);
    await page.keyboard.press('x');
    await page.waitForSelector('.broken-picker');
    await page.keyboard.press('2');
    await page.waitForSelector('.rebook-bar'); // offered a new time on the schedule; they'll call back instead
    await page.waitForFunction(() => document.activeElement?.closest('.rebook-bar'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rebook-bar', { state: 'detached' });
  });
  const cancelled = await j.s.get(`/appointments/${later.id}`);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.broken_reason, 'with a reason');
  await j.healthy('schedule');
});
