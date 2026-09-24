import { currentActor, setActor } from './actor.js';
import { HttpError } from './auth.js';

// The AI may suggest anything, but it may not do something high-risk on its own: money, claims, signing,
// prescribing, merging charts, insurance details and removals need a person's yes. A request the assistant
// makes carries X-Acting-For: assistant; one the person approved on screen also carries X-Human-Approved.
// Without it, a high-risk change is refused (428) — whatever path the AI took to get here. The approval is
// written into the audit trail with the change.
export const HIGH_RISK = [
  ['POST', /^\/patients\/\d+\/(payments|refunds|adjustments|terminal-payments|transfer|prescriptions|merge|insurance|payment-plans)$/, 'money, prescriptions, merges and insurance'],
  ['POST', /^\/ledger\/\d+\/void$/, 'voiding a charge or payment'],
  ['POST', /^\/payment-plans\/\d+\/charge-now$/, 'charging a card'],
  ['POST', /^\/claims(\/submit|\/837|\/\d+\/(submit|void|payment|deny|correct|reopen|appeal))?$/, 'claims'],
  ['PUT', /^\/claims\/\d+$/, 'claims'],
  ['POST', /^\/insurance-checks$/, 'posting insurance payments'],
  ['POST', /^\/collections\/\d+\/(write-off|agency)$/, 'collections'],
  ['POST', /^\/procedures\/\d+\/(complete|uncomplete)$/, 'completing procedures (posts charges)'],
  ['POST', /^\/notes\/\d+\/sign$/, 'signing clinical notes'],
  ['POST', /^\/statements\/run$/, 'sending statements'],
  ['PUT', /^\/(insurance|insurance-plans|payment-plans)\/\d+$/, 'insurance and payment plans'],
  ['PUT', /^\/patients\/\d+\/medical$/, 'changing the medical history'],
  ['POST', /^\/insurance-updates\/\d+\/apply$/, 'insurance'],
  ['POST', /^\/org\/role-templates\/\d+\/apply$/, 'changing permissions across the group'],
  ['PUT', /^\/org\/role-templates\/\d+$/, 'changing permissions across the group'],
  ['POST', /^\/timeclock\/(punches(\/\d+\/(correct|void))?|period\/(approve|unlock)|pto\/(\d+\/decide|adjust)|kiosks)$/, 'payroll time, approvals and time off'],
  ['PUT', /^\/timeclock\/(punches\/\d+|staff\/\d+|settings)$/, 'payroll time, pay rates and rules'],
  ['POST', /^\/checklists\/(flags\/\d+\/resolve|occurrences\/\d+\/correct)$/, 'checklist corrective actions and corrections'],
  ['POST', /^\/optimizer\/\d+\/(act|undo)$/, 'booking, changing visits or texting patients from the schedule optimizer'],
  ['POST', /^\/lab-checkin(\/\d+\/lab-message)?$/, 'checking in lab work and asking the lab for a remake'],
  ['POST', /^\/business\/(cost-profiles(\/bulk)?|provider-pay)$/, 'procedure costs and provider pay plans'],
  ['PUT', /^\/business\/(settings|staff-roles\/\d+|exam-targets)$/, 'business view settings'],
  ['POST', /^\/treatment-plans\/\d+\/fin-accept$/, 'accepting a payment option (payment plans, discounts, financing)'],
  ['POST', /^\/fin-agreements\/\d+\/(prepay|reverse-discount|cancel)$/, 'prepayments, discounts and payment agreements'],
  ['PUT', /^\/fin-options\/settings$/, 'discount and financing rules'],
  ['POST', /^\/referral-tracker\/matches\/\d+\/confirm$/, 'confirming a specialist report for a referral'],
  ['POST', /^\/daily-deposits(\/\d+\/(verify|reopen|bank-note))?$/, 'deposits'],
  ['POST', /^\/cash\/(sessions\/\d+\/(count|verify)|drawers(\/\d+\/open)?)$/, 'cash drawers'],
  ['POST', /^\/patients\/\d+\/insurance-card\/confirm$/, 'insurance'],
  // Insurance autopilot: posting remittances, a person's decisions on them, and the owner's auto-post/billing switches.
  ['POST', /^\/(era\/import|clearinghouse\/responses)$/, 'posting insurance payments'],
  ['POST', /^\/eob-autopilot\/(post-ready|paper\/\d+\/post|lines\/\d+\/\w+|claims\/\d+\/send-secondary)$/, 'posting insurance payments and claims'],
  ['PUT', /^\/eob-autopilot\/settings$/, 'insurance auto-posting and patient billing rules'],
  ['POST', /^\/fees\/(increases|changes\/\d+\/(approve|cancel))$/, 'fee changes'],
  ['PUT', /^\/fees\/changes\/\d+$/, 'fee changes'],
  ['PUT', /^\/(fee-schedules|procedure-codes)\/\d+$/, 'fee changes'],
  ['POST', /^\/daily\/preauths\/\d+\/send$/, 'claims'],
  ['POST', /^\/claim-queue\/(approve|approve-all|skip)$/, 'approving or skipping prepared claims'],
  ['POST', /^\/billing\/(setup|replace-card|recurring\/\d+\/charge-now|dunning\/\d+\/(retry|resume)|fees(\/\d+\/apply)?|fee-charges\/\d+\/waive|authorizations\/\d+\/revoke)$/, 'setting up automatic payments, charging cards and office fees'],
  ['PUT', /^\/billing\/(settings|fees\/\d+)$/, 'card surcharges and office fees'],
  ['POST', /^\/benchmarks\/(join|leave|send-now)$/, 'sharing practice numbers outside the practice'],
  ['PUT', /^\/benchmarks\/providers\/\d+\/name$/, 'showing a provider’s name to other practices'],
  ['POST', /^\/bonus\/(plans(\/\d+\/status)?|periods\/(approve|\d+\/reopen))$/, 'bonus plans and approving bonuses'],
  ['PUT', /^\/bonus\/(settings|plans\/\d+)$/, 'bonus plans and approving bonuses'],
  ['PATCH', /^\/ai-findings\/\d+$/, 'charting or dismissing an AI x-ray finding (a diagnosis)'],
  ['POST', /^\/provider-out$/, 'moving or cancelling a whole column of visits (provider out)'],
  ['POST', /^\/txfollow\/letters(\/\d+)?\/approve$/, 'sending a doctor’s letter to a patient'],
  ['POST', /^\/marketing\/costs(\/\d+\/void)?$/, 'marketing costs'],
  ['PUT', /^\/marketing\/patients\/\d+\/attribution$/, 'where a patient came from'],
  ['POST', /^\/verification\/(policies\/\d+\/phone|reads\/\d+\/confirm|reviews\/\d+\/apply)$/, 'insurance benefits for everyone on a plan'],
  ['DELETE', /./, 'removing records'],
];

