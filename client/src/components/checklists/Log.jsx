import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Printer, ArrowLeft } from 'lucide-react';
import { api, download } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, fmtTime } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { Evidence, StateChip, CriticalChip, resultText, OccurrenceDrawer } from './shared.jsx';
import './checklists.css';

const yearAgo = () => new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);

// Filters live in the address, so the printable page and a bookmarked "spore tests, last 12 months" are one link.
function useLogFilters() {
  const [params, setParams] = useSearchParams();
  const f = { item_id: params.get('item_id') || '', q: params.get('q') || '', from: params.get('from') || yearAgo(), to: params.get('to') || todayIso(), critical: params.get('critical') || '' };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  return { f, qs, set: (patch) => setParams(Object.fromEntries(Object.entries({ ...f, ...patch }).filter(([, v]) => v))) };
}
function useLog(qs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setData(null); api.get(`/checklists/log?${qs}`).then(setData, setError); }, [qs]);
  return { data, error };
}

// The compliance log (RCL3): every occurrence in a period with its result, who, when, evidence and flags —
// e.g. all spore tests for the last 12 months for an inspection. CSV download or a printable page.
export default function ChecklistLog() {
  const { f, qs, set } = useLogFilters();
  const { data, error } = useLog(qs);
  const [q, setQ] = useState(f.q);
  const [openId, setOpenId] = useState(null);
  const nav = useNavigate();
  const spore = useMemo(() => data?.items.find((i) => /spore/i.test(i.title)), [data]);
  if (error) return <ErrorBox error={error} />;
  return (
    <div>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div className="actions">
          <select aria-label="Item" value={f.item_id} onChange={(e) => set({ item_id: e.target.value })}>
            <option value="">Every item</option>
            {(data?.items || []).map((i) => <option key={i.id} value={i.id}>{i.template_name}: {i.title}</option>)}
          </select>
          <input aria-label="Search items" placeholder="Search (e.g. spore)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && set({ q })} style={{ width: 170 }} />
          <input type="date" aria-label="From" value={f.from} onChange={(e) => set({ from: e.target.value })} />
          <input type="date" aria-label="To" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!f.critical} onChange={(e) => set({ critical: e.target.checked ? '1' : '' })} /> Critical only</label>
        </div>
        <div className="actions">
          {spore && f.item_id !== String(spore.id) && <button className="small" onClick={() => set({ item_id: String(spore.id), q: '', from: yearAgo(), to: todayIso() })}>Spore tests, last 12 months</button>}
          <button onClick={() => download(`/checklists/log?${qs}&format=csv`, 'checklist-log.csv').catch((e) => toast(e.message, { tone: 'error' }))}><Download size={15} aria-hidden /> CSV</button>
          <button onClick={() => nav(`/checklists/log/print?${qs}`)}><Printer size={15} aria-hidden /> Printable</button>
        </div>
      </div>
      {!data ? <p className="muted">Loading…</p> : !data.rows.length ? <div className="card cl-empty">Nothing recorded for these filters.</div> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="cl-table cl-log">
            <thead><tr><th>Due</th><th>Item</th><th>Status</th><th>Result</th><th>By</th><th>Evidence</th><th>Flag / corrective action</th></tr></thead>
            <tbody>
              {data.rows.map((o) => (
                <tr key={o.id} onClick={() => setOpenId(o.id)} style={{ cursor: 'pointer' }}>
                  <td>{fmtDate(o.due_date)}<div className="muted" style={{ fontSize: 12 }}>{o.location_name}</div></td>
                  <td>{o.title} {o.critical ? <CriticalChip /> : null}<div className="muted" style={{ fontSize: 12 }}>{o.position_name}</div></td>
                  <td><StateChip state={o.state} /></td>
                  <td style={{ color: o.outcome && o.outcome !== 'ok' ? 'var(--danger)' : undefined, fontWeight: o.outcome && o.outcome !== 'ok' ? 700 : 400 }}>{resultText(o)}{o.note ? <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{o.note}</div> : null}</td>
                  <td>{o.completed_by_name}{o.completed_local && <div className="muted" style={{ fontSize: 12 }}>{fmtDate(o.completed_local.slice(0, 10))} {fmtTime(o.completed_local)}</div>}</td>
                  <td>{o.evidence.length ? `${o.evidence.length} file${o.evidence.length > 1 ? 's' : ''}` : ''}</td>
                  <td style={{ fontSize: 12.5 }}>{o.flags.map((fl) => <div key={fl.id}>{fl.corrective_action ? <><strong>Action:</strong> {fl.corrective_action}</> : <span className="cl-warn">Open</span>}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <OccurrenceDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// The same log as a document to print or save as PDF (the browser's Print → Save as PDF), photos included.
export function ChecklistLogPrint() {
  const { f, qs } = useLogFilters();
  const { data, error } = useLog(qs);
  const { practice } = useAuth();
  const item = data?.items.find((i) => String(i.id) === f.item_id);
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="print-doc cl-print">
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Link to={`/checklists/log?${qs}`} className="button"><ArrowLeft size={14} aria-hidden /> Back</Link>
        <button className="primary" onClick={() => window.print()}><Printer size={15} aria-hidden /> Print or save as PDF</button>
      </div>
      <div className="cl-print-head">
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Compliance log{item ? `: ${item.title}` : f.q ? `: “${f.q}”` : ''}</h1>
          <div className="muted" style={{ fontSize: 13 }}>{practice?.name} · {fmtDate(f.from)} – {fmtDate(f.to)}{f.critical ? ' · critical items' : ''}</div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>Printed {new Date().toLocaleString()}</div>
      </div>
      {!data ? <p>Loading…</p> : (
        <>
          <p style={{ fontSize: 13 }}>{data.rows.length} entries · {data.rows.filter((o) => o.state === 'done').length} on time · {data.rows.filter((o) => o.state === 'late').length} late · {data.rows.filter((o) => ['missed', 'overdue'].includes(o.state)).length} not done · {data.rows.filter((o) => o.outcome && o.outcome !== 'ok').length} failed or out of range</p>
          <table className="cl-table">
            <thead><tr><th>Due</th><th>Item</th><th>Result</th><th>Done by / when</th><th>Evidence</th><th>Corrective action</th></tr></thead>
            <tbody>
              {data.rows.map((o) => (
                <tr key={o.id}>
                  <td>{o.due_date}<div style={{ fontSize: 11 }}>{o.location_name}</div></td>
                  <td>{o.title}</td>
                  <td><strong>{resultText(o) || (o.state === 'done' || o.state === 'late' ? 'Done' : o.state === 'missed' ? 'MISSED' : 'NOT DONE')}</strong>{o.outcome && o.outcome !== 'ok' ? ' ⚠' : ''}{o.note ? <div style={{ fontSize: 11 }}>{o.note}</div> : null}</td>
                  <td>{o.completed_by_name}{o.completed_local ? <div style={{ fontSize: 11 }}>{o.completed_local}{o.completed_late ? ' (late)' : ''}</div> : null}{o.late_reason ? <div style={{ fontSize: 11 }}>Late entry: {o.late_reason}</div> : null}</td>
                  <td><div className="cl-print-photos">{o.evidence.map((e) => <Evidence key={e.id} e={e} />)}</div></td>
                  <td style={{ fontSize: 11 }}>{o.flags.map((fl) => <div key={fl.id}>{fl.corrective_action || 'OPEN'}{fl.resolved_by_name ? ` — ${fl.resolved_by_name}` : ''}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
