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
