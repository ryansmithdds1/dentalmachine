// Diagnostic image processing for x-rays, applied to a copy of the pixels (the stored image never changes).
// Order: noise reduction (median) → auto levels (percentile stretch) → local contrast (CLAHE) → global
// equalization → sharpen (unsharp mask) → gamma / brightness / contrast / invert → emboss → false colour.

export const NEUTRAL = { brightness: 0, contrast: 0, gamma: 1, sharpen: 0, denoise: 0, clahe: 0, stretch: false, invert: false, equalize: false, emboss: false, colormap: 'none', rotate: 0, flipH: false };

// Starting points for common reads; staff fine-tune from there and can save what they like per image.
export const PRESETS = [
  { id: 'original', label: 'Original', key: '1', hint: 'Exactly as the sensor sent it', adjust: {} },
  { id: 'clarity', label: 'Clarity', key: '2', hint: 'Auto levels, local contrast, light noise reduction and sharpening — a clear picture from any sensor', adjust: { stretch: true, denoise: 1, clahe: 2, sharpen: 0.8 } },
  { id: 'caries', label: 'Caries', key: '3', hint: 'Stronger contrast at the enamel and dentin for interproximal decay', adjust: { stretch: true, clahe: 1.5, contrast: 20, gamma: 0.9, sharpen: 1.2 } },
  { id: 'endo', label: 'Endo', key: '4', hint: 'Crisp edges for canals, files and apices', adjust: { stretch: true, denoise: 1, clahe: 1, gamma: 1.1, sharpen: 2 } },
  { id: 'perio', label: 'Perio', key: '5', hint: 'Brighter, softer for crestal bone levels', adjust: { stretch: true, clahe: 1, brightness: 6, gamma: 1.35, sharpen: 0.6 } },
];

// What an x-ray opens with when nobody has saved settings for it (per computer).
const OPEN_KEY = 'dm_xray_open';
export function openPreset() {
  try { return localStorage.getItem(OPEN_KEY) || 'clarity'; } catch { return 'clarity'; }
}
export function setOpenPreset(id) {
  try { localStorage.setItem(OPEN_KEY, id); } catch { /* per-computer convenience */ }
}

export const COLORMAPS = { none: 'Grey', heat: 'Heat', bone: 'Bone', spectrum: 'Spectrum' };

export const withDefaults = (a) => ({ ...NEUTRAL, ...(a || {}) });
// What is worth saving: only the settings that differ from neutral.
export function compact(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) if (k in NEUTRAL && v !== NEUTRAL[k]) out[k] = v;
  return Object.keys(out).length ? out : null;
}
export const isNeutralPixels = (a) => {
  const x = withDefaults(a);
  return !x.brightness && !x.contrast && x.gamma === 1 && !x.sharpen && !x.denoise && !x.clahe && !x.stretch && !x.invert && !x.equalize && !x.emboss && x.colormap === 'none';
};

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function colormapLut(name) {
  const stops = {
    heat: [[0, 0, 0, 0], [0.35, 180, 20, 0], [0.7, 255, 190, 0], [1, 255, 255, 255]],
    bone: [[0, 0, 0, 0], [0.375, 84, 84, 116], [0.75, 169, 200, 200], [1, 255, 255, 255]],
    spectrum: [[0, 20, 0, 90], [0.25, 0, 90, 255], [0.5, 0, 220, 120], [0.75, 255, 220, 0], [1, 255, 30, 0]],
  }[name];
  if (!stops) return null;
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, ...c0] = stops[j];
    const [t1, ...c1] = stops[j + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * f;
  }
  return lut;
}

// Separable box blur of one channel plane (Float32), radius r, used for the unsharp mask.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Is this image grey (an x-ray) rather than a colour photo? Sampled, so it's quick on big images.
export function isGrey(data) {
  const step = Math.max(4, Math.floor(data.length / 4 / 5000) * 4);
  for (let i = 0; i < data.length; i += step) {
    if (Math.abs(data[i] - data[i + 1]) > 6 || Math.abs(data[i + 1] - data[i + 2]) > 6) return false;
  }
  return true;
}

