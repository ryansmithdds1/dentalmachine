import { HttpError } from './auth.js';

// Patient message templates. Practices can override any of these in Settings → Messages.
// Each lists the merge fields it can use; the ones in `required` must stay in (the link, usually).
export const TEMPLATE_META = {
  reminder: {
    label: 'Appointment reminder', help: 'Sent before each visit on the reminder schedule.', vars: ['first_name', 'practice', 'when', 'provider', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, this is {practice} reminding you of your appointment on {when} with {provider}. Please confirm: {link}',
    es: 'Hola {first_name}, le recordamos de {practice} su cita el {when} con {provider}. Por favor confirme: {link}',
  },
  booking_confirmation: {
    label: 'Booking confirmation', help: 'When an online request is accepted.', vars: ['first_name', 'practice', 'when', 'provider', 'link', 'phone'], required: [],
    text: "Hi {first_name}, you're booked at {practice} on {when} with {provider}. Details or changes: {link}",
    es: 'Hola {first_name}, su cita en {practice} quedó para el {when} con {provider}. Detalles o cambios: {link}',
  },
  booking_declined: {
    label: 'Online request declined', help: 'When the office declines an online booking request. {reason} is what staff type, if anything.', vars: ['first_name', 'practice', 'when', 'reason', 'phone'], required: [],
    text: "Hi {first_name}, we couldn't confirm your requested time ({when}) at {practice}. {reason} Please call us at {phone} to find another time.",
    es: 'Hola {first_name}, no pudimos confirmar el horario que pidió ({when}) en {practice}. {reason} Llámenos al {phone} para buscar otro horario.',
  },
  recall: {
    label: 'Recall', help: 'Recall reminders and recall sequences.', vars: ['first_name', 'practice', 'phone', 'link'], required: [],
    text: "Hi {first_name}, it's time for your next checkup and cleaning at {practice}. Call us at {phone} to schedule. {link}",
    es: 'Hola {first_name}, ya le toca su próximo chequeo y limpieza en {practice}. Llámenos al {phone} para hacer su cita. {link}',
  },
  forms: {
    label: 'Forms to fill in', help: 'The link to health history, consents and other forms.', vars: ['first_name', 'practice', 'forms', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, please complete {forms} for {practice} before your visit: {link}',
    es: 'Hola {first_name}, por favor complete {forms} para {practice} antes de su visita: {link}',
  },
  treatment_plan: {
    label: 'Treatment plan to review', help: 'The link to review and e-sign a treatment plan.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, here is the treatment plan we discussed at {practice}, with your estimated costs. Review and sign here: {link}',
    es: 'Hola {first_name}, aquí está el plan de tratamiento que hablamos en {practice}, con sus costos estimados. Revíselo y fírmelo aquí: {link}',
  },
  payment_link: {
    label: 'Payment link', help: 'Sent with a link to pay a balance online.', vars: ['first_name', 'practice', 'amount', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, you can pay your {practice} balance of {amount} securely online: {link}',
    es: 'Hola {first_name}, puede pagar su saldo de {amount} con {practice} en línea de forma segura: {link}',
  },
  card_setup: {
    label: 'Save a card', help: 'Link to save a card for a payment plan or membership.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Hi {first_name}, {practice} can charge your payments automatically. Add your card securely here: {link}',
    es: 'Hola {first_name}, {practice} puede cobrar sus pagos automáticamente. Agregue su tarjeta de forma segura aquí: {link}',
  },
  card_declined: {
    label: 'Automatic payment declined', help: 'When a payment plan or membership charge is declined.', vars: ['first_name', 'practice', 'amount', 'reason', 'phone'], required: [],
    text: "Hi {first_name}, the {amount} payment to {practice} didn't go through ({reason}). Please call us at {phone} to update your card.",
    es: 'Hola {first_name}, el pago de {amount} a {practice} no se procesó ({reason}). Llámenos al {phone} para actualizar su tarjeta.',
  },
  survey: {
    label: 'Patient survey', help: 'Surveys sent after visits or to a list (Campaigns → Surveys).', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: "Hi {first_name}, would you take a minute to tell {practice} how we're doing? {link}",
    es: 'Hola {first_name}, ¿nos regala un minuto para decirle a {practice} cómo lo estamos haciendo? {link}',
  },
  review: {
    label: 'Review request', help: 'After a visit. The link asks how the visit went: happy patients are sent on to your review page, others can tell you privately.', vars: ['first_name', 'practice', 'link', 'phone'], required: ['link'],
    text: 'Thanks for visiting {practice} today, {first_name}! How did we do? {link}',
    es: '¡Gracias por visitar {practice} hoy, {first_name}! ¿Cómo lo hicimos? {link}',
  },
};
export const DEFAULT_TEMPLATES = Object.fromEntries(Object.entries(TEMPLATE_META).map(([k, m]) => [k, m.text]));
export const LANGUAGES = { en: 'English', es: 'Español' };
// Custom Spanish wording is stored as "<key>_es" next to the English.
const SPANISH_DEFAULTS = Object.fromEntries(Object.entries(TEMPLATE_META).map(([k, m]) => [`${k}_es`, m.es]));
const baseKey = (k) => k.replace(/_es$/, '');

export function templatesFor(practice, lang = 'en') {
  let custom = {};
  try {
    custom = practice?.message_templates ? JSON.parse(practice.message_templates) : {};
  } catch {
    custom = {};
  }
  const pick = (k, v) => (lang === 'es' ? custom[`${k}_es`] || v : custom[k] || v);
  return Object.fromEntries(Object.entries(TEMPLATE_META).map(([k, m]) => [k, pick(k, lang === 'es' ? m.es : m.text)]));
}

// Words around the templates that aren't themselves editable.
export const FIXED_TEXT = {
  en: { sms_reply: ' Reply C to confirm, or call us to reschedule. Reply STOP to opt out.', the_office: 'the office' },
  es: { sms_reply: ' Responda C para confirmar, o llámenos para cambiar su cita. Responda STOP para no recibir mensajes.', the_office: 'la oficina' },
};
export const fixedText = (lang) => FIXED_TEXT[lang === 'es' ? 'es' : 'en'];
// A patient's language on file is free text ("Spanish", "es", "Español"); messages go out in Spanish or English.
export const langCode = (v) => (/^(es\b|spanish|espa)/i.test(String(v || '').trim()) ? 'es' : 'en');
export const patientLang = (p) => langCode(p?.language);

export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+/g, ' ').trim();
}

export function validateTemplates(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!obj || typeof obj !== 'object') throw new HttpError(400, 'message_templates must be an object');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const meta = TEMPLATE_META[baseKey(k)];
    if (!meta || !(k in DEFAULT_TEMPLATES || k in SPANISH_DEFAULTS)) throw new HttpError(400, `Unknown template ${k}`);
    if (v == null || v === '') continue;
    const name = `${meta.label}${k.endsWith('_es') ? ' (Spanish)' : ''}`;
    if (typeof v !== 'string' || v.length > 600) throw new HttpError(400, `${name} must be text up to 600 characters`);
    for (const need of meta.required) if (!v.includes(`{${need}}`)) throw new HttpError(400, `${name} must include {${need}}`);
    const unknown = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !meta.vars.includes(x));
    if (unknown.length) throw new HttpError(400, `${name} can't use {${unknown[0]}} — it can use ${meta.vars.map((x) => `{${x}}`).join(' ')}`);
    out[k] = v;
  }
  return JSON.stringify(out);
}

