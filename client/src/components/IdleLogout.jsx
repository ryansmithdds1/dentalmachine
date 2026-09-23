import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';

// HIPAA automatic logoff: sign out after the practice's idle timeout, with a 60-second warning.
export default function IdleLogout() {
  const { practice, logout } = useAuth();
  const minutes = practice?.idle_timeout_minutes || 15;
  const [warn, setWarn] = useState(false);
  const last = useRef(Date.now());
  const pinged = useRef(Date.now());

  useEffect(() => {
    const bump = () => {
      last.current = Date.now();
      try {
        localStorage.setItem('dm_last_activity', String(last.current));
      } catch {
        /* storage unavailable */
      }
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      let shared = last.current;
      try {
        shared = Math.max(shared, Number(localStorage.getItem('dm_last_activity')) || 0); // activity in other tabs counts
      } catch {
        /* ignore */
      }
      const idle = Date.now() - shared;
      if (idle > minutes * 60_000) logout('idle');
      else {
        setWarn(idle > minutes * 60_000 - 60_000);
        // The server ends sessions it hasn't heard from; reading a chart without clicking through still counts.
        if (idle < 120_000 && Date.now() - pinged.current > 120_000) {
          pinged.current = Date.now();
          api.post('/auth/ping').catch(() => {});
        }
      }
    }, 5000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, [minutes, logout]);

  if (!warn) return null;
  return (
    <div className="idle-warning" role="alertdialog">
      <strong>Still there?</strong> You&apos;ll be signed out in under a minute to protect patient information.
      <button className="small primary" onClick={() => { last.current = Date.now(); setWarn(false); }}>Stay signed in</button>
    </div>
  );
}
