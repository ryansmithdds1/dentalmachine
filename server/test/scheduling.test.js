import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { shiftVisit } from '../src/routes/schedule.js';

const h = harness();
const MON = '2031-01-06'; // a Monday

test('monthly repeats keep the day of the month, clamped to short months', () => {
  const every = { every: 1, unit: 'month' };
  assert.equal(shiftVisit('2031-01-31 09:00', every, 1), '2031-02-28 09:00');
  assert.equal(shiftVisit('2031-01-31 09:00', every, 2), '2031-03-31 09:00');
  assert.equal(shiftVisit('2031-01-06 09:00', { every: 2, unit: 'week' }, 3), '2031-02-17 09:00');
});

test('recurring series: books free visits, reports conflicts, edits and cancels "this and following"', async () => {
  const { api, provider, patient } = await h.practice();
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Busy' })).data;
  // Week 3 is already taken by another patient.
  await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: '2031-01-20 09:00', end_time: '2031-01-20 10:00' });

  const first = await api.post('/appointments', {
    patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 09:00`, end_time: `${MON} 09:30`, reason: 'Ortho adjustment',
    repeat: { every: 1, unit: 'week', count: 6 },
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.series.created, 5);
  assert.equal(first.data.series.skipped.length, 1);
  assert.equal(first.data.series.skipped[0].start_time, '2031-01-20 09:00');
  assert.match(first.data.series.skipped[0].reason, /conflict/i);

  const visits = (await api.get(`/appointments?patient_id=${patient.id}&from=2031-01-01&to=2031-03-01`)).data;
  assert.deepEqual(visits.map((v) => v.start_time), ['2031-01-06 09:00', '2031-01-13 09:00', '2031-01-27 09:00', '2031-02-03 09:00', '2031-02-10 09:00']);
  const second = visits[1];
  const info = (await api.get(`/appointments/${second.id}`)).data.series;
  assert.deepEqual([info.position, info.total, info.remaining, info.unit], [2, 5, 3, 'week']);

  // Move visit 2 an hour later and a day later, for it and everything after.
  const moved = await api.put(`/appointments/${second.id}`, { start_time: '2031-01-14 10:00', end_time: '2031-01-14 10:30', scope: 'following' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.series_update.updated, 3);
  const after = (await api.get(`/appointments?patient_id=${patient.id}&from=2031-01-01&to=2031-03-01`)).data;
  assert.deepEqual(after.map((v) => v.start_time), ['2031-01-06 09:00', '2031-01-14 10:00', '2031-01-28 10:00', '2031-02-04 10:00', '2031-02-11 10:00']);

  // Cancel from visit 4 onward.
  const fourth = after[3];
  assert.equal((await api.patch(`/appointments/${fourth.id}/status`, { status: 'cancelled', scope: 'following' })).status, 200);
  const left = (await api.get(`/appointments?patient_id=${patient.id}&from=2031-01-01&to=2031-03-01`)).data;
  assert.equal(left.length, 3);

  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 13:00`, end_time: `${MON} 13:30`, repeat: { unit: 'day', count: 3 } })).status, 400);
});

test('provider working hours limit open slots, online booking and staff booking', async () => {
  const { api, patient } = await h.practice({ slug: `hours-${Date.now()}`, online_booking: true });
  // Hygienist works Tuesdays and Thursdays only, 7-3.
  const hours = { 0: [], 1: [], 2: [['07:00', '15:00']], 3: [], 4: [['07:00', '15:00']], 5: [], 6: [] };
  const hyg = (await api.post('/providers', { name: 'Sam RDH', type: 'hygienist', working_hours: hours })).data;
  assert.deepEqual(JSON.parse(hyg.working_hours)[2], [['07:00', '15:00']]);

  const tue = '2031-01-07';
  const slots = (await api.get(`/availability?date=${tue}&provider_id=${hyg.id}&duration=60`)).data.slots;
  assert.equal(slots[0], `${tue} 07:00`);
  assert.equal(slots.at(-1), `${tue} 14:00`);
  assert.deepEqual((await api.get(`/availability?date=${MON}&provider_id=${hyg.id}&duration=60`)).data.slots, []);

  const off = await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00` });
  assert.equal(off.status, 409);
  assert.ok(off.data.details?.can_override ?? off.data.can_override);
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00`, override_blockout: true })).status, 201);

  const sched = (await api.get(`/schedule?from=${MON}&to=${tue}`)).data;
  assert.deepEqual(sched.provider_hours[hyg.id][MON], []);
  assert.deepEqual(sched.provider_hours[hyg.id][tue], [['07:00', '15:00']]);

  // Back to office hours.
  assert.equal((await api.put(`/providers/${hyg.id}`, { working_hours: null })).data.working_hours, null);
});

