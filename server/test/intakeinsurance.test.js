// #20 eligibility applied on its own (exceptions only), #30 the intake worklist, #31 insurance card → policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { actorMiddleware } from '../src/actor.js';
import { authenticate, HttpError } from '../src/auth.js';
import { officeAccess } from '../src/officeaccess.js';
import { flushChanges } from '../src/util.js';
import { createEligibility, eligibilityProblems } from '../src/eligibility.js';
import intakeReviewRoutes from '../src/routes/intakereview.js';

const h = harness();

// The intake worklist router isn't mounted in app.js yet, so it runs here behind the same sign-in, actor and
// office-access layers the real API uses.
let intakeServer;
let intakeOrigin;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => actorMiddleware(h.db, flushChanges)(req, res, next));
  const api = express.Router();
  // Built on the first request: the shared database only exists once the harness has started.
  let inner = null;
  api.use((req, res, next) => {
    if (!inner) {
      inner = express.Router();
      inner.use(authenticate(h.db, 'test-secret'), officeAccess(h.db), intakeReviewRoutes({ db: h.db }));
    }
    inner(req, res, next);
  });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((r) => { intakeServer = app.listen(0, r); });
  intakeOrigin = `http://127.0.0.1:${intakeServer.address().port}`;
});
after(() => intakeServer?.close());
const intake = (token) => ({
  get: async (p) => { const r = await fetch(`${intakeOrigin}/api${p}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, data: await r.json() }; },
  post: async (p, b) => { const r = await fetch(`${intakeOrigin}/api${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, data: await r.json() }; },
});

const user = async (api, role) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: `${role} person`, role, password: `${role}-password-123` });
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
};
const audits = (practiceId, action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', practiceId, action);
const issues = (practiceId) => h.db.all("SELECT * FROM issues WHERE practice_id = ? AND kind = 'eligibility' ORDER BY id", practiceId);

// A payer's 271, with whatever EB lines the test needs.
const x271 = (lines) => ['ISA*00*          *00*          *ZZ*PAYER          *ZZ*US             *240101*1200*^*00501*000000001*0*P*:', 'GS*HB*P*U*20240101*1200*1*X*005010X279A1',
  'ST*271*0001*005010X279A1', ...lines, 'SE*9*0001', 'GE*1*1', 'IEA*1*000000001'].join('~') + '~';

async function insured(ctx) {
  const { api, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', annual_max: 150000, deductible: 5000, deductible_met: 0 })).data;
  return { carrier, policy };
}

test('#20 a clean eligibility response is applied to the policy on its own, recorded as automation, with no exception', async () => {
  const ctx = await h.practice({ timezone: 'UTC' });
  const { policy } = await insured(ctx);
  const pid = policy.practice_id;
  // Deductible met changed at the payer: the sandbox reports what's left from the policy, so move it first.
  await h.db.run('UPDATE patient_insurance SET deductible_met = 2000 WHERE id = ?', policy.id);
  const r = await ctx.api.post(`/insurance/${policy.id}/eligibility`);
  assert.equal(r.status, 201);
  assert.equal(r.data.applied, true);
  assert.deepEqual(r.data.reasons, []);
  assert.equal(r.data.summary.applied.auto, true);
  const [row] = await audits(pid, 'eligibility.auto_apply');
  assert.ok(row, 'audited');
  assert.equal(row.source, 'automation');
  assert.equal(row.user_id, null, 'the system, not the person who pressed Check');
  assert.ok(JSON.parse(row.details).fields.includes('deductible_met'));
  assert.equal((await issues(pid)).length, 0, 'nothing for a person to look at');
  const plan = await h.db.get('SELECT verified_source FROM insurance_plans WHERE id = (SELECT plan_id FROM patient_insurance WHERE id = ?)', policy.id);
  assert.equal(plan.verified_source, 'eligibility');
});

test('#20 inactive coverage and payer errors become a Needs attention item and change nothing; a later clean answer resolves it', async () => {
  const ctx = await h.practice({ timezone: 'UTC' });
  const { policy } = await insured(ctx);
  const pid = policy.practice_id;
  const check = (await ctx.api.post(`/insurance/${policy.id}/eligibility`)).data;
  const before = await h.db.get('SELECT annual_max, deductible_met FROM patient_insurance WHERE id = ?', policy.id);

  // The payer says coverage ended (imported by hand, as a manual-mode office would).
  const inactive = await ctx.api.post(`/eligibility/${check.id}/response`, x271(['EB*6*IND*35**DENTAL PPO', 'EB*F*IND*35***23*900.00']));
  assert.equal(inactive.status, 200);
  assert.equal(inactive.data.status, 'inactive');
  assert.match(inactive.data.summary.review.reasons[0], /isn’t active/);
  assert.equal(inactive.data.summary.applied, undefined);
  assert.deepEqual(await h.db.get('SELECT annual_max, deductible_met FROM patient_insurance WHERE id = ?', policy.id), before, 'nothing applied');
  let open = (await issues(pid)).filter((i) => i.status === 'open');
  assert.equal(open.length, 1);
  assert.match(open[0].title, /Jane Doe/);
  assert.equal(open[0].patient_id, ctx.patient.id);

  // A payer error (AAA 72: bad member ID) is the same item, counted again.
  const again = (await ctx.api.post(`/insurance/${policy.id}/eligibility`)).data;
  await ctx.api.post(`/eligibility/${again.id}/response`, x271(['AAA*N**72*C']));
  open = (await issues(pid)).filter((i) => i.status === 'open');
  assert.equal(open.length, 1);
  assert.match(open[0].detail, /member ID/);

  // A clean check later closes it by itself.
  const clean = (await ctx.api.post(`/insurance/${policy.id}/eligibility`)).data;
  assert.equal(clean.applied, true);
  const [issue] = await issues(pid);
  assert.equal(issue.status, 'resolved');
  assert.match(issue.resolution, /came back clean/);
});

test('#20 numbers that disagree with a verified plan need a look; Keep closes it and is audited; Apply anyway updates it', async () => {
  const ctx = await h.practice({ timezone: 'UTC' });
  const { policy } = await insured(ctx);
  const pid = policy.practice_id;
  await ctx.api.post(`/insurance/${policy.id}/eligibility`); // verifies the plan
  const c = (await ctx.api.post(`/insurance/${policy.id}/eligibility`)).data;
  const r = await ctx.api.post(`/eligibility/${c.id}/response`, x271(['EB*1*IND*35**DENTAL PPO', 'EB*F*IND*35***23*1000.00', 'EB*C*IND*35***23*50.00']));
  assert.match(r.data.summary.review.reasons.join(' '), /annual max: the payer says \$1,000, the plan on file says \$1,500/);
  assert.equal((await h.db.get('SELECT annual_max FROM patient_insurance WHERE id = ?', policy.id)).annual_max, 150000);

  // Permissions: an assistant can't close it; another practice can't see it.
  const asst = await user(ctx.api, 'assistant');
  assert.equal((await asst.post(`/eligibility/${c.id}/keep`)).status, 403);
  const other = await h.practice();
  assert.equal((await other.api.post(`/eligibility/${c.id}/keep`)).status, 404);
  assert.equal((await other.api.post(`/eligibility/${c.id}/apply`)).status, 404);

  const kept = await ctx.api.post(`/eligibility/${c.id}/keep`, { reason: 'Called Delta: $1,500 is right' });
  assert.equal(kept.status, 200);
  assert.equal(kept.data.summary.review.outcome, 'kept');
  const [k] = await audits(pid, 'eligibility.keep_on_file');
  assert.equal(k.reason, 'Called Delta: $1,500 is right');
  assert.equal((await issues(pid)).filter((i) => i.status === 'open').length, 0);

  // Applying anyway: by the person, with before and after.
  const applied = await ctx.api.post(`/eligibility/${c.id}/apply`);
  assert.equal(applied.data.annual_max, 100000);
  const [a] = await audits(pid, 'eligibility.apply');
  assert.equal(a.source, 'human');
  assert.deepEqual(JSON.parse(a.changes).annual_max, [150000, 100000]);
});

test('#20 the evening batch applies the clean ones and counts the rest', async () => {
  const ctx = await h.practice({ timezone: 'UTC' });
  const { policy } = await insured(ctx);
  const day = '2031-06-02';
  await ctx.api.post('/appointments', { patient_id: ctx.patient.id, provider_id: ctx.provider.id, start_time: `${day} 09:00`, end_time: `${day} 09:30` });
  const out = (await ctx.api.post('/eligibility/batch', { date: day })).data;
  assert.deepEqual([out.checked, out.applied, out.needs_look], [1, 1, 0]);
  const rows = (await ctx.api.get(`/eligibility/batch?date=${day}`)).data.rows;
  assert.equal(rows[0].summary.applied.auto, true);
  assert.equal(rows[0].policy_id, policy.id);
  // Run by the nightly job (no person): recorded as automation.
  const elig = createEligibility({ db: h.db, config: { ediMode: 'sandbox' } });
  const r = await elig.check(await h.db.get('SELECT * FROM patient_insurance WHERE id = ?', policy.id));
  assert.equal(r.applied, true);
  assert.equal((await audits(policy.practice_id, 'eligibility.auto_apply')).at(-1).source, 'automation');
});

test('#20 what counts as a problem', () => {
  assert.deepEqual(eligibilityProblems({ active: true, errors: [], coinsurance: {} }), []);
  assert.equal(eligibilityProblems({ active: null, errors: [], coinsurance: {} }).length, 1);
  assert.match(eligibilityProblems({ active: true, errors: [], plan_begin: '2031-01-01', coinsurance: {} }, { today: '2030-12-01' })[0], /doesn’t start until/);
  // Unverified plans take the payer's numbers; verified ones flag differences.
  assert.deepEqual(eligibilityProblems({ active: true, errors: [], annual_max: 1, coinsurance: { basic: 50 } }, { plan: { annual_max: 1, pct_basic: 80 } }), []);
  assert.match(eligibilityProblems({ active: true, errors: [], annual_max: 1, coinsurance: { basic: 50 } }, { plan: { verified_at: 'x', annual_max: 1, pct_basic: 80 } })[0], /basic: the payer says 50%/);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');

test('#31 a card photo is read (sandbox) into a policy for a person to confirm; the AI read and the approval are both recorded', async () => {
  const ctx = await h.practice();
  const pid = ctx.patient.practice_id;
  const read = await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, { front: { file_base64: PNG, mime: 'image/png' }, back: { file_base64: PNG, mime: 'image/png' } });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.sandbox, true);
  assert.ok(read.data.proposed.subscriber_id);
  assert.equal(read.data.proposed.relationship, 'self');
  assert.equal(read.data.proposed.subscriber_dob, '1985-04-12', 'what the chart knows is used');
  assert.match(read.data.reason, /not read from the picture/);
  assert.equal(read.data.carrier, null, 'no carriers yet');
  assert.equal(read.data.new_carrier.name, read.data.read.carrier_name, 'offered as a new carrier');
  const again = await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, { file_base64: PNG, mime: 'image/png' });
  assert.equal(again.data.read.subscriber_id, read.data.read.subscriber_id, 'the same picture reads the same');
  const [ai] = await audits(pid, 'insurance_card.ai_read');
  assert.equal(ai.source, 'ai');
  assert.ok(ai.reason);

  // The carrier on the card is matched once it exists (by payer ID or name).
  const carrier = (await ctx.api.post('/carriers', { name: read.data.new_carrier.name.toUpperCase(), payer_id: read.data.new_carrier.payer_id })).data;
  const read2 = await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, { file_base64: PNG, mime: 'image/png' });
  assert.equal(read2.data.carrier.id, carrier.id);

  // The person saves it (fixing the member ID) and confirms: approver and corrections on record.
  const policy = (await ctx.api.post(`/patients/${ctx.patient.id}/insurance`, { ...read2.data.proposed, subscriber_id: 'FIXED1' })).data;
  const ok = await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/confirm`, { read_id: read2.data.read_id, policy_id: policy.id });
  assert.deepEqual(ok.data.corrected, ['subscriber_id']);
  const [conf] = await audits(pid, 'insurance.ai_card_confirmed');
  assert.equal(conf.source, 'human');
  assert.match(conf.reason, /checked and saved by Admin \(corrected subscriber_id\)/);

  // Validation, permissions, isolation.
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, { file_base64: PNG, mime: 'text/html' })).status, 400);
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, {})).status, 400);
  const billing = await user(ctx.api, 'billing');
  assert.equal((await billing.post(`/patients/${ctx.patient.id}/insurance-card/read`, { file_base64: PNG, mime: 'image/png' })).status, 403);
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${ctx.patient.id}/insurance-card/read`, { file_base64: PNG, mime: 'image/png' })).status, 404);
  assert.equal((await other.api.post(`/patients/${other.patient.id}/insurance-card/confirm`, { read_id: read2.data.read_id, policy_id: policy.id })).status, 404);
  assert.equal((await ctx.api.post(`/patients/${ctx.patient.id}/insurance-card/confirm`, { read_id: 999999, policy_id: policy.id })).status, 404);
});

