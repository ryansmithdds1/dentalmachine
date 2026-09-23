import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq, publicPractice } from '../util.js';
import { estimateCoverage, postClaimPayment, benefitYear, deductibleMet, reverseEntry, createClaim, checkPostingDate } from '../services.js';
import { savePolicy, validatePlan, syncPlan, PLAN_BENEFITS, DEFAULT_FREQUENCIES, planFor } from '../benefits.js';

const POLICY_FIELDS = [
  'carrier_id', 'priority', 'subscriber_name', 'subscriber_id', 'subscriber_dob', 'relationship', 'group_number',
  'annual_max', 'deductible', 'deductible_met', 'pct_preventive', 'pct_basic', 'pct_major', 'active', 'benefit_month',
  'plan_id', 'effective_date',
];

const CLAIM_SELECT = `SELECT c.*, p.first_name, p.last_name, ic.name AS carrier_name, ic.payer_id, pi.subscriber_id, pi.group_number
  FROM claims c JOIN patients p ON p.id = c.patient_id
  JOIN patient_insurance pi ON pi.id = c.patient_insurance_id
  JOIN insurance_carriers ic ON ic.id = pi.carrier_id`;

function validatePolicy(row) {
  requireOneOf(row.priority, ['primary', 'secondary'], 'priority');
  requireOneOf(row.relationship, ['self', 'spouse', 'child', 'other'], 'relationship');
  for (const k of ['pct_preventive', 'pct_basic', 'pct_major']) {
    if (row[k] != null && (row[k] < 0 || row[k] > 100)) throw new HttpError(400, `${k} must be 0-100`);
  }
  for (const k of ['annual_max', 'deductible', 'deductible_met']) {
    if (row[k] != null) row[k] = toCents(row[k], k);
  }
  if (row.benefit_month != null) {
    row.benefit_month = Number(row.benefit_month);
    if (!Number.isInteger(row.benefit_month) || row.benefit_month < 1 || row.benefit_month > 12) throw new HttpError(400, 'benefit_month must be 1-12');
  }
}

// Staff entering "deductible met" are describing the current benefit year.
async function stampDeductibleYear(db, row, policy) {
  if (row.deductible_met == null) return;
  const today = (await practiceNow(db, policy.practice_id)).slice(0, 10);
  row.deductible_year = benefitYear({ ...policy, ...row }, today).start;
}

