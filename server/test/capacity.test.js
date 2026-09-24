// Capacity meter (CAP1–CAP2): booked % from hours, patterns, blocks and days off; the first opening per kind of
// visit; demand in hours from recall and planned treatment; targets and their validation; the recommendations'
// thresholds and wording (with their numbers); office isolation; nightly snapshots (idempotent, pruned after two
// years); the practice's time zone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import capacityRoutes from '../src/routes/capacity.js';
import {
  computeCapacity, validateTargets, parseTargets, DEFAULT_TARGETS, waitStatus, bookedStatus, gapStatus, extendPlan, waitWords, clockWords,
  loadCapacityInputs, recordCapacitySnapshots, runCapacitySnapshots, capacitySummary, CAPACITY_SCHEMA, CAPACITY_COLUMNS,
} from '../src/capacity.js';
import { DEFAULT_APPOINTMENT_TYPES } from '../src/defaults.js';
import { DEFAULT_RECALL_TYPES } from '../src/recalls.js';

// ---- Pure calculation ----
const MON = '2026-09-28'; // a Monday
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const TYPES = DEFAULT_APPOINTMENT_TYPES.map(([name, duration, , codes, providerType], i) => ({ id: i + 1, name, duration, procedure_codes: JSON.stringify(codes), provider_type: providerType, active: 1 }));
const typeId = (prefix) => TYPES.find((t) => t.name.startsWith(prefix)).id;
const RECALL_TYPES = DEFAULT_RECALL_TYPES.map(([key, name, months, codes, active]) => ({ key, name, interval_months: months, codes, active, appointment_type_id: null }));
const DOC = { id: 1, name: 'Dr. Amy Chen, DDS', type: 'dentist', working_hours: null, active: 1 };
const HYG = { id: 2, name: 'Hana Ruiz, RDH', type: 'hygienist', working_hours: null, active: 1 };

function input(extra = {}) {
  return {
    today: MON, now: `${MON} 07:00`, locationId: null, practice: { office_hours: null }, locations: [], providers: [DOC, HYG],
    exceptions: [], blockouts: [], appointments: [], holds: [], templateBlocks: [], planOffices: {}, home: {}, types: TYPES,
    recallTypes: RECALL_TYPES, recalls: [], planned: [], waitlist: [], requests: [], targets: DEFAULT_TARGETS, ...extra,
  };
}
const visit = (provider, date, from, to, extra = {}) => ({ provider_id: provider, location_id: null, start_time: `${date} ${from}`, end_time: `${date} ${to}`, appointment_type_id: null, status: 'scheduled', asap: 0, ...extra });
// Fills a provider's working days (Mon–Fri 08:00–17:00) for `days` days from `from`.
const fill = (provider, from, days, typeIdOf = null) => {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(visit(provider, d, '08:00', '17:00', { appointment_type_id: typeIdOf }));
  }
  return out;
};