const portalUpdate = (ctx, row) => h.db.run(
  'INSERT INTO insurance_updates (practice_id, patient_id, carrier_name, member_id, group_number, subscriber_name, relationship, document_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ctx.patient.practice_id, ctx.patient.id, row.carrier_name ?? null, row.member_id ?? null, row.group_number ?? null, row.subscriber_name ?? null, row.relationship ?? 'self', '[]',
).then((r) => r.id);

test('#31 portal insurance applies in one step: carrier added if missing, once only, replacing primary only when asked', async () => {
  const ctx = await h.practice();
  const pid = ctx.patient.practice_id;
  const uid = await portalUpdate(ctx, { carrier_name: 'Humana Dental', member_id: 'H 555', group_number: 'G1' });

  // The assistant can't enter insurance without a person.
  const ai = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/insurance-updates/${uid}/apply`)).status, 428);
  const other = await h.practice();
  assert.equal((await other.api.post(`/insurance-updates/${uid}/apply`)).status, 404);
  const asst = await user(ctx.api, 'assistant');
  assert.equal((await asst.post(`/insurance-updates/${uid}/apply`)).status, 403);

  const r = await ctx.api.post(`/insurance-updates/${uid}/apply`);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.carrier_created, true);
  assert.deepEqual([r.data.policy.carrier_name, r.data.policy.subscriber_id, r.data.policy.priority, r.data.policy.subscriber_name], ['Humana Dental', 'H 555', 'primary', 'Jane Doe']);
  assert.equal((await h.db.get('SELECT status, reviewed_by FROM insurance_updates WHERE id = ?', uid)).status, 'reviewed');
  const [a] = await audits(pid, 'insurance_update.apply');
  assert.equal(a.patient_id, ctx.patient.id);
  assert.ok(JSON.parse(a.changes).subscriber_id, 'the new policy’s values are on the record');
  assert.equal((await ctx.api.post(`/insurance-updates/${uid}/apply`)).status, 409, 'twice does nothing');

  // A different card when they already have primary insurance: asks first, then replaces (old kept, inactive).
  const uid2 = await portalUpdate(ctx, { carrier_name: 'humana dental', member_id: 'H777' });
  const ask = await ctx.api.post(`/insurance-updates/${uid2}/apply`);
  assert.equal(ask.status, 409);
  assert.match(ask.data.error, /already have Humana Dental/);
  assert.equal((await h.db.get('SELECT status FROM insurance_updates WHERE id = ?', uid2)).status, 'pending', 'rolled back');
  const rep = await ctx.api.post(`/insurance-updates/${uid2}/apply`, { replace: true });
  assert.equal(rep.status, 201);
  assert.equal(rep.data.carrier_created, false, 'matched by name');
  assert.equal((await h.db.get('SELECT active FROM patient_insurance WHERE id = ?', r.data.policy.id)).active, 0);

  // Missing member ID: read the card instead.
  const uid3 = await portalUpdate(ctx, { carrier_name: 'Aetna' });
  const miss = await ctx.api.post(`/insurance-updates/${uid3}/apply`);
  assert.equal(miss.status, 422);
  assert.equal(miss.data.details.needs_card_read, true);
});

test('#30 the intake worklist gathers histories, portal insurance and card photos across patients, scoped to the practice', async () => {
  const ctx = await h.practice();
  const pid = ctx.patient.practice_id;
  const list = intake(ctx.token);
  const first = await list.get('/intake/pending');
  assert.deepEqual(first.data.items, [], JSON.stringify(first));

  await h.db.run("INSERT INTO patient_forms (practice_id, patient_id, kind, data, signature_name, review_status) VALUES (?, ?, 'medical_history', ?, 'Jane Doe', 'pending')", pid, ctx.patient.id, JSON.stringify({ conditions: ['Diabetes'], allergies: 'Penicillin', medications: '' }));
  const uid = await portalUpdate(ctx, { carrier_name: 'Guardian', member_id: 'GU1' });
  const second = (await ctx.api.post('/patients', { first_name: 'Card', last_name: 'Only', dob: '1990-01-01' })).data;
  const doc = (await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key) VALUES (?, ?, 'insurance_card', 'Insurance card front.jpg', 'image/jpeg', 10, 'k1')", pid, second.id)).id;
  const doc2 = (await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key) VALUES (?, ?, 'insurance_card', 'Insurance card back.jpg', 'image/jpeg', 10, 'k2')", pid, second.id)).id;
  // A photo someone on staff uploaded isn't "sent in".
  await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key, uploaded_by) VALUES (?, ?, 'insurance_card', 'x.jpg', 'image/jpeg', 10, 'k3', 1)", pid, second.id);

  const gotRes = await list.get('/intake/pending');
  assert.equal(gotRes.status, 200, JSON.stringify(gotRes.data));
  const got = gotRes.data;
  assert.deepEqual(got.items.map((i) => i.kind).sort(), ['card', 'history', 'insurance_update']);
  const hist = got.items.find((i) => i.kind === 'history');
  assert.equal(hist.changes.allergies.proposed, 'Penicillin');
  assert.deepEqual(got.items.find((i) => i.kind === 'card').document_ids, [doc, doc2], 'front and back together');
  assert.equal(got.items.find((i) => i.kind === 'insurance_update').ready, true);

  // Another practice sees none of it, and can't set its photos aside.
  const other = await h.practice();
  assert.deepEqual((await intake(other.token).get('/intake/pending')).data.items, []);
  assert.equal((await intake(other.token).post('/intake/cards/done', { document_ids: [doc] })).status, 404);
  // Someone without clinical access sees no health histories; without billing, no insurance.
  await user(ctx.api, 'assistant');
  const asstLogin = await h.client().post('/auth/login', { email: (await h.db.get("SELECT email FROM users WHERE role = 'assistant' AND practice_id = ? ORDER BY id DESC", pid)).email, password: 'assistant-password-123' });
  assert.deepEqual((await intake(asstLogin.data.token).get('/intake/pending')).data.items.map((i) => i.kind), ['history']);
  assert.equal((await intake(asstLogin.data.token).post('/intake/cards/done', { document_ids: [doc] })).status, 403);

  // Accepting through the usual routes takes items off: the portal update applied, the card set aside.
  await ctx.api.post(`/insurance-updates/${uid}/apply`);
  const done = await list.post('/intake/cards/done', { document_ids: [doc, doc2] });
  assert.equal(done.status, 200);
  assert.equal((await audits(pid, 'intake.card_done')).length, 2);
  assert.deepEqual((await list.get('/intake/pending')).data.items.map((i) => i.kind), ['history']);

  // Entering a policy for a patient also clears their waiting card photos.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  await h.db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key, created_at) VALUES (?, ?, 'insurance_card', 'c.jpg', 'image/jpeg', 10, 'k4', ?)", pid, ctx.patient.id, minuteAgo);
  assert.equal((await list.get('/intake/pending')).data.items.filter((i) => i.kind === 'card').length, 0, 'Jane had a policy entered after this photo');
});
