import { createHash } from 'node:crypto';
import { toCsv } from './util.js';

// Time clock and payroll rules (TC1–TC5, docs/workflows/specs/TC-timeclock.md). Pure functions — no database —
// so the payroll math (overtime, double time, rounding, clock-in windows, pay periods, exports) can be tested
// on its own. Times are practice-local wall-clock strings 'YYYY-MM-DD HH:MM'; elapsed time is always measured
// between real instants, so a shift across a daylight-saving change is paid for the hours actually worked.

export const PAY_TYPES = ['regular', 'overtime', 'doubletime', 'pto', 'holiday'];
export const PAY_TYPE_LABELS = { regular: 'Regular', overtime: 'Overtime', doubletime: 'Double time', pto: 'Paid time off', holiday: 'Holiday' };
export const EXPORT_FORMATS = { gusto: 'Gusto', adp: 'ADP Workforce Now', paychex: 'Paychex Flex', quickbooks: 'QuickBooks Payroll (time activities)', csv: 'Plain CSV' };
export const PERIOD_TYPES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
export const ROUNDING = [0, 5, 6, 15];

// The rules a practice starts with (federal: overtime past 40 hours in a week; no rounding; clock in up to
// 7 minutes before the shift, 5 minutes' grace for late).
export const DEFAULT_SETTINGS = {
  early_in_minutes: 7, late_grace_minutes: 5, early_out_minutes: 5, late_out_minutes: 10, outside_window: 'flag', block_unscheduled: 0,
  pay_period: 'biweekly', period_anchor: null, week_start_day: 0,
  ot_weekly: 1, ot_weekly_minutes: 2400, ot_daily: 0, ot_daily_minutes: 480, dt_daily: 0, dt_daily_minutes: 720, seventh_day: 0,
  rounding: 0, paid_break_max_minutes: 20,
  pto_mode: 'none', pto_per_hour: 0, pto_fixed_minutes: 0, pto_cap_minutes: 0,
  adp_company_code: null, paychex_client_id: null,
};

// ---- Dates and times ----
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isDate = (s) => {
  const m = DATE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100;
};
export const isHm = (s) => HM.test(String(s ?? ''));
export const isLocal = (s) => {
  const m = LOCAL.exec(String(s ?? ''));
  return !!m && isDate(m[1]) && +m[2] < 24 && +m[3] < 60;
};
export const hmToMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
export const minToHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
export const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
export const dateRange = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
};
// The first day of the workweek (Sunday unless the practice says otherwise) that holds a date.
export const weekStart = (date, startDay = 0) => addDays(date, -((weekday(date) - startDay + 7) % 7));

