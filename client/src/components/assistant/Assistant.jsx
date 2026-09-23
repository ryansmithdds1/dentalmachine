import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Mic, MicOff, Send, X, Sparkles, RotateCcw, Check, Settings2, Undo2 } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { WRITERS, screenPath } from './tools.js';
import { localCommand, isYes, isNo, isUndo } from './intents.js';
import { chime } from './chime.js';

// The assistant: hold the talk key (F2, or a foot pedal set to send it), say what you want, let go.
// Moving around the app ("open her x-rays", "schedule tomorrow", "start perio") happens instantly,
// without the AI. Everything else goes to Claude, which looks things up on the server and comes back
// with the change it wants to make: low-risk ones (check-in, seating, perio readings) happen at once
// with Undo; the rest show a card — tap the talk key or say "yes" to do it, Esc or "no" to drop it.
// It stays quiet: a chime and a line on screen, not a voice.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const pref = (k, d) => { try { return localStorage.getItem(`dm_assistant_${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dm_assistant_${k}`, v); } catch { /* per computer */ } };
const HOLD_MS = 350;
// "Check in Emma's 3 PM visit" → "Checked in Emma's 3 PM visit" for the done message.
const PAST = [['Book', 'Booked'], ['Move', 'Moved'], ['Check in', 'Checked in'], ['Seat', 'Seated'], ['Confirm', 'Confirmed'], ['Complete', 'Completed'], ['Cancel', 'Cancelled'],
  ['Mark no-show:', 'Marked no-show:'], ['Post', 'Posted'], ['Add', 'Added'], ['Plan', 'Planned'], ['Chart', 'Charted'], ['Perio', 'Recorded perio']];
const done = (line) => {
  const first = line.split('\n')[0].replace(/:$/, '');
  const hit = PAST.find(([v]) => first.startsWith(`${v} `));
  return hit ? `${hit[1]}${first.slice(hit[0].length)}` : first;
};

