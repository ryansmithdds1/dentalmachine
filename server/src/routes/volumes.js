import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit } from '../util.js';
import { imageSize } from '../thumbnails.js';
import { publish } from '../events.js';
import { analyzeSeries, seriesFiles, decodeVolume, encodeVolume, compress, meshParts, isVolumeDoc, isMeshDoc } from '../volume.js';

// The 3D viewer's data: a CBCT document decoded into one volume, and the meshes of a scan document.
// Everything is read-only, practice-scoped, needs clinical:read, and is audited as an image view
// (document.view, with what was opened) — the same trail as opening an x-ray.
//
//   GET  /documents/:did/view3d        which viewer opens it: { kind: 'volume', … } or { kind: 'mesh', parts }
//   GET  /documents/:did/volume/info   manifest: size, voxel spacing (mm), slice order, warnings
//   GET  /documents/:did/volume?max=N  the volume (binary "DMVOL1", see volume.js encodeVolume), gzip
//   GET  /documents/:did/mesh/parts    the scan files in the document (one, or upper/lower from a zip)
//   GET  /documents/:did/mesh?part=i   one scan file's bytes (X-Mesh-Format: stl | ply | obj)
//   POST /documents/:did/snapshot      a PNG of the current view, saved as a new document for the patient

// Manifests are small and only change if the file does, so they're kept per stored file (and read from
// documents.volume_manifest when the upload recorded one).
const manifests = new Map();
const MANIFEST_CACHE = 64;
// Decoding a big CBCT uses a few hundred MB for a second or two: at most two at once per server.
let decoding = 0;
const waiting = [];
async function slot(fn) {
  if (decoding >= 2) await new Promise((r) => waiting.push(r));
  decoding++;
  try {
    return await fn();
  } finally {
    decoding--;
    waiting.shift()?.();
  }
}

