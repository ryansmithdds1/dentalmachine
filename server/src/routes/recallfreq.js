// Recall types and frequencies (RF1–RF4, docs/workflows/specs/RF-recall-frequencies.md): a patient's recall
// status, what to bundle into a hygiene visit, per-patient interval overrides and cleaning-type switches (with a
// reason, audited), work done at another office, the office-wide recall board with its export, finding and
// merging duplicate recalls, and the practice's recall settings.
import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { insert, audit, findOr404, practiceNow, paged, toCsv, isRealDate, recorded } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { withActor } from '../actor.js';
import { officeFee } from '../fees.js';
import { recallTypes } from '../recalls.js';
import {
  applyAgeRules, healRecallResets, setRecallInterval, switchRecallType, addOutsideWork, voidOutsideWork, findDuplicateRecalls,
} from '../recallsync.js';
import { patientRecallStatus, bundleForVisit, isHygieneVisit, recallBoard, recallSettings, STATUSES } from '../recallfreq.js';
import { linkRecalls } from './schedule.js';

const ACTIVE_VISIT = ['scheduled', 'confirmed', 'checked_in', 'in_chair'];
const reasonOf = (body, what = 'a reason') => {
  const reason = String(body?.reason ?? '').trim();
  if (reason.length < 3) throw new HttpError(400, `Give ${what} (a few words)`);
  return reason.slice(0, 300);
};

