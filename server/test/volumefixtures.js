// Synthetic CBCT series and scan meshes for the 3D viewer's tests and its screenshot harness.
// (Not a test file itself: the runner only picks up *.test.js.)
import { buildDicom } from '../src/dicom.js';
import { zip } from '../src/recordexport.js';

// Explicit VR little endian element (what buildDicom writes).
function el(group, element, vr, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value).length % 2 ? `${value} ` : String(value), 'latin1');
  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const head = Buffer.alloc(long ? 12 : 8);
  head.writeUInt16LE(group, 0);
  head.writeUInt16LE(element, 2);
  head.write(vr, 4, 'latin1');
  if (long) head.writeUInt32LE(data.length, 8); else head.writeUInt16LE(data.length, 6);
  return Buffer.concat([head, data]);
}
const ds = (list) => list.map((n) => String(Math.round(n * 1e4) / 1e4)).join('\\');

// buildDicom plus the geometry tags a CBCT slice carries, placed before the pixel data.
export function withTags(buf, elements) {
  const at = buf.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57]), 132);
  return Buffer.concat([buf.subarray(0, at), ...elements, buf.subarray(at)]);
}

// A bright sphere (HU 1000) in air (HU -1000), 32×32×24 by default. Pixel (0,0) of slice k holds 10·k HU
// so tests can check the slices came back in position order.
export const sphere = (nx, ny, nz) => (x, y, z) => {
  if (x === 0 && y === 0) return z * 10;
  const r = Math.min(nx, ny, nz) / 3;
  return Math.hypot(x - nx / 2, y - ny / 2, z - nz / 2) < r ? 1000 : -1000;
};

// A small dental phantom for screenshots: a lower jaw (cortical shell, cancellous inside) holding a row of
// teeth along a U-shaped arch — enamel crowns over dentin, tapering roots with a pulp canal — in soft
// tissue. Units are HU; distances in voxels.
export const phantom = (nx, ny, nz) => {
  const cx = nx / 2;
  const y0 = ny * 0.2;
  const half = nx * 0.36;
  const k = (ny * 0.55) / (half * half);
  const arc = (x) => (x * Math.sqrt(1 + 4 * k * k * x * x)) / 2 + Math.asinh(2 * k * x) / (4 * k);
  const total = 2 * arc(half);
  const teeth = 12;
  const pitch = total / teeth;
  return (x, y, z) => {
    const xr = x - cx;
    const across = (y - y0 - k * xr * xr) / Math.sqrt(1 + 4 * k * k * xr * xr); // distance from the arch
    const s = arc(xr) + total / 2; // position along it
    const h = z / nz;
    let hu = -1000;
    if ((xr / (nx * 0.48)) ** 2 + ((y - ny * 0.5) / (ny * 0.5)) ** 2 + ((h - 0.45) / 0.55) ** 2 < 1) hu = 30;
    if (s < 0 || s > total || Math.abs(across) > 16) return hu;
    const n = Math.floor(s / pitch);
    const along = s - (n + 0.5) * pitch;
    // Crown: an ellipsoid, enamel on the outside.
    const cr = (along / (pitch * 0.47)) ** 2 + (across / 8.5) ** 2 + ((h - 0.62) / 0.085) ** 2;
    if (cr < 1 && h > 0.55) return cr > 0.5 ? 2600 : 1600;
    // Root: tapering toward the apex, with a canal.
    if (h > 0.26 && h <= 0.58) {
      const t = (h - 0.26) / 0.32;
      const r = 1.8 + t * (pitch * 0.32 - 1.8);
      const e = (along / r) ** 2 + (across / (r * 1.25)) ** 2;
      if (e < 0.06) return 180;
      if (e < 1) return 1600;
      if (e < 1.35) return -200; // periodontal ligament space
    }
    // Jaw bone around the roots.
    if (h > 0.1 && h < 0.555 && Math.abs(across) < 14) return Math.abs(across) > 11 || h < 0.14 ? 1050 : 420;
    return hu;
  };
};

// One DICOM file per slice. Shuffled, with instance numbers deliberately backwards, so only the
// ImagePositionPatient tag gives the true order.
export function makeSeries({ nx = 32, ny = 32, nz = 24, spacing = [0.25, 0.3, 0.5], origin = [-4, -5, -10], density = sphere(nx, ny, nz), patientId = 'PT-1', seriesUid = '1.2.826.0.1.3680043.2.1.1', shuffle = true, positions = true } = {}) {
  const files = [];
  for (let z = 0; z < nz; z++) {
    const pixels = Buffer.alloc(nx * ny * 2);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) pixels.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(density(x, y, z) + 1000))), (y * nx + x) * 2);
    const base = buildDicom({ patientId, modality: 'CT', pixels, image: { rows: ny, columns: nx, bits: 16 } });
    const data = withTags(base, [
      el(0x0018, 0x0050, 'DS', ds([spacing[2]])),
      el(0x0020, 0x000e, 'UI', seriesUid),
      el(0x0020, 0x0013, 'IS', String(nz - z)),
      ...(positions ? [el(0x0020, 0x0032, 'DS', ds([origin[0], origin[1], origin[2] + z * spacing[2]]))] : []),
      el(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
      el(0x0028, 0x0030, 'DS', ds([spacing[1], spacing[0]])), // row spacing (y) \ column spacing (x)
      el(0x0028, 0x1052, 'DS', '-1000'),
      el(0x0028, 0x1053, 'DS', '1'),
    ]);
    files.push({ name: `CT/IMG${String(z * 7 % nz).padStart(4, '0')}_${z}.dcm`, data, z });
  }
  if (shuffle) files.sort((a, b) => ((a.z * 13) % nz) - ((b.z * 13) % nz));
  return files;
}

