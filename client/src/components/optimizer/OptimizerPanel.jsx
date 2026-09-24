import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Target, X, Sparkles, Stethoscope, Users, CalendarPlus, Scissors, ShieldCheck, Undo2, ChevronDown, ChevronRight, MessageSquare, Check, Clock } from 'lucide-react';
import { api } from '../../api.js';
import { money, fmtTime } from '../../format.js';
import { toast } from '../../toast.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts, typingIn } from '../../shortcuts.js';
import { useOptimizer, ACTION_LABEL, KIND_LABEL } from './useOptimizer.js';
import './optimizer.css';

// Today's schedule optimizer (OPT, docs/workflows/specs/OPT-optimizer.md): a slim side panel beside the schedule
// or the huddle. Each provider's progress to goal and what the plan adds; then every opportunity as a card with its
// $ and one action — the plan's moves first. Nothing happens without a click (or Enter): each action goes through
// the same endpoints as doing it by hand, shows at once, and can be undone from the toast.
// Keys while it's open: J / K (or ↓ ↑) move between cards, Enter does the card's action, D "not today", Esc closes.
const KIND_ICON = { treatment: Stethoscope, finder: Sparkles, family: Users, fill: CalendarPlus, shorten: Scissors, confirm: ShieldCheck };
const whole = (c) => (c == null ? '' : money(c).replace(/\.00$/, ''));
// Undo from a toast: errors show as a red toast rather than vanishing.
const safely = (fn) => async () => { try { await fn(); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); } };
const span = (o) => (o.start_time ? `${fmtTime(o.start_time)}${o.end_time ? `–${fmtTime(o.end_time)}` : ''}` : '');

export function ProviderProgress({ p, money: showMoney, compact = false }) {
  const pct = p.pct ?? 0;
  const after = p.plan?.pct ?? pct;
  const open = p.open_minutes >= 60 ? `${Math.floor(p.open_minutes / 60)}h${p.open_minutes % 60 ? ` ${p.open_minutes % 60}m` : ''}` : `${p.open_minutes} min`;
  return (
    <div className={`opt-prov${compact ? ' compact' : ''}`}>
      <div className="opt-prov-line">
        <span className="opt-dot" style={{ background: p.color || 'var(--primary)' }} />
        <strong>{p.name}</strong>
        {showMoney && p.goal ? <span className="opt-prov-pct">{pct}%{p.plan?.moves?.length ? <> → <b className={after >= 100 ? 'ok' : ''}>{after}%</b></> : null}</span> : null}
      </div>
      {showMoney && p.goal ? (
        <div className="opt-bar" role="img" aria-label={`${pct}% of goal booked${p.plan?.moves?.length ? `, ${after}% with the plan` : ''}`}>
          <i className="now" style={{ width: `${Math.min(100, pct)}%` }} />
          {after > pct && <i className="plan" style={{ left: `${Math.min(100, pct)}%`, width: `${Math.max(0, Math.min(100, after) - Math.min(100, pct))}%` }} />}
        </div>
      ) : null}
      <div className="opt-prov-sub">
        {p.plan?.headline || (showMoney ? '' : `${p.name}`)}
        {!compact && <span> · open {open}{p.blocks?.length ? ` · ${p.blocks.map((b) => b.label).join(', ')} still open` : ''}</span>}
      </div>
    </div>
  );
}

