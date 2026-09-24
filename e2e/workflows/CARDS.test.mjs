// Patient preferences, doctor's notes, "we moved them" and customizable cards (PP1, DN1, S8, S6 —
// docs/workflows/specs/PP-DN-S8-S6.md): an urgent preference in ≤ 2 actions shows on the schedule card and the
// patient bar; a doctor's note on an empty slot in ≤ 2 actions (right-click, pick) shows as a bubble the front desk
// acknowledges; customizing the cards is ≤ 3 actions; cancelling "for our reason" counts on the patient.
//
// Runs the app with the new routes in front (e2e/lib/cards-app.mjs) until app.js mounts them.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let DAY; let chairs; let providers;
const tag = Math.random().toString(36).slice(2, 6);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const card = (id) => `.cal [data-appt-id="${id}"]`;

before(async () => {
  app = await startApp({ entry: 'e2e/lib/cards-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // A quiet Wednesday months ahead (the demo schedule sits around today).
  DAY = addDays(today, 170);
  while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 3) DAY = addDays(DAY, 1);
  chairs = await s.get('/operatories?active=true');
  providers = await s.get('/providers?active=true');
  assert.ok((await s.get(`/schedule?from=${DAY}&to=${DAY}`)).hours[DAY]?.length, `the office is open on ${DAY}`);
});
after(async () => { await browser?.close(); await app?.stop(); });

async function bookAt(first, time, minutes = 60) {
  const p = await s.post('/patients', { first_name: `${first}${tag}`, last_name: 'Cardtest', dob: '1986-04-09', phone: '(512) 555-0161' });
  const [h, m] = time.split(':').map(Number);
  const e = h * 60 + m + minutes;
  const a = await s.post('/appointments', {
    patient_id: p.id, provider_id: providers[0].id, operatory_id: chairs[0].id, start_time: `${DAY} ${time}`,
    end_time: `${DAY} ${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`, override_blockout: true, notify: false,
  });
  assert.ok(a.id, JSON.stringify(a));
  return { p, a };
}
async function openDay() {
  await s.page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await s.page.waitForSelector('.cal-col-head');
}
// Where a time of day is on screen, from the hour labels in the grid's gutter.
const yOf = (minute) => s.page.evaluate((m) => {
  const labels = [...document.querySelectorAll('.cal-hour-label')].map((l) => ({ t: l.textContent, top: parseFloat(l.style.top) }));
  const toMin = (t) => { const [n, ap] = t.split(' '); return ((Number(n) % 12) + (ap === 'PM' ? 12 : 0)) * 60; };
  const [a, b] = labels;
  const ppm = (b.top - a.top) / (toMin(b.t) - toMin(a.t));
  return document.querySelector('.cal-body').getBoundingClientRect().top + a.top + (m - toMin(a.t)) * ppm;
}, minute);

test('PP1: an urgent preference in ≤ 2 actions — on the schedule card (hover lists it) and in the patient bar', async () => {
  const { page } = s;
  const { p, a } = await bookAt('Pia', '10:00');
  await openDay();
  await page.click(card(a.id));
  await page.waitForSelector('.drawer .visit-extras .cc-prefs');
  const r = await measure(page, async () => {
    await page.click('.drawer .visit-extras .cc-prefs');
    await page.click('.drawer .pp-row[data-option="Blanket"] .pp-urgent-btn');
    await page.waitForSelector(`${card(a.id)} .cc-urgent`);
  });
  console.log(withinBudget('add an urgent preference and see it on the card', r, { actions: 2, ms: 5000 }));
  const title = await page.getAttribute(`${card(a.id)} .cc-urgent`, 'title');
  assert.match(title, /Blanket \(urgent\)/);
  await page.waitForSelector('.drawer .ve-urgent:has-text("Blanket")');
  await page.waitForSelector('.patient-bar .cc-prefs.urgent:has-text("Blanket")');
  const prefs = await s.get(`/patients/${p.id}/preferences`);
  assert.deepEqual(prefs.map((x) => [x.label, x.urgent]), [['Blanket', 1]]);
  assert.deepEqual(s.errors, []);
});

test('DN1: a doctor’s note on an empty slot in ≤ 2 actions (right-click, pick); the front desk says “Got it”', async () => {
  const { page } = s;
  await openDay();
  const box = await page.locator('.cal-col').nth(0).boundingBox();
  const y = await yOf(14 * 60 + 5);
  const r = await measure(page, async () => {
    await page.mouse.click(box.x + box.width / 2, y, { button: 'right' });
    await page.click('.dn-composer .dn-pick:has-text("Fit an emergency here")');
    await page.waitForSelector('.dn-bubble:has-text("Fit an emergency here")');
  });
  console.log(withinBudget('leave a doctor’s note on a slot', r, { actions: 2, ms: 5000 }));
  const [note] = await s.get(`/schedule-notes?date=${DAY}`);
  assert.equal(note.body, 'Fit an emergency here');
  assert.equal(note.kind, 'slot');
  assert.equal(note.start_time, '14:00');
  await page.click('.dn-bubble:has-text("Fit an emergency here")');
  await page.click('.dn-popover button:has-text("Got it")');
  await page.waitForSelector('.dn-slot.acknowledged');
  assert.equal((await s.get(`/schedule-notes?date=${DAY}`))[0].status, 'acknowledged');
  // "Book it" opens the booking form on that slot.
  await page.click('.dn-bubble:has-text("Fit an emergency here")');
  await page.click('.dn-popover button:has-text("Book it")');
  await page.waitForSelector('.modal');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('S6: customize what cards show in ≤ 3 actions (open, tick Age, save for everyone); the card shows it', async () => {
  const { page } = s;
  const { a } = await bookAt('Cora', '11:30');
  await openDay();
  await page.waitForSelector(card(a.id));
  assert.equal(await page.locator(`${card(a.id)} .cc-age`).count(), 0, 'not shown until chosen');
  const r = await measure(page, async () => {
    await page.click('button[aria-label="Customize cards"]');
    await page.click('.cle-check[title="How old they are"] input');
    await page.click('.cle-panel button:has-text("Save for everyone")');
    await page.waitForSelector(`${card(a.id)} .cc-age`);
  });
  console.log(withinBudget('customize cards', r, { actions: 3, ms: 5000 }));
  const layout = await s.get('/card-layout');
  assert.ok(layout.practice.lines.flat().includes('age'));
  // Back to the standard cards for the other tests.
  await s.api('PUT', '/card-layout', { layout: null });
  assert.deepEqual(s.errors, []);
});

test('S8: cancel for our reason — “Whose reason? Ours”, then the office’s reason — counts on the patient', async () => {
  const { page } = s;
  const { p, a } = await bookAt('Mora', '15:00');
  await openDay();
  await page.click(card(a.id));
  await page.waitForSelector('.drawer');
  await page.keyboard.press('x');
  await page.waitForSelector('.broken-picker');
  await page.click('.broken-whose button:has-text("Ours")');
  await page.keyboard.press('1'); // Provider sick
  await page.waitForFunction(async (id) => !document.querySelector(`.cal [data-appt-id="${id}"]`), a.id);
  if (await page.locator('.modal').count()) await page.keyboard.press('Escape');
  const conn = await s.get(`/patients/${p.id}/connection`);
  assert.equal(conn.strikes.count, 1);
  assert.equal(conn.strikes.list[0].reason, 'provider_sick');
  assert.match(conn.strike_warning, /We moved Mora/);
  await page.waitForSelector('.patient-bar .cc-strike-badge:has-text("Moved by us 1×")');
  assert.deepEqual(s.errors, []);
});
