// One definition per KPI (docs/metrics.md). Every screen, email and report that shows one of these numbers
// asks this module, so the same question always gets the same answer. Money comes from the ledger (integer
// cents, SUM(amount), voided entries and their reversals left out); visits from appointments; treatment from
// procedures. Each metric can be narrowed to one provider and/or one office where that makes sense, and has a
// drill-down (metricRows) that lists the rows behind the number.
//
// Scheduled production here is the same rule as the schedule screen (procedure fees on the day's visits that
// aren't cancelled or no-shows). production.js (perfect-day templates) is being built separately; when it lands,
// both should call one function — see the note in docs/metrics.md.
import { agingReport } from './aging.js';
import { allocationsForRange } from './allocation.js';
import { utcRange, addMonths, practiceNow } from './util.js';
import { hoursFor, providerHoursOn } from './hours.js';
import { loadDiagnoses, summarize, diagnosisPatients, EXAM_TYPES, EXAM_CODES, ROUTINE_EXAMS, classifyExam, examRules } from './diagnosis.js';

export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (d) => DATE.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
const LIVE = (a = 'l') => `${a}.voided_at IS NULL AND ${a}.reverses_id IS NULL`;
const IN = (list) => list.map(() => '?').join(',');

// Industry rules of thumb, used where the practice hasn't set a goal (kept in step with KPI_DEFAULTS in
// routes/settings.js, which is what the practice's own percentage targets override).
export const BENCHMARKS = { collection_rate: 98, case_acceptance: 60, hygiene_reappointment: 90, broken_rate: 10, recall_current_rate: 70 };
// practices.kpi_targets keys (set on the Analytics screen) for the same metrics.
const TARGET_KEYS = { collection_rate: 'collection_rate', case_acceptance: 'case_acceptance', hygiene_reappointment: 'hygiene_reappointment', broken_rate: 'no_show_rate', recall_current_rate: 'recall_current', new_patients: 'new_patients' };

