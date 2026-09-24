import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, practiceNow, insert } from '../util.js';
import { INTERVALS, cleanIncluded, membershipYear, addInterval, runMembershipBilling, membershipOn } from '../memberships.js';
import { chargeSucceeded } from '../billingauto.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const age = (dob, on) => (dob ? Math.floor((new Date(on) - new Date(dob)) / (365.25 * 86400_000)) : null);

// Membership plans and the patients on them.
export default function membershipRoutes({ db, payments, messenger }) {
  const r = Router();
  const admin = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change membership plans'); };
  const planView = (p) => ({ ...p, included: JSON.parse(p.included || '[]') });
  const cleanPlan = (b) => {
    const row = {};
    if (b.name !== undefined) { row.name = String(b.name || '').trim().slice(0, 80); if (!row.name) throw new HttpError(400, 'Name the plan'); }
    if (b.description !== undefined) row.description = String(b.description || '').slice(0, 500) || null;
    if (b.price !== undefined) { row.price = Math.round(Number(b.price)); if (!Number.isFinite(row.price) || row.price < 100) throw new HttpError(400, 'price must be at least $1.00 (in cents)'); }
    if (b.interval !== undefined) { if (!INTERVALS.includes(b.interval)) throw new HttpError(400, 'interval must be month or year'); row.interval = b.interval; }
    if (b.discount_pct !== undefined) { row.discount_pct = Number(b.discount_pct) || 0; if (row.discount_pct < 0 || row.discount_pct > 100) throw new HttpError(400, 'discount_pct must be 0-100'); }
    if (b.included !== undefined) row.included = cleanIncluded(b.included);
    for (const k of ['min_age', 'max_age']) if (b[k] !== undefined) row[k] = b[k] === '' || b[k] == null ? null : Number(b[k]);
    if (b.active !== undefined) row.active = b.active ? 1 : 0;
    return row;
  };

  r.get('/membership-plans', requirePermission('billing:read'), async (req, res) => {
    const rows = await db.all(
      `SELECT p.*, (SELECT COUNT(*) FROM memberships m WHERE m.plan_id = p.id AND m.status IN ('active','past_due')) AS members
       FROM membership_plans p WHERE p.practice_id = ?${req.query.all === 'true' ? '' : ' AND p.active = 1'} ORDER BY p.active DESC, p.price`, req.user.practice_id,
    );
    res.json(rows.map(planView));
  });

  r.post('/membership-plans', requirePermission('billing:write'), async (req, res) => {
    admin(req);
    const row = cleanPlan({ interval: 'month', ...req.body });
    if (!row.name || row.price == null) throw new HttpError(400, 'A plan needs a name and a price');
    const id = await insert(db, 'membership_plans', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'membership_plan.create', 'membership_plans', id);
    res.status(201).json(planView(await db.get('SELECT * FROM membership_plans WHERE id = ?', id)));
  });

  r.put('/membership-plans/:pid', requirePermission('billing:write'), async (req, res) => {
    admin(req);
    const plan = await findOr404(db, 'membership_plans', req.params.pid, req.user.practice_id, 'Membership plan');
    const row = cleanPlan(req.body || {});
    if (Object.keys(row).length) await db.run(`UPDATE membership_plans SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), plan.id);
    await audit(db, req, 'membership_plan.update', 'membership_plans', plan.id);
    res.json(planView(await db.get('SELECT * FROM membership_plans WHERE id = ?', plan.id)));
  });

  // A patient's membership: plan, billing, and how much of each included service is left this year.
  const detail = async (m) => {
    const today = (await practiceNow(db, m.practice_id)).slice(0, 10);
    const plan = planView(await db.get('SELECT * FROM membership_plans WHERE id = ?', m.plan_id));
    const year = membershipYear(m.start_date, today < m.start_date ? m.start_date : today);
    const used = await db.all(
      `SELECT pr.code FROM ledger_entries l JOIN procedures pr ON pr.id = l.procedure_id
       WHERE l.membership_id = ? AND l.adjustment_type = 'Membership included' AND l.entry_date >= ? AND l.voided_at IS NULL AND l.reverses_id IS NULL`, m.id, year.from,
    );
    const method = m.payment_method_id ? await db.get('SELECT id, brand, last4, exp_month, exp_year, removed_at FROM payment_methods WHERE id = ?', m.payment_method_id) : null;
    const savings = (await db.get("SELECT COALESCE(-SUM(amount), 0) AS n FROM ledger_entries WHERE membership_id = ? AND type = 'adjustment' AND voided_at IS NULL", m.id)).n;
    return {
      ...m, billing_lock: undefined, plan, year, savings, card: method && !method.removed_at ? method : null,
      usage: plan.included.map((rule) => ({ ...rule, used: used.filter((u) => rule.codes.some((c) => u.code.startsWith(c))).length })),
      benefits_active: !!(await membershipOn(db, m.patient_id, today)),
    };
  };

  r.get('/patients/:id/membership', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const all = await db.all('SELECT * FROM memberships WHERE patient_id = ? AND practice_id = ? ORDER BY id DESC', patient.id, req.user.practice_id);
    const current = all.find((m) => m.status !== 'cancelled') || (all[0]?.paid_through > (await practiceNow(db, req.user.practice_id)).slice(0, 10) ? all[0] : null);
    res.json({ current: current ? await detail(current) : null, history: all.filter((m) => m !== current).map((m) => ({ id: m.id, plan_id: m.plan_id, status: m.status, start_date: m.start_date, cancelled_at: m.cancelled_at })) });
  });

  // Cards belong to the household's guarantor.
  const checkCard = async (req, patient, methodId) => {
    if (!methodId) return null;
    const holder = patient.guarantor_id || patient.id;
    const m = await db.get('SELECT id FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(methodId), req.user.practice_id, holder);
    if (!m) throw new HttpError(404, 'Card not found on this account');
    return m.id;
  };

  r.post('/patients/:id/memberships', requirePermission('billing:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const plan = await findOr404(db, 'membership_plans', req.body?.plan_id, req.user.practice_id, 'Membership plan');
    if (!plan.active) throw new HttpError(400, 'That plan is no longer offered');
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const start = req.body?.start_date || today;
    if (!DATE.test(start)) throw new HttpError(400, 'start_date must be YYYY-MM-DD');
    const years = age(patient.dob, start);
    if ((plan.min_age != null || plan.max_age != null) && years == null) throw new HttpError(400, 'Add the patient’s date of birth first — this plan has an age range');
    if (plan.min_age != null && years < plan.min_age) throw new HttpError(400, `${plan.name} is for patients ${plan.min_age} and older`);
    if (plan.max_age != null && years > plan.max_age) throw new HttpError(400, `${plan.name} is for patients up to ${plan.max_age}`);
    const methodId = await checkCard(req, patient, req.body?.payment_method_id);
    const id = await db.tx(async () => {
      if (await db.get("SELECT id FROM memberships WHERE patient_id = ? AND status IN ('active','past_due')", patient.id)) throw new HttpError(409, 'This patient already has a membership — cancel it first to switch plans');
      return insert(db, 'memberships', {
        practice_id: req.user.practice_id, patient_id: patient.id, plan_id: plan.id, start_date: start, next_bill_date: start, paid_through: start,
        payment_method_id: methodId, autopay: req.body?.autopay === false ? 0 : 1, created_by: req.user.id,
      });
    });
    await audit(db, req, 'membership.create', 'memberships', id, { plan: plan.name });
    // The first period is billed (and the card charged) right away.
    const billing = start <= today ? await runMembershipBilling(db, payments, { membershipId: id, messenger }) : [];
    res.status(201).json({ ...(await detail(await db.get('SELECT * FROM memberships WHERE id = ?', id))), billing });
  });

  const membershipOr404 = async (req) => findOr404(db, 'memberships', req.params.mid, req.user.practice_id, 'Membership');

  r.put('/memberships/:mid', requirePermission('billing:write'), async (req, res) => {
    const m = await membershipOr404(req);
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', m.patient_id);
    const row = {};
    if (req.body?.payment_method_id !== undefined) { row.payment_method_id = await checkCard(req, patient, req.body.payment_method_id); row.billing_failures = 0; }
    if (req.body?.autopay !== undefined) row.autopay = req.body.autopay ? 1 : 0;
    if (Object.keys(row).length) await db.run(`UPDATE memberships SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), m.id);
    await audit(db, req, 'membership.update', 'memberships', m.id);
    res.json(await detail(await db.get('SELECT * FROM memberships WHERE id = ?', m.id)));
  });

  // Try billing now (e.g. after a new card is added to a past-due membership).
  r.post('/memberships/:mid/bill', requirePermission('billing:write'), async (req, res) => {
    const m = await membershipOr404(req);
    if (m.status === 'past_due') await db.run('UPDATE memberships SET billing_message = NULL WHERE id = ?', m.id);
    const billing = await runMembershipBilling(db, payments, { membershipId: m.id, messenger });
    await audit(db, req, 'membership.bill', 'memberships', m.id, { periods: billing.length });
    res.json({ ...(await detail(await db.get('SELECT * FROM memberships WHERE id = ?', m.id))), billing });
  });

  // The patient paid the period at the desk: the fee is already on the ledger, so just move to the next period.
  r.post('/memberships/:mid/settle', requirePermission('billing:write'), async (req, res) => {
    const m = await membershipOr404(req);
    if (m.status !== 'past_due') throw new HttpError(409, 'Only a past-due membership can be marked as paid');
    const plan = await db.get('SELECT interval FROM membership_plans WHERE id = ?', m.plan_id);
    const next = addInterval(m.next_bill_date, plan.interval);
    await db.run("UPDATE memberships SET status = 'active', next_bill_date = ?, paid_through = ?, billing_failures = 0, billing_message = ? WHERE id = ?", next, next, `Paid at the office (${req.user.name || 'staff'})`, m.id);
    // Its declined-card retries are over (billingauto.js), and the Needs attention item resolves.
    await chargeSucceeded(db, { practiceId: m.practice_id, sourceType: 'membership', sourceId: m.id, today: (await practiceNow(db, m.practice_id)).slice(0, 10), note: 'paid at the office' });
    await audit(db, req, 'membership.settle', 'memberships', m.id);
    res.json(await detail(await db.get('SELECT * FROM memberships WHERE id = ?', m.id)));
  });

  // Cancelling stops future billing; benefits last through the period already paid for.
  r.post('/memberships/:mid/cancel', requirePermission('billing:write'), async (req, res) => {
    const m = await membershipOr404(req);
    if (m.status === 'cancelled') throw new HttpError(409, 'Already cancelled');
    await db.run("UPDATE memberships SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?", String(req.body?.reason || '').slice(0, 300) || null, m.id);
    await audit(db, req, 'membership.cancel', 'memberships', m.id);
    res.json(await detail(await db.get('SELECT * FROM memberships WHERE id = ?', m.id)));
  });

  r.get('/reports/memberships', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const to = DATE.test(req.query.to || '') ? req.query.to : (await practiceNow(db, pid)).slice(0, 10);
    const from = DATE.test(req.query.from || '') ? req.query.from : `${to.slice(0, 7)}-01`;
    const members = await db.all(
      `SELECT m.id, m.patient_id, m.status, m.start_date, m.next_bill_date, m.paid_through, m.billing_message, m.autopay, m.payment_method_id,
         p.first_name, p.last_name, mp.name AS plan_name, mp.price, mp.interval
       FROM memberships m JOIN patients p ON p.id = m.patient_id JOIN membership_plans mp ON mp.id = m.plan_id
       WHERE m.practice_id = ? AND m.status IN ('active','past_due') ORDER BY m.status DESC, p.last_name, p.first_name`, pid,
    );
    const monthly = members.reduce((s, m) => s + (m.interval === 'year' ? Math.round(m.price / 12) : m.price), 0);
    const sum = async (sql) => (await db.get(sql, pid, from, to)).n;
    res.json({
      from, to, active: members.length, past_due: members.filter((m) => m.status === 'past_due').length, monthly_recurring: monthly, members,
      joined: await sum('SELECT COUNT(*) AS n FROM memberships WHERE practice_id = ? AND start_date BETWEEN ? AND ?'),
      cancelled: await sum('SELECT COUNT(*) AS n FROM memberships WHERE practice_id = ? AND substr(cancelled_at, 1, 10) BETWEEN ? AND ?'),
      fees_billed: await sum("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND membership_id IS NOT NULL AND type = 'charge' AND voided_at IS NULL AND entry_date BETWEEN ? AND ?"),
      member_savings: await sum("SELECT COALESCE(-SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND membership_id IS NOT NULL AND type = 'adjustment' AND voided_at IS NULL AND entry_date BETWEEN ? AND ?"),
      member_production: await sum(`SELECT COALESCE(SUM(l.amount), 0) AS n FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'charge' AND l.procedure_id IS NOT NULL AND l.voided_at IS NULL AND l.entry_date BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.patient_id = l.patient_id AND m.start_date <= l.entry_date AND (m.cancelled_at IS NULL OR m.paid_through > l.entry_date))`),
    });
  });

  return r;
}
