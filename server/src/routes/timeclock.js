import { Router } from 'express';
import { HttpError, can, hashPassword, verifyPassword, rateLimit } from '../auth.js';
import { insert, update, recorded, findOr404, audit, toCsv, hashToken, newToken } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { publish } from '../events.js';
import {
  DEFAULT_SETTINGS, PAY_TYPES, EXPORT_FORMATS, PERIOD_TYPES, ROUNDING, isDate, isHm, isLocal, hmToMin, addDays, daysBetween, weekday, weekStart, dateRange,
  utcToLocal, localToUtc, unpaidBreakMinutes, workedMinutes, classifyPunches, clockInCheck, clockOutCheck, fmt12, periodFor, previousPeriod, nextPeriod,
  summarize, ptoDays, ptoAccrual, pinProblem, usHolidays, buildExport, reconcile, detailHash,
} from '../timeclock.js';

// Time clock, staff schedules and payroll (TC1–TC5; docs/workflows/specs/TC-timeclock.md).
//
// How time is kept:
// - time_punches: one row per shift segment (clock in → clock out), practice-local wall-clock times plus the
//   exact UTC instants (so daylight-saving days pay the real hours). clock_in/clock_out are what was punched and
//   never change once set; eff_in/eff_out/eff_break are what counts after manager corrections (a cache rebuilt
//   from time_punch_corrections, which keep the reason, who and when — the original stays visible).
// - time_breaks: breaks and lunches inside a punch. time_open_punches: one row per person who is clocked in, so a
//   double click or two tablets can never open two punches (the database refuses a second row).
// - Schedules: staff_shift_templates (the usual week) and staff_shifts (a date's override or day off).
// - Pay: timeclock_settings (windows, pay period, overtime, rounding, PTO), timeclock_staff (payroll id, rate,
//   PIN), pto_requests + pto_ledger (balance = SUM(minutes)), timeclock_holidays, pay_period_approvals
//   (approving locks the period for that person), payroll_exports (every file: who, when, period, hash).
// Everyone punches themselves; timeclock:manage runs schedules, corrections, approvals and exports;
// timeclock:rates (or an administrator) sees and sets pay rates and labor cost.

const REASON_MAX = 300;
const clean = (v, max = 200) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null);
const isUnique = (err) => /unique|duplicate key/i.test(String(err?.message));
const asId = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a number`);
  return n;
};
const reqDate = (v, name) => {
  if (!isDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return v;
};
const reqHm = (v, name) => {
  if (!isHm(v)) throw new HttpError(400, `${name} must be a time like 08:00`);
  return v;
};
const toLocal = (v, name) => {
  const s = String(v ?? '').replace('T', ' ').slice(0, 16);
  if (!isLocal(s)) throw new HttpError(400, `${name} must be a real date and time (YYYY-MM-DD HH:MM)`);
  return s;
};
const reasonOf = (body, what = 'Say why') => {
  const r = clean(body?.reason ?? body?.note, REASON_MAX);
  if (!r) throw new HttpError(400, `${what} — the reason is kept with the change`);
  return r;
};
const minutesInt = (v, name, { min = 0, max = 24 * 60 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) throw new HttpError(400, `${name} must be a whole number of minutes from ${min} to ${max}`);
  return n;
};
const hoursToMinutes = (v, name, { min = 0, max = 24 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be hours from ${min} to ${max}`);
  return Math.round(n * 60);
};
const iso = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString();
// "Sam Okafor, RDH" → "Sam O."; "Dr. Alex Chen" → "Alex C." (the shared tablet shows only this much).
const firstLast = (name = '') => {
  const p = String(name).split(',')[0].trim().split(/\s+/).filter((w, i, all) => !(i === 0 && all.length > 2 && /^(dr|mr|mrs|ms|mx)\.?$/i.test(w)));
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0];
};

