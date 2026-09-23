import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, practiceNow } from '../util.js';
import { schemaInfo } from '../db.js';
import { emitPatient } from '../webhooks.js';
import { patientBalance, primaryPolicy } from '../services.js';
import { isOptedOutAddress, clearOptOut } from '../messaging.js';
import { patientScope, checkOffice } from '../officeaccess.js';

const FIELDS = [
  'first_name', 'last_name', 'preferred_name', 'dob', 'gender', 'email', 'phone', 'address', 'city', 'state', 'zip',
  'emergency_contact', 'medical_alerts', 'allergies', 'medications', 'notes', 'primary_provider_id', 'status', 'sms_opt_in', 'email_opt_in', 'guarantor_id', 'referral_source', 'office_alert',
  'asa_class', 'premed_required', 'medical_conditions',
  'phone_home', 'phone_work', 'preferred_contact', 'language', 'primary_hygienist_id', 'photo', 'custom', 'fee_schedule_id', 'location_id',
];

export const MEDICAL_CONDITIONS = [
  'Heart disease', 'Heart murmur', 'Artificial heart valve', 'Prosthetic joint', 'High blood pressure', 'Stroke', 'Diabetes', 'Asthma', 'COPD',
  'Bleeding disorder', 'Anticoagulant therapy', 'Hepatitis', 'HIV', 'Kidney disease', 'Liver disease', 'Seizures', 'Cancer / chemotherapy',
  'Radiation to head or neck', 'Bisphosphonates', 'Osteoporosis', 'Pregnant', 'Thyroid disorder', 'Tobacco use', 'Sleep apnea',
];

// A patient's own fees (e.g. cash / uninsured) come from an office fee schedule.
async function checkFeeSchedule(db, row, req) {
  if (!('fee_schedule_id' in row)) return;
  if (!row.fee_schedule_id) { row.fee_schedule_id = null; return; }
  const fs = await db.get("SELECT id FROM fee_schedules WHERE id = ? AND practice_id = ? AND kind = 'office'", row.fee_schedule_id, req.user.practice_id);
  if (!fs) throw new HttpError(400, 'Choose an office fee schedule');
}

function validate(row) {
  requireOneOf(row.status, ['active', 'inactive', 'archived'], 'status');
  if (row.dob && !/^\d{4}-\d{2}-\d{2}$/.test(row.dob)) throw new HttpError(400, 'dob must be YYYY-MM-DD');
  if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'Invalid email');
  requireOneOf(row.asa_class || undefined, ['I', 'II', 'III', 'IV', 'V', 'VI'], 'asa_class');
  requireOneOf(row.preferred_contact || undefined, ['text', 'call', 'email'], 'preferred_contact');
  if (row.preferred_contact === '') row.preferred_contact = null;
  if (row.language != null) row.language = String(row.language).trim().slice(0, 40) || null;
  // A small profile photo, as a data URL (resized in the browser).
  if (row.photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(row.photo)) throw new HttpError(400, 'photo must be a JPEG, PNG or WebP image');
    if (row.photo.length > 400_000) throw new HttpError(400, 'That photo is too large');
  } else if ('photo' in row) row.photo = null;
  if (row.asa_class === '') row.asa_class = null;
  if (row.premed_required != null) row.premed_required = row.premed_required ? 1 : 0;
  if (row.medical_conditions != null) {
    const list = Array.isArray(row.medical_conditions) ? row.medical_conditions : (() => { try { return JSON.parse(row.medical_conditions); } catch { return null; } })();
    if (!Array.isArray(list)) throw new HttpError(400, 'medical_conditions must be a list');
    row.medical_conditions = JSON.stringify([...new Set(list.map((c) => String(c).trim().slice(0, 80)).filter(Boolean))].slice(0, 60));
  }
}

