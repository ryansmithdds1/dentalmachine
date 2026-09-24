import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useCommands } from '../shortcuts.js';
import { money, fmtDate, fmtUtcDate } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox, Badge, useSubmit } from '../components/ui.jsx';

// Billing autopilot (backlog BL1–BL5; spec docs/workflows/specs/BL-billing.md): every automatic payment and what's
// next, the declined ones being retried (and what to do when they pause), disputes, the daily check with the card
// processor, expiring cards, the office's fees and the card-cost settings. Charges run on their own; this screen
// shows only what needs a person.
const TABS = [['plans', 'Automatic payments'], ['declined', 'Declined'], ['disputes', 'Disputes & refunds'], ['recon', 'Daily check'], ['expiring', 'Expiring cards'], ['fees', 'Office fees'], ['settings', 'Card costs & retries']];
const KIND = { payment_plan: 'Payment plan', membership: 'Membership', ortho_case: 'Ortho', recurring: 'Recurring' };
const pct = (bps) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export default function BillingAutopilot() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'plans';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'plans') n.delete('tab'); else n.set('tab', t); return n; });
  useCommands(TABS.map(([k, label]) => ({ id: `billing-${k}`, label: `Billing autopilot: ${label}`, run: () => setTab(k) })));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Billing autopilot</h1>
          <div className="muted">Automatic payments charge, post and send receipts on their own. You only see what needs a person.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'plans' && <Plans />}
      {tab === 'declined' && <Declined />}
      {tab === 'disputes' && <Disputes />}
      {tab === 'recon' && <DailyCheck />}
      {tab === 'expiring' && <Expiring />}
      {tab === 'fees' && <Fees />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

// ---- BL1: every plan and what's next ----
function Plans() {
  const { practice } = useAuth();
  const [kind, setKind] = useState('');
  const { data, error } = useApi(`/billing/active${kind ? `?kind=${kind}` : ''}`);
  return (
    <>
      <ErrorBox error={error} />
      {data && (
        <div className="card">
          <div className="inline" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong>{data.counts.total} active</strong>
            <span>{data.counts.retrying} retrying</span>
            <span>{data.counts.paused} paused</span>
            <span>{data.counts.no_card} without a card</span>
            <label style={{ marginLeft: 'auto' }}>Show{' '}
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Everything</option>
                {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}
      {data?.waiting_for_patient?.length > 0 && (
        <div className="card">
          <h3>Waiting for the patient to agree</h3>
          <ul>{data.waiting_for_patient.map((w) => <li key={w.id}><Link to={`/patients/${w.patient_id}`}>{w.patient}</Link> — {KIND[w.kind]}, link sent {fmtUtcDate(w.sent_at, practice?.timezone)}</li>)}</ul>
        </div>
      )}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Patient</th><th>What</th><th>Next</th><th>Amount</th><th>Card</th><th>Signed OK</th><th>Status</th></tr></thead>
          <tbody>
            {(data?.items || []).map((i) => (
              <tr key={`${i.kind}:${i.id}`}>
                <td><Link to={`/patients/${i.patient_id}`}>{i.patient}</Link></td>
                <td>{i.label?.startsWith(KIND[i.kind]) ? i.label : `${KIND[i.kind]} · ${i.label}`}</td>
                <td>{i.next_date ? fmtDate(i.next_date) : '—'}</td>
                <td>{money(i.next_amount)}</td>
                <td>{i.card ? <>{i.card.label}{i.card.expiring && <> <Badge value="expiring" /></>}</> : <span className="muted">No card — billed to the account</span>}</td>
                <td>{i.authorization ? fmtUtcDate(i.authorization.signed_at, practice?.timezone) : <span className="muted">not on file</span>}</td>
                <td>{i.dunning ? <span title={i.dunning.reason}>{i.status === 'paused' ? 'Paused' : `Retry ${fmtDate(i.dunning.next_retry_on)}`}</span> : <Badge value={i.status} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.items.length && <p className="muted">No automatic payments yet. Set one up from a patient’s ledger (Set up payments).</p>}
      </div>
    </>
  );
}

// ---- BL3: declined and being retried ----
function Declined() {
  const { data, error, reload } = useApi('/billing/dunning');
  const { can } = useAuth();
  const write = can('billing:write');
  const [note, setNote] = useState({});
  const act = useSubmit(async (d, what, body) => {
    const out = await api.post(`/billing/dunning/${d.id}/${what}`, body);
    toast(what === 'retry' ? (out.result?.ok || out.result?.charged ? 'Charged — it’s posted' : `Still declined: ${out.result?.reason || 'try again later'}`) : what === 'send-link' ? 'Update-card link sent' : what === 'resume' ? 'Retries restarted' : 'Retries stopped');
    reload();
  });
  return (
    <>
      <ErrorBox error={error || act.error} />
      {data && !data.length && <div className="card muted">No declined payments. When a card is declined nothing is posted, the patient gets a link to update it, and it’s tried again on its own.</div>}
      {(data || []).map((d) => (
        <div key={d.id} className="card">
          <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <strong><Link to={`/patients/${d.patient_id}`}>{d.patient}</Link></strong> — {d.label}, {money(d.amount)} {d.card && <span className="muted">({d.card})</span>}
              <div className="muted">{d.last_reason} · {d.failures} {d.failures === 1 ? 'try' : 'tries'} · {d.status === 'paused' ? 'paused — needs a person' : `next try ${fmtDate(d.next_retry_on)}`}{d.patient_notified_at ? ' · patient sent an update-card link' : ' · patient not reached yet'}</div>
            </div>
            {write && (
              <div className="drawer-actions">
                <button onClick={() => act.submit(d, 'retry')} disabled={act.busy}>Retry now</button>
                <button onClick={() => act.submit(d, 'send-link')} disabled={act.busy}>Text update-card link</button>
                {d.status === 'paused' && <button onClick={() => act.submit(d, 'resume')} disabled={act.busy}>Restart retries</button>}
              </div>
            )}
          </div>
          {d.status === 'paused' && (
            <div style={{ marginTop: 8 }}>
              <strong>Next steps</strong>
              <ol>
                <li>Call {d.patient}{d.phone ? ` at ${d.phone}` : ''}: “The card we have on file for your {d.label} didn’t go through, so we’ve paused the automatic payments. Could we update the card, or take a payment now?”</li>
                <li>Send a statement from their <Link to={`/patients/${d.patient_id}/statement`}>Statement page</Link>.</li>
                <li>No answer in 30 days: consider moving the account to collections.</li>
              </ol>
            </div>
          )}
          {write && (
            <div className="inline" style={{ gap: 8, marginTop: 6 }}>
              <input aria-label="Why stop the retries" placeholder="Stop retries — why? (e.g. paid by check, sent to collections)" value={note[d.id] || ''} onChange={(e) => setNote({ ...note, [d.id]: e.target.value })} style={{ flex: 1 }} />
              <button onClick={() => act.submit(d, 'stop', { note: note[d.id] })} disabled={act.busy || !note[d.id]}>Stop retries</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function Disputes() {
  const { practice } = useAuth();
  const { data, error } = useApi('/billing/disputes');
  return (
    <div className="card table-wrap">
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>Date</th><th>Patient</th><th>What</th><th>Amount</th><th>Status</th><th>Respond by</th></tr></thead>
        <tbody>
          {(data || []).map((d) => (
            <tr key={d.id}>
              <td>{fmtUtcDate(d.created_at, practice?.timezone)}</td>
              <td>{d.patient_id ? <Link to={`/patients/${d.patient_id}`}>{d.first_name} {d.last_name}</Link> : <span className="muted">not matched</span>}</td>
              <td>{d.kind === 'dispute' ? `Card dispute${d.reason ? ` (${d.reason.replace(/_/g, ' ')})` : ''}` : 'Refund made at the processor'}</td>
              <td>{money(d.amount)}</td>
              <td><Badge value={d.status} /></td>
              <td>{d.status === 'open' && d.respond_by ? fmtDate(d.respond_by) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.length && <p className="muted">No disputes. When a patient disputes a card payment, it’s taken back off the ledger here and shows in Needs attention with the deadline to respond.</p>}
    </div>
  );
}

// ---- BL2: the daily check with the processor ----
function DailyCheck() {
  const { data, error, reload } = useApi('/billing/reconciliation');
  const { can } = useAuth();
  const run = useSubmit(async () => {
    const out = await api.post('/billing/reconciliation/run', {});
    toast(out.available === false ? out.note : `Checked ${out.day}: ${out.exceptions} to look at`);
    reload();
  });
  return (
    <>
      <ErrorBox error={error || run.error} />
      <div className="card">
        {data && !data.available && <p className="muted">{data.mode === 'sandbox' ? 'Sandbox card payments: there’s no processor to check against.' : 'Card processing isn’t connected.'}</p>}
        <p>Each morning yesterday’s card charges and payouts at the processor are checked against the ledger. Anything that doesn’t match goes to Needs attention for billing.</p>
        {can('billing:write') && <button onClick={() => run.submit()} disabled={run.busy}>Check yesterday again</button>}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Day</th><th>At the processor</th><th>In the ledger</th><th>Matched</th><th>Payouts</th><th>To look at</th></tr></thead>
          <tbody>
            {(data?.days || []).map((d) => (
              <tr key={d.id}>
                <td>{fmtDate(d.day)}</td><td>{money(d.processor_total)}</td><td>{money(d.ledger_total)}</td><td>{d.matched}</td><td>{d.payouts}</td>
                <td>{d.status === 'unavailable' ? <span className="muted">not available</span> : d.exceptions ? <span title={(d.detail?.exceptions || []).map((e) => e.title).join('\n')}>{d.exceptions} — see Needs attention</span> : 'All matched'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.days?.length && <p className="muted">No days checked yet{data.available ? '' : ' — there’s nothing to check until card processing is connected'}.</p>}
      </div>
    </>
  );
}

function Expiring() {
  const { data, error, reload } = useApi('/billing/expiring-cards');
  const { can, practice } = useAuth();
  const send = useSubmit(async (c) => { await api.post(`/payment-methods/${c.id}/update-link`, {}); toast('Update-card link sent'); reload(); });
  const runAll = useSubmit(async () => { const out = await api.post('/billing/expiring-cards/run', {}); toast(`${out.sent} update-card request${out.sent === 1 ? '' : 's'} sent`); reload(); });
  return (
    <>
      <ErrorBox error={error || send.error || runAll.error} />
      <div className="card">
        <p>Cards used for automatic payments are caught a month before they expire: the patient is sent a secure link to update the card (once per card).</p>
        {can('billing:write') && <button onClick={() => runAll.submit()} disabled={runAll.busy}>Send any that are due now</button>}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Patient</th><th>Card</th><th>Expires</th><th>Asked</th><th /></tr></thead>
          <tbody>
            {(data || []).map((c) => (
              <tr key={c.id}>
                <td><Link to={`/patients/${c.patient_id}`}>{c.patient}</Link></td>
                <td>{c.brand} •••• {c.last4}</td>
                <td>{fmtDate(c.expires)}</td>
                <td>{c.notified_at ? fmtUtcDate(c.notified_at, practice?.timezone) : '—'}</td>
                <td>{can('billing:write') && <button className="small" onClick={() => send.submit(c)} disabled={send.busy}>Text link again</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <p className="muted">No cards in use expire soon.</p>}
      </div>
    </>
  );
}

// ---- BL5: office fees ----
const BLANK_FEE = { name: '', kind: 'fixed', amount: '', pct: '', occasion: 'manual', applies: 'offered', min: '', max: '', max_per_year: '', grace_days: 0, waivable: true, active: true };
function Fees() {
  const { data, error, reload } = useApi('/billing/fees');
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [form, setForm] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const cents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
  const save = useSubmit(async () => {
    const body = {
      name: form.name, kind: form.kind, amount: form.kind === 'fixed' ? cents(form.amount) : 0, pct_bps: form.kind === 'percent' ? Math.round(Number(form.pct) * 100) : 0,
      occasion: form.occasion, applies: form.applies, min_amount: cents(form.min), max_amount: cents(form.max), max_per_year: form.max_per_year === '' ? null : Number(form.max_per_year),
      grace_days: Number(form.grace_days) || 0, waivable: form.waivable, active: form.active,
    };
    if (form.id) await api.put(`/billing/fees/${form.id}`, body); else await api.post('/billing/fees', body);
    toast('Fee saved');
    setForm(null);
    reload();
  });
  const edit = (f) => setForm({
    id: f.id, name: f.name, kind: f.kind, amount: f.amount ? (f.amount / 100).toFixed(2) : '', pct: f.pct_bps ? f.pct_bps / 100 : '', occasion: f.occasion, applies: f.applies,
    min: f.min_amount != null ? (f.min_amount / 100).toFixed(2) : '', max: f.max_amount != null ? (f.max_amount / 100).toFixed(2) : '', max_per_year: f.max_per_year ?? '', grace_days: f.grace_days, waivable: f.waivable, active: f.active,
  });
  return (
    <>
      <ErrorBox error={error || save.error} />
      <div className="card">
        <p>Fees post as their own line on the ledger (never inside a procedure fee), are shown to the patient before they agree, and can be waived by a manager with a reason.</p>
        {admin ? <button onClick={() => setForm({ ...BLANK_FEE })}>Add a fee</button> : <p className="muted">Only an administrator can add or change fees.</p>}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Fee</th><th>Amount</th><th>When</th><th>Limits</th><th>Waivable</th><th /></tr></thead>
          <tbody>
            {(data?.fees || []).map((f) => (
              <tr key={f.id} className={f.active ? '' : 'muted'}>
                <td>{f.name}{!f.active && ' (off)'}</td>
                <td>{f.kind === 'fixed' ? money(f.amount) : `${pct(f.pct_bps)} of what’s owed`}</td>
                <td>{f.occasion_label} · {f.applies === 'automatic' ? 'automatic' : 'offered'}{f.grace_days ? ` · after ${f.grace_days} days` : ''}</td>
                <td>{[f.min_amount != null && `at least ${money(f.min_amount)}`, f.max_amount != null && `at most ${money(f.max_amount)}`, f.max_per_year && `${f.max_per_year}× a year`].filter(Boolean).join(', ') || '—'}</td>
                <td>{f.waivable ? 'Yes' : 'No'}</td>
                <td>{admin && <button className="small" onClick={() => edit(f)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && (
        <aside className="drawer" aria-label="Office fee">
          <div className="drawer-head"><h2>{form.id ? 'Edit fee' : 'New fee'}</h2><button onClick={() => setForm(null)} aria-label="Close">✕</button></div>
          <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
            <label>Name<input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Missed appointment fee" /></label>
            <label>Type
              <select value={form.kind} onChange={(e) => set('kind', e.target.value)}><option value="fixed">A fixed $ amount</option><option value="percent">A % of what’s owed</option></select>
            </label>
            {form.kind === 'fixed'
              ? <label>Amount ($)<input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label>
              : <label>Percent<input inputMode="decimal" value={form.pct} onChange={(e) => set('pct', e.target.value)} /></label>}
            <label>When it applies
              <select value={form.occasion} onChange={(e) => set('occasion', e.target.value)}>{Object.entries(data?.occasions || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            {form.occasion !== 'manual' && (
              <label>How
                <select value={form.applies} onChange={(e) => set('applies', e.target.value)}><option value="automatic">Added automatically</option><option value="offered">Offered (staff choose)</option></select>
              </label>
            )}
            {form.occasion === 'late_payment' && <label>Grace days<input inputMode="numeric" value={form.grace_days} onChange={(e) => set('grace_days', e.target.value)} /></label>}
            {form.kind === 'percent' && <label>At least ($)<input inputMode="decimal" value={form.min} onChange={(e) => set('min', e.target.value)} /></label>}
            <label>At most ($, cap)<input inputMode="decimal" value={form.max} onChange={(e) => set('max', e.target.value)} /></label>
            <label>Times a year per patient (blank = no limit)<input inputMode="numeric" value={form.max_per_year} onChange={(e) => set('max_per_year', e.target.value)} /></label>
            <label className="checkbox"><input type="checkbox" checked={form.waivable} onChange={(e) => set('waivable', e.target.checked)} /> Managers can waive it (with a reason)</label>
            <label className="checkbox"><input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> On</label>
            <div className="drawer-actions"><button className="primary" type="submit" disabled={save.busy}>Save</button></div>
          </form>
        </aside>
      )}
    </>
  );
}

// ---- BL4/BL5: processor, passing card costs on, retries ----
function Settings() {
  const { data, error, reload } = useApi('/billing/settings');
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [form, setForm] = useState(null);
  const s = form || (data && {
    pass_through: data.settings.pass_through, surcharge: data.settings.surcharge_bps / 100 || '', cost: data.settings.processing_cost_bps / 100 || '', fee: data.settings.convenience_fee ? (data.settings.convenience_fee / 100).toFixed(2) : '',
    notified: !!data.settings.processor_notified, retry: data.settings.retry_days.join(', '), expiring: data.settings.expiring_days,
  });
  const set = (k, v) => setForm({ ...s, [k]: v });
  const save = useSubmit(async () => {
    await api.put('/billing/settings', {
      pass_through: s.pass_through, surcharge_bps: Math.round(Number(s.surcharge || 0) * 100), processing_cost_bps: Math.round(Number(s.cost || 0) * 100),
      convenience_fee: Math.round(Number(s.fee || 0) * 100), processor_notified: s.notified, retry_days: s.retry, expiring_days: Number(s.expiring),
    });
    toast('Saved');
    setForm(null);
    reload();
  });
  if (!data) return <ErrorBox error={error} />;
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
      <ErrorBox error={save.error} />
      <h3>Card processor</h3>
      <p>{data.processors.filter((p) => p.available).map((p) => p.name).join(', ')} {data.mode === 'sandbox' ? '(sandbox — test cards only)' : data.mode === 'none' ? '(not connected)' : ''}. Coming later: {data.processors.filter((p) => !p.available).map((p) => p.name).join(', ')}.</p>
      <h3>Pass card costs on to patients</h3>
      <p className="muted">State: {data.state || 'not set'}. {data.state_rule?.note || (data.surcharge_allowed ? `Card brands allow up to ${pct(data.brand_max_bps)} on credit cards, never on debit.` : '')}</p>
      <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 10 }}>
        <label className="checkbox"><input type="radio" checked={s.pass_through === 'off'} onChange={() => set('pass_through', 'off')} /> Don’t pass card costs on</label>
        <label className="checkbox"><input type="radio" checked={s.pass_through === 'surcharge'} disabled={!data.surcharge_allowed} onChange={() => set('pass_through', 'surcharge')} /> A surcharge on credit cards {!data.surcharge_allowed && '(not allowed in this state)'}</label>
        {s.pass_through === 'surcharge' && (
          <div style={{ marginLeft: 24 }}>
            <label>What card processing costs you (%)<input inputMode="decimal" value={s.cost} onChange={(e) => set('cost', e.target.value)} /></label>
            <label>Surcharge (%) — at most {pct(data.surcharge_max_bps ?? data.brand_max_bps)} and never more than your cost<input inputMode="decimal" value={s.surcharge} onChange={(e) => set('surcharge', e.target.value)} /></label>
            <label className="checkbox"><input type="checkbox" checked={s.notified} onChange={(e) => set('notified', e.target.checked)} /> I told my processor (card brands require 30 days’ notice)</label>
          </div>
        )}
        <label className="checkbox"><input type="radio" checked={s.pass_through === 'convenience_fee'} onChange={() => set('pass_through', 'convenience_fee')} /> A flat convenience fee for paying online</label>
        {s.pass_through === 'convenience_fee' && <label style={{ marginLeft: 24 }}>Fee ($)<input inputMode="decimal" value={s.fee} onChange={(e) => set('fee', e.target.value)} /></label>}
        {data.disclosure && <p className="muted">Patients see: “{data.disclosure.text}” before they pay, and it’s on the receipt.</p>}
        <h3>Declined payments</h3>
        <label>Try again on these days after a decline<input value={s.retry} onChange={(e) => set('retry', e.target.value)} /></label>
        <label>Ask for a new card this many days before it expires<input inputMode="numeric" value={s.expiring} onChange={(e) => set('expiring', e.target.value)} /></label>
        {admin ? <div className="drawer-actions"><button className="primary" type="submit" disabled={save.busy}>Save</button></div> : <p className="muted">Only an administrator can change these.</p>}
      </fieldset>
    </form>
  );
}
