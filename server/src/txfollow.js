import { audit, recorded, localNow } from './util.js';
import { registerCadenceType, STOP_REASONS, addDays, daysBetween, skipReason, stepsFor, CHANNEL_LABELS } from './cadence.js';
import { localDate } from './diagnosis.js';
import { planFacts, planStopReason, urgencyOf, visitWords, groupOf, leadOf, URGENCIES, URGENCY_LABELS } from './txwords.js';
import { tidyLetters } from './txletter.js';

// Treatment follow-up on autopilot (TF1, TF2, TF4 — docs/workflows/specs/TF-treatment-followup.md): the cadence
// engine's 'treatment' type. Anyone with diagnosed treatment that isn't scheduled gets a recommended sequence of
// texts, emails, team calls and — after a while — a letter from their doctor (txletter.js), one sequence per
// urgency (urgent / soon / elective), each editable on the sequence editor (/recall?type=treatment&tab=sequences).
// Anchor: the plan's diagnosis date (practice-local). Source: the treatment plan (an option group counts once).
// Stops the moment the work is booked (or they're coming in to see a dentist), done, declined in writing (plan
// rejected, or an informed-refusal form signed), when they opt out or are held — checked on every pass and right
// before every send. Texts carry no clinical detail: only the office's name and a link (the plan, the cost and a
// time are behind it, after a date-of-birth check). Emails and call scripts name the work and the patient's cost.
// Off until an administrator switches it on (practices.treatment_cadence).

export const TYPE = 'treatment';
const LOOKBACK_DAYS = 180; // at switch-on, only plans diagnosed in the last six months (older ones are a campaign's job)

// {visit} = the work in plain words and the patient's estimated cost ("a crown (your estimated cost: $420.00)").
// Texts never use it. {link} opens the plan, the cost and times; {phone} is the office.
const t = (offset_days, channel, template, extra = {}) => ({ offset_days, channel, template, ...extra });
const TEXT_FIRST = 'Hi {first_name}, it’s {practice}. The treatment we recommended at your visit still needs to be scheduled. See the details and your cost here: {link}';
const TEXT_AGAIN = 'Hi {first_name}, {practice} here — just checking in about the treatment we recommended. You can see it and pick a time here: {link} or call {phone}.';
const EMAIL = 'Hi {first_name}, at your last visit we recommended {visit}. It’s best not to leave it too long — small problems are simpler (and cost less) to fix. See your plan and choose a time here: {link} — or call us at {phone} with any questions.';
const EMAIL_LATER = 'Hi {first_name}, we haven’t been able to schedule {visit} yet. If cost, timing or worry is holding you back, we’re happy to talk it through and look at payment options. See your plan here: {link} or call {phone}.';
const CALL = 'Hi, this is {practice} calling for {first_name}. At your last visit the doctor recommended {visit}. Do you have any questions about it? Can we find a time that works for you?';
const LETTER = 'A personal letter from the doctor (drafted for the doctor to review and approve).';
export const DEFAULT_TREATMENT_CADENCES = {
  urgent: [
    t(1, 'text', 'Hi {first_name}, it’s {practice}. The treatment we recommended shouldn’t wait long. See the details and pick a time: {link}'),
    t(3, 'task_call', CALL),
    t(7, 'email', EMAIL, { subject: 'Your treatment at {practice}' }),
    t(14, 'text', TEXT_AGAIN),
    t(21, 'task_call', CALL),
    t(30, 'letter', LETTER, { subject: 'A note from your doctor' }),
    t(60, 'text', TEXT_AGAIN),
  ],
  soon: [
    t(2, 'text', TEXT_FIRST),
    t(7, 'email', EMAIL, { subject: 'Your treatment at {practice}' }),
    t(14, 'task_call', CALL),
    t(30, 'text', TEXT_AGAIN),
    t(60, 'email', EMAIL_LATER, { subject: 'Still here to help with your treatment' }),
    t(90, 'letter', LETTER, { subject: 'A note from your doctor' }),
  ],
  elective: [
    t(7, 'email', EMAIL, { subject: 'Your treatment options at {practice}' }),
    t(30, 'text', TEXT_FIRST),
    t(60, 'task_call', CALL),
    t(120, 'email', EMAIL_LATER, { subject: 'Still thinking it over?' }),
    t(180, 'text', TEXT_AGAIN),
  ],
};
const NAMES = { urgent: 'Urgent treatment', soon: 'Treatment (soon)', elective: 'Elective treatment' };

Object.assign(STOP_REASONS, {
  treatment_done: 'Treatment done', plan_gone: 'Plan removed', urgency_changed: 'Urgency changed (moved to its new sequence)', other_option: 'Chose another option',
});

