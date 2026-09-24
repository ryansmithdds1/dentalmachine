const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (cents) => usd.format((cents || 0) / 100);
export const toCents = (dollars) => Math.round(Number(dollars) * 100);
export const fromCents = (cents) => ((cents || 0) / 100).toFixed(2);

export const fullName = (p) => (p ? `${p.first_name}${p.preferred_name ? ` "${p.preferred_name}"` : ''} ${p.last_name}` : '');

export function age(dob) {
  if (!dob) return '';
  const d = new Date(`${dob}T00:00:00`);
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}

export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(`${s.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtTime(s) {
  if (!s) return '';
  const [h, m] = s.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const fmtDateTime = (s) => (s ? `${fmtDate(s)} ${fmtTime(s)}` : '');

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const label = (s) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');

// Today's date in the practice's time zone (which may differ from the browser's).
export function practiceToday(tz = 'America/New_York') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// For UTC timestamps from the server (created_at, signed_at…): show the practice-local date.
export function fmtUtcDate(s, tz) {
  if (!s) return '';
  if (String(s).length <= 10) return fmtDate(s); // a plain date has no time zone to convert
  const d = new Date(`${s.slice(0, 19).replace(' ', 'T')}Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(tz ? { timeZone: tz } : {}) });
}
export function fmtUtcDateTime(s, tz) {
  if (!s) return '';
  const d = new Date(`${s.slice(0, 19).replace(' ', 'T')}Z`);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
}

// An appointment's insurance check as a badge: verified recently, getting old, not done, or a problem.
export function eligibilityBadge(e, now = Date.now()) {
  if (!e) return null;
  const days = e.checked_at ? Math.max(0, Math.floor((now - Date.parse(`${e.checked_at.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(e.checked_at) ? '' : 'Z'}`)) / 86400_000)) : null;
  const ago = days == null ? '' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  if (e.status === 'active') return days <= 30 ? { tone: 'ok', icon: '$✓', text: `Insurance verified ${ago}` } : { tone: 'warn', icon: '$?', text: `Insurance verified ${ago} — check again` };
  if (e.status === 'inactive') return { tone: 'bad', icon: '$✗', text: `Coverage inactive (checked ${ago})` };
  if (e.status === 'error') return { tone: 'bad', icon: '$!', text: `Eligibility check failed ${ago}` };
  if (e.status === 'pending') return { tone: 'warn', icon: '$…', text: 'Eligibility request waiting for the payer’s answer' };
  return { tone: 'warn', icon: '$?', text: 'Insurance not verified' };
}