export default function Assistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState([]);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [toasts, setToasts] = useState([]);
  const [showPrefs, setShowPrefs] = useState(false);
  const [talkKey, setTalkKey] = useState(() => pref('key', 'F2'));
  const [learning, setLearning] = useState(false);
  const [chairId, setChairId] = useState(() => pref('chair', ''));
  const [speak, setSpeak] = useState(() => pref('speak', '0') === '1');
  const [chairs, setChairs] = useState([]);
  const [undoId, setUndoId] = useState(null);
  const history = useRef([]);
  const carry = useRef([]); // results to send with the next request (keeps the conversation whole without a round trip now)
  const lastUndo = useRef(null);
  const rec = useRef(null);
  const keyState = useRef({});
  const feedEnd = useRef(null);
  const inputRef = useRef(null);
  const pendingRef = useRef(null);
  pendingRef.current = pending;

  useEffect(() => {
    api.get('/assistant').then(setStatus).catch(() => setStatus({ enabled: false, tools: [] }));
  }, []);
  useEffect(() => { feedEnd.current?.scrollIntoView({ block: 'end' }); }, [feed, pending]);
  useEffect(() => { if (showPrefs && !chairs.length) api.get('/operatories').then((o) => setChairs(o.filter((c) => c.active !== 0))).catch(() => {}); }, [showPrefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (item) => setFeed((f) => [...f.slice(-60), { key: `${Date.now()}-${Math.random()}`, ...item }]);
  const toast = useCallback((t) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((list) => [...list.slice(-3), { id, ...t }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.undo ? 8000 : 4500);
  }, []);
  const say = (t) => {
    if (!speak || !t || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(t), { rate: 1.1 }));
  };
  const logOutcome = (id, outcome) => id && api.post(`/assistant/log/${id}`, { outcome }).catch(() => {});

  const patientId = () => Number(/^\/patients\/(\d+)/.exec(location.pathname)?.[1]) || null;
  const context = () => {
    const pid = patientId();
    const base = chairId ? { chair_id: Number(chairId) } : {};
    return pid ? { ...base, patient_id: pid, tab: new URLSearchParams(location.search).get('tab') } : { ...base, screen: location.pathname === '/' ? 'today' : location.pathname.slice(1).split('/')[0] };
  };
  const go = (path, perioVoice) => {
    if (perioVoice) { try { sessionStorage.setItem('dm_perio_voice', '1'); } catch { /* same tab */ } }
    navigate(path);
    if (perioVoice) setTimeout(() => window.dispatchEvent(new Event('dm:perio-voice')), 400);
  };

  // Make the changes (after a yes, or at once for low-risk ones), keep their results for the next request,
  // and remember how to take them back.
  const execute = async (items, logId) => {
    const undos = [];
    const lines = [];
    let failed = false;
    for (const it of items) {
      try {
        const { result, undo } = await WRITERS[it.name](it.input);
        carry.current.push({ type: 'tool_result', tool_use_id: it.id, content: JSON.stringify(result) });
        if (undo) undos.push(undo);
        lines.push(done(it.line));
      } catch (err) {
        failed = true;
        carry.current.push({ type: 'tool_result', tool_use_id: it.id, content: `Failed: ${err.message}`, is_error: true });
        add({ kind: 'error', text: `${it.line.split('\n')[0]}: ${err.message}` });
        toast({ kind: 'error', text: err.message });
      }
    }
    if (lines.length) {
      window.dispatchEvent(new Event('dm:refresh'));
      const label = lines.join(' · ');
      add({ kind: 'done', text: label });
      const id = undos.length ? `${Date.now()}` : null;
      lastUndo.current = id ? { id, label, logId, run: async () => { for (const u of undos.reverse()) await u(); } } : null;
      setUndoId(id);
      toast({ kind: 'done', text: label, undo: id || undefined });
    }
    chime(failed ? 'error' : 'done');
    logOutcome(logId, failed ? 'failed' : 'confirmed');
  };

  const ask = async (said) => {
    const content = carry.current.length ? [...carry.current, { type: 'text', text: said }] : said;
    carry.current = [];
    history.current.push({ role: 'user', content });
    setBusy(true);
    try {
      const out = await api.post('/assistant/turn', { messages: history.current, context: context() });
      history.current.push(...out.append);
      if (out.steps.length) add({ kind: 'steps', steps: out.steps, ms: out.ms });
      const nav = out.ui.at(-1);
      if (nav) go(screenPath(nav), nav.name === 'start_voice_perio');
      if (out.refused) { add({ kind: 'error', text: 'The assistant can’t help with that one.' }); chime('error'); return; }
      if (out.pending.length) {
        carry.current = [...out.results];
        if (out.text) add({ kind: 'assistant', text: out.text, quiet: true });
        if (out.pending.every((p) => p.auto)) { await execute(out.pending, out.log_id); return; }
        setPending({ items: out.pending, logId: out.log_id });
        setOpen(true);
        chime('ask');
        say('Confirm?');
        return;
      }
      if (out.text) {
        add({ kind: 'assistant', text: out.text });
        const question = /\?\s*$/.test(out.text);
        if (question) { setOpen(true); chime('ask'); } else { toast({ kind: 'info', text: out.text }); chime('done'); }
        say(out.text);
      } else if (nav) chime('done');
    } catch (err) {
      add({ kind: 'error', text: err.message });
      toast({ kind: 'error', text: err.message });
      chime('error');
      // Keep the conversation usable: drop the request that didn't get an answer.
      history.current.pop();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (yes, instead = null) => {
    const p = pendingRef.current;
    if (!p) return;
    setPending(null);
    if (yes) await execute(p.items, p.logId);
    else {
      for (const it of p.items) carry.current.push({ type: 'tool_result', tool_use_id: it.id, content: 'Not done: the person did not confirm. Nothing was changed.', is_error: true });
      logOutcome(p.logId, 'cancelled');
      if (!instead) { add({ kind: 'cancelled', text: 'Cancelled — nothing changed.' }); chime('stop'); }
    }
    if (instead) await ask(instead);
  };

  const undo = async () => {
    const u = lastUndo.current;
    if (!u) { toast({ kind: 'info', text: 'Nothing to undo.' }); return; }
    lastUndo.current = null;
    setUndoId(null);
    try {
      await u.run();
      carry.current.push({ type: 'text', text: `(The person undid: ${u.label})` });
      window.dispatchEvent(new Event('dm:refresh'));
      add({ kind: 'cancelled', text: `Undone: ${u.label}` });
      toast({ kind: 'info', text: `Undone: ${u.label}` });
      logOutcome(u.logId, 'undone');
      chime('stop');
    } catch (err) {
      toast({ kind: 'error', text: `Couldn’t undo: ${err.message}` });
      chime('error');
    }
  };

  const submit = async (raw) => {
    const said = String(raw || '').trim();
    if (!said) return;
    setText('');
    if (pendingRef.current) {
      add({ kind: 'user', text: said });
      if (isYes(said)) return decide(true);
      if (isNo(said)) return decide(false);
      return decide(false, said); // something else instead: that's the next request
    }
    if (isUndo(said)) return undo();
    const local = localCommand(said, { patientId: patientId() });
    if (local) {
      add({ kind: 'user', text: said });
      go(local.go, local.perioVoice);
      toast({ kind: 'info', text: local.label });
      chime('done');
      return;
    }
    if (busy || !status?.enabled) return;
    add({ kind: 'user', text: said });
    await ask(said);
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const startListening = useCallback(() => {
    if (!SR) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); return; }
    if (rec.current) return;
    window.speechSynthesis?.cancel();
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    if ('processLocally' in r) r.processLocally = true; // on-device recognition where the browser offers it
    let final = '';
    r.onresult = (e) => {
      let now = '';
      for (const res of e.results) {
        if (res.isFinal) final += res[0].transcript;
        else now += res[0].transcript;
      }
      setInterim(final + now);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed') toast({ kind: 'error', text: 'Microphone access was blocked — allow it in the address bar.' });
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      if (final.trim()) submitRef.current(final);
      else chime('stop');
    };
    rec.current = r;
    setListening(true);
    chime('listen');
    try { r.start(); } catch { rec.current = null; setListening(false); }
  }, [toast]);
  const stopListening = () => rec.current?.stop();

  // Hold the talk key to speak, let go to send. With a change waiting, a quick tap says yes.
  useEffect(() => {
    if (!status?.enabled) return undefined;
    const typing = (e) => e.target.closest?.('input, textarea, select, [contenteditable="true"]') && !/^F\d+$/.test(e.key);
    const down = (e) => {
      if (learning) {
        e.preventDefault();
        if (e.key !== 'Escape') { setTalkKey(e.key); setPref('key', e.key); }
        setLearning(false);
        return;
      }
      if (e.key === 'Escape') {
        if (pendingRef.current) { e.preventDefault(); decide(false); return; }
        if (rec.current) { rec.current.abort(); return; }
        if (open && !document.querySelector('.modal')) setOpen(false);
        return;
      }
      if (e.key !== talkKey || e.repeat || typing(e)) return;
      e.preventDefault();
      const k = keyState.current;
      k.down = Date.now();
      k.held = false;
      if (pendingRef.current) {
        k.timer = setTimeout(() => { k.held = true; startListening(); }, HOLD_MS);
      } else if (rec.current) {
        stopListening();
      } else {
        k.held = true;
        startListening();
      }
    };
    const up = (e) => {
      if (e.key !== talkKey || learning) return;
      const k = keyState.current;
      if (!k.down) return;
      clearTimeout(k.timer);
      const long = Date.now() - k.down > HOLD_MS;
      k.down = 0;
      if (pendingRef.current && !k.held) { decide(true); return; }
      if (long) stopListening(); // push-to-talk: letting go sends; a tap keeps listening until you pause
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [status, talkKey, learning, open, startListening]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    history.current = [];
    carry.current = [];
    lastUndo.current = null;
    setUndoId(null);
    setFeed([]);
    setPending(null);
  };

  if (!status || (!status.enabled && user?.role !== 'admin')) return null;
  const keyLabel = talkKey === ' ' ? 'Space' : talkKey;

  return (
    <>
      <div className="assist-toasts" aria-live="polite">
        {listening && <div className="assist-toast live"><span className="assist-rec" />{interim || 'Listening…'}</div>}
        {busy && !listening && <div className="assist-toast busy"><span className="assist-thinking inline"><span /><span /><span /></span>Working…</div>}
        {toasts.map((t) => (
          <div key={t.id} className={`assist-toast ${t.kind}`}>
            {t.kind === 'done' && <Check size={14} />}
            <span>{t.text}</span>
            {t.undo && t.undo === undoId && <button type="button" onClick={undo}><Undo2 size={13} /> Undo</button>}
          </div>
        ))}
      </div>
      <button type="button" className={`assist-fab${listening ? ' live' : ''}${busy ? ' busy' : ''}`} onClick={() => setOpen(!open)}
        title={status.enabled ? `Assistant — hold ${keyLabel} and speak` : 'Assistant (not set up)'} aria-label="Assistant">
        {listening ? <Mic size={22} /> : <Sparkles size={22} />}
      </button>
      {open && (
        <section className="assist" role="dialog" aria-label="Assistant">
          <header className="assist-head">
            <Sparkles size={16} />
            <strong>Assistant</strong>
            <span className="assist-hint">hold <kbd>{keyLabel}</kbd> to talk</span>
            <span className="assist-spacer" />
            <button type="button" className={`assist-icon${showPrefs ? ' on' : ''}`} onClick={() => setShowPrefs(!showPrefs)} title="Settings for this computer" aria-label="Settings"><Settings2 size={16} /></button>
            <button type="button" className="assist-icon" onClick={reset} title="Start over" aria-label="Start over"><RotateCcw size={16} /></button>
            <button type="button" className="assist-icon" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
          </header>
          {showPrefs && (
            <div className="assist-prefs">
              <label>This computer’s chair
                <select value={chairId} onChange={(e) => { setChairId(e.target.value); setPref('chair', e.target.value); }}>
                  <option value="">Not in an operatory</option>
                  {chairs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label>Talk key (or foot pedal)
                <button type="button" onClick={() => setLearning(true)}>{learning ? 'Press the key or pedal…' : keyLabel}</button>
              </label>
              <label className="assist-check"><input type="checkbox" checked={speak} onChange={(e) => { setSpeak(e.target.checked); setPref('speak', e.target.checked ? '1' : '0'); }} /> Read replies aloud</label>
            </div>
          )}
          <div className="assist-feed">
            {!status.enabled && (
              <div className="assist-empty">The assistant isn’t set up on this server yet. Add an <code>ANTHROPIC_API_KEY</code> to the server’s settings to turn it on (see the README).</div>
            )}
            {status.enabled && !feed.length && !pending && (
              <div className="assist-empty">
                <p>Hold <kbd>{keyLabel}</kbd>, speak, let go. Tap <kbd>{keyLabel}</kbd> to confirm, <kbd>Esc</kbd> to cancel, say “undo” to take it back.</p>
                <ul>
                  <li>“Book Ryan Smith for a crown prep with Dr. Lee next Tuesday afternoon.”</li>
                  <li>“Take a $120 card payment.” · “Check in the 10 o’clock.”</li>
                  <li>“Note: cold sensitivity on 19, no pain on percussion.”</li>
                  <li>“Plan an MOD composite on 30.” · “Existing crown on 3, 19 missing.”</li>
                  <li>“Perio on 3: 3 2 4, bleeding mesial.” · “Start perio.”</li>
                  <li>“Open her x-rays.” · “Schedule tomorrow.”</li>
                </ul>
              </div>
            )}
            {feed.map((f) => (
              f.kind === 'steps' ? <div key={f.key} className="assist-steps">{f.steps.join(' · ')}{f.ms ? ` · ${(f.ms / 1000).toFixed(1)}s` : ''}</div>
                : <div key={f.key} className={`assist-msg ${f.kind}${f.quiet ? ' quiet' : ''}`}>{f.kind === 'done' && <Check size={14} />}<span>{f.text}</span></div>
            ))}
            {pending && (
              <div className="assist-confirm">
                <ul>{pending.items.map((p) => <li key={p.id}>{p.line}</li>)}</ul>
                <div className="assist-confirm-actions">
                  <button type="button" className="primary" onClick={() => decide(true)}><Check size={15} /> Confirm <kbd>{keyLabel}</kbd></button>
                  <button type="button" onClick={() => decide(false)}>Cancel <kbd>Esc</kbd></button>
                </div>
              </div>
            )}
            {busy && <div className="assist-thinking"><span /><span /><span /></div>}
            <div ref={feedEnd} />
          </div>
          {status.enabled && (
            <form className="assist-input" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
              <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={pending ? 'yes, no, or something else…' : 'Type, or hold the talk key…'} aria-label="Ask the assistant" disabled={busy} />
              {SR && (
                <button type="button" className={`assist-mic${listening ? ' live' : ''}`} onClick={() => (listening ? stopListening() : startListening())} title={`Speak (hold ${keyLabel})`} aria-label={listening ? 'Stop listening' : 'Speak'}>
                  {listening ? <MicOff size={17} /> : <Mic size={17} />}
                </button>
              )}
              <button type="submit" className="assist-send" disabled={!text.trim() || busy} aria-label="Send"><Send size={16} /></button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
