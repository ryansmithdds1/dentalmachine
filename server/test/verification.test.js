// Insurance verification center (IV1–IV4): automatic checks before each visit, full breakdowns from the 271,
// documents read by AI and confirmed by a person, group-wide plan updates with their guard, exceptions,
// verified by phone, texting the patient for new insurance, metrics, isolation and permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { parse271Detail } from '../src/benefitdetail.js';
import { createEligibility } from '../src/eligibility.js';
import { runVerificationAutomation, exceptionsFor, breakdownState, VERIFY_DEFAULTS, addDays } from '../src/verification.js';
import { localNow } from '../src/util.js';

const h = harness();

const x271 = (lines) => ['ISA*00*          *00*          *ZZ*PAYER          *ZZ*US             *240101*1200*^*00501*000000001*0*P*:', 'GS*HB*P*U*20240101*1200*1*X*005010X279A1',
  'ST*271*0001*005010X279A1', ...lines, 'SE*40*0001', 'GE*1*1', 'IEA*1*000000001'].join('~') + '~';

// A payer that sends the whole breakdown, service type by service type.
const FULL = (group = 'G100') => x271([
  'NM1*PR*2*DELTA DENTAL*****PI*94276', 'NM1*IL*1*DOE*JANE****MI*W1', 'DMG*D8*19850412', `REF*6P*${group}*ACME PPO`, 'DTP*346*RD8*20260101-20261231',
  'EB*1*IND*35**ACME PPO',
  'EB*C*IND*35***23*50.00', 'EB*C*IND*35***29*20.00', 'EB*C*FAM*35***23*150.00',
  'EB*F*IND*35***23*2000.00', 'EB*F*IND*35***29*1600.00', 'EB*F*IND*35***24*400.00',
  'EB*A*IND*41*****0', 'EB*A*IND*23*****0',
  'EB*A*IND*25*****.2', 'MSG*WAITING PERIOD 6 MONTHS FOR BASIC SERVICES',
  'EB*A*IND*26*****.5', 'EB*A*IND*24*****.2', 'EB*A*IND*40*****.2',
  'EB*A*IND*36*****.5', 'DTP*348*D8*20270101', 'EB*A*IND*39*****.5',
  'EB*A*IND*38*****.5', 'EB*F*IND*38***32*1000.00', 'MSG*ORTHO TO AGE 19',
  'MSG*MISSING TOOTH CLAUSE APPLIES',
  'EB*F*IND*41**********AD:D1110', 'HSD*VS*2***22', 'DTP*304*D8*20260302',
  'EB*F*IND*41**********AD:D0274', 'HSD*VS*1***34*12',
  'EB*A*IND*25*****.5****N', // out of network: not the plan's figures
]);

test('271 benefit detail: percentages by service type, maximums used and left, deductibles, frequencies, waiting periods, identity', () => {
  const d = parse271Detail(FULL());
  assert.equal(d.active, true);
  assert.equal(d.complete, true);
  assert.deepEqual([d.plan.pct_preventive, d.plan.pct_basic, d.plan.pct_major], [100, 80, 50]);
  assert.deepEqual(d.plan.coverage_overrides, { D3: 50 }, 'endodontics paid differently from basic becomes an override; perio and oral surgery match');
  assert.deepEqual([d.plan.annual_max, d.plan.deductible, d.plan.family_deductible], [200000, 5000, 15000]);
  assert.deepEqual([d.plan.ortho_max, d.plan.ortho_pct, d.plan.ortho_age_limit], [100000, 50, 19]);
  assert.equal(d.plan.wait_basic_months, 6, 'from the message after the basic EB');
  assert.equal(d.plan.wait_major_months, 12, 'crowns begin a year after coverage (DTP*348)');
  assert.equal(d.plan.missing_tooth_clause, 1);
  assert.equal(d.plan.benefit_month, 1, 'calendar-year figures');
  assert.deepEqual(d.plan.frequencies, [{ codes: ['D1110'], count: 2, per: 'benefit_year' }, { codes: ['D0274'], count: 1, months: 12 }]);
  assert.deepEqual([d.patient.max_used, d.patient.max_remaining, d.patient.deductible_remaining, d.patient.deductible_met], [40000, 160000, 2000, 3000]);
  assert.deepEqual(d.patient.history, [{ codes: ['D1110'], date: '2026-03-02' }]);
  assert.deepEqual([d.patient.plan_begin, d.patient.plan_end], ['2026-01-01', '2026-12-31']);
  assert.deepEqual([d.identity.group_number, d.identity.member_id, d.identity.subscriber_dob, d.identity.payer_name], ['G100', 'W1', '1985-04-12', 'DELTA DENTAL']);
  assert.ok(d.categories.find((c) => c.service_type === '26' && c.pct === 50));

  // Eligibility only (no percentages): not a full breakdown.
  const thin = parse271Detail(x271(['EB*1*IND*35**PPO', 'EB*F*IND*35***23*1500.00', 'DTP*347*D8*20261015']));
  assert.equal(thin.complete, false);
  assert.equal(thin.patient.plan_end, '2026-10-15');
  // Crowns keep their own rate when restorative is overridden.
  const odd = parse271Detail(x271(['EB*1*IND*35', 'EB*A*IND*36*****.5', 'EB*A*IND*26*****.2', 'EB*A*IND*25*****.4', 'EB*A*IND*24*****.2']));
  assert.equal(odd.plan.pct_basic, 60);
  assert.deepEqual(odd.plan.coverage_overrides, { D3: 80, D4: 80 }, 'the tier follows restorative; endo and perio differ');
  const ortho = parse271Detail(x271(['EB*1*IND*35', 'EB*I*IND*38']));
  assert.equal(ortho.plan.ortho_max, 0, 'orthodontics not covered');
});

