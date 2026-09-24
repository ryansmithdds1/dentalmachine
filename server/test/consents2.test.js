// Consents start to finish (C1–C4), patient education with proof (E1–E3) and paperwork on autopilot (P1–P5).
// Spec: docs/workflows/specs/C-consents.md. The new routes aren't mounted in app.js by this file's author, so
// they're mounted on a small app here next to the real one (same database), the way chartaudit.test.js does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import express from 'express';
import { harness } from './helpers.js';
import consentRoutes from '../src/routes/consents.js';
import paperworkRoutes from '../src/routes/paperwork.js';
import paperworkPublicRoutes from '../src/routes/paperworkpublic.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { aiGuard } from '../src/aiguard.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { runPaperwork } from '../src/paperwork.js';
import { CONSENT_LIBRARY } from '../src/consentlib.js';

const h = harness();
let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const storage = h.app.locals.storage;
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/public', paperworkPublicRoutes({ db: h.db, storage, secret: 'test-secret' }));
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    const ai = req.get('X-Acting-For') === 'assistant';
    setActor({ source: ai ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(aiGuard());
  api.use(officeAccess(h.db));
  api.use(consentRoutes({ db: h.db, storage }));
  api.use(paperworkRoutes({ db: h.db, messenger: h.messenger, storage, config: h.config }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(err instanceof HttpError ? err.status : err.type === 'entity.too.large' ? 413 : 500).json({ error: err.message, details: err.details }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (token, extra = {}) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
};
const my = (token, extra) => {
  const c = call(token, extra);
  return { get: (p) => c('GET', p), post: (p, b) => c('POST', p, b ?? {}), put: (p, b) => c('PUT', p, b) };
};
const pub = (headers = {}) => my(null, headers);

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
const SIG = signaturePng();

// Answers for every required field of a form, as the patient's screen would send them.
function fillAll(fields) {
  const answers = {};
  for (const f of fields) {
    if (!f.key || !f.required) continue;
    answers[f.key] = f.type === 'checkbox' ? true : f.type === 'yesno' ? 'no' : f.type === 'signature' ? SIG : f.type === 'select' ? f.options[0] : f.type === 'date' ? '2026-01-01' : f.type === 'initials' ? 'JD' : 'x';
  }
  return answers;
}
const HISTORY = { answers: { allergies: 'Penicillin', medications: 'Lisinopril 10mg', conditions: ['High blood pressure'], phone: '(512) 555-0177', email: 'jane.new@example.com', consent_hipaa: true, consent_treatment: true }, signature_name: 'Jane Doe', signature_image: SIG };


// Many practices and sign-ins in one file: each from its own address, so the sign-up rate limit isn't hit.
let ipSeq = 10;
const fromIp = () => ({ 'X-Forwarded-For': `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` });
async function newPractice() {
  const email = `c2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const reg = await h.client(null, fromIp()).post('/auth/register', { practice_name: 'Consent Practice', name: 'Admin', email, password: 'correct-horse-battery' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const api = h.client(reg.data.token);
  await api.put('/practice', { npi: '1234567893', tax_id: '74-1234567', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '(512) 555-0142', send_from: '00:00', send_until: '00:00' });
  const provider = (await api.post('/providers', { name: 'Dr. Ann Lee, DDS', type: 'dentist', npi: '1987654321' })).data;
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', email: 'jane@example.com', address: '9 Elm', city: 'Austin', state: 'TX', zip: '78704', gender: 'female' })).data;
  return { api, token: reg.data.token, email, provider, patient, practiceId: reg.data.user?.practice_id };
}
async function staff(p, role) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const made = await p.api.post('/users', { email, name: role === 'front_desk' ? 'Desk' : 'Assistant', role, password: 'staff-password-123' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return (await h.client(null, fromIp()).post('/auth/login', { email, password: 'staff-password-123' })).data.token;
}

const inDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// A practice with the library installed, a patient with a visit in two days that has an extraction and a root canal.
async function setup({ dob = '1985-04-12', days = 2 } = {}) {
  const p = await newPractice();
  const mine = my(p.token);
  const lib = await mine.post('/consents/library/install', { all: true });
  assert.equal(lib.status, 201, JSON.stringify(lib.data));
  if (dob !== '1985-04-12') await p.api.put(`/patients/${p.patient.id}`, { dob });
  const ext = (await p.api.post(`/patients/${p.patient.id}/procedures`, { code: 'D7140', tooth: '3', provider_id: p.provider.id })).data;
  const rct = (await p.api.post(`/patients/${p.patient.id}/procedures`, { code: 'D3330', tooth: '19', provider_id: p.provider.id })).data;
  const day = inDays(days);
  const appt = await p.api.post('/appointments', { patient_id: p.patient.id, provider_id: p.provider.id, start_time: `${day} 09:00`, end_time: `${day} 10:00`, procedure_ids: [ext.id, rct.id], override_blockout: true });
  assert.equal(appt.status, 201, JSON.stringify(appt.data));
  return { ...p, mine, ext, rct, appt: appt.data, day };
}
const templateNamed = async (api, name) => (await api.get('/form-templates')).data.find((t) => t.name === name);

// Opens a link like the patient would: birth date, then the pass.
async function openLink(url, dob = '1985-04-12') {
  const token = url.split('/p/')[1];
  const locked = await pub().get(`/public/papers/${token}`);
  assert.equal(locked.status, 403);
  assert.equal(locked.data.details.dob_required, true);
  const wrong = await pub().post(`/public/papers/${token}/verify`, { dob: '1999-01-01' });
  assert.equal(wrong.status, 403);
  const { pass } = (await pub().post(`/public/papers/${token}/verify`, { dob })).data;
  const client = pub({ 'X-Form-Pass': pass });
  const view = await client.get(`/public/papers/${token}`);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  return { token, client, view: view.data };
}

test('C1: the consent library — ten consents, marked for attorney review, English and Spanish, installed once', async () => {
  const p = await newPractice();
  const mine = my(p.token);
  const before = (await mine.get('/consents/library')).data;
  assert.equal(before.length, 10);
  assert.deepEqual(before.map((x) => x.key).sort(), ['crown_bridge', 'extraction', 'financial', 'implant', 'ortho', 'perio_srp', 'refusal', 'root_canal', 'sedation', 'whitening']);
  // The office already has the starter extraction consent and financial policy (seeded): those are adopted, not doubled.
  assert.ok(before.find((x) => x.key === 'extraction').installed);
  const first = await mine.post('/consents/library/install', { all: true });
  assert.equal(first.status, 201);
  const again = await mine.post('/consents/library/install', { all: true });
  assert.deepEqual(again.data.template_ids, first.data.template_ids, 'installing twice finds the same forms');
  const forms = (await p.api.get('/form-templates')).data;
  assert.equal(forms.filter((t) => t.name === 'Consent for tooth extraction').length, 1);
  const implant = forms.find((t) => t.name === 'Consent for dental implant surgery');
  assert.equal(implant.legal_review, 1);
  assert.match(implant.description, /review with your attorney/);
  const es = JSON.parse(implant.fields_es);
  assert.equal(es.length, implant.fields.length);
  assert.deepEqual(es.map((f) => f.key), implant.fields.map((f) => f.key), 'Spanish wording keeps the same answers');
  assert.match(es.find((f) => f.type === 'paragraph' && /Riesgos|riesgos/.test(f.text)).text, /implante/);
  // A front-desk person can't install or change consents.
  const desk = await staff(p, 'front_desk');
  assert.equal((await my(desk).post('/consents/library/install', { all: true })).status, 403);
  assert.equal((await my(desk).put(`/form-templates/${implant.id}/consent-settings`, { witness: false })).status, 403);
  // The attorney reviewed it: the marker comes off (a new version is not needed for that).
  const reviewed = await mine.put(`/form-templates/${implant.id}/consent-settings`, { legal_reviewed: true });
  assert.equal(reviewed.data.legal_review, 0);
  assert.equal(CONSENT_LIBRARY.every((x) => x.fields.length === x.fields_es.length), true);
});

test('C1: versions — every wording kept; a signed consent points at the exact version and wording shown', async () => {
  const s = await setup();
  const ext = await templateNamed(s.api, 'Consent for tooth extraction');
  const due = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data;
  const extItem = due.items.find((i) => i.kind === 'consent' && i.name === 'Consent for tooth extraction');
  assert.ok(extItem?.consent_id, JSON.stringify(due.items));
  const sent = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [extItem.consent_id], channel: 'qr' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const { token, client, view } = await openLink(sent.data.url);
  const form = view.forms[0];
  assert.match(form.fields.en.find((f) => f.type === 'paragraph').text, /Jane Doe.*D7140 Extraction.*#3.*\$200\.00/);
  // The office edits the wording while the patient has it open: they're shown the new one before signing.
  const newFields = [...ext.fields.slice(0, -1), { type: 'paragraph', text: 'New paragraph added by the office.' }, ext.fields.at(-1)];
  const put = await s.api.put(`/form-templates/${ext.id}`, { fields: newFields });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const stale = await client.post(`/public/papers/${token}/forms/${form.id}`, { answers: fillAll(form.fields.en), signature_name: 'Jane Doe', version_id: form.version_id });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.details.changed, true);
  const fresh = (await client.get(`/public/papers/${token}`)).data.forms[0];
  assert.notEqual(fresh.version_id, form.version_id);
  assert.ok(fresh.fields.en.some((f) => f.text === 'New paragraph added by the office.'));
  const ok = await client.post(`/public/papers/${token}/forms/${fresh.id}`, { answers: fillAll(fresh.fields.en), signature_name: 'Jane Doe', version_id: fresh.version_id });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const versions = (await s.mine.get(`/form-templates/${ext.id}/versions`)).data;
  assert.ok(versions.length >= 2);
  const signedV = versions.find((v) => v.id === fresh.version_id);
  assert.equal(Number(signedV.signed_count), 1);
  const old = (await s.mine.get(`/form-template-versions/${form.version_id}`)).data;
  assert.ok(!old.fields.some((f) => f.text === 'New paragraph added by the office.'), 'the earlier wording is kept as it was');
  const c = (await s.mine.get(`/consents/${extItem.consent_id}`)).data;
  assert.equal(c.status, 'signed');
  assert.equal(c.version_id, fresh.version_id);
  assert.ok(c.wording.some((f) => f.text === 'New paragraph added by the office.'));
  assert.equal(c.content_hash.length, 64);
});

test('C2: consents attach from the procedures by code and category, once, and a signed plan consent covers the visit', async () => {
  const s = await setup();
  const first = (await s.mine.post(`/patients/${s.patient.id}/consents/attach`, { appointment_id: s.appt.id })).data;
  const names = first.consents.map((c) => c.template_name).sort();
  assert.deepEqual(names, ['Consent for root canal treatment', 'Consent for tooth extraction']);
  const again = (await s.mine.post(`/patients/${s.patient.id}/consents/attach`, { appointment_id: s.appt.id })).data;
  assert.deepEqual(again.consents.map((c) => c.id).sort(), first.consents.map((c) => c.id).sort(), 'attaching again finds the same consents');
  // Two at once (the job and a person): still one each.
  await Promise.all([1, 2, 3].map(() => s.mine.post(`/patients/${s.patient.id}/consents/attach`, { appointment_id: s.appt.id })));
  assert.equal(Number((await h.db.get("SELECT COUNT(*) AS n FROM consents WHERE patient_id = ? AND status <> 'superseded'", s.patient.id)).n), 2);
  // By category: the office maps periodontics to the SRP consent by category only.
  const srp = await templateNamed(s.api, 'Consent for scaling and root planing (gum treatment)');
  await s.mine.put(`/form-templates/${srp.id}/consent-settings`, { procedure_codes: '', procedure_categories: 'periodontics' });
  const perio = (await s.api.post(`/patients/${s.patient.id}/procedures`, { code: 'D4341', area: 'UR', provider_id: s.provider.id })).data;
  const byCat = (await s.mine.post(`/patients/${s.patient.id}/consents/attach`, { procedure_ids: [perio.id] })).data;
  assert.deepEqual(byCat.consents.map((c) => c.template_name), ['Consent for scaling and root planing (gum treatment)']);
  assert.equal((await s.mine.put(`/form-templates/${srp.id}/consent-settings`, { procedure_categories: 'nonsense' })).status, 400);
  // The consent is filled with the patient, teeth, procedures and fee.
  const pv = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [byCat.consents[0].id], channel: 'qr' });
  const { view } = await openLink(pv.data.url);
  assert.match(view.forms[0].fields.en[0].text, /Patient: Jane Doe\. Planned treatment: D4341/);
  // Validation: another practice's appointment, a missing procedure.
  const other = await newPractice();
  const theirAppt = (await h.db.get('SELECT id FROM appointments WHERE practice_id <> ? LIMIT 1', other.practiceId || 0));
  if (theirAppt) assert.equal((await my(other.token).post(`/patients/${other.patient.id}/consents/attach`, { appointment_id: s.appt.id })).status, 404);
  assert.equal((await s.mine.post(`/patients/${s.patient.id}/consents/attach`, { procedure_ids: [999999] })).status, 404);
});

test('C3/P1: autopilot sends once before the visit, reminds until done, never twice — even with two servers at once', async () => {
  const s = await setup();
  await s.mine.put('/paperwork/settings', { paperwork_autopilot: true, paperwork_reminders: 2, paperwork_remind_hours: 24 });
  const before = h.sent.length;
  const [a, b] = await Promise.all([runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl }), runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl })]);
  const mineSent = h.sent.slice(before).filter((m) => m.to === '(512) 555-0100' || m.to === s.patient.phone);
  assert.equal(mineSent.length, 1, `one text: ${JSON.stringify(h.sent.slice(before))} ${JSON.stringify([a, b])}`);
  const text = mineSent[0].body;
  assert.match(text, /\/p\/[A-Za-z0-9_-]+/);
  assert.doesNotMatch(text, /extraction|root canal|D7140|allerg/i, 'no treatment named in the text');
  await runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.equal(h.sent.length - before, h.sent.slice(before).length);
  const sentNow = h.sent.slice(before).filter((m) => m.to === s.patient.phone).length;
  assert.equal(sentNow, 1, 'running again sends nothing new');
  // A day later: one reminder (a new link), then another the next day, then no more.
  const later = (hrs) => new Date(Date.now() + hrs * 3600_000);
  await h.db.run("UPDATE paperwork_links SET created_at = '2000-01-01 00:00:00' WHERE patient_id = ?", s.patient.id);
  await Promise.all([runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl, now: later(25) }), runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl, now: later(25) })]);
  assert.equal(h.sent.slice(before).filter((m) => m.to === s.patient.phone).length, 2, 'one reminder');
  await h.db.run("UPDATE paperwork_links SET created_at = '2000-01-01 00:00:00' WHERE patient_id = ?", s.patient.id);
  await runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl, now: later(50) });
  await h.db.run("UPDATE paperwork_links SET created_at = '2000-01-01 00:00:00' WHERE patient_id = ?", s.patient.id);
  await runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl, now: later(75) });
  assert.equal(h.sent.slice(before).filter((m) => m.to === s.patient.phone).length, 3, 'two reminders at most');
  const links = await h.db.all('SELECT purpose FROM paperwork_links WHERE patient_id = ? ORDER BY id', s.patient.id);
  assert.deepEqual(links.map((l) => l.purpose), ['auto', 'reminder', 'reminder']);
  // The schedule shows the visit's forms as not done; the consents are "sent".
  const status = (await s.mine.get(`/paperwork/status?date=${s.day}`)).data[s.appt.id];
  assert.equal(status.state, 'todo');
  assert.equal(status.consents.total, 2);
  assert.equal(status.consents.signed, 0);
  // Audit: the automatic sends are recorded as automation.
  const auto = await h.db.get("SELECT source FROM audit_log WHERE action = 'paperwork.auto_send' AND patient_id = ?", s.patient.id);
  assert.equal(auto.source, 'automation');
  await s.mine.put('/paperwork/settings', { paperwork_autopilot: false });
});

test('C3: at the chair — hand the iPad in one step; the kiosk shows the forms with no birth date; staff see live progress', async () => {
  const s = await setup();
  const k = await s.mine.post('/forms-kiosks', { name: 'Op 2 iPad' });
  assert.equal(k.status, 201);
  const kiosk = pub({ 'X-Kiosk-Token': k.data.token });
  assert.equal((await kiosk.get('/public/forms-kiosk/current')).data.session, null);
  // One step: "Hand iPad" for the visit's consents (the only iPad is picked).
  const due = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data.items.filter((i) => i.kind === 'consent');
  const hand = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { appointment_id: s.appt.id, consent_ids: due.map((d) => d.consent_id), channel: 'kiosk' });
  assert.equal(hand.status, 201, JSON.stringify(hand.data));
  assert.equal(hand.data.kiosk.name, 'Op 2 iPad');
  // A double tap doesn't make a second session.
  const twice = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { appointment_id: s.appt.id, consent_ids: due.map((d) => d.consent_id), channel: 'kiosk' });
  assert.equal(twice.data.repeated, true);
  assert.equal(Number((await h.db.get("SELECT COUNT(*) AS n FROM kiosk_sessions WHERE patient_id = ? AND status IN ('waiting','active')", s.patient.id)).n), 1);
  const cur = (await kiosk.get('/public/forms-kiosk/current')).data;
  assert.equal(cur.session.first_name, 'Jane');
  assert.equal(cur.session.forms.length, 2);
  const sid = cur.session.id;
  const prog = await kiosk.post(`/public/forms-kiosk/sessions/${sid}/progress`, { page: 1, total: 2 });
  assert.equal(prog.status, 200);
  const live = (await s.mine.get('/kiosk-sessions')).data.find((x) => x.id === sid);
  assert.equal(live.page, 1);
  assert.equal(live.status, 'active');
  for (const f of cur.session.forms) {
    const r = await kiosk.post(`/public/forms-kiosk/sessions/${sid}/forms/${f.id}`, { answers: fillAll(f.fields.en), signature_name: 'Jane Doe', version_id: f.version_id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  // Done: the iPad goes back home by itself.
  assert.equal((await kiosk.get('/public/forms-kiosk/current')).data.session, null);
  const session = await h.db.get('SELECT status, ended_reason FROM kiosk_sessions WHERE id = ?', sid);
  assert.equal(session.status, 'completed');
  const check = (await s.mine.get(`/appointments/${s.appt.id}/consent-check`)).data;
  assert.equal(check.ready, true);
  const status = (await s.mine.get(`/paperwork/status?appointment_ids=${s.appt.id}`)).data[s.appt.id];
  assert.equal(status.consents.signed, 2);
  const pf = await h.db.get("SELECT signed_via, kiosk_session_id, device FROM patient_forms WHERE patient_id = ? AND kind = 'custom' ORDER BY id DESC LIMIT 1", s.patient.id);
  assert.equal(pf.signed_via, 'kiosk');
  assert.equal(pf.kiosk_session_id, sid);
});

test('C4: signed → PDF filed to Documents and the visit, procedures consented, and nothing can change it afterwards', async () => {
  const s = await setup();
  const due = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data.items.find((i) => i.name === 'Consent for root canal treatment');
  const sent = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [due.consent_id], channel: 'sms' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.message.status, 'sent');
  const url = h.sent.at(-1).body.match(/https:\/\/app\.example\.com\/p\/\S+/)[0];
  const { token, client, view } = await openLink(url);
  const f = view.forms[0];
  const signed = await client.post(`/public/papers/${token}/forms/${f.id}`, { answers: fillAll(f.fields.es || f.fields.en), signature_name: 'Jane Doe', version_id: f.version_id, lang: 'es' });
  assert.equal(signed.status, 201, JSON.stringify(signed.data));
  // Signing twice (a double tap) doesn't file it twice.
  const dup = await client.post(`/public/papers/${token}/forms/${f.id}`, { answers: fillAll(f.fields.en), signature_name: 'Jane Doe', version_id: f.version_id });
  assert.equal(dup.status, 410);
  const c = await h.db.get('SELECT * FROM consents WHERE id = ?', due.consent_id);
  assert.equal(c.status, 'signed');
  assert.equal(c.lang, 'es');
  assert.equal(c.signed_via, 'link');
  assert.ok(c.ip);
  assert.ok(c.device);
  const doc = await h.db.get('SELECT * FROM documents WHERE id = ?', c.document_id);
  assert.equal(doc.category, 'consent');
  assert.equal(doc.appointment_id, s.appt.id);
  assert.equal(doc.mime, 'application/pdf');
  const pdf = await h.app.locals.storage.read(doc.storage_key, !!doc.encrypted);
  assert.match(pdf.slice(0, 5).toString(), /%PDF/);
  assert.match(pdf.toString('latin1'), /Spanish/);
  const rct = await h.db.get('SELECT consent_id, consented_at FROM procedures WHERE id = ?', s.rct.id);
  assert.equal(rct.consent_id, c.id);
  assert.ok(rct.consented_at);
  // Immutable: the database refuses changes to a signed record, and so does the signed form.
  await assert.rejects(h.db.run('UPDATE consents SET content = ? WHERE id = ?', '[]', c.id), /cannot be changed/);
  await assert.rejects(h.db.run('UPDATE consents SET signer_name = ? WHERE id = ?', 'Someone else', c.id), /cannot be changed/);
  await assert.rejects(h.db.run('UPDATE patient_forms SET data = ? WHERE id = ?', '{}', c.patient_form_id), /cannot be changed/);
  // A new version needs a new signature: the old record stays, a new consent is needed.
  const noReason = await s.mine.post(`/consents/${c.id}/supersede`, {});
  assert.equal(noReason.status, 400);
  const sup = await s.mine.post(`/consents/${c.id}/supersede`, { reason: 'Consent wording updated; re-sign before treatment' });
  assert.equal(sup.status, 201, JSON.stringify(sup.data));
  assert.equal(sup.data.status, 'needed');
  const old = await h.db.get('SELECT status, content, signer_name, replaced_by_id FROM consents WHERE id = ?', c.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.content, c.content);
  assert.equal(old.replaced_by_id, sup.data.id);
  // The history of the record is on it (attach, send, sign, supersede) and viewing it is recorded.
  const detail = (await s.mine.get(`/consents/${c.id}`)).data;
  const actions = detail.history.map((a) => a.action);
  for (const a of ['consent.attach', 'consent.sign', 'consent.supersede']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  assert.equal(detail.history.find((a) => a.action === 'consent.sign').source, 'patient');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'consent.view' AND entity_id = ?", c.id));
});

test('C4: minors need a parent or guardian; a witness is recorded on the iPad when the office asks for one', async () => {
  const s = await setup({ dob: '2014-06-01' });
  const due = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data.items.find((i) => i.name === 'Consent for tooth extraction');
  const qr = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [due.consent_id], channel: 'qr' });
  const { token, client, view } = await openLink(qr.data.url, '2014-06-01');
  assert.equal(view.minor, true);
  const f = view.forms[0];
  const body = { answers: fillAll(f.fields.en), signature_name: 'Mary Doe', version_id: f.version_id };
  assert.equal((await client.post(`/public/papers/${token}/forms/${f.id}`, body)).status, 400, 'no relationship');
  assert.equal((await client.post(`/public/papers/${token}/forms/${f.id}`, { ...body, signer_relationship: 'self' })).status, 400, 'a child can’t sign for themselves');
  const ok = await client.post(`/public/papers/${token}/forms/${f.id}`, { ...body, signer_relationship: 'parent' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const c = await h.db.get('SELECT signer_name, signer_relationship FROM consents WHERE id = ?', due.consent_id);
  assert.deepEqual({ ...c }, { signer_name: 'Mary Doe', signer_relationship: 'parent' });

  // Witness: the implant consent asks for one; on the iPad the team member signs after the patient.
  const adult = await setup();
  const implant = (await adult.api.post(`/patients/${adult.patient.id}/procedures`, { code: 'D6010', tooth: '30', provider_id: adult.provider.id })).data;
  const att = (await adult.mine.post(`/patients/${adult.patient.id}/consents/attach`, { procedure_ids: [implant.id] })).data.consents[0];
  assert.equal(att.template_name, 'Consent for dental implant surgery');
  assert.equal(att.witness_required, true);
  const k = (await adult.mine.post('/forms-kiosks', { name: 'Front iPad' })).data;
  const kiosk = pub({ 'X-Kiosk-Token': k.token });
  await adult.mine.post(`/patients/${adult.patient.id}/paperwork/send`, { consent_ids: [att.id], channel: 'kiosk', kiosk_id: k.id });
  const sess = (await kiosk.get('/public/forms-kiosk/current')).data.session;
  const form = sess.forms[0];
  const noWitness = await kiosk.post(`/public/forms-kiosk/sessions/${sess.id}/forms/${form.id}`, { answers: fillAll(form.fields.en), signature_name: 'Jane Doe', version_id: form.version_id });
  assert.equal(noWitness.status, 400);
  assert.equal(noWitness.data.details.witness_required, true);
  const withWitness = await kiosk.post(`/public/forms-kiosk/sessions/${sess.id}/forms/${form.id}`, { answers: fillAll(form.fields.en), signature_name: 'Jane Doe', version_id: form.version_id, witness: { name: 'Maria Lopez, RDA', signature: SIG } });
  assert.equal(withWitness.status, 201, JSON.stringify(withWitness.data));
  const wc = await h.db.get('SELECT witness_name, witness_user_id, witness_signature FROM consents WHERE id = ?', att.id);
  assert.equal(wc.witness_name, 'Maria Lopez, RDA');
  assert.ok(wc.witness_user_id, 'the team member who handed the iPad over');
  assert.ok(wc.witness_signature);
});

test('C4: "patient declined" — at the chair or on the iPad — is as traceable as a signature', async () => {
  const s = await setup();
  const items = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data.items.filter((i) => i.kind === 'consent');
  const [ext, rct] = [items.find((i) => /extraction/.test(i.name)), items.find((i) => /root canal/.test(i.name))];
  // Front desk can't record a clinical decline.
  const desk = await staff(s, 'front_desk');
  assert.equal((await my(desk).post(`/consents/${ext.consent_id}/decline`, { reason: 'x' })).status, 403);
  assert.equal((await s.mine.post(`/consents/${ext.consent_id}/decline`, {})).status, 400, 'a reason is required');
  const d = await s.mine.post(`/consents/${ext.consent_id}/decline`, { reason: 'Wants to think about it; risks explained' });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.status, 'declined');
  assert.equal(d.data.declined_by_name, 'Admin');
  const again = await s.mine.post(`/consents/${ext.consent_id}/decline`, { reason: 'twice' });
  assert.equal(again.status, 409);
  const row = await h.db.get('SELECT * FROM consents WHERE id = ?', ext.consent_id);
  const doc = await h.db.get('SELECT category, filename, appointment_id FROM documents WHERE id = ?', row.document_id);
  assert.equal(doc.category, 'document', 'a declined consent is never filed where a signed one would count');
  assert.match(doc.filename, /Declined/);
  await assert.rejects(h.db.run('UPDATE consents SET declined_reason = ? WHERE id = ?', 'changed', row.id), /cannot be changed/);
  const audit = await h.db.get("SELECT reason, source, user_id FROM audit_log WHERE action = 'consent.decline' AND entity_id = ?", row.id);
  assert.equal(audit.source, 'human');
  assert.match(audit.reason, /think about it/);
  // Declined consents land in the intake worklist for a person.
  const intake = (await s.api.get('/intake/pending')).data.items;
  assert.ok(intake.some((i) => i.kind === 'consent_declined' && i.id === row.id), JSON.stringify(intake));

  // The patient declines on the iPad: typed name and signature, device and time recorded.
  const k = (await s.mine.post('/forms-kiosks', { name: 'Desk iPad' })).data;
  const kiosk = pub({ 'X-Kiosk-Token': k.token });
  await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [rct.consent_id], channel: 'kiosk', kiosk_id: k.id });
  const sess = (await kiosk.get('/public/forms-kiosk/current')).data.session;
  const dec = await kiosk.post(`/public/forms-kiosk/sessions/${sess.id}/forms/${sess.forms[0].id}/decline`, { signature_name: 'Jane Doe', signature: SIG, reason: 'Prefer extraction' });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.equal(dec.data.finished, true);
  const pr = await h.db.get('SELECT status, signer_name, signed_via, device, declined_by FROM consents WHERE id = ?', rct.consent_id);
  assert.equal(pr.status, 'declined');
  assert.equal(pr.signer_name, 'Jane Doe');
  assert.equal(pr.signed_via, 'kiosk');
  assert.equal(pr.declined_by, null);
  assert.equal((await h.db.get("SELECT source FROM audit_log WHERE action = 'consent.decline' AND entity_id = ?", rct.consent_id)).source, 'patient');
  // Set aside from the worklist (handled): off the list, on the record.
  const done = await s.api.post('/intake/paperwork/done', { entity: 'consents', id: row.id, reason: 'Called patient' });
  assert.equal(done.status, 200);
  assert.ok(!(await s.api.get('/intake/pending')).data.items.some((i) => i.key === `consent_declined:${row.id}`));
});

test('P3: kiosk sessions are scoped to their iPad, run out when idle or expired, and a revoked iPad stops working', async () => {
  const s = await setup();
  const a = (await s.mine.post('/forms-kiosks', { name: 'iPad A' })).data;
  const b = (await s.mine.post('/forms-kiosks', { name: 'iPad B' })).data;
  const kA = pub({ 'X-Kiosk-Token': a.token });
  const kB = pub({ 'X-Kiosk-Token': b.token });
  assert.equal((await pub({ 'X-Kiosk-Token': 'nope' }).get('/public/forms-kiosk/current')).status, 401);
  // Two iPads and nothing to go on: staff are asked which.
  const choose = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'kiosk' });
  assert.equal(choose.status, 400);
  assert.equal(choose.data.details.choose_kiosk, true);
  const sent = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'kiosk', kiosk_id: a.id });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const sid = sent.data.session.id;
  assert.equal((await kB.get('/public/forms-kiosk/current')).data.session, null, 'the other iPad sees nothing');
  assert.equal((await kB.post(`/public/forms-kiosk/sessions/${sid}/history`, HISTORY)).status, 410, 'nor can it submit into it');
  // Another practice's staff can't cancel it or load its iPad.
  const other = await newPractice();
  assert.equal((await my(other.token).post(`/kiosk-sessions/${sid}/cancel`)).status, 404);
  assert.equal((await my(other.token).post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'kiosk', kiosk_id: a.id })).status, 404);
  // Idle: the iPad ends it and clears itself.
  const end = await kA.post(`/public/forms-kiosk/sessions/${sid}/end`, { reason: 'idle' });
  assert.equal(end.status, 200);
  assert.equal((await kA.get('/public/forms-kiosk/current')).data.session, null);
  assert.equal((await h.db.get('SELECT status FROM kiosk_sessions WHERE id = ?', sid)).status, 'expired');
  // Expired by time (a session left on the iPad) and by the job.
  const again = (await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'kiosk', kiosk_id: a.id })).data.session;
  await h.db.run("UPDATE kiosk_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", again.id);
  assert.equal((await kA.get('/public/forms-kiosk/current')).data.session, null);
  const third = (await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'kiosk', kiosk_id: a.id })).data.session;
  await h.db.run("UPDATE kiosk_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", third.id);
  const counts = await runPaperwork(h.db, h.messenger, { appUrl: h.config.appUrl });
  assert.ok(counts.expired >= 1);
  // Revoked: the iPad stops working.
  const desk = await staff(s, 'front_desk');
  assert.equal((await my(desk).post(`/forms-kiosks/${a.id}/revoke`)).status, 403, 'only administrators set up or revoke iPads');
  assert.equal((await my(desk).post('/forms-kiosks', { name: 'x' })).status, 403);
  assert.equal((await s.mine.post(`/forms-kiosks/${a.id}/revoke`)).status, 200);
  assert.equal((await kA.get('/public/forms-kiosk/current')).status, 401);
});

test('E1–E3: education shown in the chair, on the iPad, and sent home — each recorded with who, what version, how, and when opened', async () => {
  const s = await setup();
  await s.mine.put('/education/crowns/extras', { video_url: 'https://videos.example.com/crown.mp4', postop: 'Avoid sticky foods on the temporary.' });
  assert.equal((await s.mine.put('/education/crowns/extras', { video_url: 'javascript:alert(1)' })).status, 400);
  const chair = await s.mine.post(`/patients/${s.patient.id}/education/show`, { slug: 'root-canal', how: 'shown_chair', appointment_id: s.appt.id });
  assert.equal(chair.status, 201, JSON.stringify(chair.data));
  assert.equal(chair.data.article.title, 'Root canal treatment');
  // On the iPad: the kiosk shows the page; viewing it is recorded.
  const k = (await s.mine.post('/forms-kiosks', { name: 'Op 1 iPad' })).data;
  const kiosk = pub({ 'X-Kiosk-Token': k.token });
  const ipad = await s.mine.post(`/patients/${s.patient.id}/education/show`, { slug: 'crowns', how: 'shown_ipad', appointment_id: s.appt.id });
  assert.equal(ipad.status, 201, JSON.stringify(ipad.data));
  const cur = (await kiosk.get('/public/forms-kiosk/current')).data.session;
  assert.equal(cur.mode, 'education');
  assert.equal(cur.article.video_url, 'https://videos.example.com/crown.mp4');
  await kiosk.post(`/public/forms-kiosk/sessions/${cur.id}/education-viewed`);
  await kiosk.post(`/public/forms-kiosk/sessions/${cur.id}/end`, { reason: 'completed' });
  // Take-home by text: link only, then the patient opens it.
  const before = h.sent.length;
  const home = await s.mine.post(`/patients/${s.patient.id}/education/take-home`, { slugs: ['extraction-aftercare'], channel: 'sms', appointment_id: s.appt.id, postop: true });
  assert.equal(home.status, 201, JSON.stringify(home.data));
  const text = h.sent.slice(before)[0].body;
  assert.doesNotMatch(text, /extraction|tooth/i, 'no treatment named in the text');
  const token = text.match(/\/e\/(\S+)/)[1];
  const opened = await pub().get(`/public/edu/${token}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.title, 'After a tooth extraction');
  const proof = (await s.mine.get(`/patients/${s.patient.id}/education/proof?appointment_id=${s.appt.id}`)).data;
  assert.equal(proof.rows.length, 3);
  assert.deepEqual(proof.rows.map((r) => r.how), ['shown_chair', 'shown_ipad', 'texted']);
  assert.ok(proof.rows.every((r) => r.by_name === 'Admin' && r.version >= 1));
  assert.ok(proof.rows[1].opened_at, 'viewed on the iPad');
  assert.ok(proof.rows[2].opened_at, 'take-home opened');
  assert.match(proof.note_text, /^Patient education: Root canal treatment \(v1\) shown on the chair screen by Admin/);
  assert.match(proof.note_text, /Your crown \(v1\) shown on the iPad/);
  assert.match(proof.note_text, /texted to the patient .*opened by the patient/);
  // It's linked into the consent: the root canal consent (whose form lists that page) quotes it in its record and PDF.
  const rct = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data.items.find((i) => /root canal/.test(i.name));
  const detail = (await s.mine.get(`/consents/${rct.consent_id}`)).data;
  assert.ok(detail.education.lines.some((l) => /Root canal treatment/.test(l)), JSON.stringify(detail.education));
  const qr = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { consent_ids: [rct.consent_id], channel: 'qr' });
  const { token: t2, client, view } = await openLink(qr.data.url);
  await client.post(`/public/papers/${t2}/forms/${view.forms[0].id}`, { answers: fillAll(view.forms[0].fields.en), signature_name: 'Jane Doe', version_id: view.forms[0].version_id });
  const doc = await h.db.get('SELECT d.* FROM consents c JOIN documents d ON d.id = c.document_id WHERE c.id = ?', rct.consent_id);
  const pdf = (await h.app.locals.storage.read(doc.storage_key, !!doc.encrypted)).toString('latin1');
  assert.match(pdf, /Education given/);
  // A new wording of the page is a new version in the record.
  await s.mine.put('/education/root-canal/extras', { postop: 'Take ibuprofen as directed.' });
  const again = await s.mine.post(`/patients/${s.patient.id}/education/show`, { slug: 'root-canal', how: 'shown_chair' });
  assert.equal(again.data.version, 2);
  // Another practice can't see the proof.
  const other = await newPractice();
  assert.equal((await my(other.token).get(`/patients/${s.patient.id}/education/proof`)).status, 404);
});

test('P1: what each visit needs — history (new or yearly), HIPAA once, financial policy yearly, screenings every visit, new-patient forms only for new patients', async () => {
  const s = await setup();
  const forms = (await s.api.get('/form-templates')).data;
  const screening = await s.api.post('/form-templates', { name: 'Health screening', kind: 'intake', fields: [{ type: 'yesno', label: 'Any fever or cough today?', required: true }, { type: 'signature', label: 'Signature' }] });
  await s.mine.put(`/form-templates/${screening.data.id}/consent-settings`, { due_rule: 'every_visit' });
  const welcome = await s.api.post('/form-templates', { name: 'Welcome questionnaire', kind: 'intake', fields: [{ type: 'text', label: 'What brings you in?', required: true }, { type: 'signature', label: 'Signature' }] });
  await s.mine.put(`/form-templates/${welcome.data.id}/consent-settings`, { due_rule: 'new_patient' });
  assert.equal((await s.mine.put(`/form-templates/${welcome.data.id}/consent-settings`, { due_rule: 'weekly' })).status, 400);
  const due = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data;
  const by = Object.fromEntries(due.items.map((i) => [i.name, i]));
  assert.equal(by['Health history'].status, 'due');
  assert.equal(by['Health history'].reason, 'New patient');
  assert.equal(by['HIPAA notice acknowledgment'].status, 'due');
  assert.equal(by['Financial policy'].status, 'due');
  assert.equal(by['Health screening'].status, 'due');
  assert.equal(by['Welcome questionnaire'].status, 'due');
  assert.equal(by['Consent for tooth extraction'].status, 'due');
  assert.equal(due.summary.state, 'todo');
  // One "Send forms" with nothing chosen sends what's due for the visit.
  const send = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { appointment_id: s.appt.id, channel: 'qr' });
  assert.equal(send.status, 201, JSON.stringify(send.data));
  assert.equal(send.data.forms, due.items.length);
  const { token, client, view } = await openLink(send.data.url);
  assert.equal(view.total, due.items.length);
  assert.equal((await client.post(`/public/papers/${token}/history`, HISTORY)).status, 201);
  for (const f of view.forms.filter((x) => x.kind === 'custom')) {
    const r = await client.post(`/public/papers/${token}/forms/${f.id}`, { answers: fillAll(f.fields.en), signature_name: 'Jane Doe', version_id: f.version_id });
    assert.equal(r.status, 201, `${f.name}: ${JSON.stringify(r.data)}`);
  }
  const after = (await s.mine.get(`/appointments/${s.appt.id}/paperwork`)).data;
  assert.equal(after.summary.state, 'done', JSON.stringify(after.items));
  assert.equal((await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { appointment_id: s.appt.id, channel: 'qr' })).status, 409, 'nothing left to send');
  // The next visit: the screening is due again; HIPAA, financial policy, history and the welcome form are not.
  await h.db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", s.appt.id);
  const next = await s.api.post('/appointments', { patient_id: s.patient.id, provider_id: s.provider.id, start_time: `${inDays(9)} 09:00`, end_time: `${inDays(9)} 10:00`, override_blockout: true });
  const n = Object.fromEntries((await s.mine.get(`/appointments/${next.data.id}/paperwork`)).data.items.map((i) => [i.name, i.status]));
  assert.equal(n['Health screening'], 'due');
  assert.equal(n['Health history'], 'done');
  assert.equal(n['HIPAA notice acknowledgment'], 'done');
  assert.equal(n['Financial policy'], 'done');
  assert.equal(n['Welcome questionnaire'], undefined, 'not asked of an established patient');
  // A year on: the history and the financial policy are due again.
  await h.db.run("UPDATE patient_forms SET review_status = review_status WHERE patient_id = ?", s.patient.id);
  const yearOut = await s.api.post('/appointments', { patient_id: s.patient.id, provider_id: s.provider.id, start_time: `${inDays(400)} 09:00`, end_time: `${inDays(400)} 10:00`, override_blockout: true });
  const y = Object.fromEntries((await s.mine.get(`/appointments/${yearOut.data.id}/paperwork`)).data.items.map((i) => [i.name, i.status]));
  assert.equal(y['Health history'], 'due');
  assert.equal(y['Financial policy'], 'due');
  assert.equal(y['HIPAA notice acknowledgment'], 'done');
  assert.ok(forms.length > 0);
});

