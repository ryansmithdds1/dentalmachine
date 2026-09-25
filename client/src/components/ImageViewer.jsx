import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Hand, Ruler, Spline, DraftingCompass, MoveUpRight, Circle, Type, Eraser, Crosshair, ZoomIn, ZoomOut, RotateCw, ArrowLeftRight,
  Contrast, Search, SlidersHorizontal, Maximize, Minimize, Undo2, Save, Keyboard,
  ScanSearch,
} from 'lucide-react';
import { api, getToken } from '../api.js';
import { ErrorBox } from './ui.jsx';
import { useAuth } from '../auth.jsx';
import { AI_COLOR, DISCLAIMER } from './xray/kinds.js';
import { PRESETS, COLORMAPS, NEUTRAL, withDefaults, compact, renderProcessed, dist, pathLength, angleAt, openPreset, setOpenPreset } from './imaging/imageproc.js';
import { toast } from '../toast.js';

// Diagnostic x-ray / photo viewer. Pixels are enhanced on a copy (gamma, sharpen, auto-levels, false
// colour, emboss) with presets for caries, endo and perio reads; the settings can be saved with the image
// so it opens the same way next time. Marks are stored in image pixels: lengths, canal lengths (a path),
// angles, arrows, circles and notes, in mm from the DICOM pixel spacing or a calibration. A magnifier,
// full screen and keyboard shortcuts cover the rest. Used alone, side by side to compare, or in the studio.

const TOOLS = [
  ['pan', Hand, 'Move', 'p'],
  ['measure', Ruler, 'Measure', 'l'],
  ['polyline', Spline, 'Canal length', 'c'],
  ['angle', DraftingCompass, 'Angle', 'a'],
  ['arrow', MoveUpRight, 'Arrow', 'w'],
  ['circle', Circle, 'Circle', 'o'],
  ['text', Type, 'Note', 't'],
  ['erase', Eraser, 'Erase a mark', 'e'],
  ['calibrate', Crosshair, 'Calibrate (draw a line of known length)', 'k'],
];
const READ_ONLY_TOOLS = ['pan', 'measure', 'polyline', 'angle'];
const MARK = '#facc15';
// AI findings (XR1): a colour per kind (xray/kinds.js); suggestions dashed, accepted solid, dismissed hidden.
// X toggles the overlay, N the confidence on it; a minimum confidence hides weak suggestions (never accepted ones).
const MIN_CONF = [[0, 'All'], [0.5, '50%+'], [0.7, '70%+'], [0.85, '85%+']];

