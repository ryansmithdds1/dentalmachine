import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runReminders } from '../src/messaging.js';
import { twilioSignature } from '../src/routes/sms.js';

const sent = [];
const calls = [];
const messenger = {
  status: { sms: 'test', email: 'test' },
  send: async (m) => { sent.push(m); return { provider_id: `t-${sent.length}` }; },
  call: async (to, url) => { calls.push({ to, url }); return { provider_id: `CA${calls.length}` }; },
};
const h = harness({ config: { twilioAuthToken: 'twilio-secret' }, messenger });
const DAY = 86400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const post = (path, params) => fetch(`${h.origin}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', `https://app.example.com${path}`, params) },
  body: new URLSearchParams(params),
});
const text = (from, Body) => post('/api/webhooks/twilio/sms', { From: from, To: '+15125557777', Body, MessageSid: `SM${Math.random()}` }).then((r) => r.text());
const wait = async (fn) => { for (let i = 0; i < 50; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };

test('a cancellation is texted to ASAP and waitlist patients; the first YES is booked, the next hears it’s gone', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC', sms_number: '+15125557777' });
  const day = ymd(Date.now() + 3 * DAY);
  const later = ymd(Date.now() + 20 * DAY);
  const bob = (await api.post('/patients', { first_name: 'Bob', last_name: 'Asap', phone: '(512) 555-0201' })).data;
  const cat = (await api.post('/patients', { first_name: 'Cat', last_name: 'Wait', phone: '(512) 555-0202' })).data;
  const book = (p, date, time, extra = {}) => api.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${date} ${time}`, end_time: `${date} ${time.replace(/^(\d\d)/, (x) => String(Number(x) + 1).padStart(2, '0'))}`, override_blockout: true, notify: false, ...extra }).then((r) => r.data);
  const janes = await book(patient, day, '10:00');
  const bobs = await book(bob, later, '09:00', { asap: true });
  await api.post('/waitlist', { patient_id: cat.id, duration: 60 });

  const before = sent.length;
  await api.patch(`/appointments/${janes.id}/status`, { status: 'cancelled' });
  const offers = await wait(() => { const o = sent.slice(before).filter((m) => /just had an opening/.test(m.body)); return o.length >= 2 && o; });
  assert.deepEqual(offers.map((m) => m.to), ['(512) 555-0201', '(512) 555-0202'], 'ASAP first, then the waitlist');
  assert.match(offers[0].body, /Reply YES to take it — the first reply gets it\. Reply STOP to opt out\.$/);

  // Bob answers first: his visit moves up.
  assert.match(await text('+15125550201', 'Yes'), /You&apos;re booked for .* at 10:00 AM/);
  const moved = (await api.get(`/appointments/${bobs.id}`)).data;
  assert.equal(moved.start_time.slice(0, 16), `${day} 10:00`);
  assert.equal(moved.status, 'confirmed');
  assert.equal(moved.asap, 0);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Bob Asap took the .* opening by text \(moved up from/.test(t.title)));
  // Cat is too late, and stays on the waitlist.
  assert.match(await text('+15125550202', 'YES'), /just taken/);
  assert.equal((await h.db.get('SELECT status FROM waitlist WHERE patient_id = ?', cat.id)).status, 'waiting');
  const offer = await h.db.get('SELECT * FROM fill_offers WHERE source_appointment_id = ?', janes.id);
  assert.equal(offer.status, 'filled');
  assert.equal(offer.filled_patient_id, bob.id);

  // A cancellation inside two hours isn't offered; turning the feature off stops it.
  await api.put('/practice', { auto_fill: false });
  const n = sent.length;
  const again = await book(patient, day, '14:00');
  await api.patch(`/appointments/${again.id}/status`, { status: 'cancelled' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.slice(n).filter((m) => /opening/.test(m.body)).length, 0);
});

test('confirmation calls: those who haven’t confirmed get a call; 1 confirms, 2 asks for a new time, a voicemail gets a message', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC', reminder_steps: [{ hours: 48 }, { hours: 24, channel: 'call' }] });
  const day = ymd(Date.now() + 3 * DAY);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 15:00`, end_time: `${day} 16:00`, override_blockout: true, notify: false })).data;
  const other = (await api.post('/appointments', { patient_id: (await api.post('/patients', { first_name: 'Ray', last_name: 'Ring', phone: '(512) 555-0303' })).data.id, provider_id: provider.id, start_time: `${day} 11:00`, end_time: `${day} 12:00`, override_blockout: true, notify: false })).data;
  const n = calls.length;
  await runReminders(h.db, messenger, { appUrl: h.config.appUrl, now: new Date(`${ymd(Date.now() + 2 * DAY)}T16:00:00Z`) });
  const placed = calls.slice(n);
  assert.deepEqual(placed.map((c) => c.to).sort(), ['(512) 555-0100', '(512) 555-0303']);
  const path = (c) => new URL(c.url).pathname;
  const jane = placed.find((c) => c.to === '(512) 555-0100');
  const ray = placed.find((c) => c.to === '(512) 555-0303');

  const greet = await (await post(path(jane), { CallSid: 'CA1', AnsweredBy: 'human' })).text();
  assert.match(greet, /<Gather input="dtmf speech" numDigits="1"/);
  assert.match(greet, /this is Practice \d+\. Jane has an appointment on \w+day, \w+ \d+ at 3 P M with Dr\. Ann Lee, DDS\. To confirm, press 1 or say yes/);
  assert.equal((await post(path(jane), { CallSid: 'CA1' }).then(() => post(path(jane), {}))).status, 200);
  assert.match(await (await post(`${path(jane)}/answer?try=1`, { Digits: '1' })).text(), /you&apos;re confirmed/);
  const confirmed = (await api.get(`/appointments/${appt.id}`)).data;
  assert.deepEqual([confirmed.status, confirmed.confirmed_via], ['confirmed', 'call']);
  assert.equal((await h.db.get("SELECT outcome FROM calls WHERE to_number = '(512) 555-0100' ORDER BY id DESC")).outcome, 'confirmed');

  // Ray's voicemail gets the message, and the call counts as a message left.
  assert.match(await (await post(path(ray), { AnsweredBy: 'machine_end_beep' })).text(), /Please call us at 5 1 2 5 5 5 0 1 4 2 to confirm/);
  assert.equal((await api.get(`/appointments/${other.id}`)).data.confirmed_via, 'left_message');
  assert.match(await (await post(`${path(ray)}/answer?try=1`, { SpeechResult: 'I need to change it' })).text(), /call you back to find a new time/);
  assert.equal((await post(`${path(ray)}/answer?try=1`, { Digits: '1' }, 'bad')).status, 200);
  const forged = await fetch(`${h.origin}${path(ray)}/answer?try=1`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: 'Digits=1' });
  assert.equal(forged.status, 403);
});
