import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Check, ChevronDown, ChevronRight, MessageSquare, Plus, Repeat, User, X } from 'lucide-react';
import { api } from '../../api.js';
import { toast, undoable } from '../../toast.js';
import { useActivePatient } from '../../activePatient.jsx';
import { openChat, onLive } from './chatStore.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayIndex = (w) => DAYS.findIndex((d) => d.startsWith(w) && w.length >= 3);
const fmtDue = (s, today) => {
  if (!s) return '';
  if (s === today) return 'Today';
  if (s === addDays(today, 1)) return 'Tomorrow';
  if (s === addDays(today, -1)) return 'Yesterday';
  const d = new Date(`${s}T12:00:00Z`);
  return d.toLocaleDateString([], { weekday: s < addDays(today, 7) && s > today ? 'long' : undefined, month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// One line typed into "Add a task": "order gloves @maria fri", "call lab tomorrow !", "check the autoclave every monday".
// @name picks who (one clear first-name match), today/tomorrow/a weekday/"in 3 days" the due date, "every …" repeats it,
// and "!" makes it high priority. What's left is the title.
export function parseTaskLine(line, team, today) {
  let text = ` ${line} `;
  const out = { assigned_to: undefined, due_date: null, repeat: null, priority: 'normal' };
  const every = /\severy\s+(day|weekday|week|other week|month|(sun|mon|tue|wed|thu|fri|sat)[a-z]*)\s/i.exec(text);
  if (every) {
    const w = every[1].toLowerCase();
    if (w === 'day') out.repeat = { rule: 'daily' };
    else if (w === 'weekday') out.repeat = { rule: 'weekdays' };
    else if (w === 'week') out.repeat = { rule: 'weekly' };
    else if (w === 'other week') out.repeat = { rule: 'biweekly' };
    else if (w === 'month') out.repeat = { rule: 'monthly' };
    else {
      const i = dayIndex(w.slice(0, 3));
      out.repeat = { rule: 'weekly', weekday: i };
      const now = new Date(`${today}T12:00:00Z`).getUTCDay();
      out.due_date = addDays(today, (i - now + 7) % 7);
    }
    text = text.replace(every[0], ' ');
  }
  const at = /\s@([\p{L}][\p{L}'.-]*)\s/u.exec(text);
  if (at) {
    const w = at[1].toLowerCase();
    const hits = team.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === w || u.name.toLowerCase().replace(/[^\p{L}]/gu, '').startsWith(w));
    if (hits.length === 1) { out.assigned_to = hits[0].id; text = text.replace(at[0], ' '); }
  }
  const when = /\s(today|tomorrow|tmrw|in\s+(\d{1,2})\s+days?|(?:next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*)\s/i.exec(text);
  if (when && !out.due_date) {
    const w = when[1].toLowerCase();
    if (w === 'today') out.due_date = today;
    else if (w === 'tomorrow' || w === 'tmrw') out.due_date = addDays(today, 1);
    else if (when[2]) out.due_date = addDays(today, Number(when[2]));
    else {
      const i = dayIndex(when[3].toLowerCase());
      const now = new Date(`${today}T12:00:00Z`).getUTCDay();
      out.due_date = addDays(today, ((i - now + 7) % 7) || 7);
    }
    text = text.replace(when[0], ' ');
  }
  if (/\s!{1,3}\s/.test(text)) { out.priority = 'high'; text = text.replace(/\s!{1,3}\s/, ' '); }
  out.title = text.replace(/\s+/g, ' ').trim();
  return out;
}

function TaskRow({ t, today, team, me, selected, onSelect, onChange, view }) {
  const nav = useNavigate();
  const { setActive } = useActivePatient();
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState('');
  const done = t.status === 'done';
  const overdue = !done && t.due_date && t.due_date < today;
  const toggle = () => undoable(done ? 'Task reopened' : 'Task done',
    async () => onChange(await api.post(`/chat/tasks/${t.id}/${done ? 'reopen' : 'done'}`)),
    async () => onChange(await api.post(`/chat/tasks/${t.id}/${done ? 'done' : 'reopen'}`))).catch(() => { /* undoable showed why */ });
  const put = async (body) => { try { onChange(await api.put(`/chat/tasks/${t.id}`, body)); } catch (e) { toast(e.message, { tone: 'error' }); } };
  const tick = async (i) => { try { onChange(await api.put(`/chat/tasks/${t.id}/checklist/${i.id}`, { done: !i.done_at })); } catch (e) { toast(e.message, { tone: 'error' }); } };
  const addItem = async (e) => {
    e.preventDefault();
    if (!item.trim()) return;
    try { onChange(await api.post(`/chat/tasks/${t.id}/checklist`, { text: item })); setItem(''); } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  const fromChat = async () => {
    try {
      const m = await api.get(`/chat/messages/${t.chat_message_id}`);
      openChat({ channelId: m.channel_id, threadId: m.parent_id || null });
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const doneItems = t.checklist?.filter((i) => i.done_at).length || 0;
  return (
    <li className={`task-row${done ? ' done' : ''}${selected ? ' selected' : ''}${t.priority === 'high' ? ' high' : ''}`} onClick={onSelect} data-task={t.id}>
      <div className="task-line">
        <button type="button" className="task-check" aria-label={done ? 'Mark not done' : 'Mark done'} onClick={(e) => { e.stopPropagation(); toggle(); }}>{done && <Check size={13} />}</button>
        <button type="button" className="task-title" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} <span>{t.title}</span>
        </button>
        <span className="task-meta">
          {t.repeat_rule && <Repeat size={12} aria-label="Repeats" />}
          {t.checklist?.length > 0 && <span className="muted">{doneItems}/{t.checklist.length}</span>}
          {t.patient && <button type="button" className="chat-chip patient" onClick={(e) => { e.stopPropagation(); setActive({ id: t.patient.id }); nav(`/patients/${t.patient.id}`); }}><User size={11} /> {t.patient.name}</button>}
          {view === 'assigned' && <span className="chat-chip">{t.assigned_to_name || 'Anyone'}</span>}
          {t.due_date && <span className={`task-due${overdue ? ' overdue' : ''}`}>{fmtDue(t.due_date, today)}</span>}
        </span>
      </div>
      {open && (
        <div className="task-more" onClick={(e) => e.stopPropagation()}>
          {t.notes && <p className="muted">{t.notes}</p>}
          {t.checklist?.length > 0 && (
            <ul className="task-checklist">
              {t.checklist.map((i) => (
                <li key={i.id}><label><input type="checkbox" checked={!!i.done_at} onChange={() => tick(i)} /> <span className={i.done_at ? 'struck' : ''}>{i.text}</span></label></li>
              ))}
            </ul>
          )}
          <form className="task-additem" onSubmit={addItem}><input placeholder="Add a checklist item…" value={item} onChange={(e) => setItem(e.target.value)} /></form>
          <div className="task-edit-row">
            <label><CalendarDays size={13} /> <input type="date" value={t.due_date || ''} onChange={(e) => put({ due_date: e.target.value || null })} /></label>
            <label>For <select value={t.assigned_to || ''} onChange={(e) => put({ assigned_to: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Anyone</option>
              {team.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Me' : u.name}</option>)}
            </select></label>
            {t.chat_message_id && <button type="button" className="small" onClick={fromChat}><MessageSquare size={13} /> Open the message</button>}
          </div>
          <div className="muted small">Added by {t.created_by_name || 'the system'}{t.completed_by_name ? ` · done by ${t.completed_by_name}` : ''}</div>
        </div>
      )}
    </li>
  );
}

// "My tasks": overdue, today, upcoming and someday; what I gave others; repeating tasks. Keyboard in the list:
// J/K move, X done (Ctrl/⌘Z undoes), Enter opens, N adds.
export default function MyTasks({ team = [], me }) {
  const [view, setView] = useState('mine');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [line, setLine] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const load = useCallback(() => api.get(`/chat/tasks${view === 'assigned' ? '?view=assigned' : ''}`).then((d) => { setData(d); setError(null); }).catch(setError), [view]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((e) => e.type === 'tasks' && (e.assigned_to === me?.id || e.by === me?.id || e.assigned_to == null) && load()), [load, me?.id]);
  const today = data?.today || new Date().toLocaleDateString('en-CA');
  const groups = useMemo(() => {
    const tasks = data?.tasks || [];
    return [
      ['Overdue', tasks.filter((t) => t.due_date && t.due_date < today), 'overdue'],
      ['Today', tasks.filter((t) => t.due_date === today), 'today'],
      ['Upcoming', tasks.filter((t) => t.due_date && t.due_date > today), ''],
      ['Someday', tasks.filter((t) => !t.due_date), ''],
      ['Done recently', data?.done || [], 'done'],
    ].filter(([, l]) => l.length);
  }, [data, today]);
  const flat = groups.flatMap(([, l]) => l);
  const replace = (t) => setData((d) => {
    if (!d) return d;
    const without = (l) => l.filter((x) => x.id !== t.id);
    return t.status === 'done' ? { ...d, tasks: without(d.tasks), done: [t, ...without(d.done)] } : { ...d, tasks: [...without(d.tasks), t].sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9'))), done: without(d.done) };
  });
  const parsed = line.trim() ? parseTaskLine(line, team, today) : null;
  const add = async (e) => {
    e.preventDefault();
    if (!parsed?.title) return;
    try {
      const body = { title: parsed.title, priority: parsed.priority, due_date: parsed.due_date ?? today, ...(parsed.assigned_to !== undefined ? { assigned_to: parsed.assigned_to } : {}), ...(parsed.repeat ? { repeat: parsed.repeat } : {}) };
      const t = await api.post('/chat/tasks', body);
      setLine('');
      toast(t.assigned_to === me.id ? 'Task added' : `Task added for ${t.assigned_to_name}`);
      load();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  const onKey = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(flat.length - 1, i + 1)); }
    else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (k === 'x' && flat[sel]) { e.preventDefault(); list.current?.querySelector(`[data-task="${flat[sel].id}"] .task-check`)?.click(); }
    else if (e.key === 'Enter' && flat[sel]) { e.preventDefault(); list.current?.querySelector(`[data-task="${flat[sel].id}"] .task-title`)?.click(); }
    else if (k === 'n') { e.preventDefault(); input.current?.focus(); }
  };
  const stop = async (s) => { try { await api.post(`/chat/series/${s.id}/stop`); toast(`“${s.title}” won’t repeat any more`); load(); } catch (e) { toast(e.message, { tone: 'error' }); } };
  const who = parsed?.assigned_to !== undefined ? team.find((u) => u.id === parsed.assigned_to) : null;
  return (
    <div className="my-tasks">
      <div className="seg task-tabs" role="tablist">
        <button className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')} role="tab" aria-selected={view === 'mine'}>My tasks</button>
        <button className={view === 'assigned' ? 'active' : ''} onClick={() => setView('assigned')} role="tab" aria-selected={view === 'assigned'}>I asked others</button>
      </div>
      <form onSubmit={add} className="task-add">
        <Plus size={15} />
        <input ref={input} value={line} onChange={(e) => setLine(e.target.value)} placeholder="Add a task… e.g. “order gloves @maria fri” or “sterilizer log every monday”" aria-label="Add a task" />
      </form>
      {parsed?.title && (
        <div className="task-preview muted">
          “{parsed.title}” · {who ? `for ${who.id === me.id ? 'me' : who.name}` : 'for me'} · {parsed.due_date ? fmtDue(parsed.due_date, today) : 'today'}
          {parsed.repeat && ` · repeats ${parsed.repeat.rule}`}{parsed.priority === 'high' && ' · high priority'} — Enter to add
        </div>
      )}
      {error && <div className="error">{error.message}</div>}
      <div className="task-lists" ref={list} tabIndex={0} onKeyDown={onKey} aria-label="Tasks (J/K to move, X to mark done)">
        {!data && !error && <div className="muted small-pad">Loading…</div>}
        {data && !flat.length && <div className="chat-empty"><Check size={28} /><div>All clear. Nothing on your list.</div></div>}
        {groups.map(([name, l, tone]) => (
          <section key={name}>
            <h4 className={`task-group ${tone}`}>{name} <span>{l.length}</span></h4>
            <ul>{l.map((t) => <TaskRow key={t.id} t={t} today={today} team={team} me={me} view={view} selected={flat[sel]?.id === t.id} onSelect={() => setSel(flat.findIndex((x) => x.id === t.id))} onChange={replace} />)}</ul>
          </section>
        ))}
        {data?.series?.length > 0 && (
          <section>
            <h4 className="task-group">Repeating <span>{data.series.length}</span></h4>
            <ul>{data.series.map((s) => (
              <li key={s.id} className="task-row series">
                <div className="task-line"><Repeat size={13} /> <span className="task-title plain">{s.title}</span>
                  <span className="task-meta"><span className="muted">{s.rule === 'weekly' || s.rule === 'biweekly' ? `${s.rule === 'biweekly' ? 'every other' : 'every'} ${DAYS[s.weekday]?.replace(/^./, (c) => c.toUpperCase())}` : s.rule === 'monthly' ? `monthly on the ${s.month_day}` : s.rule === 'weekdays' ? 'every weekday' : 'every day'}</span>
                    {s.assigned_to_name && <span className="chat-chip">{s.assigned_to_name}</span>}
                    <button type="button" className="small" onClick={() => stop(s)} title="Stop repeating"><X size={12} /> Stop</button></span>
                </div>
              </li>
            ))}</ul>
          </section>
        )}
      </div>
    </div>
  );
}
