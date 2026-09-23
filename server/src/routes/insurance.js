import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq, publicPractice, validTooth, paged, pageArgs, recorded } from '../util.js';
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

export const CALL_OUTCOMES = {
  in_process: 'In process', paid: 'Paid — payment on the way', denied: 'Denied', need_info: 'Payer needs more information',
  not_on_file: 'No record of the claim', resubmit: 'Asked to resubmit', pending_patient: 'Waiting on the patient (COB, other coverage)', other: 'Other',
};

export default function insuranceRoutes({ db }) {
  const r = Router();

  // ---- Carriers ----
  r.get('/carriers', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all('SELECT * FROM insurance_carriers WHERE practice_id = ? ORDER BY name', req.user.practice_id));
  });

  r.post('/carriers', requirePermission('billing:write'), async (req, res) => {
    const row = pick(req.body, ['name', 'payer_id', 'phone', 'address', 'timely_filing_days']);
    if (row.timely_filing_days === '' ) row.timely_filing_days = null;
    requireFields(row, ['name']);
    const id = await insert(db, 'insurance_carriers', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'carrier.create', 'insurance_carriers', id);
    res.status(201).json(await db.get('SELECT * FROM insurance_carriers WHERE id = ?', id));
  });

  r.put('/carriers/:cid', requirePermission('billing:write'), async (req, res) => {
    const existing = await findOr404(db, 'insurance_carriers', req.params.cid, req.user.practice_id, 'Carrier');
    const changes = pick(req.body, ['name', 'payer_id', 'phone', 'address', 'active', 'timely_filing_days']);
    if (changes.timely_filing_days !== undefined) changes.timely_filing_days = Number(changes.timely_filing_days) > 0 ? Math.min(3650, Math.round(Number(changes.timely_filing_days))) : null;
    await update(db, 'insurance_carriers', existing.id, req.user.practice_id, changes);
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
    age_limits: plan.age_limits ? JSON.parse(plan.age_limits) : [],
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
    // Where the breakdown came from (the portal, a call, an AI-read document) and when, for the next person who asks.
    if (['portal', 'phone', 'fax', 'eligibility', 'ai_read'].includes(req.body.verified_source)) Object.assign(row, { verified_source: req.body.verified_source, verified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
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
    if (req.query.carrier_id) {
      where.push('ic.id = ?');
      params.push(Number(req.query.carrier_id));
    }
    // Worklist: how old each claim is (since it was sent, or created if not yet sent) and whether it needs
    // someone — rejected, denied, or no answer from the payer after 30 days. Those come first.
    // A logged call with a follow-up date quiets "no payment" until that date comes round.
    // Only claims still in play (draft, sent, part-paid, denied) can need someone, so those are worked out
    // here; paid and void claims (most of a practice's history) come straight from the database a page at a time.
    const OPEN = ['draft', 'submitted', 'partially_paid', 'denied'];
    const inList = OPEN.map(() => '?').join(',');
    const whereSql = where.join(' AND ');
    const closedOnly = !!req.query.status && !OPEN.includes(req.query.status);
    const wantClosed = req.query.status ? closedOnly : req.query.attention !== '1';
    const now = Date.now();
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const open = (c) => ['submitted', 'partially_paid'].includes(c.status);
    const worklist = (rows) => { for (const c of rows) {
      const since = c.submitted_at || c.created_at;
      c.age_days = Math.max(0, Math.floor((now - Date.parse(since.includes('T') ? since : `${since.replace(' ', 'T')}Z`)) / 86400_000));
      const outcome = CALL_OUTCOMES[c.last_call_outcome]?.toLowerCase();
      c.attention = c.ch_status === 'rejected' && c.status === 'draft' ? `Rejected: ${c.ch_message || 'see claim history'}`
        : c.status === 'denied' ? `Denied${c.denial_reason ? `: ${c.denial_reason}` : ''}`
          : open(c) && c.follow_up_date && c.follow_up_date <= today ? `Follow-up due${outcome ? ` (last call: ${outcome})` : ''}`
            : open(c) && c.follow_up_date ? null
              : open(c) && c.age_days > 30 ? `No payment after ${c.age_days} days`
                : null;
    } return rows; };
    const [min, max] = { '0-30': [0, 30], '31-60': [31, 60], '61-90': [61, 90], '90+': [91, Infinity] }[req.query.age] || [0, Infinity];
    const inAge = (c) => c.age_days >= min && c.age_days <= max;
    let out = closedOnly ? [] : worklist(await db.all(`${CLAIM_SELECT} WHERE ${whereSql} AND c.status IN (${inList}) ORDER BY c.created_at DESC, c.id DESC`, ...params, ...OPEN)).filter(inAge);
    if (req.query.attention === '1') out = out.filter((c) => c.attention);
    out.sort((a, b) => (!!b.attention - !!a.attention) || (a.attention ? b.age_days - a.age_days : 0));
    if (!wantClosed) return res.json(paged(req, res, out));
    const closedSql = `${CLAIM_SELECT} WHERE ${whereSql} AND c.status NOT IN (${inList}) ORDER BY c.created_at DESC, c.id DESC`;
    // An age filter on closed claims is rare: work those out in full.
    if (req.query.age) return res.json(paged(req, res, [...out, ...worklist(await db.all(closedSql, ...params, ...OPEN)).filter(inAge)]));
    const { limit, offset } = pageArgs(req);
    const closedCount = Number((await db.get(`SELECT COUNT(*) AS n FROM (${closedSql}) x`, ...params, ...OPEN)).n);
    const first = out.slice(offset, offset + limit);
    const more = limit - first.length;
    const closed = more > 0 ? worklist(await db.all(`${closedSql} LIMIT ? OFFSET ?`, ...params, ...OPEN, more, Math.max(0, offset - out.length))) : [];
    res.set('X-Total-Count', String(out.length + closedCount));
    res.json([...first, ...closed]);
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

  // Fix a claim before (re)sending it — after a clearinghouse rejection or a payer denial: the procedure
  // code, tooth and surfaces (corrected on the chart too), the prior-authorization number, and a note to
  // the payer. What changed is kept on the claim's history. A claim the payer already has goes back out as a
  // corrected claim (below) once edited.
  // New coverage the patient sent in from the portal, waiting for someone to enter it.
  r.get('/patients/:id/insurance-updates', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const rows = await db.all("SELECT u.*, us.name AS reviewed_by_name FROM insurance_updates u LEFT JOIN users us ON us.id = u.reviewed_by WHERE u.patient_id = ? AND u.practice_id = ? AND (u.status = 'pending' OR u.reviewed_at > ?) ORDER BY u.id DESC",
      patient.id, req.user.practice_id, new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
    res.json(rows.map((u) => ({ ...u, document_ids: JSON.parse(u.document_ids || '[]') })));
  });
  r.post('/insurance-updates/:uid/reviewed', requirePermission('billing:write'), async (req, res) => {
    const u = await findOr404(db, 'insurance_updates', req.params.uid, req.user.practice_id, 'Insurance update');
    await db.run("UPDATE insurance_updates SET status = 'reviewed', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", req.user.id, u.id);
    await audit(db, req, 'insurance_update.reviewed', 'insurance_updates', u.id);
    res.json({ ok: true });
  });

  // A phone call (or portal check) with the payer about this claim: who, reference number, what they said,
  // and when to follow up next. Kept in the claim's history.
  r.post('/claims/:cid/calls', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    const outcome = req.body?.outcome;
    requireOneOf(outcome, Object.keys(CALL_OUTCOMES), 'outcome');
    const clean = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    const call = { outcome, contact: clean(req.body.contact, 100), reference: clean(req.body.reference, 60), note: clean(req.body.note, 1000), follow_up_date: clean(req.body.follow_up_date, 10) };
    if (call.follow_up_date && !/^\d{4}-\d{2}-\d{2}$/.test(call.follow_up_date)) throw new HttpError(400, 'Follow-up date must be YYYY-MM-DD');
    const message = [CALL_OUTCOMES[outcome], call.contact && `spoke with ${call.contact}`, call.reference && `ref ${call.reference}`, call.note, call.follow_up_date && `follow up ${call.follow_up_date}`].filter(Boolean).join(' · ');
    await insert(db, 'claim_events', { practice_id: claim.practice_id, claim_id: claim.id, source: 'call', status: outcome, message: message.slice(0, 500), details: JSON.stringify(call), user_id: req.user.id });
    await db.run("UPDATE claims SET follow_up_date = ?, last_call_at = datetime('now'), last_call_outcome = ? WHERE id = ?", call.follow_up_date, outcome, claim.id);
    await audit(db, req, 'claim.call', 'claims', claim.id, { outcome });
    res.status(201).json({ ...call, message });
  });

  r.put('/claims/:cid', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (!['draft', 'denied'].includes(claim.status)) {
      throw new HttpError(409, claim.status === 'submitted' ? 'This claim is with the payer — send a corrected claim instead' : `A ${claim.status} claim can't be edited${['paid', 'partially_paid'].includes(claim.status) ? ' — reopen it first' : ''}`);
    }
    const b = req.body || {};
    const changes = [];
    const claimRow = {};
    for (const [key, label, max] of [['remarks', 'Note to payer', 80], ['preauth_number', 'Prior authorization #', 50]]) {
      if (b[key] === undefined) continue;
      const v = String(b[key] || '').trim().slice(0, max) || null;
      if (v !== (claim[key] || null)) { claimRow[key] = v; changes.push({ field: label, from: claim[key] || null, to: v }); }
    }
    const items = await db.all('SELECT ci.id, ci.procedure_id, pr.code, pr.tooth, pr.surfaces FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', claim.id);
    const procUpdates = [];
    for (const it of Array.isArray(b.items) ? b.items : []) {
      const line = items.find((x) => x.id === Number(it.claim_item_id));
      if (!line) throw new HttpError(400, `Line ${it.claim_item_id} isn't on this claim`);
      const row = {};
      if (it.code !== undefined && String(it.code).trim().toUpperCase() !== line.code) {
        const code = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', req.user.practice_id, String(it.code).trim().toUpperCase());
        if (!code) throw new HttpError(400, `Unknown procedure code ${it.code}`);
        Object.assign(row, { code_id: code.id, code: code.code, description: code.description, category: code.category });
      }
      if (it.tooth !== undefined) {
        const t = String(it.tooth || '').trim().toUpperCase() || null;
        if (t && !validTooth(t)) throw new HttpError(400, `Line ${line.code}: tooth must be 1-32 or A-T`);
        if (t !== (line.tooth || null)) row.tooth = t;
      }
      if (it.surfaces !== undefined) {
        const s = String(it.surfaces || '').toUpperCase().replace(/[^MODBLIF]/g, '') || null;
        if (s !== (line.surfaces || null)) row.surfaces = s;
      }
      if (!Object.keys(row).length) continue;
      procUpdates.push([line, row]);
      const name = `${line.code}${line.tooth ? ` #${line.tooth}` : ''}`;
      if (row.code) changes.push({ field: `${name} code`, from: line.code, to: row.code });
      if ('tooth' in row) changes.push({ field: `${name} tooth`, from: line.tooth || null, to: row.tooth });
      if ('surfaces' in row) changes.push({ field: `${name} surfaces`, from: line.surfaces || null, to: row.surfaces });
    }
    if (!changes.length) throw new HttpError(400, 'Nothing changed');
    await db.tx(async () => {
      if (Object.keys(claimRow).length) await update(db, 'claims', claim.id, req.user.practice_id, claimRow);
      for (const [line, row] of procUpdates) {
        await recorded(db, 'procedures', line.procedure_id, () => db.run(`UPDATE procedures SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), line.procedure_id));
      }
      // A different code can change what insurance covers: re-estimate this claim's lines.
      if (procUpdates.some(([, row]) => row.code)) {
        const policy = await db.get('SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.id = ?', claim.patient_insurance_id);
        if (policy.priority !== 'secondary') {
          const procs = await db.all(`SELECT * FROM procedures WHERE id IN (${items.map(() => '?').join(',')})`, ...items.map((i) => i.procedure_id));
          const est = await estimateCoverage(db, policy, procs);
          for (const e of est.items) await db.run('UPDATE claim_items SET estimated_amount = ?, write_off = ? WHERE claim_id = ? AND procedure_id = ?', e.insurance, e.write_off, claim.id, e.procedure_id);
          await recorded(db, 'claims', claim.id, () => db.run('UPDATE claims SET estimated_amount = ?, deductible_applied = ?, write_off_estimate = ? WHERE id = ?', est.total_insurance, est.total_deductible, est.total_write_off, claim.id));
        }
      }
      const summary = changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ');
      await insert(db, 'claim_events', { practice_id: claim.practice_id, claim_id: claim.id, source: 'edit', status: claim.ch_status || claim.status, message: `Edited — ${summary}`.slice(0, 500), details: JSON.stringify(changes), user_id: req.user.id });
    });
    await audit(db, req, 'claim.edit', 'claims', claim.id, { changes });
    res.json({ ...(await db.get(`${CLAIM_SELECT} WHERE c.id = ?`, claim.id)), changes });
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
      await recorded(db, 'claims', claim.id, () => db.run("UPDATE claims SET status = 'void', ch_status = ?, ch_message = ? WHERE id = ?", 'replaced', kind === 'void' ? 'Cancelled at the payer by a void claim' : 'Replaced by a corrected claim', claim.id));
      const newId = await createClaim(db, {
        practiceId: req.user.practice_id, policyId: claim.patient_insurance_id, procedureIds, userId: req.user.id,
        extra: { frequency_code: kind === 'void' ? '8' : '7', original_reference: reference.slice(0, 50), corrected_from_id: claim.id, preauth_number: claim.preauth_number, remarks: claim.remarks },
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
    // The same check (payer, number and amount) posted a second time is almost always a mistake.
    if (b.check_number && !b.confirm_duplicate) {
      const dup = await db.get('SELECT id, check_date FROM insurance_checks WHERE practice_id = ? AND check_number = ? AND amount = ? AND COALESCE(carrier_id, 0) = ?', pid, String(b.check_number).slice(0, 50), amount, carrier?.id ?? 0);
      if (dup) throw new HttpError(409, `Check ${b.check_number} for $${(amount / 100).toFixed(2)} was already posted on ${dup.check_date}. Post it again only if the payer really sent it twice.`, { duplicate_of: dup.id });
    }
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
      if (!(await recorded(db, 'claims', claim.id, () => db.run("UPDATE claims SET status = 'submitted', paid_amount = 0, paid_at = NULL WHERE id = ? AND status IN ('paid','partially_paid')", claim.id))).changes) {
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
