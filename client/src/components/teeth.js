// Facts about teeth, shared by the chart drawing, charting shorthand and perio. Universal numbering:
// permanent upper 1-16 and lower 32-17 (patient's right to left as you face them), primary upper A-J and
// lower T-K, supernumerary 51-82 (beside 1-32) and AS-TS (beside A-T).
export const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
export const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
export const P_UPPER = 'ABCDEFGHIJ'.split('');
export const P_LOWER = 'TSRQPONMLK'.split('');

const POSTERIOR = new Set(['1', '2', '3', '4', '5', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '28', '29', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
const MOLARS = new Set(['1', '2', '3', '14', '15', '16', '17', '18', '19', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
const CANINES = new Set(['6', '11', '22', '27', 'C', 'H', 'M', 'R']);

// A supernumerary tooth is drawn like the tooth it sits beside (51 ↔ 1, AS ↔ A).
export const baseTooth = (t) => {
  const s = String(t).toUpperCase();
  if (/^[A-T]S$/.test(s)) return s[0];
  const n = Number(s);
  return n >= 51 && n <= 82 ? String(n - 50) : s;
};
export const isPosterior = (t) => POSTERIOR.has(baseTooth(t));
export const isMolar = (t) => MOLARS.has(baseTooth(t));
export const isPrimary = (t) => /^[A-T]$/.test(baseTooth(t));
export const isUpper = (t) => {
  const b = baseTooth(t);
  return /^[A-J]$/.test(b) || (Number(b) >= 1 && Number(b) <= 16);
};
// molar · premolar · canine · central · lateral (incisors); lower incisors are all narrow "lateral".
export function toothClass(t) {
  const b = baseTooth(t);
  if (MOLARS.has(b)) return 'molar';
  if (POSTERIOR.has(b)) return 'premolar';
  if (CANINES.has(b)) return 'canine';
  if (['8', '9', 'E', 'F'].includes(b)) return 'central';
  return 'lateral';
}
// Mesial faces the midline: on the drawing's right for the patient's right side.
export function mesialOnRight(t) {
  const b = baseTooth(t);
  const n = Number(b);
  return /^[A-E]$|^[P-T]$/.test(b) || (n >= 1 && n <= 8) || (n >= 25 && n <= 32);
}
// The five surfaces as this tooth names them: posterior teeth have B and O, anterior F and I.
export const surfacesFor = (t) => (t && !isPosterior(t) ? ['M', 'I', 'D', 'F', 'L'] : ['M', 'O', 'D', 'B', 'L']);
export const QUADRANT_LABELS = { UR: 'Upper right', UL: 'Upper left', LL: 'Lower left', LR: 'Lower right', U: 'Upper arch', L: 'Lower arch' };
