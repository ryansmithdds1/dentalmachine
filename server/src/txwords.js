import { estimateCoverage, primaryPolicy } from './services.js';

// Treatment follow-up (TF, docs/workflows/specs/TF-treatment-followup.md): what a treatment plan is, in plain
// words for patients — what the work is called, which tooth, how soon it matters (urgency), what the doctor found,
// why it matters and what can happen if it waits (the starting wording of the doctor's letter, which the doctor
// edits), and what it costs the patient (the plan's insurance estimate). No PHI leaves through here on its own:
// callers decide what goes where (texts carry none of it, only a link).

export const URGENCIES = ['urgent', 'soon', 'elective'];
export const URGENCY_LABELS = { urgent: 'Urgent', soon: 'Soon', elective: 'Elective' };
const RANK = { urgent: 0, soon: 1, elective: 2 };

// Kinds of work, matched on the CDT code. `one` is how a message names it; the rest start the doctor's letter.
const MISSING = {
  diagnosis: 'a missing tooth',
  why: 'Replacing the tooth keeps your bite even and stops the teeth around the gap from drifting.',
  risk: 'After a tooth is lost the bone underneath slowly shrinks and the neighbouring teeth tilt into the space, which makes replacing it harder and more costly later.',
};
export const KINDS = [
  {
    key: 'root_canal', match: /^D3[23]/, one: 'a root canal', urgency: 'urgent',
    diagnosis: 'an infection or inflammation in the nerve inside the tooth',
    why: 'An infected nerve does not heal on its own. A root canal clears the infection and lets you keep your own tooth.',
    risk: 'Left untreated, the infection can spread into the bone and cause a painful abscess and swelling, and the tooth may have to come out.',
  },
  {
    key: 'extraction', match: /^D7[12]/, one: 'having a tooth removed', urgency: 'urgent',
    diagnosis: 'a tooth that can’t be saved',
    why: 'Taking it out stops the problem from spreading to the bone and the teeth next to it.',
    risk: 'Waiting can lead to infection, pain and swelling, and damage to the bone and the neighbouring teeth.',
  },
  {
    key: 'crown', match: /^D27|^D295[0-4]|^D2[56]/, one: 'a crown', urgency: 'soon',
    diagnosis: 'a tooth that is cracked or too weak to hold a filling',
    why: 'A crown covers and protects the tooth so it can’t break any further.',
    risk: 'A weak or cracked tooth can break, sometimes below the gum. It may then need a root canal as well, or it may not be possible to save it — which means more treatment and more cost.',
  },
  {
    key: 'filling', match: /^D2[1-4]/, one: 'a filling', urgency: 'soon',
    diagnosis: 'a cavity (tooth decay)',
    why: 'Right now the decay is small enough to fix with a simple filling.',
    risk: 'Decay keeps growing. Once it reaches the nerve the tooth can start to hurt, and it may need a root canal and a crown instead of a filling.',
  },
  {
    key: 'perio', match: /^D42|^D434|^D4355|^D438/, one: 'a deep cleaning (gum treatment)', urgency: 'soon',
    diagnosis: 'gum disease — an infection in the gums and the bone that holds your teeth',
    why: 'A deep cleaning removes the bacteria below the gumline so your gums can heal and tighten.',
    risk: 'Gum disease slowly destroys the bone around the teeth. Teeth can loosen and be lost, and gum disease is linked to diabetes and heart disease.',
  },
  { key: 'implant', match: /^D6[01]/, one: 'an implant', urgency: 'soon', ...MISSING },
  { key: 'bridge', match: /^D6[2-9]/, one: 'a bridge', urgency: 'soon', ...MISSING },
  { key: 'denture', match: /^D5/, one: 'a denture', urgency: 'soon', ...MISSING, diagnosis: 'missing teeth' },
  {
    key: 'ortho', match: /^D8/, one: 'orthodontic treatment (braces or aligners)', urgency: 'elective',
    diagnosis: 'teeth that are crowded or a bite that doesn’t meet evenly',
    why: 'Straighter teeth are easier to keep clean and wear more evenly.',
    risk: 'Crowded teeth are harder to clean, so decay and gum problems are more likely, and uneven wear can get worse over time.',
  },
  {
    key: 'veneer', match: /^D296/, one: 'veneers', urgency: 'elective',
    diagnosis: 'front teeth that are worn, chipped or discoloured',
    why: 'Veneers protect and restore the front surface of the teeth.',
    risk: 'Worn or chipped enamel doesn’t grow back, and the wear can continue.',
  },
  {
    key: 'guard', match: /^D994[4-6]/, one: 'a night guard', urgency: 'elective',
    diagnosis: 'signs that you grind or clench your teeth',
    why: 'A night guard takes the force off your teeth and jaw while you sleep.',
    risk: 'Grinding wears teeth down, can crack them and can make the jaw sore.',
  },
];
const BY_CATEGORY = { endodontics: 'urgent', oral_surgery: 'urgent', restorative: 'soon', prosthodontics: 'soon', periodontics: 'soon', implants: 'soon' };

