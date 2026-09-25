// Shared by every way a document arrives (the chart, office documents, a desk scanner through the bridge, a
// scan folder) and every screen that opens one: the checks an upload goes through, who may open which
// document, and reading its text in the background (ocr.js) so it can be searched and filed.
import { createHash } from 'node:crypto';
import { HttpError, can } from './auth.js';
import { insert, audit, findOr404, validTooth } from './util.js';
import { classify } from './filetypes.js';
import { checkUpload } from './virusscan.js';
import { referralDocumentFiled } from './referraltracker.js';
import { inspectUpload } from './volume.js';
import { extractText, suggestCategory, findExpiry, aiReadable, PATIENT_CATEGORIES, OFFICE_CATEGORIES } from './ocr.js';
import { indexDocument } from './docsearch.js';
import { publish } from './events.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor } from './actor.js';
import { restricted, canSeePatient } from './officeaccess.js';

export { PATIENT_CATEGORIES, OFFICE_CATEGORIES };
export const ALL_CATEGORIES = [...new Set([...PATIENT_CATEGORIES, ...OFFICE_CATEGORIES])];
// Office documents (no patient) need their own permission. Until these are in PERMISSION_CATALOG (auth.js),
// only administrators have them.
export const OFFICE_READ = 'officedocs:read';
export const OFFICE_WRITE = 'officedocs:write';

// The document, if this person may open (or change) it; 404 otherwise, as if it didn't exist.
// How long someone with only documents:add can take back (Undo) a file they just added.
export const OWN_UNDO_MINUTES = 15;
export async function loadDoc(db, req, id, { write = false, allowDeleted = false, ownUndo = false } = {}) {
  const doc = await findOr404(db, 'documents', id, req.user.practice_id, 'Document');
  if (doc.deleted_at && !allowDeleted) throw new HttpError(404, 'Document not found');
  if (doc.patient_id != null) {
    const need = write ? 'clinical:write' : 'clinical:read';
    const added = doc.created_at instanceof Date ? doc.created_at.getTime()
      : Date.parse(`${String(doc.created_at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(String(doc.created_at)) ? '' : 'Z'}`);
    const justAdded = ownUndo && can(req.user, 'documents:add') && doc.uploaded_by === req.user.id && added > Date.now() - OWN_UNDO_MINUTES * 60_000;
    if (!can(req.user, need) && !justAdded) {
      throw new HttpError(403, write && can(req.user, 'documents:add')
        ? 'You can add documents to a chart; changing or removing them needs a clinical login (a dentist, hygienist or assistant)'
        : `Missing permission: ${need}`);
    }
    if (!(await canSeePatient(db, req.user, doc.patient_id))) throw new HttpError(404, 'Document not found');
    return doc;
  }
  if (doc.inbox) {
    // Unfiled scans: whoever files documents into charts.
    if (!can(req.user, 'clinical:write')) throw new HttpError(404, 'Document not found');
    return doc;
  }
  if (!can(req.user, write ? OFFICE_WRITE : OFFICE_READ)) throw new HttpError(404, 'Document not found');
  if (restricted(req.user) && doc.location_id != null && !req.user.location_ids.includes(doc.location_id)) throw new HttpError(404, 'Document not found');
  return doc;
}

// Everything an upload goes through before it's kept: what it really is (not what it's called), size for
// its kind, the virus scan, CBCT/scan zips checked, then encrypted into storage and recorded. Returns the id.
// o: { req, practiceId, patientId (null for office/inbox), body, filename, declared, category, tooth, notes,
//      uploadedBy, source, extra (more columns), scope: 'patient'|'office', scanner, auditAction, auditOpts }
export async function storeUpload(db, storage, o) {
  const { body } = o;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Empty upload');
  const type = classify(body, o.filename, o.declared);
  // A zip must be a CBCT series or a set of scans (never arbitrary files); it's filed as an x-ray or photo.
  const scan = type.mime === 'application/zip' || type.mime.startsWith('model/') ? inspectUpload(body, type.filename) : null;
  if (type.mime === 'application/zip' && !scan) throw new HttpError(415, 'That zip isn’t a CBCT series or a 3D scan');
  const scope = o.scope || (o.patientId ? 'patient' : 'office');
  const allowed = scope === 'office' ? OFFICE_CATEGORIES : PATIENT_CATEGORIES;
  const category = String(o.category || scan?.category || 'document');
  if (!allowed.includes(category)) throw new HttpError(400, `category must be one of ${allowed.join(', ')}`);
  const tooth = o.tooth ? String(o.tooth).toUpperCase() : null;
  if (!validTooth(tooth)) throw new HttpError(400, 'tooth must be 1-32 or A-T');
  const virus = await checkUpload(db, o.scanner, body, { req: o.req, practiceId: o.practiceId, patientId: o.patientId || null, filename: type.filename });
  const { storageKey, encrypted } = await storage.save(o.practiceId, body);
  const id = await insert(db, 'documents', {
    practice_id: o.practiceId, patient_id: o.patientId || null, category, filename: type.filename, mime: type.mime, size: body.length,
    storage_key: storageKey, encrypted: encrypted ? 1 : 0, tooth, notes: o.notes ? String(o.notes).slice(0, 500) : null,
    uploaded_by: o.uploadedBy ?? null, source: o.source || null, source_hash: createHash('sha256').update(body).digest('hex'), virus_status: virus,
    ...(o.extra || {}),
  });
  await audit(db, o.req, o.auditAction || 'document.upload', 'documents', id, { patient_id: o.patientId || null, category, mime: type.mime, size: body.length, virus_scan: virus }, o.auditOpts || {});
  return { id, mime: type.mime, category, kind: type.kind };
}

