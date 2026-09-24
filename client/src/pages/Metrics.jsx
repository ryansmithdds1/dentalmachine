import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Minus, Target, X, Lightbulb } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtDateTime, label as labelize } from '../format.js';
import { useCommands } from '../shortcuts.js';
import { ErrorBox } from '../components/ui.jsx';
import DiagnosisConversion from '../components/metrics/DiagnosisConversion.jsx';
import Benchmarks from '../components/metrics/Benchmarks.jsx';
import './metrics.css';

// Reports → Metrics: every KPI from the one shared definition (server/src/metrics.js, docs/metrics.md), with its
// goal, how it moved, and the rows behind it one click (or Enter) away. Email links land here with ?metric=…
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['last_week', 'Last week'], ['month', 'This month'], ['last_month', 'Last month'], ['ytd', 'Year to date']];
const GROUPS = [
  ['Money', ['production_gross', 'production_net', 'adjustments', 'collections', 'collection_rate']],
  ['Patients & visits', ['new_patients', 'case_acceptance', 'diagnosed', 'hygiene_reappointment', 'broken_appointments', 'broken_rate']],
  ['Right now', ['unscheduled_treatment', 'ar_total', 'ar_over_90', 'claims_over_30', 'recall_due', 'recall_overdue', 'recall_current_rate']],
  ['Booked on the schedule', ['scheduled_production', 'visits', 'unconfirmed', 'insurance_to_verify', 'open_gaps', 'balances_due']],
];
// What each number counts, in a sentence (the full rules are in docs/metrics.md).
const ABOUT = {
  production_gross: 'Fees for completed work, posted in these dates. Voided charges don’t count.',
  production_net: 'Gross production minus insurance write-offs, discounts and other write-offs.',
  adjustments: 'Insurance write-offs, discounts and other write-offs (credits only; voided ones don’t count).',
  collections: 'Patient and insurance payments received, minus refunds paid back.',
  collection_rate: 'Collections as a share of net production.',
  new_patients: 'Patients whose first completed visit was in these dates.',
  case_acceptance: 'Dollars accepted out of treatment presented, for plans made in these dates.',
  diagnosed: 'Treatment charted on the day of a completed exam, at office fees (the same work charted again counts once). The Diagnosis & conversion tab follows it to completion.',
  hygiene_reappointment: 'Hygiene visits where the patient left with the next visit already booked.',
  broken_appointments: 'No-shows and cancellations for visits in these dates (up to today).',
  broken_rate: 'Broken visits out of kept plus broken visits.',
  unscheduled_treatment: 'Planned treatment not on a booked visit, for active patients.',
  ar_total: 'Everything owed to the practice, by household.',
  ar_over_90: 'The part of what’s owed that is more than 90 days old.',
  claims_over_30: 'Claims sent more than 30 days ago with no answer yet.',
  recall_due: 'Patients due for their checkup in the next 30 days, not yet booked.',
  recall_overdue: 'Patients past their checkup date and not booked.',
  recall_current_rate: 'Patients on recall who aren’t overdue (or are already booked).',
  visits: 'Visits booked in these dates (not cancelled or missed).',
  scheduled_production: 'Fees of the procedures on booked visits.',
  unconfirmed: 'Booked visits the patient hasn’t confirmed.',
  insurance_to_verify: 'Booked visits whose insurance hasn’t been checked in 30 days.',
  open_gaps: 'Free stretches of 30 minutes or more in each provider’s hours.',
  balances_due: 'What the households of booked patients owe.',
};
const COLS = {
  entry_date: 'Date', patient: 'Patient', type: 'Type', description: 'Description', provider_name: 'Provider', amount: 'Amount', first_visit: 'First visit',
  source: 'Came from', created_at: 'Made', name: 'Plan', status: 'Status', presented: 'Presented', accepted: 'Accepted', start_time: 'Visit', reappointed: 'Next visit booked',
  broken_reason: 'Reason', rebooked_for: 'Rebooked for', procedures: 'Procedures', oldest: 'Planned since', balance: 'Balance', d90_plus: 'Over 90 days',
  insurance_pending: 'Insurance expected', patient_portion: 'Patient owes', claim_id: 'Claim', carrier: 'Insurance', submitted_at: 'Sent', days: 'Days waiting',
  estimated_amount: 'Expected', due_date: 'Due', exam_type: 'Exam', completed: 'Completed', open: 'Still open', stage: 'Next step', last_contacted_at: 'Last contacted', production: 'Scheduled', date: 'Date', start: 'From', end: 'To', minutes: 'Minutes',
};
const MONEY_COLS = new Set(['amount', 'presented', 'accepted', 'balance', 'd90_plus', 'insurance_pending', 'patient_portion', 'estimated_amount', 'production', 'completed', 'open']);

