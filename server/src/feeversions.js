// Fee schedule versions, fee increases and approved PPO updates (backlog FS1–FS3).
//
// The model:
//  - The live fees stay where the rest of the app reads them: `procedure_codes.fee` (the office's standard
//    fees, schedule key 'standard') and `fee_schedule_items` (office and PPO schedules, key 'fs<id>').
//  - Every change to a schedule makes a new, never-edited VERSION (`fee_schedule_versions` + its items): the
//    whole table as it stands from `effective_from`, with who made it, who approved it, the source and a note.
//    The first time a schedule changes, the fees it had until then are kept as a baseline version that counts
//    "from the beginning", so older dates of service keep resolving to what was in effect then.
//  - Planned changes (`fee_changes` + `fee_change_items`) are either % increases or imported payer schedules.
//    They stay editable and cancellable until they take effect. An increase is approved by the person who
//    schedules it (fees:manage); an import is a DRAFT until a person approves it — AI never applies fees.
//    On the effective date (the practice's local midnight) `runFeeJobs` applies each one exactly once.
//  - `resolveFee` is the one way to ask "what was this code's fee on this schedule on this date": estimates
//    and claims use it with the date of service.
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './auth.js';
import { audit, recorded, localNow, MAX_CENTS } from './util.js';
import { toPostgres } from './db.js';
import { recordFeeChange } from './fees.js';
import { requireHuman } from './aiguard.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor, currentActor } from './actor.js';

const currentActorSource = () => currentActor()?.source || 'automation';

// Tables for db.js SCHEMA (kept here too, created on first use, until they're pasted there).
export const FEE_VERSION_SCHEMA = `
-- Every version of every fee schedule, never overwritten. fee_schedule_id NULL = the office's standard fees
-- (procedure_codes); schedule_key ('standard' or 'fs<id>') numbers the versions of one schedule.
CREATE TABLE IF NOT EXISTS fee_schedule_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER REFERENCES fee_schedules(id),
  schedule_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  change_id INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, schedule_key, version_no)
);
CREATE TABLE IF NOT EXISTS fee_schedule_version_items (
  version_id INTEGER NOT NULL REFERENCES fee_schedule_versions(id),
  code TEXT NOT NULL,
  fee INTEGER NOT NULL,
  PRIMARY KEY (version_id, code)
);
-- Planned fee changes: % increases (scheduled or applied now) and imported payer schedules (draft until approved).
CREATE TABLE IF NOT EXISTS fee_changes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER REFERENCES fee_schedules(id),
  schedule_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('increase','import')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','applied','cancelled','rejected')),
  effective_date TEXT,
  params TEXT,
  note TEXT,
  group_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  file_name TEXT,
  file_hash TEXT,
  reader TEXT,
  ai_reason TEXT,
  summary TEXT,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT,
  applied_at TEXT,
  applied_version_id INTEGER REFERENCES fee_schedule_versions(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The lines of a planned change (derived rows: recomputed while the change is still editable).
CREATE TABLE IF NOT EXISTS fee_change_items (
  change_id INTEGER NOT NULL REFERENCES fee_changes(id),
  code TEXT NOT NULL,
  old_fee INTEGER,
  new_fee INTEGER,
  ucr INTEGER,
  flag TEXT,
  warn TEXT,
  skip INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (change_id, code)
);
-- A payer schedule's upload inbox: files dropped here are read into drafts by the fee job (never applied).
CREATE TABLE IF NOT EXISTS fee_import_inbox (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id),
  file_name TEXT NOT NULL,
  mime TEXT,
  file_hash TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processed','failed','duplicate')),
  change_id INTEGER REFERENCES fee_changes(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  UNIQUE (practice_id, fee_schedule_id, file_hash)
);
CREATE INDEX IF NOT EXISTS idx_fee_versions_eff ON fee_schedule_versions(practice_id, schedule_key, effective_from);
CREATE INDEX IF NOT EXISTS idx_fee_changes_status ON fee_changes(status, effective_date);
`;

const ensured = new WeakSet();
export async function ensureFeeSchema(db) {
  if (ensured.has(db)) return;
  const sql = db.dialect === 'postgres' ? toPostgres(FEE_VERSION_SCHEMA).replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY') : FEE_VERSION_SCHEMA;
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await db.run(s);
  ensured.add(db);
}

// "From the beginning": the baseline version covers every date before the first recorded change.
export const BEGINNING = '1900-01-01';
export const scheduleKey = (fsId) => (fsId ? `fs${Number(fsId)}` : 'standard');
export const ROUNDING = { none: 'To the cent', dollar: 'Nearest $1', five: 'Nearest $5', up00: 'Up to the next whole dollar (.00)', up99: 'Up to .99' };
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// Postgres returns no id unless asked; SQLite supports RETURNING too.
const insertId = async (db, sql, ...params) => (await db.get(`${sql} RETURNING id`, ...params)).id;

