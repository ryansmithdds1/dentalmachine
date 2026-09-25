import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { undoable } from '../toast.js';
import { money, fmtDate, fmtDateTime, label, shiftDate, practiceToday } from '../format.js';
import { Badge, ErrorBox, useSubmit, MoreRows, SidePanel } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';
import { brokenLabel } from '../components/calendar/BrokenPicker.jsx';
import RecallBoard from '../components/RecallBoard.jsx';
import MailingLabelsButton from '../components/MailingLabels.jsx';
import './followups.css';

const OUTCOMES = [['left_voicemail', 'Left voicemail'], ['texted', 'Texted'], ['emailed', 'Emailed'], ['spoke_scheduled', 'Spoke — scheduled'], ['spoke_will_call', 'Spoke — will call back'], ['declined', 'Declined'], ['wrong_number', 'Wrong number'], ['note', 'Note']];
const outcomeLabel = (o) => OUTCOMES.find((x) => x[0] === o)?.[1] || o;
const minutesBetween = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60_000;

// The front desk's call lists: unconfirmed visits, recall, unscheduled treatment and broken appointments.
export default function Followups() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'recall';
  const { data: unsched, reload: reloadUnsched } = useApi('/followups/unscheduled');
  const { data: broken, reload: reloadBroken } = useApi('/followups/broken');
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Follow-up</h1>
          <div className="muted">Everyone who should be on the schedule but isn&apos;t. Log each call so the whole team sees who was reached.</div>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'unconfirmed' ? 'active' : ''} onClick={() => setParams({ tab: 'unconfirmed' })}>Unconfirmed</button>
        <button className={tab === 'recall' ? 'active' : ''} onClick={() => setParams({ tab: 'recall' })}>Recall</button>
        <button className={tab === 'board' ? 'active' : ''} onClick={() => setParams({ tab: 'board' })}>Recall board</button>
        <button className={tab === 'unscheduled' ? 'active' : ''} onClick={() => setParams({ tab: 'unscheduled' })}>Unscheduled treatment {unsched ? <span className="count">{unsched.length}</span> : null}</button>
        <button className={tab === 'broken' ? 'active' : ''} onClick={() => setParams({ tab: 'broken' })}>Broken appointments {broken ? <span className="count">{broken.length}</span> : null}</button>
      </div>
      {tab === 'unconfirmed' && <Unconfirmed />}
      {tab === 'recall' && <Recall />}
      {tab === 'board' && <RecallBoard />}
      {tab === 'unscheduled' && <CallList kind="unscheduled" rows={unsched} onChange={reloadUnsched} />}
      {tab === 'broken' && <CallList kind="broken" rows={broken} onChange={reloadBroken} />}
    </>
  );
}

const SENT = { reminder: 'Reminder', booking_confirmation: 'Booked', no_show: 'Missed visit' };
const deliveryText = (m) => (m.status === 'blocked' ? 'not sent (opted out)' : m.status === 'failed' ? 'failed' : m.delivery || 'sent');
const pct = (n) => (n == null ? '—' : `${n}%`);

