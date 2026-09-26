// Report library: the ready-made reports office managers know by name from other practice software
// (production by provider, collections, aging, unscheduled treatment, no-shows…), each declared once here:
//   { id, name, category, description, params, columns, run(ctx) → { rows, totals?, note? } }.
// The routes (routes/reportlibrary.js) list them, run them with validated filters, and export CSV; the saved-reports
// job can email the ones without admin-only data. Rules every report follows:
//  - practice-scoped (ctx.pid) and held to the person's offices (ctx.office / ctx.patients) — see officeaccess.js;
//  - money comes from the ledger (SUM(amount), integer cents). Voided entries and their reversals net to zero, so
//    sums include both; counts only count live entries. Planned work (scheduled / unscheduled treatment) and claims
//    show fees and estimates, which aren't money yet, and say so;
//  - SQL runs on SQLite and Postgres: no json_extract, every '?' compared with a column, sorting of NULLs in JS.
import { HttpError } from './auth.js';
import { practiceNow, utcRange, isRealDate, addMonths, toCsv } from './util.js';
import { patientScope, restricted } from './officeaccess.js';
import { agingReport } from './aging.js';
import { allocationsForRange } from './allocation.js';
import { providerHoursFor, officeHours, weekday } from './hours.js';
import { REPORTS as SAVED_REPORTS, rangeFor } from './savedreports.js';
import { MARKETING_LIBRARY_REPORT } from './marketing.js';
import { diagnosisFunnel } from './diagnosis.js';

export const MAX_ROWS = 5000;
const MAX_RANGE_DAYS = 3 * 366 + 1;
const NAME = "p.first_name || ' ' || p.last_name";
const LIVE = 'l.voided_at IS NULL AND l.reverses_id IS NULL';

export const CATEGORIES = ['Production', 'Collections', 'Accounts receivable', 'Patients', 'Treatment', 'Scheduling', 'Insurance', 'Office'];

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const monthEnd = (month) => addDays(`${addMonths(`${month}-01`, 1).slice(0, 7)}-01`, -1);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const num = (v) => Number(v || 0);
const bucketOf = (days) => (days <= 30 ? 'd0_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus');
const TYPE_LABEL = { payment: 'Patient payment', insurance_payment: 'Insurance payment', refund: 'Refund', charge: 'Charge', adjustment: 'Adjustment' };
const title = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
const entryStatus = (e) => (e.reverses_id ? 'Reversal' : e.voided_at ? 'Voided' : '');

// SQL fragments are { sql, args }; join() puts several after a WHERE clause in order.
const frag = (sql = '', args = []) => ({ sql, args });
const join = (...parts) => ({ sql: parts.map((p) => p.sql).join(''), args: parts.flatMap((p) => p.args) });

// Common column shapes.
const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const money = (key, label, extra = {}) => col(key, label, 'money', { sum: true, ...extra });
const count = (key, label, extra = {}) => col(key, label, 'int', { sum: true, ...extra });
const patientCol = col('patient', 'Patient', 'patient');

// ---------------------------------------------------------------------------------------------------------------
// Shared queries

// Ledger money per type (and payment method) in a date range, for the summaries.
async function ledgerByType(ctx, from, to) {
  const w = ctx.office('l.location_id');
  return ctx.db.all(
    `SELECT l.type, COALESCE(l.method, '') AS method, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS n, SUM(l.amount) AS amount
     FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ?${w.sql}
     GROUP BY l.type, COALESCE(l.method, '')`, ctx.pid, from, to, ...w.args,
  );
}
const typeSum = (rows, type, key = 'amount') => rows.filter((r) => r.type === type).reduce((s, r) => s + num(r[key]), 0);

async function appointmentCounts(ctx, from, to) {
  const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
  const rows = await ctx.db.all(
    `SELECT a.status, COUNT(*) AS n FROM real_appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${w.sql} GROUP BY a.status`,
    ctx.pid, `${from} 00:00`, `${to} 24:00`, ...w.args,
  );
  return Object.fromEntries(rows.map((r) => [r.status, num(r.n)]));
}

async function newPatientCount(ctx, from, to) {
  const [f, t] = await utcRange(ctx.db, ctx.pid, from, to);
  const s = ctx.patients('p');
  return num((await ctx.db.get(`SELECT COUNT(*) AS n FROM real_patients p WHERE p.practice_id = ? AND p.merged_into_id IS NULL AND p.created_at >= ? AND p.created_at < ?${s.sql}`, ctx.pid, f, t, ...s.args)).n);
}

