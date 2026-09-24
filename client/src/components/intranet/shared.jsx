import { createElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, FlaskConical, Package, Wallet, Globe, ImageOff } from 'lucide-react';
import { ApiError, getLocationId, getToken, openFile } from '../../api.js';
import { render } from './md.js';

// Tell every intranet view (and the command bar's list) that something changed.
export const intranetChanged = () => window.dispatchEvent(new Event('dm:intranet'));
export function useIntranetRefresh(reload) {
  useEffect(() => {
    window.addEventListener('dm:intranet', reload);
    return () => window.removeEventListener('dm:intranet', reload);
  }, [reload]);
}

export const CATEGORIES = [
  ['insurance', 'Insurance portals', ShieldCheck],
  ['labs', 'Labs', FlaskConical],
  ['supplies', 'Supplies', Package],
  ['payroll', 'Payroll', Wallet],
  ['other', 'Other', Globe],
];
export const categoryLabel = (c) => CATEGORIES.find(([k]) => k === c)?.[1] || 'Other';
export const ROLE_LABELS = { admin: 'Administrators', dentist: 'Dentists', hygienist: 'Hygienists', assistant: 'Assistants', front_desk: 'Front desk', billing: 'Billing' };

export const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
// External sites always open in a new tab with no link back to this app and no referrer.
export function openExternal(url) {
  const a = Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener noreferrer' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The site's own /favicon.ico, loaded by the browser (never fetched through our server); the category's
// icon when the site has none or the browser blocks it.
export function LinkIcon({ link, size = 22 }) {
  const [failed, setFailed] = useState(false);
  const Fallback = CATEGORIES.find(([k]) => k === link.category)?.[2] || Globe;
  let src = null;
  try { src = `${new URL(link.url).origin}/favicon.ico`; } catch { /* no icon */ }
  if (!src || failed) return <Fallback size={size} strokeWidth={1.8} aria-hidden />;
  return <img src={src} width={size} height={size} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />;
}

// Raw requests (uploads, files) with the same session and office headers as api.js.
const headers = () => ({ ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) });
export async function uploadAttachment(pageId, file) {
  const res = await fetch(`/api/intranet/pages/${pageId}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': crypto.randomUUID?.() || String(Date.now()), ...headers() }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details);
  return data;
}
const blobs = new Map();
export function useAttachmentUrl(id) {
  const [url, setUrl] = useState(blobs.get(id) || null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!id || blobs.has(id)) return undefined;
    let alive = true;
    fetch(`/api/intranet/attachments/${id}/file`, { headers: headers() })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { const u = URL.createObjectURL(b); blobs.set(id, u); if (alive) setUrl(u); })
      .catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [id]);
  return { url, error };
}
function AttachmentImage({ id, alt }) {
  const { url, error } = useAttachmentUrl(id);
  if (error) return <span className="md-img-missing"><ImageOff size={14} /> {alt || 'Image not available'}</span>;
  if (!url) return <span className="md-img-loading" aria-label="Loading image" />;
  return <img className="md-img" src={url} alt={alt || ''} />;
}
export const openAttachment = (id) => openFile(`/intranet/attachments/${id}/file`);

// Renders page text (see md.js: safe by construction — no HTML string is ever inserted).
export function MarkdownView({ text, className = '' }) {
  const nav = useNavigate();
  const nodes = render(text, createElement, {
    image: (id, alt, key) => <AttachmentImage key={key} id={id} alt={alt} />,
    onNavigate: (path, e) => { e.preventDefault(); nav(path); },
    openAttachment: (id) => openAttachment(id).catch(() => { /* the file view shows its own error */ }),
  });
  return <div className={`md ${className}`}>{nodes}</div>;
}

// "Who can see this": offices and roles. Empty = everyone.
export function ScopePicker({ value, onChange, locations }) {
  const locs = value.location_ids || [];
  const roles = value.roles || [];
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="intra-scope">
      {locations?.length > 1 && (
        <fieldset>
          <legend>Offices <span className="muted">{locs.length ? '' : '· all offices'}</span></legend>
          <div className="intra-chips">
            {locations.map((l) => (
              <button type="button" key={l.id} className={`intra-chip${locs.includes(l.id) ? ' on' : ''}`} aria-pressed={locs.includes(l.id)} onClick={() => onChange({ ...value, location_ids: toggle(locs, l.id) })}>{l.name}</button>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend>Roles <span className="muted">{roles.length ? '' : '· everyone'}</span></legend>
        <div className="intra-chips">
          {Object.entries(ROLE_LABELS).map(([k, l]) => (
            <button type="button" key={k} className={`intra-chip${roles.includes(k) ? ' on' : ''}`} aria-pressed={roles.includes(k)} onClick={() => onChange({ ...value, roles: toggle(roles, k) })}>{l}</button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
export function scopeLabel(item, locations) {
  const parts = [];
  if (item.location_ids?.length) parts.push(item.location_ids.map((id) => locations?.find((l) => l.id === id)?.name || 'Office').join(', '));
  if (item.roles?.length) parts.push(item.roles.map((r) => ROLE_LABELS[r] || r).join(', '));
  return parts.join(' · ');
}

// Tiny line diff (longest common subsequence) for "what changed" between two versions.
export function lineDiff(a, b) {
  const x = String(a ?? '').split('\n');
  const y = String(b ?? '').split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: '-', t })), ...y.map((t) => ({ op: '+', t }))];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', t: x[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', t: x[i++] });
    else out.push({ op: '+', t: y[j++] });
  }
  while (i < n) out.push({ op: '-', t: x[i++] });
  while (j < m) out.push({ op: '+', t: y[j++] });
  return out;
}

// '/' jumps to the intranet's own search box instead of the global command bar while on these screens.
export function useSlashToSearch(ref) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.modal, .palette')) return;
      if (!ref.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ref.current.focus();
      ref.current.select?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
}
