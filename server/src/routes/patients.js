import { Router } from 'express';
import { pretendPhone, pretendEmail } from '../training.js';
import { requirePermission, HttpError, can } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, practiceNow, recorded, isRealDate, validEmail } from '../util.js';
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

// The medical history (alerts, allergies, medications, conditions, ASA, premed) is clinical data: it is
// edited together in one place, by someone with clinical access, and saving it counts as reviewing it.
export const MEDICAL_FIELDS = ['medical_alerts', 'allergies', 'medications', 'medical_conditions', 'asa_class', 'premed_required'];
// A history not reviewed in a year (or never) is due; the morning huddle uses the same year.
export const MEDICAL_REVIEW_DAYS = 365;
export function medicalReviewDue(reviewedAt, today) {
  if (!reviewedAt) return true;
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - MEDICAL_REVIEW_DAYS);
  return String(reviewedAt).slice(0, 10) < cutoff.toISOString().slice(0, 10);
}
const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// Whether a medical field would really change (no conditions and an empty list are the same; so are 0 and no premed).
const medicalValue = (k, v) => (v == null || v === '' || (k === 'medical_conditions' && v === '[]') || (k === 'premed_required' && !Number(v)) ? '' : String(v));
const medicalChanges = (row, existing) => MEDICAL_FIELDS.filter((k) => k in row && medicalValue(k, row[k]) !== medicalValue(k, existing[k]));

// A patient's own fees (e.g. cash / uninsured) come from an office fee schedule.
async function checkFeeSchedule(db, row, req) {
  if (!('fee_schedule_id' in row)) return;
  if (!row.fee_schedule_id) { row.fee_schedule_id = null; return; }
  const fs = await db.get("SELECT id FROM fee_schedules WHERE id = ? AND practice_id = ? AND kind = 'office'", row.fee_schedule_id, req.user.practice_id);
  if (!fs) throw new HttpError(400, 'Choose an office fee schedule');
}

