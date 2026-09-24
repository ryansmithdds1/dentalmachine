import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './errors.jsx';
import { useAuth } from './auth.jsx';
import { label } from './format.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Toasts from './components/Toasts.jsx';
import PatientBar from './components/PatientBar.jsx';
import { ActivePatientProvider } from './activePatient.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import IntranetCommands from './components/intranet/IntranetCommands.jsx';
import QuickCommands, { TaskBadge } from './components/QuickCommands.jsx';
import ChatPanel from './components/chat/ChatPanel.jsx';
import ChatBadge from './components/chat/ChatBadge.jsx';
import UrgentBanner from './components/chat/UrgentBanner.jsx';
import Assistant from './components/assistant/Assistant.jsx';
import CallPop from './components/CallPop.jsx';
import KeyboardHelp from './components/KeyboardHelp.jsx';
import IdleLogout from './components/IdleLogout.jsx';
import { Suspense, lazy, useEffect, useState } from 'react';
import { api, getLocationId, setLocationId } from './api.js';
import { readOfflineDay } from './offline.js';
import OfflineBanner from './offline/OfflineBanner.jsx';
import { pendingCount } from './offline/index.js';
import { ClockButton } from './components/TimeClock.jsx';
import { useLiveEvents } from './live.js';
import MfaSetup from './components/MfaSetup.jsx';
import { Sun, CalendarDays, Users, MessageSquare, Inbox as InboxIcon, PhoneCall, Megaphone, Receipt, ListChecks, ChartColumn, Landmark, Settings as SettingsIcon, Search, PanelLeftClose, PanelLeftOpen, LogOut, Keyboard, Monitor, Moon, Sparkles, Phone, Building2, Star, HelpCircle, AlertTriangle, BookOpen, Clock, Banknote, Gauge, Repeat, ShieldCheck } from 'lucide-react';
import { getThemePref, setThemePref, watchTheme } from './theme.js';

// Pages load on demand so the first screen appears quickly.
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientDetail = lazy(() => import('./pages/PatientDetail.jsx'));
const Claims = lazy(() => import('./pages/Claims.jsx'));
const ClaimDetail = lazy(() => import('./pages/ClaimDetail.jsx'));
const Followups = lazy(() => import('./pages/Followups.jsx'));
const Finance = lazy(() => import('./pages/Finance.jsx'));
const Ask = lazy(() => import('./pages/Ask.jsx'));
const Calls = lazy(() => import('./pages/Calls.jsx'));
const Group = lazy(() => import('./pages/Group.jsx'));
const Intranet = lazy(() => import('./pages/Intranet.jsx'));
const IntakeReview = lazy(() => import('./components/IntakeReview.jsx'));
const Reputation = lazy(() => import('./pages/Reputation.jsx'));
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
const Attention = lazy(() => import('./pages/Attention.jsx'));
const AttentionBadge = lazy(() => import('./pages/Attention.jsx').then((m) => ({ default: m.AttentionBadge })));
const Inbox = lazy(() => import('./pages/Inbox.jsx'));
const Office = lazy(() => import('./pages/Office.jsx'));
const TimeClockPage = lazy(() => import('./pages/TimeClock.jsx'));
const TimeClockKiosk = lazy(() => import('./pages/TimeClock.jsx').then((m) => ({ default: m.Kiosk })));
const Deposits = lazy(() => import('./pages/Deposits.jsx'));
const BookingPage = lazy(() => import('./pages/public/BookingPage.jsx'));
const ConfirmPage = lazy(() => import('./pages/public/ConfirmPage.jsx'));
const IntakePage = lazy(() => import('./pages/public/IntakePage.jsx'));
const ReviewPage = lazy(() => import('./pages/public/ReviewPage.jsx'));
const SurveyPage = lazy(() => import('./pages/public/SurveyPage.jsx'));
const PayResult = lazy(() => import('./pages/public/PayResult.jsx'));
const LabCasePage = lazy(() => import('./pages/public/LabCasePage.jsx'));
const LearnPage = lazy(() => import('./pages/public/LearnPage.jsx'));
const RecallBook = lazy(() => import('./pages/public/RecallBook.jsx'));
const Recall = lazy(() => import('./pages/Recall.jsx'));
const Metrics = lazy(() => import('./pages/Metrics.jsx'));
const ChartAudit = lazy(() => import('./pages/ChartAudit.jsx'));
const CheckinPage = lazy(() => import('./pages/public/CheckinPage.jsx'));
const StatusPage = lazy(() => import('./pages/public/StatusPage.jsx'));
const Help = lazy(() => import('./pages/Help.jsx'));

// Patient-facing pages work without a staff login.
export default function App() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Routes>
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/c/:token" element={<ConfirmPage />} />
        <Route path="/lab/:token" element={<LabCasePage />} />
        <Route path="/learn/:practice/:slug" element={<LearnPage />} />
        <Route path="/checkin/:practice" element={<CheckinPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/f/:token" element={<IntakePage />} />
        <Route path="/r/:token" element={<ReviewPage />} />
        <Route path="/s/:token" element={<SurveyPage />} />
        <Route path="/u/:token" element={<UnsubscribePage />} />
        <Route path="/pay/:result" element={<PayResult />} />
        <Route path="/tp/:token" element={<CaseAcceptance />} />
        <Route path="/scan/:token" element={<PhoneUpload />} />
        <Route path="/portal/:key" element={<Portal />} />
        <Route path="/timeclock/kiosk" element={<TimeClockKiosk />} />
        <Route path="/rb/:token" element={<RecallBook />} />
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

// Staging and demo servers say so on every screen, so nobody mistakes test data for the real practice.
function EnvironmentBanner() {
  const [env, setEnv] = useState(null);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((d) => setEnv(d.environment)).catch(() => {}); }, []);
  if (env !== 'staging' && env !== 'demo') return null;
  return <div className="env-banner no-print">{env === 'staging' ? 'Staging server — test data only. Nothing here reaches real patients, payers or card processors.' : 'Demo server — sample data, sandbox integrations.'}</div>;
}

