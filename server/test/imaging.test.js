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
  const { api, patient } = await h.practice();
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
