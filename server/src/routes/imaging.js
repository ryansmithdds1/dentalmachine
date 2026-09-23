import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePermission, HttpError, rateLimit } from '../auth.js';
import { findOr404, insert, audit, newToken, hashToken, validTooth } from '../util.js';
import { publish } from '../events.js';
import { isDicom, readDicomTags } from '../dicom.js';
import { dicomToImage } from '../dicomimage.js';
import { MAX_UPLOAD_BYTES, MOUNT_TEMPLATES } from './documents.js';

const ONLINE_SECONDS = 90;
const sqlAgo = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Imaging bridges: a small agent on each operatory PC opens the patient in the practice's imaging
// software (DEXIS, Sidexis, Carestream, Apteryx, VixWin…) and sends captured images back to the chart.
export default function imagingRoutes({ db, storage }) {
  const r = Router();
  const view = (a) => ({
    id: a.id, name: a.name, hostname: a.hostname, version: a.version, apps: JSON.parse(a.apps || '[]'), sensor: a.sensor || null, last_seen_at: a.last_seen_at, active: !!a.active,
    online: !!a.last_seen_at && Date.now() - Date.parse(`${a.last_seen_at.replace(' ', 'T')}Z`) < ONLINE_SECONDS * 1000,
  });

  r.get('/imaging/agents', requirePermission('clinical:read'), async (req, res) => {
    res.json((await db.all('SELECT * FROM bridge_agents WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id)).map(view));
  });

  // The token is shown once; only its hash is stored.
  r.post('/imaging/agents', requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Name the workstation (e.g. "Op 2")');
    const { token } = newToken();
    const key = `dmb_${token}`;
    const id = await insert(db, 'bridge_agents', { practice_id: req.user.practice_id, name, token_hash: hashToken(key), created_by: req.user.id });
    await audit(db, req, 'bridge.create', 'bridge_agents', id);
    res.status(201).json({ ...view(await db.get('SELECT * FROM bridge_agents WHERE id = ?', id)), token: key });
  });

  r.delete('/imaging/agents/:aid', requireAdmin, async (req, res) => {
    const agent = await findOr404(db, 'bridge_agents', req.params.aid, req.user.practice_id, 'Workstation');
    await db.run('UPDATE bridge_agents SET active = 0 WHERE id = ?', agent.id);
    await audit(db, req, 'bridge.revoke', 'bridge_agents', agent.id);
    res.json({ ok: true });
  });

  // "Open in DEXIS" from the chart: queue a launch on the chosen workstation.
  r.post('/patients/:id/imaging/launch', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const agent = await findOr404(db, 'bridge_agents', req.body?.agent_id, req.user.practice_id, 'Workstation');
    if (!agent.active) throw new HttpError(409, 'That workstation was removed');
    const apps = JSON.parse(agent.apps || '[]');
    const app = apps.find((a) => a.id === req.body?.app) || (apps.length === 1 ? apps[0] : null);
    if (!app) throw new HttpError(400, `Choose one of: ${apps.map((a) => a.name).join(', ') || 'no imaging programs set up on that workstation'}`);
    const payload = {
      app: app.id, patient: {
        id: patient.id, first_name: patient.first_name, last_name: patient.last_name, preferred_name: patient.preferred_name,
        dob: patient.dob, gender: patient.gender,
      },
    };
    const id = await insert(db, 'bridge_commands', { practice_id: req.user.practice_id, agent_id: agent.id, patient_id: patient.id, type: 'launch', payload: JSON.stringify(payload), created_by: req.user.id });
    await audit(db, req, 'imaging.launch', 'patients', patient.id, { agent: agent.name, app: app.id });
    res.status(201).json({ id, status: 'pending', online: view(agent).online, app: app.name, workstation: agent.name });
  });

  // Direct sensor capture: the workstation's bridge drives the sensor (a TWAIN/WIA acquire command per
  // exposure, or the sensor driver's output folder) and each image lands in the next empty spot of the mount.
  r.post('/patients/:id/imaging/capture', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const agent = await findOr404(db, 'bridge_agents', req.body?.agent_id, req.user.practice_id, 'Workstation');
    if (!agent.active) throw new HttpError(409, 'That workstation was removed');
    if (!agent.sensor) throw new HttpError(400, `No sensor is set up in the imaging bridge on ${agent.name}`);
    if (!view(agent).online) throw new HttpError(409, `The imaging bridge on ${agent.name} is offline`);
    let mount;
    if (req.body?.mount_id) {
      mount = await findOr404(db, 'image_mounts', req.body.mount_id, req.user.practice_id, 'Mount');
      if (mount.patient_id !== patient.id) throw new HttpError(400, 'That mount belongs to another patient');
    } else {
      const template = req.body?.template || 'fmx18';
      if (!MOUNT_TEMPLATES[template]) throw new HttpError(400, `template must be one of ${Object.keys(MOUNT_TEMPLATES).join(', ')}`);
      const mid = await insert(db, 'image_mounts', { practice_id: req.user.practice_id, patient_id: patient.id, template, taken_at: new Date().toISOString().slice(0, 10), slots: '{}', created_by: req.user.id });
      mount = await db.get('SELECT * FROM image_mounts WHERE id = ?', mid);
    }
    const total = MOUNT_TEMPLATES[mount.template];
    if (Object.keys(JSON.parse(mount.slots || '{}')).length >= total) throw new HttpError(409, 'That mount is already full');
    const busy = await db.get("SELECT id FROM bridge_commands WHERE agent_id = ? AND type = 'capture' AND status IN ('pending','delivered') AND created_at > ?", agent.id, sqlAgo(30 * 60_000));
    if (busy) await db.run("UPDATE bridge_commands SET status = 'done', result = 'Replaced by a new capture', completed_at = datetime('now') WHERE id = ?", busy.id);
    const payload = { mount_id: mount.id, template: mount.template, total, patient: { id: patient.id, first_name: patient.first_name, last_name: patient.last_name } };
    const id = await insert(db, 'bridge_commands', { practice_id: req.user.practice_id, agent_id: agent.id, patient_id: patient.id, type: 'capture', payload: JSON.stringify(payload), created_by: req.user.id });
    await audit(db, req, 'imaging.capture', 'patients', patient.id, { agent: agent.name, mount_id: mount.id });
    res.status(201).json({ id, status: 'pending', mount_id: mount.id, workstation: agent.name, sensor: agent.sensor });
  });
  r.post('/imaging/commands/:cid/stop', requirePermission('clinical:write'), async (req, res) => {
    const c = await findOr404(db, 'bridge_commands', req.params.cid, req.user.practice_id, 'Command');
    if (['pending', 'delivered'].includes(c.status)) await db.run("UPDATE bridge_commands SET status = 'done', result = 'Stopped from the chart', completed_at = datetime('now') WHERE id = ?", c.id);
    res.json({ ok: true });
  });

  // ---- Unfiled images: bridge imports that couldn't be matched to a patient ----
  r.get('/imaging/unfiled', requirePermission('clinical:read'), async (req, res) => {
    const rows = await db.all(
      `SELECT u.id, u.filename, u.mime, u.size, u.reason, u.claimed, u.opened_patient_id, u.taken_at, u.modality, u.category, u.created_at, b.name AS workstation,
         p.first_name AS opened_first_name, p.last_name AS opened_last_name
       FROM unfiled_images u LEFT JOIN bridge_agents b ON b.id = u.agent_id LEFT JOIN patients p ON p.id = u.opened_patient_id
       WHERE u.practice_id = ? AND u.filed_at IS NULL AND u.discarded_at IS NULL ORDER BY u.id DESC LIMIT 500`, req.user.practice_id,
    );
    res.json(rows.map((r) => ({ ...r, claimed: r.claimed ? JSON.parse(r.claimed) : null })));
  });
  r.get('/imaging/unfiled/:uid/image', requirePermission('clinical:read'), async (req, res) => {
    const u = await findOr404(db, 'unfiled_images', req.params.uid, req.user.practice_id, 'Image');
    const data = await storage.read(u.storage_key, !!u.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    const view = u.mime === 'application/dicom' ? dicomToImage(data) : { mime: u.mime, data };
    if (!view || !/^image\//.test(view.mime)) throw new HttpError(415, 'No preview for this file');
    res.set({ 'Content-Type': view.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(view.data);
  });
  // File several at once into one patient's chart (or discard mistakes).
  r.post('/imaging/unfiled/file', requirePermission('clinical:write'), async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'Choose the images');
    const discard = req.body?.discard === true;
    const patient = discard ? null : await findOr404(db, 'patients', req.body?.patient_id, req.user.practice_id, 'Patient');
    const filed = [];
    await db.tx(async () => {
      for (const id of ids) {
        const u = await db.get('SELECT * FROM unfiled_images WHERE id = ? AND practice_id = ? AND filed_at IS NULL AND discarded_at IS NULL', id, req.user.practice_id);
        if (!u) throw new HttpError(409, `Image ${id} was already filed`);
        if (discard) {
          await db.run("UPDATE unfiled_images SET discarded_at = datetime('now'), filed_by = ? WHERE id = ?", req.user.id, u.id);
          continue;
        }
        const docId = await insert(db, 'documents', {
          practice_id: u.practice_id, patient_id: patient.id, category: req.body?.category || u.category || 'xray', filename: u.filename, mime: u.mime, size: u.size,
          storage_key: u.storage_key, encrypted: u.encrypted, notes: `Filed by hand from the imaging bridge (${u.reason})`, source: `bridge:${u.agent_id}`, source_hash: u.source_hash,
          taken_at: u.taken_at, uploaded_by: req.user.id,
        });
        await db.run("UPDATE unfiled_images SET filed_at = datetime('now'), filed_by = ?, document_id = ? WHERE id = ?", req.user.id, docId, u.id);
        filed.push(docId);
      }
    });
    await audit(db, req, discard ? 'unfiled.discard' : 'unfiled.file', 'patients', patient?.id ?? null, { ids, documents: filed });
    if (patient) publish(req.user.practice_id, { type: 'documents', patient_id: patient.id });
    publish(req.user.practice_id, { type: 'unfiled' });
    res.json({ ok: true, documents: filed });
  });

  // The agent program, for installing on operatory PCs.
  r.get('/imaging/agent-download', requirePermission('clinical:read'), (_req, res) => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../../../bridge/dental-machine-bridge.mjs');
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="dental-machine-bridge.mjs"' }).send(readFileSync(file));
  });

  r.get('/imaging/commands/:cid', requirePermission('clinical:read'), async (req, res) => {
    const c = await findOr404(db, 'bridge_commands', req.params.cid, req.user.practice_id, 'Command');
    res.json({ id: c.id, status: c.status, result: c.result, delivered_at: c.delivered_at, completed_at: c.completed_at });
  });

  return r;
}

// ---- Routes the bridge agent calls (authenticated by its own key, not a staff login) ----
export function bridgeAgentRoutes({ db, storage }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 600, name: 'bridge' });
  r.use(limiter, async (req, _res, next) => {
    const key = String(req.headers.authorization || '').replace(/^Bridge\s+/i, '');
    const agent = key.startsWith('dmb_') ? await db.get('SELECT * FROM bridge_agents WHERE token_hash = ? AND active = 1', hashToken(key)) : null;
    if (!agent) return next(new HttpError(401, 'Unknown or revoked bridge key'));
    req.agent = agent;
    await db.run("UPDATE bridge_agents SET last_seen_at = datetime('now') WHERE id = ?", agent.id);
    next();
  });

  r.post('/hello', express.json(), async (req, res) => {
    const apps = (Array.isArray(req.body?.apps) ? req.body.apps : []).slice(0, 20).map((a) => ({ id: String(a.id).slice(0, 40), name: String(a.name || a.id).slice(0, 60) }));
    const sensor = req.body?.sensor ? String(req.body.sensor.name || req.body.sensor).slice(0, 60) : null;
    await db.run('UPDATE bridge_agents SET apps = ?, sensor = ?, hostname = ?, version = ? WHERE id = ?', JSON.stringify(apps), sensor, String(req.body?.hostname || '').slice(0, 100) || null, String(req.body?.version || '').slice(0, 20) || null, req.agent.id);
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.agent.practice_id);
    res.json({ practice: practice.name, workstation: req.agent.name });
  });

  // Long poll: waits up to ~25 s for work so launches feel instant without hammering the server.
  r.get('/commands', async (req, res) => {
    const deadline = Date.now() + Math.min(Number(req.query.wait) || 25, 25) * 1000;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    for (;;) {
      const rows = await db.all("SELECT id, type, payload, created_at FROM bridge_commands WHERE agent_id = ? AND status = 'pending' ORDER BY id LIMIT 10", req.agent.id);
      // Launches older than two minutes are stale (nobody is waiting at the chair any more).
      const fresh = [];
      for (const c of rows) {
        const age = Date.now() - Date.parse(`${c.created_at.replace(' ', 'T')}Z`);
        await db.run(`UPDATE bridge_commands SET status = ?, delivered_at = datetime('now') WHERE id = ? AND status = 'pending'`, age > 120_000 ? 'expired' : 'delivered', c.id);
        if (age <= 120_000) fresh.push({ id: c.id, type: c.type, ...JSON.parse(c.payload) });
      }
      if (fresh.length || Date.now() > deadline || aborted) return res.json(fresh);
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (aborted) return undefined; // the agent hung up (or the server is shutting down)
    }
  });

  // A capture in progress: whether to keep taking exposures, and how many spots are left.
  r.get('/captures/:cid', async (req, res) => {
    const c = await db.get("SELECT * FROM bridge_commands WHERE id = ? AND agent_id = ? AND type = 'capture'", Number(req.params.cid), req.agent.id);
    if (!c) throw new HttpError(404, 'Capture not found');
    const { mount_id: mountId, total } = JSON.parse(c.payload);
    const mount = await db.get('SELECT slots FROM image_mounts WHERE id = ?', mountId);
    const filled = Object.keys(JSON.parse(mount?.slots || '{}')).length;
    res.json({ active: c.status === 'delivered' && filled < total, filled, total });
  });

  r.post('/commands/:cid/result', express.json(), async (req, res) => {
    const c = await db.get('SELECT * FROM bridge_commands WHERE id = ? AND agent_id = ?', Number(req.params.cid), req.agent.id);
    if (!c) throw new HttpError(404, 'Command not found');
    if (c.type === 'capture' && c.status === 'done') return res.json({ ok: true }); // already finished (full, or stopped from the chart)
    await db.run("UPDATE bridge_commands SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?", req.body?.ok ? 'done' : 'error', String(req.body?.message || '').slice(0, 300) || null, c.id);
    res.json({ ok: true });
  });

  // Captured images go to the patient whose imaging session was opened on this workstation. An ID in the
  // DICOM header or file name is only trusted when it agrees with that (or when nothing was opened);
  // when they disagree the image is left unmatched for a person to file, never guessed.
  r.post('/images', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const agent = req.agent;
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Empty upload');
    const filename = String(req.query.filename || 'image').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    const mime = sniffMime(data, filename);
    if (!mime) throw new HttpError(415, 'Only images, PDFs and DICOM files are imported');
    const tags = isDicom(data) ? readDicomTags(data) : null;
    // Sensor capture: the patient is the one the capture was started for, and the image fills the next spot.
    let capture = null;
    if (req.query.capture_id) {
      capture = await db.get("SELECT * FROM bridge_commands WHERE id = ? AND agent_id = ? AND type = 'capture'", Number(req.query.capture_id), agent.id);
      if (!capture) throw new HttpError(404, 'Capture not found');
      if (capture.status !== 'delivered') throw new HttpError(409, 'This capture was stopped');
    }
    const inPractice = async (id) => (/^\d+$/.test(String(id || '').trim()) ? (await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', Number(id), agent.practice_id))?.id ?? null : null);
    const since = new Date(Date.now() - 45 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const launched = (await db.get("SELECT patient_id FROM bridge_commands WHERE agent_id = ? AND type = 'launch' AND status IN ('delivered','done') AND created_at > ? ORDER BY id DESC LIMIT 1", agent.id, since))?.patient_id
      ?? (await inPractice(req.query.opened_patient_id));
    const claimed = [
      ['dicom', tags?.patientId ? String(tags.patientId).trim() : null],
      ['filename', req.query.patient_id ? String(req.query.patient_id) : null],
    ].filter(([, v]) => v);
    let patientId = null;
    let matchedBy = null;
    // An image nobody can place goes to the practice's unfiled queue for a person to file, never guessed.
    const queue = async (reason) => {
      const hash = createHash('sha256').update(data).digest('hex');
      const already = await db.get('SELECT id FROM unfiled_images WHERE practice_id = ? AND source_hash = ?', agent.practice_id, hash);
      if (already) return res.status(202).json({ queued: true, unmatched: true, id: already.id, duplicate: true, reason });
      const saved = await storage.save(agent.practice_id, data);
      const id = await insert(db, 'unfiled_images', {
        practice_id: agent.practice_id, agent_id: agent.id, filename, mime, size: data.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0,
        source_hash: hash, reason, claimed: claimed.length ? JSON.stringify(Object.fromEntries(claimed)) : null, opened_patient_id: launched ?? null,
        taken_at: tags?.studyDate || null, modality: tags?.modality || null, category: ['xray', 'photo'].includes(req.query.category) ? req.query.category : tags?.modality === 'XC' ? 'photo' : 'xray',
      });
      publish(agent.practice_id, { type: 'unfiled' });
      return res.status(202).json({ queued: true, unmatched: true, id, reason });
    };
    if (capture) {
      const disagree = claimed.find(([, v]) => Number(v) !== capture.patient_id);
      if (disagree) throw new HttpError(422, `This image is labelled for patient ${disagree[1]} (${disagree[0]}), not the patient being captured`, { unmatched: true, conflict: true });
      patientId = capture.patient_id;
      matchedBy = 'capture';
    } else if (launched) {
      const disagree = claimed.find(([, v]) => Number(v) !== launched);
      if (disagree) return queue(`Labelled for patient ${disagree[1]} (${disagree[0]}), but patient #${launched} was open on ${agent.name}`);
      patientId = launched;
      matchedBy = claimed.length ? `last_opened+${claimed.map(([k]) => k).join('+')}` : 'last_opened';
    } else {
      for (const [by, v] of claimed) {
        const id = await inPractice(v);
        if (!id) continue;
        if (!patientId) [patientId, matchedBy] = [id, by];
        else if (id !== patientId) return queue('The DICOM header and the file name point to different patients');
      }
    }
    if (!patientId) return queue(claimed.length ? `No patient ${claimed.map(([k, v]) => `${v} (${k})`).join(' or ')} in this practice` : 'No patient was open on the workstation and the image has no chart number');
    const hash = createHash('sha256').update(data).digest('hex');
    const dup = await db.get('SELECT id FROM documents WHERE patient_id = ? AND source_hash = ? AND deleted_at IS NULL', patientId, hash);
    if (dup && capture) throw new HttpError(409, 'The sensor sent the same image twice — it was already filed', { duplicate: true, id: dup.id });
    if (dup) return res.json({ id: dup.id, duplicate: true, patient_id: patientId });
    const payload = capture ? JSON.parse(capture.payload) : null;
    const category = payload ? (payload.template.startsWith('photos') ? 'photo' : 'xray') : ['xray', 'photo'].includes(req.query.category) ? req.query.category : tags?.modality === 'XC' ? 'photo' : 'xray';
    const tooth = req.query.tooth && validTooth(String(req.query.tooth).toUpperCase()) ? String(req.query.tooth).toUpperCase() : null;
    const { storageKey, encrypted } = await storage.save(agent.practice_id, data);
    const id = await insert(db, 'documents', {
      practice_id: agent.practice_id, patient_id: patientId, category, filename, mime, size: data.length, storage_key: storageKey, encrypted: encrypted ? 1 : 0,
      tooth, notes: `Imported from ${agent.name}${tags?.modality ? ` (${tags.modality})` : ''}`, source: `bridge:${agent.id}`, source_hash: hash,
      taken_at: tags?.studyDate || null,
    });
    await audit(db, { user: { practice_id: agent.practice_id, id: null }, ip: req.ip }, 'document.import', 'documents', id, { patient_id: patientId, agent: agent.name, matched_by: matchedBy });
    let placed = null;
    if (capture) {
      placed = await db.tx(async () => {
        const mount = await db.get('SELECT * FROM image_mounts WHERE id = ?', payload.mount_id);
        const slots = JSON.parse(mount.slots || '{}');
        let slot = 0;
        while (slot < payload.total && slots[slot] != null) slot++;
        if (slot >= payload.total) return { slot: null, remaining: 0 };
        slots[slot] = id;
        await db.run('UPDATE image_mounts SET slots = ? WHERE id = ?', JSON.stringify(slots), mount.id);
        const remaining = payload.total - Object.keys(slots).length;
        if (!remaining) await db.run("UPDATE bridge_commands SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ?", `Mount complete (${payload.total} images)`, capture.id);
        return { slot, remaining };
      });
      publish(agent.practice_id, { type: 'mounts', patient_id: patientId });
    }
    publish(agent.practice_id, { type: 'documents', patient_id: patientId });
    res.status(201).json({ id, patient_id: patientId, matched_by: matchedBy, category, ...(placed || {}) });
  });

  return r;
}

export function sniffMime(buf, filename = '') {
  if (isDicom(buf)) return 'application/dicom';
  const b = buf.subarray(0, 12);
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*') return 'image/tiff';
  if (b.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (/\.dcm$/i.test(filename)) return 'application/dicom';
  return null;
}
