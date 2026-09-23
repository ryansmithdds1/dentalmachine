import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, findOr404, audit, toCents, practiceNow, publicPractice } from '../util.js';
import { patientBalance, pendingInsurance, checkPostingDate, voidLedgerEntry } from '../services.js';
import { planStatus } from './family.js';
import { allocate } from '../allocation.js';

export const PAYMENT_METHODS = ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'other'];

export default function billingRoutes({ db, payments = { enabled: false } }) {
  const r = Router();
  const patientOr404 = async (req) => await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');

  r.get('/patients/:id/ledger', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const entries = await db.all(
      `SELECT l.*, u.name AS created_by_name FROM ledger_entries l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.patient_id = ? AND l.practice_id = ? ORDER BY l.entry_date, l.id`,
      patient.id, req.user.practice_id,
    );
    let running = 0;
    for (const e of entries) e.running_balance = running += e.amount;
    const pending = await pendingInsurance(db, req.user.practice_id, patient.id);
    const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', req.user.practice_id)).lock_date;
    // What each credit paid for, and credit not yet applied to any charge.
    const lines = await db.all('SELECT ci.claim_id, ci.procedure_id, ci.paid_amount, ci.adjusted_amount FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.patient_id = ?', patient.id);
    const { allocations, unapplied } = allocate(entries, lines);
    const paidBy = new Map();
    for (const a of allocations) paidBy.set(a.charge_id, (paidBy.get(a.charge_id) || 0) + a.amount);
    for (const e of entries) if (e.amount > 0 && e.type === 'charge') e.paid_off = paidBy.get(e.id) || 0;
    res.json({
      entries, balance: running, pending_insurance: pending.insurance, pending_write_off: pending.write_off, patient_portion: running - pending.total, lock_date: lock,
      unapplied_credit: unapplied.reduce((s, u) => s + u.amount, 0),
    });
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
      practice_id: req.user.practice_id, location_id: req.location_id, patient_id: patient.id, type: 'payment', amount: -amount,
      description: row.description || `Patient payment (${row.method.replace('_', ' ')})`, method: row.method,
      reference: row.reference ?? null, entry_date: await checkPostingDate(db, req.user.practice_id, row.entry_date), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.payment', 'ledger_entries', id, { amount });
    if (plan && (await planStatus(db, plan, '9999-12-31')).remaining === 0) await db.run("UPDATE payment_plans SET status = 'completed' WHERE id = ?", plan.id);
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // ---- Adjustment types ----
  const DEFAULT_TYPES = [['Courtesy discount', 'credit'], ['Senior discount', 'credit'], ['Professional courtesy', 'credit'], ['Small balance write-off', 'credit'], ['Bad debt write-off', 'credit'], ['Insurance write-off', 'credit'], ['Treatment plan discount', 'credit'], ['NSF / returned check fee', 'debit'], ['Finance charge', 'debit'], ['Other', 'credit']];
  const adjustmentTypes = async (pid) => {
    let rows = await db.all('SELECT * FROM adjustment_types WHERE practice_id = ? ORDER BY name', pid);
    if (!rows.length) {
      for (const [name, direction] of DEFAULT_TYPES) await db.run('INSERT INTO adjustment_types (practice_id, name, direction) VALUES (?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, name, direction);
      rows = await db.all('SELECT * FROM adjustment_types WHERE practice_id = ? ORDER BY name', pid);
    }
    return rows;
  };
  r.get('/adjustment-types', requirePermission('billing:read'), async (req, res) => res.json(await adjustmentTypes(req.user.practice_id)));
  r.post('/adjustment-types', requirePermission('billing:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can add adjustment types');
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'name is required');
    requireOneOf(req.body?.direction || 'credit', ['credit', 'debit'], 'direction');
    await db.run('INSERT INTO adjustment_types (practice_id, name, direction) VALUES (?, ?, ?) ON CONFLICT (practice_id, name) DO UPDATE SET active = 1', req.user.practice_id, name, req.body?.direction || 'credit');
    res.status(201).json(await adjustmentTypes(req.user.practice_id));
  });

  // Adjustment: negative = credit (discount/write-off), positive = debit (e.g. NSF fee). Credits above the
  // practice's approval limit need an administrator.
  r.post('/patients/:id/adjustments', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['amount', 'description', 'entry_date', 'adjustment_type']);
    requireFields(row, ['amount', 'description']);
    const amount = toCents(row.amount);
    if (amount === 0) throw new HttpError(400, 'Adjustment amount cannot be zero');
    if (row.adjustment_type && !(await adjustmentTypes(req.user.practice_id)).some((t) => t.name === row.adjustment_type)) throw new HttpError(400, 'Unknown adjustment type');
    const limit = (await db.get('SELECT adjustment_approval_limit FROM practices WHERE id = ?', req.user.practice_id)).adjustment_approval_limit;
    if (amount < 0 && limit != null && -amount > limit && req.user.role !== 'admin') {
      throw new HttpError(403, `Write-offs over $${(limit / 100).toFixed(2)} need an administrator`, { approval_required: true });
    }
    const id = await insert(db, 'ledger_entries', {
      adjustment_type: row.adjustment_type || null,
      practice_id: req.user.practice_id, location_id: req.location_id, patient_id: patient.id, type: 'adjustment', amount,
      description: row.description, entry_date: await checkPostingDate(db, req.user.practice_id, row.entry_date), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.adjustment', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Refund of a credit balance. With `payment_id` of a card payment, the money goes back to that card
  // through the processor; otherwise it's recorded as paid out by cash or check.
  r.post('/patients/:id/refunds', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['amount', 'method', 'reference', 'description', 'payment_id']);
    requireFields(row, ['amount']);
    const amount = toCents(row.amount);
    if (amount <= 0) throw new HttpError(400, 'Refund amount must be positive');
    const credit = -(await patientBalance(db, req.user.practice_id, patient.id));
    if (amount > credit) throw new HttpError(400, credit > 0 ? `The account only has a $${(credit / 100).toFixed(2)} credit to refund` : 'There is no credit on this account to refund');
    let original = null;
    let reference = row.reference ?? null;
    let method = row.method;
    if (row.payment_id) {
      original = await findOr404(db, 'ledger_entries', row.payment_id, req.user.practice_id, 'Payment');
      if (original.patient_id !== patient.id || original.type !== 'payment' || original.amount >= 0 || original.voided_at) throw new HttpError(400, 'Choose a payment on this account to refund');
      const refunded = (await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE refund_of_id = ?', original.id)).n;
      if (amount > -original.amount - refunded) throw new HttpError(400, `Only $${((-original.amount - refunded) / 100).toFixed(2)} of that payment is left to refund`);
      method = original.method;
      if (['credit_card', 'debit_card'].includes(original.method) && payments.refund && /^(pi_|sbx_)/.test(original.reference || '')) {
        const out = await payments.refund({ reference: original.reference, amount, idempotencyKey: `refund-${original.id}-${refunded}-${amount}` });
        reference = out.reference;
      }
    }
    requireOneOf(method, PAYMENT_METHODS, 'method');
    const id = await insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, location_id: req.location_id, patient_id: patient.id, type: 'refund', amount,
      description: row.description || (original ? `Refund of ${original.entry_date} payment` : 'Refund to patient'), method, reference,
      refund_of_id: original?.id ?? null, entry_date: (await practiceNow(db, req.user.practice_id)).slice(0, 10), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.refund', 'ledger_entries', id, { amount, payment_id: original?.id ?? null });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // Moves part of a balance (or credit) to another member of the same family, e.g. a parent's overpayment
  // to a child's account. Posted as a matched pair of adjustments.
  r.post('/patients/:id/transfer', requirePermission('billing:write'), async (req, res) => {
    const from = await patientOr404(req);
    const to = await findOr404(db, 'patients', req.body?.to_patient_id, req.user.practice_id, 'Patient');
    const head = (p) => p.guarantor_id || p.id;
    if (from.id === to.id || head(from) !== head(to)) throw new HttpError(400, 'Transfers are between members of the same family');
    const amount = toCents(req.body?.amount);
    if (amount === 0) throw new HttpError(400, 'Enter an amount');
    const note = String(req.body?.note || '').trim().slice(0, 200);
    const date = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const transfer = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // Positive amount moves a balance (the other account now owes it); negative moves a credit.
    await db.tx(async () => {
      await insert(db, 'ledger_entries', { practice_id: req.user.practice_id, patient_id: from.id, type: 'adjustment', adjustment_type: 'Transfer', amount: -amount, description: `Transfer to ${to.first_name} ${to.last_name}${note ? ` — ${note}` : ''}`, entry_date: date, created_by: req.user.id, transfer_id: transfer });
      await insert(db, 'ledger_entries', { practice_id: req.user.practice_id, patient_id: to.id, type: 'adjustment', adjustment_type: 'Transfer', amount, description: `Transfer from ${from.first_name} ${from.last_name}${note ? ` — ${note}` : ''}`, entry_date: date, created_by: req.user.id, transfer_id: transfer });
    });
    await audit(db, req, 'ledger.transfer', 'patients', from.id, { to: to.id, amount });
    res.status(201).json({ balance: await patientBalance(db, req.user.practice_id, from.id), to_balance: await patientBalance(db, req.user.practice_id, to.id) });
  });

  r.post('/ledger/:eid/void', requirePermission('billing:write'), async (req, res) => {
    const entry = await findOr404(db, 'ledger_entries', req.params.eid, req.user.practice_id, 'Ledger entry');
    const id = await voidLedgerEntry(db, entry, { userId: req.user.id, reason: req.body?.reason });
    await audit(db, req, 'ledger.void', 'ledger_entries', entry.id, { reason: req.body?.reason, reversal_id: id, amount: entry.amount });
    res.status(201).json({ reversal_id: id, balance: await patientBalance(db, req.user.practice_id, entry.patient_id) });
  });

  // Printable statement data.
  r.get('/patients/:id/statement', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const family = req.query.family === 'true' || req.query.family === '1';
    const data = await statementData(db, req.user.practice_id, patient, { family, since: req.query.since || '0000-00-00' });
    await audit(db, req, 'statement.generate', 'patients', patient.id, { family });
    res.json(data);
  });

  return r;
}

// Statement contents for a patient, or (family) for the guarantor and every member of the household.
export async function statementData(db, practiceId, patient, { family = false, since = '0000-00-00' } = {}) {
  const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', practiceId));
  const addressee = family && patient.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', patient.guarantor_id) : patient;
  const ids = family
    ? (await db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', practiceId, addressee.id, addressee.id)).map((x) => x.id)
    : [patient.id];
  const inList = ids.map(() => '?').join(',');
  const prior = (await db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${inList}) AND entry_date < ?`, practiceId, ...ids, since)).n;
  const entries = await db.all(
    `SELECT l.*, p.first_name AS patient_first_name, p.last_name AS patient_last_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
     WHERE l.practice_id = ? AND l.patient_id IN (${inList}) AND l.entry_date >= ? ORDER BY l.entry_date, l.id`, practiceId, ...ids, since,
  );
  const balance = (await db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${inList})`, practiceId, ...ids)).n;
  const pending = await pendingInsurance(db, practiceId, ids);
  return {
    practice, patient: addressee, family, since, previous_balance: prior, entries, balance,
    pending_insurance: pending.insurance, pending_write_off: pending.write_off, amount_due: Math.max(0, balance - pending.total), generated_at: new Date().toISOString(),
  };
}
