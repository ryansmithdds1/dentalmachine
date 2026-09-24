// RV · Reviews with a feedback screen (docs/workflows/specs/RV-reviews.md, docs/reviews.md).
// Budgets: ask for a review from the chart ≤ 1 action (and Alt+R from any screen with the patient active: 1);
// the patient rates with one tap and is routed: happy → invitation to post, less than happy → private feedback.
// The small public-review link is on the page whatever the rating (no review gating).
// Needs the RV routes mounted (server/src/app.js, client/src/App.jsx): skipped when they aren't.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let mounted = false; let patients = [];

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  mounted = !!(await s.get('/reviews/settings')).throttle_months;
  if (!mounted) return;
  await s.api('PUT', '/practice', { review_url: 'https://g.page/r/e2e-example/review', send_from: '00:00', send_until: '00:00' });
  const list = await s.get('/patients?limit=200');
  for (const p of list.rows || list) {
    if (!p.phone) continue;
    const full = await s.get(`/patients/${p.id}`);
    const st = await s.get(`/patients/${p.id}/review-request`);
    const dob = full.dob ? new Date(full.dob) : null;
    const adult = !dob || (Date.now() - dob.getTime()) / (365.25 * 86400_000) >= 18;
    if (full.sms_opt_in && adult && st.allowed && !full.guarantor_id) patients.push(full);
    if (patients.length >= 3) break;
  }
  assert.ok(patients.length >= 3, 'demo data has adult patients who can get texts');
});
after(async () => { await browser?.close(); await app?.stop(); });

const linkFor = async (patientId) => {
  const msgs = await s.get(`/messages?patient_id=${patientId}&limit=5`);
  const m = msgs.find((x) => x.kind === 'review');
  assert.ok(m, 'a review text was sent');
  return new URL(/\/r\/[\w-]+/.exec(m.body)[0], app.base).toString();
};

test('RV1: ask for a review from the chart in 1 action; Alt+R from another screen', async (t) => {
  if (!mounted) return t.skip('RV routes not mounted yet');
  const { page } = s;
  const p = patients[0];
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('button.review-ask');
  const r = await measure(page, async () => {
    await page.click('button.review-ask');
    await page.waitForSelector('text=/Review request (texted|emailed) to/');
  });
  console.log(withinBudget('RV1 chart → review request', r, { actions: 1, ms: 3000 }));
  assert.match(await linkFor(p.id), /\/r\//);

  // The same patient again: the server says it's already been done (no second text).
  const again = await s.post(`/patients/${p.id}/review-request`, { source: 'chart' });
  assert.equal(again.already, true);

  // Another patient made active, then Alt+R from the schedule.
  const q = patients[2];
  await page.goto(`${app.base}/patients/${q.id}`);
  await page.waitForSelector('button.review-ask');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar');
  const r2 = await measure(page, async () => {
    await page.keyboard.press('Alt+r');
    await page.waitForSelector('text=/Review request (texted|emailed) to/');
  });
  console.log(withinBudget('RV1 Alt+R from the schedule', r2, { actions: 1, ms: 3000 }));
  assert.ok(s.errors.length === 0, s.errors.join('\n'));
});

test('RV2: the patient taps a star and is routed; the public link is there for every rating', async (t) => {
  if (!mounted) return t.skip('RV routes not mounted yet');
  const happyUrl = await linkFor(patients[0].id);
  const sad = patients[1];
  await s.post(`/patients/${sad.id}/review-request`, { source: 'checkout' });
  const sadUrl = await linkFor(sad.id);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // a phone, no staff login
  const page = await ctx.newPage();
  await trackActions(page);
  // Happy: one tap → invitation with the Google button; the public link too.
  await page.goto(happyUrl);
  await page.waitForSelector('.rv-star');
  assert.equal(await page.locator('[data-testid=public-review-link]').count(), 1, 'public link before rating');
  const r = await measure(page, async () => {
    await page.click('.rv-star >> nth=4');
    await page.waitForSelector('button:has-text("on Google")');
  });
  console.log(withinBudget('RV2 happy rating → invitation', r, { actions: 1, ms: 3000 }));
  assert.equal(await page.locator('[data-testid=public-review-link] a').first().getAttribute('href').then((h) => /\/go\?site=google$/.test(h)), true);

  // Less than happy: one tap → the private form (public link still there) → sent privately.
  await page.goto(sadUrl);
  await page.waitForSelector('.rv-star');
  await page.click('.rv-star >> nth=1');
  await page.waitForSelector('text=What went wrong?');
  assert.equal(await page.locator('[data-testid=public-review-link]').count(), 1, 'public link for a low rating');
  await page.click('textarea');
  await page.keyboard.type('Waited 40 minutes and nobody told me why.');
  await page.click('text=Please call me back');
  await page.click('button:has-text("Send to")');
  await page.waitForSelector('text=Thank you for telling us');
  assert.equal(await page.locator('[data-testid=public-review-link]').count(), 1, 'public link after feedback');
  await ctx.close();

  // The office has it: inbox item, and a follow-up task for the patient.
  const inbox = await s.get('/reviews/feedback');
  const item = inbox.find((x) => x.patient_id === sad.id);
  assert.ok(item && item.feedback_status === 'new' && item.callback_wanted === 1);
  const tasks = await s.get(`/tasks?patient_id=${sad.id}`);
  assert.ok(tasks.some((x) => /Unhappy after visit \(2★\)/.test(x.title)));

  // The dashboard shows it (staff screen).
  await s.page.goto(`${app.base}/reviews?tab=feedback`);
  await s.page.waitForSelector(`text=${sad.last_name}`);
  await s.page.goto(`${app.base}/reviews`);
  await s.page.waitForSelector('text=Requests funnel');
  assert.ok(await s.page.evaluate(() => document.body.innerText.includes('Private feedback')));
});
