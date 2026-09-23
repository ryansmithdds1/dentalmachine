import { useEffect, useState } from 'react';
import { getToken } from '../../api.js';

// Files are behind auth, so they're fetched with the bearer token and shown through object URLs.
export async function fetchBlob(id, image = false) {
  const res = await fetch(`/api/documents/${id}/${image ? 'image' : 'file'}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load file');
  return URL.createObjectURL(await res.blob());
}

// A small preview from the server. When the server can't make one (a JPEG without an embedded thumbnail),
// this browser makes it from the full image once and hands it back, so nobody downloads the full file again.
async function loadThumb(id) {
  const res = await fetch(`/api/documents/${id}/thumb`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 200) return URL.createObjectURL(await res.blob());
  if (res.status !== 202) throw new Error('No preview');
  const full = await fetchBlob(id, true);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = full; });
    const f = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(img.naturalWidth * f)), height: Math.max(1, Math.round(img.naturalHeight * f)) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (blob) fetch(`/api/documents/${id}/thumb`, { method: 'PUT', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => {});
    return blob ? URL.createObjectURL(blob) : full;
  } finally {
    setTimeout(() => URL.revokeObjectURL(full), 1000);
  }
}

// Previews are small and never change, so they're kept for the session (the most recent few hundred).
const cache = new Map();
export function fetchThumb(id) {
  if (cache.has(id)) {
    const p = cache.get(id);
    cache.delete(id);
    cache.set(id, p);
    return p;
  }
  const p = loadThumb(id);
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  if (cache.size > 400) {
    const [oldest, old] = cache.entries().next().value;
    cache.delete(oldest);
    old.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  return p;
}

export function useThumb(id, enabled = true) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    setSrc(null);
    if (!id || !enabled) return undefined;
    let alive = true;
    fetchThumb(id).then((u) => alive && setSrc(u)).catch(() => {});
    return () => { alive = false; };
  }, [id, enabled]);
  return src;
}
