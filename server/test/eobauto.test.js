// Insurance payments posted and billed on autopilot (backlog A1–A5, docs/eob-autopilot.md).
// The dangerous things first: money only posts when a remittance reconciles exactly, never twice, never by AI
// alone, and every other case lands on the worklist; then billing the patient, reconciliation and isolation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';
import { processInbound } from '../src/clearinghouse.js';
import { classify } from '../src/eobauto.js';
import { runEobAutopilot } from '../src/eobjob.js';
import { runCadences } from '../src/cadence.js';
import { createMailer } from '../src/mail.js';

// A stand-in for the Anthropic API (paper EOBs are read by AI): answers with whatever tool call the test sets.
let reply = null;
const fake = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't1', name: 'read_eob', input: reply }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { ediMode: 'sandbox', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });
const d = (c) => (c / 100).toFixed(2);
const DAY = 86400_000;
const later = (days) => new Date(Date.now() + days * DAY);
let traceN = 0;

// An 835 with exactly the claim lines, adjustments and service lines a test needs.
function e835({ trace = `TRN${Date.now() % 100000}${++traceN}`, date = '2026-09-20', payer = 'DELTA DENTAL', claims, plb = [], total = null }) {
  const segs = [];
  const sum = total ?? claims.reduce((s, c) => s + c.paid, 0) - plb.reduce((s, p) => s + p.amount, 0);
  segs.push(`BPR*I*${d(sum)}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999999999*DA*654321*${date.replace(/-/g, '')}`);
  segs.push(`TRN*1*${trace}*1512345678`, `N1*PR*${payer}`, 'N1*PE*PRACTICE*XX*1234567893');
  for (const c of claims) {
    segs.push(`CLP*${c.control}*${c.status ?? (c.paid ? 1 : 4)}*${d(c.billed)}*${d(c.paid)}*${d(c.pr || 0)}*12*${c.pcn || 'PCN1'}`);
    for (const [g, r, a] of c.cas || []) segs.push(`CAS*${g}*${r}*${d(a)}`);
    for (const s of c.svc || []) {
      segs.push(`SVC*AD:${s.code}*${d(s.billed)}*${d(s.paid)}`);
      for (const [g, r, a] of s.cas || []) segs.push(`CAS*${g}*${r}*${d(a)}`);
    }
  }
  if (plb.length) segs.push(`PLB*1234567893*20261231*${plb.map((p) => `${p.reason}:${p.ref || 'X'}*${d(p.amount)}`).join('*')}`);
  return `ISA*00*          *00*          *ZZ*DELTA          *ZZ*PRACTICE       *260101*1200*^*00501*000000002*0*P*:~GS*HP*D*P*20260101*1200*2*X*005010X221A1~ST*835*0001~${segs.join('~')}~SE*${segs.length + 2}*0001~GE*1*2~IEA*1*000000002~`;
}

// A practice with Jane on a Delta policy (optionally a PPO fee schedule and a secondary policy).
async function setup({ schedule = null, secondary = false, settings = null } = {}) {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const pid = patient.practice_id;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  if (schedule) {
    const fs = await h.db.run("INSERT INTO fee_schedules (practice_id, name, kind) VALUES (?, 'Delta PPO', 'ppo')", pid);
    for (const [code, fee] of Object.entries(schedule)) await h.db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', fs.id, code, fee);
    await h.db.run('UPDATE insurance_carriers SET fee_schedule_id = ? WHERE id = ?', fs.id, carrier.id);
  }
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'G1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_preventive: 100, effective_date: '2025-01-01' })).data;
  let policy2 = null;
  if (secondary) {
    const c2 = (await api.post('/carriers', { name: 'MetLife', payer_id: '65978' })).data;
    policy2 = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: c2.id, priority: 'secondary', subscriber_name: 'John Doe', subscriber_id: 'M2', group_number: 'G2', annual_max: 100000, deductible: 0, pct_basic: 50, effective_date: '2025-01-01' })).data;
  }
  if (settings) assert.equal((await api.put('/eob-autopilot/settings', settings)).status, 200);
  return { ...ctx, pid, carrier, policy, policy2 };
}
// A submitted claim for these codes.
async function claimFor(ctx, codes, { policy = ctx.policy } = {}) {
  const ids = [];
  for (const code of codes) ids.push((await ctx.api.post(`/patients/${ctx.patient.id}/procedures`, { code, provider_id: ctx.provider.id, complete: true, ...(code === 'D2392' ? { tooth: '30', surfaces: 'MO' } : {}) })).data.id);
  const claim = (await ctx.api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: ids })).data;
  const sent = await ctx.api.post(`/claims/${claim.id}/submit`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  return (await ctx.api.get(`/claims/${claim.id}`)).data;
}
const ledger = async (ctx) => (await ctx.api.get(`/patients/${ctx.patient.id}/ledger`)).data;
const entries = async (ctx) => { const l = await ledger(ctx); return l.entries || l; };
const mailbox = (ctx, content) => processInbound(h.db, { name: `f${++traceN}.835`, content }, { practiceId: ctx.pid });
const clean = (claim, extra = {}) => ({ control: `DM${claim.id}`, billed: claim.total_fee, paid: claim.total_fee - 5000 - 3500, pr: 3500, cas: [['CO', '45', 5000], ['PR', '2', 3500]], ...extra });
const work = async (ctx) => (await ctx.api.get('/eob-autopilot')).data;

