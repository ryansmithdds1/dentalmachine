/* global document, window, sessionStorage, MutationObserver, getComputedStyle, CSS */
// The measuring robot: performs one office action the way a person would and counts what it cost them.
// See docs/workflows/scoring.md for what each number means and how it becomes a score.
//
// What is counted (only real input events, so drive the page with page.click / page.keyboard, never page.fill):
//   clicks       every mouse press (a drag is one click)
//   keys         every key press that isn't a letter typed into a text box: Enter, Tab, Esc, arrows, shortcuts,
//                Ctrl/⌘K… A command typed into the command bar or a "type MERGE" box (t.cmd) counts as 1 key.
//   fields       text boxes the person typed information into (a name, an amount, the note itself): 1 per box,
//                however long the text — the information is inherent to the task, the typing isn't the software's fault
//   textChars    how many characters that information took (reported, not scored)
//   screens      changes of screen (address path, or the ?tab= of a page)
//   modals       dialogs opened (.modal / aria-modal), and the most stacked at once
//   dialogs      the browser's own confirm/prompt/alert boxes (accepted so the action can finish)
//   confirms     "Are you sure?"-style questions inside the app's own dialogs
//   form fields  every form box shown during the action: prefilled (had a value when it appeared) or not,
//                and which ones the person had to touch
//   mouseTravel  pixels the pointer travelled between clicks (the "motion" of an action)
//   a11y         boxes without a label, buttons without a name (basic accessibility)
//   errors       page crashes, console errors, failed requests and 4xx/5xx answers — any of these fails the action
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch, CONSOLE_ALLOW } from '../../lib/watch.mjs';

