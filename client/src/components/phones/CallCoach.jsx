import { useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Sparkles } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { toast } from '../../toast.js';
import { fmtDateTime } from '../../format.js';
import NoBookReason from './NoBookReason.jsx';
import './phones.css';

// One call's coaching (PH3-PH5), under its transcript: the AI's read against the office's protocol (labelled AI,
// with the words it relied on), the owner's own rating and comments, why they didn't book, and any upset-caller
// alert with its acknowledgement. People see their own calls' scores; coaches see everyone's.
export default function CallCoach({ callId, canWrite }) {
  const { data: r, reload } = useApi(`/phones/calls/${callId}/review`);
  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const rescore = async () => {
    setBusy(true);
    try { await api.post(`/phones/calls/${callId}/score`); reload(); } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const rate = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/phones/calls/${callId}/reviews`, { rating: rating === '' ? null : Number(rating), comment });
      setRating(''); setComment(''); reload();
      toast('Coaching saved');
    } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  const ack = async (id) => {
    try { await api.post(`/phones/alerts/${id}/ack`, {}); reload(); toast('Alert acknowledged'); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div className="call-coach" style={{ marginTop: 12 }}>
      {r.alerts.map((a) => (
        <div key={a.id} className={`public-notice${a.status === 'open' ? ' warn' : ''}`} style={{ margin: '8px 0' }}>
          <AlertTriangle size={14} /> <strong>{a.kind === 'upset' ? 'Upset caller' : 'Alert'}</strong>{a.quote ? <> — “{a.quote}”</> : null}
          <span className="muted" style={{ fontSize: 12 }}> · {a.source === 'live' ? 'heard during the call' : a.source === 'ai' ? 'AI read of the transcript' : 'from the transcript'}</span>
          {a.status === 'open' ? <button type="button" className="small" style={{ marginLeft: 8 }} onClick={() => ack(a.id)}>Acknowledge</button>
            : <span className="muted" style={{ fontSize: 12 }}> · acknowledged by {a.ack_by_name} {fmtDateTime(a.ack_at)}{a.ack_note ? ` — ${a.ack_note}` : ''}</span>}
        </div>
      ))}
      {canWrite && r.show_no_book && (
        <NoBookReason callId={callId} suggested={r.no_book?.suggested_reason} quote={r.no_book?.suggested_quote} current={r.no_book?.reason} onSaved={reload} />
      )}
      {r.visible && (
        <div className="card" style={{ marginTop: 10, padding: 10 }}>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <strong>
              Against the protocol{r.call_type ? ` · ${r.call_type.replace('_', ' ')}` : ''}
              {r.effective_score != null && <span style={{ marginLeft: 8 }}>{r.effective_score}/100</span>}
              {r.effective_by === 'owner' && <span className="ai-label" style={{ marginLeft: 6 }}>owner’s rating</span>}
            </strong>
            {r.score && <span className="ai-label"><Sparkles size={11} /> {r.score.label}</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{r.coaching_note}</div>
          {r.score ? (
            <ul className="coach-steps">
              {r.score.steps.map((st) => (
                <li key={st.key}>
                  {st.met ? <CheckCircle2 size={13} className="met" /> : <XCircle size={13} className="unmet" />} {st.label}{st.required ? '' : <span className="muted"> (optional)</span>}
                  {st.quote && <blockquote>“{st.quote}”</blockquote>}
                  {st.note && <div className="muted" style={{ fontSize: 12, marginLeft: 18 }}>{st.note}</div>}
                </li>
              ))}
            </ul>
          ) : <div className="muted" style={{ fontSize: 13, margin: '6px 0' }}>Not scored yet{r.can_coach ? '' : ' — calls are scored after the recording is transcribed, when AI is on'}.</div>}
          {r.can_coach && <button type="button" className="small" disabled={busy} onClick={rescore}>{r.score ? 'Score again' : 'Score now'}</button>}
          {r.reviews.map((v) => <div key={v.id} style={{ fontSize: 13, marginTop: 6 }}><strong>{v.by_name}</strong>{v.rating != null ? ` rated ${v.rating}/100` : ''}{v.comment ? `: ${v.comment}` : ''} <span className="muted">{fmtDateTime(v.created_at)}</span></div>)}
          {r.can_coach && (
            <form onSubmit={rate} className="inline" style={{ gap: 6, marginTop: 8 }}>
              <input type="number" min={0} max={100} value={rating} onChange={(e) => setRating(e.target.value)} placeholder="Your rating" aria-label="Your rating (0-100)" style={{ width: 110 }} />
              <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Coaching comment" aria-label="Coaching comment" style={{ flex: 1 }} />
              <button className="small primary" disabled={rating === '' && !comment.trim()}>Save</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
