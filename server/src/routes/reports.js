import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { practiceNow, utcRange, mapSeq, paged } from '../util.js';
import { allocationsForRange } from '../allocation.js';
import { agingReport } from '../aging.js';
import { restricted } from '../officeaccess.js';
import { isRetail, retailTotals } from '../ledgerkinds.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function range(req, db) {
  const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const from = req.query.from || `${today.slice(0, 7)}-01`;
  const to = req.query.to || today;
  if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
  return { from, to, today };
}

// Report filters on ledger rows: ?location_id= (one office of a multi-location practice) and ?provider_id=.
// Someone limited to some offices only ever sees theirs.
const atLocation = (req, alias = '') => {
  const where = [];
  const args = [];
  for (const k of ['location_id', 'provider_id']) {
    const id = Number(req.query[k]) || null;
    if (k === 'location_id' && restricted(req.user)) {
      if (id && !req.user.location_ids.includes(id)) throw new HttpError(403, "That office isn't one of yours");
      const ids = id ? [id] : req.user.location_ids;
      where.push(` AND ${alias}location_id IN (${ids.map(() => '?').join(',')})`);
      args.push(...ids);
    } else if (id) { where.push(` AND ${alias}${k} = ?`); args.push(id); }
  }
  return { sql: where.join(''), args };
};

