import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { useMakeActive } from '../activePatient.jsx';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import { fmtDateTime } from '../format.js';
import { ErrorBox, Modal, PatientPicker, useSubmit } from '../components/ui.jsx';
import ReplyBox from '../components/ReplyBox.jsx';
import '../components/comms.css';

// Two-way texting inbox: patient replies and texts from unknown numbers, assignment, archiving,
// editable quick replies, live updates. Keyboard: J/K (or the arrows) move between conversations, Enter
// jumps to the reply box, Enter sends, Esc goes back to the list. /messages?patient=ID (Alt+T, the command
// bar's "text <name>") opens that patient's conversation ready to type.
export default function Inbox() {
  const { can, practice, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const { data: threads, reload } = useApi(`/conversations?view=${view}`);
  const { data: quick, reload: reloadQuick } = useApi('/quick-replies');
  const users = useLookup('/users');
  const asked = params.get('t') || (params.get('patient') ? `p${params.get('patient')}` : null);
  const activeKey = asked || threads?.[0]?.thread || null;
  const active = threads?.find((t) => t.thread === activeKey);
  const { data: thread, reload: reloadThread } = useApi(activeKey ? `/conversations/${activeKey}/messages` : null, [activeKey]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [editingQuick, setEditingQuick] = useState(false);
  // Answer the way the patient wrote: a portal message gets a portal reply (it can hold clinical details).
  const [via, setVia] = useState('sms');
  useEffect(() => {
    const last = thread?.filter((m) => m.direction === 'inbound').at(-1);
    setVia(last?.channel === 'portal' ? 'portal' : 'sms');
  }, [thread]);
  const end = useRef(null);
  const reply = useRef(null);
  const items = useRef(new Map());
  const patientId = activeKey?.startsWith('p') ? Number(activeKey.slice(1)) : null;
  // A patient who has never texted isn't in the list yet: look them up for the header.
  const { data: fetched } = useApi(patientId && threads && !active ? `/patients/${patientId}` : null);
  const patient = useMemo(() => {
    if (!patientId) return null;
    if (active) return { id: patientId, first_name: active.first_name, last_name: active.last_name };
    return fetched?.id === patientId ? fetched : null;
  }, [patientId, active, fetched]);
  // Opening a patient's conversation (not just landing on the inbox) makes them the active patient.
  useMakeActive(asked ? patient : null);

  const [focusReply, setFocusReply] = useState(!!params.get('patient'));
  useEffect(() => {
    if (!focusReply || !activeKey) return;
    const f = setTimeout(() => { reply.current?.focus(); setFocusReply(false); }, 0);
    return () => clearTimeout(f);
  }, [focusReply, activeKey, thread]);
  const open = (t, { toReply = false } = {}) => {
    setAttaching(false);
    setParams({ view, t }, { replace: true });
    if (toReply) setFocusReply(true);
  };
  const move = (step) => {
    if (!threads?.length) return;
    const i = threads.findIndex((t) => t.thread === activeKey);
    const next = threads[Math.min(threads.length - 1, Math.max(0, (i < 0 ? -1 : i) + step))];
    open(next.thread);
    items.current.get(next.thread)?.focus();
  };
  const toList = () => {
    reply.current?.blur();
    (items.current.get(activeKey) || [...items.current.values()][0])?.focus();
  };
  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next conversation', section: 'Messages' },
    { combo: 'arrowdown', handler: () => move(1) },
    { combo: 'k', handler: () => move(-1), label: 'Previous conversation', section: 'Messages' },
    { combo: 'arrowup', handler: () => move(-1) },
    {
      combo: 'enter', label: 'Reply to this conversation', section: 'Messages',
      // Enter on a focused button or link still presses it.
      handler: (e) => { const b = e.target.closest?.('button, a, summary, [role="button"]'); if (b) b.click(); else if (activeKey) open(activeKey, { toReply: true }); },
    },
    {
      combo: 'escape', label: 'Back to the conversation list', section: 'Messages', inInputs: true,
      handler: (e) => { if (attaching) setAttaching(false); else if (!e.target.closest?.('.call-pop')) toList(); },
    },
  ]);

  useLiveEvents((e) => {
    if (e.type !== 'message') return;
    reload();
    reloadThread();
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [thread]);
  useEffect(() => {
    if (patientId && active?.unread) api.post(`/patients/${patientId}/conversation/read`).then(reload).catch((x) => toast(`Couldn’t mark as read: ${x.message}`, { tone: 'error' }));
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
  // The server keeps sending idempotent (the app sends an Idempotency-Key), so Enter twice sends once.
  const send = async (text) => {
    const msg = patientId
      ? await api.post(`/patients/${patientId}/messages`, { channel: via, body: text })
      : await api.post(`/conversations/${activeKey}/reply`, { body: text });
    reloadThread();
    reload();
    return msg;
  };
  const attach = async (p) => {
    try {
      const res = await api.post(`/conversations/${activeKey}/attach`, { patient_id: p.id });
      setAttaching(false);
      toast(`Filed under ${p.first_name} ${p.last_name}`);
      open(res.thread, { toReply: true });
      reload();
    } catch (x) {
      toast(x.message || 'Couldn’t attach the number', { tone: 'error' });
    }
  };
  const fill = (q) => q.replace('{phone}', practice?.phone || '');
  const title = patientId ? (patient ? `${patient.first_name} ${patient.last_name}` : 'Patient') : `Unknown number ${active?.number || ''}`;

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
        <div className="inbox-list card" role="listbox" aria-label="Conversations">
          {threads?.length === 0 && <div className="empty">{view === 'open' ? `No conversations. ${practice?.sms_number ? '' : 'Set the practice texting number in Settings → Practice.'}` : 'Nothing here.'}</div>}
          {threads?.map((t) => (
            <button key={t.thread} ref={(el) => (el ? items.current.set(t.thread, el) : items.current.delete(t.thread))} role="option" aria-selected={t.thread === activeKey}
              className={`inbox-item${t.thread === activeKey ? ' active' : ''}`} onClick={() => open(t.thread, { toReply: true })}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <strong>{t.patient_id ? `${t.first_name} ${t.last_name}` : `Unknown ${t.number}`}</strong>
                {t.unread > 0 && <span className="unread">{t.unread}</span>}
              </div>
              <span className="muted inbox-preview">{t.direction === 'outbound' ? 'You: ' : ''}{t.body}</span>
              <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(t.created_at)}{t.assigned_name ? ` · ${t.assigned_name}` : ''}</span>
            </button>
          ))}
          {threads?.length > 0 && <div className="muted inbox-keys">J/K to move · Enter to reply · Esc back here</div>}
        </div>
        <div className="inbox-thread card">
          {!activeKey ? <div className="empty">Select a conversation.</div> : (
            <>
              <div className="inbox-thread-head inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                {patientId
                  ? <Link to={`/patients/${patientId}`}><strong>{title}</strong></Link>
                  : <strong>{title}</strong>}
                {can('patients:write') && (
                  <span className="inline" style={{ gap: 6 }}>
                    {!patientId && <button className={`small${attaching ? '' : ' primary'}`} aria-expanded={attaching} onClick={() => setAttaching((a) => !a)}>{attaching ? 'Cancel' : 'Attach to patient'}</button>}
                    <select value={active?.assigned_to || ''} onChange={(e) => act(() => api.put(`/conversations/${activeKey}`, { assigned_to: e.target.value ? Number(e.target.value) : null }))} style={{ width: 'auto' }} aria-label="Assign">
                      <option value="">Unassigned</option>
                      {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? 'Me' : u.name}</option>)}
                    </select>
                    {active?.archived
                      ? <button className="small" onClick={() => act(() => api.put(`/conversations/${activeKey}`, { archived: false }))}>Unarchive</button>
                      : active && <button className="small" title="Hide until the patient writes again" onClick={() => act(async () => { await api.put(`/conversations/${activeKey}`, { archived: true }); setParams({ view }); })}>Archive</button>}
                  </span>
                )}
              </div>
              {attaching && !patientId && (
                <div className="inbox-attach">
                  <span className="muted">Their texts move to the patient&apos;s conversation. If the patient has no mobile number, this one is saved on their chart.</span>
                  <PatientPicker value={null} onChange={(p) => p && attach(p)} />
                  <Link className="small" to={`/patients?new=1&phone=${encodeURIComponent(active?.number || '')}`}><UserPlus size={13} /> Not on file? New patient with this number</Link>
                </div>
              )}
              <ErrorBox error={err} />
              <div className="bubbles">
                {thread?.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction}`}>
                    <div>{m.body}</div>
                    <div className="bubble-meta">{m.channel === 'portal' ? '🔒 Portal · ' : ''}{fmtDateTime(m.created_at)}{m.direction === 'outbound' ? ` · ${m.created_by_name || (m.kind === 'auto_reply' ? 'auto-reply' : m.kind.replace('_', ' '))}${m.status === 'failed' ? ' · failed' : m.status === 'blocked' ? ` · not sent: ${m.error}` : ''}` : ''}</div>
                  </div>
                ))}
                {thread?.length === 0 && <div className="muted">No messages yet — say hello below.</div>}
                <div ref={end} />
              </div>
              {can('patients:write') && (
                <div className="composer">
                  <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
                    {(quick || []).map((q) => <button type="button" key={q} className="small" title={fill(q)} onClick={() => { setBody(fill(q)); reply.current?.focus(); }}>{q.slice(0, 28)}{q.length > 28 ? '…' : ''}</button>)}
                    <button type="button" className="small link" onClick={() => setEditingQuick(true)}>Edit…</button>
                  </div>
                  <ReplyBox ref={reply} value={body} onChange={setBody} onSend={send} maxLength={via === 'portal' ? 4000 : 480}
                    placeholder={via === 'portal' ? 'Secure reply — the patient reads it in the portal' : 'Type a reply… (no clinical details by text)'}>
                    {patientId && (
                      <select value={via} onChange={(e) => setVia(e.target.value)} aria-label="Reply by">
                        <option value="sms">Text</option>
                        <option value="portal">Portal (secure)</option>
                      </select>
                    )}
                  </ReplyBox>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {editingQuick && (
        <Modal title="Quick replies" onClose={() => setEditingQuick(false)}>
          <QuickReplies initial={quick || []} onDone={() => { setEditingQuick(false); reloadQuick(); }} />
        </Modal>
      )}
    </>
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