async function todayFor(db, practiceId, ctx) {
  if (ctx?.today) return ctx.today;
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York';
  return localNow(tz).slice(0, 10);
}

export const treatmentCadence = {
  label: 'Treatment follow-up',
  linkPath: 'api/public/txf',
  messageKind: 'treatment_followup',
  enabled: (practice) => Number(practice.treatment_cadence) === 1,

  async defaultSequences() {
    return URGENCIES.map((u) => ({ subtype: u, name: NAMES[u], steps: DEFAULT_TREATMENT_CADENCES[u] }));
  },

  // Every open plan (one per option group) with work not yet on the schedule, diagnosed since the practice's
  // starting date. It enrols them itself and then prepares any due doctor's letters (tidyLetters) before the
  // engine looks for due steps — so the engine never sends a generic letter for the letter step.
  async candidates(db, practice, { today, windows }) {
    const pid = practice.id;
    const tz = practice.timezone || 'America/New_York';
    const floor = practice.treatment_cadence_from || addDays(today, -LOOKBACK_DAYS);
    // Treatment is one person's: never grouped into a family message (unless the office sets a window itself).
    await db.run("UPDATE cadence_sequences SET family_window_days = 0 WHERE practice_id = ? AND type = ? AND updated_by IS NULL AND family_window_days <> 0", pid, TYPE);
    const plans = await db.all(
      `SELECT tp.*, p.location_id AS home_office FROM real_treatment_plans tp JOIN real_patients p ON p.id = tp.patient_id
       WHERE tp.practice_id = ? AND tp.status IN ('proposed','accepted') AND p.status = 'active' AND p.merged_into_id IS NULL
         AND EXISTS (SELECT 1 FROM real_procedures pr WHERE pr.treatment_plan_id = tp.id AND pr.status = 'planned' AND pr.appointment_id IS NULL)
       ORDER BY tp.id`, pid,
    );
    const out = [];
    const seenGroups = new Set();
    for (const plan of plans) {
      if (plan.option_group) {
        const key = `${plan.patient_id}:${plan.option_group}`;
        if (seenGroups.has(key)) continue;
        const lead = leadOf(await groupOf(db, plan));
        if (lead.id !== plan.id) continue;
        seenGroups.add(key);
      }
      const anchor = localDate(tz, plan.created_at);
      if (!anchor || anchor < floor) continue;
      if (await db.get("SELECT e.id FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.source_type = 'treatment_plan' AND e.source_id = ? AND e.status = 'active' AND s.type = ?", plan.id, TYPE)) continue;
      const open = await db.all("SELECT code, category FROM procedures WHERE treatment_plan_id = ? AND status = 'planned' AND appointment_id IS NULL", plan.id);
      const subtype = URGENCIES.includes(plan.followup_urgency) ? plan.followup_urgency : urgencyOf(open);
      const w = windows[subtype];
      if (!w || anchor < w.from || anchor > w.to) continue;
      if (await planStopReason(db, plan, { today, anchor })) continue;
      out.push({ patient_id: plan.patient_id, subtype, source_type: 'treatment_plan', source_id: plan.id, anchor_date: anchor, location_id: plan.home_office ?? null });
    }
    // Enrol here (the engine's own insert then finds them already there), so a letter step that is already due
    // on a late start is prepared as a draft before the engine's pass reaches it.
    const seqs = new Map((await db.all('SELECT id, subtype, name FROM cadence_sequences WHERE practice_id = ? AND type = ? AND active = 1', pid, TYPE)).map((s) => [s.subtype, s]));
    for (const c of out) {
      const seq = seqs.get(c.subtype);
      if (!seq) continue;
      const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', c.patient_id, pid);
      if (await skipReason(db, patient, TYPE)) continue;
      const { changes, id } = await db.run(
        `INSERT INTO cadence_enrollments (practice_id, patient_id, sequence_id, source_type, source_id, anchor_date, location_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sequence_id, source_type, source_id, anchor_date) DO NOTHING`,
        pid, c.patient_id, seq.id, c.source_type, c.source_id, c.anchor_date, c.location_id ?? patient.location_id ?? null,
      );
      if (changes) await audit(db, { user: { practice_id: pid, id: null } }, 'cadence.enroll', 'cadence_enrollments', id, { type: TYPE, sequence: seq.name, anchor_date: c.anchor_date, treatment_plan_id: c.source_id }, { patientId: c.patient_id });
    }
    await tidyLetters(db, practice, { today });
    return out;
  },

  // Checked on every pass and again right before every send.
  async stopCheck(db, e, ctx) {
    const today = await todayFor(db, e.practice_id, ctx);
    const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ? AND practice_id = ?', e.source_id, e.practice_id);
    const stop = await planStopReason(db, plan, { today, anchor: e.anchor_date });
    if (stop) return stop;
    const seq = await db.get('SELECT subtype FROM cadence_sequences WHERE id = ?', e.sequence_id);
    const open = await db.all("SELECT code, category FROM procedures WHERE treatment_plan_id = ? AND status = 'planned' AND appointment_id IS NULL", plan.id);
    const urgency = URGENCIES.includes(plan.followup_urgency) ? plan.followup_urgency : urgencyOf(open);
    if (seq && urgency !== seq.subtype) return { reason: 'urgency_changed' };
    return null;
  },

  // The work and the patient's cost, for emails and call scripts (never texts: their templates don't use {visit}).
  async describe(db, enrollments) {
    const parts = [];
    for (const e of enrollments) {
      const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ?', e.source_id);
      if (plan) parts.push(visitWords(await planFacts(db, plan)));
    }
    return { visit: [...new Set(parts)].join('; ') || 'the treatment we recommended' };
  },

  // Team calls: the engine names its tasks for recall; say what this one is and where to log it.
  async afterSend(db, enrollments) {
    for (const e of enrollments) {
      const run = await db.get("SELECT task_id FROM cadence_runs WHERE enrollment_id = ? AND status = 'task' AND task_id IS NOT NULL ORDER BY id DESC LIMIT 1", e.id);
      if (!run) continue;
      const task = await db.get('SELECT id, title, notes FROM tasks WHERE id = ?', run.task_id);
      if (!task || !/^Recall call:/.test(task.title)) continue;
      await recorded(db, 'tasks', task.id, () => db.run('UPDATE tasks SET title = ?, notes = ? WHERE id = ?',
        task.title.replace(/^Recall call:/, 'Treatment follow-up call:'),
        String(task.notes || '').replace('Log the outcome on the Recall screen', 'Log the outcome on Treatment follow-up (Recall autopilot → Treatment)'), task.id));
    }
  },
};
registerCadenceType(TYPE, treatmentCadence);