test('the rule: only an exact reconcile is clean', () => {
  const claim = { id: 1, status: 'submitted', total_fee: 23500 };
  const items = [{ id: 11, code: 'D2392', fee: 23500 }];
  const line = (x) => ({ status: 'processed_primary', status_code: '1', billed: 23500, paid: 15000, patient_resp: 3500, adjustments: [{ group: 'CO', reason: '45', amount: 5000 }, { group: 'PR', reason: '2', amount: 3500 }], services: [], ...x });
  assert.equal(classify({ claim, items, lines: [line()] }).kind, null);
  assert.equal(classify({ claim, items, lines: [line()], expected: 18500 }).kind, null, 'allowed 185 = PPO 185');
  assert.equal(classify({ claim, items, lines: [line()], expected: 20000 }).kind, 'underpaid');
  assert.equal(classify({ claim, items, lines: [line()], expected: 17000 }).kind, 'overpaid');
  assert.equal(classify({ claim, items, lines: [line({ paid: 14900 })] }).kind, 'review', 'a cent missing is not clean');
  assert.equal(classify({ claim, items, lines: [line({ paid: 30000 })] }).kind, 'overpaid');
  assert.equal(classify({ claim, items, lines: [line({ status: 'reversal', paid: -15000 })] }).kind, 'reversal');
  assert.equal(classify({ claim: null, items, lines: [line()] }).kind, 'unmatched');
  assert.equal(classify({ claim: { ...claim, status: 'paid' }, items, lines: [line()] }).kind, 'overpaid', 'a second payment on a paid claim');
  assert.equal(classify({ claim, items, lines: [line({ billed: 20000, paid: 11500 })] }).kind, 'partial');
  assert.equal(classify({ claim, items, lines: [line({ adjustments: [{ group: 'CO', reason: '97', amount: 5000 }, { group: 'PR', reason: '2', amount: 3500 }] })] }).kind, 'denied', 'bundling is a line denial');
  assert.equal(classify({ claim, items, lines: [line({ adjustments: [{ group: 'OA', reason: '23', amount: 5000 }, { group: 'PR', reason: '2', amount: 3500 }] })] }).kind, 'review');
  assert.equal(classify({ claim, items, lines: [line({ status: 'denied', status_code: '4', paid: 0, patient_resp: 0, adjustments: [{ group: 'CO', reason: '29', amount: 23500 }] })] }).kind, 'denied');
});

test('A1: a clean ERA posts itself as the automation once auto-posting is on; off, it waits for one click', async () => {
  const ctx = await setup();
  // Off (the default): nothing moves on its own.
  assert.equal((await ctx.api.get('/eob-autopilot/settings')).data.autopost, false);
  const c1 = await claimFor(ctx, ['D2392']);
  const r1 = await mailbox(ctx, e835({ claims: [clean(c1)] }));
  assert.equal(r1.result.ready, 1, JSON.stringify(r1));
  assert.equal((await ctx.api.get(`/claims/${c1.id}`)).data.status, 'submitted');
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment').length, 0);
  let w = await work(ctx);
  assert.deepEqual(w.items.map((i) => i.kind), ['ready']);
  // One click posts every clean one, as the person.
  const posted = await ctx.api.post('/eob-autopilot/post-ready', {});
  assert.equal(posted.data.posted, 1, JSON.stringify(posted.data));
  assert.equal((await ctx.api.get(`/claims/${c1.id}`)).data.status, 'paid');
  const line = await h.db.get('SELECT * FROM remit_lines WHERE claim_id = ?', c1.id);
  assert.deepEqual([line.state, line.posted_source], ['posted', 'human']);

  // On: the next clean ERA posts as the automation — paid, contractual write-off, patient owes their part.
  const on = await ctx.api.put('/eob-autopilot/settings', { autopost: true });
  assert.equal(on.data.autopost_since.length, 10);
  const c2 = await claimFor(ctx, ['D2392']);
  const before = (await ledger(ctx)).balance;
  const r2 = await mailbox(ctx, e835({ claims: [clean(c2)] }));
  assert.equal(r2.result.posted, 1, JSON.stringify(r2));
  const claim = (await ctx.api.get(`/claims/${c2.id}`)).data;
  assert.deepEqual([claim.status, claim.paid_amount], ['paid', 15000]);
  const mine = (await entries(ctx)).filter((e) => e.claim_id === c2.id);
  assert.deepEqual(mine.map((e) => [e.type, e.amount]).sort(), [['adjustment', -5000], ['insurance_payment', -15000]]);
  assert.equal((await ledger(ctx)).balance - before, -15000 - 5000, 'paid and written off; the patient part stays on the account');
  const audit = await h.db.get("SELECT * FROM audit_log WHERE action = 'eob.autopost' AND entity_id = ?", c2.id);
  assert.equal(audit.source, 'automation');
  assert.match(audit.actor, /autopilot/i);
  assert.match(audit.changes, /"status":\["submitted","paid"\]/);
  const items = (await h.db.all('SELECT paid_amount, patient_resp FROM claim_items WHERE claim_id = ?', c2.id));
  assert.deepEqual(items.map((i) => i.paid_amount), [15000]);
  w = await work(ctx);
  assert.equal(w.items.length, 0);
});

