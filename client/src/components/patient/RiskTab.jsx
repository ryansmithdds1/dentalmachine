import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// Caries (CAMBRA) and periodontal risk: answered here, started from what the chart already shows, with what
// each level means for recalls, x-rays and home care. And education pages to send for their treatment.
const LEVEL = { low: 'ok', moderate: 'warn', high: 'danger', extreme: 'danger' };

export default function RiskTab({ patient }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/patients/${patient.id}/risk`);
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="grid grid-2">
        <Assessment kind="caries" title="Caries risk (CAMBRA)" data={data} patient={patient} canWrite={can('clinical:write')} onSaved={reload} />
        <Assessment kind="perio" title="Periodontal risk" data={data} patient={patient} canWrite={can('clinical:write')} onSaved={reload} />
      </div>
      <Education patient={patient} canWrite={can('patients:write')} />
    </>
  );
}

function Assessment({ kind, title, data, patient, canWrite, onSaved }) {
  const last = data[kind];
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState(() => ({ ...data.from_chart[kind], ...(last?.answers || {}) }));
  const [applyRecall, setApplyRecall] = useState(true);
  const save = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/risk`, { kind, answers, apply_recall: applyRecall });
    setEditing(false);
    onSaved();
  });
  const q = data.questions[kind];
  const check = (k, label) => <label key={k} className="checkbox" style={{ display: 'block' }}><input type="checkbox" checked={!!answers[k]} onChange={(e) => setAnswers({ ...answers, [k]: e.target.checked })} /> {label}</label>;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {last && <span className={`badge ${LEVEL[last.level]}`}>{last.level}</span>}
      </div>
      {last ? (
        <div style={{ fontSize: 13, marginTop: 6 }}>
          <div className="muted">Assessed {fmtDate(last.created_at.slice(0, 10))}{last.by_name ? ` by ${last.by_name}` : ''}</div>
          <div>Recall every <strong>{last.result.recall_months} months</strong>{last.result.bitewings ? <> · bitewings {last.result.bitewings}</> : null}</div>
          {last.result.recommend?.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{last.result.recommend.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      ) : <div className="muted" style={{ marginTop: 6 }}>Not assessed yet.</div>}
      {canWrite && !editing && <button className="small" style={{ marginTop: 6 }} onClick={() => setEditing(true)}>{last ? 'Reassess' : 'Assess'}</button>}
      {editing && (
        <div style={{ marginTop: 8 }}>
          <ErrorBox error={save.error} />
          {kind === 'caries' ? (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Disease indicators</div>{Object.entries(q.disease).map(([k, l]) => check(k, l))}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Risk factors</div>{Object.entries(q.factors).map(([k, l]) => check(k, l))}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Protective factors</div>{Object.entries(q.protective).map(([k, l]) => check(k, l))}
            </>
          ) : (
            <div className="form-grid">
              {Object.entries(q).map(([k, l]) => (k === 'family_history' ? check(k, l) : (
                <label key={k}>{l}<input type="number" min="0" step="any" value={answers[k] ?? ''} onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })} /></label>
              )))}
            </div>
          )}
          {data.from_chart.perio.exam_date && kind === 'perio' && <div className="muted" style={{ fontSize: 11 }}>Bleeding and pockets filled in from the perio chart of {fmtDate(data.from_chart.perio.exam_date)}.</div>}
          <label className="checkbox" style={{ marginTop: 6 }}><input type="checkbox" checked={applyRecall} onChange={(e) => setApplyRecall(e.target.checked)} /> Set the recall interval to match</label>
          <div className="form-actions"><button onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={save.busy} onClick={save.submit}>Save</button></div>
        </div>
      )}
    </div>
  );
}

function Education({ patient, canWrite }) {
  const { data, reload } = useApi(`/patients/${patient.id}/education`);
  const [picked, setPicked] = useState(null);
  const [channel, setChannel] = useState('sms');
  const [done, setDone] = useState(null);
  const send = useSubmit(async () => {
    const r = await api.post(`/patients/${patient.id}/education`, { slugs: chosen, channel });
    setDone(r.status === 'sent' ? 'Sent.' : `Not sent: ${r.error || r.status}`);
    reload();
  });
  if (!data) return null;
  const chosen = picked ?? data.suggested;
  return (
    <div className="card">
      <h2>Patient education</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Short pages about their treatment, sent as a link. Pages matching their plan are ticked.</p>
      <ErrorBox error={send.error} />
      <div style={{ columns: 2, fontSize: 13 }}>
        {data.articles.map((a) => <label key={a.slug} className="checkbox" style={{ display: 'block' }}><input type="checkbox" checked={chosen.includes(a.slug)} onChange={(e) => setPicked(e.target.checked ? [...chosen, a.slug] : chosen.filter((s) => s !== a.slug))} /> {a.title}</label>)}
      </div>
      {canWrite && (
        <div className="inline" style={{ gap: 8, marginTop: 8 }}>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Send by"><option value="sms">Text</option><option value="email">Email</option></select>
          <button className="primary small" disabled={!chosen.length || send.busy} onClick={send.submit}>Send {chosen.length || ''}</button>
          {done && <span className="muted">{done}</span>}
        </div>
      )}
      {data.sent.length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Last sent {fmtDate(data.sent[0].created_at.slice(0, 10))}</div>}
    </div>
  );
}