export const zipSeries = (files) => zip(files.map((f) => ({ name: f.name, data: f.data })));

// One multi-frame DICOM (how some CBCT software exports): frames stacked, spacing between slices given.
export function makeMultiframe({ nx = 16, ny = 16, nz = 6, spacing = 0.4 } = {}) {
  const pixels = Buffer.alloc(nx * ny * nz * 2);
  for (let z = 0; z < nz; z++) for (let i = 0; i < nx * ny; i++) pixels.writeUInt16LE(1000 + z * 100, (z * nx * ny + i) * 2);
  const base = buildDicom({ patientId: 'PT-1', modality: 'CT', pixels, image: { rows: ny, columns: nx, bits: 16 } });
  return withTags(base, [
    el(0x0018, 0x0088, 'DS', ds([spacing])),
    el(0x0028, 0x0008, 'IS', String(nz)),
    el(0x0028, 0x0030, 'DS', ds([spacing, spacing])),
    el(0x0028, 0x1052, 'DS', '-1000'),
    el(0x0028, 0x1053, 'DS', '1'),
  ]);
}

// ---- Meshes ----
export function binaryStl(triangles) {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write('synthetic scan', 0, 'latin1');
  buf.writeUInt32LE(triangles.length, 80);
  triangles.forEach((t, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n.forEach((x, k) => buf.writeFloatLE(x / len, o + k * 4));
    [a, b, c].forEach((p, j) => p.forEach((x, k) => buf.writeFloatLE(x, o + 12 + j * 12 + k * 4)));
  });
  return buf;
}

// A tetrahedron with 10 mm edges along the axes (tests: known distances).
export const tetraStl = () => binaryStl([
  [[0, 0, 0], [0, 10, 0], [10, 0, 0]], [[0, 0, 0], [10, 0, 0], [0, 0, 10]], [[0, 0, 0], [0, 0, 10], [0, 10, 0]], [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
]);

// A dental arch for screenshots: 14 rounded teeth on a U-shaped gum, in mm. upper=true flips it to face down.
export function archStl({ upper = false } = {}) {
  const tris = [];
  const blob = (cx, cy, cz, rx, ry, rz, bumps) => {
    const S = 18;
    const T = 12;
    const P = (i, j) => {
      const th = (i / S) * Math.PI * 2;
      const ph = (j / T) * Math.PI;
      let r = 1;
      if (bumps && Math.cos(ph) > 0.2) r += 0.08 * Math.cos(th * 2) * Math.cos(ph); // cusps on the biting surface
      return [cx + rx * r * Math.sin(ph) * Math.cos(th), cy + ry * r * Math.sin(ph) * Math.sin(th), cz + rz * Math.cos(ph)];
    };
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < T; j++) {
        const a = P(i, j); const b = P(i + 1, j); const c = P(i + 1, j + 1); const d = P(i, j + 1);
        tris.push([a, b, c], [a, c, d]);
      }
    }
  };
  const arch = (t) => [t * 24, 30 - 30 * t * t * 0.9]; // x, y (mm)
  for (let i = 0; i < 14; i++) {
    const t = -1 + (i + 0.5) * (2 / 14);
    const [x, y] = arch(t);
    const molar = Math.abs(t) > 0.55;
    const w = molar ? 4.8 : Math.abs(t) > 0.3 ? 3.6 : 3.2;
    blob(x, y, 5, w, molar ? 5 : 3.2, 4.5, true);
  }
  for (let i = 0; i < 40; i++) { // gum: overlapping flattened blobs along the arch
    const t = -1.08 + (i + 0.5) * (2.16 / 40);
    const [x, y] = arch(t);
    blob(x, y, 0.5, 5.5, 6.5, 3.5, false);
  }
  // Upper jaw: mirrored up and over the lower (winding swapped so the outside stays outside).
  const flip = (p) => [p[0], p[1], 22 - p[2]];
  return binaryStl(upper ? tris.map(([a, b, c]) => [flip(a), flip(c), flip(b)]) : tris);
}

export const asciiStl = () => 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
export const plyText = () => 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
export const objText = () => 'o tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
