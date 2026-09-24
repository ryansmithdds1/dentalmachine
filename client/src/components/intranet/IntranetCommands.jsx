import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useCommands } from '../../shortcuts.js';
import { hostOf, openExternal, useIntranetRefresh } from './shared.jsx';

// Always mounted (inside the signed-in shell): puts every office link and intranet page into the command bar,
// so "Open Delta Dental portal" is Ctrl/⌘K → type "delta" → Enter from any screen. Renders nothing.
export default function IntranetCommands() {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const [data, setData] = useState({ links: [], pages: [] });
  const load = useCallback(() => {
    if (!user) return;
    // The command bar is a convenience: if this fails, the Links page still works.
    api.get('/intranet/commands').then(setData).catch(() => { /* keep the last list */ });
  }, [user]);
  useEffect(() => { load(); }, [load]);
  useIntranetRefresh(load);
  // Another office manager may add links while this tab is open: refresh now and then, and on return.
  useEffect(() => {
    const t = setInterval(load, 10 * 60_000);
    const onFocus = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  const manager = can?.('intranet:manage');
  const commands = useMemo(() => [
    ...data.links.map((l) => ({
      id: `intranet-link-${l.id}`,
      label: `Open ${l.title}${l.category === 'insurance' && !/portal/i.test(l.title) ? ' portal' : ''}`,
      hint: `Office link · ${hostOf(l.url)}`,
      run: () => openExternal(l.url),
    })),
    ...data.pages.slice(0, 400).map((p) => ({ id: `intranet-page-${p.id}`, label: `Office manual: ${p.title}`, hint: 'Intranet page', run: () => nav(`/intranet/pages/${p.id}`) })),
    { id: 'intranet-home', label: 'Office intranet (announcements, SOPs, links)', hint: 'Go to page', run: () => nav('/intranet') },
    { id: 'intranet-links', label: 'Office links', hint: 'Go to page', run: () => nav('/intranet/links') },
    { id: 'intranet-search', label: 'Search the office manual (SOPs)', hint: 'Intranet', run: () => nav('/intranet/search') },
    ...(manager ? [
      { id: 'intranet-new-page', label: 'New office manual page (SOP)', hint: 'Intranet', run: () => nav('/intranet/new') },
      { id: 'intranet-new-announcement', label: 'New office announcement', hint: 'Intranet', run: () => nav('/intranet?announce=1') },
      { id: 'intranet-new-link', label: 'Add an office link', hint: 'Intranet', run: () => nav('/intranet/links?add=1') },
    ] : []),
  ], [data, manager, nav]);
  useCommands(commands);
  return null;
}
