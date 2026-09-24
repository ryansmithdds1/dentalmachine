// A small, friendly picture of the mouth with the teeth in the plan highlighted — for the patient, not for charting
// (that's the Odontogram). Universal numbering: upper 1–16 from the patient's right, lower 17–32 back along.
const WIDTH = { molar: 20, premolar: 16, canine: 14, incisor: 13 };
const kindOf = (n) => {
  const i = n <= 16 ? n : 33 - n; // position 1..16 along the arch
  if (i <= 3 || i >= 14) return 'molar';
  if (i <= 5 || i >= 12) return 'premolar';
  if (i === 6 || i === 11) return 'canine';
  return 'incisor';
};
const GAP = 3;
const layout = (() => {
  const row = (nums) => {
    let x = 0;
    return nums.map((n) => {
      const w = WIDTH[kindOf(n)];
      const at = { n, x, w };
      x += w + GAP;
      return at;
    });
  };
  const upper = row(Array.from({ length: 16 }, (_, i) => i + 1));
  const lower = row(Array.from({ length: 16 }, (_, i) => 32 - i));
  const span = upper.at(-1).x + upper.at(-1).w;
  return { upper, lower, span };
})();

export default function ToothMap({ teeth = [], size = 320, label = 'Teeth in your plan' }) {
  const on = new Set(teeth.map((t) => String(t).toUpperCase()));
  const { upper, lower, span } = layout;
  // The arches curve gently: teeth at the back sit lower (upper) or higher (lower).
  const curve = (x, w) => {
    const c = (x + w / 2 - span / 2) / (span / 2);
    return c * c * 14;
  };
  const tooth = ({ n, x, w }, top) => {
    const hit = on.has(String(n));
    const y = top ? 8 + curve(x, w) : 64 - curve(x, w);
    return (
      <g key={n}>
        <rect x={x} y={y} width={w} height={26} rx={w / 2.6} className={hit ? 'tm-tooth on' : 'tm-tooth'} />
        {hit && <text x={x + w / 2} y={top ? y - 3 : y + 36} className="tm-num" textAnchor="middle">{n}</text>}
      </g>
    );
  };
  return (
    <svg className="tooth-map" viewBox={`-4 -8 ${span + 8} 112`} width={size} role="img" aria-label={`${label}: ${[...on].join(', ') || 'none'}`}>
      {upper.map((t) => tooth(t, true))}
      {lower.map((t) => tooth(t, false))}
    </svg>
  );
}
