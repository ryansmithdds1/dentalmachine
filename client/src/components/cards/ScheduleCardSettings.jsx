import { useEffect, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import CardLayoutEditor from './CardLayoutEditor.jsx';
import './cards.css';

// Settings → Schedule → "Appointment cards": what each card shows (S6) and the office's list of patient
// preferences (PP1). Mounted by Settings.jsx (see docs/workflows/specs/PP-DN-S8-S6.md for the line).
const CATEGORIES = [['comfort', 'Comfort'], ['care', 'Care'], ['scheduling', 'Scheduling'], ['other', 'Other']];

export function PreferenceOptions() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [list, setList] = useState(null);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('comfort');
  const load = () => api.get('/preference-options?all=1').then(setList).catch((err) => toast(err.message, { tone: 'error' }));
  useEffect(() => { load(); }, []);
  const add = async () => {
    try {
      await api.post('/preference-options', { label: label.trim(), category });
      setLabel('');
      load();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  const set = async (o, patch) => {
    try { await api.put(`/preference-options/${o.id}`, patch); load(); } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  return (
    <div className="card">
      <h3>Patient preferences</h3>
      <p className="muted" style={{ fontSize: 13 }}>The list the team picks from on a patient (pillow, blanket, no nitrous…). Any of them can be marked urgent on a patient: urgent ones show on the schedule card, the patient bar and the visit panel.</p>
      <ul className="pn-timeline">
        {(list || []).map((o) => (
          <li key={o.id} className={o.active ? '' : 'removed'}>
            <span className="pn-body">{o.label}</span> <span className="muted">· {CATEGORIES.find(([k]) => k === o.category)?.[1]}</span>
            {admin && (o.active
              ? <button type="button" className="icon-btn tiny" onClick={() => set(o, { active: false })} aria-label={`Retire ${o.label}`} title="Retire (kept on patients who have it)"><X size={12} /></button>
              : <button type="button" className="icon-btn tiny" onClick={() => set(o, { active: true })} aria-label={`Bring back ${o.label}`} title="Bring back"><RotateCcw size={12} /></button>)}
          </li>
        ))}
      </ul>
      {admin && (
        <form className="inline" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (label.trim()) add(); }}>
          <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Likes the window chair" aria-label="New preference" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Kind" style={{ width: 'auto' }}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="small" disabled={!label.trim()}><Plus size={13} /> Add</button>
        </form>
      )}
    </div>
  );
}

export default function ScheduleCardSettings() {
  return (
    <>
      <CardLayoutEditor inline />
      <PreferenceOptions />
    </>
  );
}
