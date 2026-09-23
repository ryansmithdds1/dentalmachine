import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
import { PdfDoc, dataUrlImage } from './pdf.js';
import { insert, newToken, hashToken, practiceNow } from './util.js';
import { preferredChannel, sendMessage, withinSendHours } from './messaging.js';
import { messageText, patientLang, subjectFor } from './templates.js';

// Practice-defined forms: consents, policies and intake questions, built from a list of fields.
// A signed form is kept as answers + the exact fields it was signed against, and filed as a PDF.

export const FIELD_TYPES = ['heading', 'paragraph', 'text', 'textarea', 'date', 'yesno', 'checkbox', 'select', 'initials', 'signature', 'photo'];
export const FORM_KINDS = ['consent', 'policy', 'intake', 'other'];
const INPUT = new Set(['text', 'textarea', 'date', 'yesno', 'checkbox', 'select', 'initials', 'signature', 'photo']);
const MAX_PHOTO = 6 * 1024 * 1024;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

// Cleans a template's field list, giving every input a stable key.
export function cleanFields(list) {
  if (!Array.isArray(list) || !list.length || list.length > 80) throw new HttpError(400, 'A form needs between 1 and 80 fields');
  const keys = new Set();
  const fields = list.map((f, i) => {
    const type = FIELD_TYPES.includes(f?.type) ? f.type : null;
    if (!type) throw new HttpError(400, `Field ${i + 1}: choose a field type`);
    const label = String(f.label || '').trim().slice(0, 300);
    const text = String(f.text || '').trim().slice(0, 8000);
    if (type === 'paragraph' && !text) throw new HttpError(400, `Field ${i + 1}: a paragraph needs text`);
    if (type !== 'paragraph' && !label) throw new HttpError(400, `Field ${i + 1}: add a label`);
    const out = { type, label };
    if (text) out.text = text;
    if (INPUT.has(type)) {
      let key = slug(f.key || label) || `field_${i + 1}`;
      while (keys.has(key)) key = `${key}_${i + 1}`;
      keys.add(key);
      out.key = key;
      out.required = type === 'signature' ? f.required !== false : !!f.required;
    }
    if (type === 'select') {
      const options = [...new Set((Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean))];
      if (!options.length) throw new HttpError(400, `${label}: add the choices`);
      out.options = options;
    }
    return out;
  });
  return fields;
}

export function cleanCodes(v) {
  return [...new Set(String(v || '').toUpperCase().split(/[\s,]+/).filter((c) => /^D\d{1,4}$/.test(c)))].join(', ') || null;
}

// Does a template apply to these procedure codes? Template codes are prefixes: "D71" covers D7140 and D7111.
export function templateMatches(template, codes) {
  const list = String(template.procedure_codes || '').split(/[\s,]+/).filter(Boolean);
  return list.length > 0 && codes.some((code) => list.some((p) => String(code).startsWith(p)));
}

// {patient}, {procedures}, {teeth}… in text, filled from the request's context.
export function fill(text, ctx) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null && ctx[k] !== '' ? String(ctx[k]) : m === '{procedures}' || m === '{teeth}' ? '—' : m));
}

export function fillFields(fields, ctx) {
  return fields.map((f) => ({ ...f, label: fill(f.label, ctx), ...(f.text ? { text: fill(f.text, ctx) } : {}) }));
}

