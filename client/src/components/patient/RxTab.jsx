import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtUtcDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// Prescriptions: favorites, allergy check, printable Rx.
export default function RxTab({ patient }) {
  const { can, practice } = useAuth();
  const { data: list, reload } = useApi(`/patients/${patient.id}/prescriptions`);
  const favorites = useLookup('/rx/favorites');
  const providers = useLookup('/providers?active=true').filter((p) => p.type !== 'hygienist');
  const [form, setForm] = useState({ provider_id: '', drug: '', strength: '', sig: '', quantity: '', refills: 0, dispense_as_written: false, notes: '' });
  const [warning, setWarning] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async (override = false) => {
    setWarning(null);
    try {
      const rx = await api.post(`/patients/${patient.id}/prescriptions`, { ...form, provider_id: Number(form.provider_id || providers[0]?.id), override_allergy: override });
      setForm({ ...form, drug: '', strength: '', sig: '', quantity: '', refills: 0, notes: '' });
      reload();
      window.open(`/prescriptions/${rx.id}/print`, '_blank');
    } catch (e) {
      if (e.details?.allergy_warning) setWarning(e.message);
      else throw e;
    }
  });

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      {can('clinical:sign') && (
        <div className="card">
          <h2>New prescription</h2>
          {patient.allergies && <div className="alert-chip" style={{ marginBottom: 10 }}>Allergies: {patient.allergies}</div>}
          <div className="chips" style={{ marginBottom: 12 }}>
            {favorites.map((f) => <button key={f.drug} type="button" className="chip" onClick={() => setForm({ ...form, ...f })}>{f.drug}</button>)}
          </div>
          <ErrorBox error={error} />
          {warning && (
            <div className="error">
              ⚠ {warning}
              <div style={{ marginTop: 6 }}><button className="small danger" onClick={() => submit(true)}>Prescribe anyway (documented override)</button></div>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="form-grid">
            <label>Prescriber<select value={form.provider_id} onChange={set('provider_id')}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Drug<input required value={form.drug} onChange={set('drug')} /></label>
            <label>Strength / form<input value={form.strength} onChange={set('strength')} /></label>
            <label>Quantity<input required value={form.quantity} onChange={set('quantity')} /></label>
            <label className="full">Sig (directions)<input required value={form.sig} onChange={set('sig')} /></label>
            <label>Refills<input type="number" min="0" max="11" value={form.refills} onChange={set('refills')} /></label>
            <label className="checkbox" style={{ alignSelf: 'end' }}><input type="checkbox" checked={form.dispense_as_written} onChange={set('dispense_as_written')} /> Dispense as written</label>
            <label className="full">Notes to pharmacist<input value={form.notes} onChange={set('notes')} /></label>
            <div className="form-actions full"><button className="primary" disabled={busy}>Save & print</button></div>
          </form>
          <p className="muted" style={{ fontSize: 12 }}>Printed prescriptions only. Controlled substances need an EPCS-certified e-prescribing service.</p>
        </div>
      )}
      <div className="card">
        <h2>History</h2>
        {list?.length === 0 && <div className="muted">No prescriptions.</div>}
        {list?.map((rx) => (
          <div key={rx.id} className="rx-row">
            <div>
              <strong>{rx.drug}</strong> {rx.strength}
              <div className="muted" style={{ fontSize: 12 }}>{rx.sig} · #{rx.quantity} · {rx.refills} refills</div>
              <div className="muted" style={{ fontSize: 12 }}>{fmtUtcDate(rx.created_at, practice?.timezone)} · {rx.provider_name}</div>
            </div>
            <button className="small" onClick={() => window.open(`/prescriptions/${rx.id}/print`, '_blank')}>Reprint</button>
          </div>
        ))}
      </div>
    </div>
  );
}
