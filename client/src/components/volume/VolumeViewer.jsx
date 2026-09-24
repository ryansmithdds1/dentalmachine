import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair, Contrast, Hand, ZoomIn, Ruler, Spline, Camera, RotateCcw, Maximize2, Minimize2, X, Trash2, Box, TriangleAlert, Keyboard, SunMoon,
} from 'lucide-react';
import {
  parseVolume, VIEWS, sliceCount, extractSlice, cursorToView, viewToCursor, sliceOf, withSlice, makeLut, toImageData, presets, autoWindow,
  paneTransform, mmBetween, panoramic, clamp,
} from './mpr.js';
import { createVolumeRenderer, DEFAULT_CAMERA } from './volren.js';
import { fetchBinary, saveSnapshot, canvasToBlob } from './net.js';
import './volume.css';

// CBCT viewer: axial, coronal and sagittal slices side by side with linked crosshairs, a 3D rendering
// (surface, volume or maximum-intensity) and a panoramic reconstruction along an arch drawn on the
// axial view. Distances are in mm from the DICOM voxel spacing. Nothing here changes the scan;
// measurements live on screen, and a snapshot saves a picture of the screen to the chart.

const TOOLS = [
  ['crosshair', Crosshair, 'Point (move the crosshairs)', 'c'],
  ['wl', Contrast, 'Brightness / contrast (drag)', 'w'],
  ['pan', Hand, 'Move', 'p'],
  ['zoom', ZoomIn, 'Zoom (drag up/down)', 'z'],
  ['measure', Ruler, 'Measure in mm', 'm'],
  ['curve', Spline, 'Draw the arch for the panoramic view', 'a'],
];
const SHORTCUTS = [
  ['Scroll / ↑ ↓', 'Next / previous slice (Shift: 5 at a time)'], ['Ctrl + scroll', 'Zoom'], ['Right-drag', 'Brightness / contrast'],
  ['Middle-drag', 'Move'], ['1 – 5', 'Presets'], ['I', 'Invert'], ['C W P Z M A', 'Tools'], ['F or double-click', 'Enlarge a view'],
  ['R', 'Reset zoom'], ['Delete', 'Remove the last measurement'], ['Esc', 'Cancel / close'],
];
const NEUTRAL_VIEW = { zoom: 1, px: 0, py: 0 };
const PANES = ['axial', 'coronal', 'sagittal'];

