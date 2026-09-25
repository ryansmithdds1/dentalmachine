import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { audit, findOr404, update, isRealDate, normalizeDateTime, practiceNow, recorded, insert, toCsv } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import { publish } from '../events.js';
import { canSeePatient } from '../officeaccess.js';
import { sendMessage, preferredChannel, recipientFor } from '../messaging.js';
import { validateAppt, releaseAppointment } from './schedule.js';
import { emitAppointment } from '../webhooks.js';
import { OFFICE_REASONS, recordOfficeMove, strikesFor, strikeWarning, planProviderOut, apologyText, reassignText } from '../cards.js';

// "We moved them" strikes and the "Provider out today" tool (S8; docs/workflows/specs/PP-DN-S8-S6.md).
//   GET  /office-reasons                         the office's reasons (provider sick, emergency, double-booked, equipment down, other)
//   POST /appointments/:id/office-move           after a move: "that was us" ({ reason, note, from_time? }) — counts as a strike
//   GET  /patients/:id/office-moves              the patient's office moves (12-month strikes + everything, voided too)
//   POST /office-moves/:id/void                  recorded by mistake ({ reason }) — kept, no longer counted
//   GET  /provider-out?provider_id=&date=        the provider's visits that day, each with who could take it or "reschedule"
//   POST /provider-out                           do it: keep with another provider / reschedule (cancel + apology text + rebook
//                                                task) / leave, per visit. client_key makes a retry return the same run.
//   GET  /office-moves/report?from=&to=          office-caused moves by reason and provider (&format=csv)
// Bulk moves are high-risk when the assistant asks for them: they need the person's OK on screen (X-Human-Approved),
// the same rule as aiguard.js (listed there as POST /provider-out).
const clean = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) || null);

function requirePersonForBulk(req) {
  const ctx = currentActor();
  if (ctx?.source !== 'ai') return;
  if (req.get('X-Human-Approved') !== '1' && !ctx.approvedBy) {
    throw new HttpError(428, 'The assistant can’t move a whole column of patients without your OK. Confirm it, or do it yourself.', { needs_approval: true });
  }
  if (!ctx.approvedBy) setActor({ actor: `Assistant (for ${req.user.name}, approved by ${req.user.name})`, approvedBy: req.user.id });
}