// 3×3 median: removes sensor speckle without softening edges the way a blur does.
function median3(plane, w, h) {
  const out = new Float32Array(plane.length);
  const v = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      let k = 0;
      for (const yy of [y0, y, y2]) { const r = yy * w; v[k++] = plane[r + x0]; v[k++] = plane[r + x]; v[k++] = plane[r + x2]; }
      // partial selection sort up to the middle element
      for (let i = 0; i <= 4; i++) {
        let m = i;
        for (let j = i + 1; j < 9; j++) if (v[j] < v[m]) m = j;
        const t = v[i]; v[i] = v[m]; v[m] = t;
      }
      out[y * w + x] = v[4];
    }
  }
  return out;
}

// Linear stretch between the 0.5th and 99.5th percentiles: uses the full grey range whatever the sensor
// or exposure delivered, without a few hot pixels washing it out.
function stretch(plane) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < plane.length; i++) hist[clamp(plane[i]) | 0]++;
  const n = plane.length;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.005; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.005; hi--);
  if (hi - lo < 8) return;
  const f = 255 / (hi - lo);
  for (let i = 0; i < n; i++) plane[i] = (plane[i] - lo) * f;
}

// CLAHE (contrast-limited adaptive histogram equalization): evens out contrast region by region, so
// enamel, dentin, bone and the dark periodontal ligament space are all readable at once. The limit keeps
// noise in flat areas from being amplified. strength 0–4.
function clahe(plane, w, h, strength) {
  const tiles = Math.max(2, Math.min(8, Math.round(Math.min(w, h) / 64)));
  const tw = w / tiles;
  const th = h / tiles;
  const maps = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Float32Array(256);
      const x0 = Math.floor(tx * tw); const x1 = Math.floor((tx + 1) * tw);
      const y0 = Math.floor(ty * th); const y1 = Math.floor((ty + 1) * th);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[clamp(plane[y * w + x]) | 0]++;
      const area = (x1 - x0) * (y1 - y0) || 1;
      const limit = Math.max(1, ((1 + strength * 1.5) * area) / 256);
      let excess = 0;
      for (let i = 0; i < 256; i++) if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
      const add = excess / 256;
      const map = new Float32Array(256);
      let cdf = 0;
      for (let i = 0; i < 256; i++) { cdf += hist[i] + add; map[i] = (cdf / area) * 255; }
      maps.push(map);
    }
  }
  const mix = Math.min(1, 0.35 + strength * 0.2); // blend with the original so it never looks synthetic
  for (let y = 0; y < h; y++) {
    const gy = Math.min(tiles - 1, Math.max(0, y / th - 0.5));
    const y0 = Math.floor(gy); const y1 = Math.min(tiles - 1, y0 + 1); const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(tiles - 1, Math.max(0, x / tw - 0.5));
      const x0 = Math.floor(gx); const x1 = Math.min(tiles - 1, x0 + 1); const fx = gx - x0;
      const i = y * w + x;
      const v = clamp(plane[i]) | 0;
      const top = maps[y0 * tiles + x0][v] * (1 - fx) + maps[y0 * tiles + x1][v] * fx;
      const bot = maps[y1 * tiles + x0][v] * (1 - fx) + maps[y1 * tiles + x1][v] * fx;
      plane[i] = plane[i] * (1 - mix) + (top * (1 - fy) + bot * fy) * mix;
    }
  }
}

function globalEqualize(plane) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < plane.length; i++) hist[clamp(plane[i]) | 0]++;
  const eq = new Float32Array(256);
  let cdf = 0;
  let min = 0;
  for (let i = 0; i < 256; i++) {
    cdf += hist[i];
    if (!min && cdf) min = cdf;
    eq[i] = plane.length === min ? i : ((cdf - min) / (plane.length - min)) * 255;
  }
  for (let i = 0; i < plane.length; i++) plane[i] = eq[clamp(plane[i]) | 0];
}

