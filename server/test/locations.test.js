import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const MON = '2031-03-03';
const SAT = '2031-03-08';

test('multi-location: offices, chairs, hours, ledger and reports by office', async () => {
  const { api, token, provider, patient } = await h.practice({ timezone: 'UTC' });
  const op1 = (await api.post('/operatories', { name: 'Op 1' })).data;
  const before = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: op1.id, start_time: `${MON} 08:00`, end_time: `${MON} 09:00` })).data;
  assert.equal(before.location_id, null, 'one office: no location yet');

  // The first office takes the existing chairs and visits.
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  assert.equal((await api.get('/operatories')).data[0].location_id, main.id);
  assert.equal((await api.get(`/appointments/${before.id}`)).data.location_id, main.id);

  // A Saturday-only satellite office with its own chair.
  const sat = (await api.post('/locations', { name: 'Westside', office_hours: { 6: [['09:00', '13:00']] } })).data;
  const op2 = (await api.post('/operatories', { name: 'West 1', location_id: sat.id })).data;
  const monday = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: op2.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00` });
  assert.equal(monday.status, 409, 'Westside is closed Mondays');
  assert.match(monday.data.error, /outside office hours/);
  const west = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: op2.id, start_time: `${SAT} 09:00`, end_time: `${SAT} 10:00` })).data;
  assert.equal(west.location_id, sat.id);

  // The calendar for one office shows its visits and hours only.
  const westCal = (await api.get(`/schedule?from=${MON}&to=${SAT}&location_id=${sat.id}`)).data;
  assert.deepEqual(westCal.appointments.map((a) => a.id), [west.id]);
  assert.deepEqual(westCal.hours[SAT], [['09:00', '13:00']]);
  assert.deepEqual(westCal.hours[MON], []);
  assert.equal((await api.get(`/schedule?from=${MON}&to=${SAT}`)).data.appointments.length, 2, 'all offices');

  // Production counts at the visit's office; front-desk payments at the screen's office.
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, appointment_id: west.id })).data;
  await api.post(`/procedures/${proc.id}/complete`);
  const westDesk = h.client(token, { 'X-Location-Id': String(sat.id) });
  await westDesk.post(`/patients/${patient.id}/payments`, { amount: 2000, method: 'cash' });
  const ledger = await h.db.all('SELECT type, location_id FROM ledger_entries WHERE patient_id = ? ORDER BY id', patient.id);
  assert.deepEqual(ledger.map((l) => [l.type, l.location_id]), [['charge', sat.id], ['payment', sat.id]]);
  const today = (await h.db.get('SELECT entry_date FROM ledger_entries WHERE patient_id = ?', patient.id)).entry_date;
  const westProd = (await api.get(`/reports/production?from=${today}&to=${today}&location_id=${sat.id}`)).data;
  assert.equal(westProd.by_provider[0].production, proc.fee);
  assert.equal((await api.get(`/reports/production?from=${today}&to=${today}&location_id=${main.id}`)).data.by_provider.length, 0);
  const all = (await api.get(`/reports/production?from=${today}&to=${today}`)).data;
  assert.deepEqual(all.by_location.map((l) => [l.name, l.production, l.patient_collections]), [['Westside', proc.fee, 2000]]);
  assert.equal((await api.get(`/reports/daysheet?date=${today}&location_id=${main.id}`)).data.entries.length, 0);

  // Staff who work at one office only: their session lists it, and their screen is always there.
  const hyg = (await api.post('/users', { email: `west-${Date.now()}@example.com`, name: 'West Desk', role: 'front_desk', password: 'correct-horse-battery', location_ids: [sat.id] })).data;
  assert.equal(hyg.location_ids, JSON.stringify([sat.id]));
  const login = await h.client().post('/auth/login', { email: hyg.email, password: 'correct-horse-battery' });
  assert.deepEqual(login.data.user.locations.map((l) => l.name), ['Westside']);
  const desk = h.client(login.data.token, { 'X-Location-Id': String(main.id) });
  await desk.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' });
  assert.equal((await h.db.get("SELECT location_id FROM ledger_entries WHERE patient_id = ? AND amount = -1000", patient.id)).location_id, sat.id);
});

test('multi-location online booking: patients choose an office', async () => {
  const { api, provider } = await h.practice({ timezone: 'UTC' });
  await api.put('/practice', { slug: `loc-${Date.now()}`, online_booking: true });
  const slug = (await api.get('/practice')).data.slug;
  const a = (await api.post('/locations', { name: 'North' })).data;
  const b = (await api.post('/locations', { name: 'South', office_hours: { 6: [['09:00', '12:00']] } })).data;
  const pub = h.client();
  const info = (await pub.get(`/public/practices/${slug}`)).data;
  assert.deepEqual(info.locations.map((l) => l.name), ['North', 'South']);
  const southMon = (await pub.get(`/public/practices/${slug}/availability?date=${MON}&location_id=${b.id}`)).data;
  assert.equal(southMon.slots.length, 0, 'South is only open Saturdays');
  assert.equal(southMon.next_available, SAT);
  const northMon = (await pub.get(`/public/practices/${slug}/availability?date=${MON}&location_id=${a.id}`)).data;
  assert.ok(northMon.slots.length > 0);
  const body = { first_name: 'Pat', last_name: 'Online', phone: '5125550199', provider_id: provider.id, start: northMon.slots[0].start };
  assert.equal((await pub.post(`/public/practices/${slug}/booking-requests`, body)).status, 400, 'which office?');
  assert.equal((await pub.post(`/public/practices/${slug}/booking-requests`, { ...body, location_id: a.id })).status, 201);
  assert.equal((await h.db.get('SELECT location_id FROM booking_requests WHERE last_name = ?', 'Online')).location_id, a.id);
});

test('location restrictions: someone limited to one office sees only its patients, schedule and reports', async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC' });
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  const west = (await api.post('/locations', { name: 'Westside' })).data;
  const opMain = (await api.post('/operatories', { name: 'M1', location_id: main.id })).data;
  const opWest = (await api.post('/operatories', { name: 'W1', location_id: west.id })).data;
  // Jane is seen at Main St; Wes at Westside; Nia is a new chart with no visits yet.
  const mainVisit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: opMain.id, start_time: `${MON} 08:00`, end_time: `${MON} 09:00` })).data;
  const wes = (await api.post('/patients', { first_name: 'Wes', last_name: 'Tside', location_id: west.id })).data;
  const westVisit = (await api.post('/appointments', { patient_id: wes.id, provider_id: provider.id, operatory_id: opWest.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00` })).data;
  const nia = (await api.post('/patients', { first_name: 'Nia', last_name: 'New' })).data;
  const westNote = (await api.post(`/patients/${wes.id}/notes`, { body: 'Westside note' })).data;

  const email = `west-${Date.now()}@example.com`;
  const staff = (await api.post('/users', { email, name: 'West Desk', role: 'dentist', password: 'west-desk-password' })).data;
  await api.put(`/users/${staff.id}`, { location_ids: [main.id] });
  const desk = h.client((await h.client().post('/auth/login', { email, password: 'west-desk-password' })).data.token);

  const names = (await desk.get('/patients?status=all')).data.rows.map((p) => p.first_name).sort();
  assert.deepEqual(names, ['Jane', 'Nia']);
  assert.equal((await desk.get(`/patients/${wes.id}`)).status, 404);
  assert.equal((await desk.get(`/patients/${wes.id}/notes`)).status, 404);
  assert.equal((await desk.get(`/appointments/${westVisit.id}`)).status, 404);
  assert.equal((await desk.put(`/notes/${westNote.id}`, { body: 'x' })).status, 404);
  assert.equal((await desk.get(`/search?q=Tside`)).data.patients.length, 0);
  assert.equal((await desk.get(`/patients/${patient.id}`)).status, 200);
  assert.equal((await desk.get(`/patients/${nia.id}`)).status, 200);
  assert.deepEqual((await desk.get(`/appointments?date=${MON}`)).data.map((a) => a.id), [mainVisit.id]);
  assert.deepEqual((await desk.get(`/schedule?from=${MON}&to=${MON}`)).data.appointments.map((a) => a.id), [mainVisit.id]);
  // Can't book at the other office, or book a patient they can't see.
  assert.equal((await desk.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: opWest.id, location_id: west.id, start_time: `${MON} 13:00`, end_time: `${MON} 14:00` })).status, 403);
  assert.equal((await desk.post('/appointments', { patient_id: wes.id, provider_id: provider.id, operatory_id: opMain.id, start_time: `${MON} 13:00`, end_time: `${MON} 14:00` })).status, 404);
  // Lists drop the other office's patients.
  await api.post('/tasks', { title: 'Call Wes', patient_id: wes.id });
  await api.post('/tasks', { title: 'Call Jane', patient_id: patient.id });
  const tasks = (await desk.get('/tasks')).data;
  assert.deepEqual((tasks.tasks || tasks).map((t) => t.title), ['Call Jane']);
  // Practice-wide reports are closed; office reports are held to Main St.
  assert.equal((await desk.get('/reports/aging')).status, 403);
  assert.equal((await desk.get(`/reports/production?location_id=${west.id}`)).status, 403);
  assert.equal((await desk.get('/reports/production')).status, 200);
  // Everyone else still sees everything.
  assert.equal((await api.get('/patients?status=all')).data.rows.length, 3);
});
