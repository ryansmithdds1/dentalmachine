import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { toast } from '../../toast.js';
import { money, practiceToday, shiftDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import './referrals.css';

const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Range({ range, setRange }) {
  const today = practiceToday();
  const presets = [['Last 12 months', shiftDate(today, -365), today], ['This year', `${today.slice(0, 4)}-01-01`, today], ['Last year', `${Number(today.slice(0, 4)) - 1}-01-01`, `${Number(today.slice(0, 4)) - 1}-12-31`]];
  return (
    <div className="rt-filters">
      {presets.map(([l, f, t]) => <button key={l} className={`chip${range.from === f && range.to === t ? ' active' : ''}`} onClick={() => setRange({ from: f, to: t })}>{l}</button>)}
      <input type="date" aria-label="From" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
      <input type="date" aria-label="To" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
    </div>
  );
}

// RT5: what we send out, priced at our fees and at what PPO plans would pay — to decide what to bring in house.
export function OpportunityReport() {
  const today = practiceToday();
  const [range, setRange] = useState({ from: shiftDate(today, -365), to: today });
  const [by, setBy] = useState('by_category');
  const { data: r, error } = useApi(`/referral-tracker/opportunity?from=${range.from}&to=${range.to}`);
  const rows = r?.[by] || [];
  const max = Math.max(1, ...rows.map((x) => x.office));
  return (
    <div className="rt-report">
      <Range range={range} setRange={setRange} />
      <ErrorBox error={error} />
      {r && (
        <>
          <div className="card rt-headline">
            <div className="rt-big">{r.headline}</div>
            <div className="rt-stats">
              <div><span className="muted small">Procedures referred out</span><b>{r.totals.count}</b></div>
              <div><span className="muted small">At your fees</span><b>{money(r.totals.office)}</b></div>
              <div><span className="muted small">After PPO write-offs</span><b>{money(r.totals.net)}</b></div>
              <div><span className="muted small">Referrals</span><b>{r.totals.referrals}</b></div>
            </div>
            {r.referrals_without_codes > 0 && <div className="muted small">{r.referrals_without_codes} referral{r.referrals_without_codes === 1 ? '' : 's'} had no procedure codes, so {r.referrals_without_codes === 1 ? 'it isn’t' : 'they aren’t'} counted — pick the procedures when you refer.</div>}
          </div>
          <div className="seg" role="tablist" aria-label="Group by">
            {[['by_category', 'Category'], ['by_code', 'Procedure'], ['by_month', 'Month'], ['by_year', 'Year'], ['top_specialists', 'Specialist']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={by === k} className={by === k ? 'active' : ''} onClick={() => setBy(k)}>{l}</button>
            ))}
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>{by === 'top_specialists' ? 'Specialist' : by === 'by_code' ? 'Procedure' : by === 'by_category' ? 'Category' : 'Period'}</th><th className="num">Count</th><th className="num">At your fees</th><th className="num">After PPO write-offs</th><th /></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.key}>
                    <td>{x.label}</td><td className="num">{x.count}</td><td className="num">{money(x.office)}</td><td className="num">{money(x.net)}</td>
                    <td className="rt-bar-cell"><span className="rt-bar" style={{ width: `${Math.round((x.office / max) * 100)}%` }} aria-hidden /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="muted">Nothing referred out in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="muted small">Fees are the ones in effect on the day of each referral. “After PPO write-offs” uses the patient’s PPO fee schedule when they had one, else your fee.</div>
        </>
      )}
    </div>
  );
}

