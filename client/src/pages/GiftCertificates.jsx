import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, openFile } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcut } from '../shortcuts.js';
import { money, toCents, fmtDate, label } from '../format.js';
import { AskButton, ErrorBox, PatientPicker, useSubmit } from '../components/ui.jsx';
import { useLastMethod } from '../components/patient/lastMethod.js';
import { toast } from '../toast.js';
import './compliance.css';

// Gift certificates (A184, docs/cash-handling.md §10): sell one (N), look one up, see what the practice
// still owes holders. Using one happens on the patient's ledger or at checkout ("Gift certificate").
const METHODS = ['credit_card', 'debit_card', 'cash', 'check', 'other'];
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function GiftCertificates() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('outstanding');
  const { data, reload } = useApi(`/gift-certificates?status=${status}`);
  const [selling, setSelling] = useState(params.get('new') === '1');
  const [sold, setSold] = useState(null);
  useEffect(() => {
    if (params.get('new') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);
  useShortcut('n', () => { setSold(null); setSelling(true); }, { label: 'Sell a gift certificate', section: 'Gift certificates', enabled: !selling && can('billing:write') });
  const s = data?.summary;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Gift certificates</h1>
          <div className="muted">Money paid in advance is held for whoever has the certificate until it’s used. Use one from the patient’s ledger (“Gift certificate”).</div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => download(`/gift-certificates?status=${status}&format=csv`, 'gift-certificates.csv')}>Download CSV</button>
          {can('billing:write') && !selling && <button type="button" className="primary" onClick={() => { setSold(null); setSelling(true); }} title="N">Sell a gift certificate</button>}
        </div>
      </div>
      {selling && <SellForm onDone={(c) => { setSelling(false); if (c) { setSold(c); reload(); } }} />}
      {sold && (
        <div className="public-notice ok" role="status" style={{ marginBottom: 12 }}>
          Sold <span className="gc-code">{sold.code}</span> for {money(sold.amount)}{sold.recipient_name ? ` (for ${sold.recipient_name})` : ''}.{' '}
          <button type="button" className="small" onClick={() => openFile(`/gift-certificates/${sold.id}/certificate.pdf`)}>Print the certificate</button>
        </div>
      )}
      {s && (
        <div className="gc-summary">
          <div className="card stat"><div className="label">Still owed to holders</div><div className="value">{money(s.outstanding_total)}</div><div className="muted" style={{ fontSize: 12 }}>{s.outstanding_count} certificate{s.outstanding_count === 1 ? '' : 's'} with money left</div></div>
          <div className="card stat"><div className="label">Used so far</div><div className="value">{money(s.redeemed_total)}</div></div>
          {s.expired_total > 0 && <div className="card stat"><div className="label">Expired, not used</div><div className="value">{money(s.expired_total)}</div><div className="muted" style={{ fontSize: 12 }}>check your state’s unclaimed-property rules</div></div>}
        </div>
      )}
      <Lookup />
      <div className="cmp-bar">
        <div className="seg" role="group" aria-label="Show">
          {[['outstanding', 'Money left'], ['used', 'Used up'], ['voided', 'Voided'], ['all', 'All']].map(([k, t]) => <button key={k} type="button" className={status === k ? 'active' : ''} aria-pressed={status === k} onClick={() => setStatus(k)}>{t}</button>)}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="cmp-table">
            <thead><tr><th>Code</th><th>Sold</th><th>Bought by</th><th>For</th><th className="num">Amount</th><th className="num">Left</th><th>Expires</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data?.rows.map((c) => (
                <tr key={c.id} className={c.status === 'voided' ? 'cmp-voided' : ''}>
                  <td className="gc-code">{c.code}</td>
                  <td>{fmtDate(c.issued_on)}</td>
                  <td><Link to={`/patients/${c.purchaser_patient_id}?tab=ledger`}>{c.purchaser_name}</Link></td>
                  <td>{c.recipient_name || <span className="muted">—</span>}</td>
                  <td className="num">{money(c.amount)}</td>
                  <td className="num">{money(c.balance)}</td>
                  <td>{c.expires_on ? <span className={c.expired ? 'text-danger' : ''}>{fmtDate(c.expires_on)}</span> : 'Never'}</td>
                  <td className="cmp-actions">
                    <button type="button" className="small" onClick={() => openFile(`/gift-certificates/${c.id}/certificate.pdf`)}>Print</button>
                    {c.status === 'active' && c.redeemed === 0 && can('deposits:manage') && (
                      <AskButton label="Why void it? (give the money back the way it was paid)" required submit="Void" danger onSubmit={(v) => api.post(`/gift-certificates/${c.id}/void`, { reason: v }).then(() => { toast(`${c.code} voided`); reload(); })}>Void</AskButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">None here.</div>}
        </div>
      </div>
    </>
  );
}

function SellForm({ onDone }) {
  const { patientId } = useActivePatient();
  const [buyer, setBuyer] = useState(patientId || null);
  const { data: who } = useApi(buyer ? `/patients/${buyer}/card` : null);
  const [lastMethod, rememberMethod] = useLastMethod(METHODS);
  const [f, setF] = useState({ amount: '', recipient_name: '', method: null, reference: '' });
  const method = f.method || lastMethod;
  const key = useRef(newKey());
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const c = await api.post('/gift-certificates', { amount: toCents(f.amount), purchaser_patient_id: buyer, recipient_name: f.recipient_name, method, reference: f.reference, client_key: key.current });
    if (f.method) rememberMethod(f.method);
    key.current = newKey();
    toast(`Sold ${c.code} — ${money(c.amount)} ${label(method).toLowerCase()} taken.`);
    onDone(c);
  });
  const ready = buyer && Number(f.amount) > 0;
  return (
    <section className="inline-panel" aria-label="Sell a gift certificate">
      <header><h3>Sell a gift certificate</h3><button type="button" className="small" onClick={() => onDone(null)}>Cancel</button></header>
      <ErrorBox error={error} />
      <form className="cmp-form" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(null); } }} onSubmit={(e) => { e.preventDefault(); if (ready) submit(); }}>
        <div className="cmp-row">
          {buyer
            ? <span className="cmp-chip">Bought by <strong>{who ? `${who.first_name} ${who.last_name}` : '…'}</strong><button type="button" className="link" aria-label="Someone else is buying" onClick={() => setBuyer(null)}>×</button></span>
            : <span className="cmp-picker"><PatientPicker value={null} onChange={(p) => setBuyer(p?.id || null)} /></span>}
        </div>
        <div className="form-grid">
          <label>Amount ($)<input autoFocus aria-label="Amount ($)" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="e.g. 100" /></label>
          <label>For (optional)<input value={f.recipient_name} onChange={set('recipient_name')} placeholder="Who it’s a gift for" /></label>
          <label>Paid by<select value={method} onChange={set('method')}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></label>
          <label>Reference<input value={f.reference} onChange={set('reference')} placeholder="check # or last 4 (optional)" /></label>
        </div>
        <div className="form-actions">
          <span className="hint">{buyer ? 'Enter sells it. The payment goes on the buyer’s account and is held for the certificate — it isn’t their credit.' : 'Choose who is buying it (they needn’t be the one using it).'}</span>
          <button className="primary" disabled={busy || !ready}>Sell</button>
        </div>
      </form>
    </section>
  );
}

function Lookup() {
  const [code, setCode] = useState('');
  const [out, setOut] = useState(null);
  const { submit, busy, error } = useSubmit(async () => setOut(await api.get(`/gift-certificates/lookup?code=${encodeURIComponent(code)}`)));
  return (
    <form className="card cmp-row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) submit(); }} aria-label="Look up a certificate">
      <label className="inline-label">Check a balance<input className="gc-code" value={code} onChange={(e) => { setCode(e.target.value); setOut(null); }} placeholder="GC-XXXXXXXX" style={{ width: 160 }} /></label>
      <button disabled={busy || !code.trim()}>Look up</button>
      <ErrorBox error={error} />
      {out && <span><span className="gc-code">{out.code}</span>: <strong>{money(out.balance)}</strong> left of {money(out.amount)}{out.status === 'voided' ? ' · voided' : out.expired ? ` · expired ${out.expires_on}` : out.expires_on ? ` · expires ${out.expires_on}` : ''}</span>}
    </form>
  );
}
