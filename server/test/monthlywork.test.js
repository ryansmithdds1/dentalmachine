// Weekly/monthly workflows 45–54: claim follow-up order, appeals saved and followed up, one print for a
// statement run, the refund queue, duplicate charts compared, supply orders, the month-end packet and undoing a
// close, and the background pass that raises what's due in Needs attention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runMonthlyWorkJobs, lastMonthOf } from '../src/monthlywork.js';

const h = harness();

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const policies = new Map();
async function sentClaim(api, patient, provider, { code = 'D2740', tooth = '19', sentDaysAgo = 45 } = {}) {
  if (!policies.has(patient.id)) {
    const carrier = (await api.post('/carriers', { name: `Payer ${Math.random().toString(36).slice(2, 6)}`, payer_id: '62308' })).data;
    policies.set(patient.id, (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'C77' })).data);
  }
  const policy = policies.get(patient.id);
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code, tooth, provider_id: provider.id, complete: true })).data;
  const made = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const claim = made.data;
  await h.db.run("UPDATE claims SET status = 'submitted', submitted_at = ? WHERE id = ?", `${daysAgo(sentDaysAgo)} 10:00:00`, claim.id);
  return claim;
}

test('#45 insurance follow-up: due calls first, a due count, and a call moves the claim off the due list', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const fresh = await sentClaim(api, patient, provider, { sentDaysAgo: 5 });
  const old = await sentClaim(api, patient, provider, { sentDaysAgo: 50, tooth: '30' });
  const promised = await sentClaim(api, patient, provider, { sentDaysAgo: 70, tooth: '14' });
  await h.db.run('UPDATE claims SET follow_up_date = ? WHERE id = ?', inDays(5), promised.id);

  const list = (await api.get('/reports/outstanding-claims')).data;
  assert.equal(list.due_count, 1);
  assert.deepEqual(list.rows.map((c) => [c.id, c.due]), [[old.id, true], [promised.id, false], [fresh.id, false]]);
  assert.deepEqual((await api.get('/reports/outstanding-claims?due=1')).data.rows.map((c) => c.id), [old.id]);
  assert.equal((await api.get('/reports/outstanding-claims?order=submitted')).data.rows[0].id, promised.id, 'the old order is still there');

  const call = await api.post(`/claims/${old.id}/calls`, { outcome: 'in_process', reference: 'R-1', follow_up_date: inDays(14) });
  assert.equal(call.status, 201);
  assert.equal((await api.get('/reports/outstanding-claims')).data.due_count, 0);
});

