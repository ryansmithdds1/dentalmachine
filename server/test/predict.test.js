// Predictions (docs/predictions.md): no-show risk per visit, denial risk per claim line. Dangerous things first: the
// numbers stay in bounds and in the right order, little history says so, one practice's history never feeds
// another's, a failing vendor falls back to the built-in model and shows up in Needs attention, nothing identifying
// is sent to the vendor, and the routes check permissions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { practiceNow } from '../src/util.js';
import { predictNoShow, predictDenial, smoothed, PRIORS, claimChance, sharedDenial } from '../src/predict/builtin.js';
import { claimWideDenyRules, claimLevel } from '../src/predict/denial.js';
import { createPredictor, registerPredictor, getPredictor, clearPredictCache, ISSUE_KEY } from '../src/predict/index.js';
import { noShowRisks, addDays, calibrate } from '../src/predict/noshow.js';
import { deidentify, JEV_FIELDS, createJev } from '../src/predict/jev.js';
import { loadDay, confirmOpportunities } from '../src/optimizer.js';

const h = harness();
after(() => registerPredictor(null));

// ---------------------------------------------------------------- the built-in model on plain features
const stats = (n, hits) => ({ n, hits });
const visit = (patient, extra = {}) => ({
  practice: stats(2000, 200), patient, first_visit: false, first_visit_stats: stats(300, 45), confirmed: false, days_ahead: 1,
  confirmed_stats: stats(600, 90), lead_days: 40, lead_label: 'booked 1–3 months ahead', lead_stats: stats(800, 90), weekday: 'Monday',
  weekday_stats: stats(400, 40), time_of_day: 'Early morning', time_stats: stats(500, 50), visit_type: 'Hygiene', type_stats: stats(900, 80),
  owes: false, owes_stats: stats(1500, 140), ...extra,
});
const record = (o = {}) => ({ missed_w: 0, kept_w: 0, no_shows_1y: 0, late_cancels_1y: 0, missed_2y: 0, kept_2y: 0, kept_ever: 0, ...o });

test('no-show model: a patient who misses a lot > no history > a patient who always comes; all within 0–1', () => {
  const misser = predictNoShow(visit(record({ missed_w: 2.6, kept_w: 0.8, no_shows_1y: 3, missed_2y: 3, kept_2y: 1, kept_ever: 1 })));
  const fresh = predictNoShow(visit(record()));
  const loyal = predictNoShow(visit(record({ kept_w: 6, kept_2y: 8, kept_ever: 12 })));
  for (const r of [misser, fresh, loyal]) {
    assert.ok(r.probability > 0 && r.probability < 1, JSON.stringify(r));
    assert.equal(r.percent, Math.round(r.probability * 100));
  }
  assert.ok(misser.probability > fresh.probability && fresh.probability > loyal.probability, `${misser.probability} > ${fresh.probability} > ${loyal.probability}`);
  assert.equal(misser.level, 'high');
  assert.equal(loyal.level, 'low');
  assert.match(misser.reasons[0], /3 missed visits in the past year/);
  assert.ok(misser.reasons.includes('not confirmed yet'), JSON.stringify(misser.reasons));
  assert.deepEqual(loyal.reasons, ['kept all 8 visits in the past 2 years']);
  assert.equal(misser.confidence, 'high');
  // Confirming lowers it; owing a balance (where owing goes with missing) raises it.
  const confirmed = predictNoShow(visit(record({ missed_w: 2.6, kept_w: 0.8, no_shows_1y: 3, missed_2y: 3, kept_2y: 1, kept_ever: 1 }), { confirmed: true, confirmed_stats: stats(1400, 60) }));
  assert.ok(confirmed.probability < misser.probability);
  const owes = predictNoShow(visit(record(), { owes: true, owes_stats: stats(500, 100) }));
  assert.ok(owes.probability > fresh.probability);
  assert.ok(owes.reasons.includes('owes a balance'));
});

