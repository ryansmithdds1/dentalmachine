// The business view (PM1–PM4, BD1–BD4, EX1–EX3; docs/business-view.md): margin math to the cent, cost versions by
// date of service, labor so far / projected with overtime and breaks, who was productive, idle gaps, staffing, exam
// support — and who may see what (staff nothing, pay only with timeclock:rates, one practice / office at a time).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError, PERMISSION_CATALOG } from '../src/auth.js';
import { setActor, actorMiddleware } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import businessRoutes from '../src/routes/business.js';
import { localToUtc } from '../src/timeclock.js';
import {
  visitMargin, visitMinutes, resolveProfile, resolvePay, addUp, thresholdsFor, bandFor, bandValue, splitSegment, laborDay, staffTimeline, suggestionsFor,
  staffingByHour, staffingAdvice, overtimeRisk, allocate, rnd, examSupport, countExams, examTargets, whatIfFee, whatIfDropPlan, suggestSupplies, trendRow,
  scaleExamValue, TYPICAL_EXAM_VALUES, CATEGORY_DEFAULTS, DEFAULT_SETTINGS,
} from '../src/business.js';
import { shapeMargin, awayState, businessDigestBlocks } from '../src/businessdata.js';

const SECRET = 'test-secret';
const h = harness();
let server;
// Started from the first API test, once the harness's own app is up.
async function startOuter() {
  if (server) return;
  // The business routes mounted the way app.js will mount them (api.use(businessRoutes({ db }))), in front of the app.
  const outer = express();
  outer.use(actorMiddleware(h.db, flushChanges));
  outer.use(express.json());
  const biz = express.Router();
  biz.use(authenticate(h.db, SECRET));
  biz.use((req, _res, next) => {
    setActor({ source: req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  biz.use(businessRoutes({ db: h.db }));
  outer.use('/api', (req, res, next) => (req.path.startsWith('/business') ? biz(req, res, next) : next()));
  outer.use((req, res, next) => h.app(req, res, next)); // the harness's app (its own before hook creates it)
  // eslint-disable-next-line no-unused-vars
  outer.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  h.outer = outer;
  await new Promise((resolve) => { server = outer.listen(0, resolve); });
  h.origin = `http://127.0.0.1:${server.address().port}`;
}
after(() => server?.close());

const setNow = (tz, local) => {
  const f = () => localToUtc(tz, local);
  h.app.locals.timeclockNow = f;
  h.outer.locals.timeclockNow = f;
  h.outerNow = f;
};

// ======================= Pure: the margin of a visit =======================
const crownProfile = { supplies_cents: 4000, lab_mode: 'case', lab_cents: 22500, merchant_bp: 250, source: 'code' };
const crown = { id: 1, code: 'D2740', category: 'prosthodontics', fee: 135000, write_off: 50000, insurance: 42500, profile: crownProfile, lab_case_cents: 19800 };

test('margin: PPO write-off, insurance + patient, lab from the case, % of production after lab — to the cent', () => {
  const minutes = visitMinutes({ start_time: '2031-03-04 09:00', end_time: '2031-03-04 10:30', pattern: '//XXXXXX//' });
  assert.deepEqual(minutes, { chair: 90, doctor: 50, provider: 50, assistant: 40 }, 'the pattern is fitted to 90 minutes: //XXXXX// = 50 doctor minutes');
  const m = visitMargin({ procedures: [crown], minutes, pay: { basis: 'production_pct', pct_bp: 3000, lab_deducted: 1 }, overheadPerHour: 18000 });
  const l = m.lines[0];
  assert.equal(l.allowed, 85000, 'fee after the PPO write-off');
  assert.equal(l.patient, 42500);
  assert.equal(l.expected, 85000, 'insurance 425.00 + patient 425.00');
  assert.equal(l.lab, 19800, 'the linked lab case beats the estimate');
  assert.equal(l.lab_source, 'case');
  assert.equal(l.merchant, 1063, '2.5% of the patient’s 425.00 = 10.625 → 10.63');
  assert.equal(l.pay, 19560, '30% of (850.00 − 198.00 lab)');
  assert.equal(m.costs, 19800 + 4000 + 1063 + 19560);
  assert.equal(m.margin, 40577);
  assert.equal(m.margin_per_chair_hour, 27051, '405.77 × 60 / 90');
  assert.equal(m.margin_per_doctor_hour, 48692, '405.77 × 60 / 50');
  assert.equal(m.overhead, 27000, '$180 an hour for 1.5 hours');
  assert.equal(m.profit, 13577);
  assert.equal(m.profit_per_hour, 9051);
  // No lab case: the profile's estimate.
  const est = visitMargin({ procedures: [{ ...crown, lab_case_cents: null }], minutes, pay: { basis: 'none' } });
  assert.equal(est.lab, 22500);
  assert.equal(est.lines[0].lab_source, 'estimate');
  assert.equal(est.pay, 0, 'owner not paid per visit');
});

test('margin: patient portion collection rate, % of collections, and no insurance', () => {
  const minutes = { chair: 60, doctor: 30, provider: 30 };
  const m = visitMargin({ procedures: [crown], minutes, pay: { basis: 'collections_pct', pct_bp: 2500 }, settings: { patient_collect_bp: 9500 } });
  assert.equal(m.lines[0].patient_expected, 40375, '95% of 425.00');
  assert.equal(m.uncollected, 2125);
  assert.equal(m.expected, 82875);
  assert.equal(m.merchant, 1009, '2.5% of 403.75 = 10.09375');
  assert.equal(m.pay, 20719, '25% of 828.75 = 207.1875');
  assert.equal(m.margin, 82875 - 19800 - 4000 - 1009 - 20719);
  // No insurance: the office fee, all from the patient, the default card fee.
  const cash = visitMargin({ procedures: [{ id: 2, code: 'D2391', category: 'restorative', fee: 20000, write_off: 0, insurance: 0, profile: { supplies_cents: 2500, lab_mode: 'none' } }], minutes: { chair: 40, doctor: 40, provider: 40 } });
  assert.equal(cash.expected, 20000);
  assert.equal(cash.merchant, 500, 'the practice’s default 2.5%');
  assert.equal(cash.margin, 20000 - 2500 - 500);
});

test('margin: hourly provider pay from the time clock rate × their time, split across procedures to the cent', () => {
  const procs = [
    { id: 1, code: 'D1110', category: 'preventive', fee: 11000, write_off: 3000, insurance: 8000, profile: { supplies_cents: 800 } },
    { id: 2, code: 'D0120', category: 'diagnostic', fee: 6500, write_off: 1500, insurance: 5000, profile: { supplies_cents: 300 } },
    { id: 3, code: 'D0274', category: 'diagnostic', fee: 7000, write_off: 2000, insurance: 5000, profile: { supplies_cents: 300 } },
  ];
  const minutes = visitMinutes({ start_time: '2031-03-04 13:00', end_time: '2031-03-04 13:50', provider_type: 'hygienist' });
  assert.deepEqual(minutes, { chair: 50, doctor: 0, provider: 50, assistant: 0 });
  const m = visitMargin({ procedures: procs, minutes, pay: { basis: 'hourly', hourly_cents: null }, hourlyRate: 4700, providerType: 'hygienist' });
  assert.equal(m.hourly_pay, 3917, '$47/h × 50 min = 39.1666 → 39.17');
  assert.equal(m.pay, 3917, 'the parts add up exactly');
  assert.deepEqual(m.lines.map((l) => l.pay), allocate(3917, [8000, 5000, 5000]));
  assert.equal(m.margin_per_doctor_hour, null, 'hygiene visits have no doctor-hour');
  assert.equal(m.merchant, 0, 'insurance pays it all: no card fee');
  // A plan's own hourly figure wins over the clock rate; no rate at all is said, not guessed.
  assert.equal(visitMargin({ procedures: procs, minutes, pay: { basis: 'hourly', hourly_cents: 6000 }, hourlyRate: 4700 }).pay, 5000);
  const none = visitMargin({ procedures: procs, minutes, pay: { basis: 'hourly' }, hourlyRate: null });
  assert.equal(none.pay, 0);
  assert.match(none.notes.join(' '), /No hourly rate/);
});

test('margin: a per-code pay override, rounding of negative margins, and adding visits up', () => {
  const minutes = { chair: 30, doctor: 30, provider: 30 };
  const implant = { id: 9, code: 'D6010', category: 'implants', fee: 200000, write_off: 0, insurance: 0, profile: { supplies_cents: 25000, lab_mode: 'case', lab_cents: 35000, merchant_bp: 0, pay_pct_bp: 3500 } };
  const m = visitMargin({ procedures: [implant], minutes, pay: { basis: 'production_pct', pct_bp: 3000 } });
  assert.equal(m.pay, 70000, 'implants pay 35% here, not the usual 30%');
  const loss = visitMargin({ procedures: [{ id: 3, code: 'D0140', category: 'diagnostic', fee: 1001, write_off: 0, insurance: 0, profile: { supplies_cents: 2002, merchant_bp: 0 } }], minutes: { chair: 45, doctor: 45 } });
  assert.equal(loss.margin, -1001);
  assert.equal(loss.margin_per_chair_hour, -1335, '−10.01 × 60/45 = −13.3466 → −13.35 (half away from zero)');
  assert.equal(rnd(-2.5), -3);
  const t = addUp([m, loss]);
  assert.equal(t.visits, 2);
  assert.equal(t.margin, m.margin + loss.margin);
  assert.equal(t.chair_minutes, 75);
  assert.equal(t.margin_per_chair_hour, rnd(((m.margin + loss.margin) * 60) / 75));
  assert.equal(t.overhead, null, 'no fixed costs known → no profit');
});

test('cost profiles: the version in effect on the date of service, code before category, retired, typical', () => {
  const profiles = [
    { scope: 'category', scope_key: 'restorative', version_no: 1, effective_from: '2026-01-01', active: 1, supplies_cents: 2000 },
    { scope: 'code', scope_key: 'D2391', version_no: 1, effective_from: '2026-03-01', active: 1, supplies_cents: 3000 },
    { scope: 'code', scope_key: 'D2391', version_no: 2, effective_from: '2026-05-01', active: 1, supplies_cents: 3500 },
    { scope: 'code', scope_key: 'D2391', version_no: 3, effective_from: '2026-05-01', active: 1, supplies_cents: 3600 },
    { scope: 'code', scope_key: 'D2391', version_no: 4, effective_from: '2026-07-01', active: 0, supplies_cents: 0 },
  ];
  const p = { code: 'D2391', category: 'restorative' };
  assert.equal(resolveProfile(profiles, p, '2025-12-31').source, 'typical');
  assert.equal(resolveProfile(profiles, p, '2025-12-31').supplies_cents, CATEGORY_DEFAULTS.restorative.supplies_cents);
  assert.equal(resolveProfile(profiles, p, '2026-02-01').supplies_cents, 2000);
  assert.equal(resolveProfile(profiles, p, '2026-02-01').source, 'category');
  assert.equal(resolveProfile(profiles, p, '2026-03-01').supplies_cents, 3000);
  assert.equal(resolveProfile(profiles, p, '2026-06-01').supplies_cents, 3600, 'same start date: the later version wins');
  assert.equal(resolveProfile(profiles, p, '2026-08-01').supplies_cents, 2000, 'the code’s profile was retired: back to the category');
  const plans = [{ provider_id: 7, version_no: 1, effective_from: '2026-01-01', basis: 'production_pct', pct_bp: 3000 }, { provider_id: 7, version_no: 2, effective_from: '2026-06-01', basis: 'collections_pct', pct_bp: 3200 }];
  assert.equal(resolvePay(plans, 7, '2026-05-31').pct_bp, 3000);
  assert.equal(resolvePay(plans, 7, '2026-06-01').basis, 'collections_pct');
  assert.equal(resolvePay(plans, 8, '2026-06-01').basis, 'none');
});

test('bands: red below fixed cost per hour, then amber, green, gold; owner thresholds; doctor-hour basis', () => {
  const t = thresholdsFor({}, 18000);
  assert.deepEqual(t, { red_below: 18000, green_from: 27000, gold_from: 45000 });
  assert.deepEqual([17999, 18000, 26999, 27000, 44999, 45000].map((v) => bandFor(v, t)), ['red', 'amber', 'amber', 'green', 'green', 'gold']);
  assert.equal(bandFor(null, t), 'none');
  assert.deepEqual(thresholdsFor({ red_below_cents: 20000, green_from_cents: 30000, gold_from_cents: 60000 }, 18000), { red_below: 20000, green_from: 30000, gold_from: 60000 });
  assert.equal(thresholdsFor({}, null).red_below, 18000, 'no finance data: the typical figure');
  assert.equal(bandValue({ margin_per_chair_hour: 100, margin_per_doctor_hour: 300 }, 'doctor'), 300);
  assert.equal(bandValue({ margin_per_chair_hour: 100, margin_per_doctor_hour: null }, 'doctor'), 100, 'hygiene falls back to chair-hours');
});

// ======================= Pure: labor =======================
test('labor: overtime past the weekly 40 and the daily 8, so far and projected, with the premium', () => {
  assert.deepEqual(splitSegment(120, { todayBefore: 420, settings: { ot_weekly: 0, ot_daily: 1, ot_daily_minutes: 480 } }), { regular: 60, overtime: 60, doubletime: 0 });
  assert.deepEqual(splitSegment(120, { todayBefore: 660, settings: { ot_weekly: 0, ot_daily: 1, dt_daily: 1 } }), { regular: 0, overtime: 60, doubletime: 60 });
  assert.deepEqual(splitSegment(300, { weekRegularBefore: 2280 }), { regular: 120, overtime: 180, doubletime: 0 });
  assert.deepEqual(splitSegment(300, { weekRegularBefore: 2280, exempt: true }), { regular: 300, overtime: 0, doubletime: 0 });
  // 32 h this week already; clocked in 5 h 05 so far today; 3 h still to go.
  const l = laborDay({ running: 305, remaining: 180, weekRegularBefore: 1920, rate: 2400 });
  assert.deepEqual([l.so_far.regular, l.so_far.overtime, l.so_far.cost], [305, 0, 12200]);
  assert.deepEqual([l.projected.regular, l.projected.overtime], [480, 5]);
  assert.equal(l.projected.cost, 19500, '(480 + 5 × 1.5) min × $24/h');
  assert.equal(l.projected.overtime_premium, 100, 'the extra half for 5 minutes');
  // Closed punches today are already classified by the payroll; a missing rate means no cost, not zero.
  const c = laborDay({ closedToday: { regular: 240, overtime: 0, doubletime: 0 }, remaining: 240, rate: null });
  assert.equal(c.projected.minutes, 480);
  assert.equal(c.projected.cost, null);
  assert.deepEqual(awayState([720], { start: 480, end: 1020, break_minutes: 60 }), { left: false, back_at: 780 }, 'out at noon on a shift to 5 pm: at lunch');
  assert.deepEqual(awayState([990], { start: 480, end: 1020, break_minutes: 60 }), { left: true, back_at: null });
  assert.deepEqual(awayState([720, null], null), { left: false, back_at: null });
});

test('overtime risk: when someone passes 40 hours today and what it costs', () => {
  const r = overtimeRisk({ nowMin: 780, weekMinutes: 2225, todayMinutes: 305, remaining: 180, rate: 2400 });
  assert.deepEqual(r, { kind: 'weekly', at: 955, minutes: 5, premium: 100 });
  assert.equal(overtimeRisk({ nowMin: 780, weekMinutes: 1000, todayMinutes: 300, remaining: 180 }), null);
  assert.equal(overtimeRisk({ nowMin: 780, weekMinutes: 2300, todayMinutes: 300, remaining: 180, exempt: true }), null);
  const d = overtimeRisk({ nowMin: 780, weekMinutes: 600, todayMinutes: 420, remaining: 120, settings: { ot_daily: 1 } });
  assert.deepEqual([d.kind, d.at, d.minutes], ['daily', 840, 60]);
});

// ======================= Pure: who is doing what =======================
test('staff lanes: in a visit, assisting (linked and pooled), breaks, idle, absent; productivity and production supported', () => {
  const visits = [
    { id: 1, provider_id: 10, operatory_id: 1, start: 540, end: 630, pattern: '//XXXXX//', provider_kind: 'doctor', production: 135000 },
    { id: 2, provider_id: 11, operatory_id: 3, start: 540, end: 600, provider_kind: 'hygiene', production: 20000 },
  ];
  const people = [
    { user_id: 1, name: 'Dr. Lee', kind: 'doctor', provider_ids: [10], operatory_ids: [], shift: { start: 480, end: 720 }, punches: [{ in: 480, out: null }], breaks: [] },
    { user_id: 2, name: 'Amy', kind: 'assistant', provider_ids: [], operatory_ids: [], pooled: true, shift: { start: 480, end: 720 }, punches: [{ in: 475, out: null }], breaks: [{ start: 630, end: 645, paid: true }] },
    { user_id: 3, name: 'Bo', kind: 'assistant', provider_ids: [], operatory_ids: [], pooled: true, shift: { start: 480, end: 720 }, punches: [{ in: 480, out: null }], breaks: [] },
    { user_id: 4, name: 'Hana', kind: 'hygienist', provider_ids: [11], operatory_ids: [], shift: { start: 480, end: 720 }, punches: [], breaks: [] },
    { user_id: 5, name: 'Fran', kind: 'admin', provider_ids: [], operatory_ids: [], shift: { start: 480, end: 600 }, punches: [{ in: 480, out: 600 }], breaks: [], left: true },
  ];
  const t = staffTimeline({ people, visits, now: 660, dayStart: 450, dayEnd: 720 });
  const by = Object.fromEntries(t.map((x) => [x.name, x]));
  // The doctor is in the visit only for its X time (9:20–10:10), idle in the assistant time around it.
  assert.equal(by['Dr. Lee'].so_far.productive_minutes, 50);
  assert.equal(by['Dr. Lee'].so_far.working_minutes, 180);
  assert.equal(by['Dr. Lee'].so_far.productivity_pct, 27.8);
  assert.equal(by['Dr. Lee'].so_far.production_supported, 75000, '50 of the 90 minutes of $1,350');
  // Two shared assistants, one doctor chair: the first one in assists the whole visit, the other is idle.
  assert.equal(by.Amy.so_far.productive_minutes, 90);
  assert.equal(by.Amy.so_far.break_minutes, 15);
  assert.equal(by.Amy.so_far.paid_minutes, 185, 'clocked in 7:55 to 11:00, the paid 15-minute break included');
  assert.equal(by.Amy.so_far.production_supported, 135000);
  assert.equal(by.Bo.so_far.productive_minutes, 0);
  assert.equal(by.Bo.so_far.idle_minutes, 180);
  assert.equal(by.Bo.so_far.productivity_pct, 0);
  // Scheduled but never clocked in; the plan ahead still counts them.
  assert.equal(by.Hana.so_far.absent_minutes, 180);
  assert.equal(by.Hana.so_far.paid_minutes, 0);
  assert.equal(by.Hana.day.paid_minutes, 60, 'expected 11:00–12:00');
  // Front office: admin time, no productivity % (it isn't measured against the schedule).
  assert.equal(by.Fran.so_far.admin_minutes, 120);
  assert.equal(by.Fran.so_far.productivity_pct, null);
  assert.equal(by.Fran.day.paid_minutes, 120, 'clocked out for the day');
  // Idle gaps of 20 minutes or more; the one still ahead is "upcoming".
  assert.deepEqual(by.Bo.gaps.map((g) => [g.start, g.end, g.upcoming]), [[480, 720, true]]);
  assert.deepEqual(by.Amy.gaps.map((g) => [g.start, g.end]), [[475, 540], [645, 720]]);
  const segs = by.Amy.segments.filter((s) => s.state === 'assisting');
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.visit_id]), [[540, 630, 1]]);
  // A linked assistant covers their doctor's chair; the pool then isn't needed there.
  const linked = staffTimeline({ people: [{ ...people[1], pooled: false, provider_ids: [10] }, people[2]], visits, now: 660, dayStart: 450, dayEnd: 720 });
  assert.equal(linked[0].so_far.productive_minutes, 90);
  assert.equal(linked[1].so_far.productive_minutes, 0);
});

test('idle suggestions: fill from the ASAP list, send home early (with the saving), move lunch', () => {
  const person = { name: 'Amy Hygienist', kind: 'hygienist', shift: { start: 480, end: 1020, break_minutes: 60 } };
  const s = suggestionsFor({ start: 780, end: 1020, minutes: 240, upcoming: true, nowMin: 780 }, { person, asapCount: 3, rate: 2400 });
  assert.deepEqual(s.map((x) => x.kind), ['fill', 'send_home', 'move_lunch']);
  assert.equal(s[1].text, 'Send Amy home at 1 pm — saves about $96');
  assert.deepEqual(suggestionsFor({ start: 780, end: 1020, upcoming: true, nowMin: 780 }, { person: { ...person, kind: 'assistant' }, asapCount: 3 }).map((x) => x.kind), ['send_home', 'move_lunch'], 'an idle assistant is a staffing question, not a booking one');
  assert.equal(s[1].saves, 9600);
  assert.equal(s[2].text, 'Move Amy’s lunch to 1 pm–2 pm');
  assert.equal(s[0].text, 'Fill 1 pm–5 pm from the ASAP list (3 waiting)');
  assert.deepEqual(suggestionsFor({ start: 600, end: 640, upcoming: false }, { person }), [], 'nothing to do about the past');
  assert.equal(suggestionsFor({ start: 900, end: 930, upcoming: true, nowMin: 780 }, { person: { ...person, kind: 'assistant' }, rate: null })[0].kind, 'other');
});

test('staffing vs demand: assistants per busy doctor chair by hour, and the advice in plain words', () => {
  const tl = [
    { kind: 'assistant', segments: [{ start: 840, end: 960, state: 'idle' }] },
    { kind: 'assistant', segments: [{ start: 840, end: 960, state: 'assisting' }] },
    { kind: 'doctor', segments: [{ start: 840, end: 960, state: 'in_visit' }] },
  ];
  const visits = [{ provider_kind: 'doctor', start: 840, end: 960 }];
  const rows = staffingByHour({ timeline: tl, visits, dayStart: 780, dayEnd: 1020 });
  assert.deepEqual(rows.map((r) => [r.hour, r.doctor_chairs, r.assistants, r.status]), [[780, 0, 0, 'ok'], [840, 1, 2, 'over'], [900, 1, 2, 'over'], [960, 0, 0, 'ok']]);
  const advice = staffingAdvice(rows);
  assert.equal(advice.length, 1);
  assert.equal(advice[0].text, '2 assistants for 1 doctor chair from 2 pm–4 pm: someone could take lunch then, make recall calls, or go home early.');
  const under = staffingAdvice(staffingByHour({ timeline: [tl[1]], visits: [...visits, { provider_kind: 'doctor', start: 840, end: 900 }, { provider_kind: 'doctor', start: 840, end: 900 }], dayStart: 840, dayEnd: 900 }));
  assert.match(under[0].text, /^1 assistant for 3 doctor chairs from 2 pm–3 pm: the doctor will be waiting/);
});

// ======================= Pure: exams, what-if, trends =======================
test('exams: one per patient per day by type, today vs target, and what they support vs the goal', () => {
  const counts = countExams([
    { patient_id: 1, date: '2031-03-04', code: 'D0150' }, { patient_id: 1, date: '2031-03-04', code: 'D0120' },
    { patient_id: 2, date: '2031-03-04', code: 'D0120' }, { patient_id: 3, date: '2031-03-04', code: 'D0140' }, { patient_id: 3, date: '2031-03-04', code: 'D9110' },
    { patient_id: 4, date: '2031-03-04', code: 'D0180' }, { patient_id: 5, date: '2031-03-04', code: 'D1110' },
  ]);
  assert.deepEqual(counts, { new_patient: 1, recall: 1, emergency: 1, perio: 1 });
  const t = examTargets(counts, { new_patient: 3, recall: 1 });
  assert.deepEqual(t.find((x) => x.type === 'new_patient'), { type: 'new_patient', label: 'New patient', count: 1, target: 3, status: 'short', short_by: 2 });
  assert.equal(t.find((x) => x.type === 'recall').status, 'met');
  assert.equal(t.find((x) => x.type === 'perio').status, null, 'no target set');

  const s = examSupport({ counts: { new_patient: 10, recall: 60, emergency: 0 }, values: { new_patient: 140000, recall: 40000, emergency: 90000 }, goal: 5000000, label: 'This month’s' });
  assert.equal(s.supported, 3800000);
  assert.equal(s.shortfall, 1200000);
  assert.equal(s.pct, 76);
  assert.deepEqual(s.options.map((o) => [o.type, o.needed]), [['new_patient', 9], ['recall', 30]], 'the exams a practice can book more of, not emergencies');
  const s2 = examSupport({ counts: { new_patient: 10, recall: 60 }, values: { new_patient: 140000, recall: 40000 }, goal: 5000000, label: 'This month’s' });
  assert.equal(s2.text, 'This month’s exams support about $38k of the $50k goal: add ~9 new patient exams or ~30 recall exams.');
  assert.equal(examSupport({ counts: { recall: 2 }, values: { recall: 40000 }, goal: 50000, label: 'Today’s' }).text, 'Today’s exams support about $800 of future production — at or above the $500 goal.');
  assert.equal(examSupport({ counts: { recall: 1 }, values: { recall: 40000 }, label: 'Today’s' }).text, 'Today’s exams support about $400 of future production.');
  assert.equal(scaleExamValue('new_patient', 200000, 5), 200000);
  assert.equal(scaleExamValue('new_patient', 140000, 1), TYPICAL_EXAM_VALUES[1].new_patient);
  assert.equal(scaleExamValue('recall', 80000, 3), 60000);
});

test('what if: raising a fee only helps where the PPO doesn’t cap it; dropping a plan; supplies from finance', () => {
  const r = whatIfFee([{ fee: 100000, allowed: 70000, ppo_allowed: 70000 }, { fee: 100000, allowed: 100000, ppo_allowed: null }, { fee: 100000, allowed: 100000, ppo_allowed: 120000 }], 1000);
  assert.deepEqual(r, { before: 270000, after: 70000 + 110000 + 110000, change: 20000 });
  const d = whatIfDropPlan({ plan: { write_off: 100000, margin: 200000, chair_minutes: 600 }, others: { margin: 600000, chair_minutes: 1200 }, retentionPct: 70, refillPct: 50 });
  assert.deepEqual(d, { recaptured_write_offs: 70000, lost_margin: 60000, refilled_margin: 45000, change: 55000, freed_hours: 3 });
  const s = suggestSupplies({ restorative: 100, preventive: 100 }, 660000);
  assert.equal(s.ratio, 2);
  assert.equal(s.categories.restorative.supplies_cents, 5000);
  assert.equal(suggestSupplies({}, 0).basis, 'typical');
  const row = trendRow({ production: 400000, collections: 380000, labor_cost: 110000, paid_minutes: 1200, productive_minutes: 600, clinical_minutes: 900, idle_minutes: 90 });
  assert.deepEqual([row.labor_pct_production, row.labor_pct_collections, row.production_per_labor_hour, row.productivity_pct, row.idle_hours], [27.5, 28.9, 20000, 66.7, 1.5]);
});

test('what staff may see: pay folded out of every breakdown without timeclock:rates', () => {
  const m = visitMargin({ procedures: [crown], minutes: { chair: 90, doctor: 50, provider: 50 }, pay: { basis: 'production_pct', pct_bp: 3000 } });
  const shown = shapeMargin(m, { rates: false });
  assert.equal(shown.pay, undefined);
  assert.equal(shown.pay_basis, undefined);
  assert.ok(shown.lines.every((l) => !('pay' in l)));
  assert.equal(shown.margin, m.margin, 'the margin still counts it');
  assert.equal(shown.pay_hidden, true);
  assert.equal(shapeMargin(m, { rates: true }).pay, m.pay);
  assert.equal(DEFAULT_SETTINGS.labor_target_high_bp, 3000);
});

// ======================= Through the API =======================
const DAY = '2031-03-04'; // a Tuesday
const TZ = 'UTC';
async function person(api, name, role, extra = {}) {
  const email = `${name.replace(/\W/g, '').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = await api.post('/users', { email, name, role, password: 'correct-horse-battery', ...extra });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  const login = await h.client(undefined, { 'X-Forwarded-For': `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { ...u.data, client: h.client(login.data.token) };
}
async function office() {
  const p = await h.practice({ timezone: TZ });
  const pid = (await h.db.get('SELECT practice_id FROM users WHERE email = ?', p.email)).practice_id;
  const chairs = (await p.api.get('/operatories?active=true')).data;
  // A PPO paying $850 for a crown (office fee $1,350), 50% for major work, no deductible.
  const fs = await h.db.get("INSERT INTO fee_schedules (practice_id, name, kind) VALUES (?, 'Delta PPO', 'ppo') RETURNING id", pid);
  await h.db.run("INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, 'D2740', 85000), (?, 'D0120', 5000)", fs.id, fs.id);
  const carrier = await h.db.get("INSERT INTO insurance_carriers (practice_id, name, fee_schedule_id) VALUES (?, 'Delta PPO', ?) RETURNING id", pid, fs.id);
  await h.db.run(`INSERT INTO patient_insurance (practice_id, patient_id, carrier_id, priority, subscriber_name, subscriber_id, relationship, annual_max, deductible, pct_preventive, pct_basic, pct_major, active)
    VALUES (?, ?, ?, 'primary', 'Jane Doe', 'W1', 'self', 500000, 0, 100, 80, 50, 1)`, pid, p.patient.id, carrier.id);
  return { ...p, pid, chairs, carrierId: carrier.id };
}
async function book(o, { start, end, code, pattern, tooth, providerId, chair }) {
  const a = await o.api.post('/appointments', {
    patient_id: o.patient.id, provider_id: providerId || o.provider.id, operatory_id: chair || o.chairs[0].id, start_time: `${DAY} ${start}`, end_time: `${DAY} ${end}`,
    override_blockout: true, notify: false, add_type_procedures: false, ...(pattern ? { pattern } : {}),
  });
  assert.ok(a.data.id, JSON.stringify(a.data));
  const pr = code ? await o.api.post(`/patients/${o.patient.id}/procedures`, { code, appointment_id: a.data.id, provider_id: providerId || o.provider.id, ...(tooth ? { tooth } : {}) }) : null;
  if (code) assert.ok(pr.data.id, JSON.stringify(pr.data));
  return { appt: a.data, proc: pr?.data };
}

let o; // the office most tests share
let crownVisit;
let amy; let bo; let fran; let desk; let mgr;
test('setup: an office with a crown visit, a PPO, a lab case, staff with shifts, rates and punches', async () => {
  await startOuter();
  setNow(TZ, `${DAY} 07:00`);
  o = await office();
  crownVisit = await book(o, { start: '09:00', end: '10:30', code: 'D2740', tooth: '3', pattern: '//XXXXXX//' });
  await h.db.run("INSERT INTO lab_cases (practice_id, patient_id, provider_id, lab_name, description, status, cost, procedure_id) VALUES (?, ?, ?, 'Smile Lab', 'Crown #3', 'sent', 19800, ?)", o.pid, o.patient.id, o.provider.id, crownVisit.proc.id);
  amy = await person(o.api, 'Amy Assist', 'assistant');
  bo = await person(o.api, 'Bo Assist', 'assistant');
  fran = await person(o.api, 'Fran Desk', 'front_desk');
  desk = await person(o.api, 'Dee Desk', 'front_desk');
  mgr = await person(o.api, 'Gil Manager', 'front_desk', { permissions_add: ['timeclock:manage'] });
  for (const [u, rate] of [[amy, 2400], [bo, 2000], [fran, 2200]]) assert.equal((await o.api.put(`/timeclock/staff/${u.id}`, { hourly_rate_cents: rate, reason: 'Pay rate' })).status, 200);
  for (const u of [amy, bo]) assert.equal((await o.api.put('/timeclock/shifts', { user_id: u.id, date: DAY, start_time: '08:00', end_time: '17:00', break_minutes: 60 })).status, 200);
  assert.equal((await o.api.put('/timeclock/shifts', { user_id: fran.id, date: DAY, start_time: '08:00', end_time: '12:00' })).status, 200);
  setNow(TZ, `${DAY} 13:00`);
  // Amy worked 16-hour days on Sunday and Monday (32 h this week), and is in since 7:55; Bo clocked out at noon for
  // lunch; Fran (front desk) is still in past her shift.
  for (const d of ['2031-03-02', '2031-03-03']) assert.equal((await o.api.post('/timeclock/punches', { user_id: amy.id, clock_in: `${d} 06:00`, clock_out: `${d} 22:00`, reason: 'Paper timesheet' })).status, 201);
  assert.equal((await o.api.post('/timeclock/punches', { user_id: amy.id, clock_in: `${DAY} 07:55`, reason: 'Forgot to punch' })).status, 201);
  assert.equal((await o.api.post('/timeclock/punches', { user_id: bo.id, clock_in: `${DAY} 08:00`, clock_out: `${DAY} 12:00`, reason: 'Forgot to punch' })).status, 201);
  assert.equal((await o.api.post('/timeclock/punches', { user_id: fran.id, clock_in: `${DAY} 08:00`, reason: 'Forgot to punch' })).status, 201);
});

test('PM1: cost profiles are versions, never overwritten; the same save twice is one version; audited', async () => {
  const body = { scope: 'code', scope_key: 'D2740', supplies_cents: 3000, lab_mode: 'case', lab_cents: 22500, merchant_bp: 250, effective_from: '2031-01-01', note: 'First go' };
  const v1 = await o.api.post('/business/cost-profiles', body);
  assert.equal(v1.status, 201, JSON.stringify(v1.data));
  assert.equal(v1.data.version_no, 1);
  const again = await o.api.post('/business/cost-profiles', body);
  assert.equal(again.status, 200);
  assert.equal(again.data.unchanged, true);
  const v2 = await o.api.post('/business/cost-profiles', { ...body, supplies_cents: 4000, effective_from: '2031-03-01', note: 'New supplier' });
  assert.equal(v2.data.version_no, 2);
  const list = (await o.api.get('/business/cost-profiles')).data;
  const d2740 = list.profiles.find((p) => p.scope_key === 'D2740');
  assert.equal(d2740.current.supplies_cents, 4000);
  assert.equal(d2740.versions, 2);
  assert.equal(list.history.filter((p) => p.scope_key === 'D2740').length, 2, 'the first version is still there');
  const rows = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'business.cost_profile' ORDER BY id", o.pid);
  assert.equal(rows.length, 2);
  assert.match(rows[1].changes, /"supplies_cents":\[3000,4000\]/);
  assert.equal(rows[1].reason, 'New supplier');
  // Bad input is refused.
  assert.equal((await o.api.post('/business/cost-profiles', { ...body, scope_key: 'D9999' })).status, 404);
  assert.equal((await o.api.post('/business/cost-profiles', { ...body, supplies_cents: -5 })).status, 400);
  assert.equal((await o.api.post('/business/cost-profiles', { ...body, lab_mode: 'maybe' })).status, 400);
  assert.equal((await o.api.post('/business/cost-profiles', { scope: 'category', scope_key: 'magic' })).status, 400);
  // The assistant may suggest costs but not save them without a yes.
  const ai = h.client(o.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post('/business/cost-profiles', { ...body, supplies_cents: 1 })).status, 428);
  // Suggestions come back (typical until finance data exists).
  const sug = (await o.api.get('/business/cost-profiles/suggestions')).data;
  assert.equal(sug.basis, 'typical');
  assert.ok(sug.categories.prosthodontics.lab_cents > 0);
  assert.deepEqual(sug.codes, [], 'no lab case has been done yet in the past year');
});

