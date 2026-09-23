import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Analytics from '../components/Analytics.jsx';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, label, practiceToday, shiftDate } from '../format.js';
import { MembershipReport } from '../components/Memberships.jsx';
import ReviewReport from '../components/ReviewReport.jsx';
import CloseBooks from '../components/CloseBooks.jsx';
import SavedReports from '../components/SavedReports.jsx';
import ReportBuilder from '../components/ReportBuilder.jsx';
import { downloadCsv, dollars, getLocationId } from '../api.js';
import { ProviderSelect, CsvButton, PrintButton } from '../components/ReportControls.jsx';

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'kpis';
  return (
    <>
      <div className="page-header"><h1>Reports</h1></div>
      <div className="tabs">
        <button className={tab === 'kpis' ? 'active' : ''} onClick={() => setParams({ tab: 'kpis' })}>Practice KPIs</button>
        <button className={tab === 'ops' ? 'active' : ''} onClick={() => setParams({ tab: 'ops' })}>Day sheet, production & A/R</button>
        <button className={tab === 'referrals' ? 'active' : ''} onClick={() => setParams({ tab: 'referrals' })}>Referrals</button>
        <button className={tab === 'memberships' ? 'active' : ''} onClick={() => setParams({ tab: 'memberships' })}>Memberships</button>
        <button className={tab === 'reviews' ? 'active' : ''} onClick={() => setParams({ tab: 'reviews' })}>Reviews</button>
        <button className={tab === 'hygiene' ? 'active' : ''} onClick={() => setParams({ tab: 'hygiene' })}>Hygiene</button>
        <button className={tab === 'plans' ? 'active' : ''} onClick={() => setParams({ tab: 'plans' })}>Treatment plans</button>
        <button className={tab === 'close' ? 'active' : ''} onClick={() => setParams({ tab: 'close' })}>Close</button>
        <button className={tab === 'saved' ? 'active' : ''} onClick={() => setParams({ tab: 'saved' })}>Saved & scheduled</button>
        <button className={tab === 'builder' ? 'active' : ''} onClick={() => setParams({ tab: 'builder' })}>Report builder</button>
      </div>
      {tab === 'kpis' ? <Analytics /> : tab === 'hygiene' ? <HygieneReport /> : tab === 'plans' ? <PlanReport /> : tab === 'close' ? <CloseBooks /> : tab === 'saved' ? <SavedReports /> : tab === 'builder' ? <ReportBuilder /> : tab === 'referrals' ? <ReferralReport /> : tab === 'memberships' ? <MembershipReport /> : tab === 'reviews' ? <ReviewReport /> : <Operational />}
    </>
  );
}

