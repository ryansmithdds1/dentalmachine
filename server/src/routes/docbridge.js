import express, { Router } from 'express';
import { HttpError, rateLimit, authenticate, signToken, verifyToken } from '../auth.js';
import { hashToken, audit } from '../util.js';
import { publish } from '../events.js';
import { withActor, setActor } from '../actor.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { storeUpload, queueRead, loadDoc, readFile, sendFile } from '../docfiles.js';
import { createVirusScanner } from '../virusscan.js';
import { createOcr } from '../ocr.js';
import { cleanFolder } from './docmanage.js';

const MB = 1024 * 1024;
const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

// ---- Routes the imaging bridge calls for scanning (authenticated by the bridge's own key) ----
// Mount next to the other bridge routes: app.use('/api/bridge', docBridgeRoutes({ db, storage, config })).
//  POST /scanner                — the bridge says which scanner it has (name, feeder, duplex, driver)
//  POST /scans/:cid/file        — a finished scan (PDF or a JPG page) for the patient the scan was started for
//  POST /scan-inbox             — a file from a watched scan folder: filed to the patient named in the file
//                                 name ("P123_…"), else kept in the scan inbox for staff to file
export function docBridgeRoutes({ db, storage, config = {}, scanner = null, reader = null }) {
  const r = Router();
  scanner ??= config.virusScanner || createVirusScanner();
  reader ??= createOcr({ config });
  const limiter = rateLimit({ windowMs: 60_000, max: 600, name: 'bridge-docs' });
  const auth = async (req, _res, next) => {
    try {
      const key = String(req.headers.authorization || '').replace(/^Bridge\s+/i, '');
      const agent = key.startsWith('dmb_') ? await db.get('SELECT * FROM bridge_agents WHERE token_hash = ? AND active = 1', hashToken(key)) : null;
      if (!agent) throw new HttpError(401, 'Unknown or revoked bridge key');
      req.agent = agent;
      await db.run("UPDATE bridge_agents SET last_seen_at = datetime('now') WHERE id = ?", agent.id);
      // Everything a bridge does is recorded as that integration, never as a person.
      setActor({ source: 'integration', actor: `Imaging bridge: ${agent.name}`, practiceId: agent.practice_id, userId: null });
      next();
    } catch (err) {
      next(err);
    }
  };
  const asAgent = (req) => ({ user: { practice_id: req.agent.practice_id, id: null }, ip: req.ip, source: 'integration', actor: `Imaging bridge: ${req.agent.name}` });

  r.post('/scanner', limiter, auth, express.json(), async (req, res) => {
    const b = req.body || {};
    const name = b.name ? String(b.name).slice(0, 80) : null;
    const info = name ? {
      driver: ['wia', 'sane', 'command', 'twain'].includes(b.driver) ? b.driver : 'command', feeder: b.feeder !== false, flatbed: b.flatbed !== false, duplex: !!b.duplex,
      color: b.color !== false, dpis: Array.isArray(b.dpis) ? b.dpis.map(Number).filter((n) => [100, 150, 200, 300, 400, 600].includes(n)) : [150, 200, 300, 600],
      problem: b.problem ? String(b.problem).slice(0, 200) : null,
    } : null;
    await db.run('UPDATE bridge_agents SET scanner = ?, scanner_info = ? WHERE id = ?', name, info ? JSON.stringify(info) : null, req.agent.id);
    const key = `bridge:${req.agent.id}:scanner`;
    if (info?.problem) {
      await raiseIssue(db, { practiceId: req.agent.practice_id, kind: 'imaging', key, entity: 'bridge_agents', entityId: req.agent.id, title: `Scanner on ${req.agent.name}: ${info.problem}`.slice(0, 200) });
    } else await resolveIssue(db, req.agent.practice_id, key, 'Resolved automatically: the scanner answered');
    res.json({ ok: true, scanner: name });
  });

  const scanCommand = async (req) => {
    const c = await db.get("SELECT * FROM bridge_commands WHERE id = ? AND agent_id = ? AND type = 'scan'", Number(req.params.cid), req.agent.id);
    if (!c) throw new HttpError(404, 'Scan not found');
    if (!['delivered', 'pending'].includes(c.status)) throw new HttpError(409, 'This scan was already finished');
    return c;
  };
  r.post('/scans/:cid/file', limiter, auth, express.raw({ type: () => true, limit: 200 * MB }), async (req, res) => {
    const c = await scanCommand(req);
    const payload = parseJson(c.payload) || {};
    const patient = await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', c.patient_id, req.agent.practice_id);
    if (!patient) throw new HttpError(404, 'Patient not found');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const ext = /\.(pdf|jpe?g|png|tiff?)$/i.exec(String(req.query.filename || ''))?.[1] || 'pdf';
    const page = Number(req.query.page) || null;
    const filename = `${payload.name || `Scan ${stamp}`}${page ? ` p${page}` : ''}.${ext.toLowerCase()}`;
    const out = await storeUpload(db, storage, {
      req: asAgent(req), practiceId: req.agent.practice_id, patientId: patient.id, body: req.body, filename, declared: 'application/octet-stream',
      category: payload.category || 'document', notes: `Scanned on ${req.agent.name}${req.agent.scanner ? ` (${req.agent.scanner})` : ''}`, uploadedBy: c.created_by,
      source: `scan:${c.id}`, scanner, auditAction: 'document.scan', extra: { folder: cleanFolder(payload.folder), taken_at: new Date().toISOString().slice(0, 10) },
    });
    queueRead(db, storage, config, reader, out.id);
    publish(req.agent.practice_id, { type: 'documents', patient_id: patient.id });
    res.status(201).json({ id: out.id, patient_id: patient.id, mime: out.mime });
  });

  // Scan folders (ScanSnap, network copiers "scan to folder"): P<chart#>_anything.pdf goes to that chart;
  // anything else waits in the scan inbox (Documents → Scan inbox) for a person to file — never guessed.
  r.post('/scan-inbox', limiter, auth, express.raw({ type: () => true, limit: 200 * MB }), async (req, res) => {
    const filename = String(req.query.filename || 'scan.pdf');
    const claimed = /^\d+$/.test(String(req.query.patient_id || '')) ? Number(req.query.patient_id) : null;
    const patient = claimed ? await db.get("SELECT id FROM patients WHERE id = ? AND practice_id = ? AND status != 'archived'", claimed, req.agent.practice_id) : null;
    const sha = String(req.headers['x-content-sha256'] || '');
    if (/^[0-9a-f]{64}$/.test(sha)) {
      const dup = await db.get('SELECT id, patient_id, inbox FROM documents WHERE practice_id = ? AND source_hash = ? AND deleted_at IS NULL', req.agent.practice_id, sha);
      if (dup) return res.json({ id: dup.id, duplicate: true, patient_id: dup.patient_id, inbox: !!dup.inbox });
    }
    const out = await storeUpload(db, storage, {
      req: asAgent(req), practiceId: req.agent.practice_id, patientId: patient?.id ?? null, scope: 'patient', body: req.body, filename, declared: 'application/octet-stream',
      category: 'document', notes: `From the scan folder on ${req.agent.name}`, source: `scanfolder:${req.agent.id}`, scanner, auditAction: 'document.scan_folder',
      extra: patient ? {} : { inbox: 1 },
    });
    queueRead(db, storage, config, reader, out.id);
    if (patient) publish(req.agent.practice_id, { type: 'documents', patient_id: patient.id });
    else publish(req.agent.practice_id, { type: 'document-inbox' });
    res.status(201).json({ id: out.id, patient_id: patient?.id ?? null, inbox: !patient, ...(claimed && !patient ? { reason: `No patient #${claimed} in this practice` } : {}) });
  });

  return r;
}

