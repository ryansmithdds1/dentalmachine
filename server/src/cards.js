// What the schedule's appointment cards, the patient bar and the chart header know about a patient beyond
// the visit itself (docs/workflows/specs/PP-DN-S8-S6.md):
//   PP1  preferences (pillow, blanket, no nitrous…), some marked urgent so nobody misses them
//   PP2  personal connection notes ("new dog") — the latest shows on the chart and the seated card
//   DN1  the doctor's notes to the front desk on a visit or an empty slot
//   S8   office-caused moves ("we moved them" strikes), counted over 12 months
//   S6   which lines and chips each card shows (the practice's layout, or a person's own)
import { HttpError, can } from './auth.js';
import { addMonths, practiceNow, recorded } from './util.js';
import { patientBalance } from './services.js';

// ---------------------------------------------------------------- PP1: preferences
export const PREF_CATEGORIES = ['comfort', 'care', 'scheduling', 'other'];
export const STARTER_PREFS = [
  ['pillow', 'Pillow behind the neck', 'comfort'],
  ['blanket', 'Blanket', 'comfort'],
  ['music', 'Headphones / music', 'comfort'],
  ['sunglasses', 'Sunglasses', 'comfort'],
  ['no_nitrous', 'No nitrous', 'care'],
  ['each_step', 'Tell me each step', 'care'],
  ['gag', 'Gag reflex', 'care'],
  ['anxious', 'Anxious — go gently', 'care'],
  ['extra_time', 'Needs extra time', 'scheduling'],
  ['mornings', 'Mornings only', 'scheduling'],
  ['text_not_call', 'Text, don’t call', 'scheduling'],
];

// The starter list is added the first time a practice's list is read (and never again: the office may retire
// any of it). The unique (practice_id, starter_key) makes two first reads at once harmless.
export async function ensurePrefOptions(db, practiceId) {
  const have = await db.get('SELECT COUNT(*) AS n FROM patient_pref_options WHERE practice_id = ? AND starter_key IS NOT NULL', practiceId);
  if (Number(have.n) > 0) return;
  let i = 0;
  for (const [key, label, category] of STARTER_PREFS) {
    await db.run(
      `INSERT INTO patient_pref_options (practice_id, label, category, starter_key, position) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (practice_id, starter_key) DO NOTHING`,
      practiceId, label, category, key, i++,
    );
  }
}

export async function prefOptions(db, practiceId, { all = false } = {}) {
  await ensurePrefOptions(db, practiceId);
  return db.all(`SELECT * FROM patient_pref_options WHERE practice_id = ?${all ? '' : ' AND active = 1'} ORDER BY position, id`, practiceId);
}

export async function patientPrefs(db, practiceId, patientIds) {
  const ids = [].concat(patientIds).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return db.all(
    `SELECT pp.id, pp.patient_id, pp.option_id, pp.urgent, pp.note, pp.added_at, pp.updated_at, o.label, o.category, u.name AS added_by_name
     FROM patient_prefs pp JOIN patient_pref_options o ON o.id = pp.option_id LEFT JOIN users u ON u.id = pp.added_by
     WHERE pp.practice_id = ? AND pp.status = 'active' AND pp.patient_id IN (${ids.map(() => '?').join(',')})
     ORDER BY pp.urgent DESC, o.position, o.id`,
    practiceId, ...ids,
  );
}

// ---------------------------------------------------------------- PP2: personal notes
export async function latestPersonal(db, practiceId, patientIds) {
  const ids = [].concat(patientIds).map(Number).filter(Boolean);
  if (!ids.length) return {};
  const rows = await db.all(
    `SELECT n.id, n.patient_id, n.body, n.created_at, u.name AS by_name FROM personal_notes n LEFT JOIN users u ON u.id = n.created_by
     WHERE n.practice_id = ? AND n.removed_at IS NULL AND n.patient_id IN (${ids.map(() => '?').join(',')}) ORDER BY n.created_at DESC, n.id DESC`,
    practiceId, ...ids,
  );
  const out = {};
  for (const r of rows) if (!out[r.patient_id]) out[r.patient_id] = r;
  return out;
}

