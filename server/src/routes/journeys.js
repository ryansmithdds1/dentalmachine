import { Router } from 'express';
import { HttpError, requirePermission, rateLimit } from '../auth.js';
import { audit, findOr404, practiceNow, recorded, validEmail } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { sendMessage } from '../messaging.js';
import { runCadences } from '../cadence.js';
import { withActor } from '../actor.js';
import { publish } from '../events.js';
import {
  JOURNEYS, journeyDef, journeySettings, journeySetting, saveJourney, validateTemplate, journeyProfile, sampleVars, renderJourney, ensureJourneySetup, ensureJourneySchema,
  runJourneyExtras, startBroadcast, broadcastAudience, HOLIDAY_STARTERS, NEWSLETTER_STARTER, welcomeFromToken, unsubscribeNewsletter, configureJourneys, addRow, doctorName, CLINICAL,
} from '../journeys.js';
import { huddleMoments, npsTrend, delightScore, certificatePdf } from '../journeys-insights.js';

// Patient journeys, staff side (docs/workflows/specs/PX-patient-experience.md): the journeys and their wording,
// previews on a phone, a test to yourself, the huddle's moments, milestone certificates, cards to write,
// referrals, holiday cards and newsletters, NPS and the delight score. Mounted on the signed-in API router.

