import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow } from '../util.js';

const LAB_STATUSES = ['sent', 'received', 'returned_for_adjustment', 'delivered', 'cancelled'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Office workflow: lab case tracking and the team to-do list.
export default function officeRoutes({ db }) {
  const r = Router();

  // ---- Lab cases ----
  const LAB_FIELDS = ['patient_id', 'provider_id', 'appointment_id', 'lab_name', 'description', 'tooth', 'shade', 'status', 'sent_date', 'due_date', 'received_date', 'cost', 'notes'];
  const validateLab = (req, row) => {
    requireOneOf(row.status, LAB_STATUSES, 'status');
    for (const k of ['sent_date', 'due_date', 'received_date']) if (row[k] && !DATE.test(row[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
    if (row.patient_id) findOr404(db, 'patients', row.patient_id, req.user.practice_id, 'Patient');
    if (row.provider_id) findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.appointment_id) findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment');
    if (row.cost != null) row.cost = toCents(row.cost, 'cost');
    if (row.status === 'received' && !row.received_date) row.received_date = practiceNow(db, req.user.practice_id).slice(0, 10);
  };
  const LAB_SELECT = `SELECT l.*, p.first_name, p.last_name, pv.name AS provider_name, a.start_time AS appointment_time
    FROM lab_cases l JOIN patients p ON p.id = l.patient_id LEFT JOIN providers pv ON pv.id = l.provider_id LEFT JOIN appointments a ON a.id = l.appointment_id`;

  r.get('/lab-cases', requirePermission('clinical:read'), (req, res) => {
    const where = ['l.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.patient_id) {
      where.push('l.patient_id = ?');
      params.push(Number(req.query.patient_id));
    }
    if (req.query.open === 'true') where.push("l.status IN ('sent','returned_for_adjustment','received')");
    const today = practiceNow(db, req.user.practice_id).slice(0, 10);
    res.json(db.all(`${LAB_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.due_date IS NULL, l.due_date, l.id DESC`, ...params).map((l) => ({
      ...l,
      overdue: ['sent', 'returned_for_adjustment'].includes(l.status) && !!l.due_date && l.due_date < today,
      // The seat appointment is coming up but the case isn't back yet.
      at_risk: ['sent', 'returned_for_adjustment'].includes(l.status) && !!l.appointment_time && l.appointment_time.slice(0, 10) <= l.due_date,
    })));
  });

  r.post('/lab-cases', requirePermission('clinical:write'), (req, res) => {
    const row = pick(req.body, LAB_FIELDS);
    requireFields(row, ['patient_id', 'lab_name', 'description']);
    row.status ??= 'sent';
    row.sent_date ??= practiceNow(db, req.user.practice_id).slice(0, 10);
    validateLab(req, row);
    const id = insert(db, 'lab_cases', { ...row, practice_id: req.user.practice_id });
    audit(db, req, 'lab_case.create', 'lab_cases', id);
    res.status(201).json(db.get(`${LAB_SELECT} WHERE l.id = ?`, id));
  });

  r.put('/lab-cases/:lid', requirePermission('clinical:write'), (req, res) => {
    const existing = findOr404(db, 'lab_cases', req.params.lid, req.user.practice_id, 'Lab case');
    const row = pick(req.body, LAB_FIELDS);
    if (row.status === 'received' && existing.received_date) row.received_date ??= existing.received_date;
    validateLab(req, row);
    update(db, 'lab_cases', existing.id, req.user.practice_id, row);
    audit(db, req, 'lab_case.update', 'lab_cases', existing.id, row.status ? { status: row.status } : undefined);
    res.json(db.get(`${LAB_SELECT} WHERE l.id = ?`, existing.id));
  });

  // ---- Tasks ----
  const TASK_FIELDS = ['patient_id', 'assigned_to', 'title', 'notes', 'due_date', 'priority', 'status'];
  const TASK_SELECT = `SELECT t.*, p.first_name, p.last_name, u.name AS assigned_to_name, c.name AS created_by_name
    FROM tasks t LEFT JOIN patients p ON p.id = t.patient_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by`;
  const validateTask = (req, row) => {
    requireOneOf(row.priority, ['low', 'normal', 'high'], 'priority');
    requireOneOf(row.status, ['open', 'done'], 'status');
    if (row.due_date && !DATE.test(row.due_date)) throw new HttpError(400, 'due_date must be YYYY-MM-DD');
    if (row.patient_id) findOr404(db, 'patients', row.patient_id, req.user.practice_id, 'Patient');
    if (row.assigned_to) findOr404(db, 'users', row.assigned_to, req.user.practice_id, 'User');
  };

  r.get('/tasks', (req, res) => {
    const where = ['t.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.mine === 'true') {
      where.push('(t.assigned_to = ? OR t.assigned_to IS NULL)');
      params.push(req.user.id);
    }
    if (req.query.patient_id) {
      where.push('t.patient_id = ?');
      params.push(Number(req.query.patient_id));
    }
    where.push(req.query.status === 'done' ? "t.status = 'done'" : "t.status = 'open'");
    res.json(db.all(
      `${TASK_SELECT} WHERE ${where.join(' AND ')}
       ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_date IS NULL, t.due_date, t.id DESC LIMIT 300`, ...params,
    ));
  });

  r.post('/tasks', (req, res) => {
    const row = pick(req.body, TASK_FIELDS);
    requireFields(row, ['title']);
    validateTask(req, row);
    const id = insert(db, 'tasks', { ...row, practice_id: req.user.practice_id, created_by: req.user.id });
    audit(db, req, 'task.create', 'tasks', id);
    res.status(201).json(db.get(`${TASK_SELECT} WHERE t.id = ?`, id));
  });

  r.put('/tasks/:tid', (req, res) => {
    const existing = findOr404(db, 'tasks', req.params.tid, req.user.practice_id, 'Task');
    const row = pick(req.body, TASK_FIELDS);
    validateTask(req, row);
    if (row.status === 'done' && existing.status !== 'done') row.completed_at = new Date().toISOString();
    if (row.status === 'open') row.completed_at = null;
    update(db, 'tasks', existing.id, req.user.practice_id, row);
    audit(db, req, 'task.update', 'tasks', existing.id);
    res.json(db.get(`${TASK_SELECT} WHERE t.id = ?`, existing.id));
  });

  return r;
}
