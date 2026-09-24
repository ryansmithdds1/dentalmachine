import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { parseDob, distance, nameScore } from '../src/patientsearch.js';

const h = harness();

test('birth dates in any usual format; typo distance; name scoring', () => {
  assert.equal(parseDob('1985-04-12'), '1985-04-12');
  assert.equal(parseDob('4/12/1985'), '1985-04-12');
  assert.equal(parseDob('04-12-85'), '1985-04-12');
  assert.equal(parseDob('04121985'), '1985-04-12');
  assert.equal(parseDob('2/30/1985'), null, 'not a real date');
  assert.equal(parseDob('5125550100'), null, 'a phone number is not a date');
  assert.equal(distance('jonh', 'john'), 1);
  assert.equal(distance('smtih', 'smith'), 1);
  const jane = { first_name: 'Jane', last_name: 'Doe', preferred_name: null };
  assert.ok(nameScore(['jane', 'doe'], jane) > nameScore(['doe', 'jane'], jane), 'first-last order ranks higher');
  assert.equal(nameScore(['jane', 'xyz'], jane), 0, 'every word must match');
});

test('patient search: names with typos, phone, DOB formats, chart number, old-system chart number', async () => {
  const { api, patient, practiceId } = await h.practice();
  await api.post('/patients', { first_name: 'Jonathan', last_name: 'Smithers', dob: '1990-02-03', phone: '(512) 555-0177' });
  const find = async (q) => (await api.get(`/search?q=${encodeURIComponent(q)}`)).data.patients.map((p) => `${p.first_name} ${p.last_name}`);
  assert.deepEqual(await find('jane doe'), ['Jane Doe']);
  assert.deepEqual(await find('jnae'), ['Jane Doe'], 'swapped letters');
  assert.deepEqual(await find('smtihers'), ['Jonathan Smithers'], 'typo in the last name');
  assert.deepEqual(await find('jon smi'), ['Jonathan Smithers'], 'starts of first and last name');
  assert.deepEqual(await find('2/3/1990'), ['Jonathan Smithers']);
  assert.deepEqual(await find('0177'), ['Jonathan Smithers']);
  assert.deepEqual(await find(`#${patient.id}`), ['Jane Doe']);
  await h.db.run("INSERT INTO external_ids (practice_id, source, kind, external_id, local_id) VALUES (?, 'dentrix', 'patient', 'DX-4411', ?)", practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id, patient.id);
  assert.deepEqual(await find('dx-4411'), ['Jane Doe'], 'the old system\'s chart number, letters and all');
  await h.db.run("UPDATE external_ids SET external_id = '4411' WHERE external_id = 'DX-4411'");
  assert.deepEqual(await find('4411'), ['Jane Doe'], 'the old system\'s chart number');
  // Another practice's patients never show up.
  const other = await h.practice();
  assert.deepEqual((await other.api.get('/search?q=smithers')).data.patients, []);
});
