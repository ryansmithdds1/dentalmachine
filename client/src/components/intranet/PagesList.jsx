import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Search, Plus, FileText, FolderPlus, Archive, RotateCcw, LayoutTemplate, CheckCircle2, CalendarClock, Pencil } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { undoable, toast } from '../../toast.js';
import { fmtDate, fmtUtcDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { intranetChanged, scopeLabel, useIntranetRefresh, useSlashToSearch } from './shared.jsx';

// The office manual: pages by section, search across titles and text, and (for managers) templates,
// sections and archived pages.
export default function PagesList({ search: searchMode = false }) {
  const nav = useNavigate();
  const { practice, can } = useAuth();
  const manager = can('intranet:manage');
  const locations = useLookup('/locations');
  const { sectionId } = useParams();
  const [params, setParams] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const { data: sections, reload: reloadSections } = useApi('/intranet/sections');
  const { data: pages, error, reload } = useApi(`/intranet/pages${archived ? '?archived=1' : manager ? '?all=1' : ''}`);
  const refresh = () => { reload(); reloadSections(); };
  useIntranetRefresh(reload);
  const [q, setQ] = useState(params.get('q') || '');
  const [hits, setHits] = useState(null);
  const [sel, setSel] = useState(0);
  const box = useRef(null);
  useSlashToSearch(box);
  useEffect(() => { if (searchMode) box.current?.focus(); }, [searchMode]);

  // Full-text search runs on the server (only pages this person may see).
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits(null); return undefined; }
    const t = setTimeout(() => api.get(`/intranet/search?q=${encodeURIComponent(term)}`).then((r) => { setHits(r); setSel(0); }).catch(() => setHits([])), 150);
    return () => clearTimeout(t);
  }, [q]);

  const section = sectionId ? sections?.find((s) => s.id === Number(sectionId)) : null;
  const onlyNone = params.get('section') === 'none';
  const list = useMemo(() => (pages || []).filter((p) => (section ? p.section_id === section.id : onlyNone ? !p.section_id || !sections?.some((s) => s.id === p.section_id) : true)), [pages, section, onlyNone, sections]);
  const groups = useMemo(() => {
    if (section || onlyNone) return [[section || { id: 0, name: 'Other pages' }, list]];
    const out = (sections || []).map((s) => [s, list.filter((p) => p.section_id === s.id)]).filter(([, l]) => l.length || manager);
    const loose = list.filter((p) => !p.section_id || !sections?.some((s) => s.id === p.section_id));
    if (loose.length) out.push([{ id: 0, name: 'Other pages' }, loose]);
    return out;
  }, [list, sections, section, onlyNone, manager]);

  useShortcuts([
    { combo: 'n', handler: () => nav(`/intranet/new${section ? `?section=${section.id}` : ''}`), label: 'New page', section: 'Office manual', enabled: manager },
  ]);

  // Sections are named inline (no dialog): { id: 'new' | sectionId, name }.
  const [draft, setDraft] = useState(null);
  const saveSection = async () => {
    const name = draft?.name?.trim();
    if (!name) return setDraft(null);
    try {
      if (draft.id === 'new') await api.post('/intranet/sections', { name });
      else await api.put(`/intranet/sections/${draft.id}`, { name });
      setDraft(null);
      refresh();
      intranetChanged();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const sectionInput = (
    <form className="intra-inline" onSubmit={(e) => { e.preventDefault(); saveSection(); }}>
      <input autoFocus value={draft?.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Section name (e.g. Front desk)" maxLength={80}
        aria-label="Section name" onKeyDown={(e) => e.key === 'Escape' && setDraft(null)} />
      <button className="small primary">Save</button>
      <button type="button" className="small" onClick={() => setDraft(null)}>Cancel</button>
    </form>
  );
  const archiveSection = (s) => undoable(`Archived section: ${s.name}`,
    async () => { await api.post(`/intranet/sections/${s.id}/archive`); refresh(); intranetChanged(); },
    async () => { await api.post(`/intranet/sections/${s.id}/restore`); refresh(); intranetChanged(); }).catch(() => {});
  const unarchive = async (p) => { try { await api.post(`/intranet/pages/${p.id}/unarchive`); toast(`Back in the manual: ${p.title}`); refresh(); intranetChanged(); } catch (e) { toast(e.message, { tone: 'error' }); } };

  return (
    <>
      <div className="page-header">
        <h1>{section ? section.name : onlyNone ? 'Other pages' : 'Office manual'}</h1>
        <div className="actions">
          {manager && (
            <>
              <div className="seg">
                <button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>Current</button>
                <button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>Archived</button>
              </div>
              <button onClick={() => setParams(params.get('templates') ? {} : { templates: '1' })}><LayoutTemplate size={14} aria-hidden /> Templates</button>
              {!section && <button onClick={() => setDraft({ id: 'new', name: '' })}><FolderPlus size={14} aria-hidden /> Section</button>}
              <button className="primary" onClick={() => nav(`/intranet/new${section ? `?section=${section.id}` : ''}`)}><Plus size={14} aria-hidden /> Page <kbd>N</kbd></button>
            </>
          )}
        </div>
      </div>

      <form className="intra-search wide" role="search" onSubmit={(e) => { e.preventDefault(); if (hits?.[sel]) nav(`/intranet/pages/${hits[sel].id}`); }}>
        <Search size={16} aria-hidden />
        <input ref={box} value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}, { replace: true }); }}
          placeholder="Search every page (titles and text)" aria-label="Search the office manual"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && hits?.length) { e.preventDefault(); setSel(Math.min(sel + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp' && hits?.length) { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
            if (e.key === 'Escape') setQ('');
          }} />
        <kbd>/</kbd>
      </form>

      {draft?.id === 'new' && <div className="card intra-panel">{sectionInput}</div>}
      {manager && params.get('templates') && <Templates onAdded={(p) => { refresh(); intranetChanged(); nav(`/intranet/pages/${p.id}`); }} />}
      <ErrorBox error={error} />

      {hits ? (
        <section className="card">
          <h2 className="intra-h2">{hits.length ? `${hits.length} page${hits.length === 1 ? '' : 's'} found` : `Nothing found for “${q}”`}</h2>
          <ul className="intra-results">
            {hits.map((h, i) => (
              <li key={h.id} className={i === sel ? 'active' : ''}>
                <Link to={`/intranet/pages/${h.id}`}><strong>{h.title}</strong>{h.section_name ? <span className="muted"> · {h.section_name}</span> : null}</Link>
                {h.snippet && <p className="muted">{h.snippet}</p>}
              </li>
            ))}
          </ul>
        </section>
      ) : archived ? (
        <section className="card">
          {!pages?.length ? <p className="muted">Nothing archived.</p> : (
            <ul className="intra-list">
              {pages.map((p) => <li key={p.id}><Link to={`/intranet/pages/${p.id}`}>{p.title}</Link><button className="small" onClick={() => unarchive(p)}><RotateCcw size={14} aria-hidden /> Bring back</button></li>)}
            </ul>
          )}
        </section>
      ) : (
        <>
          {pages && !pages.length && <div className="card muted">{manager ? 'No pages yet. Start with a template (opening checklist, medical emergency, sterilization…) and adapt it, or write your own.' : 'No pages yet.'}</div>}
          {groups.map(([s, items]) => (
            <section key={s.id} className="card">
              <div className="intra-section-head">
                {draft?.id === s.id ? sectionInput : <h2 className="intra-h2">{!section && s.id ? <Link to={`/intranet/sections/${s.id}`}>{s.name}</Link> : s.name}</h2>}
                {manager && s.id ? (
                  <div className="actions">
                    <button className="small icon" title="Rename section" aria-label="Rename section" onClick={() => setDraft({ id: s.id, name: s.name })}><Pencil size={14} /></button>
                    {!items.length && <button className="small icon" title="Archive section" aria-label="Archive section" onClick={() => archiveSection(s)}><Archive size={14} /></button>}
                  </div>
                ) : null}
              </div>
              {!items.length ? <p className="muted">No pages in this section yet.</p> : (
                <ul className="intra-pages">
                  {items.map((p) => (
                    <li key={p.id}>
                      <Link to={`/intranet/pages/${p.id}`} className="intra-page-link">
                        <FileText size={16} aria-hidden />
                        <span>
                          <strong>{p.title}</strong>
                          <small className="muted">
                            Updated {fmtUtcDate(p.updated_at, practice?.timezone)}{p.updated_by_name ? ` by ${p.updated_by_name}` : ''}
                            {p.ack_version ? <> · <CheckCircle2 size={11} aria-hidden /> sign-off</> : null}
                            {manager && p.review_due ? <> · <CalendarClock size={11} aria-hidden /> review {fmtDate(p.review_due)}</> : null}
                            {manager && scopeLabel(p, locations) ? ` · ${scopeLabel(p, locations)}` : ''}
                            {p.template_key ? ' · from a template' : ''}
                          </small>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </>
  );
}

function Templates({ onAdded }) {
  const { data, error, reload } = useApi('/intranet/templates');
  const [busy, setBusy] = useState(null);
  const add = async (t) => {
    setBusy(t.key);
    try {
      const p = await api.post(`/intranet/templates/${t.key}`);
      toast(p.already ? 'You already have this one' : `Added “${t.title}” — adapt it to your office`);
      reload();
      onAdded(p);
    } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(null); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <section className="card intra-panel">
      <h2 className="intra-h2"><LayoutTemplate size={16} aria-hidden /> Starter templates</h2>
      <p className="muted">Ready-made pages to adapt to your office. Each one starts with a note reminding you to change the steps, names and numbers to how you work.</p>
      <div className="intra-templates">
        {data.map((t) => (
          <div key={t.key} className="intra-template">
            <strong>{t.title}</strong>
            <small className="muted">{t.section}{t.requires_ack ? ' · asks for sign-off' : ''}</small>
            {t.page_id
              ? <Link className="button small" to={`/intranet/pages/${t.page_id}`}>{t.status === 'archived' ? 'Added (archived)' : 'Open'}</Link>
              : <button className="small primary" disabled={busy === t.key} onClick={() => add(t)}>Add</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
