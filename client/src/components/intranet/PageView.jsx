import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, History, CheckCircle2, CalendarCheck, Archive, RotateCcw, Users, Paperclip, X, Printer, FolderOpen } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { useLiveEvents } from '../../live.js';
import { undoable, toast } from '../../toast.js';
import { fmtDate, fmtUtcDate, fmtUtcDateTime } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { MarkdownView, intranetChanged, lineDiff, openAttachment, scopeLabel } from './shared.jsx';
import { AckReport } from './Announcements.jsx';

// One office manual page: read it, acknowledge it, and (managers) edit, review, see history, restore, archive.
export default function PageView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { practice } = useAuth();
  const tz = practice?.timezone;
  const locations = useLookup('/locations');
  const { data: page, error, reload } = useApi(`/intranet/pages/${id}`);
  useLiveEvents((e) => e.type === 'intranet' && e.id === Number(id) && reload());
  const [panel, setPanel] = useState(null); // 'history' | 'acks'
  const manager = !!page?.can_manage;
  const active = page?.status === 'active';
  useShortcuts([
    { combo: 'e', handler: () => nav(`/intranet/pages/${id}/edit`), label: 'Edit this page', section: 'Office manual', enabled: manager && active },
    { combo: 'h', handler: () => setPanel(panel === 'history' ? null : 'history'), label: 'Version history', section: 'Office manual', enabled: !!page },
    { combo: 'escape', handler: () => setPanel(null), enabled: !!panel },
  ]);

  const done = () => { reload(); intranetChanged(); };
  const acknowledge = async () => {
    try { await api.post(`/intranet/pages/${id}/ack`); toast('Thanks — recorded as read and acknowledged'); done(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const reviewed = async () => {
    try { const p = await api.post(`/intranet/pages/${id}/reviewed`); toast(p.review_due ? `Marked as reviewed — next review ${fmtDate(p.review_due)}` : 'Marked as reviewed'); done(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const archive = () => undoable(`Archived: ${page.title}`,
    async () => { await api.post(`/intranet/pages/${id}/archive`); done(); },
    async () => { await api.post(`/intranet/pages/${id}/unarchive`); done(); }).catch(() => {});
  const unarchive = async () => { try { await api.post(`/intranet/pages/${id}/unarchive`); toast('Back in the office manual'); done(); } catch (e) { toast(e.message, { tone: 'error' }); } };

  if (error) return <ErrorBox error={error} />;
  if (!page) return <div className="muted" style={{ padding: 24 }}>Loading…</div>;
  return (
    <div className={`intra-page-layout${panel ? ' with-panel' : ''}`}>
      <article className="card intra-page">
        <div className="intra-crumbs muted">
          <Link to="/intranet/pages">Office manual</Link>
          {page.section && <> / <Link to={`/intranet/sections/${page.section.id}`}><FolderOpen size={12} aria-hidden /> {page.section.name}</Link></>}
        </div>
        {!active && <div className="intra-banner warn">This page is archived — only managers can see it. {manager && <button className="small" onClick={unarchive}>Bring it back</button>}</div>}
        <header className="intra-page-head">
          <h1>{page.title}</h1>
          <div className="actions intra-no-print">
            {manager && active && <button onClick={() => nav(`/intranet/pages/${id}/edit`)} title="Edit (E)"><Pencil size={14} aria-hidden /> Edit <kbd>E</kbd></button>}
            <button onClick={() => setPanel(panel === 'history' ? null : 'history')} title="History (H)"><History size={14} aria-hidden /> History</button>
            <button className="icon" onClick={() => window.print()} title="Print" aria-label="Print"><Printer size={14} /></button>
          </div>
        </header>
        <div className="muted intra-meta">
          Version {page.version} · updated {fmtUtcDate(page.updated_at, tz)}{page.updated_by_name ? ` by ${page.updated_by_name}` : ''}
          {page.last_reviewed_at ? ` · last reviewed ${fmtUtcDate(page.last_reviewed_at, tz)}${page.last_reviewed_by_name ? ` by ${page.last_reviewed_by_name}` : ''}` : ' · not reviewed yet'}
          {page.review_due ? <span className={page.review_overdue ? 'intra-overdue' : ''}> · review {page.review_overdue ? 'overdue since' : 'due'} {fmtDate(page.review_due)}</span> : null}
          {manager && scopeLabel(page, locations) ? ` · for ${scopeLabel(page, locations)}` : ''}
        </div>

        {page.ack_version && active ? (
          page.acknowledged
            ? <div className="intra-banner ok"><CheckCircle2 size={16} aria-hidden /> You’ve read and acknowledged this page.</div>
            : <div className="intra-banner info intra-no-print"><span>Please read this page, then confirm you’ve read it.</span><button className="primary" onClick={acknowledge}>I’ve read and understood this</button></div>
        ) : null}

        <MarkdownView text={page.body} />

        {page.attachments?.length > 0 && (
          <div className="intra-attachments">
            <h2 className="intra-h2"><Paperclip size={15} aria-hidden /> Files</h2>
            <ul>
              {page.attachments.map((a) => (
                <li key={a.id}><button className="link" onClick={() => openAttachment(a.id).catch((e) => toast(e.message, { tone: 'error' }))}>{a.filename}</button> <span className="muted">{Math.max(1, Math.round(a.size / 1024))} KB</span></li>
              ))}
            </ul>
          </div>
        )}

        {manager && active && (
          <footer className="intra-page-tools intra-no-print">
            <button className="small" onClick={reviewed}><CalendarCheck size={14} aria-hidden /> Still correct — mark reviewed</button>
            {page.ack_version && <button className="small" onClick={() => setPanel(panel === 'acks' ? null : 'acks')}><Users size={14} aria-hidden /> Who’s read it</button>}
            <button className="small" onClick={archive}><Archive size={14} aria-hidden /> Archive</button>
          </footer>
        )}
      </article>
      {panel === 'history' && <HistoryPanel page={page} manager={manager && active} onClose={() => setPanel(null)} onRestored={done} />}
      {panel === 'acks' && <AcksPanel pageId={page.id} onClose={() => setPanel(null)} />}
    </div>
  );
}

function AcksPanel({ pageId, onClose }) {
  const { data, error } = useApi(`/intranet/pages/${pageId}/acks`);
  return (
    <aside className="card intra-side-panel" aria-label="Who has read this page">
      <div className="intra-section-head"><h2>Who’s read it</h2><button className="small icon" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      <ErrorBox error={error} />
      {data && <AckReport report={data} />}
      {data?.acknowledged.length > 0 && (
        <ul className="intra-list">
          {data.acknowledged.map((p) => <li key={p.user_id}><span>{p.name}</span><span className="muted">{fmtUtcDateTime(p.acknowledged_at)}</span></li>)}
        </ul>
      )}
    </aside>
  );
}

// Every saved version; pick one to see what changed from the one before it, and restore it (as a new version).
function HistoryPanel({ page, manager, onClose, onRestored }) {
  const { practice } = useAuth();
  const { data: versions, error, reload } = useApi(`/intranet/pages/${page.id}/versions`);
  const [pick, setPick] = useState(null);
  const [texts, setTexts] = useState({});
  const [mode, setMode] = useState('changes');
  const load = useCallback(async (v) => {
    if (!v || texts[v]) return;
    const row = await api.get(`/intranet/pages/${page.id}/versions/${v}`);
    setTexts((t) => ({ ...t, [v]: row }));
  }, [page.id, texts]);
  useEffect(() => { if (versions?.length && !pick) setPick(versions[0].version); }, [versions, pick]);
  useEffect(() => {
    if (!pick) return;
    load(pick).catch(() => {});
    if (pick > 1) load(pick - 1).catch(() => {});
  }, [pick, load]);
  const restore = (v) => undoable(`Restored version ${v} (saved as version ${page.version + 1})`,
    async () => { await api.post(`/intranet/pages/${page.id}/restore`, { version: v }); reload(); onRestored(); setPick(null); },
    async () => { await api.post(`/intranet/pages/${page.id}/restore`, { version: page.version }); reload(); onRestored(); setPick(null); }).catch(() => {});

  const cur = texts[pick];
  const prev = pick > 1 ? texts[pick - 1] : { body: '', title: '' };
  const diff = cur && prev ? lineDiff(prev.body, cur.body) : null;
  return (
    <aside className="card intra-side-panel intra-history" aria-label="Version history">
      <div className="intra-section-head"><h2>History</h2><button className="small icon" onClick={onClose} aria-label="Close (Esc)"><X size={14} /></button></div>
      <ErrorBox error={error} />
      <ol className="intra-versions">
        {versions?.map((v) => (
          <li key={v.version}>
            <button className={pick === v.version ? 'active' : ''} onClick={() => setPick(v.version)}>
              <strong>Version {v.version}{v.version === page.version ? ' · current' : ''}</strong>
              <small className="muted">{fmtUtcDateTime(v.created_at, practice?.timezone)} · {v.created_by_name || 'Unknown'}</small>
              {v.change_note && <small>{v.change_note}</small>}
            </button>
          </li>
        ))}
      </ol>
      {cur && (
        <div className="intra-version-detail">
          <div className="intra-section-head">
            <div className="seg">
              <button className={mode === 'changes' ? 'active' : ''} onClick={() => setMode('changes')}>Changes</button>
              <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>Full page</button>
            </div>
            {manager && pick !== page.version && <button className="small" onClick={() => restore(pick)}><RotateCcw size={14} aria-hidden /> Restore this version</button>}
          </div>
          {prev && cur.title !== prev.title && pick > 1 && <p className="muted">Title: <del>{prev.title}</del> → <ins>{cur.title}</ins></p>}
          {mode === 'text' ? <MarkdownView text={cur.body} className="compact" /> : (
            <pre className="intra-diff" aria-label={`Changes in version ${pick}`}>
              {diff?.every((d) => d.op === ' ') ? <span className="muted">No text changes in this version.</span> : diff?.map((d, i) => (
                <div key={i} className={d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'same'}>{d.op === ' ' ? '  ' : `${d.op} `}{d.t || ' '}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
}
