import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { Meter, mineTone } from './shared.jsx';
import './bonus.css';

// The slim bar above the schedule (BN2): one line per plan the person is in — the team's progress and whether
// they qualify — so everyone knows where they stand without leaving the schedule. Nothing while the module is off,
// switched off for the schedule, or when the person is in no plan. Refreshes when the schedule does (dm:refresh).
export default function BonusBar() {
  const { data, error } = useApi('/bonus/progress');
  if (error || !data?.enabled || !data.show_schedule || !data.plans.length) return null;
  return (
    <div className="bn-bar" role="status" aria-live="polite" aria-label="Team bonus progress">
      <Trophy size={14} aria-hidden="true" className="bn-muted" />
      {data.plans.slice(0, 3).map((v) => (
        <span key={v.plan.id} className="item" title={`${v.plan.name}: ${v.headline}${v.my_line ? ` — ${v.my_line}` : ''}`}>
          <Meter view={v} />
          <span>{v.headline}</span>
          {v.my_line && <span className={`me ${mineTone(v)}`}>· {v.my_line}</span>}
        </span>
      ))}
      <Link to="/bonus">My bonus</Link>
    </div>
  );
}
