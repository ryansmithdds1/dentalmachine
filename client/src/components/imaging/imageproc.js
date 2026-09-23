// Diagnostic image processing for x-rays, applied to a copy of the pixels (the stored image never changes).
// Order: histogram equalization ("Auto") → sharpen (unsharp mask) → gamma / brightness / contrast /
// invert as one lookup table → emboss → false colour.

export const NEUTRAL = { brightness: 0, contrast: 0, gamma: 1, sharpen: 0, invert: false, equalize: false, emboss: false, colormap: 'none', rotate: 0, flipH: false };

// Starting points for common reads; staff fine-tune from there and can save what they like per image.
export const PRESETS = [
  { id: 'original', label: 'Original', key: '1', adjust: {} },
  { id: 'caries', label: 'Caries', key: '2', hint: 'Higher contrast and sharpening for interproximal decay', adjust: { contrast: 35, gamma: 0.85, sharpen: 1.2 } },
  { id: 'endo', label: 'Endo', key: '3', hint: 'Sharp edges for canals, files and apices', adjust: { contrast: 20, gamma: 1.15, sharpen: 2.2 } },
  { id: 'perio', label: 'Perio', key: '4', hint: 'Brighter, softer for crestal bone levels', adjust: { brightness: 8, contrast: 12, gamma: 1.45, sharpen: 0.6 } },
  { id: 'auto', label: 'Auto', key: '5', hint: 'Spreads the grey levels across the full range', adjust: { equalize: true, sharpen: 0.5 } },
];

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
  return !x.brightness && !x.contrast && x.gamma === 1 && !x.sharpen && !x.invert && !x.equalize && !x.emboss && x.colormap === 'none';
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

export function processPixels(source, adjust) {
  const a = withDefaults(adjust);
  const { width: w, height: h } = source;
  const src = source.data;
  const out = new ImageData(w, h);
  const dst = out.data;
  const grey = isGrey(src);

  // Point operations as one table: equalize → gamma → brightness/contrast → invert.
  const eq = new Float32Array(256);
  if (a.equalize) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < src.length; i += 4) hist[(src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29) >> 8]++;
    let cdf = 0;
    let min = 0;
    const total = w * h;
    for (let i = 0; i < 256; i++) {
      cdf += hist[i];
      if (!min && cdf) min = cdf;
      eq[i] = total === min ? i : ((cdf - min) / (total - min)) * 255;
    }
  } else for (let i = 0; i < 256; i++) eq[i] = i;
  const c = a.contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = 255 * Math.pow(eq[i] / 255, 1 / a.gamma);
    v = cf * (v - 128) + 128 + a.brightness * 1.28;
    lut[i] = clamp(a.invert ? 255 - v : v);
  }

  // Sharpen (unsharp mask) works on luminance for x-rays, on each channel for photos.
  const channels = grey ? 1 : 3;
  const sharp = [];
  if (a.sharpen > 0) {
    const r = Math.max(1, Math.round(Math.max(w, h) / 600));
    for (let ch = 0; ch < channels; ch++) {
      const plane = new Float32Array(w * h);
      for (let i = 0, p = ch; i < plane.length; i++, p += 4) plane[i] = src[p];
      const blur = boxBlur(plane, w, h, r);
      for (let i = 0; i < plane.length; i++) plane[i] += a.sharpen * (plane[i] - blur[i]);
      sharp.push(plane);
    }
  }
  const cmap = a.colormap !== 'none' ? colormapLut(a.colormap) : null;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const s = sharp.length ? sharp[grey ? 0 : ch][i] : src[p + (grey ? 0 : ch)];
      dst[p + ch] = lut[s < 0 ? 0 : s > 255 ? 255 : s | 0];
    }
    dst[p + 3] = src[p + 3];
  }

  if (a.emboss) {
    // Relief: difference with the diagonal neighbour, centred on mid-grey.
    const lum = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = (dst[p] * 77 + dst[p + 1] * 150 + dst[p + 2] * 29) >> 8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const j = Math.min(h - 1, y + 1) * w + Math.min(w - 1, x + 1);
        const k = Math.max(0, y - 1) * w + Math.max(0, x - 1);
        const v = clamp(128 + 2 * (lum[j] - lum[k]));
        dst[i * 4] = dst[i * 4 + 1] = dst[i * 4 + 2] = v;
      }
    }
  }
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
  if (a.equalize) filters.push('contrast(130%)');
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
