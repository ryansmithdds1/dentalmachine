import { useState } from 'react';
import { Trophy, Plus, Pencil, Power, Archive, ListChecks } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { undoable } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import PlanEditor from './PlanEditor.jsx';
import PeriodReview from './PeriodReview.jsx';
import './bonus.css';

// Settings → Team bonus (BN1, BN3): the owner's switch for the whole module (off until turned on), where it shows
// (dashboard card, schedule bar), the plans — each with plain-language rules and a worked example — and the
// end-of-period review and approval. Administrators and people with 'bonus:manage' only; everything is audited on
// the server. Switches save at once with an undo; plan changes are new versions with a reason.
export default function BonusSettings() {
  const settings = useApi('/bonus/settings');
  const catalog = useApi('/bonus/plan-types');
  const plans = useApi('/bonus/plans');
  const [editing, setEditing] = useState(null); // { type, plan? }
  const [reviewing, setReviewing] = useState(null); // plan id
  const [archiving, setArchiving] = useState(null); // { plan, reason }
  const [err, setErr] = useState(null);

  const error = settings.error || catalog.error || plans.error;
  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!settings.data || !catalog.data || !plans.data) return <div className="card">Loading…</div>;
  const s = settings.data;
  const cat = catalog.data;

  const setSetting = (patch, message) => undoable(message, async () => {
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, s[k]]));
    await api.put('/bonus/settings', patch);
    settings.reload();
    return before;
  }, async (before) => { await api.put('/bonus/settings', before); settings.reload(); }).catch(setErr);
  const setStatus = async (plan, status, reason) => {
    setErr(null);
    try {
      await undoable(status === 'active' ? `${plan.name} is on` : status === 'off' ? `${plan.name} is off` : `${plan.name} archived`,
        () => api.post(`/bonus/plans/${plan.id}/status`, { status, ...(reason ? { reason } : {}) }),
        status === 'archived' ? null : () => api.post(`/bonus/plans/${plan.id}/status`, { status: plan.status }).then(() => plans.reload()));
      plans.reload();
    } catch (e) { setErr(e); }
  };
  const done = (saved) => { setEditing(null); if (saved) plans.reload(); };

  return (
    <div className="card bn-settings">
      <div>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Trophy size={18} aria-hidden="true" /> Team bonus</h2>
        <p className="bn-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Reward the team for the numbers that matter. Everyone sees the team’s progress and their own status on the dashboard and the schedule —
          never anyone else’s pay, unless you make a plan visible to the team. Nothing is paid until you approve the period; approved bonuses go into the
          time-clock payroll export as their own pay type.
        </p>
      </div>
      <label className="bn-switch">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setSetting({ enabled: e.target.checked }, e.target.checked ? 'Team bonuses are on' : 'Team bonuses are off')} />
        Team bonuses are {s.enabled ? 'on' : 'off'}
      </label>
      <div className="bn-checks">
        <label><input type="checkbox" checked={s.show_dashboard} disabled={!s.enabled} onChange={(e) => setSetting({ show_dashboard: e.target.checked }, e.target.checked ? 'Shown on the dashboard' : 'Hidden from the dashboard')} /> Show the progress card on the dashboard</label>
        <label><input type="checkbox" checked={s.show_schedule} disabled={!s.enabled} onChange={(e) => setSetting({ show_schedule: e.target.checked }, e.target.checked ? 'Shown on the schedule' : 'Hidden from the schedule')} /> Show the slim bar on the schedule</label>
      </div>
      <ul className="bn-detail">{cat.common_rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <ErrorBox error={err} />

      <div>
        <p className="bn-sub">Your plans</p>
        {!plans.data.plans.length && <p className="bn-muted">No plans yet — pick one below to start.</p>}
        {plans.data.plans.map((p) => (
          <div key={p.id}>
            <div className="bn-planrow">
              <div className="bn-grow">
                <strong>{p.name}</strong> <span className="bn-muted bn-small">· {cat.types[p.type]?.label}</span>
                <div className="bn-muted bn-small">
                  {p.current ? `Version ${p.current.version}, since ${fmtDate(p.current.effective_from)}` : 'Not started yet'}
                  {p.upcoming && ` · version ${p.upcoming.version} from ${fmtDate(p.upcoming.effective_from)}`}
                  {p.last_approved_end && ` · approved to ${fmtDate(p.last_approved_end)}`}
                  {(p.upcoming || p.current)?.config?.team_visible ? ' · visible to the team' : ''}
                </div>
              </div>
              <span className={`bn-pill ${p.status === 'active' ? 'ok' : p.status === 'archived' ? '' : 'warn'}`}>{p.status === 'active' ? 'On' : p.status === 'off' ? 'Off' : 'Archived'}</span>
              {p.status !== 'archived' && (
                <>
                  <button onClick={() => setStatus(p, p.status === 'active' ? 'off' : 'active')}><Power size={14} aria-hidden="true" /> {p.status === 'active' ? 'Turn off' : 'Turn on'}</button>
                  <button onClick={() => { setEditing({ type: p.type, plan: p }); setReviewing(null); }}><Pencil size={14} aria-hidden="true" /> Change rules</button>
                  <button onClick={() => setReviewing(reviewing === p.id ? null : p.id)} aria-expanded={reviewing === p.id}><ListChecks size={14} aria-hidden="true" /> Review &amp; approve</button>
                  <button onClick={() => setArchiving({ plan: p, reason: '' })} aria-label={`Archive ${p.name}`}><Archive size={14} aria-hidden="true" /></button>
                </>
              )}
            </div>
            {archiving?.plan.id === p.id && (
              <div className="bn-actions" style={{ marginBottom: 10 }}>
                <input autoFocus aria-label="Why archive this plan?" placeholder="Why retire this plan? (kept in the audit log)" value={archiving.reason} maxLength={300}
                  onChange={(e) => setArchiving({ ...archiving, reason: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setArchiving(null); if (e.key === 'Enter' && archiving.reason.trim()) { setStatus(p, 'archived', archiving.reason); setArchiving(null); } }} />
                <button disabled={!archiving.reason.trim()} onClick={() => { setStatus(p, 'archived', archiving.reason); setArchiving(null); }}>Archive</button>
                <button onClick={() => setArchiving(null)}>Cancel</button>
              </div>
            )}
            {editing?.plan?.id === p.id && <PlanEditor catalog={cat} plan={p} type={p.type} onDone={done} />}
            {reviewing === p.id && <div style={{ padding: '4px 0 14px' }}><PeriodReview plan={p} /></div>}
          </div>
        ))}
      </div>

      {editing && !editing.plan && <PlanEditor catalog={cat} type={editing.type} onDone={done} />}

      <div>
        <p className="bn-sub">Add a plan</p>
        <div className="bn-types">
          {Object.values(cat.types).map((t) => (
            <article key={t.key} className="bn-type" aria-label={t.label}>
              <h3>{t.label}</h3>
              <span className="bn-small">{t.summary}</span>
              <ul>{t.how.map((x) => <li key={x}>{x}</li>)}</ul>
              <div className="bn-example"><strong>Worked example</strong>{t.example}</div>
              <button onClick={() => { setEditing({ type: t.key }); setReviewing(null); }}><Plus size={14} aria-hidden="true" /> Set up</button>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
