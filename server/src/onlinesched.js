// Online scheduling (backlog OS1–OS5, docs/workflows/specs/OS-online-scheduling.md): what patients can book online,
// the real open times for it, booking straight into the schedule, and telling the front desk.
//
// - Visit types (online_visit_types) sit on top of appointment types: who may book them (new / existing /
//   anyone), length, providers, offices, lead time, how far ahead, pre-visit questions (emergency triage), and
//   whether a booking goes straight on the schedule or waits as a request for the office.
// - Open times come from the same rules as the schedule (openSlots: provider/office hours, visits, blockouts,
//   reserved blocks, held requests) plus what openSlots doesn't know: perfect-day blocks (production.js), a free
//   chair, the type's buffer and lead time. Held same-day emergency time is a perfect-day block or a reserved
//   block kept for the emergency appointment type — the one existing model for "held time".
// - Booking reuses booking_requests (one per person) and finishBooking (onlinebooking.js): the matching rules
//   (existing charts joined only on name + birth date + phone/email; near misses flagged, never merged), the
//   insurance rules (an existing chart's insurance waits for review) and validateAppt, all in one transaction.
// - Everything a patient does here is recorded with source 'patient'. Analytics hold no personal details.
import { HttpError } from './auth.js';
import { insert, audit, practiceNow, newToken, isRealDate, validEmail, friendlyDateTime } from './util.js';
import { openSlots, INACTIVE, linkRecalls } from './routes/schedule.js';
import { loadTemplates, planDays, blocksOn } from './production.js';
import { finishBooking, matchPatient } from './onlinebooking.js';
import { publish } from './events.js';
import { raiseIssue } from './issues.js';
import { sendVisitsMessage, sendMessage, visitsIcs } from './messaging.js';
import { createPacket } from './formtemplates.js';
import { officeFee } from './fees.js';
import { announce, DEFAULT_CHANNELS } from './chat.js';
import { withActor } from './actor.js';

export const KINDS = ['new_patient', 'emergency', 'hygiene', 'consult', 'other'];
export const KIND_LABELS = { new_patient: 'New patient', emergency: 'Emergency', hygiene: 'Cleaning', consult: 'Consult', other: 'Other' };
const RULES = ['never', 'new_patients', 'always', 'risky_slots'];
const QUESTION_TYPES = ['yesno', 'scale', 'choice', 'text'];
export const STEPS = ['view', 'office', 'reason', 'time', 'details', 'booked', 'requested', 'taken', 'bot'];
export const FLAG_LABELS = {
  urgent: 'Urgent emergency — call them',
  possible_duplicate: 'Possible duplicate chart — check before the visit',
  not_matched: 'Couldn’t match to an existing chart',
  insurance_to_verify: 'Insurance to verify',
  card_to_read: 'Insurance card photo to read and confirm',
  needs_approval: 'Waiting for the office to accept',
  before_recall_due: 'Booked before their cleaning is due (insurance may not cover it)',
  has_upcoming_visit: 'Already has a visit coming up',
  family: 'Family booked together — check the guarantor',
  deposit_paid: 'Deposit paid',
  card_on_file: 'Card saved on file',
  existing_booked_new: 'An existing patient booked a new-patient visit',
};
const PER_DAY = 6;
const MAX_PEOPLE = 6;

// ---- Small helpers ----
export const parseList = (v) => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v || '[]') : v;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};
const ids = (v) => [...new Set(parseList(v).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
// 'YYYY-MM-DD HH:MM' plus minutes (wall-clock arithmetic, as appointment times are stored).
export const shiftMin = (dt, minutes) => new Date(Date.parse(`${dt.replace(' ', 'T')}:00Z`) + minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const digits = (s) => String(s || '').replace(/\D/g, '');
const clip = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) || null);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

// ---- Emergency triage: a few plain questions; the answers decide the urgent flag on the server ----
export const TRIAGE = [
  { key: 'pain', type: 'scale', required: true, urgent_if: { gte: 7 }, label: 'How bad is the pain right now? (0 = none, 10 = worst)', label_es: '¿Qué tan fuerte es el dolor ahora? (0 = nada, 10 = el peor)' },
  { key: 'swelling', type: 'yesno', required: true, urgent_if: { eq: true }, label: 'Any swelling in your face or gums?', label_es: '¿Tiene hinchazón en la cara o las encías?' },
  { key: 'trauma', type: 'yesno', required: true, urgent_if: { eq: true }, label: 'Was a tooth knocked out, broken or loosened by an injury?', label_es: '¿Se le cayó, rompió o aflojó un diente por un golpe?' },
  { key: 'fever', type: 'yesno', urgent_if: { eq: true }, label: 'Do you have a fever?', label_es: '¿Tiene fiebre?' },
];
const CONSULT_TOPIC = {
  key: 'topic', type: 'choice', required: true, label: 'What would you like to talk about?', label_es: '¿De qué le gustaría hablar?',
  options: ['Implants', 'Invisalign / clear aligners', 'Braces', 'Cosmetic / whitening', 'Something else'],
};

// Checks the office's questions for a visit type (Settings).
export function cleanQuestions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'questions must be a list');
  if (list.length > 8) throw new HttpError(400, 'At most 8 questions');
  const keys = new Set();
  return list.map((q, i) => {
    const at = `Question ${i + 1}`;
    const key = String(q?.key || '').trim();
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(key) || keys.has(key)) throw new HttpError(400, `${at}: give it a short unique key (letters, e.g. pain)`);
    keys.add(key);
    if (!QUESTION_TYPES.includes(q.type)) throw new HttpError(400, `${at}: type must be one of ${QUESTION_TYPES.join(', ')}`);
    const label = clip(q.label, 200);
    if (!label) throw new HttpError(400, `${at}: write the question`);
    const out = { key, type: q.type, label, label_es: clip(q.label_es, 200), required: !!q.required };
    if (q.type === 'choice') {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 60)).filter(Boolean).slice(0, 10);
      if (options.length < 2) throw new HttpError(400, `${at}: give at least two choices`);
      out.options = options;
    }
    const u = q.urgent_if;
    if (u && typeof u === 'object') {
      if (q.type === 'scale' && Number.isInteger(Number(u.gte)) && Number(u.gte) >= 0 && Number(u.gte) <= 10) out.urgent_if = { gte: Number(u.gte) };
      else if (q.type === 'yesno' && u.eq === true) out.urgent_if = { eq: true };
      else if (q.type === 'choice' && Array.isArray(u.in)) out.urgent_if = { in: u.in.map(String).filter((o) => out.options.includes(o)) };
    }
    return out;
  });
}

// The patient's answers checked against the questions; urgent when any answer crosses its line.
export function evalAnswers(questions, answers = {}) {
  const clean = {};
  const reasons = [];
  const given = answers && typeof answers === 'object' ? answers : {};
  for (const q of questions) {
    const v = given[q.key];
    const missing = v === undefined || v === null || v === '';
    if (missing) {
      if (q.required) throw new HttpError(400, `Please answer: ${q.label}`);
      continue;
    }
    let val;
    if (q.type === 'scale') {
      val = Number(v);
      if (!Number.isInteger(val) || val < 0 || val > 10) throw new HttpError(400, `Please answer 0 to 10: ${q.label}`);
      if (q.urgent_if?.gte != null && val >= q.urgent_if.gte) reasons.push(`${q.key === 'pain' ? 'pain' : q.key} ${val}/10`);
    } else if (q.type === 'yesno') {
      if (![true, false, 'yes', 'no'].includes(v)) throw new HttpError(400, `Please answer yes or no: ${q.label}`);
      val = v === true || v === 'yes';
      if (q.urgent_if?.eq === true && val) reasons.push(q.key);
    } else if (q.type === 'choice') {
      val = String(v);
      if (!q.options.includes(val)) throw new HttpError(400, `Please choose an answer: ${q.label}`);
      if (q.urgent_if?.in?.includes(val)) reasons.push(val);
    } else {
      val = clip(v, 300);
    }
    clean[q.key] = val;
  }
  return { answers: clean, urgent: reasons.length > 0, reasons };
}

// ---- Settings ----
export async function settingsFor(db, practiceId) {
  await db.run('INSERT INTO online_sched_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', practiceId);
  return await db.get('SELECT * FROM online_sched_settings WHERE practice_id = ?', practiceId);
}

