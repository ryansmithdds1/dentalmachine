// Workflow 7 — write a clinical note: Alt+N → type once → Ctrl/⌘+Enter, linked to today's visit (budget 4).
// Spec: docs/workflows/specs/07-clinical-notes.md
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let todays;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  // A patient on today's schedule with a single visit, so there's no doubt which one the note belongs to.
  const appts = await s.get('/appointments');
  const counts = appts.reduce((m, a) => m.set(a.patient_id, (m.get(a.patient_id) || 0) + 1), new Map());
  const appt = appts.find((a) => counts.get(a.patient_id) === 1);
  assert.ok(appt, 'the demo schedule has visits today');
  patient = await s.get(`/patients/${appt.patient_id}`);
  todays = appts.filter((a) => a.patient_id === appt.patient_id).map((a) => a.id);
});
after(async () => { await browser?.close(); await app?.stop(); });

test("note for the active patient in 4 actions, drafted and linked to today's visit, no dialog", async () => {
  const { page } = s;
  // Opening the chart makes them the active patient; then work elsewhere.
  await page.goto(`${app.base}/patients/${patient.id}`);
  await page.waitForSelector('h1, .patient-header');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');

  const drafted = await s.get(`/patients/${patient.id}/note-draft`);
  const said = 'patient tolerated well, no complications';
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+n');
    await page.waitForURL(/tab=notes/);
    // The cursor lands in the composer's typing box.
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Type what to add');
    await page.keyboard.type(said);
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector(`.card:has-text("${said.charAt(0).toUpperCase()}${said.slice(1)}")`);
  });
  console.log(withinBudget('write a note', r, { actions: 4, ms: 6000 }));

  const notes = await s.get(`/patients/${patient.id}/notes`);
  const note = notes.find((n) => n.body.includes('Patient tolerated well'));
  assert.ok(note, 'the note was saved');
  assert.ok(todays.includes(note.appointment_id), `linked to today's visit (got ${note.appointment_id}, today ${todays})`);
  assert.ok(note.visit_start, 'shows the visit on the saved note');
  // The visit's templates were already in the note: only the extra sentence was typed.
  if (drafted.body) assert.ok(note.body.startsWith(drafted.body.slice(0, 30)), 'opened drafted from the visit');
  assert.deepEqual(s.errors, [], 'no dialogs or page errors');
});

test('? lists the note shortcuts', async () => {
  const { page } = s;
  await page.locator('h2:has-text("New note")').click();
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  const text = await page.textContent('.shortcuts');
  assert.match(text, /Save the note/);
  assert.match(text, /Start or stop dictation/);
  await page.keyboard.press('Escape');
});
