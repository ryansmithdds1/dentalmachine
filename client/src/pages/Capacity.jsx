// Capacity meter (CAP1–CAP2, docs/workflows/specs/CAP-capacity.md): is there enough doctor and hygiene time? For
// each kind of provider: how soon the next new patient, emergency, recall and treatment can get in, how full the
// coming weeks are against the office's own band, open time vs the work waiting, and what to do about it — each
// recommendation with the numbers behind it. Read-only (schedule:read); an administrator edits the targets in a
// side panel (T). No money on this screen.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CalendarClock, Target, Gauge, Users, Siren, Stethoscope, Sparkles, X, ArrowRight } from 'lucide-react';
import { api, getLocationId } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { fmtDate, fmtTime } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { StatusPill, waitText } from '../components/CapacityWidget.jsx';
import './capacity.css';

const pct = (p) => (p == null ? '—' : `${Math.round(p)}%`);
const hrs = (h) => (h == null ? '—' : h >= 10 ? `${Math.round(h)} h` : `${h} h`);
const KIND_ICON = { doctor: Stethoscope, hygiene: Sparkles };

export default function Capacity() {
  const { can, user } = useAuth();
  const offices = useLookup('/locations');
  const [office, setOffice] = useState(() => getLocationId() || '');
  const q = office ? `?location_id=${office}` : '?location_id=all';
  const { data, error, loading, reload } = useApi(`/capacity${q}`);
  const trend = useApi(`/capacity/trend${q}&days=90`);
  const [editing, setEditing] = useState(false);
  const admin = user?.role === 'admin';
  useShortcuts([
    { combo: 't', handler: () => setEditing((v) => !v), label: 'Capacity targets', section: 'Capacity' },
    { combo: 'r', handler: () => reload(), label: 'Refresh', section: 'Capacity' },
  ]);
  useCommands([{ id: 'capacity-targets', label: 'Capacity targets', hint: 'T', run: () => setEditing(true) }]);
  if (!can('schedule:read')) return <div className="card">You need access to the schedule to see capacity.</div>;
  const activeOffices = (offices || []).filter((o) => o.active !== 0);

  return (
    <div className="cap-page">
      <div className="page-header">
        <div>
          <h1><Gauge size={20} aria-hidden="true" /> Capacity</h1>
          <div className="muted">When to add a hygiene day, lengthen a doctor’s day or hold slots — so new patients, emergencies, recall and treatment all get in on time.</div>
        </div>
        <div className="actions">
          {activeOffices.length > 1 && (
            <select aria-label="Office" value={office} onChange={(e) => setOffice(e.target.value)}>
              <option value="">All offices</option>
              {activeOffices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <button onClick={() => setEditing(true)} title="Targets (T)"><Target size={15} aria-hidden="true" /> Targets</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <div className="card muted">Working out the next 8 weeks…</div>}
      {data && (
        <>
          <Recommendations recs={data.recommendations} />
          <div className="cap-kinds">
            {['doctor', 'hygiene'].map((k) => <KindCard key={k} k={data.kinds[k]} targets={data.targets} trend={(trend.data?.points || []).filter((p) => p.kind === k)} />)}
          </div>
          <Providers providers={data.providers} />
          <div className="muted cap-foot">As of {fmtDate(data.now.slice(0, 10))} {fmtTime(data.now)}{data.office ? ` · ${data.office.name}` : ''}. Targets: new patients within {data.targets.new_patient_days} days, emergencies within {data.targets.emergency_business_days} business day{data.targets.emergency_business_days === 1 ? '' : 's'}, hygiene within {data.targets.hygiene_days} days, treatment within {data.targets.treatment_days} days, {data.targets.booked_low}–{data.targets.booked_high}% booked.</div>
        </>
      )}
      {editing && <TargetsPanel admin={admin} onClose={() => setEditing(false)} onSaved={() => { reload(); trend.reload(); }} />}
    </div>
  );
}

function Recommendations({ recs }) {
  if (!recs.length) {
    return <div className="card cap-recs cap-allgood"><CheckCircle2 size={18} aria-hidden="true" /> Everything is on target: no changes to the schedule needed.</div>;
  }
  return (
    <section className="card cap-recs" aria-labelledby="cap-recs-h">
      <h2 id="cap-recs-h">What to do</h2>
      <ol>
        {recs.map((r) => (
          <li key={r.id} className={`cap-rec ${r.severity}`}>
            <StatusPill status={r.severity} />
            <div className="cap-rec-body">
              <div className="cap-rec-text">{r.text}</div>
              <div className="cap-rec-why muted">{r.because}</div>
            </div>
            {r.action && <Link className="cap-rec-go" to={r.action.to}>{r.action.label} <ArrowRight size={14} aria-hidden="true" /></Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function KindCard({ k, targets, trend }) {
  const Icon = KIND_ICON[k.kind];
  if (!k.provider_ids.length) {
    return <section className="card cap-kind"><h2><Icon size={17} aria-hidden="true" /> {k.label}</h2><div className="muted">No {k.label.toLowerCase()} providers work here.</div></section>;
  }
  const d = k.demand;
  return (
    <section className={`card cap-kind ${k.status}`} aria-label={`${k.label} capacity`}>
      <div className="cap-kind-head">
        <h2><Icon size={17} aria-hidden="true" /> {k.label}</h2>
        <StatusPill status={k.status} />
      </div>

      <h3><CalendarClock size={14} aria-hidden="true" /> First openings</h3>
      <div className="cap-chips">
        {Object.values(k.openings).map((m) => (
          <div key={m.key} className={`cap-chip ${m.status}`} title={m.opening ? `${fmtDate(m.opening.date)} ${fmtTime(m.opening.start)} with ${m.opening.provider} · target ${m.target} ${m.unit}` : `Nothing open in the next 4 months · target ${m.target} ${m.unit}`}>
            <span className="cap-chip-label">{m.label}</span>
            <strong>{waitText(m.days, m.unit)}</strong>
            <span className="cap-chip-date">{m.opening ? fmtDate(m.opening.date) : '—'}</span>
          </div>
        ))}
      </div>

      <h3><Gauge size={14} aria-hidden="true" /> Booked</h3>
      <div className="cap-meters">
        {[['w2', '2 weeks'], ['w4', '4 weeks'], ['w8', '8 weeks']].map(([w, label]) => (
          <BookedBar key={w} label={label} value={k.booked[w].pct} low={targets.booked_low} high={targets.booked_high}
            detail={`${hrs(round1(k.booked[w].booked_minutes / 60))} booked of ${hrs(round1(k.booked[w].available_minutes / 60))} available`} />
        ))}
      </div>

      <h3><Users size={14} aria-hidden="true" /> Open time vs work waiting <span className="muted">(hours a week, next 8 weeks)</span></h3>
      <SupplyDemand open={k.supply.open_hours_week} need={d.hours_week} gap={k.gap_hours_week} status={k.gap_status} parts={d.parts} />

      <dl className="cap-demand">
        {d.recall && <><dt>Recall due next 4 weeks</dt><dd>{d.recall.due_4w.patients} patients · {hrs(d.recall.due_4w.hours)}</dd>
          <dt>Recall due next 8 weeks</dt><dd>{d.recall.due_8w.patients} · {hrs(d.recall.due_8w.hours)}</dd>
          <dt>Overdue (last 12 months)</dt><dd>{d.recall.overdue.patients} · {hrs(d.recall.overdue.hours)}</dd></>}
        <dt>Unscheduled treatment</dt><dd>{d.unscheduled.patients} patients · {hrs(d.unscheduled.hours)}</dd>
        <dt>ASAP list</dt><dd>{d.asap.count}</dd>
        <dt>Online requests</dt><dd>{d.requests.count}{d.requests.count ? ` (oldest ${d.requests.oldest_days} d)` : ''}</dd>
        {d.emergencies && <><dt><Siren size={12} aria-hidden="true" /> Emergencies</dt><dd>{d.emergencies.per_day} a day</dd></>}
        {d.new_patients && <><dt>New patients</dt><dd>{d.new_patients.per_week} a week</dd></>}
        <dt>Open perfect-day blocks (2 wk)</dt><dd>{k.blocks.count}{k.blocks.count ? ` · ${hrs(k.blocks.hours)}` : ''}</dd>
      </dl>

      <Sparkline points={trend} low={targets.booked_low} high={targets.booked_high} />
    </section>
  );
}
const round1 = (n) => Math.round(n * 10) / 10;

// A horizontal bar 0–100% with the target band shaded behind it and the value as a thick mark.
export function BookedBar({ label, value, low, high, detail }) {
  const status = value == null ? 'none' : value < low ? (value >= low - 10 ? 'amber' : 'red') : value > high ? (value >= high + (100 - high) / 2 ? 'red' : 'amber') : 'green';
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="cap-bar-row" title={detail}>
      <span className="cap-bar-label">{label}</span>
      <div className="cap-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0} aria-label={`${label} booked ${pct(value)}, target ${low}–${high}%`}>
        <div className="cap-band" style={{ left: `${low}%`, width: `${high - low}%` }} />
        <div className={`cap-fill ${status}`} style={{ width: `${v}%` }} />
      </div>
      <strong className="cap-bar-value">{pct(value)}</strong>
    </div>
  );
}

function SupplyDemand({ open, need, gap, status, parts }) {
  const max = Math.max(open, need, 1);
  const why = `Needed: recall due ${parts.recall_due} + overdue ${parts.recall_overdue} + unscheduled ${parts.unscheduled} + new patients ${parts.new_patients} + emergencies ${parts.emergencies}`;
  return (
    <div className="cap-sd">
      <div className="cap-sd-row"><span>Open</span><div className="cap-sd-track"><div className="cap-sd-fill open" style={{ width: `${(open / max) * 100}%` }} /></div><strong>{hrs(open)}</strong></div>
      <div className="cap-sd-row" title={why}><span>Needed</span><div className="cap-sd-track"><div className="cap-sd-fill need" style={{ width: `${(need / max) * 100}%` }} /></div><strong>{hrs(need)}</strong></div>
      <div className="cap-sd-gap"><StatusPill status={status}>{gap >= 0 ? `${hrs(gap)} a week to spare` : `${hrs(-gap)} a week short`}</StatusPill></div>
    </div>
  );
}

// The 4-week booked % over the last 90 nights, with the target band.
function Sparkline({ points, low, high }) {
  const [hover, setHover] = useState(null);
  const pts = points.filter((p) => p.booked_pct_4w != null);
  if (pts.length < 2) return <div className="cap-spark-empty muted">The trend fills in night by night.</div>;
  const W = 280; const H = 56;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.booked_pct_4w).toFixed(1)}`).join(' ');
  const h = hover != null ? pts[hover] : pts.at(-1);
  return (
    <figure className="cap-spark">
      <figcaption className="muted">Booked next 4 weeks, last {pts.length} nights · <strong>{fmtDate(h.date)}: {pct(h.booked_pct_4w)}</strong>{h.first_recall_days != null ? ` · recall ${waitText(h.first_recall_days)}` : ''}{h.first_treatment_days != null ? ` · treatment ${waitText(h.first_treatment_days)}` : ''}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Booked percentage trend"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))); }}>
        <rect className="cap-spark-band" x="0" y={y(high)} width={W} height={y(low) - y(high)} />
        <path className="cap-spark-line" d={path} vectorEffect="non-scaling-stroke" />
        {hover != null && <circle className="cap-spark-dot" cx={x(hover)} cy={y(pts[hover].booked_pct_4w)} r="3.5" vectorEffect="non-scaling-stroke" />}
      </svg>
    </figure>
  );
}

function Providers({ providers }) {
  if (!providers.length) return null;
  const main = (p) => p.openings.treatment_60 || p.openings.recall || Object.values(p.openings)[0];
  return (
    <section className="card cap-providers">
      <h2>By provider</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Provider</th><th>Next 2 wk</th><th>4 wk</th><th>8 wk</th><th>First opening</th><th>Status</th></tr></thead>
          <tbody>
            {providers.map((p) => {
              const m = main(p);
              return (
                <tr key={p.id}>
                  <td>{p.name} <span className="muted">· {p.kind}</span></td>
                  <td>{pct(p.booked.w2.pct)}</td><td>{pct(p.booked.w4.pct)}</td><td>{pct(p.booked.w8.pct)}</td>
                  <td>{m ? `${m.label}: ${waitText(m.days, m.unit)}${m.opening ? ` (${fmtDate(m.opening.date)})` : ''}` : '—'}</td>
                  <td><StatusPill status={p.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const FIELDS = [
  ['new_patient_days', 'New patients seen within', 'days'],
  ['emergency_business_days', 'Emergencies seen within', 'business days'],
  ['hygiene_days', 'Recall / hygiene within', 'days'],
  ['treatment_days', 'Treatment within', 'days'],
  ['booked_low', 'Booked at least', '%'],
  ['booked_high', 'Booked at most', '%'],
  ['backlog_weeks', 'Work off overdue recall and unscheduled treatment over', 'weeks'],
];
// Side panel (no modal): targets saved on Save, audited on the server.
function TargetsPanel({ admin, onClose, onSaved }) {
  const { data } = useApi('/capacity/targets');
  const typesList = useLookup('/appointment-types');
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !form) setForm({ ...data.targets }); }, [data, form]);
  useShortcuts([{ combo: 'escape', handler: onClose, label: 'Close targets', section: 'Capacity', inInputs: true }]);
  const types = useMemo(() => (typesList || []).filter((t) => t.active !== 0), [typesList]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => v !== data.targets[k]).map(([k, v]) => [k, v === '' ? null : v]));
      await api.put('/capacity/targets', changed);
      toast('Capacity targets saved');
      onSaved();
      onClose();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <aside className="drawer cap-drawer" aria-label="Capacity targets">
      <div className="drawer-head"><strong><Target size={15} aria-hidden="true" /> Capacity targets</strong><button className="link" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
      <form className="drawer-body" onSubmit={save}>
        {!admin && <p className="muted">Only an administrator can change these.</p>}
        <ErrorBox error={err} />
        {form && FIELDS.map(([k, label, unit], i) => (
          <label key={k} className="cap-field">
            <span>{label}</span>
            <span className="cap-field-input"><input type="number" min="0" disabled={!admin} autoFocus={i === 0 && admin} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value === '' ? '' : Number(e.target.value) })} /> <span className="muted">{unit}</span></span>
          </label>
        ))}
        {form && [['new_patient_type_id', 'New patient visit'], ['emergency_type_id', 'Emergency visit']].map(([k, label]) => (
          <label key={k} className="cap-field">
            <span>{label}</span>
            <select disabled={!admin} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Find it automatically</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ))}
        {admin && <div className="drawer-actions"><button className="primary" disabled={busy || !form}>Save targets</button><button type="button" onClick={onClose}>Cancel</button></div>}
      </form>
    </aside>
  );
}