function Operational() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  // Multi-location: reports follow the office picked in the sidebar ("All offices" is consolidated).
  const office = getLocationId();
  const [prov, setProv] = useState('');
  const at = `${office ? `&location_id=${office}` : ''}${prov ? `&provider_id=${prov}` : ''}`;
  // Only the part being looked at is loaded.
  const [view, setView] = useState('sheet');
  const { data: prod } = useApi(view === 'production' ? `/reports/production?from=${from}&to=${to}${at}` : null);
  const [agingGroup, setAgingGroup] = useState('patient');
  const [asOf, setAsOf] = useState('');
  const { data: aging } = useApi(view === 'aging' ? `/reports/aging?group=${agingGroup}${asOf ? `&as_of=${asOf}` : ''}` : null);
  const { data: byProv } = useApi(view === 'production' ? `/reports/collections-by-provider?from=${from}&to=${to}${at}` : null);
  const { data: adj } = useApi(view === 'production' ? `/reports/adjustments?from=${from}&to=${to}${at}` : null);
  const [sheetDate, setSheetDate] = useState(today);
  const { data: sheet } = useApi(view === 'sheet' ? `/reports/daysheet?date=${sheetDate}${at}` : null);
  const maxDay = Math.max(1, ...(prod?.by_day || []).map((d) => Math.max(d.production, d.collections)));
  const total = (key) => (prod?.by_day || []).reduce((s, d) => s + d[key], 0);

  return (
    <>
      <div className="inline no-print" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
        <div className="seg">
          {[['sheet', 'Day sheet'], ['production', 'Production & collections'], ['aging', 'A/R aging']].map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
        </div>
        {view !== 'aging' && <ProviderSelect value={prov} onChange={setProv} />}
      </div>
      {view === 'sheet' && <DaySheet sheet={sheet} date={sheetDate} setDate={setSheetDate} />}
      {view === 'production' && <>
      {prod?.by_location && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>By office</h2>
            <CsvButton name={`offices-${from}-to-${to}`} rows={prod.by_location} columns={[['Office', (r) => r.name], ['Production', (r) => dollars(r.production)], ['Patient payments', (r) => dollars(r.patient_collections)], ['Adjustments', (r) => dollars(r.adjustments)]]} />
          </div>
          <table className="compact-table">
            <thead><tr><th>Office</th><th className="num">Production</th><th className="num">Patient payments</th><th className="num">Adjustments</th></tr></thead>
            <tbody>{prod.by_location.map((l) => <tr key={l.id ?? 'none'}><td>{l.name}</td><td className="num">{money(l.production)}</td><td className="num">{money(l.patient_collections)}</td><td className="num">{money(l.adjustments)}</td></tr>)}</tbody>
          </table>
          <p className="muted" style={{ fontSize: 12 }}>{from} to {to}. {office ? 'Pick “All offices” in the sidebar for everything else on this page combined.' : 'Pick an office in the sidebar to see this page for one office.'} Insurance payments aren’t tied to an office.</p>
        </div>
      )}

      <div className="page-header" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0 }}>Production & collections</h2>
        <div className="actions">
          <button onClick={() => { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }}>MTD</button>
          <button onClick={() => { setFrom(shiftDate(today, -29)); setTo(today); }}>Last 30 days</button>
          <button onClick={() => { setFrom(`${today.slice(0, 4)}-01-01`); setTo(today); }}>YTD</button>
          <PrintButton />
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
          <span>to</span>
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
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

      </>}

      {view === 'aging' && <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div style={{ padding: '14px 16px' }}>
          <TitleRow title="Accounts receivable aging">
            <div className="seg no-print">
              <button className={agingGroup === 'patient' ? 'active' : ''} onClick={() => setAgingGroup('patient')}>By patient</button>
              <button className={agingGroup === 'family' ? 'active' : ''} onClick={() => setAgingGroup('family')}>By family</button>
            </div>
            <input type="date" className="no-print" aria-label="As of" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} title="As of (leave blank for today)" style={{ width: 150 }} />
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
      </div>}
    </>
  );
}

