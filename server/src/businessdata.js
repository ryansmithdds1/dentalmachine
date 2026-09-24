// The business view's data (PM1–PM4, BD1–BD4): loads what business.js (pure math) needs and puts the answers
// together for routes/business.js. See docs/business-view.md for what every number means.
//
// Where the inputs come from (nothing here is a second copy of a number another module owns):
//  - fees and the PPO write-off: the procedures' fees and the insurance estimate (benefits.js estimateCoverage) for
//    booked visits; claims (actual write-off / paid) or the fee resolver (feeversions.js resolveFee, by date of
//    service) for completed work in the reports;
//  - scheduled / completed production: production.js scheduleProduction (the schedule's own rule);
//  - production and collections over a period: metrics.js computeMetrics (the ledger);
//  - hours, breaks, rounding and overtime: the time clock's own computeHours / shiftsFor (routes/timeclock.js);
//  - fixed costs: the finance module (financeOverview: QuickBooks, else the categorized bank lines), unless the
//    owner typed their own numbers;
//  - direct costs: the owner's cost profiles and provider pay plans (the tables below), versioned by date.
import { HttpError, can, USER_PERMISSION_SQL, effectivePermissions } from './auth.js';
import { toPostgres } from './db.js';
import { appointmentScope } from './officeaccess.js';
import { estimateCoverage } from './benefits.js';
import { primaryPolicy } from './services.js';
import { coverageTier } from './defaults.js';
import { resolveFee, ensureFeeSchema } from './feeversions.js';
import { scheduleProduction } from './production.js';
import * as metrics from './metrics.js';
import { financeOverview } from './finance/metrics.js';
import { hoursFor } from './hours.js';
import { computeHours, shiftsFor, practiceRules, staffList } from './routes/timeclock.js';
import { utcToLocal, localToUtc, hmToMin, weekStart, addDays, dateRange } from './timeclock.js';
import {
  DEFAULT_SETTINGS, CATEGORIES, CATEGORY_DEFAULTS, TYPICAL_OVERHEAD_PER_CHAIR_HOUR, TYPICAL_FIXED_COSTS_PER_DAY,
  EXAM_TYPE_LABELS, FALLBACK_EXAM_CODES, TYPICAL_EXAM_VALUES, EXAM_HORIZONS, scaleExamValue, countExams, examTargets, examSupport,
  resolveProfile, resolvePay, suggestSupplies, visitMinutes, visitMargin, addUp, thresholdsFor, bandFor, bandValue, allocate,
  laborDay, staffTimeline, suggestionsFor, staffingByHour, staffingAdvice, overtimeRisk, trendRow, whatIfDropPlan, rnd, perHour, pct1, toMin,
} from './business.js';

// ---- Tables (for db.js SCHEMA; kept here too and created on first use until they're pasted there) ----
export const BUSINESS_SCHEMA = `
-- Business view (PM1-PM4, BD1-BD4; business.js, businessdata.js, routes/business.js, docs/business-view.md).
-- The owner's settings: color thresholds, fixed costs, labor target. One row per practice; changes are audited.
CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  basis TEXT NOT NULL DEFAULT 'chair' CHECK (basis IN ('chair','doctor')),
  overhead_mode TEXT NOT NULL DEFAULT 'auto' CHECK (overhead_mode IN ('auto','manual')),
  overhead_per_hour_cents INTEGER,
  fixed_costs_month_cents INTEGER,
  work_days_month INTEGER NOT NULL DEFAULT 18,
  red_below_cents INTEGER,
  green_from_cents INTEGER,
  gold_from_cents INTEGER,
  labor_target_low_bp INTEGER NOT NULL DEFAULT 2500,
  labor_target_high_bp INTEGER NOT NULL DEFAULT 3000,
  patient_collect_bp INTEGER NOT NULL DEFAULT 10000,
  default_merchant_bp INTEGER NOT NULL DEFAULT 250,
  assistants_per_doctor_chair_bp INTEGER NOT NULL DEFAULT 10000,
  idle_gap_minutes INTEGER NOT NULL DEFAULT 20,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Direct costs of a procedure code or a whole category (supplies, lab, card fee, provider pay override). Never
-- edited or deleted: every change is a new version from a date; a version with active = 0 retires the profile.
CREATE TABLE IF NOT EXISTS business_cost_profiles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  scope TEXT NOT NULL CHECK (scope IN ('code','category')),
  scope_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  supplies_cents INTEGER NOT NULL DEFAULT 0,
  lab_mode TEXT NOT NULL DEFAULT 'none' CHECK (lab_mode IN ('none','fixed','case')),
  lab_cents INTEGER NOT NULL DEFAULT 0,
  merchant_bp INTEGER,
  pay_pct_bp INTEGER,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, scope, scope_key, version_no)
);
-- How each provider is paid for their work (associates, hygienists), versioned the same way.
CREATE TABLE IF NOT EXISTS business_provider_pay (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('none','production_pct','collections_pct','hourly')),
  pct_bp INTEGER NOT NULL DEFAULT 0,
  hourly_cents INTEGER,
  lab_deducted INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, provider_id, version_no)
);
-- Who each person on the clock works with, for the staff lanes (doctor / hygienist = their own visits; assistant =
-- their providers' or chairs' visits, or the shared pool; admin = front office). Missing rows are worked out from roles.
CREATE TABLE IF NOT EXISTS business_staff_roles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('doctor','hygienist','assistant','admin')),
  provider_ids TEXT,
  operatory_ids TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The owner's daily exam targets by type (EX1) and their own value per exam (EX2), used when the practice's history
-- can't say yet. Configuration: one row per type, changes audited.
CREATE TABLE IF NOT EXISTS business_exam_targets (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  exam_type TEXT NOT NULL,
  daily_target INTEGER,
  value_cents INTEGER,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, exam_type)
);
CREATE INDEX IF NOT EXISTS idx_business_cost_profiles ON business_cost_profiles(practice_id, scope, scope_key);
CREATE INDEX IF NOT EXISTS idx_business_provider_pay ON business_provider_pay(practice_id, provider_id);
`;

const ensured = new WeakSet();
export async function ensureBusinessSchema(db) {
  if (ensured.has(db)) return;
  const sql = db.dialect === 'postgres' ? toPostgres(BUSINESS_SCHEMA).replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY') : BUSINESS_SCHEMA;
  // Comments first (they may hold a ';'), then one statement at a time.
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter(Boolean);
  for (const s of statements) await db.run(s);
  ensured.add(db);
}
// Postgres returns no id unless asked; SQLite supports RETURNING too.
export const insertId = async (db, sql, ...params) => (await db.get(`${sql} RETURNING id`, ...params)).id;

const LIVE = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed'];
const parseIds = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
};

// ---- Settings, costs and pay ----
export async function loadSettings(db, pid) {
  await ensureBusinessSchema(db);
  const row = await db.get('SELECT * FROM business_settings WHERE practice_id = ?', pid);
  const s = { ...DEFAULT_SETTINGS };
  if (row) for (const k of Object.keys(DEFAULT_SETTINGS)) if (row[k] !== undefined) s[k] = row[k];
  return { ...s, id: row?.id ?? null, updated_at: row?.updated_at ?? null };
}
export async function loadCosts(db, pid) {
  await ensureBusinessSchema(db);
  const profiles = await db.all('SELECT * FROM business_cost_profiles WHERE practice_id = ? ORDER BY scope, scope_key, version_no', pid);
  const pay = await db.all('SELECT * FROM business_provider_pay WHERE practice_id = ? ORDER BY provider_id, version_no', pid);
  const rates = new Map((await db.all(
    'SELECT pv.id, s.hourly_rate_cents FROM providers pv LEFT JOIN timeclock_staff s ON s.user_id = pv.user_id WHERE pv.practice_id = ?', pid,
  )).map((r) => [r.id, r.hourly_rate_cents ?? null]));
  return { profiles, pay, rates };
}

