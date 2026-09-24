import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { harness } from './helpers.js';
import { actorMiddleware } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { timeclockKioskRoutes } from '../src/routes/timeclock.js';
import {
  classifyPunches, summarize, roundMs, roundLocal, workedMinutes, unpaidBreakMinutes, clockInCheck, clockOutCheck, localToUtc, utcToLocal, elapsedMinutes,
  periodFor, previousPeriod, ptoAccrual, pinProblem, usHolidays, buildExport, reconcile, weekStart, DEFAULT_SETTINGS,
} from '../src/timeclock.js';

const h = harness();

// ======================= Pure payroll math =======================
const H = 60;
const day = (date, minutes) => ({ date, minutes, in_ms: Date.parse(`${date}T08:00:00Z`) });
const totals = (rows) => rows.reduce((t, r) => ({ regular: t.regular + r.regular, overtime: t.overtime + r.overtime, doubletime: t.doubletime + r.doubletime }), { regular: 0, overtime: 0, doubletime: 0 });

test('overtime: weekly past 40 hours (federal), next week starts fresh', () => {
  // Mon–Fri 2031-03-03..07 (Sunday-start week), 9 h each = 45 h → 5 h overtime; the next Monday 4 h regular.
  const rows = classifyPunches([...['03', '04', '05', '06', '07'].map((d) => day(`2031-03-${d}`, 9 * H)), day('2031-03-10', 4 * H)], DEFAULT_SETTINGS);
  assert.deepEqual(totals(rows), { regular: 44 * H, overtime: 5 * H, doubletime: 0 });
  // Overtime lands on the day it happened (Friday), not spread across the week.
  assert.equal(rows.find((r) => r.date === '2031-03-07').overtime, 5 * H);
});

test('overtime: the workweek start day decides which week hours count toward', () => {
  // Wed–Tue, 7 days × 7 h = 49 h. Sunday-start weeks split it 4 days (Wed–Sat) + 3 days (Sun–Tue): no overtime.
  const days = ['2031-03-05', '2031-03-06', '2031-03-07', '2031-03-08', '2031-03-09', '2031-03-10', '2031-03-11'].map((d) => day(d, 7 * H));
  assert.equal(totals(classifyPunches(days, { ...DEFAULT_SETTINGS, week_start_day: 0 })).overtime, 0);
  // A Wednesday-start week holds all 49 h: 9 h overtime.
  assert.equal(totals(classifyPunches(days, { ...DEFAULT_SETTINGS, week_start_day: 3 })).overtime, 9 * H);
  assert.equal(weekStart('2031-03-09', 1), '2031-03-03');
});

test('overtime: daily over 8 h and double time over 12 h (California style)', () => {
  const s = { ...DEFAULT_SETTINGS, ot_daily: 1, dt_daily: 1 };
  assert.deepEqual(totals(classifyPunches([day('2031-03-04', 13 * H)], s)), { regular: 8 * H, overtime: 4 * H, doubletime: 1 * H });
  // Two punches the same day add up before the daily limits apply.
  const split = classifyPunches([{ ...day('2031-03-04', 5 * H), in_ms: 1 }, { ...day('2031-03-04', 5 * H), in_ms: 2 }], s);
  assert.deepEqual(totals(split), { regular: 8 * H, overtime: 2 * H, doubletime: 0 });
  assert.deepEqual([split[0].overtime, split[1].overtime], [0, 2 * H]);
  // Double time without daily overtime: regular until 12 h.
  assert.deepEqual(totals(classifyPunches([day('2031-03-04', 13 * H)], { ...DEFAULT_SETTINGS, dt_daily: 1 })), { regular: 12 * H, overtime: 0, doubletime: 1 * H });
});

test('overtime: daily overtime is not counted again toward the weekly 40 (no pyramiding)', () => {
  const s = { ...DEFAULT_SETTINGS, ot_daily: 1 };
  // Mon–Fri 10 h = 8 reg + 2 OT each (40 reg, 10 OT). Saturday 5 h: over 40 regular → all overtime.
  const rows = classifyPunches([...['03', '04', '05', '06', '07'].map((d) => day(`2031-03-${d}`, 10 * H)), day('2031-03-08', 5 * H)], s);
  assert.deepEqual(totals(rows), { regular: 40 * H, overtime: 15 * H, doubletime: 0 });
});

test('overtime: California seventh consecutive day — first 8 h overtime, past 8 h double time', () => {
  const s = { ...DEFAULT_SETTINGS, ot_daily: 1, dt_daily: 1, seventh_day: 1 };
  const week = ['02', '03', '04', '05', '06', '07', '08'].map((d) => day(`2031-03-${d}`, 9 * H)); // Sun–Sat, 9 h each = 63 h
  const rows = classifyPunches(week, s);
  assert.deepEqual(totals(rows), { regular: 40 * H, overtime: 22 * H, doubletime: 1 * H });
  const seventh = rows.find((r) => r.date === '2031-03-08');
  assert.deepEqual([seventh.regular, seventh.overtime, seventh.doubletime], [0, 8 * H, 1 * H]);
  // Six days only: no seventh-day rule.
  assert.equal(totals(classifyPunches(week.slice(0, 6), s)).doubletime, 0);
  // Exempt (salaried) staff: all regular.
  assert.deepEqual(totals(classifyPunches(week, s, { exempt: true })), { regular: 63 * H, overtime: 0, doubletime: 0 });
});

test('rounding: nearest 5, 6 or 15 minutes on clock-in and clock-out only', () => {
  const t = (hm) => Date.parse(`2031-03-04T${hm}:00Z`);
  const r = (hm, inc) => new Date(roundMs(t(hm), inc)).toISOString().slice(11, 16);
  assert.deepEqual(['08:07', '08:08', '07:52', '07:53'].map((x) => r(x, 15)), ['08:00', '08:15', '07:45', '08:00']);
  assert.deepEqual(['08:02', '08:03', '08:05'].map((x) => r(x, 6)), ['08:00', '08:06', '08:06']);
  assert.deepEqual(['08:02', '08:03'].map((x) => r(x, 5)), ['08:00', '08:05']);
  assert.equal(r('08:07', 0), '08:07');
  assert.equal(roundLocal('2031-03-04 23:53', 15), '2031-03-05 00:00');
  // 7:53 → 8:00 and 16:07 → 16:00 = 8 h, minus a 30-minute lunch; the break itself isn't rounded.
  assert.equal(workedMinutes({ in_ms: t('07:53'), out_ms: t('16:07'), unpaid_break: 30 }, 15), 450);
  assert.equal(workedMinutes({ in_ms: t('07:53'), out_ms: t('16:07'), unpaid_break: 30 }, 0), 464);
  assert.equal(workedMinutes({ in_ms: t('07:53'), out_ms: null }, 0), null);
});