const adminOnly = (req) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change patient journeys');
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (v, name) => {
  if (!DATE.test(String(v || '')) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new HttpError(400, `${name} must be a date (YYYY-MM-DD)`);
  return String(v);
};
const segments = (text) => (/^[\x20-\x7e\n’‘“”—]*$/.test(text) ? Math.ceil(text.length / 153) || 1 : Math.ceil(text.length / 67) || 1);
async function seePatient(db, req, id) {
  const p = await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
  if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
  return p;
}

export default function journeyRoutes({ db, messenger, mailer = null, config = {}, secret }) {
  const r = Router();
  configureJourneys({ appUrl: config.appUrl ?? null, messenger });

  // ---- The journeys ----
  r.get('/journeys', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const p = await db.get('SELECT send_from, send_until, timezone FROM practices WHERE id = ?', pid);
    const counts = await db.all(
      `SELECT s.subtype, COUNT(*) AS n FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id
       WHERE s.practice_id = ? AND s.type = 'journey' AND r.status = 'sent' AND r.created_at >= ? GROUP BY s.subtype`, pid, new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' '),
    );
    res.json({
      journeys: (await journeySettings(db, pid)).map((j) => ({ ...j, sent_30d: Number(counts.find((c) => c.subtype === j.key)?.n) || 0 })),
      send_from: p.send_from || '08:00', send_until: p.send_until || '20:00', timezone: p.timezone, mail: mailer?.enabled ? mailer.name : null,
    });
  });

  // The message on a phone: the saved wording, or wording being edited (not saved), filled in for a pretend patient.
  r.post('/journeys/:key/preview', requirePermission('patients:read'), async (req, res) => {
    const j = journeyDef(req.params.key);
    if (!j?.engine) throw new HttpError(404, 'This journey has no message');
    const s = await journeySetting(db, req.user.practice_id, j.key);
    const channel = req.body?.channel && j.channels.includes(req.body.channel) ? req.body.channel : s.channel;
    const template = req.body?.template != null ? validateTemplate(j, req.body.template, channel) : s.template;
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const vars = await sampleVars(db, practice, j.key);
    const text = renderJourney(template, vars) + (channel === 'text' ? ' Reply STOP to opt out.' : '');
    const subject = renderJourney(req.body?.subject ?? s.subject ?? '', { first_name: vars.first_name, practice: practice.name });
    res.json({ key: j.key, channel, text, subject: ['email'].includes(channel) ? subject : null, segments: channel === 'text' ? segments(text) : null, sample: 'Alex (a pretend patient)' });
  });

  // A test to yourself, filled in for a pretend patient: to your email, or to a mobile number you type for texts.
  r.post('/journeys/:key/test', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const j = journeyDef(req.params.key);
    if (!j?.engine) throw new HttpError(404, 'This journey has no message');
    if (!messenger) throw new HttpError(503, 'Texting and email aren’t set up yet');
    const pid = req.user.practice_id;
    const s = await journeySetting(db, pid, j.key);
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const vars = await sampleVars(db, practice, j.key);
    const text = `[Test] ${renderJourney(s.template, vars)}`;
    const toPhone = req.body?.to && /\d/.test(req.body.to) ? String(req.body.to).replace(/[^\d+]/g, '') : null;
    if (toPhone && toPhone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Type a 10-digit mobile number');
    const me = await db.get('SELECT email FROM users WHERE id = ?', req.user.id);
    const to = toPhone || (req.body?.to && validEmail(req.body.to) ? String(req.body.to).trim() : me?.email);
    if (!to) throw new HttpError(400, 'Type an email address or a mobile number');
    const channel = toPhone ? 'sms' : 'email';
    const msg = await sendMessage(db, messenger, {
      practiceId: pid, channel, to, subject: `[Test] ${renderJourney(s.subject || j.name, { first_name: vars.first_name, practice: practice.name })}`, body: text, kind: 'journey_test', userId: req.user.id,
    });
    await audit(db, req, 'journey.test', 'journey_settings', null, { key: j.key, channel, status: msg.status });
    if (msg.status !== 'sent') throw new HttpError(502, `The test didn’t go: ${msg.error || msg.status}`);
    res.json({ ok: true, channel, to });
  });

  // ---- What the welcome says about the office ----
  r.get('/journeys/profile', requirePermission('patients:read'), async (req, res) => res.json(await journeyProfile(db, req.user.practice_id)));
  r.put('/journeys/profile', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const pid = req.user.practice_id;
    await ensureJourneySchema(db);
    const b = req.body || {};
    const before = await journeyProfile(db, pid);
    const row = {};
    for (const k of ['parking', 'what_to_bring', 'what_to_expect', 'team_note']) {
      if (b[k] == null) continue;
      const v = String(b[k]).trim();
      if (v.length > 600) throw new HttpError(400, 'Keep each part under 600 characters');
      if (CLINICAL.test(v) && k !== 'what_to_expect') throw new HttpError(400, 'Keep clinical details out of this — it goes into texts and emails');
      row[k] = v;
    }
    if (b.doctor_photo !== undefined) {
      if (b.doctor_photo && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(b.doctor_photo))) throw new HttpError(400, 'The photo must be a PNG or JPEG');
      if (b.doctor_photo && String(b.doctor_photo).length > 400_000) throw new HttpError(400, 'The photo is too large (keep it under 300 KB)');
      row.doctor_photo = b.doctor_photo || null;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await db.run('INSERT INTO journey_profile (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
    await db.run(`UPDATE journey_profile SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE practice_id = ?`, ...Object.values(row), req.user.id, pid);
    const after = await journeyProfile(db, pid);
    const log = (x) => ({ ...x, doctor_photo: x.doctor_photo ? '[photo]' : null, updated_at: undefined });
    await audit(db, req, 'journey.profile', 'journey_profile', null, null, { before: log(before), after: log(after) });
    res.json(after);
  });

  // After /journeys/profile (declared above), so that path isn't taken for a journey's key.
  r.put('/journeys/:key', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    res.json(await saveJourney(db, req, req.params.key, req.body || {}));
  });

  // ---- The huddle's moments ----
  r.get('/journeys/moments', requirePermission('schedule:read'), async (req, res) => {
    const date = req.query.date ? dateParam(req.query.date, 'date') : (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    res.json(await huddleMoments(db, req.user, { date }));
  });
  const moment = async (req) => {
    await ensureJourneySchema(db);
    const m = await findOr404(db, 'journey_moments', req.params.id, req.user.practice_id, 'Moment');
    await seePatient(db, req, m.patient_id);
    return m;
  };
  for (const [path, status] of [['done', 'done'], ['dismiss', 'dismissed']]) {
    r.post(`/journeys/moments/:id/${path}`, requirePermission('patients:write'), async (req, res) => {
      const m = await moment(req);
      if (m.status !== 'suggested') return res.json(m); // the same click twice
      await db.run("UPDATE journey_moments SET status = ?, done_by = ?, done_at = datetime('now') WHERE id = ? AND status = 'suggested'", status, req.user.id, m.id);
      await audit(db, req, `journey.moment.${path}`, 'journey_moments', m.id, { kind: m.kind }, { patientId: m.patient_id, before: { status: m.status }, after: { status } });
      publish(req.user.practice_id, { type: 'journeys', patient_id: m.patient_id });
      res.json(await db.get('SELECT * FROM journey_moments WHERE id = ?', m.id));
    });
  }
  // A life event the team chose to celebrate: a card task (never an automatic message).
  r.post('/journeys/moments/:id/card', requirePermission('patients:write'), async (req, res) => {
    const m = await moment(req);
    if (m.task_id) return res.json(m);
    if (req.body?.assign_to && !(await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1', Number(req.body.assign_to), req.user.practice_id))) throw new HttpError(400, 'Choose someone on the team');
    const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', m.patient_id);
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const taskId = await addRow(db, 'tasks', {
      practice_id: req.user.practice_id, patient_id: m.patient_id, assigned_to: req.body?.assign_to ? Number(req.body.assign_to) : req.user.id, priority: 'normal', due_date: today,
      title: `Congratulations card: ${p.first_name} ${p.last_name}${m.detail ? ` — ${m.detail.split(':')[0]}` : ''}`.slice(0, 200), notes: 'Write a short note from the team. Tick this task when the card is in the mail.', created_by: req.user.id,
    });
    await db.run("UPDATE journey_moments SET task_id = ?, status = 'done', done_by = ?, done_at = datetime('now') WHERE id = ?", taskId, req.user.id, m.id);
    await audit(db, req, 'journey.moment.card', 'journey_moments', m.id, { task_id: taskId }, { patientId: m.patient_id });
    publish(req.user.practice_id, { type: 'tasks' });
    res.json(await db.get('SELECT * FROM journey_moments WHERE id = ?', m.id));
  });
  r.get('/journeys/moments/:id/certificate', requirePermission('patients:read'), async (req, res) => {
    const m = await moment(req);
    if (!['braces_off', 'cavity_free'].includes(m.kind)) throw new HttpError(400, 'Certificates are for milestones');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', m.patient_id);
    const provider = patient.primary_provider_id ? await db.get('SELECT * FROM providers WHERE id = ?', patient.primary_provider_id)
      : await db.get("SELECT * FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist' ORDER BY id LIMIT 1", practice.id);
    await audit(db, req, 'journey.certificate', 'journey_moments', m.id, { kind: m.kind }, { patientId: m.patient_id });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="certificate-${m.id}.pdf"`).send(certificatePdf({ practice, patient, moment: m, doctor: doctorName(provider) }));
  });

  // ---- Cards to write (handwritten thank-yous, gifts) ----
  r.get('/journeys/cards', requirePermission('patients:read'), async (req, res) => {
    await ensureJourneySchema(db);
    const open = req.query.status !== 'all';
    res.json(await db.all(
      `SELECT c.id, c.patient_id, c.reason, c.created_at, c.task_id, t.title, t.status AS task_status, t.completed_at, t.assigned_to, p.first_name, p.last_name, p.address, p.city, p.state, p.zip
       FROM journey_cards c JOIN patients p ON p.id = c.patient_id LEFT JOIN tasks t ON t.id = c.task_id WHERE c.practice_id = ?${open ? " AND t.status = 'open'" : ''} ORDER BY c.id DESC LIMIT 200`,
      req.user.practice_id,
    ));
  });
  // "Card sent": the task's checkbox.
  r.post('/journeys/cards/:id/sent', requirePermission('patients:write'), async (req, res) => {
    await ensureJourneySchema(db);
    const c = await findOr404(db, 'journey_cards', req.params.id, req.user.practice_id, 'Card');
    await seePatient(db, req, c.patient_id);
    if (c.task_id) await recorded(db, 'tasks', c.task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'open'", c.task_id));
    await audit(db, req, 'journey.card.sent', 'journey_cards', c.id, { reason: c.reason }, { patientId: c.patient_id });
    publish(req.user.practice_id, { type: 'tasks' });
    res.json({ ...c, task_status: 'done' });
  });

  // ---- Referrals between patients ----
  r.post('/journeys/referrals', requirePermission('patients:write'), async (req, res) => {
    await ensureJourneySchema(db);
    const b = req.body || {};
    const referrer = await seePatient(db, req, b.referrer_patient_id);
    const referred = await seePatient(db, req, b.referred_patient_id);
    if (referrer.id === referred.id) throw new HttpError(400, 'A patient can’t refer themselves');
    const had = await db.get('SELECT * FROM journey_referrals WHERE practice_id = ? AND referred_patient_id = ?', req.user.practice_id, referred.id);
    if (had) {
      if (had.referrer_patient_id === referrer.id) return res.json(had);
      throw new HttpError(409, `${referred.first_name} is already recorded as referred by someone else`);
    }
    const id = await addRow(db, 'journey_referrals', { practice_id: req.user.practice_id, referrer_patient_id: referrer.id, referred_patient_id: referred.id, created_by: req.user.id });
    await audit(db, req, 'journey.referral', 'journey_referrals', id, { referrer_patient_id: referrer.id, referred_patient_id: referred.id }, { patientId: referred.id });
    res.status(201).json(await db.get('SELECT * FROM journey_referrals WHERE id = ?', id));
  });

  // ---- A patient's choices (newsletter, VIP, no celebrations) ----
  r.get('/journeys/patients/:id/prefs', requirePermission('patients:read'), async (req, res) => {
    await ensureJourneySchema(db);
    const p = await seePatient(db, req, req.params.id);
    const x = await db.get('SELECT * FROM journey_prefs WHERE patient_id = ?', p.id);
    const referred = await db.get('SELECT r.*, p.first_name, p.last_name FROM journey_referrals r JOIN patients p ON p.id = r.referrer_patient_id WHERE r.referred_patient_id = ?', p.id);
    res.json({ patient_id: p.id, newsletter: !!x?.newsletter, vip: !!x?.vip, no_celebrations: !!x?.no_celebrations, referred_by: referred ? { id: referred.referrer_patient_id, name: `${referred.first_name} ${referred.last_name}` } : null });
  });
  r.put('/journeys/patients/:id/prefs', requirePermission('patients:write'), async (req, res) => {
    await ensureJourneySchema(db);
    const p = await seePatient(db, req, req.params.id);
    const b = req.body || {};
    const row = {};
    for (const k of ['newsletter', 'vip', 'no_celebrations']) {
      if (b[k] == null) continue;
      if (typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      row[k] = b[k] ? 1 : 0;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const before = (await db.get('SELECT newsletter, vip, no_celebrations FROM journey_prefs WHERE patient_id = ?', p.id)) || { newsletter: 0, vip: 0, no_celebrations: 0 };
    await db.run('INSERT INTO journey_prefs (practice_id, patient_id) VALUES (?, ?) ON CONFLICT (patient_id) DO NOTHING', req.user.practice_id, p.id);
    await db.run(`UPDATE journey_prefs SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}${row.newsletter ? ", newsletter_at = datetime('now')" : ''}, updated_by = ?, updated_at = datetime('now') WHERE patient_id = ?`,
      ...Object.values(row), req.user.id, p.id);
    const after = await db.get('SELECT newsletter, vip, no_celebrations FROM journey_prefs WHERE patient_id = ?', p.id);
    await audit(db, req, 'journey.prefs', 'patients', p.id, null, { patientId: p.id, before, after });
    res.json({ patient_id: p.id, newsletter: !!after.newsletter, vip: !!after.vip, no_celebrations: !!after.no_celebrations });
  });

  // ---- Post-op check-ins (clinical) ----
  r.get('/journeys/checkins', requirePermission('clinical:read'), async (req, res) => {
    await ensureJourneySchema(db);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
    res.json(await db.all(
      `SELECT c.id, c.patient_id, c.visit_date, c.reply, c.reply_text, c.replied_at, c.task_id, p.first_name, p.last_name, pv.name AS provider_name
       FROM journey_checkins c JOIN patients p ON p.id = c.patient_id LEFT JOIN providers pv ON pv.id = c.provider_id WHERE c.practice_id = ? AND c.visit_date >= ? ORDER BY c.visit_date DESC, c.id DESC`,
      req.user.practice_id, from,
    ));
  });

  // ---- Feedback: NPS trend and the delight score ----
  const period = async (req) => {
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const to = req.query.to ? dateParam(req.query.to, 'to') : today;
    const from = req.query.from ? dateParam(req.query.from, 'from') : new Date(Date.parse(`${to}T12:00:00Z`) - 180 * 86400_000).toISOString().slice(0, 10);
    if (from > to) throw new HttpError(400, 'from must be before to');
    return { from, to };
  };
  r.get('/journeys/feedback/nps', requirePermission('reports:read'), async (req, res) => {
    const by = req.query.by === 'location' ? 'location' : 'provider';
    res.json(await npsTrend(db, req.user.practice_id, { ...(await period(req)), by }));
  });
  r.get('/journeys/delight', requirePermission('reports:read'), async (req, res) => {
    await ensureJourneySchema(db);
    res.json(await delightScore(db, req.user.practice_id, await period(req)));
  });

  // ---- Holiday cards and newsletters ----
  r.get('/journeys/broadcasts', requirePermission('patients:read'), async (req, res) => {
    await ensureJourneySchema(db);
    const rows = await db.all('SELECT * FROM journey_broadcasts WHERE practice_id = ? ORDER BY id DESC LIMIT 50', req.user.practice_id);
    const optedIn = await db.get('SELECT COUNT(*) AS n FROM journey_prefs WHERE practice_id = ? AND newsletter = 1', req.user.practice_id);
    res.json({ broadcasts: rows, holiday_starters: HOLIDAY_STARTERS, newsletter_starter: NEWSLETTER_STARTER, newsletter_subscribers: Number(optedIn?.n) || 0 });
  });
  const cleanBroadcast = (b, partial = false) => {
    const out = {};
    if (!partial || b.kind != null) {
      if (!['holiday', 'newsletter'].includes(b.kind)) throw new HttpError(400, 'Choose a holiday card or a newsletter');
      out.kind = b.kind;
    }
    if (!partial || b.channel != null) {
      const ch = b.channel || 'email';
      if (!['email', 'postcard'].includes(ch)) throw new HttpError(400, 'Send by email or as a mailed postcard');
      out.channel = ch;
    }
    for (const [k, max, need] of [['title', 120, true], ['subject', 200, false], ['body', 5000, true]]) {
      if (partial && b[k] == null) continue;
      const v = String(b[k] ?? '').trim();
      if (need && !v) throw new HttpError(400, k === 'body' ? 'Write what it says' : 'Give it a name');
      if (v.length > max) throw new HttpError(400, `Keep the ${k} under ${max} characters`);
      const bad = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !['first_name', 'practice', 'phone', 'address'].includes(x));
      if (bad.length) throw new HttpError(400, `{${bad[0]}} can’t be used here — use {first_name}, {practice}, {phone} or {address}`);
      out[k] = v || null;
    }
    return out;
  };
  r.post('/journeys/broadcasts', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    await ensureJourneySchema(db);
    const row = cleanBroadcast(req.body || {});
    if (row.kind === 'newsletter' && row.channel !== 'email') throw new HttpError(400, 'Newsletters go by email');
    const id = await addRow(db, 'journey_broadcasts', { practice_id: req.user.practice_id, ...row, created_by: req.user.id });
    await audit(db, req, 'journey.broadcast.create', 'journey_broadcasts', id, { kind: row.kind, title: row.title });
    res.status(201).json(await db.get('SELECT * FROM journey_broadcasts WHERE id = ?', id));
  });
  const broadcast = async (req) => {
    await ensureJourneySchema(db);
    return findOr404(db, 'journey_broadcasts', req.params.id, req.user.practice_id, 'Card or newsletter');
  };
  r.put('/journeys/broadcasts/:id', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const b = await broadcast(req);
    if (b.status !== 'draft') throw new HttpError(409, 'It has already gone out — make a new one instead');
    const row = cleanBroadcast(req.body || {}, true);
    delete row.kind;
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    if (b.kind === 'newsletter' && row.channel && row.channel !== 'email') throw new HttpError(400, 'Newsletters go by email');
    await db.run(`UPDATE journey_broadcasts SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status = 'draft'`, ...Object.values(row), b.id);
    const after = await db.get('SELECT * FROM journey_broadcasts WHERE id = ?', b.id);
    await audit(db, req, 'journey.broadcast.update', 'journey_broadcasts', b.id, null, { before: { title: b.title, subject: b.subject, body: b.body, channel: b.channel }, after: { title: after.title, subject: after.subject, body: after.body, channel: after.channel } });
    res.json(after);
  });
  r.get('/journeys/broadcasts/:id/audience', requirePermission('patients:read'), async (req, res) => {
    const b = await broadcast(req);
    const people = await broadcastAudience(db, req.user.practice_id, b.kind, b.channel);
    res.json({ count: people.length });
  });
  r.post('/journeys/broadcasts/:id/send', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const b = await broadcast(req);
    if (b.channel === 'postcard' && !mailer?.enabled) throw new HttpError(409, 'Mailing isn’t set up — connect a mail service in Settings → Integrations first');
    res.json(await startBroadcast(db, req, b));
  });
  r.post('/journeys/broadcasts/:id/cancel', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const b = await broadcast(req);
    if (b.status === 'sent') throw new HttpError(409, 'It has already gone out');
    await db.run("UPDATE journey_broadcasts SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('draft','sending')", b.id);
    // What hadn't gone yet stays unsent (scratch rows of the send queue).
    await db.run("UPDATE journey_broadcast_recipients SET status = 'skipped', result = 'cancelled' WHERE broadcast_id = ? AND status = 'pending'", b.id);
    await audit(db, req, 'journey.broadcast.cancel', 'journey_broadcasts', b.id, { title: b.title });
    res.json(await db.get('SELECT * FROM journey_broadcasts WHERE id = ?', b.id));
  });

  // Runs this practice's journeys now (after switching one on, or for a demo).
  r.post('/journeys/run-now', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const pid = req.user.practice_id;
    await ensureJourneySetup(db, pid);
    await audit(db, req, 'journey.run_now', 'practices', pid);
    const deps = { messenger, mailer, appUrl: config.appUrl, secret, practiceIds: [pid] };
    const cadence = await runCadences(db, deps);
    const extras = await withActor({ source: 'automation', actor: 'Patient journeys' }, () => runJourneyExtras(db, deps));
    res.json({ ...cadence, ...extras });
  });

  return r;
}

// The patient's side: the welcome page (first name, the visit and the office — nothing clinical) and the
// newsletter's unsubscribe. Mounted under /api/public.
export function journeyPublicRoutes({ db }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 30, name: 'journeys' });
  r.get('/journeys/welcome/:token', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await welcomeFromToken(db, req.params.token));
  });
  r.get('/journeys/unsubscribe/:token', limiter, async (req, res) => {
    const x = await unsubscribeNewsletter(db, req.params.token);
    res.json({ practice_name: x.practice_name });
  });
  r.post('/journeys/unsubscribe/:token', limiter, async (req, res) => {
    const x = await unsubscribeNewsletter(db, req.params.token);
    const before = await db.get('SELECT newsletter FROM journey_prefs WHERE patient_id = ?', x.patient_id);
    await db.run("UPDATE journey_prefs SET newsletter = 0, updated_at = datetime('now') WHERE patient_id = ? AND newsletter = 1", x.patient_id);
    await audit(db, { user: { practice_id: x.practice_id, id: null } }, 'journey.newsletter.unsubscribe', 'patients', x.patient_id, null, {
      patientId: x.patient_id, source: 'patient', actor: 'Patient (unsubscribe link)', before: { newsletter: before?.newsletter ?? 0 }, after: { newsletter: 0 },
    });
    // Only the newsletter: appointment reminders and the rest keep going (the patient can say STOP for those).
    res.json({ ok: true, practice_name: x.practice_name });
  });
  return r;
}

export const JOURNEY_KEYS = JOURNEYS.map((j) => j.key);
