import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('video visits: a room link on the visit, in the reminder and on the confirm page', async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC' });
  const book = (extra) => api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, ...extra });
  const v = (await book({ start_time: '2031-05-06 09:00', end_time: '2031-05-06 09:30', video: true })).data;
  assert.match(v.video_url, /^https:\/\/meet\.jit\.si\/DentalMachine-[\w-]{12}$/);

  // A visit type can always be by video; a provider's own room is used when set.
  assert.equal((await api.put(`/providers/${provider.id}`, { video_room_url: 'http://not-secure.example' })).status, 400);
  await api.put(`/providers/${provider.id}`, { video_room_url: 'https://doxy.me/drlee' });
  const type = (await api.post('/appointment-types', { name: 'Virtual consult', duration: 20, is_video: true })).data;
  const t = (await book({ start_time: '2031-05-06 10:00', appointment_type_id: type.id })).data;
  assert.equal(t.video_url, 'https://doxy.me/drlee');

  // Turned off and on again on an ordinary visit.
  const plain = (await book({ start_time: '2031-05-06 11:00', end_time: '2031-05-06 11:30' })).data;
  assert.equal(plain.video_url, null);
  assert.equal((await api.put(`/appointments/${plain.id}`, { video: true })).data.video_url, 'https://doxy.me/drlee');
  assert.equal((await api.put(`/appointments/${v.id}`, { video: false })).data.video_url, null);

  const before = h.sent.length;
  await api.post(`/appointments/${t.id}/remind`, { channel: 'email' });
  const msg = h.sent.slice(before)[0];
  assert.match(msg.body, /video visit — join here at the time: https:\/\/doxy\.me\/drlee(\n|$)/);
  const token = /\/c\/([\w-]+)/.exec(msg.body)[1];
  assert.equal((await h.client().get(`/public/confirm/${token}`)).data.video_url, 'https://doxy.me/drlee');
});
