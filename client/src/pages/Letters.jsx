import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, openFile, saveBlob } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcuts } from '../shortcuts.js';
import { fmtUtcDateTime } from '../format.js';
import { ErrorBox, PatientPicker, useSubmit } from '../components/ui.jsx';
import { toast } from '../toast.js';
import './compliance.css';

// Letters from templates (A171, docs/documents.md, “Letters and mailing labels”): pick a letter (1–9), see it filled in for this patient,
// Enter prints it (the PDF is filed in their documents), M emails it. A field the chart has nothing for is shown in
// red and blocks printing and sending until it's fixed. ?patients=1,2,3 makes the same letter for a list.
const LAST = 'dm_last_letter_template';
const b64Blob = (b64) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/pdf' });

export default function Letters() {
  const [params] = useSearchParams();
  const { patientId: active } = useActivePatient();
  const { can } = useAuth();
  const list = useMemo(() => (params.get('patients') || '').split(',').map(Number).filter((n) => n > 0), [params]);
  const [pid, setPid] = useState(Number(params.get('patient')) || list[0] || active || null);
  const templates = useLookup('/letter-templates');
  const [tid, setTid] = useState(() => { try { return Number(localStorage.getItem(LAST)) || null; } catch { return null; } });
  const template = templates.find((t) => t.id === tid) || null;
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(null); // this letter's own wording, when changed on screen
  const { data: patient } = useApi(pid ? `/patients/${pid}/card` : null);
  const { data: history, reload: reloadHistory } = useApi(pid && !list.length ? `/patients/${pid}/letters` : null);
  const [preview, setPreview] = useState(null);
  const body = words ?? template?.body;
  // A different letter (or patient) clears the old preview at once, so neither the paper nor Print/Enter ever acts
  // on the previous letter while the new one is being filled in.
  useEffect(() => { setPreview(null); }, [pid, template?.id]);
  useEffect(() => {
    if (!pid || !template) { setPreview(null); return undefined; }
    let live = true;
    const t = setTimeout(() => api.post(`/patients/${pid}/letters/preview`, { template_id: template.id, body, subject: template.subject })
      .then((p) => live && setPreview(p)).catch((e) => live && setPreview({ error: e })), words ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [pid, template, body, words]);
  const choose = (t) => { setTid(t.id); setWords(null); setEditing(false); try { localStorage.setItem(LAST, String(t.id)); } catch { /* storage unavailable */ } };
  const blocked = !preview || preview.error || preview.missing?.length > 0 || preview.blanks?.length > 0;

  const make = useSubmit(async (delivery) => {
    // The print tab is opened on the key press or click itself, so the browser doesn't block it as a pop-up.
    const tab = delivery === 'print' ? window.open('', '_blank') : null;
    try { await makeIt(delivery, tab); } catch (e) { tab?.close(); throw e; }
  });
  const makeIt = async (delivery, tab) => {
    if (list.length > 1) {
      const out = await api.post('/letters/batch', { template_id: template.id, patient_ids: list, ...(words ? { body: words, subject: template.subject } : {}) });
      if (out.pdf) { if (tab) tab.location.href = URL.createObjectURL(b64Blob(out.pdf)); else saveBlob(b64Blob(out.pdf), 'letters.pdf'); } else tab?.close();
      toast(`${out.made} letter${out.made === 1 ? '' : 's'} made and filed on each chart${out.skipped.length ? ` · ${out.skipped.length} left out (nothing to fill a field)` : ''}.`, { tone: out.skipped.length ? 'warn' : 'ok' });
      return;
    }
    const out = await api.post(`/patients/${pid}/letters`, { template_id: template.id, delivery, ...(words ? { body: words, subject: template.subject } : {}) });
    reloadHistory();
    if (delivery === 'email') toast(out.message?.status === 'sent' ? `Emailed to ${patient?.first_name} (a copy is filed in their documents).` : `Filed, but the email didn’t go: ${out.message?.error || out.message?.status}`, { tone: out.message?.status === 'sent' ? 'ok' : 'warn' });
    else {
      toast('Filed in their documents (Letters). Printing…');
      await openFile(`/letters/${out.letter.id}/pdf`, tab);
    }
  };
  const writer = can('patients:write');
  useShortcuts([
    ...templates.slice(0, 9).map((t, i) => ({ combo: String(i + 1), handler: () => choose(t), label: `Letter: ${t.name}`, section: 'Letters', enabled: !editing })),
    { combo: 'enter', handler: () => !blocked && !make.busy && make.submit('print'), label: 'Print the letter (and file it on the chart)', section: 'Letters', enabled: writer && !editing && !!template },
    { combo: 'm', handler: () => !blocked && preview?.can_email && make.submit('email'), label: 'Email the letter', section: 'Letters', enabled: writer && !editing && !!template && list.length <= 1 },
    { combo: 'e', handler: () => template && setEditing(true), label: 'Change the wording for this letter', section: 'Letters', enabled: writer && !editing && !!template },
  ]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Write a letter</h1>
          <div className="muted">{list.length > 1 ? `The same letter for ${list.length} patients — each is filled in for them and filed on their chart.` : 'Filled in from the chart, printed or emailed, and filed in the patient’s documents.'}</div>
        </div>
        {can('patients:read') && <Link to="/settings?tab=letters"><button type="button">Edit templates</button></Link>}
      </div>
      <div className="ltr-layout">
        <div>
          {!list.length && (
            <div className="card" style={{ marginBottom: 12 }}>
              {pid && patient ? (
                <div className="cmp-row"><span className="cmp-chip">For <strong>{patient.first_name} {patient.last_name}</strong><button type="button" className="link" aria-label="Choose someone else" onClick={() => setPid(null)}>×</button></span></div>
              ) : <PatientPicker value={null} onChange={(p) => setPid(p?.id || null)} />}
            </div>
          )}
          <div className="card ltr-list" role="listbox" aria-label="Letters">
            {templates.map((t, i) => (
              <button key={t.id} type="button" role="option" aria-selected={t.id === tid} className={t.id === tid ? 'active' : ''} onClick={() => choose(t)}>
                {i < 9 && <kbd>{i + 1}</kbd>}<span>{t.name}</span>
              </button>
            ))}
            {!templates.length && <div className="muted">No letter templates yet.</div>}
          </div>
        </div>
        <div>
          {!template && <div className="card empty">Choose a letter{templates.length ? ' (press its number)' : ''}.</div>}
          {template && (
            <>
              <ErrorBox error={make.error || preview?.error} />
              {preview?.missing?.length > 0 && (
                <div className="error">Nothing on the chart to fill {preview.missing.map((m) => m.label.toLowerCase()).join(', ')} — {preview.missing.some((m) => m.field === 'next_appointment') ? 'book the visit first, ' : ''}update the chart or change the wording (E).</div>
              )}
              {preview?.blanks?.length > 0 && <div className="error">Fill in {preview.blanks.map((b) => `“${b}”`).join(', ')} before printing (E to change the wording).</div>}
              <div className="ltr-paper" aria-label="Letter preview">
                {preview?.subject && <div className="ltr-head">{preview.subject}</div>}
                {editing
                  ? <textarea autoFocus aria-label="Letter wording (merge fields in braces)" value={body} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }} />
                  : <div style={{ whiteSpace: 'pre-wrap' }}>{highlight(preview?.body ?? '')}</div>}
              </div>
              {writer && (
                <div className="ltr-actions">
                  <button type="button" className="primary" disabled={blocked || make.busy} onClick={() => make.submit('print')} title="Enter">{list.length > 1 ? `Print ${list.length} letters` : 'Print'}</button>
                  {list.length <= 1 && <button type="button" disabled={blocked || make.busy || !preview?.can_email} onClick={() => make.submit('email')} title={preview?.can_email ? 'M' : 'No email address that accepts email'}>Email</button>}
                  {editing ? <button type="button" onClick={() => setEditing(false)}>Done changing</button> : <button type="button" onClick={() => setEditing(true)} title="E">Change the wording</button>}
                  {words && <button type="button" className="link" onClick={() => { setWords(null); setEditing(false); }}>Back to the template</button>}
                  {preview && !preview.has_address && list.length <= 1 && <span className="muted" style={{ fontSize: 12 }}>No complete mailing address on file — the letter prints without one.</span>}
                </div>
              )}
            </>
          )}
          {history?.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>Letters to {patient?.first_name || 'this patient'}</h3>
              <table>
                <tbody>
                  {history.map((l) => (
                    <tr key={l.id}>
                      <td>{fmtUtcDateTime(l.created_at)}</td>
                      <td>{l.template_name || l.subject || 'Letter'}</td>
                      <td>{l.delivery === 'email' ? `Emailed${l.message_status && l.message_status !== 'sent' ? ` (${l.message_status})` : ''}` : 'Printed'} · {l.created_by_name}</td>
                      <td><button type="button" className="small" onClick={() => openFile(`/letters/${l.id}/pdf`)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Unfilled fields stay as {field} in the preview: shown in red.
function highlight(text) {
  return String(text).split(/(\{\w+\})/g).map((part, i) => (/^\{\w+\}$/.test(part) ? <span key={i} className="ltr-missing">{part}</span> : part));
}
