// Small sample images for the themed demo practice (themeddemo.js): a few x-ray-like and photo-like PNGs drawn
// in code, so the repository carries no binaries. Each is saved once per practice and shared by the chart's
// sample documents (the demo practice's x-rays and photos all point at these few files).
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

// width × height, channels 1 (grey) or 3 (RGB); pixel(x, y) returns a value or [r, g, b].
function png(width, height, channels, pixel) {
  const row = width * channels + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const v = pixel(x, y);
      if (channels === 1) raw[y * row + 1 + x] = v;
      else for (let c = 0; c < 3; c++) raw[y * row + 1 + x * 3 + c] = v[c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
// A tooth: a rounded crown over a tapering root, as a function of position (0..1 inside the tooth box).
const toothShape = (u, v) => {
  const crown = ((u - 0.5) / 0.46) ** 4 + ((v - 0.24) / 0.25) ** 4 < 1;
  // Two roots, each tapering to a rounded tip.
  const w = 0.13 * (1 - (v - 0.4) / 0.62);
  const root = v >= 0.4 && v < 1 && (Math.abs(u - 0.3) < w || Math.abs(u - 0.7) < w || (v < 0.55 && Math.abs(u - 0.5) < 0.3));
  return crown ? 'crown' : root ? 'root' : null;
};

// A bitewing-like radiograph: two rows of teeth with a bright filling or two.
function bitewing(seed) {
  const W = 360; const H = 260;
  return png(W, H, 1, (x, y) => {
    let v = 28 + 10 * Math.sin((x + seed * 13) / 37) * Math.cos(y / 29);
    const upper = y < H / 2;
    const ty = upper ? (H / 2 - y) / (H / 2 - 12) : (y - H / 2) / (H / 2 - 12);
    const idx = Math.floor((x - 10) / 85);
    const u = ((x - 10) % 85) / 85;
    if (idx >= 0 && idx < 4 && ty >= 0 && ty <= 1) {
      const part = toothShape(u, ty);
      if (part === 'crown') v = 190 - ty * 40;
      else if (part === 'root') v = 150 - ty * 50;
      if (part === 'crown' && Math.abs(u - 0.5) < 0.15 && ty < 0.2 && (idx + seed) % 3 === 0) v = 250; // a filling
      if (part && Math.abs(u - 0.5) < 0.08 && ty > 0.2) v -= 60; // the pulp
    }
    return clamp(v);
  });
}

// A panoramic-like image: a smile-shaped arch of teeth.
function pano(seed) {
  const W = 560; const H = 260;
  return png(W, H, 1, (x, y) => {
    let v = 22 + 18 * Math.exp(-(((x - W / 2) / 180) ** 2)) + 6 * Math.sin((x + seed) / 21);
    const curve = 22 * Math.cos(((x - W / 2) / W) * Math.PI);
    for (const upper of [true, false]) {
      const mid = H / 2 + (upper ? -6 : 6) + (upper ? -curve : curve) * 0.3;
      const ty = upper ? (mid - y) / 100 : (y - mid) / 100;
      const u = ((x - 12) % 34) / 34;
      if (x > 12 && x < W - 12 && ty >= 0 && ty <= 1) {
        const part = toothShape(u, ty);
        if (part === 'crown') v = 185 - ty * 30;
        else if (part === 'root') v = 140 - ty * 60;
      }
    }
    return clamp(v);
  });
}

// A periapical-like image: one tall tooth.
function periapical(seed) {
  const W = 200; const H = 280;
  return png(W, H, 1, (x, y) => {
    let v = 30 + 8 * Math.sin((y + seed * 7) / 17);
    const u = (x - 40) / 120; const ty = (y - 20) / 240;
    if (u >= 0 && u <= 1 && ty >= 0 && ty <= 1) {
      const part = toothShape(u, ty);
      if (part === 'crown') v = 195 - ty * 30;
      else if (part === 'root') v = 150 - ty * 40;
      if (part && Math.abs(u - 0.5) < 0.07 && ty > 0.15) v -= 70;
    }
    return clamp(v);
  });
}

// An intraoral photo-like image: pink gums and ivory teeth.
function photo(seed) {
  const W = 360; const H = 240;
  return png(W, H, 3, (x, y) => {
    const dx = (x - W / 2) / (W / 2); const dy = (y - H / 2) / (H / 2);
    if (dx * dx + dy * dy * 1.8 > 1) return [40, 18, 22];
    const u = ((x + seed * 3) % 45) / 45;
    const tooth = Math.abs(dy) < 0.42 && Math.abs(u - 0.5) < 0.44 && Math.abs(dy) > 0.03;
    if (tooth) { const s = 235 - Math.abs(dy) * 60; return [clamp(s), clamp(s - 6), clamp(s - 30)]; }
    return [clamp(200 - Math.abs(dy) * 40), clamp(95 - Math.abs(dy) * 20), clamp(110 - Math.abs(dy) * 20)];
  });
}

// [key, category, filename, notes, generator]
export const SAMPLE_IMAGES = [
  ['bw_right', 'xray', 'bitewing-right.png', 'Bitewing, right side', () => bitewing(1)],
  ['bw_left', 'xray', 'bitewing-left.png', 'Bitewing, left side', () => bitewing(2)],
  ['pano', 'xray', 'panoramic.png', 'Panoramic', () => pano(3)],
  ['pa', 'xray', 'periapical.png', 'Periapical', () => periapical(4)],
  ['photo', 'photo', 'intraoral-photo.png', 'Intraoral photo', () => photo(5)],
];
