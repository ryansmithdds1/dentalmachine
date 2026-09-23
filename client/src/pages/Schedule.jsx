import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { money, fmtTime, shiftDate, practiceToday } from '../format.js';
import { Modal } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';
import BlockoutForm from '../components/calendar/BlockoutForm.jsx';
import AppointmentDrawer from '../components/calendar/AppointmentDrawer.jsx';
import CalendarGrid, { toMin } from '../components/calendar/CalendarGrid.jsx';

const ZOOMS = [{ label: 'S', px: 1 }, { label: 'M', px: 1.5 }, { label: 'L', px: 2.2 }];
const pref = (k, d) => {
  try {
    return localStorage.getItem(`dm_sched_${k}`) ?? d;
  } catch {
    return d;
  }
};
const savePref = (k, v) => {
  try {
    localStorage.setItem(`dm_sched_${k}`, v);
  } catch {
    /* storage unavailable */
  }
};
const weekStart = (d) => shiftDate(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));
const dayName = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowMinutes = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
};
const short = (cents) => money(cents).replace('.00', '');

function useMediaQuery(q) {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}

export default function Schedule() {
  const { practice, can, user } = useAuth();
  const nav = useNavigate();
  const tz = practice?.timezone || 'America/New_York';
  const today = practiceToday(tz);
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery('(max-width: 760px)');
  const date = params.get('date') || today;
  const view = params.get('view') || (narrow ? 'agenda' : pref('view', 'day'));
  const [mode, setModeState] = useState(() => pref('mode', 'operatory'));
  const [zoom, setZoomState] = useState(() => Number(pref('zoom', 1.5)));
  const [providerFilter, setProviderFilter] = useState('');
  const setMode = (m) => { setModeState(m); savePref('mode', m); };
  const setZoom = (z) => { setZoomState(z); savePref('zoom', z); };
  const go = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    if (patch.view && !narrow) savePref('view', patch.view);
    setParams(next, { replace: true });
  };

  const operatories = useLookup('/operatories?active=true');
  const providers = useLookup('/providers?active=true');
  const from = view === 'week' ? weekStart(date) : date;
  const to = view === 'week' ? shiftDate(from, 6) : date;

  // ---- Data: stale-while-revalidate cache keyed by range, with neighbour prefetch ----
  const cache = useRef(new Map());
  const key = `${from}|${to}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchRange = useCallback(async (f, t) => {
    const d = await api.get(`/schedule?from=${f}&to=${t}`);
    cache.current.set(`${f}|${t}`, d);
    return d;
  }, []);

  const reload = useCallback(async ({ silent } = {}) => {
    const k = keyRef.current;
    const [f, t] = k.split('|');
    if (!silent) setLoading(true);
    try {
      const d = await fetchRange(f, t);
      if (keyRef.current === k) setData(d);
    } catch {
      /* keep showing what we have */
    } finally {
      setLoading(false);
    }
  }, [fetchRange]);

  useEffect(() => {
    const cached = cache.current.get(key);
    setData(cached || null);
    reload({ silent: !!cached });
    const span = view === 'week' ? 7 : 1;
    const t = setTimeout(() => {
      for (const dir of [-1, 1]) {
        const f = shiftDate(from, dir * span);
        const tt = shiftDate(f, span - 1);
        if (!cache.current.has(`${f}|${tt}`)) fetchRange(f, tt).catch(() => {});
      }
    }, 300);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Live updates from other workstations, patient confirmations and texts ----
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((text, opts = {}) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action ? 8000 : 4000);
  }, []);
  useLiveEvents((evt) => {
    if (evt.type !== 'schedule') return;
    for (const k of [...cache.current.keys()]) {
      const [f, t] = k.split('|');
      if (!evt.dates || evt.dates.some((d) => d >= f && d <= t)) cache.current.delete(k);
    }
    const [f, t] = keyRef.current.split('|');
    if (!evt.dates || evt.dates.some((d) => d >= f && d <= t)) {
      reload({ silent: true });
      if (evt.by !== user.id) toast(evt.source === 'patient' || evt.source === 'sms' ? 'A patient just updated their appointment' : 'Schedule updated by a teammate');
    }
  }, (up) => {
    setLive(up);
    if (up) reload({ silent: true });
  });

  const [nowMin, setNowMin] = useState(() => nowMinutes(tz));
  useEffect(() => {
    const t = setInterval(() => setNowMin(nowMinutes(tz)), 30_000);
    return () => clearInterval(t);
  }, [tz]);

  // ---- UI state ----
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [placing, setPlacing] = useState(null);
  const [showAsap, setShowAsap] = useState(false);
  const [asap, setAsap] = useState([]);
  useEffect(() => {
    if (showAsap) api.get('/asap').then(setAsap).catch(() => {});
  }, [showAsap, data]);
  const selected = data?.appointments.find((a) => a.id === selectedId) || asap.find((a) => a.id === selectedId) || null;

  // ---- Mutations (optimistic, with undo) ----
  const replaceAppt = (updated) => setData((d) => d && ({ ...d, appointments: d.appointments.map((a) => (a.id === updated.id ? updated : a)) }));
  const saveMove = useCallback(async (appt, patch, { undoable = true, override = false } = {}) => {
    const before = appt;
    replaceAppt({ ...appt, ...patch, _pending: true });
    try {
      const saved = await api.put(`/appointments/${appt.id}`, { ...patch, ...(override ? { override_blockout: true } : {}) });
      cache.current.clear();
      const [f, t] = keyRef.current.split('|');
      const d = saved.start_time.slice(0, 10);
      if (d >= f && d <= t) replaceAppt(saved);
      reload({ silent: true });
      if (undoable && (patch.start_time || patch.end_time)) {
        toast(`${appt.first_name} ${appt.last_name} → ${dayName(d, { weekday: 'short' })} ${fmtTime(saved.start_time)}–${fmtTime(saved.end_time)}`, {
          action: {
            label: 'Undo',
            run: () => saveMove(saved, { start_time: before.start_time, end_time: before.end_time, provider_id: before.provider_id, operatory_id: before.operatory_id }, { undoable: false, override: true }),
          },
        });
      }
      return saved;
    } catch (err) {
      replaceAppt(before);
      if (err.details?.can_override && confirm(`${err.message}. Book it there anyway?`)) return saveMove(appt, patch, { undoable, override: true });
      toast(err.message, { error: true });
      return null;
    }
  }, [reload, toast]);

  const onMove = useCallback((appt, col, start, end) => {
    saveMove(appt, { start_time: `${col.date} ${start}`, end_time: `${col.date} ${end}`, ...col.assign });
  }, [saveMove]);
  const onResize = useCallback((appt, end) => saveMove(appt, { end_time: `${appt.start_time.slice(0, 10)} ${end}` }), [saveMove]);
  const onSelectRange = useCallback((col, start, end) => {
    if (!can('schedule:write')) return;
    setModal({ type: 'new', defaults: { date: col.date, time: start, end, ...col.assign, provider_id: col.assign.provider_id || (providerFilter ? Number(providerFilter) : undefined) } });
  }, [can, providerFilter]);
  const onPlace = useCallback((col, start) => {
    const appt = placing;
    setPlacing(null);
    const dur = toMin(appt.end_time) - toMin(appt.start_time);
    saveMove(appt, { start_time: `${col.date} ${start}`, end_time: `${col.date} ${hhmm(toMin(start) + dur)}`, ...col.assign });
  }, [placing, saveMove]);

  const setStatus = async (a, status, scope) => {
    replaceAppt({ ...a, status, _pending: true });
    try {
      replaceAppt(await api.patch(`/appointments/${a.id}/status`, { status, ...(scope ? { scope } : {}) }));
      cache.current.clear();
      if (scope === 'following') toast('Cancelled this and the following visits in the series');
      if (['cancelled', 'no_show'].includes(status)) {
        setSelectedId(null);
        reload({ silent: true });
      }
    } catch (err) {
      replaceAppt(a);
      toast(err.message, { error: true });
    }
  };

  // ---- Keyboard shortcuts: ←/→ move, T today, D/W/A views, N new, Esc close ----
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || modal) return;
      const step = view === 'week' ? 7 : 1;
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowLeft') go({ date: shiftDate(date, -step) });
      else if (e.key === 'ArrowRight') go({ date: shiftDate(date, step) });
      else if (k === 't') go({ date: today });
      else if (k === 'd') go({ view: 'day' });
      else if (k === 'w') go({ view: 'week' });
      else if (k === 'a') go({ view: 'agenda' });
      else if (k === 'n' && can('schedule:write')) setModal({ type: 'new', defaults: { date } });
      else if (e.key === 'Escape') {
        setPlacing(null);
        setSelectedId(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- Columns ----
  const appts = data?.appointments || [];
  const blockouts = data?.blockouts || [];
  const columns = useMemo(() => {
    if (!data) return [];
    const onDate = (b, d) => b.start_time < `${d} 24:00` && b.end_time > `${d} 00:00`;
    const officeWide = (b) => !b.provider_id && !b.operatory_id;
    if (view === 'week') {
      const days = Array.from({ length: 7 }, (_, i) => shiftDate(from, i))
        .filter((d) => (data.hours[d] || []).length || appts.some((a) => a.start_time.startsWith(d)));
      return days.map((d) => ({
        key: d, date: d, label: dayName(d, { weekday: 'short', month: 'numeric', day: 'numeric' }), isToday: d === today,
        sub: `${short(data.production[d] || 0)} · ${appts.filter((a) => a.start_time.startsWith(d)).length} appts`,
        hours: data.hours[d], showProvider: true, assign: {},
        accepts: (a) => a.start_time.startsWith(d) && (!providerFilter || a.provider_id === Number(providerFilter)),
        blockouts: blockouts.filter((b) => onDate(b, d) && (officeWide(b) || (providerFilter && b.provider_id === Number(providerFilter)))),
      }));
    }
    const base = { date, isToday: date === today, hours: data.hours[date] };
    if (mode === 'provider') {
      return providers.map((p) => ({
        ...base, key: `p${p.id}`, label: p.name, color: p.color, assign: { provider_id: p.id }, showProvider: false,
        hours: data.provider_hours?.[p.id]?.[date] ?? base.hours,
        sub: short(appts.filter((a) => a.provider_id === p.id).reduce((s, a) => s + a.production, 0)),
        accepts: (a) => a.start_time.startsWith(date) && a.provider_id === p.id,
        blockouts: blockouts.filter((b) => onDate(b, date) && (officeWide(b) || b.provider_id === p.id)),
      }));
    }
    const cols = operatories.map((o) => ({
      ...base, key: `o${o.id}`, label: o.name, assign: { operatory_id: o.id }, showProvider: true,
      sub: `${appts.filter((a) => a.operatory_id === o.id).length} appts`,
      accepts: (a) => a.start_time.startsWith(date) && a.operatory_id === o.id,
      blockouts: blockouts.filter((b) => onDate(b, date) && (officeWide(b) || b.operatory_id === o.id)),
    }));
    if (appts.some((a) => !a.operatory_id && a.start_time.startsWith(date))) {
      cols.push({
        ...base, key: 'o-none', label: 'No chair', assign: { operatory_id: null }, showProvider: true,
        accepts: (a) => a.start_time.startsWith(date) && !a.operatory_id, blockouts: blockouts.filter((b) => onDate(b, date) && officeWide(b)),
      });
    }
    return cols;
  }, [data, view, mode, date, from, today, providers, operatories, providerFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeRange = useMemo(() => {
    let open = 24 * 60;
    let close = 0;
    for (const c of columns) {
      for (const [o, cl] of c.hours || []) {
        open = Math.min(open, toMin(o));
        close = Math.max(close, toMin(cl));
      }
    }
    if (open >= close) [open, close] = [8 * 60, 17 * 60];
    let start = open - 60;
    let end = close + 60;
    for (const a of appts) {
      start = Math.min(start, toMin(a.start_time));
      end = Math.max(end, toMin(a.end_time));
    }
    return { start: Math.max(0, Math.floor(start / 60) * 60), end: Math.min(24 * 60, Math.ceil(end / 60) * 60), open };
  }, [columns, appts]);

  // ---- Summary ----
  const dayAppts = view === 'week' ? appts : appts.filter((a) => a.start_time.startsWith(date));
  const production = dayAppts.reduce((s, a) => s + (a.production || 0), 0);
  const goal = (data?.daily_goal || 0) * (view === 'week' ? Math.max(1, columns.length) : 1);
  const unconfirmed = dayAppts.filter((a) => a.status === 'scheduled').length;
  const title = view === 'week'
    ? `${dayName(from, { month: 'short', day: 'numeric' })} – ${dayName(to, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : dayName(date, { weekday: narrow ? 'short' : 'long', month: narrow ? 'short' : 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="schedule-page">
      <div className="sched-toolbar">
        <div className="sched-nav">
          <button onClick={() => go({ date: shiftDate(date, view === 'week' ? -7 : -1) })} aria-label="Previous">‹</button>
          <button onClick={() => go({ date: today })} className={date === today ? 'active' : ''}>Today</button>
          <button onClick={() => go({ date: shiftDate(date, view === 'week' ? 7 : 1) })} aria-label="Next">›</button>
          <input type="date" value={date} onChange={(e) => e.target.value && go({ date: e.target.value })} aria-label="Go to date" />
        </div>
        <div className="sched-title">
          <h1>{title}</h1>
          <div className="muted sched-stats">
            <span>{dayAppts.length} appts</span>
            {unconfirmed > 0 && <span className="badge warn">{unconfirmed} unconfirmed</span>}
            <span title="Scheduled production">{short(production)}{goal ? ` of ${short(goal)}` : ''}</span>
            {goal > 0 && <span className="goal-bar" title="Scheduled production vs goal"><i style={{ width: `${Math.min(100, (production / goal) * 100)}%` }} /></span>}
            <span className={`live-dot${live ? ' on' : ''}`} title={live ? 'Live: changes from other screens appear instantly' : 'Reconnecting…'}>{live ? 'Live' : 'Offline'}</span>
            {loading && <span>Loading…</span>}
          </div>
        </div>
        <div className="sched-controls">
          <div className="seg">
            {['day', 'week', 'agenda'].map((v) => <button key={v} className={view === v ? 'active' : ''} onClick={() => go({ view: v })}>{v === 'agenda' ? 'List' : v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
          {view === 'day' && (
            <div className="seg">
              <button className={mode === 'operatory' ? 'active' : ''} onClick={() => setMode('operatory')}>Chairs</button>
              <button className={mode === 'provider' ? 'active' : ''} onClick={() => setMode('provider')}>Providers</button>
            </div>
          )}
          {view !== 'day' && (
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} aria-label="Provider filter" style={{ width: 'auto' }}>
              <option value="">All providers</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {view !== 'agenda' && (
            <div className="seg" title="Zoom">
              {ZOOMS.map((z) => <button key={z.label} className={zoom === z.px ? 'active' : ''} onClick={() => setZoom(z.px)}>{z.label}</button>)}
            </div>
          )}
          <button onClick={() => setShowAsap(!showAsap)} className={showAsap ? 'active' : ''}>ASAP</button>
          {can('schedule:write') && <button onClick={() => setModal({ type: 'block', defaults: { date } })}>Block time</button>}
          {can('schedule:write') && <button className="primary" onClick={() => setModal({ type: 'new', defaults: { date } })}>+ Appointment</button>}
        </div>
      </div>

      {placing && (
        <div className="placing-banner">
          <span>Tap a new time for <strong>{placing.first_name} {placing.last_name}</strong>{view === 'agenda' ? ' — switch to Day or Week view' : ''}.</span>
          <button className="small" onClick={() => setPlacing(null)}>Cancel</button>
        </div>
      )}

      <div className="sched-main">
        {!data ? <div className="empty">Loading schedule…</div> : view === 'agenda' ? (
          <Agenda from={from} to={to} appts={appts} blockouts={blockouts} providerFilter={providerFilter} onOpen={(a) => setSelectedId(a.id)} today={today} />
        ) : columns.length === 0 ? (
          <div className="empty card" style={{ flex: 1 }}>
            The office is closed this {view === 'week' ? 'week' : 'day'}.{' '}
            {can('schedule:write') && <button className="link" onClick={() => setModal({ type: 'new', defaults: { date } })}>Book anyway</button>}
          </div>
        ) : (
          <CalendarGrid
            columns={columns} appointments={appts} range={timeRange} pxPerMin={zoom} nowMin={nowMin}
            onMove={onMove} onResize={onResize} readOnly={!can('schedule:write')}
            onSelectRange={onSelectRange} onOpen={(a) => setSelectedId(a.id)}
            onOpenBlockout={(b) => can('schedule:write') && setModal({ type: 'block', blockout: b })}
            placing={placing} onPlace={onPlace} selectedId={selectedId} scrollKey={`${view}|${from}`}
          />
        )}

        {showAsap && (
          <aside className="asap-panel">
            <div className="inline" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>ASAP list</h3><button className="small" onClick={() => setShowAsap(false)} aria-label="Close">✕</button></div>
            <p className="muted" style={{ fontSize: 12 }}>Patients who&apos;d take an earlier opening. Open one, choose <em>Move…</em>, then tap a gap.</p>
            {asap.length === 0 && <div className="muted">Nobody on the list.</div>}
            {asap.map((a) => (
              <button key={a.id} className="asap-item" onClick={() => setSelectedId(a.id)}>
                <strong>{a.first_name} {a.last_name}</strong>
                <span className="muted">{dayName(a.start_time.slice(0, 10), { month: 'short', day: 'numeric' })} {fmtTime(a.start_time)} · {a.type_name || a.reason}</span>
                {a.phone && <span className="muted">{a.phone}</span>}
              </button>
            ))}
          </aside>
        )}
      </div>

      {selected && (
        <AppointmentDrawer
          appt={selected} can={can} onClose={() => setSelectedId(null)}
          onStatus={(s, scope) => setStatus(selected, s, scope)}
          onEdit={() => setModal({ type: 'edit', appt: selected })}
          onChart={() => nav(`/patients/${selected.patient_id}`)}
          onMove={() => {
            setPlacing(selected);
            setSelectedId(null);
            if (view === 'agenda') go({ view: 'day' });
          }}
          onToggleAsap={() => saveMove(selected, { asap: !selected.asap }, { undoable: false }).then(() => api.get('/asap').then(setAsap))}
          onReminder={async () => {
            try {
              const m = await api.post(`/appointments/${selected.id}/remind`);
              toast(`Reminder ${m.status === 'sent' ? 'sent' : 'failed'} by ${m.channel === 'sms' ? 'text' : 'email'}`);
              reload({ silent: true });
            } catch (e) {
              toast(e.message, { error: true });
            }
          }}
        />
      )}

      {modal?.type === 'new' && (
        <Modal title="New appointment" onClose={() => setModal(null)}>
          <AppointmentForm defaults={modal.defaults} onCancel={() => setModal(null)}
            onBlock={() => setModal({ type: 'block', defaults: modal.defaults })}
            onSaved={(a) => {
              setModal(null);
              cache.current.clear();
              const d = a.start_time.slice(0, 10);
              if (d < from || d > to) go({ date: d });
              else reload({ silent: true });
              setSelectedId(a.id);
            }} />
        </Modal>
      )}
      {modal?.type === 'edit' && (
        <Modal title="Edit appointment" onClose={() => setModal(null)}>
          <AppointmentForm appointment={modal.appt} onCancel={() => setModal(null)} onSaved={() => { setModal(null); cache.current.clear(); reload({ silent: true }); }} />
        </Modal>
      )}
      {modal?.type === 'block' && (
        <Modal title={modal.blockout ? 'Blocked time' : 'Block time'} onClose={() => setModal(null)}>
          <BlockoutForm blockout={modal.blockout} defaults={modal.defaults} onDone={() => { setModal(null); cache.current.clear(); reload({ silent: true }); }} />
        </Modal>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            <span>{t.text}</span>
            {t.action && <button className="small" onClick={() => { t.action.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Agenda({ from, to, appts, blockouts, providerFilter, onOpen, today }) {
  const days = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) days.push(d);
  const shown = appts.filter((a) => !providerFilter || a.provider_id === Number(providerFilter));
  return (
    <div className="agenda">
      {days.map((d) => {
        const list = shown.filter((a) => a.start_time.startsWith(d));
        const blocks = blockouts.filter((b) => b.start_time.startsWith(d));
        if (!list.length && !blocks.length && from !== to) return null;
        const items = [...list.map((a) => ({ t: a.start_time, a })), ...blocks.map((b) => ({ t: b.start_time, b }))].sort((x, y) => x.t.localeCompare(y.t));
        return (
          <section key={d}>
            <h3 className={d === today ? 'today' : ''}>{dayName(d, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
            {!list.length && <div className="muted" style={{ padding: 8 }}>No appointments.</div>}
            {items.map(({ a, b }) => (b ? (
              <div key={`b${b.id}`} className="agenda-block">{fmtTime(b.start_time)}–{fmtTime(b.end_time)} · {b.reason}</div>
            ) : (
              <button key={a.id} className={`agenda-item status-${a.status}`} style={{ '--c': a.type_color || a.provider_color }} onClick={() => onOpen(a)}>
                <div className="agenda-time"><strong>{fmtTime(a.start_time)}</strong><span className="muted">{fmtTime(a.end_time)}</span></div>
                <div className="agenda-body">
                  <strong>{a.medical_alerts ? '⚠ ' : ''}{a.first_name} {a.last_name}</strong>
                  <span className="muted">{a.type_name || a.reason} · {a.provider_name}{a.operatory_name ? ` · ${a.operatory_name}` : ''}</span>
                </div>
                <span className={`badge ${a.status}`}>{a.status.replace('_', ' ')}</span>
              </button>
            )))}
          </section>
        );
      })}
      {!shown.length && from !== to && <div className="empty">No appointments this week.</div>}
    </div>
  );
}
