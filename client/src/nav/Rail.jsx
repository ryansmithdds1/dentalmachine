import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Pin, PinOff, ChevronDown, ChevronRight, Menu, X, Search, Settings as SettingsIcon, HelpCircle, PanelLeftClose, PanelLeftOpen, UserSearch } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { useRemembered, showPref } from '../prefs.js';
import { useActivePatient } from '../activePatient.jsx';
import { navFor, whereAmI, allPages, pinnable, MAX_PINS } from './navConfig.js';
import { useNavCounts, rollUp, NavBadge } from './navCounts.jsx';
import './rail.css';

// The module bar (navConfig.js), like Open Dental's: a click on a module goes straight to it — Schedule, the
// active patient's Family / Account / Treatment Plan / Chart / Images, or Manage (today's dashboard). The rest of
// each module is in a dropdown: its chevron (or → / ↓ on the focused module) opens it, and so does resting the
// pointer on the module. With no active patient a patient module asks for one (the command bar's patient
// search) and then opens that module's tab. Kept open (rail-open), the dropdowns fold out under their modules.
// On a phone the modules live in a bottom sheet behind the Menu button. Up to 3 pages can be pinned above the
// modules (saved per person on the server, PUT /me/nav-pins).

// Which modules' dropdowns are folded out when the menu is kept open: a per-computer convenience.
const FOLD_KEY = 'dm_nav_folds';
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const OPEN_DELAY = 280; // resting on a module opens its dropdown; passing over it on the way to a click doesn't
const CLOSE_DELAY = 220;
const PHONE = '(max-width: 800px)';
const itemKey = (p) => p.to || `tab:${p.tab}`;

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
    if (!to || to.includes('?') || to.startsWith('tab:')) return toast('This one follows the patient or opens a tab, so it can’t be pinned', { tone: 'error' });
    const on = pinned.includes(to);
    if (!on && pinned.length >= MAX_PINS) return toast(`You can pin up to ${MAX_PINS} pages — unpin one first`, { tone: 'error' });
    const next = on ? pinned.filter((x) => x !== to) : [...pinned, to];
    if (await save(next, list)) toast(on ? `Unpinned ${label(to)}` : `Pinned ${label(to)} to the top of the menu`, { undo: () => save(pinned, next) });
  };
  return [pinned, toggle];
}

// The patient the patient modules work on: the one on screen, else the active patient.
function usePatientModules(modules, where) {
  const { patientId, recent } = useActivePatient();
  const navigate = useNavigate();
  const pid = where?.patientId || patientId || null;
  const who = recent.find((r) => r.id === pid);
  const name = pid ? (who ? `${who.preferred_name || who.first_name} ${who.last_name}` : `Patient #${pid}`) : null;
  const hrefFor = (m, tab = m.patient?.tab) => (m.patient && pid ? `/patients/${pid}?tab=${tab}` : null);
  // No patient yet: the command bar asks for one, then opens this module's tab for them.
  const pick = (m, tab) => window.dispatchEvent(new CustomEvent('dm:search', { detail: { pick: { label: m ? m.label : 'the patient modules', tab: tab || m?.patient?.tab || null } } }));
  // Where one click on a module goes.
  const target = (m) => (m.patient ? hrefFor(m) : m.home?.to || m.items.find((p) => p.to)?.to || '/');
  const go = (m) => {
    const to = target(m);
    if (to) navigate(to);
    else pick(m);
  };
  return { pid, name, hrefFor, pick, target, go };
}

