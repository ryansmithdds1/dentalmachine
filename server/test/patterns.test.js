import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { fitPattern, providerTime } from '../src/patterns.js';

const h = harness();
const day = '2030-06-04'; // a Tuesday

test('patterns: fitted to the visit length; provider time as minute ranges', () => {
  assert.equal(fitPattern('//XXXX//', 80), '//XXXX//');
  assert.equal(fitPattern('//XXXX//', 100), '//XXXXXX//', 'longer visits get more provider time before the closing assistant time');
  assert.equal(fitPattern('//XXXX//', 60), '//XX//', 'shorter visits lose provider time, keeping the assistant time around it');
  assert.equal(fitPattern('//XXXX//', 40), '//X/');
  assert.equal(fitPattern('/X/', 10), 'X');
  assert.deepEqual(providerTime({ start_time: `${day} 09:00`, end_time: `${day} 10:20`, pattern: '//XXXX//' }), [[560, 600]]);
  assert.deepEqual(providerTime({ start_time: `${day} 09:00`, end_time: `${day} 10:00`, pattern: null }), [[540, 600]]);
});

test('a provider can see another patient during a visit\'s assistant time, not during provider time', async () => {
  const { api, patient, provider } = await h.practice();
  const bad = await api.post('/appointment-types', { name: 'Crown prep', duration: 80, pattern: 'x/q' });
  assert.equal(bad.status, 400);
  assert.equal((await api.post('/appointment-types', { name: 'All assistant', duration: 30, pattern: '///' })).status, 400);
  const other = (await api.post('/providers', { name: 'Dr. Quick', type: 'dentist' })).data;
  const crown = (await api.post('/appointment-types', { name: 'Crown prep', duration: 80, pattern: '//xxxx//', provider_durations: { [other.id]: 60 } })).data;
  assert.equal(crown.pattern, '//XXXX//');

  const book = (body) => api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, override_blockout: true, ...body });
  const prep = await book({ appointment_type_id: crown.id, start_time: `${day} 09:00` });
  assert.equal(prep.status, 201, JSON.stringify(prep.data));
  assert.equal(prep.data.end_time, `${day} 10:20`);
  assert.equal((await api.get(`/appointments/${prep.data.id}`)).data.pattern, '//XXXX//');

  const second = (await api.post('/patients', { first_name: 'Sam', last_name: 'Second', dob: '1990-01-01' })).data;
  const quick = (start, end) => api.post('/appointments', { patient_id: second.id, provider_id: provider.id, start_time: `${day} ${start}`, end_time: `${day} ${end}`, override_blockout: true });
  assert.equal((await quick('09:00', '09:20')).status, 201, 'the first 20 minutes are assistant time');
  const clash = await quick('09:30', '09:40');
  assert.equal(clash.status, 409, 'provider time');
  assert.match(clash.data.error, /provider/);
  assert.equal((await quick('10:00', '10:20')).status, 201, 'the last 20 minutes are assistant time again');

  // The same type with the faster provider takes their length.
  const fast = await api.post('/appointments', { patient_id: patient.id, provider_id: other.id, appointment_type_id: crown.id, start_time: `${day} 13:00`, override_blockout: true });
  assert.equal(fast.data.end_time, `${day} 14:00`);
  assert.equal((await api.get(`/appointments/${fast.data.id}`)).data.pattern, '//XX//');
});
