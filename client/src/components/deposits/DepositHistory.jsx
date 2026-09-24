import { useEffect, useState } from 'react';
import { X, Printer, Camera, UserCheck, RotateCcw, AlertTriangle, Landmark, CreditCard, FileText } from 'lucide-react';
import { api, openFile } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime, label } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { uploadDepositPhoto, STATUS_LABEL } from './depositApi.js';

const Chip = ({ status }) => <span className={`dep-chip ${status}`}>{STATUS_LABEL[status] || label(status)}</span>;

// Every deposit followed to the bank: submitted → in the bank → reconciled, and anything that needs a person.
export default function DepositHistory() {
  const { data, error, reload } = useApi('/daily-deposits');
  const [openId, setOpenId] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card muted">Loading deposits…</div>;
  return (
    <div className="dep-grid">
      <div className="card">
        <div className="dep-section-title"><h2>Cash and check deposits</h2><span className="muted">{fmtDate(data.from)} – {fmtDate(data.to)}</span></div>
        <table className="dep-table">
          <thead><tr><th>Day</th><th>Bag</th><th>Prepared / verified</th><th className="num">Total</th><th>Where it is</th></tr></thead>
          <tbody>
            {data.deposits.map((d) => (
              <tr key={d.id} className="clickable" tabIndex={0} onClick={() => setOpenId(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(d.id); }}>
                <td>{fmtDate(d.business_date)}{d.location && <div className="muted" style={{ fontSize: 12 }}>{d.location.name}</div>}</td>
                <td>{d.bag_number || '—'}</td>
                <td>{d.prepared_by_name}<div className="muted" style={{ fontSize: 12 }}>{d.verified_by_name ? `✓ ${d.verified_by_name}` : 'not verified yet'}</div></td>
                <td className="num">{money(d.total)}{d.difference !== 0 && d.stage !== 'reopened' && <div className="dep-short" style={{ fontSize: 12 }}>{money(d.difference)} vs ledger</div>}</td>
                <td><Chip status={d.status} />{d.exceptions.map((x) => <div key={x.kind} className="dep-short" style={{ fontSize: 12 }}>{x.text}</div>)}</td>
              </tr>
            ))}
            {!data.deposits.length && <tr><td colSpan={5} className="muted">No deposits in the last 30 days.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="dep-section-title"><h2>Cards and insurance EFTs</h2></div>
        <table className="dep-table">
          <tbody>
            {data.electronic.map((e) => (
              <tr key={e.key}>
                <td>{e.type === 'eft' ? <Landmark size={14} /> : <CreditCard size={14} />} {e.label}<div className="muted" style={{ fontSize: 12 }}>{fmtDate(e.date)}</div></td>
                <td className="num">{money(e.amount)}</td>
                <td><Chip status={e.status} /></td>
              </tr>
            ))}
            {!data.electronic.length && <tr><td className="muted">None in this period.</td></tr>}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12 }}>“In the bank” comes from the bank feed (Finance → Bank). Anything late shows in Needs attention.</p>
      </div>
      {openId && <DepositPanel id={openId} onClose={() => setOpenId(null)} onChange={reload} />}
    </div>
  );
}

