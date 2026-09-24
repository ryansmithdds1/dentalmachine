// X-ray AI as a second set of eyes (backlog XR1–XR3; docs/workflows/specs/XR-xray-ai.md): FDA-cleared vendor
// adapters (Pearl, Overjet, VideaHealth) with sandbox, the chart comparison review list, accept/dismiss recorded,
// the AI never charting on its own, the pre-appointment second look, accepted-only patient views, permissions,
// practice isolation, and vendor failures in Needs attention.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { harness } from './helpers.js';
import { insert, practiceNow } from '../src/util.js';
import { normalize, compareWithChart, createXrayAi, runSecondLook, sentenceFor } from '../src/xrayai.js';
import { pearl, overjet, videahealth, vendorAdapter, fdiToUniversal, VendorError } from '../src/xrayvendors.js';

// Outside calls to 127.0.0.1 are logged too in this file, so the Connection activity check sees the fake vendor.
process.env.LOG_LOCAL_INTEGRATIONS = '1';

// A tiny real PNG (8x8, one grey level per call), as an x-ray upload.
function png(level = 128) {
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
  const raw = Buffer.alloc(8 * 9, level); for (let y = 0; y < 8; y++) raw[y * 9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Vendor fixtures (the shapes the adapters are built to; see xrayvendors.js) ----
const PEARL_RESPONSE = {
  analysis_id: 'pa_7f3c2a91d0e84b6c9a11',
  image: { width: 1200, height: 900, modality: 'bitewing' },
  quality: { usable: true, issues: ['cone_cut'] },
  detections: [
    { id: 'd1', class: 'caries', tooth: { number: 19, system: 'universal' }, surfaces: ['D'], score: 0.87, severity: 'progressed', bbox: { x: 600, y: 450, w: 120, h: 90 } },
    { id: 'd2', class: 'periapical_radiolucency', tooth: { number: 30, system: 'universal' }, surfaces: [], score: 0.66, bbox: { x: 100, y: 700, w: 60, h: 60 } },
    { id: 'd3', class: 'bone_loss', tooth: { number: 18, system: 'universal' }, score: 0.7, bbox: { x: 10, y: 10, w: 10, h: 10 }, measurements: { bone_level_mm: 4.25 } },
    { id: 'd4', class: 'widened_pdl', tooth: { number: 3 }, score: 0.5, bbox: { x: 0, y: 0, w: 5, h: 5 } },
  ],
};
const OVERJET_SUBMIT = { id: 'oj_5b1e8d7c3a2f4e6d8c90', status: 'processing' };
const OVERJET_RESULT = {
  id: 'oj_5b1e8d7c3a2f4e6d8c90', status: 'complete', radiograph_type: 'PA', width: 1000, height: 1000, quality_check: { passed: true },
  findings: [
    { finding_id: 11, type: 'Caries', tooth_number: '3', numbering: 'universal', surfaces: 'MO', confidence: 0.91, stage: 'enamel', outline: [[100, 200], [200, 200], [200, 260], [100, 260]] },
    { finding_id: 12, type: 'MarginDiscrepancy', tooth_number: '14', numbering: 'universal', surfaces: 'D', confidence: 0.58, outline: [[500, 500], [540, 540]] },
    { finding_id: 13, type: 'RCT', tooth_number: '30', confidence: 0.97, outline: [[0, 0], [10, 10]] },
  ],
};
const VIDEA_SUBMIT = { analysis_id: 'va_c0ffee1234567890abcd', state: 'queued' };
const VIDEA_RESULT = {
  analysis_id: 'va_c0ffee1234567890abcd', state: 'completed',
  images: [{ reference: 'REF', image_class: 'pan', findings: [
    { id: 1, type: 'CARIES', tooth: '36', tooth_numbering: 'FDI', surfaces: ['O', 'D'], probability: 0.8, region: { left: 0.1, top: 0.2, width: 0.05, height: 0.06 } },
    { id: 2, type: 'CALCULUS', tooth: '41', tooth_numbering: 'FDI', surfaces: [], probability: 0.62, region: { left: 0.5, top: 0.6, width: 0.04, height: 0.03 } },
    { id: 3, type: 'IMPACTED_TOOTH', tooth: '48', tooth_numbering: 'FDI', probability: 0.99, region: { left: 0.9, top: 0.7, width: 0.08, height: 0.1 } },
  ] }],
};

// A fetch that answers from a script of responses and remembers what was asked.
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('Pearl adapter: one call with the image only (no patient details); labelled boxes in pixels become our findings', async () => {
  const s = scripted([[200, PEARL_RESPONSE]]);
  const a = vendorAdapter(pearl, { base: 'https://pearl.example', key: 'pk_live', fetchImpl: s.fetchImpl });
  assert.equal(a.cleared, true);
  const out = await a.analyze({ data: png(), mime: 'image/png', ref: 'ref-1', tooth: '19' });
  const [{ url, init }] = s.calls;
  assert.equal(url, 'https://pearl.example/v1/second-opinion/analyze');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], 'pk_live');
  assert.equal(init.headers['Idempotency-Key'], 'ref-1');
  assert.equal(init.headers['X-Sandbox-Tooth'], undefined, 'nothing but the image goes to a real vendor');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['client_reference', 'image', 'include']);
  assert.equal(Buffer.from(body.image.data, 'base64').equals(png()), true);
  assert.equal(out.vendor_ref, 'pa_7f3c2a91d0e84b6c9a11');
  assert.equal(out.image_type, 'bitewing');
  assert.equal(out.quality, 'cone cut');
  const f = out.findings.map(normalize);
  assert.deepEqual(f.map((x) => [x.kind, x.tooth, x.surfaces, x.confidence]), [['caries', '19', 'D', 0.87], ['periapical', '30', null, 0.66], ['bone_loss', '18', null, 0.7], ['other', '3', null, 0.5]]);
  assert.deepEqual(f[0].box, [0.5, 0.5, 0.1, 0.1]);
  assert.equal(f[2].measurement_mm, 4.3);
  assert.match(f[0].note, /Pearl Second Opinion: progressed caries \(87%\)/);
  assert.match(f[3].note, /widened pdl/, 'an unknown label is kept in the note, not dropped');
});

