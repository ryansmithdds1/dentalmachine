import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { withActor } from '../src/actor.js';
import { completeProcedure } from '../src/services.js';

const h = harness();

test('the assistant can book on its own, but money needs the person’s OK — and the OK is on the record', async () => {
  const { token, patient, provider } = await h.practice();
  const ai = h.client(token, { 'X-Acting-For': 'assistant' });
  const aiApproved = h.client(token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' });

  const pay = await ai.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  assert.equal(pay.status, 428);
  assert.equal(pay.data.needs_approval, true);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", patient.id)).n, 0, 'nothing was posted');
  // Adding a completed procedure posts a charge: also high-risk. A planned one is fine.
  assert.equal((await ai.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).status, 428);
  assert.equal((await ai.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id })).status, 201);

  const ok = await aiApproved.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  assert.equal(ok.status, 201);
  const row = await h.db.get("SELECT * FROM audit_log WHERE entity = 'ledger_entries' AND entity_id = ? AND action LIKE '%create%'", ok.data.entry.id)
    || await h.db.get('SELECT * FROM audit_log WHERE patient_id = ? AND source = ? ORDER BY id DESC LIMIT 1', patient.id, 'ai');
  assert.equal(row.source, 'ai');
  assert.match(row.actor, /approved by/);

  // A person doing it themselves is never asked.
  assert.equal((await h.client(token).post(`/patients/${patient.id}/payments`, { amount: 100, method: 'cash' })).status, 201);
});

test('AI that isn’t coming through a request still can’t post charges without approval', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id })).data;
  const proc = await h.db.get('SELECT * FROM procedures WHERE id = ?', p.id);
  await assert.rejects(
    withActor({ source: 'ai', actor: 'Some agent', practiceId }, () => completeProcedure(h.db, { id: null, practice_id: practiceId }, proc)),
    (err) => err.status === 428,
  );
  assert.equal((await h.db.get('SELECT status FROM procedures WHERE id = ?', p.id)).status, 'planned');
});
