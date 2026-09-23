import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, requireOneOf, validTooth } from '../util.js';
import { sniffMime } from './imaging.js';

const CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'other'];
const ALLOWED = /^(image\/(png|jpeg|gif|webp|bmp|tiff)|application\/pdf|application\/dicom|text\/plain)$/;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Patient documents & imaging. Files are uploaded as the raw request body.
export default function documentRoutes({ db, storage }) {
  const r = Router();

  r.get('/patients/:id/documents', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      `SELECT d.id, d.category, d.filename, d.mime, d.size, d.tooth, d.notes, d.source, d.taken_at, d.created_at, u.name AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.practice_id = ? AND d.patient_id = ? AND d.deleted_at IS NULL ORDER BY d.id DESC`,
      req.user.practice_id, patient.id,
    ));
  });

  r.post(
    '/patients/:id/documents',
    requirePermission('clinical:write'),
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
      // Go by the file's contents: browsers send DICOM (and often TIFF) as application/octet-stream,
      // and a declared type isn't proof of what the file is.
      const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const mime = sniffMime(req.body, String(req.query.filename || '')) || (declared === 'text/plain' ? declared : null);
      if (!mime || !ALLOWED.test(mime)) throw new HttpError(415, 'Only images, PDFs, DICOM and text files can be uploaded');
      const category = String(req.query.category || 'document');
      requireOneOf(category, CATEGORIES, 'category');
      const tooth = req.query.tooth ? String(req.query.tooth).toUpperCase() : null;
      if (!validTooth(tooth)) throw new HttpError(400, 'tooth must be 1-32 or A-T');
      const filename = String(req.query.filename || 'upload').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
      const { storageKey, encrypted } = await storage.save(req.user.practice_id, req.body);
      const id = await insert(db, 'documents', {
        practice_id: req.user.practice_id, patient_id: patient.id, category, filename, mime, size: req.body.length,
        storage_key: storageKey, encrypted: encrypted ? 1 : 0, tooth, notes: req.query.notes ? String(req.query.notes).slice(0, 500) : null,
        uploaded_by: req.user.id,
      });
      await audit(db, req, 'document.upload', 'documents', id, { patient_id: patient.id, category });
      res.status(201).json(await db.get('SELECT id, category, filename, mime, size, tooth, notes, created_at FROM documents WHERE id = ?', id));
    },
  );

  r.get('/documents/:did/file', requirePermission('clinical:read'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    const data = await storage.read(doc.storage_key, !!doc.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    await audit(db, req, 'document.view', 'documents', doc.id, { patient_id: doc.patient_id });
    res.set({
      'Content-Type': doc.mime,
      'Content-Length': data.length,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${doc.filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    res.send(data);
  });

  // Soft delete: the file is retained for record-keeping but hidden from the chart.
  r.delete('/documents/:did', requirePermission('clinical:write'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    await db.run("UPDATE documents SET deleted_at = datetime('now') WHERE id = ?", doc.id);
    await audit(db, req, 'document.delete', 'documents', doc.id, { patient_id: doc.patient_id });
    res.json({ ok: true });
  });

  return r;
}
