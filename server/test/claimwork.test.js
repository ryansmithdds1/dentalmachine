import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { adaForm } from '../src/adaform.js';

const h = harness();

async function setup() {
  const ctx = await h.practice();
  const { api, patient } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const other = (await api.post('/carriers', { name: 'MetLife', payer_id: '65978' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
  const claimFor = async (code, tooth, surfaces) => {
    const p = (await api.post(`/patients/${patient.id}/procedures`, { code, tooth, surfaces, provider_id: ctx.provider.id, complete: true })).data;
    return (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] })).data;
  };
  return { ...ctx, carrier, other, policy, claimFor };
}

test('claims worklist: needs-attention first, filtered by payer and age', async () => {
  const { api, carrier, other, claimFor } = await setup();
  const fresh = await claimFor('D2392', '30', 'MO');
  const denied = await claimFor('D2391', '19', 'O');
  const stale = await claimFor('D2740', '3');
  await api.post(`/claims/${denied.id}/submit`);
  await api.post(`/claims/${denied.id}/deny`, { reason: 'Missing tooth number' });
  await api.post(`/claims/${stale.id}/submit`);
  await h.db.run('UPDATE claims SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 45 * 86400_000).toISOString(), stale.id);

  const all = (await api.get('/claims')).data;
  assert.deepEqual(all.slice(0, 2).map((c) => c.id).sort(), [denied.id, stale.id].sort(), 'attention first');
  assert.equal(all.find((c) => c.id === stale.id).attention, 'No payment after 45 days');
  assert.equal(all.find((c) => c.id === stale.id).age_days, 45);
  assert.match(all.find((c) => c.id === denied.id).attention, /Denied: Missing tooth/);
  assert.equal(all.find((c) => c.id === fresh.id).attention, null);

  assert.deepEqual((await api.get('/claims?attention=1')).data.map((c) => c.id).sort(), [denied.id, stale.id].sort());
  assert.deepEqual((await api.get('/claims?age=31-60')).data.map((c) => c.id), [stale.id]);
  assert.equal((await api.get(`/claims?carrier_id=${carrier.id}`)).data.length, 3);
  assert.equal((await api.get(`/claims?carrier_id=${other.id}`)).data.length, 0);
});

test('editing a denied claim: fixes the chart, re-estimates, keeps a diff, and goes out as a corrected claim', async () => {
  const { api, patient, claimFor } = await setup();
  const claim = await claimFor('D2391', '19', 'O');
  await api.post(`/claims/${claim.id}/submit`);
  assert.equal((await api.put(`/claims/${claim.id}`, { remarks: 'x' })).status, 409, 'with the payer: send a corrected claim instead');
  await api.post(`/claims/${claim.id}/deny`, { reason: 'Procedure inconsistent with tooth' });
  await h.db.run("UPDATE claims SET payer_claim_number = 'PAY123' WHERE id = ?", claim.id);

  const detail = (await api.get(`/claims/${claim.id}`)).data;
  const item = detail.items[0];
  assert.equal((await api.put(`/claims/${claim.id}`, { items: [{ claim_item_id: item.id, tooth: '99' }] })).status, 400);
  assert.equal((await api.put(`/claims/${claim.id}`, { items: [{ claim_item_id: item.id, code: 'D9999X' }] })).status, 400);
  assert.equal((await api.put(`/claims/${claim.id}`, {})).status, 400, 'nothing changed');

  const res = await api.put(`/claims/${claim.id}`, { items: [{ claim_item_id: item.id, code: 'D2740', tooth: '18', surfaces: '' }], remarks: 'Crown, not a filling; tooth corrected', preauth_number: 'PA-77' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.changes.map((c) => [c.field, c.from, c.to]), [
    ['Note to payer', null, 'Crown, not a filling; tooth corrected'],
    ['Prior authorization #', null, 'PA-77'],
    ['D2391 #19 code', 'D2391', 'D2740'],
    ['D2391 #19 tooth', '19', '18'],
    ['D2391 #19 surfaces', 'O', null],
  ]);
  // The chart is corrected too, and the estimate follows the new code (major, 50%).
  const proc = (await h.db.get('SELECT * FROM procedures WHERE id = ?', item.procedure_id));
  assert.deepEqual([proc.code, proc.tooth, proc.surfaces], ['D2740', '18', null]);
  const after = (await api.get(`/claims/${claim.id}`)).data;
  assert.equal(after.estimated_amount, Math.round(after.total_fee * 0.5));
  const events = (await api.get(`/claims/${claim.id}/events`)).data;
  const ev = events.find((e) => e.source === 'edit');
  assert.equal(ev.details.length, 5);
  assert.ok(ev.user_name);

  // Sent as a corrected claim: it replaces PAY123 and carries the note (NTE) in the 837.
  const corrected = (await api.post(`/claims/${claim.id}/correct`, { original_reference: 'PAY123' })).data;
  assert.equal(corrected.remarks, 'Crown, not a filling; tooth corrected');
  const file = (await api.post('/claims/837', { claim_ids: [corrected.id] })).data;
  assert.match(file, /CLM\*[^~]*\*11:B:7\*/);
  assert.match(file, /REF\*F8\*PAY123~/);
  assert.match(file, /NTE\*ADD\*CROWN, NOT A FILLING; TOOTH CORRECTED~/);
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).status, 200);
});

