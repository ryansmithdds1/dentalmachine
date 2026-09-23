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

export async function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return (await db.run(sql, ...keys.map((k) => row[k]))).id;
}

export async function update(db, table, id, practiceId, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND practice_id = ?`;
  return (await db.run(sql, ...keys.map((k) => row[k]), id, practiceId)).changes;
}

// Fetches a row scoped to the caller's practice or 404s. Tenant isolation hinges on this.
export async function findOr404(db, table, id, practiceId, label = table) {
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND practice_id = ?`, Number(id), practiceId);
  if (!row) throw new HttpError(404, `${label} not found`);
  return row;
}

export async function audit(db, req, action, entity, entityId, details) {
  await db.run(
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

// Valid tooth identifiers: permanent 1-32 (Universal), primary A-T, and supernumerary teeth
// (51-82 next to a permanent tooth, AS-TS next to a primary one).
export function validTooth(tooth) {
  if (tooth == null) return true;
  const t = String(tooth).toUpperCase();
  if (/^[A-T]S?$/.test(t)) return true;
  const n = Number(t);
  return Number.isInteger(n) && ((n >= 1 && n <= 32) || (n >= 51 && n <= 82));
}

// Treatment area for codes charted by quadrant or arch.
export const QUADRANTS = ['UR', 'UL', 'LL', 'LR'];
export const ARCHES = ['U', 'L'];
const QUADRANT_CODES = /^D(434[12]|42[0-6]\d)$/;
const ARCH_CODES = /^D(51[1-4]0|52[1-2][1-4]|54[1-2][1-2]|57[3-6]\d|5863|5865)$/;
export function codeArea(code) {
  if (code.area) return code.area;
  if (QUADRANT_CODES.test(code.code)) return 'quadrant';
  if (ARCH_CODES.test(code.code)) return 'arch';
  return code.requires_tooth ? 'tooth' : 'mouth';
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

export async function practiceNow(db, practiceId) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone;
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
export function friendlyDateTime(value, lang = 'en') {
  const d = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  const [h, m] = value.slice(11, 16).split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
  if (lang === 'es') return `${d.toLocaleDateString('es-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}, a las ${time} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day} at ${time} ${h < 12 ? 'AM' : 'PM'}`;
}

// UTC timestamp ('YYYY-MM-DD HH:MM:SS', as SQLite datetime('now') stores) for a practice-local wall-clock time.
// Used to compare created_at-style UTC columns against practice-local date ranges.
export function zonedToUtc(timeZone, date, time = '00:00') {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = localNow(timeZone, guess);
  const offset = Date.parse(`${local.replace(' ', 'T')}:00Z`) - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString().replace('T', ' ').slice(0, 19);
}

// [startUtc, endUtcExclusive] covering practice-local dates from..to inclusive.
export async function utcRange(db, practiceId, from, to) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York';
  const next = new Date(Date.parse(`${to}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  return [zonedToUtc(tz, from), zonedToUtc(tz, next)];
}

// Sequential async map (keeps queries ordered, which matters inside transactions).
export async function mapSeq(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
  return out;
}

// A practice row safe to send to a browser: server-side secrets removed.
export const publicPractice = (p) => (p ? { ...p, sso_client_secret: undefined } : p);
// What non-admin staff see of the practice settings: no sign-on or connection configuration, no message templates.
const STAFF_HIDDEN = ['message_templates', 'stripe_terminal_location'];
export const staffPractice = (p, user) => {
  if (!p || user?.role === 'admin') return publicPractice(p);
  const out = publicPractice(p);
  // Sign-on and connection settings (and the wording of automated messages) are the administrator's business.
  for (const k of Object.keys(out)) if (k.startsWith('sso_') || STAFF_HIDDEN.includes(k)) delete out[k];
  return out;
};

// CSV text for spreadsheet exports (formula-looking cells are neutralised).
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `﻿${[columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, f]) => cell(f(r))).join(','))].join('\r\n')}\r\n`;
}

// Long lists come a page at a time: ?limit (default 200, at most 2000) and ?offset. The full count goes in
// the X-Total-Count header so the screen can offer "show more"; the response body keeps its shape.
export const pageArgs = (req, { dflt = 200, max = 2000 } = {}) => ({
  limit: Math.min(Math.max(Number(req.query.limit) || dflt, 1), max),
  offset: Math.max(Number(req.query.offset) || 0, 0),
});
export function paged(req, res, rows, opts) {
  const { limit, offset } = pageArgs(req, opts);
  res.set('X-Total-Count', String(rows.length));
  return rows.slice(offset, offset + limit);
}
