import { useEffect, useState } from 'react';
import { api, getToken, getLocationId } from '../../api.js';
import { getPref, loadPrefs } from '../../prefs.js';

// One shared state for the team chat: the panel, the rail badge and the urgent banner all read it, so the
// app makes one start-up call and keeps one set of counts. Live events (ids only) refresh it; the panel owns
// the one live connection (see ChatPanel's ChatLive).
let state = {
  ready: false, open: false, view: 'chat', channelId: null, threadId: null, searchQuery: '',
  boot: null, unread: { important: 0, total: 0, urgent: 0 }, urgent: [], draft: null, error: null, tick: 0,
};
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(state));
export const chatState = () => state;
export function setChat(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  emit();
}
export function useChat() {
  const [s, set] = useState(state);
  useEffect(() => {
    listeners.add(set);
    set(state);
    return () => listeners.delete(set);
  }, []);
  return s;
}

let loading = null;
export function loadBoot() {
  loading ??= api.get('/chat/bootstrap')
    .then((boot) => {
      const everyone = boot.channels.find((c) => c.slug === 'everyone');
      setChat((s) => ({ ready: true, boot, unread: boot.unread, error: null, channelId: s.channelId ?? everyone?.id ?? boot.channels[0]?.id ?? null }));
      return boot;
    })
    .catch((error) => { setChat({ error }); return null; })
    .finally(() => { loading = null; });
  return loading;
}
export const loadUrgent = () => api.get('/chat/urgent').then((urgent) => setChat({ urgent })).catch(() => { /* the banner just waits for the next event */ });

// Unread counts change often; a burst of events makes one request.
let unreadTimer = null;
export function refreshUnread() {
  clearTimeout(unreadTimer);
  unreadTimer = setTimeout(() => {
    api.get('/chat/unread').then((u) => setChat((s) => {
      const by = new Map(u.channels.map((c) => [c.channel_id, c]));
      const boot = s.boot && { ...s.boot, channels: s.boot.channels.map((c) => ({ ...c, unread: by.get(c.id)?.unread ?? 0, mentions: by.get(c.id)?.mentions ?? 0 })) };
      return { unread: { important: u.important, total: u.total, urgent: u.urgent }, boot };
    })).catch(() => { /* try again on the next event */ });
  }, 250);
}

// Open the panel: on a conversation, a person (their DM), about a patient, or a view ('tasks', 'search').
export async function openChat({ channelId, userId, patient, text, view, threadId } = {}) {
  if (!state.boot) await loadBoot();
  let id = channelId ?? null;
  if (userId) {
    const dm = await api.post('/chat/dms', { user_ids: [userId] });
    if (!state.boot?.channels.some((c) => c.id === dm.id)) await loadBoot();
    id = dm.id;
  }
  if (!id && patient) {
    // Smart default: where this person last wrote about a patient, else their role's channel.
    const last = getPref('chat.patient_channel', null);
    const role = state.boot?.me?.role;
    const slug = ['dentist', 'hygienist', 'assistant'].includes(role) ? 'clinical' : ['front_desk', 'billing'].includes(role) ? 'front-desk' : 'everyone';
    id = state.boot?.channels.some((c) => c.id === last) ? last : state.boot?.channels.find((c) => c.slug === slug)?.id;
  }
  setChat((s) => ({
    open: true, view: view || (id || patient || text ? 'chat' : s.view), channelId: id ?? s.channelId, threadId: threadId ?? null,
    draft: patient || text ? { patient: patient || null, text: text || '', at: Date.now() } : s.draft,
  }));
}
export const closeChat = () => setChat({ open: false, threadId: null });
export const toggleChat = () => (state.open ? closeChat() : openChat());

// ---- Files and GIFs come from the API with the session token, shown through blob addresses ----
const blobs = new Map();
export async function blobUrl(path) {
  if (blobs.has(path)) return blobs.get(path);
  const p = fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}`, ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`Couldn’t load (${r.status})`))))
    .then((b) => URL.createObjectURL(b));
  blobs.set(path, p);
  p.catch(() => blobs.delete(path));
  return p;
}
export function useBlobUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (path) blobUrl(path).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(false));
    return () => { alive = false; };
  }, [path]);
  return url;
}

export async function uploadFile(file) {
  const res = await fetch(`/api/chat/attachments?filename=${encodeURIComponent(file.name || 'pasted-image.png')}`, {
    method: 'POST', body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${getToken()}`, ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

// ---- Notifications: browser notices with a soft chime, respecting each person's quiet hours ----
export const prefDefaults = { 'chat.notify': 'mentions', 'chat.sound': true, 'chat.desktop': true, 'chat.quiet': { enabled: false, from: '19:00', until: '07:00' }, 'chat.digest': true };
export const chatPref = (k) => getPref(k, prefDefaults[k]);
export function quietNow(d = new Date()) {
  const q = chatPref('chat.quiet');
  if (!q?.enabled) return false;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return q.from <= q.until ? hm >= q.from && hm < q.until : hm >= q.from || hm < q.until;
}
let audio = null;
export function chime(urgent = false) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const notes = urgent ? [880, 660, 880] : [660, 880];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.13;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(urgent ? 0.12 : 0.06, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  } catch { /* no sound on this computer */ }
}
export const canNotify = () => typeof Notification !== 'undefined';
export async function askNotifyPermission() {
  if (!canNotify() || Notification.permission !== 'default') return canNotify() ? Notification.permission : 'unsupported';
  return Notification.requestPermission();
}
export function notify({ title, body, urgent, onClick, tag }) {
  if (quietNow() && !urgent) return;
  if (chatPref('chat.sound')) chime(urgent);
  if (!chatPref('chat.desktop') || !canNotify() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, silent: true, requireInteraction: !!urgent });
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  } catch { /* some browsers only notify from a service worker */ }
}
export const primePrefs = () => loadPrefs();

// Live chat/task events for the pieces of the panel (the panel holds the one connection and passes them on).
const bus = new Set();
export const onLive = (f) => { bus.add(f); return () => bus.delete(f); };
export const emitLive = (e) => bus.forEach((f) => f(e));
