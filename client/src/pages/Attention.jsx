import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useLiveEvents } from '../live.js';
import { fmtUtcDateTime as fmtDateTime } from '../format.js';
import { ErrorBox, Modal, useSubmit } from '../components/ui.jsx';

// Where something that failed on its own (a rejected claim, a text that didn't go, a sync that broke) lands
// as a work item for the right person, until someone fixes it or a later attempt works.
const LINKS = { claims: (id) => `/claims/${id}`, patients: (id) => `/patients/${id}`, claim_queue: () => '/claims?tab=approve' };

export default function Attention() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'open';
  const queue = params.get('role') ?? 'mine';
  const kind = params.get('kind') || '';
  const qs = new URLSearchParams({ status, ...(queue ? { role: queue } : {}), ...(kind ? { kind } : {}) });
  const { data, error, reload } = useApi(`/issues?${qs}`, [status, queue, kind]);
  useLiveEvents((e) => e.type === 'issues' && reload());
  const [closing, setClosing] = useState(null);
  const set = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v === null) n.delete(k); else n.set(k, v); return n; });
  const reopen = async (i) => { await api.patch(`/issues/${i.id}`, { status: 'open' }).catch(() => {}); reload(); };
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Needs attention</h1>
          <div className="muted">Things that failed on their own — a claim that was rejected, a text that didn&apos;t go, a sync that broke. Each stays here until it&apos;s fixed or a later try works.</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select value={queue} onChange={(e) => set('role', e.target.value)} aria-label="Whose list" style={{ width: 'auto' }}>
          <option value="mine">My list{data?.my_queue ? ` (${data.roles[data.my_queue]})` : ''}</option>
          <option value="">Everyone&apos;s</option>
          {data && Object.entries(data.roles).map(([k, v]) => <option key={k} value={k}>{v}{data.open[k] ? ` (${data.open[k]})` : ''}</option>)}
        </select>
        <select value={kind} onChange={(e) => set('kind', e.target.value || null)} aria-label="Kind" style={{ width: 'auto' }}>
          <option value="">All kinds</option>
          {data && Object.entries(data.kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="tabs" style={{ margin: 0 }}>
          {['open', 'resolved', 'ignored'].map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => set('status', s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>What</th><th>Patient</th><th>For</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {data?.issues.map((i) => (
              <tr key={i.id}>
                <td>
                  <div>{i.severity === 'high' && <span className="badge danger" style={{ marginRight: 6 }}>urgent</span>}{LINKS[i.entity] ? <Link to={LINKS[i.entity](i.entity_id)}>{i.title}</Link> : i.title}</div>
                  {i.detail && <div className="muted" style={{ fontSize: 13 }}>{i.detail}</div>}
                  {i.occurrences > 1 && <div className="muted" style={{ fontSize: 12 }}>Happened {i.occurrences} times since {fmtDateTime(i.first_seen)}</div>}
                  {i.resolution && <div style={{ fontSize: 13 }}>{i.status === 'ignored' ? 'Ignored' : 'Resolved'}{i.resolved_by_name ? ` by ${i.resolved_by_name}` : ''}: {i.resolution}</div>}
                </td>
                <td>{i.patient_id ? <Link to={`/patients/${i.patient_id}`}>{i.patient_name}</Link> : '—'}</td>
                <td>{data.roles[i.role] || i.role}{i.assigned_name ? ` · ${i.assigned_name}` : ''}</td>
                <td className="muted">{fmtDateTime(i.last_seen)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {i.status === 'open'
                    ? <><button className="small primary" onClick={() => setClosing({ issue: i, status: 'resolved' })}>Fixed</button>{' '}<button className="small" onClick={() => setClosing({ issue: i, status: 'ignored' })}>Ignore</button></>
                    : <button className="small" onClick={() => reopen(i)}>Reopen</button>}
                </td>
              </tr>
            ))}
            {data && !data.issues.length && <tr><td colSpan={5} className="muted">{status === 'open' ? 'Nothing needs attention.' : 'Nothing here.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {closing && <CloseIssue {...closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />}
    </>
  );
}

function CloseIssue({ issue, status, onClose, onDone }) {
  const [note, setNote] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.patch(`/issues/${issue.id}`, { status, note });
    onDone();
  });
  return (
    <Modal title={status === 'ignored' ? 'Ignore this item' : 'Mark as fixed'} onClose={onClose}>
      <p>{issue.title}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>{status === 'ignored' ? 'Why can it be ignored?' : 'What was done?'}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} required autoFocus />
        </label>
        <ErrorBox error={error} />
        <div className="form-actions"><button className="primary" disabled={busy || !note.trim()}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}

// The count on the sidebar: open items in this person's list.
export function AttentionBadge() {
  const { data, reload } = useApi('/issues?role=mine');
  useLiveEvents((e) => e.type === 'issues' && reload());
  const n = data?.issues.length || 0;
  return n > 0 ? <span className="nav-badge">{n}</span> : null;
}