test('recalls follow the visit that covers them; cancelling from the edit form releases everything', async () => {
  const { api, provider, patient } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Sam RDH', type: 'hygienist' })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: hyg.id, complete: true }); // starts a prophy recall
  const recall = async () => (await h.db.get('SELECT * FROM recalls WHERE patient_id = ?', patient.id));
  assert.equal((await recall()).status, 'due');
  // An emergency visit with the dentist doesn't take the patient off recall.
  const emergency = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 08:00`, end_time: `${MON} 08:30`, reason: 'Toothache' })).data;
  assert.equal((await recall()).status, 'due');
  // A hygiene visit does, and cancelling it (from the edit form) puts the recall back and frees the procedures.
  const crown = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: provider.id })).data;
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00`, procedure_ids: [crown.id] })).data;
  assert.equal((await recall()).status, 'scheduled');
  assert.equal((await recall()).appointment_id, visit.id);
  const put = await api.put(`/appointments/${visit.id}`, { status: 'cancelled' });
  assert.equal(put.status, 200);
  assert.equal((await recall()).status, 'due');
  assert.equal((await h.db.get('SELECT appointment_id FROM procedures WHERE id = ?', crown.id)).appointment_id, null);
  assert.equal((await api.patch(`/appointments/${emergency.id}/status`, { status: 'no_show' })).status, 200);
});

test('office hours apply to every provider unless overridden; phone search ignores formatting', async () => {
  const { api, provider, patient } = await h.practice();
  const sunday = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-01-05 10:00', end_time: '2031-01-05 11:00' });
  assert.equal(sunday.status, 409);
  assert.match(sunday.data.error, /outside office hours/);
  assert.equal(sunday.data.details.can_override, true);
  const evening = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 18:00`, end_time: `${MON} 18:30` });
  assert.equal(evening.status, 409);
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 18:00`, end_time: `${MON} 18:30`, override_blockout: true })).status, 201);

  for (const q of ['5125550100', '512-555-0100', '555 0100', '(512) 555']) {
    const found = (await api.get(`/patients?q=${encodeURIComponent(q)}`)).data.rows;
    assert.ok(found.some((p) => p.id === patient.id), q);
  }
});

test('a completed extraction charts the tooth missing; undoing it takes that back', async () => {
  const { api, provider, patient } = await h.practice();
  const ext = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '19', provider_id: provider.id, complete: true })).data;
  let chart = (await api.get(`/patients/${patient.id}/chart`)).data;
  assert.ok(chart.conditions.some((c) => c.tooth === '19' && c.condition === 'missing'));
  await api.post(`/procedures/${ext.id}/uncomplete`, { reason: 'Wrong tooth' });
  chart = (await api.get(`/patients/${patient.id}/chart`)).data;
  assert.ok(!chart.conditions.some((c) => c.tooth === '19' && c.condition === 'missing'));
});

