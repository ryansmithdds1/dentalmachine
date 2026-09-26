import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, requirePermission, can } from '../auth.js';
import { audit, findOr404, insert, isRealDate } from '../util.js';
import { withActor } from '../actor.js';
import { ensureTrainingPatient, trainingPatientOf, resetTrainingPatient, prepareTraining, parseNeeds, trainingActor } from '../training.js';

// Guided walkthroughs ("Show me"): the training patient, who has done which tour, and the tours a manager assigns.
//   POST /training/patient            the practice's training patient (made on first use)
//   POST /training/patient/prepare    get it ready for one tour ({ needs: ['visit_today:checked_in', …] })
//   POST /training/patient/reset      back to a clean chart (audited; training records are scratch data)
//   POST /training/runs               I started a tour · PATCH /training/runs/:id  how far I got / how it ended
//   GET  /training/me                 my to-do list (assigned tours) and what I've completed
//   GET  /training/team               everyone's progress (training:manage)
//   POST /training/assignments        give someone a set of tours (training:manage) · POST …/:id/cancel
// Everyone may practise and keep their own record; assigning and seeing the team needs training:manage.

const here = dirname(fileURLToPath(import.meta.url));
// The tours that exist (ids, titles, who they're for) and the ready-made sets, written by `npm run tours`.
let index = null;
export function tourIndex() {
  if (!index) {
    try { index = JSON.parse(readFileSync(join(here, '../tourindex.json'), 'utf8')); } catch { index = { tours: {}, sets: [] }; }
  }
  return index;
}
const tourExists = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(tourIndex().tours, id);
const intIn = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};
const key = (v) => (v == null ? null : String(v).slice(0, 80));

// Progress on one assignment: which of its tours this person has completed (ever — a tour done before it was
// assigned still counts).
function progressOf(assignment, done) {
  const tours = JSON.parse(assignment.tour_ids || '[]');
  const finished = tours.filter((t) => done.has(t));
  return {
    id: assignment.id, title: assignment.title, set_key: assignment.set_key, due_on: assignment.due_on, status: assignment.status,
    assigned_by: assignment.assigned_by_name || null, created_at: assignment.created_at,
    tours, done: finished, pct: tours.length ? Math.round((finished.length / tours.length) * 100) : 100,
  };
}
async function completedBy(db, practiceId, userId) {
  const rows = await db.all("SELECT tour_id, MAX(finished_at) AS at, COUNT(*) AS n FROM tour_runs WHERE practice_id = ? AND user_id = ? AND status = 'completed' GROUP BY tour_id", practiceId, userId);
  return new Map(rows.map((r) => [r.tour_id, r.at]));
}
async function assignmentsOf(db, practiceId, userId) {
  return db.all(
    `SELECT a.*, u.name AS assigned_by_name FROM training_assignments a LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.practice_id = ? AND a.user_id = ? AND a.status = 'active' ORDER BY a.id`, practiceId, userId,
  );
}