// Runs inside the page (added to every page load of the context). Keeps its tally in sessionStorage so a full
// page load in the middle of an action doesn't lose it.
export const INSTRUMENT = () => {
  if (window.__dmRobot) return;
  window.__dmRobot = true;
  const KEY = 'dm_robot';
  const blank = () => ({ on: false, clicks: 0, keys: 0, fields: 0, textChars: 0, cmd: 0, modals: 0, maxModals: 0, confirms: 0, travel: 0, last: null, touched: [], log: [], ev: [] });
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || blank(); } catch { return blank(); } };
  const save = (c) => { try { sessionStorage.setItem(KEY, JSON.stringify(c)); } catch { /* storage unavailable */ } };
  window.__dmRobotReset = (on) => { const c = blank(); c.on = on; save(c); };
  window.__dmRobotRead = () => read();
  let lastField = null;
  const fieldOf = (el) => el?.closest?.('input, textarea, [contenteditable], [role="textbox"]');
  // A readable name for a form box: its label, aria-label, name or placeholder.
  const nameOf = (el) => {
    if (!el) return '';
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const wrap = el.closest('label');
    const t = el.getAttribute('aria-label') || (byFor || wrap)?.textContent || el.getAttribute('name') || el.getAttribute('placeholder') || el.getAttribute('title') || el.tagName.toLowerCase();
    return t.replace(/\s+/g, ' ').trim().slice(0, 40);
  };
  window.__dmNameOf = nameOf;
  // ---- Stable targets for the guided walkthroughs (npm run tours → client/public/manual/tours.json) ----
  // What a person acted on, described so the tour overlay can find it again on another day, another patient and
  // another screen size: its data-tour name, test id, label, link, other data-* attributes, or its role and words —
  // whichever is the first that picks out just that element. Kept in step with resolveTarget() in
  // client/src/components/tours/tourEngine.js (same { css, text } meaning).
  const normText = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => normText(el.innerText || el.value || el.getAttribute?.('aria-label') || '').slice(0, 80);
  // A form field's own label words ("Carrier *" → "Carrier"), for fields with nothing else to name them by.
  const labelOf = (el) => {
    const l = el.closest?.('label') || el.labels?.[0];
    if (!l) return '';
    return normText([...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')).replace(/\s*\*$/, '').slice(0, 60);
  };
  const resolve = (t) => {
    let els;
    try { els = [...document.querySelectorAll(t.css)]; } catch { return []; }
    els = els.filter(visible);
    if (t.lab != null) els = els.filter((el) => labelOf(el) === t.lab);
    if (t.text != null) {
      const exact = els.filter((el) => textOf(el) === t.text);
      els = exact.length ? exact : els.filter((el) => textOf(el).startsWith(t.text));
    }
    return els;
  };
  window.__dmResolve = resolve;
  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, [role=button], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=switch], [role=link], [role=row], [data-tour], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
  const cssq = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const STATE = /^(active|hl|focus|focused|selected|open|pending|current|is-|has-|hover|dragging|disabled|small|primary|secondary|link|ghost|danger)/;
  const candidates = (el) => {
    const tag = el.tagName.toLowerCase();
    const a = (n) => el.getAttribute(n);
    const out = [];
    if (a('data-tour')) out.push({ css: `[data-tour=${cssq(a('data-tour'))}]` });
    if (a('data-testid')) out.push({ css: `[data-testid=${cssq(a('data-testid'))}]` });
    if (a('aria-label')) out.push({ css: `${tag}[aria-label=${cssq(a('aria-label'))}]` });
    if (el.id && !/\d{2,}|^:|^r\d/.test(el.id)) out.push({ css: `#${CSS.escape(el.id)}` });
    if (tag === 'a' && a('href') && !/^(https?:|mailto:|tel:)/.test(a('href'))) out.push({ css: `a[href=${cssq(a('href'))}]` });
    for (const n of ['name', 'placeholder', 'title']) if (a(n) && /^(input|select|textarea|button)$/.test(tag)) out.push({ css: `${tag}[${n}=${cssq(a(n))}]` });
    for (const at of el.attributes) if (/^data-(?!tip$|state$|ready$|v$)/.test(at.name) && at.value && at.value.length < 60) out.push({ css: `${tag}[${at.name}=${cssq(at.value)}]` });
    const role = a('role');
    const text = textOf(el);
    const cls = [...el.classList].filter((c) => !STATE.test(c) && !/\d{2,}/.test(c)).slice(0, 2);
    const base = role ? `[role=${cssq(role)}]` : cls.length ? `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}` : tag;
    if (text && text.length <= 60) out.push({ css: base, text });
    if (/^(input|select|textarea)$/.test(tag) && labelOf(el)) out.push({ css: tag, lab: labelOf(el) });
    if (cls.length) out.push({ css: base });
    return out;
  };
  // The nearest named ancestor, to narrow a description that matches more than one element.
  const scopeOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = candidates(p).find((x) => !x.text && x.lab == null && resolve(x).length === 1);
      if (c) return c.css;
    }
    return null;
  };
  // Every description that finds just this element (unique ones first, then ones where it is the first match,
  // marked weak) — npm run tours keeps the first that doesn't name a record by its id.
  const describe = (raw) => {
    if (!raw || raw === document.body || raw === document.documentElement || !raw.closest) return null;
    const el = raw.closest(INTERACTIVE) || raw;
    const label = normText(el.getAttribute('aria-label') || textOf(el) || nameOf(el)).slice(0, 60);
    const cands = candidates(el);
    const scope = scopeOf(el);
    const scoped = scope ? cands.map((c) => ({ ...c, css: `${scope} ${c.css}` })) : [];
    const unique = [...cands, ...scoped].filter((c) => { const r = resolve(c); return r.length === 1 && r[0] === el; });
    const first = [...cands, ...scoped].filter((c) => !unique.includes(c) && resolve(c)[0] === el).map((c) => ({ ...c, weak: true }));
    const alts = [...unique, ...first].slice(0, 8);
    if (!alts.length) return cands[0] ? { ...cands[0], label, weak: true } : null;
    return { ...alts[0], label, alts: alts.slice(1) };
  };
  window.__dmDescribe = describe;
  const combo = (e) => [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && e.key.length > 1 && 'Shift', e.key === ' ' ? 'Space' : e.key].filter(Boolean).join('+');
  const what = (el) => (el.closest('button, a, [role=button], [role=tab], [role=option], label, input, select, textarea, td, th, li')?.textContent || el.getAttribute?.('aria-label') || el.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    const c = read();
    if (!c.on) return;
    c.clicks++;
    if (c.last) c.travel += Math.round(Math.hypot(e.clientX - c.last[0], e.clientY - c.last[1]));
    c.last = [e.clientX, e.clientY];
    c.log.push(`click ${what(e.target)}`);
    c.ev.push({ k: 'click', t: describe(e.target) });
    save(c);
    lastField = null;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    const c = read();
    if (!c.on) return;
    if (window.__dmCmd) {
      // A command typed as words ("bill", "month-end close", "MERGE"): one key for the whole word.
      if (window.__dmCmd === 1) { c.keys++; c.cmd++; c.log.push(`command "${window.__dmCmdText || ''}"`); c.ev.push({ k: 'type', text: window.__dmCmdText || '', cmd: true, t: describe(document.activeElement) }); window.__dmCmd = 2; }
      save(c);
      return;
    }
    const field = fieldOf(e.target);
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && field;
    if (typing) {
      if (field !== lastField) {
        c.fields++;
        const n = nameOf(field);
        c.log.push(`type into "${n}"`);
        if (!c.touched.includes(n)) c.touched.push(n);
        c.ev.push({ k: 'type', text: '', t: describe(field) });
      }
      const lastEv = c.ev[c.ev.length - 1];
      if (lastEv?.k === 'type' && !lastEv.cmd) lastEv.text += e.key;
      c.textChars++;
      lastField = field;
    } else {
      c.keys++;
      c.log.push(`key ${combo(e)}`);
      c.ev.push({ k: 'key', key: combo(e), t: describe(document.activeElement) });
      lastField = null;
    }
    save(c);
  }, true);
  // A choice made in a select or a checkbox (by mouse or keyboard) is a box the person touched.
  document.addEventListener('change', (e) => {
    // A choice in a list (select) counts however it was made — the robot's selectOption isn't a "trusted" event.
    if (!e.isTrusted && !e.target?.matches?.('select')) return;
    const c = read();
    if (!c.on || !e.target?.matches?.('select, input[type=checkbox], input[type=radio], input[type=date], input[type=time]')) return;
    const n = nameOf(e.target);
    if (!c.touched.includes(n)) c.touched.push(n);
    if (e.target.matches('select')) c.ev.push({ k: 'select', value: e.target.value, text: normText(e.target.selectedOptions?.[0]?.textContent), t: describe(e.target) });
    save(c);
  }, true);
  // Dialogs: how many opened, how deep they stacked, and whether one asked "Are you sure?".
  const seen = new WeakSet();
  const check = () => {
    const els = [...document.querySelectorAll('.modal, [role="dialog"][aria-modal="true"], [role="alertdialog"]')].filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
    const n = els.length;
    const c = read();
    if (c.on) {
      let dirty = false;
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        c.modals++;
        c.log.push(`dialog "${(el.querySelector('h1, h2, h3, header')?.textContent || '').trim().slice(0, 40)}"`);
        if (/are you sure|do you really want|confirm that you want/i.test(el.textContent || '')) c.confirms++;
        dirty = true;
      }
      if (n > c.maxModals) { c.maxModals = n; dirty = true; }
      if (dirty) save(c);
    }
  };
  const start = () => { new MutationObserver(check).observe(document.body, { childList: true, subtree: true }); check(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
};

// Everything visible on screen that a person can fill in, inside a form, dialog or side panel.
const FORM_SCAN = () => {
  const scope = 'form, .modal, .inline-panel, .drawer, aside, [role="dialog"], .chart-entry, .card';
  const els = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    if (['hidden', 'submit', 'button', 'search', 'file'].includes(el.type) || el.disabled || el.readOnly) return false;
    if (el.offsetParent === null) return false;
    if (/search|filter|find/i.test(`${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`) && !el.closest('.modal')) return false;
    return !!el.closest(scope);
  });
  return els.map((el) => {
    const filled = el.type === 'checkbox' || el.type === 'radio' ? true : el.tagName === 'SELECT' ? el.value !== '' : !!el.value;
    return { name: window.__dmNameOf ? window.__dmNameOf(el) : el.name, filled };
  });
};

