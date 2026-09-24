import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCheck, Target, CalendarPlus, TrendingUp, Lock, LockOpen } from 'lucide-react';
import { api } from '../../api.js';
import { money, label } from '../../format.js';
import './production.css';

// Production on the schedule (S5): the numbers come from GET /schedule/production (server/src/production.js),
// the one calculation shared with reports and the huddle. This file only shows them.

export const KINDS = ['all', 'doctor', 'hygiene'];
export const KIND_LABEL = { all: 'All', doctor: 'Doctor', hygiene: 'Hygiene' };
export const dollars = (cents) => (cents == null ? '—' : money(cents).replace(/\.00$/, ''));
const CATEGORY = {
  diagnostic: 'Exams & x-rays', preventive: 'Cleanings', restorative: 'Fillings', endodontics: 'Root canals', periodontics: 'Gum care',
  prosthodontics: 'Crowns & bridges', oral_surgery: 'Extractions & surgery', orthodontics: 'Orthodontics', implants: 'Implants', adjunctive: 'Other',
};
export const categoryLabel = (k) => CATEGORY[k] || label(k);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

// ---- Data: one request per day/week, kind and office; kept so switching back is instant, and refreshed
// (a moment later, so a burst of changes is one request) whenever the schedule's own data changes. ----
const cache = new Map();
export function useProduction({ date, days = 1, kind = 'all', office = '', version, enabled = true }) {
  const key = `${date}|${days}|${kind}|${office || ''}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [state, setState] = useState(() => cache.get(key) || null);
  useEffect(() => { setState(cache.get(key) || null); }, [key]);
  useEffect(() => {
    if (!enabled || !date) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/schedule/production?date=${date}&days=${days}&kind=${kind}${office ? `&location_id=${office}` : ''}`)
        .then((d) => {
          cache.set(key, d);
          if (alive && keyRef.current === key) setState(d);
        })
        // Production is extra: without it the schedule shows what it always did (visit counts).
        .catch(() => { if (alive && keyRef.current === key && !cache.has(key)) setState(null); });
    }, cache.has(key) ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [key, version, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Adds up days (the week's total) or narrows to one provider. Buckets: { scheduled, completed, goal, visits, … }.
const addInto = (to, from) => {
  for (const k of ['scheduled', 'completed', 'goal', 'visits']) if (from?.[k] != null) to[k] = (to[k] || 0) + from[k];
};
export function summarize(days, providerId = null) {
  const out = { scheduled: 0, completed: 0, goal: 0, visits: 0, providers: {}, categories: {}, blocks: [] };
  for (const d of days || []) {
    const src = providerId ? d.providers[providerId] : d;
    if (!src) continue;
    addInto(out, src);
    for (const [c, v] of Object.entries(src.categories || {})) addInto((out.categories[c] ||= {}), v);
    if (!providerId) for (const [id, v] of Object.entries(d.providers || {})) addInto((out.providers[id] ||= { name: v.name, color: v.color, kind: v.kind }), v);
    out.blocks.push(...(d.blocks || []).filter((b) => !providerId || b.provider_id === Number(providerId)));
  }
  return out;
}

// ---- Hover / focus popover: opens on a short hover or keyboard focus, closes on leave, blur or Esc. ----
function useHoverPop() {
  const [anchor, setAnchor] = useState(null);
  const timer = useRef(null);
  const over = useRef(false);
  const close = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (!over.current) setAnchor(null); }, 120); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pointer = useRef('');
  const anchorProps = {
    onPointerEnter: (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.currentTarget;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setAnchor(el.getBoundingClientRect()), 180);
    },
    onPointerLeave: close,
    onPointerDown: (e) => { pointer.current = e.pointerType; },
    // From the keyboard (Tab), focus opens it; a mouse already has hover.
    onFocus: (e) => { if (e.currentTarget.matches(':focus-visible')) setAnchor(e.currentTarget.getBoundingClientRect()); },
    onBlur: close,
    onKeyDown: (e) => { if (e.key === 'Escape' && anchor) { e.stopPropagation(); setAnchor(null); } },
    // A tap on a tablet toggles it.
    onClick: (e) => {
      if (pointer.current === 'mouse') return;
      const r = e.currentTarget.getBoundingClientRect();
      setAnchor((a) => (a ? null : r));
    },
  };
  const popProps = { onPointerEnter: () => { over.current = true; }, onPointerLeave: () => { over.current = false; close(); } };
  return { anchor, anchorProps, popProps };
}

function Popover({ anchor, popProps, children, label: aria }) {
  const box = useRef(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 8 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - w - 12));
    const below = anchor.bottom + 8 + h < window.innerHeight - 8;
    setPos({ left, top: below ? anchor.bottom + 8 : Math.max(8, anchor.top - h - 8) });
  }, [anchor]);
  return createPortal(
    <div ref={box} className="prod-pop" role="tooltip" aria-label={aria} style={pos} {...popProps}>{children}</div>,
    document.body,
  );
}

