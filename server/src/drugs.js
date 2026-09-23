// Allergy screening at the moment of prescribing: the drug itself, and drug classes with known
// cross-sensitivity. A match is a warning the prescriber must acknowledge, not a hard stop.
const CLASSES = [
  { name: 'opioid', members: ['codeine', 'hydrocodone', 'oxycodone', 'morphine', 'hydromorphone', 'tramadol', 'tapentadol', 'fentanyl', 'meperidine', 'oxymorphone', 'opioid', 'opiate', 'vicodin', 'norco', 'percocet', 'tylenol #3', 'tylenol with codeine'] },
  { name: 'penicillin', members: ['penicillin', 'amoxicillin', 'ampicillin', 'augmentin', 'amoxicillin/clavulanate', 'dicloxacillin', 'pen vk', 'penicillin vk'] },
  { name: 'cephalosporin', members: ['cephalexin', 'keflex', 'cefadroxil', 'cefuroxime', 'cefdinir', 'cephalosporin'], related: ['penicillin'] },
  { name: 'NSAID', members: ['ibuprofen', 'naproxen', 'aspirin', 'ketorolac', 'diclofenac', 'meloxicam', 'celecoxib', 'etodolac', 'nsaid', 'advil', 'motrin', 'aleve'] },
  { name: 'sulfonamide', members: ['sulfa', 'sulfamethoxazole', 'bactrim', 'sulfonamide'] },
  { name: 'macrolide', members: ['azithromycin', 'erythromycin', 'clarithromycin', 'macrolide', 'z-pak'] },
  { name: 'lincosamide', members: ['clindamycin', 'lincomycin'] },
  { name: 'tetracycline', members: ['doxycycline', 'minocycline', 'tetracycline'] },
  { name: 'fluoroquinolone', members: ['ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'fluoroquinolone'] },
  { name: 'benzodiazepine', members: ['diazepam', 'triazolam', 'lorazepam', 'alprazolam', 'midazolam', 'benzodiazepine', 'valium', 'halcion'] },
  { name: 'chlorhexidine', members: ['chlorhexidine', 'peridex'] },
  { name: 'metronidazole', members: ['metronidazole', 'flagyl'] },
  { name: 'acetaminophen', members: ['acetaminophen', 'paracetamol', 'tylenol'] },
];

const words = (s) => String(s || '').toLowerCase();
const classesOf = (text) => CLASSES.filter((c) => c.members.some((m) => text.includes(m)));

// Returns a warning message, or null when nothing in the allergy list relates to the drug.
export function allergyWarning(allergies, drug) {
  const a = words(allergies);
  const d = words(drug);
  if (!a.trim() || !d.trim() || /^(nkda|none|no known)/.test(a.trim())) return null;
  // Same drug named in the allergy list.
  const direct = a.split(/[,;/\n]+/).map((x) => x.trim()).find((x) => x.length > 3 && d.includes(x));
  if (direct) return `Allergy warning: patient is allergic to ${direct}`;
  const allergic = classesOf(a);
  for (const c of classesOf(d)) {
    if (allergic.some((x) => x.name === c.name)) return `Allergy warning: ${drug} is an ${c.name}, and the patient reports an ${c.name} allergy (${allergies})`;
    const rel = allergic.find((x) => c.related?.includes(x.name));
    if (rel) return `Allergy caution: ${drug} is a ${c.name}; patients with a ${rel.name} allergy can cross-react (${allergies})`;
  }
  return null;
}
