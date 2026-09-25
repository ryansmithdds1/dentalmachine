// No-show / late-cancel risk for upcoming visits, from the practice's own history (see builtin.js for the model).
//
// What counts: a visit is "missed" when it was a no-show or a late cancellation — cancelled less than the practice's
// late-cancel window (practices.late_cancel_hours, default 24) before it, not by the office (latecancel.js); "kept"
// when the patient came (checked in, in the chair or completed). Earlier cancellations and the office's own don't
// count either way. Cancellations from before cancelled_at was kept (and not found in the change log) use the older
// rule: any cancellation with a reason that isn't the office's.
//
// For a day (or a week) of visits it's a fixed set of queries — the office's rates (cached, predict/index.js), the
// history of that day's patients and their balances — never one query per visit.
import { practiceNow } from '../util.js';
import { cachedStats, getPredictor, forScreen } from './index.js';
import { predictNoShow } from './builtin.js';
import { isLateCancel, lateCancelHours, DEFAULT_LATE_CANCEL_HOURS } from '../latecancel.js';

const DAY = 86400_000;
const HISTORY_YEARS = 5; // for "first visit" and a patient's record; the office's rates use the last two years
const RATE_DAYS = 730;
const CONFIRM_WINDOW_DAYS = 3; // before this, not being confirmed yet is normal and says nothing
const KEPT = ['completed', 'checked_in', 'in_chair'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ymd = (s) => String(s || '').slice(0, 10);
const dayNum = (s) => Math.floor(Date.parse(`${ymd(s)}T00:00:00Z`) / DAY);
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const IN = (a) => a.map(() => '?').join(',');
const chunks = (a, n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function outcomeOf(a, lateHours = DEFAULT_LATE_CANCEL_HOURS) {
  if (KEPT.includes(a.status)) return 'kept';
  if (a.status === 'no_show') return 'missed';
  if (isLateCancel(a, lateHours)) return 'missed';
  return null;
}
export function leadBucket(days) {
  if (days <= 1) return ['short', 'booked on short notice'];
  if (days <= 7) return ['week', 'booked within the week'];
  if (days <= 30) return ['month', 'booked 1–4 weeks ahead'];
  if (days <= 90) return ['quarter', 'booked 1–3 months ahead'];
  return ['far', 'booked more than 3 months ahead'];
}
export function timeOfDay(start) {
  const h = Number(String(start).slice(11, 13));
  return h < 10 ? 'Early morning' : h < 12 ? 'Late morning' : h < 15 ? 'Early afternoon' : 'Late afternoon';
}
const leadDays = (a) => (a.created_at ? Math.max(0, dayNum(a.start_time) - dayNum(a.created_at)) : null);

// The office's rates by group, from resolved visits (rows: all of the office's visits in the lookback, sorted by
// patient then time; `owing`: patients who owe a balance now, or null to leave balance out; `from`/`to`: the
// dates whose visits count toward the rates; `keptEarlier`: patients who came before the first of `rows`).
export function buildNoShowStats(rows, { owing = null, from, to, types = {}, keptEarlier = null, lateHours = DEFAULT_LATE_CANCEL_HOURS }) {
  const blank = () => ({ n: 0, hits: 0 });
  const s = { practice: blank(), weekday: {}, time: {}, lead: {}, type: {}, confirmed: { yes: blank(), no: blank() }, first: blank(), owes: owing ? { yes: blank(), no: blank() } : null, types };
  const bump = (bag, key, missed) => { const b = (bag[key] ??= blank()); b.n++; if (missed) b.hits++; };
  let pid = null;
  let keptBefore = false;
  for (const a of rows) {
    if (a.patient_id !== pid) { pid = a.patient_id; keptBefore = !!keptEarlier?.has(pid); }
    const o = outcomeOf(a, lateHours);
    const d = ymd(a.start_time);
    if (o && d >= from && d < to) {
      const m = o === 'missed';
      bump(s, 'practice', m);
      bump(s.weekday, WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()], m);
      bump(s.time, timeOfDay(a.start_time), m);
      const ld = leadDays(a);
      if (ld != null) bump(s.lead, leadBucket(ld)[0], m);
      if (a.appointment_type_id) bump(s.type, a.appointment_type_id, m);
      bump(s.confirmed, a.confirmed_at ? 'yes' : 'no', m);
      if (!keptBefore) bump(s, 'first', m);
      if (owing) bump(s.owes, owing.has(a.patient_id) ? 'yes' : 'no', m);
    }
    if (o === 'kept') keptBefore = true;
  }
  return s;
}

// A patient's record before `date` (history: their resolved visits, any order), recency-weighted: a visit a year
// before counts half as much as one this week.
export function patientRecord(history, date, lateHours = DEFAULT_LATE_CANCEL_HOURS) {
  const t = dayNum(date);
  const r = { missed_w: 0, kept_w: 0, no_shows_1y: 0, late_cancels_1y: 0, missed_2y: 0, kept_2y: 0, kept_ever: 0 };
  for (const a of history) {
    if (ymd(a.start_time) >= ymd(date)) continue;
    const age = t - dayNum(a.start_time);
    const o = outcomeOf(a, lateHours);
    if (!o) continue;
    const w = 0.5 ** (Math.max(0, age) / 365);
    if (o === 'kept') { r.kept_w += w; r.kept_ever++; if (age <= RATE_DAYS) r.kept_2y++; }
    else {
      r.missed_w += w;
      if (age <= RATE_DAYS) r.missed_2y++;
      if (age <= 365) { if (a.status === 'no_show') r.no_shows_1y++; else r.late_cancels_1y++; }
    }
  }
  r.missed_w = Math.round(r.missed_w * 1000) / 1000;
  r.kept_w = Math.round(r.kept_w * 1000) / 1000;
  return r;
}

// The features of one visit (counts and categories only — no names, birth dates or record ids).
export function visitFeatures(visit, record, stats, { today, owes = null }) {
  const d = ymd(visit.start_time);
  const weekday = WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()];
  const tod = timeOfDay(visit.start_time);
  const ld = leadDays(visit);
  const [lk, llabel] = ld == null ? [null, null] : leadBucket(ld);
  const isConfirmed = !!visit.confirmed_at || visit.status === 'confirmed';
  // Not confirmed yet only means something close to the day.
  const confirmed = isConfirmed ? true : dayNum(d) - dayNum(today) <= CONFIRM_WINDOW_DAYS ? false : null;
  return {
    practice: stats.practice,
    patient: record,
    first_visit: record.kept_ever === 0, first_visit_stats: stats.first,
    days_ahead: Math.max(0, dayNum(d) - dayNum(today)),
    confirmed, confirmed_stats: confirmed == null ? null : stats.confirmed[confirmed ? 'yes' : 'no'],
    lead_days: ld, lead_label: llabel, lead_stats: lk ? stats.lead[lk] : null,
    weekday, weekday_stats: stats.weekday[weekday] || null,
    time_of_day: tod, time_stats: stats.time[tod] || null,
    visit_type: visit.appointment_type_id ? stats.types[visit.appointment_type_id] || null : null,
    type_stats: visit.appointment_type_id ? stats.type[visit.appointment_type_id] || null : null,
    owes: owes == null || !stats.owes ? null : owes, owes_stats: owes == null || !stats.owes ? null : stats.owes[owes ? 'yes' : 'no'],
  };
}

