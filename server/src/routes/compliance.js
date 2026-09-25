import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { pick, insert, update, change, findOr404, audit, practiceNow, isRealDate, normalizeDateTime, toCsv } from '../util.js';
import { publish } from '../events.js';
import { PdfDoc } from '../pdf.js';
import { DISCLOSURE_PURPOSES, ACCOUNTING_YEARS, EXPOSURE_STEPS, isManager, recordDisclosure } from '../compliance.js';

// Compliance logs (README.md, “Compliance log”, actions A168 A169 A175):
//   /incidents   patient complaints and office incidents — anyone records one; the whole log is for managers
//   /exposures   staff blood/body-fluid exposures and sharps injuries — confidential (compliance:exposures)
//   /disclosures the HIPAA accounting of disclosures, per patient and practice-wide, with the patient's report
// Nothing here is ever deleted: records are resolved/closed, or voided with a reason when entered by mistake.
// Every change goes through insert()/update() (before → after in the audit log) plus an audit() entry.
const SEVERITIES = ['low', 'medium', 'high'];
const KINDS = ['complaint', 'incident'];
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

export default function complianceRoutes({ db }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const staffOr400 = async (req, id, what) => {
    if (id == null || id === '') return null;
    const u = await db.get('SELECT id, name FROM users WHERE id = ? AND practice_id = ?', Number(id), req.user.practice_id);
    if (!u) throw new HttpError(400, `${what}: choose someone on the team`);
    return u;
  };
  const patientOrNull = async (req, id) => (id == null || id === '' ? null : findOr404(db, 'patients', id, req.user.practice_id, 'Patient'));

  // ---------------- Complaints and incidents ----------------
  const INCIDENT_SELECT = `SELECT i.*, p.first_name, p.last_name, rb.name AS reported_by_name, fu.name AS follow_up_name, rv.name AS resolved_by_name, t.status AS task_status
    FROM incidents i LEFT JOIN patients p ON p.id = i.patient_id LEFT JOIN users rb ON rb.id = i.reported_by LEFT JOIN users fu ON fu.id = i.follow_up_user_id
    LEFT JOIN users rv ON rv.id = i.resolved_by LEFT JOIN tasks t ON t.id = i.task_id`;
  // Managers see the whole log; everyone else what they reported or has to follow up.
  const visible = (req) => (isManager(req.user) ? { sql: '', args: [] } : { sql: ' AND (i.reported_by = ? OR i.follow_up_user_id = ?)', args: [req.user.id, req.user.id] });
  const incidentOr404 = async (req) => {
    const v = visible(req);
    const row = await db.get(`SELECT * FROM incidents i WHERE i.id = ? AND i.practice_id = ?${v.sql}`, Number(req.params.iid), req.user.practice_id, ...v.args);
    if (!row) throw new HttpError(404, 'Incident not found');
    return row;
  };
  const taskFor = async (req, inc, owner, due) => {
    const title = `Follow up: ${inc.kind === 'complaint' ? 'complaint' : 'incident'} — ${inc.summary}`.slice(0, 200);
    const id = await insert(db, 'tasks', {
      practice_id: req.user.practice_id, patient_id: inc.patient_id ?? null, assigned_to: owner?.id ?? null, title, due_date: due ?? null,
      priority: inc.severity === 'high' ? 'high' : 'normal', created_by: req.user.id, notes: 'From the complaint & incident log (Manage → Compliance log). Resolve it there with what was done.',
    });
    publish(req.user.practice_id, { type: 'tasks' });
    return id;
  };

  r.get('/incidents', requirePermission('patients:read'), async (req, res) => {
    const v = visible(req);
    const status = String(req.query.status || 'open');
    const where = status === 'all' ? '' : status === 'resolved' ? " AND i.status = 'resolved'" : status === 'voided' ? " AND i.status = 'voided'" : " AND i.status = 'open'";
    const pid = req.query.patient_id ? ' AND i.patient_id = ?' : '';
    const rows = await db.all(`${INCIDENT_SELECT} WHERE i.practice_id = ?${where}${pid}${v.sql} ORDER BY i.occurred_at DESC, i.id DESC LIMIT 500`,
      req.user.practice_id, ...(pid ? [Number(req.query.patient_id)] : []), ...v.args);
    res.json({ rows, manager: isManager(req.user) });
  });

  r.post('/incidents', requirePermission('patients:read'), async (req, res) => {
    const b = req.body || {};
    const summary = clip(b.summary, 300);
    if (!summary) throw new HttpError(400, 'Say what happened', { missing: ['summary'] });
    const kind = b.kind || 'complaint';
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Kind must be complaint or incident');
    const severity = b.severity || 'low';
    if (!SEVERITIES.includes(severity)) throw new HttpError(400, 'Severity must be low, medium or high');
    const now = await practiceNow(db, req.user.practice_id);
    const occurred = b.occurred_at ? normalizeDateTime(b.occurred_at, 'When') : now.slice(0, 16);
    if (occurred > now.slice(0, 16)) throw new HttpError(400, "“When” can't be in the future");
    const patient = await patientOrNull(req, b.patient_id);
    const owner = await staffOr400(req, b.follow_up_user_id, 'Follow-up');
    if (b.follow_up_due != null && b.follow_up_due !== '' && !isRealDate(b.follow_up_due)) throw new HttpError(400, 'Follow-up due must be a real date (YYYY-MM-DD)');
    const due = b.follow_up_due || null;
    const row = {
      practice_id: req.user.practice_id, location_id: req.location_id ?? patient?.location_id ?? null, kind, patient_id: patient?.id ?? null, occurred_at: occurred,
      summary, details: clip(b.details, 4000), people: clip(b.people, 300), severity, reported_by: req.user.id, follow_up_user_id: owner?.id ?? null, follow_up_due: due,
    };
    const id = await db.tx(async () => {
      const iid = await insert(db, 'incidents', row);
      await audit(db, req, 'incident.create', 'incidents', iid, { kind, severity, patient_id: row.patient_id }, { patientId: row.patient_id, after: row });
      // The follow-up is a real task on its owner's to-do list, so it isn't forgotten.
      if (owner || due) await change(db, 'incidents', iid, { task_id: await taskFor(req, row, owner, due) });
      return iid;
    });
    res.status(201).json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, id));
  });

  // Corrections while it's open: the reporter or a manager. Before → after is kept.
  r.put('/incidents/:iid', requirePermission('patients:read'), async (req, res) => {
    const inc = await incidentOr404(req);
    if (inc.status !== 'open') throw new HttpError(409, 'Reopen it first to change it');
    if (inc.reported_by !== req.user.id && !isManager(req.user)) throw new HttpError(403, 'Only the person who reported it or a manager can change it');
    const row = pick(req.body, ['summary', 'details', 'people', 'severity', 'kind', 'follow_up_user_id', 'follow_up_due', 'patient_id']);
    if ('summary' in row) { row.summary = clip(row.summary, 300); if (!row.summary) throw new HttpError(400, 'Say what happened'); }
    if ('details' in row) row.details = clip(row.details, 4000);
    if ('people' in row) row.people = clip(row.people, 300);
    if ('severity' in row && !SEVERITIES.includes(row.severity)) throw new HttpError(400, 'Severity must be low, medium or high');
    if ('kind' in row && !KINDS.includes(row.kind)) throw new HttpError(400, 'Kind must be complaint or incident');
    if ('follow_up_due' in row && row.follow_up_due != null && !isRealDate(row.follow_up_due)) throw new HttpError(400, 'Follow-up due must be a real date (YYYY-MM-DD)');
    if ('patient_id' in row) row.patient_id = (await patientOrNull(req, row.patient_id))?.id ?? null;
    const owner = 'follow_up_user_id' in row ? await staffOr400(req, row.follow_up_user_id, 'Follow-up') : undefined;
    if (owner !== undefined) row.follow_up_user_id = owner?.id ?? null;
    await update(db, 'incidents', inc.id, req.user.practice_id, row);
    const now = await db.get('SELECT * FROM incidents WHERE id = ?', inc.id);
    // Keep the task in step with the follow-up.
    if (now.task_id && ('follow_up_user_id' in row || 'follow_up_due' in row)) await update(db, 'tasks', now.task_id, req.user.practice_id, { assigned_to: now.follow_up_user_id, due_date: now.follow_up_due });
    else if (!now.task_id && (now.follow_up_user_id || now.follow_up_due)) await change(db, 'incidents', inc.id, { task_id: await taskFor(req, now, owner || (now.follow_up_user_id ? { id: now.follow_up_user_id } : null), now.follow_up_due) });
    await audit(db, req, 'incident.change', 'incidents', inc.id, { fields: Object.keys(row) }, { patientId: now.patient_id });
    res.json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, inc.id));
  });

  const closeTask = async (req, inc) => {
    if (inc.task_id) await db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND practice_id = ? AND status = 'open'", inc.task_id, req.user.practice_id);
    publish(req.user.practice_id, { type: 'tasks' });
  };
  // Resolved: what was done. The follow-up owner, the reporter or a manager.
  r.post('/incidents/:iid/resolve', requirePermission('patients:read'), async (req, res) => {
    const inc = await incidentOr404(req);
    const resolution = clip(req.body?.resolution, 2000);
    if (!resolution) throw new HttpError(400, 'Say how it was resolved', { missing: ['resolution'] });
    if (inc.status === 'resolved') return res.json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, inc.id));
    if (inc.status !== 'open') throw new HttpError(409, 'This entry was voided');
    await update(db, 'incidents', inc.id, req.user.practice_id, { status: 'resolved', resolution, resolved_by: req.user.id, resolved_at: new Date().toISOString() });
    await closeTask(req, inc);
    await audit(db, req, 'incident.resolve', 'incidents', inc.id, { resolution }, { patientId: inc.patient_id });
    res.json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, inc.id));
  });
  r.post('/incidents/:iid/reopen', requirePermission('compliance:manage'), async (req, res) => {
    const inc = await incidentOr404(req);
    if (inc.status !== 'resolved') throw new HttpError(409, 'Only a resolved entry can be reopened');
    await update(db, 'incidents', inc.id, req.user.practice_id, { status: 'open', resolved_at: null, resolved_by: null });
    await audit(db, req, 'incident.reopen', 'incidents', inc.id, { reason: clip(req.body?.reason, 300) }, { patientId: inc.patient_id });
    res.json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, inc.id));
  });
  // Entered by mistake: kept, marked void with the reason (managers only).
  r.post('/incidents/:iid/void', requirePermission('compliance:manage'), async (req, res) => {
    const inc = await incidentOr404(req);
    const reason = clip(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Give a reason');
    if (inc.status === 'voided') throw new HttpError(409, 'Already voided');
    await update(db, 'incidents', inc.id, req.user.practice_id, { status: 'voided', void_reason: reason });
    await closeTask(req, inc);
    await audit(db, req, 'incident.void', 'incidents', inc.id, { reason }, { patientId: inc.patient_id, reason });
    res.json(await db.get(`${INCIDENT_SELECT} WHERE i.id = ?`, inc.id));
  });

  // The manager's report: counts by kind, severity and status for a period, how long they took to resolve,
  // and every entry — on screen or as a spreadsheet (CSV).
  r.get('/incidents/report', requirePermission('compliance:manage'), async (req, res) => {
    const to = isRealDate(req.query.to) ? req.query.to : await today(req);
    const from = isRealDate(req.query.from) ? req.query.from : `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    const rows = await db.all(`${INCIDENT_SELECT} WHERE i.practice_id = ? AND i.status != 'voided' AND substr(i.occurred_at, 1, 10) BETWEEN ? AND ? ORDER BY i.occurred_at`, req.user.practice_id, from, to);
    await audit(db, req, 'incident.report', 'incidents', null, { from, to, rows: rows.length, format: req.query.format || 'json' });
    if (req.query.format === 'csv') {
      const csv = toCsv(rows, [['When', (x) => x.occurred_at], ['Kind', (x) => x.kind], ['Severity', (x) => x.severity], ['What happened', (x) => x.summary], ['Details', (x) => x.details],
        ['Who was involved', (x) => x.people], ['Patient', (x) => (x.patient_id ? `${x.first_name} ${x.last_name} (#${x.patient_id})` : '')], ['Reported by', (x) => x.reported_by_name],
        ['Follow-up', (x) => x.follow_up_name], ['Due', (x) => x.follow_up_due], ['Status', (x) => x.status], ['Resolution', (x) => x.resolution], ['Resolved', (x) => (x.resolved_at || '').slice(0, 10)]]);
      return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="complaints-incidents-${from}-to-${to}.csv"` }).send(csv);
    }
    const count = (f) => rows.reduce((m, x) => ({ ...m, [f(x)]: (m[f(x)] || 0) + 1 }), {});
    const days = rows.filter((x) => x.resolved_at).map((x) => (Date.parse(x.resolved_at) - Date.parse(`${x.created_at.replace(' ', 'T')}Z`)) / 86400_000);
    res.json({
      from, to, total: rows.length, by_kind: count((x) => x.kind), by_severity: count((x) => x.severity), by_status: count((x) => x.status),
      avg_days_to_resolve: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
      overdue: rows.filter((x) => x.status === 'open' && x.follow_up_due && x.follow_up_due < to).length, rows,
    });
  });

  // ---------------- Staff exposure incidents (OSHA) ----------------
  const EXPOSURE_TYPES = ['sharps', 'splash', 'bite', 'other'];
  const exposureView = (x) => x && { ...x, followup: JSON.parse(x.followup || '{}'), steps: EXPOSURE_STEPS.map(([key, label]) => ({ key, label })) };
  const EXPOSURE_SELECT = `SELECT e.*, p.first_name AS source_first_name, p.last_name AS source_last_name, rb.name AS recorded_by_name
    FROM exposure_incidents e LEFT JOIN patients p ON p.id = e.source_patient_id LEFT JOIN users rb ON rb.id = e.recorded_by`;
  const exposureOr404 = (req) => findOr404(db, 'exposure_incidents', req.params.xid, req.user.practice_id, 'Exposure incident');
  const cleanFollowup = (input, before = {}) => {
    const out = { ...before };
    for (const [key] of EXPOSURE_STEPS) {
      if (!(key in (input || {}))) continue;
      const v = input[key];
      if (v === null || v === false || v === '') out[key] = null;
      else if (v === true) out[key] = before[key] || null;
      else if (isRealDate(v)) out[key] = v;
      else throw new HttpError(400, `${key}: a date (YYYY-MM-DD), or empty`);
    }
    return out;
  };

  r.get('/exposures/steps', requirePermission('compliance:exposures'), (_req, res) => res.json(EXPOSURE_STEPS.map(([key, label]) => ({ key, label }))));
  r.get('/exposures', requirePermission('compliance:exposures'), async (req, res) => {
    const all = req.query.status === 'all';
    const rows = await db.all(`${EXPOSURE_SELECT} WHERE e.practice_id = ?${all ? '' : " AND e.status != 'voided'"} ORDER BY e.occurred_at DESC LIMIT 500`, req.user.practice_id);
    res.json(rows.map(exposureView));
  });
  r.post('/exposures', requirePermission('compliance:exposures'), async (req, res) => {
    const b = req.body || {};
    const employee = await staffOr400(req, b.employee_user_id, 'Employee');
    const name = clip(b.employee_name, 120) || employee?.name;
    if (!name) throw new HttpError(400, 'Who was exposed? Choose the employee', { missing: ['employee_user_id'] });
    const description = clip(b.description, 2000);
    if (!description) throw new HttpError(400, 'Say how it happened', { missing: ['description'] });
    const type = b.exposure_type || 'sharps';
    if (!EXPOSURE_TYPES.includes(type)) throw new HttpError(400, `Type must be one of: ${EXPOSURE_TYPES.join(', ')}`);
    const now = await practiceNow(db, req.user.practice_id);
    const occurred = b.occurred_at ? normalizeDateTime(b.occurred_at, 'When') : now.slice(0, 16);
    if (occurred > now.slice(0, 16)) throw new HttpError(400, "“When” can't be in the future");
    const source = await patientOrNull(req, b.source_patient_id);
    // Reporting it is the first step of the follow-up; the person recording it is doing just that.
    const followup = cleanFollowup(b.followup, { reported: now.slice(0, 10) });
    const row = {
      practice_id: req.user.practice_id, location_id: req.location_id ?? null, employee_user_id: employee?.id ?? null, employee_name: name, occurred_at: occurred, exposure_type: type,
      device: clip(b.device, 200), procedure_name: clip(b.procedure_name, 200), body_part: clip(b.body_part, 100), work_area: clip(b.work_area, 100), description,
      source_patient_id: source?.id ?? null, source_unknown: source ? 0 : b.source_unknown ? 1 : 0, immediate_actions: clip(b.immediate_actions, 2000), followup: JSON.stringify(followup), recorded_by: req.user.id,
    };
    const id = await insert(db, 'exposure_incidents', row);
    // The audit entry names the record, not its medical details (the log itself is restricted).
    await audit(db, req, 'exposure.create', 'exposure_incidents', id, { exposure_type: type, employee_user_id: row.employee_user_id, source_recorded: !!source });
    res.status(201).json(exposureView(await db.get(`${EXPOSURE_SELECT} WHERE e.id = ?`, id)));
  });
  r.put('/exposures/:xid', requirePermission('compliance:exposures'), async (req, res) => {
    const x = await exposureOr404(req);
    if (x.status === 'voided') throw new HttpError(409, 'This entry was voided');
    const row = pick(req.body, ['device', 'procedure_name', 'body_part', 'work_area', 'description', 'immediate_actions', 'exposure_type', 'source_patient_id', 'source_unknown']);
    for (const [k, n] of [['device', 200], ['procedure_name', 200], ['body_part', 100], ['work_area', 100], ['description', 2000], ['immediate_actions', 2000]]) if (k in row) row[k] = clip(row[k], n);
    if ('description' in row && !row.description) throw new HttpError(400, 'Say how it happened');
    if ('exposure_type' in row && !EXPOSURE_TYPES.includes(row.exposure_type)) throw new HttpError(400, `Type must be one of: ${EXPOSURE_TYPES.join(', ')}`);
    if ('source_patient_id' in row) row.source_patient_id = (await patientOrNull(req, row.source_patient_id))?.id ?? null;
    if ('source_unknown' in row) row.source_unknown = row.source_unknown ? 1 : 0;
    if (req.body?.followup) row.followup = JSON.stringify(cleanFollowup(req.body.followup, JSON.parse(x.followup || '{}')));
    await update(db, 'exposure_incidents', x.id, req.user.practice_id, row);
    await audit(db, req, 'exposure.change', 'exposure_incidents', x.id, { fields: Object.keys(row) });
    res.json(exposureView(await db.get(`${EXPOSURE_SELECT} WHERE e.id = ?`, x.id)));
  });
  r.post('/exposures/:xid/close', requirePermission('compliance:exposures'), async (req, res) => {
    const x = await exposureOr404(req);
    if (x.status !== 'open') throw new HttpError(409, x.status === 'closed' ? 'Already closed' : 'This entry was voided');
    await update(db, 'exposure_incidents', x.id, req.user.practice_id, { status: 'closed', closed_at: new Date().toISOString(), closed_by: req.user.id });
    await audit(db, req, 'exposure.close', 'exposure_incidents', x.id, { steps_done: Object.values(JSON.parse(x.followup || '{}')).filter(Boolean).length });
    res.json(exposureView(await db.get(`${EXPOSURE_SELECT} WHERE e.id = ?`, x.id)));
  });
  r.post('/exposures/:xid/void', requirePermission('compliance:exposures'), async (req, res) => {
    const x = await exposureOr404(req);
    const reason = clip(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Give a reason');
    if (x.status === 'voided') throw new HttpError(409, 'Already voided');
    await update(db, 'exposure_incidents', x.id, req.user.practice_id, { status: 'voided', void_reason: reason });
    await audit(db, req, 'exposure.void', 'exposure_incidents', x.id, { reason }, { reason });
    res.json(exposureView(await db.get(`${EXPOSURE_SELECT} WHERE e.id = ?`, x.id)));
  });
  // The sharps injury log (1910.1030(h)(5)): device type and brand, where, how — kept without the employee's name
  // unless asked (?names=1), as the rule requires the log to protect their confidentiality.
  r.get('/exposures/export.csv', requirePermission('compliance:exposures'), async (req, res) => {
    const names = req.query.names === '1';
    const rows = await db.all(`${EXPOSURE_SELECT} WHERE e.practice_id = ? AND e.status != 'voided' ORDER BY e.occurred_at`, req.user.practice_id);
    await audit(db, req, 'exposure.export', 'exposure_incidents', null, { rows: rows.length, names });
    const steps = EXPOSURE_STEPS.map(([key, label]) => [label, (x) => JSON.parse(x.followup || '{}')[key] || '']);
    const csv = toCsv(rows, [['Case #', (x) => x.id], ['Date and time', (x) => x.occurred_at], ...(names ? [['Employee', (x) => x.employee_name]] : []), ['Type', (x) => x.exposure_type],
      ['Device (type and brand)', (x) => x.device], ['Procedure', (x) => x.procedure_name], ['Work area', (x) => x.work_area], ['Body part', (x) => x.body_part], ['How it happened', (x) => x.description],
      ['Immediate actions', (x) => x.immediate_actions], ['Source patient known', (x) => (x.source_patient_id ? 'yes' : x.source_unknown ? 'unknown' : 'not recorded')], ...steps, ['Status', (x) => x.status]]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sharps-injury-log.csv"' }).send(csv);
  });

  // ---------------- HIPAA accounting of disclosures ----------------
  const DISCLOSURE_SELECT = `SELECT d.*, u.name AS recorded_by_name, vu.name AS voided_by_name, p.first_name, p.last_name
    FROM phi_disclosures d LEFT JOIN users u ON u.id = d.recorded_by LEFT JOIN users vu ON vu.id = d.voided_by JOIN patients p ON p.id = d.patient_id`;
  r.get('/disclosures/purposes', requirePermission('patients:read'), (_req, res) => res.json(Object.entries(DISCLOSURE_PURPOSES).map(([key, label]) => ({ key, label }))));
  r.get('/patients/:id/disclosures', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(`${DISCLOSURE_SELECT} WHERE d.practice_id = ? AND d.patient_id = ? ORDER BY d.disclosed_on DESC, d.id DESC`, req.user.practice_id, patient.id));
  });
  r.post('/patients/:id/disclosures', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const id = await recordDisclosure(db, req, patient, req.body || {}, { today: await today(req) });
    res.status(201).json(await db.get(`${DISCLOSURE_SELECT} WHERE d.id = ?`, id));
  });
  // Recorded in error: kept (the accounting shows only live ones), voided with the reason by a manager.
  r.post('/disclosures/:did/void', requirePermission('compliance:manage'), async (req, res) => {
    const d = await findOr404(db, 'phi_disclosures', req.params.did, req.user.practice_id, 'Disclosure');
    const reason = clip(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Give a reason');
    if (d.status === 'voided') throw new HttpError(409, 'Already voided');
    await update(db, 'phi_disclosures', d.id, req.user.practice_id, { status: 'voided', void_reason: reason, voided_by: req.user.id, voided_at: new Date().toISOString() });
    await audit(db, req, 'disclosure.void', 'phi_disclosures', d.id, { reason, patient_id: d.patient_id }, { patientId: d.patient_id, reason });
    res.json(await db.get(`${DISCLOSURE_SELECT} WHERE d.id = ?`, d.id));
  });
  // Practice-wide log (managers): who got what, for everyone.
  r.get('/disclosures', requirePermission('compliance:manage'), async (req, res) => {
    const to = isRealDate(req.query.to) ? req.query.to : await today(req);
    const from = isRealDate(req.query.from) ? req.query.from : `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    const rows = await db.all(`${DISCLOSURE_SELECT} WHERE d.practice_id = ? AND d.disclosed_on BETWEEN ? AND ? ORDER BY d.disclosed_on DESC, d.id DESC LIMIT 1000`, req.user.practice_id, from, to);
    res.json({ from, to, rows });
  });
  // The patient's accounting (164.528): every live disclosure in the six years before the request (or since ?from),
  // as a PDF to hand or mail them, or a CSV. Giving it is itself recorded (audit: disclosure.accounting).
  r.get('/patients/:id/disclosures/accounting', requirePermission('patients:read'), requirePermission('compliance:manage'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const to = await today(req);
    const earliest = `${Number(to.slice(0, 4)) - ACCOUNTING_YEARS}${to.slice(4)}`;
    const from = isRealDate(req.query.from) && req.query.from > earliest ? req.query.from : earliest;
    const rows = await db.all(`${DISCLOSURE_SELECT} WHERE d.practice_id = ? AND d.patient_id = ? AND d.status = 'active' AND d.disclosed_on BETWEEN ? AND ? ORDER BY d.disclosed_on, d.id`,
      req.user.practice_id, patient.id, from, to);
    const format = req.query.format === 'csv' ? 'csv' : 'pdf';
    await audit(db, req, 'disclosure.accounting', 'patients', patient.id, { from, to, rows: rows.length, format }, { patientId: patient.id });
    const purpose = (x) => `${DISCLOSURE_PURPOSES[x.purpose] || x.purpose}${x.purpose_detail ? ` — ${x.purpose_detail}` : ''}`;
    const file = `disclosures-${patient.last_name}-${patient.id}-${to}`.replace(/[^\w.-]+/g, '_');
    if (format === 'csv') {
      const csv = toCsv(rows, [['Date', (x) => x.disclosed_on], ['Recipient', (x) => x.recipient], ['Recipient address', (x) => x.recipient_address], ['What was disclosed', (x) => x.description], ['Purpose', purpose]]);
      return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}.csv"` }).send(csv);
    }
    const practice = await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', req.user.practice_id);
    const doc = new PdfDoc({ footer: `${practice.name} · Accounting of disclosures · ${patient.first_name} ${patient.last_name}` });
    doc.text(practice.name, { size: 14, bold: true });
    doc.text([practice.address, [practice.city, practice.state, practice.zip].filter(Boolean).join(' '), practice.phone].filter(Boolean).join(' · '), { size: 9 });
    doc.space(10);
    doc.text('Accounting of disclosures of protected health information', { size: 13, bold: true });
    doc.text(`Patient: ${patient.first_name} ${patient.last_name}${patient.dob ? ` (born ${patient.dob})` : ''} · Chart #${patient.id}`);
    doc.text(`Period: ${from} to ${to} · Prepared ${to}`);
    doc.text('This lists disclosures of your health information that the law requires us to account for. It does not include disclosures for your treatment, payment or our health care operations, disclosures to you, or disclosures you authorized in writing.', { size: 9, color: [0.35, 0.38, 0.45] });
    doc.rule();
    if (!rows.length) doc.text('No disclosures to report for this period.');
    for (const x of rows) {
      doc.text(`${x.disclosed_on} — ${x.recipient}`, { bold: true });
      if (x.recipient_address) doc.text(x.recipient_address, { indent: 12, size: 9.5 });
      doc.text(`What: ${x.description}`, { indent: 12 });
      doc.text(`Why: ${purpose(x)}`, { indent: 12 });
      doc.space(4);
    }
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${file}.pdf"` }).send(doc.toBuffer());
  });

  // Who can do what here, for the screen (tabs it shows).
  r.get('/compliance/access', requirePermission('patients:read'), (req, res) => res.json({ manager: isManager(req.user), exposures: can(req.user, 'compliance:exposures') }));
  return r;
}
