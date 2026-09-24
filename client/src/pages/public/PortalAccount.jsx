import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, CreditCard, Landmark, Receipt, Users } from 'lucide-react';
import { money } from '../../format.js';
import { ErrorBox } from '../../components/ui.jsx';
import { fmtDateL, fmtTimeL, useLang } from './i18n.js';
import { useBT } from './billing-i18n.js';
import './billpay.css';

// Patient portal 2.0 (PT1, PT2): the account at a glance — what you owe now and why, in plain words; each visit's
// charges, insurance and payments; the household for the head of household; statements and receipts; paying by
// card, Apple Pay / Google Pay, bank or a saved card; saved cards, autopay and payment plans.
// docs/workflows/specs/PT-portal.md. Money is always what the server worked out from the ledger.

const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
async function call(method, path, body, token, { key } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, details: data.details });
  return data;
}
async function download(path, token, name) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const shortDate = (lang, s) => fmtDateL(lang, s, { month: 'short', day: 'numeric', year: 'numeric' });
const cardName = (t, c) => `${c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : t('Card')} •••• ${c.last4}`;
const minus = (c) => `−${money(c)}`;

export default function PortalAccount({ token, onSignOut, returned }) {
  const t = useBT();
  const [acct, setAcct] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = useCallback(async () => {
    try {
      setAcct(await call('GET', '/portal/account', null, token));
    } catch (e) {
      if (e.status === 401) onSignOut();
      else setError(e);
    }
  }, [token, onSignOut]);
  useEffect(() => { load(); }, [load]);
  // Back from the card processor's page: make sure it's posted, then say so.
  useEffect(() => {
    if (!returned?.session_id) return;
    call('GET', `/portal/billing/return?session_id=${encodeURIComponent(returned.session_id)}`, null, token)
      .then((r) => { setNotice(r.status === 'paid' ? t('Thank you — your payment of {amount} is on your account.', { amount: money(r.amount) }) : t('Thank you — your bank payment is on its way. It takes a few business days to clear.')); load(); })
      .catch(() => setNotice(t('Thank you — your payment was received and will show on your account shortly.')));
  }, [returned?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg) => { setNotice(msg); setError(null); load(); };
  if (!acct) return error ? <ErrorBox error={error} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <>
      {notice && <div className="public-notice ok bp-notice" role="status">{notice}</div>}
      <ErrorBox error={error} />
      <BalanceCard acct={acct} token={token} onPaid={done} />
      {acct.members.length > 1 && <Household acct={acct} token={token} />}
      <VisitsCard acct={acct} />
      {acct.treatment_plans.length > 0 && <PlansCard acct={acct} />}
      <PapersCard acct={acct} token={token} onError={setError} onDone={done} />
      {acct.is_guarantor && acct.payment.enabled && <CardsAndPlans acct={acct} token={token} onDone={done} onError={setError} />}
    </>
  );
}

// "You owe", in plain words, with where the rest of the balance is.
function Explain({ s, t }) {
  const pending = s.pending_insurance + s.pending_write_off;
  if (s.balance < 0) return <p>{t('You have a credit of {amount}. We’ll use it toward your next visit, or you can ask us for a refund.', { amount: money(-s.balance) })}</p>;
  if (s.balance === 0) return <p>{t('You’re all paid up. Thank you!')}</p>;
  return (
    <>
      <p>
        {pending > 0 && s.your_portion > 0 && t('Your account balance is {balance}. We’re still waiting on your insurance for {pending}, so what you owe now is {due}.', { balance: money(s.balance), pending: money(pending), due: money(s.your_portion) })}
        {pending > 0 && s.your_portion === 0 && t('Your account balance is {balance}, and we’re waiting on your insurance for all of it. Nothing is due from you right now — we’ll let you know if insurance pays less than expected.', { balance: money(s.balance) })}
        {pending === 0 && t('This is what’s left after insurance and your payments.')}
      </p>
      {s.pending_write_off > 0 && <p className="muted bp-small">{t('{amount} of the insurance part is your in-network discount, which comes off when the claim is paid.', { amount: money(s.pending_write_off) })}</p>}
    </>
  );
}

