import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, label, shiftDate, practiceToday } from '../format.js';
import { Badge } from '../components/ui.jsx';

export default function Recalls() {
  const { can, practice } = useAuth();
  const [window_, setWindow] = useState(30);
  const today = practiceToday(practice?.timezone);
  const before = shiftDate(today, window_);
  const { data: recalls, reload } = useApi(`/recalls?before=${before}&status=due,contacted`);

  const [notice, setNotice] = useState(null);
  const remind = async (r) => {
    setNotice(null);
    try {
      const m = await api.post(`/recalls/${r.id}/remind`);
      setNotice(`${r.first_name} ${r.last_name}: reminder ${m.status === 'sent' ? 'sent' : 'failed'} by ${m.channel === 'sms' ? 'text' : 'email'}.`);
      reload();
    } catch (e) {
      setNotice(`${r.first_name} ${r.last_name}: ${e.message}`);
    }
  };
  const mark = async (r, status) => {
    await api.put(`/recalls/${r.id}`, { status });
    reload();
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Recall list</h1>
          <div className="muted">Patients due for hygiene/perio maintenance who are not yet scheduled.</div>
        </div>
        <div className="actions">
          <select value={window_} onChange={(e) => setWindow(Number(e.target.value))} style={{ width: 200 }}>
            <option value={0}>Overdue only</option>
            <option value={30}>Due within 30 days</option>
            <option value={60}>Due within 60 days</option>
            <option value={90}>Due within 90 days</option>
          </select>
        </div>
      </div>
      {notice && <div className="public-notice" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Patient</th><th>Type</th><th>Due</th><th>Phone</th><th>Email</th><th>Status</th><th /></tr></thead>
            <tbody>
              {recalls?.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/patients/${r.patient_id}`}>{r.first_name} {r.last_name}</Link></td>
                  <td>{label(r.type)}</td>
                  <td style={{ color: r.due_date < today ? 'var(--danger)' : undefined }}>{fmtDate(r.due_date)}{r.due_date < today ? ' (overdue)' : ''}</td>
                  <td>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : '—'}</td>
                  <td>{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : '—'}</td>
                  <td><Badge value={r.status} />{r.last_contacted_at && <div className="muted" style={{ fontSize: 11 }}>contacted {fmtDate(r.last_contacted_at)}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('schedule:write') && (
                      <>
                        <button className="small primary" onClick={() => remind(r)}>Send reminder</button>{' '}
                        <button className="small" onClick={() => mark(r, 'contacted')}>Contacted</button>{' '}
                        <button className="small" onClick={() => mark(r, 'inactive')}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {recalls?.length === 0 && <div className="empty">Nobody is due. 🎉</div>}
        </div>
      </div>
    </>
  );
}