test('Overjet adapter: posts the image, polls for the analysis, outlines become boxes', async () => {
  const s = scripted([[202, OVERJET_SUBMIT], [200, { id: OVERJET_SUBMIT.id, status: 'processing' }], [200, OVERJET_RESULT]]);
  const a = vendorAdapter(overjet, { base: 'https://oj.example/', key: 'oj_key', fetchImpl: s.fetchImpl, pollMs: 0 });
  const out = await a.analyze({ data: png(), mime: 'image/png', ref: 'ref-2' });
  assert.equal(s.calls[0].url, 'https://oj.example/v2/radiographs');
  assert.equal(s.calls[0].init.headers.Authorization, 'Bearer oj_key');
  assert.equal(s.calls[0].init.headers['Content-Type'], 'image/png');
  assert.ok(Buffer.from(s.calls[0].init.body).equals(png()));
  assert.equal(s.calls[1].url, `https://oj.example/v2/radiographs/${OVERJET_SUBMIT.id}/analysis`);
  assert.equal(s.calls.length, 3, 'polled until complete');
  assert.equal(out.image_type, 'periapical');
  const f = out.findings.map(normalize);
  assert.deepEqual(f.map((x) => [x.kind, x.tooth, x.surfaces]), [['caries', '3', 'MO'], ['open_margin', '14', 'D'], ['root_canal', '30', null]]);
  assert.deepEqual(f[0].box, [0.1, 0.2, 0.1, 0.06]);
  // A failed analysis is the image's problem; a refused key is the connection's.
  const bad = scripted([[202, OVERJET_SUBMIT], [200, { id: OVERJET_SUBMIT.id, status: 'failed', quality_check: { passed: false, reason: 'not a radiograph' } }]]);
  await assert.rejects(vendorAdapter(overjet, { key: 'k', fetchImpl: bad.fetchImpl, pollMs: 0 }).analyze({ data: png(), mime: 'image/png', ref: 'r' }), (e) => e instanceof VendorError && e.kind === 'image' && /not a radiograph/.test(e.message));
  const auth = scripted([[401, { error: 'invalid token' }]]);
  await assert.rejects(vendorAdapter(overjet, { key: 'k', fetchImpl: auth.fetchImpl }).analyze({ data: png(), mime: 'image/png', ref: 'r' }), (e) => e.kind === 'auth' && /key was refused/.test(e.message));
});

