import { api } from '../../api.js';
import { toast } from '../../toast.js';

// Workflow 27 (docs/workflows/specs/27-demographics.md): contact details change in place — from the chart's Contact
// card or the command bar ("phone 512 555 0142", "address 12 Oak St, Round Rock, TX 78664") — and save at once with
// Undo. Undo sends the old values back through the same routes, so the chart's history shows both. A new address
// also moves everyone in the household who lived at the old one (the server decides who: routes/family.js).

export const CONTACT_FIELDS = {
  phone: 'mobile', phone_home: 'home phone', phone_work: 'work phone', email: 'email', emergency_contact: 'emergency contact',
  preferred_contact: 'contact preference', language: 'language', address: 'address',
};

// "5125550142", "512.555.0142", "+1 512 555 0142" → "(512) 555-0142". Anything else isn't a US phone number.
export function formatPhone(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10 || /[a-z]/i.test(raw.replace(/ext\.?\s*\d+$/i, ''))) throw new Error(`“${raw}” isn’t a 10-digit phone number`);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// "12 Oak St, Round Rock, TX 78664" (the commas after the street are what split it) → { address, city, state, zip }.
// A street alone ("12 Oak St") changes just the street.
export function parseAddress(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) throw new Error('Type the new address');
  const m = /^(.+?),\s*(.+?),?\s+([A-Za-z]{2})\.?,?\s+(\d{5}(?:-\d{4})?)$/.exec(t);
  if (m) return { address: m[1], city: m[2].replace(/,$/, ''), state: m[3].toUpperCase(), zip: m[4] };
  if (!t.includes(',')) return { address: t };
  throw new Error('Type it as: 12 Oak St, Round Rock, TX 78664');
}
export const addressLine = (p) => [p.address, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

const cleanEmail = (v) => {
  const e = String(v || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`“${e}” isn’t an email address`);
  return e;
};

// Turns typed values into what the server stores; throws a plain-language error for anything impossible.
export function normalize(field, value) {
  if (field === 'phone' || field === 'phone_home' || field === 'phone_work') return formatPhone(value) || null;
  if (field === 'email') return cleanEmail(value) || null;
  if (field === 'address') return parseAddress(value);
  return String(value ?? '').trim() || null;
}

const refresh = () => window.dispatchEvent(new Event('dm:refresh'));
const first = (p) => p.preferred_name || p.first_name;
const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// Saves one change for a patient (who: { id, first_name, preferred_name, … the current values }), with an Undo toast.
export async function saveContact(who, field, value) {
  const next = normalize(field, value);
  if (field === 'address') {
    const r = await api.put(`/patients/${who.id}/address`, next);
    const moved = r.moved || [];
    refresh();
    toast(`New address for ${names([first(who), ...moved.map((m) => m.first_name)])}: ${addressLine(r.patient)}`, {
      undo: async () => {
        try {
          await api.put(`/patients/${who.id}/address`, { ...r.before, household: false });
          for (const m of moved) await api.put(`/patients/${m.id}/address`, { ...m.before, household: false });
          toast('Undone');
        } catch (e) {
          toast(`Couldn’t undo: ${e.message}`, { tone: 'error' });
        }
        refresh();
      },
    });
    return r.patient;
  }
  const before = who[field] ?? null;
  if ((before || null) === (next || null)) return who;
  const saved = await api.put(`/patients/${who.id}`, { [field]: next });
  refresh();
  toast(`${first(who)}’s ${CONTACT_FIELDS[field] || field.replace(/_/g, ' ')} ${next ? `is now ${next}` : 'was cleared'}`, {
    undo: async () => {
      try { await api.put(`/patients/${who.id}`, { [field]: before }); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); }
      refresh();
    },
  });
  return saved;
}

// The command bar's wording: "phone …", "mobile …", "home phone …", "work phone …", "email …", "address …".
export const CONTACT_COMMAND = /^\s*(home phone|work phone|mobile|cell|phone|e-?mail|new address|moved to|address)\s*:?\s+(\S.*)$/i;
export function parseContactCommand(text) {
  const m = CONTACT_COMMAND.exec(text || '');
  if (!m) return null;
  const word = m[1].toLowerCase();
  const field = word === 'home phone' ? 'phone_home' : word === 'work phone' ? 'phone_work' : /mail/.test(word) ? 'email' : /address|moved/.test(word) ? 'address' : 'phone';
  return { field, value: m[2].trim() };
}
