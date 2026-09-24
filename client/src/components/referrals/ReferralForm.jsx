import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { money } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import './referrals.css';

const URGENCY = [['routine', 'Routine'], ['soon', 'Soon'], ['critical', 'Critical']];
const SEND = [['email', 'Email secure link'], ['print', 'Print'], ['fax', 'Print to fax'], ['none', 'Don’t send']];
const SPECIALTIES = ['Endodontics', 'Oral surgery', 'Periodontics', 'Orthodontics', 'Pediatric dentistry', 'Prosthodontics', 'Oral medicine', 'General dentist', 'Physician'];
const newKey = () => globalThis.crypto?.randomUUID?.() || `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Refer a patient in one step (RT1): specialist (the one used last for this kind of work is chosen), what for (the
// planned procedures picked on the chart, or a reason), how urgent, files to send along, and how the letter goes.
// Ctrl/⌘+Enter sends. Used on the Referrals board (N), the chart and the treatment plan ("Refer" on procedures).
// Props: patient { id, first_name, last_name }, procedureIds (planned procedures to refer), direction 'out' | 'in',
// onDone(result), onCancel.
export default function ReferralForm({ patient, procedureIds = [], direction = 'out', onDone, onCancel }) {
  const { can } = useAuth();
  const out = direction === 'out';
  const { data: contacts, reload: reloadContacts } = useApi('/referral-contacts');
  const { data: suggestion } = useApi(`/referral-tracker/suggest?patient_id=${patient.id}${procedureIds.length ? `&procedure_ids=${procedureIds.join(',')}` : ''}`);
  const { data: docs } = useApi(out && can('clinical:read') ? `/patients/${patient.id}/documents` : null);
  const [clientKey] = useState(newKey);
  const [form, setForm] = useState({ contact_id: '', reason: '', urgency: 'routine', send: 'print', text_patient: true, notes: '' });
  const [picked, setPicked] = useState(procedureIds);
  const [files, setFiles] = useState([]);
  const [newContact, setNewContact] = useState(null);
  const [touched, setTouched] = useState({});
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setTouched((t) => ({ ...t, [k]: true })); };

  // Smart defaults, once they arrive (never over what the person already changed).
  useEffect(() => {
    if (!suggestion) return;
    setForm((f) => ({
      ...f,
      contact_id: touched.contact_id || !out ? f.contact_id : String(suggestion.contact?.id || ''),
      reason: touched.reason ? f.reason : out ? suggestion.reason || '' : f.reason,
      send: touched.send ? f.send : out ? suggestion.send : 'none',
      text_patient: touched.text_patient ? f.text_patient : suggestion.text_patient,
    }));
  }, [suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const contact = useMemo(() => contacts?.find((c) => String(c.id) === String(form.contact_id)), [contacts, form.contact_id]);
  // Email needs an address: without one the letter is printed.
  useEffect(() => {
    if (out && contact && !contact.email && form.send === 'email') setForm((f) => ({ ...f, send: 'print' }));
  }, [contact]); // eslint-disable-line react-hooks/exhaustive-deps
  const planned = suggestion?.planned || [];
  const chosen = planned.filter((p) => picked.includes(p.procedure_id));
  const recentDocs = (docs || []).slice(0, 12);

  const { submit, busy, error } = useSubmit(async () => {
    const body = {
      direction, client_key: clientKey, reason: form.reason || null, notes: form.notes || null, urgency: out ? form.urgency : 'routine',
      ...(newContact ? { new_contact: newContact } : { contact_id: Number(form.contact_id) || null }),
      ...(out ? { items: chosen.map((p) => ({ procedure_id: p.procedure_id })), document_ids: files, send: form.send, text_patient: !!form.text_patient } : {}),
    };
    const r = await api.post(`/referral-tracker/patients/${patient.id}/referrals`, body);
    if (newContact) reloadContacts();
    const ref = r.referral;
    if (r.letter?.status === 'print') window.open(`/referrals/${ref.id}/letter`, '_blank');
    const bits = [
      out ? `Referred to ${ref.contact_name}` : `Saved — referred by ${ref.contact_name}`,
      r.letter?.status === 'sent' ? 'letter emailed' : r.letter?.error ? `letter not sent (${r.letter.error})` : null,
      r.patient_text?.status === 'sent' ? 'patient texted' : null,
      r.alert ? 'team alerted' : null,
    ].filter(Boolean);
    toast(bits.join(' · '), { tone: r.letter?.error ? 'error' : 'ok' });
    onDone?.(r);
  });
  const ready = (newContact ? newContact.name : form.contact_id) && (!out || form.reason || chosen.length);
  useShortcuts([{ combo: 'mod+enter', handler: () => ready && !busy && submit(), label: 'Send the referral', inInputs: true }]);

  return (
    <form className="rt-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="rt-for muted">{out ? 'Refer' : 'Referred to us:'} <strong>{patient.first_name} {patient.last_name}</strong></div>
      {newContact ? (
        <div className="form-grid rt-new-contact">
          <label>Name<input autoFocus required value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Dr. Jane Smith" /></label>
          <label>Practice<input value={newContact.practice_name} onChange={(e) => setNewContact({ ...newContact, practice_name: e.target.value })} /></label>
          <label>Specialty<input list="rt-specialties" value={newContact.specialty} onChange={(e) => setNewContact({ ...newContact, specialty: e.target.value })} /></label>
          <label>Phone<input value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} /></label>
          <label>Fax<input value={newContact.fax} onChange={(e) => setNewContact({ ...newContact, fax: e.target.value })} /></label>
          <label>Email<input type="email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} /></label>
          <datalist id="rt-specialties">{SPECIALTIES.map((x) => <option key={x} value={x} />)}</datalist>
          <div className="full"><button type="button" className="link" onClick={() => setNewContact(null)}>Choose from the list instead</button></div>
        </div>
      ) : (
        <label className="rt-field">
          {out ? 'Specialist' : 'Referring doctor'}
          <select required value={form.contact_id} onChange={(e) => (e.target.value === 'new' ? setNewContact({ name: '', practice_name: '', specialty: '', phone: '', fax: '', email: '' }) : set('contact_id', e.target.value))}>
            <option value="">Choose…</option>
            {contacts?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}{c.practice_name ? ` — ${c.practice_name}` : ''}{c.specialty ? ` (${c.specialty})` : ''}</option>)}
            <option value="new">+ Someone new…</option>
          </select>
        </label>
      )}
      {out && planned.length > 0 && (
        <div className="rt-field">
          <span>Procedures to refer</span>
          <div className="chips">
            {planned.map((p) => (
              <button type="button" key={p.procedure_id} className={`chip${picked.includes(p.procedure_id) ? ' active' : ''}`} aria-pressed={picked.includes(p.procedure_id)}
                onClick={() => setPicked((x) => (x.includes(p.procedure_id) ? x.filter((y) => y !== p.procedure_id) : [...x, p.procedure_id]))}>
                {p.code}{p.tooth ? ` #${p.tooth}` : ''} <span className="muted">{p.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="rt-field">{out ? 'Reason' : 'Note'}<input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder={out ? 'e.g. RCT #19, symptomatic irreversible pulpitis' : 'e.g. implant consult'} /></label>
      {out && (
        <>
          <div className="rt-field">
            <span>How urgent</span>
            <div className="seg rt-urgency" role="radiogroup" aria-label="How urgent">
              {URGENCY.map(([k, l]) => (
                <button type="button" key={k} role="radio" aria-checked={form.urgency === k} className={`${form.urgency === k ? 'active' : ''} rt-u-${k}`} onClick={() => set('urgency', k)}>{l}</button>
              ))}
            </div>
            {form.urgency === 'critical' && <div className="rt-hint">The dentist and the front desk are alerted now and every week until the patient is seen.</div>}
          </div>
          {recentDocs.length > 0 && (
            <div className="rt-field">
              <span>Send along</span>
              <div className="chips">
                {recentDocs.map((d) => (
                  <button type="button" key={d.id} className={`chip${files.includes(d.id) ? ' active' : ''}`} aria-pressed={files.includes(d.id)}
                    onClick={() => setFiles((x) => (x.includes(d.id) ? x.filter((y) => y !== d.id) : [...x, d.id]))}>{d.filename}</button>
                ))}
              </div>
            </div>
          )}
          <div className="rt-field">
            <span>Letter</span>
            <div className="seg" role="radiogroup" aria-label="Send the letter">
              {SEND.map(([k, l]) => (
                <button type="button" key={k} role="radio" aria-checked={form.send === k} className={form.send === k ? 'active' : ''} disabled={k === 'email' && !newContact && contact && !contact.email}
                  title={k === 'email' && contact && !contact.email ? 'No email address on file' : undefined} onClick={() => set('send', k)}>{l}</button>
              ))}
            </div>
          </div>
          <label className="rt-check"><input type="checkbox" checked={!!form.text_patient} onChange={(e) => set('text_patient', e.target.checked)} /> Text the patient the specialist’s number</label>
          <label className="rt-field">Notes for the specialist<textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          {chosen.length > 0 && <div className="muted rt-hint">At your fees: {money(chosen.reduce((s, p) => s + (p.fee || 0), 0))}</div>}
        </>
      )}
      <div className="form-actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary rt-send" disabled={busy || !ready}>{out ? 'Send referral' : 'Save'}</button>
      </div>
    </form>
  );
}
