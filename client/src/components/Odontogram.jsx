import { useId, useRef } from 'react';
import { UPPER, LOWER, P_UPPER, P_LOWER, baseTooth, isPosterior, isUpper, isMolar, isPrimary, toothClass, mesialOnRight } from './teeth.js';
import './odontogram.css';

export { baseTooth, isPosterior, isUpper, surfacesFor, QUADRANT_LABELS } from './teeth.js';

// Graphic odontogram. Each tooth is drawn twice, the way a dentist looks at it: from the side (crown and
// roots, shaped by tooth type) and from above (the five surfaces). Work and findings are painted on both.

// What each colour means, everywhere on the chart.
export const STATUS_COLORS = { planned: '#e11d48', completed: '#2563eb', existing: '#16a34a', problem: '#c2410c', watch: '#d97706' };

export const CONDITION_COLORS = {
  caries: STATUS_COLORS.problem,
  fracture: STATUS_COLORS.problem,
  abscess: STATUS_COLORS.problem,
  missing: '#94a3b8',
  impacted: '#64748b',
  filling: STATUS_COLORS.existing,
  crown: STATUS_COLORS.existing,
  root_canal: STATUS_COLORS.existing,
  implant: STATUS_COLORS.existing,
  bridge_pontic: STATUS_COLORS.existing,
  sealant: STATUS_COLORS.existing,
  veneer: STATUS_COLORS.existing,
  watch: STATUS_COLORS.watch,
  mobility: '#7c3aed',
};

// Which drawing a code or condition gets.
const OVERLAY_CODES = [
  ['extraction', /^D7(1|2[1-5])\d\d$/],
  ['implant', /^D60(10|1[1-3])$/],
  ['pontic', /^D62\d\d$/],
  ['crown', /^D(27\d\d|29[34]\d|605\d|606\d|67\d\d)$/],
  ['root_canal', /^D33(10|20|30|46|47|48)$/],
  ['post', /^D29(5[0-4])$/],
  ['sealant', /^D135[12]$/],
  ['veneer', /^D29(6[0-2])$/],
];
const CONDITION_OVERLAY = { crown: 'crown', root_canal: 'root_canal', implant: 'implant', bridge_pontic: 'pontic', sealant: 'sealant', veneer: 'veneer' };
export const overlayFor = (code) => OVERLAY_CODES.find(([, re]) => re.test(code))?.[0] || null;

// Mirror of the server's rule for which codes are charted by quadrant or arch.
export function codeArea(code) {
  if (!code) return 'tooth';
  if (code.area) return code.area;
  if (/^D(434[12]|42[0-6]\d)$/.test(code.code)) return 'quadrant';
  if (/^D(51[1-4]0|52[1-2][1-4]|54[1-2][1-2]|57[3-6]\d|5863|5865)$/.test(code.code)) return 'arch';
  return code.requires_tooth ? 'tooth' : 'mouth';
}

// Everything drawn on one tooth, plus a plain-words summary for its tooltip.
export function toothState(tooth, conditions, procedures) {
  const fills = {};
  const overlays = [];
  const notes = [];
  let missing = false;
  let planX = false;
  let watch = false;
  let mobility = false;
  for (const c of conditions.filter((x) => x.tooth === tooth && !x.resolved)) {
    notes.push(`${c.condition.replace('_', ' ')}${c.surfaces ? ` ${c.surfaces}` : ''}`);
    if (c.condition === 'missing') missing = true;
    if (c.condition === 'impacted') overlays.push({ kind: 'impacted', color: CONDITION_COLORS.impacted });
    if (c.condition === 'watch') watch = true;
    if (c.condition === 'mobility') mobility = true;
    const kind = CONDITION_OVERLAY[c.condition];
    if (kind) overlays.push({ kind, color: CONDITION_COLORS[c.condition] });
    if (c.surfaces && !['crown', 'veneer', 'sealant'].includes(c.condition)) for (const s of c.surfaces) fills[s] = CONDITION_COLORS[c.condition];
    else if (['fracture', 'abscess'].includes(c.condition)) overlays.push({ kind: c.condition, color: CONDITION_COLORS[c.condition] });
  }
  // Completed work draws over conditions, planned work over both.
  const ordered = [...procedures.filter((p) => p.tooth === tooth)].sort((a, b) => (a.status === b.status ? 0 : a.status === 'planned' ? 1 : -1));
  for (const p of ordered) {
    notes.push(`${p.code}${p.surfaces ? ` ${p.surfaces}` : ''} ${p.status}`);
    const color = p.status === 'planned' ? STATUS_COLORS.planned : STATUS_COLORS.completed;
    const kind = overlayFor(p.code);
    if (kind === 'extraction') {
      if (p.status === 'planned') planX = true;
      else missing = true;
    } else if (kind) overlays.push({ kind, color });
    if (p.surfaces && !['crown', 'veneer', 'sealant'].includes(kind)) for (const s of p.surfaces) fills[s] = color;
  }
  return { fills, overlays, missing, planX, watch, mobility, notes };
}

