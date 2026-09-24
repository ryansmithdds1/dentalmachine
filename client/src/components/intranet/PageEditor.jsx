import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Heading2, Bold, Italic, List, ListOrdered, ListChecks, Link2, ImagePlus, Table, MessageSquareQuote, Eye, Columns2, PenLine, FileText } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { MarkdownView, ScopePicker, intranetChanged, uploadAttachment } from './shared.jsx';

const REVIEW_CHOICES = [['', 'No review reminder'], ['90', 'Every 3 months'], ['180', 'Every 6 months'], ['365', 'Every year']];
// Unsaved text is kept in this browser (per person, per page) so leaving the editor never loses work.
const draftKey = (id) => `dm_intranet_draft_${id || 'new'}`;
const readDraft = (id) => { try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch { return null; } };
const writeDraft = (id, v) => { try { if (v) localStorage.setItem(draftKey(id), JSON.stringify(v)); else localStorage.removeItem(draftKey(id)); } catch { /* storage unavailable */ } };

// Write or edit an office manual page: Markdown with a small toolbar and a live preview. Ctrl/⌘S saves;
// every save becomes a new version in the page's history.
export default function PageEditor({ id = null }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const locations = useLookup('/locations');
  const { data: sections } = useApi('/intranet/sections');
  const { data: page, error: loadError } = useApi(id ? `/intranet/pages/${id}` : null);
  const [f, setF] = useState(null);
  const [draft, setDraft] = useState(null);
  const [view, setView] = useState(() => (window.innerWidth > 1100 ? 'split' : 'write'));
  const [attachments, setAttachments] = useState([]);
  const text = useRef(null);
  const file = useRef(null);

  useEffect(() => {
    if (id && !page) return;
    const start = page
      ? { title: page.title, body: page.body, section_id: page.section_id || '', requires_ack: !!page.ack_version, reack: false, review_every_days: page.review_every_days ? String(page.review_every_days) : '', location_ids: page.location_ids || [], roles: page.roles || [], change_note: '' }
      : { title: '', body: '', section_id: params.get('section') || '', requires_ack: false, reack: false, review_every_days: '365', location_ids: [], roles: [], change_note: '' };
    setF(start);
    setAttachments(page?.attachments || []);
    const saved = readDraft(id);
    if (saved && (saved.body !== start.body || saved.title !== start.title) && (!page || saved.base_version === page.version)) setDraft(saved);
  }, [page, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = f && (page ? f.title !== page.title || f.body !== page.body : f.title || f.body);
  useEffect(() => {
    if (!f) return undefined;
    const t = setTimeout(() => writeDraft(id, dirty ? { title: f.title, body: f.body, base_version: page?.version ?? null } : null), 400);
    return () => clearTimeout(t);
  }, [f, dirty, id, page]);

  const { submit, busy, error } = useSubmit(async () => {
    if (!f.title.trim()) throw new Error('Give the page a title');
    const body = {
      title: f.title, body: f.body, section_id: f.section_id || null, requires_ack: f.requires_ack, reack: f.reack,
      review_every_days: f.review_every_days ? Number(f.review_every_days) : null, location_ids: f.location_ids, roles: f.roles, change_note: f.change_note || null,
    };
    const saved = id ? await api.put(`/intranet/pages/${id}`, { ...body, base_version: page.version }) : await api.post('/intranet/pages', body);
    writeDraft(id, null);
    intranetChanged();
    const before = page?.version;
    toast(id ? (saved.version !== before ? `Saved as version ${saved.version}` : 'Saved') : 'Page created', {
      undo: id && saved.version !== before ? async () => {
        try { await api.post(`/intranet/pages/${id}/restore`, { version: before }); intranetChanged(); toast(`Back to how it was (saved as version ${saved.version + 1})`); } catch (e) { toast(e.message, { tone: 'error' }); }
      } : null,
    });
    nav(`/intranet/pages/${saved.id}`);
  });
  const cancel = () => nav(id ? `/intranet/pages/${id}` : '/intranet/pages');
  useShortcuts([
    { combo: 'mod+s', handler: () => f && submit(), label: 'Save the page', section: 'Editor', inInputs: true },
    { combo: 'mod+enter', handler: () => f && submit(), label: 'Save the page', section: 'Editor', inInputs: true },
    { combo: 'escape', handler: cancel, label: 'Leave the editor (your unsaved text is kept)', section: 'Editor', inInputs: true },
  ]);

  // Toolbar: wrap the selection, or start lines with a marker.
  const edit = (fn) => {
    const el = text.current;
    // In Preview there's no text box: add at the end.
    if (!el) { setF((x) => ({ ...x, body: fn(x.body, x.body.length, x.body.length)[0] })); return; }
    const { selectionStart: a, selectionEnd: b, value } = el;
    const [next, selA, selB] = fn(value, a, b);
    setF((x) => ({ ...x, body: next }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(selA, selB); });
  };
  const wrap = (left, right = left, placeholder = 'text') => edit((v, a, b) => {
    const inner = v.slice(a, b) || placeholder;
    return [v.slice(0, a) + left + inner + right + v.slice(b), a + left.length, a + left.length + inner.length];
  });
  const lines = (prefix) => edit((v, a, b) => {
    const start = v.lastIndexOf('\n', a - 1) + 1;
    const block = v.slice(start, b) || 'item';
    let n = 0;
    const out = block.split('\n').map((l) => (typeof prefix === 'function' ? prefix(++n) : prefix) + l.replace(/^(\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?|#{1,4}\s+|>\s?)/, '')).join('\n');
    return [v.slice(0, start) + out + v.slice(b), start, start + out.length];
  });
  const insert = (snippet) => edit((v, a, b) => {
    const pre = a > 0 && v[a - 1] !== '\n' ? '\n\n' : '';
    return [v.slice(0, a) + pre + snippet + v.slice(b), a + pre.length, a + pre.length + snippet.length];
  });
  const link = () => {
    const el = text.current;
    if (!el) return insert('[link text](https://)');
    const label = el.value.slice(el.selectionStart, el.selectionEnd) || 'link text';
    edit((v, a, b) => {
      const s = `[${label}](https://)`;
      return [v.slice(0, a) + s + v.slice(b), a + label.length + 3, a + label.length + 11];
    });
  };
  const onKeyDown = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); link(); }
  };
  const onFile = async (e) => {
    const picked = [...(e.target.files || [])];
    e.target.value = '';
    for (const fl of picked) {
      try {
        const a = await uploadAttachment(id, fl);
        setAttachments((l) => [...l, a]);
        insert(a.mime.startsWith('image/') ? `![${a.filename.replace(/\.[^.]+$/, '')}](att:${a.id})` : `[${a.filename}](att:${a.id})`);
        toast(`Added ${a.filename}`);
      } catch (err) { toast(err.message, { tone: 'error' }); }
    }
  };

  if (loadError) return <ErrorBox error={loadError} />;
  if (!f) return <div className="muted" style={{ padding: 24 }}>Loading…</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const tool = (Icon, label, run, key) => <button type="button" className="icon" title={key ? `${label} (${key})` : label} aria-label={label} onClick={run}><Icon size={16} /></button>;

  return (
    <form className="intra-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="page-header">
        <h1>{id ? 'Edit page' : 'New page'}</h1>
        <div className="actions">
          <button type="button" onClick={cancel}>Cancel</button>
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'} <kbd>Ctrl/⌘ S</kbd></button>
        </div>
      </div>
      <ErrorBox error={error} />
      {draft && (
        <div className="intra-banner info">
          <span>You have unsaved changes from earlier on this computer.</span>
          <button type="button" className="small primary" onClick={() => { setF({ ...f, title: draft.title, body: draft.body }); setDraft(null); }}>Bring them back</button>
          <button type="button" className="small" onClick={() => { writeDraft(id, null); setDraft(null); }}>Discard</button>
        </div>
      )}
      <input className="intra-title-input" value={f.title} onChange={set('title')} placeholder="Page title (e.g. Opening checklist)" aria-label="Page title" maxLength={160} autoFocus={!id} />

      <div className="intra-toolbar" role="toolbar" aria-label="Formatting">
        {tool(Heading2, 'Heading', () => lines('## '))}
        {tool(Bold, 'Bold', () => wrap('**'), 'Ctrl/⌘ B')}
        {tool(Italic, 'Italic', () => wrap('*'), 'Ctrl/⌘ I')}
        <span className="intra-toolbar-sep" />
        {tool(List, 'Bulleted list', () => lines('- '))}
        {tool(ListOrdered, 'Numbered list', () => lines((n) => `${n}. `))}
        {tool(ListChecks, 'Checklist', () => lines('- [ ] '))}
        <span className="intra-toolbar-sep" />
        {tool(Link2, 'Link', link, 'Ctrl/⌘ K')}
        {tool(Table, 'Table', () => insert('| Who | Does |\n|---|---|\n| | |\n'))}
        {tool(MessageSquareQuote, 'Note', () => lines('> '))}
        {id
          ? tool(ImagePlus, 'Add an image or PDF', () => file.current?.click())
          : <span className="muted intra-toolbar-hint">Save once to add images and files</span>}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple hidden onChange={onFile} />
        <span className="intra-toolbar-grow" />
        <div className="seg" aria-label="View">
          <button type="button" className={view === 'write' ? 'active' : ''} onClick={() => setView('write')} title="Write"><PenLine size={14} aria-hidden /> Write</button>
          <button type="button" className={view === 'split' ? 'active' : ''} onClick={() => setView('split')} title="Side by side"><Columns2 size={14} aria-hidden /></button>
          <button type="button" className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')} title="Preview"><Eye size={14} aria-hidden /> Preview</button>
        </div>
      </div>

      <div className={`intra-edit-area ${view}`}>
        {view !== 'preview' && (
          <textarea ref={text} value={f.body} onChange={set('body')} onKeyDown={onKeyDown} aria-label="Page text" spellCheck
            placeholder={'## Steps\n1. First do this\n2. Then this\n\n- [ ] A checklist item\n\n**Bold**, *italic*, [a link](https://example.com)'} />
        )}
        {view !== 'write' && <div className="intra-preview card" aria-label="Preview">{f.body.trim() ? <MarkdownView text={f.body} /> : <p className="muted">The preview shows here as you type.</p>}</div>}
      </div>

      {attachments.length > 0 && (
        <p className="muted intra-files"><FileText size={13} aria-hidden /> Files on this page: {attachments.map((a) => a.filename).join(', ')}</p>
      )}

      <details className="card intra-options" open={!id}>
        <summary>Section, sign-off, review and who can see it</summary>
        <div className="intra-form-row">
          <label>Section
            <select value={f.section_id} onChange={set('section_id')}>
              <option value="">No section</option>
              {sections?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Review reminder
            <select value={f.review_every_days} onChange={set('review_every_days')}>{REVIEW_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          {id && <label className="grow">What changed <span className="muted">(optional, shows in the history)</span><input value={f.change_note} onChange={set('change_note')} maxLength={300} placeholder="e.g. New alarm code procedure" /></label>}
        </div>
        <label className="check"><input type="checkbox" checked={f.requires_ack} onChange={set('requires_ack')} /> Ask everyone who can see it to confirm they’ve read it</label>
        {id && page?.ack_version && f.requires_ack && (
          <label className="check"><input type="checkbox" checked={f.reack} onChange={set('reack')} /> This is an important change — ask everyone to read it again</label>
        )}
        <ScopePicker value={f} onChange={(v) => setF({ ...f, ...v })} locations={locations} />
      </details>
    </form>
  );
}