const LOGO = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
export function cleanSettings(body) {
  const out = {};
  const b = body || {};
  if (b.brand_color !== undefined) {
    if (b.brand_color && !/^#[0-9a-f]{6}$/i.test(b.brand_color)) throw new HttpError(400, 'Brand color must look like #0d9488');
    out.brand_color = b.brand_color || null;
  }
  if (b.logo !== undefined) {
    if (!b.logo) { out.logo = null; out.logo_mime = null; } else {
      const m = LOGO.exec(String(b.logo));
      if (!m) throw new HttpError(400, 'The logo must be a PNG, JPEG or WebP picture');
      if (m[3].length * 0.75 > 200_000) throw new HttpError(400, 'The logo is too large (200 KB at most)');
      out.logo = m[3];
      out.logo_mime = m[1];
    }
  }
  for (const k of ['headline', 'headline_es']) if (b[k] !== undefined) out[k] = clip(b[k], 120);
  if (b.notify_chat !== undefined) out.notify_chat = b.notify_chat ? 1 : 0;
  if (b.notify_sms_to !== undefined) {
    const d = digits(b.notify_sms_to);
    if (b.notify_sms_to && !(d.length === 10 || (d.length === 11 && d.startsWith('1')))) throw new HttpError(400, 'The office text number must be a US or Canadian phone number');
    out.notify_sms_to = b.notify_sms_to ? String(b.notify_sms_to).trim().slice(0, 30) : null;
  }
  if (b.family_max !== undefined) {
    const n = Number(b.family_max);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PEOPLE) throw new HttpError(400, `Family bookings: 1 to ${MAX_PEOPLE} people`);
    out.family_max = n;
  }
  if (b.embed_origins !== undefined) {
    const list = (Array.isArray(b.embed_origins) ? b.embed_origins : String(b.embed_origins || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
    for (const o of list) if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new HttpError(400, `Website addresses look like https://www.yourpractice.com (not ${o.slice(0, 60)})`);
    out.embed_origins = list.length ? JSON.stringify(list.slice(0, 10)) : null;
  }
  if (b.risky_weekdays !== undefined) {
    const days = ids(b.risky_weekdays).filter((d) => d <= 6).concat(parseList(b.risky_weekdays).includes(0) ? [0] : []);
    out.risky_weekdays = days.length ? JSON.stringify([...new Set(days)].sort()) : null;
  }
  for (const k of ['risky_before', 'risky_after']) {
    if (b[k] === undefined) continue;
    if (b[k] && !HHMM.test(b[k])) throw new HttpError(400, 'Times must be HH:MM');
    out[k] = b[k] || null;
  }
  return out;
}

// A "no-show prone" slot, by the office's own rule (e.g. Mondays, or before 8:30 / from 4:00).
export function riskySlot(settings, start) {
  const days = parseList(settings?.risky_weekdays).map(Number);
  const t = start.slice(11, 16);
  return days.includes(weekdayOf(start.slice(0, 10))) || (!!settings?.risky_before && t < settings.risky_before) || (!!settings?.risky_after && t >= settings.risky_after);
}

// ---- Visit types ----
// First use: sensible visit types from the practice's own appointment types (the office adjusts them).
export async function ensureVisitTypes(db, practiceId) {
  if ((await db.get('SELECT COUNT(*) AS n FROM online_visit_types WHERE practice_id = ?', practiceId)).n > 0) return;
  const types = await db.all('SELECT * FROM appointment_types WHERE practice_id = ? AND active = 1 ORDER BY online_bookable DESC, sort, id', practiceId);
  const find = (re) => types.find((t) => re.test(t.name)) || null;
  const seeds = [
    { kind: 'new_patient', label: 'New patient exam & cleaning', label_es: 'Examen y limpieza (paciente nuevo)', blurb: 'Your first visit: exam, x-rays and a cleaning', blurb_es: 'Su primera visita: examen, radiografías y limpieza', type: find(/new patient|comprehensive|\bnp\b/i), duration: 60, who: 'new', family: 1, lead: 120, max: 60, mode: 'instant', questions: [] },
    { kind: 'emergency', label: 'Tooth pain / emergency', label_es: 'Dolor de muelas / emergencia', blurb: 'Seen as soon as possible — today when we can', blurb_es: 'Le atendemos lo antes posible, hoy si podemos', type: find(/emergenc|limited|pain|palliative/i), duration: 30, who: 'anyone', family: 0, lead: 30, max: 3, mode: 'instant', questions: TRIAGE },
    { kind: 'hygiene', label: 'Cleaning & checkup', label_es: 'Limpieza y revisión', blurb: 'For current patients, with your hygienist', blurb_es: 'Para pacientes actuales, con su higienista', type: types.find((t) => /recall|prophy|periodic|hygiene|cleaning/i.test(t.name) && !/new patient/i.test(t.name)) || null, duration: 60, who: 'existing', family: 1, lead: 240, max: 120, mode: 'instant', questions: [] },
    { kind: 'consult', label: 'Consultation: implants, Invisalign, braces, cosmetic', label_es: 'Consulta: implantes, Invisalign, frenos, estética', blurb: 'Talk through your options with the doctor', blurb_es: 'Hable de sus opciones con el doctor', type: find(/consult/i), duration: 30, who: 'anyone', family: 0, lead: 240, max: 60, mode: 'request', questions: [CONSULT_TOPIC] },
  ];
  for (const [i, s] of seeds.entries()) {
    await db.run(
      `INSERT INTO online_visit_types (practice_id, kind, label, label_es, blurb, blurb_es, appointment_type_id, duration, lead_minutes, max_days, booking_mode, who, family, questions, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, label) DO NOTHING`,
      practiceId, s.kind, s.label, s.label_es, s.blurb, s.blurb_es, s.type?.id ?? null, s.type?.duration || s.duration, s.lead, s.max, s.mode, s.who, s.family, JSON.stringify(s.questions), i,
    );
  }
}

export async function visitTypes(db, practiceId, { all = false } = {}) {
  await ensureVisitTypes(db, practiceId);
  return (await db.all(`SELECT * FROM online_visit_types WHERE practice_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, practiceId))
    .map((t) => ({ ...t, provider_ids: ids(t.provider_ids), location_ids: ids(t.location_ids), questions: parseList(t.questions) }));
}

// A visit type from Settings, checked. `existing` is the stored row for an edit.
export async function cleanVisitType(db, practiceId, body, existing = null) {
  const b = body || {};
  const row = {};
  const has = (k) => b[k] !== undefined || !existing;
  if (has('kind')) {
    if (!KINDS.includes(b.kind ?? 'other')) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
    row.kind = b.kind ?? 'other';
  }
  if (has('label')) {
    row.label = clip(b.label, 80);
    if (!row.label) throw new HttpError(400, 'Give the visit type a name patients understand, like "New patient exam"');
  }
  for (const k of ['label_es', 'blurb', 'blurb_es']) if (b[k] !== undefined) row[k] = clip(b[k], k === 'label_es' ? 80 : 160);
  if (b.appointment_type_id !== undefined) {
    if (b.appointment_type_id == null || b.appointment_type_id === '') row.appointment_type_id = null;
    else {
      const t = await db.get('SELECT id FROM appointment_types WHERE id = ? AND practice_id = ?', Number(b.appointment_type_id), practiceId);
      if (!t) throw new HttpError(404, 'Appointment type not found');
      row.appointment_type_id = t.id;
    }
  }
  const int = (k, lo, hi, label) => {
    if (b[k] === undefined) return;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${label} must be ${lo}–${hi}`);
    row[k] = n;
  };
  int('duration', 10, 480, 'Length (minutes)');
  if (row.duration != null && row.duration % 10) throw new HttpError(400, 'Length must be in 10-minute steps');
  int('lead_minutes', 0, 20160, 'Lead time (minutes)');
  int('max_days', 1, 365, 'How far ahead (days)');
  int('buffer_minutes', 0, 60, 'Buffer (minutes)');
  int('sort', 0, 1000, 'Order');
  int('deposit', 0, 100_000, 'Deposit (cents)');
  if (b.booking_mode !== undefined) {
    if (!['instant', 'request'].includes(b.booking_mode)) throw new HttpError(400, "booking_mode must be 'instant' or 'request'");
    row.booking_mode = b.booking_mode;
  }
  if (b.who !== undefined) {
    if (!['new', 'existing', 'anyone'].includes(b.who)) throw new HttpError(400, "who must be 'new', 'existing' or 'anyone'");
    row.who = b.who;
  }
  for (const k of ['deposit_rule', 'card_rule']) {
    if (b[k] === undefined) continue;
    if (!RULES.includes(b[k])) throw new HttpError(400, `${k} must be one of ${RULES.join(', ')}`);
    row[k] = b[k];
  }
  if (b.family !== undefined) row.family = b.family ? 1 : 0;
  if (b.active !== undefined) row.active = b.active ? 1 : 0;
  if (b.provider_ids !== undefined) {
    const list = ids(b.provider_ids);
    for (const id of list) if (!(await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', id, practiceId))) throw new HttpError(404, 'Provider not found');
    row.provider_ids = JSON.stringify(list);
  }
  if (b.location_ids !== undefined) {
    const list = ids(b.location_ids);
    for (const id of list) if (!(await db.get('SELECT id FROM locations WHERE id = ? AND practice_id = ?', id, practiceId))) throw new HttpError(404, 'Office not found');
    row.location_ids = JSON.stringify(list);
  }
  if (b.questions !== undefined) row.questions = JSON.stringify(cleanQuestions(b.questions));
  return row;
}

// What the public page shows about a visit type.
export function publicType(t, { settings, payments }) {
  const paid = !!payments?.enabled;
  return {
    id: t.id, kind: t.kind, label: t.label, label_es: t.label_es, blurb: t.blurb, blurb_es: t.blurb_es, duration: t.duration, who: t.who,
    family: !!t.family, family_max: t.family ? settings?.family_max || 4 : 1, mode: t.booking_mode, location_ids: t.location_ids,
    questions: t.questions.map((q) => ({ key: q.key, type: q.type, label: q.label, label_es: q.label_es, required: q.required, options: q.options })),
    deposit: paid && t.deposit_rule !== 'never' ? t.deposit : 0, deposit_rule: paid ? t.deposit_rule : 'never', card_rule: paid ? t.card_rule : 'never',
  };
}

// ---- Open times ----
// Everything the slot search needs once per request: the type's providers, its offices' chairs, the day plans.
export async function searchContext(db, practice, vt, { locationId = null, providerId = null } = {}) {
  const all = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name, id', practice.id);
  const apptType = vt.appointment_type_id ? await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ?', vt.appointment_type_id, practice.id) : null;
  let providers = vt.provider_ids.length ? all.filter((p) => vt.provider_ids.includes(p.id)) : null;
  if (!providers) {
    const kind = apptType?.provider_type || (vt.kind === 'hygiene' ? 'hygienist' : 'dentist');
    providers = all.some((p) => p.type === kind) ? all.filter((p) => p.type === kind) : all;
  }
  if (providerId) providers = providers.filter((p) => p.id === Number(providerId));
  const chairs = await db.all(
    `SELECT id, name, location_id, default_provider_id FROM operatories WHERE practice_id = ? AND active = 1${locationId ? ' AND (location_id = ? OR location_id IS NULL)' : ''} ORDER BY sort, id`,
    practice.id, ...(locationId ? [locationId] : []),
  );
  return {
    practice, vt, apptType, providers: providers.slice(0, 20), chairs, locationId, typeId: vt.appointment_type_id ?? null,
    templates: await loadTemplates(db, practice.id), now: await practiceNow(db, practice.id), dayCache: new Map(),
  };
}

// Busy times of the chairs on a day: visits, chair blockouts and held online requests with a chair.
async function chairBusy(db, ctx, date) {
  if (!ctx.chairs.length) return new Map();
  const list = ctx.chairs.map(() => '?').join(',');
  const cids = ctx.chairs.map((c) => c.id);
  const rows = [
    ...(await db.all(`SELECT operatory_id, start_time, end_time FROM appointments WHERE practice_id = ? AND operatory_id IN (${list}) AND status NOT IN ${INACTIVE} AND start_time < ? AND end_time > ?`, ctx.practice.id, ...cids, `${date} 24:00`, `${date} 00:00`)),
    ...(await db.all(`SELECT operatory_id, start_time, end_time, kind, appointment_type_ids FROM blockouts WHERE practice_id = ? AND operatory_id IN (${list}) AND start_time < ? AND end_time > ?`, ctx.practice.id, ...cids, `${date} 24:00`, `${date} 00:00`))
      .filter((b) => !(b.kind === 'reserved' && ctx.typeId != null && parseList(b.appointment_type_ids).map(Number).includes(Number(ctx.typeId)))),
    ...(await db.all(
      `SELECT operatory_id, requested_start, duration FROM booking_requests WHERE practice_id = ? AND operatory_id IN (${list}) AND status = 'pending' AND requested_start >= ? AND requested_start < ?
         AND (deposit_status = 'paid' OR hold_until > ? OR (deposit_status IS NULL AND created_at > ?))`,
      ctx.practice.id, ...cids, `${date} 00:00`, `${date} 24:00`, new Date().toISOString(), new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    )).map((b) => ({ operatory_id: b.operatory_id, start_time: b.requested_start, end_time: shiftMin(b.requested_start, b.duration || 60) })),
  ];
  const out = new Map();
  for (const r of rows) {
    const s = r.start_time.slice(0, 10) < date ? 0 : toMin(r.start_time.slice(11, 16));
    const e = r.end_time.slice(0, 10) > date ? 1440 : toMin(r.end_time.slice(11, 16));
    if (!out.has(r.operatory_id)) out.set(r.operatory_id, []);
    out.get(r.operatory_id).push([s, e]);
  }
  return out;
}

// Every open start on a day, per provider: { providerId: Map(minute → { start, chair, score, protectedBlock }) }.
// Never a time that isn't free: openSlots (hours, visits, blockouts, held requests) with the buffer added, minus
// perfect-day blocks kept for other visit types (until their release), minus times with no free chair.
export async function openOn(db, ctx, date) {
  if (ctx.dayCache.has(date)) return ctx.dayCache.get(date);
  const { vt, now } = ctx;
  const earliest = shiftMin(now, vt.lead_minutes || 0);
  const last = addDays(now.slice(0, 10), Math.max(0, (vt.max_days || 60) - 1));
  const out = new Map();
  if (date < now.slice(0, 10) || date > last || date < earliest.slice(0, 10)) {
    ctx.dayCache.set(date, out);
    return out;
  }
  const need = vt.duration + (vt.buffer_minutes || 0);
  const plans = await planDays(db, ctx.practice.id, date, date, ctx.templates);
  const chairs = await chairBusy(db, ctx, date);
  const chairFree = (cid, s, e) => !(chairs.get(cid) || []).some(([a, b]) => s < b && e > a);
  for (const p of ctx.providers) {
    const starts = await openSlots(db, ctx.practice.id, p.id, date, { duration: need, step: 10, after: earliest > `${date} 00:00` ? earliest : null, typeId: ctx.typeId, locationId: ctx.locationId });
    if (!starts.length) continue;
    const plan = plans.get(`${p.id}|${date}`);
    const blocks = plan ? blocksOn(plan, date) : [];
    const mins = starts.map((s) => toMin(s.slice(11, 16)));
    const set = new Set(mins);
    const slots = new Map();
    for (const t of mins) {
      const s = `${date} ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const e = shiftMin(s, vt.duration);
      const mine = (b) => ctx.typeId != null && b.appointment_type_ids.includes(Number(ctx.typeId));
      // Kept for other visit types until its release time: not offered (validateAppt would refuse it too).
      if (blocks.some((b) => b.appointment_type_ids.length && !mine(b) && now < b.release_at && b.start_time < e && b.end_time > s)) continue;
      // A chair: the provider's own first, then a free one nobody calls theirs, then any free one.
      let chair = null;
      if (ctx.chairs.length) {
        const order = [...ctx.chairs].sort((a, b) => (a.default_provider_id === p.id ? 0 : a.default_provider_id == null ? 1 : 2) - (b.default_provider_id === p.id ? 0 : b.default_provider_id == null ? 1 : 2));
        chair = order.find((c) => chairFree(c.id, t, t + vt.duration)) || null;
        if (!chair) continue;
      }
      // Smart ordering: a time that starts or ends against something (a visit, the start of the day) fills the
      // schedule; one that leaves a sliver under 30 minutes wastes it. Production blocks are protected: offered
      // to other visit types only when little else is open.
      let before = 0;
      while (set.has(t - (before + 10))) before += 10;
      let after = 0;
      while (set.has(t + after + 10)) after += 10;
      let score = 0;
      score += before === 0 ? 3 : before < 30 ? -3 : 0;
      score += after === 0 ? 3 : after < 30 ? -3 : 0;
      score += t % 30 === 0 ? 1 : t % 15 === 0 ? 0.5 : 0;
      if (t % 15 && before && after) continue; // an odd start only when it fits snugly
      const protectedBlock = blocks.some((b) => (b.goal > 0 || b.appointment_type_ids.length) && !mine(b) && b.start_time < e && b.end_time > s);
      if (protectedBlock) score -= 6;
      slots.set(t, { start: s, chair: chair?.id ?? null, score, protectedBlock });
    }
    if (slots.size) out.set(p.id, slots);
  }
  ctx.dayCache.set(date, out);
  return out;
}

// Options on a day for `people` (1, or a family back-to-back: the next person starts when the one before
// finishes; the same provider when free, else another who fits). prefer: per person, providers to try first.
export async function optionsOn(db, ctx, date, { people = 1, prefer = [] } = {}) {
  const open = await openOn(db, ctx, date);
  if (!open.size) return [];
  const starts = [...new Set([...open.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
  const byId = new Map(ctx.providers.map((p) => [p.id, p]));
  const options = [];
  for (const t0 of starts) {
    const items = [];
    let t = t0;
    let prev = null;
    let score = null;
    let prot = false;
    for (let i = 0; i < people; i++) {
      // Free at this time, in the order they're wanted: the person's own provider(s), the provider of the person
      // before (families together), then everyone else; with no preference, the best-fitting time.
      const order = [...new Set([...(prefer[i] || []), ...(prev ? [prev] : []), ...ctx.providers.map((p) => p.id)])].filter((pid) => byId.has(pid) && open.get(pid)?.has(t));
      if (!order.length) break;
      let pid = order.find((x) => prefer[i]?.includes(x) || x === prev);
      if (!pid) pid = order.reduce((a, b) => (open.get(b).get(t).score > open.get(a).get(t).score ? b : a));
      const slot = open.get(pid).get(t);
      items.push({ start: slot.start, provider_id: pid, provider_name: byId.get(pid).name, operatory_id: slot.chair });
      score = score == null ? slot.score : Math.min(score, slot.score);
      prot ||= slot.protectedBlock;
      prev = pid;
      t += ctx.vt.duration;
    }
    if (items.length === people) options.push({ start: items[0].start, items, score, protected: prot });
  }
  return options;
}

// A short, useful list for a day: emergencies see the earliest times; everyone else the best-fitting times
// spread through the day (protected production time only when there's little else), in time order.
export function pickForDay(options, vt) {
  if (!options.length) return [];
  if (vt.kind === 'emergency') return options.slice(0, 8).map((o, i) => ({ ...o, best: i === 0 }));
  const open = options.filter((o) => !o.protected);
  const pool = open.length >= 3 ? open : options;
  const ranked = [...pool].sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
  const picked = [];
  for (const o of ranked) {
    if (picked.length >= PER_DAY) break;
    const m = toMin(o.start.slice(11, 16));
    if (picked.some((p) => Math.abs(toMin(p.start.slice(11, 16)) - m) < 30)) continue;
    picked.push(o);
  }
  const top = picked[0];
  return picked.sort((a, b) => a.start.localeCompare(b.start)).map((o) => ({ ...o, best: o === top }));
}

// The next few days with openings from `from`.
export async function searchDays(db, ctx, { from = null, people = 1, days = 4, prefer = [] } = {}) {
  const today = ctx.now.slice(0, 10);
  let d = from && from > today ? from : today;
  const last = addDays(today, Math.max(0, (ctx.vt.max_days || 60) - 1));
  const out = [];
  for (let i = 0; i < 60 && out.length < days && d <= last; i++, d = addDays(d, 1)) {
    const options = pickForDay(await optionsOn(db, ctx, d, { people, prefer }), ctx.vt);
    if (options.length) out.push({ date: d, options: options.map(publicOption) });
  }
  return { days: out, next_from: d <= last ? d : null };
}
const publicOption = (o) => ({ start: o.start, best: !!o.best, items: o.items.map((x) => ({ start: x.start, provider_id: x.provider_id, provider_name: x.provider_name })) });

// When the chosen time was just taken: the nearest open times on that day and the next few.
export async function nearestOptions(db, ctx, start, { people = 1, prefer = [] } = {}) {
  ctx.dayCache.clear();
  const found = [];
  for (let i = 0, d = start.slice(0, 10); i < 7 && found.length < 12; i++, d = addDays(d, 1)) {
    found.push(...await optionsOn(db, ctx, d, { people, prefer }));
  }
  const at = Date.parse(`${start.replace(' ', 'T')}:00Z`);
  return found.sort((a, b) => Math.abs(Date.parse(`${a.start.replace(' ', 'T')}:00Z`) - at) - Math.abs(Date.parse(`${b.start.replace(' ', 'T')}:00Z`) - at))
    .slice(0, 3).map(publicOption);
}

// ---- Booking ----
const PHONE_OK = (d) => d.length === 10 || (d.length === 11 && d.startsWith('1'));

// Checks the submitted people and contact details (everything a public form sends is untrusted).
export function cleanPeople(body, vt, familyMax) {
  const list = Array.isArray(body.people) ? body.people : [];
  if (!list.length) throw new HttpError(400, 'Tell us who the visit is for');
  const max = vt.family ? Math.min(familyMax || 4, MAX_PEOPLE) : 1;
  if (list.length > max) throw new HttpError(400, max === 1 ? 'This visit is booked one person at a time' : `Up to ${max} people at once`);
  const phone = clip(body.phone, 30);
  const email = clip(body.email, 200);
  if (!phone && !email) throw new HttpError(400, 'A mobile number or email is needed so we can confirm');
  // Texts only go to US/Canada numbers (confirmations to arbitrary international numbers are a known fraud).
  if (phone && !PHONE_OK(digits(phone))) throw new HttpError(400, 'Please enter a US or Canadian phone number, or use email');
  if (email && !validEmail(email)) throw new HttpError(400, 'Please check your email address');
  const today = new Date().toISOString().slice(0, 10);
  return list.map((p, i) => {
    const first = clip(p?.first_name, 80);
    const last = clip(p?.last_name, 80);
    if (!first || !last) throw new HttpError(400, i ? `Person ${i + 1}: first and last name, please` : 'First and last name, please');
    const dob = String(p?.dob || '').trim();
    if (!isRealDate(dob) || dob > today || dob < '1900-01-01') throw new HttpError(400, `${first}: please check the date of birth`);
    return { first_name: first, last_name: last, dob, phone, email };
  });
}

const CARD_MIME = /^image\/(jpeg|png|webp)$/;
export function cleanCards(ins) {
  const out = [];
  for (const side of [ins?.card_front, ins?.card_back]) {
    if (!side) continue;
    const data = String(side.file_base64 || '');
    if (!CARD_MIME.test(String(side.mime || '')) || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, 'The card photo must be a JPEG or PNG picture');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 700_000) throw new HttpError(400, 'That card photo is too large');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const webp = bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!jpeg && !png && !webp) throw new HttpError(400, 'The card photo must be a JPEG or PNG picture');
    out.push({ bytes, mime: jpeg ? 'image/jpeg' : png ? 'image/png' : 'image/webp' });
  }
  return out;
}

// Where the booking came from: ?src= on the link (google, website, facebook, qr…) and standard UTM tags, plus the
// referring site's host. Short slugs only — never a full URL or anything personal.
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
export function cleanSource(s = {}) {
  const pick = (v) => (SLUG.test(String(v || '')) ? String(v).toLowerCase() : null);
  let ref = null;
  try {
    if (s.ref) ref = new URL(/^https?:/.test(String(s.ref)) ? String(s.ref) : `https://${s.ref}`).hostname.slice(0, 80) || null;
  } catch { ref = null; }
  // A promo code (typed on the page or ?promo=) and a patient's referral link code (?rp=) — marketing.js reads them.
  const promo = /^[A-Za-z0-9_-]{2,20}$/.test(String(s.promo || '').trim()) ? String(s.promo).trim().toUpperCase() : null;
  const rp = /^[A-Za-z0-9]{6,16}$/.test(String(s.rp || '')) ? String(s.rp).toUpperCase() : null;
  return { source: pick(s.src) || pick(s.utm_source) || (ref ? 'referral' : 'direct'), utm_source: pick(s.utm_source), utm_medium: pick(s.utm_medium), utm_campaign: pick(s.utm_campaign), referrer_host: ref, variant: ['a', 'b'].includes(s.variant) ? s.variant : null, promo_code: promo, referral_code: rp };
}

// Anonymous funnel steps. The session key is random from the page; nothing else about the person is kept.
export async function recordStep(db, practiceId, { session, step, kind = null, source = null, variant = null, day }) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(session || '')) || !STEPS.includes(step)) return false;
  await db.run(
    'INSERT INTO online_booking_events (practice_id, session_key, step, visit_kind, source, variant, day) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, session_key, step) DO NOTHING',
    practiceId, String(session), step, KINDS.includes(kind) ? kind : null, SLUG.test(String(source || '')) ? String(source).toLowerCase() : null, ['a', 'b'].includes(variant) ? variant : null, day,
  );
  return true;
}

// The whole booking: validated, then planned and written in one transaction (the time re-checked inside it,
// so two people can't take the same time), then everyone who needs to know is told.
// deps: { db, messenger, payments, storage, config }; returns the patient-facing result.
export async function bookOnline(deps, practice, body, { ip = null } = {}) {
  const { db, payments, storage, config = {} } = deps;
  const pid = practice.id;
  const key = String(body.key || '');
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(key)) throw new HttpError(400, 'Missing booking key — please reload the page');
  const prior = await db.get('SELECT * FROM online_bookings WHERE practice_id = ? AND submit_key = ?', pid, key);
  if (prior) return await replay(deps, prior);

  const settings = await settingsFor(db, pid);
  const vt = (await visitTypes(db, pid)).find((t) => t.id === Number(body.visit_type_id));
  if (!vt) throw new HttpError(400, 'Choose what the visit is for');
  const offices = await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', pid);
  let location = null;
  if (offices.length) {
    location = offices.find((l) => l.id === Number(body.location_id)) || (offices.length === 1 ? offices[0] : null);
    if (!location) throw new HttpError(400, 'Choose an office');
    if (vt.location_ids.length && !vt.location_ids.includes(location.id)) throw new HttpError(400, 'That visit isn’t booked online at this office');
  }
  const people = cleanPeople(body, vt, settings.family_max);
  const { answers, urgent, reasons } = evalAnswers(vt.questions, body.answers);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(body.start || ''));
  if (!m) throw new HttpError(400, 'Choose a time');
  const start = `${m[1]} ${m[2]}`;
  const ins = body.insurance || {};
  const carrier = clip(ins.carrier, 100);
  const memberId = clip(ins.member_id, 40)?.replace(/\s+/g, '') || null;
  const subscriber = clip(ins.subscriber, 120);
  const cards = cleanCards(ins);
  const notes = clip(body.notes, 500);
  const src = cleanSource(body.source || {});
  const lang = body.language === 'es' ? 'es' : null;
  const asap = body.asap ? 1 : 0;
  const preferProvider = body.provider_id ? Number(body.provider_id) : null;

  // Who they are (read-only here; charts are made in the transaction by finishBooking).
  const matches = [];
  for (const p of people) matches.push(await matchPatient(db, pid, p));
  const newPeople = matches.filter((x) => !x.sure).length;
  const flags = new Set();
  if (urgent) flags.add('urgent');
  if (people.length > 1) flags.add('family');
  if (matches.some((x) => x.nearMiss)) flags.add('possible_duplicate');
  if (vt.who === 'new' && matches.some((x) => x.sure)) flags.add('existing_booked_new');
  let mode = vt.booking_mode;
  if (vt.who === 'existing' && matches.some((x) => !x.sure)) { flags.add('not_matched'); mode = 'request'; }
  if (mode === 'request') flags.add('needs_approval');
  // Hygiene with their own hygienist when that person is free at the time; before the cleaning is due is flagged.
  const prefer = [];
  for (const [i, x] of matches.entries()) {
    const own = x.sure ? await db.get('SELECT primary_hygienist_id, primary_provider_id FROM patients WHERE id = ?', x.sure.id) : null;
    prefer[i] = [...(i === 0 && preferProvider ? [preferProvider] : []), ...(vt.kind === 'hygiene' && own?.primary_hygienist_id ? [own.primary_hygienist_id] : []), ...(own?.primary_provider_id ? [own.primary_provider_id] : [])];
    if (x.sure) {
      if (vt.kind === 'hygiene') {
        const due = await db.get("SELECT MIN(due_date) AS d FROM recalls WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted')", pid, x.sure.id);
        if (due?.d && start.slice(0, 10) < due.d) flags.add('before_recall_due');
      }
      if (await db.get(`SELECT id FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ('scheduled','confirmed') AND start_time > ?`, pid, x.sure.id, await practiceNow(db, pid))) flags.add('has_upcoming_visit');
    }
  }
  let insuranceStatus = 'none';
  if (cards.length) { insuranceStatus = 'card_photo'; flags.add('card_to_read'); } else if (carrier && memberId) { insuranceStatus = 'to_verify'; flags.add('insurance_to_verify'); } else if (matches[0].sure && await db.get('SELECT id FROM patient_insurance WHERE patient_id = ? AND active = 1 LIMIT 1', matches[0].sure.id)) insuranceStatus = 'on_file';

  // Deposit and card on file: only when card payments are set up, for one person, by the type's rule.
  const applies = (rule) => payments?.enabled && people.length === 1
    && (rule === 'always' || (rule === 'new_patients' && newPeople > 0) || (rule === 'risky_slots' && riskySlot(settings, start)));
  const deposit = vt.deposit > 0 && applies(vt.deposit_rule) ? vt.deposit : 0;
  const wantCard = applies(vt.card_rule);

  // Card photos are stored (encrypted) before the transaction; the chart gets them when the visit is booked.
  const files = [];
  for (const c of cards) {
    const saved = await storage.save(pid, c.bytes);
    files.push({ storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, mime: c.mime, size: c.bytes.length });
  }

  const ctx = await searchContext(db, practice, vt, { locationId: location?.id ?? null, providerId: preferProvider });
  if (!ctx.providers.length) throw new HttpError(400, 'Choose one of the times shown');
  const today = ctx.now.slice(0, 10);
  let outcome;
  try {
    outcome = await db.tx(async () => {
      // One booking at a time per practice while the time is checked and taken (SQLite already runs one transaction at a time).
      if (db.dialect === 'postgres') await db.run(`SELECT pg_advisory_xact_lock(7342, ${Number(pid)})`);
      const obId = await insert(db, 'online_bookings', {
        practice_id: pid, location_id: location?.id ?? null, visit_type_id: vt.id, submit_key: key, people: people.length, first_start: start,
        new_patients: newPeople, urgent: urgent ? 1 : 0, triage: vt.questions.length ? JSON.stringify(answers) : null, insurance_status: insuranceStatus,
        ...src, language: lang, asap,
      });
      ctx.dayCache.clear();
      ctx.now = await practiceNow(db, pid);
      const option = (await optionsOn(db, ctx, start.slice(0, 10), { people: people.length, prefer })).find((o) => o.start === start);
      if (!option) throw Object.assign(new HttpError(409, 'That time was just taken — here are the nearest open times'), { taken: true });
      const requestIds = [];
      for (const [i, p] of people.entries()) {
        const it = option.items[i];
        const reqId = await insert(db, 'booking_requests', {
          practice_id: pid, first_name: p.first_name, last_name: p.last_name, dob: p.dob, phone: p.phone, email: p.email,
          reason: ctx.apptType?.name || vt.label, duration: vt.duration, provider_id: it.provider_id, operatory_id: it.operatory_id, requested_start: it.start,
          new_patient: matches[i].sure ? 0 : 1, notes: [notes, i === 0 && vt.questions.length ? answerText(vt.questions, answers) : null].filter(Boolean).join(' · ') || null,
          ip, language: lang, location_id: location?.id ?? null, source: src.source, referral_source: clip(body.referral_source, 100),
          online_booking_id: obId, visit_type_id: vt.id, urgent: urgent ? 1 : 0, answers: i === 0 && vt.questions.length ? JSON.stringify(answers) : null, asap,
          ...(i === 0 ? { insurance_carrier: carrier, insurance_member_id: memberId, insurance_subscriber: subscriber, card_files: files.length ? JSON.stringify(files) : null } : {}),
          ...(deposit ? { deposit_amount: deposit, deposit_status: payments.mode === 'stripe' ? 'awaiting' : 'paid', hold_until: new Date(Date.now() + 35 * 60_000).toISOString(),
            ...(payments.mode === 'stripe' ? {} : { deposit_reference: `sbx_dep_${key.slice(0, 16)}` }) } : {}),
        });
        requestIds.push(reqId);
      }
      let status = mode === 'instant' ? 'booked' : 'requested';
      if (deposit && payments.mode === 'stripe') status = 'awaiting_deposit';
      else if (deposit) flags.add('deposit_paid');
      const apptIds = [];
      if (status === 'booked') {
        for (const [i, reqId] of requestIds.entries()) {
          const b = await db.get('SELECT * FROM booking_requests WHERE id = ?', reqId);
          const apptId = await finishBooking(db, b, { providerId: option.items[i].provider_id, start: option.items[i].start, duration: vt.duration, operatoryId: option.items[i].operatory_id });
          apptIds.push(apptId);
          await addTypeProcedures(db, pid, ctx.apptType, apptId);
          await linkRecalls(db, pid, apptId);
        }
      }
      await db.run('UPDATE online_bookings SET status = ?, flags = ?, result = ? WHERE id = ?', status, JSON.stringify([...flags]), JSON.stringify({ request_ids: requestIds, appointment_ids: apptIds }), obId);
      return { obId, status, requestIds, apptIds, option };
    });
  } catch (err) {
    // Taken between the check and the write (validateAppt's own conflict check), or by the option check itself.
    if (err.taken || err.status === 409) {
      const nearest = await nearestOptions(db, ctx, start, { people: people.length, prefer });
      throw new HttpError(409, 'That time was just taken — here are the nearest open times', { taken: true, nearest });
    }
    // The same key raced itself: the first booking stands.
    const again = await db.get('SELECT * FROM online_bookings WHERE practice_id = ? AND submit_key = ?', pid, key);
    if (again) return await replay(deps, again);
    throw err;
  }

  const firstPatient = outcome.apptIds.length ? (await db.get('SELECT patient_id FROM appointments WHERE id = ?', outcome.apptIds[0])).patient_id : null;
  await audit(db, { ip, user: { practice_id: pid, id: null } }, `online_booking.${outcome.status}`, 'online_bookings', outcome.obId, {
    visit_type_id: vt.id, kind: vt.kind, people: people.length, start, appointment_ids: outcome.apptIds, request_ids: outcome.requestIds, flags: [...flags], source: src.source,
  }, { source: 'patient', actor: 'Patient (online booking)', patientId: firstPatient, locationId: location?.id ?? null });

  // A deposit on Stripe's page first; the booking completes when Stripe says it's paid (routes/payments.js).
  let checkoutUrl = null;
  if (outcome.status === 'awaiting_deposit') {
    try {
      const back = `${config.appUrl}/book/${practice.slug}`;
      const session = await payments.stripe('POST', 'checkout/sessions', {
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(deposit),
        'line_items[0][price_data][product_data][name]': `${practice.name} — deposit for ${vt.label}`, 'metadata[booking_request_id]': String(outcome.requestIds[0]),
        'metadata[practice_id]': String(pid), 'payment_intent_data[metadata][practice_id]': String(pid), client_reference_id: `booking-${outcome.requestIds[0]}`,
        ...(people[0].email ? { customer_email: people[0].email } : {}), expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
        success_url: `${back}?deposit=paid`, cancel_url: `${back}?deposit=cancelled`,
      });
      await db.run('UPDATE booking_requests SET deposit_session_id = ? WHERE id = ?', session.id, outcome.requestIds[0]);
      checkoutUrl = session.url;
    } catch (err) {
      await db.run("UPDATE booking_requests SET status = 'declined', deposit_status = 'expired' WHERE id = ?", outcome.requestIds[0]);
      await db.run("UPDATE online_bookings SET status = 'declined' WHERE id = ?", outcome.obId);
      await raiseIssue(db, { practiceId: pid, kind: 'payment', key: `online-deposit:${outcome.obId}`, role: 'front_desk', entity: 'online_bookings', entityId: outcome.obId, title: 'An online booking couldn’t open the deposit card page, so it wasn’t booked', detail: err.message });
      throw new HttpError(502, 'We couldn’t open the secure card page — please try again or call us');
    }
  }
  // Card on file: Stripe's own page (card numbers never reach this server); the sandbox saves a test card.
  let cardUrl = null;
  if (wantCard && firstPatient) {
    if (payments.mode === 'stripe') {
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', firstPatient);
      cardUrl = await payments.cardSetupUrl(db, patient, { successUrl: `${config.appUrl}/book/${practice.slug}?card=saved`, cancelUrl: `${config.appUrl}/book/${practice.slug}?card=skipped` }).catch(async (err) => {
        await raiseIssue(db, { practiceId: pid, kind: 'payment', key: `online-card:${outcome.obId}`, role: 'front_desk', entity: 'online_bookings', entityId: outcome.obId, patientId: firstPatient, title: 'Couldn’t open the card-on-file page for an online booking — ask for a card at check-in', detail: err.message });
        return null;
      });
    } else if (!(await db.get('SELECT id FROM payment_methods WHERE patient_id = ? AND removed_at IS NULL', firstPatient))) {
      await insert(db, 'payment_methods', { practice_id: pid, patient_id: firstPatient, provider: 'sandbox', payment_method_id: `sbx_pm_${key.slice(0, 16)}`, brand: 'visa', last4: '4242', exp_month: 12, exp_year: new Date().getUTCFullYear() + 3 });
      flags.add('card_on_file');
      await db.run('UPDATE online_bookings SET flags = ? WHERE id = ?', JSON.stringify([...flags]), outcome.obId);
    }
  }
  await recordStep(db, pid, { session: body.session, step: outcome.status === 'booked' ? 'booked' : 'requested', kind: vt.kind, source: src.source, variant: src.variant, day: today });

  // The front desk hears straight away; then the patient's confirmation, forms and the card read. None of these
  // can undo the booking; each failure becomes a Needs attention item.
  await tellOffice(deps, practice, outcome.obId).catch((err) => raiseIssue(db, { practiceId: pid, kind: 'schedule', key: `online-alert:${outcome.obId}`, role: 'front_desk', entity: 'online_bookings', entityId: outcome.obId, title: 'An online booking came in but the front-desk alert failed — check Online requests', detail: err.message }));
  if (outcome.status === 'booked') {
    await afterBooked(deps, practice, outcome, { newPeople: matches.map((x) => !x.sure), recipientFirst: true });
  }
  const result = await resultFor(deps, practice, outcome.obId);
  return { ...result, checkout_url: checkoutUrl, card_url: cardUrl };
}