// ---- Geometry. Side view in "upper" orientation: roots up (apex near y=4), the neck at y=64, the biting edge
// near y=108. Lower teeth use the same shapes flipped. The top view sits in a 46-unit band.
const WIDTH = { molar: 50, premolar: 36, canine: 34, central: 38, lateral: 30 };
const LOWER_WIDTH = { molar: 50, premolar: 36, canine: 32, central: 26, lateral: 28 };
const PRIMARY_WIDTH = { molar: 40, premolar: 36, canine: 30, central: 30, lateral: 27 };
export const toothWidth = (t) => (isPrimary(t) ? PRIMARY_WIDTH : isUpper(t) ? WIDTH : LOWER_WIDTH)[toothClass(t)];
const SIDE_H = 112;
const TOP_H = 46;
const GAP = 6;
const H = SIDE_H + GAP + TOP_H;
export const NECK = 64;

export function crownPath(cls, w) {
  const x = (f) => (f * w).toFixed(1);
  if (cls === 'molar') return `M${x(0.1)} ${NECK} C0 76 ${x(0.01)} 96 ${x(0.12)} 103 Q${x(0.27)} 110 ${x(0.41)} 103 Q${x(0.5)} 99 ${x(0.59)} 103 Q${x(0.73)} 110 ${x(0.88)} 103 C${x(0.99)} 96 ${w} 76 ${x(0.9)} ${NECK} Z`;
  if (cls === 'premolar') return `M${x(0.16)} ${NECK} C${x(0.02)} 76 ${x(0.03)} 94 ${x(0.18)} 102 Q${x(0.5)} 112 ${x(0.82)} 102 C${x(0.97)} 94 ${x(0.98)} 76 ${x(0.84)} ${NECK} Z`;
  if (cls === 'canine') return `M${x(0.2)} ${NECK} C${x(0.04)} 76 ${x(0.06)} 92 ${x(0.26)} 100 L${x(0.5)} 110 L${x(0.74)} 100 C${x(0.94)} 92 ${x(0.96)} 76 ${x(0.8)} ${NECK} Z`;
  return `M${x(0.2)} ${NECK} C${x(0.06)} 74 ${x(0.04)} 94 ${x(0.1)} 104 Q${x(0.5)} 110 ${x(0.9)} 104 C${x(0.96)} 94 ${x(0.94)} 74 ${x(0.8)} ${NECK} Z`;
}

