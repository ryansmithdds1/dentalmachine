import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, label } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';
import { useLiveEvents } from '../../live.js';
import { ScanLine, Radio, Video, Upload } from 'lucide-react';
import { useRemembered } from '../../prefs.js';
import { useShortcuts, typingIn } from '../../shortcuts.js';
import { toast, undoable } from '../../toast.js';
import { guessCategory } from '../imaging/category.js';
import '../imaging/documents.css';
import ImageViewer from '../ImageViewer.jsx';
import { is3dDoc, Viewer3D, zipFolder } from '../volume/index.jsx';
import ImagingStudio, { MountBoard } from '../imaging/ImagingStudio.jsx';
import { MOUNTS, slotLabels } from '../imaging/mounts.js';
import { fetchBlob, useThumb } from '../imaging/thumbs.js';
import { thumbStyle } from '../imaging/imageproc.js';
import { readWs, saveWs } from '../imaging/workstation.js';

// Browsers can't show TIFF or DICOM; those are offered as downloads instead of a broken preview.
const previewable = (mime) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime);
// What the image viewer opens (DICOM is converted on the server).
const viewerable = (mime) => previewable(mime) || mime === 'application/dicom';

const CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'other'];
const catLabel = (c) => (c === 'xray' ? 'X-ray' : label(c));
const uploadKey = () => `up-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`;

function Thumb({ doc, onOpen }) {
  const src = useThumb(doc.id, viewerable(doc.mime));
  return (
    <button className="doc-tile" onClick={onOpen}>
      <div className="doc-thumb">{src ? <img src={src} alt={doc.filename} style={thumbStyle(doc.adjust)} /> : <span style={{ fontSize: 32 }}>{doc.mime === 'application/pdf' ? '📄' : '📎'}</span>}</div>
      <div className="doc-meta">
        <strong>{doc.filename}{doc.annotated ? ' ✎' : ''}{doc.retake_of ? ' · retake' : ''}</strong>
        <span className="muted">{catLabel(doc.category)}{doc.tooth ? ` · #${doc.tooth}` : ''} · {fmtDate(doc.created_at)}</span>
        {doc.tags && JSON.parse(doc.tags).length > 0 && <span className="doc-tags">{JSON.parse(doc.tags).map((t) => <i key={t}>{t}</i>)}</span>}
      </div>
    </button>
  );
}

