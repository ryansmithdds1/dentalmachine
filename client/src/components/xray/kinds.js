// X-ray AI findings (backlog XR1–XR3): one colour per kind, shared by the viewer overlay, the review list and the
// chair screen. The same words the server uses for the label every finding carries.
export const AI_COLOR = {
  caries: '#f43f5e', calculus: '#f59e0b', bone_loss: '#a855f7', periapical: '#ef4444', open_margin: '#fb923c', restoration: '#38bdf8', crown: '#38bdf8',
  root_canal: '#22d3ee', implant: '#94a3b8', impacted: '#eab308', other: '#e2e8f0',
};
export const DISCLAIMER = 'AI suggestion — the dentist decides';
export const pct = (c) => `${Math.round((Number(c) || 0) * 100)}%`;
export const where = (f) => (f.tooth ? `#${f.tooth}${f.surfaces ? ` ${f.surfaces}` : ''}` : 'tooth not identified');