async function manyRows(db, table, cols, rows) {
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250);
    await db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`, ...chunk.flat());
  }
}

export async function localToday(db, practiceId, now = new Date()) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone;
  return localNow(tz || 'America/New_York', now).slice(0, 10);
}

// The schedule, checked to be this practice's (null = standard fees).
export async function scheduleFor(db, practiceId, fsId) {
  if (fsId == null || fsId === '' || fsId === 'standard') return { id: null, key: 'standard', name: 'Standard office fees', kind: 'standard' };
  const fs = await db.get('SELECT * FROM fee_schedules WHERE id = ? AND practice_id = ?', Number(fsId), practiceId);
  if (!fs) throw new HttpError(404, 'Fee schedule not found');
  return { ...fs, key: scheduleKey(fs.id) };
}

// ---- Reading fees ----
export async function liveItems(db, practiceId, fsId) {
  const rows = fsId
    ? await db.all('SELECT code, fee FROM fee_schedule_items WHERE fee_schedule_id = ? ORDER BY code', fsId)
    : await db.all('SELECT code, fee FROM procedure_codes WHERE practice_id = ? ORDER BY code', practiceId);
  return new Map(rows.map((r) => [r.code, r.fee]));
}

export const currentVersion = (db, practiceId, fsId) => db.get(
  'SELECT * FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? ORDER BY effective_from DESC, version_no DESC LIMIT 1', practiceId, scheduleKey(fsId),
);

// The version in effect on a date (the baseline for dates before every version).
async function versionOn(db, practiceId, fsId, date) {
  const key = scheduleKey(fsId);
  return (await db.get('SELECT * FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? AND effective_from <= ? ORDER BY effective_from DESC, version_no DESC LIMIT 1', practiceId, key, date))
    || db.get('SELECT * FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? ORDER BY effective_from, version_no LIMIT 1', practiceId, key);
}

export async function versionItems(db, versionId) {
  return new Map((await db.all('SELECT code, fee FROM fee_schedule_version_items WHERE version_id = ? ORDER BY code', versionId)).map((r) => [r.code, r.fee]));
}

// THE fee resolver: a code's fee on a schedule (null = standard fees) on a date of service. The current
// version is the live table (what the rest of the app edits); earlier dates read the version in effect then.
// Returns null when the code isn't on that schedule on that date (callers fall back: PPO → office fee).
export async function resolveFee(db, practiceId, fsId, code, date = null) {
  const live = async () => (fsId
    ? (await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fsId, code))?.fee
    : (await db.get('SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, code))?.fee) ?? null;
  const day = date ? String(date).slice(0, 10) : null;
  if (!day) return live();
  const current = await currentVersion(db, practiceId, fsId);
  if (!current || day >= current.effective_from) return live();
  const v = await versionOn(db, practiceId, fsId, day);
  return (await db.get('SELECT fee FROM fee_schedule_version_items WHERE version_id = ? AND code = ?', v.id, code))?.fee ?? null;
}

// The whole table in effect on a date.
export async function tableOn(db, practiceId, fsId, date) {
  const current = await currentVersion(db, practiceId, fsId);
  if (!current || !date || date >= current.effective_from) return liveItems(db, practiceId, fsId);
  return versionItems(db, (await versionOn(db, practiceId, fsId, date)).id);
}

// ---- Writing versions ----
async function createVersion(db, { practiceId, fsId, effectiveFrom, source, note = null, items, changeId = null, createdBy = null, approvedBy = null, actorSource = null }) {
  const key = scheduleKey(fsId);
  const last = await db.get('SELECT MAX(version_no) AS n FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ?', practiceId, key);
  const id = await insertId(db,
    `INSERT INTO fee_schedule_versions (practice_id, fee_schedule_id, schedule_key, version_no, effective_from, source, note, change_id, item_count, created_by, approved_by, actor_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    practiceId, fsId || null, key, (last?.n || 0) + 1, effectiveFrom, source, note ? String(note).slice(0, 500) : null, changeId, items.size, createdBy, approvedBy, actorSource);
  await manyRows(db, 'fee_schedule_version_items', ['version_id', 'code', 'fee'], [...items].map(([c, f]) => [id, c, f]));
  return id;
}

// Before the first change, the fees as they were become version 1 ("from the beginning"). `overrides`
// restores values a caller has already changed (code → fee before the change; null = wasn't there).
export async function ensureBaseline(db, practiceId, fsId, { overrides = null, createdBy = null } = {}) {
  await ensureFeeSchema(db);
  const has = await db.get('SELECT id FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? LIMIT 1', practiceId, scheduleKey(fsId));
  if (has) return has.id;
  const items = await liveItems(db, practiceId, fsId);
  for (const [c, f] of Object.entries(overrides || {})) {
    if (f == null) items.delete(c);
    else items.set(c, f);
  }
  // A schedule that had no fees yet has nothing to keep: its first version counts from the beginning.
  if (!items.size) return null;
  return createVersion(db, { practiceId, fsId, effectiveFrom: BEGINNING, source: 'baseline', note: 'Fees as they were before version history started', items, createdBy, actorSource: 'automation' });
}

