import { useEffect, useState } from 'react';
import { api } from './api.js';

// Smart defaults: what this person used last (payment method, note template, visit length…), kept on the
// server so it follows them to any computer. Keys can be scoped: remembered(`note.template@provider:${id}`).
let cache = null;
let loading = null;
const listeners = new Set();
const notify = () => listeners.forEach((f) => f());

export function loadPrefs() {
  if (!loading) {
    loading = api.get('/me/prefs')
      .then((p) => { cache = p || {}; notify(); return cache; })
      // Defaults are a convenience: without them forms just start from their usual values.
      .catch(() => { cache = cache || {}; return cache; });
  }
  return loading;
}
export const resetPrefs = () => { cache = null; loading = null; };
export const getPref = (key, fallback) => (cache && Object.hasOwn(cache, key) ? cache[key] : fallback);
export function setPref(key, value) {
  if (cache && JSON.stringify(cache[key]) === JSON.stringify(value)) return;
  cache = { ...(cache || {}), [key]: value };
  notify();
  // A lost preference only means one more click next time.
  api.put(`/me/prefs/${encodeURIComponent(key)}`, { value }).catch(() => { /* not important */ });
}
// For a preference saved through a route of its own (e.g. PUT /me/nav-pins, which checks and records it):
// updates what this screen shows at once; the caller saves it and puts the old value back if that fails.
export function showPref(key, value) {
  cache = { ...(cache || {}), [key]: value };
  notify();
}

// [value, remember] — value is the last one remembered (or the fallback until prefs load).
export function useRemembered(key, fallback) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    loadPrefs();
    return () => listeners.delete(f);
  }, []);
  return [key ? getPref(key, fallback) : fallback, (v) => key && setPref(key, v)];
}