test('VideaHealth adapter: FDI tooth numbers become Universal; regions are fractions already', async () => {
  const result = { ...VIDEA_RESULT, images: [{ ...VIDEA_RESULT.images[0], reference: 'ref-3' }] };
  const s = scripted([[202, VIDEA_SUBMIT], [200, result]]);
  const out = await vendorAdapter(videahealth, { key: 'vk', fetchImpl: s.fetchImpl, pollMs: 0 }).analyze({ data: png(), mime: 'image/png', ref: 'ref-3' });
  assert.equal(s.calls[0].url, 'https://api.videa.ai/v1/analyses');
  assert.equal(JSON.parse(s.calls[0].init.body).images[0].reference, 'ref-3');
  assert.equal(s.calls[1].url, `https://api.videa.ai/v1/analyses/${VIDEA_SUBMIT.analysis_id}`);
  assert.equal(out.image_type, 'panoramic');
  assert.deepEqual(out.findings.map(normalize).map((x) => [x.kind, x.tooth, x.surfaces, x.confidence]), [['caries', '19', 'OD', 0.8], ['calculus', '25', null, 0.62], ['impacted', '32', null, 0.99]]);
  assert.deepEqual(out.findings[0].box, [0.1, 0.2, 0.05, 0.06]);
  assert.deepEqual([11, 18, 21, 28, 31, 38, 41, 48, 51, 55, 61, 65, 71, 75, 81, 85, 19, 99].map(fdiToUniversal), ['8', '1', '9', '16', '24', '17', '25', '32', 'E', 'A', 'F', 'J', 'O', 'K', 'P', 'T', null, null]);
});

test('engines: only FDA-cleared vendors (or their sandbox); a general-purpose model is refused', () => {
  const claude = createXrayAi({ config: { xrayAi: 'claude' } });
  assert.equal(claude.enabled, false);
  assert.match(claude.reason, /not validated/);
  assert.equal(createXrayAi({ config: { xrayAi: 'pearl' } }).enabled, false, 'no key, no reads');
  assert.equal(createXrayAi({ config: { xrayAi: 'pearl', xrayAiKey: 'k' } }).label, 'Pearl Second Opinion');
  assert.equal(createXrayAi({ config: { xrayAi: 'vendor', xrayAiName: 'Overjet', xrayAiUrl: 'https://x', xrayAiKey: 'k' } }).vendor, 'overjet');
  assert.equal(createXrayAi({ config: { xrayAi: 'vendor', xrayAiName: 'SomeModel', xrayAiUrl: 'https://x', xrayAiKey: 'k' } }).enabled, false);
  for (const v of ['pearl', 'overjet', 'videahealth']) {
    const sb = createXrayAi({ config: { xrayAi: 'sandbox', xrayAiSandboxVendor: v } });
    assert.equal(sb.vendor, v);
    assert.equal(sb.cleared, false, 'made-up findings are never presented as cleared');
    assert.match(sb.label, /sandbox/);
  }
});

test('sandbox: each vendor’s API played locally gives the same findings through its own parser', async () => {
  const got = {};
  for (const v of ['pearl', 'overjet', 'videahealth']) {
    const sb = createXrayAi({ config: { xrayAi: 'sandbox', xrayAiSandboxVendor: v } });
    got[v] = (await sb.analyze({ data: png(), mime: 'image/png', ref: 'r', tooth: '14' })).findings.map(normalize).map((f) => [f.kind, f.tooth, f.surfaces]);
  }
  assert.deepEqual(got.pearl, got.overjet);
  assert.deepEqual(got.pearl, got.videahealth);
  assert.deepEqual(got.pearl.slice(0, 3).map((f) => f.slice(0, 2)), [['caries', '14'], ['calculus', '15'], ['restoration', '16']]);
});

