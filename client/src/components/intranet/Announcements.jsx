import { useState } from 'react';
import { Megaphone, Archive, Users, Pencil } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcut } from '../../shortcuts.js';
import { undoable, toast } from '../../toast.js';
import { fmtDate, fmtUtcDate, shiftDate, practiceToday } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { MarkdownView, ScopePicker, scopeLabel, intranetChanged } from './shared.jsx';

// New or edited announcement, inline (no dialog). Shows until the date chosen (a week by default).
export function AnnouncementForm({ initial, onDone, onCancel }) {
  const { practice } = useAuth();
  const locations = useLookup('/locations');
  const [f, setF] = useState(() => ({
    title: initial?.title || '', body: initial?.body || '', requires_ack: !!initial?.requires_ack, pinned: initial ? !!initial.pinned : true,
    expires_on: initial ? initial.expires_on || '' : shiftDate(practiceToday(practice?.timezone), 7), location_ids: initial?.location_ids || [], roles: initial?.roles || [],
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { ...f, expires_on: f.expires_on || null };
    const saved = initial ? await api.put(`/intranet/announcements/${initial.id}`, body) : await api.post('/intranet/announcements', body);
    toast(initial ? 'Announcement updated' : 'Announcement posted');
    onDone?.(saved);
  });
  useShortcut('mod+s', () => submit(), { label: 'Post the announcement', section: 'Intranet', inInputs: true });
  // Ctrl/⌘+Enter posts too (as everywhere else a form is finished from the keyboard).
  useShortcut('mod+enter', () => f.title.trim() && submit(), { label: 'Post the announcement', section: 'Intranet', inInputs: true });
  return (
    <form className="intra-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2><Megaphone size={18} aria-hidden /> {initial ? 'Edit announcement' : 'New announcement'}</h2>
      <ErrorBox error={error} />
      <label>Title<input autoFocus value={f.title} onChange={set('title')} placeholder="e.g. New sterilizer training Thursday at noon" maxLength={160} required /></label>
      <label>Message <span className="muted">(optional · **bold**, lists and links work)</span><textarea rows={4} value={f.body} onChange={set('body')} /></label>
      <div className="intra-form-row">
        <label>Show until<input type="date" value={f.expires_on} onChange={set('expires_on')} /></label>
        <label className="check"><input type="checkbox" checked={f.requires_ack} onChange={set('requires_ack')} /> Ask everyone to acknowledge it</label>
        <label className="check"><input type="checkbox" checked={f.pinned} onChange={set('pinned')} /> Pin to the top</label>
      </div>
      <ScopePicker value={f} onChange={(v) => setF({ ...f, ...v })} locations={locations} />
      <div className="actions">
        <button className="primary" disabled={busy || !f.title.trim()}>{initial ? 'Save' : 'Post'} <kbd>Ctrl/⌘ Enter</kbd></button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// Managers: every current announcement, who has acknowledged it, edit and archive (with Undo).
export default function Announcements() {
  const { practice, can } = useAuth();
  const locations = useLookup('/locations');
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useApi(`/intranet/announcements${archived ? '?archived=1' : '?all=1'}`);
  const [editing, setEditing] = useState(null);
  const [report, setReport] = useState(null);
  if (!can('intranet:manage')) return <div className="card muted">Only managers can manage announcements.</div>;
  const archive = (a) => undoable(`Archived: ${a.title}`,
    async () => { await api.post(`/intranet/announcements/${a.id}/archive`); reload(); intranetChanged(); },
    async () => { await api.post(`/intranet/announcements/${a.id}/restore`); reload(); intranetChanged(); }).catch(() => {});
  const showReport = async (a) => {
    if (report?.id === a.id) return setReport(null);
    try { setReport({ id: a.id, ...(await api.get(`/intranet/announcements/${a.id}/acks`)) }); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <>
      <div className="page-header">
        <h1>Announcements</h1>
        <div className="actions">
          <div className="seg">
            <button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>Current</button>
            <button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>Archived</button>
          </div>
          {!archived && editing !== 'new' && <button className="primary" onClick={() => setEditing('new')}>+ Announcement</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      {editing === 'new' && <div className="card intra-panel"><AnnouncementForm onDone={() => { setEditing(null); reload(); intranetChanged(); }} onCancel={() => setEditing(null)} /></div>}
      {data?.length === 0 && <div className="card muted">{archived ? 'Nothing archived.' : 'No announcements right now.'}</div>}
      <div className="intra-stack">
        {data?.map((a) => (editing === a.id ? (
          <div key={a.id} className="card intra-panel"><AnnouncementForm initial={a} onDone={() => { setEditing(null); reload(); intranetChanged(); }} onCancel={() => setEditing(null)} /></div>
        ) : (
          <article key={a.id} className="card intra-row-card">
            <div className="intra-row-main">
              <h3>{a.title} {a.requires_ack ? <span className="badge">sign-off</span> : null} {a.expires_on && a.expires_on < practiceToday(practice?.timezone) ? <span className="badge">expired</span> : null}</h3>
              {a.body && <MarkdownView text={a.body} className="compact" />}
              <div className="muted intra-meta">
                {a.created_by_name} · {fmtUtcDate(a.created_at, practice?.timezone)}{a.expires_on ? ` · shows until ${fmtDate(a.expires_on)}` : ''}{scopeLabel(a, locations) ? ` · ${scopeLabel(a, locations)}` : ''}
              </div>
              {report?.id === a.id && <AckReport report={report} />}
            </div>
            {!archived && (
              <div className="intra-row-actions">
                {a.requires_ack ? <button className="small" onClick={() => showReport(a)}><Users size={14} aria-hidden /> Who’s read it</button> : null}
                <button className="small" onClick={() => setEditing(a.id)}><Pencil size={14} aria-hidden /> Edit</button>
                <button className="small" onClick={() => archive(a)}><Archive size={14} aria-hidden /> Archive</button>
              </div>
            )}
          </article>
        )))}
      </div>
    </>
  );
}

export function AckReport({ report }) {
  const total = report.acknowledged.length + report.missing.length;
  return (
    <div className="intra-ack-report">
      <div className="intra-progress" aria-label={`${report.acknowledged.length} of ${total} acknowledged`}><span style={{ width: `${total ? (report.acknowledged.length / total) * 100 : 0}%` }} /></div>
      <p><strong>{report.acknowledged.length} of {total}</strong> have acknowledged{report.version ? ` version ${report.version}` : ''}.</p>
      {report.missing.length > 0 && <p><span className="muted">Still to read:</span> {report.missing.map((p) => p.name).join(', ')}</p>}
    </div>
  );
}
