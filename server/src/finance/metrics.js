import { CATEGORIES, TYPICAL_OVERHEAD, isExpense, categorize } from './categories.js';
import { expectedDeposits } from './service.js';

const monthsBack = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
};
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const per = (a, b) => (b ? Math.round(a / b) : null);
const day = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// The practice side (production, collections, visits, chair time) next to the business side (what it cost,
// from QuickBooks when connected, else from the categorized bank lines), month by month.
export async function financeOverview(db, pid, { months = 12, today }) {
  const list = monthsBack(today.slice(0, 7), months);
  const from = `${list[0]}-01`;
  const to = today;
  const byMonth = (rows, key = 'n') => Object.fromEntries(rows.map((r) => [r.month, Number(r[key]) || 0]));
  const m7 = 'substr(entry_date, 1, 7)';
  const production = byMonth(await db.all(`SELECT ${m7} AS month, SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND entry_date BETWEEN ? AND ? GROUP BY ${m7}`, pid, from, to));
  const writeOffs = byMonth(await db.all(`SELECT ${m7} AS month, -SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'adjustment' AND amount < 0 AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ? GROUP BY ${m7}`, pid, from, to));
  const collections = byMonth(await db.all(`SELECT ${m7} AS month, -SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund') AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ? GROUP BY ${m7}`, pid, from, to));
  const visitRows = await db.all(
    `SELECT substr(start_time, 1, 7) AS month, substr(start_time, 1, 10) AS d, start_time, end_time FROM appointments
     WHERE practice_id = ? AND status IN ('completed','checked_in','in_chair') AND start_time >= ? AND start_time <= ?`, pid, `${from} 00:00`, `${to} 23:59`,
  );
  const mins = (a, b) => Math.max(0, (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000);

  // Costs: QuickBooks' profit and loss for months it has, the bank's lines otherwise.
  const qboAccounts = new Map((await db.all('SELECT qbo_id, category FROM qbo_accounts WHERE practice_id = ?', pid)).map((a) => [a.qbo_id, a.category]));
  const qboRows = await db.all("SELECT month, qbo_account_id, account_name, section, amount FROM qbo_pl WHERE practice_id = ? AND month >= ? AND section IN ('cogs','expense','other_expense')", pid, list[0]);
  const bankRows = await db.all(
    `SELECT substr(bt.date, 1, 7) AS month, bt.category, -SUM(bt.amount) AS n FROM bank_transactions bt
     WHERE bt.practice_id = ? AND bt.amount < 0 AND bt.ignored = 0 AND bt.pending = 0 AND bt.date BETWEEN ? AND ? GROUP BY substr(bt.date, 1, 7), bt.category`, pid, from, to,
  );
  // Processor fees never show as a bank line (payouts arrive net), so matched payouts supply them.
  const feeRows = byMonth(await db.all(
    "SELECT substr(date, 1, 7) AS month, SUM(match_fee) AS n FROM bank_transactions WHERE practice_id = ? AND match_kind IN ('card','financing','mixed') AND match_fee > 0 AND date BETWEEN ? AND ? GROUP BY substr(date, 1, 7)", pid, from, to,
  ));
  const deposited = byMonth(await db.all("SELECT substr(date, 1, 7) AS month, SUM(amount) AS n FROM bank_transactions WHERE practice_id = ? AND match_kind IS NOT NULL AND date BETWEEN ? AND ? GROUP BY substr(date, 1, 7)", pid, from, to));

  const rows = list.map((month) => {
    const visits = visitRows.filter((v) => v.month === month);
    const q = qboRows.filter((r) => r.month === month);
    const b = bankRows.filter((r) => r.month === month);
    const source = q.length ? 'quickbooks' : b.length ? 'bank' : null;
    const costs = {};
    if (source === 'quickbooks') {
      for (const r of q) {
        const cat = qboAccounts.get(r.qbo_account_id) || categorize(r.account_name, { amount: -1, accountType: r.section === 'cogs' ? 'Cost of Goods Sold' : 'Expense' });
        if (isExpense(cat)) costs[cat] = (costs[cat] || 0) + r.amount;
      }
    } else if (source === 'bank') {
      for (const r of b) if (isExpense(r.category || 'other')) costs[r.category || 'other'] = (costs[r.category || 'other'] || 0) + Number(r.n);
      if (feeRows[month]) costs.fees = (costs.fees || 0) + feeRows[month];
    }
    const sum = (f) => Object.entries(costs).filter(([c]) => f(CATEGORIES[c] || CATEGORIES.other)).reduce((s, [, v]) => s + v, 0);
    const overhead = sum((c) => c.overhead);
    const doctor = costs.doctor || 0;
    const expenses = sum(() => true);
    const collected = collections[month] || 0;
    const hours = visits.reduce((s, v) => s + mins(v.start_time, v.end_time), 0) / 60;
    const days = new Set(visits.map((v) => v.d)).size;
    return {
      month, partial: month === today.slice(0, 7), source,
      production: production[month] || 0, write_offs: writeOffs[month] || 0, net_production: (production[month] || 0) - (writeOffs[month] || 0),
      collections: collected, deposited: deposited[month] || 0,
      visits: visits.length, chair_hours: Math.round(hours * 10) / 10, work_days: days,
      costs, overhead, doctor, expenses, profit: source ? collected - expenses : null,
      overhead_pct: source ? pct(overhead, collected) : null,
      cost_per_visit: source ? per(overhead, visits.length) : null,
      cost_per_chair_hour: source ? per(overhead, hours) : null,
      collections_per_chair_hour: per(collected, hours),
      profit_per_chair_hour: source ? per(collected - expenses, hours) : null,
      break_even_per_day: source ? per(overhead + doctor, days) : null,
    };
  });

  // The whole period (full months with costs only, so a half-finished month doesn't skew it).
  const full = rows.filter((r) => r.source && !r.partial);
  const total = (k) => full.reduce((s, r) => s + (r[k] || 0), 0);
  const costs = {};
  for (const r of full) for (const [c, v] of Object.entries(r.costs)) costs[c] = (costs[c] || 0) + v;
  const collected = total('collections');
  const categories = Object.entries(CATEGORIES).filter(([k]) => isExpense(k)).map(([key, c]) => {
    const share = pct(costs[key] || 0, collected);
    const status = !c.typical || share == null ? null : share > c.typical[1] ? 'high' : share < c.typical[0] ? 'low' : 'ok';
    return { key, label: c.label, amount: costs[key] || 0, pct: share, typical: c.typical, overhead: c.overhead, status };
  }).filter((c) => c.amount || c.typical);
  const hours = total('chair_hours');
  const overhead = total('overhead');
  const summary = {
    months: full.length, collections: collected, production: total('production'), overhead, doctor: total('doctor'), expenses: total('expenses'),
    profit: collected - total('expenses'), overhead_pct: pct(overhead, collected), typical_overhead: TYPICAL_OVERHEAD, profit_pct: pct(collected - total('expenses'), collected),
    visits: total('visits'), chair_hours: Math.round(hours * 10) / 10,
    cost_per_visit: per(overhead, total('visits')), cost_per_chair_hour: per(overhead, hours), profit_per_chair_hour: per(collected - total('expenses'), hours),
    collections_per_chair_hour: per(collected, hours), break_even_per_day: per(overhead + total('doctor'), total('work_days')),
    collection_pct: pct(collected, total('net_production')),
  };

  // Money recorded here that hasn't reached the bank, and card fees as a share of card payments.
  const recon = await reconciliation(db, pid, today);
  const insights = [];
  for (const c of categories.filter((x) => x.status === 'high')) insights.push({ tone: 'warn', text: `${c.label} ran ${c.pct}% of collections — typical is ${c.typical[0]}–${c.typical[1]}%.` });
  if (summary.overhead_pct != null && summary.overhead_pct > TYPICAL_OVERHEAD[1]) insights.push({ tone: 'warn', text: `Overhead is ${summary.overhead_pct}% of collections (typical ${TYPICAL_OVERHEAD[0]}–${TYPICAL_OVERHEAD[1]}%).` });
  if (recon.fees && recon.card_gross) insights.push({ tone: 'info', text: `Card and financing fees took ${money(recon.fees)} of ${money(recon.card_gross)} (${pct(recon.fees, recon.card_gross)}%) in the last 90 days.` });
  if (recon.missing_total) insights.push({ tone: 'warn', text: `${money(recon.missing_total)} recorded as collected more than 5 days ago hasn't shown up in the bank (${recon.missing.length} items).` });
  if (summary.collection_pct != null && summary.collection_pct < 97) insights.push({ tone: 'warn', text: `Collections are ${summary.collection_pct}% of net production — aim for 98%+.` });
  return { months: rows, summary, categories, reconciliation: recon, insights };
}

const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// The last 90 days: what should have reached the bank, what did, and what's missing.
export async function reconciliation(db, pid, today) {
  const since = day(today, -90);
  const missing = await expectedDeposits(db, pid, since, day(today, -5));
  const matched = await db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(CASE WHEN match_fee > 0 AND match_kind IN ('card','financing','mixed') THEN match_fee ELSE 0 END),0) AS fees, COALESCE(SUM(CASE WHEN match_kind IN ('card','financing','mixed') THEN match_amount ELSE 0 END),0) AS card_gross FROM bank_transactions WHERE practice_id = ? AND match_kind IS NOT NULL AND date >= ?",
    pid, since,
  );
  const open = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bt.amount),0) AS amount FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.account_id
     WHERE bt.practice_id = ? AND bt.amount > 0 AND bt.match_kind IS NULL AND bt.ignored = 0 AND bt.pending = 0 AND ba.deposits_here = 1 AND COALESCE(bt.category,'') NOT IN ('transfer','owner') AND bt.date >= ?`,
    pid, since,
  );
  return {
    since, matched: Number(matched.n), matched_amount: Number(matched.amount), fees: Number(matched.fees), card_gross: Number(matched.card_gross),
    unmatched_credits: Number(open.n), unmatched_credit_amount: Number(open.amount),
    missing, missing_total: missing.reduce((s, m) => s + m.amount, 0),
  };
}
