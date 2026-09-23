import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { openSlots } from '../src/routes/schedule.js';

const h = harness();

test('referrals: contacts, in and out, letter, report', async () => {
  const { api, patient, provider } = await h.practice();
  const endo = (await api.post('/referral-contacts', { name: 'Dr. Root', practice_name: 'Canal Endodontics', specialty: 'Endodontics', phone: '555-0100', npi: '1234567893' })).data;
  const gp = (await api.post('/referral-contacts', { name: 'Dr. Friend', specialty: 'General dentist' })).data;
  assert.equal((await api.post('/referral-contacts', { name: 'X', npi: '12' })).status, 400);

  const inbound = await api.post(`/patients/${patient.id}/referrals`, { contact_id: gp.id, direction: 'in' });
  assert.equal(inbound.status, 201);
  assert.equal(inbound.data.status, 'closed');
  const p = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(p.referred_by_id, gp.id);

  const out = (await api.post(`/patients/${patient.id}/referrals`, { contact_id: endo.id, direction: 'out', reason: 'RCT #19', teeth: '19', urgency: 'soon', provider_id: provider.id })).data;
  assert.equal(out.status, 'open');
  assert.equal((await api.get('/referrals?open=true')).data.length, 1);
  const letter = (await api.get(`/referrals/${out.id}/letter`)).data;
  assert.equal(letter.contact.practice_name, 'Canal Endodontics');
  assert.equal(letter.patient.last_name, 'Doe');
  assert.equal(letter.provider.name, provider.name);
  await api.put(`/referrals/${out.id}`, { status: 'report_received' });
  assert.equal((await api.get('/referrals?open=true')).data.length, 0);
  assert.equal((await api.put(`/referrals/${out.id}`, { status: 'lost' })).status, 400);

  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const rep = (await api.get('/reports/referrals')).data;
  const src = rep.sources.find((s) => s.id === gp.id);
  assert.equal(src.patients, 1);
  assert.ok(src.production > 0);
  assert.equal(rep.outgoing[0].reports, 1);
  const contacts = (await api.get('/referral-contacts')).data;
  assert.equal(contacts.find((c) => c.id === endo.id).referred_out, 1);
});

test('patient contact details, primary hygienist and photo', async () => {
  const { api, patient } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Sam Hyg, RDH', type: 'hygienist' })).data;
  const photo = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;
  const res = await api.put(`/patients/${patient.id}`, { phone_home: '555-1111', phone_work: '555-2222', preferred_contact: 'call', language: 'Spanish', primary_hygienist_id: hyg.id, photo });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.preferred_contact, res.data.language, res.data.primary_hygienist_id, res.data.photo], ['call', 'Spanish', hyg.id, photo]);
  assert.equal((await api.put(`/patients/${patient.id}`, { preferred_contact: 'pigeon' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { photo: 'data:text/html;base64,PGgxPg==' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { primary_hygienist_id: 999999 })).status, 404);
});

test('online requests: a pending request holds its slot; accepting can change the time', async () => {
  const ctx = await h.practice({ online_booking: true, slug: `hold-${Date.now()}` });
  const { api, provider } = ctx;
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', provider.id)).practice_id;
  const day = '2030-03-05';
  const before = await openSlots(h.db, pid, provider.id, day, { duration: 60, step: 30 });
  assert.ok(before.includes(`${day} 10:00`));
  const id = (await h.db.run(
    "INSERT INTO booking_requests (practice_id, first_name, last_name, phone, reason, provider_id, requested_start, duration) VALUES (?, 'New', 'Person', '555-0123', 'Cleaning', ?, ?, 60)",
    pid, provider.id, `${day} 10:00`,
  )).id;
  const after = await openSlots(h.db, pid, provider.id, day, { duration: 60, step: 30 });
  assert.ok(!after.includes(`${day} 10:00`) && !after.includes(`${day} 09:30`), 'held while pending');
  const acc = await api.post(`/booking-requests/${id}/accept`, { provider_id: provider.id, start_time: `${day} 11:00`, duration: 30 });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.start_time, `${day} 11:00`);
  const appt = await h.db.get('SELECT end_time FROM appointments WHERE id = ?', acc.data.appointment_id);
  assert.equal(appt.end_time, `${day} 11:30`);
  assert.ok((await openSlots(h.db, pid, provider.id, day, { duration: 60, step: 30 })).includes(`${day} 10:00`), 'released once handled');
});

