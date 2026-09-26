import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, ArrowLeft, Wand2, SkipForward, GraduationCap, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, setPracticeMode } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useActivePatient } from '../../activePatient.jsx';
import { toast } from '../../toast.js';
import { loadTours, fill, fillTarget, findTarget, keyMatches, keyLabel, parseCombo, doClick, doKey, doType, doSelect, isTextField, unfilled, selectDone } from './tourEngine.js';
import './tours.css';

// Guided walkthroughs ("Show me"). A tour is a list of steps made from the measuring robot's run of that office
// action (tours.json, `npm run tours`). The overlay dims the page, lights up what to act on, and says what to do and
// which key does it; it moves on when the person actually does it — the click, the key, the typing — so they learn by
// doing. "Show me" does the step for them. Tours run on the training patient (Tess Training, server/src/training.js)
// unless the person chooses a real chart, in which case the steps really happen and the tour says so.
//
// Mounted once in the signed-in shell (App.jsx), outside the page's error boundary, so it carries on across pages.
// Start one with useTours().start(id), or from anywhere with window.dispatchEvent(new CustomEvent('dm:tour',
// { detail: { id } })). window.__dmTour.state() tells tests (and the replay check) where it is.
const Ctx = createContext({ start: () => {}, running: false });
export const useTours = () => useContext(Ctx);
export const startTour = (id, opts = {}) => window.dispatchEvent(new CustomEvent('dm:tour', { detail: { id, ...opts } }));

const FIND_MS = 8000; // how long a step's target may take to appear before the tour offers to skip it
// The page has finished loading what it shows (no "Loading…" line left in the main area).
const settled = () => ![...document.querySelectorAll('main *')].some((el) => el.childElementCount === 0 && /^Loading\b.{0,40}(…|\.\.\.)$/.test((el.textContent || '').trim()) && el.offsetParent !== null);
const SETTLE_MS = 350; // after a step is done, a moment for the screen to show what it did
const keyOfUrl = (u) => { try { const x = new URL(u, window.location.origin); return `${x.pathname}?${[...x.searchParams].sort().map(([k, v]) => `${k}=${v}`).join('&')}`; } catch { return u; } };
const sameUrl = (want, loc) => {
  const w = new URL(want, window.location.origin);
  if (w.pathname !== loc.pathname) return false;
  const have = new URLSearchParams(loc.search);
  return [...w.searchParams].every(([k, v]) => have.get(k) === v);
};

