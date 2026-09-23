import { useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { fromCents, toCents } from '../format.js';
import { ErrorBox, PatientPicker, useSubmit } from './ui.jsx';

export const LAB_STATUSES = [['sent', 'Sent to lab'], ['received', 'Received'], ['returned_for_adjustment', 'Returned for adjustment'], ['delivered', 'Delivered to patient'], ['cancelled', 'Cancelled']];

export function LabCaseForm({ labCase, patient: fixedPatient, onDone }) {
  const providers = useLookup('/providers?active=true');
  const [patient, setPatient] = useState(fixedPatient || (labCase ? { id: labCase.patient_id, first_name: labCase.first_name, last_name: labCase.last_name } : null));
  const [form, setForm] = useState({
    lab_name: labCase?.lab_name || '', description: labCase?.description || '', tooth: labCase?.tooth || '', shade: labCase?.shade || '',
    provider_id: labCase?.provider_id || '', status: labCase?.status || 'sent', sent_date: labCase?.sent_date || new Date().toISOString().slice(0, 10),
    due_date: labCase?.due_date || '', cost: labCase?.cost != null ? fromCents(labCase.cost) : '', notes: labCase?.notes || '',
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    if (!patient) throw new Error('Choose a patient');
    const body = { ...form, patient_id: patient.id, provider_id: form.provider_id ? Number(form.provider_id) : null, cost: form.cost === '' ? null : toCents(form.cost) };
    if (labCase) await api.put(`/lab-cases/${labCase.id}`, body);
    else await api.post('/lab-cases', body);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {!fixedPatient && <label className="full">Patient{labCase ? <strong style={{ color: 'var(--text)' }}>{patient.first_name} {patient.last_name}</strong> : <PatientPicker value={patient} onChange={setPatient} />}</label>}
        <label>Lab<input required value={form.lab_name} onChange={set('lab_name')} placeholder="e.g. Glidewell" /></label>
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
