import { Router } from 'express';
import { HttpError, requirePermission, can } from '../auth.js';
import { audit, findOr404, practiceNow, recorded, insert } from '../util.js';
import { canSeePatient, restricted, checkOffice } from '../officeaccess.js';
import {
  cadenceType, cadenceTypes, ensureSequences, saveSequence, resetSequence, stepsFor, recordOutcome, patientStatus, stopEnrollment, runCadences,
  messageVars, addDays, daysBetween, CHANNEL_LABELS, STOP_REASONS, OUTCOMES, CHANNELS, DEFAULT_FALLBACK,
} from '../cadence.js';
import { DEFAULT_RECALL_CADENCE } from '../cadence-recall.js';

// Recall on autopilot, staff side (docs/workflows/specs/RC-recall.md): the switch, the sequences and their
// editor, the dashboard (results only), the people to call with one-click outcomes, and each patient's cadence.
// Mounted on the signed-in API router; every route checks its permission and the practice (and office) it's in.

const adminOnly = (req) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change this');
};
const typeOf = (req) => {
  const t = String(req.query.type || req.body?.type || 'recall');
  if (!cadenceTypes().includes(t)) throw new HttpError(400, 'Unknown cadence type');
  return t;
};
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// Offices this person may see figures for: a chosen one (theirs), all of theirs, or everything.
function officeFilter(req, alias = 'e') {
  const want = req.query.location_id ? Number(req.query.location_id) : null;
  if (want) {
    checkOffice(req.user, want);
    return { sql: ` AND ${alias}.location_id = ?`, args: [want] };
  }
  if (restricted(req.user)) return { sql: ` AND (${alias}.location_id IS NULL OR ${alias}.location_id IN (${req.user.location_ids.map(() => '?').join(',')}))`, args: [...req.user.location_ids] };
  return { sql: '', args: [] };
}

