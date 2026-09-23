import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, label, practiceToday, toCents, fromCents } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from './ui.jsx';

// Billing → Deposits: build the bank deposit from undeposited payments, print the slip, reconcile with the bank.
export default function Deposits() {
  const { practice, can } = useAuth();
  const [methods, setMethods] = useState('cash,check');
  const { data: waiting, reload: reloadWaiting } = useApi(`/deposits/undeposited?methods=${methods}`);
  const { data: deposits, reload } = useApi('/deposits');
  const [picked, setPicked] = useState(null);
  const [form, setForm] = useState({ deposit_date: practiceToday(practice?.timezone), reference: '' });
  const [recon, setRecon] = useState(null);
  const chosen = picked ?? new Set((waiting || []).map((e) => e.id));
  const total = (waiting || []).filter((e) => chosen.has(e.id)).reduce((s, e) => s + e.amount, 0);
  const make = useSubmit(async () => {
    const d = await api.post('/deposits', { ...form, entry_ids: [...chosen] });
    setPicked(null);
    reloadWaiting(); reload();
    window.open(`/deposits/${d.id}/slip`, '_blank');
  });
  const w = can('billing:write');
  const toggle = (id) => { const s = new Set(chosen); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s); };
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Not yet deposited</h2>
          <select value={methods} onChange={(e) => { setMethods(e.target.value); setPicked(null); }}>
            <option value="cash,check">Cash and checks</option>
            <option value="check">Checks</option>
            <option value="cash">Cash</option>
            <option value="credit_card,debit_card">Card batches</option>
            <option value="ach,care_credit,other">ACH and other</option>
          </select>
        </div>
        <ErrorBox error={make.error} />
        <table className="compact-table">
          <thead><tr><th /><th>Date</th><th>From</th><th>Method</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {waiting?.map((e) => (
              <tr key={e.id}>
                <td><input type="checkbox" checked={chosen.has(e.id)} onChange={() => toggle(e.id)} aria-label="Include" /></td>
                <td>{fmtDate(e.entry_date)}</td>
                <td>{e.type === 'insurance_payment' ? e.description : `${e.first_name} ${e.last_name}`}</td>
                <td>{label(e.method || 'check')}{e.reference ? ` #${e.reference}` : ''}</td>
                <td className="num">{money(e.amount)}</td>
              </tr>
            ))}
            {waiting?.length === 0 && <tr><td colSpan={5} className="muted">Everything has been deposited.</td></tr>}
          </tbody>
        </table>
        {w && waiting?.length > 0 && (
          <div className="inline" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            <input type="date" value={form.deposit_date} onChange={(e) => setForm({ ...form, deposit_date: e.target.value })} />
            <input placeholder="Slip or bank reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} style={{ width: 180 }} />
            <button className="primary" disabled={make.busy || !chosen.size} onClick={make.submit}>Make deposit of {money(total)}</button>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Deposits</h2>
        <table className="compact-table">
          <thead><tr><th>Date</th><th>Reference</th><th className="num">Total</th><th>Bank</th><th /></tr></thead>
          <tbody>
            {deposits?.map((d) => (
              <tr key={d.id}>
                <td>{fmtDate(d.deposit_date)}<div className="muted" style={{ fontSize: 11 }}>{d.items} items</div></td>
                <td>{d.reference || '—'}</td>
                <td className="num">{money(d.total)}</td>
                <td>{d.status === 'open' ? <span className="muted">Not reconciled</span> : <><Badge value={d.status} />{d.status === 'discrepancy' && <div className="error-text" style={{ fontSize: 12 }}>Bank {money(d.bank_amount)} ({money(d.bank_amount - d.total)})</div>}</>}</td>
                <td>
                  <div className="inline" style={{ gap: 6 }}>
                    <a href={`/deposits/${d.id}/slip`} target="_blank" rel="noreferrer">Slip</a>
                    {w && d.status !== 'reconciled' && <button className="small" onClick={() => setRecon(d)}>Reconcile</button>}
                  </div>
                </td>
              </tr>
            ))}
            {deposits?.length === 0 && <tr><td colSpan={5} className="muted">No deposits yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {recon && <Reconcile d={recon} onClose={() => setRecon(null)} onDone={() => { setRecon(null); reload(); reloadWaiting(); }} />}
    </div>
  );
}

function Reconcile({ d, onClose, onDone }) {
  const [f, setF] = useState({ bank_amount: fromCents(d.total), bank_date: '' });
  const save = useSubmit(async () => { await api.post(`/deposits/${d.id}/reconcile`, { bank_amount: toCents(f.bank_amount), bank_date: f.bank_date || null }); onDone(); });
  const undo = useSubmit(async () => { await api.del(`/deposits/${d.id}`); onDone(); });
  return (
    <Modal title={`Reconcile deposit of ${money(d.total)}`} onClose={onClose}>
      <ErrorBox error={save.error || undo.error} />
      <p className="muted" style={{ fontSize: 13 }}>Enter the deposit as it appears on the bank statement. A different amount is flagged so it can be tracked down.</p>
      <div className="form-grid">
        <label>Amount on the statement ($)<input type="number" step="0.01" value={f.bank_amount} onChange={(e) => setF({ ...f, bank_amount: e.target.value })} /></label>
        <label>Date on the statement<input type="date" value={f.bank_date} onChange={(e) => setF({ ...f, bank_date: e.target.value })} /></label>
      </div>
      <div className="form-actions">
        <button className="danger" disabled={undo.busy} onClick={() => window.confirm('Undo this deposit? Its payments go back to the not-deposited list.') && undo.submit()}>Undo deposit</button>
        <button className="primary" disabled={save.busy} onClick={save.submit}>Save</button>
      </div>
    </Modal>
  );
}
