import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, newToken, practiceNow, recorded } from '../util.js';
import { canSeePatient, appointmentScope, checkOffice } from '../officeaccess.js';
import { mintHandoff, HANDOFF_MINUTES } from '../handoff.js';
import {
  dueForVisit, summarize, buildItems, sendPaperwork, nextVisit, endKioskSession, startKioskSession, packetView, runPaperworkSafely,
} from '../paperwork.js';
import { consentView } from '../consents.js';
import { articleFor, recordDelivery, sendTakeHome, proofFor } from '../eduproof.js';
import { libraryFor } from '../education.js';
import { publish } from '../events.js';

// Paperwork (P1–P5) and education (E1–E3), for the team: what's due for a visit, one "Send forms" for any channel
// (text, email, QR code, this screen, the office iPad), the kiosk iPads and their live sessions, forms status for
// the schedule and huddle, and showing/sending education with proof on the chart.
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const CHANNELS = ['auto', 'sms', 'email', 'qr', 'here', 'kiosk'];
const MEDIA_MAX = 60 * 1024 * 1024;

function sniffMedia(buf) {
  const b = buf.subarray(0, 16);
  if (b[0] === 0xff && b[1] === 0xd8) return ['image', 'image/jpeg'];
  if (b.toString('latin1', 1, 4) === 'PNG') return ['image', 'image/png'];
  if (b.toString('latin1', 0, 4) === 'GIF8') return ['image', 'image/gif'];
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return ['image', 'image/webp'];
  if (b.toString('latin1', 4, 8) === 'ftyp') return ['video', 'video/mp4'];
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ['video', 'video/webm'];
  return null;
}

