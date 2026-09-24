import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Send, PhoneCall, FileSignature, LayoutGrid, Repeat, Settings2, Sparkles, Circle, ArrowUpRight, Eraser, X, FileDown, Play, CheckCheck, Mail, Printer } from 'lucide-react';
import { api, getToken, getLocationId, openFile } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast } from '../toast.js';
import { money, fmtDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { Sequences } from './Recall.jsx';
import './recall.css';
import './txfollow.css';

// Treatment follow-up (TF1–TF4, docs/workflows/specs/TF-treatment-followup.md), at /recall?type=treatment.
// The cadence runs on its own. This screen shows only what needs a person: the doctor's letters to approve (one
// click each, or a batch), the calls to make with one-key outcomes, and the results. Administrators switch it on,
// shape each urgency's sequence, and set up the letterhead; each doctor adds their own signature.

const URGENCY = { urgent: 'Urgent', soon: 'Soon', elective: 'Elective' };
const TABS = [['letters', 'Letters to approve', FileSignature], ['calls', 'Calls', PhoneCall], ['board', 'Board', LayoutGrid], ['sequences', 'Sequences', Repeat], ['setup', 'Letter setup', Settings2]];

export default function TreatmentFollowup() {
  const { user, can } = useAuth();
  const admin = user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'letters';
  const go = (t) => setParams({ type: 'treatment', tab: t });
  const settings = useApi('/txfollow/settings');
  const [busy, setBusy] = useState(false);
  const on = !!settings.data?.enabled;

  const toggle = async () => {
    setBusy(true);
    try {
      await api.put('/txfollow/settings', { enabled: !on });
      toast(!on ? 'Treatment follow-up is on — patients with unscheduled treatment are picked up on the next pass.' : 'Treatment follow-up is off. Nothing more will be sent.');
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
      toast(`Done: ${s.sent} sent, ${s.tasks} call${s.tasks === 1 ? '' : 's'} for the team, ${s.stopped} stopped (booked or not needed).`);
      window.dispatchEvent(new Event('dm:refresh'));
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  useCommands([
    { id: 'txf-letters', label: 'Treatment follow-up: letters to approve', hint: 'Treatment', run: () => go('letters') },
    { id: 'txf-calls', label: 'Treatment follow-up: calls to make', hint: 'Treatment', run: () => go('calls') },
    { id: 'txf-board', label: 'Treatment follow-up: board', hint: 'Treatment', run: () => go('board') },
  ]);

  return (
    <div className="rc-page txf-page">
      <div className="page-header">
        <div>
          <h1>Treatment follow-up</h1>
          <div className="muted">Texts, emails, calls and a letter from the doctor go out on their own until the treatment is booked. You only see the letters to approve, the calls to make and the results.</div>
        </div>
        <div className="inline rc-head-actions">
          {settings.data && <span className={`rc-state ${on ? 'on' : ''}`}><span className="rc-dot" />{on ? 'Running' : 'Off'}</span>}
          {admin && settings.data && <button className={on ? '' : 'primary'} disabled={busy} onClick={toggle}>{on ? 'Turn off' : 'Turn on'}</button>}
          {admin && on && <button disabled={busy} onClick={runNow} title="Run the follow-up pass now instead of waiting a few minutes"><Play size={15} /> Run now</button>}
          <Link to="/recall" className="button">Recall →</Link>
        </div>
      </div>
      {settings.data && !on && <div className="rc-note">Treatment follow-up is off.{admin ? ` Turning it on picks up plans diagnosed since ${fmtDate(settings.data.from_date || settings.data.default_from)}.` : ' An administrator can turn it on here.'}</div>}
      <div className="tabs" role="tablist">
        {TABS.map(([k, label, Icon]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => go(k)}><Icon size={14} /> {label}</button>)}
      </div>
      {tab === 'letters' && <Letters canSign={can('clinical:sign')} canEdit={can('clinical:write')} />}
      {tab === 'calls' && <Calls canLog={can('schedule:write')} />}
      {tab === 'board' && <Board canEdit={can('clinical:write')} />}
      {tab === 'sequences' && <Sequences admin={admin} settings={settings.data} type="treatment" anchorLabel="Diagnosed" />}
      {tab === 'setup' && <LetterSetup admin={admin} />}
    </div>
  );
}

// ---- Letters to approve ----
// J / K move, A approves the highlighted letter, Enter opens it, X ticks it for a batch.
function Letters({ canSign, canEdit }) {
  const { data, error, reload } = useApi('/txfollow/letters');
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const [gone, setGone] = useState(() => new Set());
  const letters = (data?.letters || []).filter((l) => !gone.has(l.id));
  const current = letters[Math.min(at, letters.length - 1)];
  useEffect(() => { if (at > letters.length - 1) setAt(Math.max(letters.length - 1, 0)); }, [letters.length, at]);

  const approve = useCallback(async (l) => {
    if (!l?.can_approve) return;
    setGone((g) => new Set(g).add(l.id));
    try {
      const out = await api.post(`/txfollow/letters/${l.id}/approve`, {});
      if (out.cancelled) toast(`${l.patient_name}: not sent — ${out.reason}.`);
      else if (out.letter.status === 'sent') toast(`${l.patient_name}: letter sent${out.letter.email_status === 'sent' ? ' by email' : ''}${out.letter.mail_status === 'sent' ? ' and mailed' : out.letter.mail_status === 'print' ? ' (a task to print and mail it)' : ''}. Filed on the chart.`);
      else toast(`${l.patient_name}: ${out.letter.error || 'it didn’t go'} — it’s in Needs attention.`, { tone: 'error' });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      reload();
      setGone(new Set());
    }
  }, [reload]);
  const approveMany = async () => {
    const ids = [...picked];
    if (!ids.length) return;
    try {
      const out = await api.post('/txfollow/letters/approve', { ids });
      const skipped = out.results.filter((r) => r.cancelled).length;
      const bad = out.results.filter((r) => r.status === 'error' || r.status === 'failed').length;
      toast(`${out.sent} letter${out.sent === 1 ? '' : 's'} sent${skipped ? `, ${skipped} not needed any more` : ''}${bad ? `, ${bad} didn’t go (see Needs attention)` : ''}.`, { tone: bad ? 'error' : 'ok' });
      setPicked(new Set());
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  useShortcuts([
    { combo: 'j', label: 'Next letter', section: 'Treatment follow-up', handler: () => setAt((i) => Math.min(i + 1, Math.max(letters.length - 1, 0))) },
    { combo: 'k', label: 'Previous letter', section: 'Treatment follow-up', handler: () => setAt((i) => Math.max(i - 1, 0)) },
    { combo: 'a', label: 'Approve and send the letter', section: 'Treatment follow-up', enabled: !!current?.can_approve && !open, handler: () => approve(current) },
    { combo: 'x', label: 'Tick the letter for a batch', section: 'Treatment follow-up', enabled: !!current && !open, handler: () => toggle(current.id) },
    { combo: 'Enter', label: 'Open the letter', section: 'Treatment follow-up', enabled: !!current && !open, handler: () => setOpen(current.id) },
  ]);
  const mine = letters.filter((l) => l.can_approve);

  return (
    <section className="rc-section">
      <div className="rc-section-head">
        <h2><FileSignature size={18} /> Letters to approve {letters.length ? <span className="count">{letters.length}</span> : null}</h2>
        {canSign && mine.length > 1 && (
          <div className="inline">
            <button type="button" onClick={() => setPicked(picked.size === mine.length ? new Set() : new Set(mine.map((l) => l.id)))}>{picked.size === mine.length ? 'Untick all' : 'Tick all mine'}</button>
            <button type="button" className="primary" disabled={!picked.size} onClick={approveMany}><CheckCheck size={15} /> Approve and send {picked.size || ''}</button>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {data && !letters.length && <div className="rc-empty"><FileSignature size={22} /> No letters waiting. When a patient reaches the letter step, a draft appears here for the doctor.</div>}
      {letters.length > 0 && (
        <div className="txf-letters" role="list">
          {letters.map((l, i) => (
            <div key={l.id} role="listitem" className={`txf-letter ${current?.id === l.id ? 'current' : ''} ${l.status}`} onClick={() => setAt(i)}>
              {canSign && l.can_approve && <input type="checkbox" aria-label={`Tick ${l.patient_name}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} onClick={(e) => e.stopPropagation()} />}
              <div className="txf-letter-main">
                <div className="txf-letter-who">
                  <Link to={`/patients/${l.patient_id}`} className="txf-name" onClick={(e) => e.stopPropagation()}>{l.patient_name}</Link>
                  <span className="muted">{l.treatment}{l.cost != null ? ` · ${money(l.cost)} for them` : ''}</span>
                  {l.ai_drafted && <span className="badge info" title="The wording was drafted by AI — read it before approving"><Sparkles size={11} /> AI-drafted</span>}
                  {l.status === 'failed' && <span className="badge danger">Didn’t go</span>}
                </div>
                <div className="muted txf-letter-sub">
                  From {l.doctor || 'the doctor'} · drafted {fmtDate(l.created_at)} {l.source === 'human' ? 'by the office' : 'by the follow-up'} ·
                  {' '}{l.send_email ? <><Mail size={12} /> email</> : null}{l.send_email && l.send_mail ? ' + ' : ''}{l.send_mail ? <><Printer size={12} /> paper</> : null}
                  {!l.has_image && ' · no picture'}{l.error ? ` · ${l.error}` : ''}
                </div>
              </div>
              <div className="txf-letter-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(l.id); }}>{canEdit ? 'Review' : 'Read'}</button>
                {l.can_approve && (
                  <button type="button" className="primary txf-approve" onClick={(e) => { e.stopPropagation(); approve(l); }} title={current?.id === l.id ? 'Key A' : undefined}>
                    <Send size={14} /> {l.status === 'failed' ? 'Send again' : 'Approve & send'}
                  </button>
                )}
                {!l.can_approve && canSign && <span className="muted txf-for">for {l.doctor}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <LetterPanel id={open} canEdit={canEdit} onClose={() => { setOpen(null); reload(); }} onApprove={(l) => { setOpen(null); approve(l); }} />}
    </section>
  );
}

// ---- One letter: the preview as the patient sees it, the words, the picture and its marks ----
function LetterPanel({ id, canEdit, onClose, onApprove }) {
  const { data, error, reload } = useApi(`/txfollow/letters/${id}`);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  useEffect(() => { if (data) setForm({ diagnosis: data.letter.diagnosis || '', treatment: data.letter.treatment || '', why: data.letter.why || '', risk: data.letter.risk || '' }); }, [data]);
  useShortcuts([{ combo: 'Escape', label: 'Close the letter', section: 'Treatment follow-up', inInputs: true, handler: onClose }]);
  const editable = canEdit && data && ['draft', 'failed'].includes(data.letter.status);

  const save = async (patch) => {
    setSaving(true);
    setErr(null);
    try {
      await api.put(`/txfollow/letters/${id}`, patch);
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  const saveText = (k) => { if (data && form[k] !== (data.letter[k] || '')) save({ [k]: form[k] }); };
  const aiDraft = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.post(`/txfollow/letters/${id}/ai-draft`, {});
      toast('The AI drafted new wording. Read it, change anything you like, then approve.');
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  const cancel = async () => {
    try {
      await api.post(`/txfollow/letters/${id}/cancel`, { reason: cancelling });
      toast('The letter won’t be sent.');
      onClose();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <aside className="drawer txf-drawer" aria-label="Doctor’s letter">
      <div className="drawer-head">
        <div>
          <strong>{data ? `Letter to ${data.letter.patient_name}` : 'Letter'}</strong>
          {data && <div className="muted">{data.letter.status_label}{data.letter.ai_drafted ? ' · wording drafted by AI' : ''}</div>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
      </div>
      <div className="drawer-body txf-drawer-body">
        <ErrorBox error={error || err} />
        {data && form && (
          <>
            {data.warnings.length > 0 && <ul className="txf-warnings">{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {data.letter.ai_drafted && data.letter.ai_reason && <div className="txf-ai-note"><Sparkles size={13} /> AI draft: {data.letter.ai_reason} Nothing is sent until you approve.</div>}
            <div className="txf-panel-grid">
              <div className="txf-fields">
                <label>What I found<textarea rows={2} value={form.diagnosis} disabled={!editable} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} onBlur={() => saveText('diagnosis')} /></label>
                <label>What I recommend<textarea rows={2} value={form.treatment} disabled={!editable} onChange={(e) => setForm({ ...form, treatment: e.target.value })} onBlur={() => saveText('treatment')} /></label>
                <label>Why it matters<textarea rows={3} value={form.why} disabled={!editable} onChange={(e) => setForm({ ...form, why: e.target.value })} onBlur={() => saveText('why')} /></label>
                <label>If it waits<textarea rows={3} value={form.risk} disabled={!editable} onChange={(e) => setForm({ ...form, risk: e.target.value })} onBlur={() => saveText('risk')} /></label>
                <div className="txf-row">
                  <label className="inline"><input type="checkbox" checked={data.letter.send_email} disabled={!editable} onChange={(e) => save({ send_email: e.target.checked })} /> Email (with the PDF)</label>
                  <label className="inline"><input type="checkbox" checked={data.letter.send_mail} disabled={!editable} onChange={(e) => save({ send_mail: e.target.checked })} /> Paper copy by mail</label>
                </div>
                <label>Signed by
                  <select value={data.letter.provider_id || ''} disabled={!editable} onChange={(e) => save({ provider_id: Number(e.target.value) })}>
                    <option value="" disabled>Choose the doctor</option>
                    {data.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.has_signature ? '' : ' (no signature yet)'}</option>)}
                  </select>
                </label>
                <label>Picture
                  <select value={data.letter.document_id || ''} disabled={!editable} onChange={(e) => save({ document_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">No picture</option>
                    {data.images.map((d) => <option key={d.id} value={d.id}>{d.category === 'photo' ? 'Photo' : 'X-ray'}{d.tooth ? ` #${d.tooth}` : ''} · {fmtDate(d.taken_at || d.created_at)} · {d.filename}</option>)}
                  </select>
                </label>
                {data.letter.document_id && data.image && (
                  <MarkupEditor documentId={data.letter.document_id} size={data.image} marks={data.effective_markup} disabled={!editable} onSave={(markup) => save({ markup })} />
                )}
              </div>
              <div className="txf-preview">
                <iframe title="Letter preview" sandbox="" srcDoc={data.html} />
              </div>
            </div>
            <div className="drawer-actions txf-actions">
              {editable && data.letter.status === 'draft' && <button type="button" disabled={saving} onClick={aiDraft} title="Let the AI suggest plain wording (labelled; you still approve)"><Sparkles size={14} /> Draft wording with AI</button>}
              <button type="button" onClick={() => openFile(`/txfollow/letters/${id}/pdf`).catch((e) => toast(e.message, { tone: 'error' }))}><FileDown size={14} /> PDF</button>
              {editable && (cancelling == null
                ? <button type="button" className="danger-ghost" onClick={() => setCancelling('')}>Not needed</button>
                : <span className="inline"><input autoFocus placeholder="Why not? (e.g. discussed in person)" value={cancelling} onChange={(e) => setCancelling(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && cancelling.trim()) cancel(); }} /><button type="button" disabled={!cancelling.trim()} onClick={cancel}>Don’t send</button></span>)}
              <span className="rc-spacer" />
              {data.letter.can_approve && <button type="button" className="primary" disabled={saving} onClick={() => onApprove(data.letter)}><Send size={14} /> {data.letter.status === 'failed' ? 'Send again' : 'Approve & send'}</button>}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

// A picture and its marks. Drag to draw a circle (from the centre out) or an arrow (tail to tip). The marks are
// in the picture's own pixels, like the imaging viewer's, so they land in the same place in the letter.
function MarkupEditor({ documentId, size, marks, disabled, onSave }) {
  const [url, setUrl] = useState(null);
  const [tool, setTool] = useState('circle');
  const [list, setList] = useState(marks || []);
  const [draft, setDraft] = useState(null);
  const svg = useRef(null);
  useEffect(() => setList(marks || []), [marks]);
  useEffect(() => {
    let alive = true;
    let obj = null;
    fetch(`/api/documents/${documentId}/image`, { headers: { Authorization: `Bearer ${getToken()}`, ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => { if (alive && b) { obj = URL.createObjectURL(b); setUrl(obj); } }).catch(() => setUrl(null));
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [documentId]);
  const point = (e) => {
    const p = svg.current.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(svg.current.getScreenCTM().inverse());
    return [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10];
  };
  const down = (e) => { if (!disabled) { e.currentTarget.setPointerCapture?.(e.pointerId); const p = point(e); setDraft({ type: tool, points: [p, p] }); } };
  const move = (e) => { if (draft) setDraft({ ...draft, points: [draft.points[0], point(e)] }); };
  const up = () => {
    if (!draft) return;
    const [a, b] = draft.points;
    setDraft(null);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < Math.max(size.width, size.height) / 100) return;
    const next = [...list, draft];
    setList(next);
    onSave(next);
  };
  const sw = Math.max(2, Math.round(Math.max(size.width, size.height) / 160));
  const draw = (a, i) => {
    const [p0, p1] = a.points;
    const c = a.color || '#dc2626';
    if (a.type === 'circle') return <circle key={i} cx={p0[0]} cy={p0[1]} r={Math.hypot(p1[0] - p0[0], p1[1] - p0[1])} fill="none" stroke={c} strokeWidth={sw} />;
    if (a.type === 'arrow' || a.type === 'line') {
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const head = [-0.45, 0.45].map((d) => `${p1[0] - sw * 6 * Math.cos(ang + d)},${p1[1] - sw * 6 * Math.sin(ang + d)}`).join(' ');
      return <g key={i}><line x1={p0[0]} y1={p0[1]} x2={p1[0]} y2={p1[1]} stroke={c} strokeWidth={sw} strokeLinecap="round" />{a.type === 'arrow' && <polygon points={`${p1[0]},${p1[1]} ${head}`} fill={c} />}</g>;
    }
    if (a.type === 'polyline') return <polyline key={i} points={a.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={c} strokeWidth={sw} />;
    return <text key={i} x={p0[0]} y={p0[1]} fill={c} fontSize={sw * 7} fontWeight="700">{a.text}</text>;
  };
  return (
    <div className="txf-markup">
      {!disabled && (
        <div className="inline txf-tools" role="toolbar" aria-label="Mark the picture">
          <button type="button" className={tool === 'circle' ? 'active' : ''} onClick={() => setTool('circle')} title="Circle: drag from the centre out"><Circle size={14} /> Circle</button>
          <button type="button" className={tool === 'arrow' ? 'active' : ''} onClick={() => setTool('arrow')} title="Arrow: drag from the tail to the tip"><ArrowUpRight size={14} /> Arrow</button>
          <button type="button" disabled={!list.length} onClick={() => { setList([]); onSave([]); }} title="Remove all marks"><Eraser size={14} /> Clear</button>
          <span className="muted">Drag on the picture to mark the area of concern.</span>
        </div>
      )}
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} className="txf-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} role="img" aria-label="Picture with marks">
        {url ? <image href={url} width={size.width} height={size.height} /> : <rect width={size.width} height={size.height} fill="#111" />}
        {list.map(draw)}
        {draft && draw(draft, 'draft')}
      </svg>
    </div>
  );
}

// ---- Calls to make (1–6 log the outcome of the highlighted call) ----
const OUTCOME_KEYS = [['reached', 'Reached'], ['left_message', 'Left message'], ['call_back', 'Will call back'], ['booked', 'Booked'], ['declined', 'Declined'], ['wrong_number', 'Wrong number']];
function Calls({ canLog }) {
  const [mine, setMine] = useState(false);
  const { data, error, reload } = useApi(`/txfollow/calls${mine ? '?mine=1' : ''}`);
  const [at, setAt] = useState(0);
  const [gone, setGone] = useState(() => new Set());
  const calls = (data?.calls || []).filter((c) => !gone.has(c.id));
  const current = calls[Math.min(at, calls.length - 1)];
  const log = async (c, outcome) => {
    if (!c || !canLog) return;
    setGone((g) => new Set(g).add(c.id));
    try {
      await api.post(`/cadence/runs/${c.id}/outcome`, { outcome });
      toast(`${c.name}: ${OUTCOME_KEYS.find(([k]) => k === outcome)?.[1]}. ${outcome === 'declined' || outcome === 'booked' ? 'Their follow-up has stopped.' : 'The next step follows on its own.'}`);
    } catch (e) {
      setGone((g) => { const n = new Set(g); n.delete(c.id); return n; });
      toast(e.message, { tone: 'error' });
      reload();
    }
  };
  useShortcuts([
    { combo: 'j', label: 'Next call', section: 'Treatment follow-up', handler: () => setAt((i) => Math.min(i + 1, Math.max(calls.length - 1, 0))) },
    { combo: 'k', label: 'Previous call', section: 'Treatment follow-up', handler: () => setAt((i) => Math.max(i - 1, 0)) },
    ...OUTCOME_KEYS.map(([k, name], i) => ({ combo: String(i + 1), label: `Call outcome: ${name}`, section: 'Treatment follow-up', enabled: !!current && canLog, handler: () => log(current, k) })),
  ]);
  return (
    <section className="rc-section">
      <div className="rc-section-head">
        <h2><PhoneCall size={18} /> Calls to make {calls.length ? <span className="count">{calls.length}</span> : null}</h2>
        <label className="inline muted rc-mine"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Just mine</label>
      </div>
      <ErrorBox error={error} />
      {data && !calls.length && <div className="rc-empty"><PhoneCall size={22} /> No calls to make. The follow-up is handling everyone else.</div>}
      <div className="rc-calls" role="list">
        {calls.map((c, i) => (
          <div key={c.id} role="listitem" className={`rc-call ${current?.id === c.id ? 'current' : ''}`} onClick={() => setAt(i)}>
            <div className="rc-call-main">
              <div className="rc-call-who">
                <Link to={`/patients/${c.patient_id}`} className="rc-call-name">{c.name}</Link>
                {c.phone && <a className="rc-call-phone" href={`tel:${c.phone}`}>{c.phone}</a>}
                <span className={`badge ${c.urgency === 'urgent' ? 'danger' : c.urgency === 'soon' ? 'warn' : ''}`}>{URGENCY[c.urgency]}</span>
                <span className="muted">{c.treatment}{c.cost != null ? ` · ${money(c.cost)} for them` : ''} · diagnosed {c.days} days ago{c.assigned_name ? ` · for ${c.assigned_name}` : ''}</span>
              </div>
              <p className="rc-script">{c.script}</p>
            </div>
            {canLog && (
              <div className="rc-outcomes">
                {OUTCOME_KEYS.map(([k, name], j) => (
                  <button key={k} type="button" className={`small ${k === 'declined' ? 'danger-ghost' : k === 'booked' || k === 'reached' ? 'good' : ''}`} onClick={(e) => { e.stopPropagation(); log(c, k); }}>
                    {current?.id === c.id && <kbd>{j + 1}</kbd>} {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- The board (TF4): where everyone is, what each step produced, who reached the end ----
function Board({ canEdit }) {
  const [days, setDays] = useState(90);
  const { data, error, reload } = useApi(`/txfollow/board?days=${days}`);
  const [stage, setStage] = useState('');
  const rows = useMemo(() => (data?.patients || []).filter((p) => !stage || p.stage_key === stage), [data, stage]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const t = data.totals;
  const maxStage = Math.max(1, ...data.stages.map((s) => s.count));
  const maxBooked = Math.max(1, ...data.by_step.map((s) => s.booked));
  const setUrgency = async (planId, urgency) => {
    try {
      await api.put(`/txfollow/plans/${planId}/urgency`, { urgency: urgency || null });
      toast('Urgency saved — they move to that sequence on the next pass.');
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  return (
    <section className="rc-section">
      <div className="rc-section-head">
        <h2>Results</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
        </select>
      </div>
      <div className="rc-tiles">
        <Tile label="Being followed up" value={t.active} hint={t.open_amount != null ? `${money(t.open_amount)} of treatment` : null} />
        <Tile label="Booked" value={t.booked} tone="good" hint={t.booking_rate != null ? `${t.booking_rate}% of those who finished` : null} />
        {t.scheduled != null && <Tile label="$ scheduled" value={money(t.scheduled)} tone="good" hint="work on the visits they booked" />}
        <Tile label="Letters to approve" value={data.letters.waiting} tone={data.letters.waiting ? 'warn' : ''} hint={`${data.letters.sent} sent · ${data.letters.booked_after} booked after`} />
        <Tile label="Calls to make" value={data.open_calls} tone={data.open_calls ? 'warn' : ''} />
        <Tile label="End of cadence" value={t.completed_no_booking} tone={t.completed_no_booking ? 'bad' : ''} hint="finished every step, still not booked" />
      </div>
      <div className="rc-grid">
        <div className="card">
          <h3>Where everyone is</h3>
          {!data.stages.length && <div className="muted">Nobody is being followed up right now.</div>}
          {data.stages.map((s) => (
            <button type="button" key={s.key} className={`rc-bar-row txf-stage ${stage === s.key ? 'active' : ''}`} onClick={() => setStage(stage === s.key ? '' : s.key)}>
              <span className="rc-bar-label">{s.label}</span>
              <span className="rc-bar"><i style={{ width: `${(s.count / maxStage) * 100}%` }} /></span>
              <span className="rc-bar-n">{s.count}{s.amount != null && s.amount > 0 ? <small> · {money(s.amount)}</small> : null}</span>
            </button>
          ))}
        </div>
        <div className="card">
          <h3>What each step booked</h3>
          {!data.by_step.length && <div className="muted">Nobody has booked from a step in this period yet.</div>}
          {data.by_step.map((s) => (
            <div className="rc-bar-row" key={s.key}>
              <span className="rc-bar-label">{s.label}</span>
              <span className="rc-bar"><i style={{ width: `${(s.booked / maxBooked) * 100}%` }} /></span>
              <span className="rc-bar-n">{s.booked}{s.scheduled != null && s.scheduled > 0 ? <small> · {money(s.scheduled)}</small> : null}</span>
            </div>
          ))}
          <h4>By urgency</h4>
          <div className="rc-chips">{data.by_urgency.map((u) => <span key={u.urgency} className="rc-chip">{u.label}: {u.active} active · {u.booked} booked</span>)}</div>
        </div>
        <div className="card rc-wide">
          <h3>Patients {stage ? <button type="button" className="link" onClick={() => setStage('')}>show everyone</button> : null}</h3>
          <table className="rc-table txf-table">
            <thead><tr><th>Patient</th><th>Urgency</th><th>Treatment</th><th className="num">Amount</th><th>Diagnosed</th><th>Last step</th><th>Next</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.enrollment_id}>
                  <td><Link to={`/patients/${p.patient_id}`}>{p.name}</Link>{p.letter_waiting ? <span className="badge warn">letter to approve</span> : null}</td>
                  <td>
                    {canEdit ? (
                      <select value={p.urgency} onChange={(e) => setUrgency(p.treatment_plan_id, e.target.value)} aria-label={`Urgency for ${p.name}`}>
                        {Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    ) : URGENCY[p.urgency]}
                  </td>
                  <td>{p.treatment}</td>
                  <td className="num">{p.amount != null ? money(p.amount) : ''}</td>
                  <td>{fmtDate(p.diagnosed)} <span className="muted">({p.days}d)</span></td>
                  <td>{p.stage}</td>
                  <td>{p.next ? `${fmtDate(p.next.date)} · ${p.next.label.replace(/^Day \d+ · /, '')}` : '—'}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="muted">No one here.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card rc-wide">
          <h3>Reached the end without booking</h3>
          {!data.end_of_cadence.length && <div className="muted">Nobody in this period.</div>}
          {data.end_of_cadence.length > 0 && (
            <table className="rc-table">
              <thead><tr><th>Patient</th><th>Treatment</th><th className="num">Amount</th><th>Diagnosed</th><th>Finished</th></tr></thead>
              <tbody>{data.end_of_cadence.map((p) => <tr key={p.enrollment_id}><td><Link to={`/patients/${p.patient_id}`}>{p.name}</Link></td><td>{p.treatment}</td><td className="num">{p.amount != null ? money(p.amount) : ''}</td><td>{fmtDate(p.diagnosed)}</td><td>{fmtDate(p.ended)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
function Tile({ label, value, hint, tone = '' }) {
  return <div className={`rc-tile ${tone}`}><div className="rc-tile-label">{label}</div><div className="rc-tile-value">{value}</div>{hint && <div className="rc-tile-hint">{hint}</div>}</div>;
}

// ---- Letterhead and signatures ----
const readFile = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
function LetterSetup({ admin }) {
  const { data, error, reload } = useApi('/txfollow/letter-setup');
  const [color, setColor] = useState('');
  useEffect(() => { if (data) setColor(data.brand_color || data.fallback_color); }, [data]);
  const put = async (path, body, done) => {
    try {
      await api.put(path, body);
      toast(done);
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  const upload = (path, key, done) => async (e) => {
    const f = e.target.files?.[0];
    if (f) put(path, { [key]: await readFile(f) }, done);
    e.target.value = '';
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <section className="rc-section txf-setup">
      <div className="card">
        <h3>Letterhead</h3>
        <p className="muted">The doctor’s letter uses your logo and color. Unset, it uses the ones from Online scheduling.</p>
        <div className="txf-row">
          <label className="inline">Color <input type="color" value={color} disabled={!admin} onChange={(e) => setColor(e.target.value)} onBlur={() => admin && color !== (data.brand_color || data.fallback_color) && put('/txfollow/letter-setup', { brand_color: color }, 'Letterhead color saved.')} /></label>
          <label className="inline">Logo {data.has_logo ? '(on file)' : data.fallback_logo ? '(from Online scheduling)' : '(none)'} <input type="file" accept="image/png,image/jpeg" disabled={!admin} onChange={upload('/txfollow/letter-setup', 'logo', 'Logo saved.')} /></label>
        </div>
        {!admin && <div className="muted">Only administrators can change the letterhead.</div>}
      </div>
      <div className="card">
        <h3>Doctors’ signatures</h3>
        <p className="muted">Each letter goes out with the doctor’s name, credentials and signature. A doctor sets their own (or an administrator does). Sign on white paper, photograph or scan it, and upload it as a PNG or JPEG.</p>
        {data.doctors.map((d) => <DoctorRow key={d.id} d={d} canEdit={admin || d.is_me} put={put} upload={upload} />)}
      </div>
    </section>
  );
}
function DoctorRow({ d, canEdit, put, upload }) {
  const [f, setF] = useState({ credentials: d.credentials, title: d.title, closing: d.closing });
  const blur = (k) => () => { if (f[k] !== d[k]) put(`/txfollow/doctors/${d.id}`, { [k]: f[k] }, `${d.name}: saved.`); };
  return (
    <div className="txf-doctor">
      <strong>{d.name}</strong>
      <input placeholder="Credentials (DDS)" value={f.credentials} disabled={!canEdit} onChange={(e) => setF({ ...f, credentials: e.target.value })} onBlur={blur('credentials')} />
      <input placeholder="Line under the name (General dentist)" value={f.title} disabled={!canEdit} onChange={(e) => setF({ ...f, title: e.target.value })} onBlur={blur('title')} />
      <input placeholder="Closing (Warm regards,)" value={f.closing} disabled={!canEdit} onChange={(e) => setF({ ...f, closing: e.target.value })} onBlur={blur('closing')} />
      <label className="inline">{d.has_signature ? <span className="badge ok">signature on file</span> : <span className="badge warn">no signature</span>}
        {canEdit && <input type="file" accept="image/png,image/jpeg" aria-label={`Signature for ${d.name}`} onChange={upload(`/txfollow/doctors/${d.id}`, 'signature', `${d.name}: signature saved.`)} />}
      </label>
    </div>
  );
}