const answerText = (questions, answers) => questions.filter((q) => answers[q.key] !== undefined).map((q) => {
  const v = answers[q.key];
  return `${q.key}: ${v === true ? 'yes' : v === false ? 'no' : v}${q.type === 'scale' ? '/10' : ''}`;
}).join(', ');

// The visit type's procedures go on the visit (planned), as when the front desk books it, so the schedule shows
// its production. Codes that need a tooth are left for the office.
async function addTypeProcedures(db, pid, type, apptId) {
  if (!type?.procedure_codes) return;
  const appt = await db.get('SELECT patient_id, provider_id, location_id FROM appointments WHERE id = ?', apptId);
  for (const code of parseList(type.procedure_codes)) {
    const pc = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, code);
    if (!pc || pc.requires_tooth) continue;
    await insert(db, 'procedures', {
      practice_id: pid, patient_id: appt.patient_id, appointment_id: apptId, provider_id: appt.provider_id, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category,
      fee: await officeFee(db, pid, pc, { patientId: appt.patient_id, providerId: appt.provider_id, locationId: appt.location_id }),
    });
  }
}

// After a visit is on the schedule: the confirmation (with its calendar file), health history and intake forms
// for new patients, and a first read of an insurance card photo for the office to confirm.
async function afterBooked(deps, practice, outcome, { newPeople }) {
  const { db, messenger, config = {} } = deps;
  const pid = practice.id;
  if (messenger) {
    const msg = await sendVisitsMessage(db, messenger, { appointmentIds: outcome.apptIds, kind: 'booking_confirmation', appUrl: config.appUrl, fallback: true }).catch((err) => ({ status: 'failed', error: err.message }));
    if (!msg || msg.status !== 'sent') {
      await raiseIssue(db, { practiceId: pid, kind: 'message', key: `online-confirm:${outcome.obId}`, role: 'front_desk', entity: 'online_bookings', entityId: outcome.obId, title: 'A patient booked online but the confirmation didn’t go — call to confirm', detail: msg?.error || null });
    }
    for (const [i, apptId] of outcome.apptIds.entries()) {
      if (!newPeople[i]) continue;
      const patient = await db.get('SELECT p.* FROM patients p JOIN appointments a ON a.patient_id = p.id WHERE a.id = ?', apptId);
      const templates = (await db.all("SELECT id FROM form_templates WHERE practice_id = ? AND active = 1 AND auto_send = 1 AND kind <> 'consent' AND procedure_codes IS NULL", pid)).map((t) => t.id);
      await createPacket(db, messenger, { practiceId: pid, patient, templateIds: templates, history: true, appointmentId: apptId, send: 'auto', appUrl: config.appUrl })
        .catch((err) => raiseIssue(db, { practiceId: pid, kind: 'message', key: `online-forms:${apptId}`, role: 'front_desk', entity: 'appointments', entityId: apptId, patientId: patient.id, title: `New patient forms couldn’t be sent to ${patient.first_name} ${patient.last_name} after booking online`, detail: err.message }));
    }
  }
  readCardLater(deps, pid, outcome.apptIds[0]);
}

