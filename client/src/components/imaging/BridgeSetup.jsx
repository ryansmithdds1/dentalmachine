import { useMemo, useState } from 'react';
import { api, getToken, getLocationId, saveBlob, ApiError } from '../../api.js';
import { useApi } from '../../hooks.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import './bridgesetup.css';

// Three steps (batch 3; it was four): the programs and the sensor are chosen on one screen, whose button adds the
// workstation and downloads its package at once.
const STEPS = ['Workstation', 'Programs & sensor', 'Install'];
const HANDOFF = { args: 'Opens with the patient', file: 'Opens with the patient', 'file+args': 'Opens with the patient', none: 'Staff pick the patient in the program' };

// The install package is made with the key the server just handed back (it's shown only once), so it
// can only be downloaded from this screen, straight after adding the workstation.
async function downloadPackage(ws, body) {
  const res = await fetch(`/api/imaging/agents/${ws.id}/package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) },
    body: JSON.stringify({ ...body, token: ws.token }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || res.statusText, data.details);
  }
  const name = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || 'dental-machine-bridge.zip';
  saveBlob(await res.blob(), name);
}

function ProgramTile({ preset, selected, onToggle }) {
  return (
    <button type="button" className={`bridge-tile${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onToggle} title={preset.comment}>
      <span className="bridge-logo" aria-hidden="true">{preset.initials}</span>
      <span className="bridge-tile-text">
        <strong>{preset.name}</strong>
        <span className="muted">{preset.vendor}</span>
      </span>
      {selected && <span className="bridge-check" aria-hidden="true">✓</span>}
    </button>
  );
}