// Root outlines, back to front, and the line of each canal (for root canals and posts).
export function rootsFor(tooth, w) {
  const cls = toothClass(tooth);
  const upper = isUpper(tooth);
  const shorten = isPrimary(tooth) ? 0.62 : 1;
  const ap = (y) => NECK - (NECK - y) * shorten;
  const x = (f) => (f * w).toFixed(1);
  if (cls === 'molar') {
    const a = ap(12);
    const buccal = (l) => {
      const X = (f) => x(l ? f : 1 - f);
      return `M${X(0.1)} ${NECK} C${X(0.06)} ${ap(44)} ${X(0.14)} ${a + 4} ${X(0.26)} ${a} C${X(0.34)} ${a + 4} ${X(0.42)} ${ap(40)} ${X(0.44)} ${NECK} Z`;
    };
    const roots = [{ d: buccal(true) }, { d: buccal(false) }];
    const canals = [`M${x(0.29)} ${NECK + 2} Q${x(0.27)} ${ap(36)} ${x(0.26)} ${a + 6}`, `M${x(0.71)} ${NECK + 2} Q${x(0.73)} ${ap(36)} ${x(0.74)} ${a + 6}`];
    if (upper) {
      const p = ap(6);
      roots.unshift({ d: `M${x(0.34)} ${NECK} C${x(0.32)} ${ap(40)} ${x(0.44)} ${p + 2} ${x(0.5)} ${p} C${x(0.56)} ${p + 2} ${x(0.68)} ${ap(40)} ${x(0.66)} ${NECK} Z`, back: true });
      canals.push(`M${x(0.5)} ${NECK + 2} L${x(0.5)} ${p + 6}`);
    }
    return { roots, canals, apexes: [[0.26 * w, a], [0.74 * w, a]] };
  }
  const apex = ap({ canine: 2, premolar: 12, central: upper ? 10 : 18, lateral: upper ? 14 : 18 }[cls]);
  const mid = (NECK + apex) / 2 + 8;
  return {
    roots: [{ d: `M${x(0.22)} ${NECK} C${x(0.2)} ${mid} ${x(0.38)} ${apex + 6} ${x(0.5)} ${apex} C${x(0.62)} ${apex + 6} ${x(0.8)} ${mid} ${x(0.78)} ${NECK} Z` }],
    canals: [`M${x(0.5)} ${NECK + 2} L${x(0.5)} ${apex + 6}`],
    apexes: [[0.5 * w, apex]],
  };
}

// A rounded outline for the top view: squarish molars, oval premolars, slim incisors.
function topOutline(cls, w) {
  const shape = { molar: [0.45, 19, 3.4], premolar: [0.42, 16, 2.5], canine: [0.4, 14, 2.1], central: [0.44, 10, 2.8], lateral: [0.43, 10, 2.6] }[cls];
  const [fa, b, n] = shape;
  const a = fa * w;
  const cx = w / 2;
  const cy = TOP_H / 2;
  const pts = [];
  for (let k = 0; k < 48; k++) {
    const t = (k / 48) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(`${(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(1)},${(cy + b * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(1)}`);
  }
  return { d: `M${pts.join(' L')} Z`, a, b, cx, cy };
}

