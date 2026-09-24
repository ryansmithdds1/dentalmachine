import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getToken } from '../../api.js';
import { savePass } from './LinkPass.jsx';

// Staff opened a plan or forms "on this screen" for the patient sitting with them. The link carries a one-time
// hand-off code in its #fragment (never sent to a server with the page). This signed-in device trades it for the
// patient's viewing pass, so the patient isn't asked for their birth date. A copied link on any other device
// falls back to the birth-date step. See server/src/handoff.js.
const inFlight = new Map();
const backKey = (token) => `dm_handoff_back_${token.slice(0, 12)}`;
// Only a path inside this app, never another site.
const safeBack = (v) => (typeof v === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(v) ? v : null);
const readBack = (token) => { try { return safeBack(sessionStorage.getItem(backKey(token))); } catch { return null; } };

function redeem(code) {
  if (!inFlight.has(code)) {
    inFlight.set(code, fetch('/api/signing-passes/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify({ code }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return inFlight.get(code);
}

// kind: 'tp' or 'form' (as LinkPass uses). Returns { checking, pass, back }.
export function useHandoff(kind, token) {
  const [state, setState] = useState(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get('here');
    return { checking: !!code, code, pass: null, back: readBack(token) };
  });
  useEffect(() => {
    if (!state.code) return;
    // The code doesn't stay in the address bar or the history.
    window.history.replaceState(null, '', window.location.pathname);
    redeem(state.code).then((d) => {
      const back = safeBack(d?.back) || readBack(token);
      if (d?.pass) {
        savePass(kind, token, d.pass);
        try { if (back) sessionStorage.setItem(backKey(token), back); } catch { /* storage unavailable */ }
      }
      setState({ checking: false, code: null, pass: d?.pass || null, back });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// The way back to the office screens once the patient hands the device back.
export function BackToOffice({ back }) {
  if (!back || !getToken()) return null;
  return (
    <div className="handoff-back">
      <Link to={back}>← Staff: back to the chart</Link>
    </div>
  );
}