test('breaks: short rest breaks are paid, lunches and long breaks are not', () => {
  assert.equal(unpaidBreakMinutes([{ kind: 'break', minutes: 10 }, { kind: 'lunch', minutes: 30 }, { kind: 'break', minutes: 25 }, { kind: 'break', minutes: null }], 20), 55);
});

test('clock-in window: early, on time, late, unscheduled; blocked or flagged', () => {
  const shift = { start_time: '08:00', end_time: '17:00' };
  const at = (hm) => `2031-03-04 ${hm}`;
  assert.deepEqual(clockInCheck(at('07:53'), shift).flag, 'on_time'); // 7 minutes before is inside the window
  const early = clockInCheck(at('07:40'), shift);
  assert.deepEqual([early.flag, early.minutes, early.blocked, early.opens_at], ['early', 20, false, '07:53']);
  const blocked = clockInCheck(at('07:40'), shift, { outside_window: 'block' });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.message, /starts at 8:00 AM\. You can clock in from 7:53 AM/);
  assert.deepEqual([clockInCheck(at('08:05'), shift).flag, clockInCheck(at('08:06'), shift).flag, clockInCheck(at('08:06'), shift).minutes], ['on_time', 'late', 6]);
  assert.equal(clockInCheck(at('08:30'), shift, { outside_window: 'block' }).blocked, false, 'being late is flagged, never blocked');
  assert.deepEqual([clockInCheck(at('08:00'), null).flag, clockInCheck(at('08:00'), null).blocked], ['unscheduled', false]);
  assert.equal(clockInCheck(at('08:00'), { off: true }, { block_unscheduled: 1 }).blocked, true);
  assert.deepEqual([clockOutCheck(at('16:50'), shift).flag, clockOutCheck(at('16:56'), shift).flag, clockOutCheck(at('17:11'), shift).flag, clockOutCheck(at('17:11'), shift).minutes], ['early_out', 'on_time', 'late_out', 11]);
});

test('time zones: daylight-saving days pay the real hours', () => {
  const ny = 'America/New_York';
  // Spring forward (2026-03-08): 00:00 → 08:00 on the wall is 7 real hours; 02:30 doesn't exist (→ 03:30).
  assert.equal(elapsedMinutes(ny, '2026-03-08 00:00', '2026-03-08 08:00'), 7 * H);
  assert.equal(utcToLocal(ny, localToUtc(ny, '2026-03-08 02:30')), '2026-03-08 03:30');
  // Fall back (2026-11-01): 00:00 → 08:00 is 9 real hours; 01:30 happens twice — the first one is used.
  assert.equal(elapsedMinutes(ny, '2026-11-01 00:00', '2026-11-01 08:00'), 9 * H);
  assert.equal(new Date(localToUtc(ny, '2026-11-01 01:30')).toISOString(), '2026-11-01T05:30:00.000Z');
  // Ordinary days and other zones round-trip.
  for (const tz of ['UTC', 'America/Los_Angeles', 'America/Phoenix', 'Pacific/Honolulu']) assert.equal(utcToLocal(tz, localToUtc(tz, '2026-07-15 13:45')), '2026-07-15 13:45');
});

test('pay periods: weekly, biweekly (from an anchor), semimonthly and monthly', () => {
  assert.deepEqual(periodFor('2026-09-24', { pay_period: 'weekly', period_anchor: '2026-09-07' }), { start: '2026-09-21', end: '2026-09-27' });
  assert.deepEqual(periodFor('2026-09-24', { pay_period: 'biweekly', period_anchor: '2026-09-07' }), { start: '2026-09-21', end: '2026-10-04' });
  assert.deepEqual(periodFor('2026-09-20', { pay_period: 'biweekly', period_anchor: '2026-09-07' }), { start: '2026-09-07', end: '2026-09-20' });
  assert.deepEqual(periodFor('2026-08-30', { pay_period: 'biweekly', period_anchor: '2026-09-07' }), { start: '2026-08-24', end: '2026-09-06' }, 'before the anchor too');
  assert.deepEqual(periodFor('2026-02-20', { pay_period: 'semimonthly' }), { start: '2026-02-16', end: '2026-02-28' });
  assert.deepEqual(periodFor('2028-02-20', { pay_period: 'semimonthly' }), { start: '2028-02-16', end: '2028-02-29' });
  assert.deepEqual(periodFor('2026-02-15', { pay_period: 'semimonthly' }), { start: '2026-02-01', end: '2026-02-15' });
  assert.deepEqual(periodFor('2026-12-31', { pay_period: 'monthly' }), { start: '2026-12-01', end: '2026-12-31' });
  assert.deepEqual(previousPeriod({ start: '2026-03-01', end: '2026-03-15' }, { pay_period: 'semimonthly' }), { start: '2026-02-16', end: '2026-02-28' });
});

test('summaries, PTO accrual, PINs and holidays', () => {
  const s = summarize({ punches: [{ date: '2031-03-04', regular: 480, overtime: 30, doubletime: 0 }, { date: '2031-04-01', regular: 999, overtime: 0, doubletime: 0 }], pto: [{ date: '2031-03-05', minutes: 480 }], holidays: [{ date: '2031-03-06', minutes: 480 }], start: '2031-03-01', end: '2031-03-31' });
  assert.deepEqual([s.regular, s.overtime, s.pto, s.holiday, s.worked, s.total, s.days.length], [480, 30, 480, 480, 510, 1470, 3]);
  assert.equal(ptoAccrual({ mode: 'per_hour', per_hour: 1.5, workedMinutes: 40 * H }), 60);
  assert.equal(ptoAccrual({ mode: 'per_hour', per_hour: 1.5, workedMinutes: 40 * H, cap: 100, balance: 80 }), 20);
  assert.equal(ptoAccrual({ mode: 'fixed', fixed: 240 }), 240);
  assert.equal(ptoAccrual({ mode: 'none', fixed: 240 }), 0);
  assert.equal(pinProblem('4827'), null);
  for (const bad of ['12', '123456789', '1111', '1234', '9876', 'abcd', '']) assert.ok(pinProblem(bad), bad);
  assert.deepEqual(usHolidays(2026).map((x) => x.date), ['2026-01-01', '2026-05-25', '2026-07-04', '2026-09-07', '2026-11-26', '2026-12-25']);
});

