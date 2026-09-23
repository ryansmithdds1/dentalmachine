import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { age } from '../format.js';

const PAGES = [
  ['Today / huddle', '/'], ['Schedule', '/schedule'], ['Patients', '/patients'], ['Messages', '/messages'], ['Follow-up lists', '/followups'], ['Campaigns', '/campaigns'],
  ['Online requests', '/requests'], ['Billing', '/claims'], ['Statements', '/claims?tab=statements'], ['Insurance follow-up', '/claims?tab=followup'],
  ['Import ERA', '/claims?tab=era'], ['Practice KPIs', '/reports'], ['Day sheet', '/reports?tab=ops'], ['To-do & labs', '/office'], ['Settings', '/settings'],
];

// Things to do for a patient; typing the verb first ("book jane", "text 512…", "pay doe") shows just that one.
const ACTIONS = [
  { verb: /^(book|schedule)\s+/i, label: 'Book for', icon: '📅', to: (p) => `/schedule?book=${p.id}` },
  { verb: /^(text|message|msg)\s+/i, label: 'Text', icon: '💬', to: (p) => `/messages?patient=${p.id}` },
  { verb: /^(pay|payment|take payment)\s+/i, label: 'Take payment from', icon: '💳', to: (p) => `/patients/${p.id}?tab=ledger&pay=1` },
];
const QUICK = [['New patient', '/patients?new=1', '➕'], ['New appointment', '/schedule?book=new', '📅']];

// Ctrl/Cmd+K quick search: jump to any patient, claim or page from anywhere, or act on a patient.
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
  const action = ACTIONS.find((a) => a.verb.test(q));
  const term = action ? q.replace(action.verb, '') : q;
  useEffect(() => {
    if (term.trim().length < 2) return setRes({ patients: [], claims: [] });
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(term)}`).then(setRes).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [term]);

  const items = useMemo(() => {
    const ql = q.toLowerCase();
    const name = (p) => `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`;
    if (action) return res.patients.map((p) => ({ key: `a${p.id}`, label: `${action.label} ${name(p)}`, sub: [p.dob && `${age(p.dob)}y · ${p.dob}`, p.phone].filter(Boolean).join(' · '), to: action.to(p), icon: action.icon }));
    const top = res.patients[0];
    return [
      ...res.patients.map((p) => ({ key: `p${p.id}`, label: `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`, sub: [p.dob && `${age(p.dob)}y · ${p.dob}`, p.phone].filter(Boolean).join(' · '), alert: p.medical_alerts, to: `/patients/${p.id}`, icon: '🧑' })),
      // The best match's common actions, right under it.
      ...(top ? ACTIONS.map((a) => ({ key: `a${a.label}${top.id}`, label: `${a.label} ${top.first_name} ${top.last_name}`, sub: 'Action', to: a.to(top), icon: a.icon })) : []),
      ...res.claims.map((c) => ({ key: `c${c.id}`, label: `Claim #${c.id}`, sub: `${c.first_name} ${c.last_name} · ${c.status}`, to: `/claims/${c.id}`, icon: '🧾' })),
      ...QUICK.filter(([l]) => !ql || l.toLowerCase().includes(ql)).map(([l, to, icon]) => ({ key: to, label: l, sub: 'Action', to, icon })),
      ...PAGES.filter(([l]) => !ql || l.toLowerCase().includes(ql)).slice(0, ql ? 5 : 14).map(([l, to]) => ({ key: to, label: l, sub: 'Go to page', to, icon: '→' })),
    ];
  }, [res, q, action]);

  if (!open) return null;
  const go = (it) => {
    setOpen(false);
    nav(it.to);
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Quick search">
        <input
          ref={input} value={q} placeholder="Search patients, or type “book”, “text” or “pay” and a name…"
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
          {term.length >= 2 && !res.patients.length && !res.claims.length && <div className="empty" style={{ padding: 12 }}>No patients match “{term}”.</div>}
        </div>
        <div className="palette-foot muted">↑↓ to move · Enter to open · Esc to close · <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere</div>
      </div>
    </div>
  );
}
