import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, findOr404, audit, toCents, practiceNow } from '../util.js';
import { patientBalance } from '../services.js';

export const PAYMENT_METHODS = ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'other'];

export default function billingRoutes({ db }) {
  const r = Router();
  const patientOr404 = (req) => findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');

  r.get('/patients/:id/ledger', requirePermission('billing:read'), (req, res) => {
    const patient = patientOr404(req);
    const entries = db.all(
      `SELECT l.*, u.name AS created_by_name FROM ledger_entries l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.patient_id = ? AND l.practice_id = ? ORDER BY l.entry_date, l.id`,
      patient.id, req.user.practice_id,
    );
    let running = 0;
    for (const e of entries) e.running_balance = running += e.amount;
    const pendingInsurance = db.get(
      "SELECT COALESCE(SUM(estimated_amount), 0) AS n FROM claims WHERE patient_id = ? AND practice_id = ? AND status = 'submitted'",
      patient.id, req.user.practice_id,
    ).n;
    res.json({ entries, balance: running, pending_insurance: pendingInsurance, patient_portion: running - pendingInsurance });
  });

  // Patient payment. Amount is positive cents; stored as a credit (negative).
  r.post('/patients/:id/payments', requirePermission('billing:write'), (req, res) => {
    const patient = patientOr404(req);
    const row = pick(req.body, ['amount', 'method', 'reference', 'entry_date', 'description']);
    requireFields(row, ['amount', 'method']);
    requireOneOf(row.method, PAYMENT_METHODS, 'method');
    const amount = toCents(row.amount);
    if (amount <= 0) throw new HttpError(400, 'Payment amount must be positive');
    const id = insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'payment', amount: -amount,
      description: row.description || `Patient payment (${row.method.replace('_', ' ')})`, method: row.method,
      reference: row.reference ?? null, entry_date: row.entry_date || practiceNow(db, req.user.practice_id).slice(0, 10), created_by: req.user.id,
    });
    audit(db, req, 'ledger.payment', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Adjustment: negative = credit (discount/write-off), positive = debit (e.g. NSF fee).
  r.post('/patients/:id/adjustments', requirePermission('billing:write'), (req, res) => {
    const patient = patientOr404(req);
    const row = pick(req.body, ['amount', 'description', 'entry_date']);
    requireFields(row, ['amount', 'description']);
    const amount = toCents(row.amount);
    if (amount === 0) throw new HttpError(400, 'Adjustment amount cannot be zero');
    const id = insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'adjustment', amount,
      description: row.description, entry_date: row.entry_date || practiceNow(db, req.user.practice_id).slice(0, 10), created_by: req.user.id,
    });
    audit(db, req, 'ledger.adjustment', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: patientBalance(db, req.user.practice_id, patient.id) });
  });

  r.post('/patients/:id/refunds', requirePermission('billing:write'), (req, res) => {
    const patient = patientOr404(req);
    const row = pick(req.body, ['amount', 'method', 'reference', 'description']);
    requireFields(row, ['amount', 'method']);
    requireOneOf(row.method, PAYMENT_METHODS, 'method');
    const amount = toCents(row.amount);
    if (amount <= 0) throw new HttpError(400, 'Refund amount must be positive');
    const id = insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'refund', amount,
      description: row.description || 'Refund to patient', method: row.method, reference: row.reference ?? null,
      entry_date: practiceNow(db, req.user.practice_id).slice(0, 10), created_by: req.user.id,
    });
    audit(db, req, 'ledger.refund', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Printable statement data.
  r.get('/patients/:id/statement', requirePermission('billing:read'), (req, res) => {
    const patient = patientOr404(req);
    const practice = db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const since = req.query.since || '0000-00-00';
    const prior = db.get('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id = ? AND practice_id = ? AND entry_date < ?', patient.id, req.user.practice_id, since).n;
    const entries = db.all('SELECT * FROM ledger_entries WHERE patient_id = ? AND practice_id = ? AND entry_date >= ? ORDER BY entry_date, id', patient.id, req.user.practice_id, since);
    audit(db, req, 'statement.generate', 'patients', patient.id);
    res.json({
      practice, patient, since, previous_balance: prior, entries,
      balance: patientBalance(db, req.user.practice_id, patient.id), generated_at: new Date().toISOString(),
    });
  });

  return r;
}
