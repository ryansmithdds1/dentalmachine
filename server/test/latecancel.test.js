// Late cancellations (latecancel.js): every path that cancels a visit records when (appointments.cancelled_at, in the
// practice's own time), putting it back clears it, the practice's window decides what counts as late — for the
// no-show predictions and the optimizer — and older cancellations are filled from the change log (migration 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { practiceNow, newToken, localNow } from '../src/util.js';
import { isLateCancel, noticeHours, lateCancelHours, DEFAULT_LATE_CANCEL_HOURS } from '../src/latecancel.js';
import { noShowRisks, patientRecord, outcomeOf, addDays } from '../src/predict/noshow.js';
import { clearPredictCache } from '../src/predict/index.js';
import { MIGRATIONS } from '../src/migrations.js';

const h = harness();
const waitFor = async (fn) => {
  for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
};
const minutesApart = (a, b) => Math.abs(Date.parse(`${a.slice(0, 16).replace(' ', 'T')}:00Z`) - Date.parse(`${b.slice(0, 16).replace(' ', 'T')}:00Z`)) / 60000;

test('the rule: late = cancelled less than the window before the visit, never the office’s own; older rows use the old rule', () => {
  const v = (extra) => ({ status: 'cancelled', start_time: '2026-10-05 09:00', ...extra });
  assert.equal(noticeHours(v({ cancelled_at: '2026-10-04 15:00' })), 18);
  assert.equal(isLateCancel(v({ cancelled_at: '2026-10-04 15:00' })), true, '18 hours’ notice is late with the usual 24');
  assert.equal(isLateCancel(v({ cancelled_at: '2026-10-03 15:00' })), false, '42 hours is not');
  assert.equal(isLateCancel(v({ cancelled_at: '2026-10-03 15:00' }), 48), true, 'but it is with a 48-hour window');
  assert.equal(isLateCancel(v({ cancelled_at: '2026-10-05 09:30' })), true, 'cancelled after the start');
  assert.equal(isLateCancel(v({ cancelled_at: '2026-10-05 08:00', broken_reason: 'office' })), false, 'the office’s own cancellation never counts');
  assert.equal(isLateCancel(v({ broken_reason: 'sick' })), true, 'no time kept: the old rule (a reason that isn’t the office’s)');
  assert.equal(isLateCancel(v({})), false, 'no time and no reason: neither');
  assert.equal(isLateCancel({ status: 'no_show', start_time: '2026-10-05 09:00' }), false);
  assert.equal(outcomeOf(v({ cancelled_at: '2026-10-01 09:00', broken_reason: 'sick' })), null, 'an early cancellation counts neither way, even with a reason');
  assert.equal(outcomeOf(v({ cancelled_at: '2026-10-05 07:00' })), 'missed');
});

