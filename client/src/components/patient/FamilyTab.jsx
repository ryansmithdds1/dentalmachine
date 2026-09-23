import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime, age } from '../../format.js';
import { ErrorBox, Modal, PatientPicker, useSubmit } from '../ui.jsx';

// Household view: everyone the guarantor is responsible for, with balances, visits and recall.
export default function FamilyTab({ patient, onChange }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, reload } = useApi(`/patients/${patient.id}/family`);
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
      onChange?.();
    } catch (e) {
      setErr(e);
    }
  };
  if (!data) return <div className="empty">Loading…</div>;
  const g = data.guarantor;

  return (
    <>
      <ErrorBox error={err} />
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>{g.last_name} family</h2>
            <div className="muted">Guarantor: <Link to={`/patients/${g.id}`}>{g.first_name} {g.last_name}</Link> · {[g.address, g.city, g.state].filter(Boolean).join(', ') || 'no address'}</div>
          </div>
          <div className="actions">
            <div style={{ textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 12 }}>Family balance</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: data.family_balance > 0 ? 'var(--danger)' : undefined }}>{money(data.family_balance)}</div>
            </div>
            <Link to={`/patients/${g.id}/statement?family=1`}><button>Family statement</button></Link>
            {can('patients:write') && <button onClick={() => setModal('link')}>Link existing patient</button>}
            {can('patients:write') && <button className="primary" onClick={() => setModal('new')}>+ Add family member</button>}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Age</th><th>Next visit</th><th>Recall due</th><th className="num">Balance</th><th /></tr></thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => nav(`/patients/${m.id}`)} style={m.id === patient.id ? { background: 'var(--primary-soft)' } : undefined}>
                  <td>
                    <strong>{m.first_name} {m.last_name}</strong>
                    {m.id === g.id && <span className="badge ok" style={{ marginLeft: 6 }}>Guarantor</span>}
                    {m.medical_alerts && <span className="alert-chip" style={{ marginLeft: 6 }} title={m.medical_alerts}>⚠</span>}
                  </td>
                  <td>{m.dob ? age(m.dob) : '—'}</td>
                  <td>{m.next_appointment ? fmtDateTime(m.next_appointment) : <span className="muted">None</span>}</td>
                  <td>{m.recall_due ? fmtDate(m.recall_due) : '—'}</td>
                  <td className="num">{money(m.balance)}</td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {can('patients:write') && m.id !== g.id && (
                      <>
                        <button className="small" onClick={() => act(() => api.post(`/patients/${m.id}/family/guarantor`))}>Make guarantor</button>{' '}
                        <button className="small danger" onClick={() => confirm(`Remove ${m.first_name} from this family?`) && act(() => api.del(`/patients/${g.id}/family/${m.id}`))}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'new' && (
        <Modal title="Add family member" onClose={() => setModal(null)}>
          <NewMember guarantor={g} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal === 'link' && (
        <Modal title="Link an existing patient" onClose={() => setModal(null)}>
          <LinkMember guarantor={g} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

function NewMember({ guarantor, onDone }) {
  const [form, setForm] = useState({ first_name: '', last_name: guarantor.last_name, dob: '', gender: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${guarantor.id}/family`, form);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>First name<input required value={form.first_name} onChange={set('first_name')} /></label>
        <label>Last name<input value={form.last_name} onChange={set('last_name')} /></label>
        <label>Date of birth<input type="date" value={form.dob} onChange={set('dob')} /></label>
        <label>Gender<select value={form.gender} onChange={set('gender')}><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Address, phone and email are copied from the guarantor.</p>
      <div className="form-actions"><button className="primary" disabled={busy}>Add to family</button></div>
    </form>
  );
}

function LinkMember({ guarantor, onDone }) {
  const [p, setP] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${guarantor.id}/family`, { patient_id: p.id });
    onDone();
  });
  return (
    <div>
      <ErrorBox error={error} />
      <PatientPicker value={p} onChange={setP} />
      <div className="form-actions"><button className="primary" disabled={!p || busy} onClick={submit}>Link to {guarantor.first_name}&apos;s family</button></div>
    </div>
  );
}
