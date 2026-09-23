import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, practiceNow } from '../util.js';
import { patientBalance, primaryPolicy } from '../services.js';

const FIELDS = [
  'first_name', 'last_name', 'preferred_name', 'dob', 'gender', 'email', 'phone', 'address', 'city', 'state', 'zip',
  'emergency_contact', 'medical_alerts', 'allergies', 'medications', 'notes', 'primary_provider_id', 'status', 'sms_opt_in', 'email_opt_in',
];

function validate(row) {
  requireOneOf(row.status, ['active', 'inactive', 'archived'], 'status');
  if (row.dob && !/^\d{4}-\d{2}-\d{2}$/.test(row.dob)) throw new HttpError(400, 'dob must be YYYY-MM-DD');
  if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'Invalid email');
}

export default function patientRoutes({ db }) {
  const r = Router();

  r.get('/patients', requirePermission('patients:read'), (req, res) => {
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
      where.push(`(p.first_name LIKE ? OR p.last_name LIKE ? OR (p.first_name || ' ' || p.last_name) LIKE ? OR p.phone LIKE ? OR p.email LIKE ? OR p.dob = ? OR CAST(p.id AS TEXT) = ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, q, q);
    }
    const whereSql = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM patients p WHERE ${whereSql}`, ...params).n;
    const rows = db.all(
      `SELECT p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.email, p.status, p.medical_alerts,
        (SELECT COALESCE(SUM(amount),0) FROM ledger_entries l WHERE l.patient_id = p.id) AS balance,
        (SELECT MIN(start_time) FROM appointments a WHERE a.patient_id = p.id AND a.start_time >= ? AND a.status NOT IN ('cancelled','no_show')) AS next_appointment
       FROM patients p WHERE ${whereSql} ORDER BY p.last_name, p.first_name LIMIT ? OFFSET ?`,
      practiceNow(db, req.user.practice_id), ...params, limit, offset,
    );
    res.json({ total, rows });
  });

  r.post('/patients', requirePermission('patients:write'), (req, res) => {
    const row = pick(req.body, FIELDS);
    requireFields(row, ['first_name', 'last_name']);
    validate(row);
    if (row.primary_provider_id) findOr404(db, 'providers', row.primary_provider_id, req.user.practice_id, 'Provider');
    const id = insert(db, 'patients', { ...row, practice_id: req.user.practice_id });
    audit(db, req, 'patient.create', 'patients', id);
    res.status(201).json(db.get('SELECT * FROM patients WHERE id = ?', id));
  });

  r.get('/patients/:id', requirePermission('patients:read'), (req, res) => {
    const patient = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const pid = req.user.practice_id;
    audit(db, req, 'patient.view', 'patients', patient.id);
    res.json({
      ...patient,
      balance: patientBalance(db, pid, patient.id),
      primary_insurance: primaryPolicy(db, pid, patient.id) || null,
      upcoming_appointments: db.all(
        `SELECT a.*, pr.name AS provider_name, o.name AS operatory_name FROM appointments a
         JOIN providers pr ON pr.id = a.provider_id LEFT JOIN operatories o ON o.id = a.operatory_id
         WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time >= ? AND a.status NOT IN ('cancelled')
         ORDER BY a.start_time LIMIT 10`,
        pid, patient.id, practiceNow(db, pid).slice(0, 10),
      ),
      recalls: db.all('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? ORDER BY due_date', pid, patient.id),
    });
  });

  r.put('/patients/:id', requirePermission('patients:write'), (req, res) => {
    const existing = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, FIELDS);
    validate(row);
    if (row.first_name === null || row.last_name === null) throw new HttpError(400, 'Name cannot be blank');
    if (row.primary_provider_id) findOr404(db, 'providers', row.primary_provider_id, req.user.practice_id, 'Provider');
    update(db, 'patients', existing.id, req.user.practice_id, { ...row, updated_at: new Date().toISOString() });
    audit(db, req, 'patient.update', 'patients', existing.id, { fields: Object.keys(row) });
    res.json(db.get('SELECT * FROM patients WHERE id = ?', existing.id));
  });

  // Medical records are retained; "deleting" archives the patient.
  r.delete('/patients/:id', requirePermission('patients:write'), (req, res) => {
    const existing = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    update(db, 'patients', existing.id, req.user.practice_id, { status: 'archived', updated_at: new Date().toISOString() });
    audit(db, req, 'patient.archive', 'patients', existing.id);
    res.json({ ok: true });
  });

  return r;
}
