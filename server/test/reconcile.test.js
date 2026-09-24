import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { reconcileCards, reconcileClaims, reconcileImports } from '../src/reconcile.js';
import { practiceNow } from '../src/util.js';

const h = harness();

test('card payments: processor vs ledger — matched, charged but not posted, posted but not charged, amount differs', async () => {
  const { api, patient, practiceId } = await h.practice();
  const today = (await practiceNow(h.db, practiceId)).slice(0, 10);
  const pay = (amount, reference) => api.post(`/patients/${patient.id}/payments`, { amount, method: 'credit_card', reference });
  await pay(5000, 'pi_match');
  await pay(3000, 'pi_wrong');
  await pay(1000, 'pi_ghost');
  const at = Math.floor(Date.now() / 1000);
  const processor = { listCharges: async ({ practiceId: pid }) => (pid === practiceId ? [
    { id: 'pi_match', amount: 5000, created: at }, { id: 'pi_wrong', amount: 3500, created: at }, { id: 'pi_missing', amount: 7000, created: at },
  ] : []) };
  const out = await reconcileCards(h.db, processor, practiceId, today, today);
  assert.equal(out.matched, 1);
  assert.deepEqual(out.charged_not_posted.map((c) => c.id), ['pi_missing']);
  assert.deepEqual(out.posted_not_charged.map((c) => c.reference), ['pi_ghost']);
  assert.deepEqual(out.amount_differs.map((c) => [c.id, c.ledger_amount, c.amount]), [['pi_wrong', 3000, 3500]]);
  assert.equal(out.processor_total, 15500);
  assert.equal(out.ledger_total, 9000);
  assert.equal((await reconcileCards(h.db, { mode: 'sandbox' }, practiceId, today, today)).available, false);
});

test('claims funnel and stuck claims; import counts that don’t add up; the report route', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const today = (await practiceNow(h.db, practiceId)).slice(0, 10);
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '1' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane', subscriber_id: 'X' })).data;
  const claim = async () => {
    const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true })).data;
    return (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [p.id] })).data;
  };
  const draft = await claim();
  const sent = await claim();
  await api.post(`/claims/${sent.id}/submit`);
  // An old draft and a claim sent 40 days ago with no answer.
  await h.db.run("UPDATE claims SET created_at = '2020-01-01 00:00:00' WHERE id = ?", draft.id);
  await h.db.run('UPDATE claims SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 40 * 86400_000).toISOString(), sent.id);
  const out = await reconcileClaims(h.db, practiceId, today, today);
  assert.equal(out.funnel.created, 1);
  assert.equal(out.funnel.sent, 1);
  assert.deepEqual(out.stuck.not_sent.map((c) => c.id), [draft.id]);
  assert.deepEqual(out.stuck.unpaid_30_days.map((c) => c.id), [sent.id]);

  await h.db.run("INSERT INTO import_batches (practice_id, source, kind, status, total_rows, created_count, updated_count, skipped_count, error_count) VALUES (?, 'csv', 'patients', 'done', 10, 6, 1, 1, 0)", practiceId);
  const [batch] = await reconcileImports(h.db, practiceId, today, today);
  assert.equal(batch.missing, 2);
  assert.equal(batch.ok, false);

  const report = await api.get('/reports/reconciliation');
  assert.equal(report.status, 200);
  assert.equal(report.data.cards.available, false);
  assert.ok(report.data.claims.funnel);
  assert.equal((await api.get('/reports/reconciliation?from=2026-02-01&to=2026-01-01')).status, 400);
});