const formatters = new Map();
function wall(tz, ms) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`;
}
// A real instant (ms) → the practice's wall clock.
export const utcToLocal = (tz, ms) => wall(tz, Math.floor(ms / 60000) * 60000);
const wallMs = (local) => Date.parse(`${local.replace(' ', 'T')}:00Z`);
const offsetAt = (tz, ms) => (wallMs(wall(tz, ms)) - Math.floor(ms / 60000) * 60000) / 60000;

// The practice's wall clock → a real instant. A time that happens twice (the hour repeated when clocks fall
// back) is taken as the first; a time that never happens (skipped when clocks spring forward) as the moment
// after the gap.
export function localToUtc(tz, local) {
  const guess = wallMs(local);
  const before = offsetAt(tz, guess - 36 * 3600_000);
  const after = offsetAt(tz, guess + 36 * 3600_000);
  const valid = [...new Set([before, after])].map((o) => guess - o * 60000).filter((t) => wall(tz, t) === local);
  if (valid.length) return Math.min(...valid);
  return guess - before * 60000;
}
export const elapsedMinutes = (tz, fromLocal, toLocal) => Math.round((localToUtc(tz, toLocal) - localToUtc(tz, fromLocal)) / 60000);

// Punch rounding to the nearest 5, 6 (tenth of an hour) or 15 minutes ("7-minute rule": 8:07 → 8:00, 8:08 → 8:15).
export function roundMs(ms, increment) {
  if (!increment) return ms;
  const step = increment * 60000;
  return Math.round(ms / step) * step;
}
export const roundLocal = (local, increment) => {
  if (!increment) return local;
  const m = hmToMin(local.slice(11, 16));
  const r = Math.round(m / increment) * increment;
  return r >= 1440 ? `${addDays(local.slice(0, 10), 1)} 00:00` : `${local.slice(0, 10)} ${minToHm(r)}`;
};

// ---- Breaks ----
// Short rest breaks (under the practice's limit, 20 minutes by default — the federal rule) are paid; lunches
// and longer breaks are not.
export function unpaidBreakMinutes(breaks, paidBreakMax = 20) {
  let total = 0;
  for (const b of breaks) {
    if (b.minutes == null) continue;
    if (b.kind === 'lunch' || b.minutes >= paidBreakMax) total += b.minutes;
  }
  return total;
}

// ---- Worked minutes for one punch ----
// p: { in_ms, out_ms, unpaid_break }. Rounding applies to the clock-in and clock-out, not to breaks.
export function workedMinutes(p, rounding = 0) {
  if (p.out_ms == null) return null;
  const span = (roundMs(p.out_ms, rounding) - roundMs(p.in_ms, rounding)) / 60000;
  return Math.max(0, Math.round(span - (p.unpaid_break || 0)));
}

// ---- Overtime ----
// Classifies each punch's minutes as regular, overtime or double time for one person. punches: [{ date, minutes, ... }]
// — whole workweeks, so the weekly total is right. Rules (settings):
//   ot_weekly: over ot_weekly_minutes (40 h) of regular time in a workweek is overtime (FLSA);
//   ot_daily: over ot_daily_minutes (8 h) in a day is overtime; dt_daily: over dt_daily_minutes (12 h) is double time;
//   seventh_day: the seventh consecutive day worked in a workweek — first 8 h overtime, the rest double time (California).
// Daily overtime hours don't count again toward the weekly 40 (no pyramiding). Exempt staff: everything regular.
export function classifyPunches(punches, settings = DEFAULT_SETTINGS, { exempt = false } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const sorted = [...punches].sort((a, b) => (a.date === b.date ? (a.in_ms ?? 0) - (b.in_ms ?? 0) : a.date < b.date ? -1 : 1));
  const out = sorted.map((p) => ({ ...p, regular: 0, overtime: 0, doubletime: 0 }));
  if (exempt) {
    for (const p of out) p.regular = p.minutes || 0;
    return out;
  }
  const weeks = new Map();
  for (const p of out) {
    const w = weekStart(p.date, s.week_start_day);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(p);
  }
  for (const [w, list] of weeks) {
    const worked = new Set(list.filter((p) => p.minutes > 0).map((p) => p.date));
    const seventh = s.seventh_day && worked.size === 7 ? addDays(w, 6) : null;
    const dayTotal = new Map();
    let weekRegular = 0;
    for (const p of list) {
      const m = p.minutes || 0;
      const prior = dayTotal.get(p.date) || 0;
      dayTotal.set(p.date, prior + m);
      const tiers = [];
      if (p.date === seventh) tiers.push([480, 'overtime'], [Infinity, 'doubletime']);
      else {
        const dt = s.dt_daily ? s.dt_daily_minutes : Infinity;
        const ot = s.ot_daily ? Math.min(s.ot_daily_minutes, dt) : dt;
        tiers.push([ot, 'regular']);
        if (ot < dt) tiers.push([dt, 'overtime']);
        tiers.push([Infinity, 'doubletime']);
      }
      let from = prior;
      const end = prior + m;
      let floor = 0;
      for (const [cap, type] of tiers) {
        const lo = Math.max(from, floor);
        const hi = Math.min(end, cap);
        if (hi > lo) {
          p[type] += hi - lo;
          from = hi;
        }
        floor = cap;
      }
      if (s.ot_weekly) {
        const room = Math.max(0, s.ot_weekly_minutes - weekRegular);
        const keep = Math.min(p.regular, room);
        p.overtime += p.regular - keep;
        p.regular = keep;
      }
      weekRegular += p.regular;
    }
  }
  return out;
}

// ---- Clock-in windows ----
// Is now inside the window for this shift? shift: { start_time, end_time } for today, or null (not scheduled).
// Early clock-ins past the window are blocked (outside_window 'block') or allowed and flagged ('flag').
// Being late is never blocked — it's flagged.
export function clockInCheck(nowLocal, shift, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const now = hmToMin(nowLocal.slice(11, 16));
  if (!shift || shift.off || !shift.start_time) {
    const blocked = !!s.block_unscheduled;
    return { flag: 'unscheduled', minutes: 0, blocked, message: blocked ? 'You’re not on the schedule today, so the clock can’t start. Ask a manager to add your shift.' : null };
  }
  const start = hmToMin(shift.start_time);
  const opens = start - s.early_in_minutes;
  if (now < opens) {
    const blocked = s.outside_window === 'block';
    return {
      flag: 'early', minutes: start - now, blocked, opens_at: minToHm(Math.max(0, opens)),
      message: blocked ? `Your shift starts at ${fmt12(shift.start_time)}. You can clock in from ${fmt12(minToHm(Math.max(0, opens)))}.` : null,
    };
  }
  if (now > start + s.late_grace_minutes) return { flag: 'late', minutes: now - start, blocked: false, message: null };
  return { flag: 'on_time', minutes: 0, blocked: false, message: null };
}
export function clockOutCheck(nowLocal, shift, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!shift || shift.off || !shift.end_time) return { flag: 'unscheduled', minutes: 0 };
  const now = hmToMin(nowLocal.slice(11, 16));
  const end = hmToMin(shift.end_time);
  if (now < end - s.early_out_minutes) return { flag: 'early_out', minutes: end - now };
  if (now > end + s.late_out_minutes) return { flag: 'late_out', minutes: now - end };
  return { flag: 'on_time', minutes: 0 };
}
export const fmt12 = (hm) => {
  const h = Number(hm.slice(0, 2));
  return `${((h + 11) % 12) + 1}:${hm.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
};

