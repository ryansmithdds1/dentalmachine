// Referral tracker (backlog RT1–RT5, docs/workflows/specs/RT-referrals.md): a patient sent to a specialist is
// followed until the specialist's report is back on the chart, and nobody loses track of a critical one.
//  - statuses (referrals.status) open → scheduled → seen → report_received → closed (closing always has a reason);
//    every move, letter, text, alert and report is a row in referral_events (who, when, source);
//  - critical referrals re-alert the referral's dentist and the front desk every N days (Needs attention + team
//    chat + a live alert) until the patient has been seen or the referral is closed; routine/soon ones only turn
//    into tasks when the practice turns nudges on — otherwise they show on the past-due report;
//  - a document filed as a referral letter or correspondence is matched to the patient's open referral (rules on the
//    read text, the AI adapter only when the rules can't tell) and waits for a person to confirm it;
//  - the in-house opportunity report prices what was referred out at the office's fees and after PPO write-offs,
//    from fees stored on the day of the referral (resolveFee / officeFee — never re-priced later).
import { HttpError, can } from './auth.js';
import { insert, change, audit, practiceNow, recorded, newToken, validTooth, isRealDate } from './util.js';
import { withActor, currentActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { publish } from './events.js';
import { join, announce } from './chat.js';
import { canSeePatient, patientScope } from './officeaccess.js';
import { sendMessage, recipientFor } from './messaging.js';
import { readText } from './docsearch.js';
import { officeFee } from './fees.js';
// Today's fee on the plan's schedule. (Swapped for feeversions.js resolveFee — the fee on the referral's
// date — once fee schedule history lands.)
const resolveFee = async (db, _practiceId, fsId, code) => (await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fsId, code))?.fee ?? null;
import { primaryPolicy } from './services.js';
import { aiClient, structured } from './ai.js';

export const STATUSES = ['open', 'scheduled', 'seen', 'report_received', 'closed'];
export const STATUS_LABELS = { open: 'Sent', scheduled: 'Scheduled with them', seen: 'Seen', report_received: 'Report back', closed: 'Closed' };
export const URGENCIES = ['routine', 'soon', 'critical'];
// 'urgent' is what the older referral form saved: it's treated as critical everywhere.
export const CRITICAL = ['critical', 'urgent'];
export const isCritical = (r) => CRITICAL.includes(r?.urgency);
export const CLOSE_REASONS = {
  completed: 'Completed — report received',
  treated_here: 'We’ll treat it here instead',
  patient_declined: 'Patient declined',
  no_longer_needed: 'No longer needed',
  sent_elsewhere: 'Sent to someone else',
  entered_in_error: 'Entered by mistake',
  other: 'Other',
};
// Open = still on someone's list. "Resolved" (for critical alerts) = the specialist has seen the patient.
export const OPEN = ['open', 'scheduled', 'seen', 'report_received'];
const UNSEEN = ['open', 'scheduled'];
export const DOC_CATEGORIES = ['referral', 'correspondence'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_DAYS = 60;

export const DEFAULTS = {
  routine_days: 30, soon_days: 14, critical_days: 7, past_due_days: 30, critical_alert_days: 7, nudge_noncritical: 0, text_patient: 1,
  alert_user_ids: [],
  patient_text: 'Hi {first_name}, {practice} has referred you to {specialist}{specialist_practice}. Please call them at {specialist_phone} to book{urgent}. Questions? Call us at {practice_phone}.',
  thank_you_text: 'Dear {contact_name},\n\nThank you for referring {patient_name} to {practice}. We’ll take good care of them and let you know when treatment is complete.\n\nWarm regards,\n{provider}',
  report_back_text: 'Dear {contact_name},\n\nWe have completed treatment for {patient_name}, whom you referred on {referral_date}:\n\n{treatment}\n\n{note}\n\nThank you for the referral.\n{provider}',
};
const SETTING_INTS = ['routine_days', 'soon_days', 'critical_days', 'past_due_days', 'critical_alert_days'];
const SETTING_FLAGS = ['nudge_noncritical', 'text_patient'];
const SETTING_TEXTS = ['patient_text', 'thank_you_text', 'report_back_text'];

export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
export const todayFor = async (db, practiceId) => (await practiceNow(db, practiceId)).slice(0, 10);
const nameOf = (p) => (p ? `${p.first_name} ${p.last_name}` : 'a patient');
const shortName = (p) => (p ? `${p.first_name} ${String(p.last_name || '').slice(0, 1)}.` : 'a patient');
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : ''));
const parseIds = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(Number).filter(Boolean) : []; } catch { return []; } };

// ---- Settings ----
export async function getSettings(db, practiceId) {
  const row = await db.get('SELECT * FROM referral_settings WHERE practice_id = ?', practiceId);
  const out = { ...DEFAULTS };
  if (row) {
    for (const k of [...SETTING_INTS, ...SETTING_FLAGS]) if (row[k] != null) out[k] = Number(row[k]);
    for (const k of SETTING_TEXTS) if (row[k]) out[k] = row[k];
    out.alert_user_ids = parseIds(row.alert_user_ids);
  }
  return out;
}

