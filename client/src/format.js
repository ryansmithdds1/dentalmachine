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
