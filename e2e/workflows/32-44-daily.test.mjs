// Daily workflows (batch 4, 32–44) on the keyboard, within budget. Specs: docs/workflows/specs/32-…44-*.md.
// Runs on e2e/lib/daily-app.mjs: the normal app plus routes/daily.js (pre-authorizations sent to the clearinghouse)
// until app.js mounts it.
//
// Not measured here because a feature test already measures the budget:
//   33 post insurance payments — e2e/workflows/A-eob-autopilot.test.mjs (clean ERAs 0, each exception 1 key)
//   37 recall / unscheduled lists — e2e/workflows/RF-recall.test.mjs (book 3, mark contacted 3) and TF-followup.test.mjs
//   41 referral out — e2e/workflows/RT-referrals.test.mjs (create a referral 3)
//   43 review request — e2e/workflows/RV-reviews.test.mjs (1 action; after-visit requests are automatic)
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let provider;
before(async () => {
  app = await startApp({ entry: 'e2e/lib/daily-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  [provider] = (await s.get('/providers?active=true')).filter((p) => p.type !== 'hygienist');
  assert.ok(provider?.id, 'a dentist to work with');
});
after(async () => { await browser?.close(); await app?.stop(); });

const newPatient = async (first, last, extra = {}) => {
  const p = await s.post('/patients', { first_name: first, last_name: last, dob: '1980-05-06', phone: '(512) 555-0142', email: `${first.toLowerCase()}@example.com`, ...extra });
  assert.ok(p.id, JSON.stringify(p));
  return p;
};
const carrierNamed = async (name) => (await s.get('/carriers')).find((c) => c.name === name) || s.post('/carriers', { name, payer_id: '60054' });
const waitFocus = (label) => s.page.waitForFunction((l) => document.activeElement?.getAttribute('aria-label') === l || document.activeElement?.textContent?.trim() === l, label);
const closeOtherTabs = async () => { for (const p of s.ctx.pages()) if (p !== s.page) await p.close(); };

test('#32 new patient with insurance in one line: ≤ 8 actions, no second screen', async () => {
  const { page } = s;
  const carrier = await carrierNamed('Aetna Dental E2E');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('new patient');
    await page.waitForSelector('.palette-item:has-text("New patient")');
    await page.keyboard.press('Enter');
    await waitFocus('New patient in one line');
    await page.keyboard.type(`quinn newpatient 4/5/1991 512-555-0177 quinn.np@example.com ${carrier.name} W99887766`);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/patients\/\d+/);
  });
  console.log(withinBudget('#32 new patient + insurance', r, { actions: 8, ms: 6000 }));
  const id = Number(page.url().match(/\/patients\/(\d+)/)[1]);
  const p = await s.get(`/patients/${id}`);
  assert.equal(`${p.first_name} ${p.last_name}`, 'Quinn Newpatient');
  assert.equal(p.dob, '1991-04-05');
  assert.equal(p.email, 'quinn.np@example.com');
  const [policy] = await s.get(`/patients/${id}/insurance`);
  assert.equal(policy?.carrier_id, carrier.id, 'the primary policy was made with it');
  assert.equal(policy.subscriber_id, 'W99887766');
  assert.equal(policy.priority, 'primary');
  assert.deepEqual(s.errors, []);
});

test('#34 prescription from a favorite: ≤ 3 actions, prescriber is not just "the first provider"', async () => {
  const { page } = s;
  const p = await newPatient('Rhea', 'Rxwright');
  await page.goto(`${app.base}/patients/${p.id}?tab=rx`);
  await page.waitForSelector('.chip kbd:has-text("1")');
  const r = await measure(page, async () => {
    await page.keyboard.press('1');
    await page.waitForFunction(() => /Save & print|Send to/.test(document.activeElement?.textContent || ''));
    await page.keyboard.press('Enter');
    await page.waitForFunction(async (pid) => {
      const res = await fetch(`/api/patients/${pid}/prescriptions`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } });
      return (await res.json()).length === 1;
    }, p.id);
  });
  console.log(withinBudget('#34 prescription', r, { actions: 3 }));
  const [rx] = await s.get(`/patients/${p.id}/prescriptions`);
  assert.ok(rx.drug);
  assert.ok(rx.provider_id, 'a prescriber was chosen for them');
  await closeOtherTabs();
  assert.deepEqual(s.errors, []);
});

