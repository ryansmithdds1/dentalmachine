import { Link } from 'react-router-dom';
import { useApi } from '../../hooks.js';
import { useLiveEvents } from '../../live.js';
import './referrals.css';

// Morning huddle card: critical referrals not seen yet (every day until they are), and open referrals of the
// patients coming in today (ask them whether they've been seen). Nothing when there's nothing to say.
export default function ReferralHuddle({ date }) {
  const { data: h, reload } = useApi(`/referral-tracker/huddle${date ? `?date=${date}` : ''}`, [date]);
  useLiveEvents((e) => ['referrals', 'referral_alert'].includes(e.type) && reload());
  if (!h || (!h.critical.length && !h.on_schedule.length && !h.reports_to_review)) return null;
  const line = (x) => (
    <li key={x.id}>
      <Link to={`/referrals?patient=${x.patient_id}`}>{x.first_name} {x.last_name}</Link> → {x.contact_name}
      <span className="muted"> · {x.status_label}{x.days_open != null ? ` · ${x.days_open} days` : ''}{x.reason ? ` · ${x.reason}` : ''}</span>
    </li>
  );
  const onDay = h.on_schedule.filter((x) => !x.alerting);
  return (
    <div className="card rt-huddle">
      <div className="rt-huddle-head"><strong>Referrals</strong><Link to="/referrals?view=critical" className="small">Open the board</Link></div>
      {h.critical.length > 0 && <><div className="rt-huddle-sub critical">Critical, not seen yet</div><ul>{h.critical.map(line)}</ul></>}
      {onDay.length > 0 && <><div className="rt-huddle-sub">Coming in today — ask how the referral went</div><ul>{onDay.map(line)}</ul></>}
      {h.reports_to_review > 0 && <div className="muted small"><Link to="/referrals?view=awaiting">{h.reports_to_review} specialist report{h.reports_to_review === 1 ? '' : 's'} to confirm or review</Link></div>}
    </div>
  );
}
