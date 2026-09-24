import { Router } from 'express';
import { requireVisiblePatients, canSeePatient } from '../officeaccess.js';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq, paged, recorded } from '../util.js';

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
const customSchedule = (plan) => {
  if (!plan.schedule) return null;
  try { return JSON.parse(plan.schedule); } catch { return null; }
};

// A schedule typed in by staff: dated amounts in order that add up to what's financed.
export function cleanSchedule(input, financed) {
  if (!Array.isArray(input) || !input.length || input.length > 120) throw new HttpError(400, 'A schedule needs 1-120 payments');
  const rows = input.map((s) => ({ due_date: String(s?.due_date || ''), amount: Math.round(Number(s?.amount)) }));
  for (const [i, s] of rows.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.due_date)) throw new HttpError(400, `Payment ${i + 1} needs a date`);
    if (!Number.isInteger(s.amount) || s.amount <= 0) throw new HttpError(400, `Payment ${i + 1} needs an amount above zero`);
    if (i && s.due_date < rows[i - 1].due_date) throw new HttpError(400, 'Payments must be in date order');
  }
  const sum = rows.reduce((t, s) => t + s.amount, 0);
  if (sum !== financed) throw new HttpError(400, `The payments add up to $${(sum / 100).toFixed(2)}; they need to add up to the $${(financed / 100).toFixed(2)} financed`);
  return rows;
}

// Charges the plan's late fee once for each installment still unpaid a set number of days after it was due.
export async function runPlanLateFees(db, { practiceId = null } = {}) {
  const out = [];
  const plans = await db.all(`SELECT * FROM payment_plans WHERE status = 'active' AND late_fee > 0${practiceId ? ' AND practice_id = ?' : ''}`, ...(practiceId ? [practiceId] : []));
  for (const plan of plans) {
    const today = (await practiceNow(db, plan.practice_id)).slice(0, 10);
    const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - (plan.late_fee_days || 0) * 86400_000).toISOString().slice(0, 10);
    const status = await planStatus(db, plan, today);
    for (const s of status.schedule) {
      if (s.due_date > cutoff || s.paid >= s.amount || s.late_fee) continue;
      const fee = await db.tx(async () => {
        const claimed = await db.run('INSERT INTO payment_plan_late_fees (plan_id, installment, amount) VALUES (?, ?, ?) ON CONFLICT (plan_id, installment) DO NOTHING', plan.id, s.n, plan.late_fee);
        if (!claimed.changes) return null;
        const entry = await insert(db, 'ledger_entries', {
          practice_id: plan.practice_id, patient_id: plan.patient_id, type: 'adjustment', adjustment_type: 'Late fee', amount: plan.late_fee,
          description: `Late fee — payment plan installment ${s.n} due ${s.due_date}`, entry_date: today,
        });
        await db.run('UPDATE payment_plan_late_fees SET ledger_entry_id = ? WHERE plan_id = ? AND installment = ?', entry, plan.id, s.n);
        return entry;
      });
      if (fee) out.push({ plan_id: plan.id, installment: s.n, amount: plan.late_fee, ledger_entry_id: fee });
    }
  }
  return out;
}

