import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, StickyNote, Flag, Link2, History, Check, X, Pencil, Trash2, FileSearch, Folder, CalendarClock } from 'lucide-react';
import { api } from '../../api.js';
import { useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { useLiveEvents } from '../../live.js';
import { catLabel, kindLabel, fmtSize, PATIENT_CATEGORIES, OFFICE_CATEGORIES } from './filekinds.jsx';

const when = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const money = (c) => (c == null ? '' : `$${(c / 100).toFixed(2)}`);

// Everything about one document beside the viewer: what it looks like it is (with the reason), its details,
// notes (edits keep history) and sticky-note pins, "needs review" for a person, and links to a visit, claim
// or treatment plan. Saves as you go; removing a note can be undone.
export default function DocSidePanel({ doc, office = false, pinMode, setPinMode, page = 1, onChanged, onNotes, focusNote }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get(`/documents/${doc.id}/details`).then((x) => { setD(x); onNotes?.(x.doc_notes); }).catch(setError), [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setD(null); load(); }, [load]);
  useLiveEvents((e) => (e.type === 'documents' && e.patient_id === doc.patient_id) || (e.type === 'office-documents' && !doc.patient_id) ? load() : null);
  if (error) return <aside className="docside"><ErrorBox error={error} /></aside>;
  if (!d) return <aside className="docside"><div className="muted">Loading…</div></aside>;
  const canWrite = !!d.can_write;
  const saved = (x, msg) => { load(); onChanged?.(x); if (msg) toast(msg); };
  return (
    <aside className="docside" aria-label="Document details and notes">
      {d.suggested_category && canWrite && (
        <div className="docside-suggest" role="status">
          <Sparkles size={16} aria-hidden />
          <div>
            <strong>Looks like {/^[aeiou]/i.test(catLabel(d.suggested_category)) ? 'an' : 'a'} {catLabel(d.suggested_category)}</strong>
            <div className="muted">{d.suggestion_reason}{d.suggestion_source === 'ai' ? ' · suggested by AI' : ''}</div>
            <div className="inline" style={{ gap: 6, marginTop: 6 }}>
              <button className="small primary" onClick={async () => saved({ ...(await api.post(`/documents/${d.id}/accept-suggestion`)), suggested: true }, `Filed as ${catLabel(d.suggested_category)}`)}>File as {catLabel(d.suggested_category)}</button>
              <button className="small" onClick={async () => { await api.post(`/documents/${d.id}/dismiss-suggestion`); load(); }}>Keep as {catLabel(d.category)}</button>
            </div>
          </div>
        </div>
      )}
      <Details d={d} office={office} canWrite={canWrite} onSaved={(x) => saved(x, 'Saved')} />
      <Notes d={d} canWrite={canWrite} pinMode={pinMode} setPinMode={setPinMode} page={page} reload={load} focusNote={focusNote} />
      <Review d={d} canWrite={canWrite} me={user} reload={load} onChanged={onChanged} />
      {!office && d.patient_id && <Links d={d} canWrite={canWrite} reload={load} />}
      <ReadText d={d} canWrite={canWrite} reload={load} />
    </aside>
  );
}

