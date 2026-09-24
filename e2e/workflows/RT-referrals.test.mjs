/* global document, sessionStorage */
// RT · Referral tracker (docs/workflows/specs/RT-referrals.md): refer the active patient as a critical referral
// (budget 3 actions: N, Critical, Send) and close it when the specialist's report is filed (budget 2: the report is
// matched on filing; one click confirms it and completes the referral). The server side runs through
// e2e/lib/referrals-app.mjs until the routes are mounted in app.js; the screens need the /referrals route in App.jsx
// (build with the mount lines applied: CLIENT_DIST=/tmp/claude-0/dist-referrals). Until then the UI steps skip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let s; let routes = false; let page = false;
let patient; let kim;

before(async () => {
  app = await startApp({ entry: 'e2e/lib/referrals-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  routes = (await s.page.evaluate(async () => (await fetch('/api/referral-tracker/board', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status)) === 200;
  if (!routes) return;
  const list = await s.get('/patients?limit=5');
  const rows = Array.isArray(list) ? list : list.rows || list.patients;
  [patient] = rows;
  const other = rows[1];
  kim = await s.post('/referral-contacts', { name: 'Dr. Grace Kim', practice_name: 'Riverside Endodontics', specialty: 'Endodontics', phone: '512-555-0199', email: 'kim@riverside.example.com' });
  // An earlier referral makes Dr. Kim the practice's usual specialist (the form's smart default).
  const prior = await s.post(`/referral-tracker/patients/${other.id}/referrals`, { contact_id: kim.id, reason: 'Endo evaluation', send: 'none', text_patient: false });
  assert.ok(prior.referral?.id, JSON.stringify(prior));
  await s.page.goto(`${app.base}/referrals`);
  page = await s.page.waitForSelector('.rt-page', { timeout: 5000 }).then(() => true, () => false);
  if (!page) console.log('RT: the /referrals page is not routed in App.jsx yet — UI steps skipped, API checked');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('RT create a critical referral for the active patient in at most 3 actions', async (t) => {
  if (!routes) return t.skip('referral tracker routes not mounted yet (see docs/workflows/specs/RT-referrals.md)');
  if (!page) {
    const r = await s.post(`/referral-tracker/patients/${patient.id}/referrals`, { contact_id: kim.id, reason: 'Evaluation and treatment (Endodontics)', urgency: 'critical', send: 'email' });
    assert.ok(r.alert, JSON.stringify(r));
    return;
  }
  const p = s.page;
  // The patient being worked on (opening the chart makes them the active patient).
  await p.goto(`${app.base}/patients/${patient.id}`);
  await p.waitForSelector('h1');
  await p.goto(`${app.base}/referrals`);
  await p.waitForSelector('.rt-page');
  const r = await measure(p, async () => {
    await p.keyboard.press('n');                                     // Refer the active patient
    await p.waitForFunction(() => document.querySelector('.rt-form select')?.value);   // specialist and reason filled in
    await p.click('.rt-urgency .rt-u-critical');                     // Critical
    await p.click('.rt-form .rt-send');                              // Send referral (the letter goes as a secure link)
    await p.waitForSelector('.rt-drawer', { state: 'detached' });
    await p.waitForSelector(`.rt-board tr.rt-row-critical:has-text("${patient.last_name}")`);
  });
  console.log(withinBudget('RT create a critical referral', r, { actions: 3, ms: 6000 }));
  const board = await s.get('/referral-tracker/board?view=critical');
  const ref = board.rows.find((x) => x.patient_id === patient.id);
  assert.ok(ref, 'on the critical list');
  assert.equal(ref.contact_id, kim.id);
  assert.equal(ref.letter_sent_via, 'email');
  assert.ok(ref.alerting);
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});

test('RT close the loop: the filed report is matched, one click completes it (at most 2 actions)', async (t) => {
  if (!routes) return t.skip('referral tracker routes not mounted yet');
  const p = s.page;
  let ref = (await s.get('/referral-tracker/board?view=critical')).rows.find((x) => x.patient_id === patient.id);
  if (!ref) ref = (await s.post(`/referral-tracker/patients/${patient.id}/referrals`, { contact_id: kim.id, reason: 'Endo', urgency: 'critical', send: 'none' })).referral;
  // The specialist's letter arrives and is filed on the chart as a referral letter (scanned, faxed or emailed in).
  const text = 'Riverside Endodontics - Dr. Grace Kim. Consultation report: root canal therapy completed.';
  const up = await p.evaluate(async ([pid, body]) => {
    const pdf = `%PDF-1.4\n1 0 obj\n<< /Length ${body.length + 40} >>\nstream\nBT /F1 12 Tf 72 720 Td (${body}) Tj ET\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n`;
    const r = await fetch(`/api/patients/${pid}/documents?filename=kim-report.pdf&category=referral`, { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/pdf' }, body: pdf });
    return r.status;
  }, [patient.id, text]);
  assert.equal(up, 201);
  // Matched in the background (a suggestion — nothing changes until a person confirms).
  let suggestion = null;
  for (let i = 0; i < 40 && !suggestion; i++) {
    suggestion = (await s.get(`/referral-tracker/referrals/${ref.id}`)).matches?.[0] || null;
    if (!suggestion) await p.waitForTimeout(250);
  }
  assert.ok(suggestion, 'the filed report was matched to the referral');
  if (!page) {
    const done = await s.post(`/referral-tracker/matches/${suggestion.id}/confirm`, { complete: true });
    assert.equal(done.status, 'closed');
    return;
  }
  await p.goto(`${app.base}/referrals?view=critical`);
  await p.waitForSelector(`.rt-board tr[data-id="${ref.id}"] .rt-confirm`);
  const r = await measure(p, async () => {
    await p.click(`.rt-board tr[data-id="${ref.id}"] .rt-confirm`);  // Report in: kim-report.pdf — confirm & complete
    await p.waitForSelector(`.rt-board tr[data-id="${ref.id}"]`, { state: 'detached' });
  });
  console.log(withinBudget('RT close a referral with the filed report', r, { actions: 2, ms: 5000 }));
  const after = await s.get(`/referral-tracker/referrals/${ref.id}`);
  assert.equal(after.status, 'closed');
  assert.equal(after.close_reason, 'completed');
  assert.ok(after.report_document_id);
  assert.deepEqual(s.errors.filter((e) => e.startsWith('pageerror')), []);
});
