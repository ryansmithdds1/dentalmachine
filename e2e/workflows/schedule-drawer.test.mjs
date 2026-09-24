// The visit panel's quick way to the patient, and hiding the schedule's notices for the day.
// Drawer: six buttons at the top (Chart, Insurance, Profile, Balance, Notes, X-rays) with their number keys 1–6,
// the name opens the profile, the visit's patient becomes the active one, Back returns to the same day and view
// with the panel open; the numbers don't clash with the cancel reasons. Budget: 2 actions from the schedule
// (open the visit, then one click or one key).
// Notices: ✕ on the late list (and a chair's "running behind") hides it for this person for today — after a reload
// too — until someone new is late; "N hidden" brings them back. Nothing about the visits changes.
/* global document, sessionStorage, localStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let DAY; let chair; let doc; let pat; let visit;
const SHOTS = process.env.SHOTS_DIR || join(tmpdir(), 'dm-shots');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const card = (id) => `.cal [data-appt-id="${id}"]`;
const localNow = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
};
const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // A quiet weekday a few weeks out, in its own chair, so nothing on the demo schedule is in the way.
  DAY = addDays(today, 40);
  while ([0, 6].includes(new Date(`${DAY}T12:00:00Z`).getUTCDay())) DAY = addDays(DAY, 1);
  chair = await s.post('/operatories', { name: 'Drawer test chair' });
  doc = await s.post('/providers', { name: 'Dr. Dora Drawer', type: 'dentist' });
  pat = await s.post('/patients', { first_name: 'Quinn', last_name: 'Quickrow', dob: '1985-04-03', phone: '(512) 555-0177', office_alert: 'Prefers morning calls' });
  visit = await s.post('/appointments', { patient_id: pat.id, provider_id: doc.id, operatory_id: chair.id, start_time: `${DAY} 10:00`, end_time: `${DAY} 11:00`, override_blockout: true, notify: false, reason: 'Drawer test' });
  assert.ok(visit.id, JSON.stringify(visit));
});
after(async () => { await browser?.close(); await app?.stop(); });

async function openSchedule(page = s.page) {
  await page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await page.waitForSelector('.cal-col-head');
  await page.keyboard.press('c');
  await page.waitForSelector(card(visit.id));
}
const activeTab = (page = s.page) => page.textContent('.tabs button.active');

test('drawer: Chart, Insurance and Profile in 2 actions from the schedule (a click on the visit, then one click or one key)', async () => {
  const { page } = s;
  await openSchedule();
  // Chart: click the visit, click Chart.
  const chart = await measure(page, async () => {
    await page.click(card(visit.id));
    await page.click('.drawer .drawer-jump:has-text("Chart")');
    await page.waitForURL(new RegExp(`/patients/${pat.id}\\?tab=chart$`));
    await page.waitForSelector('.tabs button.active');
  });
  console.log(withinBudget('visit → chart', chart, { actions: 2, ms: 4000 }));
  assert.equal(await activeTab(), 'Chart');
  // The patient is the active one (the patient bar keeps them on the next screen).
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('dm_active_patient'))), pat.id);

  // Back: the same day and view, with the visit's panel open again.
  await page.goBack();
  await page.waitForSelector('.drawer .drawer-jumps');
  const url = new URL(page.url());
  assert.equal(url.pathname, '/schedule');
  assert.equal(url.searchParams.get('date'), DAY);
  assert.equal(url.searchParams.get('view'), 'day');
  assert.match(await page.textContent('.drawer h2'), /Quinn Quickrow/);
  await page.waitForFunction(() => !new URL(location.href).searchParams.get('appt'));

  // Insurance: the visit, then 2.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });
  const ins = await measure(page, async () => {
    await page.click(card(visit.id));
    await page.waitForSelector('.drawer .drawer-jumps');
    await page.keyboard.press('2');
    await page.waitForURL(new RegExp(`/patients/${pat.id}\\?tab=insurance$`));
    await page.waitForSelector('.tabs button.active');
  });
  console.log(withinBudget('visit → insurance (key 2)', ins, { actions: 2, ms: 4000 }));
  assert.equal(await activeTab(), 'Insurance');

  // Profile: keyboard only — Enter on the focused visit, then 3.
  await page.goBack();
  await page.waitForSelector('.drawer .drawer-jumps');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });
  await page.focus(card(visit.id));
  const prof = await measure(page, async () => {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.drawer .drawer-jumps');
    await page.keyboard.press('3');
    await page.waitForURL(new RegExp(`/patients/${pat.id}\\?tab=overview$`));
    await page.waitForSelector('.tabs button.active');
  });
  console.log(withinBudget('visit → profile (keyboard: Enter, 3)', prof, { actions: 2, ms: 4000 }));
  assert.equal(await activeTab(), 'Overview');

  // The name in the header is a link to the profile too; Balance, Notes and X-rays go to their tabs.
  await page.goBack();
  await page.waitForSelector('.drawer .drawer-name');
  assert.equal(await page.getAttribute('.drawer .drawer-name', 'href'), `/patients/${pat.id}?tab=overview`);
  const hrefs = await page.$$eval('.drawer .drawer-jump', (els) => els.map((e) => [e.textContent, e.getAttribute('href')]));
  assert.deepEqual(hrefs.map(([t]) => t), ['Chart1', 'Insurance2', 'Profile3', 'Balance4', 'Notes5', 'X-rays6']);
  assert.deepEqual(hrefs.map(([, h]) => h.split('tab=')[1]), ['chart', 'insurance', 'overview', 'ledger', 'notes', 'documents']);
  // At a glance: balance and the office's alert, without leaving the schedule.
  await page.waitForSelector('.drawer .drawer-facts .fact:has-text("Balance")');
  assert.match(await page.textContent('.drawer .drawer-facts'), /Prefers morning calls/);
  // "Open chart" at the bottom is gone (it's at the top now); the other actions are still there.
  assert.equal(await page.locator('.drawer button:has-text("Open chart")').count(), 0);
  assert.ok(await page.locator('.drawer button:has-text("Move…")').count());
  await page.click('.drawer .drawer-name');
  await page.waitForURL(new RegExp(`/patients/${pat.id}\\?tab=overview$`));
  await page.goBack();
  await page.waitForSelector('.drawer .drawer-jumps');
  await page.keyboard.press('4');
  await page.waitForURL(/tab=ledger$/);
  assert.equal(await activeTab(page), 'Ledger');
  assert.deepEqual(s.errors, []);
});

test('drawer: the number keys are in the ? list, do nothing with the panel closed, and pick a reason (not a tab) while cancelling', async () => {
  const { page } = s;
  await openSchedule();
  await page.click(card(visit.id));
  await page.waitForSelector('.drawer .drawer-jumps');
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts:has-text("Visit panel")');
  const help = await page.textContent('.shortcuts');
  assert.match(help, /Open the patient’s chart/);
  assert.match(help, /Open the patient’s x-rays and documents/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.shortcuts', { state: 'detached' });
  if (await page.locator('.drawer').count()) await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });
  // Panel closed: 1 is nothing on the schedule.
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  assert.match(page.url(), /\/schedule/);

  // Cancel reasons are numbered too: with the picker up, 1 is "Sick", not the chart.
  const p = await s.post('/patients', { first_name: 'Cass', last_name: 'Cancelcase', dob: '1990-01-01' });
  const a = await s.post('/appointments', { patient_id: p.id, provider_id: doc.id, operatory_id: chair.id, start_time: `${DAY} 14:00`, end_time: `${DAY} 14:30`, override_blockout: true, notify: false, reason: 'Cancel test' });
  await page.reload();
  await page.waitForSelector(card(a.id));
  await page.click(card(a.id));
  await page.waitForSelector('.drawer .drawer-jumps');
  await page.keyboard.press('x');
  await page.waitForSelector('.broken-picker');
  await page.keyboard.press('1');
  await page.waitForFunction(async (id) => {
    const r = await fetch(`/api/appointments/${id}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } });
    return (await r.json()).status === 'cancelled';
  }, a.id);
  assert.match(page.url(), /\/schedule/, 'stayed on the schedule');
  assert.equal((await s.get(`/appointments/${a.id}`)).broken_reason, 'sick');
  while (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  assert.deepEqual(s.errors, []);
});

test('drawer: buttons follow permissions — an assistant (no billing) has no Balance, and 4 does nothing', async () => {
  const email = `assistant.${Date.now()}@example.com`;
  const u = await s.post('/users', { email, name: 'Ari Assistant', role: 'assistant', password: 'demo-password-123' });
  assert.ok(u.id, JSON.stringify(u));
  const b = await signIn(browser, app.base, { email });
  await b.page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await b.page.waitForSelector('.cal-col-head');
  await b.page.keyboard.press('c');
  await b.page.click(card(visit.id));
  await b.page.waitForSelector('.drawer .drawer-jumps');
  const labels = await b.page.$$eval('.drawer .drawer-jump span', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ['Chart', 'Insurance', 'Profile', 'Notes', 'X-rays']);
  assert.equal(await b.page.locator('.drawer .drawer-facts .fact:has-text("Balance")').count(), 0, 'no balance without billing access');
  await b.page.keyboard.press('4');
  await b.page.waitForTimeout(300);
  assert.match(b.page.url(), /\/schedule/);
  await b.page.keyboard.press('5');
  await b.page.waitForURL(/tab=notes$/);
  await b.ctx.close();
});

test('screens: the drawer in dark mode and at phone width', async () => {
  const d = await signIn(browser, app.base, { colorScheme: 'dark' });
  await d.page.evaluate(() => localStorage.setItem('dm_theme', 'dark'));
  await d.page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await d.page.waitForSelector('.cal-col-head');
  await d.page.keyboard.press('c');
  await d.page.click(card(visit.id));
  await d.page.waitForSelector('.drawer .drawer-facts');
  assert.equal(await d.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await d.page.waitForTimeout(250);
  await d.page.screenshot({ path: join(SHOTS, 'drawer-dark.png') });
  await d.ctx.close();

  const m = await signIn(browser, app.base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.page.goto(`${app.base}/schedule?date=${DAY}`);
  await m.page.waitForSelector(`.agenda [data-appt-id="${visit.id}"]`);
  await m.page.click(`.agenda [data-appt-id="${visit.id}"]`);
  await m.page.waitForSelector('.drawer .drawer-facts');
  await m.page.waitForTimeout(300);
  await m.page.screenshot({ path: join(SHOTS, 'drawer-phone.png') });
  const box = await m.page.locator('.drawer .drawer-jumps').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the buttons fit the phone (${JSON.stringify(box)})`);
  assert.ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll');
  await m.page.click('.drawer .drawer-jump:has-text("Chart")');
  await m.page.waitForURL(/tab=chart$/);
  await m.page.goBack();
  await m.page.waitForSelector('.drawer .drawer-jumps');
  assert.equal(new URL(m.page.url()).searchParams.get('date'), DAY);
  await m.ctx.close();
  console.log(`screenshots in ${SHOTS}`);
});

test('notices: ✕ hides the late list for today (after a reload too), it comes back when someone new is late, and "N hidden" restores it', async () => {
  const { page } = s;
  // A daytime hour for the practice whatever the clock says (as in the S7 test).
  const tz = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu']
    .find((z) => { const m = localNow(z)[1]; return m >= 600 && m < 1200; });
  await s.api('PUT', '/practice', { timezone: tz, send_from: '00:00', send_until: '00:00' });
  await s.api('PUT', '/schedule/late-settings', { late_minutes: 5, very_late_minutes: 30 });
  const [day, now] = localNow(tz);
  // Each late patient in a chair (and with a dentist) of their own, so the test visits never overlap.
  const mk = async (first, from, to, where = null) => {
    const w = where || { chair: await s.post('/operatories', { name: `Notice chair ${first}` }), doc: await s.post('/providers', { name: `Dr. ${first} Notice`, type: 'dentist' }) };
    const p = await s.post('/patients', { first_name: first, last_name: 'Noticetest', dob: '1980-05-06', phone: '(512) 555-0142' });
    const a = await s.post('/appointments', { patient_id: p.id, provider_id: w.doc.id, operatory_id: w.chair.id, start_time: at(day, from), end_time: at(day, to), override_blockout: true, notify: false, add_type_procedures: false });
    assert.ok(a.id, JSON.stringify(a));
    return a;
  };
  const first = await mk('Lola', now - 8, now + 20);
  await page.goto(`${app.base}/schedule?date=${day}&view=day`);
  await page.reload();
  await page.waitForSelector('.late-banner');
  const before = await s.get(`/appointments/${first.id}`);
  const lateCount = async () => Number((await page.textContent('.late-banner .late-head strong')).match(/\d+/)[0]);
  const n = await lateCount();

  const hide = await measure(page, async () => {
    await page.click('.late-banner .notice-hide');
    await page.waitForSelector('.late-banner', { state: 'detached' });
  });
  console.log(withinBudget('hide the late list', hide, { actions: 1, ms: 2000 }));
  assert.match(await page.textContent('.notices-hidden'), /1 hidden/);
  // Only hidden on this screen: the visit is exactly as it was.
  const after1 = await s.get(`/appointments/${first.id}`);
  for (const k of ['status', 'start_time', 'end_time', 'updated_at', 'broken_reason']) assert.equal(after1[k], before[k], k);

  // Still hidden after a reload (kept for this person, for today).
  await page.reload();
  await page.waitForSelector('.cal-col-head');
  await page.waitForSelector('.notices-hidden');
  assert.equal(await page.locator('.late-banner').count(), 0);

  // Someone new is late: it comes back, with both.
  await mk('Milo', now - 6, now + 30);
  await page.reload();
  await page.waitForSelector('.late-banner');
  assert.equal(await lateCount(), n + 1, 'one more patient late');
  assert.equal(await page.locator('.notices-hidden').count(), 0);

  // Hide it again, then "1 hidden" brings it back in one click.
  await page.click('.late-banner .notice-hide');
  await page.waitForSelector('.notices-hidden');
  const restore = await measure(page, async () => {
    await page.click('.notices-hidden');
    await page.waitForSelector('.late-banner');
  });
  console.log(withinBudget('show hidden notices', restore, { actions: 1, ms: 2000 }));
  assert.equal(await page.locator('.notices-hidden').count(), 0);

  // A chair running behind hides the same way and counts in the chip.
  const behind = { chair: await s.post('/operatories', { name: 'Notice test chair' }), doc: await s.post('/providers', { name: 'Dr. Nora Notice', type: 'dentist' }) };
  const q = await mk('Otto', now - 60, now - 12, behind);
  const r = await mk('Nell', now - 12, now + 20, behind);
  for (const st of ['checked_in', 'in_chair']) await s.api('PATCH', `/appointments/${q.id}/status`, { status: st });
  await s.api('PATCH', `/appointments/${r.id}/status`, { status: 'checked_in' });
  await page.reload();
  await page.keyboard.press('c');
  const head = page.locator('.cal-col-head', { hasText: 'Notice test chair' });
  await head.locator('.cal-behind').waitFor();
  await page.click('.late-banner .notice-hide');
  await head.locator('.cal-behind .behind-hide').click();
  await page.waitForFunction(() => /2 hidden/.test(document.querySelector('.notices-hidden')?.textContent || ''));
  assert.equal(await head.locator('.cal-behind').count(), 0);
  // Dark mode and a phone: the banner's ✕ and the chip look right.
  await page.click('.notices-hidden');
  await page.waitForSelector('.late-banner');
  await page.evaluate(() => { localStorage.setItem('dm_theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'late-banner-dark.png') });
  await page.click('.late-banner .notice-hide');
  await page.waitForSelector('.notices-hidden');
  await page.screenshot({ path: join(SHOTS, 'late-hidden-dark.png') });
  await page.evaluate(() => { localStorage.setItem('dm_theme', 'light'); document.documentElement.dataset.theme = 'light'; });
  await page.click('.notices-hidden');

  const m = await signIn(browser, app.base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.page.goto(`${app.base}/schedule?date=${day}`);
  await m.page.waitForSelector('.late-banner .notice-hide');
  await m.page.screenshot({ path: join(SHOTS, 'late-banner-phone.png') });
  await m.page.click('.late-banner .notice-hide');
  await m.page.waitForSelector('.notices-hidden');
  const chip = await m.page.locator('.notices-hidden').boundingBox();
  assert.ok(chip && chip.x >= 0 && chip.x + chip.width <= 390, `the chip is fully on screen on a phone (${JSON.stringify(chip)})`);
  await m.page.screenshot({ path: join(SHOTS, 'late-hidden-phone.png') });
  assert.ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll');
  await m.ctx.close();
  assert.deepEqual(s.errors, []);
});
