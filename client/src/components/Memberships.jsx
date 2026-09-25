import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useLookup, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fullName } from '../format.js';
import { CsvButton, PrintButton } from './ReportControls.jsx';
import { Badge, ErrorBox, Modal, useSubmit, AskButton } from './ui.jsx';
import { toast } from '../toast.js';

const per = (p) => `${money(p.price)}/${p.interval === 'year' ? 'yr' : 'mo'}`;

// Settings → Membership plans.
export function MembershipPlans() {
  const { user } = useAuth();
  const { data: plans, reload } = useApi('/membership-plans?all=true');
  const [editing, setEditing] = useState(null);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="inline" style={{ padding: '14px 16px', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Membership plans</h2>
          <div className="muted" style={{ fontSize: 13 }}>An in-house plan for patients without insurance: a monthly or yearly fee charged to their card, services included each membership year, and a discount on other treatment.</div>
        </div>
        {user?.role === 'admin' && <button className="primary" onClick={() => setEditing({ name: '', price: '', interval: 'month', discount_pct: 15, included: [{ label: 'Cleanings', codes: 'D1110', per_year: 2 }, { label: 'Exams', codes: 'D0120, D0150', per_year: 2 }, { label: 'X-rays', codes: 'D0274, D0210, D0330', per_year: 1 }], active: true })}>+ Plan</button>}
      </div>
      {!plans ? <div className="empty">Loading…</div> : plans.length === 0 ? <div className="empty">No plans yet.</div> : (
        <table>
          <thead><tr><th>Plan</th><th>Price</th><th>Included each year</th><th>Discount</th><th>Members</th><th /></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                <td><strong>{p.name}</strong>{(p.min_age != null || p.max_age != null) && <div className="muted">Ages {p.min_age ?? 0}–{p.max_age ?? '+'}</div>}</td>
                <td>{per(p)}</td>
                <td>{p.included.map((r) => `${r.label} ×${r.per_year}`).join(', ') || '—'}</td>
                <td>{p.discount_pct}%</td>
                <td>{p.members}</td>
                <td>{user?.role === 'admin' && <button className="small" onClick={() => setEditing({ ...p, price: (p.price / 100).toFixed(2), active: !!p.active, included: p.included.map((r) => ({ ...r, codes: r.codes.join(', ') })) })}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); invalidateLookup('/membership-plans'); }} />}
    </div>
  );
}

