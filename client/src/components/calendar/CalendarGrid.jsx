import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCheck, DoorOpen, Armchair, Pill, TriangleAlert, Repeat, Lock, LockOpen, Hourglass } from 'lucide-react';
import { eligibilityBadge } from '../../format.js';
import PatientHoverCard from './PatientHoverCard.jsx';
import { ColumnProduction, dollars } from './ProductionBar.jsx';
import { lateness, waitLabel } from './late.js';
import './late.css';
import { nextKind, NEXT_LABEL, READY_LABEL, READY_SHORT } from './flow.js';
import './workflow.css';

export const toMin = (t) => Number(t.slice(-5, -3)) * 60 + Number(t.slice(-2));
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const label12 = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`;
const STATUS_ICON = { confirmed: [Check, 'Confirmed'], checked_in: [DoorOpen, 'Checked in'], in_chair: [Armchair, 'In the chair'], completed: [CheckCheck, 'Completed'] };
const hourLabel = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1} ${m < 720 ? 'AM' : 'PM'}`;
const clock = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;
const initialsOf = (name = '') => name.replace(/^(dr\.?|drs\.?)\s+/i, '').split(/[\s,]+/).filter((w) => w && !/^(dds|dmd|rdh|md|phd|jr|sr)\.?$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// Side-by-side lanes for overlapping events within one column.
function layoutLanes(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster) {
      let lane = lanes.findIndex((end) => end <= it.s);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = it.e;
      it.lane = lane;
    }
    for (const it of cluster) out.push({ ...it, lanes: lanes.length });
    cluster = [];
  };
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

/**
 * Time-grid calendar with pointer drag-to-move, resize, drag-to-create and tap-to-place.
 * columns: [{ key, label, sub, date, hours, isToday, accepts(appt) -> bool, blockouts: [] , assign: {date, provider_id?, operatory_id?} }]
 * Optional per column: prod ({ scheduled, completed, goal, visits, … } shown in the heading with its breakdown, or
 * { off, kind, visits } when the column isn't in the kind of production shown) and lanes (perfect-day blocks:
 * { id, label, start_time, end_time, goal, scheduled, color, open }) drawn as tinted lanes behind the visits.
 */
// "Color by status": one color per step of the visit, the same as the legend.
export const STATUS_COLORS = { scheduled: '#64748b', confirmed: '#16a34a', checked_in: '#d97706', in_chair: '#7c3aed', completed: '#0f766e', no_show: '#dc2626', cancelled: '#94a3b8' };

