import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Mic, ScanQrCode, ThumbsUp, TriangleAlert, Send, CalendarClock, CircleCheck, X, Package, FlaskConical } from 'lucide-react';
import { api, postAudio } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useLiveEvents } from '../live.js';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import { fmtDate, fmtTime } from '../format.js';
import useDictation from '../components/useDictation.js';
import '../components/readiness/readiness.css';

// Lab case / parts check-in (LB2–LB4): pick the case (from "due this week", the slip's QR code, or by saying it),
// take a photo, and one tap "Looks good" — or note the problem, which goes to the doctor with a note for the lab.
// Built for a phone at the front desk or in the lab room; works the same on a desktop with the keyboard.
const CHECKS = ['right_patient', 'matches_rx', 'shade', 'margins', 'no_cracks', 'all_parts'];
const LABELS = {
  lab_case: { right_patient: 'Right patient and tooth', matches_rx: 'Matches the Rx', shade: 'Shade is right', margins: 'Margins and contacts look right', no_cracks: 'No cracks or chips', all_parts: 'All parts and models there' },
  part: { right_patient: 'For the right patient', matches_rx: 'Right brand, platform and size', shade: 'Sterile pack sealed', margins: 'In date (not expired)', no_cracks: 'No damage', all_parts: 'Everything ordered is here' },
};
const KINDS = [['remake', 'Remake'], ['adjust', 'Adjust'], ['missing_parts', 'Missing parts'], ['other', 'Other']];
const STATE = {
  late: ['Late', 'warn'], due: ['Due soon', 'info'], sent: ['At the lab', ''], in_production: ['In production', ''], shipped: ['Shipped', 'info'],
  arrived: ['Arrived — check it', 'info'], problem: ['Problem', 'danger'], ordered: ['Ordered', ''], to_order: ['To order', 'warn'],
};
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pname = (x) => `${x.preferred_name || x.first_name} ${x.last_name}`;
// " #3" after the description, unless the description already says it ("Zirconia crown #3").
const toothTag = (desc = '', tooth, sep = ' ') => {
  if (!tooth) return '';
  const at = (desc || '').indexOf(`#${tooth}`);
  const said = at >= 0 && !/\d/.test((desc || '')[at + String(tooth).length + 1] || '');
  return said ? '' : `${sep}#${tooth}`;
};
const stateOf = (x, today) => {
  if (x.type === 'part') return x.status;
  if (x.check_status === 'problem') return 'problem';
  if (x.status === 'received') return 'arrived';
  if (x.due_date && x.due_date < today) return 'late';
  if (x.lab_status === 'shipped') return 'shipped';
  if (x.lab_status === 'in_production') return 'in_production';
  return x.due_date && x.due_date <= today ? 'due' : 'sent';
};