// Where new patients come from (and what they've produced), and how outgoing referrals are going.
function ReferralReport() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [prov, setProv] = useState('');
  const { data } = useApi(`/reports/referrals?from=${from}&to=${to}${prov ? `&provider_id=${prov}` : ''}`);
  const { data: open } = useApi('/referrals?open=true');
  return (
    <>
      <div className="inline" style={{ margin: '12px 0', gap: 8, flexWrap: 'wrap' }}>
        <label className="inline">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <ProviderSelect value={prov} onChange={setProv} label="Production: all providers" />
        <PrintButton />
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Referring doctors and people</h2>
            <CsvButton name={`referral-sources-${from}-to-${to}`} rows={data?.sources} columns={[['Source', (r) => r.name], ['Practice', (r) => r.practice_name || ''], ['Patients', (r) => r.patients], ['Production since referral', (r) => dollars(r.production)]]} />
          </div>
          <table className="compact-table">
            <thead><tr><th>Source</th><th className="num">Patients</th><th className="num">Production since</th></tr></thead>
            <tbody>
              {data?.sources.map((s) => <tr key={s.id}><td>{s.name}<div className="muted" style={{ fontSize: 12 }}>{[s.practice_name, s.specialty].filter(Boolean).join(' · ')}</div></td><td className="num">{s.patients}</td><td className="num">{money(s.production)}</td></tr>)}
              {data?.sources.length === 0 && <tr><td colSpan={3} className="muted">No referrals recorded in this period.</td></tr>}
            </tbody>
          </table>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h3>Other new-patient sources</h3>
            <CsvButton name={`new-patient-sources-${from}-to-${to}`} rows={data?.free_text} columns={[['Source', (r) => r.source], ['Patients', (r) => r.patients], ['Production', (r) => dollars(r.production)]]} />
          </div>
          <table className="compact-table">
            <thead><tr><th>Source</th><th className="num">Patients</th><th className="num">Production</th></tr></thead>
            <tbody>{data?.free_text.map((s) => <tr key={s.source}><td>{s.source}</td><td className="num">{s.patients}</td><td className="num">{money(s.production)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Referred out</h2>
            <CsvButton name={`referred-out-${from}-to-${to}`} rows={data?.outgoing} columns={[['Specialist', (r) => r.name], ['Specialty', (r) => r.specialty || ''], ['Sent', (r) => r.referrals], ['Seen', (r) => r.seen], ['Report back', (r) => r.reports]]} />
          </div>
          <table className="compact-table">
            <thead><tr><th>Specialist</th><th className="num">Sent</th><th className="num">Seen</th><th className="num">Report back</th></tr></thead>
            <tbody>
              {data?.outgoing.map((s) => <tr key={s.name}><td>{s.name}{s.specialty ? <span className="muted"> · {s.specialty}</span> : null}</td><td className="num">{s.referrals}</td><td className="num">{s.seen}</td><td className="num">{s.reports}</td></tr>)}
              {data?.outgoing.length === 0 && <tr><td colSpan={4} className="muted">None in this period.</td></tr>}
            </tbody>
          </table>
          <h3>Waiting on the specialist</h3>
          <table className="compact-table">
            <tbody>
              {open?.map((r) => (
                <tr key={r.id}><td><Link to={`/patients/${r.patient_id}`}>{r.first_name} {r.last_name}</Link></td><td>{r.contact_name}</td><td>{r.reason || ''}</td><td className="muted">{r.referral_date}</td><td>{label(r.status)}</td></tr>
              ))}
              {open?.length === 0 && <tr><td className="muted">Nothing outstanding.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function useRange(providerType) {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [prov, setProv] = useState('');
  const pickers = (
    <div className="inline" style={{ margin: '12px 0', gap: 8, flexWrap: 'wrap' }}>
      <label className="inline">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="inline">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <ProviderSelect value={prov} onChange={setProv} type={providerType} label={providerType === 'hygienist' ? 'All hygienists' : 'All providers'} />
      <PrintButton />
    </div>
  );
  return { from, to, pickers, q: `from=${from}&to=${to}${prov ? `&provider_id=${prov}` : ''}` };
}
const pctText = (v) => (v == null ? '—' : `${v}%`);

// Hygiene: production and reappointment by hygienist, perio vs prophy, and whether due recalls got seen.
function HygieneReport() {
  const { from, to, pickers, q } = useRange('hygienist');
  const { data } = useApi(`/reports/hygiene?${q}`);
  return (
    <>
      {pickers}
      {data && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Hygiene production</div><div className="value">{money(data.total.production)}</div></div>
            <div className="card stat"><div className="label">Reappointment</div><div className="value">{pctText(data.total.reappointment_rate)}</div><div className="sub">{data.total.reappointed} of {data.total.visits} visits left booked</div></div>
            <div className="card stat"><div className="label">Perio share</div><div className="value">{pctText(data.perio.perio_pct)}</div><div className="sub">{data.perio.perio} perio · {data.perio.prophy} prophy</div></div>
            <div className="card stat"><div className="label">Recalls seen</div><div className="value">{pctText(data.recall.seen_pct)}</div><div className="sub">{data.recall.seen} of {data.recall.due} due · {data.recall.booked} booked</div></div>
          </div>
          <div className="card">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>By hygienist</h2>
              <CsvButton name={`hygiene-${from}-to-${to}`} rows={data.hygienists} columns={[['Hygienist', (r) => r.name], ['Production', (r) => dollars(r.production)], ['Visits', (r) => r.visits], ['Per visit', (r) => (r.per_visit == null ? '' : dollars(r.per_visit))], ['Reappointed', (r) => r.reappointed], ['Reappointment %', (r) => r.reappointment_rate ?? '']]} />
            </div>
            <table className="compact-table">
              <thead><tr><th>Hygienist</th><th className="num">Production</th><th className="num">Visits</th><th className="num">Per visit</th><th className="num">Reappointed</th></tr></thead>
              <tbody>
                {data.hygienists.map((r) => <tr key={r.provider_id}><td>{r.name}</td><td className="num">{money(r.production)}</td><td className="num">{r.visits}</td><td className="num">{r.per_visit == null ? '—' : money(r.per_visit)}</td><td className="num">{pctText(r.reappointment_rate)}</td></tr>)}
                {!data.hygienists.length && <tr><td colSpan={5} className="muted">No hygienists set up (Settings → Providers, type Hygienist).</td></tr>}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12 }}>Reappointed: the patient left with their next visit already booked. Perio share: scaling and root planing, perio maintenance and full-mouth debridement against adult and child prophies. Recalls seen: patients whose recall came due in these dates who have had a visit since two months before it.</p>
          </div>
        </>
      )}
    </>
  );
}

// Treatment plans presented in the dates, and how far each provider's got: accepted, scheduled, done.
function PlanReport() {
  const { from, to, pickers, q } = useRange();
  const { data } = useApi(`/reports/treatment-plans?${q}`);
  const rows = data ? [...data.providers, { ...data.total, provider_id: 'total', provider_name: 'Total' }] : [];
  return (
    <>
      {pickers}
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Presented → accepted → scheduled → done</h2>
          <CsvButton name={`treatment-plans-${from}-to-${to}`} rows={rows} columns={[['Provider', (r) => r.provider_name], ['Plans', (r) => r.plans], ['Presented', (r) => dollars(r.presented)], ['Accepted', (r) => dollars(r.accepted)], ['Acceptance %', (r) => r.acceptance_pct ?? ''], ['Scheduled', (r) => dollars(r.scheduled)], ['Completed', (r) => dollars(r.completed)], ['Accepted, not scheduled', (r) => dollars(r.unscheduled)]]} />
        </div>
        <table className="compact-table">
          <thead><tr><th>Provider</th><th className="num">Plans</th><th className="num">Presented</th><th className="num">Accepted</th><th className="num">Scheduled</th><th className="num">Completed</th><th className="num">Accepted, not scheduled</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.provider_id ?? 'none'} style={r.provider_id === 'total' ? { fontWeight: 600 } : undefined}>
                <td>{r.provider_name}</td><td className="num">{r.plans}</td><td className="num">{money(r.presented)}</td>
                <td className="num">{money(r.accepted)} <span className="muted">{pctText(r.acceptance_pct)}</span></td>
                <td className="num">{money(r.scheduled)}</td><td className="num">{money(r.completed)}</td><td className="num">{money(r.unscheduled)}</td>
              </tr>
            ))}
            {data && !data.providers.length && <tr><td colSpan={7} className="muted">No treatment plans presented in these dates.</td></tr>}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12 }}>By the date each plan was presented (or created). Accepted counts plans accepted or signed, and any procedure already booked or done. The follow-up list under Follow-ups → Unscheduled treatment has the patients behind the last column.</p>
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
          <input type="date" aria-label="Day" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160 }} />
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
const TitleRow = ({ title, children }) => (
  <div className="inline" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{title}</h2><span className="inline">{children}</span></div>
);
