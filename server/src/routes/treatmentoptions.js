import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, change, findOr404, audit, practiceNow, validTooth, normalizeSurfaces, codeArea, mapSeq } from '../util.js';
import { officeFee } from '../fees.js';
import { fingerprint } from '../finoptions.js';
import { planQuote, plainName } from './finoptions.js';

// Comparing 2–3 alternative treatments for one tooth or problem (backlog F6): e.g. "extraction + bone graft" vs
// "root canal + buildup + crown on #19". Each option is an ordinary treatment plan in one option_group
// (so accepting one is the usual plan acceptance, F4). This file:
// - creates the group in one call (POST /patients/:id/treatment-options — also used by the voice/typed entry
//   engine), validated, idempotent and audited;
// - builds the comparison: what's done, teeth, visits and chair time, the patient's cost after insurance, the
//   lowest monthly, the likely next step and its future cost, typical longevity, plain pros and cons;
// - keeps the office's own wording for those per procedure (procedure_insights), with starter text that is
//   marked until someone in the office reviews it.

// Starter wording, by code prefix (longest prefix wins): written plainly for patients, and marked "review before
// use" on the staff screen until the office saves its own version (then it's theirs). `next` lists the likely
// next steps — several when there's a choice (after an extraction: an implant or a bridge) — with the codes
// they'd take, priced at the office's fees when shown.
const IMPLANT = { label: 'Implant and crown to replace the tooth', codes: ['D6010', 'D6065'] };
const BRIDGE = { label: 'Bridge to fill the gap (3 units)', codes: ['D6750', 'D6240', 'D6750'] };
const CROWN = { label: 'Buildup and crown to protect the tooth', codes: ['D2950', 'D2740'] };
const st = (next, longevity, pros, cons) => ({ next, longevity, pros, cons });
export const STARTER_INSIGHTS = {
  D0: st([], null, ['Shows us exactly what’s going on'], []),
  D1110: st([], 'Every 6 months', ['Removes buildup brushing can’t reach', 'Catches problems early'], []),
  D1206: st([], 'Every 6 months', ['Strengthens enamel and helps prevent cavities'], []),
  D1351: st([], 'About 5–10 years', ['Seals deep grooves so cavities can’t start'], ['Can chip and need touching up']),
  D21: st([], 'About 10–15 years', ['Strong and long-lasting', 'Done in one visit'], ['Silver colour shows']),
  D23: st([], 'About 5–10 years', ['Tooth-coloured', 'Done in one visit'], ['Large fillings can crack over time']),
  D2962: st([], 'About 10–15 years', ['Changes the shape and colour of front teeth'], ['A thin layer of enamel is removed']),
  D27: st([], 'About 10–15 years', ['Protects a weak or cracked tooth', 'Looks like a natural tooth'], ['Some of the tooth is reshaped', 'Two visits']),
  D2950: st([], null, ['Rebuilds the tooth so a crown holds'], []),
  D2954: st([], null, ['Anchors the rebuild inside a root-treated tooth'], []),
  D3220: st([], null, ['Relieves pain in a baby tooth and keeps it until it falls out naturally'], []),
  D3: st([CROWN], 'Often 10–15 years or more with a crown', ['Keeps your own tooth', 'Chewing feels natural', 'Stops the pain from the infected nerve'], ['Usually needs a crown afterwards', 'One or two longer visits']),
  D434: st([{ label: 'Gum maintenance cleanings every 3–4 months', codes: ['D4910'] }], null, ['Stops gum disease getting worse', 'Helps keep teeth that would otherwise loosen'], ['Gums can be tender for a few days']),
  D4910: st([], 'Every 3–4 months', ['Keeps gum disease under control'], []),
  D5: st([], 'About 5–8 years', ['The least expensive way to replace many teeth'], ['Removable; can move when eating', 'Takes time to get used to']),
  D6010: st([{ label: 'Crown on the implant', codes: ['D6065'] }], 'Often 20 years or more', ['Feels and works like a natural tooth', 'Doesn’t touch the neighbouring teeth', 'Keeps the jawbone healthy'], ['Months of healing before the crown', 'Higher cost up front']),
  D6065: st([], 'About 15 years or more', ['Looks and works like a natural tooth'], []),
  D62: st([], 'About 10–15 years', ['Fixed in place within a few weeks', 'No surgery'], ['The neighbouring teeth are reshaped for it', 'Harder to floss under']),
  D67: st([], 'About 10–15 years', ['Fixed in place within a few weeks', 'No surgery'], ['The neighbouring teeth are reshaped for it', 'Harder to floss under']),
  D7140: st([IMPLANT, BRIDGE], 'The gap is permanent unless the tooth is replaced', ['Quickest and least expensive today', 'Ends the problem in one visit'], ['Leaves a gap: nearby teeth can drift and the bone shrinks', 'Replacing the tooth later costs more']),
  D7210: st([IMPLANT, BRIDGE], 'The gap is permanent unless the tooth is replaced', ['Removes a tooth that can’t be saved'], ['Leaves a gap: nearby teeth can drift and the bone shrinks', 'A few days of healing']),
  D7240: st([], null, ['Prevents crowding, infection and damage to the next tooth'], ['A few days of swelling']),
  D7953: st([], null, ['Keeps the bone ready for an implant later'], ['Adds a few months of healing']),
  D8: st([], 'Results last with a retainer', ['Straighter teeth and a better bite', 'Easier to keep clean'], ['Takes 1–2 years']),
  D9944: st([], 'About 3–5 years', ['Protects teeth from grinding at night'], ['Takes a few nights to get used to']),
};
const longest = (map, code) => Object.keys(map).filter((k) => code.startsWith(k)).sort((a, b) => b.length - a.length)[0];

