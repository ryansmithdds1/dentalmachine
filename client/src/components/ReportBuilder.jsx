import { useState } from 'react';
import { api, downloadCsv, dollars } from '../api.js';
import { useApi } from '../hooks.js';
import { money, fmtDate } from '../format.js';
import { ErrorBox } from './ui.jsx';

const fmt = (v, type) => (v == null ? '' : type === 'money' ? money(v) : type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : type === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
const START = { dataset: 'procedures', mode: 'list', columns: ['completed', 'code', 'description', 'provider', 'fee'], filters: [{ column: 'status', op: 'eq', value: 'completed' }], group_by: 'code', aggregates: [{ fn: 'count' }], sort: null };

// Reports → Report builder: pick what to report on, the columns or totals, and filters. No SQL needed.
export default function ReportBuilder() {
  const { data: meta, reload } = useApi('/query-builder');
  const [spec, setSpec] = useState(START);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!meta) return <div className="card">Loading…</div>;
  const ds = meta.datasets[spec.dataset];
  const cols = Object.entries(ds.columns);
  const numeric = cols.filter(([, c]) => ['money', 'number'].includes(c.type));
  const set = (patch) => { setSpec({ ...spec, ...patch }); setResult(null); };
  const body = () => ({ dataset: spec.dataset, filters: spec.filters.filter((f) => f.column), sort: spec.sort, ...(spec.mode === 'group' ? { group_by: spec.group_by, aggregates: spec.aggregates } : { columns: spec.columns }) });
  const run = async () => {
    setErr(null); setBusy(true);
    try { setResult(await api.post('/query-builder/run', body())); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const save = async () => {
    const name = window.prompt('Name this report');
    if (!name) return;
    try { await api.post('/query-builder/saved', { name, spec: { ...body(), mode: spec.mode } }); reload(); } catch (e) { setErr(e); }
  };
  const load = (q) => { setSpec({ ...START, ...q.spec, mode: q.spec.group_by ? 'group' : 'list', columns: q.spec.columns || START.columns, filters: q.spec.filters || [], aggregates: q.spec.aggregates || [{ fn: 'count' }] }); setResult(null); };
  const setFilter = (i, patch) => set({ filters: spec.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setAgg = (i, patch) => set({ aggregates: spec.aggregates.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="card">
        <h2>Report builder</h2>
        <label>Report on<select value={spec.dataset} onChange={(e) => set({ dataset: e.target.value, columns: Object.keys(meta.datasets[e.target.value].columns).slice(0, 5), filters: [], group_by: Object.keys(meta.datasets[e.target.value].columns)[0], aggregates: [{ fn: 'count' }], sort: null })}>
          {Object.entries(meta.datasets).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
        </select></label>
        <div className="seg" style={{ margin: '10px 0' }}>
          <button className={spec.mode === 'list' ? 'active' : ''} onClick={() => set({ mode: 'list' })}>List rows</button>
          <button className={spec.mode === 'group' ? 'active' : ''} onClick={() => set({ mode: 'group' })}>Totals by…</button>
        </div>
        {spec.mode === 'list' ? (
          <fieldset className="builder-cols"><legend>Columns</legend>
            {cols.map(([k, c]) => <label key={k} className="checkbox"><input type="checkbox" checked={spec.columns.includes(k)} onChange={(e) => set({ columns: e.target.checked ? [...spec.columns, k] : spec.columns.filter((x) => x !== k) })} /> {c.label}</label>)}
          </fieldset>
        ) : (
          <>
            <label>Group by<select value={spec.group_by} onChange={(e) => set({ group_by: e.target.value })}>{cols.map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select></label>
            {spec.aggregates.map((a, i) => (
              <div key={i} className="inline" style={{ gap: 6, marginTop: 6 }}>
                <select aria-label="Total" value={a.fn} onChange={(e) => setAgg(i, { fn: e.target.value, column: e.target.value === 'count' ? undefined : a.column || numeric[0]?.[0] })}>{Object.entries(meta.aggregates).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                {a.fn !== 'count' && <select aria-label="Of" value={a.column} onChange={(e) => setAgg(i, { column: e.target.value })}>{numeric.map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select>}
                <button className="small" aria-label="Remove total" onClick={() => set({ aggregates: spec.aggregates.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            {spec.aggregates.length < 5 && <button className="small" style={{ marginTop: 6 }} onClick={() => set({ aggregates: [...spec.aggregates, numeric.length ? { fn: 'sum', column: numeric[0][0] } : { fn: 'count' }] })}>+ Total</button>}
          </>
        )}
        <h3>Only include</h3>
        {spec.filters.map((f, i) => (
          <div key={i} className="builder-filter">
            <select aria-label="Column" value={f.column} onChange={(e) => setFilter(i, { column: e.target.value })}>{cols.map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select>
            <select aria-label="Comparison" value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })}>{Object.entries(meta.ops).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {!['empty', 'not_empty'].includes(f.op) && <input aria-label="Value" type={ds.columns[f.column]?.type === 'date' ? 'date' : ['money', 'number'].includes(ds.columns[f.column]?.type) ? 'number' : 'text'} value={f.value ?? ''} onChange={(e) => setFilter(i, { value: e.target.value })} />}
            <button className="small" aria-label="Remove filter" onClick={() => set({ filters: spec.filters.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button className="small" onClick={() => set({ filters: [...spec.filters, { column: cols[0][0], op: 'eq', value: '' }] })}>+ Filter</button>
        <label style={{ marginTop: 10 }}>Sort by<select value={spec.sort?.column || ''} onChange={(e) => set({ sort: e.target.value ? { column: e.target.value, dir: spec.sort?.dir || 'asc' } : null })}>
          <option value="">—</option>
          {spec.mode === 'group' && spec.aggregates.map((a, i) => <option key={`agg${i}`} value={`agg${i}`}>{meta.aggregates[a.fn]}{a.column ? ` ${ds.columns[a.column]?.label.toLowerCase()}` : ''}</option>)}
          {cols.map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
        </select></label>
        {spec.sort && <label className="checkbox"><input type="checkbox" checked={spec.sort.dir === 'desc'} onChange={(e) => set({ sort: { ...spec.sort, dir: e.target.checked ? 'desc' : 'asc' } })} /> Largest / newest first</label>}
        <div className="form-actions"><button onClick={save}>Save</button><button className="primary" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</button></div>
        {meta.saved.length > 0 && (
          <>
            <h3>Saved</h3>
            {meta.saved.map((q) => (
              <div key={q.id} className="inline" style={{ justifyContent: 'space-between' }}>
                <button className="link" onClick={() => load(q)}>{q.name}</button>
                <button className="small" aria-label={`Delete ${q.name}`} onClick={() => window.confirm(`Delete “${q.name}”?`) && api.del(`/query-builder/saved/${q.id}`).then(reload)}>✕</button>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="card">
        <ErrorBox error={err} />
        {!result ? <div className="empty">Choose what you want to see and press Run.</div> : (
          <>
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{result.rows.length} rows{result.truncated ? ' (first 1,000 — add a filter to narrow it)' : ''}</span>
              <button className="small" disabled={!result.rows.length} onClick={() => downloadCsv(`report-${spec.dataset}`, result.rows, result.headers.map((hd, i) => [hd.label, (r) => (hd.type === 'money' ? dollars(r[i]) : r[i] ?? '')]))}>⬇ CSV</button>
            </div>
            <div className="table-wrap">
              <table className="compact-table">
                <thead><tr>{result.headers.map((hd, i) => <th key={i} className={['money', 'number'].includes(hd.type) ? 'num' : ''}>{hd.label}</th>)}</tr></thead>
                <tbody>{result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={['money', 'number'].includes(result.headers[j].type) ? 'num' : ''}>{fmt(v, result.headers[j].type)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
