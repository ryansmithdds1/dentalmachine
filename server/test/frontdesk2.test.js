import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runReminders } from '../src/messaging.js';
import { runRecallSequences } from '../src/recalls.js';
import { localNow } from '../src/util.js';
import { isAltWeek } from '../src/hours.js';

const h = harness();
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));
const HOUR = 3600_000;

async function setup() {
  const ctx = await h.practice({ office_hours: ALL_DAY });
  const practice = (await ctx.api.get('/practice')).data;
  return { ...ctx, tz: practice.timezone };
}
const at = (tz, ms) => localNow(tz, new Date(ms));
const book = async ({ api, patient, provider }, start, extra = {}) =>
  (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: start, end_time: start.slice(0, 11) + String(Number(start.slice(11, 13)) + 1).padStart(2, '0') + start.slice(13), override_blockout: true, ...extra })).data;

test('multi-step reminders: each step once, the latest due one only, confirmed patients only when asked', async () => {
  const ctx = await setup();
  const { api, tz } = ctx;
  const bad = await api.put('/practice', { reminder_steps: [{ hours: 48 }, { hours: 48 }] });
  assert.equal(bad.status, 400);
  const ok = await api.put('/practice', { reminder_steps: [{ hours: 336, channel: 'email' }, { hours: 48 }, { hours: 3, confirmed: true, channel: 'sms' }] });
  assert.equal(ok.status, 200);

  const base = Date.now();
  // Safely inside one hour so the end time stays the same day.
  const startMs = base + 10 * 24 * HOUR;
  const start = at(tz, startMs).slice(0, 11) + '10:00';
  const startAt = Date.parse(`${start.replace(' ', 'T')}Z`) - (Date.parse(`${at(tz, base).replace(' ', 'T')}Z`) - base);
  const appt = await book(ctx, start);
  const mine = () => h.sent.filter((m) => m.body?.includes('Dr. Ann Lee') || m.to === 'jane@example.com' || m.to?.endsWith('5550100'));
  const count0 = mine().length;

  await runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now: new Date(base) });
  let sent = await h.db.all('SELECT step, status FROM appointment_reminders WHERE appointment_id = ?', appt.id);
  assert.deepEqual(sent.map((s) => s.step), [336], 'the two-week email');
  assert.equal(mine().length, count0 + 1);
  assert.equal(mine().at(-1).channel, 'email');
  await runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now: new Date(base + HOUR) });
  assert.equal(mine().length, count0 + 1, 'not sent twice');

  // Two days out: the 48-hour step.
  await runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now: new Date(startAt - 40 * HOUR) });
  sent = await h.db.all('SELECT step FROM appointment_reminders WHERE appointment_id = ? ORDER BY step DESC', appt.id);
  assert.deepEqual(sent.map((s) => s.step), [336, 48]);

  // Once confirmed, only the same-day step (which is set to include confirmed patients) goes out.
  await api.patch(`/appointments/${appt.id}/status`, { status: 'confirmed', confirmed_via: 'phone' });
  await runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now: new Date(startAt - 2 * HOUR) });
  sent = await h.db.all('SELECT step FROM appointment_reminders WHERE appointment_id = ? ORDER BY step DESC', appt.id);
  assert.deepEqual(sent.map((s) => s.step), [336, 48, 3]);
  assert.equal(mine().at(-1).channel, 'sms');

  // A visit booked the day before only gets the 48-hour reminder, not the two-week one.
  const soonStart = at(tz, base + 26 * HOUR).slice(0, 11) + '11:00';
  const soon = await book(ctx, soonStart);
  await runReminders(h.db, h.messenger, { appUrl: h.config.appUrl, now: new Date(base) });
  const soonSteps = await h.db.all('SELECT step FROM appointment_reminders WHERE appointment_id = ?', soon.id);
  assert.deepEqual(soonSteps.map((s) => s.step), [48]);

  // Moving a visit clears its reminders so the new time gets them afresh.
  await api.put(`/appointments/${soon.id}`, { start_time: soonStart.replace('11:00', '12:00'), end_time: soonStart.replace('11:00', '13:00'), override_blockout: true });
  assert.equal((await h.db.all('SELECT * FROM appointment_reminders WHERE appointment_id = ?', soon.id)).length, 0);
});

