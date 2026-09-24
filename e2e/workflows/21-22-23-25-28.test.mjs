// Workflows 21 (build a treatment plan), 22 (present it and get it signed), 23 (consent forms), 25 (claim
// attachments) and 28 (staff tasks) — on the keyboard, within budget. Specs: docs/workflows/specs/21-…28-*.md
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let patient;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  patient = await s.post('/patients', { first_name: 'Tess', last_name: 'Planwright', dob: '1980-02-03', phone: '(512) 555-0199', email: 'tess@example.com' });
  assert.ok(patient.id, JSON.stringify(patient));
});
after(async () => { await browser?.close(); await app?.stop(); });

const plansOf = () => s.get(`/patients/${patient.id}/treatment-plans`);
const openTreatment = async () => {
  await s.page.goto(`${app.base}/patients/${patient.id}?tab=treatment`);
  await s.page.waitForSelector('h2:has-text("Treatment plans")');
};

test('#21 build a 3-procedure plan by typing: ≤ 3 per procedure + 1, named for you, no dialogs', async () => {
  const { page } = s;
  await openTreatment();
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add work to the plan');
    for (const line of ['14 D2740', '30 MO filling', '19 rct']) {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('.modal td:has-text("D3330")');
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector('.card h3:has-text("Treatment plan —")');
  });
  console.log(withinBudget('#21 build a treatment plan', r, { actions: 3 * 3 + 1, ms: 6000 }));
  const [plan] = await plansOf();
  assert.deepEqual(plan.procedures.map((p) => `${p.code} ${p.tooth}${p.surfaces ? ` ${p.surfaces}` : ''}`), ['D2740 14', 'D2392 30 MO', 'D3330 19']);
  assert.match(plan.name, /^Treatment plan — \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(s.errors, [], 'no prompt or confirm boxes');
});

test('#21 fee edited in place and a removal undone with Ctrl/⌘Z — no prompt or confirm', async () => {
  const { page } = s;
  const [plan] = await plansOf();
  const crown = plan.procedures.find((p) => p.code === 'D2740');
  await page.click('button[aria-label^="Fee for D2740 #14"]');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.type('1200');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("Fee for D2740 #14 is now")');
  assert.equal((await plansOf())[0].procedures.find((p) => p.id === crown.id).fee, 120000);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await plansOf())[0].procedures.find((p) => p.id === crown.id).fee, crown.fee);

  await page.click('button[aria-label="Remove D3330 #19 from the chart"]');
  await page.waitForSelector('.toast:has-text("D3330 #19 removed from the chart")');
  assert.equal((await plansOf())[0].procedures.length, 2);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await plansOf())[0].procedures.length, 3);
  assert.deepEqual(s.errors, []);
});

test('#21 all unplanned work onto a new plan: 1 action', async () => {
  const { page } = s;
  await s.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '17' });
  await s.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '3', surfaces: 'MO' });
  await openTreatment();
  await page.waitForSelector('button:has-text("Plan all unplanned work (2)")');
  const r = await measure(page, async () => {
    await page.keyboard.press('a');
    await page.waitForSelector('.toast:has-text("made with 2 procedures")');
  });
  console.log(withinBudget('#21 plan all unplanned', r, { actions: 1 }));
  assert.equal((await plansOf()).length, 2);
});

test('#22 present on this screen: 2 staff + 3 patient, no birth date, same tab, and back to the chart', async () => {
  const { page } = s;
  await openTreatment();
  const plan = (await plansOf()).find((p) => p.procedures.some((x) => x.code === 'D3330'));
  const pages = page.context().pages().length;
  const staff = await measure(page, async () => {
    await page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Present & e-sign")').click();
    await page.waitForSelector('.modal button:has-text("Open here for Tess to sign")');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/tp\//);
    await page.waitForSelector('h1:has-text("Your treatment plan, Tess")');
  });
  console.log(withinBudget('#22 present (staff)', staff, { actions: 2 }));
  assert.equal(page.context().pages().length, pages, 'no new tab');
  assert.doesNotMatch(page.url(), /here=/, 'the one-time code is gone from the address bar');

  const patientSide = await measure(page, async () => {
    await page.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'name');
    await page.keyboard.type('Tess Planwright');
    await page.click('label.checkbox input[type=checkbox]');
    await page.click('button:has-text("Accept & sign")');
    await page.waitForSelector('h1:has-text("Thank you")');
  });
  console.log(withinBudget('#22 accept and sign (patient)', patientSide, { actions: 3 }));
  await page.click('a:has-text("back to the chart")');
  await page.waitForURL(new RegExp(`/patients/${patient.id}\\?tab=treatment`));
  await page.waitForSelector('.badge:has-text("Signed by Tess Planwright")');

  // The hand-off can't be used again: a reload of the same plan link asks for the birth date.
  const again = await s.post(`/treatment-plans/${(await plansOf()).find((p) => !p.signed_at).id}/present`, { here: true });
  assert.equal((await s.post('/signing-passes/redeem', { code: again.handoff })).kind, 'plan');
  assert.match(JSON.stringify(await s.post('/signing-passes/redeem', { code: again.handoff })), /expired or was already used/);
  assert.deepEqual(s.errors, []);
});

