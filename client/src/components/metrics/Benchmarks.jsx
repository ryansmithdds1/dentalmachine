import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, Medal, Award, TrendingUp, Users, Target, Sparkles, Lock, UserRound } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import './benchmarks.css';

// Reports → Metrics → Benchmarks (BM3–BM4): how this practice's doctors and hygienists compare with practices like
// it — percentiles, each person's above/below-average card with the biggest opportunities and what the best quarter
// does differently (from the numbers only), and anonymous monthly leaderboards. Every number is worked out on the
// server (server/src/benchmarks.js); only aggregates ever leave the practice, and only when the owner has joined.
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shift = (m, k) => {
  const d = new Date(`${m}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 7);
};
export const valueText = (unit, v) => (v == null ? '—' : unit === 'money' ? `$${Math.round(v / 100).toLocaleString('en-US')}` : unit === 'percent' ? `${Math.round(v * 10) / 10}%` : String(Math.round(v)));
export const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
const ROLES = [['dentist', 'Dentists'], ['hygienist', 'Hygienists'], ['practice', 'Whole practice']];
const TIER_ICON = { gold: Trophy, silver: Medal, bronze: Medal, top10: Award };

// Where p25–p90 sit, and where each of ours sits, on one line (performance order: right is better).
function Spread({ m }) {
  const p = m.percentiles;
  const pts = [p.p25, p.p50, p.p75, p.p90, ...m.mine.map((x) => x.value)].filter((v) => v != null);
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pos = (v) => {
    const f = (v - lo) / (hi - lo);
    return `${Math.round((m.better === 'lower' ? 1 - f : f) * 1000) / 10}%`;
  };
  const band = [pos(p.p25), pos(p.p75)].sort();
  return (
    <div className="bm-spread" role="img" aria-label={`25th percentile ${valueText(m.unit, p.p25)}, median ${valueText(m.unit, p.p50)}, 75th ${valueText(m.unit, p.p75)}, 90th ${valueText(m.unit, p.p90)}`}>
      <span className="bm-spread-band" style={{ left: band[0], width: `calc(${band[1]} - ${band[0]})` }} />
      <span className="bm-spread-mid" style={{ left: pos(p.p50) }} />
      <span className="bm-spread-top" style={{ left: pos(p.p90) }} title={`90th percentile ${valueText(m.unit, p.p90)}`} />
      {m.mine.map((x) => <span key={x.provider_key} className="bm-spread-you" style={{ left: pos(x.value) }} title={`${x.name}: ${valueText(m.unit, x.value)}`} />)}
    </div>
  );
}

function Card({ c }) {
  return (
    <article className="bm-card" aria-label={`${c.name}: how they compare`}>
      <header>
        <strong>{c.name}</strong>
        <span className="muted">{c.role === 'practice' ? 'Whole practice' : c.role === 'hygienist' ? 'Hygienist' : 'Dentist'}</span>
      </header>
      {c.headline && <p className="bm-headline">{c.headline}</p>}
      <p className="muted bm-summary">{c.summary}{c.hidden ? ` ${c.hidden} more aren’t shown yet (too few practices share them).` : ''}</p>
      {c.compared > 0 && (
        <div className="bm-meter" aria-hidden="true"><i style={{ width: `${(c.above / c.compared) * 100}%` }} /></div>
      )}
      {c.opportunities.length > 0 && (
        <>
          <h4><Target size={14} aria-hidden="true" /> Biggest opportunities</h4>
          <ol className="bm-opps">
            {c.opportunities.map((o) => (
              <li key={o.metric}>
                <span>{o.text}</span>
                {o.impact && <span className="bm-impact">{o.impact}</span>}
                {o.differently.length > 0 && (
                  <ul className="bm-diff">
                    {o.differently.map((d) => <li key={d.metric}>{d.text}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {c.strengths.length > 0 && (
        <>
          <h4><Sparkles size={14} aria-hidden="true" /> Doing great</h4>
          <ul className="bm-strengths">{c.strengths.map((s) => <li key={s.metric}>{s.text}</li>)}</ul>
        </>
      )}
    </article>
  );
}

function Leaderboard({ boards }) {
  const [pick, setPick] = useState('');
  if (!boards.length) return <p className="muted">No leaderboards yet: they appear once enough practices like yours share a number.</p>;
  const b = boards.find((x) => `${x.metric}|${x.role}` === pick) || boards[0];
  return (
    <div className="bm-board">
      <label className="bm-inline">
        <span>Leaderboard for</span>
        <select value={`${b.metric}|${b.role}`} onChange={(e) => setPick(e.target.value)}>
          {boards.map((x) => <option key={`${x.metric}|${x.role}`} value={`${x.metric}|${x.role}`}>{x.label} · {x.role_label}</option>)}
        </select>
      </label>
      <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>{b.group_label} · {b.practices} practices. Names are hidden unless a doctor chose to show theirs.</p>
      <ol className="bm-rank">
        {b.entries.map((e) => {
          const Icon = e.badge ? TIER_ICON[e.badge.tier] : null;
          return (
            <li key={`${e.rank}-${e.label}`} className={e.mine ? 'mine' : ''}>
              <span className="bm-pos">{e.outside_top ? `#${e.rank}` : e.rank}</span>
              <span className="bm-who">
                <strong>{e.mine && e.you ? `${e.you} (you)` : e.label}</strong>
                <span className="muted">{[e.practice_type, e.region].filter(Boolean).join(' · ')}{e.sample ? ' · sample' : ''}</span>
              </span>
              {e.badge && <span className={`bm-badge ${e.badge.tier}`}>{Icon && <Icon size={13} aria-hidden="true" />}{e.badge.text}</span>}
              <span className="bm-val">{valueText(b.unit, e.value)}</span>
            </li>
          );
        })}
      </ol>
      {b.rising_star && (
        <p className="bm-rising"><TrendingUp size={14} aria-hidden="true" /> <strong>Rising star:</strong> {b.rising_star.mine && b.rising_star.you ? `${b.rising_star.you} (you)` : b.rising_star.label}{b.rising_star.region ? ` · ${b.rising_star.region}` : ''} — up {b.rising_star.gain} places in every hundred since last month.</p>
      )}
    </div>
  );
}

