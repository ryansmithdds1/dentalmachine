// Guided walkthroughs ("Show me", client/src/components/tours): the overlay itself.
//  • Help → Show me lists the walkthroughs by role; search finds one; Start puts it on Tess Training.
//  • Each step lights up what to use and moves on when the person does it — by keyboard (press I: checked in) and by
//    mouse (click the lit-up Book appointment button) — and "Show me" does a step for them. Esc leaves.
//  • The command bar: "show me how to check in" starts it.
//  • A manager assigns "Front desk basics"; it's on that person's Training list, and a walkthrough done ticks it.
//  • The first-login welcome: offered once, gone when dismissed.
//  • Light and dark (TOUR_SHOTS=dir keeps the pictures).
/* global window, document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { tourState, playTour } from '../lib/tours.mjs';

const SHOTS = process.env.TOUR_SHOTS;
let app; let browser;
before(async () => {
  app = await startApp();
  browser = await launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await app?.stop(); });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const seen = (page) => page.evaluate(() => fetch('/api/me/prefs/tour.welcome', { method: 'PUT', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'seen' }) })); // eslint-disable-line no-undef
const waitStep = (page, step, sub = 0) => page.waitForFunction(([a, b]) => { const s = window.__dmTour?.state(); return s && ((s.phase === 'step' && s.step === a && s.sub === b && s.status === 'ready') || (a === -1 && s.phase === 'done')); }, [step, sub]);

for (const scheme of ['light', 'dark']) {
  test(`TOURS Help → Show me → check a patient in on Tess Training, by keyboard (${scheme})`, async () => {
    const { page, errors, ctx, get } = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app', colorScheme: scheme });
    await seen(page);
    await page.goto(`${app.base}/help?tab=showme`);
    await page.getByRole('tab', { name: 'Show me' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Show me' }).getAttribute('aria-selected'), 'true');
    await page.locator('.manual-group').first().waitFor();
    assert.match(await page.locator('.manual-group[open] summary').first().innerText(), /Front desk \(you\)/, 'my role first');
    await shot(page, `showme-list-${scheme}`);
    await page.getByLabel('Search the walkthroughs').fill('check a patient in');
    await page.locator('.showme-list button', { hasText: 'Show me' }).first().click();
    // The intro: what it is, and the practice patient.
    const intro = page.locator('.tour-callout[data-tour-phase="intro"]');
    await intro.waitFor();
    assert.match(await intro.innerText(), /How do I check a patient in\?/);
    assert.match(await intro.innerText(), /Tess Training/);
    await shot(page, `tour-intro-${scheme}`);
    await intro.getByRole('button', { name: 'Start on Tess Training' }).click();
    await waitStep(page, 0);
    const st = await tourState(page);
    assert.equal(st.id, 'A010');
    // On the schedule, Tess's visit lit up, the key shown, the box saying what to do.
    await page.waitForURL(/\/schedule/);
    // (Measured once the schedule has finished scrolling to the visit: the ring follows it.)
    const around = await page.waitForFunction((id) => {
      const ring = document.querySelector('.tour-ring')?.getBoundingClientRect();
      const card = document.querySelector(`[data-appt-id="${id}"]`)?.getBoundingClientRect();
      return !!ring && !!card && Math.abs(ring.x + 6 - card.x) < 3 && Math.abs(ring.y + 6 - card.y) < 3;
    }, st.ctx.appt, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(around, 'the ring is around the training visit');
    assert.match(await page.locator('.tour-callout .tour-do').innerText(), /Press\s*I/);
    assert.equal(await page.locator('.tour-callout [aria-live="polite"]').count(), 1, 'instructions are announced');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme);
    await shot(page, `tour-step-${scheme}`);
    // Learn by doing: the person presses I, the visit is checked in, the walkthrough ends.
    await page.keyboard.press('i');
    await waitStep(page, -1);
    await page.locator('.tour-callout .tour-done').waitFor();
    await shot(page, `tour-done-${scheme}`);
    const a = await get(`/appointments/${st.ctx.appt}`);
    assert.equal(a.status, 'checked_in', 'it really happened — on the training patient');
    await page.locator('.tour-callout').getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.locator('.tour-callout').count(), 0);
    const me = await get('/training/me');
    assert.ok(me.completed.A010, 'recorded as completed');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('TOURS by mouse (the lit-up button), "Show me" does a step, Esc leaves', async () => {
  const { page, errors, ctx, get } = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await seen(page);
  // Book an appointment: step 1 by keyboard (Alt+B), step 2 by clicking the lit-up Book appointment button.
  await page.goto(`${app.base}/`);
  await page.waitForFunction(() => !!window.__dmTour);
  await page.evaluate(() => window.__dmTour.start('A020'));
  await page.locator('.tour-callout[data-tour-phase="intro"] button.primary').click();
  await waitStep(page, 0);
  await page.keyboard.press('Alt+b');
  await waitStep(page, 1);
  const s1 = await tourState(page);
  assert.match(s1.expect.t.text || s1.expect.t.label || '', /Book appointment/);
  await shot(page, 'tour-click-step');
  // A click outside the lit-up spot doesn't go through (the page is dimmed there); the box gives a nudge.
  await page.mouse.click(5, 5);
  assert.equal((await tourState(page)).step, 1);
  const btn = await page.evaluateHandle((t) => window.__dmTour.find(t), s1.expect.t);
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitStep(page, -1);
  const tess = (await get('/training/me')).training_patient;
  const booked = await get(`/appointments?patient_id=${tess.id}&from=2000-01-01&to=2100-01-01`);
  assert.ok(booked.length >= 1, 'booked for Tess');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tour-callout').count(), 0, 'Esc closes the finished walkthrough');

  // Seat a patient: "Show me" does it.
  await page.evaluate(() => window.__dmTour.start('A012'));
  await page.locator('.tour-callout[data-tour-phase="intro"] button.primary').click();
  await waitStep(page, 0);
  const seat = await tourState(page);
  await page.locator('.tour-callout').getByRole('button', { name: 'Show me' }).click();
  await waitStep(page, -1);
  assert.equal((await get(`/appointments/${seat.ctx.appt}`)).status, 'in_chair', 'Show me did the step');
  await page.locator('.tour-callout').getByRole('button', { name: 'Close' }).click();

  // Esc leaves part-way, and the record says so.
  await page.evaluate(() => window.__dmTour.start('A002'));
  await page.locator('.tour-callout[data-tour-phase="intro"] button.primary').click();
  await waitStep(page, 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tour-callout').count(), 0);
  assert.equal(await page.locator('.tour-layer').count(), 0);
  const recent = (await get('/training/me')).recent;
  assert.equal(recent.find((r) => r.tour_id === 'A002')?.status, 'exited');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('TOURS the command bar: "show me how to check in" starts it; a manual page has Show me', async () => {
  const { page, errors, ctx } = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await seen(page);
  await page.goto(`${app.base}/schedule`);
  await page.locator('.rail-mod').first().waitFor();
  await page.keyboard.press(`${MOD}+k`);
  await page.locator('.palette input').waitFor();
  await page.keyboard.type('show me how to check in');
  const row = page.locator('.palette-item', { hasText: 'check a patient in' }).first();
  await row.waitFor();
  await row.click();
  await page.locator('.tour-callout[data-tour-phase="intro"]').waitFor();
  assert.equal((await tourState(page)).id, 'A010');
  await page.keyboard.press('Escape');
  await page.goto(`${app.base}/help?how=A010`);
  await page.getByRole('button', { name: 'Show me' }).click();
  await page.locator('.tour-callout[data-tour-phase="intro"]').waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('TOURS a manager assigns Front desk basics; it is on the front desk’s Training list and a finished walkthrough ticks it', async () => {
  const admin = await signIn(browser, app.base, { email: 'admin@demo.dentalmachine.app' });
  await seen(admin.page);
  await admin.page.goto(`${app.base}/training?tab=team`);
  const row = admin.page.locator('tr', { hasText: 'Front Desk' }).first();
  await row.waitFor();
  const userId = await row.getAttribute('data-person');
  await row.getByRole('button', { name: 'Assign' }).click();
  const form = admin.page.locator('form[aria-label^="Assign training"]');
  await form.getByLabel('Training set').selectOption('front-desk-basics');
  await shot(admin.page, 'training-team-assign');
  await form.getByRole('button', { name: 'Assign' }).click();
  await admin.page.locator(`tr[data-person="${userId}"]`, { hasText: 'Front desk basics' }).waitFor();
  assert.deepEqual(admin.errors, []);
  await admin.ctx.close();

  const desk = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await seen(desk.page);
  await desk.page.goto(`${app.base}/training`);
  const card = desk.page.locator('.card[data-assignment]', { hasText: 'Front desk basics' });
  await card.waitFor();
  const before = Number((await card.getAttribute('data-assignment')) && (await card.locator('strong').last().innerText()).replace('%', ''));
  await shot(desk.page, 'training-mine');
  // Start from the list, play the first walkthrough to the end.
  await card.getByRole('button', { name: /Start|Continue/ }).click();
  await desk.page.locator('.tour-callout[data-tour-phase="intro"] button.primary').click();
  await playTour(desk.page);
  await desk.page.locator('.tour-callout').getByRole('button', { name: /Next walkthrough|Close/ }).first().waitFor();
  await desk.page.keyboard.press('Escape');
  await desk.page.goto(`${app.base}/training`);
  const after = Number((await desk.page.locator('.card[data-assignment]', { hasText: 'Front desk basics' }).locator('strong').last().innerText()).replace('%', ''));
  assert.ok(after > before, `progress moved (${before}% → ${after}%)`);
  assert.deepEqual(desk.errors, []);
  await desk.ctx.close();
});

test('TOURS the first-login welcome is offered once and gone when dismissed', async () => {
  const { page, errors, ctx } = await signIn(browser, app.base, { email: 'billing@demo.dentalmachine.app' });
  await page.goto(`${app.base}/`);
  const hello = page.locator('.tour-welcome');
  await hello.waitFor();
  assert.match(await hello.innerText(), /Take the 3-minute tour for your role/);
  await shot(page, 'welcome');
  await hello.getByRole('button', { name: 'Not now' }).click();
  await hello.waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('.rail-mod').first().waitFor();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.tour-welcome').count(), 0, 'not offered again');
  assert.deepEqual(errors, []);
  await ctx.close();
});
