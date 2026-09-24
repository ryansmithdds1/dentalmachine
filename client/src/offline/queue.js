// Changes made while the internet is down: a short list of safe ones is kept on this computer (sealed, see
// store.js) and sent in the order they were made once the connection is back, each with the Idempotency-Key
// it was given when the person clicked, so a resend can never post it twice. Everything else is refused with
// a plain "needs the internet" message.
//
// Safe offline: a new clinical note (an unsigned draft), the visit's flow steps (check in, seat, ready, out,
// and stepping back), a cash or check payment, a new task. Not offline: card payments (the processor must say
// yes), claims, eligibility, texts and email, signing notes, charging procedures, cancelling visits.
// No storage or network of its own (both are passed in), so the server's test runner can check it in Node.
import { seal, unseal } from './store.js';

const MAX_CENTS = 1_000_000_000;
// The flow steps a visit can take offline (scheduled/confirmed are where Undo steps back to).
const FLOW = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed'];
const TASK_FIELDS = ['patient_id', 'assigned_to', 'title', 'notes', 'due_date', 'priority', 'status', 'text'];
// Items older than this can't be checked against the server's record of what arrived (it keeps a day).
export const CHECK_WINDOW_MS = 20 * 3600_000;

const only = (body, keys) => Object.fromEntries(keys.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
const refuse = (message) => ({ refuse: message });
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Friendly wording for what can't be done offline.
export function needsInternet(method, path) {
  if (/payment-intents|terminal|card|stripe|payment-methods|payment-requests|refund/i.test(path)) return 'Card payments need the internet';
  if (/claim|era|eob|preauth|edi|attachment/i.test(path)) return 'Insurance claims need the internet';
  if (/eligibility|benefit/i.test(path)) return 'Checking insurance eligibility needs the internet';
  if (/conversations|messages|sms|text|remind|email|campaign|confirm/i.test(path)) return 'Texting and email need the internet';
  if (/\/sign$/.test(path)) return 'Signing a note needs the internet — it’s kept as a draft until then';
  return method === 'GET' ? 'Needs the internet — this isn’t in the offline copy' : 'Needs the internet — this change can’t be saved offline';
}

// Can this change wait in the queue? Returns { kind, label, body } (the body as it will be sent — the same
// object that was fingerprinted with the key) or { refuse }.
export function classify(method, path, body = {}, now = new Date()) {
  const p = path.split('?')[0];
  let m = p.match(/^\/patients\/(\d+)\/notes$/);
  if (method === 'POST' && m) {
    if (typeof body.body !== 'string' || !body.body.trim()) return refuse('Write something in the note first');
    if (body.body.length > 20000) return refuse('A note can be at most 20,000 characters');
    return { kind: 'note', label: 'Clinical note (draft, to sign later)', patient_id: Number(m[1]), body: only(body, ['body', 'appointment_id', 'provider_id', 'ai_assisted']) };
  }
  m = p.match(/^\/appointments\/(\d+)\/status$/);
  if (method === 'PATCH' && m) {
    if (!FLOW.includes(body.status)) return refuse(['cancelled', 'no_show'].includes(body.status) ? 'Cancelling or marking a no-show needs the internet' : 'That change needs the internet');
    if (body.complete_procedures) return refuse('Completing and charging the visit’s procedures needs the internet — choose “Visit only” for now');
    if (body.scope) return refuse('Changing a whole series needs the internet');
    const label = { checked_in: 'Checked in', in_chair: 'Seated', completed: 'Checked out', scheduled: 'Step back', confirmed: 'Step back' }[body.status];
    return { kind: 'status', label, appointment_id: Number(m[1]), body: only(body, ['status', 'undo']) };
  }
  m = p.match(/^\/appointments\/(\d+)\/ready$/);
  if (method === 'PUT' && m) {
    if (![null, undefined, 'doctor', 'checkout'].includes(body.ready_for)) return refuse('That change needs the internet');
    return { kind: 'ready', label: body.ready_for ? `Ready for ${body.ready_for}` : 'Not ready', appointment_id: Number(m[1]), body: { ready_for: body.ready_for ?? null, ...only(body, ['undo']) } };
  }
  m = p.match(/^\/patients\/(\d+)\/payments$/);
  if (method === 'POST' && m) {
    if (!['cash', 'check'].includes(body.method)) return refuse('Card payments need the internet — cash and checks can be taken offline');
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CENTS) return refuse('Enter the amount');
    // Posted on the day it was taken, not the day the connection came back. No receipt is sent from the queue.
    return {
      kind: 'payment', label: `${body.method === 'cash' ? 'Cash' : 'Check'} payment $${(amount / 100).toFixed(2)}`, patient_id: Number(m[1]),
      body: { ...only(body, ['amount', 'method', 'reference', 'description', 'payment_plan_id']), entry_date: body.entry_date || localDate(now) },
    };
  }
  if (method === 'POST' && p === '/tasks') {
    if (!String(body.title || body.text || '').trim()) return refuse('Say what needs doing');
    return { kind: 'task', label: 'New task', patient_id: body.patient_id ?? null, body: only(body, TASK_FIELDS) };
  }
  return refuse(needsInternet(method, p));
}