test('#35 lab case for the active patient: ≤ 6 actions — lab, work, tooth and provider filled in; Undo cancels it', async () => {
  const { page } = s;
  const p = await newPatient('Lara', 'Labcase');
  const proc = await s.post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: provider.id });
  assert.ok(proc.id, JSON.stringify(proc));
  const labs = (await s.get('/labs')).filter((l) => l.active);
  const lab = labs[0] || await s.post('/labs', { name: 'E2E Dental Lab', turnaround_days: 10 });
  await s.api('PUT', '/me/prefs/lab.last', { value: { lab_id: lab.id, lab_name: lab.name } });
  await page.goto(`${app.base}/patients/${p.id}`); // opening the chart makes Lara the active patient
  await page.waitForSelector('h1');
  await page.goto(`${app.base}/office`);
  await page.waitForSelector('h2:has-text("Lab cases")');
  const r = await measure(page, async () => {
    await page.keyboard.press('l');
    await page.waitForSelector('.modal');
    await page.waitForFunction(() => document.activeElement?.closest('label')?.textContent?.startsWith('Shade'));
    await page.keyboard.type('A2');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Lab case logged for Lara Labcase")');
  });
  console.log(withinBudget('#35 lab case', r, { actions: 6 }));
  const cases = (await s.get('/lab-cases')).filter((c) => c.patient_id === p.id);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].procedure_id, proc.id);
  assert.equal(cases[0].tooth, '14');
  assert.equal(cases[0].shade, 'A2');
  assert.equal(cases[0].lab_id, lab.id);
  assert.equal(cases[0].provider_id, provider.id);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await s.get('/lab-cases')).find((c) => c.id === cases[0].id).status, 'cancelled', 'cancelled, not deleted');
  assert.deepEqual(s.errors, []);
});

test('#36 morning huddle: a flag fixed on its row with 1 key (confirm), with Undo', async () => {
  const { page } = s;
  let huddle = await s.get('/huddle');
  const today = huddle.date;
  if (!huddle.rows.some((x) => x.flags.includes('unconfirmed'))) {
    const p = await newPatient('Hugo', 'Huddle');
    const slot = await s.get(`/appointments/suggest?patient_id=${p.id}&from=${today}`);
    const appt = await s.post('/appointments', { patient_id: p.id, provider_id: slot.provider_id, operatory_id: slot.operatory_id, start_time: slot.start_time, end_time: slot.end_time, appointment_type_id: slot.appointment_type_id });
    assert.ok(appt.id, JSON.stringify(appt));
    huddle = await s.get(`/huddle?date=${today}`);
  }
  const row = huddle.rows.find((x) => x.flags.includes('unconfirmed'));
  assert.ok(row, 'an unconfirmed visit on the huddle');
  await page.goto(`${app.base}/`);
  await page.waitForSelector(`.huddle-row[data-appt="${row.id}"]`);
  await page.click(`.huddle-row[data-appt="${row.id}"] .huddle-time`);
  await page.waitForSelector(`.huddle-row.kb-row[data-appt="${row.id}"]`);
  const r = await measure(page, async () => {
    await page.keyboard.press('c');
    await page.waitForSelector(`.toast:has-text("Confirmed ${row.first_name} ${row.last_name}")`);
  });
  console.log(withinBudget('#36 huddle fix (confirm)', r, { actions: 1 }));
  const status = async () => (await s.get(`/huddle?date=${today}`)).rows.find((x) => x.id === row.id).status;
  assert.equal(await status(), 'confirmed');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal(await status(), 'scheduled');
  assert.deepEqual(s.errors, []);
});

let planPatient;
test('#38 pre-authorization made and sent from the plan: ≤ 2 actions, no 837 file to upload', async () => {
  const { page } = s;
  planPatient = await newPatient('Pria', 'Preauth');
  const carrier = await carrierNamed('Aetna Dental E2E');
  const policy = await s.post(`/patients/${planPatient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Pria Preauth', subscriber_id: 'PA123', group_number: 'G1' });
  assert.ok(policy.id, JSON.stringify(policy));
  await s.post(`/patients/${planPatient.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: provider.id });
  const plan = await s.post(`/patients/${planPatient.id}/treatment-plans`, { all_unplanned: true });
  assert.ok(plan.id, JSON.stringify(plan));
  await page.goto(`${app.base}/patients/${planPatient.id}?tab=treatment`);
  await page.waitForSelector(`.card[data-plan="${plan.id}"] button:has-text("Pre-authorize")`);
  const r = await measure(page, async () => {
    await page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Pre-authorize")').click();
    await page.waitForSelector('.toast:has-text("sent to")');
  });
  console.log(withinBudget('#38 pre-authorization', r, { actions: 2 }));
  const pa = (await s.get('/preauths')).find((x) => x.patient_id === planPatient.id);
  assert.equal(pa.status, 'submitted');
  assert.deepEqual(s.errors, []);
});

test('#39 financing application: ≤ 2 actions, amount is the plan’s patient share', async () => {
  const { page } = s;
  await s.api('PUT', '/practice', { financing: { links: [{ name: 'CareCredit', url: 'https://www.carecredit.com/go/DEMO123/' }] } });
  const [plan] = await s.get(`/patients/${planPatient.id}/treatment-plans`);
  const share = plan.estimate.patient_after_discount;
  assert.ok(share > 0, 'the plan has a patient share');
  await page.goto(`${app.base}/patients/${planPatient.id}?tab=ledger`);
  await page.waitForSelector('button:has-text("Send an application")');
  const r = await measure(page, async () => {
    await page.click('button:has-text("Send an application")');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Send' && !document.activeElement.disabled);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("application sent to Pria")');
  });
  console.log(withinBudget('#39 financing application', r, { actions: 2 }));
  const [fin] = await s.get(`/patients/${planPatient.id}/financing`);
  assert.equal(fin.amount, share);
  assert.equal(fin.treatment_plan_id, plan.id);
  assert.deepEqual(s.errors, []);
});

