import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { benefitYear, deductibleMet } from '../src/services.js';
import { parse835, sandbox835 } from '../src/x12.js';
import { planStatus } from '../src/routes/family.js';

const h = harness({ config: { payments: 'sandbox' } });

const ledger = async (api, patient) => (await api.get(`/patients/${patient.id}/ledger`)).data;
const yesterday = () => new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

async function insured(ctx, { secondary = false, deductible = 0, ppo = false } = {}) {
  const { api, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  if (ppo) {
    const fs = (await api.post('/fee-schedules', { name: 'Delta PPO', percent_of_ucr: 80 })).data;
    await api.put(`/fee-schedules/${fs.id}`, { carrier_ids: [carrier.id] });
  }
  const primary = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible, pct_basic: 80 })).data;
  let second = null;
  if (secondary) {
    const c2 = (await api.post('/carriers', { name: 'MetLife', payer_id: '65978' })).data;
    second = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: c2.id, priority: 'secondary', subscriber_name: 'John Doe', subscriber_id: 'M2', relationship: 'spouse', annual_max: 100000, deductible: 0, pct_basic: 80 })).data;
  }
  return { primary, second };
}
const completed = async ({ api, patient, provider }, code = 'D2392') =>
  (await api.post(`/patients/${patient.id}/procedures`, { code, tooth: '30', surfaces: code === 'D2392' ? 'MO' : undefined, provider_id: provider.id, complete: true })).data;

test('secondary claims: the same procedure goes to both insurers, the secondary pays what is left', async () => {
  const ctx = await h.practice();
  const { primary, second } = await insured(ctx, { secondary: true });
  const proc = await completed(ctx);
  const c1 = await ctx.api.post('/claims', { patient_insurance_id: primary.id, procedure_ids: [proc.id] });
  assert.equal(c1.status, 201);
  assert.equal(c1.data.estimated_amount, 18800); // 80% of $235
  assert.equal((await ctx.api.post('/claims', { patient_insurance_id: primary.id, procedure_ids: [proc.id] })).status, 409, 'not twice to the same insurer');
  // Still unclaimed for the secondary.
  assert.equal((await ctx.api.get(`/patients/${ctx.patient.id}/unclaimed-procedures?patient_insurance_id=${second.id}`)).data.length, 1);
  assert.equal((await ctx.api.get(`/patients/${ctx.patient.id}/unclaimed-procedures?patient_insurance_id=${primary.id}`)).data.length, 0);
  const c2 = await ctx.api.post('/claims', { patient_insurance_id: second.id, procedure_ids: [proc.id] });
  assert.equal(c2.status, 201, JSON.stringify(c2.data));
  assert.equal(c2.data.estimated_amount, 23500 - 18800, 'secondary pays only the remaining $47');
  const l = await ledger(ctx.api, ctx.patient);
  assert.equal(l.pending_insurance, 23500);
  assert.equal(l.patient_portion, 0);
});

test('deductibles start again each benefit year; benefits are counted by date of service', async () => {
  const policy = { benefit_month: 7, deductible_met: 5000, deductible_year: '2025-07-01' };
  assert.deepEqual(benefitYear(policy, '2026-03-10'), { start: '2025-07-01', end: '2026-07-01' });
  assert.deepEqual(benefitYear(policy, '2026-07-01'), { start: '2026-07-01', end: '2027-07-01' });
  assert.equal(deductibleMet(policy, '2026-06-30'), 5000);
  assert.equal(deductibleMet(policy, '2026-07-01'), 0, 'new benefit year');
  assert.equal(deductibleMet({ deductible_met: 2500 }, '2026-01-02'), 2500, 'legacy rows keep their value');

  const ctx = await h.practice();
  const { primary } = await insured(ctx, { deductible: 5000 });
  // Staff record the deductible as met this year…
  await ctx.api.put(`/insurance/${primary.id}`, { deductible_met: 5000 });
  const proc = await completed(ctx);
  let est = (await ctx.api.post(`/patients/${ctx.patient.id}/estimate`, { patient_insurance_id: primary.id, procedure_ids: [proc.id] })).data;
  assert.equal(est.total_deductible, 0);
  // …but that was last benefit year: it no longer counts.
  const lastYear = `${Number(new Date().toISOString().slice(0, 4)) - 1}-01-01`;
  await h.db.run('UPDATE patient_insurance SET deductible_year = ? WHERE id = ?', lastYear, primary.id);
  est = (await ctx.api.post(`/patients/${ctx.patient.id}/estimate`, { patient_insurance_id: primary.id, procedure_ids: [proc.id] })).data;
  assert.equal(est.total_deductible, 5000);
  assert.equal(est.total_insurance, Math.round((23500 - 5000) * 0.8));
});