export default function VolumeViewer({ documentId, info = null, canEdit = false, onClose, onSaved, height = '100%' }) {
  const root = useRef(null);
  const grid = useRef(null);
  const [vol, setVol] = useState(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState(null);
  const [cursor, setCursor] = useState([0, 0, 0]);
  const [wl, setWl] = useState({ center: 500, width: 2000 });
  const [preset, setPreset] = useState('auto');
  const [invert, setInvert] = useState(false);
  const [tool, setTool] = useState('crosshair');
  const [views, setViews] = useState({ axial: NEUTRAL_VIEW, coronal: NEUTRAL_VIEW, sagittal: NEUTRAL_VIEW, pano: NEUTRAL_VIEW });
  const [active, setActive] = useState('axial');
  const [maxed, setMaxed] = useState(null);
  const [measures, setMeasures] = useState([]);
  const [curve, setCurve] = useState([]);
  const [curveOpen, setCurveOpen] = useState(false);
  const [slab, setSlab] = useState(14);
  const [fourth, setFourth] = useState('3d');
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  // ---- Load ----
  useEffect(() => {
    let live = true;
    setVol(null);
    setError(null);
    fetchBinary(`/documents/${documentId}/volume`, (n) => live && setLoaded(n))
      .then(({ buffer }) => {
        if (!live) return;
        const v = parseVolume(buffer);
        setVol(v);
        setCursor([Math.floor(v.nx / 2), Math.floor(v.ny / 2), Math.floor(v.nz / 2)]);
        setWl(autoWindow(v));
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [documentId]);
  useEffect(() => { root.current?.focus(); }, [vol]);

  const lut = useMemo(() => makeLut(wl, invert), [wl, invert]);
  const presetList = useMemo(() => (vol ? presets(vol) : []), [vol]);
  const applyPreset = (p) => { setPreset(p.key); setWl({ center: p.center, width: p.width }); };
  const changeWl = useCallback((next) => { setPreset(null); setWl(next); }, []);

  const pano = useMemo(() => (vol && curve.length >= 2 ? panoramic(vol, curve, { thickness: slab }) : null), [vol, curve, slab]);
  useEffect(() => { if (pano && !curveOpen) setFourth('pano'); }, [pano, curveOpen]);

  const scroll = useCallback((view, delta) => {
    if (!vol || view === 'pano') return;
    setCursor((c) => withSlice(view, c, sliceOf(view, c) + delta, vol));
  }, [vol]);
  const setView = useCallback((view, next) => setViews((v) => ({ ...v, [view]: typeof next === 'function' ? next(v[view]) : next })), []);
  const addMeasure = useCallback((m) => setMeasures((list) => [...list, { ...m, id: Date.now() + Math.random() }]), []);

  // ---- Keyboard ----
  const onKey = (e) => {
    if (!vol || e.target.closest?.('input, select, textarea')) return;
    const k = e.key;
    if (['ArrowUp', 'PageUp', 'ArrowRight'].includes(k)) { scroll(active, e.shiftKey ? 5 : 1); e.preventDefault(); return; }
    if (['ArrowDown', 'PageDown', 'ArrowLeft'].includes(k)) { scroll(active, e.shiftKey ? -5 : -1); e.preventDefault(); return; }
    if (/^[1-5]$/.test(k) && presetList[Number(k) - 1]) { applyPreset(presetList[Number(k) - 1]); return; }
    const t = TOOLS.find((x) => x[3] === k.toLowerCase());
    if (t && !e.ctrlKey && !e.metaKey) { setTool(t[0]); if (t[0] === 'curve') startCurve(); return; }
    if (k === 'i' || k === 'I') setInvert((x) => !x);
    else if (k === 'f' || k === 'F') setMaxed((m) => (m ? null : active));
    else if (k === 'r' || k === 'R') setViews({ axial: NEUTRAL_VIEW, coronal: NEUTRAL_VIEW, sagittal: NEUTRAL_VIEW, pano: NEUTRAL_VIEW });
    else if (k === 'Delete' || k === 'Backspace') setMeasures((l) => l.slice(0, -1));
    else if (k === '?') setHelp((h) => !h);
    else if (k === 'Escape') {
      if (curveOpen) finishCurve();
      else if (help) setHelp(false);
      else if (maxed) setMaxed(null);
      else onClose?.();
    } else return;
    e.preventDefault();
  };

  const startCurve = () => { setCurve([]); setCurveOpen(true); setTool('curve'); setActive('axial'); setFourth('pano'); };
  const finishCurve = () => { setCurveOpen(false); setTool('crosshair'); };

  // ---- Snapshot: the four views (or the enlarged one) as one PNG, saved to the patient's documents ----
  const snapshot = async () => {
    const box = grid.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.round(box.width * dpr);
    out.height = Math.round(box.height * dpr);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of grid.current.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (!r.width) continue;
      ctx.drawImage(c, (r.left - box.left) * dpr, (r.top - box.top) * dpr, r.width * dpr, r.height * dpr);
    }
    setSaving(true);
    try {
      const doc = await saveSnapshot(documentId, await canvasToBlob(out), maxed ? (VIEWS[maxed]?.label || (maxed === 'pano' ? 'Panoramic' : '3D')) : 'CBCT views');
      setNotice(`Saved to documents as “${doc.filename}”`);
      onSaved?.(doc);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="vv vv-center" style={{ height }}>
        <div className="vv-error"><TriangleAlert size={20} /> {error}</div>
        {onClose && <button type="button" className="vv-btn" onClick={onClose}>Close</button>}
      </div>
    );
  }
  if (!vol) {
    return (
      <div className="vv vv-center" style={{ height }}>
        <div className="vv-loading">
          <div className="vv-spinner" />
          <div>Opening the CBCT…</div>
          <div className="vv-muted">{loaded ? `${(loaded / 1048576).toFixed(1)} MB received` : 'Preparing the volume on the server'}</div>
          {info?.dims && <div className="vv-muted">{info.dims.join(' × ')} voxels · {info.slices} slices</div>}
        </div>
      </div>
    );
  }

  const spacing = vol.spacing.map((s) => (Math.round(s * 1000) / 1000)).join(' × ');
  const warnings = [...(vol.warnings || [])];
  if (vol.step > 1) warnings.push(`Shown at 1/${vol.step} resolution (${vol.sourceDims.join(' × ')} voxels in the file) to fit in the browser.`);
  const paneProps = { vol, cursor, lut, wl, tool, measures, onCursor: setCursor, onScroll: scroll, onWl: changeWl, onView: setView, onMeasure: addMeasure, onActivate: setActive };
  const shown = (key) => !maxed || maxed === key;

  return (
    <div className="vv" style={{ height }} ref={root} tabIndex={0} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <div className="vv-bar">
        <div className="vv-title">
          <strong>{info?.filename || 'CBCT'}</strong>
          <span className="vv-muted">{vol.dims.join(' × ')} · {spacing} mm voxels{vol.units === 'HU' ? ' · HU' : ''}</span>
        </div>
        <div className="vv-group" role="toolbar" aria-label="Tools">
          {TOOLS.map(([key, Icon, label, hot]) => (
            <button key={key} type="button" className={`vv-icon${tool === key ? ' on' : ''}`} title={`${label} (${hot.toUpperCase()})`} aria-label={label} aria-pressed={tool === key}
              onClick={() => (key === 'curve' ? startCurve() : setTool(key))}><Icon size={17} /></button>
          ))}
        </div>
        <div className="vv-group" aria-label="Presets">
          {presetList.map((p, n) => (
            <button key={p.key} type="button" className={`vv-chip${preset === p.key ? ' on' : ''}`} title={`${p.label} (${n + 1})`} onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
          <button type="button" className={`vv-icon${invert ? ' on' : ''}`} title="Invert (I)" aria-pressed={invert} onClick={() => setInvert((x) => !x)}><SunMoon size={17} /></button>
        </div>
        <div className="vv-group vv-right">
          <span className="vv-wl">W {Math.round(wl.width)} · L {Math.round(wl.center)}</span>
          <button type="button" className="vv-icon" title="Reset zoom (R)" onClick={() => setViews({ axial: NEUTRAL_VIEW, coronal: NEUTRAL_VIEW, sagittal: NEUTRAL_VIEW, pano: NEUTRAL_VIEW })}><RotateCcw size={17} /></button>
          <button type="button" className="vv-icon" title="Keyboard shortcuts (?)" onClick={() => setHelp((h) => !h)}><Keyboard size={17} /></button>
          {canEdit && <button type="button" className="vv-btn" disabled={saving} onClick={snapshot} title="Save a picture of these views to the patient’s documents"><Camera size={16} /> {saving ? 'Saving…' : 'Snapshot'}</button>}
          {onClose && <button type="button" className="vv-icon" title="Close (Esc)" aria-label="Close" onClick={onClose}><X size={18} /></button>}
        </div>
      </div>
      {warnings.length > 0 && <div className="vv-warn"><TriangleAlert size={15} /> {warnings.join(' ')}</div>}
      {notice && <div className="vv-notice" role="status">{notice} <button type="button" className="vv-link" onClick={() => setNotice(null)}>OK</button></div>}

      <div className={`vv-grid${maxed ? ' maxed' : ''}`} ref={grid}>
        {PANES.map((key) => shown(key) && (
          <SlicePane key={key} view={key} {...paneProps} viewState={views[key]} active={active === key} maxed={maxed === key}
            onToggleMax={() => setMaxed((m) => (m ? null : key))}
            curve={key === 'axial' ? curve : null} curveOpen={curveOpen}
            onCurvePoint={(p) => setCurve((c) => [...c, p])} onCurveDone={finishCurve} />
        ))}
        {shown(fourth === 'pano' ? 'pano' : '3d') && (
          <div className="vv-pane vv-fourth">
            <div className="vv-tabs">
              <button type="button" className={fourth === '3d' ? 'on' : ''} onClick={() => { setFourth('3d'); if (maxed) setMaxed('3d'); }}><Box size={14} /> 3D</button>
              <button type="button" className={fourth === 'pano' ? 'on' : ''} onClick={() => { setFourth('pano'); if (maxed) setMaxed('pano'); }}><Spline size={14} /> Panoramic</button>
            </div>
            {fourth === '3d' ? (
              <View3D vol={vol} wl={wl} invert={invert} maxed={maxed === '3d'} onToggleMax={() => setMaxed((m) => (m ? null : '3d'))} />
            ) : pano ? (
              <>
                <SlicePane view="pano" pano={pano} {...paneProps} viewState={views.pano} active={active === 'pano'} maxed={maxed === 'pano'} onToggleMax={() => setMaxed((m) => (m ? null : 'pano'))} embedded />
                <div className="vv-pano-tools">
                  <label>Slab {slab} mm <input type="range" min="1" max="40" value={slab} onChange={(e) => setSlab(Number(e.target.value))} /></label>
                  <button type="button" className="vv-link" onClick={startCurve}>Redraw the arch</button>
                </div>
              </>
            ) : (
              <div className="vv-hint">
                <Spline size={28} />
                <p><strong>Panoramic view</strong></p>
                <p>{curveOpen ? `Click along the middle of the teeth on the axial view (${curve.length} point${curve.length === 1 ? '' : 's'}). Double-click or press Esc to finish.` : 'Draw the arch on the axial view: click along the middle of the teeth from one side to the other.'}</p>
                {!curveOpen && <button type="button" className="vv-btn" onClick={startCurve}><Spline size={15} /> Draw the arch</button>}
              </div>
            )}
          </div>
        )}
      </div>

      {measures.length > 0 && (
        <div className="vv-measures">
          <Ruler size={14} />
          {measures.map((m, n) => (
            <span key={m.id} className="vv-measure" title={`${VIEWS[m.view]?.label || 'Panoramic'} slice ${m.slice + 1}`}>
              {n + 1}. {m.mm.toFixed(1)} mm <span className="vv-muted">{VIEWS[m.view]?.label || 'Pano'} {m.view !== 'pano' ? m.slice + 1 : ''}</span>
              <button type="button" aria-label="Remove" onClick={() => setMeasures((l) => l.filter((x) => x.id !== m.id))}><Trash2 size={12} /></button>
            </span>
          ))}
          <span className="vv-muted">Measurements aren’t saved — take a snapshot to keep them.</span>
        </div>
      )}
      {help && (
        <div className="vv-help" onClick={() => setHelp(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <strong>Shortcuts</strong>
            <table><tbody>{SHORTCUTS.map(([a, b]) => <tr key={a}><td><kbd>{a}</kbd></td><td>{b}</td></tr>)}</tbody></table>
            <button type="button" className="vv-btn" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One slice view (or the panoramic image): canvas, crosshairs, measurements, mouse handling.
// ---------------------------------------------------------------------------------------------
function SlicePane({ view, vol, pano, cursor, lut, wl, tool, measures, viewState, active, maxed, embedded, curve, curveOpen, onCursor, onScroll, onWl, onView, onMeasure, onActivate, onToggleMax, onCurvePoint, onCurveDone }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const drag = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState(null);
  const [hover, setHover] = useState(null);
  const isPano = view === 'pano';
  const index = isPano ? 0 : sliceOf(view, cursor);
  const slice = useMemo(() => (isPano ? pano : extractSlice(vol, view, index)), [vol, view, index, pano, isPano]);
  const color = isPano ? '#fbbf24' : VIEWS[view].color;

  // The slice at its own resolution, redrawn only when the slice or the window changes.
  const image = useMemo(() => {
    if (!slice) return null;
    const c = document.createElement('canvas');
    c.width = slice.w;
    c.height = slice.h;
    const ctx = c.getContext('2d');
    ctx.putImageData(toImageData(slice, lut, ctx), 0, 0);
    return c;
  }, [slice, lut]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const transform = useMemo(() => (slice && size.w ? paneTransform(slice, size.w, size.h, viewState) : null), [slice, size, viewState]);

  // ---- Draw ----
  useEffect(() => {
    const c = canvas.current;
    if (!c || !transform || !image) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.imageSmoothingEnabled = transform.scale * slice.su < 6;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, transform.ox, transform.oy, transform.dw, transform.dh);

    // Crosshairs: where the other planes cut this one, in their colours, with a gap at the centre.
    const lines = [];
    if (!isPano) {
      const [u, v] = cursorToView(view, cursor, vol);
      const others = PANES.filter((p) => p !== view);
      // A vertical line is the plane whose axis runs across this view; horizontal, the one down it.
      const across = view === 'sagittal' ? 'coronal' : 'sagittal';
      const down = others.find((p) => p !== across);
      lines.push({ vertical: true, at: u + 0.5, color: VIEWS[across].color }, { vertical: false, at: v + 0.5, color: VIEWS[down].color });
    } else if (slice.columns) {
      lines.push({ vertical: false, at: vol.nz - 1 - cursor[2] + 0.5, color: VIEWS.axial.color });
      let best = -1;
      let bestD = Infinity;
      slice.columns.forEach(([x, y], n) => { const d = Math.hypot((x - cursor[0]) * vol.spacing[0], (y - cursor[1]) * vol.spacing[1]); if (d < bestD) { bestD = d; best = n; } });
      if (bestD < 4) lines.push({ vertical: true, at: best + 0.5, color: '#e2e8f0' });
    }
    const [cx, cy] = isPano ? [null, null] : transform.toScreen(...cursorToView(view, cursor, vol).map((x) => x + 0.5));
    ctx.lineWidth = 1;
    for (const l of lines) {
      ctx.strokeStyle = l.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      if (l.vertical) {
        const [x] = transform.toScreen(l.at, 0);
        if (cy == null) { ctx.moveTo(x, 0); ctx.lineTo(x, size.h); } else { ctx.moveTo(x, 0); ctx.lineTo(x, cy - 12); ctx.moveTo(x, cy + 12); ctx.lineTo(x, size.h); }
      } else {
        const [, y] = transform.toScreen(0, l.at);
        if (cx == null) { ctx.moveTo(0, y); ctx.lineTo(size.w, y); } else { ctx.moveTo(0, y); ctx.lineTo(cx - 12, y); ctx.moveTo(cx + 12, y); ctx.lineTo(size.w, y); }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The arch being drawn for the panoramic view.
    if (curve?.length) {
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      curve.forEach((p, n) => { const [x, y] = transform.toScreen(p[0] + 0.5, p[1] + 0.5); if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      for (const p of curve) { const [x, y] = transform.toScreen(p[0] + 0.5, p[1] + 0.5); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
    }

    // Measurements on this slice.
    const mine = measures.filter((m) => m.view === view && m.slice === index);
    for (const m of [...mine, ...(draft ? [draft] : [])]) drawMeasure(ctx, transform, m, slice);

    // Labels (drawn on the canvas so snapshots carry them).
    ctx.font = '600 12px Inter Variable, system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    const title = isPano ? `Panoramic · ${slice.w * slice.su | 0} mm arch` : `${VIEWS[view].label}  ${index + 1} / ${sliceCount(vol, view)}`;
    ctx.fillText(title, 10, embedded ? 36 : 9);
    ctx.font = '11px Inter Variable, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,0.75)';
    const orient = { axial: ['A', 'P', 'R', 'L'], coronal: ['S', 'I', 'R', 'L'], sagittal: ['S', 'I', 'A', 'P'], pano: ['S', 'I', 'R', 'L'] }[view];
    ctx.textAlign = 'center';
    ctx.fillText(orient[0], size.w / 2, embedded ? 36 : 9);
    ctx.textBaseline = 'bottom';
    ctx.fillText(orient[1], size.w / 2, size.h - 8);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(orient[2], 8, size.h / 2);
    ctx.textAlign = 'right';
    ctx.fillText(orient[3], size.w - 8, size.h / 2);
    // Scale bar.
    const mmPx = transform.scale;
    const barMm = [1, 2, 5, 10, 20, 50].find((m) => m * mmPx > 50) || 50;
    ctx.strokeStyle = 'rgba(226,232,240,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size.w - 14 - barMm * mmPx, size.h - 14); ctx.lineTo(size.w - 14, size.h - 14);
    ctx.stroke();
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${barMm} mm`, size.w - 14, size.h - 18);
    ctx.textAlign = 'left';
    if (hover) ctx.fillText(hover, 10, size.h - 8);
  }, [image, transform, cursor, measures, draft, curve, hover, size, vol, view, index, isPano, slice, color, embedded]);

  // ---- Mouse ----
  const imagePoint = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return transform.toImage(e.clientX - r.left, e.clientY - r.top);
  };
  const pointToCursor = ([u, v]) => {
    if (!isPano) return viewToCursor(view, [u, v], cursor, vol);
    const col = slice.columns[clamp(Math.floor(u), 0, slice.w - 1)];
    return [clamp(Math.round(col[0]), 0, vol.nx - 1), clamp(Math.round(col[1]), 0, vol.ny - 1), clamp(Math.round(vol.nz - 1 - v), 0, vol.nz - 1)];
  };
  const inside = ([u, v]) => u >= 0 && v >= 0 && u < slice.w && v < slice.h;

  const down = (e) => {
    if (!transform) return;
    onActivate(view);
    canvas.current.setPointerCapture(e.pointerId);
    const mode = e.button === 2 ? 'wl' : e.button === 1 ? 'pan' : tool === 'curve' && view !== 'axial' ? 'crosshair' : tool;
    const p = imagePoint(e);
    drag.current = { mode, x: e.clientX, y: e.clientY, p, wl, view: viewState, moved: false };
    if (mode === 'crosshair' && inside(p)) onCursor(pointToCursor(p));
    if (mode === 'measure' && inside(p)) setDraft({ view, slice: index, a: p, b: p, mm: 0 });
    e.preventDefault();
  };
  const move = (e) => {
    if (!transform) return;
    const p = imagePoint(e);
    if (inside(p)) {
      const u = Math.floor(p[0]);
      const v = Math.floor(p[1]);
      const val = slice.values[v * slice.w + u];
      setHover(`${vol.units === 'HU' ? 'HU' : 'Value'} ${val}`);
    } else setHover(null);
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === 'crosshair' && inside(p)) onCursor(pointToCursor(p));
    else if (d.mode === 'wl') {
      const k = Math.max(1, d.wl.width) / 250;
      onWl({ center: d.wl.center - dy * k, width: Math.max(1, d.wl.width + dx * k) });
    } else if (d.mode === 'pan') onView(view, { ...d.view, px: d.view.px + dx, py: d.view.py + dy });
    else if (d.mode === 'zoom') onView(view, { ...d.view, zoom: clamp(d.view.zoom * Math.exp(-dy / 150), 0.25, 40) });
    else if (d.mode === 'measure' && draft) setDraft({ ...draft, b: p, mm: mmBetween(draft.a, p, slice.su, slice.sv) });
  };
  const up = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'measure' && draft) {
      if (draft.mm > 0.2) onMeasure(draft);
      setDraft(null);
    }
    if (d.mode === 'curve' && view === 'axial' && curveOpen && !d.moved && e.detail < 2) {
      const p = imagePoint(e);
      if (inside(p)) onCurvePoint(p);
    }
  };
  const dbl = () => {
    if (tool === 'curve' && curveOpen && view === 'axial') onCurveDone();
    else onToggleMax();
  };

  // Wheel: slices (Ctrl: zoom about the pointer). Registered by hand so it can stop the page scrolling.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return undefined;
    const wheel = (e) => {
      e.preventDefault();
      if (!transform) return;
      if (e.ctrlKey || e.metaKey || isPano) {
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const f = Math.exp(-e.deltaY / 400);
        onView(view, (v) => {
          const zoom = clamp(v.zoom * f, 0.25, 40);
          const g = zoom / v.zoom;
          // Keep the point under the pointer still.
          const cxp = size.w / 2 + v.px;
          const cyp = size.h / 2 + v.py;
          return { zoom, px: v.px + (mx - cxp) * (1 - g), py: v.py + (my - cyp) * (1 - g) };
        });
      } else onScroll(view, (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 5 : 1));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [transform, view, isPano, onScroll, onView, size]);

  const cursorStyle = tool === 'pan' ? 'grab' : tool === 'wl' ? 'ns-resize' : tool === 'zoom' ? 'zoom-in' : 'crosshair';
  return (
    <div className={`vv-pane${active ? ' active' : ''}${embedded ? ' embedded' : ''}`} style={{ '--pane': color }}>
      <div className="vv-canvas" ref={wrap}>
        <canvas ref={canvas} style={{ cursor: cursorStyle }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => setHover(null)} onDoubleClick={dbl}
          aria-label={isPano ? 'Panoramic reconstruction' : `${VIEWS[view].label} slice ${index + 1}`} role="img" />
      </div>
      {!embedded && (
        <button type="button" className="vv-max" title={maxed ? 'Back to four views (F)' : 'Enlarge (F)'} onClick={onToggleMax}>{maxed ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      )}
    </div>
  );
}

function drawMeasure(ctx, t, m, slice) {
  const [ax, ay] = t.toScreen(m.a[0], m.a[1]);
  const [bx, by] = t.toScreen(m.b[0], m.b[1]);
  ctx.strokeStyle = '#facc15';
  ctx.fillStyle = '#facc15';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  for (const [x, y] of [[ax, ay], [bx, by]]) {
    const nx = -(by - ay); const ny = bx - ax; const l = Math.hypot(nx, ny) || 1;
    ctx.beginPath(); ctx.moveTo(x - (nx / l) * 5, y - (ny / l) * 5); ctx.lineTo(x + (nx / l) * 5, y + (ny / l) * 5); ctx.stroke();
  }
  const mm = m.mm ?? mmBetween(m.a, m.b, slice.su, slice.sv);
  const label = `${mm.toFixed(1)} mm`;
  ctx.font = '600 12px Inter Variable, system-ui, sans-serif';
  const w = ctx.measureText(label).width + 10;
  const x = (ax + bx) / 2 + 8;
  const y = (ay + by) / 2 - 10;
  ctx.fillStyle = 'rgba(15,23,42,0.85)';
  ctx.fillRect(x, y - 9, w, 18);
  ctx.fillStyle = '#facc15';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 5, y);
}

// ---------------------------------------------------------------------------------------------
// 3D view (WebGL2): drag to turn, Shift/right-drag to move, scroll to zoom.
// ---------------------------------------------------------------------------------------------
const MODES = [['iso', 'Surface'], ['dvr', 'Volume'], ['mip', 'MIP']];
const ANGLES = [['Front', 0, 0.12], ['Right', -Math.PI / 2, 0.1], ['Left', Math.PI / 2, 0.1], ['Top', 0, 1.45], ['Back', Math.PI, 0.12]];

function View3D({ vol, wl, invert, maxed, onToggleMax }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const renderer = useRef(null);
  const drag = useRef(null);
  const [failed, setFailed] = useState(null);
  const [mode, setMode] = useState('iso');
  const [camera, setCamera] = useState(DEFAULT_CAMERA);
  const [quality, setQuality] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const s = vol.stats || {};
  const isoRange = [s.p50 ?? 0, s.max ?? 3000];
  const [iso, setIso] = useState(() => (vol.units === 'HU' ? clamp(1100, isoRange[0], isoRange[1]) : Math.round(isoRange[0] + (isoRange[1] - isoRange[0]) * 0.45)));
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    try {
      renderer.current = createVolumeRenderer(canvas.current);
      if (!renderer.current) setFailed('This browser can’t show 3D (WebGL2 is off or unsupported). The slice views still work.');
      else renderer.current.setVolume(vol);
    } catch (e) {
      setFailed(`3D view unavailable: ${e.message}`);
    }
    return () => { renderer.current?.dispose(); renderer.current = null; };
  }, [vol]);

  useEffect(() => {
    const el = wrap.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!renderer.current || !size.w) return undefined;
    // Rendered a little below full resolution while turning, full when still.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * (quality < 1 ? 0.6 : 1);
    c.width = Math.max(1, Math.round(size.w * scale));
    c.height = Math.max(1, Math.round(size.h * scale));
    // MIP shows the slice window; the volume look fades in from just under the threshold to the densest tissue.
    const win = mode === 'mip' ? wl : { center: (iso - 250 + (s.max ?? iso + 1000)) / 2, width: Math.max(1, (s.max ?? iso + 1000) - (iso - 250)) };
    const id = requestAnimationFrame(() => renderer.current?.render({ mode, window: win, iso, opacity, camera, quality, invert }));
    return () => cancelAnimationFrame(id);
  }, [mode, wl, iso, opacity, camera, quality, invert, size]);

  const down = (e) => {
    canvas.current.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cam: camera, pan: e.shiftKey || e.button !== 0 };
    setQuality(0.5);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.pan) setCamera({ ...d.cam, panX: d.cam.panX - dx / size.h * d.cam.dist * 0.5, panY: d.cam.panY + dy / size.h * d.cam.dist * 0.5 });
    else setCamera({ ...d.cam, yaw: d.cam.yaw - dx * 0.008, pitch: clamp(d.cam.pitch + dy * 0.008, -1.5, 1.5) });
  };
  const up = () => { drag.current = null; setQuality(1); };
  useEffect(() => {
    const el = canvas.current;
    const wheel = (e) => { e.preventDefault(); setCamera((c) => ({ ...c, dist: clamp(c.dist * Math.exp(e.deltaY / 500), 0.6, 8) })); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div className="vv-3d">
      <div className="vv-canvas" ref={wrap}>
        <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={onToggleMax} role="img" aria-label="3D rendering of the scan" style={{ cursor: 'grab' }} />
        {failed && <div className="vv-hint"><TriangleAlert size={22} /><p>{failed}</p></div>}
      </div>
      <div className="vv-3d-tools">
        <div className="vv-seg">
          {MODES.map(([k, label]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{label}</button>)}
        </div>
        {mode !== 'mip' && (
          <label title="The density shown from: higher shows only teeth, lower shows bone too">
            {mode === 'iso' ? 'Surface at' : 'Show from'} {Math.round(iso)}{vol.units === 'HU' ? ' HU' : ''}
            <input type="range" min={isoRange[0]} max={isoRange[1]} value={iso} onChange={(e) => setIso(Number(e.target.value))} />
          </label>
        )}
        {mode === 'dvr' && <label>Opacity <input type="range" min="0.1" max="3" step="0.1" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>}
        {mode === 'mip' && <span className="vv-muted">Uses the slice brightness / contrast</span>}
        <div className="vv-seg">
          {ANGLES.map(([label, yaw, pitch]) => <button key={label} type="button" onClick={() => setCamera({ ...DEFAULT_CAMERA, yaw, pitch })}>{label}</button>)}
        </div>
      </div>
      <button type="button" className="vv-max" title={maxed ? 'Back to four views' : 'Enlarge'} onClick={onToggleMax}>{maxed ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
    </div>
  );
}
