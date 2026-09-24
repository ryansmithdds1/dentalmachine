import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtUtcDate, toCents, fromCents } from '../format.js';
import { ChStatus, ClaimEdiCard, sendClaims } from '../components/ClaimEdi.jsx';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import { useShortcuts, isMac } from '../shortcuts.js';
import { undoable, toast } from '../toast.js';
import './claimdetail.css';

export default function ClaimDetail() {
  const { id } = useParams();
  const { can, practice } = useAuth();
  const navigate = useNavigate();
  const { data: c, reload, error: loadErr } = useApi(`/claims/${id}`);
  const [modal, setModal] = useState(null);
  const [checks, setChecks] = useState(0);
  const [edits, setEdits] = useState(0);
  const [err, setErr] = useState(null);
  const { data: ch } = useApi('/clearinghouse');
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  if (loadErr) return <div className="error">{loadErr.message}</div>;
  if (!c) return <div className="empty">Loading…</div>;
  const w = can('billing:write');
  const paidLines = c.items.some((i) => i.paid_amount || i.adjusted_amount);
  const sendElectronic = () => act(() => sendClaims([c.id], ch));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Claim #{c.id} <Badge value={c.status} /> {c.ch_status && <ChStatus claim={c} />}{c.frequency_code === '7' ? <span className="badge info">Corrected claim</span> : c.frequency_code === '8' ? <span className="badge warn">Void notice</span> : null}</h1>
          <div className="muted"><Link to={`/patients/${c.patient_id}`}>{c.first_name} {c.last_name}</Link> · {c.carrier_name}</div>
        </div>
        <div className="actions no-print">
          <button onClick={() => window.print()}>Print</button>
          <button title="The ADA Dental Claim Form on plain paper, for payers that need a paper claim" onClick={() => window.open(`/claims/${c.id}/ada`, '_blank')}>ADA claim form</button>
          {w && ['draft', 'denied'].includes(c.status) && <button className="primary" onClick={sendElectronic}>{ch?.batch ? 'Send to clearinghouse' : 'Download 837'}</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button onClick={() => act(() => api.post(`/claims/${c.id}/submit`))}>{c.status === 'denied' ? 'Resubmitted on paper' : 'Mark sent on paper'}</button>}
          {w && ['submitted', 'partially_paid'].includes(c.status) && <button className="primary" onClick={() => setModal('pay')}>Enter EOB payment</button>}
          {w && c.status === 'submitted' && <button className="danger" onClick={() => setModal('deny')}>Denied</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button onClick={() => setModal('edit')}>Edit claim</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button className="danger" onClick={() => confirm('Void this claim? Procedures become billable again.') && act(() => api.post(`/claims/${c.id}/void`))}>Void</button>}
          {w && ['submitted', 'denied'].includes(c.status) && (
            <>
              <button title="Send a replacement claim (frequency 7) — the payer's claim number is needed" onClick={() => {
                const ref = window.prompt("Corrected claim: a new claim replaces this one at the payer.\n\nPayer's claim number for the original:", c.payer_claim_number || '');
                if (ref?.trim()) act(async () => { const n = await api.post(`/claims/${c.id}/correct`, { original_reference: ref }); navigate(`/claims/${n.id}`); });
              }}>Corrected claim…</button>
              <button className="danger" title="Tell the payer to cancel this claim (frequency 8)" onClick={() => {
                const ref = window.prompt("Void at the payer: sends a cancellation for this claim.\n\nPayer's claim number for the original:", c.payer_claim_number || '');
                if (ref?.trim()) act(async () => { const n = await api.post(`/claims/${c.id}/correct`, { kind: 'void', original_reference: ref }); navigate(`/claims/${n.id}`); });
              }}>Void at payer…</button>
            </>
          )}
          {w && ['paid', 'partially_paid'].includes(c.status) && (
            <button onClick={() => {
              const reason = window.prompt('Reopen this claim? Its insurance payments and write-offs are reversed on the ledger and it goes back to waiting on the payer.\n\nReason:');
              if (reason?.trim()) act(() => api.post(`/claims/${c.id}/reopen`, { reason }));
            }}>Reopen claim</button>
          )}
        </div>
      </div>
      <ErrorBox error={err} />
      {c.denial_reason && <div className="error">Denial reason: {c.denial_reason}</div>}
      {w && ['denied', 'partially_paid', 'paid'].includes(c.status) && <Appeal key={c.id} claim={c} onSent={() => setEdits((n) => n + 1)} />}
      {c.payer_claim_number && <div className="muted" style={{ marginBottom: 8 }}>Payer claim # {c.payer_claim_number}</div>}
      {c.ch_status === 'rejected' && c.status === 'draft' && <div className="error">Rejected electronically: {c.ch_message}</div>}
      <ClaimChecks id={c.id} status={c.status} version={checks} />

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Billing provider</h2>
          <dl className="kv">
            <dt>Practice</dt><dd>{c.practice.name}</dd>
            <dt>Address</dt><dd>{[c.practice.address, c.practice.city, c.practice.state, c.practice.zip].filter(Boolean).join(', ') || '—'}</dd>
            <dt>NPI / TIN</dt><dd>{c.practice.npi || '—'} / {c.practice.tax_id || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Subscriber</h2>
          <dl className="kv">
            <dt>Patient</dt><dd>{c.patient.first_name} {c.patient.last_name} (DOB {c.patient.dob || '—'})</dd>
            <dt>Carrier</dt><dd>{c.carrier_name} {c.payer_id ? `· Payer ID ${c.payer_id}` : ''}</dd>
            <dt>Member ID</dt><dd>{c.subscriber_id}</dd>
            <dt>Group</dt><dd>{c.group_number || '—'}</dd>
          </dl>
        </div>
      </div>

      <Attachments claim={c} onChange={() => { reload(); setChecks((n) => n + 1); }} />
      <Remittances claim={c} />

      <div className="card">
        <h2>Services</h2>
        <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Code</th><th>Description</th><th>Tooth</th><th>Surf</th><th>Provider (NPI)</th><th className="num">Fee</th><th className="num">Est. ins.</th>{paidLines && <><th className="num">Paid</th><th className="num">Write-off</th><th className="num">Patient</th></>}</tr></thead>
          <tbody>
            {c.items.map((i) => (
              <tr key={i.id}>
                <td>{fmtDate(i.completed_at)}</td><td>{i.code}</td><td>{i.description}</td><td>{i.tooth}</td><td>{i.surfaces}</td>
                <td>{i.provider_name} {i.provider_npi ? `(${i.provider_npi})` : ''}</td>
                <td className="num">{money(i.fee)}</td><td className="num">{money(i.estimated_amount)}</td>
                {paidLines && <><td className="num">{money(i.paid_amount)}</td><td className="num">{money(i.adjusted_amount)}</td><td className="num">{money(i.patient_resp)}</td></>}
              </tr>
            ))}
            <tr className="totals-row"><td colSpan={6}>Totals · paid {money(c.paid_amount)}</td><td className="num">{money(c.total_fee)}</td><td className="num">{money(c.estimated_amount)}</td>{paidLines && <td colSpan={3} />}</tr>
          </tbody>
        </table>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          Created {fmtUtcDate(c.created_at, practice?.timezone)}{c.submitted_at ? ` · Submitted ${fmtUtcDate(c.submitted_at, practice?.timezone)}` : ''}{c.paid_at ? ` · Paid ${fmtUtcDate(c.paid_at, practice?.timezone)}` : ''}
        </div>
      </div>

      {c.remarks && <div className="card"><strong>Note to payer:</strong> {c.remarks}</div>}
      <ClaimEdiCard key={`${edits}-${c.status}-${c.ch_status}`} claim={c} onChange={reload} />
      {modal === 'edit' && <Modal title={`Edit claim #${c.id}`} wide onClose={() => setModal(null)}><EditClaim claim={c} onDone={(r) => { setModal(r?.corrected ? null : 'edited'); setEdits((n) => n + 1); if (r?.corrected) navigate(`/claims/${r.corrected}`); else reload(); }} /></Modal>}
      {modal === 'edited' && (
        <Modal title="Claim updated" onClose={() => setModal(null)}>
          <p>The changes are saved and listed in the claim's history.</p>
          {c.status === 'denied' && c.payer_claim_number
            ? <p>The payer already has this claim (#{c.payer_claim_number}). Send it as a <strong>corrected claim</strong> so it replaces the original instead of being denied as a duplicate.</p>
            : <p>Send it again when you're ready.</p>}
          <div className="form-actions">
            <button onClick={() => setModal(null)}>Later</button>
            {c.status === 'denied' && c.payer_claim_number
              ? <button className="primary" onClick={() => act(async () => { const n = await api.post(`/claims/${c.id}/correct`, { original_reference: c.payer_claim_number }); setModal(null); navigate(`/claims/${n.id}`); })}>Create corrected claim</button>
              : <button className="primary" onClick={() => { setModal(null); sendElectronic(); }}>{ch?.batch ? 'Send to clearinghouse' : 'Download 837'}</button>}
          </div>
        </Modal>
      )}
      {modal === 'pay' && <Modal title="Enter insurance payment (EOB)" onClose={() => setModal(null)}><PaymentForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal === 'deny' && <Modal title="Record denial" onClose={() => setModal(null)}><DenyForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
    </>
  );
}

function PaymentForm({ claim, onDone }) {
  const remaining = Math.max(0, claim.estimated_amount - claim.paid_amount);
  const [form, setForm] = useState({ amount: fromCents(remaining), write_off: fromCents(claim.write_off_estimate || 0), reference: '', final: true });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/payment`, { amount: toCents(form.amount), write_off: toCents(form.write_off || 0), reference: form.reference, final: form.final });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Insurance paid ($)<input type="number" step="0.01" min="0" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>Contractual write-off ($)<input type="number" step="0.01" min="0" value={form.write_off} onChange={(e) => setForm({ ...form, write_off: e.target.value })} /></label>
        <label className="full">Check / EFT #<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
        <label className="checkbox full"><input type="checkbox" checked={form.final} onChange={(e) => setForm({ ...form, final: e.target.checked })} /> Final payment for this claim</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post payment</button></div>
    </form>
  );
}

function DenyForm({ claim, onDone }) {
  const [reason, setReason] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/deny`, { reason });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Reason<textarea required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="form-actions"><button className="primary danger" disabled={busy}>Record denial</button></div>
    </form>
  );
}

function ClaimChecks({ id, status, version }) {
  const { data } = useApi(['draft', 'denied'].includes(status) ? `/claims/${id}/validate?v=${version}` : null);
  // Only for claims still to send (the last answer is kept while the claim moves on).
  if (!data || !['draft', 'denied'].includes(status)) return null;
  const risks = data.risks || [];
  const warn = data.warnings?.length || risks.length ? (
    <div className="public-notice" style={{ marginBottom: 12 }}>
      {risks.length > 0 && (
        <>
          <strong>Denial risks:</strong>
          <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
            {risks.map((r) => <li key={`${r.procedure_id}-${r.message}`} className={r.level === 'deny' ? 'text-danger' : ''}>{r.code ? `${r.code}${r.tooth ? ` #${r.tooth}` : ''}: ` : ''}{r.message}{r.level === 'deny' ? ' — likely denied as it stands' : ''}</li>)}
          </ul>
        </>
      )}
      {data.warnings?.length > 0 && (
        <>
          <strong>Payers often deny these without attachments:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.warnings.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
    </div>
  ) : null;
  if (!data.problems.length) return <>{warn}<div className="badge ok" style={{ marginBottom: 12 }}>✓ Ready to send electronically</div></>;
  return (
    <>
      {warn}
      <div className="error">
        <strong>Fix before sending electronically:</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    </>
  );
}

// Appeal (workflow 46, docs/workflows/specs/46-denied-claim-appeals.md). On a denied claim it's open already with
// the payer's reason filled in: D (or the button) drafts the letter — by AI from the chart, or from a plain template
// when AI is off — and "Send appeal & print" (Ctrl/⌘+Enter) files it on the chart as a PDF, records it in the
// claim's history and brings the claim back up for a follow-up call in 30 days. Nothing goes out on its own.
function Appeal({ claim, onSent }) {
  const [open, setOpen] = useState(claim.status === 'denied');
  const [reason, setReason] = useState(claim.denial_reason || '');
  const [draft, setDraft] = useState(null);
  const [followUp, setFollowUp] = useState(() => new Date(Date.now() + 30 * 86400_000).toLocaleDateString('en-CA'));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [err, setErr] = useState(null);
  const letterRef = useRef(null);
  // The letter gets the cursor as soon as a draft is in, to read and finish it (then Ctrl/⌘+Enter).
  const drafted = !!draft?.letter;
  useEffect(() => { if (drafted) letterRef.current?.focus(); }, [drafted]);
  const write = async () => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.post(`/claims/${claim.id}/appeal`, { reason });
      setDraft(d);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const print = (letter) => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.title = `Appeal — claim ${claim.id}`;
    const pre = w.document.createElement('pre');
    pre.style.cssText = 'font: 12pt/1.5 Georgia, serif; white-space: pre-wrap; margin: 1in;';
    pre.textContent = letter;
    w.document.body.appendChild(pre);
    w.print();
  };
  const send = async () => {
    if (!draft?.letter || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await api.post(`/claims/${claim.id}/appeal`, { letter: draft.letter, reason, follow_up_date: followUp, drafted_by: draft.drafted_by || 'staff' });
      setSent(out);
      toast(`Appeal filed on the chart · claim #${claim.id} comes back for a call on ${fmtDate(out.follow_up_date)}`);
      print(draft.letter);
      onSent?.();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  useShortcuts([
    { combo: 'd', handler: () => { setOpen(true); write(); }, label: 'Draft the appeal letter', section: 'Claim', enabled: !draft && !busy },
    { combo: 'mod+enter', handler: send, label: 'Send the appeal and print it', section: 'Claim', enabled: !!draft && !sent, inInputs: true },
  ]);
  if (!open) return <div style={{ margin: '8px 0' }}><button className="small" onClick={() => setOpen(true)}>Appeal this claim…</button></div>;
  return (
    <div className="card">
      <h2>Appeal</h2>
      <ErrorBox error={err} />
      {sent ? (
        <div className="public-notice ok">Appeal filed on the chart (Insurance folder) and in this claim’s history. It comes back on the follow-up list on {fmtDate(sent.follow_up_date)}. <button className="small" onClick={() => print(draft.letter)}>Print again</button></div>
      ) : (
        <>
          <label>What the payer said, or what you disagree with<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Downgraded to amalgam; paid at 50% instead of 80%" /></label>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}><button className={draft ? '' : 'primary'} disabled={busy} onClick={write}>{busy && !draft ? 'Writing…' : draft ? 'Write again' : <>Draft the letter <kbd>D</kbd></>}</button></div>
          {draft && (
            <>
              {draft.drafted_by === 'template' && <div className="text-warn" style={{ fontSize: 12, marginBottom: 6 }}>Drafted from the office template (AI is off): add the dentist’s clinical reason where the brackets are.</div>}
              <textarea ref={letterRef} rows={16} style={{ width: '100%', fontFamily: 'Georgia, serif' }} value={draft.letter} onChange={(e) => setDraft({ ...draft, letter: e.target.value, drafted_by: draft.drafted_by === 'ai' ? 'ai' : draft.drafted_by })} aria-label="Appeal letter" />
              {draft.enclosures?.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Enclose: {draft.enclosures.join('; ')}</div>}
              {draft.missing?.length > 0 && <div className="text-warn" style={{ fontSize: 12 }}>Stronger with (not in the chart): {draft.missing.join('; ')}</div>}
              <div className="form-actions">
                <label className="inline" style={{ gap: 6, marginRight: 'auto' }}>Call the payer again on<input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></label>
                <button onClick={() => navigator.clipboard?.writeText(draft.letter)}>Copy</button>
                <button className="primary" disabled={busy} onClick={send}>{busy ? 'Filing…' : 'Send appeal & print'} <kbd>{isMac ? '⌘' : 'Ctrl'}↵</kbd></button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// What the payer sent for this claim (ERAs and paper EOBs, from the insurance autopilot) and the EOB itself.
function Remittances({ claim }) {
  const { practice } = useAuth();
  const { data } = useApi(`/claims/${claim.id}/remittances`);
  if (!data?.length) return null;
  const open = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (res.ok) window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
  };
  const STATE = { posted: 'Posted', ready: 'Ready to post', exception: 'Needs a look', resolved: 'Decided' };
  return (
    <div className="card">
      <h2>Insurance payments received</h2>
      <table><thead><tr><th>Received</th><th>From</th><th>Paid</th><th>Written off</th><th>Patient</th><th>Status</th><th /></tr></thead>
        <tbody>{data.map((r) => (
          <tr key={r.id}>
            <td>{fmtUtcDate(r.created_at, practice?.timezone)}</td><td>{r.source === 'era' ? 'ERA' : 'Paper EOB'} {r.trace || ''}</td><td>{money(r.paid)}</td><td>{money(r.contractual)}</td><td>{money(r.patient_resp)}</td>
            <td>{STATE[r.state] || r.state}{r.state === 'exception' && r.reason ? ` — ${r.reason}` : ''}{r.state === 'exception' ? <> · <Link to="/insurance-autopilot">worklist</Link></> : null}</td>
            <td>{r.eob_url && <button className="small" onClick={() => open(r.eob_url)}>See the EOB</button>}</td>
          </tr>
        ))}</tbody></table>
    </div>
  );
}

// X-rays, perio charts and narratives for the payer, each referenced from the claim by its control number.
function Attachments({ claim, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/claims/${claim.id}/attachments`);
  const { data: docs } = useApi(`/patients/${claim.patient_id}/documents`);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const editable = can('billing:write') && !['paid', 'void'].includes(claim.status);
  // What the validator says payers will want, matched to the chart: recent films of these teeth, the perio chart.
  const { data: sug, reload: reloadSug } = useApi(editable ? `/claims/${claim.id}/attachments/suggest` : null);
  const [ticked, setTicked] = useState(null);
  const refreshAll = () => { reload(); reloadSug(); onChange(); };
  const run = async (fn) => { setErr(null); try { await fn(); refreshAll(); } catch (e) { setErr(e); } };
  const suggestions = sug?.suggestions || [];
  const picks = ticked || new Set(suggestions.filter((x) => x.preselected).map((x) => x.key));
  const attachPicked = () => {
    const items = suggestions.filter((x) => picks.has(x.key)).map((x) => (x.kind === 'perio' ? { perio_exam_id: x.perio_exam_id } : { document_id: x.document_id, report_type: x.report_type }));
    if (!items.length) return;
    setErr(null);
    // Attached at once; Undo takes them off again (only while they haven't been sent).
    undoable(`Attached ${items.length} to claim #${claim.id}`,
      async () => { const r = await api.post(`/claims/${claim.id}/attachments/batch`, { items }); setTicked(null); refreshAll(); return r; },
      async (r) => { for (const aid of r.added) await api.del(`/claim-attachments/${aid}`); refreshAll(); })
      .catch((e) => setErr(e));
  };
  useShortcuts([{ combo: 'a', handler: attachPicked, label: 'Attach the suggested x-rays / perio chart', section: 'Claim', enabled: editable && picks.size > 0 && !form }]);
  if (!data) return null;
  const pending = data.attachments.filter((a) => ['pending', 'rejected'].includes(a.status));
  const toggle = (key) => { const next = new Set(picks); if (next.has(key)) next.delete(key); else next.add(key); setTicked(next); };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Attachments</h2>
        <div className="inline" style={{ gap: 6 }}>
          {editable && <button className="small" onClick={() => setForm({ report_type: 'RB', document_id: '', narrative: '', transmission: 'BM' })}>+ Attachment</button>}
          {editable && pending.length > 0 && <button className="small primary" onClick={() => run(() => api.post(`/claims/${claim.id}/attachments/send`))}>{data.electronic ? `Send ${pending.length} to the payer` : `Number ${pending.length} for mail/fax`}</button>}
          {!data.electronic && data.attachments.some((a) => a.control_number) && <button className="small" onClick={() => window.open(`/claims/${claim.id}/attachments/print`, '_blank')}>Print cover sheet</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      {editable && sug?.needs?.length > 0 && (
        <div className="attach-suggest">
          <div><strong>Payers usually want:</strong> {sug.needs.map((n) => `${n.label}${n.teeth.length ? ` of #${n.teeth.join(', #')}` : ''}`).join(' · ')}</div>
          {suggestions.length > 0 ? (
            <>
              {suggestions.map((x) => (
                <label key={x.key} className="checkbox">
                  <input type="checkbox" checked={picks.has(x.key)} onChange={() => toggle(x.key)} />
                  {x.label} <span className="muted">· {x.why} · {fmtDate(x.date)}</span>
                </label>
              ))}
              <button className="small primary" disabled={!picks.size} title="Shortcut: A" onClick={attachPicked}>Attach {picks.size} suggested</button>
            </>
          ) : (
            <div className="muted">Nothing on file from the year around the service date{sug.needs.some((n) => n.type === 'RB') ? ' — take or import an x-ray of the tooth' : ''}{sug.needs.some((n) => n.type === 'P6') ? ' — chart perio' : ''}, or add a narrative.</div>
          )}
        </div>
      )}
      {data.attachments.length === 0 ? <div className="muted" style={{ marginTop: 6 }}>None. {data.mode === 'manual' ? 'Attachments are mailed or faxed with a printed cover sheet (no attachment service is connected).' : ''}</div> : (
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>What</th><th>File / narrative</th><th>Sent</th><th>Control number</th><th /></tr></thead>
          <tbody>
            {data.attachments.map((a) => (
              <tr key={a.id}>
                <td>{data.report_types[a.report_type]}</td>
                <td>{a.filename || <span style={{ whiteSpace: 'pre-wrap' }}>{a.narrative}</span>}</td>
                <td>{data.transmissions[a.transmission]}{a.error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{a.error}</div>}</td>
                <td>{a.control_number || <Badge value="pending" />}</td>
                <td>{editable && ['pending', 'rejected'].includes(a.status) && <button className="small" onClick={() => run(() => api.del(`/claim-attachments/${a.id}`))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && (
        <Modal title="Add an attachment" onClose={() => setForm(null)}>
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post(`/claims/${claim.id}/attachments`, { ...form, document_id: form.document_id ? Number(form.document_id) : null }); setForm(null); }); }}>
            <ErrorBox error={err} />
            <div className="form-grid">
              <label>Kind<select value={form.report_type} onChange={(e) => setForm({ ...form, report_type: e.target.value })}>{Object.entries(data.report_types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              {!data.electronic && <label>Sending it<select value={form.transmission} onChange={(e) => setForm({ ...form, transmission: e.target.value })}><option value="BM">By mail</option><option value="FX">By fax</option></select></label>}
              <label className="full">From the chart
                <select value={form.document_id} onChange={(e) => setForm({ ...form, document_id: e.target.value })}>
                  <option value="">— none (narrative only) —</option>
                  {(docs || []).map((d) => <option key={d.id} value={d.id}>{d.filename} · {d.category}{d.tooth ? ` #${d.tooth}` : ''} · {fmtDate(d.taken_at || d.created_at)}</option>)}
                </select>
              </label>
              <label className="full">Narrative{form.report_type === 'OZ' ? ' *' : ' (optional)'}<textarea rows={5} value={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.value })} placeholder="e.g. Tooth #30 has a fractured MB cusp under a large existing amalgam; a crown is needed to restore it." /></label>
              <div className="full">
                <button type="button" className="small" disabled={form.drafting} onClick={async () => {
                  setForm((f) => ({ ...f, drafting: true }));
                  try {
                    const d = await api.post(`/claims/${claim.id}/narrative`, {});
                    setForm((f) => ({ ...f, drafting: false, ai_drafted: true, narrative: d.narrative, report_type: f.document_id ? f.report_type : 'OZ', hint: [d.missing?.length ? `Not in the chart (add if you can): ${d.missing.join('; ')}` : '', d.attach?.length ? `Send with it: ${d.attach.join('; ')}` : ''].filter(Boolean).join(' · ') }));
                  } catch (e) { setErr(e); setForm((f) => ({ ...f, drafting: false })); }
                }}>{form.drafting ? 'Writing…' : 'Draft the narrative with AI'}</button>
                {form.hint && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{form.hint}</div>}
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Drafted from the chart — read it and correct anything before sending.</div>
              </div>
            </div>
            <div className="form-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary" onClick={() => setForm((f) => { const { drafting: _d, hint: _h, ...rest } = f; return rest; })}>Add</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// Fix a rejected or denied claim: codes, teeth and surfaces (corrected on the chart too), the prior
// authorization number and a note to the payer. Changes are kept in the claim's history.
function EditClaim({ claim, onDone }) {
  const [items, setItems] = useState(() => claim.items.map((i) => ({ claim_item_id: i.id, code: i.code, tooth: i.tooth || '', surfaces: i.surfaces || '', description: i.description })));
  const [remarks, setRemarks] = useState(claim.remarks || '');
  const [preauth, setPreauth] = useState(claim.preauth_number || '');
  const setItem = (idx, k, v) => setItems(items.map((x, i) => (i === idx ? { ...x, [k]: v } : x)));
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/claims/${claim.id}`, { items: items.map(({ description: _, ...x }) => x), remarks, preauth_number: preauth });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {claim.ch_message && claim.ch_status === 'rejected' && <div className="error" style={{ marginBottom: 8 }}>Rejected: {claim.ch_message}</div>}
      {claim.denial_reason && <div className="error" style={{ marginBottom: 8 }}>Denied: {claim.denial_reason}</div>}
      <table>
        <thead><tr><th>Code</th><th>Description</th><th>Tooth</th><th>Surfaces</th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.claim_item_id}>
              <td><input aria-label="Procedure code" value={it.code} onChange={(e) => setItem(idx, 'code', e.target.value.toUpperCase())} style={{ width: 90 }} /></td>
              <td className="muted">{it.description}</td>
              <td><input aria-label="Tooth" value={it.tooth} onChange={(e) => setItem(idx, 'tooth', e.target.value)} style={{ width: 60 }} /></td>
              <td><input aria-label="Surfaces" value={it.surfaces} onChange={(e) => setItem(idx, 'surfaces', e.target.value.toUpperCase())} style={{ width: 80 }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label>Prior authorization #<input value={preauth} onChange={(e) => setPreauth(e.target.value)} /></label>
        <label className="full">Note to payer (sent with the claim, 80 characters)<input maxLength={80} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Tooth #3 corrected from #4; narrative attached" /></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Code, tooth and surface changes also correct the procedure in the patient's chart.</p>
      <div className="form-actions"><button className="primary" disabled={busy}>Save changes</button></div>
    </form>
  );
}