// Custom patient fields: the practice defines them (text, number, date, yes/no or a pick list);
// values are kept per patient as JSON and checked against the definitions.
export const CUSTOM_TYPES = ['text', 'number', 'date', 'checkbox', 'select'];
export async function customFieldDefs(db, practiceId) {
  const p = await db.get('SELECT custom_fields FROM practices WHERE id = ?', practiceId);
  try {
    return JSON.parse(p?.custom_fields || '[]');
  } catch {
    return [];
  }
}
async function validateCustom(db, practiceId, row, current) {
  if (row.custom == null) return;
  const defs = await customFieldDefs(db, practiceId);
  const incoming = typeof row.custom === 'string' ? JSON.parse(row.custom) : row.custom;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new HttpError(400, 'custom must be an object');
  const out = { ...(current ? JSON.parse(current) : {}) };
  for (const [key, raw] of Object.entries(incoming)) {
    const def = defs.find((d) => d.key === key);
    if (!def) {
      // A field the practice has since removed: its old value can ride along unchanged.
      if (key in out && JSON.stringify(out[key]) === JSON.stringify(raw)) continue;
      throw new HttpError(400, `Unknown custom field ${key}`);
    }
    if (raw == null || raw === '') { delete out[key]; continue; }
    let v = raw;
    if (def.type === 'number') {
      v = Number(raw);
      if (!Number.isFinite(v)) throw new HttpError(400, `${def.label} must be a number`);
    } else if (def.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new HttpError(400, `${def.label} must be a date`);
    } else if (def.type === 'checkbox') v = !!raw;
    else if (def.type === 'select') {
      if (!(def.options || []).includes(raw)) throw new HttpError(400, `${def.label} must be one of: ${(def.options || []).join(', ')}`);
    } else v = String(raw).slice(0, 500);
    out[key] = v;
  }
  row.custom = JSON.stringify(out);
}

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

// Charts that look like the same person: same name and birthday, or the same phone or email.
export async function findDuplicates(db, practiceId, p, excludeId = 0) {
  const rows = await db.all(
    `SELECT id, first_name, last_name, dob, phone, email, status FROM patients
     WHERE practice_id = ? AND id != ? AND status != 'archived'
       AND ((lower(last_name) = lower(?) AND (lower(first_name) = lower(?) OR (CAST(? AS TEXT) IS NOT NULL AND dob = ?)))
         OR (CAST(? AS TEXT) IS NOT NULL AND lower(email) = lower(?)) OR (CAST(? AS TEXT) IS NOT NULL AND phone LIKE ?))
     LIMIT 200`,
    practiceId, excludeId, p.last_name || '', p.first_name || '', p.dob || null, p.dob || null, p.email || null, p.email || null,
    digits(p.phone).length === 10 ? 'x' : null, `%${digits(p.phone).slice(-4)}`,
  );
  const phone = digits(p.phone);
  return rows.filter((r) => {
    const sameName = r.last_name?.toLowerCase() === String(p.last_name || '').toLowerCase()
      && (r.first_name?.toLowerCase() === String(p.first_name || '').toLowerCase() || (p.dob && r.dob === p.dob));
    const samePhone = phone.length === 10 && digits(r.phone) === phone
      // Families share a phone: a shared number only counts with the same first name or birthday.
      && (r.first_name?.toLowerCase() === String(p.first_name || '').toLowerCase() || (p.dob && r.dob === p.dob));
    const sameEmail = p.email && r.email?.toLowerCase() === String(p.email).toLowerCase() && r.first_name?.toLowerCase() === String(p.first_name || '').toLowerCase();
    return sameName || samePhone || sameEmail;
  }).slice(0, 5);
}

