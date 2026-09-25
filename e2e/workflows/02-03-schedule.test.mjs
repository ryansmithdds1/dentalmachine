// Workflows 2 and 3 (docs/workflows/specs/02-schedule-view.md, 03-appointment-status.md): today's schedule and
// switching Chairs/Providers/one provider by key; moving a visit through check in → seat → ready → out with
// one key (or one click) per step, with Undo instead of "Are you sure?".
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let today; let chairs; let provider;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  chairs = await s.get('/operatories?active=true');
  provider = (await s.get('/providers?active=true'))[0];
});
after(async () => { await browser?.close(); await app?.stop(); });

// A visit today, late in the evening so it never collides with the demo schedule.
async function bookToday(first, time) {
  const p = await s.post('/patients', { first_name: first, last_name: 'Flowtest', dob: '1990-02-03', phone: '(512) 555-0199' });
  const a = await s.post('/appointments', {
    patient_id: p.id, provider_id: provider.id, operatory_id: chairs[0].id, start_time: `${today} ${time}`, end_time: `${today} ${time.slice(0, 3)}50`,
    override_blockout: true, notify: false, reason: 'Flow test',
  });
  assert.ok(a.id, JSON.stringify(a));
  return a;
}
const card = (id) => `.cal [data-appt-id="${id}"]`;
const statusOf = async (id) => (await s.get(`/appointments/${id}`)).status;

test('#2 today’s schedule in 2 keys; Chairs / Providers / one provider in 1 key each, remembered', async () => {
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.sidebar');
  const open = await measure(page, async () => {
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await page.waitForSelector('.cal-col-head');
  });
  console.log(withinBudget('open today’s schedule', open, { actions: 2, ms: 4000 }));
  assert.match(page.url(), /\/schedule/);

  const providers = await measure(page, async () => {
    await page.keyboard.press('p');
    await page.waitForSelector('.cal-col-head .cal-col-avatar');
  });
  console.log(withinBudget('providers view', providers, { actions: 1, ms: 2000 }));

  const one = await measure(page, async () => {
    await page.keyboard.press('v');
    await page.waitForFunction(() => document.querySelectorAll('.cal-col-head').length === 1);
  });
  console.log(withinBudget('one provider', one, { actions: 1, ms: 2000 }));
  const chosen = await page.$eval('select[aria-label="Provider filter"]', (el) => el.value);
  assert.ok(chosen, 'the provider picker shows who is on screen');

  const chairsView = await measure(page, async () => {
    await page.keyboard.press('c');
    await page.waitForFunction(() => !document.querySelector('.cal-col-head .cal-col-avatar'));
  });
  console.log(withinBudget('chairs view', chairsView, { actions: 1, ms: 2000 }));
  // Chairs view shows only that provider's visits.
  const others = await page.$$eval('.cal-appt', (els) => els.length);
  const mine = (await s.get(`/schedule?from=${today}&to=${today}`)).appointments.filter((a) => String(a.provider_id) === chosen).length;
  assert.ok(others <= mine, `only the chosen provider's visits show (${others} of ${mine})`);

  // The choice follows the person: a fresh load opens on the same provider.
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('.cal-col-head');
  await page.waitForFunction((v) => document.querySelector('select[aria-label="Provider filter"]')?.value === v, chosen);
  await page.keyboard.press('Shift+V');
  await page.waitForFunction(() => document.querySelector('select[aria-label="Provider filter"]')?.value === '');

  // The command bar offers the same views.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('Providers view');
  await page.waitForSelector('.palette-item:has-text("Schedule: Providers view")');
  await page.keyboard.press('Escape');
  // And ? lists the new keys.
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  const help = await page.textContent('.shortcuts');
  for (const t of ['Chairs view', 'Providers view', 'Show one provider', 'Check in the selected visit', 'Ready for the doctor', 'Out — visit complete']) assert.ok(help.includes(t), `? lists "${t}"`);
  await page.keyboard.press('Escape');
});

