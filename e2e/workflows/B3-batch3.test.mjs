// Batch 3 — the scorecard's last B's and leftovers (docs/workflows/scorecard.md): reports one step from the menu or
// the command bar, "export <report>", mark deceased in one step, the staff licence tracker, Ctrl/⌘+Z after an add,
// the recall list's row keys, a one-line late banner, a shorter chart header, and one way into a clinical note.
// signIn() records any browser dialog as an error, so every test also proves no confirm/prompt/alert box.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

const uniq = () => Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6);
const newPatient = async (first, extra = {}) => {
  const p = await s.post('/patients', { first_name: first, last_name: `Bthree${uniq()}`, dob: '1984-03-04', phone: '(512) 555-0142', email: `${first.toLowerCase()}@example.com`, sms_opt_in: 1, ...extra });
  assert.ok(p.id, JSON.stringify(p));
  return p;
};
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { const v = await check().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`timed out waiting for ${what}`);
};
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

test('menu: My bonus and Patient feedback are in Manage; a report is its ▾ and one click (2 actions)', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  const r = await measure(page, async () => {
    const link = page.locator('.sidebar a[href="/bonus"]').first();
    if (!(await link.isVisible())) await page.click('.rail-mod[data-module="manage"] .rail-mod-chev');
    await link.click();
    await page.waitForURL(/\/bonus$/);
  });
  console.log(withinBudget('open My bonus from the menu', r, { actions: 2 }));
  assert.ok(await page.locator('.sidebar a[href="/reviews"]').count(), 'Patient feedback is in the menu');
  assert.deepEqual(s.errors, []);
});

test('command bar: "export day sheet" downloads today’s day sheet as a CSV without opening it (3 actions), recorded', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  let file;
  const r = await measure(page, async () => {
    const dl = page.waitForEvent('download');
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('export day sheet');
    await page.waitForSelector('.palette-item.active:has-text("Export day sheet")');
    await page.keyboard.press('Enter');
    file = await dl;
  });
  console.log(withinBudget('export the day sheet', r, { actions: 3 }));
  assert.match(file.suggestedFilename(), /^day-sheet-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync(await file.path(), 'utf8');
  assert.match(text, /Date,Type,Patient,Description,Method,Reference,Provider \/ by,Amount \(\$\)/);
  assert.equal(new URL(page.url()).pathname, '/schedule', 'still where they were');
  await page.waitForSelector('.palette', { state: 'detached' });
  // Export rows only show once "export" is typed: a report's name alone still opens the report first.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('day sheet');
  await page.waitForSelector('.palette-item');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.palette-item:has(.palette-icon:text-is("⬇"))').count(), 0);
  assert.ok(await page.locator('.palette-item:has-text("Day sheet")').count(), 'the report itself is offered');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });
  // Payroll too: the pay period that just ended, in the format used last.
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type('export payroll');
  assert.equal(await page.inputValue('.palette input'), 'export payroll', 'the bar opens empty (not with the last words)');
  await page.waitForSelector('.palette-item.active:has-text("Export payroll (the pay period that just ended)")');
  await page.keyboard.press('Escape');
  const audit = await s.get('/audit-log?action=report.export');
  const rows = Array.isArray(audit) ? audit : audit.rows || audit.entries || [];
  assert.ok(rows.some((x) => /day-sheet/.test(JSON.stringify(x))), 'the export is in the audit log');
  assert.deepEqual(s.errors, []);
});

test('A179 mark deceased: one step (chart ⋯ menu) — inactive, visit cancelled, summary; Ctrl/⌘+Z puts it back', async () => {
  const { page } = s;
  const p = await newPatient('Walter');
  const today = (await s.get('/dashboard')).today;
  const providers = await s.get('/providers?active=true');
  const chairs = await s.get('/operatories?active=true');
  const day = addDays(today, 45);
  const visit = await s.post('/appointments', { patient_id: p.id, provider_id: providers[0].id, operatory_id: chairs[0].id, start_time: `${day} 07:05`, end_time: `${day} 07:35`, override_blockout: true, notify: false });
  assert.ok(visit.id, JSON.stringify(visit));
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('h1');
  const r = await measure(page, async () => {
    await page.click('main button[title="More"]');
    await page.click('text=Mark deceased');
    await page.waitForSelector('.toast:has-text("marked deceased")');
  });
  console.log(withinBudget('mark a patient deceased', r, { actions: 2 }));
  assert.match(await page.textContent('.toast:has-text("marked deceased")'), /1 future visit cancelled/);
  await page.waitForSelector('h1 .badge.deceased');
  assert.equal((await s.get(`/patients/${p.id}`)).status, 'inactive');
  assert.equal((await s.get(`/appointments/${visit.id}`)).status, 'cancelled');
  // Undo from the keyboard while the notice shows.
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("No longer marked deceased")');
  await until(async () => (await s.get(`/patients/${p.id}`)).status === 'active', 'the chart active again');
  assert.equal((await s.get(`/appointments/${visit.id}`)).status, 'scheduled', 'the visit is back');
  assert.deepEqual(s.errors, []);
});

