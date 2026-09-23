import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
const SITES = ['DB', 'B', 'MB', 'DL', 'L', 'ML'];
const depthColor = (d) => (d == null || d === '' ? undefined : d >= 5 ? 'var(--danger)' : d === 4 ? 'var(--warn)' : undefined);

// Six-site probing depths per tooth, entered buccal row then lingual row.
export default function PerioTab({ patient }) {
  const { can } = useAuth();
  const { data: exams, reload } = useApi(`/patients/${patient.id}/perio`);
  const [readings, setReadings] = useState({});
  const [viewing, setViewing] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    const clean = {};
    for (const [tooth, v] of Object.entries(readings)) {
      const pd = v.pd.map((d) => (d === '' || d == null ? null : Number(d)));
      if (pd.some((d) => d != null) || v.bop.some(Boolean)) clean[tooth] = { pd, bop: v.bop };
    }
    await api.post(`/patients/${patient.id}/perio`, { readings: clean });
    setReadings({});
    reload();
  });

  const shown = viewing ? viewing.readings : readings;
  const editable = !viewing && can('clinical:write');
  const get = (tooth) => shown[tooth] || { pd: Array(6).fill(''), bop: Array(6).fill(false) };
  const setDepth = (tooth, i, value) => {
    const cur = get(tooth);
    const pd = [...cur.pd];
    pd[i] = value.replace(/\D/g, '').slice(0, 2);
    setReadings({ ...readings, [tooth]: { ...cur, pd } });
  };
  const toggleBop = (tooth, i) => {
    const cur = get(tooth);
    const bop = [...cur.bop];
    bop[i] = !bop[i];
    setReadings({ ...readings, [tooth]: { ...cur, bop } });
  };

  const renderArch = (teeth) => (
    <table style={{ tableLayout: 'fixed', minWidth: 900 }}>
      <thead><tr><th style={{ width: 70 }} />{teeth.map((t) => <th key={t} style={{ textAlign: 'center', padding: 4 }}>{t}</th>)}</tr></thead>
      <tbody>
        {[[0, 3, 'Buccal'], [3, 6, 'Lingual']].map(([from, to, side]) => (
          <tr key={side}>
            <td className="muted" style={{ fontSize: 11 }}>{side}</td>
            {teeth.map((t) => (
              <td key={t} style={{ padding: 2 }}>
                <div style={{ display: 'flex', gap: 1 }}>
                  {get(t).pd.slice(from, to).map((d, k) => {
                    const i = from + k;
                    return editable ? (
                      <input key={i} value={d ?? ''} onChange={(e) => setDepth(t, i, e.target.value)}
                        onContextMenu={(e) => { e.preventDefault(); toggleBop(t, i); }}
                        title={`${SITES[i]} · right-click toggles bleeding`}
                        style={{ padding: '2px 0', textAlign: 'center', fontSize: 12, color: depthColor(Number(d)), background: get(t).bop[i] ? 'var(--danger-soft)' : undefined }} />
                    ) : (
                      <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 12, color: depthColor(d), background: get(t).bop?.[i] ? 'var(--danger-soft)' : undefined }}>{d ?? '·'}</span>
                    );
                  })}
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{viewing ? `Perio exam ${fmtDate(viewing.exam_date)}` : 'New periodontal exam'}</h2>
        <div className="actions">
          <select value={viewing?.id || ''} onChange={(e) => setViewing(exams.find((x) => String(x.id) === e.target.value) || null)} style={{ width: 200 }}>
            <option value="">{can('clinical:write') ? 'New exam' : 'Select an exam'}</option>
            {exams?.map((x) => <option key={x.id} value={x.id}>{fmtDate(x.exam_date)}</option>)}
          </select>
          {editable && <button className="primary" disabled={busy || !Object.keys(readings).length} onClick={submit}>Save exam</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="muted" style={{ marginBottom: 8 }}>Depths in mm. <span style={{ color: 'var(--warn)' }}>4mm</span> · <span style={{ color: 'var(--danger)' }}>5mm+</span> · shaded = bleeding on probing{editable ? ' (right-click a site to toggle)' : ''}.</div>
      <div className="table-wrap">
        {renderArch(UPPER)}
        <div style={{ height: 12 }} />
        {renderArch(LOWER)}
      </div>
    </div>
  );
}