test('PM2/PM3: the schedule by margin — to the cent through the insurance estimate, the lab case and the pay plan', async () => {
  assert.equal((await o.api.post('/business/provider-pay', { provider_id: o.provider.id, basis: 'production_pct', pct_bp: 3000, lab_deducted: true, effective_from: '2031-01-01' })).status, 201);
  assert.equal((await o.api.put('/business/settings', { overhead_mode: 'manual', overhead_per_hour_cents: 18000, fixed_costs_month_cents: 1800000, work_days_month: 18 })).status, 200);
  const s = (await o.api.get(`/business/schedule?date=${DAY}`)).data;
  const v = s.visits[crownVisit.appt.id];
  assert.ok(v, JSON.stringify(s));
  assert.equal(v.fee, 135000);
  assert.equal(v.write_off, 50000, 'the PPO pays $850 of the $1,350 fee');
  assert.equal(v.insurance, 42500);
  assert.equal(v.expected, 85000);
  assert.equal(v.lab, 19800);
  assert.equal(v.supplies, 4000, 'the cost version in effect on the visit’s date');
  assert.equal(v.merchant, 1063);
  assert.equal(v.pay, 19560);
  assert.equal(v.margin, 40577);
  assert.equal(v.chair_minutes, 90);
  assert.equal(v.doctor_minutes, 50);
  assert.equal(v.margin_per_chair_hour, 27051);
  assert.equal(v.margin_per_doctor_hour, 48692);
  assert.equal(v.profit_per_hour, 9051);
  assert.equal(v.band, 'green', '$270.51 an hour: between 1.5× and 2.5× the $180 fixed cost');
  assert.equal(v.payer, 'Delta PPO');
  assert.equal(s.days[DAY].margin, 40577);
  assert.equal(s.columns.operatories[DAY][o.chairs[0].id].margin, 40577);
  // The owner's thresholds and the doctor-hour basis change the color, not the math.
  assert.equal((await o.api.put('/business/settings', { basis: 'doctor', gold_from_cents: 45000 })).status, 200);
  assert.equal((await o.api.get(`/business/schedule?date=${DAY}`)).data.visits[crownVisit.appt.id].band, 'gold');
  assert.equal((await o.api.put('/business/settings', { basis: 'chair', gold_from_cents: null })).status, 200);
  assert.equal((await o.api.put('/business/settings', { red_below_cents: 50000, green_from_cents: 40000 })).status, 400, 'thresholds must go up');
  assert.equal((await o.api.put('/business/settings', { labor_target_low_bp: 3500, labor_target_high_bp: 3000 })).status, 400);
  const audits = await h.db.all("SELECT changes FROM audit_log WHERE practice_id = ? AND action = 'business.settings' ORDER BY id", o.pid);
  assert.ok(audits.some((a) => /"basis":\["chair","doctor"\]/.test(a.changes)), 'before → after is kept');
  // A version from a later date doesn't reach back to this visit.
  assert.equal((await o.api.post('/business/cost-profiles', { scope: 'code', scope_key: 'D2740', supplies_cents: 9000, lab_mode: 'case', lab_cents: 22500, merchant_bp: 250, effective_from: '2031-04-01' })).status, 201);
  assert.equal((await o.api.get(`/business/schedule?date=${DAY}`)).data.visits[crownVisit.appt.id].supplies, 4000);
});