test('booked % = booked minutes ÷ available minutes: hours, provider patterns, blocks, days off, double booking', () => {
  const c = computeCapacity(input({
    providers: [DOC, { ...HYG, working_hours: JSON.stringify({ 2: [['07:00', '15:00']], 4: [['07:00', '15:00']] }) }],
    blockouts: [
      // An office holiday (no provider, no chair) and the doctor's lunch meeting on Monday.
      { provider_id: null, operatory_id: null, start_time: `${addDays(MON, 2)} 00:00`, end_time: `${addDays(MON, 3)} 00:00`, kind: 'blocked' },
      { provider_id: 1, operatory_id: null, start_time: `${MON} 12:00`, end_time: `${MON} 13:00`, kind: 'blocked' },
      // A chair's own block doesn't take the provider's time.
      { provider_id: null, operatory_id: 9, start_time: `${MON} 08:00`, end_time: `${MON} 17:00`, kind: 'blocked' },
      // Reserved time is still bookable time (only for its own visit types).
      { provider_id: 1, operatory_id: null, start_time: `${addDays(MON, 1)} 08:00`, end_time: `${addDays(MON, 1)} 08:30`, kind: 'reserved', appointment_type_ids: '[9]' },
    ],
    exceptions: [{ provider_id: 1, date: addDays(MON, 4), hours: '[]' }], // Friday off
    appointments: [
      visit(1, MON, '09:00', '11:00'), // 120
      visit(1, MON, '11:30', '12:30'), // only 30 of it is in available time (the meeting)
      visit(1, addDays(MON, 1), '09:00', '10:00'), visit(1, addDays(MON, 1), '09:00', '10:00'), // double booked: 60 once
      visit(1, addDays(MON, 2), '09:00', '10:00'), // on the holiday: not available time
      visit(2, addDays(MON, 1), '07:00', '11:00'), // hygienist: 240 of her Tuesday
    ],
  }));
  const doc = c.providers.find((p) => p.id === 1);
  // Two weeks: 10 weekdays × 540 − holiday 540 − Friday off 540 − meeting 60.
  assert.equal(doc.booked.w2.available_minutes, 10 * 540 - 540 - 540 - 60);
  assert.equal(doc.booked.w2.booked_minutes, 120 + 30 + 60);
  assert.equal(doc.booked.w2.pct, Math.round((210 / 4260) * 1000) / 10);
  // The hygienist works Tuesdays and Thursdays 07:00–15:00; the holiday is a Wednesday.
  const hyg = c.providers.find((p) => p.id === 2);
  assert.equal(hyg.booked.w2.available_minutes, 4 * 480);
  assert.equal(hyg.booked.w4.available_minutes, 8 * 480);
  assert.equal(hyg.booked.w2.booked_minutes, 240);
  assert.equal(c.kinds.hygiene.booked.w2.pct, 12.5);
  // Nothing booked is under the band: red.
  assert.equal(c.kinds.doctor.booked.status, 'red');
});

test('first opening per kind of visit: after now today, around visits, reserved and perfect-day blocks until released', () => {
  // The doctor is full all week; the hygienist is free.
  const base = input({ appointments: fill(1, MON, 5) });
  let c = computeCapacity(base);
  const t60 = c.kinds.doctor.openings.treatment_60;
  assert.equal(t60.opening.start, `${addDays(MON, 7)} 08:00`);
  assert.equal(t60.days, 7);
  assert.equal(t60.status, 'green');
  // Emergencies count business days: Tue–Fri and Monday = 5, over a 1-day target → red.
  const em = c.kinds.doctor.openings.emergency;
  assert.equal(em.opening.business_days, 5);
  assert.equal(em.days, 5);
  assert.equal(em.status, 'red');
  // Recall and new patients go to hygiene (their visit types are hygiene's), from now on today.
  assert.equal(c.kinds.hygiene.openings.recall.opening.start, `${MON} 08:00`);
  assert.equal(c.kinds.hygiene.openings.new_patient.opening.minutes, 90);
  assert.ok(!('recall' in c.kinds.doctor.openings));
  c = computeCapacity({ ...base, now: `${MON} 16:05` });
  assert.equal(c.kinds.hygiene.openings.recall.opening.start, `${addDays(MON, 1)} 08:00`, 'after 16:05 an hour visit no longer fits today');

  // Tuesday 08:00–08:30 kept for emergencies: open to an emergency, not to a filling.
  const kept = { provider_id: 1, operatory_id: null, start_time: `${addDays(MON, 1)} 08:00`, end_time: `${addDays(MON, 1)} 08:30`, kind: 'reserved', appointment_type_ids: `[${typeId('Emergency')}]` };
  const appts = fill(1, MON, 5).map((a) => (a.start_time.startsWith(addDays(MON, 1)) ? { ...a, start_time: `${addDays(MON, 1)} 08:30` } : a));
  c = computeCapacity(input({ appointments: appts, blockouts: [kept] }));
  assert.equal(c.kinds.doctor.openings.emergency.opening.start, `${addDays(MON, 1)} 08:00`);
  assert.equal(c.kinds.doctor.openings.emergency.status, 'green');
  assert.equal(c.kinds.doctor.openings.treatment_30.opening.start, `${addDays(MON, 7)} 08:00`);

  // Next Monday 08:00–10:00 is kept for crowns until Sunday: a filling can't go there yet; a crown can.
  const crowns = { provider_id: 1, date: addDays(MON, 7), start_time: `${addDays(MON, 7)} 08:00`, end_time: `${addDays(MON, 7)} 10:00`, appointment_type_ids: [typeId('Crown prep')], release_at: `${addDays(MON, 6)} 08:00`, label: 'Crowns' };
  c = computeCapacity(input({ appointments: fill(1, MON, 5), templateBlocks: [crowns] }));
  assert.equal(c.kinds.doctor.openings.treatment_60.opening.start, `${addDays(MON, 7)} 08:00`, 'crown prep is a treatment type: it may use the crown block');
  c = computeCapacity(input({ appointments: fill(1, MON, 5), templateBlocks: [crowns], types: TYPES.map((t) => (t.name === 'Crown prep' ? { ...t, provider_type: 'hygienist' } : t)) }));
  assert.equal(c.kinds.doctor.openings.treatment_60.opening.start, `${addDays(MON, 7)} 10:00`, 'a block kept for other visits waits for its release');
  assert.equal(c.kinds.doctor.blocks.count, 1);
  assert.equal(c.kinds.doctor.blocks.list[0].label, 'Crowns');
  // After the release time anyone may book it.
  c = computeCapacity(input({ appointments: fill(1, MON, 5), templateBlocks: [{ ...crowns, release_at: `${MON} 06:00` }], types: TYPES.map((t) => (t.name === 'Crown prep' ? { ...t, provider_type: 'hygienist' } : t)) }));
  assert.equal(c.kinds.doctor.openings.treatment_60.opening.start, `${addDays(MON, 7)} 08:00`);
  assert.equal(c.kinds.doctor.blocks.list[0].released, true);

  // A pending online request holds its time; nothing within the horizon → no opening, red.
  c = computeCapacity(input({ holds: [{ provider_id: 2, start_time: `${MON} 08:00`, end_time: `${MON} 09:00` }] }));
  assert.equal(c.kinds.hygiene.openings.recall.opening.start, `${MON} 09:00`);
  c = computeCapacity(input({ appointments: fill(2, MON, 130) }));
  assert.equal(c.kinds.hygiene.openings.recall.opening, null);
  assert.equal(c.kinds.hygiene.openings.recall.status, 'red');
});