// Settings → Imaging bridges → "Set up a workstation": name, imaging programs, sensor, then one download
// with everything that PC needs (bridge, filled-in settings with its key, installer).
export default function BridgeSetup({ onClose, onCreated }) {
  const { data: catalog, error: loadError } = useApi('/imaging/presets');
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('windows');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]); // [{ preset, command, watch_folder }]
  const [sensor, setSensor] = useState({ preset: '', kvp: '70', ma: '7' });
  const [created, setCreated] = useState(null);
  const [done, setDone] = useState(false);
  const presets = catalog?.presets || [];
  const byId = useMemo(() => Object.fromEntries(presets.map((p) => [p.id, p])), [presets]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => [p.name, p.vendor, p.initials, p.id, ...(p.aliases || [])].join(' ').toLowerCase().includes(q));
  }, [presets, query]);

  const toggle = (id) => setPicked((list) => (list.some((x) => x.preset === id) ? list.filter((x) => x.preset !== id) : [...list, { preset: id, command: '', watch_folder: '' }]));
  const setPick = (id, k, v) => setPicked((list) => list.map((x) => (x.preset === id ? { ...x, [k]: v } : x)));
  const missingPath = picked.find((x) => byId[x.preset]?.needs_command && !x.command.trim());
  const canNext = [
    name.trim().length > 0,
    !missingPath && (picked.length > 0 || !!sensor.preset),
    true,
  ][step];
  const body = () => ({
    platform, server: window.location.origin,
    apps: picked.map((x) => ({ preset: x.preset, ...(x.command.trim() ? { command: x.command.trim() } : {}), ...(x.watch_folder.trim() ? { watch_folder: x.watch_folder.trim() } : {}) })),
    sensor: sensor.preset ? { preset: sensor.preset, kvp: sensor.kvp, ma: sensor.ma } : null,
  });
  // Adding the workstation and making its package are one step for the office; a failed download (or a
  // second click) reuses the workstation just added instead of adding another.
  const make = useSubmit(async () => {
    let ws = created;
    if (!ws) {
      ws = await api.post('/imaging/agents', { name: name.trim() });
      setCreated(ws);
      onCreated?.();
    }
    await downloadPackage(ws, body());
    setDone(true);
    setStep(2);
  });
  const configOnly = () => {
    const b = body();
    const cfg = { server: b.server, token: created.token, workstation: created.name, apps: b.apps.map(({ watch_folder: folder, ...a }) => (folder ? { ...a, watch: [{ folder, category: byId[a.preset]?.watch?.[0]?.category || 'xray', create: true }] } : a)), ...(b.sensor ? { sensor: { preset: b.sensor.preset, exposure: { kvp: Number(b.sensor.kvp) || undefined, ma: Number(b.sensor.ma) || undefined } } } : {}) };
    saveBlob(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }), 'bridge-config.json');
  };

  return (
    <div className="card bridge-setup">
      <div className="bridge-setup-head">
        <h2 style={{ margin: 0 }}>Set up an imaging workstation</h2>
        <button type="button" className="small" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
      </div>
      <ol className="bridge-steps" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>{i + 1}. {s}</li>)}
      </ol>
      <ErrorBox error={loadError} />

      {step === 0 && (
        <div className="form-grid">
          <label>
            Workstation name
            <input autoFocus value={name} disabled={!!created} onChange={(e) => setName(e.target.value)} placeholder='For example "Op 2" or "Pano room"' maxLength={80}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { e.preventDefault(); setStep(1); } }} />
          </label>
          <label>
            This computer runs
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="windows">Windows (most imaging programs)</option>
              <option value="mac">macOS</option>
              <option value="linux">Linux</option>
            </select>
          </label>
        </div>
      )}

      {step === 1 && (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Choose the imaging programs on this computer. Staff can then open the patient in them from the chart, and images exported from them file themselves. Skip this if the PC only takes x-rays straight from a sensor.</p>
          <input type="search" aria-label="Search imaging programs" placeholder="Search: DEXIS, Sidexis, Carestream, Eaglesoft…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 360 }} />
          <div className="bridge-tiles">
            {shown.map((p) => <ProgramTile key={p.id} preset={p} selected={picked.some((x) => x.preset === p.id)} onToggle={() => toggle(p.id)} />)}
            {catalog && !shown.length && <div className="muted">No program matches “{query}”. Choose “Other program” and enter its path.</div>}
          </div>
          {picked.length > 0 && (
            <div className="bridge-picked">
              {picked.map((x) => {
                const p = byId[x.preset];
                if (!p) return null;
                return (
                  <div key={x.preset} className="bridge-picked-row">
                    <div className="bridge-picked-name">
                      <span className="bridge-logo small" aria-hidden="true">{p.initials}</span>
                      <strong>{p.name}</strong>
                      <span className="badge nocap">{HANDOFF[p.handoff] || p.handoff}</span>
                      {p.verify && <span className="badge warn nocap" title={p.comment}>Check once after installing</span>}
                    </div>
                    <div className="form-grid">
                      <label>
                        Program path{p.needs_command ? '' : ' (optional)'}
                        <input value={x.command} onChange={(e) => setPick(x.preset, 'command', e.target.value)} placeholder={p.command || 'C:\\Program Files\\…\\program.exe'} />
                      </label>
                      <label>
                        Export folder (optional)
                        <input value={x.watch_folder} onChange={(e) => setPick(x.preset, 'watch_folder', e.target.value)} placeholder={platform === 'windows' ? p.watch?.[0]?.folder : `DentalMachineBridge/${(p.watch?.[0]?.folder || '').replace(/^C:\\DentalMachine\\/i, '').replace(/\\/g, '/')}`} />
                      </label>
                    </div>
                    {p.export_help && <div className="muted" style={{ fontSize: 12 }}>{p.export_help}</div>}
                  </div>
                );
              })}
            </div>
          )}
          {missingPath && <div className="error" style={{ marginTop: 8 }}>Enter the program path for {byId[missingPath.preset]?.name}.</div>}
          <h3 style={{ margin: '16px 0 6px', fontSize: 14 }}>Sensor</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Optional: take x-rays straight from a sensor plugged into this computer (needs the sensor&apos;s TWAIN driver and the free NAPS2 app).</p>
          <div className="chips" role="radiogroup" aria-label="Sensor">
            {[{ id: '', name: 'No sensor on this PC' }, ...(catalog?.sensors || [])].map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={sensor.preset === s.id} className={`chip${sensor.preset === s.id ? ' active' : ''}`} onClick={() => setSensor({ ...sensor, preset: s.id })}>{s.name}</button>
            ))}
          </div>
          {sensor.preset && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <label>Usual kVp<input type="number" min="40" max="100" value={sensor.kvp} onChange={(e) => setSensor({ ...sensor, kvp: e.target.value })} /></label>
              <label>Usual mA<input type="number" min="1" max="20" step="0.5" value={sensor.ma} onChange={(e) => setSensor({ ...sensor, ma: e.target.value })} /></label>
            </div>
          )}
          {!picked.length && !sensor.preset && <div className="muted" style={{ marginTop: 8 }}>Choose an imaging program (previous step) or a sensor.</div>}
        </>
      )}

      {step === 2 && (
        <>
          <dl className="kv">
            <dt>Workstation</dt><dd>{name.trim()} <span className="muted">({{ windows: 'Windows', mac: 'macOS', linux: 'Linux' }[platform]})</span></dd>
            <dt>Imaging programs</dt><dd>{picked.map((x) => byId[x.preset]?.name).join(', ') || '—'}</dd>
            <dt>Sensor</dt><dd>{catalog?.sensors?.find((s) => s.id === sensor.preset)?.name || 'None'}</dd>
          </dl>
          {!done ? (
            <p className="muted" style={{ fontSize: 13 }}>
              This adds the workstation and downloads its install package. The package holds the workstation&apos;s key, which is shown only this once:
              copy it to that computer and don&apos;t email it.
            </p>
          ) : (
            <div className="public-notice ok">
              <strong>{created.name} added and its package downloaded.</strong>
              <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>Copy the zip to that computer and unzip it.</li>
                <li>{platform === 'windows' ? <>Double-click <code>install.cmd</code> and answer Yes. It installs Node.js if needed, starts the bridge with Windows, and checks the setup.</> : <>Open Terminal in the folder and run <code>sh install.sh</code>.</>}</li>
                <li>Follow <code>SETUP.txt</code> to point each imaging program&apos;s export at its folder, then open a test patient from the chart.</li>
              </ol>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Lost the file? Download it again now — once you leave this screen, remove the workstation and add it again for a new key.</div>
            </div>
          )}
          <ErrorBox error={make.error} />
        </>
      )}

      <ErrorBox error={step === 1 ? make.error : null} />
      <div className="form-actions">
        {step > 0 && !created && <button type="button" onClick={() => setStep(step - 1)} disabled={make.busy}>Back</button>}
        {step === 0 && <button type="button" className="primary" disabled={!canNext} onClick={() => setStep(1)}>Next</button>}
        {step === 1 && (
          <button type="button" className="primary" disabled={!canNext || make.busy} onClick={() => make.submit()}>
            {make.busy ? 'Preparing…' : 'Add workstation and download'}
          </button>
        )}
        {step === 2 && (
          <>
            {created && <button type="button" onClick={configOnly} title="Just the settings file, for setting the bridge up by hand">bridge-config.json only</button>}
            <button type="button" className="primary" disabled={make.busy} onClick={() => make.submit()}>
              {make.busy ? 'Preparing…' : 'Download package again'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
