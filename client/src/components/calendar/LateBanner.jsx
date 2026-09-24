import { useEffect, useRef, useState } from 'react';
import { AlarmClock, MessageSquareText, Phone, UserX, Move, Bell, BellOff, Check } from 'lucide-react';
import { fmtTime } from '../../format.js';
import { waitLabel } from './late.js';
import './late.css';

// "3 patients late" at the top of the schedule (S7), with what to do about each one in one click: text them,
// call them, mark a no-show (the reason picker opens), or move the visit. Visible to everyone on the schedule;
// the actions show for people allowed to take them. The optional soft sound is each person's own choice.
export default function LateBanner({ list, canText, canWrite, onText, onNoShow, onMove, onOpen, sound, onSound }) {
  const [open, setOpen] = useState(false);
  const [texted, setTexted] = useState({});
  const [busy, setBusy] = useState(null);
  const shown = open ? list : list.slice(0, 3);
  const veryLate = list.some((x) => x.late.level === 'very_late');
  const text = async (a) => {
    setBusy(a.id);
    try {
      if (await onText(a)) setTexted((t) => ({ ...t, [a.id]: true }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={`late-banner${veryLate ? ' very' : ''}`} aria-label="Late patients">
      <div className="late-head">
        <AlarmClock size={17} strokeWidth={2.4} aria-hidden="true" />
        <strong role="status" aria-live="polite">{list.length} patient{list.length === 1 ? '' : 's'} late</strong>
        <button type="button" className="icon-btn small late-sound" onClick={() => onSound(!sound)} aria-pressed={!!sound}
          title={sound ? 'Sound on when someone becomes late (just for you) — turn off' : 'Play a soft sound when someone becomes late (just for you)'}>
          {sound ? <Bell size={15} /> : <BellOff size={15} />}
        </button>
      </div>
      <ul className="late-list">
        {shown.map(({ appt: a, late }) => (
          <li key={a.id} className={late.level === 'very_late' ? 'very' : ''}>
            <button type="button" className="link late-who" onClick={() => onOpen(a)} title="Open the visit">
              <strong>{a.first_name} {a.last_name}</strong>
            </button>
            <span className="late-min">{waitLabel(late.minutes)}</span>
            <span className="muted late-when">{fmtTime(a.start_time)}{a.operatory_name ? ` · ${a.operatory_name}` : ''}</span>
            <span className="late-actions">
              {canText && (texted[a.id]
                ? <span className="late-done"><Check size={13} /> Texted</span>
                : <button type="button" className="small" disabled={busy === a.id} onClick={() => text(a)} title="Text “are you on your way?”"><MessageSquareText size={14} /> Text</button>)}
              {a.phone && <a className="btn small" href={`tel:${a.phone}`} title={`Call ${a.phone}`}><Phone size={14} /> Call</a>}
              {canWrite && <button type="button" className="small" onClick={() => onNoShow(a)} title="Mark a no-show (pick the reason)"><UserX size={14} /> No-show</button>}
              {canWrite && <button type="button" className="small" onClick={() => onMove(a)} title="Move the visit (arrow keys and Enter, or tap a new time)"><Move size={14} /> Move</button>}
            </span>
          </li>
        ))}
      </ul>
      {list.length > 3 && <button type="button" className="link late-more" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </section>
  );
}

// A soft two-note chime, made in the browser (no sound file). Quietly does nothing where audio isn't allowed.
export function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    [[784, 0], [659, 0.18]].forEach(([f, at]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.07, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t + at);
      o.stop(t + at + 0.55);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* no audio here: the banner is enough */
  }
}

// Chimes when a visit newly becomes late — not for the ones already late when the schedule opened or when
// someone comes back to today from another day (`view` changes start over).
export function useLateChime(list, on, view) {
  const seen = useRef(null);
  const lastView = useRef(view);
  useEffect(() => {
    const ids = new Set(list.map((x) => x.appt.id));
    if (lastView.current !== view) seen.current = null;
    lastView.current = view;
    if (seen.current && on && [...ids].some((id) => !seen.current.has(id))) chime();
    seen.current = ids;
  }, [list, on, view]);
}
