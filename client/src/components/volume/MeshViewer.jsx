import { useEffect, useRef, useState } from 'react';
import { Ruler, Camera, RotateCcw, X, Trash2, TriangleAlert, Grid3x3, Palette } from 'lucide-react';
import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight, Group, Mesh, MeshPhysicalMaterial, DoubleSide, Box3, Vector3, Vector2,
  Raycaster, SphereGeometry, MeshBasicMaterial, BufferGeometry, Line, LineBasicMaterial, PMREMGenerator, ACESFilmicToneMapping, SRGBColorSpace, Color,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fetchBinary, saveSnapshot, canvasToBlob } from './net.js';
import './volume.css';

// Intraoral / model scan viewer (.stl, .ply, .obj): turn, zoom and move the model, show or hide the
// upper and lower jaws, open the bite, measure between two points on the surface (scan files are in
// mm), and save a picture to the patient's documents. The scan itself is never changed.

const JAW_LABEL = { upper: 'Upper', lower: 'Lower', bite: 'Bite' };
const ENAMEL = 0xe9dcc6;

function parseMesh(format, buffer) {
  if (format === 'stl') return [new STLLoader().parse(buffer)];
  if (format === 'ply') return [new PLYLoader().parse(buffer)];
  const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
  const list = [];
  group.traverse((o) => { if (o.isMesh) list.push(o.geometry); });
  return list;
}

