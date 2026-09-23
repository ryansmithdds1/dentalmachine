// Universal numbering: upper arch 1-16 (patient's right to left), lower arch 17-32 (patient's left to right).
const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));

export const CONDITION_COLORS = {
  caries: '#dc2626',
  missing: '#94a3b8',
  filling: '#2563eb',
  crown: '#ca8a04',
  root_canal: '#9333ea',
  implant: '#0891b2',
  bridge_pontic: '#a16207',
  fracture: '#ea580c',
  sealant: '#16a34a',
  veneer: '#db2777',
  impacted: '#64748b',
  watch: '#f59e0b',
  abscess: '#b91c1c',
  mobility: '#7c3aed',
};
const PLANNED = '#dc2626';
const DONE = '#2563eb';

const isMolarOrPremolar = (n) => {
  const t = Number(n);
  return [1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 28, 29, 30, 31, 32].includes(t);
};

// Five-surface tooth diagram. Surfaces: B/F (outer), L (inner), M, D, O/I (center).
function ToothSvg({ tooth, upper, fills, missing, outline }) {
  const occ = isMolarOrPremolar(tooth) ? 'O' : 'I';
  const facial = isMolarOrPremolar(tooth) ? 'B' : 'F';
  // Mesial faces the midline: for teeth 1-8 and 25-32 that's the right side of the drawing.
  const t = Number(tooth);
  const mesialRight = (t >= 1 && t <= 8) || (t >= 25 && t <= 32);
  const top = upper ? facial : 'L';
  const bottom = upper ? 'L' : facial;
  const left = mesialRight ? 'D' : 'M';
  const right = mesialRight ? 'M' : 'D';
  const c = (s) => fills[s] || fills[s === 'B' ? 'F' : s === 'F' ? 'B' : s === 'O' ? 'I' : s === 'I' ? 'O' : s] || '#fff';
  return (
    <svg width="32" height="32" viewBox="0 0 32 32">
      <g stroke={outline || '#64748b'} strokeWidth={outline ? 2 : 1}>
        <polygon points="0,0 32,0 22,10 10,10" fill={c(top)} />
        <polygon points="32,0 32,32 22,22 22,10" fill={c(right)} />
        <polygon points="0,32 32,32 22,22 10,22" fill={c(bottom)} />
        <polygon points="0,0 10,10 10,22 0,32" fill={c(left)} />
        <rect x="10" y="10" width="12" height="12" fill={c(occ)} />
      </g>
      {missing && <path d="M2 2 L30 30 M30 2 L2 30" stroke="#475569" strokeWidth="3" />}
    </svg>
  );
}

export default function Odontogram({ conditions = [], procedures = [], selected, onSelect }) {
  const info = (tooth) => {
    const fills = {};
    let outline = null;
    let missing = false;
    const active = conditions.filter((c) => c.tooth === tooth && !c.resolved);
    for (const c of active) {
      if (c.condition === 'missing' || c.condition === 'impacted') missing = true;
      const color = CONDITION_COLORS[c.condition];
      if (c.surfaces) for (const s of c.surfaces) fills[s] = color;
      else outline = color;
    }
    for (const p of procedures.filter((x) => x.tooth === tooth)) {
      const color = p.status === 'planned' ? PLANNED : DONE;
      if (p.surfaces) for (const s of p.surfaces) fills[s] = color;
      else if (p.status === 'planned') outline = PLANNED;
    }
    return { fills, outline, missing };
  };

  const renderTooth = (tooth, upper) => {
    const { fills, outline, missing } = info(tooth);
    return (
      <div key={tooth} className={`tooth${selected === tooth ? ' selected' : ''}`} onClick={() => onSelect?.(tooth === selected ? null : tooth)} title={`Tooth ${tooth}`}>
        {upper && <span className="num">{tooth}</span>}
        <ToothSvg tooth={tooth} upper={upper} fills={fills} outline={outline} missing={missing} />
        {!upper && <span className="num">{tooth}</span>}
      </div>
    );
  };

  return (
    <div>
      <div className="odontogram">
        <div className="arch">{UPPER.map((t) => renderTooth(t, true))}</div>
        <div className="muted" style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', width: '100%', maxWidth: 700 }}>
          <span>Patient right</span><span>Patient left</span>
        </div>
        <div className="arch">{LOWER.map((t) => renderTooth(t, false))}</div>
      </div>
      <div className="legend">
        <span><i style={{ background: PLANNED }} />Planned treatment / caries</span>
        <span><i style={{ background: DONE }} />Completed / existing restoration</span>
        <span><i style={{ background: CONDITION_COLORS.crown }} />Crown</span>
        <span><i style={{ background: CONDITION_COLORS.root_canal }} />Root canal</span>
        <span><i style={{ background: CONDITION_COLORS.implant }} />Implant</span>
        <span><i style={{ background: CONDITION_COLORS.missing }} />Missing (✕)</span>
      </div>
    </div>
  );
}
