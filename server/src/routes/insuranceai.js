import { Router } from 'express';
import { createHash } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, isRealDate, recorded } from '../util.js';
import { structured, aiClient } from '../ai.js';
import { PLAN_BENEFITS, savePolicy } from '../benefits.js';
import { requireHuman } from '../aiguard.js';

// Reading insurance paperwork with AI, so nobody retypes it:
//  - a benefit summary (the payer portal's page saved as PDF or a screenshot, a fax, or the free-text notes in
//    an eligibility response) becomes the plan's breakdown: maximums, percentages, frequencies, waiting
//    periods, downgrades, age limits, missing-tooth clause — shown next to what's on file, applied by a person;
//  - a paper EOB (or a check's remittance) becomes a filled-in insurance check: each claim found, matched to
//    ours, with what was paid and written off per procedure — posted by a person through the usual check entry;
//  - a photo of an insurance card (front, and the back if there is one) becomes a filled-in policy form: the
//    carrier (matched to ours, or offered as a new one), member ID, group, subscriber and payer ID — saved by a
//    person, who is recorded as the one who approved what the AI read.
const MAX_BYTES = 10_000_000;

function fileContent(body) {
  if (body?.text) return [{ type: 'text', text: String(body.text).slice(0, 60_000) }];
  const data = String(body?.file_base64 || '');
  const mime = String(body?.mime || '');
  if (!data) throw new HttpError(400, 'Attach the document (PDF or image) or paste its text');
  if (data.length * 0.75 > MAX_BYTES) throw new HttpError(400, 'That file is too large (10 MB at most)');
  if (mime === 'application/pdf') return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }];
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return [{ type: 'image', source: { type: 'base64', media_type: mime, data } }];
  throw new HttpError(400, 'PDF, PNG or JPEG only');
}

const FREQ = {
  type: 'object',
  properties: {
    label: { type: 'string' }, codes: { type: 'array', items: { type: 'string' }, description: 'CDT codes or prefixes (D27 = all crowns)' },
    count: { type: 'integer' }, months: { type: 'integer', description: 'Rolling window in months, when the limit is "1 per 36 months"' },
    per: { type: 'string', enum: ['benefit_year'], description: 'When the limit is per benefit/calendar year' },
    per_tooth: { type: 'boolean' },
  },
  required: ['codes', 'count'],
};
const BENEFITS_TOOL = {
  name: 'benefit_breakdown',
  description: 'The dental plan’s benefits as written in the document. Leave out anything the document doesn’t say.',
  input_schema: {
    type: 'object',
    properties: {
      plan_name: { type: 'string' }, group_number: { type: 'string' }, network: { type: 'string', enum: ['in', 'out', 'unknown'] },
      annual_max: { type: 'number', description: 'Dollars' }, deductible: { type: 'number' }, family_deductible: { type: 'number' },
      deductible_waived_preventive: { type: 'boolean' },
      pct_preventive: { type: 'integer' }, pct_basic: { type: 'integer' }, pct_major: { type: 'integer' },
      benefit_month: { type: 'integer', description: '1 for a calendar year; the month a fiscal benefit year starts otherwise' },
      ortho_max: { type: 'number' }, ortho_pct: { type: 'integer' }, ortho_age_limit: { type: 'integer' },
      wait_basic_months: { type: 'integer' }, wait_major_months: { type: 'integer' },
      downgrade_composites: { type: 'boolean', description: 'Posterior composites paid at the amalgam rate' },
      missing_tooth_clause: { type: 'boolean' },
      frequencies: { type: 'array', items: FREQ },
      age_limits: { type: 'array', items: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } }, max_age: { type: 'integer' } }, required: ['codes', 'max_age'] } },
      coverage_overrides: { type: 'array', description: 'Services paid at a different percentage from their category (e.g. endodontics at 50%, implants not covered = 0).', items: { type: 'object', properties: { code: { type: 'string', description: 'CDT code or prefix' }, pct: { type: 'integer' } }, required: ['code', 'pct'] } },
      history: { type: 'array', description: 'Services already used and when.', items: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['codes', 'date'] } },
      notes: { type: 'array', items: { type: 'string' }, description: 'Anything else the front desk should know (exclusions, special rules).' },
    },
  },
};
const BENEFITS_SYSTEM = `You read US dental insurance benefit documents (payer portal pages, breakdown faxes, eligibility responses) for a dental office's front desk.
Copy the plan's rules into the tool exactly as written; don't infer or fill in typical values. Percentages are what the plan pays. Map service categories to CDT: preventive D1, diagnostic D0, basic restorative D2140-D2394, endodontics D3, periodontics D4, oral surgery D7, crowns D27, prosthodontics D5/D62, implants D60, orthodontics D8.`;

