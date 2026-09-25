// End-to-end: the core day in a real browser against a real server and database.
// New patient → insurance → book → check in → chart and complete → claim → ERA posts the payment → statement.
// Run: npm run build && npm run e2e   (starts its own server on a fresh SQLite database, seeded with the demo
// practice; E2E_URL=http://localhost:4000 runs against a server you started instead).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let base = process.env.E2E_URL;
let server;
let dir;
let browser;
let page;
const errors = [];

before(async () => {
  if (!base) {
    if (!existsSync(join(root, 'client/dist/index.html'))) throw new Error('Build the client first: npm run build');
    dir = mkdtempSync(join(tmpdir(), 'dm-e2e-'));
    const port = 4900 + Math.floor(Math.random() * 90);
    const env = {
      ...process.env, DATABASE_PATH: join(dir, 'e2e.db'), DATABASE_URL: '', JWT_SECRET: 'e2e-secret', PORT: String(port), APP_URL: `http://localhost:${port}`,
      UPLOAD_DIR: join(dir, 'uploads'), EDI_MODE: 'sandbox', PAYMENTS: 'sandbox', SMS_DRIVER: 'log', MAIL_DRIVER: 'log', REMINDERS: 'off', NODE_ENV: 'test',
    };
    const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/seed.js'], { cwd: root, env, encoding: 'utf8' });
    if (seeded.status !== 0) throw new Error(`Seeding failed: ${seeded.stderr}`);
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', (d) => process.env.E2E_DEBUG && process.stderr.write(d));
    base = `http://localhost:${port}`;
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const api = (path) => page.evaluate(async (p) => (await fetch(`/api${p}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).json(), path);
const closeAlerts = async () => {
  await page.waitForTimeout(400);
  while (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
};

// On failure, a screenshot of where it stopped (E2E_SHOTS=dir to keep them).
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (err) {
    const shot = join(process.env.E2E_SHOTS || tmpdir(), `e2e-failed-${name.replace(/\W+/g, '-')}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    err.message = `${name}: ${err.message}\nScreenshot: ${shot}${errors.length ? `\nPage errors: ${errors.join('; ')}` : ''}`;
    throw err;
  }
};
const last = `Endtoend${Date.now().toString(36)}`;

test('a new patient from first visit to paid claim and statement', async () => {
  // Sign in.
  await page.goto(base);
  await page.fill('input[autocomplete=username]', 'admin@demo.dentalmachine.app');
  await page.fill('input[type=password]', 'demo-password-123');
  await page.click('button.primary');
  await page.waitForSelector('.sidebar');

  // New patient.
  await step('new patient', async () => {
  await page.goto(`${base}/patients?new=1`);
  await page.getByLabel('First name *').fill('Erin');
  await page.getByLabel('Last name *').fill(last);
  await page.getByLabel('Date of birth').fill('1988-06-15');
  await page.getByLabel('Mobile phone (texts go here)').fill(`(512) 555-${String(Date.now() % 10000).padStart(4, '0')}`);
  await page.locator('.modal button.primary').click();
  await page.waitForURL(/\/patients\/\d+/);
  await closeAlerts();
  });
  const patientId = Number(page.url().match(/patients\/(\d+)/)[1]);

  // Insurance.
  await step('insurance', async () => {
  await page.click('.tabs button:has-text("Insurance")');
  await page.click('text=+ Type it in');
  const carrier = page.locator('.modal label:has-text("Carrier *") select');
  await carrier.selectOption({ index: 1 });
  await page.getByLabel('Subscriber name *').fill(`Erin ${last}`);
  await page.getByLabel('Member ID *').fill('E2E12345');
  await page.locator('.modal button.primary').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  });
  const policies = await api(`/patients/${patientId}/insurance`);
  assert.equal(policies.length, 1);

  // Book today, with an appointment type that brings its procedures (exam and cleaning).
  const { today } = await api('/dashboard'); // the practice's date, whatever the machine's clock says
  await step('book', async () => {
    await page.goto(`${base}/schedule?book=${patientId}`);
    const type = page.locator('.book-panel label:has-text("Appointment type") select');
    const cleaning = await type.locator('option').filter({ hasText: /cleaning/i }).first().getAttribute('value');
    await type.selectOption(cleaning);
    const modal = page.locator('.book-panel');
    await modal.getByLabel('Date', { exact: true }).fill(today);
    await modal.getByLabel('Start time').fill('18:00');
    const provider = page.locator('.book-panel label:has-text("Provider") select').first();
    if (!(await provider.inputValue())) await provider.selectOption({ index: 1 });
    await page.locator('.book-panel .form-actions button.primary').click();
    // Outside office hours or on a closed day, the form asks first.
    const anyway = page.locator('.book-panel button:has-text("Book it anyway")');
    await Promise.race([anyway.waitFor().then(() => anyway.click()), page.waitForSelector('.book-panel', { state: 'detached' })]).catch(() => {});
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  const appt = (await api(`/appointments?date=${today}&patient_id=${patientId}`))[0];
  assert.ok(appt, 'appointment booked');

  // Check in and seat from the schedule.
  await step('check in', async () => {
    await page.goto(`${base}/schedule?date=${today}`);
    await page.locator('.cal-appt', { hasText: last }).first().click();
    await page.locator('.drawer button:has-text("Check in")').first().click();
    await page.locator('.drawer button:has-text("Seat")').first().click();
    await page.locator('.drawer button:has-text("Check out…")').waitFor();
  });
  assert.equal((await api(`/appointments/${appt.id}`)).status, 'in_chair');

  // Chart: a two-surface filling on #30, done today.
  await step('chart', async () => {
    await page.goto(`${base}/patients/${patientId}?tab=chart`);
    await closeAlerts();
    await page.click('[title="Tooth 30"]');
    await page.fill('input[aria-label="Procedure code"]', 'D2392');
    await page.locator('.code-picker .results button', { hasText: 'D2392' }).first().click();
    await page.getByRole('button', { name: 'M', exact: true }).click();
    await page.getByRole('button', { name: 'O', exact: true }).click();
    await page.locator('label:has-text("Provider") select').last().selectOption({ label: 'Dr. Alex Chen, DDS' });
    await page.getByRole('button', { name: 'Completed today', exact: true }).click();
    await page.click('button.primary:has-text("Chart as completed")');
    await closeAlerts(); // the note prompt
  });
  const charted = (await api(`/patients/${patientId}/procedures`)).find?.((p) => p.code === 'D2392');
  assert.equal(charted?.status, 'completed');
  assert.equal(charted.surfaces, 'MO');

  // Check out: complete the visit's procedures, bill insurance, finish.
  await step('checkout', async () => {
    await page.goto(`${base}/checkout/${appt.id}`);
    await page.click('button:has-text("planned procedure")');
    await page.locator('text=charges posted').waitFor();
    await page.click('button:has-text("claim to")'); // "Send claim to …" with a clearinghouse, else "Create claim to …"
    await page.locator('text=/Claim #\\d+ (created|sent|saved)/').first().waitFor();
    await page.click('button:has-text("Mark checked out")');
    await page.locator('.badge:has-text("Checked out")').waitFor();
  });
  const claims = await api(`/claims?patient_id=${patientId}`);
  assert.equal(claims.length, 1);
  assert.equal((await api(`/appointments/${appt.id}`)).status, 'completed');

  // Send the claim; the (sandbox) clearinghouse answers with an acknowledgment, the payer's claim status and
  // an ERA, which posts the insurance payment on its own.
  const claimId = claims[0].id;
  await step('send claim', async () => {
    await page.goto(`${base}/claims/${claimId}`);
    // Checkout already sends it when a clearinghouse is connected (workflow 24); send by hand only a draft.
    if ((await api(`/claims/${claimId}`)).status === 'draft') await page.click('button:has-text("Send to clearinghouse")');
    for (let i = 0; i < 40 && (await api(`/claims/${claimId}`)).status === 'draft'; i++) await page.waitForTimeout(250);
    await page.locator('.timeline li', { hasText: /accepted|sent|paid/i }).first().waitFor();
  });
  await step('ERA', async () => {
    await page.goto(`${base}/claims?tab=claims`);
    // The sandbox's answers can take a moment after the send: check again until the ERA has posted.
    for (let i = 0; i < 10 && !['paid', 'partially_paid'].includes((await api(`/claims/${claimId}`)).status); i++) {
      await page.click('button:has-text("Check for responses")');
      await page.locator('button:has-text("Check for responses")').waitFor();
      for (let j = 0; j < 4 && !['paid', 'partially_paid'].includes((await api(`/claims/${claimId}`)).status); j++) await page.waitForTimeout(250);
    }
  });
  // Clean ERA payments wait on the insurance autopilot for one "Post all" (a person posts the money).
  await step('post ERA', async () => {
    if (['paid', 'partially_paid'].includes((await api(`/claims/${claimId}`)).status)) return;
    await page.goto(`${base}/claims?tab=autopilot`);
    await page.click('button:has-text("Post all")');
    for (let i = 0; i < 20 && !['paid', 'partially_paid'].includes((await api(`/claims/${claimId}`)).status); i++) await page.waitForTimeout(250);
  });
  const paid = await api(`/claims/${claimId}`);
  assert.ok(['paid', 'partially_paid'].includes(paid.status), `claim is ${paid.status}`);
  assert.ok(paid.paid_amount > 0);
  const ledger = await api(`/patients/${patientId}/ledger`);
  assert.ok(ledger.entries.some((e) => e.type === 'insurance_payment' && -e.amount === paid.paid_amount), 'insurance payment on the ledger');

  // The statement shows what's left for the patient, with a way to pay.
  await step('statement', async () => {
    await page.goto(`${base}/patients/${patientId}/statement`);
    await page.locator('.statement-stub').waitFor();
  });
  const due = await page.locator('.statement-due-amount').textContent();
  assert.equal(due, `$${(ledger.patient_portion / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  assert.ok(ledger.patient_portion > 0, 'the filling and the rest of the visit are the patient\'s to pay');
  assert.equal(await page.locator('text=Insurance payment').count() + await page.locator('td:has-text("Insurance")').count() > 0, true);

  assert.deepEqual(errors, [], 'no errors in the page');
});

/* global document, window */
// Chairside on an iPad and a phone: the chart stacks, a tapped tooth brings its panel up, dictation types
// into the note, and nothing scrolls sideways.
test('chairside on a tablet and a phone', async () => {
  for (const [label, viewport] of [['ipad', { width: 820, height: 1180 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const tab = await ctx.newPage();
    tab.setDefaultTimeout(15_000);
    tab.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    try {
      await tab.goto(base);
      await tab.fill('input[autocomplete=username]', 'admin@demo.dentalmachine.app');
      await tab.fill('input[type=password]', 'demo-password-123');
      await tab.click('button.primary');
      await tab.waitForSelector('.app-shell, .sidebar, .topbar', { state: 'attached' });
      const patients = await tab.evaluate(async () => (await fetch('/api/patients?limit=1', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).json());
      const pid = (patients.rows || patients)[0].id;
      const sideways = () => tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      await tab.goto(`${base}/patients/${pid}?tab=chart`);
      await tab.waitForSelector('.odontogram2');
      while (await tab.locator('.modal-backdrop').count()) { await tab.keyboard.press('Escape'); await tab.waitForTimeout(150); }
      assert.equal(await sideways(), 0, `${label}: chart scrolls sideways`);
      const teeth = await tab.locator('.chart-layout > .card').first().boundingBox();
      const panel = await tab.locator('.chart-layout > div').nth(1).boundingBox();
      assert.ok(panel.y > teeth.y + teeth.height - 1, `${label}: the entry panel sits under the teeth`);
      await tab.locator('.tooth2[data-tooth="30"]').tap();
      await tab.getByText('Tooth #30').first().waitFor();
      await tab.waitForTimeout(600);
      const heading = await tab.getByText('Tooth #30').first().boundingBox();
      assert.ok(heading.y >= 0 && heading.y < viewport.height, `${label}: the tapped tooth's panel is on screen`);

      await tab.click('button:has-text("Dictate today")');
      await tab.waitForSelector('.note-composer');
      await tab.fill('.dictate-type input', 'patient tolerated well');
      await tab.press('.dictate-type input', 'Enter');
      await tab.waitForFunction(() => /tolerated/i.test(document.querySelector('.note-composer textarea')?.value || ''));
      assert.equal(await sideways(), 0, `${label}: dictation scrolls sideways`);
      await tab.keyboard.press('Escape');

      await tab.goto(`${base}/schedule`);
      await tab.waitForTimeout(800);
      assert.equal(await sideways(), 0, `${label}: schedule scrolls sideways`);
    } finally {
      await ctx.close();
    }
  }
  assert.deepEqual(errors, []);
});
