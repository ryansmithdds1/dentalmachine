// CBCT volumes and 3D scans (intraoral / model scans) for the 3D viewer.
//
// A CBCT arrives as a DICOM series: hundreds of single-slice .dcm files, usually in a .zip (or one
// multi-frame DICOM file). It is stored as ONE document (the zip, encrypted like every other file) and
// described by a small manifest worked out at upload: size, voxel spacing in mm, and the slice order.
// The viewer gets the decoded volume as one binary blob (see encodeVolume) instead of hundreds of files.
//
// Scans (.stl, .ply, .obj — one file, or an upper/lower pair in a zip) are served as they are; the
// browser parses them. Nothing here changes a stored file: everything is read-only and derived.
import { inflateRawSync, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { parseDicom } from './dicomimage.js';
import { HttpError } from './auth.js';

const gzipAsync = promisify(gzip);

// Limits: a big dental CBCT is ~ 800 slices of 800×800 16-bit (~1 GB uncompressed). Anything past these
// is refused rather than risk running the server out of memory (a zip bomb would otherwise do the same).
export const LIMITS = {
  zipEntries: 5000,
  entryBytes: 128 * 1024 * 1024, // one file inside the zip
  zipTotalBytes: 1536 * 1024 * 1024, // everything in the zip, uncompressed
  sourceVoxels: 1024 * 1024 * 1024, // the volume as scanned
  outputVoxels: 640 * 640 * 640, // what is sent to a browser (downsampled to fit)
  meshBytes: 256 * 1024 * 1024,
};

// ---------------------------------------------------------------------------------------------
// ZIP reading (central directory; stored or deflated entries). Entries are inflated one at a time,
// only when read, so a series is never held uncompressed twice.
// ---------------------------------------------------------------------------------------------
export const isZip = (buf) => buf?.length > 22 && buf.readUInt32LE(0) === 0x04034b50;

export function readZip(buf) {
  if (!isZip(buf)) throw new HttpError(415, 'Not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(415, 'This zip file is damaged (no directory at the end)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new HttpError(415, 'Zip64 archives aren’t supported — zip the series with a standard zip tool');
  if (count > LIMITS.zipEntries) throw new HttpError(413, `That zip has more than ${LIMITS.zipEntries} files`);
  const entries = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(415, 'This zip file is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // Folders, macOS resource forks and hidden files are not part of the series.
    const base = name.split('/').pop();
    if (!base || name.startsWith('__MACOSX/') || base.startsWith('.')) continue;
    if (flags & 1) throw new HttpError(415, 'That zip is password-protected — export it without a password');
    if (![0, 8].includes(method)) throw new HttpError(415, `That zip uses a compression method (${method}) that isn’t supported`);
    if (size > LIMITS.entryBytes) throw new HttpError(413, `${base} is too large`);
    total += size;
    if (total > LIMITS.zipTotalBytes) throw new HttpError(413, 'That zip is too large once unpacked');
    entries.push({
      name, base, size,
      read() {
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new HttpError(415, 'This zip file is damaged');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const body = buf.subarray(start, start + packed);
        if (method === 0) return body;
        // maxOutputLength: the size in the directory is a claim; never inflate past it.
        try {
          const out = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
          if (out.length !== size) throw new Error('size mismatch');
          return out;
        } catch {
          throw new HttpError(415, `${base} in the zip is damaged or larger than it says`);
        }
      },
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// DICOM geometry. dicomimage.js's parseDicom reads what's needed to show one image (size, bit depth,
// rescale, pixels); a volume also needs where each slice sits. This walker reads those tags, looking
// inside sequences too (enhanced multi-frame CT keeps spacing and per-frame positions in functional-
// group sequences).
// ---------------------------------------------------------------------------------------------
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const KNOWN_SQ = new Set(['52009229', '52009230', '00209113', '00289110', '00289145', '00209116']);
const GEOMETRY = {
  '0020000e': 'seriesUid', '00200013': 'instance', '00200037': 'orientation', '00180050': 'thickness',
  '00180088': 'between', '00280008': 'frames', '00280030': 'pixelSpacing', '00281052': 'intercept', '00281053': 'slope',
  '00281050': 'windowCenter', '00281051': 'windowWidth', '00100020': 'patientId', '00080060': 'modality', '00080020': 'studyDate',
};
const UNDEFINED = 0xffffffff;

export function readGeometry(buf) {
  if (!(buf.length > 132 && buf.toString('latin1', 128, 132) === 'DICM')) return null;
  const out = { framePositions: [] };
  let explicit = true;
  const text = (s, l) => buf.toString('latin1', s, s + l).replace(/\0/g, '').trim();

  // Returns the position after the dataset (at `end`, or just past an item delimiter).
  const elements = (pos, end, depth) => {
    while (pos + 8 <= end) {
      const group = buf.readUInt16LE(pos);
      const element = buf.readUInt16LE(pos + 2);
      if (group === 0xfffe) return pos + 8; // item / sequence delimiter ends this dataset
      const useExplicit = group === 0x0002 || explicit;
      let vr = null;
      let len;
      let header = 8;
      if (useExplicit) {
        vr = buf.toString('latin1', pos + 4, pos + 6);
        if (LONG_VR.has(vr)) { len = buf.readUInt32LE(pos + 8); header = 12; } else len = buf.readUInt16LE(pos + 6);
      } else len = buf.readUInt32LE(pos + 4);
      const tag = group.toString(16).padStart(4, '0') + element.toString(16).padStart(4, '0');
      const start = pos + header;
      if (tag === '7fe00010') { out.stop = true; return end; }
      if (vr === 'SQ' || KNOWN_SQ.has(tag) || len === UNDEFINED) {
        // A real file nests a few levels; a crafted one could nest until the stack runs out.
        if (depth >= 12) throw new HttpError(415, 'This DICOM file is malformed (sequences nested too deep)');
        pos = sequence(start, len, depth + 1);
        continue;
      }
      if (start + len > buf.length) return end;
      const value = text(start, len);
      if (tag === '00020010') explicit = value !== '1.2.840.10008.1.2';
      if (tag === '00200032') {
        const v = value.split('\\').map(Number);
        if (v.length === 3 && v.every(Number.isFinite)) {
          if (depth === 0) out.position = v;
          else out.framePositions.push(v);
        }
      } else if (GEOMETRY[tag] && out[GEOMETRY[tag]] === undefined) out[GEOMETRY[tag]] = value;
      pos = start + len;
    }
    return pos;
  };
  const sequence = (pos, len, depth) => {
    const end = len === UNDEFINED ? buf.length : Math.min(buf.length, pos + len);
    while (pos + 8 <= end) {
      const element = buf.readUInt16LE(pos + 2);
      const ilen = buf.readUInt32LE(pos + 4);
      pos += 8;
      if (element === 0xe0dd) return pos; // sequence delimiter
      if (element !== 0xe000) return end;
      if (ilen === UNDEFINED) pos = elements(pos, end, depth);
      else { elements(pos, Math.min(end, pos + ilen), depth); pos += ilen; }
      if (out.stop) return end;
    }
    return end;
  };
  elements(132, buf.length, 0);
  delete out.stop;

  const nums = (s) => (s ? s.split('\\').map(Number).filter(Number.isFinite) : null);
  return {
    seriesUid: out.seriesUid || '',
    instance: out.instance ? Number(out.instance) : null,
    position: out.position || null,
    framePositions: out.framePositions,
    orientation: nums(out.orientation)?.length === 6 ? nums(out.orientation) : null,
    thickness: Number(out.thickness) > 0 ? Number(out.thickness) : null,
    between: Number(out.between) > 0 ? Number(out.between) : null,
    frames: Number(out.frames) > 1 ? Math.floor(Number(out.frames)) : 1,
    pixelSpacing: nums(out.pixelSpacing)?.filter((x) => x > 0) || null,
    slope: out.slope !== undefined && Number.isFinite(Number(out.slope)) && Number(out.slope) !== 0 ? Number(out.slope) : null,
    intercept: out.intercept !== undefined && Number.isFinite(Number(out.intercept)) ? Number(out.intercept) : null,
    windowCenter: nums(out.windowCenter)?.[0] ?? null,
    windowWidth: nums(out.windowWidth)?.[0] ?? null,
    patientId: out.patientId || null,
    modality: out.modality || null,
    studyDate: out.studyDate || null,
  };
}

const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// Reads one DICOM file enough to place it in a volume. → null when it isn't an image slice.
function sliceInfo(name, data) {
  const d = parseDicom(data);
  if (!d || !d.rows || !d.columns) return null; // DICOMDIR, reports, etc.
  const g = readGeometry(data);
  return { name, d, g };
}

// Works out the volume from the files of a series (the entries of a zip, or one multi-frame DICOM).
// files: [{ name, read() → Buffer }]. → the manifest (small JSON, stored with the document).
export function analyzeSeries(files) {
  const slices = [];
  let skipped = 0;
  for (const f of files) {
    const s = sliceInfo(f.name, f.read());
    if (s) slices.push(s); else skipped++;
  }
  if (!slices.length) throw new HttpError(415, 'No DICOM images were found — a CBCT should be the folder of .dcm files its software exports');
  const warnings = [];
  // A zip can hold more than one series (a scout, a second scan): use the largest, say so.
  const bySeries = new Map();
  for (const s of slices) {
    const key = `${s.g.seriesUid}|${s.d.rows}x${s.d.columns}`;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(s);
  }
  const series = [...bySeries.values()].sort((a, b) => b.length * b[0].g.frames - a.length * a[0].g.frames)[0];
  if (bySeries.size > 1) warnings.push(`The file holds ${bySeries.size} image series; showing the largest (${series.length} files).`);
  if (skipped) warnings.push(`${skipped} file${skipped === 1 ? '' : 's'} in the upload ${skipped === 1 ? 'isn’t an image' : 'aren’t images'} and ${skipped === 1 ? 'was' : 'were'} left out.`);

  const first = series[0];
  // Patient identity: every slice must belong to the same person.
  const ids = new Set(series.map((s) => s.g.patientId).filter(Boolean));
  if (ids.size > 1) throw new HttpError(422, 'These slices come from more than one patient — check the export before uploading');
  if (!UNCOMPRESSED.has(first.d.transfer)) {
    throw new HttpError(415, 'This CBCT is compressed (JPEG / JPEG 2000) inside the DICOM files. Export it uncompressed from the CBCT software to view it here.');
  }
  if (first.d.samples !== 1 || ![8, 16].includes(first.d.bitsAllocated)) throw new HttpError(415, 'Only grayscale 8- or 16-bit CBCT images can be shown');

  const nx = first.d.columns;
  const ny = first.d.rows;
  const orientation = first.g.orientation || [1, 0, 0, 0, 1, 0];
  let normal = cross(orientation.slice(0, 3), orientation.slice(3, 6));
  if (!(Math.hypot(...normal) > 0.5)) normal = [0, 0, 1];
  const ps = first.g.pixelSpacing || first.d.pixelSpacing;
  // DICOM Pixel Spacing is "row spacing \ column spacing": y first, then x.
  const sy = ps?.[0] || null;
  const sx = ps?.[1] || ps?.[0] || null;
  if (!sx) warnings.push('The files don’t say the pixel size; measurements assume 1 mm per pixel and are NOT reliable.');

  let order;
  let sz = null;
  if (series.length === 1 && first.g.frames > 1) {
    // One multi-frame file: frames in stored order unless per-frame positions say otherwise.
    const frames = first.g.frames;
    const pos = first.g.framePositions.length === frames ? first.g.framePositions : null;
    order = Array.from({ length: frames }, (_, i) => ({ name: first.name, frame: i, z: pos ? dot(pos[i], normal) : i }));
    if (pos) {
      order.sort((a, b) => a.z - b.z);
      sz = median(order.slice(1).map((o, i) => o.z - order[i].z));
    }
  } else {
    const placed = series.every((s) => s.g.position);
    order = series.map((s) => ({ name: s.name, frame: 0, z: placed ? dot(s.g.position, normal) : null, instance: s.g.instance }));
    if (placed) order.sort((a, b) => a.z - b.z || (a.instance ?? 0) - (b.instance ?? 0));
    else {
      warnings.push('The slices have no position in their headers; ordered by instance number.');
      order.sort((a, b) => (a.instance ?? 0) - (b.instance ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    // The same position twice (a duplicated file) would stretch the volume: keep one.
    if (placed) {
      const before = order.length;
      order = order.filter((o, i) => i === 0 || Math.abs(o.z - order[i - 1].z) > 1e-4);
      if (order.length < before) warnings.push(`${before - order.length} duplicate slice${before - order.length === 1 ? '' : 's'} left out.`);
      const gaps = order.slice(1).map((o, i) => o.z - order[i].z);
      sz = median(gaps);
      if (sz && gaps.some((gap) => Math.abs(gap - sz) > sz * 0.1)) warnings.push('The slices are not evenly spaced (a slice may be missing); distances across slices are approximate.');
    }
  }
  if (!(sz > 0)) {
    sz = first.g.between || first.g.thickness || null;
    if (!sz) {
      sz = sx || 1;
      if (order.length > 1) warnings.push('The slice spacing isn’t recorded; assumed equal to the pixel size.');
    }
  }
  const nz = order.length;
  if (nx * ny * nz > LIMITS.sourceVoxels) throw new HttpError(413, 'That CBCT is larger than the viewer can open');
  const rescaled = first.g.slope != null || first.g.intercept != null;
  return {
    version: 1,
    kind: 'cbct',
    dims: [nx, ny, nz],
    spacing: [round(sx || 1), round(sy || sx || 1), round(sz)],
    orientation,
    bits: first.d.bitsAllocated,
    signed: first.d.signed,
    units: rescaled && /^(CT)$/i.test(first.g.modality || 'CT') ? 'HU' : 'raw',
    window: first.g.windowWidth > 1 && first.g.windowCenter != null ? { center: first.g.windowCenter, width: first.g.windowWidth } : null,
    modality: first.g.modality || null,
    studyDate: first.g.studyDate || null,
    patientId: first.g.patientId || null,
    slices: order.map((o) => (o.frame ? { name: o.name, frame: o.frame, z: o.z == null ? null : round(o.z, 3) } : { name: o.name, z: o.z == null ? null : round(o.z, 3) })),
    warnings,
  };
}

// The files of a stored document, as the series reader wants them.
export function seriesFiles(data) {
  if (isZip(data)) return readZip(data).filter((e) => !/\.(txt|xml|html?|pdf|jpe?g|png|ini|exe|dll|json|stl|ply|obj)$/i.test(e.base));
  return [{ name: 'image.dcm', read: () => data }];
}

// ---------------------------------------------------------------------------------------------
// Decoding: slices → one Int16 volume (x fastest, then y, then z in manifest order), rescaled to real
// units (HU for CT), box-averaged down when larger than a browser should hold.
// ---------------------------------------------------------------------------------------------
export async function decodeVolume(data, manifest, { max = 512 } = {}) {
  const [nx, ny, nz] = manifest.dims;
  const largest = Math.max(nx, ny, nz);
  let step = Math.max(1, Math.ceil(largest / max));
  while (Math.floor(nx / step) * Math.floor(ny / step) * Math.max(1, Math.floor(nz / step)) > LIMITS.outputVoxels) step++;
  const ox = Math.max(1, Math.floor(nx / step));
  const oy = Math.max(1, Math.floor(ny / step));
  const oz = Math.max(1, Math.floor(nz / step));
  const out = new Int16Array(ox * oy * oz);
  const files = new Map(seriesFiles(data).map((f) => [f.name, f]));
  const acc = new Float32Array(ox * oy);
  const cnt = new Uint16Array(ox * oy);
  const xIndex = Int32Array.from({ length: ox * step }, (_, x) => Math.floor(x / step));
  let lo = Infinity;
  let hi = -Infinity;
  let parsed = null;
  let parsedName = null;
  for (let k = 0; k < nz; k++) {
    const kz = Math.floor(k / step);
    if (kz >= oz) break;
    const s = manifest.slices[k];
    if (parsedName !== s.name) {
      const f = files.get(s.name);
      if (!f) throw new HttpError(422, 'A slice listed for this CBCT is missing from the stored file');
      const buf = f.read();
      parsed = { d: parseDicom(buf), g: readGeometry(buf) };
      parsedName = s.name;
    }
    const { d, g } = parsed;
    if (d.rows !== ny || d.columns !== nx) throw new HttpError(422, 'The CBCT slices are not all the same size');
    const bytes = d.bitsAllocated / 8;
    const frameBytes = nx * ny * bytes;
    const px = d.pixelData;
    const base = (s.frame || 0) * frameBytes;
    if (!px || px.length < base + frameBytes) throw new HttpError(422, 'A CBCT slice is shorter than its header says');
    const slope = g.slope ?? 1;
    const intercept = g.intercept ?? 0;
    const mask = bytes === 2 && !d.signed && d.bitsStored && d.bitsStored < 16 ? (1 << d.bitsStored) - 1 : 0xffff;
    // A typed view of this frame (copied when the pixels don't start on an even byte).
    let frame;
    if (bytes === 1) frame = px.subarray(base, base + frameBytes);
    else {
      const T = d.signed ? Int16Array : Uint16Array;
      const at = px.byteOffset + base;
      frame = at % 2 === 0 ? new T(px.buffer, at, nx * ny) : new T(Uint8Array.from(px.subarray(base, base + frameBytes)).buffer);
    }
    const signedOrMasked = bytes === 2 && !d.signed && mask !== 0xffff;
    for (let y = 0; y < oy * step; y++) {
      const row = Math.floor(y / step) * ox;
      const src = y * nx;
      for (let x = 0; x < ox * step; x++) {
        const v = signedOrMasked ? frame[src + x] & mask : frame[src + x];
        const i = row + xIndex[x];
        acc[i] += v * slope + intercept;
        cnt[i]++;
      }
    }
    if ((k + 1) % step === 0 || k === nz - 1) {
      const plane = kz * ox * oy;
      for (let i = 0; i < acc.length; i++) {
        const v = cnt[i] ? Math.max(-32768, Math.min(32767, Math.round(acc[i] / cnt[i]))) : 0;
        out[plane + i] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      acc.fill(0);
      cnt.fill(0);
      // Let other requests in between slabs: a big volume takes a second or two to decode.
      if (kz % 16 === 15) await new Promise((r) => setImmediate(r));
    }
  }
  const stats = volumeStats(out, lo, hi);
  return {
    header: {
      format: 'dm-volume', version: 1, dtype: 'int16', byteOrder: 'LE',
      dims: [ox, oy, oz], spacing: manifest.spacing.map((s) => round(s * step)), step, sourceDims: manifest.dims,
      units: manifest.units, orientation: manifest.orientation, modality: manifest.modality,
      window: manifest.window || stats.window, stats, warnings: manifest.warnings || [],
    },
    data: out,
  };
}

// Percentiles from a histogram, for automatic window/level and the presets on non-HU scanners.
function volumeStats(data, lo, hi) {
  if (!Number.isFinite(lo)) return { min: 0, max: 0, p1: 0, p50: 0, p99: 0, p999: 0, window: { center: 0, width: 1 } };
  const bins = 4096;
  const span = hi - lo || 1;
  const hist = new Uint32Array(bins);
  const stride = Math.max(1, Math.floor(data.length / 4_000_000));
  let n = 0;
  for (let i = 0; i < data.length; i += stride) { hist[Math.min(bins - 1, Math.floor(((data[i] - lo) / span) * bins))]++; n++; }
  const pct = (q) => {
    let seen = 0;
    const want = q * n;
    for (let b = 0; b < bins; b++) { seen += hist[b]; if (seen >= want) return Math.round(lo + ((b + 0.5) / bins) * span); }
    return hi;
  };
  const p1 = pct(0.01);
  const p99 = pct(0.99);
  const p999 = pct(0.999);
  return { min: lo, max: hi, p1, p50: pct(0.5), p99, p999, window: { center: Math.round((p1 + p999) / 2), width: Math.max(1, p999 - p1) } };
}

// Binary form sent to the viewer:
//   bytes 0-7  "DMVOL1\0\0"
//   bytes 8-11 uint32 LE: offset of the voxel data (a multiple of 8)
//   bytes 12…  JSON header (UTF-8), space-padded
//   offset…    Int16 LE voxels, x fastest, then y, then z
export function encodeVolume({ header, data }) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const offset = Math.ceil((12 + json.length) / 8) * 8;
  const head = Buffer.alloc(offset, 0x20);
  head.write('DMVOL1\0\0', 0, 'latin1');
  head.writeUInt32LE(offset, 8);
  json.copy(head, 12);
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) body.swap16(); // big-endian host: send little-endian
  return Buffer.concat([head, body]);
}

export function decodeVolumeBuffer(buf) {
  if (buf.toString('latin1', 0, 6) !== 'DMVOL1') throw new Error('Not a volume');
  const offset = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 12, offset).trim());
  const copy = Buffer.from(buf.subarray(offset));
  return { header, data: new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2) };
}

export const compress = (buf) => gzipAsync(buf, { level: 1 });

// ---------------------------------------------------------------------------------------------
// Meshes (intraoral / model scans)
// ---------------------------------------------------------------------------------------------
const MESH_EXT = /\.(stl|ply|obj)$/i;

// → 'stl' | 'ply' | 'obj' | null, from the bytes (the name only breaks ties for OBJ, which has no signature).
export function meshFormat(buf, filename = '') {
  if (!buf || buf.length < 15) return null;
  const head = buf.toString('latin1', 0, Math.min(buf.length, 512));
  if (/^ply\r?\nformat /.test(head)) return 'ply';
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length === 84 + n * 50) return 'stl'; // binary STL: exact size check
  }
  if (/^\s*solid\b/.test(head) && /\bfacet\b/.test(buf.toString('latin1', 0, Math.min(buf.length, 4096)))) return 'stl';
  if (/\.obj$/i.test(filename) && /^(v|vn|vt|f|o|g|#|mtllib|usemtl|s)\s/m.test(head) && !buf.subarray(0, 4096).includes(0)) return 'obj';
  return null;
}

// Which jaw a scan file is, from its name (scanner exports say "UpperJaw", "Maxillary", "LowerJaw"…).
export function jawOf(name) {
  if (/upper|maxill|oberkiefer|\bup\b|\bmax\b|_u\b|-u\b/i.test(name)) return 'upper';
  if (/lower|mandib|unterkiefer|\blow\b|\bmand\b|_l\b|-l\b/i.test(name)) return 'lower';
  if (/bite|occlus|buccal/i.test(name)) return 'bite';
  return null;
}

// The meshes in a stored document: the file itself, or the .stl/.ply/.obj files in a zip.
export function meshParts(data, filename = '') {
  if (isZip(data)) {
    const parts = [];
    for (const e of readZip(data)) {
      if (!MESH_EXT.test(e.base)) continue;
      if (e.size > LIMITS.meshBytes) throw new HttpError(413, `${e.base} is too large to view`);
      const body = e.read();
      const format = meshFormat(body, e.base);
      if (format) parts.push({ index: parts.length, name: e.base, format, size: body.length, jaw: jawOf(e.base), read: () => body });
    }
    return parts;
  }
  const format = meshFormat(data, filename);
  if (!format) return [];
  if (data.length > LIMITS.meshBytes) throw new HttpError(413, 'That scan is too large to view');
  return [{ index: 0, name: filename || `scan.${format}`, format, size: data.length, jaw: jawOf(filename), read: () => data }];
}

// ---------------------------------------------------------------------------------------------
// For the upload route (documents.js): what a zip or scan file is.
// ---------------------------------------------------------------------------------------------
export const MESH_MIME = { stl: 'model/stl', ply: 'model/ply', obj: 'model/obj' };

// A MIME type for files sniffMime doesn't know: zips and 3D scans. → string | null.
export function sniffScanMime(buf, filename = '') {
  if (isZip(buf)) return 'application/zip';
  const f = meshFormat(buf, filename);
  return f ? MESH_MIME[f] : null;
}

// What an uploaded zip or scan file is. → null (not ours), or { kind: 'volume', category: 'xray', manifest }
// or { kind: 'mesh', category: 'photo', parts }. A zip that is neither throws 415, so a zip can't be used
// to put arbitrary files in the chart. (The documents table only allows its existing categories, so a
// CBCT is filed as an x-ray and a scan as a photo; the mime type says which viewer opens it.)
export function inspectUpload(buf, filename = '') {
  if (isZip(buf)) {
    const entries = readZip(buf);
    if (entries.some((e) => MESH_EXT.test(e.base))) {
      const parts = meshParts(buf, filename);
      if (parts.length) return { kind: 'mesh', category: 'photo', parts: parts.map(({ read: _r, ...p }) => p) };
    }
    return { kind: 'volume', category: 'xray', manifest: analyzeSeries(seriesFiles(buf)) };
  }
  const format = meshFormat(buf, filename);
  if (format) return { kind: 'mesh', category: 'photo', parts: [{ index: 0, name: filename, format, size: buf.length, jaw: jawOf(filename) }] };
  return null;
}

// Documents the 3D routes may open. Which viewer (volume or mesh) is settled from the contents (view3d).
export function isVolumeDoc(doc) {
  return doc.mime === 'application/zip' || doc.mime === 'application/dicom';
}
export function isMeshDoc(doc) {
  return /^model\/(stl|ply|obj)$/.test(doc.mime) || doc.mime === 'application/zip' || (doc.mime === 'text/plain' && MESH_EXT.test(doc.filename || ''));
}