test('chart comparison: by tooth and surface, conditions, planned work and work done after the image', () => {
  const chart = {
    conditions: [{ id: 1, tooth: '19', surfaces: 'MO', condition: 'caries', resolved: 0 }, { id: 2, tooth: '3', surfaces: null, condition: 'crown', resolved: 0 }],
    procedures: [
      { id: 10, code: 'D2392', tooth: '30', surfaces: 'DO', status: 'planned' },
      { id: 11, code: 'D2391', tooth: '14', surfaces: 'O', status: 'completed', completed_at: '2026-01-10 10:00:00' },
      { id: 12, code: 'D4341', tooth: null, surfaces: null, status: 'planned' },
      { id: 13, code: 'D3330', tooth: '2', status: 'completed', completed_at: '2020-01-01' },
    ],
  };
  const cmp = (f) => compareWithChart({ confidence: 0.8, ...f }, chart, '2026-03-01');
  assert.equal(cmp({ kind: 'caries', tooth: '19', surfaces: 'O' }).status, 'charted', 'same tooth, overlapping surface');
  const miss = cmp({ kind: 'caries', tooth: '19', surfaces: 'D' });
  assert.equal(miss.status, 'not_charted', 'same tooth, other surface');
  assert.equal(miss.sentence, 'AI saw possible caries on #19 D; not charted');
  assert.equal(cmp({ kind: 'caries', tooth: '30', surfaces: 'D' }).matched.type, 'procedure', 'planned filling covers it');
  assert.equal(cmp({ kind: 'caries', tooth: '14', surfaces: 'O' }).status, 'not_charted', 'a filling done before the x-ray doesn’t treat caries seen after');
  assert.equal(cmp({ kind: 'caries', tooth: '20', surfaces: 'O' }).status, 'not_charted');
  assert.equal(cmp({ kind: 'crown', tooth: '3' }).status, 'charted');
  assert.equal(cmp({ kind: 'restoration', tooth: '14', surfaces: 'O' }).status, 'charted', 'existing work: the completed procedure counts whenever it was done');
  assert.equal(cmp({ kind: 'root_canal', tooth: '2' }).status, 'charted');
  assert.equal(cmp({ kind: 'root_canal', tooth: '31' }).sentence, 'AI saw an existing root canal on #31; not charted');
  assert.equal(cmp({ kind: 'calculus', tooth: '8' }).status, 'charted', 'scaling planned for the mouth');
  assert.equal(cmp({ kind: 'caries', tooth: null }).status, 'no_tooth');
  assert.equal(sentenceFor({ kind: 'bone_loss', tooth: '18', measurement_mm: 4.3 }, 'not_charted'), 'AI saw possible bone loss on #18 (4.3 mm); not charted');
});