test('A170 staff licences: "<first name> cpr 10/30/2027" + Enter on the tracker (2 actions), with a reminder rule', async () => {
  const { page } = s;
  const users = (await s.get('/users')).filter((u) => u.active);
  const first = (u) => u.name.replace(/^dr\.?\s+/i, '').split(/\s+/)[0];
  const who = users.find((u) => users.filter((x) => first(x).toLowerCase() === first(u).toLowerCase()).length === 1);
  await page.goto(`${app.base}/documents?tab=staff`);
  await page.waitForSelector('input[aria-label="Add or renew a licence"]:focus');
  const r = await measure(page, async () => {
    await page.keyboard.type(`${first(who).toLowerCase()} cpr 10/30/2027`);
    await page.waitForSelector('.cred-preview:has-text("Enter adds it")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("CPR")');
  });
  console.log(withinBudget('add a staff CPR card', r, { actions: 2 }));
  const list = await s.get('/staff-credentials');
  const row = list.people.find((x) => x.user_id === who.id).credentials.find((c) => c.kind === 'cpr');
  assert.equal(row.expires_on, '2027-10-30');
  assert.equal(row.remind_days, 60);
  await page.waitForSelector(`.cred-chip:has-text("CPR")`);
  assert.deepEqual(s.errors, []);
});

test('settings add line: Ctrl/⌘+Z right after Enter takes back the add (not the typing)', async () => {
  const { page } = s;
  const name = `Chair ${uniq()}`;
  await page.goto(`${app.base}/settings?tab=operatories`);
  await page.waitForFunction(() => !!document.activeElement?.closest('.quick-add'));
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`.toast:has-text("${name}")`);
  const made = await until(async () => (await s.get('/operatories')).find((o) => o.name === name), 'the chair');
  assert.equal(made.active, 1);
  await page.keyboard.press(`${MOD}+z`);
  await until(async () => (await s.get('/operatories')).find((o) => o.id === made.id).active === 0, 'the add undone');
  assert.equal(await page.evaluate(() => document.activeElement?.value || ''), '', 'the typing is not brought back');
  // Typing again after that: Ctrl/⌘+Z is the box's own undo again.
  assert.deepEqual(s.errors, []);
});

test('A037 recall list: B books the highlighted patient, Enter confirms (keyboard only, 2 actions)', async () => {
  const { page } = s;
  await page.goto(`${app.base}/followups?tab=recall`);
  await page.waitForSelector('main tr.kb-row');
  const pid = Number(await page.locator('main tr.kb-row').getAttribute('data-patient-id'));
  const r = await measure(page, async () => {
    await page.keyboard.press('b');
    await page.waitForSelector('.book-panel');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  console.log(withinBudget('book a recall patient', r, { actions: 2 }));
  assert.equal(r.clicks, 0, 'keyboard only');
  const today = (await s.get('/dashboard')).today;
  const appts = await s.get(`/appointments?from=${today}&to=${addDays(today, 400)}`);
  assert.ok((appts.rows || appts).some((a) => a.patient_id === pid), 'booked');
  // One row per patient.
  const names = await page.locator('main table.recall-list tbody tr[data-patient-id]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-patient-id')));
  assert.equal(new Set(names).size, names.length, 'no patient listed twice');
  assert.deepEqual(s.errors, []);
});

test('layout: the late banner is one line for three people; the chart header and tabs leave the whole tooth chart on screen', async () => {
  const { page } = s;
  const localNow = (tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
  };
  const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const tz = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu'].find((z) => { const m = localNow(z)[1]; return m >= 600 && m < 1200; });
  await s.api('PUT', '/practice', { timezone: tz, send_from: '00:00', send_until: '00:00' });
  await s.api('PUT', '/schedule/late-settings', { late_minutes: 5, very_late_minutes: 30 });
  const [day, now] = localNow(tz);
  const doc = await s.post('/providers', { name: `Dr. Ima Late ${uniq()}`, type: 'dentist' });
  for (const [i, first] of ['Ana', 'Bea', 'Cal'].entries()) {
    const chair = await s.post('/operatories', { name: `Late chair ${uniq()}` });
    const p = await newPatient(first);
    await s.post('/appointments', { patient_id: p.id, provider_id: doc.id, operatory_id: chair.id, start_time: at(day, now - 8 - i), end_time: at(day, now + 30), override_blockout: true, notify: false, add_type_procedures: false });
  }
  await page.goto(`${app.base}/schedule?date=${day}&view=day`);
  await page.waitForSelector('.late-banner');
  const banner = await page.locator('.late-banner').boundingBox();
  assert.ok(banner.height <= 64, `the late banner is ${banner.height}px tall (it was ~120)`);
  assert.ok(await page.locator('.late-list li button:has-text("Text")').count(), 'the actions are still there, named');

  const p = await newPatient('Chartie');
  await page.goto(`${app.base}/patients/${p.id}?tab=chart`);
  await page.waitForSelector('.chart-layout svg, .chart-layout .odontogram, .chart-layout canvas');
  const tabs = await page.locator('.pt-tabs').boundingBox();
  assert.ok(tabs.height <= 64, `the grouped tabs are one row (${tabs.height}px)`);
  const card = await page.locator('.card.pt-head').boundingBox();
  assert.ok(card.y + card.height + tabs.height <= 210, `header and tabs end by ${Math.round(card.y + card.height + tabs.height)}px`);
  assert.deepEqual(s.errors, []);
});

test('clinical note: one way in — say or type in the one line, the template picker is at its end', async () => {
  const { page } = s;
  const p = await newPatient('Nota');
  await page.goto(`${app.base}/patients/${p.id}?tab=notes`);
  await page.waitForSelector('[aria-label="Type what to add"]');
  assert.equal(await page.locator('.dictate-bar select[aria-label="Insert a template"]').count(), 1, 'the template picker is in the one entry line');
  assert.equal(await page.locator('.note-composer > .inline select[aria-label="Insert a template"]').count(), 0, 'no separate template row above it');
  assert.deepEqual(s.errors, []);
});
