// Diagnosis totals and conversion by provider (DX1–DX2). The one definition of "treatment diagnosed at an exam"
// and of the funnel that follows it (presented → accepted → scheduled → completed); docs/metrics.md, section
// "Diagnosis & conversion", explains each rule and server/test/diagnosis.test.js pins them. metrics.js exposes
// the diagnosed total as the `diagnosed` KPI (goals, trends, emails); screens and reports call this module.
//
// In short:
//  - An EXAM is a completed exam-code procedure (D0150, D0120, D0180, D0145, D0140, D0160, D0170, D9110). One exam
//    per patient per day; its type (new patient / recall / perio / emergency) comes from the code.
//  - Treatment is DIAGNOSED at that exam when a treatment procedure (not diagnostic or preventive) is charted for
//    the patient on the exam's practice-local date. The same code on the same tooth/surfaces/area charted again
//    while the first is still open is the same finding, not new work (no double counting of re-diagnosis).
//  - Cohorts: every later step is credited to the exam where the work was first diagnosed, whenever it happens.
//  - Money is the office fee on the procedure (integer cents). "Expected" is that fee capped at the patient's
//    primary PPO fee schedule (the in-network allowed amount, from resolveFee on the day the work was done, else
//    the day it was diagnosed) — an estimate, not money.
import { localNow } from './util.js';
import { resolveFee, currentVersion } from './feeversions.js';

export const EXAM_TYPES = { new_patient: 'New patient exams', recall: 'Recall (periodic) exams', perio: 'Perio exams', emergency: 'Emergency (limited) exams' };
// Exam codes and what they are by default. D9110 (palliative) isn't an exam but marks an emergency visit.
export const EXAM_CODES = { D0150: 'new_patient', D0120: 'recall', D0180: 'perio', D0145: 'recall', D0140: 'emergency', D0160: 'emergency', D0170: 'emergency', D9110: 'emergency' };
// Codes that can be classified another way by the practice: a type, or 'first_exam' (new patient when it is the
// patient's first comprehensive/periodic exam here, otherwise recall).
export const CONFIGURABLE = { D0150: 'new_patient', D0180: 'perio' };
export const RULE_CHOICES = ['new_patient', 'recall', 'perio', 'emergency', 'first_exam'];
const ROUTINE_EXAMS = ['D0150', 'D0180', 'D0120', 'D0145'];
// Not "treatment": exams, x-rays, cleanings, fluoride, sealants.
const NOT_TREATMENT = ['diagnostic', 'preventive'];
const PRECEDENCE = { new_patient: 0, perio: 1, recall: 2, emergency: 3 };
export const STAGES = ['diagnosed', 'presented', 'accepted', 'scheduled', 'completed'];
const LIVE_VISIT = (s) => s && !['cancelled', 'no_show'].includes(s);
const IN = (list) => list.map(() => '?').join(',');

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
export function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

// The practice-local date of a UTC timestamp ('YYYY-MM-DD HH:MM:SS' from datetime('now'), or ISO).
export function localDateTime(tz, utc) {
  if (!utc) return null;
  const s = String(utc).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? String(utc).slice(0, 16).replace('T', ' ') : localNow(tz, d);
}
export const localDate = (tz, utc) => localDateTime(tz, utc)?.slice(0, 10) ?? null;

// The practice's exam-type rules. Defaults until a settings screen stores the practice's own choices (see
// docs/workflows/specs/DX-diagnosis.md, "Open decisions"); every caller goes through here so that's one change.
export async function examRules() {
  return { ...CONFIGURABLE };
}
export function cleanRules(input = {}) {
  const out = { ...CONFIGURABLE };
  for (const code of Object.keys(CONFIGURABLE)) {
    const v = input?.[code] ?? input?.[code.toLowerCase()];
    if (v == null || v === '') continue;
    if (!RULE_CHOICES.includes(v)) return null;
    out[code] = v;
  }
  return out;
}

export function examType(code, rules = CONFIGURABLE, firstExam = false) {
  const rule = rules[code] ?? EXAM_CODES[code];
  if (!rule) return null;
  if (rule === 'first_exam') return firstExam ? 'new_patient' : 'recall';
  return rule;
}

