import { useEffect, useState } from 'react';
import { Library, Tablet, Timer, Languages, ShieldCheck, Scale, History } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { fmtDateTime } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import './consents.css';

// Settings → Forms & consents: the consent library (C1), which consents go with which treatment (C2), Spanish
// wording and witnesses (C4), when each form is due and the paperwork autopilot (P1/P5), and the kiosk iPads (P3).
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
const RULES = [['', 'Once (or by “renew every”)'], ['once', 'Once'], ['yearly', 'Every year'], ['every_visit', 'Every visit (screenings)'], ['new_patient', 'New patients only']];
const label = (s) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export default function ConsentSettings() {
  const lib = useApi('/consents/library');
  const forms = useApi('/form-templates');
  const settings = useApi('/paperwork/settings');
  const kiosks = useApi('/forms-kiosks');
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const act = async (fn, msg) => {
    setError(null);
    try { await fn(); if (msg) toast(msg); lib.reload(); forms.reload(); settings.reload(); kiosks.reload(); } catch (e) { setError(e); }
  };
  const missing = (lib.data || []).filter((x) => !x.installed);
  return (
    <div className="card">
      <h2><Library size={18} /> Forms &amp; consents</h2>
      <ErrorBox error={error || lib.error || forms.error} />

      <h3>Consent library</h3>
      <p className="muted">Ready-made consents in English and Spanish. They’re templates — <b>review them with your attorney</b> and edit them to your office’s wording. Every version is kept; a signed consent always shows the exact wording the patient saw.</p>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {(lib.data || []).map((x) => (
          <span key={x.key} className={`cp-chip ${x.installed ? (x.legal_review ? 'warn' : 'ok') : 'info'}`} title={x.installed ? (x.legal_review ? 'Template — not yet reviewed by your attorney' : 'Reviewed') : 'Not added yet'}>{x.name}</span>
        ))}
      </div>
      {missing.length > 0 && <button className="primary" onClick={() => act(() => api.post('/consents/library/install', { keys: missing.map((x) => x.key) }), `Added ${missing.length} consent${missing.length === 1 ? '' : 's'}`)}>Add {missing.length} from the library</button>}

      <h3 style={{ marginTop: 18 }}>Which form, when</h3>
      <table className="table">
        <thead><tr><th>Form</th><th>Attached to / due</th><th>Version</th><th /></tr></thead>
        <tbody>
          {(forms.data || []).map((t) => (
            <FormRow key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} act={act} />
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 18 }}><Timer size={16} /> Paperwork on autopilot</h3>
      {settings.data && <Autopilot s={settings.data} act={act} />}

      <h3 style={{ marginTop: 18 }}><Tablet size={16} /> Office iPads (kiosk mode)</h3>
      <p className="muted">On the iPad, sign in as an administrator and open <code>{window.location.origin}/kiosk</code>. It then signs itself out and waits for patients; staff press “Hand iPad” on a patient. Turn on Guided Access on the iPad to lock it to this page.</p>
      <table className="table">
        <tbody>
          {(kiosks.data || []).map((k) => (
            <tr key={k.id}>
              <td>{k.name}{k.operatory_name ? <span className="muted"> · {k.operatory_name}</span> : null}</td>
              <td className="muted">{k.revoked_at ? 'Turned off' : k.last_seen_at ? `Last seen ${fmtDateTime(k.last_seen_at)}` : 'Not seen yet'}</td>
              <td>{!k.revoked_at && <button className="small" onClick={() => act(() => api.post(`/forms-kiosks/${k.id}/revoke`), `${k.name} is no longer a kiosk`)}>Turn off</button>}</td>
            </tr>
          ))}
          {kiosks.data?.length === 0 && <tr><td className="muted">No iPads yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FormRow({ t, open, onToggle, act }) {
  const [codes, setCodes] = useState(t.procedure_codes || '');
  const [cats, setCats] = useState(() => new Set(String(t.procedure_categories || '').split(/[\s,]+/).filter(Boolean)));
  const [rule, setRule] = useState(t.due_rule || '');
  const [witness, setWitness] = useState(!!t.witness);
  const [es, setEs] = useState(() => (t.fields_es ? JSON.parse(t.fields_es).map((f) => (f.options_es ? { ...f, options: f.options_es } : f)) : null));
  const [versions, setVersions] = useState(null);
  useEffect(() => { if (open) api.get(`/form-templates/${t.id}/versions`).then(setVersions).catch(() => setVersions([])); }, [open, t.id]);
  const consent = t.kind === 'consent';
  const save = () => act(() => api.put(`/form-templates/${t.id}/consent-settings`, consent
    ? { procedure_codes: codes, procedure_categories: [...cats], witness, ...(es ? { fields_es: es } : {}) }
    : { due_rule: rule || null, ...(es ? { fields_es: es } : {}) }), `${t.name} saved`);
  const startEs = () => setEs(t.fields.map((f) => ({ ...f, ...(f.options ? { options: f.options } : {}) })));
  return (
    <>
      <tr>
        <td>{t.name}{t.legal_review ? <span className="cp-chip warn" style={{ marginLeft: 6 }} title="Template — review with your attorney"><Scale size={11} /> template</span> : null}{t.fields_es ? <span className="muted" title="Has Spanish wording"> · ES</span> : null}</td>
        <td className="muted">{consent ? [t.procedure_codes, t.procedure_categories].filter(Boolean).join(' · ') || 'Not attached automatically' : RULES.find(([k]) => k === (t.due_rule || ''))?.[1]}{consent && t.witness ? ' · witness' : ''}</td>
        <td>v{t.version}</td>
        <td><button className="small" onClick={onToggle}>{open ? 'Close' : 'Edit'}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <div className="form-grid">
              {consent ? (
                <>
                  <label className="full">Procedure codes (prefixes: D71 covers D7140)<input value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="D71, D72" /></label>
                  <div className="full">
                    <div className="muted" style={{ fontSize: 12 }}>…or any procedure in these categories</div>
                    <div className="inline" style={{ flexWrap: 'wrap', gap: 8 }}>
                      {CATEGORIES.map((c) => <label key={c} className="checkbox"><input type="checkbox" checked={cats.has(c)} onChange={() => { const n = new Set(cats); if (n.has(c)) n.delete(c); else n.add(c); setCats(n); }} /> {label(c)}</label>)}
                    </div>
                  </div>
                  <label className="checkbox"><input type="checkbox" checked={witness} onChange={(e) => setWitness(e.target.checked)} /> A team member signs as witness (on the office iPad)</label>
                </>
              ) : (
                <label>When is it due?<select value={rule} onChange={(e) => setRule(e.target.value)}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="inline"><Languages size={16} /> <b>Spanish wording</b> {!es && <button className="small" onClick={startEs}>Add Spanish</button>}</div>
              {es && es.map((f, i) => (
                <div key={i} className="form-grid" style={{ marginTop: 6 }}>
                  <div className="muted" style={{ fontSize: 12 }}>{t.fields[i].type}: {t.fields[i].label || t.fields[i].text?.slice(0, 80)}</div>
                  {f.type === 'paragraph'
                    ? <textarea className="full" rows={3} value={f.text || ''} onChange={(e) => setEs(es.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} aria-label={`Spanish for field ${i + 1}`} />
                    : <input className="full" value={f.label || ''} onChange={(e) => setEs(es.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Spanish for field ${i + 1}`} />}
                  {f.type === 'select' && <input className="full" value={(f.options_es || f.options || []).join(', ')} onChange={(e) => setEs(es.map((x, j) => (j === i ? { ...x, options: e.target.value.split(',').map((o) => o.trim()) } : x)))} aria-label={`Spanish choices for field ${i + 1}`} />}
                </div>
              ))}
            </div>
            <div className="form-actions">
              <button type="button" className="link" style={{ marginRight: 'auto' }} onClick={() => window.dispatchEvent(new CustomEvent('dm:edit-form-template', { detail: t.id }))}>Change the wording…</button>
              {t.legal_review ? <button onClick={() => act(() => api.put(`/form-templates/${t.id}/consent-settings`, { legal_reviewed: true }), 'Marked as reviewed by your attorney')}><ShieldCheck size={14} /> Our attorney reviewed it</button> : null}
              <button className="primary" onClick={save}>Save</button>
            </div>
            {versions?.length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                <History size={12} /> {versions.map((v) => `v${v.version} (${String(v.created_at).slice(0, 10)}${Number(v.signed_count) ? `, signed ${v.signed_count}×` : ''})`).join(' · ')}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Autopilot({ s, act }) {
  const [v, setV] = useState(s);
  const num = (k, lbl, min, max) => <label>{lbl}<input type="number" min={min} max={max} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></label>;
  return (
    <div className="form-grid">
      <label className="checkbox full"><input type="checkbox" checked={!!v.paperwork_autopilot} onChange={(e) => setV({ ...v, paperwork_autopilot: e.target.checked ? 1 : 0 })} /> Send what each visit needs automatically (health history, policies, screenings, consents for the booked work)</label>
      {num('paperwork_days', 'Days before the visit', 0, 14)}
      {num('paperwork_reminders', 'Reminders until done', 0, 5)}
      {num('paperwork_remind_hours', 'Hours between reminders', 4, 168)}
      {num('history_renew_months', 'Health history update every (months)', 1, 60)}
      <div className="form-actions full"><button className="primary" onClick={() => act(() => api.put('/paperwork/settings', v), 'Saved')}>Save</button></div>
    </div>
  );
}
