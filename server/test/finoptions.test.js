// Treatment plans with financial options (backlog F1–F5): the arithmetic to the cent first, then the routes —
// estimates per phase and benefit year, accepting an option (patient and desk), the snapshot, the ledger,
// permissions and practice isolation. Spec: docs/workflows/specs/F-financial-options.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import {
  amortize, pctOf, payInFull, inOffice, lenderOption, membershipOption, buildOptions, cleanSettings, ppoSavings, fingerprint, monthlyDates, DEFAULT_SETTINGS,
} from '../src/finoptions.js';

const h = harness();
const S = cleanSettings({});
const sum = (list) => list.reduce((s, x) => s + x, 0);

// ---- Pure arithmetic ----
test('amortization: 0% splits evenly rounded up, the last payment absorbs the remainder, never a cent off', () => {
  const a = amortize(100000, 0, 12);
  assert.equal(a.payment, 8334);
  assert.equal(a.last, 8326);
  assert.deepEqual(a.payments.slice(0, 11), Array(11).fill(8334));
  assert.equal(sum(a.payments), 100000);
  assert.equal(a.interest, 0);
  // Even splits stay even; tiny amounts never leave a zero or negative last payment.
  assert.deepEqual(amortize(120000, 0, 6).payments, Array(6).fill(20000));
  assert.deepEqual(amortize(13, 0, 8).payments, [1, 1, 1, 1, 1, 1, 1, 6]);
  assert.throws(() => amortize(5, 0, 8), /too small/);
  assert.throws(() => amortize(100, 0, 0), /months/);
  assert.throws(() => amortize(100.5, 0, 2), /whole number of cents/);
  assert.throws(() => amortize(-100, 0, 2), /whole number of cents/);
});

test('amortization with interest: the standard payment, interest to the cent each month, the balance ends at zero', () => {
  // $2,500 at 17.90% APR over 48 months: $73.31 a month (standard annuity formula), last $73.09.
  const a = amortize(250000, 17.9, 48);
  assert.equal(a.payment, 7331);
  assert.equal(a.last, 7309);
  assert.equal(a.total, 351866);
  assert.equal(a.interest, 101866);
  assert.equal(sum(a.payments), a.total);
  // Replay it month by month: interest = balance × APR/12 rounded half-up; the balance ends at exactly 0.
  let bal = 250000;
  for (const p of a.payments) bal = bal + Math.round((bal * 17.9) / 1200) - p;
  assert.equal(bal, 0);
  // $1,200 at 9.99% over 12 months: $105.49 (last $105.51).
  const b = amortize(120000, 9.99, 12);
  assert.deepEqual([b.payment, b.last, b.total], [10549, 10551, 126590]);
});

