import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, toCents, fromCents } from '../format.js';
import { ChStatus, ClaimEdiCard, sendClaims } from '../components/ClaimEdi.jsx';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';

export default function ClaimDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data: c, reload, error: loadErr } = useApi(`/claims/${id}`);
  const [modal, setModal] = useState(null);
  const [checks, setChecks] = useState(0);
  const [err, setErr] = useState(null);
  const { data: ch } = useApi('/clearinghouse');
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  if (loadErr) return <div className="error">{loadErr.message}</div>;
  if (!c) return <div className="empty">Loading…</div>;
  const w = can('billing:write');
  const paidLines = c.items.some((i) => i.paid_amount || i.adjusted_amount);
  const sendElectronic = () => act(() => sendClaims([c.id], ch));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Claim #{c.id} <Badge value={c.status} /> <ChStatus claim={c} />{c.frequency_code === '7' ? <span className="badge info">Corrected claim</span> : c.frequency_code === '8' ? <span className="badge warn">Void notice</span> : null}</h1>
          <div className="muted"><Link to={`/patients/${c.patient_id}`}>{c.first_name} {c.last_name}</Link> · {c.carrier_name}</div>
        </div>
        <div className="actions no-print">
          <button onClick={() => window.print()}>Print</button>
          {w && ['draft', 'denied'].includes(c.status) && <button className="primary" onClick={sendElectronic}>{ch?.batch ? 'Send to clearinghouse' : 'Download 837'}</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button onClick={() => act(() => api.post(`/claims/${c.id}/submit`))}>{c.status === 'denied' ? 'Resubmitted on paper' : 'Mark sent on paper'}</button>}
          {w && ['submitted', 'partially_paid'].includes(c.status) && <button className="primary" onClick={() => setModal('pay')}>Enter EOB payment</button>}
          {w && c.status === 'submitted' && <button className="danger" onClick={() => setModal('deny')}>Denied</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button className="danger" onClick={() => confirm('Void this claim? Procedures become billable again.') && act(() => api.post(`/claims/${c.id}/void`))}>Void</button>}
          {w && ['submitted', 'denied'].includes(c.status) && (
            <>
              <button title="Send a replacement claim (frequency 7) — the payer's claim number is needed" onClick={() => {
                const ref = window.prompt("Corrected claim: a new claim replaces this one at the payer.\n\nPayer's claim number for the original:", c.payer_claim_number || '');
                if (ref?.trim()) act(async () => { const n = await api.post(`/claims/${c.id}/correct`, { original_reference: ref }); navigate(`/claims/${n.id}`); });
              }}>Corrected claim…</button>
              <button className="danger" title="Tell the payer to cancel this claim (frequency 8)" onClick={() => {
                const ref = window.prompt("Void at the payer: sends a cancellation for this claim.\n\nPayer's claim number for the original:", c.payer_claim_number || '');
                if (ref?.trim()) act(async () => { const n = await api.post(`/claims/${c.id}/correct`, { kind: 'void', original_reference: ref }); navigate(`/claims/${n.id}`); });
              }}>Void at payer…</button>
            </>
          )}
          {w && ['paid', 'partially_paid'].includes(c.status) && (
            <button onClick={() => {
              const reason = window.prompt('Reopen this claim? Its insurance payments and write-offs are reversed on the ledger and it goes back to waiting on the payer.\n\nReason:');
              if (reason?.trim()) act(() => api.post(`/claims/${c.id}/reopen`, { reason }));
            }}>Reopen claim</button>
          )}
        </div>
      </div>
      <ErrorBox error={err} />
      {c.denial_reason && <div className="error">Denial reason: {c.denial_reason}</div>}
      {c.payer_claim_number && <div className="muted" style={{ marginBottom: 8 }}>Payer claim # {c.payer_claim_number}</div>}
      {c.ch_status === 'rejected' && c.status === 'draft' && <div className="error">Rejected electronically: {c.ch_message}</div>}
      <ClaimChecks id={c.id} status={c.status} version={checks} />

      <div className="grid grid-2">
        <div className="card">
          <h2>Billing provider</h2>
          <dl className="kv">
            <dt>Practice</dt><dd>{c.practice.name}</dd>
            <dt>Address</dt><dd>{[c.practice.address, c.practice.city, c.practice.state, c.practice.zip].filter(Boolean).join(', ') || '—'}</dd>
            <dt>NPI / TIN</dt><dd>{c.practice.npi || '—'} / {c.practice.tax_id || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Subscriber</h2>
          <dl className="kv">
            <dt>Patient</dt><dd>{c.patient.first_name} {c.patient.last_name} (DOB {c.patient.dob || '—'})</dd>
            <dt>Carrier</dt><dd>{c.carrier_name} {c.payer_id ? `· Payer ID ${c.payer_id}` : ''}</dd>
            <dt>Member ID</dt><dd>{c.subscriber_id}</dd>
            <dt>Group</dt><dd>{c.group_number || '—'}</dd>
          </dl>
        </div>
      </div>

      <Attachments claim={c} onChange={() => { reload(); setChecks((n) => n + 1); }} />

      <div className="card">
        <h2>Services</h2>
        <table>
          <thead><tr><th>Date</th><th>Code</th><th>Description</th><th>Tooth</th><th>Surf</th><th>Provider (NPI)</th><th className="num">Fee</th><th className="num">Est. ins.</th>{paidLines && <><th className="num">Paid</th><th className="num">Write-off</th><th className="num">Patient</th></>}</tr></thead>
          <tbody>
            {c.items.map((i) => (
              <tr key={i.id}>
                <td>{fmtDate(i.completed_at)}</td><td>{i.code}</td><td>{i.description}</td><td>{i.tooth}</td><td>{i.surfaces}</td>
                <td>{i.provider_name} {i.provider_npi ? `(${i.provider_npi})` : ''}</td>
                <td className="num">{money(i.fee)}</td><td className="num">{money(i.estimated_amount)}</td>
                {paidLines && <><td className="num">{money(i.paid_amount)}</td><td className="num">{money(i.adjusted_amount)}</td><td className="num">{money(i.patient_resp)}</td></>}
              </tr>
            ))}
            <tr className="totals-row"><td colSpan={6}>Totals · paid {money(c.paid_amount)}</td><td className="num">{money(c.total_fee)}</td><td className="num">{money(c.estimated_amount)}</td>{paidLines && <td colSpan={3} />}</tr>
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8 }}>
          Created {fmtDate(c.created_at)}{c.submitted_at ? ` · Submitted ${fmtDate(c.submitted_at)}` : ''}{c.paid_at ? ` · Paid ${fmtDate(c.paid_at)}` : ''}
        </div>
      </div>

      <ClaimEdiCard claim={c} onChange={reload} />
      {modal === 'pay' && <Modal title="Enter insurance payment (EOB)" onClose={() => setModal(null)}><PaymentForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal === 'deny' && <Modal title="Record denial" onClose={() => setModal(null)}><DenyForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
    </>
  );
}

