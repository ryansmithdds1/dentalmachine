import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import MyChecklist from '../components/checklists/MyChecklist.jsx';
import ChecklistDashboard from '../components/checklists/Dashboard.jsx';
import ChecklistSetup from '../components/checklists/Setup.jsx';
import ChecklistLog, { ChecklistLogPrint } from '../components/checklists/Log.jsx';
import '../components/checklists/checklists.css';

// Recurring checklists by position (RCL1–RCL3; docs/workflows/specs/RCL-checklists.md), mounted at /checklists/*.
// Everyone: My checklist. Owners and office managers (checklists:manage): dashboard, setup and the compliance log.
export default function Checklists() {
  const { can } = useAuth();
  const manager = can('checklists:manage');
  const { pathname } = useLocation();
  const nav = useNavigate();
  const tabs = [['/checklists', 'My checklist'], ['/checklists/dashboard', 'Dashboard'], ['/checklists/setup', 'Set up'], ['/checklists/log', 'Compliance log']];
  const here = tabs.slice(1).find(([to]) => pathname.startsWith(to))?.[0] || '/checklists';
  return (
    <div className="cl-page">
      {manager && (
        <nav className="tabs no-print" aria-label="Checklists">
          {tabs.map(([to, label]) => <button key={to} className={here === to ? 'active' : ''} aria-current={here === to ? 'page' : undefined} onClick={() => nav(to)}>{label}</button>)}
        </nav>
      )}
      <Routes>
        <Route index element={<MyChecklist />} />
        {manager && <Route path="dashboard" element={<ChecklistDashboard />} />}
        {manager && <Route path="setup" element={<ChecklistSetup />} />}
        {manager && <Route path="log" element={<ChecklistLog />} />}
        {manager && <Route path="log/print" element={<ChecklistLogPrint />} />}
        <Route path="*" element={<Navigate to="/checklists" replace />} />
      </Routes>
    </div>
  );
}
