import { CalendarPlus, Stethoscope, Users, Scissors, ShieldCheck, Sparkles } from 'lucide-react';
import { money } from '../../format.js';
import { openOptimizer } from './useOptimizer.js';
import './optimizer.css';

// Markers on the schedule grid (OPT): open time worth filling, outlined, with how many ideas fit there; and each
// opportunity that has a place on the grid (a visit to book, a stretch of a visit, time a shorter visit frees, a
// visit to double-confirm) as a small pill. A click opens the side panel on that card. Drawn in one column of
// CalendarGrid; `col` is the grid's column ({ date, assign: { provider_id? , operatory_id? } }).
const ICON = { treatment: Stethoscope, finder: Sparkles, family: Users, fill: CalendarPlus, shorten: Scissors, confirm: ShieldCheck };
const toMin = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
const whole = (c) => (c == null ? '' : money(c).replace(/\.00$/, ''));

export default function OptimizerMarkers({ col, data, range, pxPerMin }) {
  if (!data || !col || col.date !== data.date) return null;
  const providerId = col.assign?.provider_id ?? null;
  const chairId = col.assign?.operatory_id ?? null;
  const top = (m) => (m - range.start) * pxPerMin;
  const mine = (o) => (providerId ? o.provider_id === providerId : chairId ? o.operatory_id === chairId : false);
  const opps = [...data.opportunities, ...data.protect].filter((o) => o.fits && o.start_time && mine(o));
  const gaps = providerId ? (data.providers.find((p) => p.provider_id === providerId)?.gaps || []).filter((g) => g.minutes >= 20) : [];
  const stop = (e) => e.stopPropagation();
  return (
    <>
      {gaps.map((g) => {
        const s = Math.max(range.start, toMin(g.start_time));
        const e = Math.min(range.end, toMin(g.end_time));
        if (e <= s) return null;
        const ideas = opps.filter((o) => o.kind !== 'confirm' && toMin(o.start_time) >= toMin(g.start_time) && toMin(o.start_time) < toMin(g.end_time));
        return (
          <button key={`gap-${g.start_time}`} type="button" className={`opt-gap${ideas.length ? ' has' : ''}`} style={{ top: top(s), height: (e - s) * pxPerMin }}
            onPointerDown={stop} onClick={(ev) => { ev.stopPropagation(); openOptimizer(ideas[0]?.id ?? null); }}
            title={`Open ${g.minutes} min${ideas.length ? ` · ${ideas.length} ${ideas.length === 1 ? 'idea' : 'ideas'} — open the plan` : ''}`}>
            {(e - s) * pxPerMin >= 18 && <span>Open {g.minutes}m{ideas.length ? ` · ${ideas.length} ${ideas.length === 1 ? 'idea' : 'ideas'}` : ''}</span>}
          </button>
        );
      })}
      {opps.map((o) => {
        const Icon = ICON[o.kind] || Sparkles;
        const s = toMin(o.start_time);
        if (s < range.start || s >= range.end) return null;
        return (
          <button key={o.key} type="button" className={`opt-pill k-${o.kind}${o.in_plan ? ' in-plan' : ''}`} style={{ top: top(s) + 2 }}
            onPointerDown={stop} onClick={(ev) => { ev.stopPropagation(); openOptimizer(o.id); }} title={`${o.title}${o.detail ? ` — ${o.detail}` : ''}`}>
            <Icon size={10} strokeWidth={2.5} />{o.kind === 'confirm' ? 'Confirm' : data.money && o.fee ? `+${whole(o.fee)}` : o.kind === 'shorten' ? `−${o.minutes}m` : 'Idea'}
          </button>
        );
      })}
    </>
  );
}
