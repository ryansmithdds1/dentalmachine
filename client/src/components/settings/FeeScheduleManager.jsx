import { useEffect, useMemo, useRef, useState } from 'react';
import { Percent, Upload, History, CalendarClock, Check, X, GitCompare, AlertTriangle, FileSpreadsheet, Sparkles, ChevronRight } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtUtcDate, practiceToday, label } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import './feeschedules.css';

// Settings → Fee schedules (FS1–FS3): every schedule with when it was last updated; raise fees by a % now or on
// a date (so January's increase isn't forgotten); import a payer's new schedule (CSV, XLSX, or a PDF the AI
// reads) and approve it after seeing what changes; and every older version, kept and comparable. One side panel
// at a time (no stacked dialogs); Esc closes it. R = raise fees, I = import.
const ROUNDING = [['dollar', 'Nearest $1'], ['five', 'Nearest $5'], ['up00', 'Up to .00'], ['up99', 'Up to .99'], ['none', 'To the cent']];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
const KIND = { standard: 'Standard', office: 'Office', ppo: 'Insurance (PPO)' };
const LAST = 'dm_fee_raise';
const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST)) || {}; } catch { return {}; } };
const saveLast = (v) => { try { localStorage.setItem(LAST, JSON.stringify(v)); } catch { /* storage off */ } };
const pct = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${v}%`);
const signed = (c) => (c == null ? '' : `${c > 0 ? '+' : c < 0 ? '−' : ''}${money(Math.abs(c))}`);
const codesOf = (s) => String(s || '').split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
const nextJan1 = (today) => `${Number(today.slice(0, 4)) + 1}-01-01`;

export default function FeeScheduleManager() {
  const { practice, can } = useAuth();
  const tz = practice?.timezone || 'America/New_York';
  const today = practiceToday(tz);
  const canManage = can('fees:manage');
  const schedules = useApi('/fees/schedules');
  const changes = useApi('/fees/changes');
  const [panel, setPanel] = useState(null); // { type: 'raise' | 'import' | 'change' | 'history', ... }
  const reload = () => { schedules.reload(); changes.reload(); };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && panel) { setPanel(null); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.key === 'r' && canManage) { e.preventDefault(); setPanel({ type: 'raise' }); }
      if (e.key === 'i') { e.preventDefault(); setPanel({ type: 'import' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, canManage]);

  const list = schedules.data || [];
  const waiting = changes.data || [];
  return (
    <div className="fsm">
      <div className="card">
        <div className="fsm-head">
          <div>
            <h2 style={{ margin: 0 }}>Fee schedules</h2>
            <p className="muted fsm-sub">Raise fees by a percentage now or on a date, bring in a payer’s new fee schedule, and see every earlier version. Estimates and claims always use the fees in effect on the date of service.</p>
          </div>
          <div className="fsm-actions">
            {canManage && <button className="primary" onClick={() => setPanel({ type: 'raise' })} aria-keyshortcuts="r"><Percent size={15} aria-hidden="true" /> Raise fees</button>}
            <button onClick={() => setPanel({ type: 'import' })} aria-keyshortcuts="i"><Upload size={15} aria-hidden="true" /> Import payer schedule</button>
          </div>
        </div>
        <ErrorBox error={schedules.error || changes.error} />

        {waiting.length > 0 && (
          <div className="fsm-waiting" aria-label="Waiting">
            <h3>Waiting</h3>
            {waiting.map((c) => (
              <button key={c.id} className="fsm-row fsm-change" onClick={() => setPanel({ type: 'change', id: c.id })}>
                {c.status === 'draft' ? <AlertTriangle size={16} className="fsm-warn" aria-hidden="true" /> : <CalendarClock size={16} aria-hidden="true" />}
                <span className="fsm-grow">
                  <strong>{c.schedule_name}</strong>{' — '}
                  {c.kind === 'increase' ? `${pct(c.params.percent)} (${c.summary.changed} fees)` : `new schedule from ${c.file_name || 'an upload'}${c.source === 'inbox' ? ' (inbox)' : ''}`}
                  <span className="muted"> · {c.status === 'draft' ? 'needs approval' : `from ${fmtDate(c.effective_date)}`}{c.created_by_name ? ` · ${c.created_by_name}` : ''}</span>
                </span>
                <span className={`badge ${c.status === 'draft' ? 'warn' : 'ok'}`}>{c.status === 'draft' ? 'Review' : 'Scheduled'}</span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        <div className="table-wrap">
          <table className="fsm-table">
            <thead><tr><th>Schedule</th><th>Kind</th><th className="num">Codes</th><th>In effect</th><th>Last updated</th><th>Next change</th><th aria-label="History" /></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.key} className={s.active ? '' : 'muted'}>
                  <td><strong>{s.name}</strong>{s.carriers?.length > 0 && <div className="muted fsm-small">{s.carriers.map((c) => c.name).join(', ')}</div>}</td>
                  <td>{KIND[s.kind] || s.kind}</td>
                  <td className="num">{s.code_count}</td>
                  <td>{s.current_version ? `v${s.current_version.version_no}${s.current_version.effective_from > '1900-01-01' ? ` · since ${fmtDate(s.current_version.effective_from)}` : ''}` : <span className="muted">—</span>}</td>
                  <td>{s.last_updated_at ? <>{fmtUtcDate(s.last_updated_at, tz)}<div className="muted fsm-small">{[s.last_updated_by, s.last_updated_how].filter(Boolean).join(' · ')}</div></> : <span className="muted">Not changed yet</span>}</td>
                  <td>{s.next_change ? <span className="badge ok">{fmtDate(s.next_change.effective_date)}</span> : s.drafts ? <span className="badge warn">Draft to review</span> : <span className="muted">—</span>}</td>
                  <td><button className="small" onClick={() => setPanel({ type: 'history', key: s.id ?? 'standard', name: s.name, kind: s.kind, id: s.id })}><History size={14} aria-hidden="true" /> History{s.versions > 1 ? ` (${s.versions})` : ''}</button></td>
                </tr>
              ))}
              {!schedules.data && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {panel && (
        <aside className="fsm-panel" role="dialog" aria-modal="false" aria-label={panel.type === 'raise' ? 'Raise fees' : panel.type === 'import' ? 'Import a payer schedule' : panel.type === 'history' ? 'Fee schedule history' : 'Fee change'}>
          <button className="small fsm-close" onClick={() => setPanel(null)} aria-label="Close"><X size={16} aria-hidden="true" /></button>
          {panel.type === 'raise' && <RaisePanel schedules={list} today={today} onDone={() => { setPanel(null); reload(); }} />}
          {panel.type === 'import' && <ImportPanel schedules={list.filter((s) => s.id)} today={today} onRead={(id) => { changes.reload(); setPanel({ type: 'change', id }); }} />}
          {panel.type === 'change' && <ChangePanel id={panel.id} today={today} canManage={canManage} onDone={() => { setPanel(null); reload(); }} />}
          {panel.type === 'history' && <HistoryPanel schedule={panel} tz={tz} />}
        </aside>
      )}
    </div>
  );
}

// ---- Raise fees by a % ----
function RaisePanel({ schedules, today, onDone }) {
  const last = readLast();
  const [form, setForm] = useState({
    keys: ['standard'], percent: last.percent ?? 5, rounding: last.rounding || 'dollar', mode: 'all', categories: [], codes: '', exclude: '',
    effective_date: nextJan1(today), note: '',
  });
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const body = useMemo(() => ({
    fee_schedule_ids: form.keys, percent: Number(form.percent), rounding: form.rounding, effective_date: form.effective_date,
    scope: { mode: form.mode, categories: form.categories, codes: codesOf(form.codes), exclude: codesOf(form.exclude) },
  }), [form]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.post('/fees/increase/preview', body).then((p) => { if (alive) { setPreview(p); setErr(null); } }).catch((e) => alive && setErr(e));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [body]);
  const now = form.effective_date <= today;
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const out = await api.post('/fees/increases', { ...body, note: form.note || null });
      saveLast({ percent: Number(form.percent), rounding: form.rounding });
      const ids = out.changes.filter((c) => c.status === 'scheduled').map((c) => c.id);
      toast(out.applied ? `Fees raised ${pct(Number(form.percent))} — a new version of each schedule was kept` : `${pct(Number(form.percent))} scheduled for ${fmtDate(form.effective_date)}`, {
        undo: ids.length ? async () => { for (const id of ids) await api.post(`/fees/changes/${id}/cancel`, { reason: 'Undone right after scheduling' }); toast('Cancelled'); onDone(); } : null,
      });
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <form onSubmit={submit} className="fsm-form">
      <h2><Percent size={18} aria-hidden="true" /> Raise fees</h2>
      <fieldset>
        <legend>Which fees</legend>
        <div className="chips">
          {schedules.filter((s) => s.active).map((s) => (
            <button type="button" key={s.key} className={`chip${form.keys.includes(s.id ?? 'standard') ? ' active' : ''}`} aria-pressed={form.keys.includes(s.id ?? 'standard')}
              onClick={() => set({ keys: toggle(form.keys, s.id ?? 'standard') })}>{s.name}</button>
          ))}
        </div>
      </fieldset>
      <div className="fsm-grid">
        <label>By (%)<input type="number" step="0.1" min="-50" max="100" autoFocus value={form.percent} onChange={(e) => set({ percent: e.target.value })} /></label>
        <label>Rounding<select value={form.rounding} onChange={(e) => set({ rounding: e.target.value })}>{ROUNDING.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <label>Starting<input type="date" min={today} value={form.effective_date} onChange={(e) => set({ effective_date: e.target.value })} /></label>
      </div>
      <fieldset>
        <legend>Codes</legend>
        <div className="chips">
          {[['all', 'All codes'], ['categories', 'Categories'], ['codes', 'A list of codes']].map(([k, t]) => (
            <button type="button" key={k} className={`chip${form.mode === k ? ' active' : ''}`} aria-pressed={form.mode === k} onClick={() => set({ mode: k })}>{t}</button>
          ))}
        </div>
        {form.mode === 'categories' && (
          <div className="chips fsm-gap">{CATEGORIES.map((c) => <button type="button" key={c} className={`chip${form.categories.includes(c) ? ' active' : ''}`} aria-pressed={form.categories.includes(c)} onClick={() => set({ categories: toggle(form.categories, c) })}>{label(c)}</button>)}</div>
        )}
        {form.mode === 'codes' && <label className="fsm-gap">Codes (D27* = every code starting D27)<input value={form.codes} placeholder="D0120, D1110, D27*" onChange={(e) => set({ codes: e.target.value })} /></label>}
        <label className="fsm-gap">Leave out<input value={form.exclude} placeholder="e.g. D1110, D0272" onChange={(e) => set({ exclude: e.target.value })} /></label>
      </fieldset>
      <label>Note (optional)<input value={form.note} placeholder="e.g. Annual increase" onChange={(e) => set({ note: e.target.value })} /></label>
      <ErrorBox error={err} />
      {preview && (
        <div className="fsm-preview">
          <div className="fsm-totals">
            <div><span className="muted">Fees changing</span><strong>{preview.totals.changed}</strong></div>
            <div><span className="muted">Last 12 months</span><strong>{preview.totals.procedures_12m} procedures</strong></div>
            <div><span className="muted">Estimated yearly effect</span><strong className={preview.totals.impact_12m >= 0 ? 'fsm-up' : 'fsm-down'}>{signed(preview.totals.impact_12m)}</strong></div>
          </div>
          {preview.previews.map((p) => (
            <details key={p.schedule.key} open={preview.previews.length === 1}>
              <summary>{p.schedule.name}: {p.summary.changed} fees · {signed(p.summary.impact_12m)} a year</summary>
              <div className="fsm-scroll">
                <table className="compact-table fsm-lines">
                  <thead><tr><th>Code</th><th>Description</th><th className="num">Now</th><th className="num">New</th><th className="num">Change</th><th className="num">Done (12 mo)</th></tr></thead>
                  <tbody>{p.rows.filter((r) => r.change).slice(0, 400).map((r) => (
                    <tr key={r.code}><td>{r.code}</td><td className="fsm-desc">{r.description}</td><td className="num">{money(r.old_fee)}</td><td className="num"><strong>{money(r.new_fee)}</strong></td><td className="num">{signed(r.change)}</td><td className="num">{r.used_12m || ''}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy || !preview?.totals.changed}>{now ? <><Check size={15} aria-hidden="true" /> Apply now</> : <><CalendarClock size={15} aria-hidden="true" /> Schedule for {fmtDate(form.effective_date)}</>}</button>
      </div>
    </form>
  );
}

// ---- Import a payer's schedule ----
function ImportPanel({ schedules, today, onRead }) {
  const ppo = schedules.filter((s) => s.active);
  const [fsId, setFsId] = useState(() => ppo.find((s) => s.kind === 'ppo')?.id ?? ppo[0]?.id ?? '');
  const [effective, setEffective] = useState('');
  const [text, setText] = useState('');
  const [inbox, setInbox] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const send = async (payload) => {
    setBusy(true);
    setErr(null);
    try {
      if (inbox) {
        await api.post(`/fees/inbox/${fsId}`, payload);
        toast('In the inbox — it will be read shortly and wait for approval');
        return;
      }
      const d = await api.post('/fees/imports', { fee_schedule_id: Number(fsId), effective_date: effective || undefined, ...payload });
      if (d.duplicate) toast('That file was already brought in — here it is');
      onRead(d.id);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const onFile = async (file) => {
    if (!file) return;
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await send({ file_base64: b64, mime: file.type || (/\.csv$/i.test(file.name) ? 'text/csv' : ''), file_name: file.name });
  };
  if (!ppo.length) return <div><h2>Import a payer schedule</h2><p className="muted">Add an insurance fee schedule first (Settings → Fee schedules below), then bring in the payer’s file here.</p></div>;
  return (
    <div className="fsm-form">
      <h2><Upload size={18} aria-hidden="true" /> Import a payer schedule</h2>
      <p className="muted fsm-small">CSV or Excel (.xlsx) with a code column and a fee column, or the payer’s PDF (read by AI). You’ll see every difference before anything changes.</p>
      <div className="fsm-grid">
        <label>Schedule<select value={fsId} onChange={(e) => setFsId(e.target.value)}>{ppo.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Effective (blank = as printed, or today)<input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
      </div>
      <label className="checkbox"><input type="checkbox" checked={inbox} onChange={(e) => setInbox(e.target.checked)} /> Put it in this schedule’s inbox instead (read in the background, then waits for approval)</label>
      <div className="fsm-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
        <FileSpreadsheet size={22} aria-hidden="true" />
        <div>Drop the file here, or</div>
        <button type="button" className="primary" disabled={busy || !fsId} onClick={() => fileRef.current?.click()}>{busy ? 'Reading…' : 'Choose file'}</button>
        <input ref={fileRef} type="file" hidden accept=".csv,.txt,.xlsx,.pdf,.png,.jpg,.jpeg,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg" onChange={(e) => onFile(e.target.files?.[0])} data-testid="fee-file" />
      </div>
      <details>
        <summary>Or paste it</summary>
        <textarea rows={6} value={text} placeholder={'code,fee\nD0120,42.00\nD1110,78.00'} onChange={(e) => setText(e.target.value)} />
        <button type="button" disabled={busy || !text.trim()} onClick={() => send({ text, file_name: 'Pasted table' })}>Read it</button>
      </details>
      <ErrorBox error={err} />
      <p className="muted fsm-small">Today is {fmtDate(today)}.</p>
    </div>
  );
}

// ---- One planned change: review and approve an import, or edit / cancel a scheduled increase ----
const FILTERS = [['review', 'Changes'], ['changed', 'Changed'], ['new', 'New'], ['missing', 'Missing'], ['check', 'To check'], ['all', 'All']];
function ChangePanel({ id, today, canManage, onDone }) {
  const { data: c, error, reload } = useApi(`/fees/changes/${id}`);
  const [filter, setFilter] = useState('review');
  const [skip, setSkip] = useState(null);
  const [effective, setEffective] = useState('');
  const [dropMissing, setDropMissing] = useState(false);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!c) return;
    setSkip(new Set(c.items.filter((i) => i.skip).map((i) => i.code)));
    setEffective(c.effective_date || today);
    setDropMissing(!!c.params?.drop_missing);
    if (c.kind === 'increase') setEdit({ percent: c.params.percent, rounding: c.params.rounding });
  }, [c, today]);
  if (error) return <ErrorBox error={error} />;
  if (!c || !skip) return <div className="muted">Loading…</div>;
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const approve = () => run(async () => {
    const out = await api.post(`/fees/changes/${c.id}/approve`, { effective_date: effective, drop_missing: dropMissing, skip_codes: [...skip] });
    toast(out.applied_now ? `${c.schedule_name} updated — the old fees are kept as the previous version` : `${c.schedule_name} will update on ${fmtDate(out.effective_date)}`);
    onDone();
  });
  const cancel = () => run(async () => {
    await api.post(`/fees/changes/${c.id}/cancel`, { reason: c.status === 'draft' ? 'Not approved' : 'Cancelled before it applied' });
    toast(c.status === 'draft' ? 'Import rejected — nothing changed' : 'Cancelled — nothing will change');
    onDone();
  });
  const saveEdit = () => run(async () => {
    await api.put(`/fees/changes/${c.id}`, { percent: Number(edit.percent), rounding: edit.rounding, effective_date: effective });
    toast('Saved');
    reload();
  });
  const open = ['draft', 'scheduled'].includes(c.status);
  const shown = c.items.filter((i) => (filter === 'all' ? true : filter === 'review' ? i.flag !== 'same' : filter === 'check' ? i.warn === 'high' || i.warn === 'low' || i.warn === 'unknown_code' : i.flag === filter));
  const warnText = { high: 'Over 3× your fee', low: 'Under ⅓ of your fee', unknown_code: 'Not one of your codes' };
  return (
    <div className="fsm-form">
      <h2>{c.kind === 'import' ? <Sparkles size={18} aria-hidden="true" /> : <Percent size={18} aria-hidden="true" />} {c.schedule_name}</h2>
      <p className="muted fsm-small">
        {c.kind === 'import' ? `From ${c.file_name || 'an upload'} · read by ${c.reader === 'ai' ? 'AI' : c.reader === 'sandbox' ? 'the sandbox reader' : c.reader?.toUpperCase()}` : `${pct(c.params.percent)} · ${ROUNDING.find(([k]) => k === c.params.rounding)?.[1] || ''}`}
        {c.created_by_name && ` · by ${c.created_by_name}`}{c.approved_by_name && ` · approved by ${c.approved_by_name}`} · <span className={`badge ${c.status === 'draft' ? 'warn' : c.status === 'applied' || c.status === 'scheduled' ? 'ok' : 'danger'}`}>{c.status}</span>
      </p>
      {c.ai_reason && <p className="fsm-reason"><Sparkles size={14} aria-hidden="true" /> {c.ai_reason}</p>}
      {c.summary?.warnings?.length > 0 && <ul className="fsm-warnings">{c.summary.warnings.slice(0, 6).map((w) => <li key={w}>{w}</li>)}</ul>}
      {c.last_error && <div className="error">Last try failed: {c.last_error}</div>}
      {c.kind === 'import' && (
        <div className="fsm-totals">
          <div><span className="muted">Changed</span><strong>{c.summary.changed}</strong></div>
          <div><span className="muted">New</span><strong>{c.summary.new}</strong></div>
          <div><span className="muted">Missing</span><strong>{c.summary.missing}</strong></div>
          <div><span className="muted">To check</span><strong className={c.summary.suspicious + c.summary.unknown ? 'fsm-warn' : ''}>{c.summary.suspicious + c.summary.unknown}</strong></div>
        </div>
      )}
      {c.kind === 'import' && <div className="chips">{FILTERS.map(([k, t]) => <button type="button" key={k} className={`chip${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{t}</button>)}</div>}
      <div className="fsm-scroll">
        <table className="compact-table fsm-lines">
          <thead><tr>{c.kind === 'import' && open && <th aria-label="Include" />}<th>Code</th><th>Description</th><th className="num">Now</th><th className="num">New</th><th className="num">Change</th>{c.kind === 'import' && <th className="num">Your fee</th>}{c.kind === 'import' && <th />}</tr></thead>
          <tbody>
            {shown.slice(0, 500).map((i) => (
              <tr key={i.code} className={skip.has(i.code) ? 'fsm-skipped' : ''}>
                {c.kind === 'import' && open && <td><input type="checkbox" aria-label={`Include ${i.code}`} checked={!skip.has(i.code)} disabled={i.flag === 'same' || i.flag === 'missing'}
                  onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(i.code)) n.delete(i.code); else n.add(i.code); return n; })} /></td>}
                <td>{i.code}</td>
                <td className="fsm-desc">{i.description}</td>
                <td className="num">{i.old_fee == null ? '—' : money(i.old_fee)}</td>
                <td className="num"><strong>{i.new_fee == null ? '—' : money(i.new_fee)}</strong></td>
                <td className="num">{i.change != null ? <>{signed(i.change)} <span className="muted">{pct(i.pct)}</span></> : ''}</td>
                {c.kind === 'import' && <td className="num muted">{i.ucr == null ? '' : money(i.ucr)}</td>}
                {c.kind === 'import' && <td>{i.warn ? <span className="badge warn" title={warnText[i.warn]}>{warnText[i.warn]}</span> : i.flag !== 'changed' && <span className="badge">{i.flag}</span>}</td>}
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="muted">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
      <ErrorBox error={err} />
      {open && canManage && (
        <div className="fsm-foot">
          {c.kind === 'increase' && edit && (
            <div className="fsm-grid">
              <label>By (%)<input type="number" step="0.1" value={edit.percent} onChange={(e) => setEdit({ ...edit, percent: e.target.value })} /></label>
              <label>Rounding<select value={edit.rounding} onChange={(e) => setEdit({ ...edit, rounding: e.target.value })}>{ROUNDING.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
              <label>Starting<input type="date" min={today} value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
            </div>
          )}
          {c.kind === 'import' && (
            <div className="fsm-grid">
              <label>Effective from<input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
              {c.summary.missing > 0 && <label className="checkbox"><input type="checkbox" checked={dropMissing} onChange={(e) => setDropMissing(e.target.checked)} /> Remove the {c.summary.missing} codes missing from the new schedule</label>}
            </div>
          )}
          <div className="form-actions">
            <button type="button" onClick={cancel} disabled={busy}><X size={15} aria-hidden="true" /> {c.status === 'draft' ? 'Reject' : 'Cancel this change'}</button>
            {c.kind === 'increase' && <button type="button" onClick={saveEdit} disabled={busy}>Save changes</button>}
            {c.kind === 'import' && c.status === 'draft' && (
              <button type="button" className="primary" onClick={approve} disabled={busy} autoFocus>
                <Check size={15} aria-hidden="true" /> {effective <= today ? 'Approve and apply' : `Approve for ${fmtDate(effective)}`}
              </button>
            )}
          </div>
        </div>
      )}
      {open && !canManage && <p className="muted fsm-small">Someone with permission to change fees approves this.</p>}
    </div>
  );
}