// Arrow keys, Home/End between the links of a list; P pins the focused page.
function listKeys(e, box, { onEscape, onPin }) {
  const links = [...box.querySelectorAll('[data-page]')];
  const i = links.indexOf(document.activeElement);
  const focus = (n) => { e.preventDefault(); e.stopPropagation(); links[(n + links.length) % links.length]?.focus(); };
  if (e.key === 'ArrowDown') focus(i + 1);
  else if (e.key === 'ArrowUp') focus(i < 0 ? links.length - 1 : i - 1);
  else if (e.key === 'Home') focus(0);
  else if (e.key === 'End') focus(links.length - 1);
  else if ((e.key === 'Escape' || e.key === 'ArrowLeft') && onEscape) { e.preventDefault(); e.stopPropagation(); onEscape(); }
  else if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey && i >= 0 && links[i].dataset.page !== 'pick') {
    e.preventDefault();
    e.stopPropagation();
    onPin(links[i].dataset.page);
  }
}

function PinButton({ page, pinned, onPin }) {
  if (!pinnable(page)) return null;
  const on = pinned.includes(page.to);
  return (
    <button type="button" tabIndex={-1} className={`rail-pin${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${on ? 'Unpin' : 'Pin'} ${page.label}`} title={on ? 'Unpin (P)' : 'Pin to the top of the menu (P)'} onClick={() => onPin(page.to)}>
      {on ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
    </button>
  );
}

// One dropdown entry: a page, or a tab of the patient's chart (Perio) for the patient modules.
function ItemLink({ module, page, nav, counts, current, className, onDone, showIcon = true }) {
  const Icon = page.icon;
  const href = page.tab ? nav.hrefFor(module, page.tab) : page.to;
  const on = current && itemKey(current) === itemKey(page);
  return (
    <Link
      to={href || '/patients'} className={`${className}${on ? ' active' : ''}`} data-page={itemKey(page)} aria-current={on ? 'page' : undefined}
      aria-keyshortcuts={pinnable(page) ? 'P' : undefined}
      onClick={(e) => { if (!href) { e.preventDefault(); nav.pick(module, page.tab); } onDone?.(); }}
    >
      {showIcon && <Icon size={16} strokeWidth={1.9} aria-hidden />}
      <span className="rail-page-label">{page.label}{page.tab && <span className="rail-tabnote"> · tab</span>}</span>
      <NavBadge badge={page.badge && counts[page.badge]} />
    </Link>
  );
}

// A module's dropdown entries, by section (Manage has several), with the patient they're for.
function Items({ module, nav, counts, current, pinned, onPin, onDone, rowClass, linkClass, showIcon }) {
  return (
    <>
      {module.patient && (
        <div className={rowClass}>
          <button type="button" className={`${linkClass} rail-pick`} data-page="pick" onClick={() => { onDone?.(); nav.pick(module); }}>
            {showIcon && <UserSearch size={16} strokeWidth={1.9} aria-hidden />}
            <span className="rail-page-label">{nav.pid ? 'Another patient…' : 'Choose a patient…'}</span>
          </button>
        </div>
      )}
      {module.sections.map((s) => (
        <div key={s.key} className="rail-fly-section" role="group" aria-label={s.label || module.label}>
          {s.label && <div className="rail-fly-sub">{s.label}</div>}
          {s.pages.map((p) => (
            <div key={itemKey(p)} className={rowClass}>
              <ItemLink module={module} page={p} nav={nav} counts={counts} current={current} className={linkClass} onDone={onDone} showIcon={showIcon} />
              <PinButton page={p} pinned={pinned} onPin={onPin} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// One module: the button (one click goes there), its chevron and its dropdown — a flyout beside the collapsed
// rail, or folded out underneath when the menu is kept open.
function Module({ module, nav, counts, where, railOpen, isOpen, onOpen, onClose, folded, onFold, pinned, onPin }) {
  const wrap = useRef(null);
  const btn = useRef(null);
  const fly = useRef(null);
  const Icon = module.icon;
  const total = rollUp([...(module.home ? [module.home] : []), ...module.items], counts);
  const active = where?.module.key === module.key;
  const href = nav.target(module);
  const id = `rail-fly-${module.key}`;
  const hasItems = module.items.length > 0 || !!module.patient;
  const shown = railOpen ? folded : isOpen;
  const forWho = module.patient ? (nav.name ? ` — ${nav.name}` : ' — choose a patient') : '';
  // Fixed to the window (the rail's list scrolls, which would clip it), beside the module and kept on screen.
  useLayoutEffect(() => {
    if (railOpen || !isOpen || !wrap.current || !fly.current) return;
    const r = wrap.current.getBoundingClientRect();
    const h = fly.current.offsetHeight;
    fly.current.style.left = `${r.right + 8}px`;
    fly.current.style.top = `${Math.max(8, Math.min(r.top - 6, window.innerHeight - h - 8))}px`;
  }, [isOpen, railOpen]);
  const openList = () => {
    if (railOpen) { if (!folded) onFold(module.key); } else onOpen(module.key, true);
    requestAnimationFrame(() => fly.current?.querySelector('[data-page]')?.focus());
  };
  const close = (refocus) => {
    if (railOpen) onFold(module.key, false); else onClose(module.key, true);
    if (refocus) btn.current?.focus();
  };
  return (
    <div
      ref={wrap} className={`rail-mod${shown ? ' open' : ''}${module.patient ? ' rail-mod-pt' : ''}`} data-module={module.key}
      onMouseEnter={() => !railOpen && hasItems && onOpen(module.key)} onMouseLeave={() => !railOpen && onClose(module.key)}
      onBlur={(e) => { if (!railOpen && e.relatedTarget && !wrap.current.contains(e.relatedTarget)) onClose(module.key, true); }}
    >
      <div className="rail-mod-row">
        <Link
          ref={btn} to={href || '/patients'} className={`rail-item rail-mod-btn${active ? ' active' : ''}`}
          aria-label={`${module.label}${forWho}${total ? ` (${total.n})` : ''}`} aria-current={active ? 'page' : undefined}
          aria-keyshortcuts={hasItems ? 'ArrowRight ArrowDown' : undefined}
          onClick={(e) => { if (!href) { e.preventDefault(); nav.pick(module); } if (!railOpen) onClose(module.key, true); }}
          onKeyDown={(e) => {
            if (hasItems && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); openList(); } else if (e.key === 'Escape' && shown) { e.preventDefault(); close(); }
          }}
        >
          <Icon size={19} strokeWidth={1.9} aria-hidden />
          <span className="rail-mod-name">
            <span className="rail-mod-full">{module.label}</span>
            <span className="rail-mod-short" aria-hidden>{module.short || module.label}</span>
          </span>
          <NavBadge badge={total} />
        </Link>
        {hasItems && (
          <button
            type="button" tabIndex={-1} className="rail-mod-chev" aria-label={`More in ${module.label}`} aria-expanded={shown} aria-controls={id}
            title={`More in ${module.label} (→)`}
            onClick={() => (shown ? close() : openList())}
          >
            {railOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          </button>
        )}
      </div>
      {hasItems && (
        <div
          ref={fly} id={id} className={railOpen ? 'rail-mod-items' : `rail-fly${module.sections.length > 2 ? ' wide' : ''}`}
          role="group" aria-label={`More in ${module.label}`} hidden={!shown}
          onKeyDown={(e) => listKeys(e, fly.current, { onEscape: () => close(true), onPin })}
        >
          {!railOpen && (
            <Link to={href || '/patients'} className="rail-fly-head" tabIndex={-1} onClick={(e) => { if (!href) { e.preventDefault(); nav.pick(module); } onClose(module.key, true); }}>
              {module.label}{/* The name only while open: hidden copies of it would be the first match for a page search. */}
              {module.patient && shown && <span className="rail-fly-who">{nav.name || 'No patient chosen'}</span>}
            </Link>
          )}
          <div className="rail-fly-body">
            <Items
              module={module} nav={nav} counts={counts} current={where?.module.key === module.key ? where.page : null} pinned={pinned} onPin={onPin}
              onDone={() => !railOpen && onClose(module.key, true)} rowClass={railOpen ? 'rail-sub-row' : 'rail-fly-row'} linkClass={railOpen ? 'rail-sub' : 'rail-fly-link'} showIcon={!railOpen}
            />
          </div>
          {!railOpen && <div className="rail-fly-foot">↑↓ move · Enter open · P pin · Esc close</div>}
        </div>
      )}
    </div>
  );
}

// Above the patient modules: who they're working on. A click switches patient.
function PatientChip({ nav, where, railOpen }) {
  const initials = nav.name ? nav.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : null;
  const inModule = where?.module.patient ? where.module : null;
  return (
    <button
      type="button" className={`rail-item rail-patient${nav.pid ? '' : ' none'}`} onClick={() => nav.pick(inModule, where?.tab)}
      data-tip={nav.name ? `${nav.name} — switch patient` : 'Choose a patient'} aria-label={nav.name ? `Patient: ${nav.name}. Switch patient` : 'Choose a patient'}
    >
      <span className="rail-patient-dot" aria-hidden>{initials || <UserSearch size={14} />}</span>
      {railOpen && <span className="rail-label"><small>{nav.pid ? 'Patient' : 'No patient'}</small>{nav.name || 'Choose a patient'}</span>}
    </button>
  );
}

function PhoneSheet({ modules, nav, counts, where, pinned, onPin, onClose }) {
  const box = useRef(null);
  useEffect(() => {
    box.current?.querySelector('[data-page]')?.focus();
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="rail-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rail-sheet" role="dialog" aria-modal="true" aria-label="Menu" ref={box} onKeyDown={(e) => listKeys(e, box.current, { onPin })}>
        <div className="rail-sheet-head">
          <strong>Menu</strong>
          {nav.name && <span className="rail-sheet-who">Patient: {nav.name}</span>}
          <button type="button" className="rail-sheet-close" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>
        {modules.map((m) => {
          const Icon = m.icon;
          const href = nav.target(m);
          return (
            <section key={m.key} className={`rail-sheet-group${where?.module.key === m.key ? ' in' : ''}`} data-module={m.key} aria-label={m.label}>
              <Link
                to={href || '/patients'} className="rail-sheet-mod" data-page={`module:${m.key}`}
                onClick={(e) => { onClose(); if (!href) { e.preventDefault(); nav.pick(m); } }}
              >
                <Icon size={18} aria-hidden /> <span>{m.label}</span>
                {m.patient && <span className="rail-sheet-for">{nav.name || 'choose a patient'}</span>}
                <NavBadge badge={rollUp([...(m.home ? [m.home] : []), ...m.items], counts)} />
              </Link>
              {m.items.length > 0 && (
                <div className="rail-sheet-pages">
                  {m.items.map((p) => (
                    <div key={itemKey(p)} className="rail-sub-row">
                      <ItemLink module={m} page={p} nav={nav} counts={counts} current={where?.page} className="rail-sheet-link" onDone={onClose} />
                      <PinButton page={p} pinned={pinned} onPin={onPin} />
                    </div>
                  ))}
                </div>
              )}
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

// The collapsed rail's list can scroll on a short window, and a scroll box clips CSS tooltips, so the labels of
// the pinned icons and the patient chip are drawn here, outside it (the modules have their names and dropdowns).
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
  const modules = useMemo(() => navFor({ can, user, practice }), [can, user, practice]);
  const pages = useMemo(() => allPages(modules), [modules]);
  const items = useMemo(() => modules.flatMap((m) => m.items), [modules]);
  const counts = useNavCounts({
    attention: items.some((p) => p.badge === 'attention'), unread: items.some((p) => p.badge === 'unread'), tasks: items.some((p) => p.badge === 'tasks'),
    checklists: items.some((p) => p.badge === 'checklists'), claims: items.some((p) => p.badge === 'claims'),
  });
  const [pinned, togglePin] = usePins(pages);
  const where = whereAmI(modules, location);
  const nav = usePatientModules(modules, where);

  // "G then a letter" (KeyboardHelp) for the patient modules: the same as a click on the module.
  const goRef = useRef(nav.go);
  goRef.current = nav.go;
  useEffect(() => {
    const onGo = (e) => { const m = modules.find((x) => x.key === e.detail); if (m) goRef.current(m); };
    window.addEventListener('dm:module', onGo);
    return () => window.removeEventListener('dm:module', onGo);
  }, [modules]);

  // One flyout at a time. Opening on hover waits a moment (a pointer passing over on its way to a click doesn't
  // flash menus), but moves straight to a neighbour when one is already open.
  const [openKey, setOpenKey] = useState(null);
  const openRef = useRef(null);
  openRef.current = openKey;
  const timer = useRef(null);
  const openModule = useCallback((key, now) => {
    clearTimeout(timer.current);
    if (now || openRef.current) setOpenKey(key);
    else timer.current = setTimeout(() => setOpenKey(key), OPEN_DELAY);
  }, []);
  const closeModule = useCallback((key, now) => {
    clearTimeout(timer.current);
    const shut = () => setOpenKey((k) => (k === key ? null : k));
    if (now) shut();
    else timer.current = setTimeout(shut, CLOSE_DELAY);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { clearTimeout(timer.current); setOpenKey(null); }, [location.pathname, location.search, railOpen, narrow]);
  useEffect(() => {
    if (!openKey) return undefined;
    const away = (e) => { if (!e.target.closest?.('.rail-mod')) setOpenKey(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpenKey(null); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [openKey]);

  // Folded-out dropdowns (menu kept open): closed until the chevron opens them; remembered on this computer.
  const [folds, setFolds] = useState(() => readJson(FOLD_KEY));
  const fold = (key, on = !folds[key]) => {
    const next = { ...folds, [key]: on };
    setFolds(next);
    writeJson(FOLD_KEY, next);
  };

  const [sheet, setSheet] = useState(false);
  const closeSheet = useCallback(() => setSheet(false), []);
  const everything = rollUp(items, counts);
  const pinnedPages = pinned.map((to) => pages.find((p) => p.to === to)).filter(Boolean);
  const firstPatient = modules.findIndex((m) => m.patient);
  const afterPatients = firstPatient < 0 ? -1 : modules.findIndex((m, i) => i > firstPatient && !m.patient);

  return (
    <aside className={`sidebar rail${narrow ? ' rail-phone' : ''}`} aria-label="Main menu">
      {brand}
      <button className="rail-item" onClick={() => window.dispatchEvent(new Event('dm:search'))} data-tip="Search (Ctrl K)" aria-label="Search">
        <Search size={19} strokeWidth={1.9} aria-hidden /><span className="rail-label">Search <kbd>Ctrl K</kbd></span>
      </button>
      {chat}
      <RailTip />
      <nav className="nav rail-nav" aria-label="Modules" onScroll={() => setOpenKey(null)}>
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
            <span className="rail-menu-text">{where ? (where.page?.label || where.module.label) : 'Menu'}</span>
            <NavBadge badge={everything} />
          </button>
        ) : modules.map((m, i) => (
          <div key={m.key} className={`rail-mod-slot${i === firstPatient ? ' pt-first' : ''}${i === afterPatients ? ' pt-after' : ''}`}>
            {i === firstPatient && <PatientChip nav={nav} where={where} railOpen={railOpen} />}
            <Module
              module={m} nav={nav} counts={counts} where={where} railOpen={railOpen}
              isOpen={openKey === m.key} onOpen={openModule} onClose={closeModule} folded={!!folds[m.key]} onFold={fold} pinned={pinned} onPin={togglePin}
            />
          </div>
        ))}
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
      {narrow && sheet && <PhoneSheet modules={modules} nav={nav} counts={counts} where={where} pinned={pinned} onPin={togglePin} onClose={closeSheet} />}
    </aside>
  );
}
