import { Router } from 'express';
import { HttpError, rateLimit, signToken, verifyToken } from '../auth.js';
import { audit, hashToken } from '../util.js';
import {
  packetFor, packetView, submitHistory, submitForm, declineFromPatient, progress, kioskFromToken, currentKioskSession, kioskSessionFor, endKioskSession,
} from '../paperwork.js';
import { patientLang } from '../templates.js';
import { publish } from '../events.js';

// The patient's side of paperwork and consents, with no sign-in (mounted under /api/public):
//   /papers/:token …          a link sent by text/email, a QR code at the desk, or this screen handed over. The link
//                             alone doesn't open the forms: the patient confirms their birth date (a staff hand-off
//                             on the office device skips that, see handoff.js).
//   /forms-kiosk/…            an office iPad in kiosk mode (X-Kiosk-Token): it sees only the session staff loaded
//                             on it, which ends when the patient finishes or goes idle.
//   /edu/:token               a take-home education link (records when it was opened).
//   /learn-media/:key/:id     an office's education picture or video (general information, no patient data).
// Only first names are shown; nothing clinical is in the links themselves.
const paperPass = (packetId, secret) => signToken({ sub: packetId, aud: 'paper-view' }, secret, 2 * 3600);
const device = (req) => String(req.get('user-agent') || '').slice(0, 200) || null;