// The one exam type for a patient's day from all the exam codes on it (new patient over perio over recall over
// emergency). firstExam: whether it's the patient's first routine exam here (for 'first_exam' rules).
export function classifyExam(codes, rules = CONFIGURABLE, firstExam = false) {
  const types = codes.map((c) => examType(c, rules, firstExam)).filter(Boolean);
  return types.sort((a, b) => PRECEDENCE[a] - PRECEDENCE[b])[0] || null;
}
export { ROUTINE_EXAMS };

async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...await fn(ids.slice(i, i + 500)));
  return out;
}

// The same finding: patient, code, tooth, surfaces (in any order) and area.
const findingKey = (r) => [r.patient_id, r.code, r.tooth || '', String(r.surfaces || '').toUpperCase().split('').sort().join(''), r.area || ''].join('|');

// Exams in [from, to] and the treatment diagnosed at each. o: { from, to, providerId?, locationId?, locationIds?,
// examType?, rules? }. Returns { events, findings, providers } — events are exams (one per patient per day),
// findings the diagnosed work with how far each has got.
export async function loadDiagnoses(db, pid, o) {
  const practice = await db.get('SELECT timezone FROM practices WHERE id = ?', pid);
  const tz = practice?.timezone || 'America/New_York';
  const rules = o.rules || await examRules(db, pid);
  const providers = new Map((await db.all('SELECT id, name, type, active FROM providers WHERE practice_id = ?', pid)).map((p) => [p.id, p]));
  const codes = Object.keys(EXAM_CODES);

  // 1. Exams: completed exam-code procedures dated in the range (completed_at is practice-local).
  const exams = await db.all(
    `SELECT pr.id, pr.patient_id, pr.code, pr.provider_id, pr.appointment_id, pr.location_id, pr.completed_at, p.first_name, p.last_name, p.location_id AS home_location_id
     FROM procedures pr JOIN patients p ON p.id = pr.patient_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.code IN (${IN(codes)}) AND pr.completed_at >= ? AND pr.completed_at < ? AND p.merged_into_id IS NULL
     ORDER BY pr.completed_at, pr.id`, pid, ...codes, o.from, addDays(o.to, 1),
  );
  const patientIds = [...new Set(exams.map((e) => e.patient_id))];
  if (!patientIds.length) return { events: [], findings: [], providers, rules, tz };

  // Whether an exam is the patient's first routine exam here (only needed for 'first_exam' rules).
  const firstRoutine = new Map();
  if (Object.values(rules).includes('first_exam')) {
    for (const r of await chunked(patientIds, (ids) => db.all(
      `SELECT patient_id, MIN(completed_at) AS first FROM procedures WHERE practice_id = ? AND status = 'completed' AND code IN (${IN(ROUTINE_EXAMS)}) AND patient_id IN (${IN(ids)}) GROUP BY patient_id`,
      pid, ...ROUTINE_EXAMS, ...ids,
    ))) firstRoutine.set(r.patient_id, String(r.first).slice(0, 10));
  }

  // The visit of each exam: its own appointment, else the patient's live visit that day.
  const visits = await chunked(patientIds, (ids) => db.all(
    `SELECT a.id, a.patient_id, a.provider_id, a.location_id, a.start_time, a.status FROM appointments a
     WHERE a.practice_id = ? AND a.patient_id IN (${IN(ids)}) AND a.start_time >= ? AND a.start_time < ? ORDER BY a.start_time, a.id`,
    pid, ...ids, o.from, addDays(o.to, 1),
  ));
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const visitOn = (patientId, date) => visits.find((v) => v.patient_id === patientId && v.start_time.slice(0, 10) === date && LIVE_VISIT(v.status));

  // 2. One exam event per patient per day: new patient wins over perio, perio over recall, recall over emergency.
  const byDay = new Map();
  for (const e of exams) {
    const date = e.completed_at.slice(0, 10);
    const type = examType(e.code, rules, firstRoutine.get(e.patient_id) === date);
    if (!type) continue;
    const key = `${e.patient_id}|${date}`;
    const list = byDay.get(key) || [];
    list.push({ ...e, date, type });
    byDay.set(key, list);
  }
  const events = [];
  for (const [key, list] of byDay) {
    list.sort((a, b) => PRECEDENCE[a.type] - PRECEDENCE[b.type] || (a.code === 'D9110') - (b.code === 'D9110') || a.id - b.id);
    const primary = list[0];
    const visit = visitById.get(primary.appointment_id) || list.map((x) => visitById.get(x.appointment_id)).find(Boolean) || visitOn(primary.patient_id, primary.date) || null;
    const providerId = primary.provider_id ?? visit?.provider_id ?? null;
    // A hygiene visit's hygienist shares the credit for treatment found at it (hygiene-generated treatment).
    const hygienistId = visit && visit.provider_id !== providerId && providers.get(visit.provider_id)?.type === 'hygienist' ? visit.provider_id : null;
    events.push({
      key, exam_id: primary.id, patient_id: primary.patient_id, first_name: primary.first_name, last_name: primary.last_name,
      date: primary.date, month: primary.date.slice(0, 7), code: primary.code, codes: [...new Set(list.map((x) => x.code))], exam_type: primary.type,
      provider_id: providerId, hygienist_id: hygienistId, appointment_id: visit?.id ?? null,
      location_id: primary.location_id ?? visit?.location_id ?? primary.home_location_id ?? null,
    });
  }
  const offices = o.locationIds?.length ? o.locationIds.map(Number) : o.locationId ? [Number(o.locationId)] : null;
  const kept = events.filter((ev) => (!offices || offices.includes(ev.location_id))
    && (!o.providerId || ev.provider_id === o.providerId || ev.hygienist_id === o.providerId)
    && (!o.examType || ev.exam_type === o.examType));
  const eventByKey = new Map(kept.map((ev) => [ev.key, ev]));
  if (!kept.length) return { events: [], findings: [], providers, rules, tz };

  // 3. Treatment charted for these patients (all of it: an earlier open finding makes a later one a re-diagnosis,
  // and a later copy that gets done still counts for the first).
  const keptPatients = [...new Set(kept.map((ev) => ev.patient_id))];
  const rows = await chunked(keptPatients, (ids) => db.all(
    `SELECT pr.id, pr.patient_id, pr.code, pr.description, pr.category, pr.tooth, pr.surfaces, pr.area, pr.fee, pr.status, pr.created_at, pr.completed_at,
       pr.appointment_id, pr.treatment_plan_id, pr.provider_id, tp.status AS plan_status, tp.signed_at, tp.option_group,
       a.status AS appt_status, a.created_at AS appt_created_at, a.start_time AS appt_start
     FROM procedures pr LEFT JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id LEFT JOIN appointments a ON a.id = pr.appointment_id
     WHERE pr.practice_id = ? AND pr.patient_id IN (${IN(ids)}) AND pr.status != 'cancelled' AND pr.category NOT IN (${IN(NOT_TREATMENT)}) AND pr.code NOT IN (${IN(codes)})`,
    pid, ...ids, ...NOT_TREATMENT, ...codes,
  ));

  // Alternative treatment options (plans in one option group): only one option is diagnosed work — the accepted
  // one, else the first option offered. Turned-down options' work is cancelled when one is accepted.
  const chosen = new Map();
  for (const r of rows) {
    if (!r.option_group || !r.treatment_plan_id) continue;
    const k = `${r.patient_id}|${r.option_group}`;
    const cur = chosen.get(k);
    const accepted = ['accepted', 'completed'].includes(r.plan_status) || !!r.signed_at;
    if (!cur || (accepted && !cur.accepted) || (accepted === cur.accepted && r.treatment_plan_id < cur.plan)) chosen.set(k, { plan: r.treatment_plan_id, accepted });
  }
  const live = rows.filter((r) => !r.option_group || !r.treatment_plan_id || chosen.get(`${r.patient_id}|${r.option_group}`)?.plan === r.treatment_plan_id);

  // 4. Findings: the same work charted again while the first is still open joins the first.
  const groups = new Map();
  for (const r of live) {
    r.created_local = localDateTime(tz, r.created_at);
    r.created_on = r.created_local.slice(0, 10);
    const k = findingKey(r);
    const g = groups.get(k) || [];
    g.push(r);
    groups.set(k, g);
  }
  const findings = [];
  for (const g of groups.values()) {
    g.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    let cur = null;
    for (const r of g) {
      // Done before this one was charted → this is new work (the tooth needs something again), not a repeat.
      const doneBefore = cur && cur.rows.some((x) => x.status === 'completed' && x.completed_at && String(x.completed_at).slice(0, 16) <= r.created_local);
      if (cur && !doneBefore) cur.rows.push(r);
      else {
        cur = { rows: [r] };
        findings.push(cur);
      }
    }
  }

  // 5. Keep the findings first diagnosed on an exam day in range, and work out how far each has got.
  const out = [];
  for (const f of findings) {
    const first = f.rows[0];
    const ev = eventByKey.get(`${first.patient_id}|${first.created_on}`);
    if (!ev) continue;
    const diagnosedOn = first.created_on;
    const completedRows = f.rows.filter((r) => r.status === 'completed');
    const completedOn = completedRows.length ? completedRows.map((r) => String(r.completed_at).slice(0, 10)).sort()[0] : null;
    const scheduledDates = [];
    for (const r of f.rows) {
      if (r.appointment_id && LIVE_VISIT(r.appt_status)) {
        const booked = localDate(tz, r.appt_created_at) || diagnosedOn;
        scheduledDates.push(booked > diagnosedOn ? booked : diagnosedOn);
      } else if (r.status === 'completed') scheduledDates.push(String(r.completed_at).slice(0, 10));
    }
    const scheduledOn = scheduledDates.sort()[0] || null;
    const completed = !!completedOn;
    const scheduled = completed || !!scheduledOn;
    const accepted = scheduled || f.rows.some((r) => ['accepted', 'completed'].includes(r.plan_status) || !!r.signed_at);
    const presented = accepted || f.rows.some((r) => r.treatment_plan_id);
    const stage = completed ? 'completed' : scheduled ? 'scheduled' : accepted ? 'accepted' : presented ? 'presented' : 'diagnosed';
    const nextVisit = f.rows.filter((r) => r.status !== 'completed' && r.appointment_id && LIVE_VISIT(r.appt_status)).map((r) => r.appt_start).sort()[0] || null;
    out.push({
      id: first.id, procedure_ids: f.rows.map((r) => r.id), patient_id: first.patient_id, first_name: ev.first_name, last_name: ev.last_name,
      code: first.code, description: first.description, tooth: first.tooth || null, surfaces: first.surfaces || null, area: first.area || null,
      fee: Number(first.fee) || 0, expected: Number(first.fee) || 0, diagnosed_on: diagnosedOn, month: diagnosedOn.slice(0, 7),
      exam_key: ev.key, exam_type: ev.exam_type, provider_id: ev.provider_id, hygienist_id: ev.hygienist_id, location_id: ev.location_id,
      presented, accepted, scheduled, completed, stage, scheduled_on: scheduled ? scheduledOn || completedOn : null, completed_on: completedOn, next_visit: nextVisit,
      days_to_schedule: scheduled && (scheduledOn || completedOn) ? Math.max(0, daysBetween(diagnosedOn, scheduledOn || completedOn)) : null,
      days_to_complete: completedOn ? Math.max(0, daysBetween(diagnosedOn, completedOn)) : null,
    });
  }

  // 6. Expected after PPO: the fee capped at the patient's primary in-network fee schedule (plan, else carrier).
  const withWork = [...new Set(out.map((f) => f.patient_id))];
  if (withWork.length) {
    const schedules = new Map();
    for (const r of await chunked(withWork, (ids) => db.all(
      `SELECT pi.patient_id, COALESCE(ip.fee_schedule_id, ic.fee_schedule_id) AS fs FROM patient_insurance pi
       JOIN insurance_carriers ic ON ic.id = pi.carrier_id LEFT JOIN insurance_plans ip ON ip.id = pi.plan_id
       WHERE pi.patient_id IN (${IN(ids)}) AND pi.active = 1 AND pi.priority = 'primary' ORDER BY pi.id`, ...ids,
    ))) if (r.fs && !schedules.has(r.patient_id)) schedules.set(r.patient_id, r.fs);
    // The one fee resolver (feeversions.js): the schedule's fee in effect on the day of service. Days on or after
    // the schedule's current version all read the live table, so those are looked up once per code, not per day.
    const allowed = new Map();
    const current = new Map();
    for (const f of out) {
      const fs = schedules.get(f.patient_id);
      if (!fs) continue;
      const day = f.completed_on || f.diagnosed_on;
      if (!current.has(fs)) current.set(fs, (await currentVersion(db, pid, fs)) ?? null);
      const cur = current.get(fs);
      const live = !day || !cur || day >= cur.effective_from;
      const k = live ? `${fs}|${f.code}` : `${fs}|${f.code}|${day}`;
      if (!allowed.has(k)) allowed.set(k, await resolveFee(db, pid, fs, f.code, live ? null : day));
      const a = allowed.get(k);
      if (a != null) f.expected = Math.min(Number(a), f.fee);
    }
  }
  out.sort((a, b) => a.diagnosed_on.localeCompare(b.diagnosed_on) || a.patient_id - b.patient_id || a.id - b.id);
  return { events: kept, findings: out, providers, rules, tz };
}

