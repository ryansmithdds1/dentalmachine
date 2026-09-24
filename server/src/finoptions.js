import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';

// Financial options for a treatment plan (F3): pay in full with a prepay discount, the office's own payment
// plan, outside lenders' promotional terms, membership pricing and PPO in-network savings — side by side.
// Everything here is pure arithmetic on integer cents, so the numbers a patient sees can be recomputed and
// compared to the cent (routes/finoptions.js stores exactly what was shown with the acceptance).
//
// Rounding rules (tested in test/finoptions.test.js):
// - A regular payment is rounded UP to the cent (0%: ceil(amount / months); with interest: the standard
//   annuity payment, rounded half-up), and the LAST payment absorbs whatever is left — so the payments
//   always add up to exactly what is owed, never a cent more or less.
// - With interest, each month's interest is the balance × APR/12 rounded half-up to the cent.
// - Percentages are applied in basis points and rounded half-up: 5% of $1,234.57 is $61.73.

export const MAX_MONTHS = 120;
const MAX_CENTS = 1_000_000_000;

export const cents = (n, name = 'amount') => {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CENTS) throw new HttpError(400, `${name} must be a whole number of cents from 0 to ${MAX_CENTS}`);
  return n;
};
const bps = (pct) => Math.round(Number(pct) * 100);
// pct% of an amount, half-up, in integer arithmetic.
export const pctOf = (amount, pct) => Math.floor((cents(amount) * bps(pct) + 5000) / 10000);

// Monthly payments for a principal at an APR over a number of months (fixed, equal payments).
export function amortize(principal, aprPct, months) {
  cents(principal, 'principal');
  const apr = Number(aprPct);
  if (!Number.isFinite(apr) || apr < 0 || apr > 100) throw new HttpError(400, 'APR must be 0-100%');
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new HttpError(400, `months must be 1-${MAX_MONTHS}`);
  if (principal === 0) return { payment: 0, last: 0, payments: [], total: 0, interest: 0 };
  if (principal < months) throw new HttpError(400, 'The amount is too small to split over that many months');
  const r = apr / 1200;
  let payment = r === 0 ? Math.ceil(principal / months) : Math.round((principal * r) / (1 - (1 + r) ** -months));
  // Rounding up must never leave the last payment at zero or below (e.g. 13¢ over 8 months).
  if (r === 0 && payment * (months - 1) >= principal) payment = Math.floor(principal / months);
  const payments = [];
  let balance = principal;
  let interest = 0;
  for (let i = 0; i < months; i++) {
    const due = Math.round(balance * r);
    interest += due;
    const amount = i === months - 1 ? balance + due : Math.min(payment, balance + due);
    payments.push(amount);
    balance = balance + due - amount;
  }
  if (payments.some((p) => p <= 0)) throw new HttpError(400, 'The amount is too small to split over that many months');
  const total = payments.reduce((s, p) => s + p, 0);
  return { payment: payments[0], last: payments[payments.length - 1], payments, total, interest };
}

// ---- Office settings (F5) ----
export const LENDER_KEYS = ['carecredit', 'sunbit', 'cherry', 'proceed', 'lendingclub', 'other'];
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  show: { pay_in_full: true, in_office: true, lenders: true, membership: true, ppo_savings: true },
  // Most PPO contracts allow a prompt-pay discount on the patient's share; some offices only give it to self-pay patients.
  prepay: { pct: 5, allowed: 'always', min_amount: 50000, max_discount: null },
  max_discount_pct: 10,
  max_apr: 18,
  in_office: { months: [3, 6, 12], apr: 0, setup_fee: 0, min_down_pct: 20, min_down: 0, min_amount: 50000, max_months: 12, first_payment_days: 30 },
  // Promotional terms per lender. Only shown when the office has the lender's application link (Settings → Financing)
  // or an apply_url here. Check them against your merchant agreement: they change.
  lenders: [
    { lender: 'carecredit', label: 'No interest if paid in full in 6 months', months: 6, apr: 0, type: 'deferred', standard_apr: 32.99, min_amount: 20000, max_amount: null, apply_url: null, enabled: true },
    { lender: 'carecredit', label: 'No interest if paid in full in 12 months', months: 12, apr: 0, type: 'deferred', standard_apr: 32.99, min_amount: 20000, max_amount: null, apply_url: null, enabled: true },
    { lender: 'carecredit', label: '24 months at 17.90% APR', months: 24, apr: 17.9, type: 'fixed', standard_apr: null, min_amount: 100000, max_amount: null, apply_url: null, enabled: true },
    { lender: 'carecredit', label: '48 months at 17.90% APR', months: 48, apr: 17.9, type: 'fixed', standard_apr: null, min_amount: 250000, max_amount: null, apply_url: null, enabled: true },
  ],
});

