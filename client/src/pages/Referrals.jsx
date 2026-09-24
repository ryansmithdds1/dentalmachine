import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileCheck2, Mail, Printer, Settings as Gear } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useLiveEvents } from '../live.js';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast, undoable } from '../toast.js';
import { fmtDate, fmtDateTime } from '../format.js';
import { ErrorBox, PatientPicker } from '../components/ui.jsx';
import ReferralForm from '../components/referrals/ReferralForm.jsx';
import { OpportunityReport, SourcesReport, ReferralSettings } from '../components/referrals/ReferralReports.jsx';
import '../components/referrals/referrals.css';

const VIEWS = [
  ['open', 'Open'], ['critical', 'Critical'], ['overdue', 'Overdue'], ['awaiting', 'Reports'], ['past_due', 'Past due'], ['inbound', 'Referred to us'], ['closed', 'Closed'],
];
const REPORTS = [['opportunity', 'In-house opportunity'], ['sources', 'Who sends us patients']];
const NEXT = { open: 'scheduled', scheduled: 'seen' };
const NEXT_LABEL = { scheduled: 'Scheduled', seen: 'Seen' };
const urgencyBadge = (x) => (x.critical ? <span className="rt-badge critical">Critical</span> : x.urgency === 'soon' ? <span className="rt-badge soon">Soon</span> : null);
const who = (x) => `${x.first_name} ${x.last_name}`;

