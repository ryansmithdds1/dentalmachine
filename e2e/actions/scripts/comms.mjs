// Calls, texts and reviews. Calls and texts come in the way Twilio sends them: signed webhooks to the local server
// (run.mjs gives it a test auth token; texts go out through the log driver, nothing leaves the machine).
/* global document */
import { createHmac } from 'node:crypto';
import { newPatient, activate } from '../lib/fixtures.mjs';

const VOICE = '+15125559400';
const SMS = '+15125559401';
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));
let seq = 0;
let wired = null;

// The practice's phone and text numbers, open all day so nothing waits for office hours (once per run).
function wire(t) {
  wired ??= t.as('admin').put('/practice', { voice_number: VOICE, forward_to: '+15125551111', sms_number: SMS, office_hours: ALWAYS_OPEN, send_from: '00:00', send_until: '00:00' });
  return wired;
}
async function webhook(t, path, params) {
  const url = `${t.base}${path}`;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = createHmac('sha1', token).update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)).digest('base64');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params) });
  if (r.status !== 200) throw new Error(`${path}: ${r.status}`);
  return r.text();
}
const ring = (t, from) => webhook(t, '/api/webhooks/twilio/voice/inbound', { CallSid: `CArobot${Date.now()}${++seq}`, From: from, To: VOICE });
const textIn = (t, from, body) => webhook(t, '/api/webhooks/twilio/sms', { From: from, To: SMS, Body: body, MessageSid: `SMrobot${Date.now()}${++seq}` });
const e164 = (phone) => `+1${phone.replace(/\D/g, '').slice(-10)}`;
// A phone number nobody else in the demo practice has.
const freshPhone = () => `(512) 55${String(Math.floor(Math.random() * 10))}-${String(1000 + Math.floor(Math.random() * 8999))}`;

export default {
  A053: { // log an ordinary call on the chart
    role: 'frontdesk',
    async setup(t) {
      const p = await newPatient(t, 'Callie');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+G: "Log a call" opens beside the screen — we called, spoke with them, just now, with the patient — the cursor in the note', async () => {
        await t.key('Alt+g');
        await t.focusIs('Call note');
      });
      await t.step('Type what was said and press Enter: it’s on the chart’s call history (Messages & forms → Calls)', async () => {
        await t.type('Asked about Saturday hours; will call back');
        await t.key('Enter');
        await t.see('.logcall-panel', { state: 'detached' });
      });
      const calls = await t.api.get(`/patients/${p.id}/calls`);
      if (!calls.some((c) => c.purpose === 'logged' && /Saturday/.test(c.summary || ''))) throw new Error('the call was not logged');
      t.note('Right after the phone line logged a call with the patient, the same panel adds the note to that call instead of logging it twice.');
    },
  },

  A004: {
    role: 'frontdesk',
    async setup(t) {
      await wire(t);
      return { p: await newPatient(t, 'Callie', { phone: freshPhone() }) };
    },
    async run(t, { p }) {
      await t.open('/schedule', '.cal-col-head');
      await t.wait(700); // the live stream connects
      await ring(t, e164(p.phone));
      await t.step('The phone rings: a pop-up shows who is calling and makes them the active patient (no action)', async () => {
        await t.see(`.call-pop:has-text("${p.last_name}")`);
        await t.see(`.patient-bar:has-text("${p.last_name}")`);
      });
      await t.step('Press Alt+O: their chart opens', async () => {
        await t.key('Alt+o');
        await t.page.waitForURL(new RegExp(`/patients/${p.id}`));
        await t.see('h1');
      });
    },
  },

  A066: { // text back an unknown caller
    role: 'frontdesk',
    async setup(t) { await wire(t); },
    async run(t) {
      await t.open('/schedule', '.cal-col-head');
      await t.wait(700);
      await ring(t, `+1512555${String(1000 + Math.floor(Math.random() * 8999))}`);
      await t.step('An unknown number rings: "Not a patient on file" with Text back / Attach / New patient', async () => {
        await t.see('.call-pop:has-text("Not a patient on file")');
      });
      await t.step('Click "Text back": a friendly text is already in the box', async () => {
        await t.click('.call-pop button:has-text("Text back")');
        await t.wait(200);
      });
      await t.step('Press Enter: texted', async () => {
        await t.key('Enter');
        await t.see('.call-pop-note:has-text("Texted")');
      });
    },
  },

  A005: {
    role: 'frontdesk',
    async setup(t) {
      await wire(t);
      const p = await newPatient(t, 'Tex', { phone: freshPhone() });
      await textIn(t, e164(p.phone), 'Hi, can I move my cleaning to next week?');
      return { p };
    },
    async run(t, { p }) {
      await t.open('/messages', '.inbox-item');
      await t.step('Messages: the newest conversation is highlighted at the top', async () => {
        await t.see(`.inbox-item:has-text("${p.last_name}")`);
      });
      await t.step('Press Enter: the conversation opens with the cursor in the reply box', async () => {
        await t.key('Enter');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reply');
      });
      await t.step('Type the reply and press Enter: sent', async () => {
        await t.type('Of course! Tuesday at 10 or Thursday at 2?');
        await t.key('Enter');
        await t.see('.bubble.outbound:has-text("Tuesday at 10")');
      });
    },
  },

  A008: {
    role: 'frontdesk',
    async setup(t) {
      await wire(t);
      const p = await newPatient(t, 'Tia', { phone: freshPhone() });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+T: their conversation opens with the cursor in the reply box', async () => {
        await t.key('Alt+t');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reply');
      });
      await t.step('Type the text and press Enter: sent', async () => {
        await t.type('See you Tuesday at 10!');
        await t.key('Enter');
        await t.see('.bubble.outbound:has-text("See you Tuesday")');
      });
    },
  },

  A065: { // ask for a review
    role: 'frontdesk',
    async setup(t) {
      await wire(t);
      await t.as('admin').put('/practice', { review_url: 'https://g.page/r/robot-example/review' });
      const p = await newPatient(t, 'Reva', { phone: freshPhone() });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+R: the review request is texted', async () => {
        await t.key('Alt+r');
        await t.see('text=/Review request (texted|emailed) to/');
      });
    },
  },
};