function Card({ o, active, onFocus, onAct, onDecline, busy, refCb, showMoney, aiWhy }) {
  const Icon = KIND_ICON[o.kind] || Target;
  return (
    <li className={`opt-card k-${o.kind}${o.in_plan ? ' in-plan' : ''}${active ? ' active' : ''}${busy ? ' busy' : ''}`} tabIndex={-1} ref={refCb} onFocus={onFocus} onClick={onFocus} aria-current={active ? 'true' : undefined} data-opt-id={o.id}>
      <div className="opt-card-top">
        <span className="opt-kind" title={KIND_LABEL[o.kind]}><Icon size={14} strokeWidth={2.2} /></span>
        <div className="opt-card-main">
          <div className="opt-card-title">{o.title}</div>
          {o.detail && <div className="opt-card-why">{o.detail}</div>}
          {aiWhy && <div className="opt-card-ai"><Sparkles size={11} /> <span className="opt-ai-tag">AI</span> {aiWhy}</div>}
          <div className="opt-card-meta">
            {o.start_time && <span><Clock size={11} /> {span(o)}</span>}
            {o.provider && <span>{o.provider}</span>}
            {o.minutes ? <span>{o.minutes} min</span> : null}
            {o.needs_reply && <span className="opt-reply">if they say yes</span>}
          </div>
        </div>
        {showMoney && (o.fee || o.at_risk) ? (
          <div className="opt-card-money">
            {o.kind === 'confirm' ? <><b>{whole(o.at_risk)}</b><small>booked</small></> : <><b>+{whole(o.fee)}</b>{o.collectible != null && o.collectible !== o.fee ? <small>≈ {whole(o.collectible)} collected</small> : null}</>}
          </div>
        ) : null}
      </div>
      {o.fits ? (
        <div className="opt-card-actions">
          <button className="small primary" disabled={busy} onClick={(e) => { e.stopPropagation(); onAct(o); }}>{ACTION_LABEL[o.action] || 'Do it'}{active && <kbd>Enter</kbd>}</button>
          {o.alt_actions.map((a, i) => <button key={a} className="small" disabled={busy} onClick={(e) => { e.stopPropagation(); onAct(o, i); }}>{ACTION_LABEL[a] || a}</button>)}
          <button className="small link opt-not" disabled={busy} onClick={(e) => { e.stopPropagation(); onDecline(o); }}>Not today{active && <kbd>D</kbd>}</button>
        </div>
      ) : <div className="opt-card-why opt-no">Doesn’t fit: {o.why_not}</div>}
    </li>
  );
}

