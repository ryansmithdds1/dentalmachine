import { HttpError } from './auth.js';
import { insert, audit, newToken, localNow } from './util.js';
import { libraryFor } from './education.js';
import { hashOf } from './consents.js';
import { preferredChannel, recipientFor, sendMessage } from './messaging.js';

// Patient education with proof it was given (E1–E3). The library itself is education.js (built-in pages plus the
// office's own); this adds what an office attaches to a page (a video link, post-op instructions, illustrations),
// the exact version shown, and a record of every time a page is shown in the chair, on the iPad, or sent home:
// who, what version, how, when — and when the patient opened a take-home link. Those records are what the consent
// record and the visit's note quote ("Crown education shown on the iPad in Op 2 by Maria, 10:42; emailed; opened").

export const HOW = { shown_chair: 'shown on the chair screen', shown_ipad: 'shown on the iPad', emailed: 'emailed to the patient', texted: 'texted to the patient' };

// One page with the office's additions.
export async function articleFor(db, practiceId, slug) {
  const a = (await libraryFor(db, practiceId)).find((x) => x.slug === slug && x.active);
  if (!a) throw new HttpError(404, 'Education page not found');
  const own = await db.get('SELECT topic, video_url, postop FROM education_articles WHERE practice_id = ? AND slug = ?', practiceId, slug);
  const media = await db.all('SELECT id, kind, filename, mime FROM education_media WHERE practice_id = ? AND slug = ? AND removed_at IS NULL ORDER BY id', practiceId, slug);
  const key = (await db.get('SELECT slug FROM practices WHERE id = ?', practiceId))?.slug || `p${practiceId}`;
  return { ...a, topic: own?.topic || null, video_url: own?.video_url || null, postop: own?.postop || null, media: media.map((m) => ({ ...m, url: `/api/public/learn-media/${key}/${m.id}` })) };
}

// The version row for what's shown now (a new one whenever the wording, video or instructions change).
export async function educationVersion(db, practiceId, a) {
  const hash = hashOf({ title: a.title, body: a.body, video_url: a.video_url || null, postop: a.postop || null, media: (a.media || []).map((m) => m.id) });
  const have = await db.get('SELECT * FROM education_versions WHERE practice_id = ? AND slug = ? AND content_hash = ? ORDER BY version DESC LIMIT 1', practiceId, a.slug, hash);
  if (have) return have;
  const next = Number((await db.get('SELECT MAX(version) AS v FROM education_versions WHERE practice_id = ? AND slug = ?', practiceId, a.slug))?.v || 0) + 1;
  await db.run(
    'INSERT INTO education_versions (practice_id, slug, version, title, body, video_url, postop, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    practiceId, a.slug, next, a.title, a.body, a.video_url || null, a.postop || null, hash,
  );
  return await db.get('SELECT * FROM education_versions WHERE practice_id = ? AND slug = ? AND content_hash = ? ORDER BY version DESC LIMIT 1', practiceId, a.slug, hash);
}

// A consent this education belongs with: named, or the patient's open/signed consent for the same visit whose form
// lists this page.
async function consentFor(db, practiceId, patientId, { consentId, appointmentId, slug }) {
  if (consentId) {
    const c = await db.get('SELECT id FROM consents WHERE id = ? AND practice_id = ? AND patient_id = ?', Number(consentId), practiceId, patientId);
    if (!c) throw new HttpError(404, 'Consent not found');
    return c.id;
  }
  if (!appointmentId) return null;
  const rows = await db.all(
    `SELECT c.id, t.education_slugs FROM consents c JOIN form_templates t ON t.id = c.template_id
     WHERE c.practice_id = ? AND c.patient_id = ? AND c.appointment_id = ? AND c.status <> 'superseded' ORDER BY c.id`, practiceId, patientId, appointmentId,
  );
  return rows.find((r) => JSON.parse(r.education_slugs || '[]').includes(slug))?.id ?? null;
}

// Records that a page was shown or sent. Returns the delivery row (and the token for a take-home link).
export async function recordDelivery(db, req, { patient, slug, how, appointmentId = null, consentId = null, operatoryId = null, kioskSessionId = null, postop = false, messageId = null, withToken = false }) {
  if (!HOW[how]) throw new HttpError(400, `how must be one of: ${Object.keys(HOW).join(', ')}`);
  const a = await articleFor(db, patient.practice_id, slug);
  const v = await educationVersion(db, patient.practice_id, a);
  const link = withToken ? newToken() : null;
  const cid = await consentFor(db, patient.practice_id, patient.id, { consentId, appointmentId, slug });
  const id = await insert(db, 'education_deliveries', {
    practice_id: patient.practice_id, location_id: req.location_id ?? patient.location_id ?? null, patient_id: patient.id, appointment_id: appointmentId, consent_id: cid,
    slug, title: a.title, version: v.version, version_id: v.id, how, postop: postop ? 1 : 0, operatory_id: operatoryId, kiosk_session_id: kioskSessionId,
    token_hash: link?.hash ?? null, message_id: messageId, source: req.source || (req.user?.role === 'api' ? 'api' : null) || null, created_by: req.user?.id ?? null,
  });
  await audit(db, req, how.startsWith('shown') ? 'education.shown' : 'education.sent', 'education_deliveries', id, { patient_id: patient.id, slug, version: v.version, how, consent_id: cid });
  return { id, token: link?.token ?? null, article: a, version: v };
}