// Changes the assistant (AI) may only make after a person says yes on screen (CLAUDE.md rule 10). aiguard.js
// holds the app-wide list; these are checked here as well so the time clock is safe on its own.
const AI_HIGH_RISK = [
  ['POST', /^\/timeclock\/punches(\/\d+\/(correct|void))?$/], ['PUT', /^\/timeclock\/punches\/\d+$/], ['DELETE', /^\/timeclock\//],
  ['POST', /^\/timeclock\/period\/(approve|unlock)$/], ['GET', /^\/timeclock\/(period\/export\.csv|payroll\.csv)$/],
  ['PUT', /^\/timeclock\/(staff\/\d+|settings)$/], ['POST', /^\/timeclock\/pto\/(\d+\/decide|adjust)$/], ['POST', /^\/timeclock\/kiosks/],
];

export default function timeclockRoutes({ db }) {
  const r = Router();
  const manager = (req) => can(req.user, 'timeclock:manage');
  const ratesOk = (req) => can(req.user, 'timeclock:rates');
  const needManager = (req) => {
    if (!manager(req)) throw new HttpError(403, 'Missing permission: timeclock:manage');
  };
  const nowMs = (req) => req.app?.locals?.timeclockNow?.() ?? Date.now();

  r.use((req, res, next) => {
    if (!req.path.startsWith('/timeclock')) return next();
    const ctx = currentActor();
    if (ctx?.source === 'ai' && AI_HIGH_RISK.some(([m, re]) => m === req.method && re.test(req.path))) {
      if (req.get('X-Human-Approved') !== '1') return res.status(428).json({ error: 'The assistant can’t change time, approvals, pay or exports without your OK. Confirm it, or do it yourself.', needs_approval: true });
      setActor({ approvedBy: req.user.id });
    }
    next();
  });

  const ctxFor = (req) => ({ db, practiceId: req.user.practice_id, now: nowMs(req) });

  // ---------------- The person's own clock ----------------
  r.get('/timeclock/me', async (req, res) => {
    const c = ctxFor(req);
    const { tz, settings } = await practiceRules(db, c.practiceId);
    const nowLocal = utcToLocal(tz, c.now);
    const today = nowLocal.slice(0, 10);
    const open = await openPunch(db, req.user.id);
    const brk = open ? await openBreak(db, open.id) : null;
    const shift = await shiftFor(db, c.practiceId, req.user.id, today);
    const wk = weekStart(today, settings.week_start_day);
    const people = await computeHours(db, c.practiceId, { from: wk, to: today, userIds: [req.user.id], tz, settings, nowMs: c.now });
    const me = people.get(req.user.id);
    const running = me?.running || 0;
    const todayMin = (me?.punches || []).filter((p) => p.date === today).reduce((t, p) => t + (p.minutes || 0), 0) + running;
    const weekMin = (me?.summary.worked || 0) + running;
    const period = periodFor(today, settings);
    const staff = await staffRow(db, req.user.id);
    const window = open ? null : clockInCheck(nowLocal, shift, settings);
    res.json({
      now: nowLocal, today, clocked_in: open ? effIn(open) : null, punch_id: open?.id ?? null,
      on_break: brk ? { id: brk.id, kind: brk.kind, since: brk.start_at } : null,
      shift, window, today_minutes: todayMin, week_minutes: weekMin, week_hours: Math.round((weekMin / 60) * 100) / 100,
      overtime_minutes_left: settings.ot_weekly ? Math.max(0, settings.ot_weekly_minutes - weekMin) : null,
      punches: (me?.punches || []).filter((p) => p.date === today).map(publicPunch),
      period, has_pin: !!staff?.pin_hash, pto_balance_minutes: await ptoBalance(db, req.user.id),
      manager: manager(req), rates: ratesOk(req),
    });
  });

  const selfPunch = (action) => async (req, res) => {
    const out = await doPunch(db, {
      practiceId: req.user.practice_id, user: req.user, action, source: 'self', now: nowMs(req), locationId: req.location_id ?? null,
      device: clean(req.get('user-agent'), 200), ip: req.ip ?? null, note: clean(req.body?.note), breakMinutes: req.body?.break_minutes, kind: req.body?.kind,
    }, req);
    res.status(action === 'in' ? 201 : 200).json(out);
  };
  r.post('/timeclock/in', selfPunch('in'));
  r.post('/timeclock/out', selfPunch('out'));
  r.post('/timeclock/break/start', selfPunch('break_start'));
  r.post('/timeclock/break/end', selfPunch('break_end'));

  // A PIN for the shared time-clock tablet (stored hashed; only the person sets it, a manager can clear it).
  r.post('/timeclock/pin', async (req, res) => {
    const problem = pinProblem(req.body?.pin);
    if (problem) throw new HttpError(400, problem);
    await saveStaff(db, req.user.practice_id, req.user.id, { pin_hash: hashPassword(String(req.body.pin)), pin_set_at: new Date().toISOString(), pin_failures: 0, pin_locked_until: null }, req.user.id);
    await audit(db, req, 'timeclock.pin_set', 'users', req.user.id);
    res.json({ ok: true });
  });

  // ---------------- Timesheets ----------------
  const range = (req, maxDays = 370) => {
    const from = reqDate(req.query.from, 'from');
    const to = reqDate(req.query.to, 'to');
    if (to < from) throw new HttpError(400, 'to must be on or after from');
    if (daysBetween(from, to) > maxDays) throw new HttpError(400, `Pick at most ${maxDays} days`);
    return [from, to];
  };
  const whoFor = async (req) => {
    if (!manager(req)) return [req.user.id];
    if (!req.query.user_id) return null;
    return [(await findOr404(db, 'users', asId(req.query.user_id, 'user_id'), req.user.practice_id, 'Person')).id];
  };

  r.get('/timeclock', async (req, res) => {
    const [from, to] = range(req);
    const userIds = await whoFor(req);
    const people = await computeHours(db, req.user.practice_id, { from, to, userIds, nowMs: nowMs(req) });
    const punches = [...people.values()].flatMap((p) => p.punches.filter((x) => x.date >= from && x.date <= to).map((x) => ({ ...publicPunch(x), user_name: p.name })));
    punches.sort((a, b) => (a.user_name === b.user_name ? (a.clock_in < b.clock_in ? -1 : 1) : String(a.user_name).localeCompare(String(b.user_name))));
    res.json({ from, to, manager: manager(req), punches, summary: [...people.values()].filter((p) => p.punches.length || p.summary.total).map(summaryRow).sort((a, b) => a.name.localeCompare(b.name)) });
  });

  // The raw timesheet as a spreadsheet (not the payroll file — that comes from approved hours, below).
  r.get('/timeclock/payroll.csv', async (req, res) => {
    needManager(req);
    const [from, to] = range(req);
    const people = await computeHours(db, req.user.practice_id, { from, to, userIds: await whoFor(req), nowMs: nowMs(req) });
    const rows = [...people.values()].filter((p) => p.punches.length || p.summary.total).map(summaryRow).sort((a, b) => a.name.localeCompare(b.name));
    const csv = toCsv(rows, [['Employee', (x) => x.name], ['Regular hours', (x) => x.regular_hours], ['Overtime hours', (x) => x.overtime_hours], ['Double time hours', (x) => x.doubletime_hours],
      ['PTO hours', (x) => x.pto_hours], ['Holiday hours', (x) => x.holiday_hours], ['Total hours', (x) => x.hours], ['Open punches', (x) => x.open_punches]]);
    await audit(db, req, 'timeclock.timesheet_export', 'practices', req.user.practice_id, { from, to });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="timesheet-${from}-to-${to}.csv"` }).send(csv);
  });

  // ---------------- Corrections (managers) ----------------
  // A punch is never edited: a correction row says what it becomes and why; the original stays on the punch.
  r.get('/timeclock/punches/:tid', async (req, res) => {
    const p = await findOr404(db, 'time_punches', asId(req.params.tid), req.user.practice_id, 'Punch');
    if (p.user_id !== req.user.id) needManager(req);
    const corrections = await db.all('SELECT c.*, u.name AS by_name FROM time_punch_corrections c LEFT JOIN users u ON u.id = c.created_by WHERE c.punch_id = ? AND c.practice_id = ? ORDER BY c.id', p.id, req.user.practice_id);
    const breaks = await db.all('SELECT id, kind, start_at, end_at, source FROM time_breaks WHERE punch_id = ? ORDER BY id', p.id);
    res.json({ ...p, eff_in: effIn(p), eff_out: effOut(p), corrections, breaks });
  });

  const addPunch = async (req, res) => {
    needManager(req);
    const user = await findOr404(db, 'users', asId(req.body?.user_id, 'user_id'), req.user.practice_id, 'Person');
    const reason = reasonOf(req.body, 'Say why this time is being added');
    const { tz } = await practiceRules(db, req.user.practice_id);
    const inL = toLocal(req.body?.clock_in, 'clock_in');
    const outL = req.body?.clock_out ? toLocal(req.body.clock_out, 'clock_out') : null;
    const brk = req.body?.break_minutes == null ? 0 : minutesInt(req.body.break_minutes, 'break_minutes', { max: 600 });
    await checkSpan(db, { tz, userId: user.id, inL, outL, brk, practiceId: req.user.practice_id, nowLocal: utcToLocal(tz, nowMs(req)) });
    if (!outL && await openPunch(db, user.id)) throw new HttpError(409, `${user.name} is already clocked in`);
    // The same early / late / left-early flags a punch at the clock would have had, against that day's shift.
    const { settings } = await practiceRules(db, req.user.practice_id);
    const shift = await shiftFor(db, req.user.practice_id, user.id, inL.slice(0, 10));
    const inCheck = clockInCheck(inL, shift, settings);
    const outCheck = outL && outL.slice(0, 10) === inL.slice(0, 10) ? clockOutCheck(outL, shift, settings) : null;
    let id;
    try {
      await db.tx(async () => {
        id = await insert(db, 'time_punches', {
          practice_id: req.user.practice_id, user_id: user.id, location_id: req.body?.location_id ? (await findOr404(db, 'locations', asId(req.body.location_id, 'location_id'), req.user.practice_id, 'Office')).id : req.location_id ?? null,
          clock_in: inL, clock_out: outL, break_minutes: 0, eff_in: inL, eff_out: outL, eff_break: brk, corrected: 1, source: 'manager',
          clock_in_utc: iso(localToUtc(tz, inL)), clock_out_utc: outL ? iso(localToUtc(tz, outL)) : null, note: clean(req.body?.note), edited_by: req.user.id, edited_at: new Date().toISOString(),
          in_flag: inCheck.flag, in_flag_minutes: inCheck.minutes || null, out_flag: outCheck?.flag ?? null, out_flag_minutes: outCheck?.minutes || null,
          shift_start: shift && !shift.off ? shift.start_time : null, shift_end: shift && !shift.off ? shift.end_time : null,
        });
        await insert(db, 'time_punch_corrections', { practice_id: req.user.practice_id, punch_id: id, user_id: user.id, kind: 'add', new_in: inL, new_out: outL, new_break: brk, reason, created_by: req.user.id });
        if (!outL) await db.run('INSERT INTO time_open_punches (practice_id, user_id, punch_id) VALUES (?, ?, ?)', req.user.practice_id, user.id, id);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `${user.name} is already clocked in`);
      throw err;
    }
    await audit(db, req, 'timeclock.add', 'time_punches', id, { user_id: user.id, clock_in: inL, clock_out: outL, break_minutes: brk }, { reason, after: { clock_in: inL, clock_out: outL, break_minutes: brk } });
    publish(req.user.practice_id, { type: 'timeclock' });
    res.status(201).json(publicPunch(await loadPunch(db, id, req.user.practice_id)));
  };
  r.post('/timeclock/punches', addPunch);

  const correct = async (req, res) => {
    needManager(req);
    const p = await findOr404(db, 'time_punches', asId(req.params.tid), req.user.practice_id, 'Punch');
    if (p.deleted_at) throw new HttpError(409, 'This punch was removed');
    const b = req.body || {};
    const reason = reasonOf(b, 'Say why the punch is being corrected');
    const { tz } = await practiceRules(db, req.user.practice_id);
    const before = { clock_in: effIn(p), clock_out: effOut(p), break_minutes: await effBreak(db, p, tz) };
    const after = { ...before };
    if (b.clock_in !== undefined) after.clock_in = toLocal(b.clock_in, 'clock_in');
    if (b.clock_out !== undefined) {
      if (b.clock_out === null || b.clock_out === '') {
        if (before.clock_out) throw new HttpError(400, 'A clock-out can be moved but not taken away');
      } else after.clock_out = toLocal(b.clock_out, 'clock_out');
    }
    if (b.break_minutes !== undefined && b.break_minutes !== null) after.break_minutes = minutesInt(b.break_minutes, 'break_minutes', { max: 600 });
    if (after.clock_in === before.clock_in && after.clock_out === before.clock_out && after.break_minutes === before.break_minutes) throw new HttpError(400, 'Nothing to change');
    await assertUnlocked(db, req.user.practice_id, p.user_id, [before.clock_in.slice(0, 10), after.clock_in.slice(0, 10)]);
    await checkSpan(db, { tz, userId: p.user_id, inL: after.clock_in, outL: after.clock_out, brk: after.break_minutes, practiceId: req.user.practice_id, exceptId: p.id, nowLocal: utcToLocal(tz, nowMs(req)) });
    await db.tx(async () => {
      await insert(db, 'time_punch_corrections', {
        practice_id: req.user.practice_id, punch_id: p.id, user_id: p.user_id, kind: 'change', before_in: before.clock_in, before_out: before.clock_out, before_break: before.break_minutes,
        new_in: after.clock_in, new_out: after.clock_out, new_break: after.break_minutes, reason, created_by: req.user.id,
      });
      // eff_break is only pinned when the manager set the break; otherwise breaks still come from the break punches.
      const pinBreak = after.break_minutes !== before.break_minutes ? after.break_minutes : p.eff_break;
      await recorded(db, 'time_punches', p.id, () => db.run('UPDATE time_punches SET eff_in = ?, eff_out = ?, eff_break = ?, corrected = 1, edited_by = ?, edited_at = ? WHERE id = ?',
        after.clock_in, after.clock_out, pinBreak ?? null, req.user.id, new Date().toISOString(), p.id));
      if (after.clock_out && !before.clock_out) {
        // A forgotten clock-out, filled in: the person is no longer clocked in (the open-punch marker is scratch data).
        await db.run('DELETE FROM time_open_punches WHERE punch_id = ?', p.id);
        await db.run('UPDATE time_breaks SET end_at = ?, end_utc = ? WHERE punch_id = ? AND end_at IS NULL', after.clock_out, iso(localToUtc(tz, after.clock_out)), p.id);
      }
    });
    await audit(db, req, 'timeclock.edit', 'time_punches', p.id, { user_id: p.user_id }, { reason, before, after });
    if (after.clock_out) await resolveIssue(db, req.user.practice_id, `timeclock-open:${p.id}`, `Clock-out added by ${req.user.name}`);
    publish(req.user.practice_id, { type: 'timeclock' });
    res.json(publicPunch(await loadPunch(db, p.id, req.user.practice_id)));
  };
  r.post('/timeclock/punches/:tid/correct', correct);
  r.put('/timeclock/punches/:tid', correct);

  const voidPunch = async (req, res) => {
    needManager(req);
    const p = await findOr404(db, 'time_punches', asId(req.params.tid), req.user.practice_id, 'Punch');
    if (p.deleted_at) throw new HttpError(409, 'This punch was already removed');
    const reason = reasonOf(req.body, 'Say why the punch is being removed');
    await assertUnlocked(db, req.user.practice_id, p.user_id, [effIn(p).slice(0, 10)]);
    const { tz } = await practiceRules(db, req.user.practice_id);
    const before = { clock_in: effIn(p), clock_out: effOut(p), break_minutes: await effBreak(db, p, tz) };
    // Payroll records are kept: the punch is marked removed (who, when, why) and drops out of hours and exports.
    await db.tx(async () => {
      await insert(db, 'time_punch_corrections', { practice_id: req.user.practice_id, punch_id: p.id, user_id: p.user_id, kind: 'void', before_in: before.clock_in, before_out: before.clock_out, before_break: before.break_minutes, reason, created_by: req.user.id });
      await recorded(db, 'time_punches', p.id, () => db.run('UPDATE time_punches SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ?', new Date().toISOString(), req.user.id, reason, p.id));
      await db.run('DELETE FROM time_open_punches WHERE punch_id = ?', p.id); // scratch marker only
    });
    await audit(db, req, 'timeclock.delete', 'time_punches', p.id, { user_id: p.user_id, clock_in: before.clock_in, clock_out: before.clock_out }, { reason });
    await resolveIssue(db, req.user.practice_id, `timeclock-open:${p.id}`, 'Punch removed');
    publish(req.user.practice_id, { type: 'timeclock' });
    res.json({ ok: true });
  };
  r.post('/timeclock/punches/:tid/void', voidPunch);
  r.delete('/timeclock/punches/:tid', voidPunch);

  r.get('/timeclock/corrections', async (req, res) => {
    needManager(req);
    const [from, to] = range(req);
    res.json(await db.all(
      `SELECT c.*, u.name AS user_name, m.name AS by_name, t.clock_in AS original_in, t.clock_out AS original_out FROM time_punch_corrections c
       JOIN users u ON u.id = c.user_id LEFT JOIN users m ON m.id = c.created_by JOIN time_punches t ON t.id = c.punch_id
       WHERE c.practice_id = ? AND COALESCE(c.new_in, c.before_in) >= ? AND COALESCE(c.new_in, c.before_in) <= ? ORDER BY c.id DESC LIMIT 500`,
      req.user.practice_id, `${from} 00:00`, `${to} 23:59`,
    ));
  });

  // ---------------- Today board (managers) ----------------
  r.get('/timeclock/today', async (req, res) => {
    needManager(req);
    const c = ctxFor(req);
    const { tz, settings } = await practiceRules(db, c.practiceId);
    const nowLocal = utcToLocal(tz, c.now);
    const today = nowLocal.slice(0, 10);
    const nowMin = hmToMin(nowLocal.slice(11, 16));
    const wk = weekStart(today, settings.week_start_day);
    const staff = await staffList(db, c.practiceId);
    const people = await computeHours(db, c.practiceId, { from: wk, to: today, tz, settings, nowMs: c.now, staff });
    const shifts = await shiftsFor(db, c.practiceId, today, today);
    const pto = await db.all("SELECT user_id, kind FROM pto_requests WHERE practice_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?", c.practiceId, today, today);
    const opens = await db.all(
      `SELECT t.*, b.id AS break_id, b.kind AS break_kind, b.start_at AS break_since FROM time_open_punches o JOIN time_punches t ON t.id = o.punch_id
       LEFT JOIN time_breaks b ON b.id = o.break_id WHERE o.practice_id = ?`, c.practiceId,
    );
    const legacyOpen = await db.all('SELECT t.* FROM time_punches t WHERE t.practice_id = ? AND t.deleted_at IS NULL AND COALESCE(t.eff_out, t.clock_out) IS NULL', c.practiceId);
    const openBy = new Map(legacyOpen.map((p) => [p.user_id, p]));
    for (const o of opens) openBy.set(o.user_id, o);
    const rows = [];
    for (const u of staff) {
      if (!u.active || u.on_clock === 0) continue;
      const hrs = people.get(u.id);
      const shift = shifts.get(`${u.id}:${today}`) || null;
      const open = openBy.get(u.id);
      const todays = (hrs?.punches || []).filter((p) => p.date === today);
      const running = hrs?.running || 0;
      const weekMin = (hrs?.summary.worked || 0) + running;
      const todayMin = todays.reduce((t, p) => t + (p.minutes || 0), 0) + running;
      const flags = [];
      let status;
      let since = null;
      if (open) {
        status = open.break_id ? (open.break_kind === 'lunch' ? 'lunch' : 'break') : 'in';
        since = open.break_id ? open.break_since : effIn(open);
        if (open.in_flag === 'late') flags.push({ kind: 'late', minutes: open.in_flag_minutes });
        if (open.in_flag === 'early') flags.push({ kind: 'early', minutes: open.in_flag_minutes });
        if (open.in_flag === 'unscheduled') flags.push({ kind: 'unscheduled' });
        const hoursOpen = (c.now - punchInMs(open, tz)) / 3600_000;
        if (effIn(open).slice(0, 10) < today || hoursOpen > 14) {
          flags.push({ kind: 'forgot_out' });
          await raiseIssue(db, { practiceId: c.practiceId, kind: 'schedule', key: `timeclock-open:${open.id}`, title: `${u.name} is still clocked in from ${effIn(open)}`, detail: 'Probably a forgotten clock-out. Add the real clock-out time in Time clock → Corrections.', role: 'admin', entity: 'time_punches', entityId: open.id });
        }
      } else if (todays.length) {
        status = 'out';
        const last = todays[todays.length - 1];
        since = last.out_local;
        for (const p of todays) {
          if (p.in_flag === 'late') flags.push({ kind: 'late', minutes: p.in_flag_minutes });
          if (p.out_flag === 'early_out') flags.push({ kind: 'early_out', minutes: p.out_flag_minutes });
        }
      } else if (pto.some((x) => x.user_id === u.id)) status = 'pto';
      else if (!shift || shift.off) status = 'off';
      else if (nowMin >= hmToMin(shift.end_time)) status = 'missing';
      else if (nowMin > hmToMin(shift.start_time) + settings.late_grace_minutes) {
        status = 'late';
        flags.push({ kind: 'late', minutes: nowMin - hmToMin(shift.start_time) });
      } else status = 'expected';
      if (settings.ot_weekly) {
        if (weekMin > settings.ot_weekly_minutes) flags.push({ kind: 'overtime', minutes: weekMin - settings.ot_weekly_minutes });
        else if (open && weekMin >= settings.ot_weekly_minutes - 60) flags.push({ kind: 'near_overtime', minutes: settings.ot_weekly_minutes - weekMin });
      }
      if (settings.ot_daily && todayMin > settings.ot_daily_minutes) flags.push({ kind: 'daily_overtime', minutes: todayMin - settings.ot_daily_minutes });
      rows.push({ user_id: u.id, name: u.name, role: u.role, status, since, shift, today_minutes: todayMin, week_minutes: weekMin, flags, punch_id: open?.id ?? null });
    }
    const order = { late: 0, missing: 1, in: 2, break: 3, lunch: 3, expected: 4, out: 5, pto: 6, off: 7 };
    rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const count = (s) => rows.filter((x) => s.includes(x.status)).length;
    res.json({ now: nowLocal, today, people: rows, counts: { in: count(['in']), on_break: count(['break', 'lunch']), late: count(['late']), missing: count(['missing']), expected: count(['expected']), out: count(['out']), off: count(['off', 'pto']), overtime: rows.filter((x) => x.flags.some((f) => f.kind === 'overtime' || f.kind === 'near_overtime')).length } });
  });

  // ---------------- Schedules ----------------
  r.get('/timeclock/schedule', async (req, res) => {
    const { settings } = await practiceRules(db, req.user.practice_id);
    const start = weekStart(reqDate(req.query.week, 'week'), settings.week_start_day);
    const days = dateRange(start, addDays(start, 6));
    const staff = (await staffList(db, req.user.practice_id)).filter((u) => u.active && u.on_clock !== 0);
    const shifts = await shiftsFor(db, req.user.practice_id, days[0], days[6]);
    const templates = await db.all('SELECT * FROM staff_shift_templates WHERE practice_id = ? AND active = 1', req.user.practice_id);
    const locations = await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    res.json({
      week_start: start, days, manager: manager(req), locations,
      people: staff.map((u) => {
        const byDay = Object.fromEntries(days.map((d) => [d, shifts.get(`${u.id}:${d}`) || null]));
        return {
          user_id: u.id, name: u.name, role: u.role, days: byDay,
          template: Object.fromEntries(templates.filter((t) => t.user_id === u.id).map((t) => [t.weekday, { start_time: t.start_time, end_time: t.end_time, break_minutes: t.break_minutes, location_id: t.location_id }])),
          scheduled_minutes: Object.values(byDay).reduce((t, s) => t + (s && !s.off ? Math.max(0, hmToMin(s.end_time) - hmToMin(s.start_time) - (s.break_minutes || 0)) : 0), 0),
        };
      }),
    });
  });

  const shiftBody = async (req, b) => {
    if (b.off || b.clear) return {};
    const start = reqHm(b.start_time, 'start_time');
    const end = reqHm(b.end_time, 'end_time');
    if (hmToMin(end) <= hmToMin(start)) throw new HttpError(400, 'The shift must end after it starts');
    const brk = b.break_minutes == null || b.break_minutes === '' ? 0 : minutesInt(b.break_minutes, 'break_minutes', { max: 240 });
    if (brk >= hmToMin(end) - hmToMin(start)) throw new HttpError(400, 'The break is longer than the shift');
    const location_id = b.location_id ? (await findOr404(db, 'locations', asId(b.location_id, 'location_id'), req.user.practice_id, 'Office')).id : null;
    return { start_time: start, end_time: end, break_minutes: brk, location_id };
  };

  // One day for one person: a shift, a day off, or back to their usual week (clear).
  r.put('/timeclock/shifts', async (req, res) => {
    needManager(req);
    const b = req.body || {};
    const user = await findOr404(db, 'users', asId(b.user_id, 'user_id'), req.user.practice_id, 'Person');
    const date = reqDate(b.date, 'date');
    const body = await shiftBody(req, b);
    const status = b.clear ? 'cleared' : b.off ? 'off' : 'scheduled';
    const id = await upsertShift(db, req.user.practice_id, user.id, date, { status, start_time: body.start_time ?? null, end_time: body.end_time ?? null, break_minutes: body.break_minutes ?? 0, location_id: body.location_id ?? null, note: clean(b.note), source: 'manual', updated_by: req.user.id });
    await audit(db, req, 'timeclock.shift', 'staff_shifts', id, { user_id: user.id, date, status, ...body });
    res.json((await shiftsFor(db, req.user.practice_id, date, date, [user.id])).get(`${user.id}:${date}`) || null);
  });

  // The usual week: one shift per weekday (0 = Sunday), or off.
  r.put('/timeclock/templates', async (req, res) => {
    needManager(req);
    const b = req.body || {};
    const user = await findOr404(db, 'users', asId(b.user_id, 'user_id'), req.user.practice_id, 'Person');
    const wd = Number(b.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new HttpError(400, 'weekday must be 0 (Sunday) to 6 (Saturday)');
    const body = await shiftBody(req, b);
    const id = await upsertTemplate(db, req.user.practice_id, user.id, wd, b.off || b.clear ? { active: 0 } : { ...body, active: 1 }, req.user.id);
    await audit(db, req, 'timeclock.template', 'staff_shift_templates', id, { user_id: user.id, weekday: wd, off: !!(b.off || b.clear), ...body });
    res.json({ ok: true, id });
  });

  // Copy one week's shifts onto another (days already set by hand in the target week are left alone).
  r.post('/timeclock/schedule/copy', async (req, res) => {
    needManager(req);
    const { settings } = await practiceRules(db, req.user.practice_id);
    const from = weekStart(reqDate(req.body?.from_week, 'from_week'), settings.week_start_day);
    const to = weekStart(reqDate(req.body?.to_week, 'to_week'), settings.week_start_day);
    if (from === to) throw new HttpError(400, 'Pick a different week to copy to');
    const shift = daysBetween(from, to);
    const source = await shiftsFor(db, req.user.practice_id, from, addDays(from, 6));
    const existing = await db.all("SELECT user_id, date FROM staff_shifts WHERE practice_id = ? AND date >= ? AND date <= ? AND status <> 'cleared'", req.user.practice_id, to, addDays(to, 6));
    const taken = new Set(existing.map((x) => `${x.user_id}:${x.date}`));
    const active = new Set((await staffList(db, req.user.practice_id)).filter((u) => u.active).map((u) => u.id));
    let copied = 0;
    let skipped = 0;
    for (const [key, s] of source) {
      const [uid, date] = key.split(':');
      const target = addDays(date, shift);
      if (!active.has(Number(uid))) continue;
      if (taken.has(`${uid}:${target}`)) { skipped++; continue; }
      await upsertShift(db, req.user.practice_id, Number(uid), target, { status: s.off ? 'off' : 'scheduled', start_time: s.start_time ?? null, end_time: s.end_time ?? null, break_minutes: s.break_minutes || 0, location_id: s.location_id ?? null, source: 'copy', updated_by: req.user.id });
      copied++;
    }
    await audit(db, req, 'timeclock.schedule_copy', 'practices', req.user.practice_id, { from_week: from, to_week: to, copied, skipped });
    res.json({ copied, skipped });
  });

  // Make one person's (or everyone's) week the usual week.
  r.post('/timeclock/templates/from-week', async (req, res) => {
    needManager(req);
    const { settings } = await practiceRules(db, req.user.practice_id);
    const from = weekStart(reqDate(req.body?.week, 'week'), settings.week_start_day);
    const only = req.body?.user_id ? (await findOr404(db, 'users', asId(req.body.user_id, 'user_id'), req.user.practice_id, 'Person')).id : null;
    const shifts = await shiftsFor(db, req.user.practice_id, from, addDays(from, 6), only ? [only] : null);
    const people = only ? [only] : (await staffList(db, req.user.practice_id)).filter((u) => u.active && u.on_clock !== 0).map((u) => u.id);
    let saved = 0;
    for (const uid of people) for (const d of dateRange(from, addDays(from, 6))) {
      const s = shifts.get(`${uid}:${d}`);
      await upsertTemplate(db, req.user.practice_id, uid, weekday(d), s && !s.off ? { start_time: s.start_time, end_time: s.end_time, break_minutes: s.break_minutes || 0, location_id: s.location_id ?? null, active: 1 } : { active: 0 }, req.user.id);
      saved++;
    }
    await audit(db, req, 'timeclock.template_from_week', 'practices', req.user.practice_id, { week: from, user_id: only });
    res.json({ saved });
  });

  // ---------------- Settings, staff pay settings, tablets ----------------
  r.get('/timeclock/settings', async (req, res) => {
    const { settings, tz } = await practiceRules(db, req.user.practice_id);
    res.json({ ...settings, timezone: tz, current_period: periodFor((utcToLocal(tz, nowMs(req))).slice(0, 10), settings) });
  });
  r.put('/timeclock/settings', async (req, res) => {
    needManager(req);
    const b = req.body || {};
    const row = {};
    const mins = (k, max) => { if (b[k] !== undefined) row[k] = minutesInt(b[k], k, { max }); };
    mins('early_in_minutes', 240); mins('late_grace_minutes', 120); mins('early_out_minutes', 240); mins('late_out_minutes', 240); mins('paid_break_max_minutes', 60);
    mins('ot_weekly_minutes', 168 * 60); mins('ot_daily_minutes', 1440); mins('dt_daily_minutes', 1440); mins('pto_fixed_minutes', 100 * 60); mins('pto_cap_minutes', 1000 * 60);
    for (const k of ['block_unscheduled', 'ot_weekly', 'ot_daily', 'dt_daily', 'seventh_day']) if (b[k] !== undefined) row[k] = b[k] ? 1 : 0;
    if (b.outside_window !== undefined) {
      if (!['flag', 'block'].includes(b.outside_window)) throw new HttpError(400, 'outside_window must be flag or block');
      row.outside_window = b.outside_window;
    }
    if (b.pay_period !== undefined) {
      if (!PERIOD_TYPES.includes(b.pay_period)) throw new HttpError(400, `pay_period must be one of: ${PERIOD_TYPES.join(', ')}`);
      row.pay_period = b.pay_period;
    }
    if (b.period_anchor !== undefined) row.period_anchor = b.period_anchor ? reqDate(b.period_anchor, 'period_anchor') : null;
    if (b.week_start_day !== undefined) {
      const n = Number(b.week_start_day);
      if (!Number.isInteger(n) || n < 0 || n > 6) throw new HttpError(400, 'week_start_day must be 0 (Sunday) to 6 (Saturday)');
      row.week_start_day = n;
    }
    if (b.rounding !== undefined) {
      if (!ROUNDING.includes(Number(b.rounding))) throw new HttpError(400, 'rounding must be 0 (none), 5, 6 or 15 minutes');
      row.rounding = Number(b.rounding);
    }
    if (b.pto_mode !== undefined) {
      if (!['none', 'per_hour', 'fixed'].includes(b.pto_mode)) throw new HttpError(400, 'pto_mode must be none, per_hour or fixed');
      row.pto_mode = b.pto_mode;
    }
    if (b.pto_per_hour !== undefined) {
      const n = Number(b.pto_per_hour);
      if (!Number.isFinite(n) || n < 0 || n > 30) throw new HttpError(400, 'pto_per_hour is minutes of time off earned per hour worked (0–30)');
      row.pto_per_hour = n;
    }
    for (const k of ['adp_company_code', 'paychex_client_id']) if (b[k] !== undefined) row[k] = clean(b[k], 20);
    const merged = { ...(await practiceRules(db, req.user.practice_id)).settings, ...row };
    if (merged.dt_daily && merged.ot_daily && merged.dt_daily_minutes <= merged.ot_daily_minutes) throw new HttpError(400, 'Double time must start after daily overtime');
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const existing = await db.get('SELECT id FROM timeclock_settings WHERE practice_id = ?', req.user.practice_id);
    const stamp = { updated_by: req.user.id, updated_at: new Date().toISOString() };
    let id = existing?.id;
    // update() records before → after; the first save records what was set.
    if (id) await update(db, 'timeclock_settings', id, req.user.practice_id, { ...row, ...stamp });
    else id = await insert(db, 'timeclock_settings', { practice_id: req.user.practice_id, ...row, ...stamp });
    await audit(db, req, 'timeclock.settings', 'timeclock_settings', id, null, existing ? {} : { after: row });
    res.json((await practiceRules(db, req.user.practice_id)).settings);
  });

  r.get('/timeclock/staff', async (req, res) => {
    needManager(req);
    const rates = ratesOk(req);
    const list = await staffList(db, req.user.practice_id);
    res.json(list.map((u) => ({
      user_id: u.id, name: u.name, role: u.role, active: u.active, on_clock: u.on_clock ?? 1, payroll_id: u.payroll_id, pay_type: u.pay_type || 'hourly',
      overtime_exempt: u.overtime_exempt || 0, pto_eligible: u.pto_eligible ?? 1, holiday_eligible: u.holiday_eligible ?? 1, has_pin: !!u.has_pin,
      pin_locked: !!(u.pin_locked_until && u.pin_locked_until > new Date(nowMs(req)).toISOString()),
      ...(rates ? { hourly_rate_cents: u.hourly_rate_cents ?? null } : {}),
    })));
  });
  r.put('/timeclock/staff/:uid', async (req, res) => {
    needManager(req);
    const user = await findOr404(db, 'users', asId(req.params.uid), req.user.practice_id, 'Person');
    const b = req.body || {};
    const row = {};
    for (const k of ['on_clock', 'overtime_exempt', 'pto_eligible', 'holiday_eligible']) if (b[k] !== undefined) row[k] = b[k] ? 1 : 0;
    if (b.payroll_id !== undefined) {
      const v = clean(b.payroll_id, 40);
      if (v && !/^[A-Za-z0-9._-]+$/.test(v)) throw new HttpError(400, 'A payroll id is letters, numbers, dots, dashes or underscores');
      if (v && await db.get('SELECT id FROM timeclock_staff WHERE practice_id = ? AND payroll_id = ? AND user_id <> ?', req.user.practice_id, v, user.id)) throw new HttpError(409, 'Someone else already has that payroll id');
      row.payroll_id = v;
    }
    if (b.pay_type !== undefined) {
      if (!['hourly', 'salary'].includes(b.pay_type)) throw new HttpError(400, 'pay_type must be hourly or salary');
      row.pay_type = b.pay_type;
    }
    if (b.hourly_rate_cents !== undefined) {
      if (!ratesOk(req)) throw new HttpError(403, 'Missing permission: timeclock:rates');
      if (b.hourly_rate_cents === null || b.hourly_rate_cents === '') row.hourly_rate_cents = null;
      else {
        const n = Number(b.hourly_rate_cents);
        if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new HttpError(400, 'hourly_rate_cents must be whole cents up to $1,000 an hour');
        row.hourly_rate_cents = n;
      }
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const id = await saveStaff(db, req.user.practice_id, user.id, row, req.user.id);
    await audit(db, req, row.hourly_rate_cents !== undefined ? 'timeclock.rate' : 'timeclock.staff', 'timeclock_staff', id, { user_id: user.id }, { reason: clean(b.reason ?? b.change_reason, REASON_MAX) });
    res.json({ ok: true });
  });
  r.post('/timeclock/staff/:uid/pin-reset', async (req, res) => {
    needManager(req);
    const user = await findOr404(db, 'users', asId(req.params.uid), req.user.practice_id, 'Person');
    const id = await saveStaff(db, req.user.practice_id, user.id, { pin_hash: null, pin_set_at: null, pin_failures: 0, pin_locked_until: null }, req.user.id);
    await audit(db, req, 'timeclock.pin_reset', 'timeclock_staff', id, { user_id: user.id });
    res.json({ ok: true });
  });

  r.get('/timeclock/kiosks', async (req, res) => {
    needManager(req);
    res.json(await db.all('SELECT k.id, k.name, k.location_id, k.created_at, k.last_seen_at, k.revoked_at, u.name AS created_by_name FROM timeclock_kiosks k LEFT JOIN users u ON u.id = k.created_by WHERE k.practice_id = ? ORDER BY k.id DESC', req.user.practice_id));
  });
  // Turns a browser into the office's shared time clock. The token is shown once; only its hash is kept.
  r.post('/timeclock/kiosks', async (req, res) => {
    needManager(req);
    const name = clean(req.body?.name, 60) || 'Front desk tablet';
    const location_id = req.body?.location_id ? (await findOr404(db, 'locations', asId(req.body.location_id, 'location_id'), req.user.practice_id, 'Office')).id : req.location_id ?? null;
    const { token, hash } = newToken();
    const id = await insert(db, 'timeclock_kiosks', { practice_id: req.user.practice_id, location_id, name, token_hash: hash, created_by: req.user.id });
    await audit(db, req, 'timeclock.kiosk_create', 'timeclock_kiosks', id, { name, location_id });
    res.status(201).json({ id, name, location_id, token });
  });
  r.post('/timeclock/kiosks/:kid/revoke', async (req, res) => {
    needManager(req);
    const k = await findOr404(db, 'timeclock_kiosks', asId(req.params.kid), req.user.practice_id, 'Tablet');
    if (!k.revoked_at) await recorded(db, 'timeclock_kiosks', k.id, () => db.run('UPDATE timeclock_kiosks SET revoked_at = ?, revoked_by = ? WHERE id = ?', new Date().toISOString(), req.user.id, k.id));
    await audit(db, req, 'timeclock.kiosk_revoke', 'timeclock_kiosks', k.id, { name: k.name });
    res.json({ ok: true });
  });

  // ---------------- Holidays ----------------
  r.get('/timeclock/holidays', async (req, res) => {
    const year = Number(req.query.year) || Number(utcToLocal('UTC', nowMs(req)).slice(0, 4));
    res.json(await db.all('SELECT * FROM timeclock_holidays WHERE practice_id = ? AND date >= ? AND date <= ? ORDER BY date', req.user.practice_id, `${year}-01-01`, `${year}-12-31`));
  });
  const addHoliday = async (req, date, name, minutes) => {
    await assertNoApprovalCovering(db, req.user.practice_id, date);
    try {
      const id = await insert(db, 'timeclock_holidays', { practice_id: req.user.practice_id, date, name, paid_minutes: minutes, created_by: req.user.id });
      await audit(db, req, 'timeclock.holiday_add', 'timeclock_holidays', id, { date, name, paid_minutes: minutes });
      return id;
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  };
  r.post('/timeclock/holidays', async (req, res) => {
    needManager(req);
    const date = reqDate(req.body?.date, 'date');
    const name = clean(req.body?.name, 80);
    if (!name) throw new HttpError(400, 'Name the holiday');
    const minutes = req.body?.hours == null ? 480 : hoursToMinutes(req.body.hours, 'hours', { max: 24 });
    const id = await addHoliday(req, date, name, minutes);
    if (!id) throw new HttpError(409, 'There’s already a holiday on that day');
    res.status(201).json(await db.get('SELECT * FROM timeclock_holidays WHERE id = ?', id));
  });
  r.post('/timeclock/holidays/us', async (req, res) => {
    needManager(req);
    const year = Number(req.body?.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'year must be a year like 2027');
    let added = 0;
    for (const h of usHolidays(year)) {
      const covered = await db.get("SELECT id FROM pay_period_approvals WHERE practice_id = ? AND status = 'approved' AND period_start <= ? AND period_end >= ?", req.user.practice_id, h.date, h.date);
      if (!covered && await addHoliday(req, h.date, h.name, 480)) added++;
    }
    res.json({ added });
  });
  // Configuration: a holiday can be taken off the list (audited), but not once hours covering it are approved.
  r.delete('/timeclock/holidays/:hid', async (req, res) => {
    needManager(req);
    const h = await findOr404(db, 'timeclock_holidays', asId(req.params.hid), req.user.practice_id, 'Holiday');
    await assertNoApprovalCovering(db, req.user.practice_id, h.date);
    await db.run('DELETE FROM timeclock_holidays WHERE id = ? AND practice_id = ?', h.id, req.user.practice_id);
    await audit(db, req, 'timeclock.holiday_remove', 'timeclock_holidays', h.id, { date: h.date, name: h.name }, { before: { date: h.date, name: h.name, paid_minutes: h.paid_minutes } });
    res.json({ ok: true });
  });

  // ---------------- Paid time off ----------------
  r.get('/timeclock/pto', async (req, res) => {
    const all = manager(req);
    const status = req.query.status && ['pending', 'approved', 'denied', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const requests = await db.all(
      `SELECT q.*, u.name AS user_name, d.name AS decided_by_name FROM pto_requests q JOIN users u ON u.id = q.user_id LEFT JOIN users d ON d.id = q.decided_by
       WHERE q.practice_id = ?${all ? '' : ' AND q.user_id = ?'}${status ? ' AND q.status = ?' : ''} ORDER BY CASE WHEN q.status = 'pending' THEN 0 ELSE 1 END, q.start_date DESC LIMIT 300`,
      req.user.practice_id, ...(all ? [] : [req.user.id]), ...(status ? [status] : []),
    );
    const balances = await db.all(
      `SELECT l.user_id, u.name, SUM(l.minutes) AS minutes FROM pto_ledger l JOIN users u ON u.id = l.user_id
       WHERE l.practice_id = ? AND l.voided_at IS NULL${all ? '' : ' AND l.user_id = ?'} GROUP BY l.user_id, u.name ORDER BY u.name`,
      req.user.practice_id, ...(all ? [] : [req.user.id]),
    );
    res.json({ requests, balances, my_balance: await ptoBalance(db, req.user.id), manager: all });
  });
  r.get('/timeclock/pto/ledger', async (req, res) => {
    const uid = req.query.user_id ? asId(req.query.user_id, 'user_id') : req.user.id;
    if (uid !== req.user.id) needManager(req);
    res.json(await db.all('SELECT l.*, u.name AS created_by_name FROM pto_ledger l LEFT JOIN users u ON u.id = l.created_by WHERE l.practice_id = ? AND l.user_id = ? ORDER BY l.entry_date DESC, l.id DESC LIMIT 500', req.user.practice_id, uid));
  });
  r.post('/timeclock/pto', async (req, res) => {
    const b = req.body || {};
    let userId = req.user.id;
    if (b.user_id && Number(b.user_id) !== req.user.id) {
      needManager(req);
      userId = (await findOr404(db, 'users', asId(b.user_id, 'user_id'), req.user.practice_id, 'Person')).id;
    }
    const start = reqDate(b.start_date, 'start_date');
    const end = reqDate(b.end_date || b.start_date, 'end_date');
    if (end < start) throw new HttpError(400, 'The last day must be on or after the first');
    if (daysBetween(start, end) > 30) throw new HttpError(400, 'Ask for at most 31 days at a time');
    const perDay = b.minutes_per_day != null ? minutesInt(b.minutes_per_day, 'minutes_per_day', { min: 15, max: 1440 }) : hoursToMinutes(b.hours_per_day ?? 8, 'hours_per_day', { min: 0.25, max: 24 });
    const kind = b.kind || 'pto';
    if (!['pto', 'unpaid'].includes(kind)) throw new HttpError(400, 'kind must be pto or unpaid');
    const clash = await db.get("SELECT id FROM pto_requests WHERE user_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?", userId, end, start);
    if (clash) throw new HttpError(409, 'There’s already a time-off request covering some of those days');
    await assertUnlocked(db, req.user.practice_id, userId, [start, end]);
    const days = dateRange(start, end).length;
    const id = await insert(db, 'pto_requests', { practice_id: req.user.practice_id, user_id: userId, kind, start_date: start, end_date: end, minutes_per_day: perDay, total_minutes: perDay * days, note: clean(b.note, 300), status: 'pending', created_by: req.user.id });
    await audit(db, req, 'timeclock.pto_request', 'pto_requests', id, { user_id: userId, start_date: start, end_date: end, minutes_per_day: perDay, kind });
    res.status(201).json(await db.get('SELECT * FROM pto_requests WHERE id = ?', id));
  });
  r.post('/timeclock/pto/:qid/decide', async (req, res) => {
    needManager(req);
    const q = await findOr404(db, 'pto_requests', asId(req.params.qid), req.user.practice_id, 'Request');
    if (q.status !== 'pending') throw new HttpError(409, `This request is already ${q.status}`);
    if (q.user_id === req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Someone else needs to approve your own time off');
    const approve = req.body?.approve === true || req.body?.decision === 'approve';
    const note = clean(req.body?.note, 300);
    if (!approve && !note) throw new HttpError(400, 'Say why the request is declined — the person will see it');
    await assertUnlocked(db, req.user.practice_id, q.user_id, [q.start_date, q.end_date]);
    let warning = null;
    await db.tx(async () => {
      const n = (await db.run("UPDATE pto_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'", approve ? 'approved' : 'denied', req.user.id, new Date().toISOString(), note, q.id)).changes;
      if (!n) throw new HttpError(409, 'This request was just decided');
      if (approve && q.kind === 'pto') {
        const balance = await ptoBalance(db, q.user_id);
        if (balance < q.total_minutes) warning = `This leaves ${(balance - q.total_minutes) / 60} hours — a negative balance.`;
        await insert(db, 'pto_ledger', { practice_id: q.practice_id, user_id: q.user_id, entry_date: q.start_date, minutes: -q.total_minutes, kind: 'used', request_id: q.id, reason: `Time off ${q.start_date}${q.end_date !== q.start_date ? ` to ${q.end_date}` : ''}`, created_by: req.user.id });
      }
    });
    await audit(db, req, approve ? 'timeclock.pto_approve' : 'timeclock.pto_deny', 'pto_requests', q.id, { user_id: q.user_id, total_minutes: q.total_minutes }, { reason: note, before: { status: 'pending' }, after: { status: approve ? 'approved' : 'denied' } });
    res.json({ ...(await db.get('SELECT * FROM pto_requests WHERE id = ?', q.id)), warning });
  });
  r.post('/timeclock/pto/:qid/cancel', async (req, res) => {
    const q = await findOr404(db, 'pto_requests', asId(req.params.qid), req.user.practice_id, 'Request');
    if (!['pending', 'approved'].includes(q.status)) throw new HttpError(409, `This request is already ${q.status}`);
    if (q.status === 'approved' || q.user_id !== req.user.id) needManager(req);
    const reason = q.status === 'approved' ? reasonOf(req.body, 'Say why approved time off is being cancelled') : clean(req.body?.reason, REASON_MAX);
    await assertUnlocked(db, req.user.practice_id, q.user_id, [q.start_date, q.end_date]);
    await db.tx(async () => {
      await recorded(db, 'pto_requests', q.id, () => db.run("UPDATE pto_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?", req.user.id, new Date().toISOString(), reason, q.id));
      // The balance comes back by voiding the "used" entry (never by editing it).
      await db.run("UPDATE pto_ledger SET voided_at = ?, voided_by = ?, void_reason = ? WHERE request_id = ? AND kind = 'used' AND voided_at IS NULL", new Date().toISOString(), req.user.id, reason || 'Request cancelled', q.id);
    });
    await audit(db, req, 'timeclock.pto_cancel', 'pto_requests', q.id, { user_id: q.user_id }, { reason });
    res.json({ ok: true });
  });
  r.post('/timeclock/pto/adjust', async (req, res) => {
    needManager(req);
    const user = await findOr404(db, 'users', asId(req.body?.user_id, 'user_id'), req.user.practice_id, 'Person');
    const minutes = Math.round(Number(req.body?.hours) * 60);
    if (!Number.isFinite(minutes) || minutes === 0 || Math.abs(minutes) > 1000 * 60) throw new HttpError(400, 'hours must be a number of hours to add (or take away, negative)');
    const reason = reasonOf(req.body, 'Say why the balance is changing');
    const id = await insert(db, 'pto_ledger', { practice_id: req.user.practice_id, user_id: user.id, entry_date: utcToLocal('UTC', nowMs(req)).slice(0, 10), minutes, kind: 'adjustment', reason, created_by: req.user.id });
    await audit(db, req, 'timeclock.pto_adjust', 'pto_ledger', id, { user_id: user.id, minutes }, { reason });
    res.status(201).json({ id, balance_minutes: await ptoBalance(db, user.id) });
  });

  // ---------------- Pay periods: review, approve, unlock ----------------
  const periodFrom = async (req, date) => {
    const { settings, tz } = await practiceRules(db, req.user.practice_id);
    const today = utcToLocal(tz, nowMs(req)).slice(0, 10);
    const period = date ? periodFor(reqDate(date, 'date'), settings) : previousPeriod(periodFor(today, settings), settings);
    return { period, settings, tz, today };
  };

  r.get('/timeclock/period', async (req, res) => {
    needManager(req);
    const { period, settings, tz, today } = await periodFrom(req, req.query.date || req.query.start);
    res.json(await periodReview(db, req.user.practice_id, { period, settings, tz, today, nowMs: nowMs(req) }));
  });

  r.post('/timeclock/period/approve', async (req, res) => {
    needManager(req);
    const { period, settings, tz, today } = await periodFrom(req, req.body?.start);
    if (req.body?.start && period.start !== req.body.start) throw new HttpError(400, `${req.body.start} isn’t the first day of a pay period (it’s in ${period.start} to ${period.end})`);
    if (period.end >= today) throw new HttpError(409, `This pay period ends ${period.end} — approve it once it’s over`);
    const review = await periodReview(db, req.user.practice_id, { period, settings, tz, today, nowMs: nowMs(req) });
    const want = Array.isArray(req.body?.user_ids) ? new Set(req.body.user_ids.map((x) => asId(x, 'user_ids'))) : null;
    if (want) for (const id of want) if (!review.people.some((p) => p.user_id === id)) throw new HttpError(404, 'Person not found in this pay period');
    const approved = [];
    const skipped = [];
    for (const p of review.people) {
      if (want && !want.has(p.user_id)) continue;
      if (p.approval) { skipped.push({ user_id: p.user_id, name: p.name, why: 'Already approved' }); continue; }
      if (p.open) { skipped.push({ user_id: p.user_id, name: p.name, why: 'Still clocked in — add the clock-out first' }); continue; }
      if (!want && !p.minutes.total) continue;
      const detail = { minutes: p.minutes, days: p.days };
      try {
        let id;
        await db.tx(async () => {
          id = await insert(db, 'pay_period_approvals', {
            practice_id: req.user.practice_id, user_id: p.user_id, period_start: period.start, period_end: period.end, status: 'approved',
            regular_minutes: p.minutes.regular, overtime_minutes: p.minutes.overtime, doubletime_minutes: p.minutes.doubletime, pto_minutes: p.minutes.pto, holiday_minutes: p.minutes.holiday,
            total_minutes: p.minutes.total, detail: JSON.stringify(detail), detail_hash: detailHash(detail), approved_by: req.user.id, approved_at: new Date().toISOString(),
          });
          // Time off earned for this period (once: a second accrual for the same period is refused by the database).
          if (settings.pto_mode !== 'none' && p.pto_eligible) {
            const earn = ptoAccrual({ mode: settings.pto_mode, per_hour: settings.pto_per_hour, fixed: settings.pto_fixed_minutes, cap: settings.pto_cap_minutes, balance: await ptoBalance(db, p.user_id), workedMinutes: p.minutes.regular + p.minutes.overtime + p.minutes.doubletime });
            if (earn > 0) await insert(db, 'pto_ledger', { practice_id: req.user.practice_id, user_id: p.user_id, entry_date: period.end, minutes: earn, kind: 'accrual', period_start: period.start, reason: `Earned ${period.start} to ${period.end}`, created_by: req.user.id });
          }
        });
        await audit(db, req, 'timeclock.period_approve', 'pay_period_approvals', id, { user_id: p.user_id, period_start: period.start, period_end: period.end, ...p.minutes });
        approved.push({ user_id: p.user_id, name: p.name, id });
      } catch (err) {
        if (!isUnique(err)) throw err;
        skipped.push({ user_id: p.user_id, name: p.name, why: 'Already approved' });
      }
    }
    res.json({ period, approved, skipped });
  });

  r.post('/timeclock/period/unlock', async (req, res) => {
    needManager(req);
    const reason = reasonOf(req.body, 'Say why the approved hours are being reopened');
    const a = req.body?.approval_id
      ? await findOr404(db, 'pay_period_approvals', asId(req.body.approval_id, 'approval_id'), req.user.practice_id, 'Approval')
      : await db.get("SELECT * FROM pay_period_approvals WHERE practice_id = ? AND user_id = ? AND period_start = ? AND status = 'approved'", req.user.practice_id, asId(req.body?.user_id, 'user_id'), reqDate(req.body?.start, 'start'));
    if (!a) throw new HttpError(404, 'Approval not found');
    if (a.status !== 'approved') throw new HttpError(409, 'These hours are already reopened');
    await db.tx(async () => {
      await recorded(db, 'pay_period_approvals', a.id, () => db.run("UPDATE pay_period_approvals SET status = 'unlocked', unlocked_by = ?, unlocked_at = ?, unlock_reason = ? WHERE id = ? AND status = 'approved'", req.user.id, new Date().toISOString(), reason, a.id));
      await db.run("UPDATE pto_ledger SET voided_at = ?, voided_by = ?, void_reason = ? WHERE user_id = ? AND kind = 'accrual' AND period_start = ? AND voided_at IS NULL", new Date().toISOString(), req.user.id, `Pay period reopened: ${reason}`, a.user_id, a.period_start);
    });
    await audit(db, req, 'timeclock.period_unlock', 'pay_period_approvals', a.id, { user_id: a.user_id, period_start: a.period_start }, { reason });
    res.json({ ok: true });
  });

  // ---------------- Payroll export ----------------
  r.get('/timeclock/period/export.csv', async (req, res) => {
    needManager(req);
    const format = String(req.query.format || 'csv');
    if (!EXPORT_FORMATS[format]) throw new HttpError(400, `format must be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
    const { period, settings, tz, today } = await periodFrom(req, req.query.start);
    const review = await periodReview(db, req.user.practice_id, { period, settings, tz, today, nowMs: nowMs(req) });
    const waiting = review.people.filter((p) => !p.approval && p.minutes.total > 0);
    if (waiting.length && req.query.partial !== '1') throw new HttpError(409, `Approve everyone’s hours first — waiting: ${waiting.map((p) => p.name).join(', ')}`, { waiting: waiting.map((p) => p.user_id) });
    const people = review.people.filter((p) => p.approval).map((p) => ({ user_id: p.user_id, name: p.name, payroll_id: p.payroll_id, ...JSON.parse(p.approval.detail) }));
    if (!people.length) throw new HttpError(409, 'No approved hours in this pay period yet');
    const file = buildExport(format, { people, start: period.start, end: period.end, settings });
    const check = reconcile(people, file.lines);
    if (!check.ok) throw new HttpError(500, 'The export didn’t match the approved hours — nothing was downloaded', check);
    const detail = {};
    for (const l of file.lines) detail[l.user_id] = { ...(detail[l.user_id] || {}), [l.type]: ((detail[l.user_id] || {})[l.type] || 0) + l.minutes };
    const id = await insert(db, 'payroll_exports', {
      practice_id: req.user.practice_id, period_start: period.start, period_end: period.end, format, filename: file.filename, content_hash: file.hash,
      people: people.length, total_minutes: check.exported_minutes, detail: JSON.stringify(detail), partial: waiting.length ? 1 : 0, created_by: req.user.id,
    });
    await audit(db, req, 'timeclock.export', 'payroll_exports', id, { format, period_start: period.start, period_end: period.end, people: people.length, total_minutes: check.exported_minutes, content_hash: file.hash });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'X-Export-Id': String(id), 'X-Content-Hash': file.hash }).send(file.csv);
  });
  r.get('/timeclock/exports', async (req, res) => {
    needManager(req);
    const start = req.query.start ? reqDate(req.query.start, 'start') : null;
    res.json(await db.all(
      `SELECT e.id, e.period_start, e.period_end, e.format, e.filename, e.content_hash, e.people, e.total_minutes, e.partial, e.created_at, u.name AS created_by_name
       FROM payroll_exports e LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ?${start ? ' AND e.period_start = ?' : ''} ORDER BY e.id DESC LIMIT 200`,
      req.user.practice_id, ...(start ? [start] : []),
    ));
  });

  // ---------------- Reports ----------------
  r.get('/timeclock/reports', async (req, res) => {
    needManager(req);
    const [from, to] = range(req, 400);
    const { settings, tz } = await practiceRules(db, req.user.practice_id);
    const staff = await staffList(db, req.user.practice_id);
    const people = await computeHours(db, req.user.practice_id, { from, to, tz, settings, nowMs: nowMs(req), staff });
    const locations = new Map((await db.all('SELECT id, name FROM locations WHERE practice_id = ?', req.user.practice_id)).map((l) => [l.id, l.name]));
    const rates = ratesOk(req);
    const rateOf = new Map(staff.map((u) => [u.id, u.hourly_rate_cents]));
    const cost = (uid, m) => {
      const rate = rateOf.get(uid);
      if (rate == null) return null;
      return Math.round(((m.regular || 0) + (m.overtime || 0) * 1.5 + (m.doubletime || 0) * 2 + (m.pto || 0) + (m.holiday || 0)) * rate / 60);
    };
    const personRows = [];
    const offices = new Map();
    const weeks = new Map();
    for (const p of people.values()) {
      const inRange = p.punches.filter((x) => x.date >= from && x.date <= to);
      if (!inRange.length && !p.summary.total) continue;
      const late = inRange.filter((x) => x.in_flag === 'late');
      personRows.push({
        user_id: p.user_id, name: p.name, minutes: pick6(p.summary), punches: inRange.length, late_count: late.length, late_minutes: late.reduce((t, x) => t + (x.in_flag_minutes || 0), 0),
        early_in_count: inRange.filter((x) => x.in_flag === 'early').length, early_out_count: inRange.filter((x) => x.out_flag === 'early_out').length,
        late_out_count: inRange.filter((x) => x.out_flag === 'late_out').length, unscheduled_count: inRange.filter((x) => x.in_flag === 'unscheduled').length,
        corrected_count: inRange.filter((x) => x.corrected).length, ...(rates ? { cost_cents: cost(p.user_id, p.summary) } : {}),
      });
      for (const x of inRange) {
        const o = offices.get(x.location_id ?? 0) || { location_id: x.location_id ?? null, name: locations.get(x.location_id) || 'No office recorded', regular: 0, overtime: 0, doubletime: 0, worked: 0, cost_cents: 0 };
        o.regular += x.regular; o.overtime += x.overtime; o.doubletime += x.doubletime; o.worked += x.minutes || 0;
        if (rates) o.cost_cents += cost(p.user_id, x) || 0;
        offices.set(x.location_id ?? 0, o);
        const w = weekStart(x.date, settings.week_start_day);
        const wr = weeks.get(w) || { week_start: w, regular: 0, overtime: 0, doubletime: 0 };
        wr.regular += x.regular; wr.overtime += x.overtime; wr.doubletime += x.doubletime;
        weeks.set(w, wr);
      }
    }
    personRows.sort((a, b) => a.name.localeCompare(b.name));
    const out = { from, to, people: personRows, offices: [...offices.values()], weeks: [...weeks.values()].sort((a, b) => (a.week_start < b.week_start ? -1 : 1)), rates };
    if (!rates) {
      for (const o of out.offices) delete o.cost_cents;
    } else {
      // Production is the ledger's non-voided charges in the same dates (rule 4: the ledger is the source of truth).
      const prod = await db.all("SELECT location_id, COALESCE(SUM(amount), 0) AS cents FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND voided_at IS NULL AND entry_date >= ? AND entry_date <= ? GROUP BY location_id", req.user.practice_id, from, to);
      const production = prod.reduce((t, x) => t + Number(x.cents), 0);
      const labor = personRows.reduce((t, x) => t + (x.cost_cents || 0), 0);
      for (const o of out.offices) {
        const pc = Number(prod.find((x) => (x.location_id ?? null) === o.location_id)?.cents || 0);
        o.production_cents = pc;
        o.labor_percent = pc > 0 ? Math.round((o.cost_cents / pc) * 1000) / 10 : null;
      }
      out.labor = { cost_cents: labor, production_cents: production, percent: production > 0 ? Math.round((labor / production) * 1000) / 10 : null, missing_rates: personRows.filter((x) => x.cost_cents == null).map((x) => x.name) };
    }
    res.json(out);
  });

  return r;
}