// A hand edit (Settings → fee schedules, procedure codes, group copy) already written to the live table:
// kept as a new version effective today. Call ensureBaseline (with the old values) before editing.
// effectiveFrom: a correction can count from an earlier date (never before the current version's).
export async function snapshotVersion(db, { practiceId, fsId, source = 'manual', note = null, userId = null, effectiveFrom = null }) {
  await ensureFeeSchema(db);
  const items = await liveItems(db, practiceId, fsId);
  const cur = await currentVersion(db, practiceId, fsId);
  if (cur) {
    const prev = await versionItems(db, cur.id);
    if (prev.size === items.size && [...items].every(([c, f]) => prev.get(c) === f)) return cur.id; // nothing changed
  }
  if (!cur && !items.size) return null;
  const today = await localToday(db, practiceId);
  let from = cur ? effectiveFrom || today : BEGINNING;
  if (cur && from < cur.effective_from) from = cur.effective_from;
  return createVersion(db, { practiceId, fsId, effectiveFrom: from, source: cur ? source : 'created', note, items, createdBy: userId, approvedBy: userId, actorSource: currentActorSource() });
}

// Makes the live table equal `target` (a PPO/office schedule's rows can be removed; standard fees only change
// on codes the office has). Each change goes to fee_history, procedure_codes changes through recorded().
async function writeLive(db, practiceId, fsId, target, userId) {
  const before = await liveItems(db, practiceId, fsId);
  const changed = [];
  for (const [code, fee] of target) {
    const old = before.get(code);
    if (old === fee) continue;
    if (fsId) {
      await db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?) ON CONFLICT(fee_schedule_id, code) DO UPDATE SET fee = excluded.fee', fsId, code, fee);
    } else {
      const row = await db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, code);
      if (!row) continue;
      await recorded(db, 'procedure_codes', row.id, () => db.run('UPDATE procedure_codes SET fee = ? WHERE id = ?', fee, row.id));
    }
    await recordFeeChange(db, { practiceId, scheduleId: fsId || null, code, oldFee: old ?? null, newFee: fee, userId });
    changed.push({ code, old_fee: old ?? null, new_fee: fee });
  }
  if (fsId) {
    for (const [code, old] of before) {
      if (target.has(code)) continue;
      // A schedule row (configuration) leaving the payer's schedule; kept in the older versions and audited.
      await db.run('DELETE FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fsId, code);
      await recordFeeChange(db, { practiceId, scheduleId: fsId, code, oldFee: old, newFee: null, userId });
      changed.push({ code, old_fee: old, new_fee: null });
    }
  }
  return changed;
}

// ---- % increases ----
export function roundFee(cents, mode) {
  if (mode === 'dollar') return Math.round(cents / 100) * 100;
  if (mode === 'five') return Math.round(cents / 500) * 500;
  if (mode === 'up00') return Math.ceil(cents / 100) * 100;
  if (mode === 'up99') return Math.ceil((cents + 1) / 100) * 100 - 1;
  return Math.round(cents);
}
export function increaseFee(fee, percent, rounding) {
  if (!fee) return fee;
  return Math.max(0, roundFee(Math.round((fee * (100 + percent)) / 100), rounding));
}

const codeMatch = (code, list) => (list || []).some((p) => (p.endsWith('*') ? code.startsWith(p.slice(0, -1)) : code === p));

// Validates and normalizes the increase rule from a request.
export function increaseParams(body = {}) {
  const percent = Number(body.percent);
  if (!Number.isFinite(percent) || percent === 0 || percent < -50 || percent > 100) throw new HttpError(400, 'percent must be a number between -50 and 100 (not 0)');
  const rounding = body.rounding || 'none';
  if (!(rounding in ROUNDING)) throw new HttpError(400, `rounding must be one of ${Object.keys(ROUNDING).join(', ')}`);
  const s = body.scope || {};
  const mode = s.mode || 'all';
  if (!['all', 'categories', 'codes'].includes(mode)) throw new HttpError(400, 'scope.mode must be all, categories or codes');
  const codes = (list) => (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  const scope = { mode, categories: Array.isArray(s.categories) ? s.categories : [], codes: codes(s.codes), exclude: codes(s.exclude) };
  for (const c of [...scope.codes, ...scope.exclude]) if (!/^D\d{4}$|^D\d{0,3}\*$/.test(c)) throw new HttpError(400, `${c.slice(0, 12)} isn't a CDT code (D1234) or a prefix (D27*)`);
  for (const c of scope.categories) if (!CATEGORIES.includes(c)) throw new HttpError(400, `Unknown category ${String(c).slice(0, 20)}`);
  if (mode === 'categories' && !scope.categories.length) throw new HttpError(400, 'Choose at least one category');
  if (mode === 'codes' && !scope.codes.length) throw new HttpError(400, 'List at least one code');
  return { percent, rounding, scope };
}

// How often each code was done in the last 12 months where this schedule set the price (an estimate of impact).
async function usage(db, practiceId, fsId, kind, today) {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86400_000).toISOString().slice(0, 10);
  let rows;
  if (!fsId) {
    rows = await db.all("SELECT code, COUNT(*) AS n FROM procedures WHERE practice_id = ? AND status = 'completed' AND completed_at >= ? GROUP BY code", practiceId, since);
  } else if (kind === 'office') {
    rows = await db.all(
      `SELECT pr.code, COUNT(*) AS n FROM procedures pr JOIN patients p ON p.id = pr.patient_id LEFT JOIN providers pv ON pv.id = pr.provider_id LEFT JOIN locations l ON l.id = pr.location_id
       WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND (p.fee_schedule_id = ? OR pv.fee_schedule_id = ? OR l.fee_schedule_id = ?) GROUP BY pr.code`,
      practiceId, since, fsId, fsId, fsId);
  } else {
    rows = await db.all(
      `SELECT pr.code, COUNT(DISTINCT pr.id) AS n FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id
       JOIN patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_plans ip ON ip.id = pi.plan_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.practice_id = ? AND c.status != 'void' AND pr.completed_at >= ? AND COALESCE(ip.fee_schedule_id, ic.fee_schedule_id) = ? GROUP BY pr.code`,
      practiceId, since, fsId);
  }
  return new Map(rows.map((r) => [r.code, Number(r.n)]));
}

