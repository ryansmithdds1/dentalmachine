import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Keyboard, Printer } from 'lucide-react';
import { useAuth } from '../../auth.jsx';
import { ROLES, loadManual, searchManual } from './manualData.js';
import ManualPage from './ManualPage.jsx';
import ManualBook from './ManualBook.jsx';
import './manual.css';

// Help → How do I…: every office task as a page with steps and screenshots (the user manual). Search it, or
// browse it by role or by area, most frequent first. /help?how=A084 opens one page; /help?q=deposit searches;
// /help?how=all shows every page to print (&print=1 opens the print box once the pictures are in).
// The staff member's own role is shown first (open); everyone's jobs are in every role's list.
const MY_ROLE = { front_desk: 'front desk', billing: 'billing', dentist: 'dentist', hygienist: 'hygienist', assistant: 'assistant', admin: 'office manager' };

export default function ManualBrowser({ how, q, print, setParams }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [by, setBy] = useState('role');
  useEffect(() => { loadManual().then(setData, setError); }, []);
  const pages = useMemo(() => data?.pages || [], [data]);
  const found = useMemo(() => (q.trim() ? searchManual(pages, q) : null), [pages, q]);
  const page = how ? pages.find((p) => p.id === how) : null;
  useEffect(() => { if (page) window.scrollTo?.(0, 0); }, [page]);

  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <div className="empty">Loading the manual…</div>;
  if (how === 'all') return <ManualBook pages={pages} autoPrint={print} onBack={() => setParams({})} />;
  if (how && page) return <ManualPage page={page} onBack={() => (window.history.length > 1 ? nav(-1) : setParams({ q }))} />;

  const mine = MY_ROLE[user?.role];
  const groups = by === 'role'
    ? [...ROLES].sort(([a], [b]) => (b === mine) - (a === mine)).map(([key, label]) => ({ key, label: key === mine ? `${label} (you)` : label, list: pages.filter((p) => p.roles.includes(key) || (key !== 'everyone' && p.roles.includes('everyone'))) }))
    : [...new Set(pages.map((p) => p.area))].map((area) => ({ key: area, label: pages.find((p) => p.area === area).areaLabel, list: pages.filter((p) => p.area === area) }));
  const row = (p) => (
    <li key={p.id}>
      <Link to={`/help?how=${p.id}`}>{p.q}</Link>
      {p.keyboard && <Keyboard size={13} className="manual-row-kbd" aria-label="works from the keyboard alone" />}
      <span className="muted manual-row-where"> · {p.where}</span>
    </li>
  );
  return (
    <div className="manual-browser">
      <input
        type="search" autoFocus placeholder="How do I… (e.g. post a deposit, void a payment, add a provider)" aria-label="Search the how-tos"
        value={q} onChange={(e) => setParams({ q: e.target.value }, { replace: true })}
        onKeyDown={(e) => { if (e.key === 'Enter' && found?.[0]) nav(`/help?how=${found[0].id}`); }}
      />
      {found ? (
        <div className="card">
          {found.length ? <ol className="manual-list manual-results">{found.map(row)}</ol> : <div className="empty">No how-to matches “{q}”. Try fewer words, or press ? on any screen for its keys.</div>}
        </div>
      ) : (
        <>
          <div className="manual-by no-print" role="group" aria-label="Group the how-tos">
            <span className="muted">{pages.length} how-tos, most frequent first · by</span>
            <button type="button" className={`small${by === 'role' ? ' active' : ''}`} aria-pressed={by === 'role'} onClick={() => setBy('role')}>role</button>
            <button type="button" className={`small${by === 'area' ? ' active' : ''}`} aria-pressed={by === 'area'} onClick={() => setBy('area')}>area</button>
            <span style={{ flex: 1 }} />
            <Link to="/help?how=all&print=1"><button type="button" className="small"><Printer size={14} aria-hidden /> Print the whole manual</button></Link>
          </div>
          <div className="manual-groups">
            {groups.filter((g) => g.list.length).map((g) => (
              <details key={g.key} className="card manual-group" open={by === 'role' ? g.key === mine || (!mine && g.key === 'front desk') : true}>
                <summary><strong>{g.label}</strong> <span className="muted">{g.list.length}</span></summary>
                <ul className="manual-list">{g.list.map(row)}</ul>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
