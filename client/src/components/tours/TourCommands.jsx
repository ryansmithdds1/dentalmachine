import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { useCommands } from '../../shortcuts.js';
import { loadTours, searchTours, SHOW_ME_WORDS, MY_ROLE } from './tourEngine.js';
import { startTour } from './TourProvider.jsx';

// The walkthroughs in the command bar: "show me how to send a statement", "walk me through checking in" or
// "tour recall" lists the matching tours first; Enter starts one. The tours are only fetched once someone asks.
export default function TourCommands() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [tours, setTours] = useState(null);
  useEffect(() => {
    let timer = null;
    const later = (v) => { clearTimeout(timer); timer = setTimeout(() => setQ(v), 120); };
    const onInput = (e) => { if (e.target?.closest?.('.palette')) later(String(e.target.value || '').trim()); };
    const onKey = (e) => { if (e.key === 'Escape') later(''); };
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(timer); document.removeEventListener('input', onInput, true); document.removeEventListener('keydown', onKey, true); };
  }, []);
  const asked = SHOW_ME_WORDS.test(q);
  useEffect(() => {
    if (asked && !tours) loadTours().then((d) => setTours(d.tours)).catch(() => { /* the command bar still works without them */ });
  }, [asked, tours]);

  const commands = useMemo(() => {
    if (!user) return [];
    const list = [{ id: 'tours-home', label: 'Show me how to… (guided walkthroughs)', hint: 'Help · learn by doing, on a practice patient', icon: '🎓', run: () => nav('/help?tab=showme') }];
    if (!asked || !tours) return list;
    const lower = q.toLowerCase();
    const words = q.replace(SHOW_ME_WORDS, '').trim();
    for (const t of searchTours(tours, words, 6, { role: MY_ROLE[user.role] })) {
      list.push({
        id: `tour-${t.id}`,
        // The command bar keeps rows whose label contains what was typed.
        label: `Show me: ${t.q.replace(/^How do I /, '').replace(/\?$/, '')} — “${q}”`.toLowerCase().includes(lower) ? `Show me: ${t.q.replace(/^How do I /, '').replace(/\?$/, '')} — “${q}”` : `${q} → ${t.q}`,
        hint: `Guided walkthrough · ${t.steps.length} step${t.steps.length === 1 ? '' : 's'}${t.patient ? ' · on Tess Training' : ''}`,
        icon: '🎓',
        run: () => startTour(t.id),
      });
    }
    return list;
  }, [user, asked, tours, q, nav]);
  useCommands(commands);
  return null;
}
