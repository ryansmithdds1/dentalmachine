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
    // A field with autoFocus already has focus: keep it. Otherwise the first thing in the body, not the header ✕.
    if (!box.current?.contains(document.activeElement)) {
      const inBody = FOCUSABLE.split(', ').map((x) => `.modal-body ${x}`).join(', ');
      const first = box.current?.querySelector(inBody) || box.current;
      first?.focus({ preventScroll: true });
    }
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

// Find and pick a patient: typos forgiven (the same search as Ctrl/⌘K), ↑/↓ and Enter to choose.
export function PatientPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [hl, setHl] = useState(0);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(q)}`).then((r) => { setResults(r.patients); setHl(0); }).catch(() => { /* keep typing */ }), 150);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (p) => { onChange(p); setQ(''); setResults([]); };

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
      <input
        autoFocus placeholder="Search patient by name, phone, DOB…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a patient"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl(Math.min(hl + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hl - 1, 0)); }
          if (e.key === 'Enter' && results[hl]) { e.preventDefault(); pick(results[hl]); }
        }}
      />
      {results.length > 0 && (
        <div className="card picker-results" role="listbox" style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, padding: 4, marginTop: 4 }}>
          {results.map((p, i) => (
            <div key={p.id} role="option" aria-selected={i === hl} className={`picker-row${i === hl ? ' hl' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setHl(i)}>
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

// A button that opens a short list of actions (closes on a choice, a click elsewhere, or Esc).
export function Menu({ label, title, items, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="menu" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title={title}>{label}</button>
      {open && (
        <div className={`popover menu-pop ${align}`} role="menu">
          {shown.map((it) => (
            <button key={it.label} className="menu-item" role="menuitem" title={it.title} onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Asks on the spot instead of a browser "Are you sure?" box or a dialog (CLAUDE.md principle 5): the first press
// shows the question with the real button beside it (focused, so Enter does it); Esc or "Keep" puts it back.
// Only for things that can't be undone — everything else saves at once with an undo toast.
export function ConfirmButton({ children, ask, yes = 'Yes', onConfirm, className = 'small danger', disabled, title, keep = 'Keep', ...rest }) {
  const [open, setOpen] = useState(false);
  const yesRef = useRef(null);
  useEffect(() => { if (open) yesRef.current?.focus({ preventScroll: true }); }, [open]);
  if (!open) return <button type="button" className={className} disabled={disabled} title={title} onClick={() => setOpen(true)} {...rest}>{children}</button>;
  return (
    <span className="inline-confirm" role="group" aria-label={ask}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); setOpen(false); } }}>
      <span className="inline-confirm-ask">{ask}</span>
      <button type="button" ref={yesRef} className={className} disabled={disabled} onClick={async () => { setOpen(false); await onConfirm(); }}>{yes}</button>
      <button type="button" className="small" onClick={() => setOpen(false)}>{keep}</button>
    </span>
  );
}

// Asks for one short answer on the spot (a reason, a number) instead of a browser prompt box: the first press
// opens a one-line box right there with the cursor in it; Enter saves, Esc puts the button back.
export function AskButton({ children, label, placeholder, initial = '', required = false, submit = 'Save', onSubmit, className = 'small', disabled, title, danger, hint }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!open) return <button type="button" className={className} disabled={disabled} title={title} onClick={() => { setValue(initial); setError(null); setOpen(true); }}>{children}</button>;
  const go = async (e) => {
    e.preventDefault();
    if (required && !value.trim()) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(value.trim()); setOpen(false); } catch (x) { setError(x); } finally { setBusy(false); }
  };
  return (
    <form className="inline-ask" onSubmit={go}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); setOpen(false); } }}>
      <label>{label}
        <input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} aria-label={label} />
      </label>
      <button className={danger ? 'small danger' : 'small primary'} disabled={busy || (required && !value.trim())}>{submit}</button>
      <button type="button" className="small" onClick={() => setOpen(false)}>Cancel</button>
      {hint && <span className="muted inline-ask-hint">{hint}</span>}
      {error && <span className="error inline-ask-error">{error.message || String(error)}</span>}
    </form>
  );
}

// A side panel instead of a dialog (CLAUDE.md principle 4): it slides in on the right, the page stays usable
// behind it (no backdrop, nothing stacked), the cursor goes to its first box, Esc closes it and focus goes back.
export function SidePanel({ title, onClose, children, className = '', wide }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [before] = useState(() => document.activeElement);
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) {
      const inBody = FOCUSABLE.split(', ').map((x) => `.drawer-body ${x}`).join(', ');
      (box.current?.querySelector(inBody) || box.current)?.focus({ preventScroll: true });
    }
    // Esc closes the panel (not whatever is behind it): listened for first, and stopped there.
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [before]);
  return (
    <aside ref={box} tabIndex={-1} className={`drawer side-panel${wide ? ' wide' : ''} ${className}`} role="dialog" aria-label={title}>
      <div className="drawer-head">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
