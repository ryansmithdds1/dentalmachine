import express, { Router } from 'express';
import { refuseTraining } from '../training.js';
import { requirePermission, requireAnyPermission, HttpError, can, USER_PERMISSION_SQL } from '../auth.js';
import { findOr404, insert, audit, recorded, isRealDate, practiceNow } from '../util.js';
import { publish } from '../events.js';
import { patientScope, restricted, canSeePatient } from '../officeaccess.js';
import {
  loadDoc, storeUpload, queueRead, readDocument, docView, OFFICE_READ, OFFICE_WRITE, OFFICE_CATEGORIES, PATIENT_CATEGORIES,
} from '../docfiles.js';
import { readLimitFor } from '../filetypes.js';
import { searchDocuments, readText } from '../docsearch.js';
import { CATEGORY_LABELS } from '../ocr.js';

// Document management (docs/documents.md): notes and sticky-note pins, "needs review" routed to a person,
// links to a visit / claim / treatment plan, folders, full-text search (patient and practice-wide), office
// (non-patient) documents with expiry reminders, the scan inbox, and "scan now" on a workstation's scanner.
// Mounted by routes/documents.js, so it sits behind sign-in and office access like the rest of the chart.
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green'];
const SCAN_SOURCES = ['auto', 'flatbed', 'feeder'];
const SCAN_COLORS = ['color', 'gray', 'bw'];
const SCAN_FORMATS = ['pdf', 'jpg'];
const ONLINE_SECONDS = 90;
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';
const idOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const agentOnline = (a) => !!a.last_seen_at && Date.now() - Date.parse(`${a.last_seen_at.replace(' ', 'T')}Z`) < ONLINE_SECONDS * 1000;