test('BD1: today — production, expected collections, direct costs, labor so far and projected with overtime, labor %', async () => {
  const t = (await o.api.get(`/business/today?date=${DAY}`)).data;
  assert.equal(t.production.scheduled, 135000, 'the production bar’s number');
  assert.equal(t.production.completed, 0);
  assert.equal(t.collections.expected, 85000);
  assert.equal(t.direct_costs.total, 19800 + 4000 + 1063 + 19560, 'the associate’s % pay is a direct cost (not on the clock)');
  // Amy: 305 min so far at $24 (12200); 3 h still to go after her lunch, 5 minutes of it overtime (19500 projected).
  // Bo: 4 h so far at $20 (8000), back from lunch at 1 pm for 4 h more (16000). Fran: in 5 h at $22 (11000), shift over.
  assert.equal(t.labor.so_far, 12200 + 8000 + 11000);
  assert.equal(t.labor.projected, 19500 + 16000 + 11000);
  assert.equal(t.labor.overtime_premium, 100);
  assert.equal(t.labor.pct_of_production, 34.4, '$465 of $1,350');
  assert.equal(t.labor.pct_of_collections, 54.7);
  assert.equal(t.labor.status, 'over', 'above the 25–30% target');
  assert.equal(t.overhead.fixed_today, 100000, '$18,000 a month over 18 days');
  assert.equal(t.contribution, 85000 - 44423 - 46500);
  assert.equal(t.profit, t.contribution - 100000);
  assert.equal(t.break_even.collections_needed, 44423 + 46500 + 100000);
  assert.ok(t.overtime.some((x) => x.name === 'Amy Assist' && x.at === 955 && x.minutes === 5 && x.premium === 100), JSON.stringify(t.overtime));
});