// kind: period (adds up over dates), snapshot (as of a day), schedule (booked visits on dates).
// goal: 'month' — a goal per month, prorated by open office days; 'day' — per open day; 'rate' — a percentage.
// scopes: which filters apply (provider, location).
export const METRICS = {
  production_gross: { label: 'Gross production', unit: 'money', better: 'higher', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  adjustments: { label: 'Write-offs & discounts', unit: 'money', better: 'lower', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  production_net: { label: 'Net production', unit: 'money', better: 'higher', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  collections: { label: 'Collections', unit: 'money', better: 'higher', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  collection_rate: { label: 'Collection rate', unit: 'percent', better: 'higher', kind: 'period', goal: 'rate', scopes: ['provider', 'location'], drill: true },
  new_patients: { label: 'New patients', unit: 'count', better: 'higher', kind: 'period', goal: 'month', scopes: ['location'], drill: true },
  case_acceptance: { label: 'Case acceptance', unit: 'percent', better: 'higher', kind: 'period', goal: 'rate', scopes: ['provider', 'location'], drill: true },
  // Treatment diagnosed at exams (diagnosis.js; the funnel after it is on the Diagnosis & conversion tab).
  diagnosed: { label: 'Treatment diagnosed', unit: 'money', better: 'higher', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  hygiene_reappointment: { label: 'Hygiene reappointment', unit: 'percent', better: 'higher', kind: 'period', goal: 'rate', scopes: ['provider', 'location'], drill: true },
  broken_appointments: { label: 'Broken appointments', unit: 'count', better: 'lower', kind: 'period', goal: 'month', scopes: ['provider', 'location'], drill: true },
  broken_rate: { label: 'No-show & cancel rate', unit: 'percent', better: 'lower', kind: 'period', goal: 'rate', scopes: ['provider', 'location'], drill: true },
  unscheduled_treatment: { label: 'Unscheduled treatment', unit: 'money', better: 'lower', kind: 'snapshot', goal: 'total', scopes: ['provider', 'location'], drill: true },
  ar_total: { label: 'Owed to the practice (A/R)', unit: 'money', better: 'lower', kind: 'snapshot', goal: 'total', scopes: [], drill: true },
  ar_over_90: { label: 'A/R over 90 days', unit: 'money', better: 'lower', kind: 'snapshot', goal: 'total', scopes: [], drill: true },
  claims_over_30: { label: 'Claims waiting over 30 days', unit: 'count', better: 'lower', kind: 'snapshot', goal: 'total', scopes: ['provider', 'location'], drill: true },
  recall_due: { label: 'Recall due in the next 30 days', unit: 'count', better: 'neutral', kind: 'snapshot', goal: null, scopes: ['provider', 'location'], drill: true },
  recall_overdue: { label: 'Recall overdue', unit: 'count', better: 'lower', kind: 'snapshot', goal: 'total', scopes: ['provider', 'location'], drill: true },
  recall_current_rate: { label: 'Patients current on recall', unit: 'percent', better: 'higher', kind: 'snapshot', goal: 'rate', scopes: ['provider', 'location'], drill: false },
  visits: { label: 'Visits booked', unit: 'count', better: 'higher', kind: 'schedule', goal: null, scopes: ['provider', 'location'], drill: true },
  scheduled_production: { label: 'Scheduled production', unit: 'money', better: 'higher', kind: 'schedule', goal: 'day', scopes: ['provider', 'location'], drill: true },
  open_gaps: { label: 'Open gaps (30 min or more)', unit: 'count', better: 'lower', kind: 'schedule', goal: null, scopes: ['provider', 'location'], drill: true },
  unconfirmed: { label: 'Unconfirmed visits', unit: 'count', better: 'lower', kind: 'schedule', goal: null, scopes: ['provider', 'location'], drill: true },
  insurance_to_verify: { label: 'Insurance to verify', unit: 'count', better: 'lower', kind: 'schedule', goal: null, scopes: ['provider', 'location'], drill: true },
  balances_due: { label: 'Balances to collect from booked patients', unit: 'money', better: 'neutral', kind: 'schedule', goal: null, scopes: ['provider', 'location'], drill: true },
};
export const SNAPSHOT_STORED = ['unscheduled_treatment', 'claims_over_30', 'recall_due', 'recall_overdue', 'recall_current_rate'];

// Which credit adjustment an entry is (the same split as the Analytics screen): insurance write-offs (the PPO
// contract), discounts the office chose to give, and other write-offs (bad debt, small balances).
export const adjustmentKind = (e) => (e.adjustment_type === 'Insurance write-off' || e.claim_id ? 'insurance_write_offs'
  : /write-?off|bad debt|collection/i.test(e.adjustment_type || '') ? 'other_write_offs' : 'discounts');

// " AND col = ?" for the filters a metric supports.
function scope(o, cols) {
  let sql = '';
  const args = [];
  if (o.providerId && cols.provider) { sql += ` AND ${cols.provider}`; args.push(...Array(cols.provider.split('?').length - 1).fill(o.providerId)); }
  if (o.locationId && cols.location) { sql += ` AND ${cols.location} = ?`; args.push(o.locationId); }
  return { sql, args };
}
const supported = (key, o) => (!o.providerId || METRICS[key].scopes.includes('provider')) && (!o.locationId || METRICS[key].scopes.includes('location'));

// ---- The calculations ----

// Production, adjustments and collections for a date range (ledger entry dates).
async function money(db, pid, o) {
  const { from, to } = o;
  if (o.providerId) {
    // One provider: their charges; payments and write-offs credited to their work (the same allocation as
    // Collections by provider: insurance to the claim's procedures, the rest to the oldest charges first).
    const s = scope(o, { provider: 'l.provider_id = ?', location: 'l.location_id' });
    const charges = (await db.get(`SELECT COALESCE(SUM(l.amount),0) AS n FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ? AND ${LIVE()}${s.sql}`, pid, from, to, ...s.args)).n;
    const alloc = (await allocationsForRange(db, pid, from, to)).filter((a) => a.provider_id === o.providerId);
    const received = alloc.filter((a) => ['payment', 'insurance_payment'].includes(a.credit_type)).reduce((x, a) => x + a.amount, 0);
    const adj = alloc.filter((a) => a.credit_type === 'adjustment');
    const split = { insurance_write_offs: 0, discounts: 0, other_write_offs: 0 };
    const ids = [...new Set(adj.map((a) => a.credit_id))];
    const kinds = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const e of await db.all(`SELECT id, adjustment_type, claim_id, location_id FROM ledger_entries WHERE id IN (${IN(chunk)})`, ...chunk)) kinds.set(e.id, e);
    }
    for (const a of adj) {
      const e = kinds.get(a.credit_id);
      if (e && (!o.locationId || e.location_id === o.locationId)) split[adjustmentKind(e)] += a.amount;
    }
    const adjustments = split.insurance_write_offs + split.discounts + split.other_write_offs;
    return { charges, adjustments, split, received, refunds: 0 };
  }
  const s = scope(o, { location: 'l.location_id' });
  const t = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN l.type = 'charge' AND l.retail_sale_id IS NULL THEN l.amount ELSE 0 END),0) AS charges,
       COALESCE(SUM(CASE WHEN l.type IN ('payment','insurance_payment') THEN -l.amount ELSE 0 END),0) AS received,
       COALESCE(SUM(CASE WHEN l.type = 'refund' THEN l.amount ELSE 0 END),0) AS refunds
     FROM ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ? AND ${LIVE()}${s.sql}`, pid, from, to, ...s.args,
  );
  const split = { insurance_write_offs: 0, discounts: 0, other_write_offs: 0 };
  const rows = await db.all(
    `SELECT l.adjustment_type, CASE WHEN l.claim_id IS NULL THEN 0 ELSE 1 END AS on_claim, -SUM(l.amount) AS n FROM ledger_entries l
     WHERE l.practice_id = ? AND l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL AND l.amount < 0 AND ${LIVE()} AND l.entry_date BETWEEN ? AND ?${s.sql}
     GROUP BY l.adjustment_type, CASE WHEN l.claim_id IS NULL THEN 0 ELSE 1 END`, pid, from, to, ...s.args,
  );
  for (const r of rows) split[adjustmentKind({ adjustment_type: r.adjustment_type, claim_id: Number(r.on_claim) ? 1 : null })] += Number(r.n);
  return { charges: Number(t.charges), adjustments: split.insurance_write_offs + split.discounts + split.other_write_offs, split, received: Number(t.received), refunds: Number(t.refunds) };
}

// A patient's first visit: the earliest completed appointment or completed procedure's charge.
const FIRST_VISITS = `SELECT x.patient_id, MIN(x.d) AS first_visit FROM (
    SELECT a.patient_id, substr(a.start_time, 1, 10) AS d FROM appointments a WHERE a.practice_id = ? AND a.status = 'completed'
    UNION ALL
    SELECT l.patient_id, l.entry_date AS d FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'charge' AND l.procedure_id IS NOT NULL AND ${LIVE()}
  ) x GROUP BY x.patient_id`;

async function newPatients(db, pid, o) {
  const s = scope(o, { location: 'p.location_id' });
  const rows = await db.all(
    `SELECT f.patient_id, f.first_visit, p.first_name, p.last_name, COALESCE(NULLIF(p.referral_source, ''), 'Not recorded') AS source
     FROM (${FIRST_VISITS}) f JOIN patients p ON p.id = f.patient_id
     WHERE f.first_visit BETWEEN ? AND ? AND p.merged_into_id IS NULL${s.sql} ORDER BY f.first_visit, p.last_name`, pid, pid, o.from, o.to, ...s.args,
  );
  return rows;
}

async function caseAcceptance(db, pid, o) {
  const [fromUtc, toUtc] = await utcRange(db, pid, o.from, o.to);
  const s = scope(o, { provider: 'pr.provider_id = ?', location: 'pr.location_id' });
  return db.get(
    `SELECT COALESCE(SUM(pr.fee),0) AS presented, COALESCE(SUM(CASE WHEN tp.status IN ('accepted','completed') THEN pr.fee ELSE 0 END),0) AS accepted,
       COUNT(DISTINCT tp.id) AS plans, COUNT(DISTINCT CASE WHEN tp.status IN ('accepted','completed') THEN tp.id END) AS accepted_plans
     FROM treatment_plans tp JOIN procedures pr ON pr.treatment_plan_id = tp.id
     WHERE tp.practice_id = ? AND tp.created_at >= ? AND tp.created_at < ? AND pr.status != 'cancelled'${s.sql}`, pid, fromUtc, toUtc, ...s.args,
  );
}

// Hygiene visits completed in range whose patient left with the next visit booked (booked by the day of the visit).
const REBOOKED = `EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.start_time > a.start_time
  AND b.status NOT IN ('cancelled','no_show') AND substr(b.created_at, 1, 10) <= substr(a.start_time, 1, 10))`;
async function hygieneReappointment(db, pid, o) {
  const s = scope(o, { provider: 'a.provider_id = ?', location: 'a.location_id' });
  return db.get(
    `SELECT COUNT(*) AS visits, COALESCE(SUM(CASE WHEN ${REBOOKED} THEN 1 ELSE 0 END),0) AS reappointed
     FROM appointments a JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?${s.sql}`,
    pid, `${o.from} 00:00`, `${o.to} 24:00`, ...s.args,
  );
}

// Visits in range up to today: kept (completed / here now) vs broken (no-show or cancelled).
async function appointmentOutcomes(db, pid, o) {
  const s = scope(o, { provider: 'a.provider_id = ?', location: 'a.location_id' });
  const end = o.to < o.today ? o.to : o.today;
  return db.get(
    `SELECT COALESCE(SUM(CASE WHEN a.status IN ('completed','checked_in','in_chair') THEN 1 ELSE 0 END),0) AS kept,
       COALESCE(SUM(CASE WHEN a.status IN ('no_show','cancelled') THEN 1 ELSE 0 END),0) AS broken,
       COALESCE(SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END),0) AS no_shows
     FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${s.sql}`,
    pid, `${o.from} 00:00`, `${end} 24:00`, ...s.args,
  );
}

// Planned treatment not on a live appointment, for active patients, on no plan or a plan still open.
const UNSCHEDULED = `pr.status = 'planned' AND p.status = 'active' AND p.merged_into_id IS NULL
  AND (pr.appointment_id IS NULL OR EXISTS (SELECT 1 FROM appointments x WHERE x.id = pr.appointment_id AND x.status IN ('cancelled','no_show')))
  AND (pr.treatment_plan_id IS NULL OR EXISTS (SELECT 1 FROM treatment_plans tp WHERE tp.id = pr.treatment_plan_id AND tp.status IN ('proposed','accepted')))`;
async function unscheduled(db, pid, o) {
  const s = scope(o, { provider: 'pr.provider_id = ?', location: 'pr.location_id' });
  return db.get(
    `SELECT COALESCE(SUM(pr.fee),0) AS amount, COUNT(*) AS procedures, COUNT(DISTINCT pr.patient_id) AS patients
     FROM procedures pr JOIN patients p ON p.id = pr.patient_id WHERE pr.practice_id = ? AND ${UNSCHEDULED}${s.sql}`, pid, ...s.args,
  );
}

// Claims sent more than 30 days before `asOf` with no answer yet.
const CLAIM_PROVIDER = 'EXISTS (SELECT 1 FROM claim_items ci JOIN procedures cp ON cp.id = ci.procedure_id WHERE ci.claim_id = c.id AND cp.provider_id = ?)';
async function claimsWaiting(db, pid, o) {
  const s = scope(o, { provider: CLAIM_PROVIDER, location: 'c.location_id' });
  return db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN c.estimated_amount > c.paid_amount THEN c.estimated_amount - c.paid_amount ELSE 0 END),0) AS expected
     FROM claims c WHERE c.practice_id = ? AND c.status = 'submitted' AND c.submitted_at IS NOT NULL AND substr(c.submitted_at, 1, 10) < ?${s.sql}`,
    pid, addDays(o.asOf, -30), ...s.args,
  );
}

