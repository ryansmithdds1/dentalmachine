import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './errors.jsx';
import { useAuth } from './auth.jsx';
import { label } from './format.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Assistant from './components/assistant/Assistant.jsx';
import KeyboardHelp from './components/KeyboardHelp.jsx';
import IdleLogout from './components/IdleLogout.jsx';
import { Suspense, lazy, useEffect, useState } from 'react';
import { api, getLocationId, setLocationId } from './api.js';
import { readOfflineDay } from './offline.js';
import { ClockButton } from './components/TimeClock.jsx';
import { useLiveEvents } from './live.js';
import MfaSetup from './components/MfaSetup.jsx';
import { Sun, CalendarDays, Users, MessageSquare, Inbox as InboxIcon, PhoneCall, Megaphone, Receipt, ListChecks, ChartColumn, Landmark, Settings as SettingsIcon, Search, PanelLeftClose, PanelLeftOpen, LogOut, Keyboard, Monitor, Moon } from 'lucide-react';
import { getThemePref, setThemePref, watchTheme } from './theme.js';

// Pages load on demand so the first screen appears quickly.
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientDetail = lazy(() => import('./pages/PatientDetail.jsx'));
const Claims = lazy(() => import('./pages/Claims.jsx'));
const ClaimDetail = lazy(() => import('./pages/ClaimDetail.jsx'));
const Followups = lazy(() => import('./pages/Followups.jsx'));
const Finance = lazy(() => import('./pages/Finance.jsx'));
const Campaigns = lazy(() => import('./pages/Campaigns.jsx'));
const UnsubscribePage = lazy(() => import('./pages/public/UnsubscribePage.jsx'));
const RouteSlip = lazy(() => import('./pages/RouteSlip.jsx'));
const SchedulePrint = lazy(() => import('./pages/SchedulePrint.jsx'));
const NotesPrint = lazy(() => import('./pages/NotesPrint.jsx'));
const AdaClaimForm = lazy(() => import('./pages/AdaClaimForm.jsx'));
const Setup = lazy(() => import('./pages/Setup.jsx'));
const TreatmentPlanPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.TreatmentPlanPrint })));
const PrescriptionPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.PrescriptionPrint })));
const WalkoutPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.WalkoutPrint })));
const ReferralLetterPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.ReferralLetterPrint })));
const Checkout = lazy(() => import('./pages/Checkout.jsx'));
const LabSlipPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.LabSlipPrint })));
const DepositSlipPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.DepositSlipPrint })));
const CollectionLetterPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.CollectionLetterPrint })));
const AttachmentCoverPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.AttachmentCoverPrint })));
const CaseAcceptance = lazy(() => import('./pages/public/CaseAcceptance.jsx'));
const PhoneUpload = lazy(() => import('./pages/public/PhoneUpload.jsx'));
const Portal = lazy(() => import('./pages/public/Portal.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Statement = lazy(() => import('./pages/Statement.jsx'));
const Requests = lazy(() => import('./pages/Requests.jsx'));
const Inbox = lazy(() => import('./pages/Inbox.jsx'));
const Office = lazy(() => import('./pages/Office.jsx'));
const BookingPage = lazy(() => import('./pages/public/BookingPage.jsx'));
const ConfirmPage = lazy(() => import('./pages/public/ConfirmPage.jsx'));
const IntakePage = lazy(() => import('./pages/public/IntakePage.jsx'));
const ReviewPage = lazy(() => import('./pages/public/ReviewPage.jsx'));
const SurveyPage = lazy(() => import('./pages/public/SurveyPage.jsx'));
const PayResult = lazy(() => import('./pages/public/PayResult.jsx'));

// Patient-facing pages work without a staff login.
export default function App() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Routes>
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/c/:token" element={<ConfirmPage />} />
        <Route path="/f/:token" element={<IntakePage />} />
        <Route path="/r/:token" element={<ReviewPage />} />
        <Route path="/s/:token" element={<SurveyPage />} />
        <Route path="/u/:token" element={<UnsubscribePage />} />
        <Route path="/pay/:result" element={<PayResult />} />
        <Route path="/tp/:token" element={<CaseAcceptance />} />
        <Route path="/scan/:token" element={<PhoneUpload />} />
        <Route path="/portal/:key" element={<Portal />} />
        <Route path="*" element={<StaffApp />} />
      </Routes>
    </Suspense>
  );
}

