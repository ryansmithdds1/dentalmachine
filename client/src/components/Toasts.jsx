import { useEffect, useRef, useState } from 'react';
import { onToast } from '../toast.js';
import { isMac, typingIn } from '../shortcuts.js';
import OnlineBookingAlerts from './OnlineBookingAlerts.jsx';

// Bottom-of-screen notices. The newest with an Undo also answers Ctrl/⌘+Z (when you're not typing in a box).
export default function Toasts() {
  const [list, setList] = useState([]);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => onToast((t) => {
    setList((l) => [...l.slice(-3), t]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.ms);
  }), []);
  const run = (t) => {
    setList((l) => l.filter((x) => x.id !== t.id));
    t.undo();
  };
  useEffect(() => {
    const onKey = (e) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || typingIn(e.target)) return;
      const t = [...listRef.current].reverse().find((x) => x.undo);
      if (!t) return;
      e.preventDefault();
      run(t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Online bookings announce themselves here (Toasts is on every signed-in screen); it stays mounted either way.
  return (
    <>
      <OnlineBookingAlerts />
      {list.length > 0 && (
        <div className="toasts no-print" role="status" aria-live="polite">
          {list.map((t) => (
            <div key={t.id} className={`toast ${t.tone}`}>
              <span>{t.message}</span>
              {t.undo && <button type="button" className="toast-undo" onClick={() => run(t)}>Undo <kbd>{isMac ? '⌘' : 'Ctrl'} Z</kbd></button>}
              <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>×</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
