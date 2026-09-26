import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, audit, practiceNow, utcRange, recorded } from '../util.js';
import { runReport } from '../reportlibrary.js';
import { lastMonthOf } from '../monthlywork.js';
import { SOLD, REDEEMED } from '../ledgerkinds.js';

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
    const sum = async (where) => (await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM real_ledger_entries ledger_entries WHERE practice_id = ? AND entry_date BETWEEN ? AND ? AND ${where}`, pid, start, end)).n;
    const count = async (sql, ...args) => Number((await db.get(sql, ...args)).n);
    const totals = {
      production: await sum("type = 'charge' AND retail_sale_id IS NULL"),
      patient_payments: -(await sum("type = 'payment'")),
      insurance_payments: -(await sum("type = 'insurance_payment'")),
      adjustments: await sum("type = 'adjustment' AND retail_sale_id IS NULL AND gift_certificate_id IS NULL"),
      refunds: await sum("type = 'refund'"),
      // Not dentistry, shown on their own lines (ledgerkinds.js).
      retail_sales: await sum('retail_sale_id IS NOT NULL'),
      gift_certificates_sold: await sum(`gift_certificate_id IS NOT NULL AND adjustment_type = '${SOLD}'`),
      gift_certificates_used: -(await sum(`gift_certificate_id IS NOT NULL AND adjustment_type = '${REDEEMED}'`)),
    };
    totals.net_collections = totals.patient_payments + totals.insurance_payments - totals.refunds;
    const checks = [
      { key: 'visits', label: 'Visits still open (not completed, cancelled or no-show)', link: '/schedule',
        count: await count(`SELECT COUNT(*) AS n FROM real_appointments appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND start_time < ? AND status IN ('scheduled','confirmed','checked_in','in_chair')`, pid, `${start} 00:00`, `${end} 24:00`, now) },
      { key: 'notes', label: 'Clinical notes not signed', link: '/',
        count: await count('SELECT COUNT(*) AS n FROM real_clinical_notes clinical_notes WHERE practice_id = ? AND signed = 0 AND created_at >= ? AND created_at < ?', pid, f, t) },
      { key: 'unbilled', label: 'Completed work for insured patients not on a claim', link: '/claims',
        count: await count(
          `SELECT COUNT(*) AS n FROM real_procedures pr WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ?
             AND EXISTS (SELECT 1 FROM real_patient_insurance pi WHERE pi.patient_id = pr.patient_id AND pi.active = 1)
             AND NOT EXISTS (SELECT 1 FROM claim_items ci WHERE ci.procedure_id = pr.id)`, pid, f, t,
        ) },
      { key: 'draft_claims', label: 'Claims not sent', link: '/claims',
        count: await count("SELECT COUNT(*) AS n FROM real_claims claims WHERE practice_id = ? AND status = 'draft' AND created_at < ?", pid, t) },
      { key: 'undeposited', label: 'Cash and check payments not on a deposit', link: '/claims?tab=deposits',
        count: await count(
          `SELECT COUNT(*) AS n FROM real_ledger_entries ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND amount < 0 AND voided_at IS NULL
             AND reverses_id IS NULL AND deposit_id IS NULL AND COALESCE(method, 'check') IN ('cash','check') AND entry_date BETWEEN ? AND ?`, pid, start, end,
        ) },
      { key: 'unreconciled', label: 'Deposits not reconciled with the bank', link: '/claims?tab=deposits',
        count: await count("SELECT COUNT(*) AS n FROM deposits WHERE practice_id = ? AND voided_at IS NULL AND status != 'reconciled' AND deposit_date BETWEEN ? AND ?", pid, start, end) },
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
      // The lock date before this close, so an Undo can put it back exactly.
      totals: JSON.stringify({ ...s.totals, open_items: Object.fromEntries(s.checks.map((c) => [c.key, c.count])), previous_lock_date: s.lock_date || null }), closed_by: req.user.id,
    });
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET lock_date = ? WHERE id = ?', s.end, pid));
    await audit(db, req, 'books.close', 'period_closes', id, { through: s.end }, { before: { lock_date: s.lock_date || null }, after: { lock_date: s.end } });
    res.status(201).json({ id, lock_date: s.end, previous_lock_date: s.lock_date || null });
  });

  // Undo a close (the toast's Undo, or an administrator who closed the wrong month): only the latest close, and
  // only while nothing has moved the lock date since. The lock date goes back to what it was; the close stays
  // in the history marked as reopened, with who and why.
  r.post('/close/:id/reopen', requirePermission('reports:read'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can reopen the books');
    const pid = req.user.practice_id;
    const row = await db.get('SELECT * FROM period_closes WHERE id = ? AND practice_id = ?', Number(req.params.id) || 0, pid);
    if (!row) throw new HttpError(404, 'Close not found');
    const t = JSON.parse(row.totals || '{}');
    if (t.reopened_at) throw new HttpError(409, 'That close was already reopened');
    const latest = await db.get('SELECT id FROM period_closes WHERE practice_id = ? ORDER BY id DESC LIMIT 1', pid);
    const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', pid)).lock_date;
    if (latest.id !== row.id || lock !== row.period_end) throw new HttpError(409, 'Only the latest close can be reopened here — move the lock date in Settings → Practice');
    const reason = String(req.body?.reason || 'Undo').trim().slice(0, 300);
    const back = t.previous_lock_date ?? null;
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET lock_date = ? WHERE id = ?', back, pid));
    await recorded(db, 'period_closes', row.id, () => db.run('UPDATE period_closes SET totals = ? WHERE id = ?', JSON.stringify({ ...t, reopened_at: new Date().toISOString(), reopened_by: req.user.id, reopen_reason: reason }), row.id));
    await audit(db, req, 'books.reopen', 'period_closes', row.id, { through: row.period_end, reason }, { before: { lock_date: lock }, after: { lock_date: back }, reason });
    res.json({ lock_date: back });
  });

  // The month-end packet (workflow 54): everything the owner and the accountant look at for a month, on one
  // screen and one print — the month-end summary, production & income by provider, collections by payment type,
  // adjustments by type, insurance aging by carrier, patient A/R aging totals, credit balances, and the loose
  // ends. Read-only; built from the report library so every number matches the reports.
  r.get('/close/packet', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    // Last month unless one is asked for: that's the month being closed.
    const s = await summary(pid, 'month', req.query.month || lastMonthOf((await practiceNow(db, pid)).slice(0, 10)).month);
    const month = s.period;
    const asOf = s.end < s.today ? s.end : s.today;
    const run = (id, q) => runReport(db, req.user, id, q).catch((err) => ({ error: err.message, rows: [], totals: null }));
    const [summaryReport, production, byType, adjustments, carriers, aging, credits] = await Promise.all([
      run('month-end', { month }),
      run('production-income', { from: s.start, to: s.end }),
      run('collections-by-payment-type', { from: s.start, to: s.end }),
      run('adjustments-by-type', { from: s.start, to: s.end }),
      run('aging-by-carrier', {}),
      run('aging-by-family', { as_of: asOf }),
      run('credit-balances', {}),
    ]);
    const slim = (r0) => ({ name: r0.report?.name, columns: r0.report?.columns, rows: r0.rows, totals: r0.totals, note: r0.note, error: r0.error });
    await audit(db, req, 'books.packet', 'practices', pid, { month });
    res.json({
      month, start: s.start, end: s.end, closed: s.closed, lock_date: s.lock_date, totals: s.totals, checks: s.checks,
      sections: {
        summary: slim(summaryReport), production: slim(production), payment_types: slim(byType), adjustments: slim(adjustments), insurance_aging: slim(carriers),
        // Patient A/R and credits as totals only: the packet goes to the accountant, the names stay in the reports.
        patient_aging: { name: 'Patient A/R aging', as_of: asOf, columns: (aging.report?.columns || []).filter((c) => c.type === 'money'), totals: aging.totals, accounts: aging.rows.length, error: aging.error },
        credit_balances: { name: 'Credit balances', accounts: credits.rows.length, total: credits.rows.reduce((t, x) => t + Number(x.credit || 0), 0), error: credits.error },
      },
    });
  });
  return r;
}
