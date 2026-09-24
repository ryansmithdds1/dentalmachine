import { Link } from 'react-router-dom';
import { PackageCheck } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { useLiveEvents } from '../../live.js';
import { fmtDate, fmtTime } from '../../format.js';
import { READINESS } from './ReadinessBadge.jsx';
import './readiness.css';

// Huddle card (LB1/LB5): visits in the next few days whose lab case or parts aren't here and checked. Opening it
// also makes the "call the lab" / "order it" to-dos (once per item). Nothing to show: nothing shown.
export default function ReadinessHuddle({ date }) {
  const { data, reload } = useApi(`/visit-readiness/huddle?date=${date}`, [date]);
  useLiveEvents((e) => ['readiness', 'lab_checkin'].includes(e.type) && reload());
  if (!data?.rows?.length) return null;
  return (
    <div className="card rdy-card" style={{ marginTop: 16 }} aria-label="Lab cases and parts">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <h2><PackageCheck size={18} aria-hidden="true" /> Lab cases &amp; parts — next {data.days_ahead} {data.days_ahead === 1 ? 'day' : 'days'}</h2>
        <Link to="/lab-checkin" className="no-print"><button className="small">Check in</button></Link>
      </div>
      <ul className="rdy-rows">
        {data.rows.map((v) => {
          const r = READINESS[v.state] || READINESS.waiting;
          return (
            <li key={v.appointment_id} className="rdy-row">
              <span className="rdy-when">{fmtDate(v.start_time.slice(0, 10))} {fmtTime(v.start_time)}</span>
              <Link to={`/patients/${v.patient_id}`}><strong>{v.patient_name}</strong></Link>
              <span className={`rdy-chip ${r.tone}`}><r.Icon size={12} aria-hidden="true" /> {v.label}</span>
              <span className="rdy-items">{v.items.filter((i) => !['checked', 'set_aside'].includes(i.state)).map((i) => `${i.name} — ${i.label.toLowerCase()}`).join(' · ')}</span>
            </li>
          );
        })}
      </ul>
      {data.ready > 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{data.ready} other {data.ready === 1 ? 'visit is' : 'visits are'} ready.</div>}
    </div>
  );
}
