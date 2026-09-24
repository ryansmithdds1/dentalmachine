import { Router } from 'express';
import { requirePermission, HttpError, rateLimit } from '../auth.js';
import { findOr404, audit } from '../util.js';
import { checkInToday } from '../checkin.js';
import { sendMessage, recipientFor } from '../messaging.js';
import { patientLang } from '../templates.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
const practiceByKey = (db, key) => (/^p\d+$/.test(key) ? db.get('SELECT * FROM practices WHERE id = ?', Number(key.slice(1))) : db.get('SELECT * FROM practices WHERE slug = ?', key));

// The QR code at the front door: phone number and date of birth, and today's visit is checked in.
export function checkinPublicRoutes({ db }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'qr-checkin' });
  const reader = rateLimit({ windowMs: 60_000, max: 60, name: 'qr-checkin-page' });
  r.get('/checkin/:practice', reader, async (req, res) => {
    const p = await practiceByKey(db, String(req.params.practice));
    if (!p) throw new HttpError(404, 'Not found');
    res.json({ name: p.name, phone: p.phone });
  });
  r.post('/checkin/:practice', limiter, async (req, res) => {
    const p = await practiceByKey(db, String(req.params.practice));
    if (!p) throw new HttpError(404, 'Not found');
    const phone = digits(req.body?.phone).slice(-10);
    const dob = String(req.body?.dob || '');
    if (phone.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, 'Enter your mobile number and date of birth');
    // The person with this birth date whose number (or whose parent's number) matches.
    const matches = (await db.all("SELECT id, phone, guarantor_id FROM patients WHERE practice_id = ? AND dob = ? AND status != 'archived'", p.id, dob));
    const ids = [];
    for (const m of matches) {
      const g = m.guarantor_id ? await db.get('SELECT phone FROM patients WHERE id = ?', m.guarantor_id) : null;
      if (digits(m.phone).slice(-10) === phone || digits(g?.phone).slice(-10) === phone) ids.push(m.id);
    }
    const done = ids.length ? await checkInToday(db, p.id, ids, { via: 'qr' }) : [];
    if (!done.length) throw new HttpError(404, `We couldn't find a visit for today with those details. Please check in at the front desk${p.phone ? ` or call ${p.phone}` : ''}.`);
    await audit(db, { ip: req.ip, user: { practice_id: p.id, id: null } }, 'checkin.qr', 'appointments', done[0].id, null, { source: 'patient', actor: 'Patient (QR check-in)', patientId: done[0].patient_id });
    res.json({ checked_in: done.map((v) => ({ name: v.first_name, time: v.start_time.slice(11, 16) })) });
  });
  return r;
}

// Staff: "we're ready for you" for someone waiting in the car.
export default function checkinRoutes({ db, messenger }) {
  const r = Router();
  r.post('/appointments/:aid/ready-text', requirePermission('schedule:write'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.aid, req.user.practice_id, 'Appointment');
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
    const to = await recipientFor(db, patient);
    if (!to.phone) throw new HttpError(400, 'No mobile number on file');
    const es = patientLang(patient) === 'es';
    const body = String(req.body?.message || '').trim().slice(0, 300)
      || (es ? `¡Estamos listos para ${patient.preferred_name || patient.first_name}! Por favor pase a la oficina.` : `We're ready for ${patient.preferred_name || patient.first_name}! Please come on in.`);
    const msg = await sendMessage(db, messenger, { practiceId: req.user.practice_id, patientId: patient.id, appointmentId: a.id, channel: 'sms', to: to.phone, body, kind: 'ready', userId: req.user.id });
    if (msg.status === 'sent') await db.run("UPDATE appointments SET ready_texted_at = datetime('now') WHERE id = ?", a.id);
    await audit(db, req, 'appointment.ready_text', 'appointments', a.id);
    res.json({ status: msg.status, error: msg.error || null });
  });
  return r;
}
