import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { requireHuman } from '../aiguard.js';
import { canSeePatient, requireVisiblePatients } from '../officeaccess.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { audit, insert, recorded } from '../util.js';
import { createClaim } from '../services.js';
import { REPORT_TYPES } from '../attachments.js';
import { attachmentDeps, filePerioChart, sendPendingAttachments } from './attachments.js';
import { parseKey, prepEnabled, prepareGroups, countGroups, skippedGroups } from '../claimprep.js';

// Billing → Ready to approve (docs/workflows/specs/24-claims.md). The list is prepared on its own (claimprep.js);
// every claim here is made and sent only when a person approves it:
//   GET  /claim-queue                 the prepared groups (ready / needs a fix), or ?view=skipped
//   GET  /claim-queue/count           how many are waiting (the tab's badge)
//   POST /claim-queue/approve         { key, override_reason? } — makes the claim and sends it
//   POST /claim-queue/approve-all     { expected_count, expected_total } — every ready group, as confirmed on screen
//   POST /claim-queue/skip            { key, reason } — skip for now; /skips/restore { skip_group } puts it back
//   POST /claim-queue/fixes           { key, document_id | perio_exam_id | narrative } — an x-ray, perio chart or
//                                     narrative for the claim; DELETE /claim-queue/fixes/:id takes it off
//   GET  /claim-queue/files/:bid      the 837 file approvals were saved in (no clearinghouse connection)
//   GET|PUT /claim-queue/settings     "Prepare claims for approval automatically" (on by default; there is no auto-send)
// A person approves: approving, approving all and skipping refuse the AI without a person's OK (requireHuman,
// and aiguard's HIGH_RISK for requests). Approval is idempotent: a group's key is unique in claim_approvals, so a
// double click or a retry returns the first claim instead of making a second (and createClaim itself refuses
// work already on a claim).
const STALE_MINUTES = 10;

