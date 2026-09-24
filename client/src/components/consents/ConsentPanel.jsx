import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNavigate } from 'react-router-dom';
import { Tablet, MessageSquareText, QrCode, MonitorSmartphone, X, FileCheck2, FileClock, FileX2, Send, Presentation, BookOpenCheck, Copy, FileText, CircleDot } from 'lucide-react';
import { api, download } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useLiveEvents } from '../../live.js';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { fmtDate, fmtTime, fmtDateTime } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { EducationArticle } from '../../pages/public/Kiosk.jsx';
import './consents.css';

// Forms & consents for one patient, in a side panel (no stacked dialogs): what their next visit still needs
// (health history, policies, screenings, the consents for the booked work — picked automatically), and one action
// to get it done: hand the office iPad over (I), text/email a link (T), show a QR code (Q), or sign on this screen
// (H). Live "Jane is on form 2 of 5". Consents can be recorded as declined at the chair with the reason, and each
// signed consent opens to its record. Education: show a page on this screen or the iPad, or send it home —
// each recorded (E2), with the sentence for the clinical note.
// Open it from anywhere: openPaperwork(patientId, { appointmentId }) (the command bar and Alt+F do).
export const openPaperwork = (patientId, opts = {}) => window.dispatchEvent(new CustomEvent('dm:paperwork', { detail: { patientId, ...opts } }));

const STATUS = {
  done: ['Done', 'ok', FileCheck2], sent: ['Sent', 'info', FileClock], due: ['Not done', 'warn', FileClock], declined: ['Declined', 'danger', FileX2],
};

