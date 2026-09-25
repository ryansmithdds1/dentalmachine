import { useEffect, useRef, useState } from 'react';
import { ScanLine, Smartphone, Upload, Printer, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useRemembered } from '../../prefs.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { readWs } from '../imaging/workstation.js';
import { catLabel, PATIENT_CATEGORIES } from './filekinds.jsx';

const DEFAULTS = { source: 'auto', duplex: false, color: 'gray', dpi: 300, format: 'pdf', category: 'document' };

// "Scan" for the patient on screen: this computer's scanner (through its imaging bridge), a phone or tablet
// (QR code), or a file from the computer. Opens under the button (no dialog on a dialog); S opens it,
// 1/2/3 pick, Esc closes. The last scan settings are remembered per person.
export default function ScanMenu({ patient, open, setOpen, onPhone, onUpload, onScanned }) {
  const { data: scanners } = useApi('/scanners');
  const [panel, setPanel] = useState(null); // null | 'desk'
  const box = useRef(null);
  const here = (scanners || []).find((s) => String(s.id) === String(readWs())) || (scanners || []).find((s) => s.online) || (scanners || [])[0];
  // The choice this person used last has the focus (Enter repeats it); with no scanner online, "a file".
  const [lastPick, rememberPick] = useRemembered('docs.scan.pick', '');
  const focusPick = lastPick === 'desk' && !here?.online ? 'file' : lastPick || (here?.online ? 'desk' : 'file');
  const pick = (k) => { if (k !== lastPick) rememberPick(k); };
  useEffect(() => {
    if (!open) { setPanel(null); return undefined; }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
      if (panel || /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === '1' && here) { e.preventDefault(); pick('desk'); setPanel('desk'); }
      if (e.key === '2') { e.preventDefault(); pick('phone'); setOpen(false); onPhone(); }
      if (e.key === '3') { e.preventDefault(); pick('file'); setOpen(false); onUpload(); }
    };
    const onDown = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest?.('.scan-trigger')) setOpen(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    setTimeout(() => (box.current?.querySelector(`button[data-pick="${focusPick}"]:not([disabled])`) || box.current?.querySelector('button:not([disabled])'))?.focus(), 0);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); };
  }, [open, panel, here, focusPick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <div className="scanmenu" ref={box} role="menu" aria-label="Scan or add a document">
      {panel === 'desk' && here ? (
        <DeskScan patient={patient} scanners={scanners} initial={here} onClose={() => setOpen(false)} onScanned={onScanned} />
      ) : (
        <>
          <button role="menuitem" data-pick="desk" className="scanmenu-item" disabled={!here || !here.online} onClick={() => { pick('desk'); setPanel('desk'); }}>
            <Printer size={20} aria-hidden />
            <span><strong>This computer’s scanner</strong><small>{here ? `${here.scanner} on ${here.name}${here.online ? '' : ' — offline'}` : 'No scanner set up in an imaging bridge (Settings → Imaging bridges)'}</small></span>
            <kbd>1</kbd>
          </button>
          <button role="menuitem" data-pick="phone" className="scanmenu-item" onClick={() => { pick('phone'); setOpen(false); onPhone(); }}>
            <Smartphone size={20} aria-hidden />
            <span><strong>Phone or tablet camera</strong><small>Scan a QR code, photograph the pages — straightened and sent as one PDF</small></span>
            <kbd>2</kbd>
          </button>
          <button role="menuitem" data-pick="file" className="scanmenu-item" onClick={() => { pick('file'); setOpen(false); onUpload(); }}>
            <Upload size={20} aria-hidden />
            <span><strong>A file on this computer</strong><small>PDF, pictures, Word/Excel, audio, video, x-rays… or drop it anywhere</small></span>
            <kbd>3</kbd>
          </button>
        </>
      )}
    </div>
  );
}