// ---- Reading text in the background ----
// One at a time per server, in the order they arrived; a document already waiting isn't queued twice.
const waiting = new Set();
let chain = Promise.resolve();
export function queueRead(db, storage, config, reader, docId, opts = {}) {
  if (waiting.has(docId)) return chain;
  waiting.add(docId);
  chain = chain.then(() => readDocument(db, storage, config, reader, docId, opts)).catch((err) => console.error('Document reading failed:', err.message)).finally(() => waiting.delete(docId));
  return chain;
}
export const readsIdle = () => chain;

// Kinds read as pictures only when a person would want them searchable (paperwork, not x-rays and photos).
const PAPERWORK = (doc) => !['xray', 'photo'].includes(doc.category) || doc.patient_id == null;

export async function readDocument(db, storage, config, reader, docId, { force = false, requestedBy = null } = {}) {
  const doc = await db.get('SELECT * FROM documents WHERE id = ?', docId);
  if (!doc || doc.deleted_at) return null;
  if (doc.ocr_status && !force && doc.ocr_status !== 'pending') return doc.ocr_status;
  const scope = doc.patient_id == null && !doc.inbox ? 'office' : 'patient';
  const practice = await db.get('SELECT document_ai FROM practices WHERE id = ?', doc.practice_id);
  let data;
  try {
    data = await storage.read(doc.storage_key, !!doc.encrypted);
  } catch (err) {
    await db.run("UPDATE documents SET ocr_status = 'failed', ocr_error = ? WHERE id = ?", String(err.message).slice(0, 200), doc.id);
    return 'failed';
  }
  if (!data) return null;
  let { text, source } = extractText(doc.mime, data);
  let ai = null;
  const canAi = reader && reader.mode !== 'off' && !!practice?.document_ai && aiReadable(doc.mime, data.length) && PAPERWORK(doc);
  if (!text && canAi) {
    try {
      ai = await withActor({ source: reader.mode === 'ai' ? 'ai' : 'automation', actor: reader.name || 'Document reader', practiceId: doc.practice_id }, () => reader.read({ mime: doc.mime, data, filename: doc.filename, scope }));
      text = ai?.text || '';
      source = reader.mode;
      await resolveIssue(db, doc.practice_id, `docread:${doc.practice_id}`, 'Resolved automatically: documents are being read again');
    } catch (err) {
      await db.run("UPDATE documents SET ocr_status = 'failed', ocr_error = ? WHERE id = ?", String(err.message).slice(0, 200), doc.id);
      await raiseIssue(db, {
        practiceId: doc.practice_id, kind: 'ai', key: `docread:${doc.practice_id}`, role: 'admin', entity: 'documents', entityId: doc.id, patientId: doc.patient_id,
        title: 'Scanned documents aren’t being read for search', detail: `${doc.filename}: ${err.message}. Use “Read text again” on the document once the AI is back.`,
      });
      return 'failed';
    }
  }
  const row = { ocr_at: new Date().toISOString().slice(0, 19).replace('T', ' '), ocr_error: null };
  if (text) {
    const saved = await storage.save(doc.practice_id, Buffer.from(text, 'utf8'));
    Object.assign(row, { ocr_status: 'done', ocr_source: source, ocr_key: saved.storageKey, ocr_encrypted: saved.encrypted ? 1 : 0, ocr_chars: text.length });
    await indexDocument(db, config, doc, text);
  } else {
    Object.assign(row, { ocr_status: canAi || source ? 'none' : 'skipped', ocr_source: source || null });
  }
  // What it looks like: the AI's reading when it read it, else the file name and words.
  const local = suggestCategory({ filename: doc.filename, text, mime: doc.mime, scope });
  const suggestion = ai?.category ? { category: ai.category, reason: ai.reason || 'Suggested by the AI reader', source: 'ai' } : local ? { ...local, source: 'rules' } : null;
  if (suggestion && suggestion.category !== doc.category) Object.assign(row, { suggested_category: suggestion.category, suggestion_reason: suggestion.reason, suggestion_source: suggestion.source });
  else Object.assign(row, { suggested_category: null, suggestion_reason: null, suggestion_source: null });
  if (scope === 'office' && !doc.expires_on) {
    const exp = ai?.expires_on || findExpiry(text);
    if (exp) row.expires_on = exp;
  }
  await db.run(`UPDATE documents SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), doc.id);
  if (ai) {
    // The AI's part is on record (source: ai), with its plain-language reason; nothing it suggests is applied.
    await withActor({ source: 'ai', actor: `${reader.name || 'AI document reader'}${requestedBy ? ` (for ${requestedBy})` : ''}`, practiceId: doc.practice_id }, () => audit(db, null, 'document.ai_read', 'documents', doc.id, {
      patient_id: doc.patient_id, chars: text.length, suggested: suggestion?.category || null, mode: reader.mode,
    }, { reason: suggestion?.reason || null, patientId: doc.patient_id, source: 'ai' }));
  }
  if (doc.patient_id) publish(doc.practice_id, { type: 'documents', patient_id: doc.patient_id });
  else publish(doc.practice_id, { type: 'office-documents' });
  // A specialist's letter or report: suggest the open referral it answers (referraltracker.js; never throws).
  if (doc.patient_id) await referralDocumentFiled(db, storage, config, doc.id);
  return row.ocr_status;
}

// A short, safe view of a document row for lists.
export function docView(d) {
  let tags = [];
  try { tags = JSON.parse(d.tags || '[]'); } catch { tags = []; }
  return {
    id: d.id, patient_id: d.patient_id, category: d.category, filename: d.filename, mime: d.mime, size: d.size, tooth: d.tooth, notes: d.notes, source: d.source,
    taken_at: d.taken_at, created_at: d.created_at, tags, folder: d.folder || null, location_id: d.location_id ?? null,
    appointment_id: d.appointment_id ?? null, claim_id: d.claim_id ?? null, treatment_plan_id: d.treatment_plan_id ?? null,
    ocr_status: d.ocr_status || null, ocr_source: d.ocr_source || null, has_text: !!d.ocr_key,
    suggested_category: d.suggested_category || null, suggestion_reason: d.suggestion_reason || null, suggestion_source: d.suggestion_source || null,
    review_status: d.review_status || null, review_assignee: d.review_assignee ?? null, review_note: d.review_note || null,
    reviewed_at: d.reviewed_at || null, expires_on: d.expires_on || null, virus_status: d.virus_status || null, inbox: !!d.inbox,
    deleted_at: d.deleted_at || null, uploaded_by_name: d.uploaded_by_name, note_count: d.note_count ?? undefined,
  };
}

// Decrypted files are kept for a couple of minutes when large (audio/video play as many small range requests),
// at most a few hundred MB in all, so a video isn't decrypted again for every few seconds of playback.
const fileCache = new Map();
const CACHE_MS = 120_000;
const CACHE_BYTES = 600 * 1024 * 1024;
export async function readFile(storage, doc) {
  const hit = fileCache.get(doc.storage_key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await storage.read(doc.storage_key, !!doc.encrypted);
  if (!data) throw new HttpError(404, 'File missing from storage');
  if (data.length > 2 * 1024 * 1024) {
    const now = Date.now();
    for (const [k, v] of fileCache) if (now - v.at >= CACHE_MS) fileCache.delete(k);
    let total = [...fileCache.values()].reduce((s, v) => s + v.data.length, 0);
    for (const [k, v] of fileCache) {
      if (total + data.length <= CACHE_BYTES) break;
      fileCache.delete(k);
      total -= v.data.length;
    }
    if (data.length <= CACHE_BYTES) fileCache.set(doc.storage_key, { data, at: now });
  }
  return data;
}

// "bytes=0-1023" → { start, end } within the file; null for no (or a multi-part) range; false when unsatisfiable.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return false;
  return { start, end };
}

// Sends a document's bytes, whole or the requested range (audio/video seeking). Returns true when this was the
// start of a viewing (no range, or a range from byte 0) — the caller audits those only.
const INLINE = /^(image\/|application\/pdf$|audio\/|video\/|text\/plain$|text\/csv$|application\/dicom$|model\/)/;
export function sendFile(req, res, doc, data) {
  const range = parseRange(req.headers.range, data.length);
  const inline = !req.query.download && INLINE.test(doc.mime);
  res.set({
    'Content-Type': /^text\//.test(doc.mime) ? `${doc.mime}; charset=utf-8` : doc.mime,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${doc.filename.replace(/"/g, '')}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  if (range === false) {
    res.status(416).set('Content-Range', `bytes */${data.length}`).end();
    return false;
  }
  if (!range) {
    res.set('Content-Length', data.length).send(data);
    return true;
  }
  res.status(206).set({ 'Content-Range': `bytes ${range.start}-${range.end}/${data.length}`, 'Content-Length': range.end - range.start + 1 });
  res.end(data.subarray(range.start, range.end + 1));
  return range.start === 0;
}
