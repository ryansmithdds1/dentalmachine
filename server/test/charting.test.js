import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { mergeNote, notePrompts, parseCsv } from '../src/routes/charting.js';
import { validTooth, codeArea } from '../src/util.js';
import { build837D } from '../src/x12.js';

const h = harness();
const proc = async ({ api, patient, provider }, code, extra = {}) =>
  await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, ...extra });

test('teeth and areas: supernumerary teeth, quadrant and arch procedures', async () => {
  assert.ok(validTooth('51') && validTooth('82') && validTooth('AS') && validTooth('ts'));
  assert.ok(!validTooth('33') && !validTooth('50') && !validTooth('83') && !validTooth('US'));
  assert.equal(codeArea({ code: 'D4341' }), 'quadrant');
  assert.equal(codeArea({ code: 'D5110' }), 'arch');
  assert.equal(codeArea({ code: 'D4910' }), 'mouth');
  assert.equal(codeArea({ code: 'D8080' }), 'mouth');

  const ctx = await h.practice();
  assert.equal((await proc(ctx, 'D7140', { tooth: '55' })).status, 201, 'a supernumerary tooth can be charted');
  const noArea = await proc(ctx, 'D4341');
  assert.equal(noArea.status, 400);
  assert.match(noArea.data.error, /quadrant/);
  const srp = await proc(ctx, 'D4341', { area: 'ur' });
  assert.equal(srp.status, 201);
  assert.equal(srp.data.area, 'UR');
  assert.equal((await proc(ctx, 'D5110', { area: 'UR' })).status, 400, 'dentures are by arch');
  assert.equal((await proc(ctx, 'D5110', { area: 'U' })).status, 201);
  assert.equal((await proc(ctx, 'D1110', { area: 'U' })).status, 400, 'a whole-mouth code takes no area');

  // Completing it names the quadrant on the ledger.
  await ctx.api.post(`/procedures/${srp.data.id}/complete`, {});
  const ledger = (await ctx.api.get(`/patients/${ctx.patient.id}/ledger`)).data;
  assert.ok(ledger.entries.some((e) => /D4341.*UR/.test(e.description)));

  // …and the claim names it as the oral cavity area (SV304).
  const x12 = build837D({
    practice: { name: 'P', npi: '1234567893', tax_id: '741234567', address: '1 Main', city: 'Austin', state: 'TX', zip: '78701' },
    claims: [{ claim: { id: 1, total_fee: 26000 }, patient: { first_name: 'J', last_name: 'D', dob: '1980-01-01', gender: 'F' }, policy: { subscriber_id: 'W1', relationship: 'self' }, carrier: { name: 'Delta', payer_id: '94276' },
      items: [{ code: 'D4341', fee: 26000, area: 'UR', completed_at: '2026-01-02 10:00:00' }] }],
    senderId: 'S', receiverId: 'R',
  });
  assert.match(x12, /SV3\*AD:D4341\*260\*\*10\*\*1/);
});

test('chart as of a date, and condition notes and resolution', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const cond = (await api.post(`/patients/${patient.id}/conditions`, { tooth: 3, condition: 'caries', surfaces: 'MO', notes: 'Watch distal' })).data;
  await proc(ctx, 'D2391', { tooth: 3, surfaces: 'MO', complete: true });
  await proc(ctx, 'D2740', { tooth: 14 });
  const res = await api.put(`/conditions/${cond.id}`, { resolved: true });
  assert.equal(res.data.resolved, 1);
  assert.ok(res.data.resolved_at);

  const past = (await api.get(`/patients/${patient.id}/chart?as_of=2000-01-01`)).data;
  assert.deepEqual([past.conditions.length, past.procedures.length], [0, 0], 'nothing had been charted yet');
  const today = new Date().toISOString().slice(0, 10);
  const now = (await api.get(`/patients/${patient.id}/chart?as_of=${today}`)).data;
  assert.equal(now.procedures.length, 1, 'only completed work shows as history');
  assert.equal(now.procedures[0].code, 'D2391');
  assert.equal(now.conditions.length, 1);
});