// The card photo is read in the background (AI when it's on, the sandbox reader on demo servers) into the pending
// insurance update; a person checks it against the photo and enters it (Insurance tab). Nothing is saved as a policy.
function readCardLater(deps, pid, apptId) {
  const { db, config = {} } = deps;
  setImmediate(() => withActor({ source: 'ai', actor: 'AI card reader (online booking)', practiceId: pid }, async () => {
    const upd = await db.get(
      "SELECT u.*, p.first_name, p.last_name, p.dob FROM insurance_updates u JOIN patients p ON p.id = u.patient_id JOIN appointments a ON a.patient_id = u.patient_id WHERE a.id = ? AND u.status = 'pending' AND u.document_ids IS NOT NULL AND u.member_id IS NULL ORDER BY u.id DESC LIMIT 1",
      apptId,
    );
    if (!upd) return;
    const mod = await import('./routes/insuranceai.js');
    const sandbox = config.ediMode === 'sandbox' || config.cardReader === 'sandbox' || process.env.CARD_READER === 'sandbox';
    const docId = parseList(upd.document_ids)[0];
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', docId);
    if (!doc || !deps.storage?.read) return;
    const bytes = await deps.storage.read(doc.storage_key, !!doc.encrypted).catch(() => null);
    if (!bytes) return;
    let read = null;
    const { aiClient, structured } = await import('./ai.js');
    if (aiClient(config) && mod.CARD_TOOL && mod.CARD_SYSTEM) {
      read = await structured(config, { system: mod.CARD_SYSTEM, tool: mod.CARD_TOOL, effort: 'low', maxTokens: 4000, content: [{ type: 'image', source: { type: 'base64', media_type: doc.mime, data: Buffer.from(bytes).toString('base64') } }, { type: 'text', text: 'The front of the card. Read it.' }] });
    } else if (sandbox && mod.sandboxCard) read = mod.sandboxCard(Buffer.from(bytes), upd);
    if (!read?.member_id && !read?.carrier_name) return;
    const note = `${upd.note || ''} — read by ${aiClient(config) ? 'AI' : 'the sandbox card reader (made-up values)'} from the photo; check against the photo before entering`.slice(0, 300);
    await db.run('UPDATE insurance_updates SET carrier_name = COALESCE(carrier_name, ?), member_id = ?, group_number = COALESCE(group_number, ?), subscriber_name = COALESCE(subscriber_name, ?), note = ? WHERE id = ?',
      clip(read.carrier_name, 100), clip(read.member_id, 60), clip(read.group_number, 60), clip(read.subscriber_name, 100), note, upd.id);
    await audit(db, null, 'insurance_card.ai_read', 'insurance_updates', upd.id, { from: 'online_booking', fields: Object.keys(read).filter((k) => read[k]) }, { source: 'ai', actor: 'AI card reader (online booking)', patientId: upd.patient_id, reason: 'Card photo sent with an online booking; a person confirms before it is entered' });
  }).catch((err) => raiseIssue(deps.db, { practiceId: pid, kind: 'ai', key: `online-card-read:${apptId}`, role: 'front_desk', title: 'An insurance card photo from an online booking couldn’t be read — read it on the Insurance tab', detail: err.message })));
}

