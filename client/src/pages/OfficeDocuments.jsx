import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FolderOpen, Inbox, Flag, Search, Upload, CalendarClock, StickyNote, Download, UserCheck, BadgeCheck } from 'lucide-react';
import StaffCredentials from '../components/StaffCredentials.jsx';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from '../format.js';
import { ErrorBox, Modal, PatientPicker } from '../components/ui.jsx';
import { useLiveEvents } from '../live.js';
import { useShortcuts, typingIn } from '../shortcuts.js';
import { toast, undoable } from '../toast.js';
import { useActivePatient } from '../activePatient.jsx';
import DocView from '../components/docs/DocView.jsx';
import { downloadDoc } from '../components/docs/DocPreview.jsx';
import { ACCEPT, OFFICE_CATEGORIES, PATIENT_CATEGORIES, catLabel, KindIcon, fmtSize } from '../components/docs/filekinds.jsx';
import '../components/docs/docs.css';

const TABS = [['office', 'Office documents', FolderOpen], ['inbox', 'Scan inbox', Inbox], ['review', 'To review', Flag], ['search', 'Search all documents', Search], ['staff', 'Staff licences & CPR', BadgeCheck]];
const today = () => new Date().toISOString().slice(0, 10);
const soon = (d) => d && d <= new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
const uploadKey = () => `up-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`;
// A category from the file's name, for office paperwork.
const guessOffice = (name) => ([[/contract|agreement|lease/i, 'contract'], [/licen[cs]e|permit|\bdea\b|registration/i, 'license'], [/policy|sop\b|handbook|manual/i, 'policy'],
  [/invoice|bill|statement|receipt/i, 'invoice'], [/cert(ificate)?|\bce\b|cpr|bls/i, 'certificate'], [/w-?4|i-?9|offer|payroll|review/i, 'hr']].find(([re]) => re.test(name))?.[1] || 'document');

// Office documents (no patient): contracts, licences with expiry reminders, policies, vendor invoices — plus
// the scan inbox (scans no chart could be matched to), documents waiting for review, and search across every
// document. Same viewer, notes, pins and review as a patient's documents.
export default function OfficeDocuments() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const officeOk = can('officedocs:read');
  const tab = params.get('tab') || (officeOk ? 'office' : can('clinical:write') ? 'inbox' : 'review');
  const setTab = (t) => { const p = new URLSearchParams(params); p.set('tab', t); p.delete('doc'); setParams(p, { replace: true }); };
  const [viewing, setViewing] = useState(null); // { doc, office, inbox }
  // ?doc=123: open that document (from search, the command bar, a to-do).
  useEffect(() => {
    const want = Number(params.get('doc'));
    if (!want) return;
    api.get(`/documents/${want}/details`).then((d) => setViewing({ doc: d, office: !d.patient_id && !d.inbox, inbox: d.inbox })).catch((e) => toast(e.message, { tone: 'error' }));
  }, [params]);
  const close = () => { setViewing(null); if (params.get('doc')) { const p = new URLSearchParams(params); p.delete('doc'); setParams(p, { replace: true }); } };
  useShortcuts(TABS.map(([k, l], i) => ({ combo: `alt+${i + 1}`, handler: () => setTab(k), label: `Documents: ${l}`, section: 'Documents', enabled: !viewing })));

  return (
    <div className="offdocs">
      <div className="page-header"><h1>Documents</h1></div>
      <div className="offdocs-tabs" role="tablist" aria-label="Documents">
        {TABS.filter(([k]) => (k === 'office' || k === 'staff' ? officeOk : k === 'inbox' ? can('clinical:write') : true)).map(([k, l, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}><Icon size={15} aria-hidden /> {l}</button>
        ))}
      </div>
      {tab === 'office' && (officeOk ? <OfficeList onOpen={(doc) => setViewing({ doc, office: true })} /> : <div className="card empty">Office documents are for managers — ask an administrator for access.</div>)}
      {tab === 'inbox' && <InboxList onOpen={(doc) => setViewing({ doc, inbox: true })} />}
      {tab === 'review' && <ReviewList onOpen={(doc) => setViewing({ doc, office: !doc.patient_id })} />}
      {tab === 'staff' && (officeOk ? <StaffCredentials /> : <div className="card empty">Staff licences are for managers — ask an administrator for access.</div>)}
      {tab === 'search' && <SearchAll initial={params.get('q') || ''} onOpen={(doc) => setViewing({ doc, office: !doc.patient_id })} />}
      {viewing && <Viewer viewing={viewing} onClose={close} />}
    </div>
  );
}

