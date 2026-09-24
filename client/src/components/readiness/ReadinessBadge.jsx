import { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Package, PackageX, Hourglass, TriangleAlert, CircleCheck, ClockAlert } from 'lucide-react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';
import './readiness.css';

// Visit readiness on the schedule (LB1/LB5): is the lab case (and every special part) here and checked?
// One small icon per card; the hook loads a day's states once (GET /visit-readiness) for every card on screen,
// and reloads when a check-in or link happens anywhere (live 'readiness' events).
export const READINESS = {
  ready: { Icon: CircleCheck, tone: 'ok', text: 'Ready — lab work and parts are here and checked' },
  arrived: { Icon: PackageCheck, tone: 'info', text: 'Arrived — needs its check' },
  waiting: { Icon: Hourglass, tone: 'muted', text: 'At the lab / on order' },
  late: { Icon: ClockAlert, tone: 'warn', text: 'Late — call the lab' },
  missing: { Icon: PackageX, tone: 'warn', text: 'Not sent, not ordered or not linked' },
  problem: { Icon: TriangleAlert, tone: 'danger', text: 'Problem with the case or parts' },
};
export const ITEM_ICON = { lab_case: Package, part: Package };

// { byAppt: { [appointmentId]: { state, label, count, items } }, reload }
export function useDayReadiness(date, to = null, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const path = enabled && date ? `/visit-readiness?date=${date}${to && to !== date ? `&to=${to}` : ''}` : null;
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api.get(path));
    } catch {
      // The grid keeps working without badges.
      setData(null);
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useLiveEvents((e) => (e.type === 'readiness' || e.type === 'lab_checkin') && load());
  return { byAppt: data?.byAppt || {}, visits: data?.visits || [], reload: load };
}

// The icon on a card. Nothing needed: nothing shown.
export default function ReadinessBadge({ info, onClick, compact = false }) {
  if (!info?.state) return null;
  const r = READINESS[info.state] || READINESS.waiting;
  const lines = (info.items || []).map((i) => `${i.name}: ${i.label}`).join('\n');
  const title = `${r.text}${lines ? `\n${lines}` : ''}`;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`rdy-badge ${r.tone}${compact ? ' compact' : ''}`} title={title} aria-label={title} tabIndex={-1}
      data-state={info.state}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(e); } : undefined}>
      <r.Icon size={11} strokeWidth={2.6} aria-hidden="true" />
    </Tag>
  );
}