test('demand in hours: recall by the recall type’s visit length (one per patient), planned work by time units or category', () => {
  const recalls = [
    { patient_id: 1, type: 'prophy', due_date: addDays(MON, 10) },
    { patient_id: 1, type: 'bwx', due_date: addDays(MON, 10) }, // rides along with the cleaning
    { patient_id: 2, type: 'perio_maint', due_date: addDays(MON, 40) },
    { patient_id: 3, type: 'prophy', due_date: addDays(MON, -30) },
    { patient_id: 4, type: 'prophy', due_date: addDays(MON, 10) },
    { patient_id: 4, type: 'perio_maint', due_date: addDays(MON, 20) },
  ];
  const planned = [
    { patient_id: 5, category: 'restorative', time_units: null, provider_type: 'dentist' }, // 60
    { patient_id: 5, category: 'endodontics', time_units: 9, provider_type: null }, // 90
    { patient_id: 6, category: 'preventive', time_units: null, provider_type: null }, // hygiene, 40
  ];
  const c = computeCapacity(input({ recalls, planned }));
  const r = c.kinds.hygiene.demand.recall;
  assert.deepEqual(r.due_4w, { patients: 2, hours: 2 });
  assert.deepEqual(r.due_8w, { patients: 3, hours: 3 });
  assert.deepEqual(r.overdue, { patients: 1, hours: 1 });
  assert.equal(c.kinds.doctor.demand.recall, null);
  assert.deepEqual(c.kinds.doctor.demand.unscheduled, { procedures: 2, patients: 1, hours: 2.5 });
  assert.deepEqual(c.kinds.hygiene.demand.unscheduled, { procedures: 1, patients: 1, hours: 0.7 });
  // Hours a week: 3 h due over 8 weeks + 1 h overdue and 40 min of planned hygiene over the 8 backlog weeks.
  assert.equal(c.kinds.hygiene.demand.parts.recall_due, 0.4);
  assert.equal(c.kinds.hygiene.demand.parts.recall_overdue, 0.1);
  assert.equal(c.kinds.hygiene.demand.hours_week, Math.round((3 / 8 + 1 / 8 + 40 / 60 / 8) * 10) / 10);
  assert.equal(c.kinds.doctor.demand.hours_week, Math.round((2.5 / 8) * 10) / 10);
  // Supply: 8 weeks × 45 open hours a week for each.
  assert.equal(c.kinds.hygiene.supply.open_hours_week, 45);
  assert.ok(c.kinds.hygiene.gap_hours_week > 44);
  assert.equal(c.kinds.hygiene.gap_status, 'green');
  // The ASAP list and online requests go to the kind they're for.
  const c2 = computeCapacity(input({
    appointments: [visit(1, addDays(MON, 3), '09:00', '10:00', { asap: 1 })],
    waitlist: [{ provider_type: null, reason: 'Wants an earlier cleaning' }, { provider_type: 'dentist', reason: 'Crown' }],
    requests: [{ provider_type: null, reason: 'Toothache', new_patient: 0, created_at: `${addDays(MON, -2)} 10:00` }, { provider_type: null, reason: 'Cleaning', new_patient: 1, created_at: `${MON} 06:00` }],
  }));
  assert.deepEqual(c2.kinds.doctor.demand.asap, { visits: 1, waitlist: 1, count: 2 });
  assert.equal(c2.kinds.hygiene.demand.asap.count, 1);
  assert.deepEqual(c2.kinds.doctor.demand.requests, { count: 1, oldest_days: 2 });
  assert.equal(c2.kinds.hygiene.demand.requests.count, 1);
});

