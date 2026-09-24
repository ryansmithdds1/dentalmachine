import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, update, audit, newToken, hashToken, addMonths, practiceNow } from './util.js';
import { fillFields, checkAnswers, seedTemplates } from './formtemplates.js';
import { dataUrlImage } from './pdf.js';
import { parseMedicalHistory, contactUpdatesFromHistory, MEDICAL_CONDITIONS } from './forms.js';
import { preferredChannel, recipientFor, sendMessage, withinSendHours } from './messaging.js';
import { messageText, patientLang, subjectFor } from './templates.js';
import { publish } from './events.js';
import { raiseIssue, resolveIssue } from './issues.js';
import {
  currentVersion, consentsForTreatment, consentContext, wordingFor, checkSigner, recordPdf, finalizeConsent, declineConsent, localTimeOf, hashOf, VIA, ageOn,
} from './consents.js';
import { proofFor } from './eduproof.js';

// Paperwork on autopilot (P1–P5; docs/workflows/specs/C-consents.md).
//
// Each visit knows which forms are due (dueForVisit): the health history (new, or older than the office's renewal
// period), the office's policies (HIPAA once, financial policy yearly…), forms the office asks for at every visit
// (screenings) or only of new patients, and the consents for the procedures booked. The autopilot sends what's
// due a few days before (one text or email with a link — no treatment named in it), reminds until it's done, and
// stops at the visit. Staff can send anything else from one "Send forms" action, by text, email, a QR code at the
// desk, this screen, or the office iPad in kiosk mode (kiosk_sessions: loaded for that patient, no birth-date
// step, cleared when done or idle, with live "page 3 of 5" for the team).
//
// Packets reuse form_requests (one row per form, sharing packet_id); links live in paperwork_links (one per
// send, so a reminder is a new link and every link is traceable). Submissions land where the rest of the app
// expects them: patient_forms (histories wait for a clinician's one-key review in the intake worklist, contact
// details apply at once), signed PDFs in documents, card photos as insurance_card documents for the
// read-and-confirm insurance path.

const sqlNow = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);
const LINK_DAYS = 14;
export const KIOSK_MINUTES = 30;
export const KIOSK_IDLE_MINUTES = 10;
const RULES = ['once', 'yearly', 'every_visit', 'new_patient'];
export const DUE_RULES = RULES;