export function processPixels(source, adjust) {
  const a = withDefaults(adjust);
  const { width: w, height: h } = source;
  const src = source.data;
  const out = new ImageData(w, h);
  const dst = out.data;
  const grey = isGrey(src);
  const n = w * h;

  // Work on luminance; colour photos keep their colour by carrying each pixel's chroma along.
  let lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = grey ? src[p] : src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114;
  const original = grey ? null : Float32Array.from(lum);
  for (let k = 0; k < Math.round(a.denoise); k++) lum = median3(lum, w, h);
  if (a.stretch) stretch(lum);
  if (a.clahe > 0) clahe(lum, w, h, a.clahe);
  if (a.equalize) globalEqualize(lum);
  if (a.sharpen > 0) {
    const r = Math.max(1, Math.round(Math.max(w, h) / 600));
    const blur = boxBlur(lum, w, h, r);
    for (let i = 0; i < n; i++) lum[i] += a.sharpen * (lum[i] - blur[i]);
  }

  // Gamma → brightness/contrast → invert as one table.
  const c = a.contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = 255 * Math.pow(i / 255, 1 / a.gamma);
    v = cf * (v - 128) + 128 + a.brightness * 1.28;
    lut[i] = clamp(a.invert ? 255 - v : v);
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = lum[i] < 0 ? 0 : lum[i] > 255 ? 255 : lum[i] | 0;
    if (grey) {
      dst[p] = dst[p + 1] = dst[p + 2] = lut[v];
    } else {
      const d = lut[v] - (a.invert ? 255 - original[i] : original[i]);
      for (let ch = 0; ch < 3; ch++) dst[p + ch] = clamp((a.invert ? 255 - src[p + ch] : src[p + ch]) + d);
    }
    dst[p + 3] = src[p + 3];
  }

  if (a.emboss) {
    const l = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) l[i] = (dst[p] * 77 + dst[p + 1] * 150 + dst[p + 2] * 29) >> 8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const j = Math.min(h - 1, y + 1) * w + Math.min(w - 1, x + 1);
        const k = Math.max(0, y - 1) * w + Math.max(0, x - 1);
        dst[i * 4] = dst[i * 4 + 1] = dst[i * 4 + 2] = clamp(128 + 2 * (l[j] - l[k]));
      }
    }
  }
  const cmap = a.colormap !== 'none' ? colormapLut(a.colormap) : null;
  if (cmap) {
    for (let p = 0; p < dst.length; p += 4) {
      const v = (dst[p] * 77 + dst[p + 1] * 150 + dst[p + 2] * 29) >> 8;
      dst[p] = cmap[v * 3];
      dst[p + 1] = cmap[v * 3 + 1];
      dst[p + 2] = cmap[v * 3 + 2];
    }
  }
  return out;
}

// A canvas holding the processed image, ready to draw with any transform. Very large images are
// processed at up to ~12 megapixels (the viewer never shows more than that at once).
export function renderProcessed(img, adjust, cache) {
  const key = JSON.stringify(compact({ ...adjust, rotate: 0, flipH: false }));
  if (cache.key === key && cache.canvas && cache.img === img) return cache.canvas;
  if (!cache.base || cache.img !== img) {
    const f = Math.min(1, Math.sqrt(12e6 / (img.naturalWidth * img.naturalHeight)));
    const base = Object.assign(document.createElement('canvas'), { width: Math.round(img.naturalWidth * f), height: Math.round(img.naturalHeight * f) });
    base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
    cache.base = base;
    cache.scale = f;
    cache.pixels = base.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, base.width, base.height);
    cache.img = img;
  }
  cache.key = key;
  if (isNeutralPixels(adjust)) {
    cache.canvas = cache.base;
    return cache.canvas;
  }
  const c = Object.assign(document.createElement('canvas'), { width: cache.base.width, height: cache.base.height });
  c.getContext('2d').putImageData(processPixels(cache.pixels, adjust), 0, 0);
  cache.canvas = c;
  return c;
}

// CSS approximation for thumbnails in mounts (rotation/flip exact, the rest close enough to recognise).
export function thumbStyle(adjust) {
  const a = withDefaults(adjust);
  const filters = [];
  if (a.brightness) filters.push(`brightness(${100 + a.brightness}%)`);
  if (a.contrast) filters.push(`contrast(${100 + a.contrast * 1.5}%)`);
  if (a.invert) filters.push('invert(1)');
  if (a.equalize || a.clahe || a.stretch) filters.push('contrast(125%)');
  const t = [];
  if (a.rotate) t.push(`rotate(${a.rotate}deg)`);
  if (a.flipH) t.push('scaleX(-1)');
  return { filter: filters.join(' ') || undefined, transform: t.join(' ') || undefined };
}

// Geometry helpers for measurements (image pixels in, mm or px out).
export const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
export const pathLength = (pts) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
export function angleAt(a, v, b) {
  const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
  const a2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
  let d = Math.abs(a1 - a2) * (180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}
