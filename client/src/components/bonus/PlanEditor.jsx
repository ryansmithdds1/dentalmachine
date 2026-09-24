import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Eye, Save, X } from 'lucide-react';
import { api } from '../../api.js';
import { useLookup } from '../../hooks.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { cash } from './shared.jsx';

// The inline editor for one bonus plan (no dialogs): the plan's own settings, who qualifies, caps, clawbacks and
// who can see what — with the plan's plain-language rules and worked example alongside, and a preview of what it
// would have paid last period on the practice's real numbers. Saving an existing plan makes a new version from
// the next period (or a date the owner picks) and needs a reason; nothing already approved is changed.

// A number field that shows dollars / percent / hours but hands back the stored unit (cents, basis points…).
function Num({ label, value, onChange, scale = 1, step = 'any', suffix, min = 0, help }) {
  const shown = (v) => (v == null || v === '' ? '' : String(Math.round((v / scale) * 100) / 100));
  const [text, setText] = useState(shown(value));
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) setText(shown(value));
    sent.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label>
      <span>{label}{suffix ? ` (${suffix})` : ''}</span>
      <input type="number" inputMode="decimal" min={min} step={step} value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = e.target.value === '' ? 0 : Math.round(Number(e.target.value) * scale);
          if (Number.isFinite(n)) { sent.current = n; onChange(n); }
        }} />
      {help && <small className="bn-muted">{help}</small>}
    </label>
  );
}
const dollars = { scale: 100, suffix: '$' };
const percentBp = { scale: 100, suffix: '%' };

