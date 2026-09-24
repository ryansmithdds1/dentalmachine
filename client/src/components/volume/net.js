// Fetching the 3D viewer's data with the session token, and saving snapshots back to the chart.
import { getToken, getLocationId } from '../../api.js';

const headers = (extra = {}) => {
  const token = getToken();
  const loc = getLocationId();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(loc ? { 'X-Location-Id': loc } : {}), ...extra };
};
async function failure(res, fallback) {
  const data = await res.json().catch(() => ({}));
  return new Error(data.error || fallback);
}

export async function getJson(path) {
  const res = await fetch(`/api${path}`, { headers: headers() });
  if (!res.ok) throw await failure(res, 'Could not open this file');
  return res.json();
}

// Streams a binary response, reporting how many bytes have arrived (a CBCT can be a few hundred MB).
export async function fetchBinary(path, onProgress) {
  const res = await fetch(`/api${path}`, { headers: headers() });
  if (!res.ok) throw await failure(res, 'Could not load the scan');
  if (!res.body?.getReader) return { buffer: await res.arrayBuffer(), headers: res.headers };
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { buffer: out.buffer, headers: res.headers };
}

// A PNG of the current view, kept as a new document for the patient. One key per snapshot so a double
// click saves it once.
export async function saveSnapshot(documentId, blob, view) {
  const key = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`/api/documents/${documentId}/snapshot?view=${encodeURIComponent(view)}`, {
    method: 'POST', headers: headers({ 'Content-Type': 'image/png', 'Idempotency-Key': key }), body: blob,
  });
  if (!res.ok) throw await failure(res, 'Could not save the snapshot');
  return res.json();
}

export const canvasToBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture'))), 'image/png'));
