import { FlaskConical } from 'lucide-react';
import { useApi } from '../../hooks.js';
import './readiness.css';

// Lab report card (LB4): per lab, how long cases really take against what was promised, how often they're late,
// and how often they come back wrong. The last six months by default.
const pct = (v) => (v == null ? '—' : `${v}%`);
const d = (v) => (v == null ? '—' : `${v} d`);
export default function LabStatsCard({ from, to, compact = false }) {
  const q = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data } = useApi(`/lab-checkin/stats${q ? `?${q}` : ''}`, [q]);
  const labs = data?.labs || [];
  if (!labs.length) return compact ? null : <div className="card rdy-card"><h2><FlaskConical size={18} /> Labs</h2><div className="empty">No cases sent in this period.</div></div>;
  return (
    <div className="card rdy-card" aria-label="Lab turnaround">
      <h2><FlaskConical size={18} aria-hidden="true" /> How the labs are doing</h2>
      <div className="muted" style={{ fontSize: 12.5, margin: '2px 0 8px' }}>Cases sent {data.from} to {data.to}. Late = back after the date the lab first promised.</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="rdy-stats">
          <thead><tr><th>Lab</th><th>Cases</th><th title="Days from sent to back in the office">Turnaround</th><th title="Days the lab promised">Promised</th><th>Late</th><th>Remakes</th>{!compact && <th title="Still out, past the promised date">Overdue now</th>}</tr></thead>
          <tbody>
            {labs.map((l) => (
              <tr key={`${l.lab_id}-${l.lab_name}`}>
                <td>{l.lab_name}</td>
                <td>{l.received}/{l.cases}</td>
                <td className={l.avg_turnaround_days != null && l.avg_promised_days != null && l.avg_turnaround_days > l.avg_promised_days ? 'bad' : ''}>{d(l.avg_turnaround_days)}</td>
                <td>{d(l.avg_promised_days)}</td>
                <td className={l.late_pct >= 20 ? 'bad' : ''}>{pct(l.late_pct)}</td>
                <td className={l.remake_pct >= 10 ? 'bad' : ''}>{pct(l.remake_pct)}</td>
                {!compact && <td className={l.open_late ? 'bad' : ''}>{l.open_late}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