test('BD2/BD3: staff lanes — assisting vs idle, productivity, idle gaps with suggestions, staffing advice', async () => {
  const s = (await o.api.get(`/business/staff?date=${DAY}`)).data;
  const by = Object.fromEntries(s.people.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['Amy Assist', 'Bo Assist', 'Fran Desk']);
  assert.equal(by['Amy Assist'].kind, 'assistant');
  assert.equal(by['Amy Assist'].so_far.productive_minutes, 90, 'first one in: assisted the crown');
  assert.equal(by['Amy Assist'].so_far.working_minutes, 305);
  assert.equal(by['Amy Assist'].so_far.productivity_pct, 29.5);
  assert.equal(by['Amy Assist'].so_far.production_supported, 135000);
  assert.equal(by['Bo Assist'].so_far.productive_minutes, 0);
  assert.equal(by['Bo Assist'].status, 'away');
  assert.equal(by['Bo Assist'].back_at, 780);
  assert.equal(by['Fran Desk'].kind, 'admin');
  assert.equal(by['Fran Desk'].so_far.admin_minutes, 300);
  const amyGap = by['Amy Assist'].gaps.find((g) => g.upcoming);
  assert.deepEqual([amyGap.start, amyGap.end], [630, 1020]);
  assert.ok(amyGap.suggestions.some((x) => x.kind === 'send_home' && x.text === 'Send Amy home at 1 pm — saves about $96'), JSON.stringify(amyGap.suggestions));
  assert.equal(by['Amy Assist'].labor.projected, 19500);
  assert.ok(s.staffing.some((r) => r.hour === 540 && r.doctor_chairs === 1 && r.status === 'over'));
  assert.ok(s.advice.some((a) => a.status === 'over'));
});