// Referrals board (backlog RT1–RT5, docs/workflows/specs/RT-referrals.md): every referral until the specialist's report
// is back — critical ones first, then reports waiting for a yes, overdue and past-due ones. J / K move, Enter opens,
// S moves it along (sent → scheduled → seen), R confirms the report that came in (and completes it), C closes,
// U makes it critical (or not), L prints the letter, N refers the active patient.
export default function Referrals() {
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const isReport = REPORTS.some(([k]) => k === view);
  const [filters, setFilters] = useState({ urgency: params.get('urgency') || '', contact_id: params.get('contact_id') || '', provider_id: params.get('provider_id') || '', patient_id: params.get('patient') || '' });
  const qs = new URLSearchParams(Object.entries({ view: isReport ? 'open' : view, ...filters }).filter(([, v]) => v)).toString();
  const { data, error, reload } = useApi(`/referral-tracker/board?${qs}`);
  const contacts = useLookup('/referral-contacts');
  const providers = useLookup('/providers?active=true');
  const { patientId } = useActivePatient();
  const { data: active } = useApi(patientId ? `/patients/${patientId}/card` : null);
  const [cur, setCur] = useState(0);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(null);
  const [settings, setSettings] = useState(false);
  const [closing, setClosing] = useState(null);
  const rows = data?.rows || [];
  const w = can('patients:write');
  useLiveEvents((e) => ['referrals', 'referral_alert', 'referral_report'].includes(e.type) && reload());
  useEffect(() => { if (cur >= rows.length && cur > 0) setCur(Math.max(0, rows.length - 1)); }, [rows.length, cur]);
  useEffect(() => { document.querySelector('tr.kb-row')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);
  useEffect(() => { if (params.get('new') && w) setCreating({ direction: params.get('direction') || 'out' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const row = rows[cur];
  const setView = (v) => { setParams({ ...Object.fromEntries(params), view: v }); setCur(0); };
  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setCur(0); };

  const act = async (fn, msg, undo) => {
    try {
      await undoable(msg, fn, undo);
      reload();
    } catch { /* the toast said why */ }
  };
  const advance = (x) => {
    const to = NEXT[x.status];
    if (!to || !w) return;
    act(() => api.post(`/referral-tracker/referrals/${x.id}/status`, { status: to }), `${who(x)}: ${NEXT_LABEL[to].toLowerCase()}`, () => api.post(`/referral-tracker/referrals/${x.id}/status`, { status: x.status, note: 'Undone' }));
  };
  const confirmReport = (x) => {
    if (!x.suggestion || !w) return;
    act(() => api.post(`/referral-tracker/matches/${x.suggestion.id}/confirm`, { complete: true }), `Report filed and ${who(x)}’s referral completed`, () => api.post(`/referral-tracker/referrals/${x.id}/reopen`, { note: 'Undone right after completing' }));
  };
  const toggleCritical = (x) => {
    if (!w || x.status === 'closed' || x.direction !== 'out') return;
    const to = x.critical ? 'soon' : 'critical';
    act(() => api.post(`/referral-tracker/referrals/${x.id}/urgency`, { urgency: to }), to === 'critical' ? `${who(x)} marked critical — the team is alerted` : `${who(x)} no longer critical`,
      () => api.post(`/referral-tracker/referrals/${x.id}/urgency`, { urgency: x.critical ? 'critical' : x.urgency || 'routine' }));
  };
  const startNew = (direction = 'out') => w && setCreating({ direction });

  useShortcuts([
    { combo: 'j', handler: () => setCur((c) => Math.min(rows.length - 1, c + 1)), label: 'Next referral', enabled: !isReport },
    { combo: 'k', handler: () => setCur((c) => Math.max(0, c - 1)), label: 'Previous referral', enabled: !isReport },
    { combo: 'enter', handler: () => row && setOpen(row.id), label: 'Open the referral', enabled: !isReport && !!row && !open },
    { combo: 's', handler: () => row && advance(row), label: 'Move it along (scheduled → seen)', enabled: !isReport && w },
    { combo: 'r', handler: () => row && (row.suggestion ? confirmReport(row) : setOpen(row.id)), label: 'Confirm the report and complete', enabled: !isReport && w },
    { combo: 'c', handler: () => row && row.status !== 'closed' && setClosing(row), label: 'Close with a reason', enabled: !isReport && w },
    { combo: 'u', handler: () => row && toggleCritical(row), label: 'Critical on/off', enabled: !isReport && w },
    { combo: 'l', handler: () => row && window.open(`/referrals/${row.id}/letter`, '_blank'), label: 'Print the letter', enabled: !isReport && !!row },
    { combo: 'n', handler: () => startNew('out'), label: 'Refer the active patient', enabled: w && !creating },
    { combo: 'escape', handler: () => { setOpen(null); setCreating(null); setClosing(null); setSettings(false); }, label: 'Close the panel', enabled: !!(open || creating || closing || settings), inInputs: true },
  ]);
  useCommands([
    { id: 'rt-new', label: 'Refer a patient to a specialist', hint: 'Referrals', run: () => startNew('out') },
    { id: 'rt-in', label: 'Record a patient referred to us', hint: 'Referrals', run: () => startNew('in') },
    { id: 'rt-past', label: 'Referrals past due', hint: 'Referrals', run: () => setView('past_due') },
  ]);

  const counts = data?.counts || {};
  const patientForForm = creating?.patient || (active && !creating?.pick ? { id: active.id, first_name: active.preferred_name || active.first_name, last_name: active.last_name } : null);

  return (
    <div className="rt-page">
      <div className="page-header">
        <div>
          <h1>Referrals</h1>
          <div className="muted">Every patient sent to a specialist, until their report is back on the chart. Critical ones alert the team every week until the patient is seen.</div>
        </div>
        <div className="actions">
          {w && <button className="primary" onClick={() => startNew('out')} title="N">Refer a patient</button>}
          {w && <button onClick={() => startNew('in')}>Referred to us…</button>}
          <button onClick={() => setSettings(true)} aria-label="Referral settings" title="Settings"><Gear size={16} /></button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {VIEWS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} className={`${view === k ? 'active' : ''}${k === 'critical' && counts.critical ? ' rt-tab-critical' : ''}`} onClick={() => setView(k)}>
            {l}{counts[k] ? <span className="count">{counts[k]}</span> : null}
          </button>
        ))}
        {can('reports:read') && REPORTS.map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'opportunity' && <OpportunityReport />}
      {view === 'sources' && <SourcesReport />}
      {!isReport && (
        <>
          <div className="rt-filters">
            <select aria-label="Urgency" value={filters.urgency} onChange={(e) => setFilter('urgency', e.target.value)}>
              <option value="">Any urgency</option><option value="critical">Critical</option><option value="soon">Soon</option><option value="routine">Routine</option>
            </select>
            <select aria-label="Specialist" value={filters.contact_id} onChange={(e) => setFilter('contact_id', e.target.value)}>
              <option value="">Any specialist</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select aria-label="Dentist" value={filters.provider_id} onChange={(e) => setFilter('provider_id', e.target.value)}>
              <option value="">Any dentist</option>{providers.filter((p) => p.type !== 'hygienist').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {filters.patient_id && <button className="chip active" onClick={() => setFilter('patient_id', '')}>One patient ✕</button>}
            {view === 'past_due' && <a className="small" href="#" onClick={async (e) => { e.preventDefault(); await downloadCsv(filters); }}>Download CSV</a>}
            {view === 'past_due' && data && <span className="muted">Open more than {data.past_due_days} days</span>}
          </div>
          <ErrorBox error={error} />
          {data && !rows.length && <div className="card muted">{EMPTY[view]}</div>}
          {rows.length > 0 && (
            <div className="card table-wrap rt-board">
              <table>
                <thead><tr><th>Patient</th><th>{view === 'inbound' ? 'Referred by' : 'Specialist'}</th><th>For</th><th>Status</th><th>Referred</th><th>Expected</th><th /></tr></thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={x.id} className={`${i === cur ? 'kb-row' : ''}${x.alerting ? ' rt-row-critical' : ''}`} onClick={() => setCur(i)} onDoubleClick={() => setOpen(x.id)} data-id={x.id}>
                      <td><Link to={`/patients/${x.patient_id}`}>{who(x)}</Link> {urgencyBadge(x)}</td>
                      <td>{x.contact_name}{x.specialty ? <div className="muted small">{x.specialty}</div> : null}</td>
                      <td className="rt-reason">{x.reason || x.teeth || '—'}</td>
                      <td>
                        <span className={`rt-status ${x.status}`}>{x.status_label}</span>
                        {x.overdue && <span className="rt-flag late">overdue</span>}
                        {x.past_due && !x.overdue && <span className="rt-flag late">{x.days_open} days</span>}
                        {x.review_due && <span className="rt-flag">to review</span>}
                        {x.ready_to_report_back && <span className="rt-flag ok">ready to report back</span>}
                      </td>
                      <td>{fmtDate(x.referral_date)}<div className="muted small">{x.days_open != null ? `${x.days_open} d` : x.close_reason ? (data.close_reasons[x.close_reason] || x.close_reason) : ''}</div></td>
                      <td>{x.expected_by ? fmtDate(x.expected_by) : '—'}</td>
                      <td className="rt-actions">
                        {x.suggestion && w && (
                          <button className="small primary rt-confirm" onClick={(e) => { e.stopPropagation(); confirmReport(x); }} title={`${x.suggestion.reason || ''} (R)`}>
                            <FileCheck2 size={14} /> Report in: {x.suggestion.filename} — confirm &amp; complete
                          </button>
                        )}
                        {!x.suggestion && NEXT[x.status] && x.direction === 'out' && w && <button className="small" onClick={(e) => { e.stopPropagation(); advance(x); }} title="S">{NEXT_LABEL[NEXT[x.status]]}</button>}
                        <button className="small" onClick={(e) => { e.stopPropagation(); setOpen(x.id); }}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted small rt-keys">J/K move · Enter open · S scheduled/seen · R confirm report · C close · U critical · L letter · N new</div>
            </div>
          )}
        </>
      )}
      {creating && (
        <aside className="drawer rt-drawer" role="dialog" aria-label={creating.direction === 'in' ? 'Referred to us' : 'Refer a patient'}>
          <div className="drawer-head"><strong>{creating.direction === 'in' ? 'Referred to us' : 'Refer to a specialist'}</strong><button className="small" onClick={() => setCreating(null)} aria-label="Close">✕</button></div>
          <div className="drawer-body">
            {patientForForm
              ? (
                <>
                  <ReferralForm key={`${patientForForm.id}-${creating.direction}`} patient={patientForForm} direction={creating.direction} onDone={() => { setCreating(null); reload(); }} onCancel={() => setCreating(null)} />
                  <button type="button" className="link small" onClick={() => setCreating({ direction: creating.direction, pick: true })}>A different patient…</button>
                </>
              )
              : <><div className="muted">Which patient?</div><PatientPicker value={null} onChange={(p) => setCreating({ ...creating, patient: p })} /></>}
          </div>
        </aside>
      )}
      {open && <ReferralDrawer id={open} onClose={() => setOpen(null)} onChange={reload} closeReasons={data?.close_reasons || {}} />}
      {closing && <CloseDrawer referral={closing} reasons={data?.close_reasons || {}} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />}
      {settings && <ReferralSettings onClose={() => setSettings(false)} canEdit={user?.role === 'admin'} />}
    </div>
  );
}

const EMPTY = {
  open: 'No open referrals. Press N to refer the active patient.', critical: 'No critical referrals waiting — nice.', overdue: 'Nothing overdue.',
  awaiting: 'No reports waiting.', past_due: 'Nothing open longer than the past-due limit.', inbound: 'No patients referred to us are waiting on a thank-you or report.', closed: 'Nothing closed in the last 90 days.',
};

async function downloadCsv(filters) {
  const qs = new URLSearchParams(Object.entries({ ...filters, format: 'csv' }).filter(([, v]) => v)).toString();
  const token = sessionStorage.getItem('dm_token');
  const res = await fetch(`/api/referral-tracker/past-due?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return toast('Couldn’t download the report', { tone: 'error' });
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'referrals-past-due.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// Closing always says why (a reason from the list, and a note for "other").
function CloseDrawer({ referral, reasons, onClose, onDone }) {
  const [reason, setReason] = useState(referral.report_document_id ? 'completed' : '');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    try {
      await api.post(`/referral-tracker/referrals/${referral.id}/close`, { reason, note: note || null });
      toast(`${who(referral)}’s referral closed`, { undo: async () => { await api.post(`/referral-tracker/referrals/${referral.id}/reopen`, { note: 'Undone right after closing' }); onDone(); } });
      onDone();
    } catch (e) { setError(e); }
  };
  return (
    <aside className="drawer rt-drawer" role="dialog" aria-label="Close the referral">
      <div className="drawer-head"><strong>Close {who(referral)}’s referral</strong><button className="small" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="drawer-body">
        <ErrorBox error={error} />
        <div className="chips" role="radiogroup" aria-label="Why">
          {Object.entries(reasons).filter(([k]) => k !== 'completed' || referral.report_document_id).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={reason === k} className={`chip${reason === k ? ' active' : ''}`} onClick={() => setReason(k)}>{l}</button>
          ))}
        </div>
        <label className="rt-field">Note{reason === 'other' ? ' (needed)' : ''}<input autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reason && save()} /></label>
        <div className="form-actions"><button className="primary" disabled={!reason || (reason === 'other' && !note)} onClick={save}>Close referral</button></div>
      </div>
    </aside>
  );
}

// One referral: what it's for, the timeline (who did what, when), files, and every action.
function ReferralDrawer({ id, onClose, onChange, closeReasons }) {
  const { can } = useAuth();
  const { data: r, reload, error } = useApi(`/referral-tracker/referrals/${id}`);
  const { data: options } = useApi(r && r.direction === 'out' && r.status !== 'closed' && !r.report_document_id && can('clinical:read') ? `/referral-tracker/referrals/${id}/report-options` : null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [letter, setLetter] = useState(null);
  const w = can('patients:write');
  const run = async (fn, msg) => {
    setErr(null);
    try {
      const out = await fn();
      if (msg) toast(msg);
      reload();
      onChange?.();
      return out;
    } catch (e) { setErr(e); return null; }
  };
  const post = (path, body, msg) => run(() => api.post(`/referral-tracker/referrals/${id}/${path}`, body || {}), msg);
  const printText = (title, text) => {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.title = title;
    const pre = win.document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font:15px/1.6 Georgia,serif;max-width:640px;margin:48px auto';
    pre.textContent = text;
    win.document.body.appendChild(pre);
    win.print();
  };
  const inbound = r?.direction === 'in';
  const sorted = useMemo(() => (r?.events || []).slice().reverse(), [r]);
  return (
    <aside className="drawer rt-drawer rt-detail" role="dialog" aria-label="Referral">
      <div className="drawer-head">
        <div>
          <strong>{r ? `${who(r)} ${inbound ? '← ' : '→ '}${r.contact_name}` : 'Referral'}</strong>
          {r && <div className="muted small">{r.status_label}{r.critical ? ' · critical' : r.urgency === 'soon' ? ' · soon' : ''} · referred {fmtDate(r.referral_date)}{r.expected_by ? ` · expected by ${fmtDate(r.expected_by)}` : ''}</div>}
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">
        <ErrorBox error={error || err} />
        {r && (
          <>
            {r.alerting && <div className="rt-alert"><AlertTriangle size={14} /> Critical and not seen yet — the team is reminded every week until it is.</div>}
            <div className="rt-what">
              {r.reason && <div>{r.reason}</div>}
              {r.items.map((i) => <div key={i.id} className="small">{i.code} {i.description}{i.tooth ? ` #${i.tooth}` : ''}</div>)}
              {r.notes && <div className="muted small">{r.notes}</div>}
              <div className="muted small">{[r.contact_practice, r.contact_phone, r.contact_fax && `fax ${r.contact_fax}`, r.contact_email].filter(Boolean).join(' · ')}</div>
            </div>
            {r.matches.map((m) => (
              <div key={m.id} className="rt-match">
                <FileCheck2 size={14} /> <strong>{m.filename}</strong> looks like the report{m.source === 'ai' ? ' (AI suggestion)' : ''}. <span className="muted small">{m.reason}</span>
                {w && (
                  <div className="drawer-actions">
                    <button className="small primary" onClick={() => run(() => api.post(`/referral-tracker/matches/${m.id}/confirm`, { complete: true }), 'Report filed — referral complete')}>Confirm &amp; complete</button>
                    <button className="small" onClick={() => run(() => api.post(`/referral-tracker/matches/${m.id}/confirm`, {}), 'Report filed')}>Confirm only</button>
                    <button className="small" onClick={() => run(() => api.post(`/referral-tracker/matches/${m.id}/dismiss`, {}), 'Dismissed')}>Not this one</button>
                  </div>
                )}
              </div>
            ))}
            {w && r.status !== 'closed' && (
              <div className="drawer-actions">
                {!inbound && NEXT[r.status] && <button className="small" onClick={() => post('status', { status: NEXT[r.status] }, `Marked ${NEXT_LABEL[NEXT[r.status]].toLowerCase()}`)}>{NEXT_LABEL[NEXT[r.status]]}</button>}
                {!inbound && r.report_document_id && <button className="small primary" onClick={() => post('complete', {}, 'Referral complete')}>Mark complete</button>}
                {!inbound && <button className="small" onClick={() => post('urgency', { urgency: r.critical ? 'soon' : 'critical' }, r.critical ? 'No longer critical' : 'Marked critical — the team is alerted')}>{r.critical ? 'Not critical' : 'Make critical'}</button>}
                {!inbound && <button className="small" onClick={() => window.open(`/referrals/${r.id}/letter`, '_blank')}><Printer size={13} /> Letter</button>}
                {!inbound && r.contact_email && <button className="small" onClick={() => post('send', { channel: 'email' }, 'Secure link emailed')}><Mail size={13} /> Email link</button>}
                {!inbound && <button className="small" onClick={() => run(() => api.post(`/referral-tracker/referrals/${r.id}/tell-patient`, {}), 'Patient told')}>Text patient</button>}
                {inbound && (
                  <>
                    <button className="small" onClick={async () => { const l = await run(() => api.get(`/referral-tracker/referrals/${r.id}/thank-you`)); if (l) setLetter({ kind: 'thank-you', text: l.text }); }}>{r.thank_you_sent_at ? 'Thank-you sent ✓' : 'Thank-you letter'}</button>
                    <button className="small" onClick={async () => { const l = await run(() => api.get(`/referral-tracker/referrals/${r.id}/report-back`)); if (l) setLetter({ kind: 'report-back', text: l.text }); }}>Report back</button>
                  </>
                )}
              </div>
            )}
            {letter && (
              <div className="rt-letter">
                <pre>{letter.text}</pre>
                <div className="drawer-actions">
                  {r.contact_email && <button className="small primary" onClick={async () => { if (await post(letter.kind, { channel: 'email', resend: true }, 'Emailed')) setLetter(null); }}>Email</button>}
                  <button className="small" onClick={async () => { printText(letter.kind === 'thank-you' ? 'Thank you' : 'Treatment report', letter.text); if (await post(letter.kind, { channel: 'print', resend: true }, 'Recorded as printed')) setLetter(null); }}>Print</button>
                  <button className="small" onClick={() => setLetter(null)}>Cancel</button>
                </div>
              </div>
            )}
            {!inbound && r.status !== 'closed' && !r.report_document_id && options?.length > 0 && w && (
              <details className="rt-link">
                <summary>Link the specialist’s report</summary>
                {options.map((d) => (
                  <div key={d.id} className="rt-opt">
                    <span>{d.filename} <span className="muted small">{fmtDate(d.created_at?.slice(0, 10))}</span></span>
                    <button className="small" onClick={() => post('report', { document_id: d.id, complete: true }, 'Report filed — referral complete')}>File &amp; complete</button>
                  </div>
                ))}
              </details>
            )}
            {r.report_document_id && !r.report_reviewed_at && can('clinical:write') && <button className="small" onClick={() => post('reviewed', {}, 'Report reviewed')}>I’ve reviewed the report</button>}
            {r.documents.length > 0 && (
              <div className="rt-files">
                {r.documents.map((d) => <a key={`${d.role}-${d.id}`} href={`/api/documents/${d.id}/file`} onClick={(e) => { e.preventDefault(); openDoc(d.id); }}>{d.role === 'report' ? 'Report: ' : ''}{d.filename}</a>)}
              </div>
            )}
            {w && r.status === 'closed' && (
              <form className="rt-note" onSubmit={async (e) => { e.preventDefault(); const why = e.currentTarget.elements.why.value.trim(); if (why) await post('reopen', { note: why }, 'Reopened'); }}>
                <input name="why" placeholder="Reopen — why? (Enter)" aria-label="Why reopen it" />
              </form>
            )}
            {r.status === 'closed' && <div className="muted small">Closed: {closeReasons[r.close_reason] || r.close_reason}{r.close_note ? ` — ${r.close_note}` : ''}</div>}
            <h3 className="rt-h">Timeline</h3>
            {w && (
              <form className="rt-note" onSubmit={async (e) => { e.preventDefault(); if (note.trim() && await post('note', { note })) setNote(''); }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (called their office, patient says…)" />
              </form>
            )}
            <ul className="timeline">
              {sorted.map((e) => (
                <li key={e.id} className={e.kind === 'alert' ? 'tl-danger' : e.kind === 'closed' || e.kind === 'report' ? 'tl-ok' : e.kind === 'nudge' ? 'tl-warn' : ''}>
                  <div>{e.note || (e.to_status ? `${e.from_status || '—'} → ${e.to_status}` : e.kind)}{e.on_date && e.kind === 'status' ? ` (${fmtDate(e.on_date)})` : ''}</div>
                  <div className="muted small">{fmtDateTime(String(e.created_at).slice(0, 16))} · {e.who || (e.source === 'automation' ? 'Automatic' : e.source)}{e.source !== 'human' && e.source !== 'automation' ? ` (${e.source})` : ''}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

async function openDoc(id) {
  const token = sessionStorage.getItem('dm_token');
  const res = await fetch(`/api/documents/${id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return toast('Couldn’t open the file', { tone: 'error' });
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}
