// Late cancellations: a visit cancelled less than the practice's window (practices.late_cancel_hours, default 24)
// before it was due. Used by the no-show / late-cancel predictions (predict/noshow.js) and, through them, the
// optimizer's Double-confirm; the setting is in Settings → Messages → Appointment reminders.
//
// appointments.cancelled_at is set by every path that cancels a visit (the schedule, the visit panel's series
// cancel, a provider's day out, the patient portal, the reminder link, the API, the AI receptionist) and cleared
// when the visit is put back on the schedule. It is kept in the practice's own time, like start_time, so the two
// compare directly. Older cancellations were filled from the change log where it had them (migrations.js, step 3).
import { practiceNow } from './util.js';

export const DEFAULT_LATE_CANCEL_HOURS = 24;
export const MAX_LATE_CANCEL_HOURS = 168;

// Practice time now, as stored in cancelled_at ('YYYY-MM-DD HH:MM').
export const cancelledNow = (db, practiceId) => practiceNow(db, practiceId);

export async function lateCancelHours(db, practiceId) {
  const row = await db.get('SELECT late_cancel_hours FROM practices WHERE id = ?', practiceId);
  const n = Number(row?.late_cancel_hours);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LATE_CANCEL_HOURS ? n : DEFAULT_LATE_CANCEL_HOURS;
}

const minutesOf = (s) => Date.parse(`${String(s).slice(0, 16).replace(' ', 'T')}:00Z`) / 60000;
// Hours of notice the patient gave (negative when it was cancelled after the start time); null without a time.
export function noticeHours(a) {
  if (!a?.cancelled_at || !a.start_time) return null;
  const h = (minutesOf(a.start_time) - minutesOf(a.cancelled_at)) / 60;
  return Number.isFinite(h) ? h : null;
}

// Whether a cancelled visit counts as a late cancellation, the patient's doing:
//   - the office's own cancellations (reason "office") never count;
//   - with cancelled_at: cancelled less than `hours` before the start;
//   - without it (cancelled before the time was recorded, and the change log didn't have it): the old rule — any
//     cancellation with a reason that isn't the office's. That over-counts early cancellations a little, so it only
//     applies to those older rows.
export function isLateCancel(a, hours = DEFAULT_LATE_CANCEL_HOURS) {
  if (a?.status !== 'cancelled') return false;
  if (a.broken_reason && String(a.broken_reason).toLowerCase() === 'office') return false;
  const notice = noticeHours(a);
  if (notice != null) return notice < hours;
  return !!a.broken_reason;
}
