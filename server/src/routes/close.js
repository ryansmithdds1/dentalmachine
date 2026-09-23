import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, audit, practiceNow, utcRange } from '../util.js';

// End-of-day and month-end close: the period's totals, a checklist of loose ends, and closing the books
// (moving the lock date up to the end of the period so nothing more can be posted into it).
function period(type, value) {
  if (type === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(value || '')) return { start: value, end: value };
  if (type === 'month' && /^\d{4}-\d{2}$/.test(value || '')) {
    const [y, m] = value.split('-').map(Number);
    return { start: `${value}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  }
  throw new HttpError(400, 'Choose a day (YYYY-MM-DD) or a month (YYYY-MM)');
}

export default function closeRoutes({ db }) {
  const r = Router();

  async function summary(pid, type, value) {
    const { start, end } = period(type, value);
    const [f, t] = await utcRange(db, pid, start, end);
    const now = await practiceNow(db, pid);
    const sum = async (where) => (await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND entry_date BETWEEN ? AND ? AND ${where}`, pid, start, end)).n;
    const count = async (sql, ...args) => Number((await db.get(sql, ...args)).n);
    const totals = {
      production: await sum("type = 'charge'"),
      patient_payments: -(await sum("type = 'payment'")),
      insurance_payments: -(await sum("type = 'insurance_payment'")),
      adjustments: await sum("type = 'adjustment'"),
      refunds: await sum("type = 'refund'"),
    };
    totals.net_collections = totals.patient_payments + totals.insurance_payments - totals.refunds;
    const checks = [
      { key: 'visits', label: 'Visits still open (not completed, cancelled or no-show)', link: '/schedule',
        count: await count(`SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND start_time < ? AND status IN ('scheduled','confirmed','checked_in','in_chair')`, pid, `${start} 00:00`, `${end} 24:00`, now) },
      { key: 'notes', label: 'Clinical notes not signed', link: '/',
        count: await count('SELECT COUNT(*) AS n FROM clinical_notes WHERE practice_id = ? AND signed = 0 AND created_at >= ? AND created_at < ?', pid, f, t) },
      { key: 'unbilled', label: 'Completed work for insured patients not on a claim', link: '/claims',
        count: await count(
          `SELECT COUNT(*) AS n FROM procedures pr WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ?
             AND EXISTS (SELECT 1 FROM patient_insurance pi WHERE pi.patient_id = pr.patient_id AND pi.active = 1)
             AND NOT EXISTS (SELECT 1 FROM claim_items ci WHERE ci.procedure_id = pr.id)`, pid, f, t,
        ) },
      { key: 'draft_claims', label: 'Claims not sent', link: '/claims',
        count: await count("SELECT COUNT(*) AS n FROM claims WHERE practice_id = ? AND status = 'draft' AND created_at < ?", pid, t) },
      { key: 'undeposited', label: 'Cash and check payments not on a deposit', link: '/claims?tab=deposits',
        count: await count(
          `SELECT COUNT(*) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND amount < 0 AND voided_at IS NULL
             AND reverses_id IS NULL AND deposit_id IS NULL AND COALESCE(method, 'check') IN ('cash','check') AND entry_date BETWEEN ? AND ?`, pid, start, end,
        ) },
      { key: 'unreconciled', label: 'Deposits not reconciled with the bank', link: '/claims?tab=deposits',
        count: await count("SELECT COUNT(*) AS n FROM deposits WHERE practice_id = ? AND status != 'reconciled' AND deposit_date BETWEEN ? AND ?", pid, start, end) },
    ];
    const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', pid)).lock_date;
    return { type, period: value, start, end, totals, checks, lock_date: lock, closed: !!lock && lock >= end, today: now.slice(0, 10) };
  }

  r.get('/close', requirePermission('reports:read'), async (req, res) => {
    res.json({
      ...(await summary(req.user.practice_id, req.query.type || 'day', req.query.period)),
      history: await db.all(
        `SELECT c.id, c.period_type, c.period_start, c.period_end, c.totals, c.closed_at, u.name AS closed_by_name FROM period_closes c
         LEFT JOIN users u ON u.id = c.closed_by WHERE c.practice_id = ? ORDER BY c.id DESC LIMIT 24`, req.user.practice_id,
      ),
    });
  });

  // Close the books through the end of the period (administrators). Loose ends don't block it, but they're recorded.
  r.post('/close', requirePermission('reports:read'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can close the books');
    const pid = req.user.practice_id;
    const s = await summary(pid, req.body?.type, req.body?.period);
    if (s.end > s.today) throw new HttpError(400, "That period isn't over yet");
    if (s.closed) throw new HttpError(409, `The books are already closed through ${s.lock_date}`);
    const id = await insert(db, 'period_closes', {
      practice_id: pid, period_type: s.type, period_start: s.start, period_end: s.end,
      totals: JSON.stringify({ ...s.totals, open_items: Object.fromEntries(s.checks.map((c) => [c.key, c.count])) }), closed_by: req.user.id,
    });
    await db.run('UPDATE practices SET lock_date = ? WHERE id = ?', s.end, pid);
    await audit(db, req, 'books.close', 'period_closes', id, { through: s.end });
    res.status(201).json({ id, lock_date: s.end });
  });
  return r;
}