// Parses our CSV output (no quoted commas in these test names).
const parseCsv = (text) => {
  const [head, ...rows] = String(text).replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
  return rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
};
const hmToMinutes = (s) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
// Hours in each format's file, summed back into minutes (decimal hours are rounded to 0.01 per cell).
const exportedMinutes = (format, text) => {
  const rows = parseCsv(text);
  const n = (v) => (v ? Number(v) * 60 : 0);
  if (format === 'gusto') return rows.reduce((t, r) => t + n(r.regular_hours) + n(r.overtime_hours) + n(r.double_overtime_hours) + n(r.pto_hours) + n(r.holiday_hours), 0);
  if (format === 'adp') return rows.reduce((t, r) => t + n(r['Reg Hours']) + n(r['O/T Hours']) + n(r['Hours 3 Amount']), 0);
  if (format === 'paychex') return rows.reduce((t, r) => t + n(r.Hours), 0);
  if (format === 'quickbooks') return rows.reduce((t, r) => t + hmToMinutes(r.Duration), 0);
  return rows.reduce((t, r) => t + n(r['Total hours']), 0);
};

test('exports: every format carries exactly the approved minutes; reconciliation catches a mismatch', () => {
  const people = [
    { user_id: 1, name: 'Ann Lee', payroll_id: 'E1', minutes: { regular: 2400, overtime: 125, doubletime: 20, pto: 480, holiday: 480 }, days: [{ date: '2031-03-03', regular: 2400, overtime: 125, doubletime: 20, pto: 0, holiday: 0 }, { date: '2031-03-04', regular: 0, overtime: 0, doubletime: 0, pto: 480, holiday: 480 }] },
    { user_id: 2, name: 'Bo Diaz', payroll_id: 'E2', minutes: { regular: 1333, overtime: 0, doubletime: 0, pto: 0, holiday: 0 }, days: [{ date: '2031-03-03', regular: 1333, overtime: 0, doubletime: 0, pto: 0, holiday: 0 }] },
  ];
  const approved = people.reduce((t, p) => t + Object.values(p.minutes).reduce((a, b) => a + b, 0), 0);
  for (const format of ['gusto', 'adp', 'paychex', 'quickbooks', 'csv']) {
    const f = buildExport(format, { people, start: '2031-03-01', end: '2031-03-14', settings: { adp_company_code: 'XYZ' } });
    const check = reconcile(people, f.lines);
    assert.equal(check.ok, true, format);
    assert.equal(check.exported_minutes, approved, format);
    assert.ok(Math.abs(exportedMinutes(format, f.csv) - approved) <= 1, `${format}: file hours add up to approved hours`);
    assert.equal(f.hash, createHash('sha256').update(f.csv).digest('hex'));
  }
  const adp = parseCsv(buildExport('adp', { people, start: '2031-03-01', end: '2031-03-14', settings: { adp_company_code: 'XYZ' } }).csv);
  assert.deepEqual(adp.filter((r) => r['File #'] === 'E1').map((r) => r['Hours 3 Code']), ['', 'DT', 'V', 'H']);
  assert.equal(adp[0]['Co Code'], 'XYZ');
  const bad = reconcile(people, buildExport('csv', { people: [people[0]], start: '2031-03-01', end: '2031-03-14' }).lines);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.differences, [{ user_id: 2, type: 'regular', approved: 1333, exported: 0 }]);
});

// ======================= Through the API =======================
const tokens = new WeakMap();
async function tokenOf(api) {
  if (!tokens.has(api)) throw new Error('no token');
  return tokens.get(api);
}
// Remembers the admin's bearer token for raw fetches (practice() returns it alongside the client).
const origPractice = h.practice;
h.practice = async (...args) => {
  const p = await origPractice(...args);
  tokens.set(p.api, `Bearer ${p.token}`);
  return p;
};

