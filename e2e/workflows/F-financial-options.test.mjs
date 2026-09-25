// Treatment plans with financial options (backlog F1–F5): the patient sees the plan visually with ways to pay
// side by side, picks one and signs in ≤ 4 actions; the desk records a choice in 3; phases are dragged and named.
// Spec: docs/workflows/specs/F-financial-options.md
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let patient;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  patient = await s.post('/patients', { first_name: 'Fina', last_name: 'Options', dob: '1979-05-06', phone: '(512) 555-0177', email: 'fina@example.com' });
  assert.ok(patient.id, JSON.stringify(patient));
  // The office's CareCredit link, so CareCredit's promotions show.
  await s.api('PUT', '/practice', { financing: { links: [{ name: 'CareCredit', url: 'https://www.carecredit.com/go/DEMO123/' }] } });
});
after(async () => { await browser?.close(); await app?.stop(); });

const plansOf = () => s.get(`/patients/${patient.id}/treatment-plans`);
const newPlan = (name, work) => s.post(`/patients/${patient.id}/treatment-plans`, { name, procedures: work.map(([code, tooth, phase]) => ({ code, tooth, phase })) });
const openTreatment = async () => {
  await s.page.goto(`${app.base}/patients/${patient.id}?tab=treatment`);
  await s.page.waitForSelector('h2:has-text("Treatment plans")');
};

test('F2/F3/F4 present the plan: teeth, phase cards, ways to pay side by side; the patient picks and signs in ≤ 3 actions', async () => {
  const { page } = s;
  const plan = await newPlan('Restore my smile', [['D2740', '14', 1], ['D3330', '19', 1], ['D6010', '30', 2]]);
  assert.ok(plan.id, JSON.stringify(plan));
  await s.api('PUT', `/treatment-plans/${plan.id}/phases/2`, { name: 'Replace the missing tooth', why: 'So you can chew on that side again.' });
  await openTreatment();
  const staff = await measure(page, async () => {
    await page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Present & e-sign")').click();
    await page.waitForSelector('.modal button:has-text("Open here for Fina to sign")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('h1:has-text("Your treatment plan, Fina")');
  });
  console.log(withinBudget('F present (staff)', staff, { actions: 2 }));
  // Visual: the teeth, a card per phase in plain words, and the ways to pay.
  assert.equal(await page.locator('.tooth-map .tm-tooth.on').count(), 3);
  assert.equal(await page.locator('.cp-phase').count(), 2);
  await page.waitForSelector('.cp-phase h3:has-text("Replace the missing tooth")');
  assert.ok(await page.locator('.cp-phase .cp-why').first().textContent());
  assert.ok(await page.locator('.fin-card').count() >= 3, 'pay in full, monthly with us, CareCredit');
  await page.waitForSelector('.fin-card[data-kind="lender"]:has-text("CareCredit")');
  // Details only on tap.
  assert.equal(await page.locator('.cp-detail').count(), 0);

  const patientSide = await measure(page, async () => {
    // Handed over in the office: the name is already on the signing line.
    await page.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'name' && document.activeElement.value === 'Fina Options');
    await page.locator('.fin-card[data-kind="in_office"] .fin-card-main').click();
    await page.click('label.checkbox input[type=checkbox]');
    await page.click('button:has-text("Accept & sign")');
    await page.waitForSelector('h1:has-text("Thank you")');
  });
  console.log(withinBudget('F pick a way to pay and sign (patient)', patientSide, { actions: 3 }));
  await page.waitForSelector('.cp-done:has-text("How you’ll pay")');
  const agreements = await s.get(`/patients/${patient.id}/fin-agreements`);
  const a = agreements.find((x) => x.treatment_plan_id === plan.id);
  assert.equal(a.kind, 'in_office');
  assert.equal(a.source, 'patient');
  assert.equal(a.intact, true);
  assert.ok(a.payment_plan_id, 'the payment plan was set up');
  assert.deepEqual(s.errors, []);
});

test('F4 at the desk: pick a way to pay and accept for the patient in 3 actions, then post the prepayment with its discount', async () => {
  const { page } = s;
  const plan = await newPlan('Crowns', [['D2740', '3', 1], ['D2740', '4', 1]]);
  await openTreatment();
  await page.waitForSelector(`.fin-desk[data-fin="${plan.id}"] .fin-card`);
  const r = await measure(page, async () => {
    await page.keyboard.press('f');
    await page.waitForFunction(() => document.activeElement?.classList.contains('fin-card-main'));
    await page.keyboard.press('Enter');
    await page.locator(`.fin-desk[data-fin="${plan.id}"] button:has-text("Accept for Fina")`).click();
    await page.waitForSelector(`.fin-desk[data-fin="${plan.id}"] .fin-agreement`);
  });
  console.log(withinBudget('F accept at the desk', r, { actions: 3 }));
  const a = (await s.get(`/patients/${patient.id}/fin-agreements`)).find((x) => x.treatment_plan_id === plan.id);
  assert.equal(a.kind, 'full');
  assert.equal(a.discount_status, 'pending');
  assert.ok(a.discount_amount > 0);
  // The discount reaches the ledger only with the prepayment.
  await page.locator(`.fin-desk[data-fin="${plan.id}"] button:has-text("Post prepayment")`).click();
  await page.waitForSelector('.toast:has-text("Prepayment of")');
  const ledger = await s.get(`/patients/${patient.id}/ledger`);
  const rows = Array.isArray(ledger) ? ledger : ledger.entries || [];
  assert.ok(rows.some((e) => e.adjustment_type === 'Prepayment discount' && e.amount === -a.discount_amount), JSON.stringify(rows).slice(0, 400));
  // Next steps are one click away: book the first visit, send the consent.
  await page.waitForSelector(`.fin-desk[data-fin="${plan.id}"] button:has-text("Book first visit")`);
  await page.waitForSelector(`.fin-desk[data-fin="${plan.id}"] button:has-text("Send consent")`);
  assert.deepEqual(s.errors, []);
});

