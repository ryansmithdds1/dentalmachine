// The ADA Dental Claim Form (2024 version) as numbered boxes, for printing a paper claim when a payer
// won't take it electronically. Pure: the caller gathers the rows.
const AREA = { U: '01', L: '02', UR: '10', UL: '20', LL: '30', LR: '40', FM: '00' };
const REL = { self: 'self', spouse: 'spouse', child: 'dependent child', dependent: 'dependent child', other: 'other' };
const GENDER = (g) => ({ female: 'F', male: 'M' })[String(g || '').toLowerCase()] || 'U';
const addr = (o) => [o?.address, [o?.city, o?.state].filter(Boolean).join(', '), o?.zip].filter(Boolean).join(' ').replace(/ (\d{5})/, ' $1');

export const ADA_LINES_PER_PAGE = 10;

export function adaForm({ claim, policy, carrier, patient, items, practice, other, subscriber, treating, missing = [], attachments = [], printedOn }) {
  const self = policy.relationship === 'self';
  const sub = self ? patient : subscriber || null;
  const lines = items.map((i) => ({
    date: String(i.completed_at || '').slice(0, 10),
    area: AREA[i.area] || '',
    tooth_system: i.tooth ? 'JP' : '',
    tooth: i.tooth || '',
    surfaces: i.surfaces || '',
    code: i.code,
    diag_pointer: '',
    quantity: 1,
    description: String(i.description || '').slice(0, 48),
    fee: i.fee,
  }));
  const missingTeeth = [...new Set(missing.map(String))].filter((t) => /^([1-9]|[12]\d|3[0-2]|[A-T])$/.test(t));
  return {
    // Header
    box1: { statement: true, preauth: false, epsdt: false },
    box2: claim.preauth_number || '',
    box3: { name: carrier.name, address: carrier.address || '' },
    // Other coverage (4–11)
    box4: { dental: !!other, medical: false },
    box5: other ? other.subscriber_name || '' : '',
    box6: other?.subscriber_dob || '',
    box7: other ? (other.relationship === 'self' ? GENDER(patient.gender) : 'U') : '',
    box8: other?.subscriber_id || '',
    box9: other?.group_number || '',
    box10: other ? REL[other.relationship] || 'other' : '',
    box11: other ? { name: other.carrier_name, address: other.carrier_address || '' } : null,
    // Subscriber (12–17)
    box12: { name: policy.subscriber_name, address: sub ? addr(sub) : '' },
    box13: self ? patient.dob || '' : policy.subscriber_dob || '',
    box14: self ? GENDER(patient.gender) : sub ? GENDER(sub.gender) : 'U',
    box15: policy.subscriber_id || '',
    box16: policy.group_number || '',
    box17: policy.plan_name || '',
    // Patient (18–23)
    box18: REL[policy.relationship] || 'other',
    box19: '',
    box20: { name: `${patient.last_name}, ${patient.first_name}`, address: addr(patient) },
    box21: patient.dob || '',
    box22: GENDER(patient.gender),
    box23: String(patient.id),
    // Services (24–32), 10 to a page
    lines,
    box31a: 0,
    box32: lines.reduce((t, l) => t + (l.fee || 0), 0),
    box33: missingTeeth,
    box34: 'AB',
    box34a: [],
    box35: [claim.remarks, claim.original_reference ? `Replaces payer claim # ${claim.original_reference}` : null].filter(Boolean).join(' · '),
    // Authorizations
    box36: 'Signature on file',
    box37: 'Signature on file',
    // Ancillary (38–47)
    box38: '11',
    box39: attachments.length,
    box40: false,
    box43: false,
    // Billing dentist (48–52a)
    box48: { name: practice.name, address: addr(practice) },
    box49: practice.npi || '',
    box50: '',
    box51: practice.tax_id || '',
    box52: practice.phone || '',
    box52a: '',
    // Treating dentist (53–58)
    box53: { name: treating?.name || '', date: printedOn },
    box54: treating?.npi || '',
    box55: treating?.license_number || '',
    box56: addr(practice),
    box56a: practice.billing_provider_taxonomy || '1223G0001X',
    box57: practice.phone || '',
    box58: '',
    claim_id: claim.id,
    control_number: claim.control_number || null,
    pages: Math.max(1, Math.ceil(lines.length / ADA_LINES_PER_PAGE)),
  };
}
