// TF · Treatment follow-up and the doctor's letter (docs/workflows/specs/TF-treatment-followup.md).
// Budget: the doctor approves a letter from the Letters list in ≤ 2 actions (one click on "Approve & send", or A
// on the highlighted letter); the letter is sent, filed on the chart and the list moves on. Opening a letter to
// review it shows the preview as the patient will see it, and Escape closes it.
// Runs against e2e/lib/txfollow-app.mjs, which adds the TF routes until app.js mounts them. The screen is at
// /recall?type=treatment (the Recall page hands over to pages/TreatmentFollowup.jsx).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false;
const letters = [];

before(async () => {
  app = await startApp({ entry: 'e2e/lib/txfollow-app.mjs' });
  browser = await launch();
  // The doctor signs in: the letters go out with Dr. Chen's name, so only Dr. Chen approves them.
  s = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  await trackActions(s.page);
  mounted = (await s.get('/txfollow/settings')).enabled !== undefined;
  if (!mounted) return;
  const chen = (await s.get('/providers')).find((p) => /Chen/.test(p.name));
  for (const first of ['Letty', 'Lars']) {
    const p = await s.post('/patients', { first_name: first, last_name: 'Letter', dob: '1976-02-03', phone: '(512) 555-0166', email: `${first.toLowerCase()}@example.com`, address: '5 Pine St', city: 'Austin', state: 'TX', zip: '78702' });
    assert.ok(p.id, JSON.stringify(p));
    const plan = await s.post(`/patients/${p.id}/treatment-plans`, { name: 'Crown', procedures: [{ code: 'D2740', tooth: '30', provider_id: chen.id }] });
    assert.ok(plan.id, JSON.stringify(plan));
    const l = await s.post('/txfollow/letters', { treatment_plan_id: plan.id });
    assert.ok(l.id, JSON.stringify(l));
    if (l.provider_id !== chen.id) await s.api('PUT', `/txfollow/letters/${l.id}`, { provider_id: chen.id });
    letters.push({ ...l, name: `${first} Letter` });
  }
});
after(async () => { await browser?.close(); await app?.stop(); });

test('TF3: the doctor approves a letter in ≤ 2 actions (click), and the next with one key', async (t) => {
  if (!mounted) return t.skip('TF routes not mounted');
  const { page } = s;
  await page.goto(`${app.base}/recall?type=treatment&tab=letters`);
  const row = page.locator('.txf-letter', { hasText: letters[0].name });
  await row.waitFor();
  // Reviewing first: the preview opens beside the list and Escape closes it (not measured).
  await row.locator('button:has-text("Review")').click();
  await page.waitForSelector('.txf-drawer iframe');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.txf-drawer', { state: 'detached' });

  const r = await measure(page, async () => {
    await row.locator('button.txf-approve').click();
    await page.waitForSelector(`text=/${letters[0].name}: letter sent/`);
  });
  console.log(withinBudget('TF3 approve a doctor’s letter', r, { actions: 2, ms: 5000 }));
  const sent = await s.get(`/txfollow/letters/${letters[0].id}`);
  assert.equal(sent.letter.status, 'sent');
  const docs = await s.get(`/patients/${letters[0].patient_id}/documents`);
  assert.ok((Array.isArray(docs) ? docs : docs.rows || docs.documents || []).some((d) => d.folder === 'Letters' || /Letter from/.test(d.filename)), 'filed on the chart');

  // The next letter is highlighted: A approves it.
  const next = page.locator('.txf-letter.current', { hasText: letters[1].name });
  await next.waitFor();
  const r2 = await measure(page, async () => {
    await page.keyboard.press('a');
    await page.waitForSelector(`text=/${letters[1].name}: letter sent/`);
  });
  console.log(withinBudget('TF3 approve with the keyboard', r2, { actions: 1, ms: 5000 }));
  assert.ok(s.errors.length === 0, s.errors.join('\n'));
});
