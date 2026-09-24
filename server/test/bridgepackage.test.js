import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import bridgePackageRoutes from '../src/routes/bridgepackage.js';
import { loadPresets } from '../src/bridgepackage.js';
import { buildZip, readZip } from '../src/zip.js';

const h = harness();
const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), '../../bridge');
const agentPath = join(bridgeDir, 'dental-machine-bridge.mjs');

// The package routes on their own signed-in router (the same way app.js mounts them), sharing the harness's
// database and sign-in secret, so these tests don't depend on app.js having been wired up yet.
let pkgOrigin;
let pkgServer;
before(async () => {
  const app = express();
  app.use(express.json());
  // Built on first use: the harness opens its database in its own before() hook.
  let api = null;
  app.use('/api', (req, res, next) => {
    if (!api) {
      api = express.Router();
      api.use(authenticate(h.db, 'test-secret'));
      api.use(bridgePackageRoutes({ db: h.db, config: h.config }));
    }
    api(req, res, next);
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { pkgServer = app.listen(0, resolve); });
  pkgOrigin = `http://127.0.0.1:${pkgServer.address().port}`;
});
after(() => pkgServer?.close());

const pkgCall = async (token, method, path, body) => {
  const res = await fetch(`${pkgOrigin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = buf;
  if (/json/.test(res.headers.get('content-type') || '')) data = JSON.parse(buf.toString('utf8'));
  return { status: res.status, data, headers: res.headers };
};
const unpack = (zip) => Object.fromEntries(readZip(zip).map((f) => [f.name.replace(/^[^/]+\//, ''), f]));
const runBridge = (cfg, args, cwd) => new Promise((done) => {
  let out = '';
  const p = spawn(process.execPath, [agentPath, cfg, ...args], { cwd });
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => done({ code, out }));
});
const PLACEHOLDERS = ['patientId', 'firstName', 'lastName', 'preferredName', 'dob', 'dobYMD', 'dobMDY', 'dobDMY', 'dobDotted', 'gender', 'bridgeFile'];

test('presets: every imaging program preset loads and has what the bridge and the wizard need', () => {
  const presets = loadPresets();
  assert.ok(presets.length >= 20, `${presets.length} presets`);
  const ids = new Set();
  const names = new Set();
  for (const p of presets) {
    const where = `preset ${p.id}`;
    assert.match(p.id, /^[a-z0-9_]+$/, where);
    assert.ok(!ids.has(p.id), `${where}: duplicate id`);
    ids.add(p.id);
    for (const a of p.aliases || []) {
      assert.ok(!names.has(a), `${where}: alias ${a} used twice`);
      names.add(a);
    }
    for (const k of ['name', 'vendor', 'initials', 'handoff', 'comment']) assert.equal(typeof p[k], 'string', `${where}: ${k}`);
    assert.ok(p.initials.length >= 1 && p.initials.length <= 3, `${where}: initials`);
    assert.ok(['args', 'file', 'file+args', 'none'].includes(p.handoff), `${where}: handoff`);
    assert.equal(typeof p.verify, 'boolean', `${where}: verify`);
    assert.match(p.comment, /^Known: /, `${where}: says what is known`);
    if (p.verify) assert.match(p.comment, /Assumed: /, `${where}: an unverified preset says what is assumed`);
    assert.ok(Array.isArray(p.args), `${where}: args`);
    if (p.handoff.includes('args')) assert.ok(p.args.length, `${where}: args hand-off with no args`);
    if (p.handoff.includes('file')) assert.ok(p.writeFile?.path && p.writeFile?.content, `${where}: file hand-off with no writeFile`);
    if (p.needsCommand) assert.equal(p.command, '', `${where}: the office fills in the command`);
    else if (p.handoff !== 'none' || p.command) assert.match(p.command, /^[A-Z]:\\.+\.exe$/i, `${where}: command`);
    for (const c of p.commandCandidates || []) assert.match(c, /^[A-Z]:\\.+\.exe$/i, `${where}: candidate ${c}`);
    assert.ok(Array.isArray(p.watch) && p.watch.length, `${where}: export folder`);
    for (const w of p.watch) {
      assert.match(w.folder, /^C:\\DentalMachine\\Export\\/, `${where}: export folder under C:\\DentalMachine`);
      assert.ok(['xray', 'photo'].includes(w.category), `${where}: category`);
    }
    for (const text of [...p.args, p.writeFile?.content || '']) {
      for (const [, k] of text.matchAll(/\{(\w+)\}/g)) assert.ok(PLACEHOLDERS.includes(k), `${where}: unknown placeholder {${k}}`);
    }
  }
  for (const a of names) assert.ok(!ids.has(a), `alias ${a} shadows a preset id`);
  // The programs offices ask for most.
  for (const id of ['dexis', 'dexis10', 'sidexis4', 'cs_imaging8', 'carestream_rvg', 'romexis', 'xrayvision', 'xvweb', 'vixwin', 'schick_cdr', 'dolphin', 'mipacs', 'tigerview', 'patterson_imaging', 'dentrix_imaging', 'ezdent_i', 'progeny', 'quickvision', 'cliniview', 'generic_patient_id']) {
    assert.ok(ids.has(id), `missing preset ${id}`);
  }
  assert.ok(names.has('eaglesoft') && names.has('planmeca'), 'Eaglesoft and Planmeca names find their presets');
});

test('zip writer: entries read back with their contents and Unix permissions', () => {
  const zip = buildZip([{ name: 'a/one.txt', data: 'hello' }, { name: 'a/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }]);
  const files = readZip(zip);
  assert.deepEqual(files.map((f) => [f.name, f.data.toString(), f.mode]), [['a/one.txt', 'hello', 0o644], ['a/run.sh', '#!/bin/sh\n', 0o755]]);
  assert.throws(() => buildZip([{ name: '../evil', data: 'x' }]));
});

test('install package: admin-only, made right after adding the workstation, carries the key and the choices, audited', async () => {
  const { api, token } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Op 2' })).data;
  const body = {
    token: created.token, server: 'https://office.example.com/ignored-path',
    apps: [{ preset: 'dexis' }, { preset: 'eaglesoft' }, { preset: 'generic_patient_id', command: 'C:\\Imaging\\Viewer.exe' }],
    sensor: { preset: 'tuxedo', kvp: 70, ma: 7 },
  };
  const res = await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, body);
  assert.equal(res.status, 200, String(res.data.error || ''));
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /DentalMachine-Bridge-Op-2\.zip/);
  const files = unpack(res.data);
  assert.deepEqual(Object.keys(files).sort(), ['SETUP.txt', 'bridge-config.json', 'dental-machine-bridge.mjs', 'install.cmd', 'install.ps1', 'install.sh', 'presets.json', 'run-bridge.ps1', 'uninstall.cmd', 'uninstall.ps1']);
  const cfg = JSON.parse(files['bridge-config.json'].data.toString());
  assert.equal(cfg.token, created.token, 'the one-time key is in the package');
  assert.equal(cfg.server, 'https://office.example.com');
  assert.equal(cfg.workstation, 'Op 2');
  assert.deepEqual(cfg.apps, [{ preset: 'dexis' }, { preset: 'patterson_imaging' }, { preset: 'generic_patient_id', command: 'C:\\Imaging\\Viewer.exe' }]);
  assert.deepEqual(cfg.sensor, { preset: 'tuxedo', exposure: { kvp: 70, ma: 7 } });
  assert.equal(files['dental-machine-bridge.mjs'].data.toString(), readFileSync(agentPath, 'utf8'));
  assert.equal(files['install.sh'].mode, 0o755);
  assert.match(files['install.cmd'].data.toString(), /\r\n/, 'Windows scripts use CRLF');
  assert.doesNotMatch(files['install.ps1'].data.toString().replace(/\r\n/g, ''), /\n/);
  assert.match(files['install.ps1'].data.toString(), /Register-ScheduledTask/);
  assert.match(files['SETUP.txt'].data.toString(), /Op 2[\s\S]*C:\\DentalMachine\\Export\\DEXIS[\s\S]*Not yet confirmed/);

  // Audited, without the key.
  const rows = await h.db.all("SELECT * FROM audit_log WHERE action = 'bridge.package' AND entity_id = ?", created.id);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0].details, /dmb_/);
  assert.deepEqual(JSON.parse(rows[0].details).apps, ['dexis', 'patterson_imaging', 'generic_patient_id']);
  assert.equal(rows[0].user_id != null, true);

  // Bad choices are refused with a plain reason.
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, apps: [{ preset: 'nope' }] })).status, 400);
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, apps: [{ preset: 'generic_patient_id' }] })).status, 400, 'needs the program path');
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, apps: [{ preset: 'dexis', command: 'calc"&del' }] })).status, 400);
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, apps: [], sensor: null })).status, 400);
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, sensor: { preset: 'tuxedo', kvp: 500 } })).status, 400);

  // Only with this workstation's own key: nobody can mint a package (and so a key) later.
  const wrong = await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, token: 'dmb_not-the-key' });
  assert.equal(wrong.status, 403);
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, { ...body, token: undefined })).status, 403);
  assert.equal((await h.db.all("SELECT id FROM audit_log WHERE action = 'bridge.package_refused' AND entity_id = ?", created.id)).length, 2);
  // ...and only while the setup is fresh.
  await h.db.run('UPDATE bridge_agents SET created_at = ? WHERE id = ?', new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19).replace('T', ' '), created.id);
  const stale = await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, body);
  assert.equal(stale.status, 410);
  assert.match(stale.data.error, /add it again/);

  // Administrators only.
  await api.post('/users', { email: `dentist-${Date.now()}@example.com`, name: 'Dr. D', role: 'dentist', password: 'dentist-password-1' });
  const dentistUser = (await api.get('/users')).data.find((u) => u.role === 'dentist');
  const dentistToken = (await h.client().post('/auth/login', { email: dentistUser.email, password: 'dentist-password-1' })).data.token;
  const fresh = (await api.post('/imaging/agents', { name: 'Op 3' })).data;
  assert.equal((await pkgCall(dentistToken, 'POST', `/imaging/agents/${fresh.id}/package`, { ...body, token: fresh.token })).status, 403);
  assert.equal((await pkgCall(dentistToken, 'GET', '/imaging/presets')).status, 200, 'the preset list itself is not sensitive');
  const presetsFile = await pkgCall(dentistToken, 'GET', '/imaging/presets-download');
  assert.equal(presetsFile.status, 200);
  assert.ok(presetsFile.data.presets.length >= 20);

  // Another practice can't make a package for this workstation, even holding its key.
  const other = await h.practice();
  assert.equal((await pkgCall(other.token, 'POST', `/imaging/agents/${fresh.id}/package`, { ...body, token: fresh.token })).status, 404);
  // A removed workstation gets no package.
  await api.del(`/imaging/agents/${fresh.id}`);
  assert.equal((await pkgCall(token, 'POST', `/imaging/agents/${fresh.id}/package`, { ...body, token: fresh.token })).status, 409);
});

test('install package for macOS/Linux: the real bridge passes --check with the preset config it contains', async () => {
  const { api, token } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Mac Op' })).data;
  const res = await pkgCall(token, 'POST', `/imaging/agents/${created.id}/package`, {
    token: created.token, platform: 'linux', apps: [{ preset: 'generic_patient_id', command: process.execPath }, { preset: 'folder_only' }],
  });
  assert.equal(res.status, 200, String(res.data.error || ''));
  const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-pkg-'));
  try {
    for (const f of readZip(res.data)) {
      const path = join(dir, f.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.data, { mode: f.mode });
    }
    const root = join(dir, 'DentalMachine-Bridge-Mac-Op');
    assert.ok(statSync(join(root, 'install.sh')).mode & 0o100, 'install.sh is executable');
    const cfg = JSON.parse(readFileSync(join(root, 'bridge-config.json'), 'utf8'));
    assert.deepEqual(cfg.apps[1].watch, [{ folder: 'Export/Photos', category: 'photo', create: true }], 'folders next to the bridge on a Mac/Linux PC');
    // Run from elsewhere: relative folders are taken from the config's folder, not the working directory.
    const { code, out } = await runBridge(join(root, 'bridge-config.json'), ['--check'], tmpdir());
    assert.equal(code, 0, out);
    assert.match(out, /OK {3}Other program: patient number on the command line: program/);
    assert.ok(out.includes(`OK   Watch folder ${join(root, 'Export', 'Imaging')}`), out);
    assert.ok(existsSync(join(root, 'Export', 'Photos')), 'the export folder was made');
    assert.doesNotMatch(out, /NOTE/, 'generic presets need no confirming');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge --check with presets: unknown presets fail, unconfirmed flags are noted, old-style apps still work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-presets-'));
  try {
    const cfg = join(dir, 'bridge-config.json');
    writeFileSync(cfg, JSON.stringify({
      server: 'http://127.0.0.1:9', token: 'dmb_x',
      apps: [
        { preset: 'vixwin', command: process.execPath, watch: [{ folder: join(dir, 'vix'), create: true }] },
        { preset: 'no-such-program' },
        { id: 'old', name: 'Old style', command: join(dir, 'missing.exe') },
      ],
    }));
    const { code, out } = await runBridge(cfg, ['--check'], dir);
    assert.equal(code, 1, out);
    assert.match(out, /FAIL Imaging program "no-such-program" — No preset called/);
    assert.match(out, /OK {3}VixWin: program/);
    assert.match(out, /FAIL Old style: program — Not found/);
    assert.match(out, /NOTE VixWin: the preset's command-line options are unconfirmed/);
    assert.ok(existsSync(join(dir, 'vix')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge with a preset: "Open in" fills the preset\'s arguments and bridge file, overrides win', async () => {
  const { api, patient } = await h.practice();
  const created = (await api.post('/imaging/agents', { name: 'Op 7' })).data;
  const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-launch-'));
  const marker = join(dir, 'launched.txt');
  const handoff = join(dir, 'handoff', 'patient.ini');
  // A presets file with a stand-in program that records how it was started.
  writeFileSync(join(dir, 'my-presets.json'), JSON.stringify({
    presets: [
      { id: 'fake', name: 'Fake Imaging', handoff: 'file+args', command: '/nowhere/fake.exe', args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv.slice(2).join("|"))', marker, '@{bridgeFile}', '{dobDotted}', '{dobDMY}'], writeFile: { path: handoff, content: '[Patients]\nPN={patientId}\nLN={lastName}\n' }, watch: [{ folder: join(dir, 'export'), category: 'xray' }] },
      { id: 'folder', name: 'Folder', handoff: 'none', launchable: false, args: [], watch: [{ folder: join(dir, 'photos'), category: 'photo' }] },
    ],
  }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    server: h.origin, token: created.token, presetsFile: 'my-presets.json',
    apps: [{ preset: 'fake', command: process.execPath }, { preset: 'folder' }],
  }));
  const agent = spawn(process.execPath, [agentPath, join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  agent.stdout.on('data', (d) => (out += d));
  agent.stderr.on('data', (d) => (out += d));
  const waitFor = async (fn, ms = 10_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    const ws = await waitFor(async () => (await api.get('/imaging/agents')).data.find((a) => a.id === created.id && a.online && a.apps.length));
    assert.deepEqual(ws.apps, [{ id: 'fake', name: 'Fake Imaging' }], 'folder-only presets are not offered as "Open in"');
    assert.ok(ws.checks.find((c) => c.name === `Watch folder ${join(dir, 'photos')}`)?.ok, 'preset export folders are created and watched');
    const launch = await api.post(`/patients/${patient.id}/imaging/launch`, { agent_id: created.id, app: 'fake' });
    assert.equal(launch.status, 201, JSON.stringify(launch.data));
    await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').length > 0);
    assert.equal(readFileSync(marker, 'utf8'), `@${handoff}|12.04.1985|12/04/1985`);
    assert.equal(readFileSync(handoff, 'utf8'), `[Patients]\nPN=${patient.id}\nLN=Doe\n`);
  } catch (err) {
    err.message += `\nagent output:\n${out}`;
    throw err;
  } finally {
    agent.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
