import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, getLocationId, downloadCsv } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { practiceToday, shiftDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { toast } from '../toast.js';
import { useShortcuts } from '../shortcuts.js';
import { useBusinessAccess, BusinessStrip, StaffLanes, ExamsCard, $, $h, pct, hrs, BAND_LABEL } from '../components/business/BusinessView.jsx';
import '../components/business/business.css';

// The owner's business page (PM1, PM4, BD1–BD4, EX; docs/business-view.md): today's P&L and staff lanes, what
// pays and what doesn't (by procedure, provider, payer, visit type — with "what if"), trends in labor and
// productivity, and the costs behind every margin. Mounted at /business.
const TABS = [['today', 'Today'], ['reports', 'What pays'], ['trends', 'Labor trends'], ['costs', 'Costs & settings']];
const dollarsIn = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
const pctIn = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
const toDollars = (c) => (c == null ? '' : String(c / 100));
const toPct = (b) => (b == null ? '' : String(b / 100));

export default function Business() {
  const { practice } = useAuth();
  const access = useBusinessAccess();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'today';
  useShortcuts(TABS.map(([k, l], i) => ({ combo: String(i + 1), handler: () => setParams({ tab: k }), label: l, section: 'Business' })));
  const today = practiceToday(practice?.timezone || 'America/New_York');
  if (!access) return <div className="empty">Loading…</div>;
  if (!access.view && !access.lanes) return <div className="empty card">The business view is for the practice owner. Ask an administrator for “See the business view”.</div>;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Business</h1>
          <div className="muted">What each visit really earns after write-offs, lab, supplies and pay; labor against production, live; and what’s worth changing.</div>
        </div>
      </div>
      <div className="tabs">
        {TABS.filter(([k]) => access.view || k === 'today').map(([k, l], i) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })} title={`${l} (${i + 1})`}>{l}</button>)}
      </div>
      {tab === 'today' && <Today today={today} access={access} />}
      {tab === 'reports' && access.view && <Reports today={today} access={access} />}
      {tab === 'trends' && access.view && <Trends today={today} access={access} />}
      {tab === 'costs' && access.view && <Costs access={access} />}
    </>
  );
}

function Today({ today, access }) {
  const [date, setDate] = useState(today);
  const office = getLocationId();
  return (
    <>
      <div className="inline" style={{ marginBottom: 8, gap: 8 }}>
        <button className="small" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">←</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
        <button className="small" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">→</button>
        {date !== today && <button className="small" onClick={() => setDate(today)}>Today</button>}
      </div>
      {access.view && <BusinessStrip date={date} office={office} />}
      {access.view && <div style={{ margin: '8px 0' }}><ExamsCard date={date} office={office} /></div>}
      <StaffLanes date={date} office={office} />
    </>
  );
}