// Payment allocation (allocation.js): which provider's work each payment and credit adjustment paid for.
// With an office chosen, the work has to have been done at that office (unapplied credit: taken there).
async function allocatedByProvider(ctx) {
  const all = await allocationsForRange(ctx.db, ctx.pid, ctx.from, ctx.to);
  if (!ctx.officeIds) return all;
  const ids = [...new Set(all.map((a) => a.charge_id || a.credit_id).filter(Boolean))];
  const where = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of await ctx.db.all(`SELECT id, location_id FROM real_ledger_entries ledger_entries WHERE practice_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, ctx.pid, ...chunk)) where.set(r.id, r.location_id);
  }
  return all.filter((a) => ctx.officeIds.includes(where.get(a.charge_id || a.credit_id)));
}

async function chargesByProvider(ctx) {
  const w = join(ctx.office('l.location_id'), ctx.provider('l.provider_id'));
  return ctx.db.all(
    `SELECT l.provider_id, SUM(l.amount) AS production FROM real_ledger_entries l
     WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql} GROUP BY l.provider_id`, ctx.pid, ctx.from, ctx.to, ...w.args,
  );
}

async function providerNames(ctx) {
  return new Map((await ctx.db.all('SELECT id, name, type FROM providers WHERE practice_id = ?', ctx.pid)).map((p) => [p.id, p]));
}

// Open claims (sent, not fully answered) with who they're for and what's still expected from the payer:
// the estimate less what's been paid, or the billed fee when there's no estimate.
async function openClaims(ctx, statuses) {
  const w = ctx.officeOrPatient('c.location_id', 'p');
  const rows = await ctx.db.all(
    `SELECT c.id, c.patient_id, ${NAME} AS patient, c.status, c.total_fee, c.estimated_amount, c.paid_amount, c.denial_reason,
       c.submitted_at, c.created_at, c.follow_up_date, ic.name AS carrier, ic.id AS carrier_id
     FROM real_claims c JOIN real_patients p ON p.id = c.patient_id
     JOIN real_patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id
     WHERE c.practice_id = ? AND c.status IN (${statuses.map(() => '?').join(',')})${w.sql}`, ctx.pid, ...statuses, ...w.args,
  );
  return rows.map((c) => {
    const since = String(c.submitted_at || c.created_at).slice(0, 10);
    const days = Math.max(0, daysBetween(since, ctx.today));
    return { ...c, since, days, outstanding: Math.max(0, (c.estimated_amount > 0 ? c.estimated_amount : c.total_fee) - c.paid_amount) };
  });
}

// Treatment plan procedures presented in the range: one row per procedure, with its plan.
async function presentedPlans(ctx) {
  const [f, t] = await utcRange(ctx.db, ctx.pid, ctx.from, ctx.to);
  const w = join(ctx.provider('pr.provider_id'), ctx.patients('p'));
  return ctx.db.all(
    `SELECT tp.id AS plan_id, tp.status AS plan_status, tp.signed_at, COALESCE(tp.presented_at, tp.created_at) AS presented,
       pr.fee, pr.status, pr.appointment_id, pr.provider_id
     FROM real_treatment_plans tp JOIN real_procedures pr ON pr.treatment_plan_id = tp.id JOIN real_patients p ON p.id = tp.patient_id
     WHERE tp.practice_id = ? AND COALESCE(tp.presented_at, tp.created_at) >= ? AND COALESCE(tp.presented_at, tp.created_at) < ? AND pr.status != 'cancelled'${w.sql}`,
    ctx.pid, f, t, ...w.args,
  );
}
// Accepted: the plan was accepted or signed, or the procedure is already booked or done (same as /reports/treatment-plans).
const planAccepted = (r) => ['accepted', 'completed'].includes(r.plan_status) || !!r.signed_at;
const procAccepted = (r) => planAccepted(r) || r.status === 'completed' || !!r.appointment_id;

// Summary rows (end of day, month end): section / item / count / amount / rate.
const line = (section, item, { n = null, amount = null, rate = null } = {}) => ({ section, item, count: n, amount, rate });
const SUMMARY_COLUMNS = [col('section', 'Section'), col('item', 'Item'), col('count', 'Count', 'int'), col('amount', 'Amount', 'money'), col('rate', 'Rate', 'pct')];

// ---------------------------------------------------------------------------------------------------------------
// The reports. params: which filters apply — range (from/to), date, month, as_of, provider, office, group,
// fee_schedule. range: the default dates (mtd = this month so far, month = the whole month, next7/next30, ytd).
// phi: rows name patients (scheduled emails then carry totals only). admin: administrators only. practiceWide:
// covers every office, so not open to someone limited to some offices.

const R = [];
const def = (d) => R.push({ params: [], range: 'mtd', phi: false, ...d });

// ---- Production ----

// Production & income (PR1): the one-screen report. Built from the same ledger sums as the reports below, so its
// numbers match them exactly: gross = charges (production-by-provider / by-day), adjustments split into PPO
// (insurance) write-offs and everything else (the adjustments-by-type split: an 'Insurance write-off' or an
// adjustment on a claim), net = gross + adjustments, collections = patient + insurance payments (refunds shown
// apart, as on the month-end summary), collection % = collections ÷ net. Voided entries and their reversals net to
// zero. Per provider: production by the charge's provider, payments and credit adjustments by the work they paid
// for (allocation.js, as collections-by-provider and gross-vs-net do); whatever can't be tied to a provider's work
// in the dates (unapplied credit, debit adjustments, corrections of other periods) is its own row, so the provider
// rows always add up to the office total. Run over today, it also projects the month: production so far this
// month + the fees of work still planned on this month's visits from today on (not money yet), beside the goal.
const IS_PPO = "(COALESCE(l.adjustment_type, '') = 'Insurance write-off' OR l.claim_id IS NOT NULL)";
export const PI_METRICS = ['gross', 'ppo_writeoffs', 'other_adjustments', 'adjustments', 'net', 'patient', 'insurance', 'collections', 'refunds', 'scheduled', 'month_to_date'];
const NO_PROVIDER = 'none';

async function hasTable(db, name) {
  const row = db.dialect === 'postgres'
    // Only this database's schema: another schema (a test's, or a second app on the server) may have the table.
    ? await db.get('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?', name)
    : await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  return !!row;
}

// The month's production goal: the goal set for the office (or the practice) on the KPI goals screen
// (metric_goals, gross production per month), else the practice's daily goal × the office's open days that month.
// Someone limited to some offices only sees an office's own goal. None set: null (the screen leaves it blank).
async function monthlyProductionGoal(ctx, month) {
  const scope = ctx.locationId ? `location:${ctx.locationId}` : ctx.officeIds ? null : 'practice';
  if (!scope) return null;
  if (await hasTable(ctx.db, 'metric_goals')) {
    const row = await ctx.db.get("SELECT value FROM metric_goals WHERE practice_id = ? AND metric = 'production_gross' AND scope_key = ?", ctx.pid, scope);
    if (row && num(row.value) > 0) return { amount: num(row.value), source: ctx.locationId ? 'Office monthly goal' : 'Practice monthly goal' };
  }
  if (scope !== 'practice') return null;
  const p = await ctx.db.get('SELECT daily_goal, office_hours FROM practices WHERE id = ?', ctx.pid);
  if (!(num(p?.daily_goal) > 0)) return null;
  const hours = officeHours(p);
  let open = 0;
  for (let d = `${month}-01`; d <= monthEnd(month); d = addDays(d, 1)) if ((hours[weekday(d)] || []).length) open++;
  return { amount: num(p.daily_goal) * open, source: `Daily goal × ${open} open days` };
}

// Credit entries' kinds (PPO write-off or other adjustment), for allocations.
async function ppoCredits(ctx, ids) {
  const out = new Set();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = await ctx.db.all(`SELECT l.id FROM real_ledger_entries l WHERE l.practice_id = ? AND l.id IN (${chunk.map(() => '?').join(',')}) AND l.type = 'adjustment' AND ${IS_PPO}`, ctx.pid, ...chunk);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

// Planned (not yet done) procedure fees on visits from `from` to `to` that aren't cancelled or missed.
function plannedSql(ctx, from, to, joins = '') {
  const w = ctx.office('a.location_id', { nullable: true });
  return {
    sql: `FROM real_procedures pr JOIN real_appointments a ON a.id = pr.appointment_id${joins}
      WHERE pr.practice_id = ? AND pr.status = 'planned' AND a.status NOT IN ('cancelled','no_show') AND a.start_time >= ? AND a.start_time < ?${w.sql}`,
    args: [ctx.pid, `${from} 00:00`, `${to} 24:00`, ...w.args],
  };
}

export async function productionIncome(ctx) {
  const w = ctx.office('l.location_id');
  const dayRows = await ctx.db.all(
    `SELECT l.entry_date AS day,
       SUM(CASE WHEN l.type = 'charge' AND l.retail_sale_id IS NULL THEN l.amount ELSE 0 END) AS gross,
       SUM(CASE WHEN l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL THEN l.amount ELSE 0 END) AS adjustments,
       SUM(CASE WHEN l.type = 'adjustment' AND ${IS_PPO} THEN l.amount ELSE 0 END) AS ppo_writeoffs,
       -SUM(CASE WHEN l.type = 'payment' THEN l.amount ELSE 0 END) AS patient,
       -SUM(CASE WHEN l.type = 'insurance_payment' THEN l.amount ELSE 0 END) AS insurance,
       SUM(CASE WHEN l.type = 'refund' THEN l.amount ELSE 0 END) AS refunds
     FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ?${w.sql}
     GROUP BY l.entry_date ORDER BY l.entry_date`, ctx.pid, ctx.from, ctx.to, ...w.args,
  );
  const blank = () => ({ gross: 0, ppo_writeoffs: 0, other_adjustments: 0, adjustments: 0, net: 0, patient: 0, insurance: 0, collections: 0, refunds: 0 });
  const finish = (r) => Object.assign(r, { other_adjustments: r.adjustments - r.ppo_writeoffs, net: r.gross + r.adjustments, collections: r.patient + r.insurance, collection_pct: pct(r.patient + r.insurance, r.gross + r.adjustments) });
  const totals = blank();
  const running = { gross: 0, net: 0, collections: 0 };
  const days = dayRows.map((raw) => {
    const r = finish({ ...blank(), day: raw.day, ...Object.fromEntries(['gross', 'adjustments', 'ppo_writeoffs', 'patient', 'insurance', 'refunds'].map((k) => [k, num(raw[k])])) });
    for (const k of ['gross', 'adjustments', 'ppo_writeoffs', 'patient', 'insurance', 'refunds']) totals[k] += r[k];
    running.gross += r.gross;
    running.net += r.net;
    running.collections += r.collections;
    return { ...r, running_gross: running.gross, running_net: running.net, running_collections: running.collections };
  }).filter((r) => r.gross || r.adjustments || r.collections || r.refunds);
  finish(totals);

  // Providers.
  const names = await providerNames(ctx);
  const byProvider = new Map();
  const row = (id) => {
    const key = id ?? NO_PROVIDER;
    if (!byProvider.has(key)) byProvider.set(key, { provider_id: id ?? null, provider: id ? names.get(id)?.name || 'Provider' : 'Not tied to a provider', ...blank(), scheduled: 0, month_to_date: 0 });
    return byProvider.get(key);
  };
  for (const c of await chargesByProvider(ctx)) row(c.provider_id).gross += num(c.production);
  const allocations = await allocatedByProvider(ctx);
  const ppo = await ppoCredits(ctx, allocations.filter((a) => a.credit_type === 'adjustment').map((a) => a.credit_id));
  for (const a of allocations) {
    const r = row(a.unapplied ? null : a.provider_id);
    if (a.credit_type === 'payment') r.patient += a.amount;
    else if (a.credit_type === 'insurance_payment') r.insurance += a.amount;
    else if (a.credit_type === 'adjustment') {
      r.adjustments -= a.amount;
      if (ppo.has(a.credit_id)) r.ppo_writeoffs -= a.amount;
    }
  }
  // Whatever the allocation couldn't place stays visible, so the rows add up to the office total.
  const rest = row(null);
  for (const k of ['gross', 'adjustments', 'ppo_writeoffs', 'patient', 'insurance', 'refunds']) {
    const placed = [...byProvider.values()].reduce((s, r) => s + r[k], 0);
    rest[k] += totals[k] - placed;
  }
  for (const r of byProvider.values()) finish(r);

  // The month, when the dates run through today: done so far + still planned on the books, beside the goal.
  let projection = null;
  if (ctx.from <= ctx.today && ctx.to >= ctx.today) {
    const month = ctx.today.slice(0, 7);
    const first = `${month}-01`;
    const last = monthEnd(month);
    const mw = join(ctx.office('l.location_id'));
    const mtd = await ctx.db.all(
      `SELECT l.provider_id, SUM(l.amount) AS production FROM real_ledger_entries l
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${mw.sql} GROUP BY l.provider_id`, ctx.pid, first, ctx.today, ...mw.args,
    );
    const q = plannedSql(ctx, ctx.today, last);
    const sched = await ctx.db.all(`SELECT a.provider_id, COUNT(DISTINCT a.id) AS visits, COALESCE(SUM(pr.fee), 0) AS scheduled ${q.sql} GROUP BY a.provider_id`, ...q.args);
    for (const m of mtd) row(m.provider_id).month_to_date += num(m.production);
    for (const s of sched) row(s.provider_id).scheduled += num(s.scheduled);
    const mtdTotal = mtd.reduce((s, m) => s + num(m.production), 0);
    const scheduled = sched.reduce((s, m) => s + num(m.scheduled), 0);
    const goal = await monthlyProductionGoal(ctx, month);
    const projected = mtdTotal + scheduled;
    projection = {
      month, from: first, to: last, scheduled_from: ctx.today, month_to_date: mtdTotal, scheduled, visits: sched.reduce((s, m) => s + num(m.visits), 0), projected,
      goal: goal?.amount ?? null, goal_source: goal?.source ?? null, goal_pct: goal ? pct(projected, goal.amount) : null, to_goal: goal ? goal.amount - projected : null,
    };
  }
  for (const r of byProvider.values()) r.projected = projection ? r.month_to_date + r.scheduled : null;
  const providers = [...byProvider.values()]
    .filter((r) => ['gross', 'adjustments', 'patient', 'insurance', 'refunds', 'scheduled', 'month_to_date'].some((k) => r[k]))
    .sort((a, b) => (a.provider_id == null) - (b.provider_id == null) || b.gross - a.gross || String(a.provider).localeCompare(String(b.provider)));
  return { from: ctx.from, to: ctx.to, location_id: ctx.locationId ?? null, totals, providers, days, projection };
}

// The entries behind a number on the Production & income screen: ledger entries for an office number, the
// allocated part of each credit for a provider's collections or adjustments, planned procedures for "scheduled".
// Amounts carry the sign the number shows (collections positive, adjustments negative), so they add up to it.
export async function productionIncomeEntries(ctx, { metric, providerId = null, day = null, limit = 2000 }) {
  if (!PI_METRICS.includes(metric)) throw new HttpError(400, `metric must be one of ${PI_METRICS.join(', ')}`);
  const from = day || ctx.from;
  const to = day || ctx.to;
  if (day && (!isRealDate(day) || day < ctx.from || day > ctx.to)) throw new HttpError(400, 'day must be a date within the report');
  const none = providerId === NO_PROVIDER;
  if (providerId != null && !none && !(await ctx.db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', providerId, ctx.pid))) throw new HttpError(404, 'Provider not found');
  const month = ctx.today.slice(0, 7);
  if (metric === 'scheduled') {
    const q = plannedSql(ctx, ctx.today, monthEnd(month), ' JOIN real_patients p ON p.id = a.patient_id LEFT JOIN providers pv ON pv.id = a.provider_id');
    const pw = providerId == null ? frag() : none ? frag(' AND a.provider_id IS NULL') : frag(' AND a.provider_id = ?', [providerId]);
    const rows = await ctx.db.all(
      `SELECT pr.id, substr(a.start_time, 1, 10) AS entry_date, a.id AS appointment_id, a.patient_id, ${NAME} AS patient, pr.code, pr.tooth, pr.description, pv.name AS provider, pr.fee AS amount
       ${q.sql}${pw.sql} ORDER BY a.start_time, pr.id LIMIT ${Number(limit)}`, ...q.args, ...pw.args,
    );
    return { metric, kind: 'planned', rows: rows.map((r) => ({ ...r, type_label: 'Planned', status: '' })), total: rows.reduce((s, r) => s + num(r.amount), 0) };
  }
  const types = {
    gross: ['charge'], month_to_date: ['charge'], ppo_writeoffs: ['adjustment'], other_adjustments: ['adjustment'], adjustments: ['adjustment'], net: ['charge', 'adjustment'],
    patient: ['payment'], insurance: ['insurance_payment'], collections: ['payment', 'insurance_payment'], refunds: ['refund'],
  }[metric];
  const credit = !types.includes('charge') && metric !== 'refunds';
  const sign = ['patient', 'insurance', 'collections'].includes(metric) ? -1 : 1;
  const [f, t] = metric === 'month_to_date' ? [`${month}-01`, ctx.today] : [from, to];
  const kind = metric === 'ppo_writeoffs' ? ` AND ${IS_PPO}` : metric === 'other_adjustments' ? ` AND NOT ${IS_PPO}` : '';
  const select = `SELECT l.id, l.entry_date, l.patient_id, ${NAME} AS patient, l.type, l.description, l.adjustment_type, l.voided_at, l.reverses_id, pr.code, pr.tooth, pv.name AS provider, l.amount
    FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id LEFT JOIN real_procedures pr ON pr.id = l.procedure_id LEFT JOIN providers pv ON pv.id = l.provider_id`;
  const shape = (r, amount) => ({ ...r, type_label: r.adjustment_type || TYPE_LABEL[r.type], status: entryStatus(r), amount });
  // An office number (or a provider's production): the ledger entries themselves.
  if (providerId == null || !credit) {
    const w = join(ctx.office('l.location_id'), providerId == null ? frag() : none ? frag(' AND l.provider_id IS NULL') : frag(' AND l.provider_id = ?', [providerId]));
    const rows = await ctx.db.all(
      `${select} WHERE l.practice_id = ? AND l.type IN (${types.map(() => '?').join(',')}) AND l.entry_date BETWEEN ? AND ?${kind}${w.sql} ORDER BY l.entry_date, l.id LIMIT ${Number(limit)}`,
      ctx.pid, ...types, f, t, ...w.args,
    );
    const out = rows.map((r) => shape(r, sign * num(r.amount)));
    return { metric, kind: 'ledger', rows: out, total: out.reduce((s, r) => s + r.amount, 0) };
  }
  // A provider's collections or adjustments: the part of each credit applied to their work (unapplied: no provider).
  const sub = { ...ctx, from, to };
  const want = { patient: ['payment'], insurance: ['insurance_payment'], collections: ['payment', 'insurance_payment'] }[metric] || ['adjustment'];
  let allocs = (await allocatedByProvider(sub)).filter((a) => want.includes(a.credit_type) && (none ? a.unapplied || a.provider_id == null : a.provider_id === providerId && !a.unapplied));
  if (metric === 'ppo_writeoffs' || metric === 'other_adjustments') {
    const ppo = await ppoCredits(ctx, allocs.map((a) => a.credit_id));
    allocs = allocs.filter((a) => ppo.has(a.credit_id) === (metric === 'ppo_writeoffs'));
  }
  const entries = new Map();
  const ids = [...new Set(allocs.map((a) => a.credit_id))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of await ctx.db.all(`${select} WHERE l.practice_id = ? AND l.id IN (${chunk.map(() => '?').join(',')})`, ctx.pid, ...chunk)) entries.set(r.id, r);
  }
  const bySign = sign === -1 ? 1 : -1;
  const out = allocs.filter((a) => entries.has(a.credit_id)).map((a) => shape({ ...entries.get(a.credit_id), applied: true, entry_amount: num(entries.get(a.credit_id).amount) }, bySign * a.amount))
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id)).slice(0, limit);
  return {
    metric, kind: 'allocated', rows: out, total: out.reduce((s, r) => s + r.amount, 0),
    note: none ? 'Credit not applied to any provider’s work. Debit adjustments and corrections from other dates also land on this row.' : 'The part of each payment or credit applied to this provider’s work.',
  };
}

def({
  id: 'production-income', name: 'Production & income', category: 'Production',
  description: 'Gross production, write-offs, net production, collections and collection % by provider — and, run mid-month, the projected month against the goal.',
  params: ['range', 'office'],
  columns: [
    col('provider', 'Provider'), money('gross', 'Gross production'), money('ppo_writeoffs', 'PPO write-offs'), money('other_adjustments', 'Other adjustments'), money('net', 'Net production'),
    money('patient', 'Patient payments'), money('insurance', 'Insurance payments'), money('collections', 'Collections'), col('collection_pct', 'Collection %', 'pct'), money('scheduled', 'Scheduled rest of month'),
  ],
  async run(ctx) {
    const r = await productionIncome(ctx);
    const p = r.projection;
    const $$ = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const note = [
      'Write-offs and payments are credited to the provider whose work they reduced or paid for; what can’t be placed is on its own row.',
      p ? `${p.month}: ${$$(p.month_to_date)} done so far + ${$$(p.scheduled)} still scheduled = ${$$(p.projected)} projected${p.goal != null ? ` against a goal of ${$$(p.goal)} (${p.goal_pct}%)` : ''}. Scheduled work is planned fees, not money yet.` : null,
    ].filter(Boolean).join(' ');
    return { rows: r.providers.map((x) => ({ ...x, scheduled: p ? x.scheduled : null })), totals: { collection_pct: r.totals.collection_pct, scheduled: p ? p.scheduled : null }, note };
  },
});

def({
  id: 'production-by-provider', name: 'Production by provider', category: 'Production',
  description: 'How much work each provider completed (ledger charges) in the dates.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Provider'), count('procedures', 'Procedures'), money('production', 'Production'), col('share', 'Share', 'pct')],
  async run(ctx) {
    const w = join(ctx.office('l.location_id'), ctx.provider('l.provider_id'));
    const rows = await ctx.db.all(
      `SELECT l.provider_id, COALESCE(pv.name, 'No provider') AS provider, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS procedures, SUM(l.amount) AS production
       FROM real_ledger_entries l LEFT JOIN providers pv ON pv.id = l.provider_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY l.provider_id, pv.name`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const total = rows.reduce((s, r) => s + num(r.production), 0);
    return { rows: rows.map((r) => ({ ...r, share: pct(num(r.production), total) })).sort((a, b) => b.production - a.production), totals: { share: total ? 100 : null } };
  },
});

def({
  id: 'production-by-code', name: 'Production by procedure code', category: 'Production',
  description: 'Which procedures were done, how often, and what they produced.',
  params: ['range', 'provider', 'office'],
  columns: [col('code', 'Code'), col('description', 'Description'), count('count', 'Count'), money('production', 'Production'), money('average', 'Average fee', { sum: false })],
  async run(ctx) {
    const w = join(ctx.office('l.location_id'), ctx.provider('l.provider_id'));
    const rows = await ctx.db.all(
      `SELECT COALESCE(pr.code, '(no code)') AS code, MIN(COALESCE(pr.description, l.description)) AS description,
         SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS count, SUM(l.amount) AS production
       FROM real_ledger_entries l LEFT JOIN real_procedures pr ON pr.id = l.procedure_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.filter((r) => num(r.count) || num(r.production)).map((r) => ({ ...r, average: r.count ? Math.round(r.production / r.count) : null })).sort((a, b) => b.production - a.production || (a.code < b.code ? -1 : 1)) };
  },
});

