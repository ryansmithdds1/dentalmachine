import PlanChart from './PlanChart.jsx';

// A small picture of the mouth with some teeth lit up (an option on the compare board): the plan chart's own tooth
// drawings in compact form, so there is one way of drawing teeth for patients (PlanChart.jsx).
export default function ToothMap({ teeth = [], size = 320, label = 'Teeth in your plan', t }) {
  const lines = [...new Set(teeth.map((n) => String(n).toUpperCase()))].map((tooth) => ({ tooth, code: '', phase: 1 }));
  return (
    <div className="tooth-map-wrap" style={{ maxWidth: size }}>
      <PlanChart lines={lines} compact t={t} label={`${label}: ${lines.map((l) => l.tooth).join(', ') || 'none'}`} />
    </div>
  );
}