// ---- Versions: hidden until asked, viewable, any two compared ----
function HistoryPanel({ schedule, tz }) {
  const { data, error } = useApi(`/fees/schedules/${schedule.key}/versions`);
  const [pickA, setPickA] = useState(null);
  const [pickB, setPickB] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [view, setView] = useState(null);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!data?.versions?.length) return;
    setPickB(data.versions[0].id);
    setPickA(data.versions[1]?.id ?? null);
  }, [data]);
  useEffect(() => {
    if (schedule.kind !== 'ppo' || !schedule.id) return undefined;
    let alive = true;
    api.get(`/fees/reports/write-offs?fee_schedule_id=${schedule.id}`).then((r) => alive && setReport(r)).catch(() => {}); // needs reports:read; hidden otherwise
    return () => { alive = false; };
  }, [schedule]);
  const compare = async () => {
    setErr(null);
    try { setCmp(await api.get(`/fees/compare?a=${pickA}&b=${pickB}`)); setView(null); } catch (x) { setErr(x); }
  };
  const show = async (id) => {
    setErr(null);
    try { setView(await api.get(`/fees/versions/${id}`)); setCmp(null); } catch (x) { setErr(x); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="fsm-form">
      <h2><History size={18} aria-hidden="true" /> {schedule.name}</h2>
      {!data.versions.length && <p className="muted">No changes recorded yet. The first change keeps today’s fees as version 1.</p>}
      {data.versions.length > 0 && (
        <table className="compact-table fsm-versions">
          <thead><tr><th>A</th><th>B</th><th>Version</th><th>In effect from</th><th>How</th><th>Who</th><th /></tr></thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.id}>
                <td><input type="radio" name="fsm-a" aria-label={`Compare from version ${v.version_no}`} checked={pickA === v.id} onChange={() => setPickA(v.id)} /></td>
                <td><input type="radio" name="fsm-b" aria-label={`Compare to version ${v.version_no}`} checked={pickB === v.id} onChange={() => setPickB(v.id)} /></td>
                <td>v{v.version_no}{v.current && <span className="badge ok">current</span>}</td>
                <td>{v.effective_from <= '1900-01-01' ? 'the beginning' : fmtDate(v.effective_from)}</td>
                <td>{v.source}{v.note && <div className="muted fsm-small">{v.note}</div>}</td>
                <td>{v.created_by_name || (v.actor_source === 'automation' ? 'Automatic' : '—')}{v.approved_by_name && v.approved_by_name !== v.created_by_name && <div className="muted fsm-small">approved by {v.approved_by_name}</div>}<div className="muted fsm-small">{fmtUtcDate(v.created_at, tz)}</div></td>
                <td><button className="small" onClick={() => show(v.id)}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.versions.length > 1 && <button type="button" onClick={compare} disabled={!pickA || !pickB || pickA === pickB}><GitCompare size={15} aria-hidden="true" /> Compare A with B</button>}
      <ErrorBox error={err} />
      {cmp && (
        <div>
          <p className="muted fsm-small">v{cmp.a.version_no} → v{cmp.b.version_no}: {cmp.summary.changed} changed, {cmp.summary.added} added, {cmp.summary.removed} removed, {cmp.summary.same} the same.</p>
          <div className="fsm-scroll">
            <table className="compact-table fsm-lines">
              <thead><tr><th>Code</th><th>Description</th><th className="num">v{cmp.a.version_no}</th><th className="num">v{cmp.b.version_no}</th><th className="num">Change</th></tr></thead>
              <tbody>{cmp.rows.filter((r) => r.status !== 'same').slice(0, 500).map((r) => (
                <tr key={r.code}><td>{r.code}</td><td className="fsm-desc">{r.description}</td><td className="num">{r.a == null ? '—' : money(r.a)}</td><td className="num">{r.b == null ? '—' : money(r.b)}</td><td className="num">{r.status === 'changed' ? <>{signed(r.change)} <span className="muted">{pct(r.pct)}</span></> : <span className="badge">{r.status}</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      {view && (
        <div>
          <p className="muted fsm-small">Version {view.version_no}: {view.items.length} codes.</p>
          <div className="fsm-scroll">
            <table className="compact-table fsm-lines"><tbody>{view.items.slice(0, 800).map((i) => <tr key={i.code}><td>{i.code}</td><td className="fsm-desc">{i.description}</td><td className="num">{money(i.fee)}</td></tr>)}</tbody></table>
          </div>
        </div>
      )}
      {report?.rows?.length > 0 && (
        <div>
          <h3>Write-offs by version</h3>
          <table className="compact-table fsm-lines">
            <thead><tr><th>Version</th><th className="num">Procedures</th><th className="num">Billed</th><th className="num">Written off</th><th className="num">%</th></tr></thead>
            <tbody>{report.rows.map((r) => (
              <tr key={r.version_id ?? 'x'}><td>{r.version_no ? `v${r.version_no}` : 'current'}{r.effective_from && r.effective_from > '1900-01-01' ? ` (${fmtDate(r.effective_from)})` : ''}</td><td className="num">{r.procedures}</td><td className="num">{money(r.billed)}</td><td className="num">{money(r.write_off_posted || r.write_off_estimated)}</td><td className="num">{r.write_off_pct ?? ''}%</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