const EOB_TOOL = {
  name: 'read_eob',
  description: 'Everything on this explanation of benefits / remittance.',
  input_schema: {
    type: 'object',
    properties: {
      payer_name: { type: 'string' }, check_number: { type: 'string' }, check_date: { type: 'string', description: 'YYYY-MM-DD' },
      total_paid: { type: 'number', description: 'Check/EFT total in dollars' }, method: { type: 'string', enum: ['check', 'eft'] },
      provider_adjustments: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, amount: { type: 'number' } }, required: ['amount'] } },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            patient_name: { type: 'string' }, subscriber_id: { type: 'string' }, payer_claim_number: { type: 'string' }, date_of_service: { type: 'string', description: 'YYYY-MM-DD' },
            paid: { type: 'number' }, patient_responsibility: { type: 'number' }, deductible: { type: 'number' }, denied: { type: 'boolean' }, remarks: { type: 'string' },
            lines: {
              type: 'array',
              items: { type: 'object', properties: { code: { type: 'string' }, tooth: { type: 'string' }, billed: { type: 'number' }, allowed: { type: 'number' }, paid: { type: 'number' }, write_off: { type: 'number' }, patient_resp: { type: 'number' }, deductible: { type: 'number' }, reason: { type: 'string' } }, required: ['code', 'paid'] },
            },
          },
          required: ['patient_name', 'paid', 'lines'],
        },
      },
    },
    required: ['claims'],
  },
};
const EOB_SYSTEM = `You read dental explanation-of-benefits documents and payer remittances for a dental office's billing team. Copy every claim and service line exactly: patient, dates, CDT codes, billed, allowed, paid, the contractual write-off (billed minus allowed, when it's a PPO reduction the patient doesn't owe), patient responsibility and reason codes. Dollars as numbers. Don't guess values that aren't on the page.`;

const toCents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Finds our claim for an EOB claim: payer claim number first, then patient name, date of service and codes.
async function matchClaim(db, pid, c, used) {
  const open = await db.all(
    `SELECT c.id, c.patient_id, c.total_fee, c.paid_amount, c.payer_claim_number, c.status, p.first_name, p.last_name, pi.subscriber_id,
       (SELECT MIN(pr.completed_at) FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = c.id) AS dos
     FROM claims c JOIN patients p ON p.id = c.patient_id LEFT JOIN patient_insurance pi ON pi.id = c.patient_insurance_id
     WHERE c.practice_id = ? AND c.status IN ('submitted','partially_paid')`, pid,
  );
  const [first, ...rest] = String(c.patient_name || '').replace(',', ' ').split(/\s+/).filter(Boolean);
  const names = [norm(first), norm(rest.at(-1) || '')];
  let best = null;
  for (const cl of open.filter((x) => !used.has(x.id))) {
    let score = 0;
    const why = [];
    if (c.payer_claim_number && cl.payer_claim_number && norm(c.payer_claim_number) === norm(cl.payer_claim_number)) { score += 100; why.push('payer claim number'); }
    const last = norm(cl.last_name);
    const firstN = norm(cl.first_name);
    if (names.includes(last) && (names.includes(firstN) || names.some((n) => n && firstN.startsWith(n.slice(0, 3))))) { score += 40; why.push('patient'); } else if (names.includes(last)) { score += 20; why.push('last name'); }
    if (c.subscriber_id && cl.subscriber_id && norm(c.subscriber_id) === norm(cl.subscriber_id)) { score += 25; why.push('subscriber ID'); }
    if (c.date_of_service && cl.dos && cl.dos.slice(0, 10) === c.date_of_service) { score += 30; why.push('date of service'); }
    const codes = (await db.all('SELECT pr.code FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', cl.id)).map((x) => x.code);
    const eobCodes = (c.lines || []).map((l) => String(l.code || '').toUpperCase());
    if (eobCodes.length && eobCodes.every((x) => codes.includes(x))) { score += 20; why.push('procedures'); }
    if (score > (best?.score || 0)) best = { claim: cl, score, why };
  }
  return best && best.score >= 60 ? best : null;
}

