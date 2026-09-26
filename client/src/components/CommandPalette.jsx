import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { age } from '../format.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { screenCommands, useCommandsVersion } from '../shortcuts.js';
import { PATIENT_ACTIONS } from './PatientBar.jsx';
import { requestReview } from '../reviewRequest.js';

const PAGES = [
  ['Dashboard (today’s huddle)', '/'], ['Schedule', '/schedule'], ['Patients', '/patients'], ['Messages', '/messages'], ['Follow-up lists', '/followups'], ['Recall list', '/followups?tab=recall'],
  ['Unscheduled treatment', '/followups?tab=unscheduled'], ['Campaigns', '/campaigns'], ['Online requests', '/requests'], ['Needs attention', '/attention'], ['Calls', '/calls'],
  ['Billing & claims', '/claims'], ['Claims ready to approve', '/claims?tab=approve'], ['Statements', '/claims?tab=statements'], ['Insurance follow-up', '/claims?tab=followup'], ['Import ERA', '/claims?tab=era'],
  ['Insurance checks (EOB)', '/claims?tab=checks'], ['Eligibility', '/claims?tab=eligibility'], ['Pre-authorizations', '/claims?tab=preauths'], ['Deposits (Billing tab)', '/claims?tab=deposits'],
  ['Practice KPIs', '/reports'], ['X-ray AI review', '/xray-review'], ['Day sheet', '/reports?tab=ops'], ['Month-end close', '/reports?tab=close&type=month'], ['Credits & refunds', '/claims?tab=refunds'], ['To-do & labs', '/office'], ['Sent in online (intake review)', '/intake'], ['Supplies', '/office?tab=supplies'],
  ['Time clock', '/timeclock'], ['My bonus', '/bonus'], ['Billing autopilot', '/billing-autopilot'], ['Team bonus settings', '/settings?tab=bonus'], ['Recall autopilot', '/recall'], ['Chart audit', '/chart-audit'], ['Insurance autopilot (Billing tab)', '/claims?tab=autopilot'], ['Scan a paper EOB', '/claims?tab=autopilot&sub=paper'], ['Insurance reconciliation', '/claims?tab=autopilot&sub=recon'], ['Referrals', '/referrals'], ['Metrics', '/metrics'], ['Production & income', '/reports?tab=production'], ['Clock in or out', '/timeclock'], ['Staff schedules', '/timeclock?tab=schedule'], ['Who’s in today', '/timeclock?tab=today'], ['Approve payroll hours', '/timeclock?tab=period'], ['Payroll export', '/timeclock?tab=export'], ['Time off requests', '/timeclock?tab=pto'], ['Deposits and cash', '/deposits'], ['Cash drawer', '/deposits?tab=drawers'], ['Finance', '/finance'], ['Settings', '/settings'], ['Help', '/help'], ['Show me (guided walkthroughs)', '/help?tab=showme'], ['My training', '/training'], ['Team training (who completed what)', '/training?tab=team'],
  ['Reviews & patient feedback', '/reviews'], ['Team shout-outs', '/reviews?tab=shoutouts'],
  // Every page in the menu can be reached from here too (the menu puts them under its modules: nav/navConfig.js).
  ['Online reviews (Google)', '/reputation'], ['Phones', '/phones'], ['Treatment follow-up', '/recall?type=treatment'], ['Insurance verification (Billing tab)', '/claims?tab=verification'],
  ['Lab check-in', '/lab-checkin'], ['Checklists', '/checklists'], ['Documents', '/documents'], ['Intranet', '/intranet'], ['Capacity', '/capacity'],
  ['Business', '/business'], ['Marketing results', '/marketing'], ['Ask your data', '/ask'], ['Group', '/group'],
  // Report tabs people look for by name (they were Reports → a tab → a button).
  // Batch 2B: compliance log, letters and labels, gift certificates and products.
  ['Record a complaint or incident', '/compliance?new=1'], ['Complaint & incident log', '/compliance'], ['Log an exposure or sharps injury (OSHA)', '/compliance?tab=exposures&new=1'],
  ['Record a HIPAA disclosure', '/compliance?tab=disclosures&new=1'], ['Accounting of disclosures (HIPAA)', '/compliance?tab=disclosures'], ['Write a letter', '/letters'],
  ['Letter templates', '/settings?tab=letters'], ['Print mailing labels (recall list)', '/followups?tab=recall'], ['Sell a gift certificate', '/gift-certificates?new=1'],
  ['Gift certificates (balances, outstanding)', '/gift-certificates'], ['Products for sale & sales tax', '/settings?tab=retail'],
  // Batch 3: the per-person licence tracker.
  ['Staff licences & CPR (who is due)', '/documents?tab=staff'],
  ['A/R aging (who owes what)', '/reports?tab=ops&view=aging'], ['Treatment plan acceptance', '/reports?tab=plans'], ['Hygiene report', '/reports?tab=hygiene'], ['Referrals report (where new patients come from)', '/reports?tab=referrals'],
];

