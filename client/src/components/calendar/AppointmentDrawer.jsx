import { useEffect } from 'react';
import { fmtTime, fmtDateTime, money } from '../../format.js';
import { Badge } from '../ui.jsx';

const FLOW = {
  scheduled: [['confirmed', 'Confirm'], ['checked_in', 'Check in']],
  confirmed: [['checked_in', 'Check in']],
  checked_in: [['in_chair', 'Seat']],
  in_chair: [['completed', 'Complete']],
};

// Side panel for one appointment: keeps the calendar visible while the front desk works.
export default function AppointmentDrawer({ appt: a, can, onClose, onStatus, onEdit, onChart, onMove, onToggleAsap, onReminder }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const w = can('schedule:write');
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
        {a.medical_alerts && <div className="error">⚠ {a.medical_alerts}</div>}
        <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge value={a.status} />
          {a.type_name && <span className="badge" style={{ background: `${a.type_color}22`, color: a.type_color }}>{a.type_name}</span>}
          {a.asap ? <span className="badge warn">ASAP</span> : null}
          {a._pending && <span className="muted">Saving…</span>}
        </div>
        {w && active && (
          <div className="drawer-actions">
            {(FLOW[a.status] || []).map(([s, l]) => <button key={s} className="primary" onClick={() => onStatus(s)}>{l}</button>)}
          </div>
        )}
        <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
          <dt>Provider</dt><dd>{a.provider_name}</dd>
          <dt>Chair</dt><dd>{a.operatory_name || '—'}</dd>
          <dt>Phone</dt><dd>{a.phone ? <a href={`tel:${a.phone}`}>{a.phone}</a> : '—'}</dd>
          <dt>Reason</dt><dd>{a.reason || '—'}</dd>
          {a.procedure_summary && (<><dt>Procedures</dt><dd>{a.procedure_summary}</dd></>)}
          <dt>Production</dt><dd>{money(a.production || 0)}</dd>
          <dt>Confirmation</dt>
          <dd>{a.confirmed_at ? `Confirmed ${fmtDateTime(a.confirmed_at.replace('T', ' '))}` : a.reminder_sent_at ? `Reminder sent ${fmtDateTime(a.reminder_sent_at)}` : 'Not reminded yet'}</dd>
          {a.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</dd></>)}
        </dl>
        <div className="drawer-actions">
          <button onClick={onChart}>Open chart</button>
          {w && active && <button onClick={onMove}>Move…</button>}
          {w && active && <button onClick={onEdit}>Edit</button>}
          {w && active && ['scheduled', 'confirmed'].includes(a.status) && <button onClick={onReminder}>Send reminder</button>}
          {w && active && <button onClick={onToggleAsap}>{a.asap ? 'Remove from ASAP' : 'Add to ASAP list'}</button>}
        </div>
        {w && active && (
          <div className="drawer-actions" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <button className="danger" onClick={() => onStatus('no_show')}>No-show</button>
            <button className="danger" onClick={() => confirm('Cancel this appointment?') && onStatus('cancelled')}>Cancel appointment</button>
          </div>
        )}
      </div>
    </aside>
  );
}