// Old vs new for one schedule, with what it would have meant over the last 12 months.
export async function previewIncrease(db, practiceId, schedule, params, { date = null } = {}) {
  const today = await localToday(db, practiceId);
  const base = await tableOn(db, practiceId, schedule.id, date || today);
  const info = new Map((await db.all('SELECT code, description, category FROM procedure_codes WHERE practice_id = ?', practiceId)).map((r) => [r.code, r]));
  const used = await usage(db, practiceId, schedule.id, schedule.kind, today);
  const rows = [];
  for (const [code, fee] of base) {
    const c = info.get(code);
    const category = c?.category || null;
    const { scope } = params;
    if (codeMatch(code, scope.exclude)) continue;
    if (scope.mode === 'categories' && !scope.categories.includes(category)) continue;
    if (scope.mode === 'codes' && !codeMatch(code, scope.codes)) continue;
    const next = increaseFee(fee, params.percent, params.rounding);
    const n = used.get(code) || 0;
    rows.push({ code, description: c?.description || null, category, old_fee: fee, new_fee: next, change: next - fee, used_12m: n, impact_12m: n * (next - fee) });
  }
  const changed = rows.filter((r) => r.change !== 0);
  const sum = (k, list = rows) => list.reduce((s, r) => s + r[k], 0);
  return {
    schedule: { id: schedule.id, key: schedule.key, name: schedule.name, kind: schedule.kind },
    rows,
    summary: {
      codes: rows.length, changed: changed.length,
      old_total: sum('old_fee'), new_total: sum('new_fee'),
      procedures_12m: sum('used_12m'),
      production_12m: rows.reduce((s, r) => s + r.used_12m * r.old_fee, 0),
      impact_12m: sum('impact_12m'),
    },
  };
}

// ---- Planned changes ----
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export async function changeView(db, change, { items = true } = {}) {
  if (!change) return change;
  const fs = change.fee_schedule_id ? await db.get('SELECT name, kind FROM fee_schedules WHERE id = ?', change.fee_schedule_id) : { name: 'Standard office fees', kind: 'standard' };
  const names = new Map((await db.all('SELECT id, name FROM users WHERE practice_id = ?', change.practice_id)).map((u) => [u.id, u.name]));
  const out = {
    ...change, params: parse(change.params, {}), summary: parse(change.summary, {}), schedule_name: fs?.name, schedule_kind: fs?.kind,
    created_by_name: names.get(change.created_by) || null, approved_by_name: names.get(change.approved_by) || null, cancelled_by_name: names.get(change.cancelled_by) || null,
  };
  if (items) {
    const desc = new Map((await db.all('SELECT code, description FROM procedure_codes WHERE practice_id = ?', change.practice_id)).map((r) => [r.code, r.description]));
    out.items = (await db.all('SELECT * FROM fee_change_items WHERE change_id = ? ORDER BY code', change.id)).map((i) => ({
      ...i, description: desc.get(i.code) || null,
      change: i.new_fee != null && i.old_fee != null ? i.new_fee - i.old_fee : null,
      pct: i.new_fee != null && i.old_fee ? Math.round(((i.new_fee - i.old_fee) / i.old_fee) * 1000) / 10 : null,
    }));
  }
  return out;
}

async function writeIncreaseItems(db, changeId, preview) {
  await db.run('DELETE FROM fee_change_items WHERE change_id = ?', changeId); // derived preview rows, recomputed
  await manyRows(db, 'fee_change_items', ['change_id', 'code', 'old_fee', 'new_fee', 'flag'], preview.rows.filter((r) => r.change !== 0).map((r) => [changeId, r.code, r.old_fee, r.new_fee, 'changed']));
}

