// The guided walkthroughs' plumbing, kept apart from the overlay so it can be read on its own: loading the tours,
// filling in their placeholders, finding a step's target on the screen, telling whether what the person just did is
// what the step expects, and doing a step for them ("Show me").
//
// A target is { css, text } — every element matching the CSS selector that is visible, and (when `text` is given)
// whose words are exactly, or else start with, `text`. The measuring robot describes what it acted on the same way
// (e2e/actions/lib/robot.mjs, INSTRUMENT), and `npm run tours` turns its runs into client/public/manual/tours.json.

let cached = null;
export function loadTours() {
  if (!cached) {
    cached = fetch('/manual/tours.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`The walkthroughs couldn’t be loaded (${r.status})`); return r.json(); })
      .catch((e) => { cached = null; throw e; });
  }
  return cached;
}

// "{last}" → the training patient's last name (or the real patient's, when the tour runs on one).
export function fill(value, ctx) {
  if (value == null) return value;
  return String(value).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null ? String(ctx[k]) : m));
}
export const unfilled = (value) => /\{\w+\}/.test(String(value ?? ''));
export function fillTarget(t, ctx) {
  if (!t) return null;
  return { ...t, css: fill(t.css, ctx), ...(t.text != null ? { text: fill(t.text, ctx) } : {}), ...(t.has != null ? { has: fill(t.has, ctx) } : {}), ...(t.label ? { label: fill(t.label, ctx) } : {}), ...(t.lab != null ? { lab: fill(t.lab, ctx) } : {}) };
}

