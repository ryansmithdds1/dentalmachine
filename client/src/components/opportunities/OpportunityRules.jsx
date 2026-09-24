import { useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Sparkles } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { announceOpportunities } from './OpportunityBadge.jsx';
import './opportunities.css';

// Settings → Opportunities (OF1): the work the office wants surfaced on visits — codes, where they apply, ages,
// how often, and the chart conditions that trigger them. Starts from a starter set; rules are edited inline and
// retired (not deleted), with undo. Only administrators change them; everyone with chart access can read them.
const SCOPE_LABEL = { mouth: 'Whole mouth', tooth: 'Per tooth', quadrant: 'Per quadrant' };
const blank = { name: '', codes: '', scope: 'mouth', age_min: '', age_max: '', frequency_months: '', conditions: [], replaces: '', note: '' };
const toForm = (r) => ({ ...blank, ...r, codes: r.codes.join(', '), replaces: (r.replaces || []).join(', '), age_min: r.age_min ?? '', age_max: r.age_max ?? '', frequency_months: r.frequency_months ?? '', note: r.note || '' });
const toBody = (f) => ({
  name: f.name, codes: f.codes, replaces: f.replaces, scope: f.scope, conditions: f.conditions, note: f.note,
  age_min: f.age_min === '' ? null : Number(f.age_min), age_max: f.age_max === '' ? null : Number(f.age_max), frequency_months: f.frequency_months === '' ? null : Number(f.frequency_months),
});
const summary = (r) => [
  r.codes.join(' / ') || 'Planned items',
  SCOPE_LABEL[r.scope],
  r.age_min != null || r.age_max != null ? `ages ${r.age_min ?? 0}–${r.age_max ?? '∞'}` : null,
  r.frequency_months ? `every ${r.frequency_months % 12 === 0 && r.frequency_months >= 12 ? `${r.frequency_months / 12} yr` : `${r.frequency_months} mo`}` : null,
].filter(Boolean).join(' · ');