test('percentages are basis points rounded half-up; monthly due dates keep month ends', () => {
  assert.equal(pctOf(123457, 5), 6173);
  assert.equal(pctOf(10, 5), 1); // 0.5¢ rounds up
  assert.equal(pctOf(100000, 2.5), 2500);
  assert.deepEqual(monthlyDates('2026-01-31', 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('prepay discount: the office %, only where allowed, never past the maximum discount or the cap', () => {
  assert.deepEqual([payInFull(123457, S).discount, payInFull(123457, S).total, payInFull(123457, S).due_today], [6173, 117284, 117284]);
  // Below the minimum: no discount.
  assert.equal(payInFull(40000, S).discount, 0);
  // Self-pay only: insured patients pay in full without it.
  const selfPay = cleanSettings({ prepay: { pct: 5, allowed: 'self_pay', min_amount: 0 } });
  assert.equal(payInFull(100000, selfPay, { insured: true }).discount, 0);
  assert.equal(payInFull(100000, selfPay, { insured: false }).discount, 5000);
  // With an 8% plan discount already on the plan and a 10% maximum, only 2% more.
  const both = payInFull(100000, S, { otherDiscountPct: 8 });
  assert.deepEqual([both.discount, both.discount_pct], [2000, 2]);
  assert.equal(payInFull(100000, S, { otherDiscountPct: 10 }).discount, 0);
  // A cap in dollars.
  assert.equal(payInFull(10000000, cleanSettings({ prepay: { pct: 5, allowed: 'always', min_amount: 0, max_discount: 25000 } })).discount, 25000);
  // Never: nothing.
  assert.equal(payInFull(100000, cleanSettings({ prepay: { pct: 5, allowed: 'never', min_amount: 0 } })).discount, 0);
});

test('settings guardrails: discounts, APRs, months and lender terms are checked', () => {
  assert.throws(() => cleanSettings({ max_discount_pct: 5, prepay: { pct: 8 } }), /above your maximum discount/);
  assert.throws(() => cleanSettings({ max_apr: 10, in_office: { apr: 12 } }), /APR/);
  assert.throws(() => cleanSettings({ in_office: { months: [6, 24], max_months: 12 } }), /longer than 12/);
  assert.throws(() => cleanSettings({ lenders: [{ lender: 'carecredit', months: 12, type: 'deferred' }] }), /standard APR/);
  assert.throws(() => cleanSettings({ lenders: [{ lender: 'carecredit', months: 12, type: 'fixed', apr: 9, apply_url: 'http://x.example' }] }), /https/);
  assert.throws(() => cleanSettings({ lenders: [{ lender: 'acme', months: 12, type: 'fixed' }] }), /choose a lender/);
  assert.equal(cleanSettings({ in_office: { months: '12, 3, 6' } }).in_office.months.join(), '3,6,12');
  assert.equal(cleanSettings({}).prepay.pct, DEFAULT_SETTINGS.prepay.pct);
});

test('in-office plan: minimum down payment, monthly from the rest, set-up fee and APR as a finance charge', () => {
  const o = inOffice(300000, S, 6);
  assert.deepEqual([o.down_payment, o.financed, o.monthly, o.total, o.due_today, o.finance_charge], [60000, 240000, 40000, 300000, 60000, 0]);
  assert.throws(() => inOffice(300000, S, 6, { downPayment: 1000 }), /at least \$600\.00/);
  assert.throws(() => inOffice(300000, S, 24), /at most 12 months/);
  const paid = cleanSettings({ in_office: { apr: 9.99, setup_fee: 2500, months: [12], min_down_pct: 0, min_amount: 0 } });
  const f = inOffice(120000, paid, 12);
  // Down payment 0, financed $1,200 + $25 set-up at 9.99%.
  const a = amortize(122500, 9.99, 12);
  assert.deepEqual([f.down_payment, f.financed, f.monthly, f.total], [0, 122500, a.payment, a.total]);
  assert.equal(f.finance_charge, a.total - 120000);
  assert.equal(sum(f.payments) + f.down_payment, f.total);
});

test('lenders: deferred-interest promos pay off in the promo period; fixed terms are amortized', () => {
  const [six, twelve, fixed24, fixed48] = DEFAULT_SETTINGS.lenders;
  const d = lenderOption(100000, twelve, 'https://apply.example/cc');
  assert.deepEqual([d.monthly, d.last_payment, d.total, d.due_today, d.apr], [8334, 8326, 100000, 0, 0]);
  assert.match(d.notes[0], /No interest if paid in full within 12 months.*32\.99% APR/);
  assert.equal(lenderOption(100000, six, 'x').monthly, 16667);
  const f = lenderOption(250000, fixed48, 'x');
  assert.deepEqual([f.monthly, f.total, f.apr], [7331, 351866, 17.9]);
  assert.equal(lenderOption(250000, fixed24, 'x').months, 24);
  // Only lenders with an application link, and only within their amounts.
  const opts = buildOptions({ amount: 150000, settings: S, lenderLinks: { carecredit: 'https://cc.example/apply' } });
  assert.deepEqual(opts.filter((o) => o.kind === 'lender').map((o) => o.months), [6, 12, 24]);
  assert.equal(buildOptions({ amount: 150000, settings: S }).filter((o) => o.kind === 'lender').length, 0);
});

test('membership pricing for patients without insurance; PPO in-network savings', () => {
  const plan = { id: 7, name: 'Care Club', price: 3500, interval: 'month', discount_pct: 20, included: JSON.stringify([{ codes: ['D1110'], per_year: 2 }]) };
  const items = [{ code: 'D1110', patient: 11000 }, { code: 'D1110', patient: 11000 }, { code: 'D1110', patient: 11000 }, { code: 'D2740', patient: 120000 }];
  const m = membershipOption(items, plan);
  // Two cleanings included, the third 20% off, the crown 20% off.
  assert.equal(m.savings, 11000 + 11000 + 2200 + 24000);
  assert.deepEqual([m.year_cost, m.due_today, m.monthly, m.total], [42000, 3500, 3500, 153000 - 48200 + 42000]);
  assert.equal(m.net_savings, 6200);
  const shown = (o) => buildOptions({ amount: 153000, items, settings: S, membershipPlans: [plan], ...o }).some((x) => x.kind === 'membership');
  assert.equal(shown({}), true);
  assert.equal(shown({ insured: true }), false, 'not for insured patients');
  assert.equal(shown({ isMember: true }), false, 'not for members');
  assert.equal(buildOptions({ amount: 11000, items: [{ code: 'D2140', patient: 11000 }], settings: S, membershipPlans: [plan] }).some((x) => x.kind === 'membership'), false, 'not when it costs more than it saves');
  assert.equal(ppoSavings({ policy: { id: 1 }, total_write_off: 42000 }), 42000);
  assert.equal(ppoSavings({ policy: null, total_write_off: 0 }), 0);
  assert.equal(fingerprint({ a: 1, b: [2, { c: 3, d: 4 }] }), fingerprint({ b: [2, { d: 4, c: 3 }], a: 1 }));
});

// ---- Routes ----
async function planFor(ctx, work = [['D2740', '14', 1], ['D3330', '19', 1], ['D6010', '30', 2]]) {
  const { api, patient, provider } = ctx;
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, {
    name: 'Restore', procedures: work.map(([code, tooth, phase]) => ({ code, tooth, provider_id: provider.id, phase })),
  })).data;
  assert.ok(plan.id, JSON.stringify(plan));
  return plan;
}
async function ppoPatient(ctx) {
  const { api, patient } = ctx;
  const fs = (await api.post('/fee-schedules', { name: 'Delta PPO', kind: 'ppo', percent_of_ucr: 60 })).data;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental' })).data;
  await api.put(`/fee-schedules/${fs.id}`, { carrier_ids: [carrier.id] });
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'G1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50, pct_preventive: 100 })).data;
  assert.ok(policy.id, JSON.stringify(policy));
  return policy;
}
const publicLink = async (ctx, plan) => {
  const { url } = (await ctx.api.post(`/treatment-plans/${plan.id}/present`, {})).data;
  const token = url.split('/tp/')[1];
  const pass = (await h.client().post(`/public/tp/${token}/verify`, { dob: '1985-04-12' })).data.pass;
  return { token, pub: h.client(null, { 'X-Plan-Pass': pass }) };
};

test('the live estimate: per phase and in total, PPO savings shown, and the benefit year split when a phase is next year', async () => {
  const ctx = await h.practice();
  await ppoPatient(ctx);
  const plan = await planFor(ctx);
  const q = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  assert.deepEqual(q.phases.map((p) => [p.phase, p.count]), [[1, 2], [2, 1]]);
  for (const k of ['fee', 'insurance', 'write_off', 'you_pay']) assert.equal(sum(q.phases.map((p) => p[k])), q.totals[k === 'you_pay' ? 'you_pay' : k], k);
  assert.ok(q.totals.write_off > 0);
  assert.equal(q.ppo_savings, q.totals.write_off, 'office fee − PPO allowed');
  assert.equal(q.totals.fee - q.totals.write_off - q.totals.insurance, q.totals.patient);
  assert.ok(q.options.some((o) => o.key === 'full') && q.options.some((o) => o.kind === 'in_office'));
  assert.match(q.quote_hash, /^[0-9a-f]{64}$/);
  assert.equal(q.settings, undefined, 'the office rules are not sent with the quote');
  // The annual maximum runs out this year; the implant phase moved to next benefit year gets its own maximum.
  const limited = q.years.length === 1 && q.years[0].limited;
  assert.ok(limited, JSON.stringify(q.years));
  const next = `${Number(q.today.slice(0, 4)) + 1}-02-01`;
  const named = await ctx.api.put(`/treatment-plans/${plan.id}/phases/2`, { name: 'Replace the missing tooth', why: 'So you can chew on that side again.', when_date: next, visits: 3 });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  const split = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  assert.equal(split.years.length, 2);
  assert.ok(split.totals.insurance > q.totals.insurance, 'more paid by insurance across two years');
  assert.deepEqual(split.phases[1].years, [split.years[1].start]);
  assert.deepEqual([split.phases[1].name, split.phases[1].visits], ['Replace the missing tooth', 3]);
  // Only phase 1: the quote is for that phase alone.
  const one = (await ctx.api.get(`/treatment-plans/${plan.id}/quote?phases=1`)).data;
  assert.deepEqual(one.chosen, [1]);
  assert.equal(one.totals.fee, split.phases[0].fee);
  assert.notEqual(one.quote_hash, split.quote_hash);
  assert.equal((await ctx.api.put(`/treatment-plans/${plan.id}/phases/2`, { when_date: '2026-02-30' })).status, 400);
  assert.equal((await ctx.api.put(`/treatment-plans/${plan.id}/phases/2`, { visits: 0 })).status, 400);
});

test('phases: rename and put whole phases in a new order (recorded)', async () => {
  const ctx = await h.practice();
  const plan = await planFor(ctx);
  await ctx.api.put(`/treatment-plans/${plan.id}/phases/1`, { name: 'Urgent' });
  await ctx.api.put(`/treatment-plans/${plan.id}/phases/2`, { name: 'Implant' });
  assert.equal((await ctx.api.put(`/treatment-plans/${plan.id}/phase-order`, { order: [2] })).status, 400);
  const r = await ctx.api.put(`/treatment-plans/${plan.id}/phase-order`, { order: [2, 1] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.phases.map((p) => [p.phase, p.name, p.count]), [[1, 'Implant', 1], [2, 'Urgent', 2]]);
  const implant = await h.db.get("SELECT phase FROM procedures WHERE treatment_plan_id = ? AND code = 'D6010'", plan.id);
  assert.equal(implant.phase, 1);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'treatment_plan.phase_order' AND entity_id = ?", plan.id));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'treatment_plan.phase' AND entity_id = ?", plan.id));
});

test('the patient picks an office payment plan and signs: a plan with an exact schedule, an immutable snapshot, and no second acceptance', async () => {
  const ctx = await h.practice();
  const plan = await planFor(ctx);
  const { token, pub } = await publicLink(ctx, plan);
  const view = (await pub.get(`/public/tp/${token}`)).data;
  assert.ok(view.quote.phases.length === 2 && view.quote.phases[0].why, 'phases with plain words');
  assert.deepEqual(view.quote.teeth.sort(), ['14', '19', '30']);
  const opt = view.quote.options.find((o) => o.key === 'office-12');
  assert.ok(opt, JSON.stringify(view.quote.options.map((o) => o.key)));
  // Stale numbers: nothing is signed.
  const stale = await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true, choice: { option_key: 'office-12', quote_hash: 'x'.repeat(64) } });
  assert.equal(stale.status, 409);
  assert.equal((await h.db.get('SELECT signed_at FROM treatment_plans WHERE id = ?', plan.id)).signed_at, null);
  const signed = await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true, choice: { option_key: 'office-12', quote_hash: view.quote.quote_hash } });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.equal(signed.data.agreement.kind, 'in_office');
  const a = await h.db.get('SELECT * FROM fin_agreements WHERE treatment_plan_id = ?', plan.id);
  assert.deepEqual([a.source, a.signature_name, a.total, a.due_today, a.monthly], ['patient', 'Jane Doe', opt.total, opt.due_today, opt.monthly]);
  const pp = await h.db.get('SELECT * FROM payment_plans WHERE id = ?', a.payment_plan_id);
  const schedule = JSON.parse(pp.schedule);
  assert.equal(schedule.length, 12);
  assert.equal(sum(schedule.map((s) => s.amount)), pp.total - pp.down_payment, 'the schedule covers exactly what is financed');
  assert.equal(pp.down_payment, opt.down_payment);
  // The snapshot is exactly what was shown, and stays so when the plan changes later.
  const snap = JSON.parse(a.snapshot);
  assert.equal(snap.quote_hash, view.quote.quote_hash);
  assert.equal(fingerprint(snap), a.snapshot_hash);
  await ctx.api.put(`/procedures/${(await h.db.get("SELECT id FROM procedures WHERE treatment_plan_id = ? AND code = 'D2740'", plan.id)).id}`, { fee: 999900 });
  const after = (await ctx.api.get(`/fin-agreements/${a.id}`)).data;
  assert.equal(after.intact, true);
  assert.equal(after.snapshot.chosen.total, opt.total);
  const pdf = await fetch(`${h.origin}/api/fin-agreements/${a.id}/pdf`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  // Twice: refused (already signed); the task for the team is there; audited as the patient.
  assert.equal((await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true, choice: { option_key: 'office-12', quote_hash: view.quote.quote_hash } })).status, 409);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM fin_agreements WHERE treatment_plan_id = ?', plan.id)).n, 1);
  assert.match((await h.db.get('SELECT title FROM tasks WHERE id = ?', a.task_id)).title, /accepted Restore: book Phase 1/);
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'fin_agreement.accept' AND entity_id = ?", a.id);
  assert.equal(log.source, 'patient');
  // Plain signing (no choice) still works for the classic flow (workflow 22).
  const plain = await planFor(ctx, [['D2740', '3', 1]]);
  const link2 = await publicLink(ctx, plain);
  assert.equal((await link2.pub.post(`/public/tp/${link2.token}`, { signature_name: 'Jane Doe', consent: true })).status, 200);
});