// Checks a submission against the fields; returns { answers, photos, signature }.
export function checkAnswers(fields, body) {
  const input = body?.answers && typeof body.answers === 'object' ? body.answers : {};
  const answers = {};
  const photos = [];
  let signature = null;
  for (const f of fields) {
    if (!f.key) continue;
    const v = input[f.key];
    const empty = v == null || v === '' || v === false;
    if (f.required && empty) throw new HttpError(400, `${f.label} is required`);
    if (empty) continue;
    if (f.type === 'signature') {
      if (!dataUrlImage(v)) throw new HttpError(400, `${f.label}: please sign again`);
      if (String(v).length > 800_000) throw new HttpError(400, 'Signature is too large');
      signature ??= v;
      answers[f.key] = v;
    } else if (f.type === 'photo') {
      const m = /^data:(image\/(?:jpeg|png));base64,/.exec(String(v));
      if (!m) throw new HttpError(400, `${f.label} must be a photo (JPEG or PNG)`);
      const bytes = Buffer.from(String(v).slice(m[0].length), 'base64');
      if (bytes.length > MAX_PHOTO) throw new HttpError(400, `${f.label} is too large (6 MB at most)`);
      photos.push({ key: f.key, label: f.label, mime: m[1], bytes, dataUrl: String(v) });
      answers[f.key] = '(photo attached)';
    } else if (f.type === 'checkbox') answers[f.key] = true;
    else if (f.type === 'yesno') {
      if (!['yes', 'no'].includes(v)) throw new HttpError(400, `${f.label}: answer yes or no`);
      answers[f.key] = v;
    } else if (f.type === 'select') {
      if (!f.options.includes(v)) throw new HttpError(400, `${f.label}: choose one of the options`);
      answers[f.key] = v;
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, `${f.label} must be a date`);
      answers[f.key] = v;
    } else answers[f.key] = String(v).slice(0, f.type === 'textarea' ? 5000 : 500);
  }
  const signatureName = String(body?.signature_name || '').trim().slice(0, 120);
  if (fields.some((f) => f.type === 'signature' && f.required) && !signatureName) throw new HttpError(400, 'Type your full name to sign');
  return { answers, photos, signature, signatureName };
}

const fmtDate = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : d || '');

// The signed record: form text as the patient saw it, their answers, signature, and when/how it was signed.
export function formPdf({ practice, patient, template, fields, answers, photos = [], signatureName, signedAt, ip }) {
  const doc = new PdfDoc({ footer: `${practice.name} · ${patient.first_name} ${patient.last_name} · ${template.name}` });
  doc.text(practice.name, { size: 9, color: [0.4, 0.43, 0.5] });
  doc.text(template.name, { size: 17, bold: true, gap: 2 });
  doc.text(`Patient: ${patient.first_name} ${patient.last_name}${patient.dob ? ` · Date of birth: ${fmtDate(patient.dob)}` : ''}`, { size: 10 });
  doc.rule();
  for (const f of fields) {
    const v = f.key ? answers[f.key] : undefined;
    if (f.type === 'heading') { doc.space(4); doc.text(f.label, { size: 12.5, bold: true }); continue; }
    if (f.type === 'paragraph') { doc.text(f.text); continue; }
    if (f.text) doc.text(f.text);
    if (f.type === 'signature') {
      doc.space(4);
      doc.text(f.label, { bold: true, gap: 2 });
      doc.image(v ? dataUrlImage(v) : null, { maxW: 240, maxH: 80, border: true });
      if (signatureName) doc.text(`Signed by ${signatureName}`, { size: 9.5 });
      continue;
    }
    if (f.type === 'photo') {
      doc.text(f.label, { bold: true, gap: 2 });
      const p = photos.find((x) => x.key === f.key);
      if (p) doc.image(dataUrlImage(p.dataUrl), { maxW: 300, maxH: 190, border: true });
      else doc.text('Not provided', { color: [0.45, 0.48, 0.55] });
      continue;
    }
    const shown = f.type === 'checkbox' ? (v ? '[x] Yes' : '[ ] No') : f.type === 'yesno' ? (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '—') : f.type === 'date' ? fmtDate(v) || '—' : v || '—';
    if (f.type === 'checkbox') doc.text(`${v ? '[x]' : '[ ]'} ${f.label}`);
    else if (f.type === 'initials') doc.text(`${f.label}   Initials: ${v || '____'}`);
    else {
      doc.text(f.label, { bold: true, gap: 1 });
      doc.text(String(shown), { indent: 10 });
    }
  }
  doc.rule();
  doc.text(`Signed electronically ${signedAt} UTC${ip ? ` from ${ip}` : ''}. Form "${template.name}" version ${template.version}.`, { size: 8.5, color: [0.4, 0.43, 0.5] });
  return doc.toBuffer();
}

