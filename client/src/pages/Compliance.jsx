import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, openFile } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcut } from '../shortcuts.js';
import { fmtDate, fmtDateTime, label, practiceToday, shiftDate } from '../format.js';
import { AskButton, ErrorBox, PatientPicker, useSubmit } from '../components/ui.jsx';
import { toast } from '../toast.js';
import './compliance.css';

// Compliance log (README.md, “Compliance log”): patient complaints and office incidents, staff exposure (sharps)
// incidents, and the HIPAA accounting of disclosures. Everything is added inline (N), nothing is ever deleted:
// entries are resolved, closed or voided with a reason.
export default function Compliance() {
  const [params, setParams] = useSearchParams();
  const { data: access } = useApi('/compliance/access');
  const tabs = [['incidents', 'Complaints & incidents'], ...(access?.exposures ? [['exposures', 'Exposure log (OSHA)']] : []), ['disclosures', 'Disclosures (HIPAA)']];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : params.get('tab') === 'exposures' && !access ? null : 'incidents';
  // ?new=1 (the command bar's "Record a complaint…", "Log an exposure…") opens the form straight away.
  const [opening, setOpening] = useState(() => params.get('new') === '1');
  useEffect(() => {
    if (params.get('new') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const go = (k) => setParams({ tab: k });
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Compliance log</h1>
          <div className="muted">Complaints, incidents, staff exposures and disclosures of patient information — recorded once, kept for good.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([k, t]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => go(k)}>{t}</button>)}
      </div>
      {tab === 'incidents' && <Incidents open={opening} onOpened={() => setOpening(false)} manager={!!access?.manager} />}
      {tab === 'exposures' && <Exposures open={opening} onOpened={() => setOpening(false)} />}
      {tab === 'disclosures' && <Disclosures open={opening} onOpened={() => setOpening(false)} manager={!!access?.manager} patientParam={params.get('patient')} exportParam={params.get('export') === '1'} />}
    </>
  );
}

// The person who usually follows up: a manager (the first administrator), else me.
function useFollowUpDefault() {
  const users = useLookup('/users');
  const { user } = useAuth();
  const admins = users.filter((u) => u.active !== 0 && u.role === 'admin');
  return user?.role === 'admin' ? user.id : admins[0]?.id || user?.id;
}

function ActivePatientChip({ patientId, onClear, label: text = 'Patient' }) {
  const { data: p } = useApi(patientId ? `/patients/${patientId}/card` : null);
  if (!patientId) return null;
  return (
    <span className="cmp-chip">
      {text}: <strong>{p ? `${p.first_name} ${p.last_name}` : `#${patientId}`}</strong>
      <button type="button" className="link" onClick={onClear} aria-label={`Not about ${p ? p.first_name : 'this patient'}`}>×</button>
    </span>
  );
}

// ---------------- Complaints & incidents ----------------
function Incidents({ open, onOpened, manager }) {
  const [status, setStatus] = useState('open');
  const { data, reload } = useApi(`/incidents?status=${status}`);
  const [adding, setAdding] = useState(false);
  const [showReport, setShowReport] = useState(false);
  useEffect(() => { if (open) { setAdding(true); onOpened(); } }, [open, onOpened]);
  useShortcut('n', () => setAdding(true), { label: 'Record a complaint or incident', section: 'Compliance log', enabled: !adding });
  const rows = data?.rows || [];
  return (
    <>
      {adding && <IncidentForm onDone={(saved) => { setAdding(false); if (saved) { setStatus('open'); reload(); } }} />}
      <div className="cmp-bar">
        <div className="seg" role="group" aria-label="Show">
          {[['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']].map(([k, t]) => <button key={k} type="button" className={status === k ? 'active' : ''} aria-pressed={status === k} onClick={() => setStatus(k)}>{t}</button>)}
        </div>
        <div className="actions">
          {manager && <button type="button" onClick={() => setShowReport((s) => !s)}>{showReport ? 'Hide report' : 'Report'}</button>}
          {manager && <button type="button" onClick={() => download('/incidents/report?format=csv', 'complaints-incidents.csv')}>Download CSV</button>}
          {!adding && <button type="button" className="primary" onClick={() => setAdding(true)} title="N">New entry</button>}
        </div>
      </div>
      {showReport && <IncidentReport />}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="cmp-table">
            <thead><tr><th>When</th><th>What happened</th><th>Patient</th><th>Follow-up</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {rows.map((i) => <IncidentRow key={i.id} i={i} manager={manager} onChange={reload} />)}
            </tbody>
          </table>
          {data && !rows.length && <div className="empty">{status === 'open' ? 'Nothing open. Press N to record a complaint or incident.' : 'Nothing here.'}</div>}
        </div>
      </div>
      {!manager && <p className="muted" style={{ fontSize: 12 }}>You see what you reported or have to follow up. The office manager sees the whole log.</p>}
    </>
  );
}