function BalanceCard({ acct, token, onPaid }) {
  const t = useBT();
  const s = acct.summary;
  const [paying, setPaying] = useState(false);
  const headingId = useId();
  return (
    <section className="card bp-balance" aria-labelledby={headingId}>
      <h2 id={headingId}>{s.balance < 0 ? t('Credit on your account') : t('You owe now')}</h2>
      <div className="bp-amount" data-testid="amount-due">{money(s.balance < 0 ? -s.balance : s.your_portion)}</div>
      <Explain s={s} t={t} />
      <dl className="bp-split">
        <div><dt>{t('Account balance')}</dt><dd>{money(s.balance)}</dd></div>
        {s.pending_insurance > 0 && <div><dt>{t('Waiting on insurance')}</dt><dd>{minus(s.pending_insurance)}</dd></div>}
        {s.pending_write_off > 0 && <div><dt>{t('In-network discount to come')}</dt><dd>{minus(s.pending_write_off)}</dd></div>}
        <div className="bp-split-total"><dt>{t('Your portion')}</dt><dd>{money(s.your_portion)}</dd></div>
      </dl>
      {acct.plans.map((p) => (
        <div key={p.id} className="bp-plan">
          <strong>{t('Payment plan')}</strong> · {t('{paid} paid, {left} left', { paid: money(p.paid), left: money(p.remaining) })}
          {p.next_due_date && <div className="muted bp-small">{t('Next {amount} due {date}', { amount: money(p.next_due_amount), date: p.next_due_date })}{p.autopay_card_id ? ` — ${t('paid automatically')}` : ''}</div>}
        </div>
      ))}
      {acct.payment.enabled && acct.payment.max > 0 && (paying
        ? <PayForm acct={acct} token={token} onCancel={() => setPaying(false)} onPaid={(msg) => { setPaying(false); onPaid(msg); }} />
        : <button className="primary big" onClick={() => setPaying(true)}>{s.your_portion > 0 ? t('Pay {amount}', { amount: money(s.your_portion) }) : t('Make a payment')}</button>)}
      {!acct.payment.enabled && s.your_portion > 0 && <p className="muted bp-small">{t('To pay, call the office or pay at your next visit.')}</p>}
      {!acct.is_guarantor && acct.payer_name && <p className="muted bp-small">{t('Payments go to your family’s account ({name}).', { name: acct.payer_name })}</p>}
    </section>
  );
}