test('pay in full: the prepay discount waits until the prepayment is posted, posts once, and is reversed by a manager only', async () => {
  const ctx = await h.practice();
  const plan = await planFor(ctx);
  const q = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  const full = q.options.find((o) => o.key === 'full');
  assert.equal(full.discount, pctOf(q.amount, 5));
  const acc = await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash, signature_name: 'Jane Doe' });
  assert.equal(acc.status, 201, JSON.stringify(acc.data));
  assert.deepEqual([acc.data.discount_status, acc.data.discount_amount], ['pending', full.discount]);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ?', ctx.patient.id)).n, 0, 'nothing on the ledger before the money comes in');
  assert.equal((await h.db.get('SELECT status FROM treatment_plans WHERE id = ?', plan.id)).status, 'accepted');
  // The same acceptance again (a double click): the same agreement; a different option: refused.
  const again = await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash });
  assert.deepEqual([again.status, again.data.id], [200, acc.data.id]);
  assert.equal((await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'office-6', quote_hash: q.quote_hash })).status, 409);

  assert.equal((await ctx.api.post(`/fin-agreements/${acc.data.id}/prepay`, { method: 'bitcoin' })).status, 400);
  const paid = await ctx.api.post(`/fin-agreements/${acc.data.id}/prepay`, { method: 'credit_card' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal((await ctx.api.post(`/fin-agreements/${acc.data.id}/prepay`, { method: 'credit_card' })).status, 200, 'a repeat posts nothing');
  const entries = await h.db.all('SELECT type, adjustment_type, amount FROM ledger_entries WHERE patient_id = ? ORDER BY id', ctx.patient.id);
  assert.deepEqual(entries, [
    { type: 'payment', adjustment_type: null, amount: -full.due_today },
    { type: 'adjustment', adjustment_type: 'Prepayment discount', amount: -full.discount },
  ]);
  // Balance is the ledger: a credit of the full patient share, ready for the charges as the work is done.
  assert.equal((await h.db.get('SELECT SUM(amount) AS b FROM ledger_entries WHERE patient_id = ?', ctx.patient.id)).b, -q.amount);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'fin_agreement.prepay' AND entity_id = ?", acc.data.id));

  // Can't cancel with a posted discount; front desk can't reverse it; an administrator can, with a reason.
  assert.equal((await ctx.api.post(`/fin-agreements/${acc.data.id}/cancel`, { reason: 'Changed mind' })).status, 409);
  await ctx.api.post('/users', { name: 'Fran', email: `fd-${ctx.email}`, password: 'correct-horse-battery', role: 'front_desk' });
  const fd = h.client((await h.client().post('/auth/login', { email: `fd-${ctx.email}`, password: 'correct-horse-battery' })).data.token);
  assert.equal((await fd.post(`/fin-agreements/${acc.data.id}/reverse-discount`, { reason: 'x' })).status, 403);
  assert.equal((await ctx.api.post(`/fin-agreements/${acc.data.id}/reverse-discount`, {})).status, 400);
  const rev = await ctx.api.post(`/fin-agreements/${acc.data.id}/reverse-discount`, { reason: 'Treatment not done' });
  assert.equal(rev.data.discount_status, 'reversed');
  const d = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', rev.data.discount_entry_id);
  assert.ok(d.voided_at);
  const back = await h.db.get('SELECT * FROM ledger_entries WHERE reverses_id = ?', d.id);
  assert.equal(back.amount, full.discount);
  const log = await h.db.get("SELECT reason FROM audit_log WHERE action = 'fin_agreement.reverse_discount' AND entity_id = ?", acc.data.id);
  assert.equal(log.reason, 'Treatment not done');
  // Now it can be cancelled, and a new option chosen.
  assert.equal((await ctx.api.post(`/fin-agreements/${acc.data.id}/cancel`, { reason: 'Changed mind' })).status, 200);
  const q2 = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  assert.equal((await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'office-6', quote_hash: q2.quote_hash })).status, 201);
});

