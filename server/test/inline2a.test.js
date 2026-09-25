// Phase 2, batch 2A: the screens that now change things in place (no dialogs, no browser "are you sure?" boxes)
// lean on the ordinary routes — these checks are that those routes still record before/after, who and why, refuse
// what they should, and take the Undo the screens offer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const rows = (pid, where = '', ...args) => h.db.all(`SELECT * FROM audit_log WHERE practice_id = ? ${where} ORDER BY id`, pid, ...args);
const changesOf = (r) => (r?.changes ? JSON.parse(r.changes) : {});
const loginAs = async (api, role) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: `A ${role}`, role, password: `${role}-password-123` });
  const r = await h.client(null, { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: `${role}-password-123` });
  return { api: h.client(r.data.token), user: r.data.user };
};

test('carriers: the usual payer IDs for the add line; the Undo of an add sets it inactive, with before/after', async () => {
  const { api, practiceId } = await h.practice();
  const common = await api.get('/carriers/common');
  assert.equal(common.status, 200);
  assert.equal(common.data.find((c) => c.name === 'Guardian')?.payer_id, '64246');
  assert.equal((await h.client().get('/carriers/common')).status, 401, 'signed in only');
  const { api: asst } = await loginAs(api, 'assistant');
  assert.equal((await asst.get('/carriers/common')).status, 403, 'billing:read, like the carrier list');

  const made = (await api.post('/carriers', { name: 'Guardian Dental', payer_id: '64246', active: true })).data;
  assert.equal(made.payer_id, '64246');
  const undo = await api.put(`/carriers/${made.id}`, { active: false });
  assert.equal(undo.status, 200);
  assert.equal(undo.data.active, 0);
  const row = (await rows(practiceId, "AND action = 'carrier.update' AND entity_id = ?", made.id)).at(-1);
  assert.deepEqual(changesOf(row).active, [1, 0], 'the deactivation is on record with before and after');
});

test('users: the role picked in the list is audited (before → after), signs them out, and Undo puts it back', async () => {
  const { api, practiceId } = await h.practice();
  const { user } = await loginAs(api, 'front_desk');
  const before = await h.db.get('SELECT token_version FROM users WHERE id = ?', user.id);
  const r = await api.put(`/users/${user.id}`, { role: 'billing' });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'billing');
  const after = await h.db.get('SELECT token_version FROM users WHERE id = ?', user.id);
  assert.ok(after.token_version > before.token_version, 'a role change ends their sessions');
  const row = (await rows(practiceId, "AND action = 'user.update' AND entity_id = ?", user.id)).at(-1);
  assert.deepEqual(changesOf(row).role, ['front_desk', 'billing']);
  assert.equal((await api.put(`/users/${user.id}`, { role: 'front_desk' })).data.role, 'front_desk', 'Undo');
  // Only an administrator changes roles, and nobody demotes themselves.
  const { api: billing } = await loginAs(api, 'billing');
  assert.equal((await billing.put(`/users/${user.id}`, { role: 'admin' })).status, 403);
  const me = (await api.get('/auth/me')).data.user || (await api.get('/auth/me')).data;
  assert.equal((await api.put(`/users/${me.id}`, { role: 'billing' })).status, 400);
  assert.equal((await api.put(`/users/${user.id}`, { role: 'owner' })).status, 400, 'a role that does not exist');
});

test('note templates: a delete keeps what the template said in the audit row, and Undo makes it again', async () => {
  const { api, practiceId } = await h.practice();
  const t = (await api.post('/note-templates', { name: 'Crown seat', body: 'Crown #__ seated with __ cement.', codes: 'D27', active: true })).data;
  assert.equal((await api.del(`/note-templates/${t.id}`)).status, 200);
  const row = (await rows(practiceId, "AND action = 'note_template.delete' AND entity_id = ?", t.id))[0];
  assert.ok(row, 'audited');
  assert.equal(changesOf(row).body[0], 'Crown #__ seated with __ cement.', 'the text that was deleted is kept');
  const again = await api.post('/note-templates', { name: 'Crown seat', body: 'Crown #__ seated with __ cement.', codes: 'D27', active: true });
  assert.equal(again.status, 201);
  assert.equal((await api.get('/note-templates')).data.filter((x) => x.name === 'Crown seat').length, 1);
});

test('chart header and contact card: office alert, usual hygienist, name and birth date change in place with before/after', async () => {
  const { api, patient, practiceId } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Sam Okafor, RDH', type: 'hygienist' })).data;
  assert.equal((await api.put(`/patients/${patient.id}`, { office_alert: 'Anxious — offer nitrous' })).status, 200);
  assert.equal((await api.put(`/patients/${patient.id}`, { primary_hygienist_id: hyg.id })).data.primary_hygienist_id, hyg.id);
  assert.equal((await api.put(`/patients/${patient.id}`, { first_name: 'Janet', last_name: 'Doe' })).status, 200);
  assert.equal((await api.put(`/patients/${patient.id}`, { dob: '1985-04-21' })).status, 200);
  const all = await rows(practiceId, "AND entity = 'patients' AND entity_id = ? AND changes IS NOT NULL", patient.id);
  const merged = Object.assign({}, ...all.map(changesOf));
  assert.deepEqual(merged.office_alert, [null, 'Anxious — offer nitrous']);
  assert.equal(merged.primary_hygienist_id[1], hyg.id);
  assert.deepEqual(merged.first_name, ['Jane', 'Janet']);
  assert.deepEqual(merged.dob, ['1985-04-12', '1985-04-21']);
  // Impossible values are refused by the server, not just the screen.
  assert.equal((await api.put(`/patients/${patient.id}`, { dob: '2099-01-01' })).status, 400, 'a birth date in the future');
  assert.equal((await api.put(`/patients/${patient.id}`, { primary_hygienist_id: 999999 })).status, 404, 'a hygienist from nowhere');
  const other = await h.practice();
  assert.equal((await other.api.put(`/patients/${patient.id}`, { office_alert: 'x' })).status, 404, 'another practice’s patient');
});

