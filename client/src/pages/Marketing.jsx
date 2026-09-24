import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, Download, Link2, Megaphone, Plus, X } from 'lucide-react';
import { api, download } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { money, fmtDate, practiceToday, shiftDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import './marketing.css';

// Marketing ROI (MK1–MK2, docs/workflows/specs/MK-marketing.md): where leads and new patients came from, what they
// went on to produce (from the ledger), what each source cost, and the return. Keys: 1/2/3 switch tabs, J/K move
// through rows, Enter opens the patients behind a row, Esc closes it.
const TABS = [['results', 'Results'], ['setup', 'Sources & campaigns'], ['costs', 'Costs']];
const GROUPS = [['source', 'Source'], ['campaign', 'Campaign'], ['channel', 'Channel'], ['month', 'Month']];
const WINDOW_LABEL = { 30: '30 days', 90: '90 days', 180: '6 months', 365: 'first year', life: 'to date' };
const dash = (v, f = (x) => x) => (v == null ? '—' : f(v));
const pctText = (v) => `${v}%`;
const monthLabel = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function Marketing() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'results';
  const setTab = (t) => setParams({ ...Object.fromEntries(params), tab: t });
  const { data: setup, error: setupError, reload: reloadSetup } = useApi('/marketing/setup');
  useShortcuts(TABS.map(([k, l], i) => ({ combo: String(i + 1), handler: () => setTab(k), label: `Show ${l}` })));
  useCommands([
    { id: 'mk-results', label: 'Marketing results (ROI by source)', hint: 'Marketing', run: () => setTab('results') },
    { id: 'mk-campaign', label: 'Add a marketing campaign', hint: 'Marketing', run: () => setTab('setup') },
    { id: 'mk-cost', label: 'Enter marketing costs', hint: 'Marketing', run: () => setTab('costs') },
  ]);
  return (
    <div className="mk">
      <div className="page-header">
        <h1><Megaphone size={20} aria-hidden /> Marketing</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l], i) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)} title={`${l} (${i + 1})`}>{l}</button>)}
      </div>
      <ErrorBox error={setupError} />
      {tab === 'results' && <Results setup={setup} />}
      {tab === 'setup' && setup && <Setup setup={setup} reload={reloadSetup} />}
      {tab === 'costs' && setup && <Costs setup={setup} reload={reloadSetup} />}
    </div>
  );
}