export async function planStatus(db, plan, today) {
  const financed = plan.total - plan.down_payment;
  const paid = -(await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE payment_plan_id = ?', plan.id)).n;
  // A schedule edited by staff, else even installments with the leftover cents on the first ones
  // (so none is ever negative or short).
  const custom = customSchedule(plan);
  const base = Math.floor(financed / plan.installments);
  const extra = financed - base * plan.installments;
  const schedule = custom
    ? custom.map((s, i) => ({ n: i + 1, due_date: s.due_date, amount: s.amount }))
    : Array.from({ length: plan.installments }, (_, i) => ({ n: i + 1, due_date: installmentDate(plan, i), amount: base + (i < extra ? 1 : 0) }));
  let cumulative = 0;
  let dueToDate = 0;
  for (const s of schedule) {
    cumulative += s.amount;
    s.paid = Math.max(0, Math.min(s.amount, paid - (cumulative - s.amount)));
    if (s.due_date <= today) dueToDate = cumulative;
  }
  const next = schedule.find((s) => s.paid < s.amount);
  const fees = await db.all('SELECT installment, amount, created_at FROM payment_plan_late_fees WHERE plan_id = ? ORDER BY installment', plan.id);
  for (const f of fees) { const s = schedule.find((x) => x.n === f.installment); if (s) s.late_fee = f.amount; }
  return {
    ...plan,
    schedule_edited: !!custom,
    late_fees_charged: fees.reduce((t, f) => t + f.amount, 0),
    financed,
    paid,
    remaining: Math.max(0, financed - paid),
    past_due: Math.max(0, dueToDate - paid),
    next_due_date: next?.due_date ?? null,
    next_due_amount: next ? next.amount - next.paid : 0,
    schedule,
  };
}

// A postal address, checked: street and city as typed (trimmed, with limits), a two-letter state, a US ZIP.
// Fields not sent are left as they are; an empty string clears one.
const ADDRESS = ['address', 'city', 'state', 'zip'];
export function cleanAddress(body) {
  const row = {};
  for (const k of ADDRESS) {
    if (!(k in body)) continue;
    const v = body[k] == null ? '' : String(body[k]).trim().replace(/\s+/g, ' ');
    row[k] = v || null;
  }
  if (!Object.keys(row).length) throw new HttpError(400, 'Send the new address (address, city, state, zip)');
  if (row.address && row.address.length > 200) throw new HttpError(400, 'address can be at most 200 characters');
  if (row.city && row.city.length > 100) throw new HttpError(400, 'city can be at most 100 characters');
  if (row.state) {
    row.state = row.state.replace(/\.$/, '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(row.state)) throw new HttpError(400, 'state must be the two-letter abbreviation (e.g. TX)');
  }
  if (row.zip && !/^\d{5}(-\d{4})?$/.test(row.zip)) throw new HttpError(400, 'zip must be 5 digits (or ZIP+4, 12345-6789)');
  return row;
}
const addressOf = (p) => Object.fromEntries(ADDRESS.map((k) => [k, p[k] ?? null]));

const RELATIONSHIPS = ['spouse', 'child', 'dependent', 'parent', 'other'];
function relationshipOf(v) {
  if (!v) return null;
  if (!RELATIONSHIPS.includes(v)) throw new HttpError(400, `relationship must be one of ${RELATIONSHIPS.join(', ')}`);
  return v;
}

export default function familyRoutes({ db }) {
  const r = Router();
  const patientOr404 = async (req, id = req.params.id) => await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
  // The guarantor is responsible for the family's bills; a patient with no guarantor is their own.
  const guarantorOf = async (p) => (p.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id) : p);

  // ---- Family file ----
  r.get('/patients/:id/family', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const g = await guarantorOf(await patientOr404(req));
    const now = await practiceNow(db, pid);
    const members = await db.all(
      `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.status, p.guarantor_id, p.medical_alerts, p.family_relationship,
        (SELECT COALESCE(SUM(amount),0) FROM ledger_entries l WHERE l.patient_id = p.id) AS balance,
        (SELECT MIN(start_time) FROM appointments a WHERE a.patient_id = p.id AND a.start_time >= ? AND a.status NOT IN ('cancelled','no_show')) AS next_appointment,
        (SELECT MIN(due_date) FROM recalls r WHERE r.patient_id = p.id AND r.status IN ('due','contacted')) AS recall_due
       FROM patients p WHERE p.practice_id = ? AND (p.id = ? OR p.guarantor_id = ?) AND p.status != 'archived'
       ORDER BY p.guarantor_id IS NOT NULL, p.dob`, now, pid, g.id, g.id,
    );
    const second = g.second_responsible_id ? await db.get('SELECT id, first_name, last_name, phone, email FROM patients WHERE id = ?', g.second_responsible_id) : null;
    res.json({
      guarantor: { id: g.id, first_name: g.first_name, last_name: g.last_name, phone: g.phone, email: g.email, address: g.address, city: g.city, state: g.state, zip: g.zip },
      second_responsible: second,
      relationships: RELATIONSHIPS,
      // patient_id so office-limited staff see only the members they may see.
      members: members.map((m) => ({ ...m, patient_id: m.id })),
      family_balance: members.reduce((s, m) => s + m.balance, 0),
    });
  });

  // Link an existing patient to this family (the guarantor of :id becomes theirs).
  r.post('/patients/:id/family', requirePermission('patients:write'), async (req, res) => {
    const g = await guarantorOf(await patientOr404(req));
    let memberId;
    if (req.body?.patient_id) {
      const member = await patientOr404(req, req.body.patient_id);
      await requireVisiblePatients(db, req.user, [member.id]);
      if (member.id === g.id) throw new HttpError(400, 'That patient is already the guarantor');
      if (await db.get('SELECT id FROM patients WHERE guarantor_id = ? LIMIT 1', member.id)) {
        throw new HttpError(409, `${member.first_name} is the guarantor of another family; move those members first`);
      }
      await update(db, 'patients', member.id, req.user.practice_id, { guarantor_id: g.id, family_relationship: relationshipOf(req.body.relationship), updated_at: new Date().toISOString() });
      memberId = member.id;
    } else {
      // New family member, inheriting the household's contact details.
      const row = pick(req.body, ['first_name', 'last_name', 'dob', 'gender', 'preferred_name']);
      requireFields(row, ['first_name']);
      memberId = await insert(db, 'patients', {
        ...row, last_name: row.last_name || g.last_name, practice_id: req.user.practice_id, guarantor_id: g.id, family_relationship: relationshipOf(req.body?.relationship),
        phone: g.phone, email: g.email, address: g.address, city: g.city, state: g.state, zip: g.zip, primary_provider_id: g.primary_provider_id,
      });
    }
    await audit(db, req, 'family.link', 'patients', memberId, { guarantor_id: g.id });
    res.status(201).json(await db.get('SELECT * FROM patients WHERE id = ?', memberId));
  });

  // ---- A new address (workflow 27, docs/workflows/specs/27-demographics.md) ----
  // Families move together: by default everyone in the household who lived at the same address moves too
  // (`household: false` changes this chart only; `members` narrows who moves). Each chart's change goes through
  // update() (before/after kept) and is audited on its own; an undo sends the old address back the same way.
  r.put('/patients/:id/address', requirePermission('patients:write'), async (req, res) => {
    const patient = await patientOr404(req);
    await requireVisiblePatients(db, req.user, [patient.id]);
    const row = cleanAddress(req.body || {});
    const was = addressOf(patient);
    const key = (a) => ADDRESS.map((k) => String(a[k] ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
    const movers = [];
    // Only a real address is shared: an empty one would drag every chart with no address along.
    if (req.body?.household !== false && was.address) {
      const head = await guarantorOf(patient);
      const family = await db.all(
        "SELECT * FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?) AND id != ? AND status != 'archived' ORDER BY id",
        req.user.practice_id, head.id, head.id, patient.id,
      );
      const only = Array.isArray(req.body?.members) ? new Set(req.body.members.map(Number)) : null;
      for (const m of family) {
        if (key(m) !== key(was) || (only && !only.has(m.id))) continue;
        if (await canSeePatient(db, req.user, m.id)) movers.push(m);
      }
    }
    const now = new Date().toISOString();
    const moved = [];
    await db.tx(async () => {
      for (const p of [patient, ...movers]) {
        const before = addressOf(p);
        const after = { ...before, ...row };
        if (key(before) === key(after)) continue;
        await update(db, 'patients', p.id, req.user.practice_id, { ...row, updated_at: now });
        await audit(db, req, 'patient.address', 'patients', p.id, { household_of: p.id === patient.id ? null : patient.id }, { before, after, patientId: p.id });
        if (p.id !== patient.id) moved.push({ id: p.id, first_name: p.first_name, last_name: p.last_name, before });
      }
    });
    res.json({ patient: await db.get('SELECT * FROM patients WHERE id = ?', patient.id), before: was, moved });
  });

  // A member's relationship to the head of household.
  r.put('/patients/:id/family/:memberId', requirePermission('patients:write'), async (req, res) => {
    const head = await guarantorOf(await patientOr404(req));
    const member = await patientOr404(req, req.params.memberId);
    if (member.guarantor_id !== head.id) throw new HttpError(400, "That patient isn't a member of this family");
    await update(db, 'patients', member.id, req.user.practice_id, { family_relationship: relationshipOf(req.body?.relationship), updated_at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // A second responsible party for the household (e.g. the other parent), from the patient records.
  r.put('/patients/:id/family-responsible', requirePermission('patients:write'), async (req, res) => {
    const head = await guarantorOf(await patientOr404(req));
    let second = null;
    if (req.body?.patient_id) {
      second = await patientOr404(req, req.body.patient_id);
      if (second.id === head.id) throw new HttpError(400, 'Choose someone other than the head of household');
    }
    await update(db, 'patients', head.id, req.user.practice_id, { second_responsible_id: second?.id ?? null, updated_at: new Date().toISOString() });
    await audit(db, req, 'family.second_responsible', 'patients', head.id, { second_responsible_id: second?.id ?? null });
    res.json({ ok: true });
  });

  // What unlinking would leave behind: the member's own balance, the household's payment plans, and
  // memberships or ortho contracts that charge the household's card for this member.
  const unlinkImpact = async (head, member) => {
    const today = (await practiceNow(db, head.practice_id)).slice(0, 10);
    const plans = [];
    for (const p of await db.all("SELECT * FROM payment_plans WHERE patient_id = ? AND status = 'active'", head.id)) {
      const s = await planStatus(db, p, today);
      plans.push({ id: p.id, remaining: s.remaining, notes: p.notes || null });
    }
    const cardCharges = [
      ...(await db.all(
        `SELECT m.id, 'membership' AS kind, mp.name AS name FROM memberships m JOIN membership_plans mp ON mp.id = m.plan_id JOIN payment_methods pm ON pm.id = m.payment_method_id
         WHERE m.patient_id = ? AND m.status IN ('active','past_due') AND pm.patient_id = ?`, member.id, head.id,
      )),
      ...(await db.all(
        `SELECT o.id, 'ortho' AS kind, 'Orthodontic contract' AS name FROM ortho_cases o JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.patient_id = ? AND o.status IN ('active','retention') AND pm.patient_id = ?`, member.id, head.id,
      )),
    ];
    const balance = (await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ?', member.id)).n;
    return { balance, plans, card_charges: cardCharges };
  };
  r.get('/patients/:id/family/:memberId/unlink', requirePermission('patients:read'), async (req, res) => {
    const head = await guarantorOf(await patientOr404(req));
    const member = await patientOr404(req, req.params.memberId);
    if (member.guarantor_id !== head.id) throw new HttpError(400, "That patient isn't a member of this family");
    res.json(await unlinkImpact(head, member));
  });

  r.delete('/patients/:id/family/:memberId', requirePermission('patients:write'), async (req, res) => {
    const head = await guarantorOf(await patientOr404(req));
    const member = await patientOr404(req, req.params.memberId);
    if (member.guarantor_id !== head.id) throw new HttpError(400, "That patient isn't a member of this family");
    const impact = await unlinkImpact(head, member);
    const needsConfirm = impact.card_charges.length || (impact.balance > 0 && impact.plans.length);
    if (needsConfirm && req.query.confirm !== '1') throw new HttpError(409, 'Unlinking affects billing — review and confirm', { impact });
    await db.tx(async () => {
      await update(db, 'patients', member.id, req.user.practice_id, { guarantor_id: null, family_relationship: null, updated_at: new Date().toISOString() });
      // The household's card stops paying for them: those charges go to the member's own account.
      for (const c of impact.card_charges) {
        if (c.kind === 'membership') await db.run('UPDATE memberships SET payment_method_id = NULL WHERE id = ?', c.id);
        else await db.run('UPDATE ortho_cases SET payment_method_id = NULL, autopay = 0 WHERE id = ?', c.id);
      }
    });
    await audit(db, req, 'family.unlink', 'patients', member.id, { card_charges_moved: impact.card_charges.length, balance: impact.balance });
    res.json({ ok: true, moved: impact.card_charges });
  });

  // Make a member the head of household (e.g. a parent takes over from a grandparent).
  r.post('/patients/:id/family/guarantor', requirePermission('patients:write'), async (req, res) => {
    const newG = await patientOr404(req);
    const oldG = await guarantorOf(newG);
    if (oldG.id === newG.id) return res.json({ ok: true });
    await db.tx(async () => {
      await db.run('UPDATE patients SET guarantor_id = ? WHERE practice_id = ? AND (guarantor_id = ? OR id = ?)', newG.id, req.user.practice_id, oldG.id, oldG.id);
      await recorded(db, 'patients', newG.id, () => db.run('UPDATE patients SET guarantor_id = NULL WHERE id = ?', newG.id));
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
    )), async (p) => await planStatus(db, p, today));
    res.json(paged(req, res, req.query.overdue === 'true' ? plans.filter((p) => p.past_due > 0) : plans));
  });

  r.get('/patients/:id/payment-plans', requirePermission('billing:read'), async (req, res) => {
    const g = await guarantorOf(await patientOr404(req));
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    res.json(await mapSeq(
      (await db.all('SELECT * FROM payment_plans WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', req.user.practice_id, g.id)),
      async (p) => await planStatus(db, p, today)
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
    const row = pick(req.body, ['status', 'notes', 'autopay_method_id', 'late_fee', 'late_fee_days']);
    requireOneOf(row.status, ['active', 'completed', 'cancelled'], 'status');
    if (row.late_fee !== undefined) row.late_fee = Math.max(0, toCents(row.late_fee || 0, 'late_fee'));
    if (row.late_fee_days !== undefined) {
      row.late_fee_days = Number(row.late_fee_days);
      if (!Number.isInteger(row.late_fee_days) || row.late_fee_days < 0 || row.late_fee_days > 90) throw new HttpError(400, 'Days before a late fee must be 0-90');
    }
    if (req.body?.schedule !== undefined) {
      // null goes back to even installments; otherwise the dated amounts must cover exactly what's financed.
      const rows = req.body.schedule === null ? null : cleanSchedule(req.body.schedule, plan.total - plan.down_payment);
      Object.assign(row, rows
        ? { schedule: JSON.stringify(rows), installments: rows.length, installment_amount: rows[0].amount, start_date: rows[0].due_date }
        : { schedule: null });
    }
    if (row.autopay_method_id) {
      const m = await findOr404(db, 'payment_methods', row.autopay_method_id, req.user.practice_id, 'Card');
      if (m.patient_id !== plan.patient_id || m.removed_at) throw new HttpError(400, "That card isn't on file for this account");
      Object.assign(row, { autopay_paused: 0, autopay_failures: 0, autopay_last_attempt: null });
    }
    await update(db, 'payment_plans', plan.id, req.user.practice_id, row);
    await audit(db, req, 'payment_plan.update', 'payment_plans', plan.id, row);
    res.json(await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', plan.id), (await practiceNow(db, req.user.practice_id)).slice(0, 10)));
  });

  return r;
}
