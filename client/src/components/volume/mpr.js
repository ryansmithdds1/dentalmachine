// Pure helpers for the CBCT viewer: reading the server's volume format, cutting axial / coronal /
// sagittal slices and a curved (panoramic) reconstruction, window/level lookup tables and presets.
// Voxel indices: i = column (x, toward the patient's left), j = row (y, toward the back), k = slice
// (z, toward the head). Slices are shown the radiology way: patient's right on the viewer's left,
// head at the top, face on the left of the sagittal view.

// "DMVOL1\0\0" · uint32 data offset · JSON header · Int16 LE voxels (see server/src/volume.js).
export function parseVolume(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'DMVOL1') throw new Error('The server sent something that isn’t a volume');
  const offset = new DataView(buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, offset)).trim());
  const [nx, ny, nz] = header.dims;
  const data = new Int16Array(buffer, offset, nx * ny * nz);
  return { ...header, data, nx, ny, nz };
}

export const VIEWS = {
  axial: { label: 'Axial', color: '#38bdf8', axis: 2 },
  coronal: { label: 'Coronal', color: '#a3e635', axis: 1 },
  sagittal: { label: 'Sagittal', color: '#f472b6', axis: 0 },
};

// How many slices a view has, and which cursor axis it moves.
export const sliceCount = (vol, view) => (view === 'axial' ? vol.nz : view === 'coronal' ? vol.ny : vol.nx);

// One slice as a grid of values, with its size in voxels and mm per pixel across (su) and down (sv).
export function extractSlice(vol, view, index) {
  const { nx, ny, nz, data, spacing } = vol;
  if (view === 'axial') {
    const k = clamp(index, 0, nz - 1);
    return { w: nx, h: ny, su: spacing[0], sv: spacing[1], values: data.subarray(k * nx * ny, (k + 1) * nx * ny) };
  }
  if (view === 'coronal') {
    const j = clamp(index, 0, ny - 1);
    const out = new Int16Array(nx * nz);
    for (let r = 0; r < nz; r++) {
      const k = nz - 1 - r;
      const src = k * nx * ny + j * nx;
      out.set(data.subarray(src, src + nx), r * nx);
    }
    return { w: nx, h: nz, su: spacing[0], sv: spacing[2], values: out };
  }
  const i = clamp(index, 0, nx - 1);
  const out = new Int16Array(ny * nz);
  for (let r = 0; r < nz; r++) {
    const k = nz - 1 - r;
    const base = k * nx * ny + i;
    for (let j = 0; j < ny; j++) out[r * ny + j] = data[base + j * nx];
  }
  return { w: ny, h: nz, su: spacing[1], sv: spacing[2], values: out };
}

// Where the cursor (i, j, k) falls in a view's image (u across, v down), and back.
export function cursorToView(view, [i, j, k], vol) {
  if (view === 'axial') return [i, j];
  if (view === 'coronal') return [i, vol.nz - 1 - k];
  return [j, vol.nz - 1 - k];
}
export function viewToCursor(view, [u, v], cursor, vol) {
  const r = (x, n) => clamp(Math.round(x), 0, n - 1);
  if (view === 'axial') return [r(u, vol.nx), r(v, vol.ny), cursor[2]];
  if (view === 'coronal') return [r(u, vol.nx), cursor[1], r(vol.nz - 1 - v, vol.nz)];
  return [cursor[0], r(u, vol.ny), r(vol.nz - 1 - v, vol.nz)];
}
export const sliceOf = (view, cursor) => (view === 'axial' ? cursor[2] : view === 'coronal' ? cursor[1] : cursor[0]);
export function withSlice(view, cursor, index, vol) {
  const c = [...cursor];
  const axis = VIEWS[view].axis;
  c[axis] = clamp(index, 0, [vol.nx, vol.ny, vol.nz][axis] - 1);
  return c;
}

// Window/level → a 65536-entry table from every Int16 value to a gray level: fast enough to redraw
// three slices on every mouse move.
export function makeLut({ center, width }, invert = false) {
  const lut = new Uint8ClampedArray(65536);
  const lo = center - width / 2;
  const w = Math.max(1, width);
  for (let n = 0; n < 65536; n++) {
    const t = ((n - 32768) - lo) / w;
    const g = t <= 0 ? 0 : t >= 1 ? 255 : t * 255;
    lut[n] = invert ? 255 - g : g;
  }
  return lut;
}
export function toImageData(slice, lut, ctx) {
  const img = ctx.createImageData(slice.w, slice.h);
  const px = img.data;
  const v = slice.values;
  for (let n = 0, p = 0; n < v.length; n++, p += 4) {
    const g = lut[v[n] + 32768];
    px[p] = g; px[p + 1] = g; px[p + 2] = g; px[p + 3] = 255;
  }
  return img;
}

