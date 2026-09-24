// Capacity meter (CAP1–CAP2, docs/capacity.md, docs/workflows/specs/CAP-capacity.md): "is there enough doctor and
// hygiene time?" For each office and kind of provider (doctor = dentists and specialists, hygiene = hygienists —
// the same split as production.js) and for each provider:
//   - how far out the first opening is for each kind of visit (new patient, emergency, recall, treatment of
//     30/60/90 minutes), found the way booking finds times (hours, days off, visits, blocks, held online requests,
//     perfect-day blocks kept for other visits until they're released);
//   - how full the next 2/4/8 weeks are (booked minutes ÷ available minutes);
//   - the perfect-day blocks still open in the next two weeks;
//   - demand: recall coming due (in hours, by the recall type's visit length), unscheduled treatment in hours,
//     the ASAP list and online requests waiting;
//   - supply vs demand in hours a week;
// then green/amber/red against the practice's own targets and plain recommendations, worked out by fixed rules
// (no AI) and always shown with the numbers behind them. Nothing here is money: the page is for anyone who can
// see the schedule.
//
// The calculation is pure (computeCapacity takes plain rows and returns plain numbers) so it can be tested
// without a database; loadCapacityInputs gathers the rows. Appointment times are practice-local wall-clock
// strings ('YYYY-MM-DD HH:MM'); "now" is the practice's own local time.
import { HttpError } from './auth.js';
import { providerHoursFor } from './hours.js';
import { loadTemplates, planDays, blocksOn, kindOf } from './production.js';
import { recallTypes } from './recalls.js';
import { typeDuration } from './patterns.js';
import { localNow } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';

export const KINDS = ['doctor', 'hygiene'];
export const KIND_LABELS = { doctor: 'Doctor', hygiene: 'Hygiene' };
export const WINDOWS = { w2: 14, w4: 28, w8: 56 };
export const HORIZON_DAYS = 120; // how far ahead we look for a first opening
export const HISTORY_DAYS = 56; // the recent weeks new-patient and emergency visits are counted over
export const OPEN_BLOCK_DAYS = 14; // perfect-day blocks still open in the next two weeks
export const TREATMENT_BUCKETS = [30, 60, 90];
export const SNAPSHOT_KEEP_DAYS = 731; // trend rows older than two years are removed (derived data)
// A planned procedure's length when its code has no time units set (10-minute units on procedure_codes).
export const CATEGORY_MINUTES = {
  diagnostic: 20, preventive: 40, restorative: 60, endodontics: 90, periodontics: 60, prosthodontics: 90,
  oral_surgery: 60, orthodontics: 30, implants: 90, adjunctive: 20,
};

// ---- Targets ----
// The practice's own targets (practices.capacity_targets, JSON). Days are calendar days except emergencies
// (business days: days the office is open). Booked % is a band: under it the chair has room to fill, over it the
// schedule is too full to take new work. backlog_weeks: how quickly overdue recall and unscheduled treatment should be
// worked off (spreads that backlog into hours a week). The visit-type ids choose which appointment type is the new
// patient and the emergency visit when the office's names don't make it obvious (null = found automatically).
export const DEFAULT_TARGETS = {
  new_patient_days: 7, emergency_business_days: 1, hygiene_days: 21, treatment_days: 14,
  booked_low: 85, booked_high: 95, backlog_weeks: 8, new_patient_type_id: null, emergency_type_id: null,
};
const RANGES = {
  new_patient_days: [0, 90, 'New patients within'], emergency_business_days: [0, 10, 'Emergencies within'],
  hygiene_days: [0, 120, 'Hygiene within'], treatment_days: [0, 120, 'Treatment within'],
  booked_low: [0, 100, 'Booked % (low end)'], booked_high: [0, 100, 'Booked % (high end)'], backlog_weeks: [1, 52, 'Work off the backlog over'],
};

export function parseTargets(stored) {
  let o = {};
  try {
    o = typeof stored === 'string' ? JSON.parse(stored || '{}') : stored || {};
  } catch {
    o = {};
  }
  const out = { ...DEFAULT_TARGETS };
  for (const k of Object.keys(DEFAULT_TARGETS)) if (o && o[k] != null && o[k] !== '') out[k] = Number(o[k]);
  return out;
}

// Checks a change to the targets (only the fields sent) on top of the current ones; returns the full set.
// Throws a 400 in plain words. Type ids are checked against the practice by the route.
export function validateTargets(input, current = DEFAULT_TARGETS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Send the targets as an object');
  const unknown = Object.keys(input).filter((k) => !(k in DEFAULT_TARGETS));
  if (unknown.length) throw new HttpError(400, `Unknown target: ${unknown.join(', ')}`);
  const out = { ...DEFAULT_TARGETS, ...current };
  for (const [k, [min, max, label]] of Object.entries(RANGES)) {
    if (!(k in input)) continue;
    const n = Number(input[k]);
    if (input[k] === null || input[k] === '' || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}: a whole number from ${min} to ${max}`);
    out[k] = n;
  }
  for (const k of ['new_patient_type_id', 'emergency_type_id']) {
    if (!(k in input)) continue;
    if (input[k] === null || input[k] === '') { out[k] = null; continue; }
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${k === 'new_patient_type_id' ? 'New patient' : 'Emergency'} visit type: choose one of the office's visit types`);
    out[k] = n;
  }
  if (out.booked_low > out.booked_high) throw new HttpError(400, 'Booked %: the low end must not be above the high end');
  return out;
}

// ---- Small helpers ----
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round1 = (n) => Math.round(n * 10) / 10;
const pctOf = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
const parseIds = (v) => {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isInteger);
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
};
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};
// Interval arithmetic on [start, end] minutes of a day.
const union = (list) => {
  const s = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of s) {
    if (out.length && r[0] <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], r[1]);
    else out.push(r);
  }
  return out;
};
const subtract = (ranges, cuts) => {
  let out = ranges.map(([a, b]) => [a, b]);
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
  }
  return out;
};
const length = (rs) => rs.reduce((n, [a, b]) => n + (b - a), 0);
const intersectLength = (a, b) => {
  let n = 0;
  for (const [s1, e1] of a) for (const [s2, e2] of b) n += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  return n;
};
// The part of a 'YYYY-MM-DD HH:MM' span that falls on `date`, in minutes of that day (null when none).
const onDate = (start, end, date) => {
  const d0 = start.slice(0, 10);
  const d1 = end.slice(0, 10);
  if (d0 > date || d1 < date) return null;
  const s = d0 < date ? 0 : toMin(start.slice(11, 16));
  const e = d1 > date ? 24 * 60 : toMin(end.slice(11, 16));
  return e > s ? [s, e] : null;
};
const addMinutes = (dateTime, minutes) => {
  const t = Date.parse(`${dateTime.replace(' ', 'T')}:00Z`) + minutes * 60_000;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
};

