import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

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

export function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (PERMISSIONS[user.role] || []).includes(permission);
}

export function authenticate(db, secret, { allowMfaSetup = false } = {}) {
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token && verifyToken(token, secret);
    if (!payload) return next(new HttpError(401, 'Authentication required'));
    const user = db.get('SELECT id, practice_id, email, name, role, active FROM users WHERE id = ?', payload.sub);
    if (!user || !user.active) return next(new HttpError(401, 'Account disabled or not found'));
    // Practices can require 2FA; until it's set up, only the account/MFA endpoints are reachable.
    if (!allowMfaSetup) {
      const gate = db.get('SELECT p.require_mfa, u.mfa_enabled FROM users u JOIN practices p ON p.id = u.practice_id WHERE u.id = ?', user.id);
      if (gate.require_mfa && !gate.mfa_enabled) return next(new HttpError(403, 'Two-factor authentication setup required', { mfa_setup_required: true }));
    }
    req.user = user;
    next();
  };
}

export const requirePermission = (permission) => (req, _res, next) =>
  can(req.user, permission) ? next() : next(new HttpError(403, `Missing permission: ${permission}`));

// Naive fixed-window limiter; good enough to blunt credential stuffing on a single node.
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, _res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    if (++entry.count > max) return next(new HttpError(429, 'Too many attempts, try again later'));
    next();
  };
}
