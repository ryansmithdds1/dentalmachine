// The imaging bridge "install package": a zip an office unzips on an operatory PC and double-clicks.
// It holds the bridge program, presets.json, a bridge-config.json filled in from the setup wizard (with the
// workstation's key), install/uninstall scripts for Windows (install.cmd → install.ps1: Node.js, a logon task,
// the setup check) and macOS/Linux (install.sh: LaunchAgent / systemd user service), and SETUP.txt with the
// steps left for each imaging program. The key is never stored here: the caller passes the one it was just
// shown (see routes/bridgepackage.js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './auth.js';
import { buildZip } from './zip.js';

export const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../bridge');
export const SENSOR_PRESETS = { tuxedo: 'Tuxedo sensor', jazz: 'Jazz sensor', twain: 'Other TWAIN sensor' };
export const PLATFORMS = ['windows', 'mac', 'linux'];
const MAX_APPS = 8;

let cached = null;
// presets.json, read once (it ships with the server and the bridge).
export function loadPresets() {
  if (!cached) {
    const list = JSON.parse(readFileSync(join(BRIDGE_DIR, 'presets.json'), 'utf8')).presets;
    if (!Array.isArray(list)) throw new Error('bridge/presets.json has no "presets" list');
    cached = list;
  }
  return cached;
}
export const findPreset = (key) => {
  const k = String(key || '').toLowerCase();
  return loadPresets().find((p) => p.id === k || (p.aliases || []).includes(k)) || null;
};

// What the setup wizard shows for each program (no internal fields).
export const presetSummaries = () => loadPresets().map((p) => ({
  id: p.id, name: p.name, vendor: p.vendor, initials: p.initials, aliases: p.aliases || [], handoff: p.handoff, verify: !!p.verify,
  needs_command: !!p.needsCommand, command: p.command || null, watch: p.watch || [], comment: p.comment, export_help: p.exportHelp || null,
}));

