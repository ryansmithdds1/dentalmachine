// Phone/tablet document scanning, done on the device (nothing leaves the phone until the person sends it):
// find the page in the photo, straighten it (perspective correction, which also removes skew), and make it
// look scanned (even lighting, good contrast). Pure functions on { width, height, data } RGBA images, so
// they run on a canvas's ImageData in the browser and in Node tests alike.
//
// Finding the page: paper is usually lighter than what it lies on. The photo is shrunk, blurred and split into
// light/dark (Otsu's threshold); the largest light region that isn't the whole picture is the page, and its
// four corners are the points furthest towards each corner (min/max of x+y and x−y). When that fails (a white
// page on a white desk), the corners fall back to the picture's edges and the person drags them into place.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Luminance of an RGBA image, shrunk so the longer side is at most `max` → { width, height, gray: Float32Array, scale }.
export function grayscale(img, max = 400) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const gray = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Average of the source block (box filter) so small text doesn't alias.
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += Math.max(1, (y1 - y0) >> 2)) {
        for (let xx = x0; xx < x1; xx += Math.max(1, (x1 - x0) >> 2)) {
          const i = (yy * img.width + xx) * 4;
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      }
      gray[y * w + x] = sum / n;
    }
  }
  return { width: w, height: h, gray, scale };
}

// Box blur (radius r) of a float image, via an integral image.
export function boxBlur(src, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

export function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[clamp(Math.round(v), 0, 255)]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// The largest 4-connected region of `mask` (Uint8Array of 0/1) → { count, pixels: Int32Array of indexes, touches: sides touched }.
function largestRegion(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = { count: 0, pixels: new Int32Array(0), touches: 0 };
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const pixels = [];
    let sides = 0;
    while (top) {
      const p = stack[--top];
      pixels.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0) sides |= 1;
      if (x === w - 1) sides |= 2;
      if (y === 0) sides |= 4;
      if (y === h - 1) sides |= 8;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    if (pixels.length > best.count) best = { count: pixels.length, pixels: Int32Array.from(pixels), touches: [1, 2, 4, 8].filter((b) => sides & b).length };
  }
  return best;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) a += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  return Math.abs(a) / 2;
}
const convex = (q) => {
  const s = [0, 1, 2, 3].map((i) => Math.sign(cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])));
  return s.every((v) => v === s[0] && v !== 0);
};

// The page's corners in the image's own pixels, clockwise from top-left: → { quad: [[x,y]×4], found }.
const GROW = 3;
export function findDocumentQuad(img) {
  const g = grayscale(img, 360);
  const { width: w, height: h } = g;
  const blurred = boxBlur(g.gray, w, h, 2);
  const t = otsu(blurred);
  const attempt = (light) => {
    const raw = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) raw[i] = light ? (blurred[i] > t ? 1 : 0) : (blurred[i] <= t ? 1 : 0);
    // Close the gaps text makes in the page (a dilation), so the page is one region; corners are moved back in below.
    const grown = boxBlur(raw, w, h, GROW);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = grown[i] > 0.5 ? 1 : 0;
    const region = largestRegion(mask, w, h);
    // The page, not the background: big enough, and not wrapped around all four edges.
    if (region.count < w * h * 0.12 || region.touches >= 4) return null;
    let tl = null; let tr = null; let br = null; let bl = null;
    let s1 = Infinity; let s2 = -Infinity; let d1 = -Infinity; let d2 = Infinity;
    for (const p of region.pixels) {
      const x = p % w;
      const y = (p - x) / w;
      if (x + y < s1) { s1 = x + y; tl = [x, y]; }
      if (x + y > s2) { s2 = x + y; br = [x, y]; }
      if (x - y > d1) { d1 = x - y; tr = [x, y]; }
      if (x - y < d2) { d2 = x - y; bl = [x, y]; }
    }
    const q = [tl, tr, br, bl];
    if (!convex(q) || quadArea(q) < w * h * 0.12) return null;
    // How well the quadrilateral explains the region: a page fills its corners' outline.
    if (region.count / quadArea(q) < 0.8) return null;
    return q;
  };
  const q = attempt(true) || attempt(false);
  const inv = 1 / g.scale;
  if (!q) {
    const mx = img.width * 0.03;
    const my = img.height * 0.03;
    return { found: false, quad: [[mx, my], [img.width - mx, my], [img.width - mx, img.height - my], [mx, img.height - my]] };
  }
  // Corners sit half a pixel out at the shrunk scale; step back out to the page edge.
  return { found: true, quad: q.map(([x, y]) => [clamp((x + 0.5) * inv, 0, img.width), clamp((y + 0.5) * inv, 0, img.height)]) };
}

// Homography mapping the unit square's corners (0,0),(1,0),(1,1),(0,1) to quad q.
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2; const dy2 = y3 - y2; const dy3 = y0 - y1 + y2 - y3;
  let a13 = 0; let a23 = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dx2 * dy1;
    a13 = (dx3 * dy2 - dx2 * dy3) / den;
    a23 = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The size the straightened page should be (its real proportions), capped at `max` pixels on the long side.
