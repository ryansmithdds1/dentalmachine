import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fullName, age, fmtDateTime } from '../format.js';
import { Modal } from '../components/ui.jsx';
import NewPatientQuick from '../components/NewPatientQuick.jsx';

const PAGE = 25;

export default function Patients() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('active');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  // ?new=1 (from quick search "New patient") opens the form; &phone= (from a caller or texter not on file)
  // starts it with their number.
  const [urlParams, setUrlParams] = useSearchParams();
  const [prefill, setPrefill] = useState(null);
  useEffect(() => {
    if (urlParams.get('new') !== '1') return;
    setPrefill(urlParams.get('phone') ? { phone: urlParams.get('phone').slice(0, 30) } : null);
    setAdding(true);
    setUrlParams({}, { replace: true });
  }, [urlParams, setUrlParams]);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(q); setOffset(0); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useApi(`/patients?q=${encodeURIComponent(debounced)}&status=${status}&limit=${PAGE}&offset=${offset}`);

  return (
    <>
      <div className="page-header">
        <h1>Patients</h1>
        <div className="actions">
          <input placeholder="Search name, phone, email, DOB (YYYY-MM-DD) or ID" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 340 }} autoFocus />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ width: 130 }} aria-label="Status">
            <option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option><option value="all">All</option>
          </select>
          {can('patients:write') && <button className="primary" onClick={() => setAdding(true)}>+ New patient</button>}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>DOB</th><th>Phone</th><th>Email</th><th>Next appointment</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {data?.rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/patients/${p.id}`)}>
                  <td>
                    <strong>{fullName(p)}</strong>
                    {p.medical_alerts && <span className="alert-chip" style={{ marginLeft: 6 }} title={p.medical_alerts}>⚠ Alert</span>}
                  </td>
                  <td>{p.dob ? `${p.dob} (${age(p.dob)})` : '—'}</td>
                  <td>{p.phone || '—'}</td>
                  <td>{p.email || '—'}</td>
                  <td>{p.next_appointment ? fmtDateTime(p.next_appointment) : <span className="muted">None</span>}</td>
                  <td className="num" style={{ color: p.balance > 0 ? 'var(--danger)' : undefined }}>{money(p.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">No patients found.</div>}
        </div>
        {data && data.total > PAGE && (
          <div className="inline" style={{ padding: 12, justifyContent: 'space-between' }}>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
            <div className="inline">
              <button disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>Previous</button>
              <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          </div>
        )}
      </div>
      {adding && (
        <Modal title="New patient" wide onClose={() => setAdding(false)}>
          {/* Workflow 32: one line typed the way the caller says it, with their insurance (docs/workflows/specs/32-new-patient.md). */}
          <NewPatientQuick defaults={prefill} onCancel={() => setAdding(false)} onSaved={(p) => nav(`/patients/${p.id}`)} />
        </Modal>
      )}
    </>
  );
}