export default function patientRoutes({ db }) {
  const r = Router();
  // The home office: one of the practice's, and (for someone limited to some offices) one of theirs.
  const checkHomeOffice = async (req, row) => {
    if (row.location_id == null || row.location_id === '') {
      if ('location_id' in row) row.location_id = null;
      return;
    }
    row.location_id = Number(row.location_id);
    await findOr404(db, 'locations', row.location_id, req.user.practice_id, 'Office');
    checkOffice(req.user, row.location_id);
  };

  r.get('/custom-fields', requirePermission('patients:read'), async (req, res) => res.json(await customFieldDefs(db, req.user.practice_id)));
  r.put('/custom-fields', requirePermission('patients:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change custom fields');
    const list = req.body?.fields;
    if (!Array.isArray(list) || list.length > 40) throw new HttpError(400, 'fields must be a list of up to 40');
    const seen = new Set();
    const clean = list.map((f) => {
      const label = String(f?.label || '').trim().slice(0, 60);
      if (!label) throw new HttpError(400, 'Each field needs a label');
      const type = CUSTOM_TYPES.includes(f.type) ? f.type : 'text';
      // Keys stay the same when a label is renamed, so values aren't lost.
      const key = f.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `field_${seen.size + 1}`;
      if (seen.has(key)) throw new HttpError(400, `Two fields are named ${label}`);
      seen.add(key);
      const options = type === 'select' ? [...new Set((Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean))] : undefined;
      if (type === 'select' && !options.length) throw new HttpError(400, `${label}: add the choices`);
      return { key, label, type, ...(options ? { options } : {}) };
    });
    await db.run('UPDATE practices SET custom_fields = ? WHERE id = ?', JSON.stringify(clean), req.user.practice_id);
    await audit(db, req, 'custom_fields.update', 'practices', req.user.practice_id);
    res.json(clean);
  });

  r.get('/patients/duplicates', requirePermission('patients:read'), async (req, res) => {
    res.json(await findDuplicates(db, req.user.practice_id, req.query, Number(req.query.exclude) || 0));
  });

  // Likely duplicate charts across the practice (same name and birthday), e.g. after an import.
  r.get('/patients/duplicate-groups', requirePermission('patients:read'), async (req, res) => {
    const rows = await db.all(
      `SELECT id, first_name, last_name, dob, phone, email, created_at FROM patients
       WHERE practice_id = ? AND status != 'archived' AND dob IS NOT NULL ORDER BY lower(last_name), lower(first_name), dob, id`,
      req.user.practice_id,
    );
    const groups = new Map();
    for (const r0 of rows) {
      const key = `${r0.last_name.toLowerCase()}|${r0.first_name.toLowerCase()}|${r0.dob}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r0);
    }
    res.json([...groups.values()].filter((g) => g.length > 1).slice(0, 200));
  });

  // Merge a duplicate chart into this one: everything that belonged to the duplicate (visits, charting,
  // ledger, claims, documents, messages…) moves here, blank details are filled in, and the duplicate is removed.
  r.post('/patients/:id/merge', requirePermission('patients:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can merge patients');
    const keep = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const from = await findOr404(db, 'patients', req.body?.from_id, req.user.practice_id, 'Patient');
    if (keep.id === from.id) throw new HttpError(400, 'Choose a different chart to merge');
    const moved = {};
    await db.tx(async () => {
      // Recalls are one per type: keep the sooner due date.
      for (const rc of await db.all('SELECT * FROM recalls WHERE patient_id = ?', from.id)) {
        const mine = await db.get('SELECT * FROM recalls WHERE patient_id = ? AND type = ?', keep.id, rc.type);
        if (mine) {
          if (rc.due_date < mine.due_date) await db.run('UPDATE recalls SET due_date = ? WHERE id = ?', rc.due_date, mine.id);
          await db.run('DELETE FROM recall_contacts WHERE recall_id = ?', rc.id);
          await db.run('DELETE FROM recalls WHERE id = ?', rc.id);
        }
      }
      for (const [table, cols] of schemaInfo()) {
        for (const c of cols) {
          if (c.ref !== 'patients') continue;
          const r0 = await db.run(`UPDATE ${table} SET ${c.name} = ? WHERE ${c.name} = ?`, keep.id, from.id);
          if (r0.changes) moved[`${table}.${c.name}`] = r0.changes;
        }
      }
      // The duplicate may have been this patient's guarantor.
      await db.run('UPDATE patients SET guarantor_id = NULL WHERE id = ? AND guarantor_id = ?', keep.id, keep.id);
      const fill = {};
      for (const k of FIELDS) if ((keep[k] == null || keep[k] === '') && from[k] != null && from[k] !== '' && k !== 'status') fill[k] = from[k];
      if (Object.keys(fill).length) await update(db, 'patients', keep.id, req.user.practice_id, fill);
      await db.run('DELETE FROM conversation_state WHERE practice_id = ? AND thread = ? AND EXISTS (SELECT 1 FROM conversation_state x WHERE x.practice_id = ? AND x.thread = ?)', req.user.practice_id, `p${from.id}`, req.user.practice_id, `p${keep.id}`);
      await db.run('UPDATE conversation_state SET thread = ? WHERE practice_id = ? AND thread = ?', `p${keep.id}`, req.user.practice_id, `p${from.id}`);
      // Old-system IDs from a data import follow the chart, so a re-import updates the kept one.
      await db.run("UPDATE external_ids SET local_id = ? WHERE practice_id = ? AND kind = 'patients' AND local_id = ?", keep.id, req.user.practice_id, from.id);
      await db.run('DELETE FROM patients WHERE id = ?', from.id);
    });
    await audit(db, req, 'patient.merge', 'patients', keep.id, { merged: from.id, name: `${from.first_name} ${from.last_name}`, moved });
    res.json({ ok: true, moved });
  });

  r.get('/patients', requirePermission('patients:read'), async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = req.query.status || 'active';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = ['p.practice_id = ?'];
    const params = [req.user.practice_id];
    if (status !== 'all') {
      where.push('p.status = ?');
      params.push(status);
    }
    if (q) {
      // Phone numbers match on their digits, however either side is formatted: 5125550100 finds (512) 555-0100.
      const digits = /^[\d\s().+-]+$/.test(q) ? q.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : '';
      const phoneDigits = "replace(replace(replace(replace(replace(COALESCE(p.phone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '.', '')";
      where.push(`(p.first_name LIKE ? OR p.last_name LIKE ? OR (p.first_name || ' ' || p.last_name) LIKE ? OR p.phone LIKE ? OR p.email LIKE ? OR p.dob = ? OR CAST(p.id AS TEXT) = ?${digits.length >= 4 ? ` OR ${phoneDigits} LIKE ?` : ''})`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, q, q, ...(digits.length >= 4 ? [`%${digits}%`] : []));
    }
    const scope = patientScope(req.user);
    const whereSql = where.join(' AND ') + scope.sql;
    params.push(...scope.args);
    const total = (await db.get(`SELECT COUNT(*) AS n FROM patients p WHERE ${whereSql}`, ...params)).n;
    const rows = await db.all(
      `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.email, p.status, p.medical_alerts,
        (SELECT COALESCE(SUM(amount),0) FROM ledger_entries l WHERE l.patient_id = p.id) AS balance,
        (SELECT MIN(start_time) FROM appointments a WHERE a.patient_id = p.id AND a.start_time >= ? AND a.status NOT IN ('cancelled','no_show')) AS next_appointment
       FROM patients p WHERE ${whereSql} ORDER BY p.last_name, p.first_name LIMIT ? OFFSET ?`,
      await practiceNow(db, req.user.practice_id), ...params, limit, offset,
    );
    res.json({ total, rows });
  });

  r.post('/patients', requirePermission('patients:write'), async (req, res) => {
    const row = pick(req.body, FIELDS);
    requireFields(row, ['first_name', 'last_name']);
    validate(row);
    await validateCustom(db, req.user.practice_id, row);
    if (row.primary_provider_id) await findOr404(db, 'providers', row.primary_provider_id, req.user.practice_id, 'Provider');
    if (row.primary_hygienist_id) await findOr404(db, 'providers', row.primary_hygienist_id, req.user.practice_id, 'Hygienist');
    else if ('primary_hygienist_id' in row) row.primary_hygienist_id = null;
    await checkFeeSchedule(db, row, req);
    if (row.guarantor_id && (await findOr404(db, 'patients', row.guarantor_id, req.user.practice_id, 'Guarantor')).guarantor_id) throw new HttpError(400, 'Choose the head of household as guarantor');
    // A number that already replied STOP starts with texting off.
    if (row.phone && await isOptedOutAddress(db, req.user.practice_id, 'sms', row.phone)) row.sms_opt_in = 0;
    // New charts belong to the office they're made in.
    if (row.location_id === undefined && req.location_id) row.location_id = req.location_id;
    await checkHomeOffice(req, row);
    const id = await insert(db, 'patients', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'patient.create', 'patients', id);
    await emitPatient(db, id, 'patient.created');
    res.status(201).json(await db.get('SELECT * FROM patients WHERE id = ?', id));
  });

  r.get('/patients/:id', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const pid = req.user.practice_id;
    await audit(db, req, 'patient.view', 'patients', patient.id);
    res.json({
      ...patient,
      balance: await patientBalance(db, pid, patient.id),
      primary_insurance: (await primaryPolicy(db, pid, patient.id)) || null,
      upcoming_appointments: await db.all(
        `SELECT a.*, pr.name AS provider_name, o.name AS operatory_name FROM appointments a
         JOIN providers pr ON pr.id = a.provider_id LEFT JOIN operatories o ON o.id = a.operatory_id
         WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time >= ? AND a.status NOT IN ('cancelled')
         ORDER BY a.start_time LIMIT 10`,
        pid, patient.id, (await practiceNow(db, pid)).slice(0, 10),
      ),
      // Past visits, newest first, including missed and cancelled ones (reliability matters when booking).
      past_appointments: await db.all(
        `SELECT a.id, a.start_time, a.end_time, a.status, a.reason, pr.name AS provider_name FROM appointments a
         JOIN providers pr ON pr.id = a.provider_id WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time < ?
         ORDER BY a.start_time DESC LIMIT 25`,
        pid, patient.id, (await practiceNow(db, pid)).slice(0, 10),
      ),
      recalls: await db.all('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? ORDER BY due_date', pid, patient.id),
      history_review_pending: (await db.get("SELECT COUNT(*) AS n FROM patient_forms WHERE patient_id = ? AND kind = 'medical_history' AND review_status = 'pending'", patient.id)).n > 0,
      guarantor: patient.guarantor_id ? await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ?', patient.guarantor_id) : null,
      family_size: (await db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND status != \'archived\' AND (id = ? OR guarantor_id = ?)', pid, patient.guarantor_id || patient.id, patient.guarantor_id || patient.id)).n,
      open_lab_cases: await db.all("SELECT id, lab_name, description, status, due_date FROM lab_cases WHERE practice_id = ? AND patient_id = ? AND status IN ('sent','returned_for_adjustment','received') ORDER BY due_date", pid, patient.id),
    });
  });

  r.put('/patients/:id', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, FIELDS);
    validate(row);
    await validateCustom(db, req.user.practice_id, row, existing.custom);
    if (row.first_name === null || row.last_name === null) throw new HttpError(400, 'Name cannot be blank');
    await checkHomeOffice(req, row);
    if (row.primary_provider_id) await findOr404(db, 'providers', row.primary_provider_id, req.user.practice_id, 'Provider');
    if (row.primary_hygienist_id) await findOr404(db, 'providers', row.primary_hygienist_id, req.user.practice_id, 'Hygienist');
    else if ('primary_hygienist_id' in row) row.primary_hygienist_id = null;
    await checkFeeSchedule(db, row, req);
    // Texts can't be switched back on for a number that replied STOP: carriers require the patient to text START.
    if (row.sms_opt_in && !existing.sms_opt_in && await isOptedOutAddress(db, req.user.practice_id, 'sms', row.phone ?? existing.phone)) {
      throw new HttpError(409, 'This number replied STOP to our texts. The patient needs to text START to that number to receive texts again.');
    }
    if (row.email_opt_in && !existing.email_opt_in && (row.email ?? existing.email)) await clearOptOut(db, req.user.practice_id, 'email', row.email ?? existing.email);
    if (row.guarantor_id) {
      const g = await findOr404(db, 'patients', row.guarantor_id, req.user.practice_id, 'Guarantor');
      if (g.id === existing.id) row.guarantor_id = null;
      else if (g.guarantor_id) throw new HttpError(400, 'Choose the head of household as guarantor');
    }
    await update(db, 'patients', existing.id, req.user.practice_id, { ...row, updated_at: new Date().toISOString() });
    await audit(db, req, 'patient.update', 'patients', existing.id, { fields: Object.keys(row) });
    await emitPatient(db, existing.id, 'patient.updated');
    res.json(await db.get('SELECT * FROM patients WHERE id = ?', existing.id));
  });

  // Medical records are retained; "deleting" archives the patient.
  r.delete('/patients/:id', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    await update(db, 'patients', existing.id, req.user.practice_id, { status: 'archived', updated_at: new Date().toISOString() });
    await audit(db, req, 'patient.archive', 'patients', existing.id);
    res.json({ ok: true });
  });

  return r;
}
