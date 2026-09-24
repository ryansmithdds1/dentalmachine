import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { harness } from './helpers.js';
import { runReminders } from '../src/messaging.js';
import { localNow } from '../src/util.js';
import { twilioSignature } from '../src/routes/sms.js';

// SendGrid signs its event webhook with an ECDSA key; the office pastes the public half into the settings.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const h = harness({ config: { twilioAuthToken: 'twilio-secret', sendgridWebhookKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } });

const DAY = 86400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = ymd(Date.now());
const at = (date, hm) => new Date(`${date}T${hm}:00Z`); // practices here run on UTC
const run = (now) => runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now });
// Every practice's reminders go out in each run: only this practice's messages count.
let only = null;
const newSince = (n) => h.sent.slice(n).filter((m) => !only || only.test(`${m.subject || ''} ${m.body}`));
const practiceOf = async (api) => {
  only = new RegExp(`${(await api.get('/practice')).data.name}\\b`);
};
const tokenOf = (m) => /\/c\/([\w-]+)/.exec(m.body)[1];
const twilio = (path, params) => fetch(`${h.origin}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', `https://app.example.com${path}`, params) },
  body: new URLSearchParams(params),
});
const tasks = async (api) => {
  const t = (await api.get('/tasks')).data;
  return t.tasks || t;
};

test('office bookings: a booked or moved visit hears about it once, within sending hours; the office can skip it', async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC', reminder_steps: [{ hours: 48 }] });
  await practiceOf(api);
  const day = ymd(Date.now() + 10 * DAY);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 10:00`, end_time: `${day} 11:00`, override_blockout: true })).data;

  await api.put('/practice', { send_from: '08:00', send_until: '20:00' });
  assert.equal((await api.put('/practice', { send_from: '8am' })).status, 400);
  let n = h.sent.length;
  await run(at(today, '03:00'));
  assert.equal(newSince(n).length, 0, 'nothing at 3am');
  await run(at(today, '15:00'));
  const [booked] = newSince(n);
  assert.equal(newSince(n).length, 1);
  assert.equal(booked.channel, 'sms');
  assert.match(booked.body, /^Hi Jane, you're booked at Practice \d+ on .* at 10:00 AM with Dr\. Ann Lee, DDS\. Details or changes: https:\/\/app\.example\.com\/c\/[\w-]+ Reply STOP to opt out\.$/);
  n = h.sent.length;
  await run(at(today, '15:10'));
  assert.equal(newSince(n).length, 0, 'once');

  // Moved: asks to confirm the new time. The earlier link still works.
  await api.put(`/appointments/${appt.id}`, { start_time: `${day} 11:00`, end_time: `${day} 12:00`, override_blockout: true });
  await run(at(today, '15:20'));
  const [moved] = newSince(n);
  assert.match(moved.body, /is now .* at 11:00 AM with Dr\. Ann Lee, DDS\. Please confirm the new time: .* Reply C to confirm or R to reschedule/);
  assert.equal((await h.client().get(`/public/confirm/${tokenOf(booked)}`)).data.start_time, `${day} 11:00`);
  assert.equal((await h.client().get(`/public/confirm/${tokenOf(moved)}`)).status, 200);

  // "Don't text them about this one."
  n = h.sent.length;
  await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 14:00`, end_time: `${day} 15:00`, override_blockout: true, notify: false });
  await run(at(today, '15:30'));
  assert.equal(newSince(n).length, 0);
});