function Details({ d, office, canWrite, onSaved }) {
  const cats = office ? OFFICE_CATEGORIES : PATIENT_CATEGORIES;
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const start = () => setF({ filename: d.filename, category: d.category, tooth: d.tooth || '', taken_at: d.taken_at || '', folder: d.folder || '', notes: d.notes || '', tags: (d.tags || []).join(', '), expires_on: d.expires_on || '' });
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { ...f };
      if (!office) delete body.expires_on;
      if (office) delete body.tooth;
      onSaved(await api.put(`/documents/${d.id}`, body));
      setF(null);
    } catch (err) { setError(err); }
  };
  if (!f) {
    return (
      <section className="docside-sec">
        <div className="docside-head"><h3>Details</h3>{canWrite && <button className="small" onClick={start}><Pencil size={13} aria-hidden /> Edit details</button>}</div>
        <dl className="docside-dl">
          <dt>Type</dt><dd>{catLabel(d.category)} · {kindLabel(d)} · {fmtSize(d.size)}</dd>
          {d.folder && <><dt>Folder</dt><dd><Folder size={13} aria-hidden /> {d.folder}</dd></>}
          {d.tooth && <><dt>Tooth</dt><dd>#{d.tooth}</dd></>}
          {d.taken_at && <><dt>Dated</dt><dd>{fmtDate(d.taken_at)}</dd></>}
          {office && <><dt>Expires</dt><dd>{d.expires_on ? <span className={d.expires_on < new Date().toISOString().slice(0, 10) ? 'docside-expired' : ''}><CalendarClock size={13} aria-hidden /> {fmtDate(d.expires_on)}</span> : <span className="muted">—</span>}</dd></>}
          <dt>Added</dt><dd>{when(d.created_at)}{d.uploaded_by_name ? ` by ${d.uploaded_by_name}` : ''}</dd>
          {d.notes && <><dt>About</dt><dd>{d.notes}</dd></>}
          {d.tags?.length > 0 && <><dt>Tags</dt><dd className="doc-tags">{d.tags.map((t) => <i key={t}>{t}</i>)}</dd></>}
          {d.virus_status === 'clean' && <><dt>Virus check</dt><dd>Clean</dd></>}
        </dl>
      </section>
    );
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="docside-sec doc-details" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setF(null); } }} aria-label="Edit document details">
      <h3>Details</h3>
      <ErrorBox error={error} />
      <label>Name<input autoFocus value={f.filename} onChange={set('filename')} /></label>
      <label>Type<select value={f.category} onChange={set('category')}>{cats.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
      <div className="docside-row">
        {!office && <label>Tooth<input value={f.tooth} onChange={set('tooth')} placeholder="e.g. 19" /></label>}
        <label>Dated<input type="date" value={f.taken_at} onChange={set('taken_at')} /></label>
      </div>
      {office && <label>Expires / renew by<input type="date" value={f.expires_on} onChange={set('expires_on')} /></label>}
      <label>Folder<input value={f.folder} onChange={set('folder')} placeholder="e.g. Ortho records" list="doc-folders" /></label>
      <label>About<input value={f.notes} onChange={set('notes')} /></label>
      <label>Tags<input value={f.tags} onChange={set('tags')} placeholder="pre-op, insurance" /></label>
      <div className="form-actions"><button type="button" onClick={() => setF(null)}>Cancel</button><button className="primary">Save</button></div>
    </form>
  );
}