// "Show my name on leaderboards": the doctor's own choice (off by default).
function MyName({ me, onChange }) {
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const flip = async (on) => {
    setBusy(true);
    try {
      const r = await api.put(`/benchmarks/providers/${me.provider_id}/name`, { show_name: on });
      toast(on ? `Leaderboards now show you as ${r.shown_as}` : `You’re anonymous again (${r.shown_as})`);
      onChange();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally { setBusy(false); }
  };
  return (
    <label className="bm-myname">
      <input type="checkbox" checked={!!me.show_name} disabled={busy || !me.public_name} onChange={(e) => flip(e.target.checked)} />
      <span><UserRound size={14} aria-hidden="true" /> Show my name on leaderboards{me.public_name ? ` as “${me.public_name}”` : ''} — otherwise I’m {me.anonymous_as}</span>
    </label>
  );
}

export default function Benchmarks() {
  const status = useApi('/benchmarks/status');
  const [month, setMonth] = useState(null);
  const [role, setRole] = useState('dentist');
  const s = status.data;
  const latest = useMemo(() => shift(new Date().toISOString().slice(0, 7), -1), []);
  const m = month || latest;
  const { data, error, loading } = useApi(s?.joined && s?.can_view ? `/benchmarks/results?month=${m}` : null);

  if (status.error) return <div className="card"><ErrorBox error={status.error} /></div>;
  if (!s) return <div className="card">Loading…</div>;
  if (!s.joined) {
    return (
      <section className="card bm-empty">
        <h2><Lock size={16} aria-hidden="true" /> Compare with practices like yours</h2>
        <p>See where each doctor and hygienist stands against similar practices — diagnosis per exam, case acceptance, production per hour, reappointment and more — with anonymous leaderboards and the few changes that would matter most.</p>
        <p className="muted">It’s off until the owner turns it on. Only totals are shared (never patient information), nothing is shown until at least 10 practices are in your group, and you can leave at any time.</p>
        {s.can_manage ? <Link className="button" to="/settings?tab=benchmarks">Set up benchmarks</Link> : <p className="muted">Ask the practice owner to turn it on in Settings → Benchmarks.</p>}
        {s.status === 'leaving' && <p className="muted">Leaving is being confirmed with the benchmark service.</p>}
      </section>
    );
  }
  if (!s.can_view) return <div className="card"><p className="muted">Benchmarks need the “See all practice reports” or “See their own production” permission, with your login linked to your provider.</p><MyName me={s.me} onChange={status.reload} /></div>;

  const metrics = (data?.metrics || []).filter((x) => x.role === role);
  const boards = (data?.leaderboards || []).filter((x) => x.role === role);
  const cards = (data?.cards || []).filter((c) => c.role === role);
  return (
    <div className="bm">
      <div className="bm-bar">
        <div className="mx-seg" role="group" aria-label="Month">
          {[shift(latest, -1), latest, shift(latest, 1)].map((x) => (
            <button key={x} type="button" className={m === x ? 'active' : ''} aria-pressed={m === x} onClick={() => setMonth(x)}>{x === shift(latest, 1) ? `${monthName(x)} so far` : monthName(x)}</button>
          ))}
        </div>
        <div className="mx-seg" role="group" aria-label="Who">
          {ROLES.map(([k, l]) => <button key={k} type="button" className={role === k ? 'active' : ''} aria-pressed={role === k} onClick={() => setRole(k)}>{l}</button>)}
        </div>
        <MyName me={s.me} onChange={status.reload} />
      </div>
      {data?.sample && <p className="bm-sample">Sandbox: the other practices here are made up, so you can try this out. Real comparisons need the benchmark service (BENCHMARK_URL).</p>}
      <ErrorBox error={error} />
      {loading && !data && <div className="card">Loading…</div>}
      {data && (
        <>
          {cards.length > 0 && (
            <section aria-label="How each person compares">
              <h2 className="bm-h"><Users size={15} aria-hidden="true" /> How you compare</h2>
              <div className="bm-cards">{cards.map((c) => <Card key={c.provider_key} c={c} />)}</div>
            </section>
          )}
          <section aria-label="Percentiles">
            <h2 className="bm-h"><Target size={15} aria-hidden="true" /> Percentiles · {monthName(m)}</h2>
            {!metrics.length ? <p className="muted">No numbers for {ROLES.find((r) => r[0] === role)[1].toLowerCase()} this month yet.</p> : (
              <div className="bm-table-wrap">
                <table className="compact-table bm-table">
                  <thead><tr><th>Number</th><th>Yours</th><th className="num">25th</th><th className="num">Median</th><th className="num">75th</th><th className="num">90th</th><th>Spread</th><th>Compared with</th></tr></thead>
                  <tbody>
                    {metrics.map((x) => (
                      <tr key={`${x.metric}|${x.role}`}>
                        <td>{x.label}{x.better === 'lower' ? <span className="muted"> (lower is better)</span> : null}</td>
                        <td>
                          {x.mine.length ? x.mine.map((y) => (
                            <div key={y.provider_key}>
                              {role !== 'practice' && x.mine.length > 1 ? <span className="muted">{y.name}: </span> : null}
                              <strong>{valueText(x.unit, y.value)}</strong>
                              {y.standing != null && <span className={`bm-pct ${y.standing >= 75 ? 'good' : y.standing < 25 ? 'low' : ''}`}> {ordinal(y.standing)} percentile</span>}
                            </div>
                          )) : <span className="muted">—</span>}
                        </td>
                        {x.suppressed ? <td colSpan={5} className="muted">{x.reason}</td> : (
                          <>
                            <td className="num">{valueText(x.unit, x.percentiles.p25)}</td>
                            <td className="num">{valueText(x.unit, x.percentiles.p50)}</td>
                            <td className="num">{valueText(x.unit, x.percentiles.p75)}</td>
                            <td className="num">{valueText(x.unit, x.percentiles.p90)}</td>
                            <td><Spread m={x} /></td>
                          </>
                        )}
                        <td className="muted" style={{ fontSize: 12 }}>{x.suppressed ? '—' : `${x.group.label} (${x.group.practices})`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted bm-foot">Percentiles are of performance: the 90th is the number only one in ten beat. Each number uses the same definition as Reports → Metrics. A number shows only when at least {data.min_peers} practices are in the group.</p>
          </section>
          <section aria-label="Leaderboard">
            <h2 className="bm-h"><Trophy size={15} aria-hidden="true" /> Leaderboard · {monthName(m)}</h2>
            <Leaderboard boards={boards} />
          </section>
        </>
      )}
    </div>
  );
}