// ---- Fixed costs (overhead) ----
// Per chair-hour: every overhead cost except the direct ones already counted per visit (supplies, lab, card fees);
// team wages are in it (they're paid whether a chair is full or not). Per day, other than wages: the same without
// team wages (the day's P&L counts wages from the time clock instead).
const financeCache = new Map();
export async function overheadFor(db, pid, today, settings) {
  const s = settings || await loadSettings(db, pid);
  const out = { per_chair_hour: null, per_chair_hour_source: null, fixed_per_day: null, fixed_per_day_source: null, detail: null };
  if (s.overhead_mode === 'manual' && s.overhead_per_hour_cents != null) { out.per_chair_hour = s.overhead_per_hour_cents; out.per_chair_hour_source = 'manual'; }
  if (s.overhead_mode === 'manual' && s.fixed_costs_month_cents != null) {
    out.fixed_per_day = rnd(s.fixed_costs_month_cents / Math.max(1, s.work_days_month || 18));
    out.fixed_per_day_source = 'manual';
  }
  if (out.per_chair_hour == null || out.fixed_per_day == null) {
    const key = `${pid}|${today}`;
    let fin = financeCache.get(key);
    if (!fin || Date.now() - fin.at > 10 * 60_000) {
      let value = null;
      try {
        value = await financeOverview(db, pid, { months: 12, today });
      } catch {
        value = null; // no finance data connected: the typical figures below are used and labelled as such
      }
      fin = { at: Date.now(), value };
      financeCache.set(key, fin);
      if (financeCache.size > 500) financeCache.delete(financeCache.keys().next().value);
    }
    const f = fin.value;
    if (f?.summary?.months && f.summary.chair_hours > 0) {
      const amount = (k) => f.categories.find((c) => c.key === k)?.amount || 0;
      const fixedAll = f.categories.filter((c) => c.overhead && !['supplies', 'lab', 'fees'].includes(c.key)).reduce((t, c) => t + c.amount, 0);
      const nonLabor = fixedAll - amount('staff');
      const workDays = f.months.filter((m) => m.source && !m.partial).reduce((t, m) => t + (m.work_days || 0), 0);
      out.detail = { months: f.summary.months, chair_hours: f.summary.chair_hours, fixed_costs: fixedAll, team_wages: amount('staff'), other_fixed: nonLabor, work_days: workDays };
      if (out.per_chair_hour == null) { out.per_chair_hour = rnd(fixedAll / f.summary.chair_hours); out.per_chair_hour_source = 'finance'; }
      if (out.fixed_per_day == null && workDays > 0) { out.fixed_per_day = rnd(nonLabor / workDays); out.fixed_per_day_source = 'finance'; }
    }
  }
  if (out.per_chair_hour == null) { out.per_chair_hour = TYPICAL_OVERHEAD_PER_CHAIR_HOUR; out.per_chair_hour_source = 'typical'; }
  if (out.fixed_per_day == null) { out.fixed_per_day = TYPICAL_FIXED_COSTS_PER_DAY; out.fixed_per_day_source = 'typical'; }
  return out;
}

// ---- Visits with their margins ----
// Loads the visits on dates from..to (the person's offices; one office if picked) and prices each one.
export async function visitsWithMargins(db, user, { from, to, locationId = null, settings, costs, overhead }) {
  const pid = user.practice_id;
  const scope = appointmentScope(user);
  const where = `a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}`;
  const args = [pid, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args];
  const appts = await db.all(
    `SELECT a.id, a.patient_id, a.provider_id, a.operatory_id, a.location_id, a.start_time, a.end_time, a.status, a.pattern, a.appointment_type_id, a.asap,
       pv.type AS provider_type, pv.name AS provider_name, pv.color AS provider_color, t.name AS type_name, t.pattern AS type_pattern, o.name AS operatory_name
     FROM appointments a JOIN providers pv ON pv.id = a.provider_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id LEFT JOIN operatories o ON o.id = a.operatory_id
     WHERE ${where} ORDER BY a.start_time, a.id`, ...args,
  );
  if (!appts.length) return [];
  const procs = await db.all(
    `SELECT x.id, x.appointment_id, x.patient_id, x.code, x.description, x.category, x.fee, x.status, x.completed_at, x.tooth, x.surfaces, x.area, x.provider_id
     FROM procedures x JOIN appointments a ON a.id = x.appointment_id WHERE ${where} AND x.status != 'cancelled' ORDER BY x.id`, ...args,
  );
  const byAppt = new Map();
  for (const x of procs) byAppt.set(x.appointment_id, [...(byAppt.get(x.appointment_id) || []), x]);
  const labs = await labCasesFor(db, pid, procs.map((p) => p.id), appts.map((a) => a.id));
  const claims = await claimItemsFor(db, procs.map((p) => p.id));
  const policies = new Map();
  const out = [];
  for (const a of appts) {
    const list = byAppt.get(a.id) || [];
    const date = a.start_time.slice(0, 10);
    let est = null;
    const notes = [];
    if (list.length) {
      if (!policies.has(a.patient_id)) policies.set(a.patient_id, await primaryPolicy(db, pid, a.patient_id));
      const policy = policies.get(a.patient_id);
      if (policy) {
        try {
          est = await estimateCoverage(db, policy, list, { asOf: date });
        } catch (err) {
          notes.push(`Insurance estimate unavailable (${String(err?.message || err).slice(0, 80)}): priced at the office fee`);
        }
      }
    }
    const inputs = pricedLines(list, { est, claims, labs: labs.forVisit(a.id, list), costs, date });
    const m = visitMargin({
      procedures: inputs, minutes: visitMinutes({ ...a, pattern: a.pattern || a.type_pattern, provider_type: a.provider_type }),
      pay: resolvePay(costs.pay, a.provider_id, date), hourlyRate: costs.rates.get(a.provider_id) ?? null, settings, overheadPerHour: overhead.per_chair_hour, providerType: a.provider_type,
    });
    m.notes.push(...notes);
    out.push({ appt: a, date, live: LIVE.includes(a.status), payer: est?.policy?.carrier_name || (policies.get(a.patient_id)?.carrier_name ?? null), margin: m });
  }
  return out;
}

// Each procedure's price: the estimate (fee, PPO write-off, insurance, patient) — or what the claim says once there is
// one — plus its cost profile on the date of service and its lab case.
function pricedLines(list, { est, claims, labs, costs, date }) {
  return list.map((p, i) => {
    const e = est?.items?.[i];
    let writeOff = e ? e.write_off : 0;
    let insurance = e ? e.insurance : 0;
    const c = claims.get(p.id);
    if (c) {
      const paid = ['paid', 'partially_paid'].includes(c.status);
      writeOff = paid ? c.adjusted_amount || c.write_off || writeOff : c.write_off || writeOff;
      insurance = paid ? c.paid_amount : c.estimated_amount;
    }
    return {
      id: p.id, code: p.code, description: p.description, category: p.category, fee: p.fee, write_off: writeOff, insurance,
      profile: resolveProfile(costs.profiles, p, (p.completed_at || date).slice(0, 10)), lab_case_cents: labs.get(p.id) ?? null,
    };
  });
}

// Lab cases with a cost: those linked to a procedure count for it; those linked only to the visit go to the visit's
// procedures that expect lab work (a lab profile), most expensive first, one case each (the rest to the first).
async function labCasesFor(db, pid, procIds, apptIds) {
  const rows = [];
  for (let i = 0; i < Math.max(procIds.length, apptIds.length); i += 400) {
    const p = procIds.slice(i, i + 400);
    const a = apptIds.slice(i, i + 400);
    if (!p.length && !a.length) continue;
    const cond = [p.length ? `procedure_id IN (${p.map(() => '?').join(',')})` : null, a.length ? `(procedure_id IS NULL AND appointment_id IN (${a.map(() => '?').join(',')}))` : null].filter(Boolean).join(' OR ');
    rows.push(...await db.all(`SELECT id, procedure_id, appointment_id, cost FROM lab_cases WHERE practice_id = ? AND status != 'cancelled' AND cost IS NOT NULL AND (${cond}) ORDER BY id`, pid, ...p, ...a));
  }
  return {
    forVisit(apptId, list) {
      const out = new Map();
      for (const r of rows) if (r.procedure_id && list.some((p) => p.id === r.procedure_id)) out.set(r.procedure_id, (out.get(r.procedure_id) || 0) + r.cost);
      const loose = rows.filter((r) => !r.procedure_id && r.appointment_id === apptId);
      if (loose.length && list.length) {
        const wants = [...list].filter((p) => !out.has(p.id) && (CATEGORY_DEFAULTS[p.category]?.lab_mode || 'none') !== 'none').sort((x, y) => y.fee - x.fee);
        const targets = wants.length ? wants : [list[0]];
        loose.forEach((r, i) => {
          const t = targets[Math.min(i, targets.length - 1)];
          out.set(t.id, (out.get(t.id) || 0) + r.cost);
        });
      }
      return out;
    },
  };
}
async function claimItemsFor(db, procIds) {
  const out = new Map();
  for (let i = 0; i < procIds.length; i += 400) {
    const ids = procIds.slice(i, i + 400);
    for (const r of await db.all(
      `SELECT ci.procedure_id, ci.write_off, ci.adjusted_amount, ci.paid_amount, ci.estimated_amount, c.status, pi.carrier_id, ic.name AS carrier_name
       FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE ci.procedure_id IN (${ids.map(() => '?').join(',')}) AND c.status <> 'void' AND c.primary_claim_id IS NULL ORDER BY ci.id`, ...ids,
    )) out.set(r.procedure_id, r);
  }
  return out;
}

// ---- What a viewer may see ----
// Without timeclock:rates, provider pay is folded out of every breakdown (the margin still includes it).
export function shapeMargin(m, { rates }) {
  if (rates) return m;
  const { pay, hourly_pay, pay_basis, ...rest } = m; // eslint-disable-line no-unused-vars
  return { ...rest, lines: (m.lines || []).map(({ pay: _p, ...l }) => l), pay_hidden: true }; // eslint-disable-line no-unused-vars
}
const shapeTotals = (t, { rates }) => {
  if (rates) return t;
  const { pay, ...rest } = t; // eslint-disable-line no-unused-vars
  return rest;
};

