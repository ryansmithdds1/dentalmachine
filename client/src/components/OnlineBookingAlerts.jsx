import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { getPref, loadPrefs } from '../prefs.js';
import { toast } from '../toast.js';
import { chime } from './calendar/LateBanner.jsx';

// OS4 — never blindsided: when a patient books online, everyone on the schedule sees it straight away (a toast with
// who, what, when, new/existing, insurance and anything that needs a person), with a soft sound unless they've
// turned it off (their own preference, from the Online bookings list). Uses the one shared live connection; the
// event carries ids only, and the details come from the server only for people allowed to see them.
export default function OnlineBookingAlerts() {
  const { can } = useAuth();
  const shown = useRef(new Set());
  useLiveEvents(async (e) => {
    if (e.type !== 'online_booking' || !can('schedule:read') || shown.current.has(e.id)) return;
    shown.current.add(e.id);
    let b;
    try {
      b = await api.get(`/online-scheduling/bookings/${e.id}`);
    } catch {
      return; // another office's booking (not ours to see), or it's gone: nothing to show
    }
    await loadPrefs();
    if (getPref('onlinebooking.sound', true)) chime();
    toast(<Link to="/requests?tab=online" className="toast-link" style={{ color: 'inherit' }}>{b.alert}</Link>, { tone: b.urgent ? 'error' : 'ok', ms: b.urgent || b.needs_person ? 15000 : 9000 });
  });
  return null;
}
