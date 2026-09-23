import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Surveys from '../components/Surveys.jsx';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtUtcDateTime } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';

// Starting wording for each segment; the office edits it before sending.
const STARTERS = {
  all_active: 'Hi {first_name}, a quick note from {practice}: our office will be closed on [date]. For anything urgent call {phone}.',
  reactivation: 'Hi {first_name}, we miss you at {practice}! It’s been a while since your last visit. Book a checkup: {booking_link}',
  unscheduled_treatment: 'Hi {first_name}, {practice} here. You still have treatment the doctor recommended — let’s get it scheduled before it becomes a bigger problem. Call {phone} or book: {booking_link}',
  recall_due: 'Hi {first_name}, you’re due for your cleaning and checkup at {practice}. Book a time that suits you: {booking_link}',
  birthdays: 'Happy birthday, {first_name}! 🎉 Everyone at {practice} hopes you have a wonderful day.',
  no_insurance: 'Hi {first_name}, no dental insurance? {practice} has a membership plan with cleanings, exams and x-rays included and a discount on everything else. Call {phone} to join.',
};

// Campaigns and patient surveys.
export default function Campaigns() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'surveys' ? 'surveys' : 'campaigns';
  return (
    <>
      <div className="tabs" style={{ marginBottom: 12 }}>
        <button className={tab === 'campaigns' ? 'active' : ''} onClick={() => setParams({})}>Campaigns</button>
        <button className={tab === 'surveys' ? 'active' : ''} onClick={() => setParams({ tab: 'surveys' })}>Surveys</button>
      </div>
      {tab === 'surveys' ? <Surveys /> : <CampaignList />}
    </>
  );
}

