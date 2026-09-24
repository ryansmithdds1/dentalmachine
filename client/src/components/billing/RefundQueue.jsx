import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv, dollars } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, toCents, label } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import '../../pages/monthly.css';

// Billing → Credits & refunds (workflow 48, docs/workflows/specs/48-refunds.md): every account the office owes
// money to, largest first. J/K move, R (or Enter) opens the refund beside the list with the amount and the card
// it goes back to already filled in; Enter refunds. A refund sends money out, so it has no Undo: the panel's
// button (with the amount on it) is the one deliberate step.
export default function RefundQueue() {
  const { can } = useAuth();
  const { data, reload } = useApi('/billing/credit-balances');
  const [at, setAt] = useState(0);
  const [panel, setPanel] = useState(false);
  const rows = data || [];
  const cur = rows[Math.min(at, rows.length - 1)] || null;
  // Refunds need a manager (deposits:manage) or admin, like the server.
  const w = can('billing:write') && can('deposits:manage');
  const move = (d) => setAt((i) => Math.max(0, Math.min(rows.length - 1, i + d)));
  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next account', section: 'Credits & refunds' },
    { combo: 'k', handler: () => move(-1), label: 'Previous account', section: 'Credits & refunds' },
    { combo: 'r', handler: () => setPanel(true), label: 'Refund the selected credit', section: 'Credits & refunds', enabled: w && !!cur },
    { combo: 'enter', handler: () => setPanel(true), label: 'Refund the selected credit', section: 'Credits & refunds', enabled: w && !!cur && !panel },
    { combo: 'escape', handler: () => setPanel(false), label: 'Close the refund panel', section: 'Credits & refunds', enabled: panel, inInputs: true },
  ]);
  if (!data) return <div className="empty">Loading…</div>;
  const total = rows.reduce((t, r) => t + r.credit, 0);
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <div><strong>{rows.length}</strong> account{rows.length === 1 ? '' : 's'} in credit · <strong>{money(total)}</strong> the office owes patients</div>
        <div className="inline">
          <span className="muted" style={{ fontSize: 12 }}><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>R</kbd> refund</span>
          <button className="small" disabled={!rows.length} onClick={() => downloadCsv('credit-balances', rows, [['Patient', (r) => `${r.first_name} ${r.last_name}`], ['Phone', (r) => r.phone || ''], ['Last credit', (r) => r.last_credit || ''], ['Credit', (r) => dollars(r.credit)]])}>⬇ CSV</button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Patient</th><th>Last payment / credit</th><th>Refund goes to</th><th className="num">Credit</th><th className="no-print" /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.patient_id} aria-selected={r === cur} className={`wl-row${r === cur ? ' current' : ''}`} onClick={() => setAt(i)}>
                  <td><Link to={`/patients/${r.patient_id}?tab=ledger`}>{r.first_name} {r.last_name}</Link>{r.phone && <div className="muted">{r.phone}</div>}</td>
                  <td>{fmtDate(r.last_credit)}</td>
                  <td>{r.card_payment ? `The card used ${fmtDate(r.card_payment.entry_date)}` : 'Check or cash from the office'}</td>
                  <td className="num"><strong>{money(r.credit)}</strong></td>
                  <td className="no-print">{w && <button className="small" onClick={(e) => { e.stopPropagation(); setAt(i); setPanel(true); }}>Refund…</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">No credit balances — nobody is owed a refund.</div>}
        </div>
      </div>
      {panel && cur && <RefundPanel key={cur.patient_id} row={cur} onClose={() => setPanel(false)} onDone={(msg) => { toast(msg); setPanel(false); reload(); }} />}
    </>
  );
}

function RefundPanel({ row, onClose, onDone }) {
  const card = row.card_payment;
  const [form, setForm] = useState({ amount: ((card ? Math.min(card.left, row.credit) : row.credit) / 100).toFixed(2), to: card ? 'card' : 'check', reference: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = useRef(null);
  useEffect(() => { go.current?.focus(); }, []);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const amount = toCents(form.amount);
      const body = form.to === 'card' ? { amount, payment_id: card.id } : { amount, method: form.to, reference: form.reference || null };
      await api.post(`/patients/${row.patient_id}/refunds`, body);
      onDone(`Refunded ${money(amount)} to ${row.first_name} ${row.last_name}${form.to === 'card' ? ' (back to the card)' : ` by ${label(form.to)}`}`);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="drawer wl-drawer" role="dialog" aria-label={`Refund ${row.first_name} ${row.last_name}`}>
      <div className="drawer-head">
        <div>
          <strong>Refund {row.first_name} {row.last_name}</strong>
          <div className="muted" style={{ fontSize: 13 }}>{money(row.credit)} credit on the account</div>
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <form className="drawer-body" onSubmit={submit}>
        <ErrorBox error={err} />
        <label>Amount ($)<input type="number" step="0.01" min="0.01" max={(row.credit / 100).toFixed(2)} required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>
          Refund to
          <select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
            {card && <option value="card">The card used {fmtDate(card.entry_date)} ({money(card.left)} left to refund)</option>}
            {['check', 'cash', 'ach', 'other'].map((m) => <option key={m} value={m}>{label(m)} from the office</option>)}
          </select>
        </label>
        {form.to !== 'card' && <label>Check # / reference<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>}
        <p className="muted" style={{ fontSize: 12 }}>The refund is posted to the ledger and recorded with your name. It can’t be undone here — a mistake is corrected with a new entry.</p>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button ref={go} className="primary" disabled={busy}>{busy ? 'Refunding…' : `Refund ${money(toCents(form.amount || 0))}`}</button>
        </div>
      </form>
    </aside>
  );
}
