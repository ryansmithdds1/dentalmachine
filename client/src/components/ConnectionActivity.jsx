import { useState } from 'react';
import { useApi } from '../hooks.js';
import { fmtUtcDateTime } from '../format.js';
import { ErrorBox } from './ui.jsx';

// Every call to an outside service (texts, email, payments, clearinghouse, bank, books, AI): which one,
// what, whether it worked and how long it took. No message contents are kept.
export default function ConnectionActivity() {
  const [service, setService] = useState('');
  const [failed, setFailed] = useState(false);
  const qs = new URLSearchParams({ ...(service ? { service } : {}), ...(failed ? { failed: '1' } : {}) });
  const { data, error } = useApi(`/integration-log?${qs}`, [service, failed]);
  return (
    <div className="card">
      <h2>Connection activity</h2>
      <p className="muted">Each call this practice made to an outside service in the last 90 days. Failures that need someone also appear in Needs attention.</p>
      <ErrorBox error={error} />
      {data?.summary.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Service (last 7 days)</th><th>Calls</th><th>Failed</th><th>Last call</th><th>Last failure</th></tr></thead>
            <tbody>
              {data.summary.map((s) => (
                <tr key={s.service} className="clickable" onClick={() => setService(s.service)}>
                  <td>{s.service}</td><td>{s.calls}</td><td>{s.failures ? <span className="badge danger">{s.failures}</span> : 0}</td>
                  <td className="muted">{fmtUtcDateTime(s.last_call)}</td><td className="muted">{s.last_failure ? fmtUtcDateTime(s.last_failure) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '16px 0 8px' }}>
        {service && <button className="small" onClick={() => setService('')}>Showing {service} — show all</button>}
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}><input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} /> Only failures</label>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Service</th><th>What</th><th>Result</th><th>Time</th><th>Their reference</th><th>Started by</th></tr></thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{fmtUtcDateTime(r.created_at)}</td>
                <td>{r.service}</td>
                <td><code>{r.operation}</code></td>
                <td>{r.ok ? `OK${r.http_status ? ` (${r.http_status})` : ''}` : <span className="badge danger">{r.http_status || 'Failed'}</span>}{r.error ? <div className="muted" style={{ fontSize: 12 }}>{r.error}</div> : null}</td>
                <td className="muted">{r.duration_ms != null ? `${r.duration_ms} ms` : ''}</td>
                <td className="muted">{r.external_id || ''}</td>
                <td className="muted">{r.source}</td>
              </tr>
            ))}
            {data && !data.rows.length && <tr><td colSpan={7} className="muted">No calls yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