// ---- helpers ----
const user = async (api, role, extra = {}) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const made = await api.post('/users', { email, name: `${role} person`, role, password: `${role}-password-123`, ...extra });
  const login = await h.client().post('/auth/login', { email, password: `${role}-password-123` });
  return { api: h.client(login.data.token), id: made.data.id };
};
const today = () => localNow('UTC').slice(0, 10);
async function setup(extra = {}) {
  const ctx = await h.practice({ timezone: 'UTC', ...extra });
  const carrier = (await ctx.api.post('/carriers', { name: 'Delta Dental', payer_id: '94276', phone: '(800) 555-0199' })).data;
  const insure = async (patient, body = {}) => (await ctx.api.post(`/patients/${patient.id}/insurance`, {
    carrier_id: carrier.id, subscriber_name: `${patient.first_name} ${patient.last_name}`, subscriber_id: `W${patient.id}`, group_number: 'G100', annual_max: 150000, deductible: 5000, pct_basic: 80, pct_major: 50, ...body,
  })).data;
  const person = async (first, extraP = {}) => (await ctx.api.post('/patients', { first_name: first, last_name: 'Test', dob: '1980-02-03', phone: '(512) 555-0111', ...extraP })).data;
  const book = async (patient, date, time = '10:00') => (await ctx.api.post('/appointments', { patient_id: patient.id, provider_id: ctx.provider.id, start_time: `${date} ${time}`, end_time: `${date} ${time.slice(0, 2)}:30`, override_blockout: true })).data;
  return { ...ctx, carrier, insure, person, book, pid: (await ctx.api.get('/practice')).data.id };
}
const plan = async (id) => h.db.get('SELECT * FROM insurance_plans WHERE id = ?', id);
const policyRow = (id) => h.db.get('SELECT * FROM patient_insurance WHERE id = ?', id);