// "5 weeks", "10 days", "1 day", "today".
export function waitWords(days) {
  if (days == null) return `more than ${Math.floor(HORIZON_DAYS / 7)} weeks`;
  if (days === 0) return 'today';
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  return `${days} day${days === 1 ? '' : 's'}`;
}
// 140, 12.5, 0.5 — hours for sentences.
export const hoursWords = (h) => (h >= 10 ? String(Math.round(h)) : String(round1(h)));
// '18:00' → '6 pm', '17:30' → '5:30 pm'.
export function clockWords(t) {
  const [h, m] = [Math.floor(t / 60), t % 60];
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
// "Dr. Ann Lee, DDS" → "Dr. Ann Lee".
export const shortName = (name) => String(name || '').replace(/,.*$/, '').trim() || 'This provider';
const possessive = (name) => (name.endsWith('s') ? `${name}’` : `${name}’s`);

// ---- Status against a target ----
export const SEVERITY = { green: 0, none: 0, amber: 1, red: 2 };
export const worst = (list) => list.reduce((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'green');
// A wait: on target is green; a little over (half the target again, at least one day) amber; beyond, or no
// opening at all within the horizon, red.
export function waitStatus(days, target) {
  if (days == null) return 'red';
  if (days <= target) return 'green';
  if (days <= target + Math.max(1, Math.ceil(target * 0.5))) return 'amber';
  return 'red';
}
// Booked %: inside the band green. Under it amber (up to ten points under), then red — the chair has room.
// Over it amber, and red when halfway from the top of the band to 100% — too full to take new work.
export function bookedStatus(pct, low, high) {
  if (pct == null) return 'none';
  if (pct < low) return pct >= low - 10 ? 'amber' : 'red';
  if (pct > high) return pct >= high + (100 - high) / 2 ? 'red' : 'amber';
  return 'green';
}
// Supply vs demand (hours a week): enough open time is green; short by less than half a working day amber.
export function gapStatus(gapHours, dayHours) {
  if (gapHours >= 0) return 'green';
  return -gapHours < dayHours / 2 ? 'amber' : 'red';
}

// ---- Visit kinds ----
const hasCode = (t, re) => parseList(t.procedure_codes).some((c) => re.test(String(c)));
const XRAY_ONLY = (codes) => codes.length > 0 && codes.every((c) => /^D0[23]/.test(String(c)));
// Which of the office's appointment types is which kind of visit.
export function classifyTypes(types, recallTypeRows, targets = DEFAULT_TARGETS) {
  const active = types.filter((t) => t.active !== 0);
  const byId = new Map(types.map((t) => [t.id, t]));
  const newPatient = (targets.new_patient_type_id && byId.get(targets.new_patient_type_id))
    || active.find((t) => hasCode(t, /^D0150$/)) || active.find((t) => /new patient|\bnp\b/i.test(t.name)) || null;
  const emergency = (targets.emergency_type_id && byId.get(targets.emergency_type_id))
    || active.find((t) => hasCode(t, /^D0140$/)) || active.find((t) => /emergenc|limited|toothache|urgent/i.test(t.name)) || null;
  // Recall visits: the recall types' own visit types (x-ray-only recall types ride along with the cleaning).
  const recallVisitTypes = [];
  const recallMinutes = {};
  for (const rt of recallTypeRows.filter((r) => r.active !== 0)) {
    const codes = parseList(rt.codes);
    if (XRAY_ONLY(codes) || rt.bundle) continue; // x-rays, exam and fluoride come with the cleaning
    const t = (rt.appointment_type_id && byId.get(rt.appointment_type_id))
      || active.find((x) => x.id !== newPatient?.id && x.provider_type === 'hygienist' && parseList(x.procedure_codes).some((c) => codes.includes(c)))
      || null;
    if (t && !recallVisitTypes.includes(t)) recallVisitTypes.push(t);
    recallMinutes[rt.key] = t?.duration || 60;
  }
  if (!recallVisitTypes.length) {
    const t = active.find((x) => x.id !== newPatient?.id && /recall|prophy|cleaning|perio maint/i.test(x.name));
    if (t) recallVisitTypes.push(t);
  }
  const special = new Set([newPatient?.id, emergency?.id, ...recallVisitTypes.map((t) => t.id)].filter(Boolean));
  const treatment = active.filter((t) => !special.has(t.id) && t.provider_type !== 'hygienist');
  return {
    newPatient, emergency, recall: recallVisitTypes, treatment, recallMinutes,
    kindOfType: (t, fallback = 'doctor') => (t?.provider_type ? kindOf(t.provider_type) : fallback),
  };
}

// ---- The calculation ----
// `input` (see loadCapacityInputs for where each comes from):
//   today, now ('YYYY-MM-DD', 'YYYY-MM-DD HH:MM', practice-local), locationId (null = the whole practice),
//   practice { office_hours }, locations [{ id, name, office_hours }], providers [{ id, name, type, working_hours }],
//   exceptions [{ provider_id, date, hours }], blockouts [{ provider_id, operatory_id, start_time, end_time, kind, appointment_type_ids }],
//   appointments [{ provider_id, location_id, start_time, end_time, appointment_type_id, asap, status }] (live visits),
//   holds [{ provider_id, start_time, end_time }] (online requests holding their time), templateBlocks [{ provider_id, date,
//   start_time, end_time, appointment_type_ids, release_at, label, location_id }], planOffices { 'providerId|date': locationId },
//   home { providerId: locationId }, types, recallTypes, recalls [{ patient_id, type, due_date, location_id }],
//   planned [{ patient_id, category, time_units, provider_type, location_id, home_location_id }],
//   waitlist [{ provider_type, reason, duration, location_id }], requests [{ provider_type, reason, new_patient, duration, created_at, location_id }],
//   targets.
export function computeCapacity(input) {
  const targets = parseTargets(input.targets);
  const { today, now, locationId = null } = input;
  const activeLocations = (input.locations || []).filter((l) => l.active !== 0);
  const singleOffice = activeLocations.length <= 1;
  const location = locationId ? activeLocations.find((l) => l.id === locationId) || (input.locations || []).find((l) => l.id === locationId) : null;
  const hoursSourceFor = (officeId) => {
    const loc = officeId ? (input.locations || []).find((l) => l.id === officeId) : null;
    return { office_hours: loc?.office_hours || input.practice?.office_hours || null };
  };
  const officeHoursSource = hoursSourceFor(locationId);
  const officeOpen = (date) => providerHoursFor(officeHoursSource, null, date).length > 0;
  // A row with an office belongs here when it's this office; one with none when the practice has one office.
  const here = (officeId) => !locationId || officeId === locationId || (officeId == null && singleOffice);

  const exceptions = new Map((input.exceptions || []).map((e) => [`${e.provider_id}|${e.date}`, typeof e.hours === 'string' ? JSON.parse(e.hours) : e.hours]));
  const apptsBy = new Map();
  for (const a of input.appointments || []) {
    for (let d = a.start_time.slice(0, 10); d <= a.end_time.slice(0, 10); d = addDays(d, 1)) {
      const k = `${a.provider_id}|${d}`;
      if (!apptsBy.has(k)) apptsBy.set(k, []);
      apptsBy.get(k).push(a);
    }
  }
  const tblocksBy = new Map();
  for (const b of input.templateBlocks || []) {
    const k = `${b.provider_id}|${b.date}`;
    if (!tblocksBy.has(k)) tblocksBy.set(k, []);
    tblocksBy.get(k).push(b);
  }
  const typesById = new Map((input.types || []).map((t) => [t.id, t]));
  const kinds = classifyTypes(input.types || [], input.recallTypes || [], targets);

  // Which office a provider is working in on a date: their perfect-day plan's office, else where most of that
  // day's visits are, else their home office (the office of their usual chair, or where they work most).
  const officeOf = (pv, date) => {
    const plan = input.planOffices?.[`${pv.id}|${date}`];
    if (plan) return plan;
    const counts = new Map();
    for (const a of apptsBy.get(`${pv.id}|${date}`) || []) if (a.location_id) counts.set(a.location_id, (counts.get(a.location_id) || 0) + 1);
    if (counts.size) return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
    return input.home?.[pv.id] ?? null;
  };

  // One provider's day: available time (their hours, less days off and blocked time), what's booked, and what
  // stands in the way of a new visit.
  const days = new Map();
  const dayOf = (pv, date) => {
    const key = `${pv.id}|${date}`;
    if (days.has(key)) return days.get(key);
    const office = officeOf(pv, date);
    const ex = exceptions.get(key);
    const ranges = union((ex ?? providerHoursFor(hoursSourceFor(office), pv, date)).map(([o, c]) => [toMin(o), toMin(c)]));
    const mine = (input.blockouts || []).filter((b) => (b.provider_id === pv.id || (b.provider_id == null && b.operatory_id == null)));
    const blocked = [];
    const reserved = [];
    for (const b of mine) {
      const span = onDate(b.start_time, b.end_time, date);
      if (!span) continue;
      if (b.kind === 'reserved') reserved.push({ span, ids: parseIds(b.appointment_type_ids) });
      else blocked.push(span);
    }
    const avail = subtract(ranges, blocked);
    const visits = (apptsBy.get(key) || []).map((a) => onDate(a.start_time, a.end_time, date)).filter(Boolean);
    const held = (input.holds || []).filter((h) => h.provider_id === pv.id).map((h) => onDate(h.start_time, h.end_time, date)).filter(Boolean);
    const booked = union(visits);
    const day = {
      office, avail, availMin: length(avail), bookedMin: intersectLength(booked, avail), busy: union([...visits, ...held]), reserved,
      tblocks: (tblocksBy.get(key) || []).map((b) => ({ span: [toMin(b.start_time.slice(-5)), toMin(b.end_time.slice(-5))], ids: parseIds(b.appointment_type_ids), release_at: b.release_at })),
    };
    days.set(key, day);
    return day;
  };
  const inOffice = (day) => here(day.office);

  // The earliest start (minutes) on a day for a visit of `duration` that `allowed` types may take, or null.
  const nowMin = toMin(now.slice(11, 16));
  const earliestOn = (day, date, duration, allowed) => {
    const lets = (ids) => ids.some((id) => allowed.has(id));
    const cuts = [...day.busy];
    for (const r of day.reserved) if (!lets(r.ids)) cuts.push(r.span);
    for (const b of day.tblocks) if (b.ids.length && !lets(b.ids) && !(b.release_at && b.release_at <= now)) cuts.push(b.span);
    for (const [s, e] of subtract(day.avail, cuts)) {
      let t = date === today ? Math.max(s, nowMin) : s;
      t = Math.ceil(t / 10) * 10;
      if (t + duration <= e) return t;
    }
    return null;
  };
  const businessDays = (date) => {
    let n = 0;
    for (let d = addDays(today, 1); d <= date; d = addDays(d, 1)) if (officeOpen(d)) n++;
    return n;
  };
  // The first opening for a kind of visit among some providers: { date, time, provider_id, provider, days, business_days }.
  const firstOpening = (providers, { duration, type = null, types = [] }) => {
    const allowed = new Set(types.map((t) => t.id));
    for (let i = 0; i <= HORIZON_DAYS; i++) {
      const date = addDays(today, i);
      let best = null;
      for (const pv of providers) {
        const day = dayOf(pv, date);
        if (!inOffice(day) || !day.availMin) continue;
        const len = (type && typeDuration(type, pv.id)) || duration;
        const t = earliestOn(day, date, len, allowed);
        if (t != null && (!best || t < best.t)) best = { t, pv, len };
      }
      if (best) {
        return {
          date, time: hhmm(best.t), start: `${date} ${hhmm(best.t)}`, minutes: best.len, provider_id: best.pv.id, provider: best.pv.name,
          days: i, business_days: businessDays(date),
        };
      }
    }
    return null;
  };

  const providers = (input.providers || []).filter((p) => p.active !== 0);
  const kindOfProvider = (pv) => kindOf(pv.type);
  // How full the next 2/4/8 weeks are for some providers (in this office).
  const bookedFor = (list) => {
    const out = {};
    for (const w of Object.keys(WINDOWS)) out[w] = { available_minutes: 0, booked_minutes: 0 };
    const weekdays = {};
    for (let i = 0; i < WINDOWS.w8; i++) {
      const date = addDays(today, i);
      for (const pv of list) {
        const day = dayOf(pv, date);
        if (!inOffice(day)) continue;
        for (const [w, n] of Object.entries(WINDOWS)) {
          if (i >= n) continue;
          out[w].available_minutes += day.availMin;
          out[w].booked_minutes += day.bookedMin;
        }
        if (i < WINDOWS.w4 && day.availMin) {
          const wd = weekdayOf(date);
          weekdays[wd] ||= { available_minutes: 0, booked_minutes: 0 };
          weekdays[wd].available_minutes += day.availMin;
          weekdays[wd].booked_minutes += day.bookedMin;
        }
      }
    }
    for (const w of Object.keys(WINDOWS)) out[w].pct = pctOf(out[w].booked_minutes, out[w].available_minutes);
    out.status = bookedStatus(out.w4.pct, targets.booked_low, targets.booked_high);
    out.weekdays = weekdays;
    return out;
  };
  // Does the provider work in this office at all in the next 8 weeks (or is it their home office)?
  const worksHere = (pv) => {
    if (!locationId) return true;
    if (input.home?.[pv.id] === locationId) return true;
    for (let i = 0; i < WINDOWS.w8; i++) {
      const day = dayOf(pv, addDays(today, i));
      if (day.availMin && inOffice(day)) return true;
    }
    return false;
  };
  const staff = providers.filter(worksHere);
  const byKind = { doctor: staff.filter((p) => kindOfProvider(p) === 'doctor'), hygiene: staff.filter((p) => kindOfProvider(p) === 'hygiene') };
  // Visits a hygienist would normally take go to the doctors when the office has no hygienist (and vice versa).
  const kindFor = (k) => (byKind[k].length || !byKind[k === 'doctor' ? 'hygiene' : 'doctor'].length ? k : (k === 'doctor' ? 'hygiene' : 'doctor'));
  const npKind = kindFor(kinds.kindOfType(kinds.newPatient, 'doctor'));
  const emKind = kindFor(kinds.kindOfType(kinds.emergency, 'doctor'));
  const recallKind = kindFor(kinds.recall.length ? kinds.kindOfType(kinds.recall[0], 'hygiene') : 'hygiene');
  const treatKind = kindFor('doctor');

  // A provider's usual working day in hours (for "add a day" and "extend to") and their regular week.
  const regularWeek = (pv) => {
    const out = {};
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const office = input.home?.[pv.id] ?? locationId ?? null;
      const ranges = providerHoursFor(hoursSourceFor(office), pv, date).map(([o, c]) => [toMin(o), toMin(c)]);
      if (ranges.length) out[weekdayOf(date)] = { open: ranges[0][0], close: ranges.at(-1)[1], minutes: length(ranges) };
    }
    return out;
  };
  const dayHoursOf = (list) => {
    const lens = list.flatMap((pv) => Object.values(regularWeek(pv)).map((d) => d.minutes));
    return lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length / 60 : 8;
  };

  // ---- Demand ----
  const recallMinutes = (key) => kinds.recallMinutes[key] ?? null;
  // One visit per patient: the longest of the recall visits they're due for, at the earliest due date.
  const recallsByPatient = new Map();
  for (const r of input.recalls || []) {
    if (!here(r.location_id)) continue;
    const m = recallMinutes(r.type);
    if (m == null) continue; // x-ray-only recall types come with the cleaning
    const had = recallsByPatient.get(r.patient_id);
    if (!had) recallsByPatient.set(r.patient_id, { minutes: m, due: r.due_date });
    else recallsByPatient.set(r.patient_id, { minutes: Math.max(had.minutes, m), due: r.due_date < had.due ? r.due_date : had.due });
  }
  const recallBucket = (from, to) => {
    const rows = [...recallsByPatient.values()].filter((r) => r.due >= from && r.due <= to);
    return { patients: rows.length, hours: round1(rows.reduce((n, r) => n + r.minutes, 0) / 60) };
  };
  const recall = {
    due_4w: recallBucket(today, addDays(today, WINDOWS.w4 - 1)),
    due_8w: recallBucket(today, addDays(today, WINDOWS.w8 - 1)),
    overdue: recallBucket(addDays(today, -365), addDays(today, -1)),
  };

  // Unscheduled treatment: the same rows as production.js (planned, not on a visit, active patients), in hours.
  const unscheduled = { doctor: { procedures: 0, patients: new Set(), minutes: 0 }, hygiene: { procedures: 0, patients: new Set(), minutes: 0 } };
  for (const x of input.planned || []) {
    if (!here(x.location_id ?? x.home_location_id ?? null)) continue;
    const k = kindFor(x.provider_type ? kindOf(x.provider_type) : x.category === 'preventive' ? 'hygiene' : 'doctor');
    const u = unscheduled[k];
    u.procedures++;
    u.patients.add(x.patient_id);
    u.minutes += Number(x.time_units) > 0 ? Number(x.time_units) * 10 : CATEGORY_MINUTES[x.category] ?? 30;
  }
  const hygieneWords = /clean|hygien|recall|prophy|perio maint/i;
  const kindOfWish = (row) => kindFor(row.provider_type ? kindOf(row.provider_type)
    : hygieneWords.test(row.reason || '') ? 'hygiene' : row.new_patient ? npKind : 'doctor');
  const asap = { doctor: { visits: 0, waitlist: 0 }, hygiene: { visits: 0, waitlist: 0 } };
  for (const a of input.appointments || []) {
    if (!a.asap || a.start_time <= now || !['scheduled', 'confirmed'].includes(a.status) || !here(a.location_id)) continue;
    const pv = providers.find((p) => p.id === a.provider_id);
    asap[kindFor(pv ? kindOf(pv.type) : 'doctor')].visits++;
  }
  for (const w of input.waitlist || []) if (here(w.location_id)) asap[kindOfWish(w)].waitlist++;
  const requests = { doctor: { count: 0, oldest_days: null }, hygiene: { count: 0, oldest_days: null } };
  for (const r of input.requests || []) {
    if (!here(r.location_id)) continue;
    const q = requests[kindOfWish(r)];
    q.count++;
    const age = daysBetween(String(r.created_at).slice(0, 10), today);
    q.oldest_days = Math.max(q.oldest_days ?? 0, age);
  }

  // New patients and emergencies of the last 8 weeks: the run rate new demand arrives at.
  const histFrom = addDays(today, -HISTORY_DAYS);
  const history = { new_patient: { visits: 0, minutes: 0 }, emergency: { visits: 0, minutes: 0 } };
  for (const a of input.appointments || []) {
    const d = a.start_time.slice(0, 10);
    if (d < histFrom || d >= today || !here(a.location_id)) continue;
    const mins = Math.max(0, daysBetween(d, a.end_time.slice(0, 10)) * 1440 + toMin(a.end_time.slice(11, 16)) - toMin(a.start_time.slice(11, 16)));
    if (kinds.newPatient && a.appointment_type_id === kinds.newPatient.id) { history.new_patient.visits++; history.new_patient.minutes += mins; }
    if (kinds.emergency && a.appointment_type_id === kinds.emergency.id) { history.emergency.visits++; history.emergency.minutes += mins; }
  }
  let openDaysPast = 0;
  for (let d = histFrom; d < today; d = addDays(d, 1)) if (officeOpen(d)) openDaysPast++;
  const weeksPast = HISTORY_DAYS / 7;

  // ---- Openings ----
  const npMinutes = kinds.newPatient?.duration || 60;
  const emMinutes = kinds.emergency?.duration || 30;
  const recallType = kinds.recall[0] || null;
  const recallLen = recallType?.duration || 60;
  const openingsFor = (list, k) => {
    const o = {};
    if (k === npKind) o.new_patient = firstOpening(list, { duration: npMinutes, type: kinds.newPatient, types: kinds.newPatient ? [kinds.newPatient] : [] });
    if (k === emKind) o.emergency = firstOpening(list, { duration: emMinutes, type: kinds.emergency, types: kinds.emergency ? [kinds.emergency] : [] });
    if (k === recallKind) o.recall = firstOpening(list, { duration: recallLen, type: recallType, types: kinds.recall });
    if (k === treatKind) for (const m of TREATMENT_BUCKETS) o[`treatment_${m}`] = firstOpening(list, { duration: m, types: kinds.treatment });
    return o;
  };
  const meterOf = (key, opening) => {
    const target = key === 'new_patient' ? targets.new_patient_days : key === 'emergency' ? targets.emergency_business_days
      : key === 'recall' ? targets.hygiene_days : targets.treatment_days;
    const days = opening ? (key === 'emergency' ? opening.business_days : opening.days) : null;
    return { key, days, target, unit: key === 'emergency' ? 'business days' : 'days', status: waitStatus(days, target) };
  };
  const OPENING_LABELS = {
    new_patient: 'New patient', emergency: 'Emergency', recall: 'Recall / hygiene',
    treatment_30: 'Treatment 30 min', treatment_60: 'Treatment 60 min', treatment_90: 'Treatment 90 min+',
  };
  const withMeters = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => {
    const base = k.startsWith('treatment_') ? 'treatment' : k;
    return [k, { label: OPENING_LABELS[k], opening: v, ...meterOf(base, v), key: k }];
  }));

  // Open perfect-day blocks in the next two weeks: kept for some visit types and nothing matching booked in them.
  const openBlocks = (list) => {
    const out = [];
    const ids = new Set(list.map((p) => p.id));
    for (const b of input.templateBlocks || []) {
      if (!ids.has(b.provider_id) || b.date < today || b.date >= addDays(today, OPEN_BLOCK_DAYS)) continue;
      const pv = list.find((p) => p.id === b.provider_id);
      const day = dayOf(pv, b.date);
      if (!inOffice(day) || b.end_time <= now) continue;
      const kept = parseIds(b.appointment_type_ids);
      if (!kept.length) continue;
      const inside = (apptsBy.get(`${b.provider_id}|${b.date}`) || []).filter((a) => a.start_time < b.end_time && a.end_time > b.start_time);
      if (inside.some((a) => kept.includes(a.appointment_type_id))) continue;
      out.push({
        provider_id: b.provider_id, provider: pv.name, date: b.date, start_time: b.start_time, end_time: b.end_time, label: b.label,
        minutes: toMin(b.end_time.slice(-5)) - toMin(b.start_time.slice(-5)), kept_for: kept.map((id) => typesById.get(id)?.name).filter(Boolean),
        released: !!(b.release_at && b.release_at <= now), release_at: b.release_at || null,
      });
    }
    out.sort((a, b) => a.start_time.localeCompare(b.start_time));
    return { count: out.length, hours: round1(out.reduce((n, b) => n + b.minutes, 0) / 60), list: out.slice(0, 20) };
  };

  // ---- Per kind ----
  const result = { kinds: {}, providers: [] };
  for (const k of KINDS) {
    const list = byKind[k];
    const booked = bookedFor(list);
    const openings = list.length ? withMeters(openingsFor(list, k)) : {};
    const dayHours = round1(dayHoursOf(list));
    const available8 = booked.w8.available_minutes / 60;
    const open8 = Math.max(0, booked.w8.available_minutes - booked.w8.booked_minutes) / 60;
    const npRate = npKind === k ? history.new_patient.minutes / 60 / weeksPast : 0;
    const emRate = emKind === k ? history.emergency.minutes / 60 / weeksPast : 0;
    const u = unscheduled[k];
    const recallHere = recallKind === k;
    const demandParts = {
      recall_due: recallHere ? recall.due_8w.hours / (WINDOWS.w8 / 7) : 0,
      recall_overdue: recallHere ? recall.overdue.hours / targets.backlog_weeks : 0,
      unscheduled: u.minutes / 60 / targets.backlog_weeks,
      new_patients: npRate,
      emergencies: emRate,
    };
    const demandWeek = Object.values(demandParts).reduce((a, b) => a + b, 0);
    const supply = { available_hours_week: round1(available8 / 8), booked_hours_week: round1((booked.w8.booked_minutes / 60) / 8), open_hours_week: round1(open8 / 8) };
    const gap = round1(supply.open_hours_week - demandWeek);
    const kindOut = {
      kind: k, label: KIND_LABELS[k], provider_ids: list.map((p) => p.id), day_hours: dayHours,
      booked: { w2: booked.w2, w4: booked.w4, w8: booked.w8, status: list.length ? booked.status : 'none', low: targets.booked_low, high: targets.booked_high },
      openings,
      supply,
      demand: {
        hours_week: round1(demandWeek), parts: Object.fromEntries(Object.entries(demandParts).map(([x, v]) => [x, round1(v)])),
        recall: recallHere ? recall : null,
        unscheduled: { procedures: u.procedures, patients: u.patients.size, hours: round1(u.minutes / 60) },
        asap: { ...asap[k], count: asap[k].visits + asap[k].waitlist },
        requests: requests[k],
        new_patients: npKind === k ? { visits_8w: history.new_patient.visits, per_week: round1(history.new_patient.visits / weeksPast) } : null,
        emergencies: emKind === k ? { visits_8w: history.emergency.visits, per_day: openDaysPast ? round1(history.emergency.visits / openDaysPast) : 0 } : null,
      },
      gap_hours_week: gap,
      gap_status: list.length ? gapStatus(gap, dayHours) : 'none',
      blocks: openBlocks(list),
    };
    kindOut.status = list.length ? worst([kindOut.booked.status, kindOut.gap_status, ...Object.values(openings).map((m) => m.status)]) : 'none';
    result.kinds[k] = kindOut;
  }
  // ---- Per provider ----
  for (const pv of staff) {
    const k = kindOfProvider(pv);
    const booked = bookedFor([pv]);
    const openings = withMeters(openingsFor([pv], k));
    result.providers.push({
      id: pv.id, name: pv.name, kind: k, booked: { w2: booked.w2, w4: booked.w4, w8: booked.w8, status: booked.status, weekdays: booked.weekdays },
      openings, week: regularWeek(pv),
      status: worst([booked.status, ...Object.values(openings).map((m) => m.status)]),
    });
  }
  result.recommendations = recommend(result, targets, { recall, byKind, history, openDaysPast, weeksPast, recallLen, npKind, emKind, recallKind, treatKind, officeOpen, today });
  result.status = worst(KINDS.map((k) => result.kinds[k].status));
  return {
    today, now, location_id: locationId, office: location ? { id: location.id, name: location.name } : null, targets,
    visit_types: {
      new_patient: kinds.newPatient ? { id: kinds.newPatient.id, name: kinds.newPatient.name, minutes: npMinutes, kind: npKind } : { id: null, name: null, minutes: npMinutes, kind: npKind },
      emergency: kinds.emergency ? { id: kinds.emergency.id, name: kinds.emergency.name, minutes: emMinutes, kind: emKind } : { id: null, name: null, minutes: emMinutes, kind: emKind },
      recall: { ids: kinds.recall.map((t) => t.id), names: kinds.recall.map((t) => t.name), minutes: recallLen, kind: recallKind },
      treatment: { ids: kinds.treatment.map((t) => t.id), kind: treatKind },
    },
    ...result,
  };
}