// Visits coming up that nobody has confirmed: who to call, what's already been tried (the texts and emails
// sent and whether they arrived, the patient's last reply), and one action per row to record the outcome.
// Workflow 13 (docs/workflows/specs/13-confirm.md): J / K move between rows, X selects, C confirms the row
// (Shift+C the selection), each with Undo; "Text a reminder" goes to everyone unconfirmed (or the selection).
const justReminded = (r) => r.messages.some((m) => m.kind === 'reminder' && m.status === 'sent' && Date.now() - Date.parse(`${m.created_at.replace(' ', 'T')}Z`) < 15 * 60_000);
function Unconfirmed() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const onDay = params.get('date');
  const [days, setDays] = useState(() => Number(params.get('days')) || 2);
  const { data, reload } = useApi(onDay ? `/followups/unconfirmed?date=${onDay}` : `/followups/unconfirmed?days=${days}`);
  const { data: stats } = useApi('/followups/confirmation-stats');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // Confirmed here: hidden at once (the list reloads behind it); Undo brings them back.
  const [gone, setGone] = useState([]);
  const rows = (data || []).filter((r) => !gone.includes(r.id));
  const [cur, setCur] = useState(0);
  const [picked, setPicked] = useState([]);
  const [sent, setSent] = useState(null);
  const w = can('schedule:write');
  useEffect(() => { if (cur > 0 && cur >= rows.length) setCur(Math.max(0, rows.length - 1)); }, [rows.length, cur]);
  useEffect(() => { document.querySelector('tr.kb-row')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);
  const act = async (r, what) => {
    setBusy(`${r.id}-${what}`);
    setError(null);
    try {
      if (what === 'left') await api.patch(`/appointments/${r.id}/status`, { status: 'scheduled', confirmed_via: 'left_message' });
      else await api.post(`/appointments/${r.id}/remind`, {});
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const confirm = async (list) => {
    if (!w || !list.length) return;
    const ids = list.map((r) => r.id);
    const left = list.filter((r) => r.left_message).map((r) => r.id);
    const show = () => setGone((g) => g.filter((x) => !ids.includes(x)));
    setGone((g) => [...g, ...ids]);
    setPicked((p) => p.filter((x) => !ids.includes(x)));
    setError(null);
    try {
      await undoable(list.length === 1 ? `Confirmed ${list[0].name} · ${fmtDateTime(list[0].start_time)}` : `Confirmed ${list.length} visits`,
        () => api.post('/followups/unconfirmed/confirm', { ids }),
        async () => { await api.post('/followups/unconfirmed/confirm', { ids, undo: true, left_message_ids: left }); show(); await reload(); });
      reload();
    } catch (e) {
      show();
      setError(e);
    }
  };
  // Everyone unconfirmed (or the selection) who can get a text or email and hasn't just had one.
  const remindable = (picked.length ? rows.filter((r) => picked.includes(r.id)) : rows).filter((r) => r.reach && !justReminded(r));
  const remindAll = async () => {
    const targets = remindable;
    if (!targets.length) return;
    setBusy('remind-all');
    setSent(null);
    const out = { sent: [], failed: [], skipped: (picked.length ? rows.filter((r) => picked.includes(r.id)) : rows).length - targets.length };
    for (const r of targets) {
      try {
        const m = await api.post(`/appointments/${r.id}/remind`, {});
        if (m.status === 'sent') out.sent.push(r.name);
        else out.failed.push(`${r.name} (${m.status === 'blocked' ? 'opted out' : 'didn’t go through'})`);
      } catch (e) {
        out.failed.push(`${r.name} (${e.message})`);
      }
    }
    setSent(out);
    setBusy(null);
    reload();
  };
  const row = rows[cur];
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  useShortcuts([
    { combo: 'j', handler: () => setCur((i) => Math.min(i + 1, rows.length - 1)), label: 'Next visit', section: 'Unconfirmed list' },
    { combo: 'k', handler: () => setCur((i) => Math.max(i - 1, 0)), label: 'Previous visit', section: 'Unconfirmed list' },
    { combo: 'x', handler: () => row && toggle(row.id), label: 'Select the visit', section: 'Unconfirmed list', enabled: w },
    { combo: 'c', handler: () => row && confirm([row]), label: 'Confirm the visit (by phone)', section: 'Unconfirmed list', enabled: w },
    { combo: 'shift+c', handler: () => confirm(rows.filter((r) => picked.includes(r.id))), label: 'Confirm the selected visits', section: 'Unconfirmed list', enabled: w },
  ]);
  useCommands(w ? [
    { id: 'unconf-remind-all', label: 'Unconfirmed: text a reminder to all', run: remindAll },
    { id: 'unconf-confirm-picked', label: 'Unconfirmed: confirm the selected visits', hint: 'Shift+C', run: () => confirm(rows.filter((r) => picked.includes(r.id))) },
  ] : []);
  return (
    <>
      {stats && (
        <div className="stat-strip">
          <div><strong>{pct(stats.confirmed_pct)}</strong><span>confirmed before the visit (30 days)</span></div>
          <div><strong>{pct(stats.no_show_pct_confirmed)}</strong><span>no-shows when confirmed</span></div>
          <div><strong>{pct(stats.no_show_pct_unconfirmed)}</strong><span>no-shows when not confirmed</span></div>
          <div><strong>{stats.messages.sent}</strong><span>reminders sent · {stats.messages.not_delivered} didn&apos;t arrive</span></div>
        </div>
      )}
      <div className="inline unconf-bar">
        {onDay ? (
          <>
            <span className="muted">{data ? `${rows.length} unconfirmed` : 'Loading…'} on {fmtDate(onDay)}</span>
            <button className="link" onClick={() => setParams({ tab: 'unconfirmed' })}>Show the next few days</button>
          </>
        ) : (
          <>
            <span className="muted">{data ? `${rows.length} unconfirmed` : 'Loading…'} in the</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How far ahead">
              <option value={1}>next day</option><option value={2}>next 2 days</option><option value={3}>next 3 days</option><option value={7}>next week</option>
            </select>
          </>
        )}
        {w && rows.length > 0 && (
          <span className="inline unconf-actions">
            <button disabled={!picked.length} onClick={() => confirm(rows.filter((r) => picked.includes(r.id)))} title="Shift+C">Confirm {picked.length || ''} selected</button>
            <button className="primary" disabled={!!busy || !remindable.length} onClick={remindAll}
              title={remindable.length ? 'Each gets a text (or email) with a link to confirm' : 'Nobody left to text: no phone or email, or they just got one'}>
              {busy === 'remind-all' ? 'Sending…' : `Text a reminder to ${picked.length ? `${remindable.length} selected` : `all ${remindable.length}`}`}
            </button>
          </span>
        )}
      </div>
      {w && rows.length > 0 && <div className="muted kb-hint"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>X</kbd> select · <kbd>C</kbd> confirm · <kbd>Shift</kbd>+<kbd>C</kbd> confirm selected</div>}
      {sent && (
        <div className={`public-notice ${sent.failed.length ? 'warn' : 'ok'} remind-result`} role="status">
          {sent.sent.length ? `Reminder sent to ${sent.sent.length}.` : 'No reminders went out.'}
          {sent.failed.length > 0 && <> Not sent: {sent.failed.join(', ')}. Texts that failed also show in Needs attention.</>}
          {sent.skipped > 0 && <> {sent.skipped} skipped (no phone or email, or reminded in the last 15 minutes).</>}
          <button className="link" onClick={() => setSent(null)} style={{ marginLeft: 8 }}>Dismiss</button>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="unconf-table">
            <thead><tr>{w && <th aria-label="Select" />}<th>Visit</th><th>Patient</th><th>Tried</th><th>Last reply</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={i === cur ? 'kb-row' : ''} aria-selected={i === cur} onClick={() => setCur(i)} data-appt-id={r.id}>
                  {w && <td><input type="checkbox" style={{ width: 'auto' }} aria-label={`Select ${r.name}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /></td>}
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.start_time)}<div className="muted">{r.reason || 'Visit'} · {r.provider_name}</div></td>
                  <td>
                    <Link to={`/patients/${r.patient_id}`}><strong>{r.name}</strong></Link>
                    <div className="muted">{r.contact ? <>via {r.contact} · </> : null}{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : 'no phone'}</div>
                    {r.problems.map((p) => <div key={p}><span className="badge warn">{p}</span></div>)}
                  </td>
                  <td>
                    {r.messages.length === 0 && <span className="muted">{r.reach ? 'Nothing sent yet' : 'Can’t be texted or emailed'}</span>}
                    {r.messages.slice(0, 3).map((m) => (
                      <div key={m.id} style={{ fontSize: 12 }}>
                        {SENT[m.kind] || label(m.kind)} by {m.channel === 'sms' ? 'text' : m.channel} · <span className={/failed|undelivered|bounced|not sent/.test(deliveryText(m)) ? 'text-danger' : ''}>{deliveryText(m)}</span>
                        <span className="muted"> · {fmtDate(m.created_at)}</span>
                      </div>
                    ))}
                    {r.left_message && <div style={{ fontSize: 12 }}><span className="badge">Left a message</span></div>}
                  </td>
                  <td style={{ maxWidth: 220 }}>{r.last_reply ? <><div>&ldquo;{r.last_reply.body}&rdquo;</div><div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.last_reply.created_at)}</div></> : <span className="muted">—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {w && (
                      <>
                        <button className="small primary" onClick={() => confirm([r])} title="C">Confirmed</button>{' '}
                        <button className="small" disabled={!!busy} onClick={() => act(r, 'left')}>Left message</button>{' '}
                        <button className="small" disabled={!!busy || !r.reach} title={r.reach ? `Send the reminder again by ${r.reach === 'sms' ? 'text' : 'email'}` : 'No working phone or email'} onClick={() => act(r, 'send')}>Send again</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && rows.length === 0 && <div className="empty">Everyone&apos;s confirmed. 🎉</div>}
        </div>
      </div>
      <Openings />
    </>
  );
}

// Cancellations the system texted to ASAP and waitlist patients, and who took them.
function Openings() {
  const { data } = useApi('/followups/openings');
  if (!data?.length) return null;
  const STATUS = { filled: 'Filled', open: 'Offered — waiting for a yes', queued: 'Waiting for sending hours', no_takers: 'Nobody to offer it to', expired: 'Not filled' };
  return (
    <div className="card" style={{ padding: 0, marginTop: 12 }}>
      <h2 style={{ padding: '14px 16px 0' }}>Cancellations filled automatically</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Opening</th><th>Cancelled by</th><th>Offered to</th><th>Result</th></tr></thead>
          <tbody>
            {data.map((o) => (
              <tr key={o.id}>
                <td>{fmtDateTime(o.start_time)}<div className="muted">{o.provider_name}</div></td>
                <td>{o.cancelled_first} {o.cancelled_last}</td>
                <td>{o.offered || '—'}</td>
                <td>{o.status === 'filled' ? <><span className="badge ok">Filled</span> <Link to={`/patients/${o.filled_patient_id}`}>{o.filled_first} {o.filled_last}</Link></> : <span className="muted">{STATUS[o.status] || o.status}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Recall (A051, A037): one row per patient — the recalls they're due for (exam, cleaning, x-rays…) as chips — so one
// call is logged once. J / K move, L logs the call right under the row (1–8 pick how it went, Enter saves), B books.
function Recall() {
  const { can, practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [win, setWin] = useState(30);
  const [limit, setLimit] = useState(200);
  const { data: recalls, reload } = useApi(`/recalls?before=${shiftDate(today, win)}&status=due,contacted&limit=${limit}`);
  const [selected, setSelected] = useState([]);
  const [notice, setNotice] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [bookFor, setBookFor] = useState(null);
  const [cur, setCur] = useState(0);
  const people = useMemo(() => {
    const by = new Map();
    for (const r of recalls || []) {
      if (!by.has(r.patient_id)) by.set(r.patient_id, { patient_id: r.patient_id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, items: [] });
      by.get(r.patient_id).items.push(r);
    }
    return [...by.values()].map((g) => ({
      ...g,
      ids: g.items.map((r) => r.id),
      due: g.items.reduce((d, r) => (r.due_date < d ? r.due_date : d), g.items[0].due_date),
      status: g.items.some((r) => r.status === 'due') ? 'due' : 'contacted',
      last_contacted_at: g.items.map((r) => r.last_contacted_at).filter(Boolean).sort().at(-1) || null,
    }));
  }, [recalls]);
  useEffect(() => { if (cur > 0 && cur >= people.length) setCur(Math.max(0, people.length - 1)); }, [people.length, cur]);
  useEffect(() => { document.querySelector('.recall-list tr.kb-row')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);
  const row = people[cur];
  const campaign = async () => {
    const r = await api.post('/recalls/campaign', { recall_ids: selected });
    setNotice(`Sent ${r.sent} recall reminder${r.sent === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped (no phone/email or opted out)` : ''}.`);
    setSelected([]);
    reload();
  };
  const book = (g) => g && setBookFor({ patient: { id: g.patient_id, first_name: g.first_name, last_name: g.last_name }, date: g.due > today ? g.due : today });
  const w = can('schedule:write');
  const quiet = !logFor && !bookFor;
  useShortcuts([
    { combo: 'j', handler: () => setCur((i) => Math.min(i + 1, people.length - 1)), label: 'Next patient', section: 'Recall list', enabled: quiet },
    { combo: 'k', handler: () => setCur((i) => Math.max(i - 1, 0)), label: 'Previous patient', section: 'Recall list', enabled: quiet },
    { combo: 'l', handler: () => row && setLogFor(row), label: 'Log a call to the patient (1–8 how it went, Enter saves)', section: 'Recall list', enabled: quiet && can('patients:write') },
    { combo: 'b', handler: () => book(row), label: 'Book the patient', section: 'Recall list', enabled: quiet && w },
  ]);
  const allIds = people.flatMap((g) => g.ids);
  const picked = (g) => g.ids.every((id) => selected.includes(id));
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={win} onChange={(e) => setWin(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Due within">
          <option value={0}>Overdue only</option><option value={30}>Due within 30 days</option><option value={60}>Due within 60 days</option><option value={90}>Due within 90 days</option>
        </select>
        {/* A177: address labels for the chosen people (or everyone listed). */}
        <MailingLabelsButton ids={(selected.length ? people.filter(picked) : people).map((g) => g.patient_id)} source="recall" label={selected.length ? 'Labels for selected' : 'Mailing labels'} />
        {w && (
          <div className="inline">
            <button onClick={() => setSelected(selected.length === allIds.length ? [] : allIds)}>{selected.length && selected.length === allIds.length ? 'Clear' : 'Select all'}</button>
            <button className="primary" disabled={!selected.length} onClick={campaign}>Text/email {people.filter(picked).length || ''} selected</button>
          </div>
        )}
      </div>
      {notice && <div className="public-notice ok" style={{ marginBottom: 12 }}>{notice}</div>}
      {people.length > 0 && <div className="muted kb-hint"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>L</kbd> log a call · <kbd>B</kbd> book</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="unconf-table recall-list">
            <thead><tr><th aria-label="Select" /><th>Patient</th><th>Due for</th><th>Due</th><th>Phone</th><th>Status</th><th /></tr></thead>
            <tbody>
              {people.map((g, i) => (
                <Fragment key={g.patient_id}>
                  <tr className={i === cur ? 'kb-row' : ''} aria-selected={i === cur} onClick={() => setCur(i)} data-patient-id={g.patient_id}>
                    <td><input type="checkbox" style={{ width: 'auto' }} aria-label={`Select ${g.first_name} ${g.last_name}`} checked={picked(g)} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...g.ids])] : selected.filter((x) => !g.ids.includes(x)))} /></td>
                    <td><Link to={`/patients/${g.patient_id}`}>{g.first_name} {g.last_name}</Link></td>
                    <td>
                      <span className="recall-chips">
                        {g.items.map((r) => (
                          <span key={r.id} className="badge recall-chip" title={`${label(r.type)} due ${fmtDate(r.due_date)}`}>
                            {label(r.type)}
                            {w && <button type="button" className="recall-chip-x" aria-label={`Stop recalling ${g.first_name} for ${label(r.type)}`} title="Inactive — stop recalling this" onClick={(e) => { e.stopPropagation(); api.put(`/recalls/${r.id}`, { status: 'inactive' }).then(reload); }}>×</button>}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td style={{ color: g.due < today ? 'var(--danger)' : undefined }}>{fmtDate(g.due)}{g.due < today ? ' · overdue' : ''}</td>
                    <td>{g.phone ? <a href={`tel:${g.phone}`}>{g.phone}</a> : '—'}</td>
                    <td><Badge value={g.status} />{g.last_contacted_at && <div className="muted" style={{ fontSize: 11 }}>contacted {fmtDate(g.last_contacted_at)}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {can('patients:write') && <button className="small" onClick={() => { setCur(i); setLogFor(g); }} title="L">Log call</button>}{' '}
                      {w && <button className="small primary" onClick={() => { setCur(i); book(g); }} title="B">Book</button>}
                    </td>
                  </tr>
                  {logFor?.patient_id === g.patient_id && (
                    <LogCallRow colSpan={7} kind="recall" target={{ patient_id: g.patient_id, name: `${g.first_name} ${g.last_name}` }} extra={{ recall_ids: g.items.filter((r) => r.status === 'due').map((r) => r.id) }}
                      onDone={() => { setLogFor(null); reload(); }} />
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {recalls?.length === 0 && <div className="empty">Nobody is due. 🎉</div>}
          {recalls && <MoreRows shown={recalls.length} total={recalls.total} onMore={(n) => setLimit(limit + n)} />}
        </div>
      </div>
      {bookFor && <BookModal {...bookFor} onDone={() => { setBookFor(null); reload(); }} />}
    </>
  );
}

// Books the patient straight from a list: their planned procedures can be attached in the form.
function BookModal({ patient, date, defaults = {}, onDone }) {
  return (
    <SidePanel className="book-panel" title={`Book ${patient.first_name} ${patient.last_name}`} onClose={() => onDone(null)}>
      <AppointmentForm patient={patient} defaults={{ date, ...defaults }} onCancel={() => onDone(null)} onSaved={onDone} />
    </SidePanel>
  );
}

function CallList({ kind, rows, onChange }) {
  const { can, practice } = useAuth();
  const [logFor, setLogFor] = useState(null);
  const [bookFor, setBookFor] = useState(null);
  const [hidden, setHidden] = useState([]);
  if (!rows) return <div className="empty">Loading…</div>;
  const shown = rows.filter((r) => !hidden.includes(r.patient_id));
  const total = shown.reduce((s, r) => s + (kind === 'unscheduled' ? r.amount : r.planned_amount), 0);
  return (
    <>
      <div className="muted" style={{ marginBottom: 8 }}>{shown.length} patients · {money(total)} in {kind === 'unscheduled' ? 'diagnosed, unscheduled treatment' : 'planned treatment'}</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              {kind === 'unscheduled'
                ? <tr><th>Patient</th><th>Treatment</th><th className="num">Value</th><th>Planned</th><th>Last contact</th><th /></tr>
                : <tr><th>Patient</th><th>Missed</th><th>What happened</th><th className="num">Planned tx</th><th>Last contact</th><th /></tr>}
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={`${r.patient_id}-${r.id || ''}`}>
                <tr>
                  <td><Link to={`/patients/${r.patient_id}`}><strong>{r.first_name} {r.last_name}</strong></Link><div className="muted">{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : r.email || 'no phone'}</div></td>
                  {kind === 'unscheduled' ? (
                    <>
                      <td style={{ maxWidth: 280 }}>{r.summary}{r.accepted ? <span className="badge ok" style={{ marginLeft: 6 }}>Accepted</span> : null}</td>
                      <td className="num">{money(r.amount)}</td>
                      <td>{fmtDate(r.planned_since)}</td>
                    </>
                  ) : (
                    <>
                      <td>{fmtDateTime(r.start_time)}<div className="muted">{r.reason} · {r.provider_name}</div></td>
                      <td><Badge value={r.status} />{r.broken_reason && <div className="muted" style={{ fontSize: 12 }}>{brokenLabel(r.broken_reason)}{r.broken_note ? ` — ${r.broken_note}` : ''}</div>}</td>
                      <td className="num">{r.planned_amount ? money(r.planned_amount) : '—'}</td>
                    </>
                  )}
                  <td>{r.last_contact ? <><div>{outcomeLabel(r.last_contact.outcome)}</div><div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.last_contact.created_at)}</div></> : <span className="muted">Never</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {can('patients:write') && <button className="small" onClick={() => setLogFor({ patient_id: r.patient_id, name: `${r.first_name} ${r.last_name}` })}>Log call</button>}{' '}
                    {can('schedule:write') && (
                      // A broken visit rebooks as the same kind of visit, with the same provider and length.
                      <button className="small primary" onClick={() => setBookFor({
                        patient: { id: r.patient_id, first_name: r.first_name, last_name: r.last_name }, date: practiceToday(practice?.timezone),
                        defaults: kind === 'broken' ? { appointment_type_id: r.appointment_type_id || undefined, provider_id: r.provider_id, ...(r.end_time ? { duration: minutesBetween(r.start_time, r.end_time) } : {}) } : {},
                      })}>{kind === 'broken' ? 'Rebook' : 'Book'}</button>
                    )}
                  </td>
                </tr>
                {logFor?.patient_id === r.patient_id && (
                  <LogCallRow colSpan={6} kind={kind} target={logFor} onDone={(outcome) => { setLogFor(null); if (outcome === 'declined') setHidden([...hidden, r.patient_id]); if (outcome) onChange?.(); }} />
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">List is clear. 🎉</div>}
        </div>
      </div>
      {bookFor && <BookModal {...bookFor} onDone={(saved) => { setBookFor(null); if (saved) { setHidden([...hidden, bookFor.patient.id]); onChange?.(); } }} />}
    </>
  );
}

// Logging a call from a list (A051, A057): a row that opens right under the patient — not a dialog. How it went is
// one key (1–8; "Left voicemail" is already picked), a note is optional, Enter saves, Esc closes. The team sees the
// last contact on the list; the history of earlier calls is right there.
function LogCallRow({ colSpan, kind, target, extra = {}, onDone }) {
  const [outcome, setOutcome] = useState('left_voicemail');
  const [note, setNote] = useState('');
  const box = useRef(null);
  const { data: history } = useApi(`/patients/${target.patient_id}/followups`);
  useEffect(() => { box.current?.querySelector('.logcall-save')?.focus(); }, []);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${target.patient_id}/followups`, { kind, outcome, note, ...extra });
    onDone(outcome);
  });
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null); return; }
    if (e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) submit(); }
      return;
    }
    if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); setOutcome(OUTCOMES[Number(e.key) - 1][0]); }
  };
  return (
    <tr className="logcall-row-inline">
      <td colSpan={colSpan}>
        <div ref={box} className="logcall-inline" role="group" aria-label={`Log contact — ${target.name}`} onKeyDown={keys}>
          <ErrorBox error={error} />
          <div className="chips" role="radiogroup" aria-label="How it went">
            {OUTCOMES.map(([v, l], i) => <button key={v} type="button" role="radio" aria-checked={outcome === v} className={`chip${outcome === v ? ' active' : ''}`} onClick={() => setOutcome(v)}>{l} <kbd>{i + 1}</kbd></button>)}
          </div>
          <div className="inline" style={{ alignItems: 'flex-end', gap: 8 }}>
            <textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Call note" style={{ flex: 1 }} />
            <button type="button" className="primary logcall-save" disabled={busy} onClick={submit}>Save <kbd>Enter</kbd></button>
            <button type="button" onClick={() => onDone(null)}>Cancel <kbd>Esc</kbd></button>
          </div>
          {history?.length > 0 && (
            <div className="muted logcall-history">
              {history.slice(0, 3).map((f) => <div key={f.id}>{fmtDateTime(f.created_at)} · {label(f.kind)} · {outcomeLabel(f.outcome)}{f.note ? ` — ${f.note}` : ''} · {f.created_by_name}</div>)}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
