import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, Download, RotateCw, Sparkles, ShieldCheck } from 'lucide-react';
import { api, download } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import { fmtDate, fmtDateTime, label } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import './chartaudit.css';

// Chart audit (CA1-CA4): every completed visit checked for what a defensible chart needs, grouped by provider and
// sorted by risk. Each row says what's missing and why it matters; "Open visit" and "Add addendum" fix it (signed
// notes are never changed). Rows clear themselves when the next check finds the chart fixed.
// Keys: J/K move, Enter opens the visit, A adds an addendum, X sets a row aside with a reason.
const SEVERITY = { high: 'Needs attention', medium: 'Should fix', low: 'Tidy up' };
const STATES = { clean: ['Checked clean', 'ok'], ready_with_notes: ['Ready, with notes', 'info'], checked: ['Checked, not marked ready', ''], open_items: ['Open items', 'warn'], not_checked: ['Not checked', ''] };

export default function ChartAudit() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'findings';
  const { data: rules } = useApi('/chart-audit/rules');
  const manager = !!rules?.can_manage;
  const tabs = [['findings', 'Findings'], ['queue', 'Doctor’s review queue'], ['trend', 'Trend'], ...(manager ? [['coaching', 'Assistants'], ['rules', 'Rules']] : [])];
  return (
    <div className="ca-page">
      <div className="page-header">
        <div>
          <h1><ShieldCheck size={22} className="ca-h-icon" /> Chart audit</h1>
          <div className="muted">Every completed visit, checked for what a complete, defensible chart has. Fix what’s listed — it clears on the next check.</div>
        </div>
      </div>
      <div className="tabs ca-noprint">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'findings' && <Findings manager={manager} />}
      {tab === 'queue' && <Queue manager={manager} />}
      {tab === 'trend' && <Trend />}
      {tab === 'coaching' && manager && <Coaching />}
      {tab === 'rules' && manager && <Rules />}
    </div>
  );
}

