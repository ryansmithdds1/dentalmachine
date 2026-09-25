/* global window */
// Simulated hardware for the measuring robot (batch 3): the office's devices, played by the robot, so the people's
// side of "take x-rays with the sensor", "intraoral photos", "dictate a note" and "connect the imaging bridge" can
// be measured. What the device does (an exposure, a camera frame, speech) is never counted — only what the person
// does in the app. The chaos tests (e2e/chaos/fakes.mjs) fake the same devices failing; these ones work.
import { deflateSync } from 'node:zlib';

// A small, valid greyscale PNG whose pixels depend on `seed` (every exposure is a different image, as the server
// refuses the same image twice).
export function png(seed = 0, w = 64, h = 48) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x * 3 + y * 5 + seed * 37) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The imaging bridge on an operatory PC, with a sensor: says hello (so the chart shows it online), then answers
// capture commands with one image per spot, a moment apart, the way a hygienist exposing the sensor would.
// Returns { agent, stop() }. `token` given: an agent already added (the "connect a bridge" action).
export async function fakeBridge(t, { name = `Op ${Date.now() % 1000} (robot)`, sensor = 'Schick 33 (simulated)', token = null, apps = [] } = {}) {
  let key = token;
  let agent = null;
  if (!key) {
    agent = await t.as('admin').post('/imaging/agents', { name });
    key = agent.token;
  }
  const call = async (method, path, body, raw = false) => {
    const r = await fetch(`${t.base}/api/bridge${path}`, {
      method, headers: { Authorization: `Bridge ${key}`, ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`bridge ${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  await call('POST', '/hello', { hostname: 'OP-PC-ROBOT', version: '1.5.0', apps, sensor: sensor ? { name: sensor, mode: 'command', size: '2', pixelSize: 20 } : null, checks: [{ name: 'Sensor', ok: true }] });
  let running = true;
  let shot = 0;
  let failures = 0;
  const loop = (async () => {
    while (running) {
      const cmds = await call('GET', '/commands?wait=1').then((x) => { failures = 0; return x; }, async () => {
        // The server went away (the run ended) or refused: wait a little, and give up after a while.
        if (++failures > 20) running = false;
        await new Promise((r) => setTimeout(r, 300));
        return [];
      });
      for (const c of cmds) {
        if (c.type !== 'capture') { await call('POST', `/commands/${c.id}/result`, { ok: true }).catch(() => {}); continue; }
        for (let i = 0; i < 40 && running; i++) {
          const s = await call('GET', `/captures/${c.id}`).catch(() => ({ active: false }));
          if (!s.active) break;
          await call('POST', `/commands/${c.id}/progress`, { state: 'waiting', message: 'Ready — expose the sensor' }).catch(() => {});
          await new Promise((r) => setTimeout(r, 250)); // the exposure
          await call('POST', `/images?capture_id=${c.id}&filename=${encodeURIComponent(`exposure-${++shot}.png`)}`, png(shot + Date.now() % 997), true).catch(() => {});
        }
        await call('POST', `/commands/${c.id}/result`, { ok: true, message: 'All spots filled' }).catch(() => {});
      }
      if (!cmds.length && running) await call('POST', '/hello', { hostname: 'OP-PC-ROBOT', version: '1.5.0', apps, sensor: sensor ? { name: sensor, mode: 'command' } : null }).catch(() => {});
    }
  })();
  return { agent, key, stop: async () => { running = false; await loop.catch(() => {}); } };
}

// Speech recognition that hears `phrase` a moment after it starts (the dentist talking), then waits quietly
// until stopped — the browser's own recogniser, played by the robot.
export const TALKING_SPEECH = (phrase) => {
  class Talking {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.timers = []; }
    start() {
      this.onstart?.();
      const result = (text, isFinal) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence: 0.95 }], { isFinal })] });
      this.timers.push(setTimeout(() => this.onresult?.(result(phrase, true)), 300));
    }
    stop() { this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 10); }
    abort() { this.stop(); }
    addEventListener(type, fn) { this[`on${type}`] = fn; }
  }
  window.SpeechRecognition = Talking;
  window.webkitSpeechRecognition = Talking;
};