export async function saveSettings(db, req, body = {}) {
  const pid = req.user.practice_id;
  const before = await getSettings(db, pid);
  const row = {};
  for (const k of SETTING_INTS) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, `${k.replace(/_/g, ' ')} must be a whole number of days from 1 to 365`);
    row[k] = n;
  }
  for (const k of SETTING_FLAGS) if (body[k] !== undefined) row[k] = body[k] ? 1 : 0;
  for (const k of SETTING_TEXTS) {
    if (body[k] === undefined) continue;
    const t = body[k] == null ? null : String(body[k]).trim().slice(0, 2000);
    row[k] = t || null;
  }
  if (body.alert_user_ids !== undefined) {
    const ids = [...new Set((Array.isArray(body.alert_user_ids) ? body.alert_user_ids : []).map(Number))];
    for (const id of ids) {
      if (!Number.isInteger(id) || !(await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1', id, pid))) throw new HttpError(400, 'Every person to alert must be an active user in this practice');
    }
    row.alert_user_ids = JSON.stringify(ids);
  }
  if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
  await db.run('INSERT INTO referral_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
  const cur = await db.get('SELECT id FROM referral_settings WHERE practice_id = ?', pid);
  await change(db, 'referral_settings', cur.id, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  const after = await getSettings(db, pid);
  await audit(db, req, 'referral.settings', 'referral_settings', cur.id, null, { before: pick(before, Object.keys(row)), after: pick(after, Object.keys(row)) });
  return after;
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, Array.isArray(o[k]) ? JSON.stringify(o[k]) : o[k]]));

export function expectedBy(date, urgency, settings) {
  const days = isCritical({ urgency }) ? settings.critical_days : urgency === 'soon' ? settings.soon_days : settings.routine_days;
  return addDays(date, days);
}

// ---- Reading ----
export const SELECT = `SELECT x.*, c.name AS contact_name, c.practice_name AS contact_practice, c.specialty, c.phone AS contact_phone, c.fax AS contact_fax, c.email AS contact_email,
    p.first_name, p.last_name, p.preferred_name, p.dob, pv.name AS provider_name, pv.user_id AS provider_user_id, ou.name AS owner_name
  FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id JOIN patients p ON p.id = x.patient_id
  LEFT JOIN providers pv ON pv.id = x.provider_id LEFT JOIN users ou ON ou.id = x.owner_id`;

export async function loadReferral(db, user, id) {
  const r = await db.get(`${SELECT} WHERE x.id = ? AND x.practice_id = ?`, Number(id), user.practice_id);
  if (!r) throw new HttpError(404, 'Referral not found');
  if (!(await canSeePatient(db, user, r.patient_id))) throw new HttpError(404, 'Referral not found');
  return r;
}

// Flags the board, the patient bar and the huddle use.
export function decorate(r, today, settings) {
  const age = daysBetween(String(r.referral_date).slice(0, 10), today);
  const critical = isCritical(r);
  const open = r.status !== 'closed';
  return {
    ...r,
    critical,
    days_open: open ? age : null,
    overdue: open && r.direction === 'out' && UNSEEN.includes(r.status) && !!r.expected_by && r.expected_by < today,
    past_due: open && age >= settings.past_due_days,
    awaiting_report: open && r.direction === 'out' && r.status === 'seen',
    review_due: r.status === 'report_received' && !r.report_reviewed_at,
    alerting: open && r.direction === 'out' && critical && UNSEEN.includes(r.status),
    status_label: STATUS_LABELS[r.status] || r.status,
  };
}

export async function timeline(db, referralId) {
  return db.all(
    `SELECT e.id, e.kind, e.from_status, e.to_status, e.on_date, e.note, e.source, COALESCE(u.name, e.actor) AS who, e.created_at
     FROM referral_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.referral_id = ? ORDER BY e.id`, referralId,
  );
}

export async function detail(db, user, id) {
  const r = await loadReferral(db, user, id);
  const settings = await getSettings(db, user.practice_id);
  const today = await todayFor(db, user.practice_id);
  const docs = can(user, 'clinical:read') ? await db.all(
    `SELECT rd.role, d.id, d.filename, d.category, d.mime, d.created_at FROM referral_documents rd JOIN documents d ON d.id = rd.document_id
     WHERE rd.referral_id = ? AND d.deleted_at IS NULL ORDER BY rd.id`, r.id,
  ) : [];
  const matches = can(user, 'clinical:read') ? await db.all(
    `SELECT m.id, m.document_id, m.score, m.reason, m.source, m.status, d.filename, d.created_at FROM referral_report_matches m JOIN documents d ON d.id = m.document_id
     WHERE m.referral_id = ? AND m.status = 'suggested' AND d.deleted_at IS NULL ORDER BY m.score DESC, m.id`, r.id,
  ) : [];
  return {
    ...decorate(r, today, settings),
    link_token_hash: undefined,
    items: await db.all(
      `SELECT i.id, i.code, i.category, i.tooth, i.surfaces, i.procedure_id, i.office_fee, i.ppo_fee, pc.description FROM referral_items i
       LEFT JOIN procedure_codes pc ON pc.practice_id = i.practice_id AND pc.code = i.code WHERE i.referral_id = ? ORDER BY i.id`, r.id,
    ),
    documents: docs,
    matches,
    events: await timeline(db, r.id),
    link_active: !!(r.link_token_hash && r.link_expires && r.link_expires > new Date().toISOString()),
  };
}

// ---- Writing ----
export async function logEvent(db, { practiceId, referralId, kind, from = null, to = null, onDate = null, note = null, userId = null }) {
  const ctx = currentActor();
  await db.run(
    'INSERT INTO referral_events (practice_id, referral_id, kind, from_status, to_status, on_date, note, user_id, source, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    practiceId, referralId, kind, from, to, onDate, note ? String(note).slice(0, 1000) : null, userId ?? null, ctx?.source || (userId ? 'human' : 'automation'), ctx?.actor || null,
  );
}

const DATE_COL = { scheduled: 'scheduled_on', seen: 'seen_on', report_received: 'report_received_on' };

// Moves a referral along. closed goes through closeReferral (it needs a reason).
export async function setStatus(db, req, ref, { status, on = null, note = null }) {
  if (!STATUSES.includes(status) || status === 'closed') throw new HttpError(400, `status must be one of: ${STATUSES.filter((s) => s !== 'closed').join(', ')}`);
  if (ref.status === 'closed') throw new HttpError(409, 'This referral is closed — reopen it first');
  const today = await todayFor(db, ref.practice_id);
  const day = on || today;
  if (!isRealDate(day)) throw new HttpError(400, 'Date must be a real date (YYYY-MM-DD)');
  // A visit can be booked for the future; "seen" and "report back" can't be in the future.
  if (status !== 'scheduled' && day > today) throw new HttpError(400, 'That date is in the future');
  if (day < String(ref.referral_date).slice(0, 10) && status !== 'scheduled') throw new HttpError(400, 'That date is before the referral was made');
  if (status === ref.status && !(DATE_COL[status] && ref[DATE_COL[status]] !== day)) return ref;
  const row = { status };
  if (DATE_COL[status]) row[DATE_COL[status]] = day;
  await change(db, 'referrals', ref.id, row);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'status', from: ref.status, to: status, onDate: day, note, userId: req?.user?.id });
  await audit(db, req, 'referral.status', 'referrals', ref.id, { from: ref.status, to: status, on: day, patient_id: ref.patient_id }, { reason: note || null, patientId: ref.patient_id });
  if (!UNSEEN.includes(status)) await settleAlerts(db, ref, `Resolved: the patient was ${status === 'scheduled' ? 'scheduled' : 'seen by the specialist'}`);
  publish(ref.practice_id, { type: 'referrals', patient_id: ref.patient_id });
  return { ...ref, ...row };
}

// The critical alert and any nudge task end once the patient has been seen or the referral is closed.
async function settleAlerts(db, ref, note) {
  await resolveIssue(db, ref.practice_id, `referral-critical:${ref.id}`, note);
  if (ref.nudge_task_id) await db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'open'", ref.nudge_task_id);
}

export async function closeReferral(db, req, ref, { reason, note = null, documentId = null }) {
  if (!CLOSE_REASONS[reason]) throw new HttpError(400, `reason must be one of: ${Object.keys(CLOSE_REASONS).join(', ')}`);
  if (reason === 'other' && !note) throw new HttpError(400, 'Say why it’s being closed');
  if (ref.status === 'closed') throw new HttpError(409, 'This referral is already closed');
  if (documentId) ref = await linkReport(db, req, ref, documentId, { source: 'human' });
  const row = { status: 'closed', closed_at: new Date().toISOString().slice(0, 19).replace('T', ' '), close_reason: reason, close_note: note ? String(note).slice(0, 500) : null, closed_by: req?.user?.id ?? null };
  await change(db, 'referrals', ref.id, row);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'closed', from: ref.status, to: 'closed', note: [CLOSE_REASONS[reason], note].filter(Boolean).join(' — '), userId: req?.user?.id });
  await audit(db, req, 'referral.close', 'referrals', ref.id, { reason, patient_id: ref.patient_id }, { reason: [CLOSE_REASONS[reason], note].filter(Boolean).join(' — '), patientId: ref.patient_id });
  await settleAlerts(db, ref, `Resolved: the referral was closed (${CLOSE_REASONS[reason]})`);
  // Suggested reports nobody confirmed are no longer needed for a closed referral.
  await db.run("UPDATE referral_report_matches SET status = 'dismissed', decided_at = datetime('now') WHERE referral_id = ? AND status = 'suggested'", ref.id);
  publish(ref.practice_id, { type: 'referrals', patient_id: ref.patient_id });
  return { ...ref, ...row };
}

export async function reopenReferral(db, req, ref, { note }) {
  if (ref.status !== 'closed') throw new HttpError(409, 'This referral is still open');
  if (!note) throw new HttpError(400, 'Say why it’s being reopened');
  const status = ref.report_document_id ? 'report_received' : ref.seen_on ? 'seen' : ref.scheduled_on ? 'scheduled' : 'open';
  await change(db, 'referrals', ref.id, { status, closed_at: null, close_reason: null, close_note: null, closed_by: null, critical_alerted_on: null });
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'reopened', from: 'closed', to: status, note, userId: req.user.id });
  await audit(db, req, 'referral.reopen', 'referrals', ref.id, { to: status, patient_id: ref.patient_id }, { reason: note, patientId: ref.patient_id });
  publish(ref.practice_id, { type: 'referrals', patient_id: ref.patient_id });
  return { ...ref, status };
}