test('inbox: unknown numbers, reply, attach, assign, archive, quick replies', async () => {
  const { api, patient } = await h.practice();
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  const inbound = (from, body, patientId = null) => h.db.run(
    "INSERT INTO messages (practice_id, patient_id, channel, kind, direction, to_address, from_address, body, status) VALUES (?, ?, 'sms', 'reply', 'inbound', '+15125550142', ?, ?, 'sent')",
    pid, patientId, from, body,
  );
  await inbound('+15125550777', 'Hi, do you take Delta Dental?');
  let list = (await api.get('/conversations')).data;
  const unknown = list.find((t) => t.thread === 'n5125550777');
  assert.ok(unknown && unknown.unread === 1 && !unknown.patient_id);
  const msgs = (await api.get('/conversations/n5125550777/messages')).data;
  assert.equal(msgs.length, 1);

  const n = h.sent.length;
  const rep = await api.post('/conversations/n5125550777/reply', { body: 'Yes we do!' });
  assert.equal(rep.status, 201);
  assert.equal(h.sent.length, n + 1);
  assert.equal(h.sent.at(-1).to, '+15125550777');
  assert.equal((await api.get('/conversations/n5125550777/messages')).data.length, 2, 'the reply is in the thread');

  // A new patient with no mobile: attaching moves the texts and saves the number.
  const newbie = (await api.post('/patients', { first_name: 'New', last_name: 'Texter' })).data;
  const att = await api.post('/conversations/n5125550777/attach', { patient_id: newbie.id });
  assert.equal(att.data.moved, 2);
  assert.equal((await api.get(`/patients/${newbie.id}`)).data.phone, '+15125550777');
  list = (await api.get('/conversations')).data;
  assert.ok(list.some((t) => t.thread === `p${newbie.id}`) && !list.some((t) => t.thread === 'n5125550777'));

  // Assign and archive; a new text brings it back.
  await inbound('+15125550100', 'Running late', patient.id);
  const me = (await api.get('/auth/me')).data.user || (await api.get('/auth/me')).data;
  await api.put(`/conversations/p${patient.id}`, { assigned_to: me.id });
  assert.equal((await api.get('/conversations?view=mine')).data.map((t) => t.thread).join(), `p${patient.id}`);
  await api.put(`/conversations/p${patient.id}`, { archived: true });
  assert.ok(!(await api.get('/conversations')).data.some((t) => t.thread === `p${patient.id}`));
  assert.ok((await api.get('/conversations?view=archived')).data.some((t) => t.thread === `p${patient.id}`));
  await new Promise((r) => setTimeout(r, 1100));
  await inbound('+15125550100', 'Actually on my way', patient.id);
  assert.ok((await api.get('/conversations')).data.some((t) => t.thread === `p${patient.id}`), 'back when they write again');
  assert.equal((await api.put('/conversations/zzz', { archived: true })).status, 400);

  // Quick replies.
  assert.ok((await api.get('/quick-replies')).data.length >= 3);
  const q = await api.put('/quick-replies', { replies: ['See you soon!', '  ', 'Call us at {phone}'] });
  assert.deepEqual(q.data, ['See you soon!', 'Call us at {phone}']);
});

