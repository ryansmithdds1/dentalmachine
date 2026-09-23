import { HttpError } from './auth.js';

// Time patterns (as in Open Dental): one character per 10 minutes, "X" when the provider is needed and "/"
// when an assistant or hygienist has the patient on their own (seating, x-rays, impressions, temporaries).
// A provider can be booked twice only where one visit's "/" time lines up with the other's.
export const SLOT = 10;

export function cleanPattern(value) {
  if (value == null || value === '') return null;
  const p = String(value).toUpperCase().replace(/\s+/g, '');
  if (!/^[X/]{1,48}$/.test(p)) throw new HttpError(400, 'Time pattern: X for provider time and / for assistant time, one per 10 minutes (e.g. //XXXX//)');
  if (!p.includes('X')) throw new HttpError(400, 'Time pattern needs at least one X (provider time)');
  return p;
}

// Stretches or trims a pattern to a visit's length. The opening and closing assistant time stay; the
// provider time in between grows or shrinks (to one slot at least, then the ends give way).
export function fitPattern(pattern, minutes) {
  if (!pattern) return null;
  const slots = Math.max(1, Math.round(minutes / SLOT));
  let head = pattern.match(/^\/*/)[0];
  let tail = pattern.slice(head.length).match(/\/*$/)[0];
  let mid = pattern.slice(head.length, pattern.length - tail.length);
  if (pattern.length < slots) return head + mid + 'X'.repeat(slots - pattern.length) + tail;
  const over = () => head.length + mid.length + tail.length - slots;
  while (over() > 0 && mid.length > 1) mid = mid.slice(0, mid.length - Math.min(over(), mid.length - 1));
  while (over() > 0 && tail.length) tail = tail.slice(1);
  while (over() > 0 && head.length) head = head.slice(1);
  return (head + mid + tail).slice(0, slots);
}

// How long a type takes with this provider (some are faster or slower than the default).
export function typeDuration(type, providerId) {
  if (!type) return null;
  const map = parseDurations(type.provider_durations);
  return map[String(providerId)] || type.duration;
}
export function parseDurations(v) {
  try {
    const o = typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
    return Object.fromEntries(Object.entries(o).filter(([k, m]) => /^\d+$/.test(k) && Number(m) >= 5 && Number(m) <= 600).map(([k, m]) => [k, Math.round(Number(m))]));
  } catch {
    return {};
  }
}

const minutesOf = (dt) => Number(dt.slice(11, 13)) * 60 + Number(dt.slice(14, 16));
// The stretches of a visit when the provider is busy, in minutes of the day.
export function providerTime({ start_time: s, end_time: e, pattern }) {
  const start = minutesOf(s);
  const end = minutesOf(e);
  if (!pattern) return [[start, end]];
  const out = [];
  for (let i = 0; i < pattern.length && start + i * SLOT < end; i++) {
    if (pattern[i] !== 'X') continue;
    const a = start + i * SLOT;
    const b = Math.min(end, a + SLOT);
    if (out.length && out.at(-1)[1] === a) out.at(-1)[1] = b;
    else out.push([a, b]);
  }
  return out;
}
export const providerOverlap = (a, b) => a.start_time.slice(0, 10) === b.start_time.slice(0, 10)
  && providerTime(a).some(([s1, e1]) => providerTime(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