// ---- Results (MK2) ----
function Results({ setup }) {
  const today = practiceToday();
  const [f, setF] = useState({ from: shiftDate(today, -364).slice(0, 7), to: today.slice(0, 7), by: 'source', model: 'first', window: '365' });
  const qs = new URLSearchParams(f).toString();
  const { data: rep, error, loading } = useApi(`/marketing/report?${qs}`);
  const [cur, setCur] = useState(0);
  const [open, setOpen] = useState(null);
  const rows = rep?.rows || [];
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setCur(0); setOpen(null); };
  useEffect(() => { document.querySelector('.mk-table tr.kb-row')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);
  useShortcuts([
    { combo: 'j', handler: () => setCur((c) => Math.min(rows.length - 1, c + 1)), label: 'Next row' },
    { combo: 'k', handler: () => setCur((c) => Math.max(0, c - 1)), label: 'Previous row' },
    { combo: 'enter', handler: () => rows[cur] && setOpen(rows[cur]), label: 'See the patients behind the row', enabled: !!rows[cur] },
    { combo: 'escape', handler: () => setOpen(null), label: 'Close the patient list', enabled: !!open },
  ]);
  const t = rep?.total;
  const w = rep?.window ?? f.window;
  const back = (r) => (w === 'life' ? r.collections_life : r[`collections_${w}`]);
  const label = (r) => (rep?.by === 'month' ? monthLabel(r.key) : r.label);
  return (
    <div>
      <div className="mk-filters card">
        <label>From <input type="month" value={f.from} onChange={(e) => e.target.value && set('from', e.target.value)} /></label>
        <label>To <input type="month" value={f.to} onChange={(e) => e.target.value && set('to', e.target.value)} /></label>
        <label>By <select value={f.by} onChange={(e) => set('by', e.target.value)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label title="First touch: how they first found us. Last touch: what brought them in just before their first visit.">Credit
          <select value={f.model} onChange={(e) => set('model', e.target.value)}><option value="first">First touch</option><option value="last">Last touch</option></select>
        </label>
        {rep?.show_cost && (
          <label>ROI on collections in <select value={f.window} onChange={(e) => set('window', e.target.value)}>{['30', '90', '180', '365', 'life'].map((x) => <option key={x} value={x}>{WINDOW_LABEL[x]}</option>)}</select></label>
        )}
        <button className="small" onClick={() => download(`/marketing/report.csv?${qs}`, 'marketing.csv').catch((e) => toast(e.message, { tone: 'error' }))}><Download size={14} aria-hidden /> CSV</button>
      </div>
      <ErrorBox error={error} />
      {t && (
        <div className="stat-strip">
          <div><strong>{t.leads}</strong><span>leads ({t.call_leads} calls, {t.online_leads} online)</span></div>
          <div><strong>{t.new_patients}</strong><span>new patients</span></div>
          <div><strong>{dash(t.show_rate, pctText)}</strong><span>showed for a visit</span></div>
          {rep.money && <div><strong>{money(back(t))}</strong><span>collected ({WINDOW_LABEL[w]})</span></div>}
          {rep.show_cost && <div><strong>{money(t.cost)}</strong><span>spent</span></div>}
          {rep.show_cost && <div><strong>{dash(t.cost_per_new_patient, money)}</strong><span>per new patient</span></div>}
          {rep.show_cost && <div><strong>{dash(t.roi, pctText)}</strong><span>return on spend</span></div>}
        </div>
      )}
      {rep && !rep.money && <p className="muted small">Money columns need permission to see billing.</p>}
      {rep && rep.money && !rep.show_cost && <p className="muted small">Costs cover every office, so they show only for people who see them all.</p>}
      <div className="mk-layout">
        <div className="card table-wrap">
          <table className="mk-table">
            <thead>
              <tr>
                <th>{GROUPS.find(([k]) => k === rep?.by)?.[1] || 'Source'}</th><th className="num">Leads</th><th className="num">New patients</th><th className="num">Show rate</th>
                {rep?.money && <><th className="num">Production 90d</th><th className="num">Production 1st yr</th><th className="num">Collected ({WINDOW_LABEL[w]})</th><th className="num">Treatment accepted</th><th className="num">Value per patient</th></>}
                {rep?.show_cost && <><th className="num">Cost</th><th className="num">Per lead</th><th className="num">Per new patient</th><th className="num">ROI</th><th className="num">Payback</th></>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className={`${i === cur ? 'kb-row' : ''}${open?.key === r.key ? ' mk-open' : ''}`} onClick={() => { setCur(i); setOpen(r); }} tabIndex={-1}>
                  <td>{label(r)}{r.channel && rep.by !== 'channel' && <span className="muted small"> · {setup?.channels?.find((c) => c.key === r.channel)?.label}</span>}</td>
                  <td className="num">{r.leads}</td><td className="num">{r.new_patients}</td><td className="num">{dash(r.show_rate, pctText)}</td>
                  {rep.money && <><td className="num">{money(r.production_90)}</td><td className="num">{money(r.production_365)}{r.new_patients > r.matured_365 && <span className="muted small" title="Some of these patients haven't been with us a year yet"> *</span>}</td><td className="num">{money(back(r))}</td><td className="num">{money(r.treatment_accepted)}</td><td className="num">{dash(r.ltv_collections, money)}</td></>}
                  {rep.show_cost && <><td className="num">{r.cost ? money(r.cost) : '—'}</td><td className="num">{dash(r.cost_per_lead, money)}</td><td className="num">{dash(r.cost_per_new_patient, money)}</td><td className={`num ${r.roi == null ? '' : r.roi >= 0 ? 'mk-good' : 'mk-bad'}`}>{dash(r.roi, pctText)}</td><td className="num">{r.cost ? (r.payback_months ? `${r.payback_months} mo` : 'not yet') : '—'}</td></>}
                </tr>
              ))}
              {!rows.length && !loading && <tr><td colSpan={14} className="muted">No leads, new patients or costs in these months yet.</td></tr>}
            </tbody>
          </table>
          {rep?.money && rows.some((r) => r.new_patients > r.matured_365) && <p className="muted small">* Includes patients who haven’t been with us a full year yet — their first-year numbers are still growing.</p>}
        </div>
        {open && <Drill row={open} qs={qs} rep={rep} onClose={() => setOpen(null)} label={label(open)} />}
      </div>
    </div>
  );
}

