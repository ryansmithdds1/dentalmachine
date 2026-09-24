// Today's schedule optimizer (OPT1–OPT4, docs/workflows/specs/OPT-optimizer.md). First the engine on plain rows:
// each generator, what fits and what doesn't (hours, visits, blocks, kept perfect-day blocks, chairs, the patient,
// preferences, the right kind of provider), the $ math, family detection, the shorten rule (not when the work
// justifies the time), the no-show rule, and the plan (reaches goal with the fewest moves, never two things in one
// place). Then through the routes on a real database: validateAppt has the last word, actions go through the
// existing endpoints once (double clicks and retries), undo, decline, text offers and their YES, $ hidden without
// billing access, practice and office isolation, permissions, and the AI note (sandbox; nothing about a patient
// beyond first name and last initial).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import {
  procMinutes, canPlace, openGaps, goalGaps, treatmentOpportunities, finderOpportunities, familyOpportunities, fillOpportunities,
  shortenOpportunities, confirmOpportunities, generate, solve, optimizeDay, uses, OPTIMIZER_SCHEMA, OPTIMIZER_COLUMNS, huddlePlan,
} from '../src/optimizer.js';
import { aiInput, explainPlan, cleanAnswer } from '../src/ai/optimizerExplain.js';
import optimizerRoutes from '../src/routes/optimizer.js';
import { riskOf as aiRisk } from '../src/aiguard.js';
import { insert, practiceNow } from '../src/util.js';
import { offerFor, claimOffer } from '../src/fill.js';

// ---- The engine, on plain rows ----
const DATE = '2030-06-05'; // a Wednesday
const H = (h, m = 0) => h * 60 + m;
function mkDay(extra = {}) {
  return {
    date: DATE, nowMin: 0,
    providers: [
      { id: 1, name: 'Dr. Chen', type: 'dentist', kind: 'doctor', hours: [[H(8), H(17)]], goal: 500000, scheduled: 300000 },
      { id: 2, name: 'Hal RDH', type: 'hygienist', kind: 'hygiene', hours: [[H(8), H(17)]], goal: 150000, scheduled: 100000 },
    ],
    chairs: [{ id: 11, name: 'Op 1', default_provider_id: 1, is_hygiene: 0 }, { id: 12, name: 'Hyg 1', default_provider_id: 2, is_hygiene: 1 }, { id: 13, name: 'Op 3', default_provider_id: null, is_hygiene: 0 }],
    visits: [], busy: [], blockouts: [], kept: [], types: {}, planned: [], finder: [], family: [], asap: [], waitlist: [], recallDue: [], noShow: {},
    ...extra,
  };
}
let vid = 100;
const pt = (id, first = 'Maria', last = 'Lopez', guarantor = null) => ({ id, first_name: first, last_name: last, guarantor_id: guarantor });
const visit = (o) => ({
  id: ++vid, patient: pt(1), provider_id: 1, operatory_id: 11, s: H(9), e: H(10), status: 'confirmed', type_id: null, usual: null,
  procedures: [], fee: 0, confirmed: true, here: true, ...o,
});
// A day with every hour of both providers booked except what's left open on purpose.

