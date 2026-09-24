import { useEffect, useRef, useState } from 'react';

// Browser speech-to-text for dictating into a note. Each time the speaker pauses, what they said since the
// last pause is handed to onPhrase as one piece (so the note updates as they go, a sentence or two at a
// time). Works in Chrome, Edge and Safari; elsewhere `supported` is false and typing still works.
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const PAUSE_MS = 1300;

export default function useDictation(onPhrase) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const rec = useRef(null);
  const live = useRef(false);
  const pending = useRef('');
  const timer = useRef(null);
  const handler = useRef(onPhrase);
  handler.current = onPhrase;

  const flush = () => {
    clearTimeout(timer.current);
    const text = pending.current.trim();
    pending.current = '';
    if (text) handler.current(text);
  };

  const start = () => {
    if (!SR || live.current) return;
    setError(null);
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onresult = (e) => {
      let mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) pending.current += ` ${e.results[i][0].transcript}`;
        else mid += e.results[i][0].transcript;
      }
      setInterim(`${pending.current} ${mid}`.trim());
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setInterim(''); flush(); }, PAUSE_MS);
    };
    // The browser stops after a long silence; keep listening until the dentist turns it off.
    r.onend = () => { if (live.current) { try { r.start(); } catch { /* restarting */ } } else setListening(false); };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        live.current = false;
        setListening(false);
        setError('Allow the microphone for this site to dictate.');
      }
    };
    rec.current = r;
    live.current = true;
    r.start();
    setListening(true);
  };
  const stop = () => {
    live.current = false;
    rec.current?.stop();
    setListening(false);
    setInterim('');
    flush();
  };
  useEffect(() => () => { live.current = false; clearTimeout(timer.current); rec.current?.stop(); }, []);

  return { supported: !!SR, listening, interim, error, start, stop, toggle: () => (live.current ? stop() : start()) };
}