test('BD4: trends and the drill-down behind them', async () => {
  const t = (await o.api.get(`/business/trends?from=2031-03-02&to=${DAY}&group=day`)).data;
  assert.equal(t.rows.length, 3);
  const mon = t.rows.find((r) => r.period === '2031-03-03');
  assert.equal(mon.paid_minutes, 960);
  assert.equal(mon.labor_cost, 38400, 'Amy’s 16 h at $24, all regular (weekly rule)');
  assert.equal(mon.production, 0);
  assert.equal(mon.labor_pct_production, null, 'no production: no percentage rather than infinity');
  const rows = (await o.api.get(`/business/trends/rows?metric=labor&from=2031-03-02&to=${DAY}`)).data;
  assert.ok(rows.some((r) => r.name === 'Amy Assist' && r.date === '2031-03-02' && r.cost === 38400));
  assert.equal((await o.api.get('/business/trends?from=2031-03-05&to=2031-03-01')).status, 400);
  assert.equal((await o.api.get('/business/trends/rows?metric=bogus&from=2031-03-02&to=2031-03-03')).status, 400);
});

test('PM4: margins by procedure and payer from completed work, least profitable under each PPO, what if', async () => {
  // Work is completed today (the real date): the pay plan and the crown's costs from before then.
  assert.equal((await o.api.post('/business/provider-pay', { provider_id: o.provider.id, basis: 'production_pct', pct_bp: 3000, lab_deducted: true, effective_from: '2020-01-01' })).status, 201);
  const done = await o.api.post(`/procedures/${crownVisit.proc.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const today = (await h.db.get('SELECT substr(completed_at, 1, 10) AS d FROM procedures WHERE id = ?', crownVisit.proc.id)).d;
  const q = `from=${today}&to=${today}`;
  const r = (await o.api.get(`/business/reports/margins?${q}&by=payer`)).data;
  const delta = r.rows.find((x) => x.label === 'Delta PPO');
  assert.ok(delta, JSON.stringify(r));
  assert.equal(delta.fee, 135000);
  assert.equal(delta.write_off, 50000, 'from the PPO’s fee on the date of service (fee resolver)');
  assert.equal(delta.lab, 19800);
  assert.equal(delta.chair_minutes, 90);
  assert.equal(r.least_profitable[0].payer, 'Delta PPO');
  assert.equal(r.least_profitable[0].procedures[0].key, 'D2740');
  const byProc = (await o.api.get(`/business/reports/margins?${q}&by=procedure`)).data;
  assert.equal(byProc.rows[0].key, 'D2740');
  // Raising the crown fee 10% changes nothing for this PPO patient: the plan caps it at $850.
  const fee = (await o.api.get(`/business/reports/what-if?${q}&kind=fee&code=D2740&pct_bp=1000`)).data;
  assert.equal(fee.change, 0, JSON.stringify(fee));
  const lab = (await o.api.get(`/business/reports/what-if?${q}&kind=lab&code=D2740&lab_cents=15000`)).data;
  assert.equal(lab.change, 4800 - rnd((4800 * 3000) / 10000), 'cheaper lab: $48 less cost, of which the associate gets 30% (their pay is after lab)');
  const drop = (await o.api.get(`/business/reports/what-if?${q}&kind=drop_plan&carrier_id=${o.carrierId}&retention=70&refill=50`)).data;
  assert.equal(drop.recaptured_write_offs, 35000);
  assert.equal((await o.api.get(`/business/reports/what-if?${q}&kind=lab`)).status, 400);
  assert.equal((await o.api.get(`/business/reports/margins?${q}&by=zodiac`)).status, 400);
});

test('EX: exams today vs target and the production they support', async () => {
  await book(o, { start: '11:00', end: '11:30', code: 'D0150' });
  assert.equal((await o.api.put('/business/exam-targets', { items: [{ exam_type: 'new_patient', daily_target: 2 }, { exam_type: 'recall', daily_target: 6, value_cents: 50000 }] })).status, 200);
  const e = (await o.api.get(`/business/exams?date=${DAY}`)).data;
  const np = e.today.find((x) => x.type === 'new_patient');
  assert.equal(np.count, 1);
  assert.equal(np.target, 2);
  assert.equal(np.status, 'short');
  assert.equal(e.horizon_months, 5);
  const todaySupport = e.support.find((x) => x.period === 'today');
  assert.ok(todaySupport.supported > 0);
  assert.match(todaySupport.text, /^Today’s exams support about \$/);
  assert.equal((await o.api.get(`/business/exams?date=${DAY}&horizon=4`)).status, 400);
  const one = (await o.api.get(`/business/exams?date=${DAY}&horizon=1`)).data;
  assert.equal(one.horizon_months, 1);
  // Anyone on the schedule sees the counts (huddle card) but not the dollars.
  const staffView = (await desk.client.get(`/business/exams?date=${DAY}`)).data;
  assert.ok(staffView.today.length);
  assert.equal(staffView.support, undefined);
  assert.equal(staffView.values, undefined);
});

test('permissions: staff see nothing; a manager sees the lanes without money; pay needs timeclock:rates', async () => {
  for (const path of [`/business/schedule?date=${DAY}`, `/business/today?date=${DAY}`, `/business/staff?date=${DAY}`, '/business/settings', '/business/cost-profiles',
    `/business/reports/margins?from=${DAY}&to=${DAY}`, `/business/trends?from=${DAY}&to=${DAY}`, '/business/provider-pay']) {
    assert.equal((await desk.client.get(path)).status, 403, path);
  }
  assert.equal((await desk.client.post('/business/cost-profiles', { scope: 'category', scope_key: 'preventive' })).status, 403);
  assert.equal((await desk.client.put('/business/settings', { basis: 'doctor' })).status, 403);
  assert.deepEqual((await desk.client.get('/business/access')).data, { view: false, manage: false, rates: false, lanes: false, exams: true });
  // The office manager (timeclock:manage) sees who's busy and idle — no dollars anywhere.
  const lanes = await mgr.client.get(`/business/staff?date=${DAY}`);
  assert.equal(lanes.status, 200);
  const text = JSON.stringify(lanes.data);
  for (const k of ['"labor"', 'production_supported', 'production_per_labor_hour', 'premium', 'idle_cost', 'missing_rate']) assert.ok(!text.includes(k), `${k} hidden`);
  assert.ok(lanes.data.people.find((p) => p.name === 'Amy Assist').so_far.productivity_pct != null);
  assert.equal((await mgr.client.get(`/business/today?date=${DAY}`)).status, 403);
  // Business view without pay rates (once business:view is in the permission catalog).
  if ('business:view' in PERMISSION_CATALOG) {
    const owner2 = await person(o.api, 'Olive Partner', 'dentist', { permissions_add: ['business:view'] });
    const s = (await owner2.client.get(`/business/schedule?date=${DAY}`)).data;
    const v = s.visits[crownVisit.appt.id];
    assert.equal(v.pay, undefined);
    assert.equal(v.pay_hidden, true);
    assert.equal(v.margin, 40577);
    const t = (await owner2.client.get(`/business/today?date=${DAY}`)).data;
    assert.equal(t.labor.hidden, true);
    assert.equal(t.labor.so_far, undefined);
    assert.equal(t.contribution, undefined);
    assert.equal((await owner2.client.get('/business/provider-pay')).status, 403);
    assert.equal((await owner2.client.post('/business/cost-profiles', { scope: 'category', scope_key: 'preventive', pay_pct_bp: 100 })).status, 403);
  }
});

test('isolation: another practice sees none of it; offices are checked', async () => {
  const other = await office();
  const s = (await other.api.get(`/business/schedule?date=${DAY}`)).data;
  assert.deepEqual(s.visits, {});
  const staff = (await other.api.get(`/business/staff?date=${DAY}`)).data;
  assert.deepEqual(staff.people, []);
  const profiles = (await other.api.get('/business/cost-profiles')).data;
  assert.deepEqual(profiles.profiles, []);
  // Someone else's office, provider or person is not found.
  const loc = await h.db.get("INSERT INTO locations (practice_id, name) VALUES (?, 'North') RETURNING id", o.pid);
  assert.equal((await other.api.get(`/business/schedule?date=${DAY}&location_id=${loc.id}`)).status, 404);
  assert.equal((await other.api.post('/business/provider-pay', { provider_id: o.provider.id, basis: 'none' })).status, 404);
  assert.equal((await other.api.put(`/business/staff-roles/${amy.id}`, { kind: 'admin' })).status, 404);
  // One office picked: visits elsewhere drop out.
  const south = await h.db.get("INSERT INTO locations (practice_id, name) VALUES (?, 'South') RETURNING id", o.pid);
  const inSouth = (await o.api.get(`/business/schedule?date=${DAY}&location_id=${south.id}`)).data;
  assert.deepEqual(inSouth.visits, {});
});

test('staff roles: link an assistant to a chair; it changes who assisted', async () => {
  const r = await o.api.put(`/business/staff-roles/${bo.id}`, { kind: 'assistant', operatory_ids: [o.chairs[0].id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = (await o.api.get(`/business/staff?date=${DAY}`)).data;
  const by = Object.fromEntries(s.people.map((p) => [p.name, p]));
  assert.equal(by['Bo Assist'].so_far.productive_minutes, 120, 'Bo works Op 1: the crown (90 min) and the new patient exam (30 min)');
  assert.equal(by['Amy Assist'].so_far.productive_minutes, 0, 'the pool wasn’t needed there');
  assert.equal((await o.api.put(`/business/staff-roles/${bo.id}`, { kind: 'wizard' })).status, 400);
  const audit = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'business.staff_role'", o.pid);
  assert.ok(audit);
});

test('end-of-day email: the owner gets the day’s business numbers; staff get nothing', async () => {
  const admin = await h.db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", o.pid);
  const blocks = await businessDigestBlocks(h.db, { practiceId: o.pid, userId: admin.id, date: DAY, nowMs: localToUtc(TZ, `${DAY} 13:00`) });
  assert.equal(blocks[0].text, 'The business side of the day');
  assert.match(blocks[1].text, /labor \$465 = [\d.]+% of production \(target 25–30%\)/);
  assert.deepEqual(await businessDigestBlocks(h.db, { practiceId: o.pid, userId: desk.id, date: DAY }), []);
  assert.deepEqual(await businessDigestBlocks(h.db, { practiceId: o.pid + 999, userId: admin.id, date: DAY }), [], 'another practice’s user');
});
