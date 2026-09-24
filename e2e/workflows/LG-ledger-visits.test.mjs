// Ledger colour coding and the ledger by visit (owner request): every line is colour coded by kind with a
// named chip and a colour key, in light and dark; clicking a line lights up its visit; "By visit" shows each
// visit's charges, claim and payments with what's left (from the ledger); an unapplied payment is applied to a
// visit inline — click "Apply to visit…", Enter (2 actions) — with Undo in the toast.
// SHOTS_DIR=/some/dir saves light and dark screenshots for a person to look at.
/* global document, getComputedStyle */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let visit; let pay; let charges;
const shots = process.env.SHOTS_DIR;
const shot = async (page, name) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  // A patient not on today's schedule, with a visit early today (two procedures, completed → two charges), a
  // courtesy discount and a cash payment nobody has applied to a visit yet.
  const today = (await s.get('/appointments')).map((a) => a.patient_id);
  const list = await s.get('/patients?limit=50');
  const pick = (list.rows || list).filter((p) => !today.includes(p.id)).at(-1);
  const dentist = (await s.get('/providers')).find((p) => p.type === 'dentist');
  const practiceDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  visit = await s.post('/appointments', { patient_id: pick.id, provider_id: dentist.id, start_time: `${practiceDay} 05:00`, end_time: `${practiceDay} 05:30`, reason: 'Ledger visit', override_blockout: true });
  assert.ok(visit.id, JSON.stringify(visit));
  for (const code of ['D0120', 'D1110']) {
    const p = await s.post(`/patients/${pick.id}/procedures`, { code, appointment_id: visit.id, provider_id: dentist.id });
    await s.post(`/procedures/${p.id}/complete`, { appointment_id: visit.id });
  }
  await s.post(`/patients/${pick.id}/adjustments`, { amount: -500, description: 'Courtesy discount', adjustment_type: 'Courtesy discount' });
  const wrong = (await s.post(`/patients/${pick.id}/payments`, { amount: 700, method: 'check' })).entry;
  await s.post(`/ledger/${wrong.id}/void`, { reason: 'Posted twice' });
  pay = (await s.post(`/patients/${pick.id}/payments`, { amount: 2000, method: 'cash' })).entry;
  assert.ok(pay?.id);
  patient = await s.get(`/patients/${pick.id}`);
  const led = await s.get(`/patients/${pick.id}/ledger`);
  charges = led.entries.filter((e) => e.type === 'charge' && e.visit_key === `a${visit.id}`);
  assert.equal(charges.length, 2, 'both charges are on the visit');
  await s.api('PUT', '/me/prefs/ledger.view', { value: 'date' });
});
after(async () => { await browser?.close(); await app?.stop(); });

const barColor = (page, sel) => page.$eval(sel, (tr) => getComputedStyle(tr.querySelector('td')).boxShadow);

test('colour coding: a bar and a named chip per kind, a colour key, in light and dark', async () => {
  const { page } = s;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${app.base}/patients/${patient.id}?tab=ledger`);
    await page.waitForSelector('.ledger-legend');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme);
    const legend = await page.textContent('.ledger-legend');
    for (const k of ['Charge', 'Patient payment', 'Insurance payment', 'Insurance write-off', 'Discount / credit', 'Refund', 'Voided / reversed']) assert.ok(legend.includes(k), `${k} in the key`);
    const chargeRow = `tr.lrow.k-charge[data-entry="${charges[0].id}"]`;
    const payRow = `tr.lrow.k-patient-pay[data-entry="${pay.id}"]`;
    await page.waitForSelector(chargeRow);
    await page.waitForSelector(payRow);
    assert.ok(await page.locator('tr.lrow.k-discount').count() > 0, 'the discount is coloured as one');
    // A voided payment and its reversal: muted and struck through, named as such.
    assert.equal(await page.locator('tr.lrow.k-void').count() >= 2, true);
    assert.match(await page.textContent('tr.lrow.k-void .kind-chip'), /voided|reversal/);
    assert.match(await page.$eval('tr.lrow.k-void td:nth-child(3)', (td) => getComputedStyle(td).textDecorationLine), /line-through/);
    assert.equal((await page.textContent(`${payRow} .kind-chip`)).trim(), 'Patient payment', 'named, not colour alone');
    const [c, p] = [await barColor(page, chargeRow), await barColor(page, payRow)];
    assert.match(c, /inset/);
    assert.notEqual(c, p, 'charges and payments have different colours');
    await shot(page, `ledger-by-date-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
});

