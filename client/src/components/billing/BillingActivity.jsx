import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtUtcDate } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import SetUpPayments from './SetUpPayments.jsx';

// The account's billing story (BL3: "every step visible on the patient's account"): charges tried, declines and
// retries, links sent, agreements, fees (waivable by a manager, with a reason), disputes and refunds — plus the
// "Set up payments" panel and adding an office fee. For the patient's ledger / account page.
export default function BillingActivity({ patientId }) {
  const { can, practice } = useAuth();
  const { data, error, reload } = useApi(`/patients/${patientId}/billing-activity`);
  const fees = useApi(`/patients/${patientId}/fee-charges`);
  const defs = useApi('/billing/fees');
  const [setup, setSetup] = useState(false);
  const [waive, setWaive] = useState(null);
  const [reason, setReason] = useState('');
  const [feeId, setFeeId] = useState('');
  const refresh = () => { reload(); fees.reload(); };
  const doWaive = useSubmit(async () => { await api.post(`/billing/fee-charges/${waive.id}/waive`, { reason }); toast('Fee waived'); setWaive(null); setReason(''); refresh(); });
  const addFee = useSubmit(async () => {
    const pre = await api.get(`/billing/fees/${feeId}/preview?patient_id=${patientId}`);
    await api.post(`/billing/fees/${feeId}/apply`, { patient_id: patientId });
    toast(`${pre.fee.name} of ${money(pre.amount)} added`);
    setFeeId('');
    refresh();
  });
  // Until the server has the billing autopilot routes, stay out of the way.
  if (error?.status === 404 && !data) return null;
  const offered = (defs.data?.fees || []).filter((f) => f.active && (f.applies === 'offered' || f.occasion === 'manual') && f.occasion !== 'plan_setup');
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Automatic payments &amp; fees</h3>
        {can('billing:write') && (
          <div className="inline" style={{ gap: 6 }}>
            <button onClick={() => setSetup(true)}>Set up payments</button>
            {offered.length > 0 && (
              <>
                <select aria-label="Add a fee" value={feeId} onChange={(e) => setFeeId(e.target.value)}>
                  <option value="">Add a fee…</option>
                  {offered.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <button onClick={() => addFee.submit()} disabled={!feeId || addFee.busy}>Add</button>
              </>
            )}
          </div>
        )}
      </div>
      <ErrorBox error={error || fees.error || doWaive.error || addFee.error} />
      {(fees.data || []).filter((c) => c.status === 'posted').length > 0 && (
        <table>
          <thead><tr><th>Fee</th><th>Amount</th><th>Date</th><th /></tr></thead>
          <tbody>
            {fees.data.filter((c) => c.status === 'posted').map((c) => (
              <tr key={c.id}><td>{c.name}</td><td>{money(c.amount)}</td><td>{fmtUtcDate(c.created_at, practice?.timezone)}</td>
                <td>{c.waivable && can('billing:write') && <button className="small" onClick={() => setWaive(c)}>Waive</button>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {waive && (
        <form className="inline" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); doWaive.submit(); }}>
          <input autoFocus aria-label="Why waive it" placeholder={`Why waive the ${money(waive.amount)} ${waive.name}? (needs a manager)`} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
          <button type="submit" disabled={!reason.trim() || doWaive.busy}>Waive</button>
          <button type="button" onClick={() => setWaive(null)}>Cancel</button>
        </form>
      )}
      <ul className="muted" style={{ marginTop: 8 }}>
        {(data?.events || []).slice(0, 30).map((e, i) => <li key={i}>{fmtDate(e.at)} — {e.text}</li>)}
        {data && !data.events.length && <li>Nothing yet.</li>}
      </ul>
      {setup && <SetUpPayments patientId={patientId} onClose={() => setSetup(false)} onDone={() => { setSetup(false); refresh(); }} />}
    </div>
  );
}