export function requireDay(value, name = 'date') {
  if (!isDate(value)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return value;
}

export function checkEffectiveDate(value, today, { allowPast = true } = {}) {
  const d = value || today;
  if (!isDate(d)) throw new HttpError(400, 'effective_date must be a real date (YYYY-MM-DD)');
  if (!allowPast && d < today) throw new HttpError(400, 'A fee increase can start today or later, not in the past');
  if (d > `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`) throw new HttpError(400, 'effective_date is more than 3 years away');
  return d;
}

// A % increase on one schedule: scheduled for its date, or applied now when that's today.
export async function scheduleIncrease(db, { practiceId, schedule, params, effectiveDate, note = null, userId, groupId = null }) {
  requireHuman('changing fees');
  await ensureFeeSchema(db);
  const today = await localToday(db, practiceId);
  const preview = await previewIncrease(db, practiceId, schedule, params, { date: effectiveDate });
  if (!preview.summary.changed) throw new HttpError(400, `Nothing would change on ${schedule.name}`);
  const id = await db.tx(async () => {
    const cid = await insertId(db,
      `INSERT INTO fee_changes (practice_id, fee_schedule_id, schedule_key, kind, status, effective_date, params, note, group_id, source, summary, created_by, approved_by, approved_at)
       VALUES (?, ?, ?, 'increase', 'scheduled', ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      practiceId, schedule.id, schedule.key, effectiveDate, JSON.stringify(params), note, groupId, JSON.stringify(preview.summary), userId, userId, new Date().toISOString());
    await writeIncreaseItems(db, cid, preview);
    return cid;
  });
  await audit(db, null, 'fee_change.scheduled', 'fee_changes', id, { schedule: schedule.name, effective_date: effectiveDate, ...params, changed: preview.summary.changed, impact_12m: preview.summary.impact_12m }, { reason: note });
  let applied = null;
  if (effectiveDate <= today) applied = await applyChange(db, id);
  return { id, applied };
}

// Editing a change that hasn't taken effect: the rule and date of an increase; the date, note, lines left
// out and whether missing codes are dropped for an import.
export async function editChange(db, change, body, userId) {
  requireHuman('changing fees');
  if (!['draft', 'scheduled'].includes(change.status)) throw new HttpError(409, `This change is already ${change.status}`);
  const today = await localToday(db, change.practice_id);
  const before = { effective_date: change.effective_date, params: change.params, note: change.note };
  const patch = {};
  if ('effective_date' in body) patch.effective_date = checkEffectiveDate(body.effective_date, today, { allowPast: change.kind === 'import' });
  if ('note' in body) patch.note = body.note ? String(body.note).slice(0, 500) : null;
  const schedule = await scheduleFor(db, change.practice_id, change.fee_schedule_id);
  await db.tx(async () => {
    if (change.kind === 'increase') {
      const params = ['percent', 'rounding', 'scope'].some((k) => k in body) ? increaseParams({ ...parse(change.params, {}), ...body }) : parse(change.params, {});
      const preview = await previewIncrease(db, change.practice_id, schedule, params, { date: patch.effective_date || change.effective_date });
      if (!preview.summary.changed) throw new HttpError(400, `Nothing would change on ${schedule.name}`);
      patch.params = JSON.stringify(params);
      patch.summary = JSON.stringify(preview.summary);
      await writeIncreaseItems(db, change.id, preview);
    } else {
      const params = { ...parse(change.params, {}) };
      if ('drop_missing' in body) params.drop_missing = !!body.drop_missing;
      patch.params = JSON.stringify(params);
      if (Array.isArray(body.skip_codes)) {
        const skip = new Set(body.skip_codes.map((c) => String(c).toUpperCase()));
        await db.run('UPDATE fee_change_items SET skip = 0 WHERE change_id = ?', change.id);
        for (const c of skip) await db.run('UPDATE fee_change_items SET skip = 1 WHERE change_id = ? AND code = ?', change.id, c);
      }
    }
    const keys = Object.keys(patch);
    if (keys.length) await db.run(`UPDATE fee_changes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), change.id);
  });
  const after = await db.get('SELECT * FROM fee_changes WHERE id = ?', change.id);
  await audit(db, null, 'fee_change.edit', 'fee_changes', change.id, { schedule: schedule.name }, {
    before, after: { effective_date: after.effective_date, params: after.params, note: after.note }, reason: body.change_reason || null,
  });
  if (after.status === 'scheduled' && after.effective_date <= today) await applyChange(db, after.id);
  return db.get('SELECT * FROM fee_changes WHERE id = ?', change.id);
}

