import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { currentActor } from './actor.js';

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

// Names (first_name, carrier name, subscriber_name…) are one line of plain text wherever they're saved:
// a newline or control character in one would break a claim file, a label or a CSV.
const NAME_KEY = /(^|_)name$/;
const cleanValue = (k, v) => (typeof v === 'string' && NAME_KEY.test(k) ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : v);

// Records that belong to an office. When the caller doesn't say which, it's the visit's office, else the
// office the person is working in, else the patient's home office.
const LOCATED = new Set(['procedures', 'claims', 'clinical_notes', 'messages', 'calls', 'documents', 'prescriptions', 'ledger_entries']);
async function officeFor(db, row) {
  if (row.appointment_id) {
    const a = await db.get('SELECT location_id FROM appointments WHERE id = ?', row.appointment_id);
    if (a?.location_id) return a.location_id;
  }
  const here = currentActor()?.locationId;
  if (here) return here;
  if (row.patient_id) return (await db.get('SELECT location_id FROM patients WHERE id = ?', row.patient_id))?.location_id ?? null;
  return null;
}

export async function insert(db, table, row) {
  if (LOCATED.has(table) && row.location_id == null && (row.appointment_id || row.patient_id || currentActor()?.locationId)) {
    const office = await officeFor(db, row);
    if (office) row = { ...row, location_id: office };
  }
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const id = (await db.run(sql, ...keys.map((k) => cleanValue(k, row[k])))).id;
  if (CREATED.has(table)) await noteChange(db, table, { ...row, id }, null, row);
  return id;
}

// Updates a row in the caller's practice. What changed (before → after) goes to the audit log.
export async function update(db, table, id, practiceId, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  const before = UNTRACKED.has(table) ? null : await db.get(`SELECT * FROM ${table} WHERE id = ? AND practice_id = ?`, id, practiceId);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND practice_id = ?`;
  const changes = (await db.run(sql, ...keys.map((k) => cleanValue(k, row[k])), id, practiceId)).changes;
  if (before && changes) await noteChange(db, table, before, before, row);
  return changes;
}

// The same, for a row already known to be the caller's (by id alone): status changes, moves, sign-offs.
export async function change(db, table, id, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  const before = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (!before) return 0;
  const n = (await db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cleanValue(k, row[k])), id)).changes;
  if (n) await noteChange(db, table, before, before, row);
  return n;
}

// Runs a raw UPDATE (status moves with datetime('now'), COALESCE…) on one row and records what it changed.
export async function recorded(db, table, id, run) {
  const before = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  const out = await run();
  if (!before) return out;
  const after = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  const patch = {};
  for (const k of Object.keys(after || {})) if (!same(before[k], after[k])) patch[k] = after[k];
  if (Object.keys(patch).length) await noteChange(db, table, before, before, patch);
  return out;
}

// ---- The audit trail ----
// Every create (of the records below) and every update through update()/change() is recorded with the
// fields that changed, before and after, and who or what did it (see actor.js). Routes add the action's
// meaning with audit(); when they do, the changes ride on that entry, otherwise they get their own.
const CREATED = new Set(['patients', 'appointments', 'procedures', 'ledger_entries', 'claims', 'clinical_notes', 'prescriptions', 'treatment_plans', 'patient_insurance',
  'insurance_checks', 'payment_plans', 'tooth_conditions', 'users', 'documents', 'booking_requests', 'lab_cases', 'financing_applications', 'insurance_plans', 'procedure_codes']);
const UNTRACKED = new Set(['audit_log', 'appointment_reminders', 'conversation_state', 'messages', 'calls', 'webhook_deliveries', 'edi_inbox', 'conversion_rows', 'import_batches',
  'scribe_sessions', 'fill_offers', 'fill_offer_recipients', 'review_connections', 'qbo_connections', 'bank_connections', 'bank_transactions', 'qbo_pl', 'qbo_accounts', 'api_keys', 'eligibility_checks']);
const SECRET = /password|token|secret|_hash$|^mfa_|access_key|refresh/i;
// Bookkeeping that changes with every edit says nothing about what changed.
const NOISE = new Set(['updated_at']);
const shown = (k, v) => {
  if (v === undefined) return null;
  if (SECRET.test(k)) return v == null ? null : '[hidden]';
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
};
const same = (a, b) => (a ?? '') === (b ?? '') || String(a ?? '') === String(b ?? '');

async function noteChange(db, table, row, before, patch) {
  const diff = {};
  for (const k of Object.keys(patch)) {
    if (NOISE.has(k)) continue;
    const to = shown(k, typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]);
    const from = before ? shown(k, before[k]) : null;
    if (before && same(from, to)) continue;
    // Secrets are noted as changed, never shown (nor their stored form named).
    diff[SECRET.test(k) ? k.replace(/_hash$|_encrypted$/, '') : k] = before ? [from, to] : to;
  }
  if (!Object.keys(diff).length) return;
  const entry = {
    table, id: row.id, created: !before, changes: diff, practiceId: row.practice_id ?? null,
    patientId: table === 'patients' ? row.id : row.patient_id ?? null, locationId: row.location_id ?? null,
  };
  const ctx = currentActor();
  if (ctx?.pending) {
    const key = `${table}:${row.id}`;
    const had = ctx.pending.get(key);
    if (had) {
      for (const [k, v] of Object.entries(diff)) had.changes[k] = had.created || !had.changes[k] ? v : [had.changes[k][0], v[1]];
    } else ctx.pending.set(key, entry);
    return;
  }
  await writeAudit(db, null, { action: `${SINGULAR(table)}.${entry.created ? 'create' : 'change'}`, entity: table, entityId: row.id, ...entry });
}

const SINGULAR = (t) => ({ patients: 'patient', appointments: 'appointment', procedures: 'procedure', ledger_entries: 'ledger', claims: 'claim', clinical_notes: 'note', prescriptions: 'prescription',
  treatment_plans: 'treatment_plan', patient_insurance: 'insurance', insurance_checks: 'insurance_check', payment_plans: 'payment_plan', tooth_conditions: 'condition', users: 'user',
  documents: 'document', booking_requests: 'booking_request', lab_cases: 'lab_case', insurance_plans: 'insurance_plan', procedure_codes: 'fee' }[t] || t.replace(/s$/, ''));

// Writes what's left of a request's changes (those no route audit took in), just before the response.
export async function flushChanges(db, pending) {
  const left = [...pending.values()];
  for (const e of left) await writeAudit(db, null, { action: `${SINGULAR(e.table)}.${e.created ? 'create' : 'change'}`, entity: e.table, entityId: e.id, ...e });
}

async function writeAudit(db, req, e) {
  const ctx = currentActor();
  const source = e.source || req?.source || (req?.user?.role === 'api' ? 'api' : null) || ctx?.source || (req?.user?.id ? 'human' : 'automation');
  const userId = req?.user?.id ?? (source === 'human' || source === 'ai' ? ctx?.userId ?? null : null);
  await db.run(
    `INSERT INTO audit_log (practice_id, user_id, action, entity, entity_id, details, ip, source, actor, patient_id, location_id, reason, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req?.user?.practice_id ?? e.practiceId ?? ctx?.practiceId ?? null, userId, e.action, e.entity ?? null, e.entityId ?? null,
    e.details ? JSON.stringify(e.details) : null, req?.ip ?? ctx?.ip ?? null, source,
    e.actor || req?.actor || (req?.user?.role === 'api' ? req.user.name : null) || ctx?.actor || req?.user?.name || null,
    e.patientId ?? null, e.locationId ?? req?.location_id ?? null, (e.reason || ctx?.reason) ? String(e.reason || ctx.reason).slice(0, 500) : null,
    e.changes && Object.keys(e.changes).length ? JSON.stringify(e.changes) : null,
  );
}

