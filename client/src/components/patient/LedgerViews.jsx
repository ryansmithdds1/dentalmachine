import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { money, fmtDate, label } from '../../format.js';
import { undoable } from '../../toast.js';
import './ledger.css';

// Colour coding: every line gets a coloured bar and a named chip (never colour alone), from the server's
// `kind` (ledgervisits.js). The colours are tokens in ledger.css with light and dark values.
export const KIND = {
  charge: { label: 'Charge', cls: 'k-charge' },
  patient_payment: { label: 'Patient payment', cls: 'k-patient-pay' },
  insurance_payment: { label: 'Insurance payment', cls: 'k-ins-pay' },
  write_off: { label: 'Insurance write-off', cls: 'k-write-off' },
  credit_adjustment: { label: 'Discount / credit', cls: 'k-discount' },
  debit_adjustment: { label: 'Fee added', cls: 'k-fee' },
  refund: { label: 'Refund', cls: 'k-refund' },
};
const isVoid = (e) => !!(e.voided_at || e.reverses_id);

export function KindChip({ e }) {
  const k = KIND[e.kind] || { label: label(e.type), cls: '' };
  return (
    <span className={`kind-chip ${isVoid(e) ? 'k-void' : k.cls}`}>
      {k.label}{e.voided_at ? ' · voided' : e.reverses_id ? ' · reversal' : ''}
    </span>
  );
}

export function LedgerLegend() {
  return (
    <div className="ledger-legend" aria-label="Colour key">
      <span className="muted">Colour key:</span>
      {Object.values(KIND).map((k) => <span key={k.cls} className={`kind-chip ${k.cls}`}>{k.label}</span>)}
      <span className="kind-chip k-void">Voided / reversed</span>
      <span className="kind-chip k-expected">Insurance still expected</span>
    </div>
  );
}

// One ledger line. Clicking it (or Enter) highlights everything on the same visit or claim.
export function LedgerRow({ e, showBalance, canWrite, focus, onFocus, onReceipt, onVoid, actions }) {
  const related = focus && e.visit_key === focus.visit_key;
  const cls = ['lrow', (KIND[e.kind] || {}).cls, isVoid(e) ? 'voided k-void' : '', related ? 'related' : '', focus?.id === e.id ? 'selected' : ''].filter(Boolean).join(' ');
  const toggle = () => onFocus(focus?.id === e.id ? null : e);
  return (
    <tr className={cls} data-entry={e.id} data-kind={e.kind} tabIndex={0} aria-selected={focus?.id === e.id}
      onClick={(ev) => { if (!ev.target.closest('button, a, select, input')) toggle(); }}
      onKeyDown={(ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); toggle(); } }}>
      <td>{fmtDate(e.entry_date)}</td>
      <td><KindChip e={e} /></td>
      <td>
        {e.proc_code && <span className="badge" style={{ marginRight: 6 }}>{e.proc_code}{e.proc_tooth ? ` #${e.proc_tooth}` : ''}{e.proc_surfaces ? ` ${e.proc_surfaces}` : ''}</span>}
        {e.description}{e.reference ? <span className="muted"> · ref {e.reference}</span> : ''}
        {e.claim_link && <> · <Link to={`/claims/${e.claim_link}`}>claim #{e.claim_link}</Link></>}
        {e.provider_name && <span className="muted"> · {e.provider_name}</span>}
        {e.voided_at && <div className="muted" style={{ fontSize: 12 }}>Voided — {e.void_reason}</div>}
      </td>
      <td className="muted">{e.created_by_name}</td>
      <td className="num">{e.amount > 0 ? money(e.amount) : ''}</td>
      <td className="num">{e.amount < 0 ? money(-e.amount) : ''}</td>
      {showBalance && <td className="num">{money(e.running_balance)}</td>}
      {canWrite && (
        <td className="num" style={{ whiteSpace: 'nowrap' }}>
          {actions}
          {e.type === 'payment' && e.amount < 0 && <button className="small" style={{ marginRight: 4 }} onClick={() => onReceipt(e)}>Receipt</button>}
          {!e.voided_at && !e.reverses_id && !e.claim_id && <button className="small" title={e.void_needs_manager ? `${e.void_needs_manager} — you can ask one to void it` : e.type === 'charge' ? 'Void this charge and put the procedure back to planned' : 'Void this entry'} onClick={() => onVoid(e)}>{e.void_needs_manager ? 'Void (manager)…' : 'Void'}</button>}
        </td>
      )}
    </tr>
  );
}

const visitName = (v) => `${fmtDate(v.date)}${v.reason ? ` · ${v.reason}` : ''}`;

