import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtUtcDateTime } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

const TYPE_LABEL = { nps: 'Recommend us (0–10)', rating: 'Stars (1–5)', yesno: 'Yes / no', text: 'Written answer' };

// Campaigns → Surveys: short patient surveys with an NPS score, sent after visits or to recent patients.
export default function Surveys() {
  const { user, can } = useAuth();
  const { data, error: loadError, reload } = useApi('/surveys');
  const [editing, setEditing] = useState(null);
  const [results, setResults] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  if (loadError) return <ErrorBox error={loadError} />; // e.g. no permission: say so, not "Loading…" for ever (e2e sweep)
  if (!data) return <div className="card">Loading…</div>;
  const admin = user.role === 'admin';
  const send = async (s) => {
    const days = window.prompt('Send to patients seen in the last how many days? (Anyone asked in the last 90 days is skipped.)', '30');
    if (!days) return;
    setErr(null);
    try { const r = await api.post(`/surveys/${s.id}/send`, { seen_within_days: Number(days) }); setNote(`Sent to ${r.sent}; ${r.skipped} couldn’t be reached.`); reload(); } catch (e) { setErr(e); }
  };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Surveys</h2>
          <div className="muted" style={{ fontSize: 13 }}>Ask patients how you’re doing and track your Net Promoter Score. One survey can go out automatically the day after each visit (at most once every 90 days per patient).</div>
        </div>
        {admin && <button className="primary" onClick={() => setEditing({ name: 'After-visit survey', questions: data.defaults, auto_after_visit: false, active: true })}>+ Survey</button>}
      </div>
      <ErrorBox error={err} />
      {note && <div className="public-notice ok" style={{ marginTop: 8 }}>{note}</div>}
      <table className="compact-table" style={{ marginTop: 10 }}>
        <thead><tr><th>Survey</th><th>Questions</th><th className="num">Sent</th><th className="num">Answered</th><th /></tr></thead>
        <tbody>
          {data.surveys.map((s) => (
            <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
              <td>{s.name}{s.auto_after_visit && <div className="muted" style={{ fontSize: 12 }}>Sent after every visit</div>}</td>
              <td>{s.questions.length}</td>
              <td className="num">{s.sent}</td>
              <td className="num">{s.answered}</td>
              <td>
                <div className="inline" style={{ gap: 6 }}>
                  <button className="small" onClick={() => setResults(s)}>Results</button>
                  {can('patients:write') && s.active && <button className="small" onClick={() => send(s)}>Send…</button>}
                  {admin && <button className="small" onClick={() => setEditing(s)}>Edit</button>}
                </div>
              </td>
            </tr>
          ))}
          {!data.surveys.length && <tr><td colSpan={5} className="muted">No surveys yet.</td></tr>}
        </tbody>
      </table>
      {editing && <SurveyForm init={editing} types={data.types} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {results && <Results survey={results} onClose={() => setResults(null)} />}
    </div>
  );
}

function SurveyForm({ init, types, onClose, onDone }) {
  const [f, setF] = useState({ ...init, questions: init.questions.map((q) => ({ ...q })) });
  const setQ = (i, patch) => setF({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { name: f.name, questions: f.questions, auto_after_visit: f.auto_after_visit, active: f.active };
    if (init.id) await api.put(`/surveys/${init.id}`, body);
    else await api.post('/surveys', body);
    onDone();
  });
  return (
    <Modal title={init.id ? 'Edit survey' : 'New survey'} wide onClose={onClose}>
      <ErrorBox error={error} />
      <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <h3>Questions</h3>
      {f.questions.map((q, i) => (
        <div key={i} className="form-grid" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 8 }}>
          <label>Kind<select value={q.type} onChange={(e) => setQ(i, { type: e.target.value })}>{types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
          <div className="inline" style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
            <button type="button" className="small" onClick={() => setF({ ...f, questions: f.questions.filter((_, j) => j !== i) })} aria-label={`Remove question ${i + 1}`}>Remove</button>
          </div>
          <label className="full">Question<input value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} /></label>
          <label className="full">In Spanish (optional)<input value={q.label_es || ''} lang="es" onChange={(e) => setQ(i, { label_es: e.target.value })} /></label>
        </div>
      ))}
      {f.questions.length < 10 && <button type="button" className="small" onClick={() => setF({ ...f, questions: [...f.questions, { type: 'rating', label: '' }] })}>+ Question</button>}
      <label className="checkbox" style={{ marginTop: 12 }}><input type="checkbox" checked={!!f.auto_after_visit} onChange={(e) => setF({ ...f, auto_after_visit: e.target.checked })} /> Send automatically the day after each visit</label>
      {init.id && <label className="checkbox"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name || !f.questions.length} onClick={submit}>Save</button></div>
    </Modal>
  );
}

function Results({ survey, onClose }) {
  const { practice } = useAuth();
  const { data } = useApi(`/surveys/${survey.id}/results`);
  return (
    <Modal title={`${survey.name} — results`} wide onClose={onClose}>
      {!data ? <p>Loading…</p> : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <div className="card stat"><div className="label">Net Promoter Score</div><div className="value">{data.nps ?? '—'}</div><div className="sub">−100 to +100</div></div>
            <div className="card stat"><div className="label">Answered</div><div className="value">{data.answered}</div><div className="sub">of {data.sent} sent</div></div>
            <div className="card stat"><div className="label">Response rate</div><div className="value">{data.response_rate == null ? '—' : `${data.response_rate}%`}</div></div>
          </div>
          {data.questions.map((q) => (
            <div key={q.id} style={{ marginBottom: 14 }}>
              <strong>{q.label}</strong> <span className="muted">· {q.count} answers</span>
              {q.type === 'nps' && q.count > 0 && (
                <div className="nps-bar" aria-label={`${q.promoters} promoters, ${q.passives} passives, ${q.detractors} detractors`}>
                  {q.promoters > 0 && <i className="pro" style={{ flex: q.promoters }}>Promoters {q.promoters}</i>}
                  {q.passives > 0 && <i className="pas" style={{ flex: q.passives }}>Passives {q.passives}</i>}
                  {q.detractors > 0 && <i className="det" style={{ flex: q.detractors }}>Detractors {q.detractors}</i>}
                </div>
              )}
              {q.type === 'rating' && <div>Average {q.average ?? '—'} ★</div>}
              {q.type === 'yesno' && <div>{q.yes} yes · {q.count - q.yes} no</div>}
              {q.type === 'text' && (
                <ul className="comments">
                  {q.comments.map((c, i) => <li key={i}>“{c.text}” <span className="muted">— <Link to={`/patients/${c.patient_id}`}>{c.name}</Link>, {fmtUtcDateTime(c.at, practice?.timezone)}{c.nps != null ? ` · ${c.nps}/10` : ''}</span></li>)}
                  {!q.comments.length && <li className="muted">No comments yet.</li>}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