// ---- Streaming audio and video to the browser's player ----
// A <video> element can't send the sign-in header, so the chart asks for a short-lived link (10 minutes, for
// this document and this person) and the player streams it with range requests.
// Mount: app.use('/api/media', docMediaRoutes({ db, storage, secret })).
export function docMediaRoutes({ db, storage, secret }) {
  const r = Router();
  r.post('/documents/:did/link', authenticate(db, secret), async (req, res) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name });
    const doc = await loadDoc(db, req, req.params.did);
    const token = signToken({ sub: doc.id, uid: req.user.id, pid: doc.practice_id, aud: 'doc-media' }, secret, 600);
    res.json({ url: `/api/media/documents/${doc.id}?t=${encodeURIComponent(token)}`, expires_in: 600 });
  });
  r.get('/documents/:did', async (req, res) => {
    const claims = verifyToken(String(req.query.t || ''), secret);
    if (!claims || claims.aud !== 'doc-media' || Number(claims.sub) !== Number(req.params.did)) throw new HttpError(401, 'This link has expired — open the document again');
    const doc = await db.get('SELECT * FROM documents WHERE id = ? AND practice_id = ? AND deleted_at IS NULL', Number(req.params.did), claims.pid);
    if (!doc) throw new HttpError(404, 'Document not found');
    const data = await readFile(storage, doc);
    const start = sendFile(req, res, doc, data);
    if (start) {
      await withActor({ source: 'human', userId: claims.uid, practiceId: doc.practice_id }, () => audit(db, { user: { practice_id: doc.practice_id, id: claims.uid }, ip: req.ip }, 'document.view', 'documents', doc.id, { patient_id: doc.patient_id, streamed: true }));
    }
  });
  return r;
}