// Starter forms every office needs; practices edit them to their own wording.
const SIGN = [{ type: 'signature', label: 'Patient (or parent/guardian) signature', required: true }, { type: 'text', label: 'If signed by a guardian, relationship to patient' }];
export const DEFAULT_TEMPLATES = [
  {
    name: 'HIPAA notice acknowledgment', kind: 'policy', auto_send: 1, renew_months: 0,
    fields: [
      { type: 'paragraph', text: 'Our Notice of Privacy Practices explains how {practice} may use and disclose your health information, and your rights to see and correct it. A copy is available at the front desk and on request.' },
      { type: 'checkbox', label: 'I have received or been offered a copy of the Notice of Privacy Practices.', required: true },
      { type: 'text', label: 'People we may talk to about your care or billing (name and relationship)' },
      { type: 'select', label: 'You may leave appointment messages by', options: ['Text or voicemail', 'Text only', 'Voicemail only', 'Please don’t leave messages'], required: true },
      ...SIGN,
    ],
  },
  {
    name: 'Financial policy', kind: 'policy', auto_send: 1, renew_months: 12,
    fields: [
      { type: 'paragraph', text: 'Payment is due when services are provided. We file dental insurance as a courtesy; your insurance benefits are an estimate, and you are responsible for any amount insurance does not pay. Balances over 60 days may be sent to collections. Appointments missed without 24 hours’ notice may be charged a fee.' },
      { type: 'initials', label: 'I understand my insurance estimate is not a guarantee of payment.', required: true },
      { type: 'initials', label: 'I understand the missed-appointment policy.', required: true },
      ...SIGN,
    ],
  },
  {
    name: 'Consent for tooth extraction', kind: 'consent', procedure_codes: 'D71, D72', auto_send: 1, renew_months: 0,
    fields: [
      { type: 'paragraph', text: 'Planned treatment: {procedures}. Teeth: {teeth}. Dentist: {provider}.' },
      { type: 'paragraph', text: 'Risks include, but are not limited to: swelling, bruising and pain; bleeding; dry socket; infection; injury to nearby teeth or fillings; numbness or tingling of the lip, chin, tongue or cheek, which is usually temporary but may rarely be permanent; sinus involvement with upper teeth; jaw fracture; and root fragments that may be left in place. Alternatives include no treatment, or other treatment the dentist has explained.' },
      { type: 'yesno', label: 'Are you taking blood thinners?', required: true },
      { type: 'checkbox', label: 'I have been told about the risks, benefits and alternatives, and my questions have been answered.', required: true },
      { type: 'checkbox', label: 'I consent to the treatment described above.', required: true },
      ...SIGN,
    ],
  },
  {
    name: 'Consent for root canal treatment', kind: 'consent', procedure_codes: 'D31, D32, D33, D34', auto_send: 1, renew_months: 0,
    fields: [
      { type: 'paragraph', text: 'Planned treatment: {procedures}. Teeth: {teeth}. Dentist: {provider}.' },
      { type: 'paragraph', text: 'Root canal treatment has a high success rate but cannot be guaranteed. Risks include: instruments separating in the canal; perforation of the root; flare-up of pain or swelling; the tooth fracturing; and the need for retreatment, surgery or extraction. The tooth will need a crown or permanent filling afterwards to protect it. Alternatives include extraction, or no treatment.' },
      { type: 'checkbox', label: 'I understand the tooth needs a final restoration (usually a crown) soon after treatment.', required: true },
      { type: 'checkbox', label: 'I consent to the treatment described above.', required: true },
      ...SIGN,
    ],
  },
  {
    name: 'Consent for sedation / nitrous oxide', kind: 'consent', procedure_codes: 'D9230, D9239, D9243, D9248', auto_send: 1, renew_months: 0,
    fields: [
      { type: 'paragraph', text: 'Planned sedation: {procedures}. Dentist: {provider}.' },
      { type: 'paragraph', text: 'Sedation may cause drowsiness, nausea, dizziness and, rarely, breathing problems or allergic reaction. You must not drive, operate machinery or make important decisions for 24 hours after oral or IV sedation, and must have a responsible adult take you home.' },
      { type: 'yesno', label: 'Have you had anything to eat or drink in the last 6 hours?', required: true },
      { type: 'text', label: 'Adult driving you home (name and phone)' },
      { type: 'checkbox', label: 'I consent to sedation as described.', required: true },
      ...SIGN,
    ],
  },
  {
    name: 'Insurance card and photo ID', kind: 'intake', auto_send: 0, renew_months: 12,
    fields: [
      { type: 'paragraph', text: 'Please take clear photos of both sides of your dental insurance card and a photo ID. They are stored securely in your chart.' },
      { type: 'photo', label: 'Insurance card — front', required: false },
      { type: 'photo', label: 'Insurance card — back', required: false },
      { type: 'photo', label: 'Photo ID', required: false },
      { type: 'signature', label: 'Signature', required: true },
    ],
  },
];

