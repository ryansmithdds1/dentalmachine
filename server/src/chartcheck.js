import { sentences } from './chartaudit.js';
import { DENTAL_TERMS } from './routes/charting.js';

// "Check my chart" (CA4) extras on top of the chart-audit checks: a dental-aware spell check, simple grammar
// catches (the AI proofreads too when it's on), template questions left unanswered and a note not linked to
// its visit. Each item comes with a one-click fix the screen applies through the normal endpoints (only on an
// unsigned note; a signed one gets an addendum), never here.

// Words a dental note uses that a general spell checker doesn't know, plus the office's own code descriptions
// and template answers (added per practice). Spelling is only suggested near these words, so ordinary English
// (which isn't in this list) is never flagged — the check looks for misspelled dental words, not every word.
const DENTAL_WORDS = `anesthetic anesthesia anaesthetic local topical lidocaine xylocaine articaine septocaine mepivacaine carbocaine prilocaine citanest
bupivacaine marcaine epinephrine epi carpule carpules cartridge cartridges infiltration infiltrated block inferior alveolar nerve mental buccal lingual palatal
nasopalatine greater palatine mesial distal occlusal facial incisal labial gingival cervical interproximal proximal cusp cusps fissure pit
caries carious decay recurrent restoration restorations restored composite amalgam resin glass ionomer sealant sealants fluoride varnish prophylaxis prophy
scaling planing debridement calculus plaque gingivitis periodontitis periodontal perio probing pocket pockets recession furcation mobility bleeding suppuration
attachment radiograph radiographs radiographic bitewing bitewings periapical panoramic cephalometric occlusal radiolucency radiolucent radiopaque
endodontic endodontics pulpotomy pulpectomy pulpitis irreversible reversible necrotic periapical abscess apical periodontitis obturation obturated gutta percha
sealer canal canals apex apices instrumentation irrigation hypochlorite chlorhexidine peridex crown crowns zirconia porcelain ceramic lithium disilicate
emax buildup core post preparation prepared impression impressions provisional temporary cemented cement cementation seated occlusion occlusal articulating
extraction extracted extractions elevated elevator forceps luxated luxation socket sockets curettage curetted irrigated hemostasis gelfoam collagen
sutures suture sutured chromic resorbable implant implants abutment fixture osteotomy torque healing bridge pontic retainer denture dentures partial reline
orthodontic brackets aligners retainer bruxism clenching attrition abrasion abfraction erosion sensitivity hypersensitivity desensitizer
rubber dam isolite isolation etch etched bond bonded bonding primer adhesive liner vitrebond calcium hydroxide flowable matrix wedge polish polished contoured
amoxicillin clindamycin azithromycin cephalexin metronidazole penicillin ibuprofen acetaminophen hydrocodone oxycodone naproxen
hypertension diabetes anticoagulant warfarin aspirin bisphosphonate premedication prophylactic allergy allergies medications
tolerated uneventful postoperative instructions consent consented informed refusal declined recommended prognosis diagnosis
mandibular maxillary quadrant arch molar molars premolar premolars bicuspid canine incisor incisors tongue mucosa vestibule frenum palate oropharynx
lymphadenopathy asymptomatic symptomatic percussion palpation vitality thermal cold electric pulp tester`.split(/\s+/).filter(Boolean);

// Misspellings seen in dental notes, straight to the right word.
export const MISSPELLINGS = {
  anesthestic: 'anesthetic', anestetic: 'anesthetic', anasthetic: 'anesthetic', anaesthestic: 'anesthetic', anestheic: 'anesthetic',
  lidocane: 'lidocaine', lidocain: 'lidocaine', articane: 'articaine', articain: 'articaine', septocane: 'septocaine', carbocain: 'carbocaine', mepivicaine: 'mepivacaine',
  carpels: 'carpules', carpuls: 'carpules', carpule: 'carpule', capules: 'carpules', cartriges: 'cartridges',
  occlussal: 'occlusal', oclusal: 'occlusal', ocllusal: 'occlusal', mesail: 'mesial', meisal: 'mesial', distral: 'distal', bucal: 'buccal', buccel: 'buccal', lingal: 'lingual', lingul: 'lingual',
  carries: 'caries', cavaties: 'cavities', restortion: 'restoration', restoraton: 'restoration', compsite: 'composite', composit: 'composite', amalgum: 'amalgam',
  prophalaxis: 'prophylaxis', prophylaxsis: 'prophylaxis', gingivitus: 'gingivitis', periodontitus: 'periodontitis', periodental: 'periodontal', perodontal: 'periodontal',
  radiograh: 'radiograph', radiogragh: 'radiograph', radiographes: 'radiographs', bitewhings: 'bitewings', periapicle: 'periapical', panoramix: 'panoramic',
  endodontc: 'endodontic', pulpotomey: 'pulpotomy', obturaton: 'obturation', gutta: 'gutta', hemostatis: 'hemostasis', heamostasis: 'hemostasis', suturs: 'sutures',
  extration: 'extraction', extracion: 'extraction', implnat: 'implant', abutmant: 'abutment', ponic: 'pontic', dentur: 'denture',
  amoxicilin: 'amoxicillin', amoxocillin: 'amoxicillin', clindamyacin: 'clindamycin', ibuprofin: 'ibuprofen', ibuprophen: 'ibuprofen', acetominophen: 'acetaminophen',
  perscription: 'prescription', prescripton: 'prescription', recieved: 'received', recieve: 'receive', pateint: 'patient', paitent: 'patient', patinet: 'patient',
  tolerate: 'tolerate', toleratd: 'tolerated', instuctions: 'instructions', instrutions: 'instructions', consnet: 'consent', concent: 'consent', refusel: 'refusal',
  hypertention: 'hypertension', diabetis: 'diabetes', allergys: 'allergies', medicaton: 'medication', medicatons: 'medications', sensitvity: 'sensitivity',
};