test('completing a visit completes its procedures; time off blocks booking; visit history', async () => {
  const { api, provider, patient } = await h.practice();
  const crown = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: provider.id })).data;
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00`, procedure_ids: [crown.id] })).data;
  const done = await api.patch(`/appointments/${visit.id}/status`, { status: 'completed', complete_procedures: true });
  assert.equal(done.status, 200);
  assert.equal(done.data.completed_procedures, 1);
  assert.equal((await h.db.get('SELECT status FROM procedures WHERE id = ?', crown.id)).status, 'completed');
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).data.balance, 135000);

  // Vacation: booking warns (with override), open times disappear, the calendar knows.
  const TUE = '2031-01-07';
  const off = await api.post(`/providers/${provider.id}/exceptions`, { from: TUE, to: '2031-01-08', off: true, reason: 'Vacation' });
  assert.equal(off.status, 201);
  assert.equal(off.data.days, 2);
  const booked = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${TUE} 09:00`, end_time: `${TUE} 10:00` });
  assert.equal(booked.status, 409);
  assert.match(booked.data.error, /is off that day \(Vacation\)/);
  assert.deepEqual((await api.get(`/availability?date=${TUE}&provider_id=${provider.id}`)).data.slots ?? (await api.get(`/availability?date=${TUE}&provider_id=${provider.id}`)).data, []);
  const sched = (await api.get(`/schedule?from=${TUE}&to=${TUE}`)).data;
  assert.deepEqual(sched.provider_hours[provider.id][TUE], []);
  assert.equal(sched.provider_exceptions[0].reason, 'Vacation');
  // Special hours on a day: only those hours count.
  const THU = '2031-01-09';
  await api.post(`/providers/${provider.id}/exceptions`, { from: THU, off: false, hours: [['13:00', '17:00']], reason: 'Morning meeting' });
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${THU} 09:00`, end_time: `${THU} 10:00` })).status, 409);
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${THU} 14:00`, end_time: `${THU} 15:00` })).status, 201);
  const list = (await api.get(`/providers/${provider.id}/exceptions?from=2031-01-01`)).data;
  assert.equal(list.length, 3);
  await api.del(`/provider-exceptions/${list[0].id}`);
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${TUE} 09:00`, end_time: `${TUE} 10:00` })).status, 201);

  // Audit log search: by patient and action, and as CSV.
  const log = (await api.get(`/audit-log?patient_id=${patient.id}&action=appointment.`)).data;
  assert.ok(log.length >= 2 && log.every((e) => e.action.startsWith('appointment.')));
  const csv = await fetch(`${h.origin}/api/audit-log?format=csv&action=provider.`, { headers: { Authorization: `Bearer ${(await api.post('/auth/logout-all')).data.token}` } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /provider\.exception/);
});

test('block scheduling: reserved time only takes its appointment types; production goals', async () => {
  const { api, provider, patient } = await h.practice();
  const crown = (await api.post('/appointment-types', { name: 'Crown prep', duration: 90 })).data;
  const hyg = (await api.post('/appointment-types', { name: 'Cleaning', duration: 60 })).data;
  const day = '2031-03-03'; // Monday
  assert.equal((await api.post('/blockouts', { provider_id: provider.id, start_time: `${day} 08:00`, end_time: `${day} 11:00`, reason: 'Crown block', kind: 'reserved' })).status, 400, 'needs types');
  assert.equal((await api.post('/blockouts', { provider_id: provider.id, start_time: `${day} 08:00`, end_time: `${day} 11:00`, kind: 'nope' })).status, 400);
  const blk = await api.post('/blockouts', { provider_id: provider.id, start_time: `${day} 08:00`, end_time: `${day} 11:00`, reason: 'Crown block', kind: 'reserved', appointment_type_ids: [crown.id] });
  assert.equal(blk.status, 201);

  const slotsFor = async (t) => (await api.get(`/availability?date=${day}&provider_id=${provider.id}&duration=60${t ? `&appointment_type_id=${t}` : ''}`)).data.slots;
  assert.ok(!(await slotsFor(null)).includes(`${day} 08:00`), 'plain search skips the block');
  assert.ok(!(await slotsFor(hyg.id)).includes(`${day} 08:00`));
  assert.ok((await slotsFor(crown.id)).includes(`${day} 08:00`), 'the reserved type can use it');

  const book = (t) => api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 08:00`, end_time: `${day} 09:30`, appointment_type_id: t });
  assert.equal((await book(hyg.id)).status, 409);
  const ok = await book(crown.id);
  assert.equal(ok.status, 201);

  // Daily goal vs scheduled production.
  await api.put(`/providers/${provider.id}`, { daily_goal: 300000 });
  assert.equal((await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: provider.id, appointment_id: ok.data.id, fee: 120000 })).status, 201);
  const prod = (await api.get(`/schedule/production?from=${day}&to=${day}`)).data;
  assert.equal(prod.goals[provider.id], 300000);
  assert.equal(prod.rows.find((r) => r.provider_id === provider.id && r.date === day).scheduled, 120000);
});
