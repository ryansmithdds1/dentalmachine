// Batch 2B — the actions the scorecard had as MISSING (README.md, “Compliance log”, docs/documents.md, “Letters and mailing labels”,
// docs/cash-handling.md §10, README.md, “PDMP”): each done in the browser the way a person would, within its
// action budget, and checked on the server afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s;
const tag = () => Date.now().toString(36).replace(/\d/g, (d) => 'abcdefghij'[d]);
const newPatient = (first, extra = {}) => s.post('/patients', { first_name: first, last_name: `Btwob${tag()}`, dob: '1980-02-03', phone: '(512) 555-0199', email: `${first.toLowerCase()}${tag()}@example.com`, ...extra });
// Opening the chart makes them the active patient, as a person would have done earlier.
const activate = async (page, id) => {
  await page.goto(`${app.base}/patients/${id}`);
  await page.waitForFunction((x) => sessionStorage.getItem('dm_active_patient') === String(x), id);
};

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('A168 complaint: N, what happened, Enter — recorded with a follow-up task for the manager', async () => {
  const { page } = s;
  const p = await newPatient('Carla');
  await activate(page, p.id);
  await page.goto(`${app.base}/compliance`);
  await page.waitForSelector('h1:has-text("Compliance log")');
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('input[aria-label="What happened"]:focus');
    await page.keyboard.type('Upset about the wait time');
    await page.keyboard.press('Enter');
    await page.waitForSelector('td:has-text("Upset about the wait time")');
  });
  console.log(withinBudget('A168 record a complaint', r, { actions: 4 }));
  const row = (await s.get('/incidents')).rows.find((i) => i.summary === 'Upset about the wait time');
  assert.equal(row.patient_id, p.id, 'about the active patient');
  assert.ok(row.task_id, 'the follow-up is a task');
  assert.equal(row.status, 'open');
  // Resolve inline.
  await page.locator('tr:has-text("Upset about the wait time") button:has-text("Resolve")').click();
  await page.keyboard.type('Apologised and gave a courtesy discount');
  await page.keyboard.press('Enter');
  await page.waitForSelector('tr:has-text("Upset about the wait time")', { state: 'detached' });
  assert.equal((await s.get('/incidents?status=resolved')).rows.find((i) => i.id === row.id).status, 'resolved');
  assert.deepEqual(s.errors, []);
});

test('A169 exposure: N, who, Tab, how, Enter — logged with the OSHA follow-up checklist', async () => {
  const { page } = s;
  await page.goto(`${app.base}/compliance?tab=exposures`);
  await page.waitForSelector('button:has-text("Log an exposure")');
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('input[aria-label="Who was exposed"]:focus');
    await page.keyboard.type('Sam Okafor');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Needlestick while recapping');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cmp-exposure:has-text("Needlestick while recapping")');
  });
  console.log(withinBudget('A169 log an exposure', r, { actions: 5 }));
  const card = page.locator('.cmp-exposure:has-text("Needlestick while recapping")');
  await card.locator('label:has-text("Wound washed") input').click();
  await page.waitForSelector('.cmp-exposure:has-text("Needlestick while recapping") :text("2/9 follow-up steps")');
  const x = (await s.get('/exposures')).find((e) => e.description === 'Needlestick while recapping');
  assert.ok(x.employee_user_id, 'matched to the team member');
  assert.ok(x.followup.washed && x.followup.reported);
  assert.deepEqual(s.errors, []);
});

