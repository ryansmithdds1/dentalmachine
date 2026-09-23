import { useCallback, useSyncExternalStore } from 'react';
import ES from './es.js';

// Language for patient-facing pages. Strings are written in English and looked up in es.js:
//   const t = useT();  t('Book a visit')  t('Hi {name}', { name })
// The choice comes from ?lang=es, the patient's toggle (remembered on this device), the patient's
// language on file (suggestLang), then the browser.
const KEY = 'dm_lang';
const subs = new Set();
let chosen = null;
try { chosen = localStorage.getItem(KEY); } catch { /* storage blocked */ }
const fromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lang') : null;
if (fromUrl === 'es' || fromUrl === 'en') chosen = fromUrl;
let suggested = null;
const browser = typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
const current = () => chosen || suggested || browser;

const notify = () => {
  if (typeof document !== 'undefined') document.documentElement.lang = current();
  for (const f of subs) f();
};
export function setLang(l) {
  chosen = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  notify();
}
// The patient's language on file, used unless they picked one here.
export function suggestLang(l) {
  if (l !== 'es' && l !== 'en') return;
  if (suggested === l) return;
  suggested = l;
  notify();
}
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
export const useLang = () => useSyncExternalStore(subscribe, current, current);

export function translate(lang, s, vars) {
  const text = lang === 'es' && ES[s] ? ES[s] : s;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : text;
}
export function useT() {
  const lang = useLang();
  return useCallback((s, vars) => translate(lang, s, vars), [lang]);
}

export const locale = (lang) => (lang === 'es' ? 'es-US' : 'en-US');
// Dates and times from 'YYYY-MM-DD[ HH:MM]' strings, in the page's language.
export function fmtDateL(lang, s, opts = { weekday: 'long', month: 'long', day: 'numeric' }) {
  if (!s) return '';
  return new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale(lang), { ...opts, timeZone: 'UTC' });
}
export function fmtTimeL(lang, s) {
  if (!s || s.length < 16) return '';
  const [h, m] = s.slice(11, 16).split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale(lang), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
export const fmtDateTimeL = (lang, s) => (s ? `${fmtDateL(lang, s)}, ${fmtTimeL(lang, s)}` : '');

// "How did you hear about us?" — the answers the office sees in its referral reports.
export const HEARD_FROM = ['Google search', 'Friend or family', 'Insurance directory', 'Social media', 'Drove by', 'Another dentist', 'Other'];
