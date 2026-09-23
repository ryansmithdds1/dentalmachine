import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, toCents, fromCents } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';

export default function InsuranceTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data: policies, reload } = useApi(`/patients/${patient.id}/insurance`);
  const { data: claims, reload: reloadClaims } = useApi(can('billing:read') ? `/claims?patient_id=${patient.id}` : null);
  const { data: unclaimed, reload: reloadUnclaimed } = useApi(can('billing:read') ? `/patients/${patient.id}/unclaimed-procedures` : null);
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState([]);
  const [err, setErr] = useState(null);
  const refresh = () => { reload(); reloadClaims(); reloadUnclaimed(); onChange?.(); };
  const active = policies?.filter((p) => p.active) || [];

  const createClaim = async () => {
    setErr(null);
    try {
      await api.post('/claims', { patient_insurance_id: active[0].id, procedure_ids: selected });
      setSelected([]);
      refresh();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Coverage</h2>
          {can('patients:write') && <button className="primary" onClick={() => setModal({ policy: null })}>+ Add policy</button>}
        </div>
        {policies?.length === 0 && <div className="muted">No insurance on file (self-pay).</div>}
        {policies?.length > 0 && (
          <table>
            <thead><tr><th>Priority</th><th>Carrier</th><th>Subscriber</th><th>Member ID / Group</th><th>Coverage (P/B/M)</th><th className="num">Annual max</th><th className="num">Deductible</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td><Badge value={p.active ? p.priority : 'inactive'} /></td>
                  <td>{p.carrier_name}</td>
                  <td>{p.subscriber_name}<div className="muted">{p.relationship}</div></td>
                  <td>{p.subscriber_id}<div className="muted">{p.group_number}</div></td>
                  <td>{p.pct_preventive}% / {p.pct_basic}% / {p.pct_major}%</td>
                  <td className="num">{money(p.annual_max)}</td>
                  <td className="num">{money(p.deductible_met)} of {money(p.deductible)}</td>
                  <td>{can('patients:write') && <button className="small" onClick={() => setModal({ policy: p })}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {can('billing:read') && (
        <div className="card">
          <h2>Claims</h2>
          <ErrorBox error={err} />
          {unclaimed?.length > 0 && active.length > 0 && can('billing:write') && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--warn-soft)', borderRadius: 8 }}>
              <strong>Completed procedures not yet billed to insurance</strong>
              {unclaimed.map((p) => (
                <label key={p.id} className="checkbox" style={{ color: 'var(--text)', marginTop: 6 }}>
                  <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                  {fmtDate(p.completed_at)} · {p.code} {p.description} {p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''} · {money(p.fee)}
                </label>
              ))}
              <div className="inline" style={{ marginTop: 8 }}>
                <button className="small" onClick={() => setSelected(unclaimed.map((p) => p.id))}>Select all</button>
                <button className="small primary" disabled={!selected.length} onClick={createClaim}>Create claim to {active[0].carrier_name}</button>
              </div>
            </div>
          )}
          {claims?.length === 0 ? <div className="muted">No claims.</div> : (
            <table>
              <thead><tr><th>Claim</th><th>Created</th><th>Carrier</th><th>Status</th><th className="num">Billed</th><th className="num">Estimated</th><th className="num">Paid</th></tr></thead>
              <tbody>
                {claims?.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/claims/${c.id}`}>#{c.id}</Link></td>
                    <td>{fmtDate(c.created_at)}</td>
                    <td>{c.carrier_name}</td>
                    <td><Badge value={c.status} /></td>
                    <td className="num">{money(c.total_fee)}</td>
                    <td className="num">{money(c.estimated_amount)}</td>
                    <td className="num">{money(c.paid_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {modal && (
        <Modal title={modal.policy ? 'Edit policy' : 'Add insurance policy'} wide onClose={() => setModal(null)}>
          <PolicyForm patient={patient} policy={modal.policy} onDone={() => { setModal(null); refresh(); }} />
        </Modal>
      )}
    </>
  );
}

function PolicyForm({ patient, policy, onDone }) {
  const carriers = useLookup('/carriers');
  const [form, setForm] = useState(() => ({
    carrier_id: policy?.carrier_id || '',
    priority: policy?.priority || 'primary',
    subscriber_name: policy?.subscriber_name || `${patient.first_name} ${patient.last_name}`,
    subscriber_id: policy?.subscriber_id || '',
    subscriber_dob: policy?.subscriber_dob || patient.dob || '',
    relationship: policy?.relationship || 'self',
    group_number: policy?.group_number || '',
    annual_max: fromCents(policy?.annual_max ?? 150000),
    deductible: fromCents(policy?.deductible ?? 5000),
    deductible_met: fromCents(policy?.deductible_met ?? 0),
    pct_preventive: policy?.pct_preventive ?? 100,
    pct_basic: policy?.pct_basic ?? 80,
    pct_major: policy?.pct_major ?? 50,
    active: policy ? !!policy.active : true,
  }));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const body = {
      ...form, carrier_id: Number(form.carrier_id),
      annual_max: toCents(form.annual_max), deductible: toCents(form.deductible), deductible_met: toCents(form.deductible_met),
      pct_preventive: Number(form.pct_preventive), pct_basic: Number(form.pct_basic), pct_major: Number(form.pct_major),
    };
    if (policy) await api.put(`/insurance/${policy.id}`, body);
    else await api.post(`/patients/${patient.id}/insurance`, body);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {carriers.length === 0 && <div className="error">No carriers set up yet — add one under Settings → Insurance carriers.</div>}
      <div className="form-grid">
        <label>
          Carrier *
          <select required value={form.carrier_id} onChange={set('carrier_id')}>
            <option value="">Select…</option>
            {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Priority<select value={form.priority} onChange={set('priority')}><option value="primary">Primary</option><option value="secondary">Secondary</option></select></label>
        <label>Subscriber name *<input required value={form.subscriber_name} onChange={set('subscriber_name')} /></label>
        <label>Member ID *<input required value={form.subscriber_id} onChange={set('subscriber_id')} /></label>
        <label>Subscriber DOB<input type="date" value={form.subscriber_dob} onChange={set('subscriber_dob')} /></label>
        <label>
          Relationship
          <select value={form.relationship} onChange={set('relationship')}>
            <option value="self">Self</option><option value="spouse">Spouse</option><option value="child">Child</option><option value="other">Other</option>
          </select>
        </label>
        <label>Group #<input value={form.group_number} onChange={set('group_number')} /></label>
        <label>Annual max ($)<input type="number" step="0.01" value={form.annual_max} onChange={set('annual_max')} /></label>
        <label>Deductible ($)<input type="number" step="0.01" value={form.deductible} onChange={set('deductible')} /></label>
        <label>Deductible met ($)<input type="number" step="0.01" value={form.deductible_met} onChange={set('deductible_met')} /></label>
        <label>Preventive %<input type="number" min="0" max="100" value={form.pct_preventive} onChange={set('pct_preventive')} /></label>
        <label>Basic %<input type="number" min="0" max="100" value={form.pct_basic} onChange={set('pct_basic')} /></label>
        <label>Major %<input type="number" min="0" max="100" value={form.pct_major} onChange={set('pct_major')} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save policy</button></div>
    </form>
  );
}