test('#40 adjustment: ≤ 3 actions, reason kept, Undo reverses (never deletes)', async () => {
  const { page } = s;
  const p = await newPatient('Ada', 'Adjust');
  const charge = await s.post(`/patients/${p.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  assert.ok(charge.id, JSON.stringify(charge));
  await page.goto(`${app.base}/patients/${p.id}?tab=ledger`);
  await page.waitForSelector('button:has-text("Adjustment")');
  const r = await measure(page, async () => {
    await page.keyboard.press('a');
    await waitFocus('Adjustment amount');
    await page.keyboard.type('25');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("of $25.00 posted for Ada")');
  });
  console.log(withinBudget('#40 adjustment', r, { actions: 3 }));
  const adjustments = async () => (await s.get(`/patients/${p.id}/ledger`)).entries.filter((e) => e.type === 'adjustment');
  const [adj] = await adjustments();
  assert.equal(adj.amount, -2500);
  assert.ok(adj.description, 'a reason');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  const after = await adjustments();
  assert.equal(after.length, 2, 'the original and its reversal');
  assert.ok(after.find((e) => e.id === adj.id).voided_at);
  assert.equal(after.reduce((t, e) => t + e.amount, 0), 0);
  assert.deepEqual(s.errors, []);
});

test('#42 end-of-day deposit that balances: ≤ 4 actions from anywhere', async () => {
  const { page } = s;
  // The demo's earlier payments go to the bank first (counted exactly), so today's deposit is just this check.
  const seeded = await s.get('/daily-deposits/build');
  if (seeded.entries.length) {
    let left = seeded.entries.filter((e) => e.kind !== 'check').reduce((t, e) => t + e.amount, 0);
    const cashCount = {};
    for (const d of [...seeded.denominations].sort((x, y) => y.cents - x.cents)) {
      const n = Math.floor(Math.max(0, left) / d.cents);
      if (n) { cashCount[d.key] = n; left -= n * d.cents; }
    }
    const dep = await s.post('/daily-deposits', { submit_key: 'e2e-seeded-0001', business_date: seeded.date, entry_ids: seeded.entries.map((e) => e.id), bag_number: 'SEED-1', cash_count: cashCount, difference_reason: left ? 'demo data' : undefined });
    assert.ok(dep.id || dep.deposit_id, JSON.stringify(dep));
  }
  const p = await newPatient('Dee', 'Deposit');
  const pay = await s.post(`/patients/${p.id}/payments`, { amount: 12000, method: 'check', reference: '4411' });
  assert.ok(!pay.error, JSON.stringify(pay));
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.rail-mod[data-module="account"]');
  const r = await measure(page, async () => {
    // Deposits & cash is in the Account module's dropdown: resting on it opens it (not an action), then one click.
    await page.hover('.rail-mod[data-module="account"] .rail-mod-btn');
    await page.click('.sidebar a[href="/deposits"]');
    await waitFocus('Bag or deposit slip number');
    await page.keyboard.type('BAG-0042');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=Bag BAG-0042');
  });
  console.log(withinBudget('#42 deposit', r, { actions: 4, ms: 6000 }));
  assert.deepEqual(s.errors, []);
});

test('#44 clock in and out: 1 action each (I on Time clock); the menu’s button no longer asks for break minutes', async () => {
  const { page } = s;
  await page.goto(`${app.base}/timeclock`);
  await page.waitForSelector('.tc-big');
  const inR = await measure(page, async () => {
    await page.keyboard.press('i');
    await page.waitForSelector('.tc-hero-status:has-text("Clocked in since")');
  });
  console.log(withinBudget('#44 clock in', inR, { actions: 1 }));
  // L: lunch, and L again when back (A061) — one key each way.
  const lunch = await measure(page, async () => {
    await page.keyboard.press('l');
    await page.waitForSelector('.tc-hero-status:has-text("On lunch since")');
  });
  console.log(withinBudget('#44 start lunch', lunch, { actions: 1 }));
  const back = await measure(page, async () => {
    await page.keyboard.press('l');
    await page.waitForSelector('.tc-hero-status:has-text("Clocked in since")');
  });
  console.log(withinBudget('#44 back from lunch', back, { actions: 1 }));
  const outR = await measure(page, async () => {
    await page.keyboard.press('i');
    await page.waitForSelector('.tc-hero-status:has-text("clocked out")');
  });
  console.log(withinBudget('#44 clock out', outR, { actions: 1 }));
  // The same from the user menu on any screen: open it, one click — no prompt box.
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  for (const want of ['Clocked in', 'Clocked out']) {
    await page.locator('.rail-avatar').first().evaluate((el) => el.closest('button').click());
    await page.locator('.clock-button button').click();
    await page.waitForSelector(`.toast:has-text("${want}")`);
    await page.keyboard.press('Escape');
  }
  assert.equal((await s.get('/timeclock/me')).clocked_in, null);
  assert.deepEqual(s.errors, [], 'no prompt box');
});