test('automatic checks: days ahead and the morning of, each once; failures retried then raised', async () => {
  const ctx = await setup();
  await ctx.api.put('/verification/settings', { days_ahead: 3, morning_of: true, morning_hour: 6 });
  const [a, b, c, d] = [await ctx.person('Today'), await ctx.person('Plus3'), await ctx.person('Plus7'), await ctx.person('Cash')];
  const [pa, pb, pc] = [await ctx.insure(a), await ctx.insure(b), await ctx.insure(c)];
  // Monday 2031-03-10; visits today at 15:00, Thursday (+3), the next Monday (+7), and one without insurance.
  const ins = async (p, when) => h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", ctx.pid, p.id, ctx.provider.id, when, `${when.slice(0, 11)}${String(Number(when.slice(11, 13))).padStart(2, '0')}:45`);
  await ins(a, '2031-03-10 15:00');
  await ins(b, '2031-03-13 09:00');
  await ins(c, '2031-03-17 09:00');
  await ins(d, '2031-03-11 09:00');
  const elig = createEligibility({ db: h.db, config: { ediMode: 'sandbox' } });
  const checks = async (policy) => (await h.db.get('SELECT COUNT(*) AS n FROM eligibility_checks WHERE patient_insurance_id = ?', policy.id)).n;
  const runs = (policy) => h.db.all('SELECT run_window, visit_date, status FROM verification_runs WHERE patient_insurance_id = ? ORDER BY id', policy.id);

  // 5am: before the morning hour — only the days-ahead window runs.
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-10T05:00:00Z') });
  assert.equal(await checks(pa), 0, 'today’s visit waits for the morning run');
  assert.equal(await checks(pb), 1, 'three days ahead: checked');
  assert.equal(await checks(pc), 0, 'a week out: not yet');
  // 7am: the morning-of run for today's visit.
  const morning = await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-10T07:00:00Z') });
  assert.equal(await checks(pa), 1);
  assert.equal(morning.find((m) => m.practice_id === ctx.pid).windows.morning.checked, 1);
  // Again, and again: nothing more (idempotent).
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-10T07:30:00Z') });
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-10T09:00:00Z') });
  assert.deepEqual([await checks(pa), await checks(pb), await checks(pc)], [1, 1, 0]);
  assert.deepEqual(await runs(pa), [{ run_window: 'morning', visit_date: '2031-03-10', status: 'done' }]);
  // Thursday morning: B's visit day — checked again (coverage can end in between); C now three days ahead? Not yet (Mon+7 = 4 days).
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-13T06:30:00Z') });
  assert.deepEqual((await runs(pb)).map((r) => r.run_window), ['ahead', 'morning']);
  assert.equal(await checks(pb), 2);
  assert.equal(await checks(pc), 0);
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-03-14T06:30:00Z') });
  assert.equal(await checks(pc), 1, 'three days before Monday');
  // The checks are the system's own, recorded as automation.
  const [row] = await h.db.all("SELECT source, actor FROM audit_log WHERE practice_id = ? AND action = 'eligibility.auto_apply' ORDER BY id LIMIT 1", ctx.pid);
  assert.equal(row.source, 'automation');

  // A payer that's down: retried on later passes (not every pass), then one Needs attention item.
  const e = await ctx.person('Down');
  const pe = await ctx.insure(e);
  await ins(e, '2031-04-03 09:00');
  const down = { automatic: true, check: async () => { throw new Error('clearinghouse timed out'); } };
  const t0 = Date.parse('2031-03-31T08:00:00Z');
  await runVerificationAutomation(h.db, down, { now: new Date(t0) });
  await runVerificationAutomation(h.db, down, { now: new Date(t0 + 5 * 60_000) });
  let run = await h.db.get('SELECT * FROM verification_runs WHERE patient_insurance_id = ?', pe.id);
  assert.deepEqual([run.status, run.attempts], ['failed', 1], 'not retried five minutes later');
  await runVerificationAutomation(h.db, down, { now: new Date(t0 + 31 * 60_000) });
  await runVerificationAutomation(h.db, down, { now: new Date(t0 + 62 * 60_000) });
  run = await h.db.get('SELECT * FROM verification_runs WHERE patient_insurance_id = ?', pe.id);
  assert.equal(run.attempts, 3);
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", ctx.pid, `verification-run:${pe.id}:2031-04-03`);
  assert.ok(issue, 'a visible work item after three tries');
  assert.match(issue.title, /couldn’t be checked/);
  await runVerificationAutomation(h.db, down, { now: new Date(t0 + 200 * 60_000) });
  assert.equal((await h.db.get('SELECT attempts FROM verification_runs WHERE id = ?', run.id)).attempts, 3, 'three tries at most');
  // The payer is back: the morning-of run works and the item closes.
  await runVerificationAutomation(h.db, elig, { now: new Date('2031-04-03T07:00:00Z') });
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
});

