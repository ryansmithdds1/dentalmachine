import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast as showToast, undoable } from '../toast.js';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { useActivePatient } from '../activePatient.jsx';
import { useRemembered } from '../prefs.js';
import { api, getLocationId } from '../api.js';
import { saveOfflineDay, PINBOARD_KEY } from '../offline.js';
import { useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { money, fmtTime, shiftDate, practiceToday, label } from '../format.js';
import { Modal } from '../components/ui.jsx';
import { ChevronLeft, ChevronRight, CalendarDays, Plus, Ban, SlidersHorizontal, Printer, Hourglass, Pin, X, ArrowUp, ArrowDown, EyeOff } from 'lucide-react';
import AppointmentForm from '../components/AppointmentForm.jsx';
import BlockoutForm from '../components/calendar/BlockoutForm.jsx';
import AppointmentDrawer from '../components/calendar/AppointmentDrawer.jsx';
import CalendarGrid, { toMin, STATUS_COLORS } from '../components/calendar/CalendarGrid.jsx';
import { planStep, nextKind, postsCharges, STEP_KEYS, READY_SHORT } from '../components/calendar/flow.js';
import { brokenLabel } from '../components/calendar/BrokenPicker.jsx';
import OverrideBanner from '../components/calendar/OverrideBanner.jsx';
import { useProduction, ProductionBar, summarize, KINDS, KIND_LABEL } from '../components/calendar/ProductionBar.jsx';
import LateBanner, { useLateChime } from '../components/calendar/LateBanner.jsx';
import { lateList, runningBehind, lateSettings } from '../components/calendar/late.js';
import { useDayOpportunities, OpportunityTotal } from '../components/opportunities/OpportunityBadge.jsx';
import { useDayReadiness } from '../components/readiness/ReadinessBadge.jsx';
import { OptimizerLauncher } from '../components/optimizer/OptimizerPanel.jsx';
import { useOptimizer } from '../components/optimizer/useOptimizer.js';

// "Fit" sizes the grid so the whole office day fits the screen without scrolling; S/M/L are fixed sizes.
const ZOOMS = [{ label: 'Fit', px: 0 }, { label: 'S', px: 1 }, { label: 'M', px: 1.5 }, { label: 'L', px: 2.2 }];
const MIN_FIT_PX = 0.85; // below this, visits get too short to read: scroll instead
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
  const compact = useMediaQuery('(max-width: 1700px)');
  const date = params.get('date') || today;
  const view = params.get('view') || (narrow ? 'agenda' : pref('view', 'day'));
  const [mode, setModeState] = useState(() => pref('mode', 'operatory'));
  const [zoom, setZoomState] = useState(() => Number(pref('zoom', 0)));
  // Showing one provider is remembered per person (on the server), so a hygienist's screen opens on their own day.
  const [providerPref, rememberProvider] = useRemembered('schedule.provider', '');
  // Production for the doctors, hygiene or everyone (S5): remembered per person too ($ cycles it).
  const [kindPref, rememberKind] = useRemembered('schedule.production_kind', 'all');
  const prodKind = KINDS.includes(kindPref) ? kindPref : 'all';
  const cycleKind = () => rememberKind(KINDS[(KINDS.indexOf(prodKind) + 1) % KINDS.length]);
  const setMode = (m) => { setModeState(m); savePref('mode', m); };
  const setZoom = (z) => { setZoomState(z); savePref('zoom', z); };
  // Grid step (5/10/15 min) and how the week view splits each day.
  const [step, setStepState] = useState(() => Number(pref('step', 10)));
  const setStep = (v) => { setStepState(v); savePref('step', v); };
  const [colorBy, setColorByState] = useState(() => pref('colorBy', 'type'));
  const setColorBy = (v) => { setColorByState(v); savePref('colorBy', v); };
  const [weekSplit, setWeekSplitState] = useState(() => pref('week_split', 'days'));
  const setWeekSplit = (v) => { setWeekSplitState(v); savePref('week_split', v); };
  const go = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    if (patch.view && !narrow) savePref('view', patch.view);
    setParams(next, { replace: true });
  };

  // Multi-location: the office picked in the sidebar decides which chairs and visits show.
  const office = getLocationId();
  const allChairs = useLookup('/operatories?active=true');
  const officeChairs = useMemo(() => (office ? allChairs.filter((o) => String(o.location_id) === office) : allChairs), [allChairs, office]);
  // Chair order and hidden chairs, kept per computer (the front desk and a hygiene room see different sets).
  const [chairLayout, setChairLayoutState] = useState(() => {
    try {
      const v = JSON.parse(pref('chairs', '{}'));
      return { order: Array.isArray(v.order) ? v.order : [], hidden: Array.isArray(v.hidden) ? v.hidden : [] };
    } catch {
      return { order: [], hidden: [] };
    }
  });
  const setChairLayout = (next) => { setChairLayoutState(next); savePref('chairs', JSON.stringify(next)); };
  const orderedChairs = useMemo(() => {
    const rank = new Map(chairLayout.order.map((id, i) => [id, i]));
    return [...officeChairs].sort((a, b) => (rank.get(a.id) ?? 1e6 + officeChairs.indexOf(a)) - (rank.get(b.id) ?? 1e6 + officeChairs.indexOf(b)));
  }, [officeChairs, chairLayout.order]);
  const operatories = useMemo(() => orderedChairs.filter((o) => !chairLayout.hidden.includes(o.id)), [orderedChairs, chairLayout.hidden]);
  const moveChair = (id, toId) => {
    const ids = orderedChairs.map((o) => o.id).filter((x) => x !== id);
    const at = toId == null ? ids.length : ids.indexOf(toId);
    ids.splice(at < 0 ? ids.length : at, 0, id);
    setChairLayout({ ...chairLayout, order: ids });
  };
  const stepChair = (id, dir) => {
    const ids = orderedChairs.map((o) => o.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setChairLayout({ ...chairLayout, order: ids });
  };
  const toggleChair = (id) => setChairLayout({ ...chairLayout, hidden: chairLayout.hidden.includes(id) ? chairLayout.hidden.filter((x) => x !== id) : [...chairLayout.hidden, id] });
  const providers = useLookup('/providers?active=true');
  const providerFilter = providers.some((p) => String(p.id) === String(providerPref)) ? String(providerPref) : '';
  const setProviderFilter = (v) => rememberProvider(v ? String(v) : '');
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
    const d = await api.get(`/schedule?from=${f}&to=${t}${office ? `&location_id=${office}` : ''}`);
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
  // Notices go through the shared toasts (Undo also answers Ctrl/⌘+Z).
  const toast = useCallback((text, opts = {}) => showToast(text, { tone: opts.error ? 'error' : 'ok', undo: opts.action?.run || null }), []);
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
  const nowStamp = `${today} ${hhmm(nowMin)}`;

  // ---- Production (S5) and the day's blocks (S2): fetched for the same days, refreshed whenever the schedule's
  // own data changes (booked, moved, completed, cancelled — here or live from another screen). ----
  const prodData = useProduction({ date: from, days: view === 'week' ? 7 : 1, kind: prodKind, office, version: data, enabled: !!data });

  // ---- Late patients and running behind (S7): the practice's thresholds; recalculated as the clock moves. ----
  const [lateRaw, setLateRaw] = useState(null);
  useEffect(() => { api.get('/schedule/late-settings').then(setLateRaw).catch(() => {}); }, []);
  const lateCfg = useMemo(() => lateSettings(lateRaw || practice), [lateRaw, practice]);
  const [lateSound, rememberLateSound] = useRemembered('schedule.late_sound', false);

  // ---- UI state ----
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [placing, setPlacing] = useState(null);
  // A move that landed on blocked time or outside hours, waiting for "move it there anyway" or "keep it".
  const [override, setOverride] = useState(null);
  const answerOverride = (yes) => { const o = override; setOverride(null); o?.resolve(yes); };
  // Keyboard move (M): the visit being carried, where it would go (column index, start minute) and its length.
  const [carry, setCarry] = useState(null);
  // Cancel / no-show from the keyboard (X, Shift+X): which picker the drawer opens with.
  const [brokenAsk, setBrokenAsk] = useState(null);
  // Keep today's list on this computer for when the internet is down (see offline.js).
  useEffect(() => {
    if (data && from <= today && to >= today) saveOfflineDay(practice, today, data.appointments, operatories, providers);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // ?book=<patient id> (the command bar's "book <name>", Alt+B for the active patient): open a new appointment
  // for them at their next open time, with Book focused so Enter books it. With a slot already dragged out
  // and no patient picked yet, it fills in the patient and keeps the slot.
  useEffect(() => {
    const id = params.get('book');
    if (!id) return;
    const next = new URLSearchParams(params);
    next.delete('book');
    setParams(next, { replace: true });
    if (id === 'new') setModal((m) => (m?.type === 'new' ? m : { type: 'new', defaults: { date } }));
    else {
      api.get(`/patients/${id}`)
        .then((p) => setModal((m) => (m?.type === 'new' && !m.patient ? { ...m, patient: p } : { type: 'new', defaults: { date }, patient: p })))
        .catch((e) => toast(e.message, { error: true }));
    }
  }, [params.get('book')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pinboard: appointments parked here (on this computer) to be placed on another day or time. Only their
  // ids are kept on the device; the details are fetched fresh, and the list is cleared at sign-out.
  const [pins, setPinsState] = useState([]);
  useEffect(() => {
    let ids = [];
    try {
      // Older versions kept whole appointments here: keep just their ids.
      ids = JSON.parse(localStorage.getItem(PINBOARD_KEY) || '[]').map((x) => Number(typeof x === 'object' ? x?.id : x)).filter(Boolean);
      localStorage.setItem(PINBOARD_KEY, JSON.stringify(ids));
    } catch { /* storage blocked */ }
    Promise.all(ids.map((id) => api.get(`/appointments/${id}`).catch(() => null)))
      .then((rows) => setPinsState(rows.filter((a) => a && !['cancelled', 'no_show', 'completed'].includes(a.status))));
  }, []);
  const setPins = (fn) => setPinsState((cur) => {
    const next = typeof fn === 'function' ? fn(cur) : fn;
    try { localStorage.setItem(PINBOARD_KEY, JSON.stringify(next.map((p) => p.id))); } catch { /* private mode */ }
    return next;
  });
  const onPin = useCallback((a) => {
    setPins((cur) => [...cur.filter((p) => p.id !== a.id), a]);
    toast(`${a.first_name} ${a.last_name} pinned — tap it on the pinboard, then tap a new time`);
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps
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
      // Blocked time or outside hours: ask inline (Enter = move it there, Esc = keep it) instead of a dialog.
      if (err.details?.can_override) {
        return new Promise((resolve) => setOverride({ appt, patch, message: err.message, resolve: (yes) => resolve(yes ? saveMove(appt, patch, { undoable, override: true }) : null) }));
      }
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
    // A chair's usual provider is the default for visits booked into it.
    const chairDefault = col.assign.operatory_id ? operatories.find((o) => o.id === col.assign.operatory_id)?.default_provider_id : null;
    // The provider comes from the column or the filter; otherwise the patient's own provider (the form asks the
    // server), falling back to the chair's usual one.
    setModal({ type: 'new', defaults: { date: col.date, time: start, end, ...col.assign, provider_id: col.assign.provider_id || (providerFilter ? Number(providerFilter) : undefined), chair_provider_id: chairDefault || undefined } });
  }, [can, providerFilter, operatories]);
  const onPlace = useCallback((col, start) => {
    const appt = placing;
    setPlacing(null);
    setCarry(null);
    const dur = toMin(appt.end_time) - toMin(appt.start_time);
    saveMove(appt, { start_time: `${col.date} ${start}`, end_time: `${col.date} ${hhmm(toMin(start) + dur)}`, ...col.assign })
      .then((saved) => saved && setPins((cur) => cur.filter((p) => p.id !== appt.id)));
  }, [placing, saveMove]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (a, status, scope, extra = {}) => {
    replaceAppt({ ...a, status, _pending: true });
    try {
      const updated = await api.patch(`/appointments/${a.id}/status`, { status, ...(scope ? { scope } : {}), ...extra });
      replaceAppt(updated);
      cache.current.clear();
      if (updated.completed_procedures) toast(`Visit complete · ${updated.completed_procedures} procedure${updated.completed_procedures === 1 ? '' : 's'} completed and charged`);
      if (scope === 'following') toast('Cancelled this and the following visits in the series');
      if (['cancelled', 'no_show'].includes(status)) {
        setSelectedId(null);
        reload({ silent: true });
      }
      return updated;
    } catch (err) {
      replaceAppt(a);
      toast(err.message, { error: true });
      return null;
    }
  };
  // Cancel or no-show with its reason (workflow 19), then — unless they said not now — the booking form for the
  // same patient, type, provider and length at the next open time after the broken one, with Book focused.
  // The freed time is still offered to the ASAP list automatically (fill.js).
  const breakVisit = async (a, status, { reason, note, scope, rebook }) => {
    const done = await setStatus(a, status, scope, { broken_reason: reason, ...(note ? { broken_note: note } : {}) });
    if (!done) return;
    setBrokenAsk(null);
    toast(`${a.first_name} ${a.last_name} ${status === 'no_show' ? 'marked as a no-show' : 'cancelled'} · ${brokenLabel(reason)}${note ? ` (${note})` : ''}`);
    if (rebook) {
      setModal({
        type: 'new', rebook: true,
        patient: { id: a.patient_id, first_name: a.first_name, last_name: a.last_name, preferred_name: a.preferred_name, dob: a.dob },
        defaults: {
          date: today, after: a.end_time, provider_id: a.provider_id, duration: toMin(a.end_time) - toMin(a.start_time),
          appointment_type_id: a.appointment_type_id || undefined, reason: a.appointment_type_id ? undefined : a.reason || undefined,
        },
      });
    }
  };

  // ---- Patient flow: check in → seat → ready → out, one key or one click each ----
  // Each step happens at once and the toast offers Undo (which steps back through the same routes, so the
  // history shows both). Cancelling keeps its own confirmation in the drawer.
  const { setActive } = useActivePatient();
  const makeActive = useCallback((a) => a?.patient_id && setActive({ id: a.patient_id, first_name: a.first_name, last_name: a.last_name, preferred_name: a.preferred_name, dob: a.dob }), [setActive]);
  const [focusComplete, setFocusComplete] = useState(0);
  // Opportunity finder: what each visit today is eligible for (G opens the list for the selected visit).
  const [focusOpps, setFocusOpps] = useState(0);
  const opps = useDayOpportunities(view === 'day' ? date : null, getLocationId(), { enabled: can('clinical:read') });
  // Today's optimizer: goal gaps and the moves that close them (O opens the plan).
  const optimizer = useOptimizer(view === 'day' ? date : null, getLocationId(), { enabled: can('schedule:read') });
  const openOpps = (a) => { setSelectedId(a.id); makeActive(a); setFocusOpps((n) => n + 1); };
  // Lab case and parts readiness (LB1/LB5): one icon per visit; clicking it opens the check-in for that visit.
  const readiness = useDayReadiness(view === 'agenda' ? null : from, to, { enabled: can('clinical:read') });
  const runStep = async (a, kind) => {
    const plan = planStep(a, kind);
    if (plan.error) return toast(plan.error);
    // Posting the visit's charges can't be taken back by Undo: open the drawer on its Complete button instead.
    if (plan.status === 'completed' && postsCharges(a, can('clinical:write'))) {
      setSelectedId(a.id);
      setFocusComplete((n) => n + 1);
      return toast('This visit has procedures to complete and charge — press Enter to finish it, or choose Visit only');
    }
    const before = a;
    const saved = (u) => { replaceAppt(u); cache.current.clear(); return u; };
    if (plan.status) {
      replaceAppt({ ...a, status: plan.status, _pending: true });
      await undoable(plan.done,
        () => api.patch(`/appointments/${a.id}/status`, { status: plan.status }).then(saved),
        () => api.patch(`/appointments/${a.id}/status`, { status: before.status, undo: true }).then(saved)).catch(() => replaceAppt(before));
    } else {
      replaceAppt({ ...a, ready_for: plan.ready, _pending: true });
      await undoable(plan.done,
        () => api.put(`/appointments/${a.id}/ready`, { ready_for: plan.ready }).then(saved),
        () => api.put(`/appointments/${a.id}/ready`, { ready_for: before.ready_for || null, undo: true }).then(saved)).catch(() => replaceAppt(before));
    }
  };
  // The visit a key acts on: the card with keyboard focus, else the one open in the drawer.
  const target = () => {
    const id = Number(document.activeElement?.closest?.('[data-appt-id]')?.dataset.apptId) || selectedId;
    return appts.find((a) => a.id === id) || null;
  };
  const stepKey = (kind) => () => {
    const a = target();
    if (!a) return toast('Pick a visit first: click it, or press F to jump to the one happening now');
    runStep(a, kind);
  };
  // F: put the keyboard on the visit happening now (or the next one today), so the flow keys work from there.
  const focusNow = () => {
    const today0 = appts.filter((a) => a.start_time.startsWith(date) && !['cancelled', 'no_show'].includes(a.status)).sort((x, y) => x.start_time.localeCompare(y.start_time));
    const now = date === today ? nowMin : -1;
    const pick = today0.find((a) => toMin(a.end_time) > now && a.status !== 'completed') || today0[0];
    const el = pick && document.querySelector(`.cal [data-appt-id="${pick.id}"], .agenda [data-appt-id="${pick.id}"]`);
    if (el) el.focus();
    else toast('No visits to go to on this day');
  };
  // ---- Keyboard move (workflow 10) ----
  // M picks up the focused visit (or, with none, the last one on the pinboard); ↑ ↓ move it by the grid step
  // (Shift: an hour), ← → to the next column, Shift+← → or Page Up/Down to another day, Enter puts it down (with
  // Undo), B parks it on the pinboard, Esc leaves it where it was. Nothing is saved until Enter.
  const focusCard = (id, tries = 12) => {
    const el = document.querySelector(`.cal [data-appt-id="${id}"]`);
    if (el && !el.classList.contains('pending')) el.focus();
    else if (tries > 0) setTimeout(() => focusCard(id, tries - 1), 120);
  };
  const pickUp = (a, fromPin = false) => {
    if (!a) return toast('Pick a visit first: click it, or press F to jump to the one happening now');
    if (['completed', 'cancelled', 'no_show'].includes(a.status)) return toast('Finished visits stay where they are');
    if (view === 'agenda') go({ view: 'day' });
    const at = columns.findIndex((c) => c.accepts(a));
    const near = at >= 0 ? at : Math.max(0, columns.findIndex((c) => (c.assign.provider_id && c.assign.provider_id === a.provider_id) || (c.assign.operatory_id && c.assign.operatory_id === a.operatory_id)));
    setSelectedId(null);
    setCarry({ appt: a, col: near, s: toMin(a.start_time), dur: toMin(a.end_time) - toMin(a.start_time), fromPin });
  };
  const cancelCarry = () => {
    const c = carry;
    setCarry(null);
    setPlacing(null);
    if (c && !c.fromPin) focusCard(c.appt.id);
  };
  const dropCarry = () => {
    const c = carry;
    const col = c && columns[c.col];
    setCarry(null);
    setPlacing(null);
    if (!col) return;
    const start = `${col.date} ${hhmm(c.s)}`;
    if (start === c.appt.start_time && col.accepts(c.appt)) {
      focusCard(c.appt.id);
      return toast('Left where it was');
    }
    saveMove(c.appt, { start_time: start, end_time: `${col.date} ${hhmm(c.s + c.dur)}`, ...col.assign }).then((saved) => {
      if (!saved) return;
      setPins((cur) => cur.filter((p) => p.id !== c.appt.id));
      focusCard(saved.id);
    });
  };
  useEffect(() => {
    if (!carry) return undefined;
    // Capture phase: while a visit is being carried, the arrows and letters belong to the move.
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      if (document.querySelector('.modal, .palette')) return;
      // Handled here: the schedule's other keys and the focused card see defaultPrevented and stay out of it.
      e.preventDefault();
      const k = e.key;
      const clampS = (v) => Math.max(timeRange.start, Math.min(timeRange.end - carry.dur, v));
      if (k === 'ArrowUp' || k === 'ArrowDown') setCarry((c) => c && { ...c, s: clampS(c.s + (k === 'ArrowUp' ? -1 : 1) * (e.shiftKey ? 60 : step)) });
      else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !e.shiftKey) setCarry((c) => c && { ...c, col: Math.max(0, Math.min(columns.length - 1, c.col + (k === 'ArrowLeft' ? -1 : 1))) });
      else if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(k)) go({ date: shiftDate(date, (k === 'ArrowLeft' || k === 'PageUp' ? -1 : 1) * (view === 'week' ? 7 : 1)) });
      else if (k === 'Enter') dropCarry();
      else if (k === 'Escape') cancelCarry();
      else if (k.toLowerCase() === 'b') {
        onPin(carry.appt);
        setCarry(null);
        setPlacing(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // X / Shift+X: cancel or no-show the focused visit — the drawer opens on the reason picker (1–7 picks one).
  const askBroken = (kind) => () => {
    const a = target();
    if (!a) return toast('Pick a visit first: click it, or press F to jump to the one happening now');
    if (['completed', 'cancelled', 'no_show'].includes(a.status)) return toast(`${a.first_name} ${a.last_name}’s visit is already ${a.status === 'completed' ? 'done' : label(a.status).toLowerCase()}`);
    setSelectedId(a.id);
    makeActive(a);
    setBrokenAsk({ kind, n: Date.now() });
  };

  const cycleProvider = () => {
    const ids = ['', ...providers.map((p) => String(p.id))];
    const next = ids[(ids.indexOf(providerFilter) + 1) % ids.length];
    setProviderFilter(next);
    toast(next ? `Showing ${providers.find((p) => String(p.id) === next).name} only` : 'Showing all providers');
  };
  const showBy = (m) => {
    if (view === 'week') setWeekSplit(m === 'provider' ? 'provider' : 'operatory');
    else {
      setMode(m);
      if (view !== 'day') go({ view: 'day' });
    }
  };
  const w = can('schedule:write');
  useShortcuts([
    { combo: 'c', handler: () => showBy('operatory'), label: 'Chairs view (one column per chair)', section: 'Schedule views' },
    { combo: 'p', handler: () => showBy('provider'), label: 'Providers view (one column per provider)', section: 'Schedule views' },
    { combo: 'v', handler: cycleProvider, label: 'Show one provider (press again for the next, then all)', section: 'Schedule views' },
    { combo: 'shift+v', handler: () => { setProviderFilter(''); toast('Showing all providers'); }, label: 'Show all providers', section: 'Schedule views' },
    { combo: '$', handler: cycleKind, label: 'Production for All → Doctor → Hygiene', section: 'Schedule views', enabled: !!prodData?.money },
    { combo: 'f', handler: focusNow, label: 'Jump to the visit happening now (then ↑ ↓ ← → between visits)', section: 'Patient flow' },
    { combo: STEP_KEYS.in, handler: stepKey('in'), label: 'Check in the selected visit', section: 'Patient flow', enabled: w },
    { combo: STEP_KEYS.seat, handler: stepKey('seat'), label: 'Seat', section: 'Patient flow', enabled: w },
    { combo: STEP_KEYS.ready, handler: stepKey('ready'), label: 'Ready for the doctor (again to clear)', section: 'Patient flow', enabled: w },
    { combo: STEP_KEYS.ready_checkout, handler: stepKey('ready_checkout'), label: 'Ready for checkout (again to clear)', section: 'Patient flow', enabled: w },
    { combo: STEP_KEYS.out, handler: stepKey('out'), label: 'Out — visit complete', section: 'Patient flow', enabled: w },
    { combo: 'g', handler: () => { const a = target(); if (a) openOpps(a); else toast('Pick a visit first: click it, or press F'); }, label: 'Opportunities for the selected visit (Enter adds one)', section: 'Patient flow', enabled: can('clinical:read') },
    { combo: 'm', handler: () => { const a = target(); if (a || !pins.length) pickUp(a); else pickUp(pins.at(-1), true); }, label: 'Move the selected visit (or the last pinned one): ↑ ↓ ← →, Enter to put it down', section: 'Moving visits', enabled: w },
    { combo: 'x', handler: askBroken('cancelled'), label: 'Cancel the selected visit (pick a reason, then rebook)', section: 'Moving visits', enabled: w },
    { combo: 'shift+x', handler: askBroken('no_show'), label: 'No-show (pick a reason, then rebook)', section: 'Moving visits', enabled: w },
  ]);
  useCommands([
    { id: 'sched-chairs', label: 'Schedule: Chairs view', hint: 'C', run: () => showBy('operatory') },
    { id: 'sched-providers', label: 'Schedule: Providers view', hint: 'P', run: () => showBy('provider') },
    { id: 'sched-all', label: 'Schedule: show all providers', hint: 'Shift+V', run: () => setProviderFilter('') },
    ...providers.map((p) => ({ id: `sched-only-${p.id}`, label: `Schedule: show only ${p.name}`, hint: 'V cycles providers', run: () => setProviderFilter(p.id) })),
    { id: 'sched-today', label: 'Schedule: today', hint: 'T', run: () => go({ date: today }) },
    ...(prodData?.money ? KINDS.map((k) => ({ id: `sched-prod-${k}`, label: `Schedule: production for ${k === 'all' ? 'everyone' : KIND_LABEL[k].toLowerCase()}`, hint: '$', run: () => rememberKind(k) })) : []),
    { id: 'sched-unconfirmed', label: 'Schedule: unconfirmed visits', run: () => nav(`/followups?tab=unconfirmed${view === 'week' ? '&days=7' : `&date=${date}`}`) },
  ]);

  // ---- Keyboard shortcuts: ←/→ move, T today, D/W/A views, N new, Esc close ----
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || modal) return;
      const step = view === 'week' ? 7 : 1;
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowLeft') go({ date: shiftDate(date, -step) });
      else if (e.key === 'ArrowRight') go({ date: shiftDate(date, step) });
      else if (k === 't') go({ date: today });
      else if (k === 'd') go({ view: 'day' });
      else if (k === 'w') go({ view: 'week' });
      else if (k === 'a') go({ view: 'agenda' });
      else if (k === 'n' && !e.shiftKey && can('schedule:write')) setModal({ type: 'new', defaults: { date } });
      else if (e.key === 'Escape') {
        if (override) answerOverride(false);
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
      // A condensed week: each day split into its providers (those working or booked) or its chairs.
      if (weekSplit !== 'days') {
        const dayLabel = (d) => dayName(d, { weekday: 'short', day: 'numeric' });
        return days.flatMap((d) => (weekSplit === 'provider'
          ? providers
            .filter((p) => (!providerFilter || p.id === Number(providerFilter)) && ((data.provider_hours?.[p.id]?.[d] ?? data.hours[d] ?? []).length || appts.some((a) => a.provider_id === p.id && a.start_time.startsWith(d))))
            .map((p) => ({
              key: `${d}-p${p.id}`, date: d, isToday: d === today, label: `${dayLabel(d)} · ${p.name.split(/[ ,]/).filter(Boolean).slice(0, 2).join(' ')}`, color: p.color,
              hours: data.provider_hours?.[p.id]?.[d] ?? data.hours[d], assign: { provider_id: p.id }, showProvider: false,
              accepts: (a) => a.start_time.startsWith(d) && a.provider_id === p.id,
              blockouts: blockouts.filter((b) => onDate(b, d) && (officeWide(b) || b.provider_id === p.id)),
            }))
          : operatories.map((o) => ({
            key: `${d}-o${o.id}`, date: d, isToday: d === today, label: `${dayLabel(d)} · ${o.name}`, hours: data.hours[d], assign: { operatory_id: o.id }, showProvider: true,
            accepts: (a) => a.start_time.startsWith(d) && a.operatory_id === o.id && (!providerFilter || a.provider_id === Number(providerFilter)),
            blockouts: blockouts.filter((b) => onDate(b, d) && (officeWide(b) || b.operatory_id === o.id)),
          }))));
      }
      return days.map((d) => ({
        key: d, date: d, label: dayName(d, { weekday: 'short', month: 'numeric', day: 'numeric' }), isToday: d === today,
        sub: `${short(data.production[d] || 0)} · ${appts.filter((a) => a.start_time.startsWith(d)).length} appts`,
        hours: data.hours[d], showProvider: true, assign: {},
        accepts: (a) => a.start_time.startsWith(d) && (!providerFilter || a.provider_id === Number(providerFilter)),
        blockouts: blockouts.filter((b) => onDate(b, d) && (officeWide(b) || (providerFilter && b.provider_id === Number(providerFilter)))),
      }));
    }
    const base = { date, isToday: date === today, hours: data.hours[date] };
    const shownProvider = (a) => !providerFilter || a.provider_id === Number(providerFilter);
    if (mode === 'provider') {
      return providers.filter((p) => !providerFilter || p.id === Number(providerFilter)).map((p) => ({
        ...base, key: `p${p.id}`, label: p.name, color: p.color, assign: { provider_id: p.id }, showProvider: false,
        hours: data.provider_hours?.[p.id]?.[date] ?? base.hours,
        ...(() => {
          const prod = appts.filter((a) => a.provider_id === p.id && !['cancelled', 'no_show'].includes(a.status)).reduce((s, a) => s + a.production, 0);
          if (!p.daily_goal) return { sub: short(prod) };
          return { sub: `${short(prod)} of ${short(p.daily_goal)} goal`, subClass: prod >= p.daily_goal ? 'goal-met' : 'goal-short' };
        })(),
        accepts: (a) => a.start_time.startsWith(date) && a.provider_id === p.id,
        blockouts: blockouts.filter((b) => onDate(b, date) && (officeWide(b) || b.provider_id === p.id)),
      }));
    }
    const cols = operatories.map((o) => ({
      ...base, key: `o${o.id}`, chairId: o.id, label: o.name, assign: { operatory_id: o.id }, showProvider: true,
      sub: ((n) => `${n} appt${n === 1 ? '' : 's'}`)(appts.filter((a) => a.operatory_id === o.id && a.start_time.startsWith(date) && !['cancelled', 'no_show'].includes(a.status)).length),
      // Who's working in this chair today (from the visits booked in it).
      people: [...new Map(appts.filter((a) => a.operatory_id === o.id && a.start_time.startsWith(date)).map((a) => [a.provider_id, { name: a.provider_name, color: a.provider_color }])).values()],
      accepts: (a) => a.start_time.startsWith(date) && a.operatory_id === o.id && shownProvider(a),
      blockouts: blockouts.filter((b) => onDate(b, date) && (officeWide(b) || b.operatory_id === o.id)),
    }));
    if (appts.some((a) => !a.operatory_id && a.start_time.startsWith(date))) {
      cols.push({
        ...base, key: 'o-none', label: 'No chair', assign: { operatory_id: null }, showProvider: true,
        accepts: (a) => a.start_time.startsWith(date) && !a.operatory_id && shownProvider(a), blockouts: blockouts.filter((b) => onDate(b, date) && officeWide(b)),
      });
    }
    return cols;
  }, [data, view, mode, date, from, today, providers, operatories, providerFilter, weekSplit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each column's production (in its heading) and its perfect-day blocks (tinted lanes). Chairs show the blocks of
  // the chair's usual provider; a hygienist's column shows no numbers while "Doctor" is picked, and vice versa.
  const gridColumns = useMemo(() => {
    // Today's columns: running behind (a patient waiting to be seated, or over time with the next one waiting).
    const withBehind = (c) => (c.isToday ? { ...c, behind: runningBehind(appts.filter((a) => c.accepts(a)), nowStamp, lateCfg) } : c);
    if (!prodData) return columns.map(withBehind);
    const zero = { scheduled: 0, completed: 0, goal: 0, visits: 0 };
    const fp = providerFilter ? Number(providerFilter) : null;
    const liveVisits = (d, pid) => appts.filter((a) => a.provider_id === pid && a.start_time.startsWith(d) && !['cancelled', 'no_show'].includes(a.status)).length;
    return columns.map((c) => {
      const day = prodData.days.find((x) => x.date === c.date);
      if (!day) return c;
      let prod;
      let laneProvider = null;
      if (c.assign.provider_id) {
        const pid = c.assign.provider_id;
        const kindHere = providers.find((p) => p.id === pid)?.type === 'hygienist' ? 'hygiene' : 'doctor';
        prod = prodKind !== 'all' && kindHere !== prodKind ? { off: true, kind: prodKind, visits: liveVisits(c.date, pid) } : day.providers[pid] || zero;
        laneProvider = pid;
      } else if ('operatory_id' in c.assign) {
        const b = day.operatories[c.assign.operatory_id ?? 'none'];
        prod = fp ? { ...(b?.providers?.[fp] || zero), goal: 0 } : { ...zero, ...b };
        const usual = c.assign.operatory_id ? operatories.find((o) => o.id === c.assign.operatory_id)?.default_provider_id : null;
        laneProvider = usual && (!fp || usual === fp) ? usual : null;
      } else {
        prod = fp ? day.providers[fp] || zero : day;
        laneProvider = fp;
      }
      const lanes = laneProvider ? day.blocks.filter((b) => b.provider_id === laneProvider).map((b) => ({ ...b, open: nowStamp >= b.release_at })) : [];
      return withBehind({ ...c, lanes, now: nowStamp, prod: prodData.money ? { ...prod, blocks: lanes } : null, prodTitle: view === 'week' && !c.assign.provider_id && !('operatory_id' in c.assign) ? dayName(c.date, { weekday: 'long', month: 'short', day: 'numeric' }) : c.label });
    });
  }, [columns, prodData, nowStamp, prodKind, providerFilter, providers, operatories, appts, view, lateCfg]);

  // Everyone late today (on screen when the range includes today), longest first; a soft sound if this person wants it.
  const lates = useMemo(() => (from <= today && to >= today
    ? lateList(appts.filter((a) => a.start_time.startsWith(today) && (!providerFilter || a.provider_id === Number(providerFilter))), nowStamp, lateCfg)
    : []), [appts, from, to, today, nowStamp, lateCfg, providerFilter]);
  useLateChime(lates, !!lateSound, `${from}|${to}|${providerFilter}`);
  const textLate = async (a) => {
    try {
      await api.post(`/patients/${a.patient_id}/messages`, {
        channel: 'sms',
        body: `Hi ${a.preferred_name || a.first_name}, it's ${practice?.name || 'your dental office'}. We have you at ${fmtTime(a.start_time)} today — are you on your way? Just reply to this text.`,
      });
      toast(`Texted ${a.first_name} ${a.last_name}: are you on your way?`);
      return true;
    } catch (err) {
      toast(err.message, { error: true });
      return false;
    }
  };

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
    const pad = zoom ? 60 : 0; // Fit shows office hours (and any visit outside them), not an extra hour each side
    let start = open - pad;
    let end = close + pad;
    for (const a of appts) {
      start = Math.min(start, toMin(a.start_time));
      end = Math.max(end, toMin(a.end_time));
    }
    const round = zoom ? 60 : 30;
    return { start: Math.max(0, Math.floor(start / round) * round), end: Math.min(24 * 60, Math.ceil(end / round) * round), open };
  }, [columns, appts, zoom]);

  // Fit: pixels per minute so the day fills the space under the column headers.
  const mainRef = useRef(null);
  const [mainH, setMainH] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setMainH(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const pxPerMin = zoom || (mainH ? Math.max(MIN_FIT_PX, (mainH - 58) / Math.max(60, timeRange.end - timeRange.start)) : 1.2);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    if (!optionsOpen) return undefined;
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest?.('.view-options')) setOptionsOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [optionsOpen]);
  const dateInput = useRef(null);

  // ---- Summary ----
  const dayAppts = (view === 'week' ? appts : appts.filter((a) => a.start_time.startsWith(date))).filter((a) => !providerFilter || a.provider_id === Number(providerFilter));
  const production = dayAppts.reduce((s, a) => s + (a.production || 0), 0);
  const goal = (data?.daily_goal || 0) * (view === 'week' ? Math.max(1, columns.length) : 1);
  const unconfirmed = dayAppts.filter((a) => a.status === 'scheduled').length;
  // The production bar: this day (or week), for the provider shown if one is picked.
  const prodSum = prodData?.money ? summarize(prodData.days.filter((d) => view === 'week' || d.date === date), providerFilter || null) : null;
  const prodHeading = providerFilter ? providers.find((p) => String(p.id) === providerFilter)?.name || 'Provider'
    : view === 'week' ? 'This week' : date === today ? 'Today' : dayName(date, { weekday: 'short', month: 'short', day: 'numeric' });
  const title = view === 'week'
    ? `${dayName(from, { month: 'short', day: 'numeric' })} – ${dayName(to, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : dayName(date, { weekday: compact ? 'short' : 'long', month: compact ? 'short' : 'long', day: 'numeric', ...(narrow ? {} : { year: 'numeric' }) });

  return (
    <div className="schedule-page">
      <div className="sched-toolbar">
        <div className="sched-nav">
          <button className="icon-btn" onClick={() => go({ date: shiftDate(date, view === 'week' ? -7 : -1) })} aria-label="Previous" title="Previous (←)"><ChevronLeft size={18} /></button>
          <button onClick={() => go({ date: today })} className={`today-btn${date === today ? ' active' : ''}`} title="Today (T)">Today</button>
          <button className="icon-btn" onClick={() => go({ date: shiftDate(date, view === 'week' ? 7 : 1) })} aria-label="Next" title="Next (→)"><ChevronRight size={18} /></button>
        </div>
        <button className="sched-title" onClick={() => { try { dateInput.current?.showPicker(); } catch { dateInput.current?.focus(); } }} title="Go to a date">
          <h1>{title}</h1>
          <CalendarDays size={16} className="muted" />
          <input ref={dateInput} type="date" value={date} onChange={(e) => e.target.value && go({ date: e.target.value })} aria-label="Go to date" tabIndex={-1} />
        </button>
        <div className="sched-stats">
          {(() => {
            const n = view === 'day' && mode === 'operatory' ? dayAppts.filter((a) => chairLayout.hidden.includes(a.operatory_id) && !['cancelled', 'no_show'].includes(a.status)).length : 0;
            return n > 0 ? <button className="stat-pill warn hidden-chairs" onClick={() => setChairLayout({ ...chairLayout, hidden: [] })} title="Some chairs are hidden on this computer — show them all"><EyeOff size={13} /> {n} in hidden chairs</button> : null;
          })()}
          <span className="stat-pill">{dayAppts.length} appts</span>
          {unconfirmed > 0 && (
            <button className="stat-pill warn unconfirmed-link" onClick={() => nav(`/followups?tab=unconfirmed${view === 'week' ? '&days=7' : `&date=${date}`}`)} title="Open the list to confirm them or text a reminder">
              {unconfirmed} unconfirmed
            </button>
          )}
          {!prodSum && (
            <span className="stat-pill prod" title="Scheduled production">
              {short(production)}{goal ? <span className="muted"> / {short(goal)}</span> : ''}
              {goal > 0 && <span className="goal-bar" title="Scheduled production vs goal"><i style={{ width: `${Math.min(100, (production / goal) * 100)}%` }} /></span>}
            </span>
          )}
          {live !== null && <span className={`live-dot${live ? ' on' : ''}`} title={live ? 'Live: changes from other screens appear instantly' : 'Reconnecting…'}>{live ? '' : 'Offline'}</span>}
          {loading && <span className="muted">Loading…</span>}
        </div>
        <div className="sched-controls">
          <div className="seg">
            {['day', 'week', 'agenda'].map((v) => <button key={v} className={view === v ? 'active' : ''} onClick={() => go({ view: v })}>{v === 'agenda' ? 'List' : v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
          {view === 'day' && (
            <div className="seg">
              <button className={mode === 'operatory' ? 'active' : ''} onClick={() => setMode('operatory')} title="Chairs (C)">Chairs</button>
              <button className={mode === 'provider' ? 'active' : ''} onClick={() => setMode('provider')} title="Providers (P)">Providers</button>
            </div>
          )}
          {view === 'week' && (
            <div className="seg" title="Week layout">
              {[['days', 'Days'], ['provider', 'By provider'], ['operatory', 'By chair']].map(([k, l]) => <button key={k} className={weekSplit === k ? 'active' : ''} onClick={() => setWeekSplit(k)}>{l}</button>)}
            </div>
          )}
          {/* One provider's day, in any view; remembered for next time. */}
          <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} aria-label="Provider filter" title="Show one provider (V)" style={{ width: 'auto' }}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {view !== 'agenda' && (
            <div className="view-options">
              <button className={`icon-btn${optionsOpen ? ' active' : ''}`} onClick={() => setOptionsOpen(!optionsOpen)} aria-expanded={optionsOpen} title="View options"><SlidersHorizontal size={17} /></button>
              {optionsOpen && (
                <div className="popover" role="dialog" aria-label="View options">
                  <div className="popover-row"><span>Zoom</span>
                    <div className="seg">{ZOOMS.map((z) => <button key={z.label} className={zoom === z.px ? 'active' : ''} onClick={() => setZoom(z.px)} title={z.px ? undefined : 'Fit the whole day on screen'}>{z.label}</button>)}</div>
                  </div>
                  <div className="popover-row"><span>Time grid</span>
                    <div className="seg">{[5, 10, 15].map((m) => <button key={m} className={step === m ? 'active' : ''} onClick={() => setStep(m)}>{m} min</button>)}</div>
                  </div>
                  <div className="popover-row"><span>Color by</span>
                    <div className="seg">{[['type', 'Type'], ['provider', 'Provider'], ['status', 'Status']].map(([k, l]) => <button key={k} className={colorBy === k ? 'active' : ''} onClick={() => setColorBy(k)}>{l}</button>)}</div>
                  </div>
                  {orderedChairs.length > 1 && (
                    <div className="chair-list">
                      <div className="popover-row"><span>Chairs on this computer</span>{(chairLayout.hidden.length > 0 || chairLayout.order.length > 0) && <button className="link" onClick={() => setChairLayout({ order: [], hidden: [] })}>Reset</button>}</div>
                      {orderedChairs.map((o, i) => (
                        <div key={o.id} className="chair-row">
                          <label className="checkbox"><input type="checkbox" checked={!chairLayout.hidden.includes(o.id)} onChange={() => toggleChair(o.id)} /> {o.name}</label>
                          <button className="icon-btn tiny" disabled={i === 0} onClick={() => stepChair(o.id, -1)} aria-label={`Move ${o.name} left`}><ArrowUp size={13} /></button>
                          <button className="icon-btn tiny" disabled={i === orderedChairs.length - 1} onClick={() => stepChair(o.id, 1)} aria-label={`Move ${o.name} right`}><ArrowDown size={13} /></button>
                        </div>
                      ))}
                      <div className="muted" style={{ fontSize: 11.5 }}>Or drag a chair&apos;s heading on the schedule to move it.</div>
                    </div>
                  )}
                  <button className="menu-item" onClick={() => { setOptionsOpen(false); window.open(`/schedule/print?date=${date}${providerFilter ? `&provider_id=${providerFilter}` : ''}`, '_blank'); }}><Printer size={16} /> Print the day (one page per provider)</button>
                </div>
              )}
            </div>
          )}
          {view === 'day' && <OptimizerLauncher date={date} locationId={getLocationId()} />}
          <button onClick={() => setShowAsap(!showAsap)} className={`icon-btn wide${showAsap ? ' active' : ''}`} title="Waitlist and ASAP list"><Hourglass size={16} /> Waitlist</button>
          {can('schedule:write') && <button className="icon-btn" onClick={() => setModal({ type: 'block', defaults: { date } })} title="Block time"><Ban size={16} /></button>}
          {can('schedule:write') && <button className="primary" onClick={() => setModal({ type: 'new', defaults: { date } })} title="New appointment (N)"><Plus size={16} strokeWidth={2.5} /> Appointment</button>}
        </div>
      </div>

      {lates.length > 0 && (
        <LateBanner list={lates} canText={can('patients:write')} canWrite={can('schedule:write')} sound={!!lateSound} onSound={rememberLateSound}
          onText={textLate}
          onOpen={(a) => { setSelectedId(a.id); makeActive(a); }}
          onNoShow={(a) => { setSelectedId(a.id); makeActive(a); setBrokenAsk({ kind: 'no_show', n: Date.now() }); }}
          onMove={(a) => { setPlacing(a); pickUp(a); }} />
      )}
      {prodSum && <ProductionBar title={prodHeading} sum={prodSum} unscheduled={prodData.unscheduled} kind={prodKind} onKind={rememberKind} now={nowStamp} />}
      {opps.totals?.count > 0 && <OpportunityTotal count={opps.totals.count} fee={opps.totals.fee} />}
      {override && <OverrideBanner message={override.message} name={`${override.appt.first_name} ${override.appt.last_name}`} onAnswer={answerOverride} />}
      {carry && (() => {
        const col = columns[carry.col];
        return (
          <div className="placing-banner carry-banner" role="status">
            <span>
              Moving <strong>{carry.appt.first_name} {carry.appt.last_name}</strong> to{' '}
              <strong>{col ? `${dayName(col.date, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(`${col.date} ${hhmm(carry.s)}`)}` : '…'}</strong>
              {col && col.label && view !== 'week' ? ` · ${col.label}` : ''}
              <span className="muted"> — ↑ ↓ time · ← → column · Shift+← → day · <kbd>Enter</kbd> put it here · <kbd>B</kbd> pinboard · <kbd>Esc</kbd> cancel</span>
            </span>
            <span className="inline">
              <button className="small primary" onClick={dropCarry}>Put it here</button>
              <button className="small" onClick={cancelCarry}>Cancel</button>
            </span>
          </div>
        );
      })()}
      {placing && !carry && (
        <div className="placing-banner">
          <span>Tap a new time for <strong>{placing.first_name} {placing.last_name}</strong>{view === 'agenda' ? ' — switch to Day or Week view' : ''}.</span>
          <button className="small" onClick={() => setPlacing(null)}>Cancel</button>
        </div>
      )}

      <div className="sched-main" ref={mainRef}>
        {!data ? <div className="empty">Loading schedule…</div> : view === 'agenda' ? (
          <Agenda from={from} to={to} appts={appts} blockouts={blockouts} providerFilter={providerFilter} onOpen={(a) => { setSelectedId(a.id); makeActive(a); }} onFocusAppt={makeActive} today={today} />
        ) : columns.length === 0 ? (
          <div className="empty card" style={{ flex: 1 }}>
            The office is closed this {view === 'week' ? 'week' : 'day'}.{' '}
            {can('schedule:write') && <button className="link" onClick={() => setModal({ type: 'new', defaults: { date } })}>Book anyway</button>}
          </div>
        ) : (
          <>
          {colorBy === 'status' && (
            <div className="legend no-print" style={{ justifyContent: 'flex-start', margin: '0 0 6px' }}>
              {Object.entries(STATUS_COLORS).map(([k, c]) => <span key={k}><i style={{ background: c }} />{label(k)}</span>)}
            </div>
          )}
          <CalendarGrid
            columns={gridColumns} appointments={appts} range={timeRange} pxPerMin={pxPerMin} nowMin={nowMin} step={step} colorBy={colorBy}
            onMove={onMove} onResize={onResize} readOnly={!can('schedule:write')} opportunities={opps.byAppt} onOpportunities={openOpps}
            readiness={readiness.byAppt} onReadiness={(a) => { makeActive(a); nav('/lab-checkin'); }} optimizer={optimizer.data}
            onSelectRange={onSelectRange} onOpen={(a) => { setSelectedId(a.id); makeActive(a); }} onFocusAppt={makeActive}
            onNext={w ? (a) => runStep(a, nextKind(a)) : undefined}
            onOpenBlockout={(b) => can('schedule:write') && setModal({ type: 'block', blockout: b })}
            placing={placing} onPlace={onPlace} selectedId={selectedId} scrollKey={`${view}|${from}|${zoom}`}
            carry={carry && columns[carry.col] ? { col: carry.col, s: carry.s, e: carry.s + carry.dur, id: carry.appt.id } : null}
            onPin={can('schedule:write') ? onPin : undefined}
            now={nowStamp} late={lateCfg}
            onReorderColumn={view === 'day' && mode === 'operatory' ? (from, to) => moveChair(from.chairId, to.chairId) : undefined}
          />
          </>
        )}

        {showAsap && (
          <aside className="asap-panel">
            <div className="inline" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Waitlist & ASAP</h3><button className="small" onClick={() => setShowAsap(false)} aria-label="Close">✕</button></div>
            <WaitlistPanel date={date} providers={providers} canWrite={can('schedule:write')} onOpenPatient={(id) => nav(`/patients/${id}`)} />
            <h3 style={{ margin: '14px 0 0' }}>Booked, want earlier</h3>
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

      {can('schedule:write') && view !== 'agenda' && (
        <div className={`pinboard${pins.length ? '' : ' empty'}`} data-pin-drop>
          <strong><Pin size={14} /> Pinboard</strong>
          {!pins.length && <span className="muted">Drop here to move it to another day</span>}
          {pins.map((p) => (
            <span key={p.id} className={`pin-item${placing?.id === p.id ? ' active' : ''}`} style={{ borderLeftColor: p.type_color || p.provider_color || '#64748b' }}>
              <button className="link" onClick={() => { if (placing?.id === p.id) { setPlacing(null); setCarry(null); } else { setPlacing(p); pickUp(p, true); } }} title="Tap, then tap a new time on the schedule (or use the arrow keys and Enter)">
                {p.first_name} {p.last_name} <span className="muted">· {p.type_name || p.reason || 'Visit'} · {toMin(p.end_time) - toMin(p.start_time)} min · was {dayName(p.start_time.slice(0, 10), { month: 'short', day: 'numeric' })} {fmtTime(p.start_time)}</span>
              </button>
              <button className="link" aria-label="Unpin" title="Leave it where it is" onClick={() => { setPins((cur) => cur.filter((x) => x.id !== p.id)); if (placing?.id === p.id) setPlacing(null); }}><X size={14} /></button>
            </span>
          ))}
        </div>
      )}

      {selected && (
        <AppointmentDrawer
          onPin={() => { onPin(selected); setSelectedId(null); }}
          appt={selected} can={can} onClose={() => setSelectedId(null)}
          focusOpportunities={focusOpps} onOpportunitiesChanged={() => { cache.current.clear(); reload({ silent: true }); }}
          onStatus={(s, scope, extra) => setStatus(selected, s, scope, extra)}
          onStep={(kind) => runStep(selected, kind)} focusComplete={focusComplete}
          brokenAsk={brokenAsk} onBroken={(kind, choice) => breakVisit(selected, kind, choice)}
          onEdit={() => setModal({ type: 'edit', appt: selected })}
          onCheckout={() => nav(`/checkout/${selected.id}`)}
          onChart={() => nav(`/patients/${selected.patient_id}`)}
          onMove={() => {
            // Tap a new time, or move it with the arrow keys and Enter.
            setPlacing(selected);
            pickUp(selected);
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
        <Modal title={modal.rebook ? `Rebook ${modal.patient.first_name} ${modal.patient.last_name}` : 'New appointment'} onClose={() => setModal(null)}>
          <AppointmentForm defaults={modal.defaults} patient={modal.patient} onCancel={() => setModal(null)}
            onBlock={() => setModal({ type: 'block', defaults: modal.defaults })} key={modal.patient?.id || 'none'}
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

    </div>
  );
}

function Agenda({ from, to, appts, blockouts, providerFilter, onOpen, onFocusAppt, today }) {
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
              <button key={a.id} data-appt-id={a.id} className={`agenda-item status-${a.status}`} style={{ '--c': a.type_color || a.provider_color }} onClick={() => onOpen(a)} onFocus={() => onFocusAppt(a)}>
                <div className="agenda-time"><strong>{fmtTime(a.start_time)}</strong><span className="muted">{fmtTime(a.end_time)}</span></div>
                <div className="agenda-body">
                  <strong>{a.premed_required ? '💊 ' : ''}{a.medical_alerts ? '⚠ ' : ''}{a.first_name} {a.last_name}</strong>
                  <span className="muted">{a.type_name || a.reason} · {a.provider_name}{a.operatory_name ? ` · ${a.operatory_name}` : ''}</span>
                </div>
                <span className={`badge ${a.status}`}>{a.status.replace('_', ' ')}</span>
                {a.status === 'in_chair' && a.ready_for && <span className="badge ready-badge">{READY_SHORT[a.ready_for]}</span>}
              </button>
            )))}
          </section>
        );
      })}
      {!shown.length && from !== to && <div className="empty">No appointments this week.</div>}
    </div>
  );
}

// Waitlist: patients with nothing booked (or wanting sooner), and texting an opening to the first who fit.
function WaitlistPanel({ date, providers, canWrite, onOpenPatient }) {
  const [list, setList] = useState(null);
  const [offer, setOffer] = useState({ date, time: '09:00', minutes: 60, provider_id: '' });
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api.get('/waitlist').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  useEffect(() => setOffer((o) => ({ ...o, date })), [date]);
  const send = async () => {
    setErr(null);
    try {
      setResult(await api.post('/waitlist/offer', { ...offer, minutes: Number(offer.minutes), provider_id: offer.provider_id ? Number(offer.provider_id) : null }));
      load();
    } catch (e) {
      setErr(e);
    }
  };
  const remove = async (w) => { await api.put(`/waitlist/${w.id}`, { status: 'removed' }); load(); };
  return (
    <div>
      <h3 style={{ margin: '10px 0 4px', fontSize: 15 }}>Not booked yet ({list?.length ?? '…'})</h3>
      {list?.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Nobody waiting. Add patients from their chart.</div>}
      {list?.map((w) => (
        <div key={w.id} className="asap-item" style={{ cursor: 'default' }}>
          <button className="link-button" onClick={() => onOpenPatient(w.patient_id)}><strong>{w.first_name} {w.last_name}</strong></button>
          <span className="muted">{w.reason || 'Visit'} · {w.duration} min{w.provider_name ? ` · ${w.provider_name}` : ''}</span>
          <span className="muted">{w.days ? JSON.parse(w.days).map((d) => 'SMTWTFS'[d]).join('') : 'Any day'} · {w.times === 'any' ? 'any time' : w.times}{w.last_offered_at ? ' · offered' : ''}</span>
          {canWrite && <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => remove(w)}>Remove</button>}
        </div>
      ))}
      {canWrite && list?.length > 0 && (
        <div className="waitlist-offer">
          <strong style={{ fontSize: 13 }}>Offer an opening</strong>
          <div className="inline" style={{ flexWrap: 'wrap', gap: 4 }}>
            <input type="date" value={offer.date} onChange={(e) => setOffer({ ...offer, date: e.target.value })} style={{ width: 140 }} />
            <input type="time" value={offer.time} step={300} onChange={(e) => setOffer({ ...offer, time: e.target.value })} style={{ width: 110 }} />
            <input type="number" value={offer.minutes} min="10" step="10" onChange={(e) => setOffer({ ...offer, minutes: e.target.value })} style={{ width: 70 }} title="Minutes available" />
            <select value={offer.provider_id} onChange={(e) => setOffer({ ...offer, provider_id: e.target.value })} style={{ width: 'auto' }}>
              <option value="">Any provider</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button className="small primary" onClick={send}>Text the first 5 who fit</button>
          {err && <div className="error">{err.message}</div>}
          {result && <div className="muted" style={{ fontSize: 12 }}>{result.sent.length ? `Texted ${result.sent.map((s) => s.name).join(', ')}.` : 'Nobody on the list fits that time.'}</div>}
        </div>
      )}
    </div>
  );
}