// Pay the amount due or another amount: saved card (one tap), a new card (with Apple Pay / Google Pay on
// Stripe's page), or a bank account. Sandbox shows the test numbers instead of Stripe's page.
export function PayForm({ acct, token, onPaid, onCancel, path = '/portal/billing/pay', lookup = false }) {
  const t = useBT();
  const lang = useLang();
  const p = acct.payment;
  const suggested = p.suggested > 0 ? p.suggested : Math.min(p.max, 5000);
  const cards = acct.cards || [];
  const [amountMode, setAmountMode] = useState('due');
  const [other, setOther] = useState('');
  const [how, setHow] = useState(cards.length ? `saved:${cards[0].id}` : 'card');
  const [save, setSave] = useState(false);
  const [receipt, setReceipt] = useState(true);
  const [testCard, setTestCard] = useState('4242 4242 4242 4242');
  const [testBank, setTestBank] = useState('000123456789');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // One key per payment attempt: a double tap or a retry after a dropped connection can't pay twice.
  const [key, setKey] = useState(newKey);
  const amount = amountMode === 'due' ? suggested : Math.round(Number(String(other).replace(/[$,\s]/g, '')) * 100);
  const valid = Number.isFinite(amount) && amount >= 50 && amount <= p.max;
  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return setError(new Error(t('Enter an amount from $0.50 to {max}', { max: money(p.max) })));
    setBusy(true);
    setError(null);
    try {
      const saved = how.startsWith('saved:');
      const body = {
        amount, how: saved ? 'saved' : 'new', card_id: saved ? Number(how.slice(6)) : undefined, method: how === 'ach' ? 'ach' : 'card', save_card: !saved && how === 'card' && save, receipt, lang,
        ...(p.mode === 'sandbox' && how === 'card' ? { card_number: testCard } : {}), ...(p.mode === 'sandbox' && how === 'ach' ? { account_number: testBank } : {}),
      };
      const r = await call('POST', path, body, token, { key });
      if (r.url) { window.location.href = r.url; return; }
      onPaid(t('Thank you — your payment of {amount} is on your account.', { amount: money(r.amount) }), r);
    } catch (err) {
      setError(err);
      setKey(newKey()); // a declined card can be tried again (or another one) as a new attempt
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="bp-pay" onSubmit={submit} aria-label={t('Make a payment')}>
      <fieldset>
        <legend>{t('How much?')}</legend>
        <label className="bp-choice"><input type="radio" name="amt" checked={amountMode === 'due'} onChange={() => setAmountMode('due')} /> {p.suggested > 0 ? t('Amount due: {amount}', { amount: money(suggested) }) : money(suggested)}</label>
        <label className="bp-choice">
          <input type="radio" name="amt" checked={amountMode === 'other'} onChange={() => setAmountMode('other')} /> {t('Another amount')}
          {amountMode === 'other' && <input className="bp-other" inputMode="decimal" autoFocus aria-label={t('Amount in dollars')} placeholder="$0.00" value={other} onChange={(e) => setOther(e.target.value)} />}
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('Pay with')}</legend>
        {cards.map((c) => (
          <label key={c.id} className="bp-choice"><input type="radio" name="how" checked={how === `saved:${c.id}`} onChange={() => setHow(`saved:${c.id}`)} /> <CreditCard size={16} aria-hidden /> {t('Saved card {card}', { card: cardName(t, c) })}</label>
        ))}
        <label className="bp-choice"><input type="radio" name="how" checked={how === 'card'} onChange={() => setHow('card')} /> <CreditCard size={16} aria-hidden /> {p.wallets ? t('Card, Apple Pay or Google Pay') : t('Card')}</label>
        {p.ach && <label className="bp-choice"><input type="radio" name="how" checked={how === 'ach'} onChange={() => setHow('ach')} /> <Landmark size={16} aria-hidden /> {t('Bank account (ACH)')}</label>}
      </fieldset>
      {p.mode === 'sandbox' && how === 'card' && (
        <label className="bp-test">{t('Test card (sandbox — no real card is charged)')}<input inputMode="numeric" value={testCard} onChange={(e) => setTestCard(e.target.value)} /><span className="muted bp-small">{t('4242… approves; 4000 0000 0000 0002 is declined.')}</span></label>
      )}
      {p.mode === 'sandbox' && how === 'ach' && (
        <label className="bp-test">{t('Test bank account (sandbox)')}<input inputMode="numeric" value={testBank} onChange={(e) => setTestBank(e.target.value)} /><span className="muted bp-small">{t('000123456789 clears; 000111111116 is refused.')}</span></label>
      )}
      {p.mode === 'stripe' && !how.startsWith('saved:') && <p className="muted bp-small">{t('You’ll enter your details on our card processor’s secure page (Stripe) and come right back.')}</p>}
      {!lookup && acct.payment.can_save_card && how === 'card' && <label className="bp-check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {t('Save this card for next time')}</label>}
      {p.email_on_file !== false && <label className="bp-check"><input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} /> {t('Email me a receipt')}</label>}
      <ErrorBox error={error} />
      <div className="bp-actions">
        <button className="primary big" disabled={busy}>{busy ? t('Paying…') : t('Pay {amount}', { amount: valid ? money(amount) : '' })}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>{t('Not now')}</button>}
      </div>
    </form>
  );
}

