import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert } from '../util.js';
import { REPORT_TYPES, TRANSMISSION } from '../attachments.js';

// Claim attachments: pick x-rays or a perio chart from the chart, or write a narrative; send them to
// get control numbers, which the claim then references (837 PWK).
export default function attachmentRoutes({ db, storage, sender }) {
  const r = Router();
  const list = (claimId) => db.all(
    `SELECT a.*, d.filename, d.mime, d.category AS document_category FROM claim_attachments a LEFT JOIN documents d ON d.id = a.document_id
     WHERE a.claim_id = ? ORDER BY a.id`, claimId,
  );

  r.get('/claims/:cid/attachments', requirePermission('billing:read'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    res.json({ attachments: await list(claim.id), report_types: REPORT_TYPES, transmissions: TRANSMISSION, mode: sender.mode, electronic: sender.electronic });
  });

  r.post('/claims/:cid/attachments', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (['paid', 'void'].includes(claim.status)) throw new HttpError(409, `Claim is ${claim.status}`);
    const b = req.body || {};
    if (!REPORT_TYPES[b.report_type]) throw new HttpError(400, 'Choose what kind of attachment this is');
    let documentId = null;
    if (b.document_id) {
      const doc = await db.get('SELECT id FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(b.document_id), claim.patient_id, req.user.practice_id);
      if (!doc) throw new HttpError(404, 'Document not found in this patient’s chart');
      documentId = doc.id;
    }
    const narrative = b.narrative ? String(b.narrative).trim().slice(0, 4000) : null;
    if (!documentId && !narrative) throw new HttpError(400, 'Choose a document or write a narrative');
    const transmission = sender.electronic ? 'EL' : ['BM', 'FX'].includes(b.transmission) ? b.transmission : 'BM';
    const id = await insert(db, 'claim_attachments', {
      practice_id: req.user.practice_id, claim_id: claim.id, document_id: documentId, report_type: b.report_type, narrative, transmission, created_by: req.user.id,
    });
    await audit(db, req, 'claim.attachment_add', 'claims', claim.id, { attachment_id: id });
    res.status(201).json(await list(claim.id));
  });

  r.delete('/claim-attachments/:aid', requirePermission('billing:write'), async (req, res) => {
    const a = await findOr404(db, 'claim_attachments', req.params.aid, req.user.practice_id, 'Attachment');
    if (!['pending', 'rejected'].includes(a.status)) throw new HttpError(409, 'This attachment was already sent; the claim refers to it');
    await db.run('DELETE FROM claim_attachments WHERE id = ?', a.id);
    res.json(await list(a.claim_id));
  });

  // Sends every attachment that hasn't gone yet. Each one that works gets its control number.
  r.post('/claims/:cid/attachments/send', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (!claim.control_number) {
      claim.control_number = `DM${claim.id}`;
      await db.run('UPDATE claims SET control_number = ? WHERE id = ?', claim.control_number, claim.id);
    }
    const ctx = await db.get(
      `SELECT p.first_name, p.last_name, p.dob, pi.subscriber_id, c.name AS payer_name, c.payer_id, pr.npi AS billing_npi
       FROM claims cl JOIN patients p ON p.id = cl.patient_id JOIN patient_insurance pi ON pi.id = cl.patient_insurance_id
       JOIN insurance_carriers c ON c.id = pi.carrier_id JOIN practices pr ON pr.id = cl.practice_id WHERE cl.id = ?`, claim.id,
    );
    const pending = await db.all("SELECT * FROM claim_attachments WHERE claim_id = ? AND status IN ('pending','rejected')", claim.id);
    const results = [];
    for (const a of pending) {
      try {
        let file = null;
        if (a.document_id && sender.electronic && sender.mode !== 'sandbox') {
          const doc = await db.get('SELECT * FROM documents WHERE id = ?', a.document_id);
          const data = await storage.read(doc.storage_key, !!doc.encrypted);
          file = { name: doc.filename, mime: doc.mime, base64: Buffer.from(data).toString('base64') };
        }
        const out = await sender.send({
          claim_control: claim.control_number, payer_id: ctx.payer_id, payer_name: ctx.payer_name, billing_npi: ctx.billing_npi,
          patient: { first_name: ctx.first_name, last_name: ctx.last_name, dob: ctx.dob }, subscriber_id: ctx.subscriber_id,
          report_type: a.report_type, narrative: a.narrative, file,
        });
        await db.run("UPDATE claim_attachments SET control_number = ?, status = ?, vendor_ref = ?, error = NULL, sent_at = datetime('now') WHERE id = ?", out.control_number, out.status, out.vendor_ref || null, a.id);
        results.push({ id: a.id, ok: true, control_number: out.control_number });
      } catch (err) {
        await db.run('UPDATE claim_attachments SET error = ? WHERE id = ?', String(err.message).slice(0, 300), a.id);
        results.push({ id: a.id, ok: false, error: err.message });
      }
    }
    await audit(db, req, 'claim.attachments_send', 'claims', claim.id, { sent: results.filter((x) => x.ok).length });
    res.json({ results, attachments: await list(claim.id) });
  });

  return r;
}
