import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtUtcDate, fmtUtcDateTime } from '../format.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox } from './ui.jsx';

// Where a claim is in its electronic journey, in plain language.
export const CH_STATUS = {
  sent: ['Sent', 'info'], received: ['At clearinghouse', 'info'], accepted: ['Accepted by payer', 'ok'], rejected: ['Rejected — fix & resend', 'danger'],
  pending: ['Payer processing', 'warn'], finalized: ['Finalized by payer', 'ok'], paid: ['Paid (ERA)', 'ok'], denied: ['Denied (ERA)', 'danger'],
  request: ['Payer needs info', 'warn'], error: ['Status error', 'danger'],
};
export function ChStatus({ claim }) {
  if (!claim.ch_status) return <span className="muted">—</span>;
  const [text, tone] = CH_STATUS[claim.ch_status] || [claim.ch_status, ''];
  return <span className={`badge nocap ${tone}`} title={claim.ch_message || ''}>{text}</span>;
}

// Sends claims to the clearinghouse when connected, otherwise downloads an 837 file for the portal.
// A claim the payer already has is only resent after the user confirms (resends cause duplicate denials).
export async function sendClaims(ids, connection, resend = false) {
  try {
    return await sendOnce(ids, connection, resend);
  } catch (err) {
    if (resend || !err.details?.already_sent) throw err;
    if (!window.confirm(`${err.message.replace(/ — .*/, '')}.\n\nResending can make the payer deny it as a duplicate. Resend anyway?`)) return null;
    return sendOnce(ids, connection, true);
  }
}

async function sendOnce(ids, connection, resend) {
  const body = { claim_ids: ids, ...(resend ? { resend: true } : {}) };
  if (connection?.batch) return api.post('/claims/submit', body);
  const res = await fetch('/api/claims/837', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { details: err.details });
  }
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `claims-${new Date().toISOString().slice(0, 10)}.837` }).click();
  return null;
}

export const describeResponses = (r) => {
  if (!r) return '';
  const files = r.responses || [];
  const paid = files.filter((f) => f.type === '835').reduce((s, f) => s + (f.result?.posted || 0), 0);
  return files.length ? ` The clearinghouse answered right away: ${files.map((f) => f.type).join(', ')}${paid ? ` · ${paid} paid and posted` : ''}.` : ' Acknowledgments will appear here as they arrive.';
};

