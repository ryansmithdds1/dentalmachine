// Predictions as staff saw them (docs/predictions.md → "What staff saw"). Each time a no-show or denial percentage is
// served to a person — the schedule, the visit panel, the optimizer, Ready to approve, the claim screen, the
// treatment plan — it is noted in prediction_log, so the accuracy report can compare what the team was actually told
// with what happened, instead of only a backtest.
//
//   - Once per subject, percentage and day: the table's unique key (plus a small memo here) means reopening the
//     schedule all day writes nothing new; a percentage that changes (confirmed, a narrative attached) is a new row.
//   - Cheap: one multi-row INSERT … ON CONFLICT DO NOTHING per screen load, only for what isn't in the memo yet.
//   - Never in the way: written after the response has been sent, never awaited by it. A write that fails is logged,
//     and failures that keep happening become a Needs attention item (resolved by the next write that works).
//   - Derived analytics, not a clinical record: rows are never edited. They are kept (not deleted); see
//     docs/predictions.md for retention.
//   - People only: API keys and requests without a signed-in person aren't "shown to staff".
import { raiseIssue, resolveIssue } from '../issues.js';
import { log } from '../monitoring.js';
import { practiceNow } from '../util.js';
import { MODEL_VERSION } from './builtin.js';
import { outcomeOf, calibrate, addDays } from './noshow.js';
import { lateCancelHours } from '../latecancel.js';

export const LOG_ISSUE_KEY = 'prediction-log';
export const FAILS_BEFORE_ISSUE = 3;
// "What staff saw" is the report's default once this many shown predictions have an outcome in the period.
export const MIN_LOGGED = 30;
export const SUBJECTS = { no_show: ['appointment'], denial: ['procedure', 'claim', 'claim_group'] };

const seen = new Set(); // keys written by this process (the unique key has the last word)
const pending = new Set();
const fails = new Map(); // practice → failures in a row
const flagged = new Set(); // practices this process raised the issue for
const checked = new Set(); // practices whose leftover issue (from before a restart) was looked at once

export const modelVersion = (p) => (!p.driver || p.driver === 'builtin' || p.fallback ? MODEL_VERSION : p.driver);

// Entries for the screens' shapes.
export const noShowEntries = (rows) => rows.filter((a) => a?.no_show_risk).map((a) => ({
  kind: 'no_show', subject_type: 'appointment', subject_id: a.id, location_id: a.location_id ?? null, prediction: a.no_show_risk,
}));
// denial: { claim, lines } (denial.js). claimId for a saved claim; otherwise the claim-level answer is logged against the
// group's first procedure (Ready to approve) — or not at all (the treatment plan, where no claim is being made).
export function denialEntries(denial, { claimId = null, group = false, locationId = null } = {}) {
  if (!denial?.lines?.length) return [];
  const out = denial.lines.map((l) => ({ kind: 'denial', subject_type: 'procedure', subject_id: l.procedure_id, location_id: locationId, prediction: l }));
  if (denial.claim && (claimId || group)) {
    const first = Math.min(...denial.lines.map((l) => Number(l.procedure_id)));
    out.push({ kind: 'denial', subject_type: claimId ? 'claim' : 'claim_group', subject_id: claimId || first, location_id: locationId, prediction: denial.claim });
  }
  return out;
}

// Notes what `req`'s person was shown. Returns the write's promise (callers don't wait for it; tests may).
export function logShown(db, req, entries, screen) {
  const user = req?.user;
  if (!user?.id || user.role === 'api' || !entries?.length) return null;
  const pid = user.practice_id;
  const job = write(db, pid, user.id, entries, screen)
    .then(() => succeeded(db, pid))
    .catch((err) => failedWrite(db, pid, err));
  pending.add(job);
  job.finally(() => pending.delete(job));
  return job;
}