// The patients behind a row (side panel; looking is recorded).
function Drill({ row, qs, rep, onClose, label }) {
  const path = `/marketing/report/patients?${qs}&key=${encodeURIComponent(row.key)}`;
  const { data, error } = useApi(path);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [row.key]);
  return (
    <aside className="card mk-drill" aria-label={`Patients: ${label}`} ref={ref} tabIndex={-1}>
      <div className="mk-drill-head">
        <strong>{label}</strong>
        <span>
          <button className="small" onClick={() => download(path.replace('/patients?', '/patients.csv?'), 'marketing-patients.csv').catch((e) => toast(e.message, { tone: 'error' }))}><Download size={14} aria-hidden /> CSV</button>
          <button className="small" onClick={onClose} aria-label="Close (Esc)"><X size={14} aria-hidden /></button>
        </span>
      </div>
      <ErrorBox error={error} />
      {data && <p className="muted small">{data.total} new patient{data.total === 1 ? '' : 's'} whose first visit was in these months.</p>}
      <ul className="mk-list">
        {(data?.patients || []).map((p) => (
          <li key={p.patient_id}>
            <Link to={`/patients/${p.patient_id}`}>{p.name}</Link>
            <span className="muted small"> · first visit {fmtDate(p.first_visit)}{p.campaign ? ` · ${p.campaign}` : ''}{p.method ? ` · ${p.method}` : ''}</span>
            {rep?.money && <div className="small">Produced {money(p.production_life)} · collected {money(p.collections_life)}{p.treatment_accepted ? ` · accepted ${money(p.treatment_accepted)}` : ''}</div>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---- Sources & campaigns (MK1) ----
function Setup({ setup, reload }) {
  const { can } = useAuth();
  const manage = setup.can_manage;
  const [src, setSrc] = useState({ name: '', channel: 'other', match_keys: '' });
  const blank = { name: '', source_id: '', utm_campaign: '', promo_code: '', tracking_number_id: '', starts_on: '', ends_on: '', notes: '' };
  const [camp, setCamp] = useState(blank);
  const [err, setErr] = useState(null);
  const [linkFor, setLinkFor] = useState(null);
  const save = async (fn, msg) => {
    setErr(null);
    try { await fn(); toast(msg); reload(); return true; } catch (e) { setErr(e); return false; }
  };
  const addSource = (e) => { e.preventDefault(); save(() => api.post('/marketing/sources', src), `Added ${src.name}`).then((ok) => ok && setSrc({ name: '', channel: 'other', match_keys: '' })); };
  const addCampaign = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(camp).filter(([, v]) => v !== ''));
    save(() => api.post('/marketing/campaigns', body), `Added ${camp.name}`).then((ok) => ok && setCamp(blank));
  };
  const toggle = (kind, row) => save(() => api.patch(`/marketing/${kind}/${row.id}`, { active: !row.active }), row.active ? `${row.name} retired` : `${row.name} back in use`);
  const sources = setup.sources;
  return (
    <div className="mk-setup">
      <ErrorBox error={err} />
      <section className="card">
        <h2>Campaigns</h2>
        <p className="muted small">A campaign is counted when someone books through its link (the campaign tag), uses its promo code, or calls its tracking number while it runs. Copy its link for ads, posts and QR codes.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Campaign</th><th>Source</th><th>Tag</th><th>Promo code</th><th>Tracking line</th><th>Runs</th><th /></tr></thead>
            <tbody>
              {setup.campaigns.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'muted'}>
                  <td>{c.name}</td><td>{c.source_name}</td><td><code>{c.utm_campaign || '—'}</code></td><td>{c.promo_code || '—'}</td>
                  <td>{c.tracking_line ? `${c.tracking_line}` : '—'}</td><td className="small">{c.starts_on ? fmtDate(c.starts_on) : 'any time'}{c.ends_on ? ` – ${fmtDate(c.ends_on)}` : ''}</td>
                  <td className="row-actions">
                    <button className="small" onClick={() => setLinkFor(linkFor === c.id ? null : c.id)}><Link2 size={14} aria-hidden /> Link</button>
                    {manage && <button className="small" onClick={() => toggle('campaigns', c)}>{c.active ? 'Retire' : 'Use again'}</button>}
                  </td>
                </tr>
              ))}
              {!setup.campaigns.length && <tr><td colSpan={7} className="muted">No campaigns yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {linkFor && <LinkBuilder campaign={setup.campaigns.find((c) => c.id === linkFor)} />}
        {manage && (
          <form className="mk-form" onSubmit={addCampaign}>
            <label>Name<input required value={camp.name} onChange={(e) => setCamp({ ...camp, name: e.target.value })} placeholder="Spring Invisalign mailer" /></label>
            <label>Source<select required value={camp.source_id} onChange={(e) => setCamp({ ...camp, source_id: e.target.value })}><option value="">Choose…</option>{sources.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>Campaign tag<input value={camp.utm_campaign} onChange={(e) => setCamp({ ...camp, utm_campaign: e.target.value })} placeholder="made from the name" /></label>
            <label>Promo code<input value={camp.promo_code} onChange={(e) => setCamp({ ...camp, promo_code: e.target.value.toUpperCase() })} placeholder="SMILE25" /></label>
            <label>Tracking line<select value={camp.tracking_number_id} onChange={(e) => setCamp({ ...camp, tracking_number_id: e.target.value })}><option value="">None</option>{setup.tracking.map((t) => <option key={t.id} value={t.id}>{t.source} · {t.number}</option>)}</select></label>
            <label>Starts<input type="date" value={camp.starts_on} onChange={(e) => setCamp({ ...camp, starts_on: e.target.value })} /></label>
            <label>Ends<input type="date" value={camp.ends_on} onChange={(e) => setCamp({ ...camp, ends_on: e.target.value })} /></label>
            <button className="primary" type="submit"><Plus size={14} aria-hidden /> Add campaign</button>
          </form>
        )}
      </section>
      <section className="card">
        <h2>Sources</h2>
        <p className="muted small">Where patients come from. The words after each name are what a link tag, a tracking line or a “How did you hear about us?” answer can say to mean it.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Channel</th><th>Matches</th><th /></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'muted'}>
                  <td>{s.name}</td><td>{setup.channels.find((c) => c.key === s.channel)?.label}</td><td className="small muted">{(s.match_keys || '').split(',').join(', ')}</td>
                  <td className="row-actions">{manage && <button className="small" onClick={() => toggle('sources', s)}>{s.active ? 'Retire' : 'Use again'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {manage && (
          <form className="mk-form" onSubmit={addSource}>
            <label>Name<input required value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} placeholder="Radio ad" /></label>
            <label>Channel<select value={src.channel} onChange={(e) => setSrc({ ...src, channel: e.target.value })}>{setup.channels.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
            <label>Also matches<input value={src.match_keys} onChange={(e) => setSrc({ ...src, match_keys: e.target.value })} placeholder="radio, kxyz" /></label>
            <button className="primary" type="submit"><Plus size={14} aria-hidden /> Add source</button>
          </form>
        )}
        {!manage && can('reports:read') && <p className="muted small">Ask an administrator to add sources or campaigns.</p>}
      </section>
      {setup.booking_url && <p className="muted small">Your booking page: <code>{setup.booking_url}</code>{!setup.online_booking && ' (online booking is off)'}</p>}
    </div>
  );
}

// Tagged link for a campaign: the booking page, or a page on the practice's own site that has the booking button.
function LinkBuilder({ campaign }) {
  const [medium, setMedium] = useState('');
  const [target, setTarget] = useState('');
  const qs = useMemo(() => new URLSearchParams(Object.entries({ medium, target }).filter(([, v]) => v)).toString(), [medium, target]);
  const { data, error } = useApi(campaign ? `/marketing/campaigns/${campaign.id}/link?${qs}` : null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(data.url); toast('Link copied'); } catch { toast('Couldn’t copy — select the link and copy it', { tone: 'error' }); }
  };
  if (!campaign) return null;
  return (
    <div className="mk-link">
      <label>Medium<select value={medium} onChange={(e) => setMedium(e.target.value)}><option value="">Usual for the source</option>{['cpc', 'social', 'email', 'sms', 'print', 'qr', 'video', 'display'].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
      <label className="mk-grow">Your own page (optional)<input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://yourpractice.com/invisalign" /></label>
      <ErrorBox error={error} />
      {data && <div className="mk-url"><code>{data.url}</code><button className="small" onClick={copy}><Copy size={14} aria-hidden /> Copy</button></div>}
      {target && <p className="muted small">Your own page needs the booking button (Settings → Online booking → website button); it passes these tags on.</p>}
    </div>
  );
}

// ---- Costs ----
function Costs({ setup, reload }) {
  const today = practiceToday();
  const blank = { source_id: '', campaign_id: '', starts_on: `${today.slice(0, 7)}-01`, ends_on: '', amount: '', notes: '' };
  const [c, setC] = useState(blank);
  const [err, setErr] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [reason, setReason] = useState('');
  const key = useRef(newKey());
  if (!setup.money) return <p className="muted">Seeing marketing costs needs permission to see billing.</p>;
  const add = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      const body = { ...c, amount: Math.round(Number(c.amount) * 100), client_key: key.current, campaign_id: c.campaign_id || null, ends_on: c.ends_on || c.starts_on };
      await api.post('/marketing/costs', body);
      key.current = newKey();
      toast(`Added ${money(body.amount)}`);
      setC({ ...blank, source_id: c.source_id });
      reload();
    } catch (e2) { setErr(e2); }
  };
  const voidIt = async (row) => {
    setErr(null);
    try { await api.post(`/marketing/costs/${row.id}/void`, { reason }); toast('Cost voided'); setVoiding(null); setReason(''); reload(); } catch (e) { setErr(e); }
  };
  const camps = setup.campaigns.filter((x) => String(x.source_id) === String(c.source_id));
  return (
    <div>
      <ErrorBox error={err} />
      {setup.can_manage && (
        <form className="card mk-form" onSubmit={add}>
          <label>Source<select required value={c.source_id} onChange={(e) => setC({ ...c, source_id: e.target.value, campaign_id: '' })}><option value="">Choose…</option>{setup.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Campaign<select value={c.campaign_id} onChange={(e) => setC({ ...c, campaign_id: e.target.value })}><option value="">Whole source</option>{camps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label>From<input type="date" required value={c.starts_on} onChange={(e) => setC({ ...c, starts_on: e.target.value })} /></label>
          <label>To<input type="date" value={c.ends_on} min={c.starts_on} onChange={(e) => setC({ ...c, ends_on: e.target.value })} /></label>
          <label>Amount ($)<input required inputMode="decimal" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="1500.00" /></label>
          <label className="mk-grow">Note<input value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} placeholder="Google Ads invoice #1234" /></label>
          <button className="primary" type="submit"><Plus size={14} aria-hidden /> Add cost</button>
        </form>
      )}
      <p className="muted small">A cost for several months is spread evenly over its days. Mistakes are voided with a reason (and entered again), never edited.</p>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Dates</th><th>Source</th><th>Campaign</th><th className="num">Amount</th><th>Note</th><th>Entered by</th><th /></tr></thead>
          <tbody>
            {(setup.costs || []).map((row) => (
              <tr key={row.id} className={row.voided_at ? 'muted mk-void' : ''}>
                <td className="small">{fmtDate(row.starts_on)}{row.ends_on !== row.starts_on ? ` – ${fmtDate(row.ends_on)}` : ''}</td>
                <td>{row.source_name}</td><td>{row.campaign_name || '—'}</td><td className="num">{money(row.amount)}</td>
                <td className="small">{row.notes}{row.voided_at && <div>Voided: {row.void_reason}</div>}</td><td className="small">{row.created_by_name}</td>
                <td className="row-actions">
                  {setup.can_manage && !row.voided_at && (voiding === row.id
                    ? <span className="mk-inline"><input autoFocus aria-label="Why void it?" placeholder="Why?" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') voidIt(row); if (e.key === 'Escape') setVoiding(null); }} /><button className="small danger" onClick={() => voidIt(row)}>Void</button></span>
                    : <button className="small" onClick={() => { setVoiding(row.id); setReason(''); }}>Void…</button>)}
                </td>
              </tr>
            ))}
            {!(setup.costs || []).length && <tr><td colSpan={7} className="muted">No costs entered yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const newKey = () => `mkc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