// ---------------------------------------------------------------- S8: office-caused moves
export const OFFICE_REASONS = {
  provider_sick: 'Provider sick',
  emergency: 'Emergency',
  double_booked: 'Double-booked',
  equipment_down: 'Equipment down',
  other: 'Other',
};
// How the reason reads in a message to the patient ("…because {phrase}").
const REASON_PHRASE = {
  provider_sick: (p) => `${p || 'your provider'} is out sick`,
  emergency: () => 'of an emergency at the office',
  double_booked: () => 'we made a mistake with the schedule',
  equipment_down: () => 'some of our equipment is being repaired',
  other: () => 'of a change at the office',
};
export const reasonPhrase = (reason, providerName) => (REASON_PHRASE[reason] || REASON_PHRASE.other)(providerName);

// The office's reason from what a request says: an office_reason code, or (from the cancel picker, whose
// screen only sends a note) the reason's label as the note.
export function officeReasonFrom(body = {}) {
  const code = body.office_reason ?? null;
  if (code != null) {
    if (!OFFICE_REASONS[code]) throw new HttpError(400, `office_reason must be one of: ${Object.keys(OFFICE_REASONS).join(', ')}`);
    return code;
  }
  const note = String(body.broken_note ?? body.note ?? '').trim().toLowerCase();
  return Object.entries(OFFICE_REASONS).find(([k, l]) => k !== 'other' && l.toLowerCase() === note)?.[0] || 'other';
}

const cleanNote = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);

// Records one office-caused move/cancel/reassign. Idempotent: the same visit moved from the same time is one
// row (a double click, a retried request). Returns { id, created }.
export async function recordOfficeMove(db, { practiceId, appt, kind, reason, note = null, toTime = null, toProviderId = null, runId = null, userId = null, source = 'human' }) {
  if (!OFFICE_REASONS[reason]) throw new HttpError(400, `reason must be one of: ${Object.keys(OFFICE_REASONS).join(', ')}`);
  const fromTime = appt.start_time;
  const had = await db.get('SELECT id FROM office_moves WHERE appointment_id = ? AND kind = ? AND from_time = ?', appt.id, kind, fromTime);
  if (had) return { id: had.id, created: false };
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const r = await db.run(
    `INSERT INTO office_moves (practice_id, location_id, appointment_id, patient_id, provider_id, to_provider_id, kind, reason, note, from_time, to_time, happened_on, run_id, source, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (appointment_id, kind, from_time) DO NOTHING`,
    practiceId, appt.location_id ?? null, appt.id, appt.patient_id, appt.provider_id, toProviderId, kind, reason, cleanNote(note), fromTime, toTime, today, runId, source, userId,
  );
  const row = await db.get('SELECT id FROM office_moves WHERE appointment_id = ? AND kind = ? AND from_time = ?', appt.id, kind, fromTime);
  // Last word on the visit itself (additive columns): who it was down to and why.
  if (kind !== 'reassign') await recorded(db, 'appointments', appt.id, () => db.run('UPDATE appointments SET moved_by = ?, office_reason = ?, office_note = ? WHERE id = ?', 'office', reason, cleanNote(note), appt.id));
  return { id: row.id, created: !!r.changes };
}

