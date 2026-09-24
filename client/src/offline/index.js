// Keeping the office working through an internet outage (docs/offline.md). This file joins the pieces to the
// app: it knows whether we're online, keeps the encrypted copy of today fresh (at sign-in and every 5
// minutes), answers screens from that copy when the internet is down (api.js calls offlineFallback), queues
// the safe changes and sends them — in order, with their original Idempotency-Keys — when it comes back.
import { getToken, getLocationId } from '../api.js';
import { toast } from '../toast.js';
import { idbBackend, getKeys, setKeys, forgetKeys, seal, unseal } from './store.js';
import { offlineRead, usable, REFRESH_MS } from './snapshot.js';
import { classify, createOutbox, syncOutbox, reportBody, placeholder, needsInternet } from './queue.js';

const PROBE_MS = 10_000;
const SNAPSHOT_ID = 'today';
let backend = null;
const store = () => (backend ??= idbBackend());

// ---- State the banner and hook read ----
let state = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  started: false, snapshotAt: null, snapshotError: null, queue: [], others: 0, syncing: false, lastSync: null, needsSignIn: false,
};
const listeners = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
};
export const subscribe = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const getOfflineState = () => state;
export const isOnline = () => state.online;
// Changes not yet sent (for the sign-out warning).
export const pendingCount = () => state.queue.filter((i) => i.state !== 'discarded').length;

let snapshot = null; // the decrypted copy, in memory only
let outbox = null;
let timers = [];
let me = null;

