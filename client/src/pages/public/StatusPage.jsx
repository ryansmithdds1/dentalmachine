import { useEffect, useState } from 'react';

// Public service status: the app, its database and file storage, messaging, and background jobs.
export default function StatusPage() {
  const [s, setS] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = () => fetch('/api/public/status').then((r) => r.json()).then((d) => { setS(d); setFailed(false); }).catch(() => setFailed(true));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  const tone = failed || s?.status === 'down' ? 'danger' : s?.status === 'degraded' ? 'warn' : 'ok';
  const label = failed ? 'Can’t reach the service' : { operational: 'All systems operational', degraded: 'Some features degraded', down: 'Service disruption' }[s?.status] || 'Checking…';
  return (
    <div className="public-page" style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>Dental Machine status</h1>
      <div className={`card badge ${tone}`} style={{ display: 'block', fontSize: 18, padding: 16 }}>{label}</div>
      {s && (
        <>
          <div className="card">
            <h2>Services</h2>
            <table>
              <tbody>
                {s.checks.map((c) => <tr key={c.name}><td>{c.name}</td><td>{c.note || (c.ok ? 'Operational' : 'Not responding')}</td><td className="num">{c.ms != null ? `${c.ms} ms` : ''}</td><td><span className={`badge ${c.ok ? 'ok' : 'danger'}`}>{c.ok ? 'OK' : 'Issue'}</span></td></tr>)}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Background jobs</h2>
            {s.background_jobs && <p className="muted" style={{ fontSize: 13 }}>{s.background_jobs}</p>}
            {s.jobs.length === 0 ? <div className="muted">No jobs have run on this server since it started.</div> : (
              <table><tbody>{s.jobs.map((j) => <tr key={j.name}><td>{j.name}</td><td className="muted">{j.last_run ? new Date(j.last_run).toLocaleString() : '—'}</td><td><span className={`badge ${j.ok ? 'ok' : 'danger'}`}>{j.ok ? 'OK' : 'Failed'}</span></td></tr>)}</tbody></table>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Checked {new Date(s.checked_at).toLocaleString()}{s.version ? ` · version ${s.version}` : ''} · up {s.uptime_minutes} minutes</div>
        </>
      )}
    </div>
  );
}