test('a full breakdown in the 271 is applied to the plan (and everyone on it), with the patient’s own amounts kept to them', async () => {
  const ctx = await setup();
  const [a, b] = [await ctx.person('Ann'), await ctx.person('Ben')];
  const [pa, pb] = [await ctx.insure(a, { subscriber_id: 'W1' }), await ctx.insure(b)];
  assert.equal(pa.plan_id, pb.plan_id, 'same carrier and group number: one plan');
  await h.db.run('UPDATE patient_insurance SET deductible_met = 1000 WHERE id = ?', pb.id);
  // A manual-mode check (pending 270) answered with the payer's file.
  const checkId = (await h.db.run("INSERT INTO eligibility_checks (practice_id, patient_id, patient_insurance_id, status) VALUES (?, ?, ?, 'pending')", ctx.pid, a.id, pa.id)).id
    ?? (await h.db.get('SELECT MAX(id) AS id FROM eligibility_checks')).id;
  const r = await ctx.api.post(`/eligibility/${checkId}/response`, FULL('G100'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = await plan(pa.plan_id);
  assert.equal(p.pct_basic, 80);
  assert.deepEqual(JSON.parse(p.coverage_overrides), { D3: 50 });
  assert.deepEqual([p.wait_basic_months, p.wait_major_months, p.ortho_max, p.ortho_age_limit, p.missing_tooth_clause, p.family_deductible], [6, 12, 100000, 19, 1, 15000]);
  assert.equal(p.annual_max, 200000);
  // Ben's policy follows the plan; his deductible met is still his own.
  const ben = await policyRow(pb.id);
  assert.equal(ben.annual_max, 200000);
  assert.equal(ben.deductible_met, 1000);
  assert.equal((await policyRow(pa.id)).deductible_met, 3000, 'Ann’s from the payer');
  const v = await h.db.get('SELECT * FROM benefit_verifications WHERE patient_insurance_id = ? ORDER BY id DESC', pa.id);
  assert.deepEqual([v.method, v.complete, v.group_status, v.patients_updated], ['electronic', 1, 'applied', 2]);
  assert.equal(JSON.parse(v.patient_detail).max_remaining, 160000);
  assert.deepEqual(JSON.parse(v.plan_changes).wait_major_months, [0, 12], 'before and after');
  const audit = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'benefits.verify' ORDER BY id DESC", ctx.pid);
  assert.equal(audit.source, 'integration', 'the payer’s answer');
  assert.deepEqual(JSON.parse(audit.changes).wait_major_months, [0, 12]);
  // Ben's breakdown shows as verified — for his plan, by the check on Ann.
  const up = (await ctx.api.get(`/patients/${b.id}/verification`)).data;
  assert.equal(up.breakdown.state, 'verified');
  assert.equal(up.breakdown.via_group, true);

  // A 271 that names another group: the plan-identity guard stops it; nothing changes and it's an exception.
  const c2 = (await h.db.run("INSERT INTO eligibility_checks (practice_id, patient_id, patient_insurance_id, status) VALUES (?, ?, ?, 'pending')", ctx.pid, a.id, pa.id)).id
    ?? (await h.db.get('SELECT MAX(id) AS id FROM eligibility_checks')).id;
  await ctx.api.post(`/eligibility/${c2}/response`, FULL('G999').replace('WAITING PERIOD 6 MONTHS', 'WAITING PERIOD 9 MONTHS'));
  assert.equal((await plan(pa.plan_id)).wait_basic_months, 6, 'unchanged');
  const summary = JSON.parse((await h.db.get('SELECT summary FROM eligibility_checks WHERE id = ?', c2)).summary);
  assert.match(summary.review.reasons.join(' '), /group G999/);
});

test('verified by phone: reference and representative required, recorded and audited; a breakdown updates the whole group but not anyone’s own amounts', async () => {
  const ctx = await setup();
  const [a, b, c] = [await ctx.person('Amy'), await ctx.person('Bo'), await ctx.person('Cy')];
  const [pa, pb, pc] = [await ctx.insure(a), await ctx.insure(b), await ctx.insure(c)];
  await h.db.run('UPDATE patient_insurance SET deductible_met = 2500 WHERE id = ?', pb.id);
  assert.equal((await ctx.api.post(`/verification/policies/${pa.id}/phone`, { active: true, rep_name: 'Maria' })).status, 400, 'reference number required');
  assert.equal((await ctx.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'R-1' })).status, 400, 'representative required');
  const r = await ctx.api.post(`/verification/policies/${pa.id}/phone`, {
    active: true, reference: 'R-123', rep_name: 'Maria', plan_end: null,
    plan: { annual_max: 200000, deductible: 5000, pct_preventive: 100, pct_basic: 70, pct_major: 50, wait_major_months: 12 },
    patient: { deductible_met: 5000, max_remaining: 150000 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.verification.group_status, r.data.verification.patients_updated], ['applied', 3], '“3 patients updated”');
  const p = await plan(pa.plan_id);
  assert.deepEqual([p.pct_basic, p.wait_major_months, p.annual_max, p.verified_source], [70, 12, 200000, 'phone']);
  assert.equal((await policyRow(pb.id)).pct_basic, 70, 'Bo on the same plan: updated at the same time');
  assert.equal((await policyRow(pc.id)).annual_max, 200000);
  assert.equal((await policyRow(pb.id)).deductible_met, 2500, 'Bo’s own deductible met untouched');
  assert.equal((await policyRow(pa.id)).deductible_met, 5000, 'Amy’s from the call');
  const check = await h.db.get('SELECT * FROM eligibility_checks WHERE id = ?', r.data.check_id);
  assert.equal(check.status, 'active');
  assert.deepEqual((({ method, reference, rep_name: rep }) => ({ method, reference, rep }))(JSON.parse(check.summary)), { method: 'phone', reference: 'R-123', rep: 'Maria' });
  const log = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'verification.phone'", ctx.pid);
  assert.match(log.reason, /Maria \(reference R-123\)/);
  assert.equal(log.source, 'human');
  const verify = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'benefits.verify' ORDER BY id DESC", ctx.pid);
  assert.deepEqual(JSON.parse(verify.changes).pct_basic, [80, 70]);
  // The list shows both statuses: how, when and by whom.
  const up = (await ctx.api.get(`/patients/${a.id}/verification`)).data;
  assert.deepEqual([up.eligibility.state, up.eligibility.how, up.eligibility.by], ['verified', 'Phone call', 'Admin']);
  assert.deepEqual([up.breakdown.state, up.breakdown.how], ['verified', 'Phone call']);
  // The AI can't record a call (it can't make one) or change a plan on its own.
  const asst = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await asst.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'X', rep_name: 'Y' })).status, 428);
});

