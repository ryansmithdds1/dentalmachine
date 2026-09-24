import { useEffect, useState } from 'react';
import { Mail, Send, Eye, Sparkles } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtUtcDateTime } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import './digests.css';

// Settings → Metric emails: who gets the morning huddle, end-of-day, weekly and monthly emails, when (in the
// practice's time zone), for which office; a live preview; a test send; and the log of every email that went
// (or didn't — those also land in Needs attention). Changes save as they're made.
const STATUS = { active: 'On', paused: 'Paused', unsubscribed: 'Unsubscribed (by them)' };

export default function Digests() {
  const { practice } = useAuth();
  const { data, error, reload } = useApi('/digests');
  const [adding, setAdding] = useState({ user_id: '', digest: 'huddle' });
  const [previewOf, setPreviewOf] = useState(null); // { sub } or { digest, audience }
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (!previewOf) return undefined;
    let alive = true;
    setPreview(null);
    const path = previewOf.sub ? `/digests/subscriptions/${previewOf.sub.id}/preview` : `/digests/preview?digest=${previewOf.digest}&audience=${previewOf.audience}`;
    api.get(`${path}${path.includes('?') ? '&' : '?'}ai=1`).then((p) => alive && setPreview(p)).catch((e) => alive && setErr(e));
    return () => { alive = false; };
  }, [previewOf]);

  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!data) return <div className="card">Loading…</div>;
  const run = async (key, fn) => {
    setErr(null);
    setBusy(key);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const save = (sub, patch) => run(`s${sub.id}`, async () => { await api.put(`/digests/subscriptions/${sub.id}`, patch); reload(); toast('Saved'); });
  const person = data.people.find((p) => String(p.id) === String(adding.user_id));
  const add = () => run('add', async () => {
    const sub = await api.post('/digests/subscriptions', { user_id: Number(adding.user_id), digest: adding.digest });
    setAdding({ user_id: '', digest: adding.digest });
    reload();
    toast(`${sub.user_name} will get the ${data.digests[sub.digest].label.toLowerCase()} email`);
  });

  return (
    <div className="card dg">
      <div className="dg-head">
        <div>
          <h2 style={{ margin: 0 }}><Mail size={18} aria-hidden="true" /> Metric emails</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            The numbers that matter, in everyone’s inbox: a morning huddle, an end-of-day recap, and weekly and monthly summaries with trends,
            goals and the two or three things most worth working on. Times are in the practice’s time zone ({data.timezone}). Patient names are shortened to a first name and initial.
          </p>
        </div>
      </div>
      <ErrorBox error={err} />

      <label className="dg-toggle">
        <input type="checkbox" checked={!!data.settings.ai_summary} disabled={busy === 'ai'} onChange={(e) => run('ai', async () => { await api.put('/digests/settings', { ai_summary: e.target.checked }); reload(); })} />
        <span><Sparkles size={14} aria-hidden="true" /> Add a short summary written by AI to each email</span>
      </label>
      <p className="muted dg-note">
        {data.ai_available ? 'It’s clearly labelled “Written by AI” and is written from the totals only — no patient names or details are sent to the AI.' : 'AI isn’t set up on this server, so emails go without a summary.'}
      </p>

      <label className="dg-toggle">
        <input type="checkbox" checked={data.settings.names !== false} disabled={busy === 'names'} onChange={(e) => run('names', async () => { await api.put('/digests/settings', { names: e.target.checked }); reload(); })} />
        <span>Show patients’ first names and last initials in the lists (e.g. “Jane D.”)</span>
      </label>
      <p className="muted dg-note">Turn this off unless your email provider is covered by a business associate agreement — the lists then show only how many, with a link into Dental Machine.</p>

      <h3>Who gets what</h3>
      <form className="dg-add" onSubmit={(e) => { e.preventDefault(); if (adding.user_id) add(); }}>
        <select aria-label="Person" value={adding.user_id} onChange={(e) => setAdding({ ...adding, user_id: e.target.value })}>
          <option value="">Choose a person…</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
        </select>
        <select aria-label="Email" value={adding.digest} onChange={(e) => setAdding({ ...adding, digest: e.target.value })}>
          {Object.entries(data.digests).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
        </select>
        <button className="primary" disabled={!adding.user_id || busy === 'add'}>Add</button>
        {person && <span className="muted" style={{ fontSize: 12.5 }}>As {data.audiences[person.default_audience].toLowerCase()}, at {data.digests[adding.digest].time} — change it below.</span>}
      </form>

      <div className="dg-table-wrap">
        <table className="compact-table dg-table">
          <thead><tr><th>Person</th><th>Email</th><th>Written for</th><th>Sends at</th><th>Office</th><th>Status</th><th>Last sent</th><th /></tr></thead>
          <tbody>
            {data.subscriptions.map((s) => (
              <tr key={s.id} className={s.status !== 'active' ? 'dg-off' : ''}>
                <td>{s.user_name}<div className="muted" style={{ fontSize: 12 }}>{s.email}</div></td>
                <td>{data.digests[s.digest].label}<div className="muted" style={{ fontSize: 12 }}>{data.digests[s.digest].when}</div></td>
                <td>
                  <select aria-label={`Written for (${s.user_name})`} value={s.audience} onChange={(e) => save(s, { audience: e.target.value })}>
                    {Object.entries(data.audiences).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </td>
                <td><input aria-label={`Send time (${s.user_name})`} type="time" defaultValue={s.send_time} onBlur={(e) => e.target.value && e.target.value !== s.send_time && save(s, { send_time: e.target.value })} /></td>
                <td>
                  {data.locations.length > 1 ? (
                    <select aria-label={`Office (${s.user_name})`} value={s.location_id || ''} onChange={(e) => save(s, { location_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">All offices</option>
                      {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  ) : <span className="muted">All</span>}
                </td>
                <td>
                  {s.status === 'unsubscribed' ? <span className="badge warn nocap" title="They used the link in the email. Only they can turn it back on.">{STATUS[s.status]}</span> : (
                    <label className="dg-switch">
                      <input type="checkbox" checked={s.status === 'active'} onChange={(e) => save(s, { status: e.target.checked ? 'active' : 'paused' })} />
                      {STATUS[s.status]}
                    </label>
                  )}
                </td>
                <td>{s.last_sent_at ? <>{fmtUtcDateTime(s.last_sent_at, practice?.timezone)} {s.last_status === 'failed' && <span className="badge danger">failed</span>}</> : <span className="muted">Not yet</span>}</td>
                <td>
                  <div className="inline" style={{ gap: 6 }}>
                    <button className="small" onClick={() => setPreviewOf({ sub: s })}><Eye size={13} aria-hidden="true" /> Preview</button>
                    <button className="small" title={`Send it to ${s.email} now, marked [Test]`} disabled={s.status === 'unsubscribed' || busy === `t${s.id}`} onClick={() => run(`t${s.id}`, async () => { await api.post(`/digests/subscriptions/${s.id}/test`); reload(); toast(`Test sent to ${s.email}`); })}>
                      <Send size={13} aria-hidden="true" /> Test
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!data.subscriptions.length && <tr><td colSpan={8} className="muted">No one gets metric emails yet. Add the owner’s weekly summary to start.</td></tr>}
          </tbody>
        </table>
      </div>
      {!data.subscriptions.length && (
        <div className="inline" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 13 }}>See what they look like:</span>
          {Object.entries(data.digests).map(([k, d]) => <button key={k} className="small" onClick={() => setPreviewOf({ digest: k, audience: 'owner' })}>{d.label}</button>)}
        </div>
      )}

      {previewOf && (
        <section className="dg-preview" aria-label="Email preview">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>{preview?.subject || 'Building the preview…'}</b>
              <div className="muted" style={{ fontSize: 12 }}>Preview with today’s numbers{previewOf.sub ? ` · as ${previewOf.sub.user_name} would get it` : ''}{preview?.ai ? ' · includes the AI summary' : ''}</div>
            </div>
            <button className="small" onClick={() => { setPreviewOf(null); setPreview(null); }}>Close preview</button>
          </div>
          {preview?.ai_error && <p className="muted" style={{ fontSize: 12 }}>The AI summary couldn’t be written just now ({preview.ai_error}); the email would go without it.</p>}
          {/* The email's own HTML, in a sandboxed frame (no scripts, links open in a new tab). */}
          {preview && <iframe className="dg-frame" title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={preview.html.replace('<head>', '<head><base target="_blank">')} />}
        </section>
      )}

      <h3>What went</h3>
      <div className="dg-table-wrap">
        <table className="compact-table">
          <thead><tr><th>When</th><th>To</th><th>Email</th><th>For</th><th>Result</th></tr></thead>
          <tbody>
            {data.log.map((l) => (
              <tr key={l.id}>
                <td>{fmtUtcDateTime(l.created_at, practice?.timezone)}</td>
                <td>{l.user_name}</td>
                <td>{data.digests[l.digest].label}{l.period_key.startsWith('test:') ? ' (test)' : ''}{l.ai_summary ? ' · AI summary' : ''}</td>
                <td className="muted">{l.period_key.startsWith('test:') ? '—' : l.period_key.split(':')[1]}</td>
                <td>
                  <span className={`badge ${l.status === 'sent' ? (l.delivery === 'bounced' ? 'danger' : 'ok') : l.status === 'failed' ? 'danger' : 'info'}`}>
                    {l.status === 'sent' ? (l.delivery === 'bounced' ? 'bounced' : l.delivery === 'delivered' ? 'delivered' : 'sent') : l.status}
                  </span>
                  {l.attempts > 1 && <span className="muted" style={{ fontSize: 12 }}> · try {l.attempts}</span>}
                  {l.error && <div className="muted" style={{ fontSize: 12 }}>{l.error}</div>}
                </td>
              </tr>
            ))}
            {!data.log.length && <tr><td colSpan={5} className="muted">Nothing sent yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
