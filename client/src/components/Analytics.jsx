import { useState } from 'react';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, shiftDate, practiceToday, label } from '../format.js';

const RANGES = [[29, '30 days'], [89, '90 days'], [364, '12 months']];
// Industry rules of thumb, shown as context next to each KPI.
const BENCH = { collection_rate: 98, case_acceptance: 60, hygiene_reappointment: 90, no_show_rate: 10, recall_current: 70 };
const short = (c) => money(c).replace('.00', '');

function Kpi({ label: l, value, suffix = '', target, invert, sub }) {
  const good = value == null || target == null ? null : invert ? value <= target : value >= target;
  return (
    <div className={`card stat kpi${good === true ? ' stat-ok' : good === false ? ' stat-warn' : ''}`}>
      <div className="label">{l}</div>
      <div className="value">{value == null ? '—' : `${value}${suffix}`}</div>
      <div className="sub">{sub}{target != null && <> · goal {invert ? '≤' : '≥'} {target}{suffix}</>}</div>
      {value != null && suffix === '%' && <div className="kpi-bar"><i style={{ width: `${Math.min(100, value)}%` }} />{target != null && <b style={{ left: `${target}%` }} />}</div>}
    </div>
  );
}

// Practice KPIs the leading PMS dashboards track.
export default function Analytics() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [days, setDays] = useState(89);
  const { data: k } = useApi(`/analytics?from=${shiftDate(today, -days)}&to=${today}`);
  if (!k) return <div className="empty">Crunching numbers…</div>;
  const maxMonth = Math.max(1, ...k.monthly.map((m) => Math.max(m.production, m.collections)));
  const maxProv = Math.max(1, ...k.by_provider.map((p) => p.production));
  const totalNp = k.new_patients.total || 1;

  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>
        {RANGES.map(([d, l]) => <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>Last {l}</button>)}
      </div>
      <div className="grid grid-4">
        <Kpi label="Gross production" value={short(k.production)} sub={`${short(k.avg_daily_production)} / day avg`} />
        <Kpi label="Collections" value={short(k.collections)} sub={`net production ${short(k.net_production)}`} />
        <Kpi label="Collection rate" value={k.collection_rate} suffix="%" target={BENCH.collection_rate} sub="of net production" />
        <Kpi label="Case acceptance" value={k.case_acceptance.rate} suffix="%" target={BENCH.case_acceptance} sub={`${short(k.case_acceptance.accepted)} of ${short(k.case_acceptance.presented)} presented`} />
        <Kpi label="Hygiene reappointment" value={k.hygiene_reappointment.rate} suffix="%" target={BENCH.hygiene_reappointment} sub={`${k.hygiene_reappointment.reappointed} of ${k.hygiene_reappointment.visits} left booked`} />
        <Kpi label="No-show & cancel rate" value={k.appointments.no_show_rate} suffix="%" target={BENCH.no_show_rate} invert sub={`${k.appointments.broken} broken · ${k.appointments.kept} kept`} />
        <Kpi label="Patients current on recall" value={k.recall_current_rate} suffix="%" target={BENCH.recall_current} sub={`${k.active_patients} active patients`} />
        <Kpi label="New patients" value={k.new_patients.total} sub={`hygiene production ${short(k.hygiene_production)}`} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Production & collections by month</h2>
          <div className="bars">
            {k.monthly.map((m) => (
              <div key={m.month} className="bar-col" title={`${m.month}\nProduction ${short(m.production)}\nCollections ${short(m.collections)}`}>
                <div className="bar-pair">
                  <i style={{ height: `${(m.production / maxMonth) * 100}%`, background: 'var(--primary)' }} />
                  <i style={{ height: `${(m.collections / maxMonth) * 100}%`, background: '#94a3b8' }} />
                </div>
                <span>{new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span>
              </div>
            ))}
          </div>
          <div className="legend" style={{ justifyContent: 'flex-start' }}><span><i style={{ background: 'var(--primary)' }} />Production</span><span><i style={{ background: '#94a3b8' }} />Collections</span></div>
        </div>
        <div className="card">
          <h2>Production by provider</h2>
          {k.by_provider.map((p) => (
            <div key={p.id} className="hbar">
              <div className="inline" style={{ justifyContent: 'space-between' }}><span>{p.name} <span className="muted">· {label(p.type)}</span></span><strong>{short(p.production)}</strong></div>
              <div className="hbar-track"><i style={{ width: `${(p.production / maxProv) * 100}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>New patients by referral source</h2>
          {k.new_patients.by_source.length === 0 && <div className="muted">No new patients in this period.</div>}
          {k.new_patients.by_source.map((s) => (
            <div key={s.source} className="hbar">
              <div className="inline" style={{ justifyContent: 'space-between' }}><span>{s.source}</span><strong>{s.n}</strong></div>
              <div className="hbar-track"><i style={{ width: `${(s.n / totalNp) * 100}%`, background: '#6366f1' }} /></div>
            </div>
          ))}
          <p className="muted" style={{ fontSize: 12 }}>Record “How did you hear about us?” on each new patient to see which marketing works.</p>
        </div>
      </div>
    </>
  );
}
