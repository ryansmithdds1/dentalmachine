import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Stethoscope } from 'lucide-react';
import { useApi } from '../hooks.js';
import { money } from '../format.js';
import './diagnosis.css';

// DX1: treatment diagnosed at exams today / this week / this month, against the monthly goal — a compact chip for
// the schedule header or the dashboard. With no providerId it shows the signed-in provider's own numbers (their
// login linked to a provider), else the practice's. Renders nothing for people who can't see reports (403) so it
// can be mounted anywhere. The definition is server/src/diagnosis.js (docs/metrics.md).
const whole = (c) => money(c).replace(/\.00$/, '');

export default function DiagnosisChip({ providerId = null, practice = false, refreshMs = 5 * 60_000 }) {
  const q = new URLSearchParams();
  if (providerId) q.set('provider_id', providerId);
  else if (practice) q.set('scope', 'practice');
  const { data, error, reload } = useApi(`/diagnosis/running${q.toString() ? `?${q}` : ''}`);
  useEffect(() => {
    const t = setInterval(reload, refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);
  if (error || !data) return null;
  const [day, week, month] = data.periods;
  const pct = month.goal ? Math.min(100, Math.round((month.diagnosed / month.goal) * 100)) : null;
  const who = data.provider?.name || 'Practice';
  const title = `${who}: treatment diagnosed at exams (office fees). Today ${whole(day.diagnosed)} from ${day.exams} exam${day.exams === 1 ? '' : 's'}; `
    + `this week ${whole(week.diagnosed)}; this month ${whole(month.diagnosed)}${month.goal ? ` of a ${whole(month.goal)} goal so far` : ''}. `
    + `Expected after PPO fees this month: about ${whole(month.expected)}.`;
  return (
    <Link to={`/metrics?tab=diagnosis${data.provider ? `&provider_id=${data.provider.id}` : ''}`} className={`dx-chip${month.standing ? ` ${month.standing}` : ''}`} title={title} aria-label={title}>
      <Stethoscope size={14} aria-hidden="true" />
      <span className="dx-chip-label">Diagnosed</span>
      <span><span className="muted">Today</span> <b>{whole(day.diagnosed)}</b></span>
      <span><span className="muted">Week</span> <b>{whole(week.diagnosed)}</b></span>
      <span>
        <span className="muted">Month</span> <b>{whole(month.diagnosed)}</b>
        {month.goal != null && <span className="muted"> / {whole(month.goal)}</span>}
      </span>
      {pct != null && <span className="dx-chip-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>}
    </Link>
  );
}