// ---- PM4: what pays ----
const BY = [['procedure', 'Procedure'], ['provider', 'Provider'], ['payer', 'Insurance'], ['type', 'Visit type'], ['category', 'Kind of work']];
function Reports({ today, access }) {
  const [from, setFrom] = useState(shiftDate(today, -90));
  const [to, setTo] = useState(today);
  const [by, setBy] = useState('procedure');
  const q = `from=${from}&to=${to}`;
  const { data, error, loading } = useApi(`/business/reports/margins?${q}&by=${by}`);
  const cols = [['Count', 'count'], ['Fees', 'fee', $], ['Write-offs', 'write_off', $], ['Expected', 'expected', $], ['Lab', 'lab', $], ['Supplies', 'supplies', $],
    ...(access.rates ? [['Pay', 'pay', $]] : []), ['Card fees', 'merchant', $], ['Margin', 'margin', $], ['Chair h', 'chair_minutes', hrs], ['Margin / chair h', 'margin_per_chair_hour', $h],
    ['Margin / doctor h', 'margin_per_doctor_hour', $h], ['Profit / h', 'profit_per_hour', $h]];
  return (
    <>
      <div className="biz-form" style={{ marginBottom: 10 }}>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="seg">{BY.map(([k, l]) => <button key={k} className={by === k ? 'active' : ''} onClick={() => setBy(k)}>{l}</button>)}</span>
        {data && <button className="small" onClick={() => downloadCsv(`margins-by-${by}-${from}-${to}.csv`, data.rows, [['Name', (r) => r.label], ...cols.map(([h, k]) => [h, (r) => (k.endsWith('minutes') ? (r[k] / 60).toFixed(1) : r[k] == null ? '' : ['count'].includes(k) ? r[k] : (r[k] / 100).toFixed(2))])])}>Export</button>}
      </div>
      <ErrorBox error={error} />
      {loading && !data && <div className="empty">Working out the margins…</div>}
      {data && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Completed work, least profitable per chair-hour first. Fixed costs: {$h(data.overhead.per_chair_hour)} a chair-hour{data.overhead.source === 'typical' ? ' (a typical figure — set yours in Costs & settings)' : ''}.{data.typical_costs ? ' Some procedure costs are typical estimates.' : ''}</p>
          <div className="table-wrap">
            <table className="biz-table">
              <thead><tr><th>{BY.find(([k]) => k === by)[1]}</th>{cols.map(([h]) => <th key={h} className="num">{h}</th>)}</tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key} className={`biz-row-${r.band}`} title={BAND_LABEL[r.band]}>
                    <td>{r.label}</td>
                    {cols.map(([h, k, f]) => <td key={h} className="num">{f ? f(r[k]) : r[k]}</td>)}
                  </tr>
                ))}
                {!data.rows.length && <tr><td colSpan={cols.length + 1} className="muted">No completed work in these dates.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="biz-section">
            <h3>Least profitable under each insurance</h3>
            {data.least_profitable.map((p) => (
              <div key={p.carrier_id ?? 0} style={{ marginBottom: 6 }}>
                <strong>{p.payer}</strong>{' '}
                <span className="muted">{p.procedures.length ? p.procedures.map((r) => `${r.key} ${$h(r.margin_per_chair_hour)}`).join(' · ') : 'nothing with chair time'}</span>
              </div>
            ))}
          </div>
          <WhatIf q={q} carriers={data.least_profitable.filter((p) => p.carrier_id)} />
        </>
      )}
    </>
  );
}
function WhatIf({ q, carriers }) {
  const [kind, setKind] = useState('fee');
  const [code, setCode] = useState('');
  const [pctUp, setPctUp] = useState('5');
  const [lab, setLab] = useState('');
  const [carrier, setCarrier] = useState(carriers[0]?.carrier_id || '');
  const [retention, setRetention] = useState('70');
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      const extra = kind === 'fee' ? `&pct_bp=${Math.round(Number(pctUp) * 100)}${code ? `&code=${encodeURIComponent(code)}` : ''}`
        : kind === 'lab' ? `&code=${encodeURIComponent(code)}&lab_cents=${dollarsIn(lab) ?? 0}` : `&carrier_id=${carrier}&retention=${retention}&refill=50`;
      setOut(await api.get(`/business/reports/what-if?${q}&kind=${kind}${extra}`));
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <form className="biz-section card" onSubmit={run} style={{ padding: 12 }}>
      <h3>What if…</h3>
      <div className="biz-form">
        <span className="seg">{[['fee', 'Raise a fee'], ['lab', 'Change a lab'], ['drop_plan', 'Drop a plan']].map(([k, l]) => <button type="button" key={k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setOut(null); }}>{l}</button>)}</span>
        {kind !== 'drop_plan' && <label>Code{kind === 'fee' ? ' (blank = all)' : ''}<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="D2740" style={{ width: 90 }} /></label>}
        {kind === 'fee' && <label>Change %<input type="number" step="0.5" value={pctUp} onChange={(e) => setPctUp(e.target.value)} style={{ width: 80 }} /></label>}
        {kind === 'lab' && <label>New lab fee $<input type="number" min="0" step="1" value={lab} onChange={(e) => setLab(e.target.value)} style={{ width: 100 }} /></label>}
        {kind === 'drop_plan' && (
          <>
            <label>Plan<select value={carrier} onChange={(e) => setCarrier(e.target.value)}>{carriers.map((c) => <option key={c.carrier_id} value={c.carrier_id}>{c.payer}</option>)}</select></label>
            <label>Patients who stay %<input type="number" min="0" max="100" value={retention} onChange={(e) => setRetention(e.target.value)} style={{ width: 80 }} /></label>
          </>
        )}
        <button className="primary small" type="submit">Work it out</button>
      </div>
      <ErrorBox error={err} />
      {out && kind !== 'drop_plan' && <p>Margin in these dates {$(out.margin_before)} → {$(out.margin_after)}: <strong>{out.change >= 0 ? '+' : ''}{$(out.change)}</strong>, about <strong>{$(out.change_per_year)} a year</strong> ({out.procedures} procedure{out.procedures === 1 ? '' : 's'}).{kind === 'fee' && out.change === 0 ? ' Insurance caps these at its allowed fee, so a higher office fee changes nothing for them.' : ''}</p>}
      {out && kind === 'drop_plan' && <p>Dropping {out.payer}: write-offs kept {$(out.recaptured_per_year)}, margin lost from patients who leave {$(out.lost_per_year)}, refilled time {$(out.refilled_per_year)} — <strong>{out.change_per_year >= 0 ? '+' : ''}{$(out.change_per_year)} a year</strong> ({out.freed_hours} chair hours freed in these dates).</p>}
    </form>
  );
}

