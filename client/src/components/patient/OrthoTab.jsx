import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, toCents, label, practiceToday } from '../../format.js';
import { ErrorBox, Modal, useSubmit, ConfirmButton } from '../ui.jsx';
import { toast } from '../../toast.js';

const STATUS_BADGE = { active: 'info', retention: 'ok', completed: 'ok', cancelled: 'danger' };

// Patient chart → Ortho: the treatment contract (insurance share, down payment, monthly billing) and the
// adjustment log (wires, elastics, aligners).
export default function OrthoTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/patients/${patient.id}/ortho`);
  const [starting, setStarting] = useState(false);
  if (!data) return null;
  const active = data.cases.find((c) => c.status === 'active');
  return (
    <div>
      <div className="page-header">
        <h3 style={{ margin: 0 }}>Orthodontics</h3>
        {!active && can('billing:write') && <button className="primary" onClick={() => setStarting(true)}>+ Start treatment</button>}
      </div>
      {!data.cases.length && <div className="card muted">No orthodontic treatment on file. {can('billing:write') ? 'Start treatment to set up the contract and monthly billing.' : 'Starting treatment sets up the contract and monthly billing, so it’s done by someone who handles billing (the front desk or billing team).'}</div>}
      {data.cases.map((c) => <OrthoCase key={c.id} c={c} appliances={data.appliances} onChange={() => { reload(); onChange?.(); }} />)}
      {starting && <StartForm patient={patient} appliances={data.appliances} onClose={() => setStarting(false)} onDone={() => { setStarting(false); reload(); onChange?.(); }} />}
    </div>
  );
}

function OrthoCase({ c, appliances, onChange }) {
  const { can } = useAuth();
  const [visit, setVisit] = useState(false);
  const [err, setErr] = useState(null);
  const update = async (body) => {
    setErr(null);
    try { await api.put(`/ortho/${c.id}`, body); onChange(); } catch (e) { setErr(e); }
  };
  const patientPart = c.total_fee - c.insurance_estimate;
  const pct = Math.min(100, Math.round((c.months_elapsed / Math.max(1, c.est_months || c.months)) * 100));
  const w = can('clinical:write');
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <strong>{label(c.appliance)} · started {fmtDate(c.start_date)}</strong>
        <span className={`badge ${STATUS_BADGE[c.status]}`}>{c.status}</span>
      </div>
      <ErrorBox error={err} />
      <div className="grid grid-2" style={{ marginTop: 8 }}>
        <div>
          <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase' }}>Progress</div>
          <div>Month {c.months_elapsed} of about {c.est_months || c.months}{c.debond_date ? ` · debonded ${fmtDate(c.debond_date)}` : ''}</div>
          <div className="plan-bar" aria-label={`${pct}% through estimated treatment time`}><i style={{ width: `${pct}%` }} /></div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase' }}>Contract</div>
          <div>{money(c.total_fee)} fee · insurance est. {money(c.insurance_estimate)} · patient {money(patientPart)}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {c.down_payment ? `${money(c.down_payment)} down, then ` : ''}{c.months} × {money(c.monthly_amount)}
            {' · '}{c.billed_months} of {c.months} months billed ({money(c.billed)} of {money(patientPart)})
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {c.billed_months < c.months && c.status !== 'cancelled' && c.status !== 'completed' ? `Next bill ${fmtDate(c.next_bill_date)} · ` : ''}
            {c.payment_method_id ? (c.autopay ? 'Autopay on' : 'Autopay off') : 'Billed to the account'}
            {c.billing_message ? ` · ${c.billing_message}` : ''}
          </div>
          {c.billing_failures > 0 && <div className="badge danger" style={{ marginTop: 4 }}>Card declined — {c.billing_message}</div>}
        </div>
      </div>
      {c.notes && <p className="muted" style={{ marginBottom: 0 }}>{c.notes}</p>}
      {w && (
        <div className="inline" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {c.status === 'active' && <button className="small primary" onClick={() => setVisit(true)}>+ Log adjustment</button>}
          {c.status === 'active' && <button className="small" onClick={() => update({ status: 'retention', debond_date: practiceToday() })}>Debond → retention</button>}
          {c.status === 'retention' && <button className="small" onClick={() => update({ status: 'completed' })}>Mark complete</button>}
          {c.payment_method_id && ['active', 'retention'].includes(c.status) && <button className="small" onClick={() => update({ autopay: !c.autopay })}>{c.autopay ? 'Turn autopay off' : 'Turn autopay on'}</button>}
          {c.status === 'active' && <ConfirmButton ask="Cancel this ortho case? Monthly billing stops; charges already posted stay on the ledger." yes="Cancel case" keep="Keep it" onConfirm={() => update({ status: 'cancelled' })}>Cancel case</ConfirmButton>}
        </div>
      )}
      {visit && <VisitForm c={c} onClose={() => setVisit(false)} onDone={() => { setVisit(false); onChange(); }} />}
      <h4 style={{ marginBottom: 6 }}>Adjustment log</h4>
      {!c.visits.length ? <div className="muted">No visits logged yet.</div> : (
        <table className="compact-table">
          <thead><tr><th>Date</th><th>Upper</th><th>Lower</th><th>Elastics</th><th>Aligner</th><th>Notes</th><th>Next</th><th /></tr></thead>
          <tbody>
            {c.visits.map((v) => (
              <tr key={v.id}>
                <td>{fmtDate(v.visit_date)}</td><td>{v.upper_wire || '—'}</td><td>{v.lower_wire || '—'}</td><td>{v.elastics || '—'}</td><td>{v.aligner || '—'}</td>
                <td>{v.notes}{v.by_name ? <div className="muted" style={{ fontSize: 12 }}>{v.by_name}</div> : null}</td>
                <td>{v.next_weeks ? `${v.next_weeks} wk` : ''}</td>
                <td>{w && <ConfirmButton className="small" aria-label="Delete visit" ask="Delete this visit entry?" yes="Delete" onConfirm={async () => { await api.del(`/ortho/visits/${v.id}`); onChange(); }}>×</ConfirmButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Log an adjustment, right under the case (no dialog): the last visit's wires and elastics are already there, the
// cursor is in the upper wire (selected, so typing replaces it) — change what changed, Enter saves.
function VisitForm({ c, onClose, onDone }) {
  const last = c.visits[0] || {};
  const aligners = c.appliance === 'aligners';
  const [f, setF] = useState({ visit_date: practiceToday(), upper_wire: last.upper_wire || '', lower_wire: last.lower_wire || '', elastics: last.elastics || '', aligner: '', notes: '', next_weeks: last.next_weeks || (aligners ? 8 : 6) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => { await api.post(`/ortho/${c.id}/visits`, f); toast('Adjustment logged'); onDone(); });
  const first = useRef(null);
  useEffect(() => { requestAnimationFrame(() => { first.current?.focus(); first.current?.select(); }); }, []);
  return (
    <form className="inline-editor ortho-visit" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }} aria-label="Log adjustment">
      <h3>Log adjustment{last.visit_date ? <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> — from the {fmtDate(last.visit_date)} visit; change what changed</span> : null}</h3>
      <ErrorBox error={error} />
      <div className="form-grid">
        {!aligners && <label>Upper wire<input ref={first} value={f.upper_wire} onChange={set('upper_wire')} placeholder=".016 NiTi" /></label>}
        {!aligners && <label>Lower wire<input value={f.lower_wire} onChange={set('lower_wire')} placeholder=".016 NiTi" /></label>}
        {aligners && <label>Aligner<input ref={first} value={f.aligner} onChange={set('aligner')} placeholder={last.aligner ? `last: ${last.aligner}` : '6 of 22'} /></label>}
        <label>Elastics<input value={f.elastics} onChange={set('elastics')} placeholder='Class II, 1/4" 6oz' /></label>
        <label>Date<input type="date" value={f.visit_date} onChange={set('visit_date')} /></label>
        <label>Next visit in (weeks)<input type="number" min="1" max="26" value={f.next_weeks} onChange={set('next_weeks')} /></label>
      </div>
      <label>Notes<textarea rows="2" value={f.notes} onChange={set('notes')} /></label>
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function StartForm({ patient, appliances, onClose, onDone }) {
  const providers = useLookup('/providers?active=true');
  const cards = useLookup(`/patients/${patient.id}/payment-methods`);
  const [f, setF] = useState({ total_fee: '5500', down_payment: '1000', months: '24', est_months: '24', appliance: 'brackets', provider_id: '', start_date: practiceToday(), payment_method_id: '', insurance_override: '', notes: '' });
  const [est, setEst] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const terms = { total_fee: toCents(f.total_fee), down_payment: toCents(f.down_payment || 0), months: Number(f.months) };
  useEffect(() => {
    if (!(terms.total_fee > 0) || !(terms.months > 0)) return undefined;
    const t = setTimeout(() => api.post(`/patients/${patient.id}/ortho/estimate`, terms).then(setEst).catch(() => setEst(null)), 250);
    return () => clearTimeout(t);
  }, [f.total_fee, f.down_payment, f.months]); // eslint-disable-line react-hooks/exhaustive-deps
  const insurance = f.insurance_override !== '' ? toCents(f.insurance_override) : est?.insurance_estimate ?? 0;
  const financed = Math.max(0, (terms.total_fee || 0) - insurance - (terms.down_payment || 0));
  const monthly = terms.months > 0 ? Math.floor(financed / terms.months) : 0;
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/ortho`, {
      ...terms, est_months: Number(f.est_months) || terms.months, appliance: f.appliance, provider_id: f.provider_id || null, start_date: f.start_date,
      payment_method_id: f.payment_method_id || null, notes: f.notes, ...(f.insurance_override !== '' ? { insurance_estimate: insurance } : {}),
    });
    onDone();
  });
  return (
    <Modal title="Start orthodontic treatment" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <label>Appliance<select value={f.appliance} onChange={set('appliance')}>{appliances.map((a) => <option key={a} value={a}>{label(a)}</option>)}</select></label>
          <label>Orthodontist<select value={f.provider_id} onChange={set('provider_id')}><option value="">—</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Start date<input type="date" value={f.start_date} onChange={set('start_date')} /></label>
          <label>Estimated treatment time (months)<input type="number" min="1" max="60" value={f.est_months} onChange={set('est_months')} /></label>
          <label>Total fee ($)<input inputMode="decimal" value={f.total_fee} onChange={set('total_fee')} /></label>
          <label>Down payment ($)<input inputMode="decimal" value={f.down_payment} onChange={set('down_payment')} /></label>
          <label>Monthly payments (months)<input type="number" min="1" max="60" value={f.months} onChange={set('months')} /></label>
          <label>Insurance estimate ($)<input inputMode="decimal" value={f.insurance_override} onChange={set('insurance_override')} placeholder={est ? (est.insurance_estimate / 100).toFixed(2) : ''} /></label>
        </div>
        {est && <div className="muted" style={{ fontSize: 13 }}>{est.insurance_note}</div>}
        <div className="card" style={{ background: 'var(--bg)', margin: '10px 0' }}>
          Patient pays <strong>{money(Math.max(0, (terms.total_fee || 0) - insurance))}</strong>: {terms.down_payment ? `${money(terms.down_payment)} today, then ` : ''}
          <strong>{terms.months || 0} × {money(monthly)}</strong> a month{financed - monthly * Math.max(0, terms.months - 1) !== monthly && terms.months > 1 ? ` (last month ${money(financed - monthly * (terms.months - 1))})` : ''}.
        </div>
        <label>
          Card for automatic monthly payments
          <select value={f.payment_method_id} onChange={set('payment_method_id')}>
            <option value="">No card — bill to the account</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.brand} •••• {c.last4} (exp {c.exp_month}/{c.exp_year})</option>)}
          </select>
        </label>
        <label>Notes<textarea rows="2" value={f.notes} onChange={set('notes')} /></label>
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Start treatment</button></div>
      </form>
    </Modal>
  );
}
