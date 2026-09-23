import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { harness } from './helpers.js';
import { localNow } from '../src/util.js';

const h = harness();

// A small transparent PNG with a stroke, like a finger signature.
function signaturePng() {
  const w = 40; const hgt = 12; const rows = [];
  for (let y = 0; y < hgt; y++) {
    const r = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) if (Math.abs(x / 3 - y) < 1) r.set([20, 20, 40, 255], 1 + x * 4);
    rows.push(r);
  }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); return Buffer.concat([len, Buffer.from(t), d, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const tokenOf = (url) => url.split('/f/')[1];

test('form templates: defaults, editing makes a new version, admins only', async () => {
  const { api } = await h.practice();
  const list = (await api.get('/form-templates')).data;
  assert.ok(list.length >= 6);
  const ext = list.find((t) => t.name === 'Consent for tooth extraction');
  assert.equal(ext.kind, 'consent');
  assert.equal(ext.version, 1);
  assert.ok(ext.fields.some((f) => f.type === 'signature' && f.required));
  assert.equal((await api.get('/form-templates')).data.length, list.length); // seeded once

  const edited = await api.put(`/form-templates/${ext.id}`, { fields: [...ext.fields, { type: 'yesno', label: 'Are you pregnant?' }] });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.version, 2);
  assert.equal((await api.put(`/form-templates/${ext.id}`, { auto_send: false })).data.version, 2);
  assert.equal((await api.put(`/form-templates/${ext.id}`, { fields: [{ type: 'select', label: 'Pick' }] })).status, 400);
  const created = await api.post('/form-templates', { name: 'Whitening consent', procedure_codes: 'd9972, x1', fields: [{ type: 'paragraph', text: 'Sensitivity is common.' }, { type: 'signature', label: 'Sign' }] });
  assert.equal(created.status, 201);
  assert.equal(created.data.procedure_codes, 'D9972');

  const email = `fd${Date.now()}@example.com`;
  await api.post('/users', { name: 'Front', email, password: 'correct-horse-battery', role: 'front_desk' });
  const fd = h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await fd.get('/form-templates')).status, 200);
  assert.equal((await fd.put(`/form-templates/${ext.id}`, { name: 'x' })).status, 403);
});

test('procedure consent: suggested, filled in, signed, filed as a PDF', async () => {
  const { api, patient, provider, token: staffToken } = await h.practice();
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '17', provider_id: provider.id })).data;
  const suggested = (await api.get(`/patients/${patient.id}/consents/suggest?procedure_ids=${proc.id}`)).data;
  assert.deepEqual(suggested.map((t) => t.name), ['Consent for tooth extraction']);

  const packet = await api.post(`/patients/${patient.id}/form-packets`, { template_ids: [suggested[0].id], procedure_ids: [proc.id], history: true });
  assert.equal(packet.status, 201, JSON.stringify(packet.data));
  const token = tokenOf(packet.data.url);
  const pub = h.client();
  const form = (await pub.get(`/public/forms/${token}`)).data;
  assert.equal(form.forms.length, 2);
  const consent = form.forms.find((f) => f.kind === 'custom');
  const intro = consent.fields.find((f) => f.type === 'paragraph').text;
  assert.match(intro, /#17/);
  assert.match(intro, /Dr\. Ann Lee/);

  const url = `/public/forms/${token}/${consent.id}`;
  assert.equal((await pub.post(url, { answers: {} })).status, 400);
  const keys = Object.fromEntries(consent.fields.filter((f) => f.key).map((f) => [f.type === 'signature' ? 'sig' : f.type, f.key]));
  const answers = {};
  for (const f of consent.fields.filter((x) => x.key)) {
    if (f.type === 'checkbox') answers[f.key] = true;
    if (f.type === 'yesno') answers[f.key] = 'no';
  }
  answers[keys.sig] = signaturePng();
  assert.equal((await pub.post(url, { answers })).status, 400); // typed name missing
  const ok = await pub.post(url, { answers, signature_name: 'Jane Doe' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await pub.post(url, { answers, signature_name: 'Jane Doe' })).status, 410);

  const forms = (await api.get(`/patients/${patient.id}/forms`)).data;
  const signed = forms.submissions.find((s) => s.kind === 'custom');
  assert.equal(signed.template_name, 'Consent for tooth extraction');
  assert.equal(signed.template_version, 1);
  assert.ok(signed.document_id);
  const docs = (await api.get(`/patients/${patient.id}/documents`)).data;
  const pdf = docs.find((d) => d.id === signed.document_id);
  assert.equal(pdf.category, 'consent');
  assert.equal(pdf.mime, 'application/pdf');
  const file = await fetch(`${h.origin}/api/documents/${pdf.id}/file`, { headers: { Authorization: `Bearer ${staffToken}` } });
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(bytes.toString('latin1'), /Consent for tooth extraction/);

  // The health history in the same packet still works, and then the link is used up.
  const history = await pub.post(`/public/forms/${token}`, { answers: { conditions: [], consent_hipaa: true, consent_treatment: true, allergies: 'None' }, signature_name: 'Jane Doe', signature_image: signaturePng() });
  assert.equal(history.status, 201, JSON.stringify(history.data));
  assert.equal((await pub.get(`/public/forms/${token}`)).status, 410);
});

test('insurance card photos are filed as images', async () => {
  const { api, patient } = await h.practice();
  const t = (await api.get('/form-templates')).data.find((x) => x.name === 'Insurance card and photo ID');
  const packet = (await api.post(`/patients/${patient.id}/form-packets`, { template_ids: [t.id] })).data;
  const token = tokenOf(packet.url);
  const form = (await h.client().get(`/public/forms/${token}`)).data.forms[0];
  const front = form.fields.find((f) => f.label === 'Insurance card — front').key;
  const sig = form.fields.find((f) => f.type === 'signature').key;
  const res = await h.client().post(`/public/forms/${token}/${form.id}`, { answers: { [front]: signaturePng(), [sig]: signaturePng() }, signature_name: 'Jane Doe' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const docs = (await api.get(`/patients/${patient.id}/documents`)).data;
  assert.ok(docs.some((d) => d.category === 'insurance_card' && d.mime === 'image/png'));
  assert.ok(docs.some((d) => d.mime === 'application/pdf'));
});

test('forms go out automatically before a visit, once', async () => {
  const { api, patient, provider } = await h.practice();
  await api.get('/form-templates');
  const tz = (await api.get('/practice')).data.timezone || 'America/New_York';
  const d = new Date(`${localNow(tz).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  const day = d.toISOString().slice(0, 10);
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '3', provider_id: provider.id })).data;
  const appt = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 09:00`, end_time: `${day} 10:00`, procedure_ids: [proc.id] });
  assert.equal(appt.status, 201, JSON.stringify(appt.data));

  const before = h.sent.length;
  await api.post('/messaging/run-reminders');
  const sent = h.sent.slice(before).filter((m) => /complete 3 forms/.test(m.body));
  assert.equal(sent.length, 1, JSON.stringify(h.sent.slice(before).map((m) => m.body)));
  const reqs = (await api.get(`/patients/${patient.id}/forms`)).data.requests;
  assert.deepEqual(reqs.map((r) => r.template_name).sort(), ['Consent for tooth extraction', 'Financial policy', 'HIPAA notice acknowledgment']);

  const again = h.sent.length;
  await api.post('/messaging/run-reminders');
  assert.equal(h.sent.slice(again).filter((m) => /forms/.test(m.body)).length, 0);
});
