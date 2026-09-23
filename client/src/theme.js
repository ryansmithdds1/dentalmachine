// Light or dark: follow the computer's setting ('system', the default) or a choice kept on this computer.
// Applied only while the app itself is on screen (printed documents and patient pages stay light).
const KEY = 'dm_theme';
export const getThemePref = () => {
  try {
    return localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
};
const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
export function applyTheme(pref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export function setThemePref(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  applyTheme(pref);
}
// Keeps the page in step with the system setting while the app is open; returns a cleanup.
export function watchTheme() {
  applyTheme();
  const m = window.matchMedia?.('(prefers-color-scheme: dark)');
  const on = () => getThemePref() === 'system' && applyTheme('system');
  m?.addEventListener('change', on);
  return () => {
    m?.removeEventListener('change', on);
    delete document.documentElement.dataset.theme;
  };
}