test('treatment plan editor: add, remove, reorder, phase, alternatives and discount', async () => {
  const ctx = await h.practice();
  const { api, patient, provider } = ctx;
  const loose = (await proc(ctx, 'D2391', { tooth: 30, surfaces: 'MO' })).data;
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, {
    name: 'Restore', procedures: [{ code: 'D2740', tooth: 30, provider_id: provider.id }], procedure_ids: [loose.id],
  })).data;
  assert.equal(plan.procedures.length, 2, 'charted work gathered into the plan');

  // Add new work, then remove one item (it stays charted, off the plan).
  let p = (await api.post(`/treatment-plans/${plan.id}/procedures`, { procedures: [{ code: 'D0220', tooth: 30, provider_id: provider.id }] })).data;
  assert.equal(p.procedures?.length, 3, JSON.stringify(p));
  const pa = p.procedures.find((x) => x.code === 'D0220');
  p = (await api.del(`/treatment-plans/${plan.id}/procedures/${pa.id}`)).data;
  assert.equal(p.procedures.length, 2);
  const chart = (await api.get(`/patients/${patient.id}/chart`)).data;
  assert.equal(chart.procedures.find((x) => x.id === pa.id).treatment_plan_id, null);

  // Reorder into two phases.
  const [crown, filling] = [p.procedures.find((x) => x.code === 'D2740'), p.procedures.find((x) => x.code === 'D2391')];
  p = (await api.put(`/treatment-plans/${plan.id}/order`, { items: [{ id: filling.id, phase: 1 }, { id: crown.id, phase: 2 }] })).data;
  assert.deepEqual(p.procedures.map((x) => [x.code, x.phase]), [['D2391', 1], ['D2740', 2]]);
  assert.deepEqual(p.phases.map((x) => x.phase), [1, 2]);
  assert.equal((await api.put(`/treatment-plans/${plan.id}/order`, { items: [{ id: 999999, phase: 1 }] })).status, 400);

  // Alternatives: accepting B turns A down and takes its work off the chart.
  const b = (await api.post(`/treatment-plans/${plan.id}/duplicate`, {})).data;
  assert.equal(b.option_label, 'Option B');
  assert.equal(b.procedures.length, 2);
  await api.put(`/treatment-plans/${b.id}`, { status: 'accepted' });
  const plans = (await api.get(`/patients/${patient.id}/treatment-plans`)).data;
  const a = plans.find((x) => x.id === plan.id);
  assert.equal(a.status, 'rejected');
  assert.equal(a.option_label, 'Option A');
  assert.equal(a.procedures.length, 0, "the turned-down option's work is cancelled");

  // A 10% discount comes off the patient's share when the work is done, and goes if it's undone.
  const disc = (await api.put(`/treatment-plans/${b.id}`, { discount_pct: 10 })).data;
  assert.equal(disc.estimate.discount, Math.round(disc.procedures.reduce((s, x) => s + x.fee, 0) * 0.1));
  const f = disc.procedures.find((x) => x.code === 'D2391');
  await api.post(`/procedures/${f.id}/complete`, {});
  let ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  const adj = ledger.entries.find((e) => e.adjustment_type === 'Treatment plan discount');
  assert.equal(adj.amount, -Math.round(f.fee * 0.1));
  await api.post(`/procedures/${f.id}/uncomplete`, { reason: 'wrong tooth' });
  ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(ledger.balance, 0, 'the charge and its discount are both reversed');
  assert.equal((await api.put(`/treatment-plans/${b.id}`, { discount_pct: 150 })).status, 400);
});

test('perio: full readings, validation, editing', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const readings = {
    3: { pd: [3, 2, 4, 5, 3, 3], gm: [1, 0, 0, 2, 0, 0], bop: [0, 0, 1, 1, 0, 0], sup: [0, 0, 0, 1, 0, 0], plaque: [1, 0, 0, 0, 0, 0], furc: [0, 1, 0, 0, 0, 0], mob: 1 },
    1: { missing: true },
  };
  const exam = await api.post(`/patients/${patient.id}/perio`, { readings });
  assert.equal(exam.status, 201);
  assert.deepEqual(exam.data.readings['3'].bop, [false, false, true, true, false, false]);
  assert.equal(exam.data.readings['3'].mob, 1);
  assert.equal(exam.data.readings['1'].missing, true);
  assert.equal((await api.post(`/patients/${patient.id}/perio`, { readings: { 3: { furc: [0, 4, 0, 0, 0, 0] } } })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/perio`, { readings: { 3: { mob: 5 } } })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/perio`, { readings: { 3: { pd: [1, 2, 3] } } })).status, 400);

  const upd = await api.put(`/perio/${exam.data.id}`, { readings: { ...readings, 3: { ...readings[3], pd: [3, 2, 4, 6, 3, 3] } }, notes: 'Rechecked 3 DL' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.readings['3'].pd[3], 6);
  assert.equal(upd.data.notes, 'Rechecked 3 DL');
  assert.equal((await api.del(`/perio/${exam.data.id}`)).status, 200);
  assert.equal((await api.get(`/patients/${patient.id}/perio`)).data.length, 0);
});

