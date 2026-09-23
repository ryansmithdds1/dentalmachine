import express, { Router } from 'express';
import { raiseIssue, resolveIssue, failed } from '../issues.js';
import { requirePermission, HttpError, signToken, verifyToken } from '../auth.js';
import { insert, findOr404, audit } from '../util.js';
import { CATEGORIES } from '../finance/categories.js';
import {
  syncBank, sealBankToken, expectedDeposits, candidates, recordMatch, unmatch, autoMatch, OPEN_CREDITS,
  syncQbo, sealQbo, qboSettings, pushDeposits, today, day,
} from '../finance/service.js';
import { financeOverview } from '../finance/metrics.js';
import { ppoProfitability } from '../finance/ppo.js';
import { openSecret } from '../sso.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can connect or disconnect accounts')));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const categoryOk = (c) => {
  if (!(c in CATEGORIES)) throw new HttpError(400, `category must be one of ${Object.keys(CATEGORIES).join(', ')}`);
  return c;
};

// The business side of the practice: bank accounts (Plaid), the books (QuickBooks), matching what the office
// collected with what reached the bank, and what the practice really costs to run.
export default function financeRoutes({ db, config, secret, plaid, qbo }) {
  const r = Router();
  const redirectUri = () => `${config.appUrl}/api/finance/quickbooks/callback`;

  r.get('/finance/status', requirePermission('finance:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const qc = await db.get('SELECT company_name, realm_id, environment, status, error, last_synced_at, settings, created_at FROM qbo_connections WHERE practice_id = ?', pid);
    res.json({
      plaid: { mode: plaid.mode, enabled: plaid.enabled },
      quickbooks: { mode: qbo.mode, enabled: qbo.enabled },
      connections: await db.all("SELECT id, provider, institution, status, error, last_synced_at, created_at FROM bank_connections WHERE practice_id = ? AND status != 'removed' ORDER BY id", pid),
      accounts: await db.all(
        `SELECT ba.id, ba.connection_id, ba.name, ba.official_name, ba.mask, ba.type, ba.subtype, ba.current_balance, ba.available_balance, ba.deposits_here, ba.active, ba.updated_at
         FROM bank_accounts ba JOIN bank_connections bc ON bc.id = ba.connection_id WHERE ba.practice_id = ? AND bc.status != 'removed' ORDER BY ba.type, ba.name`, pid,
      ),
      qbo: qc ? { ...qc, settings: qboSettings(qc) } : null,
      qbo_accounts: qc ? await db.all('SELECT id, qbo_id, name, full_name, type, subtype, category, category_source FROM qbo_accounts WHERE practice_id = ? AND active = 1 ORDER BY type, full_name', pid) : [],
      categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label, expense: c.expense !== false, overhead: c.overhead })),
    });
  });

  // ---- Bank (Plaid) ----
  r.post('/finance/plaid/link-token', requireAdmin, async (req, res) => {
    if (!plaid.enabled) throw new HttpError(503, 'Bank connections are not set up on this server (PLAID_CLIENT_ID / PLAID_SECRET)');
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
    const relink = req.body?.connection_id ? await findOr404(db, 'bank_connections', req.body.connection_id, req.user.practice_id, 'Connection') : null;
    const webhook = config.appUrl.startsWith('https://') ? `${config.appUrl}/api/webhooks/plaid` : undefined;
    res.json({
      mode: plaid.mode,
      link_token: await plaid.linkToken({ practiceId: req.user.practice_id, practiceName: practice.name, webhook, accessToken: relink ? openSecret(relink.access_token, secret, 'bank') : undefined }),
    });
  });

  r.post('/finance/plaid/exchange', requireAdmin, async (req, res) => {
    if (!plaid.enabled) throw new HttpError(503, 'Bank connections are not set up on this server');
    const publicToken = String(req.body?.public_token || '');
    if (!publicToken) throw new HttpError(400, 'public_token is required');
    const { accessToken, itemId } = await plaid.exchange(publicToken);
    const id = await insert(db, 'bank_connections', {
      practice_id: req.user.practice_id, provider: 'plaid', item_id: itemId, access_token: sealBankToken(accessToken, secret),
      institution: String(req.body?.institution || '').slice(0, 80) || null, created_by: req.user.id,
    });
    await audit(db, req, 'finance.bank_connect', 'bank_connections', id, { institution: req.body?.institution });
    const result = await syncBank(db, plaid, secret, await db.get('SELECT * FROM bank_connections WHERE id = ?', id));
    res.status(201).json({ id, ...result });
  });

  r.post('/finance/bank/sync', requirePermission('finance:write'), async (req, res) => {
    const out = [];
    for (const c of await db.all("SELECT * FROM bank_connections WHERE practice_id = ? AND status IN ('active','error')", req.user.practice_id)) {
      try {
        out.push({ id: c.id, ...(await syncBank(db, plaid, secret, c)) });
      } catch (err) {
        out.push({ id: c.id, error: err.message });
      }
    }
    res.json(out);
  });

  r.delete('/finance/bank/connections/:id', requireAdmin, async (req, res) => {
    const c = await findOr404(db, 'bank_connections', req.params.id, req.user.practice_id, 'Connection');
    if (c.access_token) await plaid.remove?.(openSecret(c.access_token, secret, 'bank'));
    // The lines already pulled stay for the numbers; the connection and its key go.
    await db.run("UPDATE bank_connections SET status = 'removed', access_token = NULL, cursor = NULL WHERE id = ?", c.id);
    await db.run('UPDATE bank_accounts SET active = 0 WHERE connection_id = ?', c.id);
    await audit(db, req, 'finance.bank_disconnect', 'bank_connections', c.id);
    res.json({ ok: true });
  });

  r.put('/finance/bank/accounts/:id', requireAdmin, async (req, res) => {
    const a = await findOr404(db, 'bank_accounts', req.params.id, req.user.practice_id, 'Account');
    const deposits = req.body?.deposits_here;
    if (deposits !== undefined) await db.run('UPDATE bank_accounts SET deposits_here = ? WHERE id = ?', deposits ? 1 : 0, a.id);
    res.json(await db.get('SELECT * FROM bank_accounts WHERE id = ?', a.id));
  });

  r.get('/finance/bank/transactions', requirePermission('finance:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const now = await today(db, pid);
    const from = DATE.test(req.query.from || '') ? req.query.from : day(now, -60);
    const to = DATE.test(req.query.to || '') ? req.query.to : now;
    const where = ['bt.practice_id = ?', 'bt.date BETWEEN ? AND ?'];
    const args = [pid, from, to];
    if (req.query.category) { where.push('bt.category = ?'); args.push(String(req.query.category)); }
    if (req.query.account_id) { where.push('bt.account_id = ?'); args.push(Number(req.query.account_id)); }
    if (req.query.direction === 'in') where.push('bt.amount > 0');
    if (req.query.direction === 'out') where.push('bt.amount < 0');
    if (req.query.q) { where.push('(LOWER(bt.description) LIKE ? OR LOWER(COALESCE(bt.merchant, \'\')) LIKE ?)'); args.push(`%${String(req.query.q).toLowerCase()}%`, `%${String(req.query.q).toLowerCase()}%`); }
    res.json(await db.all(
      `SELECT bt.id, bt.date, bt.amount, bt.description, bt.merchant, bt.category, bt.category_source, bt.pending, bt.ignored, bt.note, bt.match_kind, bt.match_refs, bt.match_amount, bt.match_fee, bt.match_status, bt.qbo_id,
         ba.name AS account_name, ba.mask AS account_mask
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.account_id WHERE ${where.join(' AND ')} ORDER BY bt.date DESC, bt.id DESC LIMIT 1000`, ...args,
    ));
  });

  // File a line under a category (and, if asked, every line like it from now on), or leave it out of the numbers.
  r.put('/finance/bank/transactions/:id', requirePermission('finance:write'), async (req, res) => {
    const t = await findOr404(db, 'bank_transactions', req.params.id, req.user.practice_id, 'Transaction');
    const b = req.body || {};
    if (b.category !== undefined) {
      await db.run("UPDATE bank_transactions SET category = ?, category_source = 'user' WHERE id = ?", categoryOk(b.category), t.id);
      if (b.remember) {
        const pattern = String(b.pattern || t.merchant || t.description || '').trim().slice(0, 60);
        if (pattern.length >= 3) {
          await insert(db, 'finance_rules', { practice_id: req.user.practice_id, pattern, category: b.category, created_by: req.user.id });
          // Lines already in that nobody has sorted by hand follow the new rule too.
          const like = `%${pattern.toLowerCase()}%`;
          await db.run(
            "UPDATE bank_transactions SET category = ?, category_source = 'rule' WHERE practice_id = ? AND COALESCE(category_source, '') != 'user' AND (LOWER(description) LIKE ? OR LOWER(COALESCE(merchant, '')) LIKE ?)",
            b.category, req.user.practice_id, like, like,
          );
        }
      }
    }
    if (b.ignored !== undefined) await db.run('UPDATE bank_transactions SET ignored = ? WHERE id = ?', b.ignored ? 1 : 0, t.id);
    if (b.note !== undefined) await db.run('UPDATE bank_transactions SET note = ? WHERE id = ?', String(b.note || '').slice(0, 300) || null, t.id);
    res.json(await db.get('SELECT * FROM bank_transactions WHERE id = ?', t.id));
  });

  r.get('/finance/rules', requirePermission('finance:read'), async (req, res) => res.json(await db.all('SELECT * FROM finance_rules WHERE practice_id = ? ORDER BY id DESC', req.user.practice_id)));
  r.delete('/finance/rules/:id', requirePermission('finance:write'), async (req, res) => {
    const rule = await findOr404(db, 'finance_rules', req.params.id, req.user.practice_id, 'Rule');
    await db.run('DELETE FROM finance_rules WHERE id = ?', rule.id);
    res.json({ ok: true });
  });

  // ---- Deposit matching ----
  // Bank credits waiting for a match (with the likely ones), recent matches, and what the office recorded as
  // collected that hasn't shown up in the bank.
  r.get('/finance/matching', requirePermission('finance:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const now = await today(db, pid);
    const days = Math.min(Math.max(Number(req.query.days) || 60, 7), 365);
    const since = day(now, -days);
    const credits = await db.all(`${OPEN_CREDITS} AND bt.date >= ? ORDER BY bt.date DESC`, pid, since);
    const pool = await expectedDeposits(db, pid, day(since, -10), now);
    const matched = await db.all(
      `SELECT bt.id, bt.date, bt.amount, bt.description, bt.match_kind, bt.match_refs, bt.match_amount, bt.match_fee, bt.match_status, bt.qbo_id, ba.name AS account_name
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.account_id WHERE bt.practice_id = ? AND bt.match_kind IS NOT NULL AND bt.date >= ? ORDER BY bt.date DESC LIMIT 300`, pid, since,
    );
    res.json({
      open: credits.map((c) => ({
        id: c.id, date: c.date, amount: c.amount, description: c.description,
        suggestions: candidates(c, pool).slice(0, 4).map((s) => ({ keys: s.keys, fee: s.fee, labels: s.items.map((i) => i.label), expected: s.items.reduce((x, i) => x + i.amount, 0) })),
      })),
      matched: matched.map((m) => ({ ...m, match_refs: JSON.parse(m.match_refs) })),
      // Recorded more than 5 days ago and not in the bank yet.
      missing: pool.filter((p) => p.date >= since && p.date <= day(now, -5)),
      expected: pool,
    });
  });

  r.post('/finance/matching/auto', requirePermission('finance:write'), async (req, res) => res.json({ matched: await autoMatch(db, req.user.practice_id) }));

  r.post('/finance/bank/transactions/:id/match', requirePermission('finance:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const t = await findOr404(db, 'bank_transactions', req.params.id, pid, 'Transaction');
    if (t.amount <= 0) throw new HttpError(400, 'Only money coming in is matched to deposits');
    if (t.match_kind) throw new HttpError(409, 'Already matched — undo that first');
    const keys = [...new Set((req.body?.keys || []).map(String))];
    if (!keys.length) throw new HttpError(400, 'Choose what this deposit was');
    const pool = await expectedDeposits(db, pid, day(t.date, -60), day(t.date, 30));
    const items = keys.map((k) => pool.find((p) => p.key === k));
    if (items.some((i) => !i)) throw new HttpError(409, 'One of those is already matched or isn’t in range');
    await recordMatch(db, t, { keys, items }, { userId: req.user.id, status: 'manual' });
    await audit(db, req, 'finance.match', 'bank_transactions', t.id, { keys });
    res.json(await db.get('SELECT * FROM bank_transactions WHERE id = ?', t.id));
  });

  r.delete('/finance/bank/transactions/:id/match', requirePermission('finance:write'), async (req, res) => {
    const t = await findOr404(db, 'bank_transactions', req.params.id, req.user.practice_id, 'Transaction');
    if (t.qbo_id) throw new HttpError(409, 'This deposit was already sent to QuickBooks — remove it there first');
    await unmatch(db, t);
    await audit(db, req, 'finance.unmatch', 'bank_transactions', t.id);
    res.json({ ok: true });
  });

  // ---- QuickBooks ----
  r.get('/finance/quickbooks/connect', requireAdmin, async (req, res) => {
    if (!qbo.enabled) throw new HttpError(503, 'QuickBooks is not set up on this server (QBO_CLIENT_ID / QBO_CLIENT_SECRET)');
    const state = signToken({ sub: req.user.id, pid: req.user.practice_id, aud: 'qbo-connect' }, secret, 15 * 60);
    res.json({ url: qbo.authUrl(state, redirectUri()) });
  });

  r.post('/finance/quickbooks/sync', requirePermission('finance:write'), async (req, res) => {
    const out = await syncQbo(db, qbo, secret, req.user.practice_id);
    if (!out) throw new HttpError(404, 'QuickBooks isn’t connected');
    res.json(out);
  });

  r.put('/finance/quickbooks/settings', requireAdmin, async (req, res) => {
    const conn = await db.get('SELECT * FROM qbo_connections WHERE practice_id = ?', req.user.practice_id);
    if (!conn) throw new HttpError(404, 'QuickBooks isn’t connected');
    const b = req.body || {};
    const ids = new Set((await db.all('SELECT qbo_id FROM qbo_accounts WHERE practice_id = ?', req.user.practice_id)).map((a) => a.qbo_id));
    const next = { ...qboSettings(conn) };
    for (const k of ['bank_account_id', 'income_account_id', 'fees_account_id']) {
      if (b[k] === undefined) continue;
      if (b[k] && !ids.has(String(b[k]))) throw new HttpError(400, `${k} isn’t an account in QuickBooks`);
      next[k] = b[k] ? String(b[k]) : null;
    }
    if (b.push_deposits !== undefined) next.push_deposits = !!b.push_deposits;
    if (b.push_since !== undefined) {
      if (b.push_since && !DATE.test(b.push_since)) throw new HttpError(400, 'push_since must be YYYY-MM-DD');
      next.push_since = b.push_since || null;
    }
    if (next.push_deposits && (!next.bank_account_id || !next.income_account_id)) throw new HttpError(400, 'Choose the bank and income accounts before sending deposits');
    await db.run('UPDATE qbo_connections SET settings = ? WHERE id = ?', JSON.stringify(next), conn.id);
    await audit(db, req, 'finance.qbo_settings', 'qbo_connections', conn.id, next);
    res.json(next);
  });

  r.put('/finance/quickbooks/accounts/:id', requirePermission('finance:write'), async (req, res) => {
    const a = await findOr404(db, 'qbo_accounts', req.params.id, req.user.practice_id, 'Account');
    await db.run("UPDATE qbo_accounts SET category = ?, category_source = 'user' WHERE id = ?", categoryOk(req.body?.category), a.id);
    res.json(await db.get('SELECT * FROM qbo_accounts WHERE id = ?', a.id));
  });

  r.post('/finance/quickbooks/push', requirePermission('finance:write'), async (req, res) => res.json(await pushDeposits(db, qbo, secret, req.user.practice_id)));

  r.delete('/finance/quickbooks', requireAdmin, async (req, res) => {
    const conn = await db.get('SELECT * FROM qbo_connections WHERE practice_id = ?', req.user.practice_id);
    if (!conn) return res.json({ ok: true });
    await qbo.revoke?.(openSecret(conn.refresh_token, secret, 'qbo'));
    await db.run('DELETE FROM qbo_connections WHERE id = ?', conn.id);
    await audit(db, req, 'finance.qbo_disconnect', 'qbo_connections', conn.id);
    res.json({ ok: true });
  });

  // ---- The numbers ----
  r.get('/finance/overview', requirePermission('finance:read'), async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 3), 24);
    res.json(await financeOverview(db, req.user.practice_id, { months, today: await today(db, req.user.practice_id) }));
  });
  // Which insurance plans pay for the chair time they take, and what leaving one would likely do.
  r.get('/finance/ppo', requirePermission('finance:read'), async (req, res) => {
    const clamp = (v, lo, hi, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Math.min(Math.max(Number(v), lo), hi));
    res.json(await ppoProfitability(db, req.user.practice_id, {
      today: await today(db, req.user.practice_id), months: clamp(req.query.months, 3, 24, 12),
      retention: clamp(req.query.retention, 0, 100, 70), refill: clamp(req.query.refill, 0, 100, 50),
      costPerHour: req.query.cost_per_hour ? Math.round(clamp(req.query.cost_per_hour, 1, 1e8, 0)) : null,
    }));
  });

  return r;
}

