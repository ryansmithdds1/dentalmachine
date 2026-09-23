import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { harness } from './helpers.js';
import { normalize } from '../src/xrayai.js';

// A tiny real PNG (8x8 grey), as an x-ray upload.
function png() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc(8 * 9, 128); for (let y = 0; y < 8; y++) raw[y * 9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 't', name: 'report_findings', input: { image_type: 'bitewing', findings: [{ kind: 'caries', tooth: '19', surfaces: 'do', confidence: 0.77, box: [0.4, 0.3, 0.1, 0.1] }, { kind: 'sparkles', confidence: 2, box: [1.5, -1, 0.2, 0.2] }] } }],
    }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { xrayAi: 'sandbox' } });
const hc = harness({ config: { xrayAi: 'claude', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });

const upload = async (hh, token, patient, extra = '', category = 'xray') => (await fetch(`${hh.origin}/api/patients/${patient.id}/documents?category=${category}&filename=bw.png${extra}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: png(),
})).json();

test('x-ray AI: new x-rays are read in the background; the dentist accepts findings onto the chart or rejects them', async () => {
  const { api, patient, token } = await h.practice();
  assert.deepEqual((await api.get('/xray-ai')).data, { enabled: true, mode: 'sandbox', label: 'AI (sandbox)', cleared: false });
  const doc = await upload(h, token, patient, '&tooth=14');
  let found = [];
  for (let i = 0; i < 50 && !found.length; i++) {
    await new Promise((r) => setTimeout(r, 20));
    found = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings;
  }
  assert.ok(found.length >= 3, 'read on upload');
  const caries = found.find((f) => f.kind === 'caries');
  assert.equal(caries.tooth, '14');
  assert.equal(caries.label, 'Caries');
  assert.equal(caries.box.length, 4);
  assert.equal((await api.get(`/patients/${patient.id}/ai-findings`)).data.length, found.length);

  const accepted = (await api.patch(`/ai-findings/${caries.id}`, { status: 'accepted', chart: true })).data;
  assert.equal(accepted.status, 'accepted');
  const cond = await h.db.get('SELECT * FROM tooth_conditions WHERE id = ?', accepted.condition_id);
  assert.deepEqual([cond.tooth, cond.condition, cond.surfaces], ['14', 'caries', caries.surfaces]);
  const calc = found.find((f) => f.kind === 'calculus');
  await api.patch(`/ai-findings/${calc.id}`, { status: 'rejected' });
  assert.equal((await api.patch(`/ai-findings/${calc.id}`, { status: 'maybe' })).status, 400);

  // Reading again replaces only suggestions nobody acted on.
  await api.post(`/documents/${doc.id}/ai-read`);
  const again = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings;
  assert.ok(again.some((f) => f.id === caries.id && f.status === 'accepted'));
  assert.ok(again.some((f) => f.id === calc.id && f.status === 'rejected'));
  const stats = (await api.get('/xray-ai/stats')).data;
  assert.equal(stats.find((s) => s.kind === 'caries').accepted, 1);

  // Photos and documents aren't read; the practice can turn automatic reading off.
  const photo = await upload(h, token, patient, '', 'photo');
  assert.equal((await api.post(`/documents/${photo.id}/ai-read`)).status, 400);
});

test('x-ray AI with Claude: the image goes as an image, findings are cleaned up, and it is labelled as not FDA-cleared', async () => {
  const { api, patient, token } = await hc.practice();
  const status = (await api.get('/xray-ai')).data;
  assert.equal(status.cleared, false);
  assert.match(status.label, /not FDA-cleared/);
  const doc = await upload(hc, token, patient);
  const out = (await api.post(`/documents/${doc.id}/ai-read`)).data;
  const sent = seen.at(-1);
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.equal(sent.messages[0].content[0].source.media_type, 'image/png');
  assert.equal(out.image_type, 'bitewing');
  assert.deepEqual(out.findings.map((f) => [f.kind, f.tooth, f.surfaces, f.confidence]), [['caries', '19', 'DO', 0.77], ['other', null, null, 1]]);
  assert.deepEqual(normalize({ kind: 'x', confidence: 2, box: [1.5, -1, 0.2, 0.2] }).box, [1, 0, 0.2, 0.2]);
});