const normText = (x) => String(x || '').replace(/\s+/g, ' ').trim();
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const textOf = (el) => normText(el.innerText || el.value || el.getAttribute?.('aria-label') || '').slice(0, 80);
const OURS = '.tour-layer, .tour-callout';
// A form field's own label words ("Carrier *" → "Carrier"): { css: 'select', lab: 'Carrier' } (the robot's labelOf).
export const labelOf = (el) => {
  const l = el.closest?.('label') || el.labels?.[0];
  if (!l) return '';
  return normText([...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')).replace(/\s*\*$/, '').slice(0, 60);
};

// Every element on screen the target describes, best first (never the walkthrough's own overlay).
export function resolveTarget(t) {
  if (!t?.css || unfilled(t.css)) return [];
  let els;
  try { els = [...document.querySelectorAll(t.css)]; } catch { return []; }
  els = els.filter((el) => visible(el) && !el.closest(OURS));
  if (t.lab != null) els = els.filter((el) => labelOf(el) === t.lab);
  if (t.text != null) {
    const exact = els.filter((el) => textOf(el) === t.text);
    els = exact.length ? exact : els.filter((el) => textOf(el).startsWith(t.text));
  }
  // { has }: somewhere in its words (the robot's :has-text).
  if (t.has != null && !unfilled(t.has)) els = els.filter((el) => normText(el.innerText || el.textContent).includes(t.has));
  return els;
}
export const findTarget = (t) => resolveTarget(t)[0] || null;

// ---- keys ----
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
// "Ctrl+k" (as the robot pressed it on Linux) → { mod, alt, shift, key }. Ctrl and ⌘ are the same key here.
export function parseCombo(combo) {
  const parts = String(combo).split('+');
  const key = parts.pop() || '+';
  const mods = new Set(parts);
  return { mod: mods.has('Ctrl') || mods.has('Control') || mods.has('Meta'), alt: mods.has('Alt'), shift: mods.has('Shift'), key: key === 'Space' ? ' ' : key };
}
export function keyMatches(combo, e) {
  const c = parseCombo(combo);
  if (c.mod !== (e.ctrlKey || e.metaKey) || c.alt !== e.altKey) return false;
  if (c.key.length === 1 && /[a-z]/i.test(c.key)) {
    // A capital means Shift. Letters are also matched by position, so Alt+letter on a Mac (which types a symbol)
    // still counts.
    const upper = c.key !== c.key.toLowerCase();
    if (upper !== e.shiftKey) return false;
    return e.key.toLowerCase() === c.key.toLowerCase() || e.code === `Key${c.key.toUpperCase()}`;
  }
  if (c.key.length === 1) return e.key === c.key;
  return e.key === c.key && (c.shift === e.shiftKey);
}
const KEYNAME = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ' ': 'Space' };
// How a key is written for a person: "Ctrl K" (⌘ K on a Mac), "Shift C", "Alt B", "Enter".
export function keyLabel(combo) {
  const c = parseCombo(combo);
  const out = [];
  if (c.mod) out.push(isMac ? '⌘' : 'Ctrl');
  if (c.alt) out.push(isMac ? '⌥' : 'Alt');
  if (c.shift || (c.key.length === 1 && /[A-Z]/.test(c.key))) out.push('Shift');
  out.push(KEYNAME[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return out;
}

// ---- doing a step for the person ("Show me") ----
const textField = (el) => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable="true"]');
function press(el, name, init = {}) {
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, ...init };
  const Ev = name.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
  return el.dispatchEvent(new Ev(name, opts));
}
export function doClick(el) {
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  press(el, 'pointerdown', { pointerType: 'mouse', isPrimary: true });
  press(el, 'mousedown');
  if (el.focus && !textField(el)) el.focus({ preventScroll: true });
  press(el, 'pointerup', { pointerType: 'mouse', isPrimary: true });
  press(el, 'mouseup');
  el.click();
}
export function doKey(combo, el = document.activeElement || document.body) {
  const c = parseCombo(combo);
  const code = c.key.length === 1 && /[a-z]/i.test(c.key) ? `Key${c.key.toUpperCase()}` : /^\d$/.test(c.key) ? `Digit${c.key}` : c.key;
  const init = {
    key: c.key, code, bubbles: true, cancelable: true, composed: true, altKey: c.alt, shiftKey: c.shift || (c.key.length === 1 && /[A-Z]/.test(c.key)),
    ctrlKey: c.mod && !isMac, metaKey: c.mod && isMac,
  };
  const target = el || document.body;
  const went = target.dispatchEvent(new KeyboardEvent('keydown', init));
  // What the browser itself would have done (made-up key presses don't do it): Enter or Space on a button clicks
  // it, Enter in a form field sends the form.
  if (went && ['Enter', ' '].includes(c.key) && target.matches?.('button, a[href], [role=button], [role=option], [role=tab], input[type=checkbox], summary')) target.click();
  else if (went && c.key === 'Enter' && target.form && textField(target) && !target.matches('textarea')) target.form.requestSubmit?.();
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}
// Puts `text` into a box the way typing would (React sees an ordinary change).
export function doType(el, text) {
  if (!el) return;
  el.focus?.({ preventScroll: false });
  if (el.isContentEditable) { document.execCommand?.('insertText', false, text); return; }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (set) set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
export function doSelect(el, { value, text }) {
  if (!el) return;
  // The robot's choice, else (a choice that was the robot's own record, or "any") the first real one not already picked.
  const opt = [...el.options].find((o) => value != null && o.value === value) || [...el.options].find((o) => text != null && normText(o.textContent) === text)
    || [...el.options].find((o) => o.value && !o.disabled && o.value !== el.value && !/^(new|\+)/i.test(o.value));
  if (!opt) return;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (set) set.call(el, opt.value); else el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
export const isTextField = textField;
// A list already showing the choice a step asks for (its value or words; any real choice for { any: true }).
export function selectDone(el, { value, text, any } = {}) {
  if (!el || el.tagName !== 'SELECT' || !el.value) return false;
  // The only real choice there is, already chosen (this office has one membership plan, one specialist).
  if ([...el.options].filter((o) => o.value && !o.disabled).length === 1) return true;
  if (any) return false; // "choose one" still wants the person to choose
  return (value != null && el.value === value) || (text != null && normText(el.selectedOptions?.[0]?.textContent) === text);
}

// ---- finding tours ----
const FILLER = new Set(['how', 'do', 'i', 'to', 'a', 'an', 'the', 'show', 'me', 'help', 'can', 'my', 'we', 'you', 'what', 'is', 'of', 'for', 'on', 'in', 'with', 'and', 'or', 'where', 'please', 'tour', 'walkthrough', 'does', 'it', 'at', 'up']);
const stem = (w) => w.replace(/’/g, "'").replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
export const tourWords = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9/'’ -]+/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w)).map(stem).filter((w) => w.length > 1);
// role (optional): the person's role in the tours' words — their own walkthroughs come first among equals.
export function searchTours(tours, q, limit = 50, { role = null } = {}) {
  const words = tourWords(q);
  if (!words.length) return [];
  // The words as typed, small ones too ("check a patient in"): a title that says just that comes first.
  const flat = (s) => ` ${String(s).toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const phrase = flat(String(q).replace(SHOW_ME_WORDS, '')).trim();
  const scored = [];
  for (const t of tours) {
    const title = `${t.q} ${t.title}`.toLowerCase();
    const exact = phrase.length > 3 && (flat(t.title).includes(` ${phrase} `) || flat(t.q).includes(` ${phrase} `)) ? 6 : 0;
    const more = `${t.areaLabel} ${t.what} ${t.steps.map((s) => s.text).join(' ')}`.toLowerCase();
    let score = 0; let found = 0; let strong = 0;
    for (const w of words) {
      const s = title.includes(w) ? 4 : more.includes(w) ? 1 : 0;
      if (s) found++;
      if (s > 1) strong++;
      score += s;
    }
    if (!strong || found < words.length - (words.length > 2 ? 1 : 0)) continue;
    const mine = role && t.roles?.includes(role) ? 2 : 0;
    scored.push({ t, score: score + exact + mine + Math.log10(1 + (t.perDay || 0)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.t);
}
export const SHOW_ME_WORDS = /^\s*(show\s+me(\s+how)?(\s+to)?|walk\s+me\s+through|tour\b|teach\s+me)/i;

// The staff member's role in the tours' words.
export const MY_ROLE = { front_desk: 'front desk', billing: 'billing', dentist: 'dentist', hygienist: 'hygienist', assistant: 'assistant', admin: 'office manager' };
export const ROLE_SET = { 'front desk': 'front-desk-basics', billing: 'billing-basics', dentist: 'dentist-basics', hygienist: 'hygienist-basics', assistant: 'assistant-basics', 'office manager': 'office-manager-basics' };