test('#46 appeal: a template draft without AI, then sent — filed on the chart, in the claim history, followed up, once', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const claim = await sentClaim(api, patient, provider);
  assert.equal((await api.post(`/claims/${claim.id}/appeal`, {})).status, 409, 'not answered yet');
  await h.db.run("UPDATE claims SET status = 'denied', denial_reason = 'Frequency limit' WHERE id = ?", claim.id);

  const draft = await api.post(`/claims/${claim.id}/appeal`, {});
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.equal(draft.data.drafted_by, 'template');
  assert.match(draft.data.letter, /Frequency limit/);
  assert.match(draft.data.letter, /D2740 tooth #19/);

  assert.equal((await api.post(`/claims/${claim.id}/appeal`, { letter: 'too short' })).status, 400);
  assert.equal((await api.post(`/claims/${claim.id}/appeal`, { letter: draft.data.letter, follow_up_date: '2020-01-01' })).status, 400, 'no follow-up in the past');
  const sent = await api.post(`/claims/${claim.id}/appeal`, { letter: draft.data.letter, drafted_by: 'template' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.ok(sent.data.document_id);
  const again = await api.post(`/claims/${claim.id}/appeal`, { letter: draft.data.letter, drafted_by: 'template' });
  assert.equal(again.data.already, true);
  assert.equal(again.data.event_id, sent.data.event_id);

  const events = (await api.get(`/claims/${claim.id}/events`)).data.filter((e) => e.source === 'appeal');
  assert.equal(events.length, 1);
  assert.equal(events[0].details.document_id, sent.data.document_id);
  const row = await h.db.get('SELECT follow_up_date FROM claims WHERE id = ?', claim.id);
  assert.equal(row.follow_up_date, sent.data.follow_up_date);
  const doc = await h.db.get('SELECT category, mime, patient_id FROM documents WHERE id = ?', sent.data.document_id);
  assert.deepEqual([doc.category, doc.mime, doc.patient_id], ['correspondence', 'application/pdf', patient.id]);
  const audit = await h.db.get("SELECT details, changes FROM audit_log WHERE action = 'claim.appeal' AND entity_id = ?", claim.id);
  assert.match(audit.details, /"drafted_by":"template"/);
  assert.match(audit.changes, /follow_up_date/);
});

test('#47 a statement run prints as one PDF and the deliveries are marked printed', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  await api.put(`/patients/${patient.id}`, { email: null });
  const second = (await api.post('/patients', { first_name: 'Bo', last_name: 'Paper', dob: '1970-01-01', address: '2 Oak', city: 'Austin', state: 'TX', zip: '78701' })).data;
  for (const p of [patient, second]) await api.post(`/patients/${p.id}/adjustments`, { amount: 12000, description: 'Balance brought over', adjustment_type: 'Other' });
  const run = await api.post('/statements/run', { min_balance: 100, since_days: 0, email: false });
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.equal(run.data.print_ids.length, 2);
  const pdf = await api.get(`/statements/runs/${run.data.id}/print`);
  assert.equal(pdf.status, 200);
  assert.match(String(pdf.data).slice(0, 8), /%PDF-1/);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM statement_deliveries WHERE run_id = ? AND status = 'printed'", run.data.id)).n, 2);
  assert.equal((await api.get('/statements/runs/999999/print')).status, 404);
});

test('#48 the refund queue lists credits with the card to refund to; refunds are audited with the balance before and after', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'check', reference: '101' });
  const q = (await api.get('/billing/credit-balances')).data;
  const row = q.find((r) => r.patient_id === patient.id);
  assert.equal(row.credit, 5000);
  assert.equal(row.card_payment, null);
  const refund = await api.post(`/patients/${patient.id}/refunds`, { amount: 3000, method: 'check', reference: '2001' });
  assert.equal(refund.status, 201);
  assert.equal(refund.data.balance, -2000);
  const audit = await h.db.get("SELECT details FROM audit_log WHERE action = 'ledger.refund' ORDER BY id DESC LIMIT 1");
  assert.match(audit.details, /"balance_before":-5000/);
  assert.match(audit.details, /"balance_after":-2000/);
  assert.equal((await api.get('/billing/credit-balances')).data.find((r) => r.patient_id === patient.id).credit, 2000);
  assert.equal((await api.post(`/patients/${patient.id}/refunds`, { amount: 9000, method: 'check' })).status, 400, 'never more than the credit');
});

test('#51 duplicate charts come with their history and a suggested chart to keep; merging archives the other', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const dupe = (await api.post('/patients', { first_name: ' jane', last_name: 'DOE ', dob: patient.dob, phone: '(512) 555-0199' })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  const [group] = (await api.get('/patients/duplicate-groups')).data;
  assert.equal(group.length, 2);
  assert.equal(group[0].id, patient.id, 'the chart with history first');
  assert.equal(group[0].suggested_keep, true);
  assert.ok(group[0].ledger_entries >= 1);
  assert.equal((await runMonthlyWorkJobs(h.db))[(await api.get('/practice')).data.id].dupes, 1);

  const m = await api.post(`/patients/${patient.id}/merge`, { from_id: dupe.id });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  const archived = await h.db.get('SELECT status, merged_into_id FROM patients WHERE id = ?', dupe.id);
  assert.deepEqual([archived.status, archived.merged_into_id], ['archived', patient.id]);
  assert.equal((await api.get('/patients/duplicate-groups')).data.length, 0);
  await runMonthlyWorkJobs(h.db);
  assert.equal((await h.db.get("SELECT status FROM issues WHERE dedupe_key = 'duplicate-charts' ORDER BY id DESC LIMIT 1")).status, 'resolved');
});

