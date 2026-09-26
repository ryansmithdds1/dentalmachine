// Where a treatment plan stands, at a glance: Presented → Thinking it over → Accepted → Scheduled → In progress →
// Completed → Completed & paid (or Declined / Expired). Everything the system already knows is worked out here, never
// stored: accepted = signed or accepted verbally (status), scheduled = its work is on a visit, in progress = some of it
// is done, completed = all of it is done, paid = what the patient owes on the plan's done work is zero by the ledger
// (allocation.js — the same rule "Why this balance" and the collections reports use). Only the human states are
// stored, by staff, with a note: "thinking it over" (treatment_plans.decision) and declined (status 'rejected').
import { allocate } from './allocation.js';

export const PLAN_STAGES = {
  proposed: 'Not presented yet',
  presented: 'Presented',
  thinking: 'Thinking it over',
  accepted: 'Accepted',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  paid: 'Completed & paid',
  declined: 'Declined',
  expired: 'Expired',
};
// Plans the office still has something to do about (the "Plans in process" list).
export const OPEN_STAGES = ['proposed', 'presented', 'thinking', 'accepted', 'scheduled', 'in_progress', 'completed'];
// A plan nobody said yes to within a year is out of date: fees, insurance and the mouth itself have moved on.
export const PLAN_EXPIRES_DAYS = 365;
// Visits that will (or did) happen: the work on them counts as booked.
const LIVE_VISIT = (status) => status && !['cancelled', 'no_show'].includes(status);

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

// plan: the treatment_plans row. procs: its procedures (not cancelled) with appt_status. money: { charged, open }
// for its done work (from the ledger). today: the practice's date.
export function stageOf(plan, procs, money, today) {
  const done = procs.filter((p) => p.status === 'completed').length;
  const planned = procs.filter((p) => p.status === 'planned');
  const booked = planned.filter((p) => p.appointment_id && LIVE_VISIT(p.appt_status)).length;
  const counts = { total: procs.length, done, planned: planned.length, booked };
  const balance = money?.open ?? 0;
  let stage;
  if (plan.status === 'rejected') stage = 'declined';
  else if ((procs.length && done === procs.length) || (plan.status === 'completed' && !planned.length)) stage = balance > 0 ? 'completed' : 'paid';
  else if (done > 0) stage = 'in_progress';
  else if (booked > 0) stage = 'scheduled';
  else if (plan.status === 'accepted' || plan.signed_at) stage = 'accepted';
  else if (plan.decision === 'thinking') stage = 'thinking';
  else if (daysBetween(String(plan.presented_at || plan.created_at).slice(0, 10), today) > PLAN_EXPIRES_DAYS) stage = 'expired';
  else if (plan.presented_at) stage = 'presented';
  else stage = 'proposed';
  const detail = stage === 'scheduled' && booked < planned.length ? `${booked} of ${planned.length} booked`
    : stage === 'in_progress' ? `${done} of ${procs.length} done` : null;
  return {
    stage, label: PLAN_STAGES[stage], detail, counts, open: OPEN_STAGES.includes(stage),
    // Money on the plan's done work only (planned work isn't owed yet). null: nothing done, nothing charged.
    balance: done > 0 ? balance : null, charged: done > 0 ? money?.charged ?? 0 : null,
  };
}

// Progress for some of one patient's plans, from one read of their procedures and ledger.
export async function plansProgress(db, practiceId, patientId, plans, today) {
  const out = new Map();
  if (!plans.length) return out;
  const ids = plans.map((p) => p.id);
  const inList = ids.map(() => '?').join(',');
  const procs = await db.all(
    `SELECT pr.id, pr.treatment_plan_id, pr.status, pr.appointment_id, a.status AS appt_status FROM procedures pr LEFT JOIN appointments a ON a.id = pr.appointment_id
     WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status != 'cancelled' AND pr.treatment_plan_id IN (${inList})`, practiceId, patientId, ...ids,
  );
  // The ledger is read only when some plan has done work to be paid for.
  let open = null;
  let charged = null;
  if (procs.some((p) => p.status === 'completed')) {
    const entries = await db.all(
      'SELECT l.*, pr.appointment_id AS visit_appointment_id FROM ledger_entries l LEFT JOIN procedures pr ON pr.id = l.procedure_id WHERE l.practice_id = ? AND l.patient_id = ?', practiceId, patientId,
    );
    const lines = await db.all('SELECT ci.claim_id, ci.procedure_id, ci.paid_amount, ci.adjusted_amount FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.practice_id = ? AND c.patient_id = ?', practiceId, patientId);
    const { open_charges: openCharges } = allocate(entries, lines);
    open = new Map();
    for (const c of openCharges) if (c.procedure_id) open.set(c.procedure_id, (open.get(c.procedure_id) || 0) + c.open);
    charged = new Map();
    for (const e of entries) {
      if (e.type === 'charge' && e.procedure_id && !e.voided_at && !e.reverses_id) charged.set(e.procedure_id, (charged.get(e.procedure_id) || 0) + e.amount);
    }
  }
  for (const plan of plans) {
    const mine = procs.filter((p) => p.treatment_plan_id === plan.id);
    const doneIds = mine.filter((p) => p.status === 'completed').map((p) => p.id);
    const money = open ? { open: doneIds.reduce((s, id) => s + (open.get(id) || 0), 0), charged: doneIds.reduce((s, id) => s + (charged.get(id) || 0), 0) } : null;
    out.set(plan.id, stageOf(plan, mine, money, today));
  }
  return out;
}

// ---- Staff notes on a plan ----
// Kept with the unscheduled-treatment follow-ups (the `followups` table, kind 'unscheduled', linked to the plan), so
// the call list's "last contact" and the patient's follow-up history show them too. Staff-only: no patient-facing
// view, portal, printout or PDF reads this table. Append-only: a correction is a new note pointing at the old one.
export const NOTE_TAGS = {
  discuss: 'Going home to discuss',
  insurance: 'Waiting on insurance / pre-auth',
  financing: 'Wants financing options',
  call_back: 'Will call back',
  price: 'Price concern',
  second_opinion: 'Second opinion',
};

export async function planNotes(db, practiceId, planIds) {
  if (!planIds.length) return [];
  return db.all(
    `SELECT f.id, f.treatment_plan_id, f.note, f.tag, f.follow_up_date, f.task_id, f.corrects_id, f.plan_stage, f.created_at, f.created_by, u.name AS created_by_name,
       t.status AS task_status, t.due_date AS task_due
     FROM followups f LEFT JOIN users u ON u.id = f.created_by LEFT JOIN tasks t ON t.id = f.task_id
     WHERE f.practice_id = ? AND f.treatment_plan_id IN (${planIds.map(() => '?').join(',')}) ORDER BY f.id DESC`, practiceId, ...planIds,
  );
}

// The note list as staff read it: newest first, a corrected note marked with what replaced it; the open follow-up
// (the plan's follow-up task, while it is open) on its own.
export function notesView(rows) {
  const correctedBy = new Map(rows.filter((r) => r.corrects_id).map((r) => [r.corrects_id, r.id]));
  const notes = rows.map((r) => ({ ...r, tag_label: r.tag ? NOTE_TAGS[r.tag] || null : null, corrected_by: correctedBy.get(r.id) || null }));
  const withTask = notes.find((n) => n.task_id);
  const followUp = withTask && withTask.task_status === 'open' ? { task_id: withTask.task_id, date: withTask.task_due || withTask.follow_up_date } : null;
  const latest = notes.find((n) => !n.corrected_by) || null;
  return { notes, latest, follow_up: followUp };
}
