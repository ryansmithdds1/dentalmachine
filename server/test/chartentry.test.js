import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('charting shorthand: teeth, ranges, surfaces, findings, work and codes', async () => {
  const { parseShorthand, codeFor, describe } = await import('../../client/src/components/patient/chartShorthand.js');
  assert.deepEqual(parseShorthand('30 MO caries'), [{ type: 'condition', tooth: '30', surfaces: 'MO', condition: 'caries' }]);
  assert.deepEqual(parseShorthand('14 D2740'), [{ type: 'procedure', tooth: '14', surfaces: null, code: 'D2740', complete: false }]);
  assert.deepEqual(parseShorthand('2-4 sealant plan').map((x) => [x.tooth, x.code]), [['2', 'D1351'], ['3', 'D1351'], ['4', 'D1351']]);
  assert.deepEqual(parseShorthand('3 crown'), [{ type: 'condition', tooth: '3', surfaces: null, condition: 'crown' }], 'work with no plan/done is existing');
  assert.deepEqual(parseShorthand('19 rct done')[0], { type: 'procedure', tooth: '19', surfaces: null, code: 'D3330', complete: true });
  assert.equal(parseShorthand('8 rct plan')[0].code, 'D3310');
  assert.equal(parseShorthand('20 root canal plan')[0].code, 'D3320');
  assert.equal(parseShorthand('30 MOD filling plan')[0].code, 'D2393');
  assert.equal(parseShorthand('8 MIF filling plan')[0].code, 'D2332');
  assert.equal(parseShorthand('17 ext')[0].code, 'D7140', 'an extraction is always a procedure');
  assert.equal(parseShorthand('32 ext surgical')[0].code, 'D7210');
  assert.deepEqual(parseShorthand('1, 16, 17, 32 missing; 8 watch').map((x) => `${x.tooth} ${x.condition}`), ['1 missing', '16 missing', '17 missing', '32 missing', '8 watch']);
  assert.deepEqual(parseShorthand('21-19 missing').map((x) => x.tooth), ['21', '20', '19'], 'ranges run either way');
  assert.equal(parseShorthand('#K O caries')[0].tooth, 'K', 'primary teeth take a #');
  assert.throws(() => parseShorthand('33 caries'), /isn't a tooth/);
  assert.throws(() => parseShorthand('MO caries'), /tooth number/);
  assert.throws(() => parseShorthand('30 MO banana'), /Didn't understand “banana”/);
  assert.equal(codeFor('filling', '3', 'O'), 'D2391');
  assert.equal(describe(parseShorthand('30 MO caries')[0]), '#30 MO caries');
});

test('conditions charted in error are voided (kept on record); planned work taken off can be put back', async () => {
  const { api, patient } = await h.practice();
  const c = (await api.post(`/patients/${patient.id}/conditions`, { tooth: '30', surfaces: 'MO', condition: 'caries' })).data;
  assert.equal((await api.post(`/conditions/${c.id}/void`, { reason: 'Wrong tooth' })).status, 200);
  assert.equal((await api.get(`/patients/${patient.id}/chart`)).data.conditions.length, 0, 'off the chart');
  const row = await h.db.get('SELECT voided_at, void_reason, voided_by FROM tooth_conditions WHERE id = ?', c.id);
  assert.ok(row.voided_at && row.voided_by);
  assert.equal(row.void_reason, 'Wrong tooth');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'condition.void' AND entity_id = ?", c.id), 'audited');
  assert.equal((await api.post(`/conditions/${c.id}/void`)).data.already, true, 'twice is fine');

  const p = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '14' })).data;
  await api.post(`/procedures/${p.id}/cancel`);
  const back = await api.post(`/procedures/${p.id}/restore`);
  assert.equal(back.data.status, 'planned');
  assert.equal((await api.post(`/procedures/${p.id}/restore`)).status, 409, 'only removed work can be put back');
  // Another practice can't touch them.
  const other = await h.practice();
  assert.equal((await other.api.post(`/conditions/${c.id}/void`)).status, 404);
  assert.equal((await other.api.post(`/procedures/${p.id}/restore`)).status, 404);
});

test('work charted as done without a provider goes to the signed-in dentist, else the patient\'s dentist', async () => {
  const { api, patient, provider } = await h.practice();
  // The admin has no provider of their own; the patient's dentist gets it.
  await api.put(`/patients/${patient.id}`, { primary_provider_id: provider.id });
  const done = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', complete: true })).data;
  assert.equal(done.status, 'completed');
  assert.equal(done.provider_id, provider.id);
  // Signed in as a dentist: their own provider record wins.
  const email = `dds-${Date.now()}@example.com`;
  const user = (await api.post('/users', { email, name: 'Dr Own', role: 'dentist', password: 'dentist-password-1' })).data;
  const own = (await api.post('/providers', { name: 'Dr Own, DDS', type: 'dentist', npi: '1234567893', user_id: user.id })).data;
  const dds = h.client((await h.client().post('/auth/login', { email, password: 'dentist-password-1' })).data.token);
  const mine = (await dds.post(`/patients/${patient.id}/procedures`, { code: 'D2391', tooth: '4', surfaces: 'O', complete: true })).data;
  assert.equal(mine.provider_id, own.id);
  // No dentist anywhere: asked plainly.
  const { api: api2, patient: p2 } = await h.practice();
  const r = await api2.post(`/patients/${p2.id}/procedures`, { code: 'D2740', tooth: '3', complete: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Choose who did this procedure/);
});
