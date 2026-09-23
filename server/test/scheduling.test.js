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