const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

// The practice's wording for one automated message, filled in. Amounts are in cents.
export async function messageText(db, practiceId, key, vars = {}, lang = 'en') {
  const practice = await db.get('SELECT name, phone, message_templates FROM practices WHERE id = ?', practiceId);
  return renderTemplate(templatesFor(practice, lang)[key], {
    practice: practice.name, phone: practice.phone || fixedText(lang).the_office, ...vars, ...(vars.amount != null ? { amount: dollars(vars.amount) } : {}),
  });
}

// Email subjects in Spanish; English subjects stay with their callers.
const SUBJECTS_ES = {
  reminder: 'Su cita en {practice}', booking_confirmation: 'Su cita en {practice}', review: 'Gracias por visitar {practice}',
  recall: 'Ya le toca su próxima visita en {practice}', card_declined: 'Su pago no se procesó — {practice}', forms: 'Por favor complete sus formularios para {practice}',
  booking_declined: 'Su solicitud de cita en {practice}', card_setup: 'Guarde una tarjeta para sus pagos — {practice}', payment_link: 'Solicitud de pago de {practice}',
  treatment_plan: 'Su plan de tratamiento de {practice}', survey: '¿Cómo lo hicimos? — {practice}',
};
export const subjectFor = (lang, key, english, practice) => (lang === 'es' && SUBJECTS_ES[key] ? SUBJECTS_ES[key].replace('{practice}', practice) : english);
