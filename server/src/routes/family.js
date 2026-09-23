import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq } from '../util.js';

const FREQ_DAYS = { weekly: 7, biweekly: 14 };

// Due date of installment i (0-based) for a plan.
export function installmentDate(plan, i) {
  const d = new Date(`${plan.start_date}T12:00:00Z`);
  if (plan.frequency === 'monthly') {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + i);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else {
    d.setUTCDate(d.getUTCDate() + i * FREQ_DAYS[plan.frequency]);
  }
  return d.toISOString().slice(0, 10);
}

// Adds schedule, amount paid, amount due to date and next due date to a plan row.
export async function planStatus(db, plan, today) {
  const financed = plan.total - plan.down_payment;
  const paid = -(await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE payment_plan_id = ?', plan.id)).n;
  const schedule = Array.from({ length: plan.installments }, (_, i) => {
    const amount = i === plan.installments - 1 ? financed - plan.installment_amount * (plan.installments - 1) : plan.installment_amount;
    return { n: i + 1, due_date: installmentDate(plan, i), amount };
  });
  let cumulative = 0;
  let dueToDate = 0;
  for (const s of schedule) {
    cumulative += s.amount;
    s.paid = Math.max(0, Math.min(s.amount, paid - (cumulative - s.amount)));
    if (s.due_date <= today) dueToDate = cumulative;
  }
  const next = schedule.find((s) => s.paid < s.amount);
  return {
    ...plan,
    financed,
    paid,
    remaining: Math.max(0, financed - paid),
    past_due: Math.max(0, dueToDate - paid),
    next_due_date: next?.due_date ?? null,
    next_due_amount: next ? next.amount - next.paid : 0,
    schedule,
  };
}

export default function familyRoutes({ db }) {
  const r = Router();
  const patientOr404 = async (req, id = req.params.id) => await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
  // The guarantor is responsible for the family's bills; a patient with no guarantor is their own.
  const guarantorOf = async p => (p.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id) : p);

  // ---- Family file ----
  r.get('/patients/:id/family', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const g = await guarantorOf(await patientOr404(req));
    const now = await practiceNow(db, pid);
    const members = await db.all(
      `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.status, p.guarantor_id, p.medical_alerts,
        (SELECT COALESCE(SUM(amount),0) FROM ledger_entries l WHERE l.patient_id = p.id) AS balance,
        (SELECT MIN(start_time) FROM appointments a WHERE a.patient_id = p.id AND a.start_time >= ? AND a.status NOT IN ('cancelled','no_show')) AS next_appointment,
        (SELECT MIN(due_date) FROM recalls r WHERE r.patient_id = p.id AND r.status IN ('due','contacted')) AS recall_due
       FROM patients p WHERE p.practice_id = ? AND (p.id = ? OR p.guarantor_id = ?) AND p.status != 'archived'
       ORDER BY p.guarantor_id IS NOT NULL, p.dob`, now, pid, g.id, g.id,
    );
    res.json({
      guarantor: { id: g.id, first_name: g.first_name, last_name: g.last_name, phone: g.phone, email: g.email, address: g.address, city: g.city, state: g.state, zip: g.zip },
      members,
      family_balance: members.reduce((s, m) => s + m.balance, 0),
    });
  });

  // Link an existing patient to this family (the guarantor of :id becomes theirs).
  r.post('/patients/:id/family', requirePermission('patients:write'), async (req, res) => {
    const g = await guarantorOf(await patientOr404(req));
    let memberId;
    if (req.body?.patient_id) {
      const member = await patientOr404(req, req.body.patient_id);
      if (member.id === g.id) throw new HttpError(400, 'That patient is already the guarantor');
      if (await db.get('SELECT id FROM patients WHERE guarantor_id = ? LIMIT 1', member.id)) {
        throw new HttpError(409, `${member.first_name} is the guarantor of another family; move those members first`);
      }
      await update(db, 'patients', member.id, req.user.practice_id, { guarantor_id: g.id, updated_at: new Date().toISOString() });
      memberId = member.id;
    } else {
      // New family member, inheriting the household's contact details.
      const row = pick(req.body, ['first_name', 'last_name', 'dob', 'gender', 'preferred_name']);
      requireFields(row, ['first_name']);
      memberId = await insert(db, 'patients', {
        ...row, last_name: row.last_name || g.last_name, practice_id: req.user.practice_id, guarantor_id: g.id,
        phone: g.phone, email: g.email, address: g.address, city: g.city, state: g.state, zip: g.zip, primary_provider_id: g.primary_provider_id,
      });
    }
    await audit(db, req, 'family.link', 'patients', memberId, { guarantor_id: g.id });
    res.status(201).json(await db.get('SELECT * FROM patients WHERE id = ?', memberId));
  });

  r.delete('/patients/:id/family/:memberId', requirePermission('patients:write'), async (req, res) => {
    const member = await patientOr404(req, req.params.memberId);
    await update(db, 'patients', member.id, req.user.practice_id, { guarantor_id: null, updated_at: new Date().toISOString() });
    await audit(db, req, 'family.unlink', 'patients', member.id);
    res.json({ ok: true });
  });

  // Make a member the head of household (e.g. a parent takes over from a grandparent).
  r.post('/patients/:id/family/guarantor', requirePermission('patients:write'), async (req, res) => {
    const newG = await patientOr404(req);
    const oldG = await guarantorOf(newG);
    if (oldG.id === newG.id) return res.json({ ok: true });
    await db.tx(async () => {
      await db.run('UPDATE patients SET guarantor_id = ? WHERE practice_id = ? AND (guarantor_id = ? OR id = ?)', newG.id, req.user.practice_id, oldG.id, oldG.id);
      await db.run('UPDATE patients SET guarantor_id = NULL WHERE id = ?', newG.id);
    });
    await audit(db, req, 'family.guarantor_change', 'patients', newG.id, { from: oldG.id });
    res.json({ ok: true });
  });

  // ---- Payment plans ----
  r.get('/payment-plans', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const status = req.query.status || 'active';
    const plans = await mapSeq((await db.all(
      `SELECT pp.*, p.first_name, p.last_name, p.phone FROM payment_plans pp JOIN patients p ON p.id = pp.patient_id
       WHERE pp.practice_id = ? AND (? = 'all' OR pp.status = ?) ORDER BY pp.created_at DESC`, pid, status, status,
    )), async p => await planStatus(db, p, today));
    res.json(req.query.overdue === 'true' ? plans.filter((p) => p.past_due > 0) : plans);
  });

  r.get('/patients/:id/payment-plans', requirePermission('billing:read'), async (req, res) => {
    const g = await guarantorOf(await patientOr404(req));
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    res.json(await mapSeq(
      (await db.all('SELECT * FROM payment_plans WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', req.user.practice_id, g.id)),
      async p => await planStatus(db, p, today)
    ));
  });

  r.post('/patients/:id/payment-plans', requirePermission('billing:write'), async (req, res) => {
    const g = await guarantorOf(await patientOr404(req));
    const row = pick(req.body, ['total', 'down_payment', 'installments', 'frequency', 'start_date', 'notes']);
    requireFields(row, ['total', 'installments', 'start_date']);
    row.total = toCents(row.total, 'total');
    row.down_payment = toCents(row.down_payment ?? 0, 'down_payment');
    row.installments = Number(row.installments);
    row.frequency = row.frequency || 'monthly';
    requireOneOf(row.frequency, ['weekly', 'biweekly', 'monthly'], 'frequency');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.start_date)) throw new HttpError(400, 'start_date must be YYYY-MM-DD');
    if (row.total <= 0 || row.down_payment < 0 || row.down_payment >= row.total) throw new HttpError(400, 'Down payment must be less than the total');
    if (!Number.isInteger(row.installments) || row.installments < 1 || row.installments > 120) throw new HttpError(400, 'Installments must be 1-120');
    const installment = Math.ceil((row.total - row.down_payment) / row.installments);
    const id = await insert(db, 'payment_plans', { ...row, installment_amount: installment, practice_id: req.user.practice_id, patient_id: g.id, created_by: req.user.id });
    await audit(db, req, 'payment_plan.create', 'payment_plans', id, { total: row.total });
    res.status(201).json(await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', id), (await practiceNow(db, req.user.practice_id)).slice(0, 10)));
  });

  r.put('/payment-plans/:planId', requirePermission('billing:write'), async (req, res) => {
    const plan = await findOr404(db, 'payment_plans', req.params.planId, req.user.practice_id, 'Payment plan');
    const row = pick(req.body, ['status', 'notes']);
    requireOneOf(row.status, ['active', 'completed', 'cancelled'], 'status');
    await update(db, 'payment_plans', plan.id, req.user.practice_id, row);
    await audit(db, req, 'payment_plan.update', 'payment_plans', plan.id, row);
    res.json(await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', plan.id), (await practiceNow(db, req.user.practice_id)).slice(0, 10)));
  });

  return r;
}
