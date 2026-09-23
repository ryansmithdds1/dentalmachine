import { useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { toCents, fromCents } from '../format.js';
import { ErrorBox, useSubmit } from './ui.jsx';

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' }));

// Everything about an employer group's coverage. Shared: every patient on the plan uses these numbers.
export default function InsurancePlanForm({ plan, carrierId, onDone }) {
  const carriers = useLookup('/carriers');
  const schedules = useLookup('/fee-schedules');
  const [form, setForm] = useState(() => ({
    carrier_id: plan?.carrier_id || carrierId || '',
    name: plan?.name || '',
    group_number: plan?.group_number || '',
    annual_max: fromCents(plan?.annual_max ?? 150000),
    deductible: fromCents(plan?.deductible ?? 5000),
    family_deductible: fromCents(plan?.family_deductible ?? 0),
    pct_preventive: plan?.pct_preventive ?? 100,
    pct_basic: plan?.pct_basic ?? 80,
    pct_major: plan?.pct_major ?? 50,
    benefit_month: plan?.benefit_month ?? 1,
    wait_basic_months: plan?.wait_basic_months ?? 0,
    wait_major_months: plan?.wait_major_months ?? 0,
    ortho_max: fromCents(plan?.ortho_max ?? 0),
    ortho_pct: plan?.ortho_pct ?? 50,
    ortho_age_limit: plan?.ortho_age_limit ?? '',
    downgrade_composites: !!plan?.downgrade_composites,
    fee_schedule_id: plan?.fee_schedule_id ?? '',
    notes: plan?.notes || '',
    frequencies: (plan?.frequencies || []).map((f) => ({ ...f, codes: f.codes.join(', '), window: f.per === 'benefit_year' ? 'year' : String(f.months) })),
    overrides: Object.entries(plan?.coverage_overrides || {}).map(([code, pct]) => ({ code, pct })),
  }));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setRow = (list, i, patch) => setForm({ ...form, [list]: form[list].map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const { submit, busy, error } = useSubmit(async () => {
    const body = {
      carrier_id: Number(form.carrier_id), name: form.name || null, group_number: form.group_number || null, notes: form.notes || null,
      annual_max: toCents(form.annual_max), deductible: toCents(form.deductible), family_deductible: toCents(form.family_deductible || 0),
      pct_preventive: Number(form.pct_preventive), pct_basic: Number(form.pct_basic), pct_major: Number(form.pct_major), benefit_month: Number(form.benefit_month),
      wait_basic_months: Number(form.wait_basic_months || 0), wait_major_months: Number(form.wait_major_months || 0),
      ortho_max: toCents(form.ortho_max || 0), ortho_pct: Number(form.ortho_pct), ortho_age_limit: form.ortho_age_limit === '' ? null : Number(form.ortho_age_limit),
      downgrade_composites: form.downgrade_composites, fee_schedule_id: form.fee_schedule_id ? Number(form.fee_schedule_id) : null,
      // A new plan with no limits entered starts from the usual ones.
      ...(!plan?.id && !form.frequencies.length ? {} : { frequencies: form.frequencies.filter((f) => f.codes.trim()).map((f) => ({
        label: f.label, codes: f.codes.split(/[\s,]+/).filter(Boolean), count: Number(f.count),
        ...(f.window === 'year' ? { per: 'benefit_year' } : { months: Number(f.window) }), per_tooth: !!f.per_tooth, per_area: !!f.per_area,
      })) }),
      coverage_overrides: Object.fromEntries(form.overrides.filter((o) => o.code.trim()).map((o) => [o.code.trim().toUpperCase(), Number(o.pct)])),
    };
    const saved = plan?.id ? await api.put(`/insurance-plans/${plan.id}`, body) : await api.post('/insurance-plans', body);
    onDone(saved);
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {plan?.members > 1 && <div className="public-notice" style={{ marginBottom: 10 }}>Shared by {plan.members} patients — changes apply to all of them.</div>}
      <div className="form-grid">
        <label>
          Carrier
          <select required value={form.carrier_id} onChange={set('carrier_id')} disabled={!!plan?.id}>
            <option value="">Select…</option>
            {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Employer / plan name<input value={form.name} onChange={set('name')} placeholder="Acme Corp PPO" /></label>
        <label>Group #<input value={form.group_number} onChange={set('group_number')} /></label>
        <label>Benefit year starts<select value={form.benefit_month} onChange={set('benefit_month')}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m} 1</option>)}</select></label>
        <label>Annual maximum ($)<input type="number" step="0.01" value={form.annual_max} onChange={set('annual_max')} /></label>
        <label>Deductible, per person ($)<input type="number" step="0.01" value={form.deductible} onChange={set('deductible')} /></label>
        <label>Family deductible ($, 0 = none)<input type="number" step="0.01" value={form.family_deductible} onChange={set('family_deductible')} /></label>
        <label>
          In-network fee schedule
          <select value={form.fee_schedule_id} onChange={set('fee_schedule_id')}>
            <option value="">Carrier default / out of network</option>
            {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Preventive %<input type="number" min="0" max="100" value={form.pct_preventive} onChange={set('pct_preventive')} /></label>
        <label>Basic %<input type="number" min="0" max="100" value={form.pct_basic} onChange={set('pct_basic')} /></label>
        <label>Major %<input type="number" min="0" max="100" value={form.pct_major} onChange={set('pct_major')} /></label>
        <label>Waiting period, basic (months)<input type="number" min="0" value={form.wait_basic_months} onChange={set('wait_basic_months')} /></label>
        <label>Waiting period, major (months)<input type="number" min="0" value={form.wait_major_months} onChange={set('wait_major_months')} /></label>
        <label>Ortho lifetime max ($, 0 = not covered)<input type="number" step="0.01" value={form.ortho_max} onChange={set('ortho_max')} /></label>
        <label>Ortho %<input type="number" min="0" max="100" value={form.ortho_pct} onChange={set('ortho_pct')} /></label>
        <label>Ortho age limit<input type="number" min="0" value={form.ortho_age_limit} onChange={set('ortho_age_limit')} placeholder="none" /></label>
        <label className="checkbox full"><input type="checkbox" checked={form.downgrade_composites} onChange={set('downgrade_composites')} /> Posterior composites are paid as amalgam (alternate benefit)</label>
      </div>

      <h3 style={{ marginTop: 16 }}>How often services are covered</h3>
      <table className="compact-table">
        <thead><tr><th>Service</th><th>Codes (prefixes OK)</th><th>Times</th><th>Per</th><th>Same tooth / area</th><th /></tr></thead>
        <tbody>
          {form.frequencies.map((f, i) => (
            <tr key={i}>
              <td><input value={f.label} onChange={(e) => setRow('frequencies', i, { label: e.target.value })} /></td>
              <td><input value={f.codes} onChange={(e) => setRow('frequencies', i, { codes: e.target.value })} /></td>
              <td><input type="number" min="0" style={{ width: 60 }} value={f.count} onChange={(e) => setRow('frequencies', i, { count: e.target.value })} /></td>
              <td>
                <select value={f.window} onChange={(e) => setRow('frequencies', i, { window: e.target.value })}>
                  <option value="year">benefit year</option>
                  {[6, 12, 24, 36, 60, 84].map((m) => <option key={m} value={String(m)}>{m} months</option>)}
                </select>
              </td>
              <td>
                <label className="checkbox"><input type="checkbox" checked={!!f.per_tooth} onChange={(e) => setRow('frequencies', i, { per_tooth: e.target.checked })} /> tooth</label>
                <label className="checkbox"><input type="checkbox" checked={!!f.per_area} onChange={(e) => setRow('frequencies', i, { per_area: e.target.checked })} /> quadrant</label>
              </td>
              <td><button type="button" className="small" onClick={() => setForm({ ...form, frequencies: form.frequencies.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="small" onClick={() => setForm({ ...form, frequencies: [...form.frequencies, { label: '', codes: '', count: 1, window: '12' }] })}>+ Limit</button>

      <h3 style={{ marginTop: 16 }}>Coverage exceptions</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>A different percentage for particular codes (e.g. implants at 50%, or D2740 at 60%).</p>
      {form.overrides.map((o, i) => (
        <div key={i} className="inline" style={{ marginBottom: 6 }}>
          <input value={o.code} onChange={(e) => setRow('overrides', i, { code: e.target.value })} placeholder="D6010" style={{ width: 110 }} />
          <input type="number" min="0" max="100" value={o.pct} onChange={(e) => setRow('overrides', i, { pct: e.target.value })} style={{ width: 80 }} /> %
          <button type="button" className="small" onClick={() => setForm({ ...form, overrides: form.overrides.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button type="button" className="small" onClick={() => setForm({ ...form, overrides: [...form.overrides, { code: '', pct: 50 }] })}>+ Exception</button>
      <label style={{ marginTop: 12 }}>Notes<textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Missing tooth clause, implant coverage, anything to remember" /></label>
      <div className="form-actions"><button className="primary" disabled={busy}>Save plan</button></div>
    </form>
  );
}