export default function DocumentsTab({ patient }) {
  const { can } = useAuth();
  const canWrite = can('clinical:write');
  const { data: docs, reload } = useApi(`/patients/${patient.id}/documents`);
  // Images captured through an imaging bridge appear without a refresh.
  useLiveEvents((e) => e.type === 'documents' && e.patient_id === patient.id && reload());
  // "Automatic" files each upload by what it is (see imaging/category.js); a type picked here is remembered.
  const [typePick, rememberType] = useRemembered('documents.type', 'auto');
  const [lastPdf, rememberPdf] = useRemembered('documents.category@pdf', 'document');
  const [tooth, setTooth] = useState('');
  const [filter, setFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [compare, setCompare] = useState(null);
  const input = useRef(null);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [phone, setPhone] = useState(false);
  const [studio, setStudio] = useState(null);
  const [dragging, setDragging] = useState(false);
  const who = patient.preferred_name || patient.first_name;

  const upload = async (files) => {
    files = files.filter((f) => f && f.size);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    const added = [];
    try {
      for (const file of files) {
        // CBCT zips and 3D scans: the server works out whether it's an x-ray series or a scan.
        const threeD = /\.(zip|stl|ply|obj)$/i.test(file.name || '');
        const category = typePick !== 'auto' ? typePick : threeD ? null : await guessCategory(file, { lastPdf });
        const q = new URLSearchParams({ ...(category ? { category } : {}), filename: file.name || 'upload', ...(tooth ? { tooth } : {}) });
        const res = await fetch(`/api/patients/${patient.id}/documents?${q}`, {
          method: 'POST',
          // One key per file: a retried or doubled request files it once.
          headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type || 'application/octet-stream', 'Idempotency-Key': uploadKey() },
          body: file,
        });
        if (!res.ok) throw new Error(`${file.name}: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
        added.push(await res.json());
      }
    } catch (e) {
      setError(e);
      toast(e.message || 'Upload failed', { tone: 'error' });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
      reload();
    }
    if (added.length) {
      const kinds = [...new Set(added.map((d) => catLabel(d.category)))].join(', ');
      toast(`Added ${added.length === 1 ? added[0].filename : `${added.length} files`} to ${who}’s chart as ${kinds}`, {
        undo: async () => {
          for (const d of added) await api.del(`/documents/${d.id}`);
          reload();
          toast('Upload removed');
        },
      });
    }
  };

  // Paste a screenshot or copied image straight into the chart (not while typing in a box).
  useEffect(() => {
    if (!canWrite) return undefined;
    const onPaste = (e) => {
      if (typingIn(e.target) || document.querySelector('.modal, .studio')) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      upload(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${stamp}${i ? `-${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const drop = {
    onDragEnter: (e) => { if (canWrite && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e) => { if (canWrite && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); },
    onDrop: (e) => {
      if (!canWrite || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setDragging(false);
      upload([...e.dataTransfer.files]);
    },
  };

  const viewables = (list) => list.filter((d) => viewerable(d.mime));
  const open = async (doc, list = null) => {
    setCompare(null);
    setEditing(false);
    // CBCT and 3D scans open in their own viewer, which streams what it needs (no whole-file download).
    if (is3dDoc(doc)) { setViewing({ doc, url: null, three: true }); return; }
    if (viewerable(doc.mime)) { setViewing({ doc, url: null, viewer: true, list: (list || viewables(shown)).map((d) => d.id) }); return; }
    setViewing({ doc, url: null });
    try {
      setViewing({ doc, url: await fetchBlob(doc.id) });
    } catch (e) {
      setError(e);
      setViewing(null);
    }
  };
  // ← → in the viewer: the next image in the same list (the grid as filtered, or the x-rays).
  const step = (d) => setViewing((v) => {
    if (!v?.list?.length) return v;
    const at = v.list.indexOf(v.doc.id);
    const next = (docs || []).find((x) => x.id === v.list[(at + d + v.list.length) % v.list.length]);
    return next ? { ...v, doc: next } : v;
  });
  const close = () => {
    if (viewing?.url) URL.revokeObjectURL(viewing.url);
    setViewing(null);
    setEditing(false);
  };
  // No "Are you sure?": the file is only hidden (kept for the record), and Undo brings it back.
  const remove = async (doc) => {
    close();
    try {
      await undoable(`Removed ${doc.filename} from ${who}’s chart`, () => api.del(`/documents/${doc.id}`), async () => { await api.post(`/documents/${doc.id}/restore`); reload(); });
    } catch { /* the toast says what went wrong */ }
    reload();
  };

  // X: the newest x-ray set (a mount) opens on its first image; ← → go through it, Esc closes.
  const openLatestXrays = async () => {
    try {
      const mounts = await api.get(`/patients/${patient.id}/mounts`);
      const set = mounts.find((m) => m.template !== 'photos8' && Object.keys(m.slots).length);
      if (set) {
        const first = Math.min(...Object.keys(set.slots).map(Number));
        setStudio({ mountId: set.id, slot: first, quick: true });
        return;
      }
      const xrays = viewables((docs || []).filter((d) => d.category === 'xray'));
      if (xrays.length) open(xrays[0], xrays);
      else toast(`No x-rays yet for ${who}`);
    } catch (e) {
      setError(e);
    }
  };
  useShortcuts([
    { combo: 'x', handler: openLatestXrays, label: 'Open the latest x-rays (← → between images, Esc closes)', section: 'Documents & x-rays', enabled: !studio && !viewing },
    { combo: 'u', handler: () => input.current?.click(), label: 'Add files (or drop / paste them anywhere here)', section: 'Documents & x-rays', enabled: canWrite && !studio && !viewing },
  ]);

  const tagsOf = (d) => { try { return JSON.parse(d.tags || '[]'); } catch { return []; } };
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (docs || []).filter((d) => (!filter || d.category === filter)
    && words.every((w) => [d.filename, d.notes, d.tooth ? `#${d.tooth}` : '', catLabel(d.category), ...tagsOf(d)].join(' ').toLowerCase().includes(w)));
  const position = viewing?.list?.length > 1 ? `${viewing.list.indexOf(viewing.doc.id) + 1} of ${viewing.list.length}` : null;

  return (
    <div className={`docs-drop${dragging ? ' over' : ''}`} {...drop} data-testid="documents-drop">
      {dragging && <div className="docs-drop-hint" aria-hidden>Drop to add to {who}’s chart</div>}
      <ImagingBar patient={patient} canCapture={canWrite} onStudio={setStudio} />
      <Mounts patient={patient} docs={docs} canEdit={canWrite} onStudio={setStudio} onLatest={openLatestXrays} />
      {canWrite && (
        <div className="card docs-add">
          <div className="inline" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
            <label>Type
              <select value={typePick} onChange={(e) => rememberType(e.target.value)}>
                <option value="auto">Automatic (from the file)</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
              </select>
            </label>
            <label>Tooth (optional)<input value={tooth} onChange={(e) => setTooth(e.target.value)} style={{ width: 90 }} placeholder="e.g. 19" /></label>
            <label>
              Files (images, PDF, DICOM, 3D scans STL/PLY/OBJ · max 25 MB; CBCT zip up to 1 GB)
              <input ref={input} type="file" multiple accept="image/*,application/pdf,.dcm,.zip,.stl,.ply,.obj" disabled={uploading} onChange={(e) => upload([...e.target.files])} />
            </label>
            <label>
              CBCT folder
              <input type="file" webkitdirectory="" disabled={uploading} aria-label="Upload a CBCT folder" onChange={async (e) => {
                const files = [...e.target.files];
                if (!files.length) return;
                const folder = (files[0].webkitRelativePath || 'cbct').split('/')[0] || 'cbct';
                upload([new File([await zipFolder(files)], `${folder}.zip`, { type: 'application/zip' })]);
                e.target.value = '';
              }} />
            </label>
            {uploading ? <span className="muted">Uploading…</span> : <span className="muted docs-drop-note"><Upload size={14} aria-hidden /> or drop files anywhere here, or paste (Ctrl+V) · <kbd>U</kbd></span>}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Documents & imaging</h2>
          <input type="search" aria-label="Search documents" placeholder="Search name, note, tag…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
          {canWrite && <button onClick={() => setPhone(true)} title="Take photos or scans with a phone straight into this chart">📱 Scan from phone</button>}
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 170 }}>
            <option value="">All types</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
        </div>
        {docs && !shown.length && <div className="empty">{docs.length ? 'Nothing matches.' : `No documents yet. ${canWrite ? 'Drop files here or paste an image to add them.' : ''}`}</div>}
        <div className="doc-grid">{shown.map((d) => <Thumb key={d.id} doc={d} onOpen={() => open(d)} />)}</div>
      </div>

      {viewing && (
        <Modal title={viewing.doc.filename} wide onClose={close}>
          {/* Delete removes (with Undo); the viewer's own keys (← →, zoom, tools) work while it has focus. */}
          <div onKeyDown={(e) => { if (e.key === 'Delete' && canWrite && !typingIn(e.target)) { e.preventDefault(); remove(viewing.doc); } }}>
            <div className="muted" style={{ marginBottom: 10 }}>
              {position && <strong className="doc-position">{position} · </strong>}
              {catLabel(viewing.doc.category)}{viewing.doc.tooth ? ` · tooth #${viewing.doc.tooth}` : ''} · {viewing.doc.taken_at ? `taken ${fmtDate(viewing.doc.taken_at)} · ` : ''}added {fmtDate(viewing.doc.created_at)}{viewing.doc.uploaded_by_name ? ` by ${viewing.doc.uploaded_by_name}` : viewing.doc.notes ? ` · ${viewing.doc.notes}` : ''}
            </div>
            {viewing.viewer && (
              <div className={compare ? 'viewer-compare' : ''}>
                <ImageViewer doc={viewing.doc} canEdit={canWrite} compact={!!compare} height={compare ? '60vh' : editing ? '46vh' : '62vh'} autoFocus
                  onPrev={viewing.list?.length > 1 ? () => step(-1) : undefined} onNext={viewing.list?.length > 1 ? () => step(1) : undefined} />
                {compare && <ImageViewer key={compare.id} doc={compare} canEdit={canWrite} compact height="60vh" />}
              </div>
            )}
            {viewing.three && <Viewer3D documentId={viewing.doc.id} canEdit={canWrite} onClose={close} onSaved={reload} height="78vh" />}
            {!viewing.viewer && !viewing.three && !viewing.url && <div className="empty">Loading…</div>}
            {viewing.url && previewable(viewing.doc.mime) && <img src={viewing.url} alt={viewing.doc.filename} className="doc-viewer" />}
            {viewing.url && viewing.doc.mime === 'application/pdf' && <iframe src={viewing.url} title={viewing.doc.filename} className="doc-viewer" style={{ height: '70vh', width: '100%', border: 0 }} />}
            {viewing.url && !viewerable(viewing.doc.mime) && viewing.doc.mime !== 'application/pdf' && <p>Preview not available for this file type — <a href={viewing.url} download={viewing.doc.filename}>download it</a> to open in your imaging software.</p>}
            {editing && (
              <DocumentDetails key={viewing.doc.id} doc={viewing.doc} onClose={() => setEditing(false)}
                onSaved={(d) => {
                  // A PDF filed as something else teaches the default for the next PDF.
                  if (viewing.doc.mime === 'application/pdf' && d.category !== viewing.doc.category) rememberPdf(d.category);
                  setEditing(false);
                  setViewing((v) => v && { ...v, doc: { ...v.doc, ...d } });
                  reload();
                }} />
            )}
            <div className="form-actions doc-actions">
              {viewing.viewer && (
                <label className="inline" style={{ gap: 6, marginRight: 'auto' }}>Compare with
                  <select aria-label="Compare with" value={compare?.id || ''} onChange={(e) => setCompare((docs || []).find((d) => d.id === Number(e.target.value)) || null)}>
                    <option value="">—</option>
                    {(docs || []).filter((d) => d.id !== viewing.doc.id && viewerable(d.mime)).map((d) => <option key={d.id} value={d.id}>{d.filename} · {fmtDate(d.taken_at || d.created_at)}{d.tooth ? ` · #${d.tooth}` : ''}</option>)}
                  </select>
                </label>
              )}
              {viewing.url && <a href={viewing.url} download={viewing.doc.filename}><button>Download</button></a>}
              {viewing.viewer && <button onClick={() => fetchBlob(viewing.doc.id).then((u) => Object.assign(document.createElement('a'), { href: u, download: viewing.doc.filename }).click())}>Download original</button>}
              {canWrite && !editing && <button onClick={() => setEditing(true)}>Edit details</button>}
              {canWrite && <button className="danger" onClick={() => remove(viewing.doc)} title="Remove from the chart (Delete) — you can undo">Remove</button>}
            </div>
          </div>
        </Modal>
      )}
      {studio && (
        <ImagingStudio patient={patient} docs={(docs || []).filter((d) => viewerable(d.mime))} canEdit={canWrite} initial={studio}
          onClose={() => { setStudio(null); reload(); }} onDocsChanged={reload} />
      )}
      {phone && <PhoneScan patient={patient} category={typePick === 'auto' ? 'document' : typePick} onClose={() => setPhone(false)} />}
    </div>
  );
}

// A QR code the office shows a patient (or scans with a staff phone): photos taken on that phone go
// straight into this chart. Good for 15 minutes; new files appear here as they arrive.
function PhoneScan({ patient, category, onClose }) {
  const [link, setLink] = useState(null);
  const [qr, setQr] = useState(null);
  const [cat, setCat] = useState(category === 'xray' ? 'document' : category);
  const [error, setError] = useState(null);
  const make = async (c) => {
    setError(null);
    try {
      const l = await api.post(`/patients/${patient.id}/upload-links`, { category: c });
      setLink(l);
      setQr(await QRCode.toDataURL(l.url, { margin: 1, width: 220 }));
    } catch (e) { setError(e); }
  };
  useEffect(() => { make(cat); }, [cat]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Scan from a phone" onClose={onClose}>
      <ErrorBox error={error} />
      <label>Save as<select value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
      {link && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          {qr && <img src={qr} alt="QR code to upload from a phone" width={220} height={220} />}
          <p>Scan with the phone camera, then take photos of the {catLabel(cat).toLowerCase()} (insurance card, referral letter, outside x-ray…). They land in {patient.first_name}&apos;s chart.</p>
          <p className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{link.url}<br />Works for 15 minutes.</p>
        </div>
      )}
    </Modal>
  );
}

// Fix what was recorded at upload, in a panel under the image (not a second dialog on top of the viewer).
// Enter saves, Esc closes just this panel.
function DocumentDetails({ doc, onClose, onSaved }) {
  const [f, setF] = useState({ filename: doc.filename, category: doc.category, tooth: doc.tooth || '', taken_at: doc.taken_at || '', notes: doc.notes || '', tags: (() => { try { return JSON.parse(doc.tags || '[]').join(', '); } catch { return ''; } })() });
  const [error, setError] = useState(null);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try { onSaved(await api.put(`/documents/${doc.id}`, f)); } catch (err) { setError(err); }
  };
  return (
    <form className="doc-details" aria-label="Document details" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <h3>Details</h3>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Name<input ref={first} value={f.filename} onChange={set('filename')} /></label>
        <label>Type<select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
        <label>Tooth<input value={f.tooth} onChange={set('tooth')} placeholder="e.g. 19" /></label>
        <label>Date taken<input type="date" value={f.taken_at} onChange={set('taken_at')} /></label>
        <label className="full">Note<input value={f.notes} onChange={set('notes')} /></label>
        <label className="full">Tags (comma-separated)<input value={f.tags} onChange={set('tags')} placeholder="e.g. pre-op, ortho records" /></label>
      </div>
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save details</button></div>
    </form>
  );
}

// Open the patient in the imaging software on this operatory's PC (through its imaging bridge), or
// capture straight from the sensor into the imaging studio.
function ImagingBar({ patient, canCapture, onStudio }) {
  const { data: agents } = useApi('/imaging/agents');
  const [ws, setWs] = useState(readWs);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [template, setTemplate] = useState('fmx18');
  if (!agents?.length) return null;
  const agent = agents.find((a) => String(a.id) === String(ws));
  const choose = (id) => { setWs(id); saveWs(id); };
  const launch = async (app) => {
    setError(null);
    setStatus(`Opening ${patient.first_name} in ${app.name} on ${agent.name}…`);
    try {
      const cmd = await api.post(`/patients/${patient.id}/imaging/launch`, { agent_id: agent.id, app: app.id });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const c = await api.get(`/imaging/commands/${cmd.id}`);
        if (c.status === 'done') return setStatus(`${app.name} is open on ${agent.name}. New images will appear here automatically.`);
        if (c.status === 'error' || c.status === 'expired') throw new Error(c.result || `${agent.name} didn't respond`);
      }
      setStatus(null);
      throw new Error(`${agent.name} hasn't picked it up — is the imaging bridge running on that computer?`);
    } catch (e) {
      setStatus(null);
      setError(e);
    }
  };
  const sensorName = agent?.sensor?.replace(/\s*\(.*\)$/, '');
  return (
    <div className="card imaging-bar">
      <label className="imaging-ws">
        <span className="muted">This computer</span>
        <select aria-label="Imaging workstation" value={agent ? agent.id : ''} onChange={(e) => choose(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Choose workstation…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? '' : ' (offline)'}</option>)}
        </select>
      </label>
      {agent && (
        <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className={`live-dot${agent.online ? ' on' : ''}`}>{agent.online ? 'Bridge online' : 'Bridge offline'}</span>
          {agent.apps.map((app) => <button key={app.id} className="small" disabled={!agent.online} onClick={() => launch(app)}>Open in {app.name}</button>)}
          {!agent.apps.length && !agent.sensor && <span className="muted">No imaging programs set up on {agent.name}.</span>}
        </div>
      )}
      {agent?.sensor && canCapture && (
        <div className="inline imaging-capture" style={{ flexWrap: 'wrap', gap: 6 }}>
          <select aria-label="Series to capture" value={template} onChange={(e) => setTemplate(e.target.value)} style={{ width: 'auto' }}>
            {Object.entries(MOUNTS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
          <button className="small primary" disabled={!agent.online} onClick={() => onStudio({ capture: true, template })}><Radio size={14} /> Capture from {sensorName}</button>
        </div>
      )}
      {status && <div className="muted imaging-status">{status}</div>}
      <ErrorBox error={error} />
    </div>
  );
}

// The latest mounts at a glance; the studio opens on a click (at the spot clicked).
function Mounts({ patient, docs, canEdit, onStudio, onLatest }) {
  const { data: mounts, reload } = useApi(`/patients/${patient.id}/mounts`);
  const docById = new Map((docs || []).map((d) => [d.id, d]));
  const [open, setOpen] = useState(null);
  useLiveEvents((e) => ['mounts', 'documents'].includes(e.type) && e.patient_id === patient.id && reload());
  if (!mounts || (!mounts.length && !canEdit)) return null;
  const current = mounts.find((m) => m.id === open) || mounts[0];
  const filled = current ? Object.keys(current.slots).length : 0;
  return (
    <div className="card">
      <div className="mount-card-head">
        <h2 style={{ margin: 0 }}>X-rays & mounts</h2>
        <div className="inline" style={{ gap: 6 }}>
          {mounts.length > 1 && (
            <select aria-label="Mount" value={current?.id || ''} onChange={(e) => setOpen(Number(e.target.value))} style={{ width: 'auto' }}>
              {mounts.map((m) => <option key={m.id} value={m.id}>{MOUNTS[m.template]?.label} · {fmtDate(m.taken_at)}</option>)}
            </select>
          )}
          {canEdit && <button className="small" onClick={() => onStudio({ mountId: current?.id, camera: true })}><Video size={14} /> Intraoral camera</button>}
          {current && <button className="small" onClick={onLatest} title="Open the newest x-ray set on its first image (X)">Latest x-rays <kbd>X</kbd></button>}
          <button className="small primary" onClick={() => onStudio({ mountId: current?.id })}><ScanLine size={14} /> Open imaging</button>
        </div>
      </div>
      {current ? (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{MOUNTS[current.template]?.label} · {fmtDate(current.taken_at)} · {filled} of {slotLabels(current.template).length} images</div>
          <div className="mount-strip" title="Click an image to open it in the imaging studio">
            <MountBoard mount={current} labels={slotLabels(current.template)} selected={null} next={-1} capturing={false} canEdit={false} sensorReady={false}
              adjustOf={(id) => docById.get(id)?.adjust} docById={docById} onClick={(i) => onStudio({ mountId: current.id, slot: current.slots[i] != null ? i : null })} onRetake={() => {}} onClear={() => {}} compact />
          </div>
        </>
      ) : <div className="muted" style={{ marginTop: 6 }}>No mounts yet — open imaging to start an FMX, bitewings or a single PA.</div>}
    </div>
  );
}
