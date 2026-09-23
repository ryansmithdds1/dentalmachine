import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtUtcDateTime, label, toCents, fromCents } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

const STEP = { letter_30: '30-day letter', letter_60: '60-day letter', letter_90: 'Final notice', agency: 'Send to agency', written_off: 'Written off', cleared: 'Taken out of collections', finance_charge: 'Finance charge', late_fee: 'Late fee' };
const AGE = { 0: 'Current', 30: '31–60 days', 60: '61–90 days', 90: '90+ days' };

// Billing → Collections: past-due family accounts and the next step for each.
export default function Collections() {
  const { can, user } = useAuth();
  const { data, reload } = useApi('/collections');
  const [open, setOpen] = useState(null);
  const [charges, setCharges] = useState(false);
  const [setup, setSetup] = useState(false);
  if (!data) return <div className="card">Loading…</div>;
  const w = can('billing:write');
  const total = data.accounts.reduce((s, a) => s + a.overdue, 0);
  return (
    <>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Past-due accounts</h2>
            <div className="muted" style={{ fontSize: 13 }}>{data.accounts.length} families · {money(total)} more than 30 days past due (what patients owe, not what insurance is expected to pay).</div>
          </div>
          <div className="inline">
            {w && <button onClick={() => setCharges(true)}>Finance charges & late fees…</button>}
            {user.role === 'admin' && <button onClick={() => setSetup(true)}>Settings</button>}
          </div>
        </div>
        <div className="table-wrap">
          <table className="compact-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Account</th><th className="num">Past due</th><th className="num">Balance</th><th>Oldest</th><th>Last paid</th><th>Status</th><th>Next step</th><th /></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/patients/${a.id}?tab=ledger`}>{a.first_name} {a.last_name}</Link>{a.phone && <div className="muted" style={{ fontSize: 12 }}>{a.phone}</div>}</td>
                  <td className="num">{money(a.overdue)}</td>
                  <td className="num">{money(a.balance)}{a.insurance_pending > 0 && <div className="muted" style={{ fontSize: 11 }}>{money(a.insurance_pending)} insurance</div>}</td>
                  <td>{AGE[a.age]}</td>
                  <td>{a.last_payment ? fmtDate(a.last_payment) : 'Never'}</td>
                  <td>{a.collection_status ? STEP[a.collection_status] || label(a.collection_status) : '—'}</td>
                  <td>{a.next ? STEP[a.next] : '—'}</td>
                  <td><button className="small" onClick={() => setOpen(a.id)}>Open</button></td>
                </tr>
              ))}
              {!data.accounts.length && <tr><td colSpan={8} className="muted">Nobody is more than 30 days past due.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {open && <AccountModal id={open} canWrite={w} admin={user.role === 'admin'} agency={data.settings.collection_agency} onClose={() => setOpen(null)} onChanged={reload} />}
      {charges && <ChargesModal settings={data.settings} onClose={() => setCharges(false)} onDone={() => { setCharges(false); reload(); }} />}
      {setup && <SettingsModal settings={data.settings} onClose={() => setSetup(false)} onDone={() => { setSetup(false); reload(); }} />}
    </>
  );
}

