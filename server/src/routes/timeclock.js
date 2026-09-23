import { Router } from 'express';
import { HttpError, can } from '../auth.js';
import { insert, findOr404, audit, practiceNow } from '../util.js';

// Time clock. Punches are practice-local wall-clock times ("YYYY-MM-DD HH:MM"). Everyone clocks themselves
// in and out; people with timeclock:manage see everyone's time, fix punches (audited) and export payroll.
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000));
const mondayOf = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};

// Hours per person: total, and overtime past 40 hours in a Monday–Sunday week (federal rule; states may differ).
export function payrollSummary(punches) {
  const people = new Map();
  for (const p of punches) {
    if (!p.clock_out) continue;
    const worked = Math.max(0, minutesBetween(p.clock_in, p.clock_out) - (p.break_minutes || 0));
    if (!people.has(p.user_id)) people.set(p.user_id, { user_id: p.user_id, name: p.user_name, minutes: 0, weeks: new Map(), open: 0 });
    const x = people.get(p.user_id);
    x.minutes += worked;
    const wk = mondayOf(p.clock_in.slice(0, 10));
    x.weeks.set(wk, (x.weeks.get(wk) || 0) + worked);
  }
  for (const p of punches) if (!p.clock_out && people.has(p.user_id)) people.get(p.user_id).open++;
  return [...people.values()].map((x) => {
    const overtime = [...x.weeks.values()].reduce((t, m) => t + Math.max(0, m - 40 * 60), 0);
    return { user_id: x.user_id, name: x.name, hours: Math.round((x.minutes / 60) * 100) / 100, regular_hours: Math.round(((x.minutes - overtime) / 60) * 100) / 100, overtime_hours: Math.round((overtime / 60) * 100) / 100, open_punches: x.open };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export default function timeclockRoutes({ db }) {
  const r = Router();
  const manager = (req) => can(req.user, 'timeclock:manage');
  const open = (userId) => db.get('SELECT * FROM time_punches WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1', userId);

  r.get('/timeclock/me', async (req, res) => {
    const now = (await practiceNow(db, req.user.practice_id)).slice(0, 16);
    const current = await open(req.user.id);
    const week = mondayOf(now.slice(0, 10));
    const punches = await db.all('SELECT * FROM time_punches WHERE user_id = ? AND clock_in >= ? ORDER BY clock_in', req.user.id, `${week} 00:00`);
    const minutes = punches.reduce((t, p) => t + Math.max(0, minutesBetween(p.clock_in, p.clock_out || now) - (p.break_minutes || 0)), 0);
    res.json({ clocked_in: current?.clock_in ?? null, week_hours: Math.round((minutes / 60) * 100) / 100, now });
  });

  r.post('/timeclock/in', async (req, res) => {
    if (await open(req.user.id)) throw new HttpError(409, 'You’re already clocked in');
    const now = (await practiceNow(db, req.user.practice_id)).slice(0, 16);
    const id = await insert(db, 'time_punches', { practice_id: req.user.practice_id, user_id: req.user.id, location_id: req.location_id ?? null, clock_in: now });
    await audit(db, req, 'timeclock.in', 'time_punches', id);
    res.status(201).json(await db.get('SELECT * FROM time_punches WHERE id = ?', id));
  });

  r.post('/timeclock/out', async (req, res) => {
    const p = await open(req.user.id);
    if (!p) throw new HttpError(409, 'You’re not clocked in');
    const now = (await practiceNow(db, req.user.practice_id)).slice(0, 16);
    const brk = Math.max(0, Math.min(600, Math.round(Number(req.body?.break_minutes) || 0)));
    if (brk > minutesBetween(p.clock_in, now)) throw new HttpError(400, 'The break is longer than the shift');
    await db.run('UPDATE time_punches SET clock_out = ?, break_minutes = ?, note = COALESCE(?, note) WHERE id = ?', now, brk, req.body?.note ? String(req.body.note).slice(0, 200) : null, p.id);
    await audit(db, req, 'timeclock.out', 'time_punches', p.id);
    res.json(await db.get('SELECT * FROM time_punches WHERE id = ?', p.id));
  });

  const range = (req) => {
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new HttpError(400, 'from and to are required (YYYY-MM-DD)');
    return [from, to];
  };
  const punchesFor = async (req, from, to) => {
    const who = manager(req) ? (req.query.user_id ? Number(req.query.user_id) : null) : req.user.id;
    return db.all(
      `SELECT t.*, u.name AS user_name, e.name AS edited_by_name FROM time_punches t JOIN users u ON u.id = t.user_id LEFT JOIN users e ON e.id = t.edited_by
       WHERE t.practice_id = ? AND t.clock_in >= ? AND t.clock_in <= ?${who ? ' AND t.user_id = ?' : ''} ORDER BY u.name, t.clock_in`,
      req.user.practice_id, `${from} 00:00`, `${to} 23:59`, ...(who ? [who] : []),
    );
  };

  // Timesheets: your own, or everyone's for a manager.
  r.get('/timeclock', async (req, res) => {
    const [from, to] = range(req);
    const punches = await punchesFor(req, from, to);
    res.json({ from, to, manager: manager(req), punches: punches.map((p) => ({ ...p, minutes: p.clock_out ? Math.max(0, minutesBetween(p.clock_in, p.clock_out) - p.break_minutes) : null })), summary: payrollSummary(punches) });
  });

  // Managers fix a missed or wrong punch; every change is audited with what it was.
  const cleanPunch = (b, existing = {}) => {
    const row = {};
    for (const k of ['clock_in', 'clock_out']) {
      if (b[k] === undefined) continue;
      if (b[k] !== null && !TIME.test(String(b[k]).replace('T', ' ').slice(0, 16))) throw new HttpError(400, `${k} must be YYYY-MM-DD HH:MM`);
      row[k] = b[k] === null ? null : String(b[k]).replace('T', ' ').slice(0, 16);
    }
    if (b.break_minutes !== undefined) row.break_minutes = Math.max(0, Math.min(600, Math.round(Number(b.break_minutes) || 0)));
    if (b.note !== undefined) row.note = String(b.note || '').slice(0, 200) || null;
    const start = row.clock_in ?? existing.clock_in;
    const end = row.clock_out !== undefined ? row.clock_out : existing.clock_out;
    if (!start) throw new HttpError(400, 'clock_in is required');
    if (end && end <= start) throw new HttpError(400, 'Clock-out must be after clock-in');
    if (end && minutesBetween(start, end) > 24 * 60) throw new HttpError(400, 'A shift can’t be longer than 24 hours');
    return row;
  };
  r.post('/timeclock/punches', async (req, res) => {
    if (!manager(req)) throw new HttpError(403, 'Missing permission: timeclock:manage');
    const user = await findOr404(db, 'users', req.body?.user_id, req.user.practice_id, 'User');
    const row = cleanPunch(req.body || {});
    const id = await insert(db, 'time_punches', { ...row, practice_id: req.user.practice_id, user_id: user.id, edited_by: req.user.id, edited_at: new Date().toISOString() });
    await audit(db, req, 'timeclock.add', 'time_punches', id, { user_id: user.id, ...row });
    res.status(201).json(await db.get('SELECT * FROM time_punches WHERE id = ?', id));
  });
  r.put('/timeclock/punches/:tid', async (req, res) => {
    if (!manager(req)) throw new HttpError(403, 'Missing permission: timeclock:manage');
    const p = await findOr404(db, 'time_punches', req.params.tid, req.user.practice_id, 'Punch');
    const row = cleanPunch(req.body || {}, p);
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await db.run(`UPDATE time_punches SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, edited_by = ?, edited_at = ? WHERE id = ?`, ...Object.values(row), req.user.id, new Date().toISOString(), p.id);
    await audit(db, req, 'timeclock.edit', 'time_punches', p.id, { before: { clock_in: p.clock_in, clock_out: p.clock_out, break_minutes: p.break_minutes }, after: row });
    res.json(await db.get('SELECT * FROM time_punches WHERE id = ?', p.id));
  });
  r.delete('/timeclock/punches/:tid', async (req, res) => {
    if (!manager(req)) throw new HttpError(403, 'Missing permission: timeclock:manage');
    const p = await findOr404(db, 'time_punches', req.params.tid, req.user.practice_id, 'Punch');
    await db.run('DELETE FROM time_punches WHERE id = ?', p.id);
    await audit(db, req, 'timeclock.delete', 'time_punches', p.id, { user_id: p.user_id, clock_in: p.clock_in, clock_out: p.clock_out });
    res.json({ ok: true });
  });

  // Payroll export: hours per person (regular and weekly overtime) as CSV for the payroll service.
  r.get('/timeclock/payroll.csv', async (req, res) => {
    if (!manager(req)) throw new HttpError(403, 'Missing permission: timeclock:manage');
    const [from, to] = range(req);
    const rows = payrollSummary(await punchesFor(req, from, to));
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['Employee,Regular hours,Overtime hours,Total hours,Open punches', ...rows.map((x) => [q(x.name), x.regular_hours, x.overtime_hours, x.hours, x.open_punches].join(','))].join('\n');
    await audit(db, req, 'timeclock.export', 'practices', req.user.practice_id, { from, to });
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="payroll-${from}-to-${to}.csv"` }).send(`${csv}\n`);
  });
  return r;
}
