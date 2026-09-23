import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: 'x' }; } };
const h = harness({ messenger });

test('digital lab Rx: the lab gets a private link with the prescription and files, and sends back status and tracking', async () => {
  const { api, token, patient, provider } = await h.practice();
  const lab = (await api.post('/labs', { name: 'Glidewell', email: 'cases@lab.example.com', turnaround_days: 10 })).data;
  const other = await h.practice();
  const scan = await (await fetch(`${h.origin}/api/patients/${patient.id}/documents?filename=scan19.stl&category=other`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'solid scan' })).json();
  const theirs = await (await fetch(`${h.origin}/api/patients/${other.patient.id}/documents?filename=x.txt`, { method: 'POST', headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'text/plain' }, body: 'x' })).json();
  const c = (await api.post('/lab-cases', { patient_id: patient.id, provider_id: provider.id, lab_id: lab.id, description: 'Zirconia crown', due_date: '2030-01-10' })).data;

  const rx = { restoration: 'Full contour crown', material: 'Zirconia', shade: 'A2', stump_shade: 'ND3', margin: 'Chamfer', contacts: 'Medium', teeth: '19', impression: 'Digital scan (iTero)', instructions: 'Please add a buccal groove.', junk: 'dropped' };
  assert.equal((await api.post(`/lab-cases/${c.id}/send`, { rx, document_ids: [theirs.id] })).status, 400, 'files from this patient only');
  const sentRx = await api.post(`/lab-cases/${c.id}/send`, { rx, document_ids: [scan.id] });
  assert.equal(sentRx.status, 200, JSON.stringify(sentRx.data));
  assert.equal(sentRx.data.emailed, true);
  const mail = sent.at(-1);
  assert.equal(mail.to, 'cases@lab.example.com');
  assert.match(mail.subject, /New case from Practice \d+: Zirconia crown \(due 2030-01-10\)/);
  const labToken = sentRx.data.link.split('/lab/')[1];
  assert.ok(mail.body.includes(sentRx.data.link));

  // The lab's view: the Rx, the patient's name/age/sex only, and the file.
  const view = await (await fetch(`${h.origin}/api/public/lab/${labToken}`)).json();
  assert.equal(view.rx.material, 'Zirconia');
  assert.equal(view.rx.junk, undefined);
  assert.equal(view.patient.name, 'Jane Doe');
  assert.deepEqual(Object.keys(view.patient).sort(), ['age', 'gender', 'name']);
  assert.deepEqual(view.files.map((f) => f.filename), ['scan19.stl']);
  const file = await fetch(`${h.origin}/api/public/lab/${labToken}/files/${scan.id}`);
  assert.equal(await file.text(), 'solid scan');
  assert.equal((await fetch(`${h.origin}/api/public/lab/${labToken}/files/${theirs.id}`)).status, 404);
  assert.equal((await fetch(`${h.origin}/api/public/lab/not-a-token`)).status, 404);

  // The lab ships it; the office gets a task and sees tracking on the case.
  const post = (body) => fetch(`${h.origin}/api/public/lab/${labToken}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ status: 'lost' })).status, 400);
  assert.equal((await post({ status: 'shipped', tracking_number: '1Z999', note: 'Out today' })).status, 200);
  const after = (await api.get(`/lab-cases?patient_id=${patient.id}`)).data[0];
  assert.deepEqual([after.lab_status, after.tracking_number, after.shade, after.tooth], ['shipped', '1Z999', 'A2', '19']);
  assert.ok(after.lab_viewed_at);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Lab \(Glidewell\) — Jane Doe, Zirconia crown: Shipped, tracking 1Z999 — “Out today”/.test(t.title)));
  // Cancelling the case closes the link.
  await api.put(`/lab-cases/${c.id}`, { status: 'cancelled' });
  assert.equal((await fetch(`${h.origin}/api/public/lab/${labToken}`)).status, 404);
});