test('A3: every exception is routed to the worklist with the reason and next step — and nothing posts', async () => {
  const ctx = await setup({ schedule: { D2392: 20000, D0274: 6000, D1110: 9000, D0120: 5000 }, settings: { autopost: true } });
  const denied = await claimFor(ctx, ['D2392']);
  const under = await claimFor(ctx, ['D0274']);
  const over = await claimFor(ctx, ['D1110']);
  const partial = await claimFor(ctx, ['D2392', 'D0120']);
  const oa = await claimFor(ctx, ['D0120']);
  const fine = await claimFor(ctx, ['D2392']);
  const era = e835({
    claims: [
      { control: `DM${denied.id}`, billed: 23500, paid: 0, cas: [['CO', '29', 23500]] },
      // PPO says $60 allowed; the payer allowed $50.
      { control: `DM${under.id}`, billed: 7000, paid: 4000, pr: 1000, cas: [['CO', '45', 2000], ['PR', '2', 1000]] },
      { control: `DM${over.id}`, billed: 11000, paid: 12000, pr: 0, cas: [] },
      { control: `DM${partial.id}`, billed: 23500, paid: 16000, pr: 4000, cas: [['CO', '45', 3500], ['PR', '2', 4000]], svc: [{ code: 'D2392', billed: 23500, paid: 16000 }] },
      { control: `DM${oa.id}`, billed: 6500, paid: 3000, pr: 0, cas: [['CO', '45', 1500], ['OA', '23', 2000]] },
      { control: 'DM999999', billed: 5000, paid: 5000 },
      { control: `DM${fine.id}`, billed: 23500, paid: 16000, pr: 4000, cas: [['CO', '45', 3500], ['PR', '2', 4000]] },
    ],
  });
  const res = await mailbox(ctx, era);
  assert.equal(res.result.posted, 1, JSON.stringify(res.result));
  const w = await work(ctx);
  const kindOf = (claimId) => w.items.find((i) => i.claim_id === claimId)?.kind;
  assert.equal(kindOf(denied.id), 'denied');
  assert.equal(kindOf(under.id), 'underpaid');
  assert.equal(kindOf(over.id), 'overpaid');
  assert.equal(kindOf(partial.id), 'partial');
  assert.equal(kindOf(oa.id), 'review');
  assert.equal(kindOf(fine.id), undefined, 'the clean one posted');
  assert.ok(w.items.some((i) => i.kind === 'unmatched' && i.control_number === 'DM999999'));
  // Plain words and next steps.
  const den = w.items.find((i) => i.claim_id === denied.id);
  assert.match(den.reason, /filing deadline/);
  assert.equal(den.actions[0].action, 'appeal', 'timely filing: appeal first');
  assert.ok(!den.actions.some((a) => a.action === 'bill_patient'), 'a CO denial is never billed to the patient');
  assert.match(w.items.find((i) => i.claim_id === under.id).reason, /\$50\.00.*\$60\.00/);
  assert.equal(w.items.find((i) => i.claim_id === over.id).actions[0].action, 'refund');
  // Only the clean claim touched the ledger; the denial is recorded on the claim.
  const ins = (await entries(ctx)).filter((e) => e.type === 'insurance_payment');
  assert.deepEqual(ins.map((e) => e.claim_id), [fine.id]);
  assert.equal((await ctx.api.get(`/claims/${denied.id}`)).data.status, 'denied');
  assert.match((await ctx.api.get(`/claims/${denied.id}`)).data.denial_reason, /CO-29/);
  // The remittance is a Needs attention item until its lines are dealt with.
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key LIKE 'era:%' AND status = 'open'", ctx.pid);
  assert.match(issue.title, /6 claim lines need a person/);

  // Decisions: accept the underpayment (posts as the payer says), refund task for the overpayment,
  // dismiss the stranger with a reason, post the partial (claim stays open), match nothing else.
  const id = (claimId) => w.items.find((i) => i.claim_id === claimId).id;
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${id(under.id)}/post`)).status, 200);
  assert.equal((await ctx.api.get(`/claims/${under.id}`)).data.status, 'paid');
  const refund = await ctx.api.post(`/eob-autopilot/lines/${id(over.id)}/refund`);
  assert.equal(refund.status, 200);
  assert.ok(await h.db.get("SELECT id FROM tasks WHERE id = ? AND title LIKE 'Refund $120.00%'", refund.data.line.task_id));
  assert.equal((await ctx.api.get(`/claims/${over.id}`)).data.status, 'submitted', 'an overpayment is not posted on its own');
  const stranger = w.items.find((i) => i.kind === 'unmatched').id;
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${stranger}/dismiss`, {})).status, 400, 'a reason is required');
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${stranger}/dismiss`, { note: 'Not our patient' })).status, 200);
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${id(partial.id)}/post`)).status, 200);
  assert.equal((await ctx.api.get(`/claims/${partial.id}`)).data.status, 'partially_paid');
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${id(partial.id)}/post`)).status, 200, 'the same key twice is harmless');
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment' && e.claim_id === partial.id).length, 1);
  // Bill the patient for a denial they're responsible for (PR-204): the claim closes to the patient.
  const nc = await claimFor(ctx, ['D0120']);
  await mailbox(ctx, e835({ claims: [{ control: `DM${nc.id}`, billed: 6500, paid: 0, pr: 6500, cas: [['PR', '204', 6500]] }] }));
  const ncLine = (await work(ctx)).items.find((i) => i.claim_id === nc.id);
  assert.equal(ncLine.kind, 'denied');
  assert.equal(ncLine.actions[0].action, 'bill_patient');
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${ncLine.id}/bill_patient`)).status, 200);
  assert.equal((await h.db.get('SELECT resolution FROM remit_lines WHERE id = ?', ncLine.id)).resolution, 'bill_patient');
});

test('the same ERA twice never posts twice; a re-sent line is skipped; two clicks post once', async () => {
  const ctx = await setup();
  const c = await claimFor(ctx, ['D2392']);
  const era = e835({ trace: 'EFT-DUP-1', claims: [clean(c)] });
  const first = await ctx.api.post('/era/import?filename=a.835', era);
  assert.equal(first.status, 201);
  assert.equal(first.data.claims[0].result, 'posted', 'a person imported it: it posts as them');
  assert.equal((await ctx.api.post('/era/import', era)).status, 409);
  assert.equal((await mailbox(ctx, era)).result.posted, 0);
  // The payer re-sends the same trace with a different total (a corrected file): lines already received are skipped.
  const again = await ctx.api.post('/era/import', e835({ trace: 'EFT-DUP-1', claims: [clean(c)], total: 15001 }));
  assert.equal(again.status, 201);
  assert.match(again.data.claims[0].result, /already received/);
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment').length, 1);

  // Two people (or a double click) posting the same ready line: one posting.
  const c2 = await claimFor(ctx, ['D2392']);
  await mailbox(ctx, e835({ claims: [clean(c2)] }));
  const line = (await work(ctx)).items.find((i) => i.claim_id === c2.id);
  const both = await Promise.all([ctx.api.post(`/eob-autopilot/lines/${line.id}/post`), ctx.api.post('/eob-autopilot/post-ready', { line_ids: [line.id] })]);
  assert.ok(both.some((r) => r.status === 200));
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment' && e.claim_id === c2.id).length, 1);
});

