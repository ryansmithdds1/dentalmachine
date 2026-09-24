// Referral tracker routes (backlog RT1–RT5; logic in referraltracker.js, spec docs/workflows/specs/RT-referrals.md).
// Signed-in routes live under /referral-tracker (the older /referrals routes stay as they are); the specialist's
// secure link is referralPublicRoutes, under /api/public/referral/:token.
import express, { Router } from 'express';
import { requirePermission, HttpError, can, rateLimit } from '../auth.js';
import { findOr404, insert, audit, isRealDate, recorded, hashToken, toCsv } from '../util.js';
import { setActor } from '../actor.js';
import { publish } from '../events.js';
import { canSeePatient, patientScope, restricted } from '../officeaccess.js';
import { storeUpload } from '../docfiles.js';
import { createVirusScanner } from '../virusscan.js';
import { readLimitFor } from '../filetypes.js';
import {
  URGENCIES, CLOSE_REASONS, STATUS_LABELS, CATEGORY_LABELS, SELECT, getSettings, saveSettings, expectedBy, loadReferral, decorate, detail, logEvent, setStatus,
  closeReferral, reopenReferral, setUrgency, linkReport, markReviewed, confirmMatch, dismissMatch, alertCritical, runReferralJobs, contactFor, cleanItems,
  suggestContact, sendLetter, tellPatient, sendInboundLetter, letterFor, sourceStats, inHouseOpportunity, todayFor, addDays, isCritical, treatmentSince,
} from '../referraltracker.js';

const CLIENT_KEY = /^[\w.:-]{8,120}$/;
const isAdmin = (req) => req.user.role === 'admin';

async function rangeOf(db, req, { months = 12 } = {}) {
  const today = await todayFor(db, req.user.practice_id);
  const to = isRealDate(req.query.to) ? req.query.to : today;
  const from = isRealDate(req.query.from) ? req.query.from : addDays(to, -Math.round(months * 30.44));
  if (from > to) throw new HttpError(400, 'from must be on or before to');
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 3 * 366 + 1) throw new HttpError(400, 'Choose at most three years');
  return { from, to };
}

// Office scope for referral lists: the patient must be one the person may see.
const scope = (user) => {
  const s = patientScope(user, 'p');
  if (!restricted(user)) return s;
  return { sql: `${s.sql} AND (x.location_id IS NULL OR x.location_id IN (${user.location_ids.map(() => '?').join(',')}))`, args: [...s.args, ...user.location_ids] };
};

