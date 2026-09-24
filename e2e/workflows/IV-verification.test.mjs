// IV · Insurance verification center: tomorrow's list checked with one key; an exception resolved in two;
// verified by phone from the keyboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let carriers; let provider; let tomorrow;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  carriers = await s.get('/carriers');
  [provider] = await s.get('/providers');
  const practice = await s.get('/practice');
  tomorrow = await s.page.evaluate((tz) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date());
    return new Date(Date.parse(`${today}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  }, practice.timezone);
});
after(async () => { await browser?.close(); await app?.stop(); });

const stamp = () => `${Date.now() % 100000}`;
async function insuredVisit(first, time) {
  const p = await s.post('/patients', { first_name: first, last_name: `Verify${stamp()}`, dob: '1981-05-06', phone: '(512) 555-0142' });
  const policy = await s.post(`/patients/${p.id}/insurance`, { carrier_id: carriers[0].id, subscriber_name: `${p.first_name} ${p.last_name}`, subscriber_id: `V${p.id}`, group_number: `GRP${p.id}`, annual_max: 150000, deductible: 5000 });
  const appt = await s.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${tomorrow} ${time}`, end_time: `${tomorrow} ${time.slice(0, 3)}${String(Number(time.slice(3)) + 10).padStart(2, '0')}`, override_blockout: true });
  assert.ok(appt.id, JSON.stringify(appt));
  return { p, policy };
}

test('IV verify tomorrow’s list: 1 key checks everyone and applies clean answers', async () => {
  const { page } = s;
  const a = await insuredVisit('Ivy', '05:00');
  const b = await insuredVisit('Ike', '05:15');
  await page.goto(`${app.base}/claims?tab=verification&range=tomorrow&view=all`);
  await page.locator('.vf-row', { hasText: a.p.last_name }).waitFor();
  await page.locator('.vf-row', { hasText: b.p.last_name }).waitFor();
  const r = await measure(page, async () => {
    await page.keyboard.press('r');
    await page.waitForSelector('.toast:has-text("Checked")');
  });
  console.log(withinBudget('IV check tomorrow’s list', r, { actions: 1, ms: 8000 }));
  for (const x of [a, b]) {
    const st = await s.get(`/patients/${x.p.id}/verification`);
    assert.equal(st.eligibility.state, 'verified', JSON.stringify(st));
    assert.equal(st.breakdown.state, 'verified', 'the sandbox 271 carries the full breakdown');
  }
  await page.locator('.vf-row', { hasText: a.p.last_name }).locator('.vf-pill.ok').first().waitFor();
  assert.deepEqual(s.errors, []);
});

test('IV resolve an exception in ≤ 2 actions: coverage inactive → text the patient for their new card', async () => {
  const { page } = s;
  const x = await insuredVisit('Ina', '05:30');
  const phone = await s.post(`/verification/policies/${x.policy.id}/phone`, { active: false, reference: 'REF-1', rep_name: 'Dana' });
  assert.ok(phone.check_id, JSON.stringify(phone));
  await page.goto(`${app.base}/claims?tab=verification&range=tomorrow`);
  const row = page.locator('.vf-row', { hasText: x.p.last_name });
  await row.waitFor();
  assert.match(await row.innerText(), /Coverage inactive/);
  const r = await measure(page, async () => {
    await row.click();
    await page.keyboard.press('t');
    await row.waitFor({ state: 'detached' });
  });
  console.log(withinBudget('IV resolve an exception (text for the new card)', r, { actions: 2, ms: 5000 }));
  const st = await s.get(`/patients/${x.p.id}/verification`);
  assert.equal(st.waiting, true, 'now waiting on the patient');
  await page.click('.vf-views button:has-text("Waiting on patient")');
  await page.locator('.vf-row', { hasText: x.p.last_name }).waitFor();
  assert.deepEqual(s.errors, []);
});

test('IV verified by phone from the keyboard: P, reference, representative, Enter (≤ 5)', async () => {
  const { page } = s;
  const x = await insuredVisit('Ora', '05:45');
  await page.goto(`${app.base}/claims?tab=verification&range=tomorrow&view=all`);
  const row = page.locator('.vf-row', { hasText: x.p.last_name });
  await row.waitFor();
  await row.click();
  const r = await measure(page, async () => {
    await page.keyboard.press('p');
    await page.waitForSelector('.vf-form input[name=reference]:focus');
    await page.keyboard.type('REF-778');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Sam');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("verified by phone")');
  });
  console.log(withinBudget('IV verified by phone', r, { actions: 5, ms: 5000 }));
  const st = await s.get(`/patients/${x.p.id}/verification`);
  assert.deepEqual([st.eligibility.state, st.eligibility.how], ['verified', 'Phone call']);
  assert.deepEqual(s.errors, []);
});