function IncidentForm({ onDone }) {
  const { patientId } = useActivePatient();
  const users = useLookup('/users');
  const fallbackOwner = useFollowUpDefault();
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [f, setF] = useState({ kind: 'complaint', severity: 'low', summary: '', details: '', people: '', follow_up_user_id: '', follow_up_due: shiftDate(today, 7), occurred_at: '' });
  const [pid, setPid] = useState(patientId || null);
  const [earlier, setEarlier] = useState(false);
  const owner = f.follow_up_user_id || fallbackOwner || '';
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const saved = await api.post('/incidents', {
      ...f, occurred_at: earlier && f.occurred_at ? f.occurred_at : undefined, patient_id: pid, follow_up_user_id: owner ? Number(owner) : null, follow_up_due: f.follow_up_due || null,
    });
    toast(`Recorded. ${saved.follow_up_name ? `A follow-up task went to ${saved.follow_up_name}.` : ''}`);
    onDone(saved);
  });
  const keys = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } if (e.key === 'Escape') { e.preventDefault(); onDone(null); } };
  return (
    <section className="inline-panel" aria-label="New complaint or incident">
      <header><h3>New complaint or incident</h3><button type="button" className="small" onClick={() => onDone(null)}>Cancel</button></header>
      <ErrorBox error={error} />
      <form className="cmp-form" onKeyDown={keys} onSubmit={(e) => { e.preventDefault(); if (f.summary.trim()) submit(); }}>
        <label className="full">What happened
          <input autoFocus aria-label="What happened" value={f.summary} onChange={set('summary')} placeholder="e.g. Upset about waiting 40 minutes; bill was higher than the estimate" />
        </label>
        <div className="cmp-row">
          <div className="seg" role="group" aria-label="Kind">
            {[['complaint', 'Complaint'], ['incident', 'Incident']].map(([k, t]) => <button key={k} type="button" className={f.kind === k ? 'active' : ''} aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{t}</button>)}
          </div>
          <label className="inline-label">How serious
            <select value={f.severity} onChange={set('severity')}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
          </label>
          {pid ? <ActivePatientChip patientId={pid} onClear={() => setPid(null)} /> : <span className="cmp-picker"><PatientPicker value={null} onChange={(p) => setPid(p?.id || null)} /></span>}
          {earlier
            ? <label className="inline-label">When<input type="datetime-local" value={f.occurred_at} onChange={set('occurred_at')} /></label>
            : <button type="button" className="link" onClick={() => setEarlier(true)}>Just now · earlier?</button>}
        </div>
        <div className="form-grid">
          <label>Who was involved<input value={f.people} onChange={set('people')} placeholder="optional" /></label>
          <label>Follow-up by
            <select value={owner} onChange={set('follow_up_user_id')}>
              <option value="">Nobody (no task)</option>
              {users.filter((u) => u.active !== 0).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label>Due<input type="date" value={f.follow_up_due} onChange={set('follow_up_due')} /></label>
        </div>
        <label className="full">Details<textarea rows={2} value={f.details} onChange={set('details')} placeholder="optional: what was said, what was done on the spot" /></label>
        <div className="form-actions">
          <span className="hint">Enter saves · the follow-up goes on {users.find((u) => String(u.id) === String(owner))?.name || 'nobody'}’s to-do list</span>
          <button className="primary" disabled={busy || !f.summary.trim()}>Save</button>
        </div>
      </form>
    </section>
  );
}