// ---- Pay periods ----
// weekly/biweekly count from an anchor date (a first day of a period; default: a recent workweek start);
// semimonthly is the 1st–15th and 16th–end of month; monthly is the calendar month.
export function periodFor(date, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const [y, m, d] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  if (s.pay_period === 'monthly') return { start: `${ym}-01`, end: `${ym}-${lastDay}` };
  if (s.pay_period === 'semimonthly') return d <= 15 ? { start: `${ym}-01`, end: `${ym}-15` } : { start: `${ym}-16`, end: `${ym}-${lastDay}` };
  const len = s.pay_period === 'weekly' ? 7 : 14;
  const anchor = s.period_anchor && isDate(s.period_anchor) ? s.period_anchor : weekStart('2026-01-04', s.week_start_day);
  const n = Math.floor(daysBetween(anchor, date) / len);
  const start = addDays(anchor, n * len);
  return { start, end: addDays(start, len - 1) };
}
export const previousPeriod = (period, settings) => periodFor(addDays(period.start, -1), settings);
export const nextPeriod = (period, settings) => periodFor(addDays(period.end, 1), settings);

// ---- Summaries ----
// One person's minutes by pay type for a period: worked time (classified) inside it, approved time off and holidays.
export function summarize({ punches = [], pto = [], holidays = [], start, end }) {
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, regular: 0, overtime: 0, doubletime: 0, pto: 0, holiday: 0 });
    return days.get(d);
  };
  for (const p of punches) {
    if (p.date < start || p.date > end) continue;
    const x = day(p.date);
    x.regular += p.regular || 0;
    x.overtime += p.overtime || 0;
    x.doubletime += p.doubletime || 0;
  }
  for (const p of pto) if (p.date >= start && p.date <= end) day(p.date).pto += p.minutes;
  for (const h of holidays) if (h.date >= start && h.date <= end) day(h.date).holiday += h.minutes;
  const list = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = { regular: 0, overtime: 0, doubletime: 0, pto: 0, holiday: 0 };
  for (const x of list) for (const k of PAY_TYPES) totals[k] += x[k];
  return { ...totals, worked: totals.regular + totals.overtime + totals.doubletime, total: PAY_TYPES.reduce((t, k) => t + totals[k], 0), days: list };
}

