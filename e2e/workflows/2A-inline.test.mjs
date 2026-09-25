// Phase 2, batch 2A: things that used to open a dialog or a browser "are you sure?" box now happen in place, with
// an Undo toast, within the budgets in docs/workflows/specs/ and the robot's targets (e2e/actions/actions.json).
// signIn() records any browser dialog as an error, so every test here also proves no confirm/prompt/alert box.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn, root } from '../lib/server.mjs';
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
  const p = await s.post('/patients', { first_name: first, last_name: `Inline${uniq()}`, dob: '1984-03-04', phone: '(512) 555-0142', email: `${first.toLowerCase()}@example.com`, ...extra });
  assert.ok(p.id, JSON.stringify(p));
  return p;
};
const focusIn = (sel) => s.page.waitForFunction((x) => !!document.activeElement?.closest(x), sel);

test('no browser confirm, prompt or alert boxes left in the client', () => {
  const found = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(f)) {
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*\/\//.test(line)) return;
          if (/(?:window\.|[^.\w])(confirm|prompt|alert)\(/.test(line) && !/isYes|confirm\(\[|confirm\(rows/.test(line)) found.push(`${p.slice(root.length + 1)}:${i + 1}`);
        });
      }
    }
  };
  walk(join(root, 'client/src'));
  assert.deepEqual(found, [], 'use ConfirmButton / AskButton (components/ui.jsx) or an undo toast instead');
});

test('Settings list: the add line has the cursor; "Guardian…" fills its payer ID; Enter adds (2 actions) and Undo sets it inactive', async () => {
  const { page } = s;
  const name = `Guardian Dental ${uniq()}`;
  await page.goto(`${app.base}/settings?tab=carriers`);
  await focusIn('.quick-add');
  const r = await measure(page, async () => {
    await page.keyboard.type(name);
    await page.waitForFunction(() => document.querySelector('.quick-add label:nth-of-type(2) input')?.value === '64246');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.toast:has-text("Added “${name}”")`);
  });
  console.log(withinBudget('add an insurance carrier', r, { actions: 2 }));
  assert.equal(await page.locator('.modal').count(), 0, 'no dialog');
  const made = (await s.get('/carriers')).find((c) => c.name === name);
  assert.equal(made.payer_id, '64246');
  // The cursor is back in the add line for the next one, so Undo is the toast's button (Ctrl/⌘+Z undoes the typing).
  await page.click(`.toast:has-text("Added “${name}”") .toast-undo`);
  await page.waitForSelector('.toast:has-text("set inactive")');
  assert.equal((await s.get('/carriers')).find((c) => c.id === made.id).active, 0);
  // Edit opens under its row, not in a dialog.
  await page.locator('.settings-body tr', { hasText: name }).locator('button:has-text("Edit")').click();
  await page.waitForSelector('.inline-editor-row form');
  assert.equal(await page.locator('.modal').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.inline-editor-row', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});

test('procedure code in one line ("D9123 Consultation 95"): code, description, fee and category (2 actions)', async () => {
  const { page } = s;
  const code = `D9${String(Date.now()).slice(-3)}`;
  await page.goto(`${app.base}/settings?tab=codes`);
  await focusIn('.quick-add');
  const r = await measure(page, async () => {
    await page.keyboard.type(`${code} Robot consultation 95`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.toast:has-text("Added")`);
  });
  console.log(withinBudget('add a procedure code', r, { actions: 2 }));
  const row = (await s.get('/procedure-codes')).find((c) => c.code === code);
  assert.equal(row.description, 'Robot consultation');
  assert.equal(row.fee, 9500);
  assert.equal(row.category, 'adjunctive');
  assert.deepEqual(s.errors, []);
});

