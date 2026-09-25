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
const lineName = (l) => `${l.code}${l.tooth ? ` #${l.tooth}` : ''}`;
// "Likely denied: 62%" when it's more likely than not, else "Denial risk 8%". For a whole claim of several lines
// (`claim`), the percentage is the chance at least one line is denied, and the hover says so.
export function DenialChip({ denial, withReasons = false, claim = false }) {
  if (!denial) return null;
  const level = denialLevel(denial.probability);
  const label = level === 'high' ? 'Likely denied:' : 'Denial risk';
  const many = claim && denial.line_count > 1;
  const hover = many
    ? `Claim: ${denial.percent}% chance at least one line is denied${denial.riskiest ? ` (riskiest line ${lineName(denial.riskiest)} ${denial.riskiest.percent}%)` : ''}${reasonsText(denial) ? ` — ${reasonsText(denial)}` : ''}. A prediction from this office’s history — it doesn’t change anything by itself.`
    : title(label, denial);
  return (
    <span className="risk-line" data-denial-risk={denial.percent}>
      <span className={`risk-chip ${level}`} title={hover}>
        <FileWarning size={11} aria-hidden="true" /> {label} {denial.percent}%{denial.confidence === 'low' && !withReasons && <span className="risk-conf"> · little history</span>}
      </span>
      {withReasons && reasonsText(denial) && <span className="risk-why"> — {denial.code && !reasonsText(denial).includes(denial.code) ? `${denial.code}${denial.tooth ? ` #${denial.tooth}` : ''}: ` : ''}{reasonsText(denial)}</span>}
    </span>
  );
}

// The claim as a whole: "Claim: 41% chance something is denied · riskiest line D2950 #3 32%", with the reasons (the
// riskiest line's). One line: the line's own chip. denial: { claim, lines } from the server (predict/denial.js).
export function ClaimDenial({ denial }) {
  const c = denial?.claim;
  if (!c) return null;
  if (!((c.line_count || denial.lines?.length || 0) > 1)) return <DenialChip denial={c} withReasons />;
  const level = denialLevel(c.probability);
  const why = reasonsText(c);
  return (
    <span className="risk-line claim-denial-line" data-denial-risk={c.percent} data-claim-denial={c.percent}>
      <span className={`risk-chip ${level}`} title={`The chance at least one line on this claim is denied, counting what the lines share (the payer, the claim) once${c.confidence ? ` (${confidenceText(c)})` : ''}. A prediction from this office’s history — it doesn’t change anything by itself.`}>
        <FileWarning size={11} aria-hidden="true" /> Claim: {c.percent}% chance something is denied
      </span>
      {c.riskiest && <span className="risk-why" data-riskiest-line={c.riskiest.code}> · riskiest line {lineName(c.riskiest)} {c.riskiest.percent}%</span>}
      {why && <span className="risk-why"> — {why}</span>}
    </span>
  );
}
