import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, practiceNow } from '../util.js';
import { REPORT_TYPES, TRANSMISSION, attachmentHints } from '../attachments.js';
import { PdfDoc } from '../pdf.js';

// Suggested attachments look this far around the date of service: x-rays and perio charts from the year
// before (payers want pre-op images and a current perio chart), or a few weeks after (a post-op film).
const LOOK_BACK_DAYS = 365;
const LOOK_AHEAD_DAYS = 30;
const MAX_BATCH = 20;
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const byTooth = (a, b) => (Number(a) || 1000 + a.charCodeAt(0)) - (Number(b) || 1000 + b.charCodeAt(0));

// A perio exam as a one-page chart, so it can travel as a claim attachment like any other document.
function perioPdf(exam, patient, practice) {
  const readings = JSON.parse(exam.readings || '{}');
  const doc = new PdfDoc({ footer: `${practice.name} · periodontal chart for ${patient.first_name} ${patient.last_name}` });
  doc.text(practice.name, { size: 14, bold: true, gap: 1 });
  doc.text(`Periodontal chart — exam of ${exam.exam_date}`, { size: 12, bold: true });
  doc.text(`${patient.first_name} ${patient.last_name}${patient.dob ? ` · born ${patient.dob}` : ''}`, { size: 10 });
  doc.space(6);
  const at = [0, 0.1, 0.34, 0.58, 0.72, 0.86];
  doc.row(['Tooth', 'Buccal depths (DB B MB)', 'Lingual depths (DL L ML)', 'Bleeding sites', 'Recession', 'Mobility'], { at, bold: true, size: 9 });
  doc.rule();
  const sites = (list, from) => (list || []).slice(from, from + 3).map((d) => (d == null ? '-' : d)).join(' ');
  for (const tooth of Object.keys(readings).sort(byTooth)) {
    const v = readings[tooth] || {};
    if (v.missing) { doc.row([`#${tooth}`, 'missing'], { at, size: 9 }); continue; }
    const gm = (v.gm || []).filter((d) => d != null);
    doc.row([`#${tooth}`, sites(v.pd, 0), sites(v.pd, 3), String((v.bop || []).filter(Boolean).length || ''), gm.length ? `${Math.max(...gm)} mm` : '', v.mob != null ? String(v.mob) : ''], { at, size: 9 });
  }
  if (exam.notes) { doc.space(6); doc.text(exam.notes, { size: 9.5 }); }
  return doc.toBuffer();
}