test('family: the one-line add ("Kit 6/6/2016") makes a child on the guarantor’s account, copying their contact details', async () => {
  const { api, patient } = await h.practice();
  const made = await api.post(`/patients/${patient.id}/family`, { first_name: 'Kit', last_name: 'Doe', dob: '2016-06-06', relationship: 'child' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const fam = (await api.get(`/patients/${patient.id}/family`)).data;
  const kit = fam.members.find((m) => m.first_name === 'Kit');
  assert.ok(kit);
  assert.equal(kit.family_relationship, 'child');
  const full = (await api.get(`/patients/${kit.id}`)).data;
  assert.equal(full.phone, patient.phone, 'the phone comes from the guarantor');
});

test('claims: a corrected claim or a void at the payer needs the payer’s number, happens once, and says so in words', async () => {
  const { api } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Robot Dental', payer_id: '99999' })).data;
  const p = (await api.post('/patients', { first_name: 'Fixie', last_name: 'Claim', dob: '1980-01-01' })).data;
  const policy = (await api.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Fixie Claim', subscriber_id: 'RB1', annual_max: 150000 })).data;
  const prov = (await api.get('/providers')).data[0];
  const proc = (await api.post(`/patients/${p.id}/procedures`, { code: 'D0120', provider_id: prov.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
  await api.post(`/claims/${claim.id}/submit`);
  const none = await api.post(`/claims/${claim.id}/correct`, {});
  assert.equal(none.status, 400);
  assert.match(none.data.error, /payer's claim number/);
  const fixed = await api.post(`/claims/${claim.id}/correct`, { original_reference: 'PAYER-12345' });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.data.frequency_code, '7');
  const twice = await api.post(`/claims/${claim.id}/correct`, { original_reference: 'PAYER-12345' });
  assert.equal(twice.status, 409, 'a second press does not make a second corrected claim');
});

test('collections: sent to the agency and taken back out (the Undo), each on the account’s history; no agency is a plain question', async () => {
  const { api, patient, practiceId } = await h.practice();
  const noAgency = await api.post(`/collections/${patient.id}/agency`, {});
  assert.equal(noAgency.status, 400);
  assert.match(noAgency.data.error, /Which agency/);
  assert.equal((await api.post(`/collections/${patient.id}/agency`, { agency: 'Summit Recovery' })).status, 201);
  assert.equal((await h.db.get('SELECT collection_status FROM patients WHERE id = ?', patient.id)).collection_status, 'agency');
  assert.equal((await api.post(`/collections/${patient.id}/clear`, {})).status, 200);
  assert.equal((await h.db.get('SELECT collection_status FROM patients WHERE id = ?', patient.id)).collection_status, null);
  const changes = await rows(practiceId, "AND entity = 'patients' AND entity_id = ? AND changes LIKE '%collection_status%'", patient.id);
  assert.ok(changes.length >= 2, 'both the send and the undo are recorded with before/after');
  const { api: asst } = await loginAs(api, 'assistant');
  assert.equal((await asst.post(`/collections/${patient.id}/agency`, { agency: 'Summit Recovery' })).status, 403, 'billing:write');
});

test('visit panel: type and length change in place (and back with Undo), recorded with before/after', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const types = (await api.get('/appointment-types?active=true')).data;
  const crown = types.find((t) => /crown/i.test(t.name)) || types[0];
  const day = '2031-03-04';
  const a = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 10:00`, end_time: `${day} 10:30`, override_blockout: true, notify: false })).data;
  const r = await api.put(`/appointments/${a.id}`, { appointment_type_id: crown.id, end_time: `${day} 11:30`, override_blockout: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.appointment_type_id, crown.id);
  assert.equal(r.data.end_time, `${day} 11:30`);
  const back = await api.put(`/appointments/${a.id}`, { appointment_type_id: null, end_time: `${day} 10:30`, override_blockout: true });
  assert.equal(back.data.end_time, `${day} 10:30`, 'Undo');
  const row = (await rows(practiceId, "AND entity = 'appointments' AND entity_id = ? AND action = 'appointment.update' AND changes LIKE '%end_time%'", a.id))[0];
  assert.deepEqual(changesOf(row).end_time, [`${day} 10:30`, `${day} 11:30`]);
  assert.equal((await api.put(`/appointments/${a.id}`, { end_time: `${day} 09:00` })).status, 400, 'an end before the start');
});

test('blocked time: removed at once, and Undo blocks the same time again', async () => {
  const { api } = await h.practice();
  const b = (await api.post('/blockouts', { start_time: '2031-03-05 12:00', end_time: '2031-03-05 13:00', reason: 'Staff meeting' })).data;
  const id = b.id ?? b.ids?.[0] ?? b[0]?.id;
  assert.ok(id, JSON.stringify(b));
  assert.equal((await api.del(`/blockouts/${id}`)).status, 200);
  const again = await api.post('/blockouts', { start_time: '2031-03-05 12:00', end_time: '2031-03-05 13:00', reason: 'Staff meeting', repeat_weeks: 1 });
  assert.equal(again.status, 201);
  const list = (await api.get('/blockouts?from=2031-03-05&to=2031-03-05')).data;
  assert.equal((Array.isArray(list) ? list : list.blockouts || []).filter((x) => x.reason === 'Staff meeting').length, 1);
});
