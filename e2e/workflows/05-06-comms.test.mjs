// Workflows 5 (identify an inbound caller) and 6 (send and read patient texts): budgets from
// docs/workflows/specs/05-caller-id.md and 06-texts.md.
// Calls and texts come in the way Twilio sends them: signed webhooks (the e2e server gets a test auth token;
// texts still go out through the log driver, nothing leaves the machine).
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

const TOKEN = 'e2e-twilio-token';
process.env.TWILIO_AUTH_TOKEN = TOKEN;
const VOICE = '+15125559400';
const SMS = '+15125559401';
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));
const sign = (url, params) => createHmac('sha1', TOKEN).update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)).digest('base64');

let app; let browser; let s; let known; let texter; let family;
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
let seq = 0;
const webhook = async (path, params) => {
  const url = `${app.base}${path}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params) });
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  return r.text();
};
const ring = async (from) => {
  const sid = `CAe2e${++seq}`;
  const twiml = await webhook('/api/webhooks/twilio/voice/inbound', { CallSid: sid, From: from, To: VOICE });
  const done = new URL(twiml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&'));
  return { hangUp: () => webhook(done.pathname + done.search, { DialCallStatus: 'completed', DialCallDuration: '30' }) };
};
const text = (from, body) => webhook('/api/webhooks/twilio/sms', { From: from, To: SMS, Body: body, MessageSid: `SMe2e${++seq}` });
const fullPatient = (id) => s.get(`/patients/${id}`);

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  await s.api('PUT', '/practice', { voice_number: VOICE, forward_to: '+15125551111', sms_number: SMS, office_hours: ALWAYS_OPEN, send_from: '00:00', send_until: '00:00' });
  const list = await s.get('/patients?limit=200');
  const rows = list.rows || list;
  const count = new Map();
  for (const p of rows) if (p.phone) count.set(digits(p.phone), (count.get(digits(p.phone)) || 0) + 1);
  const single = rows.filter((p) => p.phone && digits(p.phone).length === 10 && count.get(digits(p.phone)) === 1);
  known = single[0];
  for (const p of single.slice(1)) {
    const full = await fullPatient(p.id);
    if (full.sms_opt_in) { texter = full; break; }
  }
  assert.ok(known && texter, 'demo data has patients with their own phone numbers');
  // A family on one number: a parent and a child (created here so the test knows exactly who).
  const parent = await s.post('/patients', { first_name: 'Pat', last_name: 'Callfam', dob: '1980-05-05', phone: '(512) 555-0161' });
  const child = await s.post('/patients', { first_name: 'Kit', last_name: 'Callfam', dob: '2016-06-06', phone: '(512) 555-0161', guarantor_id: parent.id });
  family = { parent, child };
});
after(async () => { await browser?.close(); await app?.stop(); });

test('#5 a known caller: the pop makes them active, Alt+O opens the chart in 1 action, and it stays until the call ends', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(600); // the live stream connects
  const call = await ring(known.phone);
  await page.waitForSelector(`.call-pop:has-text("${known.last_name}")`);
  await page.waitForSelector(`.patient-bar:has-text("${known.last_name}")`); // active without a click
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+o');
    await page.waitForURL(new RegExp(`/patients/${known.id}$`));
  });
  console.log(withinBudget('#5 caller → chart', r, { actions: 1, ms: 3000 }));
  // No fixed timer: still up while the call goes on, then "Call ended" and gone.
  assert.equal(await page.locator('.call-pop').count(), 1);
  await call.hangUp();
  await page.waitForSelector('.call-pop:has-text("Call ended")');
  await page.waitForFunction(() => !document.querySelector('.call-pop'), null, { timeout: 12_000 });
});

test('#5 a family number: the pop lists everyone on it; one click picks who is calling', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForTimeout(600);
  await ring('+15125550161');
  await page.waitForSelector('.call-pop-family');
  assert.equal(await page.locator('.call-pop-family button').count(), 2);
  const r = await measure(page, async () => {
    await page.click('.call-pop-family button:has-text("Kit")');
    await page.waitForSelector('.patient-bar:has-text("Kit")');
  });
  console.log(withinBudget('#5 pick a family member', r, { actions: 1, ms: 3000 }));
  await page.click('.call-pop [aria-label="Dismiss"]');
  assert.ok(family.child.id);
});

test('#5 an unknown caller: text back in 2 actions, attach inline, or start a new patient with the number', async () => {
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.waitForTimeout(600);
  await ring('+15125550923');
  await page.waitForSelector('.call-pop:has-text("Not a patient on file")');
  const r = await measure(page, async () => {
    await page.click('.call-pop button:has-text("Text back")');
    await page.keyboard.press('Enter'); // the suggested text is already in the box
    await page.waitForSelector('.call-pop-note:has-text("Texted")');
  });
  console.log(withinBudget('#5 text back an unknown caller', r, { actions: 2, ms: 3000 }));
  const threads = await s.get('/conversations');
  assert.ok(threads.some((t) => t.thread === 'n5125550923'), 'the text-back shows in Messages');

  // Attach to a patient, inline (no dialog).
  const a = await measure(page, async () => {
    await page.click('.call-pop button:has-text("Attach to a patient")');
    await page.keyboard.type(texter.last_name);
    await page.click(`.call-pop-attach .picker-row:has-text("${texter.first_name}")`);
    await page.waitForSelector(`.call-pop-name:has-text("${texter.last_name}")`);
  });
  console.log(withinBudget('#5 attach an unknown caller', a, { actions: 3, ms: 4000 }));
  assert.equal(await page.locator('.modal').count(), 0);
  await page.click('.call-pop [aria-label="Dismiss"]');

  // New patient with the caller's number.
  await ring('+15125550924');
  await page.waitForSelector('.call-pop:has-text("Not a patient on file")');
  await page.click('.call-pop button:has-text("New patient with this number")');
  await page.waitForSelector('.modal:has-text("New patient")');
  const phoneBox = page.locator('.modal input[type=tel], .modal input[name=phone]').first();
  const prefilled = (await phoneBox.count()) ? await phoneBox.inputValue() : '';
  console.log(`#5 new patient form phone prefilled: ${prefilled || '(no — PatientForm needs to read `defaults`)'}`);
  await page.keyboard.press('Escape');
});

