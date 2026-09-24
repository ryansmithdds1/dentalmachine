import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { fmtTime, fmtDateTime, fmtUtcDateTime, money, eligibilityBadge } from '../../format.js';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { Badge } from '../ui.jsx';
import { nextKind, NEXT_LABEL, READY_LABEL, STEP_KEYS, postsCharges } from './flow.js';
import BrokenPicker, { brokenLabel } from './BrokenPicker.jsx';
import './workflow.css';
import OpportunityPanel from '../opportunities/OpportunityPanel.jsx';

// Side panel for one appointment: keeps the calendar visible while the front desk works.
const CONFIRM = [['phone', 'By phone'], ['text', 'By text'], ['email', 'By email'], ['in_person', 'In person']];
export const CONFIRMED_VIA = { phone: 'by phone', text: 'by text', email: 'by email', in_person: 'in person', portal: 'in the portal', left_message: '' };

// Minutes between two practice-local 'YYYY-MM-DD HH:MM' times.
const mins = (a, b) => (a && b ? Math.round((Date.parse(`${b.replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`)) / 60000) : null);

export default function AppointmentDrawer({ appt: a, can, onClose, onStatus, onStep, focusComplete = 0, brokenAsk = null, onBroken, onEdit, onChart, onMove, onPin, onToggleAsap, onReminder, onCheckout, focusOpportunities = 0, onOpportunitiesChanged }) {
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
  // Cancel or no-show: the reason picker ('cancelled' | 'no_show'), opened here or by X / Shift+X on the schedule.
  const [asking, setAsking] = useState(null);
  useEffect(() => setAsking(null), [a.id]);
  useEffect(() => { if (brokenAsk) setAsking(brokenAsk.kind); }, [brokenAsk?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = !['completed', 'cancelled', 'no_show'].includes(a.status);
  const date = new Date(`${a.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  // The next step of the visit, one click from the top of the panel (the same as its key on the schedule).
  const next = w && active ? nextKind(a) : null;
  const charges = postsCharges(a, can('clinical:write'));
  // "O" on a visit that would post charges lands here, on the button that does it.
  const completeRef = useRef(null);
  useEffect(() => { if (focusComplete) completeRef.current?.focus(); }, [focusComplete]);
  const completeWithProcedures = (
    <button ref={completeRef} className="primary" title={`Completes ${a.procedure_summary} and posts ${money(a.production || 0)}`} onClick={() => onStatus('completed', null, { complete_procedures: true })}>Complete visit & procedures</button>
  );
  const kbd = (k) => <kbd>{k.replace('shift+', '⇧').toUpperCase()}</kbd>;

  return (
    <aside className="drawer" role="dialog" aria-label={`${a.first_name} ${a.last_name}`}>
      <div className="drawer-head" style={{ borderTopColor: a.type_color || a.provider_color }}>
        <div>
          <h2 style={{ margin: 0 }}>{a.first_name} {a.last_name}</h2>
          <div className="muted">{date} · {fmtTime(a.start_time)}–{fmtTime(a.end_time)}</div>
          {next && (
            <div className="drawer-next">
              {next === 'out' && charges ? completeWithProcedures : (
                <button className="primary" onClick={() => onStep(next)} title={`Next step (${STEP_KEYS[next].toUpperCase()} on the schedule)`}>{NEXT_LABEL[next]}{kbd(STEP_KEYS[next])}</button>
              )}
            </div>
          )}
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">
        {a.video_url && <div className="public-notice ok" style={{ marginBottom: 8 }}>📹 Video visit · <a href={a.video_url} target="_blank" rel="noreferrer">Join the call</a></div>}
        {!!a.premed_required && <div className="error"><strong>💊 Premedication required</strong> — confirm it was taken before treatment.</div>}
        {a.medical_alerts && <div className="error">⚠ {a.medical_alerts}</div>}
        <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge value={a.status} />
          {a.status === 'in_chair' && a.ready_for && <span className="badge ready-badge">{READY_LABEL[a.ready_for]}</span>}
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
          <>
          <div className="drawer-actions">
            {a.status === 'in_chair' && (
              <>
                {/* Ready for the doctor's exam or for checkout; pressing the lit one clears it. */}
                <button className={a.ready_for === 'doctor' ? 'active' : ''} aria-pressed={a.ready_for === 'doctor'} onClick={() => onStep('ready')}>{READY_LABEL.doctor}{kbd(STEP_KEYS.ready)}</button>
                <button className={a.ready_for === 'checkout' ? 'active' : ''} aria-pressed={a.ready_for === 'checkout'} onClick={() => onStep('ready_checkout')}>{READY_LABEL.checkout}{kbd(STEP_KEYS.ready_checkout)}</button>
                {/* Completing the visit completes its planned procedures too (charges post), for clinical staff. */}
                {charges && next !== 'out' && completeWithProcedures}
                {charges && <button onClick={() => onStatus('completed')} title="Mark the visit done without completing its procedures">Visit only</button>}
                {!charges && next !== 'out' && <button onClick={() => onStep('out')}>Out · visit complete{kbd(STEP_KEYS.out)}</button>}
              </>
            )}
            {['checked_in', 'in_chair'].includes(a.status) && onCheckout && <button onClick={onCheckout}>Check out…</button>}
            {a.status === 'checked_in' && <ReadyText appt={a} />}
          </div>
          {a.status === 'checked_in' && a.checked_in_via && <div className="muted" style={{ fontSize: 12, marginTop: -4 }}>Checked in {a.checked_in_via === 'qr' ? 'with the QR code' : 'by text'}{a.arrived_at ? ` at ${a.arrived_at.slice(11, 16)}` : ''}</div>}
          </>
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
        {can('clinical:read') && <OpportunityPanel appointmentId={a.id} canAdd={can('clinical:write') && !['cancelled', 'no_show'].includes(a.status)} autoFocus={focusOpportunities} onChanged={onOpportunitiesChanged} />}
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
            <button className={`danger${asking === 'no_show' ? ' active' : ''}`} onClick={() => setAsking('no_show')} title="No-show (Shift+X on the schedule)">No-show{kbd('shift+x')}</button>
            <button className={`danger${asking === 'cancelled' ? ' active' : ''}`} onClick={() => setAsking('cancelled')} title="Cancel (X on the schedule)">Cancel appointment{kbd('x')}</button>
          </div>
        )}
        {w && active && asking && onBroken && (
          <BrokenPicker appt={a} kind={asking} series={series} onClose={() => setAsking(null)}
            onDone={(choice) => onBroken(asking, { ...choice, scope: choice.scope === 'following' ? 'following' : null })} />
        )}
        {['cancelled', 'no_show'].includes(a.status) && a.broken_reason && (
          <div className="muted" style={{ marginTop: 10 }}>{a.status === 'no_show' ? 'Missed' : 'Cancelled'}: {brokenLabel(a.broken_reason)}{a.broken_note ? ` — ${a.broken_note}` : ''}</div>
        )}
      </div>
    </aside>
  );
}

const HISTORY_LABEL = { 'appointment.ready': 'Ready', 'appointment.create': 'Booked', 'appointment.update': 'Changed', 'appointment.status': 'Status', 'appointment.checkout': 'Checked out', 'appointment.family': 'Booked (family)' };
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
    const undo = d.undo ? ' (undo)' : '';
    if (r.action === 'appointment.status') return `${String(d.from || '').replace('_', ' ')} → ${String(d.to || '').replace('_', ' ')}${undo}`;
    if (r.action === 'appointment.ready') return `${d.to ? READY_LABEL[d.to].toLowerCase() : 'not ready'}${undo}`;
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

// For patients waiting in the car: one tap texts them to come in.
function ReadyText({ appt }) {
  const [state, setState] = useState(appt.ready_texted_at ? 'Texted' : null);
  return (
    <button disabled={!!state && state !== 'Try again'} onClick={async () => {
      setState('Sending…');
      try {
        const r = await api.post(`/appointments/${appt.id}/ready-text`, {});
        setState(r.status === 'sent' ? 'Texted' : 'Try again');
      } catch { setState('Try again'); }
    }}>{state === 'Texted' ? '✓ Texted “we’re ready”' : state || 'Text “we’re ready”'}</button>
  );
}
