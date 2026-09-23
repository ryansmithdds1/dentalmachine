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

export default function App() {
  const { user, practice, loading, logout, can } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  const nav = [
    ['/', '📊', 'Dashboard', true],
    ['/schedule', '📅', 'Schedule', can('schedule:read')],
    ['/patients', '🧑‍⚕️', 'Patients', can('patients:read')],
    ['/recalls', '🔔', 'Recall', can('schedule:read')],
    ['/claims', '🧾', 'Claims', can('billing:read')],
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