// ---------------- The shared tablet (no staff sign-in; the tablet's own token + each person's PIN) ----------------
// Mounted outside the signed-in API: app.use('/api/kiosk', timeclockKioskRoutes({ db })).
export function timeclockKioskRoutes({ db }) {
  const r = Router();
  const perDevice = rateLimit({ windowMs: 60_000, max: 60, name: 'timeclock-kiosk' });
  const nowMs = (req) => req.app?.locals?.timeclockNow?.() ?? Date.now();
  const kioskOf = async (req) => {
    const token = req.get('X-Kiosk-Token');
    const k = token ? await db.get('SELECT * FROM timeclock_kiosks WHERE token_hash = ? AND revoked_at IS NULL', hashToken(token)) : null;
    if (!k) throw new HttpError(401, 'This tablet isn’t set up as a time clock. A manager can set it up in Time clock → Settings.');
    const seen = new Date(nowMs(req)).toISOString();
    if (!k.last_seen_at || Date.parse(seen) - Date.parse(k.last_seen_at) > 60_000) await db.run('UPDATE timeclock_kiosks SET last_seen_at = ? WHERE id = ?', seen, k.id);
    return k;
  };

  r.get('/timeclock/staff', perDevice, async (req, res) => {
    const k = await kioskOf(req);
    const practice = await db.get('SELECT name, timezone FROM practices WHERE id = ?', k.practice_id);
    const staff = (await staffList(db, k.practice_id)).filter((u) => u.active && u.on_clock !== 0 && u.role !== 'api');
    const opens = await db.all('SELECT o.user_id, o.break_id, b.kind FROM time_open_punches o LEFT JOIN time_breaks b ON b.id = o.break_id WHERE o.practice_id = ?', k.practice_id);
    const state = new Map(opens.map((o) => [o.user_id, o.break_id ? (o.kind === 'lunch' ? 'lunch' : 'break') : 'in']));
    res.json({
      practice: practice?.name, kiosk: k.name, timezone: practice?.timezone || 'America/New_York', now: utcToLocal(practice?.timezone || 'America/New_York', nowMs(req)),
      people: staff.filter((u) => !u.location_ids || !k.location_id || JSON.parse(u.location_ids || '[]').length === 0 || JSON.parse(u.location_ids).includes(k.location_id))
        .map((u) => ({ id: u.id, name: firstLast(u.name), status: state.get(u.id) || 'out', has_pin: !!u.has_pin })),
    });
  });

  r.post('/timeclock/punch', perDevice, async (req, res) => {
    const k = await kioskOf(req);
    const b = req.body || {};
    const action = b.action;
    if (!['in', 'out', 'break_start', 'break_end'].includes(action)) throw new HttpError(400, 'action must be in, out, break_start or break_end');
    const user = await db.get('SELECT id, practice_id, name, role, active FROM users WHERE id = ? AND practice_id = ?', asId(b.user_id, 'user_id'), k.practice_id);
    if (!user || !user.active) throw new HttpError(404, 'Person not found');
    const s = await staffRow(db, user.id);
    if (!s?.pin_hash) throw new HttpError(409, 'Set your time-clock PIN first: sign in and open Time clock → My PIN.');
    const now = nowMs(req);
    if (s.pin_locked_until && Date.parse(s.pin_locked_until) > now) throw new HttpError(429, 'Too many wrong PINs. Wait 15 minutes or ask a manager to reset your PIN.');
    // Security counters (not payroll data): wrong PINs are counted; five in a row lock the PIN for 15 minutes.
    if (!verifyPassword(String(b.pin ?? ''), s.pin_hash)) {
      const fails = (s.pin_failures || 0) + 1;
      const lock = fails >= 5;
      await db.run('UPDATE timeclock_staff SET pin_failures = ?, pin_locked_until = ? WHERE id = ?', lock ? 0 : fails, lock ? new Date(now + 15 * 60_000).toISOString() : s.pin_locked_until, s.id);
      if (lock) {
        req.user = { id: user.id, practice_id: k.practice_id, name: user.name, role: user.role };
        await audit(db, req, 'timeclock.pin_locked', 'users', user.id, { kiosk: k.name });
        throw new HttpError(429, 'Too many wrong PINs. Wait 15 minutes or ask a manager to reset your PIN.');
      }
      throw new HttpError(401, `That PIN didn’t match. ${5 - fails} ${5 - fails === 1 ? 'try' : 'tries'} left.`);
    }
    if (s.pin_failures || s.pin_locked_until) await db.run('UPDATE timeclock_staff SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?', s.id);
    // From here the person is the one acting (on the office tablet), for the audit trail.
    req.user = { id: user.id, practice_id: k.practice_id, name: user.name, role: user.role };
    req.location_id = k.location_id ?? null;
    setActor({ source: 'human', userId: user.id, practiceId: k.practice_id, actor: `${user.name} (time clock tablet: ${k.name})`, locationId: k.location_id ?? null });
    const out = await doPunch(db, { practiceId: k.practice_id, user, action, source: 'kiosk', kioskId: k.id, now, locationId: k.location_id ?? null, device: clean(req.get('user-agent'), 200), ip: req.ip ?? null, kind: b.kind }, req);
    res.status(action === 'in' ? 201 : 200).json({ ...out, name: firstLast(user.name) });
  });
  return r;
}

