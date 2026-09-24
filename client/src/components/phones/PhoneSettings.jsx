import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import './phones.css';

// Settings → Phone line → Calls and coaching (PH1, PH5-PH7): what callers hear before a recorded call, live
// transcription for the call screen, AI scoring, who answers phones (for the missed-call numbers), who hears about
// upset callers and bad days, and the missed-call target.
export default function PhoneSettings() {
  const { user } = useAuth();
  const { data, reload } = useApi('/phones/settings');
  const [f, setF] = useState(null);
  if (!data) return null;
  const admin = user?.role === 'admin';
  const cur = f || {
    recording_disclosure: data.recording_disclosure || '', live_transcription: data.live_transcription, scoring: data.scoring,
    answerer_ids: data.answerer_ids, alert_user_ids: data.alert_user_ids, alert_sms_to: (data.alert_sms_to || []).join(', '), missed_target_pct: data.missed_target_pct, missed_min_calls: data.missed_min_calls,
  };
  const set = (patch) => setF({ ...cur, ...patch });
  const toggle = (key, id) => set({ [key]: cur[key].includes(id) ? cur[key].filter((x) => x !== id) : [...cur[key], id] });
  const save = async () => {
    try {
      await api.put('/phones/settings', { ...cur, alert_sms_to: cur.alert_sms_to.split(',').map((x) => x.trim()).filter(Boolean), missed_target_pct: Number(cur.missed_target_pct), missed_min_calls: Number(cur.missed_min_calls) });
      toast('Phone settings saved');
      setF(null); reload();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3 style={{ margin: 0 }}>Calls and coaching</h3>
      <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
        <label style={{ marginTop: 8 }}>What callers hear before a recorded call
          <input value={cur.recording_disclosure} onChange={(e) => set({ recording_disclosure: e.target.value })} placeholder={data.default_disclosure} />
        </label>
        <p className="muted" style={{ fontSize: 12 }}>Some states require everyone on a call to agree to recording (for example California, Florida, Illinois, Maryland, Massachusetts, Pennsylvania, Washington). Keep the message on and check your state’s rules with your advisor.</p>
        <label className="checkbox"><input type="checkbox" checked={cur.live_transcription} onChange={(e) => set({ live_transcription: e.target.checked })} /> Live transcription on the call screen (Next openings filter as the caller talks){data.live ? '' : ' — not set up on this server; the quick filter chips work without it'}</label>
        <label className="checkbox"><input type="checkbox" checked={cur.scoring} onChange={(e) => set({ scoring: e.target.checked })} /> Score recorded calls against our protocols with AI{data.scorer ? ` (${data.scorer.label})` : ' — AI is off on this server'}</label>
        <div style={{ marginTop: 8 }}><strong style={{ fontSize: 13 }}>Who answers the phones</strong> <span className="muted" style={{ fontSize: 12 }}>(missed calls count against whoever was on shift; none ticked = the front desk)</span></div>
        <div className="reason-chips">{data.team.map((u) => <button type="button" key={u.id} className={`chip${cur.answerer_ids.includes(u.id) ? ' on' : ''}`} aria-pressed={cur.answerer_ids.includes(u.id)} onClick={() => toggle('answerer_ids', u.id)}>{u.name}</button>)}</div>
        <div style={{ marginTop: 8 }}><strong style={{ fontSize: 13 }}>Who hears about upset callers and missed-call days</strong> <span className="muted" style={{ fontSize: 12 }}>(none ticked = administrators)</span></div>
        <div className="reason-chips">{data.team.map((u) => <button type="button" key={u.id} className={`chip${cur.alert_user_ids.includes(u.id) ? ' on' : ''}`} aria-pressed={cur.alert_user_ids.includes(u.id)} onClick={() => toggle('alert_user_ids', u.id)}>{u.name}</button>)}</div>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <label>Also text these mobiles (no patient details)<input value={cur.alert_sms_to} onChange={(e) => set({ alert_sms_to: e.target.value })} placeholder="+1 512 555 0100" /></label>
          <label>Missed-call target (%)<input type="number" min={1} max={100} value={cur.missed_target_pct} onChange={(e) => set({ missed_target_pct: e.target.value })} /></label>
          <label>…once a day has at least (calls)<input type="number" min={1} max={500} value={cur.missed_min_calls} onChange={(e) => set({ missed_min_calls: e.target.value })} /></label>
        </div>
        {admin && <div className="form-actions"><button type="button" className="primary" disabled={!f} onClick={save}>Save calls and coaching</button></div>}
      </fieldset>
    </div>
  );
}