// ---- Insurance cards ----
const CARD_TOOL = {
  name: 'insurance_card',
  description: 'What is printed on this dental insurance card. Leave out anything the card doesn’t show.',
  input_schema: {
    type: 'object',
    properties: {
      carrier_name: { type: 'string', description: 'The insurance company (e.g. Delta Dental, MetLife), not the employer' },
      payer_id: { type: 'string', description: 'Electronic payer ID for claims, when printed (often on the back)' },
      member_id: { type: 'string', description: 'Member / subscriber / ID number exactly as printed' },
      group_number: { type: 'string' }, plan_name: { type: 'string' }, employer: { type: 'string' },
      subscriber_name: { type: 'string', description: 'The subscriber (primary member) as printed, First Last' },
      subscriber_dob: { type: 'string', description: 'YYYY-MM-DD, only when printed' },
      effective_date: { type: 'string', description: 'YYYY-MM-DD, only when printed' },
      claims_address: { type: 'string' }, phone: { type: 'string', description: 'Provider services phone' },
      unclear: { type: 'array', items: { type: 'string' }, description: 'Fields that were hard to read (blurred, cut off) and need checking' },
    },
  },
};
const CARD_SYSTEM = `You read photos of US dental insurance cards for a dental office's front desk. Copy what is printed exactly (ID numbers character for character). Don't guess: leave out anything not on the card, and list anything hard to read under "unclear". The carrier is the insurance company, not the employer or network name.`;

// Card photos come from the browser, shrunk to a few hundred KB each.
function cardImages(body) {
  const sides = [body?.front || (body?.file_base64 ? body : null), body?.back].filter(Boolean);
  if (!sides.length) throw new HttpError(400, 'Add a photo of the front of the card');
  return sides.map((side) => {
    const data = String(side.file_base64 || '');
    const mime = String(side.mime || '');
    if (!data) throw new HttpError(400, 'Add a photo of the front of the card');
    if (data.length * 0.75 > MAX_BYTES) throw new HttpError(400, 'That photo is too large (10 MB at most)');
    if (mime === 'application/pdf') return { data, block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } };
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new HttpError(400, 'A photo (PNG or JPEG) or a PDF of the card');
    return { data, block: { type: 'image', source: { type: 'base64', media_type: mime, data } } };
  });
}

// Sandbox (no AI key, demo/test servers): the same answer every time for the same picture, made up — never
// read from the picture — so the whole flow can be tried and tested without sending anything anywhere.
const SANDBOX_CARRIERS = [['Delta Dental', '94276'], ['MetLife Dental', '65978'], ['Cigna Dental', '62308'], ['Aetna Dental', '60054'], ['Guardian', '64246'], ['United Concordia', 'CX014']];
export function sandboxCard(bytes, patient) {
  const h = createHash('sha256').update(bytes).digest();
  const [carrier_name, payer_id] = SANDBOX_CARRIERS[h[0] % SANDBOX_CARRIERS.length];
  return {
    carrier_name, payer_id, member_id: `SBX${h.readUInt32BE(1) % 1_000_000_000}`.padEnd(12, '0'), group_number: String(100000 + (h.readUInt16BE(5) % 900000)),
    subscriber_name: `${patient.first_name} ${patient.last_name}`, subscriber_dob: patient.dob || undefined, plan_name: 'PPO', unclear: [],
  };
}