// Basic accessibility: boxes without a label and buttons without a name, on the screen as it is now.
const A11Y_SCAN = () => {
  const problems = [];
  const visible = (el) => el.offsetParent !== null;
  const named = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
    if (el.closest('label')) return true;
    return false;
  };
  for (const el of document.querySelectorAll('main input, main select, main textarea, .modal input, .modal select, .modal textarea, aside input, aside select, aside textarea')) {
    if (['hidden', 'submit', 'button'].includes(el.type) || !visible(el)) continue;
    if (!named(el)) problems.push(`${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} without a label${el.placeholder ? ` (placeholder "${el.placeholder.slice(0, 30)}" only)` : ''}`);
  }
  for (const el of document.querySelectorAll('main button, .modal button, aside button, header button')) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').trim();
    if (!text && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('aria-labelledby')) problems.push(`button without a name (${el.className || 'no class'})`.slice(0, 80));
  }
  return [...new Set(problems)].slice(0, 20);
};

// Answers that are errors by design (the same ones e2e/sweep/sweep.test.mjs tolerates, each explained there).
const BY_DESIGN = [/^403 GET \/api\/diagnosis\/running/, /^403 GET \/api\/phones\/alerts/];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const screenOf = (url) => {
  try {
    const u = new URL(url);
    const tab = u.searchParams.get('tab');
    return `${u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id')}${tab ? `?tab=${tab}` : ''}`;
  } catch { return url; }
};

