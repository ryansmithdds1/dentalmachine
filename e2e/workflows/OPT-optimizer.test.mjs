// Today's schedule optimizer (docs/workflows/specs/OPT-optimizer.md): from the huddle, O opens the plan and Enter
// does the top move — two actions — and it's done through the normal endpoints (the tracking row says done or, for
// a text offer, waiting on the reply). Also: J/K move, D hides one for today, Esc closes; the schedule's Plan button.
// Until app.js mounts the routes (and Dashboard.jsx the huddle card), the parts that need them are skipped.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false; let day; let doc; let chair;

// Practice-local "now" in a time zone: [date, minutes after midnight].
const localNow = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
};
const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const probe = await s.page.evaluate(async () => (await fetch('/api/optimizer/settings', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status);
  mounted = probe === 200;
  if (!mounted) return;
  // A morning somewhere, so the day still has time left; the office open every day, texts any time.
  const tz = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu']
    .find((z) => { const m = localNow(z)[1]; return m >= 420 && m < 780; }) || 'UTC';
  const open = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['06:00', '22:00']]]));
  await s.api('PUT', '/practice', { timezone: tz, send_from: '00:00', send_until: '00:00', office_hours: open });
  const [today, now] = localNow(tz);
  day = today;
  // Our own dentist with a $5,000 goal and a chair, and a patient on the schedule with a crown planned: the time after
  // the visit is open, so the plan stretches the visit for the crown.
  doc = await s.post('/providers', { name: 'Dr. Opal Tester', type: 'dentist', daily_goal: 500000 });
  chair = await s.post('/operatories', { name: 'Optimizer chair' });
  const p = await s.post('/patients', { first_name: 'Olive', last_name: 'Planner', dob: '1982-03-04', phone: '(512) 555-0177' });
  const start = Math.ceil((now + 30) / 10) * 10;
  const visit = await s.post('/appointments', { patient_id: p.id, provider_id: doc.id, operatory_id: chair.id, start_time: at(day, start), end_time: at(day, start + 60), notify: false, add_type_procedures: false, override_blockout: true });
  assert.ok(visit.id, JSON.stringify(visit));
  const crown = await s.post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: doc.id });
  assert.ok(crown.id, JSON.stringify(crown));
});
after(async () => { await browser?.close(); await app?.stop(); });

test('OPT the plan finds and prices the planned crown for today’s patient', async (t) => {
  if (!mounted) return t.skip('optimizer routes not mounted in app.js yet');
  const d = await s.get(`/optimizer/today?date=${day}`);
  const o = d.opportunities.find((x) => x.patient === 'Olive P.');
  assert.ok(o, JSON.stringify(d.opportunities.map((x) => x.title)));
  assert.equal(o.fits, true, o.why_not);
  assert.ok(o.fee > 0);
  const prov = d.providers.find((x) => x.provider_id === doc.id);
  assert.equal(prov.goal, 500000);
  assert.match(prov.plan.headline, /move/);
});

test('OPT from the huddle: O opens the plan, Enter does the top move (≤ 2 actions); J/K move, D hides, Esc closes', async (t) => {
  if (!mounted) return t.skip('optimizer routes not mounted in app.js yet');
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.sidebar');
  if (!(await page.locator('.opt-huddle').count())) {
    await page.waitForTimeout(1500);
    if (!(await page.locator('.opt-huddle').count())) return t.skip('the huddle card isn’t mounted in Dashboard.jsx yet');
  }
  await page.waitForSelector('.opt-huddle .opt-headline');
  const before = await s.get(`/optimizer/today?date=${day}`);
  const top = [...before.opportunities.filter((o) => o.fits && o.in_plan), ...before.opportunities.filter((o) => o.fits && !o.in_plan), ...before.protect.filter((o) => o.fits)][0];
  assert.ok(top, 'there is something to do');
  const r = await measure(page, async () => {
    await page.keyboard.press('o');
    await page.waitForSelector('.opt-panel .opt-card.active');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast');
  });
  console.log(withinBudget('accept the top opportunity (O, Enter)', r, { actions: 2, ms: 6000 }));
  const row = (await s.get(`/optimizer/today?date=${day}`));
  const state = [...row.done, ...row.working].find((x) => x.id === top.id);
  assert.ok(state, `the top move (${top.title}) is done or waiting on a reply`);
  assert.match(await page.textContent('.toast'), /Added to the visit|Booked|Offer texted|Reminder sent|Visit shortened|Visit moved up|Text sent/);

  // J / K move between cards; D hides one for today; Esc closes.
  const cards = await page.locator('.opt-panel .opt-card').count();
  if (cards > 1) {
    const first = await page.getAttribute('.opt-panel .opt-card.active', 'data-opt-id');
    await page.keyboard.press('j');
    await page.waitForFunction((id) => document.querySelector('.opt-panel .opt-card.active')?.getAttribute('data-opt-id') !== id, first);
    const hid = await page.getAttribute('.opt-panel .opt-card.active', 'data-opt-id');
    await page.keyboard.press('d');
    await page.waitForSelector(`.opt-panel .opt-card[data-opt-id="${hid}"]`, { state: 'detached' });
    const after = await s.get(`/optimizer/today?date=${day}`);
    assert.ok(after.declined.some((x) => String(x.id) === hid), 'marked not today');
    await page.keyboard.press('k');
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.opt-panel', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});

test('OPT on the schedule: the Plan button and markers on open time', async (t) => {
  if (!mounted) return t.skip('optimizer routes not mounted in app.js yet');
  const { page } = s;
  await page.goto(`${app.base}/schedule?date=${day}&view=day`);
  await page.waitForSelector('.cal-col-head');
  if (!(await page.locator('.opt-launch').count())) return t.skip('the Plan button isn’t mounted in Schedule.jsx yet');
  await page.keyboard.press('p');
  await page.waitForSelector('button.opt-gap');
  await page.click('.opt-launch');
  await page.waitForSelector('.opt-panel');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.opt-panel', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});