// Things to do for a patient; typing the verb first ("book jane", "note doe", "perio 555-0100") shows just that.
const ACTIONS = [
  { verb: /^(book|schedule)\s+/i, label: 'Book for', icon: '📅', to: (p) => `/schedule?book=${p.id}` },
  { verb: /^(text|message|msg)\s+(?!@)/i, label: 'Text', icon: '💬', to: (p) => `/messages?patient=${p.id}` },
  { verb: /^(pay|payment|take payment)\s+/i, label: 'Take payment from', icon: '💳', to: (p) => `/patients/${p.id}?tab=ledger&pay=1` },
  { verb: /^(note|notes)\s+/i, label: 'Write a note for', icon: '📝', to: (p) => `/patients/${p.id}?tab=notes` },
  { verb: /^(chart)\s+/i, label: 'Chart', icon: '🦷', to: (p) => `/patients/${p.id}?tab=chart` },
  { verb: /^(perio)\s+/i, label: 'Perio for', icon: '📏', to: (p) => `/patients/${p.id}?tab=perio` },
  { verb: /^(ledger|balance)\s+/i, label: 'Ledger for', icon: '💵', to: (p) => `/patients/${p.id}?tab=ledger` },
  { verb: /^(xray|x-ray|xrays|images?|photos?)\s+/i, label: 'Images for', icon: '🩻', to: (p) => `/patients/${p.id}?tab=documents` },
  { verb: /^(insurance|ins)\s+/i, label: 'Insurance for', icon: '🛡', to: (p) => `/patients/${p.id}?tab=insurance` },
  // Does it in place: texts the "how did we do?" link (docs/reviews.md).
  { verb: /^(review|reviews|ask for a review)\s+/i, label: 'Ask for a review from', icon: '⭐', run: (p) => requestReview(p.id, { source: 'command', name: `${p.first_name} ${p.last_name}` }) },
];
const doOrGo = (a, p) => (a.run ? { run: () => a.run(p) } : { to: a.to(p) });
const QUICK = [['New patient', '/patients?new=1', '➕'], ['New appointment', '/schedule?book=new', '📅']];
// For comparing what was typed with a row's name: case, curly quotes and extra spaces don't matter.
const norm = (s) => String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
// "#33", "claim 33", "claim #33": the person means a claim (a bare "33" may be a chart number).
const CLAIM_Q = /^(claim\s*#?|#)\s*\d+$/i;
const nameOf = (p) => `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}`;
const subOf = (p) => [p.dob && `${age(p.dob)}y · ${p.dob}`, p.phone].filter(Boolean).join(' · ');

// Ctrl/Cmd+K (or /): find any patient, open any screen, and run common actions, from anywhere.
export default function CommandPalette() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { patientId, recent, setActive, clear } = useActivePatient();
  const [open, setOpen] = useState(false);
  // A patient module (nav/Rail.jsx) with no active patient asks for one here: { label, tab } — picking a
  // patient then opens that tab of their chart.
  const [pick, setPick] = useState(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ patients: [], claims: [] });
  const [idx, setIdx] = useState(0);
  const input = useRef(null);
  // Where the pointer last was: rows only take the highlight when it really moves, not when the list
  // grows under a resting pointer (that stole Enter from the first result).
  const pointer = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPick(null);
        setOpen((o) => !o);
      } else if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        setPick(null);
        setOpen(true);
      }
    };
    const onOpen = (e) => { setPick(e.detail?.pick || null); setOpen(true); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('dm:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dm:search', onOpen);
    };
  }, []);
  // Empty every time it opens — cleared as it closes too, so the first frame of the next opening never shows (or
  // types onto) the words from last time (batch 3: a quick reopen kept "export day sheet" in the box).
  useEffect(() => {
    pointer.current = null;
    shown.current = { q: null, keys: [] };
    setQ('');
    setIdx(0);
  }, [open]);
  const action = ACTIONS.find((a) => a.verb.test(q));
  const term = action ? q.replace(action.verb, '') : q;
  useEffect(() => {
    if (term.trim().length < 2) return setRes({ patients: [], claims: [] });
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(term)}`).then(setRes).catch(() => { /* keep the last results */ }), 120);
    return () => clearTimeout(t);
  }, [term]);
  const active = recent.find((r) => r.id === patientId) || (patientId ? { id: patientId, first_name: 'the active', last_name: 'patient' } : null);

  // Screens add commands while the bar is open (documents found by their words): re-read them when they do.
  const cmdTick = useCommandsVersion();
  // What has been shown for the current words, in order: rows never move once shown (a person who pauses
  // before Enter opens what they saw first); anything that arrives later is added below.
  const shown = useRef({ q: null, keys: [] });
  const ranked = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const hit = (label) => !ql || label.toLowerCase().includes(ql);
    const patient = (p) => ({ key: `p${p.id}`, label: nameOf(p), sub: subOf(p), alert: p.medical_alerts, to: `/patients/${p.id}`, icon: '🧑', patient: p });
    // Choosing a patient for a module: only patients (recent ones until the person types), straight to the tab.
    if (pick) {
      const to = (p) => `/patients/${p.id}${pick.tab ? `?tab=${pick.tab}` : ''}`;
      const list = ql.length >= 2 ? res.patients : recent;
      return list.map((p) => ({ ...patient(p), to: to(p), sub: ql.length >= 2 ? subOf(p) : `Recent · ${subOf(p)}` }));
    }
    const pages = (n) => PAGES.filter(([l]) => hit(l)).slice(0, n).map(([l, to]) => ({ key: `page:${l}`, label: l, sub: 'Go to page', to, icon: '→' }));
    // "insurance verification", "chart audit", "x-ray AI review" start with an action word, so screens
    // whose names match are offered after the patients.
    if (action) return [...res.patients.map((p) => ({ key: `a${p.id}`, label: `${action.label} ${nameOf(p)}`, sub: subOf(p), ...doOrGo(action, p), icon: action.icon, patient: p })), ...pages(6)];
    const top = res.patients[0];
    const activeActions = active && !res.patients.length
      ? [
        ...PATIENT_ACTIONS.filter((a) => can(a.perm) && hit(`${a.title || a.label} ${active.first_name}`)).map((a) => ({ key: `aa${a.key}`, label: `${a.title || a.label} — ${nameOf(active)}`, sub: 'Active patient', ...(a.run ? { run: () => a.run(active.id) } : { to: a.to(active.id) }), icon: '★', kbd: `Alt ${a.key.toUpperCase()}` })),
        ...(hit('clear patient') ? [{ key: 'clear', label: `Clear ${nameOf(active)}`, sub: 'Stop working on this patient', run: clear, icon: '×' }] : []),
      ]
      : [];
    // Screens can register many commands (every report, every link): show a few until the person types.
    // Rows that arrive late (documents found by the words inside them) are marked `last` and always go at the
    // bottom, so they never push down what the person is about to open.
    const cmds = screenCommands().filter((c) => hit(c.label)).map((c) => ({ key: `s${c.id}`, label: c.label, sub: c.hint || 'This screen', run: c.run, icon: c.icon || '⚡', last: !!c.last }));
    const screen = cmds.filter((c) => !c.last).slice(0, ql ? 40 : 8);
    const late = ql ? cmds.filter((c) => c.last).slice(0, 8) : [];
    const claims = res.claims.map((c) => ({ key: `c${c.id}`, label: `Claim #${c.id}`, sub: `${c.first_name} ${c.last_name} · ${c.status}`, to: `/claims/${c.id}`, icon: '🧾' }));
    const digits = /^\d+$/.test(ql) ? ql : null;
    // Best matches first: a claim asked for by number ("#33", "claim 33"), a patient whose chart number is
    // exactly what was typed, and any screen or action whose name is exactly what was typed ("day sheet").
    const chartNo = digits ? res.patients.filter((p) => String(p.id) === digits) : [];
    const claimFirst = CLAIM_Q.test(ql) || (digits && !chartNo.length);
    const rest = [
      ...screen,
      ...(!ql ? recent.filter((r) => r.id !== patientId).slice(0, 5).map((p) => ({ ...patient(p), key: `r${p.id}`, sub: `Recent · ${subOf(p)}` })) : []),
      ...QUICK.filter(([l]) => hit(l)).map(([l, to, icon]) => ({ key: to, label: l, sub: 'Action', to, icon })),
      // Keyed by label: two entries can open the same screen ("Time clock", "Clock in or out").
      ...pages(ql ? 6 : 10),
    ];
    const exact = ql ? [...activeActions, ...rest].filter((it) => norm(it.label) === norm(ql)) : [];
    const list = [
      ...exact,
      ...(claimFirst ? claims : []),
      ...chartNo.map(patient),
      ...res.patients.filter((p) => !chartNo.includes(p)).map(patient),
      // The best match's common actions, right under it.
      ...(top ? ACTIONS.slice(0, 5).map((a) => ({ key: `a${a.label}${top.id}`, label: `${a.label} ${top.first_name} ${top.last_name}`, sub: 'Action', ...doOrGo(a, top), icon: a.icon, patient: top })) : []),
      ...(claimFirst ? [] : claims),
      ...activeActions,
      ...rest,
      ...late,
    ];
    const seen = new Set();
    return list.filter((it) => !seen.has(it.key) && seen.add(it.key));
  }, [res, q, action, active, recent, patientId, can, clear, pick, cmdTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => {
    const prev = shown.current;
    if (prev.q !== q) { shown.current = { q, keys: ranked.map((it) => it.key) }; return ranked; }
    const byKey = new Map(ranked.map((it) => [it.key, it]));
    const kept = prev.keys.filter((k) => byKey.has(k));
    const keptSet = new Set(kept);
    const out = [...kept.map((k) => byKey.get(k)), ...ranked.filter((it) => !keptSet.has(it.key))];
    shown.current = { q, keys: out.map((it) => it.key) };
    return out;
  }, [ranked, q]);

  if (!open) return null;
  const go = (it) => {
    setOpen(false);
    if (it.patient) setActive(it.patient);
    if (it.run) it.run();
    else nav(it.to);
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={`palette${pick ? ' palette-pick' : ''}`} role="dialog" aria-label={pick ? `Choose a patient for ${pick.label}` : 'Quick search'}>
        {pick && <div className="palette-pick-head">Choose a patient for <strong>{pick.label}</strong></div>}
        <input
          // Focused as it appears, so the first letter typed right after Ctrl/⌘K isn't lost.
          ref={input} autoFocus value={q} placeholder={pick ? 'Patient name, phone, birth date or chart #…' : 'Find a patient (name, phone, birth date, chart #), a screen or an action…'}
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
            <button key={it.key} className={`palette-item${i === idx ? ' active' : ''}`} onMouseMove={(e) => { const at = `${e.clientX},${e.clientY}`; if (pointer.current && pointer.current !== at) setIdx(i); pointer.current = at; }} onClick={() => go(it)}>
              <span className="palette-icon">{it.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{it.label}</strong> {it.patient?.is_training ? <span className="training-badge">Training</span> : null} {it.alert && <span className="alert-chip" style={{ fontSize: 10, padding: '1px 6px' }}>⚠</span>}
                <div className="muted" style={{ fontSize: 12 }}>{it.sub}</div>
              </span>
              {it.kbd && <kbd className="palette-kbd">{it.kbd}</kbd>}
            </button>
          ))}
          {term.length >= 2 && !res.patients.length && !res.claims.length && <div className="empty" style={{ padding: 12 }}>No patients match “{term}”.</div>}
          {pick && term.length < 2 && !items.length && <div className="empty" style={{ padding: 12 }}>Type a name, phone number, birth date or chart number.</div>}
        </div>
        <div className="palette-foot muted">↑↓ to move · Enter to open · Esc to close · <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere</div>
      </div>
    </div>
  );
}
