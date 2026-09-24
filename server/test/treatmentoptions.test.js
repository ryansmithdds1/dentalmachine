// Comparing 2–3 options for one problem (backlog F6): one call makes the alternative plans (idempotent, validated,
// audited), one endpoint compares them — cost after insurance, monthly, visits and chair time, the likely next step
// and its future cost, longevity, pros and cons (office wording or marked starter text) — and the patient's choice
// signs that option through the plan link (F4). Spec: docs/workflows/specs/F-financial-options.md (F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const TWO = [
  { label: 'Option 1', items: [{ code: 'D7140', tooth: '19' }, { code: 'D7953', tooth: '19' }] },
  { label: 'Option 2', items: [{ code: 'D3330', tooth: '19' }, { code: 'D2950', tooth: '19' }, { code: 'D2740', tooth: '19' }] },
];
const setup = async () => {
  const ctx = await h.practice();
  const made = await ctx.api.post('/procedure-codes', { code: 'D7953', description: 'Bone replacement graft, ridge preservation', category: 'oral_surgery', fee: 45000, requires_tooth: 1 });
  assert.ok([200, 201, 409].includes(made.status), JSON.stringify(made.data)); // 409: already a default code
  return ctx;
};

test('one call makes 2 alternatives for #19; the same call again returns them; bad input is refused', async () => {
  const ctx = await setup();
  const { api, patient } = ctx;
  const r = await api.post(`/patients/${patient.id}/treatment-options`, { options: TWO });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.plans.length, 2);
  assert.equal(r.data.plans[0].name, 'Tooth #19: Tooth removal + Bone graft');
  const rows = await h.db.all('SELECT id, option_group, option_label, status FROM treatment_plans WHERE patient_id = ? ORDER BY id', patient.id);
  assert.equal(new Set(rows.map((x) => x.option_group)).size, 1);
  assert.deepEqual(rows.map((x) => x.option_label), ['Option 1', 'Option 2']);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE patient_id = ?', patient.id)).n, 5);
  // Twice (a double click, a repeated voice command): the same group, nothing new.
  const again = await api.post(`/patients/${patient.id}/treatment-options`, { options: TWO });
  assert.deepEqual([again.status, again.data.replay, again.data.plans.map((p) => p.id)], [200, true, r.data.plans.map((p) => p.id)]);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM treatment_plans WHERE patient_id = ?', patient.id)).n, 2);
  // A caller's own key: a different request with the same key is the same group.
  const keyed = await api.post(`/patients/${patient.id}/treatment-options`, { key: 'voice-123', options: TWO });
  assert.equal(keyed.status, 201);
  assert.equal((await api.post(`/patients/${patient.id}/treatment-options`, { key: 'voice-123', options: TWO })).data.replay, true);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'treatment_plan.options_create' AND patient_id = ?", patient.id));
  for (const bad of [
    { options: [TWO[0]] },
    { options: [...TWO, TWO[0], TWO[1]] },
    { options: [TWO[0], { items: [{ code: 'D9999', tooth: '19' }] }] },
    { options: [TWO[0], { items: [{ code: 'D2740', tooth: '40' }] }] },
    { options: [TWO[0], { items: [{ code: 'D2740' }] }] },
    { options: [TWO[0], { items: [] }] },
  ]) assert.equal((await api.post(`/patients/${patient.id}/treatment-options`, bad)).status, 400, JSON.stringify(bad));
});