// Connection status, mailbox check and recent traffic.
export function ClearinghousePanel({ onChange, version = 0 }) {
  const { can, practice } = useAuth();
  const { data: ch, reload } = useApi('/clearinghouse', [version]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!ch) return null;
  const poll = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/clearinghouse/poll');
      setMsg(r.busy ? 'Another check is already running — try again in a minute.' : r.files.length ? `Processed ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.map((f) => f.type || f.name).join(', ')}.` : 'Nothing new from the clearinghouse.');
      reload();
      onChange?.();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file) => {
    setErr(null);
    try {
      const res = await fetch(`/api/clearinghouse/responses?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'text/plain' }, body: await file.text() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(data.duplicate ? 'That file was already loaded.' : data.error ? `${file.name}: ${data.error}` : `Loaded ${data.type} ${file.name}.`);
      reload();
      onChange?.();
    } catch (e) {
      setErr(e);
    }
  };
  const w = can('billing:write');
  return (
    <div className="card ch-panel">
      <div className="ch-head">
        <div>
          <span className={`live-dot${ch.batch ? ' on' : ''}`} />
          <strong>{ch.name}</strong>
          <span className="muted"> · {ch.batch ? `claims send directly; responses checked every ${ch.poll_minutes} min` : 'download 837 files and upload them in your clearinghouse portal'}{ch.realtime ? ' · real-time eligibility & claim status' : ''}</span>
        </div>
        <div className="inline">
          {w && ch.batch && <button className="small" disabled={busy} onClick={poll}>{busy ? 'Checking…' : 'Check for responses'}</button>}
          {w && !ch.batch && (
            <label className="small-upload">
              Load response file
              <input type="file" accept=".999,.277,.277ca,.835,.txt,.x12,.edi" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
            </label>
          )}
          <button className="small link" onClick={() => setOpen(!open)}>{open ? 'Hide activity' : 'Activity'}</button>
        </div>
      </div>
      <ErrorBox error={err} />
      {msg && <div className="muted" style={{ marginTop: 6 }}>{msg}</div>}
      {ch.needs_attention.length > 0 && (
        <div className="ch-attention">
          <strong>{ch.needs_attention.length} rejected claim{ch.needs_attention.length === 1 ? '' : 's'} to fix and resend:</strong>
          {ch.needs_attention.map((c) => <div key={c.id}><Link to={`/claims/${c.id}`}>#{c.id} {c.first_name} {c.last_name}</Link> — {c.ch_message}</div>)}
        </div>
      )}
      {open && (
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div>
            <h3>Batches sent</h3>
            {ch.batches.length === 0 && <div className="muted">None yet.</div>}
            {ch.batches.map((b) => (
              <div key={b.id} className="ch-row">
                <span>{fmtUtcDate(b.created_at, practice?.timezone)} · {JSON.parse(b.claim_ids).length} claim(s) · #{b.control}</span>
                <span className={`badge ${b.status === 'accepted' ? 'ok' : b.status === 'rejected' ? 'danger' : 'info'}`}>{b.status.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
          <div>
            <h3>Files received</h3>
            {ch.inbox.length === 0 && <div className="muted">None yet.</div>}
            {ch.inbox.map((f) => (
              <div key={f.id} className="ch-row">
                <span>{fmtUtcDate(f.created_at, practice?.timezone)} · <strong>{f.type || '?'}</strong> {f.name}</span>
                <span className={f.error ? 'text-danger' : 'muted'}>{f.error || summarize(f)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const summarize = (f) => {
  const r = f.result ? JSON.parse(f.result) : null;
  if (!r) return '';
  if (f.type === '835') return `${r.posted} paid${r.denied ? `, ${r.denied} denied` : ''}`;
  if (r.status) return r.status.replace(/_/g, ' ');
  if (r.claims) return `${r.claims.length} claim status${r.claims.length === 1 ? '' : 'es'}`;
  return '';
};

// Claim page: status check (276/277) and the claim's electronic timeline.
export function ClaimEdiCard({ claim, onChange }) {
  const { can, practice } = useAuth();
  const { data: events, reload } = useApi(`/claims/${claim.id}/events`);
  const [err, setErr] = useState(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setErr(null);
    setChecking(true);
    try {
      const res = await fetch(`/api/claims/${claim.id}/status-check`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } });
      if ((res.headers.get('content-type') || '').includes('text/plain')) {
        Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `claim-status-${claim.id}.276` }).click();
      } else if (!res.ok) throw new Error((await res.json()).error);
      reload();
      onChange?.();
    } catch (e) {
      setErr(e);
    } finally {
      setChecking(false);
    }
  };
  const canCheck = can('billing:read') && ['submitted', 'partially_paid', 'paid', 'denied'].includes(claim.status);
  if (!events?.length && !canCheck) return null;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Status and history</h2>
        {canCheck && <button className="small" disabled={checking} onClick={check}>{checking ? 'Asking payer…' : 'Check status with payer'}</button>}
      </div>
      <ErrorBox error={err} />
      <ol className="timeline">
        {events?.map((e) => (
          <li key={e.id} className={`tl-${(CH_STATUS[e.status] || [])[1] || 'info'}`}>
            {e.source === 'edit' ? (
              <>
                <div><strong>Edited</strong> <span className="muted">· {e.user_name || 'staff'} · {fmtUtcDateTime(e.created_at, practice?.timezone)}</span></div>
                <ul className="claim-diff">
                  {(e.details || []).map((d, i) => <li key={i}>{d.field}: <del>{d.from ?? '—'}</del> → <ins>{d.to ?? '—'}</ins></li>)}
                </ul>
              </>
            ) : (
              <>
                <div><strong>{(CH_STATUS[e.status] || [e.status])[0]}</strong> <span className="muted">· {e.source} · {fmtUtcDateTime(e.created_at, practice?.timezone)}</span></div>
                {e.message && <div className="muted">{e.message}</div>}
              </>
            )}
          </li>
        ))}
        {!events?.length && <li className="muted">Not sent electronically yet.</li>}
      </ol>
    </div>
  );
}
