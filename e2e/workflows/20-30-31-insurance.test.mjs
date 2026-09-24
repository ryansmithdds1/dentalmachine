// #20 eligibility (applied on its own; people only see exceptions), #30 intake worklist, #31 scan an insurance
// card into a policy — within budget, on the keyboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

// A real 1×1 PNG, standing in for a phone photo of a card (the sandbox reader makes up the same card for it every time).
const CARD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let app; let browser; let s; let carriers;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  carriers = await s.get('/carriers');
});
after(async () => { await browser?.close(); await app?.stop(); });

const newPatient = (first) => s.post('/patients', { first_name: first, last_name: `Ins${Date.now() % 100000}`, dob: '1980-02-03' });
const insure = (p) => s.post(`/patients/${p.id}/insurance`, { carrier_id: carriers[0].id, subscriber_name: `${p.first_name} ${p.last_name}`, subscriber_id: `W${p.id}`, annual_max: 150000, deductible: 5000 });
// A payer's 271 saying coverage ended, imported the way a manual-mode office would.
const INACTIVE = ['ISA*00*          *00*          *ZZ*PAYER          *ZZ*US             *240101*1200*^*00501*000000001*0*P*:', 'GS*HB*P*U*20240101*1200*1*X*005010X279A1',
  'ST*271*0001*005010X279A1', 'EB*6*IND*35**DENTAL PPO', 'SE*4*0001', 'GE*1*1', 'IEA*1*000000001'].join('~') + '~';

test('#20 check eligibility for the patient on screen: 1 key, applied to the policy automatically', async () => {
  const { page } = s;
  const p = await newPatient('Elig');
  const policy = await insure(p);
  await page.goto(`${app.base}/patients/${p.id}?tab=insurance`);
  await page.waitForSelector('h2:has-text("Eligibility & benefits")');
  const r = await measure(page, async () => {
    await page.keyboard.press('e');
    await page.waitForSelector('.elig-outcome.done:has-text("Applied to the policy automatically")');
  });
  console.log(withinBudget('#20 check eligibility', r, { actions: 1, ms: 5000 }));
  const [check] = await s.get(`/patients/${p.id}/eligibility`);
  assert.equal(check.status, 'active');
  assert.equal(check.summary.applied.auto, true);
  assert.equal(check.patient_insurance_id, policy.id);
  assert.deepEqual(s.errors, []);
});

test('#20 the day’s list leads with exceptions; each takes 1 action', async () => {
  const { page } = s;
  const practice = await s.get('/practice');
  const tomorrow = await page.evaluate((tz) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date());
    return new Date(Date.parse(`${today}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  }, practice.timezone);
  const [provider] = await s.get('/providers');
  const p = await newPatient('Lapsed');
  const policy = await insure(p);
  const appt = await s.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${tomorrow} 06:00`, end_time: `${tomorrow} 06:30`, override_blockout: true });
  assert.ok(appt.id, JSON.stringify(appt));
  const check = await s.post(`/insurance/${policy.id}/eligibility`);
  await page.evaluate(async ([id, body]) => {
    const res = await fetch(`/api/eligibility/${id}/response`, { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'text/plain' }, body }); // eslint-disable-line no-undef
    if (!res.ok) throw new Error(await res.text());
  }, [check.id, INACTIVE]);

  await page.goto(`${app.base}/claims?tab=eligibility`);
  const row = page.locator('.elig-exception', { hasText: p.last_name });
  await row.waitFor();
  assert.match(await row.innerText(), /coverage isn’t active/);
  const r = await measure(page, async () => {
    await row.locator('button:has-text("Keep what’s on file")').click();
    await row.waitFor({ state: 'detached' });
  });
  console.log(withinBudget('#20 review an exception', r, { actions: 1, ms: 4000 }));
  const [latest] = await s.get(`/patients/${p.id}/eligibility`);
  assert.equal(latest.summary.review.outcome, 'kept');
  assert.deepEqual(s.errors, []);
});

test('#31 scan a new insurance card: photo → read → confirm in ≤ 4 actions, carrier added inline if missing', async () => {
  const { page } = s;
  const p = await newPatient('Card');
  await page.goto(`${app.base}/patients/${p.id}?tab=insurance`);
  await page.waitForSelector('button:has-text("Scan card")');
  const r = await measure(page, async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('s')]);
    await chooser.setFiles({ name: 'card-front.png', mimeType: 'image/png', buffer: CARD });
    await page.waitForSelector('.modal .card-read-banner');
    await page.keyboard.press('Enter'); // Save policy has focus once the card is read
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.waitForSelector('td:has-text("SBX")');
  });
  r.actions += 1; // choosing the photo (setFiles isn't a keyboard or mouse event, but a person does pick it)
  console.log(withinBudget('#31 scan an insurance card', r, { actions: 4, ms: 6000 }));
  const [policy] = await s.get(`/patients/${p.id}/insurance`);
  assert.match(policy.subscriber_id, /^SBX/);
  assert.equal(policy.subscriber_name, `${p.first_name} ${p.last_name}`);
  assert.equal(policy.subscriber_dob, '1980-02-03', 'what the chart already knows');
  // The new coverage is checked with the payer straight after (no extra step), and the photo is filed.
  for (let i = 0; i < 40 && !(await s.get(`/patients/${p.id}/eligibility`)).length; i++) await page.waitForTimeout(100);
  assert.equal((await s.get(`/patients/${p.id}/eligibility`))[0].status, 'active');
  const docs = await s.get(`/patients/${p.id}/documents`);
  assert.ok((docs.rows || docs).some((d) => d.category === 'insurance_card'), 'card photo filed in Documents');
  assert.deepEqual(s.errors, []);
});

// #30: the intake worklist (components/IntakeReview.jsx on the To-do page, GET /intake/pending) is mounted.
// TODO: seed a pending item from the browser (a public booking with insurance for an existing patient) and measure J to the item,
// A to accept — 1–2 actions per item. The server side is covered in server/test/intakeinsurance.test.js.
test.skip('#30 intake worklist: J/K, A accepts — needs a seeded pending item (server side covered)');
