import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, findOr404, audit, toCents, practiceNow } from '../util.js';
import { patientBalance } from '../services.js';
import { planStatus } from './family.js';

export const PAYMENT_METHODS = ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'other'];

export default function billingRoutes({ db }) {
  const r = Router();
  const patientOr404 = async req => await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');

  r.get('/patients/:id/ledger', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const entries = await db.all(
      `SELECT l.*, u.name AS created_by_name FROM ledger_entries l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.patient_id = ? AND l.practice_id = ? ORDER BY l.entry_date, l.id`,
      patient.id, req.user.practice_id,
    );
    let running = 0;
    for (const e of entries) e.running_balance = running += e.amount;
    const pendingInsurance = (await db.get(
      "SELECT COALESCE(SUM(estimated_amount), 0) AS n FROM claims WHERE patient_id = ? AND practice_id = ? AND status = 'submitted'",
      patient.id, req.user.practice_id,
    )).n;
    res.json({ entries, balance: running, pending_insurance: pendingInsurance, patient_portion: running - pendingInsurance });
  });

  // Patient payment. Amount is positive cents; stored as a credit (negative).
  r.post('/patients/:id/payments', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['amount', 'method', 'reference', 'entry_date', 'description', 'payment_plan_id']);
    requireFields(row, ['amount', 'method']);
    requireOneOf(row.method, PAYMENT_METHODS, 'method');
    const amount = toCents(row.amount);
    if (amount <= 0) throw new HttpError(400, 'Payment amount must be positive');
    const plan = row.payment_plan_id ? await findOr404(db, 'payment_plans', row.payment_plan_id, req.user.practice_id, 'Payment plan') : null;
    if (plan) {
      const family = await db.get('SELECT 1 AS ok FROM patients WHERE id = ? AND (id = ? OR guarantor_id = ?)', patient.id, plan.patient_id, plan.patient_id);
      if (!family) throw new HttpError(400, 'That payment plan belongs to another family');
    }
    const id = await insert(db, 'ledger_entries', {
      payment_plan_id: plan?.id ?? null,
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'payment', amount: -amount,
      description: row.description || `Patient payment (${row.method.replace('_', ' ')})`, method: row.method,
      reference: row.reference ?? null, entry_date: row.entry_date || (await practiceNow(db, req.user.practice_id)).slice(0, 10), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.payment', 'ledger_entries', id, { amount });
    if (plan && (await planStatus(db, plan, '9999-12-31')).remaining === 0) await db.run("UPDATE payment_plans SET status = 'completed' WHERE id = ?", plan.id);
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Adjustment: negative = credit (discount/write-off), positive = debit (e.g. NSF fee).
  r.post('/patients/:id/adjustments', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['amount', 'description', 'entry_date']);
    requireFields(row, ['amount', 'description']);
    const amount = toCents(row.amount);
    if (amount === 0) throw new HttpError(400, 'Adjustment amount cannot be zero');
    const id = await insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'adjustment', amount,
      description: row.description, entry_date: row.entry_date || (await practiceNow(db, req.user.practice_id)).slice(0, 10), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.adjustment', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  r.post('/patients/:id/refunds', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['amount', 'method', 'reference', 'description']);
    requireFields(row, ['amount', 'method']);
    requireOneOf(row.method, PAYMENT_METHODS, 'method');
    const amount = toCents(row.amount);
    if (amount <= 0) throw new HttpError(400, 'Refund amount must be positive');
    const id = await insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, patient_id: patient.id, type: 'refund', amount,
      description: row.description || 'Refund to patient', method: row.method, reference: row.reference ?? null,
      entry_date: (await practiceNow(db, req.user.practice_id)).slice(0, 10), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.refund', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Printable statement data.
  r.get('/patients/:id/statement', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const since = req.query.since || '0000-00-00';
    // Family statements go to the guarantor and include every member of the household.
    const family = req.query.family === 'true' || req.query.family === '1';
    const addressee = family && patient.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', patient.guarantor_id) : patient;
    const ids = family
      ? (await db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', req.user.practice_id, addressee.id, addressee.id)).map((x) => x.id)
      : [patient.id];
    const inList = ids.map(() => '?').join(',');
    const prior = (await db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${inList}) AND entry_date < ?`, req.user.practice_id, ...ids, since)).n;
    const entries = await db.all(
      `SELECT l.*, p.first_name AS patient_first_name, p.last_name AS patient_last_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
       WHERE l.practice_id = ? AND l.patient_id IN (${inList}) AND l.entry_date >= ? ORDER BY l.entry_date, l.id`, req.user.practice_id, ...ids, since,
    );
    const balance = (await db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${inList})`, req.user.practice_id, ...ids)).n;
    await audit(db, req, 'statement.generate', 'patients', patient.id, { family });
    res.json({ practice, patient: addressee, family, since, previous_balance: prior, entries, balance, generated_at: new Date().toISOString() });
  });

  return r;
}
