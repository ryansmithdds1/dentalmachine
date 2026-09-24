// The patient flow on the schedule: arrived → seated → ready → out. "Ready" is a flag beside the status
// (ready_for: 'doctor' | 'checkout'), so each step here is either a status change or a ready change.
// The schedule's keys, the card's next-step button and the drawer all use these, so they always agree.

export const READY_LABEL = { doctor: 'Ready for doctor', checkout: 'Ready for checkout' };
export const READY_SHORT = { doctor: 'Ready · Dr', checkout: 'Ready · out' };

// Keys that act on the focused (or open) appointment.
export const STEP_KEYS = { in: 'i', seat: 's', ready: 'r', ready_checkout: 'shift+r', out: 'o' };

// What a step does to this visit: { status } or { ready }, a label for buttons and a message for the toast.
// Returns { error } when the step doesn't apply (e.g. seating someone already gone home).
export function planStep(a, kind) {
  const who = `${a.first_name} ${a.last_name}`;
  const waiting = ['scheduled', 'confirmed'].includes(a.status);
  switch (kind) {
    case 'in':
      return waiting ? { status: 'checked_in', label: 'Check in', done: `Checked in ${who}` } : { error: `${who} is already past check-in` };
    case 'seat':
      return waiting || a.status === 'checked_in' ? { status: 'in_chair', label: 'Seat', done: `Seated ${who}` } : { error: a.status === 'in_chair' ? `${who} is already seated` : `${who} can’t be seated now` };
    case 'ready':
    case 'ready_checkout': {
      if (a.status !== 'in_chair') return { error: `Seat ${who} first, then mark them ready` };
      const want = kind === 'ready' ? 'doctor' : 'checkout';
      // Pressing it again takes the flag off (they weren't ready after all).
      if (a.ready_for === want) return { ready: null, label: 'Not ready', done: `${who} no longer marked ready` };
      return { ready: want, label: READY_LABEL[want], done: `${who} is ${READY_LABEL[want].toLowerCase()}` };
    }
    case 'out':
      return a.status === 'in_chair' ? { status: 'completed', label: 'Out', done: `${who} is out · visit complete` } : { error: a.status === 'completed' ? `${who} is already out` : `Seat ${who} first` };
    default:
      return { error: 'Unknown step' };
  }
}

// The one step that comes next, for the one-click button: check in → seat → ready → out.
export function nextKind(a) {
  if (['scheduled', 'confirmed'].includes(a.status)) return 'in';
  if (a.status === 'checked_in') return 'seat';
  if (a.status === 'in_chair') return a.ready_for ? 'out' : 'ready';
  return null;
}
export const NEXT_LABEL = { in: 'Check in', seat: 'Seat', ready: 'Ready', out: 'Out' };

// Completing a visit that has planned procedures (for someone allowed to) also posts their charges, which the
// toast's Undo can't take back — that one stays a deliberate click on the drawer's button.
export const postsCharges = (a, canClinical) => a.status === 'in_chair' && !!a.procedure_summary && canClinical;
