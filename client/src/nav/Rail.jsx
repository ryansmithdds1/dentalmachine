import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Pin, PinOff, ChevronDown, Menu, X, Search, Settings as SettingsIcon, HelpCircle, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { useRemembered, showPref } from '../prefs.js';
import { navFor, pageFor, allPages, MAX_PINS } from './navConfig.js';
import { useNavCounts, rollUp, NavBadge } from './navCounts.jsx';
import './rail.css';

// The navigation rail. Seven group icons (navConfig.js); hovering one — or Tab / → on it — opens a flyout of
// its pages, and clicking it goes back to the page last used in that group. Kept open (rail-open), the groups
// are collapsible sections instead. On a phone the groups live in a bottom sheet behind the Menu button.
// Up to 3 favourite pages can be pinned above the groups (saved per person on the server, PUT /me/nav-pins).

// Per-computer conveniences (which page each group opens, which sections are open): losing them costs a click.
const LAST_KEY = 'dm_nav_last';
const SECTIONS_KEY = 'dm_nav_sections';
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const OPEN_DELAY = 140;
const CLOSE_DELAY = 220;
const PHONE = '(max-width: 800px)';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE);
    if (!mq) return undefined;
    const f = () => setNarrow(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return narrow;
}

function usePins(pages) {
  const [saved] = useRemembered('nav.pins', []);
  const list = Array.isArray(saved) ? saved : [];
  // Pages this person can't open any more (a role change) just drop out.
  const pinned = list.filter((to) => pages.some((p) => p.to === to));
  const label = (to) => pages.find((p) => p.to === to)?.label || to;
  const save = async (next, before) => {
    showPref('nav.pins', next);
    try {
      await api.put('/me/nav-pins', { pins: next });
      return true;
    } catch (e) {
      showPref('nav.pins', before);
      toast(`Couldn’t save your pinned pages: ${e.message}`, { tone: 'error' });
      return false;
    }
  };
  const toggle = async (to) => {
    const on = pinned.includes(to);
    if (!on && pinned.length >= MAX_PINS) return toast(`You can pin up to ${MAX_PINS} pages — unpin one first`, { tone: 'error' });
    const next = on ? pinned.filter((x) => x !== to) : [...pinned, to];
    if (await save(next, list)) toast(on ? `Unpinned ${label(to)}` : `Pinned ${label(to)} to the top of the menu`, { undo: () => save(pinned, next) });
  };
  return [pinned, toggle];
}

// Arrow keys, Home/End between the links of a list; P pins the focused page.
function listKeys(e, box, { onEscape, onPin }) {
  const links = [...box.querySelectorAll('a[data-page]')];
  const i = links.indexOf(document.activeElement);
  const focus = (n) => { e.preventDefault(); e.stopPropagation(); links[(n + links.length) % links.length]?.focus(); };
  if (e.key === 'ArrowDown') focus(i + 1);
  else if (e.key === 'ArrowUp') focus(i < 0 ? links.length - 1 : i - 1);
  else if (e.key === 'Home') focus(0);
  else if (e.key === 'End') focus(links.length - 1);
  else if ((e.key === 'Escape' || e.key === 'ArrowLeft') && onEscape) { e.preventDefault(); e.stopPropagation(); onEscape(); }
  else if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey && i >= 0) {
    e.preventDefault();
    e.stopPropagation();
    onPin(links[i].dataset.page);
  }
}

