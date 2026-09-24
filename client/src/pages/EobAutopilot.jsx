import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken, ApiError } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { money, fmtDate, toCents } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox, PatientPicker } from '../components/ui.jsx';
import './eobautopilot.css';

// Insurance autopilot (backlog A1–A5, docs/eob-autopilot.md): ERAs and paper EOBs post themselves when they
// reconcile exactly; this screen is only the exceptions — one list, J/K to move, one key per decision — plus
// the paper EOB scanner, patient billing, the daily reconciliation and the owner's switches.
const TABS = [['work', 'Worklist'], ['paper', 'Paper EOB'], ['billing', 'Billing patients'], ['recon', 'Reconciliation'], ['settings', 'Settings']];

export default function EobAutopilot() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'work';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'work') n.delete('tab'); else n.set('tab', t); return n; });
  useCommands(TABS.map(([k, label]) => ({ id: `eob-${k}`, label: `Insurance autopilot: ${label}`, run: () => setTab(k) })));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Insurance autopilot</h1>
          <div className="muted">Insurance payments post themselves when every cent adds up. You only see what needs a person.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'work' && <Worklist />}
      {tab === 'paper' && <PaperEob />}
      {tab === 'billing' && <Billing />}
      {tab === 'recon' && <Reconciliation />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

// ---- The worklist ----
function Worklist() {
  const { data, error, reload } = useApi('/eob-autopilot');
  const { can } = useAuth();
  const navigate = useNavigate();
  useLiveEvents((e) => e.type === 'eob' && reload());
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [asking, setAsking] = useState(null); // 'dismiss' (a note) or 'match' (a claim)
  const [note, setNote] = useState('');
  const [detail, setDetail] = useState(null);
  const noteRef = useRef(null);
  const rows = useRef([]);
  const items = useMemo(() => (data?.items || []).filter((i) => i.kind !== 'ready'), [data]);
  const ready = useMemo(() => (data?.items || []).filter((i) => i.kind === 'ready'), [data]);
  const cur = items[Math.min(at, Math.max(0, items.length - 1))];
  const write = can('billing:write');
  useEffect(() => { rows.current[at]?.scrollIntoView?.({ block: 'nearest' }); }, [at]);
  useEffect(() => {
    setAsking(null);
    setNote('');
    setDetail(null);
    if (cur?.kind === 'unmatched') api.get(`/eob-autopilot/lines/${cur.id}`).then(setDetail).catch(() => setDetail(null));
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, done) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      toast(done);
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const act = (action, extra = {}) => {
    if (!cur || !write || busy) return;
    const a = cur.actions.find((x) => x.action === action);
    if (!a) return;
    if (action === 'dismiss' && !extra.note) { setAsking('dismiss'); setTimeout(() => noteRef.current?.focus(), 0); return; }
    if (action === 'match' && !extra.claim_id) { setAsking('match'); return; }
    if (action === 'send_secondary') return sendSecondary(cur);
    const who = cur.patient || 'this line';
    const words = { post: `Posted ${who}`, bill_patient: `${who}: billed to the patient`, resend: `Task made to correct and resend claim #${cur.claim_id}`, appeal: `Task made to appeal claim #${cur.claim_id}`, refund: 'Refund task made', match: 'Matched', reverse: `Payment reversed — claim #${cur.claim_id} is open again`, dismiss: 'Set aside' };
    run(() => api.post(`/eob-autopilot/lines/${cur.id}/${action}`, extra), words[action] || 'Done');
  };
  // One key: attach the primary's EOB (paper) and send the secondary through the usual path.
  const sendSecondary = (it) => run(async () => {
    const prep = await api.post(`/eob-autopilot/claims/${it.claim_id}/send-secondary`);
    if (prep.send_via === 'clearinghouse') await api.post('/claims/submit', { claim_ids: [it.claim_id] });
    else await api.post(`/claims/${it.claim_id}/submit`);
  }, `Secondary claim #${it.claim_id} sent`);
  const postAll = () => write && ready.length && run(() => api.post('/eob-autopilot/post-ready', {}), `Posted ${ready.length} clean payment${ready.length === 1 ? '' : 's'}`);
  const move = (d) => setAt((i) => Math.max(0, Math.min(items.length - 1, i + d)));
  const keys = [
    { combo: 'j', handler: () => move(1), label: 'Next item', section: 'Insurance autopilot' },
    { combo: 'k', handler: () => move(-1), label: 'Previous item', section: 'Insurance autopilot' },
    { combo: 'enter', handler: () => cur?.claim_id && navigate(`/claims/${cur.claim_id}`), label: 'Open the claim', section: 'Insurance autopilot', enabled: !!cur?.claim_id },
    { combo: 'shift+p', handler: postAll, label: 'Post all clean payments', section: 'Insurance autopilot', enabled: ready.length > 0 },
    ...(cur?.actions || []).map((a) => ({ combo: a.key, handler: () => act(a.action), label: a.label, section: 'Insurance autopilot', enabled: write })),
  ];
  useShortcuts(keys);

  return (
    <div className="eob-work">
      <ErrorBox error={error || err} />
      {ready.length > 0 && (
        <div className="card eob-ready">
          <div><strong>{ready.length} payment{ready.length === 1 ? '' : 's'} add up exactly</strong> <span className="muted">— {money(ready.reduce((s, i) => s + i.amounts.paid, 0))} ready to post{data?.settings?.autopost ? '' : ' (turn on auto-posting in Settings and these post themselves)'}</span></div>
          {write && <button className="primary" disabled={busy} onClick={postAll}>Post all <kbd>Shift</kbd>+<kbd>P</kbd></button>}
        </div>
      )}
      {data?.paper_waiting > 0 && <div className="card"><Link to="?tab=paper">{data.paper_waiting} paper EOB{data.paper_waiting === 1 ? '' : 's'} read and waiting for your “looks right” →</Link></div>}
      {data && (
        <div className="eob-counts">
          {Object.entries(data.counts || {}).filter(([k]) => k !== 'ready').map(([k, n]) => <span key={k} className={`eob-chip eob-${k}`}>{data.kinds[k]} {n}</span>)}
        </div>
      )}
      {data && items.length === 0 && <div className="card muted">Nothing needs a person. Clean payments post on their own; anything unusual shows up here.</div>}
      {items.length > 0 && (
        <div className="eob-split">
          <div className="card eob-list" role="listbox" aria-label="Insurance exceptions">
            <div className="eob-keys"><span><kbd>J</kbd>/<kbd>K</kbd> move</span><span><kbd>Enter</kbd> open claim</span><span>one key per action</span></div>
            {items.map((it, i) => (
              <div key={it.key} ref={(el) => { rows.current[i] = el; }} role="option" aria-selected={it === cur} className={`eob-item${it === cur ? ' current' : ''}`} onClick={() => setAt(i)}>
                <span className={`eob-chip eob-${it.kind}`}>{it.kind_label}</span>
                <div>
                  <strong>{it.patient || it.control_number || 'Unknown'}</strong>
                  <span className="muted"> · {it.payer || 'Payer'}{it.claim_id ? ` · claim #${it.claim_id}` : ''}</span>
                  <div className="muted eob-reason">{it.reason}</div>
                </div>
                <div className="eob-amt">{it.amounts.paid != null ? money(it.amounts.paid) : money(it.amounts.billed)}</div>
              </div>
            ))}
          </div>
          {cur && (
            <aside className="card eob-panel" aria-label="Selected item">
              <div className="eob-panel-head">
                <span className={`eob-chip eob-${cur.kind}`}>{cur.kind_label}</span>
                {cur.patient_id && <Link to={`/patients/${cur.patient_id}`}>{cur.patient}</Link>}
                {cur.claim_id && <Link to={`/claims/${cur.claim_id}`}>Claim #{cur.claim_id}</Link>}
              </div>
              <p className="eob-why">{cur.reason}</p>
              {cur.reasons?.length > 0 && <ul className="eob-codes">{cur.reasons.map((r) => <li key={r.code}><code>{r.code}</code> {r.text || ''}</li>)}</ul>}
              <table className="eob-amounts"><tbody>
                {[['Billed', cur.amounts.billed], ['Insurance paid', cur.amounts.paid], ['Contractual write-off', cur.amounts.write_off], ['Other adjustments', cur.amounts.other], ['Patient owes (per payer)', cur.amounts.patient], ['PPO fee schedule allows', cur.amounts.expected_allowed], ['Expected from secondary', cur.amounts.expected]]
                  .filter(([, v]) => v != null && v !== 0).map(([k, v]) => <tr key={k}><td>{k}</td><td>{money(v)}</td></tr>)}
              </tbody></table>
              <div className="muted" style={{ fontSize: 12 }}>{cur.source === 'paper' ? 'Paper EOB' : cur.source === 'era' ? 'ERA' : ''}{cur.trace ? ` ${cur.trace}` : ''}{cur.paper_eob_id ? <> · <a href={`/api/eob-autopilot/paper/${cur.paper_eob_id}/file`} onClick={(e) => { e.preventDefault(); openEob(cur.paper_eob_id); }}>see the EOB</a></> : null}</div>
              {write && (
                <div className="eob-actions">
                  {cur.actions.map((a) => (
                    <button key={a.action} className={a === cur.actions[0] ? 'primary' : ''} disabled={busy} onClick={() => act(a.action)}>{a.label} <kbd>{a.key.toUpperCase()}</kbd></button>
                  ))}
                </div>
              )}
              {asking === 'dismiss' && (
                <form className="eob-ask" onSubmit={(e) => { e.preventDefault(); if (note.trim()) act('dismiss', { note: note.trim() }); }}>
                  <input ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why there’s nothing to do (e.g. not our patient)" aria-label="Why" />
                  <button className="primary" disabled={!note.trim() || busy}>Set aside</button>
                </form>
              )}
              {asking === 'match' && (
                <div className="eob-ask">
                  <div className="muted" style={{ fontSize: 13 }}>Which claim is it? Same amount first.</div>
                  {(detail?.candidates || []).map((c) => (
                    <button key={c.id} className="eob-cand" disabled={busy} onClick={() => act('match', { claim_id: c.id })}>#{c.id} {c.first_name} {c.last_name} · {money(c.total_fee)}</button>
                  ))}
                  {detail && !detail.candidates?.length && <div className="muted">No open claims to match.</div>}
                </div>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

// The EOB file (it can list other patients, so it's opened for billing staff only, and the view is recorded).
async function openEob(id) {
  const res = await fetch(`/api/eob-autopilot/paper/${id}/file`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return toast('Couldn’t open the EOB', { tone: 'error' });
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
}

// ---- Paper EOBs: scan, PDF or a phone photo ----
// Photos are shrunk in the browser (a few hundred KB is plenty to read) and always sent as JPEG.
async function shrink(file) {
  if (file.type === 'application/pdf') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
}
function PaperEob() {
  const { can } = useAuth();
  const list = useApi('/eob-autopilot/paper');
  const [eob, setEob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const input = useRef(null);
  const send = async (file) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await shrink(file);
      const res = await fetch(`/api/eob-autopilot/paper?filename=${encodeURIComponent(file.name || 'eob.jpg')}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data.error || 'Couldn’t read that EOB');
      setEob(data);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const post = async () => {
    if (!eob || busy) return;
    setBusy(true);
    try {
      const out = await api.post(`/eob-autopilot/paper/${eob.id}/post`);
      setEob(out);
      toast(`Posted ${out.posted ?? 0} payment${out.posted === 1 ? '' : 's'}${out.exceptions ? ` — ${out.exceptions} left on the worklist` : ''}`);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  useShortcuts([{ combo: 'enter', handler: post, label: 'Looks right — post', section: 'Paper EOB', enabled: !!eob && eob.status === 'read' && eob.clean > 0 }]);
  return (
    <div className="eob-paper">
      <div className="card eob-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); send(e.dataTransfer.files[0]); }}>
        <p><strong>Scan or photograph the EOB</strong> — the desk scanner&apos;s PDF, or a phone or iPad photo. The AI reads every claim on it; nothing posts until you say it looks right.</p>
        <input ref={input} type="file" accept="application/pdf,image/*" capture="environment" hidden onChange={(e) => send(e.target.files[0])} />
        {can('billing:write') && <button className="primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : 'Choose a file or take a photo'}</button>}
      </div>
      <ErrorBox error={err} />
      {eob && (
        <div className="card">
          <div className="eob-panel-head">
            <strong>{eob.payer_name || 'EOB'}</strong><span className="muted">{eob.check_number ? `check ${eob.check_number}` : ''} {eob.check_date ? fmtDate(eob.check_date) : ''} · {money(eob.total_paid)}</span>
            {eob.duplicate && <span className="badge">already uploaded</span>}
            <a href="#eob" onClick={(e) => { e.preventDefault(); openEob(eob.id); }}>see the EOB</a>
          </div>
          <table className="eob-table"><thead><tr><th>Patient</th><th>Claim</th><th>Billed</th><th>Paid</th><th>Write-off</th><th>Patient</th><th /></tr></thead>
            <tbody>{eob.lines.map((l) => (
              <tr key={l.id} className={l.state === 'exception' ? 'eob-row-ex' : ''}>
                <td>{l.patient || l.control_number || '—'}</td><td>{l.claim_id ? <Link to={`/claims/${l.claim_id}`}>#{l.claim_id}</Link> : '—'}</td>
                <td>{money(l.billed)}</td><td>{money(l.paid)}</td><td>{money(l.contractual)}</td><td>{money(l.patient_resp)}</td>
                <td>{l.state === 'ready' ? '✓ adds up' : l.state === 'posted' ? 'Posted' : l.state === 'resolved' ? 'Done' : l.reason}</td>
              </tr>
            ))}</tbody></table>
          {eob.status === 'read' && can('billing:write') && (
            <div className="eob-actions">
              <button className="primary" disabled={busy || !eob.clean} onClick={post}>Looks right — post {eob.clean} <kbd>Enter</kbd></button>
              {eob.exceptions > 0 && <span className="muted">{eob.exceptions} need a look — they go to the worklist.</span>}
            </div>
          )}
          {eob.status === 'posted' && <div className="muted">Posted{eob.approved_at ? ` ${fmtDate(eob.approved_at.slice(0, 10))}` : ''}.</div>}
        </div>
      )}
      <div className="card table-wrap">
        <table><thead><tr><th>Uploaded</th><th>Payer</th><th>Check</th><th>Amount</th><th>Status</th><th>Waiting</th></tr></thead>
          <tbody>{(list.data || []).map((p) => (
            <tr key={p.id} onClick={() => api.get(`/eob-autopilot/paper/${p.id}`).then(setEob)} style={{ cursor: 'pointer' }}>
              <td>{fmtDate(p.created_at.slice(0, 10))}</td><td>{p.payer_name || '—'}</td><td>{p.check_number || '—'}</td><td>{money(p.total_paid)}</td>
              <td>{p.status === 'posted' ? `Posted by ${p.approved_by_name || '—'}` : 'Read — not posted yet'}</td><td>{p.ready ? `${p.ready} to post` : ''}{p.exceptions ? ` ${p.exceptions} to look at` : ''}</td>
            </tr>
          ))}</tbody></table>
      </div>
    </div>
  );
}

// ---- Billing the patient (A4) ----
const BILL_WORDS = { active: 'Being billed', paid: 'Paid', stopped: 'Stopped', done: 'Finished', skipped: 'Not billed', merged: 'Joined an open bill' };
function Billing() {
  const { data, error, reload } = useApi('/eob-autopilot/billing');
  useLiveEvents((e) => e.type === 'eob' && reload());
  const { can } = useAuth();
  const [holding, setHolding] = useState(null); // { patient, note } while adding someone to the hold list
  const release = async (h) => { await api.post(`/cadence/holds/${h.id}/release`).catch((e) => toast(e.message, { tone: 'error' })); toast(`${h.first_name} is off the hold list`); reload(); };
  const hold = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/cadence/patients/${holding.patient.id}/holds`, { reason: 'other', type: 'patient_balance', note: holding.note.trim() });
      toast(`${holding.patient.first_name} won’t be billed automatically`);
      setHolding(null);
      reload();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  };
  const s = data?.settings;
  return (
    <>
      <ErrorBox error={error} />
      {s && (
        <div className="card muted">
          {s.billing
            ? <>When a claim closes and at least {money(s.min_balance)} is left, the patient gets a text or email with a pay link {s.wait_days} day{s.wait_days === 1 ? '' : 's'} later, reminders after 7 and 14 days, and a paper statement after {s.paper_days} days if the link wasn&apos;t opened. Payment plans charge as agreed.</>
            : <>Billing patients automatically is off. An administrator turns it on in Settings.</>}
        </div>
      )}
      <div className="card">
        <div className="eob-panel-head">
          <h3 style={{ margin: 0 }}>Held — not billed automatically</h3>
          {can('patients:write') && !holding && <button className="small" onClick={() => setHolding({ patient: null, note: '' })}>Hold a patient</button>}
        </div>
        {holding && (
          <form className="eob-ask" onSubmit={hold}>
            <PatientPicker value={holding.patient} onChange={(p) => setHolding({ ...holding, patient: p })} />
            <input value={holding.note} onChange={(e) => setHolding({ ...holding, note: e.target.value })} placeholder="Why (e.g. the owner is talking to them)" aria-label="Why hold" />
            <button className="primary" disabled={!holding.patient || !holding.note.trim()}>Hold</button>
            <button type="button" onClick={() => setHolding(null)}>Cancel</button>
          </form>
        )}
        {(data?.holds || []).map((h) => <div key={h.id} className="inline" style={{ gap: 8 }}><Link to={`/patients/${h.patient_id}`}>{h.first_name} {h.last_name}</Link><span className="muted">{h.note}</span>{can('patients:write') && <button className="small" onClick={() => release(h)}>Release</button>}</div>)}
        {data && !data.holds.length && !holding && <div className="muted">Nobody is held.</div>}
      </div>
      <div className="card table-wrap">
        <table><thead><tr><th>Account</th><th>Claim</th><th>Started</th><th>Owed then</th><th>Owes now</th><th>Sent</th><th>Paper</th><th>Status</th></tr></thead>
          <tbody>{(data?.bills || []).map((b) => (
            <tr key={b.id}>
              <td><Link to={`/patients/${b.patient_id}`}>{b.first_name} {b.last_name}</Link></td><td><Link to={`/claims/${b.claim_id}`}>#{b.claim_id}</Link></td>
              <td>{fmtDate(b.anchor_date)}</td><td>{money(b.amount)}</td><td>{b.owes_now != null ? money(b.owes_now) : ''}</td>
              <td>{(b.sends || []).filter((r) => r.status === 'sent').map((r) => `${r.channel} ${fmtDate(r.due_date)}`).join(', ')}{b.link_opened_at ? ' · link opened' : ''}</td>
              <td>{b.paper_status || ''}</td><td>{BILL_WORDS[b.status] || b.status}{b.stop_reason && b.status !== 'active' ? ` (${String(b.stop_reason).replace(/_/g, ' ')})` : ''}</td>
            </tr>
          ))}</tbody></table>
        {data && !data.bills.length && <div className="muted">No balances billed yet.</div>}
      </div>
    </>
  );
}

// ---- Reconciliation (A5) ----
function Reconciliation() {
  const { data, error } = useApi('/eob-autopilot/reconciliation');
  return (
    <>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        <table className="eob-table">
          <thead><tr><th>Day</th><th>From payers</th><th>Posted</th><th>Waiting</th><th>In the bank</th><th>Not in bank</th><th>Claims closed</th><th>Billed</th><th>Paid</th><th>Written off</th><th>Patient part</th><th>Billed to patient</th><th>Gaps</th></tr></thead>
          <tbody>{(data?.days || []).map((d) => (
            <tr key={d.date} className={d.gaps ? 'eob-row-ex' : ''}>
              <td>{fmtDate(d.date)}</td><td>{money(d.remitted)}</td><td>{money(d.posted)}</td><td>{money(d.waiting)}</td><td>{money(d.deposited)}</td><td>{money(d.not_deposited)}</td>
              <td>{d.claims_closed}</td><td>{money(d.billed)}</td><td>{money(d.paid)}</td><td>{money(d.written_off)}</td><td>{money(d.patient_part)}</td><td>{money(d.billed_to_patient)}</td><td>{d.gaps || ''}</td>
            </tr>
          ))}</tbody>
        </table>
        {data && !data.days.length && <div className="muted">No insurance payments in these two weeks.</div>}
      </div>
      {data?.gaps?.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Gaps ({data.gaps.length})</h3>
          <ul>{data.gaps.map((g) => <li key={g.key}>{fmtDate(g.date)} — {g.ref.claim_id ? <Link to={`/claims/${g.ref.claim_id}`}>{g.text}</Link> : g.text}</li>)}</ul>
        </div>
      )}
    </>
  );
}

// ---- The owner's switches ----
function Settings() {
  const { user } = useAuth();
  const { data: s, error, reload } = useApi('/eob-autopilot/settings');
  const { data: p } = useApi('/eob-autopilot/preview?days=30');
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (s) setForm({ min_balance: (s.min_balance / 100).toFixed(2), wait_days: s.wait_days, paper_days: s.paper_days }); }, [s]);
  const admin = user?.role === 'admin';
  const save = async (patch, done) => {
    setErr(null);
    try { await api.put('/eob-autopilot/settings', patch); toast(done); reload(); } catch (e) { setErr(e); }
  };
  if (!s || !form) return <ErrorBox error={error} />;
  return (
    <div className="eob-settings">
      <ErrorBox error={err} />
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Post electronic payments automatically {s.autopost ? <span className="badge ok">On since {fmtDate(s.autopost_since)}</span> : <span className="badge">Off</span>}</h3>
        <p className="muted">Only an ERA where paid + contractual write-off + patient share equals what was billed, for our claim and procedures, with no denial, reversal, over- or underpayment. Everything else waits for a person. Paper EOBs always need a person&apos;s OK.</p>
        {p && (
          <div className="eob-preview">
            Over the last {p.days} days: <strong>{p.would_post}</strong> claim payment{p.would_post === 1 ? '' : 's'} ({money(p.would_post_amount)}) would have posted on their own; <strong>{p.exceptions}</strong> would have waited for a person
            {Object.keys(p.by_kind).length ? ` (${Object.entries(p.by_kind).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}.
            {p.matched_team + p.differed_from_team.length > 0 && <> Where your team posted them, the autopilot&apos;s numbers matched <strong>{p.matched_team}</strong> of {p.matched_team + p.differed_from_team.length}.</>}
          </div>
        )}
        {admin && (s.autopost
          ? <button onClick={() => save({ autopost: false }, 'Auto-posting is off')}>Turn off</button>
          : <button className="primary" onClick={() => save({ autopost: true }, 'Auto-posting is on')}>Turn on auto-posting</button>)}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Bill patients automatically after insurance {s.billing ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</h3>
        <form className="eob-form" onSubmit={(e) => { e.preventDefault(); save({ min_balance: toCents(form.min_balance), wait_days: Number(form.wait_days), paper_days: Number(form.paper_days) }, 'Billing rules saved'); }}>
          <label>Smallest balance to bill ($)<input inputMode="decimal" value={form.min_balance} disabled={!admin} onChange={(e) => setForm({ ...form, min_balance: e.target.value })} /></label>
          <label>Days to wait after the claim closes<input type="number" min="0" max="60" value={form.wait_days} disabled={!admin} onChange={(e) => setForm({ ...form, wait_days: e.target.value })} /></label>
          <label>Mail paper if the link isn&apos;t opened after (days)<input type="number" min="3" max="90" value={form.paper_days} disabled={!admin} onChange={(e) => setForm({ ...form, paper_days: e.target.value })} /></label>
          {admin && <button>Save rules</button>}
        </form>
        <p className="muted">Hold a patient on the Billing patients tab. Patients on a payment plan are never billed this way — their autopay charges as agreed.</p>
        {admin && (s.billing
          ? <button onClick={() => save({ billing: false }, 'Automatic billing is off')}>Turn off</button>
          : <button className="primary" onClick={() => save({ billing: true }, 'Automatic billing is on')}>Turn on automatic billing</button>)}
      </div>
    </div>
  );
}