export async function setUrgency(db, req, ref, { urgency, note = null }) {
  if (!URGENCIES.includes(urgency)) throw new HttpError(400, `urgency must be one of: ${URGENCIES.join(', ')}`);
  if (ref.urgency === urgency) return ref;
  const settings = await getSettings(db, ref.practice_id);
  const row = { urgency, expected_by: expectedBy(String(ref.referral_date).slice(0, 10), urgency, settings) };
  // Made critical: the team is told now, then every N days.
  if (urgency === 'critical') row.critical_alerted_on = null;
  await change(db, 'referrals', ref.id, row);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'urgency', note: `${ref.urgency || 'routine'} → ${urgency}${note ? ` — ${note}` : ''}`, userId: req.user.id });
  await audit(db, req, 'referral.urgency', 'referrals', ref.id, { from: ref.urgency, to: urgency, patient_id: ref.patient_id }, { reason: note, patientId: ref.patient_id });
  const next = { ...ref, ...row };
  if (urgency === 'critical' && ref.status !== 'closed') await alertCritical(db, next, { now: new Date() });
  else if (isCritical(ref) && urgency !== 'critical') await resolveIssue(db, ref.practice_id, `referral-critical:${ref.id}`, 'Resolved: no longer marked critical');
  publish(ref.practice_id, { type: 'referrals', patient_id: ref.patient_id });
  return next;
}

// ---- The report back (RT3) ----
// Links a document as the specialist's report: status report_received, the dentist gets a task to review it.
export async function linkReport(db, req, ref, documentId, { source = 'human', note = null } = {}) {
  const doc = await db.get('SELECT * FROM documents WHERE id = ? AND practice_id = ? AND deleted_at IS NULL', Number(documentId), ref.practice_id);
  if (!doc) throw new HttpError(404, 'Document not found');
  if (doc.patient_id !== ref.patient_id) throw new HttpError(400, 'That document is on another patient’s chart');
  if (ref.status === 'closed') throw new HttpError(409, 'This referral is closed — reopen it first');
  await db.run("INSERT INTO referral_documents (practice_id, referral_id, document_id, role, added_by) VALUES (?, ?, ?, 'report', ?) ON CONFLICT (referral_id, document_id, role) DO NOTHING",
    ref.practice_id, ref.id, doc.id, req?.user?.id ?? null);
  const today = await todayFor(db, ref.practice_id);
  const row = { report_document_id: doc.id, status: 'report_received', report_received_on: ref.report_received_on || today };
  if (!ref.seen_on) row.seen_on = today;
  await change(db, 'referrals', ref.id, row);
  // The filed document is confirmed; other suggestions of the same document are settled.
  await db.run("UPDATE referral_report_matches SET status = 'confirmed', decided_by = ?, decided_at = datetime('now') WHERE referral_id = ? AND document_id = ? AND status = 'suggested'", req?.user?.id ?? null, ref.id, doc.id);
  await db.run("UPDATE referral_report_matches SET status = 'dismissed', decided_by = ?, decided_at = datetime('now') WHERE document_id = ? AND referral_id <> ? AND status = 'suggested'", req?.user?.id ?? null, doc.id, ref.id);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'report', from: ref.status, to: 'report_received', onDate: row.report_received_on, note: note || `Report filed: ${doc.filename}`, userId: req?.user?.id });
  await audit(db, req, 'referral.report_linked', 'referrals', ref.id, { document_id: doc.id, patient_id: ref.patient_id, via: source }, { patientId: ref.patient_id });
  await settleAlerts(db, ref, 'Resolved: the specialist’s report is back');
  const next = { ...ref, ...row };
  await notifyReview(db, next, doc);
  publish(ref.practice_id, { type: 'referrals', patient_id: ref.patient_id });
  return next;
}

// The dentist is asked to read the report: a task (one per referral), shown live.
async function notifyReview(db, ref, doc) {
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  if (r.review_task_id && (await db.get("SELECT id FROM tasks WHERE id = ? AND status = 'open'", r.review_task_id))) return;
  const assignee = r.provider_user_id || r.owner_id || r.created_by || null;
  const taskId = await insert(db, 'tasks', {
    practice_id: r.practice_id, patient_id: r.patient_id, assigned_to: assignee, priority: isCritical(r) ? 'high' : 'normal', due_date: await todayFor(db, r.practice_id),
    title: `Review ${r.contact_name}’s report for ${nameOf(r)}`, notes: `The specialist’s report (${doc.filename}) is on the chart. Mark it reviewed on the Referrals board.`,
  });
  await change(db, 'referrals', r.id, { review_task_id: taskId });
  publish(r.practice_id, { type: 'tasks' });
  publish(r.practice_id, { type: 'referral_report', referral_id: r.id, patient_id: r.patient_id, to: assignee ? [assignee] : [] });
}

export async function markReviewed(db, req, ref) {
  if (!ref.report_document_id) throw new HttpError(409, 'No report has come back yet');
  if (ref.report_reviewed_at) return ref;
  const row = { report_reviewed_at: new Date().toISOString().slice(0, 19).replace('T', ' '), report_reviewed_by: req.user.id };
  await change(db, 'referrals', ref.id, row);
  if (ref.review_task_id) await db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, ref.review_task_id);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'reviewed', note: 'Report reviewed', userId: req.user.id });
  await audit(db, req, 'referral.report_reviewed', 'referrals', ref.id, { patient_id: ref.patient_id }, { patientId: ref.patient_id });
  publish(ref.practice_id, { type: 'tasks' });
  return { ...ref, ...row };
}

// ---- Matching filed documents to open referrals ----
const STEMS = [['endo', 'endodont'], ['perio', 'periodont'], ['oral surg', 'oral surg'], ['maxillofacial', 'maxillofacial'], ['ortho', 'orthodont'], ['pediatric', 'pediatric'], ['prosth', 'prosthodont'], ['implant', 'implant']];
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const TITLES = new Set(['dr', 'doctor', 'dds', 'dmd', 'ms', 'md', 'phd', 'pc', 'pa', 'llc', 'jr', 'sr', 'ii', 'iii']);
const hasWord = (textWords, w) => textWords.has(w);

export function scoreCandidate(text, filename, c, { single = false } = {}) {
  const all = `${text || ''} ${filename || ''}`.toLowerCase();
  const tw = new Set(words(all));
  const nameWords = words(c.contact_name).filter((w) => !TITLES.has(w) && w.length >= 3);
  const surname = nameWords[nameWords.length - 1];
  let score = 0;
  const why = [];
  if (surname && hasWord(tw, surname)) { score += 50; why.push(`names ${c.contact_name}`); }
  const practice = String(c.contact_practice || '').toLowerCase().trim();
  if (practice.length >= 4 && all.includes(practice)) { score += 30; why.push(`names ${c.contact_practice}`); }
  const spec = String(c.specialty || '').toLowerCase();
  const stem = STEMS.find(([k]) => spec.includes(k));
  if (stem && all.includes(stem[1])) { score += 15; why.push(`mentions ${c.specialty}`); }
  if (single) { score += 10; why.push('the only open referral for this patient'); }
  return { score, reason: why.length ? `The document ${why.join(', ')}` : null };
}

