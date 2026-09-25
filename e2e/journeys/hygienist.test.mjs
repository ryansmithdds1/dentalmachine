// Nightly journey — the hygienist (Sam, sam@demo): a full-mouth perio chart on the keyboard, saved, then the
// patient's next hygiene (recall) visit booked from the chart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey, addDays } from './lib.mjs';

const j = journey('hygienist', 'sam@demo.dentalmachine.app');
let patient;

test('perio chart', async () => {
  const { page } = j;
  patient = await j.s.post('/patients', { first_name: 'Hana', last_name: `Perio${Date.now() % 100000}`, dob: '1975-03-03', phone: '(512) 555-0177' });
  assert.ok(patient.id, JSON.stringify(patient));
  await j.step('readings', async () => {
    await j.goto(`/patients/${patient.id}?tab=perio`, '.perio-table');
    await page.locator('.chart-toolbar button:has-text("Depths")').click();
    for (const d of '324535323434') await page.keyboard.type(d); // teeth 1 and 2, both sides' first row
    await page.keyboard.type('b');
    await page.locator('.page-header button.primary:has-text("Save exam")').click();
    await page.waitForSelector('.page-header :text("Perio exam")');
  });
  const [exam] = await j.s.get(`/patients/${patient.id}/perio`);
  assert.deepEqual(exam.readings['1'].pd.slice(0, 3), [3, 2, 4]);
  assert.ok(exam.readings['2'].pd.some((v) => v === 5), 'the second tooth too');
  await j.healthy('perio');
});

test('recall visit booked from the chart', async () => {
  const { page } = j;
  await j.step('book', async () => {
    await j.goto(`/patients/${patient.id}?tab=overview`, 'h1');
    await page.keyboard.press('Alt+b'); // book the active patient's next visit
    await page.waitForSelector('.book-panel .book-suggest strong');
    const type = page.locator('.book-panel label:has-text("Appointment type") select');
    if (await type.count()) {
      const recall = await type.locator('option').filter({ hasText: /recall|cleaning|prophy|hygiene/i }).first().getAttribute('value').catch(() => null);
      if (recall) await type.selectOption(recall);
    }
    await page.locator('.book-panel .form-actions button.primary').click();
    const anyway = page.locator('.book-panel button:has-text("Book it anyway")');
    await Promise.race([anyway.waitFor().then(() => anyway.click()), page.waitForSelector('.book-panel', { state: 'detached' })]).catch(() => {});
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  const booked = await j.until(async () => (await j.s.get(`/appointments?patient_id=${patient.id}&from=${j.today}&to=${addDays(j.today, 400)}`)).find((a) => a.status !== 'cancelled'), 'the booked visit');
  assert.ok(booked.start_time >= j.today, 'in the future');
  await j.healthy('after booking');
});
