import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { hit } from './cluster.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, secret, ttlSeconds = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Role → permissions. Admins implicitly have everything.
export const PERMISSIONS = {
  dentist: ['patients:read', 'patients:write', 'schedule:read', 'schedule:write', 'clinical:read', 'clinical:write', 'clinical:sign', 'billing:read', 'reports:read'],
  hygienist: ['patients:read', 'patients:write', 'schedule:read', 'schedule:write', 'clinical:read', 'clinical:write', 'clinical:sign', 'billing:read'],
  assistant: ['patients:read', 'patients:write', 'schedule:read', 'schedule:write', 'clinical:read', 'clinical:write'],
  front_desk: ['patients:read', 'patients:write', 'schedule:read', 'schedule:write', 'clinical:read', 'billing:read', 'billing:write'],
  billing: ['patients:read', 'schedule:read', 'clinical:read', 'billing:read', 'billing:write', 'reports:read'],
};

// Everything a role can be given. Settings, users and practice-wide admin stay with administrators.
export const PERMISSION_CATALOG = {
  'patients:read': 'See patients', 'patients:write': 'Add and edit patients',
  'schedule:read': 'See the schedule', 'schedule:write': 'Book and move appointments',
  'clinical:read': 'See charts, notes and x-rays', 'clinical:write': 'Chart, write notes, upload images', 'clinical:sign': 'Sign clinical notes',
  'billing:read': 'See ledgers and claims', 'billing:write': 'Take payments, adjust, send claims',
  'reports:read': 'See all practice reports', 'reports:own': 'See their own production',
  'timeclock:manage': 'See and fix everyone’s timesheets, export payroll',
  'timeclock:rates': 'See and set staff pay rates and labor cost',
  'business:view': 'See the business view: margins, profit per hour, labor vs production (owner)',
  'business:manage': 'Set procedure costs, provider pay plans and business view thresholds',
  'officedocs:read': 'See office documents (contracts, licences, policies, invoices)',
  'officedocs:write': 'Add and file office documents',
  'checklists:manage': 'Set up checklists by position, see the checklist dashboard and compliance log, resolve checklist flags',
  'fees:manage': 'Change fees: raise fees, approve payer fee schedules, schedule and cancel fee changes',
  'phones:coach': 'Phones: see everyone’s call scores and missed calls, coach and rate calls, edit phone protocols',
  'reviews:manage': 'Handle private patient feedback, review-request settings and team shout-outs',
  'chartaudit:manage': 'See everyone’s chart audit findings and tune the checks',
  'deposits:manage': 'Verify deposits and cash drawers, reopen deposits, approve cash voids, refunds and discounts',
  'intranet:manage': 'Edit the office intranet: links, office manual, announcements and onboarding',
  'finance:read': 'See bank activity, costs and profit', 'finance:write': 'Sort bank lines and match deposits',
};

// A person's permissions: their custom role's (or their built-in role's), plus or minus any set just for them.
export function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === 'admin') return ['*'];
  const parse = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
  const base = user.custom_role_permissions != null ? parse(user.custom_role_permissions) : PERMISSIONS[user.role] || [];
  const add = parse(user.permissions_add);
  const remove = new Set(parse(user.permissions_remove));
  return [...new Set([...base, ...add])].filter((p) => !remove.has(p) && p in PERMISSION_CATALOG);
}

export function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.perms || effectivePermissions(user)).includes(permission);
}

export const USER_PERMISSION_SQL = `SELECT u.id, u.practice_id, u.email, u.name, u.role, u.active, u.token_version, u.custom_role_id, u.permissions_add, u.permissions_remove, u.location_ids, u.must_change_password,
  cr.permissions AS custom_role_permissions, cr.name AS custom_role_name FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id`;

// Minutes past the idle timeout before the server refuses a session (the browser signs out on time).
const SESSION_GRACE_MINUTES = 2;

export function authenticate(db, secret, { allowMfaSetup = false } = {}) {
  return async (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token && verifyToken(token, secret);
    // Only staff sessions reach staff routes (patient-portal tokens are signed with the same key).
    if (!payload || payload.aud !== 'staff') return next(new HttpError(401, 'Authentication required'));
    const user = await db.get(`${USER_PERMISSION_SQL} WHERE u.id = ?`, payload.sub);
    if (!user || !user.active) return next(new HttpError(401, 'Account disabled or not found'));
    // A password change, 2FA reset or "sign out everywhere" bumps the version and ends older sessions.
    if ((payload.tv ?? 0) !== (user.token_version ?? 0)) return next(new HttpError(401, 'Your session has ended — please sign in again'));
    // The server's own record of this sign-in: ended by signing out, or by the practice's idle timeout
    // (HIPAA automatic logoff, enforced here as well as in the browser).
    const s = payload.sid ? await db.get('SELECT s.id, s.last_seen_at, s.ended_at, p.idle_timeout_minutes FROM staff_sessions s JOIN practices p ON p.id = s.practice_id WHERE s.sid = ? AND s.user_id = ?', payload.sid, user.id) : null;
    if (!s || s.ended_at) return next(new HttpError(401, 'Your session has ended — please sign in again'));
    const idleMs = Date.now() - Date.parse(s.last_seen_at);
    if (idleMs > ((s.idle_timeout_minutes || 15) + SESSION_GRACE_MINUTES) * 60_000) {
      await db.run("UPDATE staff_sessions SET ended_at = ?, end_reason = 'idle' WHERE id = ?", new Date().toISOString(), s.id);
      return next(new HttpError(401, 'Signed out after a period without activity — please sign in again', { idle: true }));
    }
    if (idleMs > 30_000) await db.run('UPDATE staff_sessions SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), s.id);
    req.session_id = s.id;
    req.session_sid = payload.sid;
    // Practices can require 2FA; until it's set up, only the account/MFA endpoints are reachable.
    if (!allowMfaSetup) {
      const gate = await db.get('SELECT p.require_mfa, u.mfa_enabled FROM users u JOIN practices p ON p.id = u.practice_id WHERE u.id = ?', user.id);
      if (gate.require_mfa && !gate.mfa_enabled) return next(new HttpError(403, 'Two-factor authentication setup required', { mfa_setup_required: true }));
      if (user.must_change_password) return next(new HttpError(403, 'Choose your own password to continue', { password_change_required: true }));
    }
    user.perms = effectivePermissions(user);
    // Multi-location: the office this screen is working in (X-Location-Id), limited to the user's offices.
    // An unknown or no-longer-allowed choice falls back rather than locking the screen.
    user.location_ids = user.location_ids ? JSON.parse(user.location_ids) : null;
    const want = Number(req.headers['x-location-id']) || null;
    const ok = want && (!user.location_ids || user.location_ids.includes(want)) && await db.get('SELECT id FROM locations WHERE id = ? AND practice_id = ? AND active = 1', want, user.practice_id);
    req.location_id = ok ? want : user.location_ids?.length === 1 ? user.location_ids[0] : null;
    req.user = user;
    next();
  };
}

export const requirePermission = (permission) => (req, _res, next) =>
  can(req.user, permission) ? next() : next(new HttpError(403, `Missing permission: ${permission}`));

// Fixed-window limiter per client IP; shared across servers when Redis is configured.
let limiterSeq = 0;
export function rateLimit({ windowMs, max, name = `l${++limiterSeq}` }) {
  return async (req, _res, next) => {
    const n = await hit(`${name}:${req.ip}`, windowMs);
    if (n > max) return next(new HttpError(429, 'Too many attempts, try again later'));
    next();
  };
}
