import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runReviewRequests } from '../src/messaging.js';

const h = harness();

test('every automated message has an editable template with checked merge fields', async () => {
  const { api, patient } = await h.practice();
  const meta = (await api.get('/message-templates/meta')).data;
  assert.ok(['forms', 'treatment_plan', 'payment_link', 'card_declined', 'booking_declined'].every((k) => meta[k]?.label && meta[k].text));
  assert.equal((await api.put('/practice', { message_templates: { forms: 'Please fill these in' } })).status, 400); // no {link}
  const bad = await api.put('/practice', { message_templates: { forms: 'Hi {first_name}, {link} {when}' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /can't use \{when\}/);
  assert.equal((await api.put('/practice', { message_templates: { forms: 'Hola {first_name}! Formularios de {practice}: {link}' } })).status, 200);
  const before = h.sent.length;
  await api.post(`/patients/${patient.id}/form-requests`, { send: 'sms' });
  assert.match(h.sent.slice(before)[0].body, /^Hola Jane! Formularios de Practice \d+: https:\/\/app\.example\.com\/f\//);
});

async function visitToday(api, patient, provider, when = '09:00') {
  const d = new Date().toISOString().slice(0, 10);
  const a = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${d} ${when}`, end_time: `${d} ${when.slice(0, 3)}30`, override_blockout: true })).data;
  await api.put(`/appointments/${a.id}`, { status: 'completed' });
  return { d, a };
}

test('review routing: happy patients go on to the review page, unhappy ones reach the office', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  await api.put('/practice', { review_url: 'https://g.page/r/example/review', review_requests: true, review_threshold: 4 });
  const { d } = await visitToday(api, patient, provider);
  const before = h.sent.length;
  assert.equal(await runReviewRequests(h.db, h.messenger, { now: new Date(`${d}T22:00:00Z`), appUrl: 'https://app.example.com' }), 1);
  const token = /\/r\/([\w-]+)/.exec(h.sent[before].body)[1];
  const pub = h.client();
  const page = (await pub.get(`/public/review/${token}`)).data;
  assert.equal(page.first_name, 'Jane');
  assert.equal(page.rating, null);
  assert.equal((await pub.post(`/public/review/${token}`, { rating: 9 })).status, 400);
  const happy = (await pub.post(`/public/review/${token}`, { rating: 5 })).data;
  assert.equal(happy.happy, true);
  const go = await fetch(`${h.origin}/api/public/review/${token}/go`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), 'https://g.page/r/example/review');

  // A second patient isn't happy.
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Ruiz', phone: '5125550177' })).data;
  await visitToday(api, other, provider, '10:00');
  const n = h.sent.length;
  await runReviewRequests(h.db, h.messenger, { now: new Date(`${d}T22:00:00Z`), appUrl: 'https://app.example.com' });
  const t2 = /\/r\/([\w-]+)/.exec(h.sent[n].body)[1];
  const sad = (await pub.post(`/public/review/${t2}`, { rating: 2 })).data;
  assert.equal(sad.happy, false);
  // No review gating: the public review link works for every rating (docs/reviews.md).
  assert.equal((await fetch(`${h.origin}/api/public/review/${t2}/go`, { redirect: 'manual' })).status, 302);
  await pub.post(`/public/review/${t2}`, { comment: 'Waited 40 minutes' });
  const tasks = (await api.get(`/tasks?patient_id=${other.id}`)).data;
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /Unhappy after visit \(2★\): Sam Ruiz — “Waited 40 minutes”/);

  const report = (await api.get(`/reports/reviews?from=${d}&to=${d}`)).data;
  assert.deepEqual([report.sent, report.responded, report.happy, report.unhappy, report.went_to_review, report.average], [2, 2, 1, 1, 2, 3.5]);
  assert.equal(report.feedback[0].comment, 'Waited 40 minutes');
});

test('Spanish: patients with Spanish on file get Spanish messages; offices can edit the Spanish wording', async () => {
  const { api, patient, provider } = await h.practice();
  await api.put(`/patients/${patient.id}`, { language: 'Spanish', sms_opt_in: true, phone: '5125550123' });
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2031-05-06 09:00', end_time: '2031-05-06 10:00' })).data;
  let before = h.sent.length;
  await api.post(`/appointments/${appt.id}/remind`, { channel: 'sms' });
  const reminder = h.sent.slice(before)[0].body;
  assert.match(reminder, /^Hola Jane, le recordamos de Practice \d+ su cita el martes, 6 de mayo, a las 9:00 a\. m\./);
  assert.match(reminder, /Responda C para confirmar/);
  const token = /\/c\/([\w-]+)/.exec(reminder)[1];
  assert.equal((await h.client().get(`/public/confirm/${token}`)).data.language, 'es');

  // The Spanish template is checked like the English one, and used for Spanish speakers only.
  assert.equal((await api.put('/practice', { message_templates: { forms_es: 'Llene esto por favor' } })).status, 400);
  assert.equal((await api.put('/practice', { message_templates: { forms_es: '¡Hola {first_name}! Sus formularios: {link}' } })).status, 200);
  before = h.sent.length;
  await api.post(`/patients/${patient.id}/form-requests`, { send: 'sms' });
  assert.match(h.sent.slice(before)[0].body, /^¡Hola Jane! Sus formularios: https:/);
  await api.put(`/patients/${patient.id}`, { language: 'English' });
  before = h.sent.length;
  await api.post(`/patients/${patient.id}/form-requests`, { send: 'sms' });
  assert.match(h.sent.slice(before)[0].body, /^Hi Jane, please complete/);
});