// A path typed by an admin: one line, no quotes or control characters, a sensible length.
function cleanPath(v, what) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 260 || /["\0-\x1f<>|]/.test(s) || !/[\\/]/.test(s)) throw new HttpError(400, `${what} must be a full path, e.g. C:\\Program Files\\...\\program.exe`);
  return s;
}
const cleanServer = (v) => {
  try {
    const u = new URL(String(v));
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
};
// The Windows export/hand-off folders in presets are under C:\DentalMachine; on a Mac or Linux PC the same
// folders go next to the bridge (the bridge reads relative paths from its own folder).
const localPath = (p) => String(p).replace(/^C:\\DentalMachine\\/i, '').replace(/\\/g, '/');

// Checks the wizard's choices and returns { config, apps, sensor, platform } for the package.
export function bridgeConfigFrom(body, { server, token, workstation }) {
  const platform = PLATFORMS.includes(body?.platform) ? body.platform : 'windows';
  const picked = Array.isArray(body?.apps) ? body.apps : [];
  if (picked.length > MAX_APPS) throw new HttpError(400, `Choose at most ${MAX_APPS} imaging programs for one workstation`);
  const apps = [];
  const used = new Set();
  for (const a of picked) {
    const preset = findPreset(a?.preset);
    if (!preset) throw new HttpError(400, `Unknown imaging program "${String(a?.preset ?? '').slice(0, 40)}"`);
    if (used.has(preset.id)) throw new HttpError(400, `${preset.name} is listed twice`);
    used.add(preset.id);
    const entry = { preset: preset.id };
    const command = cleanPath(a.command, `${preset.name} program path`);
    if (command) entry.command = command;
    else if (preset.needsCommand) throw new HttpError(400, `Enter where ${preset.name.replace(/^Other program: /, 'the program')} is installed (its .exe)`);
    const folder = cleanPath(a.watch_folder, `${preset.name} export folder`);
    const watch = (preset.watch || []).map((w, i) => ({ ...w, ...(i === 0 && folder ? { folder } : {}) }));
    if (folder || platform !== 'windows') entry.watch = watch.map((w) => ({ ...w, folder: platform === 'windows' || folder ? w.folder : localPath(w.folder), create: true }));
    if (platform !== 'windows' && preset.writeFile?.path) entry.writeFile = { path: localPath(preset.writeFile.path) };
    apps.push({ entry, preset });
  }
  let sensor = null;
  if (body?.sensor) {
    const key = String(body.sensor.preset || body.sensor).toLowerCase();
    if (!SENSOR_PRESETS[key]) throw new HttpError(400, `Sensor must be one of: ${Object.keys(SENSOR_PRESETS).join(', ')}`);
    sensor = { preset: key };
    const kvp = body.sensor.kvp == null || body.sensor.kvp === '' ? null : Number(body.sensor.kvp);
    const ma = body.sensor.ma == null || body.sensor.ma === '' ? null : Number(body.sensor.ma);
    if (kvp !== null && !(kvp >= 40 && kvp <= 100)) throw new HttpError(400, 'kVp must be between 40 and 100');
    if (ma !== null && !(ma > 0 && ma <= 20)) throw new HttpError(400, 'mA must be between 0 and 20');
    if (kvp !== null || ma !== null) sensor.exposure = { ...(kvp !== null ? { kvp } : {}), ...(ma !== null ? { ma } : {}) };
  }
  if (!apps.length && !sensor) throw new HttpError(400, 'Choose at least one imaging program or a sensor');
  const config = {
    server, token, workstation,
    apps: apps.map((a) => a.entry),
    scanSeconds: 5,
    ...(sensor ? { sensor } : {}),
  };
  return { config, apps, sensor, platform };
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const template = (name) => readFileSync(join(BRIDGE_DIR, 'installer', name), 'utf8');

function setupText({ workstation, apps, sensor, platform, config }) {
  const where = platform === 'windows' ? 'C:\\DentalMachine' : '~/DentalMachineBridge';
  const lines = [
    `Dental Machine imaging bridge for "${workstation}"`,
    '',
    platform === 'windows'
      ? '1. Unzip this whole folder, then double-click install.cmd and say Yes when Windows asks for permission.'
      : '1. Unzip this whole folder, open Terminal in it and run: sh install.sh',
    `   It installs Node.js if needed, copies the bridge to ${where}, starts it now and every time`,
    '   you sign in, and checks the setup. Keep the window open until it says it is done.',
    '2. Set up each imaging program to export new images to its folder:',
  ];
  for (const { entry, preset } of apps) {
    const shown = (f) => (platform === 'windows' || /^([A-Za-z]:|[\\/~])/.test(f) ? f : `${where}/${f}`);
    const folders = (entry.watch || preset.watch || []).map((w) => shown(w.folder)).join(', ');
    lines.push(`   - ${preset.name}: ${folders ? `export to ${folders}` : 'nothing to export'}`);
    if (preset.exportHelp && !entry.watch) lines.push(`     ${preset.exportHelp}`);
    if (preset.handoff === 'none') lines.push('     Staff pick the patient in this program; images go to the patient last opened from the chart on this PC.');
    if (preset.verify) lines.push(`     Not yet confirmed for your version: ${preset.comment.replace(/^Known: .*?Assumed: /, '')}`);
  }
  if (sensor) {
    lines.push(`3. Sensor (${SENSOR_PRESETS[sensor.preset]}): install the sensor's TWAIN driver and the free NAPS2 app (naps2.com),`);
    lines.push('   then press "Test sensor" in Dental Machine, Settings -> Imaging bridges.');
  }
  lines.push(
    `${sensor ? 4 : 3}. Open a test patient from the chart ("Open in ...") and check the right patient opens.`,
    '',
    `Settings file: ${where}${platform === 'windows' ? '\\' : '/'}bridge-config.json. It holds this workstation's key: don't email it or copy it`,
    'to another PC. If it is lost, remove the workstation in Settings -> Imaging bridges and add it again.',
    platform === 'windows' ? 'To remove the bridge: run uninstall.cmd (in C:\\DentalMachine).' : 'To remove the bridge: sh install.sh --uninstall',
    `Programs in this package: ${config.apps.map((a) => a.preset).join(', ') || 'none'}${sensor ? `; sensor: ${sensor.preset}` : ''}.`,
    '',
  );
  return lines.join('\n');
}

// The zip itself: { filename, zip, files }.
export function buildBridgePackage({ server, token, workstation, body, date = new Date() }) {
  const cleanServerUrl = cleanServer(server);
  if (!cleanServerUrl) throw new HttpError(400, 'The Dental Machine address must be an http(s) address');
  const built = bridgeConfigFrom(body, { server: cleanServerUrl, token, workstation });
  const slug = String(workstation).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workstation';
  const root = `DentalMachine-Bridge-${slug}`;
  const files = [
    { name: 'dental-machine-bridge.mjs', data: readFileSync(join(BRIDGE_DIR, 'dental-machine-bridge.mjs')) },
    { name: 'presets.json', data: readFileSync(join(BRIDGE_DIR, 'presets.json')) },
    { name: 'bridge-config.json', data: `${JSON.stringify(built.config, null, 2)}\n` },
    { name: 'SETUP.txt', data: crlf(setupText({ workstation, ...built })) },
    { name: 'install.cmd', data: crlf(template('install.cmd')) },
    { name: 'install.ps1', data: crlf(template('install.ps1')) },
    { name: 'run-bridge.ps1', data: crlf(template('run-bridge.ps1')) },
    { name: 'uninstall.cmd', data: crlf(template('uninstall.cmd')) },
    { name: 'uninstall.ps1', data: crlf(template('uninstall.ps1')) },
    { name: 'install.sh', data: template('install.sh'), mode: 0o755 },
  ];
  return {
    filename: `${root}.zip`,
    zip: buildZip(files.map((f) => ({ ...f, name: `${root}/${f.name}` })), { date }),
    files: files.map((f) => f.name),
    apps: built.config.apps.map((a) => a.preset),
    sensor: built.sensor?.preset || null,
    platform: built.platform,
  };
}