// The AI adapter for unclear matches: 'ai' (Claude, through ai.js, only for practices that allow AI reading of
// documents), 'sandbox' (deterministic, no outside call — demos and tests), or 'off'.
export function createReferralMatcher({ config = {} } = {}) {
  if (config.referralMatcher) return config.referralMatcher;
  if (aiClient(config)) {
    return {
      mode: 'ai', name: 'AI referral matcher',
      async match({ text, candidates }) {
        const list = candidates.map((c) => `#${c.id}: ${c.contact_name}${c.contact_practice ? `, ${c.contact_practice}` : ''}${c.specialty ? ` (${c.specialty})` : ''}, referred ${c.referral_date}${c.reason ? ` for ${c.reason}` : ''}`).join('\n');
        const out = await structured(config, {
          system: 'You match a specialist’s letter or report that a dental office received to the referral it answers. Choose only from the listed referrals; answer null when none clearly fits. Give a short plain-language reason (one sentence) a front-desk person can check.',
          tool: { name: 'pick_referral', description: 'The referral this document answers', input_schema: { type: 'object', properties: { referral_id: { type: ['integer', 'null'] }, reason: { type: 'string' } }, required: ['referral_id', 'reason'] } },
          effort: 'low', maxTokens: 2000,
          content: [{ type: 'text', text: `Open referrals:\n${list}\n\nDocument text:\n${String(text).slice(0, 6000)}` }],
        });
        const id = Number(out.referral_id);
        return candidates.some((c) => c.id === id) ? { referral_id: id, reason: String(out.reason || '').slice(0, 200) || 'Suggested by the AI' } : null;
      },
    };
  }
  if (config.ediMode === 'sandbox' || process.env.REFERRAL_MATCHER === 'sandbox') {
    return {
      mode: 'sandbox', name: 'Sandbox matcher',
      // Picks the referral whose reason shares the most words with the document (no outside call).
      async match({ text, candidates }) {
        const tw = new Set(words(text));
        const ranked = candidates.map((c) => ({ c, n: words(c.reason).filter((w) => w.length >= 4 && tw.has(w)).length })).sort((a, b) => b.n - a.n);
        if (!ranked.length || !ranked[0].n || (ranked[1] && ranked[1].n === ranked[0].n)) return null;
        return { referral_id: ranked[0].c.id, reason: `Sandbox: the document mentions “${words(ranked[0].c.reason).filter((w) => w.length >= 4 && tw.has(w)).slice(0, 3).join(', ')}”` };
      },
    };
  }
  return { mode: 'off', name: 'Off', async match() { return null; } };
}

// A document was filed (or read) on a patient's chart: if it's a referral letter or correspondence and the patient
// has an open referral out, suggest the match for a person to confirm. Never links anything by itself. Safe to call
// more than once (one suggestion per referral and document). Returns the suggestion made, if any.
export async function matchDocument(db, storage, config, docId, { matcher = null } = {}) {
  const doc = await db.get('SELECT * FROM documents WHERE id = ?', Number(docId));
  if (!doc || doc.deleted_at || !doc.patient_id) return null;
  if (!DOC_CATEGORIES.includes(doc.category) && !DOC_CATEGORIES.includes(doc.suggested_category)) return null;
  if (await db.get('SELECT id FROM referral_report_matches WHERE document_id = ?', doc.id)) return null;
  if (await db.get("SELECT id FROM referral_documents WHERE document_id = ? AND role = 'report'", doc.id)) return null;
  const candidates = await db.all(
    `${SELECT} WHERE x.practice_id = ? AND x.patient_id = ? AND x.direction = 'out' AND x.status IN ('open','scheduled','seen') AND x.report_document_id IS NULL
       AND x.referral_date <= ? ORDER BY x.id`, doc.practice_id, doc.patient_id, String(doc.created_at).slice(0, 10),
  );
  if (!candidates.length) return null;
  const text = storage ? await readText(storage, doc) : '';
  const scored = candidates.map((c) => ({ c, ...scoreCandidate(text, doc.filename, c, { single: candidates.length === 1 }) })).sort((a, b) => b.score - a.score);
  let pickRow = null;
  const [best, next] = scored;
  if (best.score >= 40 && (!next || best.score - next.score >= 15)) pickRow = { referral: best.c, score: best.score, reason: best.reason, source: 'rules' };
  else if (candidates.length === 1) pickRow = { referral: best.c, score: best.score, reason: best.reason || 'The only open referral for this patient', source: 'rules' };
  else if (text) {
    // The rules can't tell: ask the AI adapter (when the practice allows AI reading of documents).
    const m = matcher || createReferralMatcher({ config });
    const allowed = m.mode !== 'ai' || !!(await db.get('SELECT document_ai FROM practices WHERE id = ?', doc.practice_id))?.document_ai;
    if (m.mode !== 'off' && allowed) {
      try {
        const out = await withActor({ source: m.mode === 'ai' ? 'ai' : 'automation', actor: m.name, practiceId: doc.practice_id }, () => m.match({ text, candidates }));
        if (out) pickRow = { referral: candidates.find((c) => c.id === out.referral_id), score: 30, reason: out.reason, source: m.mode === 'ai' ? 'ai' : 'sandbox' };
        await resolveIssue(db, doc.practice_id, `referral-match:${doc.practice_id}`, 'Resolved: referral reports are being matched again');
      } catch (err) {
        await raiseIssue(db, { practiceId: doc.practice_id, kind: 'ai', key: `referral-match:${doc.practice_id}`, role: 'front_desk', entity: 'documents', entityId: doc.id, patientId: doc.patient_id,
          title: 'A specialist’s report couldn’t be matched to its referral', detail: `${doc.filename}: ${err.message}. Link it by hand on the Referrals board.` });
      }
    }
  }
  if (!pickRow) return null;
  const made = await db.run(
    "INSERT INTO referral_report_matches (practice_id, referral_id, document_id, score, reason, source) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (referral_id, document_id) DO NOTHING",
    doc.practice_id, pickRow.referral.id, doc.id, pickRow.score, pickRow.reason ? String(pickRow.reason).slice(0, 300) : null, pickRow.source,
  );
  if (!made.changes) return null;
  const actor = pickRow.source === 'ai' ? { source: 'ai', actor: 'AI referral matcher' } : { source: 'automation', actor: 'Referral tracker' };
  await withActor({ ...actor, practiceId: doc.practice_id }, async () => {
    await logEvent(db, { practiceId: doc.practice_id, referralId: pickRow.referral.id, kind: 'report_suggested', note: `${doc.filename}${pickRow.reason ? ` — ${pickRow.reason}` : ''}` });
    await audit(db, null, 'referral.report_suggested', 'referrals', pickRow.referral.id, { document_id: doc.id, score: pickRow.score, patient_id: doc.patient_id },
      { reason: pickRow.reason, patientId: doc.patient_id, source: actor.source, actor: actor.actor });
  });
  publish(doc.practice_id, { type: 'referrals', patient_id: doc.patient_id });
  return { referral_id: pickRow.referral.id, document_id: doc.id, score: pickRow.score, reason: pickRow.reason, source: pickRow.source };
}

// The hook for the documents filing path (docfiles.readDocument, PUT /documents/:id): never throws — a failure
// becomes a Needs attention item, the filing itself is not affected.
export async function referralDocumentFiled(db, storage, config, docId) {
  try {
    return await matchDocument(db, storage, config, docId);
  } catch (err) {
    const doc = await db.get('SELECT practice_id, patient_id, filename FROM documents WHERE id = ?', Number(docId)).catch(() => null);
    await raiseIssue(db, { practiceId: doc?.practice_id, kind: 'records', key: `referral-match-failed:${docId}`, role: 'front_desk', entity: 'documents', entityId: Number(docId), patientId: doc?.patient_id ?? null,
      title: 'A filed referral letter couldn’t be checked against open referrals', detail: `${doc?.filename || docId}: ${err.message}` });
    return null;
  }
}