// ---- Recommendations ----
// Fixed rules, so the same schedule always gives the same advice. Each has the numbers behind it and a
// severity (red, amber); red first. Nothing is changed by them: they're for the owner or office manager to act on.
export function recommend(r, targets, ctx) {
  const out = [];
  const add = (x) => out.push({ ...x, id: `${x.rule}:${x.provider_id ?? x.kind}` });
  const hyg = r.kinds.hygiene;
  const doc = r.kinds.doctor;
  const band = `${targets.booked_low}–${targets.booked_high}%`;

  // Hygiene: booked out (the recall wait is over target, or the next 4 weeks are over the band) → add a day.
  const recallKindOut = r.kinds[ctx.recallKind];
  const recallMeter = recallKindOut?.openings?.recall;
  if (recallMeter && recallKindOut.provider_ids.length) {
    const tooFull = recallKindOut.booked.w4.pct != null && recallKindOut.booked.w4.pct > targets.booked_high;
    if (recallMeter.status !== 'green' || tooFull) {
      const dayHours = recallKindOut.day_hours || 8;
      const perDay = Math.max(1, Math.floor((dayHours * 60) / ctx.recallLen));
      const short = Math.max(0, -recallKindOut.gap_hours_week);
      const daysNeeded = Math.min(5, Math.max(1, Math.ceil(short / dayHours - 0.25)));
      const due = ctx.recall.due_4w;
      const who = ctx.recallKind === 'hygiene' ? 'Hygiene' : 'The doctors’ recall visits';
      const dayWord = ctx.recallKind === 'hygiene' ? 'hygiene day' : 'recall day';
      const wait = recallMeter.days;
      const severity = worst([recallMeter.status, recallKindOut.booked.status === 'red' && tooFull ? 'red' : 'amber']);
      add({
        rule: 'add_hygiene_day', kind: ctx.recallKind, severity,
        text: `${who} is booked ${waitWords(wait)} out${due.hours > 0 ? ` and ${hoursWords(due.hours)} recall hours are due in the next month` : ''}: `
          + `add ${daysNeeded === 1 ? `a ${dayWord}` : `${daysNeeded} ${dayWord}s a week`} (about ${perDay * daysNeeded} more visits a week)`,
        numbers: {
          first_recall_opening: recallMeter.opening?.start ?? null, wait_days: wait, target_days: targets.hygiene_days,
          booked_pct_4w: recallKindOut.booked.w4.pct, recall_hours_due_4w: due.hours, recall_patients_due_4w: due.patients,
          overdue_patients: ctx.recall.overdue.patients, open_hours_week: recallKindOut.supply.open_hours_week, needed_hours_week: recallKindOut.demand.hours_week,
          visits_per_day: perDay, days_to_add: daysNeeded,
        },
        because: `First recall opening ${recallMeter.opening ? `${recallMeter.opening.date} (${recallMeter.days} days)` : `none in ${HORIZON_DAYS} days`}, target ${targets.hygiene_days} days · `
          + `${pctWords(recallKindOut.booked.w4.pct)} booked next 4 weeks · ${hoursWords(recallKindOut.supply.open_hours_week)} open hours a week vs ${hoursWords(recallKindOut.demand.hours_week)} needed`,
        action: { label: 'Open the schedule setup', to: '/settings?tab=schedule' },
      });
    }
  }
  // Hygiene under-booked: room in the chair and patients due.
  if (hyg.provider_ids.length && ['amber', 'red'].includes(hyg.booked.status) && hyg.booked.w4.pct < targets.booked_low && (!recallMeter || recallMeter.status === 'green' || ctx.recallKind !== 'hygiene')) {
    const due = ctx.recall.due_4w;
    const asapN = hyg.demand.asap.count;
    add({
      rule: 'fill_hygiene', kind: 'hygiene', severity: hyg.booked.status,
      text: `Hygiene is only ${pctWords(hyg.booked.w4.pct)} booked for the next 4 weeks (target ${band}): `
        + `${due.patients} patient${due.patients === 1 ? ' is' : 's are'} due for recall in the next month — work the recall list${asapN ? ` and the ASAP list (${asapN})` : ''}`,
      numbers: { booked_pct_4w: hyg.booked.w4.pct, target_low: targets.booked_low, recall_patients_due_4w: due.patients, overdue_patients: ctx.recall.overdue.patients, asap: asapN },
      because: `${hoursWords((hyg.booked.w4.available_minutes - hyg.booked.w4.booked_minutes) / 60)} open hygiene hours in the next 4 weeks`,
      action: { label: 'Open the recall list', to: '/followups?tab=recall' },
    });
  }

  // Each doctor: treatment booked out → extend a day or open another; under-booked → work the lists.
  const docProviders = r.providers.filter((p) => p.kind === 'doctor');
  for (const p of docProviders) {
    const m = p.openings.treatment_60 || p.openings.treatment_30;
    const name = shortName(p.name);
    if (m && m.status !== 'green') {
      const doctorShort = Math.max(0, -doc.gap_hours_week) / Math.max(1, docProviders.length);
      const ext = Math.min(2, Math.max(1, Math.ceil(doctorShort * 2) / 2));
      const plan = extendPlan(p.week, ext, p.booked.weekdays);
      // Far over target (red) or short of hours: another day as well as a longer one.
      const both = doctorShort > 2 || m.status === 'red' || !plan.extend;
      const pieces = [plan.extend ? `extend ${plan.extend.day} to ${clockWords(plan.extend.to)}` : null, plan.open && both ? `open a ${plan.open}` : null].filter(Boolean);
      add({
        rule: 'extend_doctor', kind: 'doctor', provider_id: p.id, severity: m.status,
        text: `${possessive(name)} treatment is ${waitWords(m.days)} out: ${pieces.length ? pieces.join(' or ') : 'add treatment time'}`,
        numbers: {
          first_treatment_opening: m.opening?.start ?? null, wait_days: m.days, target_days: targets.treatment_days, booked_pct_4w: p.booked.w4.pct,
          unscheduled_hours: doc.demand.unscheduled.hours, short_hours_week: round1(doctorShort), extend_hours: plan.extend ? ext : null,
        },
        because: `First ${m.opening?.minutes || 60}-minute treatment opening ${m.opening ? `${m.opening.date} (${m.days} days)` : `none in ${HORIZON_DAYS} days`}, target ${targets.treatment_days} days · `
          + `${pctWords(p.booked.w4.pct)} booked next 4 weeks · ${hoursWords(doc.demand.unscheduled.hours)} hours of treatment not yet scheduled`,
        action: { label: 'Open the schedule setup', to: '/settings?tab=schedule' },
      });
    } else if (['amber', 'red'].includes(p.booked.status) && p.booked.w4.pct != null && p.booked.w4.pct < targets.booked_low) {
      add({
        rule: 'fill_doctor', kind: 'doctor', provider_id: p.id, severity: p.booked.status,
        text: `${name} is only ${pctWords(p.booked.w4.pct)} booked for the next 4 weeks (target ${band}): `
          + `${hoursWords(doc.demand.unscheduled.hours)} hours of treatment for ${doc.demand.unscheduled.patients} patient${doc.demand.unscheduled.patients === 1 ? '' : 's'} is waiting to be scheduled — call the unscheduled treatment list`,
        numbers: { booked_pct_4w: p.booked.w4.pct, target_low: targets.booked_low, unscheduled_hours: doc.demand.unscheduled.hours, unscheduled_patients: doc.demand.unscheduled.patients, asap: doc.demand.asap.count },
        because: `${hoursWords((p.booked.w4.available_minutes - p.booked.w4.booked_minutes) / 60)} open hours in the next 4 weeks`,
        action: { label: 'Open unscheduled treatment', to: '/followups?tab=unscheduled' },
      });
    }
  }

  // Emergencies waiting → hold slots each day.
  const em = r.kinds[ctx.emKind]?.openings?.emergency;
  if (em && em.status !== 'green') {
    const perDay = r.kinds[ctx.emKind].demand.emergencies?.per_day || 0;
    const hold = Math.min(4, Math.max(1, Math.ceil(perDay)));
    add({
      rule: 'hold_emergency', kind: ctx.emKind, severity: em.status,
      text: `Hold ${hold} emergency slot${hold === 1 ? '' : 's'} a day — emergencies are waiting ${em.days == null ? `more than ${HORIZON_DAYS} days` : `${em.days} business day${em.days === 1 ? '' : 's'}`}`,
      numbers: { first_emergency_opening: em.opening?.start ?? null, wait_business_days: em.days, target_business_days: targets.emergency_business_days, emergencies_per_day: perDay, slots_to_hold: hold },
      because: `First emergency opening ${em.opening ? em.opening.date : `none in ${HORIZON_DAYS} days`}, target ${targets.emergency_business_days} business day${targets.emergency_business_days === 1 ? '' : 's'} · `
        + `${perDay} emergenc${perDay === 1 ? 'y' : 'ies'} a day over the last 8 weeks`,
      action: { label: 'Set up perfect-day blocks', to: '/settings?tab=schedule' },
    });
  }

  // New patients waiting → keep openings for them each week.
  const np = r.kinds[ctx.npKind]?.openings?.new_patient;
  if (np && np.status !== 'green') {
    const perWeek = r.kinds[ctx.npKind].demand.new_patients?.per_week || 0;
    const keep = Math.min(20, Math.max(2, Math.ceil(perWeek)));
    const pending = r.kinds[ctx.npKind].demand.requests.count;
    add({
      rule: 'new_patient_slots', kind: ctx.npKind, severity: np.status,
      text: `New patients wait ${waitWords(np.days)} for a first visit (target ${targets.new_patient_days} days): keep ${keep} new-patient openings a week${pending ? ` — ${pending} online request${pending === 1 ? ' is' : 's are'} waiting too` : ''}`,
      numbers: { first_new_patient_opening: np.opening?.start ?? null, wait_days: np.days, target_days: targets.new_patient_days, new_patients_per_week: perWeek, openings_to_keep: keep, online_requests: pending },
      because: `First new-patient opening ${np.opening ? `${np.opening.date} (${np.days} days)` : `none in ${HORIZON_DAYS} days`} · ${perWeek} new patients a week over the last 8 weeks`,
      action: { label: 'Set up perfect-day blocks', to: '/settings?tab=schedule' },
    });
  }

  // Online requests left waiting hold their times and lose patients.
  for (const k of KINDS) {
    const q = r.kinds[k].demand.requests;
    if (q.count && q.oldest_days >= 1) {
      add({
        rule: 'answer_requests', kind: k, severity: q.oldest_days >= 3 ? 'red' : 'amber',
        text: `${q.count} online request${q.count === 1 ? ' is' : 's are'} waiting for an answer (oldest ${q.oldest_days} day${q.oldest_days === 1 ? '' : 's'}): answer them so the times they hold go back on the schedule`,
        numbers: { requests: q.count, oldest_days: q.oldest_days },
        because: `${KIND_LABELS[k]} requests not accepted or declined yet`,
        action: { label: 'Open online requests', to: '/requests' },
      });
    }
  }

  // Short on hours overall even though nobody is waiting too long yet.
  for (const k of KINDS) {
    const kk = r.kinds[k];
    if (kk.gap_status !== 'red' || out.some((x) => x.kind === k && ['add_hygiene_day', 'extend_doctor'].includes(x.rule))) continue;
    add({
      rule: 'short_hours', kind: k, severity: 'amber',
      text: `${KIND_LABELS[k]} needs about ${hoursWords(-kk.gap_hours_week)} more hours a week than it has open over the next 8 weeks (${hoursWords(kk.demand.hours_week)} needed, ${hoursWords(kk.supply.open_hours_week)} open): plan more ${k === 'hygiene' ? 'hygiene' : 'doctor'} time before the wait grows`,
      numbers: { needed_hours_week: kk.demand.hours_week, open_hours_week: kk.supply.open_hours_week, gap_hours_week: kk.gap_hours_week, parts: kk.demand.parts },
      because: 'Recall coming due, overdue recall and unscheduled treatment spread over the backlog weeks, plus new patients and emergencies at the recent rate',
      action: { label: 'Open the schedule setup', to: '/settings?tab=schedule' },
    });
  }
  return out.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
}
const pctWords = (p) => (p == null ? '—' : `${Math.round(p)}%`);

