import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ArrowLeftRight, RotateCw, Trash2, Keyboard, Snowflake } from 'lucide-react';
import { api, getToken } from '../../api.js';
import { ErrorBox, ConfirmButton } from '../ui.jsx';
import { useThumb } from './thumbs.js';

// Intraoral camera, live in the imaging studio. Nearly every intraoral camera (and the USB capture box of
// older ones) shows up as an ordinary USB video camera, so the browser runs it directly — no bridge
// needed. The handpiece button usually sends a key press; "Learn button" records which one. Each shot
// is filed in the chart as a photo (tagged "intraoral", with the tooth if one is entered), and fills the
// next empty spot when a photo series mount is open.

const CAM_KEY = 'dm_camera';
const TRIGGER_KEY = 'dm_camera_trigger';
// A permission prompt nobody answers, or a camera another program holds, never answers at all: after this
// long say so instead of "Starting the camera…" for ever (found by e2e/chaos/media.test.mjs).
const CAMERA_WAIT_MS = 10_000;
const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* per-computer convenience */ } };

export default function IntraoralCamera({ patient, photoMount, onCaptured }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(() => read(CAM_KEY, ''));
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [tooth, setTooth] = useState('');
  const [trigger, setTrigger] = useState(() => read(TRIGGER_KEY, ' '));
  const [learning, setLearning] = useState(false);
  const [shots, setShots] = useState([]);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  // Start (or switch) the camera; the list of cameras gets its names once permission is given.
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(new Error(window.isSecureContext ? 'This browser can’t use cameras' : 'Cameras only work over a secure (https) connection'));
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const ask = navigator.mediaDevices.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        const s = await Promise.race([ask, new Promise((_, no) => setTimeout(() => {
          ask.then((late) => late.getTracks().forEach((t) => t.stop()), () => {}); // arrives after we gave up: let it go
          no(Object.assign(new Error('The camera didn’t start — answer the browser’s camera prompt, and check the camera is plugged in and not open in another program'), { name: 'TimeoutError' }));
        }, CAMERA_WAIT_MS))]);
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        setLive(true);
        setFrozen(false);
        setError(null);
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        setDevices(list);
      } catch (e) {
        if (cancelled) return;
        setLive(false);
        if (deviceId && e.name === 'OverconstrainedError') { setDeviceId(''); return; } // that camera is unplugged: use any
        setError(new Error(e.name === 'NotAllowedError' ? 'Camera access was blocked — allow it in the browser’s address bar' : e.name === 'NotFoundError' ? 'No camera found — plug in the intraoral camera' : e.message));
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  const capture = useCallback(async () => {
    const v = video.current;
    if (!v || !live || busy || !v.videoWidth) return;
    setBusy(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const [w, h] = [v.videoWidth, v.videoHeight];
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = c.getContext('2d');
      ctx.translate(w / 2, h / 2);
      if (rotate) ctx.rotate(Math.PI);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(v, -w / 2, -h / 2, w, h);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (frozen) { v.play().catch(() => {}); setFrozen(false); }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const t = tooth.trim().toUpperCase();
      const q = new URLSearchParams({ category: 'photo', filename: `intraoral-${stamp}${t ? `-tooth${t}` : ''}.jpg`, ...(t ? { tooth: t } : {}) });
      const res = await fetch(`/api/patients/${patient.id}/documents?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'image/jpeg' }, body: blob });
      const doc = await res.json();
      if (!res.ok) throw new Error(doc.error || 'Could not save the photo');
      await api.put(`/documents/${doc.id}`, { tags: ['intraoral'] }).catch(() => {});
      setShots((list) => [{ id: doc.id, tooth: t }, ...list].slice(0, 30));
      onCaptured?.(doc);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }, [live, busy, rotate, mirror, frozen, tooth, patient.id, onCaptured]);

  // The handpiece button (or a foot pedal) arrives as a key press.
  useEffect(() => {
    const onKey = (e) => {
      if (learning) {
        e.preventDefault();
        setTrigger(e.key);
        write(TRIGGER_KEY, e.key);
        setLearning(false);
        return;
      }
      if (e.target.closest?.('input, select, textarea, .modal')) return;
      if (e.key === trigger) { e.preventDefault(); e.stopPropagation(); capture(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [learning, trigger, capture]);

  const freeze = () => {
    if (!video.current) return;
    if (frozen) video.current.play().catch(() => {}); else video.current.pause();
    setFrozen(!frozen);
  };
  const remove = async (id) => {
    try {
      await api.del(`/documents/${id}`);
      setShots((list) => list.filter((s) => s.id !== id));
      onCaptured?.(null);
    } catch (e) { setError(e); }
  };
  const keyName = trigger === ' ' ? 'Space' : trigger;
  const next = photoMount?.next;

  return (
    <div className="iocam">
      <div className="iocam-bar">
        <select className="studio-select" aria-label="Camera" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); write(CAM_KEY, e.target.value); }}>
          <option value="">{devices.length ? 'Default camera' : 'Camera…'}</option>
          {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
        </select>
        <label className="iocam-tooth">Tooth<input value={tooth} onChange={(e) => setTooth(e.target.value)} placeholder="e.g. 19" /></label>
        <button type="button" className={`studio-btn ghost${mirror ? ' on' : ''}`} onClick={() => setMirror(!mirror)} title="Mirror (for shots taken in a mirror)"><ArrowLeftRight size={15} /> Mirror</button>
        <button type="button" className={`studio-btn ghost${rotate ? ' on' : ''}`} onClick={() => setRotate(!rotate)} title="Turn upside down (upper arch)"><RotateCw size={15} /> Upper</button>
        <button type="button" className={`studio-btn ghost${frozen ? ' on' : ''}`} onClick={freeze} title="Freeze the picture, then Capture keeps it"><Snowflake size={15} /> {frozen ? 'Frozen' : 'Freeze'}</button>
        <button type="button" className={`studio-btn ghost${learning ? ' on' : ''}`} onClick={() => setLearning(!learning)} title="Press the camera's capture button to teach it"><Keyboard size={15} /> {learning ? 'Press the camera button…' : `Button: ${keyName}`}</button>
        <div className="studio-spacer" />
        <button type="button" className="studio-btn go" disabled={!live || busy} onClick={capture}><Camera size={15} /> Capture</button>
      </div>
      <ErrorBox error={error} />
      <div className={`iocam-stage${flash ? ' flash' : ''}`}>
        <video ref={video} muted playsInline style={{ transform: `${rotate ? 'rotate(180deg) ' : ''}${mirror ? 'scaleX(-1)' : ''}` || undefined }} />
        {!live && !error && <div className="viewer-loading"><span className="spinner" /> Starting the camera…</div>}
        {live && (
          <div className="iocam-hint">
            {next ? `Next: ${next}` : 'Saved to the chart as photos'} · press <kbd>{keyName}</kbd> or the camera button to capture
          </div>
        )}
      </div>
      {shots.length > 0 && (
        <div className="iocam-strip" aria-label="Photos taken now">
          {shots.map((s) => <Shot key={s.id} id={s.id} tooth={s.tooth} onDelete={() => remove(s.id)} />)}
        </div>
      )}
    </div>
  );
}

function Shot({ id, tooth, onDelete }) {
  const src = useThumb(id);
  return (
    <div className="iocam-shot">
      {src ? <img className="arrive" src={src} alt={tooth ? `Tooth ${tooth}` : 'Intraoral photo'} /> : <span className="spot-loading" />}
      {tooth && <span className="spot-n">#{tooth}</span>}
      <ConfirmButton className="small" aria-label="Delete photo" title="Delete" ask="Delete this photo from the chart?" yes="Delete" onConfirm={onDelete}><Trash2 size={13} /></ConfirmButton>
    </div>
  );
}