const setNow = (tz, local) => { h.app.locals.timeclockNow = () => localToUtc(tz, local); };
const clearNow = () => { delete h.app.locals.timeclockNow; };
async function person(api, name, extra = {}) {
  const email = `${name.replace(/\W/g, '').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = await api.post('/users', { email, name, role: 'hygienist', password: 'correct-horse-battery', ...extra });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  // Each sign-in from its own address, so the sign-in rate limit (per address) isn't what's being tested.
  const login = await h.client(undefined, { 'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { ...u.data, client: h.client(login.data.token) };
}
const auditRows = async (practiceId, action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', practiceId, action);
const practiceOf = async (email) => (await h.db.get('SELECT practice_id FROM users WHERE email = ?', email)).practice_id;

test('punching: clock in once (double clicks and races make one punch), breaks, clock out', async () => {
  clearNow();
  const { api } = await h.practice({ timezone: 'UTC' });
  const ann = await person(api, 'Ann Punch');
  const tries = await Promise.all([1, 2, 3, 4].map(() => ann.client.post('/timeclock/in', {})));
  assert.equal(tries.filter((t) => t.status === 201).length, 1, 'exactly one clock-in wins');
  assert.ok(tries.filter((t) => t.status !== 201).every((t) => t.status === 409));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM time_punches WHERE user_id = ?', ann.id)).n, 1);
  const punch = tries.find((t) => t.status === 201).data.punch;
  assert.equal(punch.source, 'self');
  const row = await h.db.get('SELECT * FROM time_punches WHERE id = ?', punch.id);
  assert.ok(row.in_ip && row.clock_in_utc, 'device/IP and exact time kept');
  assert.equal((await ann.client.post('/timeclock/break/start', { kind: 'lunch' })).status, 200);
  assert.equal((await ann.client.post('/timeclock/break/start', {})).status, 409, 'already on a break');
  const me = (await ann.client.get('/timeclock/me')).data;
  assert.equal(me.on_break.kind, 'lunch');
  assert.ok(me.clocked_in);
  assert.equal((await ann.client.post('/timeclock/break/end', {})).status, 200);
  assert.equal((await ann.client.post('/timeclock/break/end', {})).status, 409);
  assert.equal((await ann.client.post('/timeclock/out', { break_minutes: 90 })).status, 400, 'a break can’t be longer than the shift');
  const outs = await Promise.all([ann.client.post('/timeclock/out', {}), ann.client.post('/timeclock/out', {})]);
  assert.deepEqual(outs.map((o) => o.status).sort(), [200, 409]);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM time_open_punches WHERE user_id = ?', ann.id)).n, 0);
  assert.equal((await ann.client.get('/timeclock/me')).data.clocked_in, null);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM time_breaks WHERE punch_id = ?', punch.id)).n, 1);
});

test('clock-in windows: early flagged or blocked with a friendly message, late and unscheduled flagged', async () => {
  const tz = 'America/Chicago';
  const { api, email } = await h.practice({ timezone: tz });
  const pid = await practiceOf(email);
  const bo = await person(api, 'Bo Window');
  for (const d of ['2025-06-03', '2025-06-05']) assert.equal((await api.put('/timeclock/shifts', { user_id: bo.id, date: d, start_time: '08:00', end_time: '17:00', break_minutes: 30 })).status, 200);
  // Flag mode (default): 20 minutes early is allowed and flagged.
  setNow(tz, '2025-06-03 07:40');
  const early = await bo.client.post('/timeclock/in', {});
  assert.equal(early.status, 201);
  assert.deepEqual([early.data.flag, early.data.punch.in_flag_minutes], ['early', 20]);
  setNow(tz, '2025-06-03 07:45');
  assert.equal((await bo.client.post('/timeclock/out', {})).data.flag, 'early_out');
  // Block mode: refused until 7:53, and the refusal is recorded.
  assert.equal((await api.put('/timeclock/settings', { outside_window: 'block' })).status, 200);
  setNow(tz, '2025-06-03 07:50');
  const blocked = await bo.client.post('/timeclock/in', {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /You can clock in from 7:53 AM/);
  assert.equal(blocked.data.details.opens_at, '07:53');
  assert.equal((await auditRows(pid, 'timeclock.blocked')).length, 1);
  setNow(tz, '2025-06-03 07:55');
  const onTime = await bo.client.post('/timeclock/in', {});
  assert.deepEqual([onTime.status, onTime.data.flag], [201, 'on_time']);
  setNow(tz, '2025-06-03 17:30');
  const late = await bo.client.post('/timeclock/out', {});
  assert.deepEqual([late.data.flag, late.data.punch.out_flag_minutes], ['late_out', 30]);
  // Late is flagged, never blocked.
  setNow(tz, '2025-06-05 08:12');
  const tardy = await bo.client.post('/timeclock/in', {});
  assert.deepEqual([tardy.status, tardy.data.flag, tardy.data.punch.in_flag_minutes], [201, 'late', 12]);
  assert.match(tardy.data.message, /12 minutes after your 8:00 AM start/);
  setNow(tz, '2025-06-05 17:00');
  await bo.client.post('/timeclock/out', {});
  // Not on the schedule: flagged, or blocked when the practice says so.
  setNow(tz, '2025-06-04 09:00');
  await api.put('/timeclock/settings', { block_unscheduled: 1 });
  const unsched = await bo.client.post('/timeclock/in', {});
  assert.equal(unsched.status, 409);
  assert.match(unsched.data.error, /not on the schedule/);
  await api.put('/timeclock/settings', { block_unscheduled: 0 });
  assert.equal((await bo.client.post('/timeclock/in', {})).data.flag, 'unscheduled');
  // The Today board shows who's in and who hasn't come in.
  const board = (await api.get('/timeclock/today')).data;
  const row = board.people.find((p) => p.user_id === bo.id);
  assert.equal(row.status, 'in');
  assert.ok(row.flags.some((f) => f.kind === 'unscheduled'));
  setNow(tz, '2025-06-04 10:00');
  await bo.client.post('/timeclock/out', {});
  // Time a manager enters gets the same flags as a punch at the clock would have.
  await api.put('/timeclock/shifts', { user_id: bo.id, date: '2025-06-02', start_time: '08:00', end_time: '17:00' });
  const added = await api.post('/timeclock/punches', { user_id: bo.id, clock_in: '2025-06-02 08:20', clock_out: '2025-06-02 16:00', reason: 'Paper timesheet' });
  assert.deepEqual([added.data.in_flag, added.data.in_flag_minutes, added.data.out_flag, added.data.out_flag_minutes], ['late', 20, 'early_out', 60]);
  clearNow();
});

test('corrections: the original punch is kept, a reason is required, every change is audited', async () => {
  const tz = 'America/Denver';
  const { api, email } = await h.practice({ timezone: tz });
  const pid = await practiceOf(email);
  const cy = await person(api, 'Cy Fix');
  setNow(tz, '2025-07-01 08:02');
  const inRes = await cy.client.post('/timeclock/in', {});
  setNow(tz, '2025-07-01 16:31');
  await cy.client.post('/timeclock/out', {});
  const id = inRes.data.punch.id;
  setNow(tz, '2025-07-10 12:00');
  assert.equal((await cy.client.post(`/timeclock/punches/${id}/correct`, { clock_in: '2025-07-01 08:00', reason: 'x' })).status, 403, 'staff can’t correct punches');
  assert.equal((await api.post(`/timeclock/punches/${id}/correct`, { clock_in: '2025-07-01 08:00' })).status, 400, 'reason required');
  assert.equal((await api.post(`/timeclock/punches/${id}/correct`, { clock_out: '2025-07-01 07:00', reason: 'Typo' })).status, 400, 'out before in');
  assert.equal((await api.post(`/timeclock/punches/${id}/correct`, { clock_in: '2025-07-20 08:00', reason: 'Typo' })).status, 400, 'no future times');
  const fixed = await api.post(`/timeclock/punches/${id}/correct`, { clock_in: '2025-07-01 07:30', break_minutes: 30, reason: 'Came in early for a sterilization audit' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.deepEqual([fixed.data.clock_in, fixed.data.original_in, fixed.data.break_minutes, fixed.data.corrected], ['2025-07-01 07:30', '2025-07-01 08:02', 30, true]);
  const raw = await h.db.get('SELECT clock_in, clock_out FROM time_punches WHERE id = ?', id);
  assert.deepEqual(raw, { clock_in: '2025-07-01 08:02', clock_out: '2025-07-01 16:31' }, 'the punched times never change');
  const detail = (await api.get(`/timeclock/punches/${id}`)).data;
  assert.equal(detail.corrections.length, 1);
  assert.deepEqual([detail.corrections[0].before_in, detail.corrections[0].new_in, detail.corrections[0].reason], ['2025-07-01 08:02', '2025-07-01 07:30', 'Came in early for a sterilization audit']);
  const log = await auditRows(pid, 'timeclock.edit');
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'Came in early for a sterilization audit');
  assert.ok(JSON.parse(log[0].changes).clock_in, 'before → after in the audit log');
  // Hours follow the correction: 07:30–16:31 minus 30 = 8 h 31 m.
  const sheet = (await api.get('/timeclock?from=2025-07-01&to=2025-07-01')).data;
  assert.equal(sheet.punches[0].minutes, 511);
  // A missed shift, added with a reason; overlapping time is refused.
  assert.equal((await api.post('/timeclock/punches', { user_id: cy.id, clock_in: '2025-07-02 08:00', clock_out: '2025-07-02 12:00' })).status, 400);
  const add = await api.post('/timeclock/punches', { user_id: cy.id, clock_in: '2025-07-02 08:00', clock_out: '2025-07-02 12:00', reason: 'Forgot to clock in' });
  assert.equal(add.status, 201);
  assert.equal((await api.post('/timeclock/punches', { user_id: cy.id, clock_in: '2025-07-02 11:00', clock_out: '2025-07-02 13:00', reason: 'Dup' })).status, 409);
  // Removing is a void with a reason: it leaves the hours but stays on record.
  assert.equal((await api.post(`/timeclock/punches/${add.data.id}/void`, {})).status, 400);
  assert.equal((await api.post(`/timeclock/punches/${add.data.id}/void`, { reason: 'Entered for the wrong person' })).status, 200);
  assert.equal((await api.get('/timeclock?from=2025-07-02&to=2025-07-02')).data.punches.length, 0);
  const voided = await h.db.get('SELECT * FROM time_punches WHERE id = ?', add.data.id);
  assert.equal(voided.delete_reason, 'Entered for the wrong person');
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM time_punch_corrections WHERE punch_id = ? AND kind = 'void'", add.data.id)).n, 1);
  // A forgotten clock-out shows on the Today board and in Needs attention, and is resolved by the fix.
  setNow(tz, '2025-07-03 08:00');
  const open = await cy.client.post('/timeclock/in', {});
  setNow(tz, '2025-07-04 09:00');
  const board = (await api.get('/timeclock/today')).data;
  assert.ok(board.people.find((p) => p.user_id === cy.id).flags.some((f) => f.kind === 'forgot_out'));
  assert.equal((await h.db.get("SELECT status FROM issues WHERE dedupe_key = ? AND practice_id = ?", `timeclock-open:${open.data.punch.id}`, pid)).status, 'open');
  assert.equal((await api.post(`/timeclock/punches/${open.data.punch.id}/correct`, { clock_out: '2025-07-03 16:00', reason: 'Forgot to clock out' })).status, 200);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE dedupe_key = ? AND practice_id = ?', `timeclock-open:${open.data.punch.id}`, pid)).status, 'resolved');
  assert.equal((await cy.client.get('/timeclock/me')).data.clocked_in, null);
  clearNow();
});

test('pay periods: approval locks the hours, unlocking needs a reason, exports match approved hours in every format', async () => {
  const tz = 'America/Los_Angeles';
  const { api, email, patient } = await h.practice({ timezone: tz });
  const pid = await practiceOf(email);
  assert.equal((await api.put('/timeclock/settings', { pay_period: 'weekly', week_start_day: 1, period_anchor: '2025-06-02', pto_mode: 'per_hour', pto_per_hour: 2, adp_company_code: 'ABC' })).status, 200);
  const di = await person(api, 'Di Payroll');
  const ed = await person(api, 'Ed Payroll');
  await api.put(`/timeclock/staff/${di.id}`, { payroll_id: 'EMP-001' });
  assert.equal((await api.put(`/timeclock/staff/${ed.id}`, { payroll_id: 'EMP-001' })).status, 409, 'payroll ids are unique');
  await api.put(`/timeclock/staff/${ed.id}`, { payroll_id: 'EMP-002' });
  setNow(tz, '2025-06-20 12:00');
  // Di: Mon–Fri 9 h (with a 30-minute lunch → 8.5 h) = 42.5 h → 2.5 h overtime. Ed: Mon 4 h and a holiday Wednesday.
  for (const d of ['02', '03', '04', '05', '06']) {
    assert.equal((await api.post('/timeclock/punches', { user_id: di.id, clock_in: `2025-06-${d} 08:00`, clock_out: `2025-06-${d} 17:00`, break_minutes: 30, reason: 'Paper timesheet' })).status, 201);
  }
  await api.post('/timeclock/punches', { user_id: ed.id, clock_in: '2025-06-02 09:00', clock_out: '2025-06-02 13:00', reason: 'Paper timesheet' });
  assert.equal((await api.post('/timeclock/holidays', { date: '2025-06-04', name: 'Office closed', hours: 8 })).status, 201);
  // Ed takes Thursday off (PTO), approved by the manager; balance goes negative and says so.
  const pto = await ed.client.post('/timeclock/pto', { start_date: '2025-06-05', end_date: '2025-06-05', hours_per_day: 8, note: 'Dentist appointment' });
  assert.equal(pto.status, 201);
  assert.equal((await ed.client.post('/timeclock/pto', { start_date: '2025-06-05', hours_per_day: 4 })).status, 409, 'same day asked twice');
  assert.equal((await ed.client.post(`/timeclock/pto/${pto.data.id}/decide`, { approve: true })).status, 403);
  const ok = await api.post(`/timeclock/pto/${pto.data.id}/decide`, { approve: true });
  assert.equal(ok.status, 200);
  assert.match(ok.data.warning, /negative/);
  assert.equal((await api.post(`/timeclock/pto/${pto.data.id}/decide`, { approve: true })).status, 409, 'decided once');

  const review = (await api.get('/timeclock/period?date=2025-06-02')).data;
  assert.deepEqual(review.period, { start: '2025-06-02', end: '2025-06-08' });
  const d1 = review.people.find((p) => p.user_id === di.id);
  const e1 = review.people.find((p) => p.user_id === ed.id);
  assert.deepEqual([d1.minutes.regular, d1.minutes.overtime, d1.minutes.holiday], [2400, 150, 480]);
  assert.deepEqual([e1.minutes.regular, e1.minutes.pto, e1.minutes.holiday], [240, 480, 480]);
  // Exports wait for approvals.
  assert.equal((await api.get('/timeclock/period/export.csv?start=2025-06-02&format=gusto')).status, 409);
  // The current (unfinished) period can't be approved; staff can't approve.
  assert.equal((await api.post('/timeclock/period/approve', { start: '2025-06-16' })).status, 409);
  assert.equal((await di.client.post('/timeclock/period/approve', { start: '2025-06-02' })).status, 403);
  const appr = await api.post('/timeclock/period/approve', { start: '2025-06-02' });
  assert.equal(appr.status, 200, JSON.stringify(appr.data));
  assert.equal(appr.data.approved.length, 2);
  assert.equal((await api.post('/timeclock/period/approve', { start: '2025-06-02' })).data.approved.length, 0, 'approving twice does nothing');
  // PTO earned: 2 minutes per hour worked, once. Di worked 42.5 h → 85 min.
  assert.equal((await h.db.get("SELECT SUM(minutes) AS m FROM pto_ledger WHERE user_id = ? AND kind = 'accrual' AND voided_at IS NULL", di.id)).m, 85);
  // Locked: no corrections, added time, time off or holidays inside the approved period.
  const aPunch = (await h.db.get('SELECT id FROM time_punches WHERE user_id = ? ORDER BY id LIMIT 1', di.id)).id;
  const locked = await api.post(`/timeclock/punches/${aPunch}/correct`, { clock_in: '2025-06-02 07:00', reason: 'Late fix' });
  assert.equal(locked.status, 409);
  assert.match(locked.data.error, /approved and locked/);
  assert.equal((await api.post('/timeclock/punches', { user_id: di.id, clock_in: '2025-06-07 08:00', clock_out: '2025-06-07 09:00', reason: 'x' })).status, 409);
  assert.equal((await di.client.post('/timeclock/pto', { start_date: '2025-06-07', hours_per_day: 4 })).status, 409);
  assert.equal((await api.post('/timeclock/holidays', { date: '2025-06-06', name: 'Nope' })).status, 409);

  // One click per format; each file is recorded with its hash, and its hours equal the approved hours.
  const approvedMinutes = [d1, e1].reduce((t, p) => t + p.minutes.total, 0);
  for (const format of ['gusto', 'adp', 'paychex', 'quickbooks', 'csv']) {
    const res = await fetch(`${h.origin}/api/timeclock/period/export.csv?start=2025-06-02&format=${format}`, { headers: { Authorization: (await tokenOf(api)) } });
    assert.equal(res.status, 200, format);
    const bytes = Buffer.from(await res.arrayBuffer());
    const row = await h.db.get('SELECT * FROM payroll_exports WHERE id = ?', Number(res.headers.get('x-export-id')));
    assert.equal(row.content_hash, createHash('sha256').update(bytes).digest('hex'), `${format}: hash of what was downloaded`);
    assert.equal(row.total_minutes, approvedMinutes, format);
    assert.ok(Math.abs(exportedMinutes(format, bytes.toString('utf8')) - approvedMinutes) <= 1, `${format}: file hours = approved hours`);
    if (format !== 'quickbooks') assert.match(bytes.toString('utf8'), /EMP-001/);
  }
  assert.equal((await auditRows(pid, 'timeclock.export')).length, 5);
  const after = (await api.get('/timeclock/period?date=2025-06-02')).data;
  assert.equal(after.reconciliation.ok, true);
  assert.equal(after.reconciliation.approved_minutes, approvedMinutes);
  assert.equal(after.exports.length, 5);

  // Reopening: a reason, audited, the accrual reversed; the old export is now flagged as not matching.
  assert.equal((await api.post('/timeclock/period/unlock', { user_id: di.id, start: '2025-06-02' })).status, 400);
  assert.equal((await api.post('/timeclock/period/unlock', { user_id: di.id, start: '2025-06-02', reason: 'Missed a lunch' })).status, 200);
  assert.equal((await auditRows(pid, 'timeclock.period_unlock'))[0].reason, 'Missed a lunch');
  assert.equal((await h.db.get("SELECT COALESCE(SUM(minutes), 0) AS m FROM pto_ledger WHERE user_id = ? AND kind = 'accrual' AND voided_at IS NULL", di.id)).m, 0);
  assert.equal((await api.post(`/timeclock/punches/${aPunch}/correct`, { break_minutes: 60, reason: 'Missed a lunch' })).status, 200);
  const reopened = (await api.get('/timeclock/period?date=2025-06-02')).data;
  assert.equal(reopened.people.find((p) => p.user_id === di.id).approval, null);
  assert.equal((await api.post('/timeclock/period/approve', { start: '2025-06-02', user_ids: [di.id] })).data.approved.length, 1);
  const stale = (await api.get('/timeclock/period?date=2025-06-02')).data.reconciliation;
  assert.equal(stale.ok, false, 'the last file no longer matches the approved hours');
  assert.equal(stale.differences[0].user_id, di.id);
  await api.get('/timeclock/period/export.csv?start=2025-06-02&format=csv');
  assert.equal((await api.get('/timeclock/period?date=2025-06-02')).data.reconciliation.ok, true);
  assert.equal((await h.db.get("SELECT SUM(minutes) AS m FROM pto_ledger WHERE user_id = ? AND kind = 'accrual' AND voided_at IS NULL", di.id)).m, 84, 'accrued again once, on the corrected hours');

  // Reports: hours, tardiness and labor cost as a percent of production (ledger charges, voided ones left out).
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date) VALUES (?, ?, 'charge', 500000, 'Crown', '2025-06-03')", pid, patient.id);
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date, voided_at) VALUES (?, ?, 'charge', 999999, 'Voided', '2025-06-03', '2025-06-03')", pid, patient.id);
  assert.equal((await api.get('/timeclock/staff')).data.find((s) => s.user_id === di.id).hourly_rate_cents, null, 'admins see rates (not set yet)');
  assert.equal((await api.put(`/timeclock/staff/${di.id}`, { hourly_rate_cents: 3000 })).status, 200);
  await api.put(`/timeclock/staff/${ed.id}`, { hourly_rate_cents: 2000 });
  const rep = (await api.get('/timeclock/reports?from=2025-06-02&to=2025-06-08')).data;
  // Di: 37.5 h reg ... after the fix: Mon 8 h, Tue–Fri 8.5 h = 42 h → 40 reg + 2 OT, + 8 holiday = 40×30 + 2×45 + 8×30 = 1530.00
  // Ed: 4 h + 8 PTO + 8 holiday = 20 h × 20 = 400.00 → 1930.00 of 5000.00 production = 38.6%.
  assert.equal(rep.labor.cost_cents, 193000);
  assert.equal(rep.labor.production_cents, 500000);
  assert.equal(rep.labor.percent, 38.6);
  assert.ok(rep.weeks.length === 1 && rep.people.length === 2);
  clearNow();
});

test('permissions and practice isolation', async () => {
  clearNow();
  const a = await h.practice({ timezone: 'UTC' });
  const b = await h.practice({ timezone: 'UTC' });
  const fay = await person(a.api, 'Fay Staff');
  const mgr = await person(a.api, 'Gil Manager', { permissions_add: ['timeclock:manage'] });
  const bookkeeper = await person(a.api, 'Hal Rates', { permissions_add: ['timeclock:manage', 'timeclock:rates'] });
  const other = await person(b.api, 'Ida Other');
  // Staff: their own clock only.
  for (const [m, p, body] of [['get', '/timeclock/today'], ['get', '/timeclock/period'], ['get', '/timeclock/period/export.csv?format=csv'], ['put', '/timeclock/settings', { rounding: 15 }],
    ['get', '/timeclock/staff'], ['get', '/timeclock/reports?from=2025-01-01&to=2025-01-31'], ['put', '/timeclock/shifts', { user_id: fay.id, date: '2025-01-02', off: true }], ['post', '/timeclock/kiosks', {}]]) {
    assert.equal((await fay.client[m](p, body)).status, 403, `${m} ${p}`);
  }
  const mine = (await fay.client.get('/timeclock?from=2025-01-01&to=2025-01-31&user_id=' + mgr.id)).data;
  assert.equal(mine.manager, false);
  // A manager with timeclock:manage runs the clock but doesn't see pay rates.
  assert.equal((await mgr.client.get('/timeclock/today')).status, 200);
  assert.equal((await mgr.client.get('/timeclock/staff')).data[0].hourly_rate_cents, undefined);
  assert.equal((await mgr.client.put(`/timeclock/staff/${fay.id}`, { hourly_rate_cents: 2500 })).status, 403);
  assert.equal((await mgr.client.get('/timeclock/reports?from=2025-01-01&to=2025-01-31')).data.labor, undefined);
  assert.equal((await bookkeeper.client.put(`/timeclock/staff/${fay.id}`, { hourly_rate_cents: 2500 })).status, 200);
  assert.equal((await bookkeeper.client.get('/timeclock/staff')).data.find((s) => s.user_id === fay.id).hourly_rate_cents, 2500);
  assert.ok((await h.db.all("SELECT * FROM audit_log WHERE action = 'timeclock.rate'")).length >= 1, 'rate changes are audited');
  // Nothing crosses practices.
  const add = await a.api.post('/timeclock/punches', { user_id: fay.id, clock_in: '2025-01-02 08:00', clock_out: '2025-01-02 12:00', reason: 'Paper' });
  assert.equal(add.status, 201);
  assert.equal((await b.api.get(`/timeclock/punches/${add.data.id}`)).status, 404);
  assert.equal((await b.api.post(`/timeclock/punches/${add.data.id}/correct`, { clock_in: '2025-01-02 07:00', reason: 'x' })).status, 404);
  assert.equal((await b.api.post(`/timeclock/punches/${add.data.id}/void`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.post('/timeclock/punches', { user_id: fay.id, clock_in: '2025-01-03 08:00', clock_out: '2025-01-03 12:00', reason: 'x' })).status, 404);
  assert.equal((await b.api.put('/timeclock/shifts', { user_id: fay.id, date: '2025-01-02', off: true })).status, 404);
  assert.equal((await b.api.put(`/timeclock/staff/${fay.id}`, { payroll_id: 'X' })).status, 404);
  assert.ok(!(await b.api.get('/timeclock?from=2025-01-01&to=2025-01-31')).data.punches.some((p) => p.user_id === fay.id));
  assert.ok(!(await b.api.get('/timeclock/today')).data.people.some((p) => p.user_id === fay.id));
  assert.equal((await b.api.get(`/timeclock?from=2025-01-01&to=2025-01-31&user_id=${fay.id}`)).status, 404);
  assert.ok((await b.api.get('/timeclock/period?date=2025-01-02')).data.people.every((p) => p.user_id !== fay.id));
  assert.equal(other.id > 0, true);
  // The assistant can't approve or export without a person's OK.
  const ai = h.client(tokens.get(a.api).slice(7), { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post('/timeclock/period/approve', {})).status, 428);
  assert.equal((await ai.get('/timeclock/period/export.csv?format=csv')).status, 428);
  // Validation: impossible dates and times are refused.
  assert.equal((await a.api.put('/timeclock/shifts', { user_id: fay.id, date: '2025-02-30', start_time: '08:00', end_time: '17:00' })).status, 400);
  assert.equal((await a.api.put('/timeclock/shifts', { user_id: fay.id, date: '2025-02-03', start_time: '17:00', end_time: '08:00' })).status, 400);
  assert.equal((await a.api.put('/timeclock/shifts', { user_id: fay.id, date: '2025-02-03', start_time: '25:00', end_time: '26:00' })).status, 400);
  assert.equal((await a.api.post('/timeclock/punches', { user_id: fay.id, clock_in: '2025-02-03 08:61', reason: 'x' })).status, 400);
  assert.equal((await a.api.put('/timeclock/settings', { rounding: 7 })).status, 400);
  assert.equal((await a.api.put('/timeclock/settings', { pay_period: 'daily' })).status, 400);
});

test('schedules: usual week, per-date overrides, days off and copying a week', async () => {
  clearNow();
  const { api } = await h.practice({ timezone: 'UTC' });
  await api.put('/timeclock/settings', { week_start_day: 1 });
  const jo = await person(api, 'Jo Sched');
  for (const wd of [1, 2, 3, 4]) assert.equal((await api.put('/timeclock/templates', { user_id: jo.id, weekday: wd, start_time: '08:00', end_time: '17:00', break_minutes: 60 })).status, 200);
  assert.equal((await api.put('/timeclock/shifts', { user_id: jo.id, date: '2025-03-04', off: true })).status, 200);
  assert.equal((await api.put('/timeclock/shifts', { user_id: jo.id, date: '2025-03-07', start_time: '07:00', end_time: '12:00' })).status, 200);
  const wk = (await api.get('/timeclock/schedule?week=2025-03-05')).data;
  assert.equal(wk.week_start, '2025-03-03');
  const row = wk.people.find((p) => p.user_id === jo.id);
  assert.deepEqual([row.days['2025-03-03'].source, row.days['2025-03-04'].off, row.days['2025-03-07'].start_time, row.days['2025-03-08']], ['template', true, '07:00', null]);
  assert.equal(row.scheduled_minutes, 8 * 60 * 3 + 5 * 60 - 0);
  // Copy onto next week: overrides (the day off, the Friday) come along; days set by hand there stay.
  await api.put('/timeclock/shifts', { user_id: jo.id, date: '2025-03-11', start_time: '10:00', end_time: '14:00' });
  const copy = await api.post('/timeclock/schedule/copy', { from_week: '2025-03-03', to_week: '2025-03-10' });
  assert.equal(copy.status, 200);
  assert.equal(copy.data.skipped, 1);
  const next = (await api.get('/timeclock/schedule?week=2025-03-10')).data.people.find((p) => p.user_id === jo.id);
  assert.deepEqual([next.days['2025-03-11'].start_time, next.days['2025-03-14'].start_time, next.days['2025-03-10'].source], ['10:00', '07:00', 'override']);
  // Clearing a date goes back to the usual week.
  await api.put('/timeclock/shifts', { user_id: jo.id, date: '2025-03-11', clear: true });
  assert.equal((await api.get('/timeclock/schedule?week=2025-03-10')).data.people.find((p) => p.user_id === jo.id).days['2025-03-11'].source, 'template');
  // Staff can see the schedule, not change it.
  assert.equal((await jo.client.get('/timeclock/schedule?week=2025-03-10')).status, 200);
  assert.equal((await jo.client.put('/timeclock/templates', { user_id: jo.id, weekday: 5, start_time: '08:00', end_time: '12:00' })).status, 403);
});

test('shared tablet: PIN (hashed, rate-limited), punches recorded as the person on the tablet', async () => {
  clearNow();
  const kapp = express();
  kapp.use(actorMiddleware(h.db, flushChanges));
  kapp.use(express.json());
  kapp.use('/api/kiosk', timeclockKioskRoutes({ db: h.db }));
  kapp.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = kapp.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/kiosk`;
  const call = async (path, token, body) => {
    const res = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Kiosk-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  try {
    const { api, email } = await h.practice({ timezone: 'UTC' });
    const pid = await practiceOf(email);
    const kim = await person(api, 'Kim Tablet');
    assert.equal((await kim.client.post('/timeclock/pin', { pin: '1234' })).status, 400, 'no straight runs');
    assert.equal((await kim.client.post('/timeclock/pin', { pin: '4827' })).status, 200);
    const stored = await h.db.get('SELECT pin_hash FROM timeclock_staff WHERE user_id = ?', kim.id);
    assert.ok(stored.pin_hash.startsWith('scrypt$') && !stored.pin_hash.includes('4827'), 'the PIN is stored hashed');
    const kiosk = await api.post('/timeclock/kiosks', { name: 'Front desk' });
    assert.equal(kiosk.status, 201);
    assert.equal((await call('/timeclock/staff', 'wrong-token')).status, 401);
    const list = await call('/timeclock/staff', kiosk.data.token);
    assert.equal(list.status, 200);
    assert.ok(list.data.people.some((p) => p.id === kim.id && p.name === 'Kim T.' && p.status === 'out'));
    // Four wrong PINs count down; the fifth locks the PIN for 15 minutes (even the right PIN is refused).
    for (let i = 1; i <= 4; i++) {
      const bad = await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '0000', action: 'in' });
      assert.equal(bad.status, 401);
      assert.match(bad.data.error, new RegExp(`${5 - i} tr`));
    }
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '0000', action: 'in' })).status, 429);
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '4827', action: 'in' })).status, 429);
    assert.equal((await auditRows(pid, 'timeclock.pin_locked')).length, 1);
    // A manager resets it; she sets a new PIN and clocks in on the tablet.
    assert.equal((await api.post(`/timeclock/staff/${kim.id}/pin-reset`, {})).status, 200);
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '4827', action: 'in' })).status, 409, 'no PIN until she sets one');
    await kim.client.post('/timeclock/pin', { pin: '5831' });
    const inRes = await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '5831', action: 'in' });
    assert.equal(inRes.status, 201, JSON.stringify(inRes.data));
    assert.equal(inRes.data.punch.source, 'kiosk');
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '5831', action: 'in' })).status, 409, 'already in');
    const entry = (await auditRows(pid, 'timeclock.in')).pop();
    assert.equal(entry.user_id, kim.id);
    assert.match(entry.actor, /Kim Tablet \(time clock tablet: Front desk\)/);
    assert.equal((await call('/timeclock/staff', kiosk.data.token)).data.people.find((p) => p.id === kim.id).status, 'in');
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: kim.id, pin: '5831', action: 'out' })).status, 200);
    // Another practice's person can't punch on this tablet; a revoked tablet stops working.
    const other = await h.practice({ timezone: 'UTC' });
    const stranger = await person(other.api, 'Lou Stranger');
    await stranger.client.post('/timeclock/pin', { pin: '5831' });
    assert.equal((await call('/timeclock/punch', kiosk.data.token, { user_id: stranger.id, pin: '5831', action: 'in' })).status, 404);
    await api.post(`/timeclock/kiosks/${kiosk.data.id}/revoke`, {});
    assert.equal((await call('/timeclock/staff', kiosk.data.token)).status, 401);
  } finally {
    server.close();
  }
});

test('daylight-saving days through the API: timesheets pay real hours', async () => {
  const tz = 'America/New_York';
  const { api } = await h.practice({ timezone: tz });
  const mo = await person(api, 'Mo Night');
  setNow(tz, '2026-12-01 12:00');
  await api.post('/timeclock/punches', { user_id: mo.id, clock_in: '2026-03-08 00:00', clock_out: '2026-03-08 08:00', reason: 'Overnight sterilizer check' });
  await api.post('/timeclock/punches', { user_id: mo.id, clock_in: '2026-11-01 00:00', clock_out: '2026-11-01 08:00', reason: 'Overnight sterilizer check' });
  const sheet = (await api.get('/timeclock?from=2026-03-01&to=2026-11-30')).data;
  assert.deepEqual(sheet.punches.map((p) => p.minutes), [7 * 60, 9 * 60]);
  // A live punch across the spring-forward change: the punched UTC instants are used.
  setNow(tz, '2026-03-08 01:30');
  await mo.client.post('/timeclock/in', {});
  setNow(tz, '2026-03-08 03:30'); // one real hour later
  const out = await mo.client.post('/timeclock/out', {});
  assert.equal(out.data.worked_minutes, 60);
  clearNow();
});