export default function recallFreqRoutes({ db }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const admin = (req) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change recall settings');
  };
  const patientOf = async (req, id = req.params.id) => {
    const p = await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    return p;
  };
  const recallOf = async (req) => {
    const rc = await findOr404(db, 'recalls', req.params.id, req.user.practice_id, 'Recall');
    if (!(await canSeePatient(db, req.user, rc.patient_id))) throw new HttpError(404, 'Recall not found');
    return rc;
  };

  // ---- One patient (RF3) ----
  // Each type: last done (date, code, where), due, status, when insurance pays again (and the plan's rule), and
  // the next visit. Resets whose procedure was un-completed and the age rule are brought up to date first.
  r.get('/patients/:id/recall-status', requirePermission('patients:read'), async (req, res) => {
    const p = await patientOf(req);
    const day = await today(req);
    const date = req.query.date ? String(req.query.date) : null;
    if (date && !isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    // Kept current by the system, not by whoever opened the chart: recorded as automation.
    await withActor({ source: 'automation', actor: 'Recall upkeep', practiceId: req.user.practice_id }, async () => {
      await healRecallResets(db, req.user.practice_id, { patientId: p.id });
      await applyAgeRules(db, req.user.practice_id, day, { patientId: p.id });
    });
    res.json(await patientRecallStatus(db, req.user.practice_id, p.id, { today: day, date }));
  });

  // What to add to a hygiene visit (x-rays, exam, fluoride due by then), for the booking form. Read-only.
  // ?date= the visit's day; appointment_type_id / provider_id say whether it's a hygiene visit (?all=1: any).
  r.get('/patients/:id/recall-bundle', requirePermission('schedule:read'), async (req, res) => {
    const p = await patientOf(req);
    const pid = req.user.practice_id;
    const day = await today(req);
    const date = req.query.date ? String(req.query.date) : day;
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const typeId = Number(req.query.appointment_type_id) || null;
    const providerId = Number(req.query.provider_id) || null;
    if (typeId) await findOr404(db, 'appointment_types', typeId, pid, 'Appointment type');
    if (providerId) await findOr404(db, 'providers', providerId, pid, 'Provider');
    const appointmentId = Number(req.query.appointment_id) || null;
    if (appointmentId && (await findOr404(db, 'appointments', appointmentId, pid, 'Appointment')).patient_id !== p.id) throw new HttpError(404, 'Appointment not found');
    const hygiene = req.query.all === '1' || await isHygieneVisit(db, pid, { appointmentTypeId: typeId, providerId });
    if (!hygiene) return res.json({ patient_id: p.id, date, hygiene: false, items: [] });
    const out = await bundleForVisit(db, pid, p.id, { today: day, date: date < day ? day : date, appointmentId, providerId, locationId: req.location_id ?? p.location_id ?? null });
    res.json({ ...out, hygiene: true });
  });

  // Adds the chosen bundle codes to a booked visit as planned work (no charge until completed) and links the
  // recalls they cover. A repeat (double click, retry) adds nothing twice.
  r.post('/appointments/:id/recall-bundle', requirePermission('schedule:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const appt = await findOr404(db, 'appointments', req.params.id, pid, 'Appointment');
    if (!(await canSeePatient(db, req.user, appt.patient_id))) throw new HttpError(404, 'Appointment not found');
    if (!ACTIVE_VISIT.includes(appt.status)) throw new HttpError(409, 'This visit was cancelled, missed or finished — add them to another visit');
    const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c).trim().toUpperCase()))];
    if (!codes.length || codes.length > 8) throw new HttpError(400, 'Choose one to eight codes to add');
    const types = (await recallTypes(db, pid)).filter((t) => t.active && t.bundle);
    for (const c of codes) {
      if (!/^D\d{4}$/.test(c)) throw new HttpError(400, `${c.slice(0, 12)} isn't a procedure code`);
      if (!types.some((t) => t.codes.some((x) => c.startsWith(x)))) throw new HttpError(400, `${c} isn't an x-ray, exam or fluoride recall code`);
    }
    const out = await db.tx(async () => {
      const added = [];
      const skipped = [];
      for (const c of codes) {
        const code = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, c);
        if (!code) throw new HttpError(400, `${c} isn't in your procedure codes`);
        if (await db.get("SELECT id FROM procedures WHERE appointment_id = ? AND code = ? AND status IN ('planned','completed')", appt.id, c)) { skipped.push(c); continue; }
        added.push(await insert(db, 'procedures', {
          practice_id: pid, patient_id: appt.patient_id, appointment_id: appt.id, provider_id: appt.provider_id, location_id: appt.location_id ?? null,
          code_id: code.id, code: code.code, description: code.description, category: code.category,
          fee: await officeFee(db, pid, code, { patientId: appt.patient_id, providerId: appt.provider_id, locationId: appt.location_id }),
        }));
      }
      if (added.length) await linkRecalls(db, pid, appt.id);
      return { added, skipped };
    });
    if (out.added.length) await audit(db, req, 'recall.bundle', 'appointments', appt.id, { codes, added: out.added, skipped: out.skipped }, { patientId: appt.patient_id });
    res.status(out.added.length ? 201 : 200).json({ ...out, procedures: out.added.length ? await db.all(`SELECT * FROM procedures WHERE id IN (${out.added.map(() => '?').join(',')})`, ...out.added) : [] });
  });

  // ---- Per patient changes (RF1–RF2), each with a reason ----
  // A different interval for this patient (e.g. perio every 4 months), or interval_months: null for the type's own.
  r.put('/recalls/:id/interval', requirePermission('clinical:write'), async (req, res) => {
    const rc = await recallOf(req);
    const reason = reasonOf(req.body, 'the reason for a different interval');
    const months = req.body?.interval_months == null || req.body.interval_months === '' ? null : Number(req.body.interval_months);
    const after = await setRecallInterval(db, rc, months, reason);
    await audit(db, req, 'recall.interval', 'recalls', rc.id, { type: rc.type, reason }, {
      reason, patientId: rc.patient_id,
      before: { interval_months: rc.interval_months, due_date: rc.due_date }, after: { interval_months: after.interval_months, due_date: after.due_date },
    });
    res.json(after);
  });

  // Switch the patient's cleaning type (to perio maintenance, or back). The prophy recall is retired, not removed.
  r.post('/patients/:id/recalls/switch', requirePermission('clinical:write'), async (req, res) => {
    const p = await patientOf(req);
    const reason = reasonOf(req.body, 'the reason for the switch');
    const day = await today(req);
    const out = await db.tx(() => switchRecallType(db, req.user.practice_id, p.id, String(req.body?.to || ''), reason, day));
    await audit(db, req, 'recall.switch', 'recalls', out.recall.id, { to: out.recall.type, retired: out.retired, reason }, { reason, patientId: p.id });
    res.json(out);
  });

  // Work done at another office (x-rays taken elsewhere…): code (or a recall type's key) and date.
  r.get('/patients/:id/outside-procedures', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientOf(req);
    res.json(await db.all(
      'SELECT o.*, u.name AS created_by_name FROM recall_outside o LEFT JOIN users u ON u.id = o.created_by WHERE o.practice_id = ? AND o.patient_id = ? ORDER BY o.done_on DESC, o.id DESC',
      req.user.practice_id, p.id,
    ));
  });
  r.post('/patients/:id/outside-procedures', requirePermission('clinical:write'), async (req, res) => {
    const p = await patientOf(req);
    const pid = req.user.practice_id;
    let code = req.body?.code;
    if (!code && req.body?.type) {
      const t = (await recallTypes(db, pid)).find((x) => x.key === String(req.body.type) && x.active);
      if (!t) throw new HttpError(400, 'Unknown recall type');
      code = t.codes[0];
    }
    const out = await addOutsideWork(db, {
      practiceId: pid, patientId: p.id, code, date: String(req.body?.date || ''), officeName: req.body?.office_name, note: req.body?.note, userId: req.user.id, today: await today(req),
    });
    if (!out.already) {
      await audit(db, req, 'recall.outside_add', 'recall_outside', out.entry.id, { code: out.entry.code, date: out.entry.done_on, office: out.entry.office_name, source: 'outside' }, { patientId: p.id });
    }
    res.status(out.already ? 200 : 201).json({ ...out.entry, already: out.already });
  });
  r.post('/outside-procedures/:oid/void', requirePermission('clinical:write'), async (req, res) => {
    const entry = await findOr404(db, 'recall_outside', req.params.oid, req.user.practice_id, 'Outside entry');
    if (!(await canSeePatient(db, req.user, entry.patient_id))) throw new HttpError(404, 'Outside entry not found');
    const reason = reasonOf(req.body, 'the reason for voiding it');
    await voidOutsideWork(db, entry, { userId: req.user.id, reason });
    await audit(db, req, 'recall.outside_void', 'recall_outside', entry.id, { code: entry.code, date: entry.done_on }, { reason, patientId: entry.patient_id });
    res.json(await db.get('SELECT * FROM recall_outside WHERE id = ?', entry.id));
  });

  // Mark a recall contacted (the board's one-key action): the recall list shows it, and the call log has a line.
  r.post('/recalls/:id/contacted', requirePermission('schedule:write'), async (req, res) => {
    const rc = await recallOf(req);
    if (!['due', 'contacted'].includes(rc.status)) throw new HttpError(409, 'Only a recall that is due can be marked contacted');
    const outcome = ['left_voicemail', 'texted', 'emailed', 'spoke_will_call', 'note'].includes(req.body?.outcome) ? req.body.outcome : 'note';
    const note = String(req.body?.note || 'Marked contacted from the recall board').slice(0, 300);
    await recorded(db, 'recalls', rc.id, () => db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ?", rc.id));
    await insert(db, 'followups', { practice_id: req.user.practice_id, patient_id: rc.patient_id, kind: 'recall', outcome, note, created_by: req.user.id });
    await audit(db, req, 'recall.contacted', 'recalls', rc.id, { outcome }, { patientId: rc.patient_id });
    res.json({ ...(await db.get('SELECT * FROM recalls WHERE id = ?', rc.id)), previous_status: rc.status });
  });

  // ---- Office-wide (RF4) ----
  const boardFilters = async (req) => {
    const q = req.query;
    const pid = req.user.practice_id;
    if (q.status && !STATUSES.includes(q.status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
    if (q.provider_id) await findOr404(db, 'providers', q.provider_id, pid, 'Provider');
    if (q.location_id) await findOr404(db, 'locations', q.location_id, pid, 'Office');
    if (q.type && !(await recallTypes(db, pid)).some((t) => t.key === q.type)) throw new HttpError(400, 'Unknown recall type');
    await withActor({ source: 'automation', actor: 'Recall upkeep', practiceId: pid }, () => healRecallResets(db, pid));
    return {
      today: await today(req), type: q.type || null, status: q.status || null, providerId: Number(q.provider_id) || null,
      locationId: Number(q.location_id) || null, search: q.q ? String(q.q).slice(0, 60) : null,
    };
  };
  r.get('/recall-board', requirePermission('schedule:read'), async (req, res) => {
    const board = await recallBoard(db, req.user, await boardFilters(req));
    const rows = paged(req, res, board.rows, { dflt: 300, max: 2000 });
    res.json({ ...board, rows, total: board.rows.length });
  });
  // Patient phone numbers and emails leave the building: reports permission, and audited.
  r.get('/recall-board/export.csv', async (req, res) => {
    if (req.user.role !== 'admin' && !can(req.user, 'reports:read')) throw new HttpError(403, 'Exporting the recall list needs reports permission');
    const board = await recallBoard(db, req.user, await boardFilters(req));
    await audit(db, req, 'recall_board.export', 'recalls', null, { rows: board.rows.length, type: req.query.type || null, status: req.query.status || null });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="recall-list-${board.today}.csv"`, 'Cache-Control': 'no-store' });
    res.send(toCsv(board.rows, [
      ['Patient', (x) => x.name], ['Phone', (x) => x.phone], ['Email', (x) => x.email], ['Recall', (x) => x.type_name], ['Due', (x) => x.due_date],
      ['Status', (x) => x.status_label], ['Also due', (x) => x.also_due.map((a) => a.short).join(' ')], ['Days overdue', (x) => x.days_overdue || ''], ['Last done', (x) => x.last_done_date], ['Last code', (x) => x.last_done_code],
      ['Booked for', (x) => (x.scheduled_for || '').slice(0, 16)], ['Last contacted', (x) => (x.contacted_at || '').slice(0, 10)], ['Provider', (x) => x.provider_name], ['Office', (x) => x.location_name],
    ]));
  });

  // Duplicate recalls (merged charts, two cleaning types at once): preview, then merge (administrators).
  r.get('/recall-board/duplicates', requirePermission('schedule:read'), async (req, res) => {
    admin(req);
    res.json(await findDuplicateRecalls(db, req.user.practice_id, { today: await today(req) }));
  });
  r.post('/recall-board/duplicates/merge', requirePermission('schedule:write'), async (req, res) => {
    admin(req);
    const day = await today(req);
    const actions = await db.tx(() => findDuplicateRecalls(db, req.user.practice_id, { today: day, apply: true }));
    await audit(db, req, 'recall.merge_duplicates', 'recalls', null, { merged: actions.filter((a) => a.kind !== 'review').length, review: actions.filter((a) => a.kind === 'review').length });
    res.json(actions);
  });

  // ---- Settings (administrators, audited) ----
  r.get('/recall-settings', requirePermission('schedule:read'), async (req, res) => {
    res.json({ ...(await recallSettings(db, req.user.practice_id)), types: await recallTypes(db, req.user.practice_id) });
  });
  r.put('/recall-settings', requirePermission('schedule:write'), async (req, res) => {
    admin(req);
    const patch = {};
    for (const [k, col] of [['due_soon_days', 'recall_due_soon_days'], ['overdue_days', 'recall_overdue_days']]) {
      if (req.body?.[k] == null) continue;
      const n = Number(req.body[k]);
      if (!Number.isInteger(n) || n < 0 || n > 365) throw new HttpError(400, `${k} must be 0 to 365 days`);
      patch[col] = n;
    }
    const before = await recallSettings(db, req.user.practice_id);
    const keys = Object.keys(patch);
    if (keys.length) await db.run(`UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), req.user.practice_id);
    const after = await recallSettings(db, req.user.practice_id);
    await audit(db, req, 'recall.settings', 'practices', req.user.practice_id, null, { before, after });
    res.json(after);
  });
  // A type's rules: age rule (child type until age_until, then adult_key), what it retires, bundled or not.
  r.put('/recall-types/:tid/rules', requirePermission('schedule:write'), async (req, res) => {
    admin(req);
    const pid = req.user.practice_id;
    const t = await findOr404(db, 'recall_types', req.params.tid, pid, 'Recall type');
    const keys = new Set((await recallTypes(db, pid)).map((x) => x.key));
    const b = req.body || {};
    const patch = {};
    if ('age_until' in b) {
      const n = b.age_until == null || b.age_until === '' ? null : Number(b.age_until);
      if (n != null && !(Number.isInteger(n) && n >= 1 && n <= 120)) throw new HttpError(400, 'age_until must be 1 to 120');
      patch.age_until = n;
    }
    if ('adult_key' in b) {
      if (b.adult_key && (!keys.has(b.adult_key) || b.adult_key === t.key)) throw new HttpError(400, 'adult_key must be another recall type');
      patch.adult_key = b.adult_key || null;
    }
    if ('retires' in b) {
      const list = Array.isArray(b.retires) ? [...new Set(b.retires.map(String))] : [];
      if (list.some((k) => !keys.has(k) || k === t.key)) throw new HttpError(400, 'retires must list other recall types');
      patch.retires = JSON.stringify(list);
    }
    if ('bundle' in b) patch.bundle = b.bundle ? 1 : 0;
    if (patch.adult_key && (patch.age_until ?? t.age_until) == null) throw new HttpError(400, 'An adult type needs the age it starts at (age_until)');
    const keysP = Object.keys(patch);
    if (keysP.length) await recorded(db, 'recall_types', t.id, () => db.run(`UPDATE recall_types SET ${keysP.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keysP.map((k) => patch[k]), t.id));
    await audit(db, req, 'recall_type.rules', 'recall_types', t.id, { key: t.key });
    res.json((await recallTypes(db, pid)).find((x) => x.id === t.id));
  });

  return r;
}