test('clicking a line lights up its visit; By visit shows what is left on each visit, from the ledger', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=ledger`);
  await page.click(`tr.lrow[data-entry="${charges[0].id}"] td:nth-child(3)`);
  await page.waitForSelector('.focus-bar');
  assert.match(await page.textContent('.focus-bar'), /Ledger visit/);
  assert.equal(await page.locator('tr.lrow.related').count(), 2, 'both charges of the visit light up');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.focus-bar', { state: 'detached' });

  await page.click('.seg button:has-text("By visit")');
  const group = `tbody.visit-group[data-visit="a${visit.id}"]`;
  await page.waitForSelector(group);
  const led = await s.get(`/patients/${patient.id}/ledger`);
  const v = led.visits.find((x) => x.key === `a${visit.id}`);
  assert.equal(v.balance, charges.reduce((sum, e) => sum + e.amount, 0), 'the visit is its charges until something is applied');
  assert.equal(Number(await page.getAttribute(`${group} .visit-left`, 'data-left')), v.balance);
  assert.match(await page.textContent(`${group} .visit-head`), /Left on this visit/);
  assert.ok(await page.locator(`tbody.visit-group.unapplied tr[data-entry="${pay.id}"]`).count(), 'the payment waits under Not applied to a visit');
  const total = led.visits.reduce((sum, x) => sum + x.balance, 0) + (led.not_applied?.balance || 0);
  assert.equal(total, led.balance, 'the visits add up to the balance');
  // The choice is remembered for this person.
  await page.waitForTimeout(300);
  assert.equal((await s.get('/me/prefs'))['ledger.view'], 'visit');
  await shot(page, 'ledger-by-visit-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(150);
  await shot(page, 'ledger-by-visit-dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

test('apply an unapplied payment to the visit: Apply to visit…, Enter — 2 actions, then Undo puts it back', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=ledger`);
  const group = `tbody.visit-group[data-visit="a${visit.id}"]`;
  await page.waitForSelector(group);
  const before = Number(await page.getAttribute(`${group} .visit-left`, 'data-left'));
  const r = await measure(page, async () => {
    await page.click(`tr[data-entry="${pay.id}"] button:has-text("Apply to visit")`);
    await page.waitForFunction(() => document.activeElement?.textContent === 'Apply');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${group} tr[data-entry="${pay.id}"]`);
  });
  console.log(withinBudget('Apply a payment to a visit', r, { actions: 2, ms: 5000 }));
  assert.equal(Number(await page.getAttribute(`${group} .visit-left`, 'data-left')), before - 2000, 'what is left on the visit drops by the payment');
  const led = await s.get(`/patients/${patient.id}/ledger`);
  assert.equal(led.entries.find((e) => e.id === pay.id).applied_to_id, led.visits.find((x) => x.key === `a${visit.id}`).anchor_id);
  assert.equal(led.entries.find((e) => e.id === pay.id).amount, -2000, 'the amount never changes');
  assert.equal(await page.locator('.modal').count(), 0, 'no dialog');
  await shot(page, 'ledger-applied-light');

  // Undo from the toast takes it off the visit again.
  await page.click('.toast button:has-text("Undo")');
  await page.waitForSelector(`tbody.visit-group.unapplied tr[data-entry="${pay.id}"]`);
  assert.equal((await s.get(`/patients/${patient.id}/ledger`)).entries.find((e) => e.id === pay.id).applied_to_id, null);
});
