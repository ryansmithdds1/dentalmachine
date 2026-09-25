// A · Insurance payments on autopilot: the exceptions worklist. A denial is decided and a secondary claim is sent
// in one key each (budget: 3 actions each). Spec: docs/workflows/specs/A-eob-autopilot.md
//
// Needs the autopilot routes mounted (server/src/routes/eobauto.js); the screen is the Insurance autopilot tab of
// Billing (/claims?tab=autopilot — /insurance-autopilot redirects there). Until then the tests skip with a note.
/* global document, sessionStorage, fetch */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let ready = null;
const PASSWORD = 'demo-password-123';
before(async () => {
  app = await startApp();
  browser = await launch();
  // A practice of its own, so the worklist holds only what this test puts there.
  const email = `eob-${Date.now()}@example.com`;
  const reg = await fetch(`${app.base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ practice_name: 'Autopilot Dental', name: 'Owner', email, password: PASSWORD }) });
  assert.equal(reg.status, 201, await reg.text());
  s = await signIn(browser, app.base, { email });
  // What a claim needs to go out (the clearinghouse checks it).
  await s.api('PUT', '/practice', { npi: '1234567893', tax_id: '74-1234567', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '(512) 555-0142' });
  await trackActions(s.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

async function wired(t) {
  ready ??= (async () => {
    const probe = await s.get('/eob-autopilot');
    if (!Array.isArray(probe?.items)) return false;
    await s.page.goto(`${app.base}/claims?tab=autopilot`);
    return s.page.locator('h2:has-text("Insurance autopilot")').waitFor({ timeout: 8000 }).then(() => true, () => false);
  })();
  if (!(await ready)) { t.skip('Insurance autopilot not mounted yet (routes/eobauto.js + App.jsx route, see docs/workflows/specs/A-eob-autopilot.md)'); return false; }
  return true;
}

const d = (c) => (c / 100).toFixed(2);
const era = (trace, claims) => {
  const segs = [`BPR*I*${d(claims.reduce((x, c) => x + c.paid, 0))}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999999999*DA*654321*20260920`, `TRN*1*${trace}*1512345678`, 'N1*PR*DELTA DENTAL', 'N1*PE*PRACTICE*XX*1234567893'];
  for (const c of claims) {
    segs.push(`CLP*DM${c.id}*${c.paid ? 1 : 4}*${d(c.billed)}*${d(c.paid)}*${d(c.pr)}*12*PCN${c.id}`);
    for (const [g, r, a] of c.cas) segs.push(`CAS*${g}*${r}*${d(a)}`);
  }
  return `ISA*00*          *00*          *ZZ*DELTA          *ZZ*PRACTICE       *260101*1200*^*00501*000000002*0*P*:~GS*HP*D*P*20260101*1200*2*X*005010X221A1~ST*835*0001~${segs.join('~')}~SE*${segs.length + 2}*0001~GE*1*2~IEA*1*000000002~`;
};
// ERAs are text: posted from the page the way Billing → Remittance uploads them.
const importEra = (text) => s.page.evaluate(async (body) => {
  const res = await fetch('/api/era/import?filename=e2e.835', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'text/plain' }, body });
  return { status: res.status, data: await res.json() };
}, text);

async function claimFor(patient, policy, provider, code) {
  const proc = await s.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true, ...(code === 'D2392' ? { tooth: '30', surfaces: 'MO' } : {}) });
  assert.ok(proc.id, JSON.stringify(proc));
  const claim = await s.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  assert.ok(claim.id, JSON.stringify(claim));
  await s.post(`/claims/${claim.id}/submit`);
  return s.get(`/claims/${claim.id}`);
}

test('A3: a denial is decided and a secondary claim goes out — one key each', async (t) => {
  if (!(await wired(t))) return;
  const { page } = s;
  const provider = await s.post('/providers', { name: 'Dr. Ann Lee, DDS', type: 'dentist', npi: '1987654321' });
  const delta = await s.post('/carriers', { name: 'Delta Dental', payer_id: '94276' });
  const met = await s.post('/carriers', { name: 'MetLife', payer_id: '65978' });
  const policyFor = (p, carrier, priority = 'primary') => s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, priority, subscriber_name: `${p.first_name} ${p.last_name}`, subscriber_id: `W${p.id}${priority[0]}`, annual_max: 150000, deductible: 0, pct_basic: 80, pct_preventive: 100 });
  // Nora's plan doesn't cover her cleaning (PR-204: hers to pay). Omar has two insurances.
  const nora = await s.post('/patients', { first_name: 'Nora', last_name: 'Denied', dob: '1980-02-03', phone: '(512) 555-0111' });
  const omar = await s.post('/patients', { first_name: 'Omar', last_name: 'Twoplans', dob: '1975-05-06', phone: '(512) 555-0112' });
  const noraPolicy = await policyFor(nora, delta);
  const omarPrimary = await policyFor(omar, delta);
  await policyFor(omar, met, 'secondary');
  const denied = await claimFor(nora, noraPolicy, provider, 'D1110');
  const primary = await claimFor(omar, omarPrimary, provider, 'D2392');
  const allowed = primary.total_fee - 5000;
  const imp = await importEra(era(`E2E${Date.now()}`, [
    { id: denied.id, billed: denied.total_fee, paid: 0, pr: denied.total_fee, cas: [['PR', '204', denied.total_fee]] },
    { id: primary.id, billed: primary.total_fee, paid: Math.round(allowed * 0.8), pr: allowed - Math.round(allowed * 0.8), cas: [['CO', '45', 5000], ['PR', '2', allowed - Math.round(allowed * 0.8)]] },
  ]));
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  assert.deepEqual(imp.data.claims.map((c) => c.result), ['denied', 'posted']);

  await page.goto(`${app.base}/claims?tab=autopilot`);
  await page.waitForSelector('.eob-item.current:has-text("Denied")');
  assert.match(await page.locator('.eob-panel').innerText(), /Not covered under the patient’s plan/);
  const deny = await measure(page, async () => {
    await page.keyboard.press('b'); // Bill the patient (the first choice for a PR-204 denial)
    await page.waitForSelector('.eob-item.current:has-text("Secondary claim to send")');
  });
  console.log(withinBudget('A3 decide a denial', deny, { actions: 3, ms: 5000 }));
  const line = (await s.get('/eob-autopilot')).items.find((i) => i.claim_id === denied.id);
  assert.equal(line, undefined, 'the denial left the worklist');

  const secondary = (await s.get('/eob-autopilot')).items.find((i) => i.kind === 'secondary');
  assert.equal(secondary.primary_claim_id, primary.id);
  const send = await measure(page, async () => {
    await page.keyboard.press('s'); // Send secondary
    // (The sandbox clearinghouse answers the secondary at once; its answer is a new line of its own.)
    await page.waitForFunction(() => ![...document.querySelectorAll('.eob-item')].some((e) => e.textContent.includes('Secondary claim to send')), null, { timeout: 10_000 });
  });
  console.log(withinBudget('A3 send a secondary claim', send, { actions: 3, ms: 8000 }));
  const sent = await s.get(`/claims/${secondary.claim_id}`);
  assert.notEqual(sent.status, 'draft');
  assert.ok(sent.submitted_at);
  assert.deepEqual(s.errors, []);
});

test('A1: settings show the 30-day preview and turn auto-posting on in one click', async (t) => {
  if (!(await wired(t))) return;
  const { page } = s;
  await page.goto(`${app.base}/claims?tab=autopilot&sub=settings`);
  await page.waitForSelector('.eob-preview');
  assert.match(await page.locator('.eob-preview').innerText(), /would have posted on their own/);
  const r = await measure(page, async () => {
    await page.click('button:has-text("Turn on auto-posting")');
    await page.waitForSelector('text=On since');
  });
  console.log(withinBudget('A1 turn on auto-posting', r, { actions: 1, ms: 5000 }));
  assert.equal((await s.get('/eob-autopilot/settings')).autopost, true);
});

test('33 manual check: carrier, check # Enter, amount — matched to the claim it pays — Enter posts (budget 6)', async () => {
  const { page } = s;
  const provider = await s.post('/providers', { name: 'Dr. Check Lee, DDS', type: 'dentist', npi: '1987654322' });
  const carrier = await s.post('/carriers', { name: `Paper Check Mutual ${Date.now() % 10000}`, payer_id: '77001' });
  const pat = await s.post('/patients', { first_name: 'Chet', last_name: 'Paperwell', dob: '1981-03-04', phone: '(512) 555-0131' });
  const policy = await s.post(`/patients/${pat.id}/insurance`, { carrier_id: carrier.id, priority: 'primary', subscriber_name: 'Chet Paperwell', subscriber_id: 'PC1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_preventive: 100 });
  const a = await claimFor(pat, policy, provider, 'D1110');
  const b = await claimFor(pat, policy, provider, 'D2392');
  assert.ok(a.estimated_amount > 0 && b.estimated_amount > 0 && a.estimated_amount !== b.estimated_amount, JSON.stringify([a.estimated_amount, b.estimated_amount]));
  await page.goto(`${app.base}/claims?tab=checks`);
  await page.waitForSelector('button:has-text("Post an insurance check")');
  const r = await measure(page, async () => {
    await page.click('button:has-text("Post an insurance check")');
    await page.waitForSelector('.modal label:has-text("Carrier") select');
    await page.locator('.modal label:has-text("Carrier") select').selectOption(String(carrier.id));
    await page.waitForFunction(() => document.activeElement?.closest('label')?.textContent?.startsWith('Check / EFT #'));
    await page.keyboard.type('55001');
    await page.keyboard.press('Enter');
    // The check pays only the cleaning: its amount picks that claim, paid as expected.
    await page.keyboard.type(d(b.estimated_amount));
    await page.waitForSelector('.modal .badge.ok:has-text("balanced")');
    await page.waitForSelector('.modal .check-matched');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal', { state: 'detached' });
  });
  // Budget 6 with the carrier pick (a select the counter doesn't see): open, number, Enter, amount, Enter = 5 here.
  console.log(withinBudget('33 manual insurance check', r, { actions: 5 }));
  const [ca, cb] = [await s.get(`/claims/${a.id}`), await s.get(`/claims/${b.id}`)];
  assert.equal(cb.paid_amount, b.estimated_amount, 'the matched claim is paid');
  assert.equal(ca.paid_amount || 0, 0, 'the other claim is left alone');
  // Posting the same check again is caught (idempotent money): the form says so instead of posting twice.
  await page.click('button:has-text("Post an insurance check")');
  await page.locator('.modal label:has-text("Carrier") select').selectOption(String(carrier.id));
  await page.keyboard.type('55001');
  await page.keyboard.press('Enter');
  await page.keyboard.type(d(b.estimated_amount)); // the same check (number, amount, payer) typed in again
  await page.waitForSelector('.modal .badge.ok:has-text("balanced")');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal [role=alert]:has-text("already posted")');
  await page.keyboard.press('Escape');
  assert.equal((await s.get(`/claims/${a.id}`)).paid_amount || 0, 0);
  assert.deepEqual(s.errors.filter((e) => !/409/.test(e)), []);
});