// One robot run of one action. `api` talks to the server as the action's role (for set-up and checks only).
export function robot({ page, ctx, base, api, action, outDir, today }) {
  const w = watch(page, { base });
  const dir = join(outDir, action.id);
  mkdirSync(dir, { recursive: true });
  const t = {
    page, ctx, base, api, action, today, get: api.get, post: api.post, put: api.put, del: api.del,
    steps: [], flags: [], notes: [], screens: [], dialogs: [], shotTime: 0, allowed: [], measuring: false, forms: new Map(), a11y: new Set(),
  };
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame() || !t.measuring) return;
    const s = screenOf(f.url());
    if (t.screens.at(-1) !== s) t.screens.push(s);
  });
  // Changes the step made (POST/PUT/PATCH/DELETE to the API), so a walkthrough can say whether doing it for real
  // changes office records or only the training patient's.
  t.stepWrites = [];
  page.on('request', (r) => {
    if (!t.measuring || ['GET', 'HEAD', 'OPTIONS'].includes(r.method())) return;
    let path = '';
    try { path = new URL(r.url()).pathname; } catch { return; }
    if (path.startsWith('/api/') && !/^\/api\/(me\/prefs|client-errors|audit\/view|events)/.test(path)) t.stepWrites.push(`${r.method()} ${path}`);
  });
  page.on('dialog', async (d) => {
    if (t.measuring) t.dialogs.push(`${d.type()}: ${d.message().slice(0, 100)}`);
    // The robot says yes so the action can finish (a person would have to click it: it's counted).
    await (d.type() === 'prompt' ? d.accept(d.defaultValue() || 'robot') : d.accept()).catch(() => {});
  });

  const tally = () => page.evaluate(() => window.__dmRobotRead?.() || null).catch(() => null);
  const probe = async () => {
    const t0 = Date.now();
    const forms = await page.evaluate(FORM_SCAN).catch(() => []);
    for (const f of forms) if (!t.forms.has(f.name)) t.forms.set(f.name, f.filled);
    for (const p of await page.evaluate(A11Y_SCAN).catch(() => [])) t.a11y.add(p);
    t.shotTime += Date.now() - t0;
  };
  const shot = async (name, caption) => {
    const t0 = Date.now();
    const file = join(dir, `${String(t.steps.length).padStart(2, '0')}-${slug(name)}.png`);
    await page.waitForTimeout(150); // let the screen paint what the step did
    // The pictures are the user manual's screenshots (npm run manual): wait (up to 3 s, not counted in the
    // action's time) for a screen that is still "Loading…" to show what it loaded.
    await page.waitForFunction(() => ![...document.querySelectorAll('main *')]
      .some((el) => el.childElementCount === 0 && /^Loading\b.{0,40}(…|\.\.\.)$/.test((el.textContent || '').trim()) && el.offsetParent !== null), null, { timeout: 3000, polling: 100 }).catch(() => {});
    await page.screenshot({ path: file }).catch(() => {});
    t.shotTime += Date.now() - t0;
    return { file, caption };
  };

  // Opens where the action starts (not measured), closes pop-ups, and takes the "start here" picture.
  t.open = async (path, selector) => {
    t.readySel = selector || null; // the walkthrough waits for the same thing before its first step
    await page.goto(`${base}${path}`);
    if (selector) await page.waitForSelector(selector, { timeout: 20_000 });
    await t.quiet();
  };
  t.quiet = async () => {
    for (let i = 0; i < 6 && (await page.locator('.modal-backdrop').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  };
  // Where the page is (path and query), for the guided walkthroughs.
  const here = () => { try { const u = new URL(page.url()); return `${u.pathname}${u.search}`; } catch { return null; } };
  t.subjects = [];
  // Starts the clock and the counters.
  t.begin = async (caption = 'Where this starts') => {
    t.startUrl = here();
    t.startFocus = await page.evaluate(() => window.__dmDescribe?.(document.activeElement) || null).catch(() => null);
    await page.evaluate(() => window.__dmRobotReset?.(true));
    w.reset();
    t.screens = [screenOf(page.url())];
    const s = await shot('start', caption);
    t.steps.push({ caption: s.caption, shot: s.file, start: true });
    t.measuring = true;
    t.shotTime = 0;
    t.t0 = Date.now();
    t.before = await tally();
  };
  // One step a person would recognise ("Press Alt+P: the payment form opens with the amount filled in").
  t.step = async (caption, fn) => {
    if (!t.measuring) await t.begin();
    const before = await tally();
    const url0 = here();
    t.stepWrites = [];
    const s0 = Date.now();
    const shot0 = t.shotTime;
    await fn();
    const ms = Date.now() - s0 - (t.shotTime - shot0);
    await probe();
    const after = await tally();
    const s = await shot(caption, caption);
    const d = (k) => (after?.[k] || 0) - (before?.[k] || 0);
    t.steps.push({
      caption, shot: s.file, ms, clicks: d('clicks'), keys: d('keys'), fields: d('fields'), did: (after?.log || []).slice((before?.log || []).length),
      // For the walkthroughs: what was acted on (a stable description of each target) and where the page was.
      ev: (after?.ev || []).slice((before?.ev || []).length), url0, url1: here(), writes: [...new Set(t.stepWrites)],
    });
  };
  // A command typed as words into the command bar or a confirmation box: counts as one key.
  t.cmd = async (text) => {
    await page.evaluate((x) => { window.__dmCmd = 1; window.__dmCmdText = x; }, text);
    await page.keyboard.type(text);
    await page.evaluate(() => { window.__dmCmd = 0; });
  };
  // Information the person types (a name, an amount, the note): 1 field however long.
  t.type = (text) => page.keyboard.type(text);
  t.key = (combo) => page.keyboard.press(combo);
  t.click = (sel, opts) => (typeof sel === 'string' ? page.click(sel, opts) : sel.click(opts));
  t.see = (sel, opts) => page.waitForSelector(sel, opts);
  t.focusIs = (label) => page.waitForFunction((l) => {
    const el = document.activeElement;
    return el?.getAttribute('aria-label') === l || (el?.textContent || '').trim() === l;
  }, label);
  // Choosing a file in the file picker: a person clicks it, so it counts as a click — or, when the picker was
  // opened from the keyboard ({ keyboard: true }), one key: the system's file dialog takes the name typed and Enter.
  t.pickFile = async (trigger, file, { keyboard = false } = {}) => {
    // Listening for the picker is switched on in the browser before the trigger (a picker opened a moment too early
    // would go unseen and the robot would wait for nothing).
    const chooserP = page.waitForEvent('filechooser');
    await page.waitForTimeout(100);
    await trigger();
    const chooser = await chooserP;
    await chooser.setFiles(file);
    if (keyboard) t.extraKeys = (t.extraKeys || 0) + 1;
    else t.extraClicks = (t.extraClicks || 0) + 1;
  };
  // What a reviewer noticed: kind is one of asks-known, dead-end, wording, layout, bug, slow, missing, note.
  t.flag = (kind, text) => t.flags.push({ kind, text });
  t.note = (text) => t.notes.push(text);
  // A request the action is expected to get an error for (e.g. a 404 probe the page makes on purpose).
  t.allow = (re) => t.allowed.push(re);
  t.wait = (ms) => page.waitForTimeout(ms);
  // The demo office can't do this (e.g. no card processor connected): recorded as blocked, not as a failure.
  t.blocked = (why) => { const e = new Error(why); e.blocked = true; throw e; };
  // Clean-up after the measurement (not counted), e.g. undoing a change other actions shouldn't see.
  t.afters = [];
  t.after = (fn) => t.afters.push(fn);

  // Stops the clock and returns the result (steps, counts, problems).
  t.finish = async ({ error } = {}) => {
    const total = t.t0 ? Date.now() - t.t0 - t.shotTime : 0;
    t.measuring = false;
    const c = (await tally()) || {};
    if (error) {
      const s = await shot('failed-here', `The robot got stuck here: ${String(error.message || error).split('\n')[0].slice(0, 160)}`);
      t.steps.push({ caption: s.caption, shot: s.file, failed: true });
    }
    const allowed = (x) => [...t.allowed, ...BY_DESIGN].some((re) => re.test(x));
    const bad = [
      ...w.pageErrors.map((e) => `page error: ${e}`),
      ...w.console.filter((m) => !CONSOLE_ALLOW.some((re) => re.test(m))).map((m) => `console: ${m}`),
      ...w.responses.filter((r) => r.path.startsWith('/api/')).map((r) => `${r.status} ${r.method} ${r.path}`),
      ...w.failed.map((f) => `failed: ${f}`),
    ].filter((x) => !allowed(x));
    const forms = [...t.forms.entries()];
    const touched = new Set(c.touched || []);
    const shown = forms.length;
    const prefilled = forms.filter(([, f]) => f).length;
    const result = {
      id: action.id, name: action.name, role: t.role, status: error ? (error.blocked ? 'blocked' : 'failed') : 'measured', error: error ? String(error.message || error).split('\n').slice(0, 3).join(' ') : undefined,
      clicks: (c.clicks || 0) + (t.extraClicks || 0), keys: (c.keys || 0) + (t.extraKeys || 0), fields: c.fields || 0, textChars: c.textChars || 0, commands: c.cmd || 0,
      screens: Math.max(0, t.screens.length - 1), route: t.screens,
      modals: c.modals || 0, maxModals: c.maxModals || 0, confirms: (c.confirms || 0), dialogs: t.dialogs,
      formFields: { shown, prefilled, touched: [...touched], untouchedBlank: forms.filter(([n, f]) => !f && !touched.has(n)).length },
      mouseTravel: c.travel || 0, ms: total,
      keyboardOnly: ((c.clicks || 0) + (t.extraClicks || 0)) === 0,
      a11y: [...t.a11y], errors: bad, flags: t.flags, notes: t.notes,
      log: c.log || [], steps: t.steps.map((s) => ({ ...s, shot: s.shot.replace(`${outDir}/`, '') })),
      // The guided walkthrough's starting point and the records the run was about (npm run tours makes them
      // placeholders: this patient becomes the training patient, this visit its visit…).
      tour: { start: { url: t.startUrl || null, focus: t.startFocus || null, ready: t.readySel || null }, subjects: t.subjects }, today: t.today,
    };
    result.actions = result.clicks + result.keys + result.fields;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  };
  return t;
}

// Talks to the API as one signed-in person (for set-up and checks; nothing here is counted).
export function apiAs(base, token) {
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; e.data = data; throw e; }
    return data;
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b = {}) => call('PUT', p, b), patch: (p, b = {}) => call('PATCH', p, b), del: (p) => call('DELETE', p),
    raw: call,
  };
}