export default function claimPrepRoutes({ db, ch, claimProblems, send }) {
  const r = Router();
  const CLAIM_SELECT = `SELECT c.*, p.first_name, p.last_name, ic.name AS carrier_name FROM claims c JOIN patients p ON p.id = c.patient_id
    JOIN patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE c.id = ?`;
  const opts = (req, extra = {}) => ({ practiceId: req.user.practice_id, user: req.user, locationId: req.location_id ?? null, claimProblems, ...extra });
  const unique = (err) => /unique|duplicate/i.test(String(err?.message)) || err?.code === '23505';
  const requireOn = async (req) => {
    if (!(await prepEnabled(db, req.user.practice_id))) throw new HttpError(409, 'Preparing claims for approval is turned off for this practice (Billing → Ready to approve → settings)');
  };
  const reasonOf = (v, what) => {
    const s = String(v ?? '').trim();
    if (!s) throw new HttpError(400, `Say why ${what}`);
    return s.slice(0, 300);
  };

  // The group a key names, worked out fresh for this person (their practice and offices). A key whose work
  // changed since the list was loaded answers 409 with the group as it is now.
  async function currentGroup(req, key) {
    const k = parseKey(key);
    if (!k) throw new HttpError(400, 'key is required');
    if (!(await canSeePatient(db, req.user, k.patient_id))) throw new HttpError(404, 'Nothing waiting to bill for this patient');
    const { groups } = await prepareGroups(db, opts(req, { patientId: k.patient_id }));
    const g = groups.find((x) => x.key === key);
    if (g) return g;
    const now = groups.find((x) => x.patient_insurance_id === k.patient_insurance_id && (x.location_id ?? null) === k.location_id);
    if (now) throw new HttpError(409, 'This patient’s unbilled work changed since the list was loaded — look again before approving', { changed: true, group: now });
    throw new HttpError(404, 'Nothing waiting to bill here any more — it may have been billed already');
  }

  // Makes the claim for one group (not the sending): taken once through claim_approvals, audited as this person.
  async function createFor(req, key, overrideReason = null) {
    requireHuman('approving claims');
    const pid = req.user.practice_id;
    const prior = await db.get('SELECT a.*, c.status AS claim_status FROM claim_approvals a LEFT JOIN claims c ON c.id = a.claim_id WHERE a.practice_id = ? AND a.group_key = ?', pid, String(key));
    if (prior?.status === 'done' && prior.claim_status && prior.claim_status !== 'void') {
      if (!(await canSeePatient(db, req.user, prior.patient_id))) throw new HttpError(404, 'Nothing waiting to bill for this patient');
      return { claimId: prior.claim_id, already: true };
    }
    // An approval stuck half-way (the server stopped mid-request) can be taken again after STALE_MINUTES.
    const stale = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    if (prior?.status === 'working' && prior.updated_at > stale) throw new HttpError(409, 'Someone is approving this claim right now — look again in a moment');
    let g;
    try {
      g = await currentGroup(req, key);
      if (g.fixes.length) {
        if (!g.can_override) throw new HttpError(422, `Fix this first: ${g.fixes.filter((f) => f.hard).map((f) => f.message).join('; ')}`, { needs_fix: g.fixes });
        if (!overrideReason) throw new HttpError(422, `Needs a fix: ${g.fixes.map((f) => f.message).join('; ')}. Fix it, or approve anyway with a reason.`, { needs_fix: g.fixes, can_override: true });
      }
    } catch (err) {
      // A second click that raced the first: by now the first may have made the claim (so the work reads as
      // billed or a duplicate). Answer with the first approval instead of an error.
      const now = await db.get('SELECT a.*, c.status AS claim_status FROM claim_approvals a LEFT JOIN claims c ON c.id = a.claim_id WHERE a.practice_id = ? AND a.group_key = ?', pid, String(key));
      if (now?.status === 'done' && now.claim_status && now.claim_status !== 'void' && await canSeePatient(db, req.user, now.patient_id)) return { claimId: now.claim_id, already: true };
      if (now?.status === 'working' && now.updated_at > stale) throw new HttpError(409, 'Someone is approving this claim right now — look again in a moment');
      throw err;
    }
    // The lock: one approval per group key, ever working at once. A failed approval (or one whose claim was
    // voided) can be taken again; a done one is answered above.
    const row = { practice_id: pid, patient_id: g.patient_id, patient_insurance_id: g.patient_insurance_id, group_key: g.key, status: 'working', approved_by: req.user.id, override_reason: overrideReason };
    let approvalId;
    try {
      approvalId = await insert(db, 'claim_approvals', row);
    } catch (err) {
      if (!unique(err)) throw err;
      const took = await db.run(
        `UPDATE claim_approvals SET status = 'working', approved_by = ?, override_reason = ?, error = NULL, claim_id = NULL, updated_at = datetime('now')
         WHERE practice_id = ? AND group_key = ? AND (status = 'failed' OR (status = 'working' AND updated_at <= ?) OR (status = 'done' AND claim_id IN (SELECT id FROM claims WHERE status = 'void')))`,
        req.user.id, overrideReason, pid, g.key, stale,
      );
      if (!took.changes) throw new HttpError(409, 'Someone is approving this claim right now — look again in a moment');
      approvalId = (await db.get('SELECT id FROM claim_approvals WHERE practice_id = ? AND group_key = ?', pid, g.key)).id;
    }
    let claimId;
    try {
      claimId = await createClaim(db, { practiceId: pid, policyId: g.patient_insurance_id, procedureIds: g.procedure_ids, userId: req.user.id });
    } catch (err) {
      await db.run("UPDATE claim_approvals SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", String(err.message).slice(0, 300), approvalId);
      throw err;
    }
    // The x-rays, perio charts and narratives picked for this work go onto the claim (sent before it, below).
    const deps = attachmentDeps(db);
    for (const a of g.attachments) {
      await insert(db, 'claim_attachments', {
        practice_id: pid, claim_id: claimId, document_id: a.document_id, report_type: a.report_type, narrative: a.narrative,
        transmission: deps?.sender?.electronic === false ? 'BM' : 'EL', created_by: req.user.id,
      });
      await db.run('UPDATE claim_prep_attachments SET claim_id = ? WHERE id = ? AND claim_id IS NULL', claimId, a.id);
    }
    await db.run("UPDATE claim_approvals SET status = 'done', claim_id = ?, updated_at = datetime('now') WHERE id = ?", claimId, approvalId);
    await audit(db, req, 'claim.create', 'claims', claimId, { from: 'ready_to_approve', patient_id: g.patient_id });
    await audit(db, req, 'claim_queue.approve', 'claims', claimId, {
      group_key: g.key, patient_id: g.patient_id, procedure_ids: g.procedure_ids, total_fee: g.total_fee, attachments: g.attachments.length,
      ...(overrideReason ? { approved_despite: g.fixes.map((f) => f.message) } : {}),
    }, { reason: overrideReason });
    return { claimId, already: false };
  }

  // Sends approved claims (their attachments first). Whatever can't go stays a draft under Billing → Claims →
  // Ready to send and becomes a Needs attention item, resolved when it's sent.
  async function sendApproved(req, claimIds) {
    const pid = req.user.practice_id;
    const failures = [];
    const ready = [];
    for (const id of claimIds) {
      const claim = await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', id, pid);
      if (!claim || !['draft', 'denied'].includes(claim.status)) continue; // sent already (a retry)
      const pending = (await db.get("SELECT COUNT(*) AS n FROM claim_attachments WHERE claim_id = ? AND status IN ('pending','rejected') AND removed_at IS NULL", id)).n;
      if (Number(pending)) {
        const deps = attachmentDeps(db);
        const results = deps ? await sendPendingAttachments(db, deps, claim) : [{ ok: false, error: 'no attachment service' }];
        await audit(db, req, 'claim.attachments_send', 'claims', id, { sent: results.filter((x) => x.ok).length, from: 'ready_to_approve' });
        const bad = results.filter((x) => !x.ok);
        if (bad.length) { failures.push({ claim_id: id, error: `An attachment couldn’t be sent (${bad[0].error})` }); continue; }
      }
      ready.push(id);
    }
    let out = null;
    // A claim the checks refuse is taken out and the rest go (it shouldn't happen: the same checks ran above).
    while (ready.length) {
      try {
        out = await send({ pid, userId: req.user.id, claimIds: ready });
        await audit(db, req, out.transport === 'file' ? 'claims.export_837' : 'claims.submit', 'edi_batches', out.batch_id, { claim_ids: out.claim_ids, transport: out.transport, from: 'ready_to_approve' });
        for (const id of out.claim_ids) await resolveIssue(db, pid, `claim-not-sent:${id}`, 'Sent');
        break;
      } catch (err) {
        const one = err.details?.claim_id;
        if (one && ready.includes(one) && ready.length > 1) {
          failures.push({ claim_id: one, error: err.message });
          ready.splice(ready.indexOf(one), 1);
          continue;
        }
        for (const id of ready) failures.push({ claim_id: id, error: err.message });
        ready.length = 0;
      }
    }
    for (const f of failures) {
      const c = await db.get('SELECT patient_id FROM claims WHERE id = ?', f.claim_id);
      await raiseIssue(db, {
        practiceId: pid, kind: 'claim', key: `claim-not-sent:${f.claim_id}`, role: 'billing', entity: 'claims', entityId: f.claim_id, patientId: c?.patient_id ?? null,
        title: `Claim #${f.claim_id} was approved but not sent`, detail: `${f.error}. It’s waiting under Billing → Claims → Ready to send.`,
      });
    }
    return { out, failures };
  }

  const claimView = (id) => db.get(CLAIM_SELECT, id);
  const how = (out) => (out ? { transport: out.transport, via: out.transport === 'file' ? null : ch?.name || null, file: out.transport === 'file' ? { batch_id: out.batch_id, filename: out.filename } : null, responses: out.responses } : {});

  r.get('/claim-queue', requirePermission('billing:read'), async (req, res) => {
    const enabled = await prepEnabled(db, req.user.practice_id);
    const clearinghouse = { batch: !!ch?.batch, name: ch?.name || null };
    if (req.query.view === 'skipped') return res.json({ enabled, clearinghouse, skipped: await skippedGroups(db, opts(req)) });
    if (!enabled) return res.json({ enabled, clearinghouse, groups: [], more: 0 });
    const { groups, more } = await prepareGroups(db, opts(req));
    const ready = groups.filter((g) => g.status === 'ready');
    res.json({ enabled, clearinghouse, groups, more, ready_count: ready.length, ready_total: ready.reduce((t, g) => t + g.total_fee, 0) });
  });

  r.get('/claim-queue/count', requirePermission('billing:read'), async (req, res) => {
    res.json({ count: await countGroups(db, opts(req)) });
  });

  r.post('/claim-queue/approve', requirePermission('billing:write'), async (req, res) => {
    requireHuman('approving claims');
    await requireOn(req);
    const override = req.body?.override_reason != null && String(req.body.override_reason).trim() ? reasonOf(req.body.override_reason, 'it should go anyway') : null;
    const { claimId, already } = await createFor(req, req.body?.key, override);
    const { out, failures } = await sendApproved(req, [claimId]);
    const claim = await claimView(claimId);
    res.status(already ? 200 : 201).json({
      claim, already, sent: ['submitted', 'partially_paid', 'paid'].includes(claim.status), error: failures[0]?.error || null, ...how(out),
    });
  });

  // Every ready group, in one step, after the person confirmed the count and total on screen. If the list
  // changed in between (new work, someone else approved some), nothing is done and the new numbers come back.
  r.post('/claim-queue/approve-all', requirePermission('billing:write'), async (req, res) => {
    requireHuman('approving claims');
    await requireOn(req);
    const { groups } = await prepareGroups(db, opts(req));
    const ready = groups.filter((g) => g.status === 'ready');
    const total = ready.reduce((t, g) => t + g.total_fee, 0);
    if (!ready.length) throw new HttpError(409, 'No claims are ready to approve');
    if (Number(req.body?.expected_count) !== ready.length || Number(req.body?.expected_total) !== total) {
      throw new HttpError(409, `The list changed: ${ready.length} claim${ready.length === 1 ? '' : 's'} for $${(total / 100).toFixed(2)} are ready now — check and confirm again`, { changed: true, count: ready.length, total });
    }
    const made = [];
    const failures = [];
    for (const g of ready) {
      try {
        made.push((await createFor(req, g.key)).claimId);
      } catch (err) {
        failures.push({ key: g.key, patient_name: g.patient_name, error: err.message });
      }
    }
    const sent = made.length ? await sendApproved(req, made) : { out: null, failures: [] };
    await audit(db, req, 'claim_queue.approve_all', 'practices', req.user.practice_id, { claims: made, count: ready.length, total_fee: total, failed: failures.length + sent.failures.length });
    const sentCount = made.length - sent.failures.length;
    res.status(201).json({ approved: made.length, sent: sentCount, claim_ids: made, failures: [...failures, ...sent.failures], ...how(sent.out) });
  });

  r.post('/claim-queue/skip', requirePermission('billing:write'), async (req, res) => {
    requireHuman('skipping claims');
    const reason = reasonOf(req.body?.reason, 'this is being skipped');
    const k = parseKey(req.body?.key);
    if (!k) throw new HttpError(400, 'key is required');
    if (!(await canSeePatient(db, req.user, k.patient_id))) throw new HttpError(404, 'Nothing waiting to bill for this patient');
    // A repeat (double click): everything in it is already skipped.
    const skippedAlready = await db.get(
      `SELECT skip_group, COUNT(*) AS n FROM claim_prep_skips WHERE practice_id = ? AND patient_insurance_id = ? AND restored_at IS NULL AND procedure_id IN (${k.procedure_ids.map(() => '?').join(',')}) GROUP BY skip_group`,
      req.user.practice_id, k.patient_insurance_id, ...k.procedure_ids,
    );
    if (skippedAlready && Number(skippedAlready.n) === k.procedure_ids.length) return res.json({ skip_group: skippedAlready.skip_group, already: true });
    const g = await currentGroup(req, req.body.key);
    const skipGroup = `${g.key}@${Date.now()}`;
    await db.tx(async () => {
      for (const id of g.procedure_ids) {
        await insert(db, 'claim_prep_skips', {
          practice_id: req.user.practice_id, patient_id: g.patient_id, patient_insurance_id: g.patient_insurance_id, procedure_id: id, skip_group: skipGroup, reason, skipped_by: req.user.id,
        });
      }
    });
    await audit(db, req, 'claim_queue.skip', 'patients', g.patient_id, { procedure_ids: g.procedure_ids, patient_insurance_id: g.patient_insurance_id, total_fee: g.total_fee, skip_group: skipGroup }, { reason });
    res.status(201).json({ skip_group: skipGroup, already: false });
  });

  r.post('/claim-queue/skips/restore', requirePermission('billing:write'), async (req, res) => {
    const rows = await db.all('SELECT * FROM claim_prep_skips WHERE practice_id = ? AND skip_group = ? AND restored_at IS NULL', req.user.practice_id, String(req.body?.skip_group || ''));
    if (!rows.length) return res.json({ restored: 0 });
    if (!(await canSeePatient(db, req.user, rows[0].patient_id))) throw new HttpError(404, 'Not found');
    for (const s of rows) {
      await recorded(db, 'claim_prep_skips', s.id, () => db.run("UPDATE claim_prep_skips SET restored_at = datetime('now'), restored_by = ? WHERE id = ? AND restored_at IS NULL", req.user.id, s.id));
    }
    await audit(db, req, 'claim_queue.unskip', 'patients', rows[0].patient_id, { procedure_ids: rows.map((s) => s.procedure_id), skip_group: rows[0].skip_group });
    res.json({ restored: rows.length });
  });

  // An x-ray, a perio chart (filed in the chart as a PDF) or a narrative, picked for work that isn't on a claim
  // yet. It goes onto the claim when the group is approved.
  r.post('/claim-queue/fixes', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const k = parseKey(b.key);
    if (!k) throw new HttpError(400, 'key is required');
    if (!(await canSeePatient(db, req.user, k.patient_id))) throw new HttpError(404, 'Patient not found');
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ? AND practice_id = ? AND patient_id = ?', k.patient_insurance_id, pid, k.patient_id);
    if (!policy) throw new HttpError(404, 'Policy not found');
    let documentId = null;
    let type = b.report_type || null;
    let narrative = null;
    if (b.perio_exam_id) {
      const exam = await db.get('SELECT * FROM perio_exams WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(b.perio_exam_id), k.patient_id, pid);
      if (!exam) throw new HttpError(404, 'Perio exam not found in this patient’s chart');
      const deps = attachmentDeps(db);
      if (!deps) throw new HttpError(503, 'Files can’t be saved right now — try again');
      documentId = await filePerioChart(db, deps.storage, { practiceId: pid, patientId: k.patient_id, exam, userId: req.user.id, note: `Perio exam of ${exam.exam_date}, filed for an insurance claim` });
      type = 'P6';
    } else if (b.document_id) {
      const doc = await db.get('SELECT id, category FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(b.document_id), k.patient_id, pid);
      if (!doc) throw new HttpError(404, 'Document not found in this patient’s chart');
      documentId = doc.id;
      type ||= doc.category === 'xray' ? 'RB' : 'DG';
    } else {
      narrative = String(b.narrative ?? '').trim().slice(0, 4000);
      if (!narrative) throw new HttpError(400, 'Choose an x-ray or write a narrative');
      type = 'OZ';
    }
    if (!REPORT_TYPES[type]) throw new HttpError(400, 'Choose what kind of attachment this is');
    if (documentId && await db.get('SELECT id FROM claim_prep_attachments WHERE patient_insurance_id = ? AND document_id = ? AND claim_id IS NULL AND removed_at IS NULL', policy.id, documentId)) {
      return res.json({ already: true }); // a repeat
    }
    const id = await insert(db, 'claim_prep_attachments', {
      practice_id: pid, patient_id: k.patient_id, patient_insurance_id: policy.id, document_id: documentId, report_type: type, narrative, created_by: req.user.id,
    });
    // An AI-drafted narrative is recorded as drafted by AI and approved by this person.
    await audit(db, req, 'claim_queue.attach', 'patients', k.patient_id, { attachment_id: id, report_type: type, document_id: documentId, ...(b.ai_drafted && narrative ? { drafted_by: 'AI', approved_by: req.user.name } : {}) });
    res.status(201).json({ id });
  });

  r.delete('/claim-queue/fixes/:fid', requirePermission('billing:write'), async (req, res) => {
    const a = await db.get('SELECT * FROM claim_prep_attachments WHERE id = ? AND practice_id = ?', Number(req.params.fid), req.user.practice_id);
    if (!a || !(await canSeePatient(db, req.user, a.patient_id))) throw new HttpError(404, 'Attachment not found');
    if (a.claim_id) throw new HttpError(409, `It’s on claim #${a.claim_id} now — change it on the claim`);
    if (a.removed_at) return res.json({ removed: true });
    await recorded(db, 'claim_prep_attachments', a.id, () => db.run("UPDATE claim_prep_attachments SET removed_at = datetime('now'), removed_by = ? WHERE id = ?", req.user.id, a.id));
    await audit(db, req, 'claim_queue.detach', 'patients', a.patient_id, { attachment_id: a.id, report_type: a.report_type });
    res.json({ removed: true });
  });

  // The 837 file approvals were saved in when there's no clearinghouse connection (to upload in its portal).
  r.get('/claim-queue/files/:bid', requirePermission('billing:write'), async (req, res) => {
    const b = await db.get("SELECT * FROM edi_batches WHERE id = ? AND practice_id = ? AND transport = 'file'", Number(req.params.bid), req.user.practice_id);
    if (!b) throw new HttpError(404, 'File not found');
    const ids = JSON.parse(b.claim_ids || '[]');
    const patients = ids.length ? (await db.all(`SELECT DISTINCT patient_id FROM claims WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((c) => c.patient_id) : [];
    await requireVisiblePatients(db, req.user, patients);
    await audit(db, req, 'claims.export_837', 'edi_batches', b.id, { claim_ids: ids, download: true });
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${b.filename}"` }).send(b.x12);
  });

  r.get('/claim-queue/settings', requirePermission('billing:read'), async (req, res) => {
    res.json({ enabled: await prepEnabled(db, req.user.practice_id) });
  });
  // Only preparing can be switched: there's no setting that sends claims without a person.
  r.put('/claim-queue/settings', requirePermission('billing:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    const pid = req.user.practice_id;
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET claim_prep = ? WHERE id = ?', req.body.enabled ? 1 : 0, pid));
    await audit(db, req, 'practice.claim_prep', 'practices', pid, { enabled: req.body.enabled });
    res.json({ enabled: req.body.enabled });
  });

  return r;
}
