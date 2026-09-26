import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { GraduationCap, X } from 'lucide-react';
import { useAuth } from '../../auth.jsx';
import { loadPrefs, useRemembered } from '../../prefs.js';
import { loadTours, MY_ROLE, ROLE_SET } from './tourEngine.js';
import { startTour, useTours } from './TourProvider.jsx';

// The first time someone signs in: "Welcome — take the 3-minute tour for your role". Three short walkthroughs from
// their role's basics, on the training patient. A line at the top of the home page, where the day starts (never a
// pop-up, and never pushing a working screen down), gone for good once they start it or say not now (kept with their
// preferences, so it follows them to any computer).
export default function TourWelcome() {
  const { user } = useAuth();
  const { running } = useTours();
  const home = useLocation().pathname === '/';
  const [seen, remember] = useRemembered('tour.welcome', null);
  const [loaded, setLoaded] = useState(false);
  const [set, setSet] = useState(null);
  const role = MY_ROLE[user?.role];
  // Only once preferences have loaded (before then "not seen" can't be told from "not known yet").
  useEffect(() => { let on = true; loadPrefs().then(() => on && setLoaded(true)); return () => { on = false; }; }, []);
  useEffect(() => {
    if (!loaded || seen != null || !role) return;
    loadTours().then((d) => setSet(d.sets.find((s) => s.key === ROLE_SET[role]) || null)).catch(() => { /* no welcome without the tours */ });
  }, [loaded, seen, role]);
  if (!home || !loaded || seen != null || running || !set?.tours?.length) return null;
  const three = set.tours.slice(0, 3);
  return (
    <div className="tour-welcome no-print" role="region" aria-label="Welcome">
      <GraduationCap size={18} aria-hidden />
      <span><strong>Welcome, {user.name.split(' ')[0]}!</strong> Take the 3-minute tour for your role — {three.length} short walkthroughs on a practice patient, where nothing you do is real.</span>
      <span style={{ flex: 1 }} />
      <button type="button" className="primary small" onClick={() => { remember('started'); startTour(three[0], { queue: three.slice(1), queueTitle: `${set.title} (the 3-minute tour)` }); }}>Take the tour</button>
      <button type="button" className="small" onClick={() => remember('dismissed')}>Not now</button>
      <button type="button" className="tour-x" aria-label="Dismiss the welcome" onClick={() => remember('dismissed')}><X size={15} /></button>
    </div>
  );
}