test('interest: the finance charge is on the ledger with the plan and reversed if the agreement is cancelled; lenders get an application', async () => {
  const ctx = await h.practice();
  await ctx.api.put('/practice', { financing: { links: [{ name: 'CareCredit', url: 'https://www.carecredit.com/go/ABC123/' }] } });
  const put = await ctx.api.put('/fin-options/settings', { settings: { max_apr: 12, in_office: { months: [12], apr: 9.99, setup_fee: 0, min_down_pct: 0, min_down: 0, min_amount: 0, max_months: 12 } } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok(await h.db.get("SELECT changes FROM audit_log WHERE action = 'fin_options.settings'"));
  const plan = await planFor(ctx);
  const q = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  const o = q.options.find((x) => x.key === 'office-12');
  assert.equal(o.finance_charge, amortize(q.amount, 9.99, 12).total - q.amount);
  const acc = (await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'office-12', quote_hash: q.quote_hash })).data;
  const fc = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', acc.finance_charge_entry_id);
  assert.deepEqual([fc.type, fc.amount, fc.payment_plan_id], ['adjustment', o.finance_charge, acc.payment_plan_id]);
  const c = await ctx.api.post(`/fin-agreements/${acc.id}/cancel`, { reason: 'Found a cheaper option' });
  assert.equal(c.data.status, 'cancelled');
  assert.equal((await h.db.get('SELECT SUM(amount) AS b FROM ledger_entries WHERE patient_id = ?', ctx.patient.id)).b, 0);
  assert.equal((await h.db.get('SELECT status FROM payment_plans WHERE id = ?', acc.payment_plan_id)).status, 'cancelled');

  const q2 = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  const lender = q2.options.find((x) => x.kind === 'lender' && x.months === 12);
  assert.match(lender.apply_url, /carecredit\.com\/go\/ABC123/);
  const la = (await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: lender.key, quote_hash: q2.quote_hash })).data;
  const app = await h.db.get('SELECT * FROM financing_applications WHERE id = ?', la.financing_application_id);
  assert.deepEqual([app.lender, app.amount, app.status, app.treatment_plan_id], ['carecredit', q2.amount, 'sent', plan.id]);
});