test('insurance follow-up calls: logged on the claim, and the worklist waits until the follow-up date', async () => {
  const { api, claimFor } = await setup();
  const other = await h.practice();
  const stale = await claimFor('D2740', '3');
  await api.post(`/claims/${stale.id}/submit`);
  await h.db.run('UPDATE claims SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 45 * 86400_000).toISOString(), stale.id);
  assert.equal((await api.post(`/claims/${stale.id}/calls`, { outcome: 'maybe' })).status, 400);
  assert.equal((await other.api.post(`/claims/${stale.id}/calls`, { outcome: 'in_process' })).status, 404);

  const later = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const call = await api.post(`/claims/${stale.id}/calls`, { outcome: 'need_info', contact: 'Maria', reference: 'CALL-5521', note: 'Needs x-ray and narrative', follow_up_date: later });
  assert.equal(call.status, 201);
  const events = (await api.get(`/claims/${stale.id}/events`)).data;
  const logged = events.find((e) => e.source === 'call');
  assert.equal(logged.status, 'need_info');
  assert.deepEqual([logged.details.contact, logged.details.reference, logged.details.follow_up_date], ['Maria', 'CALL-5521', later]);
  assert.ok(logged.user_name);
  assert.match(logged.message, /spoke with Maria · ref CALL-5521/);

  // Someone's on it: off the attention list until the follow-up date.
  let row = (await api.get('/claims')).data.find((c) => c.id === stale.id);
  assert.equal(row.attention, null);
  assert.equal(row.follow_up_date, later);
  await h.db.run('UPDATE claims SET follow_up_date = ? WHERE id = ?', new Date(Date.now() - 86400_000).toISOString().slice(0, 10), stale.id);
  row = (await api.get('/claims?attention=1')).data.find((c) => c.id === stale.id);
  assert.equal(row.attention, 'Follow-up due (last call: payer needs more information)');
  // A call with no follow-up date goes back to the usual rule.
  await api.post(`/claims/${stale.id}/calls`, { outcome: 'in_process' });
  assert.match((await api.get('/claims')).data.find((c) => c.id === stale.id).attention, /No payment after 45 days/);
});

test('ADA claim form: numbered boxes from the claim, other coverage, missing teeth, ten lines a page', async () => {
  const { api, patient, provider, other: otherCarrier, claimFor } = await setup();
  await api.put(`/providers/${provider.id}`, { license_number: 'TX-12345' });
  await api.post(`/patients/${patient.id}/insurance`, { carrier_id: otherCarrier.id, priority: 'secondary', subscriber_name: 'John Doe', subscriber_id: 'M2', relationship: 'spouse', annual_max: 100000 });
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '1', condition: 'missing' });
  const claim = await claimFor('D2392', '30', 'MO');
  const form = await api.get(`/claims/${claim.id}/ada`);
  assert.equal(form.status, 200, JSON.stringify(form.data));
  const f = form.data;
  assert.equal(f.box3.name, 'Delta Dental');
  assert.deepEqual([f.box4.dental, f.box5, f.box8, f.box10, f.box11.name], [true, 'John Doe', 'M2', 'spouse', 'MetLife']);
  assert.deepEqual([f.box12.name, f.box15, f.box18], ['Jane Doe', 'W1', 'self']);
  assert.equal(f.box20.name, 'Doe, Jane');
  assert.equal(f.box21, '1985-04-12');
  assert.equal(f.lines.length, 1);
  assert.deepEqual([f.lines[0].code, f.lines[0].tooth, f.lines[0].surfaces, f.lines[0].tooth_system], ['D2392', '30', 'MO', 'JP']);
  assert.ok(f.lines[0].description);
  assert.equal(f.box32, f.lines[0].fee);
  assert.deepEqual(f.box33, ['1']);
  assert.deepEqual([f.box49, f.box51], ['1234567893', '74-1234567']);
  assert.deepEqual([f.box53.name, f.box54, f.box55], ['Dr. Ann Lee, DDS', '1987654321', 'TX-12345']);
  assert.equal(f.pages, 1);
  assert.equal((await (await h.practice()).api.get(`/claims/${claim.id}/ada`)).status, 404);
});

