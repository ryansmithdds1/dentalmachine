import { useEffect, useRef, useState } from 'react';
import { postAudio } from '../api.js';

// Speech-to-text for dictating into a note. Each time the speaker pauses, what they said since the last pause
// is handed to onPhrase as one piece, so the note updates a sentence or two at a time.
//
// Two ways to hear:
// - 'server': the microphone is recorded here and each piece is sent to the office's speech service
//   (Deepgram's medical model, primed with dental words, under the practice's BAA). Needs MediaRecorder.
// - 'browser': the browser's own recognition (Chrome, Edge, Safari). Quick, but generic about drug names, and
//   the browser may send audio to its maker.
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const CAN_RECORD = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;
const PAUSE_MS = 1300;
const MAX_PIECE_MS = 25_000;
const LOUD = 0.025; // RMS level that counts as speech
const FALLBACK_PIECE_MS = 6000; // when pauses can't be detected
// Recognizer errors that restarting won't fix: stop and say why, instead of restarting for ever while the
// button still says "Listening". (Found by e2e/chaos/speech.test.mjs.)
const FATAL = {
  'not-allowed': 'Allow the microphone for this site to dictate.',
  'service-not-allowed': 'Allow the microphone for this site to dictate.',
  'audio-capture': 'No microphone was found — plug one in (or check it isn’t muted) and try again, or type instead.',
  network: 'The browser’s speech recognition couldn’t reach its service — check the connection and try again, or type instead.',
  'language-not-supported': 'This browser can’t recognise English speech — type instead.',
};
const MIC_WAIT_MS = 10_000; // a permission prompt nobody answers, or a microphone that never starts
const MAX_RESTARTS = 3; // the recognizer ending again and again without hearing anything