// Presets. CBCT units differ between machines: when the file is in Hounsfield units the classic
// numbers are used, otherwise they're placed on this scan's own range of values.
export function presets(vol) {
  const s = vol.stats || {};
  if (vol.units === 'HU') {
    return [
      { key: 'auto', label: 'Auto', ...autoWindow(vol) },
      { key: 'bone', label: 'Bone', center: 500, width: 2000 },
      { key: 'teeth', label: 'Teeth', center: 1300, width: 2800 },
      { key: 'soft', label: 'Soft tissue', center: 50, width: 450 },
      { key: 'airway', label: 'Airway', center: -500, width: 1000 },
    ];
  }
  const lo = s.p1 ?? s.min ?? 0;
  const hi = s.p999 ?? s.max ?? 1;
  const span = Math.max(1, hi - lo);
  return [
    { key: 'auto', label: 'Auto', ...autoWindow(vol) },
    { key: 'bone', label: 'Bone', center: lo + span * 0.55, width: span * 0.8 },
    { key: 'teeth', label: 'Teeth', center: lo + span * 0.78, width: span * 0.5 },
    { key: 'soft', label: 'Soft tissue', center: lo + span * 0.25, width: span * 0.35 },
    { key: 'airway', label: 'Airway', center: lo + span * 0.08, width: span * 0.3 },
  ];
}
export function autoWindow(vol) {
  const s = vol.stats || {};
  if (s.p1 != null && s.p999 != null && s.p999 > s.p1) return { center: Math.round((s.p1 + s.p999) / 2), width: Math.round(s.p999 - s.p1) };
  return vol.window || { center: 0, width: 2000 };
}

// ---- Screen ↔ image for a pane: fit to the pane keeping true proportions (mm), then zoom and pan ----
export function paneTransform(slice, cw, ch, view) {
  const wmm = slice.w * slice.su;
  const hmm = slice.h * slice.sv;
  const fit = Math.min(cw / wmm, ch / hmm) * 0.94;
  const scale = fit * (view.zoom || 1); // screen px per mm
  const dw = wmm * scale;
  const dh = hmm * scale;
  const ox = (cw - dw) / 2 + (view.px || 0);
  const oy = (ch - dh) / 2 + (view.py || 0);
  return {
    ox, oy, dw, dh, scale,
    toImage: (sx, sy) => [(sx - ox) / (slice.su * scale), (sy - oy) / (slice.sv * scale)],
    toScreen: (u, v) => [ox + u * slice.su * scale, oy + v * slice.sv * scale],
  };
}

// Distance in mm between two points of one slice (u, v in voxels).
export const mmBetween = (a, b, su, sv) => Math.hypot((b[0] - a[0]) * su, (b[1] - a[1]) * sv);

// ---- Curved (panoramic) reconstruction along an arch drawn on the axial view ----
// points: [[i, j], …] in axial voxels. Returns an image (w samples along the curve × nz rows, head at
// the top) where each pixel is the average (or maximum) across a slab `thickness` mm thick, plus where
// each column lies so a click on it can move the cursor.
export function panoramic(vol, points, { thickness = 12, mode = 'average' } = {}) {
  if (!points || points.length < 2) return null;
  const { nx, ny, nz, data, spacing } = vol;
  const [sx, sy] = spacing;
  const step = Math.min(sx, sy); // mm between samples along the curve
  // Catmull-Rom through the points (in mm), then resampled evenly by arc length.
  const mm = points.map(([i, j]) => [i * sx, j * sy]);
  const dense = [];
  for (let s = 0; s < mm.length - 1; s++) {
    const p0 = mm[Math.max(0, s - 1)]; const p1 = mm[s]; const p2 = mm[s + 1]; const p3 = mm[Math.min(mm.length - 1, s + 2)];
    for (let t = 0; t < 1; t += 0.02) {
      const t2 = t * t; const t3 = t2 * t;
      dense.push([0, 1].map((d) => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  dense.push(mm[mm.length - 1]);
  const samples = [];
  let carry = 0;
  for (let n = 1; n < dense.length; n++) {
    const a = dense[n - 1]; const b = dense[n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const tx = (b[0] - a[0]) / len; const ty = (b[1] - a[1]) / len;
    let d = carry;
    while (d < len) {
      samples.push({ x: a[0] + tx * d, y: a[1] + ty * d, nx: -ty, ny: tx });
      d += step;
    }
    carry = d - len;
  }
  const w = samples.length;
  if (w < 2 || w > 8000) return null;
  const slab = Math.max(1, Math.round(thickness / step));
  const out = new Int16Array(w * nz);
  const plane = nx * ny;
  const sample = (k, x, y) => { // bilinear in the axial plane (x, y in voxels)
    const x0 = Math.floor(x); const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= nx - 1 || y0 >= ny - 1) return null;
    const fx = x - x0; const fy = y - y0;
    const b = k * plane + y0 * nx + x0;
    return (data[b] * (1 - fx) + data[b + 1] * fx) * (1 - fy) + (data[b + nx] * (1 - fx) + data[b + nx + 1] * fx) * fy;
  };
  for (let c = 0; c < w; c++) {
    const s = samples[c];
    for (let r = 0; r < nz; r++) {
      const k = nz - 1 - r;
      let acc = 0; let n = 0; let max = -32768;
      for (let t = -slab / 2; t <= slab / 2; t++) {
        const v = sample(k, (s.x + s.nx * t * step) / sx, (s.y + s.ny * t * step) / sy);
        if (v == null) continue;
        acc += v; n++;
        if (v > max) max = v;
      }
      out[r * w + c] = n ? Math.round(mode === 'max' ? max : acc / n) : (vol.stats?.min ?? -1000);
    }
  }
  return { w, h: nz, su: step, sv: spacing[2], values: out, columns: samples.map((s) => [s.x / sx, s.y / sy]) };
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