export default function OptimizerPanel({ date, locationId = null, onClose, focusId = null }) {
  const { can } = useAuth() || {};
  const opt = useOptimizer(date, locationId);
  const d = opt.data;
  const [pending, setPending] = useState({}); // id → 'acting' | 'gone' (optimistic)
  const [cursor, setCursor] = useState(0);
  const [showNoFit, setShowNoFit] = useState(false);
  const refs = useRef(new Map());
  const panel = useRef(null);
  const write = can?.('schedule:write');

  const sections = useMemo(() => {
    if (!d) return [];
    const live = (o) => pending[o.id] !== 'gone';
    const fits = d.opportunities.filter((o) => o.fits && live(o));
    return [
      { key: 'plan', title: d.plan.moves ? 'The plan' : null, items: fits.filter((o) => o.in_plan) },
      { key: 'more', title: 'More ideas', items: fits.filter((o) => !o.in_plan) },
      { key: 'protect', title: 'Protect what’s booked', items: d.protect.filter((o) => o.fits && live(o)) },
    ].filter((s) => s.items.length);
  }, [d, pending]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const current = flat[Math.min(cursor, flat.length - 1)] || null;

  // Opened on one card (a marker on the schedule): start there.
  useEffect(() => {
    if (!focusId || !flat.length) return;
    const i = flat.findIndex((o) => o.id === focusId);
    if (i >= 0) setCursor(i);
  }, [focusId, flat.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (current) refs.current.get(current.id)?.focus({ preventScroll: false });
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (o, alt = null) => {
    if (!write) return toast('You can see the plan but not book or change visits', { tone: 'error' });
    setPending((p) => ({ ...p, [o.id]: 'gone' }));
    try {
      const r = await api.post(`/optimizer/${o.id}/act`, alt == null ? {} : { alt });
      const type = alt == null ? o.action : o.alt_actions[alt];
      const said = { text_offer: 'Offer texted — their YES books it', text: 'Text sent', confirm: 'Reminder sent', shorten: 'Visit shortened', book: 'Booked', move_up: 'Visit moved up', attach: 'Added to the visit', finder_add: 'Added to the visit' }[type] || 'Done';
      const canUndo = !['text_offer', 'text', 'confirm'].includes(type) && !r.already;
      toast(`${said}${o.fee && d?.money && !['confirm', 'shorten'].includes(o.kind) ? ` · +${whole(o.fee)}` : ''}`, {
        undo: canUndo ? safely(async () => { await api.post(`/optimizer/${o.id}/undo`); toast('Undone'); opt.reload(); }) : null,
      });
    } catch (e) {
      toast(e.message || 'That didn’t work', { tone: 'error' });
      setPending((p) => { const n = { ...p }; delete n[o.id]; return n; });
    }
    opt.reload();
  }, [write, d?.money]); // eslint-disable-line react-hooks/exhaustive-deps

  const decline = useCallback(async (o) => {
    if (!write) return;
    setPending((p) => ({ ...p, [o.id]: 'gone' }));
    try {
      await api.post(`/optimizer/${o.id}/decline`, {});
      toast('Hidden for today', { undo: safely(async () => { await api.post(`/optimizer/${o.id}/restore`); setPending((p) => { const n = { ...p }; delete n[o.id]; return n; }); opt.reload(); }) });
    } catch (e) {
      toast(e.message, { tone: 'error' });
      setPending((p) => { const n = { ...p }; delete n[o.id]; return n; });
    }
    opt.reload();
  }, [write]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel's own keys, ahead of the screen underneath (the schedule's D is "day view"; here it's "not today").
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || document.querySelector('.modal, .palette')) return;
      const k = e.key;
      if (k === 'Escape') onClose?.();
      else if (k === 'j' || k === 'ArrowDown') setCursor((c) => Math.min(flat.length - 1, c + 1));
      else if (k === 'k' || k === 'ArrowUp') setCursor((c) => Math.max(0, c - 1));
      else if (k === 'Enter' && current?.fits && !e.target.closest?.('button, a')) act(current);
      else if ((k === 'd' || k === 'D') && current?.fits) decline(current);
      else return;
      e.preventDefault(); // the screen underneath sees defaultPrevented and leaves the key alone
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flat, current, act, decline, onClose]);

  const noFit = d ? d.opportunities.filter((o) => !o.fits) : [];
  const showMoney = !!d?.money;
  const rankedById = new Map((opt.ai?.ranked || []).map((r) => [r.id, r]));
  return (
    <aside className="opt-panel" ref={panel} aria-label="Today’s plan">
      <div className="opt-head">
        <div>
          <h2><Target size={18} /> Today’s plan</h2>
          <div className="muted opt-date">{new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} · <kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> do it · <kbd>D</kbd> not today</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close the plan (Esc)"><X size={16} /></button>
      </div>
      <div className="opt-body">
        {opt.error && !opt.missing && <div className="error">{opt.error.message}</div>}
        {opt.missing && <div className="muted">The schedule optimizer isn’t switched on for this server yet.</div>}
        {!d && !opt.error && <div className="muted opt-loading">Working out today’s plan…</div>}
        {d && (
          <>
            <div className="opt-headline">{d.plan.headline}</div>
            <div className="opt-provs">
              {d.providers.filter((p) => p.goal || p.plan?.moves?.length || p.open_minutes).map((p) => <ProviderProgress key={p.provider_id} p={p} money={showMoney} />)}
            </div>
            {d.ai_available && (
              <div className="opt-ai">
                {!opt.ai && <button className="small" onClick={opt.explain}><Sparkles size={13} /> Explain with AI</button>}
                {opt.ai?.loading && <span className="muted">Asking the AI…</span>}
                {opt.ai && !opt.ai.loading && (
                  <div className="opt-ai-note">
                    <div className="opt-ai-label"><Sparkles size={12} /> Written by {opt.ai.label}{opt.ai.sandbox ? '' : ' — from the list below only'}</div>
                    {opt.ai.summary && <p>{opt.ai.summary}</p>}
                  </div>
                )}
                {opt.aiError && <div className="error">{opt.aiError}</div>}
              </div>
            )}
            {!flat.length && <div className="opt-empty"><Check size={16} /> Nothing to do right now{d.plan.moves ? '' : ' — the day is set'}.</div>}
            {sections.map((s) => (
              <section key={s.key} className="opt-section">
                {s.title && <h3>{s.title}{s.key === 'plan' && showMoney && d.plan.added ? <span> +{whole(d.plan.added)}</span> : null}</h3>}
                <ul className="opt-list">
                  {s.items.map((o) => (
                    <Card key={o.id || o.key} o={o} showMoney={showMoney} aiWhy={rankedById.get(o.id)?.why} active={current?.id === o.id} busy={pending[o.id] === 'acting'}
                      onFocus={() => setCursor(flat.indexOf(o))} onAct={act} onDecline={decline}
                      refCb={(el) => (el ? refs.current.set(o.id, el) : refs.current.delete(o.id))} />
                  ))}
                </ul>
              </section>
            ))}
            {d.working.length > 0 && (
              <section className="opt-section">
                <h3><MessageSquare size={13} /> Waiting on a reply</h3>
                <ul className="opt-mini">{d.working.map((w) => <li key={w.id}>{w.title}</li>)}</ul>
              </section>
            )}
            {d.done.length > 0 && (
              <section className="opt-section">
                <h3><Check size={13} /> Done today{showMoney && d.captured ? <span> +{whole(d.captured)}</span> : null}</h3>
                <ul className="opt-mini">
                  {d.done.map((x) => (
                    <li key={x.id}>
                      <span>{x.title}</span>
                      {x.undoable && write && <button className="link small" onClick={async () => { try { await api.post(`/optimizer/${x.id}/undo`); toast('Undone'); } catch (e) { toast(e.message, { tone: 'error' }); } opt.reload(); }}><Undo2 size={12} /> Undo</button>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {noFit.length > 0 && (
              <section className="opt-section">
                <button className="link opt-toggle" onClick={() => setShowNoFit(!showNoFit)} aria-expanded={showNoFit}>
                  {showNoFit ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {noFit.length} {noFit.length === 1 ? 'idea doesn’t' : 'ideas don’t'} fit today
                </button>
                {showNoFit && <ul className="opt-mini muted">{noFit.map((o) => <li key={o.key}><span>{o.title}</span><small>{o.why_not}</small></li>)}</ul>}
              </section>
            )}
            {d.declined.length > 0 && <div className="muted opt-foot">{d.declined.length} marked “not today”.</div>}
          </>
        )}
      </div>
    </aside>
  );
}

// The panel with its button and the O key, for any screen (the schedule mounts this one line).
export function OptimizerLauncher({ date, locationId = null, button = true }) {
  const { can } = useAuth() || {};
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const opt = useOptimizer(date, locationId, { enabled: !!can?.('schedule:read') });
  useShortcuts([{ combo: 'o', handler: () => setOpen((v) => !v), label: 'Open today’s plan (schedule optimizer)', section: 'Schedule', enabled: !!can?.('schedule:read') && !opt.missing }]);
  useEffect(() => {
    const on = (e) => { setFocusId(e.detail?.id ?? null); setOpen(true); };
    window.addEventListener('dm:optimizer', on);
    return () => window.removeEventListener('dm:optimizer', on);
  }, []);
  if (!can?.('schedule:read') || opt.missing) return null;
  const moves = opt.data?.plan?.moves;
  return (
    <>
      {button && (
        <button className={`icon-btn wide opt-launch${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title="Today’s plan (O)">
          <Target size={16} /> Plan{moves ? <span className="opt-count">{moves}</span> : null}
        </button>
      )}
      {open && <OptimizerPanel date={date} locationId={locationId} focusId={focusId} onClose={() => setOpen(false)} />}
    </>
  );
}
