import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { cariesRisk, perioRisk } from '../src/risk.js';

const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: 'x' }; } };
const h = harness({ messenger });

test('caries and perio risk levels follow CAMBRA and the periodontal risk assessment', () => {
  assert.equal(cariesRisk({ fluoride_paste: true }).level, 'low');
  assert.equal(cariesRisk({ snacking: true, heavy_plaque: true, fluoride_paste: true }).level, 'moderate');
  assert.equal(cariesRisk({ cavities: true, fluoride_paste: true }).level, 'high');
  const extreme = cariesRisk({ cavities: true, low_saliva: true, saliva_meds: true });
  assert.deepEqual([extreme.level, extreme.recall_months], ['extreme', 3]);
  assert.ok(extreme.recommend.some((x) => /Chlorhexidine/.test(x)));
  assert.equal(perioRisk({ bop_pct: 5, sites_5mm: 0 }).level, 'low');
  const high = perioRisk({ bop_pct: 40, sites_5mm: 12, smoker: 15 });
  assert.deepEqual([high.level, high.recall_months], ['high', 3]);
  assert.ok(high.recommend.some((x) => /D4341/.test(x)) && high.recommend.some((x) => /Smoking/.test(x)));
});

test('risk assessments start from the chart, are kept, and can set the recall', async () => {
  const { api, patient, provider } = await h.practice();
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '14', condition: 'caries', surfaces: 'O' });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true });
  const before = (await api.get(`/patients/${patient.id}/risk`)).data;
  assert.deepEqual([before.from_chart.caries.cavities, before.from_chart.caries.recent_restorations], [true, true]);
  assert.ok(before.questions.caries.protective.xylitol);
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, interval_months, due_date) VALUES ((SELECT practice_id FROM patients WHERE id = ?), ?, 'prophy', 6, '2030-01-01')", patient.id, patient.id);
  const saved = await api.post(`/patients/${patient.id}/risk`, { kind: 'caries', answers: { ...before.from_chart.caries, fluoride_paste: true, bogus: true }, apply_recall: true });
  assert.equal(saved.status, 201);
  assert.deepEqual([saved.data.level, saved.data.result.recall_months], ['high', 4]);
  assert.equal((await h.db.get("SELECT interval_months FROM recalls WHERE patient_id = ? AND type = 'prophy'", patient.id)).interval_months, 4);
  const after = (await api.get(`/patients/${patient.id}/risk`)).data;
  assert.equal(after.caries.level, 'high');
  assert.equal(after.caries.answers.bogus, undefined);
  assert.equal((await api.post(`/patients/${patient.id}/risk`, { kind: 'mood', answers: {} })).status, 400);
});

test('education: pages matched to the plan, sent by text, readable without signing in; the office can add its own', async () => {
  const { api, patient, provider } = await h.practice();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '19', provider_id: provider.id });
  const mine = (await api.get(`/patients/${patient.id}/education`)).data;
  assert.deepEqual(mine.suggested, ['crowns']);
  const n = sent.length;
  const r = await api.post(`/patients/${patient.id}/education`, { slugs: ['crowns', 'nope'] });
  assert.equal(r.data.status, 'sent');
  const text = sent.slice(n)[0];
  assert.equal(text.to, '(512) 555-0100');
  const url = text.body.match(/Your crown: (\S+)/)[1];
  const path = new URL(url).pathname.replace('/learn/', '');
  const page = await (await fetch(`${h.origin}/api/public/learn/${path}`)).json();
  assert.equal(page.title, 'Your crown');
  assert.match(page.body, /two visits/);

  // The office's own page, and an override of a built-in one.
  assert.equal((await api.put('/education/Bad Slug', { title: 'x', body: 'y' })).status, 400);
  await api.put('/education/crowns', { title: 'Crowns at our office', body: 'Same-day crowns with our milling unit.', codes: 'D2740, D2750' });
  await api.put('/education/sleep-apnea', { title: 'Snoring and sleep apnea', body: 'We make oral appliances.', codes: ['D9947'] });
  const lib = (await api.get('/education')).data.articles;
  assert.equal(lib.find((a) => a.slug === 'crowns').title, 'Crowns at our office');
  assert.ok(lib.find((a) => a.slug === 'sleep-apnea'));
  assert.equal((await (await fetch(`${h.origin}/api/public/learn/${path}`)).json()).title, 'Crowns at our office');
  assert.equal((await fetch(`${h.origin}/api/public/learn/${path.split('/')[0]}/missing`)).status, 404);
});
