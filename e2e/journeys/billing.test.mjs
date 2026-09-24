// Nightly journey — billing (Casey, billing@demo): approve a claim from Ready to approve, let the (sandbox)
// clearinghouse answer and post the ERA through the insurance autopilot, send statements, and close the day
// with a deposit. The patient and finished work are set up through the API as the office's admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journey } from './lib.mjs';
import { tokenFor } from '../lib/watch.mjs';

let admin; let patient; let claimId;
const as = (method, path, body) => fetch(`${j.base}/api${path}`, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const j = journey('billing', 'billing@demo.dentalmachine.app', async () => {
  admin = await tokenFor(j.base, 'admin@demo.dentalmachine.app');
  const [provider] = await as('GET', '/providers?active=true');
  const carrier = await as('POST', '/carriers', { name: 'Journey Dental', payer_id: '99996' });
  patient = await as('POST', '/patients', { first_name: 'Bill', last_name: `Journey${Date.now() % 100000}`, dob: '1979-07-07' });
  await as('POST', `/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: `Bill ${patient.last_name}`, subscriber_id: `BJ${patient.id}`, group_number: 'G1' });
  for (const code of ['D1110', 'D0120']) await as('POST', `/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true });
});

test('approve a claim from Ready to approve', async () => {
  const { page } = j;
  const row = page.locator('tr.wl-row', { hasText: patient.last_name });
  await j.step('approve', async () => {
    await j.goto('/claims?tab=claims', '.tabs button:has-text("Ready to approve")');
    await page.click('.tabs button:has-text("Ready to approve")');
    await row.locator('button:has-text("Approve")').click();
    await page.waitForSelector(`.toast:has-text("${patient.last_name}")`);
  });
  const claims = await j.s.get(`/claims?patient_id=${patient.id}&limit=50`);
  assert.equal(claims.length, 1, 'one claim');
  claimId = claims[0].id;
  await j.healthy('ready to approve');
});

test('the ERA comes back and is posted through the insurance autopilot', async () => {
  const { page } = j;
  const paid = async () => ['paid', 'partially_paid'].includes((await j.s.get(`/claims/${claimId}`)).status);
  await j.step('responses', async () => {
    await j.goto('/claims?tab=claims', 'button:has-text("Check for responses")');
    for (let i = 0; i < 10 && !(await paid()); i++) {
      if (await page.locator('button:has-text("Check for responses")').count()) {
        await page.click('button:has-text("Check for responses")');
        await page.locator('button:has-text("Check for responses")').waitFor();
      }
      await page.waitForTimeout(800);
      // Clean ERA payments wait on the autopilot for one "Post all" by a person.
      if (i >= 1 && !(await paid())) {
        await j.goto('/claims?tab=autopilot', 'main');
        const post = page.locator('button:has-text("Post all")');
        // The worklist loads after the tab: wait for the button instead of counting before it can appear.
        await post.first().waitFor({ timeout: 5000 }).catch(() => {});
        if (await post.count()) { await post.first().click(); await page.waitForTimeout(800); }
        await j.goto('/claims?tab=claims', 'button:has-text("Check for responses")');
      }
    }
  });
  assert.ok(await paid(), `claim is ${(await j.s.get(`/claims/${claimId}`)).status}`);
  const ledger = await j.s.get(`/patients/${patient.id}/ledger`);
  assert.ok(ledger.entries.some((e) => e.type === 'insurance_payment'), 'insurance payment on the ledger');
});

test('send statements', async () => {
  const { page } = j;
  const before = (await j.s.get('/statements/runs')).length;
  await j.step('statements', async () => {
    await j.goto('/claims?tab=statements', 'button:has-text("Send statements")');
    await page.waitForSelector('button:has-text("Send statements"):not([disabled])');
    await page.click('button:has-text("Send statements")');
  });
  await j.until(async () => (await j.s.get('/statements/runs')).length > before, 'the statement run');
  await j.healthy('statements');
});

test('close the day with a deposit', async () => {
  const { page } = j;
  // A check taken today, so there is something to deposit.
  await as('POST', `/patients/${patient.id}/payments`, { amount: 4000, method: 'check', reference: '1042' });
  const before = (await j.s.get('/daily-deposits')).deposits.length;
  await j.step('deposit', async () => {
    await j.goto('/deposits', '[aria-label="Bag or deposit slip number"]');
    // Count-it-here cash that doesn't match asks why; the demo's cash is counted as it stands.
    const why = page.locator('label:has-text("Why doesn’t it match?") textarea');
    if (await why.count()) await why.fill('Journey test: counted as recorded');
    await page.fill('[aria-label="Bag or deposit slip number"]', `BAG-${Date.now() % 100000}`);
    await page.locator('button.primary:has-text("Submit and lock")').click();
    await page.waitForSelector('button:has-text("Start another deposit")');
  });
  assert.equal((await j.s.get('/daily-deposits')).deposits.length, before + 1, 'a deposit was recorded');
  await j.healthy('deposit');
});
