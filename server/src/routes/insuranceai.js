import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit } from '../util.js';
import { structured } from '../ai.js';
import { PLAN_BENEFITS } from '../benefits.js';

// Reading insurance paperwork with AI, so nobody retypes it:
//  - a benefit summary (the payer portal's page saved as PDF or a screenshot, a fax, or the free-text notes in
//    an eligibility response) becomes the plan's breakdown: maximums, percentages, frequencies, waiting
//    periods, downgrades, age limits, missing-tooth clause — shown next to what's on file, applied by a person;
//  - a paper EOB (or a check's remittance) becomes a filled-in insurance check: each claim found, matched to
//    ours, with what was paid and written off per procedure — posted by a person through the usual check entry.
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
    const pid = req.user.practice_id;
    const out = await structured(config, { system: EOB_SYSTEM, tool: EOB_TOOL, effort: 'medium', maxTokens: 16000, content: [...fileContent(req.body), { type: 'text', text: 'Read this EOB.' }] });
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
    await audit(db, req, 'eob.ai_read', 'claims', null, { claims: claims.length, matched: claims.filter((c) => c.claim_id).length });
    res.json({
      payer_name: out.payer_name || null, carrier_id: carrier?.id ?? null, check_number: out.check_number || null, check_date: out.check_date || null,
      amount: toCents(out.total_paid), method: out.method === 'eft' ? 'eft' : 'check',
      provider_adjustments: (out.provider_adjustments || []).map((a) => ({ reason: a.reason || 'Other', amount: toCents(a.amount) })), claims,
      totals_match: toCents(out.total_paid) === claims.reduce((s, c) => s + c.paid, 0) - (out.provider_adjustments || []).reduce((s, a) => s + (toCents(a.amount) || 0), 0),
    });
  });

  return r;
}
