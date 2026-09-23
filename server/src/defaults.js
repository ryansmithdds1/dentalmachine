import { insert, mapSeq } from './util.js';

// Starter fee schedule. Practices should review codes/fees against their current CDT licence and local UCR.
// [code, description, category, fee (cents), requires_tooth, requires_surface]
export const DEFAULT_CODES = [
  ['D0120', 'Periodic oral evaluation', 'diagnostic', 6500, 0, 0],
  ['D0140', 'Limited oral evaluation, problem focused', 'diagnostic', 8500, 0, 0],
  ['D0150', 'Comprehensive oral evaluation', 'diagnostic', 11000, 0, 0],
  ['D0180', 'Comprehensive periodontal evaluation', 'diagnostic', 12000, 0, 0],
  ['D0210', 'Intraoral complete series of images', 'diagnostic', 15000, 0, 0],
  ['D0220', 'Intraoral periapical, first image', 'diagnostic', 3500, 1, 0],
  ['D0274', 'Bitewings, four images', 'diagnostic', 7000, 0, 0],
  ['D0330', 'Panoramic image', 'diagnostic', 12000, 0, 0],
  ['D1110', 'Prophylaxis, adult', 'preventive', 11000, 0, 0],
  ['D1120', 'Prophylaxis, child', 'preventive', 8000, 0, 0],
  ['D1206', 'Topical fluoride varnish', 'preventive', 4500, 0, 0],
  ['D1351', 'Sealant, per tooth', 'preventive', 5500, 1, 0],
  ['D2140', 'Amalgam, one surface, primary or permanent', 'restorative', 15000, 1, 1],
  ['D2150', 'Amalgam, two surfaces, primary or permanent', 'restorative', 19000, 1, 1],
  ['D2330', 'Resin-based composite, one surface, anterior', 'restorative', 16500, 1, 1],
  ['D2331', 'Resin-based composite, two surfaces, anterior', 'restorative', 20000, 1, 1],
  ['D2391', 'Resin-based composite, one surface, posterior', 'restorative', 18500, 1, 1],
  ['D2392', 'Resin-based composite, two surfaces, posterior', 'restorative', 23500, 1, 1],
  ['D2393', 'Resin-based composite, three surfaces, posterior', 'restorative', 28500, 1, 1],
  ['D2740', 'Crown, porcelain/ceramic', 'prosthodontics', 135000, 1, 0],
  ['D2750', 'Crown, porcelain fused to high noble metal', 'prosthodontics', 125000, 1, 0],
  ['D2950', 'Core buildup, including any pins', 'restorative', 30000, 1, 0],
  ['D2954', 'Prefabricated post and core', 'restorative', 35000, 1, 0],
  ['D3220', 'Therapeutic pulpotomy', 'endodontics', 22000, 1, 0],
  ['D3310', 'Endodontic therapy, anterior tooth', 'endodontics', 85000, 1, 0],
  ['D3320', 'Endodontic therapy, premolar tooth', 'endodontics', 100000, 1, 0],
  ['D3330', 'Endodontic therapy, molar tooth', 'endodontics', 125000, 1, 0],
  ['D4341', 'Periodontal scaling and root planing, 4+ teeth per quadrant', 'periodontics', 26000, 0, 0],
  ['D4342', 'Periodontal scaling and root planing, 1-3 teeth per quadrant', 'periodontics', 18000, 0, 0],
  ['D4910', 'Periodontal maintenance', 'periodontics', 15500, 0, 0],
  ['D5110', 'Complete denture, maxillary', 'prosthodontics', 185000, 0, 0],
  ['D5120', 'Complete denture, mandibular', 'prosthodontics', 185000, 0, 0],
  ['D6010', 'Surgical placement of implant body, endosteal', 'implants', 220000, 1, 0],
  ['D6065', 'Implant supported porcelain/ceramic crown', 'implants', 160000, 1, 0],
  ['D7140', 'Extraction, erupted tooth or exposed root', 'oral_surgery', 20000, 1, 0],
  ['D7210', 'Extraction, erupted tooth requiring removal of bone', 'oral_surgery', 32000, 1, 0],
  ['D7240', 'Removal of impacted tooth, completely bony', 'oral_surgery', 50000, 1, 0],
  ['D8080', 'Comprehensive orthodontic treatment, adolescent', 'orthodontics', 600000, 0, 0],
  ['D9110', 'Palliative treatment of dental pain', 'adjunctive', 12000, 0, 0],
  ['D9230', 'Inhalation of nitrous oxide', 'adjunctive', 7500, 0, 0],
  ['D9944', 'Occlusal guard, hard appliance, full arch', 'adjunctive', 55000, 0, 0],
];

// [name, minutes, color, procedure codes, provider type, bookable online]
export const DEFAULT_APPOINTMENT_TYPES = [
  ['New patient exam & cleaning', 90, '#0ea5e9', ['D0150', 'D0210', 'D1110'], 'hygienist', 1],
  ['Recall exam & cleaning', 60, '#10b981', ['D0120', 'D1110', 'D0274'], 'hygienist', 1],
  ['Perio maintenance', 60, '#14b8a6', ['D0120', 'D4910'], 'hygienist', 0],
  ['Filling', 60, '#6366f1', [], 'dentist', 0],
  ['Crown prep', 90, '#a855f7', [], 'dentist', 0],
  ['Crown seat', 30, '#c084fc', [], 'dentist', 0],
  ['Root canal', 90, '#f43f5e', [], 'dentist', 0],
  ['Extraction', 60, '#f97316', [], 'dentist', 0],
  ['Emergency / limited exam', 30, '#ef4444', ['D0140', 'D0220'], 'dentist', 1],
  ['Consultation', 30, '#64748b', [], 'dentist', 1],
];

export async function seedPracticeDefaults(db, practiceId) {
  for (const [code, description, category, fee, rt, rs] of DEFAULT_CODES) {
    await insert(db, 'procedure_codes', {
      practice_id: practiceId, code, description, category, fee, requires_tooth: rt, requires_surface: rs,
    });
  }
  for (const name of ['Op 1', 'Op 2', 'Hygiene 1']) {
    await insert(db, 'operatories', { practice_id: practiceId, name });
  }
  await mapSeq(
    DEFAULT_APPOINTMENT_TYPES,
    async ([name, duration, color, codes, providerType, online], sort) => await insert(db, 'appointment_types', {
      practice_id: practiceId, name, duration, color, procedure_codes: JSON.stringify(codes), provider_type: providerType, online_bookable: online, sort,
    })
  );
}

// Insurance coverage tier for a procedure category.
export function coverageTier(category) {
  if (category === 'diagnostic' || category === 'preventive') return 'preventive';
  if (['prosthodontics', 'implants', 'orthodontics'].includes(category)) return 'major';
  return 'basic';
}