// ---- BD4: trends ----
function Trends({ today, access }) {
  const [from, setFrom] = useState(shiftDate(today, -27));
  const [to, setTo] = useState(today);
  const [group, setGroup] = useState('week');
  const [drill, setDrill] = useState(null);
  const { data, error } = useApi(`/business/trends?from=${from}&to=${to}&group=${group}`);
  const { data: rows } = useApi(drill ? `/business/trends/rows?metric=${drill}&from=${from}&to=${to}` : null);
  return (
    <>
      <div className="biz-form" style={{ marginBottom: 10 }}>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="seg">{['day', 'week', 'month'].map((g) => <button key={g} className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>{g[0].toUpperCase() + g.slice(1)}</button>)}</span>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="table-wrap">
            <table className="biz-table">
              <thead><tr><th>Period</th><th className="num">Production</th><th className="num">Collections</th>{access.rates && <><th className="num">Labor</th><th className="num">Labor % prod.</th><th className="num">Labor % coll.</th><th className="num">Overtime</th></>}
                <th className="num">Paid h</th><th className="num">Production / labor h</th><th className="num">Busy %</th><th className="num">Idle h</th>{access.rates && <th className="num">Idle $</th>}</tr></thead>
              <tbody>
                {[...data.rows, { ...data.total, period: 'Total' }].map((r) => (
                  <tr key={r.period} style={r.period === 'Total' ? { fontWeight: 700 } : undefined}>
                    <td>{r.period}</td><td className="num">{$(r.production)}</td><td className="num">{$(r.collections)}</td>
                    {access.rates && <><td className="num"><button className="link" onClick={() => setDrill('labor')}>{$(r.labor_cost)}</button></td><td className="num">{pct(r.labor_pct_production)}</td><td className="num">{pct(r.labor_pct_collections)}</td><td className="num"><button className="link" onClick={() => setDrill('overtime')}>{$(r.overtime_premium)}</button></td></>}
                    <td className="num">{hrs(r.paid_minutes)}</td><td className="num">{$h(r.production_per_labor_hour)}</td><td className="num">{pct(r.productivity_pct)}</td><td className="num">{r.idle_hours == null ? '—' : `${r.idle_hours} h`}</td>{access.rates && <td className="num">{$(r.idle_cost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.productivity_included && <p className="muted">Pick two months or less to see who was busy and idle.</p>}
          {data.people.length > 0 && (
            <div className="biz-section">
              <h3>By person</h3>
              <table className="biz-table">
                <thead><tr><th>Person</th><th>Role</th><th className="num">Paid h</th><th className="num">Busy %</th><th className="num">Idle h</th><th className="num">Production supported / h</th></tr></thead>
                <tbody>{data.people.map((p) => <tr key={p.user_id}><td>{p.name}</td><td>{p.kind}</td><td className="num">{hrs(p.paid_minutes)}</td><td className="num">{pct(p.productivity_pct)}</td><td className="num">{hrs(p.idle_minutes)}</td><td className="num">{$h(p.production_per_labor_hour)}</td></tr>)}</tbody>
              </table>
              <p className="muted">By role: {data.roles.map((r) => `${r.kind} ${pct(r.productivity_pct)} busy, ${r.idle_hours} h idle`).join(' · ')}</p>
            </div>
          )}
          {drill && rows && (
            <div className="biz-section">
              <h3>{drill === 'overtime' ? 'Overtime' : 'Hours and labor'} behind the numbers <button className="link" onClick={() => setDrill(null)}>close</button></h3>
              <table className="biz-table">
                <thead><tr><th>Date</th><th>Person</th><th>In</th><th>Out</th><th className="num">Hours</th><th className="num">Overtime h</th>{access.rates && <th className="num">Cost</th>}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}><td>{r.date}</td><td>{r.name}</td><td>{r.clock_in?.slice(11)}</td><td>{r.clock_out?.slice(11)}</td><td className="num">{hrs(r.minutes)}</td><td className="num">{hrs((r.overtime || 0) + (r.doubletime || 0))}</td>{access.rates && <td className="num">{$(r.cost)}</td>}</tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---- PM1: costs, pay plans, thresholds, staff roles, exam targets ----
function Costs({ access }) {
  const { data: s, reload: reloadSettings } = useApi('/business/settings');
  const { data: cp, reload: reloadProfiles } = useApi('/business/cost-profiles');
  const { data: sug } = useApi('/business/cost-profiles/suggestions');
  const { data: pay, reload: reloadPay } = useApi(access.rates ? '/business/provider-pay' : null);
  const { data: roles, reload: reloadRoles } = useApi('/business/staff-roles');
  const { data: exams, reload: reloadExams } = useApi('/business/exams');
  const save = async (fn, done, msg) => {
    try {
      await fn();
      done?.();
      toast(msg);
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  if (!s || !cp) return <div className="empty">Loading…</div>;
  return (
    <>
      <SettingsForm s={s} can={access.manage} onSave={(body) => save(() => api.put('/business/settings', body), reloadSettings, 'Saved. The schedule colors update now.')} />
      <div className="biz-section">
        <h3>Costs per procedure</h3>
        <p className="muted" style={{ marginTop: 0 }}>Supplies, lab and card fees for each code or kind of work. Each change is kept as a new version from the date you choose — past visits keep the costs they had.</p>
        {sug && access.manage && (
          <p>
            <button className="small" onClick={() => save(() => api.post('/business/cost-profiles/bulk', { items: [
              ...Object.entries(sug.categories).map(([k, v]) => ({ scope: 'category', scope_key: k, supplies_cents: v.supplies_cents, lab_mode: v.lab_mode, lab_cents: v.lab_cents, source: 'suggested' })),
              ...sug.codes.filter((c) => cp.codes.some((x) => x.code === c.code)).map((c) => ({ scope: 'code', scope_key: c.code, supplies_cents: sug.categories[cp.codes.find((x) => x.code === c.code).category]?.supplies_cents ?? 0, lab_mode: 'case', lab_cents: c.lab_cents, source: 'suggested' })),
            ] }), reloadProfiles, 'Suggested costs saved — change any of them below.')}>Use the suggested costs</button>{' '}
            <span className="muted">{sug.basis === 'finance' ? `Scaled to your supply spend (${$(sug.supply_spend)} in 12 months, ×${sug.ratio} typical).` : 'Typical amounts (connect the bank or QuickBooks in Finance to scale them to your spending).'}{sug.codes.length ? ` Lab fees from your last year of lab cases for ${sug.codes.length} code${sug.codes.length === 1 ? '' : 's'}.` : ''}</span>
          </p>
        )}
        <ProfileEditor cp={cp} can={access.manage} rates={access.rates} onSave={(body) => save(() => api.post('/business/cost-profiles', body), reloadProfiles, 'Saved as a new version.')} />
      </div>
      {access.rates && pay && <PayPlans pay={pay} can={access.manage} onSave={(body) => save(() => api.post('/business/provider-pay', body), reloadPay, 'Pay plan saved as a new version.')} />}
      {roles && <StaffRoles roles={roles} onSave={(uid, body) => save(() => api.put(`/business/staff-roles/${uid}`, body), reloadRoles, 'Saved.')} />}
      {exams && <ExamTargets exams={exams} can={access.manage} onSave={(items) => save(() => api.put('/business/exam-targets', { items }), reloadExams, 'Exam targets saved.')} />}
    </>
  );
}
function SettingsForm({ s, can, onSave }) {
  const st = s.settings;
  const [f, setF] = useState(null);
  useEffect(() => {
    setF({
      basis: st.basis, overhead_mode: st.overhead_mode, overhead: toDollars(st.overhead_per_hour_cents), fixed: toDollars(st.fixed_costs_month_cents), days: String(st.work_days_month),
      red: toDollars(st.red_below_cents), green: toDollars(st.green_from_cents), gold: toDollars(st.gold_from_cents), low: toPct(st.labor_target_low_bp), high: toPct(st.labor_target_high_bp),
      collect: toPct(st.patient_collect_bp), merchant: toPct(st.default_merchant_bp), assist: String(st.assistants_per_doctor_chair_bp / 10000), gap: String(st.idle_gap_minutes),
    });
  }, [st]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const o = s.overhead;
  return (
    <form className="biz-section card" style={{ padding: 12 }} onSubmit={(e) => {
      e.preventDefault();
      onSave({
        basis: f.basis, overhead_mode: f.overhead_mode, overhead_per_hour_cents: dollarsIn(f.overhead), fixed_costs_month_cents: dollarsIn(f.fixed), work_days_month: Number(f.days),
        red_below_cents: dollarsIn(f.red), green_from_cents: dollarsIn(f.green), gold_from_cents: dollarsIn(f.gold), labor_target_low_bp: pctIn(f.low), labor_target_high_bp: pctIn(f.high),
        patient_collect_bp: pctIn(f.collect), default_merchant_bp: pctIn(f.merchant), assistants_per_doctor_chair_bp: Math.round(Number(f.assist) * 10000), idle_gap_minutes: Number(f.gap),
      });
    }}>
      <h3>Fixed costs, colors and targets</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Fixed cost per chair-hour now: <strong>{$h(o.per_chair_hour)}</strong> ({o.per_chair_hour_source === 'finance' ? `from Finance: ${$(o.detail?.fixed_costs)} over ${o.detail?.chair_hours} chair hours` : o.per_chair_hour_source === 'manual' ? 'your number' : 'a typical figure — connect Finance or enter yours'}); other fixed costs per day <strong>{$(o.fixed_per_day)}</strong>.
      </p>
      <fieldset disabled={!can} className="biz-form" style={{ border: 0, padding: 0 }}>
        <label>Color by margin per<select value={f.basis} onChange={set('basis')}><option value="chair">chair-hour</option><option value="doctor">doctor-hour</option></select></label>
        <label>Fixed costs<select value={f.overhead_mode} onChange={set('overhead_mode')}><option value="auto">from Finance</option><option value="manual">my numbers</option></select></label>
        {f.overhead_mode === 'manual' && <>
          <label>Per chair-hour $<input type="number" min="0" value={f.overhead} onChange={set('overhead')} style={{ width: 90 }} /></label>
          <label>Other fixed costs a month $<input type="number" min="0" value={f.fixed} onChange={set('fixed')} style={{ width: 110 }} /></label>
          <label>Days open a month<input type="number" min="1" max="31" value={f.days} onChange={set('days')} style={{ width: 70 }} /></label>
        </>}
        <label>Red below $/h<input type="number" min="0" value={f.red} placeholder={String(o.per_chair_hour / 100)} onChange={set('red')} style={{ width: 90 }} /></label>
        <label>Green from $/h<input type="number" min="0" value={f.green} placeholder="1.5×" onChange={set('green')} style={{ width: 90 }} /></label>
        <label>Gold from $/h<input type="number" min="0" value={f.gold} placeholder="2.5×" onChange={set('gold')} style={{ width: 90 }} /></label>
        <label>Labor target %<span className="inline"><input type="number" min="0" max="100" value={f.low} onChange={set('low')} style={{ width: 60 }} />–<input type="number" min="0" max="100" value={f.high} onChange={set('high')} style={{ width: 60 }} /></span></label>
        <label>Patient portions collected %<input type="number" min="0" max="100" value={f.collect} onChange={set('collect')} style={{ width: 70 }} /></label>
        <label>Card fee %<input type="number" min="0" max="100" step="0.1" value={f.merchant} onChange={set('merchant')} style={{ width: 70 }} /></label>
        <label>Assistants per doctor chair<input type="number" min="0" max="4" step="0.5" value={f.assist} onChange={set('assist')} style={{ width: 70 }} /></label>
        <label>Flag idle stretches from (min)<input type="number" min="5" max="240" value={f.gap} onChange={set('gap')} style={{ width: 70 }} /></label>
        {can && <button className="primary small" type="submit">Save</button>}
      </fieldset>
    </form>
  );
}
function ProfileEditor({ cp, can, rates, onSave }) {
  const blank = { scope: 'code', scope_key: '', supplies: '', lab_mode: 'none', lab: '', merchant: '', pay: '', effective_from: cp.today, note: '' };
  const [f, setF] = useState(blank);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pick = (p) => setF({ scope: p.scope, scope_key: p.scope_key, supplies: toDollars(p.current?.supplies_cents), lab_mode: p.current?.lab_mode || 'none', lab: toDollars(p.current?.lab_cents), merchant: toPct(p.current?.merchant_bp), pay: toPct(p.current?.pay_pct_bp), effective_from: cp.today, note: '' });
  const rows = useMemo(() => [...cp.profiles].sort((a, b) => (a.scope === b.scope ? a.scope_key.localeCompare(b.scope_key) : a.scope === 'category' ? -1 : 1)), [cp.profiles]);
  return (
    <>
      <table className="biz-table">
        <thead><tr><th>Code / kind</th><th className="num">Supplies</th><th>Lab</th><th className="num">Card fee</th>{rates && <th className="num">Pay override</th>}<th>Since</th><th className="num">Versions</th><th /></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.scope}|${p.scope_key}`}>
              <td>{p.scope === 'category' ? `All ${p.scope_key.replace('_', ' ')}` : p.scope_key}</td>
              <td className="num">{p.current ? $(p.current.supplies_cents) : '—'}</td>
              <td>{p.current ? (p.current.active ? { none: 'none', fixed: $(p.current.lab_cents), case: `lab case (else ${$(p.current.lab_cents)})` }[p.current.lab_mode] : 'retired') : `starts ${p.upcoming[0]?.effective_from}`}</td>
              <td className="num">{p.current?.merchant_bp != null ? pct(p.current.merchant_bp / 100) : 'default'}</td>
              {rates && <td className="num">{p.current?.pay_pct_bp != null ? pct(p.current.pay_pct_bp / 100) : '—'}</td>}
              <td>{p.current?.effective_from === '1900-01-01' ? 'always' : p.current?.effective_from}{p.upcoming.length ? ` · next ${p.upcoming[0].effective_from}` : ''}</td>
              <td className="num">{p.versions}</td>
              <td>{can && <button className="link" onClick={() => pick(p)}>Change</button>}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="muted">No costs entered yet: typical amounts are used (and labelled) until you do.</td></tr>}
        </tbody>
      </table>
      {can && (
        <form className="biz-form" style={{ marginTop: 8 }} onSubmit={(e) => {
          e.preventDefault();
          onSave({ scope: f.scope, scope_key: f.scope_key, supplies_cents: dollarsIn(f.supplies) ?? 0, lab_mode: f.lab_mode, lab_cents: dollarsIn(f.lab) ?? 0, merchant_bp: pctIn(f.merchant), ...(rates ? { pay_pct_bp: pctIn(f.pay) } : {}), effective_from: f.effective_from, note: f.note || null });
          setF(blank);
        }}>
          <label>For<select value={f.scope} onChange={set('scope')}><option value="code">a code</option><option value="category">a kind of work</option></select></label>
          {f.scope === 'code'
            ? <label>Code<input list="biz-codes" value={f.scope_key} onChange={(e) => setF({ ...f, scope_key: e.target.value.toUpperCase() })} style={{ width: 90 }} required /><datalist id="biz-codes">{cp.codes.map((c) => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist></label>
            : <label>Kind<select value={f.scope_key} onChange={set('scope_key')} required><option value="" />{cp.categories.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select></label>}
          <label>Supplies $<input type="number" min="0" step="0.01" value={f.supplies} onChange={set('supplies')} style={{ width: 90 }} /></label>
          <label>Lab<select value={f.lab_mode} onChange={set('lab_mode')}><option value="none">none</option><option value="fixed">fixed $</option><option value="case">from the lab case</option></select></label>
          {f.lab_mode !== 'none' && <label>{f.lab_mode === 'case' ? 'Estimate when no case $' : 'Lab $'}<input type="number" min="0" step="0.01" value={f.lab} onChange={set('lab')} style={{ width: 90 }} /></label>}
          <label>Card fee % (blank = default)<input type="number" min="0" max="100" step="0.1" value={f.merchant} onChange={set('merchant')} style={{ width: 70 }} /></label>
          {rates && <label>Provider pay % (blank = their plan)<input type="number" min="0" max="100" step="0.5" value={f.pay} onChange={set('pay')} style={{ width: 70 }} /></label>}
          <label>From<input type="date" value={f.effective_from} onChange={set('effective_from')} /></label>
          <label>Why (optional)<input value={f.note} onChange={set('note')} style={{ width: 160 }} /></label>
          <button className="primary small" type="submit">Save as new version</button>
        </form>
      )}
    </>
  );
}
function PayPlans({ pay, can, onSave }) {
  const [f, setF] = useState({ provider_id: pay.providers[0]?.id || '', basis: 'production_pct', pct: '30', hourly: '', lab_deducted: false, effective_from: pay.today });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="biz-section">
      <h3>How providers are paid</h3>
      <table className="biz-table">
        <thead><tr><th>Provider</th><th>Paid</th><th>Since</th><th className="num">Time clock rate</th></tr></thead>
        <tbody>{pay.providers.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.current ? `${pay.bases[p.current.basis]}${p.current.pct_bp ? ` — ${p.current.pct_bp / 100}%` : ''}${p.current.hourly_cents ? ` — ${$h(p.current.hourly_cents)}` : ''}${p.current.lab_deducted ? ', after lab' : ''}` : 'not per visit (owner)'}</td><td>{p.current?.effective_from || ''}</td><td className="num">{p.clock_rate_cents != null ? $h(p.clock_rate_cents) : '—'}</td></tr>)}</tbody>
      </table>
      {can && (
        <form className="biz-form" style={{ marginTop: 8 }} onSubmit={(e) => {
          e.preventDefault();
          onSave({ provider_id: Number(f.provider_id), basis: f.basis, pct_bp: pctIn(f.pct), hourly_cents: dollarsIn(f.hourly), lab_deducted: f.lab_deducted, effective_from: f.effective_from });
        }}>
          <label>Provider<select value={f.provider_id} onChange={set('provider_id')}>{pay.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Paid<select value={f.basis} onChange={set('basis')}>{Object.entries(pay.bases).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {['production_pct', 'collections_pct'].includes(f.basis) && <label>%<input type="number" min="0" max="100" step="0.5" value={f.pct} onChange={set('pct')} style={{ width: 70 }} /></label>}
          {f.basis === 'hourly' && <label>$/h (blank = time clock rate)<input type="number" min="0" step="0.01" value={f.hourly} onChange={set('hourly')} style={{ width: 90 }} /></label>}
          {['production_pct', 'collections_pct'].includes(f.basis) && <label className="checkbox"><input type="checkbox" checked={f.lab_deducted} onChange={set('lab_deducted')} /> after lab fees</label>}
          <label>From<input type="date" value={f.effective_from} onChange={set('effective_from')} /></label>
          <button className="primary small" type="submit">Save as new version</button>
        </form>
      )}
    </div>
  );
}
function StaffRoles({ roles, onSave }) {
  return (
    <div className="biz-section">
      <h3>Who works with whom (staff lanes)</h3>
      <p className="muted" style={{ marginTop: 0 }}>Assistants linked to a provider or chair count as busy when that provider or chair has a patient; unlinked assistants share the doctor chairs in the order they clocked in.</p>
      <table className="biz-table">
        <thead><tr><th>Person</th><th>Works as</th><th>With provider</th><th>In chair</th></tr></thead>
        <tbody>{roles.people.map((p) => (
          <tr key={p.user_id}>
            <td>{p.name}</td>
            <td><select disabled={!roles.can_manage} value={p.kind} onChange={(e) => onSave(p.user_id, { kind: e.target.value, provider_ids: p.provider_ids, operatory_ids: p.operatory_ids })}>{[['doctor', 'Doctor'], ['hygienist', 'Hygienist'], ['assistant', 'Assistant'], ['admin', 'Front office']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>{!p.saved && <span className="muted"> (guessed)</span>}</td>
            <td><select disabled={!roles.can_manage} value={p.provider_ids[0] || ''} onChange={(e) => onSave(p.user_id, { kind: p.kind, provider_ids: e.target.value ? [Number(e.target.value)] : [], operatory_ids: p.operatory_ids })}><option value="">{p.kind === 'assistant' ? 'shared' : '—'}</option>{roles.providers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
            <td><select disabled={!roles.can_manage} value={p.operatory_ids[0] || ''} onChange={(e) => onSave(p.user_id, { kind: p.kind, provider_ids: p.provider_ids, operatory_ids: e.target.value ? [Number(e.target.value)] : [] })}><option value="">—</option>{roles.chairs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
function ExamTargets({ exams, can, onSave }) {
  const [f, setF] = useState(() => Object.fromEntries(exams.today.map((x) => [x.type, { target: x.target ?? '', value: exams.values?.[x.type]?.override != null ? toDollars(exams.values[x.type].override) : '' }])));
  return (
    <form className="biz-section" onSubmit={(e) => {
      e.preventDefault();
      onSave(Object.entries(f).map(([t, v]) => ({ exam_type: t, daily_target: v.target === '' ? null : Number(v.target), value_cents: dollarsIn(v.value) })));
    }}>
      <h3>Exams per day and what an exam is worth</h3>
      <p className="muted" style={{ marginTop: 0 }}>Daily targets for the exams card. The value of an exam comes from your own history once there’s enough of it{exams.values_source === 'diagnosis' ? '' : '; until then your number here (for 5 months) or a typical one'}.</p>
      <div className="biz-form">
        {exams.today.map((x) => (
          <fieldset key={x.type} disabled={!can} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}>
            <legend style={{ fontSize: 12 }}>{x.label}</legend>
            <span className="inline" style={{ gap: 8 }}>
              <label>Per day<input type="number" min="0" max="200" value={f[x.type]?.target ?? ''} onChange={(e) => setF({ ...f, [x.type]: { ...f[x.type], target: e.target.value } })} style={{ width: 60 }} /></label>
              <label>Worth $ (5 mo)<input type="number" min="0" value={f[x.type]?.value ?? ''} placeholder={exams.values?.[x.type] ? String(Math.round(exams.values[x.type].value / 100)) : ''} onChange={(e) => setF({ ...f, [x.type]: { ...f[x.type], value: e.target.value } })} style={{ width: 90 }} /></label>
            </span>
          </fieldset>
        ))}
        {can && <button className="primary small" type="submit">Save</button>}
      </div>
    </form>
  );
}
