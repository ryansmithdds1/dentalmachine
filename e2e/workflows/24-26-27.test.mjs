// Workflows 24 (create and send claims), 26 (fill openings from the ASAP list) and 27 (update demographics or
// contact info) — on the keyboard, within budget. Specs: docs/workflows/specs/24-claims.md, 26-asap-fill.md,
// 27-demographics.md.
/* global document, sessionStorage */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let provider; let carrier;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  [provider] = await s.get('/providers?active=true');
  carrier = await s.post('/carriers', { name: 'W3 Dental', payer_id: '99999' });
  assert.ok(carrier.id, JSON.stringify(carrier));
});
after(async () => { await browser?.close(); await app?.stop(); });

// A patient with a primary policy and finished, unbilled work.
async function insuredWithWork(first, codes = ['D1110', 'D0120', 'D0274']) {
  const p = await s.post('/patients', { first_name: first, last_name: 'Claimwell', dob: '1981-04-05', phone: '(512) 555-0161', email: `${first.toLowerCase()}@example.com` });
  const policy = await s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: `${first} Claimwell`, subscriber_id: `W3${p.id}`, group_number: 'G1' });
  assert.ok(policy.id, JSON.stringify(policy));
  const procs = [];
  for (const code of codes) procs.push(await s.post(`/patients/${p.id}/procedures`, { code, provider_id: provider.id, complete: true }));
  assert.ok(procs.every((x) => x.id), JSON.stringify(procs));
  return { p, policy, procs };
}
const claimsOf = (pid) => s.get(`/claims?patient_id=${pid}&limit=50`);

test('#24 from the Insurance tab: B makes the claim for all the finished work and sends it — 1 action, no dialogs', async () => {
  const { page } = s;
  const { p, procs } = await insuredWithWork('Cora');
  await page.goto(`${app.base}/patients/${p.id}?tab=insurance`);
  await page.waitForSelector('button:has-text("claim to W3 Dental")');
  const r = await measure(page, async () => {
    await page.keyboard.press('b');
    await page.waitForSelector('.toast:has-text("sent to W3 Dental")');
  });
  console.log(withinBudget('#24 bill from the Insurance tab', r, { actions: 1, ms: 5000 }));
  const claims = await claimsOf(p.id);
  assert.equal(claims.length, 1, 'one claim');
  assert.equal(claims[0].status, 'submitted');
  const detail = await s.get(`/claims/${claims[0].id}`);
  assert.deepEqual(detail.items.map((i) => i.procedure_id).sort(), procs.map((x) => x.id).sort(), 'every finished procedure, ticked by default');
  // Pressing it again has nothing left to bill: no second claim.
  await page.keyboard.press('b');
  await page.waitForTimeout(400);
  assert.equal((await claimsOf(p.id)).length, 1);
  assert.deepEqual(s.errors, [], 'no prompt or confirm boxes');
});

test('#24 from any screen for the active patient: Ctrl/⌘K, "bill", Enter — 3 actions', async () => {
  const { page } = s;
  const { p } = await insuredWithWork('Dell', ['D0150']);
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('h1:has-text("Dell Claimwell")');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name:has-text("Dell")');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('bill');
    await page.waitForSelector('.palette-item:has-text("Bill insurance for Dell Claimwell")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("sent to W3 Dental")');
  });
  console.log(withinBudget('#24 bill from the command bar', r, { actions: 3, ms: 6000 }));
  const [claim] = await claimsOf(p.id);
  assert.equal(claim.status, 'submitted');
  assert.deepEqual(s.errors, []);
});