export async function confirmMatch(db, req, matchId, { complete = false } = {}) {
  const m = await db.get('SELECT * FROM referral_report_matches WHERE id = ? AND practice_id = ?', Number(matchId), req.user.practice_id);
  if (!m) throw new HttpError(404, 'Suggestion not found');
  if (m.status !== 'suggested') throw new HttpError(409, m.status === 'confirmed' ? 'Already confirmed' : 'That suggestion was dismissed');
  let ref = await loadReferral(db, req.user, m.referral_id);
  ref = await linkReport(db, req, ref, m.document_id, { source: m.source, note: `Report confirmed${m.source === 'ai' ? ' (suggested by the AI)' : ''}` });
  if (complete) ref = await closeReferral(db, req, ref, { reason: 'completed' });
  return ref;
}

export async function dismissMatch(db, req, matchId) {
  const m = await db.get('SELECT * FROM referral_report_matches WHERE id = ? AND practice_id = ?', Number(matchId), req.user.practice_id);
  if (!m) throw new HttpError(404, 'Suggestion not found');
  await loadReferral(db, req.user, m.referral_id);
  if (m.status !== 'suggested') return m;
  await recorded(db, 'referral_report_matches', m.id, () => db.run("UPDATE referral_report_matches SET status = 'dismissed', decided_by = ?, decided_at = datetime('now') WHERE id = ?", req.user.id, m.id));
  await logEvent(db, { practiceId: m.practice_id, referralId: m.referral_id, kind: 'report_dismissed', note: 'Suggested document isn’t the report', userId: req.user.id });
  await audit(db, req, 'referral.report_dismissed', 'referrals', m.referral_id, { document_id: m.document_id });
  return { ...m, status: 'dismissed' };
}

// ---- Critical alerts and nudges (RT2) ----
async function alertRecipients(db, ref, settings) {
  const ids = new Set(settings.alert_user_ids);
  const dentist = ref.provider_user_id ?? (ref.provider_id ? (await db.get('SELECT user_id FROM providers WHERE id = ?', ref.provider_id))?.user_id : null);
  if (dentist) ids.add(dentist);
  for (const u of await db.all("SELECT id FROM users WHERE practice_id = ? AND active = 1 AND role = 'front_desk'", ref.practice_id)) ids.add(u.id);
  if (!dentist && ref.owner_id) ids.add(ref.owner_id);
  const live = await db.all(`SELECT id FROM users WHERE practice_id = ? AND active = 1 AND id IN (${[...ids].map(() => '?').join(',') || 'NULL'})`, ref.practice_id, ...ids);
  return live.map((u) => u.id);
}

async function postToChat(db, practiceId, body, recipientIds, patientId) {
  await db.run(
    "INSERT INTO chat_channels (practice_id, kind, name, slug, topic, audience) VALUES (?, 'channel', 'Everyone', 'everyone', 'The whole office', 'everyone') ON CONFLICT (practice_id, slug) DO NOTHING",
    practiceId,
  );
  const channel = await db.get("SELECT * FROM chat_channels WHERE practice_id = ? AND slug = 'everyone'", practiceId);
  const made = await db.run(
    "INSERT INTO chat_messages (practice_id, channel_id, user_id, source, kind, body, patient_id, urgent) VALUES (?, ?, NULL, 'automation', 'system', ?, ?, 1)",
    practiceId, channel.id, body.slice(0, 3900), patientId,
  );
  for (const uid of recipientIds) {
    await join(db, channel, uid, { readThrough: made.id - 1 });
    await db.run('INSERT INTO chat_mentions (practice_id, message_id, channel_id, user_id, via) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO NOTHING', practiceId, made.id, channel.id, uid, 'referral');
  }
  await announce(db, channel, { event: 'message', message_id: made.id, parent_id: null, mentions: recipientIds, urgent: true, by: null });
  return made.id;
}

// Tells the dentist and the front desk about a critical referral the patient hasn't been seen for — once per
// interval (claimed with one conditional UPDATE, so two job runs or servers can't both send it).
export async function alertCritical(db, ref, { now = new Date(), settings = null } = {}) {
  settings ||= await getSettings(db, ref.practice_id);
  const today = await todayFor(db, ref.practice_id);
  const since = addDays(today, -settings.critical_alert_days);
  const claim = await db.run(
    `UPDATE referrals SET critical_alerted_on = ?, critical_alerts = critical_alerts + 1
     WHERE id = ? AND status IN ('open','scheduled') AND urgency IN ('critical','urgent') AND (critical_alerted_on IS NULL OR critical_alerted_on <= ?)`,
    today, ref.id, since,
  );
  if (!claim.changes) return null;
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  const days = daysBetween(String(r.referral_date).slice(0, 10), today);
  const recipients = await alertRecipients(db, r, settings);
  const title = `Critical referral: ${nameOf(r)} → ${r.contact_name} — ${r.status === 'scheduled' ? `scheduled${r.scheduled_on ? ` for ${r.scheduled_on}` : ''}, not seen yet` : 'not scheduled yet'} (${days} day${days === 1 ? '' : 's'})`;
  return withActor({ source: 'automation', actor: 'Referral tracker', practiceId: r.practice_id }, async () => {
    await raiseIssue(db, {
      practiceId: r.practice_id, kind: 'records', key: `referral-critical:${r.id}`, severity: 'high', role: 'front_desk', entity: 'referrals', entityId: r.id, patientId: r.patient_id, title,
      detail: `${r.reason || 'Critical referral'}. Call ${r.contact_name}${r.contact_phone ? ` (${r.contact_phone})` : ''} and the patient; mark it scheduled or seen on the Referrals board. This comes back every ${settings.critical_alert_days} days until the patient is seen or the referral is closed.`,
    });
    await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: 'alert', note: `Critical alert #${r.critical_alerts} sent to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}` });
    publish(r.practice_id, { type: 'referral_alert', referral_id: r.id, patient_id: r.patient_id, to: recipients });
    let chat = null;
    try {
      if (recipients.length) chat = await postToChat(db, r.practice_id, `🔴 ${title}. Please make sure they get seen — open the Referrals board to update it.`, recipients, r.patient_id);
      await resolveIssue(db, r.practice_id, `referral-critical-chat:${r.id}`, 'Resolved: the alert was posted');
    } catch (err) {
      await raiseIssue(db, { practiceId: r.practice_id, kind: 'message', key: `referral-critical-chat:${r.id}`, role: 'admin', patientId: r.patient_id, title: 'A critical referral alert couldn’t be posted to team chat', detail: err.message });
    }
    return { referral_id: r.id, recipients, chat };
  });
}

// Routine / soon referrals past their expected date: one task for the referral's owner (only when turned on).
export async function nudgeOverdue(db, ref, { settings, today }) {
  if (!settings.nudge_noncritical || isCritical(ref)) return null;
  const late = (UNSEEN.includes(ref.status) && ref.expected_by && ref.expected_by < today) || (ref.status === 'seen' && ref.seen_on && addDays(ref.seen_on, 14) < today);
  if (!late) return null;
  if (ref.nudge_task_id && (await db.get("SELECT id FROM tasks WHERE id = ? AND status = 'open'", ref.nudge_task_id))) return null;
  const claim = await db.run('UPDATE referrals SET nudged_on = ? WHERE id = ? AND (nudged_on IS NULL OR nudged_on < ?)', today, ref.id, today);
  if (!claim.changes) return null;
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  const title = r.status === 'seen' ? `Ask ${r.contact_name} for the report on ${nameOf(r)}` : `${nameOf(r)} hasn’t been seen by ${r.contact_name} yet — call to check`;
  return withActor({ source: 'automation', actor: 'Referral tracker', practiceId: r.practice_id }, async () => {
    const taskId = await insert(db, 'tasks', {
      practice_id: r.practice_id, patient_id: r.patient_id, assigned_to: r.owner_id || r.created_by || null, priority: 'normal', due_date: today, title,
      notes: `Referred ${r.referral_date}${r.reason ? ` for ${r.reason}` : ''}. Expected by ${r.expected_by}. Update it on the Referrals board.`,
    });
    await change(db, 'referrals', r.id, { nudge_task_id: taskId });
    await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: 'nudge', note: title });
    publish(r.practice_id, { type: 'tasks' });
    return taskId;
  });
}