// An imported schedule approved by a person (fees:manage): scheduled for its date, or applied now.
export async function approveImport(db, change, body, userId) {
  requireHuman('approving a fee schedule');
  if (change.kind !== 'import') throw new HttpError(400, 'Only imported schedules need approval');
  if (change.status !== 'draft') throw new HttpError(409, `This import is already ${change.status}`);
  const today = await localToday(db, change.practice_id);
  const effective = checkEffectiveDate(body.effective_date || change.effective_date, today);
  const params = { ...parse(change.params, {}), drop_missing: !!body.drop_missing };
  const claim = await db.tx(async () => {
    const r = await db.run("UPDATE fee_changes SET status = 'scheduled', effective_date = ?, params = ?, note = COALESCE(?, note), approved_by = ?, approved_at = ? WHERE id = ? AND status = 'draft'",
      effective, JSON.stringify(params), body.note ? String(body.note).slice(0, 500) : null, userId, new Date().toISOString(), change.id);
    if (!r.changes) return false;
    if (Array.isArray(body.skip_codes)) {
      for (const c of body.skip_codes) await db.run('UPDATE fee_change_items SET skip = 1 WHERE change_id = ? AND code = ?', change.id, String(c).toUpperCase());
    }
    return true;
  });
  if (!claim) throw new HttpError(409, 'This import was just approved or cancelled by someone else');
  const counts = await db.get("SELECT SUM(CASE WHEN skip = 0 AND flag IN ('new','changed') THEN 1 ELSE 0 END) AS applying, SUM(skip) AS skipped FROM fee_change_items WHERE change_id = ?", change.id);
  await audit(db, null, 'fee_import.approved', 'fee_changes', change.id, { effective_date: effective, drop_missing: params.drop_missing, applying: Number(counts?.applying || 0), skipped: Number(counts?.skipped || 0) }, { reason: body.note || null });
  await resolveIssue(db, change.practice_id, `fee-import-review:${change.id}`, 'Approved');
  let applied = null;
  if (effective <= today) applied = await applyChange(db, change.id);
  return { applied, effective_date: effective };
}

export async function cancelChange(db, change, { reason = null, userId }) {
  requireHuman('changing fees');
  if (!['draft', 'scheduled'].includes(change.status)) throw new HttpError(409, `This change is already ${change.status}`);
  const to = change.status === 'draft' ? 'rejected' : 'cancelled';
  const r = await db.run('UPDATE fee_changes SET status = ?, cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status = ?',
    to, userId, new Date().toISOString(), reason ? String(reason).slice(0, 500) : null, change.id, change.status);
  if (!r.changes) throw new HttpError(409, 'This change was just applied or cancelled by someone else');
  await audit(db, null, `fee_change.${to}`, 'fee_changes', change.id, { kind: change.kind, effective_date: change.effective_date }, { before: { status: change.status }, after: { status: to }, reason });
  await resolveIssue(db, change.practice_id, `fee-import-review:${change.id}`, to === 'rejected' ? 'Rejected' : 'Cancelled');
  await resolveIssue(db, change.practice_id, `fee-change:${change.id}`, 'Cancelled');
  return to;
}

// Applies a scheduled change once: a new version, and (when it's the newest by date) the live fees. The
// status flip is the claim, inside the transaction, so a second run (another server, a retry) does nothing.
export async function applyChange(db, changeId, { now = new Date() } = {}) {
  requireHuman('changing fees');
  await ensureFeeSchema(db);
  return db.tx(async () => {
    const claim = await db.run("UPDATE fee_changes SET status = 'applied', applied_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND status = 'scheduled'", now.toISOString(), changeId);
    if (!claim.changes) return null;
    const ch = await db.get('SELECT * FROM fee_changes WHERE id = ?', changeId);
    const pid = ch.practice_id;
    const fsId = ch.fee_schedule_id || null;
    const params = parse(ch.params, {});
    await ensureBaseline(db, pid, fsId, { createdBy: ch.created_by });
    const base = await tableOn(db, pid, fsId, ch.effective_date);
    const target = new Map(base);
    let recalculated = 0;
    if (ch.kind === 'increase') {
      // Worked out again from the fees in effect on the day, so a fee edited since scheduling isn't lost.
      const planned = new Map((await db.all('SELECT code, new_fee FROM fee_change_items WHERE change_id = ?', ch.id)).map((r) => [r.code, r.new_fee]));
      const schedule = await scheduleFor(db, pid, fsId);
      const preview = await previewIncrease(db, pid, schedule, params, { date: ch.effective_date });
      for (const r of preview.rows) {
        if (r.change === 0) continue;
        target.set(r.code, r.new_fee);
        if (planned.get(r.code) !== r.new_fee) recalculated++;
      }
    } else {
      const items = await db.all('SELECT * FROM fee_change_items WHERE change_id = ?', ch.id);
      for (const i of items) if (!i.skip && i.new_fee != null) target.set(i.code, i.new_fee);
      if (params.drop_missing) for (const i of items) if (!i.skip && i.flag === 'missing') target.delete(i.code);
    }
    const current = await currentVersion(db, pid, fsId);
    const isCurrent = !current || ch.effective_date >= current.effective_from;
    const note = [ch.note, recalculated ? `${recalculated} fee(s) worked out again: they changed after this was scheduled` : null].filter(Boolean).join(' · ') || null;
    const versionId = await createVersion(db, {
      practiceId: pid, fsId, effectiveFrom: ch.effective_date, source: ch.kind === 'increase' ? `increase ${params.percent > 0 ? '+' : ''}${params.percent}%` : ch.reader === 'ai' ? 'import (AI read)' : 'import',
      note, items: target, changeId: ch.id, createdBy: ch.created_by, approvedBy: ch.approved_by, actorSource: 'human',
    });
    const changed = isCurrent ? await writeLive(db, pid, fsId, target, ch.approved_by) : [];
    await db.run('UPDATE fee_changes SET applied_version_id = ? WHERE id = ?', versionId, ch.id);
    const shown = changed.slice(0, 400);
    await audit(db, null, 'fee_schedule.version_applied', 'fee_schedule_versions', versionId, {
      change_id: ch.id, kind: ch.kind, fee_schedule_id: fsId, effective_from: ch.effective_date, changed: changed.length, recalculated,
      scheduled_by: ch.created_by, approved_by: ch.approved_by, live: isCurrent,
    }, {
      before: Object.fromEntries(shown.map((c) => [c.code, c.old_fee])), after: Object.fromEntries(shown.map((c) => [c.code, c.new_fee])),
      reason: ch.note || null,
    });
    return { version_id: versionId, changed: changed.length, live: isCurrent, recalculated };
  });
}