// Take-home: one message with a link per page (no treatment named in the text itself), each link tracked.
export async function sendTakeHome(db, messenger, req, { patient, slugs, channel, appointmentId = null, consentId = null, postop = false, appUrl }) {
  const to = await recipientFor(db, patient);
  const target = preferredChannel(to, channel === 'auto' ? undefined : channel);
  if (!target) throw new HttpError(400, channel === 'email' ? 'No email on file that accepts messages' : channel === 'sms' ? 'No mobile number on file that accepts texts' : 'No phone or email on file that accepts messages');
  const unique = [...new Set(slugs)].slice(0, 6);
  for (const slug of unique) await articleFor(db, patient.practice_id, slug); // every page exists before anything is sent
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', patient.practice_id);
  const made = [];
  for (const slug of unique) made.push(await recordDelivery(db, req, { patient, slug, how: target.channel === 'sms' ? 'texted' : 'emailed', appointmentId, consentId, postop, withToken: true }));
  const es = String(patient.language || '').toLowerCase().startsWith('es');
  const links = made.map((d) => `${appUrl}/e/${d.token}`).join('\n');
  const body = es
    ? `Hola ${to.first_name}, ${practice.name} le envía información sobre su visita:\n${links}${target.channel === 'sms' ? '\nResponda STOP para no recibir más mensajes.' : ''}`
    : `Hi ${to.first_name}, here is information from ${practice.name} about your visit:\n${links}${target.channel === 'sms' ? '\nReply STOP to opt out.' : ''}`;
  const msg = await sendMessage(db, messenger, {
    practiceId: patient.practice_id, patientId: patient.id, appointmentId, channel: target.channel, to: target.to, kind: 'education', userId: req.user?.id ?? null,
    subject: es ? `Información de ${practice.name}` : `Information from ${practice.name}`, body,
  });
  for (const d of made) await db.run('UPDATE education_deliveries SET message_id = ? WHERE id = ?', msg.id, d.id);
  return { deliveries: made.map((d) => ({ id: d.id, slug: d.article.slug, title: d.article.title, version: d.version.version })), status: msg.status, error: msg.error || null, channel: target.channel };
}

// The proof, as rows and as one sentence per page for the consent record and the clinical note.
export async function proofFor(db, practiceId, patientId, { appointmentId = null, consentId = null, since = null } = {}) {
  const where = ['d.practice_id = ?', 'd.patient_id = ?'];
  const args = [practiceId, patientId];
  if (consentId && appointmentId) { where.push('(d.consent_id = ? OR d.appointment_id = ?)'); args.push(consentId, appointmentId); }
  else if (consentId) { where.push('d.consent_id = ?'); args.push(consentId); }
  else if (appointmentId) { where.push('d.appointment_id = ?'); args.push(appointmentId); }
  if (since) { where.push('d.created_at >= ?'); args.push(since); }
  const rows = await db.all(
    `SELECT d.id, d.slug, d.title, d.version, d.how, d.postop, d.appointment_id, d.consent_id, d.opened_at, d.open_count, d.created_at, d.source,
       u.name AS by_name, o.name AS operatory_name
     FROM education_deliveries d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN operatories o ON o.id = d.operatory_id
     WHERE ${where.join(' AND ')} ORDER BY d.id`, ...args,
  );
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York';
  const at = (utc) => localNow(tz, new Date(`${String(utc).replace(' ', 'T')}Z`));
  const time = (utc) => {
    const [h, m] = at(utc).slice(11, 16).split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const lines = rows.map((r) => `${r.title} (v${r.version}) ${HOW[r.how]}${r.operatory_name ? ` in ${r.operatory_name}` : ''}${r.by_name ? ` by ${r.by_name}` : ''} on ${at(r.created_at).slice(0, 10)} at ${time(r.created_at)}${r.opened_at ? `; opened by the patient ${at(r.opened_at).slice(0, 10)} ${time(r.opened_at)}` : r.how === 'emailed' || r.how === 'texted' ? '; not opened yet' : ''}.`);
  return { rows: rows.map((r) => ({ ...r, local_time: at(r.created_at) })), lines, note_text: lines.length ? `Patient education: ${lines.join(' ')}` : '' };
}