// The background job: critical alerts, nudges, and matching recently filed letters no hook saw.
export async function runReferralJobs(db, { storage = null, config = {}, now = new Date(), practiceId = null } = {}) {
  const out = { alerts: 0, nudges: 0, matches: 0 };
  const practices = practiceId ? [{ practice_id: practiceId }] : await db.all("SELECT DISTINCT practice_id FROM referrals WHERE status <> 'closed'");
  for (const { practice_id: pid } of practices) {
    await withActor({ source: 'automation', actor: 'Referral tracker', practiceId: pid }, async () => {
      try {
        const settings = await getSettings(db, pid);
        const today = await todayFor(db, pid);
        const open = await db.all("SELECT * FROM referrals WHERE practice_id = ? AND direction = 'out' AND status IN ('open','scheduled','seen') ORDER BY id", pid);
        for (const r of open) {
          if (isCritical(r) && UNSEEN.includes(r.status) && (await alertCritical(db, r, { now, settings }))) out.alerts++;
          if (await nudgeOverdue(db, r, { settings, today })) out.nudges++;
        }
        if (storage) {
          const since = addDays(today, -30);
          const docs = await db.all(
            `SELECT d.id FROM documents d WHERE d.practice_id = ? AND d.deleted_at IS NULL AND d.patient_id IS NOT NULL AND d.created_at >= ?
               AND (d.category IN ('referral','correspondence') OR d.suggested_category IN ('referral','correspondence'))
               AND NOT EXISTS (SELECT 1 FROM referral_report_matches m WHERE m.document_id = d.id)
               AND EXISTS (SELECT 1 FROM referrals x WHERE x.patient_id = d.patient_id AND x.direction = 'out' AND x.status IN ('open','scheduled','seen'))`, pid, since,
          );
          for (const d of docs) if (await referralDocumentFiled(db, storage, config, d.id)) out.matches++;
        }
        await resolveIssue(db, pid, `referral-jobs:${pid}`, 'Resolved: referral follow-up is running again');
      } catch (err) {
        await raiseIssue(db, { practiceId: pid, kind: 'records', key: `referral-jobs:${pid}`, role: 'admin', title: 'Referral follow-up (critical alerts, nudges) didn’t run', detail: err.message });
      }
    });
  }
  return out;
}

// ---- Creating (RT1) ----
export async function contactFor(db, req, body) {
  const pid = req.user.practice_id;
  if (body.contact_id) {
    const c = await db.get('SELECT * FROM referral_contacts WHERE id = ? AND practice_id = ?', Number(body.contact_id), pid);
    if (!c) throw new HttpError(404, 'Specialist not found');
    return c;
  }
  const n = body.new_contact;
  if (!n || typeof n !== 'object' || !String(n.name || '').trim()) throw new HttpError(400, 'Choose the specialist, or add a new one with a name');
  const row = {};
  for (const k of ['name', 'practice_name', 'specialty', 'phone', 'fax', 'email', 'address']) if (n[k] != null && String(n[k]).trim()) row[k] = String(n[k]).trim().slice(0, 200);
  if (row.email && !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(row.email)) throw new HttpError(400, 'Invalid email');
  // The same specialist typed again (same name and practice) is the existing contact, not a second one.
  const same = await db.get('SELECT * FROM referral_contacts WHERE practice_id = ? AND lower(name) = ? AND lower(COALESCE(practice_name, \'\')) = ?', pid, row.name.toLowerCase(), (row.practice_name || '').toLowerCase());
  if (same) return same;
  const id = await insert(db, 'referral_contacts', { ...row, practice_id: pid });
  await audit(db, req, 'referral_contact.create', 'referral_contacts', id);
  return db.get('SELECT * FROM referral_contacts WHERE id = ?', id);
}

async function scheduleOf(db, pid, patientId) {
  const pol = await primaryPolicy(db, pid, patientId);
  if (!pol) return null;
  if (pol.plan_id) {
    const plan = await db.get('SELECT fee_schedule_id FROM insurance_plans WHERE id = ? AND practice_id = ?', pol.plan_id, pid);
    if (plan?.fee_schedule_id) return plan.fee_schedule_id;
  }
  return (await db.get('SELECT fee_schedule_id FROM insurance_carriers WHERE id = ?', pol.carrier_id))?.fee_schedule_id ?? null;
}

// Validates the items (codes, teeth, the planned procedure each came from) and prices them for the report.
export async function cleanItems(db, req, patient, items, { date, providerId, locationId }) {
  if (items == null) return [];
  if (!Array.isArray(items) || items.length > 30) throw new HttpError(400, 'items must be a list (at most 30)');
  const pid = req.user.practice_id;
  const fs = await scheduleOf(db, pid, patient.id);
  const out = [];
  for (const it of items) {
    let code = String(it?.code || '').trim().toUpperCase();
    let tooth = it?.tooth ? String(it.tooth).trim().toUpperCase() : null;
    let procedureId = null;
    if (it?.procedure_id) {
      const pr = await db.get('SELECT pr.*, pc.code FROM procedures pr JOIN procedure_codes pc ON pc.id = pr.code_id WHERE pr.id = ? AND pr.practice_id = ?', Number(it.procedure_id), pid);
      if (!pr || pr.patient_id !== patient.id) throw new HttpError(404, 'Planned procedure not found for this patient');
      if (pr.status !== 'planned') throw new HttpError(409, 'Only planned procedures can be referred out');
      procedureId = pr.id;
      code ||= pr.code;
      tooth ||= pr.tooth || null;
    }
    if (!/^D\d{4}$/.test(code)) throw new HttpError(400, `“${code || '(blank)'}” isn’t a procedure code (D0000–D9999)`);
    const pc = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code);
    if (!pc) throw new HttpError(400, `${code} isn’t in this practice’s procedure codes`);
    if (tooth && !validTooth(tooth)) throw new HttpError(400, `Tooth ${tooth} isn’t valid (1-32 or A-T)`);
    const surfaces = it?.surfaces ? String(it.surfaces).toUpperCase().replace(/[^MODBLFI]/g, '').slice(0, 5) || null : null;
    const office = await officeFee(db, pid, pc, { patientId: patient.id, providerId, locationId, date });
    const ppo = fs ? await resolveFee(db, pid, fs, code, date) : null;
    out.push({ code, category: pc.category, tooth, surfaces, procedure_id: procedureId, office_fee: office ?? null, ppo_fee: ppo ?? null });
  }
  return out;
}

// Whoever finds the specialist next: the one this practice used last for the same kind of work.
export async function suggestContact(db, pid, categories = []) {
  const cats = categories.filter(Boolean);
  if (cats.length) {
    const hit = await db.get(
      `SELECT x.contact_id FROM referral_items i JOIN referrals x ON x.id = i.referral_id JOIN referral_contacts c ON c.id = x.contact_id
       WHERE i.practice_id = ? AND c.active = 1 AND i.category IN (${cats.map(() => '?').join(',')}) ORDER BY i.id DESC LIMIT 1`, pid, ...cats,
    );
    if (hit) return hit.contact_id;
  }
  return (await db.get("SELECT x.contact_id FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id WHERE x.practice_id = ? AND x.direction = 'out' AND c.active = 1 ORDER BY x.id DESC LIMIT 1", pid))?.contact_id ?? null;
}

