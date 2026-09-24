#!/usr/bin/env node
// Dental Machine imaging bridge — runs on each operatory PC (Windows, macOS or Linux, Node 18+).
//  • "Open in DEXIS" (etc.) from the chart launches your imaging program with the patient.
//  • New images in your imaging program's export folders are uploaded to the patient's chart.
//  • "Capture from sensor" in the chart takes x-rays straight from the sensor into a mount, through a
//    TWAIN/WIA acquire command (e.g. NAPS2's console) or the folder the sensor driver saves to.
//    Presets for Tuxedo and Jazz sensors fill in the TWAIN details: "sensor": { "preset": "tuxedo" }.
//  • It checks its own setup (programs, folders, sensor, uploads) and reports problems to Settings → Imaging
//    bridges and Needs attention every 10 minutes. `--check` prints the same checks and exits.
//  • Imaging programs can be named by preset ("apps": [{ "preset": "dexis" }]) from presets.json next to this
//    file; any field set in bridge-config.json (command, args, writeFile, watch, name) overrides the preset's.
//    Apps written out in full, as before presets existed, keep working unchanged.
//  • Desk scanners: "Scan" in the chart scans on this PC's scanner ("scanner": { "driver": "auto" }) —
//    WIA on Windows (installer/scan.ps1), SANE's scanimage on macOS/Linux, or any command that writes page
//    images to a folder — makes one PDF and files it to the patient. Scan folders (ScanSnap, copiers that
//    "scan to folder"): a watch folder with "kind": "scan" files P<chart#>_… to that chart, the rest to the
//    scan inbox. See docs/documents.md.
// Usage: node dental-machine-bridge.mjs bridge-config.json [--list-sensors | --list-scanners | --check]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.5.0';
const configPath = resolve(process.argv[2] || 'bridge-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = String(config.server || '').replace(/\/$/, '');
if (!server || !String(config.token || '').startsWith('dmb_')) {
  console.error('bridge-config.json needs "server" (your Dental Machine address) and "token" (from Settings → Imaging bridges).');
  process.exit(1);
}
const statePath = resolve(dirname(configPath), config.stateFile || 'bridge-state.json');

// ---- Presets: "apps": [{ "preset": "dexis" }] fills in the program's path, arguments and bridge file ----
// A Windows path ("C:\…", "\\server\share") is absolute on every OS; other relative paths are taken from
// the folder bridge-config.json is in (the macOS/Linux installer writes "Export/…" folders that way).
const isAbsolutePath = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
// A Windows path on a Mac or Linux PC (a preset's default) can't be used there: never create it as a local folder.
const foreignPath = (p) => process.platform !== 'win32' && /^[A-Za-z]:[\\/]|^\\\\/.test(String(p || ''));
const fromConfigDir = (p) => (p && !isAbsolutePath(String(p)) ? resolve(dirname(configPath), String(p)) : p);
const setupProblems = []; // shown by --check and reported with the self-check
const setupNotes = []; // informational only (--check prints them; they never raise a Needs attention item)
function loadPresets() {
  const candidates = config.presetsFile ? [fromConfigDir(config.presetsFile)] : [join(dirname(fileURLToPath(import.meta.url)), 'presets.json'), join(dirname(configPath), 'presets.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const list = JSON.parse(readFileSync(file, 'utf8')).presets;
      if (Array.isArray(list)) return list;
    } catch (err) {
      setupProblems.push({ name: 'Imaging program presets', ok: false, note: `${file} can't be read (${err.message})` });
      return [];
    }
  }
  setupProblems.push({ name: 'Imaging program presets', ok: false, note: `presets.json not found next to the bridge (looked in ${candidates.join(', ')})` });
  return [];
}
function resolveApps() {
  const raw = Array.isArray(config.apps) ? config.apps : [];
  if (!raw.some((a) => a && a.preset)) return raw; // older configs: nothing to do
  const presets = loadPresets();
  const find = (key) => {
    const k = String(key).toLowerCase();
    return presets.find((p) => p.id === k || (p.aliases || []).includes(k));
  };
  const apps = [];
  const watch = [...(config.watch || [])];
  const sameFolder = (a, b) => String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
  for (const entry of raw) {
    if (!entry?.preset) {
      apps.push(entry);
      continue;
    }
    const p = find(entry.preset);
    if (!p) {
      setupProblems.push({ name: `Imaging program "${entry.preset}"`, ok: false, note: `No preset called "${entry.preset}" in presets.json — check the spelling, or write the program out in full` });
      continue;
    }
    // A preset's program may be installed in one of a few places: use the first that exists on this PC.
    const command = 'command' in entry ? entry.command : ((p.commandCandidates || []).find((c) => existsSync(c)) || p.command);
    const writeFile = entry.writeFile === false || (!p.writeFile && !entry.writeFile) ? undefined : { ...(p.writeFile || {}), ...(entry.writeFile || {}) };
    if (writeFile?.path) writeFile.path = fromConfigDir(writeFile.path);
    const args = (entry.args || p.args || []).map((a) => String(a).split('{bridgeFile}').join(writeFile?.path || ''));
    const app = { ...entry, id: entry.id || p.id, name: entry.name || p.name, preset: p.id, command: command || undefined, args, writeFile, launchable: entry.launchable ?? p.launchable ?? true };
    apps.push(app);
    if (p.verify && !entry.verified) setupNotes.push(`${app.name}: the preset's command-line options are unconfirmed for your version — open a test patient from the chart once; if the patient doesn't open, fix "args"/"writeFile" (see presets.json "comment")`);
    if (p.needsCommand && !app.command) setupProblems.push({ name: `${app.name}: program`, ok: false, note: 'Set "command" to the program\'s .exe in bridge-config.json' });
    // The preset's export folders are watched too, unless the app says "watch": false or lists its own.
    if (entry.watch !== false) {
      for (const w of Array.isArray(entry.watch) ? entry.watch : p.watch || []) {
        if (!watch.some((x) => sameFolder(fromConfigDir(x.folder), fromConfigDir(w.folder)))) watch.push({ create: true, ...w });
      }
    }
  }
  config.watch = watch;
  return apps;
}
config.apps = resolveApps();
// Scan folders: "scanFolders": [{ "preset": "scansnap" }] or [{ "folder": "D:\\Scans" }] — paperwork a scanner saves there
// is filed to the chart named in the file (P<chart#>_…) or waits in the scan inbox.
for (const entry of Array.isArray(config.scanFolders) ? config.scanFolders : []) {
  const p = entry?.preset ? scanPreset(entry.preset) : null;
  if (entry?.preset && (!p || p.type !== 'folder')) {
    setupProblems.push({ name: `Scan folder "${entry.preset}"`, ok: false, note: `No scan-folder preset called "${entry.preset}" in presets.json` });
    continue;
  }
  const folder = entry.folder || p?.folder;
  if (!folder) continue;
  config.watch = [...(config.watch || []), { create: true, ...entry, folder, kind: 'scan' }];
}
for (const w of config.watch || []) {
  w.folder = fromConfigDir(w.folder);
  if (w.moveTo) w.moveTo = fromConfigDir(w.moveTo);
  // Export folders the installer or a preset named are made here, so the imaging program has somewhere to export to.
  if (w.create && w.folder && !foreignPath(w.folder) && !existsSync(w.folder)) {
    try { mkdirSync(w.folder, { recursive: true }); } catch { /* reported by the self-check */ }
  }
}
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
  dobDMY: p.dob ? `${p.dob.slice(8, 10)}/${p.dob.slice(5, 7)}/${p.dob.slice(0, 4)}` : '', dobDotted: p.dob ? `${p.dob.slice(8, 10)}.${p.dob.slice(5, 7)}.${p.dob.slice(0, 4)}` : '',
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
  // Programs with no outside hand-off: nothing opens, but images exported next are filed to this patient.
  if (!app.command && !app.writeFile) return `Ready for ${cmd.patient.first_name} ${cmd.patient.last_name} — images exported from ${app.name} on this computer go to their chart`;
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
          if (cmd.type === 'scan') {
            scanJob(cmd); // reports its own progress and result
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

// ---- Desk scanners ("Scan" in the chart) ----
// "scanner": { "driver": "auto" | "wia" | "sane" | "command", "device": "…", "name": "Front desk scanner" }
//  • wia     — Windows: installer/scan.ps1 drives the Windows Image Acquisition service (flatbed or feeder, duplex
//              when the scanner has it), one JPEG per page. UNTESTED on real hardware: written from the WIA 2.0
//              automation documentation; check with `--list-scanners` and one test scan.
//  • sane    — macOS/Linux: SANE's `scanimage` (brew install sane-backends / apt install sane-utils).
//              UNTESTED against real scanners: source names ("ADF", "ADF Duplex", "Flatbed") differ between
//              backends — set "sources": { "feeder": "…", "duplex": "…", "flatbed": "…" } to match `scanimage -A`.
//  • command — any program that scans: "command" + "args" with {dir} (write page files there, in page order),
//              {dpi}, {color} (color|gray|bw), {source} (auto|flatbed|feeder), {duplex} (1|0) and {device}.
// The pages become one PDF (JPEG pages are embedded as they are, so nothing is re-compressed) unless the chart
// asked for separate pictures, then go to the patient the scan was started for.
// scan.ps1 is looked for next to the bridge (installer/ or the same folder); install packages that don't carry
// it get the copy embedded at the end of this file, written out on first use.
const SCAN_PS1 = [join(dirname(fileURLToPath(import.meta.url)), 'installer', 'scan.ps1'), join(dirname(fileURLToPath(import.meta.url)), 'scan.ps1')].find((p) => existsSync(p))
  || join(tmpdir(), `dm-bridge-scan-${VERSION}.ps1`);
const ensureScanScript = () => {
  if (!existsSync(SCAN_PS1)) writeFileSync(SCAN_PS1, embeddedScanPs1().replace(/\n/g, '\r\n'));
  return SCAN_PS1;
};
const whichSync = (cmd) => {
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) for (const e of exts) if (d && existsSync(join(d, cmd + e))) return join(d, cmd + e);
  return null;
};
function scanPreset(id) {
  const file = [config.presetsFile ? fromConfigDir(config.presetsFile) : null, join(dirname(fileURLToPath(import.meta.url)), 'presets.json'), join(dirname(configPath), 'presets.json')].find((f) => f && existsSync(f));
  try {
    return (JSON.parse(readFileSync(file, 'utf8')).scanPresets || []).find((p) => p.id === String(id).toLowerCase()) || null;
  } catch {
    return null;
  }
}
function resolveScanner(raw) {
  if (!raw) return null;
  let r = typeof raw === 'string' ? { driver: raw } : { ...raw };
  if (r.preset) {
    const p = scanPreset(r.preset);
    if (!p || p.type !== 'device') setupProblems.push({ name: `Scanner "${r.preset}"`, ok: false, note: `No scanner preset called "${r.preset}" in presets.json` });
    else r = { driver: p.driver, device: p.device, name: p.name, ...r };
  }
  let driver = String(r.driver || 'auto').toLowerCase();
  if (driver === 'auto') driver = process.platform === 'win32' ? 'wia' : whichSync('scanimage') ? 'sane' : null;
  if (!driver) {
    setupProblems.push({ name: 'Scanner', ok: false, note: 'No scanner driver found: install SANE (scanimage), or set "scanner": { "driver": "command", … } in bridge-config.json' });
    return null;
  }
  if (driver === 'command' && !r.command) {
    setupProblems.push({ name: 'Scanner', ok: false, note: '"scanner.driver" is "command" but "scanner.command" is not set' });
    return null;
  }
  return {
    feeder: true, flatbed: true, duplex: driver !== 'command' ? true : !!r.duplex, timeoutSeconds: 300, ...r, driver,
    name: r.name || (r.device ? `${r.device}` : driver === 'wia' ? 'Scanner (WIA)' : driver === 'sane' ? 'Scanner (SANE)' : 'Scanner'),
    sources: { flatbed: 'Flatbed', feeder: 'ADF', duplex: 'ADF Duplex', ...(r.sources || {}) },
  };
}
const scannerCfg = resolveScanner(config.scanner || null);

const runProc = (command, args, { timeoutSeconds = 300, cwd } = {}) => new Promise((done) => {
  let out = '';
  let err = '';
  let child;
  try {
    child = spawn(command, args, { windowsHide: true, cwd });
  } catch (e) {
    done({ ok: false, code: null, out, err: e.message });
    return;
  }
  const timer = setTimeout(() => child.kill(), timeoutSeconds * 1000);
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { err += d; });
  child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: null, out, err: e.message }); });
  child.on('exit', (code) => { clearTimeout(timer); done({ ok: code === 0, code, out, err }); });
});

