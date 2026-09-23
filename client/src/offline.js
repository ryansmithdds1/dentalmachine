// Today's schedule kept on this device so the office can still see who's coming if the internet drops.
// Only today's list (times, names, reasons, chairs) is kept, for this browser tab only (it goes when the
// tab closes), and it's removed at sign-out.
const KEY = 'dm_offline_day';

export function saveOfflineDay(practice, date, appointments, operatories = [], providers = []) {
  const chair = Object.fromEntries(operatories.map((o) => [o.id, o.name]));
  const prov = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  const day = {
    saved_at: new Date().toISOString(), practice: practice?.name || '', date,
    visits: appointments.filter((a) => a.start_time.startsWith(date) && !['cancelled', 'no_show'].includes(a.status)).map((a) => ({
      start: a.start_time.slice(11, 16), end: a.end_time.slice(11, 16), name: `${a.first_name} ${a.last_name}`, phone: a.phone || '',
      reason: a.type_name || a.reason || '', provider: prov[a.provider_id] || a.provider_name || '', chair: chair[a.operatory_id] || '', status: a.status,
      alert: !!(a.medical_alerts || a.premed_required),
    })),
  };
  try { sessionStorage.setItem(KEY, JSON.stringify(day)); } catch { /* storage full or blocked */ }
}

export function readOfflineDay() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
}

// Patient details kept in the browser, cleared at sign-out: today's list, and the pinboard (ids only).
export const PINBOARD_KEY = 'dm_pinboard';
export function clearOfflineDay() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
  try { localStorage.removeItem(KEY); localStorage.removeItem(PINBOARD_KEY); } catch { /* storage blocked */ }
}
