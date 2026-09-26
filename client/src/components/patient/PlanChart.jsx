import { useId } from 'react';
import { UPPER, LOWER, isUpper } from '../teeth.js';
import { ToothSvg, ChartDefs, toothState, toothWidth, overlayFor, STATUS_COLORS, QUADRANT_LABELS } from '../Odontogram.jsx';
import './planchart.css';

// The patient's mouth with their plan drawn on it — the same tooth drawings as the chart (Odontogram.jsx), so a
// crown, root canal, implant, bridge, filled surfaces and a tooth coming out (✕) look the same everywhere. Each
// phase has its own colour; work already done and what's already in the mouth are green. Teeth in the plan light
// up; `active`/`onActive` tie a tooth to the procedures listed beside it (hover or focus either one).
export const PHASE_COLORS = ['#e11d48', '#7c3aed', '#d97706', '#c026d3', '#0e7490'];
export const phaseColor = (n) => PHASE_COLORS[(Math.max(1, Number(n) || 1) - 1) % PHASE_COLORS.length];

// What each kind of work is called on the legend (only the kinds in this plan are listed).
const MARKS = {
  crown: 'Crown', root_canal: 'Root canal', implant: 'Implant', pontic: 'Bridge', extraction: 'Tooth removed', post: 'Buildup or post', sealant: 'Sealant', veneer: 'Veneer', filling: 'Filling',
};
const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '') : s);
const markOf = (l) => overlayFor(l.code) || (l.surfaces ? 'filling' : null);
const toothOf = (l) => (l.tooth ? String(l.tooth).toUpperCase() : null);

