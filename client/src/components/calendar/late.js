// Late patients and running behind (S7) — pure functions of the visits and the practice-local time, so the
// schedule, its banner and the tests all agree. Times are practice-local 'YYYY-MM-DD HH:MM' strings, as the
// server stores them. Nothing here talks to the server.

export const LATE_DEFAULTS = { lateAfter: 5, veryLateAfter: 10 };
const WAITING = ['scheduled', 'confirmed'];

const stamp = (t) => Date.parse(`${t.slice(0, 10)}T${t.slice(11, 16)}:00Z`);
// Whole minutes from a to b (b later = positive).
export const minutesBetween = (a, b) => Math.floor((stamp(b) - stamp(a)) / 60_000);

// The practice's late thresholds, from its settings (late_minutes / very_late_minutes), kept sensible.
export function lateSettings(practice) {
  const n = Number(practice?.late_minutes);
  const m = Number(practice?.very_late_minutes);
  const lateAfter = Number.isInteger(n) && n >= 1 && n <= 60 ? n : LATE_DEFAULTS.lateAfter;
  const veryLateAfter = Number.isInteger(m) && m >= lateAfter && m <= 120 ? m : Math.max(lateAfter, LATE_DEFAULTS.veryLateAfter);
  return { lateAfter, veryLateAfter };
}

// A visit that should have started and the patient hasn't been checked in: null, or
// { minutes, level: 'late' | 'very_late' }. Only visits on today's date (a past day's are no-shows to record).
export function lateness(appt, now, { lateAfter, veryLateAfter } = LATE_DEFAULTS) {
  if (!appt || !now || !WAITING.includes(appt.status)) return null;
  if (appt.start_time.slice(0, 10) !== now.slice(0, 10)) return null;
  const minutes = minutesBetween(appt.start_time, now);
  if (minutes < lateAfter) return null;
  return { minutes, level: minutes >= veryLateAfter ? 'very_late' : 'late' };
}

// "7 min", "1 h 5 min", "2 h" — how long, in words that read at a glance.
export const waitLabel = (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`);

// Everyone late right now, the longest wait first.
export function lateList(appts, now, settings = LATE_DEFAULTS) {
  return appts
    .map((a) => ({ appt: a, late: lateness(a, now, settings) }))
    .filter((x) => x.late)
    .sort((x, y) => y.late.minutes - x.late.minutes || x.appt.start_time.localeCompare(y.appt.start_time));
}

// How far behind one column (a chair or a provider) is running, from its visits today:
//   - a patient checked in but not seated after `lateAfter` minutes past their time (or arrival, if they came late);
//   - a patient still in the chair past the visit's end while the next patient in the column is waiting
//     (checked in, or due already).
// Returns null or { minutes, reason, appt } for the worst one.
export function runningBehind(columnAppts, now, { lateAfter } = LATE_DEFAULTS) {
  if (!now) return null;
  const today = columnAppts.filter((a) => a.start_time.slice(0, 10) === now.slice(0, 10)).sort((a, b) => a.start_time.localeCompare(b.start_time));
  let worst = null;
  const consider = (minutes, reason, appt) => { if (!worst || minutes > worst.minutes) worst = { minutes, reason, appt }; };
  for (const a of today) {
    if (a.status === 'checked_in') {
      const since = a.arrived_at && a.arrived_at > a.start_time ? a.arrived_at : a.start_time;
      const waited = minutesBetween(since, now);
      if (waited >= lateAfter) consider(waited, `${a.first_name} ${a.last_name} checked in and not seated for ${waited} min`, a);
    }
    if (a.status === 'in_chair' && now > a.end_time) {
      const next = today.find((b) => b.id !== a.id && b.start_time >= a.start_time && (b.status === 'checked_in' || (WAITING.includes(b.status) && b.start_time <= now)));
      if (next) {
        const over = minutesBetween(a.end_time, now);
        if (over >= 1) consider(over, `${a.first_name} ${a.last_name} is ${over} min past their end time and ${next.first_name} ${next.last_name} is waiting`, a);
      }
    }
  }
  return worst;
}
