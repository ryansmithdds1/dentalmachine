import { HttpError } from './auth.js';

// Patient message templates. Practices can override any of these in Settings → Messages.
// Each lists the merge fields it can use; the ones in `required` must stay in (the link, usually).
export const TEMPLATE_META = {
  reminder: {
    label: 'Appointment reminder', help: 'Sent before each visit on the reminder schedule.', vars: ['first_name', 'practice', 'when', 'provider', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, this is {practice} reminding you of your appointment on {when} with {provider}. Please confirm: {link}',
  },
  booking_confirmation: {
    label: 'Booking confirmation', help: 'When an online request is accepted.', vars: ['first_name', 'practice', 'when', 'provider', 'link', 'phone'], required: [],
    text: "Hi {first_name}, you're booked at {practice} on {when} with {provider}. Details or changes: {link}",
  },
  booking_declined: {
    label: 'Online request declined', help: 'When the office declines an online booking request. {reason} is what staff type, if anything.', vars: ['first_name', 'practice', 'when', 'reason', 'phone'], required: [],
    text: "Hi {first_name}, we couldn't confirm your requested time ({when}) at {practice}. {reason} Please call us at {phone} to find another time.",
  },
  recall: {
    label: 'Recall', help: 'Recall reminders and recall sequences.', vars: ['first_name', 'practice', 'phone', 'link'], required: [],
    text: "Hi {first_name}, it's time for your next checkup and cleaning at {practice}. Call us at {phone} to schedule. {link}",
  },
  forms: {
    label: 'Forms to fill in', help: 'The link to health history, consents and other forms.', vars: ['first_name', 'practice', 'forms', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, please complete {forms} for {practice} before your visit: {link}',
  },
  treatment_plan: {
    label: 'Treatment plan to review', help: 'The link to review and e-sign a treatment plan.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, here is the treatment plan we discussed at {practice}, with your estimated costs. Review and sign here: {link}',
  },
  payment_link: {
    label: 'Payment link', help: 'Sent with a link to pay a balance online.', vars: ['first_name', 'practice', 'amount', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, you can pay your {practice} balance of {amount} securely online: {link}',
  },
  card_setup: {
    label: 'Save a card', help: 'Link to save a card for a payment plan or membership.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, {practice} can charge your payments automatically. Add your card securely here: {link}',
  },
  card_declined: {
    label: 'Automatic payment declined', help: 'When a payment plan or membership charge is declined.', vars: ['first_name', 'practice', 'amount', 'reason', 'phone'], required: [],
    text: "Hi {first_name}, the {amount} payment to {practice} didn't go through ({reason}). Please call us at {phone} to update your card.",
  },
  review: {
    label: 'Review request', help: 'After a visit. The link asks how the visit went: happy patients are sent on to your review page, others can tell you privately.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Thanks for visiting {practice} today, {first_name}! How did we do? {link}',
  },
};
export const DEFAULT_TEMPLATES = Object.fromEntries(Object.entries(TEMPLATE_META).map(([k, m]) => [k, m.text]));

export function templatesFor(practice) {
  let custom = {};
  try {
    custom = practice?.message_templates ? JSON.parse(practice.message_templates) : {};
  } catch {
    custom = {};
  }
  return { ...DEFAULT_TEMPLATES, ...Object.fromEntries(Object.entries(custom).filter(([k, v]) => k in DEFAULT_TEMPLATES && v)) };
}

export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+/g, ' ').trim();
}

export function validateTemplates(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!obj || typeof obj !== 'object') throw new HttpError(400, 'message_templates must be an object');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULT_TEMPLATES)) throw new HttpError(400, `Unknown template ${k}`);
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || v.length > 600) throw new HttpError(400, `${k} template must be text up to 600 characters`);
    for (const need of TEMPLATE_META[k].required) if (!v.includes(`{${need}}`)) throw new HttpError(400, `${TEMPLATE_META[k].label} must include {${need}}`);
    const unknown = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !TEMPLATE_META[k].vars.includes(x));
    if (unknown.length) throw new HttpError(400, `${TEMPLATE_META[k].label} can't use {${unknown[0]}} — it can use ${TEMPLATE_META[k].vars.map((x) => `{${x}}`).join(' ')}`);
    out[k] = v;
  }
  return JSON.stringify(out);
}

const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

// The practice's wording for one automated message, filled in. Amounts are in cents.
export async function messageText(db, practiceId, key, vars = {}) {
  const practice = await db.get('SELECT name, phone, message_templates FROM practices WHERE id = ?', practiceId);
  return renderTemplate(templatesFor(practice)[key], {
    practice: practice.name, phone: practice.phone || 'the office', ...vars, ...(vars.amount != null ? { amount: dollars(vars.amount) } : {}),
  });
}