function IncidentRow({ i, manager, onChange }) {
  const act = async (path, body) => { await api.post(`/incidents/${i.id}/${path}`, body); onChange(); };
  return (
    <tr className={i.status === 'voided' ? 'cmp-voided' : ''}>
      <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(i.occurred_at)}</td>
      <td>
        <span className={`badge ${i.severity === 'high' ? 'danger' : i.severity === 'medium' ? 'warn' : ''}`}>{label(i.kind)} · {i.severity}</span> <strong>{i.summary}</strong>
        {i.people && <div className="muted" style={{ fontSize: 12 }}>Involved: {i.people}</div>}
        {i.details && <div className="muted" style={{ fontSize: 12 }}>{i.details}</div>}
        {i.resolution && <div style={{ fontSize: 12 }}>✓ {i.resolution} <span className="muted">— {i.resolved_by_name}, {fmtDate(String(i.resolved_at).slice(0, 10))}</span></div>}
        {i.void_reason && <div className="muted" style={{ fontSize: 12 }}>Voided: {i.void_reason}</div>}
        <div className="muted" style={{ fontSize: 11 }}>Reported by {i.reported_by_name}</div>
      </td>
      <td>{i.patient_id ? <Link to={`/patients/${i.patient_id}`}>{i.first_name} {i.last_name}</Link> : <span className="muted">—</span>}</td>
      <td>{i.follow_up_name || <span className="muted">—</span>}{i.follow_up_due && <div className="muted" style={{ fontSize: 12 }}>due {fmtDate(i.follow_up_due)}</div>}</td>
      <td><span className={`badge ${i.status === 'open' ? 'info' : i.status === 'resolved' ? 'ok' : ''}`}>{i.status}</span></td>
      <td className="cmp-actions">
        {i.status === 'open' && <AskButton label="How was it resolved?" required submit="Resolve" className="small primary" onSubmit={(v) => act('resolve', { resolution: v })}>Resolve</AskButton>}
        {i.status === 'resolved' && manager && <button type="button" className="small" onClick={() => act('reopen', {})}>Reopen</button>}
        {i.status !== 'voided' && manager && <AskButton label="Why void it?" required submit="Void" danger onSubmit={(v) => act('void', { reason: v })}>Void</AskButton>}
      </td>
    </tr>
  );
}

function IncidentReport() {
  const { data } = useApi('/incidents/report');
  if (!data) return <div className="card muted">Loading…</div>;
  const line = (o) => Object.entries(o).map(([k, n]) => `${label(k)} ${n}`).join(' · ') || '—';
  return (
    <div className="card cmp-report" aria-label="Complaint and incident report">
      <h3 style={{ marginTop: 0 }}>Last 12 months · {data.total} entr{data.total === 1 ? 'y' : 'ies'}</h3>
      <div className="grid grid-4">
        <div><div className="muted">By kind</div>{line(data.by_kind)}</div>
        <div><div className="muted">By severity</div>{line(data.by_severity)}</div>
        <div><div className="muted">Status</div>{line(data.by_status)}</div>
        <div><div className="muted">Days to resolve (average)</div>{data.avg_days_to_resolve ?? '—'}{data.overdue ? <div className="text-danger">{data.overdue} follow-up{data.overdue === 1 ? '' : 's'} overdue</div> : null}</div>
      </div>
    </div>
  );
}