test('every way a visit is cancelled records when; putting it back clears it; cancelling again keeps the first time', async () => {
  const slug = `late-${Date.now()}`;
  const p = await h.practice({ timezone: 'UTC', slug });
  const { api, provider, patient, practiceId } = p;
  const day = addDays((await practiceNow(h.db, practiceId)).slice(0, 10), 9);
  let hour = 7;
  const book = async (extra = {}, patientId = patient.id, d = day) => {
    hour++;
    const r = await api.post('/appointments', { patient_id: patientId, provider_id: provider.id, start_time: `${d} ${String(hour).padStart(2, '0')}:00`, end_time: `${d} ${String(hour).padStart(2, '0')}:30`, override_blockout: true, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const row = (id) => h.db.get('SELECT status, cancelled_at FROM appointments WHERE id = ?', id);
  const expectNow = async (id, label) => {
    const a = await row(id);
    assert.equal(a.status, 'cancelled', label);
    assert.ok(a.cancelled_at, `${label}: cancelled_at set`);
    assert.ok(minutesApart(a.cancelled_at, await practiceNow(h.db, practiceId)) <= 2, `${label}: ${a.cancelled_at} is now, in the practice's time`);
  };

  // 1. The schedule's status buttons (and the assistant's, which call the same route).
  const a1 = await book();
  assert.equal((await api.patch(`/appointments/${a1.id}/status`, { status: 'cancelled', broken_reason: 'sick' })).status, 200);
  await expectNow(a1.id, 'status route');
  const first = (await row(a1.id)).cancelled_at;
  await h.db.run('UPDATE appointments SET cancelled_at = ? WHERE id = ?', `${day} 01:00`, a1.id);
  assert.equal((await api.patch(`/appointments/${a1.id}/status`, { status: 'cancelled', broken_reason: 'conflict' })).status, 200);
  assert.equal((await row(a1.id)).cancelled_at, `${day} 01:00`, 'a second cancel (a changed reason) keeps when it was cancelled');
  assert.ok(first);
  // Put back on the schedule: cleared (the change log keeps what it was).
  assert.equal((await api.patch(`/appointments/${a1.id}/status`, { status: 'scheduled' })).status, 200);
  assert.equal((await row(a1.id)).cancelled_at, null);
  const log = await h.db.all("SELECT changes FROM audit_log WHERE entity = 'appointments' AND entity_id = ? AND changes LIKE '%cancelled_at%'", a1.id);
  assert.ok(log.length >= 2, 'the change log has the times, set and cleared');

  // 2. The edit form.
  const a2 = await book();
  assert.equal((await api.put(`/appointments/${a2.id}`, { status: 'cancelled' })).status, 200);
  await expectNow(a2.id, 'edit form');
  assert.equal((await api.put(`/appointments/${a2.id}`, { status: 'scheduled', cancelled_at: '2020-01-01 00:00', override_blockout: true })).status, 200);
  assert.equal((await row(a2.id)).cancelled_at, null, 'cleared, and never taken from the client');

  // 3. A series: "this and following".
  const series = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${addDays(day, 1)} 08:00`, end_time: `${addDays(day, 1)} 08:30`, override_blockout: true, repeat: { every: 1, unit: 'week', count: 3 } }));
  const occ = await h.db.all('SELECT id FROM appointments WHERE practice_id = ? AND series_id IS NOT NULL ORDER BY start_time', practiceId);
  assert.equal(series.status, 201, JSON.stringify(series.data));
  assert.equal(occ.length, 3);
  assert.equal((await api.patch(`/appointments/${occ[0].id}/status`, { status: 'cancelled', broken_reason: 'cost', scope: 'following' })).status, 200);
  for (const o of occ) await expectNow(o.id, 'series, this and following');

  // 4. A provider's day out ("reschedule" cancels, reason: the office).
  const a4 = await book();
  const out = await api.post('/provider-out', { provider_id: provider.id, date: day, reason: 'provider_sick', client_key: `k-${Date.now()}`, send_texts: false, visits: [{ appointment_id: a4.id, action: 'reschedule' }] });
  assert.equal(out.status, 201, JSON.stringify(out.data));
  await expectNow(a4.id, 'provider out');
  assert.equal(isLateCancel({ ...(await h.db.get('SELECT * FROM appointments WHERE id = ?', a4.id)) }, 1000), false, 'the office’s cancellation is never the patient’s late cancel');

  // 5. The reminder link.
  const a5 = await book();
  const { token, hash } = newToken();
  await h.db.run('INSERT INTO confirm_links (practice_id, token_hash, appointment_id, recipient_id, channel, address) VALUES (?, ?, ?, ?, ?, ?)', practiceId, hash, a5.id, patient.id, 'sms', '(512) 555-0100');
  assert.equal((await h.client().post(`/public/confirm/${token}`, { action: 'cancel', appointment_id: a5.id })).status, 200);
  await expectNow(a5.id, 'reminder link');

  // 6. The API.
  const key = (await api.post('/api-keys', { name: 'Website', scopes: ['appointments:read', 'appointments:write'] })).data.key;
  const a6 = await book();
  const r6 = await fetch(`${h.origin}/api/v1/appointments/${a6.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
  assert.equal(r6.status, 200);
  await expectNow(a6.id, 'API');

  // 7. The AI receptionist, for a caller who proved who they are.
  const { receptionTool } = await import('../src/phones.js');
  const a7 = await book();
  const callId = (await h.db.run("INSERT INTO calls (practice_id, direction, from_number, to_number, patient_id, status, purpose) VALUES (?, 'inbound', '+15125550100', '+15125559999', ?, 'in-progress', 'receptionist')", practiceId, patient.id)).id;
  const practice = await h.db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const tool = async (name, input) => receptionTool(h.db, await h.db.get('SELECT * FROM calls WHERE id = ?', callId), practice, name, input);
  assert.equal((await tool('verify_caller', { first_name: 'Jane', dob: '1985-04-12' })).verified, true);
  assert.equal((await tool('change_visit', { appointment_id: a7.id, action: 'cancel' })).cancelled, true);
  await expectNow(a7.id, 'AI receptionist');

  // 8. The patient portal (online, more than a day ahead).
  const a8 = await book();
  const pub = h.client();
  const n = h.sent.length;
  await pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-12' });
  await waitFor(() => h.sent.length > n);
  const code = h.sent.at(-1).body.match(/\d{6}/)[0];
  const portal = h.client((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code })).data.token);
  assert.equal((await portal.post(`/portal/appointments/${a8.id}/cancel`, { reason: 'Travel' })).status, 200);
  await expectNow(a8.id, 'portal');
});

test('the window is a practice setting: admin only, 1–168 hours, audited before → after, and it changes what counts', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const { api, provider, practiceId } = p;
  assert.equal(await lateCancelHours(h.db, practiceId), DEFAULT_LATE_CANCEL_HOURS);
  assert.equal((await api.put('/practice', { late_cancel_hours: 0 })).status, 400);
  assert.equal((await api.put('/practice', { late_cancel_hours: 500 })).status, 400);
  assert.equal((await api.put('/practice', { late_cancel_hours: 'soon' })).status, 400);
  const email = `desk${Date.now()}@example.com`;
  await api.post('/users', { name: 'Desk', email, password: 'correct-horse-battery', role: 'front_desk' });
  const desk = h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await desk.put('/practice', { late_cancel_hours: 48 })).status, 403);

  // A patient who twice cancelled 30 hours ahead, for a reason of their own.
  const today = (await practiceNow(h.db, practiceId)).slice(0, 10);
  const pt = (await api.post('/patients', { first_name: 'Thirty', last_name: 'Hours', dob: '1980-01-01' })).data;
  const past = async (d, status, extra = {}) => h.db.run(
    'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, broken_reason, cancelled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    practiceId, pt.id, provider.id, `${d} 09:00`, `${d} 10:00`, status, extra.reason ?? null, extra.cancelled_at ?? null, `${addDays(d, -20)} 10:00:00`,
  );
  for (const d of [addDays(today, -40), addDays(today, -80)]) await past(d, 'cancelled', { reason: 'conflict', cancelled_at: `${addDays(d, -1)} 03:00` });
  await past(addDays(today, -120), 'completed');
  const next = (await h.db.run('INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    practiceId, pt.id, provider.id, `${addDays(today, 2)} 09:00`, `${addDays(today, 2)} 10:00`, 'scheduled', `${addDays(today, -10)} 10:00:00`)).id;
  const visit = await h.db.get('SELECT * FROM appointments WHERE id = ?', next);
  clearPredictCache();
  const at24 = (await noShowRisks(h.db, practiceId, [visit])).get(next);
  assert.ok(!at24.reasons.join(' ').includes('late cancellation'), JSON.stringify(at24.reasons));

  const res = await api.put('/practice', { late_cancel_hours: 48 });
  assert.equal(res.status, 200);
  assert.equal(res.data.late_cancel_hours, 48);
  const entry = await h.db.get("SELECT changes FROM audit_log WHERE practice_id = ? AND action = 'practice.update' ORDER BY id DESC LIMIT 1", practiceId);
  assert.deepEqual(JSON.parse(entry.changes).late_cancel_hours, [24, 48], 'before → after');
  const at48 = (await noShowRisks(h.db, practiceId, [visit])).get(next);
  assert.match(at48.reasons.join(' '), /2 late cancellations in the past year/);
  assert.ok(at48.probability > at24.probability, `${at48.probability} > ${at24.probability}`);
  // The record the model sees, directly.
  const hist = await h.db.all('SELECT * FROM appointments WHERE patient_id = ?', pt.id);
  assert.equal(patientRecord(hist, today, 24).late_cancels_1y, 0);
  assert.equal(patientRecord(hist, today, 48).late_cancels_1y, 2);
});

test('migration 3 fills cancelled_at from the change log (in practice time), only blanks, only the same practice, and runs again harmlessly', async () => {
  const a = await h.practice({ timezone: 'America/Chicago' });
  const b = await h.practice({ timezone: 'UTC' });
  const ins = (p, status) => h.db.run('INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?)', p.practiceId, p.patient.id, p.provider.id, '2026-02-10 09:00', '2026-02-10 10:00', status);
  const x = (await ins(a, 'cancelled')).id; // cancelled twice, put back once in between: the latest counts
  const y = (await ins(a, 'cancelled')).id; // nothing in the log
  const z = (await ins(a, 'cancelled')).id; // the log entry belongs to another practice
  const k = (await ins(a, 'scheduled')).id; // not cancelled now
  const kept = (await ins(a, 'cancelled')).id; // already has a time
  await h.db.run('UPDATE appointments SET cancelled_at = ? WHERE id = ?', '2026-02-01 08:00', kept);
  const logRow = (pid, id, when, changes) => h.db.run(
    "INSERT INTO audit_log (practice_id, action, entity, entity_id, changes, created_at, source) VALUES (?, 'appointment.change', 'appointments', ?, ?, ?, 'human')", pid, id, JSON.stringify(changes), when,
  );
  await logRow(a.practiceId, x, '2026-02-05 15:00:00', { status: ['scheduled', 'cancelled'] });
  await logRow(a.practiceId, x, '2026-02-06 15:00:00', { status: ['cancelled', 'scheduled'] });
  await logRow(a.practiceId, x, '2026-02-09 20:30:00', { status: ['scheduled', 'cancelled'], broken_reason: [null, 'sick'] });
  await logRow(b.practiceId, z, '2026-02-09 20:30:00', { status: ['scheduled', 'cancelled'] });
  await logRow(a.practiceId, k, '2026-02-09 20:30:00', { status: ['scheduled', 'cancelled'] });
  await logRow(a.practiceId, kept, '2026-02-09 20:30:00', { status: ['scheduled', 'cancelled'] });
  const step = MIGRATIONS.find((m) => m.id === 3);
  await step.up(h.db);
  const got = async (id) => (await h.db.get('SELECT cancelled_at FROM appointments WHERE id = ?', id)).cancelled_at;
  // 20:30 UTC on 9 February is 14:30 in Chicago (CST).
  assert.equal(await got(x), localNow('America/Chicago', new Date('2026-02-09T20:30:00Z')));
  assert.equal(await got(x), '2026-02-09 14:30');
  assert.equal(await got(y), null, 'nothing in the log: left empty (the old rule applies)');
  assert.equal(await got(z), null, 'another practice’s log entry is never used');
  assert.equal(await got(k), null, 'not cancelled now');
  assert.equal(await got(kept), '2026-02-01 08:00', 'only blanks are filled');
  await step.up(h.db);
  assert.equal(await got(x), '2026-02-09 14:30');
  assert.equal(isLateCancel({ ...(await h.db.get('SELECT * FROM appointments WHERE id = ?', x)) }), true, '18½ hours before the visit');
});