test('families: one text for everyone that day to the parent; the link and a "C" cover them all; cancel and reschedule reach the front desk', async () => {
  const { api, provider, patient: jane } = await h.practice({ timezone: 'UTC', reminder_steps: [{ hours: 48 }], sms_number: '+15125558888' });
  await practiceOf(api);
  const emma = (await api.post('/patients', { first_name: 'Emma', last_name: 'Doe', dob: `${new Date().getUTCFullYear() - 8}-03-02`, guarantor_id: jane.id })).data;
  const day = ymd(Date.now() + 5 * DAY);
  const visits = (await api.post('/appointments/family', { mode: 'back_to_back', start_time: `${day} 09:00`, provider_id: provider.id, override_blockout: true, members: [{ patient_id: jane.id }, { patient_id: emma.id }] })).data;
  assert.equal(visits.length, 2);

  // A child's visit alone goes to the parent too.
  const n0 = h.sent.length;
  await run(at(ymd(Date.now() + 4 * DAY), '10:00'));
  const sent = newSince(n0);
  assert.equal(sent.length, 1, 'one message for both');
  assert.equal(sent[0].to, '(512) 555-0100');
  assert.match(sent[0].body, /^Hi Jane, this is Practice \d+ with a reminder: .*: Jane at 9:00 AM with Dr\. Ann Lee, DDS, Emma at 10:00 AM with Dr\. Ann Lee, DDS\. Please confirm: /);

  const pub = h.client();
  const token = tokenOf(sent[0]);
  const view = (await pub.get(`/public/confirm/${token}`)).data;
  assert.equal(view.first_name, 'Jane');
  assert.deepEqual(view.visits.map((v) => v.first_name), ['Jane', 'Emma']);
  assert.match(view.practice.maps_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Practice/);
  assert.deepEqual((await pub.post(`/public/confirm/${token}`, { action: 'confirm' })).data.visits.map((v) => v.status), ['confirmed', 'confirmed']);
  assert.equal((await api.get(`/appointments/${visits[1].id}`)).data.confirmed_via, 'text');

  // Cancelling or moving needs to say which visit.
  assert.equal((await pub.post(`/public/confirm/${token}`, { action: 'cancel' })).status, 400);
  const cancelled = (await pub.post(`/public/confirm/${token}`, { action: 'cancel', appointment_id: visits[1].id, note: 'Emma is sick' })).data;
  assert.deepEqual(cancelled.visits.map((v) => v.status), ['confirmed', 'cancelled']);
  assert.ok((await tasks(api)).some((t) => t.patient_id === emma.id && /cancelled .* from their reminder\. .*They wrote: "Emma is sick"/.test(t.title)));
  const moved = (await pub.post(`/public/confirm/${token}`, { action: 'reschedule', appointment_id: visits[0].id })).data;
  assert.equal(moved.reschedule_requested, visits[0].id);
  assert.ok((await tasks(api)).some((t) => t.patient_id === jane.id && /asked for a new time/.test(t.title)));
  assert.equal((await pub.post(`/public/confirm/${token}`, { action: 'nap' })).status, 400);

  // The calendar file has the visits still on.
  const ics = await fetch(`${h.origin}/api/public/confirm/${token}/calendar.ics`);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  const cal = await ics.text();
  assert.equal(cal.match(/BEGIN:VEVENT/g).length, 1);
  assert.match(cal, /DTSTART:\d{8}T090000Z/);
  assert.match(cal, /SUMMARY:Dental appointment — Practice \d+/);
  assert.doesNotMatch(cal, /Emma/);

  // By text: "C" from the parent's phone confirms the family's next day of visits.
  const day2 = ymd(Date.now() + 6 * DAY);
  const more = (await api.post('/appointments/family', { mode: 'back_to_back', start_time: `${day2} 13:00`, provider_id: provider.id, override_blockout: true, members: [{ patient_id: jane.id }, { patient_id: emma.id }] })).data;
  const base = { From: '+15125550100', To: '+15125558888', get MessageSid() { return `SM${Math.random()}`; } }; // each text its own id, as with Twilio
  const c = await (await twilio('/api/webhooks/twilio/sms', { ...base, Body: 'Yes' })).text();
  assert.match(c, /Thanks! Confirmed at Practice \d+: .*: Jane at 1:00 PM, Emma at 2:00 PM\./);
  for (const v of more) assert.equal((await api.get(`/appointments/${v.id}`)).data.status, 'confirmed');
  assert.match(await (await twilio('/api/webhooks/twilio/sms', { ...base, Body: 'c' })).text(), /already confirmed/);
  assert.match(await (await twilio('/api/webhooks/twilio/sms', { ...base, Body: 'HELP' })).text(), /appointment reminders\. For help call \(512\) 555-0142\. Reply STOP to opt out/);
  assert.match(await (await twilio('/api/webhooks/twilio/sms', { ...base, Body: 'R' })).text(), /will call you to find a new time/);
  assert.ok((await tasks(api)).some((t) => /texted "R" — wants a new time/.test(t.title)));
});