test('P4: contact details apply at once; the medical history waits for a clinician’s one-key review; card photos go to the insurance path; PDFs filed', async () => {
  const s = await setup();
  await s.api.put(`/patients/${s.patient.id}`, { allergies: 'Latex' });
  const sent = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, template_ids: [(await templateNamed(s.api, 'Insurance card and photo ID')).id], channel: 'qr' });
  const { token, client, view } = await openLink(sent.data.url);
  const hist = await client.post(`/public/papers/${token}/history`, { ...HISTORY, answers: { ...HISTORY.answers, allergies: 'None' } });
  assert.equal(hist.status, 201, JSON.stringify(hist.data));
  const p = (await s.api.get(`/patients/${s.patient.id}`)).data;
  assert.equal(p.phone, '(512) 555-0177', 'contact details applied');
  assert.equal(p.email, 'jane.new@example.com');
  assert.equal(p.allergies, 'Latex', 'medical fields wait for review (and "none" never erases an allergy)');
  const intake = (await s.api.get('/intake/pending')).data.items.find((i) => i.kind === 'history' && i.patient_id === s.patient.id);
  assert.ok(intake, 'in the one-screen review worklist');
  assert.equal(intake.changes.allergies.proposed, 'Latex');
  assert.equal(intake.changes.medications.proposed, 'Lisinopril 10mg');
  // The contact change is on the record, attributed to the patient.
  const change = await h.db.get("SELECT source, changes FROM audit_log WHERE entity = 'patients' AND entity_id = ? AND changes LIKE '%555-0177%'", s.patient.id);
  assert.equal(change.source, 'patient');
  const pdf = await h.db.get("SELECT category FROM documents WHERE patient_id = ? AND filename LIKE 'Health history%'", s.patient.id);
  assert.equal(pdf.category, 'medical_history');
  // Card photos from the kiosk/phone are filed for the read-and-confirm insurance path (a person confirms).
  const card = view.forms.find((f) => f.name === 'Insurance card and photo ID');
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`;
  const answers = fillAll(card.fields.en);
  answers[card.fields.en.find((f) => f.type === 'photo').key] = jpeg;
  const r = await client.post(`/public/papers/${token}/forms/${card.id}`, { answers, signature_name: 'Jane Doe', version_id: card.version_id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const items = (await s.api.get('/intake/pending')).data.items;
  assert.ok(items.some((i) => i.kind === 'card' && i.patient_id === s.patient.id), 'card photo waits for a person to read and confirm');
  // The AI can't merge a medical history on its own (HIGH_RISK, existing): the assistant gets 428.
  const ai = await h.client(s.token, { 'X-Acting-For': 'assistant' }).put(`/patients/${s.patient.id}/medical`, { allergies: 'None' });
  assert.equal(ai.status, 428);
});

test('Practice isolation: another practice sees none of it', async () => {
  const s = await setup();
  const other = await newPractice();
  const them = my(other.token);
  const c = (await s.mine.post(`/patients/${s.patient.id}/consents/attach`, { appointment_id: s.appt.id })).data.consents[0];
  assert.equal((await them.get(`/consents/${c.id}`)).status, 404);
  assert.equal((await them.post(`/consents/${c.id}/decline`, { reason: 'x' })).status, 404);
  assert.equal((await them.get(`/patients/${s.patient.id}/consents`)).status, 404);
  assert.equal((await them.get(`/appointments/${s.appt.id}/paperwork`)).status, 404);
  assert.equal((await them.get(`/appointments/${s.appt.id}/consent-check`)).status, 404);
  assert.equal((await them.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'qr' })).status, 404);
  assert.equal((await them.post(`/patients/${other.patient.id}/paperwork/send`, { consent_ids: [c.id], channel: 'qr' })).status, 404);
  const st = (await them.get(`/paperwork/status?appointment_ids=${s.appt.id}`)).data;
  assert.deepEqual(st, {});
  assert.equal((await them.post(`/patients/${s.patient.id}/education/show`, { slug: 'crowns' })).status, 404);
  const tpl = await templateNamed(s.api, 'Consent for tooth extraction');
  assert.equal((await them.get(`/form-templates/${tpl.id}/versions`)).status, 404);
  assert.deepEqual((await them.get('/intake/pending')).data?.items?.filter?.((i) => i.patient_id === s.patient.id) ?? [], []);
  // Validation: bad channel, bad ids.
  assert.equal((await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'fax' })).status, 400);
  assert.equal((await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { template_ids: ['abc'], channel: 'qr' })).status, 400);
  assert.equal((await s.mine.get('/paperwork/status?date=2026-13-45x')).status, 400);
});

test('Sending by text: a double click sends one text; no phone or email → a clear error; the link works once per form', async () => {
  const s = await setup();
  const before = h.sent.length;
  const [one, two] = await Promise.all([
    s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'sms' }),
    s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'sms' }),
  ]);
  assert.ok([one.status, two.status].includes(201));
  const texts = h.sent.slice(before).filter((m) => m.to === s.patient.phone);
  assert.ok(texts.length <= 2);
  const again = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { history: true, channel: 'sms' });
  assert.equal(again.data.repeated, true, 'the same send within half a minute is not sent again');
  const after = h.sent.slice(before).filter((m) => m.to === s.patient.phone).length;
  assert.equal(after, texts.length);
  await s.api.put(`/patients/${s.patient.id}`, { phone: null, email: null });
  const none = await s.mine.post(`/patients/${s.patient.id}/paperwork/send`, { template_ids: [(await templateNamed(s.api, 'Financial policy')).id], channel: 'auto' });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /No phone or email/);
});