test('no-show model: with little history it stays near the usual rate, says so, and has low confidence', () => {
  const r = predictNoShow({ practice: stats(5, 1), patient: record(), first_visit: true, first_visit_stats: stats(2, 0), confirmed: null });
  assert.equal(r.confidence, 'low');
  assert.ok(r.reasons.some((x) => /not much history yet/.test(x)), JSON.stringify(r.reasons));
  assert.ok(Math.abs(r.probability - PRIORS.no_show) < 0.06, `${r.probability} near ${PRIORS.no_show}`);
  // No history at all.
  const none = predictNoShow({ practice: stats(0, 0), patient: record() });
  assert.ok(none.probability > 0.05 && none.probability < 0.12);
  // A group that's all misses can't decide it alone (capped shift).
  const extreme = predictNoShow(visit(record(), { confirmed_stats: stats(600, 600) }));
  assert.ok(extreme.probability < 0.5, `${extreme.probability}`);
});

test('denial model: payer × code history orders it; a "deny" rule hit pushes it up strongly; reasons are plain', () => {
  const base = { practice: stats(3000, 150), payer_stats: stats(800, 50), labels: { payer: 'Delta Dental' } };
  const bad = predictDenial({ ...base, code: 'D2950', code_stats: stats(40, 12), payer_code_stats: stats(8, 5), narrative: false, payer_code_narr_stats: stats(8, 5) });
  const good = predictDenial({ ...base, code: 'D1110', code_stats: stats(900, 9), payer_code_stats: stats(300, 2), narrative: false, payer_code_narr_stats: stats(300, 2) });
  assert.ok(bad.probability > good.probability * 5, `${bad.probability} vs ${good.probability}`);
  assert.equal(bad.reasons[0], 'Delta Dental has denied 5 of 8 D2950 sent without a narrative');
  assert.equal(good.confidence, 'high');
  const ruled = predictDenial({ ...base, code: 'D1110', code_stats: stats(900, 9), payer_code_stats: stats(300, 2), rules: { deny: 1, narrative: 0, warn: 0 }, labels: { ...base.labels, first_rule: 'Frequency: 2 per year — used' } });
  assert.ok(ruled.probability > good.probability * 5 && ruled.probability > 0.05, `${ruled.probability}`);
  assert.equal(ruled.reasons[0], 'Frequency: 2 per year — used');
  for (const r of [bad, good, ruled]) assert.ok(r.probability > 0 && r.probability < 1);
  // Little history: the usual rate, low confidence, and it says so.
  const thin = predictDenial({ code: 'D2950', practice: stats(4, 0), labels: { payer: 'Acme' } });
  assert.equal(thin.confidence, 'low');
  assert.ok(Math.abs(thin.probability - PRIORS.denial) < 0.03);
  assert.ok(thin.reasons.some((x) => /not much claim history yet/.test(x)));
  assert.equal(smoothed(stats(0, 0), 0.2, 10), 0.2);
});

