import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BadgeCheck, MessageSquare, PhoneCall, RefreshCw, Upload, FileText, CalendarCheck, Users, Play, ShieldAlert, Clock, X, History } from 'lucide-react';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { money, fmtDate, fmtTime, fmtUtcDateTime, shiftDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { VerifyPills } from '../components/VerifyBadge.jsx';
import './verification.css';

// Insurance verification center (IV1–IV4, docs/workflows/specs/IV-verification.md). Every upcoming patient
// with two statuses — eligibility and the full benefit breakdown — and what's missing. Eligibility runs by
// itself before each visit and the morning of; clean answers are applied on their own, breakdowns and all.
// The screen leads with the exceptions, each with one-key actions: T text the patient for their new card,
// S the payer phone script, P verified by phone, E check now, U read a portal page or fax, O open the chart.

const RANGES = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['two_weeks', 'Next 14 days']];
const VIEWS = [['attention', 'Needs a person'], ['waiting', 'Waiting on patient'], ['all', 'Everyone']];
const remembered = () => { try { return localStorage.getItem('dm.verify.range'); } catch { return null; } };
const remember = (r) => { try { localStorage.setItem('dm.verify.range', r); } catch { /* storage unavailable */ } };

export const FIELD_LABELS = {
  annual_max: 'Annual maximum', deductible: 'Deductible', family_deductible: 'Family deductible', pct_preventive: 'Preventive & diagnostic', pct_basic: 'Basic',
  pct_major: 'Major', benefit_month: 'Benefit year starts (month)', ortho_max: 'Ortho lifetime maximum', ortho_pct: 'Ortho', ortho_age_limit: 'Ortho age limit',
  wait_basic_months: 'Waiting period, basic', wait_major_months: 'Waiting period, major', downgrade_composites: 'Back-tooth composites paid as amalgam',
  missing_tooth_clause: 'Missing tooth clause', frequencies: 'Frequency limits', coverage_overrides: 'Paid differently by code', age_limits: 'Age limits',
  max_used: 'Maximum used (this patient)', max_remaining: 'Maximum left (this patient)', deductible_met: 'Deductible met (this patient)',
  deductible_remaining: 'Deductible left (this patient)', plan_begin: 'Coverage starts', plan_end: 'Coverage ends', history: 'Services already used',
};
const MONEY = new Set(['annual_max', 'deductible', 'family_deductible', 'ortho_max', 'max_used', 'max_remaining', 'deductible_met', 'deductible_remaining']);
const PCT = new Set(['pct_preventive', 'pct_basic', 'pct_major', 'ortho_pct']);
const MONTHS = new Set(['wait_basic_months', 'wait_major_months']);
const BOOL = new Set(['downgrade_composites', 'missing_tooth_clause']);
const every = (f) => (f.months ? (f.months % 12 === 0 ? `${f.months / 12} yr` : `${f.months} mo`) : 'benefit year');
export function show(k, v) {
  if (v == null || v === '') return '—';
  if (MONEY.has(k)) return money(v);
  if (PCT.has(k)) return `${v}%`;
  if (MONTHS.has(k)) return Number(v) ? `${v} months` : 'None';
  if (BOOL.has(k)) return Number(v) ? 'Yes' : 'No';
  if (k === 'frequencies' && Array.isArray(v)) return v.map((f) => `${f.label || f.codes.join('/')}: ${f.count}× per ${every(f)}`).join(' · ');
  if (k === 'coverage_overrides' && v && typeof v === 'object') return Object.entries(v).map(([c, p]) => `${c} ${p}%`).join(' · ');
  if (k === 'history' && Array.isArray(v)) return v.map((x) => `${x.codes.join('/')} ${fmtDate(x.date)}`).join(' · ');
  if (k === 'plan_begin' || k === 'plan_end') return fmtDate(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// embedded: shown as the Verification tab of Billing (its own page before), so its heading is a section's.
export default function Verification({ embedded = false }) {
  const { can, user, practice } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || remembered() || 'week';
  const office = params.get('office') || '';
  const view = params.get('view') || 'attention';
  const set = (patch) => setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const setRange = (r) => { remember(r); set({ range: r }); };
  const { data, error, reload } = useApi(`/verification/upcoming?range=${range}${office ? `&location_id=${office}` : ''}`);
  const metrics = useApi(`/verification/metrics${office ? `?location_id=${office}` : ''}`);
  const reviews = useApi('/verification/reviews');
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(() => new Set());
  const [at, setAt] = useState(0);
  const [panel, setPanel] = useState(null);
  const fileRef = useRef(null);
  const canWrite = can('billing:write');

  const rows = useMemo(() => (data?.rows || []).filter((r) => {
    if (view === 'all') return true;
    const key = `${r.appointment_id}`;
    if (view === 'waiting') return r.waiting;
    return r.exceptions.length > 0 && !r.waiting && !gone.has(key);
  }), [data, view, gone]);
  const current = rows[Math.min(at, rows.length - 1)] || null;
  const needsPerson = (data?.rows || []).filter((r) => r.exceptions.length > 0 && !r.waiting && !gone.has(`${r.appointment_id}`)).length;
  useEffect(() => { if (at > rows.length - 1) setAt(Math.max(rows.length - 1, 0)); }, [rows.length, at]);
  useEffect(() => { setPanel(null); }, [current?.appointment_id]);
  const refresh = () => { reload(); metrics.reload(); reviews.reload(); };

  const act = async (fn, { keepRow = true } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (!keepRow) setGone((g) => new Set(g).add(`${current.appointment_id}`));
      refresh();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const runAll = () => act(async () => {
    const out = await api.post('/verification/run', { range, location_id: office || undefined });
    toast(`Checked ${out.checked}${out.applied ? ` · ${out.applied} applied to the plan` : ''}${out.needs_look ? ` · ${out.needs_look} need a look` : ''}${out.skipped ? ` · ${out.skipped} already checked today` : ''}${out.failed.length ? ` · ${out.failed.length} couldn’t be checked` : ''}`);
  });
  const textPatient = (r = current) => r && canWrite && act(async () => {
    const out = await api.post(`/patients/${r.patient_id}/request-insurance`);
    toast(out.already ? `${r.patient_name} was already sent a link today` : `Texted ${r.patient_name} a secure link for a photo of their card (${out.to}). It lands in Intake review.`);
  }, { keepRow: false });
  const checkNow = (r = current) => r?.policy && act(async () => {
    const out = await api.post(`/verification/policies/${r.policy.id}/check`);
    toast(out.mode === 'manual' ? 'The request is ready for the clearinghouse portal (Billing → Eligibility)' : `${r.patient_name}: ${out.status === 'active' ? 'coverage active' : out.status}${out.applied ? ' — applied to the plan' : out.reasons?.length ? ` — needs a look: ${out.reasons[0]}` : ''}`);
  });
  const upload = () => canWrite && current?.policy && fileRef.current?.click();
  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !current?.policy) return;
    act(async () => {
      const res = await fetch(`/api/verification/policies/${current.policy.id}/read-document?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'The document couldn’t be read');
      setPanel({ kind: 'read', read: out });
    });
  };

  useShortcuts([
    { combo: 'j', label: 'Next patient', section: 'Verification', handler: () => setAt((i) => Math.min(i + 1, Math.max(rows.length - 1, 0))) },
    { combo: 'k', label: 'Previous patient', section: 'Verification', handler: () => setAt((i) => Math.max(i - 1, 0)) },
    { combo: 'r', label: 'Check everyone in this range now', section: 'Verification', enabled: !!data?.automatic, handler: runAll },
    { combo: 't', label: 'Text the patient for their new insurance card', section: 'Verification', enabled: !!current && canWrite, handler: () => textPatient() },
    { combo: 's', label: 'Payer phone script', section: 'Verification', enabled: !!current?.policy, handler: () => setPanel((p) => (p?.kind === 'script' ? null : { kind: 'script' })) },
    { combo: 'p', label: 'Verified by phone', section: 'Verification', enabled: !!current?.policy && canWrite, handler: () => setPanel({ kind: 'phone' }) },
    { combo: 'e', label: 'Check eligibility now', section: 'Verification', enabled: !!current?.policy, handler: () => checkNow() },
    { combo: 'u', label: 'Read a portal page or fax', section: 'Verification', enabled: !!current?.policy && canWrite, handler: upload },
    { combo: 'o', label: 'Open the chart', section: 'Verification', enabled: !!current, handler: () => nav(`/patients/${current.patient_id}?tab=insurance`) },
    { combo: 'v', label: 'Switch view (needs a person / waiting / everyone)', section: 'Verification', handler: () => set({ view: VIEWS[(VIEWS.findIndex(([k]) => k === view) + 1) % VIEWS.length][0] }) },
    ...RANGES.map(([k, label], i) => ({ combo: String(i + 1), label: `Show ${label.toLowerCase()}`, section: 'Verification', handler: () => setRange(k) })),
  ]);
  useCommands([
    { id: 'verify-tomorrow', label: 'Insurance verification: tomorrow’s patients', hint: 'Verification', run: () => setRange('tomorrow') },
    { id: 'verify-run', label: 'Insurance verification: check everyone now', hint: 'Verification', run: runAll },
  ]);

  const s = data?.summary;
  const m = metrics.data;
  return (
    <div className="vf-page">
      <div className="page-header">
        <div>
          {embedded ? <h2 className="vf-title">Insurance verification</h2> : <h1>Insurance verification</h1>}
          <div className="muted">
            {data?.automatic
              ? `Eligibility is checked by itself ${data.settings.days_ahead ? `${data.settings.days_ahead} day${data.settings.days_ahead === 1 ? '' : 's'} before each visit` : ''}${data.settings.days_ahead && data.settings.morning_of ? ' and ' : ''}${data.settings.morning_of ? 'the morning of' : ''}; full breakdowns are applied to the whole plan. You only see what needs a person.`
              : 'Connect a real-time clearinghouse (Settings → Integrations) and eligibility runs by itself. Until then verify by phone (P) or read the payer portal page (U).'}
          </div>
        </div>
        <div className="inline vf-head-actions">
          {data && <span className={`vf-state ${data.automatic ? 'on' : ''}`}><span className="vf-dot" />{data.automatic ? 'Automatic' : 'Manual'}</span>}
          {data?.automatic && can('billing:read') && <button className="primary" disabled={busy || !data.rows.length} onClick={runAll}><Play size={15} /> Check everyone <kbd>R</kbd></button>}
        </div>
      </div>

      <div className="vf-controls">
        <div className="seg" role="group" aria-label="When">
          {RANGES.map(([k, label], i) => <button key={k} type="button" className={range === k ? 'active' : ''} onClick={() => setRange(k)} title={`Key ${i + 1}`}>{label}</button>)}
        </div>
        {data?.offices?.length > 1 && (
          <select value={office} onChange={(e) => set({ office: e.target.value })} aria-label="Office">
            <option value="">All offices</option>
            {data.offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <div className="seg vf-views" role="group" aria-label="Show">
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" className={view === k ? 'active' : ''} onClick={() => set({ view: k })}>
              {label}{k === 'attention' && s ? <span className="vf-count">{needsPerson}</span> : k === 'waiting' && s?.waiting ? <span className="vf-count">{s.waiting}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {s && (
        <div className="vf-tiles">
          <Tile label="Visits" value={s.visits} hint={`${s.insured} with insurance`} />
          <Tile label="Eligibility verified" value={pctOf(s.eligibility_verified, s.insured)} tone={s.eligibility_verified === s.insured ? 'good' : 'warn'} hint={`${s.eligibility_verified} of ${s.insured}`} />
          <Tile label="Breakdown verified" value={pctOf(s.breakdown_verified, s.insured)} tone={s.breakdown_verified === s.insured ? 'good' : 'warn'} hint={`${s.breakdown_verified} of ${s.insured} (stale after ${data.settings.breakdown_stale_days} days)`} />
          <Tile label="Needs a person" value={needsPerson} tone={needsPerson ? 'bad' : 'good'} hint={s.waiting ? `${s.waiting} waiting on the patient` : 'the list below'} />
          {m && <Tile label="Verified 48 h ahead" value={m.pct_verified_48h == null ? '—' : `${m.pct_verified_48h}%`} tone={m.pct_verified_48h >= 95 ? 'good' : m.pct_verified_48h == null ? '' : 'warn'} hint={`last 30 days · ${m.verified_48h} of ${m.visits} visits`} />}
          {m && <Tile label="Stale breakdowns" value={m.stale_breakdowns} tone={m.stale_breakdowns ? 'warn' : 'good'} hint="plans of patients booked in the next 14 days" />}
        </div>
      )}

      {reviews.data?.length > 0 && <Reviews items={reviews.data} canWrite={canWrite} onDone={refresh} />}
      <ErrorBox error={error} />
      <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,text/plain" hidden onChange={onFile} aria-hidden tabIndex={-1} />

      <div className="vf-main">
        <section className="vf-list" aria-label="Patients">
          {data && !rows.length && (
            <div className="vf-empty"><CalendarCheck size={22} /> {view === 'attention' ? 'Nothing needs a person. Everyone else is verified or being checked automatically.' : view === 'waiting' ? 'Nobody is waiting on a patient.' : 'No visits in this range.'}</div>
          )}
          {!data && !error && <div className="vf-empty">Loading…</div>}
          {rows.map((r, i) => (
            <div key={r.appointment_id} role="listitem" className={`vf-row ${current?.appointment_id === r.appointment_id ? 'current' : ''}`} onClick={() => setAt(i)}>
              <div className="vf-when"><b>{r.date === data.today ? 'Today' : r.date === shiftDate(data.today, 1) ? 'Tomorrow' : fmtDate(r.date)}</b><span>{fmtTime(r.start_time)}</span>{r.location_name && data.offices.length > 1 && <small>{r.location_name}</small>}</div>
              <div className="vf-who">
                <Link to={`/patients/${r.patient_id}?tab=insurance`} className="vf-name" onClick={(e) => e.stopPropagation()}>{r.patient_name}</Link>
                <span className="muted">{r.policy ? `${r.policy.carrier_name}${r.policy.group_number ? ` · group ${r.policy.group_number}` : ''}` : 'No insurance on file'}</span>
                {r.exceptions.length > 0 && (
                  <div className="vf-chips">
                    {r.exceptions.map((x) => <span key={x.kind} className={`vf-chip ${SEVERE.has(x.kind) ? 'bad' : x.kind === 'breakdown_stale' ? 'soft' : 'warn'}`} title={x.detail}>{x.label}</span>)}
                    {r.waiting && <span className="vf-chip info"><Clock size={11} /> Texted {fmtUtcDateTime(r.requested_at, practice?.timezone)}</span>}
                  </div>
                )}
              </div>
              <VerifyPills eligibility={r.eligibility} breakdown={r.breakdown} />
            </div>
          ))}
        </section>
        {current && (
          <Panel row={current} panel={panel} setPanel={setPanel} canWrite={canWrite} busy={busy} tz={practice?.timezone} user={user}
            onText={() => textPatient()} onCheck={() => checkNow()} onUpload={upload} onDone={refresh} />
        )}
      </div>
    </div>
  );
}

const SEVERE = new Set(['inactive', 'terminated', 'check_failed']);
const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Tile({ label, value, hint, tone = '' }) {
  return (
    <div className={`vf-tile ${tone}`}>
      <div className="vf-tile-label">{label}</div>
      <div className="vf-tile-value">{value}</div>
      {hint && <div className="vf-tile-hint">{hint}</div>}
    </div>
  );
}

// ---- The side panel: the current patient's statuses, exceptions and actions ----
function Panel({ row, panel, setPanel, canWrite, busy, tz, onText, onCheck, onUpload, onDone }) {
  const detail = useApi(row.policy ? `/verification/policies/${row.policy.id}` : null, [row.eligibility.at, row.breakdown.at]);
  const e = row.eligibility;
  const b = row.breakdown;
  return (
    <aside className="vf-panel card" aria-label={`Insurance for ${row.patient_name}`}>
      <div className="vf-panel-head">
        <div>
          <h2>{row.patient_name}</h2>
          <div className="muted">{fmtDate(row.date)} at {fmtTime(row.start_time)}{row.provider_name ? ` · ${row.provider_name}` : ''}</div>
        </div>
        <Link to={`/patients/${row.patient_id}?tab=insurance`} className="button small" title="Key O">Chart <kbd>O</kbd></Link>
      </div>
      {row.policy ? (
        <>
          <div className="vf-policy">
            <div><b>{row.policy.carrier_name}</b>{row.policy.payer_phone && <a href={`tel:${row.policy.payer_phone}`} className="vf-phone"><PhoneCall size={13} /> {row.policy.payer_phone}</a>}</div>
            <div className="muted">Member {row.policy.subscriber_id || '—'} · group {row.policy.group_number || '—'} · subscriber {row.policy.subscriber_name}{row.policy.relationship !== 'self' ? ` (${row.policy.relationship})` : ''}</div>
          </div>
          <div className="vf-status-grid">
            <Status title="Eligibility" s={e} tz={tz} extra={e.plan_end ? `Coverage ends ${fmtDate(e.plan_end)}` : null} />
            <Status title="Full breakdown" s={b} tz={tz} extra={b.via_group ? 'Verified for another patient on the same plan' : b.patients_updated > 1 ? `Updated ${b.patients_updated} patients on the plan` : b.why || null} />
          </div>
          {row.remaining && <div className="vf-remaining"><span>Maximum left</span><b>{money(row.remaining.max_remaining)}</b><span className="muted">of {money(row.remaining.annual_max)} {row.remaining.source === 'payer' ? '(payer)' : '(from claims here)'}</span></div>}
        </>
      ) : <p className="muted">No insurance on file{row.pending_update ? ' — the patient sent new insurance: enter it from their Insurance tab.' : '.'}</p>}

      {row.exceptions.length > 0 && (
        <ul className="vf-exceptions">
          {row.exceptions.map((x) => <li key={x.kind} className={SEVERE.has(x.kind) ? 'bad' : ''}><ShieldAlert size={14} /><div><b>{x.label}</b><span>{x.detail}</span></div></li>)}
        </ul>
      )}
      {row.missing.length > 0 && <p className="vf-missing">Missing: {row.missing.join(', ')} — <Link to={`/patients/${row.patient_id}?tab=insurance`}>add on the Insurance tab</Link></p>}

      <div className="vf-actions">
        {canWrite && <button type="button" disabled={busy} onClick={onText}><MessageSquare size={14} /> Text for new card <kbd>T</kbd></button>}
        {row.policy && <button type="button" onClick={() => setPanel(panel?.kind === 'script' ? null : { kind: 'script' })}><FileText size={14} /> Phone script <kbd>S</kbd></button>}
        {row.policy && canWrite && <button type="button" onClick={() => setPanel({ kind: 'phone' })}><PhoneCall size={14} /> Verified by phone <kbd>P</kbd></button>}
        {row.policy && <button type="button" disabled={busy} onClick={onCheck}><RefreshCw size={14} /> Check now <kbd>E</kbd></button>}
        {row.policy && canWrite && <button type="button" disabled={busy} onClick={onUpload}><Upload size={14} /> Read portal page or fax <kbd>U</kbd></button>}
      </div>

      {panel?.kind === 'script' && detail.data && (
        <div className="vf-script">
          <div className="vf-sub-head"><b>Payer phone script</b><button type="button" className="link" onClick={() => setPanel(null)} aria-label="Close"><X size={14} /></button></div>
          <pre>{detail.data.script}</pre>
        </div>
      )}
      {panel?.kind === 'phone' && <PhoneForm row={row} plan={detail.data?.plan} onClose={() => setPanel(null)} onDone={onDone} />}
      {panel?.kind === 'read' && <ReadConfirm read={panel.read} onClose={() => setPanel(null)} onDone={onDone} />}
      {detail.data?.drafts?.length > 0 && !panel && (
        <p className="vf-note">An AI read of a benefit document is waiting to be checked. <button type="button" className="link" onClick={async () => setPanel({ kind: 'read', read: await api.get(`/verification/reads/${detail.data.drafts[0].id}`) })}>Check it now</button></p>
      )}
      {detail.data && <HistoryList detail={detail.data} tz={tz} />}
    </aside>
  );
}

function Status({ title, s, tz, extra }) {
  const tone = ['verified'].includes(s.state) ? 'ok' : ['inactive', 'error'].includes(s.state) ? 'bad' : 'warn';
  return (
    <div className={`vf-status ${tone}`}>
      <div className="vf-status-title">{title}</div>
      <div className="vf-status-label">{s.label}</div>
      {s.at && <div className="vf-status-meta">{s.how} · {fmtUtcDateTime(s.at, tz)}{s.by ? ` · ${s.by}` : ''}{s.reference ? ` · ref ${s.reference}` : ''}</div>}
      {extra && <div className="vf-status-meta">{extra}</div>}
    </div>
  );
}

// ---- Verified by phone: the answer, the reference number and the representative, and (optionally) the benefits ----
const PHONE_PLAN = ['annual_max', 'deductible', 'pct_preventive', 'pct_basic', 'pct_major', 'wait_basic_months', 'wait_major_months', 'family_deductible'];
const PHONE_PATIENT = ['max_remaining', 'deductible_met'];
function PhoneForm({ row, plan, onClose, onDone }) {
  const [active, setActive] = useState(true);
  const [reference, setReference] = useState('');
  const [rep, setRep] = useState('');
  const [planEnd, setPlanEnd] = useState('');
  const [more, setMore] = useState(false);
  const [vals, setVals] = useState({});
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  const num = (k) => {
    const v = vals[k];
    if (v == null || v === '') return undefined;
    return MONEY.has(k) ? Math.round(Number(v) * 100) : Math.round(Number(v));
  };
  const submit = async (ev) => {
    ev.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      const planFields = Object.fromEntries(PHONE_PLAN.map((k) => [k, num(k)]).filter(([, v]) => v !== undefined));
      const patient = Object.fromEntries(PHONE_PATIENT.map((k) => [k, num(k)]).filter(([, v]) => v !== undefined));
      const out = await api.post(`/verification/policies/${row.policy.id}/phone`, { active, reference, rep_name: rep, plan_end: planEnd || null, plan: planFields, patient });
      const v = out.verification;
      toast(`${row.patient_name}: verified by phone (ref ${reference})${v?.group_status === 'applied' && v.patients_updated > 1 ? ` — ${v.patients_updated} patients on the plan updated` : v?.group_status === 'review' ? ' — the plan change is waiting for review' : ''}`);
      onClose();
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="vf-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="vf-sub-head"><b>Verified by phone</b><button type="button" className="link" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      <div className="seg" role="group" aria-label="Coverage">
        <button type="button" className={active ? 'active' : ''} onClick={() => setActive(true)}>Active</button>
        <button type="button" className={!active ? 'active' : ''} onClick={() => setActive(false)}>Not active</button>
      </div>
      <div className="vf-form-row">
        <label>Reference #<input ref={first} name="reference" value={reference} onChange={(e) => setReference(e.target.value)} required autoComplete="off" /></label>
        <label>Representative<input name="rep_name" value={rep} onChange={(e) => setRep(e.target.value)} required autoComplete="off" /></label>
        <label>Coverage ends<input type="date" value={planEnd} onChange={(e) => setPlanEnd(e.target.value)} /></label>
      </div>
      <button type="button" className="link" onClick={() => setMore(!more)}>{more ? 'Hide benefits' : 'Add the benefits they read out (updates everyone on the plan)'}</button>
      {more && (
        <div className="vf-form-grid">
          {[...PHONE_PLAN, ...PHONE_PATIENT].map((k) => (
            <label key={k}>{FIELD_LABELS[k]}{MONEY.has(k) ? ' ($)' : PCT.has(k) ? ' (%)' : MONTHS.has(k) ? ' (months)' : ''}
              <input inputMode="decimal" value={vals[k] ?? ''} placeholder={plan && plan[k] != null ? (MONEY.has(k) ? String(plan[k] / 100) : String(plan[k])) : ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" disabled={saving || !reference.trim() || !rep.trim()}>Save <kbd>Enter</kbd></button></div>
    </form>
  );
}

// ---- A document read by AI: each field next to what's on file; only the ticked ones are applied ----
function ReadConfirm({ read, onClose, onDone }) {
  const fields = [...Object.entries(read.proposed.plan || {}).map(([k, v]) => ({ k, v, now: read.current?.[k], own: false })), ...Object.entries(read.proposed.patient || {}).map(([k, v]) => ({ k, v, now: read.current_patient?.[k], own: true }))];
  const [ticked, setTicked] = useState(() => new Set());
  const [edits, setEdits] = useState({});
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const editable = (k) => MONEY.has(k) || PCT.has(k) || MONTHS.has(k) || ['benefit_month', 'ortho_age_limit'].includes(k);
  const toggle = (k) => setTicked((t) => { const n = new Set(t); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const confirm = async () => {
    setErr(null);
    setSaving(true);
    try {
      const values = Object.fromEntries(Object.entries(edits).filter(([k]) => ticked.has(k)).map(([k, v]) => [k, MONEY.has(k) ? Math.round(Number(v) * 100) : Math.round(Number(v))]));
      const out = await api.post(`/verification/reads/${read.id}/confirm`, { confirmed: [...ticked], values });
      const v = out.verification;
      toast(`Applied ${out.confirmed.length} field${out.confirmed.length === 1 ? '' : 's'}${v.group_status === 'applied' && v.patients_updated > 1 ? ` — ${v.patients_updated} patients on the plan updated` : v.group_status === 'review' ? ' — the plan change is waiting for review' : ''}`);
      onClose();
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  const discard = async () => {
    try { await api.post(`/verification/reads/${read.id}/discard`); toast('Set aside — nothing was applied'); onClose(); onDone(); } catch (e) { setErr(e); }
  };
  return (
    <div className="vf-read">
      <div className="vf-sub-head"><b>Check the AI’s read against the document</b><button type="button" className="link" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      <p className={`vf-note ${read.sandbox ? 'warn' : ''}`}>{read.reason}{/[.!]$/.test(read.reason || '') ? '' : '.'}{read.document_id ? ' The document is filed in the chart (Documents → Insurance).' : ''}</p>
      <table className="vf-table">
        <thead><tr><th /><th>Field</th><th>On file</th><th>Read from the document</th></tr></thead>
        <tbody>
          {fields.map(({ k, v, now }) => {
            const differs = JSON.stringify(now ?? null) !== JSON.stringify(v ?? null);
            return (
              <tr key={k} className={ticked.has(k) ? 'ticked' : ''}>
                <td><input type="checkbox" checked={ticked.has(k)} onChange={() => toggle(k)} aria-label={`Apply ${FIELD_LABELS[k] || k}`} /></td>
                <td>{FIELD_LABELS[k] || k}</td>
                <td className="muted">{now === undefined ? '—' : show(k, now)}</td>
                <td className={differs ? 'vf-diff' : ''}>
                  {editable(k)
                    ? <input className="vf-edit" inputMode="decimal" value={edits[k] ?? (MONEY.has(k) ? String(v / 100) : String(v))} onChange={(e) => { setEdits({ ...edits, [k]: e.target.value }); setTicked((t) => new Set(t).add(k)); }} aria-label={FIELD_LABELS[k] || k} />
                    : show(k, v)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button type="button" className="link" onClick={() => setTicked(new Set(fields.map((f) => f.k)))}>Tick all I checked</button>
        <button type="button" onClick={discard}>Set aside</button>
        <button type="button" className="primary" disabled={saving || !ticked.size} onClick={confirm}>Apply {ticked.size || ''} checked field{ticked.size === 1 ? '' : 's'}</button>
      </div>
    </div>
  );
}

// ---- What was verified before, and what it changed ----
function HistoryList({ detail, tz }) {
  const [open, setOpen] = useState(false);
  const items = detail.history || [];
  if (!items.length && !detail.checks?.length) return null;
  return (
    <div className="vf-history">
      <button type="button" className="link" onClick={() => setOpen(!open)}><History size={14} /> {open ? 'Hide history' : `History (${items.length} breakdown${items.length === 1 ? '' : 's'}, ${detail.checks.length} check${detail.checks.length === 1 ? '' : 's'})`}</button>
      {open && (
        <ol>
          {items.map((h) => (
            <li key={`v${h.id}`}>
              <div><b>{h.how}</b> · {fmtUtcDateTime(h.created_at, tz)} · {h.by_name || h.actor || 'Automatic'}{h.reference ? ` · ref ${h.reference}` : ''}{h.rep_name ? ` (${h.rep_name})` : ''} · for {h.for_patient}</div>
              {h.group_status === 'review' && <div className="vf-note warn">Waiting for review: {h.review_reasons?.join('; ')}</div>}
              {h.patients_updated > 0 && <div className="muted"><Users size={12} /> {h.patients_updated} patient{h.patients_updated === 1 ? '' : 's'} on the plan updated{h.reviewed_by_name ? ` (reviewed by ${h.reviewed_by_name})` : ''}</div>}
              {Object.entries(h.plan_changes || {}).map(([k, [from, to]]) => <div key={k} className="vf-change">{FIELD_LABELS[k] || k}: <s>{show(k, parseMaybe(from))}</s> → <b>{show(k, parseMaybe(to))}</b></div>)}
            </li>
          ))}
          {detail.checks.map((c) => <li key={`c${c.id}`} className="muted">Eligibility {c.status} · {c.method === 'phone' ? `phone (ref ${c.reference}, ${c.rep_name})` : c.method} · {fmtUtcDateTime(c.at, tz)} · {c.by}</li>)}
        </ol>
      )}
    </div>
  );
}
const parseMaybe = (v) => { if (typeof v !== 'string' || !/^[[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };

// ---- Plan changes waiting for a person (IV3) ----
function Reviews({ items, canWrite, onDone }) {
  const [picked, setPicked] = useState({});
  const decide = async (r, how) => {
    try {
      const out = await api.post(`/verification/reviews/${r.id}/${how}`, how === 'apply' ? { plan_ids: picked[r.id] || [] } : {});
      toast(how === 'apply' ? `Applied — ${out.patients_updated} patient${out.patients_updated === 1 ? '' : 's'} updated` : 'Kept what’s on file');
      onDone();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  return (
    <section className="vf-reviews card">
      <h2><Users size={16} /> Plan changes waiting for you <span className="vf-count">{items.length}</span></h2>
      <p className="muted">Verified for one patient, but the plan on file might not be theirs — so nobody else’s benefits were changed yet.</p>
      {items.map((r) => (
        <div key={r.id} className="vf-review">
          <div>
            <b>{r.patient_name}</b> · {r.carrier_name} group {r.plan_group || '—'}{r.plan_name ? ` (${r.plan_name})` : ''} · {r.how}{r.by ? ` by ${r.by}` : ''}
            <div className="vf-note warn">{r.review_reasons.join('; ')}</div>
            <div>{Object.entries(r.proposed).map(([k, [from, to]]) => <span key={k} className="vf-change">{FIELD_LABELS[k] || k}: <s>{show(k, parseMaybe(from))}</s> → <b>{show(k, parseMaybe(to))}</b></span>)}</div>
            {r.siblings.length > 0 && (
              <div className="vf-siblings">Also update: {r.siblings.map((sib) => (
                <label key={sib.id}><input type="checkbox" checked={(picked[r.id] || []).includes(sib.id)} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked ? [...(picked[r.id] || []), sib.id] : (picked[r.id] || []).filter((x) => x !== sib.id) })} /> {sib.name || 'Plan'} ({sib.members} patient{sib.members === 1 ? '' : 's'})</label>
              ))}</div>
            )}
          </div>
          {canWrite && (
            <div className="vf-review-actions">
              <button type="button" className="primary small" onClick={() => decide(r, 'apply')}><BadgeCheck size={14} /> Apply to {r.members} patient{r.members === 1 ? '' : 's'}</button>
              <button type="button" className="small" onClick={() => decide(r, 'keep')}>Keep what’s on file</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
