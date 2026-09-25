// Nightly journey — the dentist (Dr. Chen, dr.chen@demo): open today's patient from the schedule, chart a
// finding, write the note, build and present the treatment plan (the patient signs it here), and sign the note.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey } from './lib.mjs';

const j = journey('dentist', 'dr.chen@demo.dentalmachine.app');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
let visit; let patient;

test("open today's patient from the schedule", async () => {
  const { page } = j;
  const me = (await j.s.get('/providers?active=true')).find((p) => /Chen/.test(p.name));
  const today = await j.s.get(`/appointments?date=${j.today}`);
  visit = today.find((a) => a.provider_id === me.id && !['cancelled', 'no_show', 'completed'].includes(a.status)) || today[0];
  assert.ok(visit, 'Dr. Chen has patients today');
  patient = await j.s.get(`/patients/${visit.patient_id}`);
  await j.step('schedule', async () => {
    await j.goto(`/schedule?date=${j.today}`, `.cal [data-appt-id="${visit.id}"]`);
    await page.click(`.cal [data-appt-id="${visit.id}"]`);
    await page.waitForSelector('.drawer');
  });
  await j.step('open the chart', async () => {
    await j.goto(`/patients/${patient.id}?tab=chart`, '.odontogram2');
  });
  await j.healthy('chart');
});

test('chart a finding on a tooth', async () => {
  const { page } = j;
  await j.step('chart', async () => {
    await page.locator('.tooth2[data-tooth="30"]').first().click();
    await page.fill('input[aria-label="Procedure code"]', 'D2392');
    await page.locator('.code-picker .results button', { hasText: 'D2392' }).first().click();
    await page.getByRole('button', { name: 'M', exact: true }).click();
    await page.getByRole('button', { name: 'O', exact: true }).click();
    await page.getByRole('button', { name: 'Completed today', exact: true }).click();
    await page.click('button.primary:has-text("Chart as completed")');
  });
  await j.until(async () => (await j.s.get(`/patients/${patient.id}/procedures`)).some((p) => p.code === 'D2392' && p.tooth === '30' && p.status === 'completed'), 'the charted filling');
});

test('build and present the treatment plan; the patient signs it here', async () => {
  const { page } = j;
  await j.step('build the plan', async () => {
    await j.goto(`/patients/${patient.id}?tab=treatment`, 'h2:has-text("Treatment plans")');
    await page.keyboard.press('n');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add work to the plan');
    await page.keyboard.type('3 D2740');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal td:has-text("D2740")');
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector('.card h3:has-text("Treatment plan —")');
  });
  const plan = (await j.s.get(`/patients/${patient.id}/treatment-plans`)).find((p) => p.procedures.some((x) => x.code === 'D2740'));
  assert.ok(plan, 'the plan was made');
  await j.step('present and sign', async () => {
    await page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Present here for")').click();
    await page.waitForURL(/\/tp\//);
    await page.waitForSelector('h1:has-text("Your treatment plan")');
    await page.locator('input[autocomplete=name]').fill(`${patient.first_name} ${patient.last_name}`);
    await page.click('label.checkbox input[type=checkbox]');
    await page.click('button:has-text("Accept & sign")');
    await page.waitForSelector('h1:has-text("Thank you")');
    await page.click('a:has-text("back to the chart")');
    await page.waitForSelector('.badge:has-text("Signed by")');
  });
  assert.ok((await j.s.get(`/patients/${patient.id}/treatment-plans`)).find((p) => p.id === plan.id).signed_at, 'signed');
});

test('write the note and sign it', async () => {
  const { page } = j;
  const said = 'journey note tolerated well';
  await j.step('note', async () => {
    await j.goto(`/patients/${patient.id}?tab=notes`, '[aria-label="Type what to add"]');
    await page.fill('[aria-label="Type what to add"]', said);
    await page.keyboard.press(`${MOD}+Shift+Enter`); // save and sign
    await page.waitForSelector('.card:has-text("Journey note tolerated well")');
  });
  const note = await j.until(async () => (await j.s.get(`/patients/${patient.id}/notes`)).find((n) => /journey note tolerated well/i.test(n.body) && n.signed), 'the signed note');
  assert.ok(note.signed_at || note.signed, 'signed');
  await j.healthy('notes');
});