test('note templates: merge fields, prompts, and drafts for completed work', async () => {
  const merged = mergeNote('Restored {procedures} for {patient}. BP {bp}. {unknown}', {
    patient: { first_name: 'Jane', last_name: 'Doe' }, date: '2026-01-02',
    procedures: [{ code: 'D2391', tooth: '30', surfaces: 'MO' }], vitals: { bp_systolic: 120, bp_diastolic: 80 },
  });
  assert.equal(merged, 'Restored D2391 #30 MO for Jane Doe. BP 120/80. {unknown}');
  assert.deepEqual(notePrompts('A [[Shade: A1|A2]] b'), [{ token: '[[Shade: A1|A2]]', label: 'Shade', options: ['A1', 'A2'] }]);

  const ctx = await h.practice();
  const { api, patient } = ctx;
  const list = (await api.get('/note-templates')).data;
  assert.ok(list.length >= 5, 'a starter library');
  assert.ok(list.find((t) => t.name === 'Composite restoration').prompts.length > 3);

  const f = (await proc(ctx, 'D2392', { tooth: 19, surfaces: 'MOD' })).data;
  const draft = (await api.get(`/patients/${patient.id}/note-draft?procedure_ids=${f.id}`)).data;
  assert.equal(draft.templates[0].name, 'Composite restoration');
  assert.match(draft.body, /Restored D2392 #19 MOD/);
  assert.ok(draft.prompts.some((x) => x.label === 'Anesthetic'));

  const mine = (await api.post('/note-templates', { name: 'Post-op call', body: 'Called {patient}: [[Status: doing well|some discomfort]].', codes: 'd9 ' })).data;
  assert.equal(mine.codes, 'D9');
  const d2 = (await api.get(`/patients/${patient.id}/note-draft?template_id=${mine.id}`)).data;
  assert.equal(d2.body, 'Called Jane Doe: [[Status: doing well|some discomfort]].');
  await api.del(`/note-templates/${mine.id}`);
  const other = await h.practice();
  assert.equal((await other.api.put(`/note-templates/${list[0].id}`, { name: 'x' })).status, 404, 'practice isolation');
});

test('vitals, ASA class, premedication and medical conditions', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const v = await api.post(`/patients/${patient.id}/vitals`, { bp_systolic: 185, bp_diastolic: 95, pulse: 80 });
  assert.equal(v.status, 201);
  assert.match(v.data.warning, /crisis/);
  assert.equal((await api.post(`/patients/${patient.id}/vitals`, { bp_systolic: 120 })).status, 400, 'both BP numbers');
  assert.equal((await api.post(`/patients/${patient.id}/vitals`, { pulse: 900 })).status, 400);
  assert.equal((await api.get(`/patients/${patient.id}/vitals`)).data.length, 1);

  const upd = await api.put(`/patients/${patient.id}`, { asa_class: 'II', premed_required: true, medical_conditions: ['Prosthetic joint', 'Diabetes', 'Diabetes'] });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.asa_class, 'II');
  assert.equal(upd.data.premed_required, 1);
  assert.deepEqual(JSON.parse(upd.data.medical_conditions), ['Prosthetic joint', 'Diabetes']);
  assert.equal((await api.put(`/patients/${patient.id}`, { asa_class: 'IX' })).status, 400);

  // The BP merges into today's exam note.
  const exam = (await proc(ctx, 'D0150')).data;
  const draft = (await api.get(`/patients/${patient.id}/note-draft?procedure_ids=${exam.id}`)).data;
  assert.match(draft.body, /BP 185\/95/);
});

test('labs: directory, cases linked to a lab and procedure, slip', async () => {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const lab = (await api.post('/labs', { name: 'Keystone Dental Lab', phone: '555-0101', turnaround_days: 10 })).data;
  const crown = (await proc(ctx, 'D2740', { tooth: 8 })).data;
  const c = await api.post('/lab-cases', { patient_id: patient.id, lab_id: lab.id, procedure_id: crown.id, shade: 'A2', sent_date: '2026-03-02' });
  assert.equal(c.status, 201);
  assert.equal(c.data.lab_name, 'Keystone Dental Lab');
  assert.equal(c.data.due_date, '2026-03-12', 'due after the lab turnaround');
  assert.equal(c.data.tooth, '8');
  assert.match(c.data.description, /D2740/);
  const slip = (await api.get(`/lab-cases/${c.data.id}/slip`)).data;
  assert.equal(slip.lab.phone, '555-0101');
  assert.equal(slip.procedure.code, 'D2740');
  assert.equal(slip.patient.last_name, 'Doe');
  assert.equal((await api.get('/labs')).data[0].open_cases, 1);
  assert.equal((await api.post('/lab-cases', { patient_id: patient.id })).status, 400, 'lab name and description needed without links');
});

test('procedure codes: CSV import and favorites', async () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
  const ctx = await h.practice();
  const { api } = ctx;
  const csv = 'Code,Description,Category,Fee,Area,Time units\nD2740,"Crown - porcelain/ceramic",restorative,"$1,350.00",tooth,6\nD9999,Unspecified adjunctive,adjunctive,0,mouth,1\nD4341,,,,quadrant,\nX,,,,,\nD1206,Fluoride varnish,bogus,35,,\n';
  const res = await api.post('/procedure-codes/import', { csv });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.created, res.data.updated], [1, 2]);
  assert.equal(res.data.errors.length, 2);
  const codes = (await api.get('/procedure-codes')).data;
  const crown = codes.find((c) => c.code === 'D2740');
  assert.deepEqual([crown.fee, crown.time_units, crown.area], [135000, 6, 'tooth']);
  assert.ok(codes.find((c) => c.code === 'D9999'));

  await proc(ctx, 'D1110');
  await proc(ctx, 'D1110');
  await proc(ctx, 'D0120');
  const fav = (await api.get('/procedure-codes/favorites')).data;
  assert.deepEqual(fav.slice(0, 2).map((c) => c.code), ['D1110', 'D0120']);
});