export function newLink() {
  const { token, hash } = newToken();
  return { token, hash, expires: new Date(Date.now() + LINK_DAYS * 86400_000).toISOString() };
}
export const linkUrl = (config, token) => `${String(config.appUrl || '').replace(/\/$/, '')}/api/public/referral/${token}/view`;

// Sends the letter: email (a secure link to the letter and files, no patient details in the email itself), or
// print / fax by hand (recorded as such — there's no fax service connected). Returns what happened.
export async function sendLetter(db, req, ref, { channel, messenger, config }) {
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', r.practice_id);
  if (!['email', 'print', 'fax', 'none'].includes(channel)) throw new HttpError(400, 'send must be one of: email, print, fax, none');
  if (channel === 'none') return { channel };
  if (channel === 'email') {
    if (!r.contact_email) throw new HttpError(400, `${r.contact_name} has no email address — print or fax the letter instead`);
    const link = newLink();
    await change(db, 'referrals', r.id, { link_token_hash: link.hash, link_expires: link.expires });
    const url = linkUrl(config, link.token);
    const inbound = r.direction === 'in';
    const subject = inbound ? `A note from ${practice.name}` : `New referral from ${practice.name}`;
    const body = inbound
      ? `${practice.name} has sent you an update about a patient you referred. View it securely (link good for ${LINK_DAYS} days): ${url}\n\nQuestions? Call ${practice.phone || 'the office'}.`
      : `${practice.name} has referred a patient to you${isCritical(r) ? ' (URGENT)' : ''}. View the referral letter and files securely, tell us when they're scheduled, and send the report back at: ${url}\n\nThe link is good for ${LINK_DAYS} days. Questions? Call ${practice.phone || 'the office'}.`;
    const msg = await sendMessage(db, messenger, { practiceId: r.practice_id, patientId: null, channel: 'email', to: r.contact_email, subject, body, kind: inbound ? 'referral_update' : 'referral_letter', userId: req?.user?.id });
    const ok = msg.status === 'sent';
    if (ok) {
      await change(db, 'referrals', r.id, { letter_sent_at: new Date().toISOString().slice(0, 19).replace('T', ' '), letter_sent_via: 'email' });
      await resolveIssue(db, r.practice_id, `referral-letter:${r.id}`, 'Resolved: the letter went on a later try');
    } else {
      await raiseIssue(db, { practiceId: r.practice_id, kind: 'message', key: `referral-letter:${r.id}`, role: 'front_desk', entity: 'referrals', entityId: r.id, patientId: r.patient_id,
        title: `The referral letter for ${nameOf(r)} to ${r.contact_name} didn’t go`, detail: `${msg.error || msg.status}. Send it again from the Referrals board, or print and fax it.` });
    }
    await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: inbound ? 'update_sent' : 'letter', note: ok ? `Emailed a secure link to ${r.contact_email}` : `Email to ${r.contact_email} didn’t go: ${msg.error || msg.status}`, userId: req?.user?.id });
    return { channel, status: msg.status, message_id: msg.id, error: ok ? null : msg.error || msg.status };
  }
  // Printed (and faxed or handed over by the team): the letter screen prints it.
  await change(db, 'referrals', r.id, { letter_sent_at: new Date().toISOString().slice(0, 19).replace('T', ' '), letter_sent_via: channel });
  await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: 'letter', note: channel === 'fax' ? `Letter printed to fax${r.contact_fax ? ` to ${r.contact_fax}` : ''}` : 'Letter printed', userId: req?.user?.id });
  return { channel, status: 'print', letter_url: `/referrals/${r.id}/letter` };
}

