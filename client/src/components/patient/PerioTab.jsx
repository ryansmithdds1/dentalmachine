import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
const SITES = ['DB', 'B', 'MB', 'DL', 'L', 'ML'];
// Readings are stored distal→mesial ([DB, B, MB, DL, L, ML]). On screen, mesial always faces the midline,
// so on the patient's left (teeth 9-24) each tooth's sites display the other way round.
const siteOrder = (tooth, from) => (Number(tooth) >= 9 && Number(tooth) <= 24 ? [from + 2, from + 1, from] : [from, from + 1, from + 2]);
const depthColor = (d) => (d == null || d === '' ? undefined : d >= 5 ? 'var(--danger)' : d === 4 ? 'var(--warn)' : undefined);

// Six-site probing depths per tooth, entered buccal row then lingual row.
export default function PerioTab({ patient }) {
  const { can } = useAuth();
  const { data: exams, reload } = useApi(`/patients/${patient.id}/perio`);
  const [readings, setReadings] = useState({});
  const [viewing, setViewing] = useState(null);
  const [bleedMode, setBleedMode] = useState(false);
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
                  {siteOrder(t, from).map((i) => {
                    const d = get(t).pd[i];
                    return editable ? (
                      <input key={i} value={d ?? ''} onChange={(e) => setDepth(t, i, e.target.value)} readOnly={bleedMode}
                        onClick={() => bleedMode && toggleBop(t, i)}
                        onContextMenu={(e) => { e.preventDefault(); toggleBop(t, i); }}
                        title={`${SITES[i]} · ${bleedMode ? 'tap to toggle bleeding' : 'right-click toggles bleeding'}`}
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
          {editable && <button className={bleedMode ? 'active' : ''} aria-pressed={bleedMode} onClick={() => setBleedMode(!bleedMode)} title="Tap sites to mark bleeding (for touch screens)">🩸 Bleeding {bleedMode ? 'on' : 'off'}</button>}
          {editable && <button className="primary" disabled={busy || !Object.keys(readings).length} onClick={submit}>Save exam</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      <PerioSummary current={shown} previous={viewing ? exams?.[exams.findIndex((x) => x.id === viewing.id) + 1] : exams?.[0]} />
      <div className="muted" style={{ marginBottom: 8 }}>Depths in mm. <span style={{ color: 'var(--warn)' }}>4mm</span> · <span style={{ color: 'var(--danger)' }}>5mm+</span> · shaded = bleeding on probing{editable ? ' (right-click a site, or turn on 🩸 and tap)' : ''}. Mesial sites face the midline.</div>
      <div className="table-wrap">
        {renderArch(UPPER)}
        <div style={{ height: 12 }} />
        {renderArch(LOWER)}
      </div>
    </div>
  );
}

// Perio summary: bleeding %, pocket counts and change vs the prior exam (what insurers and patients care about).
export function perioStats(readings) {
  let sites = 0, bleeding = 0, p4 = 0, p5 = 0, deepest = 0;
  for (const v of Object.values(readings || {})) {
    v.pd.forEach((d, i) => {
      if (d === '' || d == null) return;
      const n = Number(d);
      sites++;
      if (v.bop?.[i]) bleeding++;
      if (n >= 4) p4++;
      if (n >= 5) p5++;
      deepest = Math.max(deepest, n);
    });
  }
  return { sites, bop_pct: sites ? Math.round((bleeding / sites) * 100) : 0, p4, p5, deepest };
}

function PerioSummary({ current, previous }) {
  const now = perioStats(current);
  if (!now.sites) return null;
  const prev = previous ? perioStats(previous.readings) : null;
  const delta = (k, lowerIsBetter = true) => {
    if (!prev?.sites) return null;
    const d = now[k] - prev[k];
    if (!d) return <span className="muted"> ±0</span>;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return <span style={{ color: good ? 'var(--ok)' : 'var(--danger)' }}> {d > 0 ? '▲' : '▼'}{Math.abs(d)}</span>;
  };
  return (
    <div className="perio-summary">
      <div><strong>{now.sites}</strong><span>sites charted</span></div>
      <div><strong className={now.bop_pct > 30 ? 'text-danger' : ''}>{now.bop_pct}%{delta('bop_pct')}</strong><span>bleeding on probing</span></div>
      <div><strong>{now.p4}{delta('p4')}</strong><span>pockets ≥ 4 mm</span></div>
      <div><strong className={now.p5 ? 'text-danger' : ''}>{now.p5}{delta('p5')}</strong><span>pockets ≥ 5 mm</span></div>
      <div><strong>{now.deepest} mm</strong><span>deepest</span></div>
      {prev?.sites ? <div className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>vs {fmtDate(previous.exam_date)}</div> : null}
    </div>
  );
}