// ======================= Shared helpers =======================
// practiceRules, staffList, computeHours and shiftsFor are also used by the business view (businessdata.js), so the
// labor there is the same hours, breaks, rounding and overtime as the payroll.

export async function practiceRules(db, practiceId) {
  const p = await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId);
  const row = await db.get('SELECT * FROM timeclock_settings WHERE practice_id = ?', practiceId);
  const settings = { ...DEFAULT_SETTINGS };
  if (row) for (const k of Object.keys(DEFAULT_SETTINGS)) if (row[k] !== undefined && row[k] !== null) settings[k] = row[k];
  if (row && row.period_anchor === null) settings.period_anchor = null;
  settings.pto_per_hour = Number(settings.pto_per_hour) || 0;
  return { tz: p?.timezone || 'America/New_York', settings };
}

const STAFF_SQL = `SELECT u.id, u.name, u.role, u.active, u.location_ids, s.id AS staff_id, s.on_clock, s.payroll_id, s.pay_type, s.overtime_exempt, s.hourly_rate_cents, s.pto_eligible,
  s.holiday_eligible, s.pin_locked_until, CASE WHEN s.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin FROM users u LEFT JOIN timeclock_staff s ON s.user_id = u.id`;
export const staffList = (db, practiceId) => db.all(`${STAFF_SQL} WHERE u.practice_id = ? ORDER BY u.name`, practiceId);
const staffRow = (db, userId) => db.get('SELECT * FROM timeclock_staff WHERE user_id = ?', userId);