const cleanList = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 6) throw new HttpError(400, `${name}: up to 6 short lines`);
  return v.map((x) => String(x || '').trim().slice(0, 120)).filter(Boolean);
};

// The office's saved wording (or the starter) for every code prefix it has.
async function insightsFor(db, practiceId) {
  const saved = await db.all('SELECT * FROM procedure_insights WHERE practice_id = ?', practiceId);
  const map = Object.fromEntries(Object.entries(STARTER_INSIGHTS).map(([k, v]) => [k, { ...v, code: k, starter: true }]));
  for (const r of saved) {
    map[r.code] = { code: r.code, next: JSON.parse(r.next_steps || '[]'), longevity: r.longevity, pros: JSON.parse(r.pros || '[]'), cons: JSON.parse(r.cons || '[]'), starter: false, updated_at: r.updated_at };
  }
  return map;
}

// One option's column in the comparison.
async function optionView(db, plan, insights) {
  const q = await planQuote(db, plan);
  const procs = await db.all("SELECT pr.code, pr.tooth, pc.time_units FROM procedures pr LEFT JOIN procedure_codes pc ON pc.id = pr.code_id WHERE pr.treatment_plan_id = ? AND pr.status = 'planned'", plan.id);
  const codes = procs.map((p) => p.code);
  const notes = { next: [], longevity: [], pros: [], cons: [], starter: false };
  for (const code of [...new Set(codes)]) {
    const key = longest(insights, code);
    if (!key) continue;
    const i = insights[key];
    notes.starter ||= i.starter;
    if (i.longevity) notes.longevity.push(i.longevity);
    notes.pros.push(...i.pros);
    notes.cons.push(...i.cons);
    // A next step the option already includes isn't "later".
    for (const step of i.next) {
      if (step.codes.every((c) => codes.includes(c))) continue;
      let cost = 0;
      for (const c of step.codes) {
        const pc = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', plan.practice_id, c);
        if (pc) cost += await officeFee(db, plan.practice_id, pc, { patientId: plan.patient_id });
      }
      if (!notes.next.some((n) => n.label === step.label)) notes.next.push({ label: step.label, codes: step.codes, cost });
    }
  }
  const uniq = (l) => [...new Set(l)];
  const monthly = q.options.filter((o) => o.monthly).map((o) => o.monthly);
  return {
    plan_id: plan.id, label: plan.option_label || plan.name, name: plan.name, status: plan.status, signed: !!plan.signed_at,
    work: uniq(q.phases.flatMap((p) => p.lines.map((l) => `${plainName(l)}${l.tooth ? ` #${l.tooth}` : ''}`))),
    teeth: q.all_teeth, visits: q.phases.reduce((n, p) => n + (p.count ? p.visits : 0), 0),
    chair_minutes: procs.reduce((s, p) => s + (p.time_units ? p.time_units * 10 : 30), 0),
    fee: q.all_totals.fee, insurance: q.all_totals.insurance, you_pay: q.all_totals.you_pay, monthly_from: monthly.length ? Math.min(...monthly) : null,
    next_steps: notes.next, later_cost_from: notes.next.length ? Math.min(...notes.next.map((n) => n.cost)) : 0,
    longevity: uniq(notes.longevity), pros: uniq(notes.pros), cons: uniq(notes.cons), starter: notes.starter,
  };
}

// The comparison for a plan's group (or the plan alone).
export async function compareFor(db, plan) {
  const plans = plan.option_group
    ? await db.all("SELECT * FROM treatment_plans WHERE practice_id = ? AND patient_id = ? AND option_group = ? AND status IN ('proposed','accepted') ORDER BY option_label, id", plan.practice_id, plan.patient_id, plan.option_group)
    : [plan];
  const insights = await insightsFor(db, plan.practice_id);
  return { group: plan.option_group || null, options: await mapSeq(plans, (p) => optionView(db, p, insights)) };
}
// For the patient: nothing about starter text or internal codes.
export const publicCompare = (c) => ({ options: c.options.map(({ starter: _s, ...o }) => ({ ...o, next_steps: o.next_steps.map(({ codes: _c, ...n }) => n) })) });

export default function treatmentOptionRoutes({ db }) {
  const r = Router();

  // Create 2–3 alternatives for one problem in one go. Idempotent: the same `key` (or, without one, the same
  // options on the same day) returns the group already made.
  r.post('/patients/:id/treatment-options', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 3) throw new HttpError(400, 'Give 2 or 3 options to compare');
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const options = [];
    for (const [n, o] of b.options.entries()) {
      const at = `Option ${n + 1}`;
      if (!Array.isArray(o?.items) || !o.items.length || o.items.length > 20) throw new HttpError(400, `${at}: add 1-20 procedures`);
      const items = [];
      for (const it of o.items) {
        const code = String(it?.code || '').trim().toUpperCase();
        const pc = /^D\d{4}$/.test(code) && await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', req.user.practice_id, code);
        if (!pc) throw new HttpError(400, `${at}: ${it?.code || 'a code'} isn't one of your procedure codes`);
        const tooth = it.tooth == null || it.tooth === '' ? null : String(it.tooth).toUpperCase();
        if (!validTooth(tooth)) throw new HttpError(400, `${at}: ${tooth} isn't a tooth`);
        const kind = codeArea(pc);
        if (kind === 'tooth' && pc.requires_tooth && !tooth) throw new HttpError(400, `${at}: ${code} needs a tooth`);
        const surfaces = normalizeSurfaces(it.surfaces);
        if (pc.requires_surface && !surfaces) throw new HttpError(400, `${at}: ${code} needs surfaces`);
        const area = ['quadrant', 'arch'].includes(kind) ? String(it.area || '').toUpperCase() : null;
        if (kind === 'quadrant' && !['UR', 'UL', 'LL', 'LR'].includes(area)) throw new HttpError(400, `${at}: ${code} needs a quadrant (UR, UL, LL, LR)`);
        if (kind === 'arch' && !['U', 'L'].includes(area)) throw new HttpError(400, `${at}: ${code} needs an arch (U or L)`);
        items.push({ pc, tooth: kind === 'tooth' ? tooth : null, surfaces: kind === 'tooth' ? surfaces : null, area });
      }
      options.push({ label: String(o.label || '').trim().slice(0, 40) || `Option ${n + 1}`, name: String(o.name || '').trim().slice(0, 120), items });
    }
    const problem = String(b.name || '').trim().slice(0, 80);
    const teeth = [...new Set(options.flatMap((o) => o.items.map((i) => i.tooth)).filter(Boolean))];
    const key = String(b.key || '').slice(0, 120) || fingerprint({ today, options: options.map((o) => [o.label, o.items.map((i) => [i.pc.code, i.tooth, i.surfaces, i.area])]) });
    const group = `opts-${fingerprint([req.user.practice_id, patient.id, key]).slice(0, 20)}`;
    const found = await db.all('SELECT id, option_label, name FROM treatment_plans WHERE practice_id = ? AND patient_id = ? AND option_group = ? ORDER BY id', req.user.practice_id, patient.id, group);
    if (found.length) {
      return res.json({ group, replay: true, plans: found.map((p) => ({ id: p.id, label: p.option_label, name: p.name })), compare: await compareFor(db, await db.get('SELECT * FROM treatment_plans WHERE id = ?', found[0].id)) });
    }
    const made = await db.tx(async () => {
      const out = [];
      for (const o of options) {
        const work = o.items.map((i) => `${plainName(i.pc)}${i.tooth && teeth.length > 1 ? ` #${i.tooth}` : ''}`);
        const name = o.name || `${problem || (teeth.length ? `Tooth ${teeth.map((t) => `#${t}`).join(', ')}` : 'Options')}: ${[...new Set(work)].join(' + ')}`.slice(0, 120);
        const id = await insert(db, 'treatment_plans', { practice_id: req.user.practice_id, patient_id: patient.id, name, option_group: group, option_label: o.label });
        for (const [k, i] of o.items.entries()) {
          await insert(db, 'procedures', {
            practice_id: req.user.practice_id, patient_id: patient.id, treatment_plan_id: id, code_id: i.pc.id, code: i.pc.code, description: i.pc.description, category: i.pc.category,
            tooth: i.tooth, surfaces: i.surfaces, area: i.area, provider_id: patient.primary_provider_id ?? null, priority: k + 1, phase: 1,
            fee: await officeFee(db, req.user.practice_id, i.pc, { patientId: patient.id, providerId: patient.primary_provider_id }),
          });
        }
        out.push({ id, label: o.label, name });
      }
      return out;
    });
    await audit(db, req, 'treatment_plan.options_create', 'treatment_plans', made[0].id, { patient_id: patient.id, group, options: made.map((p) => ({ id: p.id, label: p.label })), source_key: b.key ? 'given' : 'content' });
    res.status(201).json({ group, replay: false, plans: made, compare: await compareFor(db, await db.get('SELECT * FROM treatment_plans WHERE id = ?', made[0].id)) });
  });

  r.get('/treatment-plans/:tid/compare', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    res.json(await compareFor(db, plan));
  });

  // The office's wording for "likely next step", longevity, pros and cons, per procedure code (or prefix).
  r.get('/procedure-insights', requirePermission('clinical:read'), async (req, res) => {
    res.json(Object.values(await insightsFor(db, req.user.practice_id)).sort((a, b) => (a.code < b.code ? -1 : 1)));
  });
  r.put('/procedure-insights/:code', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change what patients are told about procedures');
    const code = String(req.params.code).toUpperCase();
    if (!/^D\d{1,4}$/.test(code)) throw new HttpError(400, 'Use a procedure code or the start of one (e.g. D7140 or D27)');
    const b = req.body || {};
    if (b.next_steps != null && (!Array.isArray(b.next_steps) || b.next_steps.length > 3)) throw new HttpError(400, 'Up to 3 next steps');
    const next = (b.next_steps || []).map((n, k) => {
      const label = String(n?.label || '').trim().slice(0, 120);
      const list = (Array.isArray(n?.codes) ? n.codes : String(n?.codes || '').split(/[\s,]+/)).map((c) => String(c).toUpperCase()).filter(Boolean);
      if (!label) throw new HttpError(400, `Next step ${k + 1}: describe it in plain words`);
      if (!list.length || list.length > 6 || list.some((c) => !/^D\d{4}$/.test(c))) throw new HttpError(400, `Next step ${k + 1}: 1-6 procedure codes`);
      return { label, codes: list };
    });
    const row = {
      next_steps: JSON.stringify(next), longevity: String(b.longevity || '').trim().slice(0, 120) || null,
      pros: JSON.stringify(cleanList(b.pros, 'Pros')), cons: JSON.stringify(cleanList(b.cons, 'Cons')),
    };
    const had = await db.get('SELECT * FROM procedure_insights WHERE practice_id = ? AND code = ?', req.user.practice_id, code);
    if (had) await change(db, 'procedure_insights', had.id, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString() });
    else await insert(db, 'procedure_insights', { practice_id: req.user.practice_id, code, ...row, updated_by: req.user.id });
    await audit(db, req, 'procedure_insight.save', 'procedure_insights', had?.id ?? null, { code }, { before: had ? { next_steps: had.next_steps, longevity: had.longevity, pros: had.pros, cons: had.cons } : { starter: JSON.stringify(STARTER_INSIGHTS[code] || null) }, after: row });
    res.json((await insightsFor(db, req.user.practice_id))[code]);
  });
  return r;
}
