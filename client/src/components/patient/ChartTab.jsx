import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, label } from '../../format.js';
import Odontogram, { CONDITION_COLORS } from '../Odontogram.jsx';
import { Badge, ErrorBox, useSubmit } from '../ui.jsx';

const SURFACES = ['M', 'O', 'D', 'B', 'L', 'I', 'F'];

export default function ChartTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/patients/${patient.id}/chart`);
  const codes = useLookup('/procedure-codes?active=true');
  const providers = useLookup('/providers?active=true');
  const [tooth, setTooth] = useState(null);
  const [surfaces, setSurfaces] = useState('');
  const [mode, setMode] = useState('procedure');
  const [cond, setCond] = useState('caries');
  const [codeId, setCodeId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [complete, setComplete] = useState(false);

  const toggleSurface = (s) => setSurfaces(surfaces.includes(s) ? surfaces.replace(s, '') : surfaces + s);
  const refresh = () => { reload(); onChange?.(); setSurfaces(''); };

  const { submit, busy, error } = useSubmit(async () => {
    if (mode === 'condition') {
      await api.post(`/patients/${patient.id}/conditions`, { tooth, surfaces, condition: cond });
    } else {
      await api.post(`/patients/${patient.id}/procedures`, {
        code_id: Number(codeId), tooth: tooth || null, surfaces: surfaces || null,
        provider_id: providerId ? Number(providerId) : patient.primary_provider_id, complete,
      });
    }
    refresh();
  });

  const resolve = async (c) => {
    await api.put(`/conditions/${c.id}`, { resolved: true });
    reload();
  };

  if (!data) return <div className="empty">Loading chart…</div>;
  const code = codes.find((c) => String(c.id) === String(codeId));
  const toothConditions = data.conditions.filter((c) => !tooth || c.tooth === tooth);
  const toothProcs = data.procedures.filter((p) => !tooth || p.tooth === tooth);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)' }}>
      <div className="card" style={{ overflowX: 'auto' }}>
        <Odontogram conditions={data.conditions} procedures={data.procedures} selected={tooth} onSelect={setTooth} />
      </div>

      {can('clinical:write') && (
        <div className="card">
          <h2>{tooth ? `Tooth #${tooth}` : 'No tooth selected'}</h2>
          <ErrorBox error={error} />
          <div className="tabs" style={{ marginBottom: 12 }}>
            <button className={mode === 'procedure' ? 'active' : ''} onClick={() => setMode('procedure')}>Procedure</button>
            <button className={mode === 'condition' ? 'active' : ''} onClick={() => setMode('condition')} disabled={!tooth}>Condition</button>
          </div>
          <label>Surfaces</label>
          <div className="inline" style={{ margin: '4px 0 12px' }}>
            {SURFACES.map((s) => (
              <button key={s} type="button" className={`small${surfaces.includes(s) ? ' primary' : ''}`} onClick={() => toggleSurface(s)} disabled={!tooth}>{s}</button>
            ))}
          </div>
          {mode === 'condition' ? (
            <label>
              Condition
              <select value={cond} onChange={(e) => setCond(e.target.value)}>
                {Object.keys(CONDITION_COLORS).map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select>
            </label>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label>
                Procedure
                <select value={codeId} onChange={(e) => setCodeId(e.target.value)}>
                  <option value="">Select a code…</option>
                  {codes.map((c) => <option key={c.id} value={c.id}>{c.code} – {c.description} ({money(c.fee)})</option>)}
                </select>
              </label>
              <label>
                Provider
                <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">Patient&apos;s primary provider</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="checkbox"><input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} /> Mark completed today (posts charge)</label>
              {code?.requires_tooth === 1 && !tooth && <div className="muted">Select a tooth on the chart.</div>}
            </div>
          )}
          <div className="form-actions">
            <button className="primary" disabled={busy || (mode === 'procedure' && !codeId) || (mode === 'condition' && !tooth)} onClick={submit}>
              {mode === 'condition' ? 'Add condition' : complete ? 'Chart as completed' : 'Add to plan'}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>{tooth ? `History for #${tooth}` : 'Charted findings & procedures'}</h2>
        <div className="grid grid-2">
          <div>
            <h3>Conditions</h3>
            <table>
              <tbody>
                {toothConditions.map((c) => (
                  <tr key={c.id} style={{ opacity: c.resolved ? 0.5 : 1 }}>
                    <td>#{c.tooth} {c.surfaces}</td>
                    <td><span className="badge" style={{ background: `${CONDITION_COLORS[c.condition]}22`, color: CONDITION_COLORS[c.condition] }}>{label(c.condition)}</span></td>
                    <td className="muted">{fmtDate(c.recorded_at)}</td>
                    <td>{!c.resolved && can('clinical:write') && <button className="small" onClick={() => resolve(c)}>Resolve</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!toothConditions.length && <div className="muted">None recorded.</div>}
          </div>
          <div>
            <h3>Procedures</h3>
            <table>
              <tbody>
                {toothProcs.map((p) => (
                  <tr key={p.id}>
                    <td>{p.code}</td>
                    <td>{p.description}<div className="muted">{p.tooth ? `#${p.tooth} ` : ''}{p.surfaces || ''} {p.provider_name ? `· ${p.provider_name}` : ''}</div></td>
                    <td><Badge value={p.status} /></td>
                    <td className="muted">{fmtDate(p.completed_at || p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!toothProcs.length && <div className="muted">None recorded.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
