import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const vendorCalls = [];
const fakeVendor = async (url, init) => {
  if (!String(url).startsWith('https://attach.example.com')) return new Response('{}', { status: 404 });
  const body = JSON.parse(init.body);
  vendorCalls.push({ body, auth: init.headers.Authorization });
  return new Response(JSON.stringify({ control_number: `NEA${vendorCalls.length}`, id: `v${vendorCalls.length}` }));
};
const h = harness();

async function crownClaim(api, patient, provider) {
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', group_number: 'G1' })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: provider.id, complete: true })).data;
  return (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
}

test('attachments: hints for crowns, x-ray + narrative sent (sandbox), PWK segments in the 837', async () => {
  const { api, patient, provider, token } = await h.practice();
  const claim = await crownClaim(api, patient, provider);
  let v = (await api.get(`/claims/${claim.id}/validate`)).data;
  assert.match(v.warnings[0], /Crowns.*pre-op x-ray.*D2740/);

  const xray = await (await fetch(`${h.origin}/api/patients/${patient.id}/documents?filename=pa30.txt&category=xray`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' })).json();
  assert.equal((await api.post(`/claims/${claim.id}/attachments`, { report_type: 'ZZ', document_id: xray.id })).status, 400);
  assert.equal((await api.post(`/claims/${claim.id}/attachments`, { report_type: 'OZ' })).status, 400);
  await api.post(`/claims/${claim.id}/attachments`, { report_type: 'RB', document_id: xray.id });
  const list = (await api.post(`/claims/${claim.id}/attachments`, { report_type: 'OZ', narrative: 'Fractured MB cusp, existing large amalgam.' })).data;
  assert.equal(list.length, 2);
  assert.equal(list[0].transmission, 'EL');
  v = (await api.get(`/claims/${claim.id}/validate`)).data;
  assert.deepEqual(v.warnings, []);
  assert.ok(v.problems.some((p) => /attachments first/.test(p)));

  const sent = (await api.post(`/claims/${claim.id}/attachments/send`)).data;
  assert.ok(sent.results.every((r) => r.ok));
  assert.ok(sent.attachments.every((a) => /^SBX/.test(a.control_number) && a.status === 'accepted'));
  assert.equal((await api.del(`/claim-attachments/${sent.attachments[0].id}`)).status, 409);

  const file = (await api.post('/claims/837', { claim_ids: [claim.id] })).data;
  const text = typeof file === 'string' ? file : file.file || JSON.stringify(file);
  assert.ok(text.includes(`PWK*RB*EL***AC*${sent.attachments[0].control_number}`), text);
  assert.ok(text.includes(`PWK*OZ*EL***AC*${sent.attachments[1].control_number}`));
  // PWK comes right after CLM in the claim loop.
  const segs = text.split('~').map((s) => s.trim());
  const clm = segs.findIndex((s) => s.startsWith('CLM*'));
  assert.ok(segs[clm + 1].startsWith('PWK*'));
});

test('attachment vendor over HTTP gets the file and patient details; manual mode numbers them for mail', async () => {
  const { createApp } = await import('../src/app.js');
  const { createAttachmentSender } = await import('../src/attachments.js');
  const http = createAttachmentSender({ mode: 'http', url: 'https://attach.example.com/v1/attachments', key: 'k1' }, fakeVendor);
  const out = await http.send({ claim_control: 'DM1', payer_id: '94276', patient: { first_name: 'Jane' }, report_type: 'RB', file: { name: 'a.png', mime: 'image/png', base64: 'AA==' } });
  assert.deepEqual([out.control_number, out.status, vendorCalls[0].auth, vendorCalls[0].body.file.name], ['NEA1', 'sent', 'Bearer k1', 'a.png']);
  const manual = createAttachmentSender({ mode: 'manual' });
  assert.equal(manual.electronic, false);
  assert.match((await manual.send({ claim_control: 'DM7' })).control_number, /^DM7A[0-9A-F]{6}$/);
  assert.ok(createApp);
});
