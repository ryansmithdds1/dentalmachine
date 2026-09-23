import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq, publicPractice } from '../util.js';
import { estimateCoverage, postClaimPayment } from '../services.js';

const POLICY_FIELDS = [
  'carrier_id', 'priority', 'subscriber_name', 'subscriber_id', 'subscriber_dob', 'relationship', 'group_number',
  'annual_max', 'deductible', 'deductible_met', 'pct_preventive', 'pct_basic', 'pct_major', 'active',
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
    res.json(await db.all(
      `SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
       WHERE pi.patient_id = ? AND pi.practice_id = ? ORDER BY pi.active DESC, pi.priority`,
      patient.id, req.user.practice_id,
    ));
  });

  r.post('/patients/:id/insurance', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, POLICY_FIELDS);
    requireFields(row, ['carrier_id', 'subscriber_name', 'subscriber_id']);
    validatePolicy(row);
    await findOr404(db, 'insurance_carriers', row.carrier_id, req.user.practice_id, 'Carrier');
    const id = await insert(db, 'patient_insurance', { ...row, patient_id: patient.id, practice_id: req.user.practice_id });
    await audit(db, req, 'insurance.create', 'patient_insurance', id);
    res.status(201).json(await db.get('SELECT * FROM patient_insurance WHERE id = ?', id));
  });

  r.put('/insurance/:iid', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'patient_insurance', req.params.iid, req.user.practice_id, 'Policy');
    const row = pick(req.body, POLICY_FIELDS);
    validatePolicy(row);
    if (row.carrier_id) await findOr404(db, 'insurance_carriers', row.carrier_id, req.user.practice_id, 'Carrier');
    await update(db, 'patient_insurance', existing.id, req.user.practice_id, row);
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

  // Procedures that are completed but not yet on a (non-void) claim.
  r.get('/patients/:id/unclaimed-procedures', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      `SELECT pr.* FROM procedures pr WHERE pr.patient_id = ? AND pr.practice_id = ? AND pr.status = 'completed'
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = pr.id AND c.status != 'void')
       ORDER BY pr.completed_at`,
      patient.id, req.user.practice_id,
    ));
  });

  r.post('/claims', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const { patient_insurance_id, procedure_ids } = req.body || {};
    const policy = await findOr404(db, 'patient_insurance', patient_insurance_id, pid, 'Policy');
    if (!Array.isArray(procedure_ids) || !procedure_ids.length) throw new HttpError(400, 'procedure_ids is required');
    const procs = await mapSeq(procedure_ids, async (id) => {
      const p = await findOr404(db, 'procedures', id, pid, 'Procedure');
      if (p.patient_id !== policy.patient_id) throw new HttpError(400, `Procedure ${p.id} belongs to another patient`);
      if (p.status !== 'completed') throw new HttpError(400, `Procedure ${p.id} is not completed`);
      const onClaim = await db.get("SELECT c.id FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = ? AND c.status != 'void'", p.id);
      if (onClaim) throw new HttpError(409, `Procedure ${p.id} is already on claim ${onClaim.id}`);
      return p;
    });
    const carrier = await db.get('SELECT name FROM insurance_carriers WHERE id = ?', policy.carrier_id);
    const est = await estimateCoverage(db, { ...policy, carrier_name: carrier.name }, procs);
    const id = await db.tx(async () => {
      const claimId = await insert(db, 'claims', {
        practice_id: pid, patient_id: policy.patient_id, patient_insurance_id: policy.id,
        total_fee: est.total_fee, estimated_amount: est.total_insurance, deductible_applied: est.total_deductible, write_off_estimate: est.total_write_off,
      });
      await mapSeq(est.items, async (item) => await insert(db, 'claim_items', {
        claim_id: claimId, procedure_id: item.procedure_id, fee: item.fee, estimated_amount: item.insurance, write_off: item.write_off,
      }));
      return claimId;
    });
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
    if (amount <= 0) throw new HttpError(400, 'Payment amount must be positive');
    const writeOff = req.body?.write_off != null ? toCents(req.body.write_off, 'write_off') : 0;
    if (writeOff < 0) throw new HttpError(400, 'write_off cannot be negative');
    const final = req.body?.final !== false;
    await postClaimPayment(db, claim, {
      amount, writeOff, final, method: req.body?.method || 'check', reference: req.body?.reference ?? null,
      userId: req.user.id, date: (await practiceNow(db, req.user.practice_id)).slice(0, 10),
    });
    await audit(db, req, 'claim.payment', 'claims', claim.id, { amount, write_off: writeOff });
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