export default function referralTrackerRoutes({ db, storage = null, config = {}, messenger }) {
  const r = Router();
  const needClinicalRead = (req) => {
    if (!can(req.user, 'clinical:read')) throw new HttpError(403, 'You don’t have permission to see charts and documents');
  };
  const load = (req) => loadReferral(db, req.user, req.params.rid);

  // ---- RT1: create in one step ----
  r.post('/referral-tracker/patients/:id/referrals', requirePermission('patients:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const patient = await findOr404(db, 'patients', req.params.id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    if (b.client_key != null && !CLIENT_KEY.test(String(b.client_key))) throw new HttpError(400, 'client_key must be 8-120 letters, digits, dashes, dots or colons');
    const clientKey = b.client_key ? String(b.client_key) : null;
    // The same form sent twice (a double click, a retry): the first referral is the answer.
    const replay = async () => {
      const had = clientKey && await db.get('SELECT id FROM referrals WHERE practice_id = ? AND client_key = ?', pid, clientKey);
      return had ? res.status(200).json({ referral: await detail(db, req.user, had.id), replayed: true }) : null;
    };
    if (await replay()) return;
    const direction = b.direction ?? 'out';
    if (!['in', 'out'].includes(direction)) throw new HttpError(400, 'direction must be in or out');
    const urgency = b.urgency ?? 'routine';
    if (!URGENCIES.includes(urgency)) throw new HttpError(400, `urgency must be one of: ${URGENCIES.join(', ')}`);
    const today = await todayFor(db, pid);
    const date = b.referral_date ?? today;
    if (!isRealDate(date)) throw new HttpError(400, 'referral_date must be a real date (YYYY-MM-DD)');
    if (date > today) throw new HttpError(400, 'referral_date can’t be in the future');
    const reason = b.reason == null ? null : String(b.reason).trim().slice(0, 500) || null;
    const notes = b.notes == null ? null : String(b.notes).trim().slice(0, 2000) || null;
    if (direction === 'out' && !reason && !(Array.isArray(b.items) && b.items.length)) throw new HttpError(400, 'Say what the referral is for (a reason or a procedure)');
    let providerId = b.provider_id ? Number(b.provider_id) : null;
    if (providerId) await findOr404(db, 'providers', providerId, pid, 'Provider');
    // The referring dentist: the patient's own, else the signed-in dentist, else the practice's only dentist.
    else {
      const dentists = await db.all("SELECT id, user_id FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist'", pid);
      providerId = patient.primary_provider_id || dentists.find((d) => d.user_id === req.user.id)?.id || (dentists.length === 1 ? dentists[0].id : null);
    }
    let ownerId = req.user.id;
    if (b.owner_id) {
      const u = await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1', Number(b.owner_id), pid);
      if (!u) throw new HttpError(404, 'That team member wasn’t found');
      ownerId = u.id;
    }
    const docIds = [...new Set((Array.isArray(b.document_ids) ? b.document_ids : []).map(Number))];
    if (docIds.length) {
      needClinicalRead(req);
      if (docIds.length > 20) throw new HttpError(400, 'Attach at most 20 files');
      for (const id of docIds) {
        const d = await db.get('SELECT id, patient_id FROM documents WHERE id = ? AND practice_id = ? AND deleted_at IS NULL', id, pid);
        if (!d || d.patient_id !== patient.id) throw new HttpError(404, 'An attached file isn’t on this patient’s chart');
      }
    }
    const send = b.send ?? (direction === 'out' ? 'print' : 'none');
    if (!['email', 'print', 'fax', 'none'].includes(send)) throw new HttpError(400, 'send must be one of: email, print, fax, none');
    const contact = await contactFor(db, req, b);
    if (!contact.active) throw new HttpError(409, `${contact.name} is marked inactive`);
    const locationId = req.location_id ?? patient.location_id ?? null;
    const items = await cleanItems(db, req, patient, b.items, { date, providerId, locationId });
    const teeth = b.teeth ? String(b.teeth).trim().slice(0, 100) : [...new Set(items.map((i) => i.tooth).filter(Boolean))].join(', ') || null;
    const settings = await getSettings(db, pid);
    let id;
    try {
      id = await db.tx(async () => {
        const rid = await insert(db, 'referrals', {
          practice_id: pid, patient_id: patient.id, contact_id: contact.id, direction, referral_date: date, reason, teeth, urgency, status: 'open', provider_id: providerId, notes,
          created_by: req.user.id, owner_id: ownerId, location_id: locationId, client_key: clientKey, expected_by: direction === 'out' ? expectedBy(date, urgency, settings) : null,
        });
        for (const it of items) await insert(db, 'referral_items', { practice_id: pid, referral_id: rid, ...it });
        for (const d of docIds) await db.run("INSERT INTO referral_documents (practice_id, referral_id, document_id, role, added_by) VALUES (?, ?, ?, 'attachment', ?) ON CONFLICT (referral_id, document_id, role) DO NOTHING", pid, rid, d, req.user.id);
        await logEvent(db, { practiceId: pid, referralId: rid, kind: 'created', to: 'open', onDate: date, note: `${direction === 'out' ? `Referred to ${contact.name}` : `Referred by ${contact.name}`}${urgency !== 'routine' ? ` (${urgency})` : ''}`, userId: req.user.id });
        await audit(db, req, 'referral.create', 'referrals', rid, { direction, urgency, contact_id: contact.id, codes: items.map((i) => i.code), documents: docIds.length, patient_id: patient.id },
          { patientId: patient.id, after: { status: 'open', urgency, contact_id: contact.id, reason } });
        return rid;
      });
    } catch (err) {
      if (/unique|duplicate/i.test(String(err.message)) || err.code === '23505') { if (await replay()) return; }
      throw err;
    }
    // The first referral in becomes the patient's "referred by".
    if (direction === 'in' && !patient.referred_by_id) {
      await recorded(db, 'patients', patient.id, () => db.run('UPDATE patients SET referred_by_id = ?, referral_source = COALESCE(referral_source, ?) WHERE id = ?', contact.id, contact.name, patient.id));
    }
    const ref = await db.get('SELECT * FROM referrals WHERE id = ?', id);
    const out = { letter: null, patient_text: null, alert: null };
    if (direction === 'out') {
      out.letter = await sendLetter(db, req, ref, { channel: send, messenger, config });
      if (b.text_patient ?? !!settings.text_patient) out.patient_text = await tellPatient(db, req, ref, { messenger });
      if (isCritical(ref)) out.alert = await alertCritical(db, ref);
    }
    publish(pid, { type: 'referrals', patient_id: patient.id });
    res.status(201).json({ referral: await detail(db, req.user, id), ...out });
  });

  // Smart defaults for the form: the specialist used last for this kind of work, the planned procedures chosen.
  r.get('/referral-tracker/suggest', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.query.patient_id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const ids = String(req.query.procedure_ids || '').split(',').map(Number).filter(Boolean).slice(0, 30);
    const procs = ids.length ? await db.all(
      `SELECT pr.id AS procedure_id, pc.code, pc.description, pc.category, pr.tooth, pr.surfaces, pr.fee FROM procedures pr JOIN procedure_codes pc ON pc.id = pr.code_id
       WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status = 'planned' AND pr.id IN (${ids.map(() => '?').join(',')})`, pid, patient.id, ...ids,
    ) : [];
    const contactId = await suggestContact(db, pid, [...new Set(procs.map((p) => p.category))]);
    const contact = contactId ? await db.get('SELECT id, name, practice_name, specialty, email, fax, phone FROM referral_contacts WHERE id = ?', contactId) : null;
    const settings = await getSettings(db, pid);
    const planned = await db.all(
      `SELECT pr.id AS procedure_id, pc.code, pc.description, pc.category, pr.tooth, pr.fee FROM procedures pr JOIN procedure_codes pc ON pc.id = pr.code_id
       WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status = 'planned' ORDER BY pr.id LIMIT 50`, pid, patient.id,
    );
    res.json({
      contact, items: procs, planned,
      reason: procs.length ? procs.map((p) => `${p.description}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ') : contact?.specialty ? `Evaluation and treatment (${contact.specialty})` : '',
      provider_id: patient.primary_provider_id || null, send: contact?.email ? 'email' : 'print', text_patient: !!settings.text_patient,
    });
  });

  // ---- Reading ----
  r.get('/referral-tracker/referrals/:rid', requirePermission('patients:read'), async (req, res) => {
    res.json(await detail(db, req.user, req.params.rid));
  });

  // The board: everything open (and closed in the last 90 days), with flags and counts per view.
  const VIEWS = {
    open: (x) => x.direction === 'out' && x.status !== 'closed',
    critical: (x) => x.direction === 'out' && x.status !== 'closed' && x.critical,
    overdue: (x) => x.overdue,
    awaiting: (x) => x.direction === 'out' && x.status !== 'closed' && (x.awaiting_report || x.review_due || !!x.suggestion),
    past_due: (x) => x.direction === 'out' && x.past_due,
    inbound: (x) => x.direction === 'in' && x.status !== 'closed',
    closed: (x) => x.status === 'closed',
  };
  async function boardRows(req, { closedDays = 90, query = req.query } = {}) {
    const pid = req.user.practice_id;
    const today = await todayFor(db, pid);
    const settings = await getSettings(db, pid);
    const s = scope(req.user);
    const conds = [];
    const args = [];
    if (query.urgency) {
      if (!URGENCIES.includes(query.urgency)) throw new HttpError(400, `urgency must be one of: ${URGENCIES.join(', ')}`);
      conds.push(query.urgency === 'critical' ? " AND x.urgency IN ('critical','urgent')" : " AND COALESCE(x.urgency, 'routine') = ?");
      if (query.urgency !== 'critical') args.push(query.urgency);
    }
    for (const [q, col] of [['contact_id', 'x.contact_id'], ['provider_id', 'x.provider_id'], ['patient_id', 'x.patient_id']]) {
      if (query[q] == null || query[q] === '') continue;
      const n = Number(query[q]);
      if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${q} must be an id`);
      conds.push(` AND ${col} = ?`);
      args.push(n);
    }
    const rows = await db.all(
      `${SELECT} WHERE x.practice_id = ? AND (x.status <> 'closed' OR x.closed_at >= ?)${conds.join('')}${s.sql} ORDER BY x.id DESC LIMIT 2000`,
      pid, `${addDays(today, -closedDays)} 00:00:00`, ...args, ...s.args,
    );
    const ids = rows.map((x) => x.id);
    const suggestions = new Map();
    const ready = new Map();
    if (ids.length && can(req.user, 'clinical:read')) {
      for (const m of await db.all(
        `SELECT m.id, m.referral_id, m.document_id, m.reason, m.source, m.score, d.filename FROM referral_report_matches m JOIN documents d ON d.id = m.document_id
         WHERE m.practice_id = ? AND m.status = 'suggested' AND d.deleted_at IS NULL ORDER BY m.score DESC`, pid,
      )) if (!suggestions.has(m.referral_id)) suggestions.set(m.referral_id, m);
    }
    // Referred to us: ready to report back once treatment since the referral is done and nothing is left planned.
    for (const x of rows.filter((y) => y.direction === 'in' && y.status !== 'closed')) {
      const t = await treatmentSince(db, x.patient_id, String(x.referral_date).slice(0, 10));
      ready.set(x.id, t.some((p) => p.status === 'completed') && !t.some((p) => p.status === 'planned'));
    }
    return {
      today, settings,
      rows: rows.map((x) => ({ ...decorate(x, today, settings), link_token_hash: undefined, suggestion: suggestions.get(x.id) || null, ready_to_report_back: ready.get(x.id) || false })),
    };
  }
  const rank = (x) => (x.alerting ? 0 : x.suggestion ? 1 : x.review_due ? 2 : x.overdue ? 3 : x.past_due ? 4 : 5);

  r.get('/referral-tracker/board', requirePermission('patients:read'), async (req, res) => {
    const view = req.query.view || 'open';
    if (!VIEWS[view]) throw new HttpError(400, `view must be one of: ${Object.keys(VIEWS).join(', ')}`);
    const { rows, settings, today } = await boardRows(req);
    const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, f]) => [k, rows.filter(f).length]));
    const list = rows.filter(VIEWS[view]).sort((a, b) => rank(a) - rank(b) || (b.days_open ?? 0) - (a.days_open ?? 0) || b.id - a.id);
    res.json({ view, today, counts, past_due_days: settings.past_due_days, rows: list, close_reasons: CLOSE_REASONS, status_labels: STATUS_LABELS });
  });

  // Past-due report: outgoing referrals open longer than the setting (default 30 days), filterable; CSV on request.
  r.get('/referral-tracker/past-due', requirePermission('patients:read'), async (req, res) => {
    const { rows, settings } = await boardRows(req, { closedDays: 0 });
    const days = req.query.days ? Number(req.query.days) : settings.past_due_days;
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HttpError(400, 'days must be a whole number');
    const list = rows.filter((x) => x.direction === 'out' && x.status !== 'closed' && x.days_open >= days).sort((a, b) => b.days_open - a.days_open);
    await audit(db, req, 'referral.past_due_report', 'referrals', null, { rows: list.length, days, csv: req.query.format === 'csv' });
    if (req.query.format === 'csv') {
      const csv = toCsv(list, [
        ['Patient', (x) => `${x.first_name} ${x.last_name}`], ['Specialist', (x) => x.contact_name], ['Specialty', (x) => x.specialty], ['Urgency', (x) => x.urgency || 'routine'],
        ['Status', (x) => x.status_label], ['Referred', (x) => x.referral_date], ['Days open', (x) => x.days_open], ['Expected by', (x) => x.expected_by], ['Dentist', (x) => x.provider_name], ['Reason', (x) => x.reason],
      ]);
      return res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="referrals-past-due.csv"' }).send(csv);
    }
    res.json({ days, rows: list });
  });

  // For the patient bar chip and the chart.
  r.get('/referral-tracker/patients/:id/flags', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const { rows } = await boardRows(req, { closedDays: 0, query: { patient_id: String(patient.id) } });
    const open = rows.filter((x) => x.status !== 'closed');
    res.json({
      open: open.length, critical: open.filter((x) => x.critical && x.direction === 'out').length, alerting: open.filter((x) => x.alerting).length, overdue: open.filter((x) => x.overdue).length,
      reports: open.filter((x) => x.suggestion || x.review_due).length,
      referrals: open.map((x) => ({ id: x.id, direction: x.direction, contact_name: x.contact_name, specialty: x.specialty, urgency: x.urgency, critical: x.critical, status: x.status, status_label: x.status_label, days_open: x.days_open, overdue: x.overdue })),
    });
  });

  // For the huddle: open referrals of the day's patients, and every critical one not seen yet.
  r.get('/referral-tracker/huddle', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = isRealDate(req.query.date) ? req.query.date : await todayFor(db, pid);
    const onDay = new Set((await db.all("SELECT DISTINCT patient_id FROM appointments WHERE practice_id = ? AND substr(start_time, 1, 10) = ? AND status NOT IN ('cancelled','no_show')", pid, date)).map((a) => a.patient_id));
    const { rows } = await boardRows(req, { closedDays: 0 });
    const open = rows.filter((x) => x.status !== 'closed');
    res.json({
      date,
      on_schedule: open.filter((x) => onDay.has(x.patient_id)).sort((a, b) => rank(a) - rank(b)),
      critical: open.filter((x) => x.alerting).sort((a, b) => (b.days_open ?? 0) - (a.days_open ?? 0)),
      reports_to_review: open.filter((x) => x.review_due || x.suggestion).length,
    });
  });

  // ---- RT2: moving it along ----
  r.post('/referral-tracker/referrals/:rid/status', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    await setStatus(db, req, ref, { status: req.body?.status, on: req.body?.on || null, note: req.body?.note ? String(req.body.note).slice(0, 500) : null });
    res.json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/referrals/:rid/close', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    if (req.body?.document_id) needClinicalRead(req);
    await closeReferral(db, req, ref, { reason: req.body?.reason, note: req.body?.note ? String(req.body.note).trim().slice(0, 500) : null, documentId: req.body?.document_id || null });
    res.json(await detail(db, req.user, ref.id));
  });
  // One click: the report is linked (if given) and the referral is closed as completed.
  r.post('/referral-tracker/referrals/:rid/complete', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    const docId = req.body?.document_id || ref.report_document_id;
    if (!docId) throw new HttpError(400, 'Attach the specialist’s report to mark it complete (or close it with another reason)');
    needClinicalRead(req);
    await closeReferral(db, req, ref, { reason: 'completed', documentId: req.body?.document_id && Number(req.body.document_id) !== ref.report_document_id ? req.body.document_id : null });
    res.json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/referrals/:rid/reopen', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    await reopenReferral(db, req, ref, { note: req.body?.note ? String(req.body.note).trim().slice(0, 500) : null });
    res.json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/referrals/:rid/urgency', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    if (ref.status === 'closed') throw new HttpError(409, 'This referral is closed');
    await setUrgency(db, req, ref, { urgency: req.body?.urgency, note: req.body?.note ? String(req.body.note).slice(0, 500) : null });
    res.json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/referrals/:rid/note', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    if (!note) throw new HttpError(400, 'Write the note');
    await logEvent(db, { practiceId: ref.practice_id, referralId: ref.id, kind: 'note', note, userId: req.user.id });
    await audit(db, req, 'referral.note', 'referrals', ref.id, { patient_id: ref.patient_id }, { patientId: ref.patient_id });
    res.status(201).json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/referrals/:rid/send', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    if (ref.status === 'closed') throw new HttpError(409, 'This referral is closed');
    const letter = await sendLetter(db, req, ref, { channel: req.body?.channel || 'print', messenger, config });
    await audit(db, req, 'referral.letter_sent', 'referrals', ref.id, { channel: letter.channel, status: letter.status, patient_id: ref.patient_id }, { patientId: ref.patient_id });
    res.json({ letter, referral: await detail(db, req.user, ref.id) });
  });
  r.post('/referral-tracker/referrals/:rid/tell-patient', requirePermission('patients:write'), async (req, res) => {
    const ref = await load(req);
    if (ref.direction !== 'out') throw new HttpError(400, 'Only for referrals out');
    const out = await tellPatient(db, req, ref, { messenger });
    await audit(db, req, 'referral.patient_told', 'referrals', ref.id, { status: out.status, patient_id: ref.patient_id }, { patientId: ref.patient_id });
    res.json(out);
  });

  // ---- RT3: the report back ----
  r.post('/referral-tracker/referrals/:rid/report', requirePermission('patients:write'), async (req, res) => {
    needClinicalRead(req);
    let ref = await load(req);
    if (!req.body?.document_id) throw new HttpError(400, 'Choose the document');
    ref = await linkReport(db, req, ref, req.body.document_id);
    if (req.body.complete) await closeReferral(db, req, ref, { reason: 'completed' });
    res.json(await detail(db, req.user, ref.id));
  });
  // Documents on this patient's chart that could be the report (newest first).
  r.get('/referral-tracker/referrals/:rid/report-options', requirePermission('patients:read'), async (req, res) => {
    needClinicalRead(req);
    const ref = await load(req);
    res.json(await db.all(
      `SELECT d.id, d.filename, d.category, d.created_at, CASE WHEN d.category IN ('referral','correspondence') THEN 1 ELSE 0 END AS likely FROM documents d
       WHERE d.practice_id = ? AND d.patient_id = ? AND d.deleted_at IS NULL AND d.category NOT IN ('xray','photo') ORDER BY likely DESC, d.id DESC LIMIT 30`, ref.practice_id, ref.patient_id,
    ));
  });
  r.post('/referral-tracker/matches/:mid/confirm', requirePermission('patients:write'), async (req, res) => {
    needClinicalRead(req);
    const ref = await confirmMatch(db, req, req.params.mid, { complete: !!req.body?.complete });
    res.json(await detail(db, req.user, ref.id));
  });
  r.post('/referral-tracker/matches/:mid/dismiss', requirePermission('patients:write'), async (req, res) => {
    needClinicalRead(req);
    res.json(await dismissMatch(db, req, req.params.mid));
  });
  r.post('/referral-tracker/referrals/:rid/reviewed', requirePermission('clinical:write'), async (req, res) => {
    const ref = await load(req);
    await markReviewed(db, req, ref);
    res.json(await detail(db, req.user, ref.id));
  });

  // ---- RT4: referred to us ----
  for (const [path, kind] of [['thank-you', 'thank_you'], ['report-back', 'report_back']]) {
    r.get(`/referral-tracker/referrals/:rid/${path}`, requirePermission('patients:read'), async (req, res) => {
      const ref = await load(req);
      if (ref.direction !== 'in') throw new HttpError(400, 'Only for patients referred to us');
      const l = await letterFor(db, ref, kind, { note: req.query.note ? String(req.query.note).slice(0, 1000) : '' });
      res.json({ text: l.text, practice: l.practice, contact: { name: l.referral.contact_name, practice_name: l.referral.contact_practice }, treatment: l.treatment });
    });
    r.post(`/referral-tracker/referrals/:rid/${path}`, requirePermission('patients:write'), async (req, res) => {
      const ref = await load(req);
      res.json(await sendInboundLetter(db, req, ref, kind, { channel: req.body?.channel || 'print', note: req.body?.note ? String(req.body.note).slice(0, 1000) : '', messenger, config, resend: !!req.body?.resend }));
    });
  }
  r.get('/referral-tracker/sources', requirePermission('reports:read'), async (req, res) => {
    res.json(await sourceStats(db, req.user, await rangeOf(db, req)));
  });

  // ---- RT5: what if we did it in house ----
  r.get('/referral-tracker/opportunity', requirePermission('reports:read'), async (req, res) => {
    const out = await inHouseOpportunity(db, req.user, await rangeOf(db, req));
    await audit(db, req, 'report.referral_opportunity', 'referrals', null, { from: out.from, to: out.to });
    res.json({ ...out, categories: CATEGORY_LABELS });
  });

  // ---- Settings and the job ----
  r.get('/referral-tracker/settings', requirePermission('patients:read'), async (req, res) => {
    res.json({ ...(await getSettings(db, req.user.practice_id)), close_reasons: CLOSE_REASONS, can_edit: isAdmin(req) });
  });
  r.put('/referral-tracker/settings', async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Only an administrator can change referral settings');
    res.json(await saveSettings(db, req, req.body));
  });
  // Runs the follow-up now for this practice (the server also runs it on a timer).
  r.post('/referral-tracker/run', async (req, res) => {
    if (!isAdmin(req)) throw new HttpError(403, 'Only an administrator can run this');
    res.json(await runReferralJobs(db, { storage, config, practiceId: req.user.practice_id }));
  });

  return r;
}