test('recall types: defaults, custom types, and which codes reset them', async () => {
  const ctx = await setup();
  const { api, patient } = ctx;
  const types = (await api.get('/recall-types')).data;
  assert.deepEqual(types.filter((t) => t.active).map((t) => t.key).sort(), ['perio_maint', 'prophy']);
  const bwx = types.find((t) => t.key === 'bwx');
  await api.put(`/recall-types/${bwx.id}`, { active: true });
  const custom = await api.post('/recall-types', { name: 'Fluoride varnish', interval_months: 6, codes: 'd1206' });
  assert.equal(custom.status, 201);
  assert.deepEqual(custom.data.codes, ['D1206']);
  assert.equal((await api.post('/recall-types', { name: 'Fluoride varnish', interval_months: 6 })).status, 409);

  for (const code of ['D1110', 'D0274', 'D1206']) {
    await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: ctx.provider.id, complete: true });
  }
  const recalls = await h.db.all('SELECT type, interval_months FROM recalls WHERE patient_id = ? ORDER BY type', patient.id);
  assert.deepEqual(recalls.map((r) => [r.type, r.interval_months]), [['bwx', 12], ['fluoride_varnish', 6], ['prophy', 6]]);
  const listed = (await api.get('/recalls?before=2099-01-01')).data;
  assert.ok(listed.some((r) => r.type_name === 'Bitewings'));
});

test('automated recall sequence: latest step once per patient, not when something is booked', async () => {
  const ctx = await setup();
  const { api, patient, tz } = ctx;
  await api.put('/practice', { recall_auto: true, recall_steps: [{ days: -7 }, { days: 30 }] });
  const today = localNow(tz).slice(0, 10);
  const shift = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES ((SELECT practice_id FROM patients WHERE id = ?), ?, 'prophy', 6, ?)", patient.id, patient.id, shift(-45));
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES ((SELECT practice_id FROM patients WHERE id = ?), ?, 'bwx', 12, ?)", patient.id, patient.id, shift(-45));
  const before = h.sent.length;
  await runRecallSequences(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.equal(h.sent.length, before + 1, 'one message for the patient, not one per recall');
  const contacts = await h.db.all('SELECT rc.step FROM recall_contacts rc JOIN recalls r ON r.id = rc.recall_id WHERE r.patient_id = ?', patient.id);
  assert.deepEqual(contacts.map((c) => c.step), [30, 30], 'the latest step (not the 7-days-before one), recorded for both recalls');
  await runRecallSequences(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.equal(h.sent.length, before + 1, 'never twice');

  // Someone already booked isn't chased.
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Booked', phone: '(512) 555-0199' })).data;
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES ((SELECT practice_id FROM patients WHERE id = ?), ?, 'prophy', 6, ?)", other.id, other.id, shift(-1));
  await book({ ...ctx, patient: other }, `${shift(20)} 09:00`);
  const n = h.sent.length;
  await api.put('/practice', { recall_steps: [{ days: 0 }] });
  await runRecallSequences(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.ok(!h.sent.slice(n).some((m) => m.to?.includes('5550199')));
});

test('patient flow timestamps and confirmation method', async () => {
  const ctx = await setup();
  const { api, tz } = ctx;
  const start = `${at(tz, Date.now() + 3 * 24 * HOUR).slice(0, 10)} 09:00`;
  const a = await book(ctx, start);
  assert.equal((await api.patch(`/appointments/${a.id}/status`, { status: 'confirmed', confirmed_via: 'carrier-pigeon' })).status, 400);
  let r = (await api.patch(`/appointments/${a.id}/status`, { status: 'scheduled', confirmed_via: 'left_message' })).data;
  assert.deepEqual([r.status, r.confirmed_via], ['scheduled', 'left_message']);
  r = (await api.patch(`/appointments/${a.id}/status`, { status: 'confirmed', confirmed_via: 'text' })).data;
  assert.equal(r.confirmed_via, 'text');
  r = (await api.patch(`/appointments/${a.id}/status`, { status: 'checked_in' })).data;
  assert.ok(r.arrived_at);
  r = (await api.patch(`/appointments/${a.id}/status`, { status: 'in_chair' })).data;
  assert.ok(r.seated_at && r.arrived_at <= r.seated_at);
  r = (await api.patch(`/appointments/${a.id}/status`, { status: 'completed' })).data;
  assert.ok(r.dismissed_at);
});

test('checkout: completes the work, suggests what to collect, shows recalls and what is left', async () => {
  const ctx = await setup();
  const { api, patient, provider, tz } = ctx;
  const planned = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: provider.id })).data;
  const start = `${at(tz, Date.now()).slice(0, 10)} 08:00`;
  const a = await book(ctx, start, { procedure_ids: [] });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, appointment_id: a.id });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, appointment_id: a.id });
  let co = (await api.get(`/appointments/${a.id}/checkout`)).data;
  assert.equal(co.procedures.length, 2);
  assert.equal(co.suggested_payment, 0, 'nothing done yet');
  assert.ok(co.unscheduled.some((p) => p.id === planned.id));

  const done = await api.post(`/appointments/${a.id}/checkout`, { complete_procedures: true });
  assert.equal(done.status, 200);
  co = done.data;
  assert.equal(co.completed_procedures, 2);
  assert.equal(co.appointment.status, 'completed');
  assert.ok(co.appointment.checked_out_at);
  const fees = co.procedures.reduce((s, p) => s + p.fee, 0);
  assert.equal(co.balance, fees);
  assert.equal(co.suggested_payment, fees, 'self-pay: the whole visit');
  assert.ok(co.recalls.some((r) => r.type === 'prophy' && r.type_name === 'Prophy'));

  const pay = await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'credit_card' });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  co = (await api.get(`/appointments/${a.id}/checkout`)).data;
  assert.equal(co.paid_today, 5000);
  assert.equal(co.suggested_payment, fees - 5000);
});

