import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { fmtTime, shiftDate } from '../format.js';
import { Modal, Badge } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';

const OPEN = 7;
const CLOSE = 18;
const PX_PER_MIN = 1; // 60px per hour
const minutes = (s) => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));

function practiceToday(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export default function Schedule() {
  const { practice, can } = useAuth();
  const nav = useNavigate();
  const [date, setDate] = useState(() => practiceToday(practice?.timezone || 'America/New_York'));
  const [view, setView] = useState('operatory');
  const [modal, setModal] = useState(null);
  const operatories = useLookup('/operatories?active=true');
  const providers = useLookup('/providers?active=true');
  const { data: appts, reload } = useApi(`/appointments?date=${date}`);

  const columns = view === 'operatory'
    ? [...operatories.map((o) => ({ id: o.id, name: o.name, key: 'operatory_id' })), { id: null, name: 'Unassigned', key: 'operatory_id' }]
    : providers.map((p) => ({ id: p.id, name: p.name, key: 'provider_id', color: p.color }));
  const visibleColumns = columns.filter((c) => c.id !== null || appts?.some((a) => !a.operatory_id));

  const setStatus = async (a, status) => {
    await api.patch(`/appointments/${a.id}/status`, { status });
    setModal(null);
    reload();
  };

  const hours = Array.from({ length: CLOSE - OPEN }, (_, i) => OPEN + i);
  const dayLabel = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Schedule</h1>
          <div className="muted">{dayLabel} · {appts?.length ?? 0} appointments</div>
        </div>
        <div className="actions">
          <button onClick={() => setDate(shiftDate(date, -1))}>←</button>
          <button onClick={() => setDate(practiceToday(practice.timezone))}>Today</button>
          <button onClick={() => setDate(shiftDate(date, 1))}>→</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160 }} />
          <select value={view} onChange={(e) => setView(e.target.value)} style={{ width: 150 }}>
            <option value="operatory">By operatory</option>
            <option value="provider">By provider</option>
          </select>
          {can('schedule:write') && <button className="primary" onClick={() => setModal({ type: 'new', defaults: { date } })}>+ New appointment</button>}
        </div>
      </div>

      <div className="schedule" style={{ gridTemplateColumns: `64px repeat(${visibleColumns.length}, minmax(170px, 1fr))` }}>
        <div className="schedule-col-head" />
        {visibleColumns.map((c) => (
          <div key={`${c.key}-${c.id}`} className="schedule-col-head" style={c.color ? { borderBottom: `3px solid ${c.color}` } : undefined}>{c.name}</div>
        ))}
        <div className="schedule-times">
          {hours.map((h) => <div key={h} className="schedule-time">{fmtTime(`0000-00-00 ${String(h).padStart(2, '0')}:00`)}</div>)}
        </div>
        {visibleColumns.map((c) => (
          <div key={`${c.key}-${c.id}`} className="schedule-col">
            {hours.flatMap((h) => [0, 30].map((m) => (
              <div key={`${h}-${m}`} className="schedule-slot"
                onClick={() => can('schedule:write') && setModal({
                  type: 'new',
                  defaults: { date, time: `${String(h).padStart(2, '0')}:${m ? '30' : '00'}`, [c.key]: c.id },
                })} />
            )))}
            {appts?.filter((a) => (a[c.key] ?? null) === c.id).map((a) => {
              const top = (minutes(a.start_time) - OPEN * 60) * PX_PER_MIN;
              const height = Math.max(22, (minutes(a.end_time) - minutes(a.start_time)) * PX_PER_MIN - 2);
              return (
                <div key={a.id} className="appt" onClick={() => setModal({ type: 'view', appt: a })}
                  style={{ top, height, background: `${a.provider_color}22`, borderLeftColor: a.provider_color, opacity: a.status === 'completed' ? 0.6 : 1 }}>
                  <strong>{a.medical_alerts ? '⚠ ' : ''}{a.first_name} {a.last_name}</strong>
                  <div className="appt-meta">{fmtTime(a.start_time)}–{fmtTime(a.end_time)} · {view === 'operatory' ? a.provider_name : a.operatory_name}</div>
                  {height > 50 && <div className="appt-meta">{a.reason}</div>}
                  {height > 66 && <Badge value={a.status} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {modal?.type === 'new' && (
        <Modal title="New appointment" onClose={() => setModal(null)}>
          <AppointmentForm defaults={modal.defaults} onCancel={() => setModal(null)} onSaved={(a) => { setModal(null); setDate(a.start_time.slice(0, 10)); reload(); }} />
        </Modal>
      )}
      {modal?.type === 'edit' && (
        <Modal title="Edit appointment" onClose={() => setModal(null)}>
          <AppointmentForm appointment={modal.appt} onCancel={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal?.type === 'view' && (
        <Modal title={`${modal.appt.first_name} ${modal.appt.last_name}`} onClose={() => setModal(null)}>
          {modal.appt.medical_alerts && <div className="error">⚠ Medical alert: {modal.appt.medical_alerts}</div>}
          <dl className="kv">
            <dt>When</dt><dd>{fmtTime(modal.appt.start_time)} – {fmtTime(modal.appt.end_time)}</dd>
            <dt>Provider</dt><dd>{modal.appt.provider_name}</dd>
            <dt>Operatory</dt><dd>{modal.appt.operatory_name || '—'}</dd>
            <dt>Reason</dt><dd>{modal.appt.reason || '—'}</dd>
            <dt>Phone</dt><dd>{modal.appt.phone || '—'}</dd>
            <dt>Status</dt><dd><Badge value={modal.appt.status} /></dd>
            {modal.appt.notes && (<><dt>Notes</dt><dd>{modal.appt.notes}</dd></>)}
          </dl>
          <div className="form-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
            <button onClick={() => nav(`/patients/${modal.appt.patient_id}`)}>Open chart</button>
            {can('schedule:write') && (
              <>
                <button onClick={() => setModal({ type: 'edit', appt: modal.appt })}>Edit / reschedule</button>
                {modal.appt.status === 'scheduled' && <button onClick={() => setStatus(modal.appt, 'confirmed')}>Confirm</button>}
                {['scheduled', 'confirmed'].includes(modal.appt.status) && <button className="primary" onClick={() => setStatus(modal.appt, 'checked_in')}>Check in</button>}
                {modal.appt.status === 'checked_in' && <button className="primary" onClick={() => setStatus(modal.appt, 'in_chair')}>Seat patient</button>}
                {['checked_in', 'in_chair'].includes(modal.appt.status) && <button className="primary" onClick={() => setStatus(modal.appt, 'completed')}>Complete</button>}
                {!['completed', 'cancelled', 'no_show'].includes(modal.appt.status) && (
                  <>
                    <button className="danger" onClick={() => setStatus(modal.appt, 'no_show')}>No-show</button>
                    <button className="danger" onClick={() => confirm('Cancel this appointment?') && setStatus(modal.appt, 'cancelled')}>Cancel appt</button>
                  </>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