const whole = (c) => money(c).replace(/\.00$/, '');
export function fmtMetric(m, v = m.value) {
  if (v == null) return '—';
  if (m.unit === 'money') return whole(v);
  if (m.unit === 'percent') return `${v}%`;
  return Number(v).toLocaleString('en-US');
}

function Trend({ m, before, vs }) {
  if (m.value == null || before == null) return null;
  const diff = m.value - before;
  const good = m.better === 'neutral' || diff === 0 ? null : (diff > 0) === (m.better === 'higher');
  const Icon = diff > 0 ? ArrowUpRight : diff < 0 ? ArrowDownRight : Minus;
  const amount = m.unit === 'percent' ? `${Math.abs(Math.round(diff * 10) / 10)} pts` : before ? `${Math.abs(Math.round((diff / Math.abs(before)) * 100))}%` : fmtMetric(m, Math.abs(diff));
  return (
    <span className={`mx-trend${good === true ? ' good' : good === false ? ' bad' : ''}`} title={`Was ${fmtMetric(m, before)} ${vs}`}>
      <Icon size={13} aria-hidden="true" /> {diff === 0 ? 'no change' : amount} <span className="muted">{vs}</span>
    </span>
  );
}

function Tile({ m, onOpen, active }) {
  const pctOfGoal = m.goal ? Math.max(0, Math.min(100, m.unit === 'percent' ? m.value : (m.value / m.goal) * 100)) : null;
  return (
    <button type="button" className={`mx-tile${m.standing ? ` ${m.standing}` : ''}${active ? ' active' : ''}`} onClick={() => onOpen(m.key)} disabled={!m.drill && m.value == null} aria-label={`${m.label}: ${fmtMetric(m)}. Show the details`}>
      <span className="mx-label">{m.label}</span>
      <span className="mx-value">{m.scoped_out ? <span className="muted mx-na">Not tracked for this filter</span> : fmtMetric(m)}</span>
      <span className="mx-trends">
        <Trend m={m} before={m.previous} vs="vs before" />
        <Trend m={m} before={m.last_year} vs="vs last year" />
      </span>
      {m.goal != null && (
        <span className="mx-goal">
          <span className="mx-bar"><i style={{ width: `${pctOfGoal ?? 0}%` }} />{m.unit === 'percent' && <b style={{ left: `${Math.min(100, m.goal)}%` }} />}</span>
          <span className="muted">{m.goal_source === 'benchmark' ? 'Benchmark' : 'Goal'} {m.better === 'lower' ? '≤' : ''}{fmtMetric(m, m.goal)}</span>
        </span>
      )}
    </button>
  );
}

// Money coming in is negative on the ledger (it lowers what's owed). The Collections and Write-offs numbers are
// shown as positive totals, so their rows are flipped to match (a refund then shows as a minus).
const FLIP = new Set(['collections', 'collection_rate', 'adjustments']);

function cell(key, row, metric) {
  const v = key === 'amount' && FLIP.has(metric) && row[key] != null ? -row[key] : row[key];
  if (key === 'patient') return row.patient_id ? <Link to={`/patients/${row.patient_id}`}>{row.first_name} {row.last_name}</Link> : '—';
  if (key === 'claim_id') return <Link to={`/claims/${v}`}>#{v}</Link>;
  if (v == null || v === '') return '—';
  if (MONEY_COLS.has(key)) return money(v);
  if (key === 'reappointed') return v ? 'Yes' : <span className="badge warn">No</span>;
  if (key === 'status') return <span className={`badge ${v}`}>{String(v).replace(/_/g, ' ')}</span>;
  if (key === 'type' || key === 'broken_reason') return labelize(String(v));
  if (['start_time', 'rebooked_for'].includes(key)) return fmtDateTime(v);
  if (['entry_date', 'first_visit', 'due_date', 'date'].includes(key)) return fmtDate(v);
  if (['created_at', 'submitted_at', 'oldest', 'last_contacted_at'].includes(key)) return fmtDate(String(v).slice(0, 10));
  return String(v);
}

