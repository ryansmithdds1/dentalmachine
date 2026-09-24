import { Link } from 'react-router-dom';
import { useApi } from '../../hooks.js';
import { money, fmtDate } from '../../format.js';

// "Why do I owe this?" in plain words, visit by visit. Worked out on the server from the ledger each time
// (never a stored balance), so it always adds up to the balance at the top of the ledger.
export default function BalanceWhy({ patient, version, onClose }) {
  const { data, error } = useApi(`/patients/${patient.id}/balance-explained`, [version]);
  if (error) return <div className="card"><div className="error">{error.message}</div></div>;
  if (!data) return <div className="card why-balance"><div className="empty">Working out the balance…</div></div>;
  const owing = data.visits.filter((v) => v.totals.open > 0);
  const settled = data.visits.length - owing.length;
  return (
    <section className="card why-balance" aria-label="Why this balance">
      <header>
        <h2>Why this balance</h2>
        <div className="actions no-print">
          <Link to={`/patients/${patient.id}/statement`}><button className="small">Print statement</button></Link>
          {onClose && <button className="small" onClick={onClose} title="Hide (W)">Hide</button>}
        </div>
      </header>
      <p className="why-summary">{summary(data, owing.length)}</p>
      {owing.map((v) => <Visit key={v.key} v={v} />)}
      {data.unapplied_credit > 0 && (
        <div className="why-visit"><h4><span>Credit on the account</span><span className="why-owes clear">−{money(data.unapplied_credit)}</span></h4><p>Paid ahead; it comes off the next charges.</p></div>
      )}
      {data.other !== 0 && (
        <div className="why-visit"><h4><span>Other</span><span className="why-owes">{money(data.other)}</span></h4><p>Refunds and transfers not tied to a visit.</p></div>
      )}
      {settled > 0 && <div className="why-visit muted" style={{ fontSize: 13 }}>{settled} earlier visit{settled > 1 ? 's are' : ' is'} paid in full.</div>}
    </section>
  );
}

function summary(d, visits) {
  if (d.balance === 0) return 'Nothing is owed: every visit is paid.';
  if (d.balance < 0) return `The account has a ${money(-d.balance)} credit.`;
  const waiting = d.pending_insurance + d.pending_write_off;
  const parts = [`${money(d.balance)} is open from ${visits} visit${visits === 1 ? '' : 's'}.`];
  if (waiting > 0) parts.push(`${money(d.pending_insurance)} is waiting on insurance${d.pending_write_off ? ` (plus ${money(d.pending_write_off)} the plan will write off)` : ''}, so the patient owes ${money(Math.max(0, d.patient_portion))} now.`);
  else parts.push('Nothing is waiting on insurance, so all of it is the patient’s to pay.');
  return parts.join(' ');
}

function Visit({ v }) {
  const t = v.totals;
  const bits = [`Charged ${money(t.charged)}`];
  if (t.insurance_paid) bits.push(`insurance paid ${money(t.insurance_paid)}`);
  if (t.write_off) bits.push(`insurance wrote off ${money(t.write_off)}`);
  if (t.adjusted) bits.push(`discounts ${money(t.adjusted)}`);
  if (t.patient_paid) bits.push(`patient paid ${money(t.patient_paid)}`);
  if (t.waiting_on_insurance) bits.push(`${money(t.waiting_on_insurance)} still waiting on insurance`);
  return (
    <div className="why-visit">
      <h4>
        <span>{fmtDate(v.date)}{v.reason ? ` · ${v.reason}` : ''}{v.provider_name ? ` · ${v.provider_name}` : ''}</span>
        <span className={`why-owes ${t.patient_owes > 0 ? 'due' : ''}`}>{t.patient_owes > 0 ? `Patient owes ${money(t.patient_owes)}` : 'Waiting on insurance'}</span>
      </h4>
      <p>{bits.join(' · ')}.</p>
      <ul>
        {v.lines.filter((l) => l.open > 0).map((l) => (
          <li key={l.ledger_entry_id}>{l.code ? `${l.code} ` : ''}{l.description}: {money(l.charged)}{l.open !== l.charged ? `, ${money(l.open)} open` : ''}</li>
        ))}
      </ul>
    </div>
  );
}
