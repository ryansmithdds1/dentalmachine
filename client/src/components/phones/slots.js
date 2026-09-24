// The call screen's filter, run in the browser so the "Next openings" panel narrows the moment a request is heard
// or a chip is tapped (the server's phonecoach.js filterSlots does the same, and the refetch widens the search).
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

export const emptyRequest = (r) => !r || (!r.weekdays?.length && !r.date_from && !r.part && !r.after && !r.before && !r.provider_ids?.length && !r.asap);

export function filterSlots(slots, r) {
  if (emptyRequest(r)) return slots;
  const out = slots.filter((x) => {
    const date = x.start.slice(0, 10);
    const hm = x.start.slice(11, 16);
    if (r.weekdays?.length && !r.weekdays.includes(weekdayOf(date))) return false;
    if (r.date_from && date < r.date_from) return false;
    if (r.date_to && date > r.date_to) return false;
    if (r.part === 'am' && hm >= '12:00') return false;
    if (r.part === 'pm' && hm < '12:00') return false;
    if (r.after && hm < r.after) return false;
    if (r.before && hm >= r.before) return false;
    if (r.provider_ids?.length && !r.provider_ids.includes(x.provider_id)) return false;
    return true;
  });
  return r.asap ? out.slice(0, 3) : out;
}

// What was heard, in a few words ("Thu · afternoon · Dr. Chen").
export function describe(r, providers = []) {
  if (emptyRequest(r)) return '';
  const bits = [];
  if (r.weekdays?.length) bits.push(r.weekdays.map((d) => WEEKDAYS[d]).join('/'));
  if (r.date_from && r.date_to && r.date_from !== r.date_to) bits.push(`${r.date_from.slice(5)}–${r.date_to.slice(5)}`);
  else if (r.date_from) bits.push(r.date_from.slice(5));
  if (r.part) bits.push(r.part === 'am' ? 'morning' : 'afternoon');
  if (r.after) bits.push(`after ${r.after}`);
  if (r.before) bits.push(`before ${r.before}`);
  if (r.provider_ids?.length) bits.push(r.provider_ids.map((id) => providers.find((p) => p.id === id)?.name || 'provider').join(' or '));
  if (r.asap) bits.push('soonest');
  return bits.join(' · ');
}

export const slotLabel = (s) => {
  const d = new Date(`${s.start.slice(0, 10)}T12:00:00Z`);
  const [h, m] = s.start.slice(11, 16).split(':').map(Number);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
