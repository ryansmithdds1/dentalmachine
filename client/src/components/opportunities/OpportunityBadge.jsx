import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../api.js';
import './opportunities.css';

// Opportunity finder (OF3) on the schedule: a small "3 · $184" chip for an appointment card, and the hook that
// loads a day's opportunities (GET /schedule/opportunities) once for every card, column and the huddle.
// Changes made in the panel (added, declined, undone) announce themselves with the 'dm:opportunities' event,
// so every badge on screen updates without a reload.
export const OPPORTUNITIES_CHANGED = 'dm:opportunities';
export const announceOpportunities = (detail = {}) => window.dispatchEvent(new CustomEvent(OPPORTUNITIES_CHANGED, { detail }));

// Whole dollars, compact: $184, $1.2k.
export const shortMoney = (cents) => {
  const d = Math.round((cents || 0) / 100);
  return d >= 10000 ? `$${Math.round(d / 1000)}k` : d >= 1000 ? `$${(d / 1000).toFixed(1).replace(/\.0$/, '')}k` : `$${d}`;
};

// { byAppt: { [appointmentId]: { count, fee, items } }, totals, by_provider, by_operatory, by_rule, visits, loading, reload }
export function useDayOpportunities(date, locationId = null, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: false });
  const path = enabled && date ? `/schedule/opportunities?date=${date}${locationId ? `&location_id=${locationId}` : ''}` : null;
  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await api.get(path), error: null, loading: false });
    } catch (error) {
      // Shown by the huddle; on the schedule a missing badge is the only sign (the grid keeps working).
      setState({ data: null, error, loading: false });
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener(OPPORTUNITIES_CHANGED, load);
    window.addEventListener('dm:refresh', load);
    return () => { window.removeEventListener(OPPORTUNITIES_CHANGED, load); window.removeEventListener('dm:refresh', load); };
  }, [load]);
  const d = state.data;
  return {
    byAppt: Object.fromEntries((d?.visits || []).map((v) => [v.appointment_id, v])),
    visits: d?.visits || [], totals: d?.totals || null, by_provider: d?.by_provider || {}, by_operatory: d?.by_operatory || {}, by_rule: d?.by_rule || [],
    error: state.error, loading: state.loading, reload: load,
  };
}

// The chip on a card. Nothing to offer: nothing shown. Clicking it (or Enter on it) opens the visit's list; it
// stops the click reaching the card underneath.
export default function OpportunityBadge({ count, fee, onClick, compact = false, title }) {
  if (!count) return null;
  const text = compact ? `${count}` : `${count} · ${shortMoney(fee)}`;
  const label = title || `${count} ${count === 1 ? 'opportunity' : 'opportunities'} worth ${shortMoney(fee)} — show them`;
  return (
    <button type="button" className="opp-badge" title={label} aria-label={label} tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}>
      <Sparkles size={10} strokeWidth={2.5} aria-hidden="true" />{text}
    </button>
  );
}

// A column or day total, for a column header or the production bar: "5 · $620 upside".
export function OpportunityTotal({ count, fee, onClick }) {
  if (!count) return null;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag type={onClick ? 'button' : undefined} className="opp-total" onClick={onClick} title={`${count} ${count === 1 ? 'opportunity' : 'opportunities'} on the books — ${shortMoney(fee)} of extra production if all are done`}>
      <Sparkles size={11} aria-hidden="true" /> {count} · {shortMoney(fee)}
    </Tag>
  );
}