// ---- Telling the front desk (OS4) ----
export async function bookingSummary(db, obId) {
  const ob = await db.get(
    `SELECT o.*, t.label AS type_label, t.kind AS type_kind, l.name AS location_name FROM online_bookings o LEFT JOIN online_visit_types t ON t.id = o.visit_type_id
     LEFT JOIN locations l ON l.id = o.location_id WHERE o.id = ?`, obId,
  );
  if (!ob) return null;
  const people = await db.all(
    `SELECT b.id, b.first_name, b.last_name, b.requested_start, b.status, b.new_patient, b.patient_id, b.appointment_id, b.possible_duplicate_id, b.provider_id, pv.name AS provider_name
     FROM booking_requests b LEFT JOIN providers pv ON pv.id = b.provider_id WHERE b.online_booking_id = ? ORDER BY b.requested_start, b.id`, obId,
  );
  const flags = parseList(ob.flags);
  return {
    id: ob.id, status: ob.status, created_at: ob.created_at, location_id: ob.location_id, location_name: ob.location_name, visit_type_id: ob.visit_type_id,
    type_label: ob.type_label, kind: ob.type_kind, first_start: ob.first_start, urgent: !!ob.urgent, triage: ob.triage ? JSON.parse(ob.triage) : null,
    insurance_status: ob.insurance_status, new_patients: ob.new_patients, source: ob.source, utm_source: ob.utm_source, utm_medium: ob.utm_medium, utm_campaign: ob.utm_campaign,
    referrer_host: ob.referrer_host, asap: !!ob.asap, flags, flag_labels: flags.map((f) => FLAG_LABELS[f] || f), needs_person: flags.some((f) => !['family', 'deposit_paid', 'card_on_file'].includes(f)),
    seen_at: ob.seen_at, seen_by: ob.seen_by, patient_id: people[0]?.patient_id ?? null,
    people: people.map((p) => ({ ...p, new_patient: !!p.new_patient })),
  };
}

