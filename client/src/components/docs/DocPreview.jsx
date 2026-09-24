import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, StickyNote } from 'lucide-react';
import { getToken } from '../../api.js';
import { kindOf, kindLabel, fmtSize } from './filekinds.jsx';
import { decodeTiff } from './tiff.js';

const auth = () => ({ Authorization: `Bearer ${getToken()}` });
async function blobOf(id) {
  const res = await fetch(`/api/documents/${id}/file`, { headers: auth() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load the file');
  return res.blob();
}
export async function downloadDoc(doc) {
  const url = URL.createObjectURL(await blobOf(doc.id));
  Object.assign(document.createElement('a'), { href: url, download: doc.filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Audio and video stream with seeking through a short-lived link (the player can't send the sign-in header);
// until that route is available the whole file is fetched once instead.
async function mediaUrl(doc) {
  try {
    const res = await fetch(`/api/media/documents/${doc.id}/link`, { method: 'POST', headers: auth() });
    if (res.ok) return { url: (await res.json()).url, revoke: false };
  } catch { /* fall back below */ }
  return { url: URL.createObjectURL(await blobOf(doc.id)), revoke: true };
}

// Parses a CSV well enough to show it as a table (quoted fields, commas and newlines inside quotes).
export function parseCsv(text, maxRows = 500) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Shows any document the browser can show — pictures, PDFs, multi-page TIFF, HEIC (where the browser can),
// audio and video players, text, CSV as a table, Word/Excel as their text — and offers the download for the rest.
// Sticky-note pins: on pictures and TIFF pages they sit where they were put (x/y as fractions of the page).
export default function DocPreview({ doc, pins = [], pinMode = false, onPin, onPinClick, onPage, height = '68vh' }) {
  const kind = kindOf(doc);
  const [state, setState] = useState({ loading: true });
  const [page, setPage] = useState(1);
  const canvas = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let revoke = null;
    setState({ loading: true });
    setPage(1);
    (async () => {
      try {
        if (kind === 'audio' || kind === 'video') {
          const m = await mediaUrl(doc);
          if (m.revoke) revoke = m.url;
          if (!cancelled) setState({ url: m.url });
        } else if (kind === 'tiff') {
          const blob = await blobOf(doc.id);
          try {
            const pages = await decodeTiff(await blob.arrayBuffer());
            if (!cancelled) setState({ pages });
          } catch (e) {
            revoke = URL.createObjectURL(blob);
            if (!cancelled) setState({ url: revoke, unsupported: e.message });
          }
        } else if (kind === 'text' || kind === 'csv') {
          const text = await (await blobOf(doc.id)).text();
          if (!cancelled) setState({ text: doc.mime === 'application/rtf' ? null : text, rows: kind === 'csv' ? parseCsv(text) : null });
          if (doc.mime === 'application/rtf') {
            const res = await fetch(`/api/documents/${doc.id}/text`, { headers: auth() });
            if (!cancelled) setState({ text: res.ok ? (await res.json()).text : '' });
          }
        } else if (kind === 'office') {
          const res = await fetch(`/api/documents/${doc.id}/text`, { headers: auth() });
          const body = res.ok ? await res.json() : { text: '' };
          if (!cancelled) setState({ text: body.text || '', office: true });
        } else if (['image', 'pdf', 'heic'].includes(kind)) {
          revoke = URL.createObjectURL(await blobOf(doc.id));
          if (!cancelled) setState({ url: revoke });
        } else if (!cancelled) setState({});
      } catch (e) {
        if (!cancelled) setState({ error: e.message });
      }
    })();
    return () => { cancelled = true; if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 1000); };
  }, [doc.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // TIFF pages are drawn onto a canvas.
  useEffect(() => {
    const p = state.pages?.[page - 1];
    if (!p || !canvas.current) return;
    const c = canvas.current;
    c.width = p.width;
    c.height = p.height;
    c.getContext('2d').putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
  }, [state.pages, page]);

  useEffect(() => { onPage?.(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageCount = state.pages?.length || 1;
  const pagePins = useMemo(() => pins.filter((n) => n.x != null && (n.page || 1) === page), [pins, page]);
  const place = (e) => {
    if (!pinMode || !onPin) return;
    const box = e.currentTarget.getBoundingClientRect();
    onPin({ x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)), page });
  };
  const Pinned = PinLayer;
  const pinProps = { pinMode, pins: pagePins, onPlace: place, onPinClick };
  const fallback = (why) => (
    <div className="docp-empty">
      <p><strong>{doc.filename}</strong> · {kindLabel(doc)} · {fmtSize(doc.size)}</p>
      <p className="muted">{why || 'This kind of file can’t be shown here.'}</p>
      <button type="button" onClick={() => downloadDoc(doc)}><Download size={15} aria-hidden /> Download to open it</button>
    </div>
  );

  if (state.error) return <div className="docp" style={{ minHeight: 200 }}>{fallback(state.error)}</div>;
  if (state.loading) return <div className="docp docp-loading" style={{ height }}>Loading…</div>;
  return (
    <div className="docp" style={{ '--docp-h': height }}>
      {kind === 'image' && <Pinned {...pinProps}><img src={state.url} alt={doc.filename} className="docp-img" /></Pinned>}
      {kind === 'heic' && (
        // Safari shows iPhone photos (HEIC) as they are; other browsers get the download.
        <HeicImage url={state.url} doc={doc} fallback={fallback('This browser can’t show iPhone (HEIC) photos — download it, or open it on an iPhone, iPad or Mac.')} pinProps={pinProps} />
      )}
      {kind === 'pdf' && (
        <div className="docp-pdfwrap">
          <iframe src={`${state.url}#page=${page}`} key={page} title={doc.filename} className="docp-pdf" />
          {pinMode && <div className="docp-pdfhint">Notes on a PDF are kept with a page number — type the note in the panel.</div>}
        </div>
      )}
      {kind === 'tiff' && state.pages && <Pinned {...pinProps}><canvas ref={canvas} className="docp-img" aria-label={`${doc.filename}, page ${page} of ${pageCount}`} /></Pinned>}
      {kind === 'tiff' && state.unsupported && fallback(state.unsupported)}
      {kind === 'audio' && <div className="docp-media"><audio controls src={state.url} preload="metadata" aria-label={doc.filename} /></div>}
      {kind === 'video' && <div className="docp-media"><video controls src={state.url} preload="metadata" aria-label={doc.filename} playsInline /></div>}
      {kind === 'csv' && state.rows && (
        <div className="docp-table">
          <table>
            <tbody>{state.rows.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
          </table>
        </div>
      )}
      {(kind === 'text' || kind === 'office') && (state.text ? (
        <div className="docp-text">
          {state.office && <div className="docp-textnote muted">The words in this {kindLabel(doc)} file (formatting isn’t shown) — download it to open in {kindLabel(doc)}.</div>}
          <pre>{state.text}</pre>
        </div>
      ) : fallback(state.office ? `This ${kindLabel(doc)} file’s words are still being read — download it to open in ${kindLabel(doc)}.` : 'This file is empty.'))}
      {kind === 'file' && fallback()}
      {(kind === 'tiff' || kind === 'pdf') && (pageCount > 1 || kind === 'pdf') && (
        <div className="docp-pager">
          <button type="button" className="small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
          <span>Page {page}{kind === 'tiff' ? ` of ${pageCount}` : ''}</span>
          <button type="button" className="small" disabled={kind === 'tiff' && page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
        </div>
      )}
    </div>
  );
}

function HeicImage({ url, doc, fallback, pinProps }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return <PinLayer {...pinProps}><img src={url} alt={doc.filename} className="docp-img" onError={() => setFailed(true)} /></PinLayer>;
}

// The picture with its sticky notes on top; in "placing" mode a click puts a new one there.
function PinLayer({ pinMode, pins, onPlace, onPinClick, children }) {
  return (
    <div className={`docp-pinwrap${pinMode ? ' placing' : ''}`} onClick={onPlace} role={pinMode ? 'button' : undefined} aria-label={pinMode ? 'Click where the sticky note goes' : undefined}>
      {children}
      {pins.map((n, i) => (
        <button key={n.id} type="button" className={`docp-pin ${n.color || 'yellow'}`} style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }} title={`${n.author || ''}: ${n.body}`}
          onClick={(e) => { e.stopPropagation(); onPinClick?.(n); }} aria-label={`Sticky note ${i + 1}: ${n.body}`}>
          <StickyNote size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}