function CampaignList() {
  const { can, practice } = useAuth();
  const { data: list, reload } = useApi('/campaigns');
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Campaigns</h1>
          <div className="muted">Text or email a group of patients at once — reactivation, unscheduled treatment, birthdays, office news. Opted-out patients are skipped, families get one message, and nothing goes out outside 9am–8pm.</div>
        </div>
        {can('patients:write') && <button className="primary" onClick={() => setEditing({ name: '', segment: 'reactivation', params: { months: 18 }, channel: 'auto', subject: '', body: STARTERS.reactivation })}>+ New campaign</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {!list ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">No campaigns yet.</div> : (
          <table>
            <thead><tr><th>Campaign</th><th>Audience</th><th>Status</th><th>Sent</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: 12 }}>{c.created_by_name} · {fmtUtcDateTime(c.created_at, practice?.timezone)}</div></td>
                  <td>{c.segment.replace(/_/g, ' ')}</td>
                  <td><Badge value={c.status} />{c.status === 'scheduled' && <div className="muted" style={{ fontSize: 12 }}>{fmtUtcDateTime(c.send_at, practice?.timezone)}</div>}</td>
                  <td>{c.status === 'draft' ? '—' : `${c.sent_count} of ${c.recipients}${c.failed_count ? ` · ${c.failed_count} failed` : ''}`}</td>
                  <td>
                    {c.status === 'draft' && can('patients:write') ? <button className="small" onClick={() => setEditing(c)}>Edit</button> : <button className="small" onClick={() => setViewing(c.id)}>Results</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <Editor campaign={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {viewing && <Results id={viewing} onClose={() => { setViewing(null); reload(); }} />}
    </>
  );
}

function Editor({ campaign, onClose, onDone }) {
  const { data: meta } = useApi('/campaigns/segments');
  const [c, setC] = useState(campaign);
  const [preview, setPreview] = useState(null);
  const [when, setWhen] = useState('');
  const set = (patch) => setC({ ...c, ...patch });
  useEffect(() => {
    const t = setTimeout(() => api.post('/campaigns/preview', { segment: c.segment, params: c.params, channel: c.channel, body: c.body }).then(setPreview).catch((e) => setPreview({ error: e })), 300);
    return () => clearTimeout(t);
  }, [c.segment, JSON.stringify(c.params), c.channel, c.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => (c.id ? api.put(`/campaigns/${c.id}`, c) : api.post('/campaigns', c));
  const draft = useSubmit(async () => { await save(); onDone(); });
  const send = useSubmit(async () => {
    const saved = await save();
    const n = preview?.recipients ?? 0;
    if (!window.confirm(when ? `Schedule this for ${n} recipients?` : `Send this to ${n} recipients now?`)) return;
    await api.post(`/campaigns/${saved.id}/send`, when ? { send_at: new Date(when).toISOString() } : {});
    onDone();
  });
  if (!meta) return null;
  const seg = meta.segments[c.segment];
  return (
    <Modal title={c.id ? `Edit “${campaign.name}”` : 'New campaign'} wide onClose={onClose}>
      <ErrorBox error={draft.error || send.error} />
      <div className="form-editor">
        <div>
          <div className="form-grid">
            <label className="full">Name (for you)<input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Spring reactivation" /></label>
            <label className="full">
              Who
              <select value={c.segment} onChange={(e) => { const s = e.target.value; set({ segment: s, params: Object.fromEntries(meta.segments[s].params.map((p) => [p.key, p.default ?? ''])), body: c.body && Object.values(STARTERS).includes(c.body) ? STARTERS[s] : c.body || STARTERS[s] }); }}>
                {Object.entries(meta.segments).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 12 }}>{seg.help}</span>
            </label>
            {seg.params.map((p) => (
              <label key={p.key}>{p.label}<input type="number" value={c.params[p.key] ?? ''} placeholder={p.key === 'month' ? 'this month' : ''} onChange={(e) => set({ params: { ...c.params, [p.key]: e.target.value } })} /></label>
            ))}
            <label>Ages from<input type="number" min="0" value={c.params.min_age ?? ''} onChange={(e) => set({ params: { ...c.params, min_age: e.target.value } })} /></label>
            <label>to<input type="number" min="0" value={c.params.max_age ?? ''} onChange={(e) => set({ params: { ...c.params, max_age: e.target.value } })} /></label>
            <label>
              Send by
              <select value={c.channel} onChange={(e) => set({ channel: e.target.value })}>
                <option value="auto">Text, or email if no mobile</option><option value="sms">Text only</option><option value="email">Email only</option>
              </select>
            </label>
            {c.channel !== 'sms' && <label>Email subject<input value={c.subject || ''} onChange={(e) => set({ subject: e.target.value })} placeholder="From your practice" /></label>}
            <label className="full">
              Message
              <textarea rows={5} value={c.body} onChange={(e) => set({ body: e.target.value })} />
              <span className="muted" style={{ fontSize: 12 }}>Merge fields: {meta.vars.map((v) => `{${v}}`).join(' ')} · don’t include health details in marketing messages.</span>
            </label>
            <label className="full">Send at (leave empty to send now)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          </div>
        </div>
        <div className="form-preview">
          <h3>Audience</h3>
          {!preview ? <div className="muted">Counting…</div> : preview.error ? <ErrorBox error={preview.error} /> : (
            <>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{preview.recipients} {preview.recipients === 1 ? 'message' : 'messages'}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {preview.sms} by text · {preview.email} by email · {preview.patients} patients in the group
                {preview.duplicates > 0 && ` · ${preview.duplicates} share a phone or email with someone else`}
                {preview.unreachable > 0 && ` · ${preview.unreachable} can't be reached or opted out`}
              </div>
              {preview.sample && <div className="sms-preview" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{preview.sample}</div>}
              <div style={{ marginTop: 10, maxHeight: 220, overflow: 'auto', fontSize: 13 }}>
                {preview.list.map((r) => <div key={`${r.id}${r.channel}`}>{r.first_name} {r.last_name} <span className="muted">· {r.channel === 'sms' ? 'text' : 'email'}</span></div>)}
                {preview.recipients > preview.list.length && <div className="muted">…and {preview.recipients - preview.list.length} more</div>}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="form-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" disabled={draft.busy || !c.name} onClick={draft.submit}>Save draft</button>
        <button className="primary" disabled={send.busy || !c.name || !preview?.recipients} onClick={send.submit}>{when ? 'Schedule' : 'Send now'}</button>
      </div>
    </Modal>
  );
}

function Results({ id, onClose }) {
  const { data: c, reload } = useApi(`/campaigns/${id}`);
  const { can } = useAuth();
  const cancel = useSubmit(async () => { await api.post(`/campaigns/${id}/cancel`); reload(); });
  if (!c) return null;
  return (
    <Modal title={c.name} wide onClose={onClose}>
      <ErrorBox error={cancel.error} />
      <div className="inline" style={{ gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
        <span><Badge value={c.status} /></span>
        <span><strong>{c.sent_count}</strong> sent of {c.recipients}</span>
        {c.failed_count > 0 && <span style={{ color: 'var(--danger)' }}>{c.failed_count} failed</span>}
        <span><strong>{c.booked}</strong> have booked since</span>
        <span>{c.unsubscribed} unsubscribed</span>
        {['scheduled', 'sending'].includes(c.status) && can('patients:write') && <button className="small danger" onClick={cancel.submit}>Stop sending</button>}
      </div>
      {c.status === 'scheduled' && <div className="muted">Waiting to start{c.recipients === 0 ? ' (messages only go out between 9am and 8pm)' : ''}.</div>}
      <div className="sms-preview" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{c.body}</div>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        <table>
          <thead><tr><th>Patient</th><th>To</th><th>Status</th><th>Booked since</th></tr></thead>
          <tbody>
            {c.recipient_list.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/patients/${r.patient_id}`}>{r.first_name} {r.last_name}</Link></td>
                <td>{r.to_address}</td>
                <td><Badge value={r.status} />{r.unsubscribed_at && <span className="muted"> · unsubscribed</span>}{r.error && <div className="muted" style={{ fontSize: 12 }}>{r.error}</div>}</td>
                <td>{r.booked > 0 ? '✓' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
