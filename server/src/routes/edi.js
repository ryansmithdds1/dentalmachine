import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, update, practiceNow, mapSeq } from '../util.js';
import { build837D, build270, build276, parse271, parse277, sandbox277, x12Type } from '../x12.js';
import { pollClearinghouse, processInbound } from '../clearinghouse.js';
import { claimEvent } from '../era.js';
import { runExclusive } from '../cluster.js';
import { benefitsUsed } from '../services.js';
import { importEra, parseControl } from '../era.js';

// Electronic claims (837D), eligibility (270/271) and remittance (835) through a clearinghouse.
// EDI_MODE=manual (default): files are generated for upload to the clearinghouse portal and responses are imported.
// EDI_MODE=sandbox: eligibility returns a simulated 271 built from the policy on file, for demos and training.
export default function ediRoutes({ db, config, clearinghouse: ch }) {
  const r = Router();
  const ids = (practice) => ({
    senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`,
    receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
  });
  const nextControl = () => (Date.now() % 1_000_000_000) || 1;

  async function claimBundle(claimId, practiceId) {
    const claim = await findOr404(db, 'claims', claimId, practiceId, 'Claim');
    if (!claim.control_number) {
      claim.control_number = `DM${claim.id}`;
      await db.run('UPDATE claims SET control_number = ? WHERE id = ?', claim.control_number, claim.id);
    }
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
    return {
      claim, policy,
      patient: await db.get('SELECT * FROM patients WHERE id = ?', claim.patient_id),
      carrier: await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id),
      items: await db.all(
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

  r.get('/claims/:cid/validate', requirePermission('billing:read'), async (req, res) => {
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ problems: claimProblems(await claimBundle(req.params.cid, req.user.practice_id), practice) });
  });

  // Builds a validated 837D batch for the given claims.
  async function batchFile(req, { control = nextControl(), controlFor = null } = {}) {
    const pid = req.user.practice_id;
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const claimIds = [...new Set((req.body?.claim_ids || []).map(Number))];
    if (!claimIds.length) throw new HttpError(400, 'claim_ids is required');
    const bundles = await mapSeq(claimIds, (id) => claimBundle(id, pid));
    for (const b of bundles) {
      if (['void', 'paid'].includes(b.claim.status)) throw new HttpError(409, `Claim #${b.claim.id} is ${b.claim.status}`);
      // Resending a claim the payer already has causes duplicate-claim denials; it must be deliberate.
      if (['submitted', 'partially_paid'].includes(b.claim.status) && !req.body?.resend) {
        throw new HttpError(409, `Claim #${b.claim.id} was already sent — check its status first, or choose "resend"`, { claim_id: b.claim.id, already_sent: true });
      }
      const problems = claimProblems(b, practice);
      if (problems.length && !req.body?.force) throw new HttpError(422, `Claim #${b.claim.id}: ${problems.join('; ')}`, { claim_id: b.claim.id, problems });
    }
    if (controlFor) for (const b of bundles) b.claim.control_number = controlFor(b.claim);
    return { practice, bundles, claimIds, control, file: build837D({ practice, claims: bundles, ...ids(practice), control, taxonomy: practice.billing_provider_taxonomy }) };
  }

  // Send claims straight to the clearinghouse (SFTP or sandbox). Responses arrive by polling.
  r.post('/claims/submit', requirePermission('billing:write'), async (req, res) => {
    if (!ch?.batch) throw new HttpError(409, 'No clearinghouse connection is set up — download the 837 file instead', { mode: ch?.mode || 'manual' });
    // The batch row comes first: its id goes into each claim's control number (DM<claim>B<batch>),
    // so responses to this submission can be told apart from earlier ones.
    const control = nextControl();
    const batchId = await insert(db, 'edi_batches', {
      practice_id: req.user.practice_id, control: String(control), claim_ids: '[]', status: 'sending', transport: ch.batch.transport, created_by: req.user.id,
    });
    let built;
    try {
      built = await batchFile(req, { control, controlFor: (claim) => `DM${claim.id}B${batchId}` });
    } catch (err) {
      await db.run('DELETE FROM edi_batches WHERE id = ?', batchId);
      throw err;
    }
    const { claimIds, file, bundles } = built;
    // Take each claim for this batch atomically, so two people sending at once can't both submit it.
    const taken = [];
    const release = async () => {
      for (const b of taken) await db.run('UPDATE claims SET batch_id = ? WHERE id = ? AND batch_id = ?', b.claim.batch_id ?? null, b.claim.id, batchId);
      await db.run('DELETE FROM edi_batches WHERE id = ?', batchId);
    };
    for (const b of bundles) {
      const prev = b.claim.batch_id;
      const got = await db.run(`UPDATE claims SET batch_id = ? WHERE id = ? AND ${prev ? 'batch_id = ?' : 'batch_id IS NULL'}`, batchId, b.claim.id, ...(prev ? [prev] : []));
      if (!got.changes) {
        await release();
        throw new HttpError(409, `Claim #${b.claim.id} is being sent by someone else right now`);
      }
      taken.push(b);
    }
    const filename = `DM${req.user.practice_id}_${control}.837`;
    try {
      await ch.batch.submit({ filename, content: file }); // network I/O stays outside transactions
    } catch (err) {
      await release();
      throw new HttpError(502, `Couldn't reach the clearinghouse: ${err.message}. Nothing was sent; try again.`);
    }
    await db.run("UPDATE edi_batches SET status = 'sent', filename = ?, claim_ids = ?, x12 = ? WHERE id = ?", filename, JSON.stringify(claimIds), file, batchId);
    for (const b of bundles) {
      await db.run("UPDATE claims SET status = CASE WHEN status IN ('draft','denied') THEN 'submitted' ELSE status END, submitted_at = COALESCE(submitted_at, datetime('now')), denial_reason = NULL, batch_id = ?, control_number = ? WHERE id = ?", batchId, b.claim.control_number, b.claim.id);
      await claimEvent(db, { ...b.claim }, 'submit', 'sent', `Sent to ${ch.name} in batch ${control}`);
    }
    await audit(db, req, 'claims.submit', 'edi_batches', batchId, { claim_ids: claimIds, transport: ch.batch.transport });
    // The sandbox answers at once, so pick its acknowledgments up straight away.
    const responses = ch.batch.transport === 'sandbox' ? await runExclusive('clearinghouse-poll', 60_000, () => pollClearinghouse(db, ch)) : null;
    res.status(201).json({ batch_id: batchId, control: String(control), claims: claimIds.length, filename, transport: ch.batch.transport, responses });
  });

  // Connection overview for the billing screen.
  r.get('/clearinghouse', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    res.json({
      mode: ch?.mode || 'manual', name: ch?.name, batch: !!ch?.batch, realtime: !!ch?.realtime || ch?.mode === 'sandbox', poll_minutes: ch?.pollMinutes,
      batches: await db.all(`SELECT b.id, b.control, b.filename, b.claim_ids, b.status, b.message, b.transport, b.acknowledged_at, b.created_at, u.name AS created_by_name
        FROM edi_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.practice_id = ? ORDER BY b.id DESC LIMIT 20`, pid),
      inbox: await db.all('SELECT id, name, type, result, error, created_at FROM edi_inbox WHERE practice_id = ? ORDER BY id DESC LIMIT 30', pid),
      needs_attention: await db.all(`SELECT c.id, c.ch_status, c.ch_message, c.ch_updated_at, p.first_name, p.last_name FROM claims c JOIN patients p ON p.id = c.patient_id
        WHERE c.practice_id = ? AND c.ch_status = 'rejected' AND c.status = 'draft' ORDER BY c.ch_updated_at DESC`, pid),
    });
  });

  // Check the clearinghouse mailbox now (it is also checked automatically every few minutes).
  r.post('/clearinghouse/poll', requirePermission('billing:write'), async (req, res) => {
    if (!ch?.batch) throw new HttpError(409, 'No clearinghouse connection is set up');
    let results;
    try {
      results = await runExclusive('clearinghouse-poll', 5 * 60_000, () => pollClearinghouse(db, ch));
    } catch (err) {
      throw new HttpError(502, `Couldn't reach the clearinghouse: ${err.message}`);
    }
    const mine = (results || []).filter((r2) => r2.practice_id === req.user.practice_id);
    await audit(db, req, 'clearinghouse.poll', null, null, { files: mine.length });
    res.json({ files: mine.map(({ name, type, result, error }) => ({ name, type, result, error })), busy: results === null });
  });

  // Upload a response file by hand (999, 277CA, 277 or 835) — for practices on manual mode.
  r.post('/clearinghouse/responses', requirePermission('billing:write'), express.text({ type: () => true, limit: '10mb' }), async (req, res) => {
    // Scoped to this practice: nothing in the file can touch another practice's claims or batches.
    const out = await processInbound(db, { name: String(req.query.filename || 'upload').slice(0, 200), content: String(req.body || '') }, { practiceId: req.user.practice_id });
    if (out.retry) throw new HttpError(503, `Couldn't process the file right now (${out.error}) — try again`);
    await audit(db, req, 'clearinghouse.upload', null, null, { type: out.type });
    res.status(201).json(out);
  });

  // Where a claim is in the payer's system: 276 → 277 in real time (or sandbox, or a 276 file to upload).
  r.post('/claims/:cid/status-check', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const bundle = await claimBundle(req.params.cid, pid);
    if (!['submitted', 'partially_paid', 'paid', 'denied'].includes(bundle.claim.status)) throw new HttpError(409, 'Send the claim before checking its status');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const request = build276({ practice, bundle, ...ids(practice), control: nextControl(), trace: `CS${bundle.claim.id}T${Date.now()}` });
    let response;
    if (ch?.realtime) response = await ch.realtime.claimStatus(request);
    else if (ch?.mode === 'sandbox') {
      const c = bundle.claim;
      const [category, code] = c.status === 'paid' || c.status === 'partially_paid' ? ['F1', '65'] : c.status === 'denied' ? ['F2', '88'] : ['P1', '20'];
      response = sandbox277({ ca: false, claims: [{ control_number: c.control_number, last_name: bundle.patient.last_name, first_name: bundle.patient.first_name, category, code, billed: c.total_fee, paid: c.paid_amount, payer_claim_number: c.payer_claim_number || `SBX${String(c.id).padStart(8, '0')}` }] });
    } else {
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="claim-status-${bundle.claim.id}.276"` });
      return res.send(request);
    }
    let statuses;
    try {
      statuses = parse277(response).claims;
    } catch {
      throw new HttpError(502, `The clearinghouse answered with a ${x12Type(response) || 'non-X12'} instead of a claim status (277)`);
    }
    const parsed = statuses.find((x) => x.control_number === bundle.claim.control_number || parseControl(x.control_number)?.claimId === bundle.claim.id);
    if (!parsed) throw new HttpError(502, 'The payer returned no status for this claim');
    if (parsed.payer_claim_number) await db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', parsed.payer_claim_number, bundle.claim.id);
    await claimEvent(db, bundle.claim, '277', parsed.group, `${parsed.text}${parsed.category ? ` (${parsed.category})` : ''}`);
    await audit(db, req, 'claim.status_check', 'claims', bundle.claim.id, { category: parsed.category });
    res.json({ status: parsed.group, category: parsed.category, text: parsed.text, paid: parsed.paid, payer_claim_number: parsed.payer_claim_number, sandbox: !ch?.realtime });
  });

  r.get('/claims/:cid/events', requirePermission('billing:read'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    res.json(await db.all('SELECT id, source, status, message, created_at FROM claim_events WHERE claim_id = ? ORDER BY id', claim.id));
  });

  // One or more claims as a single 837D batch file. mark_submitted moves drafts to submitted.
  r.post('/claims/837', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const { bundles, claimIds, file } = await batchFile(req);
    if (req.body?.mark_submitted !== false) {
      for (const b of bundles) {
        if (['draft', 'denied'].includes(b.claim.status)) await db.run("UPDATE claims SET status = 'submitted', submitted_at = datetime('now'), denial_reason = NULL WHERE id = ?", b.claim.id);
      }
    }
    await audit(db, req, 'claims.export_837', 'claims', claimIds[0], { claim_ids: claimIds });
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="claims-${(await practiceNow(db, pid)).slice(0, 10)}.837"` });
    res.send(file);
  });

  // ---- Eligibility ----
  async function sandbox271(policy, patient, trace) {
    const used = await benefitsUsed(db, policy);
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

  r.get('/patients/:id/eligibility', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json((await db.all(
      `SELECT e.id, e.patient_insurance_id, e.status, e.summary, e.created_at, c.name AS carrier_name, u.name AS created_by_name
       FROM eligibility_checks e JOIN patient_insurance pi ON pi.id = e.patient_insurance_id JOIN insurance_carriers c ON c.id = pi.carrier_id
       LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ? AND e.patient_id = ? ORDER BY e.id DESC LIMIT 20`,
      req.user.practice_id, patient.id,
    )).map(eligView));
  });

  r.post('/insurance/:iid/eligibility', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const policy = await findOr404(db, 'patient_insurance', req.params.iid, pid, 'Policy');
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', policy.patient_id);
    const carrier = await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const trace = `EL${Date.now()}`;
    const request = build270({ practice, patient, policy, carrier, ...ids(practice), control: nextControl(), trace });
    let row = { practice_id: pid, patient_id: patient.id, patient_insurance_id: policy.id, request_x12: request, created_by: req.user.id, status: 'pending' };
    if (ch?.realtime || config.ediMode === 'sandbox' || ch?.mode === 'sandbox') {
      const live = !!ch?.realtime;
      const response = live ? await ch.realtime.eligibility(request) : await sandbox271(policy, patient, trace);
      let summary;
      try {
        summary = parse271(response);
      } catch {
        throw new HttpError(502, `The clearinghouse answered with a ${x12Type(response) || 'non-X12'} instead of an eligibility response (271)`);
      }
      row = { ...row, response_x12: response, summary: JSON.stringify({ ...summary, ...(live ? {} : { sandbox: true }) }), status: summary.errors.length ? 'error' : summary.active ? 'active' : 'inactive' };
    }
    const id = await insert(db, 'eligibility_checks', row);
    const mode = ch?.realtime ? 'realtime' : row.response_x12 ? 'sandbox' : 'manual';
    await audit(db, req, 'eligibility.check', 'eligibility_checks', id, { mode });
    res.status(201).json({ ...eligView(await db.get('SELECT id, patient_insurance_id, status, summary, created_at FROM eligibility_checks WHERE id = ?', id)), mode });
  });

  r.get('/eligibility/:eid/270', requirePermission('billing:read'), async (req, res) => {
    const e = await findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="eligibility-${e.id}.270"` }).send(e.request_x12);
  });

  // Import the payer's 271 (from the clearinghouse portal) for a pending check.
  r.post('/eligibility/:eid/response', requirePermission('billing:write'), express.text({ type: () => true, limit: '2mb' }), async (req, res) => {
    const e = await findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    let summary;
    try {
      summary = parse271(req.body);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    await update(db, 'eligibility_checks', e.id, req.user.practice_id, {
      response_x12: req.body, summary: JSON.stringify(summary), status: summary.errors.length ? 'error' : summary.active ? 'active' : 'inactive',
    });
    await audit(db, req, 'eligibility.response', 'eligibility_checks', e.id);
    res.json(eligView(await db.get('SELECT id, patient_insurance_id, status, summary, created_at FROM eligibility_checks WHERE id = ?', e.id)));
  });

  // Copy verified benefits onto the policy so treatment estimates use them.
  r.post('/eligibility/:eid/apply', requirePermission('billing:write'), async (req, res) => {
    const e = await findOr404(db, 'eligibility_checks', req.params.eid, req.user.practice_id, 'Eligibility check');
    const s = e.summary && JSON.parse(e.summary);
    if (!s) throw new HttpError(409, 'No response to apply yet');
    const row = {};
    if (s.annual_max != null) row.annual_max = s.annual_max;
    if (s.deductible != null) row.deductible = s.deductible;
    if (s.deductible != null && s.deductible_remaining != null) row.deductible_met = Math.max(0, s.deductible - s.deductible_remaining);
    for (const tier of ['preventive', 'basic', 'major']) if (s.coinsurance?.[tier] != null) row[`pct_${tier}`] = s.coinsurance[tier];
    await update(db, 'patient_insurance', e.patient_insurance_id, req.user.practice_id, row);
    await audit(db, req, 'eligibility.apply', 'patient_insurance', e.patient_insurance_id, { fields: Object.keys(row) });
    res.json(await db.get('SELECT * FROM patient_insurance WHERE id = ?', e.patient_insurance_id));
  });

  // ---- ERA / 835 auto-posting ----
  r.get('/era', requirePermission('billing:read'), async (req, res) => {
    res.json((await db.all(
      `SELECT e.id, e.filename, e.payer_name, e.check_number, e.payment_date, e.total_paid, e.claims_matched, e.claims_unmatched, e.details, e.created_at, u.name AS created_by_name
       FROM era_imports e LEFT JOIN users u ON u.id = e.created_by WHERE e.practice_id = ? ORDER BY e.id DESC LIMIT 100`, req.user.practice_id,
    )).map((e) => ({ ...e, details: JSON.parse(e.details || '[]') })));
  });

  r.post('/era/import', requirePermission('billing:write'), express.text({ type: () => true, limit: '10mb' }), async (req, res) => {
    const results = await importEra(db, String(req.body || ''), { practiceId: req.user.practice_id, userId: req.user.id, filename: req.query.filename });
    const posted = results.filter((r) => !r.duplicate);
    if (!posted.length) throw new HttpError(409, results[0]?.error || 'This ERA was already imported');
    const claims = posted.flatMap((r) => r.claims);
    await audit(db, req, 'era.import', 'era_imports', posted[0].id, { remittances: posted.length, matched: claims.filter((c) => ['posted', 'denied'].includes(c.result)).length, total: claims.length });
    // One remittance per file is the common case; several checks in one file are listed under `remittances`.
    res.status(201).json({ ...posted[0], claims, total_paid: posted.reduce((s, r) => s + r.total_paid, 0), remittances: results });
  });

  return r;
}
