import { Router } from 'express';
import { createHash, createHmac } from 'node:crypto';
import { requirePermission, can, HttpError } from '../auth.js';
import { audit, practiceNow } from '../util.js';
import { patientBalance, primaryPolicy } from '../services.js';
import { canSeePatient } from '../officeaccess.js';
import { apiAs } from '../assistantTools.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { medicalReviewDue } from './patients.js';

// Working through an internet outage (see docs/offline.md). While online, each signed-in screen fetches a
// read-only copy of what the office needs today — today's and tomorrow's schedule for this office, and for
// each of today's patients the summary card, recent notes, tooth chart and last perio exam — and keeps it
// on the device, encrypted with a key only this sign-in can get from here. Changes made while offline are
// queued on the device and sent later with their original Idempotency-Key, so nothing posts twice.
//
// Mount (inside the signed-in router, after officeAccess):  api.use(offlineRoutes({ db, secret, app: () => app }))

const MAX_PATIENTS = 200;
const RECENT_NOTES = 20;
// How long a kept copy may be shown (the client refuses to show an older one).
const MAX_AGE_HOURS = 14;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const sqliteTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const addDay = (ymd) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// Same scope string and hash as the signed-in router's idempotency middleware (app.js / idempotency.js):
// sha256(`u<user id>:<session row id>`), first 32 hex characters.
export const idempotencyScope = (userId, sessionId) => createHash('sha256').update(`u${userId}:${sessionId ?? ''}`).digest('hex').slice(0, 32);

