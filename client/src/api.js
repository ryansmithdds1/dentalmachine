import { offlineFallback, markOnline } from './offline/index.js';

const TOKEN_KEY = 'dm_token';

export const getToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (t) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
};

// Multi-location practices: the office this screen works in (kept per computer), sent with every request.
const LOCATION_KEY = 'dm_location';
export const getLocationId = () => {
  try {
    return localStorage.getItem(LOCATION_KEY) || '';
  } catch {
    return '';
  }
};
export const setLocationId = (id) => {
  try {
    if (id) localStorage.setItem(LOCATION_KEY, String(id));
    else localStorage.removeItem(LOCATION_KEY);
  } catch {
    /* storage unavailable */
  }
};
const locationHeader = () => (getLocationId() ? { 'X-Location-Id': getLocationId() } : {});

export class ApiError extends Error {
  constructor(status, message, details, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.requestId = requestId || null;
  }
}

// Every change carries an Idempotency-Key, so a double click or a resend never does the work twice:
// the same request again within a few seconds reuses its key and gets the first answer back. Any other change
// in between means the person moved on (seat → undo → seat again), so the repeat is new work with a new key.
let last = null;
function idempotencyKey(method, path, body) {
  if (method === 'GET') return null;
  const sig = `${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`;
  const now = Date.now();
  if (last && last.sig === sig && now - last.at <= 8000) return last.key;
  const key = globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`;
  last = { sig, key, at: now };
  return key;
}

async function request(method, path, body, extraHeaders = {}) {
  const token = getToken();
  const key = idempotencyKey(method, path, body);
  if (key) extraHeaders = { 'Idempotency-Key': key, ...extraHeaders };
  // No connection (or the server can't be reached): today's offline copy answers reads, and the few safe
  // changes wait on this computer with this same key (see offline/). Anything else says it needs the internet.
  const offline = async () => {
    const r = await offlineFallback({ method, path, body, key, assistant: !!extraHeaders['X-Acting-For'] });
    if (r.error) throw new ApiError(0, r.error);
    return r.data;
  };
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader(), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return offline();
  }
  if ([502, 503, 504].includes(res.status)) return offline();
  markOnline();
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('dm:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details, data.request_id);
  // Long lists come a page at a time; the full count rides along on the array.
  const total = res.headers.get('X-Total-Count');
  if (total != null && Array.isArray(data)) Object.defineProperty(data, 'total', { value: Number(total) });
  return data;
}

// Sends raw audio (a piece of dictation) and gets JSON back.
export async function postAudio(path, blob) {
  const token = getToken();
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader() }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details, data.request_id);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p, b) => request('DELETE', p, b),
};

// What the assistant does on someone's behalf is recorded as the AI acting for them, not as them.
// High-risk changes (money, claims, signing…) are refused by the server unless the person approved them:
// only changes run inside approved() — after a yes on screen, or an Undo they asked for — say so.
let approving = 0;
const ai = () => (approving ? { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' } : { 'X-Acting-For': 'assistant' });
export async function approved(fn) {
  approving++;
  try {
    return await fn();
  } finally {
    approving--;
  }
}
export const assistantApi = {
  get: (p) => request('GET', p, undefined, ai()),
  post: (p, b = {}) => request('POST', p, b, ai()),
  put: (p, b) => request('PUT', p, b, ai()),
  patch: (p, b) => request('PATCH', p, b, ai()),
  del: (p) => request('DELETE', p, undefined, ai()),
};

// Downloads a file from the API (with the session token) and saves it.
export async function download(path, fallbackName = 'download') {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || res.statusText, data.details);
  }
  const name = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || fallbackName;
  saveBlob(await res.blob(), name);
  return name;
}

// Opens a file from the API (a PDF to print) in a new tab. The tab opens first so popup blockers allow it.
export async function openFile(path, w = window.open('', '_blank')) {
  try {
    const token = getToken();
    const res = await fetch(`/api${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader() } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error || res.statusText, data.details);
    }
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Spreadsheet export of rows already on screen. `columns` is [[header, row => value], ...]; money values
// are passed in cents and written in dollars.
export function downloadCsv(name, rows, columns) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // Quote when needed, and neutralise spreadsheet formulas (=, +, -, @ at the start).
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, f]) => cell(f(r))).join(','))];
  saveBlob(new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }), name.endsWith('.csv') ? name : `${name}.csv`);
}
export const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));
