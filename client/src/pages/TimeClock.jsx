import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Clock, LogIn, LogOut, Coffee, UtensilsCrossed, Play, Users, CalendarDays, Wrench, BadgeCheck, Download, Plane, ChartColumn, Settings as SettingsIcon,
  ChevronLeft, ChevronRight, Copy, Save, AlertTriangle, CheckCircle2, Lock, Unlock, TabletSmartphone, KeyRound, Plus, X, Delete, RotateCcw,
} from 'lucide-react';
import { api, download } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import { fmtDate, fmtTime, practiceToday, shiftDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import './timeclock.css';

// Time clock (TC1–TC5, docs/workflows/specs/TC-timeclock.md): clock in and out, breaks, schedules, fixes,
// pay-period approval, payroll files, time off and reports. The shared tablet is <Kiosk /> below.

// ---------- formatting ----------
const hm = (min) => (min == null ? '—' : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`);
const hrs = (min) => (min == null ? '—' : (Math.round((min / 60) * 100) / 100).toFixed(2));
const t12 = (local) => (local ? fmtTime(local) : '—');
const hm12 = (hhmm) => (hhmm ? fmtTime(`0000-00-00 ${hhmm}`) : '');
const shortTime = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`;
};
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const mins = (m) => (!m ? '' : m < 60 ? `${m}m` : hm(m).replace(/ 00m$/, ''));
const FLAG_TEXT = {
  late: (m) => `Late ${mins(m)}`.trim(), early: (m) => `Early ${mins(m)}`.trim(), early_out: (m) => `Left ${mins(m)} early`, late_out: (m) => `Stayed ${mins(m)} late`,
  unscheduled: () => 'Not scheduled', forgot_out: () => 'Forgot to clock out?', overtime: (m) => `Overtime +${hm(m)}`, near_overtime: (m) => `${hm(m)} to overtime`, daily_overtime: (m) => `Daily OT +${hm(m)}`,
};
const flagTone = (k) => (['late', 'forgot_out', 'overtime', 'daily_overtime'].includes(k) ? 'danger' : ['early', 'early_out', 'late_out', 'near_overtime', 'unscheduled'].includes(k) ? 'warn' : 'info');
const Flag = ({ kind, minutes }) => <span className={`tc-flag ${flagTone(kind)}`}>{(FLAG_TEXT[kind] || (() => kind))(minutes)}</span>;
const punchFlags = (p) => [p.in_flag && p.in_flag !== 'on_time' && { kind: p.in_flag, minutes: p.in_flag_minutes }, p.out_flag && !['on_time', 'unscheduled'].includes(p.out_flag) && { kind: p.out_flag, minutes: p.out_flag_minutes }].filter(Boolean);

const TABS = [
  ['me', 'My time', Clock, false], ['today', 'Today', Users, true], ['schedule', 'Schedules', CalendarDays, false], ['fix', 'Corrections', Wrench, true],
  ['period', 'Pay period', BadgeCheck, true], ['pto', 'Time off', Plane, false], ['export', 'Export', Download, true], ['reports', 'Reports', ChartColumn, true], ['settings', 'Settings', SettingsIcon, true],
];

export default function TimeClock() {
  const { can } = useAuth();
  const manager = can('timeclock:manage');
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => !t[3] || manager);
  const tab = tabs.some((t) => t[0] === params.get('tab')) ? params.get('tab') : 'me';
  const go = (k, extra = {}) => setParams({ ...(k === 'me' ? {} : { tab: k }), ...extra });
  useShortcuts(tabs.map(([k, text], i) => ({ combo: `alt+${i + 1}`, handler: () => go(k), label: `Time clock: ${text}`, section: 'Time clock' })));
  return (
    <div className="tc">
      <div className="page-header">
        <h1><Clock size={20} className="tc-h-icon" aria-hidden /> Time clock</h1>
      </div>
      <div className="tabs tc-tabs" role="tablist">
        {tabs.map(([k, text, Icon], i) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => go(k)} title={`Alt+${i + 1}`}>
            <Icon size={15} aria-hidden /> {text}
          </button>
        ))}
      </div>
      {tab === 'me' && <MyTime />}
      {tab === 'today' && <TodayBoard onFix={(uid) => go('fix', { user: String(uid) })} />}
      {tab === 'schedule' && <Schedules manager={manager} />}
      {tab === 'fix' && <Corrections initialUser={params.get('user') || ''} />}
      {tab === 'period' && <PayPeriod start={params.get('period')} onPeriod={(s) => go('period', { period: s })} onExport={(s) => go('export', { period: s })} />}
      {tab === 'pto' && <TimeOff manager={manager} />}
      {tab === 'export' && <Export start={params.get('period')} onPeriod={(s) => go('export', { period: s })} onReview={(s) => go('period', { period: s })} />}
      {tab === 'reports' && <Reports />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

// ============ My time: the big button ============
function MyTime() {
  const { data: me, reload, error } = useApi('/timeclock/me');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (tick) reload(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useCallback(async (path, body = {}) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post(path, body);
      toast(r.message || 'Done');
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [reload]);
  const primary = me ? (me.clocked_in ? ['/timeclock/out'] : ['/timeclock/in']) : null;
  const blocked = me && !me.clocked_in && me.window?.blocked;
  useShortcuts([{ combo: 'i', handler: () => primary && !busy && !blocked && act(primary[0]), label: me?.clocked_in ? 'Clock out' : 'Clock in', section: 'Time clock', enabled: !!me }]);
  if (error) return <ErrorBox error={error} />;
  if (!me) return <div className="card">Loading…</div>;
  const state = me.on_break ? 'break' : me.clocked_in ? 'in' : 'out';
  return (
    <div className="tc-me">
      <section className={`card tc-hero ${state}`}>
        <div className="tc-hero-status">
          <span className={`tc-dot ${state}`} aria-hidden />
          {state === 'out' && 'You’re clocked out'}
          {state === 'in' && <>Clocked in since <strong>{t12(me.clocked_in)}</strong></>}
          {state === 'break' && <>On {me.on_break.kind === 'lunch' ? 'lunch' : 'a break'} since <strong>{t12(me.on_break.since)}</strong></>}
        </div>
        <div className="tc-hero-shift muted">
          {me.shift && !me.shift.off ? `Your shift today: ${hm12(me.shift.start_time)} – ${hm12(me.shift.end_time)}` : 'You’re not on today’s schedule'}
        </div>
        <button className={`tc-big ${state === 'out' ? 'in' : 'out'}`} disabled={busy || blocked || state === 'break'} onClick={() => act(primary[0])} aria-keyshortcuts="i">
          {state === 'out' ? <LogIn size={30} aria-hidden /> : <LogOut size={30} aria-hidden />}
          <span>{state === 'out' ? 'Clock in' : 'Clock out'}</span>
          <kbd>I</kbd>
        </button>
        {blocked && <div className="tc-note warn"><AlertTriangle size={15} aria-hidden /> Clock-in opens at {hm12(me.window.opens_at)} (your shift starts {hm12(me.shift?.start_time)}).</div>}
        {!blocked && me.window?.flag === 'early' && <div className="tc-note warn">It’s {me.window.minutes} minutes before your shift — clocking in now will be flagged for your manager.</div>}
        {state !== 'out' && (
          <div className="tc-break-row">
            {state === 'in' && <>
              <button disabled={busy} onClick={() => act('/timeclock/break/start', { kind: 'break' })}><Coffee size={16} aria-hidden /> Start break</button>
              <button disabled={busy} onClick={() => act('/timeclock/break/start', { kind: 'lunch' })}><UtensilsCrossed size={16} aria-hidden /> Start lunch</button>
            </>}
            {state === 'break' && <button className="primary" disabled={busy} onClick={() => act('/timeclock/break/end')}><Play size={16} aria-hidden /> I’m back</button>}
          </div>
        )}
        <ErrorBox error={err} />
      </section>
      <div className="tc-stats">
        <Stat label="Today" value={hm(me.today_minutes)} />
        <Stat label="This week" value={hm(me.week_minutes)} sub={me.overtime_minutes_left != null ? (me.overtime_minutes_left > 0 ? `${hm(me.overtime_minutes_left)} until overtime` : 'In overtime') : null} tone={me.overtime_minutes_left === 0 ? 'warn' : null} />
        <Stat label="Pay period" value={`${fmtDate(me.period.start).replace(/, \d{4}$/, '')} – ${fmtDate(me.period.end).replace(/, \d{4}$/, '')}`} small />
        <Stat label="Time off balance" value={hm(me.pto_balance_minutes)} tone={me.pto_balance_minutes < 0 ? 'warn' : null} />
      </div>
      <div className="tc-two">
        <section className="card">
          <h2 className="tc-h2">Today’s punches</h2>
          {me.punches.length ? (
            <ul className="tc-punches">
              {me.punches.map((p) => (
                <li key={p.id}>
                  <span>{t12(p.clock_in)} → {p.clock_out ? t12(p.clock_out) : <em>now</em>}</span>
                  <span className="muted">{p.minutes != null ? hm(p.minutes) : ''}{p.break_minutes ? ` · ${p.break_minutes}m break` : ''}</span>
                  <span>{punchFlags(p).map((f, i) => <Flag key={i} {...f} />)}{p.corrected && <span className="tc-flag info">Fixed by manager</span>}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing yet today.</p>}
        </section>
        <PinCard hasPin={me.has_pin} onDone={reload} />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone, small }) {
  return (
    <div className={`card stat tc-stat${tone ? ` ${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className={`value${small ? ' small' : ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function PinCard({ hasPin, onDone }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.post('/timeclock/pin', { pin });
      setPin('');
      toast('PIN saved — use it on the office time-clock tablet');
      onDone();
    } catch (x) { setErr(x); }
  };
  return (
    <section className="card">
      <h2 className="tc-h2"><KeyRound size={16} aria-hidden /> Tablet PIN</h2>
      <p className="muted tc-small">{hasPin ? 'You have a PIN for the shared time-clock tablet. Type a new one to change it.' : 'Set a 4–8 digit PIN to clock in on the office’s shared tablet.'}</p>
      <form className="inline" onSubmit={save}>
        <input inputMode="numeric" autoComplete="off" type="password" pattern="\d{4,8}" maxLength={8} placeholder="New PIN" aria-label="New PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <button className="primary" disabled={pin.length < 4}>{hasPin ? 'Change PIN' : 'Set PIN'}</button>
      </form>
      <ErrorBox error={err} />
    </section>
  );
}

// ============ Today board (managers) ============
const STATUS = { in: ['In', 'ok'], break: ['On break', 'info'], lunch: ['At lunch', 'info'], late: ['Late', 'danger'], missing: ['Missing', 'danger'], expected: ['Due later', 'muted'], out: ['Gone for the day', 'muted'], pto: ['Time off', 'info'], off: ['Off', 'muted'] };
function TodayBoard({ onFix }) {
  const { data, reload, error } = useApi('/timeclock/today');
  useLiveEvents((e) => e.type === 'timeclock' && reload());
  useEffect(() => { const t = setInterval(reload, 60_000); return () => clearInterval(t); }, [reload]);
  const [filter, setFilter] = useState('all');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const c = data.counts;
  const pills = [['all', 'Everyone', data.people.length], ['in', 'In', c.in], ['break', 'On break', c.on_break], ['late', 'Late', c.late, 'danger'], ['missing', 'Missing', c.missing, 'danger'], ['expected', 'Due later', c.expected], ['ot', 'Overtime watch', c.overtime, 'warn']];
  const shown = data.people.filter((p) => filter === 'all' || (filter === 'break' ? ['break', 'lunch'].includes(p.status) : filter === 'ot' ? p.flags.some((f) => /overtime/.test(f.kind)) : p.status === filter));
  return (
    <div>
      <div className="tc-pills" role="group" aria-label="Show">
        {pills.map(([k, text, n, tone]) => (
          <button key={k} className={`tc-pill${filter === k ? ' active' : ''}${n && tone ? ` ${tone}` : ''}`} onClick={() => setFilter(k)}>{text} <strong>{n}</strong></button>
        ))}
        <span className="muted tc-small tc-live">Live · {t12(data.now)}</span>
      </div>
      <div className="tc-board">
        {shown.map((p) => {
          const [text, tone] = STATUS[p.status] || [p.status, 'muted'];
          return (
            <article key={p.user_id} className={`card tc-person ${tone}`}>
              <header>
                <strong>{p.name}</strong>
                <span className={`tc-status ${tone}`}>{text}{p.since && ['in', 'break', 'lunch', 'out'].includes(p.status) ? ` · ${t12(p.since)}` : ''}</span>
              </header>
              <div className="muted tc-small">{p.shift && !p.shift.off ? `Shift ${hm12(p.shift.start_time)} – ${hm12(p.shift.end_time)}` : 'Not scheduled'} · today {hm(p.today_minutes)} · week {hm(p.week_minutes)}</div>
              {p.flags.length > 0 && <div className="tc-flags">{p.flags.map((f, i) => <Flag key={i} {...f} />)}</div>}
              {(p.flags.some((f) => f.kind === 'forgot_out') || ['missing', 'late'].includes(p.status)) && <button className="small tc-fix" onClick={() => onFix(p.user_id)}><Wrench size={13} aria-hidden /> Fix time</button>}
            </article>
          );
        })}
        {!shown.length && <div className="empty">No one here.</div>}
      </div>
    </div>
  );
}

// ============ Schedules ============
function Schedules({ manager }) {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [week, setWeek] = useState(today);
  const { data, reload, error } = useApi(`/timeclock/schedule?week=${week}`);
  const [editing, setEditing] = useState(null);
  const [drag, setDrag] = useState(null);
  const [err, setErr] = useState(null);
  useShortcuts([
    { combo: 'arrowleft', handler: () => setWeek((w) => shiftDate(w, -7)), label: 'Previous week', section: 'Schedules' },
    { combo: 'arrowright', handler: () => setWeek((w) => shiftDate(w, 7)), label: 'Next week', section: 'Schedules' },
  ]);
  const save = async (body, msg) => {
    setErr(null);
    try {
      await api.put('/timeclock/shifts', body);
      toast(msg);
      setEditing(null);
      reload();
    } catch (e) { setErr(e); }
  };
  const copyLast = async () => {
    try {
      const r = await api.post('/timeclock/schedule/copy', { from_week: shiftDate(data.week_start, -7), to_week: data.week_start });
      toast(`Copied ${r.copied} shift${r.copied === 1 ? '' : 's'} from last week${r.skipped ? ` (${r.skipped} already set, left alone)` : ''}`);
      reload();
    } catch (e) { setErr(e); }
  };
  const makeUsual = async () => {
    try {
      await api.post('/timeclock/templates/from-week', { week: data.week_start });
      toast('This week is now everyone’s usual week');
      reload();
    } catch (e) { setErr(e); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const drop = (uid, date) => {
    if (!drag || (drag.user_id === uid && drag.date === date)) return;
    const s = drag.shift;
    save(s && !s.off ? { user_id: uid, date, start_time: s.start_time, end_time: s.end_time, break_minutes: s.break_minutes, location_id: s.location_id } : { user_id: uid, date, off: true }, 'Shift copied');
    setDrag(null);
  };
  return (
    <div className="card">
      <div className="tc-toolbar">
        <div className="inline">
          <button className="small" onClick={() => setWeek(shiftDate(data.week_start, -7))} aria-label="Previous week"><ChevronLeft size={16} /></button>
          <strong>Week of {fmtDate(data.week_start)}</strong>
          <button className="small" onClick={() => setWeek(shiftDate(data.week_start, 7))} aria-label="Next week"><ChevronRight size={16} /></button>
          <button className="small" onClick={() => setWeek(today)}>This week</button>
        </div>
        {manager && (
          <div className="inline">
            <button className="small" onClick={copyLast}><Copy size={14} aria-hidden /> Copy last week</button>
            <button className="small" onClick={makeUsual} title="Save this week as the pattern every week starts from"><Save size={14} aria-hidden /> Make this the usual week</button>
          </div>
        )}
      </div>
      <ErrorBox error={err} />
      <div className="tc-grid-wrap">
        <table className="tc-grid">
          <thead>
            <tr><th>Person</th>{data.days.map((d) => <th key={d} className={d === today ? 'today' : ''}>{DAY[dow(d)]} <span className="muted">{Number(d.slice(8))}</span></th>)}<th className="num">Hours</th></tr>
          </thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.user_id}>
                <th scope="row">{p.name}<div className="muted tc-small">{p.role?.replace(/_/g, ' ')}</div></th>
                {data.days.map((d) => {
                  const s = p.days[d];
                  const isEditing = editing?.user_id === p.user_id && editing?.date === d;
                  return (
                    <td key={d} className={`tc-cell${s?.off ? ' off' : s ? ` on ${s.source}` : ''}${d === today ? ' today' : ''}`}
                      draggable={manager && !!s} onDragStart={() => setDrag({ user_id: p.user_id, date: d, shift: s })} onDragOver={(e) => manager && drag && e.preventDefault()} onDrop={() => drop(p.user_id, d)}>
                      {isEditing ? <ShiftEditor shift={s} onSave={(b) => save({ user_id: p.user_id, date: d, ...b }, 'Shift saved')} onOff={() => save({ user_id: p.user_id, date: d, off: true }, 'Marked as a day off')} onClear={() => save({ user_id: p.user_id, date: d, clear: true }, 'Back to the usual week')} onCancel={() => setEditing(null)} />
                        : (
                          <button className="tc-cell-btn" disabled={!manager} onClick={() => setEditing({ user_id: p.user_id, date: d })} aria-label={`${p.name} ${DAY[dow(d)]}: ${s?.off ? 'off' : s ? `${s.start_time} to ${s.end_time}` : 'no shift'}`}>
                            {s?.off ? 'Off' : s ? `${shortTime(s.start_time)}–${shortTime(s.end_time)}` : manager ? <Plus size={13} className="muted" /> : ''}
                            {s?.source === 'override' && !s.off && <span className="tc-changed" title="Changed for this day">•</span>}
                          </button>
                        )}
                    </td>
                  );
                })}
                <td className="num">{hrs(p.scheduled_minutes)}</td>
              </tr>
            ))}
            {!data.people.length && <tr><td colSpan={9} className="muted">No one is on the time clock yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {manager && <p className="muted tc-small">Click a day to set a shift. Drag a shift onto another day or person to copy it. ← / → change the week. A dot means the day differs from the usual week.</p>}
    </div>
  );
}

function ShiftEditor({ shift, onSave, onOff, onClear, onCancel }) {
  const [f, setF] = useState({ start_time: shift?.start_time || '08:00', end_time: shift?.end_time || '17:00', break_minutes: shift?.break_minutes ?? 60 });
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <form className="tc-shift-editor" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, break_minutes: Number(f.break_minutes) || 0 }); }} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <input ref={first} type="time" aria-label="Start" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} />
      <input type="time" aria-label="End" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} />
      <label className="tc-small">Break <input type="number" min="0" max="240" value={f.break_minutes} onChange={(e) => setF({ ...f, break_minutes: e.target.value })} /></label>
      <div className="tc-editor-actions">
        <button className="small primary" type="submit">Save</button>
        <button className="small" type="button" onClick={onOff}>Off</button>
        <button className="small" type="button" onClick={onClear} title="Back to the usual week">Usual</button>
        <button className="small" type="button" onClick={onCancel} aria-label="Cancel"><X size={13} /></button>
      </div>
    </form>
  );
}

// ============ Corrections ============
const toInput = (local) => (local ? local.replace(' ', 'T') : '');
const fromInput = (v) => (v ? v.replace('T', ' ').slice(0, 16) : null);
function Corrections({ initialUser }) {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const { data: settings } = useApi('/timeclock/settings');
  const [range, setRange] = useState(null);
  const [who, setWho] = useState(initialUser);
  useEffect(() => { if (settings && !range) setRange({ from: settings.current_period.start, to: today }); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, reload, error } = useApi(range ? `/timeclock?from=${range.from}&to=${range.to}${who ? `&user_id=${who}` : ''}` : null);
  const { data: history, reload: reloadHistory } = useApi(range ? `/timeclock/corrections?from=${range.from}&to=${range.to}` : null);
  const { data: staff } = useApi('/timeclock/staff');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => { reload(); reloadHistory(); };
  if (error) return <ErrorBox error={error} />;
  if (!data || !range) return <div className="card">Loading…</div>;
  return (
    <div className="card">
      <div className="tc-toolbar">
        <div className="inline">
          <input type="date" aria-label="From" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
          <select aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {(staff || []).filter((s) => s.active).map((s) => <option key={s.user_id} value={s.user_id}>{s.name}</option>)}
          </select>
        </div>
        <button className="small primary" onClick={() => setAdding(true)}><Plus size={14} aria-hidden /> Add missed time</button>
      </div>
      <p className="muted tc-small">Punches are never edited: a fix is saved alongside the original with your reason, and both stay on record.</p>
      <table className="compact-table tc-table">
        <thead><tr><th>Person</th><th>Day</th><th>In</th><th>Out</th><th className="num">Break</th><th className="num">Worked</th><th>Flags</th><th /></tr></thead>
        <tbody>
          {adding && <PunchRow staff={staff || []} today={today} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
          {data.punches.map((p) => (editing === p.id
            ? <PunchRow key={p.id} punch={p} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />
            : (
              <tr key={p.id} className={p.clock_out ? '' : 'tc-open-row'}>
                <td>{p.user_name}</td>
                <td>{DAY[dow(p.date)]} {fmtDate(p.date)}</td>
                <td>{t12(p.clock_in)}{p.corrected && p.original_in !== p.clock_in && <s className="tc-orig" title="As punched">{t12(p.original_in)}</s>}</td>
                <td>{p.clock_out ? t12(p.clock_out) : <em className="tc-warn-text">still in</em>}{p.corrected && p.original_out !== p.clock_out && <s className="tc-orig" title="As punched">{p.original_out ? t12(p.original_out) : 'none'}</s>}</td>
                <td className="num">{p.break_minutes ? `${p.break_minutes}m` : '—'}</td>
                <td className="num">{hm(p.minutes)}{p.overtime ? <span className="tc-ot"> +{hm(p.overtime)} OT</span> : ''}</td>
                <td>{punchFlags(p).map((f, i) => <Flag key={i} {...f} />)}{p.corrected && <span className="tc-flag info">Fixed</span>}{p.source === 'kiosk' && <span className="tc-flag muted">Tablet</span>}</td>
                <td><button className="small" onClick={() => setEditing(p.id)}>Fix</button></td>
              </tr>
            )))}
          {!data.punches.length && !adding && <tr><td colSpan={8} className="muted">No time recorded in these dates.</td></tr>}
        </tbody>
      </table>
      {history?.length > 0 && (
        <details className="tc-history">
          <summary>Fix history ({history.length})</summary>
          <ul>
            {history.map((c) => (
              <li key={c.id}>
                <strong>{c.user_name}</strong> — {c.kind === 'add' ? `added ${t12(c.new_in)}–${t12(c.new_out)}` : c.kind === 'void' ? `removed ${t12(c.before_in)}–${t12(c.before_out)}` : `${t12(c.before_in)}–${t12(c.before_out)} → ${t12(c.new_in)}–${t12(c.new_out)}${c.new_break !== c.before_break ? `, break ${c.before_break ?? 0}→${c.new_break}m` : ''}`}
                <span className="muted"> · “{c.reason}” · {c.by_name}, {fmtDate(c.created_at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PunchRow({ punch, staff, today, onCancel, onDone }) {
  const [f, setF] = useState(punch
    ? { clock_in: toInput(punch.clock_in), clock_out: toInput(punch.clock_out), break_minutes: punch.break_minutes ?? 0, reason: '' }
    : { user_id: staff.find((s) => s.active)?.user_id || '', clock_in: `${today}T08:00`, clock_out: `${today}T17:00`, break_minutes: 60, reason: '' });
  const [err, setErr] = useState(null);
  const [removing, setRemoving] = useState(false);
  const save = async (e) => {
    e?.preventDefault();
    setErr(null);
    try {
      if (removing) await api.post(`/timeclock/punches/${punch.id}/void`, { reason: f.reason });
      else if (punch) await api.post(`/timeclock/punches/${punch.id}/correct`, { clock_in: fromInput(f.clock_in), ...(f.clock_out ? { clock_out: fromInput(f.clock_out) } : {}), break_minutes: Number(f.break_minutes) || 0, reason: f.reason });
      else await api.post('/timeclock/punches', { user_id: Number(f.user_id), clock_in: fromInput(f.clock_in), clock_out: fromInput(f.clock_out), break_minutes: Number(f.break_minutes) || 0, reason: f.reason });
      toast(removing ? 'Punch removed (kept on record)' : punch ? 'Punch fixed' : 'Time added');
      onDone();
    } catch (x) { setErr(x); }
  };
  return (
    <tr className="tc-edit-row">
      <td colSpan={8}>
        <form className="tc-edit" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
          {punch ? <strong>{punch.user_name}</strong> : (
            <select aria-label="Person" value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>{staff.filter((s) => s.active).map((s) => <option key={s.user_id} value={s.user_id}>{s.name}</option>)}</select>
          )}
          {!removing && <>
            <label>In <input type="datetime-local" value={f.clock_in} onChange={(e) => setF({ ...f, clock_in: e.target.value })} autoFocus /></label>
            <label>Out <input type="datetime-local" value={f.clock_out} onChange={(e) => setF({ ...f, clock_out: e.target.value })} /></label>
            <label>Unpaid break <input type="number" min="0" max="600" className="tc-num" value={f.break_minutes} onChange={(e) => setF({ ...f, break_minutes: e.target.value })} /> min</label>
          </>}
          <label className="tc-grow">Why <input required value={f.reason} placeholder={removing ? 'e.g. entered for the wrong person' : 'e.g. forgot to clock out'} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus={removing} /></label>
          <button className={`small ${removing ? 'danger' : 'primary'}`} disabled={!f.reason.trim()}>{removing ? 'Remove punch' : 'Save'}</button>
          {punch && <button type="button" className="small" onClick={() => setRemoving(!removing)}>{removing ? 'Keep it' : 'Remove…'}</button>}
          <button type="button" className="small" onClick={onCancel} aria-label="Cancel"><X size={13} /></button>
        </form>
        <ErrorBox error={err} />
        {punch?.corrected && <div className="muted tc-small">As punched: {t12(punch.original_in)} – {punch.original_out ? t12(punch.original_out) : 'no clock-out'}</div>}
      </td>
    </tr>
  );
}

// ============ Pay period review ============
function usePeriod(start) {
  return useApi(`/timeclock/period${start ? `?date=${start}` : ''}`);
}
function PeriodNav({ data, onPeriod }) {
  return (
    <div className="inline">
      <button className="small" onClick={() => onPeriod(data.prev.start)} aria-label="Previous pay period"><ChevronLeft size={16} /></button>
      <strong>{fmtDate(data.period.start)} – {fmtDate(data.period.end)}</strong>
      <button className="small" onClick={() => onPeriod(data.next.start)} aria-label="Next pay period"><ChevronRight size={16} /></button>
      {!data.ended && <span className="tc-flag info">In progress</span>}
    </div>
  );
}
function PayPeriod({ start, onPeriod, onExport }) {
  const { data, reload, error } = usePeriod(start);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState(null);
  const [open, setOpen] = useState(null);
  const approve = async (ids) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/timeclock/period/approve', { start: data.period.start, ...(ids ? { user_ids: ids } : {}) });
      toast(`Approved ${r.approved.length} ${r.approved.length === 1 ? 'person' : 'people'}${r.skipped.length ? ` · ${r.skipped.length} not yet: ${r.skipped.map((s) => `${s.name} (${s.why})`).join(', ')}` : ''}`, { tone: r.skipped.length ? 'warn' : 'ok' });
      reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  useShortcuts([{ combo: 'shift+a', handler: () => data && !busy && approve(), label: 'Approve all ready', section: 'Pay period', enabled: !!data?.ended }]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const ready = data.people.filter((p) => p.ready && !p.approval && p.minutes.total > 0);
  return (
    <div className="card">
      <div className="tc-toolbar">
        <PeriodNav data={data} onPeriod={onPeriod} />
        <div className="inline">
          <button className="primary" disabled={busy || !data.ended || !ready.length} onClick={() => approve()} aria-keyshortcuts="Shift+A">
            <CheckCircle2 size={16} aria-hidden /> Approve all ready ({ready.length})
          </button>
          {data.approved_count > 0 && <button onClick={() => onExport(data.period.start)}><Download size={15} aria-hidden /> Export</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      {!data.ended && <p className="tc-note info">This pay period isn’t over yet — you can review it now and approve it after {fmtDate(data.period.end)}.</p>}
      <table className="compact-table tc-table">
        <thead><tr><th>Person</th><th className="num">Regular</th><th className="num">Overtime</th><th className="num">Double</th><th className="num">PTO</th><th className="num">Holiday</th><th className="num">Total</th><th>Look at</th><th>Status</th></tr></thead>
        <tbody>
          {data.people.map((p) => (
            <PeriodRow key={p.user_id} p={p} open={open === p.user_id} onToggle={() => setOpen(open === p.user_id ? null : p.user_id)} busy={busy}
              onApprove={() => approve([p.user_id])} reopening={reopening === p.user_id} onReopen={() => setReopening(p.user_id)} onReopened={() => { setReopening(null); reload(); }} onCancelReopen={() => setReopening(null)} />
          ))}
          {!data.people.length && <tr><td colSpan={9} className="muted">No hours in this pay period.</td></tr>}
        </tbody>
        <tfoot><tr><th>Total</th>{['regular', 'overtime', 'doubletime', 'pto', 'holiday', 'total'].map((k) => <th key={k} className="num">{hrs(data.totals[k])}</th>)}<th colSpan={2}>{data.approved_count} approved · {data.waiting_count} waiting</th></tr></tfoot>
      </table>
      {data.unlocks?.length > 0 && <details className="tc-history"><summary>Reopened approvals ({data.unlocks.length})</summary><ul>{data.unlocks.map((u) => <li key={u.id}>{data.people.find((p) => p.user_id === u.user_id)?.name} — “{u.unlock_reason}” · {u.unlocked_by_name}, {fmtDate(u.unlocked_at)}</li>)}</ul></details>}
      <p className="muted tc-small">Hours in hours (decimal). Approving locks a person’s time for this period; reopening needs a reason and is recorded. Shift+A approves everyone who’s ready.</p>
    </div>
  );
}

function PeriodRow({ p, open, onToggle, busy, onApprove, reopening, onReopen, onReopened, onCancelReopen }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const f = p.flags;
  const looks = [f.late && `${f.late} late`, f.early && `${f.early} early`, f.early_out && `${f.early_out} left early`, f.unscheduled && `${f.unscheduled} unscheduled`, f.corrected && `${f.corrected} fixed`].filter(Boolean);
  const reopen = async (e) => {
    e.preventDefault();
    try {
      await api.post('/timeclock/period/unlock', { approval_id: p.approval.id, reason });
      toast(`${p.name}’s hours are open again`);
      onReopened();
    } catch (x) { setErr(x); }
  };
  return (
    <>
      <tr className={p.approval ? 'tc-approved' : ''}>
        <td><button className="link" onClick={onToggle} aria-expanded={open}>{p.name}</button>{p.payroll_id && <div className="muted tc-small">#{p.payroll_id}</div>}</td>
        {['regular', 'overtime', 'doubletime', 'pto', 'holiday', 'total'].map((k) => <td key={k} className={`num${k === 'total' ? ' strong' : ''}${k === 'overtime' && p.minutes[k] ? ' tc-ot' : ''}`}>{p.minutes[k] ? hrs(p.minutes[k]) : '—'}</td>)}
        <td className="tc-small">{looks.length ? looks.join(' · ') : <span className="muted">—</span>}</td>
        <td>
          {p.approval ? (
            <span className="inline">
              <span className="tc-flag ok"><Lock size={11} aria-hidden /> Approved</span>
              {p.changed_since_approval && <span className="tc-flag danger" title="The hours now differ from what was approved">Changed</span>}
              <button className="small" onClick={onReopen} title="Reopen with a reason"><Unlock size={12} aria-hidden /></button>
            </span>
          ) : p.open ? <span className="tc-flag danger">Still clocked in</span>
            : p.ready ? <button className="small primary" disabled={busy} onClick={onApprove}>Approve</button>
              : <span className="muted tc-small">After the period ends</span>}
        </td>
      </tr>
      {reopening && (
        <tr className="tc-edit-row"><td colSpan={9}>
          <form className="tc-edit" onSubmit={reopen} onKeyDown={(e) => e.key === 'Escape' && onCancelReopen()}>
            <label className="tc-grow">Why reopen {p.name}’s approved hours? <input autoFocus required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. missed a lunch break" /></label>
            <button className="small danger" disabled={!reason.trim()}>Reopen</button>
            <button type="button" className="small" onClick={onCancelReopen}>Cancel</button>
          </form>
          <ErrorBox error={err} />
        </td></tr>
      )}
      {open && (
        <tr className="tc-detail-row"><td colSpan={9}>
          <table className="compact-table">
            <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="num">Break</th><th className="num">Worked</th><th className="num">Reg</th><th className="num">OT</th><th className="num">DT</th><th>Flags</th></tr></thead>
            <tbody>
              {p.punches.map((x) => (
                <tr key={x.id}>
                  <td>{DAY[dow(x.date)]} {fmtDate(x.date)}</td><td>{t12(x.clock_in)}</td><td>{x.clock_out ? t12(x.clock_out) : <em>open</em>}</td>
                  <td className="num">{x.break_minutes || '—'}</td><td className="num">{hm(x.minutes)}</td><td className="num">{hrs(x.regular)}</td><td className="num">{x.overtime ? hrs(x.overtime) : ''}</td><td className="num">{x.doubletime ? hrs(x.doubletime) : ''}</td>
                  <td>{punchFlags(x).map((fl, i) => <Flag key={i} {...fl} />)}{x.corrected && <span className="tc-flag info">Fixed</span>}</td>
                </tr>
              ))}
              {p.days.filter((d) => d.pto || d.holiday).map((d) => <tr key={`d${d.date}`}><td>{DAY[dow(d.date)]} {fmtDate(d.date)}</td><td colSpan={8} className="muted">{d.pto ? `Time off ${hm(d.pto)}` : ''}{d.pto && d.holiday ? ' · ' : ''}{d.holiday ? `Holiday ${hm(d.holiday)}` : ''}</td></tr>)}
            </tbody>
          </table>
        </td></tr>
      )}
    </>
  );
}

// ============ Export ============
const FORMAT_ORDER = ['gusto', 'adp', 'paychex', 'quickbooks', 'csv'];
const FORMAT_LABEL = { gusto: 'Gusto', adp: 'ADP Workforce Now', paychex: 'Paychex Flex', quickbooks: 'QuickBooks Payroll', csv: 'Plain CSV' };
function Export({ start, onPeriod, onReview }) {
  const { data, reload, error } = usePeriod(start);
  const [err, setErr] = useState(null);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState(null);
  const run = async (format) => {
    setBusy(format);
    setErr(null);
    try {
      await download(`/timeclock/period/export.csv?start=${data.period.start}&format=${format}${partial ? '&partial=1' : ''}`, `payroll-${format}-${data.period.start}.csv`);
      toast(`${data.formats[format]} file downloaded and recorded`);
      reload();
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const rec = data.reconciliation;
  const canExport = data.approved_count > 0 && (!data.waiting_count || partial);
  return (
    <div className="tc-export">
      <section className="card">
        <div className="tc-toolbar"><PeriodNav data={data} onPeriod={onPeriod} /></div>
        {data.waiting_count > 0 && (
          <div className="tc-note warn">
            <AlertTriangle size={15} aria-hidden /> {data.waiting_count} {data.waiting_count === 1 ? 'person’s' : 'people’s'} hours aren’t approved yet.
            <button className="link" onClick={() => onReview(data.period.start)}>Review and approve</button>
            <label className="tc-small inline"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} /> Export only the approved people</label>
          </div>
        )}
        <div className="tc-formats">
          {FORMAT_ORDER.map((k) => (
            <button key={k} className="tc-format" disabled={!canExport || !!busy} onClick={() => run(k)}>
              <Download size={18} aria-hidden />
              <strong>{FORMAT_LABEL[k]}</strong>
              <span className="muted tc-small">{k === 'quickbooks' ? 'Time activities, one line per day' : k === 'csv' ? 'Hours by person and pay type' : 'Hours import file'}</span>
            </button>
          ))}
        </div>
        <ErrorBox error={err} />
        <p className="muted tc-small">Files only — nothing is sent to your payroll company. Totals by person and pay type (regular, overtime, double time, PTO, holiday) come from the approved hours. Each download is recorded with a fingerprint of the file.</p>
      </section>
      <section className={`card tc-rec ${rec ? (rec.ok ? 'ok' : 'bad') : ''}`}>
        <h2 className="tc-h2">Reconciliation</h2>
        {!rec ? <p className="muted">Approved: <strong>{hrs(data.approved_minutes)} h</strong>. Nothing exported for this period yet.</p> : (
          <>
            <p className="tc-rec-line">
              {rec.ok ? <CheckCircle2 size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
              Approved <strong>{hrs(rec.approved_minutes)} h</strong> {rec.ok ? '=' : '≠'} exported <strong>{hrs(rec.exported_minutes)} h</strong> <span className="muted">(latest file: {data.formats[rec.format]})</span>
            </p>
            {!rec.ok && <ul>{rec.differences.map((d, i) => <li key={i}>{d.name}: {d.type} approved {hrs(d.approved)} h, in the file {hrs(d.exported)} h — export again.</li>)}</ul>}
          </>
        )}
      </section>
      <section className="card">
        <h2 className="tc-h2">Files made for this period</h2>
        <table className="compact-table">
          <thead><tr><th>When</th><th>Format</th><th>By</th><th className="num">People</th><th className="num">Hours</th><th>Fingerprint</th></tr></thead>
          <tbody>
            {data.exports.map((e) => <tr key={e.id}><td>{fmtDate(e.created_at)} {e.created_at?.slice(11, 16)} UTC</td><td>{data.formats[e.format]}{e.partial ? ' (approved only)' : ''}</td><td>{e.created_by_name}</td><td className="num">{e.people}</td><td className="num">{hrs(e.total_minutes)}</td><td><code title={e.content_hash}>{e.content_hash.slice(0, 12)}</code></td></tr>)}
            {!data.exports.length && <tr><td colSpan={6} className="muted">None yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ============ Time off ============
function TimeOff({ manager }) {
  const { practice, user } = useAuth();
  const today = practiceToday(practice?.timezone);
  const { data, reload, error } = useApi('/timeclock/pto');
  const [f, setF] = useState({ start_date: today, end_date: today, hours_per_day: 8, note: '', kind: 'pto' });
  const [err, setErr] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [note, setNote] = useState('');
  const [adjust, setAdjust] = useState(null);
  const ask = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.post('/timeclock/pto', { ...f, hours_per_day: Number(f.hours_per_day) });
      toast('Time off requested');
      setF({ ...f, note: '' });
      reload();
    } catch (x) { setErr(x); }
  };
  const decide = async (q, approve) => {
    setErr(null);
    try {
      const r = await api.post(`/timeclock/pto/${q.id}/decide`, { approve, note: approve ? null : note });
      toast(approve ? `Approved${r.warning ? ` — ${r.warning}` : ''}` : 'Declined', { tone: r.warning ? 'warn' : 'ok' });
      setDeclining(null);
      setNote('');
      reload();
    } catch (x) { setErr(x); }
  };
  const [cancelling, setCancelling] = useState(null);
  const cancel = async (q, reason = 'Cancelled') => {
    try { await api.post(`/timeclock/pto/${q.id}/cancel`, { reason }); toast('Request cancelled'); setCancelling(null); setNote(''); reload(); } catch (x) { setErr(x); }
  };
  const saveAdjust = async (e) => {
    e.preventDefault();
    try { await api.post('/timeclock/pto/adjust', adjust); toast('Balance adjusted'); setAdjust(null); reload(); } catch (x) { setErr(x); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const pending = data.requests.filter((q) => q.status === 'pending');
  return (
    <div className="tc-two">
      <section className="card">
        <h2 className="tc-h2">Ask for time off</h2>
        <p className="muted tc-small">Your balance: <strong>{hm(data.my_balance)}</strong></p>
        <form className="tc-form" onSubmit={ask}>
          <label>First day <input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: e.target.value > f.end_date ? e.target.value : f.end_date })} /></label>
          <label>Last day <input type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></label>
          <label>Hours a day <input type="number" step="0.25" min="0.25" max="24" value={f.hours_per_day} onChange={(e) => setF({ ...f, hours_per_day: e.target.value })} /></label>
          <label>Kind <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="pto">Paid time off</option><option value="unpaid">Unpaid</option></select></label>
          <label className="full">Note <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Optional" /></label>
          <button className="primary">Send request</button>
        </form>
        <ErrorBox error={err} />
      </section>
      <section className="card">
        <h2 className="tc-h2">{manager ? `Requests${pending.length ? ` · ${pending.length} waiting` : ''}` : 'My requests'}</h2>
        <ul className="tc-requests">
          {data.requests.map((q) => (
            <li key={q.id} className={q.status}>
              <div>
                <strong>{manager ? q.user_name : ''}</strong> {fmtDate(q.start_date)}{q.end_date !== q.start_date ? ` – ${fmtDate(q.end_date)}` : ''} · {hm(q.total_minutes)} {q.kind === 'unpaid' ? 'unpaid' : ''}
                {q.note && <div className="muted tc-small">“{q.note}”</div>}
                {q.decision_note && <div className="muted tc-small">{q.decided_by_name}: “{q.decision_note}”</div>}
              </div>
              <div className="inline">
                <span className={`tc-flag ${q.status === 'approved' ? 'ok' : q.status === 'pending' ? 'warn' : 'muted'}`}>{q.status}</span>
                {manager && q.status === 'pending' && q.user_id !== user.id && declining !== q.id && <>
                  <button className="small primary" onClick={() => decide(q, true)}>Approve</button>
                  <button className="small" onClick={() => setDeclining(q.id)}>Decline</button>
                </>}
                {q.status === 'pending' && q.user_id === user.id && <button className="small" onClick={() => cancel(q)} aria-label="Cancel request"><X size={12} /></button>}
                {manager && q.status === 'approved' && cancelling !== q.id && <button className="small" onClick={() => { setCancelling(q.id); setNote(''); }} aria-label="Cancel approved time off"><X size={12} /></button>}
              </div>
              {cancelling === q.id && (
                <form className="tc-edit" onSubmit={(e) => { e.preventDefault(); cancel(q, note); }}>
                  <input autoFocus required placeholder="Why cancel approved time off? (kept on record)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="small danger" disabled={!note.trim()}>Cancel it</button>
                  <button type="button" className="small" onClick={() => setCancelling(null)}>Keep</button>
                </form>
              )}
              {declining === q.id && (
                <form className="tc-edit" onSubmit={(e) => { e.preventDefault(); decide(q, false); }}>
                  <input autoFocus required placeholder="Why? (they’ll see this)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="small danger" disabled={!note.trim()}>Decline</button>
                  <button type="button" className="small" onClick={() => setDeclining(null)}>Cancel</button>
                </form>
              )}
            </li>
          ))}
          {!data.requests.length && <li className="muted">No requests.</li>}
        </ul>
        {manager && (
          <>
            <h2 className="tc-h2">Balances</h2>
            <table className="compact-table">
              <tbody>
                {data.balances.map((b) => (
                  <tr key={b.user_id}><td>{b.name}</td><td className="num">{hm(b.minutes)}</td><td><button className="small" onClick={() => setAdjust({ user_id: b.user_id, hours: '', reason: '' })}>Adjust</button></td></tr>
                ))}
                {!data.balances.length && <tr><td className="muted">Balances appear once time off is earned or used.</td></tr>}
              </tbody>
            </table>
            {adjust && (
              <form className="tc-edit" onSubmit={saveAdjust}>
                <select aria-label="Person" value={adjust.user_id} onChange={(e) => setAdjust({ ...adjust, user_id: Number(e.target.value) })}>{data.balances.map((b) => <option key={b.user_id} value={b.user_id}>{b.name}</option>)}</select>
                <input type="number" step="0.25" className="tc-num" placeholder="± hours" required value={adjust.hours} onChange={(e) => setAdjust({ ...adjust, hours: e.target.value })} />
                <input className="tc-grow" placeholder="Why" required value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
                <button className="small primary">Save</button>
                <button type="button" className="small" onClick={() => setAdjust(null)}>Cancel</button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ============ Reports ============
function Reports() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const presets = useMemo(() => {
    const m = today.slice(0, 7);
    const lastM = shiftDate(`${m}-01`, -1).slice(0, 7);
    const lastEnd = shiftDate(`${m}-01`, -1);
    return [['This month', `${m}-01`, today], ['Last month', `${lastM}-01`, lastEnd], ['Last 90 days', shiftDate(today, -89), today], ['This year', `${today.slice(0, 4)}-01-01`, today]];
  }, [today]);
  const [range, setRange] = useState({ from: presets[0][1], to: presets[0][2] });
  const { data, error } = useApi(`/timeclock/reports?from=${range.from}&to=${range.to}`);
  if (error) return <ErrorBox error={error} />;
  const maxWeek = Math.max(1, ...(data?.weeks || []).map((w) => w.regular + w.overtime + w.doubletime));
  return (
    <div>
      <div className="tc-toolbar card">
        <div className="seg" role="group" aria-label="Dates">{presets.map(([l, f, t]) => <button key={l} className={range.from === f && range.to === t ? 'active' : ''} onClick={() => setRange({ from: f, to: t })}>{l}</button>)}</div>
        <div className="inline">
          <input type="date" aria-label="From" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          <input type="date" aria-label="To" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
        </div>
      </div>
      {!data ? <div className="card">Loading…</div> : (
        <>
          {data.labor && (
            <div className="tc-stats">
              <Stat label="Labor cost" value={money(data.labor.cost_cents)} sub="Rates × hours (overtime ×1.5, double ×2)" />
              <Stat label="Production" value={money(data.labor.production_cents)} sub="Charges in the ledger" />
              <Stat label="Labor % of production" value={data.labor.percent == null ? '—' : `${data.labor.percent}%`} tone={data.labor.percent > 30 ? 'warn' : null} />
              {data.labor.missing_rates.length > 0 && <Stat label="No pay rate" value={data.labor.missing_rates.length} sub={data.labor.missing_rates.join(', ')} tone="warn" />}
            </div>
          )}
          <section className="card">
            <h2 className="tc-h2">Hours and punctuality by person</h2>
            <table className="compact-table tc-table">
              <thead><tr><th>Person</th><th className="num">Regular</th><th className="num">Overtime</th><th className="num">Double</th><th className="num">PTO</th><th className="num">Holiday</th><th className="num">Late</th><th className="num">Avg late</th><th className="num">Left early</th><th className="num">Unscheduled</th><th className="num">Fixes</th>{data.rates && <th className="num">Cost</th>}</tr></thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.user_id}>
                    <td>{p.name}</td>
                    {['regular', 'overtime', 'doubletime', 'pto', 'holiday'].map((k) => <td key={k} className="num">{p.minutes[k] ? hrs(p.minutes[k]) : '—'}</td>)}
                    <td className={`num${p.late_count ? ' tc-warn-text' : ''}`}>{p.late_count || '—'}</td>
                    <td className="num">{p.late_count ? `${Math.round(p.late_minutes / p.late_count)}m` : '—'}</td>
                    <td className="num">{p.early_out_count || '—'}</td><td className="num">{p.unscheduled_count || '—'}</td><td className="num">{p.corrected_count || '—'}</td>
                    {data.rates && <td className="num">{p.cost_cents == null ? <span className="muted">no rate</span> : money(p.cost_cents)}</td>}
                  </tr>
                ))}
                {!data.people.length && <tr><td colSpan={12} className="muted">No hours in these dates.</td></tr>}
              </tbody>
            </table>
          </section>
          <div className="tc-two">
            <section className="card">
              <h2 className="tc-h2">Overtime by week</h2>
              <div className="tc-bars" role="img" aria-label="Hours per week, overtime highlighted">
                {data.weeks.map((w) => (
                  <div key={w.week_start} className="tc-bar-row">
                    <span className="tc-small muted">{fmtDate(w.week_start).replace(/, \d{4}$/, '')}</span>
                    <div className="tc-bar">
                      <i className="reg" style={{ width: `${(w.regular / maxWeek) * 100}%` }} />
                      <i className="ot" style={{ width: `${(w.overtime / maxWeek) * 100}%` }} />
                      <i className="dt" style={{ width: `${(w.doubletime / maxWeek) * 100}%` }} />
                    </div>
                    <span className="tc-small num">{w.overtime + w.doubletime ? `${hrs(w.overtime + w.doubletime)} h OT` : ''}</span>
                  </div>
                ))}
                {!data.weeks.length && <p className="muted">No hours yet.</p>}
              </div>
              <div className="tc-legend tc-small"><span><i className="reg" /> Regular</span><span><i className="ot" /> Overtime</span><span><i className="dt" /> Double time</span></div>
            </section>
            <section className="card">
              <h2 className="tc-h2">By office</h2>
              <table className="compact-table">
                <thead><tr><th>Office</th><th className="num">Worked</th><th className="num">Overtime</th>{data.rates && <><th className="num">Labor</th><th className="num">Production</th><th className="num">Labor %</th></>}</tr></thead>
                <tbody>
                  {data.offices.map((o) => (
                    <tr key={o.location_id ?? 0}><td>{o.name}</td><td className="num">{hrs(o.worked)}</td><td className="num">{hrs(o.overtime + o.doubletime)}</td>
                      {data.rates && <><td className="num">{money(o.cost_cents)}</td><td className="num">{money(o.production_cents)}</td><td className="num">{o.labor_percent == null ? '—' : `${o.labor_percent}%`}</td></>}
                    </tr>
                  ))}
                  {!data.offices.length && <tr><td colSpan={6} className="muted">No hours yet.</td></tr>}
                </tbody>
              </table>
              {data.rates && <p className="muted tc-small">Worked time only — paid time off and holidays aren’t tied to an office, so they’re in the total above but not here.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
const money = (cents) => (cents == null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

// ============ Settings: rules, people, holidays, tablets ============
function SettingsTab() {
  return (
    <div className="tc-settings">
      <RulesCard />
      <StaffCard />
      <div className="tc-two">
        <HolidaysCard />
        <TabletsCard />
      </div>
    </div>
  );
}

function RulesCard() {
  const { data, reload } = useApi('/timeclock/settings');
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return <div className="card">Loading…</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    const keys = ['early_in_minutes', 'late_grace_minutes', 'early_out_minutes', 'late_out_minutes', 'outside_window', 'block_unscheduled', 'pay_period', 'period_anchor', 'week_start_day', 'ot_weekly', 'ot_weekly_minutes', 'ot_daily', 'ot_daily_minutes', 'dt_daily', 'dt_daily_minutes', 'seventh_day', 'rounding', 'paid_break_max_minutes', 'pto_mode', 'pto_per_hour', 'pto_fixed_minutes', 'pto_cap_minutes', 'adp_company_code', 'paychex_client_id'];
    const numeric = new Set(['early_in_minutes', 'late_grace_minutes', 'early_out_minutes', 'late_out_minutes', 'week_start_day', 'ot_weekly_minutes', 'ot_daily_minutes', 'dt_daily_minutes', 'rounding', 'paid_break_max_minutes', 'pto_per_hour', 'pto_fixed_minutes', 'pto_cap_minutes']);
    const body = Object.fromEntries(keys.filter((k) => String(f[k] ?? '') !== String(data[k] ?? '')).map((k) => [k, numeric.has(k) ? Number(f[k]) : f[k] === '' ? null : f[k]]));
    if (!Object.keys(body).length) return toast('Nothing changed');
    try { await api.put('/timeclock/settings', body); toast('Time clock rules saved'); reload(); } catch (x) { setErr(x); }
  };
  const hoursField = (k, label) => (
    <label>{label} <input type="number" step="0.5" min="0" value={Number(f[k]) / 60} onChange={(e) => setF({ ...f, [k]: Math.round(Number(e.target.value) * 60) })} /></label>
  );
  return (
    <form className="card tc-rules" onSubmit={save}>
      <h2 className="tc-h2">Rules</h2>
      <fieldset>
        <legend>Clock-in window</legend>
        <label>Clock in up to <input type="number" min="0" max="240" value={f.early_in_minutes} onChange={set('early_in_minutes')} /> min before the shift</label>
        <label>Late after <input type="number" min="0" max="120" value={f.late_grace_minutes} onChange={set('late_grace_minutes')} /> min (grace)</label>
        <label>Early out if more than <input type="number" min="0" max="240" value={f.early_out_minutes} onChange={set('early_out_minutes')} /> min before the end</label>
        <label>Flag staying more than <input type="number" min="0" max="240" value={f.late_out_minutes} onChange={set('late_out_minutes')} /> min after the end</label>
        <label>Too early to clock in <select value={f.outside_window} onChange={set('outside_window')}><option value="flag">Allow it and flag it</option><option value="block">Don’t allow it</option></select></label>
        <label className="tc-check"><input type="checkbox" checked={!!f.block_unscheduled} onChange={set('block_unscheduled')} /> Don’t allow clocking in on a day someone isn’t scheduled</label>
      </fieldset>
      <fieldset>
        <legend>Pay period and overtime</legend>
        <label>Pay period <select value={f.pay_period} onChange={set('pay_period')}><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="semimonthly">Twice a month (1st–15th, 16th–end)</option><option value="monthly">Monthly</option></select></label>
        {['weekly', 'biweekly'].includes(f.pay_period) && <label>A period starts on <input type="date" value={f.period_anchor || ''} onChange={set('period_anchor')} /></label>}
        <label>Workweek starts <select value={f.week_start_day} onChange={set('week_start_day')}>{DAY.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <label className="tc-check"><input type="checkbox" checked={!!f.ot_weekly} onChange={set('ot_weekly')} /> Weekly overtime after</label>{hoursField('ot_weekly_minutes', 'hours')}
        <label className="tc-check"><input type="checkbox" checked={!!f.ot_daily} onChange={set('ot_daily')} /> Daily overtime after</label>{hoursField('ot_daily_minutes', 'hours a day')}
        <label className="tc-check"><input type="checkbox" checked={!!f.dt_daily} onChange={set('dt_daily')} /> Double time after</label>{hoursField('dt_daily_minutes', 'hours a day')}
        <label className="tc-check"><input type="checkbox" checked={!!f.seventh_day} onChange={set('seventh_day')} /> Seventh day in a row: overtime, then double time past 8 hours (California)</label>
        <label>Round punches <select value={f.rounding} onChange={set('rounding')}><option value={0}>No rounding</option><option value={5}>Nearest 5 minutes</option><option value={6}>Nearest 6 minutes (tenth of an hour)</option><option value={15}>Nearest 15 minutes</option></select></label>
        <label>Breaks shorter than <input type="number" min="0" max="60" value={f.paid_break_max_minutes} onChange={set('paid_break_max_minutes')} /> min are paid</label>
      </fieldset>
      <fieldset>
        <legend>Time off and payroll</legend>
        <label>Time off is earned <select value={f.pto_mode} onChange={set('pto_mode')}><option value="none">Not tracked here</option><option value="per_hour">Per hour worked</option><option value="fixed">A fixed amount each pay period</option></select></label>
        {f.pto_mode === 'per_hour' && <label><input type="number" step="0.1" min="0" max="30" value={f.pto_per_hour} onChange={set('pto_per_hour')} /> minutes per hour worked <span className="muted tc-small">(1.54 ≈ 80 h a year full-time)</span></label>}
        {f.pto_mode === 'fixed' && hoursField('pto_fixed_minutes', 'Hours each pay period')}
        {f.pto_mode !== 'none' && hoursField('pto_cap_minutes', 'Stop earning at (hours, 0 = no cap)')}
        <label>ADP company code <input value={f.adp_company_code || ''} onChange={set('adp_company_code')} maxLength={20} /></label>
        <label>Paychex client ID <input value={f.paychex_client_id || ''} onChange={set('paychex_client_id')} maxLength={20} /></label>
      </fieldset>
      <ErrorBox error={err} />
      <div className="form-actions"><span className="muted tc-small">Time zone: {f.timezone} · Changes apply to hours not yet approved.</span><button className="primary">Save rules</button></div>
    </form>
  );
}

function StaffCard() {
  const { data, reload, error } = useApi('/timeclock/staff');
  const [err, setErr] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card">Loading…</div>;
  const rates = data.some((s) => 'hourly_rate_cents' in s);
  const patch = async (s, body, msg = 'Saved') => {
    setErr(null);
    try { await api.put(`/timeclock/staff/${s.user_id}`, body); toast(msg); reload(); } catch (x) { setErr(x); }
  };
  return (
    <section className="card">
      <h2 className="tc-h2">People</h2>
      <ErrorBox error={err} />
      <table className="compact-table tc-table">
        <thead><tr><th>Name</th><th>On the clock</th><th>Payroll ID</th><th>Pay</th><th>Overtime</th>{rates && <th className="num">Hourly rate</th>}<th>Tablet PIN</th></tr></thead>
        <tbody>
          {data.filter((s) => s.active).map((s) => (
            <tr key={s.user_id}>
              <td>{s.name}<div className="muted tc-small">{s.role?.replace(/_/g, ' ')}</div></td>
              <td><input type="checkbox" aria-label={`${s.name} on the time clock`} checked={!!s.on_clock} onChange={(e) => patch(s, { on_clock: e.target.checked }, e.target.checked ? `${s.name} is on the time clock` : `${s.name} is off the time clock`)} /></td>
              <td><InlineText value={s.payroll_id || ''} label={`${s.name} payroll ID`} onSave={(v) => patch(s, { payroll_id: v || null }, 'Payroll ID saved')} /></td>
              <td><select aria-label={`${s.name} pay type`} value={s.pay_type} onChange={(e) => patch(s, { pay_type: e.target.value })}><option value="hourly">Hourly</option><option value="salary">Salary</option></select></td>
              <td><label className="tc-small"><input type="checkbox" checked={!!s.overtime_exempt} onChange={(e) => patch(s, { overtime_exempt: e.target.checked })} /> Exempt</label></td>
              {rates && <td className="num"><InlineText value={s.hourly_rate_cents == null ? '' : (s.hourly_rate_cents / 100).toFixed(2)} label={`${s.name} hourly rate`} prefix="$" onSave={(v) => patch(s, { hourly_rate_cents: v === '' ? null : Math.round(Number(v) * 100) }, 'Rate saved')} /></td>}
              <td>{s.pin_locked ? <span className="tc-flag danger">Locked</span> : s.has_pin ? <span className="tc-flag ok">Set</span> : <span className="muted tc-small">Not set</span>}
                {(s.has_pin || s.pin_locked) && <button className="small" title="Clear the PIN so they can set a new one" onClick={() => api.post(`/timeclock/staff/${s.user_id}/pin-reset`, {}).then(() => { toast('PIN cleared — they can set a new one'); reload(); }, setErr)}><RotateCcw size={12} aria-hidden /> Reset</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rates && <p className="muted tc-small">Pay rates are visible to people with the “See and set staff pay rates” permission.</p>}
    </section>
  );
}

function InlineText({ value, onSave, label, prefix }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <span className="tc-inline-text">
      {prefix}<input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setV(value); }} />
    </span>
  );
}

function HolidaysCard() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, reload } = useApi(`/timeclock/holidays?year=${year}`);
  const [f, setF] = useState({ date: '', name: '', hours: 8 });
  const [err, setErr] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await api.post('/timeclock/holidays', { ...f, hours: Number(f.hours) }); setF({ date: '', name: '', hours: 8 }); toast('Holiday added'); reload(); } catch (x) { setErr(x); }
  };
  const us = async () => {
    try { const r = await api.post('/timeclock/holidays/us', { year }); toast(`Added ${r.added} holiday${r.added === 1 ? '' : 's'}`); reload(); } catch (x) { setErr(x); }
  };
  const remove = async (hol) => {
    try {
      await api.del(`/timeclock/holidays/${hol.id}`);
      toast(`${hol.name} removed`, { undo: async () => { await api.post('/timeclock/holidays', { date: hol.date, name: hol.name, hours: hol.paid_minutes / 60 }); reload(); } });
      reload();
    } catch (x) { setErr(x); }
  };
  return (
    <section className="card">
      <div className="tc-toolbar">
        <h2 className="tc-h2">Paid holidays</h2>
        <div className="inline">
          <button className="small" onClick={() => setYear(year - 1)} aria-label="Previous year"><ChevronLeft size={14} /></button><strong>{year}</strong><button className="small" onClick={() => setYear(year + 1)} aria-label="Next year"><ChevronRight size={14} /></button>
        </div>
      </div>
      <ul className="tc-list">
        {(data || []).map((hol) => <li key={hol.id}><span>{fmtDate(hol.date)} · {hol.name}</span><span className="muted">{hm(hol.paid_minutes)}</span><button className="small" onClick={() => remove(hol)} aria-label={`Remove ${hol.name}`}><X size={12} /></button></li>)}
        {data && !data.length && <li className="muted">No holidays for {year}. <button className="link" onClick={us}>Add the usual six US holidays</button></li>}
      </ul>
      <form className="tc-edit" onSubmit={add}>
        <input type="date" required aria-label="Date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <input className="tc-grow" required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input type="number" className="tc-num" min="0" max="24" step="0.5" aria-label="Paid hours" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
        <button className="small primary">Add</button>
      </form>
      <ErrorBox error={err} />
      <p className="muted tc-small">Hourly people on the clock who worked or took paid time off that pay period get the holiday’s hours.</p>
    </section>
  );
}

export const KIOSK_KEY = 'dm_timeclock_kiosk';
const kioskToken = () => { try { return localStorage.getItem(KIOSK_KEY); } catch { return null; } };
function TabletsCard() {
  const nav = useNavigate();
  const { data, reload } = useApi('/timeclock/kiosks');
  const [name, setName] = useState('Front desk tablet');
  const [err, setErr] = useState(null);
  const setup = async (e) => {
    e.preventDefault();
    try {
      const k = await api.post('/timeclock/kiosks', { name });
      try { localStorage.setItem(KIOSK_KEY, k.token); } catch { throw new Error('This browser won’t save settings (private window?) — use a normal window on the tablet.'); }
      toast('This device is now the office time clock');
      nav('/timeclock/kiosk');
    } catch (x) { setErr(x); }
  };
  const revoke = async (k) => {
    try { await api.post(`/timeclock/kiosks/${k.id}/revoke`, {}); toast(`${k.name} can no longer clock people in`); reload(); } catch (x) { setErr(x); }
  };
  return (
    <section className="card">
      <h2 className="tc-h2"><TabletSmartphone size={16} aria-hidden /> Shared time-clock tablet</h2>
      <p className="muted tc-small">Open this on the tablet by the front desk: people tap their name and type their PIN. The tablet only clocks people in and out — it can’t open anything else.</p>
      {kioskToken() && <p><button className="link" onClick={() => nav('/timeclock/kiosk')}>This device is a time clock — open it</button></p>}
      <form className="tc-edit" onSubmit={setup}>
        <input className="tc-grow" aria-label="Tablet name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="small primary">Use this device as the time clock</button>
      </form>
      <ErrorBox error={err} />
      <ul className="tc-list">
        {(data || []).map((k) => <li key={k.id} className={k.revoked_at ? 'muted' : ''}><span>{k.name}</span><span className="muted tc-small">{k.revoked_at ? 'switched off' : k.last_seen_at ? `last used ${fmtDate(k.last_seen_at)}` : 'not used yet'}</span>{!k.revoked_at && <button className="small" onClick={() => revoke(k)}>Switch off</button>}</li>)}
      </ul>
    </section>
  );
}

// ============ Kiosk: the shared tablet ============
// Route: /timeclock/kiosk (outside the signed-in app). Tap your name → pick what you're doing → PIN → done,
// then back to the start. Keyboard: type to find a name, digits for the PIN, Enter, Esc.
async function kioskCall(path, body) {
  const res = await fetch(`/api/kiosk${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Token': kioskToken() || '' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}
const ACTIONS = {
  out: [['in', 'Clock in', LogIn, 'in']],
  in: [['out', 'Clock out', LogOut, 'out'], ['break_start', 'Start break', Coffee, 'break', 'break'], ['break_start', 'Start lunch', UtensilsCrossed, 'break', 'lunch']],
  break: [['break_end', 'I’m back', Play, 'in'], ['out', 'Clock out', LogOut, 'out']],
  lunch: [['break_end', 'I’m back from lunch', Play, 'in'], ['out', 'Clock out', LogOut, 'out']],
};
export function Kiosk() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [who, setWho] = useState(null);
  const [action, setAction] = useState(null);
  const [pin, setPin] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(new Date());
  const load = useCallback(() => kioskCall('/timeclock/staff').then((d) => { setList(d); setErr(null); }, setErr), []);
  const home = useCallback(() => { setWho(null); setAction(null); setPin(''); setDone(null); setErr(null); load(); }, [load]);
  useEffect(() => { load(); const t = setInterval(() => setNow(new Date()), 15_000); const r = setInterval(load, 120_000); return () => { clearInterval(t); clearInterval(r); }; }, [load]);
  // Back to the start after a result, or when someone walks away mid-way.
  useEffect(() => {
    if (!who && !done) return undefined;
    const t = setTimeout(home, done ? 4000 : 25_000);
    return () => clearTimeout(t);
  }, [who, action, pin, done, home]);
  const submit = useCallback(async (p = pin) => {
    if (busy || p.length < 4) return;
    setBusy(true);
    try {
      const r = await kioskCall('/timeclock/punch', { user_id: who.id, pin: p, action: action[0], kind: action[4] });
      setDone({ ok: true, text: r.message, name: who.name });
    } catch (e) {
      if (e.status === 401) { setErr(e); setPin(''); } else setDone({ ok: false, text: e.message, name: who.name });
    } finally { setBusy(false); }
  }, [busy, pin, who, action]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') return home();
      if (!action) return;
      if (/^\d$/.test(e.key)) setPin((x) => (x.length < 8 ? x + e.key : x));
      else if (e.key === 'Backspace') setPin((x) => x.slice(0, -1));
      else if (e.key === 'Enter') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [action, submit, home]);
  if (!kioskToken() || (err?.status === 401 && !who)) {
    return (
      <div className="kiosk"><div className="kiosk-panel center">
        <TabletSmartphone size={40} aria-hidden />
        <h1>This device isn’t a time clock yet</h1>
        <p>A manager can set it up: sign in, open Time clock → Settings, and choose “Use this device as the time clock”.</p>
        <a className="kiosk-link" href="/timeclock?tab=settings">Open Time clock settings</a>
      </div></div>
    );
  }
  // The office's time (the tablet's own clock setting may differ).
  const tz = list?.timezone;
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <div><strong>{list?.practice}</strong><span>{list?.kiosk}</span></div>
        <div className="kiosk-clock">{time}<small>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(tz ? { timeZone: tz } : {}) })}</small></div>
      </header>
      {done ? (
        <div className={`kiosk-panel center kiosk-done ${done.ok ? 'ok' : 'bad'}`} role="status">
          {done.ok ? <CheckCircle2 size={64} aria-hidden /> : <AlertTriangle size={64} aria-hidden />}
          <h1>{done.ok ? `Thanks, ${done.name.split(' ')[0]}` : 'That didn’t work'}</h1>
          <p>{done.text}</p>
          <button className="kiosk-btn" onClick={home}>Done</button>
        </div>
      ) : !who ? (
        <div className="kiosk-panel">
          <h1>Tap your name</h1>
          {!list ? <p>Loading…</p> : (
            <div className="kiosk-people">
              {list.people.map((p) => (
                <button key={p.id} className={`kiosk-person ${p.status}`} onClick={() => { setWho(p); setErr(null); if (ACTIONS[p.status].length === 1) setAction(ACTIONS[p.status][0]); }}>
                  <span className="kiosk-initials" aria-hidden>{p.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>
                  <strong>{p.name}</strong>
                  <small>{p.status === 'out' ? 'Clocked out' : p.status === 'in' ? 'Clocked in' : p.status === 'lunch' ? 'At lunch' : 'On break'}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : !action ? (
        <div className="kiosk-panel center">
          <h1>Hi {who.name.split(' ')[0]} — what are you doing?</h1>
          <div className="kiosk-actions">
            {ACTIONS[who.status].map((a) => { const Icon = a[2]; return <button key={a[1]} className={`kiosk-btn big ${a[3]}`} onClick={() => setAction(a)}><Icon size={28} aria-hidden /> {a[1]}</button>; })}
          </div>
          <button className="kiosk-back" onClick={home}>Not you? Go back</button>
        </div>
      ) : (
        <div className="kiosk-panel center">
          <h1>{action[1]} — {who.name}</h1>
          {!who.has_pin && <p className="kiosk-warn">You haven’t set a PIN yet. Sign in on a computer → Time clock → My time → Tablet PIN.</p>}
          <div className="kiosk-dots" aria-label={`${pin.length} digits entered`}>{Array.from({ length: Math.max(4, pin.length) }).map((_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
          {err && <p className="kiosk-warn" role="alert">{err.message}</p>}
          <div className="kiosk-pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => setPin((x) => (x.length < 8 ? x + d : x))}>{d}</button>)}
            <button onClick={() => setPin((x) => x.slice(0, -1))} aria-label="Delete"><Delete size={24} /></button>
            <button onClick={() => setPin((x) => (x.length < 8 ? `${x}0` : x))}>0</button>
            <button className="go" disabled={pin.length < 4 || busy} onClick={() => submit()} aria-label="Enter"><CheckCircle2 size={26} /></button>
          </div>
          <button className="kiosk-back" onClick={home}>Cancel</button>
        </div>
      )}
    </div>
  );
}