// STL stores every triangle separately, which looks faceted: welding shared corners gives smooth teeth.
function smooth(geometry) {
  let g = geometry;
  const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (!g.index && !g.attributes.color && tris < 3_000_000) {
    g.deleteAttribute('normal');
    g = mergeVertices(g, 1e-4);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

export default function MeshViewer({ documentId, info, canEdit = false, onClose, onSaved, height = '100%' }) {
  const wrap = useRef(null);
  const labels = useRef(null);
  const three = useRef(null);
  const [parts, setParts] = useState([]); // { name, jaw, visible, triangles, colored }
  const [loading, setLoading] = useState('Opening the scan…');
  const [error, setError] = useState(null);
  const [measuring, setMeasuring] = useState(false);
  const [pending, setPending] = useState(null);
  const [measures, setMeasures] = useState([]);
  const [opening, setOpening] = useState(0);
  const [wire, setWire] = useState(false);
  const [useColor, setUseColor] = useState(true);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  // ---- Scene ----
  useEffect(() => {
    const el = wrap.current;
    let renderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      setError('This browser can’t show 3D (WebGL is off or unsupported). Download the file to open it in your scan software.');
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45; // reflections for a little sheen, not a wash of white
    const camera = new PerspectiveCamera(32, 1, 0.1, 10000);
    scene.add(camera);
    // Soft sky/ground light, a key light that follows the eye (the side you look at is always lit) and a
    // low fill so embrasures and grooves keep some shape.
    scene.add(new HemisphereLight(0xffffff, 0x2a303c, 0.35));
    const key = new DirectionalLight(0xfff8ee, 1.25);
    key.position.set(0.6, 1, 0.9);
    camera.add(key);
    const fill = new DirectionalLight(0xdfe8ff, 0.35);
    fill.position.set(-1, -0.6, -0.4);
    scene.add(fill);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    const root = new Group();
    scene.add(root);
    const marks = new Group();
    scene.add(marks);
    const state = { renderer, scene, camera, controls, root, marks, meshes: [], radius: 50, center: new Vector3(), labelItems: [] };
    three.current = state;
    // Drawn only when something changes (a turn, a toggle, the damping settling), not 60 times a second.
    let queued = 0;
    const frame = () => {
      queued = 0;
      const moving = controls.update();
      renderer.render(scene, camera);
      placeLabels(state, el);
      if (moving) state.request();
    };
    state.request = () => { if (!queued) queued = requestAnimationFrame(frame); };
    controls.addEventListener('change', state.request);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      state.request();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(queued);
      controls.dispose();
      state.meshes.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
    };
  }, []);

  // ---- Load the parts ----
  useEffect(() => {
    const t = three.current;
    if (!t || !info?.parts?.length) return undefined;
    let live = true;
    (async () => {
      try {
        const loaded = [];
        for (const p of info.parts) {
          setLoading(`Loading ${p.name}…`);
          const { buffer } = await fetchBinary(`/documents/${documentId}/mesh?part=${p.index}`);
          if (!live) return;
          for (const raw of parseMesh(p.format, buffer)) {
            const geometry = smooth(raw);
            const colored = !!geometry.attributes.color;
            const material = new MeshPhysicalMaterial({
              color: colored ? 0xffffff : ENAMEL, vertexColors: colored, roughness: 0.5, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.35, side: DoubleSide,
            });
            const mesh = new Mesh(geometry, material);
            mesh.userData = { part: p.index, jaw: p.jaw };
            t.root.add(mesh);
            t.meshes.push(mesh);
            loaded.push({ index: p.index, name: p.name, jaw: p.jaw, colored, triangles: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3 });
          }
        }
        if (!live) return;
        const box = new Box3().setFromObject(t.root);
        box.getCenter(t.center);
        t.radius = Math.max(1, box.getSize(new Vector3()).length() / 2);
        t.root.position.sub(t.center);
        t.center.set(0, 0, 0);
        t.camera.near = t.radius / 100;
        t.camera.far = t.radius * 100;
        t.camera.updateProjectionMatrix();
        setParts(loaded.reduce((acc, p) => (acc.some((x) => x.index === p.index) ? acc : [...acc, { ...p, visible: true }]), []));
        look(t, 'front');
        t.request();
        setLoading(null);
      } catch (e) {
        if (live) setError(e.message || 'Could not read this scan');
      }
    })();
    return () => { live = false; };
  }, [documentId, info]);

  // Visibility, bite opening, wireframe, colour.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const upperIndex = parts.find((p) => p.jaw === 'upper')?.index ?? (parts.length > 1 ? parts[0].index : null);
    for (const m of t.meshes) {
      const p = parts.find((x) => x.index === m.userData.part);
      m.visible = p ? p.visible : true;
      m.position.z = m.userData.part === upperIndex ? opening : 0;
      m.material.wireframe = wire;
      const colored = !!m.geometry.attributes.color;
      m.material.vertexColors = colored && useColor;
      m.material.color = new Color(colored && useColor ? 0xffffff : ENAMEL);
      m.material.needsUpdate = true;
    }
    t.request();
  }, [parts, opening, wire, useColor]);

  // ---- Measuring: click two points on the surface ----
  useEffect(() => {
    const t = three.current;
    if (!t) return undefined;
    const dom = t.renderer.domElement;
    let start = null;
    const down = (e) => { start = [e.clientX, e.clientY]; };
    const up = (e) => {
      if (!measuring || !start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) return;
      const r = dom.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), t.camera);
      const hit = ray.intersectObjects(t.meshes.filter((m) => m.visible), false)[0];
      if (!hit) return;
      const p = hit.point.clone();
      if (!pending) setPending(p);
      else {
        setMeasures((list) => [...list, { id: Date.now(), a: pending, b: p, mm: pending.distanceTo(p) }]);
        setPending(null);
      }
    };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointerup', up);
    dom.style.cursor = measuring ? 'crosshair' : 'grab';
    return () => { dom.removeEventListener('pointerdown', down); dom.removeEventListener('pointerup', up); };
  }, [measuring, pending]);

  // Draw the measurements (points, lines) and keep their labels for the render loop to place.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.marks.clear();
    const dot = new SphereGeometry(t.radius * 0.009, 16, 12);
    const mat = new MeshBasicMaterial({ color: 0xfacc15, depthTest: false });
    const lineMat = new LineBasicMaterial({ color: 0xfacc15, depthTest: false });
    const points = [...measures.flatMap((m) => [m.a, m.b]), ...(pending ? [pending] : [])];
    for (const p of points) { const s = new Mesh(dot, mat); s.position.copy(p); s.renderOrder = 10; t.marks.add(s); }
    for (const m of measures) { const l = new Line(new BufferGeometry().setFromPoints([m.a, m.b]), lineMat); l.renderOrder = 9; t.marks.add(l); }
    t.labelItems = measures.map((m, n) => ({ id: m.id, at: m.a.clone().add(m.b).multiplyScalar(0.5), text: `${n + 1}. ${m.mm.toFixed(2)} mm` }));
    if (labels.current) labels.current.innerHTML = t.labelItems.map((l) => `<span class="mv-label" data-id="${l.id}">${l.text}</span>`).join('');
    t.request();
  }, [measures, pending]);

  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'm') setMeasuring((x) => !x);
    else if (k === 'r') look(three.current, 'front');
    else if (k === 'escape') { if (pending) setPending(null); else if (measuring) setMeasuring(false); else onClose?.(); } else return;
    e.preventDefault();
  };

  // A picture of the view with the measurement labels drawn in, saved to the chart.
  const snapshot = async () => {
    const t = three.current;
    t.renderer.render(t.scene, t.camera);
    const src = t.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, out.height);
    g.addColorStop(0, '#1b2433');
    g.addColorStop(1, '#0a0f17');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const k = out.width / src.clientWidth;
    ctx.font = `600 ${Math.round(13 * k)}px Inter Variable, system-ui, sans-serif`;
    for (const l of t.labelItems) {
      const p = l.at.clone().project(t.camera);
      const x = (p.x * 0.5 + 0.5) * out.width;
      const y = (-p.y * 0.5 + 0.5) * out.height;
      const w = ctx.measureText(l.text).width + 12 * k;
      ctx.fillStyle = 'rgba(15,23,42,0.85)';
      ctx.fillRect(x + 6 * k, y - 11 * k, w, 22 * k);
      ctx.fillStyle = '#facc15';
      ctx.fillText(l.text, x + 12 * k, y + 5 * k);
    }
    setSaving(true);
    try {
      const doc = await saveSnapshot(documentId, await canvasToBlob(out), 'Scan view');
      setNotice(`Saved to documents as “${doc.filename}”`);
      onSaved?.(doc);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setSaving(false);
    }
  };

  const triangles = parts.reduce((s, p) => s + p.triangles, 0);
  const anyColor = parts.some((p) => p.colored);
  const hasUpper = parts.length > 1;
  return (
    <div className="vv mv" style={{ height }} tabIndex={0} onKeyDown={onKey}>
      <div className="vv-bar">
        <div className="vv-title">
          <strong>{info?.filename || '3D scan'}</strong>
          {triangles > 0 && <span className="vv-muted">{parts.length} part{parts.length === 1 ? '' : 's'} · {(triangles / 1000).toFixed(0)}k triangles · mm</span>}
        </div>
        <div className="vv-group">
          {parts.map((p) => (
            <button key={p.index} type="button" className={`vv-chip${p.visible ? ' on' : ''}`} aria-pressed={p.visible} title={p.name}
              onClick={() => setParts((list) => list.map((x) => (x.index === p.index ? { ...x, visible: !x.visible } : x)))}>
              {JAW_LABEL[p.jaw] || p.name.replace(/\.[^.]+$/, '').slice(0, 18)}
            </button>
          ))}
          {hasUpper && (
            <label className="vv-range" title="Open the bite: lift the upper jaw away from the lower">Open <input type="range" min="0" max={Math.round(three.current?.radius || 40)} value={opening} onChange={(e) => setOpening(Number(e.target.value))} /></label>
          )}
        </div>
        <div className="vv-group">
          {[['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['lower', 'Lower occlusal'], ['upper', 'Upper occlusal']].map(([k, label]) => (
            <button key={k} type="button" className="vv-chip" onClick={() => look(three.current, k)}>{label}</button>
          ))}
        </div>
        <div className="vv-group vv-right">
          <button type="button" className={`vv-icon${measuring ? ' on' : ''}`} title="Measure: click two points (M)" aria-pressed={measuring} onClick={() => { setMeasuring((x) => !x); setPending(null); }}><Ruler size={17} /></button>
          <button type="button" className={`vv-icon${wire ? ' on' : ''}`} title="Show the triangles" aria-pressed={wire} onClick={() => setWire((x) => !x)}><Grid3x3 size={17} /></button>
          {anyColor && <button type="button" className={`vv-icon${useColor ? ' on' : ''}`} title="Scanner colours" aria-pressed={useColor} onClick={() => setUseColor((x) => !x)}><Palette size={17} /></button>}
          <button type="button" className="vv-icon" title="Reset the view (R)" onClick={() => look(three.current, 'front')}><RotateCcw size={17} /></button>
          {canEdit && <button type="button" className="vv-btn" disabled={saving || !!loading} onClick={snapshot}><Camera size={16} /> {saving ? 'Saving…' : 'Snapshot'}</button>}
          {onClose && <button type="button" className="vv-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={18} /></button>}
        </div>
      </div>
      {notice && <div className="vv-notice" role="status">{notice} <button type="button" className="vv-link" onClick={() => setNotice(null)}>OK</button></div>}
      <div className="mv-stage">
        <div className="mv-canvas" ref={wrap} />
        <div className="mv-labels" ref={labels} />
        {measuring && <div className="mv-tip">{pending ? 'Click the second point' : 'Click the first point on the scan'} · Esc to stop</div>}
        {(loading || error) && (
          <div className="vv-hint mv-overlay">
            {error ? <><TriangleAlert size={22} /><p>{error}</p></> : <><div className="vv-spinner" /><p>{loading}</p></>}
          </div>
        )}
      </div>
      {measures.length > 0 && (
        <div className="vv-measures">
          <Ruler size={14} />
          {measures.map((m, n) => (
            <span key={m.id} className="vv-measure">{n + 1}. {m.mm.toFixed(2)} mm
              <button type="button" aria-label="Remove" onClick={() => setMeasures((l) => l.filter((x) => x.id !== m.id))}><Trash2 size={12} /></button>
            </span>
          ))}
          <span className="vv-muted">Straight-line distance. Not saved — take a snapshot to keep it.</span>
        </div>
      )}
    </div>
  );
}

