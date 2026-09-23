import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { label } from './format.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import IdleLogout from './components/IdleLogout.jsx';
import { Suspense, lazy, useEffect, useState } from 'react';
import { api } from './api.js';
import { useLiveEvents } from './live.js';
import MfaSetup from './components/MfaSetup.jsx';

// Pages load on demand so the first screen appears quickly.
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientDetail = lazy(() => import('./pages/PatientDetail.jsx'));
const Claims = lazy(() => import('./pages/Claims.jsx'));
const ClaimDetail = lazy(() => import('./pages/ClaimDetail.jsx'));
const Followups = lazy(() => import('./pages/Followups.jsx'));
const Campaigns = lazy(() => import('./pages/Campaigns.jsx'));
const UnsubscribePage = lazy(() => import('./pages/public/UnsubscribePage.jsx'));
const RouteSlip = lazy(() => import('./pages/RouteSlip.jsx'));
const TreatmentPlanPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.TreatmentPlanPrint })));
const PrescriptionPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.PrescriptionPrint })));
const WalkoutPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.WalkoutPrint })));
const ReferralLetterPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.ReferralLetterPrint })));
const Checkout = lazy(() => import('./pages/Checkout.jsx'));
const LabSlipPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.LabSlipPrint })));
const AttachmentCoverPrint = lazy(() => import('./pages/PrintDocs.jsx').then((m) => ({ default: m.AttachmentCoverPrint })));
const CaseAcceptance = lazy(() => import('./pages/public/CaseAcceptance.jsx'));
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
        <Route path="/u/:token" element={<UnsubscribePage />} />
        <Route path="/pay/:result" element={<PayResult />} />
        <Route path="/tp/:token" element={<CaseAcceptance />} />
        <Route path="/portal/:key" element={<Portal />} />
        <Route path="*" element={<StaffApp />} />
      </Routes>
    </Suspense>
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
  const { user, practice, loading, logout, can, refresh } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
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
    ['/', '☀️', 'Today', true],
    ['/schedule', '📅', 'Schedule', can('schedule:read')],
    ['/patients', '🧑‍⚕️', 'Patients', can('patients:read')],
    ['/messages', '💬', 'Messages', can('patients:read')],
    ['/requests', '📥', 'Online requests', can('schedule:read')],
    ['/followups', '📞', 'Follow-up lists', can('schedule:read')],
    ['/campaigns', '📣', 'Campaigns', can('patients:write')],
    ['/claims', '🧾', 'Billing', can('billing:read')],
    ['/office', '✅', 'To-do & labs', true],
    ['/reports', '📈', 'Reports', can('reports:read')],
    ['/settings', '⚙️', 'Settings', true],
  ];

  return (
    <Routes>
      <Route path="/appointments/:id/route-slip" element={<RouteSlip />} />
      <Route path="/treatment-plans/:id/print" element={<TreatmentPlanPrint />} />
      <Route path="/prescriptions/:id/print" element={<PrescriptionPrint />} />
      <Route path="/lab-cases/:id/slip" element={<LabSlipPrint />} />
      <Route path="/claims/:id/attachments/print" element={<AttachmentCoverPrint />} />
      <Route path="/appointments/:id/walkout" element={<WalkoutPrint />} />
      <Route path="/referrals/:id/letter" element={<ReferralLetterPrint />} />
      <Route path="*" element={<Shell nav={nav} />} />
    </Routes>
  );
}

function Shell({ nav }) {
  const { user, practice, logout } = useAuth();
  return (
    <div className="app">
      <CommandPalette />
      <IdleLogout />
      <aside className="sidebar">
        <div className="brand">
          <span>🦷</span>
          <div>
            Dental Machine
            <small>{practice?.name}</small>
          </div>
        </div>
        <button className="search-trigger" onClick={() => window.dispatchEvent(new Event('dm:search'))}>
          🔍 Search <kbd>Ctrl K</kbd>
        </button>
        <nav className="nav">
          {nav.filter((n) => n[3]).map(([to, icon, text]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <span aria-hidden>{icon}</span> {text}
              {to === '/messages' && <UnreadBadge />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: '#fff' }}>{user.name}</div>
          <div>{label(user.role)}</div>
          <button className="small" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/checkout/:id" element={<Checkout />} />
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
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