async function saveStaff(db, practiceId, userId, row, by) {
  const existing = await staffRow(db, userId);
  const stamp = { updated_by: by, updated_at: new Date().toISOString() };
  if (existing) {
    await update(db, 'timeclock_staff', existing.id, practiceId, { ...row, ...stamp });
    return existing.id;
  }
  try {
    return await insert(db, 'timeclock_staff', { practice_id: practiceId, user_id: userId, ...row, ...stamp });
  } catch (err) {
    if (!isUnique(err)) throw err;
    const again = await staffRow(db, userId);
    await update(db, 'timeclock_staff', again.id, practiceId, { ...row, ...stamp });
    return again.id;
  }
}

const effIn = (p) => p.eff_in || p.clock_in;
const effOut = (p) => (p.eff_out !== undefined && p.eff_out !== null ? p.eff_out : p.clock_out ?? null);
const punchInMs = (p, tz) => (effIn(p) === p.clock_in && p.clock_in_utc ? Date.parse(p.clock_in_utc) : localToUtc(tz, effIn(p)));
const punchOutMs = (p, tz) => {
  const out = effOut(p);
  if (!out) return null;
  return out === p.clock_out && p.clock_out_utc ? Date.parse(p.clock_out_utc) : localToUtc(tz, out);
};
const breakMinutes = (b, tz, nowMs) => {
  const s = b.start_utc ? Date.parse(b.start_utc) : localToUtc(tz, b.start_at);
  const e = b.end_at ? (b.end_utc ? Date.parse(b.end_utc) : localToUtc(tz, b.end_at)) : nowMs;
  return e == null ? null : Math.max(0, Math.round((e - s) / 60000));
};
async function effBreak(db, p, tz) {
  if (p.eff_break != null) return p.eff_break;
  const settings = (await practiceRules(db, p.practice_id)).settings;
  const breaks = await db.all('SELECT * FROM time_breaks WHERE punch_id = ?', p.id);
  return unpaidBreakMinutes(breaks.map((b) => ({ kind: b.kind, minutes: b.end_at ? breakMinutes(b, tz) : null })), settings.paid_break_max_minutes) + (p.break_minutes || 0);
}