export default function cadenceRoutes({ db, messenger, mailer = null, config = {}, secret }) {
  const r = Router();

  // ---- The switch ----
  r.get('/cadence/settings', requirePermission('schedule:read'), async (req, res) => {
    const p = await db.get('SELECT recall_cadence, recall_auto, send_from, send_until, timezone FROM practices WHERE id = ?', req.user.practice_id);
    res.json({
      recall_enabled: !!p.recall_cadence, old_recall_messages: !!p.recall_auto && !p.recall_cadence, send_from: p.send_from || '08:00', send_until: p.send_until || '20:00',
      timezone: p.timezone, texting: messenger?.status?.sms || 'log', email: messenger?.status?.email || 'log', calls: messenger?.call ? messenger?.status?.voice || 'log' : null,
      mail: mailer?.enabled ? mailer.name : null, channels: CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABELS[c], fallback: DEFAULT_FALLBACK[c] })),
    });
  });
  r.put('/cadence/settings', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    if (typeof req.body?.recall_enabled !== 'boolean') throw new HttpError(400, 'recall_enabled must be true or false');
    const before = await db.get('SELECT recall_cadence FROM practices WHERE id = ?', req.user.practice_id);
    const pid = req.user.practice_id;
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET recall_cadence = ? WHERE id = ?', req.body.recall_enabled ? 1 : 0, pid));
    if (req.body.recall_enabled) await ensureSequences(db, req.user.practice_id, 'recall');
    await audit(db, req, req.body.recall_enabled ? 'cadence.recall.on' : 'cadence.recall.off', 'practices', req.user.practice_id, null, {
      before: { recall_cadence: before.recall_cadence }, after: { recall_cadence: req.body.recall_enabled ? 1 : 0 },
    });
    res.json({ recall_enabled: req.body.recall_enabled });
  });

  // ---- Sequences ----
  r.get('/cadence/sequences', requirePermission('schedule:read'), async (req, res) => {
    const type = typeOf(req);
    const users = await db.all('SELECT id, name FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    res.json({ type, sequences: await ensureSequences(db, req.user.practice_id, type), recommended: type === 'recall' ? DEFAULT_RECALL_CADENCE : [], team: users });
  });
  r.put('/cadence/sequences/:id', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    const seq = await findOr404(db, 'cadence_sequences', req.params.id, req.user.practice_id, 'Sequence');
    res.json(await saveSequence(db, req, seq, req.body || {}));
  });
  r.post('/cadence/sequences/:id/reset', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    const seq = await findOr404(db, 'cadence_sequences', req.params.id, req.user.practice_id, 'Sequence');
    res.json(await resetSequence(db, req, seq));
  });

  // ---- Dashboard: results and exceptions only ----
  r.get('/cadence/dashboard', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const type = typeOf(req);
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
    const since = utc(new Date(Date.now() - days * 86400_000));
    const f = officeFilter(req);
    const base = `FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.practice_id = ? AND s.type = ?${f.sql}`;
    const active = await db.all(`SELECT e.id, e.anchor_date, e.location_id ${base} AND e.status = 'active'`, pid, type, ...f.args);
    const booked = await db.all(
      `SELECT e.id, e.anchor_date, e.location_id, e.booked_at, e.booked_via, e.booked_step_id, e.booked_appointment_id, e.source_id, e.patient_id,
         st.offset_days, st.channel, st.position ${base.replace('WHERE', 'LEFT JOIN cadence_steps st ON st.id = e.booked_step_id WHERE')} AND e.stop_reason = 'booked' AND e.booked_at >= ?`,
      pid, type, ...f.args, since,
    );
    const stopped = await db.all(`SELECT e.stop_reason, COUNT(*) AS n ${base} AND e.status = 'stopped' AND e.stop_reason <> 'booked' AND e.stopped_at >= ? GROUP BY e.stop_reason`, pid, type, ...f.args, since);
    const sends = await db.all(
      `SELECT r.channel, r.status, COUNT(*) AS n FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id
       WHERE r.practice_id = ? AND s.type = ?${f.sql} AND r.created_at >= ? AND r.grouped_with IS NULL GROUP BY r.channel, r.status`, pid, type, ...f.args, since,
    );
    const openCalls = await db.get(`SELECT COUNT(*) AS n FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id WHERE r.practice_id = ? AND s.type = ?${f.sql} AND r.status = 'task' AND e.status = 'active'`, pid, type, ...f.args);
    const failing = await db.get("SELECT COUNT(*) AS n FROM issues WHERE practice_id = ? AND status = 'open' AND dedupe_key LIKE 'cadence%'", pid);

    // $ scheduled: the fees of the work on each booked visit; a visit with nothing on it yet counts the recall
    // type's usual fee (its first code). Money only for people who can see billing.
    const money = can(req.user, 'billing:read');
    let scheduled = 0;
    const usual = new Map();
    const valueOf = async (b) => {
      if (!b.booked_appointment_id) return 0;
      const onVisit = await db.get("SELECT COALESCE(SUM(fee), 0) AS v FROM procedures WHERE appointment_id = ? AND status IN ('planned','completed')", b.booked_appointment_id);
      if (Number(onVisit.v) > 0) return Number(onVisit.v);
      const recall = type === 'recall' ? await db.get('SELECT type FROM recalls WHERE id = ?', b.source_id) : null;
      if (!recall) return 0;
      if (!usual.has(recall.type)) {
        const rt = await db.get('SELECT codes FROM recall_types WHERE practice_id = ? AND key = ?', pid, recall.type);
        const code = JSON.parse(rt?.codes || '[]')[0];
        usual.set(recall.type, code ? Number((await db.get('SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code))?.fee || 0) : 0);
      }
      return usual.get(recall.type);
    };
    const byStep = new Map();
    const byOffice = new Map();
    const office = (id) => {
      const k = id ?? 0;
      if (!byOffice.has(k)) byOffice.set(k, { location_id: id ?? null, due: 0, overdue: 0, booked: 0, reactivated: 0, scheduled: 0 });
      return byOffice.get(k);
    };
    let reactivated = 0;
    let selfBooked = 0;
    for (const b of booked) {
      const v = money ? await valueOf(b) : 0;
      scheduled += v;
      const lapsed = daysBetween(b.anchor_date, String(b.booked_at).slice(0, 10)) >= 90;
      if (lapsed) reactivated++;
      if (b.booked_via === 'self_schedule') selfBooked++;
      const key = b.booked_step_id ? `${b.offset_days}:${b.channel}` : 'none';
      if (!byStep.has(key)) byStep.set(key, { offset_days: b.offset_days ?? null, channel: b.channel ?? null, label: b.channel ? `${b.offset_days >= 0 ? `Day +${b.offset_days}` : `Day ${b.offset_days}`} · ${CHANNEL_LABELS[b.channel]}` : 'Before any step', booked: 0, scheduled: 0 });
      byStep.get(key).booked++;
      byStep.get(key).scheduled += v;
      const o = office(b.location_id);
      o.booked++;
      o.scheduled += v;
      if (lapsed) o.reactivated++;
    }
    const soon = addDays(today, 30);
    for (const e of active) {
      if (e.anchor_date < today) office(e.location_id).overdue++;
      else if (e.anchor_date <= soon) office(e.location_id).due++;
    }
    const locations = new Map((await db.all('SELECT id, name FROM locations WHERE practice_id = ?', pid)).map((l) => [l.id, l.name]));
    const channelStats = {};
    for (const s of sends) {
      const c = (channelStats[s.channel || 'none'] ||= { channel: s.channel, label: CHANNEL_LABELS[s.channel] || 'None', sent: 0, failed: 0, skipped: 0, calls: 0 });
      if (s.status === 'sent') c.sent += Number(s.n);
      else if (s.status === 'failed') c.failed += Number(s.n);
      else if (s.status === 'skipped') c.skipped += Number(s.n);
      else if (s.status === 'task' || s.status === 'done') c.calls += Number(s.n);
    }
    res.json({
      today, days, type,
      due_soon: active.filter((e) => e.anchor_date >= today && e.anchor_date <= soon).length,
      overdue: active.filter((e) => e.anchor_date < today).length,
      active: active.length, booked: booked.length, self_booked: selfBooked, reactivated,
      scheduled: money ? scheduled : null,
      open_calls: Number(openCalls.n), failing: Number(failing.n),
      by_step: [...byStep.values()].sort((a, b) => (a.offset_days ?? -999) - (b.offset_days ?? -999)).map((s) => ({ ...s, scheduled: money ? s.scheduled : null })),
      by_office: [...byOffice.values()].map((o) => ({ ...o, name: o.location_id ? locations.get(o.location_id) || 'Office' : 'No office', scheduled: money ? o.scheduled : null })),
      channels: Object.values(channelStats),
      stopped: stopped.map((s) => ({ reason: s.stop_reason, label: STOP_REASONS[s.stop_reason] || s.stop_reason, n: Number(s.n) })),
    });
  });

  // ---- People to call (task_call steps), with the script and their history ----
  r.get('/cadence/calls', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const type = typeOf(req);
    const f = officeFilter(req);
    const mine = req.query.mine === '1';
    const rows = await db.all(
      `SELECT r.id, r.patient_id, r.enrollment_id, r.due_date, r.task_id, r.created_at, st.template, st.offset_days, e.anchor_date, e.location_id, s.name AS sequence_name,
         p.first_name, p.last_name, p.preferred_name, p.phone, p.phone_home, p.phone_work, p.guarantor_id, t.assigned_to, u.name AS assigned_name
       FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id
         JOIN cadence_steps st ON st.id = r.step_id JOIN patients p ON p.id = r.patient_id
         LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users u ON u.id = t.assigned_to
       WHERE r.practice_id = ? AND s.type = ? AND r.status = 'task' AND e.status = 'active'${f.sql}${mine ? ' AND (t.assigned_to IS NULL OR t.assigned_to = ?)' : ''}
       ORDER BY r.due_date, r.id LIMIT 300`,
      pid, type, ...f.args, ...(mine ? [req.user.id] : []),
    );
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const def = cadenceType(type);
    const out = [];
    for (const row of rows) {
      const e = await db.get('SELECT * FROM cadence_enrollments WHERE id = ?', row.enrollment_id);
      const history = await db.all(
        "SELECT r.due_date, r.status, r.channel, r.outcome, r.outcome_note, r.finished_at FROM cadence_runs r WHERE r.enrollment_id = ? AND r.id <> ? AND r.status <> 'skipped' ORDER BY r.due_date DESC, r.id DESC LIMIT 5",
        row.enrollment_id, row.id,
      );
      const { visit } = await def.describe(db, [e]);
      const recipient = { id: row.patient_id, first_name: row.first_name, preferred_name: row.preferred_name };
      const script = messageVars({ practice, recipient, patients: [recipient], anchor: row.anchor_date, visit, link: 'the link in our text' });
      out.push({
        id: row.id, patient_id: row.patient_id, name: `${row.preferred_name || row.first_name} ${row.last_name}`, phone: row.phone || row.phone_home || row.phone_work,
        due_date: row.due_date, anchor_date: row.anchor_date, overdue_days: daysBetween(row.anchor_date, (await practiceNow(db, pid)).slice(0, 10)), sequence_name: row.sequence_name,
        assigned_to: row.assigned_to, assigned_name: row.assigned_name, visit, script: row.template.replace(/\{(\w+)\}/g, (_, k) => script[k] ?? ''), history,
      });
    }
    res.json({ calls: out, outcomes: Object.entries(OUTCOMES).map(([key, label]) => ({ key, label })) });
  });

  r.post('/cadence/runs/:id/outcome', requirePermission('schedule:write'), async (req, res) => {
    const run = await findOr404(db, 'cadence_runs', req.params.id, req.user.practice_id, 'Call');
    if (!(await canSeePatient(db, req.user, run.patient_id))) throw new HttpError(404, 'Call not found');
    res.json(await recordOutcome(db, req, run, { outcome: String(req.body?.outcome || ''), note: req.body?.note }));
  });

  // ---- A patient's cadence (the patient page) ----
  const visiblePatient = async (req) => {
    const p = await findOr404(db, 'patients', req.params.pid, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    return p;
  };
  r.get('/cadence/patients/:pid', requirePermission('patients:read'), async (req, res) => {
    const p = await visiblePatient(req);
    const status = await patientStatus(db, req.user.practice_id, p.id);
    for (const e of status.enrollments) e.steps_total = (await stepsFor(db, e.sequence_id)).length;
    res.json(status);
  });
  r.post('/cadence/patients/:pid/holds', requirePermission('patients:write'), async (req, res) => {
    const p = await visiblePatient(req);
    const reason = String(req.body?.reason || '');
    if (!['deceased', 'moved', 'no_contact', 'other'].includes(reason)) throw new HttpError(400, 'Choose deceased, moved, no contact or other');
    const type = req.body?.type ? typeOf(req) : null;
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
    if (reason === 'other' && !note) throw new HttpError(400, 'Say why, so the team knows');
    const open = await db.get('SELECT * FROM cadence_holds WHERE patient_id = ? AND released_at IS NULL AND reason = ? AND COALESCE(type, \'\') = ?', p.id, reason, type || '');
    if (open) return res.json(open); // the same click twice
    const id = await insert(db, 'cadence_holds', { practice_id: req.user.practice_id, patient_id: p.id, type, reason, note, created_by: req.user.id });
    await audit(db, req, 'cadence.hold', 'cadence_holds', id, { reason, type, note }, { patientId: p.id, reason: STOP_REASONS[reason] });
    for (const e of await db.all("SELECT e.*, s.type FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.patient_id = ? AND e.practice_id = ? AND e.status = 'active'", p.id, req.user.practice_id)) {
      if (!type || e.type === type) await stopEnrollment(db, e, { reason, userId: req.user.id, req });
    }
    res.status(201).json(await db.get('SELECT * FROM cadence_holds WHERE id = ?', id));
  });
  r.post('/cadence/holds/:id/release', requirePermission('patients:write'), async (req, res) => {
    const hold = await findOr404(db, 'cadence_holds', req.params.id, req.user.practice_id, 'Hold');
    if (!(await canSeePatient(db, req.user, hold.patient_id))) throw new HttpError(404, 'Hold not found');
    if (hold.released_at) return res.json(hold);
    await recorded(db, 'cadence_holds', hold.id, () => db.run("UPDATE cadence_holds SET released_at = datetime('now'), released_by = ? WHERE id = ? AND released_at IS NULL", req.user.id, hold.id));
    await audit(db, req, 'cadence.hold_release', 'cadence_holds', hold.id, { reason: hold.reason }, { patientId: hold.patient_id });
    res.json(await db.get('SELECT * FROM cadence_holds WHERE id = ?', hold.id));
  });
  r.post('/cadence/enrollments/:id/stop', requirePermission('schedule:write'), async (req, res) => {
    const e = await findOr404(db, 'cadence_enrollments', req.params.id, req.user.practice_id, 'Recall sequence');
    if (!(await canSeePatient(db, req.user, e.patient_id))) throw new HttpError(404, 'Recall sequence not found');
    const note = String(req.body?.reason || '').trim().slice(0, 300);
    if (!note) throw new HttpError(400, 'Say why it’s being stopped');
    await stopEnrollment(db, e, { reason: 'manual', userId: req.user.id, req });
    await audit(db, req, 'cadence.stop_note', 'cadence_enrollments', e.id, { note }, { patientId: e.patient_id, reason: note });
    res.json(await db.get('SELECT * FROM cadence_enrollments WHERE id = ?', e.id));
  });

  // Runs this practice's cadence now instead of waiting for the next pass (after switching on, or for a demo).
  r.post('/cadence/run-now', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    await audit(db, req, 'cadence.run_now', 'practices', req.user.practice_id);
    res.json(await runCadences(db, { messenger, mailer, appUrl: config.appUrl, secret, practiceIds: [req.user.practice_id] }));
  });

  return r;
}
