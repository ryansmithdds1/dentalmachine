import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { insert, update, findOr404, audit, practiceNow, isRealDate, mapSeq } from '../util.js';
import { plansProgress, planNotes, notesView, NOTE_TAGS, PLAN_STAGES, OPEN_STAGES } from '../planprogress.js';

// Where each treatment plan stands, and the office's own notes on it ("going home to discuss"), with an optional
// follow-up date that becomes a task. Notes are staff-only: nothing patient-facing (the plan page, the portal, the
// printout, the PDF) reads them. See planprogress.js.
export default function planNoteRoutes({ db }) {
  const r = Router();
  const today = async (pid) => (await practiceNow(db, pid)).slice(0, 10);
  // The balance is money: only people who can see ledgers get the dollars.
  const shown = (req, progress) => (can(req.user, 'billing:read') ? progress : { ...progress, balance: undefined, charged: undefined });

  r.get('/treatment-plans/:tid/notes', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const progress = (await plansProgress(db, plan.practice_id, plan.patient_id, [plan], await today(plan.practice_id))).get(plan.id);
    res.json({ ...notesView(await planNotes(db, plan.practice_id, [plan.id])), progress: shown(req, progress), tags: NOTE_TAGS });
  });

  // A note (a chip, free text or both), optionally a follow-up date (one open follow-up task per plan: made, or its
  // date moved) and optionally where the plan stands now: 'thinking' (thinking it over), 'declined', or 'reopen'.
  // corrects_id: this note replaces an earlier one (which stays, marked as corrected).
  r.post('/treatment-plans/:tid/notes', requirePermission('patients:write'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const b = req.body || {};
    const tag = b.tag == null || b.tag === '' ? null : String(b.tag);
    if (tag && !NOTE_TAGS[tag]) throw new HttpError(400, `tag must be one of: ${Object.keys(NOTE_TAGS).join(', ')}`);
    const text = String(b.text ?? '').trim();
    if (text.length > 1000) throw new HttpError(400, 'A note can be up to 1,000 characters');
    const note = text || (tag ? NOTE_TAGS[tag] : '');
    const stage = b.stage == null || b.stage === '' ? null : String(b.stage);
    if (stage && !['thinking', 'declined', 'reopen'].includes(stage)) throw new HttpError(400, 'stage must be thinking, declined or reopen');
    if (!note && !stage && !b.follow_up_date) throw new HttpError(400, 'Write a note, pick one, or set a follow-up date');
    // Turning a plan down (or back) is a clinical call, as on the plan itself.
    if (stage === 'declined' && plan.status === 'rejected') throw new HttpError(409, 'This plan is already declined');
    if (stage === 'reopen' && plan.status !== 'rejected' && plan.decision !== 'thinking') throw new HttpError(409, 'Only a declined plan or one being thought over can be reopened');
    if ((stage === 'declined' || (stage === 'reopen' && plan.status === 'rejected')) && !can(req.user, 'clinical:write')) throw new HttpError(403, 'Declining or reopening a plan needs clinical permission');
    if (stage && ['completed'].includes(plan.status)) throw new HttpError(409, 'This plan is completed');
    const day = await today(plan.practice_id);
    let followUp = null;
    if (b.follow_up_date) {
      followUp = String(b.follow_up_date);
      if (!isRealDate(followUp)) throw new HttpError(400, 'follow_up_date must be a real date (YYYY-MM-DD)');
      if (followUp < day) throw new HttpError(400, 'The follow-up date is in the past');
      if (followUp > `${Number(day.slice(0, 4)) + 3}${day.slice(4)}`) throw new HttpError(400, 'The follow-up date is more than 3 years away');
    }
    let corrects = null;
    if (b.corrects_id != null) {
      corrects = await db.get('SELECT id FROM followups WHERE id = ? AND practice_id = ? AND treatment_plan_id = ?', Number(b.corrects_id) || 0, plan.practice_id, plan.id);
      if (!corrects) throw new HttpError(404, 'That note is not on this plan');
      if (await db.get('SELECT id FROM followups WHERE corrects_id = ?', corrects.id)) throw new HttpError(409, 'That note was already corrected');
    }
    const before = { status: plan.status, decision: plan.decision ?? null };
    let id;
    let taskId = null;
    await db.tx(async () => {
      if (stage === 'thinking') await update(db, 'treatment_plans', plan.id, plan.practice_id, { decision: 'thinking' });
      if (stage === 'declined') await update(db, 'treatment_plans', plan.id, plan.practice_id, { status: 'rejected', decision: null });
      if (stage === 'reopen') await update(db, 'treatment_plans', plan.id, plan.practice_id, { status: plan.status === 'rejected' ? 'proposed' : plan.status, decision: null });
      if (followUp) {
        // The plan's follow-up task, while it's open, moves to the new date; otherwise a new one for the writer.
        const open = await db.get("SELECT t.id FROM followups f JOIN tasks t ON t.id = f.task_id WHERE f.treatment_plan_id = ? AND f.practice_id = ? AND t.status = 'open' ORDER BY f.id DESC LIMIT 1", plan.id, plan.practice_id);
        if (open) {
          await update(db, 'tasks', open.id, plan.practice_id, { due_date: followUp });
          taskId = open.id;
        } else {
          taskId = await insert(db, 'tasks', {
            practice_id: plan.practice_id, patient_id: plan.patient_id, assigned_to: req.user.id, created_by: req.user.id, due_date: followUp,
            title: `Follow up on treatment plan: ${plan.name}`.slice(0, 200), notes: note ? note.slice(0, 1000) : null,
          });
        }
      }
      const fresh = await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id);
      const now = (await plansProgress(db, plan.practice_id, plan.patient_id, [fresh], day)).get(plan.id);
      id = await insert(db, 'followups', {
        practice_id: plan.practice_id, patient_id: plan.patient_id, kind: 'unscheduled', outcome: 'note', note: note || (stage ? `Marked “${PLAN_STAGES[now.stage]}”` : `Follow up on ${followUp}`),
        tag, treatment_plan_id: plan.id, follow_up_date: followUp, task_id: taskId, corrects_id: corrects?.id ?? null, plan_stage: now.stage, created_by: req.user.id,
      });
    });
    const after = await db.get('SELECT status, decision FROM treatment_plans WHERE id = ?', plan.id);
    await audit(db, req, 'treatment_plan.note', 'treatment_plans', plan.id, { note_id: id, tag, follow_up_date: followUp, task_id: taskId, stage, corrects_id: corrects?.id ?? null, patient_id: plan.patient_id },
      { before, after: { status: after.status, decision: after.decision ?? null } });
    const view = notesView(await planNotes(db, plan.practice_id, [plan.id]));
    const progress = (await plansProgress(db, plan.practice_id, plan.patient_id, [{ ...plan, ...after }], day)).get(plan.id);
    res.status(201).json({ ...view, note: view.notes.find((n) => n.id === id), progress: shown(req, progress) });
  });

  // Plans in process, by where they stand, with the latest note and the follow-up date: the list the office works
  // (Follow-ups → Plans in process). ?stage= narrows it; ?all=1 includes declined, expired and paid plans.
  r.get('/followups/plans', requirePermission('clinical:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const day = await today(pid);
    const plans = await db.all(
      `SELECT tp.*, p.first_name, p.last_name, p.phone, p.email FROM real_treatment_plans tp JOIN real_patients p ON p.id = tp.patient_id
       WHERE tp.practice_id = ? AND p.status = 'active' ORDER BY tp.id DESC LIMIT 2000`, pid,
    );
    const byPatient = new Map();
    for (const p of plans) byPatient.set(p.patient_id, [...(byPatient.get(p.patient_id) || []), p]);
    const progress = new Map();
    await mapSeq([...byPatient], async ([patientId, list]) => {
      for (const [k, v] of await plansProgress(db, pid, patientId, list, day)) progress.set(k, v);
    });
    const notes = await planNotes(db, pid, plans.map((p) => p.id));
    const fees = new Map((await db.all(
      `SELECT treatment_plan_id AS id, SUM(fee) AS fee FROM procedures WHERE practice_id = ? AND status = 'planned' AND treatment_plan_id IS NOT NULL GROUP BY treatment_plan_id`, pid,
    )).map((x) => [x.id, Number(x.fee) || 0]));
    const want = req.query.stage ? String(req.query.stage).split(',') : null;
    const rows = plans.map((p) => {
      const g = progress.get(p.id);
      const v = notesView(notes.filter((n) => n.treatment_plan_id === p.id));
      return {
        plan_id: p.id, name: p.name, option_label: p.option_label, patient_id: p.patient_id, first_name: p.first_name, last_name: p.last_name, phone: p.phone, email: p.email,
        created_at: p.created_at, presented_at: p.presented_at, signed_at: p.signed_at, planned_fee: fees.get(p.id) || 0,
        ...shown(req, g), latest_note: v.latest ? { text: v.latest.note, tag: v.latest.tag, at: v.latest.created_at, by: v.latest.created_by_name } : null, follow_up: v.follow_up,
      };
    }).filter((x) => (want ? want.includes(x.stage) : req.query.all ? true : x.open));
    const counts = {};
    for (const x of rows) counts[x.stage] = (counts[x.stage] || 0) + 1;
    // Soonest follow-up first, then the oldest plan without one.
    rows.sort((a, b) => (a.follow_up?.date || '9999').localeCompare(b.follow_up?.date || '9999') || String(a.created_at).localeCompare(String(b.created_at)));
    res.json({ rows, counts, stages: PLAN_STAGES, open_stages: OPEN_STAGES });
  });

  return r;
}
