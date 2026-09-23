import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runSurveys, npsScore } from '../src/surveys.js';

const h = harness();

test('NPS score', () => {
  assert.equal(npsScore([10, 9, 8, 7, 3]), 20);
  assert.equal(npsScore([]), null);
});

test('surveys: build, send, answer (in Spanish too), results with NPS; the day-after job', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const meta = (await api.get('/surveys')).data;
  assert.equal(meta.defaults[0].type, 'nps');
  assert.equal((await api.post('/surveys', { name: 'Bad', questions: [{ type: 'stars', label: 'x' }] })).status, 400);
  const s = (await api.post('/surveys', { name: 'After visit' })).data;
  assert.equal(s.questions.length, 3);

  const other = (await api.post('/patients', { first_name: 'Ana', last_name: 'Ruiz', email: 'ana@example.com', email_opt_in: true, language: 'Spanish' })).data;
  const before = h.sent.length;
  assert.deepEqual((await api.post(`/surveys/${s.id}/send`, { patient_ids: [patient.id, other.id] })).data, { sent: 2, skipped: 0 });
  const msgs = h.sent.slice(before);
  assert.match(msgs.find((m) => m.to === 'ana@example.com').body, /^Hola Ana/);
  const token = (m) => /\/s\/([\w-]+)/.exec(m.body)[1];
  const pub = h.client();
  const page = (await pub.get(`/public/survey/${token(msgs.find((m) => m.to === 'ana@example.com'))}`)).data;
  assert.equal(page.language, 'es');
  assert.equal(page.questions[0].label_es.startsWith('¿Qué tan probable'), true);

  const janeToken = token(msgs.find((m) => m.to !== 'ana@example.com'));
  assert.equal((await pub.post(`/public/survey/${janeToken}`, { answers: { nps: 11 } })).status, 400);
  assert.equal((await pub.post(`/public/survey/${janeToken}`, { answers: { nps: 10, wait: 4, better: 'More parking' } })).status, 200);
  assert.equal((await pub.post(`/public/survey/${janeToken}`, { answers: { nps: 1 } })).status, 409, 'once');
  await pub.post(`/public/survey/${token(msgs.find((m) => m.to === 'ana@example.com'))}`, { answers: { nps: 5, better: 'Más horarios en la tarde' } });

  const res = (await api.get(`/surveys/${s.id}/results`)).data;
  assert.deepEqual([res.sent, res.answered, res.response_rate, res.nps], [2, 2, 100, 0]);
  const q = Object.fromEntries(res.questions.map((x) => [x.id, x]));
  assert.deepEqual([q.nps.promoters, q.nps.detractors, q.wait.average], [1, 1, 4]);
  assert.deepEqual(q.better.comments.map((c) => c.text).sort(), ['More parking', 'Más horarios en la tarde']);

  // Automatic: the day after a completed visit, once per 90 days.
  await api.put(`/surveys/${s.id}`, { auto_after_visit: true });
  const third = (await api.post('/patients', { first_name: 'Tom', last_name: 'Lee', phone: '5125550177', sms_opt_in: true })).data;
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'completed')", (await api.get('/practice')).data.id, third.id, provider.id, `${yesterday} 09:00`, `${yesterday} 10:00`);
  const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  assert.ok(await runSurveys(h.db, h.messenger, { appUrl: 'https://app.example.com', now: noon }) >= 1);
  assert.equal(await runSurveys(h.db, h.messenger, { appUrl: 'https://app.example.com', now: noon }), 0, 'not twice');
});
