import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { createHash } from 'node:crypto';
import { findOr404, audit, insert, recorded, practiceNow, isRealDate } from '../util.js';
import { structured, aiClient } from '../ai.js';
import { PdfDoc } from '../pdf.js';
import { scrubClaim } from '../scrubber.js';
import { claimDenial } from '../predict/denial.js';
import { logShown, denialEntries } from '../predict/log.js';
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

export const APPEAL_FOLLOW_UP_DAYS = 30;
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const $ = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

// The appeal when AI is off: a plain letter from the claim's own facts, for the office to finish and sign.
export function templateAppeal(f, why) {
  const p = f.practice;
  const lines = f.items.map((i) => `  - ${i.date || ''} ${i.code}${i.tooth ? ` tooth #${i.tooth}` : ''}${i.surfaces ? ` ${i.surfaces}` : ''}: ${i.description || ''} (billed ${$(i.fee)}, paid ${$(i.paid_amount)})`);
  const letter = [
    p.name, [p.address, [p.city, p.state, p.zip].filter(Boolean).join(', ')].filter(Boolean).join(', '), p.phone || '', '',
    `${f.policy.carrier_name} — Appeals Department`, f.policy.carrier_address || '', '',
    `Re: Request for reconsideration of claim #${f.claim.id}${f.claim.payer_claim_number ? ` (payer claim ${f.claim.payer_claim_number})` : ''}`,
    `Patient: ${f.chart.patient?.name || ''}   Subscriber: ${f.policy.subscriber_name || ''}   Member ID: ${f.policy.subscriber_id || ''}${f.policy.group_number ? `   Group: ${f.policy.group_number}` : ''}`, '',
    'To the appeals reviewer:', '',
    `We ask you to reconsider this claim. ${why ? `The reason given was: "${why}". ` : ''}We believe the services below were necessary and are covered under the patient's plan.`, '',
    'Services:', ...lines, '',
    'Clinical reason: [the treating dentist’s findings — tooth, extent, x-ray findings — and why this treatment was needed]', '',
    'Enclosed: [x-rays, perio chart, narrative, the explanation of benefits].', '',
    'Please reprocess the claim and contact our office with any questions.', '',
    'Sincerely,', '', f.provider?.name || '', f.provider?.npi ? `NPI ${f.provider.npi}` : '',
  ].join('\n');
  return { letter, enclosures: f.onFile.slice(0, 3).map((d) => `X-ray${d.tooth ? ` of #${d.tooth}` : ''} (${d.date})`), missing: ['The clinical reason in the dentist’s words (the template leaves a space for it)'] };
}

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
    const risks = await scrubClaim(db, claim.id);
    const denial = await claimDenial(db, claim.id, risks);
    res.json({ risks, denial });
    if (['draft', 'denied'].includes(claim.status)) logShown(db, req, denialEntries(denial, { claimId: claim.id, locationId: claim.location_id ?? null }), 'claim');
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

  // Appeals (workflow 46). Without a letter: a draft to read and edit — written by AI from the chart and the
  // payer's reason, or from a plain template when AI is off. With a letter: the office sends it — the letter is
  // filed on the chart as a PDF, the claim's history records the appeal, and the claim comes back up for a
  // follow-up call on the date given (default APPEAL_FOLLOW_UP_DAYS). The same letter twice is one appeal.
  r.post('/claims/:cid/appeal', requirePermission('billing:write'), async (req, res) => {
    const f = await claimFacts(req);
    if (!['denied', 'partially_paid', 'paid'].includes(f.claim.status)) throw new HttpError(409, 'Appeal a claim once the payer has answered it');
    const why = String(req.body?.reason || f.claim.denial_reason || '').slice(0, 1000);
    if (req.body?.letter !== undefined) return res.status(201).json(await recordAppeal(req, f, why));
    if (!aiClient(config)) {
      await audit(db, req, 'claim.appeal_draft', 'claims', f.claim.id, { drafted_by: 'template' });
      return res.json({ ...templateAppeal(f, why), drafted_by: 'template' });
    }
    const out = await structured(config, { system: SYSTEM, tool: APPEAL_TOOL, effort: 'medium', maxTokens: 12000, content: `Write the appeal. The payer's reason or the office's concern: ${why || '(see claim)'}\n\n${factsText(f)}` });
    if (!out.letter) throw new HttpError(502, 'The AI didn’t return a letter — try again');
    await audit(db, req, 'claim.ai_appeal', 'claims', f.claim.id, { drafted_by: 'AI', status: 'draft for review' });
    res.json({ letter: out.letter, enclosures: out.enclosures || [], missing: out.missing || [], drafted_by: 'ai' });
  });

  const recordAppeal = async (req, f, why) => {
    const letter = String(req.body.letter || '').trim();
    if (letter.length < 40) throw new HttpError(400, 'Write the appeal letter first');
    if (letter.length > 20000) throw new HttpError(400, 'The letter is too long (20,000 characters at most)');
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const followUp = req.body.follow_up_date ? String(req.body.follow_up_date) : addDays(today, APPEAL_FOLLOW_UP_DAYS);
    if (!isRealDate(followUp) || followUp < today) throw new HttpError(400, 'Follow-up date must be a real date (YYYY-MM-DD), today or later');
    const hash = createHash('sha256').update(letter).digest('hex').slice(0, 16);
    // A double click or a resend of the same letter is the same appeal.
    const again = (await db.all("SELECT id, details FROM claim_events WHERE claim_id = ? AND source = 'appeal'", f.claim.id))
      .map((e) => ({ id: e.id, ...JSON.parse(e.details || '{}') })).find((e) => e.hash === hash);
    if (again) return { event_id: again.id, document_id: again.document_id, follow_up_date: again.follow_up_date, already: true };
    const drafted = ['ai', 'template', 'staff'].includes(req.body.drafted_by) ? req.body.drafted_by : 'staff';
    const storage = req.app.locals.storage;
    let documentId = null;
    if (storage) {
      const doc = new PdfDoc({ footer: `${f.practice.name} · appeal of claim #${f.claim.id}` });
      for (const para of letter.split(/\n/)) doc.text(para || ' ', { size: 11, gap: 1 });
      const pdf = doc.toBuffer();
      const saved = await storage.save(req.user.practice_id, pdf);
      documentId = await insert(db, 'documents', {
        practice_id: req.user.practice_id, patient_id: f.claim.patient_id, category: 'correspondence', folder: 'Insurance',
        filename: `Appeal claim ${f.claim.id} ${today}.pdf`, mime: 'application/pdf', size: pdf.length, storage_key: saved.storageKey,
        encrypted: saved.encrypted ? 1 : 0, uploaded_by: req.user.id, source: 'appeal', notes: `Appeal of claim #${f.claim.id} to ${f.policy.carrier_name}`.slice(0, 500),
      });
    }
    const details = { hash, document_id: documentId, follow_up_date: followUp, reason: why || null, drafted_by: drafted };
    const eventId = await insert(db, 'claim_events', {
      practice_id: f.claim.practice_id, claim_id: f.claim.id, source: 'appeal', status: 'sent',
      message: `Appeal sent${why ? `: ${why}` : ''} · follow up ${followUp}`.slice(0, 500), details: JSON.stringify(details), user_id: req.user.id,
    });
    await recorded(db, 'claims', f.claim.id, () => db.run('UPDATE claims SET follow_up_date = ? WHERE id = ?', followUp, f.claim.id));
    // Who sent it is the person signed in; an AI draft they approved says so.
    await audit(db, req, 'claim.appeal', 'claims', f.claim.id, { document_id: documentId, drafted_by: drafted, approved_by: req.user.id, reason: why || null }, {
      before: { follow_up_date: f.claim.follow_up_date || null }, after: { follow_up_date: followUp },
    });
    return { event_id: eventId, document_id: documentId, follow_up_date: followUp };
  };
  return r;
}
