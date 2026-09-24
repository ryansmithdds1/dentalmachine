import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, Download, Printer, RotateCcw, Search, Star } from 'lucide-react';
import { api, download, getLocationId } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useRemembered } from '../prefs.js';
import { useShortcuts } from '../shortcuts.js';
import { money, fmtDate, fmtDateTime, fmtUtcDateTime, shiftDate } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';
import { ProviderSelect } from './ReportControls.jsx';
import './reportlibrary.css';

// Reports → Report library: the ready-made reports office managers know by name (server/src/reportlibrary.js),
// searchable, grouped by category, with favourites. Each opens with sensible filters, a sortable table with
// totals, CSV, print, and "Save / schedule" through Saved & scheduled. The command bar (Ctrl K) opens them by
// name too (see Reports.jsx).
const FAVOURITES = 'reports.library.favourites';

export default function ReportLibrary({ catalog, error }) {
  const [params, setParams] = useSearchParams();
  const id = params.get('report');
  const [favs, setFavs] = useRemembered(FAVOURITES, []);
  const favourites = Array.isArray(favs) ? favs : [];
  const toggleFav = (rid) => setFavs(favourites.includes(rid) ? favourites.filter((x) => x !== rid) : [...favourites, rid]);
  const open = (rid) => setParams(rid ? { tab: 'library', report: rid } : { tab: 'library' });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');

  if (error) return <ErrorBox error={error} />;
  if (!catalog) return <div className="card muted">Loading the report library…</div>;
  const current = id ? catalog.reports.find((r) => r.id === id) : null;
  return (
    <div className="rl">
      <aside className="rl-side no-print" aria-label="Report categories">
        <SearchBox q={q} setQ={(v) => { setQ(v); if (id) open(null); }} autoFocus={!id} />
        <nav className="rl-cats">
          <CatButton active={cat === 'all' && !q} onClick={() => { setCat('all'); setQ(''); open(null); }} label="All reports" n={catalog.reports.length} />
          <CatButton active={cat === 'favourites' && !q} onClick={() => { setCat('favourites'); setQ(''); open(null); }} label="Favourites" n={favourites.filter((f) => catalog.reports.some((r) => r.id === f)).length} icon={<Star size={14} />} />
          <div className="rl-cats-rule" />
          {catalog.categories.map((c) => {
            const n = catalog.reports.filter((r) => r.category === c).length;
            return n ? <CatButton key={c} active={cat === c && !q} onClick={() => { setCat(c); setQ(''); open(null); }} label={c} n={n} /> : null;
          })}
        </nav>
        {current && <SideList reports={catalog.reports.filter((r) => r.category === current.category)} current={current.id} open={open} title={current.category} />}
      </aside>
      <section className="rl-main">
        {current
          ? <ReportView key={current.id} meta={current} today={catalog.today} fav={favourites.includes(current.id)} toggleFav={() => toggleFav(current.id)} back={() => open(null)} />
          : <Catalog reports={catalog.reports} categories={catalog.categories} q={q} cat={cat} favourites={favourites} toggleFav={toggleFav} open={open} />}
        {id && !current && <div className="card muted">That report isn’t available to you. <button className="link" onClick={() => open(null)}>See all reports</button></div>}
      </section>
    </div>
  );
}

function SearchBox({ q, setQ, autoFocus }) {
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);
  return (
    <label className="rl-search">
      <Search size={15} aria-hidden="true" />
      <input
        ref={ref} type="search" value={q} placeholder="Find a report…" aria-label="Find a report"
        onChange={(e) => setQ(e.target.value)}
        // Down arrow moves into the results; Escape clears.
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('.rl-card-open')?.focus(); }
          if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); }
        }}
      />
    </label>
  );
}

const CatButton = ({ active, onClick, label, n, icon }) => (
  <button className={`rl-cat${active ? ' active' : ''}`} onClick={onClick} aria-current={active ? 'true' : undefined}>
    {icon}<span>{label}</span><span className="rl-count">{n}</span>
  </button>
);

