import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './helpers.js';

const seen = [];
const queue = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(JSON.parse(body));
    const content = queue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content }));
  });
});
await new Promise((r) => fake.listen(0, r));
after(() => fake.close());
const h = harness({ config: { ediMode: 'manual', assistant: { enabled: true, apiKey: 'k', baseURL: `http://127.0.0.1:${fake.address().port}`, model: 'claude-opus-5-5', effort: 'low' } } });
const DAY = 86400_000;
const ago = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

test('denial scrubber: frequency, filing deadline, duplicates, missing narrative and the payer’s history', async () => {
  const ctx = await h.practice();
  const { api, patient, provider } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'G1' })).data;
  await h.db.run('UPDATE insurance_carriers SET timely_filing_days = 90 WHERE id = ?', carrier.id);
  const proc = async (code, extra = {}) => (await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true, ...extra })).data;
  const claimFor = async (ids) => (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: ids })).data;

  // Bitewings earlier this year, already billed; a build-up once denied by this payer.
  const bw1 = await proc('D0274');
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE id = ?', `${ago(20)} 10:00:00`, bw1.id);
  const first = await claimFor([bw1.id]);
  await api.post(`/claims/${first.id}/submit`);
  const oldCore = await proc('D2950', { tooth: '30' });
  const deniedClaim = await claimFor([oldCore.id]);
  await h.db.run("UPDATE claims SET status = 'denied', denial_reason = 'Narrative required' WHERE id = ?", deniedClaim.id);

  const bw2 = await proc('D0274');
  const core = await proc('D2950', { tooth: '19' });
  const late = await proc('D1110');
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE id = ?', `${ago(120)} 10:00:00`, late.id);
  const claim = await claimFor([bw2.id, core.id, late.id]);
  const risks = (await api.get(`/claims/${claim.id}/scrub`)).data.risks;
  const on = (id) => risks.filter((r) => r.procedure_id === id);
  assert.ok(on(bw2.id).some((r) => r.level === 'deny' && /^Frequency: Bitewings/.test(r.message)), JSON.stringify(risks));
  assert.ok(on(core.id).some((r) => r.level === 'warn' && /Build-ups are often denied without a narrative/.test(r.message)));
  assert.ok(on(core.id).some((r) => /Delta Dental has denied D2950 1 time before \(last: Narrative required\)/.test(r.message)));
  assert.ok(on(late.id).some((r) => r.level === 'deny' && /past this payer’s 90-day filing limit/.test(r.message)));
  // Also on the pre-send check.
  assert.ok((await api.get(`/claims/${claim.id}/validate`)).data.risks.length >= 4);

  // The same service entered twice and billed again.
  const twin = await proc('D0274');
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE id = ?', `${ago(20)} 10:00:00`, twin.id);
  const again = await claimFor([twin.id]);
  const dup = await api.get(`/claims/${again.id}/scrub`);
  assert.equal(dup.status, 200, JSON.stringify(dup.data));
  assert.ok(dup.data.risks.some((r) => /Already billed on claim #\d+/.test(r.message)), JSON.stringify(dup.data));

  // A narrative attached clears the narrative warning.
  await api.post(`/claims/${claim.id}/attachments`, { report_type: 'OZ', narrative: 'Tooth #19 fractured MOD with less than 50% coronal structure remaining.' });
  assert.ok(!(await api.get(`/claims/${claim.id}/scrub`)).data.risks.some((r) => /Build-ups are often denied/.test(r.message)));
});

test('AI narratives and appeal letters are drafted from the chart, for staff to edit', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Cigna', payer_id: '62308' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'C77' })).data;
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '19', condition: 'fracture', surfaces: 'MOD' });
  const crown = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '19', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [crown.id] })).data;

  queue.push([{ type: 'tool_use', id: 't1', name: 'claim_narrative', input: { narrative: 'Tooth #19 presented with a fractured MOD cusp…', missing: ['Pre-op x-ray date'], attach: ['Pre-op periapical of #19'] } }]);
  const n = await api.post(`/claims/${claim.id}/narrative`, { code: 'D2740', tooth: '19' });
  assert.equal(n.status, 200, JSON.stringify(n.data));
  assert.match(n.data.narrative, /fractured MOD/);
  const facts = seen.at(-1).messages[0].content;
  assert.match(facts, /Focus on D2740 on #19/);
  assert.match(facts, /"condition": "fracture"/);
  assert.match(facts, /"subscriber"[\s\S]*"C77"/);
  assert.match(seen.at(-1).system, /never invent findings/);

  assert.equal((await api.post(`/claims/${claim.id}/appeal`, {})).status, 409, 'not answered yet');
  await h.db.run("UPDATE claims SET status = 'denied', denial_reason = 'Not medically necessary' WHERE id = ?", claim.id);
  queue.push([{ type: 'tool_use', id: 't2', name: 'appeal_letter', input: { letter: 'Re: Claim for Jane Doe…', enclosures: ['Narrative', 'Pre-op x-ray'] } }]);
  const a = await api.post(`/claims/${claim.id}/appeal`, {});
  assert.equal(a.status, 200);
  assert.deepEqual(a.data.enclosures, ['Narrative', 'Pre-op x-ray']);
  assert.match(seen.at(-1).messages[0].content, /Not medically necessary/);
});