export default function LabCheckin() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { patientId: activeId, setActive } = useActivePatient();
  const { data, reload, error } = useApi('/lab-checkin/due?days=7');
  const { data: dict } = useApi(can('clinical:write') ? '/dictation' : null);
  useLiveEvents((e) => ['readiness', 'lab_checkin'].includes(e.type) && reload());
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState(null); // the case or part being checked (kept after it drops off the list)
  const [extra, setExtra] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [checks, setChecks] = useState({});
  const [problem, setProblem] = useState(null); // { note, kind }
  const [heard, setHeard] = useState(null);
  const [spoken, setSpoken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [scan, setScan] = useState(false);
  const [code, setCode] = useState('');
  const key = useRef(newKey());
  const fileInput = useRef(null);
  const search = useRef(null);

  const today = data?.today || '';
  const items = useMemo(() => {
    const all = [...(data?.cases || []), ...(data?.parts || [])];
    if (extra && !all.some((x) => x.type === extra.type && x.id === extra.id)) all.unshift(extra);
    const q = filter.trim().toLowerCase();
    return q ? all.filter((x) => `${pname(x)} ${x.description || x.item_name || ''} ${x.tooth || ''} ${x.lab_name || ''}`.toLowerCase().includes(q)) : all;
  }, [data, extra, filter]);
  const sel = picked && (items.find((x) => x.type === picked.type && x.id === picked.id) || picked);
  const labels = LABELS[sel?.type || 'lab_case'];

  const select = (x, prefill = null) => {
    setPicked(x || null);
    setPhotos([]);
    photoIds.current = [];
    setResult(null);
    setChecks(prefill?.checklist || {});
    setProblem(prefill?.verdict === 'problem' ? { note: prefill.problem_note || '', kind: prefill.problem_kind || 'remake' } : null);
    key.current = newKey();
    if (x) setActive({ id: x.patient_id, first_name: x.first_name, last_name: x.last_name, preferred_name: x.preferred_name });
  };
  // A case named in the address (from the schedule card or a scan) or the patient already being worked on.
  useEffect(() => {
    if (!data || picked) return;
    const want = params.get('case');
    const x = want ? items.find((i) => i.type === 'lab_case' && String(i.id) === want) : activeId ? items.find((i) => i.patient_id === activeId) : null;
    if (x) select(x);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Voice: hold to talk; what was said picks the case and fills the checklist (a person still confirms) ----
  const dictation = useDictation((text) => setSpoken((s) => `${s} ${text}`.trim()), { mode: dict?.mode || 'browser', pauseMs: 900 });
  useEffect(() => {
    if (dictation.listening || !spoken) return undefined;
    const t = setTimeout(async () => {
      try {
        const h = await api.post('/lab-checkin/parse', { text: spoken });
        setHeard(h);
        const m = h.match && !h.ambiguous ? [...(data?.cases || []), ...(data?.parts || [])].find((x) => x.type === h.match.type && x.id === h.match.id) : null;
        if (m) select(m, h);
      } catch (e) {
        toast(e.message, { tone: 'error' });
      }
      setSpoken('');
    }, 350);
    return () => clearTimeout(t);
  }, [dictation.listening, spoken]); // eslint-disable-line react-hooks/exhaustive-deps
  const talk = (on) => (on ? (setHeard(null), dictation.start()) : dictation.stop());
  const holdBy = useRef(null); // 'pointer' or 'key': what is holding "Hold to talk" down

  // ---- The slip's QR code (camera where the browser can read codes; a USB scanner types into the box) ----
  const lookup = async (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    try {
      const c = await api.get(`/lab-checkin/lookup?code=${encodeURIComponent(v)}`);
      setExtra(c);
      setScan(false);
      setCode('');
      select(c);
      setParams({ case: String(c.id) }, { replace: true });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };

  // ---- Photos go up as they're taken (stored encrypted, filed on the visit) ----
  const uploads = useRef(Promise.resolve());
  const photoIds = useRef([]);
  const addPhotos = (files) => {
    if (!sel) return;
    uploads.current = uploads.current.then(() => savePhotos(files));
  };
  const savePhotos = async (files) => {
    for (const f of files) {
      const q = new URLSearchParams({ [sel.type === 'part' ? 'requirement_id' : 'lab_case_id']: sel.id, filename: f.name || 'lab-check.jpg' });
      const url = URL.createObjectURL(f);
      setPhotos((p) => [...p, { url, id: null }]);
      try {
        const out = await postAudio(`/lab-checkin/photos?${q}`, f);
        photoIds.current = [...photoIds.current, out.id];
        setPhotos((p) => p.map((x) => (x.url === url ? { ...x, id: out.id } : x)));
      } catch (e) {
        setPhotos((p) => p.filter((x) => x.url !== url));
        toast(`That photo didn’t save: ${e.message}`, { tone: 'error' });
      }
    }
  };

  const submit = async (verdict) => {
    if (!sel || busy) return;
    const checklist = Object.fromEntries(CHECKS.map((k) => [k, verdict === 'ok' ? true : checks[k] !== false]));
    if (verdict === 'problem' && !problem?.note?.trim()) { toast('Say what’s wrong first', { tone: 'error' }); return; }
    setBusy(true);
    try {
      await uploads.current; // a photo taken a moment ago is saved first
      const body = {
        [sel.type === 'part' ? 'requirement_id' : 'lab_case_id']: sel.id, verdict, checklist, photo_ids: photoIds.current,
        via: heard?.match ? 'voice' : extra?.id === sel.id ? 'scan' : 'screen', transcript: heard?.text || undefined, key: key.current,
        ...(verdict === 'problem' ? { problem_note: problem.note.trim(), problem_kind: problem.kind } : {}),
      };
      const out = await api.post('/lab-checkin', body);
      setResult({ ...out, sel });
      setMessage(out.next?.lab_message || '');
      setHeard(null);
      if (verdict === 'ok') toast(`Checked in — ${pname(sel)}, ${sel.description || sel.item_name}`);
      else toast(`Problem noted${out.notified?.name ? ` — ${out.notified.name} has been told` : ''}`, { tone: 'error' });
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const sendToLab = async () => {
    try {
      const out = await api.post(`/lab-checkin/${result.id}/lab-message`, { kind: result.problem_kind === 'adjust' ? 'adjust' : 'remake', message });
      toast(out.emailed ? 'Sent to the lab' : 'Saved — the lab has no email on file, so call or send them the link', { tone: out.emailed ? 'ok' : 'error' });
      setResult((r) => ({ ...r, sent: out }));
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };

  useShortcuts([
    { combo: 'f', handler: () => search.current?.focus(), label: 'Find a case', section: 'Lab check-in' },
    { combo: 'c', handler: () => fileInput.current?.click(), label: 'Take a photo', section: 'Lab check-in', enabled: !!sel && !result },
    { combo: 'g', handler: () => submit('ok'), label: 'Looks good — check it in', section: 'Lab check-in', enabled: !!sel && !result && !problem },
    { combo: 'p', handler: () => setProblem((x) => x || { note: '', kind: 'remake' }), label: 'Note a problem', section: 'Lab check-in', enabled: !!sel && !result },
    { combo: 'v', handler: () => talk(!dictation.listening), label: 'Talk (press again to stop)', section: 'Lab check-in', enabled: dictation.supported && can('clinical:write') },
    { combo: 's', handler: () => setScan((x) => !x), label: 'Scan the slip', section: 'Lab check-in' },
    { combo: 'j', handler: () => { const i = items.findIndex((x) => x.type === sel?.type && x.id === sel?.id); const n = items[Math.min(items.length - 1, i + 1)]; if (n) select(n); }, label: 'Next case', section: 'Lab check-in', enabled: items.length > 0 },
    { combo: 'k', handler: () => { const i = items.findIndex((x) => x.type === sel?.type && x.id === sel?.id); const n = items[Math.max(0, i - 1)]; if (n) select(n); }, label: 'Previous case', section: 'Lab check-in', enabled: items.length > 0 },
  ]);

  const writer = can('clinical:write');
  const cases = items.filter((x) => x.type === 'lab_case');
  const parts = items.filter((x) => x.type === 'part');
  const row = (x) => {
    const st = stateOf(x, today);
    const [label, tone] = STATE[st] || [st, ''];
    return (
      <li key={`${x.type}-${x.id}`}>
        <button type="button" className={`lbc-item${sel && sel.type === x.type && sel.id === x.id ? ' active' : ''}`} onClick={() => select(x)} data-testid={`lbc-${x.type}-${x.id}`}>
          <div className="top"><strong>{pname(x)}</strong><span className={`rdy-chip ${tone}`}>{label}</span></div>
          <div>{x.type === 'part' ? <Package size={13} aria-hidden="true" /> : <FlaskConical size={13} aria-hidden="true" />} {x.description || x.item_name}{toothTag(x.description || x.item_name, x.tooth)}{x.qty > 1 ? ` × ${x.qty}` : ''}</div>
          <div className="sub">
            {x.lab_name ? `${x.lab_name} · ` : ''}{x.due_date ? `due ${fmtDate(x.due_date)}` : ''}{x.appointment_time ? `${x.due_date ? ' · ' : ''}visit ${fmtDate(x.appointment_time.slice(0, 10))} ${fmtTime(x.appointment_time)}` : ' · no visit linked'}
          </div>
        </button>
      </li>
    );
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Check in lab work</h1>
          <div className="muted">Pick the case, snap a photo, tap “Looks good”. Or hold the mic and say it.</div>
        </div>
      </div>
      <div className="lbc">
        <section aria-label="Cases to check in">
          <div className="lbc-tools">
            <input ref={search} type="search" placeholder="Find a patient, case or lab" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a case"
              onKeyDown={(e) => {
                // Enter picks the first match; Escape goes back to the list's keys (j/k, g, p, c).
                if (e.key === 'Enter' && items[0]) { e.preventDefault(); select(items[0]); e.currentTarget.blur(); }
                if (e.key === 'Escape') e.currentTarget.blur();
              }} />
            <button type="button" onClick={() => setScan((x) => !x)} aria-pressed={scan}><ScanQrCode size={16} /> Scan slip</button>
            {writer && dictation.supported && (
              <button type="button" className={`lbc-talk${dictation.listening ? ' on' : ''}`} aria-pressed={dictation.listening}
                // The label grows to "Listening… let go when done", which can move the button out from under a
                // mouse that is holding it; capturing the pointer keeps "let go" meaning let go (found by
                // e2e/chaos/speech.test.mjs), and a hold from the keyboard isn't ended by where the mouse is.
                onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); holdBy.current = 'pointer'; talk(true); }}
                onPointerUp={() => { holdBy.current = null; talk(false); }} onPointerCancel={() => { holdBy.current = null; talk(false); }}
                onPointerLeave={() => holdBy.current === 'pointer' && dictation.listening && talk(false)}
                onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdBy.current = 'key'; talk(true); } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { holdBy.current = null; talk(false); } }}
                title="Hold and say: “Lab case is in for Maria Lopez, crown number 30, shade A2, looks good”">
                <Mic size={16} /> {dictation.listening ? 'Listening… let go when done' : 'Hold to talk'}
              </button>
            )}
          </div>
          {scan && <Scanner onCode={lookup} code={code} setCode={setCode} onClose={() => setScan(false)} />}
          {(dictation.interim || spoken) && <div className="lbc-heard" aria-live="polite">{dictation.interim || spoken}</div>}
          {dictation.error && <div className="error">{dictation.error}</div>}
          {heard && (
            <div className="lbc-heard" aria-live="polite">
              Heard <q>{heard.text}</q>
              {heard.match && !heard.ambiguous && <div>→ {heard.match.patient}, {heard.match.description}{toothTag(heard.match.description, heard.match.tooth)} ({heard.match.why.join(', ')}). Check the photo and confirm below.</div>}
              {heard.question && <div><strong>{heard.question}</strong></div>}
              {heard.ambiguous && heard.candidates.length > 0 && (
                <div className="lbc-cands">{heard.candidates.map((c) => {
                  const x = items.find((i) => i.type === c.type && i.id === c.id);
                  return x ? <button key={`${c.type}-${c.id}`} type="button" className="small" onClick={() => select(x, heard)}>{c.patient}: {c.description}{toothTag(c.description, c.tooth)}</button> : null;
                })}</div>
              )}
              {heard.warnings?.map((w) => <div key={w} className="warn">{w}</div>)}
            </div>
          )}
          {error && <div className="error">{error.message}</div>}
          {!data ? <div className="empty">Loading…</div> : !items.length ? <div className="empty">{filter ? 'Nothing matches.' : 'Nothing due this week. Scan a slip to check in any case.'}</div> : (
            <>
              {cases.length > 0 && <><div className="lbc-group">Lab cases due this week</div><ul className="lbc-list">{cases.map(row)}</ul></>}
              {parts.length > 0 && <><div className="lbc-group">Parts for upcoming visits</div><ul className="lbc-list">{parts.map(row)}</ul></>}
            </>
          )}
        </section>

        <section className="card lbc-panel" aria-label="Check">
          {!sel ? <div className="empty">Pick a case from the list, scan its slip, or hold the mic and say which one.</div> : (
            <>
              <h2>{pname(sel)}</h2>
              <div>{sel.description || sel.item_name}{toothTag(sel.description || sel.item_name, sel.tooth, ' · ')}{sel.shade ? ` · shade ${sel.shade}` : ''}{sel.lab_name ? ` · ${sel.lab_name}` : ''}</div>
              {sel.rx && <div className="lbc-rx">{['material', 'shade', 'margin', 'contacts', 'occlusion', 'teeth'].filter((k) => sel.rx[k]).map((k) => <span key={k}><span className="muted">{k.replace('_', ' ')}:</span> {sel.rx[k]}</span>)}</div>}
              {sel.details && <div className="lbc-rx">{Object.entries(sel.details).filter(([k]) => k !== 'part').map(([k, v]) => <span key={k}><span className="muted">{k}:</span> {String(v)}</span>)}</div>}
              <div className="muted" style={{ fontSize: 13 }}>{sel.appointment_time ? `For the visit ${fmtDate(sel.appointment_time.slice(0, 10))} at ${fmtTime(sel.appointment_time)}` : 'No visit linked yet — link it from the schedule'}</div>

              {!result && writer && (
                <>
                  <div className="lbc-photos">
                    {photos.map((p) => <img key={p.url} src={p.url} alt="Photo of the case" style={{ opacity: p.id ? 1 : 0.5 }} />)}
                    <label className="lbc-camera">
                      <Camera size={18} /> {photos.length ? 'Another photo' : 'Photo of the case'}
                      <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple hidden data-testid="lbc-photo"
                        onChange={(e) => { addPhotos([...(e.target.files || [])]); e.target.value = ''; }} />
                    </label>
                  </div>
                  <div className="lbc-checks" role="group" aria-label="Checklist">
                    {CHECKS.map((k) => (
                      <label key={k} className={`lbc-check${checks[k] === true ? ' yes' : checks[k] === false ? ' no' : ''}`}>
                        <input type="checkbox" checked={checks[k] !== false} onChange={(e) => {
                          setChecks((c) => ({ ...c, [k]: e.target.checked }));
                          if (!e.target.checked) setProblem((x) => x || { note: '', kind: 'remake' });
                        }} />
                        {labels[k]}
                      </label>
                    ))}
                  </div>
                  <div className="lbc-actions">
                    <button type="button" className="primary good" disabled={busy || !!problem || CHECKS.some((k) => checks[k] === false)} onClick={() => submit('ok')}>
                      <ThumbsUp size={18} /> Looks good
                    </button>
                    {!problem && <button type="button" onClick={() => setProblem({ note: '', kind: 'remake' })}><TriangleAlert size={16} /> Something’s wrong</button>}
                  </div>
                  {problem && (
                    <div className="lbc-problem">
                      <label>What’s wrong?
                        <textarea autoFocus value={problem.note} onChange={(e) => setProblem({ ...problem, note: e.target.value })} placeholder="e.g. Margin is open on the distal" />
                      </label>
                      <div className="seg" role="group" aria-label="What it needs">
                        {KINDS.map(([k, l]) => <button key={k} type="button" className={problem.kind === k ? 'active' : ''} onClick={() => setProblem({ ...problem, kind: k })}>{l}</button>)}
                      </div>
                      <div className="lbc-actions">
                        <button type="button" className="danger" disabled={busy} onClick={() => submit('problem')}><TriangleAlert size={16} /> Record the problem</button>
                        <button type="button" onClick={() => { setProblem(null); setChecks({}); }}><X size={16} /> Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {result?.verdict === 'ok' && <div className="lbc-done" role="status"><CircleCheck size={18} /> Checked in{result.appointment_id ? ' and ready for the visit' : ''}. The schedule card is green.</div>}
              {result?.verdict === 'problem' && (
                <div className="lbc-next" role="status">
                  <strong>Problem recorded{result.notified?.name ? ` — ${result.notified.name} has a to-do` : ''}.</strong>
                  {result.next?.lab_message && !result.sent && (
                    <>
                      <label>Note to the lab{result.next.lab_email ? ` (${result.next.lab_email})` : ''}
                        <textarea value={message} onChange={(e) => setMessage(e.target.value)} />
                      </label>
                      <div className="lbc-actions"><button type="button" className="primary" onClick={sendToLab}><Send size={16} /> Send to the lab</button></div>
                    </>
                  )}
                  {result.sent && <div>Sent to the lab{result.sent.emailed ? '' : ' — no lab email on file; call them or share the case link'}.</div>}
                  {result.next?.move_visit && (
                    <div><button type="button" onClick={() => nav(`/schedule?date=${result.next.move_visit.date}`)}><CalendarClock size={16} /> Move the visit ({fmtDate(result.next.move_visit.date)})</button></div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

// Reads the slip's QR code with the camera where the browser can (Chrome, Edge, Android); otherwise the code can be
// typed or scanned with a USB scanner into the box (it types the code and Enter).
function Scanner({ onCode, code, setCode, onClose }) {
  const video = useRef(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return undefined;
    let stream = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) return;
        video.current.srcObject = stream;
        await video.current.play();
        setLive(true);
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { onCode(found[0].rawValue); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { /* no camera: the box still works */ }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card lbc-scan" style={{ marginBottom: 10 }}>
      <video ref={video} muted playsInline hidden={!live} aria-label="Camera" />
      <form className="lbc-tools" style={{ marginTop: 8, marginBottom: 0 }} onSubmit={(e) => { e.preventDefault(); onCode(code); }}>
        <input type="text" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={live ? 'Point at the QR code on the slip — or type the case number' : 'Scan or type the code on the slip (DM-LAB-…)'} aria-label="Slip code" />
        <button type="submit">Find</button>
        <button type="button" onClick={onClose} aria-label="Close scanner"><X size={16} /></button>
      </form>
    </div>
  );
}
