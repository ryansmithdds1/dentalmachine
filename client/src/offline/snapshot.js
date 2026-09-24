// The read-only copy of today (GET /offline/snapshot) and how the screens read it when the internet is down:
// offlineRead(snapshot, path, queue) answers the same GET paths the screens already call (the schedule, a
// patient, their card, notes, chart and perio, the provider and chair lists), with changes still waiting to
// be sent laid over the top so the screen shows what the person just did. Anything else isn't in the copy.
// Pure functions only: no storage or network here (see index.js), so they're tested in Node.

export const REFRESH_MS = 5 * 60_000;

const between = (d, from, to) => d >= from && d <= to;
const parse = (path) => {
  const [p, q = ''] = path.split('?');
  return { p: p.replace(/\/+$/, ''), q: new URLSearchParams(q) };
};

// Is this copy still usable? Older than max_age_hours (default 14: a full office day), it isn't shown.
export function usable(snap, now = Date.now()) {
  if (!snap?.generated_at) return false;
  return now - Date.parse(snap.generated_at) <= (snap.max_age_hours || 14) * 3600_000;
}

// "9:42" (or "Tue 9:42" when the copy is from another day).
export function asOf(snap, now = new Date()) {
  if (!snap?.generated_at) return '';
  const t = new Date(snap.generated_at);
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return t.toDateString() === now.toDateString() ? time : `${t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

// Queued changes shown on the copy: status and "ready" steps on the visit, new notes at the top of the notes.
// Payments aren't added to the balance (the ledger decides that once the payment is posted).
export function overlay(snap, queue = []) {
  if (!queue.length) return snap;
  const out = structuredClone(snap);
  const appts = out.schedule?.appointments || [];
  for (const item of queue) {
    if (item.state === 'discarded') continue;
    const id = Number(item.path.split('/')[2]);
    if (item.kind === 'status' || item.kind === 'ready') {
      const a = appts.find((x) => x.id === id);
      if (a) Object.assign(a, item.kind === 'status' ? { status: item.body.status } : { ready_for: item.body.ready_for ?? null }, { offline_pending: true });
    }
    if (item.kind === 'note' && out.patients?.[id]?.notes) out.patients[id].notes.unshift(queuedNote(item));
  }
  return out;
}

export const queuedNote = (item) => ({
  id: `offline:${item.key}`, patient_id: Number(item.path.split('/')[2]), body: item.body.body, appointment_id: item.body.appointment_id ?? null,
  provider_id: item.body.provider_id ?? null, signed: 0, created_at: item.queued_at.replace('T', ' ').slice(0, 19), author_name: 'Not sent yet',
  addenda: [], signature: null, offline_pending: true,
});

// The schedule for from..to, when the copy covers those days (and the same office).
function schedule(snap, q) {
  const s = snap.schedule;
  if (!s) return undefined;
  const from = q.get('from') || snap.today;
  const to = q.get('to') || from;
  if (!between(from, snap.today, snap.tomorrow) || !between(to, snap.today, snap.tomorrow) || to < from) return undefined;
  const loc = q.get('location_id');
  if (loc && Number(loc) !== snap.location_id) return undefined; // another office's schedule isn't in the copy
  const pick = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([d]) => between(d, from, to)));
  return {
    ...s, from, to,
    hours: pick(s.hours), production: pick(s.production),
    provider_hours: Object.fromEntries(Object.entries(s.provider_hours || {}).map(([id, days]) => [id, pick(days)])),
    provider_exceptions: (s.provider_exceptions || []).filter((e) => between(e.date, from, to)),
    appointments: s.appointments.filter((a) => between(a.start_time.slice(0, 10), from, to)),
    blockouts: (s.blockouts || []).filter((b) => b.start_time.slice(0, 10) <= to && b.end_time.slice(0, 10) >= from),
    offline_as_of: snap.generated_at,
  };
}

// What the copy says for GET <path>, or undefined when it doesn't have it.
export function offlineRead(snapshot, path, queue = []) {
  if (!snapshot) return undefined;
  const snap = overlay(snapshot, queue);
  const { p, q } = parse(path);
  if (p === '/schedule') return schedule(snap, q);
  if (snap.lookups && Object.hasOwn(snap.lookups, path)) return snap.lookups[path];
  const appts = snap.schedule?.appointments || [];
  if (p === '/appointments') {
    // A patient's visits (the notes screen's "which visit?" list): only the ones in the copy.
    if (q.get('patient_id')) return appts.filter((a) => a.patient_id === Number(q.get('patient_id')));
    const from = q.get('from') || q.get('date') || snap.today;
    const to = q.get('to') || from;
    if (!between(from, snap.today, snap.tomorrow) || !between(to, snap.today, snap.tomorrow)) return undefined;
    return appts.filter((a) => between(a.start_time.slice(0, 10), from, to));
  }
  let m = p.match(/^\/appointments\/(\d+)$/);
  if (m) return appts.find((a) => a.id === Number(m[1]));
  m = p.match(/^\/patients\/(\d+)(?:\/(card|notes|chart|perio))?$/);
  if (!m) return undefined;
  const entry = snap.patients?.[m[1]];
  if (!entry) return undefined;
  const part = m[2] || 'patient';
  if (part === 'chart' && q.get('as_of')) return undefined; // the chart on a past date isn't in the copy
  return entry[part];
}
