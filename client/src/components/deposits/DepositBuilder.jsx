import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Printer, Camera, Landmark, CreditCard, Banknote, ShieldCheck } from 'lucide-react';
import { api, openFile } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, practiceToday } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import DenominationCounter, { countTotal } from './DenominationCounter.jsx';
import { uploadDepositPhoto, newSubmitKey, STATUS_LABEL } from './depositApi.js';

// Today's deposit: the checks (one by one), the cash (counted by bills and coins, or the verified drawer counts),
// checked against what the ledger says was taken. When it balances: bag number, Enter — done.
export default function DepositBuilder({ onSubmitted }) {
  const { practice, can } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [date, setDate] = useState(today);
  const { data, error, reload } = useApi(`/daily-deposits/build?date=${date}`);
  const [excluded, setExcluded] = useState(() => new Set());
  const [counts, setCounts] = useState({});
  const [mode, setMode] = useState(null);
  const [bag, setBag] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newSubmitKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const reasonRef = useRef(null);
  const write = can('billing:write');

  const closedDrawers = (data?.drawers || []).filter((d) => d.status === 'closed');
  const cashMode = mode || (closedDrawers.length ? 'drawers' : 'count');
  const t = useMemo(() => {
    if (!data) return null;
    const on = data.entries.filter((e) => !excluded.has(e.id));
    const cashExpected = on.filter((e) => e.kind !== 'check').reduce((s, e) => s + e.amount, 0);
    const checkTotal = on.filter((e) => e.kind === 'check').reduce((s, e) => s + e.amount, 0);
    const cashCounted = cashMode === 'drawers' ? closedDrawers.reduce((s, d) => s + (d.to_deposit || 0), 0) : countTotal(data.denominations, counts);
    const leftOut = data.entries.filter((e) => excluded.has(e.id));
    const difference = cashCounted - cashExpected;
    return { cashExpected, checkTotal, cashCounted, total: cashCounted + checkTotal, ledger: cashExpected + checkTotal, difference, leftOut: leftOut.reduce((s, e) => s + e.amount, 0), leftCount: leftOut.length, balanced: difference === 0 && leftOut.length === 0, ids: on.map((e) => e.id) };
  }, [data, excluded, counts, cashMode, closedDrawers]);

  const toggleLine = (ids) => {
    const next = new Set(excluded);
    const off = ids.every((id) => next.has(id));
    for (const id of ids) (off ? next.delete(id) : next.add(id));
    setExcluded(next);
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!t || busy) return;
    if (!t.balanced && !reason.trim()) {
      setErr(new Error('This deposit doesn’t match the ledger — say why before submitting.'));
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = {
        submit_key: key, business_date: date, entry_ids: t.ids, bag_number: bag, difference_reason: t.balanced ? undefined : reason,
        ...(cashMode === 'drawers' ? { drawer_session_ids: closedDrawers.map((d) => d.id) } : { cash_count: counts }),
      };
      const dep = await api.post('/daily-deposits', body);
      setDone(dep);
      toast(`Deposit of ${money(dep.total)} submitted and locked`);
      onSubmitted?.(dep);
    } catch (x) {
      setErr(x);
      if (x.details?.needs_reason) reasonRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setDone(null); setCounts({}); setBag(''); setReason(''); setExcluded(new Set()); setMode(null); setKey(newSubmitKey()); reload();
  };

  if (error) return <ErrorBox error={error} />;
  if (!data || !t) return <div className="card muted">Loading the day’s payments…</div>;
  if (done) return <Submitted dep={done} onAnother={startOver} />;

  const nothing = !data.entries.length && !closedDrawers.length;
  return (
    <form className="dep-grid" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }}>
      <div>
        <div className="dep-toolbar">
          <label>Payments taken on <input type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value || today); setExcluded(new Set()); }} /></label>
          <span className="muted" style={{ fontSize: 13 }}>Ledger for the day: {money(data.day_ledger.cash)} cash · {money(data.day_ledger.check)} checks{data.day_ledger.cash_refund ? ` · ${money(-data.day_ledger.cash_refund)} cash refunded` : ''}</span>
        </div>
        {data.reopened?.length > 0 && <div className="dep-flag"><AlertTriangle size={16} />A reopened deposit ({fmtDate(data.reopened[0].business_date)}) is waiting to be redone: “{data.reopened[0].reopen_reason}”. Its payments are back on this list.</div>}
        {data.drawers_open > 0 && <div className="dep-flag note"><Banknote size={16} />{data.drawers_open} cash drawer{data.drawers_open === 1 ? ' is' : 's are'} still open or waiting for a second person. Close {data.drawers_open === 1 ? 'it' : 'them'} on Cash drawers first.</div>}

        <div className="card">
          <div className="dep-section-title"><h2>Checks</h2><span className="muted">{data.checks.length} check{data.checks.length === 1 ? '' : 's'} · untick one to hold it back</span></div>
          <table className="dep-table">
            <thead><tr><th aria-label="On this deposit" /><th>From</th><th>Check #</th><th>Taken</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {data.checks.map((c) => {
                const on = !c.entry_ids.every((id) => excluded.has(id));
                return (
                  <tr key={c.key} className={on ? '' : 'off'}>
                    <td><input type="checkbox" checked={on} onChange={() => toggleLine(c.entry_ids)} aria-label={`Include check from ${c.payer}`} /></td>
                    <td>{c.payer}{c.insurance && c.patients.length > 0 && <div className="muted" style={{ fontSize: 12 }}>for {c.patients.join(', ')}</div>}</td>
                    <td>{c.check_number || <span className="muted">—</span>}</td>
                    <td>{fmtDate(c.entry_date)}{c.earlier && <span className="dep-chip warn" style={{ marginLeft: 6 }}>earlier day</span>}</td>
                    <td className="num">{money(c.amount)}</td>
                  </tr>
                );
              })}
              {!data.checks.length && <tr><td colSpan={5} className="muted">No checks waiting.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="dep-section-title">
            <h2>Cash</h2>
            <span className="muted">Ledger says {money(t.cashExpected)} ({data.cash_entries.filter((e) => !excluded.has(e.id)).length} payment{data.cash_entries.length === 1 ? '' : 's'})</span>
          </div>
          {closedDrawers.length > 0 && (
            <div className="dep-toolbar" role="radiogroup" aria-label="How the cash was counted">
              <label><input type="radio" name="cashmode" checked={cashMode === 'drawers'} onChange={() => setMode('drawers')} /> Use the verified drawer count{closedDrawers.length > 1 ? 's' : ''} ({money(closedDrawers.reduce((s, d) => s + (d.to_deposit || 0), 0))})</label>
              <label><input type="radio" name="cashmode" checked={cashMode === 'count'} onChange={() => setMode('count')} /> Count it here</label>
            </div>
          )}
          {cashMode === 'count' ? <DenominationCounter denominations={data.denominations} value={counts} onChange={setCounts} idPrefix="dep" /> : (
            <table className="dep-table"><tbody>{closedDrawers.map((d) => <tr key={d.id}><td>{d.name}</td><td className="num">{money(d.to_deposit)}</td></tr>)}</tbody></table>
          )}
          {data.cash_entries.some((e) => e.kind === 'cash_refund') && <p className="muted" style={{ fontSize: 13 }}>Cash refunded out of the day’s cash is taken off what the bag should hold.</p>}
        </div>

        <div className="card">
          <div className="dep-section-title"><h2>Cards and insurance EFTs</h2><span className="muted">Not in the bag: they go to the bank on their own</span></div>
          <table className="dep-table">
            <tbody>
              {data.electronic.map((e) => (
                <tr key={e.key}>
                  <td>{e.type === 'eft' ? <Landmark size={15} /> : <CreditCard size={15} />} {e.label}</td>
                  <td className="num">{money(e.amount)}</td>
                  <td><span className={`dep-chip ${e.in_bank ? 'in_bank' : 'taken'}`}>{e.in_bank ? 'In the bank' : 'On its way'}</span></td>
                </tr>
              ))}
              {!data.electronic.length && <tr><td className="muted">No card batches or EFTs for this day.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card dep-totals">
        <h2>Deposit for {fmtDate(date)}</h2>
        <div className="dep-big">
          <div className="line"><span>Checks</span><strong>{money(t.checkTotal)}</strong></div>
          <div className="line"><span>Cash in the bag</span><strong>{money(t.cashCounted)}</strong></div>
          <div className="line total"><span>Total</span><strong>{money(t.total)}</strong></div>
          <div className="line"><span className="muted">Ledger says</span><span className="muted">{money(t.ledger)}</span></div>
          {t.difference !== 0 && <div className="line diff"><span>Cash {t.difference < 0 ? 'short' : 'over'}</span><strong>{money(Math.abs(t.difference))}</strong></div>}
          {t.leftCount > 0 && <div className="line"><span>Held back</span><span>{money(t.leftOut)} ({t.leftCount})</span></div>}
        </div>
        {nothing ? <div className="dep-balance off"><AlertTriangle size={20} />Nothing waiting to go to the bank.</div>
          : t.balanced ? <div className="dep-balance ok" role="status"><CheckCircle2 size={22} />Balances with the ledger</div>
            : <div className="dep-balance off" role="status"><AlertTriangle size={20} />Doesn’t match — say why below</div>}
        <ErrorBox error={err} />
        {write && !nothing && (
          <div className="dep-form">
            {!t.balanced && (
              <label>Why doesn’t it match?
                <textarea ref={reasonRef} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. $5 short, counted twice, manager told" />
              </label>
            )}
            <label>Bag or deposit slip number
              {/* Workflow 42: when it already balances (checks only, or verified drawers), the bag number is all that's left. */}
              <input autoFocus={t.balanced} aria-label="Bag or deposit slip number" value={bag} onChange={(e) => setBag(e.target.value)} placeholder="From the bag or the bank slip" autoComplete="off" required />
            </label>
            <button className="primary" type="submit" disabled={busy || !bag.trim()}><ShieldCheck size={18} /> {busy ? 'Submitting…' : `Submit and lock ${money(t.total)}`}</button>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Once submitted it’s locked. A second person verifies it; a manager can reopen it with a reason.</p>
          </div>
        )}
      </div>
    </form>
  );
}

