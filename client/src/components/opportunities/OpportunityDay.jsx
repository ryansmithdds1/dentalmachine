import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtTime, practiceToday } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { useDayOpportunities } from './OpportunityBadge.jsx';
import OpportunityPanel from './OpportunityPanel.jsx';
import './opportunities.css';

// The morning huddle's opportunity list (OF3): the day's extra production if everything each patient is due for
// is done, what it's made of, and each visit's list — open one to add or decline right there. Below it, how much
// of what was offered this month was accepted and done.
export default function OpportunityDay({ date: given, locationId = null, onOpen, showCapture = true }) {
  const { practice, can } = useAuth() || {};
  const date = given || practiceToday(practice?.timezone);
  const day = useDayOpportunities(date, locationId);
  const [open, setOpen] = useState(null);
  const month = `${date.slice(0, 7)}-01`;
  const capture = useApi(showCapture ? `/opportunities/capture?from=${month}&to=${date}${locationId ? `&location_id=${locationId}` : ''}` : null, [date, locationId]);
  const withOpps = day.visits.filter((v) => v.count);
  const c = capture.data?.totals;
  return (
    <section className="card opp-day" aria-label="Opportunities today">
      <div className="opp-day-head">
        <h3><Sparkles size={16} /> Opportunities</h3>
        {day.totals?.count > 0 && (
          <div className="opp-day-total">
            <strong>{money(day.totals.fee)}</strong>
            <span className="muted">{day.totals.count} {day.totals.count === 1 ? 'item' : 'items'} on {day.totals.visits} of {day.visits.length} {day.visits.length === 1 ? 'visit' : 'visits'}</span>
          </div>
        )}
      </div>
      <ErrorBox error={day.error} />
      {!day.totals && !day.error && <div className="muted opp-empty">Checking today’s patients…</div>}
      {day.by_rule.length > 0 && (
        <div className="opp-day-rules">
          {day.by_rule.map((r) => <span key={r.rule_id} className="opp-chip">{r.name} <b>{r.count}</b> · {money(r.fee)}</span>)}
        </div>
      )}
      {day.totals && !withOpps.length && <div className="muted opp-empty">Nothing extra due for today’s patients.</div>}
      <ul className="opp-day-list">
        {withOpps.map((v) => (
          <li key={v.appointment_id}>
            <button className="opp-day-visit" aria-expanded={open === v.appointment_id} onClick={() => setOpen(open === v.appointment_id ? null : v.appointment_id)}>
              {open === v.appointment_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="opp-day-time">{fmtTime(v.start_time)}</span>
              <span className="opp-day-pt">{v.patient}</span>
              <span className="opp-day-items">{v.items.map((i) => i.name).join(' · ')}</span>
              <span className="opp-fee">{money(v.fee)}</span>
            </button>
            {open === v.appointment_id && (
              <div className="opp-day-panel">
                <OpportunityPanel appointmentId={v.appointment_id} canAdd={!!can?.('clinical:write')} autoFocus title={`${v.patient} · ${v.provider || ''}`} />
                <div className="inline opp-day-links">
                  <Link to={`/patients/${v.patient_id}`}>Open chart</Link>
                  {onOpen && <button className="link" onClick={() => onOpen(v)}>Show on the schedule</button>}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {showCapture && c && c.offered > 0 && (
        <div className="opp-capture muted">
          This month: {c.offered} offered · {c.accepted} added ({c.acceptance ?? 0}%) · {c.done} done · {money(c.done_fee)} produced of {money(c.offered_fee)} offered
        </div>
      )}
    </section>
  );
}
