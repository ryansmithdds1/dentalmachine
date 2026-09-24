import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckSquare, CornerDownRight, FileText, MessageSquareReply, Pencil, SmilePlus, Trash2, User, ListChecks, Check } from 'lucide-react';
import { api, download } from '../../api.js';
import { useActivePatient } from '../../activePatient.jsx';
import { toast, undoable } from '../../toast.js';
import { EmojiPicker, GifView } from './Pickers.jsx';
import { QUICK_REACTIONS } from './emoji.js';
import { useBlobUrl, blobUrl, openChat, chatState } from './chatStore.js';

export const toDate = (s) => (s ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`) : null);
export const timeOf = (s) => toDate(s)?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) || '';
export const initials = (name = '') => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
// A steady color per person, from the theme's palette.
const HUES = [168, 200, 262, 330, 24, 45, 140, 290];
export const hueOf = (id) => HUES[Math.abs(Number(id) || 0) % HUES.length];
export function Avatar({ id, name, size = 32 }) {
  return <span className="chat-avatar" style={{ '--h': hueOf(id), width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{initials(name)}</span>;
}

// Text with @mentions highlighted and web links clickable (nothing else is interpreted).
const TOKENS = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|((?:^|(?<=[\s(]))@[\p{L}][\p{L}'.-]*)/gu;
export function RichText({ text, meName }) {
  if (!text) return null;
  const me = (meName || '').split(/\s+/)[0]?.toLowerCase();
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<a key={m.index} href={m[1]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);
    else {
      const who = m[2].slice(1).replace(/[.'-]+$/, '').toLowerCase();
      out.push(<span key={m.index} className={`chat-mention${who === me || ['everyone', 'all', 'here', 'channel'].includes(who) ? ' me' : ''}`}>{m[2]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function Attachment({ a }) {
  const isImage = /^image\//.test(a.mime);
  const src = useBlobUrl(isImage ? `/chat/attachments/${a.id}` : null);
  if (isImage) {
    return (
      <button type="button" className="chat-image" onClick={() => blobUrl(`/chat/attachments/${a.id}`).then((u) => window.open(u, '_blank', 'noopener'))} title={a.filename}>
        {src ? <img src={src} alt={a.filename} /> : <span className="gif-loading" />}
      </button>
    );
  }
  return (
    <button type="button" className="chat-file" onClick={() => download(`/chat/attachments/${a.id}?download=1`, a.filename).catch((e) => toast(e.message, { tone: 'error' }))}>
      <FileText size={16} /> <span>{a.filename}</span> <small className="muted">{Math.max(1, Math.round(a.size / 1024))} KB</small>
    </button>
  );
}

// "Make a task" right under the message: title, who, when — the message's patient comes along.
export function TaskForm({ message, team, me, onDone }) {
  const mentioned = team.find((u) => u.id !== me.id && (message.body || '').toLowerCase().includes(`@${u.name.split(' ')[0].toLowerCase()}`));
  const [f, setF] = useState({ title: (message.body || '').replace(/\s+/g, ' ').slice(0, 300), assigned_to: mentioned?.id || me.id, due_date: chatState().boot?.today || new Date().toLocaleDateString('en-CA') });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.post(`/chat/messages/${message.id}/task`, { ...f, assigned_to: Number(f.assigned_to) });
      toast(`Task added for ${t.assigned_to_name || 'you'}`);
      onDone(t);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="chat-taskform" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onDone(null)}>
      <input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Task" />
      <div className="row">
        <select value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })} aria-label="For">
          {team.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Me' : u.name}</option>)}
        </select>
        <input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} aria-label="Due" />
        {message.patient && <span className="chat-chip"><User size={12} /> {message.patient.name}</span>}
        <button className="primary small" disabled={busy}>Add task</button>
        <button type="button" className="small" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}

function Seen({ message }) {
  const [list, setList] = useState(null);
  const load = () => (list ? setList(null) : api.get(`/chat/messages/${message.id}/acks`).then(setList).catch((e) => toast(e.message, { tone: 'error' })));
  return (
    <span className="chat-seen">
      <button type="button" className="link" onClick={load}>Seen by {message.acks?.count || 0}</button>
      {list && (
        <span className="chat-seen-list">
          {list.acked.map((a) => <span key={a.user_id} className="ok"><Check size={11} /> {a.name}</span>)}
          {list.waiting.map((a) => <span key={a.user_id} className="wait">{a.name}</span>)}
        </span>
      )}
    </span>
  );
}

// One message: grouped under the previous one from the same person when close in time.
export default function Message({ m, me, team, compact, onReply, onEdit, onUpdate, inThread, editing, onSaveEdit, onCancelEdit, highlight }) {
  const nav = useNavigate();
  const { setActive } = useActivePatient();
  const [picker, setPicker] = useState(false);
  const [task, setTask] = useState(false);
  const [draft, setDraft] = useState(m.body || '');
  useEffect(() => { if (editing) setDraft(m.body || ''); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const react = async (emoji, on) => {
    try { onUpdate(await api.post(`/chat/messages/${m.id}/reactions`, { emoji, on })); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const toggle = (emoji) => react(emoji, !m.reactions.find((r) => r.emoji === emoji)?.mine);
  // No "are you sure?": it goes at once, and Undo brings it back.
  const remove = () => undoable('Message deleted', async () => onUpdate(await api.del(`/chat/messages/${m.id}`)), async () => onUpdate(await api.post(`/chat/messages/${m.id}/restore`))).catch(() => { /* undoable already showed why */ });
  const ack = async () => {
    try { await api.post(`/chat/messages/${m.id}/ack`); onUpdate({ ...m, acks: { count: (m.acks?.count || 0) + (m.acks?.mine ? 0 : 1), mine: true } }); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const openPatient = () => {
    setActive({ id: m.patient.id });
    nav(`/patients/${m.patient.id}`);
  };
  const deleted = m.status === 'deleted';
  return (
    <div className={`chat-msg${compact ? ' compact' : ''}${m.urgent && !deleted ? ' urgent' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${highlight ? ' highlight' : ''}`} data-id={m.id}>
      <div className="chat-msg-side">{compact ? <span className="chat-time-side">{timeOf(m.created_at)}</span> : <Avatar id={m.user_id} name={m.author_name} />}</div>
      <div className="chat-msg-main">
        {!compact && (
          <div className="chat-msg-head">
            <strong>{m.author_name || 'Someone'}</strong>
            {m.source && m.source !== 'human' && <span className="chat-tag">{m.source === 'ai' ? 'Assistant' : 'Automatic'}</span>}
            <span className="muted">{timeOf(m.created_at)}</span>
          </div>
        )}
        {m.urgent && !deleted && <div className="chat-urgent-tag"><AlertTriangle size={13} /> Urgent</div>}
        {deleted ? <div className="chat-deleted">Message deleted</div>
          : m.hidden ? <div className="chat-deleted">A message about a patient at another office</div>
            : editing ? (
              <div className="chat-edit">
                <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(8, draft.split('\n').length + 1)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(draft); }
                    if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); }
                  }} />
                <div className="muted small">Enter to save · Esc to cancel</div>
              </div>
            ) : (
              <>
                {m.body && <div className="chat-body"><RichText text={m.body} meName={me.name} />{m.edited_at && <span className="chat-edited"> (edited)</span>}</div>}
                {m.gif && <div className="chat-gif"><GifView gif={m.gif} /></div>}
                {m.attachments?.length > 0 && <div className="chat-files">{m.attachments.map((a) => <Attachment key={a.id} a={a} />)}</div>}
              </>
            )}
        {m.patient && !deleted && (
          <button type="button" className="chat-chip patient" onClick={openPatient} title="Open the chart"><User size={12} /> {m.patient.name}</button>
        )}
        {m.tasks?.length > 0 && (
          <div className="chat-task-chips">
            {m.tasks.map((t) => (
              <button type="button" key={t.id} className={`chat-chip task${t.status === 'done' ? ' done' : ''}`} onClick={() => openChat({ view: 'tasks' })}>
                <ListChecks size={12} /> {t.status === 'done' ? 'Done' : 'Task'} · {t.assigned_to_name || 'Unassigned'}
              </button>
            ))}
          </div>
        )}
        {m.reactions?.length > 0 && (
          <div className="chat-reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} type="button" className={r.mine ? 'mine' : ''} onClick={() => toggle(r.emoji)} title={r.names.join(', ')}>{r.emoji} <span>{r.count}</span></button>
            ))}
          </div>
        )}
        {m.urgent && !deleted && (
          <div className="chat-urgent-row">
            {m.user_id !== me.id && !m.acks?.mine && <button type="button" className="primary small" onClick={ack}><CheckSquare size={13} /> Got it</button>}
            {m.acks?.mine && <span className="ok-text"><Check size={13} /> You’ve seen this</span>}
            <Seen message={m} />
          </div>
        )}
        {!inThread && m.reply_count > 0 && (
          <button type="button" className="chat-replies" onClick={() => onReply(m)}><CornerDownRight size={13} /> {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}<span className="muted"> · last {timeOf(m.last_reply_at)}</span></button>
        )}
        {m.failed && <div className="error small">Didn’t send — <button type="button" className="link" onClick={m.retry}>try again</button></div>}
        {task && <TaskForm message={m} team={team} me={me} onDone={(t) => { setTask(false); if (t) onUpdate({ ...m, tasks: [...(m.tasks || []), { id: t.id, status: t.status, title: t.title, assigned_to: t.assigned_to, assigned_to_name: t.assigned_to_name }] }); }} />}
      </div>
      {!deleted && !m.hidden && !m.pending && !editing && (
        <div className="chat-actions" role="toolbar" aria-label="Message actions">
          {QUICK_REACTIONS.slice(0, 3).map((e) => <button key={e} type="button" onClick={() => toggle(e)} title={`React ${e}`}>{e}</button>)}
          <button type="button" onClick={() => setPicker(true)} title="Add a reaction" aria-label="Add a reaction"><SmilePlus size={15} /></button>
          {!inThread && <button type="button" onClick={() => onReply(m)} title="Reply in thread" aria-label="Reply in thread"><MessageSquareReply size={15} /></button>}
          <button type="button" onClick={() => setTask(true)} title="Make this a task" aria-label="Make this a task"><ListChecks size={15} /></button>
          {m.mine && m.kind === 'text' && <button type="button" onClick={() => { setDraft(m.body || ''); onEdit(m); }} title="Edit (↑ in an empty box)" aria-label="Edit"><Pencil size={14} /></button>}
          {m.mine && <button type="button" onClick={remove} title="Delete" aria-label="Delete"><Trash2 size={14} /></button>}
          {picker && <EmojiPicker align="right" onClose={() => setPicker(false)} onPick={(e) => { setPicker(false); react(e, true); }} />}
        </div>
      )}
    </div>
  );
}