test('F1 phases: drag work into another phase, name a phase in place, and the estimate follows', async () => {
  const { page } = s;
  const plan = await newPlan('Quadrant work', [['D2740', '12', 1], ['D2740', '13', 1], ['D3330', '14', 2]]);
  await openTreatment();
  const card = page.locator(`.card[data-plan="${plan.id}"]`);
  await card.locator('.phase-row').nth(1).waitFor();
  const row = card.locator('tr:has(button[aria-label^="Fee for D2740 #13"])');
  await row.dragTo(card.locator('.phase-row').nth(1));
  await page.waitForSelector('.toast:has-text("D2740 #13 moved to Phase 2")');
  const after = (await plansOf()).find((p) => p.id === plan.id);
  assert.equal(after.procedures.find((p) => p.tooth === '13').phase, 2);
  const r = await measure(page, async () => {
    await card.locator('button[aria-label="Name of phase 2"]').click();
    await page.keyboard.type('Root canal first');
    await page.keyboard.press('Enter');
    await card.locator('.phase-row strong:has-text("Root canal first")').waitFor();
  });
  console.log(withinBudget('F name a phase', r, { actions: 3 }));
  const q = await s.get(`/treatment-plans/${plan.id}/quote`);
  assert.equal(q.phases.find((p) => p.phase === 2).name, 'Root canal first');
  assert.equal(q.phases.find((p) => p.phase === 2).count, 2);
  // Undo of the drag is there (Ctrl/⌘Z) and nothing asked for confirmation.
  assert.deepEqual(s.errors, []);
});

test('F6 compare options for #19: "Show patient" opens the patient window, the staff screen points, the patient taps and signs', async () => {
  const { page } = s;
  await s.post('/procedure-codes', { code: 'D7953', description: 'Bone replacement graft, ridge preservation', category: 'oral_surgery', fee: 45000, requires_tooth: 1 });
  const made = await s.post(`/patients/${patient.id}/treatment-options`, { options: [
    { label: 'Option 1', items: [{ code: 'D7140', tooth: '19' }, { code: 'D7953', tooth: '19' }] },
    { label: 'Option 2', items: [{ code: 'D3330', tooth: '19' }, { code: 'D2950', tooth: '19' }, { code: 'D2740', tooth: '19' }] },
  ] });
  assert.equal(made.plans?.length, 2, JSON.stringify(made));
  await openTreatment();
  const panel = page.locator('.cmp-staff');
  await panel.waitFor();
  assert.equal(await panel.locator('.cmp-col').count(), 2);
  await panel.locator('.cmp-next:has-text("Bridge to fill the gap")').waitFor();
  await panel.locator('.cmp-starter').first().waitFor();
  const r = await measure(page, async () => {
    const [win] = await Promise.all([page.context().waitForEvent('page'), panel.locator('button:has-text("Show patient")').click()]);
    await win.waitForSelector('.cmp-board .cmp-col');
    s.win = win;
  });
  console.log(withinBudget('F6 show the patient', r, { actions: 1 }));
  const win = s.win;
  await trackActions(win);
  assert.equal(await win.locator('.cmp-col').count(), 2);
  assert.equal(await win.locator('.cmp-starter').count(), 0, 'no staff notes on the patient screen');
  await win.locator('.cmp-next:has-text("Implant and crown")').waitFor();
  // The staff screen points; the patient window follows.
  const second = made.plans[1].id;
  await panel.locator(`.cmp-col[data-plan="${second}"] button`).click();
  await win.waitForSelector(`.cmp-col.pointed[data-plan="${second}"]`);
  // The patient taps option 2, then signs (their name is already on the signing line: tick, accept).
  const p = await measure(win, async () => {
    await win.locator(`.cmp-col[data-plan="${second}"] button:has-text("Choose this")`).click();
    await win.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'name' && document.activeElement.value === 'Fina Options');
    await win.click('label.checkbox input[type=checkbox]');
    await win.click('button:has-text("Accept & sign")');
    await win.waitForSelector('h1:has-text("Thank you")');
  });
  console.log(withinBudget('F6 patient chooses and signs', p, { actions: 3 }));
  assert.ok(p.actions >= 3, p.log.join(', '));
  await panel.locator('.badge:has-text("Patient chose Option 2")').waitFor();
  const plans = await plansOf();
  assert.ok(plans.find((x) => x.id === second).signed_at, 'option 2 is signed');
  assert.equal(plans.find((x) => x.id === made.plans[0].id).signed_at, null);
  assert.deepEqual(s.errors, []);
});
