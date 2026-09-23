import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePermission, HttpError, rateLimit } from '../auth.js';
import { findOr404, insert, audit, newToken, hashToken, validTooth } from '../util.js';
import { publish } from '../events.js';
import { isDicom, readDicomTags } from '../dicom.js';
import { MAX_UPLOAD_BYTES } from './documents.js';

const ONLINE_SECONDS = 90;
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Imaging bridges: a small agent on each operatory PC opens the patient in the practice's imaging
// software (DEXIS, Sidexis, Carestream, Apteryx, VixWin…) and sends captured images back to the chart.
export default function imagingRoutes({ db }) {
  const r = Router();
  const view = (a) => ({
    id: a.id, name: a.name, hostname: a.hostname, version: a.version, apps: JSON.parse(a.apps || '[]'), last_seen_at: a.last_seen_at, active: !!a.active,
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
    await db.run('UPDATE bridge_agents SET apps = ?, hostname = ?, version = ? WHERE id = ?', JSON.stringify(apps), String(req.body?.hostname || '').slice(0, 100) || null, String(req.body?.version || '').slice(0, 20) || null, req.agent.id);
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

  r.post('/commands/:cid/result', express.json(), async (req, res) => {
    const c = await db.get('SELECT * FROM bridge_commands WHERE id = ? AND agent_id = ?', Number(req.params.cid), req.agent.id);
    if (!c) throw new HttpError(404, 'Command not found');
    await db.run("UPDATE bridge_commands SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?", req.body?.ok ? 'done' : 'error', String(req.body?.message || '').slice(0, 300) || null, c.id);
    res.json({ ok: true });
  });

  // Captured images: matched to the patient by the DICOM patient ID, an explicit patient_id, or the
  // patient most recently opened on this workstation.
  r.post('/images', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const agent = req.agent;
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Empty upload');
    const filename = String(req.query.filename || 'image').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    const mime = sniffMime(data, filename);
    if (!mime) throw new HttpError(415, 'Only images, PDFs and DICOM files are imported');
    const tags = isDicom(data) ? readDicomTags(data) : null;
    let patientId = null;
    let matchedBy = null;
    const inPractice = async (id) => (/^\d+$/.test(String(id || '')) ? (await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', Number(id), agent.practice_id))?.id : null);
    if (tags?.patientId && (patientId = await inPractice(tags.patientId))) matchedBy = 'dicom';
    if (!patientId && req.query.patient_id && (patientId = await inPractice(req.query.patient_id))) matchedBy = 'filename';
    if (!patientId && req.query.opened_patient_id && (patientId = await inPractice(req.query.opened_patient_id))) matchedBy = 'last_opened';
    if (!patientId) {
      const since = new Date(Date.now() - 45 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      const recent = await db.get("SELECT patient_id FROM bridge_commands WHERE agent_id = ? AND type = 'launch' AND status IN ('delivered','done') AND created_at > ? ORDER BY id DESC LIMIT 1", agent.id, since);
      if (recent) {
        patientId = recent.patient_id;
        matchedBy = 'last_opened';
      }
    }
    if (!patientId) throw new HttpError(422, 'Could not tell which patient this image belongs to', { unmatched: true });
    const hash = createHash('sha256').update(data).digest('hex');
    const dup = await db.get('SELECT id FROM documents WHERE patient_id = ? AND source_hash = ? AND deleted_at IS NULL', patientId, hash);
    if (dup) return res.json({ id: dup.id, duplicate: true, patient_id: patientId });
    const category = ['xray', 'photo'].includes(req.query.category) ? req.query.category : tags?.modality === 'XC' ? 'photo' : 'xray';
    const tooth = req.query.tooth && validTooth(String(req.query.tooth).toUpperCase()) ? String(req.query.tooth).toUpperCase() : null;
    const { storageKey, encrypted } = await storage.save(agent.practice_id, data);
    const id = await insert(db, 'documents', {
      practice_id: agent.practice_id, patient_id: patientId, category, filename, mime, size: data.length, storage_key: storageKey, encrypted: encrypted ? 1 : 0,
      tooth, notes: `Imported from ${agent.name}${tags?.modality ? ` (${tags.modality})` : ''}`, source: `bridge:${agent.id}`, source_hash: hash,
      taken_at: tags?.studyDate || null,
    });
    await audit(db, { user: { practice_id: agent.practice_id, id: null }, ip: req.ip }, 'document.import', 'documents', id, { patient_id: patientId, agent: agent.name, matched_by: matchedBy });
    publish(agent.practice_id, { type: 'documents', patient_id: patientId });
    res.status(201).json({ id, patient_id: patientId, matched_by: matchedBy, category });
  });

  return r;
}

export function sniffMime(buf, filename = '') {
  if (isDicom(buf)) return 'application/dicom';
  const b = buf.subarray(0, 12);
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*') return 'image/tiff';
  if (b.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (/\.dcm$/i.test(filename)) return 'application/dicom';
  return null;
}
