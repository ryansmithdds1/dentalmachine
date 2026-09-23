import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, label } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';
import { useLiveEvents } from '../../live.js';
import ImageViewer from '../ImageViewer.jsx';

// Browsers can't show TIFF or DICOM; those are offered as downloads instead of a broken preview.
const previewable = (mime) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime);
// What the image viewer opens (DICOM is converted on the server).
const viewerable = (mime) => previewable(mime) || mime === 'application/dicom';

const CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'other'];
const catLabel = (c) => (c === 'xray' ? 'X-ray' : label(c));

// Files are behind auth, so fetch them with the bearer token and show via object URLs.
async function fetchBlob(id, image = false) {
  const res = await fetch(`/api/documents/${id}/${image ? 'image' : 'file'}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('Could not load file');
  return URL.createObjectURL(await res.blob());
}

// A small preview from the server. When the server can't make one (a JPEG without an embedded thumbnail),
// this browser makes it from the full image once and hands it back, so nobody downloads the full file again.
async function fetchThumb(id) {
  const res = await fetch(`/api/documents/${id}/thumb`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 200) return URL.createObjectURL(await res.blob());
  if (res.status !== 202) throw new Error('No preview');
  const full = await fetchBlob(id, true);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = full; });
    const f = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(img.naturalWidth * f)), height: Math.max(1, Math.round(img.naturalHeight * f)) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (blob) fetch(`/api/documents/${id}/thumb`, { method: 'PUT', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => {});
    return blob ? URL.createObjectURL(blob) : full;
  } finally {
    setTimeout(() => URL.revokeObjectURL(full), 1000);
  }
}

function Thumb({ doc, onOpen }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!viewerable(doc.mime)) return undefined;
    let url;
    let alive = true;
    fetchThumb(doc.id).then((u) => { url = u; if (alive) setSrc(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [doc.id, doc.mime]);
  return (
    <button className="doc-tile" onClick={onOpen}>
      <div className="doc-thumb">{src ? <img src={src} alt={doc.filename} /> : <span style={{ fontSize: 32 }}>{doc.mime === 'application/pdf' ? '📄' : '📎'}</span>}</div>
      <div className="doc-meta">
        <strong>{doc.filename}{doc.annotated ? ' ✎' : ''}</strong>
        <span className="muted">{catLabel(doc.category)}{doc.tooth ? ` · #${doc.tooth}` : ''} · {fmtDate(doc.created_at)}</span>
      </div>
    </button>
  );
}

