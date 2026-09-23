import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

test('collections: past-due accounts, letters, finance charges and late fees, agency and bad-debt write-off', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const kid = (await api.post('/patients', { first_name: 'Kid', last_name: 'Doe', guarantor_id: patient.id })).data;
  // $200 from 100 days ago on the child's chart, $50 from last week on the parent's.
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date) VALUES (?, ?, 'charge', 20000, 'Old work', ?)", pid, kid.id, daysAgo(100));
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date) VALUES (?, ?, 'charge', 5000, 'New work', ?)", pid, patient.id, daysAgo(7));

  let list = (await api.get('/collections')).data.accounts;
  assert.equal(list.length, 1, 'one family account');
  assert.deepEqual([list[0].id, list[0].overdue, list[0].age, list[0].next], [patient.id, 20000, 90, 'letter_90']);

  const letter = await api.post(`/collections/${kid.id}/letter`, { stage: 'letter_90', send: 'email' });
  assert.equal(letter.status, 201);
  assert.match(letter.data.body, /\$200\.00 .* more than 90 days past due/);
  assert.equal(letter.data.message.channel, 'email');
  list = (await api.get('/collections')).data.accounts;
  assert.equal(list[0].collection_status, 'letter_90');
  assert.equal(list[0].next, 'agency');

  // Finance charges: 1.5% a month, $1 minimum; a $10 late fee when nothing's been paid for a month.
  assert.equal((await api.post('/collections/charges', {})).status, 400, 'nothing set up yet');
  await api.put('/practice', { finance_charge_bps: 150, finance_charge_min: 100, late_fee: 1000, collection_agency: 'Acme Recovery' });
  const preview = (await api.post('/collections/charges', {})).data;
  assert.deepEqual(preview.accounts.map((a) => [a.patient_id, a.finance_charge, a.late_fee]), [[patient.id, 300, 1000]]);
  await api.post('/collections/charges', { post: true });
  assert.equal((await api.post('/collections/charges', { post: true })).data.accounts.length, 0, 'once a month');
  const fees = await h.db.all("SELECT adjustment_type, amount FROM ledger_entries WHERE patient_id = ? AND type = 'adjustment' ORDER BY id", patient.id);
  assert.deepEqual(fees.map((f) => [f.adjustment_type, f.amount]), [['Finance charge', 300], ['Late fee', 1000]]);

  // To the agency, writing the balance off.
  assert.equal((await api.post(`/collections/${patient.id}/agency`, { write_off: true })).status, 201);
  const wo = await h.db.get("SELECT amount FROM ledger_entries WHERE patient_id = ? AND adjustment_type = 'Bad debt write-off'", patient.id);
  assert.equal(wo.amount, -(20000 + 5000 + 300 + 1000));
  const detail = (await api.get(`/collections/${patient.id}`)).data;
  assert.equal(detail.account.collection_status, 'agency');
  assert.deepEqual(detail.history.map((x) => x.action), ['written_off', 'agency', 'late_fee', 'finance_charge', 'letter_90']);
  assert.equal(detail.history[1].note, 'Acme Recovery');
  await api.post(`/collections/${patient.id}/clear`, { note: 'Agency settled' });
  assert.equal((await api.get('/collections')).data.accounts.length, 0);
});
