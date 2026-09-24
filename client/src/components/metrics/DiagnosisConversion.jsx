import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Stethoscope, Users, TrendingUp, ListChecks } from 'lucide-react';
import { download } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import '../diagnosis.css';

// Reports → Metrics → Diagnosis & conversion (DX1–DX2). Treatment diagnosed at new patient, recall, perio and
// emergency exams, and how much of it was presented, accepted, scheduled and completed since — per provider, per
// exam type, by month, and the patients behind it. Every number comes from server/src/diagnosis.js; the rules
// are in docs/metrics.md ("Diagnosis & conversion"). Shares the page's provider/office filters (URL params).
const PERIODS = [['month', 'This month'], ['last_month', 'Last month'], ['last_3_months', '3 months'], ['last_6_months', '6 months'], ['last_12_months', '12 months'], ['ytd', 'Year to date']];
const TYPES = [['', 'All exams'], ['new_patient', 'New patient'], ['recall', 'Recall'], ['perio', 'Perio'], ['emergency', 'Emergency']];
const STEPS = [['diagnosed', 'Diagnosed'], ['presented', 'Presented'], ['accepted', 'Accepted'], ['scheduled', 'Scheduled'], ['completed', 'Completed']];
const STAGE_FILTERS = [['open', 'Still open'], ['diagnosed', 'Not presented'], ['presented', 'Not accepted'], ['accepted', 'Not scheduled'], ['scheduled', 'Scheduled'], ['all', 'Everything']];
const STAGE_LABEL = { diagnosed: 'Not presented yet', presented: 'Waiting for a yes', accepted: 'Accepted, not booked', scheduled: 'Booked', completed: 'Done' };
const whole = (c) => (c == null ? '—' : money(c).replace(/\.00$/, ''));
const pctText = (v) => (v == null ? '—' : `${v}%`);
const days = (v) => (v == null ? '—' : `${v} d`);
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function Running({ query, provider }) {
  const { data } = useApi(`/diagnosis/running?${query}`);
  if (!data) return null;
  return (
    <section className="dx-section" aria-label="Diagnosed so far">
      <h2><Stethoscope size={15} aria-hidden="true" /> Diagnosed so far{provider ? ` · ${provider}` : ''}</h2>
      <div className="dx-running">
        {data.periods.map((p) => {
          const pct = p.goal ? Math.max(0, Math.min(100, (p.diagnosed / p.goal) * 100)) : null;
          return (
            <div key={p.key} className={`mx-tile${p.standing ? ` ${p.standing}` : ''}`} style={{ cursor: 'default' }}>
              <span className="mx-label">{p.label}</span>
              <span className="mx-value">{whole(p.diagnosed)}</span>
              <span className="muted" style={{ fontSize: 12 }}>{p.exams} exam{p.exams === 1 ? '' : 's'}{p.per_exam != null ? ` · ${whole(p.per_exam)} per exam` : ''} · about {whole(p.expected)} after PPO fees</span>
              {p.goal != null && (
                <span className="mx-goal">
                  <span className="mx-bar"><i style={{ width: `${pct}%` }} /></span>
                  <span className="muted">Goal {whole(p.goal)}{p.key === 'month' ? ' so far this month' : ''}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {data.providers?.length > 0 && (
        <div className="dx-table-wrap" style={{ marginTop: 10 }}>
          <table className="compact-table dx-table">
            <thead><tr><th>Provider</th><th className="num">Today</th><th className="num">This week</th><th className="num">This month</th><th className="num">Goal so far</th></tr></thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.provider_id}>
                  <td>{p.name}</td>
                  <td className="num">{whole(p.today.diagnosed)}</td>
                  <td className="num">{whole(p.week.diagnosed)}</td>
                  <td className="num">{whole(p.month.diagnosed)}</td>
                  <td className="num">{p.month_goal != null ? <span className={`badge ${p.standing === 'good' ? 'ok' : p.standing === 'behind' ? 'danger' : 'warn'}`}>{whole(p.month_goal)}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Funnel({ t, stage, onStage }) {
  return (
    <div className="dx-funnel" role="group" aria-label="Conversion funnel">
      {STEPS.map(([k, label], i) => {
        const v = t[k];
        const share = t.diagnosed ? Math.round((v / t.diagnosed) * 100) : 0;
        const prevKey = STEPS[i - 1]?.[0];
        return (
          <button key={k} type="button" className={`dx-step${stage === k ? ' active' : ''}`} aria-pressed={stage === k}
            onClick={() => onStage(k === 'completed' ? 'all' : k === 'diagnosed' ? 'open' : k)}
            title={k === 'diagnosed' ? 'Show patients with treatment still open' : `Show work that got to “${label.toLowerCase()}” and stopped there`}>
            <span className="mx-label">{label}</span>
            <span className="dx-amount">{whole(v)}</span>
            <span className="dx-meter"><i style={{ width: `${share}%` }} /></span>
            <small>{k === 'diagnosed' ? `${t.exams} exams · ${whole(t.per_exam)} per exam` : `${pctText(t.of_diagnosed_pct[k])} of diagnosed · ${pctText(t.step_pct[k])} of ${prevKey}`}</small>
            {k === 'scheduled' && <small>Median {days(t.median_days_to_schedule)} to book</small>}
            {k === 'completed' && <small>Median {days(t.median_days_to_complete)} to finish</small>}
          </button>
        );
      })}
    </div>
  );
}

const ROW_COLS = [
  ['exams', 'Exams', (x) => x.exams],
  ['diagnosed', 'Diagnosed', (x) => whole(x.diagnosed)],
  ['per_exam', 'Per exam', (x) => whole(x.per_exam)],
  ['presented', 'Presented', (x) => pctText(x.of_diagnosed_pct.presented)],
  ['accepted', 'Accepted', (x) => pctText(x.of_diagnosed_pct.accepted)],
  ['scheduled', 'Scheduled', (x) => pctText(x.of_diagnosed_pct.scheduled)],
  ['completed', 'Completed', (x) => pctText(x.of_diagnosed_pct.completed)],
  ['still_open', 'Still open', (x) => whole(x.still_open)],
  ['days', 'Days to book', (x) => days(x.median_days_to_schedule)],
];
const Cells = ({ x }) => ROW_COLS.map(([k, , f]) => <td key={k} className="num">{f(x)}</td>);
const Head = ({ first }) => <tr><th>{first}</th>{ROW_COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr>;

export default function DiagnosisConversion() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const period = params.get('dx_period') || 'last_6_months';
  const examType = params.get('exam_type') || '';
  const stage = params.get('dx_stage') || 'open';
  const providerId = params.get('provider_id') || '';
  const locationId = params.get('location_id') || '';
  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  const scopeQ = useMemo(() => {
    const q = new URLSearchParams();
    if (providerId) q.set('provider_id', providerId);
    if (locationId) q.set('location_id', locationId);
    return q;
  }, [providerId, locationId]);
  const query = useMemo(() => {
    const q = new URLSearchParams(scopeQ);
    q.set('period', period);
    if (examType) q.set('exam_type', examType);
    return q.toString();
  }, [scopeQ, period, examType]);
  const runningQ = useMemo(() => {
    const q = new URLSearchParams(scopeQ);
    if (!providerId) { q.set('scope', 'practice'); q.set('per_provider', '1'); }
    return q.toString();
  }, [scopeQ, providerId]);
  const { data, error } = useApi(`/diagnosis/funnel?${query}`);
  const { data: pts, error: ptsError } = useApi(`/diagnosis/patients?${query}&stage=${stage}&limit=300`);
  const csv = useSubmit(() => download(`/diagnosis/funnel?${query}&format=csv`, 'diagnosis-conversion.csv'));
  const [showAllMonths, setShowAllMonths] = useState(false);
  const canCompare = can('reports:read');
  const maxMonth = Math.max(1, ...(data?.by_month || []).map((m) => m.total.diagnosed));
  const months = data?.by_month || [];

  return (
    <div className="dx-tab">
      <Running query={runningQ} provider={data?.providers?.length === 1 && providerId ? data.providers[0].name : null} />

      <section className="dx-section" aria-label="Conversion">
        <div className="mx-head">
          <div>
            <h2 style={{ margin: 0 }}><TrendingUp size={15} aria-hidden="true" /> From exam to finished treatment</h2>
            <p className="muted dx-sub" style={{ margin: '4px 0 0' }}>
              {data ? `Exams ${fmtDate(data.from)} – ${fmtDate(data.to)}. ` : ''}Work done later still counts for the exam where it was found, so recent months keep growing.
            </p>
          </div>
          <div className="mx-filters">
            <div className="mx-seg" role="group" aria-label="Exams from">
              {PERIODS.map(([k, l]) => <button key={k} type="button" className={period === k ? 'active' : ''} aria-pressed={period === k} onClick={() => set({ dx_period: k })}>{l}</button>)}
            </div>
            <div className="mx-seg" role="group" aria-label="Exam type">
              {TYPES.map(([k, l]) => <button key={k || 'all'} type="button" className={examType === k ? 'active' : ''} aria-pressed={examType === k} onClick={() => set({ exam_type: k })}>{l}</button>)}
            </div>
            <button type="button" className="small" onClick={() => csv.submit()} disabled={csv.busy || !data}><Download size={14} aria-hidden="true" /> CSV</button>
          </div>
        </div>
        <ErrorBox error={error || csv.error} />
        {!data ? <div className="muted">Loading…</div> : data.totals.exams === 0 ? <p className="muted">No completed exams in these dates{examType ? ' of this type' : ''}.</p> : (
          <>
            <div style={{ marginTop: 10 }}><Funnel t={data.totals} stage={stage} onStage={(s) => set({ dx_stage: s === 'open' ? '' : s })} /></div>
            {!examType && (
              <div className="dx-table-wrap" style={{ marginTop: 12 }}>
                <table className="compact-table dx-table">
                  <thead><Head first="Exam type" /></thead>
                  <tbody>
                    {data.by_exam_type.filter((t) => t.exams).map((t) => (
                      <tr key={t.exam_type}><td><button type="button" className="link" onClick={() => set({ exam_type: t.exam_type })}>{t.label}</button></td><Cells x={t} /></tr>
                    ))}
                    <tr className="dx-total"><td>All exams</td><Cells x={data.totals} /></tr>
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {data && data.providers.length > 0 && (
        <section className="dx-section" aria-label="By provider">
          <h2><Users size={15} aria-hidden="true" /> By provider</h2>
          <p className="muted dx-sub">Treatment found at a hygiene visit counts for the doctor who examined and for the hygienist; the totals count each exam once.{canCompare && !providerId ? ' Pick a provider to see only their numbers.' : ''}</p>
          <div className="dx-table-wrap">
            <table className="compact-table dx-table">
              <thead><Head first="Provider" /></thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.provider_id}>
                    <td>{canCompare && !providerId ? <button type="button" className="link" onClick={() => set({ provider_id: String(p.provider_id) })}>{p.name}</button> : p.name}{p.type === 'hygienist' ? <span className="muted"> · hygienist</span> : ''}</td>
                    <Cells x={p.total} />
                  </tr>
                ))}
                {data.providers.length > 1 && <tr className="dx-total"><td>Whole practice</td><Cells x={data.totals} /></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {months.length > 0 && (
        <section className="dx-section" aria-label="By month">
          <h2><TrendingUp size={15} aria-hidden="true" /> By month of the exam</h2>
          <div className="dx-table-wrap">
            <table className="compact-table dx-table">
              <thead><Head first="Month" /></thead>
              <tbody>
                {(showAllMonths ? months : months.slice(-12)).map((m) => (
                  <tr key={m.month}>
                    <td>{monthName(m.month)}<span className="dx-inline-bar" aria-hidden="true"><i style={{ width: `${Math.round((m.total.diagnosed / maxMonth) * 100)}%` }} /></span></td>
                    <Cells x={m.total} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {months.length > 12 && !showAllMonths && <button type="button" className="small" onClick={() => setShowAllMonths(true)}>Show all {months.length} months</button>}
        </section>
      )}

      <section className="dx-section" aria-label="Patients">
        <div className="mx-head">
          <h2 style={{ margin: 0 }}><ListChecks size={15} aria-hidden="true" /> Patients</h2>
          <div className="mx-seg" role="group" aria-label="Which patients">
            {STAGE_FILTERS.map(([k, l]) => <button key={k} type="button" className={stage === k ? 'active' : ''} aria-pressed={stage === k} onClick={() => set({ dx_stage: k === 'open' ? '' : k })}>{l}</button>)}
          </div>
        </div>
        <ErrorBox error={ptsError} />
        {!pts ? <div className="muted">Loading…</div> : pts.count === 0 ? <p className="muted">Nobody on this list.</p> : (
          <>
            <p className="muted dx-sub" style={{ marginTop: 6 }}>{pts.count} patient exam{pts.count === 1 ? '' : 's'} · {whole(pts.open)} still open{pts.count > pts.rows.length ? ` · first ${pts.rows.length} shown` : ''}</p>
            <div className="dx-table-wrap">
              <table className="compact-table dx-table">
                <thead><tr><th>Patient</th><th>Exam</th><th>Provider</th><th className="num">Diagnosed</th><th className="num">Still open</th><th>Next step</th><th>Next visit</th><th>Treatment</th></tr></thead>
                <tbody>
                  {pts.rows.map((r) => (
                    <tr key={`${r.patient_id}-${r.exam_date}`}>
                      <td><Link to={`/patients/${r.patient_id}`}>{r.first_name} {r.last_name}</Link></td>
                      <td>{fmtDate(r.exam_date)} <span className="muted">· {r.exam_type.replace('_', ' ')}</span></td>
                      <td>{r.provider_name || '—'}{r.hygienist_name ? <span className="muted"> · {r.hygienist_name}</span> : ''}</td>
                      <td className="num">{whole(r.diagnosed)}</td>
                      <td className="num">{whole(r.open)}</td>
                      <td><span className={`badge ${r.stage === 'completed' ? 'ok' : r.stage === 'scheduled' ? 'info' : 'warn'}`}>{STAGE_LABEL[r.stage]}</span></td>
                      <td>{r.next_visit ? fmtDateTime(r.next_visit) : <span className="muted">—</span>}</td>
                      <td className="dx-items">{r.items.map((i) => `${i.code}${i.tooth ? ` #${i.tooth}` : ''}`).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <p className="muted mx-foot">Diagnosed: treatment (not exams, x-rays or cleanings) charted on the day of a completed exam, at office fees; the same work charted again while still open counts once. Presented: on a treatment plan. Accepted: plan accepted or signed. Scheduled: on a booked visit. The full rules are in the metrics guide.</p>
    </div>
  );
}