// Width, height and colour components of a JPEG (from its frame header), or null.
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7), components: buf[p + 9] };
    }
    p += 2 + len;
  }
  return null;
}

// One PDF from JPEG pages, each page sized from the scan's resolution (so a letter page prints as a letter page).
function jpegsToPdf(pages, dpi = 300) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const tree = add(null);
  const kids = [];
  for (const jpg of pages) {
    const info = jpegInfo(jpg);
    if (!info) throw new Error('A page is not a JPEG image');
    const w = (info.width / dpi) * 72;
    const h = (info.height / dpi) * 72;
    const space = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]));
    const draw = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
    const content = add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

// Runs the scanner into a fresh folder; → sorted page file paths (or throws with a message for the chart).
async function scanPages(opts, dir) {
  const s = scannerCfg;
  const color = opts.color || 'gray';
  const source = opts.source || 'auto';
  if (s.driver === 'wia') {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', s.script || ensureScanScript(), '-OutDir', dir, '-Source', source, '-Color', color, '-Dpi', String(opts.dpi || 300)];
    if (opts.duplex) args.push('-Duplex');
    if (s.device) args.push('-Device', s.device);
    const out = await runProc(s.powershell || 'powershell.exe', args, { timeoutSeconds: s.timeoutSeconds });
    if (!out.ok) throw new Error((out.err || out.out).split(/\r?\n/).filter(Boolean).pop() || `scan.ps1 failed (exit ${out.code})`);
  } else if (s.driver === 'sane') {
    const mode = { color: 'Color', gray: 'Gray', bw: 'Lineart' }[color];
    const args = ['--format=jpeg', `--resolution=${opts.dpi || 300}`, `--mode=${mode}`, `--batch=${join(dir, 'page-%03d.jpg')}`];
    if (s.device) args.unshift(`--device-name=${s.device}`);
    if (source === 'flatbed') args.push(`--source=${s.sources.flatbed}`, '--batch-count=1');
    else if (source === 'feeder') args.push(`--source=${opts.duplex ? s.sources.duplex : s.sources.feeder}`);
    else args.push('--batch-count=1');
    const out = await runProc(s.command || 'scanimage', args, { timeoutSeconds: s.timeoutSeconds });
    // scanimage ends a feeder batch with "Document feeder out of documents" (exit 7) once pages were read.
    if (!out.ok && !(out.code === 7 && readdirSync(dir).length)) throw new Error((out.err || out.out).split(/\r?\n/).filter(Boolean).pop() || `scanimage failed (exit ${out.code})`);
  } else {
    const fillScan = (a) => String(a).replace(/\{(\w+)\}/g, (m, k) => ({ dir, dpi: String(opts.dpi || 300), color, source, duplex: opts.duplex ? '1' : '0', device: s.device || '' })[k] ?? m);
    const out = await runProc(fillScan(s.command), (s.args || []).map(fillScan), { timeoutSeconds: s.timeoutSeconds });
    if (!out.ok) throw new Error((out.err || out.out).split(/\r?\n/).filter(Boolean).pop() || `The scan command failed (exit ${out.code})`);
  }
  const files = readdirSync(dir).filter((n) => /\.(jpe?g|png|tiff?|pdf)$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => join(dir, n));
  if (!files.length) throw new Error('The scanner didn’t produce any pages — is there paper in it?');
  return files;
}

