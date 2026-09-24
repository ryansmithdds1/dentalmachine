import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';
import { quickFill, prompts } from '../src/notedictation.js';

// A stand-in for the AI: answers with a filled note, or fails when told to.
const seen = [];
let failNext = 0;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    if (failNext > 0) { failNext--; res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 't', name: 'update_note', input: {
        note: 'Periodic exam. Small ulcer on the left buccal mucosa; salt-water rinses, recheck in 2 weeks. Next recall [[Recall: 6 months|3 months]].',
        filled: [], added: ['ulcer on left buccal mucosa', 'recheck in 2 weeks'], changed: ['Soft tissue WNL → small ulcer on the left buccal mucosa'],
      } }],
    }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());
const h = harness();
const withAi = harness({ config: { assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });

const COMPOSITE = 'Restored #30 MO. Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi|3% mepivacaine plain|none]], [[Carpules: 1|2|3]] carpule(s), [[Injection: infiltration|IANB|PSA]]. Isolation with [[Isolation: rubber dam|Isolite|cotton rolls]]. Composite shade [[Shade: A1|A2|A3|A3.5|B1]]. [[Sutures: no sutures|sutures placed]].';

test('quick fill: options said outright, numbers by their label, distinctive words and free shades', () => {
  const out = quickFill(COMPOSITE, 'two carpules of articaine I A N B, rubber dam, shade A2');
  assert.match(out.body, /Anesthetic: 4% articaine 1:100k epi, 2 carpule\(s\)/);
  assert.match(out.body, /Isolation with rubber dam/);
  assert.match(out.body, /shade A2\./);
  assert.ok(out.unanswered.includes('Sutures'), 'nothing said about sutures: still a question');
  assert.ok(out.unanswered.includes('Injection'), '"I A N B" spelled out is left for the AI or a tap, not guessed');
  // Longest option wins; a shade that isn't on the list is written as said.
  assert.match(quickFill(COMPOSITE, 'no sutures').body, /no sutures\./);
  assert.match(quickFill(COMPOSITE, 'shade b2 today').body, /shade B2\./);
  // Nothing is guessed from unrelated words.
  assert.equal(quickFill(COMPOSITE, 'patient did great').filled.length, 0);
  assert.equal(prompts(COMPOSITE).length, 6);
  // Teeth said the way dentists say them.
  assert.equal(quickFill('Restored [[Teeth: ]].', 'number thirty M O').body, 'Restored [[Teeth: ]].', 'spelled-out surfaces need the AI');
  assert.equal(quickFill('Restored [[Teeth: ]].', 'tooth 30 MO and number 31 O').body, 'Restored #30 MO, #31 O.');
});

test('dictating into a note: fills the template, keeps what it can’t place, records the approval when saved', async () => {
  const { api, patient } = await h.practice();
  const out = (await api.post(`/patients/${patient.id}/note-dictate`, { body: COMPOSITE, dictation: 'articaine, three carpules, isolite, IANB' })).data;
  assert.equal(out.ai, false);
  assert.match(out.body, /4% articaine 1:100k epi, 3 carpule\(s\), IANB\. Isolation with Isolite/);
  assert.deepEqual(out.unanswered, ['Shade', 'Sutures']);
  // A longer dictation the quick fill can't place goes at the end, as said.
  const long = (await api.post(`/patients/${patient.id}/note-dictate`, { body: 'Periodic exam.', dictation: 'small ulcer on the left buccal mucosa, told her to rinse with salt water and come back in two weeks if it is still there' })).data;
  assert.match(long.body, /^Periodic exam\.\nSmall ulcer on the left buccal mucosa/);
  assert.equal((await api.post(`/patients/${patient.id}/note-dictate`, { body: 'x', dictation: '' })).status, 400);

  const note = (await api.post(`/patients/${patient.id}/notes`, { body: out.body, ai_assisted: true })).data;
  const approved = await h.db.get("SELECT * FROM audit_log WHERE action = 'note.ai_draft_approved' AND entity_id = ?", note.id);
  assert.ok(approved);
});

test('with AI on: the dictation is worked into the right sentences, contradictions changed and listed; if the AI fails, nothing is lost', async () => {
  const { api, patient } = await withAi.practice();
  const out = (await api.post(`/patients/${patient.id}/note-dictate`, { body: 'Periodic exam. Soft tissue WNL. Next recall [[Recall: 6 months|3 months]].', dictation: 'small ulcer left buccal mucosa, salt water rinses, recheck two weeks' })).data;
  assert.equal(out.ai, true);
  assert.match(out.body, /Small ulcer on the left buccal mucosa/);
  assert.deepEqual(out.unanswered, ['Recall']);
  assert.equal(out.changed.length, 1);
  const sent = seen.at(-1);
  assert.match(sent.messages[0].content, /Soft tissue WNL/);
  assert.match(sent.system, /Never add anything that wasn't dictated/);

  failNext = 3; // the client retries twice
  const fallback = (await api.post(`/patients/${patient.id}/note-dictate`, { body: 'Crown seat #3. [[Cement: RelyX|FujiCEM]].', dictation: 'fujicem' })).data;
  assert.equal(fallback.ai, false);
  assert.match(fallback.warning, /couldn't help/);
  assert.match(fallback.body, /Crown seat #3\. FujiCEM\./);
});

const calls = [];
const dg = harness({
  config: { transcribe: 'deepgram', deepgramKey: 'dg-key' },
  fetchImpl: async (url, opts) => {
    if (String(url).includes('deepgram.com')) {
      calls.push({ url: String(url), opts });
      return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: '2 carpules of articaine, rubber dam' }] }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return globalThis.fetch(url, opts);
  },
});

test('server dictation: the medical speech model, primed with dental words and the office’s template answers; audio not kept', async () => {
  const { token } = await dg.practice();
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await (await fetch(`${dg.origin}/api/dictation`, { headers: auth })).json()).mode, 'server');
  const res = await fetch(`${dg.origin}/api/dictation/transcribe`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/webm;codecs=opus' }, body: Buffer.from('fake-audio') });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, '2 carpules of articaine, rubber dam');
  const url = new URL(calls.at(-1).url);
  assert.equal(url.searchParams.get('model'), 'nova-3-medical');
  const terms = url.searchParams.getAll('keyterm');
  assert.ok(terms.includes('articaine') && terms.includes('Isolite'), 'dental vocabulary');
  assert.ok(terms.includes('Vitrebond'), 'answers from the office’s own templates');
  assert.equal(calls.at(-1).opts.headers['Content-Type'], 'audio/webm');
  assert.equal((await fetch(`${dg.origin}/api/dictation/transcribe`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/webm' }, body: Buffer.alloc(0) })).status, 400);
});

test('without a speech service the screen uses the browser, and the server refuses audio', async () => {
  const { token } = await h.practice();
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await (await fetch(`${h.origin}/api/dictation`, { headers: auth })).json()).mode, 'browser');
  assert.equal((await fetch(`${h.origin}/api/dictation/transcribe`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/webm' }, body: Buffer.from('x') })).status, 409);
});
