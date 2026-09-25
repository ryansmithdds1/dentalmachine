import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime, fmtDate, label } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit, AskButton } from '../components/ui.jsx';
import OnlineBookings from '../components/OnlineBookings.jsx';

export default function Requests() {
  const { can, practice } = useAuth();
  // The first tab is every online booking (booked or waiting); the others are the requests waiting for a yes.
  const [params, setParams] = useSearchParams();
  const status = params.get('tab') || 'online';
  const setStatus = (s) => setParams({ tab: s }, { replace: true });
  const { data: requests, reload } = useApi(status === 'online' ? null : `/booking-requests?status=${status}`);
  const { data: messages } = useApi('/messages?limit=50');
  const [accepting, setAccepting] = useState(null);
  const [err, setErr] = useState(null);
  const bookingUrl = practice?.slug ? `${window.location.origin}/book/${practice.slug}` : null;

  // The note to the patient is typed beside Decline (optional); Enter declines.
  const decline = async (b, reason) => {
    setErr(null);
    await api.post(`/booking-requests/${b.id}/decline`, { reason });
    reload();
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Online requests</h1>
          <div className="muted">
            {practice?.online_booking && bookingUrl
              ? <>Patients book at <a href={bookingUrl} target="_blank" rel="noreferrer">{bookingUrl}</a></>
              : 'Online booking is off. Turn it on in Settings → Practice.'}
          </div>
        </div>
      </div>
      <div className="tabs">
        {['online', 'pending', 'accepted', 'declined', 'all'].map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s === 'online' ? 'Online bookings' : label(s)}</button>)}
      </div>
      <ErrorBox error={err} />
      {status === 'online' && <OnlineBookings />}
      <div className="card" style={{ padding: 0, display: status === 'online' ? 'none' : undefined }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Requested time</th><th>Name</th><th>Contact</th><th>Reason</th><th>Provider</th><th>Received</th><th>Status</th><th /></tr></thead>
            <tbody>
              {requests?.map((b) => (
                <tr key={b.id}>
                  <td><strong>{fmtDateTime(b.requested_start)}</strong></td>
                  <td>
                    {b.first_name} {b.last_name}
                    <div className="muted">{b.dob ? `DOB ${b.dob}` : ''} {b.new_patient ? '· New patient' : ''}</div>
                    {b.matches.length > 0 && b.status === 'pending' && <div className="badge warn">Possible existing patient</div>}
                  </td>
                  <td>{b.phone}<div className="muted">{b.email}</div></td>
                  <td>{b.reason}{b.notes && <div className="muted" style={{ maxWidth: 260 }}>“{b.notes}”</div>}{b.referral_source && <div className="muted" style={{ fontSize: 12 }}>Heard about us: {b.referral_source}</div>}{b.source && <div className="muted" style={{ fontSize: 12 }}>Booked from: {b.source === 'google' ? 'Google' : b.source}</div>}</td>
                  <td>{b.provider_name}</td>
                  <td className="muted">{fmtDate(b.created_at)}</td>
                  <td>
                    <Badge value={b.status} />
                    {b.patient_id && <div><Link to={`/patients/${b.patient_id}`}>Open chart</Link></div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {b.status === 'pending' && can('schedule:write') && (
                      <>
                        <button className="small primary" onClick={() => setAccepting(b)}>Accept…</button>{' '}
                        <AskButton className="small danger" danger label="Note to the patient (optional)" placeholder="That day is fully booked." submit="Decline" onSubmit={(reason) => decline(b, reason)}>Decline…</AskButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {requests?.length === 0 && <div className="empty">No {status === 'all' ? '' : status} requests.</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div style={{ padding: '14px 16px' }}><h2 style={{ margin: 0 }}>Recent patient messages</h2></div>
        <MessageTable messages={messages} showPatient />
      </div>

      {accepting && (
        <Modal title={`Accept request from ${accepting.first_name} ${accepting.last_name}`} onClose={() => setAccepting(null)}>
          <AcceptForm request={accepting} onDone={() => { setAccepting(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

function AcceptForm({ request, onDone }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const [patientId, setPatientId] = useState(request.matches[0]?.id ? String(request.matches[0].id) : '');
  const [providerId, setProviderId] = useState(String(request.provider_id || ''));
  const [operatoryId, setOperatoryId] = useState('');
  // The front desk can book a different time or length than the patient asked for.
  const [when, setWhen] = useState({ date: request.requested_start.slice(0, 10), time: request.requested_start.slice(11, 16), duration: request.duration });
  const [result, setResult] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    setResult(await api.post(`/booking-requests/${request.id}/accept`, {
      patient_id: patientId ? Number(patientId) : null, provider_id: Number(providerId), operatory_id: operatoryId ? Number(operatoryId) : null,
      start_time: `${when.date} ${when.time}`, duration: Number(when.duration),
    }));
  });

  if (result) {
    return (
      <div>
        <div className="badge ok" style={{ fontSize: 13, padding: '6px 12px' }}>Booked for {fmtDateTime(result.start_time || `${when.date} ${when.time}`)}</div>
        <p>{result.message ? `Confirmation ${result.message.channel === 'sms' ? 'text' : 'email'} ${result.message.status === 'sent' ? 'sent' : 'failed'} to ${result.message.to_address}.` : 'No confirmation sent (no phone/email).'}</p>
        <div className="form-actions"><button className="primary" onClick={onDone}>Done</button></div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p>Requested <strong>{fmtDateTime(request.requested_start)}</strong> ({request.duration} min) for <em>{request.reason}</em>.</p>
      <div className="form-grid">
        <label className="full">
          Patient record
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">Create new patient: {request.first_name} {request.last_name}</option>
            {request.matches.map((m) => <option key={m.id} value={m.id}>Existing: {m.first_name} {m.last_name} · #{m.id} {m.dob ? `· DOB ${m.dob}` : ''} {m.phone ? `· ${m.phone}` : ''}</option>)}
          </select>
        </label>
        <label>Date<input type="date" required value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} /></label>
        <label>Time<input type="time" required step={300} value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} /></label>
        <label>Length (minutes)<input type="number" min="10" step="5" value={when.duration} onChange={(e) => setWhen({ ...when, duration: e.target.value })} /></label>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Operatory
          <select value={operatoryId} onChange={(e) => setOperatoryId(e.target.value)}>
            <option value="">—</option>
            {operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Book & send confirmation</button></div>
    </form>
  );
}

export function MessageTable({ messages, showPatient }) {
  if (!messages) return <div className="empty">Loading…</div>;
  if (!messages.length) return <div className="empty">No messages yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th>{showPatient && <th>Patient</th>}<th>Type</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.created_at)}</td>
              {showPatient && <td>{m.patient_id ? <Link to={`/patients/${m.patient_id}`}>{m.first_name} {m.last_name}</Link> : '—'}</td>}
              <td>{label(m.kind)}<div className="muted">{m.channel === 'sms' ? 'Text' : 'Email'}</div></td>
              <td className="muted">{m.to_address}</td>
              <td style={{ maxWidth: 420 }}>{m.body}</td>
              <td>
                <span className={`badge ${m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'danger' : m.status === 'blocked' ? 'warn' : 'info'}`}>{m.status}</span>
                {m.provider_id === 'log' && <div className="muted" style={{ fontSize: 11 }}>log only</div>}
                {m.error && <div className="muted" style={{ fontSize: 11 }}>{m.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
