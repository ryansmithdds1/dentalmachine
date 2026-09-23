import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, money, label } from '../format.js';

const time12 = (dt) => {
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// The day's schedule on paper: one page per provider (or just the one asked for), in time order.
export default function SchedulePrint() {
  const [params] = useSearchParams();
  const { practice } = useAuth();
  const date = params.get('date');
  const only = params.get('provider_id');
  const { data: appts } = useApi(`/appointments?date=${date}${only ? `&provider_id=${only}` : ''}`);
  useEffect(() => {
    if (appts) setTimeout(() => window.print(), 300);
  }, [appts]);
  if (!appts) return <div className="empty">Loading…</div>;
  const active = appts.filter((a) => !['cancelled', 'no_show'].includes(a.status)).sort((a, b) => a.start_time.localeCompare(b.start_time));
  const byProvider = [...active.reduce((m, a) => m.set(a.provider_id, [...(m.get(a.provider_id) || []), a]), new Map()).values()];
  return (
    <div className="print-doc schedule-print">
      <div className="no-print" style={{ marginBottom: 12 }}><button onClick={() => window.print()}>Print</button></div>
      {!byProvider.length && <p>No appointments on {fmtDate(date)}.</p>}
      {byProvider.map((list) => (
        <section key={list[0].provider_id} className="print-page">
          <header className="inline" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>{list[0].provider_name}</h2>
            <div>{practice?.name} · {fmtDate(date)} · {list.length} patient{list.length === 1 ? '' : 's'} · {money(list.reduce((s, a) => s + (a.production || 0), 0))}</div>
          </header>
          <table>
            <thead><tr><th>Time</th><th>Patient</th><th>Visit</th><th>Chair</th><th>Notes</th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{time12(a.start_time)}–{time12(a.end_time)}</td>
                  <td>
                    <strong>{a.first_name} {a.last_name}</strong>{a.preferred_name ? ` (${a.preferred_name})` : ''}
                    <div className="muted">{a.phone || ''}{a.dob ? ` · born ${a.dob}` : ''}</div>
                    {a.medical_alerts && <div style={{ color: '#b91c1c' }}>⚠ {a.medical_alerts}</div>}
                    {a.premed_required ? <div style={{ color: '#b91c1c' }}>Premedication required</div> : null}
                  </td>
                  <td>{a.type_name || a.reason || ''}<div className="muted">{a.procedure_summary || ''}</div><div className="muted">{label(a.status)}</div></td>
                  <td>{a.operatory_name || ''}</td>
                  <td>{a.notes || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