test('status against targets: waits, the booked band and supply vs demand', () => {
  assert.equal(waitStatus(7, 7), 'green');
  assert.equal(waitStatus(11, 7), 'amber');
  assert.equal(waitStatus(12, 7), 'red');
  assert.equal(waitStatus(1, 1), 'green');
  assert.equal(waitStatus(2, 1), 'amber');
  assert.equal(waitStatus(3, 1), 'red');
  assert.equal(waitStatus(0, 0), 'green');
  assert.equal(waitStatus(1, 0), 'amber');
  assert.equal(waitStatus(null, 21), 'red');
  assert.equal(bookedStatus(90, 85, 95), 'green');
  assert.equal(bookedStatus(80, 85, 95), 'amber');
  assert.equal(bookedStatus(74.9, 85, 95), 'red');
  assert.equal(bookedStatus(96, 85, 95), 'amber');
  assert.equal(bookedStatus(97.5, 85, 95), 'red');
  assert.equal(bookedStatus(null, 85, 95), 'none');
  assert.equal(gapStatus(0, 8), 'green');
  assert.equal(gapStatus(-3.9, 8), 'amber');
  assert.equal(gapStatus(-4, 8), 'red');
  assert.equal(waitWords(35), '5 weeks');
  assert.equal(waitWords(1), '1 day');
  assert.equal(clockWords(18 * 60), '6 pm');
  assert.equal(clockWords(17 * 60 + 30), '5:30 pm');
});

