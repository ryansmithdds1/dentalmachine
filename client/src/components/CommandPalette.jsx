import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { age } from '../format.js';

const PAGES = [
  ['Today / huddle', '/'], ['Schedule', '/schedule'], ['Patients', '/patients'], ['Messages', '/messages'], ['Follow-up lists', '/followups'], ['Campaigns', '/campaigns'],
  ['Online requests', '/requests'], ['Billing', '/claims'], ['Statements', '/claims?tab=statements'], ['Insurance follow-up', '/claims?tab=followup'],
  ['Import ERA', '/claims?tab=era'], ['Practice KPIs', '/reports'], ['Day sheet', '/reports?tab=ops'], ['To-do & labs', '/office'], ['Settings', '/settings'],
];

// Ctrl/Cmd+K quick search: jump to any patient, claim or page from anywhere.
export default function CommandPalette() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ patients: [], claims: [] });
  const [idx, setIdx] = useState(0);
  const input = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dm:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dm:search', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) return setRes({ patients: [], claims: [] });
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo(() => {
    const ql = q.toLowerCase();
    return [
      ...res.patients.map((p) => ({ key: `p${p.id}`, label: `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`, sub: [p.dob && `${age(p.dob)}y · ${p.dob}`, p.phone].filter(Boolean).join(' · '), alert: p.medical_alerts, to: `/patients/${p.id}`, icon: '🧑' })),
      ...res.claims.map((c) => ({ key: `c${c.id}`, label: `Claim #${c.id}`, sub: `${c.first_name} ${c.last_name} · ${c.status}`, to: `/claims/${c.id}`, icon: '🧾' })),
      ...PAGES.filter(([l]) => !ql || l.toLowerCase().includes(ql)).slice(0, ql ? 5 : 14).map(([l, to]) => ({ key: to, label: l, sub: 'Go to page', to, icon: '→' })),
    ];
  }, [res, q]);

  if (!open) return null;
  const go = (it) => {
    setOpen(false);
    nav(it.to);
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Quick search">
        <input
          ref={input} value={q} placeholder="Search patients by name, phone, DOB, #ID… or jump to a page"
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(items.length - 1, idx + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(0, idx - 1)); }
            else if (e.key === 'Enter' && items[idx]) go(items[idx]);
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <button key={it.key} className={`palette-item${i === idx ? ' active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => go(it)}>
              <span className="palette-icon">{it.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{it.label}</strong> {it.alert && <span className="alert-chip" style={{ fontSize: 10, padding: '1px 6px' }}>⚠</span>}
                <div className="muted" style={{ fontSize: 12 }}>{it.sub}</div>
              </span>
            </button>
          ))}
          {q.length >= 2 && !res.patients.length && !res.claims.length && <div className="empty" style={{ padding: 12 }}>No patients match “{q}”.</div>}
        </div>
        <div className="palette-foot muted">↑↓ to move · Enter to open · Esc to close · <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere</div>
      </div>
    </div>
  );
}