test('a reversal ERA is never posted on its own; reversing it reopens the claim with reversing entries', async () => {
  const ctx = await setup({ settings: { autopost: true } });
  const c = await claimFor(ctx, ['D2392']);
  await mailbox(ctx, e835({ claims: [clean(c)] }));
  const bal = (await ledger(ctx)).balance;
  await mailbox(ctx, e835({ claims: [{ control: `DM${c.id}`, status: 22, billed: -23500, paid: -15000, pr: -3500, cas: [['CO', '45', -5000], ['PR', '2', -3500]] }], total: -15000 }));
  const rev = (await work(ctx)).items.find((i) => i.claim_id === c.id);
  assert.equal(rev.kind, 'reversal');
  assert.equal((await ctx.api.get(`/claims/${c.id}`)).data.status, 'paid', 'nothing changed yet');
  // The assistant can't do it without the person's OK.
  const ai = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/eob-autopilot/lines/${rev.id}/reverse`)).status, 428);
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${rev.id}/reverse`)).status, 200);
  const claim = (await ctx.api.get(`/claims/${c.id}`)).data;
  assert.deepEqual([claim.status, claim.paid_amount], ['submitted', 0]);
  const es = (await entries(ctx)).filter((e) => e.claim_id === c.id);
  assert.equal(es.filter((e) => e.reverses_id).length, 2, 'payment and write-off reversed, not edited');
  assert.ok(es.filter((e) => !e.reverses_id).every((e) => e.voided_at));
  assert.equal((await ledger(ctx)).balance, bal + 15000 + 5000);
});

test('split and partial payments: two lines of one claim post together; a claim paid in two remittances closes on the second', async () => {
  const ctx = await setup({ settings: { autopost: true } });
  const c = await claimFor(ctx, ['D2392', 'D0274']);
  await mailbox(ctx, e835({
    claims: [
      { control: `DM${c.id}`, billed: 23500, paid: 15000, pr: 3500, cas: [['CO', '45', 5000], ['PR', '2', 3500]] },
      { control: `DM${c.id}`, billed: 7000, paid: 5000, pr: 1000, cas: [['CO', '45', 1000], ['PR', '2', 1000]] },
    ],
  }));
  let claim = (await ctx.api.get(`/claims/${c.id}`)).data;
  assert.deepEqual([claim.status, claim.paid_amount], ['paid', 20000]);
  assert.equal((await h.db.get('SELECT lines_count FROM remit_lines WHERE claim_id = ?', c.id)).lines_count, 2);

  const p = await claimFor(ctx, ['D2392', 'D0274']);
  await mailbox(ctx, e835({ claims: [{ control: `DM${p.id}`, billed: 23500, paid: 15000, pr: 3500, cas: [['CO', '45', 5000], ['PR', '2', 3500]], svc: [{ code: 'D2392', billed: 23500, paid: 15000 }] }] }));
  let line = (await work(ctx)).items.find((i) => i.claim_id === p.id);
  assert.equal(line.kind, 'partial');
  await ctx.api.post(`/eob-autopilot/lines/${line.id}/post`);
  assert.equal((await ctx.api.get(`/claims/${p.id}`)).data.status, 'partially_paid');
  await mailbox(ctx, e835({ claims: [{ control: `DM${p.id}`, billed: 7000, paid: 5000, pr: 1000, cas: [['CO', '45', 1000], ['PR', '2', 1000]], svc: [{ code: 'D0274', billed: 7000, paid: 5000 }] }] }));
  line = (await work(ctx)).items.find((i) => i.claim_id === p.id);
  assert.equal(line.kind, 'partial', 'the second part still needs a look');
  await ctx.api.post(`/eob-autopilot/lines/${line.id}/post`);
  claim = (await ctx.api.get(`/claims/${p.id}`)).data;
  assert.deepEqual([claim.status, claim.paid_amount], ['paid', 20000]);
});

test('secondary: the primary posting drafts the secondary, it shows on the worklist, one key attaches the paper EOB, and the patient is not billed meanwhile', async () => {
  const ctx = await setup({ secondary: true, settings: { billing: true, wait_days: 0 } });
  const c = await claimFor(ctx, ['D2392']);
  // A paper primary EOB, approved by a person.
  const dos = (await h.db.get('SELECT MIN(pr.completed_at) AS d FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', c.id)).d.slice(0, 10);
  reply = { payer_name: 'Delta Dental', check_number: 'CHK-2', check_date: dos, total_paid: 150, method: 'check', claims: [{ patient_name: 'DOE, JANE', date_of_service: dos, paid: 150, patient_responsibility: 35, lines: [{ code: 'D2392', tooth: '30', billed: 235, allowed: 185, paid: 150, write_off: 50, patient_resp: 35 }] }] };
  const up = await upload(ctx, jpeg('secondary'));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal((await ctx.api.post(`/eob-autopilot/paper/${up.data.id}/post`)).status, 200);
  const sec = await h.db.get('SELECT * FROM claims WHERE primary_claim_id = ?', c.id);
  assert.equal(sec.status, 'draft');
  const item = (await work(ctx)).items.find((i) => i.kind === 'secondary');
  assert.equal(item.claim_id, sec.id);
  assert.equal(item.paper_eob_id, up.data.id);
  // Balance billing waits for the secondary.
  await runEobAutopilot(h.db, { practiceIds: [ctx.pid], mailer: createMailer({ env: { MAIL_DRIVER: 'log' } }), appUrl: 'https://app.example.com' });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM balance_bills WHERE practice_id = ?', ctx.pid)).n, 0);
  // One key: the primary's EOB is filed on the chart and attached; then the usual send.
  const prep = await ctx.api.post(`/eob-autopilot/claims/${sec.id}/send-secondary`);
  assert.equal(prep.status, 200, JSON.stringify(prep.data));
  const att = await h.db.get('SELECT a.*, d.category, d.patient_id FROM claim_attachments a JOIN documents d ON d.id = a.document_id WHERE a.claim_id = ?', sec.id);
  assert.deepEqual([att.report_type, att.category, att.patient_id], ['EB', 'eob', ctx.patient.id]);
  assert.equal((await ctx.api.post(`/eob-autopilot/claims/${sec.id}/send-secondary`)).data.attachment_id, att.id, 'twice attaches once');
  assert.equal((await ctx.api.post(`/claims/${sec.id}/submit`)).status, 200);
  assert.ok(!(await work(ctx)).items.some((i) => i.kind === 'secondary'));
});

