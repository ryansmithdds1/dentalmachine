import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit } from '../util.js';
import { structured } from '../ai.js';
import { scrubClaim } from '../scrubber.js';
import { chartContext } from './scribe.js';

// Getting claims paid the first time: the denial-risk check, and narratives and appeal letters drafted by
// AI from the chart (for a person to read, edit and send — never sent on their own).
const NARRATIVE_TOOL = {
  name: 'claim_narrative',
  description: 'A narrative supporting a dental insurance claim.',
  input_schema: {
    type: 'object',
    properties: {
      narrative: { type: 'string', description: 'The narrative, plain text, at most about 800 characters: diagnosis, clinical findings (with tooth numbers, pocket depths, fracture/decay extent, x-ray findings), why the procedure was necessary.' },
      missing: { type: 'array', items: { type: 'string' }, description: 'Facts a payer would want that the chart doesn’t show (so staff can add them)' },
      attach: { type: 'array', items: { type: 'string' }, description: 'Attachments to send with it (e.g. pre-op periapical of #19, perio chart)' },
    },
    required: ['narrative'],
  },
};
const APPEAL_TOOL = {
  name: 'appeal_letter',
  description: 'An appeal letter for a denied or underpaid dental claim.',
  input_schema: {
    type: 'object',
    properties: {
      letter: { type: 'string', description: 'The full letter, plain text, ready to print on letterhead: addressed to the payer’s appeals department, referencing the claim, patient, subscriber ID and dates, answering the denial reason point by point with the clinical facts, requesting reprocessing, and listing enclosures.' },
      enclosures: { type: 'array', items: { type: 'string' } },
      missing: { type: 'array', items: { type: 'string' }, description: 'Facts the letter would be stronger with that the chart doesn’t show' },
    },
    required: ['letter'],
  },
};
const SYSTEM = `You write insurance documentation for a US dental office from its own chart. Use only facts in the chart given; never invent findings, measurements or dates. Where a fact a payer would want is missing, leave it out of the text and list it under "missing". Write plainly and clinically, as the treating dentist.`;

export default function claimAiRoutes({ db, config }) {
  const r = Router();
  const claimFacts = async (req) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    const policy = await db.get('SELECT pi.*, ic.name AS carrier_name, ic.address AS carrier_address FROM patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE pi.id = ?', claim.patient_insurance_id);
    const items = await db.all(
      `SELECT pr.code, pr.description, pr.tooth, pr.surfaces, substr(pr.completed_at, 1, 10) AS date, ci.fee, ci.paid_amount, ci.adjustments
       FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?`, claim.id,
    );
    const teeth = [...new Set(items.map((i) => i.tooth).filter(Boolean))];
    const chart = await chartContext(db, req.user.practice_id, claim.patient_id, null);
    const notes = await db.all('SELECT substr(created_at, 1, 10) AS date, body FROM clinical_notes WHERE patient_id = ? ORDER BY created_at DESC LIMIT 6', claim.patient_id);
    const findings = teeth.length ? await db.all(
      `SELECT kind, tooth, surfaces, measurement_mm, status, substr(created_at, 1, 10) AS date FROM xray_findings
       WHERE patient_id = ? AND status != 'dismissed' AND tooth IN (${teeth.map(() => '?').join(',')}) LIMIT 20`, claim.patient_id, ...teeth,
    ) : [];
    // What's on file to send with it, so the draft's "send with it" list names real films, not wished-for ones.
    const onFile = await db.all(
      `SELECT d.category, d.tooth, substr(COALESCE(d.taken_at, d.created_at), 1, 10) AS date, CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS attached
       FROM documents d LEFT JOIN claim_attachments a ON a.document_id = d.id AND a.claim_id = ? AND a.removed_at IS NULL
       WHERE d.patient_id = ? AND d.practice_id = ? AND d.deleted_at IS NULL AND d.category = 'xray' ORDER BY COALESCE(d.taken_at, d.created_at) DESC LIMIT 12`,
      claim.id, claim.patient_id, req.user.practice_id,
    );
    const practice = await db.get('SELECT name, address, city, state, zip, phone, npi FROM practices WHERE id = ?', req.user.practice_id);
    const provider = await db.get('SELECT pv.name, pv.npi FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id JOIN providers pv ON pv.id = pr.provider_id WHERE ci.claim_id = ? LIMIT 1', claim.id);
    return { claim, policy, items, chart, notes, findings, practice, provider, onFile };
  };
  const factsText = (f) => JSON.stringify({
    practice: f.practice, treating_dentist: f.provider,
    claim: { id: f.claim.id, payer_claim_number: f.claim.payer_claim_number, status: f.claim.status, billed: f.claim.total_fee / 100, paid: f.claim.paid_amount / 100, denial_reason: f.claim.denial_reason, remarks: f.claim.remarks },
    payer: { name: f.policy.carrier_name, address: f.policy.carrier_address }, subscriber: { name: f.policy.subscriber_name, id: f.policy.subscriber_id, group: f.policy.group_number },
    procedures: f.items.map((i) => ({ ...i, fee: i.fee / 100, paid: i.paid_amount / 100, adjustments: i.adjustments ? JSON.parse(i.adjustments) : undefined, paid_amount: undefined })),
    chart: { patient: f.chart.patient, conditions: f.chart.charted_conditions, recent_history: f.chart.recent_history, last_perio: f.chart.last_perio }, clinical_notes: f.notes, xray_ai_findings: f.findings,
    xrays_on_file: f.onFile.map((d) => ({ tooth: d.tooth || 'full mouth', date: d.date, attached_to_this_claim: !!d.attached })),
  }, null, 1);

  r.get('/claims/:cid/scrub', requirePermission('billing:read'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    res.json({ risks: await scrubClaim(db, claim.id) });
  });

  r.post('/claims/:cid/narrative', requirePermission('billing:write'), async (req, res) => {
    const f = await claimFacts(req);
    const focus = req.body?.code ? `Focus on ${String(req.body.code).slice(0, 10)}${req.body.tooth ? ` on #${String(req.body.tooth).slice(0, 3)}` : ''}.` : '';
    const out = await structured(config, { system: SYSTEM, tool: NARRATIVE_TOOL, effort: 'medium', content: `Write the claim narrative. ${focus}\n\n${factsText(f)}` });
    if (!out.narrative) throw new HttpError(502, 'The AI didn’t return a narrative — try again');
    // A draft only: nothing is attached until a person reads it and adds it (recorded then as approved by them).
    await audit(db, req, 'claim.ai_narrative', 'claims', f.claim.id, { drafted_by: 'AI', status: 'draft for review' });
    res.json({ narrative: out.narrative, missing: out.missing || [], attach: out.attach || [] });
  });

  r.post('/claims/:cid/appeal', requirePermission('billing:write'), async (req, res) => {
    const f = await claimFacts(req);
    if (!['denied', 'partially_paid', 'paid'].includes(f.claim.status)) throw new HttpError(409, 'Appeal a claim once the payer has answered it');
    const why = String(req.body?.reason || f.claim.denial_reason || '').slice(0, 1000);
    const out = await structured(config, { system: SYSTEM, tool: APPEAL_TOOL, effort: 'medium', maxTokens: 12000, content: `Write the appeal. The payer's reason or the office's concern: ${why || '(see claim)'}\n\n${factsText(f)}` });
    if (!out.letter) throw new HttpError(502, 'The AI didn’t return a letter — try again');
    await audit(db, req, 'claim.ai_appeal', 'claims', f.claim.id);
    res.json({ letter: out.letter, enclosures: out.enclosures || [], missing: out.missing || [] });
  });
  return r;
}