test('the payer-reported deductible (835 PR-1) is what counts toward the deductible', async () => {
  const era = sandbox835({ payee: { name: 'P', npi: '1234567893' }, eft: 'E1', date: '2026-01-15', claims: [{ control_number: 'DM1', billed: 23500, paid: 14800, patient: 8700, write_off: 0, payer_claim_number: 'X' }] })
    .replace('CAS*PR*2*87', 'CAS*PR*1*50*1*2*37');
  const c = parse835(era).claims[0];
  assert.equal(c.deductible, 5000);
});

test('PPO patient portion: the expected write-off is not billed to the patient anywhere', async () => {
  const ctx = await h.practice();
  const { primary } = await insured(ctx, { ppo: true });
  const proc = await completed(ctx);
  const claim = (await ctx.api.post('/claims', { patient_insurance_id: primary.id, procedure_ids: [proc.id] })).data;
  // Allowed $188 (80% of $235): write-off $47, insurance 80% of $188 = $150.40, patient $37.60.
  assert.equal(claim.write_off_estimate, 4700);
  const l = await ledger(ctx.api, ctx.patient);
  assert.deepEqual([l.balance, l.pending_insurance, l.pending_write_off, l.patient_portion], [23500, 15040, 4700, 3760]);
  const st = (await ctx.api.get(`/patients/${ctx.patient.id}/statement`)).data;
  assert.equal(st.amount_due, 3760);
  assert.deepEqual(st.aging, { current: 23500, d31_60: 0, d61_90: 0, d90_plus: 0 }, 'today\'s charge is current');
  // The ledger lines carry the procedure and its claim.
  const charge = l.entries.find((e) => e.type === 'charge');
  assert.equal(charge.proc_code, 'D2392');
  assert.equal(charge.claim_link, claim.id);
  const cands = (await ctx.api.get('/statements/candidates?min_balance=100')).data;
  assert.equal(cands.find((c) => c.id === ctx.patient.id).patient_portion, 3760);
});

test('ledger voids: reversal entries, un-completing work, and what cannot be voided', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const pay = (await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'cash' })).data.entry;
  assert.equal((await api.post(`/ledger/${pay.id}/void`, {})).status, 400, 'a reason is required');
  const v = await api.post(`/ledger/${pay.id}/void`, { reason: 'Posted to the wrong patient' });
  assert.equal(v.status, 201);
  assert.equal(v.data.balance, 0);
  assert.equal((await api.post(`/ledger/${pay.id}/void`, { reason: 'again' })).status, 409);
  assert.equal((await api.post(`/ledger/${v.data.reversal_id}/void`, { reason: 'undo' })).status, 409);
  const entries = (await ledger(api, patient)).entries;
  assert.ok(entries.find((e) => e.id === pay.id).voided_at);
  assert.equal(entries.find((e) => e.id === v.data.reversal_id).amount, 5000);

  // Un-completing a procedure reverses its charge and puts it back to planned.
  const proc = await completed(ctx);
  const un = await api.post(`/procedures/${proc.id}/uncomplete`, { reason: 'Charted on the wrong tooth' });
  assert.equal(un.status, 200, JSON.stringify(un.data));
  assert.equal(un.data.status, 'planned');
  assert.equal((await ledger(api, patient)).balance, 0);
  // Once it's on a claim, the claim has to go first.
  const { primary } = await insured(ctx);
  await api.post(`/procedures/${proc.id}/complete`, {});
  await api.post('/claims', { patient_insurance_id: primary.id, procedure_ids: [proc.id] });
  const r = await api.post(`/procedures/${proc.id}/uncomplete`, { reason: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /void that claim first/);
});