test('group update guard: exact plan identity only; ambiguous goes to review; other plan records of the group are never changed on their own', async () => {
  const ctx = await setup();
  const [a, d] = [await ctx.person('Al'), await ctx.person('Di')];
  const pa = await ctx.insure(a);
  // Di's policy says group G200 but was put on the G100 plan: the plan may not be hers.
  const pd = await ctx.insure(d, { group_number: 'G200', plan_id: pa.plan_id });
  assert.equal(pd.plan_id, pa.plan_id);
  const r = await ctx.api.post(`/verification/policies/${pd.id}/phone`, { active: true, reference: 'R9', rep_name: 'Lee', plan: { pct_major: 40 }, patient: { deductible_met: 1234 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.verification.group_status, 'review');
  assert.match(r.data.verification.reasons[0], /group number/);
  assert.equal((await plan(pa.plan_id)).pct_major, 50, 'the plan is unchanged');
  assert.equal((await policyRow(pd.id)).deductible_met, 1234, 'her own amount still applies');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", ctx.pid, `plan-review:${r.data.verification.id}`));
  // The payer naming another group is also a stop.
  const other = await ctx.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'R10', rep_name: 'Lee', group_number: 'G777', plan: { pct_major: 45 } });
  assert.equal(other.data.verification.group_status, 'review');
  // A separate plan record with the same group number (a second option under the employer).
  const sibling = (await ctx.api.post('/insurance-plans', { carrier_id: ctx.carrier.id, group_number: 'G100', name: 'High option', pct_major: 60 })).data;
  const ok = await ctx.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'R11', rep_name: 'Kim', plan: { pct_major: 55 } });
  assert.equal(ok.data.verification.group_status, 'applied');
  assert.deepEqual(ok.data.verification.siblings.map((s) => s.id), [sibling.id], 'named, not changed');
  assert.equal((await plan(sibling.id)).pct_major, 60);
  assert.equal((await plan(pa.plan_id)).pct_major, 55);

  // The review list; a person applies it (optionally to the other record too). Once.
  const list = (await ctx.api.get('/verification/reviews')).data;
  const item = list.find((x) => x.id === r.data.verification.id);
  assert.ok(item);
  assert.deepEqual(item.proposed.pct_major, [50, 40]);
  assert.equal((await h.client(ctx.token, { 'X-Acting-For': 'assistant' }).post(`/verification/reviews/${item.id}/apply`, {})).status, 428, 'the AI needs a person’s OK');
  const applied = await ctx.api.post(`/verification/reviews/${item.id}/apply`, { plan_ids: [sibling.id], note: 'Called Delta: both options changed' });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual([(await plan(pa.plan_id)).pct_major, (await plan(sibling.id)).pct_major], [40, 40]);
  assert.equal(applied.data.patients_updated, 2);
  assert.equal((await ctx.api.post(`/verification/reviews/${item.id}/apply`, {})).status, 409);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE dedupe_key = ?', `plan-review:${item.id}`)).status, 'resolved');
  // Keep what's on file for the other one.
  const kept = await ctx.api.post(`/verification/reviews/${other.data.verification.id}/keep`, { note: 'Wrong group read out' });
  assert.equal(kept.status, 200);
  assert.equal((await h.db.get('SELECT group_status FROM benefit_verifications WHERE id = ?', other.data.verification.id)).group_status, 'kept');
});