def({
  id: 'production-by-category', name: 'Production by category', category: 'Production',
  description: 'Production split into diagnostic, preventive, restorative, perio, surgery and so on.',
  params: ['range', 'provider', 'office'],
  columns: [col('category', 'Category'), count('count', 'Procedures'), money('production', 'Production'), col('share', 'Share', 'pct')],
  async run(ctx) {
    const w = join(ctx.office('l.location_id'), ctx.provider('l.provider_id'));
    const rows = await ctx.db.all(
      `SELECT COALESCE(pr.category, 'other') AS category, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS count, SUM(l.amount) AS production
       FROM real_ledger_entries l LEFT JOIN real_procedures pr ON pr.id = l.procedure_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql} GROUP BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const total = rows.reduce((s, r) => s + num(r.production), 0);
    return { rows: rows.map((r) => ({ ...r, category: title(r.category), share: pct(num(r.production), total) })).sort((a, b) => b.production - a.production), totals: { share: total ? 100 : null } };
  },
});

def({
  id: 'production-by-day', name: 'Production by day', category: 'Production',
  description: 'Each day’s production, adjustments and collections side by side.',
  params: ['range', 'office'],
  columns: [col('day', 'Date', 'date'), money('production', 'Production'), money('adjustments', 'Adjustments'), money('net', 'Net production'), money('collections', 'Collections')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT l.entry_date AS day,
         SUM(CASE WHEN l.type = 'charge' AND l.retail_sale_id IS NULL THEN l.amount ELSE 0 END) AS production,
         SUM(CASE WHEN l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL THEN l.amount ELSE 0 END) AS adjustments,
         -SUM(CASE WHEN l.type IN ('payment','insurance_payment') THEN l.amount ELSE 0 END) AS collections
       FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY l.entry_date ORDER BY l.entry_date`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, net: num(r.production) + num(r.adjustments) })) };
  },
});

def({
  id: 'gross-vs-net-production', name: 'Gross vs. net production', category: 'Production',
  description: 'Production before and after write-offs and discounts, by provider.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Provider'), money('gross', 'Gross production'), money('adjustments', 'Write-offs & discounts'), money('net', 'Net production'), col('net_pct', 'Net %', 'pct')],
  async run(ctx) {
    const names = await providerNames(ctx);
    const rows = new Map();
    const row = (id) => {
      const key = id ?? 'none';
      if (!rows.has(key)) rows.set(key, { provider_id: id ?? null, provider: id ? names.get(id)?.name || 'Provider' : 'Not applied to work', gross: 0, adjustments: 0 });
      return rows.get(key);
    };
    for (const c of await chargesByProvider(ctx)) row(c.provider_id).gross += num(c.production);
    for (const a of await allocatedByProvider(ctx)) {
      if (a.credit_type !== 'adjustment') continue;
      if (ctx.providerId && a.provider_id !== ctx.providerId) continue;
      row(a.provider_id).adjustments -= a.amount;
    }
    const list = [...rows.values()].map((r) => ({ ...r, net: r.gross + r.adjustments, net_pct: pct(r.gross + r.adjustments, r.gross) })).sort((a, b) => b.gross - a.gross);
    const g = list.reduce((s, r) => s + r.gross, 0);
    const n = list.reduce((s, r) => s + r.net, 0);
    return { rows: list, totals: { net_pct: pct(n, g) }, note: 'Write-offs are credited to the work they reduced (insurance write-offs by the procedures on the claim, other credits oldest charge first).' };
  },
});

def({
  id: 'scheduled-production', name: 'Scheduled production', category: 'Production',
  description: 'What’s booked ahead: visits and the fees of the procedures planned on them, by day and provider.',
  params: ['range', 'provider', 'office'], range: 'next30',
  columns: [col('day', 'Date', 'date'), col('provider', 'Provider'), count('visits', 'Visits'), money('scheduled', 'Scheduled fees')],
  async run(ctx) {
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const rows = await ctx.db.all(
      `SELECT substr(a.start_time, 1, 10) AS day, a.provider_id, pv.name AS provider, COUNT(DISTINCT a.id) AS visits, COALESCE(SUM(pr.fee), 0) AS scheduled
       FROM real_appointments a JOIN providers pv ON pv.id = a.provider_id
       LEFT JOIN real_procedures pr ON pr.appointment_id = a.id AND pr.status != 'cancelled'
       WHERE a.practice_id = ? AND a.status NOT IN ('cancelled','no_show') AND a.start_time >= ? AND a.start_time < ?${w.sql}
       GROUP BY substr(a.start_time, 1, 10), a.provider_id, pv.name`, ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...w.args,
    );
    return { rows: rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.provider).localeCompare(String(b.provider)))), note: 'Fees of planned procedures, not money yet. A visit counts once however many procedures it has.' };
  },
});

def({
  id: 'hygiene-production', name: 'Hygiene production & reappointment', category: 'Production',
  description: 'Each hygienist’s production, visits, and how many patients left with their next visit booked.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Hygienist'), money('production', 'Production'), count('visits', 'Visits'), money('per_visit', 'Per visit', { sum: false }), count('reappointed', 'Reappointed'), col('reappointment_rate', 'Reappointment %', 'pct')],
  async run(ctx) {
    const lw = join(ctx.office('l.location_id'), ctx.provider('l.provider_id'));
    const prod = await ctx.db.all(
      `SELECT l.provider_id, SUM(l.amount) AS production FROM real_ledger_entries l JOIN providers pv ON pv.id = l.provider_id
       WHERE l.practice_id = ? AND pv.type = 'hygienist' AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${lw.sql} GROUP BY l.provider_id`,
      ctx.pid, ctx.from, ctx.to, ...lw.args,
    );
    const aw = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const visits = await ctx.db.all(
      `SELECT a.provider_id, COUNT(*) AS visits, SUM(CASE WHEN EXISTS (SELECT 1 FROM real_appointments b WHERE b.patient_id = a.patient_id AND b.start_time > a.start_time
           AND b.status NOT IN ('cancelled','no_show') AND substr(b.created_at, 1, 10) <= substr(a.start_time, 1, 10)) THEN 1 ELSE 0 END) AS reappointed
       FROM real_appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?${aw.sql}
       GROUP BY a.provider_id`, ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...aw.args,
    );
    const pw = ctx.provider('id');
    const hygienists = await ctx.db.all(`SELECT id, name, active FROM providers WHERE practice_id = ? AND type = 'hygienist'${pw.sql}`, ctx.pid, ...pw.args);
    const rows = hygienists.map((h) => {
      const p = num(prod.find((x) => x.provider_id === h.id)?.production);
      const v = visits.find((x) => x.provider_id === h.id) || {};
      return { provider_id: h.id, provider: h.name, active: h.active, production: p, visits: num(v.visits), reappointed: num(v.reappointed), per_visit: v.visits ? Math.round(p / v.visits) : null, reappointment_rate: pct(num(v.reappointed), num(v.visits)) };
    }).filter((r) => r.active || r.production || r.visits).map(({ active: _a, ...r }) => r).sort((a, b) => b.production - a.production || a.provider.localeCompare(b.provider));
    const t = rows.reduce((s, r) => ({ production: s.production + r.production, visits: s.visits + r.visits, reappointed: s.reappointed + r.reappointed }), { production: 0, visits: 0, reappointed: 0 });
    return { rows, totals: { per_visit: t.visits ? Math.round(t.production / t.visits) : null, reappointment_rate: pct(t.reappointed, t.visits) }, note: 'Reappointed: the patient’s next visit was booked by the end of the day of this one.' };
  },
});

// ---- Collections ----
def({
  id: 'collections-by-provider', name: 'Collections by provider', category: 'Collections',
  description: 'Money collected for each provider’s work, patient and insurance, against their production.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Provider'), money('production', 'Production'), money('patient', 'Patient payments'), money('insurance', 'Insurance payments'), money('collections', 'Total collected'), col('collection_pct', 'Collection %', 'pct')],
  async run(ctx) {
    const names = await providerNames(ctx);
    const rows = new Map();
    // Product and gift certificate sales are nobody's dental work: what paid for them is its own row, not "unapplied".
    const row = (id, retail = false) => {
      const key = retail ? 'retail' : id ?? 'none';
      if (!rows.has(key)) rows.set(key, { provider_id: retail ? null : id ?? null, provider: retail ? 'Retail & gift certificates' : id ? names.get(id)?.name || 'Provider' : 'Unapplied credit', production: 0, patient: 0, insurance: 0 });
      return rows.get(key);
    };
    for (const c of await chargesByProvider(ctx)) row(c.provider_id).production += num(c.production);
    for (const a of await allocatedByProvider(ctx)) {
      if (ctx.providerId && a.provider_id !== ctx.providerId) continue;
      if (a.credit_type === 'payment') row(a.provider_id, a.retail).patient += a.amount;
      else if (a.credit_type === 'insurance_payment') row(a.provider_id, a.retail).insurance += a.amount;
    }
    const list = [...rows.values()].map((r) => ({ ...r, collections: r.patient + r.insurance, collection_pct: pct(r.patient + r.insurance, r.production) }))
      .filter((r) => r.production || r.collections).sort((a, b) => b.collections - a.collections || b.production - a.production);
    const p = list.reduce((s, r) => s + r.production, 0);
    const c = list.reduce((s, r) => s + r.collections, 0);
    return { rows: list, totals: { collection_pct: pct(c, p) }, note: 'Payments are credited to the provider whose work they paid for (insurance by the procedures on the claim; patient payments oldest charge first).' };
  },
});

def({
  id: 'collections-by-payment-type', name: 'Collections by payment type', category: 'Collections',
  description: 'Money in by how it was paid — cash, check, card, insurance check or EFT — less refunds.',
  params: ['range', 'office'],
  columns: [col('payment_type', 'Payment type'), count('count', 'Count'), money('amount', 'Amount')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT l.type, COALESCE(l.method, 'other') AS method, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS count, -SUM(l.amount) AS amount
       FROM real_ledger_entries l WHERE l.practice_id = ? AND l.type IN ('payment','insurance_payment','refund') AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY l.type, COALESCE(l.method, 'other')`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const order = { payment: 0, insurance_payment: 1, refund: 2 };
    return {
      rows: rows.filter((r) => num(r.count) || num(r.amount)).map((r) => ({ type: r.type, method: r.method, payment_type: `${TYPE_LABEL[r.type]} · ${title(r.method)}`, count: num(r.count), amount: num(r.amount) }))
        .sort((a, b) => order[a.type] - order[b.type] || b.amount - a.amount),
      note: 'Refunds are money paid back out, so they count against the total.',
    };
  },
});

def({
  id: 'insurance-vs-patient-collections', name: 'Insurance vs. patient collections', category: 'Collections',
  description: 'How much came from insurance and how much from patients, month by month.',
  params: ['range', 'office'], range: 'ytd',
  columns: [col('month', 'Month'), money('patient', 'Patient payments'), money('insurance', 'Insurance payments'), money('total', 'Total'), col('insurance_share', 'Insurance share', 'pct')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT substr(l.entry_date, 1, 7) AS month,
         -SUM(CASE WHEN l.type = 'payment' THEN l.amount ELSE 0 END) AS patient,
         -SUM(CASE WHEN l.type = 'insurance_payment' THEN l.amount ELSE 0 END) AS insurance
       FROM real_ledger_entries l WHERE l.practice_id = ? AND l.type IN ('payment','insurance_payment') AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY substr(l.entry_date, 1, 7) ORDER BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const list = rows.map((r) => ({ month: r.month, patient: num(r.patient), insurance: num(r.insurance), total: num(r.patient) + num(r.insurance), insurance_share: pct(num(r.insurance), num(r.patient) + num(r.insurance)) }));
    const ins = list.reduce((s, r) => s + r.insurance, 0);
    const tot = list.reduce((s, r) => s + r.total, 0);
    return { rows: list, totals: { insurance_share: pct(ins, tot) } };
  },
});

def({
  id: 'collection-percentage', name: 'Collection percentage', category: 'Collections',
  description: 'Collections as a share of net production (after adjustments), month by month.',
  params: ['range', 'office'], range: 'ytd',
  columns: [col('month', 'Month'), money('production', 'Production'), money('adjustments', 'Adjustments'), money('net', 'Net production'), money('collections', 'Collections'), col('collection_pct', 'Collection %', 'pct')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT substr(l.entry_date, 1, 7) AS month,
         SUM(CASE WHEN l.type = 'charge' AND l.retail_sale_id IS NULL THEN l.amount ELSE 0 END) AS production,
         SUM(CASE WHEN l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL THEN l.amount ELSE 0 END) AS adjustments,
         -SUM(CASE WHEN l.type IN ('payment','insurance_payment') THEN l.amount ELSE 0 END) AS collections
       FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY substr(l.entry_date, 1, 7) ORDER BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const list = rows.map((r) => {
      const net = num(r.production) + num(r.adjustments);
      return { month: r.month, production: num(r.production), adjustments: num(r.adjustments), net, collections: num(r.collections), collection_pct: pct(num(r.collections), net) };
    });
    return { rows: list, totals: { collection_pct: pct(list.reduce((s, r) => s + r.collections, 0), list.reduce((s, r) => s + r.net, 0)) } };
  },
});

def({
  id: 'daily-payments', name: 'Payments journal', category: 'Collections', phi: true,
  description: 'Every payment, insurance payment and refund posted in the dates, with who posted it.',
  params: ['range', 'office'],
  columns: [col('entry_date', 'Date', 'date'), patientCol, col('type_label', 'Type'), col('method', 'Method'), col('reference', 'Reference'), col('posted_by', 'Posted by'), col('status', 'Status'), money('amount', 'Amount')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT l.id, l.entry_date, l.patient_id, ${NAME} AS patient, l.type, l.method, l.reference, u.name AS posted_by, l.voided_at, l.reverses_id, -l.amount AS amount
       FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id LEFT JOIN users u ON u.id = l.created_by
       WHERE l.practice_id = ? AND l.type IN ('payment','insurance_payment','refund') AND l.entry_date BETWEEN ? AND ?${w.sql}
       ORDER BY l.entry_date, l.id`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, type_label: TYPE_LABEL[r.type], method: title(r.method), posted_by: r.posted_by || 'Online / automatic', status: entryStatus(r) })), note: 'Refunds show as negative. A voided payment and its reversal cancel out.' };
  },
});