// lines: [{ code, tooth, surfaces, area, phase, status ('planned'|'completed'), plain }]. existing: the patient's
// chart ([{ tooth, condition, surfaces }]) and done: work done before ([{ tooth, code, surfaces }]).
// phases: [{ phase, name }] for the legend. t: translates on patient pages.
export default function PlanChart({ lines = [], existing = [], done = [], phases = [], active = null, onActive, onPick, compact = false, legend = !compact, t = fill, label }) {
  const uid = useId().replace(/:/g, '');
  const planned = lines.filter((l) => l.status !== 'completed');
  const procedures = [
    ...done.filter((d) => d.tooth).map((d) => ({ ...d, tooth: toothOf(d), status: 'completed', color: STATUS_COLORS.existing })),
    ...lines.filter((l) => l.tooth).map((l) => ({ ...l, tooth: toothOf(l), status: l.status === 'completed' ? 'completed' : 'planned', color: l.status === 'completed' ? STATUS_COLORS.existing : phaseColor(l.phase) })),
  ];
  const conditions = existing.map((c) => ({ ...c, tooth: toothOf(c) }));
  const inPlan = new Map();
  for (const l of lines) if (toothOf(l)) inPlan.set(toothOf(l), [...(inPlan.get(toothOf(l)) || []), l]);
  const describe = (n) => {
    const work = inPlan.get(n) || [];
    return `${t('Tooth #{n}', { n })}${work.length ? `: ${[...new Set(work.map((w) => t(w.plain || w.description || w.code)))].join(', ')}` : ''}`;
  };
  const tooth = (n) => {
    const on = inPlan.has(n);
    const state = toothState(n, conditions, procedures);
    const colors = [...new Set((inPlan.get(n) || []).map((l) => (l.status === 'completed' ? STATUS_COLORS.existing : phaseColor(l.phase))))];
    const cls = `pc-tooth tm-tooth${on ? ' on' : ''}${active === n ? ' active' : ''}${active && on && active !== n ? ' faded' : ''}`;
    const body = (
      <>
        {isUpper(n) && <span className="pc-num">{n}</span>}
        <ToothSvg tooth={n} state={state} uid={`${uid}-${n}`} />
        {!isUpper(n) && <span className="pc-num">{n}</span>}
        {on && !compact && <span className="pc-dots" aria-hidden="true">{colors.map((c) => <i key={c} style={{ background: c }} />)}</span>}
      </>
    );
    const style = { '--pc-c': colors[0] || 'var(--primary)' };
    if (!on || compact || !onActive) return <div key={n} className={cls} data-tooth={n} style={style} title={on ? describe(n) : undefined}>{body}</div>;
    return (
      <button key={n} type="button" className={cls} data-tooth={n} style={style} aria-label={describe(n)} aria-pressed={active === n}
        onMouseEnter={() => onActive(n)} onMouseLeave={() => onActive(null)} onFocus={() => onActive(n)} onBlur={() => onActive(null)}
        onClick={() => onPick?.(n)}>
        {body}
      </button>
    );
  };
  const arch = (teeth, cls) => (
    <div className={`pc-arch ${cls}`} style={{ gridTemplateColumns: teeth.map((n) => `${toothWidth(n) + 8}fr`).join(' ') }}>{teeth.map(tooth)}</div>
  );
  // Work for a whole area (deep cleaning by quadrant, a denture…): chips under the drawing.
  const areaWork = planned.filter((l) => !l.tooth);
  const marks = [...new Set(lines.map(markOf).filter(Boolean))];
  const phaseList = phases.length ? phases : [...new Set(planned.map((l) => l.phase || 1))].map((p) => ({ phase: p, name: t('Phase {n}', { n: p }) }));
  const teethList = [...inPlan.keys()];
  return (
    <figure className={`plan-chart tooth-map${compact ? ' compact' : ''}`} aria-label={label || `${t('Teeth in your plan')}: ${teethList.map((n) => `#${n}`).join(', ') || t('none')}`}>
      <ChartDefs />
      <div className="pc-mouth">
        <div className="pc-side" aria-hidden="true"><span>{t('Right')}</span><span>{t('Left')}</span></div>
        <div className="pc-label" aria-hidden="true">{t('Upper')}</div>
        {arch(UPPER, 'upper')}
        <div className="pc-bite" aria-hidden="true" />
        {arch(LOWER, 'lower')}
        <div className="pc-label" aria-hidden="true">{t('Lower')}</div>
      </div>
      {areaWork.length > 0 && (
        <div className="pc-areas">
          {areaWork.map((l, i) => (
            <span key={i} className="pc-area" style={{ '--pc-c': phaseColor(l.phase) }}><i aria-hidden="true" />{t(l.plain || l.description || l.code)}{l.area ? ` · ${t(QUADRANT_LABELS[l.area] || l.area)}` : ''}</span>
          ))}
        </div>
      )}
      {legend && (
        <figcaption className="pc-legend">
          {phaseList.length > 1 && phaseList.map((p) => <span key={p.phase}><i className="sw" style={{ background: phaseColor(p.phase) }} />{t(p.name)}</span>)}
          {phaseList.length === 1 && <span><i className="sw" style={{ background: phaseColor(phaseList[0].phase) }} />{t('Recommended')}</span>}
          {(existing.length > 0 || done.length > 0 || lines.some((l) => l.status === 'completed')) && <span><i className="sw" style={{ background: STATUS_COLORS.existing }} />{t('Already done')}</span>}
          {marks.map((m) => <span key={m} className="pc-mark"><MarkIcon kind={m} />{t(MARKS[m])}</span>)}
        </figcaption>
      )}
    </figure>
  );
}

// The little picture for each kind of mark on the legend.
function MarkIcon({ kind }) {
  const c = 'currentColor';
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, className: 'pc-mi' };
  if (kind === 'extraction') return <svg {...common}><path d="M3 3l10 10M13 3L3 13" stroke={c} strokeWidth="2.2" strokeLinecap="round" /></svg>;
  if (kind === 'root_canal' || kind === 'post') return <svg {...common}><path d="M8 2v12" stroke={c} strokeWidth="2.4" strokeLinecap="round" /></svg>;
  if (kind === 'implant') return <svg {...common}><path d="M6 2h4l-.5 12h-3z" fill="none" stroke={c} strokeWidth="1.4" /><path d="M6 5h4M6 8h4M6.3 11h3.4" stroke={c} strokeWidth="1" /></svg>;
  if (kind === 'pontic') return <svg {...common}><path d="M1 8h14" stroke={c} strokeWidth="2.4" strokeLinecap="round" /><rect x="5" y="4" width="6" height="8" rx="2" fill="none" stroke={c} strokeWidth="1.4" /></svg>;
  if (kind === 'filling') return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke={c} strokeWidth="1.2" /><path d="M2.5 2.5L8 8l5.5-5.5z" fill={c} opacity="0.85" /></svg>;
  if (kind === 'sealant') return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke={c} strokeWidth="1.2" /><path d="M4 12l8-8M6.5 13l6.5-6.5M3 9.5L9.5 3" stroke={c} strokeWidth="1" /></svg>;
  return <svg {...common}><path d="M3 6c0-2 2-3.5 5-3.5S13 4 13 6c0 3-1 7-2.2 7.5-1 .4-1.3-3-2.8-3s-1.8 3.4-2.8 3C4 13 3 9 3 6z" fill="none" stroke={c} strokeWidth="2" /></svg>;
}

// One tooth with one procedure drawn on it, for the list beside the chart.
export function ToothThumb({ line, size = 30 }) {
  const uid = useId().replace(/:/g, '');
  const n = toothOf(line);
  if (!n) return <span className="pc-thumb none" style={{ '--thumb': `${size}px` }} aria-hidden="true" />;
  const state = toothState(n, [], [{ ...line, tooth: n, status: line.status === 'completed' ? 'completed' : 'planned', color: line.status === 'completed' ? STATUS_COLORS.existing : phaseColor(line.phase) }]);
  // Fillings and sealants show on the biting view (the surfaces); everything else from the side.
  const view = ['filling', 'sealant'].includes(markOf(line)) ? 'top' : 'side';
  return (
    <span className={`pc-thumb ${view}`} style={{ '--thumb': `${size}px` }} aria-hidden="true">
      <ToothSvg tooth={n} state={state} uid={`${uid}-t`} view={view} />
    </span>
  );
}
