import { Check, Clock, CalendarDays, ArrowRight, Hourglass } from 'lucide-react';
import { money } from '../../format.js';
import ToothMap from './ToothMap.jsx';

// 2–3 options for the same problem side by side (F6): what's done, visits and chair time, the patient's cost
// after insurance, the lowest monthly, the likely next step and its future cost, longevity, pros and cons.
// Used on the patient's screen (tap to choose) and on the staff screen (point to an option on the patient's
// window). `t` translates on patient pages; staff see which wording is still the office's starter text.
const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '') : s);
const hours = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

export default function CompareBoard({ options, chosen = null, highlight = null, onChoose, chooseLabel, t = fill, staff = false }) {
  return (
    <div className="cmp-board" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = chosen === o.plan_id;
        return (
          <div key={o.plan_id} className={`cmp-col${on ? ' on' : ''}${highlight === o.plan_id ? ' pointed' : ''}`} data-plan={o.plan_id}>
            <div className="cmp-label">{t(o.label)}{on && <Check size={16} aria-hidden="true" />}</div>
            <div className="cmp-work">{o.work.map((w) => t(w)).join(' + ')}</div>
            <ToothMap teeth={o.teeth} size={220} />
            <div className="cmp-facts">
              <span><CalendarDays size={14} aria-hidden="true" /> {o.visits === 1 ? t('1 visit') : t('{n} visits', { n: o.visits })}</span>
              <span><Clock size={14} aria-hidden="true" /> {hours(o.chair_minutes)}</span>
            </div>
            <div className="cmp-cost">
              <div className="muted">{t('You pay')}</div>
              <div className="fin-big">{money(o.you_pay)}</div>
              <div className="muted">{o.insurance > 0 ? t('after {amount} from insurance', { amount: money(o.insurance) }) : ' '}</div>
              {o.monthly_from && <div className="cmp-monthly">{t('or from {amount}/mo', { amount: money(o.monthly_from) })}</div>}
            </div>
            {o.next_steps.length > 0 && (
              <div className="cmp-next">
                <div className="cmp-h"><ArrowRight size={14} aria-hidden="true" /> {t('Likely next step')}</div>
                {o.next_steps.map((n, i) => <div key={i}>{t(n.label)}{n.cost ? <> · <strong>{money(n.cost)}</strong> {t('later')}</> : null}</div>)}
              </div>
            )}
            {o.longevity.length > 0 && <div className="cmp-last"><Hourglass size={14} aria-hidden="true" /> {o.longevity.map((l) => t(l)).join(' · ')}</div>}
            {(o.pros.length > 0 || o.cons.length > 0) && (
              <ul className="cmp-pc">
                {o.pros.map((p, i) => <li key={`p${i}`} className="pro">{t(p)}</li>)}
                {o.cons.map((c, i) => <li key={`c${i}`} className="con">{t(c)}</li>)}
              </ul>
            )}
            {staff && o.starter && <div className="cmp-starter">Starter wording — review it (Treatment plans ⚙ → What patients are told)</div>}
            {onChoose && !o.signed && (
              <button type="button" className={on ? 'primary' : ''} aria-pressed={on} onClick={() => onChoose(o.plan_id)}>{chooseLabel ? chooseLabel(o) : on ? t('Chosen') : t('Choose this')}</button>
            )}
            {o.signed && <div className="muted">{t('Signed')}</div>}
          </div>
        );
      })}
    </div>
  );
}