export default function PlanEditor({ catalog, plan = null, type, onDone }) {
  const t = catalog.types[type];
  const start = plan?.upcoming?.config || plan?.current?.config || t.defaults;
  const [name, setName] = useState(plan?.name || t.label);
  const [cfg, setCfg] = useState(() => JSON.parse(JSON.stringify(start)));
  const [effective, setEffective] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const locations = useLookup('/locations');
  const providers = useLookup('/providers');
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setElig = (k, v) => setCfg((c) => ({ ...c, eligibility: { ...c.eligibility, [k]: v } }));
  const toggle = (list, x) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const setRow = (k, i, patch) => setCfg((c) => ({ ...c, [k]: c[k].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = (k, row) => setCfg((c) => ({ ...c, [k]: [...(c[k] || []), row] }));
  const dropRow = (k, i) => setCfg((c) => ({ ...c, [k]: c[k].filter((_, j) => j !== i) }));

  const run = async (key, fn) => {
    setErr(null);
    setBusy(key);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const doPreview = () => run('preview', async () => setPreview(await api.post('/bonus/preview', { type, name, config: cfg })));
  const save = () => run('save', async () => {
    if (plan) {
      await api.put(`/bonus/plans/${plan.id}`, { name, config: cfg, reason, ...(effective ? { effective_from: effective } : {}) });
      toast(`${name}: new rules saved${effective ? ` from ${effective}` : ' from the next period'}`);
    } else {
      await api.post('/bonus/plans', { type, name, config: cfg, ...(effective ? { effective_from: effective } : {}) });
      toast(`${name} saved — switch it on when you’re ready`);
    }
    onDone(true);
  });
  const onKey = (e) => {
    if (e.key === 'Escape') onDone(false);
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  };
  const kpiUnit = (key) => catalog.kpis[key]?.unit;

  return (
    <section className="bn-editor" aria-label={plan ? `Edit ${plan.name}` : `New ${t.label}`} onKeyDown={onKey}>
      <div className="bn-row">
        <strong className="bn-grow">{plan ? `Change the rules: ${plan.name}` : `New plan: ${t.label}`}</strong>
        <button onClick={() => onDone(false)} aria-label="Close without saving" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </div>
      <p className="bn-muted" style={{ margin: 0 }}>{t.summary}</p>
      <ul className="bn-detail">{t.how.map((x) => <li key={x}>{x}</li>)}</ul>
      <div className="bn-example"><strong>Worked example</strong>{t.example}</div>

      <div className="bn-fields">
        <label><span>Plan name</span><input ref={first} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        {type !== 'daily_goal' && (
          <label><span>Paid for each</span>
            <select value={cfg.period} onChange={(e) => set('period', e.target.value)}>{Object.entries(catalog.periods).map(([k, v]) => <option key={k} value={k}>{v.toLowerCase()}</option>)}</select>
          </label>
        )}
        {locations.length > 1 && (
          <label><span>Office</span>
            <select value={cfg.location_id || ''} onChange={(e) => set('location_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">All offices</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <label><span>{plan ? 'New rules start on' : 'Starts on'}</span><input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          <small className="bn-muted">{plan ? 'Blank: the start of the next period, so this period keeps the rules the team was promised.' : 'Blank: the start of this period.'}</small>
        </label>
      </div>

      {type === 'team_collections' && (
        <div className="bn-fields">
          <label><span>Measure</span><select value={cfg.basis} onChange={(e) => set('basis', e.target.value)}>{Object.entries(catalog.bases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label><span>Target</span>
            <select value={cfg.target_mode} onChange={(e) => set('target_mode', e.target.value)}>
              <option value="fixed">A set amount</option><option value="labor">Labor cost ÷ target labor %</option>
            </select>
          </label>
          {cfg.target_mode === 'fixed'
            ? <Num label="Target per period" {...dollars} value={cfg.target_cents} onChange={(v) => set('target_cents', v)} />
            : <Num label="Target labor" {...percentBp} value={cfg.labor_bp} onChange={(v) => set('labor_bp', v)} help="From the time clock’s hours and pay rates" />}
          <Num label="Team’s share of the excess" {...percentBp} value={cfg.share_bp} onChange={(v) => set('share_bp', v)} />
          <label><span>Split the pool</span>
            <select value={cfg.split} onChange={(e) => set('split', e.target.value)}>
              <option value="hours">By hours worked</option><option value="role_weights">By role weights</option><option value="equal">Equally</option>
            </select>
          </label>
          {cfg.split === 'role_weights' && cfg.eligibility.roles.map((r) => (
            <Num key={r} label={`${catalog.role_labels[r]} weight`} value={cfg.role_weights?.[r] ?? 1} onChange={(v) => set('role_weights', { ...cfg.role_weights, [r]: v })} />
          ))}
        </div>
      )}

      {type === 'daily_goal' && (
        <div className="bn-fields">
          <label><span>Goal for each</span><select value={cfg.unit} onChange={(e) => set('unit', e.target.value)}><option value="day">day</option><option value="week">week</option></select></label>
          <label><span>Measure</span><select value={cfg.basis} onChange={(e) => set('basis', e.target.value)}>{Object.entries(catalog.bases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label><span>Goal</span>
            <select value={cfg.goal_mode} onChange={(e) => set('goal_mode', e.target.value)}><option value="goal">The practice’s goal (Metrics / Settings)</option><option value="fixed">A set amount</option></select>
          </label>
          {cfg.goal_mode === 'fixed' && <Num label={`Goal per ${cfg.unit}`} {...dollars} value={cfg.goal_cents} onChange={(v) => set('goal_cents', v)} />}
          <Num label="Paid to each person per goal hit" {...dollars} value={cfg.amount_cents} onChange={(v) => set('amount_cents', v)} />
        </div>
      )}

      {type === 'spiff' && (
        <div className="bn-lines">
          <p className="bn-sub">Procedures</p>
          {cfg.rules.map((r, i) => (
            <div key={i} className="bn-line">
              <label>Codes (comma between)<input value={r.codes.join(', ')} onChange={(e) => setRow('rules', i, { codes: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })} /></label>
              <label>Name<input value={r.label} maxLength={80} onChange={(e) => setRow('rules', i, { label: e.target.value })} /></label>
              <Num label="Each" {...dollars} value={r.amount_cents} onChange={(v) => setRow('rules', i, { amount_cents: v })} />
              <Num label="Or % of fee" {...percentBp} value={r.pct_bp} onChange={(v) => setRow('rules', i, { pct_bp: v })} />
              <label>Goes to
                <select value={r.to} onChange={(e) => setRow('rules', i, { to: e.target.value })}>
                  <option value="provider">The provider who did it</option><option value="assistant">The assistant working with them</option><option value="scheduler">Whoever booked the visit</option>
                </select>
              </label>
              <button onClick={() => dropRow('rules', i)} aria-label={`Remove ${r.label}`} disabled={cfg.rules.length === 1}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
          ))}
          <button onClick={() => addRow('rules', { codes: [], label: '', amount_cents: 0, pct_bp: 0, to: 'provider' })} style={{ alignSelf: 'flex-start' }}><Plus size={14} aria-hidden="true" /> Add a procedure</button>
        </div>
      )}

      {type === 'provider_pct' && (
        <div className="bn-lines">
          <div className="bn-fields"><label><span>Measure</span><select value={cfg.basis} onChange={(e) => set('basis', e.target.value)}>{Object.entries(catalog.bases).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
          <p className="bn-sub">Providers</p>
          {cfg.providers.map((x, i) => (
            <div key={i} className="bn-line">
              <label>Provider
                <select value={x.provider_id || ''} onChange={(e) => setRow('providers', i, { provider_id: Number(e.target.value) })}>
                  <option value="">Choose…</option>
                  {providers.filter((p) => p.active !== 0).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <Num label="Base per period" {...dollars} value={x.base_cents} onChange={(v) => setRow('providers', i, { base_cents: v })} />
              <Num label="Share above the base" {...percentBp} value={x.pct_bp} onChange={(v) => setRow('providers', i, { pct_bp: v })} />
              <button onClick={() => dropRow('providers', i)} aria-label="Remove provider"><Trash2 size={14} aria-hidden="true" /></button>
            </div>
          ))}
          <button onClick={() => addRow('providers', { provider_id: null, base_cents: 0, pct_bp: 1000 })} style={{ alignSelf: 'flex-start' }}><Plus size={14} aria-hidden="true" /> Add a provider</button>
          <small className="bn-muted">Paid to the login linked to each provider (Settings → Providers).</small>
        </div>
      )}

      {(type === 'scorecard' || type === 'front_desk') && (
        <div className="bn-lines">
          <p className="bn-sub">Targets</p>
          {cfg.kpis.map((k, i) => (
            <div key={i} className="bn-line">
              <label>Measure
                <select value={k.key} onChange={(e) => setRow('kpis', i, { key: e.target.value })}>{Object.entries(catalog.kpis).map(([key, d]) => <option key={key} value={key}>{d.label}</option>)}</select>
              </label>
              <Num label={catalog.kpis[k.key]?.better === 'lower' ? 'At most' : 'At least'} {...(kpiUnit(k.key) === 'money' ? dollars : { suffix: kpiUnit(k.key) === 'percent' ? '%' : null })} value={k.target} onChange={(v) => setRow('kpis', i, { target: v })} />
              <Num label="Points" step={1} value={k.points} onChange={(v) => setRow('kpis', i, { points: v })} />
              <button onClick={() => dropRow('kpis', i)} aria-label="Remove target" disabled={cfg.kpis.length === 1}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
          ))}
          <button onClick={() => addRow('kpis', { key: Object.keys(catalog.kpis)[0], target: 0, points: 1 })} style={{ alignSelf: 'flex-start' }}><Plus size={14} aria-hidden="true" /> Add a target</button>
          <p className="bn-sub">Payout tiers (each person who qualifies)</p>
          {cfg.tiers.map((x, i) => (
            <div key={i} className="bn-line">
              <Num label="With at least … points" step={1} value={x.points} onChange={(v) => setRow('tiers', i, { points: v })} />
              <Num label="Pays" {...dollars} value={x.amount_cents} onChange={(v) => setRow('tiers', i, { amount_cents: v })} />
              <button onClick={() => dropRow('tiers', i)} aria-label="Remove tier" disabled={cfg.tiers.length === 1}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
          ))}
          <button onClick={() => addRow('tiers', { points: 1, amount_cents: 0 })} style={{ alignSelf: 'flex-start' }}><Plus size={14} aria-hidden="true" /> Add a tier</button>
        </div>
      )}

      <p className="bn-sub">Who qualifies</p>
      <fieldset className="bn-checks" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="bn-muted bn-small" style={{ padding: 0 }}>Roles</legend>
        {catalog.roles.map((r) => (
          <label key={r}><input type="checkbox" checked={cfg.eligibility.roles.includes(r)} onChange={() => setElig('roles', toggle(cfg.eligibility.roles, r))} /> {catalog.role_labels[r]}</label>
        ))}
      </fieldset>
      <div className="bn-fields">
        <Num label="Hours worked in the period, at least" step={1} value={cfg.eligibility.min_hours} onChange={(v) => setElig('min_hours', v)} help="From the time clock. 0 = no minimum." />
        <label><span>Leave out</span>
          <select multiple size={Math.min(5, Math.max(2, catalog.staff.length))} value={cfg.eligibility.exclude_user_ids.map(String)} onChange={(e) => setElig('exclude_user_ids', [...e.target.selectedOptions].map((o) => Number(o.value)))}>
            {catalog.staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>

      <p className="bn-sub">Limits and safety</p>
      <div className="bn-fields">
        <Num label="Most per person per period" {...dollars} value={cfg.cap_person_cents} onChange={(v) => set('cap_person_cents', v)} help="0 = no cap" />
        <Num label="Most for the whole plan per period" {...dollars} value={cfg.cap_total_cents} onChange={(v) => set('cap_total_cents', v)} help="0 = no cap; over it, everyone is scaled down evenly" />
        <Num label="Take back voids and refunds for" step={1} suffix="days" value={cfg.clawback_days} onChange={(v) => set('clawback_days', v)} help="0 = never take back" />
      </div>
      <label className="bn-switch" style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={!!cfg.team_visible} onChange={(e) => set('team_visible', e.target.checked)} />
        Everyone in this plan can see what everyone in it earns (off: each person sees only their own)
      </label>

      {plan && (
        <label className="bn-field"><span>Why the change? (kept with the new version)</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
      )}
      <ErrorBox error={err} />
      <div className="bn-actions">
        <button className="primary" onClick={save} disabled={!!busy || (plan && !reason.trim())} title="Save (Ctrl+Enter)"><Save size={14} aria-hidden="true" /> {busy === 'save' ? 'Saving…' : plan ? 'Save new version' : 'Save plan'}</button>
        <button onClick={doPreview} disabled={!!busy}><Eye size={14} aria-hidden="true" /> {busy === 'preview' ? 'Working it out…' : 'What would it have paid last period?'}</button>
      </div>
      {preview && (
        <div className="bn-example" aria-live="polite">
          <strong>{preview.period.start} to {preview.period.end}, on your real numbers</strong>
          Total {cash(preview.totals.net_cents)}{preview.totals.cap_cut_cents ? ` (after ${cash(preview.totals.cap_cut_cents)} over the caps)` : ''} to {preview.people.filter((p) => p.net_cents > 0).length} people.
          {!!preview.notes.length && <ul className="bn-detail">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <table className="bn-table" style={{ marginTop: 6 }}>
            <tbody>{preview.people.map((p) => <tr key={p.user_id} className={p.eligible ? '' : 'muted'}><td>{p.name}</td><td>{p.eligible ? p.detail.join('; ') : p.why}</td><td className="num">{cash(p.net_cents)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
