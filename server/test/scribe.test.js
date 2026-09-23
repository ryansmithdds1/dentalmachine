import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';

// A stand-in for the Anthropic API that answers with the scribe's tool call.
const seen = [];
let reply = null;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content: reply }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });
const off = harness({ config: { assistant: { enabled: false } } });

test('AI scribe: the conversation and the chart become a draft note; codes are checked; the conversation is not kept', async () => {
  const { api, patient, provider } = await h.practice();
  await api.put(`/patients/${patient.id}`, { allergies: 'Penicillin' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${today} 23:00`, end_time: `${today} 23:50`, override_blockout: true, notify: false })).data;
  await api.post('/note-templates', { name: 'Restorative', body: 'Tooth #: \nAnesthetic: \nProcedure: ' });

  reply = [{
    type: 'tool_use', id: 'toolu_1', name: 'write_note',
    input: {
      note: 'Reason for visit: sensitivity on #30.\nTreatment: MO composite #30.', summary: 'MO composite #30',
      completed: [{ code: 'd2392', tooth: '30', surfaces: 'mo' }, { code: 'D9999X', description: 'something odd' }],
      planned: [{ code: 'D2740', tooth: '19' }], conditions: [{ tooth: '19', condition: 'fracture', surfaces: 'L' }],
      missing: ['Anesthetic amount', 'Shade'], patient_instructions: 'Avoid chewing on the left for two hours.',
    },
  }];
  const transcript = 'Okay Jane, so the cold sensitivity is on the lower right. Yes, 30 has decay on the mesial and occlusal, we will do a composite today. Also 19 has a crack on the lingual, we should crown that.';
  const draft = await api.post('/scribe/draft', { patient_id: patient.id, transcript, minutes: 22 });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.equal(draft.data.appointment_id, visit.id, 'today’s visit is found');
  assert.deepEqual(draft.data.completed.map((p) => [p.code, p.tooth, p.surfaces, p.known]), [['D2392', '30', 'MO', true], ['D9999X', null, null, false]]);
  assert.ok(draft.data.completed[0].fee > 0, 'with the office fee');
  assert.deepEqual(draft.data.missing, ['Anesthetic amount', 'Shade']);

  // What Claude was given: the conversation, the chart (allergy, today's visit, the office's note template).
  const sent = seen.at(-1);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.tools[0].name, 'write_note');
  const prompt = sent.messages[0].content;
  assert.match(prompt, /Penicillin/);
  assert.match(prompt, /"name": "Restorative"/);
  assert.match(prompt, /cold sensitivity is on the lower right/);

  // Logged without the conversation.
  const s = await h.db.get('SELECT * FROM scribe_sessions WHERE id = ?', draft.data.session_id);
  assert.equal(s.minutes, 22);
  assert.equal(s.words, transcript.split(/\s+/).length);
  assert.ok(!JSON.stringify(s).includes('sensitivity'));
  const note = (await api.post(`/patients/${patient.id}/notes`, { body: draft.data.note, appointment_id: visit.id })).data;
  assert.equal((await api.post(`/scribe/${s.id}/saved`, { note_id: note.id, edited: true })).status, 200);
  assert.equal((await h.db.get('SELECT note_id, edited FROM scribe_sessions WHERE id = ?', s.id)).note_id, note.id);

  assert.equal((await api.post('/scribe/draft', { patient_id: patient.id, transcript: 'hi' })).status, 400);
  const o = await off.practice();
  assert.equal((await o.api.get('/scribe')).data.enabled, false);
  assert.equal((await o.api.post('/scribe/draft', { patient_id: o.patient.id, transcript })).status, 503);
});
