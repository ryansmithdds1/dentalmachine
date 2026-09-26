import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';

// What the schedule's cards show beyond the visit itself (PP1, PP2, DN1, S8, S6 — docs/workflows/specs/PP-DN-S8-S6.md):
// one request per range of days (GET /schedule-cards), shared by every card, refreshed on live events and when
// something here changes (refreshCards()). The schedule works without it: a failed load just leaves the extras off.
export const CARDS_CHANGED = 'dm:cards';
export const refreshCards = () => window.dispatchEvent(new Event(CARDS_CHANGED));

const store = new Map(); // "from|to" → { data, at, listeners, loading, again }
async function load(key) {
  const e = store.get(key);
  if (e.loading) { e.again = true; return; }
  e.loading = true;
  const [from, to] = key.split('|');
  try {
    e.data = await api.get(`/schedule-cards?from=${from}&to=${to}`);
    e.at = Date.now();
    e.listeners.forEach((f) => f(e.data));
  } catch { /* extras only: the next change or refresh tries again */ } finally {
    e.loading = false;
    if (e.again) { e.again = false; load(key); }
  }
}
let timer = null;
const refreshAll = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { for (const [k, e] of store) if (e.listeners.size) load(k); }, 250);
};
if (typeof window !== 'undefined') window.addEventListener(CARDS_CHANGED, refreshAll);

const EMPTY = { by_appt: {}, slot_notes: [], other_notes: [], layout: null };
export function useCardData(from, to) {
  const key = from && to ? `${from}|${to}` : null;
  const [data, setData] = useState(() => (key && store.get(key)?.data) || EMPTY);
  useEffect(() => {
    if (!key) return undefined;
    if (!store.has(key)) store.set(key, { data: null, at: 0, listeners: new Set(), loading: false, again: false });
    const e = store.get(key);
    e.listeners.add(setData);
    setData(e.data || EMPTY);
    if (!e.data || Date.now() - e.at > 30_000) load(key);
    return () => e.listeners.delete(setData);
  }, [key]);
  useLiveEvents((ev) => { if (['cards', 'doctor_note', 'schedule'].includes(ev.type)) refreshAll(); });
  return data;
}

// A patient's preferences, latest personal note and strikes (the patient bar, the chart header, the drawer).
const conn = new Map(); // patientId → { data, listeners, loading }
async function loadConn(id) {
  const e = conn.get(id);
  // A live event can arrive for a patient whose panel hasn't mounted its entry yet (the next render does that).
  if (!e || e.loading) return;
  e.loading = true;
  try {
    e.data = await api.get(`/patients/${id}/connection`);
    e.listeners.forEach((f) => f(e.data));
  } catch { /* shown when it loads */ } finally { e.loading = false; }
}
export function useConnection(patientId) {
  const [data, setData] = useState(() => conn.get(patientId)?.data || null);
  useEffect(() => {
    if (!patientId) return undefined;
    if (!conn.has(patientId)) conn.set(patientId, { data: null, listeners: new Set(), loading: false });
    const e = conn.get(patientId);
    e.listeners.add(setData);
    setData(e.data);
    loadConn(patientId);
    const again = () => loadConn(patientId);
    window.addEventListener(CARDS_CHANGED, again);
    return () => { e.listeners.delete(setData); window.removeEventListener(CARDS_CHANGED, again); };
  }, [patientId]);
  // A cancel or move "for our reason" comes as a schedule change; preferences and notes as cards changes.
  useLiveEvents((ev) => { if (patientId && (ev.type === 'schedule' || (ev.type === 'cards' && (!ev.patient_id || ev.patient_id === Number(patientId))))) loadConn(patientId); });
  return data;
}

// "Moved by us 2× in 12 mo" and, on hover, when and why.
export const strikeTitle = (s) => (s?.list || []).map((m) => `${m.happened_on} · ${m.kind === 'cancel' ? 'cancelled' : 'moved'} · ${m.reason_label}${m.note ? ` (${m.note})` : ''}`).join('\n');
export const strikeLabel = (s) => (s?.count ? `Moved by us ${s.count}× in 12 mo` : '');
