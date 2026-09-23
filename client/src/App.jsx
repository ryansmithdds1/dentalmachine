import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { label } from './format.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Schedule from './pages/Schedule.jsx';
import Patients from './pages/Patients.jsx';
import PatientDetail from './pages/PatientDetail.jsx';
import Claims from './pages/Claims.jsx';
import ClaimDetail from './pages/ClaimDetail.jsx';
import Recalls from './pages/Recalls.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import Statement from './pages/Statement.jsx';
import Requests from './pages/Requests.jsx';
import Inbox from './pages/Inbox.jsx';
import Office from './pages/Office.jsx';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useLiveEvents } from './live.js';
import MfaSetup from './components/MfaSetup.jsx';
import BookingPage from './pages/public/BookingPage.jsx';
import ConfirmPage from './pages/public/ConfirmPage.jsx';
import IntakePage from './pages/public/IntakePage.jsx';
import PayResult from './pages/public/PayResult.jsx';

// Patient-facing pages work without a staff login.
export default function App() {
  return (
    <Routes>
      <Route path="/book/:slug" element={<BookingPage />} />
      <Route path="/c/:token" element={<ConfirmPage />} />
      <Route path="/f/:token" element={<IntakePage />} />
      <Route path="/pay/:result" element={<PayResult />} />
      <Route path="*" element={<StaffApp />} />
    </Routes>
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
    ['/', '📊', 'Dashboard', true],
    ['/schedule', '📅', 'Schedule', can('schedule:read')],
    ['/patients', '🧑‍⚕️', 'Patients', can('patients:read')],
    ['/messages', '💬', 'Messages', can('patients:read')],
    ['/requests', '📥', 'Online requests', can('schedule:read')],
    ['/recalls', '🔔', 'Recall', can('schedule:read')],
    ['/claims', '🧾', 'Billing', can('billing:read')],
    ['/office', '✅', 'To-do & labs', true],
    ['/reports', '📈', 'Reports', can('reports:read')],
    ['/settings', '⚙️', 'Settings', true],
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span>🦷</span>
          <div>
            Dental Machine
            <small>{practice?.name}</small>
          </div>
        </div>
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
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/patients/:id" element={<PatientDetail />} />
          <Route path="/patients/:id/statement" element={<Statement />} />
          <Route path="/recalls" element={<Recalls />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/messages" element={<Inbox />} />
          <Route path="/office" element={<Office />} />
          <Route path="/claims" element={<Claims />} />
          <Route path="/claims/:id" element={<ClaimDetail />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