// Ordinary words that sit one letter away from a dental word; never "corrected".
const COMMON = new Set(`dental rental mental facial racial crown brown crowd clown bridge fridge filling falling feeling killing selling telling calling
caring carries carried cares cards cares canal canals candle cement moment comment liner linear line lines linen polish police posh
dentures ventures bond band bend bone bones tone tones zone zones core care cure pure more wore sore score post past most cost host
seal sell sale sail tell tall teeth tooth truth root roots boot boat route rate late plate place placed plane plan planned planed
molar solar polar local vocal focal decay delay relay display cap cup map mat gum gun sum arch march larch torch porch touch
prep prop drop crop wedge hedge ledge edge sedge dam damn day dry etch itch each fetch bite site kite white write wine line pain paint gain
numb number thumb crumb shade shake share shape made grade trade graded traded fluid flush sealer dealer healer healing dealing feeling
buccal lingual`.split(/\s+/));

const levenshtein = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};

export function dictionaryFor(extra = []) {
  const words = new Set(DENTAL_WORDS);
  for (const t of [...DENTAL_TERMS, ...extra]) for (const w of String(t).toLowerCase().split(/[^a-z]+/)) if (w.length >= 3) words.add(w);
  return words;
}

// Possible misspellings: [{ word, suggestion, quote }]. The same word is reported once.
export function spellCheck(text, dictionary = dictionaryFor()) {
  const out = [];
  const seen = new Set();
  const list = [...dictionary];
  for (const m of String(text || '').matchAll(/[A-Za-z][a-z]{3,}/g)) {
    const raw = m[0];
    const w = raw.toLowerCase();
    if (seen.has(w) || dictionary.has(w) || COMMON.has(w)) continue;
    let suggestion = MISSPELLINGS[w] && MISSPELLINGS[w] !== w ? MISSPELLINGS[w] : null;
    if (!suggestion && w.length >= 6) {
      const max = w.length >= 9 ? 2 : 1;
      const near = list.filter((d) => d.length >= 6 && d[0] === w[0] && levenshtein(w, d) <= max).sort((a, b) => levenshtein(w, a) - levenshtein(w, b));
      suggestion = near[0] || null;
    }
    if (!suggestion) continue;
    seen.add(w);
    const fixed = raw[0] === raw[0].toUpperCase() ? suggestion[0].toUpperCase() + suggestion.slice(1) : suggestion;
    out.push({ word: raw, suggestion: fixed, quote: sentences(text).find((s) => s.includes(raw)) || raw });
  }
  return out;
}

// Grammar the rules can catch without the AI: a word written twice ("the the").
export function grammarCheck(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    if (/^(that|had|very|no)$/i.test(m[1])) continue;
    out.push({ quote: m[0], suggestion: m[1], why: `“${m[1]}” is written twice` });
  }
  return out;
}

// Template questions still in the note: [[Label: a|b|c]].
export const templateQuestions = (text) => [...String(text || '').matchAll(/\[\[([^:\]]+):\s*([^\]]*)\]\]/g)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()).filter(Boolean) }));

// The "Check my chart" extras for one visit's context (from chartaudit.visitContext).
export async function chartCheckExtras(ctx, { dictionary, comparer = null } = {}) {
  const items = [];
  const note = ctx.notes.find((n) => !n.signed) || ctx.notes[0] || null;
  if (!note) return items;
  const editable = !note.signed;
  const body = note.body;
  for (const s of spellCheck(body, dictionary)) {
    items.push({ check: 'spelling', subject: `spell:${s.word.toLowerCase()}`, title: `“${s.word}” — did you mean “${s.suggestion}”?`, detail: null, evidence: s.quote, source: 'rule', severity: 'low',
      fix: editable ? { type: 'replace_text', note_id: note.id, find: s.word, replace: s.suggestion } : { type: 'addendum', note_id: note.id } });
  }
  const grammar = grammarCheck(body);
  if (comparer?.proofread) {
    try {
      const ai = await comparer.proofread({ text: body });
      for (const g of ai.issues || []) if (g.quote && body.includes(g.quote) && !grammar.some((x) => x.quote === g.quote)) grammar.push({ ...g, source: 'ai' });
    } catch { /* the AI proofread is optional; the rules above still ran */ }
  }
  for (const g of grammar) {
    items.push({ check: 'grammar', subject: `grammar:${g.quote.toLowerCase()}`.slice(0, 120), title: `“${g.quote}” → “${g.suggestion}”`, detail: g.why || null, evidence: g.quote, source: g.source === 'ai' ? 'ai' : 'rule', severity: 'low',
      fix: editable ? { type: 'replace_text', note_id: note.id, find: g.quote, replace: g.suggestion } : { type: 'addendum', note_id: note.id } });
  }
  for (const q of templateQuestions(body)) {
    items.push({ check: 'template_field', subject: `field:${q.label.toLowerCase()}`, title: `“${q.label}” isn’t answered`, detail: q.options.length ? `Choose: ${q.options.join(' · ')}` : 'Fill it in.', evidence: q.token, source: 'rule', severity: 'medium',
      fix: editable ? { type: 'choose', note_id: note.id, find: q.token, options: q.options, label: q.label } : { type: 'addendum', note_id: note.id } });
  }
  if (ctx.appointment_id && !note.appointment_id) {
    items.push({ check: 'note_not_linked', subject: `link:${note.id}`, title: 'The note isn’t linked to this visit', detail: null, evidence: null, source: 'rule', severity: 'low',
      fix: editable ? { type: 'link_note', note_id: note.id, appointment_id: ctx.appointment_id } : null });
  }
  return items;
}
