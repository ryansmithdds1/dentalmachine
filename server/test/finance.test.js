import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { insert, localNow } from '../src/util.js';
import { candidates } from '../src/finance/service.js';
import { categorize } from '../src/finance/categories.js';
import { parseProfitAndLoss } from '../src/finance/quickbooks.js';

// The sandbox bank mirrors the practice's own deposits (a day after the slip, card days two days later less
// 2.9% + 30¢, insurance EFTs on the payment date) and adds a typical practice's bills.
const h = harness({ config: { plaid: 'sandbox', qbo: 'sandbox' } });
const DAY = 86400_000;
const ago = (n) => localNow('America/New_York', new Date(Date.now() - n * DAY)).slice(0, 10);

async function practiceWithMoney() {
  const ctx = await h.practice();
  const { api, patient, practiceId } = ctx;
  const pay = (amount, method, date, type = 'payment') => insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: patient.id, type, amount: -amount, method, description: 'Payment', entry_date: date });
  // Cash and checks on a deposit slip twelve days ago.
  const e1 = await pay(12_000, 'cash', ago(12));
  const e2 = await pay(33_550, 'check', ago(12));
  const slip = (await api.post('/deposits', { entry_ids: [e1, e2], deposit_date: ago(12), reference: 'Slip 12' })).data;
  // Two card days, and a charge for production.
  await pay(20_000, 'credit_card', ago(9));
  await pay(15_000, 'debit_card', ago(9));
  await pay(50_000, 'credit_card', ago(6));
  await insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: patient.id, type: 'charge', amount: 140_000, description: 'Crown', entry_date: ago(9) });
  // The practice has been open a while (the sandbox bank's bills start with its records).
  await insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: patient.id, type: 'charge', amount: 20_000, description: 'Exam', entry_date: ago(100) });
  // An insurance EFT with its trace number.
  await insert(h.db, 'era_imports', { practice_id: practiceId, payer_name: 'Delta Dental', check_number: '1TRN88442', payment_date: ago(8), total_paid: 81_234, raw: 'ISA*' });
  return { ...ctx, slip };
}