const HIST_COLS = 'id, patient_id, start_time, created_at, status, broken_reason, confirmed_at, cancelled_at, appointment_type_id';

async function owingPatients(db, pid, ids = null) {
  const out = new Set();
  const q = (extra, args) => db.all(`SELECT patient_id FROM ledger_entries WHERE practice_id = ?${extra} GROUP BY patient_id HAVING SUM(amount) > 0`, pid, ...args);
  if (!ids) for (const r of await q('', [])) out.add(r.patient_id);
  else for (const c of chunks(ids)) for (const r of await q(` AND patient_id IN (${IN(c)})`, c)) out.add(r.patient_id);
  return out;
}

// The office's rates as of today (cached a few minutes).
export async function practiceNoShowStats(db, pid, today, lateHours = DEFAULT_LATE_CANCEL_HOURS) {
  // Keyed by the late-cancel window too: changing it in Settings counts visits differently from the next read.
  return cachedStats(`no_show:${pid}:${lateHours}`, today, async () => {
    const from = addDays(today, -RATE_DAYS);
    const rows = await db.all(
      `SELECT ${HIST_COLS} FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND status IN ('completed','checked_in','in_chair','no_show','cancelled') ORDER BY patient_id, start_time`,
      pid, `${from} 00:00`, `${today} 00:00`,
    );
    // Who had already come before those two years (so their visit then wasn't a first visit).
    const keptEarlier = new Set((await db.all(
      "SELECT DISTINCT patient_id FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND status IN ('completed','checked_in','in_chair')",
      pid, `${addDays(today, -365 * HISTORY_YEARS)} 00:00`, `${from} 00:00`,
    )).map((r) => r.patient_id));
    const types = Object.fromEntries((await db.all('SELECT id, name FROM appointment_types WHERE practice_id = ?', pid)).map((t) => [t.id, t.name]));
    return buildNoShowStats(rows, { owing: await owingPatients(db, pid), from, to: today, types, keptEarlier, lateHours });
  });
}