const INSURANCE_WORDS = { none: 'no insurance given', on_file: 'insurance on file', to_verify: 'insurance typed in — to verify', card_photo: 'card photo — to read' };
export function alertText(s) {
  const who = s.people.map((p) => `${p.first_name} ${p.last_name}`).join(', ');
  const when = friendlyDateTime(s.first_start);
  const newOld = s.people.every((p) => p.new_patient) ? 'new patient' : s.people.some((p) => p.new_patient) ? 'new and existing' : 'existing patient';
  const verb = s.status === 'booked' ? 'booked' : s.status === 'awaiting_deposit' ? 'is paying a deposit for' : 'requested';
  const triage = s.urgent && s.triage ? ` (${Object.entries(s.triage).filter(([, v]) => v !== false).map(([k, v]) => `${k}: ${v === true ? 'yes' : v}`).join(', ')})` : '';
  const needs = s.flag_labels.filter((_, i) => !['family', 'deposit_paid', 'card_on_file'].includes(s.flags[i]));
  return `${s.urgent ? '🚨 ' : ''}Online: ${who} ${verb} ${s.type_label || 'a visit'} — ${when}${s.people[0]?.provider_name ? ` with ${s.people[0].provider_name}` : ''}${s.location_name ? ` at ${s.location_name}` : ''}. ${newOld[0].toUpperCase()}${newOld.slice(1)}, ${INSURANCE_WORDS[s.insurance_status] || 'insurance unknown'}.${triage}${needs.length ? ` Needs a person: ${needs.join('; ')}.` : ''}${s.source ? ` Source: ${s.source}.` : ''}`;
}