describe('the engine (pure)', () => {
  test('how long work takes: the code’s time units, else a typical time for the code, else for its category', () => {
    assert.equal(procMinutes({ code: 'D2740', category: 'prosthodontics', time_units: 9 }), 90);
    assert.equal(procMinutes({ code: 'D1206', category: 'preventive' }), 5);
    assert.equal(procMinutes({ code: 'D2391', category: 'restorative' }), 45);
    assert.equal(procMinutes({ code: 'D9999' }), 30);
  });

  test('canPlace checks hours, visits, blocks, kept perfect-day blocks, chairs, the patient and the clock', () => {
    const v = visit({ s: H(9), e: H(10) });
    const day = mkDay({
      visits: [v, visit({ patient: pt(2), provider_id: 2, operatory_id: 12, s: H(13), e: H(14) })],
      blockouts: [{ provider_id: null, operatory_id: null, s: H(12), e: H(13), reason: 'Lunch' }, { provider_id: null, operatory_id: 13, s: H(15), e: H(16), reason: 'Repair' }],
      kept: [{ provider_id: 1, s: H(10), e: H(11), type_ids: [5], label: 'Crown prep', until: '3:00 PM' }],
      nowMin: H(8, 30),
    });
    assert.match(canPlace(day, { providerId: 1, s: H(7), e: H(8) }).why, /Outside Dr\. Chen’s hours/);
    assert.match(canPlace(day, { providerId: 1, s: H(8), e: H(8, 30) }).why, /passed/);
    assert.match(canPlace(day, { providerId: 1, s: H(9, 30), e: H(10, 30) }).why, /Dr\. Chen is booked/);
    assert.match(canPlace(day, { providerId: 1, s: H(12), e: H(12, 30) }).why, /booked/, 'an office-wide block (lunch) takes the time');
    assert.match(canPlace(day, { providerId: 1, s: H(10), e: H(10, 30), typeId: 4 }).why, /kept for Crown prep until 3:00 PM/);
    assert.equal(canPlace(day, { providerId: 1, s: H(10), e: H(10, 30), typeId: 5 }).fits, true, 'a crown prep may go in the crown block');
    assert.match(canPlace(day, { providerId: 1, patientId: 2, s: H(13, 30), e: H(14) }).why, /patient is booked/);
    // The provider's own chair first; when it's taken, another free one.
    assert.equal(canPlace(day, { providerId: 1, s: H(11), e: H(12) }).operatory_id, 11);
    const busyChair = mkDay({ visits: [visit({ provider_id: 2, operatory_id: 11, patient: pt(3), s: H(11), e: H(12) })] });
    assert.equal(canPlace(busyChair, { providerId: 1, s: H(11), e: H(12) }).operatory_id, 13);
    const noChair = mkDay({ chairs: [{ id: 11, name: 'Op 1', default_provider_id: 1 }], visits: [visit({ provider_id: 2, operatory_id: 11, patient: pt(3), s: H(11), e: H(12) })] });
    assert.match(canPlace(noChair, { providerId: 1, s: H(11), e: H(12) }).why, /No chair is free/);
    // Visits at another office still hold the provider.
    const elsewhere = mkDay({ busy: [{ id: 999, provider_id: 1, operatory_id: 99, patient_id: 50, s: H(14), e: H(15) }] });
    assert.match(canPlace(elsewhere, { providerId: 1, s: H(14), e: H(14, 30) }).why, /booked/);
  });

  test('OPT1: open time is the hours less visits and blocks, from now on; the goal gap per provider', () => {
    const day = mkDay({ nowMin: H(9, 5), visits: [visit({ s: H(10), e: H(12) })], blockouts: [{ provider_id: 1, s: H(12), e: H(13) }] });
    assert.deepEqual(openGaps(day, 1).map((g) => [g.s, g.e]), [[H(9, 10), H(10)], [H(13), H(17)]]);
    const g = goalGaps(day).find((x) => x.provider_id === 1);
    assert.equal(g.gap, 200000);
    assert.equal(g.pct, 60);
    assert.equal(g.open_minutes, 50 + 240);
  });

  test('(a) planned treatment: in the visit when it has the time, else stretch it, else a visit of its own next to it', () => {
    const tx = (id, o = {}) => ({ id, patient_id: 1, code: 'D2391', description: 'Resin', tooth: '30', fee: 20000, collectible: 15000, minutes: 45, kind: 'doctor', provider_id: 1, ...o });
    // A 90-minute doctor visit with 30 minutes of work: the filling fits inside.
    const roomy = visit({ s: H(9), e: H(10, 30), procedures: [{ id: 1, code: 'D2740', fee: 100000, minutes: 30 }] });
    let [o] = treatmentOpportunities(mkDay({ visits: [roomy], planned: [tx(501)] }));
    assert.equal(o.action.type, 'attach');
    assert.equal(o.action.end, undefined, 'no stretching needed');
    assert.equal(o.fee, 20000);
    assert.equal(o.collectible, 15000);
    // A full visit with open time after: stretch it.
    const full = visit({ s: H(9), e: H(10), procedures: [{ id: 1, code: 'D2740', fee: 100000, minutes: 60 }] });
    [o] = treatmentOpportunities(mkDay({ visits: [full], planned: [tx(502)] }));
    assert.equal(o.action.type, 'attach');
    assert.equal(o.action.end, H(10, 50));
    assert.match(o.detail, /stretch the visit to 10:50 AM/);
    // The next patient is right after, but Dr. Chen is free before: a visit of its own just before.
    const next = visit({ patient: pt(9, 'Ned', 'Next'), s: H(10), e: H(11) });
    [o] = treatmentOpportunities(mkDay({ visits: [full, next], planned: [tx(503)] }));
    assert.equal(o.action.type, 'book');
    assert.equal(o.action.end, H(9));
    // A patient in the hygiene chair with a filling planned: the doctor right after their cleaning.
    const cleaning = visit({ provider_id: 2, operatory_id: 12, s: H(9), e: H(10), procedures: [{ id: 2, code: 'D1110', fee: 12000, minutes: 60 }] });
    [o] = treatmentOpportunities(mkDay({ visits: [cleaning], planned: [tx(504)] }));
    assert.equal(o.action.type, 'book');
    assert.equal(o.action.provider_id, 1);
    assert.equal(o.action.start, H(10));
    assert.equal(o.action.operatory_id, 12, 'same chair, they stay put');
    assert.match(o.title, /after their 9:00 AM visit/);
    // No doctor time around it: shown, not fitting, with why.
    const doctorFull = mkDay({ visits: [cleaning, visit({ patient: pt(7), s: H(8), e: H(17) })], planned: [tx(505)] });
    [o] = treatmentOpportunities(doctorFull);
    assert.equal(o.fits, false);
    assert.match(o.why_not, /Dr\. Chen is booked/);
    // Visits already over aren't offered.
    assert.equal(treatmentOpportunities(mkDay({ nowMin: H(11), visits: [roomy], planned: [tx(506)] })).length, 0);
  });

  test('(b) opportunity-finder items: in the visit, by stretching it, or not yet covered', () => {
    const v = visit({ provider_id: 2, operatory_id: 12, s: H(9), e: H(10), procedures: [{ id: 3, code: 'D1110', fee: 12000, minutes: 40 }, { id: 4, code: 'D0120', fee: 6000, minutes: 10 }] });
    const f = (o = {}) => ({ appointment_id: v.id, patient_id: 1, rule_id: 7, name: 'Fluoride', codes: ['D1206'], fee: 4500, collectible: 4500, minutes: 5, reason: 'Age 9', ...o });
    let [o] = finderOpportunities(mkDay({ visits: [v], finder: [f()] }));
    assert.equal(o.action.type, 'finder_add');
    assert.equal(o.action.end, undefined);
    [o] = finderOpportunities(mkDay({ visits: [v], finder: [f({ rule_id: 8, name: 'Sealants', minutes: 40, fee: 18000 })] }));
    assert.equal(o.action.end, H(10, 30));
    [o] = finderOpportunities(mkDay({ visits: [v], finder: [f({ coverage: { status: 'not_yet', label: 'Not covered yet — eligible on 2030-09-01' } })] }));
    assert.equal(o.fits, false);
    assert.match(o.why_not, /eligible on 2030-09-01/);
  });

  test('(c) family: a sibling due for a cleaning goes right after the brother’s, same chair; not when blocked, booked, or kept', () => {
    const kid = visit({ patient: pt(20, 'Leo', 'Park', 10), provider_id: 2, operatory_id: 12, s: H(15), e: H(16) });
    const sister = { patient: pt(21, 'Mia', 'Park', 10), head_id: 10, recall: { id: 1, type: 'prophy', name: 'Prophy', due_date: '2030-05-01', type_id: 2, minutes: 60, fee: 15000, collectible: 12000, kind: 'hygiene' }, planned: [] };
    let [o] = familyOpportunities(mkDay({ visits: [kid], family: [sister] }));
    assert.equal(o.kind, 'family');
    assert.equal(o.action.type, 'book');
    assert.equal(o.action.start, H(16));
    assert.equal(o.action.operatory_id, 12);
    assert.equal(o.action.appointment_type_id, 2);
    assert.match(o.title, /Mia P\. could come after Leo P\. \(3:00 PM\)/);
    assert.equal(o.collectible, 12000);
    // After is taken: before.
    [o] = familyOpportunities(mkDay({ visits: [kid, visit({ patient: pt(30), provider_id: 2, operatory_id: 12, s: H(16), e: H(17) })], family: [sister] }));
    assert.equal(o.action.end, H(15));
    // Insurance frequency (or a waiting period) keeps it off the list.
    assert.equal(familyOpportunities(mkDay({ visits: [kid], family: [{ ...sister, recall: { ...sister.recall, blocked: 'Frequency limit' } }] })).length, 0);
    // Already coming today: nothing to suggest.
    assert.equal(familyOpportunities(mkDay({ visits: [kid, visit({ patient: pt(21, 'Mia', 'Park', 10), provider_id: 1, s: H(9), e: H(10) })], family: [sister] })).length, 0);
    // Not family (another household): nothing.
    assert.equal(familyOpportunities(mkDay({ visits: [kid], family: [{ ...sister, head_id: 99 }] })).length, 0);
    // The hygienist's afternoon is kept for perio: doesn't fit, with the reason.
    [o] = familyOpportunities(mkDay({ visits: [kid], family: [sister], kept: [{ provider_id: 2, s: H(8), e: H(17), type_ids: [3], label: 'Perio maintenance' }] }));
    assert.equal(o.fits, false);
    assert.match(o.why_not, /kept for Perio maintenance/);
  });

  test('(d) waitlist, ASAP and recall-due patients fit an open gap by length, provider and their preferences', () => {
    const busyMorning = [visit({ patient: pt(40), s: H(8), e: H(12) }), visit({ patient: pt(41), provider_id: 2, operatory_id: 12, s: H(8), e: H(17) })];
    const wl = (o = {}) => ({ waitlist_id: 1, patient: pt(50, 'Wes', 'Waite'), provider_id: null, days: null, times: 'any', minutes: 60, fee: 20000, collectible: 18000, reason: 'Filling', kind: 'doctor', procedure_ids: [601], ...o });
    let [o] = fillOpportunities(mkDay({ visits: busyMorning, waitlist: [wl()] }));
    assert.equal(o.action.type, 'text_offer');
    assert.equal(o.action.start, H(12));
    assert.equal(o.alt_actions[0].type, 'book');
    assert.deepEqual(o.alt_actions[0].procedure_ids, [601]);
    assert.equal(o.needs_reply, true);
    // Mornings only: the only open time is the afternoon.
    [o] = fillOpportunities(mkDay({ visits: busyMorning, waitlist: [wl({ times: 'morning' })] }));
    assert.equal(o.fits, false);
    assert.match(o.why_not, /mornings/);
    // Not on their days.
    [o] = fillOpportunities(mkDay({ visits: busyMorning, waitlist: [wl({ days: [1, 2] })] }));
    assert.match(o.why_not, /days/);
    // Wants the hygienist, who's full.
    [o] = fillOpportunities(mkDay({ visits: busyMorning, waitlist: [wl({ provider_id: 2, kind: null })] }));
    assert.equal(o.fits, false);
    // Longer than any gap.
    [o] = fillOpportunities(mkDay({ visits: [visit({ patient: pt(40), s: H(8), e: H(16, 30) })], waitlist: [wl({ minutes: 60 })] }));
    assert.equal(o.fits, false);
    // ASAP: their later visit could move up (the text offer, or move it now).
    const asap = { appointment_id: 777, patient: pt(60, 'Ann', 'Soon'), provider_id: 1, kind: 'doctor', minutes: 90, fee: 110000, collectible: 90000, from_time: '2030-06-20 09:00', type_id: 5 };
    [o] = fillOpportunities(mkDay({ visits: busyMorning, asap: [asap] }));
    assert.equal(o.source, 'asap');
    assert.equal(o.alt_actions[0].type, 'move_up');
    assert.equal(o.alt_actions[0].appointment_id, 777);
    // Recall due: hygiene time only.
    const rc = { recall_id: 5, patient: pt(70, 'Rae', 'Call'), kind: 'hygiene', minutes: 60, fee: 15000, collectible: 12000, type_id: 2, name: 'Prophy', due_date: '2030-01-01' };
    const hygOpen = mkDay({ visits: [visit({ patient: pt(40), s: H(8), e: H(17) }), visit({ patient: pt(41), provider_id: 2, operatory_id: 12, s: H(8), e: H(14) })], recallDue: [rc] });
    [o] = fillOpportunities(hygOpen);
    assert.equal(o.provider_id, 2);
    assert.equal(o.action.start, H(14));
    // One suggestion per patient, the best of their gaps.
    assert.equal(fillOpportunities(mkDay({ waitlist: [wl()] })).length, 1);
  });

  test('(e) shorten: an 90-minute cleaning with 50 minutes of work frees 30; not when the work needs the time', () => {
    const v = visit({ patient: pt(80, 'Sam', 'Long'), provider_id: 2, operatory_id: 12, s: H(9), e: H(10, 30), usual: 60, type_id: 2, procedures: [{ id: 5, code: 'D1110', fee: 12000, minutes: 40 }, { id: 6, code: 'D0120', fee: 6000, minutes: 10 }] });
    const nextUp = visit({ patient: pt(81), provider_id: 2, operatory_id: 12, s: H(10, 30), e: H(17) });
    const rc = { recall_id: 5, patient: pt(70, 'Rae', 'Call'), kind: 'hygiene', minutes: 30, fee: 9000, collectible: 8000, type_id: null, name: 'Prophy', due_date: '2030-01-01' };
    let [o] = shortenOpportunities(mkDay({ visits: [v, nextUp], types: { 2: { name: 'Recall exam & cleaning' } }, recallDue: [rc] }));
    assert.equal(o.minutes, 30);
    assert.equal(o.action.end, H(10));
    assert.match(o.detail, /usually takes 60/);
    assert.equal(o.then.fee, 9000, 'what fits in the freed time');
    assert.equal(o.fee, 9000);
    // The work attached needs the time: no suggestion.
    const justified = { ...v, procedures: [...v.procedures, { id: 7, code: 'D4341', fee: 30000, minutes: 60 }] };
    assert.equal(shortenOpportunities(mkDay({ visits: [justified, nextUp], types: {} })).length, 0);
    // Only 5 minutes over: not worth it.
    assert.equal(shortenOpportunities(mkDay({ visits: [{ ...v, e: H(10, 5) }], types: {} })).length, 0);
    // Already started, or no usual length known: left alone.
    assert.equal(shortenOpportunities(mkDay({ nowMin: H(9, 10), visits: [v], types: {} })).length, 0);
    assert.equal(shortenOpportunities(mkDay({ visits: [{ ...v, usual: null }], types: {} })).length, 0);
    [o] = shortenOpportunities(mkDay({ visits: [v, nextUp], types: {} }));
    assert.equal(o.fee, 0, 'nothing to put there: frees the time, adds nothing yet');
  });

  test('(f) no-show risk: the predicted probability drives double-confirm; low risk and confirmed visits are left alone', () => {
    const v = visit({ patient: pt(90), status: 'scheduled', confirmed: false, fee: 45000 });
    const calm = visit({ patient: pt(92), status: 'scheduled', confirmed: false });
    const noShow = {
      [v.id]: { probability: 0.41, percent: 41, level: 'high', reasons: ['2 missed visits in the past year', 'not confirmed yet'], confidence: 'high' },
      [calm.id]: { probability: 0.04, percent: 4, level: 'low', reasons: [], confidence: 'high' },
    };
    const opps = confirmOpportunities(mkDay({ visits: [v, calm, visit({ patient: pt(91), status: 'confirmed' })], noShow }));
    assert.equal(opps.length, 1, 'only the risky, unconfirmed visit');
    const [o] = opps;
    assert.equal(o.kind, 'confirm');
    assert.equal(o.at_risk, 45000);
    assert.equal(o.risk, 'high');
    assert.equal(o.probability, 0.41);
    assert.match(o.detail, /^No-show risk 41% — 2 missed visits in the past year, not confirmed yet · \$450 booked/);
    // No prediction (e.g. the visit is in the past) → no suggestion.
    assert.equal(confirmOpportunities(mkDay({ visits: [v] })).length, 0);
  });

  test('OPT3: the plan reaches goal with the fewest moves and never puts two things in one place', () => {
    // Dr. Chen needs $2,000 more. Two waitlist patients both fit only 12:00–13:00; a crown for a patient on the
    // schedule fits in their visit. The plan: the crown ($1,500) and one of the two for 12:00 — not both.
    const v = visit({ s: H(8), e: H(10), procedures: [{ id: 1, code: 'D0120', fee: 6000, minutes: 10 }] });
    const day = mkDay({
      providers: [{ id: 1, name: 'Dr. Chen', type: 'dentist', kind: 'doctor', hours: [[H(8), H(13)]], goal: 500000, scheduled: 300000 }],
      visits: [v, visit({ patient: pt(2), s: H(10), e: H(12), operatory_id: 13 })],
      planned: [{ id: 900, patient_id: 1, code: 'D2740', description: 'Crown', tooth: '3', fee: 150000, collectible: 120000, minutes: 90, kind: 'doctor', provider_id: 1 }],
      waitlist: [
        { waitlist_id: 1, patient: pt(50, 'Wes', 'Waite'), times: 'any', minutes: 60, fee: 60000, collectible: 50000, kind: 'doctor', procedure_ids: [] },
        { waitlist_id: 2, patient: pt(51, 'Will', 'Wait'), times: 'any', minutes: 60, fee: 80000, collectible: 70000, kind: 'doctor', procedure_ids: [] },
      ],
    });
    const { plan, opportunities, providers } = optimizeDay(day);
    const picked = opportunities.filter((o) => o.in_plan);
    assert.equal(picked.length, 2, JSON.stringify(picked.map((o) => o.key)));
    assert.ok(picked.some((o) => o.key === 'tx:900'));
    assert.ok(picked.some((o) => o.key === 'fill:51'), 'the bigger of the two for the one open hour');
    const doc = plan.providers.find((p) => p.provider_id === 1);
    assert.equal(doc.headline, '2 moves get Dr. Chen to 106% of goal');
    assert.equal(doc.reached, true);
    assert.equal(plan.added, 230000);
    assert.equal(providers[0].gap, 200000);
    // Never two in one place.
    const us = picked.map((o) => uses(day, o));
    for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
      assert.ok(!us[i].iv.some(([r, s, e]) => us[j].iv.some(([r2, s2, e2]) => r === r2 && s < e2 && s2 < e)), 'no overlapping provider, chair or patient time');
    }
  });

  test('OPT3: with many candidates the greedy plan still never double-books, and spare minutes in a visit aren’t spent twice', () => {
    const visits = [];
    const planned = [];
    for (let i = 0; i < 8; i++) {
      const v = visit({ patient: pt(200 + i), s: H(8) + i * 60, e: H(8) + i * 60 + 60, operatory_id: 11, procedures: [{ id: 300 + i, code: 'D0120', fee: 5000, minutes: 30 }] });
      visits.push(v);
      // Two 20-minute items per visit with 30 spare minutes (+5 tolerance): only one of them fits alongside the other.
      planned.push({ id: 1000 + i * 2, patient_id: 200 + i, code: 'D2391', fee: 20000 + i, collectible: 20000, minutes: 20, kind: 'doctor', provider_id: 1 });
      planned.push({ id: 1001 + i * 2, patient_id: 200 + i, code: 'D2392', fee: 21000 + i, collectible: 21000, minutes: 20, kind: 'doctor', provider_id: 1 });
    }
    const day = mkDay({ providers: [{ id: 1, name: 'Dr. Chen', kind: 'doctor', hours: [[H(8), H(17)]], goal: 1000000, scheduled: 0 }], visits, planned, waitlist: Array.from({ length: 6 }, (_, i) => ({ waitlist_id: i, patient: pt(400 + i), times: 'any', minutes: 60, fee: 30000, collectible: 30000, kind: 'doctor' })) });
    const opps = generate(day);
    assert.ok(opps.filter((o) => o.fits).length > 14, 'enough to take the greedy path');
    const plan = solve(day, opps);
    const picked = opps.filter((o) => plan.keys.includes(o.key));
    for (const v of visits) {
      const inIt = picked.filter((o) => o.action?.appointment_id === v.id && !o.action.end);
      assert.ok(inIt.reduce((n, o) => n + o.minutes, 0) <= 35, `visit ${v.id} isn’t overfilled`);
    }
    const us = picked.map((o) => uses(day, o));
    for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
      assert.ok(!us[i].iv.some(([r, s, e]) => us[j].iv.some(([r2, s2, e2]) => r === r2 && s < e2 && s2 < e)));
    }
    // One hour after the last visit (16:00–17:00): only one waitlist patient gets it.
    assert.equal(picked.filter((o) => o.kind === 'fill').length, 1);
  });

  test('OPT3: at goal already, or no goal: no moves, and it says so', () => {
    const day = mkDay({ providers: [{ id: 1, name: 'Dr. Chen', kind: 'doctor', hours: [[H(8), H(17)]], goal: 100000, scheduled: 120000 }], waitlist: [{ waitlist_id: 1, patient: pt(50), times: 'any', minutes: 60, fee: 60000, collectible: 60000, kind: 'doctor' }] });
    const { plan } = optimizeDay(day);
    assert.equal(plan.moves, 0);
    assert.equal(plan.providers[0].headline, 'Dr. Chen is at 120% of goal — nothing needed');
    assert.equal(plan.headline, 'Everyone is at goal today');
    const none = optimizeDay(mkDay({ providers: [{ id: 1, name: 'Dr. Chen', kind: 'doctor', hours: [[H(8), H(17)]], goal: 0, scheduled: 0 }] }));
    assert.equal(none.plan.headline, 'No goals are set for today');
  });

  test('AI input carries only first name + last initial and the engine’s own numbers; answers keep only known keys', async () => {
    const v = visit({ patient: { ...pt(1, 'Maria', 'Lopez-Garcia'), dob: '1980-01-02', phone: '(512) 555-0100' }, s: H(9), e: H(10, 30) });
    const day = mkDay({ visits: [v], planned: [{ id: 1, patient_id: 1, code: 'D2391', description: 'Resin', tooth: '30', fee: 20000, collectible: 15000, minutes: 45, kind: 'doctor', provider_id: 1 }] });
    const { plan, opportunities } = optimizeDay(day);
    const input = aiInput({ providers: plan.providers, opportunities });
    assert.match(input, /Maria L\./);
    assert.doesNotMatch(input, /Lopez|1980|555-0100/);
    const out = await explainPlan({}, { providers: plan.providers, opportunities }, { mode: 'sandbox' });
    assert.equal(out.label, 'AI (sandbox)');
    assert.equal(out.ranked[0].key, 'tx:1');
    assert.match(out.summary, /AI sandbox/);
    const cleaned = cleanAnswer({ ranked: [{ key: 'made-up', why: 'x' }, { key: 'tx:1', why: 'Good.' }, { key: 'tx:1', why: 'dup' }], summary: 'ok' }, opportunities);
    assert.deepEqual(cleaned.ranked, [{ key: 'tx:1', why: 'Good.' }]);
  });
});