export default function offlineRoutes({ db, secret, app }) {
  if (!secret) throw new Error('offlineRoutes needs the server secret');
  const r = Router();

  // The keys that lock the copies kept on this device. Neither is stored anywhere: both are derived from the
  // server secret. The snapshot key belongs to this sign-in (a new sign-in can't read an old copy, which is
  // wiped at sign-out anyway). The outbox key belongs to this person — so changes queued offline survive an
  // idle sign-out and are sent when they sign in again — and changes when their password changes or they
  // "sign out everywhere", which makes anything left on a lost computer unreadable.
  r.get('/offline/key', requirePermission('schedule:read'), async (req, res) => {
    if (!req.session_sid) throw new HttpError(401, 'Sign in again to keep an offline copy');
    const derive = (label) => b64(createHmac('sha256', `${secret}:offline`).update(label).digest());
    res.json({
      session_key: derive(`snapshot:${req.session_sid}`),
      outbox_key: derive(`outbox:${req.user.practice_id}:${req.user.id}:${req.user.token_version ?? 0}`),
      // Not secret: tells a device which sign-in's key sealed a copy, so an old copy is recognised and wiped.
      key_id: createHash('sha256').update(`kid:${req.session_sid}`).digest('hex').slice(0, 16),
      user_id: req.user.id, practice_id: req.user.practice_id, max_age_hours: MAX_AGE_HOURS,
    });
  });

  // One call for the whole read-only copy. Audited as one bulk read, plus (at most once per person per
  // patient per 12 hours, so the 5-minute refresh doesn't flood the log) a line on each patient's record.
  r.get('/offline/snapshot', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const now = await practiceNow(db, pid);
    const today = now.slice(0, 10);
    const tomorrow = addDay(today);
    const call = apiAs(app(), req);
    const locationId = req.location_id ?? null;
    // The schedule exactly as the Schedule page gets it (same office limits and shape), through the app's own API.
    const schedule = await call('GET', `/schedule?from=${today}&to=${tomorrow}${locationId ? `&location_id=${locationId}` : ''}`);
    const lookups = {};
    const omitted = [];
    for (const path of ['/operatories?active=true', '/providers?active=true', '/providers']) {
      try {
        lookups[path] = await call('GET', path);
      } catch (err) {
        omitted.push({ part: path, reason: err.message });
      }
    }

    const visits = schedule.appointments.filter((a) => !['cancelled', 'no_show'].includes(a.status));
    const todays = visits.filter((a) => a.start_time.slice(0, 10) === today);
    const ids = [...new Set(todays.map((a) => a.patient_id))].slice(0, MAX_PATIENTS);
    if (new Set(todays.map((a) => a.patient_id)).size > MAX_PATIENTS) omitted.push({ part: 'patients', reason: `Only the first ${MAX_PATIENTS} of today's patients are kept` });

    const patients = {};
    const clinical = can(req.user, 'clinical:read');
    if (!can(req.user, 'patients:read')) omitted.push({ part: 'patients', reason: 'Missing permission: patients:read' });
    else {
      if (!clinical) omitted.push({ part: 'clinical', reason: 'Missing permission: clinical:read' });
      for (const id of ids) {
        const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', id, pid);
        if (!p || !(await canSeePatient(db, req.user, id))) continue;
        patients[id] = {
          patient: await patientView(p, visits),
          card: await cardFor(req.user, p, today),
          ...(clinical ? { notes: await notesFor(pid, p.id), chart: await chartFor(pid, p.id), perio: await lastPerio(pid, p.id) } : {}),
        };
      }
    }

    const kept = Object.keys(patients).map(Number);
    await audit(db, req, 'offline.snapshot', 'patients', null, {
      date: today, through: tomorrow, location_id: locationId, visits: visits.length, patient_count: kept.length, patient_ids: kept,
      parts: clinical ? ['schedule', 'card', 'notes', 'chart', 'perio'] : ['schedule', 'card'],
    });
    if (kept.length) {
      const seen = new Set((await db.all(
        `SELECT DISTINCT patient_id FROM audit_log WHERE practice_id = ? AND user_id = ? AND action = 'offline.snapshot_patient' AND created_at >= ? AND patient_id IN (${kept.map(() => '?').join(',')})`,
        pid, req.user.id, sqliteTime(new Date(Date.now() - 12 * 3600_000)), ...kept,
      )).map((x) => x.patient_id));
      for (const id of kept) if (!seen.has(id)) await audit(db, req, 'offline.snapshot_patient', 'patients', id, { date: today }, { patientId: id });
    }

    res.json({
      version: 1, generated_at: new Date().toISOString(), practice_now: now, today, tomorrow, location_id: locationId, max_age_hours: MAX_AGE_HOURS,
      schedule, lookups, patients, day_sheet: daySheet(todays), omitted,
    });
  });

  // Before sending queued changes: which of these Idempotency-Keys already reached the server under one of
  // this person's recent sign-ins (a change sent just before the connection or the session dropped, whose
  // answer never arrived). A new sign-in has a new idempotency scope, so without this check it could be
  // posted twice.
  r.get('/offline/sent', requirePermission('schedule:read'), async (req, res) => {
    const keys = String(req.query.keys || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length > 200) throw new HttpError(400, 'At most 200 keys at a time');
    if (keys.some((k) => !/^[\w.:-]{8,120}$/.test(k))) throw new HttpError(400, 'keys must be Idempotency-Keys');
    if (!keys.length) return res.json({ sent: [] });
    // Kept answers last a day (idempotency.js), so sign-ins from the last day and a half cover them.
    const sessions = await db.all('SELECT id FROM staff_sessions WHERE user_id = ? AND practice_id = ? AND created_at >= ?', req.user.id, req.user.practice_id, sqliteTime(new Date(Date.now() - 36 * 3600_000)));
    const scopes = [...new Set([req.session_id, ...sessions.map((s) => s.id)].filter((x) => x != null))].map((sid) => idempotencyScope(req.user.id, sid));
    const rows = await db.all(
      `SELECT key, status, response_status FROM idempotency_keys WHERE scope IN (${scopes.map(() => '?').join(',')}) AND key IN (${keys.map(() => '?').join(',')})`,
      ...scopes, ...keys,
    );
    res.json({ sent: rows.map((x) => ({ key: x.key, status: x.status, response_status: x.response_status ?? null })) });
  });

  // After a sync (or when someone throws away a queued change): what happened, for the audit log, and a
  // Needs attention item when something couldn't be sent. No patient details travel here — only kinds,
  // keys, answers and error messages.
  const KINDS = ['note', 'status', 'ready', 'payment', 'task'];
  r.post('/offline/sync-report', requirePermission('schedule:read'), async (req, res) => {
    const b = req.body || {};
    const list = (v, name) => {
      if (v == null) return [];
      if (!Array.isArray(v) || v.length > 500) throw new HttpError(400, `${name} must be a list of at most 500`);
      return v.map((x) => {
        if (!x || !KINDS.includes(x.kind) || !/^[\w.:-]{8,120}$/.test(String(x.key || ''))) throw new HttpError(400, `Each ${name} item needs a kind (${KINDS.join(', ')}) and its Idempotency-Key`);
        const status = x.status == null ? null : Number(x.status);
        if (status != null && !(Number.isInteger(status) && status >= 0 && status < 600)) throw new HttpError(400, 'status must be an HTTP status');
        const queuedAt = x.queued_at == null ? null : String(x.queued_at).slice(0, 30);
        return { kind: x.kind, key: x.key, status, queued_at: queuedAt, ...(x.error ? { error: String(x.error).slice(0, 200) } : {}) };
      });
    };
    const sent = list(b.sent, 'sent');
    const failed = list(b.failed, 'failed');
    const discarded = list(b.discarded, 'discarded');
    if (!sent.length && !failed.length && !discarded.length) throw new HttpError(400, 'Nothing to report');
    await audit(db, req, 'offline.sync', 'users', req.user.id, { sent, failed, discarded });
    const key = `offline-sync:u${req.user.id}`;
    if (failed.length) {
      await raiseIssue(db, {
        practiceId: req.user.practice_id, kind: 'records', key, role: 'front_desk', severity: failed.some((f) => ['payment', 'note'].includes(f.kind)) ? 'high' : 'normal',
        title: `${failed.length} change${failed.length === 1 ? '' : 's'} made offline by ${req.user.name} couldn't be sent — open the offline changes on their computer to fix or discard`,
        detail: failed.map((f) => `${f.kind}: ${f.error || `HTTP ${f.status}`}`).join('; '),
      });
    } else if (sent.length) await resolveIssue(db, req.user.practice_id, key, 'Resolved automatically: the offline changes were sent');
    res.json({ ok: true });
  });

  // ---- The patient parts, shaped like the routes the screens call (patients.js, clinical.js) ----

  // GET /patients/:id, trimmed to what a copy can know: the chart header, balance, insurance, today's visits.
  const patientView = async (p, visits) => {
    const { photo: _photo, ...row } = p; // photos are large and not needed to work offline
    return {
      ...row, photo: null,
      balance: await patientBalance(db, p.practice_id, p.id),
      primary_insurance: (await primaryPolicy(db, p.practice_id, p.id)) || null,
      upcoming_appointments: visits.filter((a) => a.patient_id === p.id),
      past_appointments: [], recalls: [], history_review_pending: false, guarantor: null, family_size: 1, open_lab_cases: [],
      offline_partial: true,
    };
  };

  // GET /patients/:id/card, plus the medication list (the offline copy is what the chair side has to go on).
  const cardFor = async (user, p, today) => {
    const pid = p.practice_id;
    const clinical = can(user, 'clinical:read');
    const billing = can(user, 'billing:read');
    const policy = billing ? await primaryPolicy(db, pid, p.id) : null;
    const elig = policy ? await db.get('SELECT status, created_at FROM eligibility_checks WHERE patient_insurance_id = ? ORDER BY id DESC LIMIT 1', policy.id) : null;
    const visit = (op, dir) => db.get(
      `SELECT a.start_time, a.reason, a.status, pr.name AS provider_name FROM appointments a JOIN providers pr ON pr.id = a.provider_id
       WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time ${op} ? AND a.status ${op === '<' ? "= 'completed'" : "NOT IN ('cancelled','no_show','completed')"} ORDER BY a.start_time ${dir} LIMIT 1`,
      pid, p.id, op === '<' ? today : `${today} 24:00`,
    );
    return {
      id: p.id, first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name, dob: p.dob, phone: p.phone, email: p.email,
      photo: null, office_alert: p.office_alert, language: p.language,
      ...(clinical ? {
        medical_alerts: p.medical_alerts, allergies: p.allergies, medications: p.medications, premed_required: !!p.premed_required,
        medical_reviewed_at: p.medical_reviewed_at, medical_review_due: medicalReviewDue(p.medical_reviewed_at, today),
      } : {}),
      ...(billing ? {
        balance: await patientBalance(db, pid, p.id),
        insurance: policy ? { carrier: policy.carrier_name, eligibility: elig?.status ?? null, checked_at: elig?.created_at ?? null } : null,
      } : {}),
      last_visit: (await visit('<', 'DESC')) || null,
      next_visit: (await visit('>=', 'ASC')) || null,
      unscheduled: null, missed_2y: null,
    };
  };

  // GET /patients/:id/notes: the most recent notes, with their addenda and signature lines.
  const notesFor = async (pid, patientId) => {
    const notes = await db.all(
      `SELECT n.*, u.name AS author_name, pv.name AS provider_name, s.name AS signed_by_name,
         sp.name AS signer_provider_name, sp.license_number AS signer_license, sp.npi AS signer_npi,
         a.start_time AS visit_start, COALESCE(t.name, a.reason) AS visit_reason
       FROM clinical_notes n
       JOIN users u ON u.id = n.author_id LEFT JOIN providers pv ON pv.id = n.provider_id LEFT JOIN users s ON s.id = n.signed_by
       LEFT JOIN providers sp ON sp.id = COALESCE((SELECT MIN(x.id) FROM providers x WHERE x.user_id = n.signed_by AND x.practice_id = n.practice_id), CASE WHEN n.signed_by IS NULL THEN n.provider_id END)
       LEFT JOIN appointments a ON a.id = n.appointment_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
       WHERE n.patient_id = ? AND n.practice_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      patientId, pid,
    );
    for (const n of notes) {
      n.signature = n.signed ? `Electronically signed by ${n.signer_provider_name || n.signed_by_name || 'staff'}${n.signer_license ? ` · License ${n.signer_license}` : ''}${n.signer_npi ? ` · NPI ${n.signer_npi}` : ''}` : null;
    }
    const top = notes.filter((n) => !n.addendum_of).slice(0, RECENT_NOTES);
    for (const n of top) n.addenda = notes.filter((a) => a.addendum_of === n.id).reverse();
    return top;
  };

  // GET /patients/:id/chart
  const chartFor = async (pid, patientId) => ({
    conditions: await db.all('SELECT * FROM tooth_conditions WHERE patient_id = ? AND practice_id = ? AND voided_at IS NULL ORDER BY recorded_at DESC', patientId, pid),
    procedures: await db.all(
      `SELECT pr.*, pv.name AS provider_name, tp.name AS plan_name, tp.option_label AS plan_option FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id
       LEFT JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id
       WHERE pr.patient_id = ? AND pr.practice_id = ? AND pr.status != 'cancelled' ORDER BY COALESCE(pr.completed_at, pr.created_at) DESC`,
      patientId, pid,
    ),
  });

  // GET /patients/:id/perio, the last exam only.
  const lastPerio = async (pid, patientId) => {
    const e = await db.get('SELECT * FROM perio_exams WHERE patient_id = ? AND practice_id = ? AND deleted_at IS NULL ORDER BY exam_date DESC, id DESC LIMIT 1', patientId, pid);
    return e ? [{ ...e, readings: JSON.parse(e.readings) }] : [];
  };

  return r;
}

// Today's list, printable: the same short form the old offline day sheet kept.
function daySheet(todays) {
  return todays.map((a) => ({
    appointment_id: a.id, patient_id: a.patient_id, start: a.start_time.slice(11, 16), end: a.end_time.slice(11, 16),
    name: `${a.preferred_name || a.first_name} ${a.last_name}`, phone: a.phone || '', reason: a.type_name || a.reason || '',
    provider: a.provider_name || '', chair: a.operatory_name || '', status: a.status, alert: !!(a.medical_alerts || a.premed_required),
  }));
}