test('a portal page or fax read by AI is only a draft until a person confirms it field by field', async () => {
  const ctx = await setup();
  const a = await ctx.person('Doc');
  const pa = await ctx.insure(a);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
  const res = await fetch(`${h.origin}/api/verification/policies/${pa.id}/read-document?filename=delta.pdf`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/pdf' }, body: pdf });
  const read = await res.json();
  assert.equal(res.status, 201, JSON.stringify(read));
  assert.equal(read.status, 'draft');
  assert.equal(read.sandbox, true);
  assert.equal(read.proposed.plan.wait_major_months, 12);
  assert.equal(read.current.wait_major_months, 0, 'shown next to what’s on file');
  assert.equal((await plan(pa.plan_id)).wait_major_months, 0, 'nothing applied yet');
  const doc = await h.db.get('SELECT * FROM documents WHERE id = ?', read.document_id);
  assert.deepEqual([doc.patient_id, doc.folder], [a.id, 'Insurance'], 'the printout is filed in the chart');
  assert.equal((await h.db.get("SELECT source FROM audit_log WHERE action = 'benefits.ai_read' AND entity_id = ?", read.id)).source, 'ai');

  assert.equal((await ctx.api.post(`/verification/reads/${read.id}/confirm`, { confirmed: [] })).status, 400, 'each field is ticked by a person');
  const asst = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await asst.post(`/verification/reads/${read.id}/confirm`, { confirmed: ['wait_major_months'] })).status, 428, 'never by the AI on its own');
  const ok = await ctx.api.post(`/verification/reads/${read.id}/confirm`, { confirmed: ['wait_major_months', 'max_remaining'], values: { wait_major_months: 6 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.edited, ['wait_major_months']);
  assert.ok(ok.data.skipped.includes('annual_max'));
  const p = await plan(pa.plan_id);
  assert.equal(p.wait_major_months, 6, 'the value the person corrected');
  assert.equal(p.missing_tooth_clause, 0, 'a field not ticked isn’t applied');
  const v = await h.db.get('SELECT * FROM benefit_verifications WHERE id = ?', ok.data.verification.id);
  assert.deepEqual([v.method, v.complete, v.document_id, v.read_id], ['document_ai', 0, read.document_id, read.id]);
  assert.equal(JSON.parse(v.patient_detail).max_remaining, read.proposed.patient.max_remaining);
  const confirmed = await h.db.get("SELECT * FROM audit_log WHERE action = 'benefits.ai_read_confirmed' AND entity_id = ?", read.id);
  assert.equal(confirmed.source, 'human');
  assert.match(confirmed.reason, /checked field by field and applied by Admin \(corrected wait_major_months\)/);
  assert.equal((await ctx.api.post(`/verification/reads/${read.id}/confirm`, { confirmed: ['annual_max'] })).status, 409, 'once');
  // An impossible value is refused before anything is claimed.
  const again = await (await fetch(`${h.origin}/api/verification/policies/${pa.id}/read-document?filename=delta.pdf`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/pdf' }, body: pdf })).json();
  assert.equal((await ctx.api.post(`/verification/reads/${again.id}/confirm`, { confirmed: ['pct_basic'], values: { pct_basic: 180 } })).status, 400);
  assert.equal((await h.db.get('SELECT status FROM benefit_reads WHERE id = ?', again.id)).status, 'draft');
  assert.equal((await ctx.api.post(`/verification/reads/${again.id}/discard`)).status, 200);
});

test('exceptions: inactive, ended, missing details, plan changed, maximum nearly used, stale breakdown, not verified', () => {
  const s = { ...VERIFY_DEFAULTS };
  const t = '2031-05-05';
  const base = {
    date: '2031-05-08', policy: { id: 1, group_number: 'G1' }, missing: [], pending_update: false, new_card: false,
    eligibility: { state: 'verified', label: 'Verified today', how: 'Electronic (271)', at: '2031-05-05 08:00:00' }, breakdown: { state: 'verified', label: 'ok' }, remaining: { annual_max: 150000, max_remaining: 90000, source: 'payer' },
  };
  const kinds = (row) => exceptionsFor({ ...base, ...row }, s, t).map((x) => x.kind);
  assert.deepEqual(kinds({}), []);
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, state: 'inactive' } }), ['inactive']);
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, plan_end: '2031-05-01' } }), ['terminated']);
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, plan_end: '2031-06-01' } }), []);
  assert.deepEqual(kinds({ missing: ['Subscriber date of birth'] }), ['missing_info']);
  assert.deepEqual(kinds({ pending_update: true }), ['plan_changed']);
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, evidence: { group_number: 'G2' } } }), ['plan_changed']);
  assert.deepEqual(kinds({ remaining: { annual_max: 150000, max_remaining: 30000, source: 'payer' } }), ['max_nearly_used'], '80% used');
  assert.deepEqual(kinds({ remaining: { annual_max: 150000, max_remaining: 31000, source: 'payer' } }), []);
  assert.deepEqual(kinds({ breakdown: { state: 'stale', label: 'old' } }), ['breakdown_stale']);
  assert.deepEqual(kinds({ breakdown: { state: 'never', label: 'never' } }), ['breakdown_stale']);
  assert.deepEqual(kinds({ eligibility: { state: 'never', label: 'Not checked yet' } }), [], 'three days out: the automatic check will get it');
  assert.deepEqual(kinds({ date: addDays(t, 1), eligibility: { state: 'never', label: 'Not checked yet' } }), ['not_verified'], 'tomorrow and still not checked');
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, state: 'error', review: ['the member ID isn’t right'] } }), ['check_failed']);
  // Most urgent first.
  assert.deepEqual(kinds({ eligibility: { ...base.eligibility, state: 'inactive' }, missing: ['Group number'], breakdown: { state: 'never', label: 'n' } }), ['inactive', 'missing_info', 'breakdown_stale']);
  assert.deepEqual(exceptionsFor({ ...base, policy: null, pending_update: true }, s, t).map((x) => x.kind), ['plan_changed'], 'self-pay who sent insurance');
  // A breakdown verified for someone else on the plan counts for this patient; their amounts don't.
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const other = breakdownState({ id: 9, patient_insurance_id: 1, group_status: 'applied', created_at: stamp, method: 'phone', patient_detail: '{"max_remaining":100}' }, { policy: { id: 2 }, plan: { benefit_month: 1 }, settings: s, today: stamp.slice(0, 10) });
  assert.deepEqual([other.state, other.via_group, other.patient_detail], ['verified', true, null]);
  const own = breakdownState({ id: 9, patient_insurance_id: 2, group_status: 'applied', created_at: stamp, method: 'phone', patient_detail: '{"max_remaining":100}' }, { policy: { id: 2 }, plan: { benefit_month: 1 }, settings: s, today: stamp.slice(0, 10) });
  assert.equal(own.patient_detail.max_remaining, 100);
  const renewed = breakdownState({ id: 9, patient_insurance_id: 2, created_at: '2031-12-20 10:00:00', method: 'phone' }, { policy: { id: 2 }, plan: { benefit_month: 1 }, settings: s, today: '2032-01-05', now: Date.parse('2032-01-05T12:00:00Z') });
  assert.equal(renewed.state, 'stale', 'the benefit year renewed since');
  assert.equal(breakdownState(null, { policy: { id: 2 }, plan: {}, settings: s, today: t }).state, 'never');
});

