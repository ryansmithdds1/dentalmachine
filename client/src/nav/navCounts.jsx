import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLiveEvents } from '../live.js';
import { useTaskCount } from '../components/QuickCommands.jsx';

// The sidebar's numbers: each page's own count, and on each group icon the sum of its pages', so nothing
// hides behind a closed group. Tone: 'alert' (red) wants a person now, 'calm' (grey) and 'info' can wait.
const POLL_MS = 5 * 60_000;

function useCount(path, pick, isEvent, { poll = false, event = null } = {}) {
  const [n, setN] = useState(null);
  const load = useCallback(() => {
    if (!path) return;
    // A badge is a hint: when it can't load, the page itself still shows everything.
    api.get(path).then((d) => setN(pick(d))).catch(() => {});
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!path) { setN(null); return undefined; }
    load();
    const t = poll ? setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, POLL_MS) : null;
    // A screen that knows the new number (Billing's approval queue) says so at once.
    const onEvent = (e) => (typeof e.detail === 'number' ? setN(e.detail) : load());
    if (event) window.addEventListener(event, onEvent);
    return () => { if (t) clearInterval(t); if (event) window.removeEventListener(event, onEvent); };
  }, [path, load, poll, event]);
  useLiveEvents((e) => { if (path && isEvent(e)) load(); });
  return n;
}

// show: which counted pages this person has in their sidebar (only those are loaded).
export function useNavCounts(show) {
  const attention = useCount(show.attention ? '/issues?role=mine' : null, (d) => d.issues.length, (e) => e.type === 'issues');
  const unread = useCount(show.unread ? '/conversations/unread' : null, (d) => d.unread, (e) => e.type === 'message');
  const checklists = useCount(show.checklists ? '/checklists/count' : null, (d) => d, (e) => e.type === 'checklists', { poll: true });
  const claims = useCount(show.claims ? '/claim-queue/count' : null, (d) => d.count, () => false, { poll: true, event: 'dm:claim-queue' });
  const tasks = useTaskCount();
  const out = {};
  if (attention) out.attention = { n: attention, tone: 'alert', title: `${attention} item${attention === 1 ? '' : 's'} in your Needs attention list` };
  if (unread) out.unread = { n: unread, tone: 'alert', title: `${unread} unread message${unread === 1 ? '' : 's'}` };
  if (show.tasks && tasks?.open) out.tasks = { n: tasks.open, tone: tasks.due ? 'alert' : 'calm', title: `${tasks.open} open task${tasks.open === 1 ? '' : 's'} for you${tasks.due ? `, ${tasks.due} due` : ''}` };
  if (checklists?.due) out.checklists = { n: checklists.due, tone: checklists.overdue ? 'alert' : 'info', title: `${checklists.due} checklist item${checklists.due === 1 ? '' : 's'} due${checklists.overdue ? `, ${checklists.overdue} overdue` : ''}` };
  if (claims) out.claims = { n: claims, tone: 'info', title: `${claims} claim${claims === 1 ? '' : 's'} ready to approve` };
  return out;
}

// A group's badge: the sum of its pages', red if any of them is.
export function rollUp(pages, counts) {
  const parts = pages.map((p) => p.badge && counts[p.badge]).filter(Boolean);
  if (!parts.length) return null;
  const tones = new Set(parts.map((b) => b.tone));
  return { n: parts.reduce((s, b) => s + b.n, 0), tone: tones.has('alert') ? 'alert' : tones.has('info') ? 'info' : 'calm', title: parts.map((b) => b.title).join(' · ') };
}

export function NavBadge({ badge, className = '' }) {
  if (!badge?.n) return null;
  return <span className={`nav-badge ${badge.tone}${className ? ` ${className}` : ''}`} title={badge.title} aria-label={badge.title}>{badge.n > 99 ? '99+' : badge.n}</span>;
}