function PinButton({ page, pinned, onPin }) {
  const on = pinned.includes(page.to);
  return (
    <button type="button" tabIndex={-1} className={`rail-pin${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${on ? 'Unpin' : 'Pin'} ${page.label}`} title={on ? 'Unpin (P)' : 'Pin to the top of the menu (P)'} onClick={() => onPin(page.to)}>
      {on ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
    </button>
  );
}

function PageLink({ page, counts, className, onClick, showIcon = true }) {
  const Icon = page.icon;
  return (
    <NavLink to={page.to} end={page.to === '/'} className={className} data-page={page.to} aria-keyshortcuts="P" onClick={onClick}>
      {showIcon && <Icon size={16} strokeWidth={1.9} aria-hidden />}
      <span className="rail-page-label">{page.label}</span>
      <NavBadge badge={page.badge && counts[page.badge]} />
    </NavLink>
  );
}

// Collapsed rail: the group icon and its flyout.
function Flyout({ group, counts, target, active, isOpen, onOpen, onClose, pinned, onPin }) {
  const wrap = useRef(null);
  const btn = useRef(null);
  const fly = useRef(null);
  const quiet = useRef(false); // focus coming back from the flyout (Esc) doesn't open it again
  const Icon = group.icon;
  const total = rollUp(group.pages, counts);
  const id = `rail-fly-${group.key}`;
  // Fixed to the window (the rail's list scrolls, which would clip it), beside the icon and kept on screen.
  useLayoutEffect(() => {
    if (!isOpen || !btn.current || !fly.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = fly.current.offsetHeight;
    fly.current.style.left = `${r.right + 10}px`;
    fly.current.style.top = `${Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8))}px`;
  }, [isOpen]);
  const first = () => requestAnimationFrame(() => fly.current?.querySelector('a[data-page]')?.focus());
  return (
    <div
      ref={wrap} className={`rail-group${isOpen ? ' open' : ''}`} data-group={group.key}
      onMouseEnter={() => onOpen(group.key)} onMouseLeave={() => onClose(group.key)}
      onBlur={(e) => { if (!wrap.current.contains(e.relatedTarget) && e.relatedTarget) onClose(group.key, true); }}
    >
      <Link
        ref={btn} to={target} className={`rail-item rail-group-btn${active ? ' active' : ''}`} aria-label={`${group.label}${total ? ` (${total.n})` : ''}`}
        aria-expanded={isOpen} aria-controls={id} aria-current={active ? 'true' : undefined}
        onClick={() => onClose(group.key, true)}
        onFocus={(e) => { if (!quiet.current && e.target.matches(':focus-visible')) onOpen(group.key, true); quiet.current = false; }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onOpen(group.key, true); first(); } else if (e.key === 'Escape' && isOpen) { e.preventDefault(); onClose(group.key, true); }
        }}
      >
        <Icon size={19} strokeWidth={1.9} aria-hidden />
        <NavBadge badge={total} />
      </Link>
      <div
        ref={fly} id={id} className="rail-fly" role="group" aria-label={`${group.label} pages`} hidden={!isOpen}
        onKeyDown={(e) => listKeys(e, fly.current, { onEscape: () => { onClose(group.key, true); quiet.current = true; btn.current?.focus(); }, onPin })}
      >
        <div className="rail-fly-head">{group.label}</div>
        {group.pages.map((p) => (
          <div key={p.to} className="rail-fly-row">
            <PageLink page={p} counts={counts} className="rail-fly-link" onClick={() => onClose(group.key, true)} />
            <PinButton page={p} pinned={pinned} onPin={onPin} />
          </div>
        ))}
        <div className="rail-fly-foot">↑↓ move · Enter open · P pin · Esc close</div>
      </div>
    </div>
  );
}

