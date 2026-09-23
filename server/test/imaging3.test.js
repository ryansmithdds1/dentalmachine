import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './helpers.js';

const h = harness();
const agentPath = join(dirname(fileURLToPath(import.meta.url)), '../../bridge/dental-machine-bridge.mjs');
const waitFor = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
};
let n = 0;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`img-${++n}-${Math.random()}`)]);

async function workstation(api, name, sensor) {
  const created = (await api.post('/imaging/agents', { name })).data;
  const bridge = (method, path, body) => fetch(`${h.origin}/api/bridge${path}`, { method, headers: { Authorization: `Bridge ${created.token}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
  await bridge('POST', '/hello', { apps: [], sensor });
  const ws = (await api.get('/imaging/agents')).data.find((a) => a.name === name);
  return { bridge, ws, token: created.token };
}

test('guided capture: aim at a spot, retake keeps the original, exposure is logged, progress is live', async () => {
  const { api, patient } = await h.practice();
  const { bridge, ws } = await workstation(api, 'Op 5', { name: 'Tuxedo sensor (Tuxedo TWAIN)', mode: 'command', preset: 'tuxedo', exposure: { kvp: 70, ma: 7, seconds: 99 } });
  // An out-of-range exposure setting is dropped rather than recorded.
  assert.deepEqual(ws.sensor_info, { mode: 'command', preset: 'tuxedo', exposure: null, pixel_um: null, size: null });
  await bridge('POST', '/hello', { apps: [], sensor: { name: 'Tuxedo sensor', preset: 'tuxedo', exposure: { kvp: 70, ma: 7 } } });

  const cap = (await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, template: 'bw4', slot: 2 })).data;
  assert.deepEqual(cap.target, { slot: 2, retake: false });
  await bridge('GET', '/commands?wait=0');
  assert.deepEqual((await (await bridge('GET', `/captures/${cap.id}`)).json()).target, { slot: 2, retake: false });

  await bridge('POST', `/commands/${cap.id}/progress`, { state: 'waiting', message: 'Ready for spot 3 — expose the sensor' });
  const live = (await api.get(`/imaging/commands/${cap.id}`)).data;
  assert.equal(live.progress.state, 'waiting');
  assert.match(live.progress.message, /spot 3/);
  assert.deepEqual([live.filled, live.total], [0, 4]);

  // The first image goes to the aimed spot; the next ones fill in order again.
  const first = await (await bridge('POST', `/images?filename=a.png&capture_id=${cap.id}&seconds=0.16`, png())).json();
  assert.equal(first.slot, 2);
  const second = await (await bridge('POST', `/images?filename=b.png&capture_id=${cap.id}`, png())).json();
  assert.equal(second.slot, 0);
  const doc = (await api.get(`/patients/${patient.id}/documents`)).data.find((d) => d.id === first.id);
  assert.deepEqual(doc.exposure, { kvp: 70, ma: 7, seconds: 0.16, sensor: 'Tuxedo sensor' });
  assert.ok(doc.taken_at);

  // Aim at a filled spot without retaking: refused. With retake: the new image replaces it in the mount.
  assert.equal((await api.put(`/imaging/commands/${cap.id}/target`, { slot: 2 })).status, 409);
  assert.equal((await api.put(`/imaging/commands/${cap.id}/target`, { slot: 9 })).status, 400);
  assert.deepEqual((await api.put(`/imaging/commands/${cap.id}/target`, { slot: 2, retake: true })).data.target, { slot: 2, retake: true });
  const retake = await (await bridge('POST', `/images?filename=c.png&capture_id=${cap.id}`, png())).json();
  assert.deepEqual([retake.slot, retake.replaced], [2, first.id]);
  const mount = (await api.get(`/patients/${patient.id}/mounts`)).data.find((m) => m.id === cap.mount_id);
  assert.deepEqual(mount.slots, { 0: second.id, 2: retake.id });
  const docs = (await api.get(`/patients/${patient.id}/documents`)).data;
  assert.ok(docs.find((d) => d.id === first.id), 'the original stays in the chart');
  assert.equal(docs.find((d) => d.id === retake.id).retake_of, first.id);

  // Fill the rest; then a full mount can still be reopened to retake one spot, and finishes after it.
  await bridge('POST', `/images?filename=d.png&capture_id=${cap.id}`, png());
  await bridge('POST', `/images?filename=e.png&capture_id=${cap.id}`, png());
  assert.equal((await api.get(`/imaging/commands/${cap.id}`)).data.status, 'done');
  assert.equal((await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, mount_id: cap.mount_id })).status, 409);
  const again = await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, mount_id: cap.mount_id, slot: 0, retake: true });
  assert.equal(again.status, 201);
  await bridge('GET', '/commands?wait=0');
  assert.equal((await (await bridge('GET', `/captures/${again.data.id}`)).json()).active, true);
  const redo = await (await bridge('POST', `/images?filename=f.png&capture_id=${again.data.id}`, png())).json();
  assert.deepEqual([redo.slot, redo.remaining, redo.replaced], [0, 0, second.id]);
  const fin = (await api.get(`/imaging/commands/${again.data.id}`)).data;
  assert.equal(fin.status, 'done');
  assert.match(fin.result, /Retake saved \(spot 1\)/);
});

test('viewer: saved adjustments, exposure edits, angle and canal-length marks, new mount layouts', async () => {
  const { api, patient, token } = await h.practice();
  const doc = await (await fetch(`${h.origin}/api/patients/${patient.id}/documents?category=xray&filename=pa.png`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body: png() })).json();
  const adj = await api.put(`/documents/${doc.id}/adjust`, { adjust: { brightness: 12, contrast: -5, gamma: 1.4, sharpen: 1.5, invert: true, colormap: 'heat', rotate: -90, flipH: false } });
  assert.equal(adj.status, 200, JSON.stringify(adj.data));
  assert.deepEqual(adj.data.adjust, { brightness: 12, contrast: -5, gamma: 1.4, sharpen: 1.5, invert: true, rotate: 270, colormap: 'heat' });
  assert.equal((await api.put(`/documents/${doc.id}/adjust`, { adjust: { gamma: 9 } })).status, 400);
  assert.equal((await api.put(`/documents/${doc.id}/adjust`, { adjust: { colormap: 'rainbow' } })).status, 400);
  const viewer = (await api.get(`/documents/${doc.id}/viewer`)).data;
  assert.equal(viewer.adjust.rotate, 270);
  assert.equal((await api.put(`/documents/${doc.id}/adjust`, { adjust: null })).data.adjust, null);

  assert.deepEqual((await api.put(`/documents/${doc.id}`, { exposure: { kvp: 65, ma: '7', seconds: 0.2, size: '2' } })).data.exposure, { kvp: 65, ma: 7, seconds: 0.2, size: '2' });
  assert.equal((await api.put(`/documents/${doc.id}`, { exposure: { kvp: 500 } })).status, 400);

  const canal = Array.from({ length: 50 }, (_, i) => [10 + i, 20 + i * 2]);
  const saved = await api.put(`/documents/${doc.id}/annotations`, { annotations: [{ type: 'angle', points: [[0, 0], [10, 0], [10, 10]] }, { type: 'polyline', points: canal }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.annotations[1].points.length, 40);
  assert.equal((await api.put(`/documents/${doc.id}/annotations`, { annotations: [{ type: 'angle', points: [[0, 0], [1, 1]] }] })).status, 400);

  for (const template of ['pa1', 'vbw7', 'pano1', 'fmx14']) assert.equal((await api.post(`/patients/${patient.id}/mounts`, { template })).status, 201);
});

test('sensor presets: the bridge finds the Tuxedo TWAIN source by name, and "Test sensor" returns an image', async () => {
  const { api, token } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Op 6' })).data;
  const dir = mkdtempSync(join(tmpdir(), 'dm-preset-'));
  // A stand-in for NAPS2.Console: lists TWAIN devices, or "acquires" a PNG to the -o path from the named device.
  const fake = join(dir, 'naps2.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--listdevices')) { console.log('WIA-Scanner'); console.log('Tuxedo Imaging TWAIN'); process.exit(0); }
if (a[a.indexOf('--device') + 1] !== 'Tuxedo Imaging TWAIN') process.exit(3);
writeFileSync(a[a.indexOf('-o') + 1], Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('test-frame')]));
`);
  const launcher = join(dir, process.platform === 'win32' ? 'naps2.cmd' : 'naps2.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ server: h.origin, token: created.token, sensor: { preset: 'tuxedo', command: launcher, exposure: { kvp: 70, ma: 7 } } }));
  const agent = spawn(process.execPath, [agentPath, join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  agent.stderr.on('data', (d) => (out += d));
  try {
    const ws = await waitFor(async () => (await api.get('/imaging/agents')).data.find((a) => a.name === 'Op 6' && a.online && a.sensor));
    assert.equal(ws.sensor, 'Tuxedo sensor (Tuxedo Imaging TWAIN)');
    assert.equal(ws.sensor_info.preset, 'tuxedo');
    assert.deepEqual(ws.sensor_info.exposure, { kvp: 70, ma: 7 });
    const t = await api.post(`/imaging/agents/${ws.id}/test-sensor`);
    assert.equal(t.status, 201);
    const done = await waitFor(async () => {
      const c = (await api.get(`/imaging/commands/${t.data.id}`)).data;
      return ['done', 'error'].includes(c.status) ? c : null;
    }, 15_000);
    assert.equal(done.status, 'done', done.result);
    assert.match(done.result, /works/);
    assert.equal(done.test_image, true);
    const img = await fetch(`${h.origin}/api/imaging/commands/${t.data.id}/test-image`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
  } catch (err) {
    err.message += `\nagent output:\n${out}`;
    throw err;
  } finally {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mm scale for sensor images without one: calibration, pixel size, or an estimate from the sensor size', async () => {
  const { api, patient } = await h.practice();
  // A PNG with real dimensions (1500 × 1000), different bytes each time.
  const sized = () => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(1500, 16);
    b.writeUInt32BE(1000, 20);
    b.write(String(Math.random()), 24);
    return b;
  };
  const shoot = async (bridge, ws) => {
    const cap = (await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, template: 'pa1' })).data;
    await bridge('GET', '/commands?wait=0');
    const out = await (await bridge('POST', `/images?filename=x.png&capture_id=${cap.id}`, sized())).json();
    return (await api.get(`/documents/${out.id}/viewer`)).data;
  };

  const est = await workstation(api, 'Op 7', { name: 'Jazz sensor', preset: 'jazz', size: 2 });
  let v = await shoot(est.bridge, est.ws);
  assert.equal(v.scale_source, 'estimate');
  assert.equal(v.mm_per_px, 36 / 1500);
  assert.equal(v.agent_id, est.ws.id);

  await est.bridge('POST', '/hello', { apps: [], sensor: { name: 'Jazz sensor', preset: 'jazz', size: 2, pixelSize: 20 } });
  v = await shoot(est.bridge, est.ws);
  assert.deepEqual([v.scale_source, v.mm_per_px], ['sensor', 0.02]);

  assert.equal((await api.put(`/imaging/agents/${est.ws.id}/calibration`, { mm_per_px: 5 })).status, 400);
  assert.equal((await api.put(`/imaging/agents/${est.ws.id}/calibration`, { mm_per_px: 0.0195 })).data.mm_per_px, 0.0195);
  v = await shoot(est.bridge, est.ws);
  assert.deepEqual([v.scale_source, v.mm_per_px], ['calibrated', 0.0195]);

  // Calibrating one image by hand marks it calibrated.
  await api.put(`/documents/${v.id}/annotations`, { annotations: [], mm_per_px: 0.021 });
  assert.deepEqual(((r) => [r.scale_source, r.mm_per_px])((await api.get(`/documents/${v.id}/viewer`)).data), ['calibrated', 0.021]);

  // Clarity settings are accepted and kept.
  const adj = await api.put(`/documents/${v.id}/adjust`, { adjust: { stretch: true, clahe: 2, denoise: 1, sharpen: 0.8 } });
  assert.deepEqual(adj.data.adjust, { sharpen: 0.8, denoise: 1, clahe: 2, stretch: true });
  assert.equal((await api.put(`/documents/${v.id}/adjust`, { adjust: { clahe: 9 } })).status, 400);
});