function GoalEditor({ m, filters, onSaved }) {
  const { data, reload } = useApi('/metric-goals');
  const scope = filters.provider_id ? 'provider' : filters.location_id ? 'location' : 'practice';
  const scopeKey = scope === 'practice' ? 'practice' : scope === 'provider' ? `provider:${filters.provider_id}` : `location:${filters.location_id}`;
  const def = data?.metrics?.[m.key];
  const saved = data?.goals?.find((g) => g.metric === m.key && g.scope_key === scopeKey);
  const shown = (g) => (g == null ? '' : m.unit === 'money' ? String(Math.round(g.display_value / 100)) : String(g.display_value));
  const [value, setValue] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!def || (scope !== 'practice' && !def.scopes.includes(scope))) return null;
  const unitHint = m.unit === 'percent' ? '%' : def.goal === 'day' ? 'a day' : def.goal === 'month' ? 'a month' : '';
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const n = Number(value ?? shown(saved));
      await api.put('/metric-goals', { metric: m.key, scope, location_id: filters.location_id || undefined, provider_id: filters.provider_id || undefined, value: m.unit === 'money' ? Math.round(n * 100) : n });
      setValue(null);
      reload();
      onSaved();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <form className="mx-goal-form" onSubmit={save}>
      <label htmlFor={`goal-${m.key}`}><Target size={14} aria-hidden="true" /> {scope === 'practice' ? 'Practice goal' : scope === 'provider' ? 'Goal for this provider' : 'Goal for this office'}{m.goal_source === 'benchmark' ? ' (using the usual benchmark until you set one)' : ''}</label>
      <span className="inline">
        {m.unit === 'money' && <span className="muted">$</span>}
        <input id={`goal-${m.key}`} type="number" min="0" step={m.unit === 'percent' ? 0.5 : 1} value={value ?? shown(saved)} onChange={(e) => setValue(e.target.value)} placeholder="none" />
        <span className="muted">{unitHint}</span>
        <button className="small primary" disabled={busy || (value ?? shown(saved)) === ''}>Save goal</button>
      </span>
      <ErrorBox error={err} />
    </form>
  );
}