// ---- The specialist's secure link (no sign-in; the token is the key) ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function referralPublicRoutes({ db, storage, config = {} }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 60, name: 'referral-link' });
  const scanner = config.virusScanner || createVirusScanner();
  const byToken = async (token) => {
    const ref = await db.get('SELECT * FROM referrals WHERE link_token_hash = ?', hashToken(String(token)));
    if (!ref || !ref.link_expires || ref.link_expires < new Date().toISOString()) throw new HttpError(404, 'This link has expired — ask the office to send it again');
    const full = await db.get(`${SELECT} WHERE x.id = ?`, ref.id);
    setActor({ source: 'integration', actor: `Specialist link: ${full.contact_name}`, practiceId: ref.practice_id });
    return full;
  };
  const who = (req, ref) => ({ ip: req.ip, user: { practice_id: ref.practice_id, id: null } });

  async function view(ref) {
    const patient = await db.get('SELECT first_name, last_name, dob, phone, medical_alerts, allergies, medications, premed_required FROM patients WHERE id = ?', ref.patient_id);
    const practice = await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', ref.practice_id);
    const base = { practice, contact: { name: ref.contact_name, practice_name: ref.contact_practice }, direction: ref.direction, status: ref.status, urgency: ref.urgency, referral_date: ref.referral_date };
    if (ref.direction === 'in') {
      const l = await letterFor(db, ref, 'report_back');
      return { ...base, patient: { name: `${patient.first_name} ${patient.last_name}` }, letter: l.text };
    }
    return {
      ...base,
      patient: { name: `${patient.first_name} ${patient.last_name}`, dob: patient.dob, phone: patient.phone, medical_alerts: patient.medical_alerts, allergies: patient.allergies, medications: patient.medications, premed_required: !!patient.premed_required },
      reason: ref.reason, teeth: ref.teeth, notes: ref.notes, provider: ref.provider_name,
      items: await db.all('SELECT i.code, i.tooth, pc.description FROM referral_items i LEFT JOIN procedure_codes pc ON pc.practice_id = i.practice_id AND pc.code = i.code WHERE i.referral_id = ? ORDER BY i.id', ref.id),
      insurance: await db.get(
        `SELECT c.name AS carrier_name, pi.subscriber_id, pi.group_number FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
         WHERE pi.patient_id = ? AND pi.active = 1 ORDER BY CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1`, ref.patient_id,
      ),
      files: await db.all("SELECT d.id, d.filename, d.mime FROM referral_documents rd JOIN documents d ON d.id = rd.document_id WHERE rd.referral_id = ? AND rd.role = 'attachment' AND d.deleted_at IS NULL", ref.id),
      report_received: !!ref.report_document_id, scheduled_on: ref.scheduled_on, seen_on: ref.seen_on,
    };
  }

  r.get('/referral/:token', limiter, async (req, res) => {
    const ref = await byToken(req.params.token);
    await audit(db, who(req, ref), 'referral_link.view', 'referrals', ref.id, null, { source: 'integration', actor: `Specialist link: ${ref.contact_name}`, patientId: ref.patient_id });
    res.json(await view(ref));
  });

  // A plain page for the specialist (no app to install): the letter, the files, "scheduled"/"seen", and the report upload.
  r.get('/referral/:token/view', limiter, async (req, res) => {
    const ref = await byToken(req.params.token);
    await audit(db, who(req, ref), 'referral_link.view', 'referrals', ref.id, null, { source: 'integration', actor: `Specialist link: ${ref.contact_name}`, patientId: ref.patient_id });
    const v = await view(ref);
    const nonce = hashToken(`${Date.now()}${Math.random()}`).slice(0, 24);
    const t = esc(req.params.token);
    const body = v.direction === 'in'
      ? `<pre>${esc(v.letter)}</pre>`
      : `<p><b>Patient:</b> ${esc(v.patient.name)}${v.patient.dob ? ` · born ${esc(v.patient.dob)}` : ''}${v.patient.phone ? ` · ${esc(v.patient.phone)}` : ''}</p>
      ${isCritical(ref) ? '<p class="urgent">URGENT — please see this patient as soon as possible.</p>' : ''}
      <p><b>Reason:</b> ${esc(v.reason || '')}${v.teeth ? ` · Teeth: ${esc(v.teeth)}` : ''}</p>
      ${v.items.length ? `<ul>${v.items.map((i) => `<li>${esc(i.code)} ${esc(i.description || '')}${i.tooth ? ` #${esc(i.tooth)}` : ''}</li>`).join('')}</ul>` : ''}
      ${v.notes ? `<p><b>Notes:</b> ${esc(v.notes)}</p>` : ''}
      <p><b>Medical:</b> ${esc([v.patient.medical_alerts, v.patient.allergies && `Allergies: ${v.patient.allergies}`, v.patient.medications && `Medications: ${v.patient.medications}`, v.patient.premed_required && 'Premedication required'].filter(Boolean).join(' · ') || 'None noted')}</p>
      ${v.insurance ? `<p><b>Insurance:</b> ${esc(v.insurance.carrier_name)} · ID ${esc(v.insurance.subscriber_id || '')}${v.insurance.group_number ? ` · group ${esc(v.insurance.group_number)}` : ''}</p>` : ''}
      <p><b>Referring dentist:</b> ${esc(v.provider || v.practice.name)}</p>
      ${v.files.length ? `<h3>Files</h3><ul>${v.files.map((f) => `<li><a href="/api/public/referral/${t}/files/${f.id}">${esc(f.filename)}</a></li>`).join('')}</ul>` : ''}
      <h3>Let us know</h3>
      <p>${v.seen_on ? `Seen ${esc(v.seen_on)}.` : v.scheduled_on ? `Scheduled for ${esc(v.scheduled_on)}.` : 'Not scheduled yet.'}</p>
      <p><label>Appointment date <input type="date" id="d"></label> <button id="sch">Scheduled</button> <button id="seen">Patient seen</button></p>
      <h3>Send your report</h3>
      <p>${v.report_received ? 'Thank you — we have your report.' : ''}<input type="file" id="f" accept=".pdf,image/*"> <button id="up">Upload report</button></p>
      <p id="msg" role="status"></p>
      <script nonce="${nonce}">
        const say = (t) => { document.getElementById('msg').textContent = t; };
        const post = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); say(r.ok ? 'Thank you — the office has been told.' : (j.error || 'That didn’t work — please call the office.')); };
        document.getElementById('sch').onclick = () => post('/api/public/referral/${t}/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'scheduled', date: document.getElementById('d').value || null }) });
        document.getElementById('seen').onclick = () => post('/api/public/referral/${t}/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'seen', date: document.getElementById('d').value || null }) });
        document.getElementById('up').onclick = () => { const f = document.getElementById('f').files[0]; if (!f) return say('Choose the report file first.'); post('/api/public/referral/${t}/report?filename=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f }); };
      </script>`;
    res.set({
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    }).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
      <title>Referral from ${esc(v.practice.name)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1f2937}h1{font-size:20px}.urgent{color:#b91c1c;font-weight:700}pre{white-space:pre-wrap;font:inherit}button{padding:6px 12px}</style></head>
      <body><h1>${v.direction === 'in' ? 'Treatment update' : 'Referral'} from ${esc(v.practice.name)}</h1><p>To ${esc(v.contact.name)}${v.contact.practice_name ? `, ${esc(v.contact.practice_name)}` : ''} · ${esc(String(v.referral_date).slice(0, 10))}</p>
      ${body}<p style="color:#6b7280;font-size:13px">${esc(v.practice.name)}${v.practice.phone ? ` · ${esc(v.practice.phone)}` : ''}</p></body></html>`);
  });

  r.get('/referral/:token/files/:did', limiter, async (req, res) => {
    const ref = await byToken(req.params.token);
    const did = Number(req.params.did);
    const link = await db.get("SELECT d.* FROM referral_documents rd JOIN documents d ON d.id = rd.document_id WHERE rd.referral_id = ? AND rd.document_id = ? AND rd.role = 'attachment' AND d.deleted_at IS NULL", ref.id, did);
    if (!link || link.patient_id !== ref.patient_id) throw new HttpError(404, 'File not found');
    const data = await storage.read(link.storage_key, !!link.encrypted);
    await audit(db, who(req, ref), 'referral_link.download', 'documents', link.id, { referral_id: ref.id }, { source: 'integration', actor: `Specialist link: ${ref.contact_name}`, patientId: ref.patient_id });
    res.set({ 'Content-Type': link.mime || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${String(link.filename).replace(/["\r\n]/g, '')}"`, 'Cache-Control': 'no-store' }).send(data);
  });

  r.post('/referral/:token/status', limiter, async (req, res) => {
    const ref = await byToken(req.params.token);
    if (ref.direction !== 'out' || ref.status === 'closed') throw new HttpError(409, 'This referral is closed');
    const status = req.body?.status;
    if (!['scheduled', 'seen'].includes(status)) throw new HttpError(400, 'status must be scheduled or seen');
    const on = req.body?.date || null;
    if (on && !isRealDate(on)) throw new HttpError(400, 'date must be a real date');
    // Never moves a referral backwards (a report already back stays back).
    const order = ['open', 'scheduled', 'seen', 'report_received'];
    if (order.indexOf(status) < order.indexOf(ref.status)) return res.json({ ok: true, status: ref.status });
    await setStatus(db, who(req, ref), ref, { status, on, note: `From ${ref.contact_name}’s office (secure link)` });
    res.json({ ok: true, status });
  });

  const raw = (req, res, next) => express.raw({ type: () => true, limit: readLimitFor(String(req.query.filename || 'report.pdf')) })(req, res, next);
  r.post('/referral/:token/report', limiter, raw, async (req, res) => {
    const ref = await byToken(req.params.token);
    if (ref.direction !== 'out' || ref.status === 'closed') throw new HttpError(409, 'This referral is closed — call the office');
    const up = await storeUpload(db, storage, {
      req: who(req, ref), practiceId: ref.practice_id, patientId: ref.patient_id, scope: 'patient', body: req.body, filename: String(req.query.filename || 'report.pdf').slice(0, 200),
      declared: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), category: 'referral', notes: `Report from ${ref.contact_name} (secure link)`, uploadedBy: null, source: 'referral_link', scanner,
    });
    // The link was made for this referral, so its report is linked straight away (the dentist still reviews it).
    await linkReport(db, who(req, ref), ref, up.id, { source: 'link', note: `Report uploaded by ${ref.contact_name}’s office` });
    publish(ref.practice_id, { type: 'documents', patient_id: ref.patient_id });
    res.status(201).json({ ok: true });
  });

  return r;
}

