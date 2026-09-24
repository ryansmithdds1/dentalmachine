// Treatment entry (routes/treatmententry.js): bundles and quick buttons (office and personal, retired not deleted,
// audited), the resolver the preview and the voice assistant use, and charting it all in one step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

async function staff(api, role) {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const user = (await api.post('/users', { email, name: `A ${role}`, role, password: `${role}-password-123` })).data;
  const token = (await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token;
  return { user, token, api: h.client(token), ai: h.client(token, { 'X-Acting-For': 'assistant' }) };
}

test('a practice starts with the starter bundles and buttons, once; office ones need an administrator', async () => {
  const { api, practiceId } = await h.practice();
  const first = (await api.get('/chart-shortcuts')).data;
  assert.deepEqual(first.bundles.map((b) => b.alias).sort(), ['brg', 'cdl', 'cdu', 'crb', 'imp', 'ng', 'np', 'npc', 'seal', 'srp']);
  assert.equal(first.shortcuts.filter((s) => s.button).length, 9, 'nine buttons: Alt+1…9');
  assert.equal(first.shortcuts[0].label, 'Crown');
  assert.equal(first.shortcuts[0].bundle_id, first.bundles.find((b) => b.alias === 'crb').id);
  assert.ok(first.bundles.find((b) => b.alias === 'imp').items.some((it) => it.phase === 3));
  await api.get('/chart-shortcuts');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedure_bundles WHERE practice_id = ?', practiceId)).n, 10, 'seeded once');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chart_shortcuts.seed' AND practice_id = ?", practiceId));

  const dentist = await staff(api, 'dentist');
  const crb = first.bundles.find((b) => b.alias === 'crb');
  assert.equal((await dentist.api.put(`/procedure-bundles/${crb.id}`, { name: 'Mine now' })).status, 403, 'office bundles are the administrator’s');
  assert.equal((await dentist.api.post('/procedure-bundles', { scope: 'office', name: 'X', items: [{ code: 'D2740' }] })).status, 403);
  assert.equal((await dentist.api.post(`/procedure-bundles/${crb.id}/retire`)).status, 403);
  const front = await staff(api, 'front_desk');
  assert.equal((await front.api.get('/chart-shortcuts')).status, 200, 'anyone who can see charts sees them');
  assert.equal((await front.api.post('/procedure-bundles', { scope: 'mine', name: 'X', items: [{ code: 'D2740' }] })).status, 403, 'making them needs clinical:write');
});

test('bundles: create, change (audited before → after), retire and restore — never deleted; personal ones stay personal', async () => {
  const { api, practiceId } = await h.practice();
  await api.get('/chart-shortcuts');
  const made = await api.post('/procedure-bundles', { scope: 'office', name: 'Quad composite', alias: 'qc', items: [{ work: 'filling', surfaces: 'same' }, { code: 'D9230', tooth: 'none', optional: true }] });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.items[1], { code: 'D9230', tooth: 'none', optional: true, default_on: false });
  assert.equal((await api.post('/procedure-bundles', { name: 'Dup', alias: 'qc', items: [{ code: 'D2740' }] })).status, 409, 'aliases are unique');
  assert.equal((await api.post('/procedure-bundles', { name: 'Bad', items: [{ code: 'D9999' }] })).status, 400, 'codes must be on the code list');
  assert.match((await api.post('/procedure-bundles', { name: 'Bad', items: [{ code: 'D4341' }] })).data.error, /quadrant/);
  assert.match((await api.post('/procedure-bundles', { name: 'Bad', alias: 'mod', items: [{ code: 'D2740' }] })).data.error, /already means something/);

  const upd = await api.put(`/procedure-bundles/${made.data.id}`, { name: 'Quadrant composite', items: [{ work: 'filling', surfaces: 'same' }] });
  assert.equal(upd.status, 200);
  const log = await h.db.get("SELECT changes FROM audit_log WHERE action = 'procedure_bundle.update' AND entity_id = ?", made.data.id);
  const changes = JSON.parse(log.changes);
  assert.deepEqual(changes.name, ['Quad composite', 'Quadrant composite'], 'before and after');
  assert.ok(changes.items, 'the recipe change is kept');

  assert.equal((await api.post(`/procedure-bundles/${made.data.id}/retire`)).status, 200);
  assert.ok(!(await api.get('/chart-shortcuts')).data.bundles.some((b) => b.id === made.data.id), 'retired: off the lists');
  assert.ok((await api.get('/chart-shortcuts?all=1')).data.bundles.some((b) => b.id === made.data.id && b.active === 0), 'still on record');
  assert.equal((await api.del(`/procedure-bundles/${made.data.id}`)).status, 404, 'there is no delete');
  assert.equal((await api.post('/procedure-bundles', { name: 'Reuse', alias: 'qc', items: [{ code: 'D2740' }] })).status, 201, 'a retired bundle’s alias is free again');
  assert.equal((await api.post(`/procedure-bundles/${made.data.id}/restore`)).status, 409, '…so it comes back only once its alias is free');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'procedure_bundle.retire' AND entity_id = ? AND practice_id = ?", made.data.id, practiceId));
  const row = await h.db.get('SELECT retired_at, retired_by FROM procedure_bundles WHERE id = ?', made.data.id);
  assert.ok(row.retired_at && row.retired_by);

  // A dentist's own bundle: theirs to change, invisible to everyone else, and can't take an office alias.
  const dentist = await staff(api, 'dentist');
  const mine = await dentist.api.post('/procedure-bundles', { name: 'My crown', alias: 'mycr', items: [{ work: 'crown' }, { work: 'buildup' }] });
  assert.equal(mine.status, 201);
  assert.equal(mine.data.user_id, dentist.user.id);
  assert.equal((await dentist.api.post('/procedure-bundles', { name: 'Clash', alias: 'np', items: [{ code: 'D0150', tooth: 'none' }] })).status, 409);
  const other = await staff(api, 'dentist');
  assert.equal((await other.api.put(`/procedure-bundles/${mine.data.id}`, { name: 'Taken' })).status, 404, 'someone else’s is not found');
  assert.ok(!(await other.api.get('/chart-shortcuts')).data.bundles.some((b) => b.id === mine.data.id));
  assert.ok(!(await api.get('/chart-shortcuts')).data.bundles.some((b) => b.id === mine.data.id), 'not even the administrator’s list');
  assert.equal((await dentist.api.put(`/procedure-bundles/${mine.data.id}`, { alias: 'mc' })).status, 200);
  // And another practice can't touch any of it.
  const elsewhere = await h.practice();
  assert.equal((await elsewhere.api.put(`/procedure-bundles/${made.data.id}`, { name: 'Nope' })).status, 404);
  assert.equal((await elsewhere.api.post(`/procedure-bundles/${made.data.id}/retire`)).status, 404);
  assert.ok(!(await elsewhere.api.get('/chart-shortcuts')).data.bundles.some((b) => b.name === 'Reuse'));
});

