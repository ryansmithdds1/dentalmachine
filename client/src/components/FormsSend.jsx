import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, download } from '../api.js';
import { useLookup } from '../hooks.js';
import { fmtDate } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

const KIND_LABEL = { consent: 'Consents', policy: 'Policies', intake: 'Intake', other: 'Other' };

// Choose forms for a patient and send them as one link (or open it on this device for the patient to sign).
// From a treatment plan, the consents that match its procedures are picked already.
// "Sign here" opens them in this tab for the patient, with a one-time pass instead of the birth-date step
// (only this signed-in device can use it); the page has a way back to the chart when they're done.
export default function SendForms({ patient, procedureIds = [], appointmentId = null, title, onClose, onSent }) {
  const navigate = useNavigate();
  const templates = useLookup('/form-templates');
  const [picked, setPicked] = useState(null);
  const [history, setHistory] = useState(!procedureIds.length);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!procedureIds.length) { setPicked(new Set()); return; }
    api.get(`/patients/${patient.id}/consents/suggest?procedure_ids=${procedureIds.join(',')}`).then((list) => setPicked(new Set(list.map((t) => t.id)))).catch(() => setPicked(new Set()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient.id, procedureIds.join(',')]);

  const { submit, busy, error } = useSubmit(async (send) => {
    const r = await api.post(`/patients/${patient.id}/form-packets`, { template_ids: [...picked], history, procedure_ids: procedureIds, appointment_id: appointmentId, send, here: !send });
    onSent?.();
    if (!send) {
      navigate(`${new URL(r.url, window.location.origin).pathname}#here=${encodeURIComponent(r.handoff)}`);
      return;
    }
    setResult(r);
  });
  const toggle = (id) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  const count = (picked?.size || 0) + (history ? 1 : 0);
  const reachable = (patient.phone && patient.sms_opt_in) || (patient.email && patient.email_opt_in);

  return (
    <Modal title={title || `Forms for ${patient.first_name}`} onClose={onClose}>
      <ErrorBox error={error} />
      {result ? (
        <>
          <div className="public-notice ok">
            {result.message ? `Sent by ${result.message.channel === 'sms' ? 'text' : 'email'}. ` : ''}
            The link works until {fmtDate(result.expires_at)}.
          </div>
          <div style={{ marginTop: 8, wordBreak: 'break-all' }}><a href={result.url} target="_blank" rel="noreferrer">{result.url}</a></div>
          <div className="form-actions"><button className="primary" onClick={onClose}>Done</button></div>
        </>
      ) : !picked ? <div className="muted">Loading…</div> : (
        <>
          <label className="checkbox" style={{ color: 'var(--text)', marginBottom: 8 }}>
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Health history
          </label>
          {['consent', 'policy', 'intake', 'other'].map((kind) => {
            const list = templates.filter((t) => t.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind} style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>{KIND_LABEL[kind]}</div>
                {list.map((t) => (
                  <label key={t.id} className="checkbox" style={{ color: 'var(--text)', margin: '4px 0' }}>
                    <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} /> {t.name}
                    {t.procedure_codes && <span className="muted" style={{ fontSize: 12 }}> · {t.procedure_codes}</span>}
                  </label>
                ))}
              </div>
            );
          })}
          <div className="form-actions">
            <button type="button" autoFocus disabled={busy || !count} title="Opens here for the patient — no birth date needed on this device" onClick={() => submit(null)}>Sign here on this device</button>
            <button className="primary" disabled={busy || !count || !reachable} title={reachable ? '' : 'No phone or email the patient accepts messages on'} onClick={() => submit('auto')}>
              Send {count > 1 ? `${count} forms` : 'form'} by {patient.phone && patient.sms_opt_in ? 'text' : 'email'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// A signed practice form's PDF in the chart.
export const openPdf = (documentId, name) => download(`/documents/${documentId}/file`, `${name}.pdf`);