// RT4: who sends us patients, and whether we thanked them and reported back.
export function SourcesReport() {
  const today = practiceToday();
  const [range, setRange] = useState({ from: shiftDate(today, -365), to: today });
  const { data: r, error } = useApi(`/referral-tracker/sources?from=${range.from}&to=${range.to}`);
  return (
    <div className="rt-report">
      <Range range={range} setRange={setRange} />
      <ErrorBox error={error} />
      {r && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Referring doctor</th><th className="num">Patients</th><th className="num">Production since</th><th className="num">Thanked</th><th className="num">Reported back</th></tr></thead>
            <tbody>
              {r.sources.map((s) => (
                <tr key={s.id}><td>{s.name}{s.practice_name ? <div className="muted small">{s.practice_name}</div> : null}</td><td className="num">{s.patients}</td><td className="num">{money(s.production)}</td>
                  <td className="num">{pctOf(s.thanked, s.referrals)}</td><td className="num">{pctOf(s.reported_back, s.referrals)}</td></tr>
              ))}
              {!r.sources.length && <tr><td colSpan={5} className="muted">No patients referred to us in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Settings: expected-by days, past-due limit, how often critical ones re-alert, nudges, texts, who else to alert.
export function ReferralSettings({ onClose, canEdit }) {
  const { data, error, reload } = useApi('/referral-tracker/settings');
  const users = useLookup(canEdit ? '/users' : null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const s = draft || data;
  const set = (k, v) => setDraft({ ...(draft || data), [k]: v });
  const save = async () => {
    setErr(null);
    try {
      const body = Object.fromEntries(['routine_days', 'soon_days', 'critical_days', 'past_due_days', 'critical_alert_days', 'nudge_noncritical', 'text_patient', 'alert_user_ids', 'patient_text', 'thank_you_text', 'report_back_text'].map((k) => [k, s[k]]));
      await api.put('/referral-tracker/settings', body);
      toast('Referral settings saved');
      setDraft(null);
      reload();
      onClose();
    } catch (e) { setErr(e); }
  };
  const num = (k, label) => <label>{label}<input type="number" min={1} max={365} value={s[k]} disabled={!canEdit} onChange={(e) => set(k, Number(e.target.value))} /></label>;
  return (
    <aside className="drawer rt-drawer" role="dialog" aria-label="Referral settings">
      <div className="drawer-head"><strong>Referral settings</strong><button className="small" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="drawer-body">
        <ErrorBox error={error || err} />
        {s && (
          <>
            <h3 className="rt-h">Expected to be seen within (days)</h3>
            <div className="form-grid">{num('routine_days', 'Routine')}{num('soon_days', 'Soon')}{num('critical_days', 'Critical')}</div>
            <div className="form-grid">{num('past_due_days', 'Past due after (days open)')}{num('critical_alert_days', 'Re-alert critical every (days)')}</div>
            <label className="rt-check"><input type="checkbox" disabled={!canEdit} checked={!!s.nudge_noncritical} onChange={(e) => set('nudge_noncritical', e.target.checked ? 1 : 0)} /> Also make a task when a routine or soon referral is overdue</label>
            <label className="rt-check"><input type="checkbox" disabled={!canEdit} checked={!!s.text_patient} onChange={(e) => set('text_patient', e.target.checked ? 1 : 0)} /> Text patients the specialist’s number when they’re referred</label>
            {canEdit && (
              <div className="rt-field">
                <span>Also alert about critical referrals (the referral’s dentist and the front desk always are)</span>
                <div className="chips">
                  {users.filter((u) => u.active).map((u) => (
                    <button type="button" key={u.id} className={`chip${s.alert_user_ids.includes(u.id) ? ' active' : ''}`}
                      onClick={() => set('alert_user_ids', s.alert_user_ids.includes(u.id) ? s.alert_user_ids.filter((x) => x !== u.id) : [...s.alert_user_ids, u.id])}>{u.name}</button>
                  ))}
                </div>
              </div>
            )}
            <label className="rt-field">Text to the patient<textarea rows={3} disabled={!canEdit} value={s.patient_text} onChange={(e) => set('patient_text', e.target.value)} /></label>
            <label className="rt-field">Thank-you letter<textarea rows={5} disabled={!canEdit} value={s.thank_you_text} onChange={(e) => set('thank_you_text', e.target.value)} /></label>
            <label className="rt-field">Report back<textarea rows={6} disabled={!canEdit} value={s.report_back_text} onChange={(e) => set('report_back_text', e.target.value)} /></label>
            <div className="muted small">Placeholders: {'{first_name} {practice} {specialist} {specialist_practice} {specialist_phone} {urgent} {practice_phone} {contact_name} {patient_name} {referral_date} {treatment} {note} {provider}'}</div>
            {canEdit && <div className="form-actions"><button className="primary" disabled={!draft} onClick={save}>Save</button></div>}
          </>
        )}
      </div>
    </aside>
  );
}