// Paper EOB uploads: the file's bytes as the body.
const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fake photo ${tag} ${Math.random()}`)]);
async function upload(ctx, bytes, headers = {}) {
  const res = await fetch(`${h.origin}/api/eob-autopilot/paper?filename=eob.jpg`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'image/jpeg', ...headers }, body: bytes });
  return { status: res.status, data: await res.json() };
}

test('A2: a paper EOB is read by AI into the same lines; nothing posts until a person says it looks right', async () => {
  const ctx = await setup();
  const a = await claimFor(ctx, ['D2392']);
  const b = await claimFor(ctx, ['D0274']);
  const dos = (await h.db.get('SELECT substr(MIN(pr.completed_at), 1, 10) AS d FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', a.id)).d;
  await h.db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', 'PX-B', b.id);
  reply = {
    payer_name: 'Delta Dental', check_number: '88123', check_date: dos, total_paid: 200, method: 'check',
    claims: [
      { patient_name: 'DOE, JANE', date_of_service: dos, paid: 150, patient_responsibility: 35, lines: [{ code: 'D2392', tooth: '30', billed: 235, paid: 150, write_off: 50, patient_resp: 35 }] },
      // Misread (or really short): it doesn't add up, so it waits for a person.
      { patient_name: 'DOE, JANE', payer_claim_number: 'PX-B', date_of_service: dos, paid: 50, patient_responsibility: 10, lines: [{ code: 'D0274', billed: 70, paid: 50, write_off: 0, patient_resp: 10 }] },
    ],
  };
  assert.equal((await upload(ctx, Buffer.from('<html>not an eob</html>'))).status, 415);
  const bytes = jpeg('a');
  const up = await upload(ctx, bytes);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual([up.data.clean, up.data.exceptions], [1, 1]);
  assert.equal((await ctx.api.get(`/claims/${a.id}`)).data.status, 'submitted', 'AI never posts money');
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment').length, 0);
  const again = await upload(ctx, bytes);
  assert.equal(again.data.id, up.data.id);
  assert.equal(again.data.duplicate, true, 'the same file twice is one EOB');
  // The assistant can't approve it on its own (428); with the person's OK on screen it can.
  const ai = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/eob-autopilot/paper/${up.data.id}/post`)).status, 428);
  assert.equal((await ai.post('/eob-autopilot/post-ready', {})).status, 428);
  const ok = await h.client(ctx.token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }).post(`/eob-autopilot/paper/${up.data.id}/post`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.posted, 1);
  const claim = (await ctx.api.get(`/claims/${a.id}`)).data;
  assert.deepEqual([claim.status, claim.paid_amount], ['paid', 15000]);
  assert.equal((await ctx.api.get(`/claims/${b.id}`)).data.status, 'submitted', 'the one that didn’t add up is still waiting');
  const trail = await h.db.get("SELECT * FROM audit_log WHERE action = 'eob.paper_post' AND entity_id = ?", up.data.id);
  assert.match(trail.details, /"read_by":"AI"/);
  assert.match(trail.actor, /approved by/);
  // Posting again posts nothing more; the EOB is filed on each claim.
  assert.equal((await ctx.api.post(`/eob-autopilot/paper/${up.data.id}/post`)).data.already, true);
  assert.equal((await entries(ctx)).filter((e) => e.type === 'insurance_payment').length, 1);
  const filed = (await ctx.api.get(`/claims/${a.id}/remittances`)).data;
  assert.equal(filed[0].eob_url, `/api/eob-autopilot/paper/${up.data.id}/file`);
  const file = await fetch(`${h.origin}${filed[0].eob_url}`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));
});