// ---- Through the app, with the Pearl sandbox ----
const h = harness({ config: { xrayAi: 'sandbox' } });
const upload = async (hh, token, patient, extra = '', category = 'xray', level = 128) => (await fetch(`${hh.origin}/api/patients/${patient.id}/documents?category=${category}&filename=bw.png${extra}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: png(level),
})).json();
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};
const userWith = async (hh, api, role) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: `A ${role}`, role, password: 'a-long-enough-password' });
  const login = await hh.client().post('/auth/login', { email, password: 'a-long-enough-password' });
  return hh.client(login.data.token);
};

test('read → review list → accept charts it with the finding as the reason, audited; dismiss is recorded; undo voids', async () => {
  const { api, patient, token } = await h.practice();
  const status = (await api.get('/xray-ai')).data;
  assert.equal(status.enabled, true);
  assert.equal(status.vendor, 'pearl');
  assert.equal(status.disclaimer, 'AI suggestion — the dentist decides');
  const doc = await upload(h, token, patient, '&tooth=19');
  const found = await waitFor(async () => { const f = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings; return f.length ? f : null; });
  assert.ok(found.length >= 3, 'read on upload');
  assert.ok(found.every((f) => f.status === 'suggested' && f.disclaimer === 'AI suggestion — the dentist decides'));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tooth_conditions WHERE patient_id = ?', patient.id)).n, 0, 'nothing is charted automatically');
  const read = await h.db.get("SELECT * FROM audit_log WHERE action = 'xray_ai.read' AND entity_id = ?", doc.id);
  assert.equal(read.source, 'ai');
  assert.match(read.actor, /Pearl Second Opinion \(sandbox/);

  // Chart the calculus's tooth with a planned scaling so the list shows it as charted; the caries isn't.
  const caries = found.find((f) => f.kind === 'caries');
  const review = (await api.get(`/patients/${patient.id}/xray-review`)).data;
  const item = review.items.find((i) => i.id === caries.id);
  assert.equal(item.chart.status, 'not_charted');
  assert.equal(item.sentence, `AI saw possible caries on #19 ${caries.surfaces}; not charted`);
  assert.equal(review.counts.not_charted, review.items.filter((i) => i.chart.status === 'not_charted').length);
  const restoration = found.find((f) => f.kind === 'restoration');
  await api.post(`/patients/${patient.id}/conditions`, { tooth: restoration.tooth, surfaces: 'O', condition: 'filling' });
  assert.equal((await api.get(`/patients/${patient.id}/xray-review`)).data.items.find((i) => i.id === restoration.id).chart.status, 'charted');

  // Accept: charted with the link, and the audit trail says who, what and why.
  const accepted = (await api.patch(`/ai-findings/${caries.id}`, { status: 'accepted' })).data;
  assert.equal(accepted.status, 'accepted');
  const cond = await h.db.get('SELECT * FROM tooth_conditions WHERE id = ?', accepted.condition_id);
  assert.deepEqual([cond.tooth, cond.condition, cond.surfaces, cond.xray_finding_id], ['19', 'caries', caries.surfaces, caries.id]);
  assert.match(cond.notes, /AI finding \(sandbox\) confirmed by Admin/);
  const entry = await h.db.get("SELECT * FROM audit_log WHERE action = 'xray_ai.accepted' AND entity_id = ?", caries.id);
  assert.equal(entry.source, 'human');
  assert.equal(entry.patient_id, patient.id);
  assert.equal(JSON.parse(entry.changes).status[1], 'accepted');
  assert.equal(JSON.parse(entry.details).condition_id, cond.id);
  assert.match(entry.reason, /Dentist confirmed the AI x-ray finding/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'condition.create' AND entity_id = ?", cond.id));
  // A repeat (double click) charts nothing more.
  await api.patch(`/ai-findings/${caries.id}`, { status: 'accepted' });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tooth_conditions WHERE xray_finding_id = ?', caries.id)).n, 1);
  // Accepting what's already on the chart links it instead of charting it twice.
  const linked = (await api.patch(`/ai-findings/${restoration.id}`, { status: 'accepted' })).data;
  assert.equal((await h.db.get('SELECT xray_finding_id FROM tooth_conditions WHERE id = ?', linked.condition_id)).xray_finding_id, null);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tooth_conditions WHERE patient_id = ? AND voided_at IS NULL', patient.id)).n, 2);

  // Dismiss, with a reason: recorded.
  const calc = found.find((f) => f.kind === 'calculus');
  const dismissed = (await api.patch(`/ai-findings/${calc.id}`, { status: 'dismissed', reason: 'Burnout at the contact, not calculus' })).data;
  assert.equal(dismissed.status, 'rejected');
  assert.equal(dismissed.review_reason, 'Burnout at the contact, not calculus');
  const dEntry = await h.db.get("SELECT * FROM audit_log WHERE action = 'xray_ai.dismissed' AND entity_id = ?", calc.id);
  assert.equal(dEntry.reason, 'Burnout at the contact, not calculus');
  assert.equal((await api.patch(`/ai-findings/${calc.id}`, { status: 'maybe' })).status, 400);
  assert.ok(!(await api.get(`/patients/${patient.id}/xray-review`)).data.items.some((i) => i.id === calc.id || i.id === caries.id), 'decided findings leave the list');

  // Reading again replaces only suggestions nobody acted on, and doesn't ask again about decided ones.
  await api.post(`/documents/${doc.id}/ai-read`);
  const again = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings;
  assert.ok(again.some((f) => f.id === caries.id && f.status === 'accepted'));
  assert.equal(again.filter((f) => f.kind === 'caries').length, 1);
  assert.equal((await api.get('/xray-ai/stats')).data.find((s) => s.kind === 'caries').accepted, 1);
  const reads = (await api.get('/xray-ai/reads')).data;
  assert.deepEqual([reads.sent, reads.read, reads.failed], [2, 2, 0]);

  // Undo of an accept: back to suggested; the condition it charted is voided (kept), with the reason.
  const undone = (await api.patch(`/ai-findings/${caries.id}`, { status: 'suggested' })).data;
  assert.equal(undone.status, 'suggested');
  const voided = await h.db.get('SELECT * FROM tooth_conditions WHERE id = ?', cond.id);
  assert.ok(voided.voided_at);
  assert.match(voided.void_reason, /undo of accept/);

  // Photos aren't read.
  const photo = await upload(h, token, patient, '', 'photo');
  assert.equal((await api.post(`/documents/${photo.id}/ai-read`)).status, 400);
});

test('the AI can never chart: the assistant gets 428 without the person’s on-screen OK; with it, the person is the approver', async () => {
  const { api, patient, token } = await h.practice();
  const doc = await upload(h, token, patient, '&tooth=3');
  const found = await waitFor(async () => { const f = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings; return f.length ? f : null; });
  const caries = found.find((f) => f.kind === 'caries');
  const assistant = h.client(token, { 'X-Acting-For': 'assistant' });
  const refused = await assistant.patch(`/ai-findings/${caries.id}`, { status: 'accepted' });
  assert.equal(refused.status, 428);
  // Refused by the AI guard (HIGH_RISK) or, without that line, by the route's own requireHuman().
  assert.equal(refused.data.needs_approval ?? refused.data.details?.needs_approval, true);
  assert.equal((await assistant.patch(`/ai-findings/${caries.id}`, { status: 'dismissed' })).status, 428, 'dismissing is the dentist’s call too');
  assert.equal((await h.db.get('SELECT status FROM xray_findings WHERE id = ?', caries.id)).status, 'suggested');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tooth_conditions WHERE patient_id = ?', patient.id)).n, 0);
  // The assistant can still ask for a read (a suggestion only).
  assert.equal((await assistant.post(`/documents/${doc.id}/ai-read`)).status, 200);
  const again = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings.find((f) => f.kind === 'caries');
  const approvedRes = await h.client(token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }).patch(`/ai-findings/${again.id}`, { status: 'accepted' });
  assert.equal(approvedRes.status, 200);
  assert.equal(approvedRes.data.review_source, 'ai');
  assert.ok(approvedRes.data.approved_by);
  const entry = await h.db.get("SELECT * FROM audit_log WHERE action = 'xray_ai.accepted' AND entity_id = ?", again.id);
  assert.equal(entry.source, 'ai');
  assert.match(entry.actor, /approved by Admin/);
});