export default function reportRoutes({ db }) {
  const r = Router();

  // Front-desk dashboard: available to anyone who can see the schedule.
  r.get('/dashboard', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to, today } = await range(req, db);
    const appts = await db.all(
      `SELECT a.status, COUNT(*) AS n FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? GROUP BY a.status`,
      pid, `${today} 00:00`, `${today} 24:00`,
    );
    const byStatus = Object.fromEntries(appts.map((a) => [a.status, a.n]));
    const out = {
      today,
      appointments_today: appts.filter((a) => !['cancelled', 'no_show'].includes(a.status)).reduce((s, a) => s + a.n, 0),
      appointments_by_status: byStatus,
      recalls_due: (await db.get(
        `SELECT COUNT(*) AS n FROM recalls r JOIN patients p ON p.id = r.patient_id
         WHERE r.practice_id = ? AND r.due_date <= ? AND r.status IN ('due','contacted') AND p.status = 'active'`, pid, today,
      )).n,
      active_patients: (await db.get("SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND status = 'active'", pid)).n,
    };
    // Practice-wide money: for people who may see reports (a permission, not a job title), across every office.
    if (can(req.user, 'reports:read') && !restricted(req.user)) {
      Object.assign(out, {
        period: { from, to },
        production: (await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND retail_sale_id IS NULL AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
        collections: -(await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
        adjustments: (await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'adjustment' AND retail_sale_id IS NULL AND gift_certificate_id IS NULL AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
        accounts_receivable: (await db.get('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ?', pid)).n,
        outstanding_claims: await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(estimated_amount),0) AS amount FROM claims WHERE practice_id = ? AND status = 'submitted'", pid),
        new_patients: (await db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND created_at >= ? AND created_at < ?', pid, ...(await utcRange(db, pid, from, to)))).n,
        unscheduled_treatment: await db.get(
          `SELECT COUNT(*) AS n, COALESCE(SUM(pr.fee),0) AS amount FROM procedures pr JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id
           WHERE pr.practice_id = ? AND pr.status = 'planned' AND pr.appointment_id IS NULL AND tp.status IN ('proposed','accepted')`, pid,
        ),
      });
    }
    res.json(out);
  });

  // A clinician's own numbers (for people allowed to see only their own production): today, this
  // month and this year, by the provider records linked to their login.
  r.get('/reports/my-production', async (req, res) => {
    if (!can(req.user, 'reports:own') && !can(req.user, 'reports:read')) throw new HttpError(403, 'Missing permission: reports:own');
    const pid = req.user.practice_id;
    const providers = await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND user_id = ?', pid, req.user.id);
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const sum = async (from) => (providers.length ? (await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND retail_sale_id IS NULL AND voided_at IS NULL AND reverses_id IS NULL
         AND provider_id IN (${providers.map(() => '?').join(',')}) AND entry_date BETWEEN ? AND ?`, pid, ...providers.map((p) => p.id), from, today,
    )).n : 0);
    res.json({ providers, today: await sum(today), month: await sum(`${today.slice(0, 7)}-01`), year: await sum(`${today.slice(0, 4)}-01-01`) });
  });

  // Hygiene department: production, reappointment, perio vs prophy, and whether recalls get seen.
  const PERIO = ['D4341', 'D4342', 'D4346', 'D4355', 'D4910'];
  const PROPHY = ['D1110', 'D1120'];
  r.get('/reports/hygiene', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    const [f, t] = await utcRange(db, pid, from, to);
    const prov = Number(req.query.provider_id) || null;
    const only = (col) => (prov ? ` AND ${col} = ${prov}` : '');
    const hygienists = await db.all(`SELECT id, name FROM providers WHERE practice_id = ? AND type = 'hygienist'${only('id')} ORDER BY name`, pid);
    const byHyg = await db.all(
      `SELECT pr.provider_id, COALESCE(SUM(pr.fee), 0) AS production, COUNT(*) AS procedures
       FROM procedures pr JOIN providers pv ON pv.id = pr.provider_id
       WHERE pr.practice_id = ? AND pv.type = 'hygienist' AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ?${only('pr.provider_id')}
       GROUP BY pr.provider_id`, pid, f, t,
    );
    const visits = await db.all(
      `SELECT a.provider_id, COUNT(*) AS visits, SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.start_time > a.start_time
           AND b.status NOT IN ('cancelled','no_show') AND substr(b.created_at, 1, 10) <= substr(a.start_time, 1, 10)) THEN 1 ELSE 0 END) AS reappointed
       FROM appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?
       GROUP BY a.provider_id`, pid, `${from} 00:00`, `${to} 24:00`,
    );
    const codes = await db.all(
      `SELECT code, COUNT(*) AS n FROM procedures WHERE practice_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
         AND code IN (${[...PERIO, ...PROPHY].map(() => '?').join(',')})${only('provider_id')} GROUP BY code`, pid, f, t, ...PERIO, ...PROPHY,
    );
    const perio = codes.filter((c) => PERIO.includes(c.code)).reduce((s, c) => s + c.n, 0);
    const prophy = codes.filter((c) => PROPHY.includes(c.code)).reduce((s, c) => s + c.n, 0);
    // Patients whose recall came due in the period: seen (a completed visit from 2 months before the due date),
    // booked (a visit still to come), or still waiting.
    const recall = await db.get(
      `SELECT COUNT(*) AS due,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = r.patient_id AND a.status = 'completed' AND a.start_time >= ${db.dialect === 'postgres' ? "to_char(r.due_date::date - 60, 'YYYY-MM-DD')" : "date(r.due_date, '-60 days')"}) THEN 1 ELSE 0 END) AS seen,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = r.patient_id AND a.status IN ('scheduled','confirmed') AND a.start_time >= ?) THEN 1 ELSE 0 END) AS booked
       FROM (SELECT x.patient_id, MIN(x.due_date) AS due_date FROM recalls x JOIN patients p ON p.id = x.patient_id
             WHERE x.practice_id = ? AND x.status != 'inactive' AND p.status = 'active' AND x.due_date BETWEEN ? AND ? GROUP BY x.patient_id) r`,
      `${(await practiceNow(db, pid)).slice(0, 10)} 00:00`, pid, from, to,
    );
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const rows = hygienists.map((h) => {
      const p = byHyg.find((x) => x.provider_id === h.id) || {};
      const v = visits.find((x) => x.provider_id === h.id) || {};
      return { provider_id: h.id, name: h.name, production: p.production || 0, visits: v.visits || 0, reappointed: v.reappointed || 0, reappointment_rate: pct(v.reappointed || 0, v.visits || 0), per_visit: v.visits ? Math.round((p.production || 0) / v.visits) : null };
    });
    const total = rows.reduce((s, x) => ({ production: s.production + x.production, visits: s.visits + x.visits, reappointed: s.reappointed + x.reappointed }), { production: 0, visits: 0, reappointed: 0 });
    res.json({
      from, to, hygienists: rows, total: { ...total, reappointment_rate: pct(total.reappointed, total.visits) },
      perio: { perio, prophy, perio_pct: pct(perio, perio + prophy), codes },
      recall: { due: recall.due || 0, seen: recall.seen || 0, booked: recall.booked || 0, seen_pct: pct(recall.seen || 0, recall.due || 0) },
    });
  });

  // Treatment plans: presented → accepted → scheduled → completed, by provider (dollars of the plans' procedures).
  r.get('/reports/treatment-plans', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    const [f, t] = await utcRange(db, pid, from, to);
    const rows = await db.all(
      `SELECT pr.provider_id, pv.name AS provider_name, COUNT(DISTINCT tp.id) AS plans,
         COALESCE(SUM(pr.fee), 0) AS presented,
         COALESCE(SUM(CASE WHEN tp.status IN ('accepted','completed') OR tp.signed_at IS NOT NULL OR pr.status = 'completed' OR pr.appointment_id IS NOT NULL THEN pr.fee ELSE 0 END), 0) AS accepted,
         COALESCE(SUM(CASE WHEN pr.status = 'planned' AND pr.appointment_id IS NOT NULL THEN pr.fee ELSE 0 END), 0) AS scheduled,
         COALESCE(SUM(CASE WHEN pr.status = 'completed' THEN pr.fee ELSE 0 END), 0) AS completed,
         COUNT(DISTINCT CASE WHEN tp.status IN ('accepted','completed') OR tp.signed_at IS NOT NULL THEN tp.id END) AS accepted_plans
       FROM treatment_plans tp JOIN procedures pr ON pr.treatment_plan_id = tp.id LEFT JOIN providers pv ON pv.id = pr.provider_id
       WHERE tp.practice_id = ? AND COALESCE(tp.presented_at, tp.created_at) >= ? AND COALESCE(tp.presented_at, tp.created_at) < ? AND pr.status != 'cancelled'${Number(req.query.provider_id) ? ` AND pr.provider_id = ${Number(req.query.provider_id)}` : ''}
       GROUP BY pr.provider_id, pv.name ORDER BY SUM(pr.fee) DESC`, pid, f, t,
    );
    const out = rows.map((x) => ({ ...x, provider_name: x.provider_name || 'No provider', unscheduled: Math.max(0, x.accepted - x.scheduled - x.completed), acceptance_pct: x.presented ? Math.round((x.accepted / x.presented) * 1000) / 10 : null }));
    const sum = (k) => out.reduce((s, x) => s + Number(x[k] || 0), 0);
    const total = { plans: sum('plans'), presented: sum('presented'), accepted: sum('accepted'), scheduled: sum('scheduled'), completed: sum('completed'), unscheduled: sum('unscheduled') };
    total.acceptance_pct = total.presented ? Math.round((total.accepted / total.presented) * 1000) / 10 : null;
    res.json({ from, to, providers: out, total });
  });

  r.get('/reports/production', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    const loc = atLocation(req, 'l.');
    const multi = (await db.get('SELECT COUNT(*) AS n FROM locations WHERE practice_id = ?', pid)).n > 0;
    res.json({
      from, to,
      by_provider: await db.all(
        `SELECT pv.id, pv.name, COUNT(*) AS procedures, SUM(l.amount) AS production FROM ledger_entries l
         JOIN providers pv ON pv.id = l.provider_id WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${loc.sql}
         GROUP BY pv.id ORDER BY production DESC`, pid, from, to, ...loc.args,
      ),
      by_category: await db.all(
        `SELECT pr.category, COUNT(*) AS procedures, SUM(l.amount) AS production FROM ledger_entries l
         JOIN procedures pr ON pr.id = l.procedure_id WHERE l.practice_id = ? AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?${loc.sql}
         GROUP BY pr.category ORDER BY production DESC`, pid, from, to, ...loc.args,
      ),
      by_day: await db.all(
        `SELECT entry_date AS day,
           SUM(CASE WHEN type = 'charge' AND retail_sale_id IS NULL THEN amount ELSE 0 END) AS production,
           -SUM(CASE WHEN type IN ('payment','insurance_payment') THEN amount ELSE 0 END) AS collections
         FROM ledger_entries l WHERE practice_id = ? AND entry_date BETWEEN ? AND ?${loc.sql} GROUP BY entry_date ORDER BY entry_date`, pid, from, to, ...loc.args,
      ),
      // From the same ledger charges as the rest of the report (voided work nets out).
      top_procedures: await db.all(
        `SELECT pr.code, MIN(pr.description) AS description, SUM(CASE WHEN l.amount > 0 THEN 1 ELSE -1 END) AS count, SUM(l.amount) AS production
         FROM ledger_entries l JOIN procedures pr ON pr.id = l.procedure_id
         WHERE l.practice_id = ? AND l.type = 'charge' AND l.retail_sale_id IS NULL AND l.entry_date BETWEEN ? AND ?${loc.sql}
         GROUP BY pr.code HAVING SUM(l.amount) > 0 ORDER BY SUM(l.amount) DESC LIMIT 10`, pid, from, to, ...loc.args,
      ),
      // Consolidated view across offices (insurance payments aren't tied to an office).
      by_location: multi && !restricted(req.user) ? await db.all(
        `SELECT l.location_id AS id, COALESCE(lo.name, 'No office') AS name,
           SUM(CASE WHEN l.type = 'charge' AND l.retail_sale_id IS NULL THEN l.amount ELSE 0 END) AS production,
           -SUM(CASE WHEN l.type = 'payment' THEN l.amount ELSE 0 END) AS patient_collections,
           SUM(CASE WHEN l.type = 'adjustment' AND l.retail_sale_id IS NULL AND l.gift_certificate_id IS NULL THEN l.amount ELSE 0 END) AS adjustments
         FROM ledger_entries l LEFT JOIN locations lo ON lo.id = l.location_id
         WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ? GROUP BY l.location_id, lo.name ORDER BY 3 DESC`, pid, from, to,
      ) : null,
    });
  });

  // Aging by patient or family (see aging.js).
  r.get('/reports/aging', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { today: now } = await range(req, db);
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || '') && req.query.as_of <= now ? req.query.as_of : now;
    const family = req.query.group === 'family';
    const report = await agingReport(db, pid, today, { family });
    res.json({ ...report, rows: paged(req, res, report.rows, { dflt: 500, max: 100_000 }), total_rows: report.rows.length });
  });

  // Production and collections per provider: payments are credited to the provider whose work they paid
  // for (insurance by the procedures on the claim, patient payments oldest charge first).
  r.get('/reports/collections-by-provider', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? ORDER BY name', pid);
    const rows = new Map(providers.map((p) => [p.id, { ...p, production: 0, adjustments: 0, patient_collections: 0, insurance_collections: 0 }]));
    const unassigned = { id: null, name: 'Unapplied credit', production: 0, adjustments: 0, patient_collections: 0, insurance_collections: 0 };
    for (const r of await db.all(
      `SELECT provider_id, SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND retail_sale_id IS NULL AND entry_date BETWEEN ? AND ?${atLocation(req).sql} GROUP BY provider_id`, pid, from, to, ...atLocation(req).args,
    )) (rows.get(r.provider_id) || unassigned).production += r.n;
    for (const a of await allocationsForRange(db, pid, from, to)) {
      const row = (a.provider_id && rows.get(a.provider_id)) || unassigned;
      if (a.credit_type === 'payment') row.patient_collections += a.amount;
      else if (a.credit_type === 'insurance_payment') row.insurance_collections += a.amount;
      else if (a.credit_type === 'adjustment') row.adjustments += a.amount;
    }
    const list = [...rows.values(), unassigned].filter((r) => r.production || r.adjustments || r.patient_collections || r.insurance_collections)
      .map((r) => ({ ...r, collections: r.patient_collections + r.insurance_collections, net_production: r.production - r.adjustments }));
    res.json({ from, to, rows: list });
  });

  // Adjustments by type (write-offs, discounts, fees), for loss control.
  r.get('/reports/adjustments', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    res.json({
      from, to,
      rows: await db.all(
        `SELECT COALESCE(adjustment_type, CASE WHEN claim_id IS NOT NULL THEN 'Insurance write-off' ELSE 'Other' END) AS type,
           COUNT(*) AS count, SUM(amount) AS amount FROM ledger_entries
         WHERE practice_id = ? AND type = 'adjustment' AND retail_sale_id IS NULL AND gift_certificate_id IS NULL AND entry_date BETWEEN ? AND ?${atLocation(req).sql} GROUP BY 1 ORDER BY SUM(amount)`, pid, from, to, ...atLocation(req).args,
      ),
    });
  });

  // End-of-day "day sheet": what was produced, collected (by payment method, for the deposit) and how the schedule went.
  r.get('/reports/daysheet', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = req.query.date || (await practiceNow(db, pid)).slice(0, 10);
    if (!DATE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const entries = await db.all(
      `SELECT l.*, p.first_name, p.last_name, pv.name AS provider_name, u.name AS created_by_name
       FROM ledger_entries l JOIN patients p ON p.id = l.patient_id LEFT JOIN providers pv ON pv.id = l.provider_id
       LEFT JOIN users u ON u.id = l.created_by WHERE l.practice_id = ? AND l.entry_date = ?${atLocation(req, 'l.').sql} ORDER BY l.type, l.id`, pid, date, ...atLocation(req, 'l.').args,
    );
    const sum = (fn) => entries.filter(fn).reduce((s, e) => s + e.amount, 0);
    const byMethod = {};
    // The deposit: money in, less money paid back out (refunds, and voided payments) by the same method.
    for (const e of entries.filter((x) => ['payment', 'insurance_payment', 'refund'].includes(x.type))) {
      const key = e.type === 'insurance_payment' ? `insurance_${e.method || 'check'}` : e.method || 'other';
      byMethod[key] = (byMethod[key] || 0) - e.amount;
    }
    const appts = await db.all(
      `SELECT status, COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ?${atLocation(req).sql} GROUP BY status`,
      pid, `${date} 00:00`, `${date} 24:00`, ...atLocation(req).args,
    );
    res.json({
      date,
      totals: {
        // Dental production and adjustments leave out product sales and gift certificates (ledgerkinds.js); those
        // have their own lines, and the payments for them are in the payments and the deposit as usual.
        production: sum((e) => e.type === 'charge' && !isRetail(e)),
        patient_payments: -sum((e) => e.type === 'payment'),
        insurance_payments: -sum((e) => e.type === 'insurance_payment'),
        adjustments: sum((e) => e.type === 'adjustment' && !isRetail(e)),
        refunds: sum((e) => e.type === 'refund'),
        ...retailTotals(entries),
      },
      deposit: byMethod,
      appointments: Object.fromEntries(appts.map((a) => [a.status, a.n])),
      entries,
    });
  });

  return r;
}