const Meter = ({ scheduled, completed, goal, slim = false }) => {
  const base = Math.max(goal || 0, scheduled || 0, 1);
  const met = goal > 0 && scheduled >= goal;
  return (
    <span className={`prod-track${slim ? ' slim' : ''}${met ? ' met' : ''}`} aria-hidden="true">
      <i className="sched" style={{ width: `${Math.min(100, (scheduled / base) * 100)}%` }} />
      <i className="done" style={{ width: `${Math.min(100, (completed / base) * 100)}%` }} />
      {goal > 0 && scheduled > goal && <b className="goal-mark" style={{ left: `${(goal / base) * 100}%` }} />}
    </span>
  );
};

// What's behind a number: by provider, by kind of work, the day's blocks and what's still to book.
export function Breakdown({ title, sum, providers, categories, blocks, unscheduled, now }) {
  const provRows = Object.entries(providers || {}).filter(([, v]) => v.scheduled || v.completed || v.goal).sort((a, b) => (b[1].scheduled || 0) - (a[1].scheduled || 0));
  const catRows = Object.entries(categories || {}).filter(([, v]) => v.scheduled || v.completed).sort((a, b) => (b[1].scheduled || 0) - (a[1].scheduled || 0));
  const p = pct(sum.scheduled, sum.goal);
  return (
    <div className="prod-breakdown">
      <div className="pb-head">
        <strong>{title}</strong>
        {p != null && <span className={`pb-pct${p >= 100 ? ' met' : ''}`}>{p}% of goal</span>}
      </div>
      <div className="pb-totals">
        <span><em>Scheduled</em>{dollars(sum.scheduled)}</span>
        <span><em>Completed</em>{dollars(sum.completed)}</span>
        <span><em>Goal</em>{sum.goal ? dollars(sum.goal) : 'Not set'}</span>
      </div>
      {provRows.length > 0 && (
        <section>
          <h4>By provider</h4>
          {provRows.map(([id, v]) => (
            <div key={id} className="pb-row">
              <i className="pb-dot" style={{ background: v.color || 'var(--faint)' }} />
              <span className="pb-name">{v.name}</span>
              <span className="pb-num">{dollars(v.scheduled)}</span>
              <span className="pb-sub">{v.completed ? `${dollars(v.completed)} done` : ''}{v.goal ? `${v.completed ? ' · ' : ''}${pct(v.scheduled, v.goal)}% of ${dollars(v.goal)}` : ''}</span>
            </div>
          ))}
        </section>
      )}
      {catRows.length > 0 && (
        <section>
          <h4>By kind of work</h4>
          {catRows.map(([c, v]) => (
            <div key={c} className="pb-row">
              <span className="pb-name">{categoryLabel(c)}</span>
              <span className="pb-num">{dollars(v.scheduled)}</span>
              <span className="pb-sub">{v.completed ? `${dollars(v.completed)} done` : ''}</span>
              <span className="pb-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, ((v.scheduled || 0) / Math.max(1, sum.scheduled)) * 100)}%` }} /></span>
            </div>
          ))}
        </section>
      )}
      {blocks?.length > 0 && (
        <section>
          <h4>Blocks</h4>
          {blocks.map((b) => (
            <div key={`${b.id}-${b.start_time}`} className="pb-row">
              <span className="pb-name">{b.type_names?.length ? (now && now >= b.release_at ? <LockOpen size={11} aria-label="Open to any visit now" /> : <Lock size={11} aria-label={`Kept for ${b.type_names.join(', ')}`} />) : null} {b.label} <span className="muted">{b.start_time.slice(11)}–{b.end_time.slice(11)}</span></span>
              <span className="pb-num">{dollars(b.scheduled)}</span>
              <span className="pb-sub">{b.goal ? `of ${dollars(b.goal)}` : ''}</span>
            </div>
          ))}
        </section>
      )}
      {unscheduled && unscheduled.amount != null && (
        <section className="pb-unsched">
          <h4>Treatment still to book</h4>
          <div className="pb-row"><span className="pb-name">{unscheduled.patients} patient{unscheduled.patients === 1 ? '' : 's'}, {unscheduled.procedures} procedure{unscheduled.procedures === 1 ? '' : 's'}</span><span className="pb-num">{dollars(unscheduled.amount)}</span></div>
          {Object.entries(unscheduled.categories || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, v]) => (
            <div key={c} className="pb-row minor"><span className="pb-name">{categoryLabel(c)}</span><span className="pb-num">{dollars(v)}</span></div>
          ))}
        </section>
      )}
    </div>
  );
}

