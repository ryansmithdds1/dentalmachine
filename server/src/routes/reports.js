import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { practiceNow, utcRange, mapSeq } from '../util.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function range(req, db) {
  const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const from = req.query.from || `${today.slice(0, 7)}-01`;
  const to = req.query.to || today;
  if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
  return { from, to, today };
}

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
    if (req.user.role === 'admin' || ['dentist', 'billing'].includes(req.user.role)) {
      Object.assign(out, {
        period: { from, to },
        production: (await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
        collections: -(await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
        adjustments: (await db.get("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'adjustment' AND entry_date BETWEEN ? AND ?", pid, from, to)).n,
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

  r.get('/reports/production', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await range(req, db);
    res.json({
      from, to,
      by_provider: await db.all(
        `SELECT pv.id, pv.name, COUNT(*) AS procedures, SUM(l.amount) AS production FROM ledger_entries l
         JOIN providers pv ON pv.id = l.provider_id WHERE l.practice_id = ? AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?
         GROUP BY pv.id ORDER BY production DESC`, pid, from, to,
      ),
      by_category: await db.all(
        `SELECT pr.category, COUNT(*) AS procedures, SUM(l.amount) AS production FROM ledger_entries l
         JOIN procedures pr ON pr.id = l.procedure_id WHERE l.practice_id = ? AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?
         GROUP BY pr.category ORDER BY production DESC`, pid, from, to,
      ),
      by_day: await db.all(
        `SELECT entry_date AS day,
           SUM(CASE WHEN type = 'charge' THEN amount ELSE 0 END) AS production,
           -SUM(CASE WHEN type IN ('payment','insurance_payment') THEN amount ELSE 0 END) AS collections
         FROM ledger_entries WHERE practice_id = ? AND entry_date BETWEEN ? AND ? GROUP BY entry_date ORDER BY entry_date`, pid, from, to,
      ),
      // From the same ledger charges as the rest of the report (voided work nets out).
      top_procedures: await db.all(
        `SELECT pr.code, MIN(pr.description) AS description, SUM(CASE WHEN l.amount > 0 THEN 1 ELSE -1 END) AS count, SUM(l.amount) AS production
         FROM ledger_entries l JOIN procedures pr ON pr.id = l.procedure_id
         WHERE l.practice_id = ? AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?
         GROUP BY pr.code HAVING SUM(l.amount) > 0 ORDER BY SUM(l.amount) DESC LIMIT 10`, pid, from, to,
      ),
    });
  });

  // Aging by patient: payments and credits pay off the oldest charges first, so what's still owed is the most
  // recent debits. Voided entries and their reversals cancel out. Accounts in credit are listed separately.
  r.get('/reports/aging', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { today } = await range(req, db);
    const patients = await db.all(
      `SELECT p.id, p.first_name, p.last_name, p.phone, SUM(l.amount) AS balance FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
       WHERE l.practice_id = ? GROUP BY p.id, p.first_name, p.last_name, p.phone HAVING SUM(l.amount) <> 0 ORDER BY SUM(l.amount) DESC`, pid,
    );
    const owing = patients.filter((p) => p.balance > 0);
    const buckets = ['current', 'd31_60', 'd61_90', 'd90_plus'];
    const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    // Every charge-type debit for those accounts in one query. Voided entries and reversals are left out:
    // they cancel each other in the balance, and the balance is what gets spread over the real charges.
    const debits = owing.length ? await db.all(
      `SELECT patient_id, amount, entry_date FROM ledger_entries WHERE practice_id = ? AND amount > 0 AND voided_at IS NULL AND reverses_id IS NULL
       AND patient_id IN (SELECT l.patient_id FROM ledger_entries l WHERE l.practice_id = ? GROUP BY l.patient_id HAVING SUM(l.amount) > 0)
       ORDER BY patient_id, entry_date DESC, id DESC`, pid, pid,
    ) : [];
    const byPatient = new Map();
    for (const d of debits) {
      if (!byPatient.has(d.patient_id)) byPatient.set(d.patient_id, []);
      byPatient.get(d.patient_id).push(d);
    }
    const rows = owing.map((p) => {
      const charges = byPatient.get(p.id) || [];
      const row = { ...p, ...Object.fromEntries(buckets.map((b) => [b, 0])) };
      let remaining = p.balance;
      for (const c of charges) {
        if (remaining <= 0) break;
        const part = Math.min(c.amount, remaining);
        remaining -= part;
        const age = Math.floor((todayMs - Date.parse(`${c.entry_date}T00:00:00Z`)) / 86400000);
        const bucket = age <= 30 ? 'current' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90_plus';
        row[bucket] += part;
      }
      // Anything not explained by a debit still on file (e.g. a voided payment) is the oldest money owed.
      if (remaining > 0) row.d90_plus += remaining;
      buckets.forEach((b) => (totals[b] += row[b]));
      return row;
    });
    const credits = patients.filter((p) => p.balance < 0).map((p) => ({ ...p, credit: -p.balance }));
    res.json({
      as_of: today, totals: { ...totals, total: rows.reduce((s, r) => s + r.balance, 0), credits: credits.reduce((s, c) => s + c.credit, 0) }, rows, credits,
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
       LEFT JOIN users u ON u.id = l.created_by WHERE l.practice_id = ? AND l.entry_date = ? ORDER BY l.type, l.id`, pid, date,
    );
    const sum = (fn) => entries.filter(fn).reduce((s, e) => s + e.amount, 0);
    const byMethod = {};
    // The deposit: money in, less money paid back out (refunds, and voided payments) by the same method.
    for (const e of entries.filter((x) => ['payment', 'insurance_payment', 'refund'].includes(x.type))) {
      const key = e.type === 'insurance_payment' ? `insurance_${e.method || 'check'}` : e.method || 'other';
      byMethod[key] = (byMethod[key] || 0) - e.amount;
    }
    const appts = await db.all(
      `SELECT status, COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? GROUP BY status`,
      pid, `${date} 00:00`, `${date} 24:00`,
    );
    res.json({
      date,
      totals: {
        production: sum((e) => e.type === 'charge'),
        patient_payments: -sum((e) => e.type === 'payment'),
        insurance_payments: -sum((e) => e.type === 'insurance_payment'),
        adjustments: sum((e) => e.type === 'adjustment'),
        refunds: sum((e) => e.type === 'refund'),
      },
      deposit: byMethod,
      appointments: Object.fromEntries(appts.map((a) => [a.status, a.n])),
      entries,
    });
  });

  return r;
}
