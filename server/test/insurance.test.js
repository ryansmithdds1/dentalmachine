import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { localNow } from '../src/util.js';
import { parseX12, sandbox835 } from '../src/x12.js';
import { processInbound } from '../src/clearinghouse.js';
import { allocate } from '../src/allocation.js';

const h = harness({ config: { ediMode: 'manual' } });

async function setup(planExtra = {}) {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'ACME', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
  if (Object.keys(planExtra).length) await api.put(`/insurance-plans/${policy.plan_id}`, planExtra);
  return { ...ctx, carrier, policy };
}
const proc = async ({ api, patient, provider }, code, extra = {}) =>
  (await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, ...extra })).data;
const estimate = async ({ api, patient, policy }, ids) => (await api.post(`/patients/${patient.id}/estimate`, { patient_insurance_id: policy.id, procedure_ids: ids })).data;

test('plans are shared: editing the plan updates everyone on it', async () => {
  const ctx = await setup();
  const spouse = (await ctx.api.post('/patients', { first_name: 'John', last_name: 'Doe', dob: '1984-02-02' })).data;
  const p2 = (await ctx.api.post(`/patients/${spouse.id}/insurance`, { carrier_id: ctx.carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', relationship: 'spouse', group_number: 'ACME' })).data;
  assert.equal(p2.plan_id, ctx.policy.plan_id, 'same carrier and group joins the plan');
  const upd = await ctx.api.put(`/insurance-plans/${ctx.policy.plan_id}`, { annual_max: 200000, pct_basic: 90 });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.members, 2);
  const theirs = (await ctx.api.get(`/patients/${spouse.id}/insurance`)).data[0];
  assert.deepEqual([theirs.annual_max, theirs.pct_basic, theirs.plan.members], [200000, 90, 2]);
  assert.equal((await ctx.api.get(`/insurance-plans?carrier_id=${ctx.carrier.id}`)).data.length, 1);
});

test('benefits: frequency limits, waiting periods, downgrades, per-code coverage, ortho and family deductible', async () => {
  // Bitewings once a year: the second set this year isn't covered.
  const ctx = await setup({ downgrade_composites: true, coverage_overrides: { D2740: 60 }, ortho_max: 150000, ortho_pct: 50, family_deductible: 10000 });
  await proc(ctx, 'D0274', { complete: true });
  const bwx = await proc(ctx, 'D0274');
  let est = await estimate(ctx, [bwx.id]);
  assert.equal(est.items[0].insurance, 0);
  assert.match(est.items[0].notes[0], /Bitewings 1× every year/);

  // Two cleanings a year: two in one plan are fine, the third isn't.
  const c1 = await proc(ctx, 'D1110');
  const c2 = await proc(ctx, 'D1110');
  const c3 = await proc(ctx, 'D1110');
  est = await estimate(ctx, [c1.id, c2.id, c3.id]);
  assert.deepEqual(est.items.map((i) => i.insurance > 0), [true, true, false]);

  // Posterior composite paid as amalgam (D2150 $190 vs D2392 $235): insurance 80% of $190.
  const comp = await proc(ctx, 'D2392', { tooth: '30', surfaces: 'MO' });
  est = await estimate(ctx, [comp.id]);
  assert.equal(est.items[0].insurance, 15200);
  assert.equal(est.items[0].patient, 23500 - 15200);
  assert.match(est.items[0].notes.join(), /Paid as amalgam/);
  // Anterior composites aren't downgraded.
  const ant = await proc(ctx, 'D2331', { tooth: '8', surfaces: 'MI' });
  assert.equal((await estimate(ctx, [ant.id])).items[0].insurance, 16000);

  // Per-code override: crowns at 60% instead of 50%.
  const crown = await proc(ctx, 'D2740', { tooth: '3' });
  assert.equal((await estimate(ctx, [crown.id])).items[0].insurance, 81000);

  // Ortho: its own percentage and lifetime maximum, outside the annual max.
  const ortho = await proc(ctx, 'D8080');
  est = await estimate(ctx, [ortho.id]);
  assert.equal(est.items[0].insurance, 150000, '50% of $6,000 capped at the $1,500 lifetime max');
  assert.match(est.items[0].notes.join(), /orthodontic lifetime maximum/);

  // Waiting period: major work covered only 12 months after the policy starts.
  await ctx.api.put(`/insurance-plans/${ctx.policy.plan_id}`, { wait_major_months: 12 });
  await ctx.api.put(`/insurance/${ctx.policy.id}`, { effective_date: localNow().slice(0, 10) });
  est = await estimate(ctx, [crown.id]);
  assert.equal(est.items[0].insurance, 0);
  assert.match(est.items[0].notes.join(), /Waiting period/);
});

test('family deductible: once the family has met it, nobody pays it again', async () => {
  const ctx = await setup({ family_deductible: 10000 });
  await ctx.api.put(`/insurance/${ctx.policy.id}`, { deductible: 5000, deductible_met: 5000 });
  const spouse = (await ctx.api.post('/patients', { first_name: 'John', last_name: 'Doe' })).data;
  const kid = (await ctx.api.post('/patients', { first_name: 'Kid', last_name: 'Doe' })).data;
  const sp = (await ctx.api.post(`/patients/${spouse.id}/insurance`, { carrier_id: ctx.carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', relationship: 'spouse', group_number: 'ACME' })).data;
  const kp = (await ctx.api.post(`/patients/${kid.id}/insurance`, { carrier_id: ctx.carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', relationship: 'child', group_number: 'ACME' })).data;
  await ctx.api.put(`/insurance/${sp.id}`, { deductible_met: 5000 });
  const filling = (await ctx.api.post(`/patients/${kid.id}/procedures`, { code: 'D2392', tooth: 'K', surfaces: 'MO', provider_id: ctx.provider.id })).data;
  const est = (await ctx.api.post(`/patients/${kid.id}/estimate`, { patient_insurance_id: kp.id, procedure_ids: [filling.id] })).data;
  assert.equal(est.total_deductible, 0, 'family deductible ($100) already met by two members');
});

test('secondary claims are drafted when the primary pays, and the 837 carries the primary adjudication', async () => {
  const ctx = await setup();
  const c2 = (await ctx.api.post('/carriers', { name: 'MetLife', payer_id: '65978' })).data;
  const sec = (await ctx.api.post(`/patients/${ctx.patient.id}/insurance`, { carrier_id: c2.id, priority: 'secondary', subscriber_name: 'John Doe', subscriber_id: 'M2', relationship: 'spouse', subscriber_dob: '1980-01-01', annual_max: 100000, deductible: 0, pct_basic: 80 })).data;
  const p = await proc(ctx, 'D2392', { tooth: '30', surfaces: 'MO', complete: true });
  const claim = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [p.id] })).data;
  // Secondary can't be sent before the primary pays.
  await ctx.api.post(`/claims/${claim.id}/submit`);
  const paid = await ctx.api.post('/insurance-checks', { carrier_id: ctx.carrier.id, check_number: 'CHK100', amount: 15000, claims: [{ claim_id: claim.id, paid: 15000, write_off: 3000, lines: [] }] });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  const secClaim = (await ctx.api.get(`/claims?patient_id=${ctx.patient.id}`)).data.find((c) => c.patient_insurance_id === sec.id);
  assert.ok(secClaim, 'secondary claim drafted automatically');
  assert.equal(secClaim.status, 'draft');
  assert.equal(secClaim.estimated_amount, 23500 - 15000 - 3000, 'covers what the primary left after its write-off');
  const file = (await ctx.api.post('/claims/837', { claim_ids: [secClaim.id] })).data;
  const segs = parseX12(file);
  const ids = segs.map((s) => s.id);
  assert.equal(segs.find((s) => s.id === 'SBR').e[1], 'S');
  assert.equal(segs.filter((s) => s.id === 'SBR')[1].e[1], 'P', 'other payer loop');
  assert.equal(segs.find((s) => s.id === 'AMT' && s.e[1] === 'D').e[2], '150');
  assert.ok(segs.some((s) => s.id === 'NM1' && s.e[1] === 'PR' && s.e[3] === 'DELTA DENTAL'));
  const svd = segs.find((s) => s.id === 'SVD');
  assert.equal(svd.e[2], '150');
  assert.ok(ids.includes('CAS'));
});

test('corrected and void claims go out with frequency 7/8 and the original claim number', async () => {
  const ctx = await setup();
  const p = await proc(ctx, 'D2392', { tooth: '30', surfaces: 'MO', complete: true });
  const claim = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [p.id], preauth_number: 'PA-77' })).data;
  await ctx.api.post(`/claims/${claim.id}/submit`);
  assert.equal((await ctx.api.post(`/claims/${claim.id}/correct`, {})).status, 400, "needs the payer's claim number");
  const fixed = await ctx.api.post(`/claims/${claim.id}/correct`, { original_reference: 'PAYER123' });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.data.frequency_code, '7');
  assert.equal((await ctx.api.get(`/claims/${claim.id}`)).data.status, 'void');
  const segs = parseX12((await ctx.api.post('/claims/837', { claim_ids: [fixed.data.id] })).data);
  assert.equal(segs.find((s) => s.id === 'CLM').e[5], '11:B:7');
  assert.equal(segs.find((s) => s.id === 'REF' && s.e[1] === 'F8').e[2], 'PAYER123');
  assert.equal(segs.find((s) => s.id === 'REF' && s.e[1] === 'G1').e[2], 'PA-77');
});

test('insurance checks post across several claims, line by line; ERA service lines and provider adjustments', async () => {
  const ctx = await setup();
  const a = await proc(ctx, 'D2392', { tooth: '30', surfaces: 'MO', complete: true });
  const b = await proc(ctx, 'D0274', { complete: true });
  const c1 = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [a.id, b.id] })).data;
  const other = await proc(ctx, 'D1110', { complete: true });
  const c2 = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [other.id] })).data;
  for (const c of [c1, c2]) await ctx.api.post(`/claims/${c.id}/submit`);
  const items = (await ctx.api.get('/insurance-checks/open-claims')).data.find((c) => c.id === c1.id).items;
  // The totals must match the check.
  assert.equal((await ctx.api.post('/insurance-checks', { check_number: 'X', amount: 999, claims: [{ claim_id: c1.id, paid: 1000 }] })).status, 400);
  const check = await ctx.api.post('/insurance-checks', {
    carrier_id: ctx.carrier.id, check_number: '55012', amount: 29800,
    claims: [
      { claim_id: c1.id, paid: 18800, write_off: 0, lines: [{ claim_item_id: items.find((i) => i.code === 'D2392').id, paid: 12800 }, { claim_item_id: items.find((i) => i.code === 'D0274').id, paid: 6000 }] },
      { claim_id: c2.id, paid: 11000 },
    ],
  });
  assert.equal(check.status, 201, JSON.stringify(check.data));
  const lines = await h.db.all('SELECT ci.paid_amount, pr.code FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY pr.code', c1.id);
  assert.deepEqual(lines.map((l) => [l.code, l.paid_amount]), [['D0274', 6000], ['D2392', 12800]]);
  const list = (await ctx.api.get('/insurance-checks')).data;
  assert.equal(list[0].claims, 2);

  // ERA with service lines and a provider-level adjustment (interest).
  const p3 = await proc(ctx, 'D2392', { tooth: '19', surfaces: 'DO', complete: true });
  const c3 = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [p3.id] })).data;
  await ctx.api.post(`/claims/${c3.id}/submit`);
  let era = sandbox835({ payee: { name: 'P', npi: '1234567893' }, eft: 'EFT9', date: '2026-02-01', claims: [{ control_number: `DM${c3.id}`, billed: 23500, paid: 18800, patient: 4700, write_off: 0, payer_claim_number: 'P9' }] });
  era = era.replace(/CAS\*PR\*2\*47~/, 'CAS*PR*2*47~SVC*AD:D2392*235*188~CAS*PR*2*47~').replace(/~(\s*)SE\*/, '~$1PLB*1234567893*20261231*L6:INT*-2.5~$1SE*');
  const res = await processInbound(h.db, { name: 'e.835', content: era }, { practiceId: ctx.patient.practice_id });
  assert.equal(res.error ?? null, null, JSON.stringify(res));
  const line = await h.db.get('SELECT paid_amount, patient_resp FROM claim_items WHERE claim_id = ?', c3.id);
  assert.deepEqual([line.paid_amount, line.patient_resp], [18800, 4700]);
  const eraCheck = await h.db.get('SELECT * FROM insurance_checks WHERE check_number = ?', 'EFT9');
  assert.deepEqual(JSON.parse(eraCheck.provider_adjustments), [{ reason: 'L6', reference: 'INT', amount: -250 }]);
});