export default function trainingRoutes({ db, storage = null }) {
  const r = Router();

  r.post('/training/patient', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const had = await trainingPatientOf(db, pid);
    const p = had || await withActor(trainingActor(req.user), () => ensureTrainingPatient(db, pid, req.user.id));
    if (!had) await audit(db, req, 'training.patient.create', 'patients', p.id, { name: `${p.first_name} ${p.last_name}` });
    res.status(had ? 200 : 201).json({ id: p.id, first_name: p.first_name, last_name: p.last_name, is_training: 1 });
  });

  r.post('/training/patient/prepare', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const needs = parseNeeds(req.body?.needs ?? []);
    const tour = req.body?.tour_id == null ? null : String(req.body.tour_id);
    if (tour && !tourExists(tour)) throw new HttpError(400, 'Unknown tour');
    const p = await trainingPatientOf(db, pid) || await withActor(trainingActor(req.user), () => ensureTrainingPatient(db, pid, req.user.id));
    const out = await withActor(trainingActor(req.user), () => prepareTraining(db, pid, p.id, needs.map((n) => (n.arg ? `${n.kind}:${n.arg}` : n.kind)), req.user.id, { storage, req }));
    if (needs.length) await audit(db, req, 'training.prepare', 'patients', p.id, { tour, needs: needs.map((n) => (n.arg ? `${n.kind}:${n.arg}` : n.kind)) });
    res.json(out);
  });

  r.post('/training/patient/reset', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const p = await trainingPatientOf(db, pid);
    if (!p) throw new HttpError(404, 'There is no training patient yet');
    const { removed, counts } = await withActor(trainingActor(req.user), () => resetTrainingPatient(db, pid, p.id, req.user.id, { storage }));
    await audit(db, req, 'training.patient.reset', 'patients', p.id, { removed, tables: counts }, { reason: 'Training patient reset to a clean chart (practice data only)' });
    res.json({ ok: true, id: p.id, removed });
  });

  // ---- Tour runs: my own record ----
  r.post('/training/runs', async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const tourId = String(b.tour_id ?? '');
    if (!tourExists(tourId)) throw new HttpError(400, 'Unknown tour');
    const clientKey = key(b.client_key);
    if (clientKey) {
      const again = await db.get('SELECT * FROM tour_runs WHERE user_id = ? AND client_key = ?', req.user.id, clientKey);
      if (again) return res.json(again);
    }
    const onTraining = b.on_training === false || b.on_training === 0 ? 0 : 1;
    let patientId = null;
    if (b.patient_id != null) {
      const p = await findOr404(db, 'patients', b.patient_id, pid, 'Patient');
      if (onTraining && !p.is_training) throw new HttpError(400, 'That is a real patient: start the tour on the training patient, or say it runs on a real chart');
      if (!onTraining && p.is_training) throw new HttpError(400, 'That is the training patient');
      patientId = p.id;
    }
    const id = await insert(db, 'tour_runs', {
      practice_id: pid, user_id: req.user.id, tour_id: tourId, on_training: onTraining, patient_id: patientId,
      steps_total: intIn(b.steps_total ?? 0, 0, 200, 'steps_total'), client_key: clientKey,
    });
    await audit(db, req, 'training.tour.start', 'tour_runs', id, { tour_id: tourId, on_training: onTraining }, { patientId });
    res.status(201).json(await db.get('SELECT * FROM tour_runs WHERE id = ?', id));
  });

  r.patch('/training/runs/:id', async (req, res) => {
    const run = await findOr404(db, 'tour_runs', req.params.id, req.user.practice_id, 'Tour');
    if (run.user_id !== req.user.id) throw new HttpError(403, 'That is someone else’s tour');
    if (run.status !== 'started') throw new HttpError(409, 'This tour has already ended');
    const b = req.body || {};
    const status = b.status ?? 'started';
    if (!['started', 'completed', 'exited'].includes(status)) throw new HttpError(400, 'status must be started, completed or exited');
    const total = run.steps_total || 200;
    const done = b.steps_done == null ? run.steps_done : intIn(b.steps_done, 0, total, 'steps_done');
    const shown = b.steps_shown == null ? run.steps_shown : intIn(b.steps_shown, 0, total, 'steps_shown');
    await db.run(
      `UPDATE tour_runs SET steps_done = ?, steps_shown = ?, status = ?${status === 'started' ? '' : ", finished_at = datetime('now')"} WHERE id = ?`,
      done, shown, status, run.id,
    );
    if (status !== 'started') {
      await audit(db, req, status === 'completed' ? 'training.tour.complete' : 'training.tour.exit', 'tour_runs', run.id,
        { tour_id: run.tour_id, steps_done: done, steps_total: run.steps_total, steps_shown: shown }, { patientId: run.patient_id });
    }
    res.json(await db.get('SELECT * FROM tour_runs WHERE id = ?', run.id));
  });

  r.get('/training/me', async (req, res) => {
    const pid = req.user.practice_id;
    const done = await completedBy(db, pid, req.user.id);
    const assignments = (await assignmentsOf(db, pid, req.user.id)).map((a) => progressOf(a, done));
    const recent = await db.all('SELECT id, tour_id, status, on_training, steps_done, steps_total, started_at, finished_at FROM tour_runs WHERE practice_id = ? AND user_id = ? ORDER BY id DESC LIMIT 20', pid, req.user.id);
    const training = await trainingPatientOf(db, pid);
    res.json({ completed: Object.fromEntries(done), assignments, recent, training_patient: training ? { id: training.id, first_name: training.first_name, last_name: training.last_name } : null, can_manage: can(req.user, 'training:manage') });
  });

  r.get('/training/sets', (_req, res) => res.json({ sets: tourIndex().sets || [] }));

  // ---- Managers ----
  r.get('/training/team', requirePermission('training:manage'), async (req, res) => {
    const pid = req.user.practice_id;
    const users = await db.all('SELECT id, name, role, email FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid);
    const runs = await db.all(
      `SELECT user_id, tour_id, status, finished_at, started_at FROM tour_runs WHERE practice_id = ? ORDER BY id`, pid,
    );
    const out = [];
    for (const u of users) {
      const mine = runs.filter((x) => x.user_id === u.id);
      const done = new Map(mine.filter((x) => x.status === 'completed').map((x) => [x.tour_id, x.finished_at]));
      const assignments = (await assignmentsOf(db, pid, u.id)).map((a) => progressOf(a, done));
      const assigned = [...new Set(assignments.flatMap((a) => a.tours))];
      out.push({
        id: u.id, name: u.name, role: u.role, completed: Object.fromEntries(done), started: mine.length,
        last_at: mine.reduce((m, x) => ((x.finished_at || x.started_at) > m ? (x.finished_at || x.started_at) : m), '') || null,
        assignments, pct: assigned.length ? Math.round((assigned.filter((t) => done.has(t)).length / assigned.length) * 100) : null,
      });
    }
    res.json({ people: out, sets: tourIndex().sets || [] });
  });

  r.post('/training/assignments', requirePermission('training:manage'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const clientKey = key(b.client_key);
    if (clientKey) {
      const again = await db.get('SELECT * FROM training_assignments WHERE practice_id = ? AND client_key = ?', pid, clientKey);
      if (again) return res.json(again);
    }
    const person = await findOr404(db, 'users', b.user_id, pid, 'Team member');
    if (!person.active) throw new HttpError(400, 'That person’s login is switched off');
    const set = b.set_key ? (tourIndex().sets || []).find((s) => s.key === b.set_key) : null;
    if (b.set_key && !set) throw new HttpError(400, 'Unknown training set');
    const tours = [...new Set(set ? set.tours : Array.isArray(b.tour_ids) ? b.tour_ids.map(String) : [])];
    if (!tours.length || tours.length > 60) throw new HttpError(400, 'Choose between 1 and 60 tours');
    const unknown = tours.filter((t) => !tourExists(t));
    if (unknown.length) throw new HttpError(400, `Unknown tour: ${unknown.join(', ')}`);
    const title = String(b.title ?? set?.title ?? '').trim().slice(0, 120);
    if (!title) throw new HttpError(400, 'Give the training a name');
    if (b.due_on != null && b.due_on !== '' && !isRealDate(b.due_on)) throw new HttpError(400, 'due_on must be a real date (YYYY-MM-DD)');
    const id = await insert(db, 'training_assignments', {
      practice_id: pid, user_id: person.id, set_key: set?.key ?? null, title, tour_ids: JSON.stringify(tours), due_on: b.due_on || null,
      assigned_by: req.user.id, client_key: clientKey,
    });
    await audit(db, req, 'training.assign', 'training_assignments', id, { user_id: person.id, name: person.name, title, tours: tours.length }, { after: { title, tours: tours.join(', '), due_on: b.due_on || null } });
    res.status(201).json(await db.get('SELECT * FROM training_assignments WHERE id = ?', id));
  });

  r.post('/training/assignments/:id/cancel', requirePermission('training:manage'), async (req, res) => {
    const a = await findOr404(db, 'training_assignments', req.params.id, req.user.practice_id, 'Assignment');
    if (a.status === 'cancelled') return res.json(a);
    await db.run("UPDATE training_assignments SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = ? WHERE id = ?", req.user.id, a.id);
    await audit(db, req, 'training.unassign', 'training_assignments', a.id, { user_id: a.user_id, title: a.title }, { before: { status: 'active' }, after: { status: 'cancelled' } });
    res.json(await db.get('SELECT * FROM training_assignments WHERE id = ?', a.id));
  });

  return r;
}