test('A4: billing the patient — wait days, minimum, hold, one bill per account, paper if unopened, stop when paid', async () => {
  const ctx = await setup({ settings: { billing: true, min_balance: 500, wait_days: 3, paper_days: 10 } });
  const mailer = createMailer({ env: { MAIL_DRIVER: 'log' } });
  const deps = (days) => ({ practiceIds: [ctx.pid], mailer, appUrl: 'https://app.example.com', now: later(days) });
  const cadence = (days) => runCadences(h.db, { messenger: h.messenger, appUrl: 'https://app.example.com', secret: 'test-secret', now: later(days), practiceIds: [ctx.pid] });
  const c = await claimFor(ctx, ['D2392']);
  await ctx.api.post('/era/import', e835({ claims: [clean(c)] }));
  // Closed today: nothing until the wait is over.
  await runEobAutopilot(h.db, deps(0));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM balance_bills WHERE practice_id = ?', ctx.pid)).n, 0);
  await runEobAutopilot(h.db, deps(3));
  const bill = await h.db.get('SELECT * FROM balance_bills WHERE practice_id = ?', ctx.pid);
  assert.deepEqual([bill.status, bill.amount, bill.patient_id], ['active', 3500, ctx.patient.id]);
  // The text with the pay link, once — however often the jobs run.
  const sentBefore = h.sent.length;
  await cadence(3);
  await cadence(3);
  await runEobAutopilot(h.db, deps(3));
  const texts = h.sent.slice(sentBefore).filter((m) => m.to === ctx.patient.phone || m.channel === 'sms' || /pay/i.test(m.body || ''));
  assert.equal(texts.length, 1, JSON.stringify(h.sent.slice(sentBefore)));
  const msg = await h.db.get("SELECT * FROM messages WHERE patient_id = ? AND kind = 'statement' ORDER BY id DESC LIMIT 1", ctx.patient.id);
  assert.ok(msg, 'logged as a statement message');
  const link = /https:\/\/app\.example\.com(\/api\/public\/pay-balance\/[^\s]+)/.exec(msg.body)[1];
  // A second claim closing joins the open bill (no second statement).
  const c2 = await claimFor(ctx, ['D2392']);
  await ctx.api.post('/era/import', e835({ claims: [clean(c2)] }));
  await runEobAutopilot(h.db, deps(6));
  assert.equal((await h.db.get('SELECT status FROM balance_bills WHERE claim_id = ?', c2.id)).status, 'merged');
  // The pay page: the account's balance after insurance; a link-preview robot doesn't count as opened.
  const bot = await fetch(`${h.origin}${link}`, { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
  assert.match(await bot.text(), /\$70\.00/);
  assert.equal((await h.db.get('SELECT link_opened_at FROM balance_bills WHERE id = ?', bill.id)).link_opened_at, null);
  // Unopened after paper_days: one paper statement by mail.
  await runEobAutopilot(h.db, deps(13));
  await runEobAutopilot(h.db, deps(14));
  const paper = await h.db.all("SELECT * FROM statement_deliveries WHERE patient_id = ? AND method = 'mail'", ctx.patient.id);
  assert.equal(paper.length, 1);
  assert.equal((await h.db.get('SELECT paper_status FROM balance_bills WHERE id = ?', bill.id)).paper_status, 'sent');
  // Paid: the bill stops and so do the reminders.
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/payments`, { amount: 7000, method: 'cash' })).status, 201);
  await runEobAutopilot(h.db, deps(15));
  assert.equal((await h.db.get('SELECT status FROM balance_bills WHERE id = ?', bill.id)).status, 'paid');
  const n = h.sent.length;
  await cadence(21);
  assert.equal(h.sent.length, n, 'no reminder after paying');
  assert.equal((await h.db.get("SELECT e.stop_reason FROM cadence_enrollments e WHERE e.source_type = 'balance_bill' AND e.source_id = ?", bill.id)).stop_reason, 'paid');
});

test('A4: below the minimum, on the hold list or opened link — no bill or no paper', async () => {
  const ctx = await setup({ settings: { billing: true, min_balance: 5000, wait_days: 0, paper_days: 5 } });
  const mailer = createMailer({ env: { MAIL_DRIVER: 'log' } });
  const deps = (days) => ({ practiceIds: [ctx.pid], mailer, appUrl: 'https://app.example.com', now: later(days) });
  const c = await claimFor(ctx, ['D2392']);
  await ctx.api.post('/era/import', e835({ claims: [clean(c)] }));
  await runEobAutopilot(h.db, deps(0));
  assert.deepEqual(await h.db.get('SELECT status, stop_reason FROM balance_bills WHERE claim_id = ?', c.id), { status: 'skipped', stop_reason: 'below_minimum' });
  // Hold list: the owner holds Jane; her next claim isn't billed until the hold is released.
  await ctx.api.put('/eob-autopilot/settings', { min_balance: 500 });
  const hold = await ctx.api.post(`/cadence/patients/${ctx.patient.id}/holds`, { reason: 'other', type: 'patient_balance', note: 'Owner is talking to her' });
  assert.equal(hold.status, 201, JSON.stringify(hold.data));
  const c2 = await claimFor(ctx, ['D2392']);
  await ctx.api.post('/era/import', e835({ claims: [clean(c2)] }));
  await runEobAutopilot(h.db, deps(1));
  assert.equal(await h.db.get('SELECT id FROM balance_bills WHERE claim_id = ?', c2.id), undefined);
  assert.ok((await ctx.api.get('/eob-autopilot/billing')).data.holds.some((x) => x.patient_id === ctx.patient.id));
  await ctx.api.post(`/cadence/holds/${hold.data.id}/release`);
  await runEobAutopilot(h.db, deps(1));
  const bill = await h.db.get('SELECT * FROM balance_bills WHERE claim_id = ?', c2.id);
  assert.equal(bill.status, 'active');
  await runCadences(h.db, { messenger: h.messenger, appUrl: 'https://app.example.com', secret: 'test-secret', now: later(1), practiceIds: [ctx.pid] });
  const msg = await h.db.get("SELECT * FROM messages WHERE patient_id = ? AND kind = 'statement' ORDER BY id DESC LIMIT 1", ctx.patient.id);
  const link = /(\/api\/public\/pay-balance\/[^\s]+)/.exec(msg.body)[1];
  const page = await fetch(`${h.origin}${link}`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
  assert.equal(page.status, 200);
  assert.ok((await h.db.get('SELECT link_opened_at FROM balance_bills WHERE id = ?', bill.id)).link_opened_at, 'opened by the patient');
  // No card processor here: "pay" goes to the patient portal.
  const pay = await fetch(`${h.origin}${link}`, { method: 'POST', redirect: 'manual' });
  assert.equal(pay.status, 303);
  assert.match(pay.headers.get('location'), /\/portal\//);
  await runEobAutopilot(h.db, deps(8));
  assert.equal((await h.db.get('SELECT paper_status FROM balance_bills WHERE id = ?', bill.id)).paper_status, null, 'opened: no paper');
  assert.equal((await fetch(`${h.origin}/api/public/pay-balance/1.AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
});

test('A5: reconciliation lists ERA vs posted vs deposited and claims billed vs paid vs written off vs patient, and raises/resolves gaps', async () => {
  const ctx = await setup({ settings: { autopost: true } });
  const c = await claimFor(ctx, ['D2392']);
  const date = new Date(Date.now() - 8 * DAY).toISOString().slice(0, 10);
  // The EFT says $160, its one claim was paid $150: $10 isn't explained.
  await mailbox(ctx, e835({ date, claims: [clean(c)], total: 16000 }));
  const era = await h.db.get('SELECT id FROM era_imports WHERE practice_id = ? ORDER BY id DESC LIMIT 1', ctx.pid);
  // A bank feed is connected and hasn't seen the EFT.
  const conn = await h.db.run("INSERT INTO bank_connections (practice_id, provider, status) VALUES (?, 'plaid', 'active')", ctx.pid);
  const acct = await h.db.run("INSERT INTO bank_accounts (practice_id, connection_id, external_id, name, deposits_here) VALUES (?, ?, 'acc1', 'Checking', 1)", ctx.pid, conn.id);
  const rec = (await ctx.api.get(`/eob-autopilot/reconciliation?from=${date}`)).data;
  const row = rec.remittances.find((r) => r.id === era.id);
  assert.deepEqual([row.total, row.posted, row.unaccounted, row.deposited], [16000, 15000, 1000, false]);
  const cl = rec.claims.find((x) => x.claim_id === c.id);
  assert.deepEqual([cl.billed, cl.paid, cl.written_off, cl.patient_part, cl.gaps.length], [23500, 15000, 5000, 3500, 0]);
  await runEobAutopilot(h.db, { practiceIds: [ctx.pid] });
  const open = async () => (await h.db.all("SELECT dedupe_key FROM issues WHERE practice_id = ? AND status = 'open' AND dedupe_key LIKE 'eobrecon:%' ORDER BY dedupe_key", ctx.pid)).map((i) => i.dedupe_key);
  assert.deepEqual(await open(), [`eobrecon:era:${era.id}`, `eobrecon:eft:${era.id}`].sort());
  // The check-level row is explained by a person, and the EFT shows up in the bank: both close.
  const check = (await work(ctx)).items.find((i) => i.era_import_id === era.id && !i.claim_id);
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${check.id}/dismiss`, { note: 'Interest, booked as income' })).status, 200);
  await h.db.run("INSERT INTO bank_transactions (practice_id, account_id, external_id, date, amount, description, match_kind, match_refs) VALUES (?, ?, 'tx1', ?, 16000, 'DELTA DENTAL EFT', 'era', ?)", ctx.pid, acct.id, date, JSON.stringify([`era:${era.id}`]));
  await runEobAutopilot(h.db, { practiceIds: [ctx.pid] });
  assert.deepEqual(await open(), []);
  // A write-off posted on the claim by hand: what's left for the patient no longer matches the payer — a gap.
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, claim_id, entry_date) VALUES (?, ?, 'adjustment', -1000, 'Extra write-off', ?, ?)", ctx.pid, ctx.patient.id, c.id, date);
  await runEobAutopilot(h.db, { practiceIds: [ctx.pid] });
  assert.deepEqual(await open(), [`eobrecon:claim:${c.id}`]);
  const day = (await ctx.api.get(`/eob-autopilot/reconciliation?from=${date}`)).data.days.find((x) => x.claims_closed);
  assert.ok(day.gaps >= 1);
});

test('practice isolation and permissions', async () => {
  const a = await setup();
  const b = await setup();
  const c = await claimFor(a, ['D2392']);
  await mailbox(a, e835({ claims: [clean(c)] }));
  const line = (await work(a)).items[0];
  assert.equal((await b.api.get(`/eob-autopilot/lines/${line.id}`)).status, 404);
  assert.equal((await b.api.post(`/eob-autopilot/lines/${line.id}/post`)).status, 404);
  assert.equal((await b.api.post('/eob-autopilot/post-ready', { line_ids: [line.id] })).data.posted, 0);
  assert.equal((await b.api.get(`/claims/${c.id}/remittances`)).status, 404);
  assert.equal((await b.api.post(`/eob-autopilot/claims/${c.id}/send-secondary`)).status, 404);
  assert.equal((await work(b)).items.length, 0);
  assert.equal((await a.api.get(`/claims/${c.id}`)).data.status, 'submitted');
  // B's mailbox file naming A's claim doesn't touch it.
  await mailbox(b, e835({ claims: [clean(c)] }));
  assert.equal((await work(b)).items[0].kind, 'unmatched');
  assert.equal((await a.api.get(`/claims/${c.id}`)).data.status, 'submitted');
  // Only an administrator turns auto-posting on; the assistant can't at all without the person's OK.
  const email = `desk-${Date.now()}@example.com`;
  await a.api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const desk = h.client((await h.client().post('/auth/login', { email, password: 'front-desk-password' })).data.token);
  assert.equal((await desk.put('/eob-autopilot/settings', { autopost: true })).status, 403);
  assert.equal((await h.client(a.token, { 'X-Acting-For': 'assistant' }).put('/eob-autopilot/settings', { autopost: true })).status, 428);
  assert.equal((await a.api.put('/eob-autopilot/settings', { autopost: 'yes' })).status, 400);
  const audit = await a.api.put('/eob-autopilot/settings', { autopost: true, reason: 'Preview matched the team for 30 days' });
  assert.equal(audit.status, 200);
  const trail = await h.db.get("SELECT * FROM audit_log WHERE action = 'eob_autopilot.settings' AND practice_id = ? ORDER BY id DESC LIMIT 1", a.pid);
  assert.match(trail.changes, /"eob_autopost":\[0,1\]/);
});

test('preview: what auto-posting would have done over the last 30 days, compared with what the team posted', async () => {
  const ctx = await setup();
  const c1 = await claimFor(ctx, ['D2392']);
  const c2 = await claimFor(ctx, ['D2392']);
  await ctx.api.post('/era/import', e835({ claims: [clean(c1), { control: `DM${c2.id}`, billed: 23500, paid: 0, cas: [['CO', '29', 23500]] }] }));
  const p = (await ctx.api.get('/eob-autopilot/preview')).data;
  assert.deepEqual([p.would_post, p.would_post_amount, p.exceptions, p.matched_team], [1, 15000, 1, 1]);
  assert.deepEqual(p.by_kind, { denied: 1 });
});

test('W9: an AI read of a paper EOB never denies a claim on its own; the person who approves it does', async () => {
  const ctx = await setup({ settings: { billing: true, min_balance: 500, wait_days: 0, paper_days: 10 } });
  const a = await claimFor(ctx, ['D2392']);
  const b = await claimFor(ctx, ['D2392']);
  const dos = (await h.db.get('SELECT substr(MIN(pr.completed_at), 1, 10) AS d FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', a.id)).d;
  await h.db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', 'PX-A', a.id);
  await h.db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', 'PX-C', b.id);
  const denial = (pcn) => ({
    payer_name: 'Delta Dental', check_number: '0', check_date: dos, total_paid: 0, method: 'check',
    claims: [{ patient_name: 'DOE, JANE', payer_claim_number: pcn, date_of_service: dos, paid: 0, denied: true, patient_responsibility: 0, lines: [{ code: 'D2392', tooth: '30', billed: 235, paid: 0, write_off: 0, patient_resp: 0 }] }],
  });
  const events = async (id) => h.db.all("SELECT source, status FROM claim_events WHERE claim_id = ? AND status = 'denied'", id);

  reply = denial('PX-A');
  const up = await upload(ctx, jpeg('deny-a'));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual(up.data.lines.map((l) => [l.state, l.kind]), [['exception', 'denied']], 'the denial waits on the worklist');
  assert.equal((await ctx.api.get(`/claims/${a.id}`)).data.status, 'submitted', 'nobody approved anything: the claim is as it was');
  assert.deepEqual(await events(a.id), []);
  assert.equal(await h.db.get("SELECT id FROM audit_log WHERE entity = 'claims' AND entity_id = ? AND action LIKE 'eob.%'", a.id), undefined);
  await runEobAutopilot(h.db, { practiceIds: [ctx.pid], appUrl: 'https://app.example.com' });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM balance_bills WHERE patient_id = ?', ctx.patient.id)).n, 0, 'the patient isn’t billed on an unapproved read');

  // "Looks right — post": the person approves the read, and the denial is theirs.
  const ok = await ctx.api.post(`/eob-autopilot/paper/${up.data.id}/post`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const claimA = (await ctx.api.get(`/claims/${a.id}`)).data;
  assert.equal(claimA.status, 'denied');
  assert.deepEqual(await events(a.id), [{ source: 'eob', status: 'denied' }]);
  const trail = await h.db.get("SELECT * FROM audit_log WHERE action = 'eob.paper_denial' AND entity_id = ?", a.id);
  assert.equal(trail.source, 'human');
  assert.match(trail.reason, /Paper EOB read by AI/);
  assert.match(trail.details, /"read_by":"AI"/);
  assert.match(trail.changes, /"status":\["submitted","denied"\]/);
  assert.ok((await work(ctx)).items.some((i) => i.claim_id === a.id && i.kind === 'denied'), 'the denied row stays for the next step');

  // Or the person's decision on the line (appeal, resend, bill the patient) — "nothing to do" leaves the claim.
  reply = denial('PX-C');
  const up2 = await upload(ctx, jpeg('deny-c'));
  const line = up2.data.lines[0];
  assert.equal((await ctx.api.get(`/claims/${b.id}`)).data.status, 'submitted');
  const appeal = await ctx.api.post(`/eob-autopilot/lines/${line.id}/appeal`, {});
  assert.equal(appeal.status, 200, JSON.stringify(appeal.data));
  assert.equal((await ctx.api.get(`/claims/${b.id}`)).data.status, 'denied');
  assert.equal((await events(b.id)).length, 1);
  assert.equal((await h.db.get("SELECT source FROM audit_log WHERE action = 'eob.paper_denial' AND entity_id = ?", b.id)).source, 'human');
});

test('W9: a paper EOB’s check is recorded for its printed total, so it reconciles once the exceptions post', async () => {
  const ctx = await setup();
  const a = await claimFor(ctx, ['D2392']);
  const b = await claimFor(ctx, ['D0274']);
  const dos = (await h.db.get('SELECT substr(MIN(pr.completed_at), 1, 10) AS d FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', a.id)).d;
  await h.db.run('UPDATE claims SET payer_claim_number = ? WHERE id = ?', 'PX-B2', b.id);
  reply = {
    payer_name: 'Delta Dental', check_number: '88124', check_date: dos, total_paid: 200, method: 'check',
    claims: [
      { patient_name: 'DOE, JANE', date_of_service: dos, paid: 150, patient_responsibility: 35, lines: [{ code: 'D2392', tooth: '30', billed: 235, paid: 150, write_off: 50, patient_resp: 35 }] },
      { patient_name: 'DOE, JANE', payer_claim_number: 'PX-B2', date_of_service: dos, paid: 50, patient_responsibility: 10, lines: [{ code: 'D0274', billed: 70, paid: 50, write_off: 0, patient_resp: 10 }] },
    ],
  };
  const up = await upload(ctx, jpeg('check'));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual([up.data.clean, up.data.exceptions], [1, 1]);
  assert.equal((await ctx.api.post(`/eob-autopilot/paper/${up.data.id}/post`)).status, 200);
  const chk = await h.db.get('SELECT * FROM insurance_checks WHERE practice_id = ?', ctx.pid);
  assert.equal(chk.amount, 20000, 'the check is what the bank deposits, not just the clean lines');
  const ex = await h.db.get("SELECT * FROM remit_lines WHERE paper_eob_id = ? AND state = 'exception' AND line_no >= 0", up.data.id);
  assert.equal((await ctx.api.post(`/eob-autopilot/lines/${ex.id}/post`, {})).status, 200);
  const { reconcileInsuranceChecks } = await import('../src/reconcile.js');
  const rec = await reconcileInsuranceChecks(h.db, ctx.pid, '2000-01-01', '2100-01-01');
  assert.deepEqual(rec.differences, [], 'the check and what was posted to it agree');
});