test('payment allocation: collections by provider, unapplied credit, aging by family', async () => {
  // Pure allocation: insurance goes to its claim's procedures; patient payments to the oldest charge.
  const entries = [
    { id: 1, type: 'charge', amount: 10000, procedure_id: 11, provider_id: 1, entry_date: '2026-01-01' },
    { id: 2, type: 'charge', amount: 20000, procedure_id: 12, provider_id: 2, entry_date: '2026-01-02' },
    { id: 3, type: 'insurance_payment', amount: -15000, claim_id: 9, entry_date: '2026-01-10' },
    { id: 4, type: 'payment', amount: -20000, entry_date: '2026-01-11' },
  ];
  const { allocations, unapplied } = allocate(entries, [{ claim_id: 9, procedure_id: 12, paid_amount: 15000, adjusted_amount: 0 }]);
  const byProvider = (type) => allocations.filter((a) => a.credit_type === type).reduce((m, a) => ({ ...m, [a.provider_id]: (m[a.provider_id] || 0) + a.amount }), {});
  assert.deepEqual(byProvider('insurance_payment'), { 2: 15000 });
  assert.deepEqual(byProvider('payment'), { 1: 10000, 2: 5000 });
  assert.deepEqual(unapplied.map((u) => u.amount), [5000]);

  const ctx = await setup();
  const hyg = (await ctx.api.post('/providers', { name: 'Sam RDH', type: 'hygienist' })).data;
  await ctx.api.post(`/patients/${ctx.patient.id}/procedures`, { code: 'D1110', provider_id: hyg.id, complete: true });
  await ctx.api.post(`/patients/${ctx.patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: ctx.provider.id, complete: true });
  await ctx.api.post(`/patients/${ctx.patient.id}/payments`, { amount: 20000, method: 'cash' });
  const rep = (await ctx.api.get('/reports/collections-by-provider')).data;
  const row = (name) => rep.rows.find((r) => r.name === name);
  assert.equal(row('Sam RDH').patient_collections, 11000, 'the cleaning (oldest) is paid first');
  assert.equal(row('Dr. Ann Lee, DDS').patient_collections, 9000);
  const led = (await ctx.api.get(`/patients/${ctx.patient.id}/ledger`)).data;
  assert.equal(led.unapplied_credit, 0);

  // Aging by family puts a child's balance on the head of household.
  const kid = (await ctx.api.post('/patients', { first_name: 'Kid', last_name: 'Doe' })).data;
  await ctx.api.post(`/patients/${ctx.patient.id}/family`, { patient_id: kid.id });
  await ctx.api.post(`/patients/${kid.id}/procedures`, { code: 'D1120', provider_id: hyg.id, complete: true });
  const fam = (await ctx.api.get('/reports/aging?group=family')).data;
  assert.equal(fam.group, 'family');
  assert.equal(fam.rows.find((r) => r.id === ctx.patient.id).balance, 23500 + 11000 - 20000 + 8000);
  assert.ok(!fam.rows.some((r) => r.id === kid.id));
  assert.ok('patient_portion' in fam.rows[0]);
});

test('adjustment types, approval limit and family transfers', async () => {
  const ctx = await setup();
  const types = (await ctx.api.get('/adjustment-types')).data;
  assert.ok(types.some((t) => t.name === 'Bad debt write-off'));
  await ctx.api.put('/practice', { adjustment_approval_limit: 5000 });
  const email = `desk-${Date.now()}@example.com`;
  await ctx.api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const desk = h.client((await h.client().post('/auth/login', { email, password: 'front-desk-password' })).data.token);
  const big = await desk.post(`/patients/${ctx.patient.id}/adjustments`, { amount: -8000, description: 'Discount', adjustment_type: 'Courtesy discount' });
  assert.equal(big.status, 403);
  assert.equal((await desk.post(`/patients/${ctx.patient.id}/adjustments`, { amount: -2000, description: 'Discount', adjustment_type: 'Courtesy discount' })).status, 201);
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/adjustments`, { amount: -8000, description: 'Discount', adjustment_type: 'Courtesy discount' })).status, 201, 'admins can');
  const rep = (await ctx.api.get('/reports/adjustments')).data;
  assert.equal(rep.rows.find((r) => r.type === 'Courtesy discount').amount, -10000);
  // Voiding a big charge is a write-off by another name: same limit.
  const proc = (await ctx.api.post(`/patients/${ctx.patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: ctx.provider.id })).data;
  await ctx.api.post(`/procedures/${proc.id}/complete`, {});
  const charge = await h.db.get("SELECT id, amount FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", proc.id);
  assert.ok(charge.amount > 5000);
  assert.equal((await desk.post(`/ledger/${charge.id}/void`, { reason: 'oops' })).status, 403);
  assert.equal((await ctx.api.post(`/ledger/${charge.id}/void`, { reason: 'oops' })).status, 201);

  const kid = (await ctx.api.post('/patients', { first_name: 'Kid', last_name: 'Doe' })).data;
  const stranger = (await ctx.api.post('/patients', { first_name: 'Not', last_name: 'Family' })).data;
  await ctx.api.post(`/patients/${ctx.patient.id}/family`, { patient_id: kid.id });
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/transfer`, { to_patient_id: stranger.id, amount: 1000 })).status, 400);
  // Mom has a $100 credit; move it to the child.
  const t = await ctx.api.post(`/patients/${ctx.patient.id}/transfer`, { to_patient_id: kid.id, amount: -10000, note: 'Overpayment' });
  assert.equal(t.status, 201);
  assert.deepEqual([t.data.balance, t.data.to_balance], [0, -10000]);
});
