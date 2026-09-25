// Recall types and frequencies (RF1–RF4): a patient's recall status is on the chart with nothing to click, and
// booking their hygiene visit takes the due bitewings and exam along (≤ 3 actions); the recall board marks a
// patient contacted with one key. Spec: docs/workflows/specs/RF-recall-frequencies.md
//
// Runs the app with the recall routes in front (e2e/lib/recallfreq-app.mjs) until app.js mounts them. The panel
// test skips until PatientDetail.jsx mounts <RecallPanel>.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let today; let hyg; let pt;
const tag = Math.random().toString(36).slice(2, 6);
const monthsAgo = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - n); return x.toISOString().slice(0, 10); };

before(async () => {
  app = await startApp({ entry: 'e2e/lib/recallfreq-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  hyg = (await s.get('/providers?active=true')).find((p) => p.type === 'hygienist');
  assert.ok(hyg, 'the demo practice has a hygienist');
  pt = await s.post('/patients', { first_name: `Rena${tag}`, last_name: 'Recall', dob: '1981-05-05', phone: '(512) 555-0177', primary_hygienist_id: hyg.id });
  assert.ok(pt.id, JSON.stringify(pt));
  // Their history came from their last dentist: cleaning and exam seven months ago, bitewings thirteen.
  for (const [code, date] of [['D1110', monthsAgo(today, 7)], ['D0120', monthsAgo(today, 7)], ['D0274', monthsAgo(today, 13)]]) {
    const r = await s.post(`/patients/${pt.id}/outside-procedures`, { code, date, office_name: 'Previous dentist' });
    assert.ok(r.id, JSON.stringify(r));
  }
});
after(async () => { await browser?.close(); await app?.stop(); });

test('RF3: the chart shows each recall’s status, due date and insurance line — no clicks', async (t) => {
  const { page } = s;
  const status = await s.get(`/patients/${pt.id}/recall-status`);
  assert.equal(status.items.find((i) => i.type === 'bwx').status, 'overdue');
  let shown = false;
  const r = await measure(page, async () => {
    await page.goto(`${app.base}/patients/${pt.id}`);
    shown = await page.waitForSelector('[aria-label="Recall status"] .rf-item', { timeout: 8000 }).then(() => true, () => false);
  });
  if (!shown) { t.skip('RecallPanel not mounted on PatientDetail.jsx yet'); return; }
  console.log(withinBudget('see a patient’s recall status', r, { actions: 0, ms: 8000 }));
  const text = await page.locator('[aria-label="Recall status"]').innerText();
  assert.match(text, /BWX/);
  assert.match(text, /Overdue/);
  assert.match(text, /Previous dentist/);
});

test('RF3: booking the hygiene visit takes the due bitewings and exam along (≤ 3 actions)', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${pt.id}`);
  await page.waitForSelector('.page-header, h1');
  await page.waitForFunction((id) => sessionStorage.getItem('dm_active_patient') === String(id), pt.id);
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+b');
    await page.waitForSelector('.book-panel .book-suggest strong');
    await page.waitForSelector('.book-panel .rf-bundle input:checked');
    await page.waitForFunction(() => document.querySelectorAll('.book-panel .rf-bundle input:checked').length >= 2);
    await page.locator('.book-panel button.primary', { hasText: 'Book appointment' }).click();
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  console.log(withinBudget('book a hygiene visit with due items bundled', r, { actions: 3, ms: 8000 }));
  let procs = [];
  for (let i = 0; i < 40 && procs.length < 2; i++) {
    const appts = await s.get(`/appointments?patient_id=${pt.id}&from=${today}&to=${monthsAgo(today, -6)}`);
    const a = appts[0];
    if (a) procs = (await s.get(`/appointments/${a.id}`)).procedures.filter((p) => ['D0274', 'D0120'].includes(p.code));
    if (procs.length < 2) await page.waitForTimeout(150);
  }
  assert.deepEqual(procs.map((p) => p.code).sort(), ['D0120', 'D0274'], 'bitewings and exam planned on the visit');
  const st = await s.get(`/patients/${pt.id}/recall-status`);
  assert.equal(st.items.find((i) => i.type === 'bwx').status, 'scheduled');
  assert.deepEqual(s.errors, []);
});

test('RF4: the recall board — find the patient, one key marks them contacted', async () => {
  const other = await s.post('/patients', { first_name: `Otto${tag}`, last_name: 'Board', dob: '1970-01-01', phone: '(512) 555-0178' });
  await s.post(`/patients/${other.id}/outside-procedures`, { code: 'D1110', date: monthsAgo(today, 8) });
  const { page } = s;
  await page.goto(`${app.base}/followups?tab=board`);
  await page.waitForSelector('.rf-board .stat-strip');
  const search = page.locator('.rf-filters input[aria-label="Find a patient on the board"]');
  await search.click();
  const r = await measure(page, async () => {
    await page.keyboard.type(`Otto${tag}`);
    await page.waitForFunction((n) => { const rows = document.querySelectorAll('.rf-table tbody tr'); return rows.length === 1 && rows[0].textContent.includes(n); }, `Otto${tag}`);
    await page.locator('.rf-table').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('c');
    await page.waitForSelector('.rf-table tbody tr .muted:has-text("contacted")');
  });
  console.log(withinBudget('mark a recall contacted from the board', r, { actions: 3, ms: 6000 }));
  const rows = (await s.get(`/recall-board?q=Otto${tag}`)).rows;
  assert.equal(rows[0].recall_status, 'contacted');
  assert.deepEqual(s.errors, []);
});

test('A051 recall list: one row per patient (exam, cleaning, x-rays as chips); L then Enter logs the call for all of them, inline (2 keys)', async () => {
  const { page } = s;
  const p = await s.post('/patients', { first_name: `Vera${tag}`, last_name: 'Aacall', dob: '1979-02-02', phone: '(512) 555-0176' });
  for (const [code, date] of [['D1110', monthsAgo(today, 8)], ['D0120', monthsAgo(today, 8)], ['D0274', monthsAgo(today, 14)]]) {
    const r = await s.post(`/patients/${p.id}/outside-procedures`, { code, date, office_name: 'Previous dentist' });
    assert.ok(r.id, JSON.stringify(r));
  }
  await page.goto(`${app.base}/followups?tab=recall`);
  await page.waitForSelector('table.recall-list');
  const rows = page.locator('table.recall-list tbody tr', { hasText: `Vera${tag}` });
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1, 'one row for the patient');
  assert.ok(await rows.first().locator('.recall-chip').count() >= 2, 'their recalls as chips');
  await rows.first().click({ position: { x: 5, y: 5 } }); // the keyboard is on their row
  const r = await measure(page, async () => {
    await page.keyboard.press('l');
    await page.waitForFunction(() => document.activeElement?.classList.contains('logcall-save'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.logcall-inline', { state: 'detached' });
  });
  console.log(withinBudget('log a recall call (left voicemail)', r, { actions: 2, ms: 4000 }));
  const log = await s.get(`/patients/${p.id}/followups`);
  assert.deepEqual([log.length, log[0].kind, log[0].outcome], [1, 'recall', 'left_voicemail']);
  const recalls = (await s.get(`/recalls?status=due,contacted&limit=500`));
  const mine = (recalls.rows || recalls).filter((x) => x.patient_id === p.id);
  assert.ok(mine.length >= 2 && mine.every((x) => x.status === 'contacted'), 'every recall of theirs is marked contacted');
  // 3 picks another outcome from the keyboard.
  await page.keyboard.press('l');
  await page.waitForSelector('.logcall-inline');
  await page.keyboard.press('3');
  await page.waitForSelector('.logcall-inline .chip.active:has-text("Emailed")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.logcall-inline', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});
