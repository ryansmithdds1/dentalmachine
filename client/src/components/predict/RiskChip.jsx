import { CircleSlash, FileWarning } from 'lucide-react';
import './predict.css';

// Predictions only inform: these show a percentage and the reasons in plain words, never act on them.
// A prediction: { probability, percent, level?, confidence, reasons: [], driver }.
const CONF = { low: 'not much history yet', medium: 'some history', high: 'lots of history' };
export const reasonsText = (p) => (p?.reasons?.length ? p.reasons.join(', ') : '');
export const confidenceText = (p) => CONF[p?.confidence] || '';
const title = (label, p) => `${label} ${p.percent}%${reasonsText(p) ? ` — ${reasonsText(p)}` : ''}${p.confidence ? ` (${confidenceText(p)})` : ''}. A prediction from this office’s history — it doesn’t change anything by itself.`;

// "No-show risk 34%". The level (high / some / low) comes from the server, relative to the office's usual rate.
export function NoShowChip({ risk, withReasons = false }) {
  if (!risk) return null;
  return (
    <span className="risk-line" data-noshow-risk={risk.percent}>
      <span className={`risk-chip ${risk.level || 'low'}`} title={title('No-show risk', risk)}>
        <CircleSlash size={11} aria-hidden="true" /> No-show risk {risk.percent}%{risk.confidence === 'low' && !withReasons && <span className="risk-conf"> · little history</span>}
      </span>
      {withReasons && reasonsText(risk) && <span className="risk-why"> — {reasonsText(risk)}</span>}
    </span>
  );
}

export const denialLevel = (p) => (p >= 0.5 ? 'high' : p >= 0.2 ? 'some' : 'low');
// "Likely denied: 62%" when it's more likely than not, else "Denial risk 8%".
export function DenialChip({ denial, withReasons = false }) {
  if (!denial) return null;
  const level = denialLevel(denial.probability);
  const label = level === 'high' ? 'Likely denied:' : 'Denial risk';
  return (
    <span className="risk-line" data-denial-risk={denial.percent}>
      <span className={`risk-chip ${level}`} title={title(label, denial)}>
        <FileWarning size={11} aria-hidden="true" /> {label} {denial.percent}%{denial.confidence === 'low' && !withReasons && <span className="risk-conf"> · little history</span>}
      </span>
      {withReasons && reasonsText(denial) && <span className="risk-why"> — {denial.code && !reasonsText(denial).includes(denial.code) ? `${denial.code}${denial.tooth ? ` #${denial.tooth}` : ''}: ` : ''}{reasonsText(denial)}</span>}
    </span>
  );
}