// ---- PM2/PM3: the schedule colored by margin ----
export async function scheduleBusiness(db, user, { from, days = 1, locationId = null, rates, today }) {
  const pid = user.practice_id;
  const settings = await loadSettings(db, pid);
  const costs = await loadCosts(db, pid);
  const overhead = await overheadFor(db, pid, today, settings);
  const to = addDays(from, Math.min(Math.max(Number(days) || 1, 1), 7) - 1);
  const visits = await visitsWithMargins(db, user, { from, to, locationId, settings, costs, overhead });
  const t = thresholdsFor(settings, overhead.per_chair_hour);
  const byVisit = {};
  const cols = { operatories: {}, providers: {} };
  const perDay = {};
  for (const v of visits) {
    if (!v.live) continue;
    const value = bandValue(v.margin, settings.basis);
    byVisit[v.appt.id] = { band: bandFor(value, t), value, payer: v.payer, ...shapeMargin(v.margin, { rates }) };
    const dk = v.date;
    const add = (bucket, key) => { ((bucket[dk] ||= {})[key] ||= []).push(v.margin); };
    add(cols.operatories, v.appt.operatory_id ?? 'none');
    add(cols.providers, v.appt.provider_id);
    (perDay[dk] ||= []).push(v.margin);
  }
  const fold = (o) => Object.fromEntries(Object.entries(o).map(([d, byKey]) => [d, Object.fromEntries(Object.entries(byKey).map(([k, list]) => {
    const tot = addUp(list);
    return [k, { ...shapeTotals(tot, { rates }), band: bandFor(bandValue(tot, settings.basis), t) }];
  }))]));
  return {
    from, to, basis: settings.basis, thresholds: t, overhead: { per_chair_hour: overhead.per_chair_hour, source: overhead.per_chair_hour_source },
    visits: byVisit, columns: { operatories: fold(cols.operatories), providers: fold(cols.providers) },
    days: Object.fromEntries(Object.entries(perDay).map(([d, list]) => { const tot = addUp(list); return [d, { ...shapeTotals(tot, { rates }), band: bandFor(bandValue(tot, settings.basis), t) }]; })),
    typical_costs: visits.some((v) => v.margin.typical_costs), rates,
  };
}

// ---- BD2/BD3: the staff lanes ----
// Who each person is on the lanes: their saved role, else worked out (linked provider → doctor / hygienist; assistants
// share the pool; front desk, billing and administrators are the front office).
export async function staffRoles(db, pid, staff) {
  await ensureBusinessSchema(db);
  const saved = new Map((await db.all('SELECT * FROM business_staff_roles WHERE practice_id = ?', pid)).map((r) => [r.user_id, r]));
  const providers = await db.all('SELECT id, user_id, name, type FROM providers WHERE practice_id = ? AND active = 1', pid);
  const norm = (s) => String(s || '').toLowerCase().replace(/^dr\.?\s+/, '').replace(/,.*$/, '').trim();
  const out = new Map();
  for (const u of staff) {
    const r = saved.get(u.id);
    if (r) {
      const provider_ids = parseIds(r.provider_ids);
      const operatory_ids = parseIds(r.operatory_ids);
      out.set(u.id, { kind: r.kind, provider_ids, operatory_ids, pooled: r.kind === 'assistant' && !provider_ids.length && !operatory_ids.length, saved: true });
      continue;
    }
    const mine = providers.filter((p) => p.user_id === u.id);
    const byName = mine.length ? mine : providers.filter((p) => norm(p.name) === norm(u.name));
    if (byName.length) out.set(u.id, { kind: byName[0].type === 'hygienist' ? 'hygienist' : 'doctor', provider_ids: byName.map((p) => p.id), operatory_ids: [], pooled: false, saved: false });
    else if (u.role === 'assistant') out.set(u.id, { kind: 'assistant', provider_ids: [], operatory_ids: [], pooled: true, saved: false });
    else if (u.role === 'hygienist' || u.role === 'dentist') out.set(u.id, { kind: u.role === 'hygienist' ? 'hygienist' : 'doctor', provider_ids: [], operatory_ids: [], pooled: false, saved: false, unlinked: true });
    else out.set(u.id, { kind: 'admin', provider_ids: [], operatory_ids: [], pooled: false, saved: false });
  }
  return out;
}

