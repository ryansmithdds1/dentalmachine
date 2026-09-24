// A compact capacity meter for the Today screen and the huddle: one line per kind of provider (status, how full
// the next 4 weeks are, the longest wait against its target) and the most urgent recommendation. The full page is
// /capacity. Shown only to people who can see the schedule; quiet when the request fails.
import { Link } from 'react-router-dom';
import { Gauge, ArrowRight, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import '../pages/capacity.css';

// Shared with the Capacity page.
export const STATUS = {
  green: { label: 'On target', Icon: CheckCircle2 },
  amber: { label: 'Watch', Icon: AlertTriangle },
  red: { label: 'Act now', Icon: XCircle },
  none: { label: 'No providers', Icon: Info },
};
export function StatusPill({ status, children }) {
  const s = STATUS[status] || STATUS.none;
  return <span className={`cap-pill ${status}`}><s.Icon size={13} aria-hidden="true" />{children || s.label}</span>;
}
export const waitText = (days, unit = 'days') => {
  if (days == null) return 'none soon';
  if (days === 0) return 'today';
  if (unit === 'business days') return days === 1 ? 'next day' : `${days} work days`;
  if (days >= 14) return `${Math.round(days / 7)} wk`;
  return `${days} day${days === 1 ? '' : 's'}`;
};

const SEV = { green: 0, none: 0, amber: 1, red: 2 };

export default function CapacityWidget({ locationId = null }) {
  const { can } = useAuth();
  const { data, error } = useApi(can('schedule:read') ? `/capacity${locationId ? `?location_id=${locationId}` : ''}` : null);
  if (!can('schedule:read') || error || !data) return null;
  const top = data.recommendations[0];
  return (
    <section className="card cap-widget" aria-label="Capacity">
      <div className="cap-widget-head">
        <strong><Gauge size={15} aria-hidden="true" /> Capacity</strong>
        <Link to="/capacity">Open <ArrowRight size={13} aria-hidden="true" /></Link>
      </div>
      {['doctor', 'hygiene'].map((k) => {
        const kk = data.kinds[k];
        if (!kk.provider_ids.length) return null;
        // The meter furthest from its target.
        const m = Object.values(kk.openings).sort((a, b) => SEV[b.status] - SEV[a.status] || (b.days ?? 999) - (a.days ?? 999))[0];
        return (
          <div key={k} className="cap-widget-row">
            <StatusPill status={kk.status}>{kk.label}</StatusPill>
            <span>{kk.booked.w4.pct == null ? '—' : `${Math.round(kk.booked.w4.pct)}%`} booked · 4 wk</span>
            {m && <span className="muted">{m.label}: {waitText(m.days, m.unit)}</span>}
          </div>
        );
      })}
      {top && <div className={`cap-widget-rec ${top.severity}`}>{top.text}</div>}
    </section>
  );
}
