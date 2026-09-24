import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleDollarSign, Users, Stethoscope, Lightbulb, TrendingUp } from 'lucide-react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';
import { money } from '../../format.js';
import './business.css';

// The business view (PM3, BD1–BD3, EX; docs/business-view.md): the schedule colored by margin per hour, today's
// P&L strip, the staff lanes and the exams card. Everything here comes from /api/business/*, which only answers
// people allowed to see it (business:view; pay only with timeclock:rates) — the screens just show what arrives.

// Whole dollars on the screens' figures; the visit breakdown keeps the cents ($c).
export const $ = (c) => (c == null ? '—' : money(Math.round(c / 100) * 100).replace(/\.00$/, ''));
export const $c = (c) => (c == null ? '—' : money(c));
export const $h = (c) => (c == null ? '—' : `${$(c)}/h`);
export const pct = (v) => (v == null ? '—' : `${v}%`);
export const hrs = (m) => (m == null ? '—' : `${(m / 60).toFixed(1)} h`);
export const clock = (m) => {
  if (m == null) return '';
  const h = Math.floor(m / 60) % 24;
  return `${((h + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
export const BAND_LABEL = { red: 'Below fixed costs', amber: 'Covers costs', green: 'Good', gold: 'Excellent', none: 'No time on the visit' };
const KIND_LABEL = { doctor: 'Doctor', hygienist: 'Hygienist', assistant: 'Assistant', admin: 'Front office' };
const STATE_LABEL = { in_visit: 'With a patient', assisting: 'Assisting', admin: 'Front office', break: 'Break', idle: 'Idle', absent: 'Not clocked in' };
const officeQuery = (office) => (office ? `&location_id=${office}` : '');

// Who may see what (asked once per page load; the server checks every request anyway).
let accessPromise = null;
export function useBusinessAccess() {
  const [access, setAccess] = useState(null);
  useEffect(() => {
    let live = true;
    accessPromise ||= api.get('/business/access').catch(() => ({ view: false, manage: false, rates: false, lanes: false, exams: false }));
    accessPromise.then((a) => live && setAccess(a));
    return () => { live = false; };
  }, []);
  return access;
}

// Fetches a business number and keeps it fresh: again whenever the schedule, the time clock or the business
// settings change (live events, a moment later so a burst is one request), and every `every` ms.
export function useLiveFetch(path, { enabled = true, every = 0, version = null, events = ['schedule', 'timeclock', 'business'] } = {}) {
  const [state, setState] = useState({ data: null, error: null });
  const timer = useRef(null);
  const current = useRef(path);
  current.current = path;
  const load = useCallback(async () => {
    if (!enabled || !path) return;
    try {
      const data = await api.get(path);
      if (current.current === path) setState({ data, error: null });
    } catch (error) {
      if (current.current === path) setState((s) => ({ data: s.data, error }));
    }
  }, [path, enabled]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (!every || !enabled) return undefined;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every, enabled]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLiveEvents((e) => {
    if (!enabled || !events.includes(e.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 700);
  });
  return { ...state, reload: load };
}

// ---- The toggle (owner only) ----
export function BusinessToggle({ on, onToggle }) {
  return (
    <button type="button" className={`icon-btn wide biz-toggle${on ? ' active' : ''}`} onClick={onToggle} aria-pressed={on}
      title={on ? 'Hide the business view (Shift+B)' : 'Business view: margin per hour, labor vs production (Shift+B)'}>
      <CircleDollarSign size={16} /> Business
    </button>
  );
}

// The schedule's visits and columns by margin (PM2/PM3).
export function useBusinessSchedule({ date, days = 1, office, on, version }) {
  return useLiveFetch(on ? `/business/schedule?date=${date}&days=${days}${officeQuery(office)}` : null, { enabled: on, version, events: ['business'] });
}

// A visit's hover breakdown, one line per figure (plain text for the title attribute and screen readers).
export function visitBreakdown(v, basis = 'chair') {
  if (!v) return '';
  const perDoctor = basis === 'doctor' && v.margin_per_doctor_hour != null;
  const lines = [
    `${BAND_LABEL[v.band] || ''}: ${$h(v.value)} margin per ${perDoctor ? 'doctor' : 'chair'}-hour`,
    `Fee ${$c(v.fee)}${v.write_off ? ` − PPO write-off ${$c(v.write_off)}` : ''}${v.payer ? ` (${v.payer})` : ''}`,
    `Expected: insurance ${$c(v.insurance)} + patient ${$c(v.patient_expected ?? v.patient)} = ${$c(v.expected)}`,
    `Lab ${$c(v.lab)} · supplies ${$c(v.supplies)} · card fees ${$c(v.merchant)}${v.pay != null ? ` · provider pay ${$c(v.pay)}` : ''}`,
    `Margin ${$c(v.margin)} · ${$h(v.margin_per_chair_hour)} per chair-hour${v.margin_per_doctor_hour != null ? ` · ${$h(v.margin_per_doctor_hour)} per doctor-hour` : ''}`,
    v.profit != null ? `After fixed costs (${$c(v.overhead)}): ${$c(v.profit)} · ${$h(v.profit_per_hour)}` : null,
    v.typical_costs ? 'Some costs are typical estimates — enter yours in Business → Costs' : null,
    ...(v.notes || []),
  ];
  return lines.filter(Boolean).join('\n');
}

// Adds each column's margin totals to the schedule's columns (chairs, providers, or the week's days).
export function withBusinessColumns(columns, biz) {
  if (!biz) return columns;
  return columns.map((c) => {
    let t = null;
    if (c.assign?.provider_id) t = biz.columns?.providers?.[c.date]?.[c.assign.provider_id];
    else if (c.assign && 'operatory_id' in c.assign) t = biz.columns?.operatories?.[c.date]?.[c.assign.operatory_id ?? 'none'];
    else t = biz.days?.[c.date];
    return t ? { ...c, biz: t } : c;
  });
}
export function ColumnBusiness({ t }) {
  if (!t) return null;
  return (
    <span className={`cal-col-biz biz-${t.band}`} title={`Margin ${$(t.margin)} (${$h(t.margin_per_chair_hour)} per chair-hour)${t.profit != null ? `, after fixed costs ${$(t.profit)}` : ''}`}>
      <i className="biz-band-dot" /> <strong>{$(t.margin)}</strong> margin{t.profit != null ? <> · {$(t.profit)} profit</> : null}
    </span>
  );
}
export function BandLegend({ biz }) {
  if (!biz) return null;
  const t = biz.thresholds;
  return (
    <div className="biz-legend no-print" aria-label="Business view colors">
      <span><i className="biz-band-dot biz-red" /> under {$h(t.red_below)} (fixed costs{biz.overhead?.source === 'typical' ? ', typical' : ''})</span>
      <span><i className="biz-band-dot biz-amber" /> to {$h(t.green_from)}</span>
      <span><i className="biz-band-dot biz-green" /> to {$h(t.gold_from)}</span>
      <span><i className="biz-band-dot biz-gold" /> {$h(t.gold_from)}+</span>
      <span>margin per {biz.basis === 'doctor' ? 'doctor' : 'chair'}-hour</span>
      {biz.typical_costs && <span className="biz-typical">Some costs are typical estimates — <a href="/business?tab=costs">enter yours</a></span>}
    </div>
  );
}

// ---- BD1: today's P&L strip ----
export function BusinessStrip({ date, office, onLanes, lanesOn }) {
  const { data: t, error } = useLiveFetch(`/business/today?date=${date}${officeQuery(office)}`, { every: 60_000 });
  if (error && !t) return <div className="biz-strip"><span className="muted">The business numbers didn’t load: {error.message}</span></div>;
  if (!t) return <div className="biz-strip"><span className="muted">Loading the business side of the day…</span></div>;
  const l = t.labor;
  const laborTone = l.status === 'over' ? 'bad' : l.status === 'on_target' ? 'good' : l.status === 'under' ? 'good' : '';
  return (
    <div className="biz-strip" role="region" aria-label="Today’s business numbers" data-testid="biz-strip">
      <div className="biz-figs">
        <Fig label="Production" value={$(t.production.scheduled)} sub={`${$(t.production.completed)} done`} />
        <Fig label="Expected collections" value={$(t.collections.expected)} sub={t.production.write_offs ? `after ${$(t.production.write_offs)} write-offs` : 'no write-offs'} />
        <Fig label="Direct costs" value={$(t.direct_costs.total)} sub={`lab ${$(t.direct_costs.lab)} · supplies ${$(t.direct_costs.supplies)}`} />
        {l.hidden ? <Fig label="Labor" value={`${l.clocked_in} in`} sub="pay needs “See pay rates”" /> : (
          <>
            <Fig label="Labor so far → day" value={`${$(l.so_far)} → ${$(l.projected)}`} sub={l.overtime_premium ? `incl. ${$(l.overtime_premium)} overtime` : `${l.clocked_in} clocked in`} />
            <Fig label="Labor % of production" value={pct(l.pct_of_production)} sub={`target ${t.labor_target.low}–${t.labor_target.high}% · ${pct(l.pct_of_collections)} of collections`} tone={laborTone} testid="biz-labor-pct" />
          </>
        )}
        <Fig label="Margin" value={$(t.margin.total)} sub={`${$h(t.margin.per_chair_hour)} per chair-hour`} />
        <Fig label="Fixed costs today" value={$(t.overhead.fixed_today)} sub={`${$h(t.overhead.per_open_hour)} open${t.overhead.fixed_source === 'typical' ? ' · typical' : ''}`} />
        {t.profit !== undefined && <Fig label="Projected profit" value={$(t.profit)} sub={t.break_even ? `break-even covered ${pct(t.break_even.covered_pct)}` : ''} tone={t.profit >= 0 ? 'good' : 'bad'} />}
        {onLanes && <button type="button" className={`small${lanesOn ? ' active' : ''}`} onClick={onLanes} title="Who is busy, idle or on break (L)"><Users size={14} /> Staff</button>}
      </div>
      <div className="biz-chips">
        {t.productivity.pct_so_far != null && <span className={`biz-chip${t.productivity.pct_so_far < 50 ? ' warn' : ''}`}>Clinical team busy {pct(t.productivity.pct_so_far)} so far</span>}
        {t.productivity.idle_minutes_day > 0 && <span className="biz-chip warn">{hrs(t.productivity.idle_minutes_day)} idle on the clock today{l.idle_cost_day ? ` (${$(l.idle_cost_day)})` : ''}</span>}
        {t.below_cost.visits > 0 && <span className="biz-chip bad">{t.below_cost.visits} visit{t.below_cost.visits === 1 ? '' : 's'} below fixed cost ({$(t.below_cost.shortfall)} short)</span>}
        {t.open_chair.minutes > 0 && t.open_chair.worth != null && <span className="biz-chip">{hrs(t.open_chair.minutes)} open chair time ≈ {$(t.open_chair.worth)} margin</span>}
        {t.overtime.map((o) => <span key={o.user_id} className="biz-chip warn">{o.name}: overtime{o.at != null ? ` from ${clock(o.at)}` : ''}{o.premium ? ` (+${$(o.premium)})` : ''}</span>)}
        {t.staffing_advice.slice(0, 2).map((a) => <span key={a.from} className={`biz-chip ${a.status === 'under' ? 'bad' : 'warn'}`}><Lightbulb size={12} /> {a.text}</span>)}
        {t.typical_costs && <span className="biz-typical">Some procedure costs are typical estimates.</span>}
      </div>
    </div>
  );
}
function Fig({ label, value, sub, tone = '', testid }) {
  return (
    <div className={`biz-fig ${tone}`} data-testid={testid}>
      <em>{label}</em>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

// ---- BD2/BD3: staff lanes ----
export function StaffLanes({ date, office }) {
  const { data: s, error } = useLiveFetch(`/business/staff?date=${date}${officeQuery(office)}`, { every: 60_000 });
  if (error && !s) return <div className="biz-lanes muted">Staff lanes didn’t load: {error.message}</div>;
  if (!s) return <div className="biz-lanes muted">Loading staff lanes…</div>;
  const span = Math.max(60, s.day_end - s.day_start);
  const at = (m) => `${((Math.min(Math.max(m, s.day_start), s.day_end) - s.day_start) / span) * 100}%`;
  const width = (a, b) => `${((Math.min(b, s.day_end) - Math.max(a, s.day_start)) / span) * 100}%`;
  const hours = [];
  for (let m = Math.ceil(s.day_start / 60) * 60; m <= s.day_end; m += 60) hours.push(m);
  return (
    <section className="biz-lanes" aria-label="Staff lanes" data-testid="biz-lanes">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3><Users size={15} /> Who’s doing what</h3>
        <div className="biz-legend biz-legend-lanes">
          {Object.entries(STATE_LABEL).map(([k, v]) => <span key={k}><i className={`biz-seg ${k}`} style={{ position: 'static' }} /> {v}</span>)}
        </div>
      </div>
      {!s.people.length && <div className="muted">Nobody is scheduled or clocked in {s.future ? 'that day' : 'today'}.</div>}
      {s.people.length > 0 && (
        <div className="biz-lane-grid">
          <div />
          <div className="biz-lane-hours">{hours.map((m) => <span key={m} style={{ left: at(m) }}>{clock(m)}</span>)}</div>
          <div />
          {s.people.map((p) => (
            <Lane key={p.user_id} p={p} s={s} at={at} width={width} />
          ))}
        </div>
      )}
      {s.staffing.length > 0 && (
        <>
          <div className="biz-hours" aria-label="Staffing vs demand by hour">
            {s.staffing.map((r) => (
              <div key={r.hour} className={`biz-hour ${r.status}`} title={`${r.assistants} assistants on, ${r.assistants_needed} needed for ${r.doctor_chairs} busy doctor chairs; ${r.hygiene_chairs} hygiene chairs busy`}>
                <strong>{clock(r.hour)}</strong>
                {r.doctor_chairs} dr chair{r.doctor_chairs === 1 ? '' : 's'} · {r.assistants} asst
              </div>
            ))}
          </div>
          {s.advice.map((a) => <div key={a.from} className="muted" style={{ fontSize: 12.5, marginTop: 4 }}><Lightbulb size={12} /> {a.text}</div>)}
        </>
      )}
    </section>
  );
}
function Lane({ p, s, at, width }) {
  const flags = p.flags.map((f) => ({ late: `in ${f.minutes} min late`, early: `in ${f.minutes} min early`, unscheduled: 'not on the schedule', early_out: `left ${f.minutes} min early`, late_out: `stayed ${f.minutes} min late`, not_in: 'not clocked in yet', unlinked: 'not linked to a provider' }[f.kind])).filter(Boolean);
  const sugg = p.gaps.filter((g) => g.upcoming).flatMap((g) => g.suggestions).slice(0, 3);
  const d = s.past ? p.so_far : p.day;
  return (
    <>
      <div className="biz-lane-name">
        <strong>{p.name}</strong>
        <small>{KIND_LABEL[p.kind]}{p.pooled ? ' (shared)' : ''}{p.status === 'away' && p.back_at ? ` · back ${clock(p.back_at)}` : ''}{flags.length ? ` · ${flags.join(', ')}` : ''}</small>
      </div>
      <div className="biz-lane-bar" role="img" aria-label={`${p.name}: ${pct(p.so_far.productivity_pct)} productive so far, ${hrs(p.so_far.idle_minutes)} idle`}>
        {p.segments.filter((g) => g.state !== 'off').map((g) => (
          <span key={`${g.start}-${g.state}`} className={`biz-seg ${g.state}${g.planned ? ' planned' : ''}`} style={{ left: at(g.start), width: width(g.start, g.end) }}
            title={`${clock(g.start)}–${clock(g.end)} ${STATE_LABEL[g.state] || g.state}${g.planned ? ' (planned)' : ''}`} />
        ))}
        {p.gaps.map((g) => <span key={`gap-${g.start}`} className="biz-gap" style={{ left: at(g.start), width: width(g.start, g.end) }} title={`Idle ${clock(g.start)}–${clock(g.end)} (${g.minutes} min)${g.idle_cost ? `, ${$(g.idle_cost)}` : ''}`} />)}
        {s.now != null && <span className="biz-now" style={{ left: at(s.now) }} />}
      </div>
      <div className="biz-lane-stats">
        <span>paid <b>{hrs(d.paid_minutes)}</b></span>
        {p.kind !== 'admin' && <span>busy <b>{pct(d.productivity_pct)}</b></span>}
        {d.production_per_labor_hour != null && <span><b>{$h(d.production_per_labor_hour)}</b> supported</span>}
        {p.labor && <span>pay <b>{$(p.labor.so_far)}</b> → {$(p.labor.projected)}</span>}
        {p.overtime_risk && <span className="biz-chip warn" style={{ height: 18 }}>OT {clock(p.overtime_risk.at)}</span>}
      </div>
      {sugg.length > 0 && <div className="biz-sugg">{sugg.map((x) => <span key={x.text}>{x.text}</span>)}</div>}
    </>
  );
}

// ---- EX1–EX3: exams today and the production they support (compact for the huddle) ----
export function ExamsCard({ date, office, compact = false }) {
  const [horizon, setHorizon] = useState(5);
  const [period, setPeriod] = useState('month');
  const { data: e, error } = useLiveFetch(`/business/exams?date=${date}&horizon=${horizon}${officeQuery(office)}`, { events: ['schedule', 'business'] });
  if (error && !e) return null;
  if (!e) return null;
  const sup = e.support?.find((x) => x.period === period);
  return (
    <div className={`biz-exams${compact ? ' compact' : ''}`} data-testid="biz-exams">
      <div className="inline" style={{ justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 13.5 }}><Stethoscope size={14} /> Exams today</strong>
        {e.support && !compact && (
          <span className="inline" style={{ gap: 6 }}>
            <span className="seg">{[['today', 'Today'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => <button key={k} className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>{l}</button>)}</span>
            <span className="seg" title="What an exam leads to within 1, 3 or 5 months">{(e.horizons || [1, 3, 5]).map((h) => <button key={h} className={horizon === h ? 'active' : ''} onClick={() => setHorizon(h)}>{h} mo</button>)}</span>
          </span>
        )}
      </div>
      <div className="biz-exam-row">
        {e.today.filter((x) => x.count || x.target).map((x) => (
          <span key={x.type} className={`biz-exam ${x.status || ''}`}><b>{x.count}</b>{x.target ? `/${x.target}` : ''} {x.label.toLowerCase()}</span>
        ))}
        {!e.today.some((x) => x.count || x.target) && <span className="muted" style={{ fontSize: 12 }}>No exams booked.</span>}
      </div>
      {sup && (
        <>
          <div className="biz-support"><TrendingUp size={13} /> {sup.text}</div>
          {sup.goal ? <div className="biz-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, sup.pct || 0)}%` }} /></div> : null}
          {!compact && <div className="biz-typical">Value per exam over {e.horizon_months} month{e.horizon_months === 1 ? '' : 's'}: {Object.entries(e.values).map(([k, v]) => `${e.types?.[k] || k} ${$(v.value)}${v.source === 'typical' ? ' (typical)' : ''}`).join(' · ')}</div>}
        </>
      )}
    </div>
  );
}