// Intuit sends the office back here after sign-in (a browser redirect, so no API token: the signed state
// says which practice and person started it). And Plaid's webhook, which says new transactions are ready.
export function financePublicRoutes({ db, config, secret, plaid, qbo }) {
  const r = Router();
  r.get('/api/finance/quickbooks/callback', async (req, res) => {
    const back = (q) => res.redirect(`/finance?tab=connections&${new URLSearchParams(q)}`);
    try {
      const state = verifyToken(String(req.query.state || ''), secret);
      if (!state || state.aud !== 'qbo-connect') return back({ qbo: 'error', message: 'The sign-in link expired — try again' });
      if (req.query.error) return back({ qbo: 'error', message: String(req.query.error_description || req.query.error).slice(0, 120) });
      const t = await qbo.exchange(String(req.query.code || ''), `${config.appUrl}/api/finance/quickbooks/callback`);
      const realmId = String(req.query.realmId || '');
      const company = await qbo.company({ realmId, accessToken: t.accessToken }).catch(() => ({ name: null }));
      const row = {
        realm_id: realmId, company_name: company.name, environment: qbo.environment, access_token: sealQbo(t.accessToken, secret), refresh_token: sealQbo(t.refreshToken, secret),
        expires_at: t.expiresAt, refresh_expires_at: t.refreshExpiresAt, status: 'active', error: null,
      };
      const have = await db.get('SELECT id FROM qbo_connections WHERE practice_id = ?', state.pid);
      if (have) await db.run(`UPDATE qbo_connections SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), have.id);
      else await insert(db, 'qbo_connections', { practice_id: state.pid, ...row, created_by: state.sub });
      await audit(db, { ip: req.ip, user: { practice_id: state.pid, id: state.sub } }, 'finance.qbo_connect', 'qbo_connections', null, { realm: realmId });
      await syncQbo(db, qbo, secret, state.pid).catch(failed(db, { practiceId: state.pid, kind: 'sync', key: 'qbo-sync', role: 'admin', title: 'QuickBooks couldn’t be synced' }));
      back({ qbo: 'connected' });
    } catch (err) {
      back({ qbo: 'error', message: String(err.message).slice(0, 120) });
    }
  });

  r.post('/api/webhooks/plaid', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    if (!plaid.enabled || !(await plaid.verifyWebhook(req.headers['plaid-verification'], req.body).catch(() => false))) return res.status(401).end();
    const body = JSON.parse(req.body.toString('utf8'));
    const conn = await db.get("SELECT * FROM bank_connections WHERE item_id = ? AND status != 'removed'", String(body.item_id || ''));
    if (conn && body.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(body.webhook_code)) {
      syncBank(db, plaid, secret, conn).catch(failed(db, { practiceId: conn.practice_id, kind: 'sync', key: `bank-sync:${conn.id}`, role: 'admin', title: 'The bank account couldn’t be synced' }));
    } else if (conn && body.webhook_type === 'ITEM' && ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(body.webhook_code)) {
      await db.run("UPDATE bank_connections SET status = 'relink', error = ? WHERE id = ?", String(body.error?.error_message || body.webhook_code).slice(0, 300), conn.id);
      await raiseIssue(db, { practiceId: conn.practice_id, kind: 'sync', key: `bank-sync:${conn.id}`, role: 'admin', severity: 'high', title: 'The bank connection needs to be signed in again (Finance → Connections)', detail: body.error?.error_message || body.webhook_code });
    }
    res.json({ ok: true });
  });
  return r;
}

// The regular run: every connected bank and QuickBooks company, then any deposits to send over.
export async function runFinanceSync(db, { plaid, qbo, secret }) {
  let n = 0;
  if (plaid.enabled) {
    for (const c of await db.all("SELECT * FROM bank_connections WHERE status IN ('active','error')")) {
      try {
        n += (await syncBank(db, plaid, secret, c)).added;
        await resolveIssue(db, c.practice_id, `bank-sync:${c.id}`);
      } catch (err) {
        await raiseIssue(db, { practiceId: c.practice_id, kind: 'sync', key: `bank-sync:${c.id}`, role: 'admin', title: 'The bank account couldn’t be synced', detail: err.message });
      }
    }
  }
  if (qbo.enabled) {
    for (const c of await db.all("SELECT practice_id FROM qbo_connections WHERE status = 'active'")) {
      try {
        await syncQbo(db, qbo, secret, c.practice_id);
        n += (await pushDeposits(db, qbo, secret, c.practice_id)).pushed;
        await resolveIssue(db, c.practice_id, 'qbo-sync');
      } catch (err) {
        await raiseIssue(db, { practiceId: c.practice_id, kind: 'sync', key: 'qbo-sync', role: 'admin', title: 'QuickBooks couldn’t be synced', detail: err.message });
      }
    }
  }
  return n;
}
