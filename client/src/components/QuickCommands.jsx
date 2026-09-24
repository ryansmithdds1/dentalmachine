import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { useLookup } from '../hooks.js';
import SendForms from './FormsSend.jsx';
import './quick.css';

// Command bar commands that work on every screen (mounted once in the staff app):
//   "task call the lab about #14 @anna"  → a task for Anna, due today, about the active patient (workflow 28)
//   "Consent forms for <active patient>" → the consents for their planned work, ready to sign here or send (23)
// and the "new task for you" note when someone assigns you one.
//
// Task counts are polled (and refreshed at once after a change made on this screen) rather than streamed: each
// live-events stream holds one of the browser's six connections to the server, and one more starves every other
// request. (If live.js ever shares one stream across the app, subscribe to the server's "tasks" events here.)
const POLL_MS = 15_000;
const taskStore = { count: null, listeners: new Set(), timer: null, userId: null };
const tell = () => taskStore.listeners.forEach((f) => f(taskStore.count));
export const tasksChanged = () => window.dispatchEvent(new Event('dm:tasks'));
async function pollTasks() {
  try {
    const c = await api.get('/tasks/count');
    const before = taskStore.count;
    taskStore.count = c;
    // Someone gave me a new task since the last look: a note, wherever I am.
    if (before && c.latest && c.latest.id !== before.latest?.id && c.latest.id > (before.latest?.id || 0)) {
      toast(`New task from ${c.latest.created_by_name || 'the office'}: ${c.latest.title}`, { ms: 10000 });
    }
    tell();
  } catch { /* signed out or offline: the next poll tries again */ }
}
function useTaskCount() {
  const [c, setC] = useState(taskStore.count);
  useEffect(() => {
    taskStore.listeners.add(setC);
    if (taskStore.listeners.size === 1) {
      pollTasks();
      taskStore.timer = setInterval(() => { if (document.visibilityState !== 'hidden') pollTasks(); }, POLL_MS);
      window.addEventListener('dm:tasks', pollTasks);
      window.addEventListener('focus', pollTasks);
    }
    return () => {
      taskStore.listeners.delete(setC);
      if (!taskStore.listeners.size) {
        clearInterval(taskStore.timer);
        window.removeEventListener('dm:tasks', pollTasks);
        window.removeEventListener('focus', pollTasks);
        taskStore.count = null;
      }
    };
  }, []);
  return c;
}
const TASK = /^\s*(task|todo|to-do)\s+(\S.*)$/i;
const paletteText = () => document.querySelector('.palette input')?.value || '';
const firstName = (n) => String(n || '').replace(/^(dr|mr|mrs|ms)\.?\s+/i, '').split(/[\s,]+/)[0];

// Who "@name" will go to, for the preview (the server decides, and refuses anything unclear).
function previewAssignee(text, users) {
  const m = /(^|\s)@([\p{L}][\p{L}'.-]*)/u.exec(text);
  if (!m) return 'Anyone';
  const who = m[2].replace(/\.+$/, '').toLowerCase();
  const active = users.filter((u) => u.active);
  let hits = active.filter((u) => firstName(u.name).toLowerCase() === who);
  if (!hits.length) hits = active.filter((u) => firstName(u.name).toLowerCase().startsWith(who));
  return hits.length === 1 ? hits[0].name : hits.length ? `@${who}: ${hits.length} people match` : `nobody called @${who}`;
}

export default function QuickCommands() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { patientId, recent } = useActivePatient();
  const users = useLookup('/users');
  const [consent, setConsent] = useState(null);
  const active = recent.find((r) => r.id === patientId) || null;
  const canTask = ['patients:write', 'billing:write', 'clinical:write'].some((p) => can(p));
  const state = useRef({});
  state.current = { patientId, active, users, canTask };

  const addTask = async (text) => {
    const { patientId: pid, active: who } = state.current;
    try {
      const t = await api.post('/tasks', { text, patient_id: pid || null });
      tasksChanged();
      toast(`Task for ${t.assigned_to_name || 'anyone'}${t.due_date ? ', due today' : ''}${who ? ` · ${who.first_name} ${who.last_name}` : ''}: ${t.title}`);
    } catch (e) {
      toast(`Couldn’t add the task: ${e.message}`, { tone: 'error' });
    }
  };

  // Enter on "task …" in the command bar adds the task, whatever patients the words happen to match.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || !e.isTrusted || !e.target.matches?.('.palette input') || !state.current.canTask) return;
      const m = TASK.exec(e.target.value);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      e.target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      addTask(m[2]);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openConsent = async () => {
    const pid = state.current.patientId;
    try {
      const [patient, planned] = await Promise.all([api.get(`/patients/${pid}`), api.get(`/patients/${pid}/procedures?status=planned`)]);
      setConsent({ patient, procedureIds: planned.map((p) => p.id) });
    } catch (e) {
      toast(`Couldn’t open the forms: ${e.message}`, { tone: 'error' });
    }
  };

  // The task command's label is what was typed, so the command bar lists it for any "task …" text.
  const taskCommand = useMemo(() => ({
    id: 'quick-task',
    get label() { return TASK.test(paletteText()) ? paletteText().trim() : 'task … @name — add a task for someone'; },
    get hint() {
      const m = TASK.exec(paletteText());
      const { active: who, users: team } = state.current;
      return m ? `New task for ${previewAssignee(m[2], team)} · due today${who ? ` · about ${who.first_name} ${who.last_name}` : ''}` : 'Type “task”, what needs doing and @their first name';
    },
    run: () => {
      const m = TASK.exec(paletteText());
      if (m) addTask(m[2]);
      else navigate('/office');
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useCommands([
    ...(canTask ? [taskCommand] : []),
    ...(active && can('patients:write') ? [{ id: 'consent-forms', label: `Consent forms for ${active.first_name} ${active.last_name}`, hint: 'The consents for their planned work — sign here or send', run: openConsent }] : []),
  ]);

  // Keeps the count (and the "new task for you" note) going on every screen.
  useTaskCount();

  if (!consent) return null;
  return (
    <SendForms
      patient={consent.patient} procedureIds={consent.procedureIds} title={`Consent forms for ${consent.patient.first_name} ${consent.patient.last_name}`}
      onClose={() => setConsent(null)}
    />
  );
}

// The count on To-do & labs: open tasks assigned to me (red when some are due today or overdue).
export function TaskBadge() {
  const c = useTaskCount();
  if (!c?.open) return null;
  return <span className={`nav-badge${c.due ? '' : ' calm'}`} title={`${c.open} open task${c.open === 1 ? '' : 's'} for you${c.due ? `, ${c.due} due` : ''}`}>{c.open}</span>;
}