test('Users: invite on one line (4 actions) and change a role in the list (saved, audited, Undo)', async () => {
  const { page } = s;
  await page.goto(`${app.base}/settings?tab=users`);
  await focusIn('.quick-add');
  const email = `riley.${uniq()}@example.com`;
  const r = await measure(page, async () => {
    await page.keyboard.type('Riley Inline');
    await page.keyboard.press('Tab');
    await page.keyboard.type(email);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.invite-sent') || [...document.querySelectorAll('.toast')].some((t) => /Invitation emailed/.test(t.textContent)));
  });
  console.log(withinBudget('invite a staff member', r, { actions: 4 }));
  const user = (await s.get('/users')).find((u) => u.email === email);
  assert.equal(user.role, 'front_desk', 'front desk to start with');
  if (await page.locator('.invite-sent button:has-text("Done")').count()) await page.click('.invite-sent button:has-text("Done")');
  await page.locator(`select[aria-label="Role for Riley Inline"]`).selectOption('billing');
  await page.waitForSelector('.toast:has-text("Riley Inline is now Billing")');
  assert.equal((await s.get('/users')).find((u) => u.id === user.id).role, 'billing');
  await page.click('.toast:has-text("is now Billing") .toast-undo');
  await page.waitForSelector('.toast:has-text("back to Front desk")');
  assert.equal((await s.get('/users')).find((u) => u.id === user.id).role, 'front_desk');
  assert.deepEqual(s.errors, []);
});