export function kindOf(proc) {
  const code = String(proc.code || '').toUpperCase();
  const k = KINDS.find((x) => x.match.test(code));
  if (k) return k;
  const words = String(proc.description || 'the treatment').replace(/,.*$/, '').toLowerCase();
  return {
    key: `code:${code}`, one: words, urgency: BY_CATEGORY[proc.category] || 'elective',
    diagnosis: 'a problem that needs treatment', why: 'Treating it now keeps it small and simple.', risk: 'Problems in the mouth usually get bigger, and harder to fix, the longer they wait.',
  };
}

// The most pressing urgency among a plan's procedures.
export const urgencyOf = (procs) => procs.map((p) => kindOf(p).urgency).sort((a, b) => RANK[a] - RANK[b])[0] || 'soon';

// "a root canal and a crown"
export const listWords = (list) => (list.length <= 1 ? list[0] || '' : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// Universal tooth numbers (1–32) and primary teeth (A–T) in words: "lower right back tooth".
export function toothWords(tooth) {
  const t = String(tooth ?? '').toUpperCase();
  if (!t) return '';
  if (/^[A-T]$/.test(t)) {
    const i = t.charCodeAt(0) - 65; // A=0 … T=19
    const upper = i < 10;
    const side = upper ? (i < 5 ? 'right' : 'left') : (i < 15 ? 'left' : 'right');
    const pos = upper ? i : i - 10;
    const front = pos >= 2 && pos <= 7;
    return `${upper ? 'upper' : 'lower'} ${side} ${front ? 'front' : 'back'} baby tooth`;
  }
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 32) return '';
  const upper = n <= 16;
  const side = upper ? (n <= 8 ? 'right' : 'left') : (n <= 24 ? 'left' : 'right');
  const pos = upper ? n : n - 16; // 1–16 along the arch
  const kind = [6, 11].includes(pos) ? 'eye tooth' : pos >= 7 && pos <= 10 ? 'front tooth' : 'back tooth';
  return `${upper ? 'upper' : 'lower'} ${side} ${kind}`;
}

// Everything about a plan that follow-up needs: its unscheduled work, words, urgency and cost (integer cents).
export async function planFacts(db, plan) {
  const all = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND practice_id = ? AND status = 'planned' ORDER BY priority, id", plan.id, plan.practice_id);
  const open = all.filter((p) => !p.appointment_id);
  const est = open.length ? await estimateCoverage(db, await primaryPolicy(db, plan.practice_id, plan.patient_id), open) : null;
  const kinds = [];
  for (const p of open) {
    const k = kindOf(p);
    if (!kinds.some((x) => x.key === k.key)) kinds.push(k);
  }
  kinds.sort((a, b) => RANK[a.urgency] - RANK[b.urgency]);
  const teeth = [...new Set(open.map((p) => p.tooth).filter(Boolean))];
  const derived = urgencyOf(open);
  return {
    procedures: open, all, kinds, teeth, words: listWords(kinds.map((k) => k.one)) || 'the treatment we recommended',
    urgency: URGENCIES.includes(plan.followup_urgency) ? plan.followup_urgency : derived, derived_urgency: derived,
    total: Number(est?.total_fee ?? open.reduce((s, p) => s + Number(p.fee || 0), 0)), insurance: Number(est?.total_insurance ?? 0), cost: Number(est?.total_patient ?? open.reduce((s, p) => s + Number(p.fee || 0), 0)),
  };
}

