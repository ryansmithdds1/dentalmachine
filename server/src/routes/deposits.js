import { Router } from 'express';
import { restricted } from '../officeaccess.js';
import { requirePermission, HttpError } from '../auth.js';
import { insert, update, findOr404, audit, practiceNow } from '../util.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Payments waiting to go to the bank: money in that isn't voided and isn't on a deposit yet.
const UNDEPOSITED = `l.practice_id = ? AND l.type IN ('payment','insurance_payment') AND l.amount < 0 AND l.voided_at IS NULL
  AND l.reverses_id IS NULL AND l.deposit_id IS NULL`;

// Deposit slips (which checks and cash went to the bank together) and reconciling them with the bank statement.
export default function depositRoutes({ db }) {
  const r = Router();
  const entryCols = `l.id, l.patient_id, l.entry_date, l.type, -l.amount AS amount, l.method, l.reference, l.description, l.location_id, p.first_name, p.last_name`;
  // Someone limited to some offices works with their offices' payments only.
  const officeSql = (req) => (restricted(req.user) ? { sql: ` AND (l.location_id IS NULL OR l.location_id IN (${req.user.location_ids.map(() => '?').join(',')}))`, args: req.user.location_ids } : { sql: '', args: [] });

  r.get('/deposits/undeposited', requirePermission('billing:read'), async (req, res) => {
    const methods = String(req.query.methods || 'cash,check').split(',').filter(Boolean);
    res.json(await db.all(
      `SELECT ${entryCols} FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id
       WHERE ${UNDEPOSITED} AND COALESCE(l.method, 'check') IN (${methods.map(() => '?').join(',')})${req.location_id ? ' AND l.location_id = ?' : ''}${officeSql(req).sql}
       ORDER BY l.entry_date, l.id`, req.user.practice_id, ...methods, ...(req.location_id ? [req.location_id] : []), ...officeSql(req).args,
    ));
  });

  r.get('/deposits', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT d.*, u.name AS created_by_name, (SELECT COUNT(*) FROM real_ledger_entries l WHERE l.deposit_id = d.id) AS items
       FROM deposits d LEFT JOIN users u ON u.id = d.created_by WHERE d.practice_id = ? AND d.voided_at IS NULL ORDER BY d.deposit_date DESC, d.id DESC LIMIT 200`, req.user.practice_id,
    ));
  });

  r.get('/deposits/:did', requirePermission('billing:read'), async (req, res) => {
    const d = await findOr404(db, 'deposits', req.params.did, req.user.practice_id, 'Deposit');
    const entries = await db.all(`SELECT ${entryCols}, l.voided_at FROM real_ledger_entries l JOIN real_patients p ON p.id = l.patient_id WHERE l.deposit_id = ? ORDER BY l.method, l.id`, d.id);
    const byMethod = {};
    for (const e of entries) byMethod[e.method || 'check'] = (byMethod[e.method || 'check'] || 0) + e.amount;
    res.json({
      ...d, entries, by_method: byMethod,
      practice: await db.get('SELECT name, address, city, state, zip FROM practices WHERE id = ?', req.user.practice_id),
    });
  });

  r.post('/deposits', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const ids = [...new Set((req.body?.entry_ids || []).map(Number))];
    if (!ids.length) throw new HttpError(400, 'Choose the payments going to the bank');
    const date = req.body?.deposit_date || (await practiceNow(db, pid)).slice(0, 10);
    if (!DATE.test(date)) throw new HttpError(400, 'deposit_date must be YYYY-MM-DD');
    const id = await db.tx(async () => {
      const entries = await db.all(`SELECT l.id, l.amount FROM real_ledger_entries l WHERE ${UNDEPOSITED} AND l.id IN (${ids.map(() => '?').join(',')})${officeSql(req).sql}`, pid, ...ids, ...officeSql(req).args);
      if (entries.length !== ids.length) throw new HttpError(409, 'Some of those payments are already on a deposit or were voided — refresh and try again');
      const depositId = await insert(db, 'deposits', {
        practice_id: pid, location_id: req.location_id ?? null, deposit_date: date, total: -entries.reduce((s, e) => s + e.amount, 0),
        reference: String(req.body?.reference || '').trim().slice(0, 80) || null, notes: String(req.body?.notes || '').trim().slice(0, 500) || null, created_by: req.user.id,
      });
      await db.run(`UPDATE ledger_entries SET deposit_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, depositId, ...ids);
      return depositId;
    });
    await audit(db, req, 'deposit.create', 'deposits', id, { items: ids.length });
    res.status(201).json(await db.get('SELECT * FROM deposits WHERE id = ?', id));
  });

  // The bank statement shows the deposit: matching amounts reconcile it, anything else is flagged.
  r.post('/deposits/:did/reconcile', requirePermission('billing:write'), async (req, res) => {
    const d = await findOr404(db, 'deposits', req.params.did, req.user.practice_id, 'Deposit');
    const bank = Math.round(Number(req.body?.bank_amount));
    if (!Number.isFinite(bank) || bank < 0) throw new HttpError(400, 'bank_amount (cents) is required');
    const bankDate = req.body?.bank_date || null;
    if (bankDate && !DATE.test(bankDate)) throw new HttpError(400, 'bank_date must be YYYY-MM-DD');
    const status = bank === d.total ? 'reconciled' : 'discrepancy';
    await db.run("UPDATE deposits SET bank_amount = ?, bank_date = ?, status = ?, reconciled_by = ?, reconciled_at = datetime('now') WHERE id = ?", bank, bankDate, status, req.user.id, d.id);
    await audit(db, req, 'deposit.reconcile', 'deposits', d.id, { status, difference: bank - d.total });
    res.json(await db.get('SELECT * FROM deposits WHERE id = ?', d.id));
  });

  // Undo a deposit that hasn't been reconciled: its payments go back to the undeposited list.
  r.delete('/deposits/:did', requirePermission('billing:write'), async (req, res) => {
    const d = await findOr404(db, 'deposits', req.params.did, req.user.practice_id, 'Deposit');
    if (d.status === 'reconciled') throw new HttpError(409, 'A reconciled deposit can’t be undone');
    if (d.voided_at) throw new HttpError(409, 'This deposit was already undone');
    if (await db.get("SELECT id FROM deposit_slips WHERE deposit_id = ? AND stage <> 'reopened'", d.id)) throw new HttpError(409, 'This deposit is locked — a manager reopens it from Deposits and cash');
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) throw new HttpError(400, 'Say why the deposit is being undone');
    // The slip is kept (voided, with who and why); its payments go back to the not-deposited list.
    const entries = (await db.all('SELECT id FROM ledger_entries WHERE deposit_id = ?', d.id)).map((e) => e.id);
    await db.tx(async () => {
      await db.run('UPDATE ledger_entries SET deposit_id = NULL WHERE deposit_id = ?', d.id);
      await update(db, 'deposits', d.id, req.user.practice_id, { voided_at: new Date().toISOString().slice(0, 19).replace('T', ' '), voided_by: req.user.id, void_reason: reason });
    });
    await audit(db, req, 'deposit.void', 'deposits', d.id, { total: d.total, entries }, { reason });
    res.json({ ok: true });
  });
  return r;
}