function AccountModal({ id, canWrite, admin, agency, onClose, onChanged }) {
  const { practice } = useAuth();
  const { data, reload } = useApi(`/collections/${id}`);
  const [err, setErr] = useState(null);
  const [agencyName, setAgencyName] = useState(agency || '');
  const run = async (fn) => {
    setErr(null);
    try { await fn(); reload(); onChanged(); } catch (e) { setErr(e); }
  };
  if (!data) return <Modal title="Account" onClose={onClose}><p>Loading…</p></Modal>;
  const a = data.aging;
  return (
    <Modal title={`${data.account.first_name} ${data.account.last_name}`} onClose={onClose}>
      <ErrorBox error={err} />
      {a && (
        <table className="compact-table">
          <tbody>
            <tr><td>Balance</td><td className="num">{money(a.balance)}</td></tr>
            <tr><td>Expected from insurance</td><td className="num">{money(a.insurance_pending)}</td></tr>
            <tr><td>31–60 / 61–90 / 90+ days</td><td className="num">{money(a.d31_60)} / {money(a.d61_90)} / {money(a.d90_plus)}</td></tr>
            <tr><td><strong>Past due from the patient</strong></td><td className="num"><strong>{money(a.overdue)}</strong></td></tr>
          </tbody>
        </table>
      )}
      {canWrite && (
        <>
          <h3>Letters</h3>
          {Object.entries(data.letters).map(([k, l]) => (
            <div key={k} className="inline" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div><strong>{l.title}</strong><div className="muted" style={{ fontSize: 12 }}>{l.body}</div></div>
              <div className="inline" style={{ gap: 6, flexShrink: 0 }}>
                <button className="small" disabled={!a?.overdue} onClick={() => run(async () => { const r = await api.post(`/collections/${id}/letter`, { stage: k }); window.alert(r.message ? `Sent by ${r.message.channel === 'sms' ? 'text' : 'email'}${r.message.status === 'sent' ? '' : ' (failed)'}` : 'Recorded — no email or text on file, so print it.'); })}>Send</button>
                <button className="small" disabled={!a?.overdue} title="Print to mail it (recorded as sent)" onClick={() => { window.open(`/collections/${id}/letter?stage=${k}`, '_blank'); run(() => api.post(`/collections/${id}/letter`, { stage: k, send: false })); }}>Print</button>
              </div>
            </div>
          ))}
          <h3>Agency and write-off</h3>
          <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input value={agencyName} onChange={(e) => setAgencyName(e.target.value)} placeholder="Collection agency" style={{ width: 200 }} />
            <button className="small" onClick={() => window.confirm(`Send ${data.account.first_name}'s account to ${agencyName || 'the agency'}?`) && run(() => api.post(`/collections/${id}/agency`, { agency: agencyName }))}>Send to agency</button>
            {admin && <button className="small" onClick={() => window.confirm(`Send to ${agencyName || 'the agency'} and write the patient's balance off as bad debt?`) && run(() => api.post(`/collections/${id}/agency`, { agency: agencyName, write_off: true }))}>Send and write off</button>}
            {admin && <button className="small danger" onClick={() => window.confirm("Write off the patient's balance as bad debt?") && run(() => api.post(`/collections/${id}/write-off`, {}))}>Write off bad debt</button>}
            {data.account.collection_status && <button className="small" onClick={() => run(() => api.post(`/collections/${id}/clear`, {}))}>Take out of collections</button>}
          </div>
        </>
      )}
      <h3>History</h3>
      <table className="compact-table">
        <tbody>
          {data.history.map((x) => <tr key={x.id}><td>{fmtUtcDateTime(x.created_at, practice?.timezone)}</td><td>{STEP[x.action] || label(x.action)}{x.note ? ` — ${x.note}` : ''}</td><td className="num">{x.amount != null ? money(x.amount) : ''}</td><td className="muted">{x.by_name || ''}</td></tr>)}
          {!data.history.length && <tr><td className="muted">Nothing yet.</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}

function ChargesModal({ settings, onClose, onDone }) {
  const { submit, busy, error } = useSubmit(async () => { await api.post('/collections/charges', { post: true }); onDone(); });
  const [p, setP] = useState(null);
  const [e, setE] = useState(null);
  // The preview is the same request without posting.
  useEffect(() => { api.post('/collections/charges', {}).then(setP).catch(setE); }, []);
  return (
    <Modal title="Finance charges & late fees" onClose={onClose}>
      <ErrorBox error={e || error} />
      <p className="muted" style={{ fontSize: 13 }}>
        {settings.finance_charge_bps ? `${settings.finance_charge_bps / 100}% a month of the past-due balance (at least ${money(settings.finance_charge_min)})` : 'No finance charge'}
        {' · '}{settings.late_fee ? `${money(settings.late_fee)} late fee when nothing's been paid for a month` : 'no late fee'}. Each account is charged once a month; accounts at an agency are skipped.
      </p>
      {p && (
        <>
          <table className="compact-table">
            <thead><tr><th>Account</th><th className="num">Past due</th><th className="num">Finance</th><th className="num">Late fee</th></tr></thead>
            <tbody>
              {p.accounts.map((a) => <tr key={a.patient_id}><td>{a.first_name} {a.last_name}</td><td className="num">{money(a.overdue)}</td><td className="num">{money(a.finance_charge)}</td><td className="num">{money(a.late_fee)}</td></tr>)}
              {!p.accounts.length && <tr><td colSpan={4} className="muted">Nothing to charge this month.</td></tr>}
            </tbody>
          </table>
          <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !p.accounts.length} onClick={submit}>Post {money(p.total)}</button></div>
        </>
      )}
    </Modal>
  );
}

function SettingsModal({ settings, onClose, onDone }) {
  const [f, setF] = useState({ pct: (settings.finance_charge_bps || 0) / 100, min: fromCents(settings.finance_charge_min || 0), late: fromCents(settings.late_fee || 0), agency: settings.collection_agency || '' });
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice', { finance_charge_bps: Math.round(Number(f.pct || 0) * 100), finance_charge_min: toCents(f.min || 0), late_fee: toCents(f.late || 0), collection_agency: f.agency });
    onDone();
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Collections settings" onClose={onClose}>
      <ErrorBox error={error} />
      <p className="muted" style={{ fontSize: 13 }}>Check your state’s rules on finance charges and late fees, and say so on your financial policy, before turning them on.</p>
      <div className="form-grid">
        <label>Finance charge (% a month)<input type="number" step="0.1" min="0" max="3" value={f.pct} onChange={set('pct')} /></label>
        <label>Minimum finance charge ($)<input type="number" step="0.01" min="0" value={f.min} onChange={set('min')} /></label>
        <label>Late fee ($)<input type="number" step="0.01" min="0" value={f.late} onChange={set('late')} /></label>
        <label>Collection agency<input value={f.agency} onChange={set('agency')} placeholder="Name, and who to send accounts to" /></label>
      </div>
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={submit}>Save</button></div>
    </Modal>
  );
}
