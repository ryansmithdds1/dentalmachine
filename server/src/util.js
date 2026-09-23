import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './auth.js';

// Picks allowed fields from a body, trimming strings and turning '' into null.
export function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body && Object.prototype.hasOwnProperty.call(body, f)) {
      let v = body[f];
      if (typeof v === 'string') v = v.trim();
      if (v === '') v = null;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      out[f] = v;
    }
  }
  return out;
}

export function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null);
  if (missing.length) throw new HttpError(400, `Missing required fields: ${missing.join(', ')}`);
}

export function requireOneOf(value, allowed, name) {
  if (value != null && !allowed.includes(value)) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
}

export function toCents(value, name = 'amount') {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return Math.round(n);
}

export function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return db.run(sql, ...keys.map((k) => row[k])).id;
}

export function update(db, table, id, practiceId, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND practice_id = ?`;
  return db.run(sql, ...keys.map((k) => row[k]), id, practiceId).changes;
}

// Fetches a row scoped to the caller's practice or 404s. Tenant isolation hinges on this.
export function findOr404(db, table, id, practiceId, label = table) {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND practice_id = ?`, Number(id), practiceId);
  if (!row) throw new HttpError(404, `${label} not found`);
  return row;
}

export function audit(db, req, action, entity, entityId, details) {
  db.run(
    'INSERT INTO audit_log (practice_id, user_id, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    req.user?.practice_id ?? null,
    req.user?.id ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    details ? JSON.stringify(details) : null,
    req.ip ?? null,
  );
}

export const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

export function addMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return isoDate(d);
}

// Valid tooth identifiers: permanent 1-32 (Universal), primary A-T.
export function validTooth(tooth) {
  if (tooth == null) return true;
  const t = String(tooth).toUpperCase();
  if (/^[A-T]$/.test(t)) return true;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 32;
}

export function normalizeSurfaces(surfaces) {
  if (surfaces == null) return null;
  const s = String(surfaces).toUpperCase().replace(/[^MODBLFI]/g, '');
  const unique = [...new Set(s)].join('');
  return unique || null;
}

// Appointment times are stored as practice-local wall-clock strings 'YYYY-MM-DD HH:MM'.
export function localNow(timeZone = 'America/New_York', date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function practiceNow(db, practiceId) {
  const tz = db.get('SELECT timezone FROM practices WHERE id = ?', practiceId)?.timezone;
  return localNow(tz || 'America/New_York');
}

export function normalizeDateTime(value, name) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value ?? ''));
  if (!m) throw new HttpError(400, `${name} must be 'YYYY-MM-DD HH:MM'`);
  return `${m[1]} ${m[2]}`;
}

// Opaque URL tokens: only the SHA-256 hash is stored, so a DB leak doesn't expose live links.
export function newToken() {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
}
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// "Tue, Sep 22 at 9:00 AM" from a practice-local 'YYYY-MM-DD HH:MM'.
export function friendlyDateTime(value) {
  const d = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const [h, m] = value.slice(11, 16).split(':').map(Number);
  return `${day} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