def({
  id: 'adjustments-by-type', name: 'Adjustments & write-offs by type', category: 'Collections',
  description: 'Discounts, write-offs and other adjustments grouped by type, for loss control.',
  params: ['range', 'office'],
  columns: [col('type', 'Adjustment type'), count('count', 'Count'), money('amount', 'Amount')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT COALESCE(l.adjustment_type, CASE WHEN l.claim_id IS NOT NULL THEN 'Insurance write-off' ELSE 'Other' END) AS type,
         SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS count, SUM(l.amount) AS amount
       FROM real_ledger_entries l WHERE l.practice_id = ? AND l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql} GROUP BY 1`,
      ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.filter((r) => num(r.count) || num(r.amount)).sort((a, b) => a.amount - b.amount), note: 'Credits (write-offs, discounts) are negative; debit adjustments (fees) are positive.' };
  },
});

def({
  id: 'refunds', name: 'Refunds', category: 'Collections', phi: true,
  description: 'Money paid back to patients or insurance, and why.',
  params: ['range', 'office'],
  columns: [col('entry_date', 'Date', 'date'), patientCol, col('method', 'Method'), col('description', 'Reason'), col('posted_by', 'By'), col('status', 'Status'), money('amount', 'Refunded')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT l.id, l.entry_date, l.patient_id, ${NAME} AS patient, l.method, l.description, u.name AS posted_by, l.voided_at, l.reverses_id, l.amount
       FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id LEFT JOIN users u ON u.id = l.created_by
       WHERE l.practice_id = ? AND l.type = 'refund' AND l.entry_date BETWEEN ? AND ?${w.sql} ORDER BY l.entry_date, l.id`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, method: title(r.method), status: entryStatus(r) })) };
  },
});

// ---- Accounts receivable ----
def({
  id: 'aging-by-family', name: 'A/R aging by family', category: 'Accounts receivable', phi: true,
  description: 'What each household owes, by how old it is, and how much insurance is still expected to pay.',
  params: ['as_of', 'office'],
  columns: [col('patient', 'Account (head of household)', 'patient'), col('phone', 'Phone'), money('current', '0–30'), money('d31_60', '31–60'), money('d61_90', '61–90'), money('d90_plus', '90+'), money('balance', 'Total'), money('insurance_pending', 'Insurance pending'), money('patient_portion', 'Patient owes')],
  async run(ctx) {
    const report = await agingReport(ctx.db, ctx.pid, ctx.asOf, { family: true });
    let rows = report.rows;
    if (ctx.officeIds) {
      const s = ctx.patients('p');
      const ok = new Set((await ctx.db.all(`SELECT p.id FROM real_patients p WHERE p.practice_id = ?${s.sql}`, ctx.pid, ...s.args)).map((p) => p.id));
      rows = rows.filter((r) => ok.has(r.id));
    }
    return { rows: rows.map((r) => ({ ...r, patient_id: r.id, patient: `${r.first_name || ''} ${r.last_name || ''}`.trim() })), note: `As of ${ctx.asOf}. Payments and credits pay off the oldest charges first; accounts in credit are on the Credit balances report.` };
  },
});

def({
  id: 'aging-by-carrier', name: 'Insurance aging by carrier', category: 'Accounts receivable',
  description: 'What each insurance company still owes on sent claims, by how long they’ve had them.',
  params: ['office'],
  columns: [col('carrier', 'Carrier'), count('claims', 'Claims'), money('d0_30', '0–30'), money('d31_60', '31–60'), money('d61_90', '61–90'), money('d90_plus', '90+'), money('total', 'Total expected')],
  async run(ctx) {
    const by = new Map();
    for (const c of await openClaims(ctx, ['submitted', 'partially_paid'])) {
      const r = by.get(c.carrier_id) || { carrier: c.carrier, claims: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
      r.claims++;
      r[bucketOf(c.days)] += c.outstanding;
      r.total += c.outstanding;
      by.set(c.carrier_id, r);
    }
    return { rows: [...by.values()].sort((a, b) => b.total - a.total), note: 'Age from the date each claim was sent. Expected: the estimate less anything already paid (the billed fee when there’s no estimate).' };
  },
});

def({
  id: 'credit-balances', name: 'Credit balances', category: 'Accounts receivable', phi: true,
  description: 'Patients who have paid more than they owe — refund or apply the credit.',
  params: ['office'],
  columns: [patientCol, col('phone', 'Phone'), col('last_credit', 'Last payment / credit', 'date'), money('credit', 'Credit')],
  async run(ctx) {
    const s = ctx.patients('p');
    const rows = await ctx.db.all(
      `SELECT l.patient_id, ${NAME} AS patient, p.phone, SUM(l.amount) AS balance, MAX(CASE WHEN l.amount < 0 THEN l.entry_date END) AS last_credit
       FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id
       WHERE l.practice_id = ?${s.sql}
       GROUP BY l.patient_id, p.first_name, p.last_name, p.phone HAVING SUM(l.amount) < 0`, ctx.pid, ...s.args,
    );
    return { rows: rows.map((r) => ({ ...r, credit: -num(r.balance) })).sort((a, b) => b.credit - a.credit) };
  },
});

def({
  id: 'outstanding-claims', name: 'Outstanding claims by age', category: 'Accounts receivable', phi: true,
  description: 'Every sent claim still waiting on the insurance company, oldest first.',
  params: ['office'],
  columns: [col('id', 'Claim #', 'claim'), patientCol, col('carrier', 'Carrier'), col('since', 'Sent', 'date'), col('days', 'Days', 'int'), col('bucket', 'Age'), col('status_label', 'Status'), money('total_fee', 'Billed'), money('outstanding', 'Expected')],
  async run(ctx) {
    const label = { d0_30: '0–30', d31_60: '31–60', d61_90: '61–90', d90_plus: '90+' };
    const rows = (await openClaims(ctx, ['submitted', 'partially_paid'])).map((c) => ({ ...c, bucket: label[bucketOf(c.days)], status_label: title(c.status) }));
    return { rows: rows.sort((a, b) => b.days - a.days || a.id - b.id) };
  },
});

def({
  id: 'claims-not-sent', name: 'Claims not sent', category: 'Accounts receivable', phi: true,
  description: 'Claims created but never sent to the insurance company.',
  params: ['office'],
  columns: [col('id', 'Claim #', 'claim'), patientCol, col('carrier', 'Carrier'), col('created', 'Created', 'date'), col('days', 'Days waiting', 'int'), money('total_fee', 'Billed'), money('estimated_amount', 'Estimate')],
  async run(ctx) {
    const rows = (await openClaims(ctx, ['draft'])).map((c) => ({ ...c, created: String(c.created_at).slice(0, 10) }));
    return { rows: rows.sort((a, b) => b.days - a.days || a.id - b.id) };
  },
});

def({
  id: 'denied-claims', name: 'Denied claims', category: 'Accounts receivable', phi: true,
  description: 'Claims the insurance company turned down, with the reason — to correct and resend.',
  params: ['office'],
  columns: [col('id', 'Claim #', 'claim'), patientCol, col('carrier', 'Carrier'), col('since', 'Sent', 'date'), col('denial_reason', 'Reason'), col('follow_up_date', 'Follow up', 'date'), money('total_fee', 'Billed')],
  async run(ctx) {
    return { rows: (await openClaims(ctx, ['denied'])).sort((a, b) => b.days - a.days || a.id - b.id) };
  },
});

// ---- Patients ----
def(MARKETING_LIBRARY_REPORT);
def({
  id: 'new-patients-by-source', name: 'New patients by referral source', category: 'Patients',
  description: 'Where new patients came from (referring people, Google, signs…) and what they’ve produced since.',
  params: ['range', 'office'],
  columns: [col('source', 'Source'), count('patients', 'New patients'), money('production', 'Production to date')],
  async run(ctx) {
    const [f, t] = await utcRange(ctx.db, ctx.pid, ctx.from, ctx.to);
    const s = ctx.patients('p');
    const rows = await ctx.db.all(
      `SELECT COALESCE(rc.name, p.referral_source, 'Not recorded') AS source, COUNT(*) AS patients, COALESCE(SUM(lp.n), 0) AS production
       FROM real_patients p LEFT JOIN referral_contacts rc ON rc.id = p.referred_by_id
       LEFT JOIN (SELECT patient_id, SUM(amount) AS n FROM real_ledger_entries ledger_entries WHERE practice_id = ? AND type = 'charge' AND retail_sale_id IS NULL GROUP BY patient_id) lp ON lp.patient_id = p.id
       WHERE p.practice_id = ? AND p.merged_into_id IS NULL AND p.created_at >= ? AND p.created_at < ?${s.sql}
       GROUP BY 1`, ctx.pid, ctx.pid, f, t, ...s.args,
    );
    return { rows: rows.sort((a, b) => b.patients - a.patients || b.production - a.production) };
  },
});

def({
  id: 'active-patients', name: 'Active patient count', category: 'Patients',
  description: 'Active patients by primary provider, how many were seen in the last 18 months, and new ones in the dates.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Primary provider'), count('active', 'Active patients'), count('seen', 'Seen in 18 months'), count('new_patients', 'New in dates')],
  async run(ctx) {
    const [f, t] = await utcRange(ctx.db, ctx.pid, ctx.from, ctx.to);
    const w = join(ctx.patients('p'), ctx.provider('p.primary_provider_id'));
    const rows = await ctx.db.all(
      `SELECT p.primary_provider_id, COALESCE(pv.name, 'No primary provider') AS provider, COUNT(*) AS active,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM real_appointments a WHERE a.patient_id = p.id AND a.status = 'completed' AND a.start_time >= ?) THEN 1 ELSE 0 END) AS seen,
         SUM(CASE WHEN p.created_at >= ? AND p.created_at < ? THEN 1 ELSE 0 END) AS new_patients
       FROM real_patients p LEFT JOIN providers pv ON pv.id = p.primary_provider_id
       WHERE p.practice_id = ? AND p.status = 'active'${w.sql}
       GROUP BY p.primary_provider_id, pv.name`, `${addMonths(ctx.today, -18)} 00:00`, f, t, ctx.pid, ...w.args,
    );
    return { rows: rows.sort((a, b) => b.active - a.active) };
  },
});

def({
  id: 'patients-without-next-visit', name: 'Patients without a next visit', category: 'Patients', phi: true,
  description: 'Active patients seen in the last 18 months with nothing booked — the unscheduled recall list.',
  params: ['provider', 'office'],
  columns: [patientCol, col('phone', 'Phone'), col('last_visit', 'Last visit', 'date'), col('days_since', 'Days since', 'int'), col('recall_due', 'Recall due', 'date')],
  async run(ctx) {
    const w = join(ctx.patients('p'), ctx.provider('p.primary_provider_id'));
    const rows = await ctx.db.all(
      `SELECT p.id AS patient_id, ${NAME} AS patient, p.phone,
         (SELECT MAX(substr(a.start_time, 1, 10)) FROM real_appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS last_visit,
         (SELECT MIN(r.due_date) FROM real_recalls r WHERE r.patient_id = p.id AND r.status NOT IN ('inactive','completed')) AS recall_due
       FROM real_patients p
       WHERE p.practice_id = ? AND p.status = 'active'
         AND EXISTS (SELECT 1 FROM real_appointments a WHERE a.patient_id = p.id AND a.status = 'completed' AND a.start_time >= ?)
         AND NOT EXISTS (SELECT 1 FROM real_appointments a WHERE a.patient_id = p.id AND a.status IN ('scheduled','confirmed') AND a.start_time >= ?)${w.sql}`,
      ctx.pid, `${addMonths(ctx.today, -18)} 00:00`, `${ctx.today} 00:00`, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, days_since: r.last_visit ? daysBetween(r.last_visit, ctx.today) : null })).sort((a, b) => (a.last_visit < b.last_visit ? -1 : a.last_visit > b.last_visit ? 1 : 0)) };
  },
});