// After submitting: print the slip, add the stamped-slip photo, and ask someone else to verify.
export function Submitted({ dep, onAnother }) {
  const [photos, setPhotos] = useState(dep.photos?.length || 0);
  const [err, setErr] = useState(null);
  const add = async (file) => {
    if (!file) return;
    try {
      await uploadDepositPhoto(dep.id, file);
      setPhotos((n) => n + 1);
      toast('Photo added to the deposit');
    } catch (x) { setErr(x); }
  };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="dep-balance ok"><CheckCircle2 size={22} />Deposit of {money(dep.total)} submitted and locked · <span className={`dep-chip ${dep.status}`}>{STATUS_LABEL[dep.status] || dep.status}</span></div>
      <p>Bag {dep.bag_number} · prepared by {dep.prepared_by_name}. Ask a manager (someone else) to verify it on the History tab.</p>
      {dep.separation?.map((f) => <div key={f.kind} className={`dep-flag ${f.severity === 'note' ? 'note' : ''}`}><AlertTriangle size={16} />{f.text}</div>)}
      <ErrorBox error={err} />
      <div className="dep-actions">
        <button type="button" onClick={() => openFile(`/daily-deposits/${dep.id}/slip.pdf`).catch(setErr)}><Printer size={16} /> Print the slip</button>
        <label className="button"><Camera size={16} /> Add a photo of the stamped slip{photos ? ` (${photos})` : ''}<input type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => add(e.target.files?.[0])} /></label>
        <button type="button" onClick={onAnother}>Start another deposit</button>
      </div>
    </div>
  );
}