test('XR3: the chair screen and the treatment presentation show only findings the dentist accepted', async () => {
  const { api, patient, token, provider } = await h.practice();
  const doc = await upload(h, token, patient, '&tooth=19');
  const found = await waitFor(async () => { const f = (await api.get(`/documents/${doc.id}/ai-findings`)).data.findings; return f.length ? f : null; });
  const caries = found.find((f) => f.kind === 'caries');
  const calc = found.find((f) => f.kind === 'calculus');
  const empty = (await api.get(`/patients/${patient.id}/xray-chair`)).data;
  assert.deepEqual(empty.images, [], 'suggestions are never shown to the patient');
  await api.patch(`/ai-findings/${caries.id}`, { status: 'accepted' });
  await api.patch(`/ai-findings/${calc.id}`, { status: 'dismissed' });
  const chair = (await api.get(`/patients/${patient.id}/xray-chair`)).data;
  assert.equal(chair.images.length, 1);
  assert.deepEqual(chair.images[0].findings.map((f) => [f.id, f.label]), [[caries.id, 'A cavity (decay)']]);
  assert.equal(chair.images[0].findings[0].box.length, 4);
  assert.ok(!('confidence' in chair.images[0].findings[0]), 'the patient sees what the dentist confirmed, not the AI’s score');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'xray_ai.chair_view' AND entity_id = ?", patient.id));

  // The plan for tooth 19 carries the accepted finding onto the patient's plan link — nothing else.
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Fillings' })).data;
  const proc = await api.post(`/patients/${patient.id}/procedures`, { code: 'D2391', tooth: '19', surfaces: caries.surfaces, provider_id: provider.id, treatment_plan_id: plan.id });
  assert.equal(proc.status, 201, JSON.stringify(proc.data));
  const staffView = (await api.get(`/treatment-plans/${plan.id}/xray-findings`)).data;
  assert.deepEqual(staffView.map((f) => [f.kind, f.tooth]), [['caries', '19']]);
  const link = (await api.post(`/treatment-plans/${plan.id}/present`, { here: true })).data;
  const tpToken = link.url.split('/tp/')[1];
  const dobPass = (await h.client().post(`/public/tp/${tpToken}/verify`, { dob: '1985-04-12' })).data.pass;
  const pub = (await h.client(null, { 'X-Plan-Pass': dobPass }).get(`/public/tp/${tpToken}`)).data;
  assert.deepEqual(pub.xray_findings.map((f) => [f.kind, f.tooth, f.label]), [['caries', '19', 'A cavity (decay)']]);
  assert.ok(!('document_id' in pub.xray_findings[0]) && !('id' in pub.xray_findings[0]), 'no internal ids on a public link');
});

