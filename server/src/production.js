// Production on the schedule (S5) and the perfect-day plan (S2): the one calculation every screen uses for
// "how much is booked today, how much is done, and what was the goal". Definitions (docs/workflows/specs/
// S5-production.md):
//   scheduled  = fees of the procedures (not cancelled) on the day's visits that aren't cancelled or missed —
//                the same numbers the schedule cards and the huddle show;
//   completed  = the live ledger charges (not voided, not reversals) posted for procedures on that day's
//                visits. The ledger is the source of truth: a voided charge and its reversal both drop out.
//   goal       = per provider: the day template's goal for that date (or its blocks' goals added up), else the
//                provider's daily goal on a day they work. Providers of a kind (doctor / hygiene) with no goal
//                fall back to the practice's goals (daily_goal, of which hygiene_goal is hygiene's part).
// A visit counts for its provider's kind: hygienists are "hygiene", dentists and specialists "doctor".
import { HttpError, can } from './auth.js';
import { appointmentScope, patientScope } from './officeaccess.js';
import { hoursFor, providerHoursFor } from './hours.js';
import { practiceNow, friendlyDateTime } from './util.js';

export const KINDS = ['all', 'doctor', 'hygiene'];
export const kindOf = (providerType) => (providerType === 'hygienist' ? 'hygiene' : 'doctor');
const INACTIVE = ['cancelled', 'no_show'];
const MAX_DAYS = 14;

export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
// 'YYYY-MM-DD HH:MM' shifted by some hours (wall-clock arithmetic, as appointment times are stored).
const shiftHours = (dateTime, hours) => new Date(Date.parse(`${dateTime.replace(' ', 'T')}:00Z`) - hours * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const parseIds = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
};

// ---- Perfect day: which template plans each provider's day ----

// Active templates with their active blocks, for the practice (or one provider).
export async function loadTemplates(db, practiceId, { providerId = null, includeRetired = false } = {}) {
  const templates = await db.all(
    `SELECT t.*, pv.name AS provider_name, pv.type AS provider_type, pv.color AS provider_color FROM day_templates t JOIN providers pv ON pv.id = t.provider_id
     WHERE t.practice_id = ?${includeRetired ? '' : ' AND t.active = 1'}${providerId ? ' AND t.provider_id = ?' : ''} ORDER BY pv.name, t.name, t.id`,
    practiceId, ...(providerId ? [providerId] : []),
  );
  if (!templates.length) return [];
  const ids = templates.map((t) => t.id);
  const blocks = await db.all(`SELECT * FROM day_template_blocks WHERE template_id IN (${ids.map(() => '?').join(',')}) AND active = 1 ORDER BY start_time, id`, ...ids);
  const typeNames = Object.fromEntries((await db.all('SELECT id, name FROM appointment_types WHERE practice_id = ?', practiceId)).map((t) => [t.id, t.name]));
  return templates.map((t) => ({
    ...t,
    weekdays: parseIds(t.weekdays),
    blocks: blocks.filter((b) => b.template_id === t.id).map((b) => {
      const types = parseIds(b.appointment_type_ids);
      return { ...b, appointment_type_ids: types, type_names: types.map((id) => typeNames[id]).filter(Boolean) };
    }),
  }));
}

// The template (or none) for each provider on each date from..to: a date override first, else their active
// template for that weekday. Map `${providerId}|${date}` → template.
export async function planDays(db, practiceId, from, to, templates = null) {
  templates ||= await loadTemplates(db, practiceId);
  const overrides = await db.all("SELECT provider_id, date, mode, template_id FROM day_template_dates WHERE practice_id = ? AND date >= ? AND date <= ? AND mode != 'auto'", practiceId, from, to);
  const byId = new Map(templates.map((t) => [t.id, t]));
  const providers = new Set([...templates.map((t) => t.provider_id), ...overrides.map((o) => o.provider_id)]);
  const out = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const pid of providers) {
      const o = overrides.find((x) => x.provider_id === pid && x.date === d);
      const t = o ? (o.mode === 'template' ? byId.get(o.template_id) : null) : templates.find((x) => x.provider_id === pid && x.weekdays.includes(weekdayOf(d)));
      if (t) out.set(`${pid}|${d}`, { ...t, override: !!o });
    }
  }
  return out;
}

