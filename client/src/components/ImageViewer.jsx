import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api.js';
import { ErrorBox } from './ui.jsx';

// X-ray / photo viewer: zoom (wheel or buttons), pan, rotate, flip, brightness/contrast/invert, and
// annotations stored in image pixels — measurements (mm from the DICOM spacing or a calibration),
// arrows, circles and text. Used on its own or two side by side to compare.

const TOOLS = [['pan', '✋', 'Move'], ['measure', '📏', 'Measure'], ['arrow', '➚', 'Arrow'], ['circle', '◯', 'Circle'], ['text', 'T', 'Note'], ['calibrate', '⇔', 'Calibrate (draw a line of known length)']];

async function loadImage(id) {
  const res = await fetch(`/api/documents/${id}/image`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load the image');
  const url = URL.createObjectURL(await res.blob());
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Could not show the image')); img.src = url; });
  return { img, url };
}

export default function ImageViewer({ doc, canEdit = false, height = '70vh', compact = false }) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const [img, setImg] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0, rot: 0, flip: false });
  const [adj, setAdj] = useState({ brightness: 100, contrast: 100, invert: false });
  const [tool, setTool] = useState('pan');
  const [notes, setNotes] = useState([]);
  const [mm, setMm] = useState(null);
  const [scaleSource, setScaleSource] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState(null);
  const drag = useRef(null);

  useEffect(() => {
    let url;
    setImg(null);
    setError(null);
    Promise.all([loadImage(doc.id), api.get(`/documents/${doc.id}/viewer`)]).then(([l, meta]) => {
      url = l.url;
      setImg(l.img);
      setNotes(meta.annotations);
      setMm(meta.mm_per_px);
      setScaleSource(meta.scale_source);
      setDirty(false);
      setView({ zoom: 1, x: 0, y: 0, rot: 0, flip: false });
    }).catch(setError);
    return () => url && URL.revokeObjectURL(url);
  }, [doc.id]);

  // Image pixels → screen: centre, pan, zoom (fit × zoom), rotate, flip.
  const matrix = useCallback(() => {
    const c = canvas.current;
    const rotated = view.rot % 180 !== 0;
    const fit = Math.min(c.width / (rotated ? img.height : img.width), c.height / (rotated ? img.width : img.height));
    const s = fit * view.zoom;
    return new DOMMatrix().translate(c.width / 2 + view.x, c.height / 2 + view.y).rotate(view.rot).scale(view.flip ? -s : s, s).translate(-img.width / 2, -img.height / 2);
  }, [img, view]);

  const lengthMm = (a) => {
    const px = Math.hypot(a.points[1][0] - a.points[0][0], a.points[1][1] - a.points[0][1]);
    return mm ? `${(px * mm).toFixed(1)} mm` : `${Math.round(px)} px`;
  };

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.current.clientWidth;
    const hgt = wrap.current.clientHeight;
    if (c.width !== w * ratio || c.height !== hgt * ratio) { c.width = w * ratio; c.height = hgt * ratio; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, c.width, c.height);
    const m = matrix();
    ctx.setTransform(m);
    ctx.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%)${adj.invert ? ' invert(1)' : ''}`;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    // Annotations: drawn in screen space from image points so lines stay crisp at any zoom.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = ([x, y]) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; };
    const all = draft ? [...notes, draft] : notes;
    for (const a of all) {
      ctx.strokeStyle = a.color || '#facc15';
      ctx.fillStyle = a.color || '#facc15';
      ctx.lineWidth = 2 * ratio;
      ctx.font = `${13 * ratio}px system-ui, sans-serif`;
      const [p0, p1] = [toScreen(a.points[0]), a.points[1] ? toScreen(a.points[1]) : null];
      if (a.type === 'text') {
        ctx.fillText(a.text || '', p0[0] + 6 * ratio, p0[1] - 6 * ratio);
        ctx.beginPath(); ctx.arc(p0[0], p0[1], 3 * ratio, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (!p1) continue;
      if (a.type === 'circle') {
        ctx.beginPath(); ctx.arc(p0[0], p0[1], Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
      if (a.type === 'arrow') {
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        for (const d of [-0.45, 0.45]) { ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(p1[0] - 12 * ratio * Math.cos(ang + d), p1[1] - 12 * ratio * Math.sin(ang + d)); ctx.stroke(); }
      }
      if (a.type === 'measure' || a.type === 'calibrate') {
        for (const p of [p0, p1]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3 * ratio, 0, Math.PI * 2); ctx.fill(); }
        const label = a.type === 'calibrate' ? 'calibrate' : lengthMm(a);
        ctx.lineWidth = 3 * ratio;
        ctx.strokeStyle = 'rgba(0,0,0,.7)';
        ctx.strokeText(label, (p0[0] + p1[0]) / 2 + 6 * ratio, (p0[1] + p1[1]) / 2 - 6 * ratio);
        ctx.fillText(label, (p0[0] + p1[0]) / 2 + 6 * ratio, (p0[1] + p1[1]) / 2 - 6 * ratio);
      }
    }
  }, [img, adj, notes, draft, matrix, mm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [draw]);

  const toImage = (e) => {
    const r = canvas.current.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const p = matrix().inverse().transformPoint(new DOMPoint((e.clientX - r.left) * ratio, (e.clientY - r.top) * ratio));
    return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  };

  const down = (e) => {
    if (!img) return;
    canvas.current.setPointerCapture(e.pointerId);
    if (tool === 'pan' || e.button === 1) { drag.current = { x: e.clientX, y: e.clientY, view }; return; }
    if (tool === 'text') {
      const text = window.prompt('Note');
      if (text) { setNotes([...notes, { type: 'text', points: [toImage(e)], text }]); setDirty(true); }
      return;
    }
    const p = toImage(e);
    setDraft({ type: tool, points: [p, p], color: tool === 'calibrate' ? '#38bdf8' : '#facc15' });
  };
  const move = (e) => {
    if (drag.current) {
      const ratio = window.devicePixelRatio || 1;
      setView({ ...drag.current.view, x: drag.current.view.x + (e.clientX - drag.current.x) * ratio, y: drag.current.view.y + (e.clientY - drag.current.y) * ratio });
    } else if (draft) setDraft({ ...draft, points: [draft.points[0], toImage(e)] });
  };
  const up = () => {
    drag.current = null;
    if (!draft) return;
    const d = draft;
    setDraft(null);
    const px = Math.hypot(d.points[1][0] - d.points[0][0], d.points[1][1] - d.points[0][1]);
    if (px < 2) return;
    if (d.type === 'calibrate') {
      const v = window.prompt('How long is that line, in millimetres? (e.g. a known implant or file length)');
      if (v && Number(v) > 0) { setMm(Number(v) / px); setScaleSource('calibrated'); setDirty(true); }
      return;
    }
    setNotes([...notes, d]);
    setDirty(true);
  };
  const wheel = (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const r = canvas.current.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const cx = (e.clientX - r.left) * ratio - canvas.current.width / 2;
    const cy = (e.clientY - r.top) * ratio - canvas.current.height / 2;
    setView((v) => {
      const zoom = Math.min(20, Math.max(0.2, v.zoom * f));
      const k = zoom / v.zoom;
      return { ...v, zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };
  useEffect(() => {
    const c = canvas.current;
    if (!c) return undefined;
    c.addEventListener('wheel', wheel, { passive: false });
    return () => c.removeEventListener('wheel', wheel);
  });

  const save = async () => {
    try {
      await api.put(`/documents/${doc.id}/annotations`, { annotations: notes, ...(scaleSource === 'calibrated' ? { mm_per_px: mm } : {}) });
      setDirty(false);
    } catch (e) { setError(e); }
  };

  return (
    <div className="image-viewer">
      <div className="viewer-toolbar">
        {TOOLS.filter(([k]) => canEdit || k === 'pan' || k === 'measure').map(([k, icon, title]) => (
          <button key={k} type="button" className={`small${tool === k ? ' primary' : ''}`} title={title} onClick={() => setTool(k)}>{icon}{compact ? '' : ` ${title.split(' (')[0]}`}</button>
        ))}
        <span className="viewer-sep" />
        <button type="button" className="small" title="Zoom in" onClick={() => setView({ ...view, zoom: Math.min(20, view.zoom * 1.25) })}>＋</button>
        <button type="button" className="small" title="Zoom out" onClick={() => setView({ ...view, zoom: Math.max(0.2, view.zoom / 1.25) })}>－</button>
        <button type="button" className="small" title="Rotate" onClick={() => setView({ ...view, rot: (view.rot + 90) % 360 })}>⟳</button>
        <button type="button" className="small" title="Flip" onClick={() => setView({ ...view, flip: !view.flip })}>⇋</button>
        <button type="button" className={`small${adj.invert ? ' primary' : ''}`} title="Invert" onClick={() => setAdj({ ...adj, invert: !adj.invert })}>◐</button>
        <button type="button" className="small" title="Reset view" onClick={() => { setView({ zoom: 1, x: 0, y: 0, rot: 0, flip: false }); setAdj({ brightness: 100, contrast: 100, invert: false }); }}>Reset</button>
        <label className="viewer-slider" title="Brightness">☀<input type="range" min="30" max="200" value={adj.brightness} onChange={(e) => setAdj({ ...adj, brightness: Number(e.target.value) })} /></label>
        <label className="viewer-slider" title="Contrast">◑<input type="range" min="30" max="300" value={adj.contrast} onChange={(e) => setAdj({ ...adj, contrast: Number(e.target.value) })} /></label>
        {canEdit && notes.length > 0 && <button type="button" className="small" title="Undo last mark" onClick={() => { setNotes(notes.slice(0, -1)); setDirty(true); }}>↶</button>}
        {canEdit && dirty && <button type="button" className="small primary" onClick={save}>Save marks</button>}
      </div>
      <ErrorBox error={error} />
      <div ref={wrap} className="viewer-canvas" style={{ height }}>
        {!img && !error && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
        <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} style={{ cursor: tool === 'pan' ? 'grab' : 'crosshair', width: '100%', height: '100%' }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {img ? `${img.width}×${img.height}px · ` : ''}{mm ? `${(1 / mm).toFixed(1)} px/mm (${scaleSource === 'dicom' ? 'from the sensor' : 'calibrated'})` : 'Not calibrated — measurements are in pixels; use Calibrate with a known length.'}
        {' · '}Scroll to zoom, drag to move.
      </div>
    </div>
  );
}
