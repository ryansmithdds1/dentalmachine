// The 3D viewer's front door — small, so it can sit in the main bundle. The viewers themselves (the
// CBCT viewer, and the scan viewer with three.js) are separate chunks, loaded only when one is opened.
//
//   import { Viewer3D, is3dDoc, zipFolder } from '../volume/index.jsx';
//   {is3dDoc(doc) && <Viewer3D documentId={doc.id} canEdit={canWrite} onClose={…} onSaved={reload} />}
import { lazy, Suspense, useEffect, useState } from 'react';
import { getJson } from './net.js';

const VolumeViewer = lazy(() => import('./VolumeViewer.jsx'));
const MeshViewer = lazy(() => import('./MeshViewer.jsx'));

// Documents that open in 3D: a zip (a CBCT series or scans) or a scan file. ASCII scans uploaded before
// scan types existed are stored as text with their .stl/.obj/.ply name. A multi-frame DICOM CBCT also
// works (<Viewer3D> on it), but single DICOM x-rays belong in the image viewer, so offer that by choice.
export function is3dDoc(doc) {
  if (!doc) return false;
  return doc.mime === 'application/zip' || /^model\//.test(doc.mime || '') || (doc.mime === 'text/plain' && /\.(stl|ply|obj)$/i.test(doc.filename || ''));
}

// Asks the server what the document is, then opens the matching viewer.
export function Viewer3D({ documentId, height = '78vh', ...props }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setError(null);
    getJson(`/documents/${documentId}/view3d`).then((i) => live && setInfo(i), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [documentId]);
  // Styled inline: the viewer's stylesheet arrives with its chunk.
  const box = { height, display: 'grid', placeItems: 'center', background: '#0a0f17', color: '#cbd5e1', borderRadius: 12, padding: 16, textAlign: 'center' };
  const wait = <div style={box}>Opening the 3D viewer…</div>;
  if (error) return <div style={{ ...box, color: '#fdba74' }} role="alert">{error}</div>;
  if (!info) return wait;
  const Viewer = info.kind === 'mesh' ? MeshViewer : VolumeViewer;
  return (
    <Suspense fallback={wait}>
      <Viewer documentId={documentId} info={info} height={height} {...props} />
    </Suspense>
  );
}

// ---- A folder of DICOM files (from <input type="file" webkitdirectory>) → one zip to upload ----
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// files: File[] → Blob (application/zip). Hidden files are skipped; paths inside the folder are kept.
export async function zipFolder(files, onProgress) {
  const parts = [];
  const central = [];
  let offset = 0;
  const list = [...files].filter((f) => !f.name.startsWith('.'));
  for (let n = 0; n < list.length; n++) {
    const f = list[n];
    const raw = new Uint8Array(await f.arrayBuffer());
    const packed = await deflate(raw);
    const [method, body] = packed && packed.length < raw.length ? [8, packed] : [0, raw];
    const name = new TextEncoder().encode(f.webkitRelativePath || f.name);
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, method, true);
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, raw.length, true); local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true); head.setUint16(8, 0x0800, true); head.setUint16(10, method, true);
    head.setUint32(16, crc, true); head.setUint32(20, body.length, true); head.setUint32(24, raw.length, true); head.setUint16(28, name.length, true); head.setUint32(42, offset, true);
    parts.push(local.buffer, name, body);
    central.push(head.buffer, name);
    offset += 30 + name.length + body.length;
    onProgress?.(n + 1, list.length);
  }
  const size = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, list.length, true); end.setUint16(10, list.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