// A template's blocks placed on a date, with when each one opens up to any visit type.
export const blocksOn = (t, date) => t.blocks.map((b) => {
  const start = `${date} ${b.start_time}`;
  return {
    id: b.id, template_id: t.id, template_name: t.name, provider_id: t.provider_id, provider_name: t.provider_name, location_id: t.location_id ?? null,
    label: b.label, start_time: start, end_time: `${date} ${b.end_time}`, appointment_type_ids: b.appointment_type_ids, type_names: b.type_names,
    goal: b.goal || 0, color: b.color || null, release_at: shiftHours(start, b.release_hours ?? t.release_hours ?? 24),
  };
});
const templateGoal = (t) => (t.day_goal != null ? t.day_goal : t.blocks.reduce((s, b) => s + (b.goal || 0), 0));

// Booking or moving a visit into a block kept for other visit types, before its release time. Returns null
// when it's fine, or { block, message }. A visit that isn't being placed anew (same time, provider and type)
// is never refused, so editing a note on a visit booked into a block "anyway" still works.
export async function checkDayBlocks(db, practiceId, row) {
  if (!row?.provider_id || !row.start_time || !row.end_time) return null;
  if (row.id) {
    const was = await db.get('SELECT start_time, end_time, provider_id, appointment_type_id FROM appointments WHERE id = ?', Number(row.id));
    if (was && was.start_time === row.start_time && was.end_time === row.end_time && was.provider_id === Number(row.provider_id)
      && (was.appointment_type_id ?? null) === (row.appointment_type_id == null ? null : Number(row.appointment_type_id))) return null;
  }
  const date = row.start_time.slice(0, 10);
  const templates = await loadTemplates(db, practiceId, { providerId: Number(row.provider_id) });
  if (!templates.length) return null;
  const plan = (await planDays(db, practiceId, date, date, templates)).get(`${Number(row.provider_id)}|${date}`);
  if (!plan) return null;
  const now = await practiceNow(db, practiceId);
  const type = row.appointment_type_id == null ? null : Number(row.appointment_type_id);
  for (const b of blocksOn(plan, date)) {
    if (!b.appointment_type_ids.length || b.start_time >= row.end_time || b.end_time <= row.start_time) continue;
    if (type != null && b.appointment_type_ids.includes(type)) continue;
    if (now >= b.release_at) continue; // released: open to any visit now
    const kept = b.type_names.length ? b.type_names.join(', ') : 'other visit types';
    return {
      block: b,
      message: `${b.start_time.slice(11)}–${b.end_time.slice(11)} is ${plan.provider_name}’s ${b.label} time, kept for ${kept} until ${friendlyDateTime(b.release_at)}`,
    };
  }
  return null;
}

// ---- The production numbers ----

const bucket = () => ({ scheduled: 0, completed: 0, visits: 0 });

