import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';

// A stand-in for the Anthropic API that answers with whatever tool call the test sets.
const seen = [];
let reply = null;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'toolu_1', name: reply.name, input: reply.input }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());

const h = harness({ config: { ediMode: 'manual', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });

async function setup() {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'ACME', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50, effective_date: '2025-01-01' })).data;
  return { ...ctx, carrier, policy };
}
const proc = async ({ api, patient, provider }, code, extra = {}) => (await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, ...extra })).data;
const estimate = async ({ api, patient, policy }, ids) => (await api.post(`/patients/${patient.id}/estimate`, { patient_insurance_id: policy.id, procedure_ids: ids })).data;
const PDF = Buffer.from('%PDF-1.4 benefit summary').toString('base64');

test('a benefit summary is read into the plan’s breakdown, compared with what’s on file, and applied by a person', async () => {
  const ctx = await setup();
  reply = {
    name: 'benefit_breakdown',
    input: {
      plan_name: 'ACME PPO', annual_max: 2000, deductible: 50, pct_preventive: 100, pct_basic: 80, pct_major: 50, wait_major_months: 12,
      downgrade_composites: true, missing_tooth_clause: true,
      frequencies: [{ label: 'Bitewings', codes: ['d0274'], count: 1, per: 'benefit_year' }, { label: 'Crowns', codes: ['D27'], count: 1, months: 60, per_tooth: true }],
      age_limits: [{ codes: ['D1206', 'D1208'], max_age: 14 }, { codes: ['D1351'], max_age: 15 }],
      coverage_overrides: [{ code: 'D6010', pct: 0 }],
      history: [{ codes: ['D1110'], date: '2026-03-02' }], notes: ['Implants not covered'],
    },
  };
  const read = await ctx.api.post(`/insurance-plans/${ctx.policy.plan_id}/read-benefits`, { file_base64: PDF, mime: 'application/pdf' });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  const sent = seen.at(-1);
  assert.equal(sent.tools[0].name, 'benefit_breakdown');
  assert.equal(sent.messages[0].content[0].type, 'document');
  const p = read.data.proposed;
  assert.deepEqual([p.annual_max, p.deductible, p.wait_major_months, p.missing_tooth_clause], [200000, 5000, 12, 1]);
  assert.deepEqual(p.frequencies[1], { label: 'Crowns', codes: ['D27'], count: 1, months: 60, per_tooth: true });
  assert.deepEqual(p.coverage_overrides, { D6010: 0 });
  assert.equal(read.data.current.annual_max, 150000, 'with what’s on file, to compare');
  assert.deepEqual(read.data.notes, ['Implants not covered']);
  assert.equal((await ctx.api.post(`/insurance-plans/${ctx.policy.plan_id}/read-benefits`, { file_base64: PDF, mime: 'text/html' })).status, 400);

  // Staff apply it; the plan remembers where it came from.
  const saved = await ctx.api.put(`/insurance-plans/${ctx.policy.plan_id}`, { ...p, benefit_notes: 'Implants not covered', verified_source: 'ai_read' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.verified_source, 'ai_read');
  assert.ok(saved.data.verified_at);
  assert.deepEqual(saved.data.age_limits[0], { codes: ['D1206', 'D1208'], max_age: 14 });
  assert.equal((await ctx.api.put(`/insurance-plans/${ctx.policy.plan_id}`, { age_limits: [{ codes: [] }] })).status, 400);

  // Age limits: Jane is an adult, so fluoride isn't covered.
  await ctx.api.put(`/patients/${ctx.patient.id}`, { dob: '1990-05-05' });
  const fl = await proc(ctx, 'D1206');
  const est = await estimate(ctx, [fl.id]);
  assert.equal(est.items[0].insurance, 0);
  assert.match(est.items[0].notes.join(' '), /Covered only through age 14/);

  // Missing tooth clause: #19 was charted missing before coverage began, so the bridge pontic isn't covered; #30's is.
  await h.db.run("INSERT INTO tooth_conditions (practice_id, patient_id, tooth, condition, recorded_at) VALUES (?, ?, '19', 'missing', '2024-06-01 10:00:00')", ctx.practiceId, ctx.patient.id);
  await h.db.run("INSERT INTO tooth_conditions (practice_id, patient_id, tooth, condition, recorded_at) VALUES (?, ?, '30', 'missing', '2025-08-01 10:00:00')", ctx.practiceId, ctx.patient.id);
  const old = await proc(ctx, 'D6240', { tooth: '19' });
  const recent = await proc(ctx, 'D6240', { tooth: '30' });
  const [a, b] = (await estimate(ctx, [old.id, recent.id])).items;
  assert.equal(a.insurance, 0);
  assert.match(a.notes.join(' '), /Missing tooth clause/);
  assert.ok(b.insurance > 0, JSON.stringify(b));
});

test('a paper EOB becomes a filled-in insurance check, matched to our claims line by line', async () => {
  const ctx = await setup();
  const a = await proc(ctx, 'D2392', { tooth: '30', surfaces: 'MO', complete: true });
  const b = await proc(ctx, 'D0274', { complete: true });
  const c1 = (await ctx.api.post('/claims', { patient_insurance_id: ctx.policy.id, procedure_ids: [a.id, b.id] })).data;
  await ctx.api.post(`/claims/${c1.id}/submit`);
  const dos = (await h.db.get('SELECT completed_at FROM procedures WHERE id = ?', a.id)).completed_at.slice(0, 10);
  reply = {
    name: 'read_eob',
    input: {
      payer_name: 'delta dental', check_number: '88123', check_date: '2026-09-20', total_paid: 188, method: 'check',
      claims: [
        { patient_name: 'DOE, JANE', subscriber_id: 'W1', date_of_service: dos, paid: 188, patient_responsibility: 40, lines: [{ code: 'D2392', tooth: '30', billed: 200, allowed: 160, paid: 128, write_off: 40, patient_resp: 32 }, { code: 'D0274', billed: 80, allowed: 68, paid: 60, write_off: 12, patient_resp: 8 }] },
        { patient_name: 'Someone Else', date_of_service: dos, paid: 0, lines: [{ code: 'D1110', paid: 0 }] },
      ],
    },
  };
  const read = await ctx.api.post('/eobs/read', { file_base64: Buffer.from('fake').toString('base64'), mime: 'image/png' });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(seen.at(-1).messages[0].content[0].type, 'image');
  const eob = read.data;
  assert.deepEqual([eob.carrier_id, eob.amount, eob.check_number, eob.totals_match], [ctx.carrier.id, 18800, '88123', true]);
  const [mine, stranger] = eob.claims;
  assert.equal(mine.claim_id, c1.id);
  assert.ok(mine.match.why.includes('patient') && mine.match.why.includes('date of service'), JSON.stringify(mine.match));
  assert.equal(mine.write_off, 5200);
  assert.ok(mine.lines.every((l) => l.claim_item_id));
  assert.equal(stranger.claim_id, null, 'nothing of ours to match');

  // Posted through the usual check entry.
  const check = await ctx.api.post('/insurance-checks', {
    carrier_id: eob.carrier_id, check_number: eob.check_number, amount: eob.amount, method: eob.method,
    claims: [{ claim_id: mine.claim_id, paid: mine.paid, write_off: mine.write_off, lines: mine.lines.map((l) => ({ claim_item_id: l.claim_item_id, paid: l.paid, write_off: l.write_off })) }],
  });
  assert.equal(check.status, 201, JSON.stringify(check.data));
  const lines = await h.db.all('SELECT ci.paid_amount, pr.code FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY pr.code', c1.id);
  assert.deepEqual(lines.map((l) => [l.code, l.paid_amount]), [['D0274', 6000], ['D2392', 12800]]);
});