export default function useDictation(onPhrase, { mode = 'browser', pauseMs = PAUSE_MS } = {}) {
  const server = mode === 'server' && CAN_RECORD;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const live = useRef(false);
  const handler = useRef(onPhrase);
  handler.current = onPhrase;
  // Browser mode
  const rec = useRef(null);
  const pending = useRef('');
  const heardMid = useRef(''); // words on screen not yet final: kept when the person presses Stop
  const restarts = useRef(0);
  const timer = useRef(null);
  // Server mode
  const audio = useRef(null); // { stream, ctx, analyser, recorder, chunks, spoke, lastVoice, started, tick }

  const flushText = () => {
    clearTimeout(timer.current);
    const text = pending.current.trim();
    pending.current = '';
    if (text) handler.current(text);
  };

  // ---- Server mode: record, cut at each pause, send the piece ----
  const newRecorder = () => {
    const a = audio.current;
    if (!a) return;
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const recorder = new MediaRecorder(a.stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const spoke = recorder.spoke;
      if (!spoke || !chunks.length) return;
      const blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
      setInterim('Writing it down…');
      postAudio('/dictation/transcribe', blob)
        .then(({ text }) => { if (text) handler.current(text); })
        .catch((e) => setError(e.message))
        .finally(() => setInterim(live.current ? 'Listening…' : ''));
    };
    recorder.spoke = false;
    recorder.start();
    Object.assign(a, { recorder, started: Date.now(), lastVoice: 0 });
  };
  const cut = () => {
    const a = audio.current;
    if (!a?.recorder || a.recorder.state === 'inactive') return;
    a.recorder.stop();
    if (live.current) newRecorder();
  };
  const starting = useRef(false);
  const startServer = async () => {
    starting.current = true;
    try {
      const ask = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const stream = await Promise.race([ask, new Promise((_, no) => setTimeout(() => {
        ask.then((late) => late.getTracks().forEach((t) => t.stop()), () => {}); // arrives after we gave up: let it go
        no(new Error('it didn’t answer — check the browser’s microphone permission'));
      }, MIC_WAIT_MS))]);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Browsers hold audio analysis until a click; if it won't run, pieces are cut on a timer instead.
      await ctx.resume().catch(() => { /* stays suspended */ });
      const analyser = ctx.createAnalyser();
      // ~170 ms of audio per look, checked every 100 ms: no gaps, so short words aren't missed.
      analyser.fftSize = 8192;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audio.current = { stream, ctx, analyser };
      live.current = true;
      newRecorder();
      setListening(true);
      setInterim('Listening…');
      audio.current.tick = setInterval(() => {
        const a = audio.current;
        if (!a?.recorder) return;
        const now = Date.now();
        if (a.ctx.state !== 'running') {
          a.recorder.spoke = true;
          if (now - a.started > FALLBACK_PIECE_MS) cut();
          return;
        }
        const buf = new Float32Array(a.analyser.fftSize);
        a.analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        if (rms > LOUD) { a.recorder.spoke = true; a.lastVoice = now; setInterim('Hearing you…'); }
        // A pause after speech, or a long stretch: send what was said so far.
        if (a.recorder.spoke && ((a.lastVoice && now - a.lastVoice > pauseMs) || now - a.started > MAX_PIECE_MS)) cut();
      }, 100);
    } catch (e) {
      live.current = false;
      setListening(false);
      setError(e?.name === 'NotAllowedError' ? 'Allow the microphone for this site to dictate.' : `The microphone couldn’t start (${e.message}).`);
    } finally {
      starting.current = false;
    }
  };
  const stopServer = () => {
    const a = audio.current;
    live.current = false;
    if (!a) return;
    clearInterval(a.tick);
    if (a.recorder && a.recorder.state !== 'inactive') a.recorder.stop();
    a.stream?.getTracks().forEach((t) => t.stop());
    a.ctx?.close().catch(() => { /* already closed */ });
    audio.current = null;
  };

  // ---- Browser mode ----
  const startBrowser = () => {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    restarts.current = 0;
    // Only the recognizer that is listening now counts: one that was told to stop may keep hearing (some
    // browsers ignore stop()), and what it hears after Stop must not land in the chart.
    const current = () => rec.current === r && live.current;
    r.onresult = (e) => {
      if (!current()) return;
      restarts.current = 0;
      let mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) pending.current += ` ${e.results[i][0].transcript}`;
        else mid += e.results[i][0].transcript;
      }
      heardMid.current = mid;
      setInterim(`${pending.current} ${mid}`.trim());
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setInterim(''); flushText(); }, pauseMs);
    };
    // The browser stops after a long silence; keep listening until the dentist turns it off.
    const fail = (message) => {
      live.current = false;
      rec.current = null;
      try { r.abort(); } catch { /* already gone */ }
      flushText();
      setListening(false);
      setInterim('');
      setError(message);
    };
    r.onend = () => {
      if (!current()) return;
      if (++restarts.current > MAX_RESTARTS) return fail('The microphone keeps stopping — try again, or type instead.');
      try { r.start(); } catch { /* restarting */ }
    };
    r.onerror = (e) => { if (current() && FATAL[e.error]) fail(FATAL[e.error]); };
    rec.current = r;
    live.current = true;
    r.start();
    setListening(true);
  };

  const supported = server || !!SR;
  const start = () => {
    if (!supported || live.current || starting.current) return;
    setError(null);
    if (server) startServer();
    else startBrowser();
  };
  const stop = () => {
    if (server) stopServer();
    else {
      live.current = false;
      const r = rec.current;
      rec.current = null;
      // What was on screen when Stop was pressed is what they said; anything heard after it is ignored.
      if (heardMid.current) pending.current += ` ${heardMid.current}`;
      heardMid.current = '';
      try { r?.stop(); } catch { /* already stopped */ }
      // A browser that doesn't end after stop() is cancelled, so the microphone is let go.
      setTimeout(() => { try { r?.abort(); } catch { /* already gone */ } }, 1000);
      flushText();
    }
    setListening(false);
    setInterim('');
  };
  useEffect(() => () => { live.current = false; clearTimeout(timer.current); try { rec.current?.abort(); } catch { /* gone */ } stopServer(); }, []);

  return { supported, server, listening, interim, error, start, stop, toggle: () => (live.current ? stop() : start()) };
}
