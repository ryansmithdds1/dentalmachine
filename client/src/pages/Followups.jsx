import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtDateTime, label, shiftDate, practiceToday } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';

const OUTCOMES = [['left_voicemail', 'Left voicemail'], ['texted', 'Texted'], ['emailed', 'Emailed'], ['spoke_scheduled', 'Spoke — scheduled'], ['spoke_will_call', 'Spoke — will call back'], ['declined', 'Declined'], ['wrong_number', 'Wrong number'], ['note', 'Note']];
const outcomeLabel = (o) => OUTCOMES.find((x) => x[0] === o)?.[1] || o;

// The front desk's call lists: recall, unscheduled treatment and broken appointments.
export default function Followups() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'recall';
  const { data: unsched, reload: reloadUnsched } = useApi('/followups/unscheduled');
  const { data: broken, reload: reloadBroken } = useApi('/followups/broken');
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Follow-up</h1>
          <div className="muted">Everyone who should be on the schedule but isn&apos;t. Log each call so the whole team sees who was reached.</div>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'recall' ? 'active' : ''} onClick={() => setParams({ tab: 'recall' })}>Recall</button>
        <button className={tab === 'unscheduled' ? 'active' : ''} onClick={() => setParams({ tab: 'unscheduled' })}>Unscheduled treatment {unsched ? <span className="count">{unsched.length}</span> : null}</button>
        <button className={tab === 'broken' ? 'active' : ''} onClick={() => setParams({ tab: 'broken' })}>Broken appointments {broken ? <span className="count">{broken.length}</span> : null}</button>
      </div>
      {tab === 'recall' && <Recall />}
      {tab === 'unscheduled' && <CallList kind="unscheduled" rows={unsched} onChange={reloadUnsched} />}
      {tab === 'broken' && <CallList kind="broken" rows={broken} onChange={reloadBroken} />}
    </>
  );
}