export default function volumeRoutes({ db, storage }) {
  const r = Router();

  const loadDoc = async (req) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at) throw new HttpError(404, 'Document not found');
    return doc;
  };
  const readFile = async (doc) => {
    const data = await storage.read(doc.storage_key, !!doc.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    return data;
  };
  const manifestOf = async (doc, data) => {
    if (doc.volume_manifest) {
      try { return JSON.parse(doc.volume_manifest); } catch { /* recompute below */ }
    }
    const key = `${doc.id}:${doc.storage_key}`;
    if (manifests.has(key)) return manifests.get(key);
    const m = analyzeSeries(seriesFiles(data ?? await readFile(doc)));
    manifests.set(key, m);
    if (manifests.size > MANIFEST_CACHE) manifests.delete(manifests.keys().next().value);
    return m;
  };
  const requireVolume = (doc) => {
    if (!isVolumeDoc(doc)) throw new HttpError(415, 'This document isn’t a CBCT volume');
  };
  // A volume needs more than one slice; a single DICOM image belongs in the x-ray viewer.
  const volumeManifest = async (doc, data) => {
    const m = await manifestOf(doc, data);
    if (m.dims[2] < 2) throw new HttpError(415, 'This is a single image, not a CBCT volume — open it in the image viewer');
    return m;
  };
  const sendBinary = async (req, res, body, headers) => {
    const gz = /\bgzip\b/.test(req.get('Accept-Encoding') || '') && body.length > 64 * 1024;
    const out = gz ? await compress(body) : body;
    res.set({
      ...headers, 'Content-Length': out.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    });
    res.send(out);
  };

  const summary = (doc, m) => ({ id: doc.id, filename: doc.filename, ...m, slices: m.slices.length });

  r.get('/documents/:did/view3d', requirePermission('clinical:read'), async (req, res) => {
    const doc = await loadDoc(req);
    if (!isVolumeDoc(doc) && !isMeshDoc(doc)) throw new HttpError(415, 'This document can’t be opened in 3D');
    const data = await readFile(doc);
    if (isMeshDoc(doc)) {
      const parts = meshParts(data, doc.filename);
      if (parts.length) return res.json({ kind: 'mesh', id: doc.id, filename: doc.filename, parts: parts.map(({ read: _read, ...p }) => p) });
      if (doc.mime !== 'application/zip') throw new HttpError(415, 'This scan file can’t be read');
    }
    res.json({ ...summary(doc, await volumeManifest(doc, data)), kind: 'volume' });
  });

  r.get('/documents/:did/volume/info', requirePermission('clinical:read'), async (req, res) => {
    const doc = await loadDoc(req);
    requireVolume(doc);
    const m = await volumeManifest(doc);
    res.json(summary(doc, m));
  });

  r.get('/documents/:did/volume', requirePermission('clinical:read'), async (req, res) => {
    const doc = await loadDoc(req);
    requireVolume(doc);
    const max = req.query.max === undefined ? 512 : Number(req.query.max);
    if (!Number.isInteger(max) || max < 32 || max > 1024) throw new HttpError(400, 'max must be a whole number from 32 to 1024');
    const body = await slot(async () => {
      const data = await readFile(doc);
      const m = await volumeManifest(doc, data);
      return encodeVolume(await decodeVolume(data, m, { max }));
    });
    await audit(db, req, 'document.view', 'documents', doc.id, { patient_id: doc.patient_id, view: 'volume' });
    await sendBinary(req, res, body, { 'Content-Type': 'application/octet-stream' });
  });

  r.get('/documents/:did/mesh/parts', requirePermission('clinical:read'), async (req, res) => {
    const doc = await loadDoc(req);
    if (!isMeshDoc(doc)) throw new HttpError(415, 'This document isn’t a 3D scan');
    const parts = meshParts(await readFile(doc), doc.filename);
    if (!parts.length) throw new HttpError(415, 'No .stl, .ply or .obj scan was found in this file');
    res.json({ id: doc.id, filename: doc.filename, parts: parts.map(({ read: _read, ...p }) => p) });
  });

  r.get('/documents/:did/mesh', requirePermission('clinical:read'), async (req, res) => {
    const doc = await loadDoc(req);
    if (!isMeshDoc(doc)) throw new HttpError(415, 'This document isn’t a 3D scan');
    const index = req.query.part === undefined ? 0 : Number(req.query.part);
    if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'part must be a whole number');
    const part = meshParts(await readFile(doc), doc.filename)[index];
    if (!part) throw new HttpError(404, 'No such part in this scan');
    await audit(db, req, 'document.view', 'documents', doc.id, { patient_id: doc.patient_id, view: 'mesh', part: part.name });
    await sendBinary(req, res, part.read(), { 'Content-Type': 'application/octet-stream', 'X-Mesh-Format': part.format, 'X-Mesh-Name': encodeURIComponent(part.name) });
  });

  // A picture of the current 3D view (a slice with measurements, a rendering, a scan) kept in the chart as a
  // new document: the source file is untouched. Sent twice (double click) → the idempotency layer answers once.
  r.post('/documents/:did/snapshot', requirePermission('clinical:write'), express.raw({ type: () => true, limit: 8 * 1024 * 1024 }), async (req, res) => {
    const doc = await loadDoc(req);
    if (!isVolumeDoc(doc) && !isMeshDoc(doc)) throw new HttpError(415, 'Snapshots are for CBCT and 3D scan documents');
    const size = Buffer.isBuffer(req.body) ? imageSize(req.body) : null;
    if (!size || size.mime !== 'image/png' || !size.width || !size.height || size.width > 8000 || size.height > 8000) throw new HttpError(400, 'Send the snapshot as a PNG image');
    const view = String(req.query.view || '').replace(/[^\w .,-]/g, '').slice(0, 60);
    const saved = await storage.save(req.user.practice_id, req.body);
    const base = doc.filename.replace(/\.[^.]*$/, '').slice(0, 150);
    const id = await insert(db, 'documents', {
      practice_id: req.user.practice_id, patient_id: doc.patient_id, category: doc.category === 'xray' ? 'xray' : 'photo',
      filename: `${base} - ${view || '3D view'}.png`.replace(/[^\w.\- ()]/g, '_'), mime: 'image/png', size: req.body.length,
      storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, tooth: doc.tooth || null, taken_at: doc.taken_at || null,
      notes: `Snapshot from ${doc.filename}${view ? ` (${view})` : ''}`.slice(0, 500), tags: JSON.stringify(['3d snapshot']),
      uploaded_by: req.user.id,
    });
    await audit(db, req, 'document.snapshot', 'documents', id, { patient_id: doc.patient_id, from_document_id: doc.id, view: view || null });
    publish(req.user.practice_id, { type: 'documents', patient_id: doc.patient_id });
    res.status(201).json(await db.get('SELECT id, category, filename, mime, size, notes, created_at FROM documents WHERE id = ?', id));
  });

  return r;
}
