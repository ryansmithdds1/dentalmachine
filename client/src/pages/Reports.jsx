import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { money, label, todayLocal, shiftDate } from '../format.js';

export default function Reports() {
  const today = todayLocal();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const { data: prod } = useApi(`/reports/production?from=${from}&to=${to}`);
  const { data: aging } = useApi('/reports/aging');
  const maxDay = Math.max(1, ...(prod?.by_day || []).map((d) => Math.max(d.production, d.collections)));
  const total = (key) => (prod?.by_day || []).reduce((s, d) => s + d[key], 0);

  return (
    <>
      <div className="page-header">
        <h1>Reports</h1>
        <div className="actions">
          <button onClick={() => { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }}>MTD</button>
          <button onClick={() => { setFrom(shiftDate(today, -29)); setTo(today); }}>Last 30 days</button>
          <button onClick={() => { setFrom(`${today.slice(0, 4)}-01-01`); setTo(today); }}>YTD</button>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
          <span>to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        </div>
      </div>

      <div className="grid grid-4">
        <div className="card stat"><div className="label">Gross production</div><div className="value">{money(total('production'))}</div></div>
        <div className="card stat"><div className="label">Collections</div><div className="value">{money(total('collections'))}</div></div>
        <div className="card stat">
          <div className="label">Collection rate</div>
          <div className="value">{total('production') ? `${Math.round((total('collections') / total('production')) * 100)}%` : '—'}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Daily production vs. collections</h2>
        {!prod?.by_day.length ? <div className="muted">No activity in this range.</div> : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 180, overflowX: 'auto', paddingBottom: 4 }}>
            {prod.by_day.map((d) => (
              <div key={d.day} title={`${d.day}\nProduction ${money(d.production)}\nCollections ${money(d.collections)}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 22 }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 150 }}>
                  <div style={{ width: 8, height: `${(d.production / maxDay) * 100}%`, background: 'var(--primary)', borderRadius: '3px 3px 0 0' }} />
                  <div style={{ width: 8, height: `${(d.collections / maxDay) * 100}%`, background: '#94a3b8', borderRadius: '3px 3px 0 0' }} />
                </div>
                <div className="muted" style={{ fontSize: 10 }}>{d.day.slice(8)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="legend" style={{ justifyContent: 'flex-start' }}>
          <span><i style={{ background: 'var(--primary)' }} />Production</span>
          <span><i style={{ background: '#94a3b8' }} />Collections</span>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Production by provider</h2>
          <table>
            <thead><tr><th>Provider</th><th className="num">Procedures</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.by_provider.map((p) => <tr key={p.id}><td>{p.name}</td><td className="num">{p.procedures}</td><td className="num">{money(p.production)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <h2>Production by category</h2>
          <table>
            <thead><tr><th>Category</th><th className="num">Procedures</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.by_category.map((c) => <tr key={c.category}><td>{label(c.category)}</td><td className="num">{c.procedures}</td><td className="num">{money(c.production)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <h2>Top procedures</h2>
          <table>
            <thead><tr><th>Code</th><th>Description</th><th className="num">Count</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.top_procedures.map((p) => <tr key={p.code}><td>{p.code}</td><td>{p.description}</td><td className="num">{p.count}</td><td className="num">{money(p.production)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div style={{ padding: '14px 16px' }}>
          <h2 style={{ margin: 0 }}>Accounts receivable aging</h2>
          <div className="muted">As of {aging?.as_of}. Credits are applied to the oldest charges first.</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Patient</th><th>Phone</th><th className="num">0–30</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th><th className="num">Total</th></tr></thead>
            <tbody>
              {aging?.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/patients/${r.id}`}>{r.first_name} {r.last_name}</Link></td>
                  <td>{r.phone}</td>
                  <td className="num">{money(r.current)}</td><td className="num">{money(r.d31_60)}</td><td className="num">{money(r.d61_90)}</td><td className="num">{money(r.d90_plus)}</td>
                  <td className="num"><strong>{money(r.balance)}</strong></td>
                </tr>
              ))}
              {aging && (
                <tr className="totals-row">
                  <td colSpan={2}>Total ({aging.rows.length} accounts)</td>
                  <td className="num">{money(aging.totals.current)}</td><td className="num">{money(aging.totals.d31_60)}</td><td className="num">{money(aging.totals.d61_90)}</td><td className="num">{money(aging.totals.d90_plus)}</td>
                  <td className="num">{money(aging.totals.total)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