// The dates (and minutes each) a time-off request covers inside a period.
export function ptoDays(req, start = '0000-00-00', end = '9999-99-99') {
  return dateRange(req.start_date, req.end_date).filter((d) => d >= start && d <= end).map((d) => ({ date: d, minutes: req.minutes_per_day }));
}

// PTO earned for a pay period: per hour worked, or a fixed amount, never past the cap.
export function ptoAccrual({ mode, per_hour = 0, fixed = 0, cap = 0, balance = 0, workedMinutes = 0 }) {
  let earn = mode === 'per_hour' ? Math.floor((workedMinutes / 60) * Number(per_hour || 0)) : mode === 'fixed' ? Math.max(0, Math.round(fixed || 0)) : 0;
  if (cap > 0) earn = Math.max(0, Math.min(earn, cap - balance));
  return earn;
}

// ---- PINs for the shared tablet ----
export function pinProblem(pin) {
  const s = String(pin ?? '');
  if (!/^\d{4,8}$/.test(s)) return 'A PIN is 4 to 8 digits.';
  if (/^(\d)\1+$/.test(s)) return 'Pick a PIN that isn’t the same digit repeated.';
  const up = '01234567890123456789';
  const down = '98765432109876543210';
  if (up.includes(s) || down.includes(s)) return 'Pick a PIN that isn’t a straight run like 1234.';
  return null;
}

// ---- US holidays most dental offices close for ----
const nthWeekday = (y, month, wd, n) => {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return `${y}-${String(month).padStart(2, '0')}-${String(1 + ((wd - first + 7) % 7) + (n - 1) * 7).padStart(2, '0')}`;
};
const lastWeekday = (y, month, wd) => {
  const last = new Date(Date.UTC(y, month, 0));
  const back = (last.getUTCDay() - wd + 7) % 7;
  return `${y}-${String(month).padStart(2, '0')}-${String(last.getUTCDate() - back).padStart(2, '0')}`;
};
export function usHolidays(year) {
  const y = Number(year);
  return [
    { date: `${y}-01-01`, name: 'New Year’s Day' }, { date: lastWeekday(y, 5, 1), name: 'Memorial Day' }, { date: `${y}-07-04`, name: 'Independence Day' },
    { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day' }, { date: nthWeekday(y, 11, 4, 4), name: 'Thanksgiving' }, { date: `${y}-12-25`, name: 'Christmas Day' },
  ];
}

// ---- Payroll exports ----
// people: [{ user_id, name, payroll_id, minutes: { regular, overtime, doubletime, pto, holiday }, days: [{ date, regular, ... }] }]
// — the approved snapshot. Returns the CSV and the minutes each line carries (for the reconciliation check).
export const hours = (min) => (Math.round(min / 0.6) / 100).toFixed(2);
const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const splitName = (name = '') => {
  const parts = String(name).replace(/,/g, ' ').trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] } : { first: parts[0] || '', last: '' };
};
const ADP_CODES = { doubletime: 'DT', pto: 'V', holiday: 'H' };
const PAYCHEX_COMPONENTS = { regular: 'Hourly', overtime: 'Overtime', doubletime: 'Double Time', pto: 'PTO', holiday: 'Holiday' };
const QB_ITEMS = { regular: 'Hourly', overtime: 'Overtime Hourly', doubletime: 'Double Overtime Hourly', pto: 'Paid Time Off', holiday: 'Holiday Pay' };

