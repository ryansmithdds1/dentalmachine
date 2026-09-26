import { localNow, recorded } from './util.js';
import { recallTypes } from './recalls.js';

// Recall on autopilot (RC1–RC4): the cadence engine's first type (see cadence.js for the contract).
// Anchor: the recall's due date. Source: the recalls row. One sequence per active recall type (prophy, perio
// maintenance, and any the practice adds), each starting from the recommended steps below and editable.

// The recommended sequence (backlog RC1). Offsets are days from the due date. {link} opens the patient's own
// booking page (RC2); {who} is "your" or "Jane and Tom's"; {family_note} offers back-to-back times to a family.
export const DEFAULT_RECALL_CADENCE = [
  { offset_days: -30, channel: 'text', template: 'Hi {first_name}, it’s time to book {who} {visit} at {practice}.{family_note} Pick a time that works for you: {link}' },
  { offset_days: -14, channel: 'text', template: 'Reminder from {practice}: {who} {visit} is due {due}. Tap to pick a time: {link}' },
  { offset_days: 0, channel: 'text', template: 'Hi {first_name}, {who} {visit} at {practice} is due today. Book online in two taps: {link} or call us at {phone}.' },
  {
    offset_days: 14, channel: 'email', subject: 'Your visit at {practice} is waiting', template:
      'Hi {first_name}, {who} {visit} was due on {due}. Regular visits catch small problems before they become big ones. Choose a time online in a few taps: {link} — or call us at {phone}.',
  },
  {
    offset_days: 30, channel: 'ai_call', conditions: { fallback: ['task_call'] }, template:
      'Hi, this is {practice}. It looks like {who} {visit} was due on {due}, and we’d love to get you booked. Can I help you find a time that works?',
  },
  { offset_days: 60, channel: 'text', template: 'Hi {first_name}, {practice} here — {who} {visit} is overdue. Book in two taps: {link} or reply and we’ll help.' },
  {
    offset_days: 90, channel: 'postcard', conditions: { fallback: ['email'] }, subject: 'We miss you at {practice}', template:
      'We haven’t seen you in a while and {who} {visit} is overdue. Call us at {phone} or book online at {link} — we’ll find a time that suits you.',
  },
  { offset_days: 180, channel: 'text', repeat_days: 90, repeat_max: 8, template: 'We miss you at {practice}, {first_name}! Book {who} {visit} whenever you’re ready: {link}' },
];

// What the visit is called in a message.
const VISIT_WORDS = { prophy: 'checkup and cleaning', child_prophy: 'checkup and cleaning', perio_maint: 'gum care visit', bwx: 'x-rays', fmx: 'x-rays', pano: 'x-ray' };
const ACTIVE_VISIT = "('scheduled','confirmed','checked_in','in_chair')";

async function todayFor(db, practiceId, ctx) {
  if (ctx?.today) return ctx.today;
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York';
  return localNow(tz).slice(0, 10);
}

// The patient's next visit from today on (any kind: a booked visit means we stop asking them to book).
export async function futureVisit(db, practiceId, patientId, today) {
  return db.get(`SELECT id, start_time FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ${ACTIVE_VISIT} AND start_time >= ? ORDER BY start_time LIMIT 1`, practiceId, patientId, `${today} 00:00`);
}

export const recallCadence = {
  label: 'Recall',
  linkPath: 'rb',
  enabled: (practice) => Number(practice.recall_cadence) === 1,

  async defaultSequences(db, practiceId) {
    // X-ray, exam and fluoride recalls ride along with the cleaning (recalls.js bundle): no sequence of their own.
    return (await recallTypes(db, practiceId)).filter((t) => t.active && !t.bundle).map((t) => ({ subtype: t.key, name: `${t.name} recall`, steps: DEFAULT_RECALL_CADENCE }));
  },

  // Every active patient with an active recall type due inside the window, not already booked (pre-appointed
  // at checkout counts as done: they have a future visit).
  async candidates(db, practice, { today, windows }) {
    const ranges = Object.values(windows);
    if (!ranges.length) return [];
    const from = ranges.map((w) => w.from).sort()[0];
    const to = ranges.map((w) => w.to).sort().at(-1);
    const rows = await db.all(
      `SELECT r.id, r.patient_id, r.type, r.due_date, p.location_id FROM real_recalls r
         JOIN real_patients p ON p.id = r.patient_id
         JOIN recall_types rt ON rt.practice_id = r.practice_id AND rt.key = r.type AND rt.active = 1 AND rt.bundle = 0
       WHERE r.practice_id = ? AND r.status IN ('due','contacted') AND p.status = 'active' AND r.due_date >= ? AND r.due_date <= ?
         AND NOT EXISTS (SELECT 1 FROM real_appointments a WHERE a.patient_id = r.patient_id AND a.status IN ${ACTIVE_VISIT} AND a.start_time >= ?)
       ORDER BY r.due_date, r.id`,
      practice.id, from, to, `${today} 00:00`,
    );
    return rows
      .filter((r) => windows[r.type] && r.due_date >= windows[r.type].from && r.due_date <= windows[r.type].to)
      .map((r) => ({ patient_id: r.patient_id, subtype: r.type, source_type: 'recall', source_id: r.id, anchor_date: r.due_date, location_id: r.location_id }));
  },

  // Checked on every pass and again right before every send.
  async stopCheck(db, e, ctx) {
    const today = await todayFor(db, e.practice_id, ctx);
    const visit = await futureVisit(db, e.practice_id, e.patient_id, today);
    if (visit) return { reason: 'booked', appointment_id: visit.id };
    const r = await db.get('SELECT * FROM recalls WHERE id = ? AND practice_id = ?', e.source_id, e.practice_id);
    if (!r) return { reason: 'recall_done' };
    if (r.status === 'scheduled') return { reason: 'booked', appointment_id: r.appointment_id };
    if (r.status === 'completed') return { reason: 'recall_done' };
    if (r.status === 'inactive') return { reason: 'recall_inactive' };
    // The visit happened (the due date moved on) or someone changed the date by hand.
    if (r.due_date !== e.anchor_date) return { reason: r.due_date > e.anchor_date ? 'recall_done' : 'recall_changed' };
    const type = await db.get('SELECT active FROM recall_types WHERE practice_id = ? AND key = ?', e.practice_id, r.type);
    if (type && !type.active) return { reason: 'recall_inactive' };
    return null;
  },

  async describe(db, enrollments) {
    const types = [];
    for (const e of enrollments) {
      const r = await db.get('SELECT type FROM recalls WHERE id = ?', e.source_id);
      const words = VISIT_WORDS[r?.type] || (await db.get('SELECT name FROM recall_types WHERE practice_id = ? AND key = ?', e.practice_id, r?.type))?.name?.toLowerCase() || 'visit';
      if (!types.includes(words)) types.push(words);
    }
    return { visit: types.length > 1 && types.includes('checkup and cleaning') ? 'checkups and cleanings' : types.join(' and ') || 'visit' };
  },

  // The recall list shows who has been contacted.
  async afterSend(db, enrollments) {
    for (const e of enrollments) {
      await recorded(db, 'recalls', e.source_id, () => db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ? AND status = 'due'", e.source_id));
    }
  },
};
