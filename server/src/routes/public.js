import { Router } from 'express';
import { HttpError, rateLimit } from '../auth.js';
import { insert, update, hashToken, practiceNow, normalizeDateTime, audit } from '../util.js';
import { MEDICAL_CONDITIONS, parseMedicalHistory, patientUpdatesFromHistory } from '../forms.js';
import { openSlots } from './schedule.js';

const REASONS = [
  { label: 'New patient exam & cleaning', duration: 60 },
  { label: 'Checkup & cleaning', duration: 60 },
  { label: 'Tooth pain / emergency', duration: 30 },
  { label: 'Consultation', duration: 30 },
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Unauthenticated endpoints reached from links sent to patients and the public booking page.
// They expose only the minimum needed and are rate limited.
export default function publicRoutes({ db }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
  const reader = rateLimit({ windowMs: 60 * 1000, max: 120 });
  const logPublic = (req, practiceId, action, entity, entityId, details) =>
    audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, action, entity, entityId, details);

  const bookablePractice = (slug) => {
    const p = db.get('SELECT * FROM practices WHERE slug = ? AND online_booking = 1', String(slug));
    if (!p) throw new HttpError(404, 'Online booking is not available for this practice');
    return p;
  };
  const publicProviders = (practiceId) => db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY type, name', practiceId);

  // ---- Online booking ----
  r.get('/practices/:slug', reader, (req, res) => {
    const p = bookablePractice(req.params.slug);
    res.json({
      name: p.name, phone: p.phone, address: p.address, city: p.city, state: p.state, zip: p.zip,
      today: practiceNow(db, p.id).slice(0, 10), providers: publicProviders(p.id), reasons: REASONS,
    });
  });

  r.get('/practices/:slug/availability', reader, (req, res) => {
    const p = bookablePractice(req.params.slug);
    const { date } = req.query;
    if (!DATE.test(date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const duration = REASONS.find((x) => x.label === req.query.reason)?.duration || 60;
    const now = practiceNow(db, p.id);
    if ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return res.json({ date, duration, slots: [] });
    const providers = publicProviders(p.id).filter((pv) => !req.query.provider_id || pv.id === Number(req.query.provider_id));
    const slots = [];
    for (const pv of providers) {
      for (const s of openSlots(db, p.id, pv.id, date, { duration, step: 30, after: now })) slots.push({ start: s, provider_id: pv.id, provider_name: pv.name });
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ date, duration, slots });
  });

  r.post('/practices/:slug/booking-requests', limiter, (req, res) => {
    const p = bookablePractice(req.params.slug);
    const b = req.body || {};
    if (b.website) return res.status(201).json({ ok: true }); // honeypot: silently drop bots
    const first = String(b.first_name || '').trim();
    const last = String(b.last_name || '').trim();
    if (!first || !last) throw new HttpError(400, 'First and last name are required');
    if (!b.phone && !b.email) throw new HttpError(400, 'A phone number or email is required so we can confirm');
    if (b.dob && !DATE.test(b.dob)) throw new HttpError(400, 'Date of birth must be YYYY-MM-DD');
    const reason = REASONS.find((x) => x.label === b.reason) || REASONS[1];
    const start = normalizeDateTime(b.start, 'start');
    if (start <= practiceNow(db, p.id)) throw new HttpError(400, 'Please choose a future time');
    const providerId = Number(b.provider_id);
    if (!publicProviders(p.id).some((pv) => pv.id === providerId)) throw new HttpError(400, 'Choose a provider');
    const free = openSlots(db, p.id, providerId, start.slice(0, 10), { duration: reason.duration, step: 30 });
    if (!free.includes(start)) throw new HttpError(409, 'That time was just taken. Please pick another.');
    const id = insert(db, 'booking_requests', {
      practice_id: p.id, first_name: first.slice(0, 80), last_name: last.slice(0, 80), dob: b.dob || null,
      phone: b.phone ? String(b.phone).slice(0, 30) : null, email: b.email ? String(b.email).slice(0, 200) : null,
      reason: reason.label, duration: reason.duration, provider_id: providerId, requested_start: start,
      new_patient: b.new_patient === false ? 0 : 1, notes: b.notes ? String(b.notes).slice(0, 1000) : null, ip: req.ip,
    });
    logPublic(req, p.id, 'booking.request', 'booking_requests', id);
    res.status(201).json({ ok: true, id });
  });

  // ---- Appointment confirmation links ----
  const apptForToken = (token) => {
    const a = db.get(
      `SELECT a.*, p.first_name, pr.name AS practice_name, pr.phone AS practice_phone, pr.address, pr.city, pr.state, pr.zip,
         pv.name AS provider_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN practices pr ON pr.id = a.practice_id
       JOIN providers pv ON pv.id = a.provider_id WHERE a.confirm_token_hash = ?`, hashToken(token),
    );
    if (!a) throw new HttpError(404, 'This link is no longer valid');
    return a;
  };
  const apptView = (a) => ({
    first_name: a.first_name, start_time: a.start_time, end_time: a.end_time, status: a.status, provider_name: a.provider_name,
    practice: { name: a.practice_name, phone: a.practice_phone, address: a.address, city: a.city, state: a.state, zip: a.zip },
  });

  r.get('/confirm/:token', reader, (req, res) => res.json(apptView(apptForToken(req.params.token))));

  r.post('/confirm/:token', limiter, (req, res) => {
    const a = apptForToken(req.params.token);
    const action = req.body?.action;
    if (a.start_time <= practiceNow(db, a.practice_id)) throw new HttpError(409, 'This appointment has already passed');
    if (action === 'confirm') {
      if (!['scheduled', 'confirmed'].includes(a.status)) throw new HttpError(409, `This appointment is ${a.status.replace('_', ' ')}`);
      db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, datetime('now')) WHERE id = ?", a.id);
    } else if (action === 'cancel') {
      if (!['scheduled', 'confirmed'].includes(a.status)) throw new HttpError(409, `This appointment is ${a.status.replace('_', ' ')}`);
      db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id);
      db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", a.id);
    } else {
      throw new HttpError(400, 'action must be confirm or cancel');
    }
    logPublic(req, a.practice_id, `appointment.patient_${action}`, 'appointments', a.id);
    res.json(apptView(apptForToken(req.params.token)));
  });

  // ---- Intake forms ----
  const formForToken = (token) => {
    const f = db.get(
      `SELECT fr.*, p.first_name, p.last_name, p.dob, p.phone, p.email, p.address, p.city, p.state, p.zip, p.emergency_contact,
         p.allergies, p.medications, pr.name AS practice_name
       FROM form_requests fr JOIN patients p ON p.id = fr.patient_id JOIN practices pr ON pr.id = fr.practice_id
       WHERE fr.token_hash = ?`, hashToken(token),
    );
    if (!f) throw new HttpError(404, 'This form link is not valid');
    if (f.status === 'completed') throw new HttpError(410, 'This form has already been submitted. Thank you!');
    if (f.expires_at < new Date().toISOString()) throw new HttpError(410, 'This form link has expired. Please ask the office for a new one.');
    return f;
  };

  r.get('/forms/:token', reader, (req, res) => {
    const f = formForToken(req.params.token);
    // Prefill contact details only; clinical history is always re-entered by the patient.
    res.json({
      practice_name: f.practice_name, kind: f.kind, first_name: f.first_name, last_name: f.last_name,
      conditions: MEDICAL_CONDITIONS,
      prefill: { phone: f.phone, email: f.email, address: f.address, city: f.city, state: f.state, zip: f.zip, emergency_contact: f.emergency_contact },
    });
  });

  r.post('/forms/:token', limiter, (req, res) => {
    const f = formForToken(req.params.token);
    const { answers, signatureName, signatureImage } = parseMedicalHistory(req.body);
    const formId = db.tx(() => {
      const id = insert(db, 'patient_forms', {
        practice_id: f.practice_id, patient_id: f.patient_id, request_id: f.id, kind: f.kind, data: JSON.stringify(answers),
        signature_name: signatureName, signature_image: signatureImage, ip: req.ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      });
      update(db, 'patients', f.patient_id, f.practice_id, { ...patientUpdatesFromHistory(answers), updated_at: new Date().toISOString() });
      db.run("UPDATE form_requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?", f.id);
      return id;
    });
    logPublic(req, f.practice_id, 'form.submit', 'patient_forms', formId, { patient_id: f.patient_id });
    res.status(201).json({ ok: true });
  });

  return r;
}