async function scanJob(cmd) {
  const who = `${cmd.patient.first_name} ${cmd.patient.last_name}`;
  const opts = cmd.options || {};
  const finish = (ok, message) => {
    log(message);
    return call('POST', `/commands/${cmd.id}/result`, { ok, message }).catch(() => {});
  };
  if (!scannerCfg) return finish(false, 'No scanner is set up in bridge-config.json on this computer');
  const dir = join(tmpdir(), `dm-scan-${cmd.id}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    progress(cmd, 'waiting', `Scanning for ${who}${opts.source === 'feeder' ? ' from the feeder' : opts.source === 'flatbed' ? ' from the glass' : ''}…`);
    const files = await scanPages(opts, dir);
    const jpegs = files.map((f) => readFileSync(f));
    const allJpeg = jpegs.every((b) => jpegInfo(b));
    progress(cmd, 'uploading', `${files.length} page${files.length === 1 ? '' : 's'} scanned — sending to the chart`);
    if (opts.format !== 'jpg' && allJpeg) {
      const pdf = jpegsToPdf(jpegs, opts.dpi || 300);
      await call('POST', `/scans/${cmd.id}/file?${new URLSearchParams({ filename: 'scan.pdf' })}`, pdf, { 'Content-Type': 'application/pdf' });
    } else {
      // Separate pictures asked for, or pages that aren't JPEG (a PDF or PNG from the scan command): each as it is.
      for (const [i, f] of files.entries()) {
        await call('POST', `/scans/${cmd.id}/file?${new URLSearchParams({ filename: basename(f), ...(files.length > 1 ? { page: String(i + 1) } : {}) })}`, jpegs[i], { 'Content-Type': 'application/octet-stream' });
      }
    }
    return finish(true, `Scanned ${files.length} page${files.length === 1 ? '' : 's'} into ${who}’s chart`);
  } catch (err) {
    progress(cmd, 'error', `Scan failed: ${err.message}`);
    return finish(false, `Scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scannerBody = () => (scannerCfg ? {
  name: scannerCfg.name, driver: scannerCfg.driver, feeder: scannerCfg.feeder !== false, flatbed: scannerCfg.flatbed !== false, duplex: !!scannerCfg.duplex,
  color: scannerCfg.color !== false, dpis: scannerCfg.dpis || [150, 200, 300, 600],
} : { name: null });
if (process.argv.includes('--list-scanners')) {
  if (process.platform === 'win32') {
    const out = await runProc('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureScanScript(), '-List']);
    console.log(out.out || out.err || 'scan.ps1 printed nothing');
  } else if (whichSync('scanimage')) {
    const out = await runProc('scanimage', ['-L']);
    console.log(out.out || out.err);
  } else console.log('No scanner tools found: install SANE (scanimage) or set "scanner": { "driver": "command" } in bridge-config.json');
  process.exit(0);
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
      if (w.kind === 'scan') {
        // Paperwork from a scanner's folder: to the chart named in the file, else the scan inbox.
        const q = new URLSearchParams({ filename: name, ...(idFromName ? { patient_id: idFromName } : {}) });
        try {
          const out = await call('POST', `/scan-inbox?${q}`, data, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': createHash('sha256').update(data).digest('hex') });
          log(out.inbox ? `${name}: in the scan inbox for the office to file${out.reason ? ` (${out.reason})` : ''}` : `${name} → patient #${out.patient_id}${out.duplicate ? ' (already filed)' : ''}`);
          state.seen[key] = out.id;
          uploads.ok++;
          if (w.moveTo) {
            mkdirSync(w.moveTo, { recursive: true });
            renameSync(path, join(w.moveTo, name));
          }
        } catch (err) {
          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 404 && err.status !== 429) {
            log(`${name}: not accepted (${err.message}) — left in the folder`);
            state.seen[key] = 'refused';
          } else {
            log(`${name}: upload failed (${err.message}); will retry`);
            uploads.failed++;
            uploads.lastError = `${name}: ${err.message}`.slice(0, 200);
            continue;
          }
        }
        saveState();
        continue;
      }
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
  if (foreignPath(dir)) return false;
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
  const checks = [...setupProblems];
  const add = (name, ok, note) => checks.push({ name, ok, note: note || null });
  for (const a of config.apps || []) {
    if (a.command && isPath(a.command)) add(`${a.name || a.id}: program`, existsSync(a.command), existsSync(a.command) ? null : `Not found at ${a.command} — fix "command" in bridge-config.json`);
    if (a.writeFile?.path) {
      const folder = foreignPath(a.writeFile.path) ? a.writeFile.path.replace(/[\\/][^\\/]*$/, '') : dirname(a.writeFile.path);
      add(`${a.name || a.id}: bridge file folder`, canWrite(folder), `Can't write to ${folder}`);
    }
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
  if (scannerCfg) {
    if (scannerCfg.driver === 'wia' && scannerCfg.script) add('Scanner script', existsSync(scannerCfg.script), `${scannerCfg.script} is missing — fix "scanner.script" or remove it to use the built-in one`);
    else if (scannerCfg.driver === 'sane') add('Scanner (scanimage)', !!(scannerCfg.command ? existsSync(scannerCfg.command) || whichSync(scannerCfg.command) : whichSync('scanimage')), 'scanimage not found — install SANE (sane-utils / sane-backends)');
  }
  add('Bridge state file', canWrite(dirname(statePath)), `Can't save ${statePath}`);
  if (uploads.failed) add('Uploads', uploads.ok > 0, `${uploads.failed} failed since the last check (${uploads.lastError})`);
  return checks;
}
if (process.argv.includes('--check')) {
  const checks = selfCheck();
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok || !c.note ? '' : ` — ${c.note}`}`);
  for (const n of setupNotes) console.log(`NOTE ${n}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
const helloBody = () => ({
  apps: (config.apps || []).filter((a) => a.launchable !== false).map((a) => ({ id: a.id, name: a.name })),
  sensor: sensor ? { name: sensor.name || 'Sensor', mode: sensor.mode || 'command', preset: sensor.preset || null, exposure: sensor.exposure || null, pixelSize: sensor.pixelSize || null, size: sensor.size ?? null } : null,
  hostname: hostname(), version: VERSION, checks: selfCheck(), uploads: { ok: uploads.ok, failed: uploads.failed },
});
const hello = await call('POST', '/hello', helloBody());
// The scanner is registered separately (servers without document scanning answer 404: nothing to do).
const sayScanner = () => call('POST', '/scanner', scannerBody()).catch((err) => { if (err.status !== 404) log('scanner check-in failed:', err.message); });
await sayScanner();
for (const c of hello.problems || []) log(`Setup problem: ${c.name} — ${c.note}`);
log(`Connected to ${hello.practice} as "${hello.workstation}". Programs: ${(config.apps || []).map((a) => a.name).join(', ') || 'none'}. Watching: ${(config.watch || []).map((w) => w.folder).join(', ') || 'nothing'}.${sensor ? ` Sensor: ${sensor.name || 'yes'}.` : ''}${scannerCfg ? ` Scanner: ${scannerCfg.name}.` : ''}`);
// Report the self-check every 10 minutes, so a moved export folder or unplugged sensor shows up in the office.
setInterval(() => {
  call('POST', '/hello', helloBody()).then(() => { uploads.ok = 0; uploads.failed = 0; uploads.lastError = null; }).catch((err) => log('check-in failed:', err.message));
  sayScanner();
}, 10 * 60_000);
setInterval(() => scan().catch((err) => log('scan failed:', err.message)), pollSeconds * 1000);
scan().catch((err) => log('scan failed:', err.message));
commandLoop();

// ---- The WIA scan script (a copy of installer/scan.ps1, kept identical by the tests) ----
// BEGIN scan.ps1
function embeddedScanPs1() {
  return String.raw`# Dental Machine bridge: scan on this PC's scanner through Windows Image Acquisition (WIA 2.0).
# Called by dental-machine-bridge.mjs when "Scan" is pressed in a chart; writes one JPEG per page into -OutDir
# (page-001.jpg, page-002.jpg, …). The bridge makes the PDF and files it to the patient.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan.ps1 -List
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan.ps1 -OutDir C:\Temp\scan -Source feeder -Duplex -Color gray -Dpi 300
#
# UNTESTED ON REAL HARDWARE. Written from Microsoft's WIA 2.0 automation documentation (WIA.DeviceManager,
# Item.Transfer, WIA property ids below). Scanners differ in what they report: if a feeder scan returns only one
# page or fails, try -Source flatbed, check the scanner's own WIA driver is installed (not just TWAIN), and run
# -List. ScanSnap models have no WIA driver: use a "scan folder" instead (see docs/documents.md).
param(
  [string]$OutDir = "$env:TEMP\dm-scan",
  [ValidateSet('auto', 'flatbed', 'feeder')][string]$Source = 'auto',
  [switch]$Duplex,
  [ValidateSet('color', 'gray', 'bw')][string]$Color = 'gray',
  [int]$Dpi = 300,
  [string]$Device = '',
  [switch]$List
)
$ErrorActionPreference = 'Stop'

# WIA constants
$ScannerDeviceType = 1
$WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES = 3086
$WIA_DPS_DOCUMENT_HANDLING_STATUS = 3087
$WIA_DPS_DOCUMENT_HANDLING_SELECT = 3088
$WIA_DPS_PAGES = 3096
$WIA_IPS_CUR_INTENT = 6146
$WIA_IPS_XRES = 6147
$WIA_IPS_YRES = 6148
$FEEDER = 1; $FLATBED = 2; $DUPLEX = 4; $FEED_READY = 1
$FormatJPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$WIA_ERROR_PAPER_EMPTY = 0x80210003

function Set-Prop($props, [int]$id, $value) {
  foreach ($p in $props) {
    if ($p.PropertyID -eq $id) {
      try { $p.Value = $value; return $true } catch { return $false }
    }
  }
  return $false
}
function Get-Prop($props, [int]$id) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p.Value } }
  return $null
}

$manager = New-Object -ComObject WIA.DeviceManager
$scanners = @($manager.DeviceInfos | Where-Object { $_.Type -eq $ScannerDeviceType })

if ($List) {
  if (-not $scanners.Count) { Write-Output 'No WIA scanners found. Install the scanner''s WIA driver (TWAIN-only scanners won''t show here).'; exit 0 }
  foreach ($s in $scanners) {
    $name = ($s.Properties | Where-Object { $_.Name -eq 'Name' }).Value
    Write-Output "$name  (id $($s.DeviceID))"
  }
  exit 0
}

if (-not $scanners.Count) { Write-Error 'No WIA scanner found on this computer — is it plugged in and switched on?'; exit 2 }
$info = $scanners[0]
if ($Device) {
  $match = $scanners | Where-Object { ($_.Properties | Where-Object { $_.Name -eq 'Name' }).Value -like "*$Device*" -or $_.DeviceID -eq $Device } | Select-Object -First 1
  if (-not $match) { Write-Error "No WIA scanner named '$Device' (run scan.ps1 -List)"; exit 2 }
  $info = $match
}
$dev = $info.Connect()

# Where the paper comes from. "auto": the feeder when it has paper in it, else the glass.
$caps = Get-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES
$hasFeeder = $caps -ne $null -and (($caps -band $FEEDER) -ne 0)
$useFeeder = $false
if ($Source -eq 'feeder') {
  if (-not $hasFeeder) { Write-Error 'This scanner has no document feeder'; exit 3 }
  $useFeeder = $true
} elseif ($Source -eq 'auto' -and $hasFeeder) {
  $status = Get-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_STATUS
  $useFeeder = $status -ne $null -and (($status -band $FEED_READY) -ne 0)
}
if ($useFeeder) {
  $select = $FEEDER
  if ($Duplex -and (($caps -band $DUPLEX) -ne 0)) { $select = $FEEDER -bor $DUPLEX }
  [void](Set-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $select)
  [void](Set-Prop $dev.Properties $WIA_DPS_PAGES 1)
} elseif ($hasFeeder) {
  [void](Set-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $FLATBED)
}

$item = $dev.Items.Item(1)
$intent = @{ color = 1; gray = 2; bw = 4 }[$Color]
[void](Set-Prop $item.Properties $WIA_IPS_CUR_INTENT $intent)
[void](Set-Prop $item.Properties $WIA_IPS_XRES $Dpi)
[void](Set-Prop $item.Properties $WIA_IPS_YRES $Dpi)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$page = 0
$process = New-Object -ComObject WIA.ImageProcess
[void]$process.Filters.Add($process.FilterInfos.Item('Convert').FilterID)
$process.Filters.Item(1).Properties.Item('FormatID').Value = $FormatJPEG
$process.Filters.Item(1).Properties.Item('Quality').Value = 85

while ($true) {
  try {
    $image = $item.Transfer($FormatJPEG)
  } catch {
    $code = $_.Exception.HResult
    if ($page -gt 0 -and ($code -eq $WIA_ERROR_PAPER_EMPTY -or $code -eq -2145320957)) { break }
    if ($page -eq 0 -and ($code -eq $WIA_ERROR_PAPER_EMPTY -or $code -eq -2145320957)) { Write-Error 'The feeder is empty — put the pages in and scan again'; exit 4 }
    Write-Error "Scan failed: $($_.Exception.Message)"
    exit 5
  }
  # Some drivers ignore the requested format: convert to JPEG so the bridge can build the PDF.
  if ($image.FormatID -ne $FormatJPEG) { $image = $process.Apply($image) }
  $page++
  $path = Join-Path $OutDir ('page-{0:D3}.jpg' -f $page)
  if (Test-Path $path) { Remove-Item $path -Force }
  $image.SaveFile($path)
  Write-Output "page $page -> $path"
  if (-not $useFeeder) { break }
}
Write-Output "done $page"
exit 0
`;
}
// END scan.ps1
