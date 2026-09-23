import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Star } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';

// Online reviews: the office's Google listing, answered from here — AI drafts replies that never confirm
// someone is a patient (the HIPAA trap), and staff edit and post them.
const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—');

export default function Reputation() {
  const { user, can } = useAuth();
  const [params] = useSearchParams();
  const { data, reload, error } = useApi('/reputation');
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('');
  const run = async (fn) => { setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const s = data.summary;
  const shown = data.reviews.filter((r) => (filter === 'unanswered' ? r.reply_status !== 'posted' : filter === 'negative' ? r.rating && r.rating <= 3 : true));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reviews</h1>
          <div className="muted">Your Google reviews in one place, answered in minutes. Low ratings become a task to reply the same day.</div>
        </div>
        {data.connected && <button onClick={() => run(() => api.post('/reputation/sync'))}>Check for new reviews</button>}
      </div>
      {params.get('google') === 'error' && <div className="error">{params.get('message') || 'Google didn’t connect.'}</div>}
      <ErrorBox error={err} />
      {!data.connected ? (
        <div className="card">
          <h2>Connect your Google Business Profile</h2>
          <p className="muted">Sign in with the Google account that manages your listing. We read your reviews and post the replies you approve — nothing else.</p>
          {data.mode ? (user.role === 'admin' ? <button className="primary" onClick={() => run(async () => { window.location.href = (await api.get('/reputation/google/connect')).url; })}>Connect Google</button> : <div className="muted">An administrator can connect it.</div>)
            : <div className="muted">Google isn’t set up on this server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</div>}
        </div>
      ) : (
        <>
          <div className="stat-strip">
            <div><strong><Star size={16} /> {s.rating ?? '—'}</strong><span>{s.count} reviews</span></div>
            <div><strong>{s.rating_90 ?? '—'}</strong><span>last 90 days ({s.count_90})</span></div>
            <div><strong>{s.reply_rate != null ? `${s.reply_rate}%` : '—'}</strong><span>answered</span></div>
            <div><strong className={s.unanswered_negative ? 'text-danger' : ''}>{s.unanswered_negative}</strong><span>low ratings waiting on a reply</span></div>
            <div><strong>{s.requests_sent_90}</strong><span>review requests sent (90 days)</span></div>
            {s.survey_count > 0 && <div><strong>{s.survey_nps_avg}</strong><span>survey score ({s.survey_count})</span></div>}
          </div>
          <div className="tabs" style={{ margin: '12px 0' }}>
            {[['', 'All'], ['unanswered', 'Not answered'], ['negative', '3 stars or less']].map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          {shown.map((r) => <Review key={r.id} review={r} canWrite={can('patients:write')} onChange={reload} />)}
          {!shown.length && <div className="card empty">Nothing here.</div>}
          <div className="muted" style={{ fontSize: 12 }}>Connected to {data.connection.location_title}{data.connection.synced_at ? ` · checked ${fmtDate(data.connection.synced_at.slice(0, 10))}` : ''}.{user.role === 'admin' && <> <button className="link" onClick={() => window.confirm('Disconnect Google?') && run(() => api.del('/reputation/google'))}>Disconnect</button></>}</div>
        </>
      )}
    </>
  );
}

function Review({ review: r, canWrite, onChange }) {
  const [text, setText] = useState(r.reply_status === 'posted' ? null : r.reply || '');
  const [busy, setBusy] = useState(false);
  const [caution, setCaution] = useState(null);
  const [drafted, setDrafted] = useState(false);
  const [err, setErr] = useState(null);
  const act = async (fn) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <div><strong>{r.author}</strong> <span style={{ color: r.rating <= 3 ? 'var(--danger)' : 'var(--warn)', letterSpacing: 1 }}>{stars(r.rating)}</span></div>
        <span className="muted" style={{ fontSize: 12 }}>{r.posted_at ? fmtDate(r.posted_at.slice(0, 10)) : ''}</span>
      </div>
      {r.text ? <p style={{ margin: '6px 0' }}>{r.text}</p> : <p className="muted" style={{ margin: '6px 0' }}>(Rating only)</p>}
      {r.reply_status === 'posted' ? (
        <div style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10, fontSize: 13 }}><span className="muted">Your reply:</span> {r.reply}</div>
      ) : canWrite && (
        <div>
          <ErrorBox error={err} />
          <textarea rows={3} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply, or let AI draft one" aria-label="Reply" />
          {caution && <div className="text-warn" style={{ fontSize: 12 }}>{caution}</div>}
          <div className="muted" style={{ fontSize: 11 }}>Never confirm they’re a patient or mention their care — even to thank them.</div>
          <div className="form-actions">
            <button disabled={busy} onClick={() => act(async () => { const d = await api.post(`/reviews/${r.id}/draft`); setText(d.reply); setCaution(d.caution); setDrafted(true); })}>Draft with AI</button>
            <button className="primary" disabled={busy || !text?.trim()} onClick={() => act(async () => { await api.post(`/reviews/${r.id}/reply`, { text, ai_drafted: drafted }); onChange(); })}>Post reply</button>
          </div>
        </div>
      )}
    </div>
  );
}
