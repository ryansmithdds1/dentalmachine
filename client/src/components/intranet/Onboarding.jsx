import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, Plus, Trash2, ArrowUp, ArrowDown, Pencil, Archive, UserPlus, BookOpen, XCircle } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcut } from '../../shortcuts.js';
import { undoable, toast } from '../../toast.js';
import { fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { ROLE_LABELS, intranetChanged } from './shared.jsx';

// One person's onboarding: progress bar and the checklist, ticked by them (or a manager). Items can link to
// the office manual page to read.
export function OnboardingCard({ onboarding: o, onChange, compact = false, showName = false }) {
  const [busy, setBusy] = useState(null);
  const tick = async (item) => {
    setBusy(item.id);
    try {
      const out = await api.post(`/intranet/onboardings/${o.id}/items/${item.id}`, { done: !item.done_at });
      if (out.status === 'completed' && o.status !== 'completed') toast(`Onboarding complete: ${o.title}`);
      onChange?.(out);
      intranetChanged();
    } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(null); }
  };
  return (
    <div className={`intra-onboarding${compact ? ' compact' : ''}`}>
      <div className="intra-onboarding-head">
        <strong>{showName ? `${o.user_name} · ` : ''}{o.title}</strong>
        <span className="muted">{o.done}/{o.total}{o.due_on ? ` · by ${fmtDate(o.due_on)}` : ''}</span>
      </div>
      <div className="intra-progress" role="progressbar" aria-valuenow={o.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${o.percent}% done`}><span style={{ width: `${o.percent}%` }} /></div>
      <ul className="intra-steps">
        {o.items.map((i) => (
          <li key={i.id} className={i.done_at ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={!!i.done_at} disabled={busy === i.id || o.status === 'cancelled'} onChange={() => tick(i)} />
              <span>{i.title}</span>
            </label>
            {i.page_id && <Link to={`/intranet/pages/${i.page_id}`} className="intra-step-link"><BookOpen size={12} aria-hidden /> {i.page_title || 'Read'}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Onboarding() {
  const { can } = useAuth();
  const manager = can('intranet:manage');
  const { data: mine, error, reload } = useApi('/intranet/onboardings');
  return (
    <>
      <div className="page-header"><h1>Onboarding</h1></div>
      <ErrorBox error={error} />
      {mine?.length > 0 && (
        <section className="card">
          <h2 className="intra-h2"><GraduationCap size={16} aria-hidden /> Your onboarding</h2>
          {mine.map((o) => <OnboardingCard key={o.id} onboarding={o} onChange={reload} />)}
        </section>
      )}
      {!manager && mine && !mine.length && <div className="card muted">Nothing assigned to you right now.</div>}
      {manager && <ManageOnboarding />}
    </>
  );
}

function ManageOnboarding() {
  const { data: lists, reload: reloadLists } = useApi('/intranet/checklists');
  const [status, setStatus] = useState('active');
  const { data: all, reload } = useApi(`/intranet/onboardings?all=1&status=${status}`);
  const { data: people } = useApi('/intranet/people');
  const { data: pages } = useApi('/intranet/pages?all=1');
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const cancel = (o) => undoable(`Cancelled onboarding for ${o.user_name}`,
    async () => { await api.post(`/intranet/onboardings/${o.id}/cancel`); reload(); },
    null).catch(() => {});
  const archive = (c) => undoable(`Archived checklist: ${c.title}`,
    async () => { await api.post(`/intranet/checklists/${c.id}/archive`); reloadLists(); },
    null).catch(() => {});
  return (
    <>
      <section className="card">
        <div className="intra-section-head">
          <h2 className="intra-h2"><UserPlus size={16} aria-hidden /> New hires</h2>
          <div className="actions">
            <div className="seg">
              {[['active', 'In progress'], ['completed', 'Done'], ['cancelled', 'Cancelled']].map(([k, l]) => <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{l}</button>)}
            </div>
            {lists?.length > 0 && <button className="primary small" onClick={() => setAssigning(!assigning)}><Plus size={14} aria-hidden /> Assign a checklist</button>}
          </div>
        </div>
        {assigning && <AssignForm lists={lists} people={people} onDone={() => { setAssigning(false); reload(); }} onCancel={() => setAssigning(false)} />}
        {all && !all.length && <p className="muted">{status === 'active' ? 'No one is onboarding right now.' : 'None.'}</p>}
        <div className="intra-onboarding-grid">
          {all?.map((o) => (
            <div key={o.id} className="intra-onboarding-item">
              <OnboardingCard onboarding={o} onChange={reload} showName compact />
              {o.status === 'active' && <button className="small" onClick={() => cancel(o)}><XCircle size={14} aria-hidden /> Cancel</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="intra-section-head">
          <h2 className="intra-h2">Onboarding checklists</h2>
          {editing !== 'new' && <button className="small" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> Checklist</button>}
        </div>
        {editing === 'new' && <ChecklistForm pages={pages} onDone={() => { setEditing(null); reloadLists(); }} onCancel={() => setEditing(null)} />}
        {lists && !lists.length && editing !== 'new' && <p className="muted">Make a checklist for new hires (for example “Front desk — first week”), linking the office manual pages they should read.</p>}
        <ul className="intra-stack">
          {lists?.map((c) => (editing === c.id ? (
            <li key={c.id}><ChecklistForm initial={c} pages={pages} onDone={() => { setEditing(null); reloadLists(); reload(); }} onCancel={() => setEditing(null)} /></li>
          ) : (
            <li key={c.id} className="intra-row-card">
              <div className="intra-row-main">
                <h3>{c.title}</h3>
                {c.description && <p className="muted">{c.description}</p>}
                <ol className="intra-checklist-preview">{c.items.map((i) => <li key={i.id}>{i.title}{i.page_title ? <span className="muted"> · {i.page_title}</span> : null}</li>)}</ol>
              </div>
              <div className="intra-row-actions">
                <button className="small" onClick={() => setEditing(c.id)}><Pencil size={14} aria-hidden /> Edit</button>
                <button className="small" onClick={() => archive(c)}><Archive size={14} aria-hidden /> Archive</button>
              </div>
            </li>
          )))}
        </ul>
      </section>
    </>
  );
}

function AssignForm({ lists, people, onDone, onCancel }) {
  const [f, setF] = useState({ checklist_id: lists?.[0]?.id || '', user_id: '', due_on: '' });
  const { submit, busy, error } = useSubmit(async () => {
    const out = await api.post('/intranet/onboardings', f);
    toast(out.already ? `${out.user_name} already has this checklist` : `Assigned to ${out.user_name}`);
    onDone();
  });
  return (
    <form className="intra-form intra-panel" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="intra-form-row">
        <label className="grow">New team member
          <select autoFocus value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} required>
            <option value="">Choose…</option>
            {people?.map((p) => <option key={p.id} value={p.id}>{p.name} ({ROLE_LABELS[p.role] || p.role})</option>)}
          </select>
        </label>
        <label className="grow">Checklist
          <select value={f.checklist_id} onChange={(e) => setF({ ...f, checklist_id: e.target.value })}>{lists?.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
        </label>
        <label>Finish by <span className="muted">(optional)</span><input type="date" value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></label>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy || !f.user_id}>Assign</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ChecklistForm({ initial, pages, onDone, onCancel }) {
  const [f, setF] = useState(() => ({ title: initial?.title || '', description: initial?.description || '', items: initial?.items?.map((i) => ({ id: i.id, title: i.title, page_id: i.page_id || '' })) || [{ title: '', page_id: '' }] }));
  const setItem = (n, patch) => setF({ ...f, items: f.items.map((it, i) => (i === n ? { ...it, ...patch } : it)) });
  const move = (n, d) => {
    const items = [...f.items];
    [items[n], items[n + d]] = [items[n + d], items[n]];
    setF({ ...f, items });
  };
  const { submit, busy, error } = useSubmit(async () => {
    const body = { title: f.title, description: f.description, items: f.items.filter((i) => i.title.trim()).map((i) => ({ ...(i.id ? { id: i.id } : {}), title: i.title, page_id: i.page_id || null })) };
    if (initial) await api.put(`/intranet/checklists/${initial.id}`, body);
    else await api.post('/intranet/checklists', body);
    toast('Checklist saved');
    onDone();
  });
  useShortcut('mod+s', () => submit(), { label: 'Save the checklist', section: 'Onboarding', inInputs: true });
  return (
    <form className="intra-form intra-panel" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Checklist name<input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Front desk — first week" required maxLength={160} /></label>
      <label>Description <span className="muted">(optional)</span><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} /></label>
      <ol className="intra-item-editor">
        {f.items.map((it, n) => (
          <li key={it.id || `n${n}`}>
            <input value={it.title} onChange={(e) => setItem(n, { title: e.target.value })} placeholder="e.g. Read the emergency plan" aria-label={`Item ${n + 1}`}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setF({ ...f, items: [...f.items.slice(0, n + 1), { title: '', page_id: '' }, ...f.items.slice(n + 1)] }); } }} />
            <select value={it.page_id} onChange={(e) => setItem(n, { page_id: e.target.value, title: it.title || pages?.find((p) => String(p.id) === e.target.value)?.title || '' })} aria-label="Linked page">
              <option value="">No page</option>
              {pages?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <button type="button" className="small icon" aria-label="Move up" disabled={!n} onClick={() => move(n, -1)}><ArrowUp size={14} /></button>
            <button type="button" className="small icon" aria-label="Move down" disabled={n === f.items.length - 1} onClick={() => move(n, 1)}><ArrowDown size={14} /></button>
            <button type="button" className="small icon" aria-label="Remove item" onClick={() => setF({ ...f, items: f.items.filter((_, i) => i !== n) })}><Trash2 size={14} /></button>
          </li>
        ))}
      </ol>
      <button type="button" className="small" onClick={() => setF({ ...f, items: [...f.items, { title: '', page_id: '' }] })}><Plus size={14} aria-hidden /> Item</button>
      <p className="muted">Removed items are kept in the history of anyone who already ticked them.</p>
      <div className="actions">
        <button className="primary" disabled={busy}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