// ---------------- Staff exposure incidents (OSHA) ----------------
function Exposures({ open, onOpened }) {
  const [showAll, setShowAll] = useState(false);
  const { data: rows, reload } = useApi(`/exposures${showAll ? '?status=all' : ''}`);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (open) { setAdding(true); onOpened(); } }, [open, onOpened]);
  useShortcut('n', () => setAdding(true), { label: 'Log an exposure or sharps injury', section: 'Compliance log', enabled: !adding });
  return (
    <>
      <div className="public-notice" style={{ marginBottom: 12 }}>Confidential employee medical records: only people with the exposure-log permission see this tab. The sharps injury log export leaves names out.</div>
      {adding && <ExposureForm onDone={(saved) => { setAdding(false); if (saved) reload(); }} />}
      <div className="cmp-bar">
        <label className="inline-label"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show voided</label>
        <div className="actions">
          <button type="button" onClick={() => download('/exposures/export.csv', 'sharps-injury-log.csv')}>Sharps injury log (CSV)</button>
          {!adding && <button type="button" className="primary" onClick={() => setAdding(true)} title="N">Log an exposure</button>}
        </div>
      </div>
      {rows?.map((x) => <ExposureCard key={x.id} x={x} onChange={reload} />)}
      {rows && !rows.length && <div className="card empty">No exposures logged. Press N to log one.</div>}
    </>
  );
}

function ExposureForm({ onDone }) {
  const users = useLookup('/users');
  const { patientId } = useActivePatient();
  const [f, setF] = useState({ employee: '', exposure_type: 'sharps', device: '', procedure_name: '', body_part: '', work_area: '', description: '', immediate_actions: '', occurred_at: '' });
  const [source, setSource] = useState(patientId || null);
  const [unknown, setUnknown] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const staff = users.filter((u) => u.active !== 0);
  // The team member typed (their name, or the start of it when only one fits); anyone else is kept by name.
  const typed = f.employee.trim().toLowerCase();
  const starts = typed ? staff.filter((u) => u.name.toLowerCase().startsWith(typed)) : [];
  const match = staff.find((u) => u.name.toLowerCase() === typed) || (starts.length === 1 ? starts[0] : null);
  const { submit, busy, error } = useSubmit(async () => {
    const saved = await api.post('/exposures', {
      employee_user_id: match?.id ?? null, employee_name: match ? null : f.employee, exposure_type: f.exposure_type, device: f.device, procedure_name: f.procedure_name,
      body_part: f.body_part, work_area: f.work_area, description: f.description, immediate_actions: f.immediate_actions, source_patient_id: unknown ? null : source,
      source_unknown: unknown, occurred_at: earlier && f.occurred_at ? f.occurred_at : undefined,
    });
    toast('Logged. Work through the follow-up checklist below.');
    onDone(saved);
  });
  const ready = f.employee.trim() && f.description.trim();
  return (
    <section className="inline-panel" aria-label="Log an exposure">
      <header><h3>Log an exposure or sharps injury</h3><button type="button" className="small" onClick={() => onDone(null)}>Cancel</button></header>
      <ErrorBox error={error} />
      <form className="cmp-form" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(null); } }} onSubmit={(e) => { e.preventDefault(); if (ready) submit(); }}>
        <div className="form-grid">
          <label>Who was exposed
            <input autoFocus aria-label="Who was exposed" list="cmp-staff" value={f.employee} onChange={set('employee')} placeholder="Start typing a name" />
            <datalist id="cmp-staff">{staff.map((u) => <option key={u.id} value={u.name} />)}</datalist>
          </label>
          <label>How it happened<input value={f.description} onChange={set('description')} placeholder="e.g. Recapping the syringe after a block" /></label>
          <label>Type
            <select value={f.exposure_type} onChange={set('exposure_type')}><option value="sharps">Needlestick / sharps</option><option value="splash">Splash (eyes, mouth, skin)</option><option value="bite">Bite</option><option value="other">Other</option></select>
          </label>
        </div>
        <label className="full">Device (type and brand — for the sharps injury log)<input value={f.device} onChange={set('device')} placeholder="e.g. 27g needle, Septodont" /></label>
        <details className="cmp-more">
          <summary>More details (procedure, body part, source patient, first aid)</summary>
          <div className="form-grid">
            <label>Procedure<input value={f.procedure_name} onChange={set('procedure_name')} /></label>
            <label>Body part<input value={f.body_part} onChange={set('body_part')} /></label>
            <label>Work area<input value={f.work_area} onChange={set('work_area')} placeholder="e.g. Op 2, sterilization" /></label>
            <label>First aid given<input value={f.immediate_actions} onChange={set('immediate_actions')} placeholder="e.g. washed with soap and water" /></label>
          </div>
          <div className="cmp-row">
            {!unknown && (source ? <ActivePatientChip patientId={source} label="Source patient" onClear={() => setSource(null)} /> : <span className="cmp-picker"><PatientPicker value={null} onChange={(p) => setSource(p?.id || null)} /></span>)}
            <label className="inline-label"><input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> Source unknown</label>
            {earlier ? <label className="inline-label">When<input type="datetime-local" value={f.occurred_at} onChange={set('occurred_at')} /></label> : <button type="button" className="link" onClick={() => setEarlier(true)}>Just now · earlier?</button>}
          </div>
        </details>
        <div className="form-actions">
          <span className="hint">Enter saves. Send the employee for medical evaluation right away — ideally within 2 hours.</span>
          <button className="primary" disabled={busy || !ready}>Save</button>
        </div>
      </form>
    </section>
  );
}