test('permissions and practice isolation', async () => {
  const a = await h.practice();
  const b = await h.practice();
  const doc = await upload(h, a.token, a.patient, '&tooth=19');
  const found = await waitFor(async () => { const f = (await a.api.get(`/documents/${doc.id}/ai-findings`)).data.findings; return f.length ? f : null; });
  const f = found[0];
  // Front desk can look (clinical:read) but can't read x-rays with the AI or decide; an assistant can't decide.
  const desk = await userWith(h, a.api, 'front_desk');
  assert.equal((await desk.get(`/patients/${a.patient.id}/xray-review`)).status, 200);
  assert.equal((await desk.post(`/documents/${doc.id}/ai-read`)).status, 403);
  assert.equal((await desk.patch(`/ai-findings/${f.id}`, { status: 'accepted' })).status, 403);
  assert.equal((await desk.post('/xray-review/second-look')).status, 403);
  const asst = await userWith(h, a.api, 'assistant');
  assert.equal((await asst.patch(`/ai-findings/${f.id}`, { status: 'accepted' })).status, 403, 'a diagnosis needs a dentist or hygienist (clinical:sign)');
  const hyg = await userWith(h, a.api, 'hygienist');
  assert.equal((await hyg.patch(`/ai-findings/${f.id}`, { status: 'dismissed' })).status, 200);
  assert.equal((await h.client().get(`/patients/${a.patient.id}/xray-review`)).status, 401);
  // Another practice sees none of it.
  assert.equal((await b.api.get(`/documents/${doc.id}/ai-findings`)).status, 404);
  assert.equal((await b.api.post(`/documents/${doc.id}/ai-read`)).status, 404);
  assert.equal((await b.api.patch(`/ai-findings/${found[1].id}`, { status: 'accepted' })).status, 404);
  assert.equal((await b.api.get(`/patients/${a.patient.id}/xray-review`)).status, 404);
  assert.equal((await b.api.get(`/patients/${a.patient.id}/xray-chair`)).status, 404);
  assert.equal((await b.api.get('/xray-review')).data.patients.length, 0);
  assert.equal((await h.db.get('SELECT status FROM xray_findings WHERE id = ?', found[1].id)).status, 'suggested');
});

// ---- A real vendor adapter against a fake Pearl: failures → Needs attention → resolved; the second look ----
let pearlDown = true;
const pearlSeen = [];
const fakePearl = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    pearlSeen.push({ url: req.url, headers: req.headers, body });
    if (pearlDown) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'maintenance' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'req-123' });
    res.end(JSON.stringify(PEARL_RESPONSE));
  });
});
await new Promise((r) => fakePearl.listen(0, r));
after(() => fakePearl.close());
const hp = harness({ config: { xrayAi: 'pearl', xrayAiKey: 'pk_test', xrayAiUrl: `http://127.0.0.1:${fakePearl.address().port}` } });

test('a vendor failure becomes a Needs attention item that resolves on the next read that works; calls are logged without PHI', async () => {
  const { api, patient, token } = await hp.practice();
  await api.put('/practice', { xray_ai_auto: false });
  const doc = await upload(hp, token, patient, '&tooth=19');
  const failed = await api.post(`/documents/${doc.id}/ai-read`);
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /Pearl Second Opinion: maintenance/);
  const issue = await hp.db.get("SELECT * FROM issues WHERE dedupe_key = 'xray-ai:vendor' AND status = 'open'");
  assert.ok(issue, 'raised');
  assert.equal(issue.kind, 'ai');
  assert.match(issue.title, /isn’t working/);
  await api.post(`/documents/${doc.id}/ai-read`);
  assert.equal((await hp.db.get("SELECT occurrences FROM issues WHERE id = ?", issue.id)).occurrences, 2, 'the same problem counts up');
  assert.equal((await hp.db.get('SELECT COUNT(*) AS n FROM xray_ai_reads WHERE document_id = ? AND ok = 0', doc.id)).n, 2);

  pearlDown = false;
  const ok = await api.post(`/documents/${doc.id}/ai-read`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.findings.map((f) => [f.kind, f.tooth]), [['caries', '19'], ['periapical', '30'], ['bone_loss', '18'], ['other', '3']]);
  assert.equal(ok.data.findings[0].cleared, 1, 'a cleared vendor’s finding says so');
  const closed = await hp.db.get('SELECT * FROM issues WHERE id = ?', issue.id);
  assert.equal(closed.status, 'resolved');
  // What went out: the image and a random reference — no name, birth date or our ids.
  const sent = pearlSeen.at(-1);
  assert.equal(sent.url, '/v1/second-opinion/analyze');
  assert.equal(sent.headers['x-api-key'], 'pk_test');
  assert.ok(!/Jane|Doe|1985-04-12/.test(sent.body));
  assert.ok(!sent.body.includes(`"${doc.id}"`) && !sent.body.includes(`"document_id"`));
  // Connection activity: host and path only.
  const logged = await hp.db.all("SELECT * FROM integration_log WHERE operation LIKE '%second-opinion%' ORDER BY id");
  assert.ok(logged.length >= 3);
  assert.deepEqual([logged[0].ok, logged.at(-1).ok, logged.at(-1).http_status, logged.at(-1).external_id], [0, 1, 200, 'req-123']);
  assert.ok(logged.every((l) => !/Jane|Doe/.test(`${l.operation}${l.error || ''}`)));

});