// Fetches a row scoped to the caller's practice or 404s. Tenant isolation hinges on this.
export async function findOr404(db, table, id, practiceId, label = table) {
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND practice_id = ?`, Number(id), practiceId);
  if (!row) throw new HttpError(404, `${label} not found`);
  return row;
}

// Records an action: who (the signed-in person, or the API key, AI or automation acting — see actor.js),
// what (action, record), where from, why (opts.reason), and the before/after of any fields changed on that
// record during this request. opts: { reason, patientId, locationId, source, actor, before, after }.
export async function audit(db, req, action, entity, entityId, details, opts = {}) {
  const ctx = currentActor();
  const key = `${entity}:${entityId}`;
  const held = ctx?.pending?.get(key);
  if (held) ctx.pending.delete(key);
  let changes = held?.changes || null;
  if (opts.before || opts.after) {
    changes = { ...(changes || {}) };
    for (const k of new Set([...Object.keys(opts.before || {}), ...Object.keys(opts.after || {})])) {
      const from = shown(k, opts.before?.[k]);
      const to = shown(k, opts.after?.[k]);
      if (!same(from, to)) changes[k] = opts.before ? [from, to] : to;
    }
  }
  const reason = opts.reason ?? details?.reason ?? null;
  const patientId = opts.patientId ?? held?.patientId ?? (entity === 'patients' ? entityId : details?.patient_id ?? null);
  await writeAudit(db, req, {
    action, entity, entityId, details, reason, patientId, changes, source: opts.source, actor: opts.actor,
    practiceId: held?.practiceId ?? null, locationId: opts.locationId ?? held?.locationId ?? null,
  });
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