// ---- Adding up ----
function blank() {
  return { exams: 0, patients: new Set(), findings: 0, diagnosed: 0, expected: 0, presented: 0, accepted: 0, scheduled: 0, completed: 0, open_expected: 0, sched: [], done: [] };
}
function addFinding(a, f) {
  a.findings += 1;
  a.diagnosed += f.fee;
  a.expected += f.expected;
  if (f.presented) a.presented += f.fee;
  if (f.accepted) a.accepted += f.fee;
  if (f.scheduled) a.scheduled += f.fee;
  if (f.completed) a.completed += f.fee;
  else a.open_expected += f.expected;
  if (f.days_to_schedule != null) a.sched.push(f.days_to_schedule);
  if (f.days_to_complete != null) a.done.push(f.days_to_complete);
}
function finish(a) {
  return {
    exams: a.exams, patients: a.patients.size, procedures: a.findings, diagnosed: a.diagnosed, expected: a.expected,
    presented: a.presented, accepted: a.accepted, scheduled: a.scheduled, completed: a.completed,
    still_open: a.diagnosed - a.completed, still_open_expected: a.open_expected,
    per_exam: a.exams ? Math.round(a.diagnosed / a.exams) : null,
    // Each step as a share of the step before, and of everything diagnosed.
    step_pct: { presented: pct(a.presented, a.diagnosed), accepted: pct(a.accepted, a.presented), scheduled: pct(a.scheduled, a.accepted), completed: pct(a.completed, a.scheduled) },
    of_diagnosed_pct: { presented: pct(a.presented, a.diagnosed), accepted: pct(a.accepted, a.diagnosed), scheduled: pct(a.scheduled, a.diagnosed), completed: pct(a.completed, a.diagnosed) },
    median_days_to_schedule: median(a.sched), median_days_to_complete: median(a.done),
  };
}
const typesBlank = () => Object.fromEntries(Object.keys(EXAM_TYPES).map((t) => [t, blank()]));

