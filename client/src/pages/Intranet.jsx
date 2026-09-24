import { NavLink, Route, Routes, useParams } from 'react-router-dom';
import { Home as HomeIcon, Link2, BookOpen, GraduationCap, Megaphone } from 'lucide-react';
import IntranetHome from '../components/intranet/Home.jsx';
import LinksPage from '../components/intranet/LinksPage.jsx';
import PagesList from '../components/intranet/PagesList.jsx';
import PageView from '../components/intranet/PageView.jsx';
import PageEditor from '../components/intranet/PageEditor.jsx';
import Onboarding from '../components/intranet/Onboarding.jsx';
import Announcements from '../components/intranet/Announcements.jsx';
import { useAuth } from '../auth.jsx';
import './intranet.css';

// The office intranet: announcements, quick links, the office manual (SOPs) and onboarding.
// Mounted at /intranet/* — every view below is a real address, so Back and bookmarks work.
export default function Intranet() {
  const { can } = useAuth();
  const manager = can('intranet:manage');
  const tab = (to, Icon, label, end) => (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}><Icon size={16} aria-hidden /> {label}</NavLink>
  );
  return (
    <div className="intra">
      <nav className="intra-tabs" aria-label="Intranet">
        {tab('/intranet', HomeIcon, 'Home', true)}
        {tab('/intranet/links', Link2, 'Links')}
        {tab('/intranet/pages', BookOpen, 'Office manual')}
        {tab('/intranet/onboarding', GraduationCap, 'Onboarding')}
        {manager && tab('/intranet/announcements', Megaphone, 'Announcements')}
      </nav>
      <Routes>
        <Route index element={<IntranetHome />} />
        <Route path="links" element={<LinksPage />} />
        <Route path="pages" element={<PagesList />} />
        <Route path="search" element={<PagesList search />} />
        <Route path="sections/:sectionId" element={<PagesList />} />
        <Route path="new" element={<PageEditor />} />
        <Route path="pages/:id" element={<PageView />} />
        <Route path="pages/:id/edit" element={<EditRoute />} />
        <Route path="onboarding" element={<Onboarding />} />
        <Route path="announcements" element={<Announcements />} />
        <Route path="*" element={<IntranetHome />} />
      </Routes>
    </div>
  );
}
function EditRoute() {
  const { id } = useParams();
  return <PageEditor key={id} id={Number(id)} />;
}
