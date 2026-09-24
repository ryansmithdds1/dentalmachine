import { useEffect, useRef, useState } from 'react';

// Keyboard shortcuts that screens register while they're showing. The ? list shows them, and the command
// bar can run the commands screens add. Combos: "c", "shift+n", "alt+p", "mod+k" (Ctrl, or ⌘ on a Mac).
const registry = new Map();
const commands = new Map();
const listeners = new Set();
let seq = 0;
const changed = () => listeners.forEach((f) => f());
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const typingIn = (el) => !!el?.closest?.('input, textarea, select, [contenteditable], [role="textbox"]');

export function matches(combo, e) {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop();
  const want = { mod: parts.includes('mod'), alt: parts.includes('alt'), shift: parts.includes('shift') };
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (want.mod !== mod || want.alt !== e.altKey) return false;
  // Letters are compared by the key's position, so Alt on a Mac (which types symbols) still works.
  const pressed = /^[a-z]$/.test(key) ? (e.code === `Key${key.toUpperCase()}` || e.key.toLowerCase() === key) : e.key.toLowerCase() === key;
  if (!pressed) return false;
  // Shift matters for letters and named keys (Enter vs Shift+Enter); "?" and other symbols already need it to type.
  return key.length === 1 && !/^[a-z]$/.test(key) ? true : want.shift === e.shiftKey;
}
export const comboLabel = (combo) => combo.split('+').map((k) => ({ mod: isMac ? '⌘' : 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: 'Shift' }[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))));

export function useShortcut(combo, handler, opts = {}) {
  useShortcuts([{ combo, handler, ...opts }]);
}

// Several at once: [{ combo, handler, label, section, enabled, inInputs }].
export function useShortcuts(list) {
  const ref = useRef(list);
  ref.current = list;
  const key = JSON.stringify(list.map((s) => [s.combo, s.label, s.section, s.enabled !== false, !!s.inInputs]));
  useEffect(() => {
    const live = ref.current.filter((s) => s.combo && s.enabled !== false);
    if (!live.length) return undefined;
    const ids = [];
    for (const s of live) {
      if (!s.label) continue;
      const id = ++seq;
      ids.push(id);
      registry.set(id, { combo: s.combo, label: s.label, section: s.section || 'This screen' });
    }
    if (ids.length) changed();
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const i = live.findIndex((s) => matches(s.combo, e));
      if (i < 0) return;
      const s = live[i];
      const plain = !/mod|alt/.test(s.combo);
      if (plain && !s.inInputs && typingIn(e.target)) return;
      if (plain && document.querySelector('.modal, .palette')) return;
      e.preventDefault();
      // The latest handler for this combo (it may close over new state).
      (ref.current.find((x) => x.combo === s.combo)?.handler || s.handler)(e);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); ids.forEach((id) => registry.delete(id)); if (ids.length) changed(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Commands a screen offers in the command bar while it's open: [{ id, label, hint, run }].
export function useCommands(list) {
  const key = JSON.stringify(list.map((c) => [c.id, c.label, c.hint]));
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    const id = ++seq;
    commands.set(id, () => ref.current);
    changed();
    return () => { commands.delete(id); changed(); };
  }, [key]);
}

export const registeredShortcuts = () => [...registry.values()];
export const screenCommands = () => [...commands.values()].flatMap((f) => f());
export function useShortcutList() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
  return registeredShortcuts();
}
