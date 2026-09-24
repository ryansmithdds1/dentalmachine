import { useEffect, useRef, useState } from 'react';
import { TriangleAlert, Check, Pencil } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, fmtDateTime, fmtUtcDate } from '../../format.js';
import { Modal, ErrorBox, useSubmit } from '../ui.jsx';
import { useShortcuts, isMac } from '../../shortcuts.js';
import { toast, undoable } from '../../toast.js';
import './medical.css';

// The medical history in one place: alerts, allergies, medications, conditions, ASA class and premedication
// are read and changed together (workflow 15). "Reviewed today, no changes" is one key (R); M (or a click on
// any line) opens the same editor inline, and saving it counts as today's review.

export const MEDICAL_CONDITIONS = [
  'Heart disease', 'Heart murmur', 'Artificial heart valve', 'Prosthetic joint', 'High blood pressure', 'Stroke', 'Diabetes', 'Asthma', 'COPD',
  'Bleeding disorder', 'Anticoagulant therapy', 'Hepatitis', 'HIV', 'Kidney disease', 'Liver disease', 'Seizures', 'Cancer / chemotherapy',
  'Radiation to head or neck', 'Bisphosphonates', 'Osteoporosis', 'Pregnant', 'Thyroid disorder', 'Tobacco use', 'Sleep apnea',
];
const ASA = [['I', 'Healthy'], ['II', 'Mild systemic disease'], ['III', 'Severe systemic disease'], ['IV', 'Severe disease, constant threat to life'], ['V', 'Moribund'], ['VI', 'Brain-dead organ donor']];
const parseList = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
const TEXT_FIELDS = [['medical_alerts', 'Medical alerts'], ['allergies', 'Allergies'], ['medications', 'Medications']];

// Due when never reviewed or reviewed more than a year ago (the huddle and the patient card use the same year).
export const medStale = (p) => !p.medical_reviewed_at || Date.now() - new Date(p.medical_reviewed_at.slice(0, 10)).getTime() > 365 * 86400000;

const valuesOf = (p) => ({
  medical_alerts: p.medical_alerts || '', allergies: p.allergies || '', medications: p.medications || '',
  medical_conditions: parseList(p.medical_conditions), asa_class: p.asa_class || '', premed_required: !!p.premed_required,
});

export default function MedicalHistory({ p, reload }) {
  const { can, practice } = useAuth();
  const canEdit = can('clinical:write');
  const [editing, setEditing] = useState(null);
  const [historyReview, setHistoryReview] = useState(false);
  const due = medStale(p);

  const markReviewed = async () => {
    try {
      await api.post(`/patients/${p.id}/medical-reviewed`);
      toast(`Medical history reviewed today — no changes for ${p.preferred_name || p.first_name}`);
      reload();
    } catch (e) {
      toast(e.message || 'Couldn’t mark it reviewed', { tone: 'error' });
    }
  };
  useShortcuts([
    { combo: 'r', handler: markReviewed, label: 'Medical history reviewed today, no changes', section: 'Medical history', enabled: canEdit && !editing },
    { combo: 'm', handler: () => setEditing('medical_alerts'), label: 'Update the medical history', section: 'Medical history', enabled: canEdit && !editing },
  ]);

  const conditions = parseList(p.medical_conditions);
  const line = (field, name, value, empty) => (
    <>
      <dt>{name}</dt>
      <dd>
        {canEdit ? (
          <button type="button" className="med-value" onClick={() => setEditing(field)} title={`Change ${name.toLowerCase()}`}>{value || <span className="muted">{empty}</span>}</button>
        ) : (value || <span className="muted">{empty}</span>)}
      </dd>
    </>
  );

  return (
    <section id="medical-history" className={`med-history${due ? ' due' : ''}`} aria-label="Medical history">
      <div className="med-head">
        <h2>Medical history</h2>
        {canEdit && !editing && (
          <span className="inline" style={{ gap: 6 }}>
            <button type="button" className={`small${due ? ' primary' : ''}`} onClick={markReviewed} title="Went over it with the patient and nothing changed (R)"><Check size={14} /> Reviewed today, no changes <kbd>R</kbd></button>
            <button type="button" className="small" onClick={() => setEditing('medical_alerts')} title="Update alerts, allergies, medications, conditions, ASA or premed (M)"><Pencil size={13} /> Update <kbd>M</kbd></button>
          </span>
        )}
      </div>
      <div className={`med-status${due ? ' due' : ''}`} role={due ? 'status' : undefined}>
        {due && <TriangleAlert size={14} aria-hidden />}
        {p.medical_reviewed_at ? `Last reviewed ${fmtUtcDate(p.medical_reviewed_at, practice?.timezone)}` : 'Never reviewed'}
        {due && <strong> — review due. Go over it with {p.preferred_name || p.first_name} at this visit.</strong>}
      </div>
      {p.history_review_pending && canEdit && (
        <div className="public-notice" style={{ marginBottom: 10 }}>
          📋 The patient submitted a new medical history. <button className="small primary" onClick={() => setHistoryReview(true)}>Review changes</button>
        </div>
      )}
      {editing ? (
        <MedicalEditor p={p} focus={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} reload={reload} />
      ) : (
        <dl className="kv med-kv">
          {line('medical_alerts', 'Alerts', p.medical_alerts, 'None')}
          {line('allergies', 'Allergies', p.allergies, 'Not recorded — ask the patient')}
          {line('medications', 'Medications', p.medications, 'None reported')}
          {line('medical_conditions', 'Conditions', conditions.length ? <span className="med-badges">{conditions.map((c) => <span key={c} className="badge warn">{c}</span>)}</span> : null, 'None checked')}
          {line('asa_class', 'ASA', p.asa_class ? `ASA ${p.asa_class} — ${ASA.find((a) => a[0] === p.asa_class)?.[1] || ''}` : null, 'Not assessed')}
          {line('premed_required', 'Premedication', p.premed_required ? <span className="badge danger">Required</span> : null, 'Not needed')}
        </dl>
      )}
      <Vitals p={p} />
      <dl className="kv"><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.notes || '—'}</dd></dl>
      {historyReview && <HistoryReview patient={p} onDone={() => { setHistoryReview(false); reload(); }} />}
    </section>
  );
}