export const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// How an email or a call names the work and the patient's share: "a crown (your estimated cost: $420.00)".
export function visitWords(facts) {
  if (!facts.procedures.length) return facts.words;
  if (facts.cost > 0) return `${facts.words} (your estimated cost: ${money(facts.cost)})`;
  if (facts.total > 0) return `${facts.words} (your insurance estimate covers it)`;
  return facts.words;
}

// The doctor's letter, first draft: the most pressing kind of work leads.
export function letterWording(facts) {
  const main = facts.kinds[0] || kindOf({ code: '', description: facts.words });
  const where = facts.teeth.length === 1 && toothWords(facts.teeth[0]) ? ` on your ${toothWords(facts.teeth[0])} (#${facts.teeth[0]})` : facts.teeth.length > 1 ? ` (teeth ${facts.teeth.map((t) => `#${t}`).join(', ')})` : '';
  return {
    diagnosis: main.diagnosis,
    why: facts.kinds.map((k) => k.why).filter((v, i, a) => a.indexOf(v) === i).join(' '),
    risk: main.risk,
    treatment: `${facts.words}${where}`,
  };
}

// ---- Is the work still waiting? (the cadence's stop rules, and the check right before a letter goes) ----
const LIVE_VISIT = "('scheduled','confirmed','checked_in','in_chair')";
// A plan's options for the same problem (Option A / Option B): followed up as one.
export async function groupOf(db, plan) {
  if (!plan.option_group) return [plan];
  return db.all("SELECT * FROM treatment_plans WHERE practice_id = ? AND patient_id = ? AND option_group = ? ORDER BY id", plan.practice_id, plan.patient_id, plan.option_group);
}
// The plan of a group that follow-up is about: the accepted one, else the first one still open.
export const leadOf = (group) => group.find((p) => p.status === 'accepted') || group.find((p) => p.status === 'proposed') || group[0];

// null while the work is still waiting, else { reason, appointment_id? }. today: the practice's date.
export async function planStopReason(db, plan, { today, anchor = null } = {}) {
  if (!plan) return { reason: 'plan_gone' };
  const group = await groupOf(db, plan);
  const ids = group.map((p) => p.id);
  const inIds = ids.map(() => '?').join(',');
  // Booked: the plan's work (or an option's) is on a visit, or the patient is coming in to see a dentist.
  const onVisit = await db.get(
    `SELECT a.id FROM procedures pr JOIN appointments a ON a.id = pr.appointment_id
     WHERE pr.treatment_plan_id IN (${inIds}) AND pr.status = 'planned' AND a.status IN ${LIVE_VISIT} ORDER BY a.start_time LIMIT 1`, ...ids,
  );
  if (onVisit) return { reason: 'booked', appointment_id: onVisit.id };
  const doctor = await db.get(
    `SELECT a.id FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.practice_id = ? AND a.patient_id = ? AND a.status IN ${LIVE_VISIT}
       AND a.start_time >= ? AND pv.type IN ('dentist','specialist') ORDER BY a.start_time LIMIT 1`, plan.practice_id, plan.patient_id, `${today} 00:00`,
  );
  if (doctor) return { reason: 'booked', appointment_id: doctor.id };
  if (group.every((p) => p.status === 'rejected')) return { reason: 'declined' };
  if (plan.status === 'rejected') return { reason: 'declined' };
  if (plan.status === 'completed') return { reason: 'treatment_done' };
  // Another option of the same work is the one being followed up now (the patient accepted it).
  if (leadOf(group).id !== plan.id) return { reason: 'other_option' };
  const open = await db.get(`SELECT COUNT(*) AS n FROM procedures WHERE treatment_plan_id IN (${inIds}) AND status = 'planned' AND appointment_id IS NULL`, ...ids);
  if (!Number(open.n)) return { reason: 'treatment_done' };
  // Declined in writing: an informed-refusal form signed since the work was diagnosed.
  const refused = await db.get(
    `SELECT pf.id FROM patient_forms pf JOIN form_templates t ON t.id = pf.template_id
     WHERE pf.practice_id = ? AND pf.patient_id = ? AND pf.signed_at IS NOT NULL AND pf.signed_at >= ? AND LOWER(t.name) LIKE ?`,
    plan.practice_id, plan.patient_id, `${anchor || String(plan.created_at).slice(0, 10)} 00:00`, '%refus%',
  );
  if (refused) return { reason: 'declined' };
  return null;
}