export default function docManageRoutes({ db, storage, config = {}, reader, scanner }) {
  const r = Router();
  const pid = (req) => req.user.practice_id;
  const who = (req) => req.user.name || 'staff';
  const changed = (doc) => (doc.patient_id ? publish(doc.practice_id, { type: 'documents', patient_id: doc.patient_id }) : publish(doc.practice_id, { type: 'office-documents' }));
  const isAdmin = (req) => req.user.role === 'admin';

  // ---- Settings: whether scans and photos of paperwork are read by the AI for search ----
  r.get('/documents/settings', requirePermission('clinical:read'), async (req, res) => {
    const p = await db.get('SELECT document_ai FROM practices WHERE id = ?', pid(req));
    res.json({ document_ai: !!p?.document_ai, reader: reader?.mode || 'off', reader_name: reader?.name || null, virus_scanner: scanner?.mode || 'none', virus_scanner_name: scanner?.name || null });
  });
  r.put('/documents/settings', async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Administrator access required');
    const on = flag(req.body?.document_ai) ? 1 : 0;
    await recorded(db, 'practices', pid(req), () => db.run('UPDATE practices SET document_ai = ? WHERE id = ?', on, pid(req)));
    await audit(db, req, 'practice.document_ai', 'practices', pid(req), { document_ai: !!on });
    res.json({ document_ai: !!on });
  });

  // ---- One document: everything the side panel shows ----
  const noteView = (n) => ({ ...n, pinned: n.x != null && n.y != null });
  const notesOf = async (docId, history = false) => (await db.all(
    `SELECT n.*, u.name AS author, c.name AS closed_by_name FROM document_notes n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN users c ON c.id = n.closed_by
     WHERE n.document_id = ?${history ? '' : " AND n.status = 'active'"} ORDER BY n.id`, docId,
  )).map(noteView);
  r.get('/documents/:did/details', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { allowDeleted: true });
    const [uploader, assignee, reviewer, requester] = await Promise.all([doc.uploaded_by, doc.review_assignee, doc.reviewed_by, doc.review_requested_by]
      .map((id) => (id ? db.get('SELECT id, name FROM users WHERE id = ? AND practice_id = ?', id, doc.practice_id) : null)));
    const links = {
      appointment: doc.appointment_id ? await db.get('SELECT id, start_time, status FROM appointments WHERE id = ?', doc.appointment_id) : null,
      claim: doc.claim_id ? await db.get('SELECT id, status, total_fee FROM claims WHERE id = ?', doc.claim_id) : null,
      treatment_plan: doc.treatment_plan_id ? await db.get('SELECT id, name, status FROM treatment_plans WHERE id = ?', doc.treatment_plan_id) : null,
    };
    const notes = await notesOf(doc.id, true);
    res.json({
      ...docView({ ...doc, uploaded_by_name: uploader?.name || null }), exposure: parseJson(doc.exposure),
      review: doc.review_status ? { status: doc.review_status, assignee, note: doc.review_note, requested_by: requester, requested_at: doc.review_requested_at, reviewed_by: reviewer, reviewed_at: doc.reviewed_at, task_id: doc.review_task_id } : null,
      links, doc_notes: notes.filter((n) => n.status === 'active'), history: notes.filter((n) => n.status !== 'active'),
      can_write: can(req.user, doc.patient_id ? 'clinical:write' : OFFICE_WRITE) || (doc.inbox && can(req.user, 'clinical:write')),
      categories: doc.patient_id || doc.inbox ? PATIENT_CATEGORIES : OFFICE_CATEGORIES,
    });
  });

  // The words read from the document (for Word/Excel files this is the preview). Viewing it is recorded.
  r.get('/documents/:did/text', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did);
    const text = await readText(storage, doc);
    await audit(db, req, 'document.view_text', 'documents', doc.id, { patient_id: doc.patient_id });
    res.json({ text, status: doc.ocr_status || null, source: doc.ocr_source || null });
  });

  // Read (again): e.g. after turning AI reading on, or when the first try failed.
  r.post('/documents/:did/read', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    await db.run("UPDATE documents SET ocr_status = 'pending' WHERE id = ?", doc.id);
    await audit(db, req, 'document.read_request', 'documents', doc.id, { patient_id: doc.patient_id });
    const status = await readDocument(db, storage, config, reader, doc.id, { force: true, requestedBy: who(req) });
    const after = await db.get('SELECT * FROM documents WHERE id = ?', doc.id);
    res.json({ status, document: docView(after) });
  });

  // A person files the document as suggested (the AI's or the rules' suggestion): recorded as their decision.
  r.post('/documents/:did/accept-suggestion', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    if (!doc.suggested_category) throw new HttpError(409, 'There is no suggestion for this document');
    const allowed = doc.patient_id || doc.inbox ? PATIENT_CATEGORIES : OFFICE_CATEGORIES;
    if (!allowed.includes(doc.suggested_category)) throw new HttpError(400, 'That suggestion doesn’t apply here');
    await recorded(db, 'documents', doc.id, () => db.run('UPDATE documents SET category = ?, suggested_category = NULL WHERE id = ?', doc.suggested_category, doc.id));
    await audit(db, req, 'document.accept_suggestion', 'documents', doc.id, { patient_id: doc.patient_id, category: doc.suggested_category, suggested_by: doc.suggestion_source, reason: doc.suggestion_reason }, {
      reason: `Approved suggestion: ${doc.suggestion_reason || ''}`.slice(0, 300),
    });
    changed(doc);
    res.json(docView(await db.get('SELECT * FROM documents WHERE id = ?', doc.id)));
  });
  r.post('/documents/:did/dismiss-suggestion', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    await recorded(db, 'documents', doc.id, () => db.run('UPDATE documents SET suggested_category = NULL WHERE id = ?', doc.id));
    await audit(db, req, 'document.dismiss_suggestion', 'documents', doc.id, { patient_id: doc.patient_id, suggested: doc.suggested_category });
    res.json({ ok: true });
  });

  // ---- Notes: history kept (an edit supersedes, a removal is a status) ----
  r.get('/documents/:did/notes', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { allowDeleted: true });
    res.json(await notesOf(doc.id, flag(req.query.history)));
  });
  const cleanNote = (b, required = true) => {
    const body = String(b?.body ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (required && !body) throw new HttpError(400, 'Write the note');
    const out = { body };
    const hasPin = b?.x !== undefined && b?.x !== null && b?.x !== '';
    if (hasPin) {
      const x = Number(b.x);
      const y = Number(b.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new HttpError(400, 'A pin’s position must be within the page (0 to 1)');
      const page = b.page == null || b.page === '' ? 1 : Number(b.page);
      if (!Number.isInteger(page) || page < 1 || page > 5000) throw new HttpError(400, 'page must be a page number');
      Object.assign(out, { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, page });
    } else if (b?.page != null && b.page !== '') {
      const page = Number(b.page);
      if (!Number.isInteger(page) || page < 1 || page > 5000) throw new HttpError(400, 'page must be a page number');
      out.page = page;
    }
    if (b?.color !== undefined && b.color !== null) {
      if (!NOTE_COLORS.includes(b.color)) throw new HttpError(400, `color must be one of ${NOTE_COLORS.join(', ')}`);
      out.color = b.color;
    }
    return out;
  };
  r.post('/documents/:did/notes', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    const n = cleanNote(req.body);
    const id = await insert(db, 'document_notes', {
      practice_id: doc.practice_id, document_id: doc.id, patient_id: doc.patient_id, body: n.body, page: n.page ?? null, x: n.x ?? null, y: n.y ?? null,
      color: n.color || (n.x != null ? 'yellow' : null), created_by: req.user.id, source: req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human',
    });
    await audit(db, req, n.x != null ? 'document.pin' : 'document.note', 'documents', doc.id, { patient_id: doc.patient_id, note_id: id, page: n.page ?? null }, { after: { note: n.body } });
    changed(doc);
    res.status(201).json(noteView(await db.get('SELECT n.*, u.name AS author FROM document_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?', id)));
  });
  const loadNote = async (req, write = true) => {
    const note = await findOr404(db, 'document_notes', req.params.nid, pid(req), 'Note');
    const doc = await loadDoc(db, req, note.document_id, { write });
    return { note, doc };
  };
  // An edit is a new version: the old one stays (status superseded) and the new one points back at it.
  r.put('/document-notes/:nid', async (req, res) => {
    const { note, doc } = await loadNote(req);
    if (note.status !== 'active') throw new HttpError(409, 'That note was already changed or removed — reload to see the latest');
    const n = cleanNote({ body: req.body?.body ?? note.body, x: req.body?.x !== undefined ? req.body.x : note.x, y: req.body?.y !== undefined ? req.body.y : note.y, page: req.body?.page ?? note.page, color: req.body?.color ?? note.color });
    const id = await db.tx(async () => {
      const done = await db.run("UPDATE document_notes SET status = 'superseded', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'active'", req.user.id, sqlNow(), note.id);
      if (!done.changes) throw new HttpError(409, 'That note was just changed by someone else — reload to see the latest');
      return insert(db, 'document_notes', {
        practice_id: note.practice_id, document_id: note.document_id, patient_id: note.patient_id, body: n.body, page: n.page ?? null, x: n.x ?? null, y: n.y ?? null,
        color: n.color || null, supersedes_id: note.id, created_by: req.user.id, source: req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human',
      });
    });
    await audit(db, req, 'document.note_edit', 'documents', doc.id, { patient_id: doc.patient_id, note_id: id, supersedes: note.id }, { before: { note: note.body }, after: { note: n.body } });
    changed(doc);
    res.json(noteView(await db.get('SELECT n.*, u.name AS author FROM document_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?', id)));
  });
  r.delete('/document-notes/:nid', async (req, res) => {
    const { note, doc } = await loadNote(req);
    if (note.status === 'deleted') return res.json({ ok: true, already: true });
    if (note.status !== 'active') throw new HttpError(409, 'That note was changed since — remove the latest version');
    await db.run("UPDATE document_notes SET status = 'deleted', closed_by = ?, closed_at = ? WHERE id = ?", req.user.id, sqlNow(), note.id);
    await audit(db, req, 'document.note_remove', 'documents', doc.id, { patient_id: doc.patient_id, note_id: note.id }, { before: { note: note.body } });
    changed(doc);
    res.json({ ok: true });
  });
  // Undo of a removal: the same note comes back (both steps stay in the audit trail).
  r.post('/document-notes/:nid/restore', async (req, res) => {
    const { note, doc } = await loadNote(req);
    if (note.status !== 'deleted') return res.json({ ok: true, already: true });
    await db.run("UPDATE document_notes SET status = 'active', closed_by = NULL, closed_at = NULL WHERE id = ?", note.id);
    await audit(db, req, 'document.note_restore', 'documents', doc.id, { patient_id: doc.patient_id, note_id: note.id });
    changed(doc);
    res.json({ ok: true });
  });

  // ---- "Needs review": routed to a person as a task on their to-do list ----
  r.put('/documents/:did/review', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    const assignee = await db.get(`${USER_PERMISSION_SQL} WHERE u.id = ? AND u.practice_id = ?`, Number(req.body?.assignee_id) || 0, pid(req));
    if (!assignee) throw new HttpError(404, 'Person not found');
    if (!assignee.active) throw new HttpError(400, `${assignee.name} is no longer active`);
    // The person has to be able to open it.
    if (!can(assignee, doc.patient_id ? 'clinical:read' : OFFICE_READ)) throw new HttpError(400, `${assignee.name} can’t open this document`);
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const today = (await practiceNow(db, pid(req))).slice(0, 10);
    const due = isRealDate(req.body?.due_date) ? req.body.due_date : today;
    const title = `Review ${doc.patient_id ? '' : 'office '}document: ${doc.filename}`.slice(0, 200);
    const taskId = await db.tx(async () => {
      if (doc.review_task_id) await db.run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ? AND status = 'open'", sqlNow(), req.user.id, doc.review_task_id);
      const t = await insert(db, 'tasks', {
        practice_id: pid(req), patient_id: doc.patient_id, assigned_to: assignee.id, title, notes: `${note ? `${note}\n` : ''}Open: /documents/${doc.id}`.slice(0, 1000), due_date: due,
        priority: flag(req.body?.urgent) ? 'high' : 'normal', created_by: req.user.id,
      });
      await recorded(db, 'documents', doc.id, () => db.run(
        "UPDATE documents SET review_status = 'needs_review', review_assignee = ?, review_task_id = ?, review_note = ?, review_requested_by = ?, review_requested_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?",
        assignee.id, t, note, req.user.id, sqlNow(), doc.id,
      ));
      return t;
    });
    await audit(db, req, 'document.review_request', 'documents', doc.id, { patient_id: doc.patient_id, assignee: assignee.name, task_id: taskId, note });
    changed(doc);
    publish(pid(req), { type: 'tasks' });
    res.json({ ok: true, task_id: taskId, review_status: 'needs_review', assignee: { id: assignee.id, name: assignee.name } });
  });
  // Reviewed (or the flag taken off): the task is done too.
  r.post('/documents/:did/review/done', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did);
    if (doc.review_status !== 'needs_review') return res.json({ ok: true, already: true });
    // The person asked, or anyone who can change the document.
    if (doc.review_assignee !== req.user.id && !can(req.user, doc.patient_id ? 'clinical:write' : OFFICE_WRITE)) throw new HttpError(403, 'Only the person asked to review it can mark it reviewed');
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    await db.tx(async () => {
      await recorded(db, 'documents', doc.id, () => db.run("UPDATE documents SET review_status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE id = ?", req.user.id, sqlNow(), doc.id));
      if (doc.review_task_id) await db.run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ? AND status = 'open'", sqlNow(), req.user.id, doc.review_task_id);
    });
    if (note) {
      await insert(db, 'document_notes', { practice_id: doc.practice_id, document_id: doc.id, patient_id: doc.patient_id, body: `Reviewed: ${note}`, created_by: req.user.id });
    }
    await audit(db, req, 'document.reviewed', 'documents', doc.id, { patient_id: doc.patient_id, note, task_id: doc.review_task_id });
    changed(doc);
    publish(pid(req), { type: 'tasks' });
    res.json({ ok: true, review_status: 'reviewed' });
  });
  // Everything waiting for review (?mine=1: just mine), for the Office to-do list and the documents screens.
  r.get('/documents/needs-review', async (req, res) => {
    const conds = ["d.practice_id = ?", "d.review_status = 'needs_review'", 'd.deleted_at IS NULL'];
    const args = [pid(req)];
    if (flag(req.query.mine)) { conds.push('d.review_assignee = ?'); args.push(req.user.id); }
    const canPatients = can(req.user, 'clinical:read');
    const canOffice = can(req.user, OFFICE_READ);
    if (!canPatients) conds.push('d.patient_id IS NULL');
    if (!canOffice) conds.push('(d.patient_id IS NOT NULL OR d.inbox = 1)');
    const s = patientScope(req.user);
    const rows = await db.all(
      `SELECT d.*, p.first_name, p.last_name, a.name AS assignee_name, q.name AS requested_by_name FROM documents d
       LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN users a ON a.id = d.review_assignee LEFT JOIN users q ON q.id = d.review_requested_by
       WHERE ${conds.join(' AND ')}${s.sql ? ` AND (d.patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = d.patient_id${s.sql}))` : ''} ORDER BY d.review_requested_at, d.id LIMIT 500`,
      ...args, ...s.args,
    );
    res.json(rows.map((d) => ({
      ...docView(d), patient_name: d.patient_id ? `${d.first_name} ${d.last_name}` : null, assignee_name: d.assignee_name, requested_by_name: d.requested_by_name,
      review_requested_at: d.review_requested_at, review_task_id: d.review_task_id,
      link: d.patient_id ? `/patients/${d.patient_id}?tab=documents&doc=${d.id}` : `/documents?doc=${d.id}`,
    })));
  });

  // ---- Links: the visit, claim or treatment plan a document belongs with (same practice, same patient) ----
  async function checkLinks(req, patientId, b) {
    const row = {};
    const one = async (key, table, label) => {
      if (b[key] === undefined) return;
      const id = idOrNull(b[key]);
      if (id === null) { row[key] = null; return; }
      if (!patientId) throw new HttpError(400, 'Office documents can’t be linked to a patient’s records');
      const found = await findOr404(db, table, id, pid(req), label);
      if (found.patient_id !== patientId) throw new HttpError(400, `That ${label.toLowerCase()} is another patient’s`);
      row[key] = found.id;
    };
    await one('appointment_id', 'appointments', 'Visit');
    await one('claim_id', 'claims', 'Claim');
    await one('treatment_plan_id', 'treatment_plans', 'Treatment plan');
    return row;
  }
  r.put('/documents/:did/links', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did, { write: true });
    const row = await checkLinks(req, doc.patient_id, req.body || {});
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to link');
    await recorded(db, 'documents', doc.id, () => db.run(`UPDATE documents SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), doc.id));
    await audit(db, req, 'document.link', 'documents', doc.id, { patient_id: doc.patient_id, ...row });
    changed(doc);
    res.json(docView(await db.get('SELECT * FROM documents WHERE id = ?', doc.id)));
  });
  // What it could be linked to: the patient's recent visits, claims and plans.
  r.get('/documents/:did/link-options', async (req, res) => {
    const doc = await loadDoc(db, req, req.params.did);
    if (!doc.patient_id) return res.json({ appointments: [], claims: [], treatment_plans: [] });
    res.json({
      appointments: await db.all("SELECT id, start_time, status FROM appointments WHERE practice_id = ? AND patient_id = ? AND status NOT IN ('cancelled') ORDER BY start_time DESC LIMIT 30", doc.practice_id, doc.patient_id),
      claims: await db.all('SELECT id, status, total_fee, created_at FROM claims WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 30', doc.practice_id, doc.patient_id),
      treatment_plans: await db.all('SELECT id, name, status, created_at FROM treatment_plans WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 30', doc.practice_id, doc.patient_id),
    });
  });
  r.get('/patients/:id/document-folders', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, pid(req), 'Patient');
    res.json((await db.all('SELECT folder, COUNT(*) AS n FROM documents WHERE practice_id = ? AND patient_id = ? AND deleted_at IS NULL AND folder IS NOT NULL GROUP BY folder ORDER BY folder', pid(req), patient.id)));
  });

  // ---- Search ----
  const auditSearch = (req, results, extra) => audit(db, req, 'document.search', extra.patient_id ? 'patients' : 'documents', extra.patient_id || null, {
    ...extra, results: results.length, ids: results.slice(0, 50).map((d) => d.id), query_words: String(req.query.q || '').trim().split(/\s+/).filter(Boolean).length,
  });
  r.get('/patients/:id/documents/search', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, pid(req), 'Patient');
    const results = await searchDocuments(db, storage, config, { practiceId: pid(req), q: String(req.query.q || ''), where: ' AND d.patient_id = ?', args: [patient.id], limit: 100 });
    await auditSearch(req, results, { patient_id: patient.id });
    res.json(results);
  });
  // Practice-wide (the command bar, the Documents screen). ?scope=patients|office|all. Office access applies:
  // patients the person can't see, and other offices' office documents, never show.
  r.get('/documents/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const scope = ['patients', 'office', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    const parts = [];
    const args = [];
    if (scope !== 'office' && can(req.user, 'clinical:read')) {
      const s = patientScope(req.user, 'sp');
      parts.push(`(d.patient_id IS NOT NULL${s.sql ? ` AND EXISTS (SELECT 1 FROM patients sp WHERE sp.id = d.patient_id${s.sql})` : ''})`);
      args.push(...s.args);
    }
    if (scope !== 'patients' && can(req.user, OFFICE_READ)) {
      const locs = restricted(req.user) ? req.user.location_ids : null;
      parts.push(`(d.patient_id IS NULL AND d.inbox = 0${locs ? ` AND (d.location_id IS NULL OR d.location_id IN (${locs.map(() => '?').join(',')}))` : ''})`);
      if (locs) args.push(...locs);
    }
    if (!parts.length) throw new HttpError(403, 'Missing permission: clinical:read');
    // The office the screen is working in narrows it further when asked (?location_id=).
    let where = ` AND (${parts.join(' OR ')})`;
    if (req.query.location_id) {
      const loc = Number(req.query.location_id);
      if (!Number.isInteger(loc) || (restricted(req.user) && !req.user.location_ids.includes(loc))) throw new HttpError(403, "That office isn't one of yours");
      where += ' AND (d.location_id = ? OR d.location_id IS NULL)';
      args.push(loc);
    }
    const results = await searchDocuments(db, storage, config, { practiceId: pid(req), q, where, args, limit: Math.min(Number(req.query.limit) || 25, 100) });
    await auditSearch(req, results, { scope });
    res.json(results.map((d) => ({ ...d, link: d.patient_id ? `/patients/${d.patient_id}?tab=documents&doc=${d.id}` : `/documents?doc=${d.id}` })));
  });

  // ---- Office documents (no patient): contracts, licences, policies, invoices… ----
  const remindExpiring = (practiceId) => remindExpiringDocuments(db, practiceId);
  const officeList = async (req, { inbox = false } = {}) => {
    const conds = ['d.practice_id = ?', 'd.patient_id IS NULL', `d.inbox = ${inbox ? 1 : 0}`];
    const args = [pid(req)];
    if (!flag(req.query.removed)) conds.push('d.deleted_at IS NULL');
    else conds.push('d.deleted_at IS NOT NULL');
    if (!inbox && restricted(req.user)) {
      conds.push(`(d.location_id IS NULL OR d.location_id IN (${req.user.location_ids.map(() => '?').join(',')}))`);
      args.push(...req.user.location_ids);
    }
    if (req.query.category) { conds.push('d.category = ?'); args.push(String(req.query.category)); }
    if (req.query.folder) { conds.push('d.folder = ?'); args.push(String(req.query.folder)); }
    if (flag(req.query.expiring)) { conds.push('d.expires_on IS NOT NULL AND d.expires_on <= ?'); args.push(new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10)); }
    const rows = await db.all(
      `SELECT d.*, u.name AS uploaded_by_name, (SELECT COUNT(*) FROM document_notes n WHERE n.document_id = d.id AND n.status = 'active') AS note_count
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE ${conds.join(' AND ')} ORDER BY d.id DESC LIMIT 1000`, ...args,
    );
    return rows.map(docView);
  };
  r.get('/office-documents', async (req, res) => {
    if (!can(req.user, OFFICE_READ)) throw new HttpError(403, 'Office documents are for managers — ask an administrator for access');
    await remindExpiring(pid(req));
    res.json(await officeList(req));
  });
  r.get('/office-documents/folders', async (req, res) => {
    if (!can(req.user, OFFICE_READ)) throw new HttpError(403, 'Office documents are for managers — ask an administrator for access');
    res.json(await db.all('SELECT folder, COUNT(*) AS n FROM documents WHERE practice_id = ? AND patient_id IS NULL AND inbox = 0 AND deleted_at IS NULL AND folder IS NOT NULL GROUP BY folder ORDER BY folder', pid(req)));
  });
  r.post(
    '/office-documents',
    (req, _res, next) => (can(req.user, OFFICE_WRITE) ? next() : next(new HttpError(403, 'Adding office documents needs the office documents permission'))),
    (req, res, next) => express.raw({ type: () => true, limit: readLimitFor(String(req.query.filename || '')) })(req, res, next),
    async (req, res) => {
      const expires = req.query.expires_on ? String(req.query.expires_on) : null;
      if (expires && !isRealDate(expires)) throw new HttpError(400, 'expires_on must be a real date (YYYY-MM-DD)');
      const out = await storeUpload(db, storage, {
        req, practiceId: pid(req), patientId: null, scope: 'office', body: req.body, filename: String(req.query.filename || 'document'),
        declared: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), category: req.query.category || 'document',
        notes: req.query.notes, uploadedBy: req.user.id, scanner,
        extra: { folder: cleanFolder(req.query.folder), expires_on: expires, taken_at: isRealDate(req.query.taken_at) ? req.query.taken_at : null },
      });
      queueRead(db, storage, config, reader, out.id);
      publish(pid(req), { type: 'office-documents' });
      res.status(201).json(docView(await db.get('SELECT * FROM documents WHERE id = ?', out.id)));
    },
  );

  // ---- Scan inbox: scans from a scan folder that couldn't be matched to a patient ----
  r.get('/document-inbox', requirePermission('clinical:write'), async (req, res) => {
    res.json(await officeList(req, { inbox: true }));
  });
  r.post('/document-inbox/:did/file', requirePermission('clinical:write'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, pid(req), 'Scan');
    if (!doc.inbox || doc.patient_id) throw new HttpError(409, 'That scan was already filed');
    const patient = await findOr404(db, 'patients', req.body?.patient_id, pid(req), 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const category = req.body?.category ? String(req.body.category) : doc.suggested_category || doc.category;
    if (!PATIENT_CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${PATIENT_CATEGORIES.join(', ')}`);
    const done = await recorded(db, 'documents', doc.id, () => db.run('UPDATE documents SET patient_id = ?, inbox = 0, category = ?, location_id = COALESCE(location_id, ?) WHERE id = ? AND inbox = 1 AND patient_id IS NULL', patient.id, category, patient.location_id ?? null, doc.id));
    if (!done.changes) throw new HttpError(409, 'That scan was already filed');
    await db.run('UPDATE document_notes SET patient_id = ? WHERE document_id = ?', patient.id, doc.id);
    await audit(db, req, 'document.file_from_inbox', 'documents', doc.id, { patient_id: patient.id, category, filename: doc.filename });
    publish(pid(req), { type: 'documents', patient_id: patient.id });
    publish(pid(req), { type: 'document-inbox' });
    res.json(docView(await db.get('SELECT * FROM documents WHERE id = ?', doc.id)));
  });

  // ---- Scanning on a workstation's desk scanner (through its imaging bridge) ----
  const scannerView = (a) => ({ id: a.id, name: a.name, hostname: a.hostname, online: agentOnline(a), scanner: a.scanner, info: parseJson(a.scanner_info) || {} });
  r.get('/scanners', requirePermission('clinical:read'), async (req, res) => {
    res.json((await db.all('SELECT * FROM bridge_agents WHERE practice_id = ? AND active = 1 AND scanner IS NOT NULL ORDER BY name', pid(req))).map(scannerView));
  });
  const cleanScanOptions = (b = {}, info = {}) => {
    const source = SCAN_SOURCES.includes(b.source) ? b.source : 'auto';
    const color = SCAN_COLORS.includes(b.color) ? b.color : 'gray';
    const format = SCAN_FORMATS.includes(b.format) ? b.format : 'pdf';
    const dpi = Number(b.dpi) || 300;
    if (![100, 150, 200, 300, 400, 600].includes(dpi)) throw new HttpError(400, 'dpi must be 100, 150, 200, 300, 400 or 600');
    if (source === 'feeder' && info.feeder === false) throw new HttpError(400, 'That scanner has no document feeder');
    return { source, color, format, dpi, duplex: flag(b.duplex) && source !== 'flatbed' && info.duplex !== false };
  };
  // "Scan now" for the active patient: the bridge on that workstation scans, makes one PDF (or JPGs) and files it here.
  r.post('/patients/:id/scan', requireAnyPermission('clinical:write', 'documents:add'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, pid(req), 'Patient');
    await refuseTraining(db, patient.id, 'a scan order to the imaging workstation');
    const agent = await findOr404(db, 'bridge_agents', req.body?.agent_id, pid(req), 'Workstation');
    if (!agent.active) throw new HttpError(409, 'That workstation was removed');
    if (!agent.scanner) throw new HttpError(400, `No scanner is set up in the imaging bridge on ${agent.name}`);
    if (!agentOnline(agent)) throw new HttpError(409, `The bridge on ${agent.name} is offline — is the computer on?`);
    const category = req.body?.category ? String(req.body.category) : 'document';
    if (!PATIENT_CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${PATIENT_CATEGORIES.join(', ')}`);
    const options = cleanScanOptions(req.body, parseJson(agent.scanner_info) || {});
    const busy = await db.get("SELECT id FROM bridge_commands WHERE agent_id = ? AND type = 'scan' AND status IN ('pending','delivered') AND created_at > ?", agent.id, new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19).replace('T', ' '));
    if (busy) throw new HttpError(409, `${agent.name}’s scanner is busy with another scan — wait for it to finish`);
    const folder = cleanFolder(req.body?.folder);
    const payload = { patient: { id: patient.id, first_name: patient.first_name, last_name: patient.last_name }, options, category, folder, name: cleanName(req.body?.name) };
    const id = await insert(db, 'bridge_commands', { practice_id: pid(req), agent_id: agent.id, patient_id: patient.id, type: 'scan', payload: JSON.stringify(payload), created_by: req.user.id });
    await audit(db, req, 'document.scan_request', 'patients', patient.id, { agent: agent.name, command_id: id, ...options, category });
    res.status(201).json({ id, status: 'pending', workstation: agent.name, scanner: agent.scanner, options });
  });
  r.get('/scans/:cid', requirePermission('clinical:read'), async (req, res) => {
    const c = await findOr404(db, 'bridge_commands', req.params.cid, pid(req), 'Scan');
    if (c.type !== 'scan') throw new HttpError(404, 'Scan not found');
    if (!(await canSeePatient(db, req.user, c.patient_id))) throw new HttpError(404, 'Scan not found');
    const docs = await db.all('SELECT id, filename, mime, category FROM documents WHERE practice_id = ? AND source = ? AND deleted_at IS NULL ORDER BY id', pid(req), `scan:${c.id}`);
    // A scan the bridge never picked up (offline, or an old bridge without scanning) doesn't wait forever.
    const age = Date.now() - Date.parse(`${c.created_at.replace(' ', 'T')}Z`);
    const status = c.status === 'pending' && age > 120_000 ? 'expired' : c.status;
    res.json({ id: c.id, status, result: c.result, progress: parseJson(c.progress), documents: docs, patient_id: c.patient_id });
  });

  return r;
}

export function cleanFolder(v) {
  const f = String(v ?? '').replace(/[\u0000-\u001f\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return f || null;
}
const cleanName = (v) => {
  const n = String(v ?? '').replace(/[^\w.\- ()]/g, '_').trim().slice(0, 80);
  return n || null;
};

// Licences and contracts with an expiry date get a to-do for the person who added them (or the office
// manager) 60 days ahead; one reminder per date — a new date (renewed) gets a new reminder.
export async function remindExpiringDocuments(db, practiceId) {
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const horizon = new Date(Date.parse(today) + 60 * 86400_000).toISOString().slice(0, 10);
  const due = await db.all('SELECT * FROM documents WHERE practice_id = ? AND patient_id IS NULL AND inbox = 0 AND deleted_at IS NULL AND expires_on IS NOT NULL AND expires_on <= ? AND expiry_task_id IS NULL', practiceId, horizon);
  for (const d of due) {
    const owner = d.uploaded_by ? await db.get('SELECT id FROM users WHERE id = ? AND active = 1', d.uploaded_by) : null;
    const soon = d.expires_on <= new Date(Date.parse(today) + 14 * 86400_000).toISOString().slice(0, 10);
    const taskId = await db.tx(async () => {
      // Lock the row first (a no-op update: Postgres holds the row until commit and re-checks the condition) so
      // two runs at once — the hourly job and someone opening the list — can't both make a to-do.
      const claimed = await db.run('UPDATE documents SET expiry_task_id = NULL WHERE id = ? AND expiry_task_id IS NULL', d.id);
      if (!claimed.changes) return null;
      const t = await insert(db, 'tasks', {
        practice_id: practiceId, assigned_to: owner?.id ?? null, priority: soon ? 'high' : 'normal',
        due_date: new Date(Math.max(Date.parse(today), Date.parse(d.expires_on) - 30 * 86400_000)).toISOString().slice(0, 10),
        title: `${d.expires_on < today ? 'Expired' : 'Expires'} ${d.expires_on}: renew ${CATEGORY_LABELS[d.category]?.toLowerCase() || 'document'} “${d.filename}”`.slice(0, 200),
        notes: `Open: /documents?doc=${d.id}`,
      });
      await db.run('UPDATE documents SET expiry_task_id = ? WHERE id = ?', t, d.id);
      return t;
    });
    if (taskId) await audit(db, null, 'document.expiry_reminder', 'documents', d.id, { task_id: taskId, expires_on: d.expires_on });
  }
  return due.length;
}