// ---- The day's (or week's) total, always at the top of the schedule ----
export function ProductionBar({ title, sum, unscheduled, kind, onKind, now, showKinds = true }) {
  const figures = useHoverPop();
  const todo = useHoverPop();
  const p = pct(sum.scheduled, sum.goal);
  const gap = sum.goal ? sum.goal - sum.scheduled : null;
  return (
    <section className="prod-bar" aria-label="Production">
      <div className="prod-figures" tabIndex={0} {...figures.anchorProps} aria-label={`${title}: scheduled ${dollars(sum.scheduled)}, completed ${dollars(sum.completed)}${sum.goal ? `, goal ${dollars(sum.goal)}, ${p}% of goal` : ''}`}>
        <span className="prod-icon" aria-hidden="true"><TrendingUp size={16} /></span>
        <span className="prod-title"><strong>{title}</strong><span>{kind && kind !== 'all' ? `${KIND_LABEL[kind]} production` : 'Production'}</span></span>
        <span className="prod-fig lead"><em>Scheduled</em><strong>{dollars(sum.scheduled)}</strong></span>
        <span className="prod-fig done"><em><CheckCheck size={12} /> Completed</em><strong>{dollars(sum.completed)}</strong></span>
        <span className="prod-fig"><em><Target size={12} /> Goal</em><strong>{sum.goal ? dollars(sum.goal) : <span className="muted">Not set</span>}</strong></span>
        <span className="prod-meter">
          <span className="prod-meter-top">
            {p != null ? <b className={`prod-pct${p >= 100 ? ' met' : ''}`}>{p}%</b> : <b className="prod-pct none">—</b>}
            <span className="muted">{gap == null ? 'no goal set' : gap > 0 ? `${dollars(gap)} to go` : `goal met${gap < 0 ? ` · +${dollars(-gap)}` : ''}`}</span>
          </span>
          <Meter scheduled={sum.scheduled} completed={sum.completed} goal={sum.goal} />
        </span>
      </div>
      <div className="prod-side">
        {unscheduled?.amount != null && unscheduled.amount > 0 && (
          <span className="prod-todo" tabIndex={0} {...todo.anchorProps} aria-label={`Treatment still to book: ${dollars(unscheduled.amount)} for ${unscheduled.patients} patients`}>
            <CalendarPlus size={14} /> <strong>{dollars(unscheduled.amount)}</strong> <span className="muted">to book</span>
          </span>
        )}
        {showKinds && (
          <div className="seg prod-kind" role="radiogroup" aria-label="Production for" title="Doctor / Hygiene / All ($)">
            {['doctor', 'hygiene', 'all'].map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'active' : ''} onClick={() => onKind(k)}>{KIND_LABEL[k]}</button>
            ))}
          </div>
        )}
      </div>
      {figures.anchor && (
        <Popover anchor={figures.anchor} popProps={figures.popProps} label={`${title} breakdown`}>
          <Breakdown title={title} sum={sum} providers={sum.providers} categories={sum.categories} blocks={sum.blocks} unscheduled={unscheduled} now={now} />
        </Popover>
      )}
      {todo.anchor && (
        <Popover anchor={todo.anchor} popProps={todo.popProps} label="Treatment still to book">
          <Breakdown title="Treatment still to book" sum={{ scheduled: unscheduled.amount, completed: 0, goal: 0 }} unscheduled={unscheduled} />
        </Popover>
      )}
    </section>
  );
}

// ---- One column's numbers, in its heading ----
export function ColumnProduction({ title, prod, now }) {
  const pop = useHoverPop();
  if (prod.off) return <span className="col-prod off" title={`Not counted in ${KIND_LABEL[prod.kind]} production`}>{prod.visits} visit{prod.visits === 1 ? '' : 's'}</span>;
  const p = pct(prod.scheduled, prod.goal);
  return (
    <>
      <span className="col-prod" tabIndex={0} {...pop.anchorProps} onPointerDown={(e) => { e.stopPropagation(); pop.anchorProps.onPointerDown(e); }} draggable={false} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        aria-label={`${title}: ${dollars(prod.scheduled)} scheduled, ${dollars(prod.completed)} completed, ${prod.visits} visits${prod.goal ? `, ${p}% of ${dollars(prod.goal)} goal` : ''}`}>
        <span className="col-prod-nums">
          <strong>{dollars(prod.scheduled)}</strong>
          {prod.completed > 0 && <span className="col-prod-done" title="Completed so far"><CheckCheck size={11} strokeWidth={2.6} />{dollars(prod.completed)}</span>}
          <span className="col-prod-visits">{prod.goal ? `${p}%` : `${prod.visits} visit${prod.visits === 1 ? '' : 's'}`}</span>
        </span>
        <Meter scheduled={prod.scheduled} completed={prod.completed} goal={prod.goal} slim />
      </span>
      {pop.anchor && (
        <Popover anchor={pop.anchor} popProps={pop.popProps} label={`${title} breakdown`}>
          <Breakdown title={title} sum={{ ...prod, goal: prod.goal || 0 }} providers={prod.providers} categories={prod.categories} blocks={prod.blocks} now={now} />
        </Popover>
      )}
    </>
  );
}