// Standard views. Scans don't agree on axes, so these assume the common export: the biting surface
// in the x-y plane, z toward the lower teeth' cusps, the front of the arch toward +y.
function look(t, where) {
  if (!t) return;
  const d = t.radius * 2.6;
  const dir = { front: [0, 1, 0.25], left: [1, 0.15, 0.2], right: [-1, 0.15, 0.2], lower: [0, 0.2, 1], upper: [0, 0.2, -1] }[where] || [0, 1, 0.25];
  const v = new Vector3(...dir).normalize().multiplyScalar(d);
  t.camera.position.copy(v);
  t.camera.up.set(...(where === 'lower' || where === 'upper' ? [0, 1, 0] : [0, 0, 1]));
  t.controls.target.set(0, 0, 0);
  t.camera.lookAt(0, 0, 0);
  t.controls.update();
  t.request?.();
}

// Measurement labels follow their points on screen (called every frame).
function placeLabels(t, el) {
  const box = el.parentElement?.querySelector('.mv-labels');
  if (!box || !t.labelItems.length) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  for (const l of t.labelItems) {
    const node = box.querySelector(`[data-id="${l.id}"]`);
    if (!node) continue;
    const p = l.at.clone().project(t.camera);
    node.style.transform = `translate(${(p.x * 0.5 + 0.5) * w + 8}px, ${(-p.y * 0.5 + 0.5) * h - 10}px)`;
    node.style.display = p.z < 1 ? '' : 'none';
  }
}