// Everything the schedule shows about production for `days` days from `from`, for one kind of provider.
// The caller has checked the dates, the office and the person's access to it.
export async function scheduleProduction(db, user, { from, days = 1, locationId = null, kind = 'all' }) {
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  const n = Math.min(Math.max(Number(days) || 1, 1), MAX_DAYS);
  const to = addDays(from, n - 1);
  const pid = user.practice_id;
  const scope = appointmentScope(user);
  const where = `a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}`;
  const args = [pid, `${from} 00:00`, `${to} 24:00`, ...(locationId ? [locationId] : []), ...scope.args];
  const wanted = (type) => kind === 'all' || kindOf(type) === kind;

  const appts = (await db.all(
    `SELECT a.id, a.provider_id, a.operatory_id, a.status, a.start_time, a.appointment_type_id, pv.type AS provider_type
     FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE ${where}`, ...args,
  ));
  const procsOf = new Map();
  for (const x of await db.all(
    `SELECT x.id, x.appointment_id, x.category, x.fee FROM procedures x JOIN appointments a ON a.id = x.appointment_id WHERE ${where} AND x.status != 'cancelled'`, ...args,
  )) procsOf.set(x.appointment_id, [...(procsOf.get(x.appointment_id) || []), x]);
  // The ledger decides what's done: live charges for these procedures (a voided charge and its reversal both drop out).
  const charges = new Map((await db.all(
    `SELECT le.procedure_id, SUM(le.amount) AS amount FROM ledger_entries le JOIN procedures x ON x.id = le.procedure_id JOIN appointments a ON a.id = x.appointment_id
     WHERE ${where} AND le.practice_id = a.practice_id AND le.type = 'charge' AND le.retail_sale_id IS NULL AND le.voided_at IS NULL AND le.reverses_id IS NULL GROUP BY le.procedure_id`, ...args,
  )).map((r) => [r.procedure_id, Number(r.amount) || 0]));

  // Goals and plans.
  const practice = await db.get('SELECT office_hours, daily_goal, hygiene_goal FROM practices WHERE id = ?', pid);
  const location = locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, pid) : null;
  const hoursSource = location?.office_hours ? { ...practice, office_hours: location.office_hours } : practice;
  const providers = await db.all('SELECT id, name, type, color, daily_goal, working_hours FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
  const exceptions = await db.all('SELECT provider_id, date, hours FROM provider_exceptions WHERE practice_id = ? AND date >= ? AND date <= ?', pid, from, to);
  const templates = await loadTemplates(db, pid);
  const plans = await planDays(db, pid, from, to, templates);
  const works = (pv, d) => {
    const ex = exceptions.find((e) => e.provider_id === pv.id && e.date === d);
    return (ex ? JSON.parse(ex.hours) : providerHoursFor(hoursSource, pv, d)).length > 0;
  };
  const kindGoalSet = (k) => providers.some((pv) => kindOf(pv.type) === k && (pv.daily_goal > 0 || templates.some((t) => t.provider_id === pv.id)));
  const practiceGoal = (k) => {
    const daily = practice.daily_goal || 0;
    const hyg = Math.min(practice.hygiene_goal || 0, daily || Infinity);
    return k === 'hygiene' ? hyg : Math.max(0, daily - hyg);
  };

  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = { date: d, ...bucket(), goal: 0, providers: {}, operatories: {}, categories: {}, blocks: [] };
    const provBucket = (pv) => (day.providers[pv.id] ||= { ...bucket(), goal: 0, kind: kindOf(pv.type), name: pv.name, color: pv.color, categories: {} });
    // Adds to a { category: { scheduled, completed } } breakdown.
    const addCat = (cats, category, sched, done) => {
      const c = (cats[category] ||= { scheduled: 0, completed: 0 });
      c.scheduled += sched;
      c.completed += done;
    };
    const dayAppts = appts.filter((a) => a.start_time.startsWith(d));
    // Each visit's scheduled production (every kind: the blocks below show what's booked in them whatever is shown).
    const booked = new Map(dayAppts.map((a) => [a.id, INACTIVE.includes(a.status) ? 0 : (procsOf.get(a.id) || []).reduce((sum, x) => sum + x.fee, 0)]));
    for (const a of dayAppts) {
      if (!wanted(a.provider_type)) continue;
      const live = !INACTIVE.includes(a.status);
      const pv = providers.find((x) => x.id === a.provider_id) || { id: a.provider_id, type: a.provider_type, name: '', color: null };
      const pb = provBucket(pv);
      const ob = (day.operatories[a.operatory_id ?? 'none'] ||= { ...bucket(), categories: {}, providers: {} });
      const obp = (ob.providers[pv.id] ||= { scheduled: 0, completed: 0, visits: 0, name: pv.name, color: pv.color });
      if (live) { day.visits++; pb.visits++; ob.visits++; obp.visits++; }
      let sched = 0;
      let doneAll = 0;
      for (const x of procsOf.get(a.id) || []) {
        const fee = live ? x.fee : 0;
        const done = charges.get(x.id) || 0;
        sched += fee;
        doneAll += done;
        for (const cats of [day.categories, pb.categories, ob.categories]) addCat(cats, x.category, fee, done);
      }
      day.scheduled += sched; pb.scheduled += sched; ob.scheduled += sched; obp.scheduled += sched;
      day.completed += doneAll; pb.completed += doneAll; ob.completed += doneAll; obp.completed += doneAll;
    }
    // Goals: each provider's (template, else their own on a working day); kinds nobody set one for use the practice's.
    const officeOpen = hoursFor(hoursSource, d).length > 0;
    for (const k of kind === 'all' ? ['doctor', 'hygiene'] : [kind]) {
      if (!kindGoalSet(k)) {
        if (officeOpen) day.goal += practiceGoal(k);
        continue;
      }
      for (const pv of providers.filter((x) => kindOf(x.type) === k)) {
        const plan = plans.get(`${pv.id}|${d}`);
        if (plan && locationId && plan.location_id && plan.location_id !== locationId) continue;
        // In one office's view, a provider's own goal counts where they're seeing patients that day.
        const here = !locationId || (plan && (!plan.location_id || plan.location_id === locationId)) || dayAppts.some((a) => a.provider_id === pv.id);
        const goal = plan ? templateGoal(plan) : pv.daily_goal > 0 && works(pv, d) && here ? pv.daily_goal : 0;
        if (!goal) continue;
        provBucket(pv).goal += goal;
        day.goal += goal;
      }
    }
    // The perfect day's blocks (every provider's, whatever the kind shown: they're about where to book), with
    // what's booked in each so far.
    for (const pv of providers) {
      const plan = plans.get(`${pv.id}|${d}`);
      if (!plan || (locationId && plan.location_id && plan.location_id !== locationId)) continue;
      for (const b of blocksOn(plan, d)) {
        const inside = dayAppts.filter((a) => a.provider_id === pv.id && !INACTIVE.includes(a.status) && a.start_time >= b.start_time && a.start_time < b.end_time);
        day.blocks.push({
          ...b, provider_color: pv.color, visits: inside.length,
          matching: inside.filter((a) => !b.appointment_type_ids.length || b.appointment_type_ids.includes(a.appointment_type_id)).length,
          scheduled: inside.reduce((s, a) => s + (booked.get(a.id) || 0), 0),
        });
      }
    }
    out.push(day);
  }

  // Treatment diagnosed but not booked yet (the same list as the huddle's), for the office and kind.
  const ps = patientScope(user);
  const unscheduled = { amount: 0, procedures: 0, patients: 0, categories: {} };
  const pending = (await db.all(
    `SELECT x.fee, x.category, x.patient_id, pv.type AS provider_type FROM procedures x JOIN patients p ON p.id = x.patient_id LEFT JOIN providers pv ON pv.id = x.provider_id
     WHERE x.practice_id = ? AND x.status = 'planned' AND x.appointment_id IS NULL AND p.status = 'active'${locationId ? ' AND (x.location_id = ? OR (x.location_id IS NULL AND p.location_id = ?))' : ''}${ps.sql}`,
    pid, ...(locationId ? [locationId, locationId] : []), ...ps.args,
  )).filter((x) => kind === 'all' || (x.provider_type ? kindOf(x.provider_type) : x.category === 'preventive' ? 'hygiene' : 'doctor') === kind);
  for (const x of pending) {
    unscheduled.amount += x.fee;
    unscheduled.procedures++;
    unscheduled.categories[x.category] = (unscheduled.categories[x.category] || 0) + x.fee;
  }
  unscheduled.patients = new Set(pending.map((x) => x.patient_id)).size;

  const result = {
    from, to, kind, money: can(user, 'billing:read'), days: out, unscheduled,
    providers: providers.filter((pv) => wanted(pv.type)).map((pv) => ({ id: pv.id, name: pv.name, color: pv.color, kind: kindOf(pv.type) })),
  };
  return result.money ? result : hideMoney(result);
}

// Without billing access the schedule still shows visit counts and the day's blocks, never the money.
function hideMoney(r) {
  const strip = (b) => ({
    ...b, scheduled: null, completed: null, ...('goal' in b ? { goal: null } : {}), ...('categories' in b ? { categories: {} } : {}),
    ...(b.providers ? { providers: Object.fromEntries(Object.entries(b.providers).map(([k, v]) => [k, { ...v, scheduled: null, completed: null }])) } : {}),
  });
  return {
    ...r,
    unscheduled: { amount: null, procedures: r.unscheduled.procedures, patients: r.unscheduled.patients, categories: {} },
    days: r.days.map((d) => ({
      ...strip(d),
      providers: Object.fromEntries(Object.entries(d.providers).map(([k, v]) => [k, strip(v)])),
      operatories: Object.fromEntries(Object.entries(d.operatories).map(([k, v]) => [k, strip(v)])),
      categories: {},
      blocks: d.blocks.map((b) => ({ ...b, goal: null, scheduled: null })),
    })),
  };
}