test('ADA form: more than ten services spill onto a second page; only real tooth numbers count as missing', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ code: 'D1110', fee: 1000, completed_at: '2026-01-02', area: i === 0 ? 'UR' : null }));
  const f = adaForm({ claim: { id: 1 }, policy: { relationship: 'child', subscriber_name: 'Pat Doe' }, carrier: { name: 'X' }, patient: { id: 2, first_name: 'Kid', last_name: 'Doe' }, items, practice: { name: 'P' }, missing: ['3', 'AB', '', 'K', '33'] });
  assert.equal(f.pages, 2);
  assert.equal(f.box32, 12000);
  assert.equal(f.lines[0].area, '10');
  assert.deepEqual(f.box33, ['3', 'K']);
  assert.equal(f.box18, 'dependent child');
});

test('long lists come a page at a time: open claims first, then paid ones, with the full count', async () => {
  const { api, claimFor } = await setup();
  const made = [];
  for (const [code, tooth, surfaces] of [['D2392', '30', 'MO'], ['D2391', '19', 'O'], ['D2740', '3'], ['D2750', '14'], ['D2393', '2', 'MOD']]) made.push(await claimFor(code, tooth, surfaces));
  // Two paid, three still open (one denied, so it needs attention).
  for (const c of made.slice(0, 2)) { await api.post(`/claims/${c.id}/submit`); await api.post(`/claims/${c.id}/payment`, { amount: 1000, write_off: 0 }); }
  await api.post(`/claims/${made[2].id}/submit`);
  await api.post(`/claims/${made[2].id}/deny`, { reason: 'x' });
  const all = await api.get('/claims');
  assert.equal(all.headers.get('x-total-count'), '5');
  assert.equal(all.data[0].id, made[2].id, 'the denied claim first');
  assert.deepEqual(all.data.slice(3).map((c) => c.status), ['paid', 'paid'], 'then paid ones');
  const p1 = await api.get('/claims?limit=2');
  const p2 = await api.get('/claims?limit=2&offset=2');
  const p3 = await api.get('/claims?limit=2&offset=4');
  assert.deepEqual([p1.data.length, p2.data.length, p3.data.length], [2, 2, 1]);
  assert.deepEqual([...p1.data, ...p2.data, ...p3.data].map((c) => c.id), all.data.map((c) => c.id), 'pages join up exactly');
  assert.equal((await api.get('/claims?status=paid&limit=1')).headers.get('x-total-count'), '2');
  assert.equal((await api.get('/claims?attention=1')).headers.get('x-total-count'), '1');
});