export default function DocumentsTab({ patient }) {
  const { can } = useAuth();
  const { data: docs, reload } = useApi(`/patients/${patient.id}/documents`);
  // Images captured through an imaging bridge appear without a refresh.
  useLiveEvents((e) => e.type === 'documents' && e.patient_id === patient.id && reload());
  const [category, setCategory] = useState('xray');
  const [tooth, setTooth] = useState('');
  const [filter, setFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [compare, setCompare] = useState(null);
  const input = useRef(null);
  const [focusMount, setFocusMount] = useState(null);
  const [editing, setEditing] = useState(null);

  const upload = async (files) => {
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const q = new URLSearchParams({ category, filename: file.name, ...(tooth ? { tooth } : {}) });
        const res = await fetch(`/api/patients/${patient.id}/documents?${q}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) throw new Error(`${file.name}: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
      }
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const open = async (doc) => {
    setCompare(null);
    if (viewerable(doc.mime)) { setViewing({ doc, url: null, viewer: true }); return; }
    setViewing({ doc, url: null });
    try {
      setViewing({ doc, url: await fetchBlob(doc.id) });
    } catch (e) {
      setError(e);
      setViewing(null);
    }
  };
  const close = () => {
    if (viewing?.url) URL.revokeObjectURL(viewing.url);
    setViewing(null);
  };
  const remove = async (doc) => {
    if (!confirm(`Remove ${doc.filename} from the chart?`)) return;
    await api.del(`/documents/${doc.id}`);
    close();
    reload();
  };

  const shown = (docs || []).filter((d) => !filter || d.category === filter);

  return (
    <>
      <ImagingBar patient={patient} onCapture={setFocusMount} canCapture={can('clinical:write')} />
      <Mounts patient={patient} docs={(docs || []).filter((d) => viewerable(d.mime))} onOpen={open} canEdit={can('clinical:write')} focus={focusMount} />
      {can('clinical:write') && (
        <div className="card">
          <div className="inline" style={{ flexWrap: 'wrap', gap: 12 }}>
            <label>Type<select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
            <label>Tooth (optional)<input value={tooth} onChange={(e) => setTooth(e.target.value)} style={{ width: 90 }} placeholder="e.g. 19" /></label>
            <label>
              Files (images, PDF, DICOM · max 25 MB)
              <input ref={input} type="file" multiple accept="image/*,application/pdf,.dcm" disabled={uploading} onChange={(e) => upload([...e.target.files])} />
            </label>
            {uploading && <span className="muted">Uploading…</span>}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Documents & imaging</h2>
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 170 }}>
            <option value="">All types</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
        </div>
        {docs && !shown.length && <div className="empty">No documents yet.</div>}
        <div className="doc-grid">{shown.map((d) => <Thumb key={d.id} doc={d} onOpen={() => open(d)} />)}</div>
      </div>

      {viewing && (
        <Modal title={viewing.doc.filename} wide onClose={close}>
          <div className="muted" style={{ marginBottom: 10 }}>
            {catLabel(viewing.doc.category)}{viewing.doc.tooth ? ` · tooth #${viewing.doc.tooth}` : ''} · {viewing.doc.taken_at ? `taken ${fmtDate(viewing.doc.taken_at)} · ` : ''}added {fmtDate(viewing.doc.created_at)}{viewing.doc.uploaded_by_name ? ` by ${viewing.doc.uploaded_by_name}` : viewing.doc.notes ? ` · ${viewing.doc.notes}` : ''}
          </div>
          {viewing.viewer && (
            <>
              <div className="inline" style={{ gap: 8, marginBottom: 8 }}>
                <label className="inline" style={{ gap: 6 }}>Compare with
                  <select aria-label="Compare with" value={compare?.id || ''} onChange={(e) => setCompare((docs || []).find((d) => d.id === Number(e.target.value)) || null)}>
                    <option value="">—</option>
                    {(docs || []).filter((d) => d.id !== viewing.doc.id && viewerable(d.mime)).map((d) => <option key={d.id} value={d.id}>{d.filename} · {fmtDate(d.taken_at || d.created_at)}{d.tooth ? ` · #${d.tooth}` : ''}</option>)}
                  </select>
                </label>
              </div>
              <div className={compare ? 'viewer-compare' : ''}>
                <ImageViewer doc={viewing.doc} canEdit={can('clinical:write')} compact={!!compare} height={compare ? '60vh' : '66vh'} />
                {compare && <ImageViewer key={compare.id} doc={compare} canEdit={can('clinical:write')} compact height="60vh" />}
              </div>
            </>
          )}
          {!viewing.viewer && !viewing.url && <div className="empty">Loading…</div>}
          {viewing.url && previewable(viewing.doc.mime) && <img src={viewing.url} alt={viewing.doc.filename} className="doc-viewer" />}
          {viewing.url && viewing.doc.mime === 'application/pdf' && <iframe src={viewing.url} title={viewing.doc.filename} className="doc-viewer" style={{ height: '70vh', width: '100%', border: 0 }} />}
          {viewing.url && !viewerable(viewing.doc.mime) && viewing.doc.mime !== 'application/pdf' && <p>Preview not available for this file type — <a href={viewing.url} download={viewing.doc.filename}>download it</a> to open in your imaging software.</p>}
          <div className="form-actions">
            {viewing.url && <a href={viewing.url} download={viewing.doc.filename}><button>Download</button></a>}
            {viewing.viewer && <button onClick={() => fetchBlob(viewing.doc.id).then((u) => Object.assign(document.createElement('a'), { href: u, download: viewing.doc.filename }).click())}>Download original</button>}
            {can('clinical:write') && <button onClick={() => setEditing(viewing.doc)}>Edit details</button>}
            {can('clinical:write') && <button className="danger" onClick={() => remove(viewing.doc)}>Remove</button>}
          </div>
        </Modal>
      )}
      {editing && (
        <DocumentDetails doc={editing} onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); setViewing((v) => v && { ...v, doc: { ...v.doc, ...d } }); reload(); }} />
      )}
    </>
  );
}

