import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { isManager } from '../deposits.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, publicPractice } from '../util.js';
import { patientBalance, pendingInsurance, checkPostingDate, voidLedgerEntry } from '../services.js';
import { planStatus } from './family.js';
import { allocate } from '../allocation.js';
import { groupByVisit, entryKind, linkProblem } from '../ledgervisits.js';
import { accountAging } from '../aging.js';
import { portalKey } from './portal.js';
import { payCodeFor, formatCode, guarantorIdOf } from '../billpay.js';
import { receiptData, receiptPdf, sendReceipt } from '../receipts.js';
import nextSlotRoutes from './nextslots.js';
import { patientScope } from '../officeaccess.js';

export const PAYMENT_METHODS = ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'financing', 'other'];

export default function billingRoutes({ db, payments = { enabled: false }, config = {}, messenger = null }) {
  const r = Router();
  const patientOr404 = async (req) => await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
  // Suggested times for the next visit (checkout's "Book recall"). Lives in its own module; mounted here so
  // app.js doesn't need to change.
  r.use(nextSlotRoutes({ db }));

  r.get('/patients/:id/ledger', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const entries = await db.all(
      `SELECT l.*, u.name AS created_by_name, pv.name AS provider_name, pr.code AS proc_code, pr.tooth AS proc_tooth, pr.surfaces AS proc_surfaces,
         COALESCE(l.claim_id, (SELECT MAX(ci.claim_id) FROM claim_items ci WHERE ci.procedure_id = l.procedure_id)) AS claim_link,
         pr.appointment_id AS visit_appointment_id, a.start_time AS visit_start, a.reason AS visit_reason, apv.name AS visit_provider
       FROM ledger_entries l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN providers pv ON pv.id = l.provider_id LEFT JOIN procedures pr ON pr.id = l.procedure_id
         LEFT JOIN appointments a ON a.id = pr.appointment_id LEFT JOIN providers apv ON apv.id = a.provider_id
       WHERE l.patient_id = ? AND l.practice_id = ? ORDER BY l.entry_date, l.id`,
      patient.id, req.user.practice_id,
    );
    let running = 0;
    for (const e of entries) e.running_balance = running += e.amount;
    const pending = await pendingInsurance(db, req.user.practice_id, patient.id);
    const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', req.user.practice_id)).lock_date;
    // What each credit paid for, and credit not yet applied to any charge.
    const lines = await db.all('SELECT ci.claim_id, ci.procedure_id, ci.paid_amount, ci.adjusted_amount FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.patient_id = ? AND c.practice_id = ?', patient.id, req.user.practice_id);
    const { allocations, unapplied } = allocate(entries, lines);
    const paidBy = new Map();
    for (const a of allocations) paidBy.set(a.charge_id, (paidBy.get(a.charge_id) || 0) + a.amount);
    for (const e of entries) if (e.amount > 0 && e.type === 'charge') e.paid_off = paidBy.get(e.id) || 0;
    // The same entries by visit (ledgervisits.js): each line's kind (colour coding), its visit, and whether it
    // can be applied to a visit from here.
    const claims = await db.all(
      `SELECT c.id, c.status, c.estimated_amount, c.paid_amount, c.write_off_estimate, pi.priority, ic.name AS carrier_name
       FROM claims c LEFT JOIN patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.patient_id = ? AND c.practice_id = ? ORDER BY c.id`, patient.id, req.user.practice_id,
    );
    const { visits, unapplied: notApplied } = groupByVisit(entries, claims, lines);
    for (const e of entries) {
      e.kind = entryKind(e);
      e.linkable = !linkProblem(e, lock);
    }
    // Which voids need a manager (the cash controls in cashdeposits.js): cash in or out, and anything on a
    // submitted deposit. Said up front, so nobody types a reason only to be told no.
    if (!isManager(req.user)) {
      const depositIds = [...new Set(entries.map((e) => e.deposit_id).filter(Boolean))];
      const locked = new Set(depositIds.length
        ? (await db.all(`SELECT DISTINCT deposit_id FROM deposit_slips WHERE deposit_id IN (${depositIds.map(() => '?').join(',')}) AND stage <> 'reopened'`, ...depositIds)).map((x) => x.deposit_id)
        : []);
      for (const e of entries) {
        if (e.voided_at || e.reverses_id) continue;
        if (e.deposit_id && locked.has(e.deposit_id)) e.void_needs_manager = 'It’s on a deposit that has been submitted';
        else if (e.method === 'cash' && ['payment', 'refund'].includes(e.type)) e.void_needs_manager = 'Voiding cash needs a manager (cash controls)';
      }
    }
    res.json({
      entries, balance: running, pending_insurance: pending.insurance, pending_write_off: pending.write_off, patient_portion: running - pending.total, lock_date: lock,
      unapplied_credit: unapplied.reduce((s, u) => s + u.amount, 0), visits, not_applied: notApplied,
    });
  });

  // "Why do I owe this?" — the balance explained visit by visit, worked out from the ledger every time (never a
  // stored balance): what each visit charged, what insurance paid or wrote off, what's still waiting on
  // insurance, what the patient paid, and what's left. The parts always add up to the ledger balance.
  r.get('/patients/:id/balance-explained', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json(await explainBalance(db, req.user.practice_id, patient.id));
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
      description: row.description ? String(row.description).slice(0, 300) : `Patient payment (${row.method.replace('_', ' ')})`, method: row.method,
      reference: row.reference != null ? String(row.reference).slice(0, 50) : null, entry_date: await checkPostingDate(db, req.user.practice_id, row.entry_date), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.payment', 'ledger_entries', id, { amount });
    if (plan && (await planStatus(db, plan, '9999-12-31')).remaining === 0) await db.run("UPDATE payment_plans SET status = 'completed' WHERE id = ?", plan.id);
    const receipt = ['email', 'sms'].includes(req.body?.receipt) ? await sendReceipt(db, messenger, { entryId: id, practiceId: req.user.practice_id, channel: req.body.receipt, userId: req.user.id }) : null;
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id), receipt });
  });

  // ---- Receipts ----
  r.get('/payments/:lid/receipt.pdf', requirePermission('billing:read'), async (req, res) => {
    const data = await receiptData(db, Number(req.params.lid), req.user.practice_id);
    if (!data) throw new HttpError(404, 'Payment not found');
    await audit(db, req, 'receipt.print', 'ledger_entries', data.entry.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="receipt-${data.entry.id}.pdf"` }).send(receiptPdf(data));
  });
  r.post('/payments/:lid/receipt', requirePermission('billing:write'), async (req, res) => {
    const channel = req.body?.channel;
    requireOneOf(channel, ['email', 'sms'], 'channel');
    if (!(await receiptData(db, Number(req.params.lid), req.user.practice_id))) throw new HttpError(404, 'Payment not found');
    const msg = await sendReceipt(db, messenger, { entryId: Number(req.params.lid), practiceId: req.user.practice_id, channel, userId: req.user.id });
    if (!msg) throw new HttpError(400, channel === 'sms' ? 'No mobile number that accepts texts on this account' : 'No email address that accepts email on this account');
    res.status(201).json(msg);
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
      description: String(row.description).slice(0, 300), entry_date: await checkPostingDate(db, req.user.practice_id, row.entry_date), created_by: req.user.id,
    });
    await audit(db, req, 'ledger.adjustment', 'ledger_entries', id, { amount });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });

  // The refund queue (workflow 48): every account the practice owes money to, largest first, with the card
  // payment a refund would go back to (the latest one with money left to refund). Read-only; the refund itself
  // is POST /patients/:id/refunds below.
  r.get('/billing/credit-balances', requirePermission('billing:read'), async (req, res) => {
    const scope = patientScope(req.user);
    const rows = await db.all(
      `SELECT p.id AS patient_id, p.first_name, p.last_name, p.phone, SUM(l.amount) AS balance, MAX(CASE WHEN l.amount < 0 THEN l.entry_date END) AS last_credit
       FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
       WHERE l.practice_id = ?${scope.sql} GROUP BY p.id, p.first_name, p.last_name, p.phone HAVING SUM(l.amount) < 0`,
      req.user.practice_id, ...scope.args,
    );
    const out = [];
    for (const r0 of rows) {
      const cards = await db.all(
        `SELECT l.id, l.entry_date, l.amount, l.method, l.reference, (SELECT COALESCE(SUM(x.amount), 0) FROM ledger_entries x WHERE x.refund_of_id = l.id) AS refunded
         FROM ledger_entries l WHERE l.patient_id = ? AND l.practice_id = ? AND l.type = 'payment' AND l.amount < 0 AND l.voided_at IS NULL
           AND l.method IN ('credit_card','debit_card') ORDER BY l.entry_date DESC, l.id DESC`,
        r0.patient_id, req.user.practice_id,
      );
      // Only card payments taken through the processor can be refunded to the card.
      const card = cards.filter((c) => /^(pi_|sbx_)/.test(c.reference || '')).map((c) => ({ id: c.id, entry_date: c.entry_date, method: c.method, left: -c.amount - Number(c.refunded) })).find((c) => c.left > 0) || null;
      out.push({ ...r0, credit: -Number(r0.balance), card_payment: card });
    }
    res.json(out.sort((a, b) => b.credit - a.credit));
  });

  // Refund of a credit balance. With `payment_id` of a card payment, the money goes back to that card
  // through the processor; otherwise it's recorded as paid out by cash or check.
  // Money leaving the practice is a sensitive action (CLAUDE.md rule 8): a manager (deposits:manage) or admin.
  r.post('/patients/:id/refunds', requirePermission('billing:write'), async (req, res) => {
    if (!isManager(req.user)) throw new HttpError(403, 'A refund needs a manager — ask one to do it', { manager_required: true });
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
    const after = await patientBalance(db, req.user.practice_id, patient.id);
    // Before and after, so the audit shows what the account looked like on each side of the refund.
    await audit(db, req, 'ledger.refund', 'ledger_entries', id, { amount, payment_id: original?.id ?? null, method, to_card: !!original, balance_before: -credit, balance_after: Number(after), patient_id: patient.id });
    res.status(201).json({ entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), balance: after });
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
    // Only what the account actually has can move: its balance (positive) or its credit (negative).
    const balance = Number(await patientBalance(db, req.user.practice_id, from.id));
    if (amount > 0 && amount > balance) throw new HttpError(400, `${from.first_name} owes $${(Math.max(0, balance) / 100).toFixed(2)} — that's the most that can be moved`);
    if (amount < 0 && -amount > -balance) throw new HttpError(400, `${from.first_name} has $${(Math.max(0, -balance) / 100).toFixed(2)} of credit — that's the most that can be moved`);
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

  // Applies a patient payment or adjustment to a visit (so the ledger by visit, "Why this balance" and
  // collections by provider count it there), or takes it off again. Only the link changes — never the amount,
  // date or type — and each change is audited with before → after and the reason. Asking twice is harmless:
  // the same link again changes nothing and records nothing.
  const linkable = async (req) => {
    const entry = await findOr404(db, 'ledger_entries', req.params.eid, req.user.practice_id, 'Ledger entry');
    const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', req.user.practice_id)).lock_date;
    const problem = linkProblem(entry, lock);
    if (problem) throw new HttpError(409, problem);
    return entry;
  };
  const setLink = async (req, entry, to, action) => {
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
    await update(db, 'ledger_entries', entry.id, req.user.practice_id, { applied_to_id: to });
    await audit(db, req, action, 'ledger_entries', entry.id, { amount: entry.amount, type: entry.type, applied_to_id: to, patient_id: entry.patient_id },
      { reason, patientId: entry.patient_id, before: { applied_to_id: entry.applied_to_id ?? null }, after: { applied_to_id: to } });
  };
  r.post('/ledger/:eid/link', requirePermission('billing:write'), async (req, res) => {
    const entry = await linkable(req);
    const toId = Number(req.body?.applied_to_id);
    if (!Number.isInteger(toId) || toId <= 0) throw new HttpError(400, 'Choose the visit to apply this to');
    const target = await findOr404(db, 'ledger_entries', toId, req.user.practice_id, 'Visit');
    if (target.patient_id !== entry.patient_id) throw new HttpError(400, "That visit is on another patient's account");
    if (target.type !== 'charge' || target.voided_at || target.reverses_id) throw new HttpError(400, 'Choose a visit with a charge on it');
    const unchanged = entry.applied_to_id === target.id;
    if (!unchanged) await setLink(req, entry, target.id, 'ledger.link');
    res.json({ unchanged, entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', entry.id) });
  });
  r.post('/ledger/:eid/unlink', requirePermission('billing:write'), async (req, res) => {
    const entry = await linkable(req);
    const unchanged = entry.applied_to_id == null;
    if (!unchanged) await setLink(req, entry, null, 'ledger.unlink');
    res.json({ unchanged, entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', entry.id) });
  });

  r.post('/ledger/:eid/void', requirePermission('billing:write'), async (req, res) => {
    const entry = await findOr404(db, 'ledger_entries', req.params.eid, req.user.practice_id, 'Ledger entry');
    // Voiding a charge takes it off the patient's bill, the same as writing it off: same approval limit.
    const limit = (await db.get('SELECT adjustment_approval_limit FROM practices WHERE id = ?', req.user.practice_id)).adjustment_approval_limit;
    if (entry.amount > 0 && limit != null && entry.amount > limit && req.user.role !== 'admin') {
      throw new HttpError(403, `Voiding charges over $${(limit / 100).toFixed(2)} needs an administrator`, { approval_required: true });
    }
    const id = await voidLedgerEntry(db, entry, { userId: req.user.id, reason: req.body?.reason });
    await audit(db, req, 'ledger.void', 'ledger_entries', entry.id, { reason: req.body?.reason, reversal_id: id, amount: entry.amount });
    res.status(201).json({ reversal_id: id, balance: await patientBalance(db, req.user.practice_id, entry.patient_id) });
  });

  // Printable statement data.
  r.get('/patients/:id/statement', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const family = req.query.family === 'true' || req.query.family === '1';
    const data = await statementData(db, req.user.practice_id, patient, { family, since: req.query.since || '0000-00-00', appUrl: config.appUrl });
    await audit(db, req, 'statement.generate', 'patients', patient.id, { family });
    res.json(data);
  });

  return r;
}

// "Why do I owe this?" for one patient (staff ledger and the patient portal): see the route above.
export async function explainBalance(db, pid, patientId) {
  const entries = await db.all(
    `SELECT l.*, pr.appointment_id AS visit_appointment_id FROM ledger_entries l LEFT JOIN procedures pr ON pr.id = l.procedure_id
     WHERE l.patient_id = ? AND l.practice_id = ? ORDER BY l.entry_date, l.id`, patientId, pid,
  );
  const balance = entries.reduce((s, e) => s + e.amount, 0);
  const claimLines = await db.all(
    `SELECT ci.claim_id, ci.procedure_id, ci.paid_amount, ci.adjusted_amount, ci.estimated_amount, ci.write_off, c.status
     FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.patient_id = ? AND c.practice_id = ?`, patientId, pid,
  );
  const { allocations, unapplied, open_charges: openCharges } = allocate(entries, claimLines);
  const open = new Map(openCharges.map((c) => [c.id, c.open]));
  // Still expected from insurance on each procedure: its open claims' estimates less what's been paid, and the
  // in-network write-off not posted yet (the same rule as the ledger's "Pending insurance").
  const pendingBy = new Map();
  for (const l of claimLines) {
    if (!['draft', 'submitted', 'partially_paid'].includes(l.status)) continue;
    const p = pendingBy.get(l.procedure_id) || { insurance: 0, write_off: 0 };
    p.insurance += Math.max(0, (l.estimated_amount || 0) - (l.paid_amount || 0));
    if (['draft', 'submitted'].includes(l.status)) p.write_off += l.write_off || 0;
    pendingBy.set(l.procedure_id, p);
  }
  const kindOf = (a) => {
    const credit = entries.find((e) => e.id === a.credit_id);
    if (credit.type === 'insurance_payment') return 'insurance_paid';
    if (credit.type === 'payment') return 'patient_paid';
    return credit.claim_id ? 'write_off' : 'adjusted';
  };
  const procIds = [...new Set(entries.map((e) => e.procedure_id).filter(Boolean))];
  const procs = new Map((procIds.length ? await db.all(
    `SELECT pr.id, pr.code, pr.tooth, pr.surfaces, pr.area, pr.description, pr.appointment_id, a.start_time, a.reason, pv.name AS provider_name
     FROM procedures pr LEFT JOIN appointments a ON a.id = pr.appointment_id LEFT JOIN providers pv ON pv.id = COALESCE(a.provider_id, pr.provider_id)
     WHERE pr.practice_id = ? AND pr.id IN (${procIds.map(() => '?').join(',')})`, pid, ...procIds,
  ) : []).map((p) => [p.id, p]));
  const visits = new Map();
  for (const c of entries.filter((e) => e.amount > 0 && e.type !== 'refund' && !e.voided_at && !e.reverses_id)) {
    const pr = c.procedure_id ? procs.get(c.procedure_id) : null;
    const key = pr?.appointment_id ? `a${pr.appointment_id}` : `d${c.entry_date}`;
    if (!visits.has(key)) {
      visits.set(key, {
        key, appointment_id: pr?.appointment_id ?? null, date: pr?.start_time ? pr.start_time.slice(0, 10) : c.entry_date,
        reason: pr?.reason || null, provider_name: pr?.provider_name || null, lines: [],
      });
    }
    const got = { insurance_paid: 0, write_off: 0, patient_paid: 0, adjusted: 0 };
    for (const a of allocations.filter((x) => x.charge_id === c.id)) got[kindOf(a)] += a.amount;
    const left = open.get(c.id) || 0;
    const pend = pr ? pendingBy.get(pr.id) : null;
    const waiting = Math.min(left, (pend?.insurance || 0) + (pend?.write_off || 0));
    visits.get(key).lines.push({
      ledger_entry_id: c.id, procedure_id: c.procedure_id ?? null, type: c.type, code: pr?.code ?? null, tooth: pr?.tooth ?? null,
      description: pr ? `${pr.description}${pr.tooth ? ` #${pr.tooth}` : ''}${pr.surfaces ? ` ${pr.surfaces}` : ''}` : c.description,
      charged: c.amount, ...got, open: left, waiting_on_insurance: waiting, patient_owes: left - waiting,
    });
  }
  const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
  const out = [...visits.values()].map((v) => ({
    ...v,
    totals: Object.fromEntries(['charged', 'insurance_paid', 'write_off', 'adjusted', 'patient_paid', 'open', 'waiting_on_insurance', 'patient_owes'].map((k) => [k, sum(v.lines, k)])),
  })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const credit = unapplied.reduce((s, u) => s + u.amount, 0);
  // Anything the visits and credit don't explain (e.g. a refund larger than the credit it came from) is shown,
  // not hidden, so the parts always add up to the balance.
  const other = balance - (sum(out.map((v) => v.totals), 'open') - credit);
  const pending = await pendingInsurance(db, pid, patientId);
  return {
    balance, pending_insurance: pending.insurance, pending_write_off: pending.write_off, patient_portion: balance - pending.total,
    unapplied_credit: credit, other, visits: out,
  };
}

// Statement contents for a patient, or (family) for the guarantor and every member of the household.
export async function statementData(db, practiceId, patient, { family = false, since = '0000-00-00', appUrl = null } = {}) {
  const practiceRow = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const practice = publicPractice(practiceRow);
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
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const plans = [];
  for (const p of await db.all(`SELECT * FROM payment_plans WHERE practice_id = ? AND patient_id IN (${inList}) AND status = 'active' ORDER BY id`, practiceId, ...ids)) {
    const s = await planStatus(db, p, today);
    plans.push({ id: s.id, total: s.total, remaining: s.remaining, installment_amount: s.installment_amount, frequency: s.frequency, next_due_date: s.next_due_date, next_due_amount: s.next_due_amount, past_due: s.past_due });
  }
  return {
    practice, patient: addressee, family, since, previous_balance: prior, entries, balance,
    pending_insurance: pending.insurance, pending_write_off: pending.write_off, amount_due: Math.max(0, balance - pending.total), generated_at: new Date().toISOString(),
    aging: await accountAging(db, practiceId, ids, today), plans,
    also_responsible: addressee.second_responsible_id ? await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', addressee.second_responsible_id) : null,
    pay_url: appUrl ? `${appUrl}/portal/${portalKey(practiceRow)}` : null,
    // "Pay my bill" (billpay.js): the account's code, printed so the bill can be found and paid from the website.
    ...(await billpayFields(db, practiceRow, addressee, appUrl)),
  };
}

async function billpayFields(db, practice, addressee, appUrl) {
  const code = practice.slug && practice.portal_enabled !== 0 ? await payCodeFor(db, practice.id, guarantorIdOf(addressee)) : null;
  return {
    pay_code: formatCode(code),
    billpay_url: code && appUrl ? `${appUrl}/billpay/${encodeURIComponent(practice.slug)}?code=${code}` : null,
    billpay_page: code && appUrl ? `${appUrl}/billpay/${encodeURIComponent(practice.slug)}` : null,
  };
}