// Risk for each upcoming visit in `appts` (rows with id, patient_id, start_time, created_at, status, confirmed_at,
// appointment_type_id). Past, finished or cancelled visits get none. Returns Map(appointment id → prediction).
export async function noShowRisks(db, pid, appts, { now = null } = {}) {
  const out = new Map();
  now ??= await practiceNow(db, pid);
  const today = ymd(now);
  const todo = appts.filter((a) => ['scheduled', 'confirmed'].includes(a.status) && ymd(a.start_time) >= today);
  if (!todo.length) return out;
  const lateHours = await lateCancelHours(db, pid);
  const stats = await practiceNoShowStats(db, pid, today, lateHours);
  const ids = [...new Set(todo.map((a) => a.patient_id))];
  const hist = new Map(ids.map((id) => [id, []]));
  for (const c of chunks(ids)) {
    for (const r of await db.all(
      // "+practice_id": still only this practice's rows, but lets the database use the patient index (idx_appt_patient)
      // rather than walking five years of the practice's visits.
      `SELECT ${HIST_COLS} FROM appointments WHERE +practice_id = ? AND patient_id IN (${IN(c)}) AND start_time >= ? AND start_time < ? AND status IN ('completed','checked_in','in_chair','no_show','cancelled')`,
      pid, ...c, `${addDays(today, -365 * HISTORY_YEARS)} 00:00`, now,
    )) hist.get(r.patient_id).push(r);
  }
  const owing = await owingPatients(db, pid, ids);
  const features = todo.map((a) => visitFeatures(a, patientRecord(hist.get(a.patient_id), today, lateHours), stats, { today, owes: owing.has(a.patient_id) }));
  const results = await getPredictor().predictMany('no_show', features, { practiceId: pid });
  todo.forEach((a, i) => out.set(a.id, results[i]));
  return out;
}

// Adds `no_show_risk` to schedule rows (in place) and returns them.
export async function withNoShowRisk(db, pid, rows) {
  const risks = await noShowRisks(db, pid, rows);
  for (const a of rows) a.no_show_risk = forScreen(risks.get(a.id)) || null;
  return rows;
}

// ---- How well it does (calibration) ----
// Tested on the last `months` months, out of time: the office's rates are learned only from the two years before
// that window, and each visit's patient record only from their visits before it — as the model would have seen it
// then. The built-in model only (a backtest never goes to an outside vendor). Balance owed then isn't known, so
// it's left out here.
export const BINS = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.6], [0.6, 1.01]];
export function calibrate(pairs) {
  const bins = BINS.map(([lo, hi]) => ({ from: Math.round(lo * 100), to: Math.min(100, Math.round(hi * 100)), n: 0, predicted: 0, actual: 0 }));
  let brier = 0;
  for (const { p, y } of pairs) {
    const b = bins[BINS.findIndex(([lo, hi]) => p >= lo && p < hi)];
    b.n++; b.predicted += p; b.actual += y;
    brier += (p - y) ** 2;
  }
  const n = pairs.length;
  return {
    n,
    predicted_rate: n ? Math.round((pairs.reduce((s, x) => s + x.p, 0) / n) * 1000) / 10 : null,
    actual_rate: n ? Math.round((pairs.reduce((s, x) => s + x.y, 0) / n) * 1000) / 10 : null,
    brier: n ? Math.round((brier / n) * 1000) / 1000 : null,
    bins: bins.map((b) => ({ from: b.from, to: b.to, n: b.n, predicted: b.n ? Math.round((b.predicted / b.n) * 1000) / 10 : null, actual: b.n ? Math.round((b.actual / b.n) * 1000) / 10 : null })),
  };
}

export async function noShowAccuracy(db, pid, { months = 6, today = null } = {}) {
  today ??= ymd(await practiceNow(db, pid));
  const lateHours = await lateCancelHours(db, pid);
  const start = addDays(today, -Math.round(months * 30.44));
  const rows = await db.all(
    `SELECT ${HIST_COLS} FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND status IN ('completed','checked_in','in_chair','no_show','cancelled') ORDER BY patient_id, start_time`,
    pid, `${addDays(start, -365 * HISTORY_YEARS)} 00:00`, `${today} 00:00`,
  );
  const types = Object.fromEntries((await db.all('SELECT id, name FROM appointment_types WHERE practice_id = ?', pid)).map((t) => [t.id, t.name]));
  const stats = buildNoShowStats(rows, { from: addDays(start, -RATE_DAYS), to: start, types, lateHours });
  const pairs = [];
  let from = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i && rows[i].patient_id !== rows[i - 1].patient_id) from = i;
    const a = rows[i];
    const o = outcomeOf(a, lateHours);
    if (!o || ymd(a.start_time) < start) continue;
    // As it looked on the day: confirmed or not, their record before this visit.
    const f = visitFeatures({ ...a, status: 'scheduled' }, patientRecord(rows.slice(from, i), a.start_time, lateHours), stats, { today: ymd(a.start_time) });
    pairs.push({ p: predictNoShow(f).probability, y: o === 'missed' ? 1 : 0 });
  }
  return { kind: 'no_show', months, from: start, to: today, trained_on: stats.practice.n, ...calibrate(pairs) };
}