// ---- Packets and links ----
export async function createPacket(db, { practiceId, patientId, appointmentId = null, items, userId = null, kioskSessionId = null }) {
  if (!items.length) throw new HttpError(400, 'Choose at least one form');
  const expires = new Date(Date.now() + LINK_DAYS * 86400_000).toISOString();
  return await db.tx(async () => {
    const ids = [];
    for (const item of items) {
      // Older unfinished requests for the same form are replaced by this one (the newest link has everything).
      if (item.kind === 'medical_history') await db.run("UPDATE form_requests SET status = 'expired' WHERE patient_id = ? AND practice_id = ? AND kind = 'medical_history' AND status = 'pending'", patientId, practiceId);
      else if (item.consent_id) await db.run("UPDATE form_requests SET status = 'expired' WHERE consent_id = ? AND status = 'pending'", item.consent_id);
      else await db.run("UPDATE form_requests SET status = 'expired' WHERE patient_id = ? AND practice_id = ? AND template_id = ? AND consent_id IS NULL AND status = 'pending'", patientId, practiceId, item.template_id);
      ids.push(await insert(db, 'form_requests', {
        practice_id: practiceId, patient_id: patientId, kind: item.kind, template_id: item.template_id ?? null, consent_id: item.consent_id ?? null,
        // Links carry their own tokens (paperwork_links); this one is never handed out.
        token_hash: hashToken(randomBytes(24).toString('hex')), expires_at: expires, created_by: userId, appointment_id: appointmentId,
        context: JSON.stringify(item.context || {}), kiosk_session_id: kioskSessionId,
      }));
    }
    await db.run(`UPDATE form_requests SET packet_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, ids[0], ...ids);
    for (const [i, item] of items.entries()) {
      if (item.consent_id) await db.run("UPDATE consents SET status = CASE WHEN status = 'needed' THEN 'sent' ELSE status END, form_request_id = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('needed','sent')", ids[i], item.consent_id);
    }
    return { packetId: ids[0], ids };
  });
}

export async function makeLink(db, { practiceId, patientId, packetId, appointmentId = null, channel, purpose, userId = null, hours = LINK_DAYS * 24, appUrl }) {
  const { token, hash } = newToken();
  const id = await insert(db, 'paperwork_links', {
    practice_id: practiceId, patient_id: patientId, packet_id: packetId, appointment_id: appointmentId, token_hash: hash, channel, purpose,
    expires_at: new Date(Date.now() + hours * 3600_000).toISOString(), created_by: userId,
  });
  return { id, token, url: `${appUrl}/p/${token}` };
}

// Texts or emails a link (to a parent for a child): the message names the office and the link, nothing clinical.
async function sendLink(db, messenger, { practiceId, patient, packetId, appointmentId, channel, purpose, userId, appUrl, count }) {
  const to = await recipientFor(db, patient);
  const target = preferredChannel(to, channel === 'auto' ? undefined : channel);
  if (!target) throw new HttpError(400, 'No phone or email on file that accepts messages (or the patient opted out)');
  const link = await makeLink(db, { practiceId, patientId: patient.id, packetId, appointmentId, channel: target.channel, purpose, userId, appUrl });
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', practiceId);
  const lang = patientLang(patient);
  const forms = count === 1 ? (lang === 'es' ? 'un formulario' : 'a form') : (lang === 'es' ? `${count} formularios` : `${count} forms`);
  const message = await sendMessage(db, messenger, {
    practiceId, patientId: patient.id, userId, appointmentId, kind: purpose === 'reminder' ? 'forms_reminder' : 'intake_form', channel: target.channel, to: target.to,
    subject: subjectFor(lang, 'forms', `Please complete your forms for ${practice.name}`, practice.name),
    body: await messageText(db, practiceId, 'forms', { first_name: to.first_name, forms, link: link.url, practice: practice.name }, lang),
  });
  await db.run('UPDATE paperwork_links SET message_id = ? WHERE id = ?', message.id, link.id);
  return { link, message };
}

export async function packetFor(db, packetId) {
  const first = await db.get('SELECT * FROM form_requests WHERE id = ?', packetId);
  if (!first) throw new HttpError(404, 'Forms not found');
  const items = await db.all(
    `SELECT fr.id, fr.kind, fr.status, fr.template_id, fr.context, fr.consent_id, fr.appointment_id, fr.expires_at, t.name, t.kind AS template_kind, t.witness
     FROM form_requests fr LEFT JOIN form_templates t ON t.id = fr.template_id
     WHERE fr.practice_id = ? AND (fr.id = ? OR fr.packet_id = ?) ORDER BY fr.id`, first.practice_id, packetId, packetId,
  );
  return { first, items };
}

async function contextFor(db, first, item) {
  if (item.consent_id) {
    const c = await db.get('SELECT * FROM consents WHERE id = ?', item.consent_id);
    return consentContext(db, { practiceId: first.practice_id, patientId: first.patient_id, procedureIds: JSON.parse(c.procedure_ids), appointmentId: c.appointment_id });
  }
  const base = await consentContext(db, { practiceId: first.practice_id, patientId: first.patient_id });
  return { ...base, ...JSON.parse(item.context || '{}') };
}

// What the patient's screen shows: every form in the packet, in English and (when the office has it) Spanish.
export async function packetView(db, packetId) {
  const { first, items } = await packetFor(db, packetId);
  const p = await db.get('SELECT * FROM patients WHERE id = ?', first.patient_id);
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', first.practice_id);
  const forms = [];
  for (const x of items) {
    if (x.kind === 'medical_history') { forms.push({ id: x.id, kind: 'medical_history', name: 'Health history', status: x.status }); continue; }
    const t = await db.get('SELECT * FROM form_templates WHERE id = ?', x.template_id);
    const v = await currentVersion(db, t);
    const ctx = await contextFor(db, first, x);
    const en = fillFields(wordingFor(v, 'en').fields, ctx);
    const es = v.fields_es ? fillFields(wordingFor(v, 'es').fields, ctx) : null;
    forms.push({ id: x.id, kind: 'custom', name: t.name, form_kind: t.kind, status: x.status, consent: !!x.consent_id, witness: !!t.witness, version_id: v.id, version: v.version, fields: { en, es } });
  }
  const age = ageOn(p.dob, new Date().toISOString().slice(0, 10));
  return {
    practice, first_name: p.first_name, language: patientLang(p), minor: age != null && age < 18, conditions: MEDICAL_CONDITIONS,
    prefill: { phone: p.phone, email: p.email, address: p.address, city: p.city, state: p.state, zip: p.zip, emergency_contact: p.emergency_contact },
    forms, total: forms.length, done: forms.filter((f) => f.status !== 'pending').length,
  };
}

// ---- Submissions (the patient's link, this screen, or the kiosk) ----
const claim = async (db, id) => {
  const done = await db.run("UPDATE form_requests SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'pending'", id);
  if (!done.changes) throw new HttpError(410, 'This form has already been submitted. Thank you!');
};
const pending = (item) => {
  if (!item) throw new HttpError(404, 'Form not found');
  if (item.status !== 'pending') throw new HttpError(410, item.status === 'completed' ? 'This form has already been submitted. Thank you!' : 'This form is no longer needed.');
};
const safeName = (s) => String(s).replace(/[^\w.\- ()]/g, '_');

// who: { via: 'link'|'kiosk'|'handoff', ip, device, kioskSession, handedOverBy }
export async function submitHistory(db, storage, { packetId, body, who }) {
  const { first, items } = await packetFor(db, packetId);
  const item = items.find((x) => x.kind === 'medical_history');
  pending(item);
  const { answers, signatureName, signatureImage } = parseMedicalHistory(body);
  const lang = body?.lang === 'es' ? 'es' : 'en';
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', first.patient_id);
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', first.practice_id);
  const signedAt = sqlNow();
  // The history as a PDF on the chart, like every other signed form.
  const shown = Object.entries(answers).filter(([k]) => !['consent_hipaa', 'consent_treatment'].includes(k))
    .map(([k, v]) => ({ type: 'text', key: k, label: k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));
  const flat = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') || 'None' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v]));
  const pdf = recordPdf({
    practice, patient, title: 'Health history', version: 1, lang, fields: shown, answers: flat, signature: signatureImage, signerName: signatureName,
    signedAt, ip: who.ip, device: who.device, via: VIA[who.via], localTime: await localTimeOf(db, first.practice_id, signedAt),
  });
  const saved = await storage.save(first.practice_id, pdf);
  const formId = await db.tx(async () => {
    await claim(db, item.id);
    const docId = await insert(db, 'documents', {
      practice_id: first.practice_id, patient_id: first.patient_id, category: 'medical_history', appointment_id: item.appointment_id, filename: safeName(`Health history ${signedAt.slice(0, 10)}.pdf`),
      mime: 'application/pdf', size: pdf.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Signed by ${signatureName}`,
    });
    const id = await insert(db, 'patient_forms', {
      practice_id: first.practice_id, patient_id: first.patient_id, request_id: item.id, kind: 'medical_history', data: JSON.stringify(answers),
      signature_name: signatureName, signature_image: signatureImage, ip: who.ip, user_agent: who.device, review_status: 'pending', document_id: docId,
      lang, signed_via: who.via, device: who.device, appointment_id: item.appointment_id, kiosk_session_id: who.kioskSession?.id ?? null,
      content_hash: hashOf(answers),
    });
    // Contact details are the patient's to update and apply now; the medical part waits for a clinician's
    // one-key review ("what changed") so a rushed "none" can't erase an allergy on the chart.
    const heard = answers.referral_source && !patient.referral_source ? { referral_source: answers.referral_source.slice(0, 100) } : {};
    await update(db, 'patients', first.patient_id, first.practice_id, { ...contactUpdatesFromHistory(answers), ...heard, updated_at: new Date().toISOString() });
    return id;
  });
  await audit(db, { ip: who.ip, user: { practice_id: first.practice_id, id: null } }, 'form.submit', 'patient_forms', formId, { patient_id: first.patient_id, kind: 'medical_history', via: who.via }, { source: 'patient' });
  publish(first.practice_id, { type: 'paperwork', patient_id: first.patient_id, appointment_id: item.appointment_id, packet_id: packetId, form: 'medical_history' });
  publish(first.practice_id, { type: 'intake' });
  return { id: formId };
}