const tint = (color, a) => `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;

function ToothSvg({ tooth, state, uid }) {
  const upper = isUpper(tooth);
  const cls = toothClass(tooth);
  const w = toothWidth(tooth);
  const posterior = isPosterior(tooth);
  const { fills, overlays, missing, planX, watch, mobility } = state;
  const has = (k) => overlays.find((o) => o.kind === k);
  const alt = { B: 'F', F: 'B', O: 'I', I: 'O' };
  const fillOf = (s) => fills[s] || fills[alt[s]] || null;
  const crown = crownPath(cls, w);
  const { roots, canals, apexes } = rootsFor(tooth, w);
  const pontic = has('pontic');
  const implant = has('implant');
  const crownWork = has('crown');
  const impacted = has('impacted');
  const mRight = mesialOnRight(tooth);
  const facial = posterior ? 'B' : 'F';
  const occ = posterior ? 'O' : 'I';
  const clipSide = `${uid}-s`;
  const clipTop = `${uid}-t`;
  const ghost = missing && !implant && !pontic;
  // Side view group, flipped for the lower arch so crowns meet in the middle of the chart.
  const sideY = upper ? 0 : TOP_H + GAP;
  const sideTransform = upper ? undefined : `translate(0 ${sideY + SIDE_H}) scale(1 -1)`;
  const topY = upper ? SIDE_H + GAP : 0;
  const o = topOutline(cls, w);
  const [topFace, bottomFace] = upper ? [facial, 'L'] : ['L', facial];
  const [leftFace, rightFace] = mRight ? ['D', 'M'] : ['M', 'D'];
  const anterior = cls === 'central' || cls === 'lateral' || cls === 'canine';
  // The biting surface: a thin incisal edge on front teeth, a smaller copy of the outline on back teeth.
  const inner = anterior
    ? { d: `M${o.cx - o.a * 0.72} ${o.cy - 2.2} L${o.cx + o.a * 0.72} ${o.cy - 2.2} L${o.cx + o.a * 0.72} ${o.cy + 2.2} L${o.cx - o.a * 0.72} ${o.cy + 2.2} Z` }
    : o;
  const innerShift = anterior ? '' : `translate(${(o.cx * 0.54).toFixed(1)} ${(o.cy * 0.54).toFixed(1)}) scale(0.46)`;
  const pad = 3;
  const region = {
    [topFace]: `${-pad},${-pad} ${w + pad},${-pad} ${o.cx},${o.cy}`,
    [bottomFace]: `${-pad},${TOP_H + pad} ${w + pad},${TOP_H + pad} ${o.cx},${o.cy}`,
    [leftFace]: `${-pad},${-pad} ${-pad},${TOP_H + pad} ${o.cx},${o.cy}`,
    [rightFace]: `${w + pad},${-pad} ${w + pad},${TOP_H + pad} ${o.cx},${o.cy}`,
  };
  const line = ghost ? 'var(--tooth-line-faint)' : 'var(--tooth-line)';
  return (
    <svg viewBox={`-4 0 ${w + 8} ${H}`} className="tooth-svg" aria-hidden="true">
      <defs>
        <clipPath id={clipSide}><path d={crown} /></clipPath>
        <clipPath id={clipTop}><path d={o.d} /></clipPath>
      </defs>
      {/* ---- side view ---- */}
      <g transform={sideTransform} className={ghost ? 'ghost' : undefined}>
        <g transform={impacted ? `rotate(${mRight ? -16 : 16} ${w / 2} ${NECK})` : undefined}>
          {/* roots, or an implant post */}
          {!pontic && !implant && roots.map((r, k) => (
            <path key={k} d={r.d} fill={ghost ? 'none' : r.back ? 'url(#dm-root-back)' : 'url(#dm-root)'} stroke={line} strokeWidth="0.9" strokeDasharray={ghost ? '3 2' : undefined} />
          ))}
          {implant && (
            <g>
              <path d={`M${w * 0.36} ${NECK} L${w * 0.39} 12 Q${w / 2} 6 ${w * 0.61} 12 L${w * 0.64} ${NECK} Z`} fill="url(#dm-metal)" stroke={implant.color} strokeWidth="1.2" />
              {[18, 26, 34, 42, 50, 58].map((y) => <line key={y} x1={w * 0.365} x2={w * 0.635} y1={y} y2={y - 3} stroke={implant.color} strokeWidth="1" opacity="0.8" />)}
            </g>
          )}
          {has('root_canal') && !implant && canals.map((d, k) => <path key={k} d={d} stroke={has('root_canal').color} strokeWidth="2.6" strokeLinecap="round" fill="none" className="canal" />)}
          {has('post') && <line x1={w / 2} x2={w / 2} y1={NECK + 2} y2={NECK - 26} stroke={has('post').color} strokeWidth="4" strokeLinecap="round" />}
          {has('abscess') && apexes.slice(0, 1).map(([ax, ay]) => (
            <g key="abscess"><circle cx={ax} cy={ay} r="9" fill="url(#dm-abscess)" /><circle cx={ax} cy={ay} r="3.4" fill={has('abscess').color} /></g>
          ))}
          {/* crown */}
          <path d={crown} fill={ghost ? 'none' : 'url(#dm-enamel)'} stroke={line} strokeWidth="1" strokeDasharray={ghost ? '3 2' : undefined} />
          {!ghost && (
            <g clipPath={`url(#${clipSide})`}>
              {fillOf(facial) && <rect x={w * 0.22} y={NECK} width={w * 0.56} height={34} fill={fillOf(facial)} opacity="0.85" />}
              {fillOf('M') && <rect x={mRight ? w * 0.76 : -1} y={NECK} width={w * 0.25} height={50} fill={fillOf('M')} opacity="0.85" />}
              {fillOf('D') && <rect x={mRight ? -1 : w * 0.76} y={NECK} width={w * 0.25} height={50} fill={fillOf('D')} opacity="0.85" />}
              {fillOf(occ) && <rect x={-1} y={96} width={w + 2} height={16} fill={fillOf(occ)} opacity="0.85" />}
              {has('veneer') && <rect x={w * 0.1} y={NECK + 4} width={w * 0.8} height={40} fill={has('veneer').color} opacity="0.5" />}
              {(crownWork || pontic) && <path d={crown} fill={tint((crownWork || pontic).color, 0.3)} />}
              <path d={crown} fill="url(#dm-shine)" />
            </g>
          )}
          {(crownWork || pontic) && <path d={crown} fill="none" stroke={(crownWork || pontic).color} strokeWidth="2.4" />}
          {pontic && (
            <g stroke={pontic.color} strokeWidth="3" strokeLinecap="round">
              <line x1={-4} x2={w * 0.12} y1={82} y2={82} /><line x1={w * 0.88} x2={w + 4} y1={82} y2={82} />
            </g>
          )}
          {has('fracture') && <path d={`M${w * 0.3} ${NECK + 6} L${w * 0.46} ${NECK + 18} L${w * 0.4} ${NECK + 24} L${w * 0.62} ${NECK + 40}`} stroke={has('fracture').color} strokeWidth="2" fill="none" strokeLinecap="round" />}
          {mobility && (
            <g stroke={CONDITION_COLORS.mobility} strokeWidth="1.4" fill="none" strokeLinecap="round">
              <path d={`M-2 80 q-3 5 0 10`} /><path d={`M${w + 2} 80 q3 5 0 10`} />
            </g>
          )}
          {impacted && <path d={crown} fill="none" stroke={impacted.color} strokeWidth="1.4" strokeDasharray="3 2" />}
        </g>
        {planX && <path d={`M-2 6 L${w + 2} ${SIDE_H - 2} M${w + 2} 6 L-2 ${SIDE_H - 2}`} stroke={STATUS_COLORS.planned} strokeWidth="3" strokeLinecap="round" className="plan-x" />}
      </g>
      {/* ---- top view ---- */}
      <g transform={`translate(0 ${topY})`} className={ghost ? 'ghost' : undefined}>
        <path d={o.d} fill={ghost ? 'none' : 'url(#dm-enamel-top)'} stroke={line} strokeWidth="1" strokeDasharray={ghost ? '3 2' : undefined} />
        {!ghost && (
          <g clipPath={`url(#${clipTop})`}>
            {Object.entries(region).map(([face, pts]) => fillOf(face) && <polygon key={face} points={pts} fill={fillOf(face)} opacity="0.88" />)}
            <g stroke={line} strokeWidth="0.6" opacity="0.55">
              <line x1={0} y1={0} x2={o.cx} y2={o.cy} /><line x1={w} y1={0} x2={o.cx} y2={o.cy} />
              <line x1={0} y1={TOP_H} x2={o.cx} y2={o.cy} /><line x1={w} y1={TOP_H} x2={o.cx} y2={o.cy} />
            </g>
            <path d={inner.d} transform={innerShift || undefined} fill={fillOf(occ) || 'url(#dm-enamel-top)'} stroke={line} strokeWidth={innerShift ? 1.6 : 0.7} opacity={fillOf(occ) ? 0.95 : 1} />
            {has('sealant') && <path d={inner.d} transform={innerShift || undefined} fill="url(#dm-sealant)" stroke={has('sealant').color} strokeWidth={innerShift ? 2.4 : 1} style={{ color: has('sealant').color }} />}
            {(crownWork || pontic) && <path d={o.d} fill={tint((crownWork || pontic).color, 0.28)} />}
            <path d={o.d} fill="url(#dm-shine-top)" />
          </g>
        )}
        {(crownWork || pontic) && <path d={o.d} fill="none" stroke={(crownWork || pontic).color} strokeWidth="2.4" />}
        {implant && !crownWork && <circle cx={o.cx} cy={o.cy} r={Math.min(o.a, o.b) * 0.45} fill="url(#dm-metal)" stroke={implant.color} strokeWidth="1.2" />}
        {watch && <circle cx={w - 3} cy={upper ? TOP_H - 4 : 4} r="4" fill={STATUS_COLORS.watch} stroke="var(--panel)" strokeWidth="1.5" className="watch-dot" />}
        {ghost && <path d={`M${w * 0.2} 8 L${w * 0.8} ${TOP_H - 8} M${w * 0.8} 8 L${w * 0.2} ${TOP_H - 8}`} stroke="var(--tooth-line-faint)" strokeWidth="2" strokeLinecap="round" />}
      </g>
    </svg>
  );
}

