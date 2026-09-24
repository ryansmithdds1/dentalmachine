#!/usr/bin/env node
// Dental Machine imaging bridge — runs on each operatory PC (Windows, macOS or Linux, Node 18+).
//  • "Open in DEXIS" (etc.) from the chart launches your imaging program with the patient.
//  • New images in your imaging program's export folders are uploaded to the patient's chart.
//  • "Capture from sensor" in the chart takes x-rays straight from the sensor into a mount, through a
//    TWAIN/WIA acquire command (e.g. NAPS2's console) or the folder the sensor driver saves to.
//    Presets for Tuxedo and Jazz sensors fill in the TWAIN details: "sensor": { "preset": "tuxedo" }.
//  • It checks its own setup (programs, folders, sensor, uploads) and reports problems to Settings → Imaging
//    bridges and Needs attention every 10 minutes. `--check` prints the same checks and exits.
// Usage: node dental-machine-bridge.mjs bridge-config.json [--list-sensors | --check]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const VERSION = '1.3.0';
const configPath = resolve(process.argv[2] || 'bridge-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = String(config.server || '').replace(/\/$/, '');
if (!server || !String(config.token || '').startsWith('dmb_')) {
  console.error('bridge-config.json needs "server" (your Dental Machine address) and "token" (from Settings → Imaging bridges).');
  process.exit(1);
}
const statePath = resolve(dirname(configPath), config.stateFile || 'bridge-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { seen: {} };
const saveState = () => writeFileSync(statePath, JSON.stringify(state));
const pollSeconds = Number(config.scanSeconds) || 5;
const log = (...a) => console.log(new Date().toISOString(), ...a);
let lastPatient = null;
// Upload results since the last report, for the self-check.
const uploads = { ok: 0, failed: 0, lastError: null };

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${server}/api/bridge${path}`, {
    method, headers: { Authorization: `Bridge ${config.token}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, details: data.details });
  return data;
};

// Fills {placeholders} in command-line arguments and bridge files.
const fill = (template, p) => String(template).replace(/\{(\w+)\}/g, (_, k) => ({
  patientId: p.id, firstName: p.first_name, lastName: p.last_name, preferredName: p.preferred_name || p.first_name,
  dob: p.dob || '', dobYMD: (p.dob || '').replace(/-/g, ''), dobMDY: p.dob ? `${p.dob.slice(5, 7)}/${p.dob.slice(8, 10)}/${p.dob.slice(0, 4)}` : '',
  gender: { female: 'F', male: 'M' }[p.gender] || 'U',
})[k] ?? '');