export default function OpportunityRules() {
  const { user } = useAuth() || {};
  const admin = user?.role === 'admin';
  const { data, error, reload } = useApi('/opportunity-rules');
  const [editing, setEditing] = useState(null); // rule id, or 'new'
  const [showRetired, setShowRetired] = useState(false);
  const done = async (msg, undoFn) => {
    await reload();
    announceOpportunities();
    toast(msg, undoFn ? { undo: async () => { try { await undoFn(); await reload(); announceOpportunities(); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); } } } : undefined);
  };
  const seed = async () => {
    try {
      const out = await api.post('/opportunity-rules/starter');
      const missing = out.added.filter((a) => a.missing_codes.length);
      await done(`Added ${out.added.length} starter ${out.added.length === 1 ? 'opportunity' : 'opportunities'}${missing.length ? ` — add ${[...new Set(missing.flatMap((m) => m.missing_codes))].join(', ')} to your codes to use them all` : ''}`);
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  const setActive = async (r, active) => {
    try {
      await api.post(`/opportunity-rules/${r.id}/${active ? 'restore' : 'retire'}`);
      await done(active ? `${r.name} is back on` : `${r.name} retired`, () => api.post(`/opportunity-rules/${r.id}/${active ? 'retire' : 'restore'}`));
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card muted">Loading opportunities…</div>;
  const live = data.rules.filter((r) => r.active);
  const retired = data.rules.filter((r) => !r.active);
  return (
    <div className="card opp-rules">
      <div className="opp-rules-head">
        <div>
          <h2><Sparkles size={16} /> Opportunities</h2>
          <p className="muted">Work a patient is due for that isn’t booked yet — shown on the visit with what insurance covers, one click to add it. Checked against history, the chart, perio readings and insurance.</p>
        </div>
        {admin && (
          <div className="inline">
            {data.starters_missing.length > 0 && <button onClick={seed} title={data.starters_missing.join(', ')}><Sparkles size={14} /> Add starter opportunities ({data.starters_missing.length})</button>}
            <button className="primary" onClick={() => setEditing('new')}><Plus size={14} /> New</button>
          </div>
        )}
      </div>
      {editing === 'new' && <RuleForm conditions={data.conditions} scopes={data.scopes} initial={blank} onCancel={() => setEditing(null)} onSave={async (body) => { const r = await api.post('/opportunity-rules', body); setEditing(null); await done(`${r.name} added`, () => api.post(`/opportunity-rules/${r.id}/retire`)); }} />}
      {!data.rules.length && editing !== 'new' && <div className="muted opp-empty">No opportunities yet. {admin ? 'Start with the starter set — sealants, fluoride, x-rays, perio, night guards, unscheduled treatment and overdue recalls.' : 'Ask an administrator to set them up.'}</div>}
      <ul className="opp-rule-list">
        {live.map((r) => (editing === r.id
          ? <li key={r.id}><RuleForm conditions={data.conditions} scopes={data.scopes} initial={toForm(r)} onCancel={() => setEditing(null)} onSave={async (body) => { await api.put(`/opportunity-rules/${r.id}`, body); setEditing(null); await done(`${body.name} saved`, () => api.put(`/opportunity-rules/${r.id}`, toBody(toForm(r)))); }} /></li>
          : <RuleRow key={r.id} r={r} conditions={data.conditions} admin={admin} onEdit={() => setEditing(r.id)} onRetire={() => setActive(r, false)} />))}
      </ul>
      {retired.length > 0 && (
        <>
          <button className="link opp-retired-toggle" onClick={() => setShowRetired((v) => !v)}>{showRetired ? 'Hide' : 'Show'} retired ({retired.length})</button>
          {showRetired && <ul className="opp-rule-list retired">{retired.map((r) => <RuleRow key={r.id} r={r} conditions={data.conditions} admin={admin} onRestore={() => setActive(r, true)} />)}</ul>}
        </>
      )}
    </div>
  );
}

function RuleRow({ r, conditions, admin, onEdit, onRetire, onRestore }) {
  return (
    <li className="opp-rule">
      <div className="opp-rule-main">
        <strong>{r.name}</strong>
        <span className="muted">{summary(r)}</span>
        {r.conditions.length > 0 && <span className="opp-rule-conds">{r.conditions.map((c) => <span key={c} className="opp-chip" title={conditions[c]}>{c.replace(/_/g, ' ')}</span>)}</span>}
        {r.replaces?.length > 0 && <span className="muted">Replaces {r.replaces.join(', ')} on the visit</span>}
        {r.note && <span className="muted opp-rule-note">{r.note}</span>}
      </div>
      {admin && (
        <div className="inline">
          {onEdit && <button className="small" onClick={onEdit} aria-label={`Edit ${r.name}`}><Pencil size={13} /> Edit</button>}
          {onRetire && <button className="small" onClick={onRetire} aria-label={`Retire ${r.name}`} title="Stop suggesting it (it stays on record)"><Archive size={13} /> Retire</button>}
          {onRestore && <button className="small" onClick={onRestore}><ArchiveRestore size={13} /> Turn back on</button>}
        </div>
      )}
    </li>
  );
}

function RuleForm({ initial, conditions, scopes, onSave, onCancel }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggle = (c) => setF((x) => ({ ...x, conditions: x.conditions.includes(c) ? x.conditions.filter((y) => y !== c) : [...x.conditions, c] }));
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(toBody(f));
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="opp-rule-form" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}>
      <ErrorBox error={error} />
      <div className="opp-form-grid">
        <label className="wide">Name<input autoFocus value={f.name} onChange={set('name')} placeholder="e.g. Sealants on permanent molars" required /></label>
        <label>Codes<input value={f.codes} onChange={set('codes')} placeholder="D1351 (first one you have is used)" /></label>
        <label>Where<select value={f.scope} onChange={set('scope')}>{scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}</select></label>
        <label>Age from<input type="number" min="0" max="120" value={f.age_min} onChange={set('age_min')} placeholder="any" /></label>
        <label>Age to<input type="number" min="0" max="120" value={f.age_max} onChange={set('age_max')} placeholder="any" /></label>
        <label>Every (months)<input type="number" min="1" max="240" value={f.frequency_months} onChange={set('frequency_months')} placeholder="once" /></label>
        <label>Replaces on the visit<input value={f.replaces} onChange={set('replaces')} placeholder="e.g. D1110" /></label>
        <label className="wide">Note for the team<input value={f.note} onChange={set('note')} placeholder="Shown with the rule" /></label>
      </div>
      <fieldset className="opp-conds">
        <legend>Only when</legend>
        {Object.entries(conditions).map(([k, text]) => (
          <label key={k} className="opp-cond"><input type="checkbox" checked={f.conditions.includes(k)} onChange={() => toggle(k)} /> {text}</label>
        ))}
      </fieldset>
      <div className="inline">
        <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'} <kbd>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}↵</kbd></button>
        <button type="button" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
      </div>
    </form>
  );
}