// Shared gradients for every tooth on the page (enamel, root, metal, shine), themed through CSS variables.
export function ChartDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="dm-enamel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--enamel-1)' }} /><stop offset="0.55" style={{ stopColor: 'var(--enamel-2)' }} /><stop offset="1" style={{ stopColor: 'var(--enamel-3)' }} />
        </linearGradient>
        <radialGradient id="dm-enamel-top" cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" style={{ stopColor: 'var(--enamel-1)' }} /><stop offset="1" style={{ stopColor: 'var(--enamel-3)' }} />
        </radialGradient>
        <linearGradient id="dm-root" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--root-2)' }} /><stop offset="0.45" style={{ stopColor: 'var(--root-1)' }} /><stop offset="1" style={{ stopColor: 'var(--root-2)' }} />
        </linearGradient>
        <linearGradient id="dm-root-back" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--root-2)', stopOpacity: 0.55 }} /><stop offset="1" style={{ stopColor: 'var(--root-2)', stopOpacity: 0.35 }} />
        </linearGradient>
        <linearGradient id="dm-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8b95a3" /><stop offset="0.4" stopColor="#e5e9ef" /><stop offset="0.7" stopColor="#aab3bf" /><stop offset="1" stopColor="#6b7684" />
        </linearGradient>
        <linearGradient id="dm-shine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="0.28" stopColor="#fff" stopOpacity="0.38" /><stop offset="0.4" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="dm-shine-top" cx="0.32" cy="0.28" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.45" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dm-abscess">
          <stop offset="0" stopColor={STATUS_COLORS.problem} stopOpacity="0.55" /><stop offset="1" stopColor={STATUS_COLORS.problem} stopOpacity="0" />
        </radialGradient>
        <pattern id="dm-sealant" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="currentColor" opacity="0.18" /><line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
        </pattern>
      </defs>
    </svg>
  );
}

