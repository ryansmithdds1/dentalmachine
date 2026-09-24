import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useLiveEvents } from '../live.js';
import { useRemembered } from '../prefs.js';
import { fmtDateTime, fmtUtcDateTime, label } from '../format.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox } from './ui.jsx';

// OS4: every online booking in one place — today, this week or the last 30 days — with who, what, when,
// new or existing, insurance, where it came from and anything that needs a person. Live: a booking made on the
// website appears here the moment it's made. "Seen" tells the rest of the team someone has looked at it.
const RANGES = [['today', 'Today'], ['week', 'This week'], ['month', 'Last 30 days']];
const INSURANCE = { none: 'None given', on_file: 'On file', to_verify: 'Typed — verify', card_photo: 'Card photo — read & confirm' };
const STATUS = { booked: 'ok', requested: 'warn', awaiting_deposit: 'info', declined: 'danger', cancelled: 'danger' };
const QUIET = new Set(['family', 'deposit_paid', 'card_on_file']);

export const sourceText = (b) => [b.source && b.source !== 'direct' ? label(b.source) : 'Direct', b.utm_source && b.utm_source !== b.source ? `utm ${b.utm_source}${b.utm_medium ? `/${b.utm_medium}` : ''}` : null,
  b.utm_campaign ? `“${b.utm_campaign}”` : null, b.referrer_host ? `from ${b.referrer_host}` : null].filter(Boolean).join(' · ');

export default function OnlineBookings() {
  const { practice } = useAuth();
  const [range, setRange] = useState('today');
  const { data, error, reload } = useApi(`/online-scheduling/bookings?range=${range}`);
  const [sound, setSound] = useRemembered('onlinebooking.sound', true);
  const [err, setErr] = useState(null);
  useLiveEvents((e) => { if (e.type === 'online_booking') reload(); });

  const seen = async (b) => {
    setErr(null);
    try {
      await api.post(`/online-scheduling/bookings/${b.id}/seen`);
      reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="inline" style={{ padding: '12px 16px', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div className="inline" style={{ gap: 6 }} role="group" aria-label="Which bookings">
          {RANGES.map(([k, l]) => <button key={k} type="button" className={`chip${range === k ? ' active' : ''}`} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        <div className="inline" style={{ gap: 12 }}>
          {data && <span className="muted">{data.bookings.length} booking{data.bookings.length === 1 ? '' : 's'}{data.needs_person ? ` · ${data.needs_person} need a person` : ''}</span>}
          <button type="button" className="icon-btn small" aria-pressed={!!sound} onClick={() => setSound(!sound)}
            title={sound ? 'Sound on for new online bookings (just for you) — turn off' : 'Play a soft sound for new online bookings (just for you)'}>
            {sound ? <Bell size={15} /> : <BellOff size={15} />}
          </button>
        </div>
      </div>
      <ErrorBox error={error || err} />
      <div className="table-wrap">
        <table className="online-bookings">
          <thead><tr><th>Booked</th><th>Who</th><th>Visit</th><th>When</th><th>Insurance</th><th>Needs a person</th><th>Source</th><th /></tr></thead>
          <tbody>
            {data?.bookings.map((b) => {
              const needs = b.flags.map((f, i) => [f, b.flag_labels[i]]).filter(([f]) => !QUIET.has(f));
              return (
                <tr key={b.id} className={b.seen_at ? '' : 'unseen'} style={b.seen_at ? undefined : { background: 'var(--primary-soft)' }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtUtcDateTime(b.created_at, practice?.timezone)}<div><span className={`badge ${STATUS[b.status] || ''}`}>{b.status === 'awaiting_deposit' ? 'paying deposit' : b.status}</span></div></td>
                  <td>
                    {b.people.map((p) => (
                      <div key={p.id}>
                        {p.patient_id ? <Link to={`/patients/${p.patient_id}`}>{p.first_name} {p.last_name}</Link> : <span>{p.first_name} {p.last_name}</span>}
                        {' '}<span className={`badge ${p.new_patient ? 'info' : ''}`}>{p.new_patient ? 'New' : 'Existing'}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {b.urgent && <span className="badge danger" title="Emergency triage answers crossed the urgent line"><AlertTriangle size={12} /> Urgent</span>} {b.type_label}
                    {b.triage && <div className="muted" style={{ fontSize: 12 }}>{Object.entries(b.triage).map(([k, v]) => `${k}: ${v === true ? 'yes' : v === false ? 'no' : v}`).join(' · ')}</div>}
                    {b.location_name && <div className="muted" style={{ fontSize: 12 }}>{b.location_name}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(b.first_start)}<div className="muted" style={{ fontSize: 12 }}>{b.people[0]?.provider_name}{b.asap ? ' · wants sooner' : ''}</div></td>
                  <td>{INSURANCE[b.insurance_status] || '—'}</td>
                  <td>{needs.length ? needs.map(([f, l]) => <div key={f} className={`badge ${f === 'urgent' ? 'danger' : 'warn'}`} style={{ marginBottom: 2 }}>{l}</div>) : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{sourceText(b)}</td>
                  <td>{b.seen_at ? <span className="muted" style={{ fontSize: 12 }}>Seen</span> : <button type="button" className="small" onClick={() => seen(b)}>Seen</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data?.bookings.length === 0 && <div className="empty">No online bookings {range === 'today' ? 'yet today' : range === 'week' ? 'this week' : 'in the last 30 days'}.</div>}
        {!data && !error && <div className="empty">Loading…</div>}
      </div>
    </div>
  );
}