def({
  id: 'birthdays', name: 'Patient birthdays', category: 'Patients', phi: true,
  description: 'Active patients with a birthday in the dates, for cards and texts.',
  params: ['range', 'office'], range: 'month',
  columns: [patientCol, col('birthday', 'Birthday', 'date'), col('turning', 'Turning', 'int'), col('phone', 'Phone'), col('email', 'Email')],
  async run(ctx) {
    const s = ctx.patients('p');
    const a = ctx.from.slice(5);
    const b = ctx.to.slice(5);
    const all = daysBetween(ctx.from, ctx.to) >= 365;
    const md = all ? frag() : a <= b && ctx.from.slice(0, 4) === ctx.to.slice(0, 4) ? frag(' AND substr(p.dob, 6, 5) >= ? AND substr(p.dob, 6, 5) <= ?', [a, b]) : frag(' AND (substr(p.dob, 6, 5) >= ? OR substr(p.dob, 6, 5) <= ?)', [a, b]);
    const rows = await ctx.db.all(
      `SELECT p.id AS patient_id, ${NAME} AS patient, p.dob, p.phone, p.email FROM real_patients p
       WHERE p.practice_id = ? AND p.status = 'active' AND p.dob IS NOT NULL AND length(p.dob) = 10${md.sql}${s.sql}`, ctx.pid, ...md.args, ...s.args,
    );
    const out = rows.map((r) => {
      const d = r.dob.slice(5);
      const year = d >= a ? Number(ctx.from.slice(0, 4)) : Number(ctx.to.slice(0, 4));
      return { patient_id: r.patient_id, patient: r.patient, phone: r.phone, email: r.email, birthday: `${year}-${d}`, turning: year - Number(r.dob.slice(0, 4)) };
    });
    return { rows: out.sort((x, y) => (x.birthday < y.birthday ? -1 : x.birthday > y.birthday ? 1 : x.patient.localeCompare(y.patient))) };
  },
});

def({
  id: 'patients-by-insurance-plan', name: 'Patients by insurance plan', category: 'Patients',
  description: 'How many active patients each carrier and plan covers.',
  params: ['office'],
  columns: [col('carrier', 'Carrier'), col('plan', 'Plan / group'), count('patients', 'Patients'), count('primary_count', 'As primary'), count('secondary_count', 'As secondary')],
  async run(ctx) {
    const s = ctx.patients('p');
    const rows = await ctx.db.all(
      `SELECT ic.name AS carrier, COALESCE(ip.name, pi.group_number, '—') AS plan, COUNT(DISTINCT pi.patient_id) AS patients,
         SUM(CASE WHEN pi.priority = 'primary' THEN 1 ELSE 0 END) AS primary_count, SUM(CASE WHEN pi.priority = 'secondary' THEN 1 ELSE 0 END) AS secondary_count
       FROM real_patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id LEFT JOIN insurance_plans ip ON ip.id = pi.plan_id
       JOIN real_patients p ON p.id = pi.patient_id
       WHERE pi.practice_id = ? AND pi.active = 1 AND p.status = 'active'${s.sql}
       GROUP BY ic.name, COALESCE(ip.name, pi.group_number, '—')`, ctx.pid, ...s.args,
    );
    const insured = await ctx.db.get(
      `SELECT COUNT(DISTINCT pi.patient_id) AS n FROM real_patient_insurance pi JOIN real_patients p ON p.id = pi.patient_id WHERE pi.practice_id = ? AND pi.active = 1 AND p.status = 'active'${s.sql}`, ctx.pid, ...s.args,
    );
    return { rows: rows.sort((a, b) => b.patients - a.patients || a.carrier.localeCompare(b.carrier)), totals: { patients: num(insured.n) }, note: 'The total counts each insured patient once, even with two plans.' };
  },
});

def({
  id: 'no-show-cancel-rate', name: 'No-show & cancellation rate', category: 'Patients',
  description: 'Of the visits booked in the dates, how many were kept, cancelled or missed — by provider.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Provider'), count('booked', 'Booked'), count('completed', 'Completed'), count('cancelled', 'Cancelled'), count('no_shows', 'No-shows'), col('cancel_rate', 'Cancel %', 'pct'), col('no_show_rate', 'No-show %', 'pct'), col('broken_rate', 'Broken %', 'pct')],
  async run(ctx) {
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const rows = await ctx.db.all(
      `SELECT a.provider_id, pv.name AS provider, COUNT(*) AS booked,
         SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_shows
       FROM real_appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${w.sql}
       GROUP BY a.provider_id, pv.name`, ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...w.args,
    );
    const rate = (r) => ({ ...r, booked: num(r.booked), completed: num(r.completed), cancelled: num(r.cancelled), no_shows: num(r.no_shows), cancel_rate: pct(num(r.cancelled), num(r.booked)), no_show_rate: pct(num(r.no_shows), num(r.booked)), broken_rate: pct(num(r.cancelled) + num(r.no_shows), num(r.booked)) });
    const list = rows.map(rate).sort((a, b) => b.booked - a.booked);
    const t = list.reduce((s, r) => ({ booked: s.booked + r.booked, completed: s.completed + r.completed, cancelled: s.cancelled + r.cancelled, no_shows: s.no_shows + r.no_shows }), { booked: 0, completed: 0, cancelled: 0, no_shows: 0 });
    const { cancel_rate, no_show_rate, broken_rate } = rate(t);
    return { rows: list, totals: { cancel_rate, no_show_rate, broken_rate } };
  },
});

// ---- Treatment ----
def({
  id: 'unscheduled-treatment', name: 'Unscheduled treatment', category: 'Treatment', phi: true,
  description: 'Diagnosed treatment that isn’t booked yet, by patient and dollar amount — the call list.',
  params: ['provider', 'office'],
  columns: [patientCol, col('phone', 'Phone'), count('procedures', 'Procedures'), col('diagnosed', 'Diagnosed', 'date'), col('accepted', 'Plan accepted'), money('amount', 'Amount')],
  async run(ctx) {
    const w = join(ctx.provider('pr.provider_id'), ctx.patients('p'));
    const rows = await ctx.db.all(
      `SELECT pr.patient_id, ${NAME} AS patient, p.phone, COUNT(*) AS procedures, SUM(pr.fee) AS amount, MIN(substr(pr.created_at, 1, 10)) AS diagnosed,
         MAX(CASE WHEN tp.status = 'accepted' OR tp.signed_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted
       FROM real_procedures pr JOIN real_treatment_plans tp ON tp.id = pr.treatment_plan_id JOIN real_patients p ON p.id = pr.patient_id
       WHERE pr.practice_id = ? AND pr.status = 'planned' AND pr.appointment_id IS NULL AND tp.status IN ('proposed','accepted')${w.sql}
       GROUP BY pr.patient_id, p.first_name, p.last_name, p.phone`, ctx.pid, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, accepted: num(r.accepted) ? 'Yes' : 'No' })).sort((a, b) => b.amount - a.amount), note: 'Planned procedures on proposed or accepted plans that aren’t on an appointment. Fees, not money yet.' };
  },
});

def({
  id: 'treatment-acceptance', name: 'Treatment plan acceptance rate', category: 'Treatment',
  description: 'Plans presented each month and how many (and how many dollars) patients said yes to.',
  params: ['range', 'provider', 'office'], range: 'ytd',
  columns: [col('month', 'Month'), count('plans', 'Plans presented'), count('accepted_plans', 'Plans accepted'), col('plan_rate', 'Plan acceptance', 'pct'), money('presented', 'Presented'), money('accepted', 'Accepted'), col('dollar_rate', 'Dollar acceptance', 'pct')],
  async run(ctx) {
    const by = new Map();
    for (const r of await presentedPlans(ctx)) {
      const m = String(r.presented).slice(0, 7);
      const x = by.get(m) || { month: m, plans: new Set(), acceptedPlans: new Set(), presented: 0, accepted: 0 };
      x.plans.add(r.plan_id);
      if (planAccepted(r)) x.acceptedPlans.add(r.plan_id);
      x.presented += num(r.fee);
      if (procAccepted(r)) x.accepted += num(r.fee);
      by.set(m, x);
    }
    const rows = [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((x) => ({ month: x.month, plans: x.plans.size, accepted_plans: x.acceptedPlans.size, plan_rate: pct(x.acceptedPlans.size, x.plans.size), presented: x.presented, accepted: x.accepted, dollar_rate: pct(x.accepted, x.presented) }));
    const s = (k) => rows.reduce((t, r) => t + r[k], 0);
    return { rows, totals: { plan_rate: pct(s('accepted_plans'), s('plans')), dollar_rate: pct(s('accepted'), s('presented')) }, note: 'Accepted: the plan was accepted or signed; dollars also count any procedure already booked or done.' };
  },
});

def({
  id: 'case-acceptance-by-provider', name: 'Case acceptance by provider', category: 'Treatment',
  description: 'Treatment each provider presented, and how much was accepted, booked and finished.',
  params: ['range', 'provider', 'office'],
  columns: [col('provider', 'Provider'), count('plans', 'Plans'), money('presented', 'Presented'), money('accepted', 'Accepted'), col('acceptance_pct', 'Acceptance', 'pct'), money('scheduled', 'Scheduled'), money('completed', 'Completed'), money('unscheduled', 'Accepted, not booked')],
  async run(ctx) {
    const names = await providerNames(ctx);
    const by = new Map();
    for (const r of await presentedPlans(ctx)) {
      const key = r.provider_id ?? 'none';
      const x = by.get(key) || { provider_id: r.provider_id ?? null, provider: r.provider_id ? names.get(r.provider_id)?.name || 'Provider' : 'No provider', planSet: new Set(), presented: 0, accepted: 0, scheduled: 0, completed: 0 };
      x.planSet.add(r.plan_id);
      x.presented += num(r.fee);
      if (procAccepted(r)) x.accepted += num(r.fee);
      if (r.status === 'planned' && r.appointment_id) x.scheduled += num(r.fee);
      if (r.status === 'completed') x.completed += num(r.fee);
      by.set(key, x);
    }
    const rows = [...by.values()].map(({ planSet, ...x }) => ({ ...x, plans: planSet.size, acceptance_pct: pct(x.accepted, x.presented), unscheduled: Math.max(0, x.accepted - x.scheduled - x.completed) })).sort((a, b) => b.presented - a.presented);
    return { rows, totals: { acceptance_pct: pct(rows.reduce((s, r) => s + r.accepted, 0), rows.reduce((s, r) => s + r.presented, 0)) }, note: 'By the date each plan was presented (or created). A plan with work by two providers counts for each.' };
  },
});

// Diagnosis & conversion (DX2): the one definition in diagnosis.js (docs/metrics.md), by provider and exam type.
def({
  id: 'diagnosis-conversion', name: 'Diagnosis & conversion by provider', category: 'Treatment',
  description: 'Treatment diagnosed at new patient, recall and emergency exams, and how much was presented, accepted, scheduled and completed since.',
  params: ['range', 'provider', 'office'], range: 'month',
  columns: [col('provider', 'Provider'), col('exam_type', 'Exam type'), count('exams', 'Exams'), money('diagnosed', 'Diagnosed'), money('expected', 'Expected after PPO'),
    money('presented', 'Presented'), money('accepted', 'Accepted'), money('scheduled', 'Scheduled'), money('completed', 'Completed'),
    col('scheduled_pct', 'Scheduled % of diagnosed', 'pct'), col('completed_pct', 'Completed % of diagnosed', 'pct'), col('days_to_schedule', 'Median days to schedule', 'int'), col('days_to_complete', 'Median days to complete', 'int')],
  async run(ctx) {
    const out = await diagnosisFunnel(ctx.db, ctx.pid, { from: ctx.from, to: ctx.to, providerId: ctx.providerId, locationIds: ctx.officeIds });
    const line = (provider, providerId, t) => ({
      provider, provider_id: providerId, exam_type: t.label, exams: t.exams, diagnosed: t.diagnosed, expected: t.expected, presented: t.presented, accepted: t.accepted,
      scheduled: t.scheduled, completed: t.completed, scheduled_pct: t.of_diagnosed_pct.scheduled, completed_pct: t.of_diagnosed_pct.completed,
      days_to_schedule: t.median_days_to_schedule, days_to_complete: t.median_days_to_complete,
    });
    const rows = out.providers.flatMap((p) => p.by_exam_type.filter((t) => t.exams).map((t) => line(p.name, p.provider_id, t)));
    const tot = out.totals;
    // A treatment found at a hygiene visit counts for the examining provider and the hygienist, so the totals are
    // the practice's (each exam once), not the sum of the rows.
    return {
      rows,
      totals: { exams: tot.exams, diagnosed: tot.diagnosed, expected: tot.expected, presented: tot.presented, accepted: tot.accepted, scheduled: tot.scheduled, completed: tot.completed, scheduled_pct: tot.of_diagnosed_pct.scheduled, completed_pct: tot.of_diagnosed_pct.completed, days_to_schedule: tot.median_days_to_schedule, days_to_complete: tot.median_days_to_complete },
      note: 'By exam date: work done later is credited to the exam where it was diagnosed. Office fees; "expected" caps each fee at the patient’s PPO fee schedule (an estimate). Treatment found at a hygiene visit counts for the doctor and the hygienist; the totals count each exam once.',
    };
  },
});

def({
  id: 'pending-preauths', name: 'Pending pre-authorizations', category: 'Treatment', phi: true,
  description: 'Pre-authorizations not yet sent or still waiting on the insurance company.',
  params: ['office'],
  columns: [patientCol, col('carrier', 'Carrier'), col('status_label', 'Status'), col('since', 'Sent / created', 'date'), col('days', 'Days', 'int'), money('total_fee', 'Treatment'), money('estimated_amount', 'Estimate')],
  async run(ctx) {
    const s = ctx.patients('p');
    const rows = await ctx.db.all(
      `SELECT pa.id, pa.patient_id, ${NAME} AS patient, ic.name AS carrier, pa.status, pa.submitted_at, pa.created_at, pa.total_fee, pa.estimated_amount
       FROM preauths pa JOIN real_patients p ON p.id = pa.patient_id JOIN real_patient_insurance pi ON pi.id = pa.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE pa.practice_id = ? AND pa.status IN ('draft','submitted')${s.sql}`, ctx.pid, ...s.args,
    );
    return {
      rows: rows.map((r) => {
        const since = String(r.submitted_at || r.created_at).slice(0, 10);
        return { ...r, since, days: Math.max(0, daysBetween(since, ctx.today)), status_label: r.status === 'draft' ? 'Not sent' : 'Waiting' };
      }).sort((a, b) => b.days - a.days),
    };
  },
});

// ---- Scheduling ----
def({
  id: 'appointments-by-day', name: 'Appointment list', category: 'Scheduling', phi: true,
  description: 'The day’s visits: time, patient, provider, chair, status and scheduled fees.',
  params: ['date', 'provider', 'office'],
  columns: [col('time', 'Time'), patientCol, col('phone', 'Phone'), col('provider', 'Provider'), col('chair', 'Chair'), col('status_label', 'Status'), col('reason', 'Reason'), money('scheduled', 'Scheduled fees')],
  async run(ctx) {
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const rows = await ctx.db.all(
      `SELECT a.id, a.patient_id, ${NAME} AS patient, p.phone, a.start_time, a.end_time, pv.name AS provider, o.name AS chair, a.status, a.reason,
         (SELECT COALESCE(SUM(pr.fee), 0) FROM real_procedures pr WHERE pr.appointment_id = a.id AND pr.status != 'cancelled') AS scheduled
       FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id LEFT JOIN operatories o ON o.id = a.operatory_id
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${w.sql}
       ORDER BY a.start_time, a.id`, ctx.pid, `${ctx.date} 00:00`, `${ctx.date} 24:00`, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, time: `${r.start_time.slice(11, 16)}–${r.end_time.slice(11, 16)}`, status_label: title(r.status), chair: r.chair || '' })) };
  },
});