export default function CalendarGrid({
  columns, appointments, range, pxPerMin, nowMin, onMove, onResize, onSelectRange, onOpen, onOpenBlockout, onPin,
  placing, onPlace, selectedId, scrollKey, headerExtra, readOnly = false, step = 10, colorBy = 'type', onReorderColumn, onFocusAppt, onNext, carry = null,
  now = null, late = null,
}) {
  const [dragCol, setDragCol] = useState(null);
  const [overCol, setOverCol] = useState(null);
  // The grid step (5, 10 or 15 minutes) is what drags and new appointments snap to.
  const SNAP = step;
  const snap = (m) => Math.round(m / SNAP) * SNAP;
  const scroller = useRef(null);
  // When someone last scrolled the grid by hand, and whether a scroll is the grid's own (keeping "now" in view).
  const userScrolled = useRef(0);
  const autoScrolling = useRef(false);
  const body = useRef(null);
  const [drag, setDrag] = useState(null); // { kind: 'move'|'resize'|'select', ... }
  const dragRef = useRef(null);
  dragRef.current = drag;
  const suppressClick = useRef(false); // a drag ends with a click event we must ignore
  const touchTap = useRef(false);
  const height = (range.end - range.start) * pxPerMin;
  const hours = useMemo(() => {
    const out = [];
    for (let m = Math.ceil(range.start / 60) * 60; m < range.end; m += 60) out.push(m);
    return out;
  }, [range]);

  // Hovering a visit (mouse only) for a moment shows the patient card; any drag or scroll hides it.
  const [hover, setHover] = useState(null);
  const hoverTimer = useRef(null);
  const hoverIn = (e, a) => {
    if (e.pointerType !== 'mouse' || dragRef.current) return;
    const el = e.currentTarget;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover({ appt: a, anchor: el.getBoundingClientRect() }), 450);
  };
  const hoverOut = () => { clearTimeout(hoverTimer.current); setHover(null); };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => { if (drag) hoverOut(); }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // While an appointment is being dragged, the pinboard shows as a drop target.
  const moving = drag?.kind === 'move' && drag.active;
  useEffect(() => {
    document.body.classList.toggle('cal-dragging', moving);
    return () => document.body.classList.remove('cal-dragging');
  }, [moving]);

  // Scroll to "now" (or opening time) when the view changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = nowMin != null && nowMin > range.start && nowMin < range.end ? nowMin - 60 : range.open ?? range.start;
    autoScrolling.current = true;
    el.scrollTop = Math.max(0, (target - range.start) * pxPerMin - 14);
    setTimeout(() => { autoScrolling.current = false; }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Today, keep the current time in view as the day goes on — unless someone scrolled in the last two minutes.
  const showsToday = columns.some((c) => c.isToday);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !showsToday || nowMin == null || nowMin < range.start || nowMin > range.end || drag || carry) return;
    if (Date.now() - userScrolled.current < 120_000) return;
    const y = (nowMin - range.start) * pxPerMin;
    const head = el.querySelector('.cal-head')?.offsetHeight || 0;
    if (y < el.scrollTop + 20 || y > el.scrollTop + el.clientHeight - head - 40) {
      autoScrolling.current = true;
      el.scrollTop = Math.max(0, y - (el.clientHeight - head) / 3);
      setTimeout(() => { autoScrolling.current = false; }, 100);
    }
  }, [nowMin, showsToday]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => {
    if (!autoScrolling.current) userScrolled.current = Date.now();
    if (hover) hoverOut();
  };

  // Keep the selected appointment in view (e.g. a new 7am visit before opening time).
  useEffect(() => {
    if (!selectedId) return;
    const el = scroller.current?.querySelector(`[data-appt-id="${selectedId}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    const view = scroller.current.getBoundingClientRect();
    if (box.top < view.top + 40 || box.top > view.bottom - 40) scroller.current.scrollTop += box.top - view.top - 60;
  }, [selectedId, columns]);

  // A visit being moved with the keyboard (M): keep its ghost in view as it goes.
  useEffect(() => {
    if (carry) scroller.current?.querySelector('.cal-ghost.carry')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [carry?.col, carry?.s]); // eslint-disable-line react-hooks/exhaustive-deps

  const geometry = useCallback((clientX, clientY) => {
    const rect = body.current.getBoundingClientRect();
    const colWidth = rect.width / columns.length;
    const col = Math.max(0, Math.min(columns.length - 1, Math.floor((clientX - rect.left) / colWidth)));
    const minute = range.start + (clientY - rect.top) / pxPerMin;
    return { col, minute };
  }, [columns.length, range.start, pxPerMin]);

  // Global listeners while dragging so the pointer can leave the card.
  useEffect(() => {
    if (!drag) return undefined;
    let autoScroll = 0;
    const tick = () => {
      if (autoScroll) scroller.current.scrollTop += autoScroll;
      raf = requestAnimationFrame(tick);
    };
    let raf = requestAnimationFrame(tick);
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const srect = scroller.current.getBoundingClientRect();
      autoScroll = e.clientY < srect.top + 40 ? -8 : e.clientY > srect.bottom - 40 ? 8 : 0;
      const { col, minute } = geometry(e.clientX, e.clientY);
      const moved = Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 4;
      if (d.kind === 'move') {
        const dur = d.e - d.s;
        const s = Math.max(range.start, Math.min(range.end - dur, snap(minute - d.grab)));
        setDrag({ ...d, active: d.active || moved, col, s2: s, e2: s + dur });
      } else if (d.kind === 'resize') {
        setDrag({ ...d, active: true, e2: Math.max(d.s + SNAP, Math.min(range.end, snap(minute))) });
      } else if (d.kind === 'select') {
        const m = Math.max(range.start, Math.min(range.end, snap(minute)));
        setDrag({ ...d, active: d.active || moved, cur: m });
      }
    };
    const up = (e) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.kind === 'move') {
        if (!d.active) return;
        suppressClick.current = true;
        // Dropped on the pinboard: park it there to place later, maybe on another day.
        if (onPin && document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pin-drop]')) return onPin(d.appt);
        if (d.s2 === d.s && d.col === d.col0) return;
        onMove(d.appt, columns[d.col], fmtMin(d.s2), fmtMin(d.e2));
      } else if (d.kind === 'resize') {
        suppressClick.current = true;
        if (d.e2 !== d.e) onResize(d.appt, fmtMin(d.e2));
      } else if (d.kind === 'select') {
        const a = Math.min(d.anchor, d.cur ?? d.anchor);
        const b = Math.max(d.anchor, d.cur ?? d.anchor);
        onSelectRange(columns[d.col], fmtMin(a), b - a >= SNAP ? fmtMin(b) : null);
      }
    };
    const key = (e) => e.key === 'Escape' && setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
  }, [drag !== null, geometry, columns, range, onMove, onResize, onSelectRange, onOpen, onPin]); // eslint-disable-line react-hooks/exhaustive-deps

  const startMove = (e, appt, colIdx, s, eMin) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (readOnly || ['completed', 'cancelled', 'no_show'].includes(appt.status)) return;
    // Touch uses tap-to-open + "Move" (tap-to-place) so the grid still scrolls naturally.
    if (e.pointerType === 'touch') return;
    const { minute } = geometry(e.clientX, e.clientY);
    setDrag({ kind: 'move', appt, col0: colIdx, col: colIdx, s, e: eMin, s2: s, e2: eMin, grab: minute - s, x0: e.clientX, y0: e.clientY, active: false });
  };
  const startResize = (e, appt, colIdx, s, eMin) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly || ['completed', 'cancelled', 'no_show'].includes(appt.status)) return;
    setDrag({ kind: 'resize', appt, col: colIdx, s, e: eMin, e2: eMin, x0: e.clientX, y0: e.clientY });
  };
  const startSelect = (e, colIdx) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const { minute } = geometry(e.clientX, e.clientY);
    const m = Math.floor(minute / SNAP) * SNAP;
    // Touch: wait for the click so a scroll gesture doesn't create an appointment.
    if (e.pointerType === 'touch') {
      touchTap.current = true;
      return;
    }
    if (placing) return onPlace(columns[colIdx], fmtMin(m));
    setDrag({ kind: 'select', col: colIdx, anchor: m, cur: m, x0: e.clientX, y0: e.clientY });
  };

  const tapColumn = (e, colIdx) => {
    if (!touchTap.current || e.target !== e.currentTarget) return;
    touchTap.current = false;
    const m = Math.floor(geometry(e.clientX, e.clientY).minute / SNAP) * SNAP;
    if (placing) onPlace(columns[colIdx], fmtMin(m));
    else onSelectRange(columns[colIdx], fmtMin(m), null);
  };

  const perColumn = useMemo(() => columns.map((col) => layoutLanes(
    appointments.filter((a) => col.accepts(a)).map((a) => ({ appt: a, s: toMin(a.start_time), e: toMin(a.end_time) })),
  )), [columns, appointments]);

  // Arrow keys on a focused visit move to the next one: ↑/↓ in the same column, ←/→ to the nearest in time in
  // the next column that has any. They never change the day while a visit has focus.
  const moveFocus = (ev, ci, a) => {
    ev.preventDefault();
    const list = perColumn[ci];
    const i = list.findIndex((x) => x.appt.id === a.id);
    let to = null;
    if (ev.key === 'ArrowDown') to = list[i + 1]?.appt;
    else if (ev.key === 'ArrowUp') to = list[i - 1]?.appt;
    else {
      const dir = ev.key === 'ArrowRight' ? 1 : -1;
      const at = toMin(a.start_time);
      for (let c = ci + dir; c >= 0 && c < perColumn.length && !to; c += dir) {
        to = perColumn[c].reduce((best, x) => (!best || Math.abs(x.s - at) < Math.abs(best.s - at) ? x : best), null)?.appt;
      }
    }
    if (to) body.current?.querySelector(`[data-appt-id="${to.id}"]`)?.focus();
  };

  return (
    <div className="cal">
      {hover && <PatientHoverCard appt={hover.appt} anchor={hover.anchor} />}
      <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
        <div className="cal-head" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))` }}>
          <div className="cal-corner">{headerExtra}</div>
          {columns.map((c) => (
            <div key={c.key} className={`cal-col-head${c.isToday ? ' today' : ''}${onReorderColumn ? ' movable' : ''}${overCol === c.key && dragCol && dragCol !== c.key ? ' drop-before' : ''}`} style={c.color ? { '--col': c.color } : undefined}
              draggable={!!onReorderColumn}
              onDragStart={onReorderColumn ? (e) => { setDragCol(c.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.label); } : undefined}
              onDragOver={onReorderColumn && dragCol ? (e) => { e.preventDefault(); setOverCol(c.key); } : undefined}
              onDragLeave={onReorderColumn ? () => setOverCol((k) => (k === c.key ? null : k)) : undefined}
              onDrop={onReorderColumn ? (e) => { e.preventDefault(); const from = columns.find((x) => x.key === dragCol); if (from && from.key !== c.key) onReorderColumn(from, c); setDragCol(null); setOverCol(null); } : undefined}
              onDragEnd={() => { setDragCol(null); setOverCol(null); }}
              title={onReorderColumn ? 'Drag to move this chair' : undefined}>
              <div className="cal-col-title">
                {c.color && <span className="cal-col-avatar" style={{ background: c.color }}>{initialsOf(c.label)}</span>}
                <span>{c.label}</span>
              </div>
              {c.behind && <span className="cal-behind" title={c.behind.reason}><Hourglass size={11} strokeWidth={2.6} /> Running {c.behind.minutes} min behind</span>}
              <div className="cal-col-info">
                {c.prod ? <ColumnProduction title={c.prodTitle || c.label} prod={c.prod} now={c.now} />
                  : c.sub && <span className={`cal-col-sub${c.subClass ? ` ${c.subClass}` : ''}`}>{c.sub}</span>}
                {c.people?.length > 0 && (
                  <span className="cal-col-people">
                    {c.people.map((p) => <i key={p.name} style={{ background: p.color || '#64748b' }} title={p.name}>{initialsOf(p.name)}</i>)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="cal-grid" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))`, height }}>
          <div className="cal-gutter">
            {hours.map((m) => <div key={m} className="cal-hour-label" style={{ top: (m - range.start) * pxPerMin }}>{hourLabel(m)}</div>)}
            {columns.some((c) => c.isToday) && nowMin != null && nowMin >= range.start && nowMin <= range.end && (
              <div className="cal-now-label" style={{ top: (nowMin - range.start) * pxPerMin }}>{clock(nowMin)}</div>
            )}
          </div>
          <div className="cal-body" ref={body} style={{ gridColumn: `2 / span ${columns.length}`, gridTemplateColumns: `repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))`, '--hour': `${60 * pxPerMin}px`, '--step': `${step * pxPerMin}px` }}>
            {columns.map((col, ci) => {
              const closed = [];
              let cursor = range.start;
              for (const [o, c] of col.hours || []) {
                if (toMin(o) > cursor) closed.push([cursor, toMin(o)]);
                cursor = Math.max(cursor, toMin(c));
              }
              if (cursor < range.end) closed.push([cursor, range.end]);
              const sel = drag?.kind === 'select' && drag.col === ci && drag.active ? [Math.min(drag.anchor, drag.cur), Math.max(drag.anchor, drag.cur)] : null;
              return (
                <div key={col.key} className={`cal-col${placing ? ' placing' : ''}`} onPointerDown={(e) => startSelect(e, ci)} onClick={(e) => tapColumn(e, ci)}>
                  {closed.map(([a, b]) => <div key={a} className="cal-closed" style={{ top: (a - range.start) * pxPerMin, height: (b - a) * pxPerMin }} />)}
                  {(col.lanes || []).map((l) => {
                    const s = Math.max(range.start, toMin(l.start_time));
                    const e = Math.min(range.end, toMin(l.end_time));
                    if (e <= s) return null;
                    const h = (e - s) * pxPerMin;
                    return (
                      <div key={`lane-${l.id}`} className={`cal-lane${l.open ? ' open' : ''}`} aria-hidden="true" style={{ top: (s - range.start) * pxPerMin, height: h, ...(l.color ? { '--lane': l.color } : {}) }}
                        title={`${l.label}${l.type_names?.length ? ` — kept for ${l.type_names.join(', ')}` : ''}${l.open ? ' (open to any visit now)' : ''}`}>
                        {h >= 16 && (
                          <span className="cal-lane-tag">
                            {l.type_names?.length ? (l.open ? <LockOpen size={10} strokeWidth={2.5} /> : <Lock size={10} strokeWidth={2.5} />) : null}
                            {l.label}
                            {l.goal != null && l.goal > 0 && <span className="goal">{dollars(l.scheduled)} / {dollars(l.goal)}</span>}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {col.blockouts.map((b) => {
                    const s = b.start_time.slice(0, 10) < col.date ? range.start : Math.max(range.start, toMin(b.start_time));
                    const e = b.end_time.slice(0, 10) > col.date ? range.end : Math.min(range.end, toMin(b.end_time));
                    if (e <= s) return null;
                    return (
                      <div key={b.id} className={`cal-block${b.kind === 'reserved' ? ' reserved' : ''}`} style={{ top: (s - range.start) * pxPerMin, height: (e - s) * pxPerMin }}
                        onPointerDown={(ev) => ev.stopPropagation()} onClick={() => onOpenBlockout(b)} title={b.kind === 'reserved' ? `${b.reason} — reserved for ${b.type_names || 'chosen visit types'}` : b.reason}>
                        <span>{b.reason}</span>
                      </div>
                    );
                  })}
                  {col.isToday && nowMin != null && nowMin >= range.start && nowMin <= range.end && (
                    <>
                      <div className="cal-now" style={{ top: (nowMin - range.start) * pxPerMin }} />
                      <div className="cal-now-bubble" aria-hidden="true" style={{ top: (nowMin - range.start) * pxPerMin }}>{clock(nowMin)}</div>
                    </>
                  )}
                  {sel && (
                    <div className="cal-selection" style={{ top: (sel[0] - range.start) * pxPerMin, height: Math.max(SNAP, sel[1] - sel[0]) * pxPerMin }}>
                      {label12(sel[0])}–{label12(Math.max(sel[1], sel[0] + SNAP))}
                    </div>
                  )}
                  {perColumn[ci].map(({ appt: a, s, e, lane, lanes }) => {
                    const dragging = (drag?.appt?.id === a.id && drag.active) || carry?.id === a.id;
                    const color = colorBy === 'provider' ? a.provider_color || '#64748b' : colorBy === 'status' ? STATUS_COLORS[a.status] || '#64748b' : a.type_color || a.provider_color || '#64748b';
                    const h = (e - s) * pxPerMin;
                    // Late (S7): not checked in N minutes after the start; very late pulses.
                    const lt = col.isToday && now ? lateness(a, now, late || undefined) : null;
                    return (
                      <div key={a.id}
                        data-appt-id={a.id}
                        className={`cal-appt status-${a.status}${dragging ? ' dragging' : ''}${selectedId === a.id ? ' selected' : ''}${a._pending ? ' pending' : ''}${lt ? (lt.level === 'very_late' ? ' late very-late' : ' late') : ''}`}
                        style={{ top: (s - range.start) * pxPerMin, height: Math.max(h - 2, 14), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, '--c': color, '--p': a.provider_color || color }}
                        onPointerDown={(ev) => { hoverOut(); startMove(ev, a, ci, s, e); }}
                        onPointerEnter={(ev) => hoverIn(ev, a)} onPointerLeave={hoverOut}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (suppressClick.current) suppressClick.current = false;
                          else onOpen(a);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.target !== ev.currentTarget || ev.defaultPrevented || carry) return;
                          if (ev.key === 'Enter') onOpen(a);
                          else if (ev.key.startsWith('Arrow') && !ev.altKey && !ev.ctrlKey && !ev.metaKey) moveFocus(ev, ci, a);
                        }}
                        onFocus={(ev) => ev.target === ev.currentTarget && onFocusAppt?.(a)}
                        tabIndex={0} role="button"
                        aria-label={`${a.first_name} ${a.last_name}, ${label12(s)} to ${label12(e)}, ${a.status.replace('_', ' ')}${a.status === 'in_chair' && a.ready_for ? `, ${READY_LABEL[a.ready_for]}` : ''}${lt ? `, late ${lt.minutes} minutes` : ''}`}>
                        {a.pattern && a.pattern.includes('/') && (
                          // Assistant time (the provider is free then) hatched along the right edge.
                          <div className="cal-pattern" aria-hidden="true">
                            {[...a.pattern].map((c, i) => <i key={i} className={c === 'X' ? 'x' : 'a'} style={{ height: `${Math.min(100, (10 / Math.max(10, e - s)) * 100)}%` }} />)}
                          </div>
                        )}
                        <div className="cal-appt-line">
                          {a.medical_alerts ? <TriangleAlert className="cal-alert" size={12} strokeWidth={2.5} aria-label="Medical alert" /> : null}
                          {a.premed_required ? <Pill className="cal-alert" size={12} strokeWidth={2.5} aria-label="Premedication" /> : null}
                          <strong>{a.first_name} {a.last_name}</strong>
                          {STATUS_ICON[a.status] && (() => { const [Icon, text] = STATUS_ICON[a.status]; return <span className={`cal-status s-${a.status}`} title={text}><Icon size={11} strokeWidth={3} /></span>; })()}
                          {a.status === 'in_chair' && a.ready_for ? <span className={`cal-ready r-${a.ready_for}`} title={READY_LABEL[a.ready_for]}>{READY_SHORT[a.ready_for]}</span> : null}
                          {a.asap ? <span className="cal-asap" title="Wants an earlier time">ASAP</span> : null}
                          {a.series_id ? <Repeat className="cal-repeat" size={11} strokeWidth={2.5} aria-label="Recurring visit" /> : null}
                          {(() => { const b = eligibilityBadge(a.eligibility); return b ? <span className={`cal-elig ${b.tone}`} title={b.text}>{b.icon}</span> : null; })()}
                          {col.isToday && nowMin != null && a.status === 'checked_in' && a.arrived_at && (
                            <span className={`cal-flow${nowMin - toMin(a.arrived_at.slice(11, 16)) >= 15 ? ' long' : ''}`} title="Waiting since arrival">⏱ {Math.max(0, nowMin - toMin(a.arrived_at.slice(11, 16)))}m</span>
                          )}
                          {lt ? <span className="cal-late" title={`Not checked in — ${waitLabel(lt.minutes)} after their time`}>Late {waitLabel(lt.minutes)}</span>
                            : !now && col.isToday && nowMin != null && ['scheduled', 'confirmed'].includes(a.status) && nowMin > s + 5 && nowMin < e && (
                              <span className="cal-flow long" title="Not checked in yet">late</span>
                            )}
                        </div>
                        {h >= 28 && <div className="cal-appt-meta"><span className="cal-time">{clock(s)}–{clock(e)}</span> {a.type_name || a.reason || ''}</div>}
                        {h >= 44 && <div className="cal-appt-meta">{col.showProvider ? a.provider_name : a.operatory_name || a.provider_name}{a.production ? <b className="cal-prod"> ${Math.round(a.production / 100).toLocaleString()}</b> : ''}</div>}
                        {h >= 60 && a.procedure_summary && <div className="cal-appt-meta cal-codes">{a.procedure_summary}</div>}
                        {onNext && nextKind(a) && !dragging && (
                          // One click for the next step of the visit, without opening the drawer.
                          <button type="button" className="cal-next" tabIndex={-1}
                            onPointerDown={(ev) => ev.stopPropagation()}
                            onClick={(ev) => { ev.stopPropagation(); onNext(a); }}
                            title={`${NEXT_LABEL[nextKind(a)]} ${a.first_name}`}>
                            {NEXT_LABEL[nextKind(a)]}
                          </button>
                        )}
                        <div className="cal-resize" onPointerDown={(ev) => startResize(ev, a, ci, s, e)} />
                      </div>
                    );
                  })}
                  {drag?.kind === 'move' && drag.active && drag.col === ci && (
                    <div className="cal-ghost" style={{ top: (drag.s2 - range.start) * pxPerMin, height: (drag.e2 - drag.s2) * pxPerMin - 2 }}>
                      {label12(drag.s2)}–{label12(drag.e2)}
                    </div>
                  )}
                  {carry && carry.col === ci && (
                    <div className="cal-ghost carry" aria-hidden="true" style={{ top: (carry.s - range.start) * pxPerMin, height: (carry.e - carry.s) * pxPerMin - 2 }}>
                      {label12(carry.s)}–{label12(carry.e)}
                    </div>
                  )}
                  {drag?.kind === 'resize' && drag.col === ci && (
                    <div className="cal-ghost" style={{ top: (drag.s - range.start) * pxPerMin, height: (drag.e2 - drag.s) * pxPerMin - 2 }}>
                      ends {label12(drag.e2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