function PlanEditor({ plan, onClose, onSaved }) {
  const [p, setP] = useState(plan);
  const set = (patch) => setP({ ...p, ...patch });
  const setRule = (i, patch) => set({ included: p.included.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { name: p.name, description: p.description, price: Math.round(Number(p.price) * 100), interval: p.interval, discount_pct: Number(p.discount_pct) || 0,
      included: p.included.map((r) => ({ ...r, per_year: Number(r.per_year) })), min_age: p.min_age ?? null, max_age: p.max_age ?? null, active: p.active };
    if (p.id) await api.put(`/membership-plans/${p.id}`, body);
    else await api.post('/membership-plans', body);
    onSaved();
  });
  return (
    <Modal title={p.id ? `Edit ${plan.name}` : 'New membership plan'} onClose={onClose}>
      <ErrorBox error={error} />
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="form-grid">
          <label className="full">Name<input required value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Adult Care Club" /></label>
          <label>Price ($)<input required type="number" min="1" step="0.01" value={p.price} onChange={(e) => set({ price: e.target.value })} /></label>
          <label>Billed<select value={p.interval} onChange={(e) => set({ interval: e.target.value })}><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
          <label>Discount on other treatment (%)<input type="number" min="0" max="100" value={p.discount_pct} onChange={(e) => set({ discount_pct: e.target.value })} /></label>
          <label>Ages (optional)<span className="inline" style={{ gap: 6 }}><input type="number" min="0" placeholder="from" value={p.min_age ?? ''} onChange={(e) => set({ min_age: e.target.value === '' ? null : Number(e.target.value) })} /><input type="number" min="0" placeholder="to" value={p.max_age ?? ''} onChange={(e) => set({ max_age: e.target.value === '' ? null : Number(e.target.value) })} /></span></label>
        </div>
        <h3 style={{ marginBottom: 4 }}>Included each membership year</h3>
        {p.included.map((r, i) => (
          <div key={i} className="inline" style={{ gap: 6, marginBottom: 6 }}>
            <input style={{ flex: 2 }} value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} placeholder="Label" aria-label="Label" />
            <input style={{ flex: 2 }} value={r.codes} onChange={(e) => setRule(i, { codes: e.target.value })} placeholder="Codes, e.g. D1110" aria-label="Codes" />
            <input style={{ width: 70 }} type="number" min="1" value={r.per_year} onChange={(e) => setRule(i, { per_year: e.target.value })} aria-label="Times per year" title="Times per year" />
            <button type="button" className="small" onClick={() => set({ included: p.included.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
          </div>
        ))}
        <button type="button" className="small" onClick={() => set({ included: [...p.included, { label: '', codes: '', per_year: 1 }] })}>+ Included service</button>
        <label className="checkbox" style={{ marginTop: 10 }}><input type="checkbox" checked={p.active} onChange={(e) => set({ active: e.target.checked })} /> Offered to new members</label>
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save plan</button></div>
      </form>
    </Modal>
  );
}

// Patient overview: their membership, what's left this year, and billing.
export function MembershipCard({ patient, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(can('billing:read') ? `/patients/${patient.id}/membership` : null);
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  if (!data) return null;
  const m = data.current;
  const done = () => { setModal(null); reload(); onChange?.(); };
  const act = async (fn) => { setErr(null); try { await fn(); done(); } catch (e) { setErr(e); } };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Membership</h2>
        {!m && can('billing:write') && <button className="small" onClick={() => setModal('enroll')}>Enroll…</button>}
      </div>
      <ErrorBox error={err} />
      {!m ? <div className="muted" style={{ marginTop: 6 }}>Not a member.</div> : (
        <div style={{ marginTop: 6 }}>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <strong>{m.plan.name} · {per(m.plan)}</strong>
            <Badge value={m.status === 'past_due' ? 'past_due' : m.status === 'cancelled' ? 'cancelled' : 'active'} />
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Member since {fmtDate(m.start_date)}
            {m.status === 'cancelled' ? ` · benefits end ${fmtDate(m.paid_through)}` : ` · next bill ${fmtDate(m.next_bill_date)}`}
            {m.card ? ` · ${m.card.brand} •••• ${m.card.last4}${m.autopay ? '' : ' (autopay off)'}` : ' · no card — billed to the account'}
          </div>
          {m.billing_message && <div className="muted" style={{ fontSize: 12, color: m.status === 'past_due' ? 'var(--danger)' : undefined }}>{m.billing_message}</div>}
          {m.usage.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {m.usage.map((u) => (
                <div key={u.label} className="inline" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{u.label}</span><span>{Math.max(0, u.per_year - u.used)} of {u.per_year} left <span className="muted">(until {fmtDate(m.year.to)})</span></span>
                </div>
              ))}
            </div>
          )}
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{m.plan.discount_pct}% off other treatment · saved {money(m.savings)} so far</div>
          {can('billing:write') && m.status !== 'cancelled' && (
            <div className="inline" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="small" onClick={() => setModal('card')}>Card…</button>
              {m.status === 'past_due' && <button className="small" onClick={() => act(() => api.post(`/memberships/${m.id}/bill`))}>Try the card again</button>}
              {m.status === 'past_due' && <button className="small" onClick={() => act(() => api.post(`/memberships/${m.id}/settle`))}>Paid at the desk</button>}
              <AskButton className="small danger" danger label="Why? (optional)" submit="Cancel membership" hint={`Benefits continue until ${fmtDate(m.paid_through)}.`} onSubmit={(reason) => act(() => api.post(`/memberships/${m.id}/cancel`, { reason }))}>Cancel membership…</AskButton>
            </div>
          )}
        </div>
      )}
      {modal === 'enroll' && <Enroll patient={patient} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'card' && <ChangeCard patient={patient} membership={m} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

function CardSelect({ patient, value, onChange }) {
  const cards = useLookup(`/patients/${patient.id}/payment-methods`);
  return (
    <label>
      Card for automatic billing
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No card — bill to the account</option>
        {cards.map((c) => <option key={c.id} value={c.id}>{c.brand} •••• {c.last4} (exp {c.exp_month}/{c.exp_year})</option>)}
      </select>
      {!cards.length && <span className="muted" style={{ fontSize: 12 }}>Save a card from the Ledger tab first to bill it automatically.</span>}
    </label>
  );
}

function Enroll({ patient, onClose, onDone }) {
  const plans = useLookup('/membership-plans');
  const [planId, setPlanId] = useState('');
  const [card, setCard] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    const r = await api.post(`/patients/${patient.id}/memberships`, { plan_id: Number(planId), payment_method_id: card ? Number(card) : null });
    if (r.billing?.some((b) => b.declined)) toast(`${fullName(patient)} is enrolled, but the card was declined: ${r.billing.find((b) => b.declined).reason}`, { tone: 'error', ms: 12000 });
    onDone();
  });
  const plan = plans.find((p) => p.id === Number(planId));
  return (
    <Modal title={`Enroll ${patient.first_name} in a membership`} onClose={onClose}>
      <ErrorBox error={error} />
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="form-grid">
          <label className="full">
            Plan
            <select required value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Choose…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {per(p)}</option>)}
            </select>
          </label>
          <CardSelect patient={patient} value={card} onChange={setCard} />
        </div>
        {plan && <p className="muted" style={{ fontSize: 13 }}>The first {plan.interval === 'year' ? 'year' : 'month'} ({money(plan.price)}) is billed today{card ? ' and charged to the card' : ' to the account'}. Includes {plan.included.map((r) => `${r.label.toLowerCase()} ×${r.per_year}`).join(', ') || 'no services'} a year and {plan.discount_pct}% off other treatment.</p>}
        {!plans.length && <p className="muted">No membership plans yet — an administrator can add them in Settings → Membership plans.</p>}
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !planId}>Enroll</button></div>
      </form>
    </Modal>
  );
}