test('starters come back in one click; anyone with clinical:write can take a copy of their own', async () => {
  const { api } = await h.practice();
  const setup = (await api.get('/chart-shortcuts')).data;
  const ng = setup.bundles.find((b) => b.starter_key === 'night_guard');
  await api.post(`/procedure-bundles/${ng.id}/retire`);
  assert.equal((await api.get('/chart-shortcuts')).data.starters.find((s) => s.key === 'night_guard').office, false);
  const back = await api.post('/procedure-bundles/starters/night_guard', { scope: 'office' });
  assert.equal(back.data.id, ng.id, 'the same bundle, restored');
  assert.equal(back.data.active, 1);
  assert.equal((await api.post('/procedure-bundles/starters/night_guard', { scope: 'office' })).data.already, true, 'twice is fine');
  assert.equal((await api.post('/procedure-bundles/starters/nope', {})).status, 404);
  const hyg = await staff(api, 'hygienist');
  const copy = await hyg.api.post('/procedure-bundles/starters/srp', { scope: 'mine' });
  assert.equal(copy.status, 201);
  assert.equal(copy.data.user_id, hyg.user.id);
  assert.equal(copy.data.alias, null, 'the office keeps the alias; the copy starts without one');
  assert.equal(copy.data.items.length, 4);
});

