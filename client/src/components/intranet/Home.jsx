import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Pin, BookOpen, CheckCircle2, Megaphone, CalendarClock, ChevronRight, Plus, Sparkles, FolderOpen, GraduationCap, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { useLiveEvents } from '../../live.js';
import { toast } from '../../toast.js';
import { fmtDate, fmtUtcDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { LinkIcon, MarkdownView, hostOf, intranetChanged, useIntranetRefresh, useSlashToSearch } from './shared.jsx';
import { AnnouncementForm } from './Announcements.jsx';
import { OnboardingCard } from './Onboarding.jsx';

// Intranet home: what's new (announcements), what needs me (sign-offs, onboarding), and the office's links
// and manual one click away.
export default function IntranetHome() {
  const nav = useNavigate();
  const { practice } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useApi('/intranet/home');
  useIntranetRefresh(reload);
  useLiveEvents((e) => e.type === 'intranet' && reload());
  const search = useRef(null);
  useSlashToSearch(search);
  const [q, setQ] = useState('');
  const composing = params.get('announce') === '1';
  const manager = !!data?.can_manage;
  useShortcuts([
    { combo: 'n', handler: () => nav('/intranet/new'), label: 'New office manual page', section: 'Intranet', enabled: manager },
    { combo: 'a', handler: () => setParams({ announce: '1' }), label: 'New announcement', section: 'Intranet', enabled: manager && !composing },
    { combo: 'l', handler: () => nav('/intranet/links'), label: 'All office links', section: 'Intranet' },
  ]);

  const ack = async (a) => {
    try {
      await api.post(`/intranet/announcements/${a.id}/ack`);
      toast(`Acknowledged: ${a.title}`);
      reload();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="muted" style={{ padding: 24 }}>Loading…</div>;
  const pinned = data.links.filter((l) => l.pinned);
  const tiles = (pinned.length ? pinned : data.links).slice(0, 12);
  const empty = !data.links.length && !data.sections.length && !data.announcements.length;

  return (
    <>
      <header className="intra-hero">
        <div>
          <h1>{practice?.name ? `${practice.name} intranet` : 'Office intranet'}</h1>
          <p className="muted">Announcements, the office manual and the websites you use every day.</p>
        </div>
        <form className="intra-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/intranet/search?q=${encodeURIComponent(q.trim())}`); }}>
          <Search size={16} aria-hidden />
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the office manual" aria-label="Search the office manual" />
          <kbd>/</kbd>
        </form>
      </header>

      {manager && composing && (
        <div className="card intra-panel">
          <AnnouncementForm onDone={() => { setParams({}); reload(); intranetChanged(); }} onCancel={() => setParams({})} />
        </div>
      )}

      {data.announcements.length > 0 && (
        <section className="intra-announcements" aria-label="Announcements">
          {data.announcements.map((a) => (
            <article key={a.id} className={`intra-announcement${a.requires_ack && !a.acknowledged ? ' needs' : ''}`}>
              <Megaphone size={18} aria-hidden className="intra-ann-icon" />
              <div className="intra-ann-body">
                <h2>{a.title}</h2>
                {a.body && <MarkdownView text={a.body} className="compact" />}
                <div className="muted intra-meta">{a.created_by_name || 'Office'} · {fmtUtcDate(a.created_at, practice?.timezone)}{a.expires_on ? ` · until ${fmtDate(a.expires_on)}` : ''}</div>
              </div>
              {a.requires_ack ? (
                a.acknowledged
                  ? <span className="intra-acked"><CheckCircle2 size={16} aria-hidden /> Acknowledged</span>
                  : <button className="primary" onClick={() => ack(a)}>I’ve read this</button>
              ) : null}
            </article>
          ))}
        </section>
      )}

      {manager && !composing && (
        <div className="intra-quick-actions">
          <button className="small" onClick={() => setParams({ announce: '1' })}><Megaphone size={14} aria-hidden /> Announcement <kbd>A</kbd></button>
          <button className="small" onClick={() => nav('/intranet/new')}><Plus size={14} aria-hidden /> Page <kbd>N</kbd></button>
          <button className="small" onClick={() => nav('/intranet/links?add=1')}><Plus size={14} aria-hidden /> Link</button>
        </div>
      )}

      {empty && manager && (
        <div className="card intra-empty">
          <Sparkles size={22} aria-hidden />
          <div>
            <h2>Set up your intranet in a few clicks</h2>
            <p className="muted">Add the insurance portals, labs and supply sites your team uses, and start the office manual from ready-made templates (opening checklist, medical emergency, sterilization and more) that you adapt to your office.</p>
            <div className="actions">
              <button className="primary" onClick={() => nav('/intranet/links?suggest=1')}>Add suggested links</button>
              <button onClick={() => nav('/intranet/pages?templates=1')}>Start from templates</button>
            </div>
          </div>
        </div>
      )}
      {empty && !manager && <div className="card muted">Nothing here yet — your office manager can add links, announcements and the office manual.</div>}

      <div className="intra-grid">
        <div className="intra-main">
          {tiles.length > 0 && (
            <section className="card">
              <div className="intra-section-head">
                <h2><Pin size={16} aria-hidden /> {pinned.length ? 'Pinned links' : 'Links'}</h2>
                <Link to="/intranet/links" className="intra-more">All links <ChevronRight size={14} aria-hidden /></Link>
              </div>
              <div className="intra-tiles">
                {tiles.map((l) => (
                  <a key={l.id} className="intra-tile" href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.title} — ${hostOf(l.url)} (opens in a new tab)`}>
                    <span className="intra-tile-icon"><LinkIcon link={l} /></span>
                    <span className="intra-tile-title">{l.title}</span>
                    <span className="intra-tile-host">{hostOf(l.url)} <ExternalLink size={11} aria-hidden /></span>
                  </a>
                ))}
              </div>
              <p className="muted intra-hint">Tip: from any screen, press <kbd>Ctrl/⌘ K</kbd> and type the site’s name.</p>
            </section>
          )}

          {data.sections.length > 0 && (
            <section className="card">
              <div className="intra-section-head">
                <h2><BookOpen size={16} aria-hidden /> Office manual</h2>
                <Link to="/intranet/pages" className="intra-more">All pages <ChevronRight size={14} aria-hidden /></Link>
              </div>
              <div className="intra-sections">
                {data.sections.map((s) => (
                  <Link key={s.id} to={`/intranet/sections/${s.id}`} className="intra-section-card">
                    <FolderOpen size={18} aria-hidden />
                    <span><strong>{s.name}</strong><small className="muted">{s.pages} page{s.pages === 1 ? '' : 's'}{s.description ? ` · ${s.description}` : ''}</small></span>
                  </Link>
                ))}
                {data.unsectioned > 0 && (
                  <Link to="/intranet/pages?section=none" className="intra-section-card">
                    <FolderOpen size={18} aria-hidden />
                    <span><strong>Other pages</strong><small className="muted">{data.unsectioned} page{data.unsectioned === 1 ? '' : 's'}</small></span>
                  </Link>
                )}
              </div>
            </section>
          )}

          {data.recent.length > 0 && (
            <section className="card">
              <h2 className="intra-h2">Recently updated</h2>
              <ul className="intra-list">
                {data.recent.map((p) => (
                  <li key={p.id}><Link to={`/intranet/pages/${p.id}`}>{p.title}</Link><span className="muted">{fmtUtcDate(p.updated_at, practice?.timezone)}</span></li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="intra-side">
          {data.needs_ack.length > 0 && (
            <section className="card intra-needs">
              <h2 className="intra-h2"><CheckCircle2 size={16} aria-hidden /> Needs your acknowledgement</h2>
              <ul className="intra-list">
                {data.needs_ack.map((n) => (
                  <li key={`${n.kind}${n.id}`}>
                    {n.kind === 'page'
                      ? <Link to={`/intranet/pages/${n.id}`}>{n.title}</Link>
                      : <span>{n.title} <span className="muted">(announcement above)</span></span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.onboarding.length > 0 && (
            <section className="card">
              <h2 className="intra-h2"><GraduationCap size={16} aria-hidden /> Your onboarding</h2>
              {data.onboarding.map((o) => <OnboardingCard key={o.id} onboarding={o} onChange={reload} compact />)}
            </section>
          )}
          {manager && data.reviews_due.length > 0 && (
            <section className="card">
              <h2 className="intra-h2"><CalendarClock size={16} aria-hidden /> Due for review</h2>
              <ul className="intra-list">
                {data.reviews_due.map((p) => (
                  <li key={p.id}><Link to={`/intranet/pages/${p.id}`}>{p.title}</Link><span className={p.overdue ? 'intra-overdue' : 'muted'}>{p.overdue ? 'overdue · ' : ''}{fmtDate(p.review_due)}</span></li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