test('the comparison: cost, monthly, visits and time, the likely next step and its cost, longevity, pros and cons', async () => {
  const ctx = await setup();
  const { api, patient } = ctx;
  const r = (await api.post(`/patients/${patient.id}/treatment-options`, { options: TWO })).data;
  const c = (await api.get(`/treatment-plans/${r.plans[1].id}/compare`)).data;
  assert.equal(c.options.length, 2);
  const [ext, rct] = c.options;
  assert.deepEqual(ext.teeth, ['19']);
  assert.ok(ext.you_pay > 0 && rct.you_pay > ext.you_pay);
  assert.ok(ext.visits >= 1 && ext.chair_minutes > 0);
  const fee = async (code) => (await h.db.get('SELECT fee FROM procedure_codes WHERE practice_id = (SELECT practice_id FROM patients WHERE id = ?) AND code = ?', patient.id, code)).fee;
  // Extraction: both ways to replace the tooth later — an implant or a bridge — each priced at today's office fees.
  assert.deepEqual(ext.next_steps.map((n) => n.label), ['Implant and crown to replace the tooth', 'Bridge to fill the gap (3 units)']);
  assert.equal(ext.next_steps[0].cost, (await fee('D6010')) + (await fee('D6065')));
  assert.equal(ext.next_steps[1].cost, 2 * (await fee('D6750')) + (await fee('D6240')));
  assert.equal(ext.later_cost_from, Math.min(ext.next_steps[0].cost, ext.next_steps[1].cost));
  // The root canal option already includes its buildup and crown: no "later" for them.
  assert.equal(rct.next_steps.length, 0);
  assert.ok(rct.pros.includes('Keeps your own tooth'));
  assert.ok(rct.longevity.length > 0);
  assert.equal(ext.starter, true, 'starter wording is marked for the office to review');
  // The office edits the wording (administrators only); it's no longer starter text, and it's audited.
  await api.post('/users', { name: 'Asa', email: `as-${ctx.email}`, password: 'correct-horse-battery', role: 'assistant' });
  const asa = h.client((await h.client().post('/auth/login', { email: `as-${ctx.email}`, password: 'correct-horse-battery' })).data.token);
  assert.equal((await asa.put('/procedure-insights/D7140', { pros: ['x'] })).status, 403);
  assert.equal((await api.put('/procedure-insights/D7140', { next_steps: [{ codes: 'D6240' }], pros: ['x'] })).status, 400, 'a next step needs plain words');
  assert.equal((await api.put('/procedure-insights/D7140', { next_steps: [{ label: 'x', codes: 'X1' }] })).status, 400);
  const saved = await api.put('/procedure-insights/D7140', { next_steps: [{ label: 'An implant later', codes: 'D6010, D6065' }], longevity: 'Permanent', pros: ['Fast'], cons: ['A gap'] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.starter, false);
  const c2 = (await api.get(`/treatment-plans/${r.plans[0].id}/compare`)).data.options[0];
  assert.deepEqual([c2.next_steps.map((n) => n.label), c2.pros[0], c2.cons[0]], [['An implant later'], 'Fast', 'A gap']);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'procedure_insight.save'"));
  // Another practice sees none of it.
  const other = await h.practice();
  assert.equal((await other.api.get(`/treatment-plans/${r.plans[0].id}/compare`)).status, 404);
  assert.equal((await other.api.post(`/patients/${patient.id}/treatment-options`, { options: TWO })).status, 404);
});

test('the patient compares on their screen and chooses option 2: that plan is signed with the chosen way to pay', async () => {
  const ctx = await setup();
  const { api, patient } = ctx;
  const r = (await api.post(`/patients/${patient.id}/treatment-options`, { options: TWO })).data;
  const { url } = (await api.post(`/treatment-plans/${r.plans[0].id}/present`, {})).data;
  const token = url.split('/tp/')[1];
  const pass = (await h.client().post(`/public/tp/${token}/verify`, { dob: '1985-04-12' })).data.pass;
  const pub = h.client(null, { 'X-Plan-Pass': pass });
  const c = (await pub.get(`/public/tp/${token}/compare`)).data;
  assert.equal(c.options.length, 2);
  assert.equal(c.options[0].starter, undefined, 'no internal flags for the patient');
  const q = (await pub.get(`/public/tp/${token}/quote?plan=${r.plans[1].id}`)).data;
  const signed = await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true, plan_id: r.plans[1].id, choice: { plan_id: r.plans[1].id, option_key: 'full', quote_hash: q.quote_hash } });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.ok(signed.data.pass, 'a pass for the option that was signed');
  const [a, b] = await h.db.all('SELECT id, signed_at, sign_token_hash FROM treatment_plans WHERE id IN (?, ?) ORDER BY id', r.plans[0].id, r.plans[1].id);
  assert.equal(a.signed_at, null);
  assert.ok(b.signed_at);
  assert.equal(a.sign_token_hash, null, 'the link now opens the signed option');
  assert.ok(await h.db.get('SELECT id FROM fin_agreements WHERE treatment_plan_id = ?', b.id));
  // The link keeps working for the patient with the new pass.
  assert.equal((await h.client(null, { 'X-Plan-Pass': signed.data.pass }).get(`/public/tp/${token}`)).data.signed_at != null, true);
});