test('claim level: the chance at least one line is denied, with what the lines share counted once', () => {
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  close(claimChance([0.3], 0.1), 0.3, 'one line: that line');
  close(claimChance([0.3], 0.6), 0.3, 'one line, even when the shared part is higher');
  close(claimChance([0.3, 0.2], 0), 1 - 0.7 * 0.8, 'nothing shared: the independent product');
  close(claimChance([0.3, 0.2, 0.1], 0.5), 0.3, 'everything shared: the riskiest line');
  // 32% and 15% with 5% shared: the second line adds 1 − 0.85/0.95 ≈ 10.5%, not 15%.
  close(claimChance([0.32, 0.15], 0.05), 1 - 0.68 * (0.85 / 0.95), 'shared part once');
  assert.equal(claimChance([], 0.1), null);
  // Bounds and monotonicity on many random claims.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 2000; k++) {
    const n = 1 + Math.floor(rand() * 5);
    const ps = Array.from({ length: n }, () => Math.round(rand() * 90) / 100);
    const q = Math.round(rand() * 40) / 100;
    const c = claimChance(ps, q);
    const indep = 1 - ps.reduce((x, p) => x * (1 - p), 1);
    assert.ok(c >= Math.max(...ps) - 1e-12 && c <= indep + 1e-12, `${JSON.stringify(ps)} q=${q}: ${c} within [${Math.max(...ps)}, ${indep}]`);
    const i = Math.floor(rand() * n);
    const up = ps.map((p, j) => (j === i ? Math.min(0.95, p + 0.05) : p));
    assert.ok(claimChance(up, q) >= c - 1e-12, `raising a line never lowers the claim: ${JSON.stringify(ps)} → ${JSON.stringify(up)}`);
    assert.ok(claimChance([...ps, rand() * 0.5], q) >= c - 1e-12, 'adding a line never lowers it');
    assert.ok(claimChance(ps, Math.min(0.9, q + 0.1)) <= c + 1e-12, 'more shared, never higher');
  }
  // The shared part: a payer that turns down whole claims more often shares more; a rule on every line adds to it.
  const quiet = sharedDenial({ practice: stats(3000, 60), payer: stats(500, 5) });
  const harsh = sharedDenial({ practice: stats(3000, 60), payer: stats(500, 80) });
  assert.ok(harsh > quiet * 3, `${harsh} vs ${quiet}`);
  assert.ok(sharedDenial({ practice: stats(3000, 60), payer: stats(500, 5) }, 1) > quiet * 5, 'a filing limit on every line is about the claim (the same push a line gets from it)');
  assert.ok(Math.abs(sharedDenial({}) - PRIORS.whole_claim) < 0.005, 'no history: the typical rate');
  // A payer with only four claims, all turned down whole, can't push a clean two-line claim near certain.
  const few = { practice: stats(3000, 150), payer_stats: stats(8, 8), labels: { payer: 'Acme' }, narrative: true, payer_code_stats: stats(4, 4), payer_code_narr_stats: stats(4, 4) };
  const l1 = predictDenial({ ...few, code: 'D2391', code_stats: stats(400, 12) });
  const l2 = predictDenial({ ...few, code: 'D1110', code_stats: stats(900, 9) });
  const smallPayer = sharedDenial({ practice: stats(3000, 60), payer: stats(8, 8) });
  assert.ok(smallPayer < 0.2, `shared part from 4 claims: ${smallPayer}`);
  const two = claimChance([l1.probability, l2.probability], smallPayer);
  assert.ok(two < 0.85, `4 of 4 whole-claim denials, 2 clean lines: ${two}`);
  // Rule hits on every line are claim-wide; on one line they are that line's.
  const items = [{ id: 1 }, { id: 2 }];
  const filing = 'Service date 2025-01-01 is past this payer’s 90-day filing limit';
  assert.equal(claimWideDenyRules(items, [{ level: 'deny', procedure_id: 1, message: filing }, { level: 'deny', procedure_id: 2, message: filing }]), 1);
  assert.equal(claimWideDenyRules(items, [{ level: 'deny', procedure_id: 1, message: 'Tooth number is missing' }]), 0);
  assert.equal(claimWideDenyRules([{ id: 1 }], [{ level: 'deny', procedure_id: 1, message: filing }]), 0, 'one line: nothing to share');
  // The claim's own answer names its riskiest line.
  const lvl = claimLevel([{ procedure_id: 1, code: 'D2950', tooth: '3', probability: 0.32, percent: 32, reasons: ['x'] }, { procedure_id: 2, code: 'D2391', tooth: '19', probability: 0.15, percent: 15, reasons: [] }], 0.05);
  assert.deepEqual([lvl.percent, lvl.line_count, lvl.riskiest.code, lvl.riskiest.percent, lvl.code, lvl.reasons[0]], [39, 2, 'D2950', 32, 'D2950', 'x']);
});

test('denial model: a small sample (4 of 4) can’t by itself push a line past ~70%; a hard rule hit still can', () => {
  const small = { code: 'D2950', practice: stats(3000, 150), payer_stats: stats(4, 4), code_stats: stats(40, 4), payer_code_stats: stats(4, 4), labels: { payer: 'Acme' } };
  for (const narrative of [null, false]) {
    const f = { ...small, narrative, payer_code_narr_stats: narrative === false ? stats(4, 4) : null };
    const plain = predictDenial(f);
    assert.ok(plain.probability < 0.7, `4 of 4, no rule hit (narrative ${narrative}): ${plain.probability}`);
    assert.ok(plain.probability > 0.2, `still well above the office’s usual 5%: ${plain.probability}`);
    const ruled = predictDenial({ ...f, rules: { deny: 1, narrative: 0, warn: 0 }, labels: { payer: 'Acme', first_rule: 'Frequency: 1 per 5 years — used' } });
    assert.ok(ruled.probability >= 0.85, `with a deny rule hit: ${ruled.probability}`);
  }
});

