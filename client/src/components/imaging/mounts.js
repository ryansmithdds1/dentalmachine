// Mount layouts: rows of labelled spots. The server only knows how many spots each template has; the
// labels decide the shape of each spot (anterior periapicals and vertical bitewings stand upright,
// posterior periapicals and bitewings lie flat) and let the same spot be compared across visits.
const U7 = ['UR molar', 'UR premolar', 'UR canine', 'Upper incisors', 'UL canine', 'UL premolar', 'UL molar'];
const L7 = ['LR molar', 'LR premolar', 'LR canine', 'Lower incisors', 'LL canine', 'LL premolar', 'LL molar'];
const BW4 = ['R molar BW', 'R premolar BW', 'L premolar BW', 'L molar BW'];

export const MOUNTS = {
  fmx18: { label: 'FMX (18)', rows: [U7, BW4, L7] },
  fmx20: { label: 'FMX (20)', rows: [['UR molar', ...U7.slice(0, 3), 'Upper incisors R', 'Upper incisors L', ...U7.slice(4)], BW4, ['LR molar', ...L7.slice(0, 3), 'Lower incisors R', 'Lower incisors L', ...L7.slice(4)]] },
  fmx14: { label: 'PA series (14)', rows: [U7, L7] },
  bw4: { label: '4 bitewings', rows: [BW4] },
  bw2: { label: '2 bitewings', rows: [['R molar BW', 'L molar BW']] },
  vbw7: { label: '7 vertical bitewings', rows: [['R molar VBW', 'R premolar VBW', 'R canine VBW', 'Anterior VBW', 'L canine VBW', 'L premolar VBW', 'L molar VBW']] },
  pa1: { label: 'Single periapical', rows: [['PA']] },
  pa2: { label: '2 periapicals', rows: [['PA 1', 'PA 2']] },
  pa4: { label: '4 periapicals', rows: [['PA 1', 'PA 2', 'PA 3', 'PA 4']] },
  pano1: { label: 'Panoramic', rows: [['Panoramic']] },
  photos8: { label: 'Photo series (8)', rows: [['Full face', 'Smile', 'Profile', 'Retracted front'], ['Right buccal', 'Left buccal', 'Upper occlusal', 'Lower occlusal']] },
};

export const slotLabels = (template) => (MOUNTS[template]?.rows || []).flat();

// Width ÷ height of a spot.
export function slotAspect(label, template) {
  if (template === 'pano1') return 2.1;
  if (template === 'photos8') return 4 / 3;
  if (/incisor|canine|anterior|VBW|^PA/i.test(label)) return 0.75;
  return 4 / 3;
}

// The same spot on earlier and later mounts ("UR molar" in last year's FMX and today's), newest first.
export function sameSpot(mounts, label, exceptMountId) {
  const out = [];
  for (const m of mounts || []) {
    if (m.id === exceptMountId) continue;
    const i = slotLabels(m.template).indexOf(label);
    if (i >= 0 && m.slots[i] != null) out.push({ mount: m, slot: i, docId: m.slots[i] });
  }
  return out;
}
