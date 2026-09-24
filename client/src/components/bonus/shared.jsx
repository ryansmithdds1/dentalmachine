import { money } from '../../format.js';

// Shared bits of the team bonus screens (BN1–BN3).

// Money with no cents when it's whole ("$18,400"), cents when not ("$711.12").
export const cash = (cents) => {
  if (cents == null) return '—';
  return cents % 100 ? money(cents) : money(cents).replace(/\.00$/, '');
};
export const hours = (h) => `${Math.round(h * 10) / 10} h`;
export const kpiValue = (k) => (k.value == null ? '—' : k.unit === 'money' ? cash(k.value) : k.unit === 'percent' ? `${k.value}%` : String(k.value));
export const kpiTarget = (k) => (k.unit === 'money' ? cash(k.target) : k.unit === 'percent' ? `${k.target}%` : String(k.target));

// How far along a plan is, 0–100, and how it's doing — for the meters.
export function meterOf(view) {
  const t = view.team;
  if (t.kind === 'target') return { pct: t.target ? (t.actual / t.target) * 100 : 0, expected: view.pace && t.target ? (view.pace.expected / t.target) * 100 : null, tone: t.actual >= t.target ? 'hit' : view.pace?.status === 'behind' ? 'behind' : '' };
  if (t.kind === 'goals') return t.today?.goal ? { pct: (t.today.actual / t.today.goal) * 100, tone: t.today.actual >= t.today.goal ? 'hit' : '' } : { pct: t.counted ? (t.hits / t.counted) * 100 : 0, tone: '' };
  if (t.kind === 'scorecard') return { pct: t.max_points ? (t.points / t.max_points) * 100 : 0, tone: t.tier ? 'hit' : '' };
  const mine = view.me?.provider;
  if (mine) return { pct: mine.base ? (mine.value / mine.base) * 100 : 100, tone: mine.value >= mine.base ? 'hit' : mine.pace?.status === 'behind' ? 'behind' : '' };
  return null;
}

export function Meter({ view, label }) {
  const m = meterOf(view);
  if (!m) return null;
  const pct = Math.max(0, Math.min(100, m.pct));
  return (
    <div className={`bn-meter ${m.tone}`} role="progressbar" aria-label={label || view.plan.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <i style={{ width: `${pct}%` }} />
      {m.expected != null && m.expected < 100 && <b style={{ left: `${Math.max(0, m.expected)}%` }} title="Where the team should be by now" />}
    </div>
  );
}

export const mineTone = (view) => (view.me?.eligible && view.me.net_cents > 0 ? 'ok' : '');