export default function ConsentPanel({ patientId, appointmentId = null, onClose, autoAction = null }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const [kioskId, setKioskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(null);
  const [live, setLive] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [record, setRecord] = useState(null);
  const [edu, setEdu] = useState(null);
  const [proof, setProof] = useState(null);
  const [presenting, setPresenting] = useState(null);
  const first = useRef(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        api.get(`/patients/${patientId}/paperwork${appointmentId ? `?appointment_id=${appointmentId}` : ''}`),
        patient ? Promise.resolve(patient) : api.get(`/patients/${patientId}`),
      ]);
      setData(d);
      setPatient(p);
      setPicked((prev) => prev ?? new Set(d.items.filter((i) => i.status === 'due' || i.status === 'sent').map((i) => i.key)));
      if (d.sessions?.[0]) setLive((l) => l || { page: d.sessions[0].page, total: d.sessions[0].total, kiosk: d.sessions[0].kiosk_name, status: d.sessions[0].status });
      setError(null);
    } catch (e) { setError(e); }
  }, [patientId, appointmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadEdu = useCallback(async () => {
    try {
      const [e, pr] = await Promise.all([api.get(`/patients/${patientId}/education`), api.get(`/patients/${patientId}/education/proof${appointmentId ? `?appointment_id=${appointmentId}` : ''}`)]);
      setEdu(e);
      setProof(pr);
    } catch { /* the forms part still works */ }
  }, [patientId, appointmentId]);
  useEffect(() => { load(); loadEdu(); }, [load, loadEdu]);
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, [data?.appointment?.id]);

  // Live: kiosk progress, signatures landing, sessions ending.
  useLiveEvents((ev) => {
    if (Number(ev.patient_id) !== Number(patientId)) return;
    if (ev.type === 'paperwork_progress') setLive((l) => ({ ...l, page: ev.page, total: ev.total, status: 'active' }));
    if (ev.type === 'kiosk') setLive((l) => (['completed', 'expired', 'cancelled'].includes(ev.status) ? { ...l, status: ev.status } : { ...l, status: ev.status, total: ev.total ?? l?.total, page: ev.page ?? l?.page ?? 0 }));
    if (ev.type === 'paperwork' || ev.type === 'kiosk') load();
    if (ev.type === 'education') loadEdu();
  });

  const items = data?.items || [];
  const open = items.filter((i) => i.status === 'due' || i.status === 'sent');
  const chosen = items.filter((i) => picked?.has(i.key));
  const kiosks = data?.kiosks || [];
  const reachable = data?.reachable;
  const body = useMemo(() => {
    const out = { appointment_id: data?.appointment?.id ?? undefined, template_ids: [], consent_ids: [], history: false };
    for (const i of chosen) {
      if (i.kind === 'medical_history') out.history = true;
      else if (i.kind === 'consent' && i.consent_id) out.consent_ids.push(i.consent_id);
      else if (i.template_id) out.template_ids.push(i.template_id);
    }
    return out;
  }, [chosen, data?.appointment?.id]);

  const send = async (channel) => {
    if (busy || !can('patients:write')) return;
    if (!chosen.length) { toast('Choose at least one form', { tone: 'error' }); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/patients/${patientId}/paperwork/send`, { ...body, channel, ...(channel === 'kiosk' && kioskId ? { kiosk_id: Number(kioskId) } : {}) });
      if (channel === 'qr') setQr({ url: r.url, img: await QRCode.toDataURL(r.url, { margin: 1, width: 360 }) });
      else if (channel === 'here') { navigate(`${new URL(r.url, window.location.origin).pathname}#here=${encodeURIComponent(r.handoff)}`); return; }
      else if (channel === 'kiosk') { setLive({ page: 0, total: r.forms, kiosk: r.kiosk?.name, status: 'waiting' }); toast(`${r.forms} form${r.forms === 1 ? '' : 's'} on ${r.kiosk?.name || 'the iPad'} for ${patient?.first_name} — hand it over`); }
      else toast(r.message?.status === 'sent' ? `Sent ${r.message.channel === 'sms' ? 'by text' : 'by email'} to ${patient?.first_name}` : `Couldn’t send: ${r.message?.error || 'try another way'}`, { tone: r.message?.status === 'sent' ? 'ok' : 'error' });
      setPicked(null);
      load();
    } catch (e) {
      if (e.details?.choose_kiosk) setError(new Error('Choose which iPad to hand over, then press I again.'));
      else if (e.details?.nothing_due) toast('Everything for this visit is already done');
      else setError(e);
    } finally { setBusy(false); }
  };
  useEffect(() => { if (autoAction && data && picked) { send(autoAction); } }, [autoAction, !!data, !!picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const decline = async (consentId, reason) => {
    try {
      await api.post(`/consents/${consentId}/decline`, { reason });
      toast('Recorded: the patient declined (filed on the chart)');
      setDeclining(null);
      load();
    } catch (e) { setError(e); }
  };
  const openRecord = async (consentId) => {
    if (record?.id === consentId) { setRecord(null); return; }
    try { setRecord(await api.get(`/consents/${consentId}`)); } catch (e) { setError(e); }
  };
  const showEdu = async (slug, how) => {
    try {
      const r = await api.post(`/patients/${patientId}/education/show`, { slug, how, appointment_id: data?.appointment?.id ?? undefined, ...(how === 'shown_ipad' && kioskId ? { kiosk_id: Number(kioskId) } : {}) });
      if (how === 'shown_chair') setPresenting(r.article);
      else toast(`Showing “${r.article.title}” on ${r.session?.kiosk_name || 'the iPad'}`);
      loadEdu();
    } catch (e) { setError(e.details?.choose_kiosk ? new Error('Choose which iPad first.') : e); }
  };
  const sendEdu = async (slug) => {
    try {
      const r = await api.post(`/patients/${patientId}/education/take-home`, { slugs: [slug], appointment_id: data?.appointment?.id ?? undefined, postop: true });
      toast(r.status === 'sent' ? `Sent ${r.channel === 'sms' ? 'by text' : 'by email'}` : `Couldn’t send: ${r.error}`, { tone: r.status === 'sent' ? 'ok' : 'error' });
      loadEdu();
    } catch (e) { setError(e); }
  };
  const copyNote = async () => {
    try { await navigator.clipboard.writeText(proof.note_text); toast('Copied — paste it into the note'); } catch { toast('Select the text and copy it', { tone: 'error' }); }
  };

  const suggested = edu ? edu.articles.filter((a) => edu.suggested.includes(a.slug)) : [];
  useShortcuts([
    { combo: 'i', handler: () => send('kiosk'), label: 'Hand the iPad over (forms & consents)', section: 'Forms & consents', enabled: !!data && can('patients:write') },
    { combo: 't', handler: () => send('auto'), label: 'Text or email the forms', section: 'Forms & consents', enabled: !!data && reachable && can('patients:write') },
    { combo: 'q', handler: () => send('qr'), label: 'Show a QR code', section: 'Forms & consents', enabled: !!data && can('patients:write') },
    { combo: 'h', handler: () => send('here'), label: 'Sign on this screen', section: 'Forms & consents', enabled: !!data && can('patients:write') },
    { combo: 'escape', handler: () => (presenting ? setPresenting(null) : onClose()), label: 'Close forms & consents', section: 'Forms & consents' },
  ]);

  if (presenting) return <ChairPresenter article={presenting} onClose={() => setPresenting(null)} />;
  const s = data?.summary;
  return (
    <aside className="cp-panel" role="complementary" aria-label={`Forms and consents${patient ? ` for ${patient.first_name} ${patient.last_name}` : ''}`}>
      <header className="cp-head">
        <div>
          <h2>Forms &amp; consents</h2>
          <div className="muted">{patient ? `${patient.first_name} ${patient.last_name}` : '…'}{data?.appointment ? ` · visit ${fmtDate(data.appointment.start_time.slice(0, 10))} ${fmtTime(data.appointment.start_time)}` : data ? ' · no upcoming visit' : ''}</div>
        </div>
        <button className="small ghost" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <ErrorBox error={error} />
      {!data ? <div className="muted">Loading…</div> : (
        <>
          {s && s.total > 0 && <div className={`cp-summary ${s.state}`}>{s.state === 'done' ? 'Everything is done for this visit' : `${s.done} of ${s.total} done`}{s.consents.total ? ` · consents ${s.consents.signed}/${s.consents.total} signed${s.consents.declined ? `, ${s.consents.declined} declined` : ''}` : ''}</div>}
          {live && ['waiting', 'active'].includes(live.status) && (
            <div className="cp-live" aria-live="polite"><CircleDot size={14} className="pulse" /> {live.status === 'waiting' ? `Waiting for ${patient?.first_name} on ${live.kiosk || 'the iPad'}` : `${patient?.first_name} is on form ${Math.max(1, live.page || 1)} of ${live.total || '?'}${live.kiosk ? ` on ${live.kiosk}` : ''}`}</div>
          )}
          {live && live.status === 'completed' && <div className="cp-live done"><FileCheck2 size={14} /> {patient?.first_name} finished on the iPad</div>}
          <ul className="cp-items">
            {items.map((i) => {
              const [label, tone, Icon] = STATUS[i.status] || STATUS.due;
              const choosable = i.status === 'due' || i.status === 'sent';
              return (
                <li key={i.key} className={`cp-item ${tone}`}>
                  <label className="cp-pick">
                    <input type="checkbox" disabled={!choosable} checked={!!picked?.has(i.key)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); return n; })} />
                    <Icon size={16} />
                    <span className="cp-name">{i.name}</span>
                  </label>
                  <span className={`cp-chip ${tone}`}>{label}</span>
                  <div className="cp-sub muted">{i.kind === 'consent' ? (i.covers ? 'Signed with the plan' : 'For the booked work') : i.reason}</div>
                  {i.kind === 'consent' && i.consent_id && (
                    <div className="cp-links">
                      {(i.status === 'done' || i.status === 'declined') && <button className="link" onClick={() => openRecord(i.consent_id)}>Record</button>}
                      {choosable && can('clinical:write') && <button className="link" onClick={() => setDeclining(declining?.id === i.consent_id ? null : { id: i.consent_id, reason: '' })}>Patient declined…</button>}
                    </div>
                  )}
                  {declining && declining.id === i.consent_id && (
                    <form className="cp-decline" onSubmit={(e) => { e.preventDefault(); if (declining.reason.trim()) decline(i.consent_id, declining.reason.trim()); }}>
                      <input autoFocus placeholder="What the patient said (Enter to record)" value={declining.reason} onChange={(e) => setDeclining({ ...declining, reason: e.target.value })} aria-label="Reason the patient declined" />
                    </form>
                  )}
                  {record && i.consent_id && record.id === i.consent_id && <ConsentRecord c={record} />}
                </li>
              );
            })}
            {!items.length && <li className="muted">Nothing is due{data.appointment ? ' for this visit' : ''}. Choose forms in Settings → Forms, or send any form from the patient’s chart.</li>}
          </ul>
          {can('patients:write') && open.length > 0 && (
            <div className="cp-actions">
              {kiosks.length > 1 && (
                <select value={kioskId} onChange={(e) => setKioskId(e.target.value)} aria-label="Which iPad">
                  <option value="">iPad: {kiosks.find((k) => k.operatory_id && k.operatory_id === data.appointment?.operatory_id)?.name || 'choose…'}</option>
                  {kiosks.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              )}
              <button ref={first} className="primary" disabled={busy || !kiosks.length} title={kiosks.length ? '' : 'Set up an iPad in Settings → Forms & consents'} onClick={() => send('kiosk')}><Tablet size={16} /> Hand iPad <kbd>I</kbd></button>
              <button disabled={busy || !reachable} title={reachable ? '' : 'No phone or email that accepts messages'} onClick={() => send('auto')}><MessageSquareText size={16} /> Text / email <kbd>T</kbd></button>
              <button disabled={busy} onClick={() => send('qr')}><QrCode size={16} /> QR code <kbd>Q</kbd></button>
              <button disabled={busy} onClick={() => send('here')}><MonitorSmartphone size={16} /> This screen <kbd>H</kbd></button>
            </div>
          )}
          {qr && (
            <div className="cp-qr">
              <img src={qr.img} alt="QR code for the patient's forms" />
              <div className="muted">The patient scans this with their phone camera and confirms their birth date. Works for 2 hours.</div>
            </div>
          )}
          <section className="cp-edu">
            <h3><BookOpenCheck size={16} /> Education</h3>
            {suggested.length === 0 && <div className="muted">No pages match the planned work. All pages are in Settings → Patient education.</div>}
            {suggested.map((a) => (
              <div key={a.slug} className="cp-edu-row">
                <span>{a.title}</span>
                <span className="cp-edu-actions">
                  <button className="small" onClick={() => showEdu(a.slug, 'shown_chair')} title="Show on this screen"><Presentation size={14} /> Show</button>
                  <button className="small" disabled={!kiosks.length} onClick={() => showEdu(a.slug, 'shown_ipad')}><Tablet size={14} /> iPad</button>
                  <button className="small" disabled={!reachable} onClick={() => sendEdu(a.slug)}><Send size={14} /> Send home</button>
                </span>
              </div>
            ))}
            {proof?.lines?.length > 0 && (
              <div className="cp-proof">
                {proof.lines.map((l) => <div key={l}>{l}</div>)}
                <button className="small" onClick={copyNote}><Copy size={14} /> Copy for the note</button>
              </div>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

function ConsentRecord({ c }) {
  const via = { link: 'link sent to the patient', kiosk: 'office iPad', handoff: 'office device', chair: 'recorded at the chair' }[c.signed_via] || c.signed_via;
  return (
    <div className="cp-record">
      <div><b>{c.status === 'declined' ? 'Declined' : 'Signed'}</b> {fmtDateTime(String(c.declined_at || c.signed_at || '').replace(' ', 'T').slice(0, 16).replace('T', ' '))} UTC · version {c.template_version}{c.lang === 'es' ? ' (Spanish)' : ''}</div>
      {c.signer_name && <div>By {c.signer_name}{c.signer_relationship && c.signer_relationship !== 'self' ? ` (${c.signer_relationship})` : ''} · {via}{c.device ? ` · ${String(c.device).slice(0, 60)}` : ''}</div>}
      {c.declined_reason && <div>Reason: {c.declined_reason}{c.declined_by_name ? ` — recorded by ${c.declined_by_name}` : ''}</div>}
      {c.witness_name && <div>Witness: {c.witness_name}</div>}
      {c.education?.lines?.map((l) => <div key={l} className="muted">{l}</div>)}
      {c.outdated && <div className="warn-text">The form has changed since — a new version needs a new signature.</div>}
      {c.document_id && <button className="small" onClick={() => download(`/documents/${c.document_id}/file`, `${c.template_name}.pdf`)}><FileText size={14} /> PDF</button>}
    </div>
  );
}

// The chair screen turned to the patient: the page big, nothing else. Esc gives the screen back.
export function ChairPresenter({ article, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="cp-present" role="dialog" aria-label={article.title}>
      <button className="cp-present-close" onClick={onClose} aria-label="Close (Esc)"><X size={22} /> <kbd>Esc</kbd></button>
      <div className="pw"><EducationArticle article={article} /></div>
    </div>
  );
}