test('second look: today’s patients’ unread x-rays are read before the visit (automation, no charting), and a failure backs off', async () => {
  pearlDown = false;
  const { api, patient, token, provider } = await hp.practice();
  await api.put('/practice', { xray_ai_auto: false });
  const pid = (await hp.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  const other = (await api.post('/patients', { first_name: 'Not', last_name: 'Today', dob: '1990-01-01' })).data;
  const mine = await upload(hp, token, patient, '&tooth=19');
  const notToday = await upload(hp, token, other, '&tooth=19', 'xray', 90);
  const today = (await practiceNow(hp.db, pid)).slice(0, 10);
  await insert(hp.db, 'appointments', { practice_id: pid, patient_id: patient.id, provider_id: provider.id, start_time: `${today} 15:00`, end_time: `${today} 16:00`, status: 'scheduled' });
  // The day's review list shows the patient with an unread x-ray.
  let day = (await api.get(`/xray-review?date=${today}`)).data;
  assert.deepEqual(day.patients.map((p) => [p.patient_id, p.unread]), [[patient.id, 1]]);
  assert.equal((await api.get('/xray-review?date=2026-02-31')).status, 400);

  pearlDown = true;
  const first = await runSecondLook(hp.db, { practiceId: pid });
  assert.deepEqual(first, { read: 0, failed: 1 });
  assert.deepEqual(await runSecondLook(hp.db, { practiceId: pid }), { read: 0, failed: 0 }, 'a read that just failed waits for a later run');
  assert.ok(await hp.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = 'xray-ai:vendor' AND status = 'open'", pid));
  await hp.db.run("UPDATE xray_ai_reads SET created_at = '2000-01-01 00:00:00' WHERE document_id = ?", mine.id);

  pearlDown = false;
  const run = (await api.post('/xray-review/second-look')).data;
  assert.deepEqual(run, { read: 1, failed: 0 });
  assert.ok((await hp.db.get('SELECT ai_read_at FROM documents WHERE id = ?', mine.id)).ai_read_at);
  assert.equal((await hp.db.get('SELECT ai_read_at FROM documents WHERE id = ?', notToday.id)).ai_read_at, null, 'only today’s patients');
  assert.equal((await hp.db.get("SELECT read_for FROM xray_ai_reads WHERE document_id = ? AND ok = 1", mine.id)).read_for, 'second_look');
  assert.equal((await hp.db.get('SELECT COUNT(*) AS n FROM tooth_conditions WHERE patient_id = ?', patient.id)).n, 0, 'never charted automatically');
  assert.equal((await hp.db.get("SELECT status FROM issues WHERE practice_id = ? AND dedupe_key = 'xray-ai:vendor'", pid)).status, 'resolved');
  const entry = await hp.db.get("SELECT * FROM audit_log WHERE action = 'xray_ai.read' AND entity_id = ? ORDER BY id DESC", mine.id);
  assert.equal(entry.source, 'ai');
  assert.match(entry.reason, /second look/);
  day = (await api.get(`/xray-review?date=${today}`)).data;
  assert.equal(day.patients[0].unread, 0);
  assert.ok(day.patients[0].items.some((i) => i.sentence === 'AI saw possible caries on #19 D; not charted'));
});
