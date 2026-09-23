import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';

export default function TreatmentTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data: plans, reload } = useApi(`/patients/${patient.id}/treatment-plans`);
  const { data: loose, reload: reloadLoose } = useApi(`/patients/${patient.id}/procedures?status=planned`);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const refresh = () => { reload(); reloadLoose(); onChange?.(); };

  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(e);
    }
  };

  const unplanned = loose?.filter((p) => !p.treatment_plan_id) || [];

  return (
    <>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Treatment plans</h2>
        {can('clinical:write') && <button className="primary" onClick={() => setCreating(true)}>+ New treatment plan</button>}
      </div>
      <ErrorBox error={err} />
      {plans?.length === 0 && unplanned.length === 0 && <div className="card empty">No treatment planned.</div>}

      {plans?.map((plan) => (
        <div className="card" key={plan.id}>
          <div className="page-header" style={{ marginBottom: 10 }}>
            <div>
              <h3 style={{ margin: 0 }}>{plan.name} <Badge value={plan.status} /></h3>
              <div className="muted">Created {fmtDate(plan.created_at)}{plan.accepted_at ? ` · Accepted ${fmtDate(plan.accepted_at)}` : ''}</div>
            </div>
            {can('clinical:write') && plan.status !== 'completed' && (
              <div className="actions">
                {plan.status !== 'accepted' && <button className="small" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' }))}>Patient accepted</button>}
                {plan.status === 'proposed' && <button className="small danger" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'rejected' }))}>Declined</button>}
              </div>
            )}
          </div>
          <ProcTable procs={plan.procedures} estimate={plan.estimate} canEdit={can('clinical:write')} act={act} />
        </div>
      ))}

      {unplanned.length > 0 && (
        <div className="card">
          <h3>Other planned procedures</h3>
          <ProcTable procs={unplanned} canEdit={can('clinical:write')} act={act} />
        </div>
      )}

      {creating && (
        <Modal title="New treatment plan" wide onClose={() => setCreating(false)}>
          <PlanBuilder patient={patient} onDone={() => { setCreating(false); refresh(); }} onCancel={() => setCreating(false)} />
        </Modal>
      )}
    </>
  );
}

function ProcTable({ procs, estimate, canEdit, act }) {
  const est = Object.fromEntries((estimate?.items || []).map((i) => [i.procedure_id, i]));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Code</th><th>Description</th><th>Tooth</th><th>Status</th><th className="num">Fee</th>{estimate && <><th className="num">Est. insurance</th><th className="num">Est. patient</th></>}<th /></tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.id}>
              <td>{p.priority}</td>
              <td>{p.code}</td>
              <td>{p.description}</td>
              <td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}</td>
              <td><Badge value={p.status} />{p.appointment_id && p.status === 'planned' ? <div className="muted" style={{ fontSize: 11 }}>scheduled</div> : null}</td>
              <td className="num">{money(p.fee)}</td>
              {estimate && <><td className="num">{est[p.id] ? money(est[p.id].insurance) : '—'}</td><td className="num">{est[p.id] ? money(est[p.id].patient) : '—'}</td></>}
              <td style={{ whiteSpace: 'nowrap' }}>
                {canEdit && p.status === 'planned' && (
                  <>
                    <button className="small" onClick={() => act(() => api.post(`/procedures/${p.id}/complete`))}>Complete</button>{' '}
                    <button className="small danger" onClick={() => confirm('Remove this procedure from the plan?') && act(() => api.post(`/procedures/${p.id}/cancel`))}>✕</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {estimate && (
            <tr className="totals-row">
              <td colSpan={5}>Remaining planned {estimate.policy ? `· ${estimate.policy.carrier_name}` : '· self-pay'}</td>
              <td className="num">{money(estimate.total_fee)}</td>
              <td className="num">{money(estimate.total_insurance)}</td>
              <td className="num">{money(estimate.total_patient)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PlanBuilder({ patient, onDone, onCancel }) {
  const codes = useLookup('/procedure-codes?active=true');
  const providers = useLookup('/providers?active=true');
  const [name, setName] = useState('Treatment plan');
  const [providerId, setProviderId] = useState(patient.primary_provider_id || '');
  const [items, setItems] = useState([{ code_id: '', tooth: '', surfaces: '' }]);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/treatment-plans`, {
      name,
      procedures: items.filter((i) => i.code_id).map((i) => ({
        code_id: Number(i.code_id), tooth: i.tooth || null, surfaces: i.surfaces || null, provider_id: providerId ? Number(providerId) : null,
      })),
    });
    onDone();
  });
  const setItem = (idx, k, v) => setItems(items.map((it, i) => (i === idx ? { ...it, [k]: v } : it)));
  const total = items.reduce((s, i) => s + (codes.find((c) => String(c.id) === String(i.code_id))?.fee || 0), 0);

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Plan name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <table style={{ marginTop: 14 }}>
        <thead><tr><th>Procedure</th><th style={{ width: 90 }}>Tooth</th><th style={{ width: 110 }}>Surfaces</th><th className="num">Fee</th><th /></tr></thead>
        <tbody>
          {items.map((it, idx) => {
            const code = codes.find((c) => String(c.id) === String(it.code_id));
            return (
              <tr key={idx}>
                <td>
                  <select value={it.code_id} onChange={(e) => setItem(idx, 'code_id', e.target.value)}>
                    <option value="">Select…</option>
                    {codes.map((c) => <option key={c.id} value={c.id}>{c.code} – {c.description}</option>)}
                  </select>
                </td>
                <td><input value={it.tooth} onChange={(e) => setItem(idx, 'tooth', e.target.value)} placeholder={code?.requires_tooth ? 'req.' : ''} /></td>
                <td><input value={it.surfaces} onChange={(e) => setItem(idx, 'surfaces', e.target.value.toUpperCase())} placeholder={code?.requires_surface ? 'e.g. MOD' : ''} /></td>
                <td className="num">{code ? money(code.fee) : ''}</td>
                <td><button type="button" className="small" onClick={() => setItems(items.filter((_, i) => i !== idx))}>✕</button></td>
              </tr>
            );
          })}
          <tr className="totals-row"><td colSpan={3}>Total</td><td className="num">{money(total)}</td><td /></tr>
        </tbody>
      </table>
      <button type="button" className="small" style={{ marginTop: 8 }} onClick={() => setItems([...items, { code_id: '', tooth: '', surfaces: '' }])}>+ Add procedure</button>
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>Create plan</button>
      </div>
    </form>
  );
}