// Everything in the history, edited inline together. Ctrl/⌘+Enter saves (and counts as today's review),
// Esc puts it back; an undo toast restores the old values.
function MedicalEditor({ p, focus, onCancel, onSaved, reload }) {
  const [f, setF] = useState(() => valuesOf(p));
  const form = useRef(null);
  const { submit, busy, error } = useSubmit(async () => {
    const before = valuesOf(p);
    const body = { ...f, asa_class: f.asa_class || null };
    await undoable('Medical history saved and marked reviewed today', () => api.put(`/patients/${p.id}/medical`, body),
      async () => { await api.put(`/patients/${p.id}/medical`, { ...before, asa_class: before.asa_class || null, reviewed: false }); reload(); });
    onSaved();
  });
  useShortcuts([{ combo: 'mod+enter', handler: () => !busy && submit(), label: 'Save the medical history', section: 'Medical history', inInputs: true }]);
  useEffect(() => {
    const el = form.current?.querySelector(`[name="${focus}"]`) || form.current?.querySelector('textarea');
    el?.focus();
    // Typing adds to what's there.
    if (el?.tagName === 'TEXTAREA') el.setSelectionRange(el.value.length, el.value.length);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [focus]);
  const others = f.medical_conditions.filter((c) => !MEDICAL_CONDITIONS.includes(c));
  const toggle = (c, on) => setF({ ...f, medical_conditions: on ? [...f.medical_conditions, c] : f.medical_conditions.filter((x) => x !== c) });
  return (
    <form ref={form} className="med-editor" onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <ErrorBox error={error} />
      {TEXT_FIELDS.map(([k, name]) => (
        <label key={k} className="full">{name}
          <textarea name={k} rows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </label>
      ))}
      <fieldset className="med-conditions">
        <legend>Conditions</legend>
        <div className="checklist">
          {[...MEDICAL_CONDITIONS, ...others].map((c, i) => (
            <label key={c} className="checkbox">
              <input type="checkbox" name={i === 0 ? 'medical_conditions' : undefined} checked={f.medical_conditions.includes(c)} onChange={(e) => toggle(c, e.target.checked)} /> {c}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        <label>ASA physical status
          <select name="asa_class" value={f.asa_class} onChange={(e) => setF({ ...f, asa_class: e.target.value })}>
            <option value="">Not assessed</option>
            {ASA.map(([v, d]) => <option key={v} value={v}>ASA {v} — {d}</option>)}
          </select>
        </label>
        <label className="checkbox" style={{ alignSelf: 'end' }}>
          <input type="checkbox" name="premed_required" checked={f.premed_required} onChange={(e) => setF({ ...f, premed_required: e.target.checked })} /> Antibiotic premedication required
        </label>
      </div>
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save — reviewed today'} <kbd>{isMac ? '⌘' : 'Ctrl'}+Enter</kbd></button>
      </div>
    </form>
  );
}

// Latest blood pressure and pulse, recorded inline.
function Vitals({ p }) {
  const { can } = useAuth();
  const { data: vitals, reload: reloadVitals } = useApi(`/patients/${p.id}/vitals`);
  const [vForm, setVForm] = useState(null);
  const [warning, setWarning] = useState(null);
  const latest = vitals?.[0];
  const { submit, busy, error } = useSubmit(async () => {
    const v = await api.post(`/patients/${p.id}/vitals`, vForm);
    setWarning(v.warning);
    setVForm(null);
    reloadVitals();
  });
  return (
    <div style={{ margin: '10px 0' }}>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 8, fontSize: 13 }}>
        <strong>Vitals:</strong>
        {latest ? <span>BP {latest.bp_systolic ? `${latest.bp_systolic}/${latest.bp_diastolic}` : '—'} · pulse {latest.pulse || '—'} <span className="muted">({fmtDate(latest.recorded_at.slice(0, 10))})</span></span> : <span className="muted">none recorded</span>}
        {can('clinical:write') && !vForm && <button className="small" onClick={() => setVForm({ bp_systolic: '', bp_diastolic: '', pulse: '' })}>Record vitals</button>}
      </div>
      {warning && <div className="error" style={{ marginTop: 6 }}>{warning}</div>}
      {vForm && (
        <form className="inline" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error} />
          <input type="number" placeholder="Systolic" style={{ width: 90 }} value={vForm.bp_systolic} onChange={(e) => setVForm({ ...vForm, bp_systolic: e.target.value })} aria-label="Systolic" />
          /
          <input type="number" placeholder="Diastolic" style={{ width: 90 }} value={vForm.bp_diastolic} onChange={(e) => setVForm({ ...vForm, bp_diastolic: e.target.value })} aria-label="Diastolic" />
          <input type="number" placeholder="Pulse" style={{ width: 80 }} value={vForm.pulse} onChange={(e) => setVForm({ ...vForm, pulse: e.target.value })} aria-label="Pulse" />
          <button className="small primary" disabled={busy}>Save</button>
          <button type="button" className="small" onClick={() => setVForm(null)}>Cancel</button>
        </form>
      )}
      {vitals?.length > 1 && (
        <details style={{ fontSize: 12, marginTop: 4 }}>
          <summary className="muted">Vitals history</summary>
          {vitals.map((v) => <div key={v.id}>{fmtDate(v.recorded_at.slice(0, 10))}: BP {v.bp_systolic ? `${v.bp_systolic}/${v.bp_diastolic}` : '—'}, pulse {v.pulse || '—'} {v.recorded_by_name ? <span className="muted">· {v.recorded_by_name}</span> : null}</div>)}
        </details>
      )}
    </div>
  );
}

// A clinician compares the history the patient submitted (intake form) with the chart and accepts the merged values.
function HistoryReview({ patient, onDone }) {
  const { data } = useApi(`/patients/${patient.id}/history-review`);
  const [form, setForm] = useState(null);
  const values = form || (data && Object.fromEntries(TEXT_FIELDS.map(([f]) => [f, data.changes[f] ? data.changes[f].proposed || '' : patient[f] || ''])));
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patient-forms/${data.form_id}/review`, values);
    onDone();
  });
  return (
    <Modal title="Review medical history" wide onClose={() => onDone()}>
      {!data ? <div className="empty">Loading…</div> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error} />
          <p className="muted">Signed by {data.signature_name} on {fmtDateTime(data.signed_at.replace(' ', 'T') + 'Z')}. Nothing on the chart changes until you save.</p>
          {TEXT_FIELDS.map(([f, name]) => (
            <div key={f} style={{ marginBottom: 14 }}>
              <strong>{name}</strong>{!data.changes[f] && <span className="muted"> — no change</span>}
              {data.changes[f] && (
                <div className="grid grid-2" style={{ fontSize: 13, margin: '4px 0' }}>
                  <div><span className="muted">On the chart:</span> {data.changes[f].current || '—'}</div>
                  <div><span className="muted">Patient reported:</span> {data.changes[f].reported || '—'}</div>
                </div>
              )}
              <textarea rows={2} value={values[f]} onChange={(e) => setForm({ ...values, [f]: e.target.value })} />
            </div>
          ))}
          {(data.answers.pregnant || data.answers.premedication || data.answers.tobacco) && (
            <p style={{ fontSize: 13 }}>{[data.answers.pregnant && 'Pregnant', data.answers.premedication && 'Needs premedication', data.answers.tobacco && 'Uses tobacco'].filter(Boolean).join(' · ')}</p>
          )}
          <div className="form-actions"><button className="primary" disabled={busy}>Save to chart</button></div>
        </form>
      )}
    </Modal>
  );
}
