import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { fmtDateTime } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';

const QUICK = [
  'Thanks! See you then.',
  'Yes, that works. We have updated your appointment.',
  'Please call the office so we can help: ',
  'We have openings later this week. Would you like one?',
];

// Two-way texting inbox: patient replies, quick responses, live updates.
export default function Inbox() {
  const { can, practice } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data: threads, reload } = useApi('/conversations');
  const activeId = Number(params.get('patient')) || threads?.find((t) => t.patient_id)?.patient_id || null;
  const { data: thread, reload: reloadThread } = useApi(activeId ? `/patients/${activeId}/conversation` : null, [activeId]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState(null);
  const [sending, setSending] = useState(false);
  const end = useRef(null);

  useLiveEvents((e) => {
    if (e.type !== 'message') return;
    reload();
    if (!e.patient_id || e.patient_id === activeId) reloadThread();
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [thread]);
  useEffect(() => {
    if (activeId && threads?.find((t) => t.patient_id === activeId)?.unread) api.post(`/patients/${activeId}/conversation/read`).then(reload).catch(() => {});
  }, [activeId, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (e) => {
    e.preventDefault();
    setSending(true);
    setErr(null);
    try {
      await api.post(`/patients/${activeId}/messages`, { channel: 'sms', body });
      setBody('');
      reloadThread();
      reload();
    } catch (x) {
      setErr(x);
    } finally {
      setSending(false);
    }
  };
  const active = threads?.find((t) => t.patient_id === activeId);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Text messages</h1>
          <div className="muted">Patient replies arrive here instantly. Replies of <strong>C</strong> confirm automatically; <strong>STOP</strong> opts out.</div>
        </div>
      </div>
      <div className="inbox">
        <div className="inbox-list card">
          {threads?.length === 0 && <div className="empty">No conversations yet. {practice?.sms_number ? '' : 'Set the practice texting number in Settings → Practice.'}</div>}
          {threads?.map((t) => (
            <button key={t.id} className={`inbox-item${t.patient_id === activeId ? ' active' : ''}`} onClick={() => t.patient_id && setParams({ patient: t.patient_id })}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{t.patient_id ? `${t.first_name} ${t.last_name}` : `Unknown ${t.from_address}`}</strong>
                {t.unread > 0 && <span className="unread">{t.unread}</span>}
              </div>
              <span className="muted inbox-preview">{t.direction === 'outbound' ? 'You: ' : ''}{t.body}</span>
              <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(t.created_at)}</span>
            </button>
          ))}
        </div>
        <div className="inbox-thread card">
          {!activeId ? <div className="empty">Select a conversation.</div> : (
            <>
              <div className="inbox-thread-head">
                <Link to={`/patients/${activeId}`}><strong>{active ? `${active.first_name} ${active.last_name}` : 'Patient'}</strong></Link>
              </div>
              <div className="bubbles">
                {thread?.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction}`}>
                    <div>{m.body}</div>
                    <div className="bubble-meta">{fmtDateTime(m.created_at)}{m.direction === 'outbound' ? ` · ${m.created_by_name || (m.kind === 'auto_reply' ? 'auto-reply' : m.kind.replace('_', ' '))}${m.status === 'failed' ? ' · failed' : ''}` : ''}</div>
                  </div>
                ))}
                <div ref={end} />
              </div>
              {can('patients:write') && (
                <form className="composer" onSubmit={send}>
                  <ErrorBox error={err} />
                  <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
                    {QUICK.map((q) => <button type="button" key={q} className="small" onClick={() => setBody(q + (q.endsWith(': ') ? practice?.phone || '' : ''))}>{q.slice(0, 28)}{q.length > 28 ? '…' : ''}</button>)}
                  </div>
                  <div className="inline">
                    <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={480} placeholder="Type a reply… (no clinical details by text)" style={{ minHeight: 44 }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && body.trim()) send(e); }} />
                    <button className="primary" disabled={sending || !body.trim()}>Send</button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
