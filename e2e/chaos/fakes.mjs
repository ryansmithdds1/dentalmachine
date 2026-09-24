/* global window, navigator */
// Misbehaving browser APIs for the chaos tests, injected with context.addInitScript before the app loads.
// Each fake counts what the app asked of it on window.__chaos so a test can check, say, that a recognizer
// the app gave up on was cancelled.

// Speech recognition. mode:
//  'stubborn' — hears "first words" (final) at once, then "more words" every 300 ms forever, and ignores
//               stop(): never fires onend. abort() works (stops talking, fires onend).
//  'error'    — every start() fails with the given error (default 'audio-capture': no microphone) and then ends,
//               the way Chrome does. An app that restarts on onend loops for ever.
//  'denied'   — every start() fails with 'not-allowed' and then ends.
export const FAKE_SPEECH = ([mode, errorName]) => {
  const c = (window.__chaos = window.__chaos || {});
  Object.assign(c, { recStarts: 0, recStops: 0, recAborts: 0, recResults: 0 });
  const result = (text, isFinal) => {
    const alt = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
    return { resultIndex: 0, results: [alt] };
  };
  class FakeRecognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.timers = []; }
    start() {
      c.recStarts++;
      if (mode === 'error' || mode === 'denied') {
        const error = mode === 'denied' ? 'not-allowed' : errorName || 'audio-capture';
        setTimeout(() => { this.onerror?.({ error, message: '' }); setTimeout(() => this.onend?.(), 10); }, 20);
        return;
      }
      this.onstart?.();
      this.timers.push(setTimeout(() => { c.recResults++; this.onresult?.(result('first words', true)); }, 60));
      this.timers.push(setInterval(() => { c.recResults++; this.onresult?.(result('more words', true)); }, 300));
    }
    stop() { c.recStops++; } // ignored: keeps listening and never ends
    abort() {
      c.recAborts++;
      this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      this.timers = [];
      setTimeout(() => this.onend?.(), 10);
    }
    addEventListener(type, fn) { this[`on${type}`] = fn; }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

// Camera / microphone. mode: 'denied' (NotAllowedError, like a blocked permission) or 'hang' (the permission
// prompt is never answered: the promise never settles).
export const FAKE_MEDIA = (mode) => {
  const c = (window.__chaos = window.__chaos || {});
  c.mediaAsks = 0;
  const md = navigator.mediaDevices || {};
  const fake = () => {
    c.mediaAsks++;
    if (mode === 'hang') return new Promise(() => {});
    return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  };
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: Object.assign(Object.create(Object.getPrototypeOf(md) || null), { getUserMedia: fake, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} }) });
  } catch {
    md.getUserMedia = fake;
  }
  // MediaRecorder must exist for "server" dictation to be offered.
  if (!window.MediaRecorder) window.MediaRecorder = class { static isTypeSupported() { return true; } };
};

// Clipboard writes refused (permission denied, or a page without focus).
export const FAKE_CLIPBOARD_DENIED = () => {
  const c = (window.__chaos = window.__chaos || {});
  c.clipboardTries = 0;
  const deny = () => { c.clipboardTries++; return Promise.reject(Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' })); };
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: deny, write: deny, readText: deny, read: deny } });
  } catch { /* leave it */ }
};

// window.print that counts calls (headless print is a no-op anyway) — mode 'throw' makes it throw, as it
// does in some embedded browsers.
export const FAKE_PRINT = (mode) => {
  const c = (window.__chaos = window.__chaos || {});
  c.prints = 0;
  window.print = () => {
    c.prints++;
    if (mode === 'throw') throw new Error('Printing is not available in this browser');
  };
};
