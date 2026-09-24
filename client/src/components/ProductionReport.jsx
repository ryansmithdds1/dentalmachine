import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, Printer, Target, X } from 'lucide-react';
import { api, download, downloadCsv, getLocationId } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts } from '../shortcuts.js';
import { money, fmtDate, practiceToday, shiftDate } from '../format.js';
import { ErrorBox } from './ui.jsx';
import './productionreport.css';

// Reports → Production & income (PR1): gross production, write-offs, net, collections and collection % for any
// dates, by provider and for the office, from the ledger (server: reportlibrary.js productionIncome — the same
// numbers as the report library). Run over today, it also shows what's still scheduled this month and the
// projected month beside the goal. Every number opens the entries behind it in a side panel.
// Keys: 1–4 date presets, D daily rows, E export CSV, P print, Esc closes the entries.
const TILE_HELP = {
  gross: 'Completed work (ledger charges) in the dates',
  adjustments: 'Write-offs and discounts (credits) and debit adjustments',
  net: 'Gross production + adjustments',
  collections: 'Patient and insurance payments (refunds shown apart)',
  collection_pct: 'Collections ÷ net production',
  scheduled: 'Fees of work still planned on this month’s visits from today on — not money yet',
  projected: 'Done so far this month + still scheduled',
};
const LABEL = {
  gross: 'Gross production', ppo_writeoffs: 'PPO write-offs', other_adjustments: 'Other adjustments', adjustments: 'Adjustments', net: 'Net production',
  patient: 'Patient payments', insurance: 'Insurance payments', collections: 'Collections', refunds: 'Refunds', scheduled: 'Scheduled rest of month', month_to_date: 'Done so far this month',
};
const pctText = (v) => (v == null ? '—' : `${v}%`);

