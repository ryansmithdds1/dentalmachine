import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { useCommands } from '../../shortcuts.js';
import { HELP_WORDS, loadManual, searchManual } from './manualData.js';

// Always mounted in the signed-in shell (renders nothing): the user manual in the command bar. "how do I post a
// deposit", "help deposit" or "deposit?" lists the matching Help → How do I… pages first; any other words
// that match a page offer it at the bottom (after patients and screens). The manual is only fetched once
// someone types a question into the bar.
export default function ManualCommands() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(null);
  // Follow what's typed in the command bar (CommandPalette.jsx), a moment after typing stops.
  useEffect(() => {
    let timer = null;
    const later = (v) => { clearTimeout(timer); timer = setTimeout(() => setQ(v), 120); };
    const onInput = (e) => { if (e.target?.closest?.('.palette')) later(String(e.target.value || '').trim()); };
    const onKey = (e) => { if (e.key === 'Escape') later(''); };
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(timer); document.removeEventListener('input', onInput, true); document.removeEventListener('keydown', onKey, true); };
  }, []);
  const asked = HELP_WORDS.test(q) || /\?\s*$/.test(q);
  const wanted = asked ? q.length >= 3 : q.length >= 4 && !/^[\d\s()+#-]+$/.test(q);
  useEffect(() => {
    if (wanted && !pages) loadManual().then((d) => setPages(d.pages)).catch(() => { /* the manual is a convenience here */ });
  }, [wanted, pages]);

  const commands = useMemo(() => {
    if (!user) return [];
    const list = [{ id: 'manual-home', label: 'How do I… (user manual)', hint: 'Help · every task step by step', icon: '❓', run: () => nav('/help') }];
    if (!wanted || !pages) return list;
    const lower = q.toLowerCase();
    const hits = searchManual(pages, q, asked ? 6 : 2);
    for (const p of hits) {
      // The command bar keeps rows whose label contains what was typed, so the words ride along when the
      // question itself doesn't contain them.
      list.push({
        id: `manual-${p.id}`,
        label: p.q.toLowerCase().includes(lower) ? p.q : `${p.q} — “${q}”`,
        hint: `User manual · ${p.where}`,
        icon: '❓',
        last: !asked,
        run: () => nav(`/help?how=${p.id}`),
      });
    }
    if (asked && hits.length) list.push({ id: 'manual-search', label: `Search the user manual for “${q}”`, hint: 'Help → How do I…', icon: '❓', run: () => nav(`/help?q=${encodeURIComponent(q.replace(HELP_WORDS, '').trim())}`) });
    return list;
  }, [user, wanted, pages, q, asked, nav]);
  useCommands(commands);
  return null;
}