export const riskOf = (method, path, body) => {
  // Adding procedures is fine; adding them as already completed posts charges.
  if (method === 'POST' && /^\/patients\/\d+\/procedures$/.test(path) && body?.complete) return 'completing procedures (posts charges)';
  return HIGH_RISK.find(([m, re]) => m === method && re.test(path))?.[2] || null;
};

// The same rule inside the code that moves money or posts charges, for AI that doesn't come through a
// request (a server-side agent): it can suggest, not do.
export function requireHuman(what) {
  const ctx = currentActor();
  if (ctx?.source === 'ai' && !ctx.approvedBy) {
    throw new HttpError(428, `The AI can’t do this without a person’s OK (${what})`);
  }
}

export function aiGuard() {
  return (req, res, next) => {
    const ctx = currentActor();
    if (ctx?.source !== 'ai') return next();
    const risk = riskOf(req.method, req.path, req.body);
    if (!risk) return next();
    if (req.get('X-Human-Approved') !== '1') {
      return res.status(428).json({ error: `The assistant can’t do this without your OK (${risk}). Confirm it, or do it yourself.`, needs_approval: true });
    }
    setActor({ actor: `Assistant (for ${req.user.name}, approved by ${req.user.name})`, approvedBy: req.user.id });
    next();
  };
}
