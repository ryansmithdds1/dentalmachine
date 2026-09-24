import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, FilePlus2, RotateCw, Send, Trash2, ChevronLeft, ChevronRight, Check, Images } from 'lucide-react';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { findDocumentQuad, processPage, rotate90 } from '../../components/docs/docscan.js';
import { jpegsToPdf } from '../../components/docs/pdfmake.js';
import '../../components/docs/docs.css';

const MAX_SIDE = 1800;
const MODES = [['color', 'Colour'], ['gray', 'Grey'], ['bw', 'Black & white'], ['photo', 'Photo as is']];

// A photo from the camera as pixels, turned the right way up (EXIF) and shrunk to a size a phone handles well.
async function loadImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That picture couldn’t be opened'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w * s), height: Math.round(h * s) });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}
function toJpeg(img, quality = 0.82) {
  const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Opened from the QR code in the office: pages photographed here are found in the picture, straightened,
// cleaned up and sent to the patient's chart as one PDF. Nothing is sent until "Send". Photos can also go
// as they are (a mouth photo, an ID).
export default function PhoneUpload() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState([]);
  const [busy, setBusy] = useState(null);
  const [pages, setPages] = useState([]); // { blob, url }
  const [editing, setEditing] = useState(null); // { img, quad, mode, turns, found }
  const [mode, setMode] = useState('color');
  const camera = useRef(null);
  useEffect(() => { api.get(`/public/upload/${token}`).then(setInfo).catch(setError); }, [token]);
  useEffect(() => () => pages.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (blob, filename) => {
    const res = await fetch(`/api/public/upload/${token}?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    setSent((s) => [...s, filename]);
  };
  // Photos straight through, as they are.
  const uploadAsIs = async (files) => {
    setBusy('Sending…');
    setError(null);
    for (const f of files) {
      try { await send(f, f.name || 'photo.jpg'); } catch (e) { setError(e); }
    }
    setBusy(null);
  };
  const shoot = async (file) => {
    if (!file) return;
    setError(null);
    setBusy('Finding the page…');
    await nextFrame();
    try {
      const img = await loadImage(file);
      const { quad, found } = findDocumentQuad(img);
      setEditing({ img, quad, found, turns: 0 });
    } catch (e) { setError(e); }
    setBusy(null);
    if (camera.current) camera.current.value = '';
  };
  const keep = async () => {
    setBusy('Straightening…');
    await nextFrame();
    try {
      let page = processPage(editing.img, editing.quad, { mode });
      page = rotate90(page, editing.turns);
      const blob = await toJpeg(page, mode === 'bw' ? 0.7 : 0.82);
      setPages((p) => [...p, { blob, url: URL.createObjectURL(blob) }]);
      setEditing(null);
    } catch (e) { setError(e); }
    setBusy(null);
  };
  const sendPdf = async () => {
    setBusy(`Sending ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
    setError(null);
    try {
      const bytes = await Promise.all(pages.map(async (p) => new Uint8Array(await p.blob.arrayBuffer())));
      const pdf = new Blob([jpegsToPdf(bytes)], { type: 'application/pdf' });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      await send(pdf, `Scan ${stamp} (${pages.length} page${pages.length === 1 ? '' : 's'}).pdf`);
      pages.forEach((p) => URL.revokeObjectURL(p.url));
      setPages([]);
    } catch (e) { setError(e); }
    setBusy(null);
  };
  const move = (i, d) => setPages((p) => {
    const next = [...p];
    const j = i + d;
    if (j < 0 || j >= next.length) return p;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  if (!info) return <PublicLayout title="Add to chart">{error ? <ErrorBox error={error} /> : <div className="empty">Loading…</div>}</PublicLayout>;
  return (
    <PublicLayout title={`Add to ${info.patient}'s chart`} practice={{ name: info.practice }}>
      <div className="card pscan">
        {!editing && (
          <>
            <p style={{ margin: 0 }}>Photograph each page on a darker surface. We find the page, straighten it and send them together as one PDF to {info.practice}.</p>
            <label className="phone-upload primary pscan-big">
              <Camera size={22} aria-hidden /> {pages.length ? 'Scan the next page' : 'Scan a document'}
              <input ref={camera} type="file" accept="image/*" capture="environment" disabled={!!busy} onChange={(e) => shoot(e.target.files[0])} aria-label="Scan a page with the camera" />
            </label>
          </>
        )}
        {editing && <PageEditor editing={editing} setEditing={setEditing} mode={mode} setMode={setMode} onKeep={keep} busy={!!busy} />}
        {busy && <p className="muted" role="status">{busy}</p>}
        <ErrorBox error={error} />
        {pages.length > 0 && !editing && (
          <>
            <div className="pscan-pages" aria-label="Pages scanned">
              {pages.map((p, i) => (
                <div key={p.url} className="pscan-page">
                  <img src={p.url} alt={`Page ${i + 1}`} />
                  <span className="n">{i + 1}</span>
                  <div className="tools">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move page ${i + 1} earlier`}><ChevronLeft size={14} /></button>
                    <button type="button" onClick={() => { URL.revokeObjectURL(p.url); setPages((all) => all.filter((x) => x !== p)); }} aria-label={`Remove page ${i + 1}`}><Trash2 size={14} /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === pages.length - 1} aria-label={`Move page ${i + 1} later`}><ChevronRight size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
            <button className="primary pscan-big" disabled={!!busy} onClick={sendPdf}><Send size={20} aria-hidden /> Send {pages.length} page{pages.length === 1 ? '' : 's'} as one PDF</button>
          </>
        )}
        {!editing && (
          <div className="inline" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <label className="phone-upload">
              <Images size={16} aria-hidden /> Send photos as they are
              <input type="file" accept="image/*" multiple disabled={!!busy} onChange={(e) => uploadAsIs([...e.target.files])} />
            </label>
            <label className="phone-upload">
              <FilePlus2 size={16} aria-hidden /> Choose files
              <input type="file" accept="image/*,application/pdf" multiple disabled={!!busy} onChange={(e) => uploadAsIs([...e.target.files])} />
            </label>
          </div>
        )}
        {sent.length > 0 && <div className="public-notice ok"><Check size={15} aria-hidden /> {sent.length} sent: {sent.join(', ')}</div>}
      </div>
    </PublicLayout>
  );
}

// The photo with the page's corners marked; drag a corner to fix it. Colour / grey / black & white, rotate.
function PageEditor({ editing, setEditing, mode, setMode, onKeep, busy }) {
  const canvas = useRef(null);
  const svg = useRef(null);
  const [drag, setDrag] = useState(null);
  const { img, quad } = editing;
  useEffect(() => {
    const c = canvas.current;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  }, [img]);
  const toImage = (e) => {
    const box = svg.current.getBoundingClientRect();
    return [Math.min(img.width, Math.max(0, ((e.clientX - box.left) / box.width) * img.width)), Math.min(img.height, Math.max(0, ((e.clientY - box.top) / box.height) * img.height))];
  };
  const onMove = (e) => {
    if (drag == null) return;
    const q = quad.map((p, i) => (i === drag ? toImage(e) : p));
    setEditing({ ...editing, quad: q });
  };
  const r = Math.max(img.width, img.height) / 28;
  return (
    <div className="pscan">
      <p style={{ margin: 0 }}>{editing.found ? 'Page found — drag a corner if it’s off.' : 'Drag the four corners onto the page’s corners.'}</p>
      <div className="pscan-edit">
        <canvas ref={canvas} aria-label="The photo" />
        <svg ref={svg} viewBox={`0 0 ${img.width} ${img.height}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
          <polygon points={quad.map((p) => p.join(',')).join(' ')} fill="rgba(20,184,166,0.12)" stroke="#14b8a6" strokeWidth={Math.max(2, r / 5)} />
          {quad.map(([x, y], i) => (
            <circle key={i} className="pscan-handle" cx={x} cy={y} r={r} onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(i); }}
              role="slider" aria-label={['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'][i]} aria-valuenow={Math.round(x)} tabIndex={0}
              onKeyDown={(e) => {
                const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
                if (!step) return;
                e.preventDefault();
                setEditing({ ...editing, quad: quad.map((p, j) => (j === i ? [p[0] + step[0], p[1] + step[1]] : p)) });
              }} />
          ))}
        </svg>
      </div>
      <div className="pscan-modes" role="group" aria-label="How it should look">
        {MODES.map(([k, l]) => <button key={k} type="button" className="small" aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}
        <button type="button" className="small" onClick={() => setEditing({ ...editing, turns: (editing.turns + 1) % 4 })} aria-label="Rotate a quarter turn"><RotateCw size={14} aria-hidden /> {editing.turns ? `${editing.turns * 90}°` : 'Rotate'}</button>
      </div>
      <div className="inline" style={{ gap: 8 }}>
        <button type="button" onClick={() => setEditing(null)} disabled={busy}>Retake</button>
        <button type="button" className="primary" style={{ flex: 1 }} onClick={onKeep} disabled={busy}><Check size={16} aria-hidden /> Use this page</button>
      </div>
    </div>
  );
}
