import { useEffect, useState } from 'react';
import { Target, ChevronRight } from 'lucide-react';
import { money } from '../../format.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { useOptimizer } from './useOptimizer.js';
import OptimizerPanel, { ProviderProgress } from './OptimizerPanel.jsx';
import './optimizer.css';

// The morning huddle's plan (OPT3): each provider's progress to goal, "N moves get Dr. Chen to 104%", and the first
// few moves. Shift+O (or the button) opens the side panel to act on them.
const whole = (c) => (c == null ? '' : money(c).replace(/\.00$/, ''));

export default function HuddlePlanCard({ date, locationId = null }) {
  const { can } = useAuth() || {};
  const allowed = !!can?.('schedule:read');
  const opt = useOptimizer(date, locationId, { enabled: allowed });
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState(null);
  useShortcuts([{ combo: 'shift+o', handler: () => setOpen((v) => !v), label: 'Open today’s plan (schedule optimizer)', section: 'Huddle', enabled: allowed && !opt.missing }]);
  useEffect(() => {
    const on = (e) => { setFocusId(e.detail?.id ?? null); setOpen(true); };
    window.addEventListener('dm:optimizer', on);
    return () => window.removeEventListener('dm:optimizer', on);
  }, []);
  if (!allowed || opt.missing) return null;
  const d = opt.data;
  const moves = d ? d.opportunities.filter((o) => o.in_plan) : [];
  return (
    <section className="card opt-huddle" aria-label="Today’s plan">
      <div className="opt-huddle-head">
        <h3><Target size={16} /> Today’s plan</h3>
        <button className="small" onClick={() => setOpen(true)}>Open the plan <kbd>Shift+O</kbd></button>
      </div>
      {!d && !opt.error && <div className="muted">Working out today’s plan…</div>}
      {opt.error && <div className="error">{opt.error.message}</div>}
      {d && (
        <>
          <div className="opt-headline">{d.plan.headline}</div>
          <div className="opt-huddle-provs">
            {d.providers.filter((p) => p.goal || p.plan?.moves?.length).map((p) => <ProviderProgress key={p.provider_id} p={p} money={d.money} compact />)}
          </div>
          {moves.length > 0 && (
            <ol className="opt-huddle-moves">
              {moves.slice(0, 4).map((o) => (
                <li key={o.key}>
                  <button className="link" onClick={() => { setFocusId(o.id); setOpen(true); }}>
                    <span>{o.title}</span>
                    {d.money && o.fee ? <b>+{whole(o.fee)}</b> : null}
                    <ChevronRight size={14} />
                  </button>
                </li>
              ))}
              {moves.length > 4 && <li className="muted">…and {moves.length - 4} more in the plan</li>}
            </ol>
          )}
          {d.protect.length > 0 && <div className="muted opt-huddle-foot">{d.protect.length} {d.protect.length === 1 ? 'visit' : 'visits'} to double-confirm (no-show risk)</div>}
        </>
      )}
      {open && <OptimizerPanel date={date} locationId={locationId} focusId={focusId} onClose={() => { setOpen(false); setFocusId(null); }} />}
    </section>
  );
}
