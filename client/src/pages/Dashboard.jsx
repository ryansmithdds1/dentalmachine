import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtTime } from '../format.js';
import { Badge } from '../components/ui.jsx';

const Stat = ({ label, value, sub }) => (
  <div className="card stat">
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {sub && <div className="sub">{sub}</div>}
  </div>
);

export default function Dashboard() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const { data: d } = useApi('/dashboard');
  const { data: appts } = useApi(d && can('schedule:read') ? `/appointments?date=${d.today}` : null, [d?.today]);
  if (!d) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {user.name.split(' ')[0]}</h1>
          <div className="muted">{new Date(`${d.today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Appointments today" value={d.appointments_today} sub={`${d.appointments_by_status.checked_in || 0} checked in · ${d.appointments_by_status.completed || 0} completed`} />
        <Stat label="Recalls due" value={d.recalls_due} sub={<Link to="/recalls">Work the recall list →</Link>} />
        <Stat label="Active patients" value={d.active_patients} sub={d.new_patients != null ? `${d.new_patients} new this month` : null} />
        {d.production != null && <Stat label="Production (MTD)" value={money(d.production)} sub={`Collections ${money(d.collections)}`} />}
        {d.accounts_receivable != null && <Stat label="Accounts receivable" value={money(d.accounts_receivable)} sub={`${d.outstanding_claims.n} claims outstanding (${money(d.outstanding_claims.amount)})`} />}
        {d.unscheduled_treatment != null && <Stat label="Unscheduled treatment" value={money(d.unscheduled_treatment.amount)} sub={`${d.unscheduled_treatment.n} planned procedures`} />}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Today&apos;s schedule</h2>
          <Link to="/schedule">Open schedule →</Link>
        </div>
        {!appts?.length ? (
          <div className="empty">No appointments today.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Time</th><th>Patient</th><th>Reason</th><th>Provider</th><th>Op</th><th>Status</th></tr>
              </thead>
              <tbody>
                {appts.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => nav(`/patients/${a.patient_id}`)}>
                    <td>{fmtTime(a.start_time)}</td>
                    <td>
                      {a.first_name} {a.last_name}
                      {a.medical_alerts && <span className="alert-chip" style={{ marginLeft: 6 }} title={a.medical_alerts}>⚠</span>}
                    </td>
                    <td>{a.reason}</td>
                    <td>{a.provider_name}</td>
                    <td>{a.operatory_name}</td>
                    <td><Badge value={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
