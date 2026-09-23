import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { fmtDate } from '../../format.js';

// What a dental lab sees from the office's link: the prescription, the files, and a way to say the case
// arrived, is in production, has shipped (with tracking), or to ask a question. No account needed.
export default function LabCasePage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ status: 'received', tracking_number: '', due_date: '', note: '' });
  const [done, setDone] = useState(null);
  const load = () => api.get(`/public/lab/${token}`).then(setD).catch(setError);
  useEffect(() => { load(); }, [token]);
  const send = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/public/lab/${token}/status`, form);
      setDone(d.updates[form.status]);
      load();
    } catch (err) { setError(err); }
  };
  if (error && !d) return <div className="public-page"><div className="card"><ErrorBox error={error} /></div></div>;
  if (!d) return <div className="empty">Loading…</div>;
  const c = d.case;
  return (
    <div className="public-page" style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: 0 }}>{c.description}</h1>
            <div className="muted">Case #{c.id} from <strong>{d.practice.name}</strong>{d.practice.phone ? ` · ${d.practice.phone}` : ''}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div>Sent {fmtDate(c.sent_date)}</div>
            <div><strong>Due back {c.due_date ? fmtDate(c.due_date) : '—'}</strong></div>
            {d.appointment && <div className="muted">Patient seats {fmtDate(d.appointment)}</div>}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>Patient: <strong>{d.patient.name}</strong>{d.patient.age != null ? `, ${d.patient.age}` : ''}{d.patient.gender ? `, ${d.patient.gender}` : ''}</div>
        <table style={{ marginTop: 12 }}>
          <tbody>
            {Object.entries(d.fields).filter(([k]) => d.rx[k]).map(([k, label]) => <tr key={k}><th style={{ width: 180 }}>{label}</th><td style={{ whiteSpace: 'pre-wrap' }}>{d.rx[k]}</td></tr>)}
            {c.notes && <tr><th>Notes</th><td>{c.notes}</td></tr>}
          </tbody>
        </table>
        {d.provider && <div className="muted" style={{ marginTop: 8 }}>Prescribed by {d.provider.name}{d.provider.license_number ? ` · Lic. ${d.provider.license_number}` : ''}{d.provider.npi ? ` · NPI ${d.provider.npi}` : ''}</div>}
      </div>
      {d.files.length > 0 && (
        <div className="card">
          <h2>Files</h2>
          {d.files.map((f) => <div key={f.id}><a href={`/api/public/lab/${token}/files/${f.id}`}>{f.filename}</a> <span className="muted" style={{ fontSize: 12 }}>{f.category}</span></div>)}
        </div>
      )}
      <form className="card" onSubmit={send}>
        <h2>Update the office</h2>
        {c.lab_status && <div className="muted" style={{ marginBottom: 8 }}>Last update: {d.updates[c.lab_status]}{c.tracking_number ? ` · tracking ${c.tracking_number}` : ''}</div>}
        <ErrorBox error={error} />
        {done && <div className="public-notice ok" style={{ marginBottom: 8 }}>Sent: {done}. Thank you.</div>}
        <div className="form-grid">
          <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{Object.entries(d.updates).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {form.status === 'shipped' && <label>Tracking number<input value={form.tracking_number} onChange={(e) => setForm({ ...form, tracking_number: e.target.value })} /></label>}
          <label>New due date (if it changes)<input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
          <label className="full">{form.status === 'question' ? 'Your question' : 'Note (optional)'}<textarea rows={2} required={form.status === 'question'} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        </div>
        <div className="form-actions"><button className="primary">Send update</button></div>
      </form>
    </div>
  );
}
