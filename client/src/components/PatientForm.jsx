import { useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { useNavigate } from 'react-router-dom';
import { ErrorBox, useSubmit } from './ui.jsx';
import { CustomFieldInputs, DuplicateWarning, parseCustom } from './Switching.jsx';

const EMPTY = {
  first_name: '', last_name: '', preferred_name: '', dob: '', gender: '', phone: '', email: '', address: '', city: '', state: '', zip: '',
  emergency_contact: '', referral_source: '', office_alert: '', medical_alerts: '', allergies: '', medications: '', notes: '', primary_provider_id: '', status: 'active',
  phone_home: '', phone_work: '', preferred_contact: '', language: '', primary_hygienist_id: '',
};

export default function PatientForm({ patient, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(patient || {}).filter(([k]) => k in EMPTY).map(([k, v]) => [k, v ?? ''])) }));
  const providers = useLookup('/providers?active=true');
  const [custom, setCustom] = useState(() => parseCustom(patient?.custom));
  const [dupes, setDupes] = useState(null);
  const nav = useNavigate();
  const { submit, busy, error } = useSubmit(async (force) => {
    // New charts: check for an existing chart for the same person first.
    if (!patient && force !== true) {
      const q = new URLSearchParams({ first_name: form.first_name, last_name: form.last_name, dob: form.dob, phone: form.phone, email: form.email });
      const found = await api.get(`/patients/duplicates?${q}`);
      if (found.length) return setDupes(found);
    }
    const body = { ...form, custom, primary_provider_id: form.primary_provider_id ? Number(form.primary_provider_id) : null, primary_hygienist_id: form.primary_hygienist_id ? Number(form.primary_hygienist_id) : null };
    const saved = patient ? await api.put(`/patients/${patient.id}`, body) : await api.post('/patients', body);
    onSaved(saved);
  });
  const field = (name, text, props = {}) => (
    <label className={props.full ? 'full' : ''}>
      {text}
      <input value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} {...props} full={undefined} />
    </label>
  );
  const area = (name, text) => (
    <label className="full">
      {text}
      <textarea value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} rows={2} style={{ minHeight: 50 }} />
    </label>
  );

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {field('first_name', 'First name *', { required: true })}
        {field('last_name', 'Last name *', { required: true })}
        {field('preferred_name', 'Preferred name')}
        {field('dob', 'Date of birth', { type: 'date' })}
        <label>
          Gender
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
          </select>
        </label>
        {field('phone', 'Mobile phone (texts go here)', { type: 'tel' })}
        {field('email', 'Email', { type: 'email' })}
        {field('phone_home', 'Home phone', { type: 'tel' })}
        {field('phone_work', 'Work phone', { type: 'tel' })}
        <label>
          Prefers
          <select value={form.preferred_contact} onChange={(e) => setForm({ ...form, preferred_contact: e.target.value })}>
            <option value="">No preference</option><option value="text">Text</option><option value="call">Phone call</option><option value="email">Email</option>
          </select>
        </label>
        <label>
          Language
          <input list="languages" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="English" />
          <datalist id="languages">{['English', 'Spanish', 'Vietnamese', 'Chinese', 'Tagalog', 'Arabic', 'Korean', 'Russian', 'French', 'Portuguese'].map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        {field('address', 'Address', { full: true })}
        {field('city', 'City')}
        {field('state', 'State', { maxLength: 2 })}
        {field('zip', 'ZIP')}
        {field('emergency_contact', 'Emergency contact')}
        <label>
          How did they hear about us?
          <input list="referral-sources" value={form.referral_source} onChange={(e) => setForm({ ...form, referral_source: e.target.value })} placeholder="e.g. Google, friend…" />
          <datalist id="referral-sources">{['Google', 'Insurance directory', 'Friend or family', 'Existing patient referral', 'Facebook / Instagram', 'Yelp', 'Drove by', 'Doctor referral', 'Mailer', 'Website'].map((x) => <option key={x} value={x} />)}</datalist>
        </label>
        <label>
          Primary provider
          <select value={form.primary_provider_id} onChange={(e) => setForm({ ...form, primary_provider_id: e.target.value })}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Primary hygienist
          <select value={form.primary_hygienist_id} onChange={(e) => setForm({ ...form, primary_hygienist_id: e.target.value })}>
            <option value="">—</option>
            {providers.filter((p) => p.type === 'hygienist').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {patient && (
          <label>
            Status
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
            </select>
          </label>
        )}
        <CustomFieldInputs value={custom} onChange={setCustom} />
        {area('medical_alerts', 'Medical alerts (shown prominently)')}
        {area('allergies', 'Allergies')}
        {area('medications', 'Medications')}
        {area('notes', 'Notes')}
        <label className="full">
          Pop-up office alert (shown to staff when the chart opens)
          <input value={form.office_alert} onChange={(e) => setForm({ ...form, office_alert: e.target.value })} placeholder="e.g. Anxious — offer nitrous; collect copay before seating" />
        </label>
      </div>
      {dupes && <DuplicateWarning matches={dupes} busy={busy} onUseExisting={(m) => nav(`/patients/${m.id}`)} onCreateAnyway={() => submit(true)} />}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button>
      </div>
    </form>
  );
}