function SideList({ reports, current, open, title }) {
  return (
    <div className="rl-sidelist">
      <div className="rl-eyebrow">{title}</div>
      {reports.map((r) => <button key={r.id} className={`rl-sideitem${r.id === current ? ' active' : ''}`} onClick={() => open(r.id)}>{r.name}</button>)}
    </div>
  );
}

// The catalog: report cards by category, filtered by the search words (name, description, category).
function Catalog({ reports, categories, q, cat, favourites, toggleFav, open }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = reports.filter((r) => {
    if (words.length) return words.every((w) => `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(w));
    if (cat === 'favourites') return favourites.includes(r.id);
    return cat === 'all' || r.category === cat;
  });
  const groups = categories.map((c) => [c, shown.filter((r) => r.category === c)]).filter(([, list]) => list.length);
  // Arrow keys move between cards like a list.
  const onKey = (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const cards = [...document.querySelectorAll('.rl-card-open')];
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) document.querySelector('.rl-search input')?.focus();
    else cards[Math.min(cards.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  return (
    <div onKeyDown={onKey}>
      <div className="rl-intro">
        <h2>{words.length ? `Reports matching “${q}”` : cat === 'favourites' ? 'Favourite reports' : cat === 'all' ? 'Report library' : cat}</h2>
        <p className="muted">{words.length || cat !== 'all' ? `${shown.length} report${shown.length === 1 ? '' : 's'}` : 'Ready-made reports for production, collections, A/R, patients, treatment, scheduling and insurance. Star the ones you use most; Ctrl K opens any of them by name.'}</p>
      </div>
      {!shown.length && (
        <div className="card rl-empty">
          {cat === 'favourites' && !words.length ? <>No favourites yet. Open a report and press the <Star size={13} /> star (or <kbd>F</kbd>) to keep it here.</> : 'No report matches those words. Try “production”, “aging” or “no-show”.'}
        </div>
      )}
      {groups.map(([c, list]) => (
        <div key={c} className="rl-group">
          {(cat === 'all' || words.length > 0 || cat === 'favourites') && <h3 className="rl-eyebrow">{c}</h3>}
          <div className="rl-cards">
            {list.map((r) => (
              <div key={r.id} className="rl-card">
                <button className="rl-card-open" onClick={() => open(r.id)}>
                  <span className="rl-card-name">{r.name}{r.admin && <span className="rl-tag">Admin</span>}</span>
                  <span className="rl-card-desc">{r.description}</span>
                </button>
                <button className={`rl-star${favourites.includes(r.id) ? ' on' : ''}`} onClick={() => toggleFav(r.id)} aria-pressed={favourites.includes(r.id)} aria-label={`${favourites.includes(r.id) ? 'Remove' : 'Add'} ${r.name} ${favourites.includes(r.id) ? 'from' : 'to'} favourites`} title="Favourite">
                  <Star size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Quick date ranges for a report's From/To.
function presets(today, future) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastEnd = shiftDate(monthStart, -1);
  return future
    ? [['Next 7 days', today, shiftDate(today, 7)], ['Next 30 days', today, shiftDate(today, 30)], ['Rest of the month', today, shiftDate(`${shiftDate(monthStart, 32).slice(0, 7)}-01`, -1)]]
    : [['This month', monthStart, today], ['Last month', `${lastEnd.slice(0, 7)}-01`, lastEnd], ['Last 30 days', shiftDate(today, -29), today], ['Year to date', `${today.slice(0, 4)}-01-01`, today]];
}

function ReportView({ meta, today, fav, toggleFav, back }) {
  const { practice } = useAuth();
  const offices = useLookup(meta.params.includes('office') ? '/locations' : null);
  const schedules = useLookup(meta.params.includes('fee_schedule') ? '/fee-schedules' : null);
  const start = () => ({ ...meta.defaults, provider_id: '', location_id: meta.params.includes('office') ? String(getLocationId() || '') : '', fee_schedule_id: '' });
  const [f, setF] = useState(start);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
  const path = `/report-library/${meta.id}${qs ? `?${qs}` : ''}`;
  const { data, error, loading } = useApi(path);
  const [sort, setSort] = useState(null);
  const [saving, setSaving] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const exportCsv = async () => {
    setCsvErr(null);
    try { await download(`${path}${qs ? '&' : '?'}format=csv`, `${meta.id}.csv`); } catch (e) { setCsvErr(e); }
  };
  useShortcuts([
    { combo: 'escape', label: 'Back to all reports', section: 'Report library', handler: back },
    { combo: 'f', label: 'Star or unstar this report', section: 'Report library', handler: toggleFav },
  ]);

  const cols = meta.columns;
  const rows = useMemo(() => {
    const list = data?.rows || [];
    if (!sort) return list;
    const c = cols.find((x) => x.key === sort.key);
    const numeric = c && ['money', 'int', 'pct', 'hours'].includes(c.type);
    return [...list].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;
      if (y == null || y === '') return -1;
      const d = numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'asc' ? d : -d;
    });
  }, [data, sort, cols]);
  const sortBy = (key) => setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const defaultsChanged = JSON.stringify(f) !== JSON.stringify(start());

  return (
    <div className="rl-report">
      <div className="rl-head">
        <div className="rl-head-text">
          <button className="link rl-back no-print" onClick={back}><ArrowLeft size={14} /> All reports</button>
          <div className="rl-eyebrow">{meta.category}</div>
          <h2 className="rl-title">
            {meta.name}
            <button className={`rl-star inline no-print${fav ? ' on' : ''}`} onClick={toggleFav} aria-pressed={fav} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} title="Favourite (F)"><Star size={18} /></button>
          </h2>
          <p className="muted rl-desc">{meta.description}</p>
        </div>
        <div className="rl-actions no-print">
          {meta.saved_key && <button onClick={() => setSaving(true)}><CalendarClock size={15} /> Save / schedule</button>}
          <button onClick={exportCsv} disabled={!data?.rows?.length} title="Download as a spreadsheet (CSV)"><Download size={15} /> CSV</button>
          <button onClick={() => window.print()} title="Print, or choose “Save as PDF” in the print dialog"><Printer size={15} /> Print</button>
        </div>
      </div>

      <div className="rl-filters no-print" role="group" aria-label="Filters">
        {meta.params.includes('range') && (
          <>
            <label className="rl-field">From<input type="date" value={f.from} onChange={(e) => e.target.value && set('from', e.target.value)} /></label>
            <label className="rl-field">To<input type="date" value={f.to} onChange={(e) => e.target.value && set('to', e.target.value)} /></label>
            <div className="rl-presets">
              {presets(today, meta.looks_ahead).map(([l, a, b]) => <button key={l} className={`small${f.from === a && f.to === b ? ' active' : ''}`} onClick={() => setF((x) => ({ ...x, from: a, to: b }))}>{l}</button>)}
            </div>
          </>
        )}
        {meta.params.includes('date') && (
          <div className="rl-field">
            Day
            <div className="rl-stepper">
              <button className="small" aria-label="Previous day" onClick={() => set('date', shiftDate(f.date, -1))}>←</button>
              <input type="date" aria-label="Day" value={f.date} onChange={(e) => e.target.value && set('date', e.target.value)} />
              <button className="small" aria-label="Next day" onClick={() => set('date', shiftDate(f.date, 1))}>→</button>
            </div>
          </div>
        )}
        {meta.params.includes('month') && <label className="rl-field">Month<input type="month" value={f.month} onChange={(e) => e.target.value && set('month', e.target.value)} /></label>}
        {meta.params.includes('as_of') && <label className="rl-field">As of<input type="date" value={f.as_of} max={today} onChange={(e) => e.target.value && set('as_of', e.target.value)} /></label>}
        {meta.params.includes('group') && (
          <div className="rl-field">By
            <div className="seg">{[['provider', 'Provider'], ['chair', 'Chair']].map(([k, l]) => <button key={k} className={f.group === k ? 'active' : ''} onClick={() => set('group', k)}>{l}</button>)}</div>
          </div>
        )}
        {meta.params.includes('provider') && <label className="rl-field">Provider<ProviderSelect value={f.provider_id} onChange={(v) => set('provider_id', v)} /></label>}
        {meta.params.includes('office') && offices.length > 0 && (
          <label className="rl-field">Office
            <select value={f.location_id} onChange={(e) => set('location_id', e.target.value)}>
              <option value="">All my offices</option>
              {offices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        {meta.params.includes('fee_schedule') && (
          <label className="rl-field">Fee schedule
            <select value={f.fee_schedule_id || data?.params?.fee_schedule_id || ''} onChange={(e) => set('fee_schedule_id', e.target.value)}>
              {!schedules.length && <option value="">None set up</option>}
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        {defaultsChanged && <button className="small rl-reset" onClick={() => { setF(start()); setSort(null); }}><RotateCcw size={13} /> Reset</button>}
      </div>

      <div className="rl-print-head">
        <strong>{practice?.name}</strong> · {meta.name} · {describeParams(data?.params)} · printed {new Date().toLocaleString('en-US')}
      </div>

      <ErrorBox error={error || csvErr} />
      <div className={`card rl-table-card${loading ? ' loading' : ''}`} aria-busy={loading}>
        {data && (meta.summary ? <SummaryTable rows={data.rows} /> : (
          <div className="table-wrap">
            <table className="rl-table">
              <thead>
                <tr>
                  {cols.map((c) => {
                    const numeric = ['money', 'int', 'pct', 'hours'].includes(c.type);
                    const dir = sort?.key === c.key ? sort.dir : null;
                    return (
                      <th key={c.key} className={numeric ? 'num' : ''} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                        <button className="rl-sort" onClick={() => sortBy(c.key)} title="Sort">
                          {c.label}{dir === 'asc' ? <ArrowUp size={12} /> : dir === 'desc' ? <ArrowDown size={12} /> : null}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.id ?? r.patient_id ?? ''}-${i}`}>
                    {cols.map((c) => <td key={c.key} className={cellClass(c, r[c.key])}><Cell col={c} row={r} tz={practice?.timezone} /></td>)}
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={cols.length} className="empty">Nothing to show for these filters.</td></tr>}
              </tbody>
              {data.totals && rows.length > 0 && (
                <tfoot>
                  <tr className="totals-row">
                    {cols.map((c, i) => <td key={c.key} className={cellClass(c, data.totals[c.key])}>{i === 0 ? `Total (${data.row_count.toLocaleString()} ${data.row_count === 1 ? 'row' : 'rows'})` : c.key in data.totals ? <Cell col={c} row={data.totals} /> : ''}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ))}
        {!data && !error && <div className="rl-skeleton" aria-hidden="true"><i /><i /><i /><i /></div>}
      </div>
      {data?.truncated && <div className="rl-note warn">Showing the first {data.rows.length.toLocaleString()} of {data.row_count.toLocaleString()} rows; totals cover them all. Download the CSV or narrow the filters for the rest.</div>}
      {data?.note && <p className="rl-note muted">{data.note}</p>}
      {saving && <SaveDialog meta={meta} filters={f} onClose={() => setSaving(false)} />}
    </div>
  );
}

function describeParams(p) {
  if (!p) return '';
  if (p.from) return `${fmtDate(p.from)} – ${fmtDate(p.to)}`;
  if (p.date) return fmtDate(p.date);
  if (p.month) return new Date(`${p.month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (p.as_of) return `as of ${fmtDate(p.as_of)}`;
  return 'current';
}

const cellClass = (c, v) => [['money', 'int', 'pct', 'hours'].includes(c.type) ? 'num' : '', c.type === 'money' && Number(v) < 0 ? 'rl-neg' : ''].filter(Boolean).join(' ');

function Cell({ col: c, row, tz }) {
  const v = row[c.key];
  if (v == null || v === '') return c.type === 'patient' || c.type === 'text' ? '' : <span className="muted">—</span>;
  switch (c.type) {
    case 'money': return money(v);
    case 'int': return Number(v).toLocaleString();
    case 'pct': return `${v}%`;
    case 'hours': return `${Number(v).toLocaleString()} h`;
    case 'date': return fmtDate(String(v));
    case 'datetime': return fmtDateTime(String(v));
    case 'utc': return fmtUtcDateTime(String(v), tz);
    case 'patient': return row.patient_id ? <Link to={`/patients/${row.patient_id}`}>{v}</Link> : v;
    case 'claim': return <Link to={`/claims/${v}`}>#{v}</Link>;
    default: return String(v);
  }
}

// End-of-day and month-end: one line per item, grouped under section headings.
function SummaryTable({ rows }) {
  const sections = [...new Set(rows.map((r) => r.section))];
  return (
    <table className="rl-table rl-summary">
      <thead><tr><th>Item</th><th className="num">Count</th><th className="num">Amount</th><th className="num">Rate</th></tr></thead>
      {sections.map((s) => (
        <tbody key={s}>
          <tr className="rl-section"><th colSpan={4} scope="colgroup">{s}</th></tr>
          {rows.filter((r) => r.section === s).map((r) => (
            <tr key={r.item} className={/^(Net|Total)/.test(r.item) ? 'rl-strong' : ''}>
              <td>{r.item}</td>
              <td className="num">{r.count == null ? '' : Number(r.count).toLocaleString()}</td>
              <td className={cellClass({ type: 'money' }, r.amount)}>{r.amount == null ? '' : money(r.amount)}</td>
              <td className="num">{r.rate == null ? '' : `${r.rate}%`}</td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

// Save / schedule: stored with Saved & scheduled reports (report "lib.<id>"), optionally emailed.
const SCHEDULES = { '': 'Just save it', daily: 'Every morning', weekly: 'Monday mornings', monthly: 'The 1st of each month' };
function SaveDialog({ meta, filters, onClose }) {
  // What "Dates" means when it's sent: a day, a month, a range relative to the send date, or nothing to choose
  // (reports as of the day, or looking ahead from it).
  const kind = meta.params.includes('date') ? 'day' : meta.params.includes('month') ? 'month' : meta.params.includes('range') && !meta.looks_ahead ? 'range' : 'none';
  const periods = kind === 'day' ? { yesterday: 'The day before it’s sent', mtd: 'The day it’s sent' }
    : kind === 'month' ? { mtd: 'This month so far', last_month: 'Last month' }
      : kind === 'range' ? { mtd: 'Month to date', last_month: 'Last month', last_7: 'Last 7 days', yesterday: 'Yesterday', ytd: 'Year to date' } : null;
  const [s, setS] = useState({ name: meta.name, period: kind === 'day' ? 'yesterday' : 'mtd', schedule: '', recipients: '' });
  const { submit, busy, error } = useSubmit(async () => {
    const params = { period: s.period, ...(filters.provider_id ? { provider_id: Number(filters.provider_id) } : {}), ...(filters.location_id ? { location_id: Number(filters.location_id) } : {}) };
    await api.post('/saved-reports', { name: s.name, report: meta.saved_key, params, schedule: s.schedule || null, recipients: s.recipients });
    toast(`Saved “${s.name}” — it’s under Saved & scheduled`);
    onClose();
  });
  return (
    <Modal title="Save this report" onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Name<input autoFocus value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></label>
        {periods && (
          <label>Dates<select value={s.period} onChange={(e) => setS({ ...s, period: e.target.value })}>{Object.entries(periods).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        )}
        <label>Email it<select value={s.schedule} onChange={(e) => setS({ ...s, schedule: e.target.value })}>{Object.entries(SCHEDULES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {s.schedule && <label className="full">To (emails, separated by commas)<input value={s.recipients} onChange={(e) => setS({ ...s, recipients: e.target.value })} placeholder="owner@example.com" /></label>}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        {filters.provider_id || filters.location_id ? 'Keeps the provider and office you picked. ' : ''}
        {kind === 'none' ? (meta.looks_ahead ? 'Looks ahead from the day it’s sent. ' : 'Shows the numbers as of the day it’s sent. ') : ''}
        {meta.phi ? 'This report lists patients, so emails carry totals only — open it here for the names.' : 'Emails carry the numbers only — no patient names.'}
      </p>
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !s.name.trim() || (s.schedule && !s.recipients.trim())} onClick={submit}>Save</button></div>
    </Modal>
  );
}