// ---- Through the routes, on a real database ----
const h = harness({ config: { optimizerAi: 'sandbox' } });
const isPg = !!process.env.TEST_DATABASE_URL;
before(async () => {
  while (!h.db || !h.app) await new Promise((r) => setTimeout(r, 10));
  // Until db.js carries the table and column (see the hand-off), add them here. Harmless once it does.
  await h.db.run(isPg ? OPTIMIZER_SCHEMA.replace('id INTEGER PRIMARY KEY', 'id SERIAL PRIMARY KEY') : OPTIMIZER_SCHEMA);
  for (const [table, column, def] of OPTIMIZER_COLUMNS) {
    await h.db.run(`ALTER TABLE ${table} ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${column} ${def}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
  }
  // Until app.js mounts the routes, put them in the app's /api router ahead of the other route groups.
  if (!h.app.router.stack.some((l) => l.handle?.stack?.some?.((x) => x.route?.path === '/optimizer/today'))) {
    const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
    const at = api.stack.findIndex((l) => l.handle?.stack);
    api.use(optimizerRoutes({ db: h.db, config: h.config, messenger: h.messenger, app: () => h.app }));
    api.stack.splice(at, 0, ...api.stack.splice(api.stack.length - 1, 1));
  }
});

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const signIn = async (email) => (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
async function staff(api, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const made = await api.post('/users', { name: `${role} person`, email, role, password: 'correct-horse-battery', ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return h.client(await signIn(email));
}

// A practice with a dentist ($3,000 goal) and a hygienist, two chairs, and a quiet future Wednesday.
async function setUp() {
  const p = await h.practice({ timezone: 'UTC', daily_goal: 0 });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  let day = addDays(today, 21);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 3) day = addDays(day, 1);
  await h.db.run('UPDATE providers SET daily_goal = 300000 WHERE id = ?', p.provider.id);
  const hyg = (await p.api.post('/providers', { name: 'Hal Hygienist, RDH', type: 'hygienist' })).data;
  const op1 = (await p.api.post('/operatories', { name: 'Op 1' })).data;
  const op2 = (await p.api.post('/operatories', { name: 'Hyg 1' })).data;
  await h.db.run('UPDATE operatories SET default_provider_id = ? WHERE id = ?', p.provider.id, op1.id);
  await h.db.run('UPDATE operatories SET default_provider_id = ?, is_hygiene = 1 WHERE id = ?', hyg.id, op2.id);
  const code = (c) => h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, c);
  const patient = async (first, last, extra = {}) => (await p.api.post('/patients', { first_name: first, last_name: last, dob: '1990-02-03', phone: '(512) 555-0199', ...extra })).data;
  const book = async (pt, start, end, extra = {}) => {
    const r = await p.api.post('/appointments', { patient_id: pt.id, provider_id: p.provider.id, operatory_id: op1.id, start_time: `${day} ${start}`, end_time: `${day} ${end}`, notify: false, add_type_procedures: false, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const plan = async (pt, c, extra = {}) => {
    const pc = await code(c);
    return insert(h.db, 'procedures', { practice_id: pid, patient_id: pt.id, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee, status: 'planned', provider_id: p.provider.id, ...extra });
  };
  const today_ = async (api = p.api, q = '') => {
    const r = await api.get(`/optimizer/today?date=${day}${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  return { ...p, pid, day, hyg, op1, op2, code, patient, book, plan, today: today_ };
}

describe('the routes', () => {
  test('a planned crown for a patient on the schedule: found and priced, done once through the endpoints, undone', async () => {
    const s = await setUp();
    // Dr. Lee is booked 8–9 and 9–10; Maria's 9:00 visit has nothing attached and the time after it is open.
    const maria = await s.patient('Maria', 'Lopez');
    await s.book(await s.patient('Early', 'Bird'), '08:00', '09:00');
    const v = await s.book(maria, '09:00', '10:00');
    const crown = await s.plan(maria, 'D2740', { tooth: '3' });
    const d = await s.today();
    const doc = d.providers.find((x) => x.provider_id === s.provider.id);
    assert.equal(doc.goal, 300000);
    assert.equal(doc.scheduled, 0);
    const o = d.opportunities.find((x) => x.key === `tx:${crown}`);
    assert.ok(o, JSON.stringify(d.opportunities.map((x) => x.key)));
    assert.equal(o.fits, true);
    assert.equal(o.action, 'attach');
    assert.equal(o.patient, 'Maria L.');
    assert.equal(o.fee, (await s.code('D2740')).fee);
    assert.ok(o.in_plan);
    assert.ok(o.id, 'tracked');
    assert.match(d.plan.headline, /move/);

    // Two clicks at once: one does it, the other answers with the first result.
    const [a, b] = await Promise.all([s.api.post(`/optimizer/${o.id}/act`), s.api.post(`/optimizer/${o.id}/act`)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.data, b.data]));
    const proc = await h.db.get('SELECT * FROM procedures WHERE id = ?', crown);
    assert.equal(proc.appointment_id, v.id);
    assert.equal(proc.status, 'planned', 'planned on the visit, not charged');
    const appt = await h.db.get('SELECT end_time FROM appointments WHERE id = ?', v.id);
    assert.ok(appt.end_time > `${s.day} 10:00`, 'the visit was stretched into the open time for the crown');
    const row = await h.db.get('SELECT * FROM optimizer_suggestions WHERE id = ?', o.id);
    assert.equal(row.status, 'done');
    const audits = await h.db.all("SELECT action, user_id, source FROM audit_log WHERE entity = 'optimizer_suggestions' AND entity_id = ?", o.id);
    assert.deepEqual(audits.map((x) => x.action), ['optimizer.act']);
    assert.ok(await h.db.get("SELECT id FROM audit_log WHERE entity = 'procedures' AND entity_id = ?", crown), 'the procedure change is in the audit log');
    // Once done it isn't offered again; the day shows it as done with its $.
    const after = await s.today();
    assert.ok(!after.opportunities.some((x) => x.key === `tx:${crown}`));
    assert.equal(after.done[0].id, o.id);
    assert.equal(after.captured, o.fee);
    assert.equal(after.providers.find((x) => x.provider_id === s.provider.id).scheduled, o.fee);

    // Undo puts it back the way it was, through the same endpoints.
    const u = await s.api.post(`/optimizer/${o.id}/undo`);
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal((await h.db.get('SELECT appointment_id FROM procedures WHERE id = ?', crown)).appointment_id, null);
    assert.equal((await h.db.get('SELECT end_time FROM appointments WHERE id = ?', v.id)).end_time, `${s.day} 10:00`);
    assert.ok((await s.today()).opportunities.some((x) => x.key === `tx:${crown}` && x.status === 'undone'));
  });

  test('no provider goals: the practice’s goal is shared by kind (as the schedule counts it)', async () => {
    const s = await setUp();
    await h.db.run('UPDATE providers SET daily_goal = NULL WHERE id = ?', s.provider.id);
    await h.db.run('UPDATE practices SET daily_goal = 400000, hygiene_goal = 100000 WHERE id = ?', s.pid);
    const d = await s.today();
    assert.equal(d.providers.find((x) => x.provider_id === s.provider.id).goal, 300000);
    assert.equal(d.providers.find((x) => x.provider_id === s.hyg.id).goal, 100000);
  });

  test('the database has the last word: a reserved block the day rows don’t know about makes a placement not fit', async () => {
    const s = await setUp();
    const jo = await s.patient('Jo', 'Block');
    await s.book(jo, '08:00', '09:00');
    await s.plan(jo, 'D2750', { tooth: '30' });
    // Everything after 9:00 is reserved for crown preps; the crown (no visit type) can't stretch into it.
    const crownType = await h.db.get("SELECT id FROM appointment_types WHERE practice_id = ? AND name = 'Root canal'", s.pid);
    const bl = await s.api.post('/blockouts', { provider_id: s.provider.id, start_time: `${s.day} 09:00`, end_time: `${s.day} 17:00`, reason: 'Root canals', kind: 'reserved', appointment_type_ids: [crownType.id] });
    assert.equal(bl.status, 201, JSON.stringify(bl.data));
    const d = await s.today();
    const o = d.opportunities.find((x) => x.kind === 'treatment');
    assert.equal(o.fits, false);
    assert.match(o.why_not, /Root canal/);
    assert.ok(!o.in_plan);
  });

  test('family: a sister due for a cleaning is booked right after her brother with the hygienist (one click); decline hides a suggestion', async () => {
    const s = await setUp();
    const mom = await s.patient('Rosa', 'Park');
    const leo = await s.patient('Leo', 'Park', { guarantor_id: mom.id, dob: '2015-03-04' });
    const mia = await s.patient('Mia', 'Park', { guarantor_id: mom.id, dob: '2017-05-06' });
    await h.db.run("INSERT INTO recalls (practice_id, patient_id, type, due_date, status) VALUES (?, ?, 'prophy', ?, 'due')", s.pid, mia.id, addDays(s.day, -30));
    const leoVisit = await s.book(leo, '14:00', '15:00', { provider_id: s.hyg.id, operatory_id: s.op2.id });
    const d = await s.today();
    const o = d.opportunities.find((x) => x.kind === 'family' && x.patient_id === mia.id);
    assert.ok(o, JSON.stringify(d.opportunities.map((x) => [x.key, x.why_not])));
    assert.equal(o.fits, true);
    assert.equal(o.start_time, `${s.day} 15:00`);
    assert.equal(o.provider_id, s.hyg.id);
    assert.equal(o.operatory_id, s.op2.id);
    assert.match(o.title, /Mia P\. could come after Leo P\./);
    const r = await s.api.post(`/optimizer/${o.id}/act`);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const booked = await h.db.get('SELECT * FROM appointments WHERE id = ?', r.data.result.appointment_id);
    assert.equal(booked.patient_id, mia.id);
    assert.equal(booked.start_time, `${s.day} 15:00`);
    assert.equal(booked.operatory_id, s.op2.id);
    assert.equal((await h.db.get('SELECT status FROM recalls WHERE patient_id = ?', mia.id)).status, 'scheduled', 'the recall is linked like any booking');
    assert.ok(leoVisit.id);

    // Decline another: gone from the list and the plan, kept as declined, audited with the reason.
    const wes = await s.patient('Wes', 'Waite');
    await s.api.post('/waitlist', { patient_id: wes.id, duration: 30, times: 'any' });
    const d2 = await s.today();
    const w = d2.opportunities.find((x) => x.patient_id === wes.id);
    assert.ok(w?.fits, JSON.stringify(w));
    const dec = await s.api.post(`/optimizer/${w.id}/decline`, { reason: 'Called — can’t come today' });
    assert.equal(dec.status, 200);
    const d3 = await s.today();
    assert.ok(!d3.opportunities.some((x) => x.id === w.id));
    assert.ok(!d3.plan.ids.includes(w.id));
    assert.equal(d3.declined.find((x) => x.id === w.id).reason, 'Called — can’t come today');
    const a = await h.db.get("SELECT reason FROM audit_log WHERE action = 'optimizer.decline' AND entity_id = ?", w.id);
    assert.equal(a.reason, 'Called — can’t come today');
    // Acting on a declined one is still possible (a change of heart), and it's re-checked first.
    assert.equal((await s.api.post(`/optimizer/${w.id}/restore`)).data.status, 'shown');
  });

  test('a text offer to an ASAP patient: the fill-offer text; their YES moves their visit up and the suggestion is done', async () => {
    const s = await setUp();
    const ann = await s.patient('Ann', 'Soon', { phone: '(512) 555-0333' });
    const later = addDays(s.day, 14);
    const booked = await s.api.post('/appointments', { patient_id: ann.id, provider_id: s.provider.id, operatory_id: s.op1.id, start_time: `${later} 09:00`, end_time: `${later} 10:00`, notify: false, asap: true, add_type_procedures: false });
    await s.plan(ann, 'D2391', { tooth: '19', appointment_id: booked.data.id });
    const d = await s.today();
    const o = d.opportunities.find((x) => x.patient_id === ann.id);
    assert.equal(o.source, 'asap');
    assert.equal(o.action, 'text_offer');
    assert.deepEqual(o.alt_actions, ['move_up']);
    assert.equal(o.start_time, `${s.day} 08:00`);
    const before = h.sent.length;
    const r = await s.api.post(`/optimizer/${o.id}/act`);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const text = h.sent.slice(before).find((m) => m.to === '(512) 555-0333');
    assert.match(text.body, /just had an opening: .* Reply YES to take it/);
    assert.equal((await h.db.get('SELECT status FROM optimizer_suggestions WHERE id = ?', o.id)).status, 'accepted', 'waiting for their answer');
    // Their YES (as the SMS webhook handles it).
    const rec = await offerFor(h.db, s.pid, '(512) 555-0333');
    const won = await claimOffer(h.db, rec);
    assert.equal(won.won, true);
    assert.equal((await h.db.get('SELECT start_time FROM appointments WHERE id = ?', booked.data.id)).start_time, `${s.day} 08:00`);
    const d2 = await s.today();
    assert.equal(d2.done.find((x) => x.id === o.id)?.status, 'done');
  });

  test('shorten: a visit booked long frees time; then undo restores it', async () => {
    const s = await setUp();
    const recallType = await h.db.get("SELECT id FROM appointment_types WHERE practice_id = ? AND name = 'Recall exam & cleaning'", s.pid);
    const sam = await s.patient('Sam', 'Long');
    const v = await s.book(sam, '09:00', '10:30', { provider_id: s.hyg.id, operatory_id: s.op2.id, appointment_type_id: recallType.id });
    const d = await s.today();
    const o = d.opportunities.find((x) => x.key === `short:${v.id}`);
    assert.ok(o, JSON.stringify(d.opportunities.map((x) => x.key)));
    assert.equal(o.minutes, 30);
    const r = await s.api.post(`/optimizer/${o.id}/act`);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await h.db.get('SELECT end_time FROM appointments WHERE id = ?', v.id)).end_time, `${s.day} 10:00`);
    await s.api.post(`/optimizer/${o.id}/undo`);
    assert.equal((await h.db.get('SELECT end_time FROM appointments WHERE id = ?', v.id)).end_time, `${s.day} 10:30`);
  });

  test('the schedule changed since it was shown: the action is refused, nothing is done', async () => {
    const s = await setUp();
    const wes = await s.patient('Wes', 'Waite');
    await s.api.post('/waitlist', { patient_id: wes.id, duration: 480, times: 'any', provider_id: s.provider.id });
    const d = await s.today();
    const o = d.opportunities.find((x) => x.patient_id === wes.id);
    assert.equal(o.fits, true);
    // Someone books into Dr. Lee's day in the meantime.
    await s.book(await s.patient('Other', 'Person'), '12:00', '13:00');
    const r = await s.api.post(`/optimizer/${o.id}/act`, { alt: 0 });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /doesn’t fit any more|isn’t an opportunity/);
    assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ?', wes.id)).n, 0);
  });

  test('money is hidden without billing access; acting needs schedule:write; the underlying endpoint’s permission still applies', async () => {
    const s = await setUp();
    const maria = await s.patient('Maria', 'Lopez');
    await s.book(maria, '09:00', '11:00');
    await s.plan(maria, 'D2391', { tooth: '30', surfaces: 'O' });
    const assistant = await staff(s.api, 'assistant');
    const d = (await assistant.get(`/optimizer/today?date=${s.day}`)).data;
    const o = d.opportunities.find((x) => x.kind === 'treatment');
    assert.equal(d.money, false);
    assert.equal(o.fee, null);
    assert.equal(d.providers[0].goal, null);
    assert.match(d.plan.headline, /suggested/);
    // Billing can see but not act.
    const billing = await staff(s.api, 'billing');
    assert.equal((await billing.get(`/optimizer/today?date=${s.day}`)).status, 200);
    assert.equal((await billing.post(`/optimizer/${o.id}/act`)).status, 403);
    // Front desk may book, but adding a procedure to a visit is clinical work.
    const desk = await staff(s.api, 'front_desk');
    const r = await desk.post(`/optimizer/${o.id}/act`);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.match(r.data.error, /clinical:write/);
    assert.equal((await h.db.get('SELECT status FROM optimizer_suggestions WHERE id = ?', o.id)).status, 'failed');
    // The assistant has it: done.
    assert.equal((await assistant.post(`/optimizer/${o.id}/act`)).status, 201);
  });

  test('practice and office isolation', async () => {
    const a = await setUp();
    const b = await setUp();
    const maria = await a.patient('Maria', 'Lopez');
    await a.book(maria, '09:00', '11:00');
    await a.plan(maria, 'D2391', { tooth: '30', surfaces: 'O' });
    const o = (await a.today()).opportunities.find((x) => x.kind === 'treatment');
    // Another practice: can't see or act on it, and its own day has none of it.
    assert.equal((await b.api.post(`/optimizer/${o.id}/act`)).status, 404);
    assert.equal((await b.api.post(`/optimizer/${o.id}/decline`)).status, 404);
    assert.ok(!(await b.today()).opportunities.some((x) => x.patient_id === maria.id));
    // Offices: someone limited to the other office doesn't get this office's suggestion.
    const north = (await a.api.post('/locations', { name: 'North' })).data;
    const south = (await a.api.post('/locations', { name: 'South' })).data;
    await h.db.run('UPDATE optimizer_suggestions SET location_id = ? WHERE id = ?', north.id, o.id);
    const southOnly = await staff(a.api, 'assistant', { location_ids: [south.id] });
    assert.equal((await southOnly.post(`/optimizer/${o.id}/act`)).status, 404);
    assert.equal((await southOnly.get(`/optimizer/today?date=${a.day}&location_id=${north.id}`)).status, 403);
  });

  test('the AI note: off until an administrator turns it on; labelled; sandbox is deterministic', async () => {
    const s = await setUp();
    const maria = await s.patient('Maria', 'Lopez');
    await s.book(maria, '09:00', '11:00');
    await s.plan(maria, 'D2391', { tooth: '30', surfaces: 'O' });
    let d = await s.today(s.api, '&explain=1');
    assert.equal(d.ai, null, 'off by default');
    assert.equal(d.ai_available, false);
    const assistant = await staff(s.api, 'assistant');
    assert.equal((await assistant.put('/optimizer/settings', { ai: true })).status, 403);
    assert.equal((await s.api.put('/optimizer/settings', { ai: true })).status, 200);
    assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'optimizer.settings'"));
    d = await s.today(s.api, '&explain=1');
    assert.equal(d.ai.label, 'AI (sandbox)');
    assert.equal(d.ai.ranked[0].key, d.opportunities.find((x) => x.in_plan).key);
    assert.ok(d.ai.ranked[0].id);
    assert.doesNotMatch(JSON.stringify(d.ai), /Lopez/);
    // Not asked for: not run.
    assert.equal((await s.today()).ai, null);
  });

  test('the assistant can’t act without a person’s yes on screen', { skip: !aiRisk('POST', '/optimizer/1/act') && 'add the optimizer line to HIGH_RISK in aiguard.js (see the hand-off)' }, async () => {
    const s = await setUp();
    const maria = await s.patient('Maria', 'Lopez');
    await s.book(maria, '09:00', '11:00');
    await s.plan(maria, 'D2391', { tooth: '30', surfaces: 'O' });
    const o = (await s.today()).opportunities.find((x) => x.kind === 'treatment');
    const ai = h.client(s.token, { 'X-Acting-For': 'assistant' });
    assert.equal((await ai.post(`/optimizer/${o.id}/act`)).status, 428);
    const ok = await h.client(s.token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }).post(`/optimizer/${o.id}/act`);
    assert.equal(ok.status, 201);
    assert.equal((await h.db.get('SELECT source FROM optimizer_suggestions WHERE id = ?', o.id)).source, 'ai');
  });

  test('$ captured per day and per person; the huddle email’s plan lines use first name and last initial', async () => {
    const s = await setUp();
    const maria = await s.patient('Maria', 'Lopez');
    await s.book(maria, '09:00', '11:00');
    await s.plan(maria, 'D2391', { tooth: '30', surfaces: 'O' });
    const o = (await s.today()).opportunities.find((x) => x.kind === 'treatment');
    const hp = await huddlePlan(h.db, { practiceId: s.pid, date: s.day });
    assert.match(JSON.stringify(hp.providers), /Maria L\./);
    assert.doesNotMatch(JSON.stringify(hp), /Lopez/);
    const anon = await huddlePlan(h.db, { practiceId: s.pid, date: s.day, names: false });
    assert.doesNotMatch(JSON.stringify(anon), /Maria/);
    assert.match(anon.providers[0].items[0], /Planned treatment for a patient on the schedule — \$/);
    await s.api.post(`/optimizer/${o.id}/act`);
    const c = (await s.api.get(`/optimizer/captured?from=${s.day}&to=${s.day}`)).data;
    assert.equal(c.by_day[0].done, 1);
    assert.equal(c.by_day[0].fee, o.fee);
    assert.equal(c.by_person[0].name, 'Admin');
  });
});
