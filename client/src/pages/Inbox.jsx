import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { fmtDateTime } from '../format.js';
import { ErrorBox, Modal, PatientPicker, useSubmit } from '../components/ui.jsx';

// Two-way texting inbox: patient replies and texts from unknown numbers, assignment, archiving,
// editable quick replies, live updates.
export default function Inbox() {
  const { can, practice, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const { data: threads, reload } = useApi(`/conversations?view=${view}`);
  const { data: quick, reload: reloadQuick } = useApi('/quick-replies');
  const users = useLookup('/users');
  const activeKey = params.get('t') || (params.get('patient') ? `p${params.get('patient')}` : threads?.[0]?.thread) || null;
  const active = threads?.find((t) => t.thread === activeKey);
  const { data: thread, reload: reloadThread } = useApi(activeKey ? `/conversations/${activeKey}/messages` : null, [activeKey]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState(null);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [editingQuick, setEditingQuick] = useState(false);
  // Answer the way the patient wrote: a portal message gets a portal reply (it can hold clinical details).
  const [via, setVia] = useState('sms');
  useEffect(() => {
    const last = thread?.filter((m) => m.direction === 'inbound').at(-1);
    setVia(last?.channel === 'portal' ? 'portal' : 'sms');
  }, [thread]);
  const end = useRef(null);
  const patientId = activeKey?.startsWith('p') ? Number(activeKey.slice(1)) : null;
  const open = (t) => setParams({ view, t });

  useLiveEvents((e) => {
    if (e.type !== 'message') return;
    reload();
    reloadThread();
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [thread]);
  useEffect(() => {
    if (patientId && active?.unread) api.post(`/patients/${patientId}/conversation/read`).then(reload).catch(() => {});
  }, [activeKey, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
      reloadThread();
    } catch (x) {
      setErr(x);
    }
  };
  const send = async (e) => {
    e.preventDefault();
    setSending(true);
    setErr(null);
    try {
      if (patientId) await api.post(`/patients/${patientId}/messages`, { channel: via, body });
      else await api.post(`/conversations/${activeKey}/reply`, { body });
      setBody('');
      reloadThread();
      reload();
    } catch (x) {
      setErr(x);
    } finally {
      setSending(false);
    }
  };
  const fill = (q) => q.replace('{phone}', practice?.phone || '');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Messages</h1>
          <div className="muted">Texts and secure portal messages from patients arrive here instantly. Texted replies of <strong>C</strong> confirm automatically; <strong>STOP</strong> opts out.</div>
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 10 }}>
        {[['open', 'Open'], ['mine', 'Assigned to me'], ['unassigned', 'Unassigned'], ['archived', 'Archived']].map(([k, l]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setParams({ view: k })}>{l}</button>
        ))}
      </div>
      <div className="inbox">
        <div className="inbox-list card">
          {threads?.length === 0 && <div className="empty">{view === 'open' ? `No conversations. ${practice?.sms_number ? '' : 'Set the practice texting number in Settings → Practice.'}` : 'Nothing here.'}</div>}
          {threads?.map((t) => (
            <button key={t.thread} className={`inbox-item${t.thread === activeKey ? ' active' : ''}`} onClick={() => open(t.thread)}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{t.patient_id ? `${t.first_name} ${t.last_name}` : `Unknown ${t.number}`}</strong>
                {t.unread > 0 && <span className="unread">{t.unread}</span>}
              </div>
              <span className="muted inbox-preview">{t.direction === 'outbound' ? 'You: ' : ''}{t.body}</span>
              <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(t.created_at)}{t.assigned_name ? ` · ${t.assigned_name}` : ''}</span>
            </button>
          ))}
        </div>
        <div className="inbox-thread card">
          {!activeKey ? <div className="empty">Select a conversation.</div> : (
            <>
              <div className="inbox-thread-head inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                {patientId
                  ? <Link to={`/patients/${patientId}`}><strong>{active ? `${active.first_name} ${active.last_name}` : 'Patient'}</strong></Link>
                  : <strong>Unknown number {active?.number || ''}</strong>}
                {can('patients:write') && (
                  <span className="inline" style={{ gap: 6 }}>
                    {!patientId && <button className="small primary" onClick={() => setAttaching(true)}>Attach to patient…</button>}
                    <select value={active?.assigned_to || ''} onChange={(e) => act(() => api.put(`/conversations/${activeKey}`, { assigned_to: e.target.value ? Number(e.target.value) : null }))} style={{ width: 'auto' }} aria-label="Assign">
                      <option value="">Unassigned</option>
                      {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? 'Me' : u.name}</option>)}
                    </select>
                    {active?.archived
                      ? <button className="small" onClick={() => act(() => api.put(`/conversations/${activeKey}`, { archived: false }))}>Unarchive</button>
                      : <button className="small" title="Hide until the patient writes again" onClick={() => act(async () => { await api.put(`/conversations/${activeKey}`, { archived: true }); setParams({ view }); })}>Archive</button>}
                  </span>
                )}
              </div>
              <ErrorBox error={err} />
              <div className="bubbles">
                {thread?.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction}`}>
                    <div>{m.body}</div>
                    <div className="bubble-meta">{m.channel === 'portal' ? '🔒 Portal · ' : ''}{fmtDateTime(m.created_at)}{m.direction === 'outbound' ? ` · ${m.created_by_name || (m.kind === 'auto_reply' ? 'auto-reply' : m.kind.replace('_', ' '))}${m.status === 'failed' ? ' · failed' : m.status === 'blocked' ? ` · not sent: ${m.error}` : ''}` : ''}</div>
                  </div>
                ))}
                <div ref={end} />
              </div>
              {can('patients:write') && (
                <form className="composer" onSubmit={send}>
                  <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
                    {(quick || []).map((q) => <button type="button" key={q} className="small" title={fill(q)} onClick={() => setBody(fill(q))}>{q.slice(0, 28)}{q.length > 28 ? '…' : ''}</button>)}
                    <button type="button" className="small link" onClick={() => setEditingQuick(true)}>Edit…</button>
                  </div>
                  <div className="inline">
                    {patientId && (
                      <select value={via} onChange={(e) => setVia(e.target.value)} aria-label="Reply by" style={{ width: 'auto' }}>
                        <option value="sms">Text</option>
                        <option value="portal">Portal (secure)</option>
                      </select>
                    )}
                    <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={via === 'portal' ? 4000 : 480} placeholder={via === 'portal' ? 'Secure reply — the patient reads it in the portal' : 'Type a reply… (no clinical details by text)'} style={{ minHeight: 44 }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && body.trim()) send(e); }} />
                    <button className="primary" disabled={sending || !body.trim()}>Send</button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
      {attaching && (
        <Modal title={`Attach ${active?.number || 'this number'} to a patient`} onClose={() => setAttaching(false)}>
          <AttachForm thread={activeKey} onDone={(res) => { setAttaching(false); setParams({ view, t: res.thread }); reload(); }} />
        </Modal>
      )}
      {editingQuick && (
        <Modal title="Quick replies" onClose={() => setEditingQuick(false)}>
          <QuickReplies initial={quick || []} onDone={() => { setEditingQuick(false); reloadQuick(); }} />
        </Modal>
      )}
    </>
  );
}

function AttachForm({ thread, onDone }) {
  const [patient, setPatient] = useState(null);
  const { submit, busy, error } = useSubmit(async () => onDone(await api.post(`/conversations/${thread}/attach`, { patient_id: patient.id })));
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>Their texts move to the patient&apos;s conversation. If the patient has no mobile number, this one is saved on their chart.</p>
      <PatientPicker value={patient} onChange={setPatient} />
      <div className="form-actions"><button className="primary" disabled={busy || !patient}>Attach</button></div>
    </form>
  );
}

function QuickReplies({ initial, onDone }) {
  const [list, setList] = useState(initial.length ? initial : ['']);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/quick-replies', { replies: list });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}><code>{'{phone}'}</code> becomes the office phone number.</p>
      {list.map((q, i) => (
        <div key={i} className="inline" style={{ marginBottom: 6 }}>
          <input value={q} onChange={(e) => setList(list.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="small" onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="small" onClick={() => setList([...list, ''])}>+ Reply</button>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}