const openPunch = (db, userId) => db.get('SELECT * FROM time_punches WHERE user_id = ? AND deleted_at IS NULL AND COALESCE(eff_out, clock_out) IS NULL ORDER BY id DESC LIMIT 1', userId);
const openBreak = (db, punchId) => db.get('SELECT * FROM time_breaks WHERE punch_id = ? AND end_at IS NULL ORDER BY id DESC LIMIT 1', punchId);
const loadPunch = (db, id, practiceId) => db.get('SELECT t.*, u.name AS user_name FROM time_punches t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.practice_id = ?', id, practiceId);

// What the screens get for a punch: the times that count (clock_in/clock_out) and what was punched (original_*).
function publicPunch(p) {
  const minutes = p.minutes !== undefined ? p.minutes : null;
  return {
    id: p.id, user_id: p.user_id, user_name: p.user_name, date: p.date ?? effIn(p).slice(0, 10), clock_in: p.in_local ?? effIn(p), clock_out: p.out_local !== undefined ? p.out_local : effOut(p),
    original_in: p.clock_in_original ?? p.clock_in, original_out: p.clock_out_original !== undefined ? p.clock_out_original : p.clock_out,
    break_minutes: p.unpaid_break ?? p.eff_break ?? p.break_minutes ?? 0, minutes, regular: p.regular, overtime: p.overtime, doubletime: p.doubletime,
    in_flag: p.in_flag ?? null, in_flag_minutes: p.in_flag_minutes ?? null, out_flag: p.out_flag ?? null, out_flag_minutes: p.out_flag_minutes ?? null,
    corrected: !!p.corrected, source: p.source || null, location_id: p.location_id ?? null, note: p.note ?? null, shift_start: p.shift_start ?? null, shift_end: p.shift_end ?? null,
    edited_by_name: p.edited_by_name ?? null,
  };
}
const pick6 = (s) => ({ regular: s.regular, overtime: s.overtime, doubletime: s.doubletime, pto: s.pto, holiday: s.holiday, worked: s.worked, total: s.total });
const h2 = (m) => Math.round((m / 60) * 100) / 100;
const summaryRow = (p) => ({
  user_id: p.user_id, name: p.name, hours: h2(p.summary.total), worked_hours: h2(p.summary.worked), regular_hours: h2(p.summary.regular), overtime_hours: h2(p.summary.overtime),
  doubletime_hours: h2(p.summary.doubletime), pto_hours: h2(p.summary.pto), holiday_hours: h2(p.summary.holiday), open_punches: p.open, minutes: pick6(p.summary),
});