// Fix what was recorded at upload.
function DocumentDetails({ doc, onClose, onSaved }) {
  const [f, setF] = useState({ filename: doc.filename, category: doc.category, tooth: doc.tooth || '', taken_at: doc.taken_at || '', notes: doc.notes || '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try { onSaved(await api.put(`/documents/${doc.id}`, f)); } catch (err) { setError(err); }
  };
  return (
    <Modal title="Edit document details" onClose={onClose}>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <label className="full">Name<input value={f.filename} onChange={set('filename')} /></label>
          <label>Type<select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
          <label>Tooth<input value={f.tooth} onChange={set('tooth')} placeholder="e.g. 19" /></label>
          <label>Date taken<input type="date" value={f.taken_at} onChange={set('taken_at')} /></label>
          <label className="full">Note<input value={f.notes} onChange={set('notes')} /></label>
        </div>
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save</button></div>
      </form>
    </Modal>
  );
}

const WS_KEY = 'dm_workstation';
const readWs = () => {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
};

// Open the patient in the imaging software on this operatory's PC (through its imaging bridge).
function ImagingBar({ patient, onCapture, canCapture }) {
  const { data: agents } = useApi('/imaging/agents');
  const [ws, setWs] = useState(readWs);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [template, setTemplate] = useState('fmx18');
  const [capture, setCapture] = useState(null);
  // While a capture runs, follow it: the mount fills in as exposures arrive (live events reload it).
  useEffect(() => {
    if (!capture) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const c = await api.get(`/imaging/commands/${capture.id}`);
        if (!alive) return;
        if (c.status === 'expired') { setCapture(null); setError(new Error(`${capture.workstation} didn't pick up the capture — is the imaging bridge running?`)); return; }
        if (c.status === 'done' || c.status === 'error') {
          setCapture(null);
          if (c.status === 'error') setError(new Error(c.result || 'Capture failed'));
          else setStatus(c.result || 'Capture finished');
          return;
        }
        setCapture((x) => x && { ...x, status: c.status });
      } catch { /* keep polling */ }
      if (alive) setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 800);
    return () => { alive = false; clearTimeout(t); };
  }, [capture?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!agents?.length) return null;
  const agent = agents.find((a) => String(a.id) === String(ws));
  const choose = (id) => {
    setWs(id);
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {
      /* per-browser convenience only */
    }
  };
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
          {agent.apps.map((app) => <button key={app.id} className="small primary" disabled={!agent.online} onClick={() => launch(app)}>Open in {app.name}</button>)}
          {!agent.apps.length && !agent.sensor && <span className="muted">No imaging programs set up on {agent.name}.</span>}
        </div>
      )}
      {agent?.sensor && canCapture && (
        <div className="inline imaging-capture" style={{ flexWrap: 'wrap', gap: 6 }}>
          {capture ? (
            <>
              <span className="live-dot on">{capture.status === 'delivered' ? `Ready — take the exposures on ${agent.sensor}; each one fills the next spot` : `Starting ${agent.sensor} on ${agent.name}…`}</span>
              <button className="small" onClick={() => api.post(`/imaging/commands/${capture.id}/stop`).then(() => setCapture(null)).catch(setError)}>Stop capture</button>
            </>
          ) : (
            <>
              <select aria-label="Series to capture" value={template} onChange={(e) => setTemplate(e.target.value)} style={{ width: 'auto' }}>
                {Object.entries(MOUNTS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
              <button className="small primary" disabled={!agent.online} onClick={startCapture}>Capture from {agent.sensor}</button>
            </>
          )}
        </div>
      )}
      {status && <div className="muted imaging-status">{status}</div>}
      <ErrorBox error={error} />
    </div>
  );

  async function startCapture() {
    setError(null);
    setStatus(null);
    try {
      const c = await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: agent.id, template });
      setCapture({ id: c.id, workstation: c.workstation, status: 'pending' });
      onCapture?.(c.mount_id);
    } catch (e) { setError(e); }
  }
}

