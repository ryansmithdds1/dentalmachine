// Predictions (docs/predictions.md): the schedule shows a visit's no-show percentage (card, hover card, visit panel)
// and Billing → Ready to approve shows each claim's denial percentage — the chance something on it is denied, with its
// riskiest line — with the reasons in plain words; Reports → Prediction accuracy switches between what staff saw and
// the backtest. Predictions only inform — nothing is cancelled, moved or held. Screens in light and dark are saved to
// SHOTS_DIR (default <tmp>/dm-shots) for a person to look at.
/* global localStorage, document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp, launch, signIn } from '../lib/server.mjs';

let app; let browser; let s; let DAY; let doc; let chair; let risky; let visit; let target; let hist; let hp;
const SHOTS = process.env.SHOTS_DIR || join(tmpdir(), 'dm-shots');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekday = (d) => { let x = d; while ([0, 6].includes(new Date(`${x}T12:00:00Z`).getUTCDay())) x = addDays(x, 1); return x; };
const card = (id) => `.cal [data-appt-id="${id}"]`;

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // Open every day, so past and future test visits all fit the hours.
  const open = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['07:00', '19:00']]]));
  await s.api('PUT', '/practice', { office_hours: open });
  DAY = weekday(addDays(today, 1)); // within the confirmation window, so "not confirmed yet" counts
  doc = await s.post('/providers', { name: 'Dr. Paula Predict', type: 'dentist' });
  chair = await s.post('/operatories', { name: 'Prediction chair' });
  // A patient who has missed three visits this year (and came once before that), booked tomorrow, not confirmed.
  risky = await s.post('/patients', { first_name: 'Nora', last_name: 'Noshow', dob: '1984-02-03', phone: '(512) 555-0161' });
  const book = (patient, date, time = '10:00', end = '11:00') => s.post('/appointments', { patient_id: patient, provider_id: doc.id, operatory_id: chair.id, start_time: `${date} ${time}`, end_time: `${date} ${end}`, override_blockout: true, notify: false, reason: 'Prediction test' });
  const kept = await book(risky.id, addDays(today, -200));
  assert.ok(kept.id, JSON.stringify(kept));
  assert.ok((await s.api('PATCH', `/appointments/${kept.id}/status`, { status: 'completed' })).id);
  for (const d of [-120, -70, -25]) {
    const a = await book(risky.id, addDays(today, d));
    const r = await s.api('PATCH', `/appointments/${a.id}/status`, { status: 'no_show', broken_reason: 'no_contact' });
    assert.equal(r.status, 'no_show', JSON.stringify(r));
  }
  visit = await book(risky.id, DAY);
  assert.ok(visit.id, JSON.stringify(visit));

  // Denial history: four D2950 claims this payer denied, then a new D2950 for another patient, ready to approve.
  const carrier = await s.post('/carriers', { name: 'Predict Dental', payer_id: '99997' });
  hist = await s.post('/patients', { first_name: 'Hal', last_name: 'History', dob: '1970-01-01' });
  hp = await s.post(`/patients/${hist.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Hal History', subscriber_id: 'PH1', group_number: 'G1' });
  for (const tooth of ['3', '14', '19', '30']) {
    const pr = await s.post(`/patients/${hist.id}/procedures`, { code: 'D2950', tooth, provider_id: doc.id, complete: true });
    const c = await s.post('/claims', { patient_insurance_id: hp.id, procedure_ids: [pr.id] });
    assert.ok(c.id, JSON.stringify(c));
    await s.post(`/claims/${c.id}/submit`, {});
    const d = await s.post(`/claims/${c.id}/deny`, { reason: 'Narrative required' });
    assert.equal(d.status, 'denied', JSON.stringify(d));
  }
  target = await s.post('/patients', { first_name: 'Dee', last_name: 'Denyable', dob: '1979-07-07' });
  await s.post(`/patients/${target.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Dee Denyable', subscriber_id: 'PD1', group_number: 'G1' });
  assert.ok((await s.post(`/patients/${target.id}/procedures`, { code: 'D2950', tooth: '18', provider_id: doc.id, complete: true })).id);
  // A second line on the same claim, so the claim's own percentage (at least one line denied) differs from the line's.
  assert.ok((await s.post(`/patients/${target.id}/procedures`, { code: 'D2391', tooth: '19', surfaces: 'O', provider_id: doc.id, complete: true })).id);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('schedule: the visit card, hover card and visit panel show the no-show percentage and why', async () => {
  const { page } = s;
  const sched = await s.get(`/schedule?from=${DAY}`);
  const risk = sched.appointments.find((a) => a.id === visit.id)?.no_show_risk;
  assert.ok(risk && risk.percent > 0 && risk.percent < 100, JSON.stringify(risk));
  assert.notEqual(risk.level, 'low', JSON.stringify(risk));
  assert.match(risk.reasons.join(' '), /3 missed visits in the past year/);

  await page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await page.waitForSelector(card(visit.id));
  // On the card: a small percentage, because it's higher than usual.
  const chip = page.locator(`${card(visit.id)} .cc-risk`);
  await chip.waitFor();
  assert.equal(await chip.getAttribute('data-noshow-risk'), String(risk.percent));
  // Hover card.
  await page.hover(card(visit.id));
  await page.waitForSelector('.hover-card [data-noshow-risk]');
  assert.match(await page.textContent('.hover-card'), new RegExp(`No-show risk ${risk.percent}%`));
  await page.screenshot({ path: join(SHOTS, 'predict-hover-light.png') });
  await page.mouse.move(5, 5);
  // Visit panel.
  await page.click(card(visit.id));
  await page.waitForSelector('.drawer .drawer-noshow');
  const text = await page.textContent('.drawer .drawer-noshow');
  assert.match(text, new RegExp(`No-show risk ${risk.percent}% — .*3 missed visits in the past year`));
  await page.locator('.drawer').screenshot({ path: join(SHOTS, 'predict-drawer-light.png') });
  // Informs only: the visit is still just scheduled.
  assert.equal((await s.get(`/appointments/${visit.id}`)).status, 'scheduled');
  assert.deepEqual(s.errors, []);
});

test('Ready to approve: each claim shows the chance something on it is denied, its riskiest line, and the payer’s history', async () => {
  const { page } = s;
  const q = await s.get('/claim-queue');
  const g = q.groups.find((x) => x.patient_id === target.id);
  assert.ok(g?.denial?.claim, JSON.stringify(g));
  assert.match(g.denial.claim.reasons.join(' '), /Predict Dental has denied 4 of 4 D2950/);
  const c = g.denial.claim;
  assert.equal(c.line_count, 2);
  assert.equal(c.riskiest.code, 'D2950');
  assert.ok(c.percent >= c.riskiest.percent, JSON.stringify(c));
  await page.goto(`${app.base}/claims?tab=approve`);
  const row = page.locator('tr.wl-row', { hasText: 'Dee Denyable' });
  await row.waitFor();
  const chip = row.locator('[data-denial-risk]');
  assert.equal(await chip.getAttribute('data-denial-risk'), String(g.denial.claim.percent));
  assert.match(await chip.textContent(), new RegExp(`(Likely denied:|Denial risk) ${g.denial.claim.percent}%`));
  assert.match(await chip.locator('.risk-chip').getAttribute('title'), new RegExp(`Claim: ${c.percent}% chance at least one line is denied \\(riskiest line D2950 #18 ${c.riskiest.percent}%\\)`));
  await row.click();
  await page.waitForSelector('.wl-detail .denial-lines');
  const detail = await page.textContent('.wl-detail .denial-lines');
  assert.match(detail, new RegExp(`Claim: ${c.percent}% chance something is denied · riskiest line D2950 #18 ${c.riskiest.percent}%`));
  assert.match(detail, /Predict Dental has denied 4 of 4 D2950/);
  await page.screenshot({ path: join(SHOTS, 'predict-approve-light.png') });
  // Nothing was made or held by the prediction: still waiting for a person.
  assert.equal((await s.get(`/claims?patient_id=${target.id}&limit=5`)).length, 0);
  assert.deepEqual(s.errors, []);
});

test('claim screen: a draft claim’s checks show the claim-level chance and its riskiest line', async () => {
  const { page } = s;
  const a = await s.post(`/patients/${hist.id}/procedures`, { code: 'D2950', tooth: '2', provider_id: doc.id, complete: true });
  const b = await s.post(`/patients/${hist.id}/procedures`, { code: 'D2391', tooth: '4', surfaces: 'O', provider_id: doc.id, complete: true });
  const claim = await s.post('/claims', { patient_insurance_id: hp.id, procedure_ids: [a.id, b.id] });
  assert.ok(claim.id, JSON.stringify(claim));
  const v = await s.get(`/claims/${claim.id}/validate`);
  const c = v.denial.claim;
  assert.equal(c.riskiest.code, 'D2950');
  await page.goto(`${app.base}/claims/${claim.id}`);
  await page.waitForSelector('.claim-denial .claim-denial-line');
  assert.match(await page.textContent('.claim-denial'), new RegExp(`Claim: ${c.percent}% chance something is denied · riskiest line D2950 #2 ${c.riskiest.percent}%`));
  await page.locator('.claim-denial').screenshot({ path: join(SHOTS, 'predict-claim-light.png') });
  assert.deepEqual(s.errors, []);
});

test('treatment plan: a planned procedure this payer often denies shows its denial percentage', async () => {
  const { page } = s;
  const plan = await s.post(`/patients/${target.id}/treatment-plans`, { name: 'Buildups', procedures: [{ code: 'D2950', tooth: '31', provider_id: doc.id }] });
  assert.ok(plan.id, JSON.stringify(plan));
  await page.goto(`${app.base}/patients/${target.id}?tab=treatment`);
  const chip = page.locator('[data-denial-risk]').first();
  await chip.waitFor();
  assert.match(await chip.textContent(), /(Likely denied:|Denial risk) \d+%/);
  await page.screenshot({ path: join(SHOTS, 'predict-txplan-light.png') });
  assert.deepEqual(s.errors, []);
});

test('Reports → Prediction accuracy: what staff saw or the backtest, predicted next to what happened', async () => {
  const { page } = s;
  // The earlier tests showed predictions to this person; they were noted (none has an outcome yet: the visit is ahead).
  const acc = await s.get('/predict/accuracy?kind=no_show&months=6');
  assert.equal(acc.source, 'backtest', 'too few shown predictions with an outcome yet, so the backtest is the default');
  await page.goto(`${app.base}/reports?tab=predictions`);
  await page.waitForSelector('.prediction-accuracy');
  const settled = () => page.waitForFunction(() => !document.querySelector('.prediction-accuracy')?.textContent.includes('Working it out'));
  await settled();
  const staff = page.locator('[data-accuracy-source="logged"]');
  const back = page.locator('[data-accuracy-source="backtest"]');
  assert.equal(await back.getAttribute('aria-pressed'), 'true');
  assert.match(await page.textContent('.prediction-accuracy'), /predicted .* on average, actually|Not enough history/);
  await page.waitForSelector('[data-accuracy-note="few-logged"]');
  await page.screenshot({ path: join(SHOTS, 'predict-accuracy-light.png') });
  // Switch to what staff saw (keyboard: the toggle is a button).
  await staff.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-accuracy-source="logged"]')?.getAttribute('aria-pressed') === 'true');
  await settled();
  assert.match(await page.textContent('.prediction-accuracy'), /shown to staff in this period have an outcome yet|predicted .* on average, actually/);
  await page.screenshot({ path: join(SHOTS, 'predict-accuracy-staff-light.png') });
  // The spreadsheet of what staff saw.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /What staff saw \(CSV\)/ }).click()]);
  assert.match(dl.suggestedFilename(), /^predictions-no_show/);
  await back.click();
  await page.waitForFunction(() => document.querySelector('[data-accuracy-source="backtest"]')?.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(s.errors, []);
});

test('screens in dark mode: schedule hover and panel, Ready to approve', async () => {
  const d = await signIn(browser, app.base, { colorScheme: 'dark' });
  await d.page.evaluate(() => localStorage.setItem('dm_theme', 'dark'));
  await d.page.goto(`${app.base}/schedule?date=${DAY}&view=day`);
  await d.page.waitForSelector(card(visit.id));
  assert.equal(await d.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await d.page.hover(card(visit.id));
  await d.page.waitForSelector('.hover-card [data-noshow-risk]');
  await d.page.screenshot({ path: join(SHOTS, 'predict-hover-dark.png') });
  await d.page.mouse.move(5, 5);
  await d.page.click(card(visit.id));
  await d.page.waitForSelector('.drawer .drawer-noshow');
  await d.page.locator('.drawer').screenshot({ path: join(SHOTS, 'predict-drawer-dark.png') });
  await d.page.goto(`${app.base}/claims?tab=approve`);
  const row = d.page.locator('tr.wl-row', { hasText: 'Dee Denyable' });
  await row.waitFor();
  await row.click();
  await d.page.waitForSelector('.wl-detail .denial-lines .claim-denial-line');
  await d.page.screenshot({ path: join(SHOTS, 'predict-approve-dark.png') });
  await d.page.goto(`${app.base}/reports?tab=predictions`);
  await d.page.waitForSelector('.prediction-accuracy');
  await d.page.waitForFunction(() => !document.querySelector('.prediction-accuracy')?.textContent.includes('Working it out'));
  await d.page.screenshot({ path: join(SHOTS, 'predict-accuracy-dark.png') });
  assert.deepEqual(d.errors, []);
  await d.ctx.close();
});