function presets(today) {
  const month = today.slice(0, 7);
  const lastEnd = shiftDate(`${month}-01`, -1);
  return [
    { key: 'mtd', label: 'This month', from: `${month}-01`, to: today },
    { key: 'last', label: 'Last month', from: `${lastEnd.slice(0, 7)}-01`, to: lastEnd },
    { key: 'qtd', label: 'Last 90 days', from: shiftDate(today, -89), to: today },
    { key: 'ytd', label: 'Year to date', from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
}

export default function ProductionReport() {
  const { practice } = useAuth() || {};
  const today = practiceToday(practice?.timezone);
  const choices = useMemo(() => presets(today), [today]);
  const [range, setRange] = useState({ from: choices[0].from, to: choices[0].to });
  const [office, setOffice] = useState(String(getLocationId() || ''));
  const [showDays, setShowDays] = useState(false);
  const [drill, setDrill] = useState(null);
  const locations = useLookup('/locations');
  const query = new URLSearchParams({ from: range.from, to: range.to, ...(office ? { location_id: office } : {}) }).toString();
  const { data, error, loading } = useApi(`/production-income?${query}`, [query]);
  const exportCsv = () => download(`/production-income?${query}&format=csv`, `production-income-${range.from}-to-${range.to}.csv`);
  const open = (d) => setDrill({ ...d, query });

  useShortcuts([
    ...choices.map((c, i) => ({ combo: String(i + 1), label: c.label, handler: () => setRange({ from: c.from, to: c.to }) })),
    { combo: 'd', label: 'Show or hide daily rows', handler: () => setShowDays((v) => !v) },
    { combo: 'e', label: 'Export CSV', handler: exportCsv },
    { combo: 'p', label: 'Print', handler: () => window.print() },
    { combo: 'escape', handler: () => setDrill(null), enabled: !!drill, inInputs: true },
  ]);

  const t = data?.totals;
  const pr = data?.projection;
  const officeName = office ? locations.find((l) => String(l.id) === office)?.name : null;
  return (
    <div className={`pi${drill ? ' pi-drilling' : ''}`}>
      <header className="pi-head">
        <div>
          <h2>Production &amp; income</h2>
          <div className="muted pi-sub">
            {fmtDate(range.from)} – {fmtDate(range.to)}{officeName ? ` · ${officeName}` : locations.length > 1 ? ' · All offices' : ''}
            {data?.generated_at && <span className="print-only"> · printed {fmtDate(today)}</span>}
          </div>
        </div>
        <div className="pi-controls no-print">
          <div className="seg" role="group" aria-label="Dates">
            {choices.map((c, i) => (
              <button key={c.key} className={range.from === c.from && range.to === c.to ? 'active' : ''} onClick={() => setRange({ from: c.from, to: c.to })} title={`${c.label} (${i + 1})`}>{c.label}</button>
            ))}
          </div>
          <label className="pi-date">From <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></label>
          <label className="pi-date">To <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></label>
          {locations.length > 1 && (
            <select aria-label="Office" value={office} onChange={(e) => setOffice(e.target.value)}>
              <option value="">All offices</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button className="small" onClick={exportCsv} title="Download as a spreadsheet (E)"><Download size={14} /> CSV</button>
          <button className="small" onClick={() => window.print()} title="Print or save as PDF (P)"><Printer size={14} /> Print</button>
        </div>
      </header>

      <ErrorBox error={error} />
      {!data && loading && <div className="card muted">Adding up the ledger…</div>}
      {t && (
        <>
          <section className="pi-tiles" aria-label="Totals">
            <Tile label="Gross production" value={money(t.gross)} help={TILE_HELP.gross} onClick={() => open({ metric: 'gross' })} />
            <Tile label="Adjustments" value={money(t.adjustments)} help={TILE_HELP.adjustments} onClick={() => open({ metric: 'adjustments' })}
              parts={[['PPO write-offs', t.ppo_writeoffs, () => open({ metric: 'ppo_writeoffs' })], ['Other', t.other_adjustments, () => open({ metric: 'other_adjustments' })]]} />
            <Tile label="Net production" value={money(t.net)} help={TILE_HELP.net} onClick={() => open({ metric: 'net' })} strong />
            <Tile label="Collections" value={money(t.collections)} help={TILE_HELP.collections} onClick={() => open({ metric: 'collections' })}
              parts={[['Patient', t.patient, () => open({ metric: 'patient' })], ['Insurance', t.insurance, () => open({ metric: 'insurance' })], ...(t.refunds ? [['Refunds', t.refunds, () => open({ metric: 'refunds' })]] : [])]} />
            <Tile label="Collection %" value={pctText(t.collection_pct)} help={TILE_HELP.collection_pct} tone={t.collection_pct == null ? '' : t.collection_pct >= 98 ? 'ok' : t.collection_pct < 90 ? 'warn' : ''} />
            {pr && <Tile label="Scheduled rest of month" value={money(pr.scheduled)} help={TILE_HELP.scheduled} onClick={() => open({ metric: 'scheduled' })}
              parts={[[`${pr.visits} ${pr.visits === 1 ? 'visit' : 'visits'} from ${fmtDate(pr.scheduled_from)}`, null]]} />}
            {pr && <Projection pr={pr} onMtd={() => open({ metric: 'month_to_date' })} />}
          </section>

          <section className="card pi-card">
            <div className="pi-card-head"><h3>By provider</h3><span className="muted">Payments and write-offs are credited to the provider whose work they paid for or reduced.</span></div>
            <div className="table-wrap">
              <table className="pi-table">
                <thead>
                  <tr>
                    <th>Provider</th><th className="num">Gross</th><th className="num">PPO write-offs</th><th className="num">Other adj.</th><th className="num">Net</th>
                    <th className="num">Patient</th><th className="num">Insurance</th><th className="num">Collections</th><th className="num">Coll. %</th>
                    {pr && <th className="num">Scheduled</th>}{pr && <th className="num">Projected</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map((r) => {
                    const pid = r.provider_id ?? 'none';
                    const cell = (k) => <Num v={r[k]} onClick={() => open({ metric: k, provider_id: pid, who: r.provider })} />;
                    return (
                      <tr key={pid} className={r.provider_id == null ? 'pi-rest' : ''}>
                        <td>{r.provider}</td>{cell('gross')}{cell('ppo_writeoffs')}{cell('other_adjustments')}{cell('net')}{cell('patient')}{cell('insurance')}{cell('collections')}
                        <td className="num">{pctText(r.collection_pct)}</td>
                        {pr && cell('scheduled')}{pr && <td className="num">{money(r.projected)}</td>}
                      </tr>
                    );
                  })}
                  {!data.providers.length && <tr><td colSpan={pr ? 11 : 9} className="muted">Nothing posted in these dates.</td></tr>}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Office total</th>
                    {['gross', 'ppo_writeoffs', 'other_adjustments', 'net', 'patient', 'insurance', 'collections'].map((k) => <Num key={k} v={t[k]} th onClick={() => open({ metric: k })} />)}
                    <th className="num">{pctText(t.collection_pct)}</th>
                    {pr && <Num v={pr.scheduled} th onClick={() => open({ metric: 'scheduled' })} />}{pr && <th className="num">{money(pr.projected)}</th>}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="card pi-card pi-days">
            <button className="pi-toggle no-print" onClick={() => setShowDays((v) => !v)} aria-expanded={showDays}>
              {showDays ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Daily rows <span className="muted">({data.days.length} {data.days.length === 1 ? 'day' : 'days'} · D)</span>
            </button>
            <h3 className="print-only">Daily rows</h3>
            <div className={`table-wrap${showDays ? '' : ' pi-collapsed'}`}>
              <table className="pi-table">
                <thead>
                  <tr><th>Date</th><th className="num">Gross</th><th className="num">Adjustments</th><th className="num">Net</th><th className="num">Collections</th><th className="num">Coll. %</th><th className="num">Net so far</th><th className="num">Collected so far</th></tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.day}>
                      <td>{fmtDate(d.day)}</td>
                      {['gross', 'adjustments', 'net', 'collections'].map((k) => <Num key={k} v={d[k]} onClick={() => open({ metric: k, day: d.day })} />)}
                      <td className="num">{pctText(d.collection_pct)}</td>
                      <td className="num muted">{money(d.running_net)}</td><td className="num muted">{money(d.running_collections)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="muted pi-foot">From the ledger: voided entries and their reversals cancel out; amounts are what was posted on each date. Scheduled and projected amounts are planned fees, not money yet.</p>
        </>
      )}
      {drill && <Entries drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

function Tile({ label, value, help, onClick, parts, strong, tone = '' }) {
  const body = (
    <>
      <span className="pi-tile-label">{label}</span>
      <span className="pi-tile-value">{value}</span>
    </>
  );
  return (
    <div className={`pi-tile${strong ? ' strong' : ''}${tone ? ` ${tone}` : ''}`} title={help}>
      {onClick ? <button className="pi-tile-main" onClick={onClick} aria-label={`${label}: ${value}. Show the entries`}>{body}</button> : <div className="pi-tile-main">{body}</div>}
      {parts && (
        <div className="pi-tile-parts">
          {parts.map(([l, v, go]) => (go
            ? <button key={l} className="link" onClick={go}>{l} {money(v)}</button>
            : <span key={l}>{l}{v != null ? ` ${money(v)}` : ''}</span>))}
        </div>
      )}
    </div>
  );
}

function Projection({ pr, onMtd }) {
  const pct = pr.goal ? Math.min(100, Math.round((pr.projected / pr.goal) * 100)) : null;
  const done = pr.goal ? Math.min(100, Math.round((pr.month_to_date / pr.goal) * 100)) : null;
  return (
    <div className="pi-tile pi-projection" title={TILE_HELP.projected}>
      <div className="pi-tile-main">
        <span className="pi-tile-label">Projected {new Date(`${pr.month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long' })}</span>
        <span className="pi-tile-value">{money(pr.projected)}</span>
      </div>
      <div className="pi-tile-parts">
        <button className="link" onClick={onMtd}>Done so far {money(pr.month_to_date)}</button>
        {pr.goal != null
          ? <span><Target size={12} /> Goal {money(pr.goal)} · {pr.goal_pct}%{pr.to_goal > 0 ? ` · ${money(pr.to_goal)} to book` : ''}</span>
          : <span className="muted">No monthly goal set</span>}
      </div>
      {pr.goal != null && (
        <div className="pi-goalbar" role="img" aria-label={`${pr.goal_pct}% of the goal if everything scheduled is done`}>
          <i className="done" style={{ width: `${done}%` }} /><i className="sched" style={{ width: `${Math.max(0, pct - done)}%` }} />
        </div>
      )}
      {pr.goal_source && <span className="pi-goal-src">{pr.goal_source}</span>}
    </div>
  );
}

function Num({ v, onClick, th }) {
  const Cell = th ? 'th' : 'td';
  if (v == null) return <Cell className="num">—</Cell>;
  return (
    <Cell className={`num${v < 0 ? ' neg' : ''}`}>
      {v && onClick ? <button className="pi-num" onClick={onClick} title="Show the entries">{money(v)}</button> : money(v)}
    </Cell>
  );
}

// The entries behind a number, in a side panel (no modal): what was posted, for whom, and the total.
function Entries({ drill, onClose }) {
  const q = new URLSearchParams(drill.query);
  q.set('metric', drill.metric);
  if (drill.provider_id != null) q.set('provider_id', drill.provider_id);
  if (drill.day) q.set('day', drill.day);
  const [state, setState] = useState({ data: null, error: null });
  const ref = useRef(null);
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null });
    api.get(`/production-income/entries?${q}`).then((data) => alive && setState({ data, error: null }), (error) => alive && setState({ data: null, error }));
    ref.current?.focus();
    return () => { alive = false; };
  }, [q.toString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error } = state;
  const title = `${LABEL[drill.metric]}${drill.who ? ` · ${drill.who}` : ''}${drill.day ? ` · ${fmtDate(drill.day)}` : ''}`;
  return (
    <aside className="pi-drill no-print" aria-label={title} ref={ref} tabIndex={-1}>
      <header>
        <div>
          <h3>{title}</h3>
          {data && <div className="muted">{data.rows.length} {data.rows.length === 1 ? 'entry' : 'entries'} · {money(data.total)}</div>}
        </div>
        <button className="small" onClick={onClose} aria-label="Close (Esc)"><X size={15} /></button>
      </header>
      <ErrorBox error={error} />
      {!data && !error && <div className="muted">Loading…</div>}
      {data?.note && <p className="muted pi-drill-note">{data.note}</p>}
      {data && (
        <>
          <ul className="pi-entries">
            {data.rows.map((r) => (
              <li key={`${r.id}-${r.amount}`} className={r.status ? 'pi-void' : ''}>
                <div className="pi-entry-top">
                  <Link to={`/patients/${r.patient_id}`}>{r.patient}</Link>
                  <span className={`pi-entry-amt${r.amount < 0 ? ' neg' : ''}`}>{money(r.amount)}</span>
                </div>
                <div className="pi-entry-meta">
                  {fmtDate(r.entry_date)} · {r.type_label}{r.code ? ` · ${r.code}${r.tooth ? ` #${r.tooth}` : ''}` : ''}{r.provider ? ` · ${r.provider}` : ''}
                  {r.status && <span className="pi-flag">{r.status}</span>}
                  {r.applied && r.entry_amount != null && <span className="muted"> · part of {money(Math.abs(r.entry_amount))}</span>}
                </div>
                {r.description && r.description !== r.type && <div className="pi-entry-desc">{r.description}</div>}
              </li>
            ))}
            {!data.rows.length && <li className="muted">No entries.</li>}
          </ul>
          <button className="small" disabled={!data.rows.length} onClick={() => downloadCsv(`${drill.metric}-entries`, data.rows, [
            ['Date', (r) => r.entry_date], ['Patient', (r) => r.patient], ['Type', (r) => r.type_label], ['Code', (r) => r.code || ''], ['Tooth', (r) => r.tooth || ''],
            ['Provider', (r) => r.provider || ''], ['Description', (r) => r.description || ''], ['Status', (r) => r.status || ''], ['Amount ($)', (r) => (r.amount / 100).toFixed(2)],
          ])}><Download size={14} /> Entries CSV</button>
        </>
      )}
    </aside>
  );
}