test('calibration: bins compare what was said with what happened', () => {
  const c = calibrate([{ p: 0.05, y: 0 }, { p: 0.35, y: 1 }, { p: 0.32, y: 0 }, { p: 0.7, y: 1 }]);
  assert.equal(c.n, 4);
  const b30 = c.bins.find((b) => b.from === 30);
  assert.deepEqual([b30.n, b30.predicted, b30.actual], [2, 33.5, 50]);
  assert.equal(c.actual_rate, 50);
});

// ---------------------------------------------------------------- against the database
const at = (d, t = '09:00') => `${d} ${t}`;
async function appt(p, patientId, date, status, extra = {}) {
  const r = await h.db.run(
    'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, created_at, confirmed_at, broken_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    p.practiceId, patientId, p.provider.id, at(date, extra.time || '09:00'), at(date, extra.end || '10:00'), status, `${addDays(date, -(extra.lead ?? 30))} 12:00:00`, extra.confirmed_at ?? null,
    extra.broken_reason ?? (status === 'no_show' ? 'no_contact' : null),
  );
  return r.id;
}
const newPatient = async (p, first) => (await p.api.post('/patients', { first_name: first, last_name: 'Riskwell', dob: '1980-05-06', phone: '(512) 555-0199', email: `${first.toLowerCase()}@example.com` })).data;

let A; // the practice most tests use, with a known history
async function practiceA() {
  if (A) return A;
  const p = await h.practice();
  const today = (await practiceNow(h.db, p.practiceId)).slice(0, 10);
  const tomorrow = addDays(today, 1);
  const x = await newPatient(p, 'Misses');
  const y = await newPatient(p, 'Always');
  const z = await newPatient(p, 'Newbie');
  await appt(p, x.id, addDays(today, -150), 'completed');
  for (const d of [-100, -60, -20]) await appt(p, x.id, addDays(today, d), 'no_show');
  for (let i = 1; i <= 8; i++) await appt(p, y.id, addDays(today, -i * 80), 'completed');
  const vx = await appt(p, x.id, tomorrow, 'scheduled', { time: '09:00', end: '10:00' });
  const vy = await appt(p, y.id, tomorrow, 'scheduled', { time: '10:00', end: '11:00' });
  const vz = await appt(p, z.id, tomorrow, 'scheduled', { time: '11:00', end: '12:00' });
  clearPredictCache();
  A = { ...p, today, tomorrow, x, y, z, vx, vy, vz };
  return A;
}