test('quick buttons and aliases: validated, ordered (Alt+1…9), retired, audited', async () => {
  const { api } = await h.practice();
  const setup = (await api.get('/chart-shortcuts')).data;
  const np = setup.bundles.find((b) => b.alias === 'np');
  assert.equal((await api.post('/chart-shortcuts', { scope: 'office', label: 'BWX', kind: 'code', target: 'D0274', alias: 'bw', color: '#123456', icon: 'zap' })).status, 201);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'code', target: 'D0000' })).status, 400);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'code', target: 'D2740', mode: 'existing' })).status, 400);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'work', target: 'banana' })).status, 400);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'finding', target: 'caries', icon: 'not-an-icon' })).status, 400);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'finding', target: 'caries', color: 'red' })).status, 400);
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'finding', target: 'caries', button: false })).status, 400, 'a button, an alias or both');
  assert.equal((await api.post('/chart-shortcuts', { label: 'x', kind: 'code', target: 'D2950', alias: 'np' })).status, 409);
  const dentist = await staff(api, 'dentist');
  const own = await dentist.api.post('/chart-shortcuts', { label: 'My NP', kind: 'bundle', bundle_id: np.id, mode: 'plan' });
  assert.equal(own.status, 201);
  assert.equal(own.data.user_id, dentist.user.id);
  const theirs = (await dentist.api.post('/procedure-bundles', { name: 'Solo', items: [{ code: 'D2740' }] })).data;
  assert.equal((await api.post('/chart-shortcuts', { scope: 'office', label: 'x', kind: 'bundle', bundle_id: theirs.id })).status, 404, 'an office button can’t use someone’s own bundle');

  const office = (await api.get('/chart-shortcuts')).data.shortcuts.filter((s) => !s.user_id);
  const ids = office.map((s) => s.id).reverse();
  const reordered = await api.put('/chart-shortcuts/order', { scope: 'office', ids });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.data.filter((s) => !s.user_id).map((s) => s.id), ids);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chart_shortcut.reorder'"));
  assert.equal((await api.put('/chart-shortcuts/order', { scope: 'office', ids: [own.data.id] })).status, 400, 'only the office’s own');
  assert.equal((await dentist.api.put('/chart-shortcuts/order', { scope: 'office', ids })).status, 403);
  assert.equal((await dentist.api.put(`/chart-shortcuts/${office[0].id}`, { label: 'Mine' })).status, 403);
  assert.equal((await dentist.api.post(`/chart-shortcuts/${own.data.id}/retire`)).status, 200);
  assert.ok(!(await dentist.api.get('/chart-shortcuts')).data.shortcuts.some((s) => s.id === own.data.id));
});

