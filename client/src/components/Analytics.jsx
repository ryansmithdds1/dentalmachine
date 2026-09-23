import { useState } from 'react';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, shiftDate, practiceToday, label } from '../format.js';
import { api, downloadCsv, dollars } from '../api.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';
import { ProviderSelect, CsvButton, PrintButton } from './ReportControls.jsx';

const RANGES = [[29, '30 days'], [89, '90 days'], [364, '12 months']];
// Industry rules of thumb, used where the practice hasn't set its own goal.
const BENCH = { collection_rate: 98, case_acceptance: 60, hygiene_reappointment: 90, no_show_rate: 10, recall_current: 70, new_patients: null };
const TARGET_LABELS = [['collection_rate', 'Collection rate (%)'], ['case_acceptance', 'Case acceptance (%)'], ['hygiene_reappointment', 'Hygiene reappointment (%)'], ['no_show_rate', 'No-show & cancel rate, at most (%)'], ['recall_current', 'Patients current on recall (%)'], ['new_patients', 'New patients a month']];

function TargetsForm({ saved, onDone }) {
  const [form, setForm] = useState(Object.fromEntries(TARGET_LABELS.map(([k]) => [k, saved[k] ?? ''])));
  const { submit, busy, error } = useSubmit(async () => { await api.put('/practice', { kpi_targets: form }); onDone(); });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p className="muted" style={{ fontSize: 13 }}>Leave one blank to use the usual benchmark (shown greyed).</p>
      <div className="form-grid">
        {TARGET_LABELS.map(([k, l]) => <label key={k}>{l}<input type="number" min="0" step={k === 'new_patients' ? 1 : 0.5} value={form[k]} placeholder={BENCH[k] ?? 'none'} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save goals</button></div>
    </form>
  );
}
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
// The headline numbers as rows, for the spreadsheet download.
const kpiRows = (k) => [
  ['From', k.from], ['To', k.to], ['Gross production', dollars(k.production)], ['Collections', dollars(k.collections)], ['Adjustments', dollars(k.adjustments)],
  ['  Insurance write-offs', dollars(k.insurance_write_offs)], ['  Discounts', dollars(k.discounts)], ['  Other write-offs (bad debt, small balances)', dollars(k.other_write_offs)],
  ['Net production', dollars(k.net_production)], ['Collection rate %', k.collection_rate ?? ''], ['Average daily production', dollars(k.avg_daily_production)],
  ['Case acceptance %', k.case_acceptance.rate ?? ''], ['Hygiene reappointment %', k.hygiene_reappointment.rate ?? ''], ['No-show & cancel rate %', k.appointments.no_show_rate ?? ''],
  ['Patients current on recall %', k.recall_current_rate ?? ''], ['New patients', k.new_patients.total], ['Hygiene production', dollars(k.hygiene_production)],
];

export default function Analytics() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [days, setDays] = useState(89);
  const [prov, setProv] = useState('');
  const { data: k } = useApi(`/analytics?from=${shiftDate(today, -days)}&to=${today}${prov ? `&provider_id=${prov}` : ''}`);
  const { data: settings, reload: reloadSettings } = useApi('/practice');
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  if (!k) return <div className="empty">Crunching numbers…</div>;
  const saved = (() => { try { return JSON.parse(settings?.kpi_targets || '{}') || {}; } catch { return {}; } })();
  const T = { ...BENCH, ...saved };
  // New patients: the monthly goal, scaled to the range shown.
  const npTarget = T.new_patients != null ? Math.round((T.new_patients * (days + 1)) / 30.4) : null;
  const maxMonth = Math.max(1, ...k.monthly.map((m) => Math.max(m.production, m.collections)));
  const maxProv = Math.max(1, ...k.by_provider.map((p) => p.production));
  const totalNp = k.new_patients.total || 1;

  return (
    <>
      <div className="inline no-print" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="seg">
          {RANGES.map(([d, l]) => <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>Last {l}</button>)}
        </div>
        <ProviderSelect value={prov} onChange={setProv} />
        <CsvButton name={`kpis-${k.from}-to-${k.to}`} rows={kpiRows(k)} columns={[['Measure', (r) => r[0]], ['Value', (r) => r[1]]]} />
        <PrintButton />
        {user?.role === 'admin' && <button className="small" onClick={() => setEditing(true)}>Edit goals</button>}
      </div>
      {editing && <Modal title="KPI goals" onClose={() => setEditing(false)}><TargetsForm saved={saved} onDone={() => { setEditing(false); reloadSettings(); }} /></Modal>}
      {prov && <p className="muted" style={{ marginTop: -6 }}>One provider: their production, visits and plans; collections and write-offs are the payments credited to their work. New patients and recall are practice-wide.</p>}
      <div className="grid grid-4">
        <Kpi label="Gross production" value={short(k.production)} sub={`${short(k.avg_daily_production)} / day avg`} />
        <Kpi label="Collections" value={short(k.collections)} sub={`net production ${short(k.net_production)}`} />
        <Kpi label="Collection rate" value={k.collection_rate} suffix="%" target={T.collection_rate} sub="of net production" />
        <Kpi label="Case acceptance" value={k.case_acceptance.rate} suffix="%" target={T.case_acceptance} sub={`${short(k.case_acceptance.accepted)} of ${short(k.case_acceptance.presented)} presented`} />
        <Kpi label="Hygiene reappointment" value={k.hygiene_reappointment.rate} suffix="%" target={T.hygiene_reappointment} sub={`${k.hygiene_reappointment.reappointed} of ${k.hygiene_reappointment.visits} left booked`} />
        <Kpi label="No-show & cancel rate" value={k.appointments.no_show_rate} suffix="%" target={T.no_show_rate} invert sub={`${k.appointments.broken} broken · ${k.appointments.kept} kept`} />
        <Kpi label="Patients current on recall" value={k.recall_current_rate} suffix="%" target={T.recall_current} sub={`${k.active_patients} active patients`} />
        <Kpi label="New patients" value={k.new_patients.total} target={npTarget} sub={`hygiene production ${short(k.hygiene_production)}`} />
        <Kpi label="Insurance write-offs" value={short(k.insurance_write_offs)} sub={`${k.production ? Math.round((k.insurance_write_offs / k.production) * 1000) / 10 : 0}% of production · PPO contracts`} />
        <Kpi label="Discounts & other write-offs" value={short(k.discounts + k.other_write_offs)} sub={`discounts ${short(k.discounts)} · bad debt & other ${short(k.other_write_offs)}`} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Production & collections by month</h2>
            <button className="small no-print" onClick={() => downloadCsv('kpis-by-month', k.monthly, [['Month', (m) => m.month], ['Production', (m) => dollars(m.production)], ['Collections', (m) => dollars(m.collections)]])}>⬇ CSV</button>
          </div>
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
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Production by provider</h2>
            <button className="small no-print" onClick={() => downloadCsv('production-by-provider', k.by_provider, [['Provider', (p) => p.name], ['Type', (p) => label(p.type)], ['Production', (p) => dollars(p.production)]])}>⬇ CSV</button>
          </div>
          {k.by_provider.map((p) => (
            <div key={p.id} className="hbar">
              <div className="inline" style={{ justifyContent: 'space-between' }}><span>{p.name} <span className="muted">· {label(p.type)}</span></span><strong>{short(p.production)}</strong></div>
              <div className="hbar-track"><i style={{ width: `${(p.production / maxProv) * 100}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>New patients by referral source</h2>
            <button className="small no-print" disabled={!k.new_patients.by_source.length} onClick={() => downloadCsv('new-patients-by-source', k.new_patients.by_source, [['Source', (s) => s.source], ['New patients', (s) => s.n]])}>⬇ CSV</button>
          </div>
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
