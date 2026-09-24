import { useState } from 'react';
import { Wallet, CalendarDays, CreditCard, Sparkles, Check } from 'lucide-react';
import { money } from '../../format.js';
import './finoptions.css';

// The financial options side by side (F3), shared by the patient's page and the desk: one calm card per way
// to pay, big numbers, and the choice of months inside the card. All numbers come from the server
// (finoptions.js); this only shows them. `t` translates on patient pages.
export const LENDER_NAMES = { carecredit: 'CareCredit', sunbit: 'Sunbit', cherry: 'Cherry', proceed: 'Proceed Finance', lendingclub: 'LendingClub', other: 'Financing' };
const groupOf = (o) => (o.kind === 'lender' ? `lender-${o.lender}` : o.kind === 'membership' ? o.key : o.kind);
const ICON = { full: Wallet, in_office: CalendarDays, lender: CreditCard, membership: Sparkles };
// Staff screens: English, with {placeholders} filled in.
const same = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s);

export function groupOptions(options = []) {
  const groups = [];
  for (const o of options) {
    const k = groupOf(o);
    let g = groups.find((x) => x.key === k);
    if (!g) groups.push((g = { key: k, kind: o.kind, list: [] }));
    g.list.push(o);
  }
  return groups;
}

// The term a card shows before anyone picks: the lowest monthly with no interest when there is one.
const featured = (g) => {
  if (g.list.length === 1) return g.list[0];
  const free = g.list.filter((o) => !o.apr);
  return (free.length ? free : g.list).reduce((a, b) => ((b.monthly ?? Infinity) < (a.monthly ?? Infinity) ? b : a));
};

export default function FinOptionCards({ options, picked, onPick, t = same, disabled = false }) {
  const groups = groupOptions(options);
  const [shown, setShown] = useState({});
  if (!groups.length) return null;
  return (
    <div className="fin-cards" role="radiogroup" aria-label={t('Ways to pay')}>
      {groups.map((g) => {
        const current = g.list.find((o) => o.key === picked) || g.list.find((o) => o.key === shown[g.key]) || featured(g);
        const active = g.list.some((o) => o.key === picked);
        const Icon = ICON[g.kind] || Wallet;
        const title = g.kind === 'full' ? t('Pay in full')
          : g.kind === 'in_office' ? t('Monthly with us')
            : g.kind === 'lender' ? LENDER_NAMES[current.lender] || current.lender
              : current.title;
        const choose = (o) => { setShown({ ...shown, [g.key]: o.key }); if (!disabled) onPick?.(o.key); };
        return (
          <div key={g.key} className={`fin-card${active ? ' active' : ''}`} data-kind={g.kind}>
            <button type="button" className="fin-card-main" role="radio" aria-checked={active} disabled={disabled} onClick={() => choose(current)}
              aria-label={`${title}: ${current.monthly ? `${money(current.monthly)} ${t('a month')}` : money(current.total)}`}>
              <span className="fin-card-head"><Icon size={18} aria-hidden="true" /> {title}{active && <Check size={16} className="fin-check" aria-hidden="true" />}</span>
              {current.monthly ? (
                <span className="fin-big">{money(current.monthly)}<small>/{t('mo')}</small></span>
              ) : (
                <span className="fin-big">{money(current.total)}</span>
              )}
              <span className="fin-sub">
                {g.kind === 'full' && (current.discount ? t('Save {amount} ({pct}% prepay discount)', { amount: money(current.discount), pct: current.discount_pct }) : t('One payment'))}
                {g.kind === 'in_office' && (current.apr ? t('{n} months · {apr}% APR', { n: current.months, apr: current.apr }) : t('{n} months · no interest', { n: current.months }))}
                {g.kind === 'lender' && current.title}
                {g.kind === 'membership' && t('Saves {amount} on this treatment', { amount: money(current.savings) })}
              </span>
              <span className="fin-facts">
                <span>{t('Total')} <strong>{money(current.total)}</strong></span>
                <span>{t('Due today')} <strong>{money(current.due_today)}</strong></span>
              </span>
            </button>
            {g.list.length > 1 && (
              <div className="fin-terms" role="group" aria-label={t('How many months')}>
                {g.list.map((o) => (
                  <button key={o.key} type="button" disabled={disabled} className={o.key === current.key ? 'on' : ''} aria-pressed={o.key === current.key} onClick={() => choose(o)}>
                    {o.months}{t('mo')}{o.apr ? '' : ' · 0%'}
                  </button>
                ))}
              </div>
            )}
            {active && current.notes?.length > 0 && <div className="fin-note">{current.notes.map((n) => t(n)).join(' ')}</div>}
            {active && g.kind === 'membership' && <div className="fin-note">{t('Includes a year of membership ({amount}).', { amount: money(current.year_cost) })}</div>}
            {active && g.kind === 'in_office' && current.last_payment !== current.monthly && <div className="fin-note">{t('Last payment {amount}.', { amount: money(current.last_payment) })}</div>}
          </div>
        );
      })}
    </div>
  );
}