// ---- Imports ----
// Classifies an imported schedule against what's on file: new, changed ($ and %), same, missing, and values
// that look wrong next to the office's own fee (UCR): over 3× or under a third.
export function classify(doc, current, ucr) {
  const rows = [];
  for (const [code, fee] of doc) {
    const old = current.get(code);
    const u = ucr.get(code);
    let warn = null;
    if (u == null) warn = 'unknown_code';
    else if (u > 0 && fee > u * 3) warn = 'high';
    else if (u > 0 && fee * 3 < u) warn = 'low';
    rows.push({ code, old_fee: old ?? null, new_fee: fee, ucr: u ?? null, flag: old == null ? 'new' : old === fee ? 'same' : 'changed', warn });
  }
  for (const [code, old] of current) if (!doc.has(code)) rows.push({ code, old_fee: old, new_fee: null, ucr: ucr.get(code) ?? null, flag: 'missing', warn: null });
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const count = (f) => rows.filter((r) => r.flag === f).length;
  return { rows, summary: { codes: doc.size, new: count('new'), changed: count('changed'), same: count('same'), missing: count('missing'), suspicious: rows.filter((r) => r.warn === 'high' || r.warn === 'low').length, unknown: rows.filter((r) => r.warn === 'unknown_code').length } };
}

export const fileHash = (text) => createHash('sha256').update(String(text)).digest('hex');