// ---- The outbox: sealed items in the 'outbox' store, one per Idempotency-Key ----
// item: { key, seq, kind, label, method, path, body, location_id, queued_at, state, attempts, error, patient_id, appointment_id }
// state: waiting → (sent: removed) | failed (the server said no; kept until retried or discarded)
//        | check (may already have gone through — a person decides) | discarded (a tombstone until reported)

export function createOutbox({ backend, getKey, owner }) {
  const label = (id) => `outbox:${owner}:${id}`;
  const write = async (item) => backend.put('outbox', { id: item.key, owner, seq: item.seq, sealed: await seal(await getKey(), item, label(item.key)) });
  const read = async () => {
    const mine = [];
    let others = 0;
    for (const rec of await backend.all('outbox')) {
      if (rec.owner !== owner) { others++; continue; }
      try {
        mine.push(await unseal(await getKey(), rec.sealed, label(rec.id)));
      } catch {
        others++; // sealed with an older key (a password change): unreadable, left for the owner to see as "can't open"
      }
    }
    return { items: mine.sort((a, b) => a.seq - b.seq), others };
  };
  return {
    list: async () => (await read()).items,
    others: async () => (await read()).others,
    // Adding the same key again (a double click, a resend) keeps the first one.
    add: async (req, now = new Date()) => {
      const { items } = await read();
      const existing = items.find((i) => i.key === req.key);
      if (existing) return existing;
      const item = {
        key: req.key, seq: Math.max(0, ...items.map((i) => i.seq)) + 1, kind: req.kind, label: req.label, method: req.method, path: req.path, body: req.body,
        location_id: req.location_id ?? null, queued_at: now.toISOString(), state: 'waiting', attempts: 0, error: null,
        patient_id: req.patient_id ?? null, appointment_id: req.appointment_id ?? null, who: req.who ?? null,
      };
      await write(item);
      return item;
    },
    update: async (key, patch) => {
      const item = (await read()).items.find((i) => i.key === key);
      if (!item) return null;
      const next = { ...item, ...patch };
      await write(next);
      return next;
    },
    remove: (key) => backend.del('outbox', key),
  };
}