function ExposureCard({ x, onChange }) {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [err, setErr] = useState(null);
  const run = async (fn) => { setErr(null); try { await fn(); onChange(); } catch (e) { setErr(e); } };
  const tick = (key) => run(() => api.put(`/exposures/${x.id}`, { followup: { [key]: x.followup[key] ? null : today } }));
  const done = x.steps.filter((s) => x.followup[s.key]).length;
  return (
    <div className={`card cmp-exposure${x.status === 'voided' ? ' cmp-voided' : ''}`}>
      <div className="cmp-exposure-head">
        <div>
          <strong>{x.employee_name}</strong> · {label(x.exposure_type)} · {fmtDateTime(x.occurred_at)}
          <div>{x.description}</div>
          <div className="muted" style={{ fontSize: 12 }}>{[x.device && `Device: ${x.device}`, x.procedure_name, x.body_part, x.work_area].filter(Boolean).join(' · ')}</div>
          <div className="muted" style={{ fontSize: 12 }}>Source: {x.source_patient_id ? <Link to={`/patients/${x.source_patient_id}`}>{x.source_first_name} {x.source_last_name}</Link> : x.source_unknown ? 'unknown' : 'not recorded'}{x.immediate_actions ? ` · First aid: ${x.immediate_actions}` : ''}</div>
          {x.void_reason && <div className="muted" style={{ fontSize: 12 }}>Voided: {x.void_reason}</div>}
        </div>
        <div className="cmp-actions">
          <span className={`badge ${x.status === 'open' ? 'info' : x.status === 'closed' ? 'ok' : ''}`}>{x.status}</span>
          <span className="muted" style={{ fontSize: 12 }}>{done}/{x.steps.length} follow-up steps</span>
          {x.status === 'open' && <button type="button" className="small" onClick={() => run(() => api.post(`/exposures/${x.id}/close`))}>Close</button>}
          {x.status !== 'voided' && <AskButton label="Why void it?" required submit="Void" danger onSubmit={(v) => api.post(`/exposures/${x.id}/void`, { reason: v }).then(onChange)}>Void</AskButton>}
        </div>
      </div>
      <ErrorBox error={err} />
      {x.status !== 'voided' && (
        <ul className="cmp-steps" aria-label="Post-exposure follow-up">
          {x.steps.map((s) => (
            <li key={s.key}>
              <label className="inline-label">
                <input type="checkbox" checked={!!x.followup[s.key]} disabled={x.status !== 'open'} onChange={() => tick(s.key)} /> {s.label}
                {x.followup[s.key] && <span className="muted"> — {fmtDate(x.followup[s.key])}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- Disclosures (HIPAA accounting) ----------------
function Disclosures({ open, onOpened, manager, patientParam, exportParam }) {
  const { patientId } = useActivePatient();
  const [pid, setPid] = useState(Number(patientParam) || patientId || null);
  useEffect(() => { if (patientParam) setPid(Number(patientParam)); }, [patientParam]);
  const { data: list, reload } = useApi(pid ? `/patients/${pid}/disclosures` : null);
  const { data: all } = useApi(!pid && manager ? '/disclosures' : null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (open) { setAdding(true); onOpened(); } }, [open, onOpened]);
  useShortcut('n', () => pid && setAdding(true), { label: 'Record a disclosure', section: 'Compliance log', enabled: !adding && !!pid });
  const [err, setErr] = useState(null);
  const report = async (format) => {
    setErr(null);
    try {
      if (format === 'csv') await download(`/patients/${pid}/disclosures/accounting?format=csv`, 'accounting-of-disclosures.csv');
      else await openFile(`/patients/${pid}/disclosures/accounting`);
    } catch (e) { setErr(e); }
  };
  return (
    <>
      <div className="cmp-bar">
        <div className="cmp-row">
          {pid ? <ActivePatientChip patientId={pid} onClear={() => { setPid(null); setAdding(false); }} /> : <span className="cmp-picker"><PatientPicker value={null} onChange={(p) => setPid(p?.id || null)} /></span>}
        </div>
        <div className="actions">
          {pid && manager && <button type="button" onClick={() => report('pdf')} title="What the patient gets when they ask: six years of disclosures">Patient’s accounting (PDF)</button>}
          {pid && manager && <button type="button" onClick={() => report('csv')}>CSV</button>}
          {pid && !adding && <button type="button" className="primary" onClick={() => setAdding(true)} title="N">Record a disclosure</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Record information given out for anything other than treatment, payment or running the office — a subpoena, a court order, the dental board, public health, law enforcement, or anything sent by mistake. Patients can ask for a list of these going back six years.</p>
      {adding && pid && <DisclosureForm patientId={pid} exportRecord={exportParam} onDone={(saved) => { setAdding(false); if (saved) reload(); }} />}
      {pid && (
        <div className="card" style={{ padding: 0 }}>
          <DisclosureTable rows={list || []} manager={manager} onChange={reload} />
          {list && !list.length && <div className="empty">No disclosures recorded for this patient.</div>}
        </div>
      )}
      {!pid && manager && all && (
        <div className="card" style={{ padding: 0 }}>
          <h3 style={{ padding: '12px 16px 0' }}>Everyone, last 12 months</h3>
          <DisclosureTable rows={all.rows} manager={manager} onChange={() => {}} withPatient />
          {!all.rows.length && <div className="empty">No disclosures in the last 12 months.</div>}
        </div>
      )}
      {!pid && !manager && <div className="card empty">Choose the patient.</div>}
    </>
  );
}

function DisclosureTable({ rows, manager, onChange, withPatient }) {
  return (
    <div className="table-wrap">
      <table className="cmp-table">
        <thead><tr><th>Date</th>{withPatient && <th>Patient</th>}<th>Given to</th><th>What</th><th>Why</th><th>Recorded by</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className={d.status === 'voided' ? 'cmp-voided' : ''}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(d.disclosed_on)}</td>
              {withPatient && <td><Link to={`/compliance?tab=disclosures&patient=${d.patient_id}`}>{d.first_name} {d.last_name}</Link></td>}
              <td>{d.recipient}{d.recipient_address && <div className="muted" style={{ fontSize: 12 }}>{d.recipient_address}</div>}</td>
              <td>{d.description}</td>
              <td>{PURPOSE_SHORT[d.purpose] || label(d.purpose)}{d.purpose_detail && <div className="muted" style={{ fontSize: 12 }}>{d.purpose_detail}</div>}</td>
              <td>{d.recorded_by_name}{d.source === 'record_export' && <div className="muted" style={{ fontSize: 11 }}>recorded by the record export</div>}{d.void_reason && <div className="muted" style={{ fontSize: 11 }}>Voided: {d.void_reason}</div>}</td>
              <td>{manager && d.status === 'active' && !withPatient && <AskButton label="Why void it?" required submit="Void" danger onSubmit={(v) => api.post(`/disclosures/${d.id}/void`, { reason: v }).then(onChange)}>Void</AskButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const PURPOSE_SHORT = { required_by_law: 'Required by law', public_health: 'Public health', abuse_report: 'Abuse report', health_oversight: 'Health oversight', judicial: 'Court / legal', law_enforcement: 'Law enforcement', coroner: 'Coroner', research: 'Research', threat: 'Serious threat', workers_comp: 'Workers’ comp', unauthorized: 'Sent in error', other: 'Other' };

const LAST_PURPOSE = 'dm_last_disclosure_purpose';
function DisclosureForm({ patientId, exportRecord, onDone }) {
  const purposes = useLookup('/disclosures/purposes');
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const remembered = useMemo(() => { try { return localStorage.getItem(LAST_PURPOSE) || 'required_by_law'; } catch { return 'required_by_law'; } }, []);
  const [f, setF] = useState({ recipient: '', recipient_address: '', purpose: remembered, purpose_detail: '', description: '', disclosed_on: today });
  const [withRecord, setWithRecord] = useState(!!exportRecord);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const first = useRef(null);
  const { submit, busy, error } = useSubmit(async () => {
    try { localStorage.setItem(LAST_PURPOSE, f.purpose); } catch { /* storage unavailable */ }
    if (withRecord) {
      // The record export itself records the disclosure (README.md, “Compliance log”), so it can't be forgotten.
      const q = new URLSearchParams({ recipient: f.recipient, recipient_address: f.recipient_address, purpose: f.purpose, purpose_detail: f.purpose_detail, description: f.description || 'Copy of the health record (summary, chart data, images and documents)' });
      await download(`/patients/${patientId}/record-export?${q}`, `health-record-${patientId}.zip`);
      toast('Record downloaded and the disclosure recorded.');
      return onDone(true);
    }
    await api.post(`/patients/${patientId}/disclosures`, f);
    toast('Disclosure recorded.');
    onDone(true);
  });
  const ready = f.recipient.trim() && (withRecord || f.description.trim()) && (f.purpose !== 'other' || f.purpose_detail.trim());
  return (
    <section className="inline-panel" aria-label="Record a disclosure">
      <header><h3>Record a disclosure</h3><button type="button" className="small" onClick={() => onDone(false)}>Cancel</button></header>
      <ErrorBox error={error} />
      <form className="cmp-form" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(false); } }} onSubmit={(e) => { e.preventDefault(); if (ready) submit(); }}>
        <div className="form-grid">
          <label>Given to<input ref={first} autoFocus aria-label="Given to" value={f.recipient} onChange={set('recipient')} placeholder="e.g. Travis County District Court" /></label>
          <label>What was given<input value={f.description} onChange={set('description')} placeholder={withRecord ? 'The whole record (summary, data, images)' : 'e.g. x-rays and notes 2024–2026'} /></label>
          <label>Why
            <select value={f.purpose} onChange={set('purpose')}>{purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
          </label>
          <label>Date<input type="date" value={f.disclosed_on} max={today} onChange={set('disclosed_on')} /></label>
          <label>Their address (if known)<input value={f.recipient_address} onChange={set('recipient_address')} /></label>
          <label>Details (case #, request){f.purpose === 'other' ? ' — required' : ''}<input value={f.purpose_detail} onChange={set('purpose_detail')} /></label>
        </div>
        <label className="inline-label"><input type="checkbox" checked={withRecord} onChange={(e) => setWithRecord(e.target.checked)} /> Download a copy of their record to send now</label>
        <div className="form-actions">
          <span className="hint">Enter saves</span>
          <button className="primary" disabled={busy || !ready}>{withRecord ? 'Record & download' : 'Save'}</button>
        </div>
      </form>
    </section>
  );
}
