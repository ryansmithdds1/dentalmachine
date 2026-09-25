import { currentActor } from './actor.js';
import { log, scrubMessage } from './monitoring.js';
import { publish } from './events.js';

// "Needs attention": when something important fails — a claim the clearinghouse rejected, a text that didn't
// go, an ERA line that matched nothing, a sync or an AI step that broke — it becomes a work item here with
// who should look at it, instead of only a line in a log. The same problem happening again counts up on
// the open item rather than making a new one; when it's fixed (by a person, or by the next attempt
// succeeding) it's resolved with a note.
export const ISSUE_KINDS = {
  claim: 'Claims', era: 'Insurance payments', eligibility: 'Eligibility', payment: 'Card payments', message: 'Texts and email',
  import: 'Data import', imaging: 'Imaging', ai: 'AI', integration: 'Connections', sync: 'Bank, books and reviews', schedule: 'Scheduling', records: 'Records', phones: 'Phones',
  jobs: 'Background work',
};
export const ROLES = { billing: 'Billing', front_desk: 'Front desk', clinical: 'Clinical', admin: 'Administrator' };

// key: what makes two failures "the same problem" (e.g. `claim-rejected:123`).
export async function raiseIssue(db, { practiceId, kind, key, title, detail = null, severity = 'normal', role = 'admin', entity = null, entityId = null, patientId = null }) {
  if (!practiceId) {
    log.error('Unassigned failure', { kind, title });
    return null;
  }
  try {
    const open = await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", practiceId, key);
    const text = detail ? scrubMessage(String(detail)).slice(0, 1000) : null;
    if (open) {
      await db.run("UPDATE issues SET occurrences = occurrences + 1, last_seen = datetime('now'), detail = COALESCE(?, detail), title = ? WHERE id = ?", text, String(title).slice(0, 300), open.id);
      return open.id;
    }
    const { id } = await db.run(
      `INSERT INTO issues (practice_id, kind, dedupe_key, title, detail, severity, role, entity, entity_id, patient_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      practiceId, kind, key, String(title).slice(0, 300), text, severity, role, entity, entityId, patientId, currentActor()?.source || 'automation',
    );
    publish(practiceId, { type: 'issues' });
    return id;
  } catch (err) {
    // The last line of defence: the failure to record a failure is itself logged loudly.
    log.error('Could not record a failure', err, { kind, title });
    return null;
  }
}

// The problem went away (a later attempt worked): close it with a note.
export async function resolveIssue(db, practiceId, key, note = 'Resolved automatically: it worked on a later attempt') {
  const r = await db.run("UPDATE issues SET status = 'resolved', resolved_at = datetime('now'), resolution = ? WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", note, practiceId, key);
  if (r.changes) publish(practiceId, { type: 'issues' });
  return r.changes;
}

// For fire-and-forget work: `.catch(failed(db, {...}))` instead of `.catch(() => {})`.
export const failed = (db, issue) => (err) => raiseIssue(db, { ...issue, detail: err?.message || String(err) });

// ---- Integration activity ----
// Every call to an outside service: which service, what, whether it worked, how long it took, the outside
// system's id, and which attempt it was. No request or response bodies (they can carry patient details).
const SERVICES = [
  [/twilio\.com$/, 'Twilio'], [/sendgrid\.com$/, 'SendGrid'], [/stripe\.com$/, 'Stripe'], [/lob\.com$/, 'Lob'], [/plaid\.com$/, 'Plaid'],
  [/intuit\.com$|quickbooks/, 'QuickBooks'], [/deepgram\.com$/, 'Deepgram'], [/googleapis\.com$|google\.com$/, 'Google'], [/anthropic\.com$/, 'Claude'],
  [/dosespot/, 'DoseSpot'], [/bamboohealth|pmpgateway|\bpmp\b|pdmp/, 'PDMP'], [/hellopearl\.com$/, 'Pearl'], [/overjet\.(ai|com)$/, 'Overjet'], [/videa\.ai$|videahealth/, 'VideaHealth'],
];
export const serviceFor = (host) => SERVICES.find(([re]) => re.test(host))?.[1] || host;

export async function logIntegration(db, { practiceId = null, service, operation, ok, httpStatus = null, ms = null, externalId = null, attempt = 1, error = null }) {
  try {
    await db.run(
      `INSERT INTO integration_log (practice_id, service, operation, ok, http_status, duration_ms, external_id, attempt, error, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      practiceId ?? currentActor()?.practiceId ?? null, service, String(operation).slice(0, 200), ok ? 1 : 0, httpStatus, ms, externalId ? String(externalId).slice(0, 120) : null,
      attempt, error ? scrubMessage(String(error)).slice(0, 500) : null, currentActor()?.source || 'automation',
    );
  } catch (err) {
    log.warn('Integration log write failed', err);
  }
}

// Wraps fetch so every outside call is logged (host and path only — never the query string or body).
export function loggedFetch(db, fetchImpl = globalThis.fetch) {
  return async (url, opts = {}) => {
    let u;
    try { u = new URL(String(url)); } catch { return fetchImpl(url, opts); }
    if (['localhost', '127.0.0.1'].includes(u.hostname) && !process.env.LOG_LOCAL_INTEGRATIONS) return fetchImpl(url, opts);
    const started = Date.now();
    const operation = `${(opts.method || 'GET').toUpperCase()} ${u.pathname.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n')}`;
    try {
      const res = await fetchImpl(url, opts);
      await logIntegration(db, { service: serviceFor(u.hostname), operation, ok: res.ok, httpStatus: res.status, ms: Date.now() - started, externalId: res.headers?.get?.('x-request-id') || res.headers?.get?.('request-id') || null });
      return res;
    } catch (err) {
      await logIntegration(db, { service: serviceFor(u.hostname), operation, ok: false, ms: Date.now() - started, error: err.message });
      throw err;
    }
  };
}

export const purgeIntegrationLog = (db) => db.run('DELETE FROM integration_log WHERE created_at < ?', new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