function Findings({ manager }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const providers = useLookup('/providers');
  const [f, setF] = useState({ status: 'open', provider_id: '', check: '', severity: '', from: '', to: '' });
  const query = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, error, reload } = useApi(`/chart-audit/findings?${query}`);
  const [sel, setSel] = useState(0);
  const [panel, setPanel] = useState(null); // { id, kind: 'addendum' | 'aside', text }
  const [err, setErr] = useState(null);
  const [running, setRunning] = useState(false);
  const rows = useMemo(() => {
    // Grouped by provider (most high-risk first), risk order within each.
    const order = new Map((data?.groups || []).map((g, i) => [g.provider_id ?? 0, i]));
    return [...(data?.findings || [])].sort((a, b) => (order.get(a.provider_id ?? 0) ?? 99) - (order.get(b.provider_id ?? 0) ?? 99) || b.risk - a.risk);
  }, [data]);
  useEffect(() => { setSel(0); }, [query]);
  const current = rows[sel];
  const openVisit = (r) => r && navigate(`/patients/${r.patient_id}?tab=notes${r.appointment_id ? `&visit=${r.appointment_id}` : ''}`);

  useShortcuts([
    { combo: 'j', label: 'Next finding', handler: () => setSel((i) => Math.min(rows.length - 1, i + 1)) },
    { combo: 'k', label: 'Previous finding', handler: () => setSel((i) => Math.max(0, i - 1)) },
    { combo: 'enter', label: 'Open the visit', handler: () => openVisit(current) },
    { combo: 'a', label: 'Add an addendum', handler: () => current?.note_id && setPanel({ id: current.id, kind: 'addendum', text: '' }) },
    { combo: 'x', label: 'Set aside with a reason', handler: () => current && setPanel({ id: current.id, kind: 'aside', text: '' }) },
  ]);
  useEffect(() => { document.querySelector('.ca-row.kb')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const act = async (fn) => {
    setErr(null);
    try { await fn(); setPanel(null); reload(); } catch (e) { setErr(e); }
  };
  const addendum = (r, text) => act(async () => {
    const a = await api.post(`/notes/${r.note_id}/addenda`, { body: text });
    if (can('clinical:sign')) await api.post(`/notes/${a.id}/sign`).catch(() => toast('Addendum saved — it still needs a signature', { tone: 'warn' }));
    toast('Addendum added. The finding clears on the next check.');
  });
  const runNow = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.post('/chart-audit/run');
      toast(r.running ? 'A check is already running' : `Checked ${r.visits} visits: ${r.opened} new, ${r.resolved} fixed`);
      reload();
    } catch (e) { setErr(e); } finally { setRunning(false); }
  };

  let lastProvider;
  return (
    <>
      <div className="ca-filters ca-noprint">
        <select aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="open">Open</option><option value="acknowledged">Set aside</option><option value="resolved">Fixed</option><option value="all">All</option>
        </select>
        {manager && (
          <select aria-label="Provider" value={f.provider_id} onChange={(e) => setF({ ...f, provider_id: e.target.value })}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <select aria-label="Check" value={f.check} onChange={(e) => setF({ ...f, check: e.target.value })}>
          <option value="">Every check</option>
          {Object.entries(data?.checks || {}).filter(([k]) => rules_audit(k)).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
        </select>
        <select aria-label="Risk" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
          <option value="">Any risk</option>{Object.entries(SEVERITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input type="date" aria-label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input type="date" aria-label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <span className="ca-spacer" />
        <button className="small" onClick={() => window.print()}><Printer size={14} /> Print</button>
        <button className="small" onClick={() => download(`/chart-audit/findings.csv?${query}`, 'chart-audit.csv').catch(setErr)}><Download size={14} /> CSV</button>
        {manager && <button className="small" disabled={running} onClick={runNow}><RotateCw size={14} /> {running ? 'Checking…' : 'Check now'}</button>}
      </div>
      <div className="kb-hint muted ca-noprint"><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>Enter</kbd> open visit · <kbd>A</kbd> addendum · <kbd>X</kbd> set aside</div>
      {data?.last_run && <div className="muted ca-last">Last checked {fmtDateTime(String(data.last_run.finished_at || data.last_run.started_at).replace('T', ' ').slice(0, 16))} UTC · {data.last_run.visits} visits</div>}
      <ErrorBox error={error || err} />
      {data?.groups?.length > 0 && (
        <div className="ca-summary">
          {data.groups.map((g) => (
            <button key={g.provider_id ?? 0} className={`ca-sum ${String(g.provider_id ?? '') === f.provider_id ? 'on' : ''}`} onClick={() => manager && setF({ ...f, provider_id: f.provider_id === String(g.provider_id) ? '' : String(g.provider_id ?? '') })}>
              <strong>{g.provider_name}</strong>
              <span>{g.visits} visit{g.visits === 1 ? '' : 's'} · {g.total} item{g.total === 1 ? '' : 's'}</span>
              <span className="ca-pills">{g.high > 0 && <em className="high">{g.high}</em>}{g.medium > 0 && <em className="medium">{g.medium}</em>}{g.low > 0 && <em className="low">{g.low}</em>}</span>
            </button>
          ))}
        </div>
      )}
      {data && rows.length === 0 && <div className="card empty">{f.status === 'open' ? 'Nothing open. Every checked visit has what it needs.' : 'Nothing matches.'}</div>}
      <div className="ca-list">
        {rows.map((r, i) => {
          const head = r.provider_id !== lastProvider;
          lastProvider = r.provider_id;
          return (
            <div key={r.id}>
              {head && <h3 className="ca-group">{r.provider_name || 'No provider'}</h3>}
              <div className={`ca-row sev-${r.severity} ${i === sel ? 'kb' : ''}`} onClick={() => setSel(i)}>
                <div className="ca-when"><strong>{r.patient_name}</strong><span className="muted">{fmtDate(r.visit_date)}</span></div>
                <div className="ca-what">
                  <div className="ca-title">{r.title}{r.source === 'ai' && <span className="ca-ai" title="Found by the AI reading the note — it only recommends"><Sparkles size={11} /> AI read</span>}{r.status !== 'open' && <span className="ca-status">{r.status === 'resolved' ? `Fixed ${fmtDate(String(r.resolved_at).slice(0, 10))}` : `Set aside: ${r.ack_reason}`}</span>}</div>
                  {r.detail && <div className="ca-detail">{r.detail}</div>}
                  {r.evidence && <blockquote className="ca-quote">“{r.evidence}”</blockquote>}
                  <div className="ca-why">{r.why}</div>
                  {panel?.id === r.id && (
                    <div className="ca-panel ca-noprint" onClick={(e) => e.stopPropagation()}>
                      <textarea rows={3} autoFocus value={panel.text} onChange={(e) => setPanel({ ...panel, text: e.target.value })} placeholder={panel.kind === 'addendum' ? 'Addendum: the late entry or correction…' : 'Why this is fine (e.g. documented on the paper chart, scanned)…'} />
                      <div className="form-actions">
                        <button className="small" onClick={() => setPanel(null)}>Cancel</button>
                        <button className="small primary" disabled={panel.text.trim().length < 3} onClick={() => (panel.kind === 'addendum' ? addendum(r, panel.text) : act(() => api.post(`/chart-audit/findings/${r.id}/acknowledge`, { reason: panel.text })))}>
                          {panel.kind === 'addendum' ? 'Save addendum' : 'Set aside'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="ca-actions ca-noprint">
                  <button className="small" onClick={() => openVisit(r)}>Open visit</button>
                  {r.note_id && r.status === 'open' && <button className="small" onClick={() => setPanel({ id: r.id, kind: 'addendum', text: '' })}>Add addendum</button>}
                  {r.status === 'open' && <button className="small link" onClick={() => setPanel({ id: r.id, kind: 'aside', text: '' })}>Set aside</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
// The report lists the nightly checks (the "Check my chart" extras aren't kept as findings).
const rules_audit = (k) => !['spelling', 'grammar', 'template_field', 'note_not_linked'].includes(k);

function Queue({ manager }) {
  const navigate = useNavigate();
  const providers = useLookup('/providers');
  const [provider, setProvider] = useState('');
  const { data, error } = useApi(`/chart-audit/doctor-queue?days=30${provider ? `&provider_id=${provider}` : manager ? '&all=1' : ''}`);
  return (
    <>
      <p className="muted">Visits whose note still needs you. Charts your assistants checked clean come first — review and sign.</p>
      {manager && (
        <div className="ca-filters">
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Everyone</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <ErrorBox error={error} />
      {data?.length === 0 && <div className="card empty">Nothing waiting for review.</div>}
      {data?.length > 0 && (
        <table className="ca-table">
          <thead><tr><th>Visit</th><th>Patient</th><th>Note</th><th>Check</th><th>Prepared by</th><th /></tr></thead>
          <tbody>
            {data.map((q) => (
              <tr key={q.visit_key}>
                <td>{fmtDate(q.date)}</td>
                <td>{q.patient_name}</td>
                <td>{q.note === 'none' ? <span className="badge warn">No note</span> : label(q.note)}</td>
                <td>
                  <span className={`badge ${STATES[q.state][1]}`}>{STATES[q.state][0]}</span>
                  {q.acknowledged.length > 0 && <div className="ca-acks">{q.acknowledged.map((a, i) => <div key={i}>{a.title}: <em>{a.reason}</em></div>)}</div>}
                  {q.state === 'open_items' && q.last_check && <div className="muted ca-small">{q.last_check.problems} open · checked by {q.last_check.by}</div>}
                </td>
                <td>{q.prepared_by ? <>{q.prepared_by}<div className="muted ca-small">{fmtDateTime(String(q.ready_at).replace('T', ' ').slice(0, 16))} UTC</div></> : '—'}</td>
                <td><button className="small" onClick={() => navigate(`/patients/${q.patient_id}?tab=notes${q.appointment_id ? `&visit=${q.appointment_id}` : ''}`)}>Open visit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// Small bars: found per week (light) and how many of those are fixed (solid).
function Bars({ weeks, value, total }) {
  const max = Math.max(1, ...weeks.map(total));
  const w = 10;
  return (
    <svg className="ca-bars" width={weeks.length * (w + 3)} height={36} role="img" aria-label="Weekly trend">
      {weeks.map((x, i) => {
        const h = Math.round((total(x) / max) * 32);
        const v = Math.round((value(x) / max) * 32);
        return (
          <g key={x.week}>
            <title>{`Week of ${fmtDate(x.week)}: ${total(x)} found, ${value(x)} fixed`}</title>
            <rect x={i * (w + 3)} y={34 - h} width={w} height={h} rx={2} className="ca-bar-bg" />
            <rect x={i * (w + 3)} y={34 - v} width={w} height={v} rx={2} className="ca-bar-fg" />
          </g>
        );
      })}
    </svg>
  );
}

function Trend() {
  const { data, error } = useApi('/chart-audit/trend?weeks=12');
  return (
    <>
      <p className="muted">Items found on each week’s visits, and how many have been fixed since. Fewer, and more fixed, is the goal.</p>
      <ErrorBox error={error} />
      {data?.length === 0 && <div className="card empty">Nothing found in the last 12 weeks.</div>}
      <div className="ca-trend">
        {data?.map((p) => {
          const found = p.weeks.reduce((s, w) => s + w.found, 0);
          const fixed = p.weeks.reduce((s, w) => s + w.fixed, 0);
          return (
            <div key={p.provider_id ?? 0} className="card ca-trend-card">
              <strong>{p.provider_name}</strong>
              <div className="muted ca-small">{found} found · {fixed} fixed ({found ? Math.round((100 * fixed) / found) : 0}%)</div>
              <Bars weeks={p.weeks} total={(w) => w.found} value={(w) => w.fixed} />
            </div>
          );
        })}
      </div>
    </>
  );
}

function Coaching() {
  const { data, error } = useApi('/chart-audit/coaching?weeks=12');
  return (
    <>
      <p className="muted">How often each assistant’s first check of a chart came back with nothing to fix. For coaching — not a score.</p>
      <ErrorBox error={error} />
      {data?.length === 0 && <div className="card empty">No charts checked yet. Assistants use “Check my chart” (Alt+K) on a visit’s note.</div>}
      {data?.length > 0 && (
        <table className="ca-table">
          <thead><tr><th>Assistant</th><th>Charts checked</th><th>Clean first time</th><th>Items per chart</th><th>By week</th></tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.user_id}>
                <td>{p.name}</td><td>{p.checked}</td><td>{p.clean_rate}%</td><td>{p.avg_problems}</td>
                <td><Bars weeks={p.weeks} total={(w) => w.checked} value={(w) => w.clean} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Rules() {
  const { data, error, reload } = useApi('/chart-audit/rules');
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (data) setDraft(structuredClone(data.rules)); }, [data]);
  if (!data || !draft) return <ErrorBox error={error} />;
  const set = (k, v) => setDraft({ ...draft, [k]: v });
  const cats = (k) => (
    <div className="ca-cats">
      {data.categories.map((c) => (
        <label key={c} className="checkbox"><input type="checkbox" checked={draft[k].includes(c)} onChange={(e) => set(k, e.target.checked ? [...draft[k], c] : draft[k].filter((x) => x !== c))} /> {label(c)}</label>
      ))}
    </div>
  );
  const save = async () => {
    setErr(null);
    try {
      await api.put('/chart-audit/rules', { ...draft, change_reason: 'Chart audit rules updated' });
      toast('Saved. The next check uses these rules.');
      reload();
    } catch (e) { setErr(e); }
  };
  const num = (k, text) => <label>{text}<input type="number" value={draft[k]} onChange={(e) => set(k, Number(e.target.value))} /></label>;
  return (
    <div className="card ca-rules">
      <ErrorBox error={err} />
      <h3>Checks</h3>
      <div className="ca-checks">
        {Object.entries(data.checks).map(([k, c]) => (
          <label key={k} className="checkbox" title={c.why}><input type="checkbox" checked={!!draft.checks[k]} onChange={(e) => set('checks', { ...draft.checks, [k]: e.target.checked })} /> {c.label}</label>
        ))}
      </div>
      <h3>Timing</h3>
      <div className="ca-nums">
        {num('unsigned_grace_days', 'Days a note may wait for its signature')}
        {num('unsigned_high_days', 'Unsigned longer than this is high risk (days)')}
        {num('medical_history_days', 'Medical history review every (days)')}
        {num('perio_interval_days', 'Full perio charting every (days)')}
        {num('consent_valid_days', 'A signed consent covers (days)')}
        {num('lookback_days', 'Check visits from the last (days)')}
        <label>Blood pressure
          <select value={draft.bp_required} onChange={(e) => set('bp_required', e.target.value)}>
            <option value="anesthesia">When local anesthetic is used</option><option value="every_visit">At every visit</option><option value="never">Not required</option>
          </select>
        </label>
      </div>
      <h3>Which work needs a signed consent</h3>{cats('consent_categories')}
      <label className="ca-codes">Also these codes<input value={draft.consent_codes.join(' ')} onChange={(e) => set('consent_codes', e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean))} placeholder="e.g. D4341 D9944" /></label>
      <h3>Which work needs anesthetic details</h3>{cats('anesthetic_categories')}
      <label className="ca-codes">Also these codes<input value={draft.anesthetic_codes.join(' ')} onChange={(e) => set('anesthetic_codes', e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean))} /></label>
      <h3>Which work needs post-op instructions</h3>{cats('postop_categories')}
      <label className="checkbox ca-ai-toggle"><input type="checkbox" checked={draft.ai_compare} onChange={(e) => set('ai_compare', e.target.checked)} /> Let the AI read notes where the wording varies (it only recommends, quotes the sentence it used, and never edits a note){data.ai ? '' : ' — AI is off on this server'}</label>
      <div className="form-actions"><button className="primary" onClick={save}>Save rules</button></div>
    </div>
  );
}