test('#52 supplies: order what is low once, receive the order with undo, cancel an order', async () => {
  const { api } = await h.practice({ timezone: 'UTC' });
  const gloves = (await api.post('/inventory', { name: 'Gloves M', unit: 'box', on_hand: 1, reorder_at: 2, reorder_qty: 10, supplier: 'Henry Schein', cost: 900 })).data;
  const bibs = (await api.post('/inventory', { name: 'Bibs', unit: 'case', on_hand: 0, reorder_at: 1, reorder_qty: 2 })).data;
  let r = (await api.get('/inventory/reorder')).data;
  assert.deepEqual(r.rows.map((i) => [i.name, i.order_qty, !!i.on_order]), [['Bibs', 2, false], ['Gloves M', 10, false]]);
  assert.equal(r.total, 9000);

  assert.equal((await api.post('/inventory/orders', { items: [{ id: gloves.id, qty: 0 }] })).status, 400);
  const o = await api.post('/inventory/orders', { items: [{ id: gloves.id, qty: 10 }, { id: bibs.id, qty: 2 }] });
  assert.equal(o.data.ordered.length, 2);
  assert.equal((await api.post('/inventory/orders', { items: [{ id: gloves.id, qty: 10 }] })).data.ordered.length, 0, 'not ordered twice');
  r = (await api.get('/inventory/reorder')).data;
  assert.equal(r.on_order, 2);
  assert.equal(r.total, 0);

  const got = await api.post(`/inventory/${gloves.id}/receive`, {});
  assert.deepEqual([got.data.quantity, got.data.on_hand], [10, 11]);
  assert.equal((await api.get('/inventory/reorder')).data.rows.some((i) => i.id === gloves.id), false, 'received and stocked');
  const undo = await api.post(`/inventory/moves/${got.data.move_id}/undo`, {});
  assert.equal(undo.data.on_hand, 1);
  assert.equal((await api.get('/inventory/reorder')).data.rows.find((i) => i.id === gloves.id).on_order.qty, 10, 'the order is open again');
  assert.equal((await api.post(`/inventory/moves/${got.data.move_id}/undo`, {})).status, 409, 'once');

  assert.deepEqual((await api.post('/inventory/orders/cancel', { ids: [bibs.id] })).data.cancelled, [bibs.id]);
  assert.equal((await api.get('/inventory/reorder')).data.rows.find((i) => i.id === bibs.id).on_order, null);
  const moves = (await api.get(`/inventory/${gloves.id}/moves`)).data.map((m) => m.reason);
  assert.deepEqual(moves.slice(0, 3), ['receive_undone', 'received', 'ordered']);
});