export default function paperworkPublicRoutes({ db, storage, secret }) {
  const r = Router();
  const reader = rateLimit({ windowMs: 60_000, max: 120, name: 'paperwork-read' });
  const writer = rateLimit({ windowMs: 60 * 60_000, max: 120, name: 'paperwork-write' });
  const perKiosk = rateLimit({ windowMs: 60_000, max: 150, name: 'forms-kiosk' });
  const logPublic = (req, practiceId, action, entity, id, details) => audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, action, entity, id, details, { source: 'patient' });

  // ---- Links ----
  const linkFor = async (token) => {
    const link = token && String(token).length < 100 ? await db.get('SELECT * FROM paperwork_links WHERE token_hash = ?', hashToken(String(token))) : null;
    if (!link) throw new HttpError(404, 'This link is not valid');
    if (link.expires_at < new Date().toISOString()) throw new HttpError(410, 'This link has expired. Please ask the office for a new one.');
    return link;
  };
  // The birth date, or a pass for this packet (from the birth-date step, or a staff hand-off on the office device).
  const passOk = (req, packetId) => {
    const pass = verifyToken(req.get('X-Form-Pass') || '', secret);
    return !!pass && ['paper-view', 'form-view'].includes(pass.aud) && pass.sub === packetId;
  };
  const open = async (req, { gate = true } = {}) => {
    const link = await linkFor(req.params.token);
    const patient = await db.get('SELECT dob, language FROM patients WHERE id = ?', link.patient_id);
    if (gate && patient?.dob && !passOk(req, link.packet_id)) {
      const practice = await db.get('SELECT name FROM practices WHERE id = ?', link.practice_id);
      throw new HttpError(403, 'Enter your date of birth to open your forms', { dob_required: true, practice_name: practice?.name, language: patientLang(patient) });
    }
    return link;
  };
  const who = (req, via) => ({ via, ip: req.ip, device: device(req) });

  r.get('/papers/:token', reader, async (req, res) => {
    const link = await open(req);
    if (!link.opened_at) {
      await db.run("UPDATE paperwork_links SET opened_at = datetime('now') WHERE id = ? AND opened_at IS NULL", link.id);
      await logPublic(req, link.practice_id, 'paperwork.link_opened', 'paperwork_links', link.id, { patient_id: link.patient_id, channel: link.channel });
    }
    res.json({ ...(await packetView(db, link.packet_id)), via: link.channel === 'handoff' ? 'handoff' : 'link' });
  });

  r.post('/papers/:token/verify', writer, async (req, res) => {
    const link = await open(req, { gate: false });
    const p = await db.get('SELECT dob FROM patients WHERE id = ?', link.patient_id);
    if (p?.dob && String(req.body?.dob || '').trim() !== p.dob) {
      await db.run('UPDATE paperwork_links SET dob_failures = dob_failures + 1 WHERE id = ?', link.id);
      const tries = Number((await db.get('SELECT dob_failures AS n FROM paperwork_links WHERE id = ?', link.id)).n);
      await logPublic(req, link.practice_id, 'paperwork.link_dob_failed', 'paperwork_links', link.id, { patient_id: link.patient_id, tries });
      if (tries >= 5) {
        await db.run('UPDATE paperwork_links SET expires_at = ? WHERE id = ?', new Date().toISOString(), link.id);
        throw new HttpError(410, 'This link has been turned off after too many tries. Please ask the office for a new one.');
      }
      throw new HttpError(403, "That date of birth doesn't match our records", { dob_required: true });
    }
    res.json({ pass: paperPass(link.packet_id, secret) });
  });

  const via = (link) => (link.channel === 'handoff' ? 'handoff' : 'link');
  const handedOverBy = async (link) => (link.channel === 'handoff' ? link.created_by : null);
  r.post('/papers/:token/history', writer, async (req, res) => {
    const link = await open(req);
    res.status(201).json(await submitHistory(db, storage, { packetId: link.packet_id, body: req.body, who: who(req, via(link)) }));
  });
  r.post('/papers/:token/forms/:rid', writer, async (req, res) => {
    const link = await open(req);
    res.status(201).json(await submitForm(db, storage, { packetId: link.packet_id, rid: req.params.rid, body: req.body, who: { ...who(req, via(link)), handedOverBy: await handedOverBy(link) } }));
  });
  r.post('/papers/:token/forms/:rid/decline', writer, async (req, res) => {
    const link = await open(req);
    res.json(await declineFromPatient(db, storage, { packetId: link.packet_id, rid: req.params.rid, body: req.body, who: who(req, via(link)) }));
  });
  r.post('/papers/:token/progress', reader, async (req, res) => {
    const link = await open(req);
    await progress(db, { packetId: link.packet_id, page: req.body?.page, total: req.body?.total });
    res.json({ ok: true });
  });

  // ---- The kiosk iPad ----
  const kioskOf = async (req) => {
    const k = await kioskFromToken(db, req.get('X-Kiosk-Token'));
    if (!k) throw new HttpError(401, 'This iPad isn’t set up for forms. A manager can set it up from Settings → Forms & consents.');
    return k;
  };
  const sessionOf = async (req) => {
    const k = await kioskOf(req);
    const s = await kioskSessionFor(db, k, req.params.sid);
    if (s.mode !== 'forms' || !s.packet_id) throw new HttpError(400, 'Nothing to fill in');
    await db.run("UPDATE kiosk_sessions SET last_activity_at = datetime('now'), status = CASE WHEN status = 'waiting' THEN 'active' ELSE status END, started_at = COALESCE(started_at, datetime('now')) WHERE id = ?", s.id);
    return { k, s };
  };
  const kioskWho = (req, s) => ({ via: 'kiosk', ip: req.ip, device: device(req), kioskSession: s });
  // Everything left done: the session ends and the iPad goes back to its home screen.
  const finishIfDone = async (s) => {
    const { items } = await packetFor(db, s.packet_id);
    if (items.every((i) => i.status !== 'pending')) {
      await db.run('UPDATE kiosk_sessions SET page = total WHERE id = ?', s.id);
      await endKioskSession(db, s.id, 'completed');
      return true;
    }
    return false;
  };

  // The iPad asks every few seconds: its name, and the patient's session when staff have loaded one.
  r.get('/forms-kiosk/current', perKiosk, async (req, res) => {
    const k = await kioskOf(req);
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', k.practice_id);
    const s = await currentKioskSession(db, k);
    let session = null;
    if (s?.mode === 'forms' && s.packet_id) session = { id: s.id, mode: 'forms', lang: s.lang, status: s.status, ...(await packetView(db, s.packet_id)) };
    else if (s?.mode === 'education' && s.education_delivery_id) {
      const d = await db.get('SELECT d.id, d.slug, d.title, d.version, v.body, v.video_url, v.postop FROM education_deliveries d LEFT JOIN education_versions v ON v.id = d.version_id WHERE d.id = ?', s.education_delivery_id);
      const media = await db.all('SELECT id, kind, mime FROM education_media WHERE practice_id = ? AND slug = ? AND removed_at IS NULL ORDER BY id', k.practice_id, d.slug);
      const p = await db.get('SELECT first_name, language FROM patients WHERE id = ?', s.patient_id);
      const key = (await db.get('SELECT slug FROM practices WHERE id = ?', k.practice_id))?.slug || `p${k.practice_id}`;
      session = { id: s.id, mode: 'education', first_name: p.first_name, language: patientLang(p), article: { ...d, media: media.map((m) => ({ ...m, url: `/api/public/learn-media/${key}/${m.id}` })) } };
    }
    res.json({ kiosk: { id: k.id, name: k.name }, practice, session });
  });
  r.post('/forms-kiosk/sessions/:sid/history', writer, async (req, res) => {
    const { s } = await sessionOf(req);
    const out = await submitHistory(db, storage, { packetId: s.packet_id, body: req.body, who: kioskWho(req, s) });
    res.status(201).json({ ...out, finished: await finishIfDone(s) });
  });
  r.post('/forms-kiosk/sessions/:sid/forms/:rid', writer, async (req, res) => {
    const { s } = await sessionOf(req);
    const out = await submitForm(db, storage, { packetId: s.packet_id, rid: req.params.rid, body: req.body, who: kioskWho(req, s) });
    res.status(201).json({ ...out, finished: await finishIfDone(s) });
  });
  r.post('/forms-kiosk/sessions/:sid/forms/:rid/decline', writer, async (req, res) => {
    const { s } = await sessionOf(req);
    await declineFromPatient(db, storage, { packetId: s.packet_id, rid: req.params.rid, body: req.body, who: kioskWho(req, s) });
    res.json({ ok: true, finished: await finishIfDone(s) });
  });
  r.post('/forms-kiosk/sessions/:sid/progress', perKiosk, async (req, res) => {
    const { s } = await sessionOf(req);
    await progress(db, { packetId: s.packet_id, page: req.body?.page, total: req.body?.total, kioskSession: s });
    res.json({ ok: true });
  });
  // Done, or nobody touched it for a while: the iPad clears itself (forms not reached stay open for another time).
  r.post('/forms-kiosk/sessions/:sid/end', perKiosk, async (req, res) => {
    const k = await kioskOf(req);
    const s = await db.get('SELECT * FROM kiosk_sessions WHERE id = ? AND kiosk_id = ?', Number(req.params.sid), k.id);
    if (!s) throw new HttpError(404, 'Session not found');
    const reason = ['completed', 'idle', 'patient_left'].includes(req.body?.reason) ? req.body.reason : 'idle';
    let ended = 0;
    if (s.mode === 'education' && reason === 'completed') {
      await db.run("UPDATE education_deliveries SET opened_at = COALESCE(opened_at, datetime('now')), open_count = open_count + 1 WHERE id = ?", s.education_delivery_id);
      ended = await endKioskSession(db, s.id, 'completed');
    } else if (reason === 'completed' && s.packet_id) {
      ended = (await finishIfDone(s)) ? 1 : await endKioskSession(db, s.id, 'patient_left');
    } else ended = await endKioskSession(db, s.id, reason);
    if (ended) await logPublic(req, k.practice_id, 'kiosk.session_end', 'kiosk_sessions', s.id, { patient_id: s.patient_id, reason, kiosk: k.name });
    res.json({ ok: true });
  });
  r.post('/forms-kiosk/sessions/:sid/education-viewed', perKiosk, async (req, res) => {
    const k = await kioskOf(req);
    const s = await kioskSessionFor(db, k, req.params.sid);
    if (s.mode !== 'education') throw new HttpError(400, 'Not an education session');
    await db.run("UPDATE education_deliveries SET opened_at = COALESCE(opened_at, datetime('now')), open_count = open_count + 1 WHERE id = ?", s.education_delivery_id);
    await db.run("UPDATE kiosk_sessions SET status = 'active', started_at = COALESCE(started_at, datetime('now')), last_activity_at = datetime('now') WHERE id = ?", s.id);
    publish(k.practice_id, { type: 'kiosk', kiosk_id: k.id, session_id: s.id, patient_id: s.patient_id, status: 'active', mode: 'education' });
    res.json({ ok: true });
  });

  // ---- Take-home education ----
  r.get('/edu/:token', reader, async (req, res) => {
    const d = String(req.params.token).length < 100 ? await db.get('SELECT * FROM education_deliveries WHERE token_hash = ?', hashToken(String(req.params.token))) : null;
    if (!d) throw new HttpError(404, 'This link is not valid');
    const first = !d.opened_at;
    await db.run("UPDATE education_deliveries SET opened_at = COALESCE(opened_at, datetime('now')), open_count = open_count + 1 WHERE id = ?", d.id);
    if (first) {
      await logPublic(req, d.practice_id, 'education.opened', 'education_deliveries', d.id, { patient_id: d.patient_id, slug: d.slug });
      publish(d.practice_id, { type: 'education', patient_id: d.patient_id, delivery_id: d.id, opened: true });
    }
    const v = await db.get('SELECT title, body, video_url, postop FROM education_versions WHERE id = ?', d.version_id);
    const practice = await db.get('SELECT name, phone, slug FROM practices WHERE id = ?', d.practice_id);
    const media = await db.all('SELECT id, kind, mime FROM education_media WHERE practice_id = ? AND slug = ? AND removed_at IS NULL ORDER BY id', d.practice_id, d.slug);
    const key = practice.slug || `p${d.practice_id}`;
    res.json({ practice: { name: practice.name, phone: practice.phone }, title: v.title, body: v.body, video_url: v.video_url, postop: v.postop, media: media.map((m) => ({ ...m, url: `/api/public/learn-media/${key}/${m.id}` })) });
  });
  r.get('/learn-media/:practice/:mid', reader, async (req, res) => {
    const key = String(req.params.practice);
    const practice = /^p\d+$/.test(key) ? await db.get('SELECT id FROM practices WHERE id = ?', Number(key.slice(1))) : await db.get('SELECT id FROM practices WHERE slug = ?', key);
    const m = practice ? await db.get('SELECT * FROM education_media WHERE id = ? AND practice_id = ? AND removed_at IS NULL', Number(req.params.mid), practice.id) : null;
    if (!m) throw new HttpError(404, 'Not found');
    const data = await storage.read(m.storage_key, !!m.encrypted);
    if (!data) throw new HttpError(404, 'Not found');
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=3600' }).send(data);
  });

  return r;
}