// Everyone's hours for a range: punches (with corrections, breaks and rounding), classified into regular /
// overtime / double time over whole workweeks, plus approved time off and holidays.
export async function computeHours(db, practiceId, { from, to, userIds = null, tz, settings, nowMs = Date.now(), staff }) {
  if (!tz || !settings) ({ tz, settings } = await practiceRules(db, practiceId));
  staff ??= await staffList(db, practiceId);
  const wFrom = weekStart(from, settings.week_start_day);
  const wTo = addDays(weekStart(to, settings.week_start_day), 6);
  const only = userIds ? ` AND t.user_id IN (${userIds.map(() => '?').join(',')})` : '';
  const rows = await db.all(
    `SELECT t.*, e.name AS edited_by_name FROM time_punches t LEFT JOIN users e ON e.id = t.edited_by
     WHERE t.practice_id = ? AND t.deleted_at IS NULL AND COALESCE(t.eff_in, t.clock_in) >= ? AND COALESCE(t.eff_in, t.clock_in) <= ?${only}`,
    practiceId, `${wFrom} 00:00`, `${wTo} 23:59`, ...(userIds || []),
  );
  const breaks = rows.length ? await db.all(
    `SELECT b.* FROM time_breaks b JOIN time_punches t ON t.id = b.punch_id WHERE t.practice_id = ? AND t.deleted_at IS NULL AND COALESCE(t.eff_in, t.clock_in) >= ? AND COALESCE(t.eff_in, t.clock_in) <= ?${only}`,
    practiceId, `${wFrom} 00:00`, `${wTo} 23:59`, ...(userIds || []),
  ) : [];
  const byPunch = new Map();
  for (const b of breaks) {
    if (!byPunch.has(b.punch_id)) byPunch.set(b.punch_id, []);
    byPunch.get(b.punch_id).push(b);
  }
  const ptoRows = await db.all(`SELECT * FROM pto_requests WHERE practice_id = ? AND status = 'approved' AND kind = 'pto' AND start_date <= ? AND end_date >= ?${userIds ? ` AND user_id IN (${userIds.map(() => '?').join(',')})` : ''}`, practiceId, to, from, ...(userIds || []));
  const holidays = await db.all('SELECT date, name, paid_minutes FROM timeclock_holidays WHERE practice_id = ? AND date >= ? AND date <= ?', practiceId, from, to);
  const people = new Map();
  const staffById = new Map(staff.map((u) => [u.id, u]));
  const person = (uid) => {
    if (!people.has(uid)) {
      const u = staffById.get(uid) || { id: uid, name: 'Unknown' };
      people.set(uid, { user_id: uid, name: u.name, payroll_id: u.payroll_id ?? null, staff: u, raw: [], pto: [], holidays: [], open: 0, running: 0 });
    }
    return people.get(uid);
  };
  for (const u of staff) if (u.active && u.on_clock !== 0 && (!userIds || userIds.includes(u.id))) person(u.id);
  for (const row of rows) {
    const x = person(row.user_id);
    const inMs = punchInMs(row, tz);
    const outMs = punchOutMs(row, tz);
    const bl = (byPunch.get(row.id) || []).map((b) => ({ kind: b.kind, minutes: b.end_at ? breakMinutes(b, tz) : null }));
    const unpaid = row.eff_break != null ? row.eff_break : unpaidBreakMinutes(bl, settings.paid_break_max_minutes) + (row.break_minutes || 0);
    const base = { ...row, clock_in_original: row.clock_in, clock_out_original: row.clock_out, date: effIn(row).slice(0, 10), in_local: effIn(row), out_local: effOut(row), in_ms: inMs, out_ms: outMs, unpaid_break: unpaid };
    if (outMs == null) {
      x.open++;
      // Time so far on an open punch (shown live; paid once it's closed). An open break doesn't count.
      const openB = (byPunch.get(row.id) || []).find((b) => !b.end_at);
      const onBreakNow = openB ? breakMinutes(openB, tz, nowMs) : 0;
      x.running += Math.max(0, Math.round((nowMs - inMs) / 60000) - unpaid - onBreakNow);
      x.raw.push({ ...base, minutes: null });
    } else x.raw.push({ ...base, minutes: workedMinutes({ in_ms: inMs, out_ms: outMs, unpaid_break: unpaid }, settings.rounding) });
  }
  for (const q of ptoRows) person(q.user_id).pto.push(...ptoDays(q, from, to));
  for (const x of people.values()) {
    const u = x.staff;
    // Holiday hours go to hourly staff on the clock who worked or took paid time off in these weeks (so an owner
    // or someone who has left isn't paid for a holiday they had nothing to do with).
    if (u.active && u.on_clock !== 0 && (u.holiday_eligible ?? 1) && (u.pay_type || 'hourly') === 'hourly' && (x.raw.length || x.pto.length)) x.holidays = holidays.map((h) => ({ date: h.date, minutes: h.paid_minutes }));
    const exempt = !!u.overtime_exempt || u.pay_type === 'salary';
    const closed = classifyPunches(x.raw.filter((p) => p.minutes != null), settings, { exempt });
    const open = x.raw.filter((p) => p.minutes == null).map((p) => ({ ...p, regular: 0, overtime: 0, doubletime: 0 }));
    x.all = [...closed, ...open].sort((a, b) => a.in_ms - b.in_ms);
    x.punches = x.all.filter((p) => p.date >= from && p.date <= to);
    x.summary = summarize({ punches: closed, pto: x.pto, holidays: x.holidays, start: from, end: to });
    x.pto_eligible = u.pto_eligible ?? 1;
  }
  return people;
}