test('chart: office alert, usual hygienist, name and a family member change in place (≤ 3 actions each)', async () => {
  const { page } = s;
  const p = await newPatient('Olive');
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('#medical-history');
  const alert = await measure(page, async () => {
    await page.click('.contact-card button[aria-label^="Change office alert"]');
    await page.waitForSelector('.contact-card input[aria-label^="Office alert"]');
    await page.keyboard.type('Anxious — offer nitrous');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("office alert is now")');
  });
  console.log(withinBudget('office alert in place', alert, { actions: 3 }));
  assert.equal((await s.get(`/patients/${p.id}`)).office_alert, 'Anxious — offer nitrous');
  assert.equal(await page.locator('.office-alert-banner').count(), 0, 'no pop-up for the person who just typed it');

  const hyg = (await s.get('/providers?active=true')).find((x) => x.type === 'hygienist');
  if (hyg) {
    await page.click('.contact-card button[aria-label^="Change usual hygienist"]');
    await page.locator('.contact-card select[aria-label^="Usual hygienist"]').selectOption(String(hyg.id));
    await page.waitForSelector('.toast:has-text("usual hygienist is now")');
    assert.equal((await s.get(`/patients/${p.id}`)).primary_hygienist_id, hyg.id);
  }

  const name = await measure(page, async () => {
    await page.click('h1 .name-in-place');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'First name');
    await page.keyboard.type('Olivia');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Name corrected to Olivia")');
  });
  console.log(withinBudget('correct a name', name, { actions: 3 }));
  assert.equal((await s.get(`/patients/${p.id}`)).first_name, 'Olivia');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(async (id) => (await (await fetch(`/api/patients/${id}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).json()).first_name === 'Olive', p.id);

  await page.goto(`${app.base}/patients/${p.id}?tab=family`);
  await page.waitForSelector('.family-add input');
  const fam = await measure(page, async () => {
    await page.click('.family-add input');
    await page.keyboard.type('Kit 6/6/2016');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("added to the family")');
  });
  console.log(withinBudget('add a family member', fam, { actions: 3 }));
  const kid = (await s.get(`/patients/${p.id}/family`)).members.find((m) => m.first_name === 'Kit');
  assert.equal(kid.dob, '2016-06-06');
  assert.equal(kid.last_name, p.last_name);
  assert.equal(await page.locator('.modal').count(), 0);
  assert.deepEqual(s.errors, []);
});

test('claim: a corrected claim asks for the payer’s number on the page (3 actions), not in a browser box', async () => {
  const { page } = s;
  const carrier = (await s.get('/carriers')).find((c) => c.active) || await s.post('/carriers', { name: 'Inline Dental', payer_id: '12345' });
  const p = await newPatient('Fixie');
  const policy = await s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Fixie', subscriber_id: `IN${p.id}`, annual_max: 150000 });
  const prov = (await s.get('/providers?active=true'))[0];
  const proc = await s.post(`/patients/${p.id}/procedures`, { code: 'D0120', provider_id: prov.id, complete: true });
  const claim = await s.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  await s.post(`/claims/${claim.id}/submit`);
  await page.goto(`${app.base}/claims/${claim.id}`);
  await page.waitForSelector('h1');
  const r = await measure(page, async () => {
    await page.click('button:has-text("Corrected claim")');
    await page.waitForSelector('.inline-ask input');
    await page.keyboard.type('PAYER-12345');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.badge:has-text("Corrected claim")');
  });
  console.log(withinBudget('corrected claim', r, { actions: 3 }));
  assert.notEqual(page.url(), `${app.base}/claims/${claim.id}`, 'the new claim opens');
  assert.deepEqual(s.errors, []);
});

test('visit panel: the type changes in place (its length follows) with Undo; no edit dialog', async () => {
  const { page } = s;
  const p = await newPatient('Edith');
  const prov = (await s.get('/providers?active=true')).find((x) => x.type === 'dentist');
  const day = '2031-06-03';
  const a = await s.post('/appointments', { patient_id: p.id, provider_id: prov.id, start_time: `${day} 10:00`, end_time: `${day} 10:30`, override_blockout: true, notify: false });
  const types = await s.get('/appointment-types?active=true');
  const t = types.find((x) => /crown/i.test(x.name)) || types[0];
  await page.goto(`${app.base}/schedule?date=${day}&view=day`);
  await page.click(`.cal [data-appt-id="${a.id}"]`);
  await page.waitForSelector('.drawer select[aria-label="Visit type"]');
  await page.locator('.drawer select[aria-label="Visit type"]').selectOption(String(t.id));
  await page.waitForSelector('.toast-undo');
  const after1 = await s.get(`/appointments/${a.id}`);
  assert.equal(after1.appointment_type_id, t.id);
  assert.notEqual(after1.end_time, `${day} 10:30`, 'the type’s usual length followed');
  assert.equal(await page.locator('.modal').count(), 0);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(async (id) => (await (await fetch(`/api/appointments/${id}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).json()).end_time.endsWith('10:30'), a.id);
  // Booking opens beside the schedule (a side panel), not over it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await page.waitForSelector('.book-panel input[aria-label="Find a patient"]');
  assert.equal(await page.locator('.modal, .modal-backdrop').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.book-panel', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});

test('collections: Send to agency is at once with Undo (no "are you sure?"); writing off still asks, on the page', async () => {
  const { page } = s;
  await s.api('PUT', '/practice', { collection_agency: 'Summit Recovery' });
  await page.goto(`${app.base}/claims?tab=collections`);
  const open = page.locator('main button:has-text("Open")').first();
  if (!(await open.count())) { console.log('no past-due account in the demo office — skipped'); return; }
  await open.click();
  await page.waitForSelector('.side-panel h3:has-text("Agency")');
  await page.click('.side-panel button:has-text("Send to agency")');
  await page.waitForSelector('.toast:has-text("sent to Summit Recovery")');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Taken out of collections")');
  await page.click('.side-panel button:has-text("Write off bad debt")');
  await page.waitForSelector('.side-panel .inline-confirm:has-text("Write off the patient")');
  await page.click('.side-panel .inline-confirm button:has-text("Keep")');
  await page.waitForSelector('.side-panel .inline-confirm', { state: 'detached' });
  await s.api('PUT', '/practice', { collection_agency: '' });
  assert.deepEqual(s.errors, []);
});

test('documents: with no scanner online, S puts the focus on "A file on this computer"', async () => {
  const { page } = s;
  const p = await newPatient('Scanny');
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('[data-testid=documents-drop]');
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.activeElement?.dataset?.pick === 'file');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});
