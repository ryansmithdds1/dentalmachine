import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, PhoneIncoming, UserPlus, Link2, X } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcuts, comboLabel } from '../shortcuts.js';
import { toast } from '../toast.js';
import { money, fmtDateTime } from '../format.js';
import { PatientPicker } from './ui.jsx';
import ReplyBox from './ReplyBox.jsx';
import NextOpenings from './phones/NextOpenings.jsx';
import NoBookReason from './phones/NoBookReason.jsx';
import './comms.css';

const nameOf = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;
// A pop whose "call ended" never arrives (a lost webhook) doesn't stay forever.
const STALE_MS = 60 * 60_000;

// The screen pop: when the office line rings, who it is (matched by caller ID), what they owe and when they're
// next in — before anyone picks up. A known caller becomes the active patient (unless the user is working in
// someone's chart), Alt+O opens their chart, and the pop stays until it's dismissed or the call ends. A caller
// who isn't on file gets the next steps right here: new patient with this number, text back, or attach.
export default function CallPop() {
  const [calls, setCalls] = useState([]);
  const nav = useNavigate();
  const loc = useLocation();
  const { can, practice } = useAuth();
  const { setActive } = useActivePatient();
  const timers = useRef(new Map());
  const locRef = useRef(loc.pathname);
  locRef.current = loc.pathname;

  const patch = (id, change) => setCalls((list) => list.map((c) => (c.call_id === id ? { ...c, ...(typeof change === 'function' ? change(c) : change) } : c)));
  const drop = (id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setCalls((list) => list.filter((c) => c.call_id !== id));
  };
  const later = (id, ms) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => drop(id), ms));
  };
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach(clearTimeout);
  }, []);

  // Who the pop is about: the one picked from a family, else the matched caller.
  const chosenOf = (c) => c.matches?.find((m) => m.id === c.chosen) || c.card || null;
  const choose = (c, p) => {
    patch(c.call_id, { chosen: p.id });
    setActive(p);
  };
  // Whoever works the pop took the call (for their own phone numbers); the first person keeps it.
  const claim = (c) => {
    if (c.claimed || !can('patients:write')) return;
    patch(c.call_id, { claimed: true });
    api.post(`/phones/calls/${c.call_id}/claim`).catch(() => patch(c.call_id, { claimed: false })); // retried on the next action
  };
  const openChart = (c) => {
    const p = chosenOf(c);
    if (!p) return;
    claim(c);
    setActive(p);
    nav(`/patients/${p.id}`);
  };

  const load = async (id) => {
    try {
      const r = await api.get(`/calls/${id}`);
      return { card: r.card, matches: r.matches || [], textable: r.textable, caller_name: r.caller_name };
    } catch {
      return { card: null, matches: [], textable: false, limited: true }; // no access to patients: number only
    }
  };

  useLiveEvents(async (e) => {
    if (e.type !== 'call') return;
    if (e.event === 'ringing') {
      const info = await load(e.call_id);
      setCalls((list) => [...list.filter((c) => c.call_id !== e.call_id), { ...e, ...info }].slice(-3));
      later(e.call_id, STALE_MS);
      // One caller on file: they become the active patient right away, so the patient bar and Alt+letter act
      // on them. Not while someone is working in another patient's chart, and not for a shared family number.
      const onChart = /^\/patients\/\d+/.test(locRef.current) && !locRef.current.startsWith(`/patients/${info.card?.id}`);
      if (info.card && info.matches.length <= 1 && !onChart) setActive(info.card);
    } else if (e.event === 'ended') {
      patch(e.call_id, { state: 'ended' });
      // A call that ended without a booking shows the one-click reasons while it fades (and waits in Calls → Didn't book).
      later(e.call_id, 8000);
    } else if (e.event === 'booked') {
      patch(e.call_id, { booked: true });
    } else if (e.event === 'missed') {
      // A missed call stays up until someone deals with it (text back, attach, dismiss).
      patch(e.call_id, { state: 'missed' });
    }
  });

  const top = calls.at(-1);
  const topPatient = top ? chosenOf(top) : null;
  useShortcuts([
    { combo: 'alt+o', handler: () => top && openChart(top), label: 'Open the caller’s chart', section: 'Incoming call', enabled: !!topPatient },
  ]);

  const attach = async (c, p) => {
    try {
      await api.patch(`/calls/${c.call_id}`, { patient_id: p.id });
      const info = await load(c.call_id);
      patch(c.call_id, { ...info, mode: null, chosen: p.id });
      setActive(p);
      toast(`Call filed under ${nameOf(p)}`);
    } catch (e) {
      toast(e.message || 'Couldn’t attach the call', { tone: 'error' });
    }
  };
  const textBack = async (c, body) => {
    const msg = await api.post(`/calls/${c.call_id}/text`, { body });
    if (msg.status !== 'failed' && msg.status !== 'blocked') patch(c.call_id, { mode: null, texted: msg.thread });
    return msg;
  };

  if (!calls.length) return null;
  const openKey = comboLabel('alt+o').join(' ');
  return (
    <div className="call-pop-stack no-print" role="status" aria-live="polite">
      {calls.map((c) => {
        const who = chosenOf(c);
        const family = (c.matches || []).length > 1;
        return (
          <div key={c.call_id} className={`call-pop card${c.state ? ` is-${c.state}` : ''}`} data-call={c.call_id}>
            <div className="call-pop-head">
              <strong><PhoneIncoming size={16} /> {c.state === 'missed' ? 'Missed call' : c.state === 'ended' ? 'Call ended' : 'Incoming call'}</strong>
              <button type="button" className="link" aria-label="Dismiss" title="Dismiss" onClick={() => drop(c.call_id)}><X size={16} /></button>
            </div>
            {c.card ? (
              <>
                <div className="call-pop-name">
                  <Link to={`/patients/${(who || c.card).id}`} onClick={() => setActive(who || c.card)}>{nameOf(who || c.card)}</Link>
                  {c === top && <kbd className="call-pop-kbd" title="Open the chart">{openKey}</kbd>}
                </div>
                <div className="muted call-pop-sub">{c.from}{c.caller_name ? ` · ${c.caller_name}` : ''}</div>
                {family && (
                  <div className="call-pop-family" role="group" aria-label="Who's calling?">
                    <span className="muted">Shares this number — who&apos;s calling?</span>
                    {c.matches.map((m) => (
                      <button key={m.id} type="button" className={`small${(c.chosen || c.card.id) === m.id ? ' primary' : ''}`} onClick={() => choose(c, m)}>{nameOf(m)}</button>
                    ))}
                  </div>
                )}
                <div className="call-pop-facts">
                  {who && who.id !== c.card.id && <div className="muted">Account of {nameOf(c.card)}:</div>}
                  {c.card.balance > 0 && <div>Balance <strong>{money(c.card.balance)}</strong></div>}
                  <div>Next visit: {c.card.next_visit ? `${fmtDateTime(c.card.next_visit.start_time)}${c.card.next_visit.reason ? ` · ${c.card.next_visit.reason}` : ''}` : <span className="text-warn">none scheduled</span>}</div>
                  {c.card.last_visit && <div className="muted">Last seen {fmtDateTime(c.card.last_visit).split(' ')[0]}</div>}
                </div>
                {c.state === 'ended' && !c.booked && can('patients:write') && <NoBookReason callId={c.call_id} />}
                {c.state !== 'ended' && !c.booked && can('schedule:read') && (
                  <NextOpenings callId={c.call_id} patient={who || c.card} primary={c === top} onBooked={() => patch(c.call_id, { booked: true, claimed: true })} />
                )}
                {c.booked && <div className="call-pop-note">Booked on this call. <Link to="/schedule">See the schedule</Link></div>}
              </>
            ) : (
              <>
                <div className="call-pop-name">{c.caller_name || c.from}</div>
                <div className="muted call-pop-sub">{c.caller_name ? `${c.from} · ` : ''}{c.limited ? '' : 'Not a patient on file'}</div>
                {can('patients:write') && !c.limited && (
                  <>
                    {c.texted && <div className="call-pop-note">Texted. Replies land in <Link to={`/messages?t=${c.texted}`}>Messages</Link>.</div>}
                    <div className="call-pop-actions">
                      <button type="button" className="small" onClick={() => nav(`/patients?new=1&phone=${encodeURIComponent(c.from || '')}`)}><UserPlus size={14} /> New patient with this number</button>
                      {c.textable && <button type="button" className={`small${c.mode === 'text' ? ' primary' : ''}`} onClick={() => patch(c.call_id, (x) => ({ mode: x.mode === 'text' ? null : 'text' }))}><MessageSquare size={14} /> Text back</button>}
                      <button type="button" className={`small${c.mode === 'attach' ? ' primary' : ''}`} onClick={() => patch(c.call_id, (x) => ({ mode: x.mode === 'attach' ? null : 'attach' }))}><Link2 size={14} /> Attach to a patient</button>
                    </div>
                    {c.mode === 'text' && (
                      <ReplyBox autoFocus rows={2} label="Text back" onSend={(body) => textBack(c, body)}
                        value={c.draft ?? `Hi, this is ${practice?.name || 'the office'} — we saw your call. How can we help?`} onChange={(v) => patch(c.call_id, { draft: v })} />
                    )}
                    {c.state !== 'ended' && can('schedule:read') && !c.mode && <NextOpenings callId={c.call_id} patient={null} primary={false} />}
                    {c.mode === 'attach' && (
                      <div className="call-pop-attach">
                        <PatientPicker value={null} onChange={(p) => p && attach(c, p)} />
                        <span className="muted">Files this call under them and saves the number if they don&apos;t have one.</span>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