// First sign-in after an administrator set (or reset) the password.
function OwnPassword() {
  const { adoptSession } = useAuth();
  const [f, setF] = useState({ current_password: '', new_password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/auth/change-password', f);
      await adoptSession(res.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <div className="error">{error}</div>}
      <label>Temporary password<input type="password" required autoComplete="current-password" value={f.current_password} onChange={(e) => setF({ ...f, current_password: e.target.value })} /></label>
      <label>New password (at least 10 characters)<input type="password" required minLength={10} autoComplete="new-password" value={f.new_password} onChange={(e) => setF({ ...f, new_password: e.target.value })} /></label>
      <button className="primary" disabled={busy}>Save and continue</button>
    </form>
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
  if (offline && !user) return <OfflineSchedule onRetry={refresh} />;
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

  if (user.password_change_required) {
    return (
      <div className="auth-page">
        <div className="card auth-card" style={{ maxWidth: 480 }}>
          <h1>Choose your own password</h1>
          <p className="muted">An administrator set a temporary password for you. Pick one only you know to continue.</p>
          <OwnPassword />
          <button className="link" style={{ marginTop: 12 }} onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  const nav = [
    ['/', Sun, 'Today', true],
    ['/attention', AlertTriangle, 'Needs attention', can('patients:read')],
    ['/chart-audit', ShieldCheck, 'Chart audit', can('clinical:read')],
    ['/schedule', CalendarDays, 'Schedule', can('schedule:read')],
    ['/patients', Users, 'Patients', can('patients:read')],
    ['/messages', MessageSquare, 'Messages', can('patients:read')],
    ['/requests', InboxIcon, 'Online requests', can('schedule:read')],
    ['/calls', Phone, 'Calls', can('patients:read')],
    ['/followups', PhoneCall, 'Follow-up lists', can('schedule:read')],
    ['/recall', Repeat, 'Recall autopilot', can('schedule:read')],
    ['/metrics', Gauge, 'Metrics', can('reports:read') || can('reports:own')],
    ['/campaigns', Megaphone, 'Campaigns', can('patients:write')],
    ['/reputation', Star, 'Reviews', can('patients:read')],
    ['/claims', Receipt, 'Billing', can('billing:read')],
    ['/office', ListChecks, 'To-do & labs', true],
    ['/timeclock', Clock, 'Time clock', true],
    ['/deposits', Banknote, 'Deposits & cash', can('billing:read')],
    ['/intranet', BookOpen, 'Intranet', true],
    ['/reports', ChartColumn, 'Reports', can('reports:read')],
    ['/ask', Sparkles, 'Ask your data', can('reports:read')],
    ['/finance', Landmark, 'Finance', can('finance:read')],
    ['/group', Building2, 'Group', user.role === 'admin' || !!practice?.org_role],
    ['/settings', SettingsIcon, 'Settings', true],
    ['/help', HelpCircle, 'Help', true],
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
      <Route path="*" element={<ActivePatientProvider><Shell nav={nav} /></ActivePatientProvider>} />
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
          <button className="menu-item" onClick={() => (!pendingCount() || window.confirm(`${pendingCount()} change(s) made offline haven’t been sent yet. They stay locked on this computer and are sent the next time you sign in here. Sign out?`)) && logout()}><LogOut size={16} /> Sign out</button>
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
      <IntranetCommands />
      <QuickCommands />
      <KeyboardHelp />
      <Toasts />
      <Assistant />
      <CallPop />
      <ChatPanel />
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
        <ChatBadge />
        <nav className="nav rail-nav">
          {nav.filter((n) => n[3]).map(([to, Icon, text]) => (
            <NavLink key={to} to={to} end={to === '/'} className="rail-item" data-tip={text} aria-label={text}>
              <Icon size={19} strokeWidth={1.9} aria-hidden />
              <span className="rail-label">{text}</span>
              {to === '/messages' && <UnreadBadge />}
              {to === '/attention' && <Suspense fallback={null}><AttentionBadge /></Suspense>}
              {to === '/office' && <TaskBadge />}
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
        <EnvironmentBanner />
        <UrgentBanner />
        <OfflineBanner />
        {user.role === 'admin' && practice?.setup_status === 'pending' && location.pathname !== '/setup' && (
          <div className="setup-banner no-print">Finish setting up {practice.name} — providers, fees, insurance and reminders. <NavLink to="/setup">Continue setup →</NavLink></div>
        )}
        {user.role === 'admin' && practice?.setup_status === 'pending' && location.pathname === '/' && !seenSetup() && <Navigate to="/setup" replace />}
        <PatientBar />
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
            <Route path="/recall" element={<Recall />} />
            <Route path="/metrics" element={<Metrics />} />
            <Route path="/chart-audit" element={<ChartAudit />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/recalls" element={<Navigate to="/followups" replace />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/attention" element={<Attention />} />
            <Route path="/messages" element={<Inbox />} />
            <Route path="/office" element={<Office />} />
            <Route path="/timeclock" element={<TimeClockPage />} />
            <Route path="/deposits" element={<Deposits />} />
            <Route path="/claims" element={<Claims />} />
            <Route path="/claims/:id" element={<ClaimDetail />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/group" element={<Group />} />
            <Route path="/reputation" element={<Reputation />} />
            <Route path="/help" element={<Help />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/intranet/*" element={<Intranet />} />
            <Route path="/intake" element={<><div className="page-header"><h1>Sent in online</h1></div><IntakeReview /></>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
