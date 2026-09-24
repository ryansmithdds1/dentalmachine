import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Plus, Pin, PinOff, Pencil, Archive, ArrowUp, ArrowDown, ExternalLink, Sparkles, Check, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useRemembered } from '../../prefs.js';
import { useShortcut } from '../../shortcuts.js';
import { undoable, toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { CATEGORIES, LinkIcon, ScopePicker, hostOf, intranetChanged, openExternal, scopeLabel, useIntranetRefresh, useSlashToSearch } from './shared.jsx';

// Office links: the websites the team uses (insurance portals, labs, supplies, payroll), by category.
// Everyone can open them; managers add, edit, pin, reorder and archive them.
export default function LinksPage() {
  const { can } = useAuth();
  const manager = can('intranet:manage');
  const locations = useLookup('/locations');
  const [params, setParams] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useApi(`/intranet/links${archived ? '?archived=1' : manager ? '?all=1' : ''}`);
  useIntranetRefresh(reload);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const search = useRef(null);
  useSlashToSearch(search);
  const adding = params.get('add') === '1';
  const suggesting = params.get('suggest') === '1';
  const changed = () => { reload(); intranetChanged(); };

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (data || []).filter((l) => !ql || `${l.title} ${l.url} ${l.category}`.toLowerCase().includes(ql));
  }, [data, q]);
  useShortcut('n', () => setParams({ add: '1' }), { label: 'Add a link', section: 'Links', enabled: manager && !adding });

  const archive = (l) => undoable(`Archived: ${l.title}`,
    async () => { await api.post(`/intranet/links/${l.id}/archive`); changed(); },
    async () => { await api.post(`/intranet/links/${l.id}/restore`); changed(); }).catch(() => {});
  const restore = async (l) => { try { await api.post(`/intranet/links/${l.id}/restore`); toast(`Restored: ${l.title}`); changed(); } catch (e) { toast(e.message, { tone: 'error' }); } };
  const pin = (l) => undoable(l.pinned ? `Unpinned: ${l.title}` : `Pinned to the intranet home: ${l.title}`,
    async () => { await api.put(`/intranet/links/${l.id}`, { pinned: !l.pinned }); changed(); },
    async () => { await api.put(`/intranet/links/${l.id}`, { pinned: !!l.pinned }); changed(); }).catch(() => {});
  const move = async (list, i, dir) => {
    const ids = list.map((l) => l.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const others = (data || []).filter((l) => !ids.includes(l.id)).map((l) => l.id);
    try { await api.put('/intranet/links-order', { ids: [...ids, ...others] }); changed(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };

  return (
    <>
      <div className="page-header">
        <h1>Office links</h1>
        <div className="actions">
          <label className="intra-search small">
            <Search size={15} aria-hidden />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a link"
              aria-label="Find a link" onKeyDown={(e) => { if (e.key === 'Enter' && shown[0] && !archived) openExternal(shown[0].url); if (e.key === 'Escape') setQ(''); }} />
            <kbd>/</kbd>
          </label>
          {manager && (
            <>
              <div className="seg">
                <button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>Current</button>
                <button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>Archived</button>
              </div>
              <button onClick={() => setParams(suggesting ? {} : { suggest: '1' })}><Sparkles size={14} aria-hidden /> Suggestions</button>
              <button className="primary" onClick={() => setParams({ add: '1' })}><Plus size={14} aria-hidden /> Link <kbd>N</kbd></button>
            </>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {manager && adding && <div className="card intra-panel"><LinkForm locations={locations} onDone={() => { setParams({}); changed(); }} onCancel={() => setParams({})} /></div>}
      {manager && suggesting && <Suggestions onAdded={changed} onClose={() => setParams({})} />}
      {data && !data.length && !adding && (
        <div className="card muted">{archived ? 'Nothing archived.' : manager ? 'No links yet. Add your own, or pick from the suggestions (insurance portals, labs, supply sites, payroll).' : 'No links yet — ask your office manager to add the sites you use.'}</div>
      )}
      {q && data?.length > 0 && !shown.length && <div className="card muted">No link matches “{q}”.</div>}
      {CATEGORIES.map(([key, label, Icon]) => {
        const list = shown.filter((l) => l.category === key);
        if (!list.length) return null;
        return (
          <section key={key} className="card intra-link-group">
            <h2 className="intra-h2"><Icon size={16} aria-hidden /> {label}</h2>
            <ul className="intra-links">
              {list.map((l, i) => (editing === l.id ? (
                <li key={l.id} className="intra-panel"><LinkForm initial={l} locations={locations} onDone={() => { setEditing(null); changed(); }} onCancel={() => setEditing(null)} /></li>
              ) : (
                <li key={l.id} className="intra-link-row">
                  <a className="intra-link" href={l.url} target="_blank" rel="noopener noreferrer">
                    <span className="intra-tile-icon"><LinkIcon link={l} size={20} /></span>
                    <span className="intra-link-text"><strong>{l.title}{l.pinned ? <Pin size={12} className="intra-pin" aria-label="pinned" /> : null}</strong><small className="muted">{hostOf(l.url)}{scopeLabel(l, locations) ? ` · ${scopeLabel(l, locations)}` : ''}</small></span>
                    <ExternalLink size={14} aria-hidden className="muted" />
                  </a>
                  {manager && (archived ? (
                    <div className="intra-row-actions"><button className="small" onClick={() => restore(l)}><RotateCcw size={14} aria-hidden /> Restore</button></div>
                  ) : (
                    <div className="intra-row-actions">
                      <button className="small icon" title={l.pinned ? 'Unpin' : 'Pin to the intranet home'} aria-label={l.pinned ? 'Unpin' : 'Pin'} onClick={() => pin(l)}>{l.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
                      <button className="small icon" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(list, i, -1)}><ArrowUp size={14} /></button>
                      <button className="small icon" title="Move down" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(list, i, 1)}><ArrowDown size={14} /></button>
                      <button className="small icon" title="Edit" aria-label="Edit" onClick={() => setEditing(l.id)}><Pencil size={14} /></button>
                      <button className="small icon" title="Archive" aria-label="Archive" onClick={() => archive(l)}><Archive size={14} /></button>
                    </div>
                  ))}
                </li>
              )))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function LinkForm({ initial, locations, onDone, onCancel }) {
  const [lastCategory, rememberCategory] = useRemembered('intranet.link.category', 'insurance');
  const [f, setF] = useState(() => ({
    title: initial?.title || '', url: initial?.url || '', category: initial?.category || lastCategory, pinned: !!initial?.pinned,
    location_ids: initial?.location_ids || [], roles: initial?.roles || [],
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  // Typing an address fills in a title from the site's name, until the title is typed by hand.
  const [titleTouched, setTitleTouched] = useState(!!initial);
  const onUrl = (e) => {
    const url = e.target.value;
    const host = hostOf(/^https?:/i.test(url) ? url : `https://${url}`).split('.')[0];
    setF({ ...f, url, ...(!titleTouched && host ? { title: host.charAt(0).toUpperCase() + host.slice(1) } : {}) });
  };
  const { submit, busy, error } = useSubmit(async () => {
    const saved = initial ? await api.put(`/intranet/links/${initial.id}`, f) : await api.post('/intranet/links', f);
    rememberCategory(f.category);
    toast(initial ? 'Link saved' : `Added: ${saved.title} — also in Ctrl/⌘K`);
    onDone(saved);
  });
  useShortcut('mod+s', () => submit(), { label: 'Save the link', section: 'Links', inInputs: true });
  return (
    <form className="intra-form" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <ErrorBox error={error} />
      <div className="intra-form-row">
        <label className="grow">Website address<input autoFocus={!initial} value={f.url} onChange={onUrl} placeholder="https://www.availity.com" inputMode="url" required /></label>
        <label className="grow">Title<input value={f.title} onChange={(e) => { setTitleTouched(true); set('title')(e); }} placeholder="Availity" maxLength={120} required /></label>
        <label>Category
          <select value={f.category} onChange={set('category')}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={f.pinned} onChange={set('pinned')} /> Pin to the intranet home</label>
      <ScopePicker value={f} onChange={(v) => setF({ ...f, ...v })} locations={locations} />
      <div className="actions">
        <button className="primary" disabled={busy}>{initial ? 'Save' : 'Add link'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Common dental sites, added in one click each (nothing is created until you click).
function Suggestions({ onAdded, onClose }) {
  const { data, error, reload } = useApi('/intranet/links/starters');
  const [busy, setBusy] = useState(false);
  const add = async (keys) => {
    setBusy(true);
    try {
      const added = await api.post('/intranet/links/starters', { keys });
      toast(`Added ${added.length} link${added.length === 1 ? '' : 's'} — change any address to your region’s portal with Edit`);
      reload();
      onAdded();
    } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const left = data.filter((s) => !s.added);
  return (
    <section className="card intra-panel">
      <div className="intra-section-head">
        <h2><Sparkles size={16} aria-hidden /> Suggested sites</h2>
        <div className="actions">
          {left.length > 0 && <button className="small" disabled={busy} onClick={() => add(left.map((s) => s.key))}>Add all {left.length}</button>}
          <button className="small" onClick={onClose}>Done</button>
        </div>
      </div>
      <p className="muted">Suggestions only — pick the ones your office uses. Many insurers have regional provider portals; you can change the address after adding.</p>
      <div className="intra-suggest">
        {CATEGORIES.map(([key, label]) => {
          const list = data.filter((s) => s.category === key);
          if (!list.length) return null;
          return (
            <div key={key}>
              <h3>{label}</h3>
              {list.map((s) => (
                <button key={s.key} type="button" className={`intra-suggest-item${s.added ? ' added' : ''}`} disabled={busy || s.added} onClick={() => add([s.key])} title={s.note || s.url}>
                  <LinkIcon link={s} size={16} />
                  <span>{s.title}<small className="muted">{hostOf(s.url)}</small></span>
                  {s.added ? <Check size={14} aria-label="added" /> : <Plus size={14} aria-hidden />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
