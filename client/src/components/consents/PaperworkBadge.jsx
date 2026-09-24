import { useEffect, useState } from 'react';
import { FileCheck2, FileClock, FileX2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';
import { openPaperwork } from './ConsentPanel.jsx';
import './consents.css';

// Forms and consents done / not done, for the schedule, the huddle and the visit (P5, C3).
//   usePaperworkStatus(date)            → { [appointment_id]: summary } for a day (one request, shared by every card)
//   <PaperworkBadge status={summary} /> → a small icon for a schedule card
//   <PaperworkBadgeFor appointmentId date /> → the same, looking the status up itself
//   <VisitPaperwork appointment={a} />  → "consents signed" (or not) where the clinician sees it before starting
const store = new Map(); // date → { data, at, listeners, loading }
const EMPTY = {};
async function fetchDay(date) {
  const e = store.get(date);
  if (e.loading) return;
  e.loading = true;
  try {
    e.data = await api.get(`/paperwork/status?date=${date}`);
    e.at = Date.now();
    e.listeners.forEach((f) => f(e.data));
  } catch { /* the schedule works without it; the next change or refresh tries again */ } finally { e.loading = false; }
}
let timer = null;
const refreshAll = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { for (const [date, e] of store) if (e.listeners.size) fetchDay(date); }, 400);
};

export function usePaperworkStatus(date) {
  const [data, setData] = useState(() => store.get(date)?.data || EMPTY);
  useEffect(() => {
    if (!date) return undefined;
    if (!store.has(date)) store.set(date, { data: null, at: 0, listeners: new Set(), loading: false });
    const e = store.get(date);
    e.listeners.add(setData);
    if (e.data) setData(e.data);
    if (!e.data || Date.now() - e.at > 60_000) fetchDay(date);
    return () => e.listeners.delete(setData);
  }, [date]);
  useLiveEvents((ev) => { if (['paperwork', 'kiosk', 'schedule'].includes(ev.type)) refreshAll(); });
  return data;
}

export function PaperworkBadge({ status }) {
  if (!status || status.state === 'none') return null;
  const declined = status.consents?.declined > 0;
  const cls = declined ? 'declined' : status.state;
  const Icon = declined ? FileX2 : status.state === 'done' ? FileCheck2 : FileClock;
  const title = status.state === 'done'
    ? 'Forms and consents done'
    : `Forms: ${status.done} of ${status.total} done${status.consents?.total ? ` · consents ${status.consents.signed}/${status.consents.total} signed` : ''}${declined ? ' · a consent was declined' : ''}${status.open_items?.length ? ` — still to do: ${status.open_items.join(', ')}` : ''}`;
  return <span className={`pw-badge ${cls}`} title={title} aria-label={title} data-paperwork={cls}><Icon size={13} strokeWidth={2.2} /></span>;
}

export function PaperworkBadgeFor({ appointmentId, date }) {
  const all = usePaperworkStatus(date);
  return <PaperworkBadge status={all[appointmentId]} />;
}

// Before starting: are the visit's consents signed? One line, one click to fix.
export function VisitPaperwork({ appointment }) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/appointments/${appointment.id}/consent-check`).then((c) => live && setCheck(c)).catch(() => live && setCheck(null));
    return () => { live = false; };
  }, [appointment.id]);
  useLiveEvents((ev) => {
    if (ev.type === 'paperwork' && Number(ev.appointment_id) === Number(appointment.id)) api.get(`/appointments/${appointment.id}/consent-check`).then(setCheck).catch(() => {});
  });
  if (!check || !check.consents.length) return null;
  const ready = check.ready;
  return (
    <div className={`pw-visit ${ready ? 'ready' : 'missing'}`} data-consent-ready={ready ? '1' : '0'}>
      {ready ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
      <span>{ready ? 'Consents signed' : `${check.needed.length + check.declined.length} consent${check.needed.length + check.declined.length === 1 ? '' : 's'} not signed${check.declined.length ? ` (${check.declined.length} declined)` : ''}`}</span>
      <button className="small" onClick={() => openPaperwork(appointment.patient_id, { appointmentId: appointment.id })}>{ready ? 'View' : 'Get signed'}</button>
    </div>
  );
}