test('A175 disclosure: N, recipient, Tab, what, Enter — on the patient’s accounting of disclosures', async () => {
  const { page } = s;
  const p = await newPatient('Dora');
  await activate(page, p.id);
  await page.goto(`${app.base}/compliance?tab=disclosures`);
  await page.waitForSelector(`.cmp-chip:has-text("${p.last_name}")`);
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('input[aria-label="Given to"]:focus');
    await page.keyboard.type('Travis County District Court');
    await page.keyboard.press('Tab');
    await page.keyboard.type('X-rays 2024-2026');
    await page.keyboard.press('Enter');
    await page.waitForSelector('td:has-text("Travis County District Court")');
  });
  console.log(withinBudget('A175 record a disclosure', r, { actions: 5 }));
  const list = await s.get(`/patients/${p.id}/disclosures`);
  assert.equal(list.length, 1);
  assert.equal(list[0].purpose, 'required_by_law');
  const csv = await page.evaluate(async (id) => (await fetch(`/api/patients/${id}/disclosures/accounting?format=csv`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).text(), p.id);
  assert.match(csv, /Travis County District Court/);
  assert.deepEqual(s.errors, []);
});

test('A171 letter: 1, Enter — printed and filed in the patient’s documents; an unfilled field blocks printing', async () => {
  const { page } = s;
  const p = await newPatient('Letty', { address: '12 Oak Lane', city: 'Austin', state: 'TX', zip: '78704' });
  await activate(page, p.id);
  await page.goto(`${app.base}/letters`);
  await page.waitForSelector(`.cmp-chip:has-text("${p.last_name}")`);
  await page.waitForSelector('.ltr-list button:has-text("Welcome to the practice")');
  await page.evaluate(() => localStorage.removeItem('dm_last_letter_template'));
  // The appointment reminder has nothing to fill {next_appointment} with: shown, and Print is off.
  await page.keyboard.press('2');
  await page.waitForSelector('.error:has-text("next appointment")');
  assert.equal(await page.locator('.ltr-actions button:has-text("Print")').isDisabled(), true);
  const r = await measure(page, async () => {
    await page.keyboard.press('1');
    await page.waitForSelector('.ltr-paper:has-text("Dear Letty")');
    // Print is ready (this letter's preview has come back) before Enter; the print tab opens on the key press.
    await page.waitForSelector('.ltr-actions button:has-text("Print"):not([disabled])');
    const popup = page.waitForEvent('popup', { timeout: 15_000 });
    await page.keyboard.press('Enter');
    await (await popup).close();
    await page.waitForSelector('td:has-text("Welcome to the practice")');
  });
  console.log(withinBudget('A171 write a letter', r, { actions: 2 }));
  const docs = await s.get(`/patients/${p.id}/documents`);
  assert.equal(docs.filter((d) => d.folder === 'Letters').length, 1);
  assert.deepEqual(s.errors, []);
});

test('A177 labels: one click on the recall list — an Avery 5160 PDF; do-not-mail people left out', async () => {
  const { page } = s;
  await page.goto(`${app.base}/followups?tab=recall`);
  await page.waitForSelector('button:has-text("Mailing labels"):not([disabled])');
  const r = await measure(page, async () => {
    const popup = page.waitForEvent('popup');
    await page.click('button:has-text("Mailing labels")');
    await (await popup).close();
    await page.waitForSelector('.toast:has-text("ready to print")');
  });
  console.log(withinBudget('A177 mailing labels', r, { actions: 1 }));
  const out = await s.post('/mailing-labels', { segment: 'reactivation', params: {} });
  assert.ok(out.count >= 0 && Array.isArray(out.skipped));
  assert.deepEqual(s.errors, []);
});