// The funnel for loaded diagnoses: practice totals, by exam type, by provider (× exam type) and by month.
// A treatment found at a hygiene visit counts for the examining provider and the hygienist; totals count it once.
export function summarize({ events, findings, providers }, { providerId = null } = {}) {
  const total = blank();
  const byType = typesBlank();
  const byProvider = new Map();
  const byMonth = new Map();
  const credit = (ev) => [ev.provider_id, ev.hygienist_id].filter((id, i, all) => id != null && all.indexOf(id) === i && (!providerId || id === providerId));
  const prov = (id) => {
    if (!byProvider.has(id)) byProvider.set(id, { total: blank(), types: typesBlank(), hygiene: blank() });
    return byProvider.get(id);
  };
  const month = (m) => {
    if (!byMonth.has(m)) byMonth.set(m, { total: blank(), types: typesBlank() });
    return byMonth.get(m);
  };
  const evByKey = new Map(events.map((ev) => [ev.key, ev]));
  for (const ev of events) {
    for (const a of [total, byType[ev.exam_type], month(ev.month).total, month(ev.month).types[ev.exam_type]]) { a.exams += 1; a.patients.add(ev.patient_id); }
    for (const id of credit(ev)) {
      const p = prov(id);
      for (const a of [p.total, p.types[ev.exam_type], ...(id === ev.hygienist_id ? [p.hygiene] : [])]) { a.exams += 1; a.patients.add(ev.patient_id); }
    }
  }
  for (const f of findings) {
    const ev = evByKey.get(f.exam_key);
    for (const a of [total, byType[f.exam_type], month(f.month).total, month(f.month).types[f.exam_type]]) addFinding(a, f);
    for (const id of ev ? credit(ev) : []) {
      const p = prov(id);
      for (const a of [p.total, p.types[f.exam_type], ...(id === ev.hygienist_id ? [p.hygiene] : [])]) addFinding(a, f);
    }
  }
  const typeRows = (types) => Object.keys(EXAM_TYPES).map((t) => ({ exam_type: t, label: EXAM_TYPES[t], ...finish(types[t]) }));
  return {
    totals: finish(total),
    by_exam_type: typeRows(byType),
    providers: [...byProvider.entries()].map(([id, p]) => {
      const pv = providers.get(id);
      return { provider_id: id, name: pv?.name || 'Provider', type: pv?.type || null, total: finish(p.total), by_exam_type: typeRows(p.types), at_hygiene_visits: p.hygiene.exams ? finish(p.hygiene) : null };
    }).sort((a, b) => b.total.diagnosed - a.total.diagnosed || a.name.localeCompare(b.name)),
    by_month: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, x]) => ({ month: m, total: finish(x.total), by_exam_type: typeRows(x.types) })),
  };
}