const num = (v, name, { min = 0, max = MAX_CENTS, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new HttpError(400, `${name} must be ${int ? 'a whole number ' : ''}from ${min} to ${max}`);
  return n;
};
const optCents = (v, name) => (v == null || v === '' ? null : cents(Number(v), name));

// Validates the owner's settings and enforces the guardrails: discounts within the cap, APRs within the
// office's interest rule, months within the maximum. Returns a complete, clean settings object.
export function cleanSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  const i = input || {};
  const show = Object.fromEntries(Object.keys(d.show).map((k) => [k, i.show?.[k] === undefined ? d.show[k] : !!i.show[k]]));
  const maxDiscount = num(i.max_discount_pct ?? d.max_discount_pct, 'Maximum discount %', { max: 50 });
  const maxApr = num(i.max_apr ?? d.max_apr, 'Maximum APR', { max: 36 });
  const p = { ...d.prepay, ...(i.prepay || {}) };
  const prepay = {
    pct: num(p.pct, 'Prepay discount %', { max: 50 }),
    allowed: ['always', 'self_pay', 'never'].includes(p.allowed) ? p.allowed : (() => { throw new HttpError(400, 'Prepay discount: allowed must be always, self_pay or never'); })(),
    min_amount: cents(Number(p.min_amount ?? 0), 'Prepay minimum'),
    max_discount: optCents(p.max_discount, 'Largest prepay discount'),
  };
  if (prepay.pct > maxDiscount) throw new HttpError(400, `The prepay discount (${prepay.pct}%) is above your maximum discount (${maxDiscount}%)`);
  const o = { ...d.in_office, ...(i.in_office || {}) };
  const maxMonths = num(o.max_months, 'Longest payment plan (months)', { min: 1, max: 60, int: true });
  const months = [...new Set((Array.isArray(o.months) ? o.months : String(o.months).split(/[\s,]+/)).filter((m) => m !== '').map((m) => num(m, 'Payment plan months', { min: 1, max: 60, int: true })))].sort((a, b) => a - b);
  if (months.some((m) => m > maxMonths)) throw new HttpError(400, `Payment plan months can't be longer than ${maxMonths}`);
  if (months.length > 6) throw new HttpError(400, 'Offer at most 6 payment plan lengths');
  const in_office = {
    months, max_months: maxMonths,
    apr: num(o.apr, 'Payment plan APR', { max: maxApr }),
    setup_fee: cents(Number(o.setup_fee ?? 0), 'Payment plan set-up fee'),
    min_down_pct: num(o.min_down_pct, 'Minimum down payment %', { max: 100 }),
    min_down: cents(Number(o.min_down ?? 0), 'Minimum down payment'),
    min_amount: cents(Number(o.min_amount ?? 0), 'Payment plan minimum'),
    first_payment_days: num(o.first_payment_days, 'Days to the first payment', { min: 0, max: 90, int: true }),
  };
  const lenders = (Array.isArray(i.lenders) ? i.lenders : d.lenders).map((l, n) => {
    const at = `Lender term ${n + 1}`;
    if (!LENDER_KEYS.includes(l?.lender)) throw new HttpError(400, `${at}: choose a lender (${LENDER_KEYS.join(', ')})`);
    const type = l.type === 'deferred' ? 'deferred' : l.type === 'fixed' ? 'fixed' : (() => { throw new HttpError(400, `${at}: type must be deferred or fixed`); })();
    const url = l.apply_url ? String(l.apply_url).trim() : null;
    if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new HttpError(400, `${at}: the apply link must start with https://`);
    const term = {
      lender: l.lender, label: String(l.label || '').trim().slice(0, 80) || `${l.months} months`,
      months: num(l.months, `${at}: months`, { min: 1, max: MAX_MONTHS, int: true }),
      apr: type === 'deferred' ? 0 : num(l.apr ?? 0, `${at}: APR`, { max: 36 }),
      type, standard_apr: l.standard_apr == null || l.standard_apr === '' ? null : num(l.standard_apr, `${at}: standard APR`, { max: 40 }),
      min_amount: cents(Number(l.min_amount ?? 0), `${at}: minimum`), max_amount: optCents(l.max_amount, `${at}: maximum`),
      apply_url: url, enabled: l.enabled !== false,
    };
    if (type === 'deferred' && term.standard_apr == null) throw new HttpError(400, `${at}: a deferred-interest promotion needs the standard APR that applies if it isn't paid off in time`);
    return term;
  });
  if (lenders.length > 16) throw new HttpError(400, 'At most 16 lender terms');
  return { version: 1, show, prepay, max_discount_pct: maxDiscount, max_apr: maxApr, in_office, lenders };
}