test('#3 check in → seat → ready → out: one key per step on the focused visit, with Undo', async () => {
  const { page } = s;
  const a = await bookToday('Keya', '22:00');
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector(card(a.id));
  // F puts the keyboard on the visit happening now (or next); ↓/↑ move between visits.
  await page.keyboard.press('f');
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-appt-id'));
  // Setup for the timed steps: our visit has the keyboard.
  await page.focus(card(a.id));
  // Focusing a visit makes its patient the active one.
  await page.waitForFunction(() => /Keya/.test(document.querySelector('.patient-bar')?.textContent || ''));

  const steps = [['i', 'checked_in'], ['s', 'in_chair'], ['r', 'ready'], ['o', 'completed']];
  for (const [key, want] of steps) {
    const r = await measure(page, async () => {
      await page.keyboard.press(key);
      if (want === 'ready') await page.waitForSelector(`${card(a.id)} .cal-ready`);
      else await page.waitForSelector(`${card(a.id)}.status-${want}:not(.pending)`);
    });
    console.log(withinBudget(`status: ${want}`, r, { actions: 1, ms: 2000 }));
  }
  const done = await s.get(`/appointments/${a.id}`);
  assert.equal(done.status, 'completed');
  assert.equal(done.ready_for, 'doctor');
  assert.ok(done.arrived_at && done.seated_at && done.dismissed_at);

  // Undo (Ctrl/⌘+Z while the notice shows) puts them back in the chair, still ready.
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector(`${card(a.id)}.status-in_chair`);
  let back;
  for (let i = 0; i < 20 && (back = await s.get(`/appointments/${a.id}`)).status !== 'in_chair'; i++) await page.waitForTimeout(100);
  assert.equal(back.status, 'in_chair');
  assert.equal(back.dismissed_at, null, 'the undone "out" time is cleared');
  assert.equal(back.ready_for, 'doctor');
  const history = await s.get(`/appointments/${a.id}/history`);
  assert.ok(history.some((h) => h.action === 'appointment.status' && JSON.parse(h.details).undo), 'the history shows the undo');
  assert.deepEqual(s.errors, []);
});

test('#3 O never opens the plan on a visit (bug 1): Shift+O is today’s plan; O on a finished visit opens its checkout', async () => {
  const { page } = s;
  const a = await bookToday('Otto', '20:00');
  await s.api('PATCH', `/appointments/${a.id}/status`, { status: 'in_chair' });
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  // O on a seated visit: out, not the optimizer.
  await page.keyboard.press('o');
  await page.waitForSelector(`${card(a.id)}.status-completed:not(.pending)`);
  assert.equal(await page.locator('.opt-panel').count(), 0, 'O did not open today’s plan');
  assert.equal(await statusOf(a.id), 'completed');
  // Shift+O opens (and closes) the plan, when the optimizer is on.
  if (await page.locator('.opt-launch').count()) {
    await page.keyboard.press('Shift+O');
    await page.waitForSelector('.opt-panel');
    await page.keyboard.press('Shift+O');
    await page.waitForSelector('.opt-panel', { state: 'detached' });
  }
  // O again on the finished visit: its checkout, in one key.
  await page.focus(card(a.id));
  const r = await measure(page, async () => {
    await page.keyboard.press('o');
    await page.waitForURL(new RegExp(`/checkout/${a.id}$`));
    await page.waitForSelector('h1:has-text("Check out")');
  });
  console.log(withinBudget('finished visit → checkout', r, { actions: 1, ms: 3000 }));
  // ? lists Shift+O for the plan.
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector(card(a.id));
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  const help = await page.textContent('.shortcuts');
  assert.ok(help.includes('on a finished visit: open its checkout'), '? explains O on a finished visit');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('#3 one click per step with the next-step button on the card, and from the drawer header', async () => {
  const { page } = s;
  const a = await bookToday('Clicky', '21:00');
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector(card(a.id));
  await page.hover(card(a.id));
  for (const want of ['checked_in', 'in_chair']) {
    const r = await measure(page, async () => {
      await page.click(`${card(a.id)} .cal-next`);
      await page.waitForSelector(`${card(a.id)}.status-${want}:not(.pending)`);
    });
    console.log(withinBudget(`card button: ${want}`, r, { actions: 1, ms: 2000 }));
  }
  assert.equal(await statusOf(a.id), 'in_chair');
  // Open the drawer (Enter on the focused card), then its header button marks them ready.
  await page.focus(card(a.id));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.drawer .drawer-next button');
  const r = await measure(page, async () => {
    await page.click('.drawer .drawer-next button');
    await page.waitForSelector('.drawer .ready-badge');
  });
  console.log(withinBudget('drawer header: ready', r, { actions: 1, ms: 2000 }));
  assert.equal((await s.get(`/appointments/${a.id}`)).ready_for, 'doctor');
  assert.deepEqual(s.errors, []);
});