async function periodReview(db, practiceId, { period, settings, tz, today, nowMs }) {
  const people = await computeHours(db, practiceId, { from: period.start, to: period.end, tz, settings, nowMs });
  const approvals = await db.all("SELECT a.*, u.name AS approved_by_name FROM pay_period_approvals a LEFT JOIN users u ON u.id = a.approved_by WHERE a.practice_id = ? AND a.period_start = ? AND a.status = 'approved'", practiceId, period.start);
  const history = await db.all("SELECT a.id, a.user_id, a.status, a.approved_at, a.unlocked_at, a.unlock_reason, u.name AS unlocked_by_name FROM pay_period_approvals a LEFT JOIN users u ON u.id = a.unlocked_by WHERE a.practice_id = ? AND a.period_start = ? AND a.status = 'unlocked' ORDER BY a.id", practiceId, period.start);
  const byUser = new Map(approvals.map((a) => [a.user_id, a]));
  // An approved person who has since left still belongs in their period.
  for (const a of approvals) if (!people.has(a.user_id)) {
    const u = await db.get('SELECT id, name FROM users WHERE id = ?', a.user_id);
    people.set(a.user_id, { user_id: a.user_id, name: u?.name || 'Unknown', payroll_id: (await staffRow(db, a.user_id))?.payroll_id ?? null, punches: [], summary: summarize({ start: period.start, end: period.end }), open: 0, pto_eligible: 0 });
  }
  const list = [...people.values()].filter((p) => p.summary.total > 0 || p.punches.length || byUser.has(p.user_id)).map((p) => {
    const a = byUser.get(p.user_id) || null;
    const minutes = pick6(p.summary);
    const days = p.summary.days;
    const flags = {
      late: p.punches.filter((x) => x.in_flag === 'late').length, early: p.punches.filter((x) => x.in_flag === 'early').length,
      early_out: p.punches.filter((x) => x.out_flag === 'early_out').length, late_out: p.punches.filter((x) => x.out_flag === 'late_out').length,
      unscheduled: p.punches.filter((x) => x.in_flag === 'unscheduled').length, corrected: p.punches.filter((x) => x.corrected).length,
    };
    return {
      user_id: p.user_id, name: p.name, payroll_id: p.payroll_id, minutes, days, flags, open: p.open, pto_eligible: p.pto_eligible,
      punches: p.punches.map(publicPunch), ready: !p.open && period.end < today,
      approval: a ? { id: a.id, approved_at: a.approved_at, approved_by_name: a.approved_by_name, total_minutes: a.total_minutes, detail: a.detail, detail_hash: a.detail_hash } : null,
      changed_since_approval: a ? detailHash({ minutes, days }) !== a.detail_hash : false,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totals = { regular: 0, overtime: 0, doubletime: 0, pto: 0, holiday: 0, total: 0 };
  for (const p of list) for (const k of Object.keys(totals)) totals[k] += p.minutes[k];
  const exports = await db.all('SELECT e.id, e.format, e.filename, e.content_hash, e.people, e.total_minutes, e.detail, e.partial, e.created_at, u.name AS created_by_name FROM payroll_exports e LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ? AND e.period_start = ? ORDER BY e.id DESC', practiceId, period.start);
  // Reconciliation: approved hours = the latest export's hours, person by person and pay type by pay type.
  const approvedPeople = list.filter((p) => p.approval).map((p) => ({ user_id: p.user_id, minutes: JSON.parse(p.approval.detail).minutes }));
  let reconciliation = null;
  if (exports.length) {
    const latest = exports[0];
    const lines = Object.entries(JSON.parse(latest.detail || '{}')).flatMap(([uid, byType]) => Object.entries(byType).map(([type, minutes]) => ({ user_id: Number(uid), type, minutes })));
    reconciliation = { export_id: latest.id, format: latest.format, ...reconcile(approvedPeople, lines) };
    reconciliation.differences = reconciliation.differences.map((d) => ({ ...d, name: list.find((p) => p.user_id === d.user_id)?.name || 'Unknown' }));
  }
  return {
    period, prev: previousPeriod(period, settings), next: nextPeriod(period, settings), ended: period.end < today, today, settings: { pay_period: settings.pay_period, rounding: settings.rounding, ot_weekly: settings.ot_weekly, ot_daily: settings.ot_daily, dt_daily: settings.dt_daily, seventh_day: settings.seventh_day },
    people: list, totals, approved_count: list.filter((p) => p.approval).length, waiting_count: list.filter((p) => !p.approval && p.minutes.total > 0).length,
    approved_minutes: approvedPeople.reduce((t, p) => t + p.minutes.total, 0), unlocks: history,
    exports: exports.map(({ detail, ...e }) => e), reconciliation, formats: EXPORT_FORMATS, pay_types: PAY_TYPES,
  };
}

// Effective shifts per `${userId}:${date}`: that date's override (a shift or a day off), else the usual week.
export async function shiftsFor(db, practiceId, from, to, userIds = null) {
  const only = userIds ? ` AND user_id IN (${userIds.map(() => '?').join(',')})` : '';
  const overrides = await db.all(`SELECT * FROM staff_shifts WHERE practice_id = ? AND date >= ? AND date <= ?${only}`, practiceId, from, to, ...(userIds || []));
  const templates = await db.all(`SELECT * FROM staff_shift_templates WHERE practice_id = ? AND active = 1${only}`, practiceId, ...(userIds || []));
  const users = userIds || [...new Set([...overrides.map((o) => o.user_id), ...templates.map((t) => t.user_id)])];
  const map = new Map();
  for (const uid of users) for (const d of dateRange(from, to)) {
    const o = overrides.find((x) => x.user_id === uid && x.date === d && x.status !== 'cleared');
    if (o) {
      map.set(`${uid}:${d}`, o.status === 'off' ? { off: true, source: 'override', id: o.id } : { start_time: o.start_time, end_time: o.end_time, break_minutes: o.break_minutes, location_id: o.location_id, source: 'override', id: o.id, note: o.note });
      continue;
    }
    const t = templates.find((x) => x.user_id === uid && x.weekday === weekday(d));
    if (t) map.set(`${uid}:${d}`, { start_time: t.start_time, end_time: t.end_time, break_minutes: t.break_minutes, location_id: t.location_id, source: 'template' });
  }
  return map;
}
const shiftFor = async (db, practiceId, userId, date) => (await shiftsFor(db, practiceId, date, date, [userId])).get(`${userId}:${date}`) || null;

async function upsertShift(db, practiceId, userId, date, row) {
  const existing = await db.get('SELECT id FROM staff_shifts WHERE user_id = ? AND date = ?', userId, date);
  const stamp = { updated_at: new Date().toISOString() };
  if (existing) {
    await update(db, 'staff_shifts', existing.id, practiceId, { ...row, ...stamp });
    return existing.id;
  }
  try {
    return await insert(db, 'staff_shifts', { practice_id: practiceId, user_id: userId, date, ...row, ...stamp });
  } catch (err) {
    if (!isUnique(err)) throw err;
    const again = await db.get('SELECT id FROM staff_shifts WHERE user_id = ? AND date = ?', userId, date);
    await update(db, 'staff_shifts', again.id, practiceId, { ...row, ...stamp });
    return again.id;
  }
}
async function upsertTemplate(db, practiceId, userId, wd, row, by) {
  const existing = await db.get('SELECT id FROM staff_shift_templates WHERE user_id = ? AND weekday = ?', userId, wd);
  const stamp = { updated_by: by, updated_at: new Date().toISOString() };
  if (existing) {
    await update(db, 'staff_shift_templates', existing.id, practiceId, { ...row, ...stamp });
    return existing.id;
  }
  if (!row.start_time) return null; // nothing to switch off
  try {
    return await insert(db, 'staff_shift_templates', { practice_id: practiceId, user_id: userId, weekday: wd, ...row, ...stamp });
  } catch (err) {
    if (!isUnique(err)) throw err;
    const again = await db.get('SELECT id FROM staff_shift_templates WHERE user_id = ? AND weekday = ?', userId, wd);
    await update(db, 'staff_shift_templates', again.id, practiceId, { ...row, ...stamp });
    return again.id;
  }
}

const ptoBalance = async (db, userId) => Number((await db.get('SELECT COALESCE(SUM(minutes), 0) AS m FROM pto_ledger WHERE user_id = ? AND voided_at IS NULL', userId))?.m || 0);

// Approved hours are locked: nothing inside an approved period changes for that person until it's reopened.
async function assertUnlocked(db, practiceId, userId, dates) {
  const ds = dates.filter(Boolean).sort();
  const a = await db.get("SELECT period_start, period_end FROM pay_period_approvals WHERE practice_id = ? AND user_id = ? AND status = 'approved' AND period_start <= ? AND period_end >= ?", practiceId, userId, ds[ds.length - 1], ds[0]);
  if (a) throw new HttpError(409, `Hours for ${a.period_start} to ${a.period_end} are approved and locked. Reopen them (with a reason) to make changes.`);
}
async function assertNoApprovalCovering(db, practiceId, date) {
  const a = await db.get("SELECT period_start, period_end FROM pay_period_approvals WHERE practice_id = ? AND status = 'approved' AND period_start <= ? AND period_end >= ?", practiceId, date, date);
  if (a) throw new HttpError(409, `Hours for ${a.period_start} to ${a.period_end} are already approved. Reopen them first.`);
}

// A manager-entered span must be real: out after in, at most 24 hours, the break shorter than the time, not in
// the future, and not overlapping the person's other time (that would pay the same hour twice).
async function checkSpan(db, { tz, userId, inL, outL, brk, practiceId, exceptId = null, nowLocal }) {
  if (inL > nowLocal) throw new HttpError(400, 'Clock-in can’t be in the future');
  if (outL) {
    if (outL <= inL) throw new HttpError(400, 'Clock-out must be after clock-in');
    if (outL > nowLocal) throw new HttpError(400, 'Clock-out can’t be in the future');
    const span = Math.round((localToUtc(tz, outL) - localToUtc(tz, inL)) / 60000);
    if (span > 24 * 60) throw new HttpError(400, 'A shift can’t be longer than 24 hours');
    if (brk >= span) throw new HttpError(400, 'The break is longer than the shift');
  }
  await assertUnlocked(db, practiceId, userId, [inL.slice(0, 10), (outL || inL).slice(0, 10)]);
  const end = outL || '9999-12-31 23:59';
  const clash = await db.get(
    `SELECT id FROM time_punches WHERE user_id = ? AND deleted_at IS NULL AND id <> ? AND COALESCE(eff_in, clock_in) < ? AND COALESCE(COALESCE(eff_out, clock_out), '9999-12-31 23:59') > ?`,
    userId, exceptId ?? 0, end, inL,
  );
  if (clash) throw new HttpError(409, 'That time overlaps another punch for this person — correct that one instead');
}

// Clock in / out / break for one person — from their own sign-in or the office tablet. Safe to repeat: a second
// "clock in" while in is refused (and the database holds one open punch per person), a second "clock out" too.
async function doPunch(db, { practiceId, user, action, source, kioskId = null, now, locationId, device, ip, note = null, breakMinutes, kind }, req) {
  const { tz, settings } = await practiceRules(db, practiceId);
  const nowLocal = utcToLocal(tz, now);
  const today = nowLocal.slice(0, 10);
  const nowUtc = iso(now);
  const shift = await shiftFor(db, practiceId, user.id, today);
  const open = await openPunch(db, user.id);
  const who = 'You’re';
  if (action === 'in') {
    if (open) throw new HttpError(409, `${who} already clocked in (since ${fmt12(effIn(open).slice(11, 16))})`, { punch_id: open.id });
    await assertUnlocked(db, practiceId, user.id, [today]);
    const check = clockInCheck(nowLocal, shift, settings);
    if (check.blocked) {
      await audit(db, req, 'timeclock.blocked', 'users', user.id, { flag: check.flag, shift: shift ? `${shift.start_time}-${shift.end_time}` : null, at: nowLocal, source });
      throw new HttpError(409, check.message, { flag: check.flag, opens_at: check.opens_at ?? null });
    }
    let id;
    try {
      await db.tx(async () => {
        id = await insert(db, 'time_punches', {
          practice_id: practiceId, user_id: user.id, location_id: locationId ?? shift?.location_id ?? null, clock_in: nowLocal, clock_in_utc: nowUtc, eff_in: nowLocal,
          break_minutes: 0, note, source, kiosk_id: kioskId, in_device: device, in_ip: ip, in_flag: check.flag, in_flag_minutes: check.minutes || null,
          shift_start: shift && !shift.off ? shift.start_time : null, shift_end: shift && !shift.off ? shift.end_time : null,
        });
        await db.run('INSERT INTO time_open_punches (practice_id, user_id, punch_id) VALUES (?, ?, ?)', practiceId, user.id, id);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `${who} already clocked in`);
      throw err;
    }
    await audit(db, req, 'timeclock.in', 'time_punches', id, { flag: check.flag, minutes: check.minutes || 0, source, kiosk_id: kioskId });
    publish(practiceId, { type: 'timeclock' });
    const flagText = check.flag === 'late' ? ` — ${check.minutes} minutes after your ${fmt12(shift.start_time)} start` : check.flag === 'early' ? ` — ${check.minutes} minutes before your shift (flagged for your manager)` : check.flag === 'unscheduled' ? ' — you’re not on today’s schedule (flagged for your manager)' : '';
    return { action, punch: publicPunch(await loadPunch(db, id, practiceId)), flag: check.flag, shift, message: `Clocked in at ${fmt12(nowLocal.slice(11, 16))}${flagText}` };
  }
  if (!open) throw new HttpError(409, `${who} not clocked in`);
  const lock = await db.get('SELECT * FROM time_open_punches WHERE user_id = ?', user.id);
  if (!lock) {
    // A punch opened before the open-punch marker existed: add its marker (a racing request may add it first).
    try {
      await db.run('INSERT INTO time_open_punches (practice_id, user_id, punch_id) VALUES (?, ?, ?)', practiceId, user.id, open.id);
    } catch (err) {
      if (!isUnique(err)) throw err;
    }
  }
  if (action === 'break_start') {
    const k = kind === 'lunch' ? 'lunch' : 'break';
    let bid;
    await db.tx(async () => {
      bid = await insert(db, 'time_breaks', { practice_id: practiceId, punch_id: open.id, user_id: user.id, kind: k, start_at: nowLocal, start_utc: nowUtc, source });
      const n = (await db.run('UPDATE time_open_punches SET break_id = ? WHERE user_id = ? AND break_id IS NULL', bid, user.id)).changes;
      if (!n) throw new HttpError(409, `${who} already on a break`);
    });
    await audit(db, req, 'timeclock.break_start', 'time_breaks', bid, { punch_id: open.id, kind: k, source });
    publish(practiceId, { type: 'timeclock' });
    return { action, message: `${k === 'lunch' ? 'Lunch' : 'Break'} started at ${fmt12(nowLocal.slice(11, 16))}`, break: { id: bid, kind: k, since: nowLocal } };
  }
  const endBreak = async () => {
    const b = await openBreak(db, open.id);
    if (!b) return null;
    await db.run('UPDATE time_breaks SET end_at = ?, end_utc = ? WHERE id = ? AND end_at IS NULL', nowLocal, nowUtc, b.id);
    await db.run('UPDATE time_open_punches SET break_id = NULL WHERE user_id = ?', user.id);
    return { ...b, minutes: Math.max(0, Math.round((now - Date.parse(b.start_utc || iso(localToUtc(tz, b.start_at)))) / 60000)) };
  };
  if (action === 'break_end') {
    const b = await db.tx(endBreak);
    if (!b) throw new HttpError(409, `${who} not on a break`);
    await audit(db, req, 'timeclock.break_end', 'time_breaks', b.id, { punch_id: open.id, kind: b.kind, minutes: b.minutes, source });
    publish(practiceId, { type: 'timeclock' });
    return { action, message: `Back from ${b.kind === 'lunch' ? 'lunch' : 'break'} (${b.minutes} min)` };
  }
  // Clock out (ends an open break first).
  const inMs = punchInMs(open, tz);
  const manual = breakMinutes == null || breakMinutes === '' ? 0 : Number(breakMinutes);
  if (!Number.isFinite(manual) || manual < 0 || manual > 600 || Math.round(manual) !== manual) throw new HttpError(400, 'break_minutes must be whole minutes (0–600)');
  if (manual > Math.round((now - inMs) / 60000)) throw new HttpError(400, 'The break is longer than the shift');
  const outCheck = clockOutCheck(nowLocal, open.shift_end ? { end_time: open.shift_end } : shift, settings);
  let closed = 0;
  await db.tx(async () => {
    await endBreak();
    closed = (await db.run(
      'UPDATE time_punches SET clock_out = ?, clock_out_utc = ?, eff_out = ?, break_minutes = ?, out_device = ?, out_ip = ?, out_flag = ?, out_flag_minutes = ?, note = COALESCE(?, note) WHERE id = ? AND clock_out IS NULL AND eff_out IS NULL',
      nowLocal, nowUtc, nowLocal, manual, device, ip, outCheck.flag, outCheck.minutes || null, note, open.id,
    )).changes;
    await db.run('DELETE FROM time_open_punches WHERE user_id = ? AND punch_id = ?', user.id, open.id); // scratch marker: this person is no longer clocked in
  });
  if (!closed) throw new HttpError(409, `${who} not clocked in`);
  await audit(db, req, 'timeclock.out', 'time_punches', open.id, { flag: outCheck.flag, minutes: outCheck.minutes || 0, break_minutes: manual, source });
  await resolveIssue(db, practiceId, `timeclock-open:${open.id}`, 'Clocked out');
  publish(practiceId, { type: 'timeclock' });
  const p = await loadPunch(db, open.id, practiceId);
  const worked = Math.max(0, Math.round((now - inMs) / 60000) - (await effBreak(db, p, tz)));
  return { action, punch: publicPunch({ ...p, minutes: worked }), flag: outCheck.flag, worked_minutes: worked, message: `Clocked out at ${fmt12(nowLocal.slice(11, 16))} — ${Math.floor(worked / 60)}h ${String(worked % 60).padStart(2, '0')}m today` };
}
