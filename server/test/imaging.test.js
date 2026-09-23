import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './helpers.js';
import { buildDicom, readDicomTags } from '../src/dicom.js';

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

test('DICOM headers are read from explicit-VR files', () => {
  const tags = readDicomTags(buildDicom({ patientId: '77', patientName: 'DOE^JANE', studyDate: '20260315', modality: 'PX' }));
  assert.deepEqual(tags, { studyDate: '2026-03-15', modality: 'PX', patientName: 'DOE JANE', patientId: '77' });
  assert.equal(readDicomTags(Buffer.from('not dicom')), null);
});

test('imaging bridge: launch the imaging program from the chart and import captured images', async () => {
  const { api, patient, token } = await h.practice();
  const created = await api.post('/imaging/agents', { name: 'Op 2' });
  assert.equal(created.status, 201);
  assert.match(created.data.token, /^dmb_/);

  const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-'));
  const watch = join(dir, 'export');
  mkdirSync(watch);
  const marker = join(dir, 'launched.txt');
  const bridgeFile = join(dir, 'bridge', 'patient.txt');
  // A stand-in "imaging program" that records the arguments it was started with.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    server: h.origin, token: created.data.token, scanSeconds: 0.3,
    apps: [{ id: 'dexis', name: 'DEXIS', command: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv.slice(2).join("|"))', marker, '{patientId}', '{lastName}', '{dobYMD}'], writeFile: { path: bridgeFile, content: '{patientId}\n{lastName}^{firstName}\n' } }],
    watch: [{ folder: watch, category: 'xray' }],
  }));
  const agent = spawn(process.execPath, [agentPath, join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  agent.stderr.on('data', (d) => (out += d));
  try {
    const agents = await waitFor(async () => {
      const list = (await api.get('/imaging/agents')).data;
      return list[0]?.online && list[0].apps.length ? list : null;
    });
    assert.deepEqual(agents[0].apps, [{ id: 'dexis', name: 'DEXIS' }]);

    const launch = await api.post(`/patients/${patient.id}/imaging/launch`, { agent_id: agents[0].id, app: 'dexis' });
    assert.equal(launch.status, 201, JSON.stringify(launch.data));
    await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').length > 0);
    assert.equal(readFileSync(marker, 'utf8'), `${patient.id}|Doe|19850412`);
    assert.equal(readFileSync(bridgeFile, 'utf8'), `${patient.id}\nDoe^Jane\n`);
    assert.equal((await waitFor(async () => {
      const c = (await api.get(`/imaging/commands/${launch.data.id}`)).data;
      return c.status === 'done' ? c : null;
    })).status, 'done');

    // A DICOM x-ray tagged with the patient's chart number, and a camera photo with no ID
    // (filed under the patient just opened on this workstation).
    writeFileSync(join(watch, 'BWX_R.dcm'), buildDicom({ patientId: String(patient.id), studyDate: '20260920', modality: 'IO' }));
    writeFileSync(join(watch, 'IMG_0042.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]));
    const docs = await waitFor(async () => {
      const d = (await api.get(`/patients/${patient.id}/documents`)).data;
      return d.length >= 2 ? d : null;
    }, 15_000);
    const dcm = docs.find((d) => d.filename === 'BWX_R.dcm');
    assert.equal(dcm.mime, 'application/dicom');
    assert.equal(dcm.category, 'xray');
    assert.equal(dcm.taken_at, '2026-09-20');
    assert.match(dcm.notes, /Imported from Op 2/);
    assert.equal(docs.find((d) => d.filename === 'IMG_0042.jpg').mime, 'image/jpeg');

    // An image labelled for a different patient than the one opened here is never guessed.
    const other = (await api.post('/patients', { first_name: 'Otto', last_name: 'Other', dob: '1970-01-01' })).data;
    const upload = (query, body) => fetch(`${h.origin}/api/bridge/images?${new URLSearchParams(query)}`, { method: 'POST', headers: { Authorization: `Bridge ${created.data.token}`, 'Content-Type': 'application/octet-stream' }, body });
    const conflict = await upload({ filename: 'other.dcm' }, buildDicom({ patientId: String(other.id), studyDate: '20260920', modality: 'IO' }));
    assert.equal(conflict.status, 202, 'held for a person to file');
    const queued = await conflict.json();
    assert.equal(queued.queued, true);
    assert.match(queued.reason, /Labelled for patient/);
    assert.equal((await api.get(`/patients/${other.id}/documents`)).data.length, 0);
    // Staff file it from the queue into the right chart.
    const unfiled = (await api.get('/imaging/unfiled')).data;
    assert.equal(unfiled.length, 1);
    assert.equal(unfiled[0].workstation, 'Op 2');
    assert.equal((await fetch(`${h.origin}/api/imaging/unfiled/${unfiled[0].id}/image`, { headers: { Authorization: `Bearer ${token}` } })).status, 415, 'a DICOM with no pixels has no preview (the file itself is kept)');
    const filed = await api.post('/imaging/unfiled/file', { ids: [unfiled[0].id], patient_id: other.id });
    assert.equal(filed.status, 200);
    assert.equal((await api.get(`/patients/${other.id}/documents`)).data.length, 1);
    assert.equal((await api.get('/imaging/unfiled')).data.length, 0);
    assert.equal((await api.post('/imaging/unfiled/file', { ids: [unfiled[0].id], patient_id: other.id })).status, 409, 'already filed');
    // Agreeing labels are fine.
    const agree = await upload({ filename: `P${patient.id}_pa.jpg`, patient_id: String(patient.id) }, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80)]));
    assert.equal(agree.status, 201);
    assert.equal((await agree.json()).patient_id, patient.id);

    // Revoked keys stop working.
    await api.del(`/imaging/agents/${agents[0].id}`);
    const res = await fetch(`${h.origin}/api/bridge/commands?wait=0`, { headers: { Authorization: `Bridge ${created.data.token}` } });
    assert.equal(res.status, 401);
  } catch (err) {
    err.message += `\nagent output:\n${out}`;
    throw err;
  } finally {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sensor capture: the bridge takes exposures straight into a mount, then stops when it is full', async () => {
  const { api, patient } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Op 3' })).data;
  const dir = mkdtempSync(join(tmpdir(), 'dm-sensor-'));
  // A stand-in TWAIN acquire command: writes one small PNG (a different one each time) to {output}.
  const png = 'Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from(String(Date.now() + Math.random()))])';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    server: h.origin, token: created.token, scanSeconds: 5,
    sensor: { name: 'Test sensor', mode: 'command', command: process.execPath, args: ['-e', `require("fs").writeFileSync(process.argv[1], ${png})`, '{output}'], extension: 'png' },
  }));
  const agent = spawn(process.execPath, [agentPath, join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  agent.stderr.on('data', (d) => (out += d));
  try {
    const ws = await waitFor(async () => (await api.get('/imaging/agents')).data.find((a) => a.name === 'Op 3' && a.online && a.sensor));
    assert.equal(ws.sensor, 'Test sensor');
    assert.equal((await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, template: 'nope' })).status, 400);

    const cap = await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, template: 'bw4' });
    assert.equal(cap.status, 201, JSON.stringify(cap.data));
    const mount = await waitFor(async () => {
      const m = (await api.get(`/patients/${patient.id}/mounts`)).data.find((x) => x.id === cap.data.mount_id);
      return Object.keys(m.slots).length === 4 ? m : null;
    }, 20_000);
    assert.deepEqual(Object.keys(mount.slots).sort(), ['0', '1', '2', '3']);
    const docs = (await api.get(`/patients/${patient.id}/documents`)).data;
    assert.equal(docs.filter((d) => d.category === 'xray' && d.mime === 'image/png').length, 4);
    const done = await waitFor(async () => {
      const c = (await api.get(`/imaging/commands/${cap.data.id}`)).data;
      return c.status === 'done' ? c : null;
    });
    assert.match(done.result, /Mount complete/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api.get(`/patients/${patient.id}/documents`)).data.length, 4, 'no exposures after the mount is full');

    // A full mount can't be captured into again; a stopped capture rejects further images.
    assert.equal((await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, mount_id: mount.id })).status, 409);
    const upload = (q) => fetch(`${h.origin}/api/bridge/images?${new URLSearchParams(q)}`, { method: 'POST', headers: { Authorization: `Bridge ${created.token}` }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) });
    assert.equal((await upload({ filename: 'late.png', capture_id: cap.data.id })).status, 409);
  } catch (err) {
    err.message += `\nagent output:\n${out}`;
    throw err;
  } finally {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sensor capture: stopping from the chart ends it; workstations without a sensor are refused', async () => {
  const { api, patient } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Op 4' })).data;
  const bridge = (method, path, body) => fetch(`${h.origin}/api/bridge${path}`, { method, headers: { Authorization: `Bridge ${created.token}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
  await bridge('POST', '/hello', { apps: [], hostname: 'op4' });
  const ws = (await api.get('/imaging/agents')).data.find((a) => a.name === 'Op 4');
  assert.equal((await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id })).status, 400, 'no sensor');

  await bridge('POST', '/hello', { apps: [], sensor: { name: 'Folder sensor', mode: 'folder' } });
  const cap = (await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, template: 'fmx18' })).data;
  const cmds = await (await bridge('GET', '/commands?wait=0')).json();
  assert.equal(cmds[0].type, 'capture');
  assert.equal(cmds[0].total, 18);
  const img = await bridge('POST', `/images?filename=img1.png&capture_id=${cap.id}`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
  assert.equal(img.status, 201);
  assert.deepEqual([(await img.json()).slot, 17], [0, 17]);
  assert.deepEqual(await (await bridge('GET', `/captures/${cap.id}`)).json(), { active: true, filled: 1, total: 18 });

  await api.post(`/imaging/commands/${cap.id}/stop`);
  assert.equal((await (await bridge('GET', `/captures/${cap.id}`)).json()).active, false);
  assert.equal((await bridge('POST', `/images?filename=img2.png&capture_id=${cap.id}`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 8, 8]))).status, 409);

  // Captures only take images for their own patient.
  const cap2 = (await api.post(`/patients/${patient.id}/imaging/capture`, { agent_id: ws.id, mount_id: cap.mount_id })).data;
  await bridge('GET', '/commands?wait=0');
  const other = (await api.post('/patients', { first_name: 'Otto', last_name: 'Other', dob: '1970-01-01' })).data;
  assert.equal((await bridge('POST', `/images?filename=P${other.id}_x.png&patient_id=${other.id}&capture_id=${cap2.id}`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]))).status, 422);
});
