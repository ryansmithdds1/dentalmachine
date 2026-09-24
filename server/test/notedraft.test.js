// Workflow 7: a new note opens drafted from today's visit and is linked to it when saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { practiceNow } from '../src/util.js';

const h = harness();

const book = async (api, patient, provider, day, from, to, extra = {}) =>
  (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} ${from}`, end_time: `${day} ${to}`, override_blockout: true, ...extra })).data;

test("note draft defaults to today's visit: its procedures' templates, the visit id and the visit's provider", async () => {
  const ctx = await h.practice();
  const { api, patient, provider } = ctx;
  const today = (await practiceNow(h.db, ctx.practiceId ?? (await api.get('/auth/me')).data.user.practice_id)).slice(0, 10);

  // No visit today: nothing drafted, nothing linked.
  const none = (await api.get(`/patients/${patient.id}/note-draft`)).data;
  assert.equal(none.body, '');
  assert.equal(none.appointment_id, null);
  assert.deepEqual(none.visits, []);

  // A cancelled visit today doesn't count; the booked one does, with its procedures written up.
  await book(api, patient, provider, today, '07:00', '07:30', { status: 'cancelled' });
  const visit = await book(api, patient, provider, today, '08:00', '09:00');
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: 19, surfaces: 'MOD', provider_id: provider.id, appointment_id: visit.id });
  const d = (await api.get(`/patients/${patient.id}/note-draft`)).data;
  assert.equal(d.appointment_id, visit.id);
  assert.deepEqual(d.visits.map((v) => v.id), [visit.id]);
  assert.equal(d.templates[0].name, 'Composite restoration');
  assert.match(d.body, /Restored D2392 #19 MOD/);
  // The admin has no provider record: written for the visit's provider.
  assert.equal(d.user_provider_id, null);
  assert.equal(d.provider_id, provider.id);

  // Two visits today: the one in the chair wins, and both are offered.
  const second = await book(api, patient, provider, today, '15:00', '16:00');
  await h.db.run("UPDATE appointments SET status = 'in_chair' WHERE id = ?", second.id);
  const two = (await api.get(`/patients/${patient.id}/note-draft`)).data;
  assert.equal(two.appointment_id, second.id);
  assert.deepEqual(two.visits.map((v) => v.id), [visit.id, second.id]);
  assert.equal(two.body, '', 'nothing booked at that visit matches a template');
  // Asking for a visit by id drafts that one; another patient's is refused.
  assert.equal((await api.get(`/patients/${patient.id}/note-draft?appointment_id=${visit.id}`)).data.appointment_id, visit.id);
  const other = (await api.post('/patients', { first_name: 'O', last_name: 'Other', dob: '1990-01-01' })).data;
  const theirs = await book(api, other, provider, today, '10:00', '11:00');
  assert.equal((await api.get(`/patients/${patient.id}/note-draft?appointment_id=${theirs.id}`)).status, 400);
  // A template picked by hand is written up with that visit's procedures.
  const tpl = (await api.get('/note-templates')).data.find((t) => t.name === 'Composite restoration');
  assert.match((await api.get(`/patients/${patient.id}/note-draft?template_id=${tpl.id}&appointment_id=${visit.id}`)).data.body, /D2392 #19 MOD/);

  // Procedures named by the chart: the visit is the one they were done at.
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, appointment_id: visit.id })).data;
  assert.equal((await api.get(`/patients/${patient.id}/note-draft?procedure_ids=${p.id}`)).data.appointment_id, visit.id);

  // A dentist with a login gets their own provider as the default.
  await api.post('/users', { email: `dr-${Date.now()}@notes.example.com`, name: 'Dr Own', role: 'dentist', password: 'dentist-own-password' });
  const users = (await api.get('/users')).data;
  const dr = users.find((u) => u.name === 'Dr Own');
  const mine = (await api.post('/providers', { name: 'Dr. Own, DDS', type: 'dentist' })).data;
  await api.put(`/providers/${mine.id}`, { user_id: dr.id });
  const drApi = h.client((await h.client().post('/auth/login', { email: dr.email, password: 'dentist-own-password' })).data.token);
  const own = (await drApi.get(`/patients/${patient.id}/note-draft`)).data;
  assert.equal(own.user_provider_id, mine.id);
  assert.equal(own.provider_id, mine.id);
});

test("a note saved with today's visit is linked to it (and its office); another patient's visit is refused", async () => {
  const ctx = await h.practice();
  const { api, patient, provider } = ctx;
  const today = (await practiceNow(h.db, (await api.get('/auth/me')).data.user.practice_id)).slice(0, 10);
  const visit = await book(api, patient, provider, today, '09:00', '10:00');
  const draft = (await api.get(`/patients/${patient.id}/note-draft`)).data;
  const saved = await api.post(`/patients/${patient.id}/notes`, { body: 'Periodic exam, no new findings.', provider_id: draft.provider_id, appointment_id: draft.appointment_id });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.appointment_id, visit.id);
  const listed = (await api.get(`/patients/${patient.id}/notes`)).data.find((n) => n.id === saved.data.id);
  assert.equal(listed.visit_start, `${today} 09:00`);
  const loc = (await h.db.get('SELECT location_id FROM appointments WHERE id = ?', visit.id)).location_id;
  assert.equal(saved.data.location_id ?? null, loc ?? null);
  // The link is recorded in the audit trail.
  const audit = await h.db.get("SELECT * FROM audit_log WHERE action = 'note.create' AND entity_id = ?", saved.data.id);
  assert.match(String(audit.details), new RegExp(`"appointment_id":${visit.id}`));

  // Still changeable before signing, and unlinked notes still save.
  assert.equal((await api.put(`/notes/${saved.data.id}`, { appointment_id: visit.id })).status, 200);
  assert.equal((await api.post(`/patients/${patient.id}/notes`, { body: 'Phone call.', appointment_id: null })).data.appointment_id, null);
  const other = (await api.post('/patients', { first_name: 'O', last_name: 'Other', dob: '1990-01-01' })).data;
  const theirs = await book(api, other, provider, today, '11:00', '12:00');
  assert.equal((await api.post(`/patients/${patient.id}/notes`, { body: 'x', appointment_id: theirs.id })).status, 400);
});
