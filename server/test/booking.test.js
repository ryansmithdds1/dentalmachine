// Workflows 9, 13 and 19: booking defaults and the next open time, confirming from the unconfirmed list
// (one or many, with undo), and the reason recorded when a visit is cancelled or missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const MON = '2031-01-06'; // a Monday, office open 08:00-17:00 by default
const TUE = '2031-01-07';

async function user(api, role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: role, role, password: `${role}-password-123` });
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
}
const book = async (api, body) => {
  const r = await api.post('/appointments', { override_blockout: true, notify: false, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};

test('suggest: the patient’s own dentist, or hygienist for a hygiene type; the type’s length; their usual chair', async () => {
  const { api, provider: dentist, patient } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Hana Rose, RDH', type: 'hygienist' })).data;
  const other = (await api.post('/providers', { name: 'Dr. Bo Kim', type: 'dentist' })).data;
  await api.put(`/patients/${patient.id}`, { primary_provider_id: other.id, primary_hygienist_id: hyg.id });
  const types = (await api.get('/appointment-types')).data;
  const prophy = types.find((t) => t.provider_type === 'hygienist');
  const crown = types.find((t) => t.name === 'Crown prep');
  const chairs = (await api.get('/operatories')).data;
  await api.put(`/operatories/${chairs[2].id}`, { default_provider_id: hyg.id });

  const hygiene = (await api.get(`/appointments/suggest?patient_id=${patient.id}&appointment_type_id=${prophy.id}&after=${MON}`)).data;
  assert.equal(hygiene.provider_id, hyg.id);
  assert.equal(hygiene.provider_source, 'patient');
  assert.match(hygiene.why.provider, /hygienist/);
  assert.equal(hygiene.duration, prophy.duration);
  assert.equal(hygiene.operatory_id, chairs[2].id);
  assert.match(hygiene.why.chair, /usual chair/);
  assert.equal(hygiene.start_time, `${MON} 08:00`, 'the first opening from the date asked for');

  const dentistVisit = (await api.get(`/appointments/suggest?patient_id=${patient.id}&appointment_type_id=${crown.id}&after=${MON}`)).data;
  assert.equal(dentistVisit.provider_id, other.id, 'their own dentist, not the first provider');
  assert.equal(dentistVisit.duration, 90);
  assert.notEqual(dentist.id, dentistVisit.provider_id);

  // A given provider, chair and length are kept.
  const given = (await api.get(`/appointments/suggest?patient_id=${patient.id}&provider_id=${dentist.id}&operatory_id=${chairs[0].id}&duration=40&after=${MON}`)).data;
  assert.deepEqual([given.provider_id, given.operatory_id, given.duration, given.provider_source], [dentist.id, chairs[0].id, 40, 'given']);
  // A fixed start time is not searched.
  const fixed = (await api.get(`/appointments/suggest?patient_id=${patient.id}&appointment_type_id=${crown.id}&start_time=${TUE}%2010:00`)).data;
  assert.deepEqual([fixed.start_time, fixed.end_time], [`${TUE} 10:00`, `${TUE} 11:30`]);
});

test('suggest: the next open time skips the provider’s visits, the chair’s visits, blocks and the patient’s own visits', async () => {
  const { api, provider, patient } = await h.practice();
  const chairs = (await api.get('/operatories')).data;
  await api.put(`/operatories/${chairs[0].id}`, { default_provider_id: provider.id });
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  const hyg = (await api.post('/providers', { name: 'Hy Gene', type: 'hygienist' })).data;
  // Provider busy 08:00-09:00; chair busy (someone else's visit) 09:00-10:00; a lunch block on the chair 10:00-10:30;
  // the patient already booked with the hygienist 10:30-11:00.
  await book(api, { patient_id: other.id, provider_id: provider.id, operatory_id: chairs[1].id, start_time: `${MON} 08:00`, end_time: `${MON} 09:00` });
  await book(api, { patient_id: other.id, provider_id: hyg.id, operatory_id: chairs[0].id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00` });
  await api.post('/blockouts', { operatory_id: chairs[0].id, start_time: `${MON} 10:00`, end_time: `${MON} 10:30`, reason: 'Chair repair' });
  await book(api, { patient_id: patient.id, provider_id: hyg.id, operatory_id: chairs[2].id, start_time: `${MON} 10:30`, end_time: `${MON} 11:00` });
  const s = (await api.get(`/appointments/suggest?patient_id=${patient.id}&provider_id=${provider.id}&duration=30&after=${MON}`)).data;
  assert.equal(s.operatory_id, chairs[0].id);
  assert.equal(s.start_time, `${MON} 11:00`);
  // Booking what was suggested works.
  const a = await api.post('/appointments', { patient_id: patient.id, provider_id: s.provider_id, operatory_id: s.operatory_id, start_time: s.start_time, end_time: s.end_time, notify: false });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  // Never in the past: a date before today searches from now.
  const past = (await api.get(`/appointments/suggest?patient_id=${patient.id}&duration=30&after=2020-01-01`)).data;
  assert.ok(past.start_time > '2025-01-01', past.start_time);
});

test('suggest: a due recall picks the visit type and starts on its due date', async () => {
  const { api, patient } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Hy Gene', type: 'hygienist' })).data;
  const types = (await api.get('/appointment-types')).data;
  const prophy = types.find((t) => t.provider_type === 'hygienist');
  const rtypes = (await api.get('/recall-types')).data;
  const rt = rtypes[0];
  await api.put(`/recall-types/${rt.id}`, { appointment_type_id: prophy.id });
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, due_date, status) VALUES (?, ?, ?, ?, 'due')", (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id, patient.id, rt.key, TUE);
  const s = (await api.get(`/appointments/suggest?patient_id=${patient.id}&pick_type=1`)).data;
  assert.equal(s.appointment_type_id, prophy.id);
  assert.equal(s.provider_id, hyg.id, 'a hygiene type goes to a hygienist');
  assert.equal(s.start_time.slice(0, 10), TUE);
  assert.match(s.why.type, /due/);
});

test('suggest: validates ids, needs schedule:read, and another practice gets 404', async () => {
  const { api, patient } = await h.practice();
  assert.equal((await api.get('/appointments/suggest')).status, 400);
  assert.equal((await api.get(`/appointments/suggest?patient_id=${patient.id}&duration=2`)).status, 400);
  assert.equal((await api.get(`/appointments/suggest?patient_id=${patient.id}&after=2031-02-30`)).status, 400);
  const other = await h.practice();
  assert.equal((await other.api.get(`/appointments/suggest?patient_id=${patient.id}`)).status, 404);
  assert.equal((await api.get(`/appointments/suggest?patient_id=${patient.id}&provider_id=${other.provider.id}`)).status, 404);
  // Read-only (every role can see the schedule); signed out is refused.
  const billing = await user(api, 'billing');
  assert.equal((await billing.get(`/appointments/suggest?patient_id=${patient.id}`)).status, 200);
  assert.equal((await h.client().get(`/appointments/suggest?patient_id=${patient.id}`)).status, 401);
});

test('cancel / no-show: the reason is validated, stored, audited with who and why, and cleared if put back', async () => {
  const { api, provider, patient } = await h.practice();
  const a = await book(api, { patient_id: patient.id, provider_id: provider.id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00` });
  assert.equal((await api.patch(`/appointments/${a.id}/status`, { status: 'cancelled', broken_reason: 'aliens' })).status, 400);
  assert.equal((await api.patch(`/appointments/${a.id}/status`, { status: 'cancelled', broken_reason: 'other' })).status, 400, '"other" needs a few words');
  assert.equal((await api.patch(`/appointments/${a.id}/status`, { status: 'confirmed', broken_reason: 'sick' })).status, 400, 'a reason only goes with a cancel or no-show');
  assert.equal((await h.db.get('SELECT status FROM appointments WHERE id = ?', a.id)).status, 'scheduled', 'nothing changed on a refused request');

  const c = await api.patch(`/appointments/${a.id}/status`, { status: 'cancelled', broken_reason: 'sick', broken_note: '  flu  ' });
  assert.equal(c.status, 200);
  assert.deepEqual([c.data.status, c.data.broken_reason, c.data.broken_note], ['cancelled', 'sick', 'flu']);
  const row = await h.db.get("SELECT * FROM audit_log WHERE action = 'appointment.status' AND entity_id = ? ORDER BY id DESC LIMIT 1", a.id);
  assert.deepEqual(JSON.parse(row.details), { from: 'scheduled', to: 'cancelled', broken_reason: 'sick', broken_note: 'flu' });
  assert.ok(row.user_id);
  assert.equal(row.reason, 'sick: flu');
  // The broken-appointment list shows why, with what's needed to rebook.
  const broken = (await api.get('/followups/broken?days=9999')).data;
  const mine = broken.find((x) => x.id === a.id);
  assert.equal(mine?.broken_reason, 'sick');
  assert.equal(mine.provider_id, provider.id);

  // Put back on the schedule: the reason goes (the change log keeps it).
  const back = await api.patch(`/appointments/${a.id}/status`, { status: 'scheduled' });
  assert.equal(back.status, 200);
  assert.equal(back.data.broken_reason, null);

  // A no-show with a reason.
  const n = await api.patch(`/appointments/${a.id}/status`, { status: 'no_show', broken_reason: 'no_contact' });
  assert.equal(n.data.broken_reason, 'no_contact');
  // Another practice can't touch it; someone without schedule:write can't either.
  const other = await h.practice();
  assert.equal((await other.api.patch(`/appointments/${a.id}/status`, { status: 'cancelled', broken_reason: 'sick' })).status, 404);
  const billing = await user(api, 'billing');
  assert.equal((await billing.patch(`/appointments/${a.id}/status`, { status: 'cancelled', broken_reason: 'sick' })).status, 403);
});

test('unconfirmed list: confirm one or many, idempotent, undo puts them back, audited; ?date narrows to a day', async () => {
  const { api, provider, patient } = await h.practice();
  const p2 = (await api.post('/patients', { first_name: 'Ann', last_name: 'Lo', dob: '1970-01-01', phone: '(512) 555-0111' })).data;
  const tomorrow = new Date(Date.now() + 86400_000 * 1.2).toISOString().slice(0, 10);
  const a1 = await book(api, { patient_id: patient.id, provider_id: provider.id, start_time: `${tomorrow} 22:00`, end_time: `${tomorrow} 22:30` });
  const a2 = await book(api, { patient_id: p2.id, provider_id: provider.id, start_time: `${tomorrow} 22:30`, end_time: `${tomorrow} 23:00` });
  await api.patch(`/appointments/${a2.id}/status`, { status: 'scheduled', confirmed_via: 'left_message' });
  const list = (await api.get(`/followups/unconfirmed?days=3`)).data;
  assert.ok(list.some((r) => r.id === a1.id) && list.some((r) => r.id === a2.id));
  assert.deepEqual((await api.get(`/followups/unconfirmed?date=${tomorrow}`)).data.map((r) => r.id).filter((id) => [a1.id, a2.id].includes(id)), [a1.id, a2.id]);
  assert.equal((await api.get('/followups/unconfirmed?date=2031-13-01')).status, 400);

  assert.equal((await api.post('/followups/unconfirmed/confirm', { ids: [] })).status, 400);
  assert.equal((await api.post('/followups/unconfirmed/confirm', { ids: [a1.id], confirmed_via: 'pigeon' })).status, 400);
  const r = await api.post('/followups/unconfirmed/confirm', { ids: [a1.id, a2.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { confirmed: [a1.id, a2.id], skipped: [] });
  const again = await api.post('/followups/unconfirmed/confirm', { ids: [a1.id] });
  assert.deepEqual(again.data.confirmed, [], 'a second click changes nothing');
  assert.equal(again.data.skipped[0].status, 'confirmed');
  const row = await h.db.get('SELECT status, confirmed_via, confirmed_at FROM appointments WHERE id = ?', a1.id);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.confirmed_via, 'phone');
  assert.ok(row.confirmed_at);
  const aud = await h.db.all("SELECT details, user_id FROM audit_log WHERE action = 'appointment.status' AND entity_id = ? ORDER BY id", a1.id);
  assert.deepEqual(JSON.parse(aud.at(-1).details), { from: 'scheduled', to: 'confirmed', confirmed_via: 'phone', bulk: 2 });
  assert.ok(aud.at(-1).user_id);
  assert.equal((await api.get('/followups/unconfirmed?days=3')).data.filter((x) => [a1.id, a2.id].includes(x.id)).length, 0);

  // Undo: back to unconfirmed, and "left a message" where it was.
  const undo = await api.post('/followups/unconfirmed/confirm', { ids: [a1.id, a2.id], undo: true, left_message_ids: [a2.id] });
  assert.deepEqual(undo.data.unconfirmed, [a1.id, a2.id]);
  const [u1, u2] = await Promise.all([a1.id, a2.id].map((id) => h.db.get('SELECT status, confirmed_via, confirmed_at FROM appointments WHERE id = ?', id)));
  assert.deepEqual([u1.status, u1.confirmed_via, u1.confirmed_at], ['scheduled', null, null]);
  assert.deepEqual([u2.status, u2.confirmed_via], ['scheduled', 'left_message']);
  assert.ok(JSON.parse((await h.db.get("SELECT details FROM audit_log WHERE action = 'appointment.status' AND entity_id = ? ORDER BY id DESC LIMIT 1", a1.id)).details).undo);

  // Other practice: 404 (nothing changes); no schedule:write: 403.
  const other = await h.practice();
  assert.equal((await other.api.post('/followups/unconfirmed/confirm', { ids: [a1.id] })).status, 404);
  assert.equal((await h.db.get('SELECT status FROM appointments WHERE id = ?', a1.id)).status, 'scheduled');
  const billing = await user(api, 'billing');
  assert.equal((await billing.post('/followups/unconfirmed/confirm', { ids: [a1.id] })).status, 403);
});