function launch(cmd) {
  const app = (config.apps || []).find((a) => a.id === cmd.app);
  if (!app) throw new Error(`No imaging program "${cmd.app}" in bridge-config.json`);
  // Some programs read the patient from a small file ("bridge file") instead of the command line.
  if (app.writeFile) {
    mkdirSync(dirname(app.writeFile.path), { recursive: true });
    writeFileSync(app.writeFile.path, fill(app.writeFile.content, cmd.patient), app.writeFile.encoding || 'latin1');
  }
  if (app.command) {
    const child = spawn(fill(app.command, cmd.patient), (app.args || []).map((a) => fill(a, cmd.patient)), { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => log('launch failed:', err.message));
    child.unref();
  }
  lastPatient = { id: cmd.patient.id, at: Date.now() };
  return `${app.name} opened for ${cmd.patient.first_name} ${cmd.patient.last_name}`;
}

async function commandLoop() {
  for (;;) {
    try {
      const commands = await call('GET', '/commands?wait=25');
      for (const cmd of commands) {
        let result;
        try {
          if (cmd.type === 'capture') {
            capture(cmd); // runs until the mount is full or it's stopped from the chart; reports its own result
            continue;
          }
          if (cmd.type === 'sensor_test') {
            testSensor(cmd);
            continue;
          }
          result = { ok: true, message: cmd.type === 'launch' ? launch(cmd) : `Unknown command ${cmd.type}` };
        } catch (err) {
          result = { ok: false, message: err.message };
        }
        log(result.message);
        await call('POST', `/commands/${cmd.id}/result`, result).catch(() => {});
      }
    } catch (err) {
      log('server unreachable:', err.message);
      if (err.status === 401) process.exit(1);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---- Direct sensor capture ----
// "command" mode runs an acquire command once per exposure; it writes the image to {output} and exits
// (NAPS2.Console with the TWAIN or WIA driver, scanimage, or the sensor vendor's own CLI).
// "folder" mode picks up whatever the sensor driver saves into a folder while the capture is running.
// Sensor presets: the TWAIN source is found by name among the devices NAPS2 lists, so the config only
// needs "preset" (plus "device" if the office has two sensors of the same brand on one PC).
const NAPS2 = process.platform === 'win32' ? 'C:\\Program Files\\NAPS2\\NAPS2.Console.exe' : 'naps2.console';
const SENSOR_PRESETS = {
  tuxedo: { name: 'Tuxedo sensor', match: /tuxedo|denterprise/i },
  jazz: { name: 'Jazz sensor', match: /jazz/i },
  twain: { name: 'TWAIN sensor', match: null },
};
const listTwain = (naps2) => new Promise((done) => {
  let out = '';
  const child = spawn(naps2, ['--listdevices', '--driver', 'twain'], { windowsHide: true });
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => done(null));
  child.on('exit', () => done(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
});
async function resolveSensor(raw) {
  if (!raw) return null;
  const preset = SENSOR_PRESETS[String(raw.preset || '').toLowerCase()];
  if (!preset) return raw;
  const naps2 = raw.command || NAPS2;
  let device = raw.device;
  if (!device) {
    const devices = await listTwain(naps2);
    if (!devices) log(`Sensor: couldn't run ${naps2} — install NAPS2 (naps2.com) or set "command"`);
    device = devices?.find((d) => (preset.match ? preset.match.test(d) : true));
    if (devices && !device) log(`Sensor: no ${preset.name} among the TWAIN devices (${devices.join(', ') || 'none'}). Install the sensor's TWAIN driver, or set "device".`);
  }
  return {
    mode: 'command', extension: 'png', timeoutSeconds: 180, ...raw, name: raw.name || (device ? `${preset.name} (${device})` : preset.name), preset: raw.preset, device: device || null,
    command: naps2, args: raw.args || ['-o', '{output}', '--noprofile', '--driver', 'twain', '--device', device || preset.name, '--force'],
  };
}
if (process.argv.includes('--list-sensors')) {
  const devices = await listTwain(config.sensor?.command || NAPS2);
  console.log(devices ? `TWAIN devices on this PC:\n  ${devices.join('\n  ') || '(none — install the sensor\'s TWAIN driver)'}` : 'NAPS2 is not installed (naps2.com), or set sensor.command in bridge-config.json');
  process.exit(0);
}
const sensor = await resolveSensor(config.sensor || null);
let capturing = null;
const progress = (cmd, state, message) => call('POST', `/commands/${cmd.id}/progress`, { state, message }).catch(() => {});
const run = (command, args) => new Promise((resolveRun) => {
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  const timer = setTimeout(() => child.kill(), (Number(sensor.timeoutSeconds) || 120) * 1000);
  child.on('error', (err) => { clearTimeout(timer); resolveRun({ ok: false, message: err.message }); });
  child.on('exit', (code) => { clearTimeout(timer); resolveRun({ ok: code === 0, message: `exit code ${code}` }); });
});
const stable = (path) => {
  try {
    const st = statSync(path);
    return st.isFile() && Date.now() - st.mtimeMs > 1000 ? st : null;
  } catch {
    return null;
  }
};

async function sendCaptured(cmd, path) {
  const data = readFileSync(path);
  const params = new URLSearchParams({ filename: basename(path), capture_id: cmd.id });
  if (sensor.size) params.set('size', sensor.size);
  return call('POST', `/images?${params}`, data, { 'Content-Type': 'application/octet-stream' });
}

async function capture(cmd) {
  if (capturing) await call('POST', `/commands/${capturing}/result`, { ok: true, message: 'Replaced by a new capture' }).catch(() => {});
  capturing = cmd.id;
  const who = `${cmd.patient.first_name} ${cmd.patient.last_name}`;
  log(`Capturing ${cmd.total} images for ${who} with ${sensor?.name || 'the sensor'}`);
  const finish = (ok, message) => {
    if (capturing === cmd.id) capturing = null;
    log(message);
    return call('POST', `/commands/${cmd.id}/result`, { ok, message }).catch(() => {});
  };
  if (!sensor) return finish(false, 'No sensor is set up in bridge-config.json');
  const status = () => call('GET', `/captures/${cmd.id}`).catch(() => ({ active: true }));
  const idleLimit = (Number(sensor.idleMinutes) || 20) * 60_000;
  let lastImage = Date.now();
  let failures = 0;
  const since = Date.now();
  const sent = new Set();
  let announced = null;
  while (capturing === cmd.id) {
    const s = await status();
    if (!s.active) return finish(true, `Capture for ${who} finished (${s.filled ?? '?'} of ${s.total ?? cmd.total})`);
    const next = s.target ? `spot ${s.target.slot + 1}${s.target.retake ? ' (retake)' : ''}` : `image ${(s.filled ?? 0) + 1} of ${s.total ?? cmd.total}`;
    if (announced !== next) {
      announced = next;
      progress(cmd, 'waiting', `Ready for ${next} — expose the sensor`);
    }
    if (Date.now() - lastImage > idleLimit) return finish(true, `Capture for ${who} stopped after ${sensor.idleMinutes || 20} idle minutes`);
    let files = [];
    if (sensor.mode === 'folder') {
      if (existsSync(sensor.folder)) {
        files = readdirSync(sensor.folder).map((n) => join(sensor.folder, n)).filter((p) => !sent.has(p)).filter((p) => {
          const st = stable(p);
          return st && st.mtimeMs >= since - 5000;
        }).sort();
      }
      if (!files.length) await new Promise((r) => setTimeout(r, 700));
    } else {
      const output = join(tmpdir(), `dm-capture-${cmd.id}-${Date.now()}.${sensor.extension || 'png'}`);
      const outcome = await run(fill(sensor.command, cmd.patient), (sensor.args || []).map((a) => fill(String(a).split('{output}').join(output), cmd.patient)));
      if (capturing !== cmd.id) return undefined;
      if (!outcome.ok || !existsSync(output)) {
        // A sensor that timed out waiting for an exposure just tries again; repeated errors give up.
        if (++failures >= (Number(sensor.maxFailures) || 3)) {
          progress(cmd, 'error', `Sensor capture failed (${outcome.message})`);
          return finish(false, `Sensor capture failed (${outcome.message}) — check the sensor is plugged in, then use Test sensor`);
        }
        progress(cmd, 'error', `No image from the sensor (${outcome.message}) — trying again`);
        announced = null;
        continue;
      }
      failures = 0;
      files = [output];
    }
    for (const path of files) {
      sent.add(path);
      try {
        progress(cmd, 'uploading', 'Image received — sending to the chart');
        announced = null;
        const out = await sendCaptured(cmd, path);
        lastImage = Date.now();
        log(`${basename(path)} → spot ${out.slot + 1} (${out.remaining} to go)`);
        if (sensor.mode === 'folder' && sensor.moveTo) {
          mkdirSync(sensor.moveTo, { recursive: true });
          renameSync(path, join(sensor.moveTo, basename(path)));
        } else if (sensor.mode !== 'folder') rmSync(path, { force: true });
      } catch (err) {
        if (err.details?.duplicate) log(`${basename(path)}: ${err.message}`);
        else if (err.status === 409) return finish(true, `Capture for ${who} was stopped`);
        log(`${basename(path)}: upload failed (${err.message})`);
        if (err.status >= 500 || !err.status) sent.delete(path); // retried on the next pass
      }
    }
  }
  return undefined;
}

// "Test sensor" from Settings: one acquire (or one new file in the capture folder) with no patient, and the
// picture goes back so the office can see the sensor, driver and bridge all work together.
async function testSensor(cmd) {
  const done = (ok, message) => {
    log(`Sensor test: ${message}`);
    return call('POST', `/commands/${cmd.id}/result`, { ok, message }).catch(() => {});
  };
  if (!sensor) return done(false, 'No sensor is set up in bridge-config.json');
  if (capturing) return done(false, 'A capture is running on this workstation — finish it first');
  let path = null;
  if (sensor.mode === 'folder') {
    if (!existsSync(sensor.folder)) return done(false, `The capture folder ${sensor.folder} doesn't exist`);
    progress(cmd, 'waiting', 'Take a test exposure in the sensor software (60 s)');
    const since = Date.now();
    while (!path && Date.now() - since < 60_000) {
      await new Promise((r) => setTimeout(r, 700));
      path = readdirSync(sensor.folder).map((n) => join(sensor.folder, n)).find((p) => {
        const st = stable(p);
        return st && st.mtimeMs >= since - 1000;
      }) || null;
    }
    if (!path) return done(false, `Folder ${sensor.folder} is there, but no image arrived in 60 s`);
  } else {
    progress(cmd, 'waiting', 'Expose the sensor now (or cover it and trigger for a dark frame)');
    const output = join(tmpdir(), `dm-sensor-test-${cmd.id}.${sensor.extension || 'png'}`);
    const outcome = await run(fill(sensor.command, {}), (sensor.args || []).map((a) => fill(String(a).split('{output}').join(output), {})));
    if (!outcome.ok || !existsSync(output)) return done(false, `No image from ${sensor.name || 'the sensor'} (${outcome.message}). Check the USB cable, the TWAIN driver, and "device" in bridge-config.json.`);
    path = output;
  }
  const data = readFileSync(path);
  progress(cmd, 'uploading', 'Sending the test image');
  await call('POST', `/commands/${cmd.id}/test-image`, data, { 'Content-Type': 'application/octet-stream' }).catch((err) => log('test image upload failed:', err.message));
  if (sensor.mode !== 'folder') rmSync(path, { force: true });
  return done(true, `${sensor.name || 'Sensor'} works — got a ${Math.round(data.length / 1024)} KB image`);
}

// Picks up new files from each watched folder once they've finished writing.
async function scan() {
  for (const w of config.watch || []) {
    if (!existsSync(w.folder)) continue;
    for (const name of readdirSync(w.folder)) {
      const path = join(w.folder, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || Date.now() - st.mtimeMs < 2000) continue;
      const key = `${path}|${st.size}|${Math.round(st.mtimeMs)}`;
      if (state.seen[key]) continue;
      const data = readFileSync(path);
      // "P123_bitewing.jpg" / "P123-pan.dcm" style names carry the chart number. The "P" is required by
      // default so capture timestamps ("20260923_1015.jpg") are never mistaken for a patient number.
      const idFromName = (new RegExp(w.patientIdPattern || '^[Pp](\\d+)[_\\-. ]').exec(basename(name)) || [])[1];
      const params = new URLSearchParams({ filename: name, category: w.category || 'xray' });
      if (idFromName) params.set('patient_id', idFromName);
      if (lastPatient && Date.now() - lastPatient.at < 45 * 60_000) params.set('opened_patient_id', lastPatient.id);
      try {
        const out = await call('POST', `/images?${params}`, data, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': createHash('sha256').update(data).digest('hex') });
        if (out.queued) log(`${name}: couldn't tell which patient (${out.reason}) — sent to Unfiled images for the office to file`);
        else log(`${name} → patient #${out.patient_id}${out.duplicate ? ' (already in chart)' : ''}`);
        state.seen[key] = out.queued ? `unfiled:${out.id}` : out.id;
        uploads.ok++;
        if (w.moveTo) {
          mkdirSync(w.moveTo, { recursive: true });
          renameSync(path, join(w.moveTo, name));
        }
      } catch (err) {
        if (err.details?.unmatched) {
          log(`${name}: couldn't tell which patient — open the patient from the chart first, or name the file "<chart#>_…"`);
          state.seen[key] = 'unmatched';
        } else {
          log(`${name}: upload failed (${err.message}); will retry`);
          uploads.failed++;
          uploads.lastError = `${name}: ${err.message}`.slice(0, 200);
          continue;
        }
      }
      saveState();
    }
  }
}

// ---- Self-check: is this PC set up the way bridge-config.json says? ----
const isPath = (p) => /[\\/]/.test(String(p || ''));
const canWrite = (dir) => {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.dm-bridge-check-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
};
function selfCheck() {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note: note || null });
  for (const a of config.apps || []) {
    if (a.command && isPath(a.command)) add(`${a.name || a.id}: program`, existsSync(a.command), existsSync(a.command) ? null : `Not found at ${a.command} — fix "command" in bridge-config.json`);
    if (a.writeFile?.path) add(`${a.name || a.id}: bridge file folder`, canWrite(dirname(a.writeFile.path)), `Can't write to ${dirname(a.writeFile.path)}`);
  }
  for (const w of config.watch || []) {
    let readable = false;
    try { readdirSync(w.folder); readable = true; } catch { /* missing or no access */ }
    add(`Watch folder ${w.folder}`, readable, readable ? null : "Folder missing or can't be read — check the imaging program's export setting");
    if (readable && w.moveTo) add(`Sent folder ${w.moveTo}`, canWrite(w.moveTo), `Can't write to ${w.moveTo}`);
  }
  if (sensor) {
    if (sensor.mode === 'folder') {
      add('Sensor folder', !!sensor.folder && canWrite(sensor.folder), `Sensor folder ${sensor.folder || '(not set)'} is missing or read-only`);
    } else {
      const found = !isPath(sensor.command) || existsSync(sensor.command);
      add('Sensor capture program', found, found ? null : `${sensor.command} not found — install NAPS2 (naps2.com) or fix "sensor.command"`);
      if (sensor.preset && found) add('Sensor connected', !!sensor.device, sensor.device ? null : 'The sensor did not show up among the TWAIN devices — plug it in, install its TWAIN driver, then restart the bridge');
    }
  }
  add('Bridge state file', canWrite(dirname(statePath)), `Can't save ${statePath}`);
  if (uploads.failed) add('Uploads', uploads.ok > 0, `${uploads.failed} failed since the last check (${uploads.lastError})`);
  return checks;
}
if (process.argv.includes('--check')) {
  const checks = selfCheck();
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok || !c.note ? '' : ` — ${c.note}`}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
const helloBody = () => ({
  apps: (config.apps || []).map((a) => ({ id: a.id, name: a.name })),
  sensor: sensor ? { name: sensor.name || 'Sensor', mode: sensor.mode || 'command', preset: sensor.preset || null, exposure: sensor.exposure || null, pixelSize: sensor.pixelSize || null, size: sensor.size ?? null } : null,
  hostname: hostname(), version: VERSION, checks: selfCheck(), uploads: { ok: uploads.ok, failed: uploads.failed },
});
const hello = await call('POST', '/hello', helloBody());
for (const c of hello.problems || []) log(`Setup problem: ${c.name} — ${c.note}`);
log(`Connected to ${hello.practice} as "${hello.workstation}". Programs: ${(config.apps || []).map((a) => a.name).join(', ') || 'none'}. Watching: ${(config.watch || []).map((w) => w.folder).join(', ') || 'nothing'}.${sensor ? ` Sensor: ${sensor.name || 'yes'}.` : ''}`);
// Report the self-check every 10 minutes, so a moved export folder or unplugged sensor shows up in the office.
setInterval(() => {
  call('POST', '/hello', helloBody()).then(() => { uploads.ok = 0; uploads.failed = 0; uploads.lastError = null; }).catch((err) => log('check-in failed:', err.message));
}, 10 * 60_000);
setInterval(() => scan().catch((err) => log('scan failed:', err.message)), pollSeconds * 1000);
scan().catch((err) => log('scan failed:', err.message));
commandLoop();
