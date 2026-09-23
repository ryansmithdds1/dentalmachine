import { Router } from 'express';
import { HttpError, hashPassword, PERMISSION_CATALOG, PERMISSIONS } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, staffPractice, toCsv } from '../util.js';
import { validatePassword } from './auth.js';
import { validateHours, validateWorkingHours } from '../hours.js';
import { validateReminderSteps } from '../messaging.js';
import { validateRecallSteps, recallTypes } from '../recalls.js';
import { PROVIDERS, sealSecret } from '../sso.js';
import { validateTemplates, DEFAULT_TEMPLATES, TEMPLATE_META } from '../templates.js';

const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Simple practice-scoped resources share one CRUD shape.
function resource(r, db, { path, table, fields, required, validate = () => {}, order = 'name' }) {
  r.get(`/${path}`, async (req, res) => {
    const activeOnly = req.query.active === 'true' ? ' AND active = 1' : '';
    res.json(await db.all(`SELECT * FROM ${table} WHERE practice_id = ?${activeOnly} ORDER BY ${order}`, req.user.practice_id));
  });
  r.post(`/${path}`, requireAdmin, async (req, res) => {
    const row = pick(req.body, fields);
    requireFields(row, required);
    await validate(row, req);
    const id = await insert(db, table, { ...row, practice_id: req.user.practice_id });
    await audit(db, req, `${table}.create`, table, id);
    res.status(201).json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
  r.put(`/${path}/:rid`, requireAdmin, async (req, res) => {
    const existing = await findOr404(db, table, req.params.rid, req.user.practice_id);
    const row = pick(req.body, fields);
    await validate(row, req);
    await update(db, table, existing.id, req.user.practice_id, row);
    await audit(db, req, `${table}.update`, table, existing.id);
    res.json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, existing.id));
  });
}

