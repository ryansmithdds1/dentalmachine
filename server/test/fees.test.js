import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('office fee schedules: patient, then provider, then office, then standard; fee history', async () => {
  const { api, provider, patient } = await h.practice();
  const std = (await api.get('/procedure-codes')).data.find((c) => c.code === 'D0120');
  const fee = async (extra = {}, who = patient) => (await api.post(`/patients/${who.id}/procedures`, { code: 'D0120', provider_id: provider.id, ...extra })).data.fee;
  assert.equal(await fee(), std.fee);

  const cash = (await api.post('/fee-schedules', { name: 'Cash / uninsured', kind: 'office' })).data;
  await api.put(`/fee-schedules/${cash.id}`, { items: [{ code: 'D0120', fee: 4000 }] });
  const assoc = (await api.post('/fee-schedules', { name: 'Associate', kind: 'office' })).data;
  await api.put(`/fee-schedules/${assoc.id}`, { items: [{ code: 'D0120', fee: 5500 }] });
  const ppo = (await api.post('/fee-schedules', { name: 'Delta PPO' })).data;
  assert.equal(ppo.kind, 'ppo');

  assert.equal((await api.put(`/providers/${provider.id}`, { fee_schedule_id: ppo.id })).status, 400, 'a PPO schedule is not an office fee');
  await api.put(`/providers/${provider.id}`, { fee_schedule_id: assoc.id });
  assert.equal(await fee(), 5500, "the provider's fees");
  await api.put(`/patients/${patient.id}`, { fee_schedule_id: cash.id });
  assert.equal(await fee(), 4000, "the patient's schedule wins");
  // A code missing from the schedules falls back to the standard fee.
  const pa = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0220', provider_id: provider.id, tooth: '3' })).data;
  assert.equal(pa.fee, (await api.get('/procedure-codes')).data.find((c) => c.code === 'D0220').fee);

  // Fee history on the standard fees and on each schedule.
  await api.put(`/procedure-codes/${std.id}`, { fee: std.fee + 1000 });
  await api.put(`/fee-schedules/${cash.id}`, { items: [{ code: 'D0120', fee: 4500 }] });
  const hist = (await api.get('/fee-history?code=D0120')).data;
  assert.deepEqual(hist.slice(0, 2).map((x) => [x.schedule_name, x.old_fee, x.new_fee]), [['Cash / uninsured', 4000, 4500], [null, std.fee, std.fee + 1000]]);
});
