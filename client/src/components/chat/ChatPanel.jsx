import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Archive, ArrowLeft, Bell, BellOff, Hash, ListChecks, Lock, MessageSquarePlus, Plus, Search, Settings2, Users, X } from 'lucide-react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';
import { useShortcuts, useCommands, comboLabel } from '../../shortcuts.js';
import { useActivePatient } from '../../activePatient.jsx';
import { useRemembered, setPref, loadPrefs } from '../../prefs.js';
import { toast } from '../../toast.js';
import {
  useChat, setChat, chatState, loadBoot, loadUrgent, refreshUnread, openChat, closeChat, toggleChat, notify, chatPref, canNotify,
  askNotifyPermission, emitLive, onLive,
} from './chatStore.js';
import Message, { Avatar, toDate, RichText, timeOf } from './Message.jsx';
import Composer from './Composer.jsx';
import MyTasks from './MyTasks.jsx';
import './chat.css';

const newKey = () => globalThis.crypto?.randomUUID?.() || `k${Date.now()}${Math.random().toString(36).slice(2)}`;
const dayLabel = (s) => {
  const d = toDate(s);
  if (!d) return '';
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const sameDay = (a, b) => toDate(a)?.toDateString() === toDate(b)?.toDateString();
const firstName = (n = '') => n.split(/\s+/)[0];

// The live connection for chat (one for the whole app): counts, the urgent banner, desktop notices, and the
// open conversation all update from it. Events carry ids only; the message itself is fetched (access-checked).
function ChatLive() {
  useEffect(() => { loadPrefs(); loadBoot(); loadUrgent(); }, []);
  useLiveEvents(async (e) => {
    const s = chatState();
    const me = s.boot?.me?.id;
    if (!me) return;
    if (e.type === 'tasks') {
      emitLive(e);
      if (e.event === 'created' && e.assigned_to === me && e.by && e.by !== me) {
        const who = s.boot.team.find((u) => u.id === e.by)?.name || 'Someone';
        notify({ title: `New task from ${who}`, body: 'Open My tasks to see it', tag: `task-${e.task_id}`, onClick: () => openChat({ view: 'tasks' }) });
      }
      return;
    }
    if (e.type !== 'chat' || (e.to && !e.to.includes(me))) return;
    emitLive(e);
    if (e.event === 'channels' || e.event === 'settings' || (e.channel_id && !s.boot.channels.some((c) => c.id === e.channel_id))) loadBoot();
    if (['message', 'read', 'delete', 'edit'].includes(e.event)) refreshUnread();
    if ((e.event === 'message' && e.urgent) || e.event === 'ack' || e.event === 'delete') loadUrgent();
    if (e.event !== 'message' || e.by === me) return;
    const ch = s.boot.channels.find((c) => c.id === e.channel_id);
    const mentioned = (e.mentions || []).includes(me);
    const level = chatPref('chat.notify');
    const wanted = e.urgent || mentioned || (level !== 'none' && ch?.kind !== 'channel') || (level === 'all' && !ch?.muted);
    if (!wanted || (ch?.muted && !mentioned && !e.urgent)) return;
    const looking = s.open && s.channelId === e.channel_id && document.hasFocus() && !e.parent_id;
    if (looking && !e.urgent) return;
    try {
      const m = await api.get(`/chat/messages/${e.message_id}`);
      const where = ch?.kind === 'channel' ? ` in #${ch.name}` : '';
      const text = m.body ? m.body.slice(0, 160) : m.gif ? 'sent a GIF' : m.attachments?.length ? 'sent a file' : '';
      notify({
        title: `${e.urgent ? 'URGENT — ' : ''}${m.author_name || 'Someone'}${where}`, body: text, urgent: e.urgent, tag: `chat-${m.id}`,
        onClick: () => openChat({ channelId: e.channel_id, threadId: e.parent_id || null }),
      });
    } catch { /* it was deleted or isn't visible to this person: nothing to show */ }
  });
  // Opening the chat from a link: ?chat=p<patient id> (the patient bar), ?chat=u<user id>, ?chat=c<channel id>.
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    const v = p.get('chat');
    if (!v) return;
    p.delete('chat');
    nav({ pathname: loc.pathname, search: p.toString() ? `?${p}` : '' }, { replace: true });
    const id = Number(v.slice(1));
    if (v[0] === 'p' && id) openAboutPatient(id);
    else if (v[0] === 'u' && id) openChat({ userId: id });
    else if (v[0] === 'c' && id) openChat({ channelId: id });
    else openChat();
  }, [loc.search]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

async function openAboutPatient(id) {
  try {
    const p = await api.get(`/patients/${id}/card`);
    openChat({ patient: { id: p.id, name: `${p.first_name} ${p.last_name}` } });
  } catch (e) {
    toast(e.message, { tone: 'error' });
  }
}

// ---- The list of messages (a conversation, or a thread) ----
function MessageList({ messages, me, team, onReply, onUpdate, editingId, setEditingId, onSaveEdit, lastRead, inThread, highlightId, onScrollTop }) {
  const ref = useRef(null);
  const atBottom = useRef(true);
  const prevCount = useRef(0);
  const prevFirst = useRef(null);
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = messages[0]?.id;
    if (prevFirst.current && first !== prevFirst.current && messages.length > prevCount.current && el.scrollTop < 80) {
      el.scrollTop = el.scrollHeight - prevHeight.current; // older messages added above: stay put
    } else if (highlightId && !prevCount.current) {
      el.querySelector(`[data-id="${highlightId}"]`)?.scrollIntoView({ block: 'center' });
    } else if (atBottom.current || !prevCount.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevCount.current = messages.length;
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages, highlightId]);
  const onScroll = () => {
    const el = ref.current;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 60) onScrollTop?.();
  };
  const firstNew = lastRead != null ? messages.find((m) => typeof m.id === 'number' && m.id > lastRead && m.user_id !== me.id)?.id : null;
  return (
    <div className="chat-messages" ref={ref} onScroll={onScroll} role="log" aria-live="polite">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || !sameDay(prev.created_at, m.created_at);
        const threadStart = inThread && i === 1;
        const compact = !newDay && !threadStart && prev && prev.user_id === m.user_id && !prev.urgent && !m.urgent && prev.status !== 'deleted'
          && Math.abs(toDate(m.created_at) - toDate(prev.created_at)) < 5 * 60_000 && m.id !== firstNew;
        return (
          <div key={m.key || m.id}>
            {newDay && <div className="chat-day"><span>{dayLabel(m.created_at)}</span></div>}
            {m.id === firstNew && <div className="chat-new"><span>New</span></div>}
            {threadStart && <div className="chat-thread-count">{messages.length - 1} {messages.length === 2 ? 'reply' : 'replies'}</div>}
            <Message
              m={m} me={me} team={team} compact={compact} inThread={inThread} onReply={onReply} onUpdate={onUpdate} highlight={m.id === highlightId}
              editing={editingId === m.id} onEdit={(x) => setEditingId(x.id)} onCancelEdit={() => setEditingId(null)} onSaveEdit={(body) => onSaveEdit(m, body)}
            />
          </div>
        );
      })}
    </div>
  );
}

