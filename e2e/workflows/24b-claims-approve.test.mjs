// Workflow 24b (Billing → Ready to approve): claims are prepared by themselves from finished work; a person approves
// one in at most 2 actions from the Billing page, and nothing goes to a payer before that. Spec:
// docs/workflows/specs/24-claims.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let provider; let carrier;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  [provider] = await s.get('/providers?active=true');
  carrier = await s.post('/carriers', { name: 'Approve Dental', payer_id: '99998' });
  assert.ok(carrier.id, JSON.stringify(carrier));
});
after(async () => { await browser?.close(); await app?.stop(); });

async function insuredWithWork(first, codes = ['D1110', 'D0120']) {
  const p = await s.post('/patients', { first_name: first, last_name: 'Approvewell', dob: '1982-03-04' });
  const policy = await s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: `${first} Approvewell`, subscriber_id: `AP${p.id}`, group_number: 'G1' });
  assert.ok(policy.id, JSON.stringify(policy));
  for (const code of codes) assert.ok((await s.post(`/patients/${p.id}/procedures`, { code, provider_id: provider.id, complete: true })).id);
  return p;
}
const claimsOf = (pid) => s.get(`/claims?patient_id=${pid}&limit=50`);

test('#24b the claim is prepared with nothing sent; from the Billing page, Ready to approve → Approve = 2 actions', async () => {
  const { page } = s;
  const p = await insuredWithWork('Ada');
  // Prepared, not made: no claim until a person approves.
  const queue = await s.get('/claim-queue');
  const g = queue.groups.find((x) => x.patient_id === p.id);
  assert.equal(g?.status, 'ready', JSON.stringify(g));
  assert.equal((await claimsOf(p.id)).length, 0);

  await page.goto(`${app.base}/claims?tab=claims`);
  await page.waitForSelector('.tabs button:has-text("Ready to approve")');
  const row = page.locator('tr.wl-row', { hasText: 'Ada Approvewell' });
  const r = await measure(page, async () => {
    await page.click('.tabs button:has-text("Ready to approve")');
    await row.locator('button:has-text("Approve")').click();
    await page.waitForSelector('.toast:has-text("Ada Approvewell")');
  });
  console.log(withinBudget('#24b approve one prepared claim', r, { actions: 2, ms: 6000 }));
  const claims = await claimsOf(p.id);
  assert.equal(claims.length, 1, 'one claim');
  assert.ok(['submitted', 'paid', 'partially_paid'].includes(claims[0].status), claims[0].status);
  assert.deepEqual(s.errors, [], 'no prompt or confirm boxes');
});

test('#24b on the keyboard: J/K to the claim, A approves it (one claim) and it leaves the list', async () => {
  const { page } = s;
  const p = await insuredWithWork('Bea', ['D0150']);
  await page.goto(`${app.base}/claims?tab=approve`);
  const row = page.locator('tr.wl-row', { hasText: 'Bea Approvewell' });
  await row.waitFor();
  const rows = page.locator('tr.wl-row');
  const index = await rows.evaluateAll((els, name) => els.findIndex((e) => e.textContent.includes(name)), 'Bea Approvewell');
  for (let i = 0; i < index; i++) await page.keyboard.press('j');
  await page.waitForSelector('tr.wl-row.current:has-text("Bea Approvewell")');
  await page.keyboard.press('a');
  await page.waitForSelector('.toast:has-text("Bea Approvewell")');
  await page.waitForTimeout(300);
  assert.equal((await claimsOf(p.id)).length, 1);
  assert.equal(await page.locator('tr.wl-row', { hasText: 'Bea Approvewell' }).count(), 0, 'gone from the list');
  assert.deepEqual(s.errors, []);
});