async function write(db, pid, userId, entries, screen) {
  const day = (await practiceNow(db, pid)).slice(0, 10);
  const rows = [];
  const keys = [];
  for (const e of entries) {
    const p = e.prediction;
    const id = Number(e.subject_id);
    if (!p || !Number.isFinite(Number(p.probability)) || !Number.isInteger(id) || id <= 0 || !SUBJECTS[e.kind]?.includes(e.subject_type)) continue;
    const percent = Number.isInteger(p.percent) ? p.percent : Math.round(Number(p.probability) * 100);
    const key = `${pid}|${e.kind}|${e.subject_type}|${id}|${day}|${percent}`;
    if (seen.has(key) || keys.includes(key)) continue;
    keys.push(key);
    rows.push([pid, e.location_id ?? null, e.kind, e.subject_type, id, Number(p.probability), percent, p.confidence ?? null, p.driver ?? 'builtin', modelVersion(p),
      JSON.stringify((p.reasons || []).slice(0, 5)), screen, userId, day]);
  }
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await db.run(
      `INSERT INTO prediction_log (practice_id, location_id, kind, subject_type, subject_id, probability, percent, confidence, driver, model_version, reasons, screen, shown_to, shown_on)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
      ...part.flat(),
    );
  }
  if (seen.size > 50_000) seen.clear();
  for (const k of keys) seen.add(k);
}

async function succeeded(db, pid) {
  fails.delete(pid);
  if (flagged.has(pid) || !checked.has(pid)) {
    flagged.delete(pid);
    checked.add(pid);
    await resolveIssue(db, pid, LOG_ISSUE_KEY, 'Resolved automatically: predictions are being saved again');
  }
}

async function failedWrite(db, pid, err) {
  const n = (fails.get(pid) || 0) + 1;
  fails.set(pid, n);
  log.warn('Prediction log: could not save what staff were shown', { practice_id: pid, error: err?.message || String(err), failures: n });
  if (n >= FAILS_BEFORE_ISSUE && !flagged.has(pid)) {
    flagged.add(pid);
    await raiseIssue(db, {
      practiceId: pid, kind: 'jobs', key: LOG_ISSUE_KEY, role: 'admin', severity: 'normal',
      title: 'Predictions shown to staff aren’t being saved', detail: `${n} tries in a row failed: ${err?.message || err}. The schedule and billing screens still work; Reports → Prediction accuracy can’t add to “What staff saw” until this is fixed.`,
    });
  }
}

// Tests: wait for the writes in flight; forget the memo (a new database in the same process).
export const flushPredictionLog = () => Promise.allSettled([...pending]);
export function resetPredictionLog() { seen.clear(); fails.clear(); flagged.clear(); checked.clear(); }

// ---- Reading it back: what was shown, and what happened ----
const DENIED = `CASE WHEN c.status = 'denied' OR EXISTS (SELECT 1 FROM claim_events e WHERE e.claim_id = c.id AND e.status = 'denied')`;
const ANSWERED = "c.status IN ('paid','partially_paid','denied') AND c.primary_claim_id IS NULL";

// Every logged row for `kind` shown in [from, to] (practice dates), with its subject's outcome: 1 (missed / denied),
// 0 (kept / paid) or null (not known yet: a visit still ahead, an early or office cancellation, a claim not answered).
export async function loggedWithOutcomes(db, pid, kind, { from, to }) {
  const rows = await db.all(
    `SELECT l.*, u.name AS shown_to_name FROM prediction_log l LEFT JOIN users u ON u.id = l.shown_to
     WHERE l.practice_id = ? AND l.kind = ? AND l.shown_on >= ? AND l.shown_on <= ? ORDER BY l.shown_at, l.id`,
    pid, kind, from, to,
  );
  const outcome = new Map(); // `${subject_type}:${id}` → 0 | 1
  const ids = (type) => [...new Set(rows.filter((r) => r.subject_type === type).map((r) => Number(r.subject_id)))];
  const inChunks = async (list, fn) => { for (let i = 0; i < list.length; i += 400) await fn(list.slice(i, i + 400)); };
  const Q = (a) => a.map(() => '?').join(',');
  if (kind === 'no_show') {
    const hours = await lateCancelHours(db, pid);
    await inChunks(ids('appointment'), async (c) => {
      for (const a of await db.all(`SELECT id, status, broken_reason, cancelled_at, start_time FROM appointments WHERE practice_id = ? AND id IN (${Q(c)})`, pid, ...c)) {
        const o = outcomeOf(a, hours);
        if (o) outcome.set(`appointment:${a.id}`, o === 'missed' ? 1 : 0);
      }
    });
  } else {
    await inChunks(ids('procedure'), async (c) => {
      for (const r of await db.all(
        `SELECT ci.procedure_id AS id, MAX(${DENIED} OR (ci.paid_amount = 0 AND ci.estimated_amount > 0) THEN 1 ELSE 0 END) AS denied
         FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.practice_id = ? AND ${ANSWERED} AND ci.procedure_id IN (${Q(c)}) GROUP BY ci.procedure_id`, pid, ...c,
      )) outcome.set(`procedure:${r.id}`, Number(r.denied) ? 1 : 0);
    });
    const claimDenied = `MAX(${DENIED} OR EXISTS (SELECT 1 FROM claim_items x WHERE x.claim_id = c.id AND x.paid_amount = 0 AND x.estimated_amount > 0) THEN 1 ELSE 0 END)`;
    await inChunks(ids('claim'), async (c) => {
      for (const r of await db.all(`SELECT c.id AS id, ${claimDenied} AS denied FROM claims c WHERE c.practice_id = ? AND ${ANSWERED} AND c.id IN (${Q(c)}) GROUP BY c.id`, pid, ...c)) {
        outcome.set(`claim:${r.id}`, Number(r.denied) ? 1 : 0);
      }
    });
    await inChunks(ids('claim_group'), async (c) => {
      for (const r of await db.all(
        `SELECT ci.procedure_id AS id, ${claimDenied} AS denied FROM claim_items ci JOIN claims c ON c.id = ci.claim_id
         WHERE c.practice_id = ? AND ${ANSWERED} AND ci.procedure_id IN (${Q(c)}) GROUP BY ci.procedure_id`, pid, ...c,
      )) outcome.set(`claim_group:${r.id}`, Number(r.denied) ? 1 : 0);
    });
  }
  return rows.map((r) => ({ ...r, outcome: outcome.has(`${r.subject_type}:${r.subject_id}`) ? outcome.get(`${r.subject_type}:${r.subject_id}`) : null }));
}

// "What staff saw": for each subject, the last percentage shown in the period, against what happened.
export async function loggedAccuracy(db, pid, kind, { months = 6, today = null } = {}) {
  today ??= (await practiceNow(db, pid)).slice(0, 10);
  const from = addDays(today, -Math.round(months * 30.44));
  const rows = await loggedWithOutcomes(db, pid, kind, { from, to: today });
  const last = new Map();
  for (const r of rows) if (r.outcome != null) last.set(`${r.subject_type}:${r.subject_id}`, r); // ordered by time: the last wins
  const pairs = (types) => [...last.values()].filter((r) => types.includes(r.subject_type)).map((r) => ({ p: Number(r.probability), y: r.outcome }));
  const main = kind === 'no_show' ? pairs(['appointment']) : pairs(['procedure']);
  const out = { kind, months, from, to: today, source: 'logged', shown: rows.length, ...calibrate(main) };
  if (kind === 'denial') out.claims = calibrate(pairs(['claim', 'claim_group']));
  return out;
}