function Drill({ m, query, onClose, canSetGoal, filters, onGoal }) {
  const { data, error } = useApi(`/metrics/${m.key}/rows?${query}`);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer mx-drawer" aria-label={`${m.label} details`}>
      <div className="drawer-head">
        <div>
          <h2 style={{ margin: 0 }}>{m.label}</h2>
          <div className="mx-big">{fmtMetric(m)}</div>
          <div className="muted" style={{ fontSize: 13 }}>{ABOUT[m.key]}</div>
        </div>
        <button onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="drawer-body">
        {canSetGoal && <GoalEditor key={`${m.key}-${filters.provider_id}-${filters.location_id}`} m={m} filters={filters} onSaved={onGoal} />}
        <ErrorBox error={error} />
        {!data ? <div className="muted">Loading…</div> : (
          <>
            {data.note && <p className="muted" style={{ fontSize: 13 }}>{data.note}</p>}
            <div className="muted" style={{ fontSize: 13, margin: '6px 0' }}>{data.count === 0 ? 'Nothing behind this number for these dates.' : `${data.count} row${data.count === 1 ? '' : 's'}${data.count > data.rows.length ? ` (first ${data.rows.length} shown)` : ''}`}</div>
            {data.rows.length > 0 && (
              <div className="mx-table-wrap">
                <table className="compact-table">
                  <thead><tr>{data.columns.map((c) => <th key={c}>{COLS[c] || labelize(c)}</th>)}</tr></thead>
                  <tbody>{data.rows.map((r, i) => <tr key={r.id ?? r.appointment_id ?? r.claim_id ?? r.recall_id ?? r.plan_id ?? `${r.patient_id}-${i}`}>{data.columns.map((c) => <td key={c}>{cell(c, r, m.key)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export default function Metrics() {
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const offices = useLookup('/locations');
  const providers = useLookup('/providers');
  const period = params.get('from') ? 'custom' : params.get('period') || 'month';
  const filters = { provider_id: params.get('provider_id') || '', location_id: params.get('location_id') || '' };
  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (period === 'custom') { q.set('from', params.get('from')); q.set('to', params.get('to') || params.get('from')); } else q.set('period', period);
    if (filters.provider_id) q.set('provider_id', filters.provider_id);
    if (filters.location_id) q.set('location_id', filters.location_id);
    return q.toString();
  }, [period, params, filters.provider_id, filters.location_id]);
  const tab = ['diagnosis', 'benchmarks'].includes(params.get('tab')) ? params.get('tab') : 'numbers';
  const { data, error, reload } = useApi(tab === 'numbers' ? `/metrics?${query}` : null);
  const open = params.get('metric');
  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  const byKey = useMemo(() => new Map((data?.metrics || []).map((m) => [m.key, m])), [data]);
  useCommands([
    ...PERIODS.map(([k, l]) => ({ id: `metrics-${k}`, label: `Metrics: ${l}`, hint: 'Practice numbers', run: () => set({ tab: '', period: k, from: '', to: '' }) })),
    { id: 'metrics-diagnosis', label: 'Metrics: Diagnosis & conversion', hint: 'Treatment diagnosed at exams, and how much gets done', run: () => set({ tab: 'diagnosis', metric: '' }) },
    { id: 'metrics-benchmarks', label: 'Metrics: Benchmarks', hint: 'How you compare with practices like yours', run: () => set({ tab: 'benchmarks', metric: '' }) },
  ]);
  const canSetGoal = user?.role === 'admin';
  const current = open ? byKey.get(open) : null;

  return (
    <div className="mx-page">
      <div className="mx-head">
        <div>
          <h1 style={{ margin: 0 }}>Practice metrics</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {tab === 'benchmarks' ? 'How your numbers compare with practices like yours (opt-in, anonymous)' : tab === 'diagnosis' ? 'Treatment diagnosed at exams, and how much of it gets done' : data ? `${fmtDate(data.from)}${data.to !== data.from ? ` – ${fmtDate(data.to)}` : ''} · compared with ${fmtDate(data.previous.from)}${data.previous.to !== data.previous.from ? ` – ${fmtDate(data.previous.to)}` : ''} and last year` : 'Loading…'}
          </div>
        </div>
        <div className="mx-filters">
          {tab === 'numbers' && (
            <div className="mx-seg" role="group" aria-label="Dates">
              {PERIODS.map(([k, l]) => <button key={k} type="button" className={period === k ? 'active' : ''} aria-pressed={period === k} onClick={() => set({ period: k, from: '', to: '' })}>{l}</button>)}
            </div>
          )}
          {offices.length > 1 && (
            <select aria-label="Office" value={filters.location_id} onChange={(e) => set({ location_id: e.target.value })}>
              <option value="">All offices</option>
              {offices.filter((o) => o.active !== 0).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {can('reports:read') && (
            <select aria-label="Provider" value={filters.provider_id} onChange={(e) => set({ provider_id: e.target.value })}>
              <option value="">All providers</option>
              {providers.filter((p) => p.active !== 0).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="mx-seg" role="tablist" aria-label="Metrics view" style={{ alignSelf: 'flex-start' }}>
        <button type="button" role="tab" aria-selected={tab === 'numbers'} className={tab === 'numbers' ? 'active' : ''} onClick={() => set({ tab: '' })}>Practice numbers</button>
        <button type="button" role="tab" aria-selected={tab === 'diagnosis'} className={tab === 'diagnosis' ? 'active' : ''} onClick={() => set({ tab: 'diagnosis', metric: '' })}>Diagnosis &amp; conversion</button>
        <button type="button" role="tab" aria-selected={tab === 'benchmarks'} className={tab === 'benchmarks' ? 'active' : ''} onClick={() => set({ tab: 'benchmarks', metric: '' })}>Benchmarks</button>
      </div>
      {tab === 'benchmarks' ? <Benchmarks /> : tab === 'diagnosis' ? <DiagnosisConversion /> : (<>
      <ErrorBox error={error} />

      {data?.areas?.length > 0 && (
        <section className="mx-areas" aria-label="Areas to work on">
          <h2><Lightbulb size={16} aria-hidden="true" /> {data.areas.length === 1 ? 'One area to work on' : `${data.areas.length} areas to work on`}</h2>
          <div className="mx-area-list">
            {data.areas.map((a) => (
              <div key={a.metric} className="mx-area">
                <b>{a.label}</b>
                <p>{a.headline}</p>
                {a.tip && <p className="muted">{a.tip}</p>}
                {a.items.length > 0 && <p className="mx-names">{a.items.slice(0, 5).join(' · ')}{a.count > 5 ? ` · and ${a.count - 5} more` : ''}</p>}
                <button className="small" onClick={() => set({ metric: new URL(a.link, window.location.origin).searchParams.get('metric') || a.metric })}>{a.count ? `See all ${a.count}` : 'See the details'}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && GROUPS.map(([title, keys]) => (
        <section key={title} className="mx-group">
          <h2>{title}</h2>
          <div className="mx-grid">
            {keys.map((k) => byKey.get(k)).filter(Boolean).map((m) => <Tile key={m.key} m={m} active={open === m.key} onOpen={(key) => set({ metric: key })} />)}
          </div>
        </section>
      ))}
      {data && <p className="muted mx-foot">The same numbers appear in the metric emails and on Reports → Practice KPIs. Open any number to see what it counts and the rows behind it.</p>}
      </>)}

      {tab === 'numbers' && current && <Drill m={current} query={query} filters={filters} canSetGoal={canSetGoal} onGoal={reload} onClose={() => set({ metric: '' })} />}
    </div>
  );
}