// Front-desk channel in team chat (created the same way chat.js does, if nobody has opened chat yet).
async function postToFrontDesk(db, practiceId, { body, patientId, locationId, urgent }) {
  const def = DEFAULT_CHANNELS.find((c) => c.slug === 'front-desk');
  await db.run("INSERT INTO chat_channels (practice_id, kind, name, slug, topic, audience) VALUES (?, 'channel', ?, ?, ?, ?) ON CONFLICT (practice_id, slug) DO NOTHING", practiceId, def.name, def.slug, def.topic, def.audience);
  const channel = await db.get("SELECT * FROM chat_channels WHERE practice_id = ? AND slug = 'front-desk'", practiceId);
  const made = await db.run(
    "INSERT INTO chat_messages (practice_id, channel_id, source, kind, body, patient_id, location_id, urgent) VALUES (?, ?, 'patient', 'system', ?, ?, ?, ?)",
    practiceId, channel.id, body.slice(0, 3900), patientId ?? null, locationId ?? null, urgent ? 1 : 0,
  );
  await announce(db, channel, { event: 'message', message_id: made.id, parent_id: null, mentions: [], urgent: !!urgent, by: null });
  return made.id;
}

export async function tellOffice(deps, practice, obId) {
  const { db, messenger } = deps;
  const pid = practice.id;
  const s = await bookingSummary(db, obId);
  const settings = await settingsFor(db, pid);
  // Live: ids only (every open screen in the practice gets it); screens fetch the details they may see.
  publish(pid, { type: 'online_booking', id: obId, urgent: s.urgent, needs_person: s.needs_person });
  publish(pid, { type: 'schedule', dates: [s.first_start.slice(0, 10)], source: 'patient' });
  publish(pid, { type: 'tasks' });
  const today = (await practiceNow(db, pid)).slice(0, 10);
  if (s.urgent) {
    const p = s.people[0];
    await insert(db, 'tasks', {
      practice_id: pid, patient_id: p.patient_id ?? null, priority: 'high', due_date: today,
      title: `Urgent emergency booked online: ${p.first_name} ${p.last_name}, ${friendlyDateTime(s.first_start)} — call them now (${s.triage ? Object.entries(s.triage).map(([k, v]) => `${k} ${v === true ? 'yes' : v === false ? 'no' : v}`).join(', ') : 'see triage'})`.slice(0, 250),
    });
  }
  if (settings.notify_chat) {
    const mid = await postToFrontDesk(db, pid, { body: alertText(s), patientId: s.patient_id, locationId: s.location_id, urgent: s.urgent });
    await db.run('UPDATE online_bookings SET chat_message_id = ? WHERE id = ?', mid, obId);
  }
  // The optional text to the office phone carries no names or health details (it's a phone anyone may see).
  if (settings.notify_sms_to && messenger) {
    const msg = await sendMessage(db, messenger, {
      practiceId: pid, channel: 'sms', to: settings.notify_sms_to, kind: 'office_alert',
      body: `${practice.name}: new online ${s.status === 'booked' ? 'booking' : 'request'} — ${s.type_label} ${friendlyDateTime(s.first_start)}${s.urgent ? ' (URGENT emergency)' : ''}${s.needs_person ? ', needs a person' : ''}. Details in Dental Machine → Online requests.`,
    });
    if (msg.status !== 'sent' && msg.status !== 'failed') {
      await raiseIssue(db, { practiceId: pid, kind: 'message', key: `online-office-text:${pid}`, role: 'admin', title: 'The office text alert for online bookings didn’t go', detail: msg.error || msg.status });
    }
  }
}