// The settings stored on the practice (JSON), or the defaults.
export function readSettings(raw) {
  try { return cleanSettings(raw ? JSON.parse(raw) : {}); } catch { return cleanSettings({}); }
}

// ---- Each option ----
// Pay in full: the prepay discount when the office allows it here. `otherDiscountPct` is any discount already
// on the plan (the plan discount): together they never pass the office's maximum.
export function payInFull(amount, settings, { insured = false, otherDiscountPct = 0 } = {}) {
  cents(amount);
  const p = settings.prepay;
  const allowed = p.allowed === 'always' || (p.allowed === 'self_pay' && !insured);
  const room = Math.max(0, settings.max_discount_pct - (Number(otherDiscountPct) || 0));
  const pct = allowed && amount >= p.min_amount ? Math.min(p.pct, room) : 0;
  let discount = pct > 0 ? pctOf(amount, pct) : 0;
  if (p.max_discount != null) discount = Math.min(discount, p.max_discount);
  const total = amount - discount;
  return { kind: 'full', key: 'full', title: 'Pay in full', total, due_today: total, monthly: null, months: null, discount, discount_pct: discount ? pct : 0, amount };
}

// In-office plan: the down payment (at least the office minimum), then equal monthly payments.
export function inOffice(amount, settings, months, { downPayment = null } = {}) {
  cents(amount);
  const o = settings.in_office;
  const minDown = Math.min(amount, Math.max(o.min_down, Math.ceil((amount * bps(o.min_down_pct)) / 10000)));
  const down = downPayment == null ? minDown : cents(downPayment, 'Down payment');
  if (down < minDown) throw new HttpError(400, `The down payment must be at least $${(minDown / 100).toFixed(2)}`);
  if (down >= amount) throw new HttpError(400, 'The down payment must be less than the amount');
  if (months > o.max_months) throw new HttpError(400, `Payment plans can be at most ${o.max_months} months`);
  const financed = amount - down + o.setup_fee;
  const a = amortize(financed, o.apr, months);
  const financeCharge = a.total - (amount - down);
  return {
    kind: 'in_office', key: `office-${months}`, title: `${months} monthly payments`, months, apr: o.apr, down_payment: down, setup_fee: o.setup_fee,
    financed, monthly: a.payment, last_payment: a.last, payments: a.payments, finance_charge: financeCharge,
    total: down + a.total, due_today: down, amount,
  };
}

export function inOfficeOptions(amount, settings) {
  if (!settings.show.in_office || amount < Math.max(settings.in_office.min_amount, 1)) return [];
  return settings.in_office.months.filter((m) => m <= settings.in_office.max_months).flatMap((m) => {
    try { return [inOffice(amount, settings, m)]; } catch { return []; }
  });
}