export function outputSize(quad, max = 2200) {
  const w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// The part of `img` inside `quad`, straightened into a width×height rectangle (bilinear sampling).
export function warpPerspective(img, quad, width, height) {
  const H = squareToQuad(quad);
  const out = new Uint8ClampedArray(width * height * 4);
  const sw = img.width;
  const sh = img.height;
  const src = img.data;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const z = H[6] * u + H[7] * v + H[8];
      const px = (H[0] * u + H[1] * v + H[2]) / z - 0.5;
      const py = (H[3] * u + H[4] * v + H[5]) / z - 0.5;
      const x0 = clamp(Math.floor(px), 0, sw - 1);
      const y0 = clamp(Math.floor(py), 0, sh - 1);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = clamp(px - x0, 0, 1);
      const fy = clamp(py - y0, 0, 1);
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src[(y0 * sw + x0) * 4 + c];
        const b = src[(y0 * sw + x1) * 4 + c];
        const d = src[(y1 * sw + x0) * 4 + c];
        const e = src[(y1 * sw + x1) * 4 + c];
        out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

// Small leftover tilt (degrees, −6…6) of text lines, by which rotation makes the row profile sharpest.
export function estimateSkew(img) {
  const g = grayscale(img, 500);
  const { width: w, height: h, gray } = g;
  const t = otsu(gray);
  const ink = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (gray[y * w + x] < t) ink.push([x - w / 2, y - h / 2]);
  if (ink.length < 50) return 0;
  let best = 0;
  let bestScore = -1;
  for (let a = -6; a <= 6.001; a += 0.5) {
    const r = (a * Math.PI) / 180;
    const sin = Math.sin(r);
    const cos = Math.cos(r);
    const rows = new Map();
    for (const [x, y] of ink) {
      const yy = Math.round(-x * sin + y * cos);
      rows.set(yy, (rows.get(yy) || 0) + 1);
    }
    let score = 0;
    for (const c of rows.values()) score += c * c;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

// Rotates by `deg` about the centre, keeping the size (the corners fill with white, like paper).
export function rotate(img, deg) {
  if (!deg) return img;
  const r = (deg * Math.PI) / 180;
  const cx = img.width / 2;
  const cy = img.height / 2;
  const corner = (x, y) => [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)];
  const out = warpPerspective(img, [corner(0, 0), corner(img.width, 0), corner(img.width, img.height), corner(0, img.height)], img.width, img.height);
  return out;
}

// Quarter turns (the rotate button), exact.
export function rotate90(img, turns = 1) {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return img;
  const { width: w, height: h, data } = img;
  const W = t % 2 ? h : w;
  const H = t % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [X, Y] = t === 1 ? [h - 1 - y, x] : t === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const s = (y * w + x) * 4;
      const d = (Y * W + X) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

// "Scan look": even out the lighting (divide by the local background), then stretch the contrast.
// mode: 'color' | 'gray' | 'bw' (crisp black text on white) | 'photo' (untouched).
export function enhance(img, mode = 'color') {
  if (mode === 'photo') return img;
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  // The paper's brightness around each point: a wide blur of a small copy, where the text barely counts.
  const small = grayscale(img, 160);
  const r = Math.max(2, Math.round(Math.max(small.width, small.height) / 16));
  let bg = small.gray;
  // Push toward the paper (lighter) by blurring the max of each neighbourhood.
  const maxed = new Float32Array(bg.length);
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = clamp(x + dx, 0, small.width - 1);
        const yy = clamp(y + dy, 0, small.height - 1);
        m = Math.max(m, bg[yy * small.width + xx]);
      }
      maxed[y * small.width + x] = m;
    }
  }
  bg = boxBlur(maxed, small.width, small.height, r);
  const bgAt = (x, y) => {
    const sx = clamp(Math.floor((x / w) * small.width), 0, small.width - 1);
    const sy = clamp(Math.floor((y / h) * small.height), 0, small.height - 1);
    return Math.max(24, bg[sy * small.width + sx]);
  };
  const out = new Uint8ClampedArray(w * h * 4);
  // Normalised lightness, then a levels stretch from its 1st to 99th percentile.
  const norm = new Float32Array(w * h);
  const hist = new Array(256).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = clamp((lum[i] / bgAt(x, y)) * 235, 0, 255);
      norm[i] = v;
      hist[Math.round(v)]++;
    }
  }
  const pct = (p) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= p * w * h) return i; }
    return 255;
  };
  const lo = pct(0.01);
  const hi = Math.max(lo + 16, pct(0.95));
  const level = (v) => clamp(((v - lo) / (hi - lo)) * 255, 0, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const L = level(norm[i]);
      if (mode === 'gray') {
        out[o] = out[o + 1] = out[o + 2] = L;
      } else if (mode === 'bw') {
        out[o] = out[o + 1] = out[o + 2] = L > 150 ? 255 : 0;
      } else {
        // Colour: scale each channel by the same lightening, so stamps and signatures keep their colour.
        const k = lum[i] > 1 ? L / lum[i] : 1;
        out[o] = clamp(data[o] * k, 0, 255);
        out[o + 1] = clamp(data[o + 1] * k, 0, 255);
        out[o + 2] = clamp(data[o + 2] * k, 0, 255);
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// The whole page pipeline: straighten along `quad` (from findDocumentQuad or the person's corners), take out
// any small tilt left, then the scan look.
export function processPage(img, quad, { mode = 'color', max = 2200, deskew = true } = {}) {
  const size = outputSize(quad, max);
  let page = warpPerspective(img, quad, size.width, size.height);
  if (deskew && mode !== 'photo') {
    const a = estimateSkew(page);
    if (Math.abs(a) >= 0.5) page = rotate(page, a);
  }
  return enhance(page, mode);
}