// Approved team bonuses (bonus_cents on a person, from bonuspay.js) travel as their own pay type in money, not
// hours: a Bonus column (Gusto, plain CSV), an earnings code line (ADP, "B"), a Bonus pay component (Paychex) or a
// Bonus line (QuickBooks), each with the amount in dollars. Without bonuses the file is exactly as before.
export const BONUS_PAY_TYPE = 'bonus';
const dollarsOf = (cents) => (cents / 100).toFixed(2);

export function buildExport(format, { people, start, end, settings = {} }) {
  if (!EXPORT_FORMATS[format]) throw new Error(`Unknown export format ${format}`);
  const lines = [];
  const note = (user_id, type, minutes) => { if (minutes) lines.push({ user_id, type, minutes }); };
  const money = [];
  const bonusOf = (p) => Math.round(p.bonus_cents || 0);
  const noteBonus = (p) => { if (bonusOf(p)) money.push({ user_id: p.user_id, type: BONUS_PAY_TYPE, cents: bonusOf(p) }); };
  const anyBonus = people.some((p) => bonusOf(p));
  const sorted = [...people].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let rows;
  let columns;
  if (format === 'gusto') {
    rows = sorted.map((p) => {
      for (const t of PAY_TYPES) note(p.user_id, t, p.minutes[t]);
      noteBonus(p);
      return { ...splitName(p.name), ...p };
    });
    columns = [['last_name', (r) => r.last], ['first_name', (r) => r.first], ['employee_id', (r) => r.payroll_id || ''], ['regular_hours', (r) => hours(r.minutes.regular)],
      ['overtime_hours', (r) => hours(r.minutes.overtime)], ['double_overtime_hours', (r) => hours(r.minutes.doubletime)], ['pto_hours', (r) => hours(r.minutes.pto)],
      ['holiday_hours', (r) => hours(r.minutes.holiday)], ...(anyBonus ? [['bonus', (r) => dollarsOf(bonusOf(r))]] : [])];
  } else if (format === 'adp') {
    // ADP Workforce Now pay data import (EPI): regular and overtime on one line, each other kind of hours on its own line with its code.
    const batch = `DM${start.replace(/-/g, '').slice(2)}`;
    rows = [];
    for (const p of sorted) {
      rows.push({ p, reg: p.minutes.regular, ot: p.minutes.overtime, code: '', amount: null });
      note(p.user_id, 'regular', p.minutes.regular);
      note(p.user_id, 'overtime', p.minutes.overtime);
      for (const t of ['doubletime', 'pto', 'holiday']) {
        if (!p.minutes[t]) continue;
        rows.push({ p, reg: null, ot: null, code: ADP_CODES[t], amount: p.minutes[t] });
        note(p.user_id, t, p.minutes[t]);
      }
      if (bonusOf(p)) {
        rows.push({ p, reg: null, ot: null, code: '', amount: null, bonus: bonusOf(p) });
        noteBonus(p);
      }
    }
    columns = [['Co Code', () => settings.adp_company_code || ''], ['Batch ID', () => batch], ['File #', (r) => r.p.payroll_id || ''], ['Employee Name', (r) => r.p.name],
      ['Reg Hours', (r) => (r.reg == null ? '' : hours(r.reg))], ['O/T Hours', (r) => (r.ot == null ? '' : hours(r.ot))], ['Hours 3 Code', (r) => r.code], ['Hours 3 Amount', (r) => (r.amount == null ? '' : hours(r.amount))],
      ...(anyBonus ? [['Earnings 3 Code', (r) => (r.bonus ? 'B' : '')], ['Earnings 3 Amount', (r) => (r.bonus ? dollarsOf(r.bonus) : '')]] : [])];
  } else if (format === 'paychex') {
    rows = [];
    for (const p of sorted) {
      for (const t of PAY_TYPES) {
        if (!p.minutes[t]) continue;
        rows.push({ p, t, m: p.minutes[t] });
        note(p.user_id, t, p.minutes[t]);
      }
      if (bonusOf(p)) {
        rows.push({ p, t: BONUS_PAY_TYPE, m: null, bonus: bonusOf(p) });
        noteBonus(p);
      }
    }
    columns = [['Client ID', () => settings.paychex_client_id || ''], ['Worker ID', (r) => r.p.payroll_id || ''], ['Worker Name', (r) => r.p.name], ['Pay Component', (r) => (r.bonus ? 'Bonus' : PAYCHEX_COMPONENTS[r.t])],
      ['Hours', (r) => (r.m == null ? '' : hours(r.m))], ['Period Start', () => start], ['Period End', () => end], ...(anyBonus ? [['Amount', (r) => (r.bonus ? dollarsOf(r.bonus) : '')]] : [])];
  } else if (format === 'quickbooks') {
    // QuickBooks time activities: one line per person, day and pay item, with the duration as hh:mm (exact to the minute).
    rows = [];
    for (const p of sorted) {
      for (const d of p.days || []) for (const t of PAY_TYPES) {
        if (!d[t]) continue;
        rows.push({ p, d, t });
        note(p.user_id, t, d[t]);
      }
      if (bonusOf(p)) {
        rows.push({ p, d: { date: end }, t: BONUS_PAY_TYPE, bonus: bonusOf(p) });
        noteBonus(p);
      }
    }
    columns = [['Date', (r) => r.d.date], ['Employee', (r) => r.p.name], ['Employee ID', (r) => r.p.payroll_id || ''], ['Pay Item', (r) => (r.bonus ? 'Bonus' : QB_ITEMS[r.t])],
      ['Duration', (r) => (r.bonus ? '' : hhmm(r.d[r.t]))], ['Hours', (r) => (r.bonus ? '' : hours(r.d[r.t]))], ['Description', (r) => (r.bonus ? `Team bonus paid with ${start} to ${end}` : `Time clock ${start} to ${end}`)],
      ...(anyBonus ? [['Amount', (r) => (r.bonus ? dollarsOf(r.bonus) : '')]] : [])];
  } else {
    rows = sorted.map((p) => {
      for (const t of PAY_TYPES) note(p.user_id, t, p.minutes[t]);
      noteBonus(p);
      return p;
    });
    columns = [['Employee', (r) => r.name], ['Payroll ID', (r) => r.payroll_id || ''], ['Period start', () => start], ['Period end', () => end],
      ...PAY_TYPES.map((t) => [`${PAY_TYPE_LABELS[t]} hours`, (r) => hours(r.minutes[t])]), ['Total hours', (r) => hours(PAY_TYPES.reduce((s, t) => s + r.minutes[t], 0))],
      ...(anyBonus ? [['Bonus ($)', (r) => dollarsOf(bonusOf(r))]] : [])];
  }
  const csv = toCsv(rows, columns);
  return { csv, lines, money, filename: `payroll-${format}-${start}-to-${end}.csv`, hash: createHash('sha256').update(csv).digest('hex') };
}

// Approved minutes vs the minutes in an export, by person and pay type. ok when every one matches.
export function reconcile(approved, lines) {
  const key = (u, t) => `${u}:${t}`;
  const a = new Map();
  const e = new Map();
  for (const p of approved) for (const t of PAY_TYPES) if (p.minutes[t]) a.set(key(p.user_id, t), (a.get(key(p.user_id, t)) || 0) + p.minutes[t]);
  for (const l of lines) e.set(key(l.user_id, l.type), (e.get(key(l.user_id, l.type)) || 0) + l.minutes);
  const differences = [];
  for (const k of new Set([...a.keys(), ...e.keys()])) {
    if ((a.get(k) || 0) !== (e.get(k) || 0)) {
      const [user_id, type] = k.split(':');
      differences.push({ user_id: Number(user_id), type, approved: a.get(k) || 0, exported: e.get(k) || 0 });
    }
  }
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  return { ok: differences.length === 0, approved_minutes: sum(a), exported_minutes: sum(e), differences };
}

// A stable fingerprint of what was approved (so a later change is noticed).
export const detailHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
