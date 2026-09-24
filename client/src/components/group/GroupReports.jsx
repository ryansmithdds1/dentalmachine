import { useState } from 'react';
import { Download } from 'lucide-react';
import { download } from '../../api.js';
import { useApi } from '../../hooks.js';
import { money, shiftDate, practiceToday } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// Group-wide reports: each practice side by side with the group's totals (totals are summed from the practices;
// rates are recomputed from the sums). Same bar approach as the practice's own KPI screen.
const short = (c) => money(c).replace('.00', '');
const pctText = (v) => (v == null ? '—' : `${v}%`);
// Two series, validated for colour-vision separation (teal = production, indigo = collections).
const PROD = 'var(--primary)';
const COLL = '#6366f1';
// A/R age bands: one hue, lighter → darker as money gets older.
const AGING = [['ar_current', 'Current', '#99e2d8'], ['ar_31_60', '31–60', '#4fb8ab'], ['ar_61_90', '61–90', '#0d9488'], ['ar_90_plus', '90+', '#0f5f58']];
const RATES = [['collection_pct', 'Collection'], ['case_acceptance_pct', 'Case acceptance'], ['hygiene_reappointment_pct', 'Hygiene reappt.']];
const RANGES = [['month', 'This month'], [29, '30 days'], [89, '90 days'], [364, '12 months']];

export default function GroupReports({ org }) {
  const today = practiceToday();
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today, preset: 'month' });
  const [practice, setPractice] = useState('');
  const qs = `from=${range.from}&to=${range.to}${practice ? `&practice_id=${practice}` : ''}`;
  const { data: rep, error } = useApi(`/org/reports?${qs}`);
  const csv = useSubmit(() => download(`/org/reports.csv?${qs}`, `group-report-${range.from}-to-${range.to}.csv`));
  const preset = (p) => setRange(p === 'month' ? { from: `${today.slice(0, 7)}-01`, to: today, preset: p } : { from: shiftDate(today, -p), to: today, preset: p });

  const rows = rep?.practices || [];
  const maxMoney = Math.max(1, ...rows.flatMap((p) => [p.production, p.collections]));
  const maxAr = Math.max(1, ...rows.map((p) => p.ar_total));
  const cols = rep?.columns || [];
  const fmt = (kind, v) => (v == null ? '—' : kind === 'money' ? money(v) : kind === 'pct' ? pctText(v) : String(v));
  return (
    <div>
      <div className="grp-toolbar">
        <div className="seg">{RANGES.map(([k, l]) => <button key={k} className={range.preset === k ? 'active' : ''} onClick={() => preset(k)}>{l}</button>)}</div>
        <label className="inline">From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value, preset: null })} /></label>
        <label className="inline">To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value, preset: null })} /></label>
        <select aria-label="Practice" value={practice} onChange={(e) => setPractice(e.target.value)}>
          <option value="">All practices</option>
          {org.practices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="spacer" />
        <button className="small" disabled={!rep || csv.busy} onClick={csv.submit}><Download size={14} /> CSV</button>
      </div>
      <ErrorBox error={error || csv.error} />
      {!rep && !error && <div className="empty">Crunching numbers…</div>}
      {rep && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <Stat l="Production" v={short(rep.totals.production)} sub={`${rows.length} practice${rows.length === 1 ? '' : 's'}`} />
            <Stat l="Collections" v={short(rep.totals.collections)} sub={`${pctText(rep.totals.collection_pct)} of production`} />
            <Stat l="Owed to the group" v={short(rep.totals.ar_total)} sub={`${short(rep.totals.ar_90_plus)} over 90 days`} />
            <Stat l="New patients" v={rep.totals.new_patients} sub={`Case acceptance ${pctText(rep.totals.case_acceptance_pct)}`} />
          </div>
          <div className="grp-charts">
            <div className="card">
              <h2>Production &amp; collections</h2>
              <div className="bars" role="img" aria-label="Production and collections by practice">
                {rows.map((p) => (
                  <div key={p.practice_id} className="bar-col" title={`${p.name}\nProduction ${short(p.production)}\nCollections ${short(p.collections)}`}>
                    <div className="bar-pair">
                      <i style={{ height: `${(p.production / maxMoney) * 100}%`, background: PROD }} />
                      <i style={{ height: `${(p.collections / maxMoney) * 100}%`, background: COLL }} />
                    </div>
                    <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  </div>
                ))}
              </div>
              <div className="legend" style={{ justifyContent: 'flex-start' }}><span><i style={{ background: PROD }} />Production</span><span><i style={{ background: COLL }} />Collections</span></div>
            </div>
            <div className="card">
              <h2>Accounts receivable by age</h2>
              {rows.map((p) => (
                <div key={p.practice_id} className="grp-row">
                  <div className="inline"><span>{p.name}</span><strong>{short(p.ar_total)}</strong></div>
                  <div style={{ width: `${Math.max(2, (p.ar_total / maxAr) * 100)}%` }}>
                    <div className="grp-stack">
                      {AGING.map(([k, l, c]) => (p[k] > 0 ? <i key={k} title={`${p.name} · ${l}: ${short(p[k])}`} style={{ flexGrow: p[k], background: c }} /> : null))}
                    </div>
                  </div>
                </div>
              ))}
              <div className="legend" style={{ justifyContent: 'flex-start' }}>{AGING.map(([k, l, c]) => <span key={k}><i style={{ background: c }} />{l}</span>)}</div>
            </div>
            <div className="card">
              <h2>Rates side by side</h2>
              <div className="grp-rates">
                <span className="h">Practice</span>{RATES.map(([k, l]) => <span key={k} className="h">{l}</span>)}
                {[...rows, { practice_id: 'total', name: 'Group', ...rep.totals }].map((p) => [
                  <strong key={`${p.practice_id}-n`} style={{ fontWeight: p.practice_id === 'total' ? 700 : 500 }}>{p.name}</strong>,
                  ...RATES.map(([k]) => (
                    <div key={`${p.practice_id}-${k}`} title={`${p.name}: ${pctText(p[k])}`}>
                      <div className="grp-rate-v">{pctText(p[k])}</div>
                      <div className="grp-meter"><i style={{ width: `${Math.min(100, p[k] || 0)}%` }} /></div>
                    </div>
                  )),
                ])}
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Practice</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
                <tbody>
                  {rows.map((p) => <tr key={p.practice_id}><td><strong>{p.name}</strong>{p.city ? <div className="muted" style={{ fontSize: 11 }}>{p.city}</div> : null}</td>{cols.map(([k, , kind]) => <td key={k} className="num">{fmt(kind, p[k])}</td>)}</tr>)}
                  <tr className="grp-total-row"><td>Group</td>{cols.map(([k, , kind]) => <td key={k} className="num">{fmt(kind, rep.totals[k])}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>A/R is as of {rep.to}. Collection % is collections ÷ production for the dates chosen; hygiene reappointment counts visits where the next one was booked by the day of the visit.</p>
        </>
      )}
    </div>
  );
}

const Stat = ({ l, v, sub }) => (
  <div className="card stat"><div className="label">{l}</div><div className="value">{v}</div><div className="sub">{sub}</div></div>
);
