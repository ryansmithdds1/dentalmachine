import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';

const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: 'x' }; } };
const h = harness({ messenger });
process.env.SUNBIT_WEBHOOK_SECRET = 'sunbit-secret';

test('financing: an application is texted with the office’s link, the lender’s callbacks move it along, and funding posts to the ledger', async () => {
  const { api, patient } = await h.practice();
  assert.equal((await api.post(`/patients/${patient.id}/financing`, { lender: 'sunbit', amount: 1200 })).status, 400, 'needs the office’s link');
  await api.put('/practice', { financing: { links: [{ name: 'Sunbit', url: 'https://apply.sunbit.com/brightsmiles' }, { name: 'CareCredit', url: 'https://www.carecredit.com/go/ABC123/' }] } });
  const lenders = (await api.get('/financing/lenders')).data.lenders;
  assert.equal(lenders.find((l) => l.key === 'carecredit').link, 'https://www.carecredit.com/go/ABC123/');
  assert.equal(lenders.find((l) => l.key === 'cherry').link, null);

  const app = await api.post(`/patients/${patient.id}/financing`, { lender: 'sunbit', amount: 1200, channel: 'sms' });
  assert.equal(app.status, 201, JSON.stringify(app.data));
  assert.equal(app.data.message_status, 'sent');
  assert.equal(app.data.link, 'https://apply.sunbit.com/brightsmiles?amount=1200.00');
  assert.match(sent.at(-1).body, /apply for Sunbit financing for your treatment \(\$1200\.00\)/);

  // The lender's signed callbacks.
  const hook = (body, secret = 'sunbit-secret') => {
    const raw = JSON.stringify(body);
    return fetch(`${h.origin}/api/webhooks/financing/sunbit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
  };
  assert.equal((await hook({ reference: `FIN-${app.data.id}`, status: 'approved' }, 'wrong')).status, 401);
  assert.equal((await hook({ reference: `FIN-${app.data.id}`, status: 'approved', approved_amount: 1500, plan: '12 months 0% APR', external_id: 'SB-77' })).status, 200);
  let row = (await api.get(`/patients/${patient.id}/financing`)).data[0];
  assert.deepEqual([row.status, row.approved_amount, row.plan, row.external_id], ['approved', 150000, '12 months 0% APR', 'SB-77']);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Sunbit: Jane Doe was approved for \$1500\.00 — schedule their treatment/.test(t.title)));

  const before = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal((await hook({ external_id: 'SB-77', status: 'funded', funded_amount: 1200 })).status, 200);
  row = (await api.get(`/patients/${patient.id}/financing`)).data[0];
  assert.deepEqual([row.status, row.funded_amount], ['funded', 120000]);
  const entry = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', row.ledger_entry_id);
  assert.deepEqual([entry.type, entry.amount, entry.method, entry.reference], ['payment', -120000, 'financing', 'SB-77']);
  assert.ok(before);
  // A repeat callback doesn't post twice; staff can't re-fund it either.
  assert.equal((await (await hook({ external_id: 'SB-77', status: 'funded', funded_amount: 1200 })).json()).already, true);
  assert.equal((await api.put(`/financing/applications/${row.id}`, { status: 'funded' })).status, 409);

  // Staff record a CareCredit approval and funding from the lender's portal.
  const cc = (await api.post(`/patients/${patient.id}/financing`, { lender: 'carecredit', amount: 800 })).data;
  const funded = await api.put(`/financing/applications/${cc.id}`, { status: 'funded', funded_amount: 800 });
  assert.equal(funded.data.status, 'funded');
  assert.equal((await h.db.get('SELECT method FROM ledger_entries WHERE id = ?', funded.data.ledger_entry_id)).method, 'care_credit');
});