export default function insuranceRoutes({ db }) {
  const r = Router();

  // ---- Carriers ----
  r.get('/carriers', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all('SELECT * FROM insurance_carriers WHERE practice_id = ? ORDER BY name', req.user.practice_id));
  });

  r.post('/carriers', requirePermission('billing:write'), async (req, res) => {
    const row = pick(req.body, ['name', 'payer_id', 'phone', 'address']);
    requireFields(row, ['name']);
    const id = await insert(db, 'insurance_carriers', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'carrier.create', 'insurance_carriers', id);
    res.status(201).json(await db.get('SELECT * FROM insurance_carriers WHERE id = ?', id));
  });

  r.put('/carriers/:cid', requirePermission('billing:write'), async (req, res) => {
    const existing = await findOr404(db, 'insurance_carriers', req.params.cid, req.user.practice_id, 'Carrier');
    await update(db, 'insurance_carriers', existing.id, req.user.practice_id, pick(req.body, ['name', 'payer_id', 'phone', 'address', 'active']));
    await audit(db, req, 'carrier.update', 'insurance_carriers', existing.id);
    res.json(await db.get('SELECT * FROM insurance_carriers WHERE id = ?', existing.id));
  });

  // ---- Patient policies ----
  r.get('/patients/:id/insurance', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    // deductible_met as it stands this benefit year (last year's figure reads as zero), with the plan.
    const rows = await db.all(
      `SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
       WHERE pi.patient_id = ? AND pi.practice_id = ? ORDER BY pi.active DESC, pi.priority`,
      patient.id, req.user.practice_id,
    );
    const out = [];
    for (const p of rows) {
      const plan = await planFor(db, p);
      const members = (await db.get('SELECT COUNT(*) AS n FROM patient_insurance WHERE plan_id = ? AND active = 1', plan.id)).n;
      out.push({ ...p, plan_id: plan.id, deductible_met: deductibleMet(p, today), plan: planView(plan, members) });
    }
    res.json(out);
  });

  // ---- Insurance plans (employer groups), shared by every patient enrolled ----
  const planView = (plan, members) => ({
    ...plan, members, frequencies: plan.frequencies ? JSON.parse(plan.frequencies) : DEFAULT_FREQUENCIES,
    coverage_overrides: plan.coverage_overrides ? JSON.parse(plan.coverage_overrides) : {},
  });
  r.get('/insurance-plans', requirePermission('billing:read'), async (req, res) => {
    const rows = await db.all(
      `SELECT p.*, c.name AS carrier_name, (SELECT COUNT(*) FROM patient_insurance pi WHERE pi.plan_id = p.id AND pi.active = 1) AS members
       FROM insurance_plans p JOIN insurance_carriers c ON c.id = p.carrier_id
       WHERE p.practice_id = ?${req.query.carrier_id ? ' AND p.carrier_id = ?' : ''} ORDER BY c.name, p.name, p.group_number`,
      req.user.practice_id, ...(req.query.carrier_id ? [Number(req.query.carrier_id)] : []),
    );
    res.json(rows.map((p) => planView(p, p.members)));
  });
  r.get('/insurance-plans/:pid', requirePermission('billing:read'), async (req, res) => {
    const plan = await findOr404(db, 'insurance_plans', req.params.pid, req.user.practice_id, 'Plan');
    const members = await db.all(
      `SELECT pi.id, pi.patient_id, pi.subscriber_name, pi.subscriber_id, pi.relationship, pi.priority, p.first_name, p.last_name FROM patient_insurance pi
       JOIN patients p ON p.id = pi.patient_id WHERE pi.plan_id = ? AND pi.active = 1 ORDER BY p.last_name, p.first_name`, plan.id,
    );
    res.json({ ...planView(plan, members.length), carrier_name: (await db.get('SELECT name FROM insurance_carriers WHERE id = ?', plan.carrier_id)).name, member_list: members });
  });
  const PLAN_FIELDS = ['carrier_id', 'name', 'group_number', 'notes', 'active', ...PLAN_BENEFITS];
  r.post('/insurance-plans', requirePermission('billing:write'), async (req, res) => {
    const row = validatePlan(pick(req.body, PLAN_FIELDS));
    requireFields(row, ['carrier_id']);
    await findOr404(db, 'insurance_carriers', row.carrier_id, req.user.practice_id, 'Carrier');
    if (row.fee_schedule_id) await findOr404(db, 'fee_schedules', row.fee_schedule_id, req.user.practice_id, 'Fee schedule');
    const id = await insert(db, 'insurance_plans', { frequencies: JSON.stringify(DEFAULT_FREQUENCIES), ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'insurance_plan.create', 'insurance_plans', id);
    res.status(201).json(planView(await db.get('SELECT * FROM insurance_plans WHERE id = ?', id), 0));
  });
  r.put('/insurance-plans/:pid', requirePermission('billing:write'), async (req, res) => {
    const plan = await findOr404(db, 'insurance_plans', req.params.pid, req.user.practice_id, 'Plan');
    const row = validatePlan(pick(req.body, PLAN_FIELDS.filter((f) => f !== 'carrier_id')));
    if (row.fee_schedule_id) await findOr404(db, 'fee_schedules', row.fee_schedule_id, req.user.practice_id, 'Fee schedule');
    await db.tx(async () => {
      await update(db, 'insurance_plans', plan.id, req.user.practice_id, row);
      await syncPlan(db, plan.id);
    });
    await audit(db, req, 'insurance_plan.update', 'insurance_plans', plan.id, { fields: Object.keys(row) });
    const members = (await db.get('SELECT COUNT(*) AS n FROM patient_insurance WHERE plan_id = ? AND active = 1', plan.id)).n;
    res.json(planView(await db.get('SELECT * FROM insurance_plans WHERE id = ?', plan.id), members));
  });

  r.post('/patients/:id/insurance', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, POLICY_FIELDS);
    requireFields(row, ['carrier_id', 'subscriber_name', 'subscriber_id']);
    validatePolicy(row);
    await findOr404(db, 'insurance_carriers', row.carrier_id, req.user.practice_id, 'Carrier');
    if (row.plan_id) await findOr404(db, 'insurance_plans', row.plan_id, req.user.practice_id, 'Plan');
    await stampDeductibleYear(db, row, { practice_id: req.user.practice_id });
    const id = await db.tx(() => savePolicy(db, req.user.practice_id, null, { ...row, patient_id: patient.id }));
    await audit(db, req, 'insurance.create', 'patient_insurance', id);
    res.status(201).json(await db.get('SELECT * FROM patient_insurance WHERE id = ?', id));
  });

  r.put('/insurance/:iid', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'patient_insurance', req.params.iid, req.user.practice_id, 'Policy');
    const row = pick(req.body, POLICY_FIELDS);
    validatePolicy(row);
    if (row.carrier_id) await findOr404(db, 'insurance_carriers', row.carrier_id, req.user.practice_id, 'Carrier');
    await stampDeductibleYear(db, row, existing);
    await db.tx(() => savePolicy(db, req.user.practice_id, existing.id, row));
    await audit(db, req, 'insurance.update', 'patient_insurance', existing.id);
    res.json(await db.get('SELECT * FROM patient_insurance WHERE id = ?', existing.id));
  });

  // ---- Claims ----
  r.get('/claims', requirePermission('billing:read'), async (req, res) => {
    const where = ['c.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }
    if (req.query.patient_id) {
      where.push('c.patient_id = ?');
      params.push(Number(req.query.patient_id));
    }
    res.json(await db.all(`${CLAIM_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC`, ...params));
  });

  r.get('/claims/:cid', requirePermission('billing:read'), async (req, res) => {
    const claim = await db.get(`${CLAIM_SELECT} WHERE c.id = ? AND c.practice_id = ?`, Number(req.params.cid), req.user.practice_id);
    if (!claim) throw new HttpError(404, 'Claim not found');
    claim.items = await db.all(
      `SELECT ci.*, pr.code, pr.description, pr.tooth, pr.surfaces, pr.completed_at, pv.name AS provider_name, pv.npi AS provider_npi
       FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id LEFT JOIN providers pv ON pv.id = pr.provider_id
       WHERE ci.claim_id = ?`, claim.id,
    );
    claim.patient = await db.get('SELECT * FROM patients WHERE id = ?', claim.patient_id);
    claim.practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', claim.practice_id));
    res.json(claim);
  });

  // Procedures that are completed but not yet on a (non-void) claim — for one policy when given, since
  // the same procedure goes on the primary claim and then on the secondary.
  r.get('/patients/:id/unclaimed-procedures', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const policyId = req.query.patient_insurance_id ? Number(req.query.patient_insurance_id) : null;
    res.json(await db.all(
      `SELECT pr.* FROM procedures pr WHERE pr.patient_id = ? AND pr.practice_id = ? AND pr.status = 'completed'
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = pr.id AND c.status != 'void'${policyId ? ' AND c.patient_insurance_id = ?' : ''})
       ORDER BY pr.completed_at`,
      patient.id, req.user.practice_id, ...(policyId ? [policyId] : []),
    ));
  });

  r.post('/claims', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const { patient_insurance_id, procedure_ids } = req.body || {};
    await findOr404(db, 'patient_insurance', patient_insurance_id, pid, 'Policy');
    const extra = req.body?.preauth_number ? { preauth_number: String(req.body.preauth_number).slice(0, 50) } : {};
    const id = await createClaim(db, { practiceId: pid, policyId: Number(patient_insurance_id), procedureIds: procedure_ids, userId: req.user.id, extra });
    await audit(db, req, 'claim.create', 'claims', id);
    res.status(201).json(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, id));
  });

  const transition = (from, to, extra = () => ({})) => async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (!from.includes(claim.status)) throw new HttpError(409, `Cannot ${to} a claim that is ${claim.status}`);
    const row = { status: to, ...extra(req, claim) };
    await update(db, 'claims', claim.id, req.user.practice_id, row);
    await audit(db, req, `claim.${to}`, 'claims', claim.id);
    res.json(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, claim.id));
  };

  r.post('/claims/:cid/submit', requirePermission('billing:write'), transition(['draft', 'denied'], 'submitted', () => ({ submitted_at: new Date().toISOString(), denial_reason: null })));
  r.post('/claims/:cid/deny', requirePermission('billing:write'), transition(['submitted'], 'denied', (req) => ({ denial_reason: req.body?.reason ?? null })));
  r.post('/claims/:cid/void', requirePermission('billing:write'), transition(['draft', 'denied'], 'void'));

  // Records the carrier's payment (EOB) and optionally writes off the contractual difference.
  r.post('/claims/:cid/payment', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (!['submitted', 'partially_paid'].includes(claim.status)) throw new HttpError(409, `Cannot record payment on a ${claim.status} claim`);
    const amount = toCents(req.body?.amount);
    if (amount < 0) throw new HttpError(400, 'Payment amount cannot be negative');
    const writeOff = req.body?.write_off != null ? toCents(req.body.write_off, 'write_off') : 0;
    if (writeOff < 0) throw new HttpError(400, 'write_off cannot be negative');
    // A $0 EOB is fine (e.g. everything went to the deductible), but it has to say something.
    if (amount === 0 && writeOff === 0 && req.body?.final === false) throw new HttpError(400, 'Enter a payment or write-off amount');
    const posted = -(await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE claim_id = ? AND type = 'adjustment'", claim.id)).n;
    if (claim.paid_amount + posted + amount + writeOff > claim.total_fee) {
      throw new HttpError(400, `Payment plus write-off can't exceed the $${(claim.total_fee / 100).toFixed(2)} billed (already posted: $${((claim.paid_amount + posted) / 100).toFixed(2)})`);
    }
    const final = req.body?.final !== false;
    await postClaimPayment(db, claim, {
      amount, writeOff, final, method: req.body?.method || 'check', reference: req.body?.reference ?? null,
      userId: req.user.id, date: (await practiceNow(db, req.user.practice_id)).slice(0, 10),
    });
    await audit(db, req, 'claim.payment', 'claims', claim.id, { amount, write_off: writeOff });
    res.json(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, claim.id));
  });

  // Corrected (replacement) or void claims to the payer. The original is closed here, a new claim goes out
  // with frequency 7 (replaces) or 8 (cancels) and the payer's original claim number.
  r.post('/claims/:cid/correct', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    const kind = req.body?.kind === 'void' ? 'void' : 'replace';
    if (!['submitted', 'denied'].includes(claim.status)) {
      throw new HttpError(409, ['paid', 'partially_paid'].includes(claim.status) ? 'Reopen the claim first (its payment is reversed), then correct it' : `A ${claim.status} claim can't be corrected — just edit and send it`);
    }
    const reference = String(req.body?.original_reference || claim.payer_claim_number || '').trim();
    if (!reference) throw new HttpError(400, "Enter the payer's claim number for the original claim (from the EOB or claim status)");
    const procedureIds = (await db.all('SELECT procedure_id FROM claim_items WHERE claim_id = ?', claim.id)).map((x) => x.procedure_id);
    const id = await db.tx(async () => {
      await db.run("UPDATE claims SET status = 'void', ch_status = ?, ch_message = ? WHERE id = ?", 'replaced', kind === 'void' ? 'Cancelled at the payer by a void claim' : 'Replaced by a corrected claim', claim.id);
      const newId = await createClaim(db, {
        practiceId: req.user.practice_id, policyId: claim.patient_insurance_id, procedureIds, userId: req.user.id,
        extra: { frequency_code: kind === 'void' ? '8' : '7', original_reference: reference.slice(0, 50), corrected_from_id: claim.id, preauth_number: claim.preauth_number },
      });
      // A void notice pays nothing; it only tells the payer to cancel the original.
      if (kind === 'void') await db.run('UPDATE claims SET estimated_amount = 0, write_off_estimate = 0 WHERE id = ?', newId);
      return newId;
    });
    await audit(db, req, `claim.${kind === 'void' ? 'void_at_payer' : 'corrected'}`, 'claims', id, { original: claim.id });
    res.status(201).json(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, id));
  });

  // ---- Insurance checks: one check (or EFT) posted across several claims, as on a paper EOB ----
  r.get('/insurance-checks', requirePermission('billing:read'), async (req, res) => {
    res.json((await db.all(
      `SELECT k.*, c.name AS carrier_name, u.name AS created_by_name,
         (SELECT COUNT(DISTINCT l.claim_id) FROM ledger_entries l WHERE l.insurance_check_id = k.id) AS claims
       FROM insurance_checks k LEFT JOIN insurance_carriers c ON c.id = k.carrier_id LEFT JOIN users u ON u.id = k.created_by
       WHERE k.practice_id = ? ORDER BY k.check_date DESC, k.id DESC LIMIT 100`, req.user.practice_id,
    )).map((k) => ({ ...k, provider_adjustments: k.provider_adjustments ? JSON.parse(k.provider_adjustments) : [] })));
  });

  r.post('/insurance-checks', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const carrier = b.carrier_id ? await findOr404(db, 'insurance_carriers', b.carrier_id, pid, 'Carrier') : null;
    const amount = toCents(b.amount, 'amount');
    if (amount < 0) throw new HttpError(400, 'Check amount cannot be negative');
    const date = await checkPostingDate(db, pid, b.check_date);
    const rows = Array.isArray(b.claims) ? b.claims : [];
    if (!rows.length) throw new HttpError(400, 'Choose the claims this check pays');
    const provAdj = (Array.isArray(b.provider_adjustments) ? b.provider_adjustments : []).map((a) => ({ reason: String(a.reason || 'Other').slice(0, 40), amount: toCents(a.amount) }));
    const claimsTotal = rows.reduce((s, x) => s + toCents(x.paid ?? 0), 0);
    const expected = claimsTotal - provAdj.reduce((s, a) => s + a.amount, 0);
    if (expected !== amount) throw new HttpError(400, `The claims total $${(claimsTotal / 100).toFixed(2)}${provAdj.length ? ` less $${((claimsTotal - expected) / 100).toFixed(2)} of provider adjustments` : ''}, but the check is $${(amount / 100).toFixed(2)}`);
    const checkId = await db.tx(async () => {
      const id = await insert(db, 'insurance_checks', {
        practice_id: pid, carrier_id: carrier?.id ?? null, payer_name: carrier?.name ?? b.payer_name ?? null, check_number: b.check_number ? String(b.check_number).slice(0, 50) : null,
        check_date: date, amount, method: b.method === 'eft' ? 'eft' : 'check', provider_adjustments: provAdj.length ? JSON.stringify(provAdj) : null, created_by: req.user.id,
      });
      for (const x of rows) {
        const claim = await findOr404(db, 'claims', x.claim_id, pid, 'Claim');
        if (!['submitted', 'partially_paid'].includes(claim.status)) throw new HttpError(409, `Claim #${claim.id} is ${claim.status}`);
        const paid = toCents(x.paid ?? 0);
        const writeOff = toCents(x.write_off ?? 0);
        if (paid < 0 || writeOff < 0) throw new HttpError(400, `Claim #${claim.id}: amounts can't be negative`);
        const posted = -(await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE claim_id = ? AND type = 'adjustment'", claim.id)).n;
        if (claim.paid_amount + posted + paid + writeOff > claim.total_fee) throw new HttpError(400, `Claim #${claim.id}: payment plus write-off is more than was billed`);
        const lines = Array.isArray(x.lines) ? x.lines.map((l) => ({ claim_item_id: Number(l.claim_item_id), paid: toCents(l.paid ?? 0), write_off: toCents(l.write_off ?? 0), patient_resp: l.patient_resp != null ? toCents(l.patient_resp) : undefined })) : null;
        await postClaimPayment(db, claim, {
          amount: paid, writeOff, final: x.final !== false, method: b.method === 'eft' ? 'eft' : 'check', reference: b.check_number || null,
          userId: req.user.id, date, lines, checkId: id, deductible: x.deductible != null ? toCents(x.deductible) : null,
        });
      }
      return id;
    });
    await audit(db, req, 'insurance_check.post', 'insurance_checks', checkId, { amount, claims: rows.length });
    res.status(201).json(await db.get('SELECT * FROM insurance_checks WHERE id = ?', checkId));
  });

  // Open claims to choose from when posting a check, with their procedures for line-by-line entry.
  r.get('/insurance-checks/open-claims', requirePermission('billing:read'), async (req, res) => {
    const rows = await db.all(
      `${CLAIM_SELECT} WHERE c.practice_id = ? AND c.status IN ('submitted','partially_paid')${req.query.carrier_id ? ' AND ic.id = ?' : ''} ORDER BY c.submitted_at, c.id`,
      req.user.practice_id, ...(req.query.carrier_id ? [Number(req.query.carrier_id)] : []),
    );
    for (const c of rows) {
      c.items = await db.all('SELECT ci.id, ci.fee, ci.estimated_amount, ci.write_off, pr.code, pr.tooth, pr.description FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', c.id);
    }
    res.json(rows);
  });

  // Reopens a paid claim (payment posted to the wrong claim, or the payer took it back): its insurance
  // payments and write-offs are reversed on the ledger and the claim goes back to waiting on the payer.
  r.post('/claims/:cid/reopen', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (!['paid', 'partially_paid'].includes(claim.status)) throw new HttpError(409, `Only paid claims can be reopened (this one is ${claim.status})`);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new HttpError(400, 'Give a reason for reopening');
    const date = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    await db.tx(async () => {
      if (!(await db.run("UPDATE claims SET status = 'submitted', paid_amount = 0, paid_at = NULL WHERE id = ? AND status IN ('paid','partially_paid')", claim.id)).changes) {
        throw new HttpError(409, 'The claim changed — reload and try again');
      }
      const posted = await db.all("SELECT * FROM ledger_entries WHERE claim_id = ? AND type IN ('insurance_payment','adjustment') AND voided_at IS NULL AND reverses_id IS NULL", claim.id);
      for (const e of posted) await reverseEntry(db, e, { userId: req.user.id, reason: `Claim #${claim.id} reopened: ${reason}`, date });
    });
    await audit(db, req, 'claim.reopen', 'claims', claim.id, { reason });
    res.json(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, claim.id));
  });

  // Pre-treatment estimate for arbitrary procedures (used by the treatment planner).
  r.post('/patients/:id/estimate', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const policyId = req.body?.patient_insurance_id;
    const policy = policyId
      ? await db.get('SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.id = ? AND pi.practice_id = ? AND pi.patient_id = ?', Number(policyId), req.user.practice_id, patient.id)
      : null;
    const procs = await mapSeq((req.body?.procedure_ids || []), async (id) => {
      const p = await findOr404(db, 'procedures', id, req.user.practice_id, 'Procedure');
      if (p.patient_id !== patient.id) throw new HttpError(400, `Procedure ${p.id} belongs to another patient`);
      return p;
    });
    res.json(await estimateCoverage(db, policy, procs));
  });

  return r;
}