export default function Odontogram({ conditions = [], procedures = [], selected, onSelect, dentition = 'permanent' }) {
  const uid = useId().replace(/:/g, '');
  const box = useRef(null);
  const showPrimary = dentition !== 'permanent';
  const showPermanent = dentition !== 'primary';
  // Rows in the order they're drawn, for arrow-key moves.
  const rows = [showPermanent && UPPER, showPrimary && P_UPPER, showPrimary && P_LOWER, showPermanent && LOWER].filter(Boolean);
  const move = (e) => {
    const keys = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (!keys[e.key]) return;
    const current = document.activeElement?.dataset?.tooth || selected;
    let r = rows.findIndex((row) => row.includes(current));
    let c = r >= 0 ? rows[r].indexOf(current) : 0;
    if (r < 0) r = 0;
    e.preventDefault();
    const [dr, dc] = keys[e.key];
    const nr = Math.max(0, Math.min(rows.length - 1, r + dr));
    // Up/down keeps roughly the same place along the arch, even between permanent and primary rows.
    c = dr ? Math.round((c / (rows[r].length - 1)) * (rows[nr].length - 1)) : Math.max(0, Math.min(rows[nr].length - 1, c + dc));
    const next = rows[nr][c];
    box.current?.querySelector(`[data-tooth="${next}"]`)?.focus();
    onSelect?.(next);
  };
  const tooth = (t) => {
    const state = toothState(t, conditions, procedures);
    const upper = isUpper(t);
    const label = `Tooth ${t}${state.notes.length ? `: ${state.notes.join(', ')}` : ''}`;
    return (
      <button
        type="button" key={t} data-tooth={t} style={{ '--w': toothWidth(t) + 8 }}
        className={`tooth2${selected === t ? ' selected' : ''}${state.missing ? ' missing' : ''}${state.notes.length ? ' charted' : ''}${isMolar(t) ? ' molar' : ''}`}
        onClick={() => onSelect?.(t === selected ? null : t)} title={label} aria-label={label} aria-pressed={selected === t}
        tabIndex={selected ? (selected === t ? 0 : -1) : (t === '1' || t === 'A' ? 0 : -1)}
      >
        {upper && <span className="tnum">{t}</span>}
        <ToothSvg tooth={t} state={state} uid={`${uid}-${t}`} />
        {!upper && <span className="tnum">{t}</span>}
      </button>
    );
  };
  // Supernumerary teeth appear once something is charted on them.
  const extra = [...new Set([...conditions, ...procedures].map((x) => x.tooth).filter((t) => t && baseTooth(t) !== t))];
  const areaWork = procedures.filter((p) => p.area);
  const arch = (teeth, cls) => (
    <div className={`arch2 ${cls}`} style={{ gridTemplateColumns: teeth.map((t) => `${toothWidth(t) + 8}fr`).join(' ') }}>
      {teeth.map(tooth)}
    </div>
  );
  return (
    <div className="odonto-wrap">
      <ChartDefs />
      <div className="odontogram2" ref={box} onKeyDown={move} role="group" aria-label="Tooth chart: arrow keys move between teeth">
        <div className="odo-side-labels" aria-hidden="true"><span>R</span><span>L</span></div>
        {showPermanent && arch(UPPER, 'upper')}
        {showPrimary && arch(P_UPPER, 'upper primary')}
        <div className="odo-midline" aria-hidden="true"><span>Patient right</span><span className="odo-plane" /><span>Patient left</span></div>
        {showPrimary && arch(P_LOWER, 'lower primary')}
        {showPermanent && arch(LOWER, 'lower')}
        {extra.length > 0 && (
          <div className="arch2 supernumerary">
            <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>Supernumerary</span>
            {extra.map(tooth)}
          </div>
        )}
      </div>
      {areaWork.length > 0 && (
        <div className="area-work">
          {areaWork.map((p) => (
            <span key={p.id} className="area-chip" style={{ borderColor: p.status === 'planned' ? STATUS_COLORS.planned : STATUS_COLORS.completed }}>
              <strong>{p.area}</strong> {p.code}
            </span>
          ))}
        </div>
      )}
      <ChartLegend />
    </div>
  );
}

export function ChartLegend() {
  const dot = (c) => <i className="lg-dot" style={{ background: c }} />;
  return (
    <div className="legend2">
      <span>{dot(STATUS_COLORS.planned)}Planned</span>
      <span>{dot(STATUS_COLORS.completed)}Done here</span>
      <span>{dot(STATUS_COLORS.existing)}Existing</span>
      <span>{dot(STATUS_COLORS.problem)}Caries · fracture · abscess</span>
      <span>{dot(STATUS_COLORS.watch)}Watch</span>
      <span><i className="lg2 lg2-crown" />Crown</span>
      <span><i className="lg2 lg2-rct" />Root canal</span>
      <span><i className="lg2 lg2-implant" />Implant</span>
      <span><i className="lg2 lg2-pontic" />Bridge</span>
      <span><i className="lg2 lg2-sealant" />Sealant</span>
      <span><b style={{ color: STATUS_COLORS.planned }}>✕</b> Extraction planned</span>
      <span><i className="lg2 lg2-missing" />Missing</span>
    </div>
  );
}