test('email reminders: HTML with a button and the calendar invite, one-click unsubscribe; landlines and bounces switch channels', async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC', reminder_steps: [{ hours: 48 }] });
  await practiceOf(api);
  await api.put(`/patients/${patient.id}`, { preferred_contact: 'email' });
  const day = ymd(Date.now() + 5 * DAY);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 09:00`, end_time: `${day} 10:00`, override_blockout: true, notify: false })).data;
  let n = h.sent.length;
  await run(at(ymd(Date.now() + 4 * DAY), '10:00'));
  const [mail] = newSince(n);
  assert.equal(mail.channel, 'email');
  assert.equal(mail.to, 'jane@example.com');
  assert.match(mail.subject, /^Your appointment at Practice \d+$/);
  assert.match(mail.html, /<a href="https:\/\/app\.example\.com\/c\/[\w-]+"[^>]*>Confirm<\/a>/);
  assert.match(mail.html, /Directions/);
  assert.equal(mail.attachments[0].filename, 'appointment.ics');
  assert.match(mail.attachments[0].content, /BEGIN:VCALENDAR[\s\S]*DTSTART:\d{8}T090000Z[\s\S]*END:VCALENDAR/);
  assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/app\.example\.com\/api\/public\/confirm\/[\w-]+\/stop-emails>$/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  // SendGrid reports it bounced: the address is marked, and the reminder goes again by text.
  const msgId = (await h.db.get("SELECT id FROM messages WHERE patient_id = ? AND channel = 'email' ORDER BY id DESC", patient.id)).id;
  const events = JSON.stringify([{ event: 'bounce', type: 'bounce', email: 'jane@example.com', reason: '550 No such user', dm_message_id: String(msgId) }]);
  const ts = String(Math.floor(Date.now() / 1000));
  const hook = (body, signature) => fetch(`${h.origin}/api/webhooks/sendgrid`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Twilio-Email-Event-Webhook-Timestamp': ts, 'X-Twilio-Email-Event-Webhook-Signature': signature ?? sign('sha256', Buffer.from(ts + body), privateKey).toString('base64') },
  });
  assert.equal((await hook(events, 'bm90IGEgc2lnbmF0dXJl')).status, 403);
  assert.equal((await hook(events)).status, 204);
  let jane = (await api.get(`/patients/${patient.id}`)).data;
  assert.ok(jane.email_bad_at);
  assert.equal(jane.email_bad_reason, '550 No such user');
  assert.equal((await h.db.get('SELECT delivery FROM messages WHERE id = ?', msgId)).delivery, 'bounced');
  n = h.sent.length;
  await run(at(ymd(Date.now() + 4 * DAY), '10:10'));
  const [text] = newSince(n);
  assert.equal(text.channel, 'sms');

  // The text doesn't arrive either (a landline): texts stop too, and a fixed email address gets it.
  const sid = (await h.db.get("SELECT provider_id FROM messages WHERE patient_id = ? AND channel = 'sms' ORDER BY id DESC", patient.id)).provider_id;
  assert.equal((await twilio('/api/webhooks/twilio/status', { MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30006' })).status, 204);
  jane = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(jane.sms_bad_reason, 'Landline or unreachable carrier');
  const list = (await api.get('/followups/unconfirmed?days=7')).data.find((x) => x.id === appt.id);
  assert.equal(list.reach, null);
  assert.deepEqual(list.problems, ['Texts: Landline or unreachable carrier', 'Email: 550 No such user']);
  assert.equal(list.messages[0].delivery, 'undelivered');
  await api.put(`/patients/${patient.id}`, { email: 'jane.doe@example.com' });
  n = h.sent.length;
  await run(at(ymd(Date.now() + 4 * DAY), '10:20'));
  assert.equal(newSince(n)[0].to, 'jane.doe@example.com');

  // "Stop appointment emails": the page only asks; the POST (or the mail app's one-click) does it.
  const stop = `${h.origin}/api/public/confirm/${tokenOf(mail)}/stop-emails`;
  assert.match(await (await fetch(stop)).text(), /<form method="post">/);
  assert.equal((await api.get(`/patients/${patient.id}`)).data.email_opt_in, 1);
  const done = await fetch(stop, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(done.status, 200);
  assert.equal((await api.get(`/patients/${patient.id}`)).data.email_opt_in, 0);
});

test('missed visits get a same-day text; the unconfirmed call list and confirmation numbers', async () => {
  // The missed visit has to be earlier the same day: just after midnight UTC, use a practice where it's already morning.
  const timezone = new Date().getUTCHours() < 2 ? 'Asia/Tokyo' : 'UTC';
  const day = localNow(timezone).slice(0, 10);
  const { api, provider, patient } = await h.practice({ timezone, reminder_steps: [{ hours: 48 }] });
  await practiceOf(api);
  const missed = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 00:05`, end_time: `${day} 00:35`, override_blockout: true, notify: false })).data;
  await api.patch(`/appointments/${missed.id}/status`, { status: 'no_show' });
  let n = h.sent.length;
  await run(new Date(Date.now() + 60_000));
  const [sorry] = newSince(n).filter((m) => /missed you/.test(m.body));
  assert.match(sorry.body, /^Hi Jane, we missed you at Practice \d+ today\. .*call \(512\) 555-0142.* Reply STOP to opt out\.$/);
  n = h.sent.length;
  await run(new Date(Date.now() + 120_000));
  assert.equal(newSince(n).filter((m) => /missed you/.test(m.body)).length, 0, 'once');

  const tomorrow = ymd(Date.now() + DAY);
  const soon = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${tomorrow} 23:00`, end_time: `${tomorrow} 23:30`, override_blockout: true, notify: false })).data;
  await api.patch(`/appointments/${soon.id}/status`, { status: 'scheduled', confirmed_via: 'left_message' });
  const row = (await api.get('/followups/unconfirmed')).data.find((x) => x.id === soon.id);
  assert.equal(row.name, 'Jane Doe');
  assert.equal(row.reach, 'sms');
  assert.equal(row.left_message, true);
  assert.equal(row.contact, null);

  const stats = (await api.get('/followups/confirmation-stats')).data;
  assert.equal(stats.visits, 1);
  assert.equal(stats.no_show_pct, 100);
  assert.equal(stats.no_show_pct_unconfirmed, 100);
  assert.equal(stats.no_show_pct_confirmed, null);
  assert.ok(stats.messages.sent >= 0);
});

test('a patient who opted out is not retried every run', async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC', reminder_steps: [{ hours: 48 }] });
  await practiceOf(api);
  const day = ymd(Date.now() + 5 * DAY);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 09:00`, end_time: `${day} 10:00`, override_blockout: true, notify: false })).data;
  await api.put(`/patients/${patient.id}`, { sms_opt_in: false, email_opt_in: false });
  await run(at(ymd(Date.now() + 4 * DAY), '10:00'));
  const r = await h.db.get('SELECT status, attempts FROM appointment_reminders WHERE appointment_id = ?', appt.id);
  assert.equal(r.status, 'unreachable');
  assert.equal((await api.get(`/appointments/${appt.id}`)).data.reminder_sent_at, null, 'not shown as reminded');
});