export async function seedTemplates(db, practiceId) {
  await db.tx(async () => {
    if ((await db.get('SELECT COUNT(*) AS n FROM form_templates WHERE practice_id = ?', practiceId)).n) return;
    for (const t of DEFAULT_TEMPLATES) {
      await db.run(
        'INSERT INTO form_templates (practice_id, name, kind, fields, procedure_codes, auto_send, renew_months) VALUES (?, ?, ?, ?, ?, ?, ?)',
        practiceId, t.name, t.kind, JSON.stringify(cleanFields(t.fields)), t.procedure_codes || null, t.auto_send, t.renew_months,
      );
    }
  });
}

// ---- Sending forms ----
// A packet is one link for several forms (health history, consents, policies). Every request in it
// shares the first request's ID as packet_id; only the first carries the link's token.
export async function createPacket(db, messenger, { practiceId, patient, templateIds = [], history = false, appointmentId = null, context = {}, userId = null, send = null, appUrl }) {
  const templates = [];
  for (const id of [...new Set(templateIds.map(Number))]) {
    const t = await db.get('SELECT id, name FROM form_templates WHERE id = ? AND practice_id = ? AND active = 1', id, practiceId);
    if (!t) throw new HttpError(404, 'Form not found');
    templates.push(t);
  }
  if (!history && !templates.length) throw new HttpError(400, 'Choose at least one form');
  const target = send ? preferredChannel(patient, send === 'auto' ? undefined : send) : null;
  if (send && !target) throw new HttpError(400, 'Patient has no reachable phone or email (or has opted out)');
  const { token, hash } = newToken();
  const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
  const items = [...(history ? [{ kind: 'medical_history' }] : []), ...templates.map((t) => ({ kind: 'custom', template_id: t.id }))];
  const ids = await db.tx(async () => {
    const out = [];
    for (const [i, item] of items.entries()) {
      out.push(await insert(db, 'form_requests', {
        practice_id: practiceId, patient_id: patient.id, ...item, token_hash: i === 0 ? hash : hashToken(randomBytes(24).toString('hex')),
        expires_at: expires, created_by: userId, appointment_id: appointmentId, context: JSON.stringify(context),
      }));
    }
    await db.run(`UPDATE form_requests SET packet_id = ? WHERE id IN (${out.map(() => '?').join(',')})`, out[0], ...out);
    return out;
  });
  const url = `${appUrl}/f/${token}`;
  let message = null;
  if (target) {
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', practiceId);
    const lang = patientLang(patient);
    const what = items.length === 1
      ? (history ? (lang === 'es' ? 'su historial médico' : 'your health history') : templates[0].name.toLowerCase())
      : (lang === 'es' ? `${items.length} formularios` : `${items.length} forms`);
    message = await sendMessage(db, messenger, {
      practiceId, patientId: patient.id, userId, appointmentId, kind: 'intake_form', channel: target.channel, to: target.to,
      subject: subjectFor(lang, 'forms', `Please complete your forms for ${practice.name}`, practice.name),
      body: await messageText(db, practiceId, 'forms', { first_name: patient.first_name, forms: what, link: url }, lang),
    });
  }
  return { id: ids[0], ids, url, expires_at: expires, message };
}

