import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { money, fmtDate } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';

// Outside financing (CareCredit, Sunbit, Cherry…): send the application, follow it, post the money.
const STATUS = { sent: ['', 'Sent'], started: ['warn', 'Started'], approved: ['ok', 'Approved'], declined: ['danger', 'Declined'], funded: ['ok', 'Funded'], cancelled: ['', 'Cancelled'], expired: ['', 'Expired'] };

export default function Financing({ patient, canWrite, onChange }) {
  const { data: apps, reload } = useApi(`/patients/${patient.id}/financing`);
  const { data: meta } = useApi('/financing/lenders');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(null);
  const ready = (meta?.lenders || []).filter((l) => l.link);
  if (!apps || !meta) return null;
  if (!apps.length && !ready.length) return null;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Financing</h2>
        {canWrite && ready.length > 0 && <button className="small" onClick={() => setSending(true)}>Send an application</button>}
      </div>
      {apps.length === 0 ? <div className="muted" style={{ marginTop: 6 }}>No applications yet.</div> : (
        <table className="compact-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Sent</th><th>Lender</th><th className="num">Amount</th><th>Status</th><th>Plan</th><th /></tr></thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td>{fmtDate(a.created_at.slice(0, 10))}</td>
                <td>{meta.lenders.find((l) => l.key === a.lender)?.name || a.lender}</td>
                <td className="num">{money(a.amount)}{a.approved_amount ? <div className="muted" style={{ fontSize: 11 }}>approved {money(a.approved_amount)}</div> : null}</td>
                <td><span className={`badge ${STATUS[a.status]?.[0] || ''}`}>{STATUS[a.status]?.[1] || a.status}</span>{a.funded_amount ? <div className="muted" style={{ fontSize: 11 }}>{money(a.funded_amount)} posted</div> : null}</td>
                <td className="muted" style={{ fontSize: 12 }}>{a.plan || ''}</td>
                <td>{canWrite && a.status !== 'funded' && <button className="small" onClick={() => setEditing(a)}>Update</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sending && <SendForm patient={patient} lenders={ready} onDone={() => { setSending(false); reload(); }} />}
      {editing && <UpdateForm app={editing} onDone={() => { setEditing(null); reload(); onChange?.(); }} />}
    </div>
  );
}

function SendForm({ patient, lenders, onDone }) {
  const [f, setF] = useState({ lender: lenders[0].key, amount: '', channel: 'sms' });
  const send = useSubmit(async () => { await api.post(`/patients/${patient.id}/financing`, f); onDone(); });
  return (
    <Modal title="Send a financing application" onClose={onDone}>
      <ErrorBox error={send.error} />
      <div className="form-grid">
        <label>Lender<select value={f.lender} onChange={(e) => setF({ ...f, lender: e.target.value })}>{lenders.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select></label>
        <label>Amount ($)<input type="number" min="1" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label>Send by<select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="sms">Text</option><option value="email">Email</option><option value="">Don’t send (in office)</option></select></label>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{lenders.find((l) => l.key === f.lender)?.note}</div>
      <div className="form-actions"><button onClick={onDone}>Cancel</button><button className="primary" disabled={!f.amount || send.busy} onClick={send.submit}>Send</button></div>
    </Modal>
  );
}

function UpdateForm({ app, onDone }) {
  const [f, setF] = useState({ status: app.status === 'approved' ? 'funded' : 'approved', approved_amount: app.approved_amount ? app.approved_amount / 100 : app.amount / 100, funded_amount: (app.approved_amount || app.amount) / 100, plan: app.plan || '', external_id: app.external_id || '' });
  const save = useSubmit(async () => { await api.put(`/financing/applications/${app.id}`, f); onDone(); });
  return (
    <Modal title="Update from the lender" onClose={onDone}>
      <ErrorBox error={save.error} />
      <div className="form-grid">
        <label>Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {f.status === 'approved' && <label>Approved for ($)<input type="number" value={f.approved_amount} onChange={(e) => setF({ ...f, approved_amount: e.target.value })} /></label>}
        {f.status === 'funded' && <label>Amount funded ($)<input type="number" value={f.funded_amount} onChange={(e) => setF({ ...f, funded_amount: e.target.value })} /></label>}
        <label>Plan (e.g. 12 months 0%)<input value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} /></label>
        <label>Lender’s account / reference<input value={f.external_id} onChange={(e) => setF({ ...f, external_id: e.target.value })} /></label>
      </div>
      {f.status === 'funded' && <div className="muted" style={{ fontSize: 12 }}>Funding posts a payment to the ledger.</div>}
      <div className="form-actions"><button onClick={onDone}>Cancel</button><button className="primary" disabled={save.busy} onClick={save.submit}>Save</button></div>
    </Modal>
  );
}