// The funnel for a range. o as for loadDiagnoses.
export async function diagnosisFunnel(db, pid, o) {
  const loaded = await loadDiagnoses(db, pid, o);
  return { from: o.from, to: o.to, rules: loaded.rules, exam_types: EXAM_TYPES, ...summarize(loaded, { providerId: o.providerId || null }) };
}

// The drill-down: one row per patient and exam, with what was diagnosed and what's still open.
// stage: 'open' (not completed yet, the default), 'all', or one stage name (the furthest step reached).
export async function diagnosisPatients(db, pid, o, { stage = 'open' } = {}) {
  const { events, findings, providers } = await loadDiagnoses(db, pid, o);
  const evByKey = new Map(events.map((ev) => [ev.key, ev]));
  const byExam = new Map();
  for (const f of findings) {
    if (stage === 'open' ? f.completed : stage !== 'all' && f.stage !== stage) continue;
    const ev = evByKey.get(f.exam_key);
    const row = byExam.get(f.exam_key) || {
      patient_id: f.patient_id, first_name: f.first_name, last_name: f.last_name, exam_date: ev.date, exam_type: ev.exam_type, exam_code: ev.code,
      provider_id: ev.provider_id, provider_name: providers.get(ev.provider_id)?.name || null, hygienist_name: ev.hygienist_id ? providers.get(ev.hygienist_id)?.name || null : null,
      diagnosed: 0, expected: 0, completed: 0, open: 0, next_visit: null, stages: {}, items: [],
    };
    row.diagnosed += f.fee;
    row.expected += f.expected;
    if (f.completed) row.completed += f.fee;
    else row.open += f.fee;
    row.stages[f.stage] = (row.stages[f.stage] || 0) + f.fee;
    if (f.next_visit && (!row.next_visit || f.next_visit < row.next_visit)) row.next_visit = f.next_visit;
    row.items.push({ procedure_id: f.id, code: f.code, description: f.description, tooth: f.tooth, surfaces: f.surfaces, fee: f.fee, expected: f.expected, stage: f.stage, scheduled_on: f.scheduled_on, completed_on: f.completed_on });
    byExam.set(f.exam_key, row);
  }
  // The furthest step every open item has reached (what to do next: present, get a yes, book it).
  const order = (s) => STAGES.indexOf(s);
  const rows = [...byExam.values()].map((r) => {
    const open = r.items.filter((i) => i.stage !== 'completed');
    return { ...r, stage: (open.length ? open : r.items).map((i) => i.stage).sort((a, b) => order(a) - order(b))[0] };
  }).sort((a, b) => b.open - a.open || a.exam_date.localeCompare(b.exam_date));
  return { rows, count: rows.length, open: rows.reduce((s, r) => s + r.open, 0) };
}