// Sending with a client key: shown at once (greyed until the server has it), never posted twice on a retry.
function useSender({ channel, me, parentId, setMessages }) {
  return useCallback(async (p) => {
    const key = newKey();
    const temp = {
      id: `tmp-${key}`, key, pending: true, user_id: me.id, author_name: me.name, body: p.body || null, gif: p.gif || null, urgent: !!p.urgent,
      created_at: new Date().toISOString(), reactions: [], attachments: p.attachments || [], patient: p.patient || null, status: 'active', kind: p.gif ? 'gif' : 'text', mine: true, parent_id: parentId,
    };
    const post = async () => {
      setMessages((l) => (l.some((x) => x.key === key) ? l.map((x) => (x.key === key ? { ...temp, failed: false } : x)) : [...l, temp]));
      try {
        const m = await api.post(`/chat/channels/${channel.id}/messages`, {
          body: p.body || null, parent_id: parentId, patient_id: p.patient?.id ?? null, urgent: !!p.urgent, attachment_ids: p.attachment_ids || [],
          mention_ids: p.mention_ids || [], gif: p.gif || null, client_key: key,
        });
        setMessages((l) => (l.some((x) => x.id === m.id) ? l.filter((x) => x.key !== key) : l.map((x) => (x.key === key ? { ...m, key } : x))));
        if (p.patient) setPref('chat.patient_channel', channel.id);
      } catch (e) {
        setMessages((l) => l.map((x) => (x.key === key ? { ...x, pending: false, failed: true, retry: post } : x)));
        toast(e.message, { tone: 'error' });
      }
    };
    post();
  }, [channel?.id, me.id, me.name, parentId, setMessages]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Conversation({ channel, boot, open, highlightId, onThread }) {
  const me = boot.me;
  const [messages, setMessages] = useState([]);
  const [more, setMore] = useState(false);
  const [lastRead, setLastRead] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const loadingOlder = useRef(false);
  const s = useChat();
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError(null);
    setEditingId(null);
    api.get(`/chat/channels/${channel.id}/messages?limit=60`).then((r) => {
      if (!alive) return;
      setMessages(r.messages);
      setMore(r.has_more);
      setLastRead(r.last_read_id ?? 0);
    }).catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [channel.id]);
  const replace = useCallback((m) => setMessages((l) => l.map((x) => (x.id === m.id ? { ...x, ...m } : x))), []);
  // Live: new messages, edits, deletes, reactions and "Got it"s in this conversation.
  useEffect(() => onLive(async (e) => {
    if (e.type !== 'chat' || e.channel_id !== channel.id || !e.message_id) return;
    const target = e.event === 'message' && e.parent_id ? e.parent_id : e.message_id;
    try {
      const m = await api.get(`/chat/messages/${target}`);
      if (m.parent_id) return; // a reply's own changes show in its thread
      setMessages((l) => (l.some((x) => x.id === m.id) ? l.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : e.event === 'message' && !e.parent_id && !l.some((x) => x.pending && x.body === m.body && m.user_id === me.id) ? [...l, m] : l));
    } catch { /* not visible to this person */ }
  }), [channel.id, me.id]);
  // Read up to the newest message while it's on screen.
  const newest = messages.filter((m) => typeof m.id === 'number').at(-1)?.id;
  useEffect(() => {
    if (!open || !newest || !document.hasFocus()) return;
    const c = s.boot?.channels.find((x) => x.id === channel.id);
    if (c && c.unread === 0 && c.mentions === 0 && c.last_read_id >= newest) return;
    api.post(`/chat/channels/${channel.id}/read`, { message_id: newest }).then(refreshUnread).catch(() => { /* marked read on the next look */ });
  }, [newest, open, channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = () => newest && open && api.post(`/chat/channels/${channel.id}/read`, { message_id: newest }).then(refreshUnread).catch(() => { /* next time */ });
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [newest, open, channel.id]);
  const older = async () => {
    if (!more || loadingOlder.current || !messages[0]) return;
    loadingOlder.current = true;
    try {
      const r = await api.get(`/chat/channels/${channel.id}/messages?before=${messages.find((m) => typeof m.id === 'number').id}&limit=60`);
      setMessages((l) => [...r.messages, ...l]);
      setMore(r.has_more);
    } finally {
      loadingOlder.current = false;
    }
  };
  const send = useSender({ channel, me, parentId: null, setMessages });
  const saveEdit = async (m, body) => {
    setEditingId(null);
    if (body.trim() === (m.body || '')) return;
    try { replace(await api.put(`/chat/messages/${m.id}`, { body })); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const editLast = () => {
    const mine = [...messages].reverse().find((m) => m.mine && m.kind === 'text' && m.status === 'active' && typeof m.id === 'number');
    if (mine) setEditingId(mine.id);
  };
  const muted = !!channel.muted;
  const toggleMute = async () => {
    try { await api.post(`/chat/channels/${channel.id}/mute`, { muted: !muted }); await loadBoot(); toast(muted ? 'Notifications on for this conversation' : 'Muted — you’ll still hear about @mentions and urgent messages'); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const archive = async () => {
    try { await api.post(`/chat/channels/${channel.id}/archive`); await loadBoot(); setChat({ channelId: s.boot.channels.find((c) => c.slug === 'everyone')?.id }); toast(`#${channel.name} archived — its history stays searchable`); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const join = async () => {
    try { await api.post(`/chat/channels/${channel.id}/join`); await loadBoot(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div className="chat-conv">
      <header className="chat-conv-head">
        <button type="button" className="chat-back" onClick={() => setChat({ channelId: null })} aria-label="All conversations"><ArrowLeft size={17} /></button>
        <div className="chat-conv-title">
          <strong>{channel.kind === 'channel' ? <><Hash size={15} /> {channel.name}</> : channel.kind === 'group' ? <><Users size={15} /> {channel.title}</> : channel.title}</strong>
          <span className="muted">{channel.kind === 'channel' ? channel.topic || `${channel.member_count} people` : channel.kind === 'group' ? `${channel.members?.length} people · private` : 'Direct message · private'}</span>
        </div>
        <button type="button" className="icon" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute (you’ll still get @mentions and urgent)'} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <BellOff size={16} /> : <Bell size={16} />}</button>
        {me.role === 'admin' && channel.kind === 'channel' && !channel.audience && <button type="button" className="icon" onClick={archive} title="Archive channel" aria-label="Archive channel"><Archive size={16} /></button>}
      </header>
      {error ? <div className="error">{error.message}</div> : (
        <MessageList
          messages={messages} me={me} team={boot.team} lastRead={lastRead} highlightId={highlightId}
          onReply={(m) => onThread(m.id)} onUpdate={replace} editingId={editingId} setEditingId={setEditingId} onSaveEdit={saveEdit} onScrollTop={older}
        />
      )}
      {channel.kind === 'channel' && !channel.member && <div className="chat-join">You’re not in #{channel.name}. <button type="button" className="primary small" onClick={join}>Join</button></div>}
      <Composer channel={channel} team={boot.team} me={me} settings={boot.settings} onSend={send} onEditLast={editLast} draft={s.draft} />
    </div>
  );
}

function Thread({ rootId, channel, boot, onClose }) {
  const me = boot.me;
  const [messages, setMessages] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const load = useCallback(() => api.get(`/chat/messages/${rootId}/thread`).then((r) => setMessages([r.parent, ...r.replies].filter(Boolean))).catch((e) => toast(e.message, { tone: 'error' })), [rootId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((e) => e.type === 'chat' && (e.parent_id === rootId || e.message_id === rootId || messages.some((m) => m.id === e.message_id)) && load()), [rootId, load, messages]);
  const send = useSender({ channel, me, parentId: rootId, setMessages });
  const replace = (m) => setMessages((l) => l.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
  const saveEdit = async (m, body) => {
    setEditingId(null);
    try { replace(await api.put(`/chat/messages/${m.id}`, { body })); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const editLast = () => { const m = [...messages].reverse().find((x) => x.mine && x.kind === 'text' && x.status === 'active' && typeof x.id === 'number'); if (m) setEditingId(m.id); };
  return (
    <div className="chat-thread">
      <header className="chat-conv-head">
        <button type="button" className="icon" onClick={onClose} aria-label="Back to the conversation"><ArrowLeft size={17} /></button>
        <div className="chat-conv-title"><strong>Thread</strong><span className="muted">{channel.kind === 'channel' ? `#${channel.name}` : channel.title}</span></div>
      </header>
      <MessageList messages={messages} me={me} team={boot.team} inThread onReply={() => {}} onUpdate={replace} editingId={editingId} setEditingId={setEditingId} onSaveEdit={saveEdit} />
      <Composer channel={channel} parentId={rootId} team={boot.team} me={me} settings={boot.settings} onSend={send} onEditLast={editLast} placeholder="Reply…" />
    </div>
  );
}

function SearchView({ boot }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) return setRes([]);
    const t = setTimeout(() => api.get(`/chat/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="chat-search">
      <div className="chat-search-box"><Search size={16} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages you can see…" aria-label="Search messages" /></div>
      <div className="chat-search-results">
        {q.trim().length >= 2 && !res.length && <div className="muted small-pad">No messages match “{q}”.</div>}
        {res.map((m) => (
          <button key={m.id} type="button" className="chat-search-hit" onClick={() => openChat({ channelId: m.channel_id, threadId: m.parent_id || null }).then(() => setChat({ highlightId: m.parent_id ? null : m.id }))}>
            <Avatar id={m.user_id} name={m.author_name} size={26} />
            <span>
              <span className="hit-head"><strong>{m.author_name}</strong> <span className="muted">{m.channel?.kind === 'channel' ? `#${m.channel.name}` : 'Direct message'} · {dayLabel(m.created_at)} {timeOf(m.created_at)}</span></span>
              <span className="hit-body"><RichText text={m.body} meName={boot.me.name} /></span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ boot }) {
  const [level, setLevel] = useRemembered('chat.notify', 'mentions');
  const [sound, setSound] = useRemembered('chat.sound', true);
  const [desktop, setDesktop] = useRemembered('chat.desktop', true);
  const [digest, setDigest] = useRemembered('chat.digest', true);
  const [quiet, setQuiet] = useRemembered('chat.quiet', { enabled: false, from: '19:00', until: '07:00' });
  const [perm, setPerm] = useState(canNotify() ? Notification.permission : 'unsupported');
  const admin = boot.me.role === 'admin';
  const save = async (patch) => {
    try { await api.put('/chat/settings', patch); await loadBoot(); toast('Saved for the whole office'); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div className="chat-settings">
      <h3>Your notifications</h3>
      <label className="set-row">Tell me about
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">Every message (except muted)</option>
          <option value="mentions">Direct messages, @mentions and urgent</option>
          <option value="none">Only @mentions and urgent</option>
        </select>
      </label>
      <label className="set-check"><input type="checkbox" checked={!!desktop} onChange={(e) => setDesktop(e.target.checked)} /> Desktop notifications {perm !== 'granted' && perm !== 'unsupported' && <button type="button" className="link" onClick={async () => setPerm(await askNotifyPermission())}>allow in this browser</button>}{perm === 'denied' && <span className="muted"> (blocked in the browser’s site settings)</span>}</label>
      <label className="set-check"><input type="checkbox" checked={!!sound} onChange={(e) => setSound(e.target.checked)} /> A soft sound</label>
      <label className="set-check"><input type="checkbox" checked={!!quiet.enabled} onChange={(e) => setQuiet({ ...quiet, enabled: e.target.checked })} /> Quiet hours
        <input type="time" value={quiet.from} onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} disabled={!quiet.enabled} aria-label="Quiet from" /> to
        <input type="time" value={quiet.until} onChange={(e) => setQuiet({ ...quiet, until: e.target.value })} disabled={!quiet.enabled} aria-label="Quiet until" />
      </label>
      <p className="muted small">In quiet hours there’s no sound, no desktop notice and no digest email. Urgent messages still show on screen.</p>
      <label className="set-check"><input type="checkbox" checked={digest !== false} onChange={(e) => setDigest(e.target.checked)} /> Email me when something for me stays unread{boot.settings.digest_minutes ? ` for ${boot.settings.digest_minutes >= 60 ? `${boot.settings.digest_minutes / 60} hours` : `${boot.settings.digest_minutes} minutes`}` : ''} (counts only, never the messages)</label>
      {admin && (
        <>
          <h3>Whole office (administrators)</h3>
          <label className="set-check"><input type="checkbox" checked={!!boot.settings.gifs_enabled} onChange={(e) => save({ gifs_enabled: e.target.checked })} /> Allow GIFs {boot.settings.gif_provider === 'sandbox' || !boot.settings.gifs_enabled ? '' : `(${boot.settings.gif_provider})`}</label>
          <p className="muted small">GIF searches send only the words typed in the GIF box — numbers and patient names are removed first.</p>
          <label className="set-row">Unread digest email after
            <select value={boot.settings.digest_minutes} onChange={(e) => save({ digest_minutes: Number(e.target.value) })}>
              {[[0, 'Never'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '1 day']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function NewConversation({ boot, onDone }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [channelName, setChannelName] = useState('');
  const people = boot.team.filter((u) => u.id !== boot.me.id && !picked.includes(u.id) && u.name.toLowerCase().includes(q.toLowerCase()));
  const start = async () => {
    if (!picked.length) return;
    try { await openChat(picked.length === 1 ? { userId: picked[0] } : { channelId: (await api.post('/chat/dms', { user_ids: picked })).id }); await loadBoot(); onDone(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const makeChannel = async (e) => {
    e.preventDefault();
    try { const c = await api.post('/chat/channels', { name: channelName }); await loadBoot(); openChat({ channelId: c.id }); onDone(); } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  return (
    <div className="chat-new-conv">
      <h3>New message</h3>
      <div className="chat-people-pick">
        {picked.map((id) => { const u = boot.team.find((x) => x.id === id); return <span key={id} className="chat-chip">{u?.name}<button type="button" aria-label={`Remove ${u?.name}`} onClick={() => setPicked(picked.filter((x) => x !== id))}><X size={12} /></button></span>; })}
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={picked.length ? 'Add someone else…' : 'Who? Type a name'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (people[0] && q) { setPicked([...picked, people[0].id]); setQ(''); } else start(); }
            if (e.key === 'Backspace' && !q && picked.length) setPicked(picked.slice(0, -1));
          }} />
      </div>
      <div className="chat-people-list">
        {people.slice(0, 12).map((u) => (
          <button key={u.id} type="button" onClick={() => { setPicked([...picked, u.id]); setQ(''); }}><Avatar id={u.id} name={u.name} size={24} /> {u.name} <span className="muted">{u.role.replace('_', ' ')}</span></button>
        ))}
      </div>
      <button type="button" className="primary" disabled={!picked.length} onClick={start}>{picked.length > 1 ? `Start a group of ${picked.length + 1}` : 'Start conversation'}</button>
      <form onSubmit={makeChannel} className="chat-new-channel">
        <h3>Or a new channel</h3>
        <div className="row"><input value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder="e.g. sterilization, ortho, marketing" aria-label="Channel name" /><button className="small" disabled={channelName.trim().length < 2}>Create</button></div>
      </form>
    </div>
  );
}

function Sidebar({ boot, s }) {
  const [browse, setBrowse] = useState(false);
  const mine = boot.channels.filter((c) => c.kind === 'channel' && c.member);
  const others = boot.channels.filter((c) => c.kind === 'channel' && !c.member);
  const dms = boot.channels.filter((c) => c.kind !== 'channel').sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
  const item = (c, icon) => (
    <button key={c.id} type="button" className={`chat-side-item${s.view === 'chat' && s.channelId === c.id ? ' active' : ''}${c.unread || c.mentions ? ' unread' : ''}${c.muted ? ' muted-ch' : ''}`}
      onClick={() => setChat({ view: 'chat', channelId: c.id, threadId: null, highlightId: null })}>
      {icon}<span className="name">{c.kind === 'channel' ? c.name : c.title}</span>
      {c.mentions > 0 ? <span className="chat-count mention">@{c.mentions}</span> : c.unread > 0 && <span className={`chat-count${c.kind === 'channel' ? ' soft' : ''}`}>{c.unread}</span>}
    </button>
  );
  return (
    <nav className="chat-side" aria-label="Conversations">
      <button type="button" className={`chat-side-item${s.view === 'tasks' ? ' active' : ''}`} onClick={() => setChat({ view: 'tasks' })}><ListChecks size={15} /><span className="name">My tasks</span></button>
      <button type="button" className={`chat-side-item${s.view === 'search' ? ' active' : ''}`} onClick={() => setChat({ view: 'search' })}><Search size={15} /><span className="name">Search</span></button>
      <div className="chat-side-head">Channels</div>
      {mine.map((c) => item(c, <Hash size={15} />))}
      {others.length > 0 && <button type="button" className="chat-side-item dim" onClick={() => setBrowse(!browse)}><Plus size={15} /><span className="name">{browse ? 'Hide other channels' : `${others.length} more channel${others.length > 1 ? 's' : ''}`}</span></button>}
      {browse && others.map((c) => item(c, <Hash size={15} />))}
      <div className="chat-side-head">Direct messages <button type="button" className="icon" onClick={() => setChat({ view: 'new' })} title="New message" aria-label="New message"><MessageSquarePlus size={15} /></button></div>
      {dms.map((c) => item(c, c.kind === 'group' ? <Users size={15} /> : <Avatar id={c.members?.find((m) => m.id !== boot.me.id)?.id ?? boot.me.id} name={c.title} size={18} />))}
      {!dms.length && <button type="button" className="chat-side-item dim" onClick={() => setChat({ view: 'new' })}><Lock size={14} /><span className="name">Message someone privately</span></button>}
    </nav>
  );
}

// The slide-out team chat: Ctrl/⌘J from anywhere; the screen underneath stays as it was.
export default function ChatPanel() {
  const s = useChat();
  const { patientId } = useActivePatient();
  const panel = useRef(null);
  const returnFocus = useRef(null);
  const [asked, setAsked] = useRemembered('chat.notify_asked', false);
  const boot = s.boot;

  useEffect(() => {
    const on = (e) => {
      const d = e.detail || {};
      if (d.patient_id) openAboutPatient(d.patient_id);
      else openChat({ channelId: d.channel_id, userId: d.user_id, text: d.text, view: d.view });
    };
    window.addEventListener('dm:chat', on);
    return () => window.removeEventListener('dm:chat', on);
  }, []);
  useEffect(() => {
    if (s.open) {
      returnFocus.current = document.activeElement;
      if (!boot) loadBoot();
    } else if (returnFocus.current?.focus) {
      returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [s.open]); // eslint-disable-line react-hooks/exhaustive-deps

  useShortcuts([
    { combo: 'mod+j', handler: toggleChat, label: 'Open or close team chat', section: 'Team chat' },
    { combo: 'mod+shift+j', handler: () => openAboutPatient(patientId), label: 'Message the team about the active patient', section: 'Team chat', enabled: !!patientId },
  ]);

  // Command bar: open chat, my tasks, message about this patient, message a teammate — and
  // "chat @maria running late" (or "@maria running late") sends straight from the command bar.
  const quick = useRef(null);
  const team = boot?.team || [];
  const commands = useMemo(() => {
    const me = boot?.me;
    const list = [
      { id: 'chat-open', label: 'Open team chat', hint: `Team chat · ${comboLabel('mod+j').join(' ')}`, run: () => openChat() },
      { id: 'chat-tasks', label: 'My tasks (to-do list)', hint: 'Team chat', run: () => openChat({ view: 'tasks' }) },
    ];
    if (patientId) list.push({ id: 'chat-patient', label: 'Message about this patient', hint: `Team chat · ${comboLabel('mod+shift+j').join(' ')}`, run: () => openAboutPatient(patientId) });
    // One command for "open a chat with someone": its label follows what's typed ("@mar", "chat maria").
    const typed = () => (document.querySelector('.palette input')?.value || '').trim();
    const person = (w) => team.filter((u) => u.id !== me?.id && (u.name.toLowerCase().split(/\s+/).some((x) => x.startsWith(w)) || u.name.toLowerCase().replace(/[^\p{L}]/gu, '').startsWith(w)));
    const dm = { user: null };
    list.push({
      id: 'chat-person', hint: 'Team chat',
      get label() {
        const q = typed();
        const m = /^(?:(?:chat|msg|dm|tell)\s+@?|@)([\p{L}][\p{L}'.-]*)$/iu.exec(q);
        dm.user = m ? person(m[1].toLowerCase())[0] || null : null;
        return dm.user ? `${q} → chat with ${dm.user.name}` : 'Message a teammate: type @ and their name';
      },
      run: () => (dm.user ? openChat({ userId: dm.user.id }) : openChat({ view: 'new' })),
    });
    list.push({
      id: 'chat-quick', hint: 'Team chat · Enter sends it now',
      get label() {
        const q = (document.querySelector('.palette input')?.value || '').trim();
        const m = /^(?:(?:chat|message|msg|dm|tell)\s+)?@([\p{L}][\p{L}'.-]*)\s+(.+)$/iu.exec(q);
        const w = m?.[1].toLowerCase();
        const hits = w ? team.filter((u) => u.id !== me?.id && (firstName(u.name).toLowerCase() === w || u.name.toLowerCase().replace(/[^\p{L}]/gu, '').startsWith(w))) : [];
        quick.current = hits.length === 1 ? { user: hits[0], text: m[2] } : null;
        return quick.current ? `${q} → send to ${quick.current.user.name}` : 'Send a team message: “chat @name your message”';
      },
      run: async () => {
        const target = quick.current;
        if (!target) return openChat();
        try {
          const dm = await api.post('/chat/dms', { user_ids: [target.user.id] });
          await api.post(`/chat/channels/${dm.id}/messages`, { body: target.text, client_key: newKey() });
          toast(`Sent to ${target.user.name}`, { undo: null });
        } catch (e) {
          toast(e.message, { tone: 'error' });
        }
      },
    });
    return list;
  }, [boot?.me?.id, team, patientId]); // eslint-disable-line react-hooks/exhaustive-deps
  useCommands(commands);

  const channel = boot?.channels.find((c) => c.id === s.channelId) || null;
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (e.target.closest?.('.chat-edit, .chat-taskform')) return;
      e.preventDefault();
      if (s.threadId) setChat({ threadId: null });
      else closeChat();
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && boot) {
      e.preventDefault();
      const order = [...boot.channels.filter((c) => c.kind === 'channel' && c.member), ...boot.channels.filter((c) => c.kind !== 'channel')];
      const i = order.findIndex((c) => c.id === s.channelId);
      const pick = e.shiftKey ? order.find((c, j) => j !== i && (c.unread || c.mentions)) : order[(i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
      if (pick) setChat({ view: 'chat', channelId: pick.id, threadId: null });
    }
  };

  return (
    <>
      <ChatLive />
      {s.open && (
        <aside className={`chat-panel no-print${s.channelId || s.view !== 'chat' ? ' has-main' : ''}`} ref={panel} role="complementary" aria-label="Team chat" onKeyDown={onKey}>
          <div className="chat-top">
            <strong className="chat-brand">Team chat</strong>
            <span className="muted chat-keys"><kbd>{comboLabel('mod+j').join(' ')}</kbd> open/close · <kbd>Alt ↑↓</kbd> switch · <kbd>Esc</kbd> close</span>
            <button type="button" className="icon" onClick={() => setChat({ view: s.view === 'settings' ? 'chat' : 'settings' })} title="Chat settings" aria-label="Chat settings"><Settings2 size={16} /></button>
            <button type="button" className="icon" onClick={closeChat} title="Close (Esc)" aria-label="Close team chat"><X size={17} /></button>
          </div>
          {canNotify() && Notification.permission === 'default' && !asked && (
            <div className="chat-ask">
              <Bell size={15} /> Get a desktop notice (with a soft sound) when someone messages you.
              <button type="button" className="primary small" onClick={async () => { await askNotifyPermission(); setAsked(true); }}>Turn on</button>
              <button type="button" className="link" onClick={() => setAsked(true)}>Not now</button>
            </div>
          )}
          {!boot ? <div className="chat-empty">{s.error ? s.error.message : 'Loading…'}</div> : (
            <div className="chat-body-grid">
              <Sidebar boot={boot} s={s} />
              <section className="chat-main">
                {s.view === 'tasks' && <MyTasks team={boot.team} me={boot.me} />}
                {s.view === 'search' && <SearchView boot={boot} />}
                {s.view === 'settings' && <SettingsView boot={boot} />}
                {s.view === 'new' && <NewConversation boot={boot} onDone={() => setChat({ view: 'chat' })} />}
                {s.view === 'chat' && channel && !s.threadId && <Conversation key={channel.id} channel={channel} boot={boot} open={s.open} highlightId={s.highlightId} onThread={(id) => setChat({ threadId: id })} />}
                {s.view === 'chat' && channel && s.threadId && <Thread key={s.threadId} rootId={s.threadId} channel={channel} boot={boot} onClose={() => setChat({ threadId: null })} />}
                {s.view === 'chat' && !channel && <div className="chat-empty"><Hash size={28} /><div>Pick a conversation</div></div>}
              </section>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