// Sends what's waiting, oldest first. `send(item)` resolves to { status, data } or throws when the network is
// down; `alreadySent(keys)` asks the server which keys already arrived (GET /offline/sent). Stops at the first
// sign the connection or session isn't there (the rest wait, in order); a change the server refuses is kept
// as failed — and later changes to the same visit wait behind it rather than jumping ahead.
export async function syncOutbox(outbox, { send, alreadySent, now = Date.now() }) {
  const report = { sent: [], failed: [], discarded: [], stopped: null };
  const items = await outbox.list();
  for (const t of items.filter((i) => i.state === 'discarded')) report.discarded.push(t);
  const waiting = items.filter((i) => i.state === 'waiting');
  if (!waiting.length) return report;

  // Anything that may have reached the server before (its answer lost) is looked up, not resent.
  let arrived;
  try {
    arrived = new Map((await alreadySent(waiting.map((i) => i.key))).map((s) => [s.key, s]));
  } catch (err) {
    return { ...report, stopped: err?.status === 401 ? 'signin' : 'offline' };
  }
  const target = (item) => (item.appointment_id ? `a${item.appointment_id}` : null);
  const blocked = new Set();
  for (const item of items) {
    if (item.state === 'failed' || item.state === 'check') {
      if (target(item)) blocked.add(target(item));
      continue;
    }
    if (item.state !== 'waiting') continue;
    const seen = arrived.get(item.key);
    if (seen?.status === 'done' && seen.response_status < 400) {
      await outbox.remove(item.key);
      report.sent.push({ ...item, status: seen.response_status, already: true });
      continue;
    }
    if (!item.force && (seen?.status === 'running' || (!seen && now - Date.parse(item.queued_at) > CHECK_WINDOW_MS))) {
      const error = seen ? 'It may already have gone through — check before sending it again' : 'Saved over a day ago — check it wasn’t already done before sending';
      await outbox.update(item.key, { state: 'check', error });
      if (target(item)) blocked.add(target(item));
      continue;
    }
    // A later step for a visit whose earlier step didn't go waits behind it (order matters: seat after check-in).
    if (target(item) && blocked.has(target(item))) {
      await outbox.update(item.key, { error: 'Waiting on an earlier change to this visit' });
      continue;
    }
    let res;
    try {
      await outbox.update(item.key, { attempts: item.attempts + 1 });
      res = await send(item);
    } catch {
      return { ...report, stopped: 'offline' }; // the connection dropped again: the rest wait, in order
    }
    if (res.status < 400) {
      await outbox.remove(item.key);
      report.sent.push({ ...item, status: res.status, data: res.data });
    } else if (res.status === 401) {
      return { ...report, stopped: 'signin' };
    } else if (res.status === 422 && /already used for a different request/i.test(res.data?.error || '')) {
      // The first try reached the server with a different body (before it was queued): a person checks.
      await outbox.update(item.key, { state: 'check', error: 'It may already have gone through — check before sending it again' });
      if (target(item)) blocked.add(target(item));
    } else if ((res.status === 409 && /already being processed/i.test(res.data?.error || '')) || res.status === 429 || res.status >= 500) {
      // Busy or broken on the server's side: try again later, in the same order.
      await outbox.update(item.key, { error: res.data?.error || `The server answered ${res.status}` });
      return { ...report, stopped: 'retry' };
    } else {
      const error = res.data?.error || `The server answered ${res.status}`;
      await outbox.update(item.key, { state: 'failed', error });
      report.failed.push({ ...item, status: res.status, error });
      if (target(item)) blocked.add(target(item));
    }
  }
  return report;
}

// The sync report for the server (POST /offline/sync-report): kinds, keys and answers only — no patient details.
export const reportBody = (r) => {
  const row = (i) => ({ kind: i.kind, key: i.key, status: i.status ?? null, queued_at: i.queued_at, ...(i.error ? { error: String(i.error).slice(0, 200) } : {}) });
  return { sent: r.sent.map(row), failed: r.failed.map(row), discarded: r.discarded.map(row) };
};

// What the screen gets back when a change is queued instead of sent, shaped like the real answer.
export function placeholder(item, snapshotAppt) {
  const common = { offline_pending: true, offline_key: item.key };
  if (item.kind === 'note') {
    return { id: `offline:${item.key}`, patient_id: item.patient_id, ...item.body, signed: 0, created_at: item.queued_at.replace('T', ' ').slice(0, 19), author_name: 'Not sent yet', addenda: [], ...common };
  }
  if (item.kind === 'status') return { ...snapshotAppt, status: item.body.status, ...common };
  if (item.kind === 'ready') return { ...snapshotAppt, ready_for: item.body.ready_for, ...common };
  if (item.kind === 'payment') return { entry: { id: `offline:${item.key}`, type: 'payment', amount: -item.body.amount, method: item.body.method, entry_date: item.body.entry_date, ...common }, balance: null, receipt: null, ...common };
  return { id: `offline:${item.key}`, ...item.body, status: item.body.status || 'open', ...common };
}
