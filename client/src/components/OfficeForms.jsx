import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { fromCents, toCents } from '../format.js';
import { ErrorBox, PatientPicker, useSubmit } from './ui.jsx';

export const LAB_STATUSES = [['sent', 'Sent to lab'], ['received', 'Received'], ['returned_for_adjustment', 'Returned for adjustment'], ['delivered', 'Delivered to patient'], ['cancelled', 'Cancelled']];

export function LabCaseForm({ labCase, patient: fixedPatient, onDone }) {
  const providers = useLookup('/providers?active=true');
  const labs = useLookup('/labs');
  const [procs, setProcs] = useState([]);
  const [patient, setPatient] = useState(fixedPatient || (labCase ? { id: labCase.patient_id, first_name: labCase.first_name, last_name: labCase.last_name } : null));
  const [form, setForm] = useState({
    lab_id: labCase?.lab_id || '', procedure_id: labCase?.procedure_id || '',
    lab_name: labCase?.lab_name || '', description: labCase?.description || '', tooth: labCase?.tooth || '', shade: labCase?.shade || '',
    provider_id: labCase?.provider_id || '', status: labCase?.status || 'sent', sent_date: labCase?.sent_date || new Date().toISOString().slice(0, 10),
    due_date: labCase?.due_date || '', cost: labCase?.cost != null ? fromCents(labCase.cost) : '', notes: labCase?.notes || '',
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  // Lab work on this patient's chart (crowns, bridges, dentures) to link the case to.
  useEffect(() => {
    if (!patient?.id) return;
    api.get(`/patients/${patient.id}/procedures`).then((rows) => setProcs(rows.filter((p) => /^D(2[5-7]|29[5-6]|5|6[2-7])/.test(p.code) && p.status !== 'cancelled'))).catch(() => setProcs([]));
  }, [patient?.id]);
  const pickLab = (e) => {
    const lab = labs.find((l) => String(l.id) === e.target.value);
    const due = lab?.turnaround_days && form.sent_date && !form.due_date
      ? new Date(Date.parse(`${form.sent_date}T12:00:00Z`) + lab.turnaround_days * 86400000).toISOString().slice(0, 10) : form.due_date;
    setForm({ ...form, lab_id: e.target.value, lab_name: lab ? lab.name : form.lab_name, due_date: due });
  };
  const pickProc = (e) => {
    const p = procs.find((x) => String(x.id) === e.target.value);
    setForm({ ...form, procedure_id: e.target.value, ...(p ? { description: form.description || `${p.code} ${p.description}`, tooth: form.tooth || p.tooth || '', provider_id: form.provider_id || p.provider_id || '' } : {}) });
  };
  const { submit, busy, error } = useSubmit(async () => {
    if (!patient) throw new Error('Choose a patient');
    const body = {
      ...form, patient_id: patient.id, provider_id: form.provider_id ? Number(form.provider_id) : null, cost: form.cost === '' ? null : toCents(form.cost),
      lab_id: form.lab_id ? Number(form.lab_id) : null, procedure_id: form.procedure_id ? Number(form.procedure_id) : null,
    };
    const saved = labCase ? await api.put(`/lab-cases/${labCase.id}`, body) : await api.post('/lab-cases', body);
    if (!labCase && window.confirm('Case logged. Print the lab slip now?')) window.open(`/lab-cases/${saved.id}/slip`, '_blank');
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {!fixedPatient && <label className="full">Patient{labCase ? <strong style={{ color: 'var(--text)' }}>{patient.first_name} {patient.last_name}</strong> : <PatientPicker value={patient} onChange={setPatient} />}</label>}
        {labs.length > 0 && (
          <label>
            Lab
            <select value={form.lab_id} onChange={pickLab}>
              <option value="">Other (type below)</option>
              {labs.filter((l) => l.active || String(l.id) === String(form.lab_id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        {!form.lab_id && <label>{labs.length ? 'Lab name' : 'Lab'}<input required value={form.lab_name} onChange={set('lab_name')} placeholder="e.g. Glidewell" /></label>}
        {procs.length > 0 && (
          <label>
            For procedure
            <select value={form.procedure_id} onChange={pickProc}>
              <option value="">—</option>
              {procs.map((p) => <option key={p.id} value={p.id}>{p.code} {p.tooth ? `#${p.tooth}` : ''} {p.description.slice(0, 40)}</option>)}
            </select>
          </label>
        )}
        <label>Case<input required value={form.description} onChange={set('description')} placeholder="e.g. Zirconia crown" /></label>
        <label>Tooth<input value={form.tooth} onChange={set('tooth')} /></label>
        <label>Shade<input value={form.shade} onChange={set('shade')} /></label>
        <label>Provider<select value={form.provider_id} onChange={set('provider_id')}><option value="">—</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Status<select value={form.status} onChange={set('status')}>{LAB_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>Sent<input type="date" value={form.sent_date} onChange={set('sent_date')} /></label>
        <label>Due back<input type="date" value={form.due_date} onChange={set('due_date')} /></label>
        <label>Lab fee ($)<input type="number" step="0.01" value={form.cost} onChange={set('cost')} /></label>
        <label className="full">Notes<input value={form.notes} onChange={set('notes')} /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>{labCase ? 'Save' : 'Log lab case'}</button></div>
      {labCase && <LabRx labCase={labCase} />}
    </form>
  );
}

export function TaskForm({ task, patient: fixedPatient, onDone }) {
  const users = useLookup('/users');
  const [patient, setPatient] = useState(fixedPatient || (task?.patient_id ? { id: task.patient_id, first_name: task.first_name, last_name: task.last_name } : null));
  const [form, setForm] = useState({ title: task?.title || '', notes: task?.notes || '', due_date: task?.due_date || '', priority: task?.priority || 'normal', assigned_to: task?.assigned_to || '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { ...form, patient_id: patient?.id ?? null, assigned_to: form.assigned_to ? Number(form.assigned_to) : null };
    if (task) await api.put(`/tasks/${task.id}`, body);
    else await api.post('/tasks', body);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Task<input required autoFocus value={form.title} onChange={set('title')} /></label>
        {!fixedPatient && <label className="full">Patient (optional)<PatientPicker value={patient} onChange={setPatient} /></label>}
        <label>Assign to<select value={form.assigned_to} onChange={set('assigned_to')}><option value="">Anyone</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Due<input type="date" value={form.due_date} onChange={set('due_date')} /></label>
        <label>Priority<select value={form.priority} onChange={set('priority')}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="full">Notes<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>{task ? 'Save' : 'Add task'}</button></div>
    </form>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Put a patient on the waitlist with when they can come.
export function WaitlistForm({ patient, entry, onDone }) {
  const providers = useLookup('/providers?active=true');
  const [form, setForm] = useState(() => ({
    reason: entry?.reason || '', duration: entry?.duration || 60, provider_id: entry?.provider_id || '', times: entry?.times || 'any',
    days: entry?.days ? JSON.parse(entry.days) : [1, 2, 3, 4, 5], notes: entry?.notes || '',
  }));
  const { submit, busy, error } = useSubmit(async () => {
    const body = { ...form, provider_id: form.provider_id ? Number(form.provider_id) : null, duration: Number(form.duration) };
    if (entry) await api.put(`/waitlist/${entry.id}`, body);
    else await api.post('/waitlist', { ...body, patient_id: patient.id });
    onDone();
  });
  const toggleDay = (d) => setForm({ ...form, days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d] });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Visit for<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Cleaning, crown seat" /></label>
        <label>Minutes needed<input type="number" min="10" step="5" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>
        <label>With<select value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}><option value="">Anyone</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="full">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Days they can come</div>
          <div className="inline" style={{ flexWrap: 'wrap', gap: 4 }}>
            {DAYS.map((d, i) => <button type="button" key={d} className={`small${form.days.includes(i) ? ' primary' : ''}`} onClick={() => toggleDay(i)}>{d}</button>)}
          </div>
        </div>
        <label>Time of day<select value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })}><option value="any">Any time</option><option value="morning">Mornings</option><option value="afternoon">Afternoons</option></select></label>
        <label className="full">Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. needs 2 hours' notice" /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>{entry ? 'Save' : 'Add to waitlist'}</button></div>
    </form>
  );
}

// The digital prescription: filled in here, sent to the lab as a private link with files from the chart.
const RX_CHOICES = {
  material: ['Zirconia', 'Lithium disilicate (e.max)', 'PFM — high noble', 'Full cast gold', 'Composite', 'Acrylic'],
  margin: ['Chamfer', 'Shoulder', 'Feather edge', 'Butt joint'],
  occlusion: ['Light', 'Medium', 'Heavy', 'Out of occlusion'],
  contacts: ['Light', 'Medium', 'Heavy'],
  pontic: ['Modified ridge lap', 'Ovate', 'Sanitary', 'Conical'],
  impression: ['Digital scan', 'PVS impression', 'Alginate', 'Models'],
};
function LabRx({ labCase }) {
  const [open, setOpen] = useState(false);
  const [rx, setRx] = useState(() => ({ teeth: labCase.tooth || '', shade: labCase.shade || '', restoration: labCase.description || '', ...(labCase.rx ? JSON.parse(labCase.rx) : {}) }));
  const [docs, setDocs] = useState([]);
  const [picked, setPicked] = useState(() => (labCase.document_ids ? JSON.parse(labCase.document_ids) : []));
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (open) api.get(`/patients/${labCase.patient_id}/documents`).then(setDocs).catch(() => setDocs([]));
  }, [open, labCase.patient_id]);
  const send = useSubmit(async () => setResult(await api.post(`/lab-cases/${labCase.id}/send`, { rx, document_ids: picked })));
  const field = (k, label, wide) => (
    <label className={wide ? 'full' : ''}>{label}
      {RX_CHOICES[k] ? (
        <input list={`rx-${k}`} value={rx[k] || ''} onChange={(e) => setRx({ ...rx, [k]: e.target.value })} />
      ) : wide ? <textarea rows={3} value={rx[k] || ''} onChange={(e) => setRx({ ...rx, [k]: e.target.value })} /> : <input value={rx[k] || ''} onChange={(e) => setRx({ ...rx, [k]: e.target.value })} />}
      {RX_CHOICES[k] && <datalist id={`rx-${k}`}>{RX_CHOICES[k].map((o) => <option key={o} value={o} />)}</datalist>}
    </label>
  );
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Digital prescription</h3>
        {labCase.rx_sent_at ? <span className="muted" style={{ fontSize: 12 }}>Sent {labCase.rx_sent_at.slice(0, 10)}{labCase.lab_viewed_at ? ' · opened by the lab' : ''}{labCase.lab_status ? ` · lab: ${labCase.lab_status.replace('_', ' ')}` : ''}{labCase.tracking_number ? ` · tracking ${labCase.tracking_number}` : ''}</span> : null}
        {!open && <button type="button" className="small" onClick={() => setOpen(true)}>{labCase.rx_sent_at ? 'Edit and resend' : 'Write and send to the lab'}</button>}
      </div>
      {open && (
        <>
          <ErrorBox error={send.error} />
          <div className="form-grid" style={{ marginTop: 8 }}>
            {field('restoration', 'Restoration')}{field('teeth', 'Teeth')}{field('material', 'Material')}{field('shade', 'Shade')}{field('stump_shade', 'Stump shade')}
            {field('margin', 'Margin')}{field('occlusion', 'Occlusal contact')}{field('contacts', 'Proximal contacts')}{field('pontic', 'Pontic design')}{field('impression', 'Impression')}
            {field('scanner', 'Scanner / case ID')}{field('instructions', 'Instructions', true)}
          </div>
          {docs.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>Send these files from the chart (scans, x-rays, photos):</div>
              <div style={{ maxHeight: 140, overflow: 'auto' }}>
                {docs.map((d) => <label key={d.id} className="checkbox"><input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} /> {d.filename} <span className="muted" style={{ fontSize: 11 }}>{d.category}{d.tooth ? ` #${d.tooth}` : ''}</span></label>)}
              </div>
            </div>
          )}
          {result && <div className="public-notice ok" style={{ marginTop: 8 }}>{result.emailed ? 'Emailed to the lab.' : 'No lab email on file — send them this link:'} <input readOnly value={result.link} onFocus={(e) => e.target.select()} style={{ width: '100%', marginTop: 4 }} /></div>}
          <div className="form-actions"><button type="button" onClick={() => window.open(`/lab-cases/${labCase.id}/slip`, '_blank')}>Print slip</button><button type="button" className="primary" disabled={send.busy} onClick={send.submit}>Send to the lab</button></div>
        </>
      )}
    </div>
  );
}