// Mount layouts: rows of labelled slots (FMX, bitewings, photo series).
const U7 = ['UR molar', 'UR premolar', 'UR canine', 'Upper incisors', 'UL canine', 'UL premolar', 'UL molar'];
const L7 = ['LR molar', 'LR premolar', 'LR canine', 'Lower incisors', 'LL canine', 'LL premolar', 'LL molar'];
const BW4 = ['R molar BW', 'R premolar BW', 'L premolar BW', 'L molar BW'];
export const MOUNTS = {
  fmx18: { label: 'FMX (18)', rows: [U7, BW4, L7] },
  fmx20: { label: 'FMX (20)', rows: [['UR molar', ...U7.slice(0, 3), 'Upper incisors R', 'Upper incisors L', ...U7.slice(4)], BW4, ['LR molar', ...L7.slice(0, 3), 'Lower incisors R', 'Lower incisors L', ...L7.slice(4)]] },
  bw4: { label: '4 bitewings', rows: [BW4] },
  bw2: { label: '2 bitewings', rows: [['Right BW', 'Left BW']] },
  pa4: { label: '4 periapicals', rows: [['PA 1', 'PA 2', 'PA 3', 'PA 4']] },
  photos8: { label: 'Photo series (8)', rows: [['Full face', 'Smile', 'Profile', 'Retracted front'], ['Right buccal', 'Left buccal', 'Upper occlusal', 'Lower occlusal']] },
};

function MountThumb({ docId, onClick, label, onClear }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!docId) { setSrc(null); return undefined; }
    let url;
    fetchThumb(docId).then((u) => setSrc((url = u))).catch(() => {});
    return () => url && URL.revokeObjectURL(url);
  }, [docId]);
  return (
    <div className={`mount-slot${docId ? ' filled' : ''}`} onClick={onClick} role="button" tabIndex={0} title={label}>
      {src ? <img src={src} alt={label} /> : <span>{label}</span>}
      {docId && onClear && <button type="button" className="mount-clear" aria-label="Remove from mount" onClick={(e) => { e.stopPropagation(); onClear(); }}>✕</button>}
    </div>
  );
}

// FMX and other mounts: images placed into a layout, opened in the viewer.
function Mounts({ patient, docs, onOpen, canEdit, focus }) {
  const { data: mounts, reload } = useApi(`/patients/${patient.id}/mounts`);
  const [open, setOpen] = useState(null);
  useLiveEvents((e) => ['mounts', 'documents'].includes(e.type) && e.patient_id === patient.id && reload());
  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    reload();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picking, setPicking] = useState(null);
  const [error, setError] = useState(null);
  const current = mounts?.find((m) => m.id === open) || mounts?.[0];
  const setSlot = async (i, docId) => {
    try {
      await api.put(`/mounts/${current.id}`, { slots: { ...current.slots, [i]: docId } });
      setPicking(null);
      reload();
    } catch (e) { setError(e); }
  };
  if (!mounts || (!mounts.length && !canEdit)) return null;
  let n = 0;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Mounts</h2>
        <div className="inline" style={{ gap: 6 }}>
          {mounts.length > 0 && (
            <select aria-label="Mount" value={current?.id || ''} onChange={(e) => setOpen(Number(e.target.value))}>
              {mounts.map((m) => <option key={m.id} value={m.id}>{MOUNTS[m.template]?.label} · {fmtDate(m.taken_at)}</option>)}
            </select>
          )}
          {canEdit && (
            <select aria-label="New mount" value="" onChange={async (e) => { if (!e.target.value) return; try { const m = await api.post(`/patients/${patient.id}/mounts`, { template: e.target.value }); setOpen(m.id); reload(); } catch (err) { setError(err); } }}>
              <option value="">+ New mount…</option>
              {Object.entries(MOUNTS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {current && (
        <div className="mount-grid">
          {MOUNTS[current.template].rows.map((row, r) => (
            <div key={r} className="mount-row">
              {row.map((label) => {
                const i = n++;
                const docId = current.slots[i];
                return (
                  <MountThumb key={i} docId={docId} label={label}
                    onClick={() => (docId ? onOpen(docs.find((d) => d.id === docId) || { id: docId, mime: 'image/png', filename: label, category: 'xray' }) : canEdit && setPicking(i))}
                    onClear={canEdit ? () => setSlot(i, null) : null} />
                );
              })}
            </div>
          ))}
        </div>
      )}
      {picking != null && (
        <Modal title="Choose an image for this spot" onClose={() => setPicking(null)}>
          {docs.length === 0 ? <div className="muted">No images yet.</div> : (
            <div className="doc-grid">{docs.map((d) => <Thumb key={d.id} doc={d} onOpen={() => setSlot(picking, d.id)} />)}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
