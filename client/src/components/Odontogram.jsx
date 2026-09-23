// Graphic odontogram. Universal numbering: permanent upper 1-16 and lower 32-17 (patient's right to left
// as you face them), primary upper A-J and lower T-K, supernumerary teeth 51-82 / AS-TS drawn after the arch.
const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
const P_UPPER = 'ABCDEFGHIJ'.split('');
const P_LOWER = 'TSRQPONMLK'.split('');

// What each colour means, everywhere on the chart.
export const STATUS_COLORS = { planned: '#dc2626', completed: '#2563eb', existing: '#15803d', problem: '#b91c1c', watch: '#d97706' };

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

const POSTERIOR = new Set(['1', '2', '3', '4', '5', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '28', '29', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
const MOLARS = new Set(['1', '2', '3', '14', '15', '16', '17', '18', '19', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
// A supernumerary tooth is drawn like the tooth it sits beside (51 ↔ 1, AS ↔ A).
export const baseTooth = (t) => {
  const s = String(t).toUpperCase();
  if (/^[A-T]S$/.test(s)) return s[0];
  const n = Number(s);
  return n >= 51 && n <= 82 ? String(n - 50) : s;
};
export const isPosterior = (t) => POSTERIOR.has(baseTooth(t));
export const isUpper = (t) => {
  const b = baseTooth(t);
  return /^[A-J]$/.test(b) || (Number(b) >= 1 && Number(b) <= 16);
};
// The five surfaces as this tooth names them: posterior teeth have B and O, anterior F and I.
export const surfacesFor = (t) => (t && !isPosterior(t) ? ['M', 'I', 'D', 'F', 'L'] : ['M', 'O', 'D', 'B', 'L']);
export const QUADRANT_LABELS = { UR: 'Upper right', UL: 'Upper left', LL: 'Lower left', LR: 'Lower right', U: 'Upper arch', L: 'Lower arch' };

// Everything drawn on one tooth.
function toothState(tooth, conditions, procedures) {
  const fills = {};
  const overlays = [];
  let missing = false;
  let planX = false;
  let watch = false;
  let mobility = false;
  for (const c of conditions.filter((x) => x.tooth === tooth && !x.resolved)) {
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
    const color = p.status === 'planned' ? STATUS_COLORS.planned : STATUS_COLORS.completed;
    const kind = overlayFor(p.code);
    if (kind === 'extraction') {
      if (p.status === 'planned') planX = true;
      else missing = true;
    } else if (kind) overlays.push({ kind, color });
    if (p.surfaces && !['crown', 'veneer', 'sealant'].includes(kind)) for (const s of p.surfaces) fills[s] = color;
  }
  return { fills, overlays, missing, planX, watch, mobility };
}

// One tooth: the crown as a five-surface diagram, with its root(s) above (upper) or below (lower).
function ToothSvg({ tooth, state, size = 1 }) {
  const upper = isUpper(tooth);
  const posterior = isPosterior(tooth);
  const b = baseTooth(tooth);
  const n = Number(b);
  // Mesial faces the midline: the right of the drawing for the patient's right side.
  const mesialRight = /^[A-E]$|^[P-T]$/.test(b) || (n >= 1 && n <= 8) || (n >= 25 && n <= 32);
  const occ = posterior ? 'O' : 'I';
  const facial = posterior ? 'B' : 'F';
  const [top, bottom] = upper ? [facial, 'L'] : ['L', facial];
  const [left, right] = mesialRight ? ['D', 'M'] : ['M', 'D'];
  const { fills, overlays, missing, planX, watch, mobility } = state;
  const alt = { B: 'F', F: 'B', O: 'I', I: 'O' };
  const c = (s) => fills[s] || fills[alt[s]] || '#fff';
  const has = (k) => overlays.find((o) => o.kind === k);
  const W = 40;
  const H = 76;
  // Crown box and root area, flipped for the lower arch.
  const crownY = upper ? 36 : 2;
  const rootTop = upper ? 2 : 40;
  const rootBottom = upper ? 36 : 74;
  const apex = upper ? rootTop : rootBottom;
  const cervical = upper ? rootBottom : rootTop;
  const roots = MOLARS.has(b) ? [12, 28] : [20];
  const pontic = has('pontic');
  const implant = has('implant');
  const stroke = missing ? '#cbd5e1' : '#64748b';
  const x0 = 2;
  const y0 = crownY;
  const s = 36;
  const i = 11;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={size !== 1 ? { maxWidth: W * size } : undefined} aria-hidden="true">
      <g opacity={missing ? 0.35 : 1}>
        {/* roots */}
        {!pontic && !implant && roots.map((x) => (
          <path key={x} d={`M${x - 7} ${cervical} C${x - 7} ${(cervical + apex) / 2} ${x - 4} ${apex} ${x} ${apex} C${x + 4} ${apex} ${x + 7} ${(cervical + apex) / 2} ${x + 7} ${cervical}`} fill="#f8fafc" stroke={stroke} strokeWidth="1" />
        ))}
        {implant && (
          <g stroke={implant.color} strokeWidth="1.5" fill="none">
            <rect x="15" y={Math.min(apex, cervical) + 2} width="10" height="30" rx="2" fill={`${implant.color}22`} />
            {[0, 1, 2, 3, 4].map((k) => <line key={k} x1="15" x2="25" y1={Math.min(apex, cervical) + 6 + k * 6} y2={Math.min(apex, cervical) + 8 + k * 6} />)}
          </g>
        )}
        {has('root_canal') && roots.map((x) => <line key={x} x1={x} x2={x} y1={cervical} y2={apex + (upper ? 3 : -3)} stroke={has('root_canal').color} strokeWidth="3" strokeLinecap="round" />)}
        {has('post') && <line x1="20" x2="20" y1={cervical} y2={(cervical + apex) / 2} stroke={has('post').color} strokeWidth="4" />}
        {/* crown: five surfaces */}
        <g stroke={stroke} strokeWidth="1">
          <polygon points={`${x0},${y0} ${x0 + s},${y0} ${x0 + s - i},${y0 + i} ${x0 + i},${y0 + i}`} fill={c(top)} />
          <polygon points={`${x0 + s},${y0} ${x0 + s},${y0 + s} ${x0 + s - i},${y0 + s - i} ${x0 + s - i},${y0 + i}`} fill={c(right)} />
          <polygon points={`${x0},${y0 + s} ${x0 + s},${y0 + s} ${x0 + s - i},${y0 + s - i} ${x0 + i},${y0 + s - i}`} fill={c(bottom)} />
          <polygon points={`${x0},${y0} ${x0 + i},${y0 + i} ${x0 + i},${y0 + s - i} ${x0},${y0 + s}`} fill={c(left)} />
          <rect x={x0 + i} y={y0 + i} width={s - 2 * i} height={s - 2 * i} fill={c(occ)} />
        </g>
        {has('crown') && <rect x={x0 - 1} y={y0 - 1} width={s + 2} height={s + 2} rx="5" fill="none" stroke={has('crown').color} strokeWidth="3.5" />}
        {pontic && (
          <g>
            <rect x={x0 - 1} y={y0 - 1} width={s + 2} height={s + 2} rx="5" fill="none" stroke={pontic.color} strokeWidth="3.5" />
            <line x1="0" x2={W} y1={upper ? y0 - 3 : y0 + s + 3} y2={upper ? y0 - 3 : y0 + s + 3} stroke={pontic.color} strokeWidth="3" />
          </g>
        )}
        {has('veneer') && <rect x={x0 + 2} y={facial === top ? y0 + 1 : y0 + s - 6} width={s - 4} height="5" fill={has('veneer').color} />}
        {has('sealant') && <text x="20" y={y0 + 22} textAnchor="middle" fontSize="11" fontWeight="700" fill={has('sealant').color}>S</text>}
        {has('fracture') && <path d={`M${x0 + 8} ${y0 + 4} L${x0 + 16} ${y0 + 16} L${x0 + 12} ${y0 + 20} L${x0 + 26} ${y0 + 32}`} stroke={has('fracture').color} strokeWidth="2" fill="none" />}
        {has('abscess') && <circle cx="20" cy={apex + (upper ? 4 : -4)} r="4" fill={has('abscess').color} />}
        {has('impacted') && <rect x="1" y="1" width={W - 2} height={H - 2} rx="6" fill="none" stroke={has('impacted').color} strokeDasharray="3 2" />}
      </g>
      {missing && <path d={`M4 ${y0 + 2} L36 ${y0 + s - 2} M36 ${y0 + 2} L4 ${y0 + s - 2}`} stroke="#64748b" strokeWidth="2.5" />}
      {planX && <path d={`M2 4 L38 ${H - 4} M38 4 L2 ${H - 4}`} stroke={STATUS_COLORS.planned} strokeWidth="3" />}
      {watch && <circle cx="35" cy={upper ? 70 : 6} r="4" fill={STATUS_COLORS.watch} />}
      {mobility && <text x="4" y={upper ? 72 : 10} fontSize="9" fontWeight="700" fill={CONDITION_COLORS.mobility}>M</text>}
    </svg>
  );
}

export default function Odontogram({ conditions = [], procedures = [], selected, onSelect, dentition = 'permanent', size = 1 }) {
  const tooth = (t) => {
    const state = toothState(t, conditions, procedures);
    const upper = isUpper(t);
    const missing = state.missing;
    return (
      <button
        type="button" key={t} className={`tooth${selected === t ? ' selected' : ''}${missing ? ' missing' : ''}`}
        onClick={() => onSelect?.(t === selected ? null : t)} title={`Tooth ${t}${missing ? ' (missing)' : ''}`} aria-pressed={selected === t}
      >
        {upper && <span className="num">{t}</span>}
        <ToothSvg tooth={t} state={state} size={size} />
        {!upper && <span className="num">{t}</span>}
      </button>
    );
  };
  // Supernumerary teeth appear once something is charted on them.
  const extra = [...new Set([...conditions, ...procedures].map((x) => x.tooth).filter((t) => t && baseTooth(t) !== t))];
  const areaWork = procedures.filter((p) => p.area);
  const showPrimary = dentition !== 'permanent';
  const showPermanent = dentition !== 'primary';
  return (
    <div>
      <div className="odontogram">
        {showPermanent && <div className="arch">{UPPER.map(tooth)}</div>}
        {showPrimary && <div className="arch primary">{P_UPPER.map(tooth)}</div>}
        <div className="muted arch-sides"><span>Patient right</span><span>Patient left</span></div>
        {showPrimary && <div className="arch primary">{P_LOWER.map(tooth)}</div>}
        {showPermanent && <div className="arch">{LOWER.map(tooth)}</div>}
        {extra.length > 0 && (
          <div className="arch supernumerary">
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
  return (
    <div className="legend">
      <span><i style={{ background: STATUS_COLORS.planned }} />Treatment planned</span>
      <span><i style={{ background: STATUS_COLORS.completed }} />Completed here</span>
      <span><i style={{ background: STATUS_COLORS.existing }} />Existing (other office)</span>
      <span><i style={{ background: STATUS_COLORS.problem }} />Caries / fracture / abscess</span>
      <span><i style={{ background: STATUS_COLORS.watch, borderRadius: '50%' }} />Watch</span>
      <span><i className="lg-crown" />Crown</span>
      <span><i className="lg-rct" />Root canal</span>
      <span><i className="lg-implant" />Implant</span>
      <span><i className="lg-pontic" />Pontic</span>
      <span><b style={{ color: STATUS_COLORS.existing }}>S</b> Sealant</span>
      <span><b style={{ color: STATUS_COLORS.planned }}>✕</b> Extraction planned</span>
      <span><b>✕</b> Missing</span>
      <span><b style={{ color: CONDITION_COLORS.mobility }}>M</b> Mobility</span>
    </div>
  );
}
