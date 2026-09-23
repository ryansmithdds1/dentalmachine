import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';

// The business side: what the practice really costs to run and earns (the schedule and ledger next to the
// bank and QuickBooks), deposits matched to the bank, the bank's lines by category, and the connections.
const TABS = [['overview', 'Profit & costs'], ['deposits', 'Deposits'], ['bank', 'Bank activity'], ['connections', 'Connections']];
const pct = (n) => (n == null ? '—' : `${n}%`);
const cents = (n) => (n == null ? '—' : money(n));
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

export default function Finance() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const { data: status, reload } = useApi('/finance/status');
  const connected = status && (status.connections.length > 0 || status.qbo);
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Finance</h1>
          <div className="muted">Your bank and QuickBooks next to the schedule and ledger: true costs, profit per visit and chair hour, and every deposit matched. Patient information never leaves Dental Machine.</div>
        </div>
      </div>
      <div className="tabs">
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {status && !connected && tab !== 'connections' && (
        <div className="public-notice" style={{ marginBottom: 12 }}>
          Connect your business bank account (and QuickBooks, if you use it) to see costs and match deposits. <button className="link" onClick={() => setParams({ tab: 'connections' })}>Connect now →</button>
        </div>
      )}
      {tab === 'overview' && <Overview />}
      {tab === 'deposits' && <Deposits />}
      {tab === 'bank' && status && <Bank categories={status.categories} />}
      {tab === 'connections' && status && <Connections status={status} reload={reload} notice={params.get('qbo')} message={params.get('message')} />}
    </>
  );
}