function Viewer({ viewing, onClose }) {
  const { doc, office, inbox } = viewing;
  const remove = async () => {
    onClose();
    try {
      await undoable(`Removed ${doc.filename}`, () => api.del(`/documents/${doc.id}`), () => api.post(`/documents/${doc.id}/restore`));
    } catch { /* the toast says why */ }
  };
  return (
    <Modal title={doc.filename} wide onClose={onClose}>
      {inbox && <FileToPatient doc={doc} onFiled={onClose} />}
      <div onKeyDown={(e) => { if (e.key === 'Delete' && !typingIn(e.target)) { e.preventDefault(); remove(); } }}>
        <DocView key={doc.id} doc={doc} office={office} />
        <div className="form-actions doc-actions">
          <button onClick={() => downloadDoc(doc).catch((e) => toast(e.message, { tone: 'error' }))}><Download size={14} aria-hidden /> Download</button>
          {doc.patient_id && <a href={`/patients/${doc.patient_id}?tab=documents&doc=${doc.id}`}><button>Open in the chart</button></a>}
          <button className="danger" onClick={remove} title="Remove (Delete) — you can undo">Remove</button>
        </div>
      </div>
    </Modal>
  );
}

// A scan from the inbox goes to a chart: the patient you're working with is suggested first.
function FileToPatient({ doc, onFiled }) {
  const { patientId, recent } = useActivePatient();
  const active = recent?.find((r) => r.id === patientId) || null;
  const [patient, setPatient] = useState(active);
  const [category, setCategory] = useState(doc.suggested_category || (doc.category !== 'document' ? doc.category : 'document'));
  const [error, setError] = useState(null);
  const file = async () => {
    try {
      await api.post(`/document-inbox/${doc.id}/file`, { patient_id: patient.id, category });
      toast(`Filed to ${patient.first_name} ${patient.last_name}’s chart`);
      onFiled();
    } catch (e) { setError(e); }
  };
  return (
    <div className="card" style={{ marginBottom: 12, background: 'var(--primary-soft)' }}>
      <ErrorBox error={error} />
      <div className="inline" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <UserCheck size={18} aria-hidden />
        <strong>File to</strong>
        <div style={{ minWidth: 260, flex: 1 }}><PatientPicker value={patient} onChange={setPatient} /></div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="File as">{PATIENT_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select>
        <button className="primary" disabled={!patient} onClick={file}>File it</button>
      </div>
      {doc.suggested_category && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Looks like {catLabel(doc.suggested_category)}: {doc.suggestion_reason}</div>}
    </div>
  );
}

function OfficeList({ onOpen }) {
  const { can } = useAuth();
  const canWrite = can('officedocs:write');
  const [filters, setFilters] = useState({ category: '', folder: '', expiring: false });
  const q = new URLSearchParams({ ...(filters.category ? { category: filters.category } : {}), ...(filters.folder ? { folder: filters.folder } : {}), ...(filters.expiring ? { expiring: '1' } : {}) });
  const { data: docs, error, reload } = useApi(`/office-documents?${q}`);
  const { data: folders } = useApi('/office-documents/folders');
  useLiveEvents((e) => e.type === 'office-documents' && reload());
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState(null);
  const [upload, setUpload] = useState({ category: 'auto', expires_on: '', folder: '' });
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  useShortcuts([{ combo: 'u', handler: () => input.current?.click(), label: 'Add office documents', section: 'Documents', enabled: canWrite }]);
  useEffect(() => {
    const t = search.trim();
    if (t.length < 2) { setHits(null); return undefined; }
    const timer = setTimeout(() => api.get(`/documents/search?scope=office&q=${encodeURIComponent(t)}`).then((rows) => setHits(new Map(rows.map((r) => [r.id, r])))).catch(() => setHits(null)), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const send = async (files) => {
    files = files.filter((f) => f?.size);
    if (!files.length) return;
    setBusy(true);
    const added = [];
    try {
      for (const f of files) {
        const qs = new URLSearchParams({ filename: f.name, category: upload.category === 'auto' ? guessOffice(f.name) : upload.category, ...(upload.expires_on ? { expires_on: upload.expires_on } : {}), ...(upload.folder ? { folder: upload.folder } : {}) });
        const res = await fetch(`/api/office-documents?${qs}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': f.type || 'application/octet-stream', 'Idempotency-Key': uploadKey() }, body: f });
        if (!res.ok) throw new Error(`${f.name}: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
        added.push(await res.json());
      }
    } catch (e) { toast(e.message, { tone: 'error' }); }
    setBusy(false);
    if (input.current) input.current.value = '';
    reload();
    if (added.length) toast(`Added ${added.length === 1 ? added[0].filename : `${added.length} documents`}`, { undo: async () => { for (const d of added) await api.del(`/documents/${d.id}`); reload(); } });
  };
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (docs || []).filter((d) => !words.length || words.every((w) => [d.filename, d.notes, d.folder, catLabel(d.category), ...(d.tags || [])].join(' ').toLowerCase().includes(w)) || hits?.has(d.id));
  return (
    <div className={`card docs-drop${dragging ? ' over' : ''}`}
      onDragOver={(e) => { if (canWrite && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={(e) => { if (!canWrite || !e.dataTransfer?.files?.length) return; e.preventDefault(); setDragging(false); send([...e.dataTransfer.files]); }}>
      {dragging && <div className="docs-drop-hint" aria-hidden>Drop to add to office documents</div>}
      <ErrorBox error={error} />
      {canWrite && (
        <div className="offdocs-filters" aria-label="Add documents">
          <label>Type<select value={upload.category} onChange={(e) => setUpload({ ...upload, category: e.target.value })}><option value="auto">Automatic (from the name)</option>{OFFICE_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
          <label>Expires (optional)<input type="date" value={upload.expires_on} min={today()} onChange={(e) => setUpload({ ...upload, expires_on: e.target.value })} /></label>
          <label>Folder<input value={upload.folder} onChange={(e) => setUpload({ ...upload, folder: e.target.value })} list="office-folders" placeholder="e.g. Licences" /></label>
          <button type="button" className="primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={15} aria-hidden /> {busy ? 'Adding…' : 'Add files'} <kbd>U</kbd>
          </button>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden disabled={busy} onChange={(e) => send([...e.target.files])} aria-label="Office documents to add" />
          <span className="muted" style={{ fontSize: 12.5 }}>or drop them anywhere here</span>
        </div>
      )}
      <datalist id="office-folders">{(folders || []).map((f) => <option key={f.folder} value={f.folder} />)}</datalist>
      <div className="offdocs-filters">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, notes and the words inside…" aria-label="Search office documents" style={{ width: 280 }} />
        <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })} aria-label="Type"><option value="">All types</option>{OFFICE_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select>
        {(folders || []).length > 0 && <select value={filters.folder} onChange={(e) => setFilters({ ...filters, folder: e.target.value })} aria-label="Folder"><option value="">All folders</option>{folders.map((f) => <option key={f.folder} value={f.folder}>{f.folder} ({f.n})</option>)}</select>}
        <label className="docs-check"><input type="checkbox" checked={filters.expiring} onChange={(e) => setFilters({ ...filters, expiring: e.target.checked })} /> Expiring in 90 days</label>
      </div>
      {docs && !shown.length && <div className="empty">{docs.length ? 'Nothing matches.' : 'No office documents yet — add contracts, licences, policies and invoices here.'}</div>}
      {shown.length > 0 && (
        <table className="offdocs-list">
          <thead><tr><th>Name</th><th>Type</th><th className="hide-sm">Folder</th><th>Expires</th><th className="hide-sm">Added</th></tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="row" tabIndex={0} onClick={() => onOpen(d)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d); }}>
                <td>
                  <div className="offdocs-name"><KindIcon doc={d} size={18} /><strong>{d.filename}</strong>{d.note_count > 0 && <span className="doc-badge"><StickyNote size={11} aria-hidden /> {d.note_count}</span>}{d.review_status === 'needs_review' && <span className="doc-badge review"><Flag size={11} aria-hidden /> Review</span>}</div>
                  {hits?.get(d.id)?.snippet && <div className="offdocs-snippet">{hits.get(d.id).snippet}</div>}
                </td>
                <td>{catLabel(d.category)}</td>
                <td className="hide-sm">{d.folder || ''}</td>
                <td>{d.expires_on ? <span className={`doc-badge${d.expires_on < today() ? ' expired' : soon(d.expires_on) ? ' review' : ''}`}><CalendarClock size={11} aria-hidden /> {fmtDate(d.expires_on)}</span> : ''}</td>
                <td className="hide-sm">{fmtDate(d.created_at)} · {fmtSize(d.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InboxList({ onOpen }) {
  const { data: docs, error, reload } = useApi('/document-inbox');
  useLiveEvents((e) => ['document-inbox', 'documents'].includes(e.type) && reload());
  return (
    <div className="card">
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>Scans from a scanner’s folder that weren’t named for a chart (P&lt;chart #&gt;_…). Open one to file it to a patient.</p>
      {docs && !docs.length && <div className="empty">Nothing to file — the inbox is empty.</div>}
      {docs?.length > 0 && (
        <table className="offdocs-list">
          <thead><tr><th>Scan</th><th>Looks like</th><th className="hide-sm">Arrived</th></tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={d.id} className="row" tabIndex={0} onClick={() => onOpen(d)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d); }}>
              <td><div className="offdocs-name"><KindIcon doc={d} size={18} /><strong>{d.filename}</strong></div></td>
              <td>{d.suggested_category ? catLabel(d.suggested_category) : <span className="muted">—</span>}</td>
              <td className="hide-sm">{fmtDate(d.created_at)} · {d.notes}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function ReviewList({ onOpen }) {
  const [mine, setMine] = useState(true);
  const { data: rows, error, reload } = useApi(`/documents/needs-review${mine ? '?mine=1' : ''}`);
  const nav = useNavigate();
  useLiveEvents((e) => ['documents', 'office-documents'].includes(e.type) && reload());
  return (
    <div className="card">
      <ErrorBox error={error} />
      <div className="offdocs-filters">
        <label className="docs-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Just mine</label>
      </div>
      {rows && !rows.length && <div className="empty">Nothing waiting for review{mine ? ' for you' : ''}.</div>}
      {rows?.length > 0 && (
        <table className="offdocs-list">
          <thead><tr><th>Document</th><th>Patient</th><th>Who</th><th className="hide-sm">Asked</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id} className="row" tabIndex={0} onClick={() => (d.patient_id ? nav(d.link) : onOpen(d))} onKeyDown={(e) => { if (e.key === 'Enter') (d.patient_id ? nav(d.link) : onOpen(d)); }}>
              <td><div className="offdocs-name"><KindIcon doc={d} size={18} /><strong>{d.filename}</strong></div>{d.review_note && <div className="offdocs-snippet">“{d.review_note}”</div>}</td>
              <td>{d.patient_name || <span className="muted">Office</span>}</td>
              <td>{d.assignee_name}</td>
              <td className="hide-sm">{fmtDate(d.review_requested_at)}{d.requested_by_name ? ` by ${d.requested_by_name}` : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function SearchAll({ initial, onOpen }) {
  const [q, setQ] = useState(initial);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRows(null); return undefined; }
    const timer = setTimeout(() => api.get(`/documents/search?q=${encodeURIComponent(t)}&limit=100`).then((r) => { setRows(r); setError(null); }).catch(setError), 250);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <div className="card">
      <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Words in any document — names, scanned text, notes (e.g. “delta eob 2025”)" aria-label="Search all documents" style={{ width: '100%', maxWidth: 560 }} />
      <ErrorBox error={error} />
      {rows && !rows.length && <div className="empty">No documents found.</div>}
      {rows?.length > 0 && (
        <table className="offdocs-list" style={{ marginTop: 12 }}>
          <thead><tr><th>Document</th><th>Patient</th><th className="hide-sm">Type</th><th className="hide-sm">Added</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id} className="row" tabIndex={0} onClick={() => (d.patient_id ? nav(d.link) : onOpen(d))} onKeyDown={(e) => { if (e.key === 'Enter') (d.patient_id ? nav(d.link) : onOpen(d)); }}>
              <td><div className="offdocs-name"><KindIcon doc={d} size={18} /><strong>{d.filename}</strong></div>{d.snippet && <div className="offdocs-snippet">{d.snippet}</div>}</td>
              <td>{d.patient_name || <span className="muted">Office</span>}</td>
              <td className="hide-sm">{catLabel(d.category)}</td>
              <td className="hide-sm">{fmtDate(d.created_at)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
