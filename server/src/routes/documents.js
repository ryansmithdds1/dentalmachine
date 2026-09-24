import express, { Router } from 'express';
import { autoAnalyze } from '../xrayai.js';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, requireOneOf, validTooth, newToken } from '../util.js';
import { sniffMime } from './imaging.js';
import { dicomToImage } from '../dicomimage.js';
import { makeThumbnail, imageSize } from '../thumbnails.js';
import { publish } from '../events.js';
import { buildRecordExport } from '../recordexport.js';

// Mount layouts (FMX etc.): how many images each holds; the client draws the slots.
export const MOUNT_TEMPLATES = { fmx18: 18, fmx20: 20, fmx14: 14, bw4: 4, bw2: 2, vbw7: 7, pa1: 1, pa2: 2, pa4: 4, pano1: 1, photos8: 8 };
// How many points each kind of mark keeps: an angle is vertex + two arms; a polyline follows a curved
// canal or root for its length.
const ANNOTATION_POINTS = { line: 2, arrow: 2, measure: 2, text: 1, circle: 2, angle: 3, polyline: 40 };
const ANNOTATION_TYPES = Object.keys(ANNOTATION_POINTS);

// Non-destructive viewing adjustments saved with an image (the original pixels are never changed).
const ADJUST_RANGES = { brightness: [-100, 100], contrast: [-100, 100], gamma: [0.2, 5], sharpen: [0, 3], denoise: [0, 3], clahe: [0, 4] };
const ADJUST_FLAGS = ['invert', 'equalize', 'stretch', 'emboss', 'flipH', 'flipV'];
const COLORMAPS = ['none', 'heat', 'bone', 'spectrum'];
export function cleanAdjust(a) {
  if (a == null) return null;
  if (typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, 'adjust must be an object');
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(ADJUST_RANGES)) {
    if (a[k] === undefined || a[k] === null) continue;
    const n = Number(a[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
    out[k] = Math.round(n * 100) / 100;
  }
  for (const k of ADJUST_FLAGS) if (a[k]) out[k] = true;
  if (a.rotate !== undefined && a.rotate !== null) {
    const r = ((Math.round(Number(a.rotate) / 90) * 90) % 360 + 360) % 360;
    if (!Number.isFinite(r)) throw new HttpError(400, 'rotate must be a multiple of 90');
    if (r) out.rotate = r;
  }
  if (a.colormap && a.colormap !== 'none') {
    if (!COLORMAPS.includes(a.colormap)) throw new HttpError(400, `colormap must be one of ${COLORMAPS.join(', ')}`);
    out.colormap = a.colormap;
  }
  return Object.keys(out).length ? out : null;
}
// Exposure record for an x-ray: settings used and the sensor, for the radiation log.
export function cleanExposure(e) {
  if (e == null) return null;
  if (typeof e !== 'object' || Array.isArray(e)) throw new HttpError(400, 'exposure must be an object');
  const num = (k, lo, hi) => {
    if (e[k] === undefined || e[k] === null || e[k] === '') return undefined;
    const n = Number(e[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
    return n;
  };
  const out = { kvp: num('kvp', 40, 150), ma: num('ma', 0.1, 20), seconds: num('seconds', 0.005, 20) };
  if (e.sensor) out.sensor = String(e.sensor).slice(0, 60);
  if (e.size) out.size = String(e.size).slice(0, 10);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}
const parseJson = (v) => (v ? JSON.parse(v) : null);

const CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'other'];
const ALLOWED = /^(image\/(png|jpeg|gif|webp|bmp|tiff)|application\/pdf|application\/dicom|text\/plain)$/;
// Tags: short labels to find documents by ("pre-op", "ortho records", "insurance"), stored as a JSON list.
export function cleanTags(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean);
  const unique = [...new Set(list)].slice(0, 12);
  return unique.length ? JSON.stringify(unique) : null;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Patient documents & imaging. Files are uploaded as the raw request body.
export default function documentRoutes({ db, storage, config = {} }) {
  const r = Router();

  // The patient's copy of their record (HIPAA right of access): summary PDF, the data, and their files.
  r.get('/patients/:id/record-export', requirePermission('clinical:read'), requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const out = await buildRecordExport(db, storage, req.user.practice_id, patient.id);
    await audit(db, req, 'patient.record_export', 'patients', patient.id, { files: out.files });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${out.filename}"` }).send(out.zip);
  });

  r.get('/patients/:id/documents', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json((await db.all(
      `SELECT d.id, d.category, d.filename, d.mime, d.size, d.tooth, d.notes, d.source, d.taken_at, d.created_at, d.tags, d.adjust, d.exposure, d.retake_of, u.name AS uploaded_by_name,
         CASE WHEN d.annotations IS NOT NULL AND d.annotations != '[]' THEN 1 ELSE 0 END AS annotated
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.practice_id = ? AND d.patient_id = ? AND d.deleted_at IS NULL ORDER BY d.id DESC`,
      req.user.practice_id, patient.id,
    )).map((d) => ({ ...d, adjust: parseJson(d.adjust), exposure: parseJson(d.exposure) })));
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
      if (category === 'xray') autoAnalyze(db, id);
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

  // The image as a browser can show it: DICOM is converted (PNG, or its embedded JPEG); other images as they are.
  const viewable = async (doc) => {
    const data = await storage.read(doc.storage_key, !!doc.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    if (doc.mime === 'application/dicom') {
      const img = dicomToImage(data);
      if (!img) throw new HttpError(415, 'This DICOM image is compressed in a way the viewer can’t show — download it to open in your imaging software');
      return img;
    }
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(doc.mime)) throw new HttpError(415, 'Not an image the viewer can show');
    return { mime: doc.mime, data, pixelSpacing: null };
  };

  r.get('/documents/:did/image', requirePermission('clinical:read'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    const img = await viewable(doc);
    await audit(db, req, 'document.view', 'documents', doc.id, { patient_id: doc.patient_id });
    res.set({ 'Content-Type': img.mime, 'Content-Length': img.data.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(img.data);
  });

  // What the viewer needs besides the pixels: saved annotations and the mm-per-pixel scale for measuring
  // (from the DICOM header when there is one, else what the user calibrated).
  r.get('/documents/:did/viewer', requirePermission('clinical:read'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    let spacing = null;
    if (doc.mime === 'application/dicom') {
      try { spacing = (await viewable(doc)).pixelSpacing?.[0] || null; } catch { spacing = null; }
    }
    res.json({
      id: doc.id, annotations: JSON.parse(doc.annotations || '[]'), mm_per_px: doc.mm_per_px || spacing, scale_source: doc.mm_per_px ? (doc.scale_source || 'calibrated') : spacing ? 'dicom' : null,
      adjust: parseJson(doc.adjust), exposure: parseJson(doc.exposure), retake_of: doc.retake_of || null, category: doc.category,
      agent_id: /^bridge:\d+$/.test(doc.source || '') ? Number(doc.source.slice(7)) : null,
    });
  });

  // Saved viewing adjustments (brightness, sharpen, invert, rotation…): what the image opens with next time.
  r.put('/documents/:did/adjust', requirePermission('clinical:write'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    const adjust = cleanAdjust(req.body?.adjust);
    await db.run('UPDATE documents SET adjust = ? WHERE id = ?', adjust ? JSON.stringify(adjust) : null, doc.id);
    publish(req.user.practice_id, { type: 'documents', patient_id: doc.patient_id });
    res.json({ ok: true, adjust });
  });

  r.put('/documents/:did/annotations', requirePermission('clinical:write'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    const list = req.body?.annotations;
    if (!Array.isArray(list) || list.length > 200) throw new HttpError(400, 'annotations must be a list of up to 200');
    const clean = list.map((a) => {
      if (!ANNOTATION_TYPES.includes(a?.type)) throw new HttpError(400, `Annotation type must be one of ${ANNOTATION_TYPES.join(', ')}`);
      const points = (Array.isArray(a.points) ? a.points : []).slice(0, ANNOTATION_POINTS[a.type]).map((p) => [Number(p?.[0]), Number(p?.[1])]);
      if (!points.length || points.some((p) => !p.every(Number.isFinite))) throw new HttpError(400, 'Annotation points must be numbers');
      if (a.type === 'angle' && points.length !== 3) throw new HttpError(400, 'An angle needs three points');
      return { type: a.type, points, ...(a.text ? { text: String(a.text).slice(0, 200) } : {}), color: /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#facc15' };
    });
    const mm = req.body?.mm_per_px;
    if (mm !== undefined && mm !== null && !(Number(mm) > 0 && Number(mm) < 10)) throw new HttpError(400, 'mm_per_px must be between 0 and 10');
    if (mm == null) await db.run('UPDATE documents SET annotations = ? WHERE id = ?', JSON.stringify(clean), doc.id);
    else await db.run("UPDATE documents SET annotations = ?, mm_per_px = ?, scale_source = 'calibrated' WHERE id = ?", JSON.stringify(clean), Number(mm), doc.id);
    await audit(db, req, 'document.annotate', 'documents', doc.id, { patient_id: doc.patient_id, count: clean.length });
    res.json({ ok: true, annotations: clean });
  });

  // ---- Mounts (FMX, bitewing sets): images placed in a layout ----
  const mountView = (m) => ({ ...m, slots: JSON.parse(m.slots || '{}') });
  r.get('/patients/:id/mounts', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json((await db.all('SELECT * FROM image_mounts WHERE practice_id = ? AND patient_id = ? ORDER BY taken_at DESC, id DESC', req.user.practice_id, patient.id)).map(mountView));
  });
  r.post('/patients/:id/mounts', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const template = String(req.body?.template || '');
    if (!MOUNT_TEMPLATES[template]) throw new HttpError(400, `template must be one of ${Object.keys(MOUNT_TEMPLATES).join(', ')}`);
    const takenAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.taken_at || '') ? req.body.taken_at : new Date().toISOString().slice(0, 10);
    const id = await insert(db, 'image_mounts', { practice_id: req.user.practice_id, patient_id: patient.id, template, taken_at: takenAt, slots: '{}', created_by: req.user.id });
    await audit(db, req, 'mount.create', 'image_mounts', id, { patient_id: patient.id });
    res.status(201).json(mountView(await db.get('SELECT * FROM image_mounts WHERE id = ?', id)));
  });
  r.put('/mounts/:mid', requirePermission('clinical:write'), async (req, res) => {
    const m = await findOr404(db, 'image_mounts', req.params.mid, req.user.practice_id, 'Mount');
    const slots = req.body?.slots;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw new HttpError(400, 'slots must map slot numbers to images');
    const clean = {};
    for (const [k, v] of Object.entries(slots)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= MOUNT_TEMPLATES[m.template]) throw new HttpError(400, `No slot ${k} in this mount`);
      if (v == null) continue;
      const doc = await db.get('SELECT id FROM documents WHERE id = ? AND patient_id = ? AND deleted_at IS NULL', Number(v), m.patient_id);
      if (!doc) throw new HttpError(404, 'Image not found for this patient');
      clean[i] = doc.id;
    }
    await db.run('UPDATE image_mounts SET slots = ? WHERE id = ?', JSON.stringify(clean), m.id);
    res.json(mountView(await db.get('SELECT * FROM image_mounts WHERE id = ?', m.id)));
  });
  r.delete('/mounts/:mid', requirePermission('clinical:write'), async (req, res) => {
    const m = await findOr404(db, 'image_mounts', req.params.mid, req.user.practice_id, 'Mount');
    await db.run('DELETE FROM image_mounts WHERE id = ?', m.id);
    // Only the layout goes; the images in it stay in the chart.
    await audit(db, req, 'mount.delete', 'image_mounts', m.id, { template: m.template, taken_at: m.taken_at, slots: m.slots }, { patientId: m.patient_id });
    res.json({ ok: true });
  });

  // Grid previews: made here when the format allows, else by the first browser to show the image (below).
  r.get('/documents/:did/thumb', requirePermission('clinical:read'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    let thumb = doc.thumb_key ? { mime: doc.thumb_mime, data: await storage.read(doc.thumb_key, !!doc.thumb_encrypted) } : null;
    if (!thumb?.data) {
      if (!/^image\//.test(doc.mime) && doc.mime !== 'application/dicom') throw new HttpError(404, 'No preview for this file type');
      const data = await storage.read(doc.storage_key, !!doc.encrypted);
      if (!data) throw new HttpError(404, 'File missing from storage');
      thumb = makeThumbnail(doc.mime, data);
      if (!thumb) return res.status(202).json({ client: true }); // not made yet: the browser makes it
      const saved = await storage.save(doc.practice_id, thumb.data);
      await db.run('UPDATE documents SET thumb_key = ?, thumb_mime = ?, thumb_encrypted = ? WHERE id = ?', saved.storageKey, thumb.mime, saved.encrypted ? 1 : 0, doc.id);
    }
    res.set({ 'Content-Type': thumb.mime, 'Content-Length': thumb.data.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(thumb.data);
  });
  // A browser's preview of an image the server can't decode (it only needs making once).
  r.put('/documents/:did/thumb', requirePermission('clinical:write'), express.raw({ type: () => true, limit: 300_000 }), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    if (doc.thumb_key) return res.json({ ok: true, existing: true });
    const size = Buffer.isBuffer(req.body) ? imageSize(req.body) : null;
    if (!size || size.width > 480 || size.height > 480 || !size.width || !size.height) throw new HttpError(400, 'A preview must be a PNG or JPEG no larger than 480 pixels');
    const saved = await storage.save(doc.practice_id, req.body);
    await db.run('UPDATE documents SET thumb_key = ?, thumb_mime = ?, thumb_encrypted = ? WHERE id = ? AND thumb_key IS NULL', saved.storageKey, size.mime, saved.encrypted ? 1 : 0, doc.id);
    res.json({ ok: true });
  });

  // Fix what was recorded at upload: type, tooth, date taken, name, note.
  r.put('/documents/:did', requirePermission('clinical:write'), async (req, res) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    const b = req.body || {};
    const row = {};
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, `category must be one of ${CATEGORIES.join(', ')}`);
      row.category = b.category;
    }
    if (b.tooth !== undefined) {
      const t = String(b.tooth || '').trim().toUpperCase();
      if (t && !validTooth(t)) throw new HttpError(400, 'Tooth must be 1-32 or A-T');
      row.tooth = t || null;
    }
    if (b.taken_at !== undefined) {
      if (b.taken_at && !/^\d{4}-\d{2}-\d{2}$/.test(b.taken_at)) throw new HttpError(400, 'taken_at must be YYYY-MM-DD');
      row.taken_at = b.taken_at || null;
    }
    if (b.filename !== undefined) {
      const name = String(b.filename || '').replace(/[^\w.\- ()]/g, '_').trim().slice(0, 200);
      if (!name) throw new HttpError(400, 'Name the file');
      row.filename = name;
    }
    if (b.notes !== undefined) row.notes = String(b.notes || '').slice(0, 500) || null;
    if (b.tags !== undefined) row.tags = cleanTags(b.tags);
    if (b.exposure !== undefined) {
      const e = cleanExposure(b.exposure);
      row.exposure = e ? JSON.stringify(e) : null;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await db.run(`UPDATE documents SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), doc.id);
    await audit(db, req, 'document.update', 'documents', doc.id, { patient_id: doc.patient_id, ...row });
    publish(req.user.practice_id, { type: 'documents', patient_id: doc.patient_id });
    const out = await db.get('SELECT id, category, tooth, taken_at, filename, notes, tags, exposure FROM documents WHERE id = ?', doc.id);
    res.json({ ...out, exposure: parseJson(out.exposure) });
  });

  // Scan to chart from a phone: a link (shown as a QR code) good for 15 minutes, for this patient only.
  r.post('/patients/:id/upload-links', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'document';
    const { token, hash } = newToken();
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    await insert(db, 'upload_links', { practice_id: req.user.practice_id, patient_id: patient.id, token_hash: hash, category, created_by: req.user.id, expires_at: expires });
    await audit(db, req, 'upload_link.create', 'patients', patient.id, { category });
    res.status(201).json({ url: `${config.appUrl}/scan/${token}`, expires_at: expires, category });
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
