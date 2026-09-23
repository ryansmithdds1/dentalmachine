import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtUtcDateTime } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

const SCHEDULES = { '': 'Not emailed', daily: 'Every morning', weekly: 'Monday mornings', monthly: 'The 1st of each month' };

// Reports → Saved & scheduled: reports with their filters, emailed to the owner (or anyone) on a schedule.
export default function SavedReports() {
  const { practice } = useAuth();
  const { data, reload } = useApi('/saved-reports');
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (fn) => { setErr(null); try { await fn(); } catch (e) { setErr(e); } };
  if (!data) return <div className="card">Loading…</div>;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Saved & scheduled reports</h2>
          <div className="muted" style={{ fontSize: 13 }}>Save the numbers you check often, and have them emailed — the owner’s Monday-morning summary, a daily day sheet for the office manager.</div>
        </div>
        <button className="primary" onClick={() => setEditing({ name: '', report: 'production', params: { period: 'last_7' }, schedule: 'weekly', recipients: [] })}>+ Report</button>
      </div>
      <ErrorBox error={err} />
      <table className="compact-table" style={{ marginTop: 10 }}>
        <thead><tr><th>Name</th><th>Report</th><th>Emailed</th><th>To</th><th>Last sent</th><th /></tr></thead>
        <tbody>
          {data.saved.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{data.reports[s.report]}{s.params.period && s.report === 'production' ? ` · ${data.periods[s.params.period]}` : ''}</td>
              <td>{SCHEDULES[s.schedule || '']}</td>
              <td style={{ fontSize: 12 }}>{s.recipients.join(', ') || '—'}</td>
              <td>{s.last_sent_at ? fmtUtcDateTime(s.last_sent_at, practice?.timezone) : '—'}</td>
              <td>
                <div className="inline" style={{ gap: 6 }}>
                  <button className="small" onClick={() => run(async () => setPreview(await api.get(`/saved-reports/${s.id}/preview`)))}>View</button>
                  <button className="small" disabled={!s.recipients.length} onClick={() => run(async () => { const r = await api.post(`/saved-reports/${s.id}/send`); window.alert(`Emailed to ${r.sent}`); reload(); })}>Send now</button>
                  <button className="small" onClick={() => setEditing(s)}>Edit</button>
                  <button className="small danger" onClick={() => window.confirm(`Delete “${s.name}”?`) && run(async () => { await api.del(`/saved-reports/${s.id}`); reload(); })}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {!data.saved.length && <tr><td colSpan={6} className="muted">No saved reports yet.</td></tr>}
        </tbody>
      </table>
      {editing && <SavedForm init={editing} meta={data} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {preview && <Modal title={preview.subject} onClose={() => setPreview(null)}><pre className="report-preview">{preview.body}</pre></Modal>}
    </div>
  );
}

function SavedForm({ init, meta, onClose, onDone }) {
  const [f, setF] = useState({ ...init, recipients: (init.recipients || []).join(', '), schedule: init.schedule || '' });
  const providers = useLookup('/providers');
  const offices = useLookup('/locations');
  const setP = (k, v) => setF({ ...f, params: { ...f.params, [k]: v || undefined } });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { name: f.name, report: f.report, params: f.params, schedule: f.schedule || null, recipients: f.recipients };
    if (init.id) await api.put(`/saved-reports/${init.id}`, body);
    else await api.post('/saved-reports', body);
    onDone();
  });
  return (
    <Modal title={init.id ? 'Edit saved report' : 'New saved report'} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Monday numbers" /></label>
        <label>Report<select value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })}>{Object.entries(meta.reports).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {f.report === 'production' && <label>Dates<select value={f.params?.period || 'mtd'} onChange={(e) => setP('period', e.target.value)}>{Object.entries(meta.periods).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        {f.report === 'production' && <label>Provider<select value={f.params?.provider_id || ''} onChange={(e) => setP('provider_id', e.target.value)}><option value="">All</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        {f.report !== 'aging' && offices.length > 0 && <label>Office<select value={f.params?.location_id || ''} onChange={(e) => setP('location_id', e.target.value)}><option value="">All offices</option>{offices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        <label>Email it<select value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })}>{Object.entries(SCHEDULES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="full">To (emails, separated by commas)<input value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} placeholder="owner@example.com" /></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Emails carry totals only — no patient names.</p>
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name} onClick={submit}>Save</button></div>
    </Modal>
  );
}
