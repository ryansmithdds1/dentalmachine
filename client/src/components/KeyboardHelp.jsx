import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './ui.jsx';
import { useShortcutList, comboLabel, registeredHelp } from '../shortcuts.js';

// "?" shows every keyboard shortcut; "g" then a letter jumps to a main area (like Gmail or GitHub).
// "module:…" entries are the patient modules of the menu (nav/Rail.jsx): they open the active patient's tab, or
// ask for a patient first. (Family and Treatment Plan have no letter: F and T were already taken.)
const GO = {
  t: ['/', 'Today (dashboard)'], s: ['/schedule', 'Schedule'], p: ['/patients', 'Patients'], m: ['/messages', 'Messages'], f: ['/followups', 'Follow-up lists'],
  b: ['/claims', 'Billing & claims'], r: ['/reports', 'Reports'], o: ['/office', 'To-do & labs'], x: ['/settings', 'Settings'],
  a: ['module:account', 'Account (the patient’s ledger)'], c: ['module:chart', 'Chart (the patient’s chart)'], i: ['module:images', 'Images (the patient’s x-rays and documents)'],
};
const typing = (el) => !!el?.closest?.('input, textarea, select, [contenteditable]');
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

const SECTIONS = [
  ['Everywhere', [
    [[isMac ? '⌘' : 'Ctrl', 'K'], 'Search patients and jump anywhere', '+'],
    [['/'], 'Search (when not typing in a box)'],
    [['?'], 'This list of shortcuts'],
    [[isMac ? '⌘' : 'Ctrl', 'Z'], 'Undo the last change (while its notice is showing)', '+'],
    [['Esc'], 'Close a dialog or panel'],
    ...Object.entries(GO).map(([k, [, l]]) => [['G', k.toUpperCase()], `Go to ${l}`, 'then']),
  ]],
  ['Schedule', [
    [['←', '→'], 'Previous / next day (or week)'],
    [['T'], 'Today'], [['D'], 'Day view'], [['W'], 'Week view'], [['A'], 'Agenda (list) view'],
    [['N'], 'New appointment'],
    [['Esc'], 'Stop placing or moving an appointment'],
    [['Enter'], 'Open the focused appointment'],
  ]],
  ['Chart & perio', [
    [['↑', '↓'], 'Move through procedure search results'],
    [['Enter'], 'Add the highlighted procedure'],
    [['0–9'], 'Perio: type a depth; the cursor moves on by itself'],
    [['1', '0–5'], 'Perio: two quick digits for 10–15 mm', 'then'],
    [['-'], 'Perio: gingival margin above the CEJ (overgrowth)'],
    [['Space', 'Enter'], 'Perio: move on to the next site'],
    [['B', 'U', 'P'], 'Perio: bleeding, pus or plaque on the site just probed (Shift+B: the whole side)'],
    [['G', 'D'], 'Perio: switch to gingival margins or depths (in a perio box)'],
    [['E', '0–9'], 'Chart: type a finding, e.g. 30 MO caries, 14 D2740, 2-4 sealant plan'],
    [[isMac ? '⌥' : 'Alt', '1–9'], 'Chart: the quick buttons, in order (tooth selected first)', '+'],
    [['14 crb bu', 'np', 'srp no LL'], 'Chart: bundles and aliases — typed, or said to the assistant'],
    [['option one …', 'option two …'], 'Chart: compare treatment options side by side'],
    [['←', '→', '↑', '↓'], 'Chart: move between teeth'],
  ]],
  ['Messages & settings', [
    [['Enter'], 'Send a text reply (Shift+Enter for a new line)'],
    [['Enter'], 'Settings search: open the first match'],
  ]],
];

export default function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  const registered = useShortcutList();
  const navigate = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      // "g" then a letter within a second and a half.
      if (pendingG.current && Date.now() - pendingG.current < 1500 && GO[e.key.toLowerCase()]) {
        e.preventDefault();
        pendingG.current = 0;
        setOpen(false);
        const to = GO[e.key.toLowerCase()][0];
        if (to.startsWith('module:')) window.dispatchEvent(new CustomEvent('dm:module', { detail: to.slice(7) }));
        else navigate(to);
        return;
      }
      pendingG.current = e.key.toLowerCase() === 'g' && !document.querySelector('.modal') ? Date.now() : 0;
    };
    const onShow = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dm:shortcuts', onShow);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dm:shortcuts', onShow);
    };
  }, [navigate]);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => setOpen(false)}>
      <div className="shortcuts">
        {[...SECTIONS, ...Object.entries(registered.reduce((acc, r) => ({ ...acc, [r.section]: [...(acc[r.section] || []), [comboLabel(r.combo), r.label, '+']] }), {})),
          ...registeredHelp().map((h) => [h.section, h.rows])].map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              {rows.map(([keys, what, sep = '/'], i) => (
                <div key={i} className="shortcut-row">
                  <dt>{keys.map((k, j) => <span key={j}>{j > 0 && <span className="muted"> {sep} </span>}<kbd>{k}</kbd></span>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Shortcuts don&apos;t fire while you&apos;re typing in a box. Press ? again to close.</p>
    </Modal>
  );
}
