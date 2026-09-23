import { Fragment, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtDateTime, toCents } from '../format.js';
import { Badge, ErrorBox, Modal } from '../components/ui.jsx';
import { PlanSummary } from '../components/patient/PaymentPlans.jsx';
import { ChStatus, ClearinghousePanel, sendClaims, describeResponses } from '../components/ClaimEdi.jsx';
import InsurancePlanForm from '../components/InsurancePlanForm.jsx';
import { useLookup } from '../hooks.js';
import { downloadCsv, dollars } from '../api.js';
import Collections from '../components/Collections.jsx';

const FILTERS = [['draft', 'Ready to send'], ['submitted', 'Submitted'], ['partially_paid', 'Partially paid'], ['denied', 'Denied'], ['paid', 'Paid'], ['void', 'Void'], ['', 'All']];

// Billing workspace: claims (with 837 batches), ERA remittance posting and payment plans.
export default function Claims() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'claims';
  return (
    <>
      <div className="page-header"><h1>Billing</h1></div>
      <div className="tabs">
        {[['claims', 'Claims'], ['checks', 'Insurance payments'], ['followup', 'Insurance follow-up'], ['preauths', 'Pre-authorizations'], ['era', 'Remittance (ERA)'], ['insplans', 'Insurance plans'], ['statements', 'Statements'], ['plans', 'Payment plans'], ['collections', 'Collections']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
        ))}
      </div>
      {tab === 'claims' && <ClaimList />}
      {tab === 'era' && <EraImport />}
      {tab === 'plans' && <Plans />}
      {tab === 'insplans' && <InsurancePlans />}
      {tab === 'checks' && <InsuranceChecks />}
      {tab === 'followup' && <InsuranceFollowup />}
      {tab === 'preauths' && <Preauths />}
      {tab === 'statements' && <Statements />}
      {tab === 'collections' && <Collections />}
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
  const [notice, setNotice] = useState(null);
  const [sent, setSent] = useState(0);
  const { data: ch } = useApi('/clearinghouse');
  const totals = (claims || []).reduce((t, c) => ({ billed: t.billed + c.total_fee, est: t.est + c.estimated_amount, paid: t.paid + c.paid_amount }), { billed: 0, est: 0, paid: 0 });
  const sendable = (claims || []).filter((c) => ['draft', 'denied'].includes(c.status));

  const batch = async (ids) => {
    setErr(null);
    setNotice(null);
    try {
      const r = await sendClaims(ids, ch);
      setNotice(r ? `Sent ${r.claims} claim${r.claims === 1 ? '' : 's'} to ${ch.name}.${describeResponses(r)}` : `Downloaded an 837 file with ${ids.length} claim${ids.length === 1 ? '' : 's'} — upload it in your clearinghouse portal.`);
      setSelected([]);
      setSent((n) => n + 1);
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
      <ClearinghousePanel onChange={reload} version={sent} />
      <ErrorBox error={err} />
      {notice && <div className="public-notice ok" style={{ marginBottom: 12 }}>{notice}</div>}
      {can('billing:write') && sendable.length > 0 && (
        <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <span>{selected.length ? `${selected.length} selected` : `${sendable.length} claim${sendable.length === 1 ? '' : 's'} ready`} · {ch?.batch ? `Sends an 837D batch straight to ${ch.name}.` : 'Creates an 837D file to upload in your clearinghouse portal.'}</span>
          <span className="inline">
            <button onClick={() => setSelected(selected.length === sendable.length ? [] : sendable.map((c) => c.id))}>{selected.length === sendable.length ? 'Clear' : 'Select all'}</button>
            <button className="primary" disabled={!selected.length} onClick={() => batch(selected)}>{ch?.batch ? `Send ${selected.length || ''} to clearinghouse` : `Download ${selected.length || ''} as 837`}</button>
          </span>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th /><th>Claim</th><th>Patient</th><th>Carrier</th><th>Created</th><th>Submitted</th><th>Status</th><th>Electronic</th><th className="num">Billed</th><th className="num">Estimated</th><th className="num">Paid</th></tr></thead>
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
                  <td><ChStatus claim={c} /></td>
                  <td className="num">{money(c.total_fee)}</td>
                  <td className="num">{money(c.estimated_amount)}</td>
                  <td className="num">{money(c.paid_amount)}</td>
                </tr>
              ))}
              {claims?.length > 0 && (
                <tr className="totals-row"><td colSpan={8}>{claims.length} claim{claims.length === 1 ? '' : 's'}</td><td className="num">{money(totals.billed)}</td><td className="num">{money(totals.est)}</td><td className="num">{money(totals.paid)}</td></tr>
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
            {p.autopay_method_id ? <div className="muted" style={{ fontSize: 12 }}>{p.autopay_paused ? '⏸ Autopay paused' : '↻ Autopay on'}{p.autopay_message ? ` · ${p.autopay_message}` : ''}</div> : null}
          </div>
        ))}
      </div>
    </>
  );
}

