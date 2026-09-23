import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export const SNAP = 10; // minutes
export const toMin = (t) => Number(t.slice(-5, -3)) * 60 + Number(t.slice(-2));
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const label12 = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`;
const snap = (m) => Math.round(m / SNAP) * SNAP;
const STATUS_ICON = { confirmed: '✓', checked_in: '➜', in_chair: '●', completed: '✔', scheduled: '' };

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
 */
export default function CalendarGrid({
  columns, appointments, range, pxPerMin, nowMin, onMove, onResize, onSelectRange, onOpen, onOpenBlockout,
  placing, onPlace, selectedId, scrollKey, headerExtra, readOnly = false,
}) {
  const scroller = useRef(null);
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

  // Scroll to "now" (or opening time) when the view changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = nowMin != null && nowMin > range.start && nowMin < range.end ? nowMin - 60 : range.open ?? range.start;
    el.scrollTop = Math.max(0, (target - range.start) * pxPerMin - 14);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

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
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.kind === 'move') {
        if (!d.active) return;
        suppressClick.current = true;
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
  }, [drag !== null, geometry, columns, range, onMove, onResize, onSelectRange, onOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (readOnly) return;
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

  return (
    <div className="cal">
      <div className="cal-scroll" ref={scroller}>
        <div className="cal-head" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))` }}>
          <div className="cal-corner">{headerExtra}</div>
          {columns.map((c) => (
            <div key={c.key} className={`cal-col-head${c.isToday ? ' today' : ''}`} style={c.color ? { boxShadow: `inset 0 -3px 0 ${c.color}` } : undefined}>
              <div className="cal-col-title">{c.label}</div>
              {c.sub && <div className="cal-col-sub">{c.sub}</div>}
            </div>
          ))}
        </div>
        <div className="cal-grid" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))`, height }}>
          <div className="cal-gutter">
            {hours.map((m) => <div key={m} className="cal-hour-label" style={{ top: (m - range.start) * pxPerMin }}>{label12(m)}</div>)}
          </div>
          <div className="cal-body" ref={body} style={{ gridColumn: `2 / span ${columns.length}`, gridTemplateColumns: `repeat(${columns.length}, minmax(var(--cal-col-min), 1fr))`, '--hour': `${60 * pxPerMin}px` }}>
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
                  {col.blockouts.map((b) => {
                    const s = b.start_time.slice(0, 10) < col.date ? range.start : Math.max(range.start, toMin(b.start_time));
                    const e = b.end_time.slice(0, 10) > col.date ? range.end : Math.min(range.end, toMin(b.end_time));
                    if (e <= s) return null;
                    return (
                      <div key={b.id} className="cal-block" style={{ top: (s - range.start) * pxPerMin, height: (e - s) * pxPerMin }}
                        onPointerDown={(ev) => ev.stopPropagation()} onClick={() => onOpenBlockout(b)} title={b.reason}>
                        <span>{b.reason}</span>
                      </div>
                    );
                  })}
                  {col.isToday && nowMin != null && nowMin >= range.start && nowMin <= range.end && (
                    <div className="cal-now" style={{ top: (nowMin - range.start) * pxPerMin }} />
                  )}
                  {sel && (
                    <div className="cal-selection" style={{ top: (sel[0] - range.start) * pxPerMin, height: Math.max(SNAP, sel[1] - sel[0]) * pxPerMin }}>
                      {label12(sel[0])}–{label12(Math.max(sel[1], sel[0] + SNAP))}
                    </div>
                  )}
                  {perColumn[ci].map(({ appt: a, s, e, lane, lanes }) => {
                    const dragging = drag?.appt?.id === a.id && drag.active;
                    const color = a.type_color || a.provider_color || '#64748b';
                    const h = (e - s) * pxPerMin;
                    return (
                      <div key={a.id}
                        className={`cal-appt status-${a.status}${dragging ? ' dragging' : ''}${selectedId === a.id ? ' selected' : ''}${a._pending ? ' pending' : ''}`}
                        style={{ top: (s - range.start) * pxPerMin, height: Math.max(h - 2, 14), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, '--c': color, '--p': a.provider_color || color }}
                        onPointerDown={(ev) => startMove(ev, a, ci, s, e)}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (suppressClick.current) suppressClick.current = false;
                          else onOpen(a);
                        }}
                        onKeyDown={(ev) => ev.key === 'Enter' && onOpen(a)}
                        tabIndex={0} role="button"
                        aria-label={`${a.first_name} ${a.last_name}, ${label12(s)} to ${label12(e)}, ${a.status}`}>
                        <div className="cal-appt-line">
                          <strong>{a.medical_alerts ? '⚠ ' : ''}{a.first_name} {a.last_name}</strong>
                          {STATUS_ICON[a.status] && <span className="cal-status" title={a.status}>{STATUS_ICON[a.status]}</span>}
                          {a.asap ? <span className="cal-asap" title="Wants an earlier time">ASAP</span> : null}
                        </div>
                        {h >= 30 && <div className="cal-appt-meta">{label12(s)}–{label12(e)} · {a.type_name || a.reason || ''}</div>}
                        {h >= 46 && <div className="cal-appt-meta">{col.showProvider ? a.provider_name : a.operatory_name || a.provider_name}{a.production ? ` · $${Math.round(a.production / 100)}` : ''}</div>}
                        {h >= 62 && a.procedure_summary && <div className="cal-appt-meta">{a.procedure_summary}</div>}
                        <div className="cal-resize" onPointerDown={(ev) => startResize(ev, a, ci, s, e)} />
                      </div>
                    );
                  })}
                  {drag?.kind === 'move' && drag.active && drag.col === ci && (
                    <div className="cal-ghost" style={{ top: (drag.s2 - range.start) * pxPerMin, height: (drag.e2 - drag.s2) * pxPerMin - 2 }}>
                      {label12(drag.s2)}–{label12(drag.e2)}
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