test('closed periods: no posting on or before the lock date, and nothing in the future', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  assert.equal((await api.put('/practice', { lock_date: new Date().toISOString().slice(0, 10) })).status, 400, 'lock date must be in the past');
  assert.equal((await api.put('/practice', { lock_date: yesterday() })).status, 200);
  const back = await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash', entry_date: yesterday() });
  assert.equal(back.status, 400);
  assert.match(back.data.error, /closed through/);
  assert.equal((await api.post(`/patients/${patient.id}/adjustments`, { amount: -500, description: 'x', entry_date: '2099-01-01' })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' })).status, 201);
});

test('refunds: only a real credit, and card payments go back to the card', async () => {
  const { api, patient } = await h.practice();
  assert.equal((await api.post(`/patients/${patient.id}/refunds`, { amount: 100, method: 'cash' })).status, 400, 'no credit');
  const card = (await api.post(`/patients/${patient.id}/payments`, { amount: 4000, method: 'credit_card', reference: 'sbx_pi_test1' })).data.entry;
  await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' });
  assert.equal((await api.post(`/patients/${patient.id}/refunds`, { amount: 6000, method: 'cash' })).status, 400, 'more than the credit');
  const r1 = await api.post(`/patients/${patient.id}/refunds`, { amount: 3000, payment_id: card.id });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  assert.match(r1.data.entry.reference, /^sbx_re_/);
  assert.equal(r1.data.entry.method, 'credit_card');
  assert.equal((await api.post(`/patients/${patient.id}/refunds`, { amount: 1500, payment_id: card.id })).status, 400, 'only $10 of that card payment is left');
  assert.equal((await api.post(`/patients/${patient.id}/refunds`, { amount: 2000, method: 'cash' })).data.balance, 0);
  // The day sheet deposit is net of refunds.
  const day = (await api.get('/reports/daysheet')).data;
  assert.equal(day.deposit.credit_card, 1000);
  assert.equal(day.deposit.cash, -1000);
});

test('payment plans split evenly with no negative installment', async () => {
  const plan = { total: 10, down_payment: 0, installments: 7, installment_amount: 2, frequency: 'monthly', start_date: '2026-01-01', id: -1 };
  const fake = { get: async () => ({ n: 0 }) };
  const s = await planStatus(fake, plan, '2026-01-01');
  assert.deepEqual(s.schedule.map((x) => x.amount), [2, 2, 2, 1, 1, 1, 1]);
  const big = await planStatus(fake, { ...plan, total: 100000, installments: 3, installment_amount: 33334 }, '2026-01-01');
  assert.deepEqual(big.schedule.map((x) => x.amount), [33334, 33333, 33333]);
});

test('aging: credits listed separately, voided payments age as owed; manual EOBs and reopening claims', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const { primary } = await insured(ctx);
  const proc = await completed(ctx);
  const claim = (await api.post('/claims', { patient_insurance_id: primary.id, procedure_ids: [proc.id] })).data;
  await api.post(`/claims/${claim.id}/submit`);
  assert.equal((await api.post(`/claims/${claim.id}/payment`, { amount: 20000, write_off: 5000 })).status, 400, 'more than billed');
  assert.equal((await api.post(`/claims/${claim.id}/payment`, { amount: 18800, write_off: 0 })).status, 200);
  assert.equal((await ledger(api, patient)).balance, 4700);
  // Posted to the wrong claim: reopen it — payment reversed, claim waiting on the payer again.
  assert.equal((await api.post(`/claims/${claim.id}/reopen`, {})).status, 400, 'reason required');
  const re = await api.post(`/claims/${claim.id}/reopen`, { reason: 'EOB was for another patient' });
  assert.equal(re.status, 200);
  assert.equal(re.data.status, 'submitted');
  assert.equal((await ledger(api, patient)).balance, 23500);
  // A $0 EOB (all to deductible) can be posted.
  assert.equal((await api.post(`/claims/${claim.id}/payment`, { amount: 0 })).status, 200);

  // A credit balance shows in the credits list, not the aging buckets.
  const other = (await api.post('/patients', { first_name: 'Cred', last_name: 'It' })).data;
  await api.post(`/patients/${other.id}/payments`, { amount: 2500, method: 'cash' });
  const aging = (await api.get('/reports/aging')).data;
  assert.equal(aging.credits.find((c) => c.id === other.id).credit, 2500);
  assert.ok(!aging.rows.some((r) => r.id === other.id));
  assert.equal(aging.rows.find((r) => r.id === patient.id).current, 23500);
});