function InsuranceFollowup() {
  const { data } = useApi('/reports/outstanding-claims');
  if (!data) return <div className="empty">Loading…</div>;
  const B = [['d0_30', '0–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', '90+ days']];
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {B.map(([k, l]) => <div key={k} className={`card stat${k === 'd90_plus' && data.totals[k] ? ' stat-danger' : k === 'd61_90' && data.totals[k] ? ' stat-warn' : ''}`}><div className="label">{l}</div><div className="value">{money(data.totals[k])}</div><div className="sub">expected from insurance</div></div>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="inline no-print" style={{ justifyContent: 'flex-end', padding: '10px 16px 0' }}>
          <button className="small" disabled={!data.rows.length} onClick={() => downloadCsv('outstanding-claims', data.rows, [['Claim #', (c) => c.id], ['Patient', (c) => `${c.first_name} ${c.last_name}`], ['Carrier', (c) => c.carrier_name], ['Carrier phone', (c) => c.carrier_phone || ''], ['Submitted', (c) => c.submitted_at || ''], ['Days out', (c) => c.days_out], ['Expected', (c) => dollars(c.estimated_amount - c.paid_amount)], ['Status', (c) => c.status]])}>⬇ CSV</button>
          <button className="small" onClick={() => window.print()}>Print / PDF</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Claim</th><th>Patient</th><th>Carrier</th><th>Submitted</th><th className="num">Days out</th><th className="num">Expected</th><th>Status</th></tr></thead>
            <tbody>
              {data.rows.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/claims/${c.id}`}>#{c.id}</Link></td>
                  <td><Link to={`/patients/${c.patient_id}`}>{c.first_name} {c.last_name}</Link></td>
                  <td>{c.carrier_name}{c.carrier_phone ? <div className="muted"><a href={`tel:${c.carrier_phone}`}>{c.carrier_phone}</a></div> : null}</td>
                  <td>{fmtDate(c.submitted_at)}</td>
                  <td className="num" style={{ color: c.days_out > 60 ? 'var(--danger)' : c.days_out > 30 ? 'var(--warn)' : undefined, fontWeight: c.days_out > 30 ? 700 : 400 }}>{c.days_out}</td>
                  <td className="num">{money(c.estimated_amount - c.paid_amount)}</td>
                  <td><Badge value={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && <div className="empty">No outstanding claims. 🎉</div>}
        </div>
      </div>
    </>
  );
}

function Preauths() {
  const { can } = useAuth();
  const { data: rows, reload } = useApi('/preauths');
  const [edit, setEdit] = useState(null);
  const exportFile = async (pa) => {
    await download(`/preauths/${pa.id}/837`, {}, `predetermination-${pa.id}.837`);
    reload();
  };
  return (
    <>
      <p className="muted">Create pre-authorizations from a patient&apos;s treatment plan. Send them electronically as an 837D predetermination, then record the payer&apos;s answer here.</p>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Patient</th><th>Carrier</th><th>Procedures</th><th className="num">Fee</th><th className="num">Estimated</th><th className="num">Approved</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows?.map((pa) => (
                <tr key={pa.id}>
                  <td>{pa.id}</td>
                  <td><Link to={`/patients/${pa.patient_id}`}>{pa.first_name} {pa.last_name}</Link><div className="muted">{fmtDate(pa.created_at)}</div></td>
                  <td>{pa.carrier_name}</td>
                  <td style={{ maxWidth: 240 }}>{pa.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')}</td>
                  <td className="num">{money(pa.total_fee)}</td>
                  <td className="num">{money(pa.estimated_amount)}</td>
                  <td className="num">{pa.approved_amount != null ? money(pa.approved_amount) : '—'}</td>
                  <td><span className={`badge ${pa.status === 'approved' ? 'ok' : pa.status === 'denied' ? 'danger' : pa.status === 'submitted' ? 'warn' : 'info'}`}>{pa.status}</span>{pa.payer_reference && <div className="muted" style={{ fontSize: 11 }}>{pa.payer_reference}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('billing:write') && pa.status === 'draft' && <button className="small primary" onClick={() => exportFile(pa)}>Send (837)</button>}{' '}
                    {can('billing:write') && ['draft', 'submitted'].includes(pa.status) && <button className="small" onClick={() => setEdit(pa)}>Record answer</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows?.length === 0 && <div className="empty">No pre-authorizations yet.</div>}
        </div>
      </div>
      {edit && (
        <Modal title={`Pre-authorization #${edit.id}`} onClose={() => setEdit(null)}>
          <PreauthAnswer pa={edit} onDone={() => { setEdit(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

function PreauthAnswer({ pa, onDone }) {
  const [form, setForm] = useState({ status: 'approved', approved_amount: (pa.estimated_amount / 100).toFixed(2), payer_reference: '', notes: '' });
  const [err, setErr] = useState(null);
  const save = async () => {
    try {
      await api.put(`/preauths/${pa.id}`, { ...form, approved_amount: form.status === 'approved' ? toCents(form.approved_amount) : null });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div>
      <ErrorBox error={err} />
      <div className="form-grid">
        <label>Answer<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="approved">Approved</option><option value="denied">Denied</option><option value="submitted">Still waiting</option></select></label>
        {form.status === 'approved' && <label>Approved amount ($)<input type="number" step="0.01" value={form.approved_amount} onChange={(e) => setForm({ ...form, approved_amount: e.target.value })} /></label>}
        <label>Payer reference #<input value={form.payer_reference} onChange={(e) => setForm({ ...form, payer_reference: e.target.value })} /></label>
        <label className="full">Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      <div className="form-actions"><button className="primary" onClick={save}>Save</button></div>
    </div>
  );
}

function Statements() {
  const { can } = useAuth();
  const [min, setMin] = useState('5');
  const [since, setSince] = useState(25);
  const { data: rows, reload } = useApi(`/statements/candidates?min_balance=${toCents(min || 0)}&since_days=${since}`);
  const { data: runs, reload: reloadRuns } = useApi('/statements/runs');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const { data: payCfg } = useApi('/payments/config');
  const mailOn = payCfg?.mail?.enabled;
  const run = async () => {
    setErr(null);
    try {
      const r = await api.post('/statements/run', { min_balance: toCents(min || 0), since_days: since });
      setResult(r);
      reload();
      reloadRuns();
    } catch (e) {
      setErr(e);
    }
  };
  const total = (rows || []).reduce((s, r) => s + r.patient_portion, 0);
  return (
    <>
      <div className="card inline" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <label>Minimum balance ($)<input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 120 }} /></label>
        <label>Skip accounts statemented in the last<select value={since} onChange={(e) => setSince(Number(e.target.value))} style={{ width: 140 }}><option value={0}>— none —</option><option value={14}>14 days</option><option value={25}>25 days</option><option value={45}>45 days</option></select></label>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div><strong>{rows?.length ?? 0}</strong> accounts · <strong>{money(total)}</strong> patient portion</div>
          <div className="muted" style={{ fontSize: 12 }}>{mailOn ? `Accounts without email are printed and mailed by ${payCfg.mail.name}.` : 'Accounts without email are printed here.'}</div>
          {can('billing:write') && <button className="primary" style={{ marginTop: 6 }} disabled={!rows?.length} onClick={run}>Send statements</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      {result && (
        <div className="public-notice ok" style={{ marginBottom: 12 }}>
          {result.accounts} statement{result.accounts === 1 ? '' : 's'}: {result.emailed} emailed{result.mailed ? `, ${result.mailed} mailed by ${result.mail}` : ''}, {result.printed} to print.{' '}
          {result.print_ids.length > 0 && <>Print: {result.print_ids.map((id) => <Link key={id} to={`/patients/${id}/statement?family=1`} style={{ marginRight: 8 }}>#{id}</Link>)}</>}
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Guarantor</th><th>Delivery</th><th>Last statement</th><th className="num">Balance</th><th className="num">Pending ins.</th><th className="num">Patient owes</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/patients/${r.id}`}>{r.first_name} {r.last_name}</Link><div className="muted">{[r.address, r.city, r.state].filter(Boolean).join(', ') || 'no address'}</div></td>
                  <td>{r.email && r.email_opt_in ? 'Email' : mailOn && r.address && r.zip ? <span className="badge info nocap">Mailed for you</span> : <span className="badge warn nocap">Print & mail</span>}</td>
                  <td>{r.statement_sent_at ? fmtDate(r.statement_sent_at) : 'Never'}</td>
                  <td className="num">{money(r.balance)}</td><td className="num">{money(r.pending_insurance)}</td><td className="num"><strong>{money(r.patient_portion)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows?.length === 0 && <div className="empty">No accounts need a statement.</div>}
        </div>
      </div>
      {runs?.length > 0 && (
        <div className="card">
          <h3>Recent statement runs</h3>
          {runs.map((r) => <div key={r.id} className="muted" style={{ padding: '3px 0' }}>{fmtDateTime(r.created_at)} · {r.accounts} accounts · {r.emailed} emailed · {r.printed} printed · {money(r.total)} · {r.created_by_name}</div>)}
        </div>
      )}
    </>
  );
}

// Employer group plans: the benefits every patient enrolled in them shares.
function InsurancePlans() {
  const { can } = useAuth();
  const { data: plans, reload } = useApi('/insurance-plans');
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const shown = (plans || []).filter((p) => !q || `${p.carrier_name} ${p.name || ''} ${p.group_number || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <input placeholder="Search carrier, employer or group #" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        {can('billing:write') && <button className="primary" onClick={() => setEditing({})}>+ New plan</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Carrier</th><th>Employer / plan</th><th>Group #</th><th className="num">Patients</th><th className="num">Annual max</th><th className="num">Deductible</th><th>Coverage (P/B/M)</th><th>Limits</th><th /></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td>{p.carrier_name}</td>
                  <td>{p.name || <span className="muted">—</span>}</td>
                  <td>{p.group_number || '—'}</td>
                  <td className="num">{p.members}</td>
                  <td className="num">{money(p.annual_max)}</td>
                  <td className="num">{money(p.deductible)}{p.family_deductible ? <div className="muted" style={{ fontSize: 11 }}>family {money(p.family_deductible)}</div> : null}</td>
                  <td>{p.pct_preventive}/{p.pct_basic}/{p.pct_major}%</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {p.frequencies.length} frequency limits{p.wait_major_months ? ` · ${p.wait_major_months}-mo major wait` : ''}{p.downgrade_composites ? ' · composites downgraded' : ''}{p.ortho_max ? ` · ortho ${money(p.ortho_max)}` : ''}
                  </td>
                  <td>{can('billing:write') && <button className="small" onClick={() => setEditing(p)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plans?.length === 0 && <div className="empty">No plans yet — they're created when you add a patient's insurance.</div>}
        </div>
      </div>
      {editing && (
        <Modal title={editing.id ? `${editing.carrier_name}${editing.name ? ` · ${editing.name}` : ''}` : 'New insurance plan'} wide onClose={() => setEditing(null)}>
          <InsurancePlanForm plan={editing.id ? editing : null} onDone={() => { setEditing(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

// Insurance checks and EFTs: post one payment across the claims it covers (paper EOBs), or review ERAs.
function InsuranceChecks() {
  const { can } = useAuth();
  const { data: checks, reload } = useApi('/insurance-checks');
  const [posting, setPosting] = useState(false);
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="muted">Every insurance check and EFT, and the claims it paid. ERAs are recorded here automatically.</div>
        {can('billing:write') && <button className="primary" onClick={() => setPosting(true)}>Post an insurance check</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Payer</th><th>Check / EFT #</th><th>How</th><th className="num">Claims</th><th className="num">Amount</th><th>Provider adjustments</th><th>By</th></tr></thead>
            <tbody>
              {checks?.map((k) => (
                <tr key={k.id}>
                  <td>{fmtDate(k.check_date)}</td>
                  <td>{k.carrier_name || k.payer_name || '—'}</td>
                  <td>{k.check_number || '—'}</td>
                  <td>{k.era_import_id ? 'ERA' : k.method === 'eft' ? 'EFT' : 'Paper check'}</td>
                  <td className="num">{k.claims}</td>
                  <td className="num"><strong>{money(k.amount)}</strong></td>
                  <td className="muted" style={{ fontSize: 12 }}>{k.provider_adjustments.map((a) => `${a.reason}${a.reference ? ` ${a.reference}` : ''}: ${money(a.amount)}`).join(', ') || '—'}</td>
                  <td className="muted">{k.created_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {checks?.length === 0 && <div className="empty">No insurance payments yet.</div>}
        </div>
      </div>
      {posting && <Modal title="Post an insurance check" wide onClose={() => setPosting(false)}><CheckForm onDone={() => { setPosting(false); reload(); }} /></Modal>}
    </>
  );
}

function CheckForm({ onDone }) {
  const carriers = useLookup('/carriers');
  const [head, setHead] = useState({ carrier_id: '', check_number: '', check_date: new Date().toLocaleDateString('en-CA'), amount: '', method: 'check' });
  const { data: open } = useApi(head.carrier_id ? `/insurance-checks/open-claims?carrier_id=${head.carrier_id}` : null);
  const [rows, setRows] = useState({});
  const [lineMode, setLineMode] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const row = (id) => rows[id] || { paid: '', write_off: '', final: true, lines: {} };
  const setRow = (id, patch) => setRows({ ...rows, [id]: { ...row(id), ...patch } });
  const chosen = (open || []).filter((c) => row(c.id).paid !== '' || row(c.id).write_off !== '');
  const total = chosen.reduce((s, c) => s + toCents(row(c.id).paid || 0), 0);
  const diff = toCents(head.amount || 0) - total;
  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/insurance-checks', {
        ...head, carrier_id: Number(head.carrier_id), amount: toCents(head.amount || 0),
        claims: chosen.map((c) => {
          const r = row(c.id);
          const lines = lineMode[c.id] ? c.items.map((i) => ({ claim_item_id: i.id, paid: toCents(r.lines[i.id]?.paid || 0), write_off: toCents(r.lines[i.id]?.write_off || 0) })) : null;
          return { claim_id: c.id, paid: toCents(r.paid || 0), write_off: toCents(r.write_off || 0), final: r.final, ...(lines ? { lines } : {}) };
        }),
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  // Line-by-line entry keeps the claim totals in step.
  const setLine = (c, itemId, k, v) => {
    const r = row(c.id);
    const lines = { ...r.lines, [itemId]: { ...(r.lines[itemId] || {}), [k]: v } };
    const sum = (key) => (Object.values(lines).reduce((s, l) => s + toCents(l[key] || 0), 0) / 100).toFixed(2);
    setRow(c.id, { lines, paid: sum('paid'), write_off: sum('write_off') });
  };
  return (
    <div>
      <ErrorBox error={err} />
      <div className="form-grid">
        <label>Carrier<select value={head.carrier_id} onChange={(e) => { setHead({ ...head, carrier_id: e.target.value }); setRows({}); }}><option value="">Select…</option>{carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Check / EFT #<input value={head.check_number} onChange={(e) => setHead({ ...head, check_number: e.target.value })} /></label>
        <label>Date<input type="date" value={head.check_date} onChange={(e) => setHead({ ...head, check_date: e.target.value })} /></label>
        <label>Check amount ($)<input type="number" step="0.01" value={head.amount} onChange={(e) => setHead({ ...head, amount: e.target.value })} /></label>
        <label>How<select value={head.method} onChange={(e) => setHead({ ...head, method: e.target.value })}><option value="check">Paper check</option><option value="eft">EFT</option></select></label>
      </div>
      {head.carrier_id && (
        <table className="compact-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Claim</th><th>Patient</th><th className="num">Billed</th><th className="num">Expected</th><th>Paid ($)</th><th>Write-off ($)</th><th>Final</th><th /></tr></thead>
          <tbody>
            {open?.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td>#{c.id}</td>
                  <td>{c.first_name} {c.last_name}</td>
                  <td className="num">{money(c.total_fee)}</td>
                  <td className="num">{money(c.estimated_amount - c.paid_amount)}</td>
                  <td><input type="number" step="0.01" style={{ width: 100 }} value={row(c.id).paid} readOnly={!!lineMode[c.id]} onChange={(e) => setRow(c.id, { paid: e.target.value })} /></td>
                  <td><input type="number" step="0.01" style={{ width: 100 }} value={row(c.id).write_off} readOnly={!!lineMode[c.id]} onChange={(e) => setRow(c.id, { write_off: e.target.value })} /></td>
                  <td><input type="checkbox" checked={row(c.id).final} onChange={(e) => setRow(c.id, { final: e.target.checked })} /></td>
                  <td><button type="button" className="small" onClick={() => setLineMode({ ...lineMode, [c.id]: !lineMode[c.id] })}>{lineMode[c.id] ? 'Claim total' : 'By line'}</button></td>
                </tr>
                {lineMode[c.id] && c.items.map((i) => (
                  <tr key={`${c.id}-${i.id}`} className="muted">
                    <td />
                    <td colSpan={2}>{i.code} {i.tooth ? `#${i.tooth}` : ''} · {money(i.fee)}</td>
                    <td className="num">{money(i.estimated_amount)}</td>
                    <td><input type="number" step="0.01" style={{ width: 100 }} value={row(c.id).lines[i.id]?.paid || ''} onChange={(e) => setLine(c, i.id, 'paid', e.target.value)} /></td>
                    <td><input type="number" step="0.01" style={{ width: 100 }} value={row(c.id).lines[i.id]?.write_off || ''} onChange={(e) => setLine(c, i.id, 'write_off', e.target.value)} /></td>
                    <td colSpan={2} />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {open?.length === 0 && <div className="muted" style={{ marginTop: 10 }}>No open claims for this carrier.</div>}
      <div className="form-actions" style={{ justifyContent: 'space-between' }}>
        <span className={diff === 0 ? 'badge ok' : 'badge warn'}>{chosen.length} claim{chosen.length === 1 ? '' : 's'} · {money(total)} posted · {diff === 0 ? 'balanced' : `${money(Math.abs(diff))} ${diff > 0 ? 'left to post' : 'over the check'}`}</span>
        <button className="primary" disabled={busy || !chosen.length || diff !== 0} onClick={submit}>Post check</button>
      </div>
    </div>
  );
}
