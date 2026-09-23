import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, label } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';

const CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'other'];
const catLabel = (c) => (c === 'xray' ? 'X-ray' : label(c));

// Files are behind auth, so fetch them with the bearer token and show via object URLs.
async function fetchBlob(id) {
  const res = await fetch(`/api/documents/${id}/file`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('Could not load file');
  return URL.createObjectURL(await res.blob());
}

function Thumb({ doc, onOpen }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!doc.mime.startsWith('image/')) return undefined;
    let url;
    fetchBlob(doc.id).then((u) => setSrc((url = u))).catch(() => {});
    return () => url && URL.revokeObjectURL(url);
  }, [doc.id, doc.mime]);
  return (
    <button className="doc-tile" onClick={onOpen}>
      <div className="doc-thumb">{src ? <img src={src} alt={doc.filename} /> : <span style={{ fontSize: 32 }}>{doc.mime === 'application/pdf' ? '📄' : '📎'}</span>}</div>
      <div className="doc-meta">
        <strong>{doc.filename}</strong>
        <span className="muted">{catLabel(doc.category)}{doc.tooth ? ` · #${doc.tooth}` : ''} · {fmtDate(doc.created_at)}</span>
      </div>
    </button>
  );
}

export default function DocumentsTab({ patient }) {
  const { can } = useAuth();
  const { data: docs, reload } = useApi(`/patients/${patient.id}/documents`);
  const [category, setCategory] = useState('xray');
  const [tooth, setTooth] = useState('');
  const [filter, setFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const input = useRef(null);

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
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 170 }}>
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
            {catLabel(viewing.doc.category)}{viewing.doc.tooth ? ` · tooth #${viewing.doc.tooth}` : ''} · uploaded {fmtDate(viewing.doc.created_at)} by {viewing.doc.uploaded_by_name}
          </div>
          {!viewing.url && <div className="empty">Loading…</div>}
          {viewing.url && viewing.doc.mime.startsWith('image/') && <img src={viewing.url} alt={viewing.doc.filename} className="doc-viewer" />}
          {viewing.url && viewing.doc.mime === 'application/pdf' && <iframe src={viewing.url} title={viewing.doc.filename} className="doc-viewer" style={{ height: '70vh', width: '100%', border: 0 }} />}
          {viewing.url && !viewing.doc.mime.startsWith('image/') && viewing.doc.mime !== 'application/pdf' && <p>Preview not available for this file type.</p>}
          <div className="form-actions">
            {viewing.url && <a href={viewing.url} download={viewing.doc.filename}><button>Download</button></a>}
            {can('clinical:write') && <button className="danger" onClick={() => remove(viewing.doc)}>Remove</button>}
          </div>
        </Modal>
      )}
    </>
  );
}