// No connection: the last copy of today's schedule saved on this computer, read-only.
function OfflineSchedule({ onRetry }) {
  const day = readOfflineDay();
  const today = new Date().toLocaleDateString('en-CA');
  return (
    <div className="offline-page">
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0 }}>You’re offline</h1>
            <div className="muted">Dental Machine can’t reach the internet. {day ? `Here’s ${day.date === today ? 'today’s' : `the ${day.date}`} schedule as of ${new Date(day.saved_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — read-only.` : 'Open the schedule while online and today’s list will be kept here for times like this.'}</div>
          </div>
          <button className="primary" onClick={onRetry}>Try again</button>
        </div>
        {day && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Time</th><th>Patient</th><th>Visit</th><th>Provider</th><th>Chair</th><th>Phone</th></tr></thead>
            <tbody>
              {day.visits.map((v, i) => (
                <tr key={i}><td>{v.start}–{v.end}</td><td>{v.alert ? '⚠ ' : ''}{v.name}</td><td>{v.reason}</td><td>{v.provider}</td><td>{v.chair}</td><td>{v.phone}</td></tr>
              ))}
              {!day.visits.length && <tr><td colSpan={6} className="muted">No visits.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function UnreadBadge() {
  const [n, setN] = useState(0);
  const load = () => api.get('/conversations/unread').then((r) => setN(r.unread)).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useLiveEvents((e) => e.type === 'message' && load());
  return n > 0 ? <span className="nav-badge">{n}</span> : null;
}

function StaffApp() {
  const { user, practice, loading, offline, logout, can, refresh } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
  if (offline) return <OfflineSchedule onRetry={refresh} />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  if (user.mfa_setup_required) {
    return (
      <div className="auth-page">
        <div className="card auth-card" style={{ maxWidth: 480 }}>
          <h1>Secure your account</h1>
          <p className="muted">{practice?.name} requires two-factor authentication. Set it up to continue.</p>
          <MfaSetup onDone={refresh} />
          <button className="link" style={{ marginTop: 12 }} onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  const nav = [
    ['/', Sun, 'Today', true],
    ['/schedule', CalendarDays, 'Schedule', can('schedule:read')],
    ['/patients', Users, 'Patients', can('patients:read')],
    ['/messages', MessageSquare, 'Messages', can('patients:read')],
    ['/requests', InboxIcon, 'Online requests', can('schedule:read')],
    ['/followups', PhoneCall, 'Follow-up lists', can('schedule:read')],
    ['/campaigns', Megaphone, 'Campaigns', can('patients:write')],
    ['/claims', Receipt, 'Billing', can('billing:read')],
    ['/office', ListChecks, 'To-do & labs', true],
    ['/reports', ChartColumn, 'Reports', can('reports:read')],
    ['/finance', Landmark, 'Finance', can('finance:read')],
    ['/settings', SettingsIcon, 'Settings', true],
  ];

  return (
    <Routes>
      <Route path="/appointments/:id/route-slip" element={<RouteSlip />} />
      <Route path="/schedule/print" element={<SchedulePrint />} />
      <Route path="/patients/:id/notes/print" element={<NotesPrint />} />
      <Route path="/treatment-plans/:id/print" element={<TreatmentPlanPrint />} />
      <Route path="/prescriptions/:id/print" element={<PrescriptionPrint />} />
      <Route path="/lab-cases/:id/slip" element={<LabSlipPrint />} />
      <Route path="/claims/:id/attachments/print" element={<AttachmentCoverPrint />} />
      <Route path="/claims/:id/ada" element={<AdaClaimForm />} />
      <Route path="/collections/:id/letter" element={<CollectionLetterPrint />} />
      <Route path="/deposits/:id/slip" element={<DepositSlipPrint />} />
      <Route path="/appointments/:id/walkout" element={<WalkoutPrint />} />
      <Route path="/referrals/:id/letter" element={<ReferralLetterPrint />} />
      <Route path="*" element={<Shell nav={nav} />} />
    </Routes>
  );
}

// Multi-location: which office this screen works in. Changing it reloads so every view follows.
function LocationPicker({ user }) {
  const list = user.locations || [];
  if (!list.length) return null;
  const saved = getLocationId();
  const current = list.some((l) => String(l.id) === saved) ? saved : user.all_locations ? '' : String(list[0].id);
  if (current !== saved) setLocationId(current);
  return (
    <label className="location-picker">
      <span className="sr-only">Office</span>
      <select value={current} onChange={(e) => { setLocationId(e.target.value); window.location.reload(); }} aria-label="Office">
        {user.all_locations && <option value="">All offices</option>}
        {list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  );
}

// A new office's admin lands on the setup wizard once per session; the banner stays until it's finished.
const seenSetup = () => {
  try {
    if (sessionStorage.getItem('dm_setup_seen')) return true;
    sessionStorage.setItem('dm_setup_seen', '1');
  } catch { /* storage unavailable: just show the banner */ return true; }
  return false;
};

// The navigation rail: icons only by default so the schedule gets the screen, labels on hover, and a
// pin to keep it open (remembered on this computer). You, your office, the time clock and sign-out live
// in the menu under your initials.
const railPref = () => {
  try {
    return localStorage.getItem('dm_nav_open') === '1';
  } catch {
    return false;
  }
};
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function UserMenu({ user, practice, logout }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(getThemePref);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest?.('.user-menu')) setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div className="user-menu">
      <button className="rail-item user-button" onClick={() => setOpen(!open)} aria-expanded={open} data-tip={user.name}>
        <span className="rail-avatar">{initials(user.name)}</span>
        <span className="rail-label">{user.name}<small>{label(user.role)}</small></span>
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <div className="user-pop-head">
            <span className="rail-avatar big">{initials(user.name)}</span>
            <div><strong>{user.name}</strong><div className="muted">{label(user.role)} · {practice?.name}</div></div>
          </div>
          <div className="seg theme-seg" role="group" aria-label="Appearance">
            {[['system', Monitor, 'Auto'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']].map(([k, Icon, text]) => (
              <button key={k} className={theme === k ? 'active' : ''} onClick={() => { setTheme(k); setThemePref(k); }} title={k === 'system' ? "Follow this computer's setting" : undefined}><Icon size={14} /> {text}</button>
            ))}
          </div>
          <LocationPicker user={user} />
          <ClockButton />
          <button className="menu-item" onClick={() => { setOpen(false); window.dispatchEvent(new Event('dm:shortcuts')); }}><Keyboard size={16} /> Keyboard shortcuts <kbd>?</kbd></button>
          <button className="menu-item" onClick={logout}><LogOut size={16} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function Shell({ nav }) {
  const location = useLocation();
  const { user, practice, logout } = useAuth();
  const [railOpen, setRailOpen] = useState(railPref);
  const toggleRail = () => setRailOpen((o) => {
    try { localStorage.setItem('dm_nav_open', o ? '0' : '1'); } catch { /* storage unavailable */ }
    return !o;
  });
  const fullBleed = location.pathname === '/schedule';
  useEffect(() => watchTheme(), []);
  return (
    <div className={`app${railOpen ? ' rail-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <CommandPalette />
      <KeyboardHelp />
      <Assistant />
      <IdleLogout />
      <aside className="sidebar rail">
        <div className="rail-brand" title={practice?.name}>
          <span className="rail-logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3c-2.5 0-4 2-4 4.5 0 3 1.5 4.5 2 7.5.4 2.6 1 6 2.7 6 1.8 0 1.5-4.5 3-6.2.5-.5 1.1-.5 1.6 0 1.5 1.7 1.2 6.2 3 6.2 1.7 0 2.3-3.4 2.7-6 .5-3 2-4.5 2-7.5C21 5 19.5 3 17 3c-2 0-3 1-5 1S9 3 7 3Z" /></svg>
          </span>
          <span className="rail-label">Dental Machine<small>{practice?.name}</small></span>
        </div>
        <button className="rail-item" onClick={() => window.dispatchEvent(new Event('dm:search'))} data-tip="Search (Ctrl K)">
          <Search size={19} strokeWidth={1.9} /><span className="rail-label">Search <kbd>Ctrl K</kbd></span>
        </button>
        <nav className="nav rail-nav">
          {nav.filter((n) => n[3]).map(([to, Icon, text]) => (
            <NavLink key={to} to={to} end={to === '/'} className="rail-item" data-tip={text} aria-label={text}>
              <Icon size={19} strokeWidth={1.9} aria-hidden />
              <span className="rail-label">{text}</span>
              {to === '/messages' && <UnreadBadge />}
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <button className="rail-item" onClick={toggleRail} data-tip={railOpen ? 'Collapse menu' : 'Keep menu open'} aria-label={railOpen ? 'Collapse menu' : 'Expand menu'}>
            {railOpen ? <PanelLeftClose size={19} strokeWidth={1.9} /> : <PanelLeftOpen size={19} strokeWidth={1.9} />}
            <span className="rail-label">Collapse</span>
          </button>
          <UserMenu user={user} practice={practice} logout={logout} />
        </div>
      </aside>
      <main className={`main${fullBleed ? ' full-bleed' : ''}`} id="main" tabIndex={-1}>
        {user.role === 'admin' && practice?.setup_status === 'pending' && location.pathname !== '/setup' && (
          <div className="setup-banner no-print">Finish setting up {practice.name} — providers, fees, insurance and reminders. <NavLink to="/setup">Continue setup →</NavLink></div>
        )}
        {user.role === 'admin' && practice?.setup_status === 'pending' && location.pathname === '/' && !seenSetup() && <Navigate to="/setup" replace />}
        <ErrorBoundary key={location.pathname}>
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/checkout/:id" element={<Checkout />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/patients" element={<Patients />} />
            <Route path="/patients/:id" element={<PatientDetail />} />
            <Route path="/patients/:id/statement" element={<Statement />} />
            <Route path="/followups" element={<Followups />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/recalls" element={<Navigate to="/followups" replace />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/messages" element={<Inbox />} />
            <Route path="/office" element={<Office />} />
            <Route path="/claims" element={<Claims />} />
            <Route path="/claims/:id" element={<ClaimDetail />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
