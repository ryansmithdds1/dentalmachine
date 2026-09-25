import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, update, audit, practiceNow } from '../util.js';
import { publish } from '../events.js';
import { sendMessage } from '../messaging.js';
import { segmentPatients, cleanParams } from '../campaigns.js';
import { LETTER_FIELDS, STARTER_TEMPLATES, checkTemplate, letterVars, renderLetter, assertComplete, lettersPdf, labelList, labelsPdf } from '../letters.js';

// Letters from templates (A171) and mailing labels (A177): docs/documents.md, “Letters and mailing labels”.
// Templates are configuration (admins; switched off rather than removed, changes audited before → after). Letters are
// records: the exact text is kept, the PDF is filed in the patient's documents, and nothing is edited afterwards.
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators change letter templates')));
const safe = (s) => String(s).replace(/[^\w.\- ]+/g, '_').slice(0, 120);

export default function letterRoutes({ db, storage, messenger }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const practiceOf = (req) => db.get('SELECT name, phone, address, city, state, zip FROM practices WHERE id = ?', req.user.practice_id);

  const templates = async (pid, all = false) => {
    let rows = await db.all(`SELECT * FROM letter_templates WHERE practice_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, name`, pid);
    if (!rows.length && !(await db.get('SELECT id FROM letter_templates WHERE practice_id = ?', pid))) {
      // A new office starts with the everyday letters, ready to use or change.
      let sort = 0;
      for (const [name, subject, body] of STARTER_TEMPLATES) {
        await db.run('INSERT INTO letter_templates (practice_id, name, subject, body, sort) VALUES (?, ?, ?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, name, subject, body, sort++);
      }
      rows = await db.all(`SELECT * FROM letter_templates WHERE practice_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, name`, pid);
    }
    return rows;
  };
  const cleanTemplate = (body, partial) => {
    const row = {};
    if (!partial || 'name' in body) {
      row.name = String(body.name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
      if (!row.name) throw new HttpError(400, 'Name the letter', { missing: ['name'] });
    }
    if (!partial || 'body' in body) {
      row.body = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
      if (!row.body) throw new HttpError(400, 'Write the letter', { missing: ['body'] });
    }
    if ('subject' in body) row.subject = String(body.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 150) || null;
    if ('active' in body) row.active = body.active ? 1 : 0;
    if ('sort' in body) row.sort = Number(body.sort) || 0;
    checkTemplate(row.body ?? '', row.subject ?? '');
    return row;
  };

  r.get('/letter-fields', requirePermission('patients:read'), (_req, res) => res.json(Object.entries(LETTER_FIELDS).map(([key, label]) => ({ key, label }))));
  r.get('/letter-templates', requirePermission('patients:read'), async (req, res) => res.json(await templates(req.user.practice_id, req.query.all === '1')));
  r.post('/letter-templates', requireAdmin, async (req, res) => {
    const row = cleanTemplate(req.body || {}, false);
    if (await db.get('SELECT id FROM letter_templates WHERE practice_id = ? AND name = ?', req.user.practice_id, row.name)) throw new HttpError(409, `There's already a letter called ${row.name}`);
    const id = await insert(db, 'letter_templates', { ...row, practice_id: req.user.practice_id, updated_by: req.user.id, updated_at: new Date().toISOString() });
    await audit(db, req, 'letter_template.create', 'letter_templates', id, { name: row.name }, { after: row });
    res.status(201).json(await db.get('SELECT * FROM letter_templates WHERE id = ?', id));
  });
  r.put('/letter-templates/:tid', requireAdmin, async (req, res) => {
    const t = await findOr404(db, 'letter_templates', req.params.tid, req.user.practice_id, 'Letter template');
    const row = cleanTemplate(req.body || {}, true);
    if (row.name && row.name !== t.name && await db.get('SELECT id FROM letter_templates WHERE practice_id = ? AND name = ? AND id != ?', req.user.practice_id, row.name, t.id)) throw new HttpError(409, `There's already a letter called ${row.name}`);
    await update(db, 'letter_templates', t.id, req.user.practice_id, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString() });
    await audit(db, req, 'letter_template.change', 'letter_templates', t.id, { name: row.name || t.name });
    res.json(await db.get('SELECT * FROM letter_templates WHERE id = ?', t.id));
  });

  // The words to fill: a saved template, or the template's words as changed on screen for this one letter.
  const sourceOf = async (req) => {
    const b = req.body || {};
    const t = b.template_id ? await findOr404(db, 'letter_templates', b.template_id, req.user.practice_id, 'Letter template') : null;
    const src = { subject: b.subject ?? t?.subject ?? '', body: b.body ?? t?.body ?? '' };
    if (!String(src.body).trim()) throw new HttpError(400, 'Choose a letter', { missing: ['template_id'] });
    src.body = String(src.body).replace(/\r\n/g, '\n').slice(0, 8000);
    src.subject = String(src.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 150);
    checkTemplate(src.body, src.subject);
    return { t, src };
  };

  r.post('/patients/:id/letters/preview', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const { src } = await sourceOf(req);
    const { vars } = await letterVars(db, req.user.practice_id, patient.id, await today(req));
    const out = renderLetter(src, vars);
    res.json({ ...out, can_email: !!(patient.email && patient.email_opt_in), has_address: !!vars.patient_address });
  });

  // Makes the letter: fills it, refuses while anything is unfilled, files the PDF on the chart, and emails it when
  // asked. Returns the letter (its PDF is GET /letters/:id/pdf).
  const makeLetter = async (req, patientId, src, t, { delivery = 'print', batchKey = null, day }) => {
    const { vars, patient } = await letterVars(db, req.user.practice_id, patientId, day);
    const out = renderLetter(src, vars);
    assertComplete(out, `${patient.first_name} ${patient.last_name}`);
    const practice = await practiceOf(req);
    const one = { name: vars.full_name, address: vars.patient_address, date: vars.today, subject: out.subject, body: out.body };
    const pdf = lettersPdf([one], practice);
    const saved = await storage.save(req.user.practice_id, pdf);
    const filename = safe(`${t?.name || out.subject || 'Letter'} ${day}.pdf`);
    const letter = await db.tx(async () => {
      const documentId = await insert(db, 'documents', {
        practice_id: req.user.practice_id, patient_id: patient.id, category: 'correspondence', folder: 'Letters', filename, mime: 'application/pdf', size: pdf.length,
        storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, uploaded_by: req.user.id, notes: `Letter: ${t?.name || out.subject || 'from a template'}`,
      });
      const id = await insert(db, 'patient_letters', {
        practice_id: req.user.practice_id, patient_id: patient.id, template_id: t?.id ?? null, subject: out.subject || null, body: out.body, delivery, document_id: documentId,
        batch_key: batchKey, created_by: req.user.id,
      });
      await audit(db, req, 'letter.create', 'patient_letters', id, { template: t?.name ?? null, delivery, document_id: documentId, patient_id: patient.id, batch: batchKey }, { patientId: patient.id });
      return db.get('SELECT * FROM patient_letters WHERE id = ?', id);
    });
    publish(req.user.practice_id, { type: 'documents', patient_id: patient.id });
    let message = null;
    if (delivery === 'email') {
      // Opt-outs and bad addresses are checked by sendMessage; a failure becomes a Needs attention item there.
      if (!patient.email) throw new HttpError(400, `${patient.first_name} has no email address — print it instead (the letter is filed on the chart)`, { letter_id: letter.id });
      message = await sendMessage(db, messenger, {
        practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'letter', channel: 'email', to: patient.email,
        subject: out.subject || `A letter from ${practice.name}`, body: `${out.body}\n\n${practice.name}`, attachments: [{ filename, type: 'application/pdf', content: pdf }],
      });
      await db.run('UPDATE patient_letters SET message_id = ? WHERE id = ?', message.id, letter.id);
    }
    return { letter: { ...letter, message_id: message?.id ?? null }, message, pdf, one };
  };

  r.post('/patients/:id/letters', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const delivery = req.body?.delivery || 'print';
    if (!['print', 'email'].includes(delivery)) throw new HttpError(400, 'Delivery must be print or email');
    const { t, src } = await sourceOf(req);
    const out = await makeLetter(req, patient.id, src, t, { delivery, day: await today(req) });
    res.status(201).json({ letter: out.letter, message: out.message && { id: out.message.id, status: out.message.status, error: out.message.error } });
  });
  r.get('/patients/:id/letters', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(`SELECT l.*, t.name AS template_name, u.name AS created_by_name, m.status AS message_status FROM patient_letters l LEFT JOIN letter_templates t ON t.id = l.template_id
      LEFT JOIN users u ON u.id = l.created_by LEFT JOIN messages m ON m.id = l.message_id WHERE l.practice_id = ? AND l.patient_id = ? ORDER BY l.id DESC`, req.user.practice_id, patient.id));
  });
  r.get('/letters/:lid/pdf', requirePermission('patients:read'), async (req, res) => {
    const l = await findOr404(db, 'patient_letters', req.params.lid, req.user.practice_id, 'Letter');
    const doc = await db.get('SELECT * FROM documents WHERE id = ? AND practice_id = ?', l.document_id, req.user.practice_id);
    const data = doc && await storage.read(doc.storage_key, !!doc.encrypted);
    if (!data) throw new HttpError(404, 'The letter’s file is missing');
    await audit(db, req, 'letter.print', 'patient_letters', l.id, { patient_id: l.patient_id }, { patientId: l.patient_id });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${safe(doc.filename)}"` }).send(data);
  });

  // The same letter for a list (a report's results, a recall list): one PDF to print, each letter filed on its own
  // chart. Anyone the letter can't be filled for is left out and named, never sent with a blank.
  r.post('/letters/batch', requirePermission('patients:write'), async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.patient_ids) ? req.body.patient_ids : []).map(Number).filter((n) => n > 0))];
    if (!ids.length) throw new HttpError(400, 'Choose who the letter is for');
    if (ids.length > 500) throw new HttpError(400, 'Up to 500 letters at a time');
    const { t, src } = await sourceOf(req);
    const day = await today(req);
    const batchKey = randomUUID();
    const made = [];
    const skipped = [];
    for (const id of ids) {
      const p = await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ? AND practice_id = ?', id, req.user.practice_id);
      if (!p) continue;
      try {
        made.push((await makeLetter(req, id, src, t, { delivery: 'print', batchKey, day })).one);
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 400) throw err;
        skipped.push({ id, name: `${p.first_name} ${p.last_name}`, reason: err.message });
      }
    }
    await audit(db, req, 'letter.batch', 'letter_templates', t?.id ?? null, { batch: batchKey, made: made.length, skipped: skipped.length });
    res.status(201).json({ made: made.length, skipped, pdf: made.length ? lettersPdf(made, await practiceOf(req)).toString('base64') : null });
  });

  // Mailing labels (Avery 5160) for any list of patients: one per household, never for someone who asked not to be
  // contacted, moved or died, or has no complete address — those are listed back so the office can fix them.
  r.post('/mailing-labels', requirePermission('patients:read'), async (req, res) => {
    // A list of patients, or a campaign's audience (segment + params), the same people the campaign would reach.
    const ids = Array.isArray(req.body?.patient_ids) ? req.body.patient_ids
      : req.body?.segment ? (await segmentPatients(db, req.user.practice_id, req.body.segment, cleanParams(req.body.segment, req.body.params || {}))).map((p) => p.id) : [];
    const skip = Math.min(29, Math.max(0, Number(req.body?.skip) || 0));
    if (req.body?.segment && !ids.length) return res.json({ count: 0, skipped: [], warnings: [], pdf: null });
    const out = await labelList(db, req.user.practice_id, ids);
    await audit(db, req, 'mailing_labels.print', 'patients', null, { requested: ids.length, printed: out.labels.length, skipped: out.skipped.length, source: String(req.body?.source || '').slice(0, 40) || null });
    res.json({ count: out.labels.length, skipped: out.skipped, warnings: out.warnings, pdf: out.labels.length ? labelsPdf(out.labels, { skip }).toString('base64') : null });
  });
  return r;
}