function validate(row) {
  requireOneOf(row.status, ['active', 'inactive', 'archived'], 'status');
  if (row.dob && (!isRealDate(row.dob) || row.dob > new Date().toISOString().slice(0, 10))) throw new HttpError(400, 'dob must be a real date of birth (YYYY-MM-DD), not in the future');
  // Free text has sensible limits (a chart field isn't a document store).
  const LIMITS = { first_name: 100, last_name: 100, preferred_name: 100, gender: 40, address: 200, city: 100, state: 40, zip: 20, emergency_contact: 300, referral_source: 200,
    medical_alerts: 2000, allergies: 2000, medications: 4000, medical_conditions: 4000, notes: 10000, office_alert: 500 };
  for (const [k, n] of Object.entries(LIMITS)) if (typeof row[k] === 'string' && row[k].length > n) throw new HttpError(400, `${k.replace(/_/g, ' ')} can be at most ${n} characters`);
  if (row.email && !validEmail(row.email)) throw new HttpError(400, 'Invalid email');
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

// The training patient (training.js) only ever has pretend contact details, so nothing addressed to it could reach a
// real person: 555-01xx numbers (reserved for fiction) and .invalid / example.com addresses.
function checkPretendContacts(row) {
  for (const k of ['phone', 'phone_home', 'phone_work']) {
    if (row[k] && !pretendPhone(row[k])) throw new HttpError(400, `Tess Training is a practice patient: use a pretend number such as (512) 555-0142 — 555-0100 to 555-0199 are never real`);
  }
  if (row.email && !pretendEmail(row.email)) throw new HttpError(400, 'Tess Training is a practice patient: use a pretend address such as tess@example.com');
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
       WHERE practice_id = ? AND status != 'archived' AND merged_into_id IS NULL AND dob IS NOT NULL ORDER BY lower(last_name), lower(first_name), dob, id`,
      req.user.practice_id,
    );
    const groups = new Map();
    for (const r0 of rows) {
      const key = `${r0.last_name.trim().toLowerCase()}|${r0.first_name.trim().toLowerCase()}|${r0.dob}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r0);
    }
    const found = [...groups.values()].filter((g) => g.length > 1).slice(0, 200);
    // For the side-by-side compare (workflow 51): how much history each chart has, and which one to keep —
    // the one with the most history (visits, ledger, notes, documents, insurance), the older one on a tie.
    const count = async (sql, id) => Number((await db.get(sql, id)).n);
    for (const g of found) {
      for (const p of g) {
        p.visits = await count('SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ?', p.id);
        p.last_visit = (await db.get("SELECT MAX(substr(start_time, 1, 10)) AS d FROM appointments WHERE patient_id = ? AND status = 'completed'", p.id)).d || null;
        p.ledger_entries = await count('SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ?', p.id);
        p.balance = await count('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ?', p.id);
        p.notes = await count('SELECT COUNT(*) AS n FROM clinical_notes WHERE patient_id = ?', p.id);
        p.documents = await count('SELECT COUNT(*) AS n FROM documents WHERE patient_id = ? AND deleted_at IS NULL', p.id);
        p.insurance = await count('SELECT COUNT(*) AS n FROM patient_insurance WHERE patient_id = ? AND active = 1', p.id);
        p.history = p.visits + p.ledger_entries + p.notes + p.documents + p.insurance;
      }
      g.sort((a, b) => b.history - a.history || String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
      g[0].suggested_keep = true;
    }
    res.json(found);
  });

  // Merge a duplicate chart into this one: everything that belonged to the duplicate (visits, charting,
  // ledger, claims, documents, messages…) moves here, blank details are filled in, and the duplicate is archived
  // (marked as merged into this one) rather than deleted.
  r.post('/patients/:id/merge', requirePermission('patients:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can merge patients');
    const keep = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const from = await findOr404(db, 'patients', req.body?.from_id, req.user.practice_id, 'Patient');
    if (keep.id === from.id) throw new HttpError(400, 'Choose a different chart to merge');
    if (from.merged_into_id || keep.merged_into_id) throw new HttpError(409, 'That chart was already merged into another one');
    // A real chart and the pretend one are never the same person (training.js).
    if (!!keep.is_training !== !!from.is_training) throw new HttpError(400, 'The training patient can’t be merged with a real chart');
    const moved = {};
    await db.tx(async () => {
      // Recalls are one per type: keep the sooner due date. The duplicate's own copy stays on its archived chart.
      const leftBehind = [];
      for (const rc of await db.all('SELECT * FROM recalls WHERE patient_id = ?', from.id)) {
        const mine = await db.get('SELECT * FROM recalls WHERE patient_id = ? AND type = ?', keep.id, rc.type);
        if (mine) {
          if (rc.due_date < mine.due_date) await recorded(db, 'recalls', mine.id, () => db.run('UPDATE recalls SET due_date = ? WHERE id = ?', rc.due_date, mine.id));
          await db.run("UPDATE recalls SET status = 'inactive' WHERE id = ?", rc.id);
          leftBehind.push(rc.id);
        }
      }
      // Journey choices are one row per patient: when both charts have one, the kept chart takes the stricter
      // "no celebrations" and VIP from either (never a newsletter opt-in it didn't give), and the duplicate's
      // row stays on its archived chart.
      const prefs = await db.get('SELECT * FROM journey_prefs WHERE patient_id = ?', from.id);
      const mine = prefs && (await db.get('SELECT * FROM journey_prefs WHERE patient_id = ?', keep.id));
      if (mine && ((prefs.no_celebrations && !mine.no_celebrations) || (prefs.vip && !mine.vip))) {
        await recorded(db, 'journey_prefs', mine.id, () => db.run('UPDATE journey_prefs SET no_celebrations = ?, vip = ? WHERE id = ?',
          mine.no_celebrations || prefs.no_celebrations ? 1 : 0, mine.vip || prefs.vip ? 1 : 0, mine.id));
      }
      // Rows that are unique per patient stay on the duplicate when the kept chart already has the same one.
      const unique = {
        'journey_prefs.patient_id': ' AND NOT EXISTS (SELECT 1 FROM journey_prefs x WHERE x.patient_id = ?)',
        'journey_moments.patient_id': ' AND NOT EXISTS (SELECT 1 FROM journey_moments x WHERE x.patient_id = ? AND x.practice_id = journey_moments.practice_id AND x.kind = journey_moments.kind AND x.source_key = journey_moments.source_key)',
        'journey_referrals.referred_patient_id': ' AND NOT EXISTS (SELECT 1 FROM journey_referrals x WHERE x.referred_patient_id = ? AND x.practice_id = journey_referrals.practice_id)',
        'journey_broadcast_recipients.patient_id': ' AND NOT EXISTS (SELECT 1 FROM journey_broadcast_recipients x WHERE x.patient_id = ? AND x.broadcast_id = journey_broadcast_recipients.broadcast_id)',
      };
      for (const [table, cols] of schemaInfo()) {
        for (const c of cols) {
          if (c.ref !== 'patients') continue;
          const skip = table === 'recalls' && leftBehind.length ? ` AND id NOT IN (${leftBehind.map(() => '?').join(',')})` : unique[`${table}.${c.name}`] || '';
          const skipArgs = table === 'recalls' && leftBehind.length ? leftBehind : unique[`${table}.${c.name}`] ? [keep.id] : [];
          const r0 = await db.run(`UPDATE ${table} SET ${c.name} = ? WHERE ${c.name} = ?${skip}`, keep.id, from.id, ...skipArgs);
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
      // The duplicate isn't deleted: it's archived and points at the kept chart, so its history can be traced.
      await update(db, 'patients', from.id, req.user.practice_id, { status: 'archived', merged_into_id: keep.id, guarantor_id: null });
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
    // The training patient (training.js) isn't one of the practice's patients: it's only listed when searched for
    // (and then with a Training badge).
    if (!q) where.push('p.is_training = 0');
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
      `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.email, p.status, p.medical_alerts, p.is_training,
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
    // A family member added to the training patient's household is a training patient too (util.js insert), as is a
    // patient made during a guided walkthrough in practice mode — with pretend details, like Tess.
    if (req.get('X-Practice-Mode') === '1' || (row.guarantor_id && (await db.get('SELECT is_training FROM patients WHERE id = ?', row.guarantor_id))?.is_training)) checkPretendContacts(row);
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

  // The small card shown when hovering a visit on the schedule: who they are and what to know before
  // they sit down. Health details need clinical access, money needs billing access (as on the huddle).
  r.get('/patients/:id/card', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const clinical = can(req.user, 'clinical:read');
    const billing = can(req.user, 'billing:read');
    const policy = billing ? await primaryPolicy(db, pid, p.id) : null;
    const elig = policy ? await db.get('SELECT status, created_at FROM eligibility_checks WHERE patient_insurance_id = ? ORDER BY id DESC LIMIT 1', policy.id) : null;
    const visit = (op, dir) => db.get(
      `SELECT a.start_time, a.reason, a.status, pr.name AS provider_name FROM appointments a JOIN providers pr ON pr.id = a.provider_id
       WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time ${op} ? AND a.status ${op === '<' ? "= 'completed'" : "NOT IN ('cancelled','no_show','completed')"} ORDER BY a.start_time ${dir} LIMIT 1`,
      pid, p.id, op === '<' ? today : `${today} 24:00`,
    );
    const unscheduled = clinical ? await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0) AS amount FROM procedures WHERE practice_id = ? AND patient_id = ? AND status = 'planned' AND appointment_id IS NULL", pid, p.id) : null;
    const missed = (await db.get("SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND patient_id = ? AND status = 'no_show' AND start_time >= ?", pid, p.id, `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`)).n;
    res.json({
      id: p.id, first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name, dob: p.dob, phone: p.phone, email: p.email,
      is_training: p.is_training ? 1 : 0, photo: p.photo || null, office_alert: p.office_alert, language: p.language,
      ...(clinical ? {
        medical_alerts: p.medical_alerts, allergies: p.allergies, premed_required: !!p.premed_required, medical_reviewed_at: p.medical_reviewed_at,
        medical_review_due: medicalReviewDue(p.medical_reviewed_at, today),
      } : {}),
      ...(billing ? {
        balance: await patientBalance(db, pid, p.id),
        insurance: policy ? { carrier: policy.carrier_name, eligibility: elig?.status ?? null, checked_at: elig?.created_at ?? null } : null,
      } : {}),
      last_visit: (await visit('<', 'DESC')) || null,
      next_visit: (await visit('>=', 'ASC')) || null,
      unscheduled: unscheduled ? { count: Number(unscheduled.n), amount: Number(unscheduled.amount) } : null,
      missed_2y: Number(missed),
    });
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
    // Changing the medical history needs clinical access (the same values sent back unchanged are fine).
    if (medicalChanges(row, existing).length && !can(req.user, 'clinical:write')) throw new HttpError(403, 'Changing the medical history needs clinical access');
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
    // A new number or address gets a fresh start after a landline or bounce report.
    if ('phone' in row && row.phone !== existing.phone) Object.assign(row, { sms_bad_at: null, sms_bad_reason: null });
    if ('email' in row && row.email !== existing.email) Object.assign(row, { email_bad_at: null, email_bad_reason: null });
    if (row.guarantor_id) {
      const g = await findOr404(db, 'patients', row.guarantor_id, req.user.practice_id, 'Guarantor');
      if (g.id === existing.id) row.guarantor_id = null;
      else if (g.guarantor_id) throw new HttpError(400, 'Choose the head of household as guarantor');
      else if (!!g.is_training !== !!existing.is_training) throw new HttpError(400, 'The training patient’s family is pretend: a real patient can’t join it, and it can’t join a real family');
    }
    if (existing.is_training) checkPretendContacts(row);
    await update(db, 'patients', existing.id, req.user.practice_id, { ...row, updated_at: new Date().toISOString() });
    await audit(db, req, 'patient.update', 'patients', existing.id, { fields: Object.keys(row) });
    await emitPatient(db, existing.id, 'patient.updated');
    res.json(await db.get('SELECT * FROM patients WHERE id = ?', existing.id));
  });

  // The one medical history editor: alerts, allergies, medications, conditions, ASA and premed together.
  // Only fields sent are changed (before/after recorded on the audit entry); saving counts as a review
  // unless `reviewed: false` (an undo puts the old values back without claiming a new review).
  r.put('/patients/:id/medical', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, MEDICAL_FIELDS);
    for (const k of ['medical_alerts', 'allergies', 'medications']) {
      if (k in row) row[k] = row[k] == null ? null : String(row[k]).trim() || null;
    }
    if ('asa_class' in row && !row.asa_class) row.asa_class = null;
    if ('premed_required' in row && ![0, 1, null].includes(row.premed_required)) throw new HttpError(400, 'premed_required must be true or false');
    if ('medical_conditions' in row && row.medical_conditions === null) row.medical_conditions = [];
    validate(row);
    const reviewed = req.body?.reviewed !== false;
    if (!Object.keys(row).length && !reviewed) throw new HttpError(400, 'Nothing to change');
    const changed = medicalChanges(row, existing);
    const patch = Object.fromEntries(changed.map((k) => [k, row[k]]));
    if (changed.length) patch.updated_at = new Date().toISOString();
    if (reviewed) patch.medical_reviewed_at = utcNow();
    if (Object.keys(patch).length) await update(db, 'patients', existing.id, req.user.practice_id, patch);
    await audit(db, req, reviewed ? 'patient.medical_update' : 'patient.medical_revert', 'patients', existing.id, { fields: changed, reviewed });
    if (changed.length) await emitPatient(db, existing.id, 'patient.updated');
    const out = await db.get(`SELECT id, ${MEDICAL_FIELDS.join(', ')}, medical_reviewed_at FROM patients WHERE id = ?`, existing.id);
    res.json({ ...out, premed_required: !!out.premed_required, changed, medical_review_due: medicalReviewDue(out.medical_reviewed_at, (await practiceNow(db, req.user.practice_id)).slice(0, 10)) });
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
