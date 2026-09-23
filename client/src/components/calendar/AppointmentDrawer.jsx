import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { fmtTime, fmtDateTime, fmtUtcDateTime, money, eligibilityBadge } from '../../format.js';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { Badge } from '../ui.jsx';

const FLOW = {
  scheduled: [['checked_in', 'Check in']],
  confirmed: [['checked_in', 'Check in']],
  checked_in: [['in_chair', 'Seat']],
  in_chair: [['completed', 'Complete']],
};

// Side panel for one appointment: keeps the calendar visible while the front desk works.
const CONFIRM = [['phone', 'By phone'], ['text', 'By text'], ['email', 'By email'], ['in_person', 'In person']];
export const CONFIRMED_VIA = { phone: 'by phone', text: 'by text', email: 'by email', in_person: 'in person', portal: 'in the portal', left_message: '' };

// Minutes between two practice-local 'YYYY-MM-DD HH:MM' times.
const mins = (a, b) => (a && b ? Math.round((Date.parse(`${b.replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`)) / 60000) : null);

export default function AppointmentDrawer({ appt: a, can, onClose, onStatus, onEdit, onChart, onMove, onPin, onToggleAsap, onReminder, onCheckout }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const w = can('schedule:write');
  const [series, setSeries] = useState(null);
  useEffect(() => {
    setSeries(null);
    if (a.series_id) api.get(`/appointments/${a.id}`).then((d) => setSeries(d.series)).catch(() => {});
  }, [a.id, a.series_id]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => setConfirmCancel(false), [a.id]);
  const active = !['completed', 'cancelled', 'no_show'].includes(a.status);
  const date = new Date(`${a.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <aside className="drawer" role="dialog" aria-label={`${a.first_name} ${a.last_name}`}>
      <div className="drawer-head" style={{ borderTopColor: a.type_color || a.provider_color }}>
        <div>
          <h2 style={{ margin: 0 }}>{a.first_name} {a.last_name}</h2>
          <div className="muted">{date} · {fmtTime(a.start_time)}–{fmtTime(a.end_time)}</div>
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">
        {a.video_url && <div className="public-notice ok" style={{ marginBottom: 8 }}>📹 Video visit · <a href={a.video_url} target="_blank" rel="noreferrer">Join the call</a></div>}
        {!!a.premed_required && <div className="error"><strong>💊 Premedication required</strong> — confirm it was taken before treatment.</div>}
        {a.medical_alerts && <div className="error">⚠ {a.medical_alerts}</div>}
        <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge value={a.status} />
          {a.type_name && <span className="badge" style={{ background: `${a.type_color}22`, color: a.type_color }}>{a.type_name}</span>}
          {a.asap ? <span className="badge warn">ASAP</span> : null}
          {a.series_id ? <span className="series-chip" title="Recurring visit">↻ {series ? `${series.position} of ${series.total} · every ${series.every > 1 ? `${series.every} ` : ''}${series.unit}${series.every > 1 ? 's' : ''}` : 'Recurring'}</span> : null}
          {a._pending && <span className="muted">Saving…</span>}
        </div>
        {w && active && a.status === 'scheduled' && (
          <div className="drawer-actions">
            <select value="" aria-label="Confirm" onChange={(e) => e.target.value && onStatus(e.target.value === 'left_message' ? 'scheduled' : 'confirmed', null, { confirmed_via: e.target.value })} style={{ width: 'auto' }}>
              <option value="">Confirm…</option>
              {CONFIRM.map(([v, l]) => <option key={v} value={v}>Confirmed {l.toLowerCase()}</option>)}
              <option value="left_message">Left a message</option>
            </select>
          </div>
        )}
        {w && active && (
          <div className="drawer-actions">
            {(FLOW[a.status] || []).map(([s, l]) => {
              // Completing the visit completes its planned procedures too (charges post), for clinical staff.
              if (s === 'completed' && a.procedure_summary && can('clinical:write')) {
                return (
                  <span key={s} className="inline">
                    <button className="primary" title={`Completes ${a.procedure_summary} and posts ${money(a.production || 0)}`} onClick={() => onStatus('completed', null, { complete_procedures: true })}>Complete visit & procedures</button>
                    <button onClick={() => onStatus('completed')} title="Mark the visit done without completing its procedures">Visit only</button>
                  </span>
                );
              }
              return <button key={s} className="primary" onClick={() => onStatus(s)}>{l}</button>;
            })}
            {['checked_in', 'in_chair'].includes(a.status) && onCheckout && <button onClick={onCheckout}>Check out…</button>}
          </div>
        )}
        {a.status === 'completed' && onCheckout && w && (
          <div className="drawer-actions">
            <button className={a.checked_out_at ? '' : 'primary'} onClick={onCheckout}>{a.checked_out_at ? 'Checkout & walkout' : 'Check out…'}</button>
          </div>
        )}
        <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
          <dt>Provider</dt><dd>{a.provider_name}</dd>
          <dt>Chair</dt><dd>{a.operatory_name || '—'}</dd>
          <dt>Phone</dt><dd>{a.phone ? <a href={`tel:${a.phone}`}>{a.phone}</a> : '—'}</dd>
          <dt>Reason</dt><dd>{a.reason || '—'}</dd>
          {a.procedure_summary && (<><dt>Procedures</dt><dd>{a.procedure_summary}</dd></>)}
          <dt>Production</dt><dd>{money(a.production || 0)}</dd>
          {a.eligibility && (() => { const b = eligibilityBadge(a.eligibility); return (<><dt>Insurance</dt><dd><span className={`cal-elig ${b.tone}`}>{b.icon}</span> {b.text} · <Link to={`/patients/${a.patient_id}?tab=insurance`}>{a.eligibility.status === 'active' ? 'details' : 'verify'}</Link></dd></>); })()}
          <dt>Confirmation</dt>
          <dd>
            {a.confirmed_at ? `Confirmed ${CONFIRMED_VIA[a.confirmed_via] || ''} ${fmtDateTime(a.confirmed_at.replace('T', ' '))}` : a.confirmed_via === 'left_message' ? 'Left a message' : a.reminder_sent_at ? `Reminder sent ${fmtDateTime(a.reminder_sent_at)}` : 'Not reminded yet'}
          </dd>
          {a.arrived_at && (
            <>
              <dt>Visit</dt>
              <dd>
                Arrived {fmtTime(a.arrived_at)}{mins(a.start_time, a.arrived_at) > 5 ? <span className="badge warn" style={{ marginLeft: 4 }}>{mins(a.start_time, a.arrived_at)} min late</span> : null}
                {a.seated_at && <> · seated {fmtTime(a.seated_at)} <span className="muted">(waited {Math.max(0, mins(a.arrived_at, a.seated_at))} min)</span></>}
                {a.dismissed_at && <> · out {fmtTime(a.dismissed_at)}{a.seated_at ? <span className="muted"> ({mins(a.seated_at, a.dismissed_at)} min in chair)</span> : null}</>}
              </dd>
            </>
          )}
          {a.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</dd></>)}
        </dl>
        <div className="drawer-actions">
          <button onClick={onChart}>Open chart</button>
          {w && active && <button onClick={onMove}>Move…</button>}
          {w && active && onPin && <button onClick={onPin} title="Park it on the pinboard, then place it on any day">Pin</button>}
          {w && active && <button onClick={onEdit}>Edit</button>}
          {w && active && ['scheduled', 'confirmed'].includes(a.status) && <button onClick={onReminder}>Send reminder</button>}
          {w && active && <button onClick={onToggleAsap}>{a.asap ? 'Remove from ASAP' : 'Add to ASAP list'}</button>}
        </div>
        <ApptHistory id={a.id} />
        {w && active && (
          <div className="drawer-actions" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <button className="danger" onClick={() => onStatus('no_show')}>No-show</button>
            <button className="danger" onClick={() => setConfirmCancel(true)}>Cancel appointment</button>
          </div>
        )}
        {w && active && confirmCancel && (
          <div className="confirm-box">
            <strong>Cancel {a.first_name}&apos;s {fmtTime(a.start_time)} visit?</strong>
            <div className="drawer-actions">
              <button className="danger" onClick={() => onStatus('cancelled')}>{series?.remaining ? 'Only this visit' : 'Yes, cancel it'}</button>
              {series?.remaining > 0 && <button className="danger" onClick={() => onStatus('cancelled', 'following')}>This and {series.remaining} later visit{series.remaining === 1 ? '' : 's'}</button>}
              <button onClick={() => setConfirmCancel(false)}>Keep it</button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

const HISTORY_LABEL = { 'appointment.create': 'Booked', 'appointment.update': 'Changed', 'appointment.status': 'Status', 'appointment.checkout': 'Checked out', 'appointment.family': 'Booked (family)' };
// Who booked, moved and changed this visit, and when.
function ApptHistory({ id }) {
  const tz = useAuth().practice?.timezone;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    setRows(null);
    setOpen(false);
  }, [id]);
  const toggle = async () => {
    setOpen(!open);
    if (!rows) setRows(await api.get(`/appointments/${id}/history`).catch(() => []));
  };
  const describe = (r) => {
    let d = {};
    try {
      d = JSON.parse(r.details || '{}') || {};
    } catch { /* plain text */ }
    if (r.action === 'appointment.status') return `${String(d.from || '').replace('_', ' ')} → ${String(d.to || '').replace('_', ' ')}`;
    if (d.from && d.to) return `moved ${fmtDateTime(d.from)} → ${fmtDateTime(d.to)}`;
    if (d.fields) return d.fields.filter((f) => !['override_blockout', 'scope'].includes(f)).join(', ');
    return '';
  };
  return (
    <div style={{ marginTop: 12 }}>
      <button className="link-button" onClick={toggle}>{open ? 'Hide history' : 'History'}</button>
      {open && (
        <ul className="appt-history">
          {rows?.map((r, i) => <li key={i}><strong>{HISTORY_LABEL[r.action] || r.action}</strong> {describe(r)}<span className="muted"> · {r.user_name || 'patient/system'} · {fmtUtcDateTime(r.created_at, tz)}</span></li>)}
          {rows?.length === 0 && <li className="muted">No changes recorded.</li>}
          {!rows && <li className="muted">Loading…</li>}
        </ul>
      )}
    </div>
  );
}
