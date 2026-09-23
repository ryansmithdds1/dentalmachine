import { insert, localNow } from '../util.js';
import { sealSecret, openSecret } from '../sso.js';
import { categorize, applyRules } from './categories.js';

export const day = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
export const today = async (db, pid) => localNow((await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York').slice(0, 10);

// ---- Bank (Plaid) ----

function categoryFor(tx, rules) {
  const text = [tx.merchant, tx.description].filter(Boolean).join(' ');
  const own = applyRules(rules, text);
  return own ? { category: own, category_source: 'rule' } : { category: categorize(text, { amount: tx.amount, providerCategory: tx.provider_category }), category_source: 'auto' };
}

// Pulls a connection's accounts and new transactions, files each line under a category, and matches deposits.
export async function syncBank(db, plaid, secret, connection) {
  const pid = connection.practice_id;
  const token = openSecret(connection.access_token, secret, 'bank');
  try {
    for (const a of await plaid.accounts(token)) {
      const have = await db.get('SELECT id FROM bank_accounts WHERE connection_id = ? AND external_id = ?', connection.id, a.external_id);
      const row = { name: a.name, official_name: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype, current_balance: a.current_balance, available_balance: a.available_balance, updated_at: new Date().toISOString() };
      if (have) await db.run(`UPDATE bank_accounts SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), have.id);
      // Only checking and savings take deposits; a business card's lines are spending.
      else await insert(db, 'bank_accounts', { practice_id: pid, connection_id: connection.id, external_id: a.external_id, deposits_here: a.type === 'depository' ? 1 : 0, ...row });
    }
    const accounts = new Map((await db.all('SELECT id, external_id FROM bank_accounts WHERE connection_id = ?', connection.id)).map((a) => [a.external_id, a.id]));
    const rules = await db.all('SELECT * FROM finance_rules WHERE practice_id = ? ORDER BY id DESC', pid);
    const out = await plaid.sync(token, connection.cursor, { db, practiceId: pid, today: await today(db, pid) });
    let added = 0;
    for (const tx of out.added) {
      const accountId = accounts.get(tx.account_external_id);
      if (!accountId || await db.get('SELECT id FROM bank_transactions WHERE account_id = ? AND external_id = ?', accountId, tx.external_id)) continue;
      await insert(db, 'bank_transactions', {
        practice_id: pid, account_id: accountId, external_id: tx.external_id, date: tx.date, amount: tx.amount, description: tx.description, merchant: tx.merchant,
        provider_category: tx.provider_category, pending: tx.pending, ...categoryFor(tx, rules),
      });
      added++;
    }
    for (const tx of out.modified) {
      const accountId = accounts.get(tx.account_external_id);
      await db.run('UPDATE bank_transactions SET date = ?, amount = ?, description = ?, merchant = ?, pending = ? WHERE account_id = ? AND external_id = ?', tx.date, tx.amount, tx.description, tx.merchant, tx.pending, accountId, tx.external_id);
    }
    // A pending line that posted comes back under a new id: the old one goes (unless someone matched it).
    for (const id of out.removed) await db.run('DELETE FROM bank_transactions WHERE practice_id = ? AND external_id = ? AND match_kind IS NULL', pid, id);
    await db.run("UPDATE bank_connections SET cursor = ?, last_synced_at = datetime('now'), status = 'active', error = NULL WHERE id = ?", out.cursor, connection.id);
    const matched = await autoMatch(db, pid);
    return { added, modified: out.modified.length, removed: out.removed.length, matched };
  } catch (err) {
    const relink = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ITEM_NOT_FOUND'].includes(err.code);
    await db.run('UPDATE bank_connections SET status = ?, error = ? WHERE id = ?', relink ? 'relink' : 'error', String(err.message).slice(0, 300), connection.id);
    throw err;
  }
}

export const sealBankToken = (token, secret) => sealSecret(token, secret, 'bank');

// ---- What should show up in the bank ----
// Deposit slips (cash and checks), insurance EFTs (from ERAs), and each day's card and financing payments,
// which the processor pays out in one lump, less its fees.
export async function expectedDeposits(db, pid, from, to) {
  const items = [];
  for (const d of await db.all('SELECT id, deposit_date, total, reference FROM deposits WHERE practice_id = ? AND deposit_date BETWEEN ? AND ? AND total > 0', pid, from, to)) {
    items.push({ key: `deposit:${d.id}`, kind: 'deposit', date: d.deposit_date, amount: d.total, label: `Deposit slip${d.reference ? ` ${d.reference}` : ` #${d.id}`} (cash & checks)` });
  }
  for (const e of await db.all('SELECT id, payer_name, check_number, payment_date, total_paid FROM era_imports WHERE practice_id = ? AND payment_date BETWEEN ? AND ? AND total_paid > 0', pid, from, to)) {
    items.push({ key: `era:${e.id}`, kind: 'era', date: e.payment_date, amount: e.total_paid, trace: e.check_number, label: `${e.payer_name || 'Insurance'} payment${e.check_number ? ` · ${e.check_number}` : ''}` });
  }
  const byDay = await db.all(
    `SELECT entry_date AS date, CASE WHEN method IN ('care_credit','financing') THEN 'financing' WHEN method = 'ach' THEN 'ach' ELSE 'card' END AS kind, -SUM(amount) AS amount, COUNT(*) AS n
     FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund') AND method IN ('credit_card','debit_card','care_credit','financing','ach')
       AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ?
     GROUP BY entry_date, CASE WHEN method IN ('care_credit','financing') THEN 'financing' WHEN method = 'ach' THEN 'ach' ELSE 'card' END`, pid, from, to,
  );
  const NAMES = { card: 'Card payments', financing: 'CareCredit payments', ach: 'Bank (ACH) payments' };
  for (const c of byDay) if (Number(c.amount) > 0) items.push({ key: `${c.kind}:${c.date}`, kind: c.kind, date: c.date, amount: Number(c.amount), label: `${NAMES[c.kind]} ${c.date} (${c.n})` });
  const matched = new Set((await db.all('SELECT match_refs FROM bank_transactions WHERE practice_id = ? AND match_refs IS NOT NULL', pid)).flatMap((r) => JSON.parse(r.match_refs)));
  return items.filter((i) => !matched.has(i.key)).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

// Processors keep a cut: how far under the expected amount a payout can be and still be that payout.
const FEE_ROOM = { card: 0.06, financing: 0.2, ach: 0.01 };

// The expected deposits a bank credit could be, best first. A processor payout can cover up to three days
// of card payments (weekends are paid together).
export function candidates(credit, pool) {
  const out = [];
  const near = pool.filter((p) => daysBetween(p.date, credit.date) >= -3 && daysBetween(p.date, credit.date) <= 7);
  for (const p of near) {
    if (p.kind === 'era' && p.trace && p.trace.length >= 4 && String(credit.description || '').includes(p.trace)) out.push({ keys: [p.key], items: [p], score: 100, fee: p.amount - credit.amount });
    else if (p.amount === credit.amount && !FEE_ROOM[p.kind]) out.push({ keys: [p.key], items: [p], score: 90 - Math.abs(daysBetween(p.date, credit.date)), fee: 0 });
    else if (p.amount === credit.amount) out.push({ keys: [p.key], items: [p], score: 85 - Math.abs(daysBetween(p.date, credit.date)), fee: 0 });
  }
  for (const kind of Object.keys(FEE_ROOM)) {
    const days = near.filter((p) => p.kind === kind && daysBetween(p.date, credit.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < days.length; i++) {
      for (let n = 1; n <= 3 && i + n <= days.length; n++) {
        const run = days.slice(i, i + n);
        if (n > 1 && daysBetween(run[0].date, run[n - 1].date) > 3) break;
        const gross = run.reduce((s, p) => s + p.amount, 0);
        if (credit.amount <= gross && credit.amount >= gross * (1 - FEE_ROOM[kind]) && gross !== credit.amount) {
          out.push({ keys: run.map((p) => p.key), items: run, score: 70 - n * 5 - daysBetween(run[n - 1].date, credit.date), fee: gross - credit.amount });
        }
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function recordMatch(db, credit, match, { userId = null, status = 'auto' } = {}) {
  const expected = match.items.reduce((s, p) => s + p.amount, 0);
  const kinds = [...new Set(match.items.map((p) => p.kind))];
  await db.run(
    "UPDATE bank_transactions SET match_kind = ?, match_refs = ?, match_amount = ?, match_fee = ?, match_status = ?, matched_by = ?, matched_at = datetime('now') WHERE id = ?",
    kinds.length === 1 ? kinds[0] : 'mixed', JSON.stringify(match.keys), expected, expected - credit.amount, status, userId, credit.id,
  );
  // A deposit slip seen in the bank is reconciled (or flagged if the amounts differ).
  for (const p of match.items.filter((x) => x.kind === 'deposit')) {
    const id = Number(p.key.split(':')[1]);
    const whole = match.items.length === 1;
    await db.run("UPDATE deposits SET bank_amount = ?, bank_date = ?, status = ?, reconciled_by = ?, reconciled_at = datetime('now') WHERE id = ?",
      whole ? credit.amount : p.amount, credit.date, !whole || credit.amount === p.amount ? 'reconciled' : 'discrepancy', userId, id);
  }
}

export async function unmatch(db, credit) {
  for (const key of JSON.parse(credit.match_refs || '[]')) {
    if (key.startsWith('deposit:')) await db.run("UPDATE deposits SET status = 'open', bank_amount = NULL, bank_date = NULL, reconciled_by = NULL, reconciled_at = NULL WHERE id = ?", Number(key.split(':')[1]));
  }
  await db.run('UPDATE bank_transactions SET match_kind = NULL, match_refs = NULL, match_amount = NULL, match_fee = NULL, match_status = NULL, matched_by = NULL, matched_at = NULL WHERE id = ?', credit.id);
}

// Bank credits into deposit accounts that aren't matched yet.
export const OPEN_CREDITS = `SELECT bt.* FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.account_id
  WHERE bt.practice_id = ? AND bt.amount > 0 AND bt.match_kind IS NULL AND bt.ignored = 0 AND bt.pending = 0 AND ba.deposits_here = 1
    AND COALESCE(bt.category, '') NOT IN ('transfer','owner')`;

// Matches what's certain: an insurance EFT with its trace number, a single deposit of exactly the right
// amount, or a single processor payout that fits. Anything with more than one possibility waits for a person.
export async function autoMatch(db, pid) {
  const credits = await db.all(`${OPEN_CREDITS} ORDER BY bt.date, bt.id`, pid);
  if (!credits.length) return 0;
  let pool = await expectedDeposits(db, pid, day(credits[0].date, -10), credits.at(-1).date);
  let matched = 0;
  for (const credit of credits) {
    const all = candidates(credit, pool);
    const exact = all.filter((c) => c.fee === 0);
    const pick = all[0]?.score === 100 ? all[0] : exact.length === 1 ? exact[0] : !exact.length && all.length === 1 ? all[0] : null;
    if (!pick) continue;
    await recordMatch(db, credit, pick);
    pool = pool.filter((p) => !pick.keys.includes(p.key));
    matched++;
  }
  return matched;
}

// ---- QuickBooks ----

export const sealQbo = (token, secret) => sealSecret(token, secret, 'qbo');

// A live sign-in for API calls, refreshing the one-hour token (and saving the new refresh token) as needed.
export async function qboAuth(db, qbo, secret, conn) {
  if (conn.expires_at && conn.expires_at > new Date().toISOString()) return { realmId: conn.realm_id, accessToken: openSecret(conn.access_token, secret, 'qbo') };
  try {
    const t = await qbo.refresh(openSecret(conn.refresh_token, secret, 'qbo'));
    await db.run("UPDATE qbo_connections SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_expires_at = COALESCE(?, refresh_expires_at), status = 'active', error = NULL WHERE id = ?",
      sealQbo(t.accessToken, secret), sealQbo(t.refreshToken, secret), t.expiresAt, t.refreshExpiresAt, conn.id);
    return { realmId: conn.realm_id, accessToken: t.accessToken };
  } catch (err) {
    await db.run("UPDATE qbo_connections SET status = 'reconnect', error = ? WHERE id = ?", String(err.message).slice(0, 300), conn.id);
    throw err;
  }
}

export async function collectionsByMonth(db, pid, from, to) {
  const rows = await db.all(
    `SELECT substr(entry_date, 1, 7) AS month, -SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund')
     AND voided_at IS NULL AND reverses_id IS NULL AND entry_date BETWEEN ? AND ? GROUP BY substr(entry_date, 1, 7)`, pid, from, to,
  );
  return Object.fromEntries(rows.map((r) => [r.month, Number(r.n)]));
}

// The chart of accounts (each expense account filed under a category; a person's choice is kept) and the
// monthly profit and loss for the last 13 months.
export async function syncQbo(db, qbo, secret, pid) {
  const conn = await db.get('SELECT * FROM qbo_connections WHERE practice_id = ?', pid);
  if (!conn) return null;
  const auth = await qboAuth(db, qbo, secret, conn);
  for (const a of await qbo.accounts(auth)) {
    const have = await db.get('SELECT id, category_source FROM qbo_accounts WHERE practice_id = ? AND qbo_id = ?', pid, a.qbo_id);
    const category = categorize(a.full_name || a.name, { accountType: a.type, amount: -1 });
    if (have) {
      await db.run(`UPDATE qbo_accounts SET name = ?, full_name = ?, type = ?, subtype = ?, active = ?${have.category_source === 'user' ? '' : ', category = ?'} WHERE id = ?`,
        a.name, a.full_name, a.type, a.subtype, a.active, ...(have.category_source === 'user' ? [] : [category]), have.id);
    } else {
      await insert(db, 'qbo_accounts', { practice_id: pid, ...a, category, category_source: 'auto' });
    }
  }
  const to = await today(db, pid);
  const from = `${day(`${to.slice(0, 7)}-15`, -365).slice(0, 7)}-01`;
  const rows = await qbo.profitAndLoss(auth, from, to, { collections: await collectionsByMonth(db, pid, from, to) });
  await db.tx(async () => {
    await db.run('DELETE FROM qbo_pl WHERE practice_id = ? AND month >= ?', pid, from.slice(0, 7));
    for (const r of rows) await insert(db, 'qbo_pl', { practice_id: pid, ...r });
  });
  await db.run("UPDATE qbo_connections SET last_synced_at = datetime('now') WHERE id = ?", conn.id);
  return { accounts: (await db.get('SELECT COUNT(*) AS n FROM qbo_accounts WHERE practice_id = ?', pid)).n, rows: rows.length };
}

export const qboSettings = (conn) => {
  try {
    return JSON.parse(conn?.settings || '{}');
  } catch {
    return {};
  }
};

// Matched deposits not yet in QuickBooks go over as deposits (totals only). Off unless the office turns it on
// — if QuickBooks' own bank feed already brings deposits in, sending them too would count them twice.
export async function pushDeposits(db, qbo, secret, pid, { limit = 50 } = {}) {
  const conn = await db.get('SELECT * FROM qbo_connections WHERE practice_id = ?', pid);
  const s = qboSettings(conn);
  if (!conn || !s.push_deposits || !s.bank_account_id || !s.income_account_id) return { pushed: 0 };
  const auth = await qboAuth(db, qbo, secret, conn);
  const ready = await db.all("SELECT * FROM bank_transactions WHERE practice_id = ? AND match_kind IS NOT NULL AND qbo_id IS NULL AND date >= ? ORDER BY date LIMIT ?", pid, s.push_since || '2000-01-01', limit);
  const LABEL = { deposit: 'Cash & check deposit', era: 'Insurance EFT', card: 'Card payments', financing: 'Patient financing', ach: 'ACH payments', mixed: 'Patient & insurance payments' };
  let pushed = 0;
  for (const t of ready) {
    const fee = Math.max(0, t.match_fee || 0);
    const id = await qbo.createDeposit(auth, {
      date: t.date, bankAccountId: s.bank_account_id, incomeAccountId: s.income_account_id, feesAccountId: s.fees_account_id,
      gross: t.amount + fee, fee, memo: `${LABEL[t.match_kind] || 'Deposit'} — Dental Machine`,
    });
    await db.run('UPDATE bank_transactions SET qbo_id = ? WHERE id = ?', id, t.id);
    pushed++;
  }
  return { pushed };
}