test('targets: defaults, partial changes, and plain refusals', () => {
  assert.deepEqual(parseTargets(null), DEFAULT_TARGETS);
  assert.deepEqual(parseTargets('not json'), DEFAULT_TARGETS);
  assert.equal(parseTargets('{"hygiene_days":28}').hygiene_days, 28);
  const t = validateTargets({ hygiene_days: 28, booked_low: 80 }, DEFAULT_TARGETS);
  assert.equal(t.hygiene_days, 28);
  assert.equal(t.booked_low, 80);
  assert.equal(t.treatment_days, 14);
  assert.equal(validateTargets({ new_patient_type_id: '' }, { ...DEFAULT_TARGETS, new_patient_type_id: 4 }).new_patient_type_id, null);
  for (const bad of [{ hygiene_days: -1 }, { hygiene_days: 2.5 }, { hygiene_days: 'soon' }, { emergency_business_days: 11 }, { booked_high: 101 },
    { booked_low: 96 }, { backlog_weeks: 0 }, { new_patient_type_id: 'x' }, { nonsense: 1 }, { hygiene_days: null }]) {
    assert.throws(() => validateTargets(bad, DEFAULT_TARGETS), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => validateTargets([], DEFAULT_TARGETS), (e) => e.status === 400);
  // Customized targets change the colour of the same numbers.
  const c = computeCapacity(input({ appointments: fill(1, MON, 5), targets: { ...DEFAULT_TARGETS, emergency_business_days: 5 } }));
  assert.equal(c.kinds.doctor.openings.emergency.status, 'green');
});

test('recommendation: hygiene booked out with recall due → add a hygiene day, with the numbers behind it', () => {
  // Hygiene full for five weeks; 140 cleanings due in the next month.
  const recalls = Array.from({ length: 140 }, (_, i) => ({ patient_id: 100 + i, type: 'prophy', due_date: addDays(MON, i % 28) }));
  const c = computeCapacity(input({ appointments: fill(2, MON, 35, typeId('Recall')), recalls }));
  const rec = c.recommendations.find((r) => r.rule === 'add_hygiene_day');
  assert.ok(rec, JSON.stringify(c.recommendations));
  assert.equal(rec.text, 'Hygiene is booked 5 weeks out and 140 recall hours are due in the next month: add a hygiene day (about 9 more visits a week)');
  assert.equal(rec.severity, 'red');
  assert.equal(rec.numbers.recall_hours_due_4w, 140);
  assert.equal(rec.numbers.wait_days, 35);
  assert.equal(rec.numbers.target_days, 21);
  assert.equal(rec.numbers.visits_per_day, 9); // a 9-hour day of 60-minute recall visits
  assert.match(rec.because, /First recall opening 2026-11-02 \(35 days\), target 21 days/);
  assert.equal(c.kinds.hygiene.status, 'red');
  assert.equal(c.recommendations[0].severity, 'red', 'red first');
  // More demand than one day covers → more days.
  const more = Array.from({ length: 600 }, (_, i) => ({ patient_id: 1000 + i, type: 'prophy', due_date: addDays(MON, i % 56) }));
  const c2 = computeCapacity(input({ appointments: fill(2, MON, 35, typeId('Recall')), recalls: more }));
  assert.match(c2.recommendations.find((r) => r.rule === 'add_hygiene_day').text, /add \d hygiene days a week \(about \d+ more visits a week\)/);
  // On target: nothing to say about hygiene time.
  const ok = computeCapacity(input({ appointments: fill(2, MON, 14, typeId('Recall')) }));
  assert.equal(ok.kinds.hygiene.openings.recall.status, 'green');
  assert.ok(!ok.recommendations.some((r) => r.rule === 'add_hygiene_day'));
});

test('recommendation: a doctor’s treatment 4 weeks out → extend the fullest short day or open a free weekday', () => {
  // Dr. Chen works Monday to Thursday; Thursday ends an hour early. Full for four weeks.
  const doc = { ...DOC, working_hours: JSON.stringify({ 1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']], 4: [['08:00', '17:00']] }) };
  const appts = [];
  for (let i = 0; i < 28; i++) {
    const d = addDays(MON, i);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 4) appts.push(visit(1, d, '08:00', wd === 4 ? '17:00' : '18:00'));
  }
  const c = computeCapacity(input({ providers: [doc, HYG], appointments: appts }));
  const rec = c.recommendations.find((r) => r.rule === 'extend_doctor');
  assert.equal(rec.text, 'Dr. Amy Chen’s treatment is 4 weeks out: extend Thursday to 6 pm or open a Friday');
  assert.equal(rec.severity, 'red');
  assert.equal(rec.provider_id, 1);
  assert.equal(rec.numbers.wait_days, 28);
  assert.equal(rec.numbers.extend_hours, 1);
  // Only a little over target (amber): a longer day is enough.
  const three = appts.filter((a) => a.start_time < addDays(MON, 21));
  const c2 = computeCapacity(input({ providers: [doc, HYG], appointments: three }));
  const rec2 = c2.recommendations.find((r) => r.rule === 'extend_doctor');
  assert.equal(c2.providers.find((p) => p.id === 1).openings.treatment_60.status, 'amber');
  assert.equal(rec2.text, 'Dr. Amy Chen’s treatment is 3 weeks out: extend Thursday to 6 pm');
  // Days already running to 7 pm can't be extended: open another day.
  assert.deepEqual(extendPlan({ 1: { open: 480, close: 1140, minutes: 660 } }, 1), { extend: null, open: 'Tuesday' });
  // Ties on the closing time go to the fullest day.
  const plan = extendPlan({ 1: { open: 480, close: 1020 }, 3: { open: 480, close: 1020 } }, 1, { 1: { available_minutes: 100, booked_minutes: 90 }, 3: { available_minutes: 100, booked_minutes: 50 } });
  assert.equal(plan.extend.day, 'Monday');
});

test('recommendation: emergencies waiting → hold slots a day, sized by the recent emergency rate', () => {
  // Last 8 weeks: 80 emergencies over 40 open days → 2 a day.
  const history = [];
  for (let i = 1; i <= 56; i++) {
    const d = addDays(MON, -i);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) for (const t of ['08:00', '08:30']) history.push(visit(1, d, t, t === '08:00' ? '08:30' : '09:00', { appointment_type_id: typeId('Emergency') }));
  }
  const c = computeCapacity(input({ appointments: [...history, ...fill(1, MON, 3)] }));
  const rec = c.recommendations.find((r) => r.rule === 'hold_emergency');
  assert.equal(c.kinds.doctor.demand.emergencies.per_day, 2);
  assert.equal(rec.text, 'Hold 2 emergency slots a day — emergencies are waiting 3 business days');
  assert.equal(rec.numbers.wait_business_days, 3);
  assert.equal(rec.severity, 'red');
  // The emergency run rate is demand: 80 × 30 min over 8 weeks = 5 hours a week.
  assert.equal(c.kinds.doctor.demand.parts.emergencies, 5);
  // Next business day is on target: no advice.
  const ok = computeCapacity(input({ appointments: [...history, ...fill(1, MON, 1)] }));
  assert.equal(ok.kinds.doctor.openings.emergency.days, 1);
  assert.ok(!ok.recommendations.some((r) => r.rule === 'hold_emergency'));
});

test('recommendation: new patients and under-booked chairs, online requests waiting', () => {
  const c = computeCapacity(input({
    appointments: fill(2, MON, 14, typeId('Recall')),
    requests: [{ provider_type: null, reason: 'New here', new_patient: 1, created_at: `${addDays(MON, -3)} 09:00` }],
    recalls: [{ patient_id: 1, type: 'prophy', due_date: addDays(MON, 3) }],
  }));
  const np = c.recommendations.find((r) => r.rule === 'new_patient_slots');
  assert.equal(np.text, 'New patients wait 2 weeks for a first visit (target 7 days): keep 2 new-patient openings a week — 1 online request is waiting too');
  assert.equal(np.numbers.wait_days, 14);
  const req = c.recommendations.find((r) => r.rule === 'answer_requests');
  assert.equal(req.severity, 'red');
  assert.match(req.text, /^1 online request is waiting for an answer \(oldest 3 days\)/);
  // The doctor has nothing booked: fill from the unscheduled treatment list.
  const fillDoc = c.recommendations.find((r) => r.rule === 'fill_doctor');
  assert.match(fillDoc.text, /^Dr\. Amy Chen is only 0% booked for the next 4 weeks \(target 85–95%\)/);
  assert.equal(fillDoc.action.to, '/followups?tab=unscheduled');
});

// ---- With the database and the routes ----
const h = harness();
const isPg = !!process.env.TEST_DATABASE_URL;
before(async () => {
  while (!h.db || !h.app) await new Promise((r) => setTimeout(r, 10));
  // Until db.js carries the table and column (see the hand-off), add them here. Harmless once it does.
  await h.db.run(isPg ? CAPACITY_SCHEMA.replace('id INTEGER PRIMARY KEY', 'id SERIAL PRIMARY KEY') : CAPACITY_SCHEMA);
  for (const [table, column, def] of CAPACITY_COLUMNS) {
    await h.db.run(`ALTER TABLE ${table} ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${column} ${def}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
  }
  // Until app.js mounts the routes, put them in the app's /api router ahead of the other route groups.
  if (!h.app.router.stack.some((l) => l.handle?.stack?.some?.((x) => x.route?.path === '/capacity'))) {
    const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
    const at = api.stack.findIndex((l) => l.handle?.stack);
    api.use(capacityRoutes({ db: h.db }));
    api.stack.splice(at, 0, ...api.stack.splice(api.stack.length - 1, 1));
  }
});

async function staff(api, role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: role, role, password: `${role}-password-123` })).data;
  return { id: u.id, api: h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token) };
}
const localToday = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

test('GET /capacity: schedule:read, practice and office isolation, no money', async () => {
  const a = await h.practice();
  const b = await h.practice();
  const db = h.db;
  const pidA = (await db.get('SELECT practice_id FROM providers WHERE id = ?', a.provider.id)).practice_id;
  const pidB = (await db.get('SELECT practice_id FROM providers WHERE id = ?', b.provider.id)).practice_id;
  const today = localToday('America/New_York');
  // Practice B's dentist is fully booked; practice A's is empty.
  for (let i = 0; i < 20; i++) {
    const d = addDays(today, i);
    await db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pidB, b.patient.id, b.provider.id, `${d} 00:00`, `${d} 23:59`);
  }
  const ca = (await a.api.get('/capacity')).data;
  const cb = (await b.api.get('/capacity')).data;
  assert.equal(ca.kinds.doctor.booked.w2.booked_minutes, 0);
  assert.ok(cb.kinds.doctor.booked.w2.booked_minutes > 0);
  assert.deepEqual(ca.providers.map((p) => p.id), [a.provider.id]);
  assert.ok(!JSON.stringify(ca).match(/"(fee|amount|goal|production)"/), 'no money on the page');
  // Two offices in A: the dentist's chair is in the first, a second dentist's in the second.
  const l1 = (await a.api.post('/locations', { name: 'North' })).data.id;
  const l2 = (await a.api.post('/locations', { name: 'South' })).data.id;
  const dr2 = (await a.api.post('/providers', { name: 'Dr. Two, DDS', type: 'dentist' })).data;
  const [op1, op2] = (await a.api.get('/operatories')).data;
  await db.run('UPDATE operatories SET location_id = ?, default_provider_id = ? WHERE id = ?', l1, a.provider.id, op1.id);
  await db.run('UPDATE operatories SET location_id = ?, default_provider_id = ? WHERE id = ?', l2, dr2.id, op2.id);
  const north = (await a.api.get(`/capacity?location_id=${l1}`)).data;
  assert.deepEqual(north.providers.map((p) => p.id), [a.provider.id]);
  assert.equal(north.office.name, 'North');
  const south = (await a.api.get(`/capacity?location_id=${l2}`)).data;
  assert.deepEqual(south.providers.map((p) => p.id), [dr2.id]);
  // Another practice's office, and nonsense.
  const lB = (await b.api.post('/locations', { name: 'B office' })).data.id;
  assert.equal((await a.api.get(`/capacity?location_id=${lB}`)).status, 404);
  assert.equal((await a.api.get('/capacity?location_id=abc')).status, 400);
  // Someone limited to North can't see South, and sees North by default.
  const fd = await staff(a.api, 'front_desk');
  await db.run('UPDATE users SET location_ids = ? WHERE id = ?', JSON.stringify([l1]), fd.id);
  assert.equal((await fd.api.get(`/capacity?location_id=${l2}`)).status, 403);
  assert.equal((await fd.api.get('/capacity')).data.location_id, l1);
  // Without schedule:read: refused.
  await db.run("UPDATE users SET permissions_remove = '[\"schedule:read\"]', location_ids = NULL WHERE id = ?", fd.id);
  assert.equal((await fd.api.get('/capacity')).status, 403);
  assert.equal((await fd.api.get('/capacity/trend')).status, 403);
  void pidA;
});

test('targets: anyone on the schedule reads them; only an administrator changes them, audited with before and after', async () => {
  const p = await h.practice();
  const fd = await staff(p.api, 'front_desk');
  const read = (await fd.api.get('/capacity/targets')).data;
  assert.deepEqual(read.targets, DEFAULT_TARGETS);
  assert.equal(read.can_edit, false);
  assert.equal((await fd.api.put('/capacity/targets', { hygiene_days: 28 })).status, 403);
  assert.equal((await p.api.put('/capacity/targets', { hygiene_days: 400 })).status, 400);
  assert.equal((await p.api.put('/capacity/targets', { booked_low: 97 })).status, 400);
  const other = await h.practice();
  const theirType = (await other.api.get('/appointment-types')).data[0];
  assert.equal((await p.api.put('/capacity/targets', { emergency_type_id: theirType.id })).status, 404);
  const mine = (await p.api.get('/appointment-types')).data.find((t) => t.name === 'Consultation');
  const res = await p.api.put('/capacity/targets', { hygiene_days: 28, emergency_type_id: mine.id, reason: 'We aim for four weeks' });
  assert.equal(res.status, 200);
  assert.equal(res.data.targets.hygiene_days, 28);
  const c = (await p.api.get('/capacity')).data;
  assert.equal(c.targets.hygiene_days, 28);
  assert.equal(c.visit_types.emergency.name, 'Consultation');
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const row = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'capacity.targets.update' ORDER BY id DESC", pid);
  const changes = JSON.parse(row.changes);
  assert.deepEqual(changes.hygiene_days, [21, 28]);
  assert.deepEqual(changes.emergency_type_id, [null, mine.id]);
  assert.equal(row.reason, 'We aim for four weeks');
  assert.equal(row.source, 'human');
});

test('the practice’s time zone decides today and now', async () => {
  const p = await h.practice();
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  await h.db.run("UPDATE practices SET timezone = 'America/Los_Angeles' WHERE id = ?", pid);
  // 03:30 UTC on Tuesday 29 Sept is 20:30 on Monday 28 Sept in Los Angeles: still Monday, and too late today.
  const now = new Date('2026-09-29T03:30:00Z');
  const inputs = await loadCapacityInputs(h.db, pid, { now });
  assert.equal(inputs.today, '2026-09-28');
  assert.equal(inputs.now, '2026-09-28 20:30');
  const c = computeCapacity(inputs);
  assert.equal(c.kinds.doctor.openings.treatment_60.opening.date, '2026-09-29');
  assert.equal(c.kinds.doctor.openings.treatment_60.days, 1);
  // In New York it's already Tuesday.
  await h.db.run("UPDATE practices SET timezone = 'America/New_York' WHERE id = ?", pid);
  assert.equal((await loadCapacityInputs(h.db, pid, { now })).today, '2026-09-28');
  assert.equal((await loadCapacityInputs(h.db, pid, { now: new Date('2026-09-29T04:30:00Z') })).today, '2026-09-29');
});

test('nightly snapshots: once a day per scope and kind (repeat runs change nothing), after 9 pm local, pruned after two years; the trend reads them', async () => {
  const p = await h.practice();
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  await h.db.run("UPDATE practices SET timezone = 'America/Chicago' WHERE id = ?", pid);
  await p.api.post('/providers', { name: 'Hana Ruiz, RDH', type: 'hygienist' });
  await h.db.run("INSERT INTO capacity_snapshots (practice_id, snapshot_date, scope_key, kind, booked_pct_4w) VALUES (?, '2023-01-02', 'practice', 'doctor', 500)", pid);
  const count = async () => Number((await h.db.get('SELECT COUNT(*) AS n FROM capacity_snapshots WHERE practice_id = ?', pid)).n);
  // 20:00 in Chicago: not yet.
  await runCapacitySnapshots(h.db, { now: new Date('2026-09-29T01:00:00Z') });
  assert.equal(await count(), 1);
  // 21:30 in Chicago: today's rows (doctor and hygiene for the practice), and the three-year-old row goes.
  await runCapacitySnapshots(h.db, { now: new Date('2026-09-29T02:30:00Z') });
  const rows = await h.db.all('SELECT * FROM capacity_snapshots WHERE practice_id = ? ORDER BY kind', pid);
  assert.deepEqual(rows.map((r) => [r.snapshot_date, r.scope_key, r.kind]), [['2026-09-28', 'practice', 'doctor'], ['2026-09-28', 'practice', 'hygiene']]);
  assert.equal(rows[0].booked_pct_4w, 0);
  assert.ok(rows[0].first_treatment_days != null);
  // Again (a second server, a restart): nothing new.
  await runCapacitySnapshots(h.db, { now: new Date('2026-09-29T03:00:00Z') });
  assert.equal(await recordCapacitySnapshots(h.db, pid, { now: new Date('2026-09-29T03:00:00Z') }), 0);
  assert.equal(await count(), 2);
  // The next evening adds the next day.
  await recordCapacitySnapshots(h.db, pid, { now: new Date('2026-09-30T02:30:00Z') });
  assert.equal(await count(), 4);
  const trend = (await p.api.get('/capacity/trend?days=731')).data;
  assert.ok(trend.points.some((x) => x.date === '2026-09-28' && x.kind === 'doctor' && x.booked_pct_4w === 0));
  assert.equal((await p.api.get('/capacity/trend?days=3')).status, 400);
});

test('the metric emails’ summary: plain lines and the top recommendations', async () => {
  const p = await h.practice();
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const s = await capacitySummary(h.db, pid, { limit: 2 });
  assert.ok(['green', 'amber', 'red'].includes(s.status));
  assert.match(s.lines[0], /^Doctor: 0% booked next 4 weeks; first openings — /);
  assert.ok(s.recommendations.length <= 2);
  assert.ok(s.recommendations.every((r) => r.text && r.because));
});