// Texts the patient who to call (through sendMessage: opt-outs and STOP are respected, a child's goes to the parent).
export async function tellPatient(db, req, ref, { messenger }) {
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', r.patient_id);
  const to = await recipientFor(db, patient);
  const settings = await getSettings(db, r.practice_id);
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', r.practice_id);
  const channel = to.phone && to.sms_opt_in ? 'sms' : to.email && to.email_opt_in ? 'email' : null;
  if (!channel) {
    await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: 'patient_text', note: 'Not sent: no mobile number or email they’ve agreed to', userId: req?.user?.id });
    return { status: 'skipped', reason: 'No mobile number or email the patient agreed to' };
  }
  const body = fill(settings.patient_text, {
    first_name: patient.preferred_name || patient.first_name, practice: practice.name, specialist: r.contact_name, specialist_practice: r.contact_practice ? ` at ${r.contact_practice}` : '',
    specialist_phone: r.contact_phone || 'the number on your referral card', urgent: isCritical(r) ? ' today — this is urgent' : '', practice_phone: practice.phone || 'the office',
  }).slice(0, 640);
  const msg = await sendMessage(db, messenger, { practiceId: r.practice_id, patientId: patient.id, channel, to: channel === 'sms' ? to.phone : to.email, subject: channel === 'email' ? `Your referral to ${r.contact_name}` : undefined, body, kind: 'referral_patient', userId: req?.user?.id });
  if (msg.status === 'sent') await change(db, 'referrals', r.id, { patient_told_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await logEvent(db, { practiceId: r.practice_id, referralId: r.id, kind: 'patient_text', note: msg.status === 'sent' ? `${channel === 'sms' ? 'Texted' : 'Emailed'} the patient ${r.contact_name}’s number` : `Not sent to the patient: ${msg.error || msg.status}`, userId: req?.user?.id });
  return { status: msg.status, channel, message_id: msg.id, error: msg.status === 'sent' ? null : msg.error };
}

// ---- Inbound (RT4) ----
export async function treatmentSince(db, patientId, date) {
  return db.all(
    `SELECT pr.id, pc.code, pc.description, pr.tooth, pr.surfaces, pr.status, substr(pr.completed_at, 1, 10) AS completed_on FROM procedures pr JOIN procedure_codes pc ON pc.id = pr.code_id
     WHERE pr.patient_id = ? AND pr.status IN ('completed','planned') AND (pr.status = 'planned' OR substr(pr.completed_at, 1, 10) >= ?) ORDER BY pr.completed_at, pr.id`, patientId, date,
  );
}

export async function letterFor(db, ref, kind, { note = '' } = {}) {
  const r = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
  const practice = await db.get('SELECT name, address, city, state, zip, phone, email FROM practices WHERE id = ?', r.practice_id);
  const settings = await getSettings(db, r.practice_id);
  const done = (await treatmentSince(db, r.patient_id, String(r.referral_date).slice(0, 10))).filter((t) => t.status === 'completed');
  const text = fill(kind === 'thank_you' ? settings.thank_you_text : settings.report_back_text, {
    contact_name: r.contact_name, patient_name: nameOf(r), practice: practice.name, referral_date: String(r.referral_date).slice(0, 10), note: note || '',
    provider: r.provider_name || practice.name,
    treatment: done.length ? done.map((t) => `• ${t.completed_on} ${t.code} ${t.description}${t.tooth ? ` (#${t.tooth})` : ''}`).join('\n') : '• (no completed treatment recorded yet)',
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { referral: r, practice, text, treatment: done };
}

export async function sendInboundLetter(db, req, ref, kind, { channel, note, messenger, config, resend = false }) {
  if (ref.direction !== 'in') throw new HttpError(400, 'Thank-you letters and reports back are for patients referred to us');
  const col = kind === 'thank_you' ? 'thank_you_sent_at' : 'report_back_sent_at';
  if (ref[col] && !resend) throw new HttpError(409, kind === 'thank_you' ? 'The thank-you was already sent' : 'The report back was already sent');
  if (!['email', 'print'].includes(channel)) throw new HttpError(400, 'channel must be email or print');
  const letter = await letterFor(db, ref, kind, { note });
  let result = { channel, status: 'print' };
  if (channel === 'email') {
    const r = letter.referral;
    if (!r.contact_email) throw new HttpError(400, `${r.contact_name} has no email address — print it instead`);
    if (kind === 'thank_you') {
      // A thank-you names the patient by first name and initial only (email isn't a secure channel).
      const body = letter.text.replace(nameOf(r), shortName(r));
      const msg = await sendMessage(db, messenger, { practiceId: r.practice_id, patientId: null, channel: 'email', to: r.contact_email, subject: `Thank you for your referral — ${letter.practice.name}`, body, kind: 'referral_thanks', userId: req.user.id });
      result = { channel, status: msg.status, message_id: msg.id, error: msg.status === 'sent' ? null : msg.error };
    } else {
      // The treatment summary is behind the secure link.
      result = await sendLetter(db, req, ref, { channel: 'email', messenger, config });
    }
    if (result.status !== 'sent') throw new HttpError(502, `The email didn’t go: ${result.error || result.status}`);
  }
  const row = { [col]: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  await change(db, 'referrals', ref.id, row);
  await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: kind === 'thank_you' ? 'thank_you' : 'report_back', note: `${kind === 'thank_you' ? 'Thank-you' : 'Report back'} ${channel === 'email' ? 'emailed' : 'printed'}${note ? ` — ${note}` : ''}`, userId: req.user.id });
  await audit(db, req, kind === 'thank_you' ? 'referral.thank_you' : 'referral.report_back', 'referrals', ref.id, { channel, patient_id: ref.patient_id }, { patientId: ref.patient_id });
  let next = { ...ref, ...row };
  if (kind === 'report_back' && ref.status !== 'closed') next = await closeReferral(db, req, next, { reason: 'completed', note: 'Report sent back to the referring doctor' });
  return { ...result, text: letter.text, referral_id: ref.id, status_after: next.status };
}

// ---- Reports ----
// Where our patients come from: per referring doctor, patients, production since, and whether we thanked them
// and reported back.
export async function sourceStats(db, user, { from, to }) {
  const s = patientScope(user, 'p');
  const rows = await db.all(
    `SELECT c.id, c.name, c.practice_name, c.specialty, COUNT(*) AS referrals, COUNT(DISTINCT x.patient_id) AS patients,
       SUM(CASE WHEN x.thank_you_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS thanked,
       SUM(CASE WHEN x.report_back_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS reported_back,
       COALESCE(SUM((SELECT COALESCE(SUM(pr.fee), 0) FROM procedures pr WHERE pr.patient_id = x.patient_id AND pr.status = 'completed' AND substr(pr.completed_at, 1, 10) >= x.referral_date)), 0) AS production
     FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id JOIN patients p ON p.id = x.patient_id
     WHERE x.practice_id = ? AND x.direction = 'in' AND x.referral_date BETWEEN ? AND ?${s.sql}
     GROUP BY c.id, c.name, c.practice_name, c.specialty`, user.practice_id, from, to, ...s.args,
  );
  const out = rows.map((r) => ({ ...r, referrals: Number(r.referrals), patients: Number(r.patients), thanked: Number(r.thanked), reported_back: Number(r.reported_back), production: Number(r.production) }))
    .sort((a, b) => b.patients - a.patients || b.production - a.production);
  return { from, to, sources: out, totals: { referrals: out.reduce((t, r) => t + r.referrals, 0), patients: out.reduce((t, r) => t + r.patients, 0), production: out.reduce((t, r) => t + r.production, 0) } };
}

export const CATEGORY_LABELS = {
  diagnostic: 'Diagnostic', preventive: 'Preventive', restorative: 'Restorative', endodontics: 'Endodontics', periodontics: 'Perio surgery', prosthodontics: 'Prosthodontics',
  oral_surgery: 'Oral surgery / extractions', orthodontics: 'Orthodontics', implants: 'Implants', adjunctive: 'Other',
};

// RT5: everything referred out in a range, priced at the office's fees and at what PPO plans would have paid
// (after the write-off), grouped by category, code, month, year and specialist. Fees are the ones stored when the
// referral was made; referrals closed as "entered by mistake" don't count.
export async function inHouseOpportunity(db, user, { from, to }) {
  const s = patientScope(user, 'p');
  const rows = await db.all(
    `SELECT i.code, i.category, i.office_fee, i.ppo_fee, x.id AS referral_id, x.referral_date, c.id AS contact_id, c.name AS contact_name, c.specialty, pc.description
     FROM referral_items i JOIN referrals x ON x.id = i.referral_id JOIN referral_contacts c ON c.id = x.contact_id JOIN patients p ON p.id = x.patient_id
     LEFT JOIN procedure_codes pc ON pc.practice_id = i.practice_id AND pc.code = i.code
     WHERE x.practice_id = ? AND x.direction = 'out' AND x.referral_date BETWEEN ? AND ? AND COALESCE(x.close_reason, '') <> 'entered_in_error'${s.sql}`,
    user.practice_id, from, to, ...s.args,
  );
  const without = Number((await db.get(
    `SELECT COUNT(*) AS n FROM referrals x JOIN patients p ON p.id = x.patient_id WHERE x.practice_id = ? AND x.direction = 'out' AND x.referral_date BETWEEN ? AND ?
       AND COALESCE(x.close_reason, '') <> 'entered_in_error' AND NOT EXISTS (SELECT 1 FROM referral_items i WHERE i.referral_id = x.id)${s.sql}`, user.practice_id, from, to, ...s.args,
  )).n);
  const group = (keyOf, labelOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) || { key: k, label: labelOf(r), count: 0, office: 0, net: 0, referrals: new Set() };
      g.count += 1;
      g.office += Number(r.office_fee || 0);
      g.net += Number(r.ppo_fee ?? r.office_fee ?? 0);
      g.referrals.add(r.referral_id);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ key: g.key, label: g.label, count: g.count, referrals: g.referrals.size, office: g.office, net: g.net, write_off: g.office - g.net }));
  };
  const byValue = (a, b) => b.office - a.office || b.count - a.count;
  const byCategory = group((r) => r.category || 'adjunctive', (r) => CATEGORY_LABELS[r.category] || r.category || 'Other').sort(byValue);
  const byCode = group((r) => r.code, (r) => `${r.code} ${r.description || ''}`.trim()).sort(byValue);
  const byMonth = group((r) => String(r.referral_date).slice(0, 7), (r) => String(r.referral_date).slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key));
  const byYear = group((r) => String(r.referral_date).slice(0, 4), (r) => String(r.referral_date).slice(0, 4)).sort((a, b) => a.key.localeCompare(b.key));
  const bySpecialist = group((r) => r.contact_id, (r) => `${r.contact_name}${r.specialty ? ` (${r.specialty})` : ''}`).sort(byValue);
  const totals = { count: rows.length, referrals: new Set(rows.map((r) => r.referral_id)).size, office: rows.reduce((t, r) => t + Number(r.office_fee || 0), 0), net: rows.reduce((t, r) => t + Number(r.ppo_fee ?? r.office_fee ?? 0), 0) };
  totals.write_off = totals.office - totals.net;
  const top = byCode[0];
  const dollars = (c) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
  return {
    from, to, totals, by_category: byCategory, by_code: byCode, by_month: byMonth, by_year: byYear, top_specialists: bySpecialist.slice(0, 10), referrals_without_codes: without,
    headline: top ? `You referred out ${top.count} × ${top.label} ≈ ${dollars(top.office)} at your fees (${dollars(top.net)} after PPO write-offs).` : 'Nothing referred out with procedure codes in this period.',
  };
}