function DeskScan({ patient, scanners, initial, onClose, onScanned }) {
  const [saved, remember] = useRemembered('docs.scan', DEFAULTS);
  const [o, setO] = useState({ ...DEFAULTS, ...saved, agent_id: initial.id, name: '' });
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const scanner = scanners.find((s) => s.id === Number(o.agent_id)) || initial;
  const info = scanner.info || {};
  const set = (k) => (e) => setO({ ...o, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const start = async (e) => {
    e?.preventDefault();
    setError(null);
    const { agent_id: agentId, name, ...opts } = o;
    remember(opts);
    try {
      const created = await api.post(`/patients/${patient.id}/scan`, { agent_id: Number(agentId), ...opts, dpi: Number(opts.dpi), name: name || undefined });
      setJob({ ...created, message: `Waiting for ${created.workstation}…` });
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 900));
        const s = await api.get(`/scans/${created.id}`);
        if (s.progress?.message) setJob((j) => ({ ...j, message: s.progress.message }));
        if (s.status === 'done') {
          toast(s.result || `Scanned into ${patient.first_name}’s chart`);
          onScanned?.(s.documents);
          onClose();
          return;
        }
        if (s.status === 'error' || s.status === 'expired') throw new Error(s.result || `${created.workstation} didn’t pick up the scan — is the bridge running there?`);
      }
      throw new Error('The scan is taking a long time — check the scanner');
    } catch (err) {
      setJob(null);
      setError(err);
    }
  };
  if (job) {
    return (
      <div className="scan-progress" role="status" aria-live="polite">
        <Loader2 size={22} className="spin" aria-hidden />
        <div><strong>Scanning for {patient.first_name}</strong><div className="muted">{job.message}</div></div>
      </div>
    );
  }
  return (
    <form className="deskscan" onSubmit={start} aria-label="Scan on this computer’s scanner">
      <div className="deskscan-head"><ScanLine size={18} aria-hidden /> <strong>Scan for {patient.first_name} {patient.last_name}</strong></div>
      <ErrorBox error={error} />
      {scanners.length > 1 && (
        <label>Scanner<select value={o.agent_id} onChange={set('agent_id')}>{scanners.map((s) => <option key={s.id} value={s.id} disabled={!s.online}>{s.scanner} · {s.name}{s.online ? '' : ' (offline)'}</option>)}</select></label>
      )}
      <div className="deskscan-grid">
        <label>Paper from<select value={o.source} onChange={set('source')}>
          <option value="auto">Automatic</option>
          {info.feeder !== false && <option value="feeder">Document feeder</option>}
          {info.flatbed !== false && <option value="flatbed">Glass (flatbed)</option>}
        </select></label>
        <label>Colour<select value={o.color} onChange={set('color')}><option value="gray">Greyscale</option><option value="color">Colour</option><option value="bw">Black &amp; white</option></select></label>
        <label>Quality<select value={o.dpi} onChange={set('dpi')}>{[150, 200, 300, 600].map((n) => <option key={n} value={n}>{n} dpi{n === 300 ? ' (usual)' : ''}</option>)}</select></label>
        <label>Save as<select value={o.category} onChange={set('category')}>{PATIENT_CATEGORIES.filter((c) => c !== 'xray').map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
      </div>
      <div className="inline" style={{ gap: 14, flexWrap: 'wrap' }}>
        {info.duplex !== false && o.source !== 'flatbed' && <label className="docs-check"><input type="checkbox" checked={!!o.duplex} onChange={set('duplex')} /> Both sides</label>}
        <label className="docs-check"><input type="checkbox" checked={o.format === 'jpg'} onChange={(e) => setO({ ...o, format: e.target.checked ? 'jpg' : 'pdf' })} /> Separate pictures (not one PDF)</label>
      </div>
      <label>Name (optional)<input value={o.name} onChange={set('name')} placeholder="e.g. Referral from Dr Smith" /></label>
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" autoFocus><ScanLine size={15} aria-hidden /> Scan now</button></div>
    </form>
  );
}