async function loadImage(id) {
  const res = await fetch(`/api/documents/${id}/image`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load the image');
  const url = URL.createObjectURL(await res.blob());
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Could not show the image')); img.src = url; });
  return { img, url };
}

const SHORTCUTS = [
  ['+ / −', 'Zoom'], ['0', 'Fit'], ['R', 'Rotate'], ['H', 'Flip'], ['I', 'Invert'], ['M', 'Magnifier'], ['F', 'Full screen'],
  ['1–5', 'Original · Clarity · Caries · Endo · Perio'], ['P L C A W O T E K', 'Tools'], ['Enter / double-click', 'Finish a canal length'],
  ['Esc', 'Cancel the mark'], ['Ctrl+Z', 'Undo'], ['← →', 'Previous / next image'], ['X', 'AI findings overlay'], ['N', 'AI confidence on the overlay'], ['?', 'These shortcuts'],
];

export default function ImageViewer({ doc, canEdit = false, height = '70vh', compact: small = false, onPrev, onNext, onSaved, dark = false, autoFocus = false }) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const root = useRef(null);
  const cache = useRef({});
  const loupe = useRef(null);
  const drag = useRef(null);
  const [img, setImg] = useState(null);
  const [processed, setProcessed] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [adj, setAdj] = useState(NEUTRAL);
  const [savedAdj, setSavedAdj] = useState(null);
  const [tool, setTool] = useState('pan');
  const [notes, setNotes] = useState([]);
  const [mm, setMm] = useState(null);
  const [scaleSource, setScaleSource] = useState(null);
  const [exposure, setExposure] = useState(null);
  const [agentId, setAgentId] = useState(null);
  const [openWith, setOpenWith] = useState(openPreset);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState(null);
  // A note's text or a calibration length is typed in a box on the image (no browser prompt): { kind, p | px, value }.
  const [ask, setAsk] = useState(null);
  const [sensorScale, setSensorScale] = useState(null); // offer to keep a calibration for the sensor
  const [magnify, setMagnify] = useState(false);
  const [panel, setPanel] = useState(false);
  const [help, setHelp] = useState(false);
  const [full, setFull] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);
  const [ai, setAi] = useState(null);
  const [showAi, setShowAi] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiConf, setAiConf] = useState(true);
  const [aiMin, setAiMin] = useState(0);
  // Accepting or dismissing a finding is the dentist's call (clinical:sign); reading an image only needs canEdit.
  const auth = useAuth();
  const canDecide = auth?.can ? auth.can('clinical:sign') : canEdit;
  const aiShown = (f) => f.status !== 'rejected' && (f.status === 'accepted' || (f.confidence ?? 1) >= aiMin);
  const [category, setCategory] = useState(doc.category || null);

  useEffect(() => {
    let url;
    setImg(null);
    setProcessed(null);
    setError(null);
    setDraft(null);
    cache.current = {};
    Promise.all([loadImage(doc.id), api.get(`/documents/${doc.id}/viewer`)]).then(([l, meta]) => {
      url = l.url;
      setImg(l.img);
      setNotes(meta.annotations);
      setMm(meta.mm_per_px);
      setScaleSource(meta.scale_source);
      setExposure(meta.exposure);
      setCategory(meta.category || doc.category || null);
      setAgentId(meta.agent_id);
      // X-rays nobody has saved settings for open with this computer's choice (Clarity unless changed).
      const start = meta.adjust || (meta.category === 'xray' ? PRESETS.find((p) => p.id === openPreset())?.adjust : null) || null;
      setAdj(withDefaults(start));
      setSavedAdj(compact(start));
      setDirty(false);
      setView({ zoom: 1, x: 0, y: 0 });
    }).catch(setError);
    return () => url && URL.revokeObjectURL(url);
  }, [doc.id]);

  // AI findings for x-rays, when the server reads them.
  useEffect(() => { api.get('/xray-ai').then(setAiStatus).catch(() => setAiStatus(null)); }, []);
  useEffect(() => {
    setAi(null);
    if (!aiStatus?.enabled || category !== 'xray') return;
    api.get(`/documents/${doc.id}/ai-findings`).then((f) => { setAi(f); if (f.findings.some((x) => x.status === 'suggested')) setShowAi(true); }).catch(() => {});
  }, [doc.id, category, aiStatus?.enabled]);
  const readAi = async () => {
    setAiBusy(true);
    try { setAi(await api.post(`/documents/${doc.id}/ai-read`)); setShowAi(true); } catch (e) { setError(e); } finally { setAiBusy(false); }
  };
  const decide = async (f, status) => {
    try {
      const next = await api.patch(`/ai-findings/${f.id}`, { status });
      setAi((a) => ({ ...a, findings: a.findings.map((x) => (x.id === f.id ? next : x)) }));
    } catch (e) { setError(e); }
  };

  // Enhancement runs off the main render (a big x-ray takes a moment), newest settings winning.
  useEffect(() => {
    if (!img) return undefined;
    const t = setTimeout(() => {
      try { setProcessed(renderProcessed(img, adj, cache.current)); } catch (e) { setError(e); }
    }, 16);
    return () => clearTimeout(t);
  }, [img, adj.brightness, adj.contrast, adj.gamma, adj.sharpen, adj.denoise, adj.clahe, adj.stretch, adj.invert, adj.equalize, adj.emboss, adj.colormap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Image pixels → screen: centre, pan, zoom (fit × zoom), rotate, flip.
  const matrix = useCallback(() => {
    const c = canvas.current;
    const rotated = adj.rotate % 180 !== 0;
    const fit = Math.min(c.width / (rotated ? img.height : img.width), c.height / (rotated ? img.width : img.height)) * 0.96;
    const s = fit * view.zoom;
    return new DOMMatrix().translate(c.width / 2 + view.x, c.height / 2 + view.y).rotate(adj.rotate).scale(adj.flipH ? -s : s, s).translate(-img.width / 2, -img.height / 2);
  }, [img, view, adj.rotate, adj.flipH]);

  const fmtLen = (px) => (mm ? `${scaleSource === 'estimate' ? '≈' : ''}${(px * mm).toFixed(1)} mm` : `${Math.round(px)} px`);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || !img || !wrap.current) return;
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.current.clientWidth;
    const hgt = wrap.current.clientHeight;
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(hgt * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(hgt * ratio); }
    const ctx = c.getContext('2d');
    const m = matrix();
    const source = processed || img;
    const paint = (t) => {
      ctx.setTransform(t);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, img.width, img.height);
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, c.width, c.height);
    paint(m);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = ([x, y]) => { const p = m.transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; };
    const label = (text, x, y) => {
      ctx.font = `600 ${12 * ratio}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(5,7,12,.78)';
      ctx.beginPath();
      ctx.roundRect(x - 4 * ratio, y - 13 * ratio, tw + 8 * ratio, 18 * ratio, 4 * ratio);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x, y);
    };
    const dot = (p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 3 * ratio, 0, Math.PI * 2); ctx.fill(); };
    const all = draft ? [...notes, draft] : notes;
    for (const a of all) {
      ctx.strokeStyle = a.color || MARK;
      ctx.fillStyle = a.color || MARK;
      ctx.lineWidth = 2 * ratio;
      ctx.lineJoin = 'round';
      const pts = a.points.map(toScreen);
      const [p0, p1] = pts;
      if (a.type === 'text') {
        dot(p0);
        label(a.text || '', p0[0] + 8 * ratio, p0[1] - 6 * ratio);
        continue;
      }
      if (a.type === 'polyline') {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.stroke();
        pts.forEach(dot);
        const end = pts[pts.length - 1];
        if (pts.length > 1) label(fmtLen(pathLength(a.points)), end[0] + 8 * ratio, end[1] + 16 * ratio);
        continue;
      }
      if (a.type === 'angle') {
        ctx.beginPath();
        ctx.moveTo(...p0);
        ctx.lineTo(...p1);
        if (pts[2]) ctx.lineTo(...pts[2]);
        ctx.stroke();
        pts.forEach(dot);
        if (pts[2]) {
          const r = 22 * ratio;
          const s = Math.atan2(p0[1] - p1[1], p0[0] - p1[0]);
          const e = Math.atan2(pts[2][1] - p1[1], pts[2][0] - p1[0]);
          let d = e - s;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          ctx.beginPath();
          ctx.arc(p1[0], p1[1], r, s, s + d, d < 0);
          ctx.stroke();
          label(`${angleAt(...a.points).toFixed(1)}°`, p1[0] + 10 * ratio, p1[1] - 10 * ratio);
        }
        continue;
      }
      if (!p1) continue;
      if (a.type === 'circle') {
        ctx.beginPath(); ctx.arc(p0[0], p0[1], dist(p0, p1), 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
      if (a.type === 'arrow') {
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        for (const d of [-0.45, 0.45]) { ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(p1[0] - 12 * ratio * Math.cos(ang + d), p1[1] - 12 * ratio * Math.sin(ang + d)); ctx.stroke(); }
      }
      if (a.type === 'measure' || a.type === 'calibrate') {
        dot(p0); dot(p1);
        label(a.type === 'calibrate' ? 'known length' : fmtLen(dist(a.points[0], a.points[1])), (p0[0] + p1[0]) / 2 + 8 * ratio, (p0[1] + p1[1]) / 2 - 8 * ratio);
      }
    }
    // AI findings: a box on the image for each, with what and where.
    if (showAi && ai) {
      for (const f of ai.findings) {
        if (!f.box || !aiShown(f)) continue;
        const [bx, by, bw, bh] = f.box;
        const corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(([u, v]) => toScreen([u * img.width, v * img.height]));
        ctx.strokeStyle = AI_COLOR[f.kind] || '#fff';
        ctx.lineWidth = 2 * ratio;
        ctx.setLineDash(f.status === 'accepted' ? [] : [6 * ratio, 4 * ratio]);
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        const top = corners.reduce((a, p) => (p[1] < a[1] ? p : a));
        label(`${f.status === 'accepted' ? '' : 'AI: '}${f.label}${f.tooth ? ` #${f.tooth}` : ''}${f.surfaces ? ` ${f.surfaces}` : ''}${f.measurement_mm ? ` ${f.measurement_mm}mm` : ''}${aiConf ? ` · ${Math.round(f.confidence * 100)}%` : ''}`, top[0], top[1] - 6 * ratio);
      }
    }
    // Magnifier: the same view at 3× inside a circle that follows the pointer.
    if (magnify && loupe.current) {
      const [lx, ly] = loupe.current;
      const r = 90 * ratio;
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#05070c';
      ctx.fillRect(lx - r, ly - r, r * 2, r * 2);
      paint(new DOMMatrix().translate(lx, ly).scale(3).translate(-lx, -ly).multiply(m));
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 2 * ratio;
      ctx.beginPath();
      ctx.arc(lx, ly, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [img, processed, notes, draft, matrix, mm, magnify, showAi, ai, aiConf, aiMin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [draw]);

  const screenPoint = (e) => {
    const r = canvas.current.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    return [(e.clientX - r.left) * ratio, (e.clientY - r.top) * ratio];
  };
  const toImage = (e) => {
    const [sx, sy] = screenPoint(e);
    const p = matrix().inverse().transformPoint(new DOMPoint(sx, sy));
    return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  };
  const addNote = (n) => { setNotes((list) => [...list, n]); setDirty(true); };
  const finishPath = () => {
    if (draft?.type !== 'polyline') return;
    const pts = draft.points.slice(0, -1); // the last point follows the pointer
    setDraft(null);
    if (pts.length >= 2) addNote({ ...draft, points: pts });
  };

  const down = (e) => {
    if (!img) return;
    root.current?.focus({ preventScroll: true });
    if (tool === 'pan' || e.button === 1) {
      canvas.current.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, view };
      return;
    }
    const p = toImage(e);
    if (tool === 'text') {
      setAsk({ kind: 'text', p, value: '' });
      return;
    }
    if (tool === 'erase') {
      // The nearest mark within a few screen pixels of any of its points or segments.
      const m = matrix();
      const [sx, sy] = screenPoint(e);
      const near = (a) => {
        const s = a.points.map(([x, y]) => { const q = m.transformPoint(new DOMPoint(x, y)); return [q.x, q.y]; });
        if (a.type === 'circle' && s[1]) return Math.abs(dist(s[0], [sx, sy]) - dist(s[0], s[1]));
        let best = Math.min(...s.map((q) => dist(q, [sx, sy])));
        for (let i = 1; i < s.length; i++) {
          const [ax, ay] = s[i - 1];
          const [bx, by] = s[i];
          const len = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((sx - ax) * (bx - ax) + (sy - ay) * (by - ay)) / len));
          best = Math.min(best, dist([ax + t * (bx - ax), ay + t * (by - ay)], [sx, sy]));
        }
        return best;
      };
      let hit = -1;
      let bestD = 10 * (window.devicePixelRatio || 1);
      notes.forEach((a, i) => { const d = near(a); if (d < bestD) { bestD = d; hit = i; } });
      if (hit >= 0) { setNotes(notes.filter((_, i) => i !== hit)); setDirty(true); }
      return;
    }
    if (tool === 'polyline') {
      if (e.detail > 1) return; // the double-click that finishes it
      setDraft(draft?.type === 'polyline' ? { ...draft, points: [...draft.points.slice(0, -1), p, p] } : { type: 'polyline', points: [p, p], color: MARK });
      return;
    }
    if (tool === 'angle') {
      if (!draft) setDraft({ type: 'angle', points: [p, p], color: MARK });
      else if (draft.points.length === 2) setDraft({ ...draft, points: [draft.points[0], p, p] });
      else { addNote({ ...draft, points: [draft.points[0], draft.points[1], p] }); setDraft(null); }
      return;
    }
    canvas.current.setPointerCapture(e.pointerId);
    setDraft({ type: tool, points: [p, p], color: tool === 'calibrate' ? '#38bdf8' : MARK });
  };
  const move = (e) => {
    if (magnify) { loupe.current = screenPoint(e); if (!drag.current && !draft) draw(); }
    if (drag.current) {
      const ratio = window.devicePixelRatio || 1;
      setView({ ...drag.current.view, x: drag.current.view.x + (e.clientX - drag.current.x) * ratio, y: drag.current.view.y + (e.clientY - drag.current.y) * ratio });
    } else if (draft) setDraft({ ...draft, points: [...draft.points.slice(0, -1), toImage(e)] });
  };
  const up = () => {
    drag.current = null;
    if (!draft || ['polyline', 'angle'].includes(draft.type)) return;
    const d = draft;
    setDraft(null);
    const px = dist(d.points[0], d.points[1]);
    if (px < 2) return;
    if (d.type === 'calibrate') {
      setAsk({ kind: 'mm', px, value: '' });
      return;
    }
    addNote(d);
  };
  const leave = () => { if (magnify) { loupe.current = null; draw(); } };

  const zoomBy = (f, cx = 0, cy = 0) => setView((v) => {
    const zoom = Math.min(30, Math.max(0.2, v.zoom * f));
    const k = zoom / v.zoom;
    return { ...v, zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  });
  useEffect(() => {
    const c = canvas.current;
    if (!c) return undefined;
    const wheel = (e) => {
      e.preventDefault();
      const [sx, sy] = screenPoint(e);
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, sx - c.width / 2, sy - c.height / 2);
    };
    c.addEventListener('wheel', wheel, { passive: false });
    return () => c.removeEventListener('wheel', wheel);
  });

  const setA = (patch) => setAdj((a) => ({ ...a, ...patch }));
  const applyPreset = (p) => setAdj((a) => ({ ...NEUTRAL, ...p.adjust, rotate: a.rotate, flipH: a.flipH }));
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else root.current?.requestFullscreen?.().catch(() => setFull((f) => !f));
  };
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => { if (autoFocus) root.current?.focus({ preventScroll: true }); }, [autoFocus, doc.id]);

  const sortedJson = (o) => JSON.stringify(o ? Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))) : null);
  const adjDirty = sortedJson(compact(adj)) !== sortedJson(savedAdj);
  const save = async () => {
    setSaving(true);
    try {
      if (dirty) await api.put(`/documents/${doc.id}/annotations`, { annotations: notes, ...(scaleSource === 'calibrated' ? { mm_per_px: mm } : {}) });
      if (adjDirty) {
        const out = await api.put(`/documents/${doc.id}/adjust`, { adjust: compact(adj) });
        setSavedAdj(out.adjust);
        onSaved?.({ id: doc.id, adjust: out.adjust });
      }
      setDirty(false);
    } catch (e) { setError(e); } finally { setSaving(false); }
  };

  const key = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { handled(); if (canEdit && notes.length) { setNotes(notes.slice(0, -1)); setDirty(true); } return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') { handled(); if (canEdit && (dirty || adjDirty)) save(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape') { if (draft) { handled(); setDraft(null); } else if (help) { handled(); setHelp(false); } return; }
    if (k === 'Enter' && draft?.type === 'polyline') { handled(); finishPath(); return; }
    if (k === '+' || k === '=') { handled(); zoomBy(1.25); return; }
    if (k === '-' || k === '_') { handled(); zoomBy(1 / 1.25); return; }
    if (k === '0') { handled(); setView({ zoom: 1, x: 0, y: 0 }); return; }
    if (k === 'ArrowLeft' && onPrev) { handled(); onPrev(); return; }
    if (k === 'ArrowRight' && onNext) { handled(); onNext(); return; }
    const lower = k.toLowerCase();
    const preset = PRESETS.find((p) => p.key === k);
    if (preset) { handled(); applyPreset(preset); return; }
    const t = TOOLS.find(([id, , , s]) => s === lower && (canEdit || READ_ONLY_TOOLS.includes(id)));
    if (t) { handled(); setDraft(null); setTool(t[0]); return; }
    const acts = { r: () => setA({ rotate: (adj.rotate + 90) % 360 }), h: () => setA({ flipH: !adj.flipH }), i: () => setA({ invert: !adj.invert }), m: () => setMagnify((v) => !v), f: toggleFull, '?': () => setHelp((v) => !v) };
    if (aiStatus?.enabled && category === 'xray') Object.assign(acts, { x: () => setShowAi((v) => !v), n: () => setAiConf((v) => !v) });
    if (acts[lower] || acts[k]) { handled(); (acts[lower] || acts[k])(); }
  };

  const activePreset = PRESETS.find((p) => JSON.stringify(compact({ ...NEUTRAL, ...p.adjust })) === JSON.stringify(compact({ ...adj, rotate: 0, flipH: false })));
  const cursor = tool === 'pan' ? (drag.current ? 'grabbing' : 'grab') : tool === 'erase' ? 'not-allowed' : magnify ? 'none' : 'crosshair';
  const canvasHeight = full ? '100%' : height;
  const xp = exposure && [exposure.kvp && `${exposure.kvp} kVp`, exposure.ma && `${exposure.ma} mA`, exposure.seconds && `${exposure.seconds} s`].filter(Boolean).join(' · ');

  return (
    <div ref={root} className={`image-viewer${dark ? ' dark' : ''}${full ? ' full' : ''}`} tabIndex={0} onKeyDown={key} onPointerEnter={() => !document.activeElement?.closest('input, select, textarea') && root.current?.focus({ preventScroll: true })}>
      <div className="viewer-toolbar">
        <div className="vgroup">
          {TOOLS.filter(([k]) => canEdit || READ_ONLY_TOOLS.includes(k)).map(([k, Icon, title, s]) => (
            <IconBtn key={k} on={tool === k} title={`${title} (${s.toUpperCase()})`} onClick={() => { setDraft(null); setTool(k); }}><Icon size={16} /></IconBtn>
          ))}
        </div>
        <div className="vgroup">
          <IconBtn title="Zoom in (+)" onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></IconBtn>
          <IconBtn title="Zoom out (−)" onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={16} /></IconBtn>
          <IconBtn title="Rotate (R)" onClick={() => setA({ rotate: (adj.rotate + 90) % 360 })}><RotateCw size={16} /></IconBtn>
          <IconBtn on={adj.flipH} title="Flip (H)" onClick={() => setA({ flipH: !adj.flipH })}><ArrowLeftRight size={16} /></IconBtn>
          <IconBtn on={adj.invert} title="Invert (I)" onClick={() => setA({ invert: !adj.invert })}><Contrast size={16} /></IconBtn>
          <IconBtn on={magnify} title="Magnifier (M)" onClick={() => setMagnify(!magnify)}><Search size={16} /></IconBtn>
          <IconBtn on={panel} title="Adjust image" onClick={() => setPanel(!panel)}><SlidersHorizontal size={16} /></IconBtn>
          {aiStatus?.enabled && category === 'xray' && <IconBtn on={showAi} title={`AI findings (${aiStatus.label}) — ${DISCLAIMER} (X)`} onClick={() => setShowAi(!showAi)}><ScanSearch size={16} /></IconBtn>}
        </div>
        {!small && (
          <div className="vgroup presets" role="group" aria-label="Presets">
            {PRESETS.map((p) => <button key={p.id} type="button" className={`vchip${activePreset?.id === p.id ? ' on' : ''}`} title={`${p.hint || 'No enhancement'} (${p.key})`} onClick={() => applyPreset(p)}>{p.label}</button>)}
          </div>
        )}
        <div className="vgroup end">
          {canEdit && notes.length > 0 && <IconBtn title="Undo last mark (Ctrl+Z)" onClick={() => { setNotes(notes.slice(0, -1)); setDirty(true); }}><Undo2 size={16} /></IconBtn>}
          <IconBtn title="Keyboard shortcuts (?)" on={help} onClick={() => setHelp(!help)}><Keyboard size={16} /></IconBtn>
          <IconBtn title="Full screen (F)" onClick={toggleFull}>{full ? <Minimize size={16} /> : <Maximize size={16} />}</IconBtn>
          {canEdit && (dirty || adjDirty) && (
            <button type="button" className="small primary vsave" disabled={saving} onClick={save} title="Save marks and image settings (Ctrl+S)"><Save size={14} /> {saving ? 'Saving…' : 'Save'}</button>
          )}
        </div>
      </div>
      {panel && (
        <div className="viewer-adjust">
          {small && (
            <div className="vgroup presets">
              {PRESETS.map((p) => <button key={p.id} type="button" className={`vchip${activePreset?.id === p.id ? ' on' : ''}`} title={p.hint} onClick={() => applyPreset(p)}>{p.label}</button>)}
            </div>
          )}
          <Slider label="Brightness" min={-100} max={100} step={1} value={adj.brightness} onChange={(v) => setA({ brightness: v })} />
          <Slider label="Contrast" min={-100} max={100} step={1} value={adj.contrast} onChange={(v) => setA({ contrast: v })} />
          <Slider label="Gamma" min={0.3} max={3} step={0.05} value={adj.gamma} onChange={(v) => setA({ gamma: v })} fmt={(v) => v.toFixed(2)} />
          <Slider label="Sharpen" min={0} max={3} step={0.1} value={adj.sharpen} onChange={(v) => setA({ sharpen: v })} fmt={(v) => v.toFixed(1)} />
          <Slider label="Local contrast" name="clahe" min={0} max={4} step={0.25} value={adj.clahe} onChange={(v) => setA({ clahe: v })} fmt={(v) => v.toFixed(2)} />
          <Slider label="Noise reduction" name="denoise" min={0} max={3} step={1} value={adj.denoise} onChange={(v) => setA({ denoise: v })} />
          <label className="vcheck"><input type="checkbox" checked={adj.stretch} onChange={(e) => setA({ stretch: e.target.checked })} /> Auto levels</label>
          <label className="vcheck"><input type="checkbox" checked={adj.equalize} onChange={(e) => setA({ equalize: e.target.checked })} /> Equalize</label>
          <label className="vcheck"><input type="checkbox" checked={adj.emboss} onChange={(e) => setA({ emboss: e.target.checked })} /> Emboss</label>
          <label className="vcheck">Colour
            <select value={adj.colormap} onChange={(e) => setA({ colormap: e.target.value })}>{Object.entries(COLORMAPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <button type="button" className="small" onClick={() => setAdj({ ...NEUTRAL })}>Reset</button>
          <label className="vcheck" title="What x-rays open with on this computer when nobody has saved settings for them">Open x-rays with
            <select value={openWith} onChange={(e) => { setOpenWith(e.target.value); setOpenPreset(e.target.value); }}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          </label>
        </div>
      )}
      {showAi && aiStatus?.enabled && (
        <div className="viewer-ai">
          <div className="viewer-ai-head">
            <strong>AI findings</strong>
            <span className="viewer-ai-tag">{DISCLAIMER}</span>
            <span className="muted">{aiStatus.label}{aiStatus.cleared ? ' · FDA-cleared' : ' · made-up findings for demos'}</span>
            <label className="vcheck" title="Show the AI's confidence on the image (N)"><input type="checkbox" checked={aiConf} onChange={(e) => setAiConf(e.target.checked)} /> Confidence</label>
            <label className="vcheck" title="Hide suggestions the AI is less sure of">Show
              <select value={aiMin} onChange={(e) => setAiMin(Number(e.target.value))}>{MIN_CONF.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
            </label>
            {canEdit && <button type="button" className="small" disabled={aiBusy} onClick={readAi}>{aiBusy ? 'Reading…' : ai?.read_at || ai?.findings?.length ? 'Read again' : 'Read this x-ray'}</button>}
          </div>
          {ai?.quality && <div className="muted" style={{ fontSize: 12 }}>Image: {ai.quality}</div>}
          {ai && !ai.findings.length && <div className="muted" style={{ fontSize: 12 }}>{ai.read_at ? 'Nothing found.' : 'Not read yet.'}</div>}
          {ai?.findings.filter((f) => f.status !== 'suggested' || aiShown(f)).map((f) => (
            <div key={f.id} className={`viewer-ai-row ${f.status}`}>
              <i style={{ background: AI_COLOR[f.kind] }} />
              <span title={f.note ? `Why: ${f.note}` : undefined}>{f.label}{f.tooth ? ` #${f.tooth}` : ''}{f.surfaces ? ` ${f.surfaces}` : ''}{f.measurement_mm ? ` · ${f.measurement_mm} mm` : ''}{aiConf ? ` · ${Math.round(f.confidence * 100)}%` : ''}{f.note && <small className="muted" style={{ display: 'block', fontSize: 11 }}>{f.note}</small>}</span>
              {canDecide && f.status === 'suggested' && (
                <>
                  <button type="button" className="small" onClick={() => decide(f, 'accepted')} title={f.tooth ? 'Accept, and add it to the tooth chart with this finding as the reason' : 'Accept'}>{f.tooth ? 'Chart it' : 'Accept'}</button>
                  <button type="button" className="small" onClick={() => decide(f, 'rejected')}>Dismiss</button>
                </>
              )}
              {f.status !== 'suggested' && <span className="muted" style={{ fontSize: 11 }}>{f.status === 'accepted' ? (f.condition_id ? 'on the chart' : 'agreed') : 'dismissed'}{canDecide && <button type="button" className="link" style={{ fontSize: 11, marginLeft: 6 }} onClick={() => decide(f, 'suggested')}>undo</button>}</span>}
            </div>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      <div ref={wrap} className="viewer-canvas" style={{ height: canvasHeight }}>
        {!img && !error && <div className="viewer-loading"><span className="spinner" /> Loading image…</div>}
        <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={leave} onDoubleClick={finishPath} style={{ cursor, width: '100%', height: '100%' }} />
        {ask && (
          <form className="viewer-ask" onSubmit={(e) => {
            e.preventDefault();
            const v = ask.value.trim();
            if (ask.kind === 'text' && v) addNote({ type: 'text', points: [ask.p], text: v, color: MARK });
            if (ask.kind === 'mm' && Number(v) > 0) {
              const scale = Number(v) / ask.px;
              setMm(scale);
              setScaleSource('calibrated');
              setDirty(true);
              // One calibration can serve every later x-ray from the same sensor: offered, not asked.
              if (agentId && canEdit) setSensorScale(scale);
            }
            setAsk(null);
            root.current?.focus({ preventScroll: true });
          }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAsk(null); root.current?.focus({ preventScroll: true }); } }}>
            <label>{ask.kind === 'text' ? 'Note' : 'How long is that line, in mm? (e.g. a known implant or file length)'}
              <input autoFocus value={ask.value} inputMode={ask.kind === 'mm' ? 'decimal' : undefined} onChange={(e) => setAsk({ ...ask, value: e.target.value })} />
            </label>
            <button className="small primary">{ask.kind === 'text' ? 'Add note' : 'Set scale'}</button>
            <button type="button" className="small" onClick={() => setAsk(null)}>Cancel</button>
          </form>
        )}
        {sensorScale && !ask && (
          <div className="viewer-ask" role="status">
            <span>Use this scale for every future x-ray from this sensor?</span>
            <button type="button" className="small primary" onClick={() => { api.put(`/imaging/agents/${agentId}/calibration`, { mm_per_px: sensorScale }).then(() => toast('Scale kept for this sensor')).catch(setError); setSensorScale(null); }}>Use for this sensor</button>
            <button type="button" className="small" onClick={() => setSensorScale(null)}>Just this image</button>
          </div>
        )}
        {draft?.type === 'polyline' && <div className="viewer-hint">Click along the canal · double-click or Enter to finish · Esc to cancel</div>}
        {draft?.type === 'angle' && <div className="viewer-hint">{draft.points.length === 2 ? 'Click the vertex of the angle' : 'Click the end of the second line'}</div>}
        {help && (
          <div className="viewer-help" onClick={() => setHelp(false)}>
            <strong>Keyboard shortcuts</strong>
            <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          </div>
        )}
      </div>
      <div className="viewer-foot">
        {img ? <span>{img.width}×{img.height}px</span> : null}
        <span className={scaleSource === 'estimate' ? 'viewer-warn' : undefined}>
          {mm ? `${(1 / mm).toFixed(1)} px/mm · ${SCALE_TEXT[scaleSource] || 'calibrated'}` : 'Not calibrated — lengths in pixels (Calibrate with a known length)'}
        </span>
        {xp && <span title={exposure.sensor ? `Sensor: ${exposure.sensor}` : undefined}>Exposure {xp}</span>}
        {adj.rotate ? <span>Rotated {adj.rotate}°</span> : null}
      </div>
    </div>
  );
}

function IconBtn({ on, title, onClick, children, disabled }) {
  return <button type="button" className={`vbtn${on ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={on || undefined} onClick={onClick} disabled={disabled}>{children}</button>;
}

const SCALE_TEXT = {
  dicom: 'scale from the sensor file',
  sensor: "scale from the sensor's pixel size",
  calibrated: 'calibrated',
  estimate: 'estimated from the sensor size — calibrate once for exact mm',
};

function Slider({ label, name, min, max, step, value, onChange, fmt = (v) => v }) {
  return (
    <label className="vslider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(NEUTRAL[name || label.toLowerCase()])} />
      <output>{fmt(value)}</output>
    </label>
  );
}