function PaymentForm({ claim, onDone }) {
  const remaining = Math.max(0, claim.estimated_amount - claim.paid_amount);
  const [form, setForm] = useState({ amount: fromCents(remaining), write_off: fromCents(claim.write_off_estimate || 0), reference: '', final: true });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/payment`, { amount: toCents(form.amount), write_off: toCents(form.write_off || 0), reference: form.reference, final: form.final });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Insurance paid ($)<input type="number" step="0.01" min="0" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>Contractual write-off ($)<input type="number" step="0.01" min="0" value={form.write_off} onChange={(e) => setForm({ ...form, write_off: e.target.value })} /></label>
        <label className="full">Check / EFT #<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
        <label className="checkbox full"><input type="checkbox" checked={form.final} onChange={(e) => setForm({ ...form, final: e.target.checked })} /> Final payment for this claim</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post payment</button></div>
    </form>
  );
}

function DenyForm({ claim, onDone }) {
  const [reason, setReason] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/deny`, { reason });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Reason<textarea required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="form-actions"><button className="primary danger" disabled={busy}>Record denial</button></div>
    </form>
  );
}

function ClaimChecks({ id, status, version }) {
  const { data } = useApi(['draft', 'denied'].includes(status) ? `/claims/${id}/validate?v=${version}` : null);
  if (!data) return null;
  const warn = data.warnings?.length ? (
    <div className="public-notice" style={{ marginBottom: 12 }}>
      <strong>Payers often deny these without attachments:</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.warnings.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  ) : null;
  if (!data.problems.length) return <>{warn}<div className="badge ok" style={{ marginBottom: 12 }}>✓ Ready to send electronically</div></>;
  return (
    <>
      {warn}
      <div className="error">
        <strong>Fix before sending electronically:</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    </>
  );
}