function Recall() {
  const { can, practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [win, setWin] = useState(30);
  const { data: recalls, reload } = useApi(`/recalls?before=${shiftDate(today, win)}&status=due,contacted`);
  const [selected, setSelected] = useState([]);
  const [notice, setNotice] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [bookFor, setBookFor] = useState(null);
  const campaign = async () => {
    const r = await api.post('/recalls/campaign', { recall_ids: selected });
    setNotice(`Sent ${r.sent} recall reminder${r.sent === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped (no phone/email or opted out)` : ''}.`);
    setSelected([]);
    reload();
  };
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={win} onChange={(e) => setWin(Number(e.target.value))} style={{ width: 'auto' }}>
          <option value={0}>Overdue only</option><option value={30}>Due within 30 days</option><option value={60}>Due within 60 days</option><option value={90}>Due within 90 days</option>
        </select>
        {can('schedule:write') && (
          <div className="inline">
            <button onClick={() => setSelected(selected.length === (recalls || []).length ? [] : (recalls || []).map((r) => r.id))}>{selected.length && selected.length === recalls?.length ? 'Clear' : 'Select all'}</button>
            <button className="primary" disabled={!selected.length} onClick={campaign}>Text/email {selected.length || ''} selected</button>
          </div>
        )}
      </div>
      {notice && <div className="public-notice ok" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th /><th>Patient</th><th>Type</th><th>Due</th><th>Phone</th><th>Status</th><th /></tr></thead>
            <tbody>
              {recalls?.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" style={{ width: 'auto' }} checked={selected.includes(r.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} /></td>
                  <td><Link to={`/patients/${r.patient_id}`}>{r.first_name} {r.last_name}</Link></td>
                  <td>{label(r.type)}</td>
                  <td style={{ color: r.due_date < today ? 'var(--danger)' : undefined }}>{fmtDate(r.due_date)}{r.due_date < today ? ' · overdue' : ''}</td>
                  <td>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : '—'}</td>
                  <td><Badge value={r.status} />{r.last_contacted_at && <div className="muted" style={{ fontSize: 11 }}>contacted {fmtDate(r.last_contacted_at)}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('patients:write') && <button className="small" onClick={() => setLogFor({ patient_id: r.patient_id, name: `${r.first_name} ${r.last_name}` })}>Log call</button>}{' '}
                    {can('schedule:write') && <button className="small primary" onClick={() => setBookFor({ patient: { id: r.patient_id, first_name: r.first_name, last_name: r.last_name }, date: r.due_date > today ? r.due_date : today })}>Book</button>}{' '}
                    {can('schedule:write') && <button className="small" title="Inactive — stop recalling this patient" onClick={() => api.put(`/recalls/${r.id}`, { status: 'inactive' }).then(reload)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {recalls?.length === 0 && <div className="empty">Nobody is due. 🎉</div>}
        </div>
      </div>
      {logFor && <LogCall kind="recall" target={logFor} onDone={() => { setLogFor(null); reload(); }} />}
      {bookFor && <BookModal {...bookFor} onDone={() => { setBookFor(null); reload(); }} />}
    </>
  );
}

// Books the patient straight from a list: their planned procedures can be attached in the form.
function BookModal({ patient, date, onDone }) {
  return (
    <Modal title={`Book ${patient.first_name} ${patient.last_name}`} onClose={() => onDone(null)}>
      <AppointmentForm patient={patient} defaults={{ date }} onCancel={() => onDone(null)} onSaved={onDone} />
    </Modal>
  );
}

function CallList({ kind, rows, onChange }) {
  const { can, practice } = useAuth();
  const [logFor, setLogFor] = useState(null);
  const [bookFor, setBookFor] = useState(null);
  const [hidden, setHidden] = useState([]);
  if (!rows) return <div className="empty">Loading…</div>;
  const shown = rows.filter((r) => !hidden.includes(r.patient_id));
  const total = shown.reduce((s, r) => s + (kind === 'unscheduled' ? r.amount : r.planned_amount), 0);
  return (
    <>
      <div className="muted" style={{ marginBottom: 8 }}>{shown.length} patients · {money(total)} in {kind === 'unscheduled' ? 'diagnosed, unscheduled treatment' : 'planned treatment'}</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              {kind === 'unscheduled'
                ? <tr><th>Patient</th><th>Treatment</th><th className="num">Value</th><th>Planned</th><th>Last contact</th><th /></tr>
                : <tr><th>Patient</th><th>Missed</th><th>What happened</th><th className="num">Planned tx</th><th>Last contact</th><th /></tr>}
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.patient_id}-${r.id || ''}`}>
                  <td><Link to={`/patients/${r.patient_id}`}><strong>{r.first_name} {r.last_name}</strong></Link><div className="muted">{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : r.email || 'no phone'}</div></td>
                  {kind === 'unscheduled' ? (
                    <>
                      <td style={{ maxWidth: 280 }}>{r.summary}{r.accepted ? <span className="badge ok" style={{ marginLeft: 6 }}>Accepted</span> : null}</td>
                      <td className="num">{money(r.amount)}</td>
                      <td>{fmtDate(r.planned_since)}</td>
                    </>
                  ) : (
                    <>
                      <td>{fmtDateTime(r.start_time)}<div className="muted">{r.reason} · {r.provider_name}</div></td>
                      <td><Badge value={r.status} /></td>
                      <td className="num">{r.planned_amount ? money(r.planned_amount) : '—'}</td>
                    </>
                  )}
                  <td>{r.last_contact ? <><div>{outcomeLabel(r.last_contact.outcome)}</div><div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.last_contact.created_at)}</div></> : <span className="muted">Never</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('patients:write') && <button className="small" onClick={() => setLogFor({ patient_id: r.patient_id, name: `${r.first_name} ${r.last_name}` })}>Log call</button>}{' '}
                    {can('schedule:write') && <button className="small primary" onClick={() => setBookFor({ patient: { id: r.patient_id, first_name: r.first_name, last_name: r.last_name }, date: practiceToday(practice?.timezone) })}>Book</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">List is clear. 🎉</div>}
        </div>
      </div>
      {logFor && <LogCall kind={kind} target={logFor} onDone={(outcome) => { setLogFor(null); if (outcome === 'declined') setHidden([...hidden, logFor.patient_id]); onChange?.(); }} />}
      {bookFor && <BookModal {...bookFor} onDone={(saved) => { setBookFor(null); if (saved) { setHidden([...hidden, bookFor.patient.id]); onChange?.(); } }} />}
    </>
  );
}

function LogCall({ kind, target, onDone }) {
  const [outcome, setOutcome] = useState('left_voicemail');
  const [note, setNote] = useState('');
  const { data: history } = useApi(`/patients/${target.patient_id}/followups`);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${target.patient_id}/followups`, { kind, outcome, note });
    onDone(outcome);
  });
  return (
    <Modal title={`Log contact — ${target.name}`} onClose={() => onDone(null)}>
      <ErrorBox error={error} />
      <div className="chips" style={{ marginBottom: 10 }}>
        {OUTCOMES.map(([v, l]) => <button key={v} type="button" className={`chip${outcome === v ? ' active' : ''}`} onClick={() => setOutcome(v)}>{l}</button>)}
      </div>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
      <div className="form-actions"><button className="primary" disabled={busy} onClick={submit}>Save</button></div>
      {history?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3>History</h3>
          {history.map((f) => <div key={f.id} className="muted" style={{ fontSize: 12, padding: '3px 0' }}>{fmtDateTime(f.created_at)} · {label(f.kind)} · {outcomeLabel(f.outcome)}{f.note ? ` — ${f.note}` : ''} · {f.created_by_name}</div>)}
        </div>
      )}
    </Modal>
  );
}