// Which of a patient's forms are due: never signed, or older than the template's renewal period.
async function formsDue(db, patientId, templates, today) {
  const due = [];
  for (const t of templates) {
    const last = await db.get('SELECT MAX(signed_at) AS at FROM patient_forms WHERE patient_id = ? AND template_id = ?', patientId, t.id);
    const pending = await db.get("SELECT id FROM form_requests WHERE patient_id = ? AND template_id = ? AND status = 'pending' AND expires_at > ?", patientId, t.id, new Date().toISOString());
    if (pending) continue;
    if (!last?.at) { due.push(t); continue; }
    if (t.renew_months > 0) {
      const d = new Date(`${last.at.slice(0, 10)}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + t.renew_months);
      if (d.toISOString().slice(0, 10) <= today) due.push(t);
    }
  }
  return due;
}

// Before each visit (within 3 days), send whatever auto-send forms the patient still needs: policies
// they haven't signed (or that have lapsed) and consents for the procedures booked on that visit.
export async function runFormSends(db, messenger, { appUrl }) {
  let sent = 0;
  for (const { id: practiceId } of await db.all('SELECT DISTINCT practice_id AS id FROM form_templates WHERE auto_send = 1 AND active = 1')) {
    const templates = await db.all('SELECT * FROM form_templates WHERE practice_id = ? AND auto_send = 1 AND active = 1', practiceId);
    const now = await practiceNow(db, practiceId);
    if (!withinSendHours(await db.get('SELECT send_from, send_until FROM practices WHERE id = ?', practiceId), now)) continue;
    const until = new Date(`${now.slice(0, 10)}T00:00:00Z`);
    until.setUTCDate(until.getUTCDate() + 3);
    const appts = await db.all(
      `SELECT a.id, a.patient_id, a.start_time, pv.name AS provider_name FROM appointments a LEFT JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.status IN ('scheduled','confirmed') AND a.start_time > ? AND a.start_time < ?
         AND NOT EXISTS (SELECT 1 FROM form_requests fr WHERE fr.appointment_id = a.id)
       ORDER BY a.start_time`,
      practiceId, now, `${until.toISOString().slice(0, 10)} 23:59`,
    );
    for (const a of appts) {
      const procs = await db.all("SELECT code, description, tooth FROM procedures WHERE appointment_id = ? AND status = 'planned'", a.id);
      const codes = procs.map((p) => p.code);
      const wanted = templates.filter((t) => (t.procedure_codes ? templateMatches(t, codes) : t.kind !== 'consent'));
      const due = await formsDue(db, a.patient_id, wanted, now.slice(0, 10));
      if (!due.length) continue;
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
      if (!preferredChannel(patient)) continue;
      const context = procContext(procs, a.provider_name);
      try {
        await createPacket(db, messenger, { practiceId, patient, templateIds: due.map((t) => t.id), appointmentId: a.id, context, send: 'auto', appUrl });
        sent++;
      } catch (err) {
        if (err.status !== 400) throw err;
      }
    }
  }
  return sent;
}

export function procContext(procs, providerName) {
  return {
    procedures: [...new Set(procs.map((p) => p.description || p.code))].join(', '),
    teeth: [...new Set(procs.map((p) => p.tooth).filter(Boolean))].map((t) => `#${t}`).join(', '),
    provider: providerName || '',
  };
}
