import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, useSubmit } from './ui.jsx';
import PhoneSettings from './phones/PhoneSettings.jsx';

// Settings → Phone line: the Twilio number, the desk phone it rings, recording, the missed-call text and
// when the AI receptionist picks up.
export default function PhoneLineSettings() {
  const { data: practice, reload } = useApi('/practice');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice', { ...cur, ring_seconds: Number(cur.ring_seconds) || 20 });
    setSaved(true);
    reload();
  });
  if (!practice) return null;
  const cur = form || {
    voice_number: practice.voice_number || '', forward_to: practice.forward_to || '', ring_seconds: practice.ring_seconds || 20, record_calls: !!practice.record_calls,
    missed_call_text: practice.missed_call_text !== 0, ai_receptionist: practice.ai_receptionist || 'off', voicemail_greeting: practice.voicemail_greeting || '',
  };
  const change = (patch) => { setSaved(false); setForm({ ...cur, ...patch }); };
  const origin = window.location.origin;
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>Phone line</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Calls come in on a Twilio number and ring your office phone. In Twilio, set the number’s “A call comes in” webhook to <code>{origin}/api/webhooks/twilio/voice/inbound</code> and its call status callback to <code>{origin}/api/webhooks/twilio/call-status</code>.
        You can port your existing number to Twilio, or forward it there.
      </p>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Your Twilio number<input value={cur.voice_number} onChange={(e) => change({ voice_number: e.target.value })} placeholder="+1 512 555 0142" /></label>
        <label>Ring this phone<input value={cur.forward_to} onChange={(e) => change({ forward_to: e.target.value })} placeholder="Front desk: +1 512 555 0100 or sip:desk@…" /></label>
        <label>Ring for (seconds)<input type="number" min={5} max={60} value={cur.ring_seconds} onChange={(e) => change({ ring_seconds: e.target.value })} /></label>
        <label>
          AI receptionist answers
          <select value={cur.ai_receptionist} onChange={(e) => change({ ai_receptionist: e.target.value })}>
            <option value="off">Never (voicemail instead)</option>
            <option value="after_hours">After hours</option>
            <option value="missed">After hours and when nobody picks up</option>
            <option value="always">Every call</option>
          </select>
        </label>
      </div>
      <label className="checkbox"><input type="checkbox" checked={cur.missed_call_text} onChange={(e) => change({ missed_call_text: e.target.checked })} /> Text missed callers back right away (“Sorry we missed your call — reply here or book online”)</label>
      <label className="checkbox"><input type="checkbox" checked={cur.record_calls} onChange={(e) => change({ record_calls: e.target.checked })} /> Record calls (callers hear the message below) — transcribed and summarized when transcription is set up. Check your state’s consent rules.</label>
      <label style={{ marginTop: 8 }}>Voicemail greeting<textarea rows={2} value={cur.voicemail_greeting} onChange={(e) => change({ voicemail_greeting: e.target.value })} placeholder={`You've reached ${practice.name}. We can't take your call right now…`} /></label>
      <p className="muted" style={{ fontSize: 12 }}>The AI receptionist can find open times and book existing patients, take new-patient requests (held for you in Online requests), move or cancel a caller’s visit, and take messages. It never gives medical advice; urgent calls become a high-priority task.</p>
      <div className="form-actions">{saved && <span className="muted">Saved</span>}<button className="primary" disabled={busy}>Save</button></div>
      <PhoneSettings />
      <TrackingNumbers />
    </form>
  );
}

// Call tracking: a Twilio number per marketing source, pointed at the same webhook; calls to it are tagged
// with the source, and the patients they become are credited to it (Calls → Sources).
function TrackingNumbers() {
  const { data, reload } = useApi('/tracking-numbers');
  const [f, setF] = useState({ number: '', source: '', monthly_cost: '' });
  const add = useSubmit(async () => { await api.post('/tracking-numbers', f); setF({ number: '', source: '', monthly_cost: '' }); reload(); });
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3 style={{ margin: 0 }}>Call tracking numbers</h3>
      <p className="muted" style={{ fontSize: 12 }}>Buy a Twilio number for each ad or mailer, point its “A call comes in” webhook at the same address as above, and list it here. Its calls ring your office as usual and show which source they came from.</p>
      <ErrorBox error={add.error} />
      {(data || []).map((t) => <div key={t.id} className="inline" style={{ gap: 8, fontSize: 13 }}><strong>{t.source}</strong> {t.number} {t.monthly_cost ? <span className="muted">${(t.monthly_cost / 100).toFixed(0)}/month</span> : null}{!t.active && <span className="muted">(off)</span>}</div>)}
      <div className="inline" style={{ gap: 6, marginTop: 6 }}>
        <input placeholder="+1 512 555 0199" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} style={{ width: 150 }} />
        <input placeholder="Source (e.g. Google Ads)" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
        <input type="number" placeholder="$ / month" value={f.monthly_cost} onChange={(e) => setF({ ...f, monthly_cost: e.target.value })} style={{ width: 100 }} />
        <button type="button" className="small" disabled={add.busy || !f.number || !f.source} onClick={add.submit}>Add</button>
      </div>
    </div>
  );
}