function ChangeCard({ patient, membership, onClose, onDone }) {
  const [card, setCard] = useState(membership.card?.id ? String(membership.card.id) : '');
  const [autopay, setAutopay] = useState(!!membership.autopay);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/memberships/${membership.id}`, { payment_method_id: card ? Number(card) : null, autopay });
    onDone();
  });
  return (
    <Modal title="Membership billing" onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <CardSelect patient={patient} value={card} onChange={setCard} />
        <label className="checkbox"><input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} /> Charge the card automatically</label>
      </div>
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={submit}>Save</button></div>
    </Modal>
  );
}

// Reports → Memberships.
export function MembershipReport() {
  const { data } = useApi('/reports/memberships');
  if (!data) return <div className="card">Loading…</div>;
  const stat = (label, value) => <div className="card stat" style={{ margin: 0 }}><div className="label">{label}</div><div className="value">{value}</div></div>;
  return (
    <>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Memberships · {fmtDate(data.from)} – {fmtDate(data.to)}</h2>
          <span className="inline"><CsvButton name="members" rows={data.members} columns={[['First name', (m) => m.first_name], ['Last name', (m) => m.last_name], ['Plan', (m) => m.plan_name], ['Since', (m) => m.start_date], ['Next bill', (m) => m.next_bill_date || ''], ['Status', (m) => m.status], ['Card on file', (m) => (m.payment_method_id ? 'yes' : 'no')]]} /><PrintButton /></span>
        </div>
        <div className="grid grid-4" style={{ gap: 12 }}>
          {stat('Active members', data.active)}
          {stat('Monthly recurring', money(data.monthly_recurring))}
          {stat('Joined / cancelled', `${data.joined} / ${data.cancelled}`)}
          {stat('Past due', data.past_due)}
          {stat('Fees billed', money(data.fees_billed))}
          {stat('Member savings given', money(data.member_savings))}
          {stat('Member treatment', money(data.member_production))}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Member</th><th>Plan</th><th>Since</th><th>Next bill</th><th>Status</th></tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td><a href={`/patients/${m.patient_id}`}>{m.first_name} {m.last_name}</a></td>
                <td>{m.plan_name} · {per(m)}</td>
                <td>{fmtDate(m.start_date)}</td>
                <td>{fmtDate(m.next_bill_date)}{!m.payment_method_id && <span className="muted"> · no card</span>}</td>
                <td><Badge value={m.status} />{m.billing_message && m.status === 'past_due' && <div className="muted" style={{ fontSize: 12 }}>{m.billing_message}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.members.length === 0 && <div className="empty">No members yet.</div>}
      </div>
    </>
  );
}
