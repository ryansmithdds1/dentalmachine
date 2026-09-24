import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { describeResponses } from '../ClaimEdi.jsx';
import '../../pages/monthly.css';

// Billing → Ready to approve (workflow 24, docs/workflows/specs/24-claims.md). Claims for finished work are prepared
// and checked by themselves; nothing goes to a payer until a person approves it here.
// J/K move · A or Enter approves the selected claim (made and sent in one step) · S skips it with a reason.
// "Approve all ready" asks once, on one line with the count and total, because a sent claim can't be unsent.
// Claims that need a fix show it right under the row: attach the x-ray the chart already has, add a narrative,
// or open the screen where the missing detail lives.
export default function ClaimApprovalQueue({ onCount }) {
  const { can, user } = useAuth();
  const [view, setView] = useState('ready');
  const { data, error, reload } = useApi(view === 'skipped' ? '/claim-queue?view=skipped' : '/claim-queue', [view]);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [skipFor, setSkipFor] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const inFlight = useRef(false);
  const w = can('billing:write');
  const groups = data?.groups || [];
  const cur = groups[Math.min(at, groups.length - 1)] || null;
  useEffect(() => { if (data && view === 'ready') onCount?.(groups.length); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (d) => { setSkipFor(null); setAt((i) => Math.max(0, Math.min(groups.length - 1, i + d))); };
  const refresh = () => { setErr(null); reload(); };

  // One key: the claim is made and sent. A second press while the first is in flight does nothing; a retry
  // after that gets the same claim back from the server (never a second one).
  const approve = async (g, overrideReason = null) => {
    if (!g || inFlight.current) return;
    if (g.status !== 'ready' && !overrideReason) {
      setErr(new Error(`${g.patient_name}: ${g.fixes[0]?.message || 'needs a fix first'} — fix it below${g.can_override ? ', or approve anyway with a reason' : ''}.`));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/claim-queue/approve', { key: g.key, ...(overrideReason ? { override_reason: overrideReason } : {}) });
      if (r.file) await downloadFile(r.file);
      const what = `Claim #${r.claim.id} (${money(r.claim.total_fee)}) for ${g.patient_name}`;
      if (r.already) toast(`${what} was already approved — nothing new was made.`);
      else if (r.sent) toast(`${what} ${r.file ? 'saved in an 837 file to upload in your clearinghouse portal' : `sent to ${g.carrier_name}${r.via ? ` through ${r.via}` : ''}`}.${r.via ? describeResponses(r) : ''}`, { ms: 7000 });
      else toast(`${what} was made but not sent: ${r.error || 'it needs a look'}. It’s under Billing → Claims → Ready to send.`, { tone: 'error', ms: 12000 });
      reload();
    } catch (x) {
      setErr(x);
      if (x.status === 409 || x.status === 404) reload();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const approveAll = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/claim-queue/approve-all', { expected_count: data.ready_count, expected_total: data.ready_total });
      if (r.file) await downloadFile(r.file);
      toast(`${r.sent} of ${r.approved} claim${r.approved === 1 ? '' : 's'} ${r.file ? 'saved in one 837 file to upload' : 'sent'}${r.failures.length ? ` — ${r.failures.length} need a look (listed under Needs attention)` : ''}.`, { tone: r.failures.length ? 'error' : 'ok', ms: 9000 });
      setConfirmAll(false);
      reload();
    } catch (x) {
      setErr(x);
      setConfirmAll(false);
      reload();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next claim', section: 'Ready to approve', enabled: view === 'ready' },
    { combo: 'k', handler: () => move(-1), label: 'Previous claim', section: 'Ready to approve', enabled: view === 'ready' },
    { combo: 'a', handler: () => approve(cur), label: 'Approve and send the selected claim', section: 'Ready to approve', enabled: w && !!cur && view === 'ready' && !confirmAll },
    { combo: 'enter', handler: () => (confirmAll ? approveAll() : approve(cur)), label: 'Approve and send the selected claim', section: 'Ready to approve', enabled: w && view === 'ready' && (!!cur || confirmAll) && !skipFor },
    { combo: 's', handler: () => cur && setSkipFor(cur.key), label: 'Skip the selected claim for now (with a reason)', section: 'Ready to approve', enabled: w && !!cur && view === 'ready' },
    { combo: 'escape', handler: () => { setSkipFor(null); setConfirmAll(false); }, label: 'Cancel', section: 'Ready to approve', enabled: !!skipFor || confirmAll, inInputs: true },
  ]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Preparing claims…</div>;
  const tabs = (
    <div className="tabs" style={{ borderBottom: 'none', marginBottom: 8 }}>
      <button className={view === 'ready' ? 'active' : ''} onClick={() => setView('ready')}>To approve</button>
      <button className={view === 'skipped' ? 'active' : ''} onClick={() => setView('skipped')}>Skipped</button>
    </div>
  );
  if (view === 'skipped') return <>{tabs}<Skipped rows={data.skipped || []} w={w} onDone={reload} /></>;
  const needFix = groups.length - (data.ready_count || 0);
  return (
    <>
      {tabs}
      {!data.enabled && (
        <div className="card" style={{ marginBottom: 12 }}>
          Preparing claims for approval is turned off, so nothing is listed here. Claims are made from each patient’s Insurance tab (B).
          {user.role === 'admin' && <PrepSetting enabled={false} onChange={reload} />}
        </div>
      )}
      {data.enabled && (
        <div className="card inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <strong>{data.ready_count}</strong> ready ({money(data.ready_total)}){needFix > 0 && <> · <strong>{needFix}</strong> need a fix</>}
            <div className="muted" style={{ fontSize: 12 }}>Prepared from finished work and checked like a claim before it’s sent. Nothing goes to a payer until you approve it · {data.clearinghouse.batch ? `sends through ${data.clearinghouse.name}` : 'saved as an 837 file to upload (no clearinghouse connected)'}</div>
          </div>
          <div className="inline">
            <span className="muted" style={{ fontSize: 12 }}><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> approve · <kbd>S</kbd> skip</span>
            {w && data.ready_count > 0 && !confirmAll && <button disabled={busy} onClick={() => setConfirmAll(true)}>Approve all {data.ready_count} ready…</button>}
          </div>
        </div>
      )}
      {confirmAll && (
        <div className="card inline" role="alert" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12, borderColor: 'var(--warn)' }}>
          <span>Send <strong>{data.ready_count} claim{data.ready_count === 1 ? '' : 's'}</strong> for <strong>{money(data.ready_total)}</strong> to the payers? A sent claim can’t be unsent.</span>
          <span className="inline">
            <button onClick={() => setConfirmAll(false)}>Cancel</button>
            <button className="primary" autoFocus disabled={busy} onClick={approveAll}>{busy ? 'Sending…' : `Send ${data.ready_count} claim${data.ready_count === 1 ? '' : 's'}`}</button>
          </span>
        </div>
      )}
      <ErrorBox error={err} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Patient</th><th>Insurance</th><th>Work</th><th>Date of service</th><th>Status</th><th className="num">Billed</th><th className="num">Insurance est.</th><th className="no-print" /></tr></thead>
            <tbody>
              {groups.map((g, i) => (
                <GroupRows key={g.key} g={g} current={g === cur} w={w} busy={busy} skipping={skipFor === g.key}
                  onPick={() => { setAt(i); if (skipFor !== g.key) setSkipFor(null); }} onApprove={(reason) => approve(g, reason)} onChanged={refresh}
                  onSkip={() => { setAt(i); setSkipFor(g.key); }} onSkipDone={() => { setSkipFor(null); reload(); }} onSkipCancel={() => setSkipFor(null)} />
              ))}
            </tbody>
          </table>
          {data.enabled && groups.length === 0 && <div className="empty">Nothing to approve — every finished procedure for an insured patient is on a claim (or skipped).</div>}
          {data.more > 0 && <div className="muted" style={{ padding: 8 }}>{data.more} more patients’ claims will show as these are approved.</div>}
        </div>
      </div>
      {user.role === 'admin' && data.enabled && <PrepSetting enabled onChange={reload} />}
    </>
  );
}

// An 837 file saved by an approval (no clearinghouse connection): downloaded straight away, kept on the server too.
async function downloadFile(file) {
  const res = await fetch(`/api/claim-queue/files/${file.batch_id}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('The claim was saved, but the 837 file didn’t download — try again from Billing → Claims');
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: file.filename }).click();
}

function GroupRows({ g, current, w, busy, skipping, onPick, onApprove, onChanged, onSkip, onSkipDone, onSkipCancel }) {
  const codes = g.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ');
  return (
    <>
      <tr aria-selected={current} className={`wl-row${current ? ' current' : ''}`} onClick={onPick}>
        <td><Link to={`/patients/${g.patient_id}?tab=insurance`} onClick={(e) => e.stopPropagation()}>{g.patient_name}</Link></td>
        <td>{g.carrier_name}{g.priority !== 'primary' && <span className="muted"> ({g.priority})</span>}</td>
        <td>{codes}</td>
        <td>{fmtDate(g.first_service)}</td>
        <td>{g.status === 'ready' ? <span className="badge ok">Ready</span> : <span className="badge warn">Needs a fix</span>}</td>
        <td className="num">{money(g.total_fee)}</td>
        <td className="num">{money(g.est_insurance)}</td>
        <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
          {w && (
            <>
              <button className="small primary" disabled={busy || g.status !== 'ready'} onClick={(e) => { e.stopPropagation(); onApprove(); }}>Approve</button>{' '}
              <button className="small" onClick={(e) => { e.stopPropagation(); onSkip(); }}>Skip…</button>
            </>
          )}
        </td>
      </tr>
      {(current || skipping) && (
        <tr className="wl-detail">
          <td colSpan={8} style={{ background: 'var(--subtle)' }}>
            {skipping && <SkipLine g={g} onDone={onSkipDone} onCancel={onSkipCancel} />}
            {current && <GroupDetail g={g} w={w} busy={busy} onApprove={onApprove} onChanged={onChanged} />}
          </td>
        </tr>
      )}
    </>
  );
}

function SkipLine({ g, onDone, onCancel }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/claim-queue/skip', { key: g.key, reason });
      toast(`Skipped ${g.patient_name}’s claim for now. It’s under Skipped to put back.`);
      onDone();
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <form className="inline" onSubmit={submit} style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
      <ErrorBox error={err} />
      <label style={{ flex: 1, minWidth: 260 }}>Why skip it for now?
        <input autoFocus required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Waiting for the new insurance card" />
      </label>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={!reason.trim()}>Skip for now</button>
    </form>
  );
}

// What's on the claim, what it needs, and the fix right there.
function GroupDetail({ g, w, busy, onApprove, onChanged }) {
  const [narrative, setNarrative] = useState('');
  const [anyway, setAnyway] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (fn) => {
    setErr(null);
    try { await fn(); onChanged(); } catch (x) { setErr(x); }
  };
  const needsFile = g.fixes.some((f) => f.kind === 'xray' || f.kind === 'perio');
  const needsNarrative = g.fixes.some((f) => f.kind === 'narrative' || f.kind === 'risk');
  const suggestions = [...g.suggestions].sort((a, b) => b.preselected - a.preselected);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <ErrorBox error={err} />
      <div className="muted" style={{ fontSize: 13 }}>
        {g.procedures.map((p) => `${p.code} ${p.description}${p.tooth ? ` #${p.tooth}` : ''}${p.surfaces ? ` ${p.surfaces}` : ''} · ${money(p.fee)}${p.provider_name ? ` · ${p.provider_name}` : ''}`).join(' — ')}
      </div>
      {g.fixes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {g.fixes.map((f, i) => (
            <li key={i} className={f.hard ? 'claim-attention' : ''}>
              {f.message}
              {f.link && <> · <Link to={f.link}>{f.link_label}</Link></>}
            </li>
          ))}
        </ul>
      )}
      {g.notes.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Worth knowing: {g.notes.join(' · ')}</div>}
      {w && needsFile && (
        <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
          {suggestions.length ? suggestions.map((s) => (
            <button key={s.key} className={`small${s.preselected ? ' primary' : ''}`} onClick={() => run(() => api.post('/claim-queue/fixes', { key: g.key, ...(s.perio_exam_id ? { perio_exam_id: s.perio_exam_id } : { document_id: s.document_id, report_type: s.report_type }) }))}>
              Attach {s.label}{s.date ? ` (${fmtDate(s.date)})` : ''}
            </button>
          )) : <span className="muted">Nothing suitable is in the chart — take or import the x-ray (<Link to={`/patients/${g.patient_id}?tab=documents`}>Images</Link>), write a narrative, or skip for now.</span>}
        </div>
      )}
      {w && (needsNarrative || needsFile) && (
        <form className="inline" style={{ gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/claim-queue/fixes', { key: g.key, narrative }); setNarrative(''); }); }}>
          <input style={{ flex: 1, minWidth: 260 }} aria-label="Narrative for the payer" placeholder="Narrative for the payer (why this was needed)" maxLength={4000} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          <button className="small" disabled={!narrative.trim()}>Add narrative</button>
        </form>
      )}
      {g.attachments.length > 0 && (
        <div className="inline" style={{ flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
          Goes with the claim:
          {g.attachments.map((a) => (
            <span key={a.id} className="badge info">
              {a.filename || (a.narrative ? `Narrative: ${a.narrative.slice(0, 40)}${a.narrative.length > 40 ? '…' : ''}` : a.report_type)}
              {w && <button className="link" aria-label="Take it off" onClick={() => run(() => api.del(`/claim-queue/fixes/${a.id}`))}>✕</button>}
            </span>
          ))}
        </div>
      )}
      {w && g.status !== 'ready' && g.can_override && (
        anyway === null
          ? <div><button className="small" onClick={() => setAnyway('')}>Approve anyway…</button></div>
          : (
            <form className="inline" style={{ gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); onApprove(anyway.trim()); }}>
              <input autoFocus style={{ flex: 1, minWidth: 260 }} aria-label="Why send it as it is" placeholder="Why send it as it is? (kept with the claim)" maxLength={300} value={anyway} onChange={(e) => setAnyway(e.target.value)} />
              <button type="button" className="small" onClick={() => setAnyway(null)}>Cancel</button>
              <button className="small primary" disabled={busy || !anyway.trim()}>Approve and send</button>
            </form>
          )
      )}
    </div>
  );
}

function Skipped({ rows, w, onDone }) {
  const [err, setErr] = useState(null);
  const putBack = async (s) => {
    try {
      await api.post('/claim-queue/skips/restore', { skip_group: s.skip_group });
      toast(`${s.patient_name}’s claim is back in the list to approve.`);
      onDone();
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <div className="card" style={{ padding: 0 }}>
      <ErrorBox error={err} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Patient</th><th>Work</th><th>Why it was skipped</th><th>Skipped</th><th className="num">Billed</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.skip_group}>
                <td><Link to={`/patients/${s.patient_id}?tab=insurance`}>{s.patient_name}</Link></td>
                <td>{s.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')}</td>
                <td>{s.reason}</td>
                <td>{fmtDate(s.skipped_at)}{s.skipped_by_name ? ` · ${s.skipped_by_name}` : ''}</td>
                <td className="num">{money(s.total_fee)}</td>
                <td>{w && <button className="small" onClick={() => putBack(s)}>Put back</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">Nothing skipped.</div>}
      </div>
    </div>
  );
}

// The practice setting (administrators). Only preparing can be turned off; there's no automatic sending.
function PrepSetting({ enabled, onChange }) {
  const [err, setErr] = useState(null);
  const flip = async (on) => {
    try {
      await api.put('/claim-queue/settings', { enabled: on });
      onChange();
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
      <ErrorBox error={err} />
      <label className="checkbox"><input type="checkbox" checked={enabled} onChange={(e) => flip(e.target.checked)} /> Prepare claims for approval automatically</label>
      <div style={{ fontSize: 12 }}>Claims are only prepared and checked; a person always approves before anything is sent.</div>
    </div>
  );
}