def({
  id: 'broken-appointments', name: 'Broken appointments', category: 'Scheduling', phi: true,
  description: 'Visits cancelled or missed in the dates, the reason, and whether they’ve been rebooked.',
  params: ['range', 'provider', 'office'],
  columns: [col('start_time', 'Was booked for', 'datetime'), patientCol, col('phone', 'Phone'), col('provider', 'Provider'), col('status_label', 'What happened'), col('broken_reason', 'Reason'), col('rebooked', 'Rebooked for', 'datetime')],
  async run(ctx) {
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const rows = await ctx.db.all(
      `SELECT a.id, a.patient_id, ${NAME} AS patient, p.phone, a.start_time, pv.name AS provider, a.status, a.broken_reason,
         (SELECT MIN(b.start_time) FROM real_appointments b WHERE b.patient_id = a.patient_id AND b.id != a.id AND b.start_time > a.start_time AND b.status NOT IN ('cancelled','no_show')) AS rebooked
       FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.status IN ('cancelled','no_show') AND a.start_time >= ? AND a.start_time < ?${w.sql}
       ORDER BY a.start_time, a.id`, ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, status_label: r.status === 'no_show' ? 'No-show' : 'Cancelled', broken_reason: title(r.broken_reason) })) };
  },
});

def({
  id: 'schedule-utilization', name: 'Schedule utilization', category: 'Scheduling',
  description: 'How much of each provider’s (or chair’s) open time was booked.',
  params: ['range', 'group', 'provider', 'office'], range: 'month',
  columns: [col('name', 'Provider / chair'), col('open_hours', 'Open hours', 'hours', { sum: true }), col('booked_hours', 'Booked hours', 'hours', { sum: true }), col('utilization', 'Utilization', 'pct'), count('visits', 'Visits')],
  async run(ctx) {
    const practice = await ctx.db.get('SELECT * FROM practices WHERE id = ?', ctx.pid);
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const appts = await ctx.db.all(
      `SELECT a.provider_id, a.operatory_id, a.start_time, a.end_time FROM real_appointments a
       WHERE a.practice_id = ? AND a.status NOT IN ('cancelled','no_show') AND a.start_time >= ? AND a.start_time < ?${w.sql}`,
      ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...w.args,
    );
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const length = (a) => Math.max(0, (Date.parse(`${a.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${a.start_time.replace(' ', 'T')}:00Z`)) / 60000) || 0;
    const openMinutes = (hoursOn) => {
      let total = 0;
      for (let d = ctx.from; d <= ctx.to; d = addDays(d, 1)) for (const [s, e] of hoursOn(d) || []) total += Math.max(0, mins(e) - mins(s));
      return total;
    };
    let units;
    if (ctx.group === 'chair') {
      const ow = ctx.office('o.location_id', { nullable: true });
      const chairs = await ctx.db.all(`SELECT o.id, o.name, o.active, lo.office_hours FROM operatories o LEFT JOIN locations lo ON lo.id = o.location_id WHERE o.practice_id = ?${ow.sql}`, ctx.pid, ...ow.args);
      units = chairs.map((c) => ({ id: c.id, name: c.name, active: c.active, open: openMinutes((d) => officeHours(c.office_hours ? c : practice)[weekday(d)]), key: 'operatory_id' }));
    } else {
      const pw = ctx.provider('id');
      const provs = await ctx.db.all(`SELECT id, name, active, working_hours FROM providers WHERE practice_id = ?${pw.sql}`, ctx.pid, ...pw.args);
      units = provs.map((p) => ({ id: p.id, name: p.name, active: p.active, open: openMinutes((d) => providerHoursFor(practice, p, d)), key: 'provider_id' }));
    }
    const rows = units.map((u) => {
      const mine = appts.filter((a) => a[u.key] === u.id);
      const booked = mine.reduce((s, a) => s + length(a), 0);
      return { id: u.id, name: u.name, active: u.active, open_hours: Math.round(u.open / 6) / 10, booked_hours: Math.round(booked / 6) / 10, utilization: pct(booked, u.open), visits: mine.length };
    }).filter((r) => r.active || r.visits).map(({ active: _a, ...r }) => r).sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
    const o = rows.reduce((s, r) => s + r.open_hours, 0);
    const b = rows.reduce((s, r) => s + r.booked_hours, 0);
    return { rows, totals: { open_hours: Math.round(o * 10) / 10, booked_hours: Math.round(b * 10) / 10, utilization: pct(b, o) }, note: 'Open time from office hours (and each provider’s own working hours); days off and blockouts aren’t taken out.' };
  },
});

def({
  id: 'asap-list', name: 'ASAP list', category: 'Scheduling', phi: true,
  description: 'Patients who want an earlier visit (ASAP) and everyone on the waitlist — to fill openings.',
  params: ['provider', 'office'],
  columns: [col('source', 'List'), patientCol, col('phone', 'Phone'), col('provider', 'Provider'), col('current', 'Booked for', 'datetime'), col('reason', 'For'), col('since', 'On list since', 'date')],
  async run(ctx) {
    const aw = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const asap = await ctx.db.all(
      `SELECT a.id, a.patient_id, ${NAME} AS patient, p.phone, pv.name AS provider, a.start_time AS current, a.reason, a.created_at
       FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.asap = 1 AND a.start_time > ? AND a.status IN ('scheduled','confirmed')${aw.sql}`, ctx.pid, ctx.now, ...aw.args,
    );
    const ww = join(ctx.patients('p'), ctx.provider('w.provider_id'));
    const wait = await ctx.db.all(
      `SELECT w.id, w.patient_id, ${NAME} AS patient, p.phone, pv.name AS provider, w.reason, w.created_at
       FROM real_waitlist w JOIN real_patients p ON p.id = w.patient_id LEFT JOIN providers pv ON pv.id = w.provider_id
       WHERE w.practice_id = ? AND w.status = 'waiting'${ww.sql}`, ctx.pid, ...ww.args,
    );
    const rows = [
      ...asap.map((r) => ({ ...r, source: 'ASAP', since: String(r.created_at).slice(0, 10) })),
      ...wait.map((r) => ({ ...r, source: 'Waitlist', current: null, provider: r.provider || 'Any', since: String(r.created_at).slice(0, 10) })),
    ];
    return { rows: rows.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)) };
  },
});