export default function paperworkRoutes({ db, messenger, storage, config }) {
  const r = Router();
  const adminOnly = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change this'); };
  const asId = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${what} must be an id`);
    return n;
  };
  const apptFor = async (req, id, patientId) => {
    const a = await findOr404(db, 'appointments', asId(id, 'appointment_id'), req.user.practice_id, 'Appointment');
    if (patientId && a.patient_id !== patientId) throw new HttpError(400, 'That appointment is for another patient');
    checkOffice(req.user, a.location_id);
    return a;
  };
  const kioskFor = async (req, id) => {
    const k = await findOr404(db, 'forms_kiosks', asId(id, 'kiosk_id'), req.user.practice_id, 'iPad');
    if (k.revoked_at) throw new HttpError(410, 'That iPad was taken out of kiosk mode');
    checkOffice(req.user, k.location_id);
    return k;
  };
  // The iPad to hand over when none is named: the one in the visit's operatory, else the one this person used last,
  // else the only one at the office.
  const defaultKiosk = async (req, appointment) => {
    const live = await db.all('SELECT * FROM forms_kiosks WHERE practice_id = ? AND revoked_at IS NULL ORDER BY id', req.user.practice_id);
    const mine = live.filter((k) => !k.location_id || !req.location_id || k.location_id === req.location_id);
    if (appointment?.operatory_id) { const k = live.find((x) => x.operatory_id === appointment.operatory_id); if (k) return k; }
    const last = await db.get('SELECT kiosk_id FROM kiosk_sessions WHERE practice_id = ? AND created_by = ? ORDER BY id DESC LIMIT 1', req.user.practice_id, req.user.id);
    const k = live.find((x) => x.id === last?.kiosk_id) || (mine.length === 1 ? mine[0] : live.length === 1 ? live[0] : null);
    if (!k) throw new HttpError(400, live.length ? 'Choose which iPad to hand over' : 'No iPad is set up in kiosk mode yet (Settings → Forms & consents → iPads)', { choose_kiosk: live.length > 0 });
    return k;
  };

  // ---- P1: what's due ----
  r.get('/appointments/:id/paperwork', requirePermission('patients:read'), async (req, res) => {
    const a = await apptFor(req, req.params.id);
    const items = await dueForVisit(db, a, { attach: req.query.attach !== 'false', userId: req.user.id, source: 'human' });
    res.json({ appointment_id: a.id, patient_id: a.patient_id, items, summary: summarize(items) });
  });

  r.get('/patients/:id/paperwork', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const now = await practiceNow(db, req.user.practice_id);
    const a = req.query.appointment_id ? await apptFor(req, req.query.appointment_id, p.id) : await nextVisit(db, req.user.practice_id, p.id, now);
    const items = a ? await dueForVisit(db, a, { attach: true, userId: req.user.id, source: 'human' }) : [];
    const consents = [];
    for (const c of await db.all("SELECT * FROM consents WHERE practice_id = ? AND patient_id = ? AND status <> 'superseded' ORDER BY id DESC LIMIT 50", req.user.practice_id, p.id)) consents.push(await consentView(db, c));
    const sessions = await db.all(
      "SELECT s.id, s.kiosk_id, k.name AS kiosk_name, s.status, s.page, s.total, s.mode, s.created_at FROM kiosk_sessions s JOIN forms_kiosks k ON k.id = s.kiosk_id WHERE s.practice_id = ? AND s.patient_id = ? AND s.status IN ('waiting','active') ORDER BY s.id DESC",
      req.user.practice_id, p.id,
    );
    const kiosks = await db.all('SELECT id, name, location_id, operatory_id, last_seen_at FROM forms_kiosks WHERE practice_id = ? AND revoked_at IS NULL ORDER BY name', req.user.practice_id);
    res.json({
      appointment: a ? { id: a.id, start_time: a.start_time, operatory_id: a.operatory_id } : null, items, summary: summarize(items), consents, sessions, kiosks,
      reachable: !!((p.phone && p.sms_opt_in) || (p.email && p.email_opt_in)),
    });
  });

  // P5: forms done / not done for each visit on a day (the schedule and the huddle).
  r.get('/paperwork/status', requirePermission('schedule:read'), async (req, res) => {
    const s = appointmentScope(req.user);
    let appts;
    if (req.query.appointment_ids) {
      const ids = String(req.query.appointment_ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);
      if (!ids.length) return res.json({});
      appts = await db.all(`SELECT a.* FROM appointments a WHERE a.practice_id = ? AND a.id IN (${ids.map(() => '?').join(',')})${s.sql}`, req.user.practice_id, ...ids, ...s.args);
    } else {
      const date = String(req.query.date || (await practiceNow(db, req.user.practice_id)).slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
      appts = await db.all(`SELECT a.* FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time <= ? AND a.status NOT IN ('cancelled','no_show')${s.sql} ORDER BY a.start_time`, req.user.practice_id, `${date} 00:00`, `${date} 23:59`, ...s.args);
    }
    const out = {};
    for (const a of appts) {
      const items = await dueForVisit(db, a, { attach: false });
      out[a.id] = { ...summarize(items), open_items: items.filter((i) => i.status === 'due' || i.status === 'sent').map((i) => i.name) };
    }
    res.json(out);
  });

  // ---- P1/P2/P3: one "Send forms" ----
  r.post('/patients/:id/paperwork/send', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    const b = req.body || {};
    const channel = b.channel || 'auto';
    if (!CHANNELS.includes(channel)) throw new HttpError(400, `channel must be one of: ${CHANNELS.join(', ')}`);
    const now = await practiceNow(db, req.user.practice_id);
    const appointment = b.appointment_id ? await apptFor(req, b.appointment_id, p.id) : await nextVisit(db, req.user.practice_id, p.id, now);
    const ids = (v, what) => (Array.isArray(v) ? v.map((x) => asId(x, what)) : []);
    const items = await buildItems(db, {
      practiceId: req.user.practice_id, patient: p, appointment, templateIds: ids(b.template_ids, 'template_ids'), history: !!b.history, consentIds: ids(b.consent_ids, 'consent_ids'), userId: req.user.id,
    });
    const kiosk = channel === 'kiosk' ? (b.kiosk_id ? await kioskFor(req, b.kiosk_id) : await defaultKiosk(req, appointment)) : null;
    const out = await sendPaperwork(db, messenger, req, { patient: p, appointment, items, channel, kiosk, appUrl: config.appUrl });
    // On this screen: a one-time pass past the birth-date step, for this packet and this signed-in session (handoff.js).
    if (channel === 'here' && !out.repeated) {
      out.handoff = await mintHandoff(db, req, 'forms', out.packet_id);
      await audit(db, req, 'form_request.handoff', 'form_requests', out.packet_id, { patient_id: p.id, minutes: HANDOFF_MINUTES });
    }
    if (kiosk) out.kiosk = { id: kiosk.id, name: kiosk.name };
    res.status(out.repeated ? 200 : 201).json(out);
  });

  // What the patient will see (staff preview, e.g. before handing over).
  r.get('/paperwork/packets/:pid/preview', requirePermission('patients:read'), async (req, res) => {
    const f = await findOr404(db, 'form_requests', asId(req.params.pid, 'Packet'), req.user.practice_id, 'Forms');
    if (!(await canSeePatient(db, req.user, f.patient_id))) throw new HttpError(404, 'Forms not found');
    res.json(await packetView(db, f.packet_id || f.id));
  });

  // ---- Settings ----
  const SETTINGS = ['paperwork_autopilot', 'paperwork_days', 'paperwork_reminders', 'paperwork_remind_hours', 'history_renew_months'];
  r.get('/paperwork/settings', requirePermission('patients:read'), async (req, res) => {
    res.json(await db.get(`SELECT ${SETTINGS.join(', ')} FROM practices WHERE id = ?`, req.user.practice_id));
  });
  r.put('/paperwork/settings', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const b = req.body || {};
    const row = {};
    const num = (k, min, max) => {
      if (b[k] === undefined) return;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k} must be a whole number from ${min} to ${max}`);
      row[k] = n;
    };
    if (b.paperwork_autopilot !== undefined) row.paperwork_autopilot = b.paperwork_autopilot ? 1 : 0;
    num('paperwork_days', 0, 14);
    num('paperwork_reminders', 0, 5);
    num('paperwork_remind_hours', 4, 168);
    num('history_renew_months', 1, 60);
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await recorded(db, 'practices', req.user.practice_id, () => db.run(`UPDATE practices SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), req.user.practice_id));
    await audit(db, req, 'paperwork.settings', 'practices', req.user.practice_id, row);
    res.json(await db.get(`SELECT ${SETTINGS.join(', ')} FROM practices WHERE id = ?`, req.user.practice_id));
  });
  // "Run now" (the job runs on its own every few minutes).
  r.post('/paperwork/run', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    res.json(await runPaperworkSafely(db, messenger, { appUrl: config.appUrl }));
  });

  // ---- P3: kiosk iPads ----
  r.get('/forms-kiosks', requirePermission('patients:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT k.id, k.name, k.location_id, k.operatory_id, o.name AS operatory_name, k.created_at, k.last_seen_at, k.revoked_at, u.name AS created_by_name
       FROM forms_kiosks k LEFT JOIN users u ON u.id = k.created_by LEFT JOIN operatories o ON o.id = k.operatory_id WHERE k.practice_id = ? ORDER BY k.revoked_at IS NOT NULL, k.name`, req.user.practice_id,
    ));
  });
  // Makes the iPad this is called from a kiosk: the token is shown once and kept only on that iPad.
  r.post('/forms-kiosks', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name the iPad (e.g. “Front desk iPad” or “Op 2”)');
    let locationId = null;
    let operatoryId = null;
    if (req.body?.location_id != null) locationId = (await findOr404(db, 'locations', asId(req.body.location_id, 'location_id'), req.user.practice_id, 'Office')).id;
    if (req.body?.operatory_id != null) operatoryId = (await findOr404(db, 'operatories', asId(req.body.operatory_id, 'operatory_id'), req.user.practice_id, 'Operatory')).id;
    const { token, hash } = newToken();
    const id = await insert(db, 'forms_kiosks', { practice_id: req.user.practice_id, location_id: locationId ?? req.location_id ?? null, operatory_id: operatoryId, name, token_hash: hash, created_by: req.user.id });
    await audit(db, req, 'kiosk.create', 'forms_kiosks', id, { name, location_id: locationId, operatory_id: operatoryId });
    res.status(201).json({ id, name, token });
  });
  r.post('/forms-kiosks/:kid/revoke', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const k = await findOr404(db, 'forms_kiosks', asId(req.params.kid, 'iPad'), req.user.practice_id, 'iPad');
    if (!k.revoked_at) {
      await recorded(db, 'forms_kiosks', k.id, () => db.run("UPDATE forms_kiosks SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?", req.user.id, k.id));
      for (const s of await db.all("SELECT id FROM kiosk_sessions WHERE kiosk_id = ? AND status IN ('waiting','active')", k.id)) await endKioskSession(db, s.id, 'revoked');
    }
    await audit(db, req, 'kiosk.revoke', 'forms_kiosks', k.id, { name: k.name });
    res.json({ ok: true });
  });

  // Open sessions (the "Maria is on page 3 of 5" list); updates arrive as live 'kiosk' / 'paperwork_progress' events.
  r.get('/kiosk-sessions', requirePermission('patients:read'), async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.kiosk_id, k.name AS kiosk_name, s.patient_id, p.first_name, p.last_name, s.appointment_id, s.status, s.mode, s.page, s.total, s.created_at, s.last_activity_at, u.name AS created_by_name
       FROM kiosk_sessions s JOIN forms_kiosks k ON k.id = s.kiosk_id JOIN patients p ON p.id = s.patient_id LEFT JOIN users u ON u.id = s.created_by
       WHERE s.practice_id = ? AND s.status IN ('waiting','active') ORDER BY s.id DESC`, req.user.practice_id,
    );
    const out = [];
    for (const s of rows) if (await canSeePatient(db, req.user, s.patient_id)) out.push(s);
    res.json(out);
  });
  r.post('/kiosk-sessions/:sid/cancel', requirePermission('patients:write'), async (req, res) => {
    const s = await findOr404(db, 'kiosk_sessions', asId(req.params.sid, 'Session'), req.user.practice_id, 'Session');
    if (!(await canSeePatient(db, req.user, s.patient_id))) throw new HttpError(404, 'Session not found');
    const n = await endKioskSession(db, s.id, 'cancelled');
    if (n) await audit(db, req, 'kiosk.session_cancel', 'kiosk_sessions', s.id, { patient_id: s.patient_id });
    res.json({ ok: true, ended: !!n });
  });

  // ---- E1–E3: education with proof ----
  r.get('/education/:slug/full', requirePermission('patients:read'), async (req, res) => {
    if (!SLUG.test(String(req.params.slug))) throw new HttpError(400, 'Unknown page');
    res.json(await articleFor(db, req.user.practice_id, String(req.params.slug)));
  });
  // A video link, post-op instructions and a topic on a page (built-in pages become the office's own copy).
  r.put('/education/:slug/extras', requirePermission('patients:write'), async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) throw new HttpError(400, 'Unknown page');
    const a = (await libraryFor(db, req.user.practice_id)).find((x) => x.slug === slug);
    if (!a) throw new HttpError(404, 'Education page not found');
    const b = req.body || {};
    const video = b.video_url == null || b.video_url === '' ? null : String(b.video_url).trim().slice(0, 500);
    if (video && !/^https:\/\/[^\s<>"']+$/.test(video)) throw new HttpError(400, 'The video link must start with https://');
    const row = {
      ...(b.topic !== undefined ? { topic: String(b.topic || '').trim().slice(0, 60) || null } : {}),
      ...(b.video_url !== undefined ? { video_url: video } : {}),
      ...(b.postop !== undefined ? { postop: String(b.postop || '').trim().slice(0, 10_000) || null } : {}),
    };
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const have = await db.get('SELECT id FROM education_articles WHERE practice_id = ? AND slug = ?', req.user.practice_id, slug);
    const id = have?.id ?? await insert(db, 'education_articles', { practice_id: req.user.practice_id, slug, title: a.title, body: a.body, codes: JSON.stringify(a.codes || []), active: 1 });
    await recorded(db, 'education_articles', id, () => db.run(`UPDATE education_articles SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), id));
    await audit(db, req, 'education.extras', 'education_articles', id, { slug, fields: Object.keys(row) });
    res.json(await articleFor(db, req.user.practice_id, slug));
  });
  r.post('/education/:slug/media', requirePermission('patients:write'), express.raw({ type: () => true, limit: MEDIA_MAX }), async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug) || !(await libraryFor(db, req.user.practice_id)).some((x) => x.slug === slug)) throw new HttpError(404, 'Education page not found');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf?.length) throw new HttpError(400, 'Send the picture or video file');
    const kind = sniffMedia(buf);
    if (!kind) throw new HttpError(415, 'Use a JPEG, PNG, GIF or WebP picture, or an MP4 or WebM video');
    if (kind[0] === 'image' && buf.length > 10 * 1024 * 1024) throw new HttpError(413, 'Pictures can be up to 10 MB');
    const filename = String(req.get('X-Filename') || `${slug}.${kind[1].split('/')[1]}`).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const saved = await storage.save(req.user.practice_id, buf);
    const id = await insert(db, 'education_media', { practice_id: req.user.practice_id, slug, kind: kind[0], filename, mime: kind[1], size: buf.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, created_by: req.user.id });
    await audit(db, req, 'education.media_add', 'education_media', id, { slug, kind: kind[0], size: buf.length });
    res.status(201).json({ id, kind: kind[0], mime: kind[1], filename });
  });
  r.post('/education/media/:mid/remove', requirePermission('patients:write'), async (req, res) => {
    const m = await findOr404(db, 'education_media', asId(req.params.mid, 'Media'), req.user.practice_id, 'Picture or video');
    if (!m.removed_at) await recorded(db, 'education_media', m.id, () => db.run("UPDATE education_media SET removed_at = datetime('now') WHERE id = ?", m.id));
    await audit(db, req, 'education.media_remove', 'education_media', m.id, { slug: m.slug });
    res.json({ ok: true });
  });

  // E1/E2: shown in the chair (this screen) or on the iPad — one call, recorded with who, what version, where.
  r.post('/patients/:id/education/show', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    const slug = String(b.slug || '');
    if (!SLUG.test(slug)) throw new HttpError(400, 'Choose a page to show');
    const how = b.how === 'shown_ipad' ? 'shown_ipad' : 'shown_chair';
    const appointment = b.appointment_id ? await apptFor(req, b.appointment_id, p.id) : null;
    let operatoryId = appointment?.operatory_id ?? null;
    if (b.operatory_id != null) operatoryId = (await findOr404(db, 'operatories', asId(b.operatory_id, 'operatory_id'), req.user.practice_id, 'Operatory')).id;
    let kiosk = null;
    if (how === 'shown_ipad') kiosk = b.kiosk_id ? await kioskFor(req, b.kiosk_id) : await defaultKiosk(req, appointment);
    const d = await recordDelivery(db, req, { patient: p, slug, how, appointmentId: appointment?.id ?? null, consentId: b.consent_id ?? null, operatoryId: operatoryId ?? kiosk?.operatory_id ?? null });
    let session = null;
    if (kiosk) {
      session = await startKioskSession(db, req, { kiosk, patient: p, appointmentId: appointment?.id ?? null, mode: 'education', deliveryId: d.id });
      await db.run('UPDATE education_deliveries SET kiosk_session_id = ? WHERE id = ?', session.id, d.id);
      publish(req.user.practice_id, { type: 'kiosk', kiosk_id: kiosk.id, session_id: session.id, patient_id: p.id, first_name: p.first_name, status: 'waiting', mode: 'education' });
    }
    res.status(201).json({ delivery_id: d.id, version: d.version.version, article: d.article, session: session && { id: session.id, kiosk_id: kiosk.id, kiosk_name: kiosk.name } });
  });

  // E3: take-home by text or email (and post-op instructions), each link tracked when opened.
  r.post('/patients/:id/education/take-home', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    const slugs = (Array.isArray(b.slugs) ? b.slugs : [b.slug]).map(String).filter((s) => SLUG.test(s));
    if (!slugs.length) throw new HttpError(400, 'Choose what to send');
    const appointment = b.appointment_id ? await apptFor(req, b.appointment_id, p.id) : null;
    const channel = ['sms', 'email'].includes(b.channel) ? b.channel : 'auto';
    res.status(201).json(await sendTakeHome(db, messenger, req, { patient: p, slugs, channel, appointmentId: appointment?.id ?? null, consentId: b.consent_id ?? null, postop: !!b.postop, appUrl: config.appUrl }));
  });

  // E2: the proof — rows, and the sentence for the clinical note ("Crown (v2) shown on the iPad in Op 2 by Maria…").
  r.get('/patients/:id/education/proof', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const appointmentId = req.query.appointment_id ? (await apptFor(req, req.query.appointment_id, p.id)).id : null;
    let consentId = null;
    if (req.query.consent_id) {
      const c = await findOr404(db, 'consents', asId(req.query.consent_id, 'consent_id'), req.user.practice_id, 'Consent');
      if (c.patient_id !== p.id) throw new HttpError(404, 'Consent not found');
      consentId = c.id;
    }
    res.json(await proofFor(db, req.user.practice_id, p.id, { appointmentId, consentId }));
  });

  // Staff view of an office picture/video.
  r.get('/education/media/:mid', requirePermission('patients:read'), async (req, res) => {
    const m = await findOr404(db, 'education_media', asId(req.params.mid, 'Media'), req.user.practice_id, 'Picture or video');
    const data = await storage.read(m.storage_key, !!m.encrypted);
    if (!data) throw new HttpError(404, 'File missing');
    res.set('Content-Type', m.mime).send(data);
  });

  return r;
}
