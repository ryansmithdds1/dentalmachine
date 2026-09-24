// Caries risk (CAMBRA, for patients 6 and up) and periodontal risk, each with what it means for the
// patient's care: how often to see them, how often to take bitewings, and what to recommend.
// Answers are booleans (or numbers where noted); anything the chart can tell is filled in for the clinician.

export const CARIES_QUESTIONS = {
  disease: {
    cavities: 'Visible cavities or radiographic lesions into dentin',
    enamel_lesions: 'Radiographic lesions in enamel only',
    white_spots: 'Active white spot lesions on smooth surfaces',
    recent_restorations: 'Restorations placed in the last 3 years',
  },
  factors: {
    heavy_plaque: 'Visible heavy plaque',
    snacking: 'Frequent snacks or sugary drinks (more than 3 a day between meals)',
    deep_pits: 'Deep pits and fissures',
    drugs: 'Recreational drug use',
    low_saliva: 'Inadequate saliva flow (observed or measured)',
    saliva_meds: 'Saliva-reducing factors (medications, radiation, systemic)',
    exposed_roots: 'Exposed roots',
    appliances: 'Orthodontic appliances',
  },
  protective: {
    fluoride_water: 'Lives in a fluoridated community',
    fluoride_paste: 'Fluoride toothpaste at least twice a day',
    fluoride_rinse: 'Fluoride mouth rinse daily',
    rx_paste: '5,000 ppm fluoride toothpaste',
    varnish: 'Fluoride varnish in the last 6 months',
    chlorhexidine: 'Chlorhexidine rinse in the last 6 months',
    xylitol: 'Xylitol gum or mints 4 times a day',
    calcium_phosphate: 'Calcium phosphate paste in the last 6 months',
    good_saliva: 'Adequate saliva flow',
  },
};

export const PERIO_QUESTIONS = {
  bop_pct: 'Bleeding on probing (% of sites)',
  sites_5mm: 'Sites 5 mm or deeper',
  teeth_lost: 'Teeth lost to periodontal disease',
  bone_loss_age: 'Bone loss ÷ age (worst site: % bone loss divided by age)',
  smoker: 'Cigarettes a day (0 if none)',
  diabetes: 'Diabetes (HbA1c, 0 if none)',
  family_history: 'Family history of early tooth loss from gum disease',
};

const count = (a, keys) => keys.filter((k) => a[k]).length;

export function cariesRisk(a) {
  const disease = count(a, Object.keys(CARIES_QUESTIONS.disease));
  const factors = count(a, Object.keys(CARIES_QUESTIONS.factors));
  const protective = count(a, Object.keys(CARIES_QUESTIONS.protective));
  const hyposalivation = !!a.low_saliva && !!a.saliva_meds;
  let level = 'low';
  if (disease > 0 || factors - protective >= 3) level = 'high';
  else if (factors > protective) level = 'moderate';
  if (level === 'high' && hyposalivation) level = 'extreme';
  const plan = {
    low: { recall_months: 6, bitewings: 'every 24–36 months', recommend: ['Fluoride toothpaste twice a day'] },
    moderate: { recall_months: 6, bitewings: 'every 18–24 months', recommend: ['Fluoride varnish at each recall', 'Fluoride toothpaste twice a day', 'Xylitol gum or mints'] },
    high: { recall_months: 4, bitewings: 'every 6–18 months', recommend: ['Fluoride varnish every 3–4 months', '5,000 ppm fluoride toothpaste', 'Xylitol 4 times a day', 'Sealants on deep pits and fissures', 'Diet counseling'] },
    extreme: { recall_months: 3, bitewings: 'every 6 months', recommend: ['Fluoride varnish every 3 months', '5,000 ppm fluoride toothpaste', 'Chlorhexidine rinse (one week a month)', 'Calcium phosphate paste', 'Saliva substitutes; review medications with their physician', 'Xylitol 4 times a day'] },
  }[level];
  return { level, score: { disease, factors, protective }, ...plan };
}