test('bank connection: link, pull the lines, file them by category, and match the deposits', async () => {
  const { api, slip, practiceId } = await practiceWithMoney();
  await api.post('/users', { email: `desk-fin-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  const deskUser = (await api.get('/users')).data.find((u) => u.role === 'front_desk');
  const desk = h.client((await h.client().post('/auth/login', { email: deskUser.email, password: 'front-desk-password' })).data.token);
  assert.equal((await desk.get('/finance/status')).status, 403, 'bank and profit numbers are for the owner (or who they allow)');
  assert.equal((await desk.post('/finance/plaid/link-token')).status, 403);

  assert.equal((await api.post('/finance/plaid/link-token')).data.link_token, 'link-sandbox');
  assert.equal((await api.post('/finance/plaid/exchange', { public_token: 'nope' })).status, 400);
  const linked = await api.post('/finance/plaid/exchange', { public_token: 'public-sandbox-1', institution: 'Chase' });
  assert.equal(linked.status, 201, JSON.stringify(linked.data));
  assert.ok(linked.data.added > 20);
  assert.ok(linked.data.matched >= 4, `matched ${linked.data.matched}`);
  // The key is stored sealed, never as-is.
  const conn = await h.db.get('SELECT access_token FROM bank_connections WHERE practice_id = ?', practiceId);
  assert.match(conn.access_token, /^v1\./);

  const status = (await api.get('/finance/status')).data;
  assert.deepEqual(status.accounts.map((a) => [a.name, a.deposits_here]), [['Business Card', 0], ['Business Checking', 1]]);
  assert.equal(status.connections[0].institution, 'Chase');

  // Deposits: the slip reconciled, the EFT by its trace number, each card day less the processor's cut.
  assert.equal((await api.get(`/deposits/${slip.id}`)).data.status, 'reconciled');
  const m = (await api.get('/finance/matching')).data;
  const kinds = m.matched.map((x) => x.match_kind).sort();
  assert.deepEqual(kinds, ['card', 'card', 'deposit', 'era']);
  const card = m.matched.find((x) => x.match_kind === 'card' && x.match_amount === 35_000);
  assert.equal(card.match_fee, 35_000 - (Math.round(35_000 * 0.971) - 30));
  assert.equal(m.open.length, 0);

  // Bank lines under the right headings.
  const lines = (await api.get(`/finance/bank/transactions?from=${ago(60)}`)).data;
  const cat = (re) => lines.find((l) => re.test(l.description))?.category;
  assert.equal(cat(/HENRY SCHEIN/), 'supplies');
  assert.equal(cat(/GUSTO PAYROLL/), 'staff');
  assert.equal(cat(/ASSOCIATE DENTIST/), 'doctor');
  assert.equal(cat(/RENT/), 'facility');
  assert.equal(cat(/GLIDEWELL/), 'lab');
  assert.equal(cat(/OWNER DRAW/), 'owner');
  assert.equal(cat(/CARD PAYMENT - THANK YOU/), 'transfer');
  assert.equal(cat(/STRIPE TRANSFER/), 'income');

  // "Always file Weave under marketing": the line and every one like it.
  const weave = lines.find((l) => /WEAVE/.test(l.description));
  assert.equal(weave.category, 'admin');
  await api.put(`/finance/bank/transactions/${weave.id}`, { category: 'marketing', remember: true, pattern: 'weave' });
  const after = (await api.get(`/finance/bank/transactions?q=weave&from=${ago(120)}`)).data;
  assert.ok(after.length >= 2 && after.every((l) => l.category === 'marketing'));
  assert.equal((await api.get('/finance/rules')).data[0].pattern, 'weave');
  assert.equal((await api.put(`/finance/bank/transactions/${lines[0].id}`, { category: 'snacks' })).status, 400);

  // Undo a match and do it by hand; the slip goes back to open, then reconciled again.
  const dep = m.matched.find((x) => x.match_kind === 'deposit');
  await api.del(`/finance/bank/transactions/${dep.id}/match`);
  assert.equal((await api.get(`/deposits/${slip.id}`)).data.status, 'open');
  const again = (await api.get('/finance/matching')).data;
  const open = again.open.find((o) => o.id === dep.id);
  assert.deepEqual(open.suggestions[0].keys, [`deposit:${slip.id}`]);
  assert.equal((await api.post(`/finance/bank/transactions/${dep.id}/match`, { keys: [`deposit:${slip.id}`] })).data.match_status, 'manual');
  assert.equal((await api.post(`/finance/bank/transactions/${dep.id}/match`, { keys: [`deposit:${slip.id}`] })).status, 409);
  assert.equal((await api.get(`/deposits/${slip.id}`)).data.status, 'reconciled');

  // Recorded as collected but never reached the bank.
  const e3 = await insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: (await h.db.get('SELECT id FROM patients WHERE practice_id = ?', practiceId)).id, type: 'payment', amount: -9_900, method: 'cash', description: 'Payment', entry_date: ago(10) });
  const lost = (await api.post('/deposits', { entry_ids: [e3], deposit_date: ago(10) })).data;
  const missing = (await api.get('/finance/matching')).data.missing;
  assert.ok(missing.some((x) => x.key === `deposit:${lost.id}` && x.amount === 9_900));

  // Plaid's webhook needs Plaid's signature.
  assert.equal((await fetch(`${h.origin}/api/webhooks/plaid`, { method: 'POST', body: '{}' })).status, 401);
});

test('QuickBooks: connect, the chart of accounts sorted into dental categories, the profit and loss, deposits sent as totals', async () => {
  const { api } = await practiceWithMoney();
  await api.post('/finance/plaid/exchange', { public_token: 'public-sandbox-2', institution: 'Chase' });
  const url = (await api.get('/finance/quickbooks/connect')).data.url.replace('https://app.example.com', h.origin);
  // Intuit sends the browser back with a code; a forged state is refused.
  const bad = await fetch(url.replace(/state=[^&]+/, 'state=forged'), { redirect: 'manual' });
  assert.match(bad.headers.get('location'), /qbo=error/);
  const back = await fetch(url, { redirect: 'manual' });
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /^\/finance\?tab=connections&qbo=connected/);

  const status = (await api.get('/finance/status')).data;
  assert.equal(status.qbo.company_name, 'Bright Smiles Dental PLLC (sandbox)');
  const acct = (name) => status.qbo_accounts.find((a) => a.name === name);
  assert.equal(acct('Lab Fees').category, 'lab');
  assert.equal(acct('Dental Supplies').category, 'supplies');
  assert.equal(acct('Staff Wages').category, 'staff');
  assert.equal(acct('Associate Dentist Compensation').category, 'doctor');
  assert.equal(acct('Merchant Processing Fees').category, 'fees');
  assert.equal(acct('Rent').category, 'facility');
  // A person's choice sticks through the next sync.
  await api.put(`/finance/quickbooks/accounts/${acct('Software & Subscriptions').id}`, { category: 'marketing' });
  await api.post('/finance/quickbooks/sync');
  assert.equal((await api.get('/finance/status')).data.qbo_accounts.find((a) => a.name === 'Software & Subscriptions').category, 'marketing');

  // Sending deposits needs the accounts chosen; then each matched deposit goes once.
  assert.equal((await api.put('/finance/quickbooks/settings', { push_deposits: true })).status, 400);
  assert.equal((await api.put('/finance/quickbooks/settings', { bank_account_id: 'nope' })).status, 400);
  await api.put('/finance/quickbooks/settings', { push_deposits: true, bank_account_id: acct('Operating Checking').qbo_id, income_account_id: acct('Patient Income').qbo_id, fees_account_id: acct('Merchant Processing Fees').qbo_id });
  const pushed = (await api.post('/finance/quickbooks/push')).data.pushed;
  assert.equal(pushed, 4);
  assert.equal((await api.post('/finance/quickbooks/push')).data.pushed, 0, 'once');
  const sent = (await api.get('/finance/matching')).data.matched;
  assert.ok(sent.every((x) => x.qbo_id));
  assert.equal((await api.del(`/finance/bank/transactions/${sent[0].id}/match`)).status, 409, 'already in QuickBooks');

  // The numbers: this month's costs come from QuickBooks.
  const o = (await api.get('/finance/overview?months=3')).data;
  const month = o.months.at(-1);
  assert.equal(month.source, 'quickbooks');
  assert.ok(month.costs.lab > 0 && month.costs.staff > 0);
  assert.ok(month.costs.facility > 0, 'rent');

  assert.equal((await api.del('/finance/quickbooks')).status, 200);
  assert.equal((await api.get('/finance/status')).data.qbo, null);
});

test('the numbers from the bank alone: overhead, cost per visit and per chair hour, against the typical ranges', async () => {
  const { api, practiceId, patient, provider } = await practiceWithMoney();
  // A month of visits so there are chair hours.
  const lastMonth = localNow('America/New_York', new Date(Date.now() - 35 * DAY)).slice(0, 7);
  for (let d = 1; d <= 20; d++) {
    const date = `${lastMonth}-${String(d).padStart(2, '0')}`;
    await insert(h.db, 'appointments', { practice_id: practiceId, patient_id: patient.id, provider_id: provider.id, start_time: `${date} 09:00`, end_time: `${date} 11:00`, status: 'completed' });
    await insert(h.db, 'ledger_entries', { practice_id: practiceId, patient_id: patient.id, type: 'payment', amount: -350_000, method: 'check', description: 'Payment', entry_date: date });
  }
  await api.post('/finance/plaid/exchange', { public_token: 'public-sandbox-3' });
  const o = (await api.get('/finance/overview?months=6')).data;
  const m = o.months.find((x) => x.month === lastMonth);
  assert.equal(m.source, 'bank');
  assert.equal(m.visits, 20);
  assert.equal(m.chair_hours, 40);
  assert.equal(m.collections, 7_000_000);
  assert.ok(m.costs.facility > 0);
  assert.equal(m.costs.owner, undefined, 'owner draws are not a cost');
  assert.equal(m.costs.transfer, undefined, 'paying the card is not a cost (its purchases are)');
  assert.equal(m.cost_per_visit, Math.round(m.overhead / 20));
  assert.equal(m.cost_per_chair_hour, Math.round(m.overhead / 40));
  assert.equal(m.overhead_pct, Math.round((m.overhead / m.collections) * 1000) / 10);
  assert.ok(o.categories.find((c) => c.key === 'staff').typical);
  assert.ok(Array.isArray(o.insights));
  assert.ok(o.summary.months >= 1);
});

test('matching rules: exact amounts, trace numbers, and weekend card batches net of fees', () => {
  const pool = [
    { key: 'card:2026-09-18', kind: 'card', date: '2026-09-18', amount: 100_00 },
    { key: 'card:2026-09-19', kind: 'card', date: '2026-09-19', amount: 50_00 },
    { key: 'card:2026-09-20', kind: 'card', date: '2026-09-20', amount: 25_00 },
    { key: 'deposit:1', kind: 'deposit', date: '2026-09-18', amount: 412_00 },
    { key: 'era:1', kind: 'era', date: '2026-09-21', amount: 900_00, trace: '8844221' },
  ];
  // Friday to Sunday paid Monday as one lump, less 2.9%.
  const weekend = candidates({ id: 1, date: '2026-09-21', amount: Math.round(175_00 * 0.971), description: 'STRIPE TRANSFER' }, pool);
  assert.deepEqual(weekend[0].keys, ['card:2026-09-18', 'card:2026-09-19', 'card:2026-09-20']);
  assert.equal(weekend[0].fee, 175_00 - Math.round(175_00 * 0.971));
  assert.deepEqual(candidates({ id: 2, date: '2026-09-19', amount: 412_00 }, pool)[0].keys, ['deposit:1']);
  const eft = candidates({ id: 3, date: '2026-09-22', amount: 899_00, description: 'DELTA HCCLAIMPMT TRN*1*8844221' }, pool);
  assert.equal(eft[0].score, 100);
  assert.equal(candidates({ id: 4, date: '2026-09-19', amount: 5_000_00 }, pool).length, 0);
});

test('categories for bank lines and QuickBooks accounts; the profit and loss report is read by account and month', () => {
  assert.equal(categorize('DELTA DENTAL INS HCCLAIMPMT', { amount: 50000 }), 'income');
  assert.equal(categorize('Online transfer from savings', { amount: 50000 }), 'transfer');
  assert.equal(categorize('BENCO DENTAL SUPPLY'), 'supplies');
  assert.equal(categorize('Payroll Expenses:Taxes'), 'staff');
  assert.equal(categorize('Officer Compensation'), 'doctor');
  assert.equal(categorize('Lab Fees', { accountType: 'Cost of Goods Sold' }), 'lab');
  assert.equal(categorize('Sales', { accountType: 'Income' }), 'income');
  assert.equal(categorize('SOMETHING ODD', { providerCategory: 'RENT_AND_UTILITIES_RENT' }), 'facility');

  const report = {
    Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Aug 2026', MetaData: [{ Name: 'StartDate', Value: '2026-08-01' }] }, { ColTitle: 'Sep 2026', MetaData: [{ Name: 'StartDate', Value: '2026-09-01' }] }, { ColTitle: 'Total' }] },
    Rows: {
      Row: [
        { type: 'Section', group: 'Income', Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Patient Income', id: '2' }, { value: '1000.00' }, { value: '1200.50' }, { value: '2200.50' }] }] }, Summary: { ColData: [{ value: 'Total Income' }] } },
        {
          type: 'Section', group: 'Expenses', Rows: {
            Row: [
              { type: 'Section', Header: { ColData: [{ value: 'Payroll', id: '20' }] }, Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Wages', id: '21' }, { value: '300' }, { value: '' }, { value: '300' }] }] } },
              { type: 'Data', ColData: [{ value: 'Rent', id: '30' }, { value: '100' }, { value: '100' }, { value: '200' }] },
            ],
          },
        },
      ],
    },
  };
  assert.deepEqual(parseProfitAndLoss(report), [
    { month: '2026-08', qbo_account_id: '2', account_name: 'Patient Income', section: 'income', amount: 100_000 },
    { month: '2026-09', qbo_account_id: '2', account_name: 'Patient Income', section: 'income', amount: 120_050 },
    { month: '2026-08', qbo_account_id: '21', account_name: 'Wages', section: 'expense', amount: 30_000 },
    { month: '2026-08', qbo_account_id: '30', account_name: 'Rent', section: 'expense', amount: 10_000 },
    { month: '2026-09', qbo_account_id: '30', account_name: 'Rent', section: 'expense', amount: 10_000 },
  ]);
});