test('the resolver: text or items → the same preview, checked on the server (teeth, surfaces, codes, areas), with fees and the estimate', async () => {
  const { api, patient, provider } = await h.practice();
  const r = await api.post('/charting/resolve', { patient_id: patient.id, text: 'crown bundle on 14 with buildup, plan it' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.items.map((it) => [it.code, it.tooth, it.fee]), [['D2740', '14', 135000], ['D2950', '14', 30000]]);
  assert.equal(r.data.total_fee, 165000);
  assert.equal(r.data.estimate.total_fee, 165000, 'priced by the estimate endpoint’s own code');
  assert.deepEqual(r.data.bundles[0].options.map((o) => [o.label, o.on]), [['buildup', true], ['post', false]]);
  // The tooth selected on the drawing fills in a tooth the entry leaves out.
  assert.deepEqual((await api.post('/charting/resolve', { patient_id: patient.id, text: 'crb', tooth: '3' })).data.items.map((it) => it.tooth), ['3']);
  // Impossible things are refused, with a reason.
  assert.match((await api.post('/charting/resolve', { patient_id: patient.id, text: '30 MI filling plan' })).data.errors[0], /back tooth/);
  assert.equal((await api.post('/charting/resolve', { patient_id: patient.id, text: '30 MO banana' })).status, 400);
  const bad = (await api.post('/charting/resolve', { patient_id: patient.id, items: [
    { type: 'procedure', code: 'D9999', tooth: '3' }, { type: 'procedure', code: 'D4341', area: 'XX' }, { type: 'procedure', code: 'D2740' },
    { type: 'procedure', code: 'D2740', tooth: '40' }, { type: 'condition', condition: 'gremlins', tooth: '3' }, { type: 'procedure', code: 'D2391', tooth: '3' },
    { type: 'procedure', code: 'D2740', tooth: '3', area: 'UR' },
  ] })).data;
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.items.map((it) => (it.error || '').split(/[:(]/)[0].trim()), [
    'D9999 isn’t on your code list', 'D4341 is charted by quadrant', 'D2740', "#40 isn't a tooth", 'Unknown finding “gremlins”', 'D2391 needs surfaces, e.g. MO', "D2740 isn't charted by quadrant or arch",
  ]);
  assert.equal((await api.post('/charting/resolve', { patient_id: patient.id, items: [{ type: 'nonsense' }] })).status, 400);
  assert.equal((await api.post('/charting/resolve', { patient_id: patient.id, items: Array(41).fill({ type: 'procedure', code: 'D2740', tooth: '3' }) })).status, 400);

  // Warnings: already planned, and the insurance plan's frequency limits (from the estimate).
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_major: 50 });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: provider.id, complete: true });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2950', tooth: '14' });
  const w = (await api.post('/charting/resolve', { patient_id: patient.id, text: '30 crb; 14 bu' })).data;
  assert.ok(w.warnings.some((x) => /Frequency: Crowns/.test(x)), w.warnings.join(' | '));
  assert.ok(w.warnings.includes('D2950 on #14 is already planned'));
  assert.equal(w.estimate.policy.carrier_name, 'Delta Dental');
  // SRP by quadrant: four quadrants are four, not one plan limit hit three times.
  const srp = (await api.post('/charting/resolve', { patient_id: patient.id, text: 'srp' })).data;
  assert.equal(srp.items.length, 4);
  assert.ok(!srp.warnings.some((x) => /Frequency/.test(x)), srp.warnings.join(' | '));

  // Comparing options: each priced on its own (a bone graft code isn't in the starter code list).
  assert.match((await api.post('/charting/resolve', { patient_id: patient.id, text: 'compare 19 ext and bone graft or 19 rct' })).data.errors[0], /D7953 isn’t on your code list/);
  await api.post('/procedure-codes', { code: 'D7953', description: 'Bone replacement graft, ridge preservation', category: 'oral_surgery', fee: 45000, requires_tooth: 1 });
  const cmp = (await api.post('/charting/resolve', { patient_id: patient.id, text: 'the patient wants to compare: option one, extraction and bone graft on 19; option two, root canal, buildup and crown on 19' })).data;
  assert.deepEqual(cmp.options.map((o) => [o.label, o.items.map((it) => it.code), o.total_fee]), [
    ['Option A', ['D7140', 'D7953'], 20000 + 45000], ['Option B', ['D3330', 'D2950', 'D2740'], 125000 + 30000 + 135000],
  ]);
  assert.ok(cmp.options.every((o) => o.estimate));

  // Someone without billing:read sees the preview without the insurance estimate.
  const assistant = await staff(api, 'assistant');
  const noBill = (await assistant.api.post('/charting/resolve', { patient_id: patient.id, text: '14 crb' })).data;
  assert.equal(noBill.estimate, null);
  assert.equal(noBill.items[0].code, 'D2740');
  // Another practice's patient is not found.
  const other = await h.practice();
  assert.equal((await other.api.post('/charting/resolve', { patient_id: patient.id, text: '14 crb' })).status, 404);
});

