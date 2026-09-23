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