// Strikes per patient: office moves and cancellations (not reassigns) in the last 12 months, newest first.
export async function strikesFor(db, practiceId, patientIds, { today = null } = {}) {
  const ids = [...new Set([].concat(patientIds).map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const day = today || (await practiceNow(db, practiceId)).slice(0, 10);
  const rows = await db.all(
    `SELECT m.id, m.patient_id, m.kind, m.reason, m.note, m.from_time, m.to_time, m.happened_on, pr.name AS provider_name
     FROM office_moves m LEFT JOIN providers pr ON pr.id = m.provider_id
     WHERE m.practice_id = ? AND m.voided_at IS NULL AND m.kind IN ('move','cancel') AND m.happened_on >= ?
       AND m.patient_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.happened_on DESC, m.id DESC`,
    practiceId, addMonths(day, -12), ...ids,
  );
  const out = {};
  for (const r of rows) (out[r.patient_id] ||= { count: 0, list: [] }).list.push({ ...r, reason_label: OFFICE_REASONS[r.reason] || r.reason });
  for (const v of Object.values(out)) {
    v.count = v.list.length;
    v.last_on = v.list[0].happened_on;
    v.days_since = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${v.last_on}T12:00:00Z`)) / 86400000);
  }
  return out;
}

// "Moved by us 2× in 12 mo" and the warning before moving them again ("We moved Maria 5 weeks ago").
export function strikeWarning(name, s) {
  if (!s?.count) return null;
  const d = s.days_since;
  const ago = d <= 1 ? (d === 0 ? 'today' : 'yesterday') : d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`;
  return `We moved ${name} ${ago}${s.count > 1 ? ` (${s.count}× in 12 months)` : ''} — try someone else if you can`;
}

// ---------------------------------------------------------------- S8: provider out today
// Plans a provider's day: each visit is kept with another provider of the same kind who is free at that time
// in the same chair (validateAppt: hours, blocks, conflicts), or rescheduled. Patients the office already moved
// get the first chance to be kept, so those with no recent strikes are the ones asked to move.
export async function planProviderOut(db, practiceId, { providerId, date, validate }) {
  const provider = await db.get('SELECT * FROM providers WHERE id = ? AND practice_id = ?', providerId, practiceId);
  if (!provider) throw new HttpError(404, 'Provider not found');
  const visits = await db.all(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.phone, p.email, o.name AS operatory_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN operatories o ON o.id = a.operatory_id
     WHERE a.practice_id = ? AND a.provider_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status IN ('scheduled','confirmed')
     ORDER BY a.start_time`,
    practiceId, providerId, `${date} 00:00`, `${date} 24:00`,
  );
  const others = await db.all(
    'SELECT id, name, type FROM providers WHERE practice_id = ? AND id != ? AND active = 1 ORDER BY CASE WHEN type = ? THEN 0 ELSE 1 END, name',
    practiceId, providerId, provider.type,
  );
  // Only someone who does the same kind of work takes a visit over (a hygienist's patients go to a hygienist).
  const candidates = others.filter((o) => o.type === provider.type || (provider.type === 'dentist' && o.type === 'specialist'));
  const strikes = await strikesFor(db, practiceId, visits.map((v) => v.patient_id));
  const order = [...visits].sort((a, b) => (strikes[b.patient_id]?.count || 0) - (strikes[a.patient_id]?.count || 0) || a.start_time.localeCompare(b.start_time));
  const taken = []; // [{ provider_id, start_time, end_time }] kept in this plan
  const plan = new Map();
  for (const v of order) {
    let keep = null;
    for (const c of candidates) {
      if (taken.some((t) => t.provider_id === c.id && t.start_time < v.end_time && t.end_time > v.start_time)) continue;
      try {
        await validate({ ...v, provider_id: c.id });
        keep = c;
        break;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
    if (keep) taken.push({ provider_id: keep.id, start_time: v.start_time, end_time: v.end_time });
    plan.set(v.id, {
      appointment_id: v.id, patient_id: v.patient_id, name: `${v.preferred_name || v.first_name} ${v.last_name}`, start_time: v.start_time, end_time: v.end_time,
      operatory_name: v.operatory_name, reason: v.reason, status: v.status, has_phone: !!v.phone,
      strikes: strikes[v.patient_id]?.count || 0, strike_list: strikes[v.patient_id]?.list || [],
      suggestion: keep ? 'keep' : 'reschedule', keep_with: keep ? { id: keep.id, name: keep.name } : null,
      options: [],
    });
  }
  // Every provider who could take each visit (for the person to choose another).
  for (const v of visits) {
    const row = plan.get(v.id);
    for (const c of candidates) {
      try {
        await validate({ ...v, provider_id: c.id });
        row.options.push({ id: c.id, name: c.name });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
  }
  return { provider: { id: provider.id, name: provider.name, type: provider.type }, date, visits: visits.map((v) => plan.get(v.id)) };
}

// The apology text (warm, short, no clinical detail) and the heads-up for a visit kept with someone else.
export function apologyText({ patient, practice, visit, reason, providerName, goodwill, link }) {
  const when = visit.start_time;
  const day = new Date(`${when.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const [h, m] = when.slice(11, 16).split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const name = patient.preferred_name || patient.first_name;
  return [
    `Hi ${name}, we’re so sorry — we have to move your ${day} ${time} visit at ${practice.name} because ${reasonPhrase(reason, providerName)}. That’s on us, not you.`,
    goodwill ? goodwill.trim() : null,
    link ? `Pick a new time that suits you: ${link}` : null,
    practice.phone ? `Or call us at ${practice.phone} and we’ll find you a good time.` : null,
  ].filter(Boolean).join(' ');
}
export function reassignText({ patient, practice, visit, toName }) {
  const name = patient.preferred_name || patient.first_name;
  const [h, m] = visit.start_time.slice(11, 16).split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `Hi ${name}, a quick heads-up from ${practice.name}: your visit at ${time} is still on, and you’ll see ${toName} this time. Sorry for the change — see you soon!`;
}

// ---------------------------------------------------------------- S6: card layouts
// Everything a card can show. `line` items are what the card showed before layouts existed; the default layout
// reproduces it exactly. Keys the client doesn't know are refused so a typo can't save a broken layout.
export const CARD_ITEMS = [
  'medical_alert', 'name', 'preferred_name', 'age', 'birthday', 'new_patient', 'confirmation', 'ready', 'asap', 'recurring', 'insurance', 'readiness',
  'opportunity', 'wait', 'late', 'urgent_prefs', 'strikes', 'doctor_note', 'forms', 'labels', 'time', 'visit_type', 'provider', 'production',
  'balance', 'procedures', 'notes', 'personal',
];
export const DEFAULT_LAYOUT = {
  version: 1,
  lines: [
    ['medical_alert', 'name', 'urgent_prefs', 'strikes', 'doctor_note', 'confirmation', 'ready', 'asap', 'recurring', 'insurance', 'readiness', 'opportunity', 'wait', 'late'],
    ['time', 'visit_type', 'personal'],
    ['provider', 'production'],
    ['procedures'],
  ],
  compact: { enabled: false, max_minutes: 30, lines: [['medical_alert', 'name', 'urgent_prefs', 'confirmation', 'late']] },
  color_by: null,
  labels: [],
};
const COLOR_BY = [null, 'type', 'provider', 'status'];

function cleanLines(lines, what) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 6) throw new HttpError(400, `${what}: between 1 and 6 lines`);
  const seen = new Set();
  return lines.map((line, i) => {
    if (!Array.isArray(line) || line.length > 20) throw new HttpError(400, `${what}: line ${i + 1} must be a list of up to 20 items`);
    return line.map((k) => {
      if (!CARD_ITEMS.includes(k)) throw new HttpError(400, `${what}: “${k}” isn’t something a card can show`);
      if (seen.has(k)) throw new HttpError(400, `${what}: “${k}” is on the card twice`);
      seen.add(k);
      return k;
    });
  });
}

export function cleanLayout(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'layout is required');
  const lines = cleanLines(input.lines, 'Card');
  const c = input.compact || {};
  const max = c.max_minutes == null ? 30 : Number(c.max_minutes);
  if (!Number.isInteger(max) || max < 10 || max > 60) throw new HttpError(400, 'Short visits are 10 to 60 minutes');
  const compact = { enabled: !!c.enabled, max_minutes: max, lines: cleanLines(c.lines?.length ? c.lines : DEFAULT_LAYOUT.compact.lines, 'Short-visit card') };
  const colorBy = input.color_by ?? null;
  if (!COLOR_BY.includes(colorBy)) throw new HttpError(400, 'color_by must be type, provider or status');
  const labels = Array.isArray(input.labels) ? input.labels : [];
  if (labels.length > 20) throw new HttpError(400, 'Up to 20 office labels');
  const keys = new Set();
  const cleanLabels = labels.map((l) => {
    const text = String(l?.text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 24);
    if (!text) throw new HttpError(400, 'Each label needs a name');
    const key = String(l.key || text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'label';
    if (keys.has(key)) throw new HttpError(400, `Two labels are called “${text}”`);
    keys.add(key);
    const color = /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#64748b';
    return { key, text, color };
  });
  return { version: 1, lines, compact, color_by: colorBy, labels: cleanLabels };
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
export const USER_LAYOUT_KEY = 'schedule.card_layout';

export async function layoutsFor(db, user) {
  const row = await db.get('SELECT layout, updated_at, updated_by FROM card_layouts WHERE practice_id = ?', user.practice_id);
  const practice = (row && parse(row.layout)) || null;
  const mine = parse((await db.get('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', user.id, USER_LAYOUT_KEY))?.value);
  const own = mine && typeof mine === 'object' && mine.lines ? mine : null;
  const base = practice || DEFAULT_LAYOUT;
  // A person's own layout decides the lines; the office's labels always come from the practice.
  const effective = own ? { ...own, labels: base.labels || [] } : base;
  return { effective, practice, mine: own, is_default: !practice, updated_at: row?.updated_at ?? null };
}

// ---------------------------------------------------------------- the day's card data
// One request for the schedule: per visit, what the chips need (urgent preferences, strikes, the latest personal
// note, notes from the doctor, balance for people who may see money, new patient, labels) and the slot notes.
export async function cardData(db, user, { from, to, scopeSql = '', scopeArgs = [] }) {
  const pid = user.practice_id;
  const visits = await db.all(
    `SELECT a.id, a.patient_id, a.start_time FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${scopeSql}`,
    pid, `${from} 00:00`, `${to} 24:00`, ...scopeArgs,
  );
  const patientIds = [...new Set(visits.map((v) => v.patient_id))];
  const [prefs, personal, strikes] = await Promise.all([patientPrefs(db, pid, patientIds), latestPersonal(db, pid, patientIds), strikesFor(db, pid, patientIds)]);
  const prefsBy = {};
  for (const p of prefs) (prefsBy[p.patient_id] ||= []).push({ id: p.id, label: p.label, category: p.category, urgent: !!p.urgent, note: p.note });
  const ids = visits.map((v) => v.id);
  const inIds = ids.map(() => '?').join(',');
  const notes = await db.all(
    `SELECT n.*, u.name AS by_name, k.name AS acked_by_name FROM schedule_notes n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN users k ON k.id = n.acked_by
     WHERE n.practice_id = ? AND n.note_date >= ? AND n.note_date <= ? AND n.status IN ('open','acknowledged') ORDER BY n.created_at, n.id`,
    pid, from, to,
  );
  const labels = ids.length ? await db.all(`SELECT appointment_id, label_key FROM appointment_labels WHERE removed_at IS NULL AND appointment_id IN (${inIds})`, ...ids) : [];
  // New patient: no completed visit before this one.
  const seen = patientIds.length ? await db.all(
    `SELECT patient_id, MIN(start_time) AS first_done FROM appointments WHERE practice_id = ? AND status = 'completed' AND patient_id IN (${patientIds.map(() => '?').join(',')}) GROUP BY patient_id`,
    pid, ...patientIds,
  ) : [];
  const firstDone = Object.fromEntries(seen.map((r) => [r.patient_id, r.first_done]));
  const money = can(user, 'billing:read');
  const balances = {};
  if (money) for (const id of patientIds) balances[id] = Number(await patientBalance(db, pid, id));
  const by = {};
  for (const v of visits) {
    by[v.id] = {
      prefs: prefsBy[v.patient_id] || [],
      personal: personal[v.patient_id] ? { body: personal[v.patient_id].body, at: personal[v.patient_id].created_at, by: personal[v.patient_id].by_name } : null,
      strikes: strikes[v.patient_id] || null,
      new_patient: !firstDone[v.patient_id] || firstDone[v.patient_id] >= v.start_time,
      labels: labels.filter((l) => l.appointment_id === v.id).map((l) => l.label_key),
      notes: notes.filter((n) => n.appointment_id === v.id).map(noteOut),
      ...(money ? { balance: balances[v.patient_id] } : {}),
    };
  }
  const visible = new Set(ids);
  return {
    by_appt: by,
    slot_notes: notes.filter((n) => n.kind === 'slot').map(noteOut),
    // Visit notes whose visit isn't on this view (another office, a filter) still count for the day's list.
    other_notes: notes.filter((n) => n.kind === 'visit' && !visible.has(n.appointment_id)).map(noteOut),
  };
}

export const noteOut = (n) => ({
  id: n.id, kind: n.kind, appointment_id: n.appointment_id, patient_id: n.patient_id, provider_id: n.provider_id, operatory_id: n.operatory_id,
  date: n.note_date, start_time: n.start_time, end_time: n.end_time, body: n.body, status: n.status, source: n.source,
  by: n.by_name ?? null, by_id: n.created_by, at: n.created_at, acked_by: n.acked_by_name ?? null, acked_at: n.acked_at, booking_started_at: n.booking_started_at,
});