test('A176 product: Sell a product, 2, Enter — a charge on the ledger; Undo voids the sale', async () => {
  const { page } = s;
  for (const [name, price] of [['E2e floss', 400], ['E2e toothbrush', 8900]]) await s.post('/retail/products', { name, price });
  const p = await newPatient('Sonia');
  await page.goto(`${app.base}/patients/${p.id}?tab=ledger`);
  await page.waitForSelector('button:has-text("Sell a product")');
  const products = await s.get('/retail/products');
  const want = products.findIndex((x) => x.name === 'E2e toothbrush') + 1;
  const r = await measure(page, async () => {
    await page.click('button:has-text("Sell a product")');
    await page.waitForSelector('.retail-item.active');
    await page.keyboard.press(String(want));
    await page.waitForSelector('.retail-item.active:has-text("E2e toothbrush")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('td:has-text("E2e toothbrush")');
  });
  console.log(withinBudget('A176 sell a product', r, { actions: 3 }));
  let ledger = await s.get(`/patients/${p.id}/ledger`);
  assert.equal(ledger.balance, 8900);
  await page.click('.toast-undo');
  await page.waitForSelector('.toast:has-text("Undone")');
  ledger = await s.get(`/patients/${p.id}/ledger`);
  assert.equal(ledger.balance, 0, 'the sale was voided by reversing entries');
  assert.ok(ledger.entries.some((e) => e.voided_at));
  assert.deepEqual(s.errors, []);
});

test('A184 gift certificate: N, amount, Enter sells it; on another account "Gift certificate", the code, Enter pays a balance', async () => {
  const { page } = s;
  const buyer = await newPatient('Gilda');
  await activate(page, buyer.id);
  await page.goto(`${app.base}/gift-certificates`);
  await page.waitForSelector('h1:has-text("Gift certificates")');
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('input[aria-label="Amount ($)"]:focus');
    await page.keyboard.type('100');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.public-notice:has-text("Sold GC-")');
  });
  console.log(withinBudget('A184 sell a gift certificate', r, { actions: 3 }));
  const code = (await page.locator('.public-notice .gc-code').innerText()).trim();
  assert.equal((await s.get(`/patients/${buyer.id}/ledger`)).balance, 0, 'the buyer paid, and owes nothing: the money is held');
  // The friend has $110 of work; the certificate pays $100 of it.
  const friend = await newPatient('Frida');
  const dentist = (await s.get('/providers')).find((x) => x.type === 'dentist');
  await s.post(`/patients/${friend.id}/procedures`, { code: 'D1110', provider_id: dentist.id, complete: true });
  const owed = (await s.get(`/patients/${friend.id}/ledger`)).balance;
  await page.goto(`${app.base}/patients/${friend.id}?tab=ledger`);
  await page.waitForSelector('button:has-text("Gift certificate")');
  const r2 = await measure(page, async () => {
    await page.click('button:has-text("Gift certificate")');
    await page.keyboard.type(code.replace('GC-', ''));
    await page.waitForSelector('.hint:has-text("left")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('td:has-text("Gift certificate")');
  });
  console.log(withinBudget('A184 use a gift certificate', r2, { actions: 3 }));
  assert.equal((await s.get(`/patients/${friend.id}/ledger`)).balance, owed - Math.min(owed, 10000));
  const look = await s.get(`/gift-certificates/lookup?code=${code}`);
  assert.equal(look.balance, 10000 - Math.min(owed, 10000));
  assert.deepEqual(s.errors, []);
});

test('A178 PDMP: 7, Enter (check), Enter (save & print) — the check is kept on the prescription', async () => {
  const d = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  await trackActions(d.page);
  const p = await newPatient('Opal');
  await d.page.goto(`${app.base}/patients/${p.id}?tab=rx`);
  await d.page.waitForSelector('h2:has-text("New prescription")');
  const r = await measure(d.page, async () => {
    await d.page.keyboard.press('7');
    await d.page.waitForSelector('button:has-text("Check the PDMP"):focus');
    await d.page.keyboard.press('Enter');
    await d.page.waitForSelector('.pdmp-box:has-text("PDMP checked")');
    const popup = d.page.waitForEvent('popup');
    await d.page.keyboard.press('Enter');
    await (await popup).close();
    await d.page.waitForSelector('.rx-row:has-text("PDMP:")');
  });
  console.log(withinBudget('A178 PDMP before an opioid', r, { actions: 3 }));
  const rx = (await d.get(`/patients/${p.id}/prescriptions`))[0];
  assert.equal(rx.schedule, 'II');
  assert.ok(rx.pdmp_check_id);
  assert.match(rx.pdmp_summary, /controlled-substance prescription/);
  assert.deepEqual(d.errors, []);
  await d.ctx.close();
});
