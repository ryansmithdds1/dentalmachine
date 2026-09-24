// Money workflows, on the keyboard and within budget:
//  #11 complete today's work (2), #12 take a payment (2), #16 book the next hygiene visit at checkout (2),
//  #17 explain a balance (1), #18 estimate the patient's portion (2).
// Specs: docs/workflows/specs/11-complete-procedures.md, 12-take-payment.md, 16-next-hygiene.md,
// 17-explain-balance.md, 18-estimate.md
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let visit; let planned;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  // A patient with no visit on today's schedule gets one (early, before the day starts, so it never collides),
  // with two procedures planned on it — the same on any day of the week.
  const today = (await s.get('/appointments')).map((a) => a.patient_id);
  const list = await s.get('/patients?limit=50');
  const pick = (list.rows || list).find((p) => !today.includes(p.id));
  const dentist = (await s.get('/providers')).find((p) => p.type === 'dentist');
  // The demo practice is in Austin: "today" is its local date.
  const practiceDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  visit = await s.post('/appointments', { patient_id: pick.id, provider_id: dentist.id, start_time: `${practiceDay} 06:00`, end_time: `${practiceDay} 06:30`, reason: 'Exam', override_blockout: true });
  assert.ok(visit.id, JSON.stringify(visit));
  planned = [];
  for (const code of ['D0120', 'D0274']) planned.push(await s.post(`/patients/${pick.id}/procedures`, { code, appointment_id: visit.id }));
  assert.ok(planned.every((p) => p.status === 'planned'), JSON.stringify(planned));
  patient = await s.get(`/patients/${pick.id}`);
});
after(async () => { await browser?.close(); await app?.stop(); });

