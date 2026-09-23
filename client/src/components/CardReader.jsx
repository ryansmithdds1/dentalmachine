import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { money, toCents } from '../format.js';
import { ErrorBox } from './ui.jsx';

// Card-present payments on a Stripe Terminal reader at the front desk.
const LAST_READER = 'dm.cardReader';
const remembered = () => { try { return localStorage.getItem(LAST_READER) || ''; } catch { return ''; } };
const remember = (id) => { try { localStorage.setItem(LAST_READER, String(id)); } catch { /* private window */ } };

export function useReaders() {
  const { data } = useApi('/terminal/readers');
  return data?.enabled ? data : { enabled: false, readers: [], test_mode: false };
}

export function ReaderPay({ patient, amount: initial, readers, testMode, onDone }) {
  const [readerId, setReaderId] = useState(() => (readers.some((r) => String(r.id) === remembered()) ? remembered() : String(readers[0]?.id || '')));
  const [amount, setAmount] = useState(initial > 0 ? (initial / 100).toFixed(2) : '');
  const [receipt, setReceipt] = useState(patient.email && patient.email_opt_in ? 'email' : '');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  // While the reader waits for the card, check every 1.5 seconds.
  useEffect(() => {
    if (payment?.status !== 'pending') return undefined;
    timer.current = setTimeout(() => api.get(`/terminal-payments/${payment.id}`).then(setPayment).catch(setError), 1500);
    return () => clearTimeout(timer.current);
  }, [payment]);
  useEffect(() => { if (payment?.status === 'succeeded') onDone?.(payment, false); }, [payment?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const start = () => run(async () => {
    remember(readerId);
    setPayment(await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: Number(readerId), amount: toCents(amount), receipt: receipt || null }));
  });
  const reader = readers.find((r) => String(r.id) === readerId);

  if (payment) {
    const s = payment.status;
    return (
      <div className="reader-pay">
        <ErrorBox error={error} />
        <div className={`reader-status ${s}`}>
          <div className="reader-amount">{money(payment.amount)}</div>
          {s === 'pending' && <><div className="spinner" aria-hidden /> <div>Waiting for the card on <strong>{reader?.label || 'the reader'}</strong> — tap, insert or swipe.</div></>}
          {s === 'succeeded' && <div>✓ Approved{payment.card_last4 ? ` · ${payment.card_brand ? payment.card_brand[0].toUpperCase() + payment.card_brand.slice(1) : 'Card'} •••• ${payment.card_last4}` : ''}. Posted to the ledger{receipt ? ` and a receipt was ${receipt === 'sms' ? 'texted' : 'emailed'}` : ''}.</div>}
          {s === 'failed' && <div>Not approved: {payment.error || 'the reader could not take the payment'}.</div>}
          {s === 'canceled' && <div>Canceled — nothing was charged.</div>}
        </div>
        <div className="form-actions">
          {s === 'pending' && testMode && <button disabled={busy} onClick={() => run(async () => setPayment(await api.post(`/terminal-payments/${payment.id}/simulate`)))}>Simulate a tap (test mode)</button>}
          {s === 'pending' && <button disabled={busy} onClick={() => run(async () => setPayment(await api.post(`/terminal-payments/${payment.id}/cancel`)))}>Cancel</button>}
          {(s === 'failed' || s === 'canceled') && <button className="primary" onClick={() => setPayment(null)}>Try again</button>}
          {s === 'succeeded' && <button className="primary" onClick={() => onDone?.(payment, true)}>Done</button>}
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); start(); }}>
      <ErrorBox error={error} />
      {error?.details?.terminal_payment_id && (
        <p><button type="button" className="small" onClick={() => run(async () => { await api.post(`/terminal-payments/${error.details.terminal_payment_id}/cancel`); setError(null); })}>Cancel the waiting payment</button></p>
      )}
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.50" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>
          Reader
          <select value={readerId} onChange={(e) => setReaderId(e.target.value)}>
            {readers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label>
          Receipt
          <select value={receipt} onChange={(e) => setReceipt(e.target.value)}>
            <option value="">No receipt</option>
            <option value="email" disabled={!patient.email}>Email {patient.email ? `(${patient.email})` : '(no email)'}</option>
            <option value="sms" disabled={!patient.phone}>Text {patient.phone ? `(${patient.phone})` : '(no phone)'}</option>
          </select>
        </label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy || !readerId}>Send to reader</button></div>
    </form>
  );
}

// Settings → Integrations: the practice's card readers.
export function CardReaderSettings() {
  const { data, reload } = useApi('/terminal/readers');
  const locations = useLookup('/locations');
  const [form, setForm] = useState({ registration_code: '', label: '', location_id: '' });
  const [error, setError] = useState(null);
  if (!data?.enabled) return null;
  const add = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/terminal/readers', { ...form, location_id: form.location_id ? Number(form.location_id) : null });
      setForm({ registration_code: '', label: '', location_id: '' });
      reload();
    } catch (err) {
      setError(err);
    }
  };
  const multi = locations.length > 1;
  return (
    <div className="card" id="card-readers">
      <h2>Card readers</h2>
      <p className="muted" style={{ fontSize: 13 }}>Take tap, chip and swipe payments at the desk. On the reader, open Settings → “Generate pairing code”, then enter the code here.{data.test_mode ? ' Test mode: use the code “simulated-wpe” for a simulated reader.' : ''}</p>
      <ErrorBox error={error} />
      {data.readers.length > 0 && (
        <table className="table" style={{ marginBottom: 12 }}>
          <thead><tr><th>Name</th><th>Model</th>{multi && <th>Location</th>}<th /></tr></thead>
          <tbody>
            {data.readers.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td className="muted">{(r.device_type || '').replace(/_/g, ' ')}{r.serial_number ? ` · ${r.serial_number}` : ''}</td>
                {multi && <td>{locations.find((l) => l.id === r.location_id)?.name || 'Any'}</td>}
                <td className="num"><button className="small" onClick={() => api.del(`/terminal/readers/${r.id}`).then(reload).catch(setError)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="inline" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={add}>
        <label>Pairing code<input required value={form.registration_code} onChange={(e) => setForm({ ...form, registration_code: e.target.value })} placeholder="e.g. quick-brown-fox" /></label>
        <label>Name<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Front desk" /></label>
        {multi && (
          <label>
            Location
            <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">Any</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <button className="primary">Add reader</button>
      </form>
    </div>
  );
}