test('schedule: monthly nth weekday and end dates, blockout ranges, chairs, waitlist, history', async () => {
  const { shiftVisit, parseRepeat } = await import('../src/routes/schedule.js');
  // 2026-01-13 is the 2nd Tuesday of January.
  const second = { every: 1, unit: 'month', monthly_by: 'weekday' };
  assert.deepEqual([1, 2, 3].map((i) => shiftVisit('2026-01-13 09:00', second, i)), ['2026-02-10 09:00', '2026-03-10 09:00', '2026-04-14 09:00']);
  // The last Friday stays the last Friday.
  assert.equal(shiftVisit('2026-01-30 09:00', second, 1), '2026-02-27 09:00');
  assert.equal(parseRepeat({ unit: 'week', every: 2, until: '2026-03-01' }, '2026-01-05 09:00').count, 4);
  assert.throws(() => parseRepeat({ unit: 'week', until: '2026-01-06' }, '2026-01-05 09:00'), /end date/);

  const ALL = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['07:00', '19:00']]]));
  const { api, patient, provider } = await h.practice({ office_hours: ALL });
  const series = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-01-14 09:00', end_time: '2031-01-14 10:00', repeat: { unit: 'month', every: 1, monthly_by: 'weekday', until: '2031-04-30' } });
  assert.equal(series.status, 201);
  assert.equal(series.data.series.created, 4);
  const visits = await h.db.all('SELECT start_time FROM appointments WHERE series_id = ? ORDER BY start_time', series.data.series_id ?? series.data.series.id);
  assert.deepEqual(visits.map((v) => v.start_time.slice(0, 10)), ['2031-01-14', '2031-02-11', '2031-03-11', '2031-04-08']);

  // A holiday week as one linked blockout; delete it in one go.
  const blk = (await api.post('/blockouts', { start_time: '2031-07-01 00:00', end_time: '2031-07-01 23:59', reason: 'Closed — July 4th week', through_date: '2031-07-05' })).data;
  assert.equal(blk.length, 5);
  assert.equal(new Set(blk.map((b) => b.series_key)).size, 1);
  await api.put(`/blockouts/${blk[0].id}`, { reason: 'Office closed', scope: 'series' });
  assert.ok((await api.get('/blockouts?from=2031-07-01&to=2031-07-05')).data.every((b) => b.reason === 'Office closed'));
  await api.del(`/blockouts/${blk[0].id}?scope=series`);
  assert.equal((await api.get('/blockouts?from=2031-07-01&to=2031-07-05')).data.length, 0);

  // Chair settings.
  const ops = (await api.get('/operatories')).data;
  const hyg = await api.put(`/operatories/${ops[0].id}`, { is_hygiene: true, sort: 5, default_provider_id: provider.id });
  assert.deepEqual([hyg.data.is_hygiene, hyg.data.sort, hyg.data.default_provider_id], [1, 5, provider.id]);
  assert.equal((await api.get('/operatories')).data.at(-1).id, ops[0].id, 'ordered by sort');

  // Waitlist: match an opening, offer it, and booking takes them off.
  const kid = (await api.post('/patients', { first_name: 'Early', last_name: 'Bird', phone: '(512) 555-0188' })).data;
  const w = await api.post('/waitlist', { patient_id: kid.id, reason: 'Cleaning', duration: 60, days: [2, 4], times: 'morning' });
  assert.equal(w.status, 201);
  assert.equal((await api.post('/waitlist', { patient_id: kid.id })).status, 409);
  assert.equal((await api.get('/waitlist?date=2031-01-21&time=09:00&minutes=60')).data.length, 1, 'Tuesday morning fits');
  assert.equal((await api.get('/waitlist?date=2031-01-21&time=14:00&minutes=60')).data.length, 0, 'not the afternoon');
  assert.equal((await api.get('/waitlist?date=2031-01-22&time=09:00&minutes=60')).data.length, 0, 'not Wednesday');
  const offer = await api.post('/waitlist/offer', { date: '2031-01-21', time: '09:00', minutes: 60 });
  assert.equal(offer.data.sent.length, 1);
  assert.match(h.sent.at(-1).body, /just opened/);
  const booked = (await api.post('/appointments', { patient_id: kid.id, provider_id: provider.id, start_time: '2031-01-21 09:00', end_time: '2031-01-21 10:00' })).data;
  assert.equal((await api.get('/waitlist')).data.length, 0);

  // History shows the move.
  await api.put(`/appointments/${booked.id}`, { start_time: '2031-01-21 10:00', end_time: '2031-01-21 11:00' });
  await api.patch(`/appointments/${booked.id}/status`, { status: 'confirmed', confirmed_via: 'text' });
  const hist = (await api.get(`/appointments/${booked.id}/history`)).data;
  assert.deepEqual(hist.map((x) => x.action), ['appointment.create', 'appointment.update', 'appointment.status']);
  assert.match(hist[1].details, /2031-01-21 09:00/);
});
