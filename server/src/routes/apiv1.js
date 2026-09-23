import express, { Router } from 'express';
import { setActor } from '../actor.js';
import { HttpError, rateLimit } from '../auth.js';
import { insert, hashToken, normalizeDateTime, audit, practiceNow, recorded } from '../util.js';
import { apiPatient, apiAppointment, apiPayment, emitEvent } from '../webhooks.js';
import { validateAppt, openSlots } from './schedule.js';
import { findDuplicates } from './patients.js';
import { publish } from '../events.js';

// Public REST API, version 1. Authenticate with an API key from Settings → API & webhooks:
//   Authorization: Bearer dm_live_…
// Lists page with ?limit (max 200) and ?starting_after=<id>; responses are { data, has_more }.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATIENT_FIELDS = ['first_name', 'last_name', 'preferred_name', 'dob', 'gender', 'phone', 'email', 'address', 'city', 'state', 'zip', 'sms_opt_in', 'email_opt_in', 'primary_provider_id'];

export default function apiV1Routes({ db }) {
  const r = Router();
  r.use(express.json({ limit: '256kb' }));
  const limiter = rateLimit({ windowMs: 60_000, max: 600, name: 'apiv1' });

  // API key → practice and scopes.
  r.use(limiter, async (req, _res, next) => {
    try {
      const h = String(req.headers.authorization || '');
      const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (!key.startsWith('dm_live_')) throw new HttpError(401, 'Send an API key: Authorization: Bearer dm_live_…');
      const k = await db.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hashToken(key));
      if (!k) throw new HttpError(401, 'API key not recognised or revoked');
      req.api = { key_id: k.id, name: k.name, practice_id: k.practice_id, scopes: JSON.parse(k.scopes) };
      // Every API change is audited as coming from this key.
      req.user = { id: null, practice_id: k.practice_id, role: 'api', name: `API: ${k.name}` };
      setActor({ source: 'api', actor: `API: ${k.name}`, practiceId: k.practice_id });
      if (!k.last_used_at || Date.parse(`${k.last_used_at.replace(' ', 'T')}Z`) < Date.now() - 60_000) await db.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", k.id);
      next();
    } catch (err) {
      next(err);
    }
  });
  const scope = (s) => (req, _res, next) => (req.api.scopes.includes(s) ? next() : next(new HttpError(403, `This key doesn't have the ${s} scope`)));
  const page = (req) => ({ limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)), after: Number(req.query.starting_after) || 0 });
  const list = (rows, limit, map) => ({ data: rows.slice(0, limit).map(map), has_more: rows.length > limit });
  const pid = (req) => req.api.practice_id;

  r.get('/me', async (req, res) => {
    const p = await db.get('SELECT id, name, timezone, phone FROM practices WHERE id = ?', pid(req));
    res.json({ practice: p, key: req.api.name, scopes: req.api.scopes });
  });

  // ---- Reference data ----
  r.get('/providers', scope('appointments:read'), async (req, res) => res.json({ data: await db.all('SELECT id, name, type, npi, color, active FROM providers WHERE practice_id = ? ORDER BY id', pid(req)) }));
  r.get('/operatories', scope('appointments:read'), async (req, res) => res.json({ data: await db.all('SELECT id, name, active FROM operatories WHERE practice_id = ? ORDER BY id', pid(req)) }));
  r.get('/appointment-types', scope('appointments:read'), async (req, res) => res.json({ data: await db.all('SELECT id, name, duration, provider_type, active FROM appointment_types WHERE practice_id = ? ORDER BY id', pid(req)) }));

  // ---- Patients ----
  r.get('/patients', scope('patients:read'), async (req, res) => {
    const { limit, after } = page(req);
    const where = ['practice_id = ?', 'id > ?'];
    const args = [pid(req), after];
    if (req.query.updated_since) { where.push('updated_at >= ?'); args.push(String(req.query.updated_since).replace('T', ' ').slice(0, 19)); }
    if (req.query.email) { where.push('lower(email) = lower(?)'); args.push(String(req.query.email)); }
    if (req.query.phone) {
      const d = String(req.query.phone).replace(/\D/g, '').slice(-10);
      where.push("replace(replace(replace(replace(replace(COALESCE(phone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '.', '') LIKE ?"); args.push(`%${d}`);
    }
    const rows = await db.all(`SELECT * FROM patients WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${limit + 1}`, ...args);
    res.json(list(rows, limit, apiPatient));
  });
  const patientOr404 = async (req, id) => {
    const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(id), pid(req));
    if (!p) throw new HttpError(404, 'Patient not found');
    return p;
  };
  r.get('/patients/:id', scope('patients:read'), async (req, res) => res.json(apiPatient(await patientOr404(req, req.params.id))));

  const cleanPatient = (b, creating) => {
    const row = {};
    for (const k of PATIENT_FIELDS) if (b[k] !== undefined) row[k] = b[k];
    if (creating && (!String(row.first_name || '').trim() || !String(row.last_name || '').trim())) throw new HttpError(400, 'first_name and last_name are required');
    for (const k of ['first_name', 'last_name']) if (row[k] !== undefined && !String(row[k]).trim()) throw new HttpError(400, `${k} can't be blank`);
    if (row.dob != null && !DATE.test(row.dob)) throw new HttpError(400, 'dob must be YYYY-MM-DD');
    if (row.email != null && row.email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'email is not valid');
    for (const k of ['sms_opt_in', 'email_opt_in']) if (row[k] !== undefined) row[k] = row[k] ? 1 : 0;
    for (const k of Object.keys(row)) if (typeof row[k] === 'string') row[k] = row[k].trim().slice(0, 200) || null;
    return row;
  };
  r.post('/patients', scope('patients:write'), async (req, res) => {
    const row = cleanPatient(req.body || {}, true);
    if (row.primary_provider_id && !(await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', row.primary_provider_id, pid(req)))) throw new HttpError(400, 'primary_provider_id not found');
    // Refuse an obvious second chart for the same person.
    const same = (await findDuplicates(db, pid(req), row)).find((d) => d.last_name.toLowerCase() === row.last_name.toLowerCase() && d.first_name.toLowerCase() === row.first_name.toLowerCase() && (!row.dob || d.dob === row.dob));
    if (same && !req.body?.allow_duplicate) throw new HttpError(409, 'A patient with this name already exists — use their id, or send allow_duplicate: true', { existing_id: same.id });
    const id = await insert(db, 'patients', { ...row, practice_id: pid(req) });
    const p = await db.get('SELECT * FROM patients WHERE id = ?', id);
    await audit(db, req, 'patient.create', 'patients', id, { via: 'api' });
    await emitEvent(db, pid(req), 'patient.created', apiPatient(p));
    res.status(201).json(apiPatient(p));
  });
  r.patch('/patients/:id', scope('patients:write'), async (req, res) => {
    const p = await patientOr404(req, req.params.id);
    const row = cleanPatient(req.body || {}, false);
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to update');
    if (row.primary_provider_id && !(await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', row.primary_provider_id, pid(req)))) throw new HttpError(400, 'primary_provider_id not found');
    await recorded(db, 'patients', p.id, () => db.run(`UPDATE patients SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(row), p.id));
    const after = await db.get('SELECT * FROM patients WHERE id = ?', p.id);
    await audit(db, req, 'patient.update', 'patients', p.id, { via: 'api', fields: Object.keys(row) });
    await emitEvent(db, pid(req), 'patient.updated', apiPatient(after));
    res.json(apiPatient(after));
  });

  // ---- Appointments ----
  r.get('/appointments', scope('appointments:read'), async (req, res) => {
    const { limit, after } = page(req);
    const where = ['practice_id = ?', 'id > ?'];
    const args = [pid(req), after];
    if (req.query.from) { if (!DATE.test(req.query.from)) throw new HttpError(400, 'from must be YYYY-MM-DD'); where.push('start_time >= ?'); args.push(`${req.query.from} 00:00`); }
    if (req.query.to) { if (!DATE.test(req.query.to)) throw new HttpError(400, 'to must be YYYY-MM-DD'); where.push('start_time <= ?'); args.push(`${req.query.to} 23:59`); }
    if (req.query.patient_id) { where.push('patient_id = ?'); args.push(Number(req.query.patient_id)); }
    if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
    const rows = await db.all(`SELECT * FROM appointments WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${limit + 1}`, ...args);
    res.json(list(rows, limit, apiAppointment));
  });
  const apptOr404 = async (req) => {
    const a = await db.get('SELECT * FROM appointments WHERE id = ? AND practice_id = ?', Number(req.params.id), pid(req));
    if (!a) throw new HttpError(404, 'Appointment not found');
    return a;
  };
  r.get('/appointments/:id', scope('appointments:read'), async (req, res) => res.json(apiAppointment(await apptOr404(req))));

  r.get('/availability', scope('appointments:read'), async (req, res) => {
    if (!DATE.test(req.query.date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const duration = Math.min(480, Math.max(10, Number(req.query.duration) || 60));
    const providers = req.query.provider_id
      ? await db.all('SELECT id, name FROM providers WHERE id = ? AND practice_id = ? AND active = 1', Number(req.query.provider_id), pid(req))
      : await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid(req));
    const out = [];
    const typeId = req.query.appointment_type_id ? Number(req.query.appointment_type_id) : null;
    for (const p of providers) for (const s of await openSlots(db, pid(req), p.id, req.query.date, { duration, step: 15, typeId })) out.push({ provider_id: p.id, start_time: s });
    res.json({ data: out.sort((a, b) => a.start_time.localeCompare(b.start_time)) });
  });

  const addMin = (t, m) => { const d = new Date(`${t.replace(' ', 'T')}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + m); return d.toISOString().slice(0, 16).replace('T', ' '); };
  r.post('/appointments', scope('appointments:write'), async (req, res) => {
    const b = req.body || {};
    await patientOr404(req, b.patient_id);
    if (!(await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ? AND active = 1', Number(b.provider_id), pid(req)))) throw new HttpError(400, 'provider_id not found');
    const type = b.appointment_type_id ? await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ?', Number(b.appointment_type_id), pid(req)) : null;
    if (b.appointment_type_id && !type) throw new HttpError(400, 'appointment_type_id not found');
    const start = normalizeDateTime(b.start_time, 'start_time');
    if (start <= (await practiceNow(db, pid(req)))) throw new HttpError(400, 'start_time must be in the future');
    const end = b.end_time ? normalizeDateTime(b.end_time, 'end_time') : addMin(start, Number(b.duration) || type?.duration || 60);
    const row = {
      patient_id: Number(b.patient_id), provider_id: Number(b.provider_id), operatory_id: b.operatory_id ? Number(b.operatory_id) : null,
      appointment_type_id: type?.id ?? null, start_time: start, end_time: end, status: 'scheduled',
      reason: b.reason ? String(b.reason).slice(0, 200) : type?.name ?? null, notes: b.notes ? String(b.notes).slice(0, 1000) : null,
    };
    await validateAppt(db, pid(req), row);
    const id = await insert(db, 'appointments', { ...row, practice_id: pid(req) });
    const a = await db.get('SELECT * FROM appointments WHERE id = ?', id);
    await audit(db, req, 'appointment.create', 'appointments', id, { via: 'api' });
    publish(pid(req), { type: 'schedule', dates: [start.slice(0, 10)], source: 'api' });
    await emitEvent(db, pid(req), 'appointment.created', apiAppointment(a));
    res.status(201).json(apiAppointment(a));
  });

  const setStatus = (status) => async (req, res) => {
    const a = await apptOr404(req);
    if (!['scheduled', 'confirmed'].includes(a.status)) throw new HttpError(409, `Appointment is ${a.status}`);
    if (status === 'confirmed') await recorded(db, 'appointments', a.id, () => db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, datetime('now')), confirmed_via = 'api' WHERE id = ?", a.id));
    else {
      await recorded(db, 'appointments', a.id, () => db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id));
      await db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", a.id);
    }
    const after = await db.get('SELECT * FROM appointments WHERE id = ?', a.id);
    await audit(db, req, `appointment.${status === 'confirmed' ? 'confirm' : 'cancel'}`, 'appointments', a.id, { via: 'api' });
    publish(pid(req), { type: 'schedule', dates: [a.start_time.slice(0, 10)], source: 'api' });
    await emitEvent(db, pid(req), status === 'confirmed' ? 'appointment.updated' : 'appointment.cancelled', apiAppointment(after));
    res.json(apiAppointment(after));
  };
  r.post('/appointments/:id/confirm', scope('appointments:write'), setStatus('confirmed'));
  r.post('/appointments/:id/cancel', scope('appointments:write'), setStatus('cancelled'));

  // ---- Payments ----
  r.get('/payments', scope('payments:read'), async (req, res) => {
    const { limit, after } = page(req);
    const where = ["practice_id = ?", "type = 'payment'", 'id > ?'];
    const args = [pid(req), after];
    if (req.query.since) { if (!DATE.test(req.query.since)) throw new HttpError(400, 'since must be YYYY-MM-DD'); where.push('entry_date >= ?'); args.push(req.query.since); }
    const rows = await db.all(`SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${limit + 1}`, ...args);
    res.json(list(rows, limit, apiPayment));
  });

  r.use((_req, _res, next) => next(new HttpError(404, 'No such API endpoint')));
  return r;
}