function Overview() {
  const [months, setMonths] = useState(12);
  const { data, error } = useApi(`/finance/overview?months=${months}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const s = data.summary;
  // Months before there was anything to show are left off.
  const firstUsed = data.months.findIndex((m) => m.production || m.collections || m.source);
  const shown = firstUsed < 0 ? [] : data.months.slice(firstUsed);
  const maxPct = Math.max(12, ...data.categories.map((c) => Math.max(c.pct || 0, c.typical?.[1] || 0)));
  return (
    <>
      <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="muted">{s.months ? `Last ${s.months} full month${s.months === 1 ? '' : 's'} with costs` : 'No months with costs yet'}</div>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={6}>6 months</option><option value={12}>12 months</option><option value={24}>24 months</option></select>
      </div>
      <div className="stat-strip">
        <div><strong>{cents(s.collections)}</strong><span>collected · {pct(s.collection_pct)} of net production</span></div>
        <div><strong>{pct(s.overhead_pct)}</strong><span>overhead (typical {s.typical_overhead[0]}–{s.typical_overhead[1]}%)</span></div>
        <div><strong>{cents(s.profit)}</strong><span>left after all costs · {pct(s.profit_pct)}</span></div>
        <div><strong>{cents(s.cost_per_visit)}</strong><span>overhead per visit</span></div>
        <div><strong>{cents(s.cost_per_chair_hour)}</strong><span>overhead per chair hour</span></div>
        <div><strong>{cents(s.profit_per_chair_hour)}</strong><span>profit per chair hour</span></div>
        <div><strong>{cents(s.break_even_per_day)}</strong><span>to break even each clinic day</span></div>
      </div>
      {data.insights.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Worth a look</h2>
          {data.insights.map((i) => <div key={i.text} className={i.tone === 'warn' ? 'text-warn' : ''} style={{ padding: '4px 0' }}>{i.tone === 'warn' ? '⚠︎ ' : 'ℹ︎ '}{i.text}</div>)}
        </div>
      )}
      <div className="card" style={{ marginTop: 12 }}>
        <h2>Where the money goes</h2>
        <p className="muted" style={{ fontSize: 13 }}>Each cost as a share of collections, with the range typical for a general practice (the shaded band).</p>
        <table className="compact-table">
          <thead><tr><th>Category</th><th className="num">Amount</th><th className="num">% of collections</th><th style={{ width: '40%' }} /></tr></thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.key}>
                <td>{c.label}{!c.overhead && <span className="muted" style={{ fontSize: 11 }}> · not overhead</span>}</td>
                <td className="num">{money(c.amount)}</td>
                <td className={`num ${c.status === 'high' ? 'text-danger' : ''}`}>{pct(c.pct)}{c.typical && <div className="muted" style={{ fontSize: 11 }}>typical {c.typical[0]}–{c.typical[1]}%</div>}</td>
                <td>
                  <div className="range-bar">
                    {c.typical && <span className="band" style={{ left: `${(c.typical[0] / maxPct) * 100}%`, width: `${((c.typical[1] - c.typical[0]) / maxPct) * 100}%` }} />}
                    <i className={c.status || ''} style={{ width: `${Math.min(100, ((c.pct || 0) / maxPct) * 100)}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ marginTop: 12, padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Month</th><th className="num">Production</th><th className="num">Collected</th><th className="num">Reached bank</th><th className="num">Overhead</th><th className="num">Overhead %</th><th className="num">Profit</th><th className="num">Visits</th><th className="num">Per visit</th><th className="num">Per chair hr</th><th>Costs from</th></tr>
            </thead>
            <tbody>
              {[...shown].reverse().map((m) => (
                <tr key={m.month} className={m.partial ? 'muted' : ''}>
                  <td>{monthName(m.month)}{m.partial ? ' (so far)' : ''}</td>
                  <td className="num">{money(m.production)}</td>
                  <td className="num">{money(m.collections)}</td>
                  <td className="num">{m.deposited ? money(m.deposited) : '—'}</td>
                  <td className="num">{m.source ? money(m.overhead) : '—'}</td>
                  <td className="num">{pct(m.overhead_pct)}</td>
                  <td className={`num ${m.profit < 0 ? 'text-danger' : ''}`}>{cents(m.profit)}</td>
                  <td className="num">{m.visits}</td>
                  <td className="num">{cents(m.cost_per_visit)}</td>
                  <td className="num">{cents(m.cost_per_chair_hour)}</td>
                  <td className="muted">{m.source === 'quickbooks' ? 'QuickBooks' : m.source === 'bank' ? 'Bank' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Deposits() {
  const { can } = useAuth();
  const { data, reload, error } = useApi('/finance/matching?days=90');
  const [picking, setPicking] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [err, setErr] = useState(null);
  const run = async (fn) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e);
    }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const fees = data.matched.reduce((s, m) => s + (m.match_fee > 0 && m.match_kind !== 'deposit' ? m.match_fee : 0), 0);
  const writable = can('finance:write');
  return (
    <>
      <ErrorBox error={err} />
      <div className="stat-strip">
        <div><strong>{data.matched.length}</strong><span>deposits matched (90 days)</span></div>
        <div><strong>{data.open.length}</strong><span>bank deposits waiting for a match</span></div>
        <div><strong className={data.missing.length ? 'text-danger' : ''}>{money(data.missing.reduce((s, m) => s + m.amount, 0))}</strong><span>recorded but not in the bank yet ({data.missing.length})</span></div>
        <div><strong>{money(fees)}</strong><span>kept by card processors</span></div>
      </div>
      {writable && <div style={{ margin: '8px 0' }}><button className="small" onClick={() => run(() => api.post('/finance/matching/auto'))}>Match what&apos;s certain</button></div>}

      <div className="card" style={{ padding: 0, marginTop: 8 }}>
        <h2 style={{ padding: '14px 16px 0' }}>Waiting for a match</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Bank date</th><th>Bank says</th><th className="num">Amount</th><th>Could be</th></tr></thead>
            <tbody>
              {data.open.map((o) => (
                <tr key={o.id}>
                  <td>{fmtDate(o.date)}</td>
                  <td style={{ maxWidth: 260 }}>{o.description}</td>
                  <td className="num">{money(o.amount)}</td>
                  <td>
                    {o.suggestions.map((s) => (
                      <div key={s.keys.join()} className="inline" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>{s.labels.join(' + ')}{s.fee > 0 && <span className="muted"> · {money(s.fee)} fees</span>}{s.fee < 0 && <span className="text-danger"> · {money(-s.fee)} more than recorded</span>}</span>
                        {writable && <button className="small primary" onClick={() => run(() => api.post(`/finance/bank/transactions/${o.id}/match`, { keys: s.keys }))}>Match</button>}
                      </div>
                    ))}
                    {!o.suggestions.length && <span className="muted">Nothing recorded fits.</span>}
                    {writable && <button className="link" style={{ fontSize: 12 }} onClick={() => { setPicking(o); setChosen([]); }}>Choose…</button>}
                    {writable && <button className="link" style={{ fontSize: 12, marginLeft: 10 }} onClick={() => run(() => api.put(`/finance/bank/transactions/${o.id}`, { ignored: true }))}>Not a patient deposit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.open.length === 0 && <div className="empty">Every bank deposit is matched. 🎉</div>}
        </div>
      </div>

      {picking && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>What was the {money(picking.amount)} deposit on {fmtDate(picking.date)}?</h2>
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            {data.expected.filter((e) => Math.abs(Date.parse(e.date) - Date.parse(picking.date)) < 21 * 86400_000).map((e) => (
              <label key={e.key} className="checkbox">
                <input type="checkbox" checked={chosen.includes(e.key)} onChange={(ev) => setChosen(ev.target.checked ? [...chosen, e.key] : chosen.filter((k) => k !== e.key))} />
                {fmtDate(e.date)} · {e.label} · {money(e.amount)}
              </label>
            ))}
          </div>
          <div className="inline" style={{ marginTop: 8, alignItems: 'center' }}>
            <span className="muted">Chosen: {money(data.expected.filter((e) => chosen.includes(e.key)).reduce((s, e) => s + e.amount, 0))} of {money(picking.amount)}</span>
            <button className="primary small" disabled={!chosen.length} onClick={() => run(async () => { await api.post(`/finance/bank/transactions/${picking.id}/match`, { keys: chosen }); setPicking(null); })}>Match</button>
            <button className="small" onClick={() => setPicking(null)}>Cancel</button>
          </div>
        </div>
      )}

      {data.missing.length > 0 && (
        <div className="card" style={{ padding: 0, marginTop: 12 }}>
          <h2 style={{ padding: '14px 16px 0' }}>Recorded here, not in the bank</h2>
          <p className="muted" style={{ padding: '0 16px', fontSize: 13 }}>Taken more than 5 days ago with no matching bank deposit: a slip not taken to the bank, a payout that failed, or a payment keyed wrong.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>What</th><th className="num">Amount</th></tr></thead>
              <tbody>{data.missing.map((m) => <tr key={m.key}><td>{fmtDate(m.date)}</td><td>{m.label}</td><td className="num">{money(m.amount)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, marginTop: 12 }}>
        <h2 style={{ padding: '14px 16px 0' }}>Matched</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Bank date</th><th>Bank says</th><th className="num">Deposited</th><th className="num">Recorded</th><th className="num">Fees / difference</th><th /></tr></thead>
            <tbody>
              {data.matched.map((m) => (
                <tr key={m.id}>
                  <td>{fmtDate(m.date)}</td>
                  <td style={{ maxWidth: 280 }}>{m.description}<div className="muted" style={{ fontSize: 11 }}>{m.match_status === 'auto' ? 'Matched automatically' : 'Matched by hand'}{m.qbo_id ? ' · in QuickBooks' : ''}</div></td>
                  <td className="num">{money(m.amount)}</td>
                  <td className="num">{money(m.match_amount)}</td>
                  <td className={`num ${m.match_fee < 0 || (m.match_kind === 'deposit' && m.match_fee) ? 'text-danger' : ''}`}>{m.match_fee ? money(m.match_fee) : '—'}</td>
                  <td>{writable && !m.qbo_id && <button className="small" onClick={() => run(() => api.del(`/finance/bank/transactions/${m.id}/match`))}>Undo</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Bank({ categories }) {
  const { can } = useAuth();
  const [filter, setFilter] = useState({ direction: '', category: '', q: '' });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const { data, reload } = useApi(`/finance/bank/transactions?${qs}`);
  const [err, setErr] = useState(null);
  const label = Object.fromEntries(categories.map((c) => [c.key, c.label]));
  const setCategory = async (t, category) => {
    setErr(null);
    const who = t.merchant || t.description;
    const remember = window.confirm(`File every line from “${who}” under ${label[category]} from now on?\n\nOK = all of them · Cancel = just this one`);
    try {
      await api.put(`/finance/bank/transactions/${t.id}`, { category, remember, pattern: t.merchant || undefined });
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const totals = (data || []).filter((t) => !t.ignored).reduce((s, t) => ({ in: s.in + Math.max(0, t.amount), out: s.out + Math.max(0, -t.amount) }), { in: 0, out: 0 });
  return (
    <>
      <ErrorBox error={err} />
      <div className="inline" style={{ marginBottom: 8, alignItems: 'center' }}>
        <select value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value })}><option value="">In and out</option><option value="in">Money in</option><option value="out">Money out</option></select>
        <select value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })}><option value="">All categories</option>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        <input placeholder="Search" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ width: 180 }} />
        <span className="muted">Last 60 days · in {money(totals.in)} · out {money(totals.out)}</span>
        {can('finance:write') && <button className="small" onClick={async () => { await api.post('/finance/bank/sync'); reload(); }}>Refresh from bank</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Description</th><th>Account</th><th className="num">Amount</th><th>Category</th><th /></tr></thead>
            <tbody>
              {(data || []).map((t) => (
                <tr key={t.id} className={t.ignored ? 'muted' : ''}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}{t.pending ? <div className="muted" style={{ fontSize: 11 }}>pending</div> : null}</td>
                  <td style={{ maxWidth: 320 }}>{t.merchant || t.description}{t.merchant && <div className="muted" style={{ fontSize: 11 }}>{t.description}</div>}{t.match_kind && <div style={{ fontSize: 11 }}><span className="badge ok">Matched deposit</span></div>}</td>
                  <td className="muted">{t.account_name} ••{t.account_mask}</td>
                  <td className={`num ${t.amount > 0 ? 'text-ok' : ''}`}>{money(t.amount)}</td>
                  <td>
                    {can('finance:write')
                      ? <select value={t.category || 'other'} onChange={(e) => setCategory(t, e.target.value)} aria-label="Category">{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
                      : label[t.category] || t.category}
                  </td>
                  <td>{can('finance:write') && <button className="small" title={t.ignored ? 'Count it again' : 'Leave out of the numbers'} onClick={async () => { await api.put(`/finance/bank/transactions/${t.id}`, { ignored: !t.ignored }); reload(); }}>{t.ignored ? 'Include' : 'Leave out'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.length === 0 && <div className="empty">No bank activity yet.</div>}
        </div>
      </div>
    </>
  );
}

// Plaid Link runs from Plaid's own script; the sandbox skips it.
const loadPlaid = () => new Promise((resolve, reject) => {
  if (window.Plaid) return resolve(window.Plaid);
  const s = document.createElement('script');
  s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  s.onload = () => resolve(window.Plaid);
  s.onerror = () => reject(new Error('Could not load Plaid'));
  document.head.appendChild(s);
});

function Connections({ status, reload, notice, message }) {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(notice === 'connected' ? 'QuickBooks is connected.' : null);
  useEffect(() => { if (notice === 'error') setErr(new Error(message || 'QuickBooks didn’t connect')); }, [notice, message]);
  const act = async (fn, done) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await fn();
      if (done) setInfo(done(out));
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const connectBank = (connectionId) => act(async () => {
    const { link_token: token, mode } = await api.post('/finance/plaid/link-token', connectionId ? { connection_id: connectionId } : {});
    if (mode === 'sandbox') return api.post('/finance/plaid/exchange', { public_token: 'public-sandbox-demo', institution: 'Demo Bank (sandbox)' });
    const Plaid = await loadPlaid();
    const result = await new Promise((resolve, reject) => {
      Plaid.create({
        token,
        onSuccess: (publicToken, meta) => resolve({ publicToken, institution: meta?.institution?.name }),
        onExit: (e) => (e ? reject(new Error(e.display_message || e.error_message || 'Bank connection cancelled')) : resolve(null)),
      }).open();
    });
    if (!result || connectionId) return null;
    return api.post('/finance/plaid/exchange', { public_token: result.publicToken, institution: result.institution });
  }, (out) => (out ? `Connected. ${out.added} bank lines in, ${out.matched} deposits matched.` : null));
  const q = status.qbo;
  const s = q?.settings || {};
  const accts = status.qbo_accounts;
  const saveQbo = (patch) => act(() => api.put('/finance/quickbooks/settings', { ...s, ...patch }));
  const expenseCats = status.categories.filter((c) => c.expense);
  return (
    <>
      <ErrorBox error={err} />
      {info && <div className="public-notice ok" style={{ marginBottom: 12 }}>{info}</div>}
      <div className="grid grid-2">
        <div className="card">
          <h2>Bank accounts</h2>
          <p className="muted" style={{ fontSize: 13 }}>Connect the practice&apos;s business checking and cards through Plaid (read-only). New lines come in several times a day; deposits are matched to what you recorded.</p>
          {!status.plaid.enabled && <p className="muted">Not set up on this server (PLAID_CLIENT_ID and PLAID_SECRET).</p>}
          {status.connections.map((c) => (
            <div key={c.id} className="card" style={{ margin: '8px 0', padding: 12 }}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{c.institution || 'Bank'}</strong>
                <span className={`badge ${c.status === 'active' ? 'ok' : 'warn'}`}>{c.status === 'relink' ? 'Needs sign-in again' : c.status}</span>
              </div>
              {c.error && <div className="text-danger" style={{ fontSize: 12 }}>{c.error}</div>}
              <div className="muted" style={{ fontSize: 12 }}>Last update {c.last_synced_at ? fmtDate(c.last_synced_at) : 'never'}</div>
              {status.accounts.filter((a) => a.connection_id === c.id).map((a) => (
                <div key={a.id} className="inline" style={{ justifyContent: 'space-between', fontSize: 13, marginTop: 6 }}>
                  <span>{a.name} ••{a.mask} · {money(a.current_balance)}</span>
                  {admin && <label className="checkbox" style={{ margin: 0 }}><input type="checkbox" checked={!!a.deposits_here} onChange={(e) => act(() => api.put(`/finance/bank/accounts/${a.id}`, { deposits_here: e.target.checked }))} /> deposits go here</label>}
                </div>
              ))}
              {admin && (
                <div className="inline" style={{ marginTop: 8 }}>
                  <button className="small" disabled={busy} onClick={() => act(() => api.post('/finance/bank/sync'), () => 'Updated from the bank.')}>Update now</button>
                  {c.status === 'relink' && <button className="small primary" disabled={busy} onClick={() => connectBank(c.id)}>Sign in again</button>}
                  <button className="small" disabled={busy} onClick={() => window.confirm('Disconnect this bank? Lines already in stay for your numbers.') && act(() => api.del(`/finance/bank/connections/${c.id}`))}>Disconnect</button>
                </div>
              )}
            </div>
          ))}
          {admin && status.plaid.enabled && <button className="primary" disabled={busy} onClick={() => connectBank()}>+ Connect a bank account{status.plaid.mode === 'sandbox' ? ' (sandbox)' : ''}</button>}
        </div>

        <div className="card">
          <h2>QuickBooks Online</h2>
          <p className="muted" style={{ fontSize: 13 }}>Your chart of accounts and monthly profit and loss come in for the numbers. Optionally, matched deposits go to QuickBooks as totals — no patient names.</p>
          {!status.quickbooks.enabled && <p className="muted">Not set up on this server (QBO_CLIENT_ID and QBO_CLIENT_SECRET).</p>}
          {q ? (
            <>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{q.company_name || `Company ${q.realm_id}`}</strong>
                <span className={`badge ${q.status === 'active' ? 'ok' : 'warn'}`}>{q.status === 'reconnect' ? 'Needs sign-in again' : q.status}</span>
              </div>
              {q.error && <div className="text-danger" style={{ fontSize: 12 }}>{q.error}</div>}
              <div className="muted" style={{ fontSize: 12 }}>Last update {q.last_synced_at ? fmtDate(q.last_synced_at) : 'never'}</div>
              {admin && (
                <>
                  <h3 style={{ marginTop: 14 }}>Send deposits to QuickBooks</h3>
                  <label className="checkbox"><input type="checkbox" checked={!!s.push_deposits} onChange={(e) => saveQbo({ push_deposits: e.target.checked })} /> Send matched deposits (leave off if QuickBooks&apos; bank feed already brings them in)</label>
                  <div className="form-grid">
                    {[['bank_account_id', 'Into bank account', (a) => a.type === 'Bank'], ['income_account_id', 'As income', (a) => /Income/.test(a.type)], ['fees_account_id', 'Card fees to', (a) => /Expense/.test(a.type)]].map(([k, l, f]) => (
                      <label key={k}>{l}
                        <select value={s[k] || ''} onChange={(e) => saveQbo({ [k]: e.target.value || null })}>
                          <option value="">—</option>{accts.filter(f).map((a) => <option key={a.qbo_id} value={a.qbo_id}>{a.full_name || a.name}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </>
              )}
              <div className="inline" style={{ marginTop: 10 }}>
                <button className="small" disabled={busy} onClick={() => act(() => api.post('/finance/quickbooks/sync'), (o) => `Updated: ${o.accounts} accounts.`)}>Update now</button>
                {s.push_deposits && <button className="small" disabled={busy} onClick={() => act(() => api.post('/finance/quickbooks/push'), (o) => `${o.pushed} deposits sent.`)}>Send deposits now</button>}
                {admin && q.status === 'reconnect' && <button className="small primary" onClick={async () => { window.location.href = (await api.get('/finance/quickbooks/connect')).url; }}>Sign in again</button>}
                {admin && <button className="small" disabled={busy} onClick={() => window.confirm('Disconnect QuickBooks?') && act(() => api.del('/finance/quickbooks'))}>Disconnect</button>}
              </div>
            </>
          ) : admin && status.quickbooks.enabled && (
            <button className="primary" onClick={async () => { window.location.href = (await api.get('/finance/quickbooks/connect')).url; }}>Connect QuickBooks{status.quickbooks.mode === 'sandbox' ? ' (sandbox)' : ''}</button>
          )}
        </div>
      </div>

      {accts.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>QuickBooks accounts → categories</h2>
          <p className="muted" style={{ fontSize: 13 }}>How each expense account counts in your numbers. Sorted automatically; change any that are wrong.</p>
          <table className="compact-table">
            <thead><tr><th>Account</th><th>Type</th><th>Counts as</th></tr></thead>
            <tbody>
              {accts.filter((a) => /Expense|Cost of Goods/.test(a.type)).map((a) => (
                <tr key={a.id}>
                  <td>{a.full_name || a.name}</td><td className="muted">{a.type}</td>
                  <td>
                    <select value={a.category || 'other'} onChange={(e) => act(() => api.put(`/finance/quickbooks/accounts/${a.id}`, { category: e.target.value }))}>
                      {expenseCats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                    {a.category_source === 'user' && <span className="muted" style={{ fontSize: 11 }}> · set by you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Rules />
    </>
  );
}

function Rules() {
  const { data, reload } = useApi('/finance/rules');
  if (!data?.length) return null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2>Your bank rules</h2>
      <table className="compact-table">
        <thead><tr><th>Lines containing</th><th>Go under</th><th /></tr></thead>
        <tbody>{data.map((r) => <tr key={r.id}><td>{r.pattern}</td><td>{r.category}</td><td><button className="small" onClick={async () => { await api.del(`/finance/rules/${r.id}`); reload(); }}>Remove</button></td></tr>)}</tbody>
      </table>
    </div>
  );
}
