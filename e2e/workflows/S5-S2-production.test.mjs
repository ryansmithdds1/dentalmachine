// S5 production on the schedule, S2 perfect-day blocks and S7 late patients (docs/workflows/specs/S5-production.md,
// S2-perfect-day.md, S7-late.md): the day's total always at the top, each column's numbers, the Doctor / Hygiene /
// All switch on one key, the breakdown on hover, live updates, the week's day totals, the blocks as lanes, moving a
// visit into a block with the inline "move it there anyway"; late visits outlined with "Late N min", the late list
// with one-click actions, and "running behind" on a chair.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let today; let chairs; let providers; let dentist; let DAY; let types; let tpl;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const dollars = (c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100).replace(/\.00$/, '');

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  chairs = await s.get('/operatories?active=true');
  providers = await s.get('/providers?active=true');
  dentist = providers.find((p) => p.type === 'dentist') || providers[0];
  types = await s.get('/appointment-types');
  // A quiet Monday months ahead (the demo schedule sits around today).
  DAY = addDays(today, 160);
  while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 1) DAY = addDays(DAY, 1);
  // The dentist's perfect Monday: crowns first thing.
  tpl = await s.post('/day-templates', {
    provider_id: dentist.id, name: 'E2E Monday', weekdays: [1], release_hours: 24,
    blocks: [{ label: 'Crowns', start_time: '08:00', end_time: '10:00', appointment_type_ids: [types.find((t) => t.name === 'Crown prep').id], goal: 300000, color: '#8b5cf6' }],
  });
  assert.ok(tpl.id, `the template is created (routes mounted?): ${JSON.stringify(tpl)}`);
});
after(async () => { await browser?.close(); await app?.stop(); });

