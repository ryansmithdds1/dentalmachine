import { Router } from 'express';
import { HttpError, hashPassword } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents } from '../util.js';
import { validatePassword } from './auth.js';
import { validateHours } from '../hours.js';
import { validateTemplates, DEFAULT_TEMPLATES } from '../templates.js';

const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Simple practice-scoped resources share one CRUD shape.
function resource(r, db, { path, table, fields, required, validate = () => {}, order = 'name' }) {
  r.get(`/${path}`, (req, res) => {
    const activeOnly = req.query.active === 'true' ? ' AND active = 1' : '';
    res.json(db.all(`SELECT * FROM ${table} WHERE practice_id = ?${activeOnly} ORDER BY ${order}`, req.user.practice_id));
  });
  r.post(`/${path}`, requireAdmin, (req, res) => {
    const row = pick(req.body, fields);
    requireFields(row, required);
    validate(row, req);
    const id = insert(db, table, { ...row, practice_id: req.user.practice_id });
    audit(db, req, `${table}.create`, table, id);
    res.status(201).json(db.get(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
  r.put(`/${path}/:rid`, requireAdmin, (req, res) => {
    const existing = findOr404(db, table, req.params.rid, req.user.practice_id);
    const row = pick(req.body, fields);
    validate(row, req);
    update(db, table, existing.id, req.user.practice_id, row);
    audit(db, req, `${table}.update`, table, existing.id);
    res.json(db.get(`SELECT * FROM ${table} WHERE id = ?`, existing.id));
  });
}

export default function settingsRoutes({ db }) {
  const r = Router();

  r.get('/practice', (req, res) => res.json(db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id)));
  r.get('/message-templates/defaults', (_req, res) => res.json(DEFAULT_TEMPLATES));
  r.put('/practice', requireAdmin, (req, res) => {
    const row = pick(req.body, ['name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'tax_id', 'npi', 'timezone', 'slug', 'online_booking', 'reminder_hours', 'require_mfa', 'office_hours', 'daily_goal', 'sms_number', 'review_url', 'review_requests', 'idle_timeout_minutes', 'message_templates', 'hygiene_goal']);
    if (row.message_templates != null) row.message_templates = validateTemplates(row.message_templates);
    if (row.review_url && !/^https:\/\/\S+$/.test(row.review_url)) throw new HttpError(400, 'Review link must start with https://');
    if (row.idle_timeout_minutes != null) {
      row.idle_timeout_minutes = Number(row.idle_timeout_minutes);
      if (!Number.isInteger(row.idle_timeout_minutes) || row.idle_timeout_minutes < 5 || row.idle_timeout_minutes > 240) throw new HttpError(400, 'Automatic sign-out must be 5-240 minutes');
    }
    if (row.hygiene_goal != null) row.hygiene_goal = toCents(row.hygiene_goal, 'hygiene_goal');
    if (row.office_hours != null) row.office_hours = JSON.stringify(validateHours(typeof row.office_hours === 'string' ? JSON.parse(row.office_hours) : row.office_hours));
    if (row.daily_goal != null) row.daily_goal = toCents(row.daily_goal, 'daily_goal');
    if (row.slug != null) {
      row.slug = String(row.slug).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(row.slug)) throw new HttpError(400, 'Booking URL name must be 3-40 lowercase letters, numbers or dashes');
      if (db.get('SELECT id FROM practices WHERE slug = ? AND id != ?', row.slug, req.user.practice_id)) throw new HttpError(409, 'That booking URL name is taken');
    }
    if (row.online_booking && !(row.slug ?? db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id).slug)) {
      throw new HttpError(400, 'Choose a booking URL name before enabling online booking');
    }
    if (row.reminder_hours != null) {
      row.reminder_hours = Number(row.reminder_hours);
      if (!Number.isInteger(row.reminder_hours) || row.reminder_hours < 0 || row.reminder_hours > 168) throw new HttpError(400, 'Reminder lead time must be 0-168 hours');
    }
    if (row.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: row.timezone });
      } catch {
        throw new HttpError(400, 'Invalid timezone');
      }
    }
    const keys = Object.keys(row);
    if (keys.length) db.run(`UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), req.user.practice_id);
    audit(db, req, 'practice.update', 'practices', req.user.practice_id);
    res.json(db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id));
  });

  // ---- Users ----
  const USER_COLS = 'id, practice_id, email, name, role, active, mfa_enabled, last_login_at, created_at';
  r.get('/users', (req, res) => res.json(db.all(`SELECT ${USER_COLS} FROM users WHERE practice_id = ? ORDER BY name`, req.user.practice_id)));

  r.post('/users', requireAdmin, (req, res) => {
    const row = pick(req.body, ['email', 'name', 'role']);
    requireFields(row, ['email', 'name', 'role']);
    requireOneOf(row.role, ROLES, 'role');
    validatePassword(req.body.password);
    if (db.get('SELECT id FROM users WHERE email = ?', row.email)) throw new HttpError(409, 'Email already in use');
    const id = insert(db, 'users', { ...row, practice_id: req.user.practice_id, password_hash: hashPassword(req.body.password) });
    audit(db, req, 'user.create', 'users', id, { role: row.role });
    res.status(201).json(db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id));
  });

  r.put('/users/:uid', requireAdmin, (req, res) => {
    const existing = findOr404(db, 'users', req.params.uid, req.user.practice_id, 'User');
    const row = pick(req.body, ['name', 'role', 'active']);
    requireOneOf(row.role, ROLES, 'role');
    if (existing.id === req.user.id && (row.active === 0 || (row.role && row.role !== 'admin'))) {
      throw new HttpError(400, 'You cannot deactivate or demote your own account');
    }
    if (req.body.password) {
      validatePassword(req.body.password);
      row.password_hash = hashPassword(req.body.password);
    }
    // Lost phone: an admin can clear a colleague's 2FA so they can enrol again.
    if (req.body.reset_mfa) Object.assign(row, { mfa_enabled: 0, mfa_secret: null, mfa_last_step: null });
    update(db, 'users', existing.id, req.user.practice_id, row);
    audit(db, req, 'user.update', 'users', existing.id, { fields: Object.keys(row).filter((k) => k !== 'password_hash') });
    res.json(db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, existing.id));
  });

  resource(r, db, {
    path: 'providers', table: 'providers', required: ['name'],
    fields: ['name', 'type', 'npi', 'license_number', 'dea_number', 'color', 'active', 'user_id'],
    validate: (row, req) => {
      requireOneOf(row.type, ['dentist', 'hygienist', 'specialist'], 'type');
      if (row.npi && !/^\d{10}$/.test(row.npi)) throw new HttpError(400, 'NPI must be 10 digits');
      if (row.user_id) findOr404(db, 'users', row.user_id, req.user.practice_id, 'User');
    },
  });

  resource(r, db, { path: 'operatories', table: 'operatories', required: ['name'], fields: ['name', 'active'], order: 'id' });

  resource(r, db, {
    path: 'procedure-codes', table: 'procedure_codes', required: ['code', 'description', 'category'], order: 'code',
    fields: ['code', 'description', 'category', 'fee', 'requires_tooth', 'requires_surface', 'active'],
    validate: (row) => {
      requireOneOf(row.category, CATEGORIES, 'category');
      if (row.code) row.code = row.code.toUpperCase();
      if (row.fee != null) row.fee = toCents(row.fee, 'fee');
    },
  });

  resource(r, db, {
    path: 'appointment-types', table: 'appointment_types', required: ['name', 'duration'], order: 'sort, name',
    fields: ['name', 'duration', 'color', 'procedure_codes', 'provider_type', 'online_bookable', 'active', 'sort'],
    validate: (row) => {
      if (row.duration != null) {
        row.duration = Number(row.duration);
        if (!Number.isInteger(row.duration) || row.duration < 5 || row.duration > 480 || row.duration % 5) throw new HttpError(400, 'Duration must be 5-480 minutes in steps of 5');
      }
      requireOneOf(row.provider_type, ['dentist', 'hygienist', 'specialist'], 'provider_type');
      if (row.procedure_codes != null) {
        const codes = Array.isArray(row.procedure_codes) ? row.procedure_codes : String(row.procedure_codes).split(/[\s,]+/).filter(Boolean);
        row.procedure_codes = JSON.stringify(codes.map((c) => String(c).toUpperCase()));
      }
    },
  });

  r.get('/audit-log', requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const where = ['a.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.entity) {
      where.push('a.entity = ?');
      params.push(req.query.entity);
    }
    if (req.query.entity_id) {
      where.push('a.entity_id = ?');
      params.push(Number(req.query.entity_id));
    }
    if (req.query.user_id) {
      where.push('a.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    res.json(db.all(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, ...params, limit,
    ));
  });

  return r;
}