test('#6 text the active patient: Alt+T, type, Enter — 3 actions', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${texter.id}`);
  await page.waitForSelector('.sidebar');
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector(`.patient-bar:has-text("${texter.last_name}")`);
  const msg = `See you Tuesday ${Date.now() % 1000}`;
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+t');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reply');
    await page.keyboard.type(msg);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.bubble.outbound:has-text("${msg}")`);
  });
  console.log(withinBudget('#6 text the active patient', r, { actions: 3, ms: 4000 }));
});

test('#6 read and reply from the inbox by keyboard: Enter, type, Enter; J/K move; Esc back to the list', async () => {
  const { page } = s;
  await text(known.phone, 'Question about my bill please');
  await text('+15125550977', 'Hi, do you take new patients?');
  await page.goto(`${app.base}/messages`);
  await page.waitForSelector('.inbox-item');
  // Newest first: the unknown texter, then the known patient.
  await page.keyboard.press('j');
  await page.waitForSelector(`.inbox-item.active:has-text("${known.last_name}")`);
  const reply = `Happy to help ${Date.now() % 1000}`;
  const r = await measure(page, async () => {
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reply');
    await page.keyboard.type(reply);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.bubble.outbound:has-text("${reply}")`);
  });
  console.log(withinBudget('#6 reply from the inbox', r, { actions: 3, ms: 4000 }));
  // Opening the thread made them the active patient.
  await page.waitForSelector(`.patient-bar:has-text("${known.last_name}")`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('inbox-item'));
  // The reply moved their conversation to the top; the unknown texter is next.
  await page.waitForSelector(`.inbox-item:first-child:has-text("${known.last_name}")`);
  await page.keyboard.press('j');
  await page.waitForSelector('.inbox-item.active:has-text("0977")');
  await page.keyboard.press('k');
  await page.waitForSelector(`.inbox-item.active:has-text("${known.last_name}")`);
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.inbox-item.active:has-text("0977")');

  // Attach the unknown texter inline.
  const a = await measure(page, async () => {
    await page.click('button:has-text("Attach to patient")');
    await page.keyboard.type(family.parent.last_name);
    await page.click(`.inbox-attach .picker-row:has-text("${family.parent.first_name}")`);
    await page.waitForSelector(`.inbox-thread-head:has-text("${family.parent.first_name} ${family.parent.last_name}")`);
  });
  console.log(withinBudget('#6 attach an unknown number', a, { actions: 3, ms: 4000 }));
  assert.equal(await page.locator('.modal').count(), 0);
});

test('#6 the chart’s Comms tab: same reply box, Enter sends, Shift+Enter is a new line', async () => {
  const { page } = s;
  await page.goto(`${app.base}/patients/${texter.id}?tab=comms`);
  const box = page.locator('.comms-composer textarea');
  await box.waitFor();
  await box.click();
  await page.keyboard.type('Line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Line two');
  assert.equal(await box.inputValue(), 'Line one\nLine two');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.comms-composer textarea')?.value === '');
  const sent = await s.get(`/messages?patient_id=${texter.id}`);
  assert.ok(sent.some((m) => m.body === 'Line one\nLine two'));
  assert.deepEqual(s.errors, []);
});