test("#11 complete today's work: Shift+C, Enter — 2 actions, charges posted", async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=chart`);
  await page.waitForSelector('button:has-text("Complete today\'s work (2)")');
  const before = (await s.get(`/patients/${patient.id}/ledger`)).balance;
  const r = await measure(page, async () => {
    await page.keyboard.press('Shift+C');
    await page.waitForSelector('.proc-confirm:has-text("post")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.proc-done:has-text("Completed 2 procedures")');
  });
  console.log(withinBudget("#11 complete today's work", r, { actions: 2, ms: 4000 }));
  const chart = await s.get(`/patients/${patient.id}/chart`);
  const done = chart.procedures.filter((p) => planned.some((x) => x.id === p.id));
  assert.ok(done.every((p) => p.status === 'completed'), 'both completed');
  assert.ok(done.every((p) => p.provider_id), 'a provider was chosen for each');
  const ledger = await s.get(`/patients/${patient.id}/ledger`);
  assert.equal(ledger.balance, before + planned.reduce((sum, p) => sum + p.fee, 0), 'charges posted once');

  // Un-complete with the reason typed in the row (no window.prompt): the charge is reversed, not deleted.
  const row = page.locator('tr', { hasText: 'D0274' }).first();
  await row.locator('button:has-text("Undo")').click();
  await page.keyboard.type('Charted on the wrong visit');
  await page.keyboard.press('Enter');
  await page.waitForFunction(async ([pid, id]) => {
    const r = await fetch(`/api/patients/${pid}/chart`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } });
    return (await r.json()).procedures.find((p) => p.id === id)?.status === 'planned';
  }, [patient.id, planned[1].id]);
  const after = await s.get(`/patients/${patient.id}/ledger`);
  assert.ok(after.entries.some((e) => e.void_reason === 'Charted on the wrong visit'));
  assert.deepEqual(s.errors, [], 'no dialogs');
});

test('#18 estimate while typing "14 D2740": 2 actions, nothing charted', async () => {
  const { page } = s;
  await page.locator('h3:has-text("Procedures")').click();
  const count = (await s.get(`/patients/${patient.id}/chart`)).procedures.length;
  const r = await measure(page, async () => {
    await page.keyboard.type('1'); // any digit on the chart starts an entry
    await page.keyboard.type('4 D2740');
    await page.waitForSelector('.chart-entry .est:has-text("Est. patient $")');
  });
  console.log(withinBudget('#18 estimate', r, { actions: 2, ms: 4000 }));
  const est = await page.textContent('.chart-entry .est');
  const server = await s.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2740', tooth: '14' }] });
  assert.ok(est.includes(`$${(server.total_patient / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`), `${est} vs ${server.total_patient}`);
  await page.keyboard.press('Escape');
  assert.equal((await s.get(`/patients/${patient.id}/chart`)).procedures.length, count, 'a preview charts nothing');
});

test('#12 take a payment with the patient active: Alt+P, Enter — 2 actions, last method remembered', async () => {
  const { page } = s;
  await s.api('PUT', '/me/prefs/payment.method', { value: 'cash' });
  await page.goto(`${app.base}/claims`); // anywhere: the patient is active
  await page.waitForSelector('.patient-bar .pb-name');
  const ledger = await s.get(`/patients/${patient.id}/ledger`);
  assert.ok(ledger.patient_portion > 0, 'the patient owes something');
  const payments = ledger.entries.filter((e) => e.type === 'payment').length;
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+p');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Payment amount');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inline-panel[aria-label="Take payment"]', { state: 'detached' });
  });
  console.log(withinBudget('#12 take a payment', r, { actions: 2, ms: 5000 }));
  const after = await s.get(`/patients/${patient.id}/ledger`);
  const paid = after.entries.filter((e) => e.type === 'payment');
  assert.equal(paid.length, payments + 1, 'posted once');
  assert.equal(-paid.at(-1).amount, ledger.patient_portion, 'the patient portion');
  assert.equal(paid.at(-1).method, 'cash', 'the method this person used last');
  assert.equal(await page.locator('.modal').count(), 0, 'no dialog');
});

test('#17 why this balance: Alt+L — 1 action, by visit, adds up', async () => {
  const { page } = s;
  // A new charge so there's something to explain.
  await s.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', complete: true });
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name');
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+l');
    await page.waitForSelector('.why-balance .why-visit');
  });
  console.log(withinBudget('#17 explain a balance', r, { actions: 1, ms: 4000 }));
  const why = await s.get(`/patients/${patient.id}/balance-explained`);
  const text = await page.textContent('.why-balance');
  assert.match(text, /Patient owes \$/);
  assert.equal(why.visits.reduce((sum, v) => sum + v.totals.open, 0) - why.unapplied_credit + why.other, why.balance, 'the parts add up to the balance');
  // W hides and shows it; the statement is one click away for printing.
  await page.locator('h2:has-text("Ledger")').click();
  await page.keyboard.press('w');
  await page.waitForSelector('.why-balance', { state: 'detached' });
  await page.keyboard.press('w');
  await page.waitForSelector('.why-balance .why-visit');
  assert.equal(await page.locator('.why-balance a[href$="/statement"]').count(), 1);
});

test('#16 book the next hygiene visit at checkout: click, Enter — 2 actions, first open slot with the hygienist', async () => {
  const { page } = s;
  await page.goto(`${app.base}/checkout/${visit.id}`);
  const book = page.locator('button:has-text("recall")').first();
  await book.waitFor();
  const co = await s.get(`/appointments/${visit.id}/checkout`);
  const recall = co.recalls.find((x) => ['due', 'contacted'].includes(x.status));
  const q = new URLSearchParams({ from: recall.due_date, count: '3', ...(recall.appointment_type_id ? { appointment_type_id: String(recall.appointment_type_id) } : {}) });
  const suggested = await s.get(`/patients/${patient.id}/next-slots?${q}`);
  assert.equal(suggested.provider.type, 'hygienist');
  const r = await measure(page, async () => {
    await book.click();
    await page.waitForFunction(() => document.activeElement?.closest('.slot-picks'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.public-notice:has-text("Booked")');
  });
  console.log(withinBudget('#16 next hygiene visit', r, { actions: 2, ms: 5000 }));
  const next = (await s.get(`/patients/${patient.id}`)).upcoming_appointments.find((a) => a.start_time === suggested.slots[0].start_time);
  assert.ok(next, 'booked at the first suggestion');
  assert.equal(next.provider_id, suggested.provider.id, 'with the hygienist');
  assert.ok(next.start_time.slice(0, 10) >= recall.due_date || next.start_time.slice(0, 10) >= visit.start_time.slice(0, 10), 'not before the recall is due');
  assert.deepEqual(s.errors, [], 'no dialogs or page errors');
});