const cardNorm = (s) => String(s || '').toLowerCase().replace(/\b(inc|co|company|insurance|of [a-z ]+)\b/g, '').replace(/[^a-z0-9]/g, '');
// Our carrier for what's on the card: the payer ID first, then the name (either way round: "Delta Dental of Texas" is our "Delta Dental").
async function matchCarrier(db, pid, { carrier_name: name, payer_id: payer }) {
  const carriers = await db.all('SELECT id, name, payer_id FROM insurance_carriers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
  if (payer) {
    const byPayer = carriers.find((c) => c.payer_id && cardNorm(c.payer_id) === cardNorm(payer));
    if (byPayer) return byPayer;
  }
  const n = cardNorm(name);
  if (!n) return null;
  return carriers.find((c) => cardNorm(c.name) === n) || carriers.find((c) => { const m = cardNorm(c.name); return m.length >= 4 && (n.startsWith(m) || m.startsWith(n)); }) || null;
}

const sameName = (a, b) => cardNorm(a).replace(/\d/g, '') === cardNorm(b).replace(/\d/g, '');
const ageOn = (dob, today) => (dob ? Math.floor((Date.parse(today) - Date.parse(dob)) / (365.25 * 86400_000)) : null);

// Reads a paper EOB (or a check's remittance) with AI and matches each claim on it to ours, line by line (amounts
// in cents). A draft for a person: nothing is posted here. Used by the EOB screen and the insurance autopilot.
export async function readEob(db, config, pid, content) {
  const out = await structured(config, { system: EOB_SYSTEM, tool: EOB_TOOL, effort: 'medium', maxTokens: 16000, content: [...content, { type: 'text', text: 'Read this EOB.' }] });
  const used = new Set();
  const claims = [];
  for (const c of out.claims || []) {
    const m = await matchClaim(db, pid, c, used);
    let lines = [];
    if (m) {
      used.add(m.claim.id);
      const items = await db.all('SELECT ci.id, pr.code, pr.tooth, ci.fee FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY ci.id', m.claim.id);
      const free = [...items];
      lines = (c.lines || []).map((l) => {
        const i = free.findIndex((x) => x.code === String(l.code).toUpperCase() && (!l.tooth || !x.tooth || String(x.tooth) === String(l.tooth)));
        const item = i >= 0 ? free.splice(i, 1)[0] : null;
        return { claim_item_id: item?.id ?? null, code: l.code, tooth: l.tooth || null, billed: toCents(l.billed), paid: toCents(l.paid) || 0, write_off: toCents(l.write_off) || 0, patient_resp: toCents(l.patient_resp), reason: l.reason || null };
      });
    }
    const paid = toCents(c.paid) || 0;
    claims.push({
      patient_name: c.patient_name, date_of_service: c.date_of_service || null, payer_claim_number: c.payer_claim_number || null, denied: !!c.denied, remarks: c.remarks || null,
      paid, write_off: lines.reduce((s, l) => s + (l.write_off || 0), 0), deductible: toCents(c.deductible), patient_responsibility: toCents(c.patient_responsibility),
      claim_id: m?.claim.id ?? null, match: m ? { score: Math.min(100, m.score), why: m.why, patient: `${m.claim.first_name} ${m.claim.last_name}`, billed: m.claim.total_fee } : null,
      lines,
    });
  }
  const carrier = out.payer_name ? await db.get('SELECT id, name FROM insurance_carriers WHERE practice_id = ? AND lower(name) = lower(?)', pid, out.payer_name) : null;
  return {
    payer_name: out.payer_name || null, carrier_id: carrier?.id ?? null, check_number: out.check_number || null, check_date: out.check_date || null,
    amount: toCents(out.total_paid), method: out.method === 'eft' ? 'eft' : 'check',
    provider_adjustments: (out.provider_adjustments || []).map((a) => ({ reason: a.reason || 'Other', amount: toCents(a.amount) })), claims,
    totals_match: toCents(out.total_paid) === claims.reduce((s, c) => s + c.paid, 0) - (out.provider_adjustments || []).reduce((s, a) => s + (toCents(a.amount) || 0), 0),
  };
}

export default function insuranceAiRoutes({ db, config }) {
  const r = Router();

  r.post('/insurance-plans/:pid/read-benefits', requirePermission('billing:write'), async (req, res) => {
    const plan = await findOr404(db, 'insurance_plans', req.params.pid, req.user.practice_id, 'Plan');
    const out = await structured(config, { system: BENEFITS_SYSTEM, tool: BENEFITS_TOOL, effort: 'medium', content: [...fileContent(req.body), { type: 'text', text: 'Fill in the benefit breakdown from this document.' }] });
    // In the plan's own units (cents, lists) so the screen can compare and apply field by field.
    const proposed = {};
    for (const k of ['annual_max', 'deductible', 'family_deductible', 'ortho_max']) if (out[k] != null) proposed[k] = toCents(out[k]);
    for (const k of ['pct_preventive', 'pct_basic', 'pct_major', 'benefit_month', 'ortho_pct', 'ortho_age_limit', 'wait_basic_months', 'wait_major_months']) if (out[k] != null) proposed[k] = Math.round(Number(out[k]));
    for (const k of ['downgrade_composites', 'missing_tooth_clause']) if (out[k] != null) proposed[k] = out[k] ? 1 : 0;
    if (out.frequencies?.length) proposed.frequencies = out.frequencies.map((f) => ({ label: f.label || f.codes.join(', '), codes: f.codes.map((c) => String(c).toUpperCase()), count: f.count, ...(f.months ? { months: f.months } : { per: 'benefit_year' }), ...(f.per_tooth ? { per_tooth: true } : {}) }));
    if (out.age_limits?.length) proposed.age_limits = out.age_limits.map((a) => ({ codes: a.codes.map((c) => String(c).toUpperCase()), max_age: a.max_age }));
    if (out.coverage_overrides?.length) proposed.coverage_overrides = Object.fromEntries(out.coverage_overrides.map((o) => [String(o.code).toUpperCase(), o.pct]));
    const current = Object.fromEntries(PLAN_BENEFITS.filter((k) => k in proposed).map((k) => [k, typeof plan[k] === 'string' && /^[[{]/.test(plan[k]) ? JSON.parse(plan[k]) : plan[k]]));
    await audit(db, req, 'insurance_plan.ai_read', 'insurance_plans', plan.id, { fields: Object.keys(proposed) });
    res.json({ proposed, current, history: out.history || [], notes: out.notes || [], plan_name: out.plan_name || null, group_number: out.group_number || null, network: out.network || null, text: out.text || null });
  });

  r.post('/eobs/read', requirePermission('billing:write'), async (req, res) => {
    const eob = await readEob(db, config, req.user.practice_id, fileContent(req.body));
    await audit(db, req, 'eob.ai_read', 'claims', null, { claims: eob.claims.length, matched: eob.claims.filter((c) => c.claim_id).length });
    res.json(eob);
  });

  // A card photo → a filled-in policy for a person to check. Nothing is saved here; the read is kept in the
  // audit trail (source: AI) so the saved policy can say where its numbers came from.
  r.post('/patients/:id/insurance-card/read', requirePermission('patients:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.params.id, pid, 'Patient');
    const images = cardImages(req.body);
    let out;
    let sandbox = false;
    if (aiClient(config)) {
      out = await structured(config, { system: CARD_SYSTEM, tool: CARD_TOOL, effort: 'low', maxTokens: 4000, content: [...images.map((i) => i.block), { type: 'text', text: images.length > 1 ? 'The front of the card, then the back. Read it.' : 'The front of the card. Read it.' }] });
      if (!out.member_id && !out.carrier_name) throw new HttpError(422, 'Couldn’t read an insurance card in that picture — try a clearer, closer photo');
    } else if (config.ediMode === 'sandbox' || config.cardReader === 'sandbox' || process.env.CARD_READER === 'sandbox') {
      out = sandboxCard(Buffer.from(images[0].data, 'base64'), patient);
      sandbox = true;
    } else throw new HttpError(503, 'Reading cards needs AI, which is off on this server (ANTHROPIC_API_KEY is not set) — type the card in instead');

    const clean = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) || null);
    const today = new Date().toISOString().slice(0, 10);
    const read = {
      carrier_name: clean(out.carrier_name, 100), payer_id: clean(out.payer_id, 20), member_id: clean(out.member_id, 60)?.replace(/\s+/g, '') || null,
      group_number: clean(out.group_number, 60), plan_name: clean(out.plan_name, 100), subscriber_name: clean(out.subscriber_name, 100),
      subscriber_dob: isRealDate(out.subscriber_dob) ? out.subscriber_dob : null, effective_date: isRealDate(out.effective_date) ? out.effective_date : null,
    };
    const carrier = await matchCarrier(db, pid, read);
    // Who the subscriber is to the patient: the patient when the names match; otherwise a parent for a
    // child, a spouse for an adult — a suggestion the person confirms.
    const self = !read.subscriber_name || sameName(read.subscriber_name, `${patient.first_name} ${patient.last_name}`);
    const age = ageOn(patient.dob, today);
    const relationship = self ? 'self' : age != null && age < 19 ? 'child' : 'spouse';
    const unclear = Array.isArray(out.unclear) ? out.unclear.map((x) => String(x).slice(0, 60)).slice(0, 10) : [];
    const reason = sandbox
      ? 'Sandbox card reader: made-up values for trying things out — not read from the picture'
      : `Read from the card photo${images.length > 1 ? 's (front and back)' : ''}${unclear.length ? `; hard to read: ${unclear.join(', ')}` : ''}. Check against the card before saving.`;
    const proposed = {
      carrier_id: carrier?.id ?? null, subscriber_name: read.subscriber_name || `${patient.first_name} ${patient.last_name}`, subscriber_id: read.member_id,
      subscriber_dob: self ? patient.dob || read.subscriber_dob : read.subscriber_dob, relationship, group_number: read.group_number, effective_date: read.effective_date,
    };
    await audit(db, req, 'insurance_card.ai_read', 'patients', patient.id, { read, proposed, sandbox, sides: images.length }, {
      source: 'ai', actor: sandbox ? 'Card reader (sandbox)' : `AI card reader (for ${req.user.name})`, reason,
    });
    const row = await db.get("SELECT MAX(id) AS id FROM audit_log WHERE practice_id = ? AND action = 'insurance_card.ai_read' AND entity_id = ?", pid, patient.id);
    res.json({
      read_id: row.id, read, proposed, reason, sandbox, unclear,
      carrier: carrier ? { id: carrier.id, name: carrier.name } : null,
      new_carrier: !carrier && read.carrier_name ? { name: read.carrier_name, payer_id: read.payer_id } : null,
    });
  });

  // The person saved the policy from a card read: noted on the policy's history with what they corrected,
  // so the AI's part and the person's approval are both on record.
  r.post('/patients/:id/insurance-card/confirm', requirePermission('patients:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.params.id, pid, 'Patient');
    const policy = await findOr404(db, 'patient_insurance', req.body?.policy_id, pid, 'Policy');
    if (policy.patient_id !== patient.id) throw new HttpError(400, 'That policy belongs to another patient');
    const readRow = await db.get("SELECT id, details FROM audit_log WHERE id = ? AND practice_id = ? AND action = 'insurance_card.ai_read' AND entity_id = ?", Number(req.body?.read_id), pid, patient.id);
    if (!readRow) throw new HttpError(404, 'Card read not found');
    const { proposed = {}, sandbox = false } = JSON.parse(readRow.details || '{}');
    const corrected = ['carrier_id', 'subscriber_name', 'subscriber_id', 'subscriber_dob', 'relationship', 'group_number', 'effective_date']
      .filter((k) => proposed[k] !== undefined && String(proposed[k] ?? '') !== String(policy[k] ?? ''));
    await audit(db, req, 'insurance.ai_card_confirmed', 'patient_insurance', policy.id, { read_id: readRow.id, corrected, sandbox, patient_id: patient.id }, {
      reason: `Entered from a card photo read by AI; checked and saved by ${req.user.name}${corrected.length ? ` (corrected ${corrected.join(', ')})` : ''}`,
    });
    res.json({ ok: true, corrected });
  });

  // New insurance a patient sent from the portal, entered in one step: the carrier matched (or added), the
  // policy created, and the update marked done. A patient who already has primary insurance needs replace:
  // true (the old primary is made inactive — kept, not deleted).
  r.post('/insurance-updates/:uid/apply', requirePermission('billing:write'), async (req, res) => {
    requireHuman('entering insurance');
    const pid = req.user.practice_id;
    const u = await findOr404(db, 'insurance_updates', req.params.uid, pid, 'Insurance update');
    if (u.status !== 'pending') throw new HttpError(409, 'That insurance update was already entered');
    if (!u.carrier_name || !u.member_id) throw new HttpError(422, 'The patient didn’t type the insurance company and member ID — read the card photo instead', { needs_card_read: true });
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', u.patient_id);
    const relationship = ['self', 'spouse', 'child', 'other'].includes(u.relationship) ? u.relationship : 'self';
    const subscriberDob = isRealDate(u.subscriber_dob) ? u.subscriber_dob : relationship === 'self' ? patient.dob : null;
    const current = await db.get("SELECT pi.id, pi.carrier_id, pi.subscriber_id, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.patient_id = ? AND pi.active = 1 AND pi.priority = 'primary' ORDER BY pi.id LIMIT 1", patient.id);
    const out = await db.tx(async () => {
      // Claimed first, so a double click or a second person can't enter it twice.
      const took = await db.run("UPDATE insurance_updates SET status = 'reviewed', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'", req.user.id, u.id);
      if (!took.changes) throw new HttpError(409, 'That insurance update was already entered');
      let carrier = await matchCarrier(db, pid, { carrier_name: u.carrier_name });
      let carrierCreated = false;
      if (!carrier) {
        const id = await insert(db, 'insurance_carriers', { practice_id: pid, name: u.carrier_name });
        carrier = { id, name: u.carrier_name };
        carrierCreated = true;
        await audit(db, req, 'carrier.create', 'insurance_carriers', id, { from: 'portal insurance update', update_id: u.id });
      }
      // The same card entered already: nothing new to add.
      if (current && current.carrier_id === carrier.id && String(current.subscriber_id).replace(/\s/g, '') === u.member_id.replace(/\s/g, '')) return { policyId: current.id, carrier, carrierCreated, same: true };
      if (current && req.body?.replace !== true) throw new HttpError(409, `They already have ${current.carrier_name} as primary insurance. Replace it with ${u.carrier_name}?`, { replaces: current.carrier_name });
      if (current) await recorded(db, 'patient_insurance', current.id, () => db.run('UPDATE patient_insurance SET active = 0 WHERE id = ?', current.id));
      const policyId = await savePolicy(db, pid, null, {
        patient_id: patient.id, carrier_id: carrier.id, priority: 'primary', subscriber_name: u.subscriber_name || `${patient.first_name} ${patient.last_name}`,
        subscriber_id: u.member_id, subscriber_dob: subscriberDob, relationship, group_number: u.group_number || null,
      });
      return { policyId, carrier, carrierCreated, replaced: current?.id ?? null };
    });
    await audit(db, req, 'insurance_update.apply', 'patient_insurance', out.policyId, {
      update_id: u.id, carrier_created: out.carrierCreated, replaced_policy_id: out.replaced ?? null, already_on_file: !!out.same, patient_id: patient.id,
    }, { reason: 'Entered from the insurance the patient sent through the portal' });
    res.status(out.same ? 200 : 201).json({ policy: await db.get('SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.id = ?', out.policyId), carrier_created: out.carrierCreated, replaced_policy_id: out.replaced ?? null, already_on_file: !!out.same });
  });

  return r;
}
