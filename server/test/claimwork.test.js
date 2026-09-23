import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

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