// Rail kept open (and the phone menu): a heading per group and its pages under it.
function Section({ group, counts, active, open, onToggle, pinned, onPin, onNavigate }) {
  const box = useRef(null);
  const Icon = group.icon;
  const total = rollUp(group.pages, counts);
  const id = `rail-sec-${group.key}`;
  return (
    <div className={`rail-section${open ? ' open' : ''}`} data-group={group.key} ref={box} onKeyDown={(e) => open && listKeys(e, box.current, { onPin })}>
      <button type="button" className={`rail-item rail-section-head${active ? ' in' : ''}`} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <Icon size={19} strokeWidth={1.9} aria-hidden />
        <span className="rail-label">{group.label}</span>
        {!open && <NavBadge badge={total} />}
        <ChevronDown size={15} className="rail-chev" aria-hidden />
      </button>
      {open && (
        <div id={id} className="rail-section-pages">
          {group.pages.map((p) => (
            <div key={p.to} className="rail-sub-row">
              <PageLink page={p} counts={counts} className="rail-sub" showIcon={false} onClick={onNavigate} />
              <PinButton page={p} pinned={pinned} onPin={onPin} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhoneSheet({ groups, counts, current, pinned, onPin, onClose }) {
  const box = useRef(null);
  useEffect(() => {
    box.current?.querySelector('a[data-page]')?.focus();
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="rail-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rail-sheet" role="dialog" aria-modal="true" aria-label="Menu" ref={box} onKeyDown={(e) => listKeys(e, box.current, { onPin })}>
        <div className="rail-sheet-head">
          <strong>Menu</strong>
          <button type="button" className="rail-sheet-close" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>
        {groups.map((g) => {
          const Icon = g.icon;
          return (
            <section key={g.key} className={`rail-sheet-group${current?.group.key === g.key ? ' in' : ''}`} data-group={g.key} aria-label={g.label}>
              <h3><Icon size={16} aria-hidden /> {g.label} <NavBadge badge={rollUp(g.pages, counts)} /></h3>
              <div className="rail-sheet-pages">
                {g.pages.map((p) => (
                  <div key={p.to} className="rail-sub-row">
                    <PageLink page={p} counts={counts} className="rail-sheet-link" onClick={onClose} />
                    <PinButton page={p} pinned={pinned} onPin={onPin} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        <div className="rail-sheet-pages rail-sheet-foot">
          <NavLink to="/settings" className="rail-sheet-link" onClick={onClose}><SettingsIcon size={16} aria-hidden /> Settings</NavLink>
          <NavLink to="/help" className="rail-sheet-link" onClick={onClose}><HelpCircle size={16} aria-hidden /> Help</NavLink>
        </div>
      </div>
    </div>
  );
}

// The collapsed rail's page list can scroll on a short window, and a scroll box clips CSS tooltips, so the
// labels of the pinned icons there are drawn here, outside it (the group icons have their flyouts instead).
function RailTip() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    const over = (e) => {
      const el = e.target.closest?.('.rail-nav [data-tip]');
      if (!el || document.querySelector('.app.rail-open') || window.innerWidth <= 800) return setTip(null);
      const r = el.getBoundingClientRect();
      setTip({ text: el.dataset.tip, top: r.top + r.height / 2, left: r.right + 12 });
    };
    const hide = () => setTip(null);
    document.addEventListener('pointerover', over);
    document.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('pointerover', over); document.removeEventListener('scroll', hide, true); };
  }, []);
  return tip ? <div className="rail-tip" style={{ top: tip.top, left: tip.left }} aria-hidden>{tip.text}</div> : null;
}

export default function Rail({ railOpen, onToggleRail, brand, chat, userMenu }) {
  const { can, user, practice } = useAuth();
  const location = useLocation();
  const narrow = useNarrow();
  const groups = useMemo(() => navFor({ can, user, practice }), [can, user, practice]);
  const pages = useMemo(() => allPages(groups), [groups]);
  const counts = useNavCounts({
    attention: pages.some((p) => p.badge === 'attention'), unread: pages.some((p) => p.badge === 'unread'), tasks: pages.some((p) => p.badge === 'tasks'),
    checklists: pages.some((p) => p.badge === 'checklists'), claims: pages.some((p) => p.badge === 'claims'),
  });
  const [pinned, togglePin] = usePins(pages);
  const current = pageFor(groups, location.pathname);

  // The page each group opens: the one last used in it.
  const [last, setLast] = useState(() => readJson(LAST_KEY));
  useEffect(() => {
    if (!current || last[current.group.key] === current.page.to) return;
    const next = { ...last, [current.group.key]: current.page.to };
    setLast(next);
    writeJson(LAST_KEY, next);
  }, [current?.group.key, current?.page.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = (g) => (g.pages.some((p) => p.to === last[g.key]) ? last[g.key] : g.pages[0].to);

  // One flyout at a time. Opening waits a moment (a pointer passing over doesn't flash menus), but moves
  // straight to a neighbour when one is already open.
  const [openKey, setOpenKey] = useState(null);
  const openRef = useRef(null);
  openRef.current = openKey;
  const timer = useRef(null);
  const openGroup = useCallback((key, now) => {
    clearTimeout(timer.current);
    if (now || openRef.current) setOpenKey(key);
    else timer.current = setTimeout(() => setOpenKey(key), OPEN_DELAY);
  }, []);
  const closeGroup = useCallback((key, now) => {
    clearTimeout(timer.current);
    const shut = () => setOpenKey((k) => (k === key ? null : k));
    if (now) shut();
    else timer.current = setTimeout(shut, CLOSE_DELAY);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setOpenKey(null); }, [location.pathname, location.search, railOpen, narrow]);
  useEffect(() => {
    if (!openKey) return undefined;
    const away = (e) => { if (!e.target.closest?.('.rail-group')) setOpenKey(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpenKey(null); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [openKey]);

  // Open sections (rail kept open): remembered; the current page's group is always open.
  const [sections, setSections] = useState(() => readJson(SECTIONS_KEY));
  const sectionOpen = (g) => sections[g.key] ?? current?.group.key === g.key;
  const toggleSection = (g) => {
    const next = { ...sections, [g.key]: !sectionOpen(g) };
    setSections(next);
    writeJson(SECTIONS_KEY, next);
  };

  const [sheet, setSheet] = useState(false);
  const closeSheet = useCallback(() => setSheet(false), []);
  const everything = rollUp(pages, counts);
  const pinnedPages = pinned.map((to) => pages.find((p) => p.to === to)).filter(Boolean);

  return (
    <aside className={`sidebar rail${narrow ? ' rail-phone' : ''}`} aria-label="Main menu">
      {brand}
      <button className="rail-item" onClick={() => window.dispatchEvent(new Event('dm:search'))} data-tip="Search (Ctrl K)" aria-label="Search">
        <Search size={19} strokeWidth={1.9} aria-hidden /><span className="rail-label">Search <kbd>Ctrl K</kbd></span>
      </button>
      {chat}
      <RailTip />
      <nav className="nav rail-nav" aria-label="Pages" onScroll={() => setOpenKey(null)}>
        {pinnedPages.length > 0 && (
          <div className="rail-pins" role="group" aria-label="Pinned pages">
            {pinnedPages.map((p) => {
              const Icon = p.icon;
              return (
                <NavLink key={p.to} to={p.to} end={p.to === '/'} className="rail-item rail-pinned" data-tip={p.label} aria-label={`${p.label} (pinned)`}>
                  <Icon size={19} strokeWidth={1.9} aria-hidden />
                  <span className="rail-label">{p.label}</span>
                  <NavBadge badge={p.badge && counts[p.badge]} />
                </NavLink>
              );
            })}
          </div>
        )}
        {narrow ? (
          <button type="button" className="rail-item rail-menu-btn" onClick={() => setSheet(true)} aria-haspopup="dialog" aria-expanded={sheet} aria-label={`Menu${everything ? ` (${everything.n})` : ''}`}>
            <Menu size={19} strokeWidth={1.9} aria-hidden />
            <span className="rail-menu-text">{current ? current.page.label : 'Menu'}</span>
            <NavBadge badge={everything} />
          </button>
        ) : groups.map((g) => (railOpen
          ? <Section key={g.key} group={g} counts={counts} active={current?.group.key === g.key} open={sectionOpen(g)} onToggle={() => toggleSection(g)} pinned={pinned} onPin={togglePin} />
          : <Flyout key={g.key} group={g} counts={counts} target={target(g)} active={current?.group.key === g.key} isOpen={openKey === g.key} onOpen={openGroup} onClose={closeGroup} pinned={pinned} onPin={togglePin} />))}
      </nav>
      <div className="rail-foot">
        <NavLink to="/settings" className="rail-item rail-desktop" data-tip="Settings" aria-label="Settings"><SettingsIcon size={19} strokeWidth={1.9} aria-hidden /><span className="rail-label">Settings</span></NavLink>
        <NavLink to="/help" className="rail-item rail-desktop" data-tip="Help" aria-label="Help"><HelpCircle size={19} strokeWidth={1.9} aria-hidden /><span className="rail-label">Help</span></NavLink>
        <button className="rail-item rail-desktop" onClick={onToggleRail} data-tip={railOpen ? 'Collapse menu' : 'Keep menu open'} aria-label={railOpen ? 'Collapse menu' : 'Expand menu'}>
          {railOpen ? <PanelLeftClose size={19} strokeWidth={1.9} /> : <PanelLeftOpen size={19} strokeWidth={1.9} />}
          <span className="rail-label">Collapse</span>
        </button>
        {userMenu}
      </div>
      {narrow && sheet && <PhoneSheet groups={groups} counts={counts} current={current} pinned={pinned} onPin={togglePin} onClose={closeSheet} />}
    </aside>
  );
}