export default function officeMoveRoutes({ db, messenger, config = {} }) {
  const r = Router();
  const changed = (req, ...dates) => publish(req.user.practice_id, { type: 'schedule', dates: [...new Set(dates.filter(Boolean).map((d) => d.slice(0, 10)))], by: req.user.id });

  r.get('/office-reasons', requirePermission('schedule:read'), (_req, res) => res.json(Object.entries(OFFICE_REASONS).map(([key, label]) => ({ key, label }))));

  // A move made by dragging (or the keyboard) is recorded as the office's doing when the person says so right
  // after. The time it moved from comes from the visit's own history, so only a real move can become a strike.
  r.post('/appointments/:id/office-move', requirePermission('schedule:write'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const reason = req.body?.reason;
    if (!OFFICE_REASONS[reason]) throw new HttpError(400, `reason must be one of: ${Object.keys(OFFICE_REASONS).join(', ')}`);
    const note = clean(req.body?.note, 300);
    if (reason === 'other' && !note) throw new HttpError(400, 'Add a few words about what happened when the reason is "Other"');
    const moves = (await db.all("SELECT details, created_at FROM audit_log WHERE practice_id = ? AND entity = 'appointments' AND entity_id = ? AND action = 'appointment.update' ORDER BY id DESC LIMIT 20", req.user.practice_id, a.id))
      .map((x) => { try { return JSON.parse(x.details || '{}'); } catch { return {}; } }).filter((d) => d.from && d.to && d.from !== d.to);
    const want = req.body?.from_time ? normalizeDateTime(req.body.from_time, 'from_time') : null;
    const move = want ? moves.find((m) => m.from === want) : moves.find((m) => m.to === a.start_time);
    if (!move) throw new HttpError(409, want ? 'This visit wasn’t moved from that time' : 'This visit hasn’t been moved');
    const { id, created } = await recordOfficeMove(db, {
      practiceId: req.user.practice_id, appt: { ...a, start_time: move.from }, kind: 'move', reason, note, toTime: move.to, userId: req.user.id, source: currentActor()?.source || 'human',
    });
    if (created) await audit(db, req, 'appointment.office_move', 'appointments', a.id, { reason, note, from: move.from, to: move.to, office_move_id: id }, { patientId: a.patient_id, reason: `Moved by the office: ${OFFICE_REASONS[reason]}${note ? ` — ${note}` : ''}` });
    const s = (await strikesFor(db, req.user.practice_id, a.patient_id))[a.patient_id] || null;
    publish(req.user.practice_id, { type: 'cards', what: 'strikes', patient_id: a.patient_id, by: req.user.id });
    res.status(created ? 201 : 200).json({ id, created, strikes: s });
  });

  r.get('/patients/:id/office-moves', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    const all = await db.all(
      `SELECT m.*, pr.name AS provider_name, u.name AS by_name FROM office_moves m LEFT JOIN providers pr ON pr.id = m.provider_id LEFT JOIN users u ON u.id = m.created_by
       WHERE m.practice_id = ? AND m.patient_id = ? ORDER BY m.happened_on DESC, m.id DESC`,
      req.user.practice_id, p.id,
    );
    const s = (await strikesFor(db, req.user.practice_id, p.id))[p.id] || null;
    res.json({ strikes: s, warning: strikeWarning(p.preferred_name || p.first_name, s), moves: all.map((m) => ({ ...m, reason_label: OFFICE_REASONS[m.reason] || m.reason })) });
  });

  r.post('/office-moves/:id/void', requirePermission('schedule:write'), async (req, res) => {
    const m = await findOr404(db, 'office_moves', req.params.id, req.user.practice_id, 'Office move');
    if (!(await canSeePatient(db, req.user, m.patient_id))) throw new HttpError(404, 'Office move not found');
    const reason = clean(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Say why this wasn’t the office’s doing');
    if (m.voided_at) return res.json({ ok: true, already: true });
    await update(db, 'office_moves', m.id, req.user.practice_id, { voided_at: await practiceNow(db, req.user.practice_id), voided_by: req.user.id, void_reason: reason });
    await audit(db, req, 'office_move.void', 'office_moves', m.id, { appointment_id: m.appointment_id, patient_id: m.patient_id }, { patientId: m.patient_id, reason });
    publish(req.user.practice_id, { type: 'cards', what: 'strikes', patient_id: m.patient_id, by: req.user.id });
    res.json({ ok: true });
  });

  const validator = (pid) => (row) => validateAppt(db, pid, { ...row });

  r.get('/provider-out', requirePermission('schedule:write'), async (req, res) => {
    const date = req.query.date;
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const pid = req.user.practice_id;
    const plan = await planProviderOut(db, pid, { providerId: Number(req.query.provider_id), date, validate: validator(pid) });
    const practice = await db.get('SELECT name, phone, slug, online_booking FROM practices WHERE id = ?', pid);
    res.json({ ...plan, reasons: OFFICE_REASONS, rebook_link: practice.online_booking && practice.slug ? `${config.appUrl || ''}/book/${practice.slug}` : null });
  });

  r.post('/provider-out', requirePermission('schedule:write'), async (req, res) => {
    requirePersonForBulk(req);
    const pid = req.user.practice_id;
    const b = req.body || {};
    const key = clean(b.client_key, 80);
    if (!key) throw new HttpError(400, 'client_key is required (so a retry can’t move anyone twice)');
    const had = await db.get('SELECT * FROM provider_out_runs WHERE practice_id = ? AND client_key = ?', pid, key);
    if (had) return res.json({ run_id: had.id, ...JSON.parse(had.summary || '{}'), already: true });
    if (!isRealDate(b.date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const provider = await findOr404(db, 'providers', b.provider_id, pid, 'Provider');
    const reason = b.reason || 'provider_sick';
    if (!OFFICE_REASONS[reason]) throw new HttpError(400, `reason must be one of: ${Object.keys(OFFICE_REASONS).join(', ')}`);
    const goodwill = clean(b.goodwill_note, 200);
    const actions = Array.isArray(b.visits) ? b.visits : [];
    if (!actions.length) throw new HttpError(400, 'Choose what happens to each visit');
    if (actions.length > 60) throw new HttpError(400, 'Too many visits at once');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const link = practice.online_booking && practice.slug ? `${config.appUrl || ''}/book/${practice.slug}` : null;
    const source = currentActor()?.source || 'human';
    const runId = await insert(db, 'provider_out_runs', { practice_id: pid, provider_id: provider.id, out_date: b.date, reason, goodwill_note: goodwill, client_key: key, source, created_by: req.user.id });
    const results = [];
    const touched = new Set([b.date]);
    const cancelNow = await practiceNow(db, pid); // when any of these were cancelled (latecancel.js)
    for (const act of actions) {
      const out = { appointment_id: Number(act.appointment_id), action: act.action };
      try {
        const a = await findOr404(db, 'appointments', act.appointment_id, pid, 'Appointment');
        if (a.provider_id !== provider.id || a.start_time.slice(0, 10) !== b.date) throw new HttpError(400, `That visit isn’t ${provider.name}’s on ${b.date}`);
        if (!(await canSeePatient(db, req.user, a.patient_id))) throw new HttpError(404, 'Appointment not found');
        if (!['scheduled', 'confirmed'].includes(a.status)) { out.result = 'skipped'; out.why = `already ${a.status.replace('_', ' ')}`; results.push(out); continue; }
        const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
        out.patient_id = a.patient_id;
        out.name = `${patient.preferred_name || patient.first_name} ${patient.last_name}`;
        if (act.action === 'keep') {
          const to = await findOr404(db, 'providers', act.provider_id, pid, 'Provider');
          await validateAppt(db, pid, { ...a, provider_id: to.id });
          await recorded(db, 'appointments', a.id, () => db.run('UPDATE appointments SET provider_id = ? WHERE id = ?', to.id, a.id));
          await db.run("UPDATE procedures SET provider_id = ? WHERE appointment_id = ? AND status = 'planned'", to.id, a.id);
          await recordOfficeMove(db, { practiceId: pid, appt: a, kind: 'reassign', reason, toTime: a.start_time, toProviderId: to.id, runId, userId: req.user.id, source });
          await audit(db, req, 'appointment.update', 'appointments', a.id, { fields: ['provider_id'], provider_id: to.id, provider_out_run: runId }, { patientId: a.patient_id, reason: `${provider.name} out: ${OFFICE_REASONS[reason]}` });
          out.result = 'kept'; out.provider = to.name;
          if (b.send_texts !== false) out.message = await tellPatient(db, messenger, { patient, a, body: (pt) => reassignText({ patient: pt, practice, visit: a, toName: to.name }), kind: 'office_move_notice', userId: req.user.id });
          await emitAppointment(db, a.id);
        } else if (act.action === 'reschedule') {
          await recorded(db, 'appointments', a.id, () => db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, broken_reason = 'office', broken_note = ? WHERE id = ?", cancelNow, OFFICE_REASONS[reason], a.id));
          await releaseAppointment(db, a.id);
          await recordOfficeMove(db, { practiceId: pid, appt: a, kind: 'cancel', reason, note: goodwill, runId, userId: req.user.id, source });
          await audit(db, req, 'appointment.status', 'appointments', a.id, { from: a.status, to: 'cancelled', broken_reason: 'office', office_reason: reason, provider_out_run: runId }, {
            patientId: a.patient_id, reason: `office: ${OFFICE_REASONS[reason]}`,
          });
          // Nobody falls through the cracks: a task to rebook them, whatever the text does.
          const taskId = await insert(db, 'tasks', {
            practice_id: pid, patient_id: a.patient_id, title: `Rebook ${out.name} — we moved their ${a.start_time.slice(11, 16)} visit (${OFFICE_REASONS[reason].toLowerCase()})`,
            notes: `${provider.name} out on ${b.date}. ${a.reason || ''}`.trim(), due_date: (await practiceNow(db, pid)).slice(0, 10), priority: 'high', created_by: req.user.id,
          });
          await audit(db, req, 'task.create', 'tasks', taskId, { patient_id: a.patient_id, provider_out_run: runId });
          out.result = 'rescheduled'; out.task_id = taskId;
          if (b.send_texts !== false) out.message = await tellPatient(db, messenger, { patient, a, body: (pt) => apologyText({ patient: pt, practice, visit: a, reason, providerName: provider.name, goodwill, link }), kind: 'office_move_apology', userId: req.user.id });
          await emitAppointment(db, a.id);
        } else {
          out.result = 'left';
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        out.result = 'failed'; out.why = err.message;
      }
      results.push(out);
    }
    const summary = {
      provider: { id: provider.id, name: provider.name }, date: b.date, reason, results,
      kept: results.filter((x) => x.result === 'kept').length, rescheduled: results.filter((x) => x.result === 'rescheduled').length,
      failed: results.filter((x) => x.result === 'failed').length,
    };
    await update(db, 'provider_out_runs', runId, pid, { summary: JSON.stringify(summary) });
    await audit(db, req, 'provider_out.run', 'provider_out_runs', runId, { provider_id: provider.id, date: b.date, reason, kept: summary.kept, rescheduled: summary.rescheduled, failed: summary.failed }, {
      reason: `${provider.name} out ${b.date}: ${OFFICE_REASONS[reason]}`,
    });
    changed(req, ...touched);
    publish(pid, { type: 'cards', what: 'strikes', by: req.user.id });
    res.status(201).json({ run_id: runId, ...summary });
  });

  r.get('/office-moves/report', requirePermission('schedule:read'), async (req, res) => {
    if (!can(req.user, 'reports:read')) throw new HttpError(403, 'You need permission to see practice reports');
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = req.query.from || `${today.slice(0, 4)}-01-01`;
    const to = req.query.to || today;
    if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
    const rows = await db.all(
      `SELECT m.*, pr.name AS provider_name, p.first_name, p.last_name FROM office_moves m LEFT JOIN providers pr ON pr.id = m.provider_id JOIN patients p ON p.id = m.patient_id
       WHERE m.practice_id = ? AND m.voided_at IS NULL AND m.happened_on >= ? AND m.happened_on <= ? ORDER BY m.happened_on DESC, m.id DESC`,
      pid, from, to,
    );
    const group = (f) => Object.values(rows.reduce((acc, m) => {
      const k = f(m);
      acc[k] ||= { key: k, moves: 0, cancels: 0, reassigns: 0, patients: new Set() };
      acc[k][m.kind === 'move' ? 'moves' : m.kind === 'cancel' ? 'cancels' : 'reassigns']++;
      acc[k].patients.add(m.patient_id);
      return acc;
    }, {})).map((g) => ({ ...g, patients: g.patients.size, total: g.moves + g.cancels + g.reassigns })).sort((a, b) => b.total - a.total);
    if (req.query.format === 'csv') {
      res.type('text/csv').set('Content-Disposition', `attachment; filename="office-moves-${from}-to-${to}.csv"`);
      await audit(db, req, 'report.export', 'office_moves', null, { report: 'office_moves', from, to, rows: rows.length });
      return res.send(toCsv(rows, [['Date', (m) => m.happened_on], ['Kind', (m) => m.kind], ['Reason', (m) => OFFICE_REASONS[m.reason] || m.reason], ['Provider', (m) => m.provider_name],
        ['Patient', (m) => `${m.first_name} ${m.last_name}`], ['Visit was', (m) => m.from_time], ['Moved to', (m) => m.to_time || ''], ['Note', (m) => m.note || '']]));
    }
    res.json({
      from, to, total: rows.length,
      by_reason: group((m) => m.reason).map((g) => ({ ...g, label: OFFICE_REASONS[g.key] || g.key })),
      by_provider: group((m) => m.provider_name || '—'),
      rows: rows.slice(0, 500).map((m) => ({ id: m.id, patient_id: m.patient_id, name: `${m.first_name} ${m.last_name}`, kind: m.kind, reason: m.reason, reason_label: OFFICE_REASONS[m.reason], provider_name: m.provider_name, from_time: m.from_time, to_time: m.to_time, happened_on: m.happened_on, note: m.note })),
    });
  });

  return r;
}

// Texts (or emails) the patient — or the parent for a child — through sendMessage, which checks opt-outs and
// raises a Needs attention item if it doesn't go.
async function tellPatient(db, messenger, { patient, a, body, kind, userId }) {
  if (!messenger) return { status: 'not_sent', why: 'messaging is off' };
  const to = await recipientFor(db, patient);
  const ch = preferredChannel(to);
  if (!ch) return { status: 'not_sent', why: 'no phone or email we can use' };
  const m = await sendMessage(db, messenger, {
    practiceId: patient.practice_id, patientId: patient.id, appointmentId: a.id, channel: ch.channel, to: ch.to,
    subject: ch.channel === 'email' ? 'We need to move your visit' : undefined, body: body(to === patient ? patient : { ...to, first_name: patient.first_name, preferred_name: patient.preferred_name }), kind, userId,
  });
  return { status: m.status, channel: m.channel, id: m.id };
}