// ---- Insurance ----
def({
  id: 'fee-schedule-comparison', name: 'Fee schedule comparison', category: 'Insurance',
  description: 'Your office fee next to a PPO’s allowed fee for each code, and what the difference costs.',
  params: ['fee_schedule', 'range'], range: 'ytd',
  columns: [col('code', 'Code'), col('description', 'Description'), money('office_fee', 'Office fee', { sum: false }), money('ppo_fee', 'PPO fee', { sum: false }), money('difference', 'Difference', { sum: false }), col('ppo_pct', 'PPO % of office', 'pct'), count('done', 'Done in dates'), money('lost', 'Difference × done')],
  async run(ctx) {
    if (!ctx.feeScheduleId) return { rows: [], note: 'No fee schedules set up yet (Insurance → Fee schedules).' };
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT pc.code, pc.description, pc.fee AS office_fee, fi.fee AS ppo_fee FROM procedure_codes pc
       LEFT JOIN fee_schedule_items fi ON fi.code = pc.code AND fi.fee_schedule_id = ?
       WHERE pc.practice_id = ? AND pc.active = 1`, ctx.feeScheduleId, ctx.pid,
    );
    const done = new Map((await ctx.db.all(
      `SELECT pr.code, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS n FROM real_ledger_entries l JOIN real_procedures pr ON pr.id = l.procedure_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${w.sql} GROUP BY pr.code`, ctx.pid, ctx.from, ctx.to, ...w.args,
    )).map((r) => [r.code, num(r.n)]));
    const list = rows.filter((r) => r.ppo_fee != null).map((r) => {
      const n = done.get(r.code) || 0;
      const diff = r.office_fee - r.ppo_fee;
      return { ...r, difference: diff, ppo_pct: pct(r.ppo_fee, r.office_fee), done: n, lost: diff * n };
    }).sort((a, b) => (a.code < b.code ? -1 : 1));
    return { rows: list, note: `Codes with a fee on “${ctx.feeScheduleName}”. Difference × done estimates the write-off at that fee for the work done in the dates.` };
  },
});

def({
  id: 'ppo-writeoffs-by-carrier', name: 'PPO write-offs by carrier', category: 'Insurance',
  description: 'Insurance write-offs posted for each carrier, against what they paid.',
  params: ['range', 'office'],
  columns: [col('carrier', 'Carrier'), count('claims', 'Claims'), money('paid', 'Insurance paid'), money('written_off', 'Written off'), col('writeoff_pct', 'Write-off share', 'pct')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT COALESCE(ic.name, 'Unknown carrier') AS carrier, COUNT(DISTINCT l.claim_id) AS claims,
         -SUM(CASE WHEN l.type = 'insurance_payment' THEN l.amount ELSE 0 END) AS paid,
         -SUM(CASE WHEN l.type = 'adjustment' THEN l.amount ELSE 0 END) AS written_off
       FROM real_ledger_entries l LEFT JOIN real_claims c ON c.id = l.claim_id LEFT JOIN real_patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE l.practice_id = ? AND l.claim_id IS NOT NULL AND l.type IN ('adjustment','insurance_payment') AND l.entry_date BETWEEN ? AND ?${w.sql}
       GROUP BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    const list = rows.map((r) => ({ ...r, paid: num(r.paid), written_off: num(r.written_off), writeoff_pct: pct(num(r.written_off), num(r.paid) + num(r.written_off)) })).sort((a, b) => b.written_off - a.written_off);
    const p = list.reduce((s, r) => s + r.paid, 0);
    const o = list.reduce((s, r) => s + r.written_off, 0);
    return { rows: list, totals: { writeoff_pct: pct(o, p + o) }, note: 'Adjustments posted against a claim, by the claim’s carrier. Write-off share: written off ÷ (paid + written off).' };
  },
});

def({
  id: 'insurance-payments-by-carrier', name: 'Insurance payments by carrier', category: 'Insurance',
  description: 'How much each insurance company paid in the dates.',
  params: ['range', 'office'],
  columns: [col('carrier', 'Carrier'), count('payments', 'Payments'), count('claims', 'Claims'), money('amount', 'Paid')],
  async run(ctx) {
    const w = ctx.office('l.location_id');
    const rows = await ctx.db.all(
      `SELECT COALESCE(ic.name, ic2.name, ck.payer_name, 'Unknown carrier') AS carrier, SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS payments,
         COUNT(DISTINCT l.claim_id) AS claims, -SUM(l.amount) AS amount
       FROM real_ledger_entries l LEFT JOIN real_claims c ON c.id = l.claim_id LEFT JOIN real_patient_insurance pi ON pi.id = c.patient_insurance_id
       LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       LEFT JOIN insurance_checks ck ON ck.id = l.insurance_check_id LEFT JOIN insurance_carriers ic2 ON ic2.id = ck.carrier_id
       WHERE l.practice_id = ? AND l.type = 'insurance_payment' AND l.entry_date BETWEEN ? AND ?${w.sql} GROUP BY 1`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, amount: num(r.amount) })).sort((a, b) => b.amount - a.amount) };
  },
});

def({
  id: 'eligibility-not-verified', name: 'Eligibility not verified', category: 'Insurance', phi: true,
  description: 'Upcoming visits for insured patients whose coverage hasn’t been confirmed in the last 30 days.',
  params: ['range', 'provider', 'office'], range: 'next7',
  columns: [col('start_time', 'Visit', 'datetime'), patientCol, col('provider', 'Provider'), col('carrier', 'Carrier'), col('subscriber_id', 'Member ID'), col('last_checked', 'Last checked', 'date'), col('last_result', 'Last result')],
  async run(ctx) {
    const since = `${addDays(ctx.today, -30)} 00:00:00`;
    const w = join(ctx.office('a.location_id', { nullable: true }), ctx.provider('a.provider_id'));
    const rows = await ctx.db.all(
      `SELECT a.id, a.patient_id, ${NAME} AS patient, a.start_time, pv.name AS provider, ic.name AS carrier, pi.subscriber_id,
         (SELECT MAX(e.created_at) FROM real_eligibility_checks e WHERE e.patient_insurance_id = pi.id) AS last_checked,
         (SELECT COUNT(*) FROM real_eligibility_checks e WHERE e.patient_insurance_id = pi.id AND e.status = 'active' AND e.created_at >= ?) AS recent
       FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       JOIN real_patient_insurance pi ON pi.patient_id = a.patient_id AND pi.active = 1 AND pi.priority = 'primary' JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE a.practice_id = ? AND a.status IN ('scheduled','confirmed') AND a.start_time >= ? AND a.start_time < ?${w.sql}
       ORDER BY a.start_time, a.id`, since, ctx.pid, `${ctx.from} 00:00`, `${ctx.to} 24:00`, ...w.args,
    );
    const pending = rows.filter((r) => !num(r.recent));
    const last = new Map();
    const ids = [...new Set(pending.map((r) => r.patient_id))];
    if (ids.length) {
      for (const e of await ctx.db.all(`SELECT e.patient_id, e.status, e.created_at FROM real_eligibility_checks e WHERE e.practice_id = ? AND e.patient_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.id`, ctx.pid, ...ids)) last.set(e.patient_id, e.status);
    }
    return { rows: pending.map(({ recent: _r, ...r }) => ({ ...r, last_checked: r.last_checked ? String(r.last_checked).slice(0, 10) : null, last_result: r.last_checked ? title(last.get(r.patient_id)) : 'Never checked' })) };
  },
});

// ---- Office ----
def({
  id: 'referrals-out', name: 'Referrals out', category: 'Office', phi: true,
  description: 'Patients sent to specialists in the dates, and whether they were seen and reported back.',
  params: ['range', 'provider', 'office'],
  columns: [col('referral_date', 'Date', 'date'), patientCol, col('specialist', 'Specialist'), col('specialty', 'Specialty'), col('reason', 'Reason'), col('provider', 'Referred by'), col('status_label', 'Status')],
  async run(ctx) {
    const w = join(ctx.patients('p'), ctx.provider('x.provider_id'));
    const rows = await ctx.db.all(
      `SELECT x.id, x.patient_id, ${NAME} AS patient, x.referral_date, rc.name AS specialist, rc.specialty, x.reason, pv.name AS provider, x.status
       FROM real_referrals x JOIN real_patients p ON p.id = x.patient_id JOIN referral_contacts rc ON rc.id = x.contact_id LEFT JOIN providers pv ON pv.id = x.provider_id
       WHERE x.practice_id = ? AND x.direction = 'out' AND x.referral_date BETWEEN ? AND ?${w.sql}
       ORDER BY x.referral_date, x.id`, ctx.pid, ctx.from, ctx.to, ...w.args,
    );
    return { rows: rows.map((r) => ({ ...r, status_label: title(r.status) })) };
  },
});

def({
  id: 'lab-cases-outstanding', name: 'Lab cases outstanding', category: 'Office', phi: true,
  description: 'Cases at the lab or back but not yet seated, with due dates and the seat appointment.',
  params: ['provider', 'office'],
  columns: [patientCol, col('lab_name', 'Lab'), col('description', 'Case'), col('status_label', 'Status'), col('sent_date', 'Sent', 'date'), col('due_date', 'Due', 'date'), col('overdue', 'Days late', 'int'), col('seat', 'Seat visit', 'datetime')],
  async run(ctx) {
    const w = join(ctx.patients('p'), ctx.provider('lc.provider_id'));
    const rows = await ctx.db.all(
      `SELECT lc.id, lc.patient_id, ${NAME} AS patient, lc.lab_name, lc.description, lc.tooth, lc.status, lc.sent_date, lc.due_date, ap.start_time AS seat_appt,
         (SELECT MIN(a.start_time) FROM real_appointments a WHERE a.patient_id = lc.patient_id AND a.start_time >= ? AND a.status IN ('scheduled','confirmed')) AS next_visit
       FROM real_lab_cases lc JOIN real_patients p ON p.id = lc.patient_id LEFT JOIN real_appointments ap ON ap.id = lc.appointment_id
       WHERE lc.practice_id = ? AND lc.status IN ('sent','received','returned_for_adjustment')${w.sql}`, `${ctx.today} 00:00`, ctx.pid, ...w.args,
    );
    const out = rows.map((r) => ({
      ...r, description: r.tooth ? `${r.description} (#${r.tooth})` : r.description, status_label: title(r.status), seat: r.seat_appt || r.next_visit || null,
      overdue: r.status !== 'received' && r.due_date && r.due_date < ctx.today ? daysBetween(r.due_date, ctx.today) : null,
    }));
    return { rows: out.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.id - b.id) };
  },
});

def({
  id: 'inventory-reorder', name: 'Inventory to reorder', category: 'Office',
  description: 'Supplies at or below their reorder point, grouped by supplier, with the order cost.',
  params: ['office'],
  columns: [col('supplier', 'Supplier'), col('name', 'Item'), col('sku', 'SKU'), col('office', 'Office'), col('on_hand', 'On hand', 'int'), col('reorder_at', 'Reorder at', 'int'), col('order_qty', 'Order', 'int'), money('unit_cost', 'Unit cost', { sum: false }), money('order_cost', 'Order cost')],
  async run(ctx) {
    const w = ctx.office('i.location_id', { nullable: true });
    const rows = await ctx.db.all(
      `SELECT i.id, i.name, i.sku, i.supplier, i.unit, i.on_hand, i.reorder_at, i.reorder_qty, i.cost AS unit_cost, lo.name AS office
       FROM inventory_items i LEFT JOIN locations lo ON lo.id = i.location_id
       WHERE i.practice_id = ? AND i.active = 1 AND i.reorder_at > 0 AND i.on_hand <= i.reorder_at${w.sql}`, ctx.pid, ...w.args,
    );
    const out = rows.map((r) => {
      const qty = r.reorder_qty > 0 ? r.reorder_qty : Math.max(1, r.reorder_at - r.on_hand);
      return { ...r, supplier: r.supplier || 'No supplier', office: r.office || 'All offices', order_qty: qty, order_cost: r.unit_cost != null ? r.unit_cost * qty : null };
    });
    return { rows: out.sort((a, b) => a.supplier.localeCompare(b.supplier) || a.name.localeCompare(b.name)) };
  },
});

def({
  id: 'audit-summary', name: 'Audit summary', category: 'Office', admin: true, practiceWide: true,
  description: 'Who did what in the dates — people, the assistant, automations and integrations — by action.',
  params: ['range'],
  columns: [col('who', 'Who'), col('source', 'Source'), col('action', 'Action'), count('count', 'Times'), col('first', 'First', 'utc'), col('last', 'Last', 'utc')],
  async run(ctx) {
    const [f, t] = await utcRange(ctx.db, ctx.pid, ctx.from, ctx.to);
    const rows = await ctx.db.all(
      `SELECT COALESCE(a.actor, u.name, 'System') AS who, COALESCE(a.source, 'human') AS source, a.action, COUNT(*) AS count, MIN(a.created_at) AS first, MAX(a.created_at) AS last
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.practice_id = ? AND a.created_at >= ? AND a.created_at < ?
       GROUP BY 1, 2, 3`, ctx.pid, f, t,
    );
    return { rows: rows.map((r) => ({ ...r, source: title(r.source) })).sort((a, b) => b.count - a.count || a.who.localeCompare(b.who) || a.action.localeCompare(b.action)) };
  },
});

def({
  id: 'end-of-day', name: 'End-of-day summary', category: 'Office',
  description: 'The day’s close-out: production, payments by method for the deposit, adjustments and visits.',
  params: ['date', 'office'], summary: true,
  columns: SUMMARY_COLUMNS,
  async run(ctx) {
    const m = await ledgerByType(ctx, ctx.date, ctx.date);
    const appts = await appointmentCounts(ctx, ctx.date, ctx.date);
    const rows = [
      line('Money', 'Production', { n: typeSum(m, 'charge', 'n'), amount: typeSum(m, 'charge') }),
      line('Money', 'Adjustments', { n: typeSum(m, 'adjustment', 'n'), amount: typeSum(m, 'adjustment') }),
      line('Money', 'Patient payments', { n: typeSum(m, 'payment', 'n'), amount: -typeSum(m, 'payment') }),
      line('Money', 'Insurance payments', { n: typeSum(m, 'insurance_payment', 'n'), amount: -typeSum(m, 'insurance_payment') }),
      line('Money', 'Refunds', { n: typeSum(m, 'refund', 'n'), amount: typeSum(m, 'refund') }),
      line('Money', 'Change in accounts receivable', { amount: m.reduce((s, r) => s + num(r.amount), 0) }),
    ];
    const deposit = m.filter((r) => ['payment', 'insurance_payment', 'refund'].includes(r.type) && num(r.amount));
    const methods = new Map();
    for (const r of deposit) {
      const key = r.type === 'insurance_payment' ? `Insurance ${r.method || 'check'}` : title(r.method || 'other');
      const x = methods.get(key) || { n: 0, amount: 0 };
      x.n += r.type === 'refund' ? 0 : num(r.n);
      x.amount -= num(r.amount);
      methods.set(key, x);
    }
    for (const [k, v] of [...methods].sort()) rows.push(line('Deposit', k, { n: v.n, amount: v.amount }));
    rows.push(line('Deposit', 'Total to deposit', { amount: [...methods.values()].reduce((s, v) => s + v.amount, 0) }));
    const booked = Object.values(appts).reduce((s, n) => s + n, 0);
    rows.push(line('Visits', 'Booked', { n: booked }));
    for (const s of ['completed', 'cancelled', 'no_show']) rows.push(line('Visits', s === 'no_show' ? 'No-shows' : title(s), { n: appts[s] || 0, rate: pct(appts[s] || 0, booked) }));
    rows.push(line('Visits', 'New patients', { n: await newPatientCount(ctx, ctx.date, ctx.date) }));
    return { rows, note: 'Refunds reduce the deposit. The deposit counts money posted today by the method it was taken.' };
  },
});

def({
  id: 'month-end', name: 'Month-end summary', category: 'Office',
  description: 'The month on one page: production, collections, collection rate, A/R, claims and visits.',
  params: ['month', 'office'], summary: true,
  columns: SUMMARY_COLUMNS,
  async run(ctx) {
    const from = `${ctx.month}-01`;
    const to = monthEnd(ctx.month);
    const m = await ledgerByType(ctx, from, to);
    const production = typeSum(m, 'charge');
    const adjustments = typeSum(m, 'adjustment');
    const patient = -typeSum(m, 'payment');
    const insurance = -typeSum(m, 'insurance_payment');
    const refunds = typeSum(m, 'refund');
    const w = ctx.office('l.location_id');
    const ar = num((await ctx.db.get(`SELECT COALESCE(SUM(l.amount), 0) AS n FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date <= ?${w.sql}`, ctx.pid, to, ...w.args)).n);
    const cw = ctx.officeOrPatient('c.location_id', 'c_p');
    const claims = await ctx.db.get(
      `SELECT SUM(CASE WHEN substr(c.submitted_at, 1, 10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN substr(c.submitted_at, 1, 10) BETWEEN ? AND ? THEN c.total_fee ELSE 0 END) AS sent_fee,
         SUM(CASE WHEN c.paid_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS paid,
         SUM(CASE WHEN c.status = 'denied' THEN 1 ELSE 0 END) AS denied
       FROM real_claims c JOIN real_patients c_p ON c_p.id = c.patient_id WHERE c.practice_id = ? AND c.status != 'void'${cw.sql}`, from, to, from, to, from, to, ctx.pid, ...cw.args,
    );
    const appts = await appointmentCounts(ctx, from, to);
    const booked = Object.values(appts).reduce((s, n) => s + n, 0);
    const net = production + adjustments;
    const rows = [
      line('Production', 'Gross production', { n: typeSum(m, 'charge', 'n'), amount: production }),
      line('Production', 'Adjustments', { n: typeSum(m, 'adjustment', 'n'), amount: adjustments }),
      line('Production', 'Net production', { amount: net }),
      line('Collections', 'Patient payments', { n: typeSum(m, 'payment', 'n'), amount: patient }),
      line('Collections', 'Insurance payments', { n: typeSum(m, 'insurance_payment', 'n'), amount: insurance }),
      line('Collections', 'Refunds', { n: typeSum(m, 'refund', 'n'), amount: refunds }),
      line('Collections', 'Total collections', { amount: patient + insurance, rate: pct(patient + insurance, net) }),
      line('Accounts receivable', `Owed to the practice on ${to}`, { amount: ar }),
      line('Claims', 'Sent', { n: num(claims?.sent), amount: num(claims?.sent_fee) }),
      line('Claims', 'Paid', { n: num(claims?.paid) }),
      line('Claims', 'Denied, still to fix', { n: num(claims?.denied) }),
      line('Visits', 'Booked', { n: booked }),
      line('Visits', 'Completed', { n: appts.completed || 0, rate: pct(appts.completed || 0, booked) }),
      line('Visits', 'Cancelled', { n: appts.cancelled || 0, rate: pct(appts.cancelled || 0, booked) }),
      line('Visits', 'No-shows', { n: appts.no_show || 0, rate: pct(appts.no_show || 0, booked) }),
      line('Patients', 'New patients', { n: await newPatientCount(ctx, from, to) }),
    ];
    return { rows, note: `${from} to ${to}. Collection rate is collections ÷ net production.` };
  },
});