// X-rays, perio charts and narratives for the payer, each referenced from the claim by its control number.
function Attachments({ claim, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/claims/${claim.id}/attachments`);
  const { data: docs } = useApi(`/patients/${claim.patient_id}/documents`);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (fn) => { setErr(null); try { await fn(); reload(); onChange(); } catch (e) { setErr(e); } };
  if (!data) return null;
  const editable = can('billing:write') && !['paid', 'void'].includes(claim.status);
  const pending = data.attachments.filter((a) => ['pending', 'rejected'].includes(a.status));
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Attachments</h2>
        <div className="inline" style={{ gap: 6 }}>
          {editable && <button className="small" onClick={() => setForm({ report_type: 'RB', document_id: '', narrative: '', transmission: 'BM' })}>+ Attachment</button>}
          {editable && pending.length > 0 && <button className="small primary" onClick={() => run(() => api.post(`/claims/${claim.id}/attachments/send`))}>{data.electronic ? `Send ${pending.length} to the payer` : `Number ${pending.length} for mail/fax`}</button>}
          {!data.electronic && data.attachments.some((a) => a.control_number) && <button className="small" onClick={() => window.open(`/claims/${claim.id}/attachments/print`, '_blank')}>Print cover sheet</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      {data.attachments.length === 0 ? <div className="muted" style={{ marginTop: 6 }}>None. {data.mode === 'manual' ? 'Attachments are mailed or faxed with a printed cover sheet (no attachment service is connected).' : ''}</div> : (
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>What</th><th>File / narrative</th><th>Sent</th><th>Control number</th><th /></tr></thead>
          <tbody>
            {data.attachments.map((a) => (
              <tr key={a.id}>
                <td>{data.report_types[a.report_type]}</td>
                <td>{a.filename || <span style={{ whiteSpace: 'pre-wrap' }}>{a.narrative}</span>}</td>
                <td>{data.transmissions[a.transmission]}{a.error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{a.error}</div>}</td>
                <td>{a.control_number || <Badge value="pending" />}</td>
                <td>{editable && ['pending', 'rejected'].includes(a.status) && <button className="small" onClick={() => run(() => api.del(`/claim-attachments/${a.id}`))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && (
        <Modal title="Add an attachment" onClose={() => setForm(null)}>
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post(`/claims/${claim.id}/attachments`, { ...form, document_id: form.document_id ? Number(form.document_id) : null }); setForm(null); }); }}>
            <ErrorBox error={err} />
            <div className="form-grid">
              <label>Kind<select value={form.report_type} onChange={(e) => setForm({ ...form, report_type: e.target.value })}>{Object.entries(data.report_types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              {!data.electronic && <label>Sending it<select value={form.transmission} onChange={(e) => setForm({ ...form, transmission: e.target.value })}><option value="BM">By mail</option><option value="FX">By fax</option></select></label>}
              <label className="full">From the chart
                <select value={form.document_id} onChange={(e) => setForm({ ...form, document_id: e.target.value })}>
                  <option value="">— none (narrative only) —</option>
                  {(docs || []).map((d) => <option key={d.id} value={d.id}>{d.filename} · {d.category}{d.tooth ? ` #${d.tooth}` : ''} · {fmtDate(d.taken_at || d.created_at)}</option>)}
                </select>
              </label>
              <label className="full">Narrative{form.report_type === 'OZ' ? ' *' : ' (optional)'}<textarea rows={4} value={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.value })} placeholder="e.g. Tooth #30 has a fractured MB cusp under a large existing amalgam; a crown is needed to restore it." /></label>
            </div>
            <div className="form-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary">Add</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
