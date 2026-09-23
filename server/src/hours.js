import { HttpError } from './auth.js';

// Weekly office hours: { "0": [], "1": [["08:00","12:00"],["13:00","17:00"]], ... } keyed by weekday (0 = Sunday).
export const DEFAULT_HOURS = { 0: [], 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '17:00']], 4: [['08:00', '17:00']], 5: [['08:00', '17:00']], 6: [] };

export function officeHours(practice) {
  if (!practice?.office_hours) return DEFAULT_HOURS;
  try {
    return JSON.parse(practice.office_hours);
  } catch {
    return DEFAULT_HOURS;
  }
}

export const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const hoursFor = (practice, date) => officeHours(practice)[weekday(date)] || [];

// A provider's own weekly hours (e.g. hygienist Tue/Thu only); null means they follow office hours.
export function providerHours(provider) {
  if (!provider?.working_hours) return null;
  try {
    return JSON.parse(provider.working_hours);
  } catch {
    return null;
  }
}
// Alternating weeks: { ...weekA, alt: { anchor: 'YYYY-MM-DD', hours: weekB } } — the week containing
// the anchor date and every other week after it use weekB.
const mondayOf = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.getTime();
};
export const isAltWeek = (alt, date) => !!alt?.anchor && Math.abs(Math.round((mondayOf(date) - mondayOf(alt.anchor)) / (7 * 86400000))) % 2 === 0;
export const providerHoursFor = (practice, provider, date) => {
  const own = providerHours(provider);
  if (!own) return hoursFor(practice, date);
  const week = own.alt && isAltWeek(own.alt, date) ? own.alt.hours : own;
  return week[weekday(date)] || [];
};

// A provider's hours: a weekly pattern, optionally with a second pattern for alternate weeks.
export function validateWorkingHours(hours) {
  const out = validateHours(hours);
  if (hours?.alt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hours.alt.anchor || '')) throw new HttpError(400, 'Alternate weeks need a start date');
    out.alt = { anchor: hours.alt.anchor, hours: validateHours(hours.alt.hours) };
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateHours(hours) {
  if (!hours || typeof hours !== 'object') throw new HttpError(400, 'office_hours must be an object keyed by weekday');
  const out = {};
  for (let d = 0; d < 7; d++) {
    const ranges = hours[d] ?? hours[String(d)] ?? [];
    if (!Array.isArray(ranges)) throw new HttpError(400, 'Each day must be a list of [open, close] ranges');
    out[d] = ranges.map(([open, close]) => {
      if (!HHMM.test(open) || !HHMM.test(close) || close <= open) throw new HttpError(400, `Invalid hours ${open}-${close}`);
      return [open, close];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < out[d].length; i++) if (out[d][i][0] < out[d][i - 1][1]) throw new HttpError(400, 'Office hour ranges overlap');
  }
  return out;
}

// The provider's hours on a date, with one-off exceptions (time off, a different day) taking precedence.
export async function providerHoursOn(db, practice, provider, date) {
  const ex = provider?.id ? await db.get('SELECT hours, reason FROM provider_exceptions WHERE provider_id = ? AND date = ?', provider.id, date) : null;
  if (ex) return Object.assign(JSON.parse(ex.hours), { exception: ex.reason || (JSON.parse(ex.hours).length ? 'Special hours' : 'Off') });
  return providerHoursFor(practice, provider, date);
}