test('the list: upcoming visits by range and office with both statuses, missing details, and exceptions; texting the patient', async () => {
  const ctx = await setup();
  const t = today();
  const north = (await ctx.api.post('/locations', { name: 'North' })).data;
  const south = (await ctx.api.post('/locations', { name: 'South' })).data;
  const [a, b, c] = [await ctx.person('Norah'), await ctx.person('Sol', { phone: null, email: null }), await ctx.person('Cash')];
  const pa = await ctx.insure(a);
  const pb = await ctx.insure(b, { relationship: 'spouse', subscriber_dob: null, subscriber_name: 'Pat Test' });
  const va = await ctx.book(a, addDays(t, 1));
  const vb = await ctx.book(b, addDays(t, 1), '11:00');
  const vc = await ctx.book(c, addDays(t, 2));
  await h.db.run('UPDATE appointments SET location_id = ? WHERE id IN (?, ?)', north.id, va.id, vc.id);
  await h.db.run('UPDATE appointments SET location_id = ? WHERE id = ?', south.id, vb.id);
  // Coverage inactive for Norah (the payer's answer by phone).
  await ctx.api.post(`/verification/policies/${pa.id}/phone`, { active: false, reference: 'R1', rep_name: 'Sue' });

  const list = (await ctx.api.get('/verification/upcoming?range=tomorrow')).data;
  assert.deepEqual(list.rows.map((r) => r.patient_name).sort(), ['Norah Test', 'Sol Test']);
  const na = list.rows.find((r) => r.patient_id === a.id);
  assert.equal(na.eligibility.state, 'inactive');
  assert.deepEqual(na.exceptions.map((x) => x.kind), ['inactive', 'breakdown_stale']);
  assert.equal(na.policy.payer_phone, '(800) 555-0199');
  const sb = list.rows.find((r) => r.patient_id === b.id);
  assert.deepEqual(sb.missing, ['Subscriber date of birth']);
  assert.deepEqual(sb.exceptions.map((x) => x.kind), ['missing_info', 'not_verified', 'breakdown_stale'], 'tomorrow and never checked');
  assert.equal(list.summary.visits, 2);
  const week = (await ctx.api.get('/verification/upcoming?range=week')).data;
  assert.equal(week.rows.find((r) => r.patient_id === c.id).eligibility.state, 'self_pay');
  assert.deepEqual((await ctx.api.get(`/verification/upcoming?range=week&location_id=${south.id}`)).data.rows.map((r) => r.patient_id), [b.id], 'one office');
  assert.equal((await ctx.api.get('/verification/upcoming?from=2031-01-01&to=2031-06-01')).status, 400, 'two months at most');

  // Text Norah for her new card: a secure upload link that lands in Intake review; once a day.
  const sent = await ctx.api.post(`/patients/${a.id}/request-insurance`);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const msg = h.sent.at(-1);
  assert.match(msg.body, /\/scan\/[A-Za-z0-9_-]{20,}/);
  const link = await h.db.get('SELECT * FROM upload_links WHERE patient_id = ? ORDER BY id DESC', a.id);
  assert.deepEqual([link.category, link.created_by], ['insurance_card', null]);
  const again = await ctx.api.post(`/patients/${a.id}/request-insurance`);
  assert.equal(again.data.already, true);
  assert.equal(h.sent.filter((m) => m.body === msg.body).length, 1, 'not sent twice');
  const after = (await ctx.api.get('/verification/upcoming?range=tomorrow')).data.rows.find((r) => r.patient_id === a.id);
  assert.equal(after.waiting, true, 'now waiting on the patient');
  assert.equal((await ctx.api.post(`/patients/${b.id}/request-insurance`)).status, 409, 'no phone or email');
  // The payer script has the payer's phone and the patient's details.
  const detail = (await ctx.api.get(`/verification/policies/${pa.id}`)).data;
  assert.match(detail.script, /\(800\) 555-0199/);
  assert.match(detail.script, /Member ID W\d+, group G100/);
  assert.equal(detail.checks[0].reference, 'R1');
});

