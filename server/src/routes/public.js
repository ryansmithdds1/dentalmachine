import express, { Router } from 'express';
import { HttpError, rateLimit, signToken, verifyToken } from '../auth.js';
import { insert, update, hashToken, practiceNow, normalizeDateTime, audit, mapSeq, publicPractice, friendlyDateTime, recorded } from '../util.js';
import { MEDICAL_CONDITIONS, parseMedicalHistory, contactUpdatesFromHistory } from '../forms.js';
import { fillFields, checkAnswers, formPdf } from '../formtemplates.js';
import { patientLang } from '../templates.js';
import { finishBooking } from '../onlinebooking.js';
import { emitAppointment } from '../webhooks.js';
import { sendAppointmentReminder, visitsIcs, mapsUrl, recordOptOut } from '../messaging.js';
import { openSlots, releaseAppointment } from './schedule.js';
import { openSlotLater } from '../fill.js';
import { publish } from '../events.js';
import { officeHours } from '../hours.js';
import { parseDurations } from '../patterns.js';
import { sniffMime } from './imaging.js';
import { MAX_UPLOAD_BYTES } from './documents.js';

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Used only for practices that haven't marked any appointment types as bookable online.
const FALLBACK_REASONS = [
  { label: 'New patient exam & cleaning', duration: 60 },
  { label: 'Checkup & cleaning', duration: 60 },
  { label: 'Tooth pain / emergency', duration: 30 },
  { label: 'Consultation', duration: 30 },
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Unauthenticated endpoints reached from links sent to patients and the public booking page.
// They expose only the minimum needed and are rate limited.
// A short pass to one form packet (see /forms/:token/verify); the portal hands one out with its links.
export const formPass = (requestId, secret) => signToken({ sub: requestId, aud: 'form-view' }, secret, 2 * 3600);

export default function publicRoutes({ db, storage, payments, messenger, config, secret }) {
  // Books a request right away; if the slot can't be booked after all it stays a request for the office.
  const bookInstantly = async (b) => {
    try {
      const apptId = await finishBooking(db, b);
      publish(b.practice_id, { type: 'schedule', dates: [b.requested_start.slice(0, 10)], source: 'patient' });
      if (messenger) await sendAppointmentReminder(db, messenger, { appointmentId: apptId, appUrl: config.appUrl, kind: 'booking_confirmation' });
      return apptId;
    } catch (err) {
      if (err.status && err.status < 500) return null;
      throw err;
    }
  };
  const r = Router();
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });

  // ---- Scan to chart from a phone (a 15-minute link shown to staff as a QR code) ----
  const uploadLink = async (token) => {
    const link = await db.get('SELECT * FROM upload_links WHERE token_hash = ?', hashToken(String(token)));
    if (!link) throw new HttpError(404, 'This link is not valid');
    if (link.expires_at < new Date().toISOString()) throw new HttpError(410, 'This link has expired — make a new one on the computer');
    return link;
  };
  const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, name: 'phone-upload' });
  r.get('/upload/:token', uploadLimiter, async (req, res) => {
    const link = await uploadLink(req.params.token);
    const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', link.patient_id);
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', link.practice_id);
    // First name and last initial only: enough for staff to see it's the right chart.
    res.json({ practice: practice.name, patient: `${p.first_name} ${p.last_name.slice(0, 1)}.`, category: link.category, expires_at: link.expires_at, uploads: link.uploads });
  });
  r.post('/upload/:token', uploadLimiter, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const link = await uploadLink(req.params.token);
    if (link.uploads >= 40) throw new HttpError(429, 'That is plenty for one link — make a new one');
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Empty upload');
    const filename = String(req.query.filename || 'scan').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    const mime = sniffMime(data, filename);
    if (!mime) throw new HttpError(415, 'Photos and PDFs only');
    const saved = await storage.save(link.practice_id, data);
    const id = await insert(db, 'documents', {
      practice_id: link.practice_id, patient_id: link.patient_id, category: link.category, filename, mime, size: data.length,
      storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, uploaded_by: link.created_by, notes: 'Scanned from a phone',
    });
    await db.run('UPDATE upload_links SET uploads = uploads + 1 WHERE id = ?', link.id);
    await audit(db, { user: { practice_id: link.practice_id, id: link.created_by }, ip: req.ip }, 'document.phone_upload', 'documents', id, { patient_id: link.patient_id });
    publish(link.practice_id, { type: 'documents', patient_id: link.patient_id });
    res.status(201).json({ ok: true, id });
  });
  const reader = rateLimit({ windowMs: 60 * 1000, max: 120 });
  const logPublic = async (req, practiceId, action, entity, entityId, details) => await audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, action, entity, entityId, details);

  const bookablePractice = async (slug) => {
    const p = publicPractice(await db.get('SELECT * FROM practices WHERE slug = ? AND online_booking = 1', String(slug)));
    if (!p) throw new HttpError(404, 'Online booking is not available for this practice');
    return p;
  };
  const reasonsFor = async (practiceId) => {
    const types = await db.all('SELECT id, name, name_es, duration, provider_type, deposit, provider_durations FROM appointment_types WHERE practice_id = ? AND active = 1 AND online_bookable = 1 ORDER BY sort, name', practiceId);
    // Deposits are only asked for when card payments are set up.
    return types.length ? types.map((t) => ({ label: t.name, label_es: t.name_es || null, duration: t.duration, durations: parseDurations(t.provider_durations), type_id: t.id, provider_type: t.provider_type, deposit: payments?.mode === 'stripe' ? t.deposit || 0 : 0 })) : FALLBACK_REASONS;
  };
  const publicLocations = async (practiceId) => await db.all('SELECT id, name, address, city, state, zip, phone, office_hours FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', practiceId);
  // Which office a patient is booking at (multi-location practices); null for a single office.
  const bookingLocation = async (practiceId, id) => {
    const list = await publicLocations(practiceId);
    if (!list.length) return null;
    const found = list.find((l) => l.id === Number(id)) || (list.length === 1 ? list[0] : null);
    if (!found) throw new HttpError(400, 'Choose an office');
    return found;
  };
  const publicProviders = async (practiceId) => await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY type, name', practiceId);

  // ---- Online booking ----
  r.get('/practices/:slug', reader, async (req, res) => {
    const p = await bookablePractice(req.params.slug);
    res.json({
      name: p.name, phone: p.phone, address: p.address, city: p.city, state: p.state, zip: p.zip,
      today: (await practiceNow(db, p.id)).slice(0, 10), providers: await publicProviders(p.id), reasons: await reasonsFor(p.id),
      instant: !!p.instant_booking,
      locations: (await publicLocations(p.id)).map(({ office_hours: hours, ...l }) => ({
        ...l, open_days: Object.entries(officeHours(hours ? { office_hours: hours } : p)).filter(([, r]) => r.length).map(([d]) => Number(d)),
      })),
      open_days: Object.entries(officeHours(p)).filter(([, r]) => r.length).map(([d]) => Number(d)),
    });
  });

  r.get('/practices/:slug/availability', reader, async (req, res) => {
    const p = await bookablePractice(req.params.slug);
    const { date } = req.query;
    if (!DATE.test(date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const reasons = await reasonsFor(p.id);
    const reason = reasons.find((x) => x.label === req.query.reason) || reasons[0];
    const duration = reason.duration;
    const location = req.query.location_id ? await bookingLocation(p.id, req.query.location_id) : null;
    const now = await practiceNow(db, p.id);
    // Office hours decide which days/times are offered; a hygiene visit is only offered with hygienists, etc.
    const all = await publicProviders(p.id);
    const providers = all
      .filter((pv) => !req.query.provider_id || pv.id === Number(req.query.provider_id))
      .filter((pv) => req.query.provider_id || !reason.provider_type || pv.type === reason.provider_type || !all.some((x) => x.type === reason.provider_type));
    const slotsOn = async (d) => (await mapSeq(
      providers,
      async (pv) => (await openSlots(db, p.id, pv.id, d, { duration: reason.durations?.[pv.id] || duration, step: 30, after: now, typeId: reason.type_id, locationId: location?.id })).map((s) => ({ start: s, provider_id: pv.id, provider_name: pv.name }))
    )).flat()
      .sort((x, y) => x.start.localeCompare(y.start));
    const slots = await slotsOn(date);
    // Point patients at the next day with openings instead of making them click through full days.
    let nextAvailable = null;
    if (!slots.length || req.query.next === '1') {
      for (let i = 1; i <= 45 && !nextAvailable; i++) {
        const d = new Date(Date.parse(`${date}T12:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
        if ((await slotsOn(d)).length) nextAvailable = d;
      }
    }
    res.json({ date, duration, slots, next_available: nextAvailable });
  });

  r.post('/practices/:slug/booking-requests', limiter, async (req, res) => {
    const p = await bookablePractice(req.params.slug);
    const b = req.body || {};
    if (b.website) return res.status(201).json({ ok: true }); // honeypot: silently drop bots
    const first = String(b.first_name || '').trim();
    const last = String(b.last_name || '').trim();
    if (!first || !last) throw new HttpError(400, 'First and last name are required');
    if (!b.phone && !b.email) throw new HttpError(400, 'A phone number or email is required so we can confirm');
    if (b.dob && !DATE.test(b.dob)) throw new HttpError(400, 'Date of birth must be YYYY-MM-DD');
    const reasons = await reasonsFor(p.id);
    const reason = reasons.find((x) => x.label === b.reason) || reasons[0];
    const start = normalizeDateTime(b.start, 'start');
    if (start <= (await practiceNow(db, p.id))) throw new HttpError(400, 'Please choose a future time');
    const providerId = Number(b.provider_id);
    if (!(await publicProviders(p.id)).some((pv) => pv.id === providerId)) throw new HttpError(400, 'Choose a provider');
    const location = await bookingLocation(p.id, b.location_id);
    const visitLength = reason.durations?.[providerId] || reason.duration;
    const free = await openSlots(db, p.id, providerId, start.slice(0, 10), { duration: visitLength, step: 30, typeId: reason.type_id, locationId: location?.id });
    if (!free.includes(start)) throw new HttpError(409, 'That time was just taken. Please pick another.');
    const deposit = reason.deposit > 0 ? reason.deposit : 0;
    const clip = (v, n) => (v ? String(v).trim().slice(0, n) || null : null);
    const id = await insert(db, 'booking_requests', {
      practice_id: p.id, first_name: first.slice(0, 80), last_name: last.slice(0, 80), dob: b.dob || null,
      phone: clip(b.phone, 30), email: clip(b.email, 200),
      reason: reason.label, duration: visitLength, provider_id: providerId, requested_start: start,
      new_patient: b.new_patient === false ? 0 : 1, notes: clip(b.notes, 1000), ip: req.ip, language: b.language === 'es' ? 'es' : null, location_id: location?.id ?? null,
      // Where the booking came from (?src= on the link: google, website, facebook…).
      source: /^[a-z0-9_-]{2,30}$/.test(String(b.source || '')) ? b.source : null,
      referral_source: clip(b.referral_source, 100), insurance_carrier: clip(b.insurance_carrier, 100), insurance_member_id: clip(b.insurance_member_id, 40), insurance_subscriber: clip(b.insurance_subscriber, 120),
      ...(deposit ? { deposit_amount: deposit, deposit_status: 'awaiting', hold_until: new Date(Date.now() + 35 * 60_000).toISOString() } : {}),
    });
    await logPublic(req, p.id, 'booking.request', 'booking_requests', id);
    // A deposit is paid on Stripe's page first; the booking completes when Stripe tells us it's paid.
    if (deposit) {
      const back = `${config.appUrl}/book/${p.slug}`;
      const session = await payments.stripe('POST', 'checkout/sessions', {
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(deposit), 'line_items[0][price_data][product_data][name]': `${p.name} — deposit for ${reason.label}`,
        'metadata[booking_request_id]': String(id), 'metadata[practice_id]': String(p.id), 'payment_intent_data[metadata][practice_id]': String(p.id), client_reference_id: `booking-${id}`,
        ...(b.email ? { customer_email: String(b.email) } : {}),
        expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60), success_url: `${back}?deposit=paid`, cancel_url: `${back}?deposit=cancelled`,
      });
      await db.run('UPDATE booking_requests SET deposit_session_id = ? WHERE id = ?', session.id, id);
      return res.status(201).json({ ok: true, id, checkout_url: session.url, deposit });
    }
    // Instant booking: straight onto the schedule, with a confirmation.
    if (p.instant_booking) {
      const booked = await bookInstantly(await db.get('SELECT * FROM booking_requests WHERE id = ?', id));
      if (booked) return res.status(201).json({ ok: true, id, booked: true, start });
    }
    res.status(201).json({ ok: true, id });
  });

  // ---- Appointment confirmation links ----
  // A link covers one visit, or a family's visits on one day. Older links keep working until the day after
  // the visit; links from before shared links existed are found on the appointment itself.
  const linkFor = async (token) => {
    const hash = hashToken(token);
    const rows = await db.all('SELECT * FROM confirm_links WHERE token_hash = ? ORDER BY id', hash);
    if (rows.length) return { ids: rows.map((x) => x.appointment_id), recipientId: rows[0].recipient_id, channel: rows[0].channel, address: rows[0].address };
    const old = await db.get('SELECT id FROM appointments WHERE confirm_token_hash = ?', hash);
    if (!old) throw new HttpError(404, 'This link is no longer valid');
    return { ids: [old.id], recipientId: null, channel: null, address: null };
  };
  const visitsFor = async (token, { expired = true } = {}) => {
    const link = await linkFor(token);
    const visits = await db.all(
      `SELECT a.*, p.first_name, p.language, pr.name AS practice_name, pr.phone AS practice_phone, pr.address, pr.city, pr.state, pr.zip, pr.timezone,
         pv.name AS provider_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN practices pr ON pr.id = a.practice_id
       JOIN providers pv ON pv.id = a.provider_id WHERE a.id IN (${link.ids.map(() => '?').join(',')}) ORDER BY a.start_time, a.id`, ...link.ids,
    );
    if (!visits.length) throw new HttpError(404, 'This link is no longer valid');
    // A reminder link stops working the day after the (last) visit.
    const yesterday = new Date(Date.parse(`${(await practiceNow(db, visits[0].practice_id)).slice(0, 10)}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    if (expired && visits.every((v) => v.start_time.slice(0, 10) < yesterday)) throw new HttpError(410, 'This link has expired');
    const recipient = link.recipientId ? await db.get('SELECT id, first_name, language FROM patients WHERE id = ?', link.recipientId) : null;
    return { link, visits, recipient };
  };
  const OPEN = ['scheduled', 'confirmed'];
  const view = async ({ visits, recipient }) => {
    const a = visits[0];
    const now = await practiceNow(db, a.practice_id);
    const practice = { name: a.practice_name, phone: a.practice_phone, address: a.address, city: a.city, state: a.state, zip: a.zip };
    return {
      first_name: recipient?.first_name || a.first_name, start_time: a.start_time, end_time: a.end_time, status: a.status, provider_name: a.provider_name,
      language: patientLang(recipient || a), video_url: a.video_url || null,
      practice: { ...practice, maps_url: mapsUrl(practice), timezone: a.timezone },
      visits: visits.map((v) => ({
        id: v.id, first_name: v.first_name, start_time: v.start_time, end_time: v.end_time, status: v.status, provider_name: v.provider_name,
        video_url: v.video_url || null, upcoming: v.start_time > now,
      })),
    };
  };
  // Which visits an action is for: the one named, or all of them.
  const pick = (visits, id) => {
    if (id == null) return visits;
    const v = visits.find((x) => x.id === Number(id));
    if (!v) throw new HttpError(404, 'That visit isn’t on this link');
    return [v];
  };

  r.get('/confirm/:token', reader, async (req, res) => res.json(await view(await visitsFor(req.params.token))));

  // The visits as a calendar file.
  r.get('/confirm/:token/calendar.ics', reader, async (req, res) => {
    const { visits } = await visitsFor(req.params.token);
    const active = visits.filter((v) => OPEN.includes(v.status));
    if (!active.length) throw new HttpError(404, 'No upcoming visits on this link');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', visits[0].practice_id);
    res.set('Content-Type', 'text/calendar; charset=utf-8').set('Content-Disposition', 'attachment; filename="appointment.ics"')
      .send(visitsIcs(active, practice, `${config.appUrl}/c/${req.params.token}`));
  });

  r.post('/confirm/:token', limiter, async (req, res) => {
    const found = await visitsFor(req.params.token);
    const { visits, link } = found;
    const action = req.body?.action;
    const now = await practiceNow(db, visits[0].practice_id);
    const practiceId = visits[0].practice_id;
    const targets = pick(visits, req.body?.appointment_id).filter((v) => v.start_time > now);
    if (!targets.length) throw new HttpError(409, 'This appointment has already passed');
    if (!['confirm', 'cancel', 'reschedule'].includes(action)) throw new HttpError(400, 'action must be confirm, cancel or reschedule');
    // Cancelling or moving one visit of several needs to say which.
    if (action !== 'confirm' && req.body?.appointment_id == null && targets.length > 1) throw new HttpError(400, 'Choose which visit');
    const open = targets.filter((v) => OPEN.includes(v.status));
    if (!open.length) throw new HttpError(409, `This appointment is ${targets[0].status.replace('_', ' ')}`);

    if (action === 'confirm') {
      // Confirmed from a link: by text or by email, whichever the link came in.
      const via = link.channel || (await db.get("SELECT channel FROM messages WHERE appointment_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1", open[0].id))?.channel;
      for (const v of open) {
        await recorded(db, 'appointments', v.id, () => db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, datetime('now')), confirmed_via = ? WHERE id = ? AND status IN ('scheduled','confirmed')", via === 'email' ? 'email' : 'text', v.id));
      }
    } else {
      const v = open[0];
      const hoursLeft = (Date.parse(`${v.start_time.replace(' ', 'T')}:00Z`) - Date.parse(`${now.replace(' ', 'T')}:00Z`)) / 3600000;
      const when = friendlyDateTime(v.start_time);
      const note = String(req.body?.note || '').trim().slice(0, 300);
      if (action === 'cancel') {
        await recorded(db, 'appointments', v.id, () => db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", v.id));
        await releaseAppointment(db, v.id);
        openSlotLater(db, v.id);
        // The front desk hears about it, with who might fill the opening.
        const asap = (await db.get(
          "SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND asap = 1 AND status IN ('scheduled','confirmed') AND start_time > ? AND patient_id != ?", practiceId, v.start_time, v.patient_id,
        )).n + (await db.get("SELECT COUNT(*) AS n FROM waitlist WHERE practice_id = ? AND status = 'waiting' AND patient_id != ?", practiceId, v.patient_id)).n;
        const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', v.patient_id);
        await insert(db, 'tasks', {
          practice_id: practiceId, patient_id: v.patient_id, priority: hoursLeft < 48 ? 'high' : 'normal', due_date: now.slice(0, 10),
          title: `${p.first_name} ${p.last_name} cancelled ${when} with ${v.provider_name} from their reminder${hoursLeft < 24 ? ' (less than 24 hours’ notice)' : ''}.${asap ? ` ${asap} on the ASAP list / waitlist could take the opening.` : ''} Call to rebook.${note ? ` They wrote: "${note}"` : ''}`,
        });
      } else {
        const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', v.patient_id);
        await insert(db, 'tasks', {
          practice_id: practiceId, patient_id: v.patient_id, priority: hoursLeft < 72 ? 'high' : 'normal', due_date: now.slice(0, 10),
          title: `${p.first_name} ${p.last_name} asked for a new time instead of ${when} with ${v.provider_name}.${note ? ` They wrote: "${note}"` : ''} Call to reschedule.`,
        });
      }
    }
    publish(practiceId, { type: 'schedule', dates: [...new Set(open.map((v) => v.start_time.slice(0, 10)))], source: 'patient' });
    publish(practiceId, { type: 'tasks' });
    for (const v of action === 'confirm' ? open : open.slice(0, 1)) {
      await logPublic(req, practiceId, `appointment.patient_${action}`, 'appointments', v.id);
      if (action !== 'reschedule') await emitAppointment(db, v.id);
    }
    res.json({ ...(await view(await visitsFor(req.params.token))), ...(action === 'reschedule' ? { reschedule_requested: open[0].id } : {}) });
  });

  // "Stop appointment emails", from the email footer or the mail app's one-click unsubscribe (a POST).
  // The GET only shows a button, so link scanners can't unsubscribe anyone.
  const stopEmails = async (token) => {
    const { link, visits, recipient } = await visitsFor(token, { expired: false });
    const practiceId = visits[0].practice_id;
    const address = link.channel === 'email' ? link.address : (await db.get('SELECT email FROM patients WHERE id = ?', recipient?.id ?? visits[0].patient_id))?.email;
    if (address) await recordOptOut(db, practiceId, 'email', address, 'unsubscribe');
    await recorded(db, 'patients', recipient?.id ?? visits[0].patient_id, () => db.run('UPDATE patients SET email_opt_in = 0 WHERE id = ?', recipient?.id ?? visits[0].patient_id));
    return visits[0].practice_name;
  };
  const page = (title, body) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1f2933">${body}</body></html>`;
  r.get('/confirm/:token/stop-emails', reader, async (req, res) => {
    const { visits } = await visitsFor(req.params.token, { expired: false });
    res.type('html').send(page('Appointment emails', `<h2>${escHtml(visits[0].practice_name)}</h2><p>Stop getting appointment emails? You'll still get texts if you have them on.</p><form method="post"><button style="padding:10px 18px;font-size:16px">Stop appointment emails</button></form>`));
  });
  r.post('/confirm/:token/stop-emails', limiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const name = await stopEmails(req.params.token);
    await logPublic(req, (await visitsFor(req.params.token, { expired: false })).visits[0].practice_id, 'patient.email_optout', 'patients', null);
    res.type('html').send(page('Unsubscribed', `<h2>${escHtml(name)}</h2><p>Done — you won't get appointment emails from us anymore. To turn them back on, just let the office know.</p>`));
  });

  // ---- Review routing ----
  // "How did we do?": 4-5 stars (or the practice's threshold) are invited to post a public review;
  // lower ratings go privately to the office, which gets a task to follow up.
  const reviewFor = async (token) => {
    const f = await db.get(
      `SELECT rf.*, p.first_name, p.last_name, p.language, pr.name AS practice_name, pr.review_url, pr.review_threshold, pr.phone AS practice_phone
       FROM review_feedback rf JOIN patients p ON p.id = rf.patient_id JOIN practices pr ON pr.id = rf.practice_id WHERE rf.token_hash = ?`, hashToken(token),
    );
    if (!f) throw new HttpError(404, 'This link is not valid');
    if (new Date(`${f.sent_at.replace(' ', 'T')}Z`) < new Date(Date.now() - 30 * 86400_000)) throw new HttpError(410, 'This link has expired. Thank you anyway!');
    return f;
  };
  const reviewView = (f) => ({
    practice_name: f.practice_name, first_name: f.first_name, rating: f.rating, comment: f.comment, practice_phone: f.practice_phone, language: patientLang(f),
    happy: f.rating != null && f.rating >= (f.review_threshold || 4), review_link: !!f.review_url,
  });
  r.get('/review/:token', reader, async (req, res) => res.json(reviewView(await reviewFor(req.params.token))));
  r.post('/review/:token', limiter, async (req, res) => {
    const f = await reviewFor(req.params.token);
    const rating = req.body?.rating != null ? Number(req.body.rating) : f.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Choose 1 to 5 stars');
    const comment = req.body?.comment != null ? String(req.body.comment).trim().slice(0, 2000) || null : f.comment;
    await db.tx(async () => {
      await db.run("UPDATE review_feedback SET rating = ?, comment = ?, responded_at = COALESCE(responded_at, datetime('now')) WHERE id = ?", rating, comment, f.id);
      // Unhappy patients get a call back: one task per answer, updated if they add more.
      if (rating < (f.review_threshold || 4)) {
        const title = `Unhappy after visit (${rating}★): ${f.first_name} ${f.last_name}${comment ? ` — “${comment.slice(0, 140)}”` : ''}`;
        if (f.task_id) await db.run('UPDATE tasks SET title = ? WHERE id = ?', title, f.task_id);
        else {
          const today = new Date().toISOString().slice(0, 10);
          const taskId = await insert(db, 'tasks', { practice_id: f.practice_id, patient_id: f.patient_id, priority: 'high', due_date: today, title });
          await db.run('UPDATE review_feedback SET task_id = ? WHERE id = ?', taskId, f.id);
        }
      }
    });
    await logPublic(req, f.practice_id, 'review.feedback', 'review_feedback', f.id, { rating });
    res.json(reviewView(await reviewFor(req.params.token)));
  });
  // The public review page, via us so the office can see who went on to leave one.
  r.get('/review/:token/go', reader, async (req, res) => {
    const f = await reviewFor(req.params.token);
    if (!f.review_url || f.rating == null || f.rating < (f.review_threshold || 4)) throw new HttpError(404, 'No review page');
    await db.run('UPDATE review_feedback SET went_to_review = 1 WHERE id = ?', f.id);
    res.redirect(302, f.review_url);
  });

  // ---- Patient forms ----
  // A link opens a packet: the health history and/or practice forms sent together.
  // Like plan links: the link alone doesn't open the forms (they show contact details and take health
  // history); the patient confirms their birth date and gets a short pass (X-Form-Pass). Portal links carry one.
  const formPassOk = (req, f) => {
    if (!f.dob) return true; // nothing on file to check against
    const pass = verifyToken(req.get('X-Form-Pass') || '', secret);
    return !!pass && pass.aud === 'form-view' && pass.sub === f.id;
  };
  const packetForToken = async (token, req = null) => {
    const f = await db.get(
      `SELECT fr.*, p.first_name, p.last_name, p.dob, p.phone, p.email, p.address, p.city, p.state, p.zip, p.emergency_contact,
         p.allergies, p.medications, p.language, pr.name AS practice_name
       FROM form_requests fr JOIN patients p ON p.id = fr.patient_id JOIN practices pr ON pr.id = fr.practice_id
       WHERE fr.token_hash = ?`, hashToken(token),
    );
    if (!f) throw new HttpError(404, 'This form link is not valid');
    if (f.expires_at < new Date().toISOString()) throw new HttpError(410, 'This form link has expired. Please ask the office for a new one.');
    const items = await db.all(
      `SELECT fr.id, fr.kind, fr.status, fr.template_id, fr.context, t.name, t.kind AS template_kind, t.fields, t.version
       FROM form_requests fr LEFT JOIN form_templates t ON t.id = fr.template_id
       WHERE fr.patient_id = ? AND (fr.id = ? OR fr.packet_id = ?) ORDER BY fr.id`, f.patient_id, f.packet_id || f.id, f.packet_id || f.id,
    );
    if (items.every((x) => x.status === 'completed')) throw new HttpError(410, 'These forms have already been submitted. Thank you!');
    if (req && !formPassOk(req, f)) throw new HttpError(403, 'Enter your date of birth to open your forms', { dob_required: true, practice_name: f.practice_name, language: patientLang(f) });
    return { f, items };
  };

  r.post('/forms/:token/verify', limiter, async (req, res) => {
    const { f } = await packetForToken(req.params.token);
    if (f.dob && String(req.body?.dob || '').trim() !== f.dob) {
      await db.run('UPDATE form_requests SET dob_failures = dob_failures + 1 WHERE id = ?', f.id);
      const tries = Number((await db.get('SELECT dob_failures AS n FROM form_requests WHERE id = ?', f.id)).n);
      await logPublic(req, f.practice_id, 'forms.link_dob_failed', 'patients', f.patient_id, { tries });
      if (tries >= 5) {
        await db.run('UPDATE form_requests SET expires_at = ? WHERE id = ?', new Date().toISOString(), f.id);
        throw new HttpError(410, 'This link has been turned off after too many tries. Please ask the office for a new one.');
      }
      throw new HttpError(403, "That date of birth doesn't match our records", { dob_required: true });
    }
    res.json({ pass: formPass(f.id, secret) });
  });
  const contextFor = (f, item) => ({
    ...JSON.parse(item.context || '{}'), patient: `${f.first_name} ${f.last_name}`, first_name: f.first_name, practice: f.practice_name,
    date: new Date().toISOString().slice(0, 10),
  });

  r.get('/forms/:token', reader, async (req, res) => {
    const { f, items } = await packetForToken(req.params.token, req);
    const history = items.find((x) => x.kind === 'medical_history');
    // Prefill contact details only; clinical history is always re-entered by the patient.
    res.json({
      practice_name: f.practice_name, kind: history ? 'medical_history' : 'custom', first_name: f.first_name, last_name: f.last_name, language: patientLang(f),
      conditions: MEDICAL_CONDITIONS,
      prefill: { phone: f.phone, email: f.email, address: f.address, city: f.city, state: f.state, zip: f.zip, emergency_contact: f.emergency_contact },
      forms: items.map((x) => (x.kind === 'medical_history'
        ? { id: x.id, kind: 'medical_history', name: 'Health history', status: x.status }
        : { id: x.id, kind: 'custom', name: x.name, form_kind: x.template_kind, status: x.status, fields: fillFields(JSON.parse(x.fields || '[]'), contextFor(f, x)) })),
    });
  });

  r.post('/forms/:token', limiter, async (req, res) => {
    const { f, items } = await packetForToken(req.params.token, req);
    const item = items.find((x) => x.kind === 'medical_history' && x.status === 'pending');
    if (!item) throw new HttpError(410, 'Your health history has already been submitted. Thank you!');
    const { answers, signatureName, signatureImage } = parseMedicalHistory(req.body);
    const formId = await db.tx(async () => {
      const id = await insert(db, 'patient_forms', {
        practice_id: f.practice_id, patient_id: f.patient_id, request_id: item.id, kind: 'medical_history', data: JSON.stringify(answers),
        signature_name: signatureName, signature_image: signatureImage, ip: req.ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
        review_status: 'pending',
      });
      // Contact details apply now; medical changes wait for a clinician to review them against the chart,
      // so a rushed "none" on a tablet can't erase an allergy the office recorded.
      // How they heard about the office fills in the chart's referral source if it's still blank.
      const heard = answers.referral_source && !(await db.get('SELECT referral_source FROM patients WHERE id = ?', f.patient_id))?.referral_source ? { referral_source: answers.referral_source.slice(0, 100) } : {};
      await update(db, 'patients', f.patient_id, f.practice_id, { ...contactUpdatesFromHistory(answers), ...heard, updated_at: new Date().toISOString() });
      await db.run("UPDATE form_requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?", item.id);
      return id;
    });
    await logPublic(req, f.practice_id, 'form.submit', 'patient_forms', formId, { patient_id: f.patient_id });
    res.status(201).json({ ok: true });
  });

  // One practice form from the packet: answers are checked against its fields, and the signed form is
  // filed in the chart as a PDF (photos of insurance cards and IDs are filed as images).
  r.post('/forms/:token/:rid', limiter, async (req, res) => {
    const { f, items } = await packetForToken(req.params.token, req);
    const item = items.find((x) => x.id === Number(req.params.rid) && x.kind === 'custom');
    if (!item) throw new HttpError(404, 'Form not found');
    if (item.status === 'completed') throw new HttpError(410, 'This form has already been submitted. Thank you!');
    const fields = fillFields(JSON.parse(item.fields || '[]'), contextFor(f, item));
    const { answers, photos, signature, signatureName } = checkAnswers(fields, req.body);
    const signedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', f.practice_id);
    const pdf = formPdf({ practice, patient: f, template: { name: item.name, version: item.version }, fields, answers, photos, signatureName, signedAt, ip: req.ip });
    const saved = await storage.save(f.practice_id, pdf);
    const files = await Promise.all(photos.map(async (p) => ({ ...p, ...(await storage.save(f.practice_id, p.bytes)) })));
    const day = signedAt.slice(0, 10);
    const formId = await db.tx(async () => {
      const docId = await insert(db, 'documents', {
        practice_id: f.practice_id, patient_id: f.patient_id, category: item.template_kind === 'consent' ? 'consent' : 'document',
        filename: `${item.name} ${day}.pdf`.replace(/[^\w.\- ()]/g, '_'), mime: 'application/pdf', size: pdf.length,
        storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Signed by ${signatureName || `${f.first_name} ${f.last_name}`}`,
      });
      for (const p of files) {
        await insert(db, 'documents', {
          practice_id: f.practice_id, patient_id: f.patient_id, category: /insurance/i.test(p.label) ? 'insurance_card' : 'photo',
          filename: `${p.label} ${day}.${p.mime === 'image/png' ? 'png' : 'jpg'}`.replace(/[^\w.\- ()]/g, '_'), mime: p.mime, size: p.bytes.length,
          storage_key: p.storageKey, encrypted: p.encrypted ? 1 : 0, notes: `From ${item.name}`,
        });
      }
      const id = await insert(db, 'patient_forms', {
        practice_id: f.practice_id, patient_id: f.patient_id, request_id: item.id, kind: 'custom', template_id: item.template_id, template_version: item.version,
        fields: JSON.stringify(fields), data: JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([k]) => !fields.find((x) => x.key === k && x.type === 'signature')))),
        signature_name: signatureName || `${f.first_name} ${f.last_name}`, signature_image: signature, document_id: docId,
        ip: req.ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      });
      await db.run("UPDATE form_requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?", item.id);
      return id;
    });
    await logPublic(req, f.practice_id, 'form.submit', 'patient_forms', formId, { patient_id: f.patient_id, template_id: item.template_id });
    res.status(201).json({ ok: true });
  });

  return r;
}