// Which weekday to lengthen (the working day that ends earliest; then the fullest over the next 4 weeks; then the
// later in the week) and which weekday to open (the first weekday Monday–Saturday they don't work). Never past 7 pm.
export function extendPlan(week, hours, booked = {}) {
  const full = (wd) => (booked[wd]?.available_minutes ? booked[wd].booked_minutes / booked[wd].available_minutes : 0);
  const worked = Object.entries(week || {}).map(([wd, d]) => ({ wd: Number(wd), ...d }));
  const candidates = worked.filter((d) => d.close + hours * 60 <= 19 * 60).sort((a, b) => a.close - b.close || full(b.wd) - full(a.wd) || b.wd - a.wd);
  const pick = candidates[0];
  const off = [1, 2, 3, 4, 5, 6].find((wd) => !(wd in (week || {})));
  return {
    extend: pick ? { weekday: pick.wd, day: DAY_NAMES[pick.wd], from: pick.close, to: pick.close + Math.round(hours * 60) } : null,
    open: off != null ? DAY_NAMES[off] : null,
  };
}

// ---- Loading from the database ----
// Rows for computeCapacity: the practice's schedule from 8 weeks back (for the new patient / emergency rate) to the
// first-opening horizon ahead. Office filtering happens in the calculation (a provider's day belongs to one office).
export async function loadCapacityInputs(db, practiceId, { locationId = null, now: nowDate = new Date() } = {}) {
  const practice = await db.get('SELECT id, timezone, office_hours, capacity_targets FROM practices WHERE id = ?', practiceId);
  if (!practice) throw new HttpError(404, 'Practice not found');
  const now = localNow(practice.timezone || 'America/New_York', nowDate);
  const today = now.slice(0, 10);
  const from = addDays(today, -HISTORY_DAYS);
  const to = addDays(today, HORIZON_DAYS);
  const locations = await db.all('SELECT id, name, office_hours, active FROM locations WHERE practice_id = ? ORDER BY sort, id', practiceId);
  const providers = await db.all('SELECT id, name, type, working_hours, active FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', practiceId);
  const exceptions = await db.all('SELECT provider_id, date, hours FROM provider_exceptions WHERE practice_id = ? AND date >= ? AND date <= ?', practiceId, today, to);
  const blockouts = await db.all(
    'SELECT provider_id, operatory_id, start_time, end_time, kind, appointment_type_ids FROM blockouts WHERE practice_id = ? AND end_time > ? AND start_time < ?',
    practiceId, `${today} 00:00`, `${to} 24:00`,
  );
  const appointments = await db.all(
    `SELECT id, provider_id, location_id, start_time, end_time, appointment_type_id, asap, status FROM appointments
     WHERE practice_id = ? AND status NOT IN ('cancelled','no_show') AND start_time >= ? AND start_time < ?`,
    practiceId, `${from} 00:00`, `${to} 24:00`,
  );
  // A pending online request holds its time the way booking does (a paid deposit, an open checkout, or two days).
  const utcNow = nowDate.toISOString();
  const twoDaysAgo = new Date(nowDate.getTime() - 48 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const pending = await db.all(
    `SELECT r.provider_id, r.requested_start, r.duration, r.reason, r.new_patient, r.created_at, r.location_id, r.deposit_status, r.hold_until, pv.type AS provider_type
     FROM booking_requests r LEFT JOIN providers pv ON pv.id = r.provider_id WHERE r.practice_id = ? AND r.status = 'pending'`, practiceId,
  );
  const holds = pending.filter((r) => r.provider_id && r.requested_start >= `${today} 00:00`
    && (r.deposit_status === 'paid' || (r.hold_until && r.hold_until > utcNow) || (r.deposit_status == null && r.created_at > twoDaysAgo)))
    .map((r) => ({ provider_id: r.provider_id, start_time: r.requested_start, end_time: addMinutes(r.requested_start, r.duration || 60) }));
  const templates = await loadTemplates(db, practiceId);
  const plans = await planDays(db, practiceId, today, to, templates);
  const templateBlocks = [];
  const planOffices = {};
  for (const [key, plan] of plans) {
    const date = key.split('|')[1];
    if (plan.location_id) planOffices[key] = plan.location_id;
    for (const b of blocksOn(plan, date)) {
      templateBlocks.push({
        provider_id: b.provider_id, date, start_time: b.start_time, end_time: b.end_time, appointment_type_ids: b.appointment_type_ids,
        release_at: b.release_at, label: b.label, location_id: b.location_id,
      });
    }
  }
  // Home office: the office of the provider's usual chair, else where most of their visits (last 8 weeks and
  // the coming 8) are.
  const home = {};
  for (const o of await db.all('SELECT default_provider_id, location_id FROM operatories WHERE practice_id = ? AND active = 1 AND default_provider_id IS NOT NULL AND location_id IS NOT NULL ORDER BY sort, id', practiceId)) {
    home[o.default_provider_id] ??= o.location_id;
  }
  const counts = new Map();
  for (const a of appointments) {
    if (!a.location_id || home[a.provider_id]) continue;
    const k = `${a.provider_id}|${a.location_id}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [k] of [...counts.entries()].sort((x, y) => y[1] - x[1])) {
    const [pid, lid] = k.split('|').map(Number);
    if (!(pid in home)) home[pid] = lid;
  }
  const types = await db.all('SELECT id, name, duration, provider_type, procedure_codes, provider_durations, active FROM appointment_types WHERE practice_id = ?', practiceId);
  const rtypes = await recallTypes(db, practiceId);
  const recalls = await db.all(
    `SELECT r.patient_id, r.type, r.due_date, p.location_id FROM recalls r JOIN patients p ON p.id = r.patient_id
     WHERE r.practice_id = ? AND r.status IN ('due','contacted') AND r.appointment_id IS NULL AND p.status = 'active' AND r.due_date >= ? AND r.due_date <= ?`,
    practiceId, addDays(today, -365), addDays(today, WINDOWS.w8 - 1),
  );
  const planned = await db.all(
    `SELECT x.patient_id, x.category, x.location_id, p.location_id AS home_location_id, pv.type AS provider_type, pc.time_units
     FROM procedures x JOIN patients p ON p.id = x.patient_id LEFT JOIN providers pv ON pv.id = x.provider_id LEFT JOIN procedure_codes pc ON pc.id = x.code_id
     WHERE x.practice_id = ? AND x.status = 'planned' AND x.appointment_id IS NULL AND p.status = 'active'`, practiceId,
  );
  const waitlist = await db.all(
    `SELECT w.reason, w.duration, p.location_id, pv.type AS provider_type FROM waitlist w JOIN patients p ON p.id = w.patient_id LEFT JOIN providers pv ON pv.id = w.provider_id
     WHERE w.practice_id = ? AND w.status = 'waiting'`, practiceId,
  );
  return {
    today, now, locationId: locationId ? Number(locationId) : null, practice, locations, providers, exceptions, blockouts, appointments, holds,
    templateBlocks, planOffices, home, types, recallTypes: rtypes, recalls, planned, waitlist,
    requests: pending.map((r) => ({ provider_type: r.provider_type, reason: r.reason, new_patient: r.new_patient, duration: r.duration, created_at: r.created_at, location_id: r.location_id })),
    targets: parseTargets(practice.capacity_targets),
  };
}

export async function capacityFor(db, practiceId, opts = {}) {
  return computeCapacity(await loadCapacityInputs(db, practiceId, opts));
}

// For the metric emails (huddle, weekly): a few plain lines and the top recommendations.
//   const cap = await capacitySummary(db, practiceId, { locationId });
//   cap.lines → ['Hygiene: 97% booked next 4 weeks, first recall opening in 5 weeks (target 3 weeks)', …]
export async function capacitySummary(db, practiceId, { locationId = null, now = new Date(), limit = 3 } = {}) {
  const c = await capacityFor(db, practiceId, { locationId, now });
  const lines = [];
  for (const k of KINDS) {
    const kk = c.kinds[k];
    if (!kk.provider_ids.length) continue;
    const firsts = Object.values(kk.openings).filter((m) => ['recall', 'treatment_60', 'new_patient', 'emergency'].includes(m.key));
    const waits = firsts.map((m) => `${m.label.toLowerCase()} ${m.days == null ? 'none soon' : m.key === 'emergency' ? `${m.days} business day${m.days === 1 ? '' : 's'}` : waitWords(m.days)}`);
    lines.push(`${kk.label}: ${pctWords(kk.booked.w4.pct)} booked next 4 weeks; first openings — ${waits.join(', ')}`);
  }
  return {
    status: c.status, as_of: c.now, office: c.office, lines,
    kinds: Object.fromEntries(KINDS.map((k) => [k, {
      status: c.kinds[k].status, booked_pct_4w: c.kinds[k].booked.w4.pct, gap_hours_week: c.kinds[k].gap_hours_week,
      first_opening_days: Object.fromEntries(Object.entries(c.kinds[k].openings).map(([key, m]) => [key, m.days])),
    }])),
    recommendations: c.recommendations.slice(0, limit).map((x) => ({ severity: x.severity, text: x.text, because: x.because })),
  };
}

// ---- Trend: nightly snapshots ----
// capacity_snapshots is derived data (rebuilt from the schedule any time): one row per practice, office scope, day
// and kind. Rows older than two years are hard-deleted — they're not a record of anything, only a trend line.
const SNAP_COLS = ['status', 'booked_pct_2w', 'booked_pct_4w', 'booked_pct_8w', 'first_new_patient_days', 'first_emergency_days', 'first_recall_days',
  'first_treatment_days', 'open_hours_week', 'demand_hours_week', 'recall_hours_4w', 'unscheduled_hours', 'asap_count', 'requests_count'];
const tenths = (v) => (v == null ? null : Math.round(v * 10));
export function snapshotRow(c, k) {
  const kk = c.kinds[k];
  const o = kk.openings;
  return {
    status: kk.status, booked_pct_2w: tenths(kk.booked.w2.pct), booked_pct_4w: tenths(kk.booked.w4.pct), booked_pct_8w: tenths(kk.booked.w8.pct),
    first_new_patient_days: o.new_patient ? o.new_patient.days : null, first_emergency_days: o.emergency ? o.emergency.days : null,
    first_recall_days: o.recall ? o.recall.days : null, first_treatment_days: o.treatment_60 ? o.treatment_60.days : null,
    open_hours_week: tenths(kk.supply.open_hours_week), demand_hours_week: tenths(kk.demand.hours_week),
    recall_hours_4w: tenths(kk.demand.recall?.due_4w.hours ?? 0), unscheduled_hours: tenths(kk.demand.unscheduled.hours),
    asap_count: kk.demand.asap.count, requests_count: kk.demand.requests.count,
  };
}
export const scopeKeyOf = (locationId) => (locationId ? `location:${locationId}` : 'practice');

// Today's snapshot for the practice and each office. A second call the same day changes nothing (the unique
// key keeps one row per practice, scope, day and kind).
export async function recordCapacitySnapshots(db, practiceId, { now = new Date() } = {}) {
  const scopes = [null, ...(await db.all('SELECT id FROM locations WHERE practice_id = ? AND active = 1 ORDER BY id', practiceId)).map((l) => l.id)];
  let written = 0;
  let date = null;
  for (const locationId of scopes) {
    const c = await capacityFor(db, practiceId, { locationId, now });
    date = c.today;
    for (const k of KINDS) {
      if (!c.kinds[k].provider_ids.length) continue;
      const row = snapshotRow(c, k);
      written += (await db.run(
        `INSERT INTO capacity_snapshots (practice_id, snapshot_date, scope_key, location_id, kind, ${SNAP_COLS.join(', ')})
         VALUES (?, ?, ?, ?, ?, ${SNAP_COLS.map(() => '?').join(', ')}) ON CONFLICT (practice_id, snapshot_date, scope_key, kind) DO NOTHING`,
        practiceId, c.today, scopeKeyOf(locationId), locationId, k, ...SNAP_COLS.map((x) => row[x]),
      )).changes;
    }
  }
  // Derived rows past two years: hard delete (scratch data, see above).
  if (date) await db.run('DELETE FROM capacity_snapshots WHERE practice_id = ? AND snapshot_date < ?', practiceId, addDays(date, -SNAPSHOT_KEEP_DAYS));
  return written;
}

// The job: once each practice's evening has come (9 pm local, like the metric snapshots), today's capacity
// snapshot. A failure becomes a Needs attention item, resolved by the next night that works.
export async function runCapacitySnapshots(db, { now = new Date() } = {}) {
  let n = 0;
  for (const p of await db.all('SELECT id, timezone FROM practices')) {
    const local = localNow(p.timezone || 'America/New_York', now);
    if (local.slice(11, 13) < '21') continue;
    if (await db.get("SELECT id FROM capacity_snapshots WHERE practice_id = ? AND snapshot_date = ? AND scope_key = 'practice'", p.id, local.slice(0, 10))) continue;
    const key = `capacity-snapshot:${p.id}`;
    try {
      n += await withActor({ source: 'automation', actor: 'Capacity snapshots', practiceId: p.id }, () => recordCapacitySnapshots(db, p.id, { now }));
      await resolveIssue(db, p.id, key);
    } catch (err) {
      await raiseIssue(db, { practiceId: p.id, kind: 'schedule', key, title: 'Tonight’s capacity snapshot couldn’t be saved', detail: err.message });
    }
  }
  return n;
}

export async function capacityTrend(db, practiceId, { locationId = null, days = 90, today }) {
  const from = addDays(today, -Math.min(Math.max(Number(days) || 90, 7), SNAPSHOT_KEEP_DAYS));
  const rows = await db.all(
    `SELECT snapshot_date, kind, ${SNAP_COLS.join(', ')} FROM capacity_snapshots WHERE practice_id = ? AND scope_key = ? AND snapshot_date >= ? ORDER BY snapshot_date, kind`,
    practiceId, scopeKeyOf(locationId), from,
  );
  const back = (v) => (v == null ? null : Number(v) / 10);
  return {
    from, to: today,
    points: rows.map((r) => ({
      date: r.snapshot_date, kind: r.kind, status: r.status,
      booked_pct_2w: back(r.booked_pct_2w), booked_pct_4w: back(r.booked_pct_4w), booked_pct_8w: back(r.booked_pct_8w),
      first_new_patient_days: r.first_new_patient_days, first_emergency_days: r.first_emergency_days, first_recall_days: r.first_recall_days,
      first_treatment_days: r.first_treatment_days, open_hours_week: back(r.open_hours_week), demand_hours_week: back(r.demand_hours_week),
      recall_hours_4w: back(r.recall_hours_4w), unscheduled_hours: back(r.unscheduled_hours), asap_count: r.asap_count, requests_count: r.requests_count,
    })),
  };
}

// The schema this module needs (the lines to add to db.js: the table in SCHEMA, the column in COLUMNS).
export const CAPACITY_SCHEMA = `CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  snapshot_date TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'practice',
  location_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('doctor','hygiene')),
  status TEXT,
  booked_pct_2w INTEGER,
  booked_pct_4w INTEGER,
  booked_pct_8w INTEGER,
  first_new_patient_days INTEGER,
  first_emergency_days INTEGER,
  first_recall_days INTEGER,
  first_treatment_days INTEGER,
  open_hours_week INTEGER,
  demand_hours_week INTEGER,
  recall_hours_4w INTEGER,
  unscheduled_hours INTEGER,
  asap_count INTEGER,
  requests_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, snapshot_date, scope_key, kind)
);`;
export const CAPACITY_COLUMNS = [['practices', 'capacity_targets', 'TEXT']];
