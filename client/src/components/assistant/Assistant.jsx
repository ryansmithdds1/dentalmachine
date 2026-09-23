import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Mic, MicOff, Send, X, Sparkles, Volume2, VolumeX, RotateCcw, Check, Ban } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { READERS, WRITERS, describe, stepLabel, screenPath } from './tools.js';

// The assistant: a microphone on every screen. Say (or type) what you want — "book Ryan Smith for a
// crown prep with Dr. Lee next Tuesday afternoon", "take a hundred twenty dollar card payment", "note:
// patient reports cold sensitivity on 19" — and it looks things up, shows exactly what it will change,
// and does it when you say "yes" (or press Confirm). Nothing is changed without that confirmation.
//
// F2 starts and stops listening from anywhere.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const YES = /^(yes|yeah|yep|yup|confirm(ed)?|do it|go ahead|correct|ok(ay)?|sure|sounds good|please do|that's right)\b/i;
const NO = /^(no|nope|cancel|stop|don't|do not|wait|never ?mind)\b/i;
const SPEAK_KEY = 'dm_assistant_speak';
const readPref = () => { try { return localStorage.getItem(SPEAK_KEY) !== '0'; } catch { return true; } };
const MAX_STEPS = 12;

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
  const [speakReplies, setSpeakReplies] = useState(readPref);
  const history = useRef([]);
  const rec = useRef(null);
  const lastWasVoice = useRef(false);
  const kinds = useRef({});
  const feedEnd = useRef(null);

  useEffect(() => {
    api.get('/assistant').then((s) => {
      setStatus(s);
      kinds.current = Object.fromEntries(s.tools.map((t) => [t.name, t.kind]));
    }).catch(() => setStatus({ enabled: false, tools: [] }));
  }, []);
  useEffect(() => { feedEnd.current?.scrollIntoView({ block: 'end' }); }, [feed, pending, interim]);

  const add = (item) => setFeed((f) => [...f, { key: `${Date.now()}-${Math.random()}`, ...item }]);
  const say = useCallback((t) => {
    if (!speakReplies || !lastWasVoice.current || !t || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(t.replace(/[*_#`]/g, '')), { rate: 1.05 }));
  }, [speakReplies]);

  const context = () => {
    const m = /^\/patients\/(\d+)/.exec(location.pathname);
    const tab = new URLSearchParams(location.search).get('tab');
    return m ? { patient_id: Number(m[1]), tab } : { screen: location.pathname === '/' ? 'today' : location.pathname.slice(1).split('/')[0] };
  };

  // Ask Claude for the next turn, run what it looked up, and stop at anything that needs a yes.
  const run = async () => {
    setBusy(true);
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const turn = await api.post('/assistant/turn', { messages: history.current, context: context() });
        // Append-only: the screen note the server added, then Claude's turn exactly as returned.
        if (turn.note) history.current.push(turn.note);
        history.current.push({ role: 'assistant', content: turn.content });
        const said = turn.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        const uses = turn.content.filter((b) => b.type === 'tool_use');
        if (turn.refused) { add({ kind: 'error', text: 'The assistant can’t help with that one.' }); return; }
        if (said && !uses.length) { add({ kind: 'assistant', text: said }); say(said); return; }
        if (said) add({ kind: 'assistant', text: said, quiet: true });
        if (!uses.length) return;

        const results = [];
        const writes = [];
        const steps = [];
        for (const u of uses) {
          const kind = kinds.current[u.name];
          if (kind === 'write') { writes.push(u); continue; }
          try {
            let out;
            if (kind === 'ui') {
              navigate(screenPath(u.input));
              out = { ok: true };
              steps.push('Opened the screen');
            } else if (READERS[u.name]) {
              out = await READERS[u.name](u.input);
              steps.push(stepLabel(u.name, u.input, out));
            } else throw new Error(`Unknown tool ${u.name}`);
            results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: err.message, is_error: true });
            steps.push(`${stepLabel(u.name, u.input, null)} — ${err.message}`);
          }
        }
        if (steps.length) add({ kind: 'steps', steps });
        if (writes.length) {
          const lines = await Promise.all(writes.map((w) => describe(w.name, w.input)));
          setPending({ results, writes, lines });
          say(writes.length > 1 ? `I'm ready to make ${writes.length} changes. Confirm?` : `${lines[0].split('\n')[0]}. Confirm?`);
          return;
        }
        history.current.push({ role: 'user', content: results });
      }
      add({ kind: 'error', text: 'That took too many steps — try saying it a different way.' });
    } catch (err) {
      add({ kind: 'error', text: err.message });
      // Keep the conversation usable: drop the unanswered turn (and its screen note).
      while (history.current.length && ['assistant', 'system'].includes(history.current.at(-1).role)) history.current.pop();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (yes, instead = null) => {
    const p = pending;
    if (!p) return;
    setPending(null);
    setBusy(true);
    const results = [...p.results];
    let changed = false;
    for (const [i, w] of p.writes.entries()) {
      if (!yes) {
        results.push({ type: 'tool_result', tool_use_id: w.id, content: 'Not done: the user did not confirm this change. Nothing was changed.', is_error: true });
        continue;
      }
      try {
        const out = await WRITERS[w.name](w.input);
        changed = true;
        results.push({ type: 'tool_result', tool_use_id: w.id, content: JSON.stringify(out) });
        add({ kind: 'done', text: p.lines[i].split('\n')[0] });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: w.id, content: `Failed: ${err.message}`, is_error: true });
        add({ kind: 'error', text: `${p.lines[i].split('\n')[0]} — ${err.message}` });
      }
    }
    if (!yes) add({ kind: 'cancelled', text: 'Cancelled — nothing was changed.' });
    if (changed) window.dispatchEvent(new Event('dm:refresh'));
    history.current.push({ role: 'user', content: instead ? [...results, { type: 'text', text: instead }] : results });
    setBusy(false);
    await run();
  };

  const submit = async (raw, { voice = false } = {}) => {
    const said = raw.trim();
    if (!said || busy) return;
    lastWasVoice.current = voice;
    setText('');
    if (pending) {
      if (YES.test(said)) return decide(true);
      add({ kind: 'user', text: said });
      if (NO.test(said) && said.split(/\s+/).length <= 3) return decide(false);
      return decide(false, said); // something else instead: treat it as the next instruction
    }
    add({ kind: 'user', text: said });
    history.current.push({ role: 'user', content: said });
    await run();
  };

  const listen = useCallback(() => {
    if (!SR) { setOpen(true); return; } // no speech in this browser: type instead
    if (rec.current) { rec.current.stop(); return; }
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
        if (res.isFinal) final = res[0].transcript;
        else now += res[0].transcript;
      }
      setInterim(final || now);
    };
    r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') add({ kind: 'error', text: e.error === 'not-allowed' ? 'Microphone access was blocked — allow it in the browser’s address bar.' : `Didn’t catch that (${e.error}).` }); };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      if (final) submitRef.current(final, { voice: true });
    };
    rec.current = r;
    setOpen(true);
    setListening(true);
    r.start();
  }, []);
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F2') { e.preventDefault(); if (status?.enabled) listen(); else setOpen((o) => !o); }
      if (e.key === 'Escape' && open && !e.defaultPrevented && !document.querySelector('.modal')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listen, open, status]);

  const reset = () => {
    history.current = [];
    setFeed([]);
    setPending(null);
    window.speechSynthesis?.cancel();
  };
  const toggleSpeak = () => {
    const v = !speakReplies;
    setSpeakReplies(v);
    try { localStorage.setItem(SPEAK_KEY, v ? '1' : '0'); } catch { /* per-computer */ }
    if (!v) window.speechSynthesis?.cancel();
  };

  if (!status || (!status.enabled && user?.role !== 'admin')) return null;

  return (
    <>
      <button type="button" className={`assist-fab${listening ? ' live' : ''}${open ? ' open' : ''}`} onClick={() => (status.enabled && !open ? listen() : setOpen(!open))}
        title={status.enabled ? 'Assistant — press F2 and speak' : 'Assistant (not set up)'} aria-label="Assistant">
        {listening ? <Mic size={22} /> : <Sparkles size={22} />}
      </button>
      {open && (
        <section className="assist" role="dialog" aria-label="Assistant">
          <header className="assist-head">
            <Sparkles size={16} />
            <strong>Assistant</strong>
            <span className="assist-spacer" />
            <button type="button" className="assist-icon" onClick={toggleSpeak} title={speakReplies ? 'Replies are read aloud (when you speak)' : 'Replies are silent'} aria-label="Read replies aloud">{speakReplies ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
            <button type="button" className="assist-icon" onClick={reset} title="Start over" aria-label="Start over"><RotateCcw size={16} /></button>
            <button type="button" className="assist-icon" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
          </header>
          <div className="assist-feed">
            {!status.enabled && (
              <div className="assist-empty">The assistant isn’t set up on this server yet. Add an <code>ANTHROPIC_API_KEY</code> to the server’s settings to turn it on (see the README).</div>
            )}
            {status.enabled && !feed.length && !pending && (
              <div className="assist-empty">
                <p>Press <kbd>F2</kbd> or the mic and say what you need:</p>
                <ul>
                  <li>“Book Ryan Smith for a crown prep with Dr. Lee next Tuesday afternoon.”</li>
                  <li>“Take a $120 card payment for this patient.”</li>
                  <li>“Note: patient reports cold sensitivity on 19, no pain on percussion.”</li>
                  <li>“Plan an MOD composite on 30 and a crown on 3.”</li>
                  <li>“Perio on 3: buccal 3 2 4, bleeding on the mesial.”</li>
                  <li>“Check in the 10 o’clock.” · “Open her x-rays.”</li>
                </ul>
                <p className="muted">Nothing changes until you say “yes” or press Confirm.</p>
              </div>
            )}
            {feed.map((f) => (
              f.kind === 'steps' ? <ul key={f.key} className="assist-steps">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
                : <div key={f.key} className={`assist-msg ${f.kind}${f.quiet ? ' quiet' : ''}`}>{f.kind === 'done' && <Check size={14} />}{f.kind === 'cancelled' && <Ban size={14} />}<span>{f.text}</span></div>
            ))}
            {pending && (
              <div className="assist-confirm">
                <strong>{pending.writes.length > 1 ? `Make these ${pending.writes.length} changes?` : 'Make this change?'}</strong>
                <ul>{pending.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                <div className="assist-confirm-actions">
                  <button type="button" className="primary" onClick={() => decide(true)} autoFocus><Check size={15} /> Confirm</button>
                  <button type="button" onClick={() => decide(false)}>Cancel</button>
                  <span className="muted">or say “yes” / “no”</span>
                </div>
              </div>
            )}
            {busy && <div className="assist-thinking"><span /><span /><span /></div>}
            {interim && <div className="assist-msg user interim">{interim}</div>}
            <div ref={feedEnd} />
          </div>
          {status.enabled && (
            <form className="assist-input" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder={pending ? 'Say yes, no, or something else…' : 'Type or press F2 to speak…'} aria-label="Ask the assistant" disabled={busy} />
              {SR && (
                <button type="button" className={`assist-mic${listening ? ' live' : ''}`} onClick={listen} title="Speak (F2)" aria-label={listening ? 'Stop listening' : 'Speak'}>
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