export function perioRisk(a) {
  const n = (k) => Number(a[k]) || 0;
  // Each factor graded 0 (low) to 2 (high), after the periodontal risk assessment (Lang & Tonetti).
  const grades = {
    bop: n('bop_pct') > 25 ? 2 : n('bop_pct') >= 10 ? 1 : 0,
    pockets: n('sites_5mm') > 8 ? 2 : n('sites_5mm') >= 5 ? 1 : 0,
    tooth_loss: n('teeth_lost') > 8 ? 2 : n('teeth_lost') >= 5 ? 1 : 0,
    bone: n('bone_loss_age') > 1 ? 2 : n('bone_loss_age') >= 0.5 ? 1 : 0,
    smoking: n('smoker') >= 10 ? 2 : n('smoker') > 0 ? 1 : 0,
    diabetes: n('diabetes') >= 7 ? 2 : n('diabetes') > 0 ? 1 : 0,
  };
  const high = Object.values(grades).filter((g) => g === 2).length;
  const moderate = Object.values(grades).filter((g) => g >= 1).length;
  const level = high >= 2 ? 'high' : moderate >= 2 || (a.family_history && moderate >= 1) ? 'moderate' : 'low';
  const recommend = [];
  if (n('sites_5mm') >= 4 && n('bop_pct') >= 10) recommend.push('Scaling and root planing where pockets are 5 mm or deeper (D4341/D4342)');
  if (grades.smoking) recommend.push('Smoking cessation');
  if (grades.diabetes === 2) recommend.push('Coordinate with their physician on diabetes control');
  if (level !== 'low') recommend.push(level === 'high' ? 'Periodontal maintenance every 3 months (D4910)' : 'Recall every 4 months');
  return { level, grades, recall_months: { low: 6, moderate: 4, high: 3 }[level], recommend };
}

// What the chart already knows, to start the questionnaire from.
export async function chartAnswers(db, patientId, today) {
  const three = new Date(Date.parse(today) - 3 * 365 * 86400_000).toISOString().slice(0, 10);
  const recent = (await db.get("SELECT COUNT(*) AS n FROM procedures WHERE patient_id = ? AND status = 'completed' AND (code LIKE 'D21%' OR code LIKE 'D23%' OR code LIKE 'D24%' OR code LIKE 'D27%') AND completed_at >= ?", patientId, three)).n;
  const conditions = (await db.all('SELECT condition FROM tooth_conditions WHERE patient_id = ? AND resolved = 0 AND voided_at IS NULL', patientId)).map((c) => c.condition);
  const ortho = await db.get("SELECT id FROM procedures WHERE patient_id = ? AND code LIKE 'D8%' AND status = 'completed' AND completed_at >= ? LIMIT 1", patientId, new Date(Date.parse(today) - 2 * 365 * 86400_000).toISOString().slice(0, 10));
  const caries = { cavities: conditions.includes('caries'), recent_restorations: recent > 0, appliances: !!ortho };
  const perio = {};
  const exam = await db.get('SELECT exam_date, readings FROM perio_exams WHERE patient_id = ? AND deleted_at IS NULL ORDER BY exam_date DESC LIMIT 1', patientId);
  if (exam) {
    const r = JSON.parse(exam.readings || '{}');
    const sites = Object.values(r).flatMap((t) => (t.pd || []).filter((v) => v != null));
    const bleed = Object.values(r).flatMap((t) => (t.bop || []).filter(Boolean)).length;
    perio.bop_pct = sites.length ? Math.round((100 * bleed) / sites.length) : 0;
    perio.sites_5mm = sites.filter((v) => v >= 5).length;
    perio.exam_date = exam.exam_date;
  }
  perio.teeth_lost = conditions.filter((c) => c === 'missing').length;
  return { caries, perio };
}
