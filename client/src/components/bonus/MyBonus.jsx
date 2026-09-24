import { Link } from 'react-router-dom';
import { Trophy, Settings as Cog } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { Meter, cash, hours, kpiValue, kpiTarget, mineTone } from './shared.jsx';
import './bonus.css';

// "My bonus" (BN2): this period's progress on each plan I'm in, whether I qualify and what I've earned so far,
// and my own history (approved, reopened, what came off for voids and refunds). Only ever my own pay — everyone's
// lines appear only on plans the owner made visible to the team.
export default function MyBonus() {
  const { data, error } = useApi('/bonus/me');
  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!data) return <div className="card">Loading…</div>;
  if (!data.enabled) {
    return (
      <div className="bn-page">
        <h1><Trophy size={20} aria-hidden="true" /> My bonus</h1>
        <p className="bn-muted">Team bonuses aren’t switched on for this practice.{data.can_manage && <> The owner can turn them on in <Link to="/settings?tab=bonus">Settings → Team bonus</Link>.</>}</p>
      </div>
    );
  }
  return (
    <div className="bn-page">
      <h1><Trophy size={20} aria-hidden="true" /> My bonus</h1>
      <p className="bn-muted" style={{ marginTop: 0 }}>
        Numbers so far update as the day goes. The final amount is set when the owner approves the period — a voided charge or a refund can lower it.
        {data.can_manage && <> <Link to="/settings?tab=bonus"><Cog size={13} aria-hidden="true" /> Set up plans</Link></>}
      </p>
      {!data.plans.length && <div className="card">You’re not in a bonus plan right now.</div>}
      {data.plans.map((v) => (
        <section key={v.plan.id} className="card bn-mine-plan" aria-label={v.plan.name}>
          <div className="bn-row">
            <strong className="bn-grow">{v.plan.name}</strong>
            <span className="bn-muted bn-small">{fmtDate(v.period.start)} – {fmtDate(v.period.end)}</span>
            {v.approved ? <span className="bn-pill ok">Approved</span> : v.final ? <span className="bn-pill warn">Waiting for approval</span> : <span className="bn-pill info">In progress</span>}
          </div>
          <div>{v.headline}</div>
          <Meter view={v} />
          {v.team.kind === 'scorecard' && (
            <div className="bn-kpis">
              {v.team.kpis.map((k) => <span key={k.key} className={`bn-pill ${k.met ? 'ok' : ''}`}>{k.met ? '✓' : '○'} {k.label}: {kpiValue(k)} (target {k.better === 'lower' ? '≤ ' : ''}{kpiTarget(k)})</span>)}
            </div>
          )}
          {v.me && (
            <div className="bn-row">
              <span className="bn-big">{cash(v.me.net_cents)}</span>
              <span className={`bn-grow ${mineTone(v) ? '' : 'bn-muted'}`}>{v.my_line}{v.me.hours ? ` · ${hours(v.me.hours)} worked` : ''}</span>
            </div>
          )}
          {!!v.me?.detail?.length && <ul className="bn-detail">{v.me.detail.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          {v.people && (
            <table className="bn-table" aria-label={`${v.plan.name}: the team`}>
              <thead><tr><th>Person</th><th>Status</th><th className="num">So far</th></tr></thead>
              <tbody>{v.people.map((p) => <tr key={p.user_id} className={p.eligible ? '' : 'muted'}><td>{p.name}</td><td>{p.eligible ? 'Qualified' : p.why}</td><td className="num">{cash(p.net_cents)}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      ))}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>History</h2>
      {!data.history.length ? <p className="bn-muted">Nothing approved yet.</p> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="bn-table">
            <thead><tr><th>Period</th><th>Plan</th><th className="num">Earned</th><th className="num">Over cap</th><th className="num">Taken back</th><th className="num">Paid</th><th>Payroll</th></tr></thead>
            <tbody>
              {data.history.map((x) => (
                <tr key={x.id} className={x.status === 'approved' ? '' : 'muted'} title={x.detail.join('\n')}>
                  <td>{fmtDate(x.period_start)} – {fmtDate(x.period_end)}</td>
                  <td>{x.plan_name}{x.status !== 'approved' && ' (reopened)'}</td>
                  <td className="num">{cash(x.earned_cents)}</td>
                  <td className="num">{x.cap_cut_cents ? cash(x.cap_cut_cents) : ''}</td>
                  <td className="num">{x.clawback_cents ? cash(x.clawback_cents) : ''}</td>
                  <td className="num"><strong>{cash(x.net_cents)}</strong></td>
                  <td>{x.status === 'approved' ? `Pay period from ${fmtDate(x.payroll_period_start)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="bn-muted bn-small">Paid so far: {cash(data.paid_total_cents)}</p>
    </div>
  );
}