// One deposit, in a side panel: what's on it, who did what, and the manager's actions.
export function DepositPanel({ id, onClose, onChange }) {
  const { user } = useAuth();
  const { data: d, error, reload } = useApi(`/daily-deposits/${id}`);
  const { data: settings } = useApi('/cash/settings');
  const [ask, setAsk] = useState(null);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState(null);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const act = async (fn, msg) => {
    setErr(null);
    try {
      await fn();
      toast(msg);
      setAsk(null);
      setWhy('');
      reload();
      onChange?.();
    } catch (x) { setErr(x); }
  };
  const manager = settings?.manager;
  return (
    <aside className="dep-panel" aria-label="Deposit">
      <header><h2 style={{ margin: 0 }}>Deposit {d ? `· ${fmtDate(d.business_date)}` : ''}</h2><button type="button" className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
      <ErrorBox error={error || err} />
      {d && (
        <>
          <Chip status={d.status} />
          {d.exceptions.map((x) => <div key={x.kind} className="dep-flag danger"><AlertTriangle size={16} />{x.text}</div>)}
          {d.separation.map((f) => <div key={f.kind} className={`dep-flag ${f.severity === 'note' ? 'note' : ''}`}><AlertTriangle size={16} />{f.text}</div>)}
          <dl>
            <dt>Total</dt><dd><strong>{money(d.total)}</strong> ({money(d.check_total)} checks · {money(d.cash_total)} cash{d.cash_source === 'drawers' ? ' from drawers' : ''})</dd>
            <dt>Ledger</dt><dd>{money(d.ledger_total)}{d.difference ? ` · ${money(d.difference)} difference` : ''}{d.left_out_total ? ` · ${money(d.left_out_total)} held back` : ''}</dd>
            {d.difference_reason && <><dt>Why</dt><dd>{d.difference_reason}</dd></>}
            <dt>Bag / slip</dt><dd>{d.bag_number}</dd>
            <dt>Prepared</dt><dd>{d.prepared_by_name} · {fmtDateTime(d.submitted_at.slice(0, 16))} UTC</dd>
            <dt>Verified</dt><dd>{d.verified_by_name ? `${d.verified_by_name} · ${fmtDateTime(d.verified_at.slice(0, 16))} UTC` : 'Not yet'}</dd>
            <dt>Bank</dt><dd>{d.bank_amount != null ? `${money(d.bank_amount)} on ${fmtDate(d.bank_date)}` : 'Not seen yet'}{d.bank_note ? ` — ${d.bank_note}` : ''}</dd>
            {d.stage === 'reopened' && <><dt>Reopened</dt><dd>{d.reopened_by_name}: {d.reopen_reason}{d.replaced_by ? ` (replaced by deposit #${d.replaced_by})` : ''}</dd></>}
            {d.replaces_deposit_id && <><dt>Replaces</dt><dd>Deposit #{d.replaces_deposit_id}</dd></>}
          </dl>
          <div className="dep-actions">
            <button type="button" onClick={() => openFile(`/daily-deposits/${d.id}/slip.pdf`).catch(setErr)}><Printer size={16} /> Slip</button>
            {d.stage !== 'reopened' && <label className="button"><Camera size={16} /> Add photo<input type="file" hidden accept="image/*,application/pdf" capture="environment" onChange={(e) => e.target.files?.[0] && act(() => uploadDepositPhoto(d.id, e.target.files[0]), 'Photo added')} /></label>}
            {d.photos.map((p, i) => <button key={p.id} type="button" onClick={() => openFile(`/daily-deposits/${d.id}/photos/${p.id}`).catch(setErr)}><FileText size={16} /> Photo {i + 1}</button>)}
            {manager && d.stage !== 'reopened' && !d.verified_by && d.prepared_by !== user?.id && <button type="button" className="primary" onClick={() => act(() => api.post(`/daily-deposits/${d.id}/verify`), 'Deposit verified')}><UserCheck size={16} /> I checked the bag — verify</button>}
            {manager && d.stage !== 'reopened' && d.bank_status === 'open' && <button type="button" onClick={() => setAsk('reopen')}><RotateCcw size={16} /> Reopen to correct</button>}
            {manager && d.bank_status === 'discrepancy' && !d.bank_note && <button type="button" onClick={() => setAsk('bank')}>Explain the bank difference</button>}
          </div>
          {ask && (
            <form className="dep-form" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/daily-deposits/${d.id}/${ask === 'reopen' ? 'reopen' : 'bank-note'}`, { reason: why }), ask === 'reopen' ? 'Deposit reopened — its payments are back on Today’s deposit' : 'Difference recorded'); }}>
              <label>{ask === 'reopen' ? 'Why does it need correcting? (the original is kept)' : 'What explains the difference?'}<textarea autoFocus rows={2} value={why} onChange={(e) => setWhy(e.target.value)} required /></label>
              <div className="dep-actions"><button className="primary" type="submit">{ask === 'reopen' ? 'Reopen' : 'Save'}</button><button type="button" onClick={() => setAsk(null)}>Cancel</button></div>
            </form>
          )}
          <h3>On this deposit</h3>
          <table className="dep-table">
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id} className={i.voided ? 'off' : ''}>
                  <td>{label(i.kind)}{i.check_number ? ` #${i.check_number}` : ''}<div className="muted" style={{ fontSize: 12 }}>{i.payer} · taken by {i.taken_by_name || '—'}</div></td>
                  <td className="num">{money(i.amount)}{i.voided && <div className="dep-short" style={{ fontSize: 12 }}>voided since</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </aside>
  );
}