test('family booking: back to back or side by side, all or nothing', async () => {
  const ctx = await setup();
  const { api, patient, provider, tz } = ctx;
  const kid = (await api.post('/patients', { first_name: 'Kid', last_name: 'Doe', guarantor_id: patient.id })).data;
  const hyg = (await api.post('/providers', { name: 'Sam Hyg, RDH', type: 'hygienist' })).data;
  const day = at(tz, Date.now() + 5 * 24 * HOUR).slice(0, 10);
  const res = await api.post('/appointments/family', {
    mode: 'back_to_back', start_time: `${day} 14:00`, provider_id: provider.id, override_blockout: true,
    members: [{ patient_id: patient.id, duration: 60 }, { patient_id: kid.id, duration: 30 }],
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.map((a) => [a.start_time, a.end_time]), [[`${day} 14:00`, `${day} 15:00`], [`${day} 15:00`, `${day} 15:30`]]);

  // Side by side with the same provider collides; nothing is booked.
  const count = async () => (await h.db.get('SELECT COUNT(*) AS n FROM appointments WHERE patient_id IN (?, ?)', patient.id, kid.id)).n;
  const n = await count();
  const clash = await api.post('/appointments/family', {
    mode: 'side_by_side', start_time: `${day} 09:00`, provider_id: provider.id, override_blockout: true,
    members: [{ patient_id: patient.id }, { patient_id: kid.id }],
  });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /^Kid:/);
  assert.equal(await count(), n);
  const side = await api.post('/appointments/family', {
    mode: 'side_by_side', start_time: `${day} 09:00`, override_blockout: true,
    members: [{ patient_id: patient.id, provider_id: provider.id }, { patient_id: kid.id, provider_id: hyg.id }],
  });
  assert.equal(side.status, 201);
  assert.equal(new Set(side.data.map((a) => a.start_time)).size, 1);
});

test('alternating weeks: a provider can work a different pattern every other week', async () => {
  assert.equal(isAltWeek({ anchor: '2026-01-05' }, '2026-01-07'), true);
  assert.equal(isAltWeek({ anchor: '2026-01-05' }, '2026-01-14'), false);
  assert.equal(isAltWeek({ anchor: '2026-01-05' }, '2026-01-21'), true);
  const ctx = await setup();
  const { api, patient } = ctx;
  const weekA = { 0: [], 1: [['08:00', '17:00']], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const weekB = { 0: [], 1: [], 2: [['08:00', '17:00']], 3: [], 4: [], 5: [], 6: [] };
  assert.equal((await api.post('/providers', { name: 'Dr. Alt', type: 'dentist', working_hours: { ...weekA, alt: { hours: weekB } } })).status, 400);
  const alt = (await api.post('/providers', { name: 'Dr. Alt', type: 'dentist', working_hours: { ...weekA, alt: { anchor: '2026-01-05', hours: weekB } } })).data;
  // 2026-01-05 is a Monday in the alternate week (Tuesdays); 2026-01-12 is a regular week (Mondays).
  const sched = (await api.get('/schedule?from=2026-01-05&to=2026-01-13')).data;
  assert.deepEqual(sched.provider_hours[alt.id]['2026-01-05'], []);
  assert.deepEqual(sched.provider_hours[alt.id]['2026-01-06'], [['08:00', '17:00']]);
  assert.deepEqual(sched.provider_hours[alt.id]['2026-01-12'], [['08:00', '17:00']]);
  assert.deepEqual(sched.provider_hours[alt.id]['2026-01-13'], []);
  const off = await api.post('/appointments', { patient_id: patient.id, provider_id: alt.id, start_time: '2026-01-05 09:00', end_time: '2026-01-05 10:00' });
  assert.equal(off.status, 409);
});