test('schedule and visit panel: each upcoming visit carries a no-show percentage with reasons', async () => {
  const p = await practiceA();
  const res = await p.api.get(`/schedule?from=${p.tomorrow}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const by = Object.fromEntries(res.data.appointments.map((a) => [a.id, a.no_show_risk]));
  const [rx, ry, rz] = [by[p.vx], by[p.vy], by[p.vz]];
  assert.ok(rx && ry && rz, JSON.stringify(by));
  assert.ok(rx.percent > ry.percent && rx.percent > rz.percent, `${rx.percent} ${ry.percent} ${rz.percent}`);
  assert.notEqual(rx.level, 'low');
  assert.match(rx.reasons.join(' '), /3 missed visits in the past year/);
  assert.equal(rx.driver, 'builtin');
  assert.equal(rx.confidence, 'low', 'a new practice with a dozen visits has little history');
  assert.ok(rx.reasons.some((r) => /not much history yet/.test(r)));
  assert.equal(rx.factors, undefined, 'screens get the numbers and the words only');
  // The visit panel's own read.
  const one = await p.api.get(`/appointments/${p.vx}`);
  assert.equal(one.data.no_show_risk.percent, rx.percent);
  // A past or finished visit gets none.
  const past = await p.api.get(`/schedule?from=${addDays(p.today, -20)}&include_cancelled=true`);
  assert.ok(past.data.appointments.every((a) => a.no_show_risk === null));
  // Predictions never act: nothing about the visits changed.
  const after = await h.db.all('SELECT status FROM appointments WHERE id IN (?, ?, ?)', p.vx, p.vy, p.vz);
  assert.deepEqual(after.map((a) => a.status), ['scheduled', 'scheduled', 'scheduled']);
});

test('optimizer: Double-confirm uses the predicted probability', async () => {
  const p = await practiceA();
  const day = await loadDay(h.db, { id: null, practice_id: p.practiceId, role: 'admin', location_ids: null }, { date: p.tomorrow, withFinder: false });
  assert.equal(day.noShow[p.vx].percent > day.noShow[p.vy].percent, true);
  const opps = confirmOpportunities(day);
  const o = opps.find((x) => x.appointment_id === p.vx);
  assert.ok(o, JSON.stringify(opps));
  assert.match(o.detail, new RegExp(`^No-show risk ${day.noShow[p.vx].percent}% — `));
  assert.ok(!opps.some((x) => x.appointment_id === p.vy), 'a patient who always comes is left alone');
});

test('practice isolation: another practice’s history never changes this one’s predictions', async () => {
  const p = await practiceA();
  const rows = await h.db.all('SELECT * FROM appointments WHERE id IN (?, ?, ?)', p.vx, p.vy, p.vz);
  clearPredictCache();
  const before = await noShowRisks(h.db, p.practiceId, rows);
  // Practice B: everyone misses everything.
  const b = await h.practice();
  const bToday = (await practiceNow(h.db, b.practiceId)).slice(0, 10);
  for (let i = 0; i < 6; i++) {
    const pt = await newPatient(b, `Bmiss${i}`);
    for (let k = 1; k <= 6; k++) await appt(b, pt.id, addDays(bToday, -k * 25), 'no_show');
  }
  const bNew = await newPatient(b, 'Bnew');
  const bv = await appt(b, bNew.id, addDays(bToday, 1), 'scheduled');
  clearPredictCache();
  const afterB = await noShowRisks(h.db, p.practiceId, rows);
  for (const id of [p.vx, p.vy, p.vz]) assert.equal(afterB.get(id).probability, before.get(id).probability, `visit ${id}`);
  // And B's own base rate is B's.
  const bRisk = (await noShowRisks(h.db, b.practiceId, await h.db.all('SELECT * FROM appointments WHERE id = ?', bv))).get(bv);
  assert.ok(bRisk.base_rate > before.get(p.vz).base_rate, `${bRisk.base_rate} > ${before.get(p.vz).base_rate}`);
  // The route refuses the other practice's visit.
  const cross = await p.api.get(`/predict/no-show/${bv}`);
  assert.equal(cross.status, 404);
  const own = await p.api.get(`/predict/no-show/${p.vx}`);
  assert.equal(own.status, 200);
  assert.equal(own.data.prediction.percent, before.get(p.vx).percent);
});

// Denial history: claims answered by the payer (inserted directly, as if from years of billing).
async function historyClaim(p, { policyId, code, status, daysAgo = 400, tooth = '3', paid = null }) {
  const pc = await h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', p.practiceId, code);
  const when = `${addDays(p.today, -daysAgo)} 10:00:00`;
  const proc = await h.db.run(
    "INSERT INTO procedures (practice_id, patient_id, provider_id, code_id, code, description, category, tooth, surfaces, fee, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)",
    p.practiceId, p.histPatient.id, p.provider.id, pc.id, code, pc.description, pc.category, tooth, 'O', 20000, when,
  );
  const claim = await h.db.run('INSERT INTO claims (practice_id, patient_id, patient_insurance_id, status, total_fee, created_at) VALUES (?, ?, ?, ?, ?, ?)', p.practiceId, p.histPatient.id, policyId, status, 20000, when);
  await h.db.run('INSERT INTO claim_items (claim_id, procedure_id, fee, estimated_amount, paid_amount) VALUES (?, ?, ?, ?, ?)', claim.id, proc.id, 20000, 12000, paid ?? (status === 'denied' ? 0 : 12000));
  return claim.id;
}
let D;
async function denialPractice() {
  if (D) return D;
  const p = await h.practice();
  p.today = (await practiceNow(h.db, p.practiceId)).slice(0, 10);
  p.carrier = (await p.api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  p.histPatient = await newPatient(p, 'History');
  const hp = (await p.api.post(`/patients/${p.histPatient.id}/insurance`, { carrier_id: p.carrier.id, subscriber_name: 'History Riskwell', subscriber_id: 'H-1' })).data;
  for (let i = 0; i < 8; i++) await historyClaim(p, { policyId: hp.id, code: 'D2950', status: i < 5 ? 'denied' : 'paid', daysAgo: 300 + i });
  for (let i = 0; i < 12; i++) await historyClaim(p, { policyId: hp.id, code: 'D2391', status: 'paid', daysAgo: 300 + i });
  p.target = await newPatient(p, 'Target');
  p.policy = (await p.api.post(`/patients/${p.target.id}/insurance`, { carrier_id: p.carrier.id, subscriber_name: 'Target Riskwell', subscriber_id: 'T-1', group_number: 'G1' })).data;
  p.buildup = (await p.api.post(`/patients/${p.target.id}/procedures`, { code: 'D2950', tooth: '30', provider_id: p.provider.id })).data;
  p.filling = (await p.api.post(`/patients/${p.target.id}/procedures`, { code: 'D2391', tooth: '19', surfaces: 'O', provider_id: p.provider.id })).data;
  clearPredictCache();
  D = p;
  return p;
}

test('treatment plan: denial percentage per planned procedure, from this payer’s history with the code', async () => {
  const p = await denialPractice();
  const res = await p.api.get(`/predict/denial?patient_id=${p.target.id}&procedure_ids=${p.buildup.id},${p.filling.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const by = Object.fromEntries(res.data.lines.map((l) => [l.code, l]));
  assert.ok(by.D2950.probability > by.D2391.probability * 3, `${by.D2950.probability} vs ${by.D2391.probability}`);
  assert.match(by.D2950.reasons.join(' '), /Delta Dental has denied 5 of 8 D2950/);
  // The claim as a whole: at least as likely as its riskiest line, no more than the lines as if independent.
  const c = res.data.claim;
  assert.equal(c.riskiest.code, 'D2950');
  assert.equal(c.line_count, 2);
  assert.ok(c.probability >= by.D2950.probability && c.probability <= 1 - (1 - by.D2950.probability) * (1 - by.D2391.probability) + 0.01, JSON.stringify(c));
  assert.equal(res.data.carrier_name, 'Delta Dental');
  // Validation: ids must be real, and belong to this practice.
  assert.equal((await p.api.get(`/predict/denial?patient_id=${p.target.id}&procedure_ids=abc`)).status, 400);
  assert.equal((await p.api.get(`/predict/denial?patient_id=${p.target.id}`)).status, 400);
  const other = await practiceA();
  assert.equal((await other.api.get(`/predict/denial?patient_id=${p.target.id}&procedure_ids=${p.buildup.id}`)).status, 404);
  // A patient without insurance: nothing to predict.
  const cash = await newPatient(p, 'Cash');
  const cp = (await p.api.post(`/patients/${cash.id}/procedures`, { code: 'D2950', tooth: '3', provider_id: p.provider.id })).data;
  const none = await p.api.get(`/predict/denial?patient_id=${cash.id}&procedure_ids=${cp.id}`);
  assert.equal(none.data.no_insurance, true);
});

test('Ready to approve and the claim screen show the denial percentage next to the rule checks', async () => {
  const p = await denialPractice();
  const done = (await p.api.post(`/patients/${p.target.id}/procedures`, { code: 'D2950', tooth: '14', provider_id: p.provider.id, complete: true })).data;
  const q = await p.api.get('/claim-queue');
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const g = q.data.groups.find((x) => x.patient_id === p.target.id);
  assert.ok(g?.denial?.claim, JSON.stringify(g));
  assert.equal(g.denial.lines[0].procedure_id, done.id);
  assert.ok(g.denial.claim.percent >= 30, `${g.denial.claim.percent}`);
  assert.match(g.denial.claim.reasons.join(' '), /Delta Dental has denied 5 of 8 D2950/);
  assert.ok(g.fixes.some((f) => f.kind === 'narrative'), 'the rule messages are still there');
  // Approving is still a person's call (a narrative is still asked for); nothing was held or made by the prediction.
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM claims WHERE patient_id = ?', p.target.id)).n), 0);

  // A saved claim's checks carry it too.
  const claim = (await p.api.post('/claims', { patient_id: p.target.id, patient_insurance_id: p.policy.id, procedure_ids: [done.id] })).data;
  assert.ok(claim.id, JSON.stringify(claim));
  const v = await p.api.get(`/claims/${claim.id}/validate`);
  assert.equal(v.status, 200);
  assert.ok(v.data.risks.length, 'rule messages kept');
  assert.equal(v.data.denial.claim.code, 'D2950');
  const s = await p.api.get(`/claims/${claim.id}/scrub`);
  assert.equal(s.data.denial.claim.percent, v.data.denial.claim.percent);
});

test('accuracy report: predicted vs what happened, reports permission only, validated', async () => {
  const p = await practiceA();
  // Six months of history in the window, and some before it to learn from.
  for (let i = 0; i < 10; i++) {
    const pt = await newPatient(p, `Cal${i}`);
    for (let k = 1; k <= 6; k++) await appt(p, pt.id, addDays(p.today, -k * 45), i < 3 && k % 2 ? 'no_show' : 'completed');
  }
  const r = await p.api.get('/predict/accuracy?kind=no_show&months=6');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.n > 20, JSON.stringify(r.data));
  assert.equal(r.data.bins.reduce((s, b) => s + b.n, 0), r.data.n);
  assert.ok(r.data.actual_rate > 0);
  const d = await p.api.get('/predict/accuracy?kind=denial&months=3');
  assert.equal(d.status, 200);
  assert.equal((await p.api.get('/predict/accuracy?kind=other')).status, 400);
  assert.equal((await p.api.get('/predict/accuracy?months=99')).status, 400);
  assert.equal((await p.api.get('/predict/status')).data.driver, 'builtin');
});

test('permissions: front desk sees visits’ risk; no reports → no accuracy; assistants can’t read denial risk', async () => {
  const p = await practiceA();
  const as = async (role) => {
    const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
    assert.equal((await p.api.post('/users', { name: role, email, password: 'correct-horse-battery', role })).status, 201);
    return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  };
  const desk = await as('front_desk');
  assert.equal((await desk.get(`/predict/no-show/${p.vx}`)).status, 200);
  assert.equal((await desk.get('/predict/accuracy')).status, 403);
  assert.equal((await desk.get('/predict/status')).status, 403);
  const assistant = await as('assistant');
  assert.equal((await assistant.get(`/predict/denial?patient_id=${p.x.id}&procedure_ids=1`)).status, 403);
  assert.equal((await h.client().get(`/predict/no-show/${p.vx}`)).status, 401);
});

// ---------------------------------------------------------------- the Jev vendor (sandbox)
test('Jev: only de-identified, whitelisted features leave — no names, birth dates, phones, emails or record ids', async () => {
  const p = await practiceA();
  const bodies = [];
  const capture = async (url, opts) => {
    bodies.push({ url, body: opts.body });
    const items = JSON.parse(opts.body).items;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: items.map((i) => ({ ref: i.ref, value: { probability: 0.33 } })) }) };
  };
  registerPredictor(createPredictor({ db: h.db, config: { predict: { driver: 'jev', jev: { mode: 'sandbox', sandboxFetch: capture } } } }));
  try {
    const rows = await h.db.all('SELECT * FROM appointments WHERE id IN (?, ?, ?)', p.vx, p.vy, p.vz);
    const risks = await noShowRisks(h.db, p.practiceId, rows);
    assert.equal(risks.get(p.vx).driver, 'jev');
    assert.equal(risks.get(p.vx).percent, 33);
    assert.ok(risks.get(p.vx).reasons.length, 'the reasons still come from the office’s own history');
    const d = await denialPractice();
    const den = await d.api.get(`/predict/denial?patient_id=${d.target.id}&procedure_ids=${d.buildup.id}`);
    assert.equal(den.data.claim.driver, 'jev');
    assert.equal(bodies.length, 2);
    for (const [i, { body }] of bodies.entries()) {
      const kind = i === 0 ? 'no_show' : 'denial';
      for (const bad of ['Misses', 'Always', 'Newbie', 'Target', 'Riskwell', '1980-05-06', '555-0199', '@example.com', 'Delta', 'patient_id', 'appointment_id', 'procedure_id', '"id"', 'labels', 'reason']) {
        assert.ok(!body.includes(bad), `${kind} payload contains ${bad}: ${body}`);
      }
      const parsed = JSON.parse(body);
      for (const it of parsed.items) {
        assert.match(it.ref, /^r\d+$/, 'opaque references only');
        for (const k of Object.keys(it.features)) assert.ok(k in JEV_FIELDS[kind], `${k} is whitelisted`);
      }
    }
    // The whitelist drops anything else, however it got there.
    const f = deidentify('no_show', { patient_id: 9, first_name: 'Ann', dob: '1990-01-01', patient: { missed_w: 1, name: 'x' }, weekday: 'Monday' });
    assert.deepEqual(f, { patient: { missed_w: 1 }, weekday: 'Monday' });
  } finally {
    registerPredictor(null);
  }
});