export default function settingsRoutes({ db, secret, config = {} }) {
  const r = Router();

  r.get('/practice', async (req, res) => res.json(staffPractice(await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id), req.user)));
  // ---- Single sign-on settings (the client secret is write-only) ----
  const ssoView = (p) => ({
    provider: p.sso_provider, tenant: p.sso_tenant, issuer: p.sso_issuer, client_id: p.sso_client_id, has_secret: !!p.sso_client_secret,
    domain: p.sso_domain, sso_only: !!p.sso_only, redirect_uri: `${config.appUrl}/api/auth/sso/callback`,
  });
  r.get('/practice/sso', requireAdmin, async (req, res) => res.json({
    ...ssoView(await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id)),
    linked: !!(await db.get('SELECT sso_subject FROM users WHERE id = ?', req.user.id)).sso_subject,
  }));
  r.put('/practice/sso', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const provider = b.provider || null;
    requireOneOf(provider, Object.keys(PROVIDERS), 'provider');
    const row = {
      sso_provider: provider, sso_tenant: b.tenant?.trim() || null, sso_issuer: b.issuer?.trim().replace(/\/$/, '') || null,
      sso_client_id: b.client_id?.trim() || null, sso_domain: b.domain?.trim().toLowerCase().replace(/^@/, '') || null, sso_only: provider && b.sso_only ? 1 : 0,
    };
    if (b.client_secret) row.sso_client_secret = sealSecret(String(b.client_secret).trim(), secret);
    if (!provider) Object.assign(row, { sso_client_secret: null, sso_only: 0 });
    if (provider === 'microsoft' && !row.sso_tenant) throw new HttpError(400, 'Enter your Microsoft Entra tenant ID (Azure portal → Entra ID → Overview)');
    if (provider === 'oidc' && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(row.sso_issuer || '')) throw new HttpError(400, 'Enter the issuer URL (https://…) from your identity provider');
    if (provider && !row.sso_client_id) throw new HttpError(400, 'Enter the client ID from your identity provider');
    const current = await db.get('SELECT sso_client_secret FROM practices WHERE id = ?', req.user.practice_id);
    if (provider && !row.sso_client_secret && !current.sso_client_secret) throw new HttpError(400, 'Enter the client secret from your identity provider');
    const keys = Object.keys(row);
    await db.run(`UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), req.user.practice_id);
    await audit(db, req, 'practice.sso_update', 'practices', req.user.practice_id, { provider, sso_only: !!row.sso_only });
    res.json(ssoView(await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id)));
  });

  r.get('/message-templates/defaults', (_req, res) => res.json(DEFAULT_TEMPLATES));
  r.get('/message-templates/meta', (_req, res) => res.json(TEMPLATE_META));
  r.put('/practice', requireAdmin, async (req, res) => {
    const row = pick(req.body, ['name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'tax_id', 'npi', 'timezone', 'slug', 'online_booking', 'reminder_hours', 'require_mfa', 'office_hours', 'daily_goal', 'sms_number', 'review_url', 'review_requests', 'review_threshold', 'instant_booking', 'idle_timeout_minutes', 'message_templates', 'hygiene_goal', 'portal_enabled', 'lock_date', 'adjustment_approval_limit', 'reminder_steps', 'recall_steps', 'recall_auto']);
    if (row.message_templates != null) row.message_templates = validateTemplates(row.message_templates);
    if (row.review_url && !/^https:\/\/\S+$/.test(row.review_url)) throw new HttpError(400, 'Review link must start with https://');
    if (row.review_threshold != null && ![3, 4, 5].includes(Number(row.review_threshold))) throw new HttpError(400, 'review_threshold must be 3, 4 or 5 stars');
    if (row.idle_timeout_minutes != null) {
      row.idle_timeout_minutes = Number(row.idle_timeout_minutes);
      if (!Number.isInteger(row.idle_timeout_minutes) || row.idle_timeout_minutes < 5 || row.idle_timeout_minutes > 240) throw new HttpError(400, 'Automatic sign-out must be 5-240 minutes');
    }
    if (row.hygiene_goal != null) row.hygiene_goal = toCents(row.hygiene_goal, 'hygiene_goal');
    if (row.office_hours != null) row.office_hours = JSON.stringify(validateHours(typeof row.office_hours === 'string' ? JSON.parse(row.office_hours) : row.office_hours));
    if (row.daily_goal != null) row.daily_goal = toCents(row.daily_goal, 'daily_goal');
    if (row.adjustment_approval_limit !== undefined) row.adjustment_approval_limit = row.adjustment_approval_limit === null || row.adjustment_approval_limit === '' ? null : Math.max(0, toCents(row.adjustment_approval_limit, 'adjustment_approval_limit'));
    if (row.lock_date !== undefined) {
      row.lock_date = row.lock_date || null;
      if (row.lock_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.lock_date)) throw new HttpError(400, 'Lock date must be YYYY-MM-DD');
      if (row.lock_date && row.lock_date >= (await practiceNow(db, req.user.practice_id)).slice(0, 10)) throw new HttpError(400, 'The lock date must be before today');
    }
    if (row.slug != null) {
      row.slug = String(row.slug).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(row.slug)) throw new HttpError(400, 'Booking URL name must be 3-40 lowercase letters, numbers or dashes');
      if (await db.get('SELECT id FROM practices WHERE slug = ? AND id != ?', row.slug, req.user.practice_id)) throw new HttpError(409, 'That booking URL name is taken');
    }
    if (row.online_booking && !(row.slug ?? (await db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id)).slug)) {
      throw new HttpError(400, 'Choose a booking URL name before enabling online booking');
    }
    // Multi-step reminders and automated recall sequences, stored as JSON.
    if (row.reminder_steps !== undefined) {
      if (row.reminder_steps === null) row.reminder_steps = null;
      else {
        try {
          row.reminder_steps = JSON.stringify(validateReminderSteps(typeof row.reminder_steps === 'string' ? JSON.parse(row.reminder_steps) : row.reminder_steps));
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
    }
    if (row.recall_steps !== undefined && row.recall_steps !== null) row.recall_steps = JSON.stringify(validateRecallSteps(typeof row.recall_steps === 'string' ? JSON.parse(row.recall_steps) : row.recall_steps));
    if (row.recall_auto != null) row.recall_auto = row.recall_auto ? 1 : 0;
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
    if (keys.length) await db.run(`UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), req.user.practice_id);
    await audit(db, req, 'practice.update', 'practices', req.user.practice_id);
    res.json({ ...(await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id)), sso_client_secret: undefined });
  });

  // ---- Users ----
  const USER_COLS = 'id, practice_id, email, name, role, active, mfa_enabled, last_login_at, created_at, custom_role_id, permissions_add, permissions_remove';
  // Custom role and per-person permission overrides, checked against the catalog and this practice.
  const permFields = async (req, row) => {
    const out = {};
    if (req.body.custom_role_id !== undefined) out.custom_role_id = req.body.custom_role_id ? (await findOr404(db, 'custom_roles', req.body.custom_role_id, req.user.practice_id, 'Role')).id : null;
    for (const k of ['permissions_add', 'permissions_remove']) {
      if (req.body[k] === undefined) continue;
      const list = Array.isArray(req.body[k]) ? req.body[k] : [];
      const bad = list.find((p) => !(p in PERMISSION_CATALOG));
      if (bad) throw new HttpError(400, `Unknown permission ${bad}`);
      out[k] = list.length ? JSON.stringify([...new Set(list)]) : null;
    }
    return Object.assign(row, out);
  };
  // Everyone can see who's on the team (to assign tasks); account details are for administrators.
  r.get('/users', async (req, res) => res.json(await db.all(
    `SELECT ${req.user.role === 'admin' ? USER_COLS : 'id, name, role, active'} FROM users WHERE practice_id = ? ORDER BY name`, req.user.practice_id,
  )));

  r.post('/users', requireAdmin, async (req, res) => {
    const row = pick(req.body, ['email', 'name', 'role']);
    requireFields(row, ['email', 'name', 'role']);
    requireOneOf(row.role, ROLES, 'role');
    validatePassword(req.body.password);
    if (await db.get('SELECT id FROM users WHERE lower(email) = lower(?)', row.email)) throw new HttpError(409, 'Email already in use');
    await permFields(req, row);
    const id = await insert(db, 'users', { ...row, practice_id: req.user.practice_id, password_hash: hashPassword(req.body.password) });
    await audit(db, req, 'user.create', 'users', id, { role: row.role });
    res.status(201).json(await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id));
  });

  r.put('/users/:uid', requireAdmin, async (req, res) => {
    const existing = await findOr404(db, 'users', req.params.uid, req.user.practice_id, 'User');
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
    await permFields(req, row);
    const permsChanged = ['custom_role_id', 'permissions_add', 'permissions_remove'].some((k) => k in row && row[k] !== existing[k]);
    await update(db, 'users', existing.id, req.user.practice_id, row);
    // A new password, 2FA reset, role change or deactivation ends that person's open sessions.
    if (permsChanged || row.password_hash || req.body.reset_mfa || row.active === 0 || row.active === false || (row.role && row.role !== existing.role)) {
      await db.run('UPDATE users SET token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?', existing.id);
    }
    await audit(db, req, 'user.update', 'users', existing.id, { fields: Object.keys(row).filter((k) => k !== 'password_hash') });
    res.json(await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, existing.id));
  });

  // ---- Custom roles ----
  r.get('/permissions', (_req, res) => res.json({ catalog: PERMISSION_CATALOG, roles: PERMISSIONS }));
  const roleView = (x) => ({ ...x, permissions: JSON.parse(x.permissions || '[]') });
  const cleanRole = (b) => {
    const name = String(b?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name the role');
    const perms = Array.isArray(b.permissions) ? [...new Set(b.permissions)] : [];
    const bad = perms.find((p) => !(p in PERMISSION_CATALOG));
    if (bad) throw new HttpError(400, `Unknown permission ${bad}`);
    return { name, permissions: JSON.stringify(perms) };
  };
  r.get('/roles', requireAdmin, async (req, res) => {
    res.json((await db.all('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.custom_role_id = r.id AND u.active = 1) AS users FROM custom_roles r WHERE r.practice_id = ? ORDER BY r.name', req.user.practice_id)).map(roleView));
  });
  r.post('/roles', requireAdmin, async (req, res) => {
    const id = await insert(db, 'custom_roles', { ...cleanRole(req.body), practice_id: req.user.practice_id });
    await audit(db, req, 'role.create', 'custom_roles', id);
    res.status(201).json(roleView(await db.get('SELECT * FROM custom_roles WHERE id = ?', id)));
  });
  r.put('/roles/:rid', requireAdmin, async (req, res) => {
    const role = await findOr404(db, 'custom_roles', req.params.rid, req.user.practice_id, 'Role');
    const row = cleanRole(req.body);
    await db.run('UPDATE custom_roles SET name = ?, permissions = ? WHERE id = ?', row.name, row.permissions, role.id);
    // Everyone with the role gets the change at their next request; their sessions restart.
    if (row.permissions !== role.permissions) await db.run('UPDATE users SET token_version = token_version + 1 WHERE custom_role_id = ?', role.id);
    await audit(db, req, 'role.update', 'custom_roles', role.id);
    res.json(roleView(await db.get('SELECT * FROM custom_roles WHERE id = ?', role.id)));
  });
  r.delete('/roles/:rid', requireAdmin, async (req, res) => {
    const role = await findOr404(db, 'custom_roles', req.params.rid, req.user.practice_id, 'Role');
    if ((await db.get('SELECT COUNT(*) AS n FROM users WHERE custom_role_id = ?', role.id)).n) throw new HttpError(409, 'Move the people in this role to another role first');
    await db.run('DELETE FROM custom_roles WHERE id = ?', role.id);
    await audit(db, req, 'role.delete', 'custom_roles', role.id);
    res.json({ ok: true });
  });

  resource(r, db, {
    path: 'providers', table: 'providers', required: ['name'],
    fields: ['name', 'type', 'npi', 'license_number', 'dea_number', 'erx_user_id', 'color', 'active', 'user_id', 'working_hours', 'daily_goal'],
    validate: async (row, req) => {
      if (row.working_hours != null) row.working_hours = JSON.stringify(validateWorkingHours(typeof row.working_hours === 'string' ? JSON.parse(row.working_hours) : row.working_hours));
      requireOneOf(row.type, ['dentist', 'hygienist', 'specialist'], 'type');
      if (row.npi && !/^\d{10}$/.test(row.npi)) throw new HttpError(400, 'NPI must be 10 digits');
      if (row.user_id) await findOr404(db, 'users', row.user_id, req.user.practice_id, 'User');
    },
  });

  // Chairs: display order, whether it's a hygiene chair, and who usually works in it (new visits dragged there default to them).
  resource(r, db, {
    path: 'operatories', table: 'operatories', required: ['name'], fields: ['name', 'active', 'sort', 'is_hygiene', 'default_provider_id'], order: 'sort, id',
    validate: async (row, req) => {
      if (row.default_provider_id) await findOr404(db, 'providers', row.default_provider_id, req.user.practice_id, 'Provider');
      else if ('default_provider_id' in row) row.default_provider_id = null;
      if (row.sort != null) row.sort = Number(row.sort) || 0;
      if (row.is_hygiene != null) row.is_hygiene = row.is_hygiene ? 1 : 0;
    },
  });

  resource(r, db, {
    path: 'procedure-codes', table: 'procedure_codes', required: ['code', 'description', 'category'], order: 'code',
    fields: ['code', 'description', 'category', 'fee', 'requires_tooth', 'requires_surface', 'active', 'area', 'time_units'],
    validate: (row) => {
      requireOneOf(row.category, CATEGORIES, 'category');
      if (row.area === '') row.area = null;
      requireOneOf(row.area ?? undefined, ['tooth', 'quadrant', 'arch', 'mouth'], 'area');
      if (row.time_units === '') row.time_units = null;
      if (row.time_units != null && (!Number.isInteger(Number(row.time_units)) || Number(row.time_units) < 0 || Number(row.time_units) > 96)) throw new HttpError(400, 'time_units must be 0-96');
      if (row.code) row.code = row.code.toUpperCase();
      if (row.fee != null) row.fee = toCents(row.fee, 'fee');
    },
  });

  resource(r, db, {
    path: 'appointment-types', table: 'appointment_types', required: ['name', 'duration'], order: 'sort, name',
    fields: ['name', 'name_es', 'duration', 'color', 'procedure_codes', 'provider_type', 'online_bookable', 'deposit', 'active', 'sort'],
    validate: (row) => {
      if (row.deposit != null) {
        row.deposit = Math.round(Number(row.deposit) || 0);
        if (row.deposit < 0 || (row.deposit > 0 && row.deposit < 100) || row.deposit > 100000) throw new HttpError(400, 'Deposit must be $1–$1,000 (or 0 for none)');
      }
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

  // Searchable audit trail (HIPAA access reviews): by date range, patient, user and action; paged,
  // or the whole match as CSV for a compliance file.
  r.get('/audit-log', requireAdmin, async (req, res) => {
    const csv = req.query.format === 'csv';
    const limit = csv ? 100_000 : Math.min(Number(req.query.limit) || 100, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
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
    if (req.query.action) {
      where.push('a.action LIKE ?');
      params.push(`${String(req.query.action).replace(/[%_]/g, '')}%`);
    }
    for (const [k, op, suffix] of [['from', '>=', ' 00:00:00'], ['to', '<=', ' 23:59:59']]) {
      if (!req.query[k]) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
      where.push(`a.created_at ${op} ?`);
      params.push(`${req.query[k]}${suffix}`);
    }
    if (req.query.patient_id) {
      // Anything about the patient: their record, or entries whose details name them.
      const id = Number(req.query.patient_id);
      // Their record, their appointments/charts/bills (by the record's patient), or details that name them.
      const owned = ['appointments', 'procedures', 'ledger_entries', 'claims', 'clinical_notes', 'documents', 'treatment_plans', 'prescriptions', 'perio_exams', 'patient_insurance'];
      where.push(`((a.entity = 'patients' AND a.entity_id = ?) OR ${owned.map((t) => `(a.entity = '${t}' AND a.entity_id IN (SELECT id FROM ${t} WHERE patient_id = ?))`).join(' OR ')} OR a.details LIKE ? OR a.details LIKE ?)`);
      params.push(id, ...owned.map(() => id), `%"patient_id":${id},%`, `%"patient_id":${id}}%`);
    }
    const rows = await db.all(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset,
    );
    if (!csv) return res.json(rows);
    await audit(db, req, 'audit_log.export', null, null, { filters: pick(req.query, ['from', 'to', 'user_id', 'patient_id', 'action', 'entity']), rows: rows.length });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(toCsv(rows, [['When (UTC)', (r) => r.created_at], ['User', (r) => r.user_name || ''], ['Action', (r) => r.action], ['Record', (r) => r.entity || ''], ['Record ID', (r) => r.entity_id ?? ''], ['IP', (r) => r.ip || ''], ['Details', (r) => r.details || '']]));
  });

  return r;
}
