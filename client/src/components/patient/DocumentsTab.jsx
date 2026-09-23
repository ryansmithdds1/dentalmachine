import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, label } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';
import { useLiveEvents } from '../../live.js';
import { ScanLine, Radio } from 'lucide-react';
import ImageViewer from '../ImageViewer.jsx';
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
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [phone, setPhone] = useState(false);
  const [studio, setStudio] = useState(null);

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

  const tagsOf = (d) => { try { return JSON.parse(d.tags || '[]'); } catch { return []; } };
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (docs || []).filter((d) => (!filter || d.category === filter)
    && words.every((w) => [d.filename, d.notes, d.tooth ? `#${d.tooth}` : '', catLabel(d.category), ...tagsOf(d)].join(' ').toLowerCase().includes(w)));

  return (
    <>
      <ImagingBar patient={patient} canCapture={can('clinical:write')} onStudio={setStudio} />
      <Mounts patient={patient} docs={docs} canEdit={can('clinical:write')} onStudio={setStudio} />
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
          <input type="search" aria-label="Search documents" placeholder="Search name, note, tag…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
          {can('clinical:write') && <button onClick={() => setPhone(true)} title="Take photos or scans with a phone straight into this chart">📱 Scan from phone</button>}
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 170 }}>
            <option value="">All types</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
        </div>
        {docs && !shown.length && <div className="empty">{docs.length ? 'Nothing matches.' : 'No documents yet.'}</div>}
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
      {studio && (
        <ImagingStudio patient={patient} docs={(docs || []).filter((d) => viewerable(d.mime))} canEdit={can('clinical:write')} initial={studio}
          onClose={() => { setStudio(null); reload(); }} onDocsChanged={reload} />
      )}
      {phone && <PhoneScan patient={patient} category={category} onClose={() => setPhone(false)} />}
      {editing && (
        <DocumentDetails doc={editing} onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); setViewing((v) => v && { ...v, doc: { ...v.doc, ...d } }); reload(); }} />
      )}
    </>
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

// Fix what was recorded at upload.
function DocumentDetails({ doc, onClose, onSaved }) {
  const [f, setF] = useState({ filename: doc.filename, category: doc.category, tooth: doc.tooth || '', taken_at: doc.taken_at || '', notes: doc.notes || '', tags: (() => { try { return JSON.parse(doc.tags || '[]').join(', '); } catch { return ''; } })() });
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
          <label className="full">Tags (comma-separated)<input value={f.tags} onChange={set('tags')} placeholder="e.g. pre-op, ortho records" /></label>
        </div>
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save</button></div>
      </form>
    </Modal>
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
function Mounts({ patient, docs, canEdit, onStudio }) {
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