// Reads a payer's schedule (CSV, XLSX, or a PDF through the AI reader) into a DRAFT awaiting approval.
export async function createImportDraft(db, { practiceId, schedule, file, reader, source = 'upload', userId = null, effectiveDate = null }) {
  await ensureFeeSchema(db);
  if (!schedule.id) throw new HttpError(400, 'Imports update an office or insurance fee schedule; use a % increase for the standard fees');
  const hash = fileHash(file.text ?? file.base64 ?? '');
  const dup = await db.get("SELECT id FROM fee_changes WHERE practice_id = ? AND fee_schedule_id = ? AND file_hash = ? AND status IN ('draft','scheduled','applied')", practiceId, schedule.id, hash);
  if (dup) return { id: dup.id, duplicate: true };
  const read = await reader.read(file);
  const doc = new Map();
  const warnings = [...(read.warnings || [])];
  for (const it of read.items || []) {
    const code = String(it.code || '').trim().toUpperCase();
    const fee = Math.round(Number(it.fee));
    if (!/^D\d{4}$/.test(code)) { warnings.push(`Skipped "${String(it.code).slice(0, 12)}": not a CDT code`); continue; }
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_CENTS) { warnings.push(`Skipped ${code}: the fee isn't a real amount`); continue; }
    if (doc.has(code) && doc.get(code) !== fee) warnings.push(`${code} appears twice; the last value was kept`);
    doc.set(code, fee);
  }
  if (!doc.size) throw new HttpError(422, 'No codes and fees were found in that file. A CSV or spreadsheet needs a code column and a fee column.');
  const today = await localToday(db, practiceId);
  const eff = effectiveDate || (isDate(read.effective_date) ? read.effective_date : null);
  const current = await liveItems(db, practiceId, schedule.id);
  const ucr = await liveItems(db, practiceId, null);
  const { rows, summary } = classify(doc, current, ucr);
  summary.warnings = warnings.slice(0, 50);
  if (read.payer_name) summary.payer_name = String(read.payer_name).slice(0, 120);
  const ai = read.reader === 'ai' || read.reader === 'sandbox';
  const id = await db.tx(async () => {
    const cid = await insertId(db,
      `INSERT INTO fee_changes (practice_id, fee_schedule_id, schedule_key, kind, status, effective_date, params, source, file_name, file_hash, reader, ai_reason, summary, created_by)
       VALUES (?, ?, ?, 'import', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      practiceId, schedule.id, schedule.key, eff && eff >= '2000-01-01' ? eff : today, JSON.stringify({ drop_missing: false }), source,
      String(file.name || 'schedule').slice(0, 200), hash, read.reader, read.reason ? String(read.reason).slice(0, 500) : null, JSON.stringify(summary), userId);
    await manyRows(db, 'fee_change_items', ['change_id', 'code', 'old_fee', 'new_fee', 'ucr', 'flag', 'warn', 'skip'],
      rows.map((r) => [cid, r.code, r.old_fee, r.new_fee, r.ucr, r.flag, r.warn, 0]));
    return cid;
  });
  await audit(db, null, 'fee_import.draft', 'fee_changes', id, { schedule: schedule.name, file: file.name || null, reader: read.reader, ...summary, warnings: undefined }, {
    ...(ai ? { source: 'ai', actor: read.reader === 'sandbox' ? 'Fee schedule reader (sandbox)' : 'AI fee schedule reader' } : {}), reason: read.reason || null,
  });
  return { id, duplicate: false, summary };
}

// ---- The job ----
// Every few minutes: scheduled changes due by each practice's local date are applied (once), and files
// waiting in a schedule's inbox are read into drafts. Failures become Needs attention items.
export async function runFeeJobs(db, { reader = null, now = new Date() } = {}) {
  await ensureFeeSchema(db);
  const out = { applied: [], drafts: [], failed: [] };
  const due = await db.all(
    `SELECT fc.id, fc.practice_id, fc.effective_date, fc.fee_schedule_id, p.timezone FROM fee_changes fc JOIN practices p ON p.id = fc.practice_id
     WHERE fc.status = 'scheduled' ORDER BY fc.effective_date, fc.id`);
  for (const d of due) {
    if (d.effective_date > localNow(d.timezone || 'America/New_York', now).slice(0, 10)) continue;
    await withActor({ source: 'automation', actor: 'Scheduled fee change', practiceId: d.practice_id, userId: null }, async () => {
      try {
        const r = await applyChange(db, d.id, { now });
        if (r) out.applied.push({ id: d.id, ...r });
        await resolveIssue(db, d.practice_id, `fee-change:${d.id}`);
      } catch (err) {
        out.failed.push({ id: d.id, error: err.message });
        await db.run('UPDATE fee_changes SET attempts = attempts + 1, last_error = ? WHERE id = ?', String(err.message).slice(0, 500), d.id);
        const name = d.fee_schedule_id ? (await db.get('SELECT name FROM fee_schedules WHERE id = ?', d.fee_schedule_id))?.name : 'Standard office fees';
        await raiseIssue(db, {
          practiceId: d.practice_id, kind: 'records', key: `fee-change:${d.id}`, severity: 'high', role: 'admin', entity: 'fee_changes', entityId: d.id,
          title: `A scheduled fee change for ${name} (from ${d.effective_date}) didn’t apply — fees are unchanged`, detail: err.message,
        });
      }
    });
  }
  if (reader) {
    const waiting = await db.all("SELECT * FROM fee_import_inbox WHERE status = 'waiting' AND attempts < 5 ORDER BY id LIMIT 20");
    for (const f of waiting) {
      await withActor({ source: 'automation', actor: 'Fee schedule inbox', practiceId: f.practice_id, userId: null }, async () => {
        try {
          const schedule = await scheduleFor(db, f.practice_id, f.fee_schedule_id);
          const isText = /^text\//.test(f.mime || '') || /\.csv$/i.test(f.file_name);
          const r = await createImportDraft(db, {
            practiceId: f.practice_id, schedule, reader, source: 'inbox', userId: f.created_by,
            file: { name: f.file_name, mime: f.mime, ...(isText ? { text: Buffer.from(f.content || '', 'base64').toString('utf8') } : { base64: f.content }) },
          });
          // The file's content is scratch once read (the draft and its lines are kept).
          await db.run("UPDATE fee_import_inbox SET status = ?, change_id = ?, content = NULL, processed_at = ?, error = NULL WHERE id = ?", r.duplicate ? 'duplicate' : 'processed', r.id, now.toISOString(), f.id);
          await resolveIssue(db, f.practice_id, `fee-inbox:${f.id}`);
          if (!r.duplicate) {
            out.drafts.push(r.id);
            await raiseIssue(db, {
              practiceId: f.practice_id, kind: 'import', key: `fee-import-review:${r.id}`, role: 'admin', entity: 'fee_changes', entityId: r.id,
              title: `${schedule.name}: a new fee schedule (${f.file_name}) is ready to review and approve`,
              detail: `${r.summary.changed} changed, ${r.summary.new} new, ${r.summary.missing} missing, ${r.summary.suspicious} to check. Nothing changes until someone approves it.`,
            });
          }
        } catch (err) {
          const attempts = f.attempts + 1;
          await db.run('UPDATE fee_import_inbox SET attempts = ?, error = ?, status = ? WHERE id = ?', attempts, String(err.message).slice(0, 500), attempts >= 5 || err.status === 422 ? 'failed' : 'waiting', f.id);
          out.failed.push({ inbox: f.id, error: err.message });
          await raiseIssue(db, {
            practiceId: f.practice_id, kind: 'import', key: `fee-inbox:${f.id}`, role: 'admin', entity: 'fee_import_inbox', entityId: f.id,
            title: `A fee schedule file (${f.file_name}) couldn’t be read`, detail: err.message,
          });
        }
      });
    }
  }
  return out;
}

export const newGroupId = () => randomUUID();