test('Jev failing: the built-in answer is used, it shows in Needs attention, and resolves when Jev answers again', async () => {
  const p = await practiceA();
  let up = false;
  const flaky = async (url, opts) => {
    if (!up) throw new Error('connect ECONNREFUSED');
    const items = JSON.parse(opts.body).items;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: items.map((i) => ({ ref: i.ref, value: { probability: 0.2 } })) }) };
  };
  const predictor = createPredictor({ db: h.db, config: { predict: { driver: 'jev', jev: { mode: 'sandbox', sandboxFetch: flaky } } } });
  registerPredictor(predictor);
  const openIssue = () => h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", p.practiceId, ISSUE_KEY);
  try {
    const rows = await h.db.all('SELECT * FROM appointments WHERE id = ?', p.vx);
    const down = (await noShowRisks(h.db, p.practiceId, rows)).get(p.vx);
    assert.equal(down.driver, 'builtin');
    assert.equal(down.fallback, true);
    assert.ok(down.probability > 0 && down.probability < 1);
    const issue = await openIssue();
    assert.ok(issue, 'a Needs attention item');
    assert.match(issue.title, /Jev didn’t answer/);
    assert.match(issue.detail, /ECONNREFUSED/);
    // The schedule still loads (with the built-in numbers) while it's down.
    const sched = await p.api.get(`/schedule?from=${p.tomorrow}`);
    assert.equal(sched.status, 200);
    assert.equal(sched.data.appointments.find((a) => a.id === p.vx).no_show_risk.driver, 'builtin');
    up = true;
    predictor.reset();
    const back = (await noShowRisks(h.db, p.practiceId, rows)).get(p.vx);
    assert.equal(back.driver, 'jev');
    assert.equal(back.percent, 20);
    assert.equal(await openIssue(), undefined, 'resolved by the next success');
    const resolved = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'resolved'", p.practiceId, ISSUE_KEY);
    assert.match(resolved.resolution, /Jev answered again/);
  } finally {
    registerPredictor(null);
  }
});

test('Jev live mode refuses to send anything without a signed BAA (and falls back)', async () => {
  let called = 0;
  const jev = createJev({ mode: 'live', url: 'https://jev.example', key: 'k', baa: false }, async () => { called++; throw new Error('should not be called'); });
  await assert.rejects(() => jev.predictMany('no_show', [{}]), /BAA/);
  assert.equal(called, 0);
  const p = await practiceA();
  registerPredictor(createPredictor({ db: h.db, config: { predict: { driver: 'jev', jev: { mode: 'live', url: 'https://jev.example', key: 'k', baa: false } } } }));
  try {
    const rows = await h.db.all('SELECT * FROM appointments WHERE id = ?', p.vy);
    const r = (await noShowRisks(h.db, p.practiceId, rows)).get(p.vy);
    assert.equal(r.driver, 'builtin');
    const issue = await h.db.get("SELECT detail FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", p.practiceId, ISSUE_KEY);
    assert.match(issue.detail, /BAA/);
  } finally {
    registerPredictor(null);
    assert.equal(getPredictor().driver, 'builtin', 'back to the default');
  }
});
