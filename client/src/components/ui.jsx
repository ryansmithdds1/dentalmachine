import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fullName, age } from '../format.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Keyboard users: focus moves into the dialog, Tab stays inside it, Escape closes, and focus goes back after.
  const [before] = useState(() => document.activeElement);
  useEffect(() => {
    const first = box.current?.querySelector(`.modal-body ${FOCUSABLE}`) || box.current;
    first?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [a, z] = [items[0], items.at(-1)];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [before]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const ErrorBox = ({ error }) => (error ? <div className="error">{error.message || String(error)}{error.requestId && error.status >= 500 ? <span className="muted" style={{ fontSize: 12 }}> · reference {error.requestId}</span> : null}</div> : null);

export const Badge = ({ value }) => <span className={`badge ${value}`}>{String(value).replace(/_/g, ' ')}</span>;

// Wraps an async submit with busy/error state.
export function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (...args) => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { submit, busy, error, setError };
}

export function PatientPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => api.get(`/patients?q=${encodeURIComponent(q)}&limit=8`).then((r) => setResults(r.rows)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="inline">
        <strong>{fullName(value)}</strong>
        <span className="muted">{value.dob ? `DOB ${value.dob}` : ''}</span>
        <button type="button" className="small" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus placeholder="Search patient by name, phone, DOB…" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, padding: 4, marginTop: 4 }}>
          {results.map((p) => (
            <div key={p.id} className="clickable" style={{ padding: '7px 10px', cursor: 'pointer', borderRadius: 6 }}
              onMouseDown={() => { onChange(p); setQ(''); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '')}>
              <strong>{fullName(p)}</strong> <span className="muted">{p.dob ? `· ${age(p.dob)}y · ${p.dob}` : ''} {p.phone ? `· ${p.phone}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Showing 200 of 1,834 · Show 200 more" under a list the server sends a page at a time.
export function MoreRows({ shown, total, onMore, step = 200 }) {
  if (total == null || total <= shown) return null;
  return (
    <div className="more-rows no-print">
      <span className="muted">Showing {shown.toLocaleString()} of {total.toLocaleString()}</span>
      <button className="small" onClick={() => onMore(step)}>Show {Math.min(step, total - shown).toLocaleString()} more</button>
    </div>
  );
}