test('#24 a claim that fails the checks stays a draft and says why; B then sends that draft (no second claim)', async () => {
  const { page } = s;
  const paper = await s.post('/carriers', { name: 'No Payer ID Dental' });
  const p = await s.post('/patients', { first_name: 'Eli', last_name: 'Draftson', dob: '1975-01-02' });
  await s.post(`/patients/${p.id}/insurance`, { carrier_id: paper.id, subscriber_name: 'Eli Draftson', subscriber_id: 'ND1' });
  await s.post(`/patients/${p.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  await page.goto(`${app.base}/patients/${p.id}?tab=insurance`);
  await page.waitForSelector('button:has-text("claim to No Payer ID Dental")');
  await page.keyboard.press('b');
  await page.waitForSelector('.toast:has-text("was made but not sent")');
  const [claim] = await claimsOf(p.id);
  assert.equal(claim.status, 'draft');
  await page.waitForSelector(`button:has-text("claim #${claim.id}")`);
  await page.keyboard.press('b');
  await page.waitForSelector('.toast:has-text("was made but not sent")');
  assert.equal((await claimsOf(p.id)).length, 1, 'the same draft, not a new claim');
  assert.deepEqual(s.errors, []);
});

test('#24 at checkout: B makes and sends the claim for today’s work — 1 action, even with the payment amount focused', async () => {
  const { page } = s;
  const p = await s.post('/patients', { first_name: 'Otto', last_name: 'Checkout', dob: '1966-06-06', phone: '(512) 555-0177' });
  await s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Otto Checkout', subscriber_id: `W3${p.id}`, group_number: 'G1' });
  // The demo practice is in Austin: "today" is its local date. Early, so it never collides.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const visit = await s.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${day} 05:30`, end_time: `${day} 06:00`, reason: 'Exam', override_blockout: true, notify: false });
  assert.ok(visit.id, JSON.stringify(visit));
  for (const code of ['D0120', 'D1110']) {
    const x = await s.post(`/patients/${p.id}/procedures`, { code, appointment_id: visit.id, provider_id: provider.id, complete: true });
    assert.ok(x.id, JSON.stringify(x));
  }
  await page.goto(`${app.base}/checkout/${visit.id}`);
  await page.waitForSelector('button:has-text("claim to W3 Dental")');
  // Nothing is owed here (insurance covers it), so checkout opens on booking the next visit; put the cursor in
  // the payment amount ourselves — B must still bill from there.
  await page.focus('[aria-label="Payment amount"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Payment amount');
  const r = await measure(page, async () => {
    await page.keyboard.press('b');
    await page.waitForSelector('.toast:has-text("sent to W3 Dental")');
  });
  console.log(withinBudget('#24 bill at checkout', r, { actions: 1, ms: 5000 }));
  const claims = await claimsOf(p.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, 'submitted');
  assert.equal((await s.get(`/claims/${claims[0].id}`)).items.length, 2, 'both of today’s procedures');
  await page.waitForSelector('button:has-text("claim to W3 Dental")', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});

// ---- 26: fill openings ----
const localNow = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
};
const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
// The fill list's order (OptimizerPanel's fillFirst): ASAP, waitlist, recall; then the earliest opening.
const RANK = { asap: 0, waitlist: 1, recall: 2 };
const fillFirst = (a, b) => (RANK[a.source] ?? 3) - (RANK[b.source] ?? 3) || String(a.start_time).localeCompare(String(b.start_time)) || (a.id || 0) - (b.id || 0);

test('#26 fill an opening from the ASAP list: L, B (book it now) — 2 actions; the visit moves up, Undo puts it back', async (t) => {
  const { page } = s;
  if ((await page.evaluate(async () => (await fetch('/api/optimizer/settings', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status)) !== 200) return t.skip('optimizer routes not mounted');
  // A morning somewhere, so the day still has open time; the office open every day, texts any time.
  const tz = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu']
    .find((z) => { const m = localNow(z)[1]; return m >= 420 && m < 780; }) || 'UTC';
  await s.api('PUT', '/practice', { timezone: tz, send_from: '00:00', send_until: '00:00', office_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['06:00', '22:00']]])) });
  const [today] = localNow(tz);
  const doc = await s.post('/providers', { name: 'Dr. Fay Filler', type: 'dentist' });
  await s.post('/operatories', { name: 'Fill chair' });
  // Booked next week, wants anything sooner.
  const pt = await s.post('/patients', { first_name: 'Asa', last_name: 'Soonest', dob: '1990-06-07', phone: '(512) 555-0188' });
  const later = await s.post('/appointments', { patient_id: pt.id, provider_id: doc.id, start_time: at(addDays(today, 7), 600), end_time: at(addDays(today, 7), 660), asap: 1, notify: false, add_type_procedures: false, override_blockout: true });
  assert.ok(later.id, JSON.stringify(later));

  await page.goto(`${app.base}/schedule?date=${today}`);
  await page.waitForSelector('.cal, .agenda');
  const plan = await s.get(`/optimizer/today?date=${today}`);
  const top = plan.opportunities.filter((o) => o.kind === 'fill' && o.fits).sort(fillFirst)[0];
  assert.ok(top, JSON.stringify(plan.opportunities.filter((o) => o.kind === 'fill').map((o) => `${o.title}: ${o.why_not || 'fits'}`)));
  assert.equal(top.source, 'asap', 'the ASAP list comes first');
  const was = await s.get(`/appointments/${top.appointment_id}`);

  const r = await measure(page, async () => {
    await page.keyboard.press('l');
    await page.waitForSelector('.opt-panel.opt-only .opt-card.active');
    await page.keyboard.press('b');
    await page.waitForSelector('.toast:has-text("Visit moved up")');
  });
  console.log(withinBudget('#26 fill an opening (L, B)', r, { actions: 2, ms: 6000 }));
  const moved = await s.get(`/appointments/${top.appointment_id}`);
  assert.equal(moved.start_time, top.start_time, 'moved into the opening');
  assert.equal(moved.provider_id, top.provider_id);
  assert.equal(moved.asap, 0, 'off the ASAP list');

  // Undo from the toast (Ctrl/⌘Z): back where it was, still on the ASAP list.
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  const back = await s.get(`/appointments/${top.appointment_id}`);
  assert.equal(back.start_time, was.start_time);
  assert.equal(back.asap, 1);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.opt-panel.opt-only', { state: 'detached' });
  assert.deepEqual(s.errors, []);
});

