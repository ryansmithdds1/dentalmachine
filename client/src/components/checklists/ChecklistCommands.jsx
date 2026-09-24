import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useCommands } from '../../shortcuts.js';
import { useLiveEvents } from '../../live.js';
import './checklists.css';

// Always mounted in the signed-in shell (App.jsx, next to IntranetCommands):
// - puts the checklists into the command bar (Ctrl/⌘K → "checklist" → Enter);
// - shows owners / office managers a banner the moment a critical checklist item fails, reads out of range or
//   misses its time (the live event carries ids only; the words come from the server's flag list).
export default function ChecklistCommands() {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const manager = can?.('checklists:manage');
  const [alert, setAlert] = useState(null);
  const commands = useMemo(() => [
    { id: 'checklist-mine', label: 'My checklist today', hint: 'Checklists', run: () => nav('/checklists') },
    ...(manager ? [
      { id: 'checklist-dashboard', label: 'Checklist dashboard (done, late, missed)', hint: 'Checklists', run: () => nav('/checklists/dashboard') },
      { id: 'checklist-setup', label: 'Set up checklists by position', hint: 'Checklists', run: () => nav('/checklists/setup') },
      { id: 'checklist-log', label: 'Compliance log (spore tests, AED checks…)', hint: 'Checklists', run: () => nav('/checklists/log') },
    ] : []),
  ], [manager, nav]);
  useCommands(commands);

  const show = useCallback(async (flagId) => {
    try {
      const flags = await api.get('/checklists/flags');
      const f = flags.find((x) => x.id === flagId);
      if (f) setAlert(f);
    } catch { /* the Needs attention item and chat post still carry it */ }
  }, []);
  useLiveEvents((e) => {
    if (e.type !== 'checklist_alert' || !user) return;
    if (Array.isArray(e.to) && !e.to.includes(user.id)) return;
    if (e.critical) show(e.flag_id);
  });
  // Critical flags already open when a manager signs in: one banner, so it isn't missed.
  useEffect(() => {
    if (!manager) return;
    api.get('/checklists/flags').then((list) => { const c = list.find((f) => f.critical); if (c) setAlert(c); }).catch(() => { /* nothing to show */ });
  }, [manager]);

  if (!alert) return null;
  return (
    <div className="cl-alert" role="alert">
      <AlertTriangle size={20} aria-hidden />
      <div style={{ flex: 1 }}>
        <strong>{alert.title}</strong>
        <div style={{ fontSize: 12.5, opacity: 0.9 }}>{alert.completed_by_name ? `Recorded by ${alert.completed_by_name}. ` : ''}Open until someone writes down the corrective action.</div>
      </div>
      <button className="small" onClick={() => { setAlert(null); nav('/checklists/dashboard'); }}>Open</button>
      <button className="small" aria-label="Dismiss" onClick={() => setAlert(null)}><X size={14} /></button>
    </div>
  );
}

// A count for the nav item (optional): items due for me now, red when any is overdue.
export function ChecklistBadge() {
  const [c, setC] = useState(null);
  const load = useCallback(() => api.get('/checklists/count').then(setC).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, [load]);
  useLiveEvents((e) => { if (e.type === 'checklists') load(); });
  if (!c?.due) return null;
  return <span className={`badge ${c.overdue ? 'danger' : 'info'}`} style={{ marginLeft: 'auto' }} aria-label={`${c.due} checklist items due`}>{c.due}</span>;
}