// ---- What the patient sees after booking ----
async function resultFor(deps, practice, obId) {
  const { db, config = {} } = deps;
  const s = await bookingSummary(db, obId);
  const out = {
    ok: true, id: obId, status: s.status, urgent: s.urgent,
    visits: s.people.map((p) => ({ first_name: p.first_name, start: p.requested_start, provider_name: p.provider_name })),
  };
  // A link to manage the visit (confirm, cancel, ask to move — the existing confirmation page) and its calendar file.
  const apptIds = s.people.map((p) => p.appointment_id).filter(Boolean);
  if (apptIds.length) {
    const { token, hash } = newToken();
    const recipient = s.people[0].patient_id;
    for (const id of apptIds) await insert(db, 'confirm_links', { practice_id: practice.id, token_hash: hash, appointment_id: id, recipient_id: recipient, channel: null, address: null });
    out.manage_url = `${config.appUrl || ''}/c/${token}`;
    out.ics_url = `/api/public/confirm/${token}/calendar.ics`;
  }
  return out;
}

async function replay(deps, prior) {
  if (prior.status === 'processing') throw new HttpError(409, 'That booking is still going through — wait a moment');
  const practice = await deps.db.get('SELECT * FROM practices WHERE id = ?', prior.practice_id);
  return { ...(await resultFor(deps, practice, prior.id)), repeat: true };
}

// The calendar file for a booking (also available from the confirmation link).
export const icsFor = (visits, practice, link) => visitsIcs(visits, practice, link);

// ---- Conversion analytics (no personal details) ----
export async function funnel(db, practiceId, { from, to, locationIds = null }) {
  const steps = await db.all(
    'SELECT step, COUNT(*) AS n FROM online_booking_events WHERE practice_id = ? AND day >= ? AND day <= ? GROUP BY step', practiceId, from, to,
  );
  const count = Object.fromEntries(STEPS.map((s) => [s, 0]));
  for (const r of steps) count[r.step] = Number(r.n);
  const bySource = await db.all(
    `SELECT COALESCE(source, 'direct') AS source, SUM(CASE WHEN step = 'view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN step IN ('booked','requested') THEN 1 ELSE 0 END) AS bookings
     FROM online_booking_events WHERE practice_id = ? AND day >= ? AND day <= ? GROUP BY COALESCE(source, 'direct') ORDER BY views DESC`, practiceId, from, to,
  );
  const byVariant = await db.all(
    `SELECT variant, SUM(CASE WHEN step = 'view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN step IN ('booked','requested') THEN 1 ELSE 0 END) AS bookings
     FROM online_booking_events WHERE practice_id = ? AND day >= ? AND day <= ? AND variant IS NOT NULL GROUP BY variant ORDER BY variant`, practiceId, from, to,
  );
  const scope = locationIds?.length ? ` AND (o.location_id IS NULL OR o.location_id IN (${locationIds.map(() => '?').join(',')}))` : '';
  const bookings = await db.all(
    `SELECT o.status, o.source, t.kind, COUNT(*) AS n, SUM(o.people) AS people FROM online_bookings o LEFT JOIN online_visit_types t ON t.id = o.visit_type_id
     WHERE o.practice_id = ? AND o.created_at >= ? AND o.created_at < ? AND o.status <> 'processing'${scope} GROUP BY o.status, o.source, t.kind`,
    practiceId, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationIds || []),
  );
  const money = await db.get(
    `SELECT COUNT(DISTINCT a.id) AS visits, COALESCE(SUM(CASE WHEN x.status <> 'cancelled' THEN x.fee ELSE 0 END), 0) AS scheduled
     FROM appointments a JOIN online_bookings o ON o.id = a.online_booking_id LEFT JOIN procedures x ON x.appointment_id = a.id
     WHERE a.practice_id = ? AND o.created_at >= ? AND o.created_at < ? AND a.status NOT IN ${INACTIVE}${scope}`,
    practiceId, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationIds || []),
  );
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const done = count.booked + count.requested;
  return {
    from, to,
    steps: STEPS.filter((s) => !['bot'].includes(s)).map((s) => ({ step: s, sessions: count[s] })),
    conversion: pct(done, count.view), drop_off: {
      office_to_reason: pct(count.office - count.reason, count.office), reason_to_time: pct(count.reason - count.time, count.reason),
      time_to_details: pct(count.time - count.details, count.time), details_to_booked: pct(count.details - done, count.details),
    },
    taken: count.taken, bots_blocked: count.bot,
    by_source: bySource.map((r) => ({ source: r.source, views: Number(r.views), bookings: Number(r.bookings), conversion: pct(Number(r.bookings), Number(r.views)) })),
    by_variant: byVariant.map((r) => ({ variant: r.variant, views: Number(r.views), bookings: Number(r.bookings), conversion: pct(Number(r.bookings), Number(r.views)) })),
    bookings: bookings.map((r) => ({ status: r.status, source: r.source || 'direct', kind: r.kind, bookings: Number(r.n), people: Number(r.people) })),
    visits_booked: Number(money?.visits || 0), scheduled_cents: Number(money?.scheduled || 0),
  };
}
