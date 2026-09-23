import { HttpError } from './auth.js';
import { buildQuery, QUERY_META } from './querybuilder.js';
import { agingReport } from './aging.js';
import { financeOverview } from './finance/metrics.js';
import { ppoProfitability } from './finance/ppo.js';
import { openSlots } from './routes/schedule.js';
import { practiceNow } from './util.js';

// Read-only questions about the practice, as tools: used by "Ask your data" in the app (Claude answers
// questions with them, as the signed-in person) and by the MCP server (an outside AI app, with an API key).
// Every tool is limited to the practice and to what the person or key may read. Money is in cents.
const DATE = { type: 'string', description: 'YYYY-MM-DD' };
const dateOr = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : fallback);
const minus = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);
const num = (v) => Number(v) || 0;

const datasetDoc = Object.entries(QUERY_META.datasets).map(([k, d]) => `${k}: ${Object.entries(d.columns).map(([c, v]) => `${c} (${v.type})`).join(', ')}`).join('\n');

export const DATA_TOOLS = [
  {
    name: 'practice_numbers',
    description: 'The practice’s key numbers for a date range: production, collections, adjustments, completed visits, new patients, no-shows and cancellations, treatment presented and accepted, hygiene visits. Defaults to the last 30 days.',
    permission: 'reports:read', scope: 'reports:read',
    input_schema: { type: 'object', properties: { from: DATE, to: DATE } },
    async run(db, pid, input) {
      const today = (await practiceNow(db, pid)).slice(0, 10);
      const to = dateOr(input.to, today);
      const from = dateOr(input.from, minus(to, 29));
      const one = async (sql, ...args) => num((await db.get(sql, ...args))?.n);
      const ledger = (type, extra = '') => one(`SELECT SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type IN (${type}) AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ?${extra}`, pid, from, to);
      const appts = async (status) => one(`SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND status IN (${status}) AND start_time >= ? AND start_time <= ?`, pid, `${from} 00:00`, `${to} 23:59`);
      const completed = await appts("'completed'");
      const noShows = await appts("'no_show'");
      const cancelled = await appts("'cancelled'");
      return {
        from, to,
        production: await ledger("'charge'"), collections: -(await ledger("'payment','insurance_payment','refund'")), adjustments: -(await ledger("'adjustment'", ' AND amount < 0')),
        completed_visits: completed, no_shows: noShows, cancellations: cancelled, no_show_rate_pct: completed + noShows ? Math.round((noShows / (completed + noShows)) * 1000) / 10 : null,
        new_patients: await one("SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?", pid, from, to),
        treatment_presented: await one("SELECT SUM(pr.fee) AS n FROM procedures pr JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id WHERE tp.practice_id = ? AND substr(tp.created_at, 1, 10) BETWEEN ? AND ?", pid, from, to),
        treatment_accepted: await one("SELECT SUM(pr.fee) AS n FROM procedures pr JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id WHERE tp.practice_id = ? AND tp.accepted_at IS NOT NULL AND substr(tp.created_at, 1, 10) BETWEEN ? AND ?", pid, from, to),
        hygiene_visits: await one("SELECT COUNT(DISTINCT pr.appointment_id) AS n FROM procedures pr WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.code IN ('D1110','D1120','D4910','D4341','D4342','D4346') AND substr(pr.completed_at, 1, 10) BETWEEN ? AND ?", pid, from, to),
      };
    },
  },
  {
    name: 'run_report',
    description: `Runs a report over one dataset: pick columns, or group_by one column with aggregates (count, sum, avg, min, max over number/money columns). Filters: {column, op (eq, ne, gt, gte, lt, lte, contains, empty, not_empty), value}. Money filter values are in dollars; money results are in cents. Dates compare as YYYY-MM-DD strings. Datasets and columns:\n${datasetDoc}`,
    permission: 'reports:read', scope: 'reports:read',
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: Object.keys(QUERY_META.datasets) },
        columns: { type: 'array', items: { type: 'string' } },
        filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['column', 'op'] } },
        group_by: { type: 'string' },
        aggregates: { type: 'array', items: { type: 'object', properties: { fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] }, column: { type: 'string' } }, required: ['fn'] } },
        sort: { type: 'object', properties: { column: { type: 'string', description: 'A column key, or agg0/agg1… for an aggregate when grouping' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        limit: { type: 'integer', description: 'At most 200 rows come back' },
      },
      required: ['dataset'],
    },
    async run(db, pid, input) {
      const { sql, args, headers } = buildQuery({ ...input, limit: Math.min(200, Number(input.limit) || 50) }, pid);
      const limit = Math.min(200, Number(input.limit) || 50);
      const rows = (await db.all(sql, ...args)).map((row) => headers.map((_, i) => row[`c${i}`] ?? null));
      return { headers, rows: rows.slice(0, limit), truncated: rows.length > limit };
    },
  },
  {
    name: 'accounts_receivable',
    description: 'What patients owe, by age (current, 31–60, 61–90, over 90 days), how much of it insurance is still expected to pay, and the largest balances.',
    permission: 'billing:read', scope: 'payments:read',
    input_schema: { type: 'object', properties: { top: { type: 'integer', description: 'How many of the largest balances to list (default 10)' } } },
    async run(db, pid, input) {
      const today = (await practiceNow(db, pid)).slice(0, 10);
      const r = await agingReport(db, pid, today);
      return { as_of: today, totals: r.totals, accounts: r.rows.length, largest: r.rows.slice(0, Math.min(50, Number(input.top) || 10)).map((x) => ({ patient_id: x.id, name: `${x.first_name} ${x.last_name}`, balance: x.balance, over_90: x.d90_plus, insurance_pending: x.insurance_pending })) };
    },
  },
  {
    name: 'business_costs',
    description: 'The business side from the bank and QuickBooks: collections, overhead and its categories against typical ranges, profit, cost per visit and per chair hour, month by month.',
    permission: 'finance:read', scope: 'finance:read',
    input_schema: { type: 'object', properties: { months: { type: 'integer', description: '3–24, default 12' } } },
    async run(db, pid, input) {
      const today = (await practiceNow(db, pid)).slice(0, 10);
      const f = await financeOverview(db, pid, { months: Math.min(24, Math.max(3, Number(input.months) || 12)), today });
      return { summary: f.summary, categories: f.categories.filter((c) => c.amount), insights: f.insights.map((i) => i.text), months: f.months.filter((m) => m.source || m.production).map(({ costs: _c, ...m }) => m) };
    },
  },
  {
    name: 'insurance_plan_profitability',
    description: 'For each insurance carrier: fees, PPO write-offs, what was kept per chair hour against what an hour costs, and the estimated effect of leaving the plan.',
    permission: 'finance:read', scope: 'finance:read',
    input_schema: { type: 'object', properties: { months: { type: 'integer' } } },
    async run(db, pid, input) {
      const today = (await practiceNow(db, pid)).slice(0, 10);
      const r = await ppoProfitability(db, pid, { today, months: Math.min(24, Math.max(3, Number(input.months) || 12)) });
      return { cost_per_hour: r.cost_per_hour, carriers: r.carriers.map(({ codes: _c, ...c }) => c), insights: r.insights.map((i) => i.text) };
    },
  },
  {
    name: 'find_patients',
    description: 'Finds patients by name, phone or email. Returns ids to use with patient_summary.',
    permission: 'patients:read', scope: 'patients:read',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run(db, pid, input) {
      const q = String(input.query || '').trim().toLowerCase();
      if (q.length < 2) throw new HttpError(400, 'Search for at least two letters');
      const digits = q.replace(/\D/g, '');
      const parts = q.split(/\s+/);
      const rows = await db.all(
        `SELECT id, first_name, last_name, dob, phone, email, status FROM patients WHERE practice_id = ? AND (
           lower(first_name || ' ' || last_name) LIKE ? OR lower(last_name) LIKE ? OR lower(email) LIKE ?${digits.length >= 4 ? " OR replace(replace(replace(replace(COALESCE(phone, ''), '(', ''), ')', ''), '-', ''), ' ', '') LIKE ?" : ''}
         ) ORDER BY last_name, first_name LIMIT 20`,
        pid, `%${q}%`, `${parts.at(-1)}%`, `%${q}%`, ...(digits.length >= 4 ? [`%${digits}%`] : []),
      );
      return { patients: rows };
    },
  },
  {
    name: 'patient_summary',
    description: 'One patient: contact details, balance, insurance, last and next visits, unscheduled treatment and recall due.',
    permission: 'patients:read', scope: 'patients:read',
    input_schema: { type: 'object', properties: { patient_id: { type: 'integer' } }, required: ['patient_id'] },
    async run(db, pid, input) {
      const p = await db.get('SELECT id, first_name, last_name, preferred_name, dob, phone, email, status, created_at FROM patients WHERE id = ? AND practice_id = ?', Number(input.patient_id), pid);
      if (!p) throw new HttpError(404, 'Patient not found');
      const now = await practiceNow(db, pid);
      const balance = num((await db.get('SELECT SUM(amount) AS n FROM ledger_entries WHERE patient_id = ?', p.id))?.n);
      return {
        ...p, balance,
        insurance: await db.all('SELECT ic.name AS carrier, pi.priority, pi.annual_max, pi.deductible FROM patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE pi.patient_id = ? AND pi.active = 1', p.id),
        last_visit: await db.get("SELECT start_time, reason FROM appointments WHERE patient_id = ? AND status = 'completed' ORDER BY start_time DESC LIMIT 1", p.id) || null,
        next_visit: await db.get("SELECT start_time, reason, status FROM appointments WHERE patient_id = ? AND start_time >= ? AND status IN ('scheduled','confirmed') ORDER BY start_time LIMIT 1", p.id, now) || null,
        unscheduled_treatment: await db.all("SELECT code, description, tooth, fee FROM procedures WHERE patient_id = ? AND status = 'planned' AND appointment_id IS NULL ORDER BY priority, id LIMIT 20", p.id),
        recall: await db.all("SELECT type, due_date, status FROM recalls WHERE patient_id = ? AND status NOT IN ('completed','inactive')", p.id),
      };
    },
  },
  {
    name: 'schedule_for_day',
    description: 'The appointments on one day (default today): time, patient, provider, reason and status.',
    permission: 'appointments:read', scope: 'appointments:read',
    input_schema: { type: 'object', properties: { date: DATE } },
    async run(db, pid, input) {
      const date = dateOr(input.date, (await practiceNow(db, pid)).slice(0, 10));
      const rows = await db.all(
        `SELECT a.id, substr(a.start_time, 12, 5) AS time, substr(a.end_time, 12, 5) AS ends, a.status, a.reason, a.patient_id, p.first_name || ' ' || p.last_name AS patient, pv.name AS provider
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
         WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time <= ? ORDER BY a.start_time`, pid, `${date} 00:00`, `${date} 23:59`,
      );
      return { date, appointments: rows };
    },
  },
  {
    name: 'open_times',
    description: 'Open appointment times on a day for each provider (or one provider).',
    permission: 'appointments:read', scope: 'appointments:read',
    input_schema: { type: 'object', properties: { date: DATE, provider_id: { type: 'integer' }, minutes: { type: 'integer', description: 'Length needed, default 60' } }, required: ['date'] },
    async run(db, pid, input) {
      const date = dateOr(input.date, null);
      if (!date) throw new HttpError(400, 'date must be YYYY-MM-DD');
      const providers = await db.all(`SELECT id, name FROM providers WHERE practice_id = ? AND active = 1${input.provider_id ? ' AND id = ?' : ''} ORDER BY id`, pid, ...(input.provider_id ? [Number(input.provider_id)] : []));
      const out = [];
      for (const p of providers) out.push({ provider_id: p.id, provider: p.name, times: (await openSlots(db, pid, p.id, date, { duration: Math.min(480, Math.max(10, Number(input.minutes) || 60)) })).slice(0, 30) });
      return { date, providers: out };
    },
  },
];

export const toolByName = (name) => DATA_TOOLS.find((t) => t.name === name);