// The day's lanes, labor, staffing and overtime. `money` = the viewer may see pay (timeclock:rates).
export async function staffDay(db, user, { date, locationId = null, nowMs = Date.now(), rates, settings = null, visits = null }) {
  const pid = user.practice_id;
  const s = settings || await loadSettings(db, pid);
  const { tz, settings: tc } = await practiceRules(db, pid);
  const nowLocal = utcToLocal(tz, nowMs);
  const today = nowLocal.slice(0, 10);
  const nowMin = date < today ? 1440 : date > today ? -1 : hmToMin(nowLocal.slice(11, 16));
  const staff = (await staffList(db, pid)).filter((u) => u.active && u.on_clock !== 0 && u.role !== 'api');
  const roles = await staffRoles(db, pid, staff);
  const wk = weekStart(date, tc.week_start_day);
  const hours = await computeHours(db, pid, { from: wk, to: date, tz, settings: tc, nowMs, staff });
  const shifts = await shiftsFor(db, pid, date, date);
  const pto = new Set((await db.all("SELECT user_id FROM pto_requests WHERE practice_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?", pid, date, date)).map((r) => r.user_id));
  const todays = new Map();
  for (const [uid, p] of hours) todays.set(uid, (p.punches || []).filter((x) => x.date === date));
  const punchIds = [...todays.values()].flat().map((x) => x.id);
  const breaks = punchIds.length ? await db.all(`SELECT * FROM time_breaks WHERE punch_id IN (${punchIds.map(() => '?').join(',')}) ORDER BY start_at`, ...punchIds) : [];
  const minuteOf = (local) => (local.slice(0, 10) < date ? 0 : local.slice(0, 10) > date ? 1440 : hmToMin(local.slice(11, 16)));

  // Visits: the day's live ones (not cancelled or missed), with production (fees) for "production supported".
  const vlist = visits || (await loadDayVisits(db, user, { date, locationId }));
  const tv = vlist.filter((v) => LIVE.includes(v.status)).map((v) => ({
    id: v.id, provider_id: v.provider_id, operatory_id: v.operatory_id, start: toMin(v.start_time), end: toMin(v.end_time) + (v.end_time.slice(0, 10) > date ? 1440 : 0),
    pattern: v.pattern || v.type_pattern || null, provider_kind: v.provider_type === 'hygienist' ? 'hygiene' : 'doctor', production: v.production || 0,
  }));

  // People in this office today: by their shift's or punches' office, else the offices they may work in.
  const inOffice = (u, shift, punches) => {
    if (!locationId) return true;
    if (shift?.location_id || punches.some((p) => p.location_id)) return shift?.location_id === locationId || punches.some((p) => p.location_id === locationId);
    const ids = u.location_ids ? parseIds(u.location_ids) : [];
    return !ids.length || ids.includes(locationId);
  };
  const people = [];
  for (const u of staff) {
    const sh = shifts.get(`${u.id}:${date}`);
    const shift = sh && !sh.off && sh.start_time && !pto.has(u.id) ? { start: hmToMin(sh.start_time), end: hmToMin(sh.end_time), break_minutes: sh.break_minutes || 0, location_id: sh.location_id ?? null } : null;
    const punches = todays.get(u.id) || [];
    if (!shift && !punches.length) continue;
    if (!inOffice(u, shift, punches)) continue;
    const role = roles.get(u.id);
    const pb = breaks.filter((b) => punches.some((p) => p.id === b.punch_id)).map((b) => {
      const start = minuteOf(b.start_at);
      const paid = b.kind !== 'lunch';
      // A break still going: expected to last the shift's lunch (or 15 minutes for a rest break), or until now if longer.
      const end = b.end_at ? minuteOf(b.end_at) : Math.max(nowMin, start + (b.kind === 'lunch' ? shift?.break_minutes || 30 : 15));
      return { start, end, paid: paid && (end - start) < (tc.paid_break_max_minutes || 20), kind: b.kind, open: !b.end_at };
    });
    people.push({
      user_id: u.id, name: u.name, role: u.role, ...role, shift, rate: u.hourly_rate_cents ?? null, exempt: !!u.overtime_exempt || u.pay_type === 'salary',
      punches: punches.map((p) => ({ id: p.id, in: minuteOf(p.in_local), out: p.out_local ? minuteOf(p.out_local) : null, in_flag: p.in_flag, in_flag_minutes: p.in_flag_minutes, out_flag: p.out_flag, out_flag_minutes: p.out_flag_minutes, minutes: p.minutes, regular: p.regular, overtime: p.overtime, doubletime: p.doubletime })),
      breaks: pb, ...awayState(punches.map((p) => (p.out_local ? minuteOf(p.out_local) : null)), shift),
      hours: hours.get(u.id),
    });
  }
  const bounds = [...people.flatMap((p) => [p.shift?.start, p.shift?.end, ...p.punches.map((x) => x.in), ...p.punches.map((x) => x.out ?? Math.min(1440, Math.max(nowMin, x.in)))]), ...tv.flatMap((v) => [v.start, v.end])].filter((x) => x != null);
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', pid);
  const loc = locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, pid) : null;
  const open = hoursFor(loc?.office_hours ? { office_hours: loc.office_hours } : practice, date);
  for (const [a, b] of open) bounds.push(hmToMin(a), hmToMin(b));
  const dayStart = bounds.length ? Math.max(0, Math.floor(Math.min(...bounds) / 30) * 30) : 7 * 60;
  const dayEnd = bounds.length ? Math.min(1440, Math.ceil(Math.max(...bounds) / 30) * 30) : 18 * 60;
  const timeline = staffTimeline({ people, visits: tv, now: nowMin, dayStart, dayEnd, idleGap: s.idle_gap_minutes || 20 });
  const asapCount = Number((await db.get("SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND asap = 1 AND status IN ('scheduled','confirmed') AND start_time > ?", pid, `${date} 23:59`))?.n || 0)
    + Number((await db.get("SELECT COUNT(*) AS n FROM waitlist WHERE practice_id = ? AND status = 'waiting'", pid))?.n || 0);

  const rows = timeline.map((t) => {
    const p = people.find((x) => x.user_id === t.user_id);
    const closed = p.punches.filter((x) => x.out != null);
    const closedToday = { regular: sum(closed, 'regular'), overtime: sum(closed, 'overtime'), doubletime: sum(closed, 'doubletime') };
    const runningPunch = p.punches.find((x) => x.out == null);
    const running = runningPunch && nowMin > 0 && nowMin < 1440 ? Math.max(0, Math.round(p.hours?.running || 0)) : 0;
    const weekRegularBefore = (p.hours?.all || []).filter((x) => x.date < date && x.minutes != null).reduce((a, x) => a + (x.regular || 0), 0);
    const weekBefore = (p.hours?.all || []).filter((x) => x.date < date && x.minutes != null).reduce((a, x) => a + (x.minutes || 0), 0);
    const unpaidTaken = p.breaks.filter((b) => !b.paid).reduce((a, b) => a + Math.max(0, Math.min(b.end, nowMin) - b.start), 0);
    const plannedPaid = Math.max(0, t.day.paid_minutes - t.so_far.paid_minutes);
    // The shift's unpaid lunch still to come (not yet taken as a break or by clocking out for it) isn't paid time.
    const lunchLeft = p.back_at != null ? 0 : Math.max(0, (p.shift?.break_minutes || 0) - unpaidTaken - p.breaks.filter((b) => !b.paid && b.end > nowMin).reduce((a, b) => a + (b.end - Math.max(b.start, nowMin)), 0));
    const remaining = nowMin >= 1440 ? 0 : Math.max(0, plannedPaid - lunchLeft);
    const labor = laborDay({ closedToday, running, remaining, weekRegularBefore, settings: tc, exempt: p.exempt, rate: p.rate });
    const todayWorked = sum(closed, 'minutes') + running;
    const risk = overtimeRisk({ nowMin: Math.max(0, nowMin), weekMinutes: weekBefore + todayWorked, todayMinutes: todayWorked, remaining, settings: tc, exempt: p.exempt, rate: p.rate });
    const flags = [];
    for (const x of p.punches) {
      if (x.in_flag === 'late') flags.push({ kind: 'late', minutes: x.in_flag_minutes });
      if (x.in_flag === 'early') flags.push({ kind: 'early', minutes: x.in_flag_minutes });
      if (x.in_flag === 'unscheduled') flags.push({ kind: 'unscheduled' });
      if (x.out_flag === 'early_out') flags.push({ kind: 'early_out', minutes: x.out_flag_minutes });
      if (x.out_flag === 'late_out') flags.push({ kind: 'late_out', minutes: x.out_flag_minutes });
    }
    if (p.shift && !p.punches.length && nowMin > p.shift.start + (tc.late_grace_minutes || 5) && nowMin < 1440) flags.push({ kind: 'not_in', minutes: Math.min(nowMin, p.shift.end) - p.shift.start });
    if (p.unlinked) flags.push({ kind: 'unlinked' });
    // One suggestion of each kind per person (the first idle stretch it fits), so the lanes stay readable.
    const said = new Set();
    const gaps = t.gaps.map((g) => ({
      ...g, idle_cost: rates && p.rate != null ? rnd((p.rate * g.minutes) / 60) : undefined,
      suggestions: suggestionsFor({ ...g, nowMin }, { person: p, asapCount, rate: rates ? p.rate : null }).filter((x) => (said.has(x.kind) ? false : said.add(x.kind))),
    }));
    const status = runningPunch ? (p.breaks.some((b) => b.open) ? 'break' : 'in') : p.back_at != null ? 'away' : p.punches.length ? 'out' : nowMin >= (p.shift?.end ?? 0) && nowMin < 1440 ? 'missing' : nowMin > (p.shift?.start ?? 1440) ? 'late' : 'expected';
    const row = {
      user_id: p.user_id, name: p.name, role: p.role, kind: t.kind, pooled: t.pooled, provider_ids: p.provider_ids, operatory_ids: p.operatory_ids, saved_role: !!p.saved,
      shift: p.shift, status, back_at: p.back_at ?? null, segments: t.segments, so_far: t.so_far, day: t.day, gaps, flags,
      worked_minutes: todayWorked, projected_minutes: labor.projected.minutes,
      overtime_risk: risk ? { kind: risk.kind, at: risk.at, minutes: risk.minutes, ...(rates ? { premium: risk.premium } : {}) } : null,
      overtime_minutes: { so_far: labor.so_far.overtime + labor.so_far.doubletime, projected: labor.projected.overtime + labor.projected.doubletime },
    };
    if (rates) {
      row.labor = { so_far: labor.so_far.cost, projected: labor.projected.cost, overtime_premium: labor.projected.overtime_premium, idle_cost_so_far: p.rate != null ? rnd((p.rate * t.so_far.idle_minutes) / 60) : null, idle_cost_day: p.rate != null ? rnd((p.rate * t.day.idle_minutes) / 60) : null };
      row.missing_rate = p.rate == null;
    }
    return row;
  });
  const hourly = staffingByHour({ timeline, visits: tv, dayStart, dayEnd, assistantsPerChairBp: s.assistants_per_doctor_chair_bp });
  return {
    date, now: nowMin >= 0 && nowMin < 1440 ? nowMin : null, past: nowMin >= 1440, future: nowMin < 0, day_start: dayStart, day_end: dayEnd,
    people: rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name)),
    staffing: hourly, advice: staffingAdvice(hourly), asap_count: asapCount, rates: !!rates,
    overtime: rows.filter((r) => r.overtime_risk || r.overtime_minutes.projected).map((r) => ({ user_id: r.user_id, name: r.name, ...r.overtime_risk, minutes_so_far: r.overtime_minutes.so_far, minutes_projected: r.overtime_minutes.projected })),
  };
}
// Clocked out: for the day (out within an hour of the shift's end, or no shift), or for lunch — then expected back
// after the shift's break (30 minutes when the shift doesn't say).
export function awayState(outs, shift) {
  if (!outs.length || outs.some((o) => o == null)) return { left: false, back_at: null };
  const last = Math.max(...outs);
  if (!shift || last >= shift.end - 60) return { left: true, back_at: null };
  return { left: false, back_at: last + Math.max(30, shift.break_minutes || 0) };
}
const KIND_ORDER = { doctor: 0, hygienist: 1, assistant: 2, admin: 3 };
const sum = (list, k) => list.reduce((t, x) => t + (x[k] || 0), 0);