// Claim attachments: pick x-rays or a perio chart from the chart, or write a narrative; send them to
// get control numbers, which the claim then references (837 PWK).
export default function attachmentRoutes({ db, storage, sender }) {
  const r = Router();
  const list = (claimId) => db.all(
    `SELECT a.*, d.filename, d.mime, d.category AS document_category FROM claim_attachments a LEFT JOIN documents d ON d.id = a.document_id
     WHERE a.claim_id = ? AND a.removed_at IS NULL ORDER BY a.id`, claimId,
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
    // An AI-drafted narrative is recorded as drafted by AI and approved (sent) by this person.
    await audit(db, req, 'claim.attachment_add', 'claims', claim.id, { attachment_id: id, ...(b.ai_drafted && narrative ? { drafted_by: 'AI', approved_by: req.user.name } : {}) });
    res.status(201).json(await list(claim.id));
  });

  // What to attach, worked out for the person: the validator's "payers want an attachment for this" list says
  // which kinds are needed; the chart supplies x-rays of those teeth taken within a year of the service, and the
  // latest perio exam for perio codes. The best match for each need comes preselected.
  const claimItems = (claimId) => db.all(
    `SELECT ci.procedure_id, pr.code, pr.tooth, substr(COALESCE(pr.completed_at, cl.created_at), 1, 10) AS service_date
     FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id JOIN claims cl ON cl.id = ci.claim_id WHERE ci.claim_id = ? ORDER BY ci.id`, claimId,
  );
  async function suggestionsFor(claim) {
    const items = await claimItems(claim.id);
    const attached = await list(claim.id);
    const today = (await practiceNow(db, claim.practice_id)).slice(0, 10);
    // A kind is needed when adding it would clear a validator warning; each item's own warning is its reason.
    const needs = [];
    for (const type of ['RB', 'P6']) {
      const itemsNeeding = items.filter((i) => attachmentHints([i], []).length > attachmentHints([i], [{ report_type: type }]).length);
      if (!itemsNeeding.length || attachmentHints(items, attached).length === attachmentHints(items, [...attached, { report_type: type }]).length) continue;
      needs.push({ type, label: REPORT_TYPES[type], items: itemsNeeding, reasons: [...new Set(itemsNeeding.flatMap((i) => attachmentHints([i], [])))] });
    }
    const taken = new Set(attached.filter((a) => a.document_id).map((a) => a.document_id));
    const out = [];
    for (const need of needs) {
      const dates = need.items.map((i) => i.service_date || today).sort();
      const from = shiftDate(dates[0], -LOOK_BACK_DAYS);
      const to = shiftDate(dates[dates.length - 1], LOOK_AHEAD_DAYS);
      if (need.type === 'RB') {
        const films = await db.all(
          `SELECT id, filename, tooth, substr(COALESCE(taken_at, created_at), 1, 10) AS taken FROM documents
           WHERE practice_id = ? AND patient_id = ? AND category = 'xray' AND deleted_at IS NULL
             AND substr(COALESCE(taken_at, created_at), 1, 10) BETWEEN ? AND ? ORDER BY COALESCE(taken_at, created_at) DESC, id DESC`,
          claim.practice_id, claim.patient_id, from, to,
        );
        const teeth = [...new Set(need.items.map((i) => i.tooth).filter(Boolean))];
        const picked = new Set();
        // The newest film of each tooth on the claim; if a tooth has none, the newest full-mouth film (pano, FMX).
        for (const tooth of teeth.length ? teeth : [null]) {
          const best = films.find((f) => tooth && f.tooth === tooth && !taken.has(f.id)) || films.find((f) => !f.tooth && !taken.has(f.id));
          if (best) picked.add(best.id);
        }
        for (const f of films) {
          if (taken.has(f.id) || (f.tooth && !teeth.includes(f.tooth))) continue;
          out.push({
            key: `doc-${f.id}`, kind: 'document', document_id: f.id, report_type: 'RB', label: f.filename, tooth: f.tooth, date: f.taken, preselected: picked.has(f.id),
            why: f.tooth ? `X-ray of #${f.tooth}` : 'Full-mouth x-ray',
          });
        }
      } else {
        const exams = await db.all(
          'SELECT id, exam_date FROM perio_exams WHERE practice_id = ? AND patient_id = ? AND deleted_at IS NULL AND exam_date BETWEEN ? AND ? ORDER BY exam_date DESC, id DESC',
          claim.practice_id, claim.patient_id, from, to,
        );
        for (const [i, e] of exams.entries()) {
          const filed = await db.get('SELECT id FROM documents WHERE patient_id = ? AND source = ? AND deleted_at IS NULL', claim.patient_id, `perio:${e.id}`);
          if (filed && taken.has(filed.id)) continue;
          out.push({ key: `perio-${e.id}`, kind: 'perio', perio_exam_id: e.id, report_type: 'P6', label: `Perio chart, ${e.exam_date}`, date: e.exam_date, preselected: i === 0, why: 'Latest perio exam' });
        }
      }
    }
    return { needs: needs.map(({ items: its, ...n }) => ({ ...n, teeth: [...new Set(its.map((i) => i.tooth).filter(Boolean))] })), suggestions: out };
  }

  r.get('/claims/:cid/attachments/suggest', requirePermission('billing:read'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (['paid', 'void'].includes(claim.status)) return res.json({ needs: [], suggestions: [] });
    res.json(await suggestionsFor(claim));
  });

  // Several attachments in one step (the suggested ones, usually): documents from the chart by id, and perio
  // exams, which are filed in the chart as a PDF first. Anything already attached is skipped, so a repeat is harmless.
  r.post('/claims/:cid/attachments/batch', requirePermission('billing:write'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    if (['paid', 'void'].includes(claim.status)) throw new HttpError(409, `Claim is ${claim.status}`);
    const wanted = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!wanted.length) throw new HttpError(400, 'Choose what to attach');
    if (wanted.length > MAX_BATCH) throw new HttpError(400, `Attach at most ${MAX_BATCH} at a time`);
    // Check everything before changing anything.
    const plan = [];
    for (const w of wanted) {
      if (w?.perio_exam_id) {
        const exam = await db.get('SELECT * FROM perio_exams WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(w.perio_exam_id), claim.patient_id, req.user.practice_id);
        if (!exam) throw new HttpError(404, 'Perio exam not found in this patient’s chart');
        plan.push({ exam, report_type: 'P6' });
      } else {
        const type = w?.report_type || 'RB';
        if (!REPORT_TYPES[type]) throw new HttpError(400, 'Choose what kind of attachment this is');
        const doc = await db.get('SELECT id FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(w?.document_id), claim.patient_id, req.user.practice_id);
        if (!doc) throw new HttpError(404, 'Document not found in this patient’s chart');
        plan.push({ document_id: doc.id, report_type: type });
      }
    }
    const transmission = sender.electronic ? 'EL' : ['BM', 'FX'].includes(req.body?.transmission) ? req.body.transmission : 'BM';
    const added = [];
    for (const p of plan) {
      let documentId = p.document_id;
      if (p.exam) {
        const filed = await db.get('SELECT id FROM documents WHERE patient_id = ? AND practice_id = ? AND source = ? AND deleted_at IS NULL', claim.patient_id, req.user.practice_id, `perio:${p.exam.id}`);
        if (filed) documentId = filed.id;
        else {
          const patient = await db.get('SELECT first_name, last_name, dob FROM patients WHERE id = ?', claim.patient_id);
          const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
          const pdf = perioPdf(p.exam, patient, practice);
          const saved = await storage.save(req.user.practice_id, pdf);
          documentId = await insert(db, 'documents', {
            practice_id: req.user.practice_id, patient_id: claim.patient_id, category: 'document', filename: `Perio chart ${p.exam.exam_date}.pdf`, mime: 'application/pdf',
            size: pdf.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, uploaded_by: req.user.id, source: `perio:${p.exam.id}`,
            notes: `Perio exam of ${p.exam.exam_date}, filed for claim #${claim.id}`,
          });
        }
      }
      const already = await db.get('SELECT id FROM claim_attachments WHERE claim_id = ? AND document_id = ? AND removed_at IS NULL', claim.id, documentId);
      if (already) continue;
      const id = await insert(db, 'claim_attachments', {
        practice_id: req.user.practice_id, claim_id: claim.id, document_id: documentId, report_type: p.report_type, narrative: null, transmission, created_by: req.user.id,
      });
      await audit(db, req, 'claim.attachment_add', 'claims', claim.id, { attachment_id: id, document_id: documentId, report_type: p.report_type, batch: true });
      added.push(id);
    }
    res.status(201).json({ added, attachments: await list(claim.id) });
  });

  r.delete('/claim-attachments/:aid', requirePermission('billing:write'), async (req, res) => {
    const a = await findOr404(db, 'claim_attachments', req.params.aid, req.user.practice_id, 'Attachment');
    if (a.removed_at) throw new HttpError(409, 'This attachment was already removed');
    if (!['pending', 'rejected'].includes(a.status)) throw new HttpError(409, 'This attachment was already sent; the claim refers to it');
    await db.run("UPDATE claim_attachments SET removed_at = datetime('now'), removed_by = ? WHERE id = ?", req.user.id, a.id);
    await audit(db, req, 'claim.attachment_remove', 'claims', a.claim_id, { attachment_id: a.id, report_type: a.report_type });
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
    const pending = await db.all("SELECT * FROM claim_attachments WHERE claim_id = ? AND status IN ('pending','rejected') AND removed_at IS NULL", claim.id);
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