// ---- The board (TF4): who is where, what each step produced, who reached the end without booking ----
const money = (v, show) => (show ? v : null);
export async function board(db, practiceId, { days = 90, officeSql = '', officeArgs = [], showMoney = true, now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const today = localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
  const since = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const base = `FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id JOIN real_patients p ON p.id = e.patient_id
    WHERE e.practice_id = ? AND s.type = ?${officeSql}`;
  const rows = await db.all(
    `SELECT e.*, s.subtype, s.name AS sequence_name, p.first_name, p.last_name, p.preferred_name ${base} AND (e.status = 'active' OR e.stopped_at >= ? OR e.created_at >= ?)
     ORDER BY e.anchor_date, e.id LIMIT 2000`, practiceId, TYPE, ...officeArgs, since, since,
  );
  const stepCache = new Map();
  const stepsOf = async (sid) => {
    if (!stepCache.has(sid)) stepCache.set(sid, await stepsFor(db, sid, { all: true }));
    return stepCache.get(sid);
  };
  const label = (st) => (st ? `Day ${st.offset_days} · ${st.channel === 'letter' ? 'Doctor’s letter' : CHANNEL_LABELS[st.channel]}` : 'Not contacted yet');
  const stages = new Map();
  const patients = [];
  const byStep = new Map();
  const endOfCadence = [];
  const totals = { active: 0, booked: 0, scheduled: 0, declined: 0, done: 0, stopped_other: 0, completed_no_booking: 0, open_amount: 0 };
  const byUrgency = Object.fromEntries(URGENCIES.map((u) => [u, { urgency: u, label: URGENCY_LABELS[u], active: 0, booked: 0 }]));
  for (const e of rows) {
    const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ?', e.source_id);
    if (!plan) continue;
    const steps = await stepsOf(e.sequence_id);
    const last = await db.get("SELECT r.step_id, r.status, r.channel, r.due_date FROM cadence_runs r WHERE r.enrollment_id = ? AND r.status IN ('sent','task','done') ORDER BY r.due_date DESC, r.id DESC LIMIT 1", e.id);
    const lastStep = last ? steps.find((s) => s.id === last.step_id) : null;
    const name = `${e.preferred_name || e.first_name} ${e.last_name}`;
    if (e.status === 'active') {
      const facts = await planFacts(db, plan);
      totals.active++;
      totals.open_amount += facts.total;
      byUrgency[e.subtype] && byUrgency[e.subtype].active++;
      const key = lastStep ? `${lastStep.offset_days}:${lastStep.channel}` : 'none';
      if (!stages.has(key)) stages.set(key, { key, label: label(lastStep), offset_days: lastStep?.offset_days ?? -1, count: 0, amount: 0 });
      const st = stages.get(key);
      st.count++;
      st.amount += facts.total;
      const next = steps.filter((s) => s.active).map((s) => ({ s, d: addDays(e.anchor_date, s.offset_days) })).find((x) => x.d > (last?.due_date || addDays(e.anchor_date, -1)));
      const letter = await db.get("SELECT id, status FROM txf_letters WHERE treatment_plan_id = ? AND status IN ('draft','failed','sending') ORDER BY id DESC LIMIT 1", plan.id);
      patients.push({
        enrollment_id: e.id, patient_id: e.patient_id, treatment_plan_id: plan.id, name, urgency: e.subtype, treatment: facts.words, amount: money(facts.total, showMoney), cost: money(facts.cost, showMoney),
        diagnosed: e.anchor_date, days: daysBetween(e.anchor_date, today), stage: label(lastStep), stage_key: key, last_status: last?.status || null,
        next: next ? { date: next.d, label: label(next.s) } : null, letter_waiting: letter ? letter.id : null,
      });
      continue;
    }
    if (e.stop_reason === 'booked') {
      totals.booked++;
      byUrgency[e.subtype] && byUrgency[e.subtype].booked++;
      const onVisit = e.booked_appointment_id ? await db.get("SELECT COALESCE(SUM(fee), 0) AS v FROM procedures WHERE appointment_id = ? AND status IN ('planned','completed')", e.booked_appointment_id) : null;
      const v = Number(onVisit?.v || 0);
      totals.scheduled += v;
      const st = e.booked_step_id ? steps.find((s) => s.id === e.booked_step_id) : null;
      const key = st ? `${st.offset_days}:${st.channel}` : 'none';
      if (!byStep.has(key)) byStep.set(key, { key, label: st ? label(st) : 'Before any step', offset_days: st?.offset_days ?? -1, booked: 0, scheduled: 0 });
      byStep.get(key).booked++;
      byStep.get(key).scheduled += v;
    } else if (e.stop_reason === 'declined') totals.declined++;
    else if (e.stop_reason === 'treatment_done') totals.done++;
    else if (e.status === 'completed') {
      totals.completed_no_booking++;
      const facts = await planFacts(db, plan);
      endOfCadence.push({ enrollment_id: e.id, patient_id: e.patient_id, name, urgency: e.subtype, treatment: facts.words, amount: money(facts.total, showMoney), diagnosed: e.anchor_date, ended: String(e.stopped_at || '').slice(0, 10) });
    } else totals.stopped_other++;
  }
  const letters = await db.get(
    `SELECT SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'sent' AND sent_at >= ? THEN 1 ELSE 0 END) AS sent FROM txf_letters WHERE practice_id = ?`, since, practiceId,
  );
  const lettersBooked = await db.get(
    `SELECT COUNT(*) AS n FROM txf_letters l JOIN cadence_enrollments e ON e.id = l.enrollment_id
     WHERE l.practice_id = ? AND l.status = 'sent' AND e.stop_reason = 'booked' AND e.booked_at >= l.sent_at AND l.sent_at >= ?`, practiceId, since,
  );
  const openCalls = await db.get(
    `SELECT COUNT(*) AS n FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id
     WHERE r.practice_id = ? AND s.type = ? AND r.status = 'task' AND r.channel = 'task_call' AND e.status = 'active'`, practiceId, TYPE,
  );
  const reached = totals.booked + totals.declined + totals.done + totals.completed_no_booking;
  return {
    today, days, enabled: Number(practice.treatment_cadence) === 1,
    totals: { ...totals, scheduled: money(totals.scheduled, showMoney), open_amount: money(totals.open_amount, showMoney), booking_rate: reached ? Math.round((totals.booked / reached) * 1000) / 10 : null },
    stages: [...stages.values()].sort((a, b) => a.offset_days - b.offset_days).map((s) => ({ ...s, amount: money(s.amount, showMoney) })),
    by_step: [...byStep.values()].sort((a, b) => a.offset_days - b.offset_days).map((s) => ({ ...s, scheduled: money(s.scheduled, showMoney) })),
    by_urgency: Object.values(byUrgency),
    letters: { waiting: Number(letters?.waiting || 0), failed: Number(letters?.failed || 0), sent: Number(letters?.sent || 0), booked_after: Number(lettersBooked?.n || 0) },
    open_calls: Number(openCalls.n),
    patients, end_of_cadence: endOfCadence,
  };
}
