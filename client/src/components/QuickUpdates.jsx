import { useEffect, useMemo, useRef } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { billPatient } from './billClaim.js';
import { parseContactCommand, normalize, saveContact, addressLine, CONTACT_FIELDS } from './patient/contactUpdate.js';

// Command bar commands for the active patient, on every screen (mounted by QuickCommands):
//   "phone 512 555 0142", "email tess@new.com", "address 12 Oak St, Round Rock, TX 78664", "home phone …",
//   "work phone …"                → saved at once with Undo; a new address moves the household too (workflow 27)
//   "bill" / "send claim"         → the claim for their finished work is made and sent (workflow 24)
// Enter on the typed text does it, whatever patients the words also happen to match (like "task …").
const BILL = /^\s*(bill|bill insurance|send claims?|file claims?)\s*$/i;
const paletteText = () => document.querySelector('.palette input')?.value || '';
const closePalette = (input) => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

export default function QuickUpdates() {
  const { can } = useAuth();
  const { patientId, recent } = useActivePatient();
  const active = recent.find((r) => r.id === patientId) || null;
  const state = useRef({});
  state.current = { active, canContact: can('patients:write'), canBill: can('billing:write') };
  const name = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;

  const updateContact = async (cmd) => {
    const who = state.current.active;
    if (!who) return toast('Open a patient first (the change goes to the active patient)', { tone: 'error' });
    try {
      // The current values, so Undo knows what to put back.
      const current = await api.get(`/patients/${who.id}`);
      await saveContact(current, cmd.field, cmd.value);
    } catch (e) {
      toast(`Couldn’t change ${name(who)}’s ${CONTACT_FIELDS[cmd.field]}: ${e.message}`, { tone: 'error' });
    }
  };
  const bill = async () => {
    const who = state.current.active;
    if (!who) return toast('Open a patient first', { tone: 'error' });
    try {
      await billPatient(who.id, name(who));
      window.dispatchEvent(new Event('dm:refresh'));
    } catch (e) {
      toast(`Couldn’t bill ${name(who)}’s insurance: ${e.message}`, { tone: 'error' });
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || !e.isTrusted || !e.target.matches?.('.palette input') || !state.current.active) return;
      const text = e.target.value;
      const cmd = state.current.canContact ? parseContactCommand(text) : null;
      const billing = !cmd && state.current.canBill && BILL.test(text);
      if (!cmd && !billing) return;
      e.preventDefault();
      e.stopPropagation();
      closePalette(e.target);
      if (cmd) updateContact(cmd);
      else bill();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listed in the command bar with a preview of what Enter will do (the label is what was typed, so it matches).
  const contactCommand = useMemo(() => ({
    id: 'quick-contact',
    get label() {
      const cmd = parseContactCommand(paletteText());
      return cmd ? paletteText().trim() : 'phone … / email … / address … — update the active patient’s contact info';
    },
    get hint() {
      const cmd = parseContactCommand(paletteText());
      const who = state.current.active;
      if (!cmd || !who) return 'e.g. “phone 512 555 0142” or “address 12 Oak St, Austin, TX 78701”';
      try {
        const v = normalize(cmd.field, cmd.value);
        return `${name(who)}’s ${CONTACT_FIELDS[cmd.field]} → ${cmd.field === 'address' ? addressLine(v) : v}${cmd.field === 'address' ? ' (and the household at the old address)' : ''} · Enter saves, Undo on the note`;
      } catch (e) {
        return e.message;
      }
    },
    run: () => { const cmd = parseContactCommand(paletteText()); if (cmd) updateContact(cmd); },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useCommands([
    ...(active && can('patients:write') ? [contactCommand] : []),
    ...(active && can('billing:write') ? [{ id: 'bill-insurance', label: `Bill insurance for ${active.first_name} ${active.last_name}`, hint: 'Makes the claim for their finished work and sends it (type “bill”)', run: bill }] : []),
  ]);
  return null;
}
