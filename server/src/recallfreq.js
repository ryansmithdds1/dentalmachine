// Recall status per patient and office-wide (RF3–RF4, docs/workflows/specs/RF-recall-frequencies.md).
//
// Read-only views over recalls (kept current by recallsync.js): each type's last visit, due date and status
// (current / due soon / due / overdue / scheduled), the date the patient's insurance pays for it again (from the
// plan's frequency limits — the same { codes, count, months | per: 'benefit_year' } rules estimateCoverage uses),
// what can ride along with the next hygiene visit, and the office-wide board with its counts.
import { addMonths } from './util.js';
import { recallTypes } from './recalls.js';
import { ageOn } from './recallsync.js';
import { primaryPolicy } from './services.js';
import { withPlan, benefitYear, DEFAULT_FREQUENCIES } from './benefits.js';
import { officeFee } from './fees.js';
import { patientScope } from './officeaccess.js';
import { worklist } from './training.js';

export const STATUSES = ['current', 'due_soon', 'due', 'overdue', 'scheduled', 'none', 'retired'];
export const STATUS_LABELS = { current: 'Current', due_soon: 'Due soon', due: 'Due', overdue: 'Overdue', scheduled: 'Scheduled', none: 'No record', retired: 'Retired' };
// Short names for the panel and the insurance line ("BWX 1 per 12 months").
const SHORT = { prophy: 'Prophy', child_prophy: 'Child prophy', perio_maint: 'Perio maint', exam: 'Exam', bwx: 'BWX', fmx: 'FMX/pano', pano: 'Pano', fluoride: 'Fluoride' };
export const shortName = (t) => SHORT[t.key] || t.name;
const ACTIVE_VISIT = ['scheduled', 'confirmed', 'checked_in', 'in_chair'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}${d.slice(0, 4) !== new Date().toISOString().slice(0, 4) ? `, ${d.slice(0, 4)}` : ''}` : '');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const matches = (code, list) => list.some((c) => String(code || '').startsWith(c));
const parse = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

export async function recallSettings(db, practiceId) {
  const p = await db.get('SELECT recall_due_soon_days, recall_overdue_days FROM practices WHERE id = ?', practiceId);
  return { due_soon_days: p?.recall_due_soon_days ?? 30, overdue_days: p?.recall_overdue_days ?? 30 };
}

// The status of one recall on a day. scheduledOn: the date of the booked visit that covers it, if any.
export function bucket({ status, due_date: due }, today, settings, scheduledOn = null) {
  if (status === 'inactive') return 'retired';
  if (scheduledOn) return 'scheduled';
  if (!due) return 'none';
  if (due > addDays(today, settings.due_soon_days)) return 'current';
  if (due > today) return 'due_soon';
  return daysBetween(due, today) <= settings.overdue_days ? 'due' : 'overdue';
}

// ---- Insurance frequency limits ----

// The plan rule that limits a recall type's codes (the first code decides: D0274 → the bitewings rule).
export function ruleFor(freqs, codes) {
  for (const c of codes) {
    const rule = freqs.find((f) => !f.per_tooth && !f.per_area && matches(c, f.codes));
    if (rule) return rule;
  }
  return null;
}

// "BWX 1 per 12 months", "Cleanings 2 per calendar year", "FMX/pano 1 per 60 months".
export function ruleText(rule, policy, name) {
  const window = rule.per === 'benefit_year'
    ? Number(policy?.benefit_month || 1) === 1 ? 'calendar year' : `benefit year (from ${MONTHS[Number(policy.benefit_month) - 1]})`
    : `${rule.months} months`;
  return `${name} ${rule.count} per ${window}`;
}

// The first day on or after `from` the plan pays for it again, given the dates it was done (any order).
export function eligibleFrom(rule, policy, dates, from) {
  const done = [...dates].filter((d) => d && d <= from).sort().reverse();
  const count = Math.max(1, Number(rule.count) || 1);
  if (rule.per === 'benefit_year') {
    const year = benefitYear(policy || {}, from);
    const used = done.filter((d) => d >= year.start && d < year.end).length;
    return used < count ? from : year.end;
  }
  const nth = done[count - 1];
  if (!nth) return from;
  const open = addMonths(nth, Number(rule.months));
  return open > from ? open : from;
}

// What the plan says about one recall type for this patient: the rule text, the first date it pays, and
// whether it pays on the due date. history: [{ code, date }] (done here and outside).
export function insuranceFor(policy, type, history, { today, due = null, age = null }) {
  if (!policy) return null;
  const plan = policy.plan || {};
  const name = shortName(type);
  const limit = parse(plan.age_limits, []).find((a) => type.codes.some((c) => matches(c, a.codes || [])));
  if (limit && age != null && age > Number(limit.max_age)) {
    return { rule: `${name} covered through age ${limit.max_age}`, eligible_on: null, covered_at_due: false, pays: false, label: `insurance stopped paying at ${Number(limit.max_age) + 1}` };
  }
  const rule = ruleFor(parse(plan.frequencies, DEFAULT_FREQUENCIES), type.codes);
  if (!rule) return { rule: null, eligible_on: today, covered_at_due: true, pays: true, label: 'no frequency limit on file' };
  const dates = history.filter((h) => matches(h.code, rule.codes)).map((h) => h.date);
  const eligible = eligibleFrom(rule, policy, dates, today);
  const atDue = due && due > today ? eligibleFrom(rule, policy, dates, due) === due : eligible === today;
  const text = ruleText(rule, policy, name);
  return {
    rule: text, eligible_on: eligible, covered_at_due: atDue, pays: true,
    label: eligible > today ? `insurance pays from ${niceDate(eligible)}` : 'insurance pays now',
  };
}

// ---- One patient ----

async function historyOf(db, practiceId, patientId) {
  const here = await db.all(
    "SELECT id, code, completed_at, location_id FROM procedures WHERE practice_id = ? AND patient_id = ? AND status = 'completed' AND completed_at IS NOT NULL",
    practiceId, patientId,
  );
  const outside = await db.all("SELECT id, code, done_on, office_name FROM recall_outside WHERE practice_id = ? AND patient_id = ? AND status = 'active'", practiceId, patientId);
  return [
    ...here.map((p) => ({ code: p.code, date: p.completed_at.slice(0, 10), source: 'here', location_id: p.location_id })),
    ...outside.map((o) => ({ code: o.code, date: o.done_on, source: 'outside', office_name: o.office_name, outside_id: o.id })),
  ];
}

// Types worth showing for a patient who has no recall row for them yet: x-rays, exam and fluoride (for the
// ages the type covers) and the cleaning that fits their age — never perio maintenance (a clinical decision).
function showWithoutRow(t, types, rows, age) {
  if (!t.active) return false;
  if (rows.some((r) => r.status !== 'inactive' && types.find((x) => x.key === r.type)?.retires.includes(t.key))) return false;
  if (t.age_until != null && !t.adult_key) return age == null || age < t.age_until;
  if (t.bundle) return true;
  if (t.adult_key) return age != null && age < t.age_until && !rows.some((r) => r.type === t.adult_key && r.status !== 'inactive');
  const child = types.find((c) => c.adult_key === t.key && c.age_until != null && c.active);
  if (child) return (age == null || age >= child.age_until) && !rows.some((r) => r.type === child.key && r.status !== 'inactive');
  return false;
}

// Everything the recall panel shows for a patient. date: look at it as of another day (the day of a visit).
export async function patientRecallStatus(db, practiceId, patientId, { today, date = null } = {}) {
  const on = date || today;
  const patient = await db.get('SELECT id, first_name, last_name, dob, location_id FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  const age = ageOn(patient?.dob, on);
  const [types, settings, rows, history] = await Promise.all([
    recallTypes(db, practiceId), recallSettings(db, practiceId),
    db.all('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? ORDER BY id', practiceId, patientId),
    historyOf(db, practiceId, patientId),
  ]);
  const raw = await primaryPolicy(db, practiceId, patientId);
  const policy = raw ? await withPlan(db, raw) : null;
  const locations = new Map((await db.all('SELECT id, name FROM locations WHERE practice_id = ?', practiceId)).map((l) => [l.id, l.name]));
  // Visits booked from today on, and the recall codes planned on them.
  const visits = await db.all(
    `SELECT a.id, a.start_time, a.provider_id, pv.type AS provider_type FROM appointments a LEFT JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND a.patient_id = ? AND a.status IN (${ACTIVE_VISIT.map(() => '?').join(',')}) AND a.start_time >= ? ORDER BY a.start_time`,
    practiceId, patientId, ...ACTIVE_VISIT, `${today} 00:00`,
  );
  const plannedOn = visits.length
    ? await db.all(`SELECT code, appointment_id FROM procedures WHERE practice_id = ? AND patient_id = ? AND status = 'planned' AND appointment_id IN (${visits.map(() => '?').join(',')})`, practiceId, patientId, ...visits.map((v) => v.id))
    : [];
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const lastOf = (codes) => history.filter((h) => matches(h.code, codes) && h.date <= on).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).at(-1) || null;
  const items = [];
  const typeByKey = new Map(types.map((t) => [t.key, t]));
  const describe = (t, r) => {
    const recorded = r?.last_done_date ? { date: r.last_done_date, code: r.last_done_code, source: r.last_done_source || 'here', location_id: r.last_done_location_id } : null;
    const fromHistory = lastOf(t.codes);
    const last = recorded && (!fromHistory || recorded.date >= fromHistory.date) ? recorded : fromHistory;
    const interval = r?.interval_months ?? t.interval_months;
    const due = r ? r.due_date : last ? addMonths(last.date, interval) : null;
    // Booked: the recall's own visit, or a future visit with one of its codes planned on it.
    let visit = r?.status === 'scheduled' && r.appointment_id ? visitById.get(r.appointment_id) : null;
    if (!visit) {
      const p = plannedOn.find((x) => matches(x.code, t.codes));
      visit = p ? visitById.get(p.appointment_id) : null;
    }
    const status = bucket({ status: r?.status, due_date: due }, on, settings, r?.status === 'inactive' ? null : visit?.start_time?.slice(0, 10) || null);
    const where = last ? last.source === 'outside'
      ? (history.find((h) => h.source === 'outside' && h.date === last.date && h.code === last.code)?.office_name || 'another office')
      : (locations.get(last.location_id) || 'here') : null;
    const insurance = r?.status === 'inactive' ? null : insuranceFor(policy, t, history.filter((h) => h.date <= on), { today: on, due, age });
    const name = shortName(t);
    const dueText = status === 'none' ? `${name}: no record` : `${name} ${status === 'current' || status === 'due_soon' || status === 'scheduled' ? 'due' : 'was due'} ${niceDate(due)}`;
    return {
      recall_id: r?.id ?? null, type: t.key, name: t.name, short: name, bundle: !!t.bundle, active_type: !!t.active,
      interval_months: interval, interval_overridden: !!r?.interval_overridden, interval_reason: r?.interval_reason ?? null, type_interval_months: t.interval_months,
      last_done: last ? { date: last.date, code: last.code, source: last.source, where } : null,
      due_date: due, status, status_label: STATUS_LABELS[status], status_reason: r?.status_reason ?? null, contacted_at: r?.last_contacted_at ?? null,
      scheduled: status === 'scheduled' && visit ? { appointment_id: visit.id, start_time: visit.start_time } : null,
      insurance,
      label: `${dueText}${status === 'scheduled' ? ` · booked ${niceDate(visit.start_time.slice(0, 10))}` : ''}${insurance && insurance.eligible_on > on ? ` · ${insurance.label}` : insurance && !insurance.pays ? ` · ${insurance.label}` : ''}`,
    };
  };
  for (const r of rows) {
    const t = typeByKey.get(r.type) || { key: r.type, name: r.type, codes: [], retires: [], interval_months: r.interval_months, active: 0, bundle: 0 };
    items.push(describe(t, r));
  }
  for (const t of types) {
    if (rows.some((r) => r.type === t.key) || !showWithoutRow(t, types, rows, age)) continue;
    items.push(describe(t, null));
  }
  const order = { overdue: 0, due: 1, due_soon: 2, none: 3, scheduled: 4, current: 5, retired: 6 };
  items.sort((a, b) => order[a.status] - order[b.status] || String(a.due_date || '').localeCompare(String(b.due_date || '')));
  const nextHygiene = visits.find((v) => v.provider_type === 'hygienist') || null;
  return {
    patient: patient ? { id: patient.id, name: `${patient.first_name} ${patient.last_name}`, age } : null,
    date: on, settings, insurance: raw ? { carrier: raw.carrier_name, benefit_month: policy.benefit_month ?? 1 } : null,
    items, next_visit: visits[0] ? { id: visits[0].id, start_time: visits[0].start_time } : null,
    next_hygiene_visit: nextHygiene ? { id: nextHygiene.id, start_time: nextHygiene.start_time } : null,
  };
}

// ---- Bundling into the hygiene visit ----

// Is this booking a hygiene visit (the cleaning the x-rays, exam and fluoride ride along with)?
export async function isHygieneVisit(db, practiceId, { appointmentTypeId = null, providerId = null } = {}) {
  const types = await recallTypes(db, practiceId);
  const cleaning = types.filter((t) => t.active && !t.bundle);
  if (appointmentTypeId) {
    const at = await db.get('SELECT id, provider_type, procedure_codes, name FROM appointment_types WHERE id = ? AND practice_id = ?', appointmentTypeId, practiceId);
    if (at) {
      if (cleaning.some((t) => t.appointment_type_id === at.id)) return true;
      if (at.provider_type === 'hygienist') return true;
      if (parse(at.procedure_codes, []).some((c) => cleaning.some((t) => matches(c, t.codes)))) return true;
      if (/clean|prophy|hygien|recall|perio maint/i.test(at.name || '')) return true;
    }
  }
  if (providerId) return (await db.get('SELECT type FROM providers WHERE id = ? AND practice_id = ?', providerId, practiceId))?.type === 'hygienist';
  return false;
}

// The code to book for a type: the one that fits (bitewings: 2 films under 10; exam: comprehensive when there's
// no exam on record), else the type's first code the office has.
function codeToBook(t, age, history, codes) {
  const has = (c) => codes.has(c);
  if (t.key === 'bwx' && age != null && age < 10 && has('D0272')) return 'D0272';
  if (t.key === 'exam') {
    const any = history.some((h) => matches(h.code, t.codes));
    if (!any && has('D0150')) return 'D0150';
    if (has('D0120')) return 'D0120';
  }
  return t.codes.find(has) || null;
}

// What to add to a hygiene visit on `date`: bundled types (x-rays, exam, fluoride) due by then — ticked when
// they're due and insurance pays on that day, offered unticked when insurance won't pay yet or they're only due
// soon after. Nothing already planned on the visit (or on another booked visit) is offered again.
export async function bundleForVisit(db, practiceId, patientId, { today, date, appointmentId = null, providerId = null, locationId = null }) {
  const status = await patientRecallStatus(db, practiceId, patientId, { today, date });
  const settings = status.settings;
  const types = new Map((await recallTypes(db, practiceId)).map((t) => [t.key, t]));
  const codes = new Map((await db.all('SELECT * FROM procedure_codes WHERE practice_id = ? AND active = 1', practiceId)).map((c) => [c.code, c]));
  const history = await historyOf(db, practiceId, patientId);
  const planned = await db.all(
    `SELECT pr.code, pr.appointment_id FROM procedures pr LEFT JOIN appointments a ON a.id = pr.appointment_id
     WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status = 'planned' AND (pr.appointment_id = ? OR (a.status IN (${ACTIVE_VISIT.map(() => '?').join(',')}) AND a.start_time >= ?))`,
    practiceId, patientId, appointmentId ?? -1, ...ACTIVE_VISIT, `${today} 00:00`,
  );
  const items = [];
  for (const it of status.items) {
    const t = types.get(it.type);
    if (!t?.bundle || !t.active || it.status === 'retired') continue;
    if (planned.some((p) => matches(p.code, t.codes))) continue;
    if (history.some((h) => h.date === date && matches(h.code, t.codes))) continue;
    const soon = it.due_date == null || it.due_date <= addDays(date, settings.due_soon_days);
    if (!soon) continue;
    const code = codeToBook(t, status.patient?.age ?? null, history, codes);
    if (!code) continue;
    const row = codes.get(code);
    const pays = !it.insurance || (it.insurance.pays && it.insurance.eligible_on <= date);
    const dueNow = it.due_date == null || it.due_date <= date;
    const why = [it.due_date ? `${it.short} ${it.due_date <= date ? 'due' : 'due soon'}: ${it.due_date}` : `${it.short}: none on record`];
    if (it.last_done) why.push(`last ${it.last_done.date}${it.last_done.source === 'outside' ? ' (outside)' : ''}`);
    if (it.insurance?.rule) why.push(it.insurance.rule);
    if (it.insurance && !pays) why.push(it.insurance.pays ? `insurance pays from ${it.insurance.eligible_on}` : it.insurance.label);
    items.push({
      type: t.key, name: t.name, short: it.short, code, description: row.description, due_date: it.due_date, status: it.status,
      fee: await officeFee(db, practiceId, row, { patientId, providerId, locationId }),
      insurance: it.insurance, checked: dueNow && pays, why: why.join(' · '),
    });
  }
  return { patient_id: patientId, date, items };
}

// ---- Office-wide ----

// The recall board: one row per live recall of an active type (retired ones with ?status=retired), with its
// status, the patient's provider and office, and the summary per type.
export async function recallBoard(db, user, { today, type = null, status = null, providerId = null, locationId = null, search = null } = {}) {
  const pid = user.practice_id;
  const settings = await recallSettings(db, pid);
  const types = (await recallTypes(db, pid)).filter((t) => t.active);
  const typeByKey = new Map(types.map((t) => [t.key, t]));
  const scope = patientScope(user, 'p');
  const args = [pid];
  let where = "r.practice_id = ? AND p.status = 'active'";
  if (status !== 'retired') where += " AND r.status != 'inactive'";
  if (type) { where += ' AND r.type = ?'; args.push(type); }
  if (locationId) { where += ' AND p.location_id = ?'; args.push(locationId); }
  if (providerId) { where += ' AND (p.primary_hygienist_id = ? OR p.primary_provider_id = ?)'; args.push(providerId, providerId); }
  if (search) { where += ' AND (LOWER(p.first_name) LIKE ? OR LOWER(p.last_name) LIKE ?)'; const q = `%${String(search).toLowerCase()}%`; args.push(q, q); }
  const rows = await db.all(
    `SELECT r.id, r.patient_id, r.type, r.due_date, r.status AS recall_status, r.interval_months, r.interval_overridden, r.last_done_date, r.last_done_code, r.last_done_source,
       r.last_contacted_at, r.appointment_id, r.status_reason,
       p.first_name, p.last_name, p.phone, p.email, p.dob, p.location_id, p.primary_provider_id, p.primary_hygienist_id,
       a.start_time AS appt_start, a.status AS appt_status, l.name AS location_name,
       COALESCE(hy.name, dr.name) AS provider_name, COALESCE(p.primary_hygienist_id, p.primary_provider_id) AS provider_id
     FROM ${worklist('recalls')} r JOIN ${worklist('patients')} p ON p.id = r.patient_id
       LEFT JOIN appointments a ON a.id = r.appointment_id
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN providers hy ON hy.id = p.primary_hygienist_id
       LEFT JOIN providers dr ON dr.id = p.primary_provider_id
     WHERE ${where}${scope.sql} ORDER BY r.due_date, r.id`,
    ...args, ...scope.args,
  );
  // Patients with any visit booked from today on (a bundled x-ray is "scheduled" when the cleaning is).
  const booked = new Map((await db.all(
    `SELECT a.patient_id, MIN(a.start_time) AS start_time FROM real_appointments a WHERE a.practice_id = ? AND a.status IN (${ACTIVE_VISIT.map(() => '?').join(',')}) AND a.start_time >= ? GROUP BY a.patient_id`,
    pid, ...ACTIVE_VISIT, `${today} 00:00`,
  )).map((x) => [x.patient_id, x.start_time]));
  const out = [];
  for (const r of rows) {
    const t = typeByKey.get(r.type);
    if (!t) continue;
    const own = r.recall_status === 'scheduled' && r.appt_start && ACTIVE_VISIT.includes(r.appt_status) && r.appt_start.slice(0, 10) >= today ? r.appt_start : null;
    const next = own || (t.bundle ? booked.get(r.patient_id) : null) || null;
    const b = bucket({ status: r.recall_status, due_date: r.due_date }, today, settings, next ? next.slice(0, 10) : null);
    out.push({
      id: r.id, patient_id: r.patient_id, name: `${r.first_name} ${r.last_name}`, first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email,
      type: r.type, type_name: t.name, short: shortName(t), bundle: !!t.bundle, due_date: r.due_date, status: b, status_label: STATUS_LABELS[b], recall_status: r.recall_status,
      days_overdue: r.due_date && r.due_date < today ? daysBetween(r.due_date, today) : 0,
      last_done_date: r.last_done_date, last_done_code: r.last_done_code, last_done_source: r.last_done_source, interval_months: r.interval_months, interval_overridden: !!r.interval_overridden,
      scheduled_for: next, contacted_at: r.last_contacted_at, provider_id: r.provider_id, provider_name: r.provider_name, location_id: r.location_id, location_name: r.location_name,
      status_reason: r.status_reason,
    });
  }
  const summary = summarize(out, types);
  // One row per patient visit: with no type chosen, x-rays / exam / fluoride due by the time of the patient's
  // cleaning ride on the cleaning's row ("also due"); due well before it, they keep a row of their own.
  let list = out;
  if (!type) {
    const cleaning = new Map();
    for (const r of out) if (!r.bundle && r.status !== 'retired' && !cleaning.has(r.patient_id)) cleaning.set(r.patient_id, r);
    list = [];
    for (const r of out) {
      const main = r.bundle ? cleaning.get(r.patient_id) : null;
      if (main && r.status !== 'retired' && (!r.due_date || !main.due_date || r.due_date <= addDays(main.due_date, settings.due_soon_days))) {
        (main.also_due ||= []).push({ id: r.id, type: r.type, short: r.short, due_date: r.due_date, status: r.status });
      } else list.push(r);
    }
  }
  for (const r of list) r.also_due ||= [];
  const shown = status ? list.filter((r) => r.status === status) : list;
  return { today, settings, summary, rows: shown, reappointment: await reappointment(db, user, { today, locationId }) };
}

function summarize(rows, types) {
  const per = {};
  for (const t of types) per[t.key] = { type: t.key, name: t.name, short: shortName(t), bundle: !!t.bundle, total: 0, current: 0, due_soon: 0, due: 0, overdue: 0, scheduled: 0, none: 0, pct_current: null };
  for (const r of rows) {
    const s = per[r.type];
    if (!s || r.status === 'retired') continue;
    s.total++;
    s[r.status] = (s[r.status] || 0) + 1;
  }
  for (const s of Object.values(per)) s.pct_current = s.total ? Math.round((100 * (s.current + s.due_soon + s.scheduled)) / s.total) : null;
  const list = Object.values(per).filter((s) => s.total > 0);
  const all = list.reduce((a, s) => ({ total: a.total + s.total, current: a.current + s.current + s.due_soon + s.scheduled, overdue: a.overdue + s.overdue, due: a.due + s.due, due_soon: a.due_soon + s.due_soon, scheduled: a.scheduled + s.scheduled }), { total: 0, current: 0, overdue: 0, due: 0, due_soon: 0, scheduled: 0 });
  return { types: list, total: all.total, overdue: all.overdue, due: all.due, due_soon: all.due_soon, scheduled: all.scheduled, pct_current: all.total ? Math.round((100 * all.current) / all.total) : null };
}

// Reappointment: of the patients who had a cleaning (a non-bundled recall type's code) in the last 90 days,
// how many left with their next visit booked (a visit after it, booked by the end of that day).
export async function reappointment(db, user, { today, locationId = null, days = 90 }) {
  const pid = user.practice_id;
  const cleaning = (await recallTypes(db, pid)).filter((t) => t.active && !t.bundle).flatMap((t) => t.codes);
  if (!cleaning.length) return { seen: 0, reappointed: 0, pct: null, days };
  const since = addDays(today, -days);
  const scope = patientScope(user, 'p');
  const done = await db.all(
    `SELECT pr.patient_id, pr.code, pr.completed_at FROM real_procedures pr JOIN real_patients p ON p.id = pr.patient_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at <= ?${locationId ? ' AND (pr.location_id = ? OR (pr.location_id IS NULL AND p.location_id = ?))' : ''}${scope.sql}`,
    pid, since, `${today} 23:59:59`, ...(locationId ? [locationId, locationId] : []), ...scope.args,
  );
  const last = new Map();
  for (const d of done) if (matches(d.code, cleaning) && (!last.has(d.patient_id) || d.completed_at > last.get(d.patient_id))) last.set(d.patient_id, d.completed_at);
  let reappointed = 0;
  for (const [patientId, at] of last) {
    const day = at.slice(0, 10);
    const next = await db.get(
      "SELECT 1 AS x FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time > ? AND status NOT IN ('cancelled','no_show') AND created_at <= ?",
      pid, patientId, `${day} 23:59`, `${addDays(day, 1)} 06:00:00`,
    );
    if (next) reappointed++;
  }
  return { seen: last.size, reappointed, pct: last.size ? Math.round((100 * reappointed) / last.size) : null, days };
}

// The counts other screens use (capacity meter, metrics): per type and overall. Read-only.
export async function recallCounts(db, practiceId, { today, locationId = null } = {}) {
  const board = await recallBoard(db, { practice_id: practiceId, location_ids: null }, { today, locationId });
  return { ...board.summary, reappointment: board.reappointment };
}
