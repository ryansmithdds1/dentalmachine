import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate } from '../format.js';
import { Badge, ErrorBox } from '../components/ui.jsx';
import { PlanSummary } from '../components/patient/PaymentPlans.jsx';

const FILTERS = [['draft', 'Ready to send'], ['submitted', 'Submitted'], ['partially_paid', 'Partially paid'], ['denied', 'Denied'], ['paid', 'Paid'], ['void', 'Void'], ['', 'All']];

// Billing workspace: claims (with 837 batches), ERA remittance posting and payment plans.
export default function Claims() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'claims';
  return (
    <>
      <div className="page-header"><h1>Billing</h1></div>
      <div className="tabs">
        {[['claims', 'Claims'], ['era', 'Remittance (ERA)'], ['plans', 'Payment plans']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
        ))}
      </div>
      {tab === 'claims' && <ClaimList />}
      {tab === 'era' && <EraImport />}
      {tab === 'plans' && <Plans />}
    </>
  );
}

async function download(path, body, filename) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { details: err.details });
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: filename });
  a.click();
}

function ClaimList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('draft');
  const { data: claims, reload } = useApi(`/claims${status ? `?status=${status}` : ''}`);
  const [selected, setSelected] = useState([]);
  const [err, setErr] = useState(null);
  const totals = (claims || []).reduce((t, c) => ({ billed: t.billed + c.total_fee, est: t.est + c.estimated_amount, paid: t.paid + c.paid_amount }), { billed: 0, est: 0, paid: 0 });
  const sendable = (claims || []).filter((c) => ['draft', 'denied'].includes(c.status));

  const batch = async (ids) => {
    setErr(null);
    try {
      await download('/claims/837', { claim_ids: ids }, `claims-${new Date().toISOString().slice(0, 10)}.837`);
      setSelected([]);
      reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <div className="tabs" style={{ borderBottom: 'none', marginBottom: 8 }}>
        {FILTERS.map(([v, text]) => <button key={v} className={status === v ? 'active' : ''} onClick={() => { setStatus(v); setSelected([]); }}>{text}</button>)}
      </div>
      <ErrorBox error={err} />
      {can('billing:write') && sendable.length > 0 && (
        <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <span>{selected.length ? `${selected.length} selected` : `${sendable.length} claims ready`} · Creates an ANSI 837D batch for your clearinghouse and marks the claims submitted.</span>
          <span className="inline">
            <button onClick={() => setSelected(selected.length === sendable.length ? [] : sendable.map((c) => c.id))}>{selected.length === sendable.length ? 'Clear' : 'Select all'}</button>
            <button className="primary" disabled={!selected.length} onClick={() => batch(selected)}>Send {selected.length || ''} electronically (837)</button>
          </span>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th /><th>Claim</th><th>Patient</th><th>Carrier</th><th>Created</th><th>Submitted</th><th>Status</th><th className="num">Billed</th><th className="num">Estimated</th><th className="num">Paid</th></tr></thead>
            <tbody>
              {claims?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/claims/${c.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    {['draft', 'denied'].includes(c.status) && can('billing:write') && (
                      <input type="checkbox" style={{ width: 'auto' }} checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                    )}
                  </td>
                  <td>#{c.id}</td>
                  <td>{c.first_name} {c.last_name}</td>
                  <td>{c.carrier_name}</td>
                  <td>{fmtDate(c.created_at)}</td>
                  <td>{fmtDate(c.submitted_at)}</td>
                  <td><Badge value={c.status} /></td>
                  <td className="num">{money(c.total_fee)}</td>
                  <td className="num">{money(c.estimated_amount)}</td>
                  <td className="num">{money(c.paid_amount)}</td>
                </tr>
              ))}
              {claims?.length > 0 && (
                <tr className="totals-row"><td colSpan={7}>{claims.length} claims</td><td className="num">{money(totals.billed)}</td><td className="num">{money(totals.est)}</td><td className="num">{money(totals.paid)}</td></tr>
              )}
            </tbody>
          </table>
          {claims?.length === 0 && <div className="empty">No claims here. Create claims from a patient&apos;s Insurance tab.</div>}
        </div>
      </div>
    </>
  );
}

function EraImport() {
  const { can } = useAuth();
  const { data: imports, reload } = useApi('/era');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/era/import?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'text/plain' }, body: await file.text() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const rows = result?.claims;
  return (
    <>
      {can('billing:write') && (
        <div className="card">
          <h2>Import an ERA (835)</h2>
          <p className="muted">Download electronic remittance files from your clearinghouse and drop them here. Payments, contractual write-offs and denials are posted to the matching claims automatically.</p>
          <input type="file" accept=".835,.txt,.x12,.edi,.era" disabled={busy} onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
          <ErrorBox error={err} />
        </div>
      )}
      {result && (
        <div className="card">
          <h2>{result.payer_name} · {result.check_number} · {money(result.total_paid)}</h2>
          <EraTable rows={rows} />
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px' }}><h2 style={{ margin: 0 }}>Import history</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Imported</th><th>Payer</th><th>Check / EFT</th><th>Paid on</th><th className="num">Amount</th><th>Claims posted</th><th>Needs attention</th></tr></thead>
            <tbody>
              {imports?.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => setResult({ payer_name: e.payer_name, check_number: e.check_number, total_paid: e.total_paid, claims: e.details })}>
                  <td>{fmtDate(e.created_at)}</td><td>{e.payer_name}</td><td>{e.check_number}</td><td>{fmtDate(e.payment_date)}</td>
                  <td className="num">{money(e.total_paid)}</td><td>{e.claims_matched}</td><td>{e.claims_unmatched ? <span className="badge warn">{e.claims_unmatched}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {imports?.length === 0 && <div className="empty">No ERAs imported yet.</div>}
        </div>
      </div>
    </>
  );
}

function EraTable({ rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Claim</th><th>Result</th><th className="num">Billed</th><th className="num">Paid</th><th className="num">Write-off</th><th className="num">Patient owes</th><th>Reason codes</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.claim_id ? <Link to={`/claims/${r.claim_id}`}>#{r.claim_id}</Link> : r.control_number}</td>
              <td><span className={`badge ${r.result === 'posted' ? 'ok' : r.result === 'denied' ? 'danger' : 'warn'}`}>{r.result}</span></td>
              <td className="num">{money(r.billed)}</td><td className="num">{money(r.paid)}</td><td className="num">{money(r.write_off)}</td><td className="num">{money(r.patient_responsibility)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{r.reasons.map((x) => `${x.code}${x.text ? ` (${x.text})` : ''}`).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Plans() {
  const [filter, setFilter] = useState('active');
  const { data: plans } = useApi(filter === 'overdue' ? '/payment-plans?overdue=true' : `/payment-plans?status=${filter}`);
  return (
    <>
      <div className="tabs" style={{ borderBottom: 'none', marginBottom: 8 }}>
        {[['active', 'Active'], ['overdue', 'Past due'], ['completed', 'Completed'], ['all', 'All']].map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      {plans?.length === 0 && <div className="card empty">No payment plans.</div>}
      <div className="grid grid-2">
        {plans?.map((p) => (
          <div key={p.id} className="card">
            <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <Link to={`/patients/${p.patient_id}`}><strong>{p.first_name} {p.last_name}</strong></Link>
              <span className="muted">{p.phone}</span>
            </div>
            <PlanSummary plan={p} />
          </div>
        ))}
      </div>
    </>
  );
}