const newPatient = (first) => s.post('/patients', { first_name: first, last_name: 'Prodtest', dob: '1980-05-06', phone: '(512) 555-0142' });
async function bookWith(first, time, minutes, code, extra = {}) {
  const p = await newPatient(first);
  const [h, m] = time.split(':').map(Number);
  const end = h * 60 + m + minutes;
  const a = await s.post('/appointments', {
    patient_id: p.id, provider_id: dentist.id, operatory_id: chairs[0].id, start_time: `${DAY} ${time}`,
    end_time: `${DAY} ${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`, override_blockout: true, notify: false, add_type_procedures: false, ...extra,
  });
  assert.ok(a.id, JSON.stringify(a));
  const pr = code ? await s.post(`/patients/${p.id}/procedures`, { code, appointment_id: a.id, provider_id: dentist.id, ...(code === 'D2740' ? { tooth: '3' } : code === 'D2391' ? { tooth: '30', surfaces: 'O' } : {}) }) : null;
  return { a, pr };
}
async function until(check, what) {
  for (let i = 0; i < 60; i++) {
    const v = await check();
    if (v) return v;
    await s.page.waitForTimeout(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const barText = () => s.page.textContent('.prod-bar .prod-fig.lead strong');

test('S5 the day’s production is on screen with no action; $ switches Doctor / Hygiene / All in one key; hover shows the breakdown', async () => {
  const { page } = s;
  const crown = await bookWith('Cara', '08:00', 90, 'D2740', { appointment_type_id: types.find((t) => t.name === 'Crown prep').id });
  const prod = await s.get(`/schedule/production?date=${DAY}`);
  assert.equal(prod.days[0].scheduled, crown.pr.fee);

  await page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await page.waitForSelector('.prod-bar');
  await until(async () => (await barText()) === dollars(crown.pr.fee), 'the scheduled total');
  assert.match(await page.textContent('.prod-bar .prod-fig:has-text("Goal") strong'), /\$/);
  // Each column's heading has its numbers.
  assert.ok(await page.locator('.cal-col-head .col-prod').count() > 0);

  const toHygiene = await measure(page, async () => {
    await page.keyboard.press('$');
    await page.waitForSelector('.prod-kind button.active:has-text("Doctor")');
    await page.keyboard.press('$');
    await page.waitForSelector('.prod-kind button.active:has-text("Hygiene")');
  });
  console.log(withinBudget('switch production to Hygiene ($ $)', toHygiene, { actions: 2, ms: 3000 }));
  await until(async () => (await barText()) === '$0', 'hygiene has nothing booked that day');
  await page.keyboard.press('$');
  await page.waitForSelector('.prod-kind button.active:has-text("All")');
  await until(async () => (await barText()) === dollars(crown.pr.fee), 'back to everyone');

  // Remembered for this person (on the server: wait for it to be saved before reloading).
  const saved = page.waitForResponse((res) => res.url().includes('/me/prefs/schedule.production_kind') && res.request().method() === 'PUT');
  await page.keyboard.press('$');
  await page.waitForSelector('.prod-kind button.active:has-text("Doctor")');
  await saved;
  await page.reload();
  await page.waitForSelector('.prod-kind button.active:has-text("Doctor")');
  await page.click('.prod-kind button:has-text("All")');

  // The breakdown: hovering costs nothing.
  const hover = await measure(page, async () => {
    await page.hover('.prod-bar .prod-figures');
    await page.waitForSelector('.prod-pop');
  });
  console.log(withinBudget('see the breakdown (hover)', hover, { actions: 0, ms: 2000 }));
  const pop = await page.textContent('.prod-pop');
  assert.match(pop, new RegExp(dentist.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(pop, /Crowns & bridges/);
  assert.match(pop, /Treatment still to book/);
  await page.mouse.move(5, 5);
  assert.deepEqual(s.errors, []);
});

test('S5 numbers update live when a visit is booked elsewhere, and the week shows each day’s total', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await page.waitForSelector('.prod-bar');
  const before = (await s.get(`/schedule/production?date=${DAY}`)).days[0].scheduled;
  // Booked from another screen (the API here): an emergency visit, whose type brings its exam and x-ray.
  const added = await bookWith('Liv', '14:00', 30, null, { appointment_type_id: types.find((t) => t.name.startsWith('Emergency')).id, add_type_procedures: true });
  assert.ok(added.a.production > 0, 'the visit type added its procedures');
  await until(async () => (await barText()) === dollars(before + added.a.production), 'the live total');

  const week = await measure(page, async () => {
    await page.keyboard.press('w');
    await page.waitForFunction(() => document.querySelectorAll('.cal-col-head .col-prod').length >= 5);
  });
  console.log(withinBudget('week with day totals (W)', week, { actions: 1, ms: 3000 }));
  const heads = await page.$$eval('.cal-col-head', (els) => els.map((e) => e.textContent));
  assert.ok(heads.some((t) => t.includes(dollars(before + added.a.production))), `the Monday column shows its total: ${heads.join(' | ')}`);
  await page.keyboard.press('d');
  assert.deepEqual(s.errors, []);
});

test('S2 blocks show as lanes; moving a filling into the crown block asks inline, and "move it there" is recorded (M ↑ Enter Enter)', async () => {
  const { page } = s;
  const fill = await bookWith('Fay', '10:00', 30, 'D2391', { appointment_type_id: types.find((t) => t.name === 'Filling').id });
  await page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await page.waitForSelector('.cal-col-head');
  await page.keyboard.press('p');
  await page.waitForSelector('.cal-lane:has-text("Crowns")');
  assert.match(await page.textContent('.cal-lane .cal-lane-tag'), /\$3,000/);

  await page.waitForSelector(`.cal [data-appt-id="${fill.a.id}"]`);
  await page.focus(`.cal [data-appt-id="${fill.a.id}"]`);
  const r = await measure(page, async () => {
    await page.keyboard.press('m');
    await page.waitForSelector('.cal-ghost.carry');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.override-banner:has-text("Crowns")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.override-banner', { state: 'detached' });
  });
  console.log(withinBudget('move into a block anyway', r, { actions: 4, ms: 5000 }));
  await until(async () => (await s.get(`/appointments/${fill.a.id}`)).start_time === `${DAY} 09:50`, 'the move');
  const log = await s.get(`/audit-log?entity=appointments&entity_id=${fill.a.id}`);
  const rows = Array.isArray(log) ? log : log.rows || log.entries || [];
  assert.ok(rows.some((x) => x.action === 'appointment.block_override'), 'the override is in the audit log');
  assert.deepEqual(s.errors, []);
});

// Practice-local "now" in a time zone: [date, minutes after midnight].
const localNow = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
};
const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('S7 late: red outline and "Late N min" on the card, the late list with one-click text, very late pulses, a chair running behind', async () => {
  const { page } = s;
  // Run this at a daytime hour for the practice whatever the clock says: pick a time zone where it's 10:00–20:00.
  const tz = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu']
    .find((z) => { const m = localNow(z)[1]; return m >= 600 && m < 1200; });
  await s.api('PUT', '/practice', { timezone: tz, send_from: '00:00', send_until: '00:00' });
  await s.api('PUT', '/schedule/late-settings', { late_minutes: 5, very_late_minutes: 10 });
  const [day, now] = localNow(tz);
  // Its own chair and dentist, so nothing on the demo schedule is in the way.
  const chair = await s.post('/operatories', { name: 'Late test chair' });
  const doc = await s.post('/providers', { name: 'Dr. Lou Tardy', type: 'dentist' });
  const p = await newPatient('Lana');
  const mk = async (patient, from, to, extra = {}) => s.post('/appointments', { patient_id: patient.id, provider_id: doc.id, operatory_id: chair.id, start_time: at(day, from), end_time: at(day, to), override_blockout: true, notify: false, add_type_procedures: false, ...extra });
  const late = await mk(p, now - 7, now + 30);
  assert.ok(late.id, JSON.stringify(late));
  await page.goto(`${app.base}/schedule?date=${day}&view=day`);
  await page.reload();
  await page.waitForSelector('.cal-col-head');
  await page.keyboard.press('c');
  const card = `.cal [data-appt-id="${late.id}"]`;
  await page.waitForSelector(`${card}.late`);
  assert.match(await page.textContent(`${card} .cal-late`), /Late [78] min/);
  assert.equal(await page.locator(`${card}.very-late`).count(), 0, 'not very late yet');
  await page.waitForSelector('.late-banner');
  if (await page.locator('.late-more').count()) await page.click('.late-more');
  const row = page.locator('.late-list li', { hasText: 'Lana Prodtest' });
  const texted = await measure(page, async () => {
    await row.locator('button:has-text("Text")').click();
    await row.locator('.late-done').waitFor();
  });
  console.log(withinBudget('text a late patient', texted, { actions: 1, ms: 3000 }));
  const msgs = await s.get(`/messages?patient_id=${p.id}`);
  assert.match(msgs[0].body, /are you on your way/);
  assert.ok(await row.locator('a[href^="tel:"]').count(), 'call is one click');

  // The practice's own numbers: late after 1, very late after 5 — the visit pulses (or a strong static style).
  await s.api('PUT', '/schedule/late-settings', { late_minutes: 1, very_late_minutes: 5 });
  await page.reload();
  await page.waitForSelector(`${card}.very-late`);

  // Running behind: over time in the chair while the next patient waits.
  const q = await newPatient('Otto');
  const r = await newPatient('Nell');
  await s.api('PUT', `/appointments/${late.id}`, { start_time: at(day, now + 60), end_time: at(day, now + 90) });
  const over = await mk(q, now - 60, now - 12);
  const next = await mk(r, now - 12, now + 20);
  for (const st of ['checked_in', 'in_chair']) await s.api('PATCH', `/appointments/${over.id}/status`, { status: st });
  await s.api('PATCH', `/appointments/${next.id}/status`, { status: 'checked_in' });
  await page.reload();
  await page.waitForSelector('.cal-col-head');
  const head = page.locator('.cal-col-head', { hasText: 'Late test chair' });
  await head.locator('.cal-behind').waitFor();
  assert.match(await head.locator('.cal-behind').textContent(), /Running 1[2-4] min behind/);
  // The current time is on every column, with the time on it.
  assert.ok(await page.locator('.cal-now-bubble').count() >= 1);
  assert.deepEqual(s.errors, []);
});