function Household({ acct, token }) {
  const t = useBT();
  const lang = useLang();
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const show = async (m) => {
    if (open === m.id) { setOpen(null); return; }
    setOpen(m.id);
    setDetail(null);
    setDetail(await call('GET', `/portal/account/members/${m.id}`, null, token).catch(() => null));
  };
  return (
    <section className="card">
      <h2><Users size={18} aria-hidden /> {t('Your family')}</h2>
      <ul className="bp-list">
        {acct.members.map((m) => (
          <li key={m.id}>
            <button type="button" className="bp-row" aria-expanded={open === m.id} onClick={() => show(m)}>
              <span>
                <strong>{m.first_name}{m.is_you ? ` (${t('you')})` : ''}</strong>
                <span className="muted bp-small">{m.next_visit ? t('Next visit {date}', { date: shortDate(lang, m.next_visit) }) : t('No visit scheduled')}{m.last_visit ? ` · ${t('last seen {date}', { date: shortDate(lang, m.last_visit) })}` : ''}</span>
              </span>
              <span className="bp-num">{money(m.your_portion)}{m.pending_insurance > 0 && <span className="muted bp-small">{t('+{amount} with insurance', { amount: money(m.pending_insurance) })}</span>}</span>
            </button>
            {open === m.id && (detail ? (
              <div className="bp-member">
                {detail.visits.length === 0 && <p className="muted">{t('No visits yet.')}</p>}
                {detail.visits.map((v) => <div key={v.id} className="bp-small">{shortDate(lang, v.start_time)} {fmtTimeL(lang, v.start_time)} · {v.reason || t('Visit')} · {v.provider_name} <span className="muted">({t(v.status)})</span></div>)}
              </div>
            ) : <p className="muted bp-small">{t('Loading…')}</p>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Each visit: what it cost, what insurance paid (or is still expected to), discounts, what you paid, what's left.
function VisitsCard({ acct }) {
  const t = useBT();
  const lang = useLang();
  const [open, setOpen] = useState(() => new Set(acct.visits.filter((v) => v.totals.open > 0).slice(0, 2).map((v) => `${v.patient_id}:${v.key}`)));
  const family = acct.members.length > 1;
  const toggle = (k) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <section className="card">
      <h2>{t('Charges and payments by visit')}</h2>
      {acct.visits.length === 0 && <p className="muted">{t('No charges yet.')}</p>}
      <ul className="bp-list">
        {acct.visits.map((v) => {
          const k = `${v.patient_id}:${v.key}`;
          const T = v.totals;
          return (
            <li key={k}>
              <button type="button" className="bp-row" aria-expanded={open.has(k)} onClick={() => toggle(k)}>
                <span>{open.has(k) ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />} <strong>{shortDate(lang, v.date)}</strong>{family ? ` · ${v.patient_name}` : ''}<span className="muted bp-small">{v.reason ? ` ${v.reason}` : ''}{v.provider_name ? ` · ${v.provider_name}` : ''}</span></span>
                <span className="bp-num">{T.patient_owes > 0 ? money(T.patient_owes) : T.waiting_on_insurance > 0 ? t('Waiting on insurance') : t('Paid')}</span>
              </button>
              {open.has(k) && (
                <div className="bp-visit">
                  <table>
                    <caption className="bp-sr">{t('Visit on {date}', { date: shortDate(lang, v.date) })}</caption>
                    <tbody>
                      {v.lines.map((l) => <tr key={l.ledger_entry_id}><th scope="row">{l.description}</th><td className="bp-num">{money(l.charged)}</td></tr>)}
                      {T.insurance_paid > 0 && <tr><th scope="row">{t('Insurance paid')}</th><td className="bp-num">{minus(T.insurance_paid)}</td></tr>}
                      {T.write_off > 0 && <tr><th scope="row">{t('In-network discount')}</th><td className="bp-num">{minus(T.write_off)}</td></tr>}
                      {T.adjusted > 0 && <tr><th scope="row">{t('Adjustments')}</th><td className="bp-num">{minus(T.adjusted)}</td></tr>}
                      {T.patient_paid > 0 && <tr><th scope="row">{t('You paid')}</th><td className="bp-num">{minus(T.patient_paid)}</td></tr>}
                      {T.waiting_on_insurance > 0 && <tr><th scope="row">{t('Waiting on insurance')}</th><td className="bp-num">{money(T.waiting_on_insurance)}</td></tr>}
                      <tr className="bp-split-total"><th scope="row">{t('Left for you to pay')}</th><td className="bp-num">{money(T.patient_owes)}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {acct.summary.unapplied_credit > 0 && <p className="muted bp-small">{t('Plus a credit of {amount} not yet used for a visit.', { amount: money(acct.summary.unapplied_credit) })}</p>}
    </section>
  );
}

function PlansCard({ acct }) {
  const t = useBT();
  return (
    <section className="card">
      <h2>{t('Treatment plans')}</h2>
      {acct.treatment_plans.map((tp) => (
        <details key={tp.id} className="bp-tp">
          <summary>
            <strong>{tp.name || t('Treatment plan')}</strong>{acct.members.length > 1 ? ` · ${tp.patient_name}` : ''}
            <span className="bp-num">{t('your estimate {amount}', { amount: money(tp.your_estimate) })}</span>
          </summary>
          <table>
            <thead><tr><th scope="col">{t('Treatment')}</th><th scope="col" className="bp-num">{t('Fee')}</th><th scope="col" className="bp-num">{t('Insurance (est.)')}</th><th scope="col" className="bp-num">{t('You (est.)')}</th></tr></thead>
            <tbody>
              {tp.procedures.map((p) => <tr key={p.id}><td>{p.description}{p.tooth ? ` #${p.tooth}` : ''}</td><td className="bp-num">{money(p.fee)}</td><td className="bp-num">{money(p.insurance)}</td><td className="bp-num">{money(p.your_part)}</td></tr>)}
              <tr className="bp-split-total"><td>{t('Total')}</td><td className="bp-num">{money(tp.total_fee)}</td><td className="bp-num">{money(tp.insurance_estimate)}</td><td className="bp-num">{money(tp.your_estimate)}</td></tr>
            </tbody>
          </table>
          <p className="muted bp-small">{t('Estimates: your insurance decides what it pays when the claim is sent.')}</p>
        </details>
      ))}
    </section>
  );
}

function PapersCard({ acct, token, onError, onDone }) {
  const t = useBT();
  const lang = useLang();
  const how = { email: t('emailed'), mail: t('mailed'), print: t('printed'), sent: t('sent') };
  return (
    <section className="card">
      <h2><Receipt size={18} aria-hidden /> {t('Statements and receipts')}</h2>
      <button className="small" onClick={() => download('/portal/statement.pdf', token, 'statement.pdf').catch(onError)}>{t('Download your current statement (PDF)')}</button>
      {acct.statements.length > 0 && (
        <ul className="bp-list bp-small">
          {acct.statements.map((s) => <li key={s.id} className="bp-line"><span>{t('Statement {date}', { date: shortDate(lang, s.date) })} · {how[s.method] || s.method}</span><span className="bp-num">{money(s.amount)}</span></li>)}
        </ul>
      )}
      <h3 className="bp-h3">{t('Payments')}</h3>
      {acct.receipts.length === 0 && <p className="muted bp-small">{t('No payments yet.')}</p>}
      <ul className="bp-list">
        {acct.receipts.slice(0, 12).map((r) => (
          <li key={r.id} className="bp-line">
            <span>{shortDate(lang, r.entry_date)} · {money(-r.amount)} <span className="muted bp-small">{String(r.method || '').replace(/_/g, ' ')}</span></span>
            <span className="bp-actions-inline">
              <button className="link" onClick={() => download(`/portal/receipts/${r.id}.pdf`, token, `receipt-${r.id}.pdf`).catch(onError)}>{t('Receipt')}</button>
              {acct.payment.email_on_file && <button className="link" onClick={() => call('POST', `/portal/billing/receipts/${r.id}/email`, {}, token, { key: newKey() }).then(() => onDone(t('The receipt is on its way to your email.'))).catch(onError)}>{t('Email it')}</button>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardsAndPlans({ acct, token, onDone, onError }) {
  const t = useBT();
  const [adding, setAdding] = useState(false);
  const [num, setNum] = useState('4242 4242 4242 4242');
  const [months, setMonths] = useState(acct.plan_choices[1]?.months ?? acct.plan_choices[0]?.months ?? null);
  const [planCard, setPlanCard] = useState(acct.cards[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const addCard = () => run(async () => {
    const r = await call('POST', '/portal/billing/cards', acct.payment.mode === 'sandbox' ? { card_number: num } : {}, token, { key: newKey() });
    if (r.url) { window.location.href = r.url; return; }
    setAdding(false);
    onDone(t('Card saved.'));
  });
  const remove = (c) => run(async () => {
    const r = await call('DELETE', `/portal/billing/cards/${c.id}`, null, token, { key: newKey() });
    onDone(r.autopay_stopped ? t('Card removed. Automatic payments for your plan are off until you choose another card.') : t('Card removed.'));
  });
  const choice = acct.plan_choices.find((c) => c.months === Number(months));
  return (
    <section className="card">
      <h2><CreditCard size={18} aria-hidden /> {t('Saved cards and automatic payments')}</h2>
      {acct.cards.length === 0 && <p className="muted bp-small">{t('No saved cards. Cards are kept by our card processor — we never store the number.')}</p>}
      <ul className="bp-list">
        {acct.cards.map((c) => (
          <li key={c.id} className="bp-line">
            <span>{cardName(t, c)} <span className="muted bp-small">{t('expires {m}/{y}', { m: c.exp_month, y: String(c.exp_year).slice(-2) })}</span></span>
            <button className="link" disabled={busy} onClick={() => remove(c)}>{t('Remove')}</button>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="bp-inline-form">
          {acct.payment.mode === 'sandbox' && <label className="bp-test">{t('Test card (sandbox)')}<input inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} /></label>}
          <button className="primary small" disabled={busy} onClick={addCard}>{acct.payment.mode === 'sandbox' ? t('Save card') : t('Continue to the secure card page')}</button>
          <button className="link" onClick={() => setAdding(false)}>{t('Cancel')}</button>
        </div>
      ) : <button className="small" onClick={() => setAdding(true)}>{t('Add a card')}</button>}

      {acct.plans.map((p) => (
        <div key={p.id} className="bp-plan">
          <strong>{t('Payment plan autopay')}</strong>
          <select aria-label={t('Card for automatic payments')} value={p.autopay_card_id ?? ''} disabled={busy} onChange={(e) => run(async () => {
            await call('PUT', `/portal/billing/plans/${p.id}/autopay`, { card_id: e.target.value ? Number(e.target.value) : null }, token, { key: newKey() });
            onDone(e.target.value ? t('Automatic payments are on.') : t('Automatic payments are off. Please pay each installment by its due date.'));
          })}>
            <option value="">{t('Off — I’ll pay each time')}</option>
            {acct.cards.map((c) => <option key={c.id} value={c.id}>{cardName(t, c)}</option>)}
          </select>
          {p.autopay_message && <div className="muted bp-small">{p.autopay_message}</div>}
        </div>
      ))}

      {acct.plans.length === 0 && acct.plan_choices.length > 0 && (
        <div className="bp-plan">
          <strong>{t('Spread your balance over a few months')}</strong>
          <p className="muted bp-small">{t('No interest. A down payment today, then the same amount each month, charged automatically to your saved card.')}</p>
          <div className="bp-plan-choices" role="radiogroup" aria-label={t('Number of months')}>
            {acct.plan_choices.map((c) => (
              <label key={c.months} className={`bp-choice-box${Number(months) === c.months ? ' on' : ''}`}>
                <input type="radio" name="months" checked={Number(months) === c.months} onChange={() => setMonths(c.months)} />
                <strong>{t('{n} months', { n: c.months })}</strong>
                <span>{t('{amount}/month', { amount: money(c.monthly) })}</span>
              </label>
            ))}
          </div>
          {choice && <p className="bp-small">{t('{down} today, then {n} payments of about {monthly}, starting in {days} days. Total {total}.', { down: money(choice.down_payment), n: choice.months, monthly: money(choice.monthly), days: acct.plan_first_payment_days ?? 30, total: money(choice.total) })}</p>}
          {acct.cards.length ? (
            <div className="bp-inline-form">
              <select aria-label={t('Card for automatic payments')} value={planCard ?? ''} onChange={(e) => setPlanCard(Number(e.target.value))}>{acct.cards.map((c) => <option key={c.id} value={c.id}>{cardName(t, c)}</option>)}</select>
              <button className="primary small" disabled={busy || !choice} onClick={() => run(async () => {
                await call('POST', '/portal/billing/plans', { months: choice.months, card_id: planCard }, token, { key: newKey() });
                onDone(t('Your payment plan is set up. We’ll email a receipt for today’s payment.'));
              })}>{t('Set up my plan')}</button>
            </div>
          ) : <p className="muted bp-small">{t('Add a card above to set up a plan.')}</p>}
        </div>
      )}
    </section>
  );
}
