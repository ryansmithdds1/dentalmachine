import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
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
            {can('schedule:write') && data.members.length > 1 && <button onClick={() => setModal('book')}>Book family visit</button>}
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

      {modal === 'book' && (
        <Modal title={`Book the ${g.last_name} family`} wide onClose={() => setModal(null)}>
          <FamilyBooking members={data.members} onDone={(appts) => { setModal(null); reload(); onChange?.(); if (appts?.length) nav(`/schedule?date=${appts[0].start_time.slice(0, 10)}`); }} />
        </Modal>
      )}
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

// Several family members in one trip: back to back in one chair, or side by side at the same time.
function FamilyBooking({ members, onDone }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const types = useLookup('/appointment-types?active=true');
  const [form, setForm] = useState({ date: new Date().toLocaleDateString('en-CA'), time: '15:00', mode: 'back_to_back', provider_id: '', operatory_id: '' });
  const [rows, setRows] = useState(() => members.map((m) => ({ patient_id: m.id, name: `${m.first_name} ${m.last_name}`, on: true, appointment_type_id: '', duration: 60, provider_id: '', operatory_id: '' })));
  const [override, setOverride] = useState(false);
  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.on);
  const side = form.mode === 'side_by_side';
  const { submit, busy, error } = useSubmit(async () => {
    const appts = await api.post('/appointments/family', {
      mode: form.mode, start_time: `${form.date} ${form.time}`, provider_id: form.provider_id ? Number(form.provider_id) : undefined,
      operatory_id: form.operatory_id ? Number(form.operatory_id) : undefined, override_blockout: override,
      members: chosen.map((r) => ({
        patient_id: r.patient_id, appointment_type_id: r.appointment_type_id ? Number(r.appointment_type_id) : undefined, duration: Number(r.duration),
        ...(side ? { provider_id: r.provider_id ? Number(r.provider_id) : undefined, operatory_id: r.operatory_id ? Number(r.operatory_id) : undefined } : {}),
      })),
    }).catch((e) => {
      if (e.details?.can_override) setOverride(true);
      throw e;
    });
    onDone(appts);
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {override && <div className="public-notice" style={{ marginBottom: 8 }}>Submit again to book anyway.</div>}
      <div className="form-grid">
        <label>Date<input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
        <label>First start time<input type="time" required step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
        <label>
          Arrangement
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="back_to_back">Back to back (one after another)</option>
            <option value="side_by_side">Side by side (same time, different chairs)</option>
          </select>
        </label>
        {!side && (
          <>
            <label>Provider<select required value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}><option value="">Select…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Chair<select value={form.operatory_id} onChange={(e) => setForm({ ...form, operatory_id: e.target.value })}><option value="">—</option>{operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          </>
        )}
      </div>
      <table className="compact-table" style={{ marginTop: 12 }}>
        <thead><tr><th /><th>Who</th><th>Visit</th><th>Minutes</th>{side && <><th>Provider</th><th>Chair</th></>}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.patient_id} style={{ opacity: r.on ? 1 : 0.5 }}>
              <td><input type="checkbox" checked={r.on} onChange={(e) => setRow(i, { on: e.target.checked })} /></td>
              <td>{r.name}</td>
              <td>
                <select value={r.appointment_type_id} onChange={(e) => { const t = types.find((x) => String(x.id) === e.target.value); setRow(i, { appointment_type_id: e.target.value, ...(t ? { duration: t.duration } : {}) }); }}>
                  <option value="">—</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td><input type="number" min="5" step="5" value={r.duration} onChange={(e) => setRow(i, { duration: e.target.value })} style={{ width: 70 }} /></td>
              {side && (
                <>
                  <td><select required={r.on} value={r.provider_id} onChange={(e) => setRow(i, { provider_id: e.target.value })}><option value="">Select…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
                  <td><select value={r.operatory_id} onChange={(e) => setRow(i, { operatory_id: e.target.value })}><option value="">—</option>{operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-actions"><button className="primary" disabled={busy || chosen.length < 2}>Book {chosen.length} visits</button></div>
    </form>
  );
}
