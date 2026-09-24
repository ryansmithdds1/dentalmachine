// New patient in one line (workflow 32, docs/workflows/specs/32-new-patient.md): what the caller says, typed the
// way it's said — "Jane Doe 3/14/1985 512-555-0100 jane@example.com Delta W123456789" — split into the chart's
// fields and, when a carrier the practice knows is named, the primary policy. Pure, so it's tested in Node
// (server/test/daily.test.js). Nothing is guessed silently: every field it fills is shown and can be changed.

const EMAIL = /[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/;
const ISO = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const US = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/;

const pad = (n) => String(n).padStart(2, '0');
const realDate = (y, m, d, today) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return iso <= today && y >= 1900 ? iso : null;
};
const titleCase = (w) => (w === w.toLowerCase() || w === w.toUpperCase() ? w.toLowerCase().replace(/(^|[-'\s])\p{L}/gu, (c) => c.toUpperCase()) : w);

// Ways a carrier may be named: its full name, the name without "Dental"/"Insurance", and its first word when that
// word is long enough and no other carrier starts with it ("Delta", "Cigna", "MetLife").
function carrierAliases(carriers) {
  const first = (c) => c.name.trim().split(/\s+/)[0].toLowerCase();
  const out = [];
  for (const c of carriers || []) {
    const names = new Set([c.name.trim().toLowerCase(), c.name.replace(/\b(dental|insurance|ins\.?|dppo|ppo)\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase()]);
    const f = first(c);
    if (f.length >= 4 && (carriers || []).filter((x) => first(x) === f).length === 1) names.add(f);
    for (const n of names) if (n.length >= 3) out.push([n, c]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseNewPatient(text, { carriers = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  let rest = ` ${String(text || '')} `;
  const out = {};
  const take = (re, fn) => {
    const m = re.exec(rest);
    if (!m) return;
    const v = fn(m);
    if (v == null) return;
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return v;
  };
  out.email = take(EMAIL, (m) => m[0].toLowerCase());
  out.dob = take(ISO, (m) => realDate(Number(m[1]), Number(m[2]), Number(m[3]), today))
    ?? take(US, (m) => {
      let y = Number(m[3]);
      if (m[3].length === 2) y += y > Number(today.slice(2, 4)) ? 1900 : 2000;
      return realDate(y, Number(m[1]), Number(m[2]), today);
    });
  out.phone = take(PHONE, (m) => `(${m[1]}) ${m[2]}-${m[3]}`);
  for (const [alias, c] of carrierAliases(carriers)) {
    const re = new RegExp(`(^|[\\s,;])${escape(alias)}(?=$|[\\s,;])`, 'i');
    if (re.test(rest)) {
      rest = rest.replace(re, ' ');
      out.carrier_id = c.id;
      out.carrier_name = c.name;
      break;
    }
  }
  // A member ID: letters and digits (at least one digit), five or more characters — only next to a carrier.
  if (out.carrier_id) out.subscriber_id = take(/(?:^|\s)([A-Za-z]{0,4}\d[A-Za-z0-9-]{3,}\d?)(?=\s|$)/, (m) => m[1].toUpperCase());
  // "Doe, Jane" or "Jane Doe" (the last word is the last name; anything before it is the first name).
  const comma = /^\s*([\p{L}'-]+(?:\s[\p{L}'-]+)*)\s*,\s*([\p{L}'-]+(?:\s[\p{L}'-]+)*)/u.exec(rest);
  const words = (comma ? `${comma[2]} ${comma[1]}` : rest).split(/[\s,;]+/).filter((w) => /^[\p{L}][\p{L}'.-]*$/u.test(w));
  if (comma) {
    out.first_name = comma[2].split(/\s+/).map(titleCase).join(' ');
    out.last_name = comma[1].split(/\s+/).map(titleCase).join(' ');
  } else if (words.length) {
    out.first_name = words.length > 1 ? words.slice(0, -1).map(titleCase).join(' ') : titleCase(words[0]);
    if (words.length > 1) out.last_name = titleCase(words.at(-1));
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== ''));
}
