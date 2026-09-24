import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { age } from '../format.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { screenCommands } from '../shortcuts.js';
import { PATIENT_ACTIONS } from './PatientBar.jsx';

const PAGES = [
  ['Today / huddle', '/'], ['Schedule', '/schedule'], ['Patients', '/patients'], ['Messages', '/messages'], ['Follow-up lists', '/followups'], ['Recall list', '/followups?tab=recall'],
  ['Unscheduled treatment', '/followups?tab=unscheduled'], ['Campaigns', '/campaigns'], ['Online requests', '/requests'], ['Needs attention', '/attention'], ['Calls', '/calls'],
  ['Billing & claims', '/claims'], ['Statements', '/claims?tab=statements'], ['Insurance follow-up', '/claims?tab=followup'], ['Import ERA', '/claims?tab=era'],
  ['Insurance checks (EOB)', '/claims?tab=checks'], ['Eligibility', '/claims?tab=eligibility'], ['Pre-authorizations', '/claims?tab=preauths'], ['Deposits', '/claims?tab=deposits'],
  ['Practice KPIs', '/reports'], ['Day sheet', '/reports?tab=ops'], ['Month-end close', '/reports?tab=close'], ['To-do & labs', '/office'], ['Supplies', '/office?tab=supplies'],
  ['Time clock', '/office?tab=time'], ['Finance', '/finance'], ['Settings', '/settings'], ['Help', '/help'],
];

// Things to do for a patient; typing the verb first ("book jane", "note doe", "perio 555-0100") shows just that.
const ACTIONS = [
  { verb: /^(book|schedule)\s+/i, label: 'Book for', icon: '📅', to: (p) => `/schedule?book=${p.id}` },
  { verb: /^(text|message|msg)\s+/i, label: 'Text', icon: '💬', to: (p) => `/messages?patient=${p.id}` },
  { verb: /^(pay|payment|take payment)\s+/i, label: 'Take payment from', icon: '💳', to: (p) => `/patients/${p.id}?tab=ledger&pay=1` },
  { verb: /^(note|notes)\s+/i, label: 'Write a note for', icon: '📝', to: (p) => `/patients/${p.id}?tab=notes` },
  { verb: /^(chart)\s+/i, label: 'Chart', icon: '🦷', to: (p) => `/patients/${p.id}?tab=chart` },
  { verb: /^(perio)\s+/i, label: 'Perio for', icon: '📏', to: (p) => `/patients/${p.id}?tab=perio` },
  { verb: /^(ledger|balance)\s+/i, label: 'Ledger for', icon: '💵', to: (p) => `/patients/${p.id}?tab=ledger` },
  { verb: /^(xray|x-ray|xrays|images?|photos?)\s+/i, label: 'Images for', icon: '🩻', to: (p) => `/patients/${p.id}?tab=documents` },
  { verb: /^(insurance|ins)\s+/i, label: 'Insurance for', icon: '🛡', to: (p) => `/patients/${p.id}?tab=insurance` },
];
const QUICK = [['New patient', '/patients?new=1', '➕'], ['New appointment', '/schedule?book=new', '📅']];
const nameOf = (p) => `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`;
const subOf = (p) => [p.dob && `${age(p.dob)}y · ${p.dob}`, p.phone].filter(Boolean).join(' · ');

// Ctrl/Cmd+K (or /): find any patient, open any screen, and run common actions, from anywhere.
export default function CommandPalette() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { patientId, recent, setActive, clear } = useActivePatient();
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
    }
  }, [open]);
  const action = ACTIONS.find((a) => a.verb.test(q));
  const term = action ? q.replace(action.verb, '') : q;
  useEffect(() => {
    if (term.trim().length < 2) return setRes({ patients: [], claims: [] });
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(term)}`).then(setRes).catch(() => { /* keep the last results */ }), 120);
    return () => clearTimeout(t);
  }, [term]);
  const active = recent.find((r) => r.id === patientId) || (patientId ? { id: patientId, first_name: 'the active', last_name: 'patient' } : null);

  const items = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const hit = (label) => !ql || label.toLowerCase().includes(ql);
    const patient = (p) => ({ key: `p${p.id}`, label: nameOf(p), sub: subOf(p), alert: p.medical_alerts, to: `/patients/${p.id}`, icon: '🧑', patient: p });
    if (action) return res.patients.map((p) => ({ key: `a${p.id}`, label: `${action.label} ${nameOf(p)}`, sub: subOf(p), to: action.to(p), icon: action.icon, patient: p }));
    const top = res.patients[0];
    const activeActions = active && !res.patients.length
      ? [
        ...PATIENT_ACTIONS.filter((a) => can(a.perm) && hit(`${a.label} ${active.first_name}`)).map((a) => ({ key: `aa${a.key}`, label: `${a.label} — ${nameOf(active)}`, sub: 'Active patient', to: a.to(active.id), icon: '★', kbd: `Alt ${a.key.toUpperCase()}` })),
        ...(hit('clear patient') ? [{ key: 'clear', label: `Clear ${nameOf(active)}`, sub: 'Stop working on this patient', run: clear, icon: '×' }] : []),
      ]
      : [];
    // Screens can register many commands (every report, every link): show a few until the person types.
    const screen = screenCommands().filter((c) => hit(c.label)).slice(0, ql ? 40 : 8).map((c) => ({ key: `s${c.id}`, label: c.label, sub: c.hint || 'This screen', run: c.run, icon: '⚡' }));
    return [
      ...res.patients.map(patient),
      // The best match's common actions, right under it.
      ...(top ? ACTIONS.slice(0, 5).map((a) => ({ key: `a${a.label}${top.id}`, label: `${a.label} ${top.first_name} ${top.last_name}`, sub: 'Action', to: a.to(top), icon: a.icon, patient: top })) : []),
      ...res.claims.map((c) => ({ key: `c${c.id}`, label: `Claim #${c.id}`, sub: `${c.first_name} ${c.last_name} · ${c.status}`, to: `/claims/${c.id}`, icon: '🧾' })),
      ...activeActions,
      ...screen,
      ...(!ql ? recent.filter((r) => r.id !== patientId).slice(0, 5).map((p) => ({ ...patient(p), key: `r${p.id}`, sub: `Recent · ${subOf(p)}` })) : []),
      ...QUICK.filter(([l]) => hit(l)).map(([l, to, icon]) => ({ key: to, label: l, sub: 'Action', to, icon })),
      ...PAGES.filter(([l]) => hit(l)).slice(0, ql ? 6 : 10).map(([l, to]) => ({ key: to, label: l, sub: 'Go to page', to, icon: '→' })),
    ];
  }, [res, q, action, active, recent, patientId, can, clear]);

  if (!open) return null;
  const go = (it) => {
    setOpen(false);
    if (it.patient) setActive(it.patient);
    if (it.run) it.run();
    else nav(it.to);
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Quick search">
        <input
          // Focused as it appears, so the first letter typed right after Ctrl/⌘K isn't lost.
          ref={input} autoFocus value={q} placeholder="Find a patient (name, phone, birth date, chart #), a screen or an action…"
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
              {it.kbd && <kbd className="palette-kbd">{it.kbd}</kbd>}
            </button>
          ))}
          {term.length >= 2 && !res.patients.length && !res.claims.length && <div className="empty" style={{ padding: 12 }}>No patients match “{term}”.</div>}
        </div>
        <div className="palette-foot muted">↑↓ to move · Enter to open · Esc to close · <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere</div>
      </div>
    </div>
  );
}