export async function submitForm(db, storage, { packetId, rid, body, who }) {
  const { first, items } = await packetFor(db, packetId);
  const item = items.find((x) => x.id === Number(rid) && x.kind === 'custom');
  pending(item);
  const t = await db.get('SELECT * FROM form_templates WHERE id = ?', item.template_id);
  const v = await currentVersion(db, t);
  // The patient signs the wording they read: if the office changed the form while it was open, they see the new one first.
  if (body?.version_id != null && Number(body.version_id) !== v.id) throw new HttpError(409, 'This form was just updated by the office. Please read the new version.', { changed: true });
  const lang = body?.lang === 'es' && v.fields_es ? 'es' : 'en';
  const ctx = await contextFor(db, first, item);
  const fields = fillFields(wordingFor(v, lang).fields, ctx);
  const { answers, photos, signature, signatureName } = checkAnswers(fields, body);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', first.patient_id);
  const { relationship } = checkSigner(patient, body, new Date().toISOString().slice(0, 10));
  if (relationship !== 'self' && !signatureName) throw new HttpError(400, 'Type the name of the person signing');
  let witness = null;
  if (body?.witness && (who.via === 'kiosk' || who.via === 'handoff')) {
    const name = String(body.witness.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Type the witness’s name');
    if (!dataUrlImage(body.witness.signature) || String(body.witness.signature).length > 400_000) throw new HttpError(400, 'Witness: please sign again');
    witness = { name, signature: body.witness.signature, userId: who.kioskSession?.created_by ?? who.handedOverBy ?? null };
  } else if (t.witness && who.via === 'kiosk') throw new HttpError(400, 'A team member needs to sign as witness for this form', { witness_required: true });
  const consent = item.consent_id ? await db.get('SELECT * FROM consents WHERE id = ?', item.consent_id) : null;
  if (consent && !['needed', 'sent'].includes(consent.status)) throw new HttpError(410, 'This consent was already signed or declined.');
  const signedAt = sqlNow();
  const education = consent ? (await proofFor(db, first.practice_id, first.patient_id, { consentId: consent.id, appointmentId: consent.appointment_id })).lines : [];
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', first.practice_id);
  const signer = signatureName || `${patient.first_name} ${patient.last_name}`;
  const pdf = recordPdf({
    practice, patient, title: t.name, version: v.version, lang, fields, answers, photos, signature, signerName: signer, relationship, signedAt, ip: who.ip, device: who.device,
    via: VIA[who.via], witness, education, localTime: await localTimeOf(db, first.practice_id, signedAt),
  });
  const saved = await storage.save(first.practice_id, pdf);
  const files = await Promise.all(photos.map(async (p) => ({ ...p, ...(await storage.save(first.practice_id, p.bytes)) })));
  const content = JSON.stringify(fields);
  const day = signedAt.slice(0, 10);
  const formId = await db.tx(async () => {
    await claim(db, item.id);
    const docId = await insert(db, 'documents', {
      practice_id: first.practice_id, patient_id: first.patient_id, category: t.kind === 'consent' ? 'consent' : 'document', appointment_id: item.appointment_id,
      treatment_plan_id: consent?.treatment_plan_id ?? null, filename: safeName(`${t.name} ${day}.pdf`), mime: 'application/pdf', size: pdf.length,
      storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Signed by ${signer}${witness ? `, witnessed by ${witness.name}` : ''}`,
    });
    // Card and ID photos: filed for the insurance read-and-confirm path (a person confirms the policy).
    for (const p of files) {
      await insert(db, 'documents', {
        practice_id: first.practice_id, patient_id: first.patient_id, category: /insurance|seguro/i.test(p.label) ? 'insurance_card' : 'photo', appointment_id: item.appointment_id,
        filename: safeName(`${p.label} ${day}.${p.mime === 'image/png' ? 'png' : 'jpg'}`), mime: p.mime, size: p.bytes.length,
        storage_key: p.storageKey, encrypted: p.encrypted ? 1 : 0, notes: `From ${t.name}`,
      });
    }
    const id = await insert(db, 'patient_forms', {
      practice_id: first.practice_id, patient_id: first.patient_id, request_id: item.id, kind: 'custom', template_id: t.id, template_version: v.version, version_id: v.id,
      fields: content, data: JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([k]) => !fields.find((x) => x.key === k && x.type === 'signature')))),
      signature_name: signer, signature_image: signature, document_id: docId, ip: who.ip, user_agent: who.device, content_hash: hashOf(content), lang,
      signer_relationship: relationship, witness_user_id: witness?.userId ?? null, witness_name: witness?.name ?? null, signed_via: who.via, device: who.device,
      appointment_id: item.appointment_id, consent_id: consent?.id ?? null, kiosk_session_id: who.kioskSession?.id ?? null,
    });
    if (consent) {
      await finalizeConsent(db, consent, {
        formId: id, documentId: docId, versionId: v.id, version: v.version, lang, content, signerName: signer, relationship, signedAt, ip: who.ip, device: who.device, via: who.via, witness,
      });
    }
    return id;
  });
  const req = { ip: who.ip, user: { practice_id: first.practice_id, id: null } };
  await audit(db, req, consent ? 'consent.sign' : 'form.submit', consent ? 'consents' : 'patient_forms', consent ? consent.id : formId, {
    patient_id: first.patient_id, form_id: formId, template_id: t.id, version: v.version, lang, via: who.via, relationship, witness: witness?.name || null,
  }, { source: 'patient' });
  publish(first.practice_id, { type: 'paperwork', patient_id: first.patient_id, appointment_id: item.appointment_id, packet_id: packetId, consent_id: consent?.id ?? null, status: 'signed' });
  if (files.some((f) => /insurance|seguro/i.test(f.label))) publish(first.practice_id, { type: 'intake' });
  return { id: formId };
}

// The patient taps "I don't consent" on a consent: recorded like a signature (typed name, signature, device).
export async function declineFromPatient(db, storage, { packetId, rid, body, who }) {
  const { first, items } = await packetFor(db, packetId);
  const item = items.find((x) => x.id === Number(rid) && x.kind === 'custom');
  pending(item);
  if (!item.consent_id) throw new HttpError(400, 'Only a consent can be declined');
  const consent = await db.get('SELECT * FROM consents WHERE id = ?', item.consent_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', first.patient_id);
  const { relationship } = checkSigner(patient, body, new Date().toISOString().slice(0, 10));
  const name = String(body?.signature_name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Type your full name');
  const signature = body?.signature && dataUrlImage(body.signature) && String(body.signature).length < 800_000 ? body.signature : null;
  const docId = await declineConsent(db, storage, {
    consent, reason: String(body?.reason || '').trim().slice(0, 500) || null, signatureName: name, signature, relationship, ip: who.ip, device: who.device, via: who.via, lang: body?.lang === 'es' ? 'es' : 'en',
  });
  await audit(db, { ip: who.ip, user: { practice_id: first.practice_id, id: null } }, 'consent.decline', 'consents', consent.id, { patient_id: first.patient_id, via: who.via, document_id: docId }, { source: 'patient', reason: body?.reason ? String(body.reason).slice(0, 500) : null });
  return { ok: true };
}

// "Maria is on page 3 of 5" for the team (live), and on a kiosk session.
export async function progress(db, { packetId, page, total, kioskSession = null }) {
  const { first } = await packetFor(db, packetId);
  const p = Math.max(0, Math.min(99, Number(page) || 0));
  const n = Math.max(0, Math.min(99, Number(total) || 0));
  if (kioskSession) await db.run("UPDATE kiosk_sessions SET page = ?, total = ?, status = CASE WHEN status = 'waiting' THEN 'active' ELSE status END, started_at = COALESCE(started_at, datetime('now')), last_activity_at = datetime('now') WHERE id = ?", p, n, kioskSession.id);
  const who = await db.get('SELECT first_name FROM patients WHERE id = ?', first.patient_id);
  publish(first.practice_id, { type: 'paperwork_progress', patient_id: first.patient_id, packet_id: packetId, kiosk_session_id: kioskSession?.id ?? null, kiosk_id: kioskSession?.kiosk_id ?? null, first_name: who?.first_name, page: p, total: n });
}

// ---- What's due for a visit (P1) ----
export async function dueForVisit(db, appt, { attach = false, userId = null, source = null } = {}) {
  const practiceId = appt.practice_id;
  await seedTemplates(db, practiceId);
  const day = String(appt.start_time).slice(0, 10);
  const practice = await db.get('SELECT history_renew_months FROM practices WHERE id = ?', practiceId);
  const nowIso = new Date().toISOString();
  const pendingReq = async (where, ...args) => db.get(`SELECT id, created_at FROM form_requests WHERE practice_id = ? AND patient_id = ? AND status = 'pending' AND expires_at > ? AND ${where} ORDER BY id DESC LIMIT 1`, practiceId, appt.patient_id, nowIso, ...args);
  const items = [];

  const hist = await db.get("SELECT MAX(signed_at) AS at FROM patient_forms WHERE practice_id = ? AND patient_id = ? AND kind = 'medical_history'", practiceId, appt.patient_id);
  const renew = Number(practice?.history_renew_months ?? 12) || 12;
  const histFresh = hist?.at && addMonths(hist.at.slice(0, 10), renew) > day;
  items.push({
    key: 'history', kind: 'medical_history', name: 'Health history', reason: hist?.at ? `Update every ${renew} months` : 'New patient', last_at: hist?.at || null,
    status: histFresh ? 'done' : (await pendingReq("kind = 'medical_history'")) ? 'sent' : 'due',
  });

  const earlier = await db.get("SELECT id FROM appointments WHERE practice_id = ? AND patient_id = ? AND status = 'completed' AND start_time < ? LIMIT 1", practiceId, appt.patient_id, appt.start_time);
  const templates = await db.all("SELECT * FROM form_templates WHERE practice_id = ? AND active = 1 AND kind <> 'consent' AND (auto_send = 1 OR due_rule IS NOT NULL) ORDER BY id", practiceId);
  for (const t of templates) {
    const rule = RULES.includes(t.due_rule) ? t.due_rule : t.renew_months > 0 ? 'yearly' : 'once';
    if (rule === 'new_patient' && earlier) continue;
    const last = await db.get('SELECT MAX(signed_at) AS at FROM patient_forms WHERE practice_id = ? AND patient_id = ? AND template_id = ?', practiceId, appt.patient_id, t.id);
    let done = !!last?.at;
    if (rule === 'yearly') done = !!last?.at && addMonths(last.at.slice(0, 10), t.renew_months || 12) > day;
    if (rule === 'every_visit') done = !!(await db.get('SELECT id FROM patient_forms WHERE practice_id = ? AND patient_id = ? AND template_id = ? AND appointment_id = ?', practiceId, appt.patient_id, t.id, appt.id));
    items.push({
      key: `form:${t.id}`, kind: 'custom', template_id: t.id, name: t.name, form_kind: t.kind, rule, last_at: last?.at || null,
      reason: { once: 'Once', yearly: `Every ${t.renew_months || 12} months`, every_visit: 'Every visit', new_patient: 'New patients' }[rule],
      status: done ? 'done' : (await pendingReq('template_id = ? AND consent_id IS NULL', t.id)) ? 'sent' : 'due',
    });
  }

  const { consents } = await consentsForTreatment(db, { practiceId, patientId: appt.patient_id, appointmentId: appt.id, attach, userId, source });
  for (const c of consents) {
    items.push({
      key: c.id ? `consent:${c.id}` : `consent-new:${c.template_id}`, kind: 'consent', consent_id: c.id, template_id: c.template_id, name: c.template_name, procedure_ids: JSON.parse(c.procedure_ids || '[]'),
      status: c.status === 'signed' ? 'done' : c.status === 'declined' ? 'declined' : c.status === 'sent' && c.form_request_id && (await db.get("SELECT id FROM form_requests WHERE id = ? AND status = 'pending' AND expires_at > ?", c.form_request_id, nowIso)) ? 'sent' : 'due',
      signed_at: c.signed_at || null, covers: !!c.covers,
    });
  }
  return items;
}

export function summarize(items) {
  const forms = items.filter((i) => i.kind !== 'consent');
  const consents = items.filter((i) => i.kind === 'consent');
  const open = items.filter((i) => i.status === 'due' || i.status === 'sent');
  return {
    total: items.length, done: items.filter((i) => i.status === 'done').length, open: open.length, sent: items.filter((i) => i.status === 'sent').length,
    forms: { total: forms.length, done: forms.filter((i) => i.status === 'done').length },
    consents: { total: consents.length, signed: consents.filter((i) => i.status === 'done').length, declined: consents.filter((i) => i.status === 'declined').length, open: consents.filter((i) => i.status === 'due' || i.status === 'sent').length },
    state: !items.length ? 'none' : open.length === 0 ? 'done' : open.length === items.length ? 'todo' : 'partial',
  };
}

// ---- Sending (P1/P2: one "Send forms" for anything) ----
// items: the forms to send; when none are named, what's due for the visit. channel: sms | email | auto (text or
// email, as the patient prefers) | qr (a link for a QR code at the desk) | here (this screen, handed over) |
// kiosk (the office iPad).
export async function buildItems(db, { practiceId, patient, appointment, templateIds = [], history = false, consentIds = [], userId }) {
  const items = [];
  if (!templateIds.length && !history && !consentIds.length) {
    if (!appointment) throw new HttpError(400, 'Choose the forms to send (there is no upcoming visit to pick them from)');
    for (const d of await dueForVisit(db, appointment, { attach: true, userId, source: 'human' })) {
      if (d.status !== 'due' && d.status !== 'sent') continue;
      if (d.kind === 'medical_history') items.push({ kind: 'medical_history' });
      else if (d.kind === 'consent') items.push({ kind: 'custom', template_id: d.template_id, consent_id: d.consent_id });
      else items.push({ kind: 'custom', template_id: d.template_id });
    }
    if (!items.length) throw new HttpError(409, 'Everything for this visit is already done', { nothing_due: true });
    return items;
  }
  if (history) items.push({ kind: 'medical_history' });
  for (const id of [...new Set(consentIds.map(Number))]) {
    const c = await db.get('SELECT * FROM consents WHERE id = ? AND practice_id = ? AND patient_id = ?', id, practiceId, patient.id);
    if (!c) throw new HttpError(404, 'Consent not found');
    if (!['needed', 'sent'].includes(c.status)) throw new HttpError(409, `That consent is already ${c.status}`);
    items.push({ kind: 'custom', template_id: c.template_id, consent_id: c.id });
  }
  for (const id of [...new Set(templateIds.map(Number))]) {
    const t = await db.get('SELECT id, kind FROM form_templates WHERE id = ? AND practice_id = ? AND active = 1', id, practiceId);
    if (!t) throw new HttpError(404, 'Form not found');
    if (items.some((i) => i.template_id === t.id)) continue;
    items.push({ kind: 'custom', template_id: t.id });
  }
  return items;
}

export async function nextVisit(db, practiceId, patientId, now) {
  return db.get("SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ('scheduled','confirmed','checked_in','in_chair') AND start_time >= ? ORDER BY start_time LIMIT 1", practiceId, patientId, `${now.slice(0, 10)} 00:00`);
}

export async function sendPaperwork(db, messenger, req, { patient, appointment, items, channel, kiosk = null, appUrl }) {
  const practiceId = req.user.practice_id;
  // A double click (or a retry) within half a minute returns the same send instead of a second text.
  const since = sqlNow(new Date(Date.now() - 30_000));
  const same = async (packetId) => {
    const { items: have } = await packetFor(db, packetId);
    const key = (xs) => xs.map((x) => `${x.kind}:${x.template_id || ''}:${x.consent_id || ''}`).sort().join('|');
    return key(have) === key(items);
  };
  if (channel === 'kiosk') {
    const recent = await db.get("SELECT * FROM kiosk_sessions WHERE kiosk_id = ? AND patient_id = ? AND created_by = ? AND status IN ('waiting','active') AND created_at >= ? ORDER BY id DESC LIMIT 1", kiosk.id, patient.id, req.user.id, since);
    if (recent?.packet_id && (await same(recent.packet_id))) return { packet_id: recent.packet_id, session: recent, repeated: true };
  } else {
    const recent = await db.get('SELECT * FROM paperwork_links WHERE practice_id = ? AND patient_id = ? AND created_by = ? AND purpose = ? AND created_at >= ? ORDER BY id DESC LIMIT 1', practiceId, patient.id, req.user.id, { sms: 'send', email: 'send', auto: 'send', qr: 'qr', here: 'handoff' }[channel], since);
    if (recent && (await same(recent.packet_id)) && channel !== 'here') return { packet_id: recent.packet_id, repeated: true, link_id: recent.id, url: null };
  }
  let session = null;
  if (channel === 'kiosk') session = await startKioskSession(db, req, { kiosk, patient, appointmentId: appointment?.id ?? null, mode: 'forms' });
  const { packetId } = await createPacket(db, { practiceId, patientId: patient.id, appointmentId: appointment?.id ?? null, items, userId: req.user.id, kioskSessionId: session?.id ?? null });
  const out = { packet_id: packetId, forms: items.length };
  if (session) {
    await db.run('UPDATE kiosk_sessions SET packet_id = ?, total = ? WHERE id = ?', packetId, items.length, session.id);
    out.session = await db.get('SELECT * FROM kiosk_sessions WHERE id = ?', session.id);
    publish(practiceId, { type: 'kiosk', kiosk_id: kiosk.id, session_id: session.id, patient_id: patient.id, first_name: patient.first_name, status: 'waiting', page: 0, total: items.length });
  } else if (channel === 'qr' || channel === 'here') {
    const link = await makeLink(db, { practiceId, patientId: patient.id, packetId, appointmentId: appointment?.id ?? null, channel: channel === 'qr' ? 'qr' : 'handoff', purpose: channel === 'qr' ? 'qr' : 'handoff', userId: req.user.id, hours: channel === 'qr' ? 2 : 1, appUrl });
    Object.assign(out, { url: link.url, link_id: link.id, expires_hours: channel === 'qr' ? 2 : 1 });
  } else {
    const { link, message } = await sendLink(db, messenger, { practiceId, patient, packetId, appointmentId: appointment?.id ?? null, channel, purpose: 'send', userId: req.user.id, appUrl, count: items.length });
    Object.assign(out, { link_id: link.id, message: { id: message.id, channel: message.channel, status: message.status, error: message.error || null } });
  }
  await audit(db, req, 'paperwork.send', 'form_requests', packetId, { patient_id: patient.id, channel, forms: items.length, consents: items.filter((i) => i.consent_id).map((i) => i.consent_id), kiosk_id: kiosk?.id ?? null });
  publish(practiceId, { type: 'paperwork', patient_id: patient.id, appointment_id: appointment?.id ?? null, packet_id: packetId, status: 'sent' });
  return out;
}

// ---- Kiosk iPads (P3) ----
export async function kioskFromToken(db, token) {
  if (!token || String(token).length > 200) return null;
  const k = await db.get('SELECT * FROM forms_kiosks WHERE token_hash = ? AND revoked_at IS NULL', hashToken(String(token)));
  if (k && (!k.last_seen_at || Date.now() - Date.parse(`${k.last_seen_at.replace(' ', 'T')}Z`) > 60_000)) await db.run("UPDATE forms_kiosks SET last_seen_at = datetime('now') WHERE id = ?", k.id);
  return k || null;
}

// One patient at a time on a kiosk: loading a new one ends the last (it was probably left on the home screen).
export async function startKioskSession(db, req, { kiosk, patient, appointmentId = null, mode = 'forms', deliveryId = null }) {
  const practiceId = req.user.practice_id;
  const open = await db.all("SELECT id FROM kiosk_sessions WHERE kiosk_id = ? AND status IN ('waiting','active')", kiosk.id);
  for (const s of open) await endKioskSession(db, s.id, 'replaced');
  const id = await insert(db, 'kiosk_sessions', {
    practice_id: practiceId, location_id: kiosk.location_id ?? null, kiosk_id: kiosk.id, patient_id: patient.id, appointment_id: appointmentId, mode,
    education_delivery_id: deliveryId, created_by: req.user.id, lang: patientLang(patient), expires_at: new Date(Date.now() + KIOSK_MINUTES * 60_000).toISOString(),
  });
  await audit(db, req, 'kiosk.session_start', 'kiosk_sessions', id, { patient_id: patient.id, kiosk: kiosk.name, mode });
  return await db.get('SELECT * FROM kiosk_sessions WHERE id = ?', id);
}

export async function endKioskSession(db, id, reason) {
  const status = reason === 'completed' ? 'completed' : reason === 'expired' || reason === 'idle' ? 'expired' : 'cancelled';
  const r = await db.run("UPDATE kiosk_sessions SET status = ?, ended_reason = ?, completed_at = datetime('now') WHERE id = ? AND status IN ('waiting','active')", status, reason, id);
  if (r.changes) {
    const s = await db.get('SELECT practice_id, kiosk_id, patient_id, packet_id, page, total FROM kiosk_sessions WHERE id = ?', id);
    // Forms the patient didn't reach stay open for a link or the next hand-over; this session can't reach them any more.
    publish(s.practice_id, { type: 'kiosk', kiosk_id: s.kiosk_id, session_id: id, patient_id: s.patient_id, status, reason, page: s.page, total: s.total });
  }
  return r.changes;
}

// The session a kiosk shows now: the latest open one that hasn't run out or gone idle.
export async function currentKioskSession(db, kiosk) {
  const s = await db.get("SELECT * FROM kiosk_sessions WHERE kiosk_id = ? AND status IN ('waiting','active') ORDER BY id DESC LIMIT 1", kiosk.id);
  if (!s) return null;
  const idleSince = s.last_activity_at ? Date.parse(`${s.last_activity_at.replace(' ', 'T')}Z`) : null;
  if (s.expires_at < new Date().toISOString() || (idleSince && Date.now() - idleSince > KIOSK_IDLE_MINUTES * 60_000)) {
    await endKioskSession(db, s.id, 'expired');
    return null;
  }
  return s;
}

// A kiosk may only touch its own open session.
export async function kioskSessionFor(db, kiosk, sid) {
  const s = await currentKioskSession(db, kiosk);
  if (!s || s.id !== Number(sid)) throw new HttpError(410, 'This session has ended. Please hand the iPad back to the team.');
  return s;
}

// ---- The autopilot (P1, P5): sends before visits and reminders, safe to run on every server at once ----
async function claimSend(db, practiceId, key, extra = {}) {
  const r = await db.run(
    'INSERT INTO paperwork_sends (practice_id, send_key, appointment_id, packet_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', practiceId, key, extra.appointmentId ?? null, extra.packetId ?? null,
  );
  return r.changes > 0;
}
const finishSend = (db, practiceId, key, patch) => db.run(`UPDATE paperwork_sends SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE practice_id = ? AND send_key = ?`, ...Object.values(patch), practiceId, key);

export async function runPaperwork(db, messenger, { appUrl, now = new Date() } = {}) {
  const counts = { sent: 0, reminded: 0, expired: 0, attached: 0 };
  // Kiosk sessions left open run out (the iPad clears itself when it next asks).
  for (const s of await db.all("SELECT id FROM kiosk_sessions WHERE status IN ('waiting','active') AND expires_at < ?", now.toISOString())) counts.expired += await endKioskSession(db, s.id, 'expired');

  for (const practice of await db.all('SELECT * FROM practices WHERE paperwork_autopilot = 1')) {
    const local = await practiceNow(db, practice.id);
    if (!withinSendHours(practice, local)) continue;
    const until = new Date(`${local.slice(0, 10)}T00:00:00Z`);
    until.setUTCDate(until.getUTCDate() + Math.max(0, Math.min(14, Number(practice.paperwork_days) || 3)));
    const appts = await db.all(
      "SELECT * FROM appointments WHERE practice_id = ? AND status IN ('scheduled','confirmed') AND start_time > ? AND start_time <= ? ORDER BY start_time",
      practice.id, local, `${until.toISOString().slice(0, 10)} 23:59`,
    );
    const actor = { user: { practice_id: practice.id, id: null }, source: 'automation' };
    for (const a of appts) {
      const items = await dueForVisit(db, a, { attach: true, source: 'automation' });
      const open = items.filter((i) => i.status === 'due');
      if (!open.length) continue;
      const key = `appt:${a.id}:initial`;
      if (!(await claimSend(db, practice.id, key, { appointmentId: a.id }))) continue;
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
      try {
        const list = open.map((d) => (d.kind === 'medical_history' ? { kind: 'medical_history' } : d.kind === 'consent' ? { kind: 'custom', template_id: d.template_id, consent_id: d.consent_id } : { kind: 'custom', template_id: d.template_id }));
        const { packetId } = await createPacket(db, { practiceId: practice.id, patientId: patient.id, appointmentId: a.id, items: list });
        const { link, message } = await sendLink(db, messenger, { practiceId: practice.id, patient, packetId, appointmentId: a.id, channel: 'auto', purpose: 'auto', userId: null, appUrl, count: list.length });
        await finishSend(db, practice.id, key, { status: message.status === 'sent' ? 'sent' : 'failed', packet_id: packetId, link_id: link.id, error: message.error || null });
        await audit(db, actor, 'paperwork.auto_send', 'form_requests', packetId, { patient_id: patient.id, appointment_id: a.id, forms: list.length }, { source: 'automation' });
        if (message.status === 'sent') counts.sent++;
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        // Nobody to send it to: the visit shows forms not done, and the intake worklist lists it for a person.
        await finishSend(db, practice.id, key, { status: 'skipped', error: String(err.message).slice(0, 300) });
      }
    }

    // Reminders until it's done: a new link each time, only for packets that went by text/email, never after the visit starts.
    const maxReminders = Math.max(0, Math.min(5, Number(practice.paperwork_reminders ?? 2)));
    const every = Math.max(4, Math.min(168, Number(practice.paperwork_remind_hours) || 24));
    if (!maxReminders) continue;
    const packets = await db.all(
      `SELECT l.packet_id, l.patient_id, MAX(l.appointment_id) AS appointment_id
       FROM paperwork_links l WHERE l.practice_id = ? AND l.channel IN ('sms','email') AND l.purpose IN ('send','auto','reminder') GROUP BY l.packet_id, l.patient_id`, practice.id,
    );
    for (const pk of packets) {
      // Each reminder follows one particular earlier link: two servers looking at the same moment claim the same
      // key, so only one reminder goes.
      const lastLink = await db.get("SELECT id, created_at FROM paperwork_links WHERE packet_id = ? AND channel IN ('sms','email') ORDER BY id DESC LIMIT 1", pk.packet_id);
      if (!lastLink || lastLink.created_at > sqlNow(new Date(now.getTime() - every * 3600_000))) continue;
      const { items } = await packetFor(db, pk.packet_id);
      const left = items.filter((i) => i.status === 'pending' && i.expires_at > now.toISOString());
      if (!left.length) continue;
      if (pk.appointment_id) {
        const a = await db.get('SELECT start_time, status FROM appointments WHERE id = ?', pk.appointment_id);
        if (!a || !['scheduled', 'confirmed'].includes(a.status) || a.start_time <= local) continue;
      }
      const sentBefore = Number((await db.get("SELECT COUNT(*) AS n FROM paperwork_links WHERE packet_id = ? AND purpose = 'reminder'", pk.packet_id)).n);
      if (sentBefore >= maxReminders) continue;
      const key = `packet:${pk.packet_id}:reminder-after:${lastLink.id}`;
      if (!(await claimSend(db, practice.id, key, { appointmentId: pk.appointment_id, packetId: pk.packet_id }))) continue;
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', pk.patient_id);
      try {
        const { link, message } = await sendLink(db, messenger, { practiceId: practice.id, patient, packetId: pk.packet_id, appointmentId: pk.appointment_id, channel: 'auto', purpose: 'reminder', userId: null, appUrl, count: left.length });
        await finishSend(db, practice.id, key, { status: message.status === 'sent' ? 'sent' : 'failed', link_id: link.id, error: message.error || null });
        await audit(db, actor, 'paperwork.reminder', 'form_requests', pk.packet_id, { patient_id: patient.id, reminder: sentBefore + 1, forms_left: left.length }, { source: 'automation' });
        if (message.status === 'sent') counts.reminded++;
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        await finishSend(db, practice.id, key, { status: 'skipped', error: String(err.message).slice(0, 300) });
      }
    }
  }
  return counts;
}

// Runs the autopilot, turning a crash into a visible work item (and clearing it when a later run works).
export async function runPaperworkSafely(db, messenger, opts) {
  try {
    const out = await runPaperwork(db, messenger, opts);
    for (const { id } of await db.all('SELECT id FROM practices WHERE paperwork_autopilot = 1')) await resolveIssue(db, id, 'paperwork:autopilot');
    return out;
  } catch (err) {
    for (const { id } of await db.all('SELECT id FROM practices WHERE paperwork_autopilot = 1')) {
      await raiseIssue(db, { practiceId: id, kind: 'message', key: 'paperwork:autopilot', role: 'front_desk', title: 'Forms before visits couldn’t be sent automatically', detail: err.message });
    }
    return { error: err.message };
  }
}

// ---- P5: the few that need a person (listed in the intake worklist, /intake) ----
// - a consent the patient declined (someone should talk it through, or record informed refusal),
// - forms that couldn't be sent before a visit (no phone or email that takes messages),
// - a visit within a day whose forms are still not done after the reminders.
// Each drops off once handled (signed, done) or set aside by a person (audited 'intake.paperwork_done').
export async function paperworkExceptions(db, user, { scopeSql = '', scopeArgs = [] } = {}) {
  const pid = user.practice_id;
  const seen = async (entity, id) => !!(await db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'intake.paperwork_done' AND entity = ? AND entity_id = ?", pid, entity, id));
  const items = [];
  const since = sqlNow(new Date(Date.now() - 14 * 86400_000));
  const declined = await db.all(
    `SELECT c.id, c.patient_id, c.declined_at, c.declined_reason, c.appointment_id, t.name AS form_name, p.first_name, p.last_name, p.dob
     FROM consents c JOIN form_templates t ON t.id = c.template_id JOIN patients p ON p.id = c.patient_id
     WHERE c.practice_id = ? AND c.status = 'declined' AND c.declined_at >= ?${scopeSql} ORDER BY c.declined_at`, pid, since, ...scopeArgs,
  );
  for (const c of declined) {
    if (await seen('consents', c.id)) continue;
    items.push({ key: `consent_declined:${c.id}`, kind: 'consent_declined', entity: 'consents', id: c.id, patient_id: c.patient_id, first_name: c.first_name, last_name: c.last_name, dob: c.dob, at: c.declined_at, form_name: c.form_name, reason: c.declined_reason, appointment_id: c.appointment_id });
  }
  const local = await practiceNow(db, pid);
  const soon = new Date(`${local.slice(0, 10)}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 2);
  const upcoming = `${soon.toISOString().slice(0, 10)} 00:00`;
  const skipped = await db.all(
    `SELECT s.id, s.appointment_id, s.error, s.created_at, a.start_time, a.patient_id, p.first_name, p.last_name, p.dob
     FROM paperwork_sends s JOIN appointments a ON a.id = s.appointment_id JOIN patients p ON p.id = a.patient_id
     WHERE s.practice_id = ? AND s.status = 'skipped' AND a.start_time >= ? AND a.status IN ('scheduled','confirmed')${scopeSql} ORDER BY a.start_time`, pid, local, ...scopeArgs,
  );
  for (const s of skipped) {
    if (await seen('paperwork_sends', s.id)) continue;
    items.push({ key: `paperwork_unreachable:${s.id}`, kind: 'paperwork_unreachable', entity: 'paperwork_sends', id: s.id, patient_id: s.patient_id, first_name: s.first_name, last_name: s.last_name, dob: s.dob, at: s.created_at, appointment_id: s.appointment_id, start_time: s.start_time, reason: s.error });
  }
  const sent = await db.all(
    `SELECT s.id, s.appointment_id, s.packet_id, s.created_at, a.start_time, a.patient_id, p.first_name, p.last_name, p.dob
     FROM paperwork_sends s JOIN appointments a ON a.id = s.appointment_id JOIN patients p ON p.id = a.patient_id
     WHERE s.practice_id = ? AND s.status IN ('sent','failed') AND s.send_key LIKE 'appt:%' AND a.start_time >= ? AND a.start_time < ? AND a.status IN ('scheduled','confirmed')${scopeSql} ORDER BY a.start_time`,
    pid, local, upcoming, ...scopeArgs,
  );
  for (const s of sent) {
    if (!s.packet_id || await seen('paperwork_sends', s.id)) continue;
    const { items: left } = await packetFor(db, s.packet_id);
    const open = left.filter((i) => i.status === 'pending');
    if (!open.length) continue;
    items.push({ key: `paperwork_overdue:${s.id}`, kind: 'paperwork_overdue', entity: 'paperwork_sends', id: s.id, patient_id: s.patient_id, first_name: s.first_name, last_name: s.last_name, dob: s.dob, at: s.created_at, appointment_id: s.appointment_id, start_time: s.start_time, forms_left: open.map((i) => i.name || 'Health history') });
  }
  return items;
}
