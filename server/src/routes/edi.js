import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, update, practiceNow } from '../util.js';
import { build837D, build270, parse271, parse835, CARC } from '../x12.js';
import { postClaimPayment, benefitsUsed } from '../services.js';

// Electronic claims (837D), eligibility (270/271) and remittance (835) through a clearinghouse.
// EDI_MODE=manual (default): files are generated for upload to the clearinghouse portal and responses are imported.
// EDI_MODE=sandbox: eligibility returns a simulated 271 built from the policy on file, for demos and training.
export default function ediRoutes({ db, config }) {
  const r = Router();
  const ids = (practice) => ({
    senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`,
    receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
  });
  const nextControl = () => (Date.now() % 1_000_000_000) || 1;

  function claimBundle(claimId, practiceId) {
    const claim = findOr404(db, 'claims', claimId, practiceId, 'Claim');
    if (!claim.control_number) {
      claim.control_number = `DM${claim.id}`;
      db.run('UPDATE claims SET control_number = ? WHERE id = ?', claim.control_number, claim.id);
    }
    const policy = db.get('SELECT * FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
    return {
      claim, policy,
      patient: db.get('SELECT * FROM patients WHERE id = ?', claim.patient_id),
      carrier: db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id),
      items: db.all(
        `SELECT ci.fee, pr.code, pr.tooth, pr.surfaces, pr.completed_at, pv.name AS provider_name, pv.npi AS provider_npi
         FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id LEFT JOIN providers pv ON pv.id = pr.provider_id WHERE ci.claim_id = ?`, claim.id,
      ),
    };
  }

  // Pre-flight checks clearinghouses reject on.
  function claimProblems(bundle, practice) {
    const p = [];
    if (!/^\d{10}$/.test(String(practice.npi || ''))) p.push('Practice NPI missing (Settings → Practice)');
    if (!String(practice.tax_id || '').replace(/\D/g, '')) p.push('Practice tax ID missing');
    if (!practice.address || !practice.zip) p.push('Practice address incomplete');
    if (!bundle.carrier.payer_id) p.push(`Payer ID missing for ${bundle.carrier.name}`);
    if (!bundle.patient.dob) p.push('Patient date of birth missing');
    if (!bundle.items.length) p.push('Claim has no procedures');
    if (bundle.items.some((i) => !i.provider_npi)) p.push('Treating provider NPI missing');
    return p;
  }

  r.get('/claims/:cid/validate', requirePermission('billing:read'), (req, res) => {
    const practice = db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ problems: claimProblems(claimBundle(req.params.cid, req.user.practice_id), practice) });
  });

  // One or more claims as a single 837D batch file. mark_submitted moves drafts to submitted.
  r.post('/claims/837', requirePermission('billing:write'), (req, res) => {
    const pid = req.user.practice_id;
    const practice = db.get('SELECT * FROM practices WHERE id = ?', pid);
    const claimIds = (req.body?.claim_ids || []).map(Number);
    if (!claimIds.length) throw new HttpError(400, 'claim_ids is required');
    const bundles = claimIds.map((id) => claimBundle(id, pid));
    for (const b of bundles) {
      if (['void', 'paid'].includes(b.claim.status)) throw new HttpError(409, `Claim #${b.claim.id} is ${b.claim.status}`);
      const problems = claimProblems(b, practice);
      if (problems.length && !req.body?.force) throw new HttpError(422, `Claim #${b.claim.id}: ${problems.join('; ')}`, { claim_id: b.claim.id, problems });
    }
    const file = build837D({ practice, claims: bundles, ...ids(practice), control: nextControl(), taxonomy: practice.billing_provider_taxonomy });
    if (req.body?.mark_submitted !== false) {
      for (const b of bundles) {
        if (['draft', 'denied'].includes(b.claim.status)) db.run("UPDATE claims SET status = 'submitted', submitted_at = datetime('now'), denial_reason = NULL WHERE id = ?", b.claim.id);
      }
    }
    audit(db, req, 'claims.export_837', 'claims', claimIds[0], { claim_ids: claimIds });
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="claims-${practiceNow(db, pid).slice(0, 10)}.837"` });
    res.send(file);
  });

  // ---- Eligibility ----
  function sandbox271(policy, patient, trace) {
    const used = benefitsUsed(db, policy);
    const pct = (v) => (1 - v / 100).toFixed(2);
    return [
      'ISA*00*          *00*          *ZZ*SANDBOX        *ZZ*DENTALMACHINE  *000101*0000*^*00501*000000001*0*T*:',
      'GS*HB*SANDBOX*DENTALMACHINE*20000101*0000*1*X*005010X279A1', 'ST*271*0001*005010X279A1', `BHT*0022*11*${trace}*20000101*0000`,
      'HL*1**20*1', 'NM1*PR*2*SANDBOX PAYER*****PI*00000', 'HL*2*1*21*1', 'NM1*1P*2*PROVIDER', 'HL*3*2*22*0',
      `NM1*IL*1*${patient.last_name.toUpperCase()}*${patient.first_name.toUpperCase()}****MI*${policy.subscriber_id}`,
      `DTP*346*D8*${new Date().getUTCFullYear()}0101`,
      'EB*1*IND*35**DENTAL PPO',
      `EB*C*IND*35***23*${(policy.deductible / 100).toFixed(2)}`,
      `EB*C*IND*35***29*${(Math.max(0, policy.deductible - policy.deductible_met) / 100).toFixed(2)}`,
      `EB*F*IND*35***23*${(policy.annual_max / 100).toFixed(2)}`,
      `EB*F*IND*35***29*${(Math.max(0, policy.annual_max - used) / 100).toFixed(2)}`,
      `EB*A*IND*23^41*****${pct(policy.pct_preventive)}`,
      `EB*A*IND*25^26^24^40*****${pct(policy.pct_basic)}`,
      `EB*A*IND*36^39*****${pct(policy.pct_major)}`,
      'MSG*SANDBOX RESPONSE - NOT FROM A REAL PAYER', 'SE*20*0001', 'GE*1*1', 'IEA*1*000000001',
    ].join('~') + '~';
  }

  const eligView = (row) => ({ ...row, summary: row.summary ? JSON.parse(row.summary) : null });

  r.get('/patients/:id/eligibility', requirePermission('billing:read'), (req, res) => {
    const patient = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(db.all(
      `SELECT e.id, e.patient_insurance_id, e.status, e.summary, e.created_at, c.name AS carrier_name, u.name AS created_by_name
       FROM eligibility_checks e JOIN patient_insurance pi ON pi.id = e.patient_insurance_id JOIN insurance_carriers c ON c.id = pi.carrier_id
       LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ? AND e.patient_id = ? ORDER BY e.id DESC LIMIT 20`,
      req.user.practice_id, patient.id,
    ).map(eligView));
  });

  r.post('/insurance/:iid/eligibility', requirePermission('billing:read'), (req, res) => {
    const pid = req.user.practice_id;
    const policy = findOr404(db, 'patient_insurance', req.params.iid, pid, 'Policy');
    const patient = db.get('SELECT * FROM patients WHERE id = ?', policy.patient_id);
    const carrier = db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
    const practice = db.get('SELECT * FROM practices WHERE id = ?', pid);
    const trace = `EL${Date.now()}`;
    const request = build270({ practice, patient, policy, carrier, ...ids(practice), control: nextControl(), trace });
    let row = { practice_id: pid, patient_id: patient.id, patient_insurance_id: policy.id, request_x12: request, created_by: req.user.id, status: 'pending' };
    if (config.ediMode === 'sandbox') {
      const response = sandbox271(policy, patient, trace);
      const summary = parse271(response);
      row = { ...row, response_x12: response, summary: JSON.stringify({ ...summary, sandbox: true }), status: summary.active ? 'active' : 'inactive' };
    }
    const id = insert(db, 'eligibility_checks', row);
    audit(db, req, 'eligibility.check', 'eligibility_checks', id, { mode: config.ediMode });
    res.status(201).json({ ...eligView(db.get('SELECT id, patient_insurance_id, status, summary, created_at FROM eligibility_checks WHERE id = ?', id)), mode: config.ediMode });
  });

  r.get('/eligibility/:eid/270', requirePermission('billing:read'), (req, res) => {
    const e = findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="eligibility-${e.id}.270"` }).send(e.request_x12);
  });

  // Import the payer's 271 (from the clearinghouse portal) for a pending check.
  r.post('/eligibility/:eid/response', requirePermission('billing:write'), express.text({ type: () => true, limit: '2mb' }), (req, res) => {
    const e = findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    let summary;
    try {
      summary = parse271(req.body);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    update(db, 'eligibility_checks', e.id, req.user.practice_id, {
      response_x12: req.body, summary: JSON.stringify(summary), status: summary.errors.length ? 'error' : summary.active ? 'active' : 'inactive',
    });
    audit(db, req, 'eligibility.response', 'eligibility_checks', e.id);
    res.json(eligView(db.get('SELECT id, patient_insurance_id, status, summary, created_at FROM eligibility_checks WHERE id = ?', e.id)));
  });

  // Copy verified benefits onto the policy so treatment estimates use them.
  r.post('/eligibility/:eid/apply', requirePermission('billing:write'), (req, res) => {
    const e = findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    const s = e.summary && JSON.parse(e.summary);
    if (!s) throw new HttpError(409, 'No response to apply yet');
    const row = {};
    if (s.annual_max != null) row.annual_max = s.annual_max;
    if (s.deductible != null) row.deductible = s.deductible;
    if (s.deductible != null && s.deductible_remaining != null) row.deductible_met = Math.max(0, s.deductible - s.deductible_remaining);
    for (const tier of ['preventive', 'basic', 'major']) if (s.coinsurance?.[tier] != null) row[`pct_${tier}`] = s.coinsurance[tier];
    update(db, 'patient_insurance', e.patient_insurance_id, req.user.practice_id, row);
    audit(db, req, 'eligibility.apply', 'patient_insurance', e.patient_insurance_id, { fields: Object.keys(row) });
    res.json(db.get('SELECT * FROM patient_insurance WHERE id = ?', e.patient_insurance_id));
  });

  // ---- ERA / 835 auto-posting ----
  r.get('/era', requirePermission('billing:read'), (req, res) => {
    res.json(db.all(
      `SELECT e.id, e.filename, e.payer_name, e.check_number, e.payment_date, e.total_paid, e.claims_matched, e.claims_unmatched, e.details, e.created_at, u.name AS created_by_name
       FROM era_imports e LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ? ORDER BY e.id DESC LIMIT 100`, req.user.practice_id,
    ).map((e) => ({ ...e, details: JSON.parse(e.details || '[]') })));
  });

  r.post('/era/import', requirePermission('billing:write'), express.text({ type: () => true, limit: '10mb' }), (req, res) => {
    const pid = req.user.practice_id;
    let era;
    try {
      era = parse835(req.body);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (era.check_number && db.get('SELECT id FROM era_imports WHERE practice_id = ? AND check_number = ? AND total_paid = ?', pid, era.check_number, era.total_paid)) {
      throw new HttpError(409, `ERA for check/EFT ${era.check_number} was already imported`);
    }
    const date = era.payment_date || practiceNow(db, pid).slice(0, 10);
    const details = db.tx(() => era.claims.map((c) => {
      const idMatch = /^DM(\d+)$/i.exec(c.control_number || '');
      const claim = db.get('SELECT * FROM claims WHERE practice_id = ? AND (control_number = ? OR id = ?)', pid, c.control_number, idMatch ? Number(idMatch[1]) : -1);
      const base = { control_number: c.control_number, billed: c.billed, paid: c.paid, patient_responsibility: c.patient_responsibility, write_off: c.contractual, reasons: c.reason_codes.map((code) => ({ code, text: CARC[code.split('-')[1]] || null })) };
      if (!claim) return { ...base, result: 'unmatched' };
      if (c.status === 'reversal' || c.status === 'not_our_claim') return { ...base, claim_id: claim.id, result: 'needs_review' };
      if (!['submitted', 'partially_paid'].includes(claim.status)) return { ...base, claim_id: claim.id, result: `skipped (claim is ${claim.status})` };
      if (c.status === 'denied' || (c.paid === 0 && c.status_code === '4')) {
        const reason = base.reasons.map((x) => `${x.code}${x.text ? ` ${x.text}` : ''}`).join(', ') || 'Denied by payer';
        db.run("UPDATE claims SET status = 'denied', denial_reason = ?, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ?", reason, c.payer_claim_number, claim.id);
        return { ...base, claim_id: claim.id, result: 'denied' };
      }
      postClaimPayment(db, claim, {
        amount: c.paid, writeOff: c.contractual, final: true, method: 'eft', reference: era.check_number, userId: req.user.id, date, payerClaimNumber: c.payer_claim_number,
      });
      return { ...base, claim_id: claim.id, result: 'posted' };
    }));
    const matched = details.filter((d) => d.result === 'posted' || d.result === 'denied').length;
    const id = insert(db, 'era_imports', {
      practice_id: pid, filename: req.query.filename ? String(req.query.filename).slice(0, 200) : null, payer_name: era.payer_name, check_number: era.check_number,
      payment_date: era.payment_date, total_paid: era.total_paid, claims_matched: matched, claims_unmatched: details.length - matched,
      details: JSON.stringify(details), raw: req.body, created_by: req.user.id,
    });
    audit(db, req, 'era.import', 'era_imports', id, { matched, total: details.length });
    res.status(201).json({ id, payer_name: era.payer_name, check_number: era.check_number, payment_date: era.payment_date, total_paid: era.total_paid, claims: details });
  });

  return r;
}
