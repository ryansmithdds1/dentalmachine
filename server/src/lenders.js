import { createHmac, timingSafeEqual } from 'node:crypto';

// Patient financing lenders. Each office has its own merchant account and application link with each
// lender; applications are sent to the patient, and the lender reports back (approved, declined, funded)
// through its webhook when the office has an API partnership, or staff record it from the lender's portal.
//   LENDERS_SANDBOX=on      pretend lenders (for demos: applications can be moved along from the app)
//   <LENDER>_WEBHOOK_SECRET  signs the lender's status callbacks (HMAC-SHA256 of the raw body, hex)
export const LENDERS = {
  carecredit: { name: 'CareCredit', method: 'care_credit', apply: 'https://www.carecredit.com/apply/', note: 'Promotional financing on the CareCredit card' },
  sunbit: { name: 'Sunbit', method: 'financing', apply: 'https://sunbit.com/', note: 'Pay over time; high approval rates, soft credit check' },
  cherry: { name: 'Cherry', method: 'financing', apply: 'https://withcherry.com/', note: 'Instant approval with a soft credit check' },
  proceed: { name: 'Proceed Finance', method: 'financing', apply: 'https://www.proceedfinance.com/', note: 'Longer terms for larger treatment' },
  lendingclub: { name: 'LendingClub Patient Solutions', method: 'financing', apply: 'https://www.lendingclub.com/patientsolutions', note: 'Installment plans' },
};
export const STATUSES = ['sent', 'started', 'approved', 'declined', 'funded', 'cancelled', 'expired'];

// The office's application link for a lender (from Settings → Financing), with the amount where the
// lender's link accepts one.
export function applicationLink(practiceFinancing, lender, amount) {
  let f = {};
  try { f = practiceFinancing ? JSON.parse(practiceFinancing) : {}; } catch { f = {}; }
  const own = (f.links || []).find((l) => l.name && (l.lender === lender || l.name.toLowerCase().replace(/[^a-z]/g, '').startsWith(lender.slice(0, 5))));
  const base = own?.url || null;
  if (!base) return null;
  const u = new URL(base);
  if (amount && !u.searchParams.has('amount')) u.searchParams.set('amount', (amount / 100).toFixed(2));
  return u.toString();
}

export function verifyLenderSignature(lender, raw, signature, env = process.env) {
  const secret = env[`${lender.toUpperCase()}_WEBHOOK_SECRET`];
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(String(signature).replace(/^sha256=/, ''));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
