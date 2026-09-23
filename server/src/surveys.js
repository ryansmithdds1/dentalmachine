import { HttpError } from './auth.js';
import { insert, newToken, localNow } from './util.js';
import { preferredChannel, sendMessage } from './messaging.js';
import { messageText, patientLang, subjectFor } from './templates.js';

// Patient surveys. Questions: nps (0–10 "would you recommend us"), rating (1–5), yesno, text. Each can have a Spanish label.
export const QUESTION_TYPES = ['nps', 'rating', 'yesno', 'text'];
export const DEFAULT_QUESTIONS = [
  { id: 'nps', type: 'nps', label: 'How likely are you to recommend us to a friend or family member?', label_es: '¿Qué tan probable es que nos recomiende a un amigo o familiar?' },
  { id: 'wait', type: 'rating', label: 'How was your wait time?', label_es: '¿Qué le pareció el tiempo de espera?' },
  { id: 'better', type: 'text', label: 'What could we do better?', label_es: '¿Qué podríamos mejorar?' },
];

export function cleanQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one question');
  if (list.length > 10) throw new HttpError(400, 'Up to 10 questions');
  const ids = new Set();
  return list.map((q, i) => {
    if (!QUESTION_TYPES.includes(q.type)) throw new HttpError(400, `Question ${i + 1}: type must be ${QUESTION_TYPES.join(', ')}`);
    const label = String(q.label || '').trim().slice(0, 300);
    if (!label) throw new HttpError(400, `Question ${i + 1} needs wording`);
    let id = String(q.id || `q${i + 1}`).replace(/[^\w]/g, '').slice(0, 20) || `q${i + 1}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);
    return { id, type: q.type, label, ...(q.label_es ? { label_es: String(q.label_es).trim().slice(0, 300) } : {}) };
  });
}

// Checks answers against the questions; the NPS answer is kept separately for the score.
export function cleanAnswers(questions, input = {}) {
  const out = {};
  let nps = null;
  for (const q of questions) {
    const v = input[q.id];
    if (v == null || v === '') continue;
    if (q.type === 'nps' || q.type === 'rating') {
      const n = Number(v);
      const [lo, hi] = q.type === 'nps' ? [0, 10] : [1, 5];
      if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `Choose ${lo} to ${hi}`);
      out[q.id] = n;
      if (q.type === 'nps' && nps == null) nps = n;
    } else if (q.type === 'yesno') out[q.id] = v === true || v === 'yes' ? 'yes' : 'no';
    else out[q.id] = String(v).trim().slice(0, 2000);
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'Answer at least one question');
  return { answers: out, nps };
}

// NPS = % promoters (9–10) − % detractors (0–6).
export function npsScore(values) {
  if (!values.length) return null;
  const promoters = values.filter((v) => v >= 9).length;
  const detractors = values.filter((v) => v <= 6).length;
  return Math.round(((promoters - detractors) / values.length) * 100);
}

// Asks one patient: a response row with a one-time link, sent by text or email.
export async function sendSurvey(db, messenger, { survey, patient, appointmentId = null, appUrl, userId = null }) {
  const target = preferredChannel(patient);
  if (!target) return null;
  const { token, hash } = newToken();
  await insert(db, 'survey_responses', { practice_id: survey.practice_id, survey_id: survey.id, patient_id: patient.id, appointment_id: appointmentId, token_hash: hash });
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', survey.practice_id);
  const lang = patientLang(patient);
  return sendMessage(db, messenger, {
    practiceId: survey.practice_id, patientId: patient.id, appointmentId, userId, kind: 'survey', channel: target.channel, to: target.to,
    subject: subjectFor(lang, 'survey', `How did we do? — ${practice.name}`, practice.name),
    body: await messageText(db, survey.practice_id, 'survey', { first_name: patient.first_name, link: `${appUrl}/s/${token}` }, lang),
  });
}

// After-visit surveys: the day after a completed visit, for practices with an automatic survey. A patient is asked at
// most once every 90 days, and not in a week they already got a review request.
export async function runSurveys(db, messenger, { appUrl, now = new Date() } = {}) {
  let sent = 0;
  for (const survey of await db.all('SELECT s.*, p.timezone FROM surveys s JOIN practices p ON p.id = s.practice_id WHERE s.auto_after_visit = 1 AND s.active = 1')) {
    const local = localNow(survey.timezone, now);
    if (Number(local.slice(11, 13)) < 10) continue;
    const yesterday = new Date(Date.parse(`${local.slice(0, 10)}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    const visits = await db.all(
      `SELECT a.id, a.patient_id FROM appointments a WHERE a.practice_id = ? AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?
         AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.patient_id = a.patient_id AND r.sent_at > ?)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.patient_id = a.patient_id AND m.kind = 'review' AND m.created_at > ?)`,
      survey.practice_id, `${yesterday} 00:00`, `${yesterday} 24:00`,
      new Date(now.getTime() - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' '), new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 19).replace('T', ' '),
    );
    const seen = new Set();
    for (const v of visits) {
      if (seen.has(v.patient_id)) continue;
      seen.add(v.patient_id);
      const patient = await db.get("SELECT * FROM patients WHERE id = ? AND status = 'active'", v.patient_id);
      if (patient && (await sendSurvey(db, messenger, { survey, patient, appointmentId: v.id, appUrl }))?.status === 'sent') sent++;
    }
  }
  return sent;
}
