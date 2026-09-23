#!/usr/bin/env node
// Dental Machine imaging bridge — runs on each operatory PC (Windows, macOS or Linux, Node 18+).
//  • "Open in DEXIS" (etc.) from the chart launches your imaging program with the patient.
//  • New images in your imaging program's export folders are uploaded to the patient's chart.
// Usage: node dental-machine-bridge.mjs bridge-config.json
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const VERSION = '1.0.0';
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
        log(`${name} → patient #${out.patient_id}${out.duplicate ? ' (already in chart)' : ''}`);
        state.seen[key] = out.id;
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

const hello = await call('POST', '/hello', { apps: (config.apps || []).map((a) => ({ id: a.id, name: a.name })), hostname: hostname(), version: VERSION });
log(`Connected to ${hello.practice} as "${hello.workstation}". Programs: ${(config.apps || []).map((a) => a.name).join(', ') || 'none'}. Watching: ${(config.watch || []).map((w) => w.folder).join(', ') || 'nothing'}.`);
setInterval(() => scan().catch((err) => log('scan failed:', err.message)), pollSeconds * 1000);
scan().catch(() => {});
commandLoop();
