import { money } from '../../format.js';

// Count cash by bills and coins: type a count, Tab to the next. Shows each line's value and the total.
// `denominations` comes from the server ([{ key, cents, label }]); `value` is { key: count }.
export const countTotal = (denominations, value) => (denominations || []).reduce((s, d) => s + (Number(value?.[d.key]) || 0) * d.cents, 0);

export default function DenominationCounter({ denominations, value, onChange, autoFocus = false, idPrefix = 'denom' }) {
  const set = (key, raw) => {
    const clean = String(raw).replace(/[^\d]/g, '').slice(0, 6);
    onChange({ ...value, [key]: clean });
  };
  return (
    <div className="denoms" role="group" aria-label="Cash by bills and coins">
      {(denominations || []).map((d, i) => {
        const n = Number(value?.[d.key]) || 0;
        return (
          <div key={d.key} className={`denom${n ? ' has' : ''}`}>
            <label htmlFor={`${idPrefix}-${d.key}`}>{d.label}</label>
            <input
              id={`${idPrefix}-${d.key}`} inputMode="numeric" pattern="[0-9]*" autoComplete="off" placeholder="0"
              autoFocus={autoFocus && i === 0} value={value?.[d.key] ?? ''} onChange={(e) => set(d.key, e.target.value)}
              onFocus={(e) => e.target.select()}
            />
            <span className="sub">{n ? money(n * d.cents) : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}
