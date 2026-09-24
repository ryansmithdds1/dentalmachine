import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../api.js';
import { money } from '../format.js';
import { ErrorBox, useSubmit } from './ui.jsx';
import { toast } from '../toast.js';
import { LENDER_NAMES } from './patient/FinOptionCards.jsx';
import './patient/finoptions.css';

// Financial options (F5): what patients are offered and the limits around it. Only an administrator saves;
// the server checks every guardrail again (finoptions.js cleanSettings) and keeps before/after in the audit log.
// Amounts are typed in dollars here and stored in cents.
const d2c = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
const c2d = (c) => (c == null ? '' : String(c / 100));

export default function FinOptionsSettings({ onSaved }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/fin-options/settings').then((r) => setS(r.settings)).catch(setErr); }, []);
  const { submit, busy, error } = useSubmit(async () => {
    const out = await api.put('/fin-options/settings', { settings: s });
    setS(out.settings);
    toast('Financial options saved');
    onSaved?.();
  });
  if (err) return <ErrorBox error={err} />;
  if (!s) return <div className="muted">Loading…</div>;
  const set = (path, v) => {
    const next = structuredClone(s);
    let o = next;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = v;
    setS(next);
  };
  const setLender = (i, k, v) => set(['lenders', i, k], v);
  const num = (v) => (v === '' ? '' : Number(v));
  return (
    <form className="fin-settings" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <h3 style={{ marginTop: 0 }}>What patients see</h3>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 14 }}>
        {[['pay_in_full', 'Pay in full'], ['in_office', 'Monthly with us'], ['lenders', 'Outside financing'], ['membership', 'Membership (no insurance)'], ['ppo_savings', 'PPO in-network savings']].map(([k, l]) => (
          <label key={k} className="checkbox"><input type="checkbox" checked={!!s.show[k]} onChange={(e) => set(['show', k], e.target.checked)} /> {l}</label>
        ))}
      </div>

      <h3>Discounts and interest limits</h3>
      <div className="form-grid">
        <label>Largest total discount (%)<input type="number" min="0" max="50" step="0.5" value={s.max_discount_pct} onChange={(e) => set(['max_discount_pct'], num(e.target.value))} /></label>
        <label>Highest APR allowed (%)<input type="number" min="0" max="36" step="0.01" value={s.max_apr} onChange={(e) => set(['max_apr'], num(e.target.value))} /></label>
      </div>

      <h3>Pay in full</h3>
      <div className="form-grid">
        <label>Prepay discount (%)<input type="number" min="0" max="50" step="0.5" value={s.prepay.pct} onChange={(e) => set(['prepay', 'pct'], num(e.target.value))} /></label>
        <label>
          Offer it to
          <select value={s.prepay.allowed} onChange={(e) => set(['prepay', 'allowed'], e.target.value)}>
            <option value="always">Everyone</option>
            <option value="self_pay">Patients without insurance only</option>
            <option value="never">No one</option>
          </select>
        </label>
        <label>Only on amounts from ($)<input type="number" min="0" step="1" value={c2d(s.prepay.min_amount)} onChange={(e) => set(['prepay', 'min_amount'], d2c(e.target.value) ?? 0)} /></label>
        <label>Largest discount ($, optional)<input type="number" min="0" step="1" value={c2d(s.prepay.max_discount)} onChange={(e) => set(['prepay', 'max_discount'], d2c(e.target.value))} /></label>
      </div>

      <h3>Monthly with us</h3>
      <div className="form-grid">
        <label>Months to offer<input value={Array.isArray(s.in_office.months) ? s.in_office.months.join(', ') : s.in_office.months} onChange={(e) => set(['in_office', 'months'], e.target.value)} placeholder="3, 6, 12" /></label>
        <label>Longest plan (months)<input type="number" min="1" max="60" value={s.in_office.max_months} onChange={(e) => set(['in_office', 'max_months'], num(e.target.value))} /></label>
        <label>APR (%)<input type="number" min="0" step="0.01" value={s.in_office.apr} onChange={(e) => set(['in_office', 'apr'], num(e.target.value))} /></label>
        <label>Set-up fee ($)<input type="number" min="0" step="0.01" value={c2d(s.in_office.setup_fee)} onChange={(e) => set(['in_office', 'setup_fee'], d2c(e.target.value) ?? 0)} /></label>
        <label>Minimum down payment (%)<input type="number" min="0" max="100" value={s.in_office.min_down_pct} onChange={(e) => set(['in_office', 'min_down_pct'], num(e.target.value))} /></label>
        <label>…and at least ($)<input type="number" min="0" step="1" value={c2d(s.in_office.min_down)} onChange={(e) => set(['in_office', 'min_down'], d2c(e.target.value) ?? 0)} /></label>
        <label>Only on amounts from ($)<input type="number" min="0" step="1" value={c2d(s.in_office.min_amount)} onChange={(e) => set(['in_office', 'min_amount'], d2c(e.target.value) ?? 0)} /></label>
        <label>First payment after (days)<input type="number" min="0" max="90" value={s.in_office.first_payment_days} onChange={(e) => set(['in_office', 'first_payment_days'], num(e.target.value))} /></label>
      </div>

      <h3>Outside financing — promotional terms</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Shown only when the lender has an application link (Settings → Practice → Financing, or the link here). Check the terms against your merchant agreement — lenders change them.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Lender</th><th>Label patients see</th><th>Months</th><th>Type</th><th>APR %</th><th>Standard APR %</th><th>From $</th><th>Up to $</th><th>On</th><th /></tr></thead>
          <tbody>
            {s.lenders.map((l, i) => (
              <tr key={i}>
                <td><select aria-label="Lender" value={l.lender} onChange={(e) => setLender(i, 'lender', e.target.value)}>{Object.entries(LENDER_NAMES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></td>
                <td><input aria-label="Label" value={l.label} onChange={(e) => setLender(i, 'label', e.target.value)} /></td>
                <td><input aria-label="Months" type="number" min="1" max="120" value={l.months} onChange={(e) => setLender(i, 'months', num(e.target.value))} style={{ width: 64 }} /></td>
                <td>
                  <select aria-label="Type" value={l.type} onChange={(e) => setLender(i, 'type', e.target.value)}>
                    <option value="deferred">No interest if paid in time</option>
                    <option value="fixed">Equal payments at APR</option>
                  </select>
                </td>
                <td><input aria-label="APR" type="number" min="0" step="0.01" disabled={l.type === 'deferred'} value={l.type === 'deferred' ? 0 : l.apr} onChange={(e) => setLender(i, 'apr', num(e.target.value))} style={{ width: 70 }} /></td>
                <td><input aria-label="Standard APR" type="number" min="0" step="0.01" value={l.standard_apr ?? ''} onChange={(e) => setLender(i, 'standard_apr', e.target.value === '' ? null : Number(e.target.value))} style={{ width: 70 }} /></td>
                <td><input aria-label="Minimum" type="number" min="0" value={c2d(l.min_amount)} onChange={(e) => setLender(i, 'min_amount', d2c(e.target.value) ?? 0)} style={{ width: 80 }} /></td>
                <td><input aria-label="Maximum" type="number" min="0" value={c2d(l.max_amount)} onChange={(e) => setLender(i, 'max_amount', d2c(e.target.value))} style={{ width: 80 }} /></td>
                <td><input aria-label="Offer this term" type="checkbox" checked={l.enabled !== false} onChange={(e) => setLender(i, 'enabled', e.target.checked)} /></td>
                <td><button type="button" className="small" aria-label="Remove this term" onClick={() => set(['lenders'], s.lenders.filter((_, j) => j !== i))}><X size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="small" style={{ marginTop: 8 }} onClick={() => set(['lenders'], [...s.lenders, { lender: 'carecredit', label: '12 months, no interest if paid in full', months: 12, apr: 0, type: 'deferred', standard_apr: 32.99, min_amount: 20000, max_amount: null, apply_url: null, enabled: true }])}><Plus size={14} /> Add a term</button>
      <p className="muted" style={{ fontSize: 12.5 }}>Example: {money(250000)} at 17.90% over 48 months is {money(7331)} a month.</p>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
      <Insights />
    </form>
  );
}

// What patients are told when options are compared (F6): likely next steps, longevity, pros and cons per code or
// code prefix. Starter wording is marked until the office saves its own. One line per pro/con; next steps as
// "Plain words: D6010 D6065", one per line.
function Insights() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/procedure-insights').then(setList).catch(setErr); }, []);
  const edit = (i) => { setOpen(i.code); setDraft({ longevity: i.longevity || '', pros: i.pros.join('\n'), cons: i.cons.join('\n'), next: i.next.map((n) => `${n.label}: ${n.codes.join(' ')}`).join('\n') }); };
  const save = async (code) => {
    setErr(null);
    try {
      const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
      const saved = await api.put(`/procedure-insights/${code}`, {
        longevity: draft.longevity, pros: lines(draft.pros), cons: lines(draft.cons),
        next_steps: lines(draft.next).map((l) => { const at = l.lastIndexOf(':'); return { label: l.slice(0, at).trim(), codes: l.slice(at + 1).trim() }; }),
      });
      setList(list.map((x) => (x.code === code ? saved : x)));
      setOpen(null);
      toast(`Saved what patients are told about ${code}`);
    } catch (e) { setErr(e); }
  };
  if (!list) return err ? <ErrorBox error={err} /> : null;
  return (
    <div style={{ marginTop: 18 }}>
      <h3>What patients are told when options are compared</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Plain words shown on the patient’s screen beside each option. Starter wording is ours — review it before use; once you save, it’s yours.</p>
      <ErrorBox error={err} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Lasts</th><th>Pros / cons</th><th>Likely next step</th><th /></tr></thead>
          <tbody>
            {list.map((i) => (open === i.code ? (
              <tr key={i.code}>
                <td><strong>{i.code}</strong></td>
                <td><input aria-label="Lasts" value={draft.longevity} onChange={(e) => setDraft({ ...draft, longevity: e.target.value })} /></td>
                <td>
                  <textarea aria-label="Pros, one per line" rows={3} placeholder="Pros, one per line" value={draft.pros} onChange={(e) => setDraft({ ...draft, pros: e.target.value })} />
                  <textarea aria-label="Cons, one per line" rows={2} placeholder="Cons, one per line" value={draft.cons} onChange={(e) => setDraft({ ...draft, cons: e.target.value })} />
                </td>
                <td><textarea aria-label="Next steps" rows={3} placeholder="Implant and crown: D6010 D6065" value={draft.next} onChange={(e) => setDraft({ ...draft, next: e.target.value })} /></td>
                <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="small primary" onClick={() => save(i.code)}>Save</button> <button type="button" className="small" onClick={() => setOpen(null)}>Cancel</button></td>
              </tr>
            ) : (
              <tr key={i.code}>
                <td><strong>{i.code}</strong>{i.starter && <div className="cmp-starter">starter — review</div>}</td>
                <td>{i.longevity || '—'}</td>
                <td style={{ fontSize: 12.5 }}>{i.pros.map((x) => `✓ ${x}`).join(' · ')}{i.cons.length ? ` · ${i.cons.map((x) => `– ${x}`).join(' · ')}` : ''}</td>
                <td style={{ fontSize: 12.5 }}>{i.next.map((n) => n.label).join(' / ') || '—'}</td>
                <td><button type="button" className="small" onClick={() => edit(i)}>Edit</button></td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
