import { useState } from 'react';
import { ChevronLeft, ChevronRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { cash, hours, kpiValue, kpiTarget } from './shared.jsx';

// The owner's end-of-period step (BN3): everyone's numbers for one plan and period — earned, over the cap, taken
// back for voids and refunds, paid — then Approve (once; a second click changes nothing) into a chosen pay period's
// payroll export, or Reopen an approved period with a reason. ← / → move between periods.
export default function PeriodReview({ plan }) {
  const [start, setStart] = useState(null);
  const { data, error, reload } = useApi(`/bonus/periods?plan_id=${plan.id}${start ? `&start=${start}` : ''}`);
  const [payroll, setPayroll] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="bn-muted">Working out the numbers…</p>;
  const run = async (fn) => {
    setErr(null);
    setBusy(true);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const approve = () => run(async () => {
    const r = await api.post('/bonus/periods/approve', { plan_id: plan.id, start: data.period.start, payroll_start: payroll || data.payroll_default, expected_total_cents: data.totals.net_cents });
    toast(r.already_approved ? 'Already approved — nothing changed' : `Approved ${cash(r.approval.total_cents)} for payroll`);
    if (r.warning) toast(r.warning, { ms: 9000 });
    reload();
  });
  const reopen = () => run(async () => {
    const r = await api.post(`/bonus/periods/${data.approval.id}/reopen`, { reason });
    toast('Reopened — it’s out of the next payroll file until you approve it again');
    if (r.warning) toast(r.warning, { ms: 9000 });
    setReason('');
    reload();
  });
  const onKey = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') setStart(data.prev.start);
    if (e.key === 'ArrowRight') setStart(data.next.start);
  };
  const t = data.team;
  return (
    <div className="bn-lines" tabIndex={-1} onKeyDown={onKey} aria-label={`${plan.name}: review a period`}>
      <div className="bn-row">
        <button onClick={() => setStart(data.prev.start)} aria-label="Previous period" title="Previous period (←)"><ChevronLeft size={15} aria-hidden="true" /></button>
        <strong>{fmtDate(data.period.start)} – {fmtDate(data.period.end)}</strong>
        <button onClick={() => setStart(data.next.start)} aria-label="Next period" title="Next period (→)"><ChevronRight size={15} aria-hidden="true" /></button>
        {data.approval ? <span className="bn-pill ok">Approved {fmtDate(data.approval.approved_at)} by {data.approval.approved_by_name}</span> : data.ended ? <span className="bn-pill warn">Ready to approve</span> : <span className="bn-pill info">Still going — numbers so far</span>}
      </div>
      <div className="bn-muted bn-small">
        {t.kind === 'target' && <>{t.label}: {cash(t.actual)} vs target {cash(t.target)}{t.labor_cents != null ? ` (labor ${cash(t.labor_cents)})` : ''} → pool {cash(t.pool)}</>}
        {t.kind === 'goals' && <>{t.hits} of {t.counted} {t.unit === 'day' ? 'days' : 'weeks'} at goal</>}
        {t.kind === 'count' && <>{t.procedures} procedures counted</>}
        {t.kind === 'providers' && t.providers.map((x) => <span key={x.provider_id}>{x.provider_name}: {cash(x.value)} vs base {cash(x.base)} → {cash(x.earned)}. </span>)}
        {t.kind === 'scorecard' && <span className="bn-kpis">{t.kpis.map((k) => <span key={k.key} className={`bn-pill ${k.met ? 'ok' : ''}`}>{k.met ? '✓' : '○'} {k.label}: {kpiValue(k)} / {kpiTarget(k)}</span>)} → {t.points} points{t.tier ? `, ${cash(t.tier.amount_cents)} tier` : ', no tier reached'}</span>}
      </div>
      {!!data.notes?.length && <ul className="bn-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {!!data.changed_since_approval?.length && (
        <ul className="bn-notes">{data.changed_since_approval.map((c) => <li key={c.user_id}>{c.name}: approved {cash(c.approved_cents)}, now {cash(c.now_cents)} (voids or refunds since) — the difference comes off their next bonus.</li>)}</ul>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="bn-table">
          <thead><tr><th>Person</th><th className="num">Hours</th><th>Why</th><th className="num">Earned</th><th className="num">Over cap</th><th className="num">Taken back</th><th className="num">Paid</th></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.user_id} className={p.eligible || p.clawback_cents ? '' : 'muted'}>
                <td>{p.name}</td>
                <td className="num">{p.hours ? hours(p.hours) : ''}</td>
                <td>{p.eligible ? p.detail.join('; ') : [p.why, ...p.detail].filter(Boolean).join('; ')}</td>
                <td className="num">{cash(p.earned_cents)}</td>
                <td className="num">{p.cap_cut_cents ? cash(p.cap_cut_cents) : ''}</td>
                <td className="num">{p.clawback_cents ? cash(p.clawback_cents) : ''}{p.still_owed_cents ? ` (+${cash(p.still_owed_cents)} later)` : ''}</td>
                <td className="num"><strong>{cash(p.net_cents)}</strong></td>
              </tr>
            ))}
            {!data.people.length && <tr><td colSpan={7} className="bn-muted">Nobody is in this plan.</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={3}><strong>Total</strong></td><td className="num">{cash(data.totals.earned_cents)}</td><td className="num">{data.totals.cap_cut_cents ? cash(data.totals.cap_cut_cents) : ''}</td><td className="num">{data.totals.clawback_cents ? cash(data.totals.clawback_cents) : ''}</td><td className="num"><strong>{cash(data.totals.net_cents)}</strong></td></tr></tfoot>
        </table>
      </div>
      <ErrorBox error={err} />
      {data.approval ? (
        <div className="bn-actions">
          <span className="bn-muted bn-small">In the payroll export for the pay period starting {fmtDate(data.approval.payroll_period_start)}.</span>
          <input aria-label="Why reopen?" placeholder="Why reopen? (required)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) reopen(); }} />
          <button onClick={reopen} disabled={busy || !reason.trim()}><RotateCcw size={14} aria-hidden="true" /> Reopen</button>
        </div>
      ) : data.ended ? (
        <div className="bn-actions">
          <label className="bn-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>Pay with the pay period starting
            <input type="date" value={payroll || data.payroll_default} onChange={(e) => setPayroll(e.target.value)} />
          </label>
          <button className="primary" onClick={approve} disabled={busy}><CheckCircle2 size={14} aria-hidden="true" /> Approve {cash(data.totals.net_cents)}</button>
        </div>
      ) : null}
    </div>
  );
}