// A request made outside api.js's retry-free path: keeps the queued item's own key and office.
async function raw(method, path, { body, headers = {} } = {}) {
  let res;
  try {
    const token = getToken();
    res = await fetch(`/api${path}`, {
      method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    markOffline();
    throw Object.assign(new Error('No connection'), { network: true });
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const office = () => (getLocationId() ? { 'X-Location-Id': getLocationId() } : {});

async function loadQueue() {
  if (!outbox) return set({ queue: [], others: 0 });
  try {
    const all = await outbox.list();
    set({ queue: all, others: await outbox.others() });
  } catch (err) {
    set({ snapshotError: `Couldn’t read the changes saved on this computer: ${err.message}` });
  }
}

// ---- The copy of today ----

async function saveSnapshot(data) {
  const keys = await getKeys();
  if (!keys) return;
  const copy = { ...data, me };
  await store().put('snapshot', { id: SNAPSHOT_ID, key_id: keys.keyId, sealed: await seal(keys.snapshot, copy, `snapshot:${keys.keyId}`) });
  snapshot = copy;
  set({ snapshotAt: data.generated_at, snapshotError: null });
}

// The copy for this sign-in, or null (none, another sign-in's, or too old to show).
export async function loadSnapshot() {
  if (snapshot && usable(snapshot)) return snapshot;
  const keys = await getKeys();
  if (!keys) return null;
  try {
    const rec = await store().get('snapshot', SNAPSHOT_ID);
    if (!rec || rec.key_id !== keys.keyId) return null;
    const copy = await unseal(keys.snapshot, rec.sealed, `snapshot:${keys.keyId}`);
    if (!usable(copy)) return null;
    snapshot = copy;
    set({ snapshotAt: copy.generated_at });
    return copy;
  } catch {
    return null;
  }
}

export async function refreshSnapshot() {
  if (!state.online || !state.started) return;
  try {
    const r = await raw('GET', '/offline/snapshot', { headers: office() });
    if (r.status === 200) await saveSnapshot(r.data);
    else set({ snapshotError: r.data?.error || `The offline copy couldn’t be updated (${r.status})` });
  } catch (err) {
    if (!err.network) set({ snapshotError: `The offline copy couldn’t be saved: ${err.message}` });
  }
}

// ---- Online / offline ----

let probeTimer = null;
export function markOffline() {
  // Keep checking for the connection (every 10 seconds) until it's back.
  probeTimer ??= setInterval(probe, PROBE_MS);
  if (!state.online) return;
  set({ online: false });
  window.dispatchEvent(new Event('dm:offline'));
}
async function probe() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) markOnline();
  } catch { /* still offline */ }
}
export function markOnline() {
  clearInterval(probeTimer);
  probeTimer = null;
  if (state.online) return;
  set({ online: true });
  window.dispatchEvent(new Event('dm:online'));
  if (state.started) sync().then(refreshSnapshot);
}

// ---- Sign-in and sign-out ----

// After sign-in (and after a reload while signed in): fetch the keys, keep the copy fresh, send anything
// waiting. `session` is { user, practice } from /auth/me, kept (encrypted) so a reload offline can open the app.
export async function startOffline(session) {
  me = session ? { user: session.user, practice: session.practice } : me;
  if (state.started) return;
  set({ started: true, needsSignIn: false });
  try {
    if (state.online) {
      const k = await raw('GET', '/offline/key');
      if (k.status !== 200) throw new Error(k.data?.error || `No offline key (${k.status})`);
      const keys = await setKeys(k.data);
      // A copy from an earlier sign-in can't be opened with this one's key: wipe it.
      const old = await store().get('snapshot', SNAPSHOT_ID).catch(() => null);
      if (old && old.key_id !== keys.keyId) await store().del('snapshot', SNAPSHOT_ID);
    }
    const keys = await getKeys();
    if (!keys) throw new Error('No offline key for this sign-in');
    outbox = createOutbox({ backend: store(), getKey: async () => (await getKeys())?.outbox, owner: keys.owner });
    await loadQueue();
    await loadSnapshot();
  } catch (err) {
    if (!err.network) set({ snapshotError: `Working offline isn’t available on this computer: ${err.message}` });
  }
  window.addEventListener('online', probe);
  window.addEventListener('offline', markOffline);
  timers.push(setInterval(() => refreshSnapshot(), REFRESH_MS));
  if (state.online) {
    await sync();
    await refreshSnapshot();
    // The screens needed offline are loaded now, so the app itself can open them without the internet.
    Promise.all([import('../pages/Schedule.jsx'), import('../pages/PatientDetail.jsx')]).catch(() => set({ snapshotError: 'Some screens couldn’t be kept for offline use' }));
  } else markOffline();
}

// For auth.jsx when /auth/me can't be reached: the signed-in person kept with the copy (this tab only).
export async function offlineSession() {
  const copy = await loadSnapshot();
  return copy?.me?.user ? copy.me : null;
}

// Sign-out (by the person or the idle timer): the copy and this sign-in's keys go. Queued changes stay,
// sealed with the person's own key, and are sent when they next sign in (see store.js).
export async function wipeOffline() {
  timers.forEach(clearInterval);
  timers = [];
  window.removeEventListener('online', probe);
  window.removeEventListener('offline', markOffline);
  snapshot = null;
  me = null;
  outbox = null;
  forgetKeys();
  try { await store().clear('snapshot'); } catch { /* no offline storage in this browser */ }
  set({ started: false, snapshotAt: null, snapshotError: null, queue: [], others: 0, lastSync: null });
}

// ---- api.js: what to do when the server can't be reached ----
// Returns { data } (from the copy, or the answer to a queued change) or { error } (a friendly message).
// `assistant`: the request came from the assistant (X-Acting-For) — it needs the internet, and a queued change
// must never be sent later as if the person had made it themselves.
export async function offlineFallback({ method, path, body, key, assistant = false }) {
  markOffline();
  if (assistant) return { error: 'The assistant needs the internet' };
  const copy = await loadSnapshot();
  if (method === 'GET') {
    const data = offlineRead(copy, path, state.queue);
    return data === undefined ? { error: copy ? needsInternet('GET', path) : 'You’re offline and there’s no copy of today on this computer' } : { data };
  }
  const c = classify(method, path, body);
  if (c.refuse) return { error: c.refuse };
  if (!outbox || !key) return { error: 'Needs the internet — changes can’t be saved on this computer right now' };
  let appt = null;
  if (c.appointment_id) {
    appt = offlineRead(copy, `/appointments/${c.appointment_id}`, state.queue);
    if (!appt) return { error: 'Needs the internet — this visit isn’t in the offline copy' };
  }
  const pt = copy?.patients?.[c.patient_id ?? appt?.patient_id]?.card;
  const who = pt ? `${pt.preferred_name || pt.first_name} ${pt.last_name}` : appt ? `${appt.first_name} ${appt.last_name}` : null;
  try {
    const item = await outbox.add({ ...c, key, method, path, location_id: getLocationId() || null, who });
    await loadQueue();
    toast('Saved on this computer — it will be sent when the connection is back');
    return { data: placeholder(item, appt) };
  } catch (err) {
    return { error: `Couldn’t save this change on this computer: ${err.message}` };
  }
}

// ---- Sending what's waiting ----

let pendingReport = { sent: [], failed: [], discarded: [] };
let syncing = null;
export function sync() {
  if (!state.online || !outbox) return Promise.resolve(null);
  const run = async () => {
    set({ syncing: true });
    try {
      const report = await syncOutbox(outbox, {
        send: (item) => raw(item.method, item.path, {
          body: item.body,
          headers: { 'Idempotency-Key': item.key, 'X-Offline-Queued-At': item.queued_at, ...(item.location_id ? { 'X-Location-Id': String(item.location_id) } : {}) },
        }),
        alreadySent: async (keys) => {
          const found = [];
          for (let i = 0; i < keys.length; i += 100) {
            const r = await raw('GET', `/offline/sent?keys=${keys.slice(i, i + 100).map(encodeURIComponent).join(',')}`);
            if (r.status !== 200) throw Object.assign(new Error(r.data?.error || 'Couldn’t check'), { status: r.status });
            found.push(...r.data.sent);
          }
          return found;
        },
      });
      await tellServer(report);
      await loadQueue();
      set({ lastSync: { at: new Date().toISOString(), sent: report.sent.length, failed: report.failed.length, stopped: report.stopped }, needsSignIn: report.stopped === 'signin' });
      if (report.sent.length) {
        toast(`${report.sent.length} change${report.sent.length === 1 ? '' : 's'} made offline ${report.sent.length === 1 ? 'was' : 'were'} sent`);
        window.dispatchEvent(new Event('dm:refresh')); // screens reload the real data
      }
      if (report.failed.length) toast(`${report.failed.length} change${report.failed.length === 1 ? '' : 's'} made offline couldn’t be sent — open “Offline changes” to fix or discard`, { tone: 'error', ms: 10_000 });
      return report;
    } catch (err) {
      set({ lastSync: { at: new Date().toISOString(), error: err.message } });
      toast(`Offline changes couldn’t be sent: ${err.message}`, { tone: 'error' });
      return null;
    } finally {
      set({ syncing: false });
      syncing = null;
    }
  };
  // One sender at a time, also across this person's other tabs.
  syncing ??= globalThis.navigator?.locks ? navigator.locks.request('dm-offline-sync', run) : run();
  return syncing;
}

// The audit trail and Needs attention hear about every sync; a report that can't be delivered is kept for next time.
async function tellServer(report) {
  const body = reportBody(report);
  for (const k of ['sent', 'failed', 'discarded']) {
    const seen = new Set(pendingReport[k].map((x) => x.key));
    pendingReport[k].push(...body[k].filter((x) => !seen.has(x.key)));
  }
  if (!pendingReport.sent.length && !pendingReport.failed.length && !pendingReport.discarded.length) return;
  try {
    const r = await raw('POST', '/offline/sync-report', { body: pendingReport, headers: { 'Idempotency-Key': `offline-report-${crypto.randomUUID()}` } });
    if (r.status !== 200) throw new Error(r.data?.error || `(${r.status})`);
    for (const t of report.discarded) await outbox.remove(t.key);
    pendingReport = { sent: [], failed: [], discarded: [] };
  } catch { /* kept in pendingReport (and the tombstones in the outbox) for the next sync */ }
}

// ---- The person's choices in the "Offline changes" list ----

export async function discard(key) {
  if (!outbox) return;
  await outbox.update(key, { state: 'discarded', discarded_at: new Date().toISOString() });
  await loadQueue();
  if (state.online) sync();
}
// Try a failed change again, or send one that needed checking ("I checked: it isn't there").
export async function retry(key) {
  if (!outbox) return;
  const item = state.queue.find((i) => i.key === key);
  await outbox.update(key, { state: 'waiting', error: null, force: item?.state === 'check' });
  await loadQueue();
  if (state.online) sync();
}