export const LIBRARY = R;
const BY_ID = new Map(R.map((r) => [r.id, r]));
export const getReport = (id) => BY_ID.get(id) || null;

// ---------------------------------------------------------------------------------------------------------------
// Filters

function defaultRange(kind, today) {
  switch (kind) {
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: monthEnd(today.slice(0, 7)) };
    case 'next7': return { from: today, to: addDays(today, 7) };
    case 'next30': return { from: today, to: addDays(today, 30) };
    case 'ytd': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

export function defaultsFor(def, today) {
  const out = {};
  if (def.params.includes('range')) Object.assign(out, defaultRange(def.range, today));
  if (def.params.includes('date')) out.date = today;
  if (def.params.includes('month')) out.month = today.slice(0, 7);
  if (def.params.includes('as_of')) out.as_of = today;
  if (def.params.includes('group')) out.group = 'provider';
  return out;
}

const visible = (def, user) => (!def.admin || user.role === 'admin') && !(def.practiceWide && restricted(user));

// Validates the query against the report's filters and builds what its run() uses. The practice, the person's
// offices and every id are checked on the server; anything that doesn't fit is refused, not ignored.
export async function buildContext(db, user, def, query = {}) {
  const pid = user.practice_id;
  const now = await practiceNow(db, pid);
  const today = now.slice(0, 10);
  const d = defaultsFor(def, today);
  const ctx = { db, pid, user, now, today, def };
  const has = (p) => def.params.includes(p);
  const date = (v, name) => {
    if (!isRealDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
    return v;
  };
  if (has('range')) {
    ctx.from = date(query.from || d.from, 'from');
    ctx.to = date(query.to || d.to, 'to');
    if (ctx.from > ctx.to) throw new HttpError(400, 'The start date is after the end date');
    if (daysBetween(ctx.from, ctx.to) > MAX_RANGE_DAYS) throw new HttpError(400, 'Pick a range of three years or less');
  }
  if (has('date')) ctx.date = date(query.date || d.date, 'date');
  if (has('month')) {
    ctx.month = query.month || d.month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ctx.month) || !isRealDate(`${ctx.month}-01`)) throw new HttpError(400, 'month must be YYYY-MM');
  }
  if (has('as_of')) {
    ctx.asOf = date(query.as_of || d.as_of, 'as_of');
    if (ctx.asOf > today) throw new HttpError(400, 'as_of can’t be in the future');
  }
  if (has('group')) {
    ctx.group = query.group || d.group;
    if (!['provider', 'chair'].includes(ctx.group)) throw new HttpError(400, 'group must be provider or chair');
  }
  const id = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    if (!/^\d+$/.test(String(v))) throw new HttpError(400, `${name} must be a number`);
    return Number(v);
  };
  ctx.providerId = has('provider') ? id(query.provider_id, 'provider_id') : null;
  if (ctx.providerId && !(await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', ctx.providerId, pid))) throw new HttpError(404, 'Provider not found');
  const loc = has('office') ? id(query.location_id, 'location_id') : null;
  if (loc && !(await db.get('SELECT id FROM locations WHERE id = ? AND practice_id = ?', loc, pid))) throw new HttpError(404, 'Office not found');
  if (loc && restricted(user) && !user.location_ids.includes(loc)) throw new HttpError(403, "That office isn't one of yours");
  ctx.locationId = loc;
  // Offices this report is held to: the one picked, or everyone limited to some offices only ever sees theirs.
  ctx.officeIds = loc ? [loc] : restricted(user) ? user.location_ids.map(Number) : null;
  if (has('fee_schedule')) {
    const fs = id(query.fee_schedule_id, 'fee_schedule_id');
    const row = fs
      ? await db.get('SELECT id, name FROM fee_schedules WHERE id = ? AND practice_id = ?', fs, pid)
      : await db.get("SELECT id, name FROM fee_schedules WHERE practice_id = ? AND active = 1 ORDER BY CASE WHEN kind = 'ppo' THEN 0 ELSE 1 END, id LIMIT 1", pid);
    if (fs && !row) throw new HttpError(404, 'Fee schedule not found');
    ctx.feeScheduleId = row?.id ?? null;
    ctx.feeScheduleName = row?.name ?? null;
  }
  const inList = (ids) => ids.map(() => '?').join(',');
  // Rows with an office column. nullable: rows not tied to an office (visits, claims, supplies) still show for
  // someone limited to some offices, as on the schedule; money on the ledger is held strictly to the office.
  ctx.office = (column, { nullable = false } = {}) => {
    if (!ctx.officeIds) return frag();
    if (nullable && !loc) return frag(` AND (${column} IS NULL OR ${column} IN (${inList(ctx.officeIds)}))`, ctx.officeIds);
    return frag(` AND ${column} IN (${inList(ctx.officeIds)})`, ctx.officeIds);
  };
  // Rows about patients: the patients who belong to the office(s) (officeaccess.js).
  ctx.patients = (alias) => (ctx.officeIds ? patientScope({ location_ids: ctx.officeIds }, alias) : frag());
  // Records with an office that may predate offices (claims): at the office, or not tied to one and about a
  // patient who belongs there.
  ctx.officeOrPatient = (column, alias) => {
    if (!ctx.officeIds) return frag();
    const s = patientScope({ location_ids: ctx.officeIds }, alias);
    return frag(` AND (${column} IN (${inList(ctx.officeIds)}) OR (${column} IS NULL AND ${s.sql.replace(/^ AND /, '')}))`, [...ctx.officeIds, ...s.args]);
  };
  ctx.provider = (column) => (ctx.providerId ? frag(` AND ${column} = ?`, [ctx.providerId]) : frag());
  return ctx;
}

// Totals: money and counts summed down the column, unless the report worked out its own (rates, distinct counts).
function totalsFor(def, rows, own = {}) {
  const out = {};
  for (const c of def.columns) if (c.sum) out[c.key] = rows.reduce((s, r) => s + (r[c.key] == null ? 0 : Number(r[c.key])), 0);
  return { ...out, ...own };
}

const PARAM_KEYS = ['from', 'to', 'date', 'month', 'as_of', 'group'];
const meta = (def, today) => ({
  id: def.id, name: def.name, category: def.category, description: def.description, params: def.params, columns: def.columns,
  phi: def.phi, admin: !!def.admin, summary: !!def.summary, looks_ahead: ['next7', 'next30'].includes(def.range) && def.params.includes('range'), defaults: defaultsFor(def, today), saved_key: def.admin ? null : `lib.${def.id}`,
});

export async function listReports(db, user) {
  const today = (await practiceNow(db, user.practice_id)).slice(0, 10);
  return { today, categories: CATEGORIES, reports: R.filter((d) => visible(d, user)).map((d) => meta(d, today)) };
}

export async function runReport(db, user, id, query = {}) {
  const def = getReport(id);
  if (!def) throw new HttpError(404, 'Report not found');
  if (def.admin && user.role !== 'admin') throw new HttpError(403, 'Only administrators can see this report');
  if (def.practiceWide && restricted(user)) throw new HttpError(403, 'This report covers every office. Ask an administrator.');
  const ctx = await buildContext(db, user, def, query);
  const out = await def.run(ctx);
  const all = out.rows || [];
  const rows = all.slice(0, MAX_ROWS);
  const params = Object.fromEntries(PARAM_KEYS.map((k) => [k, ctx[k === 'as_of' ? 'asOf' : k]]).filter(([, v]) => v != null));
  if (ctx.providerId) params.provider_id = ctx.providerId;
  if (ctx.locationId) params.location_id = ctx.locationId;
  if (ctx.feeScheduleId) params.fee_schedule_id = ctx.feeScheduleId;
  return {
    report: meta(def, ctx.today), params, generated_at: ctx.now, rows, row_count: all.length, truncated: all.length > rows.length,
    totals: def.summary ? null : totalsFor(def, all, out.totals), note: out.note || null,
  };
}

// CSV of a result: money in dollars, rates as numbers, the totals as a last line.
const cellValue = (c, v) => (v == null ? '' : c.type === 'money' ? (Number(v) / 100).toFixed(2) : v);
export function reportCsv(result) {
  const cols = result.report.columns;
  const rows = result.totals ? [...result.rows, { __total: true, ...result.totals }] : result.rows;
  return toCsv(rows, cols.map((c, i) => [c.type === 'money' ? `${c.label} ($)` : c.type === 'pct' ? `${c.label} (%)` : c.label, (r) => (r.__total && i === 0 ? 'Total' : r.__total && !(c.key in result.totals) ? '' : cellValue(c, r[c.key]))]));
}

// ---------------------------------------------------------------------------------------------------------------
// Saved & scheduled: every library report except the admin-only ones can be saved and emailed through the existing
// saved-reports mechanism (savedreports.js), under the key "lib.<id>". Emails never name patients: reports whose
// rows are about patients send totals only.
const $ = (c) => `${Number(c) < 0 ? '-' : ''}$${(Math.abs(Number(c || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shown = (c, v) => (v == null || v === '' ? '—' : c.type === 'money' ? $(v) : c.type === 'pct' ? `${v}%` : c.type === 'hours' ? `${v} h` : String(v));

export function renderText(result) {
  const { report, params } = result;
  const cols = report.columns;
  const head = [params.from && params.to ? `${params.from} to ${params.to}` : params.date || params.month || params.as_of || '', ''];
  const body = [];
  if (report.summary) {
    let section = null;
    for (const r of result.rows) {
      if (r.section !== section) { if (section) body.push(''); body.push(r.section); section = r.section; }
      body.push(`  ${r.item.padEnd(34, ' ')}${[r.count != null ? String(r.count) : '', r.amount != null ? $(r.amount) : '', r.rate != null ? `${r.rate}%` : ''].filter(Boolean).join('   ')}`);
    }
  } else if (!report.phi) {
    const [first, ...rest] = cols;
    for (const r of result.rows.slice(0, 40)) body.push(`${String(shown(first, r[first.key])).slice(0, 32).padEnd(34, ' ')}${rest.map((c) => `${c.label}: ${shown(c, r[c.key])}`).join(' · ')}`);
    if (result.rows.length > 40) body.push(`…and ${result.rows.length - 40} more — open the report to see them all.`);
    body.push('');
  } else {
    body.push(`${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'} — open Reports → Report library to see them (emails don’t carry patient names).`, '');
  }
  if (result.totals) body.push(`Totals: ${cols.slice(1).filter((c) => c.key in result.totals).map((c) => `${c.label} ${shown(c, result.totals[c.key])}`).join(' · ')}`);
  if (result.note) body.push('', result.note);
  return [...head, ...body];
}

// period (mtd, last_month…) → the dates for reports with a range; reports looking ahead keep their own dates.
export function savedQuery(def, params, today) {
  const q = {};
  if (def.params.includes('range') && !['next7', 'next30'].includes(def.range)) Object.assign(q, rangeFor(params.period, today));
  if (def.params.includes('date')) q.date = params.period === 'yesterday' || !params.period ? addDays(today, -1) : today;
  if (def.params.includes('month')) q.month = params.period === 'last_month' ? addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7) : today.slice(0, 7);
  if (params.provider_id && def.params.includes('provider')) q.provider_id = params.provider_id;
  if (params.location_id && def.params.includes('office')) q.location_id = params.location_id;
  return q;
}

export function registerSavedReports(target = SAVED_REPORTS) {
  for (const d of R) {
    if (d.admin) continue;
    target[`lib.${d.id}`] = {
      label: d.name,
      async render(db, pid, params, today) {
        // Scheduled emails run as the practice (no office limits): whoever saved it can see every office.
        const user = { practice_id: pid, role: 'admin', location_ids: null };
        const q = savedQuery(d, params || {}, today);
        // "Yesterday" for a day report is relative to the practice's today, not the server's.
        if (q.date && q.date > today) q.date = today;
        return renderText(await runReport(db, user, d.id, q));
      },
    };
  }
}
registerSavedReports();
