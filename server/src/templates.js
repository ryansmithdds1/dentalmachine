import { HttpError } from './auth.js';

// Patient message templates. Practices can override any of these in Settings.
// Placeholders: {first_name} {practice} {when} {provider} {link} {phone}
export const DEFAULT_TEMPLATES = {
  reminder: 'Hi {first_name}, this is {practice} reminding you of your appointment on {when} with {provider}. Please confirm: {link}',
  booking_confirmation: "Hi {first_name}, you're booked at {practice} on {when} with {provider}. Details or changes: {link}",
  recall: "Hi {first_name}, it's time for your next checkup and cleaning at {practice}. Call us at {phone} to schedule. {link}",
  review: 'Thanks for visiting {practice} today, {first_name}! If you have a moment, we would love a review: {link}',
};

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
    if ((k === 'reminder' || k === 'review') && !v.includes('{link}')) throw new HttpError(400, `${k} template must include {link}`);
    out[k] = v;
  }
  return JSON.stringify(out);
}
