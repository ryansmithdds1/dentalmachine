import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { undoable, toast } from '../toast.js';
import { PatientPicker } from './ui.jsx';

// On the patient's chart (PX): the newsletter (opt-in), VIP (mailed birthday card), no celebrations at all, and who
// referred them (so the referral thank-you reaches that patient). Each tick saves at once, with undo.
export default function JourneyPrefs({ patientId }) {
  const { data, reload } = useApi(`/journeys/patients/${patientId}/prefs`, [patientId]);
  const [picking, setPicking] = useState(false);
  if (!data) return null;
  const set = (k, v) => undoable(
    `${LABELS[k]} ${v ? 'on' : 'off'}`,
    async () => { await api.put(`/journeys/patients/${patientId}/prefs`, { [k]: v }); reload(); },
    async () => { await api.put(`/journeys/patients/${patientId}/prefs`, { [k]: !v }); reload(); },
  ).catch(() => {});
  const referred = async (p) => {
    setPicking(false);
    if (!p) return;
    try {
      await api.post('/journeys/referrals', { referrer_patient_id: p.id, referred_patient_id: patientId });
      toast(`Referred by ${p.first_name} ${p.last_name}`);
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Staying in touch</h3>
      {Object.entries(LABELS).map(([k, l]) => (
        <label key={k} className="inline" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!data[k]} onChange={(e) => set(k, e.target.checked)} /> {l}
        </label>
      ))}
      <div style={{ marginTop: 8, fontSize: 13 }}>
        Referred by: {data.referred_by ? <strong>{data.referred_by.name}</strong> : picking ? <PatientPicker value={null} onChange={referred} /> : (
          <button type="button" className="link" onClick={() => setPicking(true)}>a patient…</button>
        )}
      </div>
    </div>
  );
}

const LABELS = { newsletter: 'Newsletter (they asked for it)', vip: 'VIP (mailed birthday card)', no_celebrations: 'No birthday or holiday messages' };