test('permissions, the AI guard and practice isolation', async () => {
  const ctx = await h.practice();
  const other = await h.practice();
  const plan = await planFor(ctx);
  const q = (await ctx.api.get(`/treatment-plans/${plan.id}/quote`)).data;
  await ctx.api.post('/users', { name: 'Asa', email: `as-${ctx.email}`, password: 'correct-horse-battery', role: 'assistant' });
  const assistant = h.client((await h.client().post('/auth/login', { email: `as-${ctx.email}`, password: 'correct-horse-battery' })).data.token);
  assert.equal((await assistant.get(`/treatment-plans/${plan.id}/quote`)).status, 200, 'clinical staff see the estimate');
  assert.equal((await assistant.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash })).status, 403, 'money needs billing:write');
  assert.equal((await assistant.put('/fin-options/settings', { settings: {} })).status, 403);
  // The assistant AI can't accept for the patient without a person's OK.
  const ai = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash })).status, 428);
  assert.equal((await ai.put('/fin-options/settings', { settings: {} })).status, 428);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM fin_agreements WHERE treatment_plan_id = ?', plan.id)).n, 0);
  // Another practice sees nothing and can't act.
  assert.equal((await other.api.get(`/treatment-plans/${plan.id}/quote`)).status, 404);
  assert.equal((await other.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash })).status, 404);
  assert.equal((await other.api.put(`/treatment-plans/${plan.id}/phases/1`, { name: 'x' })).status, 404);
  const a = (await ctx.api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: 'full', quote_hash: q.quote_hash })).data;
  assert.equal((await other.api.get(`/fin-agreements/${a.id}`)).status, 404);
  assert.equal((await other.api.post(`/fin-agreements/${a.id}/prepay`, { method: 'cash' })).status, 404);
  assert.equal((await other.api.post(`/fin-agreements/${a.id}/cancel`, { reason: 'x' })).status, 404);
  assert.deepEqual((await other.api.get(`/patients/${other.patient.id}/fin-agreements`)).data, []);
  // A picture from another patient's chart can't be put on a phase.
  const doc = await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key) VALUES (?, ?, 'xray', 'x.png', 'image/png', 1, 'k')", other.practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', other.patient.id)).practice_id, other.patient.id);
  assert.equal((await ctx.api.put(`/treatment-plans/${plan.id}/phases/1`, { document_id: doc.id })).status, 404);
});