// The day's visits with their production (fees of non-cancelled procedures), for the lanes.
async function loadDayVisits(db, user, { date, locationId }) {
  const scope = appointmentScope(user);
  const rows = await db.all(
    `SELECT a.id, a.provider_id, a.operatory_id, a.start_time, a.end_time, a.status, a.pattern, t.pattern AS type_pattern, pv.type AS provider_type,
       (SELECT COALESCE(SUM(x.fee), 0) FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS production
     FROM appointments a JOIN providers pv ON pv.id = a.provider_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}`,
    user.practice_id, `${date} 00:00`, `${addDays(date, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args,
  );
  return rows.map((r) => ({ ...r, production: Number(r.production) || 0 }));
}

// ---- BD1: today's P&L ----
export async function todayBusiness(db, user, { date, locationId = null, nowMs = Date.now(), rates, today }) {
  const pid = user.practice_id;
  const settings = await loadSettings(db, pid);
  const costs = await loadCosts(db, pid);
  const overhead = await overheadFor(db, pid, today, settings);
  const visits = await visitsWithMargins(db, user, { from: date, to: date, locationId, settings, costs, overhead });
  const live = visits.filter((v) => v.live);
  const done = live.filter((v) => v.appt.status === 'completed');
  // Scheduled and completed production: the schedule's own numbers (production.js), the same as the production bar.
  let scheduled = live.reduce((t, v) => t + v.margin.fee, 0);
  let completed = null;
  try {
    const prod = await scheduleProduction(db, user, { from: date, days: 1, locationId, kind: 'all' });
    if (prod.money && prod.days[0]) { scheduled = prod.days[0].scheduled; completed = prod.days[0].completed; }
  } catch {
    completed = null; // falls back to the visits' own fees below
  }
  if (completed == null) completed = done.reduce((t, v) => t + v.margin.fee, 0);

  const lanes = await staffDay(db, user, { date, locationId, nowMs, rates: true, settings, visits: visits.map((v) => ({ ...v.appt, production: v.margin.fee })) });
  const onClock = new Set(lanes.people.map((p) => p.user_id));
  const providerUsers = new Map((await db.all('SELECT id, user_id FROM providers WHERE practice_id = ?', pid)).map((r) => [r.id, r.user_id]));
  // Hourly-paid providers who are on the time clock today are in the labor figure; don't count their pay twice.
  const direct = (list) => list.reduce((t, v) => {
    const clocked = v.margin.pay_basis === 'hourly' && onClock.has(providerUsers.get(v.appt.provider_id));
    return t + v.margin.lab + v.margin.supplies + v.margin.merchant + (clocked ? 0 : v.margin.pay);
  }, 0);
  const expected = live.reduce((t, v) => t + v.margin.expected, 0);
  const expectedDone = done.reduce((t, v) => t + v.margin.expected, 0);
  const directCosts = direct(live);
  const labor = {
    so_far: lanes.people.reduce((t, p) => t + (p.labor?.so_far || 0), 0),
    projected: lanes.people.reduce((t, p) => t + (p.labor?.projected || 0), 0),
    overtime_premium: lanes.people.reduce((t, p) => t + (p.labor?.overtime_premium || 0), 0),
    paid_minutes_so_far: lanes.people.reduce((t, p) => t + p.so_far.paid_minutes, 0),
    paid_minutes_projected: lanes.people.reduce((t, p) => t + p.projected_minutes, 0),
    idle_cost_day: lanes.people.reduce((t, p) => t + (p.labor?.idle_cost_day || 0), 0),
    missing_rates: lanes.people.filter((p) => p.missing_rate).map((p) => p.name),
    people: lanes.people.length,
    clocked_in: lanes.people.filter((p) => p.status === 'in' || p.status === 'break').length,
  };
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', pid);
  const loc = locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, pid) : null;
  const openMinutes = hoursFor(loc?.office_hours ? { office_hours: loc.office_hours } : practice, date).reduce((t, [a, b]) => t + Math.max(0, hmToMin(b) - hmToMin(a)), 0);
  const fixedToday = openMinutes > 0 || live.length ? overhead.fixed_per_day : 0;
  const contribution = expected - directCosts - labor.projected;
  const t = thresholdsFor(settings, overhead.per_chair_hour);
  const red = live.filter((v) => bandFor(bandValue(v.margin, settings.basis), t) === 'red');
  // Open chair time during office hours: each active chair's open minutes not booked, worth the day's average margin per chair-hour.
  const chairs = await db.all(`SELECT id FROM operatories WHERE practice_id = ? AND active = 1${locationId ? ' AND location_id = ?' : ''}`, pid, ...(locationId ? [locationId] : []));
  const booked = live.reduce((a, v) => a + v.margin.chair_minutes, 0);
  const openChairMinutes = Math.max(0, chairs.length * openMinutes - booked);
  const totals = addUp(live.map((v) => v.margin));
  const out = {
    date, open_minutes: openMinutes, visits: live.length, completed_visits: done.length,
    production: { scheduled, completed, write_offs: totals.write_off, net: totals.allowed },
    collections: { expected, expected_completed: expectedDone, insurance: totals.insurance, patient: live.reduce((a, v) => a + v.margin.patient_expected, 0), uncollected: live.reduce((a, v) => a + v.margin.uncollected, 0) },
    direct_costs: { total: directCosts, lab: totals.lab, supplies: totals.supplies, merchant: totals.merchant },
    overhead: { per_chair_hour: overhead.per_chair_hour, per_chair_hour_source: overhead.per_chair_hour_source, fixed_today: fixedToday, fixed_source: overhead.fixed_per_day_source, per_open_hour: openMinutes ? perHour(fixedToday, openMinutes) : null },
    margin: { total: totals.margin, per_chair_hour: totals.margin_per_chair_hour, per_doctor_hour: totals.margin_per_doctor_hour },
    below_cost: { visits: red.length, shortfall: red.reduce((a, v) => a + Math.max(0, (v.margin.overhead || 0) - v.margin.margin), 0) },
    open_chair: { minutes: openChairMinutes, worth: totals.margin_per_chair_hour != null ? rnd((openChairMinutes * Math.max(0, totals.margin_per_chair_hour)) / 60) : null },
    productivity: {
      pct_so_far: pct1(sum(lanes.people.filter((p) => p.kind !== 'admin').map((p) => p.so_far), 'productive_minutes'), sum(lanes.people.filter((p) => p.kind !== 'admin').map((p) => p.so_far), 'working_minutes')),
      idle_minutes_so_far: sum(lanes.people.map((p) => p.so_far), 'idle_minutes'), idle_minutes_day: sum(lanes.people.map((p) => p.day), 'idle_minutes'),
    },
    labor_target: { low: settings.labor_target_low_bp / 100, high: settings.labor_target_high_bp / 100 },
    staffing_advice: lanes.advice, overtime: lanes.overtime.map(({ premium, ...o }) => (rates ? { ...o, premium } : o)),
    thresholds: t, basis: settings.basis, rates: !!rates, typical_costs: visits.some((v) => v.margin.typical_costs),
  };
  if (rates) {
    const hours = labor.paid_minutes_projected / 60;
    out.labor = {
      ...labor,
      pct_of_production: pct1(labor.projected, scheduled), pct_of_production_so_far: pct1(labor.so_far, completed),
      pct_of_collections: pct1(labor.projected, expected),
      production_per_labor_hour: hours > 0 ? rnd(scheduled / hours) : null,
    };
    const p = out.labor.pct_of_production;
    out.labor.status = p == null ? null : p > out.labor_target.high ? 'over' : p < out.labor_target.low ? 'under' : 'on_target';
    out.contribution = contribution;
    out.profit = contribution - fixedToday;
    out.break_even = { collections_needed: directCosts + labor.projected + fixedToday, covered_pct: pct1(expected, directCosts + labor.projected + fixedToday) };
  } else {
    out.labor = { hidden: true, people: labor.people, clocked_in: labor.clocked_in };
  }
  return out;
}

// ---- BD4: trends ----
const bucketOf = (d, group, weekStartDay = 0) => (group === 'month' ? d.slice(0, 7) : group === 'week' ? weekStart(d, weekStartDay) : d);
export async function businessTrends(db, user, { from, to, group = 'day', locationId = null, rates, nowMs = Date.now(), today, withProductivity = true }) {
  const pid = user.practice_id;
  const { tz, settings: tc } = await practiceRules(db, pid);
  const staff = await staffList(db, pid);
  const rateOf = new Map(staff.map((u) => [u.id, u.hourly_rate_cents ?? null]));
  const hours = await computeHours(db, pid, { from, to, tz, settings: tc, nowMs, staff });
  const days = dateRange(from, to);
  const buckets = new Map();
  const bucket = (d) => {
    const k = bucketOf(d, group, tc.week_start_day);
    if (!buckets.has(k)) buckets.set(k, { period: k, from: d, to: d, production: 0, collections: 0, labor_cost: 0, labor_missing: 0, paid_minutes: 0, overtime_minutes: 0, overtime_premium: 0, productive_minutes: 0, clinical_minutes: 0, idle_minutes: 0, idle_cost: 0 });
    const b = buckets.get(k);
    if (d < b.from) b.from = d;
    if (d > b.to) b.to = d;
    return b;
  };
  for (const d of days) bucket(d);
  for (const b of buckets.values()) {
    const { values } = await metrics.computeMetrics(db, pid, { from: b.from, to: b.to, today, keys: ['production_gross', 'collections'], locationId });
    b.production = values.production_gross || 0;
    b.collections = values.collections || 0;
  }
  const byRole = new Map();
  const byPerson = new Map();
  for (const p of hours.values()) {
    for (const x of p.punches || []) {
      if (x.minutes == null || x.date < from || x.date > to) continue;
      if (locationId && x.location_id && x.location_id !== locationId) continue;
      const b = bucket(x.date);
      const rate = rateOf.get(p.user_id);
      b.paid_minutes += x.minutes;
      b.overtime_minutes += (x.overtime || 0) + (x.doubletime || 0);
      if (rate == null) b.labor_missing += 1;
      else {
        b.labor_cost += rnd((((x.regular || 0) + (x.overtime || 0) * 1.5 + (x.doubletime || 0) * 2) * rate) / 60);
        b.overtime_premium += rnd((((x.overtime || 0) * 0.5 + (x.doubletime || 0)) * rate) / 60);
      }
    }
  }
  const productivity = withProductivity && days.length <= 62;
  if (productivity) {
    for (const d of days) {
      if (d > today) continue;
      const lanes = await staffDay(db, user, { date: d, locationId, nowMs, rates: true });
      const b = bucket(d);
      for (const r of lanes.people) {
        const clinical = r.kind !== 'admin';
        const done = r.so_far;
        b.idle_minutes += done.idle_minutes;
        b.idle_cost += r.labor?.idle_cost_so_far || 0;
        if (clinical) { b.productive_minutes += done.productive_minutes; b.clinical_minutes += done.working_minutes; }
        const pr = byPerson.get(r.user_id) || { user_id: r.user_id, name: r.name, kind: r.kind, paid_minutes: 0, productive_minutes: 0, working_minutes: 0, idle_minutes: 0, idle_cost: 0, production_supported: 0, days: 0 };
        pr.paid_minutes += done.paid_minutes; pr.productive_minutes += clinical ? done.productive_minutes : 0; pr.working_minutes += clinical ? done.working_minutes : 0;
        pr.idle_minutes += done.idle_minutes; pr.idle_cost += r.labor?.idle_cost_so_far || 0; pr.production_supported += done.production_supported; pr.days += 1;
        byPerson.set(r.user_id, pr);
        const rr = byRole.get(r.kind) || { kind: r.kind, paid_minutes: 0, productive_minutes: 0, working_minutes: 0, idle_minutes: 0, people: new Set() };
        rr.paid_minutes += done.paid_minutes; rr.productive_minutes += clinical ? done.productive_minutes : 0; rr.working_minutes += clinical ? done.working_minutes : 0; rr.idle_minutes += done.idle_minutes; rr.people.add(r.user_id);
        byRole.set(r.kind, rr);
      }
    }
  }
  const rows = [...buckets.values()].sort((a, b) => (a.period < b.period ? -1 : 1)).map((b) => {
    const r = trendRow(b);
    if (!productivity) { r.productivity_pct = null; r.idle_hours = null; }
    if (!rates) { for (const k of ['labor_cost', 'overtime_premium', 'idle_cost', 'labor_pct_production', 'labor_pct_collections', 'labor_missing']) delete r[k]; }
    return r;
  });
  const total = trendRow(rows.reduce((t, r) => {
    for (const k of Object.keys(t)) t[k] += r[k] || 0;
    return t;
  }, { production: 0, collections: 0, labor_cost: 0, paid_minutes: 0, overtime_minutes: 0, overtime_premium: 0, productive_minutes: 0, clinical_minutes: 0, idle_minutes: 0, idle_cost: 0 }));
  if (!rates) for (const k of ['labor_cost', 'overtime_premium', 'idle_cost', 'labor_pct_production', 'labor_pct_collections']) delete total[k];
  if (!productivity) { total.productivity_pct = null; total.idle_hours = null; }
  return {
    from, to, group, rows, total, productivity_included: productivity, rates: !!rates,
    people: [...byPerson.values()].map((p) => ({ ...p, productivity_pct: pct1(p.productive_minutes, p.working_minutes), production_per_labor_hour: perHour(p.production_supported, p.paid_minutes), ...(rates ? {} : { idle_cost: undefined }) })).sort((a, b) => a.name.localeCompare(b.name)),
    roles: [...byRole.values()].map((r) => ({ kind: r.kind, people: r.people.size, paid_hours: Math.round((r.paid_minutes / 60) * 10) / 10, productivity_pct: pct1(r.productive_minutes, r.working_minutes), idle_hours: Math.round((r.idle_minutes / 60) * 10) / 10 })),
  };
}

// Drill-down: the shifts and visits behind a trend number.
export async function trendRows(db, user, { metric, from, to, locationId = null, rates, nowMs = Date.now() }) {
  const pid = user.practice_id;
  if (metric === 'production') {
    const scope = appointmentScope(user);
    return (await db.all(
      `SELECT a.id AS appointment_id, substr(a.start_time, 1, 10) AS date, a.start_time, a.status, pv.name AS provider_name,
         (SELECT COALESCE(SUM(x.fee), 0) FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS production
       FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status = 'completed'${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}
       ORDER BY a.start_time`, pid, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args,
    )).map((r) => ({ ...r, production: Number(r.production) || 0 }));
  }
  const { tz, settings: tc } = await practiceRules(db, pid);
  const staff = await staffList(db, pid);
  const rateOf = new Map(staff.map((u) => [u.id, u.hourly_rate_cents ?? null]));
  const hours = await computeHours(db, pid, { from, to, tz, settings: tc, nowMs, staff });
  const out = [];
  for (const p of hours.values()) for (const x of p.punches || []) {
    if (x.date < from || x.date > to || x.minutes == null) continue;
    if (locationId && x.location_id && x.location_id !== locationId) continue;
    const rate = rateOf.get(p.user_id);
    out.push({
      date: x.date, user_id: p.user_id, name: p.name, clock_in: x.in_local, clock_out: x.out_local, minutes: x.minutes, regular: x.regular, overtime: x.overtime, doubletime: x.doubletime,
      ...(rates ? { cost: rate == null ? null : rnd((((x.regular || 0) + (x.overtime || 0) * 1.5 + (x.doubletime || 0) * 2) * rate) / 60), overtime_premium: rate == null ? null : rnd((((x.overtime || 0) * 0.5 + (x.doubletime || 0)) * rate) / 60) } : {}),
    });
  }
  const rows = out.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
  if (metric === 'overtime') return rows.filter((r) => r.overtime || r.doubletime);
  return rows;
}

// ---- PM4: what pays and what doesn't ----
// Completed work in a date range, priced like the schedule but from what really happened: the claim's write-off and
// payment when there is one, else the PPO's allowed fee on the date of service (the fee resolver) and the policy's
// percentages. Chair and doctor time: each visit's, shared across its procedures by allowed fee.
export async function completedWork(db, user, { from, to, locationId = null, settings, costs, overhead }) {
  const pid = user.practice_id;
  await ensureFeeSchema(db);
  const scope = appointmentScope(user);
  const rows = await db.all(
    `SELECT pr.id, pr.patient_id, pr.appointment_id, pr.code, pr.description, pr.category, pr.fee, substr(pr.completed_at, 1, 10) AS dos,
       COALESCE(pr.provider_id, a.provider_id) AS provider_id, a.start_time, a.end_time, a.pattern, a.appointment_type_id, t.name AS type_name, t.pattern AS type_pattern,
       pv.type AS provider_type, pv.name AS provider_name, apv.type AS appt_provider_type
     FROM procedures pr LEFT JOIN appointments a ON a.id = pr.appointment_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
     LEFT JOIN providers pv ON pv.id = COALESCE(pr.provider_id, a.provider_id) LEFT JOIN providers apv ON apv.id = a.provider_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ?${locationId ? ' AND pr.location_id = ?' : ''}${scope.sql.replace(/\ba\./g, 'a.')}
     ORDER BY pr.completed_at, pr.id`,
    pid, from, `${addDays(to, 1)}`, ...(locationId ? [locationId] : []), ...scope.args,
  );
  const claims = await claimItemsFor(db, rows.map((r) => r.id));
  const labs = await labCasesFor(db, pid, rows.map((r) => r.id), [...new Set(rows.map((r) => r.appointment_id).filter(Boolean))]);
  const policies = new Map();
  const fsOf = async (policy) => {
    if (!policy) return null;
    if (policy.plan_id) {
      const plan = await db.get('SELECT fee_schedule_id FROM insurance_plans WHERE id = ? AND practice_id = ?', policy.plan_id, pid);
      if (plan?.fee_schedule_id) return plan.fee_schedule_id;
    }
    return (await db.get('SELECT fee_schedule_id FROM insurance_carriers WHERE id = ?', policy.carrier_id))?.fee_schedule_id ?? null;
  };
  const feeCache = new Map();
  const groups = new Map();
  for (const r of rows) {
    const key = r.appointment_id ? `a${r.appointment_id}` : `p${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const visits = [];
  for (const [, list] of groups) {
    const head = list[0];
    const lines = [];
    const payers = [];
    for (const r of list) {
      if (!policies.has(r.patient_id)) {
        const pol = await primaryPolicy(db, pid, r.patient_id);
        policies.set(r.patient_id, pol ? { ...pol, fs: await fsOf(pol) } : null);
      }
      const pol = policies.get(r.patient_id);
      const c = claims.get(r.id);
      let writeOff = 0;
      let insurance = 0;
      let ppoAllowed = null;
      let payer = 'No insurance';
      let carrierId = null;
      if (c) {
        const paid = ['paid', 'partially_paid'].includes(c.status);
        writeOff = paid ? c.adjusted_amount || c.write_off || 0 : c.write_off || 0;
        insurance = paid ? c.paid_amount : c.estimated_amount;
        payer = c.carrier_name;
        carrierId = c.carrier_id;
        if (writeOff > 0) ppoAllowed = r.fee - writeOff;
      } else if (pol) {
        payer = pol.carrier_name;
        carrierId = pol.carrier_id;
        if (pol.fs) {
          const k = `${pol.fs}|${r.code}|${r.dos}`;
          if (!feeCache.has(k)) feeCache.set(k, await resolveFee(db, pid, pol.fs, r.code, r.dos));
          const f = feeCache.get(k);
          if (f != null) { ppoAllowed = f; writeOff = Math.max(0, r.fee - f); }
        }
        const tier = coverageTier(r.category);
        insurance = rnd(((r.fee - writeOff) * (pol[`pct_${tier}`] ?? 0)) / 100);
      }
      if (c && c.write_off === 0 && pol?.fs && ppoAllowed == null) {
        const k = `${pol.fs}|${r.code}|${r.dos}`;
        if (!feeCache.has(k)) feeCache.set(k, await resolveFee(db, pid, pol.fs, r.code, r.dos));
        ppoAllowed = feeCache.get(k);
      }
      payers.push({ payer, carrier_id: carrierId, ppo_allowed: ppoAllowed });
      lines.push({ id: r.id, code: r.code, description: r.description, category: r.category, fee: r.fee, write_off: writeOff, insurance, profile: resolveProfile(costs.profiles, r, r.dos), lab_case_cents: null });
    }
    const lab = labs.forVisit(head.appointment_id, list);
    for (const l of lines) l.lab_case_cents = lab.get(l.id) ?? null;
    const minutes = head.start_time ? visitMinutes({ start_time: head.start_time, end_time: head.end_time, pattern: head.pattern || head.type_pattern, provider_type: head.appt_provider_type || head.provider_type }) : { chair: 0, doctor: 0, provider: 0 };
    const providerId = head.provider_id;
    const input = { procedures: lines, minutes, pay: resolvePay(costs.pay, providerId, head.dos), hourlyRate: costs.rates.get(providerId) ?? null, settings, overheadPerHour: overhead.per_chair_hour, providerType: head.appt_provider_type || head.provider_type };
    visits.push({ head, input, payers, margin: visitMargin(input) });
  }
  return visits;
}

// One row per procedure line, with its share of the visit's time.
export function reportLines(visits) {
  const out = [];
  for (const v of visits) {
    const m = v.margin;
    const w = m.lines.map((l) => l.allowed || 1);
    const chair = allocate(m.chair_minutes, w);
    const doctor = allocate(m.doctor_minutes, w);
    const overhead = m.overhead != null ? allocate(m.overhead, w) : m.lines.map(() => null);
    m.lines.forEach((l, i) => out.push({
      ...l, chair_minutes: chair[i], doctor_minutes: doctor[i], overhead: overhead[i], profit: overhead[i] != null ? l.margin - overhead[i] : null,
      provider_id: v.head.provider_id, provider_name: v.head.provider_name || 'No provider', type_id: v.head.appointment_type_id, type_name: v.head.type_name || (v.head.appointment_id ? 'No visit type' : 'Not on a visit'),
      payer: v.payers[i].payer, carrier_id: v.payers[i].carrier_id, ppo_allowed: v.payers[i].ppo_allowed, dos: v.head.dos,
    }));
  }
  return out;
}
export function groupLines(lines, by, { rates, thresholds, basis }) {
  const keyOf = { procedure: (l) => l.code, provider: (l) => l.provider_id ?? 0, payer: (l) => l.carrier_id ?? 0, type: (l) => l.type_id ?? 0, category: (l) => l.category }[by];
  const labelOf = { procedure: (l) => `${l.code} ${l.description || ''}`.trim(), provider: (l) => l.provider_name, payer: (l) => l.payer, type: (l) => l.type_name, category: (l) => l.category }[by];
  if (!keyOf) throw new HttpError(400, 'by must be procedure, provider, payer, type or category');
  const groups = new Map();
  for (const l of lines) {
    const k = String(keyOf(l));
    if (!groups.has(k)) groups.set(k, { key: k, label: labelOf(l), count: 0, fee: 0, write_off: 0, allowed: 0, expected: 0, lab: 0, supplies: 0, merchant: 0, pay: 0, costs: 0, margin: 0, chair_minutes: 0, doctor_minutes: 0, overhead: 0, profit: 0, has_overhead: true });
    const g = groups.get(k);
    g.count += 1;
    for (const f of ['fee', 'write_off', 'allowed', 'expected', 'lab', 'supplies', 'merchant', 'pay', 'costs', 'margin', 'chair_minutes', 'doctor_minutes']) g[f] += l[f] || 0;
    if (l.overhead == null) g.has_overhead = false;
    else { g.overhead += l.overhead; g.profit += l.profit; }
  }
  return [...groups.values()].map((g) => {
    const r = { ...g, overhead: g.has_overhead ? g.overhead : null, profit: g.has_overhead ? g.profit : null };
    delete r.has_overhead;
    r.margin_per_chair_hour = perHour(r.margin, r.chair_minutes);
    r.margin_per_doctor_hour = r.doctor_minutes > 0 ? perHour(r.margin, r.doctor_minutes) : null;
    r.profit_per_hour = r.profit != null && r.chair_minutes > 0 ? perHour(r.profit, r.chair_minutes) : null;
    r.write_off_pct = pct1(r.write_off, r.fee);
    r.band = bandFor(bandValue(r, basis), thresholds);
    if (!rates) delete r.pay;
    return r;
  }).sort((a, b) => (a.margin_per_chair_hour ?? Infinity) - (b.margin_per_chair_hour ?? Infinity));
}

export async function marginReport(db, user, { from, to, by = 'procedure', locationId = null, rates, today }) {
  const pid = user.practice_id;
  const settings = await loadSettings(db, pid);
  const costs = await loadCosts(db, pid);
  const overhead = await overheadFor(db, pid, today, settings);
  const thresholds = thresholdsFor(settings, overhead.per_chair_hour);
  const visits = await completedWork(db, user, { from, to, locationId, settings, costs, overhead });
  const lines = reportLines(visits);
  const rows = groupLines(lines, by, { rates, thresholds, basis: settings.basis });
  const total = groupLines(lines.map((l) => ({ ...l, code: 'all', description: 'Everything', category: 'all' })), 'category', { rates, thresholds, basis: settings.basis })[0] || null;
  // The least profitable procedures under each payer (per chair-hour; procedures with time on the schedule).
  const byPayer = new Map();
  for (const l of lines) {
    const k = l.carrier_id ?? 0;
    if (!byPayer.has(k)) byPayer.set(k, { carrier_id: l.carrier_id, payer: l.payer, lines: [] });
    byPayer.get(k).lines.push(l);
  }
  const leastProfitable = [...byPayer.values()].map((p) => ({
    carrier_id: p.carrier_id, payer: p.payer, procedures: groupLines(p.lines, 'procedure', { rates, thresholds, basis: settings.basis }).filter((r) => r.chair_minutes > 0).slice(0, 5),
  })).sort((a, b) => String(a.payer).localeCompare(String(b.payer)));
  return { from, to, by, rows, total, least_profitable: leastProfitable, thresholds, basis: settings.basis, overhead: { per_chair_hour: overhead.per_chair_hour, source: overhead.per_chair_hour_source }, rates: !!rates, typical_costs: visits.some((v) => v.margin.typical_costs) };
}

// "What if": the same completed work, priced again with one thing changed. Scaled to a year.
export async function whatIf(db, user, { from, to, kind, code = null, pctBp = 0, labCents = null, carrierId = null, retention = 70, refill = 50, locationId = null, today }) {
  const pid = user.practice_id;
  const settings = await loadSettings(db, pid);
  const costs = await loadCosts(db, pid);
  const overhead = await overheadFor(db, pid, today, settings);
  const visits = await completedWork(db, user, { from, to, locationId, settings, costs, overhead });
  const days = dateRange(from, to).length;
  const year = (x) => rnd((x * 365) / Math.max(1, days));
  const before = visits.reduce((t, v) => t + v.margin.margin, 0);
  if (kind === 'fee' || kind === 'lab') {
    let touched = 0;
    const after = visits.reduce((t, v) => {
      const lines = v.input.procedures.map((l, i) => {
        if (code && l.code !== code) return l;
        touched += 1;
        if (kind === 'lab') return { ...l, lab_case_cents: labCents };
        const fee = l.fee + rnd((l.fee * pctBp) / 10000);
        const cap = v.payers[i].ppo_allowed;
        const allowed = cap != null ? Math.min(fee, cap) : fee;
        const ratio = l.fee - l.write_off > 0 ? l.insurance / (l.fee - l.write_off) : 0;
        return { ...l, fee, write_off: fee - allowed, insurance: v.payers[i].payer === 'No insurance' ? 0 : Math.min(allowed, cap != null ? l.insurance : rnd(allowed * ratio)) };
      });
      return t + visitMargin({ ...v.input, procedures: lines }).margin;
    }, 0);
    return { kind, code, pct: pctBp / 100, lab_cents: labCents, procedures: touched, days, margin_before: before, margin_after: after, change: after - before, change_per_year: year(after - before) };
  }
  if (kind === 'drop_plan') {
    const lines = reportLines(visits);
    const mine = lines.filter((l) => String(l.carrier_id) === String(carrierId));
    if (!mine.length) throw new HttpError(404, 'No completed work under that plan in these dates');
    const agg = (list) => list.reduce((t, l) => ({ write_off: t.write_off + l.write_off, margin: t.margin + l.margin, chair_minutes: t.chair_minutes + l.chair_minutes }), { write_off: 0, margin: 0, chair_minutes: 0 });
    const r = whatIfDropPlan({ plan: agg(mine), others: agg(lines.filter((l) => String(l.carrier_id) !== String(carrierId))), retentionPct: retention, refillPct: refill });
    return { kind, carrier_id: Number(carrierId), payer: mine[0].payer, retention, refill, days, procedures: mine.length, ...r, change_per_year: year(r.change), recaptured_per_year: year(r.recaptured_write_offs), lost_per_year: year(r.lost_margin), refilled_per_year: year(r.refilled_margin) };
  }
  throw new HttpError(400, 'kind must be fee, lab or drop_plan');
}

// ---- PM1: suggested costs ----
export async function suggestions(db, pid, today) {
  const from = addDays(today, -365);
  const counts = Object.fromEntries((await db.all("SELECT category, COUNT(*) AS n FROM procedures WHERE practice_id = ? AND status = 'completed' AND completed_at >= ? GROUP BY category", pid, from)).map((r) => [r.category, Number(r.n)]));
  let spend = 0;
  try {
    const fin = await financeOverview(db, pid, { months: 12, today });
    spend = fin.categories.find((c) => c.key === 'supplies')?.amount || 0;
  } catch {
    spend = 0; // no finance data: typical amounts
  }
  const base = suggestSupplies(counts, spend);
  const labByCode = await db.all(
    `SELECT pr.code, COUNT(*) AS n, ROUND(AVG(lc.cost)) AS avg_cost FROM lab_cases lc JOIN procedures pr ON pr.id = lc.procedure_id
     WHERE lc.practice_id = ? AND lc.cost IS NOT NULL AND lc.status != 'cancelled' AND lc.created_at >= ? GROUP BY pr.code`, pid, from,
  );
  return {
    ...base, supply_spend: spend, procedures: counts,
    codes: labByCode.map((r) => ({ code: r.code, lab_mode: 'case', lab_cents: Number(r.avg_cost) || 0, cases: Number(r.n) })),
  };
}

// ---- EX1–EX3: exams and the production they support ----
// Counts come from the diagnosis module (metrics.js examsForDay) and values from its history (examValues) when they
// are there; until then, exam codes on the day's visits are counted here and values come from the owner's table
// (else typical values). `source` says which was used.
export async function examCounts(db, user, { from, to, locationId = null }) {
  const pid = user.practice_id;
  if (typeof metrics.examsForDay === 'function') {
    const out = {};
    for (const d of dateRange(from, to)) {
      const c = await metrics.examsForDay(db, pid, d, { locationId });
      for (const [t, n] of Object.entries(c?.by_type || {})) out[t] = (out[t] || 0) + (Number(n) || 0);
    }
    return { counts: out, source: 'diagnosis' };
  }
  const codes = Object.keys(FALLBACK_EXAM_CODES);
  const scope = appointmentScope(user);
  const rows = await db.all(
    `SELECT x.patient_id, substr(a.start_time, 1, 10) AS date, x.code FROM procedures x JOIN appointments a ON a.id = x.appointment_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show') AND x.status != 'cancelled'
       AND x.code IN (${codes.map(() => '?').join(',')})${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}
     UNION ALL
     SELECT x.patient_id, substr(x.completed_at, 1, 10) AS date, x.code FROM procedures x
     WHERE x.practice_id = ? AND x.appointment_id IS NULL AND x.status = 'completed' AND x.completed_at >= ? AND x.completed_at < ?
       AND x.code IN (${codes.map(() => '?').join(',')})${locationId ? ' AND x.location_id = ?' : ''}`,
    pid, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...codes, ...(locationId ? [locationId] : []), ...scope.args,
    pid, from, addDays(to, 1), ...codes, ...(locationId ? [locationId] : []),
  );
  return { counts: countExams(rows), source: 'codes' };
}
export async function examSettings(db, pid) {
  await ensureBusinessSchema(db);
  const rows = await db.all('SELECT exam_type, daily_target, value_cents FROM business_exam_targets WHERE practice_id = ?', pid);
  return Object.fromEntries(rows.map((r) => [r.exam_type, { daily_target: r.daily_target, value_cents: r.value_cents }]));
}
export async function examValuesFor(db, pid, { horizon = 5, locationId = null, today = null } = {}) {
  const h = EXAM_HORIZONS.includes(horizon) ? horizon : 5;
  const own = await examSettings(db, pid);
  if (typeof metrics.examValues === 'function') {
    const v = await metrics.examValues(db, pid, { providerId: null, locationId, horizon: h, today });
    const out = {};
    // No history yet for a type (and no override there): the owner's number here, else the typical value.
    for (const [t, x] of Object.entries(v || {})) {
      const mine = own[t]?.value_cents;
      const fallback = mine != null ? scaleExamValue(t, mine, h) : TYPICAL_EXAM_VALUES[h][t] ?? 0;
      out[t] = { value: x?.used ?? fallback, learned: x?.learned ?? null, override: x?.override ?? null, exams: x?.exams ?? null, low_sample: !!x?.low_sample, source: x?.override != null ? 'override' : x?.learned != null ? 'history' : mine != null ? 'owner' : 'typical' };
    }
    return { values: out, source: 'diagnosis', horizon: h };
  }
  const out = {};
  for (const t of Object.keys(EXAM_TYPE_LABELS)) {
    const mine = own[t]?.value_cents;
    out[t] = { value: mine != null ? scaleExamValue(t, mine, h) : TYPICAL_EXAM_VALUES[h][t], learned: null, override: mine ?? null, source: mine != null ? 'owner' : 'typical' };
  }
  return { values: out, source: 'owner', horizon: h };
}
const addMonthsTo = (d, n) => {
  const [y, m, day] = d.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1 + n, day));
  return x.toISOString().slice(0, 10);
};
export async function examsBusiness(db, user, { date, locationId = null, money, weekStartDay = 1, horizon = 5 }) {
  const pid = user.practice_id;
  const own = await examSettings(db, pid);
  const today = await examCounts(db, user, { from: date, to: date, locationId });
  const targets = examTargets(today.counts, Object.fromEntries(Object.entries(own).filter(([, v]) => v.daily_target != null).map(([t, v]) => [t, v.daily_target])));
  const out = { date, source: today.source, today: targets };
  if (!money) return out;
  const { values, source, horizon: h } = await examValuesFor(db, pid, { horizon, locationId, today: date });
  const valueOf = Object.fromEntries(Object.entries(values).map(([t, v]) => [t, v.value]));
  const wk = weekStart(date, weekStartDay);
  const monthFrom = `${date.slice(0, 7)}-01`;
  const monthTo = addDays(`${addDays(monthFrom, 32).slice(0, 7)}-01`, -1);
  const periods = [
    { key: 'today', label: 'Today’s', from: date, to: date },
    { key: 'week', label: 'This week’s', from: wk, to: addDays(wk, 6) },
    { key: 'month', label: 'This month’s', from: monthFrom, to: monthTo },
  ];
  out.values = values;
  out.values_source = source;
  out.horizon_months = h;
  out.horizons = EXAM_HORIZONS;
  out.support = [];
  for (const p of periods) {
    const c = p.key === 'today' ? today : await examCounts(db, user, { from: p.from, to: p.to, locationId });
    // The goal for the coming `h` months from the period's start, at the period's share of those months.
    const hTo = addDays(addMonthsTo(p.from, h), -1);
    const goals = await metrics.goalsFor(db, pid, { from: p.from, to: hTo, locationId });
    const goalH = goals.production_gross?.goal ?? null;
    const share = (dateRange(p.from, p.to).length) / dateRange(p.from, hTo).length;
    const goal = goalH != null ? rnd(goalH * share) : null;
    out.support.push({
      period: p.key, from: p.from, to: p.to, counts: c.counts, goal_horizon: goalH, goal_horizon_to: hTo, goal_source: goals.production_gross?.source ?? null,
      ...examSupport({ counts: c.counts, values: valueOf, goal, label: p.label }),
    });
  }
  return out;
}

// ---- The end-of-day email (BD4): the day's business numbers for an owner ----
// Only for someone who may see the business view; the labor figures only with timeclock:rates. Totals only — no
// patient and no one's pay. Returns email blocks (email/layout.js), or [] for anyone else.
export async function businessDigestBlocks(db, { practiceId, userId, date, locationId = null, nowMs = Date.now() }) {
  if (!userId) return [];
  const row = await db.get(`${USER_PERMISSION_SQL} WHERE u.id = ? AND u.practice_id = ?`, userId, practiceId);
  if (!row || !row.active) return [];
  const user = { ...row, location_ids: row.location_ids ? JSON.parse(row.location_ids) : null };
  user.perms = effectivePermissions(user);
  if (!can(user, 'business:view')) return [];
  const rates = can(user, 'timeclock:rates');
  const t = await todayBusiness(db, user, { date, locationId, nowMs, rates, today: date });
  const money = (c) => (c == null ? '—' : `$${Math.round(c / 100).toLocaleString('en-US')}`);
  const blocks = [{ type: 'heading', text: 'The business side of the day' }];
  const parts = [`Production ${money(t.production.completed)} done of ${money(t.production.scheduled)} scheduled`, `expected collections ${money(t.collections.expected)}`, `margin ${money(t.margin.total)} (${money(t.margin.per_chair_hour)} a chair-hour)`];
  if (rates && !t.labor.hidden) parts.push(`labor ${money(t.labor.projected)} = ${t.labor.pct_of_production ?? '—'}% of production (target ${t.labor_target.low}–${t.labor_target.high}%)`, `profit after fixed costs ${money(t.profit)}`);
  blocks.push({ type: 'text', text: `${parts.join(' · ')}.` });
  const notes = [];
  if (t.below_cost.visits) notes.push(`${t.below_cost.visits} visit${t.below_cost.visits === 1 ? '' : 's'} earned less than the chair costs to run (${money(t.below_cost.shortfall)} short).`);
  if (t.productivity.idle_minutes_day >= 60) notes.push(`${Math.round(t.productivity.idle_minutes_day / 6) / 10} hours on the clock with nothing scheduled${rates && t.labor.idle_cost_day ? ` (${money(t.labor.idle_cost_day)})` : ''}.`);
  for (const o of t.overtime.slice(0, 3)) notes.push(`${o.name}: overtime this week${rates && o.premium ? ` (+${money(o.premium)})` : ''}.`);
  if (notes.length) blocks.push({ type: 'list', title: 'Worth a look', items: notes });
  return blocks;
}

export const categoryList = CATEGORIES;
export const localToUtcMs = localToUtc;
export const canRates = (user) => can(user, 'timeclock:rates');