// An outside lender's promotion. Deferred interest: no interest if paid off in the promo period — the monthly
// shown is what pays it off in time. Fixed: equal payments at the promo APR. The lender pays the office, so
// nothing is due today.
export function lenderOption(amount, term, applyUrl) {
  cents(amount);
  const a = amortize(amount, term.type === 'deferred' ? 0 : term.apr, term.months);
  const notes = term.type === 'deferred'
    ? [`No interest if paid in full within ${term.months} months. If not, interest at ${term.standard_apr}% APR is charged from the purchase date.`]
    : [`${term.apr}% APR, ${term.months} equal payments${term.apr ? ` (includes $${((a.total - amount) / 100).toFixed(2)} interest)` : ''}.`];
  return {
    kind: 'lender', key: `lender-${term.lender}-${term.months}-${term.type}`, lender: term.lender, title: term.label, months: term.months, apr: a.total > amount ? term.apr : 0,
    promo_type: term.type, standard_apr: term.standard_apr, monthly: a.payment, last_payment: a.last, total: a.total, due_today: 0, amount, apply_url: applyUrl, notes,
  };
}

// Membership pricing for a patient without insurance: what the plan's included services and discount take
// off this treatment (the same rules as memberships.js memberBenefit), plus a year of membership.
export function membershipOption(items, plan) {
  const included = (() => { try { return JSON.parse(plan.included || '[]'); } catch { return []; } })();
  const used = new Map();
  let savings = 0;
  for (const it of items) {
    const share = cents(it.patient, 'patient share');
    if (share <= 0) continue;
    const rule = included.find((r) => r.codes.some((c) => String(it.code).startsWith(c)));
    const key = rule ? rule.codes.join() : null;
    if (rule && (used.get(key) || 0) < rule.per_year) {
      used.set(key, (used.get(key) || 0) + 1);
      savings += share;
    } else if (plan.discount_pct > 0) savings += pctOf(share, plan.discount_pct);
  }
  const amount = items.reduce((s, it) => s + it.patient, 0);
  const yearCost = plan.interval === 'month' ? plan.price * 12 : plan.price;
  return {
    kind: 'membership', key: `member-${plan.id}`, plan_id: plan.id, title: `${plan.name} membership`, savings, year_cost: yearCost,
    treatment_total: amount - savings, total: amount - savings + yearCost, due_today: plan.price, monthly: plan.interval === 'month' ? plan.price : null,
    months: plan.interval === 'month' ? 12 : null, net_savings: savings - yearCost, amount,
  };
}

// PPO in-network savings: the office fee less what the PPO allows (the contractual write-off).
export const ppoSavings = (estimate) => (estimate?.policy && estimate.total_write_off > 0 ? estimate.total_write_off : 0);

// Every option to show, in a fixed order. `amount` is the patient's estimated share (after insurance and any
// plan or membership discount already on the plan).
export function buildOptions({ amount, items = [], settings, insured = false, otherDiscountPct = 0, lenderLinks = {}, membershipPlans = [], isMember = false }) {
  cents(amount);
  const out = [];
  if (amount <= 0) return out;
  if (settings.show.pay_in_full) out.push(payInFull(amount, settings, { insured, otherDiscountPct }));
  out.push(...inOfficeOptions(amount, settings));
  if (settings.show.lenders) {
    for (const t of settings.lenders) {
      const url = t.apply_url || lenderLinks[t.lender] || null;
      if (!t.enabled || !url || amount < t.min_amount || (t.max_amount != null && amount > t.max_amount) || amount < t.months) continue;
      out.push(lenderOption(amount, t, url));
    }
  }
  if (settings.show.membership && !insured && !isMember) {
    for (const plan of membershipPlans) {
      const m = membershipOption(items, plan);
      if (m.net_savings > 0) out.push(m);
    }
  }
  const seen = new Set();
  return out.filter((o) => (seen.has(o.key) ? false : seen.add(o.key)));
}

// A stable fingerprint of what was shown: the same numbers always hash the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex');

// Due dates for monthly payments starting on a date (the 31st becomes the month's last day).
export function monthlyDates(start, n) {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + i, Math.min(d, last))).toISOString().slice(0, 10);
  });
}