function Notes({ d, canWrite, pinMode, setPinMode, page, reload, focusNote }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const focused = useRef(null);
  useEffect(() => { if (focusNote) focused.current?.scrollIntoView?.({ block: 'nearest' }); }, [focusNote]);
  // A pin placed on the picture opens the note box for it.
  useEffect(() => { if (pinMode?.x != null) box.current?.focus(); }, [pinMode]);
  const add = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const pin = pinMode?.x != null ? { x: pinMode.x, y: pinMode.y, page: pinMode.page } : d.mime === 'application/pdf' && page > 1 ? { page } : {};
      await api.post(`/documents/${d.id}/notes`, { body, ...pin });
      setText('');
      setPinMode?.(false);
      reload();
    } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const saveEdit = async () => {
    try {
      await api.put(`/document-notes/${editing.id}`, { body: editing.body });
      setEditing(null);
      reload();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const remove = async (n) => {
    try {
      await api.del(`/document-notes/${n.id}`);
      reload();
      toast('Note removed', { undo: async () => { await api.post(`/document-notes/${n.id}/restore`); reload(); } });
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const editsOf = (n) => d.history.filter((h) => h.status === 'superseded' && chainHas(d.history, n, h));
  return (
    <section className="docside-sec">
      <div className="docside-head">
        <h3><StickyNote size={15} aria-hidden /> Notes {d.doc_notes.length > 0 && <span className="docside-count">{d.doc_notes.length}</span>}</h3>
        {d.history.length > 0 && <button className="small" onClick={() => setShowHistory(!showHistory)} aria-pressed={showHistory}><History size={13} aria-hidden /> History</button>}
      </div>
      {!d.doc_notes.length && <div className="muted docside-empty">No notes yet.</div>}
      <ul className="docside-notes">
        {d.doc_notes.map((n, i) => (
          <li key={n.id} ref={focusNote === n.id ? focused : null} className={`${n.pinned ? `pinned ${n.color || 'yellow'}` : ''}${focusNote === n.id ? ' focus' : ''}`}>
            {editing?.id === n.id ? (
              <div>
                <textarea autoFocus value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={3}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
                <div className="inline" style={{ gap: 6 }}><button className="small primary" onClick={saveEdit}>Save</button><button className="small" onClick={() => setEditing(null)}>Cancel</button></div>
              </div>
            ) : (
              <>
                <div className="docside-note-body">{n.pinned && <span className="docside-pinno" title={`Pinned on page ${n.page || 1}`}>{i + 1}</span>}{n.body}</div>
                <div className="docside-note-meta muted">
                  {n.author || 'Someone'} · {when(n.created_at)}{n.supersedes_id ? ' · edited' : ''}{n.page && !n.pinned ? ` · page ${n.page}` : ''}{n.pinned ? ` · pinned${n.page > 1 ? ` on page ${n.page}` : ''}` : ''}{n.source === 'ai' ? ' · by assistant' : ''}
                  {canWrite && (
                    <span className="docside-note-actions">
                      <button className="link" onClick={() => setEditing({ id: n.id, body: n.body })} aria-label="Edit note"><Pencil size={12} /></button>
                      <button className="link" onClick={() => remove(n)} aria-label="Remove note"><Trash2 size={12} /></button>
                    </span>
                  )}
                </div>
                {showHistory && editsOf(n).map((h) => <div key={h.id} className="docside-old"><s>{h.body}</s> <span className="muted">— {h.author}, {when(h.created_at)}</span></div>)}
              </>
            )}
          </li>
        ))}
      </ul>
      {showHistory && d.history.filter((h) => h.status === 'deleted').map((h) => (
        <div key={h.id} className="docside-old"><s>{h.body}</s> <span className="muted">— removed by {h.closed_by_name || 'someone'}, {when(h.closed_at)}</span></div>
      ))}
      {canWrite && (
        <div className="docside-add">
          {pinMode?.x != null && <div className="docside-pinhint"><StickyNote size={13} aria-hidden /> New sticky note at the spot you picked{pinMode.page > 1 ? ` (page ${pinMode.page})` : ''}</div>}
          <textarea ref={box} rows={2} value={text} placeholder={pinMode ? 'What should people know about this spot?' : 'Add a note — Enter saves'} aria-label="New note"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }} />
          <div className="inline" style={{ gap: 6 }}>
            <button className="small primary" disabled={!text.trim() || busy} onClick={add}>Add note</button>
            {setPinMode && d.mime !== 'application/pdf' && (
              <button className={`small${pinMode ? ' active' : ''}`} onClick={() => setPinMode(pinMode ? false : true)} aria-pressed={!!pinMode} title="Click a spot on the page to pin a sticky note there (P)">
                <StickyNote size={13} aria-hidden /> {pinMode ? 'Cancel pin' : 'Pin on page'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
// Is `old` an earlier version of `note` (following supersedes_id back)?
function chainHas(history, note, old) {
  let at = note.supersedes_id;
  for (let i = 0; at && i < 50; i++) {
    if (at === old.id) return true;
    at = history.find((h) => h.id === at)?.supersedes_id;
  }
  return false;
}

function Review({ d, canWrite, me, reload, onChanged }) {
  const users = useLookup('/users');
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const r = d.review;
  const ask = async () => {
    try {
      const out = await api.put(`/documents/${d.id}/review`, { assignee_id: Number(who), note });
      toast(`Sent to ${out.assignee.name}’s to-do list`);
      setOpen(false);
      setNote('');
      reload();
      onChanged?.({ id: d.id, review_status: 'needs_review' });
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const done = async () => {
    try {
      await api.post(`/documents/${d.id}/review/done`, { note });
      toast('Marked reviewed');
      setNote('');
      reload();
      onChanged?.({ id: d.id, review_status: 'reviewed' });
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <section className="docside-sec">
      <div className="docside-head"><h3><Flag size={15} aria-hidden /> Review</h3></div>
      {r?.status === 'needs_review' ? (
        <div className="docside-review">
          <div><strong>Needs review</strong> by {r.assignee?.name || 'someone'}{r.requested_by ? ` · asked by ${r.requested_by.name}` : ''}</div>
          {r.note && <div className="muted">“{r.note}”</div>}
          {(r.assignee?.id === me?.id || canWrite) && (
            <div className="inline" style={{ gap: 6, marginTop: 6 }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you found (optional)" aria-label="Review note" />
              <button className="small primary" onClick={done}><Check size={13} aria-hidden /> Reviewed</button>
            </div>
          )}
        </div>
      ) : (
        <>
          {r?.status === 'reviewed' && <div className="muted">Reviewed by {r.reviewed_by?.name || 'someone'} · {when(r.reviewed_at)}</div>}
          {canWrite && !open && <button className="small" onClick={() => setOpen(true)}><Flag size={13} aria-hidden /> Ask someone to review</button>}
          {open && (
            <div className="docside-reviewform">
              <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who should review it" autoFocus>
                <option value="">Who should look at it?</option>
                {users.filter((u) => u.active !== 0 && u.active !== false).map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me?.id ? ' (me)' : ''}</option>)}
              </select>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to check (optional)" aria-label="What to check" />
              <div className="inline" style={{ gap: 6 }}><button className="small primary" disabled={!who} onClick={ask}>Send to their to-do</button><button className="small" onClick={() => setOpen(false)}><X size={13} aria-hidden /> Cancel</button></div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Links({ d, canWrite, reload }) {
  const [opts, setOpts] = useState(null);
  const [editing, setEditing] = useState(false);
  const l = d.links || {};
  const start = async () => { setEditing(true); if (!opts) setOpts(await api.get(`/documents/${d.id}/link-options`).catch(() => ({ appointments: [], claims: [], treatment_plans: [] }))); };
  const set = async (key, value) => {
    try { await api.put(`/documents/${d.id}/links`, { [key]: value || null }); reload(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const any = l.appointment || l.claim || l.treatment_plan;
  return (
    <section className="docside-sec">
      <div className="docside-head"><h3><Link2 size={15} aria-hidden /> Belongs with</h3>{canWrite && !editing && <button className="small" onClick={start}><Pencil size={13} aria-hidden /> {any ? 'Change' : 'Link'}</button>}</div>
      {!editing && !any && <div className="muted docside-empty">Not linked to a visit, claim or plan.</div>}
      {!editing && (
        <ul className="docside-links">
          {l.appointment && <li><a href={`/schedule?date=${String(l.appointment.start_time).slice(0, 10)}`}>Visit {fmtDate(String(l.appointment.start_time).slice(0, 10))}</a></li>}
          {l.claim && <li><a href={`/claims/${l.claim.id}`}>Claim #{l.claim.id} · {l.claim.status} · {money(l.claim.total_fee)}</a></li>}
          {l.treatment_plan && <li><a href={`/patients/${d.patient_id}?tab=treatment`}>Plan: {l.treatment_plan.name}</a></li>}
        </ul>
      )}
      {editing && opts && (
        <div className="docside-linkform">
          <label>Visit<select value={d.appointment_id || ''} onChange={(e) => set('appointment_id', e.target.value)}><option value="">—</option>{opts.appointments.map((a) => <option key={a.id} value={a.id}>{fmtDate(String(a.start_time).slice(0, 10))} · {a.status.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Claim<select value={d.claim_id || ''} onChange={(e) => set('claim_id', e.target.value)}><option value="">—</option>{opts.claims.map((c) => <option key={c.id} value={c.id}>#{c.id} · {c.status} · {money(c.total_fee)}</option>)}</select></label>
          <label>Treatment plan<select value={d.treatment_plan_id || ''} onChange={(e) => set('treatment_plan_id', e.target.value)}><option value="">—</option>{opts.treatment_plans.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.status}</option>)}</select></label>
          <button className="small" onClick={() => setEditing(false)}>Done</button>
        </div>
      )}
    </section>
  );
}

function ReadText({ d, canWrite, reload }) {
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  const status = {
    done: `Searchable — words read ${d.ocr_source === 'ai' ? 'by AI' : d.ocr_source === 'pdf' ? 'from the PDF' : 'from the file'}`,
    none: 'No words found to search', failed: 'Couldn’t read the words this time', skipped: 'Not read for search', pending: 'Reading…',
  }[d.ocr_status] || 'Not read yet';
  const again = async () => {
    setBusy(true);
    try { await api.post(`/documents/${d.id}/read`); reload(); } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <section className="docside-sec docside-text">
      <div className="docside-head">
        <h3><FileSearch size={15} aria-hidden /> Search text</h3>
        <span className="muted" style={{ fontSize: 12 }}>{status}</span>
      </div>
      <div className="inline" style={{ gap: 6 }}>
        {d.has_text && <button className="small" onClick={async () => setText(text == null ? (await api.get(`/documents/${d.id}/text`)).text : null)}>{text == null ? 'Show the words' : 'Hide'}</button>}
        {canWrite && <button className="small" disabled={busy} onClick={again}>{busy ? 'Reading…' : d.has_text ? 'Read again' : 'Read text now'}</button>}
      </div>
      {text != null && <pre className="docside-words">{text || '(nothing)'}</pre>}
    </section>
  );
}