// Recall for active patients (not turned off): overdue, due in the next 30 days, and current (not yet due, or booked).
const RECALL_PROVIDER = '(p.primary_hygienist_id = ? OR p.primary_provider_id = ?)';
async function recall(db, pid, o) {
  const s = scope(o, { provider: RECALL_PROVIDER, location: 'p.location_id' });
  const d = o.asOf;
  return db.get(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN r.status IN ('due','contacted') AND r.due_date < ? THEN 1 ELSE 0 END),0) AS overdue,
       COALESCE(SUM(CASE WHEN r.status IN ('due','contacted') AND r.due_date >= ? AND r.due_date <= ? THEN 1 ELSE 0 END),0) AS due_soon,
       COALESCE(SUM(CASE WHEN r.due_date >= ? OR r.status = 'scheduled' THEN 1 ELSE 0 END),0) AS current_n
     FROM recalls r JOIN patients p ON p.id = r.patient_id
     WHERE r.practice_id = ? AND p.status = 'active' AND r.status != 'inactive'${s.sql}`, d, d, addDays(d, 30), d, pid, ...s.args,
  );
}

// ---- The schedule (booked visits on dates) ----
const INACTIVE = "('cancelled','no_show')";
async function bookedVisits(db, pid, o) {
  const s = scope(o, { provider: 'a.provider_id = ?', location: 'a.location_id' });
  return db.all(
    `SELECT a.id, a.patient_id, a.provider_id, a.start_time, a.end_time, a.status, a.location_id, p.first_name, p.last_name, p.guarantor_id, pv.name AS provider_name,
       (SELECT COALESCE(SUM(fee), 0) FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS production
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ${INACTIVE}${s.sql} ORDER BY a.start_time`,
    pid, `${o.from} 00:00`, `${o.to} 24:00`, ...s.args,
  );
}

// Same rule as the morning huddle: the patient's active primary (else secondary) policy with no eligibility check
// in the 30 days before the visit.
async function toVerify(db, visits) {
  const ids = [...new Set(visits.map((v) => v.patient_id))];
  if (!ids.length) return [];
  const policies = new Map();
  for (const x of await db.all(`SELECT id, patient_id FROM patient_insurance WHERE patient_id IN (${IN(ids)}) AND active = 1 ORDER BY patient_id, CASE priority WHEN 'primary' THEN 0 ELSE 1 END, id`, ...ids)) {
    if (!policies.has(x.patient_id)) policies.set(x.patient_id, x.id);
  }
  const pol = [...policies.values()];
  const last = new Map();
  if (pol.length) for (const e of await db.all(`SELECT patient_insurance_id, MAX(created_at) AS at FROM eligibility_checks WHERE patient_insurance_id IN (${IN(pol)}) GROUP BY patient_insurance_id`, ...pol)) last.set(e.patient_insurance_id, e.at);
  return visits.filter((v) => {
    const policy = policies.get(v.patient_id);
    if (!policy) return false;
    const at = last.get(policy);
    return !at || at.slice(0, 10) < addDays(v.start_time.slice(0, 10), -30);
  });
}

// Family balances (the guarantor's household) of the patients booked, counted once per household.
async function balancesDue(db, pid, visits) {
  const heads = [...new Set(visits.map((v) => v.guarantor_id || v.patient_id))];
  if (!heads.length) return [];
  const rows = await db.all(
    // Written as guarantor-or-self from the practice's patients (not COALESCE(...) IN over the ledger) so it reads
    // only those households' entries: the old form read every ledger entry in the practice.
    `SELECT COALESCE(p.guarantor_id, p.id) AS g, COALESCE(SUM(l.amount),0) AS n FROM patients p JOIN ledger_entries l ON l.patient_id = p.id
     WHERE p.practice_id = ? AND (p.guarantor_id IN (${IN(heads)}) OR (p.guarantor_id IS NULL AND p.id IN (${IN(heads)}))) GROUP BY COALESCE(p.guarantor_id, p.id)`, pid, ...heads, ...heads,
  );
  const owed = new Map(rows.filter((r) => Number(r.n) > 0).map((r) => [r.g, Number(r.n)]));
  const seen = new Set();
  const out = [];
  for (const v of visits) {
    const g = v.guarantor_id || v.patient_id;
    if (!owed.has(g) || seen.has(g)) continue;
    seen.add(g);
    out.push({ ...v, balance: owed.get(g) });
  }
  return out;
}

const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const datesBetween = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };

// Free stretches of 30 minutes or more inside each working provider's hours, not taken by a visit or a blocked
// time (reserved blocks still count as open: they're kept for a kind of visit, not closed).
async function openGaps(db, pid, o, visits) {
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', pid);
  const location = o.locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', o.locationId, pid) : null;
  const office = location?.office_hours ? { ...practice, office_hours: location.office_hours } : practice;
  const providers = await db.all(`SELECT * FROM providers WHERE practice_id = ? AND active = 1${o.providerId ? ' AND id = ?' : ''} ORDER BY name`, pid, ...(o.providerId ? [o.providerId] : []));
  const blockouts = await db.all(
    "SELECT provider_id, operatory_id, start_time, end_time FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ? AND COALESCE(kind, 'blocked') = 'blocked'",
    pid, `${o.to} 24:00`, `${o.from} 00:00`,
  );
  const gaps = [];
  for (const date of datesBetween(o.from, o.to)) {
    // Only time that can still be filled: today and later.
    if (date < o.today || !hoursFor(office, date).length) continue;
    for (const pv of providers) {
      const hours = await providerHoursOn(db, office, pv, date);
      if (!hours?.length) continue;
      const busy = [
        ...visits.filter((v) => v.provider_id === pv.id && v.start_time.slice(0, 10) === date),
        ...blockouts.filter((b) => (b.provider_id === pv.id || (!b.provider_id && !b.operatory_id)) && b.start_time.slice(0, 10) <= date && b.end_time.slice(0, 10) >= date),
      ].map((b) => [b.start_time.slice(0, 10) < date ? 0 : toMin(b.start_time.slice(11, 16)), b.end_time.slice(0, 10) > date ? 1440 : toMin(b.end_time.slice(11, 16))]).sort((a, b) => a[0] - b[0]);
      for (const [open, close] of hours) {
        let at = toMin(open);
        const end = toMin(close);
        for (const [s, e] of busy) {
          if (e <= at || s >= end) continue;
          if (s - at >= 30) gaps.push({ date, provider_id: pv.id, provider_name: pv.name, start: toHm(at), end: toHm(s), minutes: s - at });
          at = Math.max(at, e);
        }
        if (end - at >= 30) gaps.push({ date, provider_id: pv.id, provider_name: pv.name, start: toHm(at), end: toHm(end), minutes: end - at });
      }
    }
  }
  return gaps;
}

// ---- Computing a set of metrics ----

// o: { from, to, today, providerId?, locationId?, keys? }. Snapshot metrics are as of `to` (A/R exactly, the
// rest from stored daily snapshots for past dates, live for today). Returns { values, parts }.
export async function computeMetrics(db, pid, o) {
  const keys = o.keys || Object.keys(METRICS);
  const want = (...k) => k.some((x) => keys.includes(x));
  const values = {};
  const parts = {};
  const set = (k, v, p) => {
    if (!keys.includes(k)) return;
    values[k] = supported(k, o) ? v : null;
    if (p) parts[k] = p;
  };
  // "Right now" metrics (kind snapshot) are as of `to`; with liveSnapshots (what a screen or an email shows
  // as the current value) they're as of today, whatever the period.
  const opts = { ...o, asOf: o.liveSnapshots || o.to > o.today ? o.today : o.to };

  if (want('production_gross', 'adjustments', 'production_net', 'collections', 'collection_rate')) {
    const m = await money(db, pid, opts);
    const collections = m.received - m.refunds;
    set('production_gross', m.charges);
    set('adjustments', m.adjustments, m.split);
    set('production_net', m.charges - m.adjustments);
    set('collections', collections, { received: m.received, refunds: m.refunds });
    set('collection_rate', pct(collections, m.charges - m.adjustments), { collections, net_production: m.charges - m.adjustments });
  }
  if (want('new_patients')) {
    const rows = supported('new_patients', o) ? await newPatients(db, pid, opts) : [];
    const bySource = {};
    for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
    set('new_patients', rows.length, { by_source: Object.entries(bySource).map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n) });
  }
  if (want('case_acceptance')) {
    const c = await caseAcceptance(db, pid, opts);
    set('case_acceptance', pct(Number(c.accepted), Number(c.presented)), { presented: Number(c.presented), accepted: Number(c.accepted), plans: Number(c.plans), accepted_plans: Number(c.accepted_plans) });
  }
  if (want('diagnosed')) {
    const d = summarize(await loadDiagnoses(db, pid, opts), { providerId: opts.providerId || null }).totals;
    set('diagnosed', d.diagnosed, { expected: d.expected, exams: d.exams, per_exam: d.per_exam, scheduled: d.scheduled, completed: d.completed });
  }
  if (want('hygiene_reappointment')) {
    const h = await hygieneReappointment(db, pid, opts);
    set('hygiene_reappointment', pct(Number(h.reappointed), Number(h.visits)), { visits: Number(h.visits), reappointed: Number(h.reappointed) });
  }
  if (want('broken_appointments', 'broken_rate')) {
    const a = await appointmentOutcomes(db, pid, opts);
    set('broken_appointments', Number(a.broken), { no_shows: Number(a.no_shows), cancelled: Number(a.broken) - Number(a.no_shows) });
    set('broken_rate', pct(Number(a.broken), Number(a.kept) + Number(a.broken)), { kept: Number(a.kept), broken: Number(a.broken) });
  }
  const live = opts.asOf >= o.today;
  if (want(...SNAPSHOT_STORED) && !live) {
    // A past date: what was stored that evening (null when nothing was recorded then).
    const stored = await snapshotValues(db, pid, opts.asOf, o);
    for (const k of SNAPSHOT_STORED) set(k, fromStored(k, stored[k] ?? null));
  } else {
    if (want('unscheduled_treatment')) {
      const u = await unscheduled(db, pid, opts);
      set('unscheduled_treatment', Number(u.amount), { procedures: Number(u.procedures), patients: Number(u.patients) });
    }
    if (want('claims_over_30')) {
      const c = await claimsWaiting(db, pid, opts);
      set('claims_over_30', Number(c.n), { expected: Number(c.expected) });
    }
    if (want('recall_due', 'recall_overdue', 'recall_current_rate')) {
      const r = await recall(db, pid, opts);
      set('recall_due', Number(r.due_soon));
      set('recall_overdue', Number(r.overdue));
      set('recall_current_rate', pct(Number(r.current_n), Number(r.total)), { current: Number(r.current_n), total: Number(r.total) });
    }
  }
  if (want('ar_total', 'ar_over_90')) {
    const { totals } = await agingReport(db, pid, opts.asOf, { family: true });
    set('ar_total', totals.total, { current: totals.current, d31_60: totals.d31_60, d61_90: totals.d61_90, d90_plus: totals.d90_plus, insurance_pending: totals.insurance_pending, patient_portion: totals.patient_portion });
    set('ar_over_90', totals.d90_plus);
  }
  if (want('visits', 'scheduled_production', 'open_gaps', 'unconfirmed', 'insurance_to_verify', 'balances_due')) {
    const visits = await bookedVisits(db, pid, opts);
    set('visits', visits.length);
    set('scheduled_production', visits.reduce((s, v) => s + Number(v.production), 0));
    set('unconfirmed', visits.filter((v) => v.status === 'scheduled').length);
    if (want('insurance_to_verify')) set('insurance_to_verify', (await toVerify(db, visits)).length);
    if (want('balances_due')) {
      const b = await balancesDue(db, pid, visits);
      set('balances_due', b.reduce((s, x) => s + x.balance, 0), { households: b.length });
    }
    if (want('open_gaps')) {
      const g = await openGaps(db, pid, opts, visits);
      set('open_gaps', g.length, { minutes: g.reduce((s, x) => s + x.minutes, 0) });
    }
  }
  return { values, parts };
}

// ---- Daily snapshots of the "right now" metrics ----
const scopeKey = (o) => (o.providerId ? `provider:${o.providerId}` : o.locationId ? `location:${o.locationId}` : 'practice');
export async function snapshotValues(db, pid, date, o = {}) {
  const key = scopeKey(o);
  // The nearest snapshot on or up to three days before the date (a weekend without a job run, say).
  const rows = await db.all(
    'SELECT metric, value, snapshot_date FROM metric_snapshots WHERE practice_id = ? AND scope_key = ? AND snapshot_date <= ? AND snapshot_date >= ? ORDER BY snapshot_date DESC',
    pid, key, date, addDays(date, -3),
  );
  const out = {};
  for (const r of rows) if (!(r.metric in out)) out[r.metric] = r.value == null ? null : Number(r.value);
  return out;
}

// Stores today's values for the practice and each office (once a day; later calls that day change nothing).
export async function recordSnapshots(db, pid, today) {
  const scopes = [{}, ...(await db.all('SELECT id FROM locations WHERE practice_id = ? AND active = 1', pid)).map((l) => ({ locationId: l.id }))];
  let n = 0;
  for (const s of scopes) {
    const { values } = await computeMetrics(db, pid, { from: today, to: today, today, keys: SNAPSHOT_STORED, ...s });
    for (const k of SNAPSHOT_STORED) {
      const v = values[k] == null ? null : Math.round(values[k] * (METRICS[k].unit === 'percent' ? 10 : 1));
      n += (await db.run(
        'INSERT INTO metric_snapshots (practice_id, snapshot_date, scope_key, metric, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT (practice_id, snapshot_date, scope_key, metric) DO NOTHING',
        pid, today, scopeKey(s), k, v,
      )).changes;
    }
  }
  return n;
}
// Percentages are stored in tenths; read back as a percentage.
export const fromStored = (k, v) => (v == null ? null : METRICS[k].unit === 'percent' ? v / 10 : v);

// ---- Goals ----
const parseTargets = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
export const goalToValue = (metric, stored) => (METRICS[metric].unit === 'percent' ? stored / 10 : stored);

// Open office days in [from, to] (the office's hours, or one office's own).
async function openDays(db, pid, from, to, locationId) {
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', pid);
  const loc = locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, pid) : null;
  const office = loc?.office_hours ? { office_hours: loc.office_hours } : practice;
  return datesBetween(from, to).filter((d) => hoursFor(office, d).length > 0);
}

// The goal for each metric over [from, to] for a scope: the scope's own goal (provider, office, practice — a
// provider or office never borrows the practice's), then for the whole practice its older settings (daily goal,
// percentage targets), then the industry benchmark. Monthly goals are prorated by open office days.
export async function goalsFor(db, pid, o) {
  const key = scopeKey(o);
  const rows = new Map((await db.all('SELECT metric, value FROM metric_goals WHERE practice_id = ? AND scope_key = ?', pid, key)).map((r) => [r.metric, Number(r.value)]));
  const practice = await db.get('SELECT daily_goal, kpi_targets FROM practices WHERE id = ?', pid);
  const targets = parseTargets(practice?.kpi_targets);
  const provider = o.providerId ? await db.get('SELECT daily_goal FROM providers WHERE id = ? AND practice_id = ?', o.providerId, pid) : null;
  const days = await openDays(db, pid, o.from, o.to, o.locationId);
  // Monthly goal → the share for the open days of [from, to] in each month it touches.
  const monthsShare = async (monthly) => {
    let total = 0;
    for (const month of [...new Set(datesBetween(o.from, o.to).map((d) => d.slice(0, 7)))]) {
      const first = `${month}-01`;
      const last = addDays(`${addDays(first, 32).slice(0, 7)}-01`, -1);
      const all = await openDays(db, pid, first, last, o.locationId);
      const inRange = days.filter((d) => d.startsWith(month)).length;
      if (all.length) total += (monthly * inRange) / all.length;
    }
    return Math.round(total);
  };
  const out = {};
  for (const [k, def] of Object.entries(METRICS)) {
    if (!def.goal) continue;
    let goal = null;
    let source = null;
    if (rows.has(k)) {
      const v = goalToValue(k, rows.get(k));
      goal = def.goal === 'month' ? await monthsShare(v) : def.goal === 'day' ? v * days.length : v;
      source = key === 'practice' ? 'practice goal' : key.startsWith('provider') ? 'provider goal' : 'office goal';
    } else if (k === 'scheduled_production' || (k === 'production_gross' && !rows.has('production_gross'))) {
      // The practice's (or provider's) daily production goal from Settings.
      const daily = o.providerId ? provider?.daily_goal : !o.locationId ? practice?.daily_goal : null;
      if (daily > 0) { goal = daily * days.length; source = o.providerId ? 'provider daily goal' : 'daily goal'; }
    } else if (key === 'practice' && TARGET_KEYS[k] && targets[TARGET_KEYS[k]] != null) {
      goal = k === 'new_patients' ? await monthsShare(Number(targets.new_patients)) : Number(targets[TARGET_KEYS[k]]);
      source = 'practice goal';
    }
    if (goal == null && BENCHMARKS[k] != null) { goal = BENCHMARKS[k]; source = 'benchmark'; }
    if (goal != null) out[k] = { goal, source };
  }
  return out;
}

// ---- Periods and comparisons ----
export const lastYear = (d) => {
  const y = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  return isDate(y) ? y : addDays(`${y.slice(0, 8)}28`, 0); // Feb 29 → Feb 28
};
// The period just before [from, to]: the previous calendar month for whole months, otherwise the same length.
export function previousRange(from, to) {
  const monthStart = from.endsWith('-01');
  const nextDay = addDays(to, 1);
  if (monthStart && nextDay.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) {
    const prevEnd = addDays(from, -1);
    return { from: `${prevEnd.slice(0, 7)}-01`, to: prevEnd };
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

// How a value stands against its goal: 'good', 'watch' (within 10%) or 'behind'.
export function standing(key, value, goal) {
  const def = METRICS[key];
  if (value == null || goal == null || def.better === 'neutral') return null;
  if (def.better === 'higher') return value >= goal ? 'good' : goal && value >= goal * 0.9 ? 'watch' : 'behind';
  return value <= goal ? 'good' : value <= goal * 1.1 ? 'watch' : 'behind';
}
export const changePct = (value, before) => (value == null || before == null || before === 0 ? null : Math.round(((value - before) / Math.abs(before)) * 1000) / 10);

// Everything a screen or an email shows for a period: each metric now, the period before, the same dates last
// year, the goal, and how it stands. o: { from, to, today, providerId?, locationId?, keys? }.
export async function compareMetrics(db, pid, o) {
  const keys = o.keys || Object.keys(METRICS);
  const prev = o.previous || previousRange(o.from, o.to);
  const ly = { from: lastYear(o.from), to: lastYear(o.to) };
  // Schedule metrics compare against their goal only. "Right now" metrics show today's value, compared with
  // the stored value one period-length ago and a year ago.
  const periodKeys = keys.filter((k) => METRICS[k].kind === 'period');
  const snapKeys = keys.filter((k) => METRICS[k].kind === 'snapshot');
  const span = Math.round((Date.parse(o.to) - Date.parse(o.from)) / 86400_000) + 1;
  const at = (d) => ({ from: d, to: d });
  const none = { values: {} };
  const [now, before, yearAgo, snapBefore, snapYearAgo, goals] = [
    await computeMetrics(db, pid, { ...o, keys, liveSnapshots: true }),
    periodKeys.length ? await computeMetrics(db, pid, { ...o, ...prev, keys: periodKeys }) : none,
    periodKeys.length ? await computeMetrics(db, pid, { ...o, ...ly, keys: periodKeys }) : none,
    snapKeys.length ? await computeMetrics(db, pid, { ...o, ...at(addDays(o.today, -span)), keys: snapKeys }) : none,
    snapKeys.length ? await computeMetrics(db, pid, { ...o, ...at(lastYear(o.today)), keys: snapKeys }) : none,
    await goalsFor(db, pid, o),
  ];
  // Before the practice's first ledger entry there's nothing to compare with (a new practice's "last year" isn't $0).
  const first = (await db.get('SELECT MIN(entry_date) AS d FROM ledger_entries WHERE practice_id = ?', pid))?.d || null;
  const hadData = (end) => !!first && first <= end;
  const metrics = keys.map((k) => {
    const def = METRICS[k];
    const value = now.values[k] ?? null;
    const snap = def.kind === 'snapshot';
    const previousValue = hadData(snap ? addDays(o.today, -span) : prev.to) ? (snap ? snapBefore : before).values[k] ?? null : null;
    const lastYearValue = hadData(snap ? lastYear(o.today) : ly.to) ? (snap ? snapYearAgo : yearAgo).values[k] ?? null : null;
    const g = goals[k] || null;
    return {
      key: k, label: def.label, unit: def.unit, better: def.better, kind: def.kind, drill: def.drill,
      value, parts: now.parts[k] || null,
      previous: previousValue, change: changePct(value, previousValue),
      last_year: lastYearValue, change_last_year: changePct(value, lastYearValue),
      goal: g?.goal ?? null, goal_source: g?.source ?? null, standing: standing(k, value, g?.goal ?? null),
      scoped_out: value == null && !supported(k, o),
    };
  });
  return { from: o.from, to: o.to, previous: prev, last_year: ly, provider_id: o.providerId || null, location_id: o.locationId || null, metrics };
}

// ---- Drill-down: the rows behind a number ----
const person = (r) => ({ patient_id: r.patient_id, first_name: r.first_name, last_name: r.last_name });

// Rows for one metric over o (as for computeMetrics). Each row is about one patient, claim, visit or gap, with
// what it adds to the number. limit caps the list (the total stays in `count`).
export async function metricRows(db, pid, key, o, { limit = 500 } = {}) {
  const def = METRICS[key];
  if (!def) return null;
  const opts = { ...o, asOf: o.to > o.today ? o.today : o.to };
  if (!supported(key, o)) return { key, columns: [], rows: [], count: 0, note: 'Not tracked for this filter' };
  const cap = (rows, columns, extra = {}) => ({ key, label: def.label, columns, rows: rows.slice(0, limit), count: rows.length, ...extra });
  switch (key) {
    case 'production_gross': case 'production_net': case 'adjustments': case 'collections': case 'collection_rate': {
      const types = key === 'production_gross' ? ['charge'] : key === 'adjustments' ? ['adjustment'] : key === 'production_net' ? ['charge', 'adjustment'] : ['payment', 'insurance_payment', 'refund'];
      const s = scope(opts, { provider: 'l.provider_id = ?', location: 'l.location_id' });
      const rows = await db.all(
        `SELECT l.id, l.entry_date, l.type, l.amount, l.description, l.adjustment_type, l.patient_id, p.first_name, p.last_name, pv.name AS provider_name
         FROM ledger_entries l JOIN patients p ON p.id = l.patient_id LEFT JOIN providers pv ON pv.id = l.provider_id
         WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ? AND ${LIVE()} AND l.type IN (${IN(types)})${types.includes('adjustment') ? " AND (l.type != 'adjustment' OR l.amount < 0)" : ''}${s.sql}
         ORDER BY l.entry_date DESC, l.id DESC`, pid, opts.from, opts.to, ...types, ...s.args,
      );
      return cap(rows, ['entry_date', 'patient', 'type', 'description', 'provider_name', 'amount'],
        opts.providerId && ['collections', 'collection_rate', 'adjustments'].includes(key) ? { note: 'For one provider the number is their share of each payment (see Collections by provider); these are the entries on their patients’ accounts.' } : {});
    }
    case 'new_patients': {
      const rows = await newPatients(db, pid, opts);
      return cap(rows.map((r) => ({ ...person(r), first_visit: r.first_visit, source: r.source })), ['first_visit', 'patient', 'source']);
    }
    case 'case_acceptance': {
      const [fromUtc, toUtc] = await utcRange(db, pid, opts.from, opts.to);
      const s = scope(opts, { provider: 'pr.provider_id = ?', location: 'pr.location_id' });
      const rows = await db.all(
        `SELECT tp.id AS plan_id, tp.name, tp.status, tp.created_at, tp.patient_id, p.first_name, p.last_name, COALESCE(SUM(pr.fee),0) AS presented,
           CASE WHEN tp.status IN ('accepted','completed') THEN COALESCE(SUM(pr.fee),0) ELSE 0 END AS accepted
         FROM treatment_plans tp JOIN procedures pr ON pr.treatment_plan_id = tp.id JOIN patients p ON p.id = tp.patient_id
         WHERE tp.practice_id = ? AND tp.created_at >= ? AND tp.created_at < ? AND pr.status != 'cancelled'${s.sql}
         GROUP BY tp.id, tp.name, tp.status, tp.created_at, tp.patient_id, p.first_name, p.last_name ORDER BY tp.created_at DESC`, pid, fromUtc, toUtc, ...s.args,
      );
      return cap(rows, ['created_at', 'patient', 'name', 'status', 'presented', 'accepted']);
    }
    case 'diagnosed': {
      const { rows } = await diagnosisPatients(db, pid, opts, { stage: 'all' });
      return cap(rows.map((r) => ({ ...person(r), date: r.exam_date, exam_type: r.exam_type.replace('_', ' '), provider_name: r.provider_name, amount: r.diagnosed, completed: r.completed, open: r.open, stage: r.stage })),
        ['date', 'patient', 'exam_type', 'provider_name', 'amount', 'completed', 'open', 'stage'], { note: 'One row per exam: the treatment diagnosed at it (office fees), what has been completed since, and what is still open.' });
    }
    case 'hygiene_reappointment': {
      const s = scope(opts, { provider: 'a.provider_id = ?', location: 'a.location_id' });
      const rows = await db.all(
        `SELECT a.id AS appointment_id, a.start_time, a.patient_id, p.first_name, p.last_name, pv.name AS provider_name, CASE WHEN ${REBOOKED} THEN 1 ELSE 0 END AS reappointed
         FROM appointments a JOIN providers pv ON pv.id = a.provider_id JOIN patients p ON p.id = a.patient_id
         WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?${s.sql}
         ORDER BY CASE WHEN ${REBOOKED} THEN 1 ELSE 0 END, a.start_time DESC`, pid, `${opts.from} 00:00`, `${opts.to} 24:00`, ...s.args,
      );
      return cap(rows.map((r) => ({ ...r, reappointed: !!Number(r.reappointed) })), ['start_time', 'patient', 'provider_name', 'reappointed']);
    }
    case 'broken_appointments': case 'broken_rate': {
      const s = scope(opts, { provider: 'a.provider_id = ?', location: 'a.location_id' });
      const end = opts.to < opts.today ? opts.to : opts.today;
      const rows = await db.all(
        `SELECT a.id AS appointment_id, a.start_time, a.status, a.broken_reason, a.patient_id, p.first_name, p.last_name, pv.name AS provider_name,
           (SELECT MIN(b.start_time) FROM appointments b WHERE b.patient_id = a.patient_id AND b.start_time > a.start_time AND b.status NOT IN ('cancelled','no_show')) AS rebooked_for
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
         WHERE a.practice_id = ? AND a.status IN ('no_show','cancelled') AND a.start_time >= ? AND a.start_time < ?${s.sql} ORDER BY a.start_time DESC`,
        pid, `${opts.from} 00:00`, `${end} 24:00`, ...s.args,
      );
      return cap(rows, ['start_time', 'patient', 'status', 'broken_reason', 'provider_name', 'rebooked_for']);
    }
    case 'unscheduled_treatment': {
      const s = scope(opts, { provider: 'pr.provider_id = ?', location: 'pr.location_id' });
      const rows = await db.all(
        `SELECT pr.patient_id, p.first_name, p.last_name, COUNT(*) AS procedures, COALESCE(SUM(pr.fee),0) AS amount, MIN(pr.created_at) AS oldest
         FROM procedures pr JOIN patients p ON p.id = pr.patient_id WHERE pr.practice_id = ? AND ${UNSCHEDULED}${s.sql}
         GROUP BY pr.patient_id, p.first_name, p.last_name ORDER BY COALESCE(SUM(pr.fee),0) DESC`, pid, ...s.args,
      );
      return cap(rows, ['patient', 'procedures', 'amount', 'oldest']);
    }
    case 'ar_total': case 'ar_over_90': {
      const { rows } = await agingReport(db, pid, opts.asOf, { family: true });
      const list = rows.filter((r) => key === 'ar_total' || r.d90_plus > 0).map((r) => ({ patient_id: r.id, first_name: r.first_name, last_name: r.last_name, balance: r.balance, d90_plus: r.d90_plus, insurance_pending: r.insurance_pending, patient_portion: r.patient_portion }));
      if (key === 'ar_over_90') list.sort((a, b) => b.d90_plus - a.d90_plus);
      return cap(list, ['patient', 'balance', 'd90_plus', 'insurance_pending', 'patient_portion']);
    }
    case 'claims_over_30': {
      const s = scope(opts, { provider: CLAIM_PROVIDER, location: 'c.location_id' });
      const rows = await db.all(
        `SELECT c.id AS claim_id, c.submitted_at, c.total_fee, c.estimated_amount, c.follow_up_date, c.patient_id, p.first_name, p.last_name, ic.name AS carrier
         FROM claims c JOIN patients p ON p.id = c.patient_id LEFT JOIN patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
         WHERE c.practice_id = ? AND c.status = 'submitted' AND c.submitted_at IS NOT NULL AND substr(c.submitted_at, 1, 10) < ?${s.sql} ORDER BY c.submitted_at`,
        pid, addDays(opts.asOf, -30), ...s.args,
      );
      const asOfMs = Date.parse(`${opts.asOf}T12:00:00Z`);
      return cap(rows.map((r) => ({ ...r, days: Math.floor((asOfMs - Date.parse(`${r.submitted_at.slice(0, 10)}T12:00:00Z`)) / 86400_000) })), ['claim_id', 'patient', 'carrier', 'submitted_at', 'days', 'estimated_amount']);
    }
    case 'recall_due': case 'recall_overdue': case 'recall_current_rate': {
      const s = scope(opts, { provider: RECALL_PROVIDER, location: 'p.location_id' });
      const d = opts.asOf;
      const cond = key === 'recall_due' ? "r.status IN ('due','contacted') AND r.due_date >= ? AND r.due_date <= ?" : "r.status IN ('due','contacted') AND r.due_date < ?";
      const rows = await db.all(
        `SELECT r.id AS recall_id, r.type, r.due_date, r.status, r.last_contacted_at, r.patient_id, p.first_name, p.last_name
         FROM recalls r JOIN patients p ON p.id = r.patient_id WHERE r.practice_id = ? AND p.status = 'active' AND ${cond}${s.sql} ORDER BY r.due_date`,
        pid, ...(key === 'recall_due' ? [d, addDays(d, 30)] : [d]), ...s.args,
      );
      return cap(rows, ['patient', 'type', 'due_date', 'status', 'last_contacted_at']);
    }
    case 'visits': case 'scheduled_production': case 'unconfirmed': case 'insurance_to_verify': case 'balances_due': case 'open_gaps': {
      const visits = await bookedVisits(db, pid, opts);
      if (key === 'open_gaps') return cap(await openGaps(db, pid, opts, visits), ['date', 'provider_name', 'start', 'end', 'minutes']);
      const list = key === 'unconfirmed' ? visits.filter((v) => v.status === 'scheduled')
        : key === 'insurance_to_verify' ? await toVerify(db, visits)
          : key === 'balances_due' ? await balancesDue(db, pid, visits) : visits;
      const rows = list.map((v) => ({ appointment_id: v.id, start_time: v.start_time, status: v.status, ...person(v), provider_name: v.provider_name, production: Number(v.production), ...(v.balance != null ? { balance: v.balance } : {}) }));
      return cap(rows, ['start_time', 'patient', 'provider_name', 'status', key === 'balances_due' ? 'balance' : 'production']);
    }
    default: return cap([], []);
  }
}


// ---- Diagnosed so far (DX1): today, this week and this month, against the monthly goal ----
// o: { today, providerId?, locationId? }. The week starts on Monday; goals are the `diagnosed` goal (per month,
// prorated by open office days like every monthly goal). A provider or office never borrows the practice's goal.
export async function diagnosisRunning(db, pid, o) {
  const monday = addDays(o.today, -((new Date(`${o.today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const monthStart = `${o.today.slice(0, 7)}-01`;
  const periods = [['today', 'Today', o.today], ['week', 'This week', monday], ['month', 'This month', monthStart]];
  const start = monday < monthStart ? monday : monthStart;
  const loaded = await loadDiagnoses(db, pid, { from: start, to: o.today, providerId: o.providerId || null, locationId: o.locationId || null });
  const slice = (from) => {
    const events = loaded.events.filter((e) => e.date >= from);
    const keys = new Set(events.map((e) => e.key));
    return summarize({ ...loaded, events, findings: loaded.findings.filter((f) => keys.has(f.exam_key)) }, { providerId: o.providerId || null });
  };
  const out = [];
  const perProvider = new Map();
  for (const [key, label, from] of periods) {
    const s = slice(from);
    const g = (await goalsFor(db, pid, { from, to: o.today, providerId: o.providerId || null, locationId: o.locationId || null })).diagnosed || null;
    out.push({
      key, label, from, to: o.today, diagnosed: s.totals.diagnosed, expected: s.totals.expected, exams: s.totals.exams, per_exam: s.totals.per_exam,
      scheduled: s.totals.scheduled, completed: s.totals.completed,
      goal: g?.goal ?? null, goal_source: g?.source ?? null, standing: standing('diagnosed', s.totals.diagnosed, g?.goal ?? null),
    });
    if (o.perProvider) {
      for (const p of s.providers) {
        const row = perProvider.get(p.provider_id) || { provider_id: p.provider_id, name: p.name, type: p.type };
        row[key] = { diagnosed: p.total.diagnosed, expected: p.total.expected, exams: p.total.exams };
        perProvider.set(p.provider_id, row);
      }
    }
  }
  const providers = [];
  for (const row of perProvider.values()) {
    const g = (await goalsFor(db, pid, { from: monthStart, to: o.today, providerId: row.provider_id })).diagnosed || null;
    const zero = { diagnosed: 0, expected: 0, exams: 0 };
    providers.push({ ...row, today: row.today || zero, week: row.week || zero, month: row.month || zero, month_goal: g?.goal ?? null, standing: standing('diagnosed', row.month?.diagnosed ?? 0, g?.goal ?? null) });
  }
  providers.sort((a, b) => b.month.diagnosed - a.month.diagnosed || a.name.localeCompare(b.name));
  return { today: o.today, provider_id: o.providerId || null, location_id: o.locationId || null, periods: out, ...(o.perProvider ? { providers } : {}) };
}

// ---- The value of an exam (EX2): learned from the practice's own cohorts, or the owner's own number ----
// For a horizon of H months (1, 3 or 5): the exams of the 12 months that ended H months ago (e.g. for 5 months,
// exams from 17 to 5 months before today), so every exam has had its full H months. Learned value = the office
// fees of the treatment diagnosed at those exams that was completed within H months of the exam, divided by the
// number of exams (exams with nothing diagnosed count, as $0). Per exam type, and per provider when asked (the
// examining provider or the hygienist of the visit, as in the funnel). The owner can set their own value per exam
// type and horizon (exam_values); `used` is theirs when set, otherwise the learned one.
export const EXAM_VALUE_HORIZONS = [1, 3, 5];
export const EXAM_VALUE_MIN_EXAMS = 10; // fewer exams than this in the window: shown, but flagged low_sample
export function examValueWindow(today, horizon) {
  return { from: addMonths(today, -(horizon + 12)), to: addDays(addMonths(today, -horizon), -1) };
}

// Owner overrides. The exam_values table is added by db.js; until a database has it there are simply none.
export async function examValueOverrides(db, pid, horizon = null) {
  let rows;
  try {
    rows = await db.all(`SELECT exam_type, horizon_months, value_cents FROM exam_values WHERE practice_id = ?${horizon ? ' AND horizon_months = ?' : ''}`, pid, ...(horizon ? [horizon] : []));
  } catch (err) {
    if (/exam_values/.test(String(err?.message))) return []; // table not created on this database yet
    throw err;
  }
  return rows.map((r) => ({ exam_type: r.exam_type, horizon_months: Number(r.horizon_months), value_cents: Number(r.value_cents) }));
}

// { [exam type]: { learned, override, used, diagnosed_per_exam, exams, low_sample, window } } for one horizon.
export async function examValues(db, pid, { providerId = null, locationId = null, horizon = 5, today = null } = {}) {
  if (!EXAM_VALUE_HORIZONS.includes(Number(horizon))) throw new Error(`horizon must be one of ${EXAM_VALUE_HORIZONS.join(', ')} months`);
  const h = Number(horizon);
  const day = today || (await practiceNow(db, pid)).slice(0, 10);
  const window = examValueWindow(day, h);
  const loaded = await loadDiagnoses(db, pid, { ...window, providerId, locationId });
  const acc = Object.fromEntries(Object.keys(EXAM_TYPES).map((t) => [t, { exams: 0, diagnosed: 0, completed: 0 }]));
  for (const ev of loaded.events) acc[ev.exam_type].exams += 1;
  const examDate = new Map(loaded.events.map((ev) => [ev.key, ev.date]));
  for (const f of loaded.findings) {
    const a = acc[f.exam_type];
    a.diagnosed += f.fee;
    if (f.completed_on && f.completed_on <= addMonths(examDate.get(f.exam_key), h)) a.completed += f.fee;
  }
  const overrides = new Map((await examValueOverrides(db, pid, h)).map((o) => [o.exam_type, o.value_cents]));
  const out = {};
  for (const [t, a] of Object.entries(acc)) {
    const learned = a.exams ? Math.round(a.completed / a.exams) : null;
    const override = overrides.has(t) ? overrides.get(t) : null;
    out[t] = {
      learned, override, used: override ?? learned, horizon_months: h,
      diagnosed_per_exam: a.exams ? Math.round(a.diagnosed / a.exams) : null, exams: a.exams, low_sample: a.exams < EXAM_VALUE_MIN_EXAMS, window,
    };
  }
  return out;
}

// ---- Exams on a day (EX1): from the codes on the day's visits ----
// Visits on the date that aren't cancelled or missed; each patient's exam codes that day — procedures on those
// visits (planned or done), else the visit type's codes — plus exams charted done that day without a visit. One
// exam per patient per day, typed like the funnel. Returns { date, total, by_type, completed, patients }.
export async function examsForDay(db, pid, date, { locationId = null, providerId = null } = {}) {
  const rules = await examRules(db, pid);
  const codes = Object.keys(EXAM_CODES);
  const next = addDays(date, 1);
  const visits = await db.all(
    `SELECT a.id, a.patient_id, a.status, t.procedure_codes AS type_codes FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${locationId ? ' AND a.location_id = ?' : ''}${providerId ? ' AND a.provider_id = ?' : ''}`,
    pid, date, next, ...(locationId ? [locationId] : []), ...(providerId ? [providerId] : []),
  );
  const ids = visits.map((v) => v.id);
  const onVisits = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    onVisits.push(...await db.all(`SELECT appointment_id, patient_id, code, status FROM procedures WHERE appointment_id IN (${IN(chunk)}) AND status != 'cancelled' AND code IN (${IN(codes)})`, ...chunk, ...codes));
  }
  const walkIns = await db.all(
    `SELECT patient_id, code, status FROM procedures WHERE practice_id = ? AND appointment_id IS NULL AND status = 'completed' AND code IN (${IN(codes)}) AND completed_at >= ? AND completed_at < ?${locationId ? ' AND location_id = ?' : ''}${providerId ? ' AND provider_id = ?' : ''}`,
    pid, ...codes, date, next, ...(locationId ? [locationId] : []), ...(providerId ? [providerId] : []),
  );
  const byPatient = new Map();
  const add = (patientId, code, done) => {
    const x = byPatient.get(patientId) || { codes: new Set(), done: false };
    x.codes.add(code);
    x.done = x.done || done;
    byPatient.set(patientId, x);
  };
  const withProcs = new Set(onVisits.map((r) => r.appointment_id));
  for (const r of onVisits) add(r.patient_id, r.code, r.status === 'completed');
  for (const v of visits) {
    if (withProcs.has(v.id) || !v.type_codes) continue;
    let list = [];
    try { list = JSON.parse(v.type_codes); } catch { list = []; } // an unreadable visit type just adds no codes
    for (const code of Array.isArray(list) ? list : []) if (EXAM_CODES[code]) add(v.patient_id, code, v.status === 'completed');
  }
  for (const r of walkIns) add(r.patient_id, r.code, true);
  // 'first_exam' rules: whether the patient had a routine exam here before this day.
  const seenBefore = new Set();
  if (Object.values(rules).includes('first_exam') && byPatient.size) {
    const pids = [...byPatient.keys()];
    for (let i = 0; i < pids.length; i += 500) {
      const chunk = pids.slice(i, i + 500);
      for (const r of await db.all(`SELECT DISTINCT patient_id FROM procedures WHERE patient_id IN (${IN(chunk)}) AND status = 'completed' AND code IN (${IN(ROUTINE_EXAMS)}) AND completed_at < ?`, ...chunk, ...ROUTINE_EXAMS, date)) seenBefore.add(r.patient_id);
    }
  }
  const byType = Object.fromEntries(Object.keys(EXAM_TYPES).map((t) => [t, 0]));
  const completed = { ...byType };
  for (const [patientId, x] of byPatient) {
    const t = classifyExam([...x.codes], rules, !seenBefore.has(patientId));
    if (!t) continue;
    byType[t] += 1;
    if (x.done) completed[t] += 1;
  }
  return { date, total: Object.values(byType).reduce((a, b) => a + b, 0), by_type: byType, completed, patients: byPatient.size };
}