export function TourProvider({ children }) {
  const nav = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { patientId, recent, setActive } = useActivePatient();
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  runRef.current = run;
  const set = useCallback((patch) => setRun((r) => (r ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)), []);

  // ---- tracking (Manage → Training) ----
  const track = useCallback((r, patch) => {
    if (!r?.runId) return;
    api.patch(`/training/runs/${r.runId}`, patch).catch((e) => {
      // Progress is a convenience record; the tour itself goes on. A failed finish is said, so it can be done again.
      if (patch.status) toast(`Your training record wasn’t saved (${e.message})`, { tone: 'error' });
    });
  }, []);

  const start = useCallback(async (id, opts = {}) => {
    let data;
    try { data = await loadTours(); } catch (e) { toast(e.message, { tone: 'error' }); return; }
    const tour = data.tours.find((t) => t.id === id);
    if (!tour) { toast('There’s no walkthrough for that yet', { tone: 'error' }); return; }
    const active = patientId ? recent.find((r) => r.id === patientId) || { id: patientId } : null;
    setRun({
      tour, phase: 'intro', step: 0, sub: 0, ctx: {}, status: 'waiting', shown: 0, done: 0,
      queue: opts.queue || [], queueTitle: opts.queueTitle || null, previous: active,
      realPatient: active && !active.is_training ? active : null, onReal: false, key: `${id}-${Date.now()}`,
    });
  }, [patientId, recent]);

  const begin = useCallback(async (onReal) => {
    const r = runRef.current;
    if (!r) return;
    set({ phase: 'preparing', onReal });
    try {
      let ctx = { today: new Date().toLocaleDateString('en-CA') };
      let pid = null;
      if (r.tour.patient && !onReal) {
        await api.post('/training/patient');
        const prep = await api.post('/training/patient/prepare', { needs: r.tour.needs || [], tour_id: r.tour.id });
        ctx = { ...ctx, ...prep };
        pid = prep.patient;
        setActive({ id: prep.patient, first_name: prep.first, last_name: prep.last, is_training: 1 });
      } else if (r.tour.patient && onReal && r.realPatient) {
        const p = await api.get(`/patients/${r.realPatient.id}`);
        ctx = { ...ctx, patient: p.id, first: p.first_name, last: p.last_name };
        pid = p.id;
      }
      const made = await api.post('/training/runs', {
        tour_id: r.tour.id, on_training: !onReal, patient_id: pid, steps_total: r.tour.steps.length, client_key: r.key,
      }).catch(() => null); // a walkthrough still runs without its record (the record says so when it can't finish)
      setRun((x) => x && { ...x, phase: 'step', step: 0, sub: 0, ctx, runId: made?.id || null, status: 'waiting', since: Date.now(), navigated: {} });
    } catch (e) {
      toast(`The walkthrough couldn’t start: ${e.message}`, { tone: 'error' });
      setRun(null);
    }
  }, [set, setActive]);

  const exit = useCallback(() => {
    const r = runRef.current;
    if (r?.phase === 'step') track(r, { status: 'exited', steps_done: r.done, steps_shown: r.shown });
    setRun(null);
  }, [track]);

  // The next step (or the end).
  const advance = useCallback((shown = false) => {
    setRun((r) => {
      if (!r || r.phase !== 'step') return r;
      const done = Math.max(r.done, r.step + 1);
      const n = { ...r, done, shown: r.shown + (shown ? 1 : 0) };
      if (r.step + 1 >= r.tour.steps.length) {
        track(n, { status: 'completed', steps_done: r.tour.steps.length, steps_shown: n.shown });
        return { ...n, phase: 'done' };
      }
      track(n, { steps_done: done, steps_shown: n.shown });
      return { ...n, step: r.step + 1, sub: 0, status: 'waiting', since: Date.now() };
    });
  }, [track]);

  const completeSub = useCallback((shown = false) => {
    const r = runRef.current;
    if (!r || r.phase !== 'step') return;
    const step = r.tour.steps[r.step];
    if (r.sub + 1 < step.expect.length) set({ sub: r.sub + 1, status: 'waiting', since: Date.now() });
    else if (step.leaves && r.step + 1 >= r.tour.steps.length) {
      // The step opens a screen outside the app (the plan for the patient to sign on this device): the walkthrough
      // is done now, before the page goes.
      track(r, { status: 'completed', steps_done: r.tour.steps.length, steps_shown: r.shown + (shown ? 1 : 0) });
      setRun(null);
    } else {
      set({ status: 'settling' });
      setTimeout(() => { if (runRef.current?.key === r.key && runRef.current.step === r.step) advance(shown); }, SETTLE_MS);
    }
  }, [advance, set, track]);

  const back = useCallback(() => set((r) => (r.step > 0 ? { step: r.step - 1, sub: 0, status: 'waiting', since: Date.now(), navigated: { ...r.navigated, [r.step - 1]: false } } : {})), [set]);

  // While practising (not on a real chart), what the walkthrough creates is practice data too (server: training.js).
  useEffect(() => {
    setPracticeMode(!!run && ['preparing', 'step'].includes(run.phase) && !run.onReal);
    return () => setPracticeMode(false);
  }, [run?.phase, run?.onReal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the current expectation, filled in ----
  const step = run?.phase === 'step' ? run.tour.steps[run.step] : null;
  const exp = step ? step.expect[run.sub] || null : null;
  const target = useMemo(() => (exp?.t && run ? fillTarget(exp.t, run.ctx) : null), [exp, run?.ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the step's page (the first step, or one the robot reached by opening a page).
  useEffect(() => {
    if (!run || run.phase !== 'step' || run.sub !== 0 || run.navigated?.[run.step]) return;
    const want = fill(run.step === 0 ? (step.url || run.tour.start?.url) : step.url, run.ctx);
    set((r) => ({ navigated: { ...r.navigated, [r.step]: true } }));
    if (want && !unfilled(want) && !sameUrl(want, location)) nav(want);
  }, [run?.phase, run?.step, run?.sub]); // eslint-disable-line react-hooks/exhaustive-deps

  // Looking for the target (and following it as the page scrolls or changes).
  const [rect, setRect] = useState(null);
  const focusedStart = useRef(null);
  useEffect(() => {
    if (!run || run.phase !== 'step') { setRect(null); return undefined; }
    let alive = true;
    let scrolled = false;
    const tick = () => {
      if (!alive) return;
      const r = runRef.current;
      if (!r || r.phase !== 'step') return;
      // The first step starts where the robot's did: e.g. with the training patient's visit selected.
      if (r.step === 0 && r.sub === 0 && r.tour.start?.focus && focusedStart.current !== r.key) {
        const f = findTarget(fillTarget(r.tour.start.focus, r.ctx));
        if (f) { f.focus?.({ preventScroll: false }); focusedStart.current = r.key; }
      }
      // The first step waits for the page the robot waited for (e.g. the chart's contact card) before it counts as ready.
      const pageReady = r.step !== 0 || !r.tour.start?.ready || !!findTarget(fillTarget(r.tour.start.ready, r.ctx));
      const el = target && pageReady ? findTarget(target) : null;
      if (el) {
        if (!scrolled) { el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); scrolled = true; }
        const b = el.getBoundingClientRect();
        setRect((old) => (old && old.x === b.x && old.y === b.y && old.w === b.width && old.h === b.height ? old : { x: b.x, y: b.y, w: b.width, h: b.height }));
        if (r.status === 'waiting' || r.status === 'missing') set({ status: 'ready' });
        // "Pick the specialist" when the usual one is already picked: nothing to do, it moves on.
        if (exp?.k === 'select' && r.status === 'ready' && !performing.current && selectDone(el, { value: fill(exp.value, r.ctx), text: fill(exp.text, r.ctx), any: exp.any })) completeSub(false);
      } else {
        setRect(null);
        // No target (a key pressed anywhere): ready once the page has settled — nothing still "Loading…".
        if (!target && r.status === 'waiting' && pageReady && settled() && Date.now() - (r.since || 0) > 250) set({ status: 'ready' });
        else if (!target && !pageReady && r.status === 'waiting' && Date.now() - (r.since || 0) > FIND_MS) set({ status: 'missing' });
        else if (target && r.status !== 'missing' && r.status !== 'settling' && Date.now() - (r.since || 0) > FIND_MS) set({ status: 'missing' });
        else if (target && r.status === 'ready') set({ status: 'waiting' });
      }
    };
    tick();
    const id = setInterval(tick, 150);
    window.addEventListener('resize', tick);
    window.addEventListener('scroll', tick, true);
    return () => { alive = false; clearInterval(id); window.removeEventListener('resize', tick); window.removeEventListener('scroll', tick, true); };
  }, [run?.phase, run?.step, run?.sub, target]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- "Show me": does the rest of this step ----
  const performing = useRef(false);
  const showMe = useCallback(async () => {
    const r = runRef.current;
    if (!r || r.phase !== 'step' || performing.current) return;
    performing.current = true;
    try {
      const st = r.tour.steps[r.step];
      for (let i = r.sub; i < st.expect.length; i++) {
        const e = st.expect[i];
        const t = e.t ? fillTarget(e.t, r.ctx) : null;
        let el = null;
        for (let w = 0; t && !el && w < 40; w++) { el = findTarget(t); if (!el) await new Promise((ok) => setTimeout(ok, 100)); }
        if (e.k === 'click') { if (el) doClick(el); } else if (e.k === 'key') {
          if (el && el !== document.activeElement && el.focus) el.focus();
          doKey(e.key, document.activeElement);
        } else if (e.k === 'type') {
          const field = el && isTextField(el) ? el : isTextField(document.activeElement) ? document.activeElement : el;
          doType(field, fill(e.text, r.ctx));
        } else if (e.k === 'select') doSelect(el, { value: fill(e.value, r.ctx), text: fill(e.text, r.ctx) });
        await new Promise((ok) => setTimeout(ok, 300));
        if (i + 1 < st.expect.length) set({ sub: i + 1 });
      }
      set({ status: 'settling' });
      setTimeout(() => advance(true), SETTLE_MS);
    } finally {
      performing.current = false;
    }
  }, [advance, set]);

  // ---- noticing what the person does ----
  const typed = useRef(null);
  useEffect(() => {
    if (!run) return undefined;
    const inCallout = (e) => e.target?.closest?.('.tour-callout');
    const onKey = (e) => {
      const r = runRef.current;
      if (!r) return;
      // Esc leaves the walkthrough — a real key press, not in the command bar (there Esc closes the bar first, and
      // the bar closes itself with a made-up Esc after running a command).
      if (e.key === 'Escape' && e.isTrusted && !e.target?.closest?.('.palette') && !(r.phase === 'step' && exp?.k === 'key' && exp.key === 'Escape')) {
        e.preventDefault(); e.stopPropagation(); exit(); return;
      }
      if (r.phase === 'done') return;
      if (r.phase !== 'step' || performing.current) return;
      if (e.altKey && e.shiftKey && ['ArrowRight', 'ArrowLeft', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'ArrowRight') showMe();
        else if (e.key === 'ArrowLeft') back();
        else document.querySelector('.tour-callout button')?.focus();
        return;
      }
      // Enter, Space and Tab in the walkthrough's own box work its buttons; other keys still reach the page.
      if (inCallout(e) && ['Enter', ' ', 'Tab'].includes(e.key)) return;
      if (exp?.k === 'key' && keyMatches(exp.key, e)) setTimeout(() => completeSub(false), 0);
      else if (exp?.k === 'type' && typed.current === r.key + r.step + r.sub) {
        // Typing done and the next thing happens (usually Enter): both count.
        const next = r.tour.steps[r.step].expect[r.sub + 1];
        if (next?.k === 'key' && keyMatches(next.key, e)) { set({ sub: r.sub + 1 }); setTimeout(() => completeSub(false), 0); }
      }
    };
    let idle = null;
    const onInput = (e) => {
      const r = runRef.current;
      if (!r || r.phase !== 'step' || performing.current || exp?.k !== 'type' || inCallout(e)) return;
      const el = e.target;
      const want = target ? findTarget(target) : null;
      if (want ? !(want === el || want.contains(el)) : !isTextField(el)) return;
      const value = String(el.value ?? el.textContent ?? '').trim();
      if (!value) return;
      typed.current = r.key + r.step + r.sub;
      clearTimeout(idle);
      // Last thing in the step (or nothing else happens): done once they stop typing for a moment.
      idle = setTimeout(() => { const x = runRef.current; if (x && x.step === r.step && x.sub === r.sub) completeSub(false); }, 1500);
    };
    const onChange = (e) => {
      if (exp?.k !== 'select' || performing.current || inCallout(e)) return;
      const want = target ? findTarget(target) : null;
      if (!want || want === e.target) completeSub(false);
    };
    const onPointer = (e) => {
      const r = runRef.current;
      if (!r || r.phase !== 'step' || performing.current || inCallout(e) || e.target?.closest?.('.tour-layer')) return;
      const want = target ? findTarget(target) : null;
      const hit = want && (want === e.target || want.contains(e.target));
      if (exp?.k === 'click') { if (!want || hit) setTimeout(() => completeSub(false), 120); return; }
      // "Press Enter" on a lit-up button: clicking it is the same thing.
      if (exp?.k === 'key' && hit && ['Enter', ' '].includes(parseCombo(exp.key).key) && want.matches('button, a[href], [role=button], [role=option], [role=tab], summary')) setTimeout(() => completeSub(false), 120);
    };
    // While something is lit up, the rest of the page is dimmed and doesn't take clicks (the box nudges instead).
    // Checked against where the control is at the moment of the click, so a page that just moved never swallows a
    // click on it.
    const guard = (e) => {
      const r = runRef.current;
      if (!r || r.phase !== 'step' || performing.current || !target || inCallout(e)) return;
      const want = findTarget(target);
      if (!want || want === e.target || want.contains(e.target)) return;
      // The page's own pop-ups that the step opened (a menu, a date picker) stay usable.
      if (e.target?.closest?.('.palette, [role="listbox"], [role="menu"], .modal')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'pointerdown') window.dispatchEvent(new Event('dm:tour-nudge'));
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('pointerdown', onPointer, true);
    for (const t of ['pointerdown', 'mousedown', 'click']) document.addEventListener(t, guard, true);
    return () => {
      clearTimeout(idle);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('pointerdown', onPointer, true);
      for (const t of ['pointerdown', 'mousedown', 'click']) document.removeEventListener(t, guard, true);
    };
  }, [run?.phase, run?.step, run?.sub, exp, target, exit, showMe, back, completeSub, set]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- starting from elsewhere (the command bar, a manual page, the welcome) ----
  useEffect(() => {
    const on = (e) => start(e.detail?.id, e.detail || {});
    window.addEventListener('dm:tour', on);
    return () => window.removeEventListener('dm:tour', on);
  }, [start]);
  useEffect(() => {
    window.__dmTour = {
      state: () => {
        const r = runRef.current;
        if (!r) return null;
        const st = r.phase === 'step' ? r.tour.steps[r.step] : null;
        const e = st?.expect[r.sub] || null;
        return {
          id: r.tour.id, phase: r.phase, step: r.step, sub: r.sub, steps: r.tour.steps.length, status: r.status, onReal: r.onReal, ctx: r.ctx,
          expect: e && { ...e, t: e.t ? fillTarget(e.t, r.ctx) : null, text: e.text != null ? fill(e.text, r.ctx) : undefined, value: e.value != null ? fill(e.value, r.ctx) : undefined },
          text: st ? fill(st.text, r.ctx) : null,
        };
      },
      start: (id, opts) => start(id, opts),
      begin: (onReal = false) => begin(onReal),
      // The element a target describes (the replay check clicks exactly what the overlay lights up).
      find: (t) => findTarget(t),
    };
    return () => { delete window.__dmTour; };
  }, [start, begin]);

  const value = useMemo(() => ({ start, running: !!run, exit }), [start, run, exit]);
  const nextInQueue = run?.queue?.[0] || null;
  return (
    <Ctx.Provider value={value}>
      {children}
      {run && (
        <TourOverlay
          run={run} step={step} exp={exp} target={target} rect={rect} user={user}
          onBegin={begin} onExit={exit} onBack={back} onShowMe={showMe} onSkip={() => advance(false)} onRetry={() => set({ status: 'waiting', since: Date.now() })}
          onNext={nextInQueue ? () => start(nextInQueue, { queue: run.queue.slice(1), queueTitle: run.queueTitle }) : null}
        />
      )}
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------------------------
const PAD = 6;
function TourOverlay({ run, step, exp, target, rect, onBegin, onExit, onBack, onShowMe, onSkip, onRetry, onNext }) {
  const box = useRef(null);
  const [nudge, setNudge] = useState(false);
  const { tour, phase } = run;
  const hole = phase === 'step' && rect ? { x: rect.x - PAD, y: rect.y - PAD, w: rect.w + PAD * 2, h: rect.h + PAD * 2 } : null;

  // The intro and the end take the keyboard (their buttons); during a step the page keeps it.
  useEffect(() => {
    if (phase === 'intro' || phase === 'done') box.current?.querySelector('button.primary')?.focus();
  }, [phase]);
  // Tab stays in the walkthrough's box (and the lit-up control, which is part of the step).
  const onKeyDown = (e) => {
    // Enter and Space press the box's own buttons; they must not also reach the page's shortcuts.
    if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.current.querySelectorAll('button:not([disabled])')];
    const lit = target ? findTarget(target) : null;
    if (lit && lit.tabIndex >= 0) items.push(lit);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
  };

  // Where the box goes: under the target, else above it, else beside it; bottom-centre when there's no target.
  const W = 360;
  let style;
  if (hole && phase === 'step') {
    const vw = window.innerWidth; const vh = window.innerHeight;
    const below = vh - (hole.y + hole.h);
    const left = Math.min(Math.max(12, hole.x + hole.w / 2 - W / 2), vw - W - 12);
    if (below > 230) style = { top: hole.y + hole.h + 12, left };
    else if (hole.y > 230) style = { top: Math.max(12, hole.y - 12), left, transform: 'translateY(-100%)' };
    else style = { top: Math.min(Math.max(12, hole.y), vh - 240), left: hole.x + hole.w + W + 24 < vw ? hole.x + hole.w + 12 : Math.max(12, hole.x - W - 12) };
  }
  useEffect(() => {
    const on = () => { setNudge(true); setTimeout(() => setNudge(false), 500); };
    window.addEventListener('dm:tour-nudge', on);
    return () => window.removeEventListener('dm:tour-nudge', on);
  }, []);
  const ctx = run.ctx;
  const training = !!tour.patient && !run.onReal;
  const keys = (exp?.k === 'key' ? [exp.key] : []).map(keyLabel);
  const total = tour.steps.length;

  return (
    <>
      <div className="tour-layer" aria-hidden="true">
        {hole ? (
          <>
            <div className="tour-dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.y) }} />
            <div className="tour-dim" style={{ top: hole.y + hole.h, left: 0, right: 0, bottom: 0 }} />
            <div className="tour-dim" style={{ top: hole.y, left: 0, width: Math.max(0, hole.x), height: hole.h }} />
            <div className="tour-dim" style={{ top: hole.y, left: hole.x + hole.w, right: 0, height: hole.h }} />
            <div className="tour-ring" style={{ top: hole.y, left: hole.x, width: hole.w, height: hole.h }} />
          </>
        ) : <div className={`tour-dim tour-dim-all${phase === 'step' ? ' light' : ''}`} />}
      </div>
      <div
        ref={box} className={`tour-callout${hole ? '' : ' center'}${nudge ? ' nudge' : ''}${phase !== 'step' ? ' wide' : ''}`} style={style}
        role="dialog" aria-modal="false" aria-labelledby="tour-title" onKeyDown={onKeyDown} data-tour-status={run.status} data-tour-phase={phase}
      >
        <div className="tour-head">
          <GraduationCap size={16} aria-hidden />
          <strong id="tour-title">{phase === 'intro' || phase === 'preparing' ? 'Show me' : tour.title}</strong>
          {phase === 'step' && <span className="tour-count">Step {run.step + 1} of {total}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="tour-x" onClick={onExit} aria-label="Exit the walkthrough (Esc)" title="Exit (Esc)"><X size={16} /></button>
        </div>

        {(phase === 'intro' || phase === 'preparing') && (
          <div className="tour-body">
            <h2 className="tour-q">{tour.q}</h2>
            {tour.what && <p className="muted">{tour.what}</p>}
            <p className="tour-meta">{total} step{total === 1 ? '' : 's'} · you do each one (or press <strong>Show me</strong> and watch it done) · <kbd>Esc</kbd> stops</p>
            {tour.patient ? (
              <>
                <p className="tour-note ok">Practise on <strong>Tess Training</strong>, the pretend patient: nothing leaves the office — no texts, claims, card charges or prescriptions — and nothing counts in reports.</p>
                <div className="tour-actions">
                  <button type="button" className="primary" disabled={phase === 'preparing'} onClick={() => onBegin(false)}>{phase === 'preparing' ? 'Getting Tess ready…' : 'Start on Tess Training'}</button>
                  {run.realPatient && !tour.needs?.length && (
                    <button type="button" disabled={phase === 'preparing'} onClick={() => onBegin(true)}>Use {run.realPatient.first_name ? `${run.realPatient.first_name} ${run.realPatient.last_name}` : 'the patient I’m on'} (real)</button>
                  )}
                </div>
                {run.realPatient && !tour.needs?.length && <p className="tour-note warn small">On a real patient the steps really happen — texts are sent, claims go out, payments post.</p>}
              </>
            ) : (
              <>
                {tour.effects === 'office' && <p className="tour-note warn">This one works on your office’s real screens: what you do really happens. Press <strong>Skip</strong> on a step to read along without doing it.</p>}
                <div className="tour-actions"><button type="button" className="primary" disabled={phase === 'preparing'} onClick={() => onBegin(false)}>{phase === 'preparing' ? 'Starting…' : 'Start'}</button></div>
              </>
            )}
            {run.queueTitle && <p className="muted small">Part of {run.queueTitle}{run.queue.length ? ` · ${run.queue.length} more after this` : ''}</p>}
          </div>
        )}

        {phase === 'step' && step && (
          <div className="tour-body">
            <p className="tour-text" aria-live="polite" aria-atomic="true">{fill(step.text, ctx)}</p>
            {run.status === 'missing' ? (
              <div className="tour-missing" role="alert">
                <AlertTriangle size={16} aria-hidden /> I can’t find {target?.label ? <>“{target.label}”</> : 'this'} on the screen. It may be further down, behind a tab, or not open yet.
                <div className="tour-actions">
                  <button type="button" onClick={onRetry}>Look again</button>
                  <button type="button" onClick={onSkip}><SkipForward size={14} aria-hidden /> Skip this step</button>
                  <button type="button" onClick={onExit}>Exit</button>
                </div>
              </div>
            ) : (
              <p className="tour-do">
                {exp?.k === 'key' && <>Press {keys.map((k, i) => <span key={i} className="tour-kbd">{k.map((x) => <kbd key={x}>{x}</kbd>)}</span>)}</>}
                {exp?.k === 'click' && <>Click {target?.label ? <strong>{target.label}</strong> : 'the highlighted spot'}</>}
                {exp?.k === 'type' && <>Type {exp.text ? <strong>“{fill(exp.text, ctx)}”</strong> : 'here'}{target?.label ? ` in ${target.label}` : ''}</>}
                {exp?.k === 'select' && (exp.any ? <>Choose one from the list</> : <>Choose <strong>{fill(exp.text || exp.value, ctx)}</strong></>)}
                {!exp && 'Read this, then press Next.'}
                {step.expect.length > 1 && <span className="muted"> · part {run.sub + 1} of {step.expect.length}</span>}
              </p>
            )}
            <p className={`tour-note ${training ? 'ok' : tour.patient || tour.effects === 'office' ? 'warn' : ''} small`}>
              {training ? <>Tess Training — practice only, nothing leaves the office.</> : tour.patient ? <>Real patient: this really happens.</> : tour.effects === 'office' ? <>Your real office: this really happens.</> : <>Nothing here changes any records.</>}
            </p>
            <div className="tour-actions">
              <button type="button" onClick={onBack} disabled={run.step === 0}><ArrowLeft size={14} aria-hidden /> Back</button>
              <button type="button" className="primary" onClick={onShowMe} title="Do this step for me (Alt+Shift+→)"><Wand2 size={14} aria-hidden /> Show me</button>
              <button type="button" onClick={onSkip} title="Skip to the next step"><SkipForward size={14} aria-hidden /> {exp ? 'Skip' : 'Next'}</button>
            </div>
            <div className="tour-progress" aria-hidden="true"><span style={{ width: `${Math.round(((run.step + (run.status === 'settling' ? 1 : 0)) / total) * 100)}%` }} /></div>
            <p className="tour-help muted">Esc stops · Alt+Shift+→ show me · Alt+Shift+← back · Alt+Shift+↓ these buttons</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="tour-body">
            <p className="tour-done" role="status"><CheckCircle2 size={20} aria-hidden /> Done — that’s how to {tour.q.replace(/^How do I /, '').replace(/\?$/, '')}.</p>
            {run.shown > 0 && <p className="muted small">You watched {run.shown} of the {total} steps. Try it again and do them yourself when you’re ready.</p>}
            <div className="tour-actions">
              {onNext ? <button type="button" className="primary" onClick={onNext}>Next walkthrough ({run.queue.length} left)</button> : <button type="button" className="primary" onClick={onExit}>Close</button>}
              {onNext && <button type="button" onClick={onExit}>Stop for now</button>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
