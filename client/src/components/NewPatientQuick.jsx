import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { practiceToday } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox, useSubmit } from './ui.jsx';
import { DuplicateWarning } from './Switching.jsx';
import PatientForm from './PatientForm.jsx';
import { parseNewPatient } from './newPatientLine.js';

const FIELDS = [
  ['first_name', 'First name *'], ['last_name', 'Last name *'], ['dob', 'Date of birth', 'date'], ['phone', 'Mobile phone (texts go here)', 'tel'], ['email', 'Email', 'email'],
];

// New patient (workflow 32, docs/workflows/specs/32-new-patient.md): one line typed the way the caller says it,
// split into the fields below (each can be changed), and the primary policy made at the same time when a carrier
// is named. Enter makes the chart. "All fields" switches to the full form in this same dialog with what's typed.
export default function NewPatientQuick({ defaults, onSaved, onCancel }) {
  const { practice } = useAuth();
  const nav = useNavigate();
  const carriers = useLookup('/carriers');
  const [line, setLine] = useState('');
  const [edits, setEdits] = useState({});
  const [dupes, setDupes] = useState(null);
  const [full, setFull] = useState(false);
  const today = practiceToday(practice?.timezone);
  const parsed = useMemo(() => parseNewPatient(line, { carriers, today }), [line, carriers, today]);
  // What's known already (a caller's number), then what the line says, then what the person typed in a field.
  const valuesFrom = (p) => ({ first_name: '', last_name: '', dob: '', phone: '', email: '', carrier_id: '', subscriber_id: '', ...(defaults || {}), ...p, ...edits });
  const v = valuesFrom(parsed);
  const set = (k) => (e) => setEdits({ ...edits, [k]: e.target.value });

  const { submit, busy, error } = useSubmit(async (force) => {
    // Enter pressed before the carrier list arrived: read the line again with it, so a carrier's name isn't
    // taken for part of the patient's name.
    let known = carriers;
    let v = valuesFrom(parsed);
    if (!known.length && line.trim()) {
      known = await api.get('/carriers').catch(() => []);
      if (known.length) v = valuesFrom(parseNewPatient(line, { carriers: known, today }));
    }
    if (!v.first_name.trim() || !v.last_name.trim()) throw new Error('Type at least a first and last name');
    if (v.carrier_id && !v.subscriber_id.trim()) throw new Error('Add the member ID for the insurance, or choose “No insurance”');
    const person = { first_name: v.first_name.trim(), last_name: v.last_name.trim(), dob: v.dob || '', phone: v.phone || '', email: v.email || '' };
    if (force !== true) {
      const found = await api.get(`/patients/duplicates?${new URLSearchParams(person)}`);
      if (found.length) return setDupes(found);
    }
    const saved = await api.post('/patients', { ...person, dob: person.dob || null, phone: person.phone || null, email: person.email || null });
    if (v.carrier_id) {
      try {
        const policy = await api.post(`/patients/${saved.id}/insurance`, {
          carrier_id: Number(v.carrier_id), priority: 'primary', relationship: 'self', subscriber_name: `${person.first_name} ${person.last_name}`,
          subscriber_id: v.subscriber_id.trim(), subscriber_dob: person.dob || null,
        });
        // Eligibility runs in the background; the chart shows the answer when it's back.
        api.post(`/insurance/${policy.id}/eligibility`).catch((e) => toast(`Couldn’t check eligibility yet: ${e.message}`, { tone: 'error' }));
        toast(`${person.first_name} ${person.last_name} added with ${known.find((c) => c.id === Number(v.carrier_id))?.name || 'insurance'}`);
      } catch (e) {
        toast(`Chart made, but the insurance didn’t save: ${e.message}`, { tone: 'error', ms: 8000 });
        return nav(`/patients/${saved.id}?tab=insurance`);
      }
    } else toast(`${person.first_name} ${person.last_name} added`);
    onSaved(saved);
  });

  if (full) {
    const { carrier_id: _c, subscriber_id: _s, ...person } = v;
    return <PatientForm defaults={person} onSaved={onSaved} onCancel={onCancel} />;
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="np-quick">
      <ErrorBox error={error} />
      <label className="full">
        Type it the way they say it
        <input
          autoFocus aria-label="New patient in one line" value={line} onChange={(e) => setLine(e.target.value)} autoComplete="off"
          placeholder="Jane Doe 3/14/1985 512-555-0100 jane@example.com Delta W123456789"
        />
        <span className="muted" style={{ fontSize: 12 }}>Name, birth date, mobile, email and — if they have it — the insurance company and member ID, in any order. Enter saves.</span>
      </label>
      <div className="form-grid" style={{ marginTop: 10 }}>
        {FIELDS.map(([k, text, type]) => (
          <label key={k}>{text}<input type={type || 'text'} value={v[k] || ''} onChange={set(k)} /></label>
        ))}
        <label>
          Insurance
          <select value={v.carrier_id || ''} onChange={set('carrier_id')} aria-label="Insurance company">
            <option value="">No insurance / add later</option>
            {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {v.carrier_id ? <label>Member ID<input value={v.subscriber_id || ''} onChange={set('subscriber_id')} aria-label="Member ID" /></label> : null}
      </div>
      {v.carrier_id ? <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>Primary policy, the patient is the subscriber. Benefits and eligibility are checked with the carrier after saving.</p> : null}
      {dupes && <DuplicateWarning matches={dupes} busy={busy} onUseExisting={(m) => nav(`/patients/${m.id}`)} onCreateAnyway={() => submit(true)} />}
      <div className="form-actions">
        <button type="button" className="link" style={{ marginRight: 'auto' }} onClick={() => setFull(true)}>All fields (address, provider, medical…)</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button>
      </div>
    </form>
  );
}
