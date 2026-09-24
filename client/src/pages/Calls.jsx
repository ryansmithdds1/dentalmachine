import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, Bot, Voicemail, MessageSquare } from 'lucide-react';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useLiveEvents } from '../live.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime } from '../format.js';
import { ErrorBox, Modal } from '../components/ui.jsx';
import CallCoach from '../components/phones/CallCoach.jsx';
import NoBookReason from '../components/phones/NoBookReason.jsx';

// The office phone line: every call, who it was, what happened, and — for recorded calls, voicemails and
// the AI receptionist — a transcript and a short summary.
const OUTCOME = {
  answered: ['ok', 'Answered'], missed: ['danger', 'Missed'], voicemail: ['warn', 'Voicemail'], after_hours: ['warn', 'After hours'], booked: ['ok', 'AI booked'],
  requested: ['ok', 'AI took a booking request'], rescheduled: ['ok', 'AI rescheduled'], cancelled: ['warn', 'AI cancelled'], message: ['warn', 'AI took a message'],
  handled: ['ok', 'AI answered'], hung_up: ['danger', 'Hung up'], confirmed: ['ok', 'Confirmed'], reschedule: ['warn', 'Wants a new time'], no_answer: ['', 'No answer'],
};
const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');

export default function Calls() {
  const { can } = useAuth();
  const [filter, setFilter] = useState('');
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [params, setParams] = useSearchParams();
  const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  // Searching (a topic, a word said on the call) looks through summaries and transcripts too.
  const search = q.trim().length >= 2;
  const { data, reload, error } = useApi(['sources', 'no_book'].includes(filter) ? null : search ? `/phones/calls?q=${encodeURIComponent(q.trim())}&from=${since}` : `/calls?days=${days}${filter ? `&filter=${filter}` : ''}`);
  // A link to one call (from a phone alert in chat, or the chart): /calls?open=123.
  const [open, setOpenState] = useState(() => Number(params.get('open')) || null);
  const setOpen = (id) => { setOpenState(id); if (!id && params.get('open')) { params.delete('open'); setParams(params, { replace: true }); } };
  useLiveEvents((e) => e.type === 'call' && reload());
  const s = data?.stats;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calls</h1>
          <div className="muted">Every call on the office line. Missed callers get a text back; recorded calls, voicemails and the AI receptionist’s calls come with a transcript and summary.</div>
        </div>
      </div>
      <ErrorBox error={error} />
      {s && (
        <div className="stat-strip">
          <div><strong>{s.inbound || 0}</strong><span>calls in</span></div>
          <div><strong>{s.missed || 0}</strong><span>missed or voicemail</span></div>
          <div><strong>{s.texted_back || 0}</strong><span>texted back</span></div>
          <div><strong>{s.ai_answered || 0}</strong><span>answered by the AI</span></div>
          <div><strong>{s.ai_booked || 0}</strong><span>booked by the AI</span></div>
        </div>
      )}
      <div className="inline" style={{ margin: '12px 0', gap: 8 }}>
        <div className="tabs" style={{ margin: 0 }}>
          {[['', 'All'], ['missed', 'Missed'], ['follow_up', 'Needs follow-up'], ['no_book', 'Didn’t book'], ['sources', 'Sources']].map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search calls (a word said, a topic)" aria-label="Search calls" style={{ maxWidth: 260 }} />
        {can('patients:read') && <Link to="/phones" className="small">Coaching and missed calls →</Link>}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
      </div>
      {filter === 'sources' && <Sources days={days} />}
      {filter === 'no_book' && <NoBookQueue canWrite={can('patients:write')} onOpen={setOpen} />}
      {!['sources', 'no_book'].includes(filter) && <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th /><th>Who</th><th>What happened</th><th>Summary</th><th className="num">Length</th><th /></tr></thead>
            <tbody>
              {data?.calls.map((c) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(c.id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(c.created_at)}</td>
                  <td title={c.purpose}>{c.purpose === 'receptionist' ? <Bot size={16} /> : c.outcome === 'voicemail' ? <Voicemail size={16} /> : c.direction === 'inbound' ? <PhoneIncoming size={16} /> : <PhoneOutgoing size={16} />}</td>
                  <td>{c.patient_id ? <Link to={`/patients/${c.patient_id}`} onClick={(e) => e.stopPropagation()}>{c.first_name} {c.last_name}</Link> : (c.caller_name || c.from_number || c.to_number || '—')}</td>
                  <td>
                    {c.outcome && <span className={`badge ${OUTCOME[c.outcome]?.[0] || ''}`}>{OUTCOME[c.outcome]?.[1] || c.outcome}</span>}
                    {c.texted_back_at && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}><MessageSquare size={11} /> texted back</span>}
                  </td>
                  <td style={{ fontSize: 13, maxWidth: 420 }}>{c.summary || <span className="muted">{c.has_transcript ? 'Transcript' : ''}</span>}{c.follow_up && !c.handled_at ? <span className="badge warn" style={{ marginLeft: 6 }}>follow up</span> : null}</td>
                  <td className="num">{dur(c.duration)}</td>
                  <td>{c.handled_at ? <span className="muted" style={{ fontSize: 12 }}>Done</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.calls.length === 0 && <div className="empty">No calls in this period. Connect the office line in Settings → Phone line.</div>}
        </div>
      </div>}
      {open && <CallDetail id={open} canWrite={can('patients:write')} onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function CallDetail({ id, canWrite, onClose }) {
  const { data: c, reload } = useApi(`/calls/${id}`);
  const [audio, setAudio] = useState(null);
  const [err, setErr] = useState(null);
  const play = async () => {
    try {
      const res = await fetch(`/api/calls/${id}/recording`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Couldn’t load the recording');
      setAudio(URL.createObjectURL(await res.blob()));
    } catch (e) { setErr(e); }
  };
  if (!c) return null;
  return (
    <Modal title={`Call · ${fmtDateTime(c.created_at)}`} wide onClose={onClose}>
      <ErrorBox error={err} />
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{c.card ? `${c.card.first_name} ${c.card.last_name}` : c.from_number}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{c.from_number} · {c.direction} · {dur(c.duration)}{c.reason ? ` · ${c.reason.replace('_', ' ')}` : ''}</div>
        </div>
        {canWrite && <button className={c.handled_at ? '' : 'primary'} onClick={async () => { await api.patch(`/calls/${id}`, { handled: !c.handled_at }); reload(); }}>{c.handled_at ? 'Mark not done' : 'Mark done'}</button>}
      </div>
      {c.summary && <div className="public-notice" style={{ margin: '10px 0' }}>{c.summary}</div>}
      {c.recording_key && (audio ? <audio controls autoPlay src={audio} style={{ width: '100%' }} /> : <button className="small" onClick={play}>Play recording</button>)}
      {c.transcript && (
        <div style={{ marginTop: 10, maxHeight: 360, overflow: 'auto', fontSize: 13, whiteSpace: 'pre-wrap', background: 'var(--surface-2, transparent)', padding: 10, borderRadius: 6 }}>{c.transcript}</div>
      )}
      <CallCoach callId={id} canWrite={canWrite} />
    </Modal>
  );
}

// Call tracking: calls, new callers and the patients they became, by marketing source.
function Sources({ days }) {
  const { data } = useApi(`/calls/sources?days=${days}`);
  if (!data) return <div className="empty">Loading…</div>;
  const m = (c) => (c == null ? '—' : `$${Math.round(c / 100).toLocaleString()}`);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Source</th><th className="num">Calls</th><th className="num">Missed</th><th className="num">New callers</th><th className="num">New patients</th><th className="num">Their production</th><th className="num">Spend</th><th className="num">Per new patient</th><th className="num">Return</th></tr></thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.source}>
                <td><strong>{s.source}</strong></td><td className="num">{s.calls}</td><td className="num">{s.missed}</td><td className="num">{s.new_callers}</td><td className="num">{s.new_patients}</td>
                <td className="num">{m(s.production)}</td><td className="num">{s.spend ? m(s.spend) : '—'}</td><td className="num">{m(s.cost_per_new_patient)}</td><td className="num">{s.return_on_spend != null ? `${s.return_on_spend}×` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.sources.length === 0 && <div className="empty">No calls yet. Add tracking numbers in Settings → Phone line.</div>}
      </div>
    </div>
  );
}

// Calls that ended without a booking and still need their reason (PH4): the AI's suggestion is one click away.
function NoBookQueue({ canWrite, onOpen }) {
  const { data, reload } = useApi('/phones/no-book/pending');
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Calls that ended without a booking. Pick why (the AI’s guess is dashed) — Phones → Why they didn’t book counts them over time.</p>
      {data.map((n) => (
        <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <button type="button" className="link" onClick={() => onOpen(n.call_id)}>{n.first_name ? `${n.first_name} ${n.last_name}` : (n.caller_name || n.from_number)}</button>
          <span className="muted" style={{ fontSize: 12 }}> · {fmtDateTime(n.call_at)}{n.summary ? ` · ${n.summary}` : ''}</span>
          {n.suggested_quote && <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>“{n.suggested_quote}”</div>}
          {canWrite && <NoBookReason callId={n.call_id} suggested={n.suggested_reason} quote={n.suggested_quote} onSaved={() => setTimeout(reload, 600)} />}
        </div>
      ))}
      {!data.length && <div className="empty">Nothing waiting — every call without a booking has its reason.</div>}
    </div>
  );
}