// "Where did this balance come from?": the ledger visit by visit — charges, the claim for them, what insurance
// paid and wrote off, what the patient paid — and what's left on each visit (the sum of its lines; the visits
// plus "Not applied to a visit" add up to the account balance).
export function VisitView({ data, canWrite, focus, onFocus, rowProps, onChanged }) {
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const [applying, setApplying] = useState(null);
  const targets = data.visits.filter((v) => v.anchor_id);
  const groups = [...(data.not_applied ? [{ ...data.not_applied, unapplied: true }] : []), ...data.visits];
  const unlink = (e, v) => undoable(`${KIND[e.kind]?.label || 'Entry'} of ${money(Math.abs(e.amount))} taken off the ${visitName(v)} visit`,
    () => api.post(`/ledger/${e.id}/unlink`, { reason: 'Taken off the visit from the ledger' }).then((r) => { onChanged(); return r; }),
    () => api.post(`/ledger/${e.id}/link`, { applied_to_id: e.applied_to_id, reason: 'Undone right after' }).then(onChanged));
  if (!groups.length) return <div className="empty">No transactions.</div>;
  const cols = canWrite ? 7 : 6;
  return (
    <div className="table-wrap">
      <table className="visit-table">
        <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>By</th><th className="num">Charges</th><th className="num">Credits</th>{canWrite && <th />}</tr></thead>
        {groups.map((g) => {
          const t = g.totals;
          const bits = [
            t.charges && `Charged ${money(t.charges)}`, t.fees && `fees ${money(t.fees)}`, t.insurance_paid && `insurance paid ${money(t.insurance_paid)}`,
            t.write_off && `written off ${money(t.write_off)}`, t.adjusted && `discounts ${money(t.adjusted)}`, t.patient_paid && `patient paid ${money(t.patient_paid)}`,
            t.refunded && `refunded ${money(t.refunded)}`,
          ].filter(Boolean);
          return (
            <tbody key={g.key} className={`visit-group${g.unapplied ? ' unapplied' : ''}${focus?.visit_key === g.key ? ' related' : ''}`} data-visit={g.key} aria-label={g.unapplied ? 'Not applied to a visit' : `Visit ${visitName(g)}`}>
              <tr className="visit-head">
                <th colSpan={cols} scope="rowgroup">
                  <div className="visit-head-line">
                    <strong>{g.unapplied ? 'Not applied to a visit' : visitName(g)}</strong>
                    {g.provider_name && <span className="muted">{g.provider_name}</span>}
                    {(g.claims || []).map((c) => (
                      <Link key={c.id} to={`/claims/${c.id}`} className={`kind-chip claim-chip ${c.status === 'void' ? 'k-void' : 'k-ins-pay'}`} title="Open the claim">
                        Claim #{c.id}{c.carrier_name ? ` · ${c.carrier_name}` : ''} · {label(c.status)}
                      </Link>
                    ))}
                    {g.insurance_expected > 0 && <span className="kind-chip k-expected">Insurance still expected {money(g.insurance_expected)}</span>}
                    {g.write_off_expected > 0 && <span className="kind-chip k-expected">Write-off expected {money(g.write_off_expected)}</span>}
                    <span className={`visit-left${g.balance > 0 ? ' due' : g.balance < 0 ? ' credit' : ''}`} data-left={g.balance}>
                      {g.unapplied ? (g.balance < 0 ? `Credit ${money(-g.balance)}` : money(g.balance)) : g.balance === 0 ? 'Paid in full' : g.balance > 0 ? `Left on this visit ${money(g.balance)}` : `Overpaid ${money(-g.balance)}`}
                    </span>
                  </div>
                  <div className="visit-note">
                    {g.unapplied ? 'Payments and adjustments not tied to a visit. Until they’re applied to one, they come off the oldest visits first.' : bits.join(' · ')}
                  </div>
                </th>
              </tr>
              {g.entry_ids.map((id) => byId.get(id)).filter(Boolean).map((e) => {
                const canApply = canWrite && e.linkable && targets.length > 0;
                const actions = canApply && (g.unapplied
                  ? <button className="small" style={{ marginRight: 4 }} onClick={() => setApplying(applying === e.id ? null : e.id)} aria-expanded={applying === e.id}>Apply to visit…</button>
                  : e.applied_to_id ? <button className="small" style={{ marginRight: 4 }} onClick={() => unlink(e, g)} title="Put it back under Not applied to a visit">Take off visit</button> : null);
                return [
                  <LedgerRow key={e.id} e={e} canWrite={canWrite} focus={focus} onFocus={onFocus} actions={actions} {...rowProps} />,
                  applying === e.id && (
                    <tr key={`apply-${e.id}`} className="apply-row">
                      <td colSpan={cols}>
                        <ApplyForm entry={e} visits={targets} onCancel={() => setApplying(null)} onDone={() => { setApplying(null); onChanged(); }} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

// Inline (no dialog): the newest visit with something left on it is chosen and the Apply button has the focus,
// so Enter applies it (Shift+Tab to pick another visit).
// The toast's Undo takes it off again; both are recorded.
function ApplyForm({ entry, visits, onCancel, onDone }) {
  const start = visits.find((v) => v.balance > 0) || visits[0];
  const [to, setTo] = useState(String(start?.anchor_id || ''));
  const [busy, setBusy] = useState(false);
  const submit = async (ev) => {
    ev.preventDefault();
    const v = visits.find((x) => String(x.anchor_id) === to);
    if (!v || busy) return;
    setBusy(true);
    try {
      await undoable(`${KIND[entry.kind]?.label || 'Entry'} of ${money(Math.abs(entry.amount))} applied to the ${visitName(v)} visit`,
        () => api.post(`/ledger/${entry.id}/link`, { applied_to_id: v.anchor_id, reason: 'Applied to a visit from the ledger' }),
        () => api.post(`/ledger/${entry.id}/unlink`, { reason: 'Undone right after' }).then(onDone));
      onDone();
    } catch {
      setBusy(false); // the toast says what went wrong
    }
  };
  return (
    <form className="apply-form" onSubmit={submit} onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); onCancel(); } }}>
      <label className="inline" style={{ gap: 6, margin: 0 }}>
        Apply {money(Math.abs(entry.amount))} to
        <select aria-label="Visit" value={to} onChange={(ev) => setTo(ev.target.value)} style={{ width: 'auto' }}>
          {visits.map((v) => <option key={v.key} value={v.anchor_id}>{visitName(v)} — {v.balance > 0 ? `${money(v.balance)} left` : 'paid'}</option>)}
        </select>
      </label>
      <button className="primary small" autoFocus disabled={busy || !to}>Apply</button>
      <button type="button" className="small" onClick={onCancel}>Cancel</button>
    </form>
  );
}
