import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtTime, fmtUtcDateTime, practiceToday, shiftDate } from '../format.js';
import { Badge, ErrorBox } from './ui.jsx';

const every = (f) => (f.months ? (f.months % 12 === 0 ? `${f.months / 12} yr` : `${f.months} mo`) : 'benefit year');

// Billing → Eligibility: a day's patients (tomorrow by default) and their insurance check, all at once.
export default function EligibilityBatch() {
  const { practice, can } = useAuth();
  const [date, setDate] = useState(() => shiftDate(practiceToday(practice?.timezone), 1));
  const { data, reload } = useApi(`/eligibility/batch?date=${date}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(null);
  const run = async (fn) => {
    setErr(null); setBusy(true);
    try { await fn(); reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const insured = data?.rows.filter((r) => r.policy_id) || [];
  const problems = insured.filter((r) => ['inactive', 'error'].includes(r.status)).length;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Insurance checks for the day</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {data?.automatic ? 'Tomorrow’s patients are checked each evening automatically; check again here any time.' : 'Connect a real-time clearinghouse (Settings → Integrations) to check everyone at once; until then check each patient from their Insurance tab.'}
          </div>
        </div>
        <div className="inline">
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          {data?.automatic && can('billing:read') && (
            <button className="primary" disabled={busy || !insured.length} onClick={() => run(async () => setResult(await api.post('/eligibility/batch', { date, max_age_days: 7 })))}>
              {busy ? 'Checking…' : 'Check everyone'}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={err} />
      {result && <div className="public-notice ok" style={{ marginTop: 8 }}>Checked {result.checked}; {result.skipped} already checked this week{result.failed.length ? `; ${result.failed.length} couldn’t be checked (${result.failed[0].error})` : ''}.</div>}
      {data && (
        <p className="muted" style={{ fontSize: 13 }}>{data.rows.length} visits on {fmtDate(date)} · {insured.length} with insurance{problems ? ` · ${problems} need attention` : ''}</p>
      )}
      <table className="compact-table">
        <thead><tr><th>Time</th><th>Patient</th><th>Insurance</th><th>Status</th><th>Checked</th><th /></tr></thead>
        <tbody>
          {data?.rows.map((r) => (
            <FragmentRow key={r.appointment_id} r={r} open={open === r.appointment_id} onToggle={() => setOpen(open === r.appointment_id ? null : r.appointment_id)}
              onCheck={() => run(() => api.post(`/insurance/${r.policy_id}/eligibility`))} onApply={() => run(() => api.post(`/eligibility/${r.check_id}/apply`))} busy={busy} tz={practice?.timezone} />
          ))}
          {data?.rows.length === 0 && <tr><td colSpan={6} className="muted">No visits that day.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ r, open, onToggle, onCheck, onApply, busy, tz }) {
  const s = r.summary;
  return (
    <>
      <tr>
        <td>{fmtTime(r.start_time)}</td>
        <td><Link to={`/patients/${r.patient_id}?tab=insurance`}>{r.first_name} {r.last_name}</Link></td>
        <td>{r.carrier_name || <span className="muted">None on file</span>}{r.subscriber_id && <div className="muted" style={{ fontSize: 11 }}>{r.subscriber_id}</div>}</td>
        <td>{r.policy_id ? (r.status ? <Badge value={r.status} /> : <span className="muted">Not checked</span>) : '—'}</td>
        <td>{r.checked_at ? fmtUtcDateTime(r.checked_at, tz) : '—'}</td>
        <td>
          <div className="inline" style={{ gap: 6 }}>
            {r.policy_id && <button className="small" disabled={busy} onClick={onCheck}>Check</button>}
            {s && <button className="small" onClick={onToggle}>{open ? 'Hide' : 'Details'}</button>}
          </div>
        </td>
      </tr>
      {open && s && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--bg)' }}>
            <div className="grid grid-2">
              <div>
                <div><strong>{s.plan_name || 'Plan'}</strong>{s.sandbox ? ' (sandbox)' : ''}</div>
                <div>Annual max {s.annual_max != null ? money(s.annual_max) : '—'}{s.max_remaining != null ? ` · ${money(s.max_remaining)} left` : ''}</div>
                <div>Deductible {s.deductible != null ? money(s.deductible) : '—'}{s.deductible_remaining != null ? ` · ${money(s.deductible_remaining)} left` : ''}</div>
                {s.coinsurance && <div>Covers {Object.entries(s.coinsurance).map(([k, v]) => `${k} ${v}%`).join(' · ')}</div>}
                {s.errors?.length > 0 && <div className="error-text">Payer error {s.errors.map((e) => e.code).join(', ')}</div>}
              </div>
              <div>
                {s.frequencies?.length > 0 && <div><strong>Limits</strong> {s.frequencies.map((f) => `${f.codes.join('/')}: ${f.count} per ${every(f)}`).join(' · ')}</div>}
                {s.history?.length > 0 && <div><strong>Last done (payer)</strong> {s.history.map((x) => `${x.codes.join('/')} ${fmtDate(x.date)}`).join(' · ')}</div>}
                <button className="small" style={{ marginTop: 6 }} disabled={busy} onClick={onApply} title="Copy the max, deductible, percentages and limits onto the patient's plan">Apply to plan</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
