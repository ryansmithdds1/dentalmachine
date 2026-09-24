import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquare, PhoneCall, Plus, Trash2, RotateCcw, Play, Repeat, CalendarCheck, Users } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { money, fmtDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { CHANNEL_ICONS, CHANNEL_NAMES } from '../components/RecallStatus.jsx';
import './recall.css';

// Recall on autopilot (RC1–RC4, docs/workflows/specs/RC-recall.md). The cadence runs on its own; this screen
// shows only what needs a person — the calls to make, with one-key outcomes — and the results: who's due,
// what each step booked, reactivated patients, $ scheduled, per office. Administrators switch it on and shape
// each recall type's sequence on a timeline.

const dayLabel = (n) => (n === 0 ? 'Due date' : n < 0 ? `${-n} days before` : `${n} days after`);
const shortDay = (n) => (n === 0 ? 'Due' : n > 0 ? `+${n}` : `${n}`);

export default function Recall() {
  const { user, can } = useAuth();
  const admin = user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'today';
  const settings = useApi('/cadence/settings');
  const [busy, setBusy] = useState(false);
  const on = !!settings.data?.recall_enabled;

  const toggle = async () => {
    setBusy(true);
    try {
      await api.put('/cadence/settings', { recall_enabled: !on });
      toast(!on ? 'Recall autopilot is on — the first messages go out on the next pass (a few minutes).' : 'Recall autopilot is off. Nothing more will be sent.');
      settings.reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const s = await api.post('/cadence/run-now', {});
      toast(`Done: ${s.sent} sent, ${s.tasks} call${s.tasks === 1 ? '' : 's'} for the team, ${s.stopped} stopped (booked or not needed), ${s.enrolled} newly due.`);
      window.dispatchEvent(new Event('dm:refresh'));
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  useCommands([
    { id: 'recall-today', label: 'Recall: calls to make and results', hint: 'Recall', run: () => setParams({ tab: 'today' }) },
    { id: 'recall-sequences', label: 'Recall: edit the recall sequence', hint: 'Recall', run: () => setParams({ tab: 'sequences' }) },
  ]);

  return (
    <div className="rc-page">
      <div className="page-header">
        <div>
          <h1>Recall autopilot</h1>
          <div className="muted">Texts, emails, calls and postcards go out on their own around each patient’s due date and stop the moment they book. You only see the calls to make and the results.</div>
        </div>
        <div className="inline rc-head-actions">
          {settings.data && (
            <span className={`rc-state ${on ? 'on' : ''}`}><span className="rc-dot" />{on ? 'Running' : 'Off'}</span>
          )}
          {admin && settings.data && <button className={on ? '' : 'primary'} disabled={busy} onClick={toggle}>{on ? 'Turn off' : 'Turn on'}</button>}
          {admin && on && <button disabled={busy} onClick={runNow} title="Run the recall pass now instead of waiting a few minutes"><Play size={15} /> Run now</button>}
        </div>
      </div>
      {settings.data?.old_recall_messages && <div className="rc-note">The older automatic recall messages (Settings) are on. Turning on the autopilot replaces them, so nobody gets both.</div>}
      {settings.data && !on && !admin && <div className="rc-note">Recall autopilot is off. An administrator can turn it on here.</div>}
      <div className="tabs">
        <button className={tab === 'today' ? 'active' : ''} onClick={() => setParams({ tab: 'today' })}>Calls &amp; results</button>
        <button className={tab === 'sequences' ? 'active' : ''} onClick={() => setParams({ tab: 'sequences' })}>Sequences</button>
      </div>
      {tab === 'today' && (
        <>
          <CallList canLog={can('schedule:write')} />
          <Dashboard />
        </>
      )}
      {tab === 'sequences' && <Sequences admin={admin} settings={settings.data} />}
    </div>
  );
}

// ---- The results ----
function Dashboard() {
  const [days, setDays] = useState(90);
  const [office, setOffice] = useState('');
  const { data, error } = useApi(`/cadence/dashboard?days=${days}${office ? `&location_id=${office}` : ''}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const maxBooked = Math.max(1, ...data.by_step.map((s) => s.booked));
  const offices = data.by_office.filter((o) => o.location_id);
  return (
    <section className="rc-section">
      <div className="rc-section-head">
        <h2>Results</h2>
        <div className="inline">
          {offices.length > 1 && (
            <select value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Office">
              <option value="">All offices</option>
              {offices.map((o) => <option key={o.location_id} value={o.location_id}>{o.name}</option>)}
            </select>
          )}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
      </div>
      <div className="rc-tiles">
        <Tile label="Due in 30 days" value={data.due_soon} hint="on the autopilot now" />
        <Tile label="Overdue" value={data.overdue} tone={data.overdue ? 'warn' : ''} hint="still being reminded" />
        <Tile label="Booked" value={data.booked} tone="good" hint={`${data.self_booked} booked themselves from the link`} />
        <Tile label="Reactivated" value={data.reactivated} tone="good" hint="booked 90+ days after due" />
        {data.scheduled != null && <Tile label="$ scheduled" value={money(data.scheduled)} tone="good" hint="work on the visits they booked" />}
        <Tile label="Calls to make" value={data.open_calls} tone={data.open_calls ? 'warn' : ''} hint="the list above" />
        {data.failing > 0 && <Tile label="Needs attention" value={data.failing} tone="bad" hint={<Link to="/attention">messages that didn’t go</Link>} />}
      </div>
      <div className="rc-grid">
        <div className="card">
          <h3>What each step booked</h3>
          {!data.by_step.length && <div className="muted">Nobody has booked from a recall step in this period yet.</div>}
          {data.by_step.map((s) => {
            const Icon = CHANNEL_ICONS[s.channel] || CalendarCheck;
            return (
              <div className="rc-bar-row" key={s.label}>
                <span className="rc-bar-label"><Icon size={14} /> {s.label}</span>
                <span className="rc-bar"><i style={{ width: `${(s.booked / maxBooked) * 100}%` }} /></span>
                <span className="rc-bar-n">{s.booked}{s.scheduled != null && s.scheduled > 0 ? <small> · {money(s.scheduled)}</small> : null}</span>
              </div>
            );
          })}
        </div>
        <div className="card">
          <h3>How messages went</h3>
          {!data.channels.length && <div className="muted">Nothing sent in this period.</div>}
          <table className="rc-table">
            <tbody>
              {data.channels.map((c) => {
                const Icon = CHANNEL_ICONS[c.channel] || MessageSquare;
                return (
                  <tr key={c.channel || 'none'}>
                    <td><Icon size={14} /> {CHANNEL_NAMES[c.channel] || c.label}</td>
                    <td className="num">{c.sent + c.calls} sent</td>
                    <td className={`num ${c.failed ? 'bad' : 'muted'}`}>{c.failed} failed</td>
                    <td className="num muted">{c.skipped} skipped</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.stopped.length > 0 && (
            <>
              <h4>Stopped without booking</h4>
              <div className="rc-chips">{data.stopped.map((s) => <span key={s.reason} className="rc-chip">{s.label} · {s.n}</span>)}</div>
            </>
          )}
        </div>
        {data.by_office.length > 1 && (
          <div className="card rc-wide">
            <h3>By office</h3>
            <table className="rc-table">
              <thead><tr><th>Office</th><th className="num">Due soon</th><th className="num">Overdue</th><th className="num">Booked</th><th className="num">Reactivated</th>{data.scheduled != null && <th className="num">$ scheduled</th>}</tr></thead>
              <tbody>
                {data.by_office.map((o) => (
                  <tr key={o.location_id ?? 0}>
                    <td>{o.name}</td><td className="num">{o.due}</td><td className="num">{o.overdue}</td><td className="num">{o.booked}</td><td className="num">{o.reactivated}</td>
                    {data.scheduled != null && <td className="num">{money(o.scheduled)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Tile({ label, value, hint, tone = '' }) {
  return (
    <div className={`rc-tile ${tone}`}>
      <div className="rc-tile-label">{label}</div>
      <div className="rc-tile-value">{value}</div>
      {hint && <div className="rc-tile-hint">{hint}</div>}
    </div>
  );
}

// ---- The people to call ----
// J / K move between calls; 1–6 log the outcome of the highlighted one. Each outcome is one click and closes
// the call's task; "declined" ends the patient's recall reminders; the rest carry on to the next step.
const OUTCOME_KEYS = [['reached', 'Reached'], ['left_message', 'Left message'], ['call_back', 'Will call back'], ['booked', 'Booked'], ['declined', 'Declined'], ['wrong_number', 'Wrong number']];
function CallList({ canLog }) {
  const [mine, setMine] = useState(false);
  const { data, error, reload } = useApi(`/cadence/calls${mine ? '?mine=1' : ''}`);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(null);
  const [gone, setGone] = useState(() => new Set());
  const calls = (data?.calls || []).filter((c) => !gone.has(c.id));
  const current = calls[Math.min(at, calls.length - 1)];

  const log = async (c, outcome) => {
    if (!c || !canLog) return;
    setGone((g) => new Set(g).add(c.id));
    try {
      await api.post(`/cadence/runs/${c.id}/outcome`, { outcome });
      const name = OUTCOME_KEYS.find(([k]) => k === outcome)?.[1];
      toast(`${c.name}: ${name}. ${outcome === 'declined' ? 'Their recall reminders have stopped.' : outcome === 'booked' ? 'Their reminders have stopped.' : 'The next step follows on its own.'}`);
    } catch (e) {
      setGone((g) => { const n = new Set(g); n.delete(c.id); return n; });
      toast(e.message, { tone: 'error' });
      reload();
    }
  };
  useShortcuts([
    { combo: 'j', label: 'Next call', section: 'Recall', handler: () => setAt((i) => Math.min(i + 1, Math.max(calls.length - 1, 0))) },
    { combo: 'k', label: 'Previous call', section: 'Recall', handler: () => setAt((i) => Math.max(i - 1, 0)) },
    ...OUTCOME_KEYS.map(([k, name], i) => ({ combo: String(i + 1), label: `Call outcome: ${name}`, section: 'Recall', enabled: !!current && canLog, handler: () => log(current, k) })),
  ]);
  useEffect(() => { if (at > calls.length - 1) setAt(Math.max(calls.length - 1, 0)); }, [calls.length, at]);

  return (
    <section className="rc-section">
      <div className="rc-section-head">
        <h2><PhoneCall size={18} /> Calls to make {calls.length ? <span className="count">{calls.length}</span> : null}</h2>
        <label className="inline muted rc-mine"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Just mine</label>
      </div>
      <ErrorBox error={error} />
      {data && !calls.length && <div className="rc-empty"><CalendarCheck size={22} /> No calls to make. The autopilot is handling everyone else.</div>}
      {calls.length > 0 && (
        <div className="rc-calls" role="list">
          {calls.map((c, i) => (
            <div key={c.id} role="listitem" className={`rc-call ${current?.id === c.id ? 'current' : ''}`} onClick={() => setAt(i)}>
              <div className="rc-call-main">
                <div className="rc-call-who">
                  <Link to={`/patients/${c.patient_id}`} className="rc-call-name">{c.name}</Link>
                  {c.phone && <a className="rc-call-phone" href={`tel:${c.phone}`}>{c.phone}</a>}
                  <span className={`rc-overdue ${c.overdue_days > 0 ? 'late' : ''}`}>{c.overdue_days > 0 ? `${c.overdue_days} days overdue` : c.overdue_days === 0 ? 'due today' : `due in ${-c.overdue_days} days`}</span>
                  <span className="muted">{c.visit}{c.assigned_name ? ` · for ${c.assigned_name}` : ''}</span>
                </div>
                {c.history.length > 0 && (
                  <div className="rc-history">
                    {c.history.map((hst, j) => {
                      const Icon = CHANNEL_ICONS[hst.channel] || MessageSquare;
                      return <span key={j} className={`rc-chip ${hst.status}`} title={`${fmtDate(hst.due_date)} · ${hst.status}${hst.outcome ? ` · ${hst.outcome.replace(/_/g, ' ')}` : ''}`}><Icon size={12} /> {fmtDate(hst.due_date)}{hst.outcome ? ` · ${hst.outcome.replace(/_/g, ' ')}` : ''}</span>;
                    })}
                  </div>
                )}
                <button type="button" className="link rc-script-toggle" onClick={(e) => { e.stopPropagation(); setOpen(open === c.id ? null : c.id); }}>{open === c.id ? 'Hide script' : 'Script'}</button>
                {open === c.id && <p className="rc-script">{c.script}</p>}
              </div>
              {canLog && (
                <div className="rc-outcomes">
                  {OUTCOME_KEYS.map(([k, name], j) => (
                    <button key={k} type="button" className={`small ${k === 'declined' ? 'danger-ghost' : k === 'booked' || k === 'reached' ? 'good' : ''}`} onClick={(e) => { e.stopPropagation(); log(c, k); }} title={current?.id === c.id ? `Key ${j + 1}` : undefined}>
                      {current?.id === c.id && <kbd>{j + 1}</kbd>} {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Sequences: a timeline and the steps ----
const SAMPLE = { first_name: 'Jane', names: 'Jane', who: 'your', visit: 'checkup and cleaning', due: 'Tue, Oct 13', link: 'https://…/rb/…', family_note: '' };
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

function Sequences({ admin, settings }) {
  const { data, error, reload } = useApi('/cadence/sequences?type=recall');
  const [pick, setPick] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const seqs = data?.sequences || [];
  const seq = seqs.find((s) => s.id === pick) || seqs[0];
  useEffect(() => { if (seq) setDraft({ name: seq.name, active: !!seq.active, family_window_days: seq.family_window_days, steps: seq.steps.map((s) => ({ ...s })) }); }, [seq?.id, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = { ...SAMPLE, practice: 'your office', phone: 'our number' };
  const dirty = useMemo(() => seq && draft && JSON.stringify({ name: seq.name, active: !!seq.active, family_window_days: seq.family_window_days, steps: seq.steps }) !== JSON.stringify(draft), [seq, draft]);

  if (error) return <ErrorBox error={error} />;
  if (!data || !draft || !seq) return <div className="empty">Loading…</div>;
  const setStep = (i, patch) => setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.put(`/cadence/sequences/${seq.id}`, { ...draft, steps: draft.steps.map((s) => ({ id: s.id, offset_days: Number(s.offset_days), channel: s.channel, template: s.template, subject: s.subject, conditions: s.conditions, repeat_days: s.repeat_days || null, repeat_max: s.repeat_max || null })) });
      toast('Sequence saved. It applies from the next step each patient reaches.');
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    setSaving(true);
    try {
      await api.post(`/cadence/sequences/${seq.id}/reset`, {});
      toast('Back to the recommended steps.');
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rc-section">
      <div className="rc-seq-pills" role="tablist">
        {seqs.map((s) => (
          <button key={s.id} role="tab" aria-selected={s.id === seq.id} className={s.id === seq.id ? 'active' : ''} onClick={() => setPick(s.id)}>
            {s.name}{!s.active && <span className="muted"> · off</span>}
          </button>
        ))}
      </div>
      <div className="card rc-timeline-card">
        <Timeline steps={draft.steps} />
        <div className="muted rc-timeline-foot">
          Stops the moment they book (or already have a visit), decline, opt out, or are marked moved, deceased or not to contact. Texts, emails and AI calls wait for sending hours{settings ? ` (${settings.send_from}–${settings.send_until})` : ''}. A step that can’t reach them tries the next channel.
        </div>
      </div>
      <ErrorBox error={err} />
      <div className="rc-steps">
        {draft.steps.map((s, i) => {
          const Icon = CHANNEL_ICONS[s.channel] || MessageSquare;
          return (
            <div className="card rc-step" key={s.id || `new-${i}`}>
              <div className="rc-step-head">
                <span className={`rc-step-icon ${s.channel}`}><Icon size={16} /></span>
                <label className="rc-field">Day
                  <input type="number" value={s.offset_days} disabled={!admin} onChange={(e) => setStep(i, { offset_days: e.target.value })} aria-label="Days from the due date" />
                </label>
                <span className="muted rc-when">{dayLabel(Number(s.offset_days))}</span>
                <select value={s.channel} disabled={!admin} onChange={(e) => setStep(i, { channel: e.target.value })} aria-label="Channel">
                  {Object.entries(CHANNEL_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {s.channel === 'task_call' && (
                  <select value={s.conditions?.assign_to || ''} disabled={!admin} onChange={(e) => setStep(i, { conditions: { ...(s.conditions || {}), assign_to: e.target.value ? Number(e.target.value) : undefined } })} aria-label="Who calls">
                    <option value="">Anyone on the team</option>
                    {(data.team || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
                <label className="rc-field rc-repeat" title="Keep repeating this step (for example a quarterly “we miss you”)"><Repeat size={14} />
                  <input type="number" placeholder="—" value={s.repeat_days ?? ''} disabled={!admin} onChange={(e) => setStep(i, { repeat_days: e.target.value === '' ? null : Number(e.target.value), repeat_max: s.repeat_max || 4 })} aria-label="Repeat every N days" />
                  <span className="muted">days</span>
                  {s.repeat_days ? <><span className="muted">×</span><input type="number" value={s.repeat_max ?? 4} disabled={!admin} onChange={(e) => setStep(i, { repeat_max: Number(e.target.value) })} aria-label="Times" /></> : null}
                </label>
                {admin && <button type="button" className="icon-button" title="Remove step" onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}><Trash2 size={15} /></button>}
              </div>
              {['email', 'letter', 'postcard'].includes(s.channel) && (
                <input className="rc-subject" value={s.subject || ''} disabled={!admin} placeholder="Subject / heading" onChange={(e) => setStep(i, { subject: e.target.value })} />
              )}
              <textarea rows={2} value={s.template} disabled={!admin} onChange={(e) => setStep(i, { template: e.target.value })} aria-label={s.channel.includes('call') ? 'Call script' : 'Message'} />
              <div className="rc-preview"><span className="muted">{s.channel.includes('call') ? 'Script:' : 'Jane sees:'}</span> {fill(s.template, vars)}</div>
            </div>
          );
        })}
      </div>
      {admin && (
        <div className="rc-editor-bar">
          <button type="button" onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { offset_days: (Math.max(...d.steps.map((x) => Number(x.offset_days)), 0) || 0) + 30, channel: 'text', template: 'Hi {first_name}, {who} {visit} at {practice} is overdue. Book in two taps: {link}', conditions: {} }] }))}><Plus size={15} /> Add step</button>
          <label className="inline muted"><Users size={15} /> Family members due within <input type="number" className="rc-small-input" value={draft.family_window_days} onChange={(e) => setDraft((d) => ({ ...d, family_window_days: Number(e.target.value) }))} /> days get one message</label>
          <label className="inline muted"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} /> This sequence is on</label>
          <span className="rc-spacer" />
          <button type="button" disabled={saving} onClick={reset} title="Replace these steps with the recommended ones"><RotateCcw size={15} /> Recommended</button>
          <button type="button" className="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
      {!admin && <div className="muted">Only administrators can change the sequences.</div>}
      <p className="muted rc-vars">Words that fill in: {'{first_name}'} {'{who}'} (“your” or “Jane and Mia’s”) {'{visit}'} {'{due}'} {'{link}'} (their booking page) {'{practice}'} {'{phone}'} {'{family_note}'}.</p>
    </section>
  );
}

// The sequence as a line through time: the due date in the middle, each step a dot where it falls, repeats as
// fainter dots. Works for any cadence (offsets relative to an anchor).
export function Timeline({ steps, anchorLabel = 'Due' }) {
  const points = [];
  for (const s of steps) {
    const d = Number(s.offset_days);
    if (!Number.isFinite(d)) continue;
    points.push({ d, s, ghost: false });
    if (Number(s.repeat_days) > 0) for (let k = 1; k <= Math.min(Number(s.repeat_max) || 4, 3); k++) points.push({ d: d + k * Number(s.repeat_days), s, ghost: true });
  }
  if (!points.length) return <div className="muted">No steps yet.</div>;
  const min = Math.min(0, ...points.map((p) => p.d));
  const max = Math.max(0, ...points.map((p) => p.d));
  const span = Math.max(max - min, 1);
  const x = (d) => `${4 + ((d - min) / span) * 92}%`;
  return (
    <div className="rc-timeline" aria-label="Sequence timeline">
      <div className="rc-line" />
      <div className="rc-anchor" style={{ left: x(0) }}><span>{anchorLabel}</span></div>
      {points.map((p, i) => {
        const Icon = CHANNEL_ICONS[p.s.channel] || MessageSquare;
        return (
          <div key={i} className={`rc-point ${p.s.channel} ${p.ghost ? 'ghost' : ''} ${i % 2 ? 'low' : ''}`} style={{ left: x(p.d) }} title={`${dayLabel(p.d)} · ${CHANNEL_NAMES[p.s.channel]}${p.ghost ? ' (repeat)' : ''}`}>
            <span className="rc-point-dot"><Icon size={13} /></span>
            <span className="rc-point-label">{shortDay(p.d)}</span>
          </div>
        );
      })}
      {points.some((p) => p.ghost) && <div className="rc-timeline-more" title="Repeats until they book or the repeats run out"><Repeat size={12} /> repeats</div>}
    </div>
  );
}

