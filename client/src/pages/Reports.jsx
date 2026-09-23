import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Analytics from '../components/Analytics.jsx';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, label, practiceToday, shiftDate } from '../format.js';
import { downloadCsv, dollars } from '../api.js';

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'kpis';
  return (
    <>
      <div className="page-header"><h1>Reports</h1></div>
      <div className="tabs">
        <button className={tab === 'kpis' ? 'active' : ''} onClick={() => setParams({ tab: 'kpis' })}>Practice KPIs</button>
        <button className={tab === 'ops' ? 'active' : ''} onClick={() => setParams({ tab: 'ops' })}>Day sheet, production & A/R</button>
      </div>
      {tab === 'kpis' ? <Analytics /> : <Operational />}
    </>
  );
}

function Operational() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const { data: prod } = useApi(`/reports/production?from=${from}&to=${to}`);
  const [agingGroup, setAgingGroup] = useState('patient');
  const [asOf, setAsOf] = useState('');
  const { data: aging } = useApi(`/reports/aging?group=${agingGroup}${asOf ? `&as_of=${asOf}` : ''}`);
  const { data: byProv } = useApi(`/reports/collections-by-provider?from=${from}&to=${to}`);
  const { data: adj } = useApi(`/reports/adjustments?from=${from}&to=${to}`);
  const [sheetDate, setSheetDate] = useState(today);
  const { data: sheet } = useApi(`/reports/daysheet?date=${sheetDate}`);
  const maxDay = Math.max(1, ...(prod?.by_day || []).map((d) => Math.max(d.production, d.collections)));
  const total = (key) => (prod?.by_day || []).reduce((s, d) => s + d[key], 0);

  return (
    <>
      <DaySheet sheet={sheet} date={sheetDate} setDate={setSheetDate} />

      <div className="page-header" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0 }}>Production & collections</h2>
        <div className="actions">
          <button onClick={() => { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }}>MTD</button>
          <button onClick={() => { setFrom(shiftDate(today, -29)); setTo(today); }}>Last 30 days</button>
          <button onClick={() => { setFrom(`${today.slice(0, 4)}-01-01`); setTo(today); }}>YTD</button>
          <button className="no-print" onClick={() => window.print()} title="Print, or choose “Save as PDF” in the print dialog">Print / PDF</button>
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
        <TitleRow title="Daily production vs. collections">
          <CsvButton name={`production-by-day-${from}-to-${to}`} rows={prod?.by_day} columns={[['Date', (d) => d.day], ['Production', (d) => dollars(d.production)], ['Collections', (d) => dollars(d.collections)]]} />
        </TitleRow>
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
          <TitleRow title="Production by provider"><CsvButton name={`production-by-provider-${from}-to-${to}`} rows={prod?.by_provider} columns={[['Provider', (p) => p.name], ['Procedures', (p) => p.procedures], ['Production', (p) => dollars(p.production)]]} /></TitleRow>
          <table>
            <thead><tr><th>Provider</th><th className="num">Procedures</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.by_provider.map((p) => <tr key={p.id}><td>{p.name}</td><td className="num">{p.procedures}</td><td className="num">{money(p.production)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <TitleRow title="Production by category"><CsvButton name={`production-by-category-${from}-to-${to}`} rows={prod?.by_category} columns={[['Category', (c) => label(c.category)], ['Procedures', (c) => c.procedures], ['Production', (c) => dollars(c.production)]]} /></TitleRow>
          <table>
            <thead><tr><th>Category</th><th className="num">Procedures</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.by_category.map((c) => <tr key={c.category}><td>{label(c.category)}</td><td className="num">{c.procedures}</td><td className="num">{money(c.production)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <TitleRow title="Top procedures"><CsvButton name={`top-procedures-${from}-to-${to}`} rows={prod?.top_procedures} columns={[['Code', (p) => p.code], ['Description', (p) => p.description], ['Count', (p) => p.count], ['Production', (p) => dollars(p.production)]]} /></TitleRow>
          <table>
            <thead><tr><th>Code</th><th>Description</th><th className="num">Count</th><th className="num">Production</th></tr></thead>
            <tbody>{prod?.top_procedures.map((p) => <tr key={p.code}><td>{p.code}</td><td>{p.description}</td><td className="num">{p.count}</td><td className="num">{money(p.production)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <TitleRow title="Collections by provider">
            <CsvButton name={`collections-by-provider-${from}-to-${to}`} rows={byProv?.rows} columns={[['Provider', (r) => r.name], ['Production', (r) => dollars(r.production)], ['Adjustments', (r) => dollars(r.adjustments)], ['Net production', (r) => dollars(r.net_production)], ['Patient payments', (r) => dollars(r.patient_collections)], ['Insurance payments', (r) => dollars(r.insurance_collections)], ['Collections', (r) => dollars(r.collections)]]} />
          </TitleRow>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>Payments are credited to the provider whose work they paid for (insurance by the procedures on the claim; patient payments oldest charge first).</div>
          <table>
            <thead><tr><th>Provider</th><th className="num">Net production</th><th className="num">Collections</th><th className="num">Rate</th></tr></thead>
            <tbody>
              {byProv?.rows.map((r) => (
                <tr key={r.id ?? 'none'}>
                  <td>{r.name}</td>
                  <td className="num">{money(r.net_production)}</td>
                  <td className="num" title={`Patients ${money(r.patient_collections)} · Insurance ${money(r.insurance_collections)}`}>{money(r.collections)}</td>
                  <td className="num">{r.net_production > 0 ? `${Math.round((r.collections / r.net_production) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <TitleRow title="Adjustments by type"><CsvButton name={`adjustments-${from}-to-${to}`} rows={adj?.rows} columns={[['Type', (r) => r.type], ['Count', (r) => r.count], ['Amount', (r) => dollars(r.amount)]]} /></TitleRow>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Type</th><th className="num">Count</th><th className="num">Amount</th></tr></thead>
            <tbody>{adj?.rows.map((r) => <tr key={r.type}><td>{r.type}</td><td className="num">{r.count}</td><td className="num">{money(r.amount)}</td></tr>)}</tbody>
          </table>
          {adj?.rows.length === 0 && <div className="muted">No adjustments in this range.</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div style={{ padding: '14px 16px' }}>
          <TitleRow title="Accounts receivable aging">
            <div className="seg no-print">
              <button className={agingGroup === 'patient' ? 'active' : ''} onClick={() => setAgingGroup('patient')}>By patient</button>
              <button className={agingGroup === 'family' ? 'active' : ''} onClick={() => setAgingGroup('family')}>By family</button>
            </div>
            <input type="date" className="no-print" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} title="As of (leave blank for today)" style={{ width: 150 }} />
            <CsvButton name={`ar-aging-${aging?.as_of}`} rows={aging?.rows} columns={[['Patient #', (r) => r.id], ['First name', (r) => r.first_name], ['Last name', (r) => r.last_name], ['Phone', (r) => r.phone], ['0-30', (r) => dollars(r.current)], ['31-60', (r) => dollars(r.d31_60)], ['61-90', (r) => dollars(r.d61_90)], ['90+', (r) => dollars(r.d90_plus)], ['Total', (r) => dollars(r.balance)], ['Insurance pending', (r) => dollars(r.insurance_pending)], ['Patient owes', (r) => dollars(r.patient_portion)]]} />
            <button className="small no-print" onClick={() => window.print()}>Print / PDF</button>
          </TitleRow>
          <div className="muted">As of {aging?.as_of}. Payments and credits are applied to the oldest charges first.</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{agingGroup === 'family' ? 'Account (head of household)' : 'Patient'}</th><th>Phone</th><th className="num">0–30</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th><th className="num">Total</th><th className="num">Insurance pending</th><th className="num">Patient owes</th></tr></thead>
            <tbody>
              {aging?.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/patients/${r.id}`}>{r.first_name} {r.last_name}</Link></td>
                  <td>{r.phone}</td>
                  <td className="num">{money(r.current)}</td><td className="num">{money(r.d31_60)}</td><td className="num">{money(r.d61_90)}</td><td className="num">{money(r.d90_plus)}</td>
                  <td className="num"><strong>{money(r.balance)}</strong></td>
                  <td className="num muted">{money(r.insurance_pending)}</td>
                  <td className="num">{money(r.patient_portion)}</td>
                </tr>
              ))}
              {aging && (
                <tr className="totals-row">
                  <td colSpan={2}>Total ({aging.rows.length} accounts)</td>
                  <td className="num">{money(aging.totals.current)}</td><td className="num">{money(aging.totals.d31_60)}</td><td className="num">{money(aging.totals.d61_90)}</td><td className="num">{money(aging.totals.d90_plus)}</td>
                  <td className="num">{money(aging.totals.total)}</td>
                  <td className="num">{money(aging.totals.insurance_pending)}</td>
                  <td className="num">{money(aging.totals.patient_portion)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {aging?.credits?.length > 0 && (
          <details style={{ padding: '0 16px 14px' }}>
            <summary>{aging.credits.length} account{aging.credits.length === 1 ? '' : 's'} in credit ({money(aging.totals.credits)}) — refund or apply</summary>
            <table style={{ marginTop: 8 }}>
              <tbody>{aging.credits.map((c) => <tr key={c.id}><td><Link to={`/patients/${c.id}`}>{c.first_name} {c.last_name}</Link></td><td>{c.phone}</td><td className="num">{money(c.credit)}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>
    </>
  );
}

function DaySheet({ sheet, date, setDate }) {
  const t = sheet?.totals;
  const deposit = Object.entries(sheet?.deposit || {});
  const depositTotal = deposit.reduce((s, [, v]) => s + v, 0);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Day sheet</h2>
          <div className="muted">End-of-day close-out: production, payments and the bank deposit.</div>
        </div>
        <div className="actions no-print">
          <button onClick={() => setDate(shiftDate(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160 }} />
          <button onClick={() => setDate(shiftDate(date, 1))}>→</button>
          <button onClick={() => window.print()}>Print / PDF</button>
          <CsvButton name={`day-sheet-${date}`} rows={sheet?.entries} columns={[['Date', (e) => e.entry_date], ['Type', (e) => label(e.type)], ['Patient', (e) => `${e.first_name} ${e.last_name}`], ['Description', (e) => e.description], ['Method', (e) => e.method || ''], ['Reference', (e) => e.reference || ''], ['Provider / by', (e) => e.provider_name || e.created_by_name || 'Online'], ['Amount', (e) => dollars(e.amount)]]} />
        </div>
      </div>
      {t && (
        <div className="grid grid-2">
          <div>
            <table>
              <tbody>
                <tr><td>Production</td><td className="num">{money(t.production)}</td></tr>
                <tr><td>Patient payments</td><td className="num">{money(t.patient_payments)}</td></tr>
                <tr><td>Insurance payments</td><td className="num">{money(t.insurance_payments)}</td></tr>
                <tr><td>Adjustments</td><td className="num">{money(t.adjustments)}</td></tr>
                <tr><td>Refunds</td><td className="num">{money(t.refunds)}</td></tr>
              </tbody>
            </table>
            <div className="muted" style={{ marginTop: 10 }}>
              Appointments: {Object.entries(sheet.appointments).map(([k, v]) => `${v} ${label(k).toLowerCase()}`).join(' · ') || 'none'}
            </div>
          </div>
          <div>
            <h3>Deposit</h3>
            <table>
              <tbody>
                {deposit.map(([k, v]) => <tr key={k}><td>{label(k)}</td><td className="num">{money(v)}</td></tr>)}
                <tr className="totals-row"><td>Total collected</td><td className="num">{money(depositTotal)}</td></tr>
              </tbody>
            </table>
            {!deposit.length && <div className="muted">No payments posted.</div>}
          </div>
        </div>
      )}
      {sheet?.entries.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>All {sheet.entries.length} transactions</summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Type</th><th>Patient</th><th>Description</th><th>Provider / by</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {sheet.entries.map((e) => (
                <tr key={e.id}>
                  <td>{label(e.type)}</td>
                  <td><Link to={`/patients/${e.patient_id}`}>{e.first_name} {e.last_name}</Link></td>
                  <td>{e.description}</td>
                  <td className="muted">{e.provider_name || e.created_by_name || 'Online'}</td>
                  <td className="num">{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// Spreadsheet export for a report table; money columns are in dollars.
function CsvButton({ name, rows, columns }) {
  return <button className="small no-print" disabled={!rows?.length} onClick={() => downloadCsv(name, rows, columns)} title="Download as a spreadsheet (CSV)">⬇ CSV</button>;
}
const TitleRow = ({ title, children }) => (
  <div className="inline" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{title}</h2><span className="inline">{children}</span></div>
);
