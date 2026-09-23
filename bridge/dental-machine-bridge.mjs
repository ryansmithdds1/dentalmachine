#!/usr/bin/env node
// Dental Machine imaging bridge — runs on each operatory PC (Windows, macOS or Linux, Node 18+).
//  • "Open in DEXIS" (etc.) from the chart launches your imaging program with the patient.
//  • New images in your imaging program's export folders are uploaded to the patient's chart.
//  • "Capture from sensor" in the chart takes x-rays straight from the sensor into a mount, through a
//    TWAIN/WIA acquire command (e.g. NAPS2's console) or the folder the sensor driver saves to.
// Usage: node dental-machine-bridge.mjs bridge-config.json
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const VERSION = '1.1.0';
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
const sensor = config.sensor || null;
let capturing = null;
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
  while (capturing === cmd.id) {
    const s = await status();
    if (!s.active) return finish(true, `Capture for ${who} finished (${s.filled ?? '?'} of ${s.total ?? cmd.total})`);
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
        if (++failures >= (Number(sensor.maxFailures) || 3)) return finish(false, `Sensor capture failed (${outcome.message})`);
        continue;
      }
      failures = 0;
      files = [output];
    }
    for (const path of files) {
      sent.add(path);
      try {
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
          continue;
        }
      }
      saveState();
    }
  }
}

const hello = await call('POST', '/hello', { apps: (config.apps || []).map((a) => ({ id: a.id, name: a.name })), sensor: sensor ? { name: sensor.name || 'Sensor', mode: sensor.mode || 'command' } : null, hostname: hostname(), version: VERSION });
log(`Connected to ${hello.practice} as "${hello.workstation}". Programs: ${(config.apps || []).map((a) => a.name).join(', ') || 'none'}. Watching: ${(config.watch || []).map((w) => w.folder).join(', ') || 'nothing'}.${sensor ? ` Sensor: ${sensor.name || 'yes'}.` : ''}`);
setInterval(() => scan().catch((err) => log('scan failed:', err.message)), pollSeconds * 1000);
scan().catch(() => {});
commandLoop();