test('#23 consent forms from the plan: 2 staff actions, signed here without a birth date', async () => {
  const { page } = s;
  await openTreatment();
  const plan = (await plansOf()).find((p) => p.procedures.some((x) => x.code === 'D7140'));
  const r = await measure(page, async () => {
    await page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Consent")').click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Sign here on this device');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/f\//);
    await page.waitForSelector('h1:has-text("Consent for tooth extraction")');
  });
  console.log(withinBudget('#23 consent forms (staff)', r, { actions: 2 }));
  assert.equal(await page.locator('input[type=date]').count(), 0, 'no birth-date step');
});

test('#23 consent forms for the active patient from the command bar, on any screen', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('consent');
    await page.waitForSelector('.palette-item:has-text("Consent forms for Tess Planwright")');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Sign here on this device');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/f\//);
    await page.waitForSelector('h1:has-text("Consent for tooth extraction")');
  });
  console.log(withinBudget('#23 consent forms (command bar)', r, { actions: 4 }));
});

test('#25 attach the suggested x-ray and send: 2 actions', async () => {
  const { page } = s;
  const carrier = await s.post('/carriers', { name: 'E2E Dental', payer_id: '99999' });
  const policy = await s.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Tess Planwright', subscriber_id: 'E2E1', group_number: 'G1' });
  const [provider] = await s.get('/providers?active=true');
  const proc = await s.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: provider.id, complete: true });
  assert.ok(proc.id, JSON.stringify(proc));
  const claim = await s.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  assert.ok(claim.id, JSON.stringify(claim));
  await page.evaluate(async (pid) => {
    for (const [name, tooth] of [['pa30.png', '30'], ['pa3.png', '3']]) {
      await fetch(`/api/patients/${pid}/documents?filename=${name}&category=xray&tooth=${tooth}`, { method: 'POST', headers: { Authorization: `Bearer ${window.sessionStorage.getItem('dm_token')}`, 'Content-Type': 'text/plain' }, body: 'x' });
    }
  }, patient.id);
  await page.goto(`${app.base}/claims/${claim.id}`);
  await page.waitForSelector('button:has-text("Attach 1 suggested")');
  const r = await measure(page, async () => {
    await page.click('button:has-text("Attach 1 suggested")');
    await page.waitForSelector('button:has-text("Send 1 to the payer")');
    await page.click('button:has-text("Send 1 to the payer")');
    await page.waitForSelector('td:has-text("SBX")');
  });
  console.log(withinBudget('#25 claim attachments', r, { actions: 2 }));
  const list = await s.get(`/claims/${claim.id}/attachments`);
  assert.equal(list.attachments.length, 1);
  assert.match(list.attachments[0].filename, /^pa30\./, 'the film of #30, not #3');
  assert.deepEqual(s.errors, []);
});

test('#28 a task from anywhere in 3 actions: assignee by first name, badge and note for them, done with one key and undo', async () => {
  const { page } = s;
  // Jordan (front desk) is signed in elsewhere.
  const jordan = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('task call the lab about the crown @jordan');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Task for Jordan Lee, due today")');
  });
  console.log(withinBudget('#28 staff task', r, { actions: 3 }));
  const tasks = await s.get('/tasks');
  const task = tasks.find((t) => t.title === 'call the lab about the crown');
  assert.ok(task, 'saved');
  assert.equal(task.assigned_to_name, 'Jordan Lee');
  assert.equal(task.patient_id, patient.id, 'about the active patient');
  assert.ok(task.due_date, 'due today');

  // Jordan gets a note and a badge.
  // (Counts are checked every 15 s; see QuickCommands.jsx for why it isn't a live stream.)
  await jordan.page.waitForSelector('.toast:has-text("New task from Morgan Reyes: call the lab about the crown")', { timeout: 25_000 });
  // The To-do count is in the Manage module's dropdown and rolls up onto the Manage module in the menu.
  await jordan.page.waitForSelector('a[href="/office"] .nav-badge', { state: 'attached' });
  await jordan.page.waitForSelector('.rail-mod[data-module="manage"] .rail-mod-btn .nav-badge');

  // Jordan ticks it off with one key, then undoes it.
  await jordan.page.goto(`${app.base}/office`);
  await jordan.page.waitForSelector('.task-row');
  await trackActions(jordan.page);
  const rows = await jordan.page.locator('.task-row').allTextContents();
  const idx = rows.findIndex((t) => t.includes('call the lab about the crown'));
  for (let i = 0; i < idx; i++) await jordan.page.keyboard.press('j');
  await jordan.page.waitForSelector('.task-row.task-sel:has-text("call the lab about the crown")');
  const done = await measure(jordan.page, async () => {
    await jordan.page.keyboard.press('x');
    await jordan.page.waitForSelector('.toast:has-text("Done: call the lab about the crown")');
  });
  console.log(withinBudget('#28 mark done', done, { actions: 1 }));
  assert.equal((await jordan.get('/tasks?status=done')).some((t) => t.id === task.id), true);
  await jordan.page.keyboard.press(`${MOD}+z`);
  await jordan.page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await jordan.get('/tasks')).some((t) => t.id === task.id), true, 'open again');
  assert.deepEqual(jordan.errors, []);
  await jordan.ctx.close();
});
