import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, fmtDateTime, label } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';
import { MessageTable } from '../../pages/Requests.jsx';
import SendForms, { openPdf } from '../FormsSend.jsx';

// Messages, intake forms and communication preferences for one patient.
export default function CommsTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data: messages, reload } = useApi(`/messages?patient_id=${patient.id}`);
  const { data: forms, reload: reloadForms } = useApi(can('clinical:read') ? `/patients/${patient.id}/forms` : null);
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);

  const togglePref = async (field) => {
    await api.put(`/patients/${patient.id}`, { [field]: !patient[field] });
    onChange?.();
  };

  return (
    <>
      <ErrorBox error={err} />
      <div className="grid grid-2">
        <div className="card">
          <h2>Contact preferences</h2>
          <label className="checkbox" style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={!!patient.sms_opt_in} disabled={!can('patients:write')} onChange={() => togglePref('sms_opt_in')} /> Text messages {patient.phone ? `to ${patient.phone}` : '(no phone on file)'}
          </label>
          <label className="checkbox" style={{ color: 'var(--text)', marginTop: 6 }}>
            <input type="checkbox" checked={!!patient.email_opt_in} disabled={!can('patients:write')} onChange={() => togglePref('email_opt_in')} /> Email {patient.email ? `to ${patient.email}` : '(no email on file)'}
          </label>
          {can('patients:write') && <div className="form-actions" style={{ justifyContent: 'flex-start' }}><button className="primary" onClick={() => setModal('message')}>Send a message</button></div>}
        </div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Forms & consents</h2>
            {can('patients:write') && <button className="primary" onClick={() => setModal('send-forms')}>Send forms…</button>}
          </div>
          <div style={{ marginTop: 10 }}>
            {forms?.submissions.map((f) => (
              <div key={f.id} className="inline" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span>{f.kind === 'medical_history' ? 'Health history' : f.template_name || 'Form'} · signed by <strong>{f.signature_name}</strong> {fmtDateTime(f.signed_at)}</span>
                {f.document_id
                  ? <button className="small" onClick={() => openPdf(f.document_id, f.template_name || 'form').catch(setErr)}>PDF</button>
                  : <button className="small" onClick={() => setModal({ form: f })}>View</button>}
              </div>
            ))}
            {forms?.requests.filter((r) => r.status === 'pending').map((r) => (
              <div key={r.id} className="muted" style={{ padding: '6px 0' }}>{r.kind === 'medical_history' ? 'Health history' : r.template_name} · sent {fmtDate(r.created_at)} · <Badge value={new Date(r.expires_at) < new Date() ? 'expired' : 'pending'} /></div>
            ))}
            {forms && !forms.submissions.length && !forms.requests.length && <div className="muted">No forms on file.</div>}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px' }}><h2 style={{ margin: 0 }}>Message history</h2></div>
        <MessageTable messages={messages} />
      </div>

      {modal === 'message' && (
        <Modal title={`Message ${patient.first_name}`} onClose={() => setModal(null)}>
          <MessageForm patient={patient} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal === 'send-forms' && <SendForms patient={patient} onClose={() => setModal(null)} onSent={() => { reload(); reloadForms(); }} />}
      {modal?.form && (
        <Modal title="Medical history" wide onClose={() => setModal(null)}>
          <FormView form={modal.form} />
        </Modal>
      )}
    </>
  );
}

function MessageForm({ patient, onDone }) {
  const [channel, setChannel] = useState(patient.phone && patient.sms_opt_in ? 'sms' : 'email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/messages`, { channel, subject, body });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>
          Send by
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="sms">Text ({patient.phone || 'no phone'})</option>
            <option value="email">Email ({patient.email || 'no email'})</option>
          </select>
        </label>
        {channel === 'email' && <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>}
        <label className="full">
          Message
          <textarea rows={4} required value={body} onChange={(e) => setBody(e.target.value)} maxLength={channel === 'sms' ? 480 : 5000} />
          {channel === 'sms' && <span className="muted">{body.length}/480 · Don&apos;t include clinical details in texts.</span>}
        </label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Send</button></div>
    </form>
  );
}

function FormView({ form }) {
  const d = form.data;
  const row = (k, v) => (v ? <><dt>{k}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{v}</dd></> : null);
  return (
    <div>
      <dl className="kv">
        {row('Conditions', d.conditions.join(', ') || 'None reported')}
        {row('Other', d.other_conditions)}
        {row('Allergies', d.allergies || 'None reported')}
        {row('Medications', d.medications || 'None reported')}
        {row('Premedication', d.premedication && 'Yes')}
        {row('Pregnant', d.pregnant && 'Yes')}
        {row('Tobacco', d.tobacco && 'Yes')}
        {row('Physician', [d.physician_name, d.physician_phone].filter(Boolean).join(' · '))}
        {row('Last dental visit', d.last_dental_visit)}
        {row('Concern', d.chief_concern)}
        {row('Consents', `${d.consent_hipaa ? 'Privacy notice acknowledged' : ''}; ${d.consent_treatment ? 'Consent to treatment' : ''}`)}
        {row('Signed', `${form.signature_name}, ${fmtDateTime(form.signed_at)} (IP ${form.ip || 'n/a'})`)}
      </dl>
      {form.signature_image && <img src={form.signature_image} alt="Signature" style={{ maxWidth: 360, border: '1px solid var(--border)', borderRadius: 8, marginTop: 12 }} />}
      <p className="muted" style={{ fontSize: 12 }}>Answers were applied to the patient&apos;s medical alerts, allergies, medications and contact details. Kind: {label(form.kind)}.</p>
    </div>
  );
}
