import { Link } from 'react-router-dom';
import { Trophy, ArrowRight } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { Meter, mineTone } from './shared.jsx';
import './bonus.css';

// Dashboard card (BN2): the team's progress on each bonus plan the person is in, and their own status —
// "Team goal: $18,400 of $22,000 this month — $3,600 to go · on pace" / "Qualified so far · $120 so far".
// Shows nothing while the module is off, switched off for the dashboard, or when the person is in no plan.
// Never shows anyone else's pay unless the owner made that plan visible to the team (the server decides).
export default function BonusCard() {
  const { data, error } = useApi('/bonus/progress');
  if (error || !data?.enabled || !data.show_dashboard || !data.plans.length) return null;
  return (
    <section className="card bn-card" aria-label="Team bonus">
      <div className="bn-card-head">
        <strong><Trophy size={15} aria-hidden="true" /> Team bonus</strong>
        <Link to="/bonus">My bonus <ArrowRight size={13} aria-hidden="true" /></Link>
      </div>
      {data.plans.map((v) => (
        <div key={v.plan.id} className="bn-plan">
          <span className="name">{v.plan.name}{v.approved ? ' · approved' : ''}</span>
          <span className="headline">{v.headline}</span>
          <Meter view={v} />
          {v.my_line && <span className={`mine ${mineTone(v)}`}>{v.my_line}</span>}
        </div>
      ))}
    </section>
  );
}