test('#54 month-end packet on one screen; closing can be undone; the reminder comes and goes', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const { month, end } = lastMonthOf(new Date().toISOString().slice(0, 10));
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, provider_id, type, amount, description, entry_date) VALUES (?, ?, ?, 'charge', 20000, 'Crown', ?)", pid, patient.id, provider.id, `${month}-10`);
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, method, entry_date) VALUES (?, ?, 'payment', -5000, 'Cash', 'cash', ?)", pid, patient.id, `${month}-11`);

  const packet = (await api.get('/close/packet')).data;
  assert.equal(packet.month, month, 'last month by default');
  assert.equal(packet.totals.production, 20000);
  assert.ok(packet.sections.summary.rows.some((r) => r.item === 'Gross production' && r.amount === 20000));
  const office = packet.sections.production.rows.reduce((t, r) => t + Number(r.gross || 0), 0);
  assert.equal(office, 20000, 'provider rows add up to the month');
  assert.equal(packet.sections.patient_aging.totals.balance, 15000);
  assert.ok(Array.isArray(packet.checks));

  const today = new Date().toISOString().slice(0, 10);
  const jobs = await runMonthlyWorkJobs(h.db);
  const open = await h.db.get("SELECT status FROM issues WHERE practice_id = ? AND dedupe_key = ?", pid, `books-not-closed:${month}`);
  if (Number(today.slice(8, 10)) >= 5) assert.equal(open.status, 'open');
  assert.equal(jobs[pid].closed, false);

  const closed = await api.post('/close', { type: 'month', period: month });
  assert.equal(closed.status, 201);
  assert.equal(closed.data.previous_lock_date, null);
  await runMonthlyWorkJobs(h.db);
  if (open) assert.equal((await h.db.get('SELECT status FROM issues WHERE practice_id = ? AND dedupe_key = ?', pid, `books-not-closed:${month}`)).status, 'resolved');
  const reopen = await api.post(`/close/${closed.data.id}/reopen`, { reason: 'Closed the wrong month' });
  assert.equal(reopen.status, 200, JSON.stringify(reopen.data));
  assert.equal((await api.get('/practice')).data.lock_date, null);
  assert.equal((await api.post(`/close/${closed.data.id}/reopen`, {})).status, 409, 'once');
  const a = await h.db.get("SELECT changes, reason FROM audit_log WHERE action = 'books.reopen'");
  assert.equal(a.reason, 'Closed the wrong month');
  assert.match(a.changes, new RegExp(end));
  // Closing again works, and an older close can't be reopened over a newer one.
  const again = await api.post('/close', { type: 'month', period: month });
  assert.equal(again.status, 201);
  assert.equal((await api.post(`/close/${closed.data.id}/reopen`, {})).status, 409);
});

test('the background pass reminds billing about claims due a call, and resolves it once they are worked', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const claim = await sentClaim(api, patient, provider, { sentDaysAgo: 40 });
  await runMonthlyWorkJobs(h.db);
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = 'claims-follow-up'", pid);
  assert.equal(issue.status, 'open');
  assert.equal(issue.role, 'billing');
  assert.match(issue.title, /1 insurance claim is due/);
  await api.post(`/claims/${claim.id}/calls`, { outcome: 'in_process', follow_up_date: inDays(10) });
  await runMonthlyWorkJobs(h.db);
  assert.equal((await h.db.get("SELECT status FROM issues WHERE practice_id = ? AND dedupe_key = 'claims-follow-up'", pid)).status, 'resolved');
});

test('staff without the permissions are refused, and other practices see nothing', async () => {
  const a = await h.practice({ timezone: 'UTC' });
  const b = await h.practice({ timezone: 'UTC' });
  const claim = await sentClaim(a.api, a.patient, a.provider);
  await h.db.run("UPDATE claims SET status = 'denied' WHERE id = ?", claim.id);
  assert.equal((await b.api.post(`/claims/${claim.id}/appeal`, { letter: 'x'.repeat(80) })).status, 404);
  assert.equal((await b.api.get('/billing/credit-balances')).data.some((r) => r.patient_id === a.patient.id), false);
  const item = (await a.api.post('/inventory', { name: 'Floss', reorder_at: 1 })).data;
  assert.equal((await b.api.post('/inventory/orders', { items: [{ id: item.id, qty: 1 }] })).status, 404);
  const staff = (await a.api.post('/users', { email: `fd-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' })).data;
  const login = await h.client().post('/auth/login', { email: staff.email, password: 'correct-horse-battery' });
  const desk = h.client(login.data.token);
  const { month } = lastMonthOf(new Date().toISOString().slice(0, 10));
  const closed = await a.api.post('/close', { type: 'month', period: month });
  assert.equal((await desk.post(`/close/${closed.data.id}/reopen`, {})).status, 403);
  assert.equal((await b.api.post(`/close/${closed.data.id}/reopen`, {})).status, 404);
});
