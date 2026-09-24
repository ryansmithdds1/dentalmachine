import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('smart defaults: each person\'s last-used values, per key and scope, private to them', async () => {
  const { api } = await h.practice();
  assert.deepEqual((await api.get('/me/prefs')).data, {});
  assert.equal((await api.put('/me/prefs/payment.method', { value: 'cash' })).status, 200);
  assert.equal((await api.put('/me/prefs/note.template@provider:3', { value: 12 })).status, 200);
  await api.put('/me/prefs/payment.method', { value: 'check' });
  assert.deepEqual((await api.get('/me/prefs')).data, { 'payment.method': 'check', 'note.template@provider:3': 12 });
  assert.equal((await api.put('/me/prefs/Bad Key!', { value: 1 })).status, 400);
  assert.equal((await api.put('/me/prefs/big', { value: 'x'.repeat(5000) })).status, 400);
  // Someone else (even in the same practice) sees only their own.
  const email = `pref-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Front', role: 'front_desk', password: 'front-desk-password' });
  const other = h.client((await h.client().post('/auth/login', { email, password: 'front-desk-password' })).data.token);
  assert.deepEqual((await other.get('/me/prefs')).data, {});
});

test('undo toasts and shortcut matching (client helpers)', async () => {
  const { toast, onToast, undoable } = await import('../../client/src/toast.js');
  const { matches, comboLabel } = await import('../../client/src/shortcuts.js');
  const seen = [];
  const off = onToast((t) => seen.push(t));
  let value = 1;
  await undoable('Changed', async () => { value = 2; return 'r'; }, async (r) => { assert.equal(r, 'r'); value = 1; });
  assert.equal(value, 2);
  assert.equal(seen[0].message, 'Changed');
  await seen[0].undo();
  assert.equal(value, 1);
  assert.equal(seen.at(-1).message, 'Undone');
  await assert.rejects(undoable('Nope', async () => { throw new Error('Card declined'); }));
  assert.equal(seen.at(-1).tone, 'error');
  toast('Plain');
  assert.equal(seen.at(-1).undo, null);
  off();
  const key = (k, o = {}) => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(matches('alt+l', key('¬', { code: 'KeyL', altKey: true })), true, 'Alt on a Mac types a symbol; the key position still matches');
  assert.equal(matches('alt+l', key('l')), false);
  assert.equal(matches('c', key('c')), true);
  assert.equal(matches('c', key('C', { shiftKey: true })), false);
  assert.equal(matches('mod+k', key('k', { ctrlKey: true })), true);
  assert.equal(matches('?', key('?', { shiftKey: true })), true);
  assert.deepEqual(comboLabel('alt+l'), ['Alt', 'L']);
});