test('metrics: % of visits verified 48 hours ahead and stale breakdowns', async () => {
  const ctx = await setup();
  const [a, b] = [await ctx.person('Early'), await ctx.person('Late')];
  const [pa, pb] = [await ctx.insure(a), await ctx.insure(b)];
  const ins = (p, when) => h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'completed')", ctx.pid, p.id, ctx.provider.id, when, when.replace(/ \d\d:/, ' 11:'));
  await ins(a, '2026-02-10 10:00');
  await ins(b, '2026-02-10 10:00');
  const chk = (p, at) => h.db.run("INSERT INTO eligibility_checks (practice_id, patient_id, patient_insurance_id, status, created_at) VALUES (?, ?, ?, 'active', ?)", ctx.pid, p.patient_id, p.id, at);
  await chk(pa, '2026-02-07 09:00:00'); // three days ahead
  await chk(pb, '2026-02-09 20:00:00'); // only 14 hours ahead
  const m = (await ctx.api.get('/verification/metrics?from=2026-02-01&to=2026-02-28')).data;
  assert.deepEqual([m.visits, m.verified_48h, m.pct_verified_48h], [2, 1, 50]);
  assert.equal(typeof m.stale_breakdowns, 'number');
});

test('isolation and permissions: other practices, other offices, roles', async () => {
  const ctx = await setup();
  const other = await setup();
  const a = await ctx.person('Mine');
  const pa = await ctx.insure(a);
  const t = today();
  const va = await ctx.book(a, addDays(t, 1));
  // Another practice sees none of it.
  assert.equal((await other.api.get(`/verification/policies/${pa.id}`)).status, 404);
  assert.equal((await other.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'x', rep_name: 'y' })).status, 404);
  assert.equal((await other.api.post(`/verification/policies/${pa.id}/check`)).status, 404);
  assert.equal((await other.api.get(`/patients/${a.id}/verification`)).status, 404);
  assert.ok(!(await other.api.get('/verification/upcoming?range=week')).data.rows.some((r) => r.patient_id === a.id));
  const loc = (await ctx.api.post('/locations', { name: 'East' })).data;
  assert.equal((await other.api.get(`/verification/upcoming?location_id=${loc.id}`)).status, 404, 'an office of another practice');
  // Someone limited to another office doesn't see this visit.
  const west = (await ctx.api.post('/locations', { name: 'West' })).data;
  await h.db.run('UPDATE appointments SET location_id = ? WHERE id = ?', loc.id, va.id);
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', loc.id, a.id);
  const westDesk = await user(ctx.api, 'front_desk', { location_ids: [west.id] });
  assert.ok(!(await westDesk.api.get('/verification/upcoming?range=week')).data.rows.some((r) => r.patient_id === a.id));
  assert.equal((await westDesk.api.get(`/verification/policies/${pa.id}`)).status, 404);
  // Roles.
  const asst = await user(ctx.api, 'assistant');
  assert.equal((await asst.api.get('/verification/upcoming')).status, 403, 'no billing access');
  const dentist = await user(ctx.api, 'dentist');
  assert.equal((await dentist.api.get('/verification/upcoming')).status, 200);
  assert.equal((await dentist.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'x', rep_name: 'y' })).status, 403, 'changing benefits needs billing:write');
  const desk = await user(ctx.api, 'front_desk');
  assert.equal((await desk.api.put('/verification/settings', { days_ahead: 5 })).status, 403, 'settings: administrators');
  assert.equal((await desk.api.post(`/verification/policies/${pa.id}/phone`, { active: true, reference: 'R', rep_name: 'Q' })).status, 201);
  assert.equal((await ctx.api.put('/verification/settings', { days_ahead: 99 })).status, 400);
  const saved = (await ctx.api.put('/verification/settings', { days_ahead: 5, breakdown_stale_days: 365 })).data;
  assert.deepEqual([saved.days_ahead, saved.breakdown_stale_days, saved.morning_of], [5, 365, true]);
  const log = await h.db.get("SELECT changes FROM audit_log WHERE action = 'verification.settings' ORDER BY id DESC");
  assert.deepEqual(JSON.parse(log.changes).days_ahead, [3, 5]);
});

test('check everyone in the range now: each policy once, recent ones skipped', async () => {
  const ctx = await setup();
  const t = today();
  const [a, b] = [await ctx.person('One'), await ctx.person('Two')];
  await ctx.insure(a);
  await ctx.insure(b);
  await ctx.book(a, addDays(t, 1));
  await ctx.book(a, addDays(t, 1), '14:00');
  await ctx.book(b, addDays(t, 1), '11:00');
  const first = (await ctx.api.post('/verification/run', { range: 'tomorrow' })).data;
  assert.deepEqual([first.checked, first.skipped, first.failed.length], [2, 0, 0]);
  const second = (await ctx.api.post('/verification/run', { range: 'tomorrow' })).data;
  assert.deepEqual([second.checked, second.skipped], [0, 2]);
  const rows = (await ctx.api.get('/verification/upcoming?range=tomorrow')).data.rows;
  assert.ok(rows.every((r) => r.eligibility.state === 'verified' && r.breakdown.state === 'verified'), 'the sandbox 271 carries a full breakdown');
});