test('charting an entry: all in one step (all or nothing), phases kept, audited with how it came in; undo by cancel/void', async () => {
  const { api, patient, provider, practiceId, token } = await h.practice();
  const out = await api.post(`/patients/${patient.id}/chart-entry`, { text: '30 imp; 3 MO caries', source: 'voice' });
  assert.equal(out.status, 201);
  assert.deepEqual(out.data.procedures.map((p) => [p.code, p.tooth, p.phase, p.status]), [['D6010', '30', 1, 'planned'], ['D6057', '30', 2, 'planned'], ['D6065', '30', 3, 'planned']]);
  assert.deepEqual(out.data.conditions.map((c) => [c.tooth, c.surfaces, c.condition]), [['3', 'MO', 'caries']]);
  const audits = await h.db.all("SELECT action, details FROM audit_log WHERE practice_id = ? AND action IN ('procedure.create','condition.create') ORDER BY id", practiceId);
  assert.equal(audits.length, 4);
  assert.ok(audits.every((a) => JSON.parse(a.details).via === 'voice'));
  assert.equal(JSON.parse(audits[0].details).bundle, 'Implant');
  // Undo is the chart's own: planned work cancelled, findings voided (kept on record).
  for (const m of out.data.made) {
    if (m.kind === 'planned') assert.equal((await api.post(`/procedures/${m.id}/cancel`)).status, 200);
    if (m.kind === 'condition') assert.equal((await api.post(`/conditions/${m.id}/void`, { reason: 'Undone right after charting' })).status, 200);
  }
  assert.equal((await api.get(`/patients/${patient.id}/chart`)).data.procedures.length, 0);

  // One bad item: nothing is charted.
  const before = (await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE patient_id = ?', patient.id)).n;
  const refused = await api.post(`/patients/${patient.id}/chart-entry`, { items: [{ type: 'procedure', code: 'D2740', tooth: '14' }, { type: 'procedure', code: 'D2392', tooth: '8', surfaces: 'MO' }] });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /front tooth/);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE patient_id = ?', patient.id)).n, before);
  assert.equal((await api.post(`/patients/${patient.id}/chart-entry`, { text: 'compare 19 ext or 19 rct' })).status, 400, 'a comparison becomes treatment options, not chart entries');

  // Done today: charged once, to the provider; a repeat with the same Idempotency-Key does nothing more.
  const key = { 'Idempotency-Key': `te-${Date.now()}` };
  const keyed = h.client(token, key);
  const done1 = await keyed.post(`/patients/${patient.id}/chart-entry`, { text: '14 crb bu done', provider_id: provider.id });
  const done2 = await keyed.post(`/patients/${patient.id}/chart-entry`, { text: '14 crb bu done', provider_id: provider.id });
  assert.equal(done1.status, 201);
  assert.equal(done2.headers.get('idempotent-replay'), 'true');
  const charges = await h.db.all("SELECT amount FROM ledger_entries WHERE patient_id = ? AND type = 'charge' AND voided_at IS NULL", patient.id);
  assert.deepEqual(charges.map((c) => c.amount).sort((a, b) => a - b), [30000, 135000]);

  // Who may chart: clinical:write, in this practice; the assistant needs a person's OK to complete work.
  const front = await staff(api, 'front_desk');
  assert.equal((await front.api.post(`/patients/${patient.id}/chart-entry`, { text: '14 crb' })).status, 403);
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${patient.id}/chart-entry`, { text: '14 crb' })).status, 404);
  const dentist = await staff(api, 'dentist');
  const aiDone = await dentist.ai.post(`/patients/${patient.id}/chart-entry`, { text: '19 rct done', provider_id: provider.id });
  assert.equal(aiDone.status, 428);
  const aiPlan = await dentist.ai.post(`/patients/${patient.id}/chart-entry`, { text: '19 rct buildup crown plan', source: 'voice' });
  assert.equal(aiPlan.status, 201, 'planning is fine');
  const approved = h.client(dentist.token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' });
  assert.equal((await approved.post(`/patients/${patient.id}/chart-entry`, { text: '20 O filling done', provider_id: provider.id })).status, 201);
  const row = await h.db.get("SELECT actor, source FROM audit_log WHERE action = 'procedure.create' AND practice_id = ? ORDER BY id DESC LIMIT 1", practiceId);
  assert.equal(row.source, 'ai');
  assert.match(row.actor, /approved by/);
});

test('the voice assistant’s chart_entry tool: its confirmation is the same preview, before anything is charted', async () => {
  const { api, patient } = await h.practice();
  const { toolbox } = await import('../src/assistantTools.js');
  const { TOOLS } = await import('../src/routes/assistant.js');
  assert.ok(TOOLS.some((t) => t.name === 'chart_entry' && t.kind === 'write'), 'a change the person confirms');
  const call = async (method, path, body) => {
    const r = method === 'GET' ? await api.get(path) : await api.post(path, body);
    if (r.status >= 400) throw new Error(r.data.error);
    return r.data;
  };
  await api.post('/procedure-codes', { code: 'D7953', description: 'Bone replacement graft, ridge preservation', category: 'oral_surgery', fee: 45000, requires_tooth: 1 });
  const tb = toolbox(call, '2026-09-24 09:00');
  assert.match(await tb.describe('chart_entry', { patient_id: patient.id, text: 'crown bundle on 14 with buildup, plan it' }), /^Chart for Jane Doe: #14 D2740 planned, #14 D2950 planned — \$1650\.00; est\. patient/);
  assert.match(await tb.describe('chart_entry', { patient_id: patient.id, text: 'option one, extraction and bone graft; option two, root canal, buildup and crown on 19' }),
    /^Treatment options for Jane Doe:\nOption A: #19 D7140 planned, #19 D7953 planned — \$650\.00.*\nOption B: #19 D3330 planned, #19 D2950 planned, #19 D2740 planned — \$2900\.00/);
  assert.match(await tb.describe('chart_entry', { patient_id: patient.id, text: '14 banana' }), /can’t: Didn't understand “banana”/);
  assert.equal((await api.get(`/patients/${patient.id}/chart`)).data.procedures.length, 0, 'describing charts nothing');
});