// ---- 27: contact info ----
test('#27 a new mobile number on the chart: E, type, Enter — 3 actions, saved at once with Undo', async () => {
  const { page } = s;
  const p = await s.post('/patients', { first_name: 'Nia', last_name: 'Newnumber', dob: '1988-08-08', phone: '(512) 555-0101' });
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('button[aria-label^="Change mobile"]');
  const r = await measure(page, async () => {
    await page.keyboard.press('e');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Mobile'));
    await page.keyboard.type('512.555.0142');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("Nia’s mobile is now (512) 555-0142")');
  });
  console.log(withinBudget('#27 change the mobile number', r, { actions: 3 }));
  assert.equal((await s.get(`/patients/${p.id}`)).phone, '(512) 555-0142', 'tidied into the usual format');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  assert.equal((await s.get(`/patients/${p.id}`)).phone, '(512) 555-0101');
  // A typo is caught before it's saved, and nothing changes.
  await page.keyboard.press('e');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Mobile'));
  await page.keyboard.type('555-01');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("isn’t a 10-digit phone number")');
  assert.equal((await s.get(`/patients/${p.id}`)).phone, '(512) 555-0101');
  assert.deepEqual(s.errors, []);
});

test('#27 a family moves: Ctrl/⌘K, "address …", Enter from any screen — 3 actions; the household moves too; Undo', async () => {
  const { page } = s;
  const mom = await s.post('/patients', { first_name: 'Hana', last_name: 'Householder', dob: '1984-02-02', phone: '(512) 555-0130', address: '1 Old Rd', city: 'Austin', state: 'TX', zip: '78701' });
  const kid = await s.post(`/patients/${mom.id}/family`, { first_name: 'Hugo', dob: '2014-03-03', relationship: 'child' });
  assert.equal(kid.address, '1 Old Rd');
  await page.goto(`${app.base}/patients/${mom.id}`);
  await page.waitForSelector('h1:has-text("Hana Householder")');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.patient-bar .pb-name:has-text("Hana")');
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('address 12 Oak St, Round Rock, TX 78664');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("New address for Hana and Hugo")');
  });
  console.log(withinBudget('#27 change the address (household)', r, { actions: 3 }));
  for (const id of [mom.id, kid.id]) {
    const x = await s.get(`/patients/${id}`);
    assert.deepEqual([x.address, x.city, x.state, x.zip], ['12 Oak St', 'Round Rock', 'TX', '78664']);
  }
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector('.toast:has-text("Undone")');
  for (const id of [mom.id, kid.id]) assert.equal((await s.get(`/patients/${id}`)).zip, '78701');
  assert.deepEqual(s.errors, []);
});

test('#27 by mouse on the chart: click the address, type, Enter — 3 actions, no window', async () => {
  const { page } = s;
  const p = await s.post('/patients', { first_name: 'Ivo', last_name: 'Inline', dob: '1970-07-07', address: '5 Elm St', city: 'Austin', state: 'TX', zip: '78702' });
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('button[aria-label^="Change address"]');
  const r = await measure(page, async () => {
    await page.click('button[aria-label^="Change address"]');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Address'));
    await page.keyboard.type('77 Lake Dr, Austin, TX 78703');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("New address for Ivo")');
  });
  console.log(withinBudget('#27 change the address on the chart', r, { actions: 3 }));
  assert.equal(await page.locator('.modal').count(), 0, 'no modal');
  assert.equal((await s.get(`/patients/${p.id}`)).zip, '78703');
  assert.deepEqual(s.errors, []);
});
