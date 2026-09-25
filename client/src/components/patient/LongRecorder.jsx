import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Square, WifiOff, RotateCw, Trash2, FileText } from 'lucide-react';
import { api, getToken, getLocationId, download } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDateTime } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox, AskButton } from '../ui.jsx';
import { putPart, dropPart, partsFor, putSession, dropSession, openSessions } from './recordingQueue.js';
import './longrecorder.css';

// Long recordings (LR1-LR3): a whole exam or procedure on a computer, phone or iPad. The recorder restarts every
// 30 seconds so each part is a complete file; parts are kept on this device (IndexedDB) until the server has them,
// upload as they go with retries, and a reload picks up where it stopped. After "Stop", the recording is
// transcribed on the server and comes back as a draft note in the office's template with the transcript line for
// each item, plus suggested charting to tick. Nothing is charted or signed until the clinician does it.
const CHUNK_MS = 30_000;
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(Math.floor(s / 3600) ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };
const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) || '';

async function sendPart(sid, part) {
  const res = await fetch(`/api/long-recordings/${sid}/chunks/${part.seq}`, {
    method: 'PUT',
    headers: { 'Content-Type': part.mime || 'audio/webm', Authorization: `Bearer ${getToken()}`, 'X-Start-Ms': String(part.start_ms), 'X-Duration-Ms': String(part.duration_ms), ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) },
    body: part.blob,
  });
  // 409 for a part the server already has with other audio would repeat forever; it's reported, not retried.
  if (res.ok) return 'ok';
  if (res.status === 409) return 'conflict';
  throw new Error(`Upload failed (${res.status})`);
}

export default function LongRecorder({ patient, appointmentId = null, onSaved }) {
  const { can } = useAuth();
  const { data: status } = useApi('/long-recordings/status');
  const { data: history, reload: reloadHistory } = useApi(`/patients/${patient.id}/long-recordings`);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | recording | paused | finishing | waiting | review
  const [session, setSession] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState(null);
  const [leftover, setLeftover] = useState([]);
  const [draft, setDraft] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [note, setNote] = useState('');
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState(false);
  const rec = useRef({ stream: null, recorder: null, seq: 0, clockMs: 0, partStart: 0, startedAt: 0, timer: null, sid: null, uploading: false });

  // Parts left on this device from an earlier page (browser closed, connection lost).
  const refreshLeftover = useCallback(async () => {
    try { setLeftover((await openSessions(patient.id)).filter((s) => s.sid !== rec.current.sid)); } catch { setLeftover([]); }
  }, [patient.id]);
  useEffect(() => { refreshLeftover(); }, [refreshLeftover]);

  // Upload loop: oldest part first; a failure waits (1s, 2s, 4s … 30s) and tries again.
  const drain = useCallback(async (sid) => {
    if (rec.current.uploading) return;
    rec.current.uploading = true;
    let wait = 1000;
    try {
      for (;;) {
        const parts = await partsFor(sid);
        setPending(parts.length);
        if (!parts.length) break;
        try {
          const r = await sendPart(sid, parts[0]);
          if (r === 'conflict') setError(new Error(`Part ${parts[0].seq + 1} conflicts with what the server has — it was kept on this device`));
          await dropPart(sid, parts[0].seq);
          setOffline(false);
          wait = 1000;
        } catch {
          setOffline(true);
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(30_000, wait * 2);
        }
      }
    } finally {
      rec.current.uploading = false;
    }
  }, []);
  useEffect(() => {
    const again = () => rec.current.sid && drain(rec.current.sid);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [drain]);

  // The timer and a clear sign in the tab title while recording; leaving the page asks first.
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const t = setInterval(() => setElapsed(rec.current.clockMs + (Date.now() - rec.current.partStart)), 500);
    const title = document.title;
    document.title = `● REC · ${title}`;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(t); document.title = title; window.removeEventListener('beforeunload', warn); };
  }, [phase]);

  // One recorder per part: started, stopped after 30 seconds (or on pause/stop), its file queued.
  const startPart = () => {
    const r = rec.current;
    const mime = pickMime();
    const recorder = new MediaRecorder(r.stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const seq = r.seq++;
    const start = r.clockMs;
    r.partStart = Date.now();
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const duration = Date.now() - r.partStart;
      r.clockMs = start + duration;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      if (blob.size) {
        await putPart({ sid: r.sid, seq, blob, mime: blob.type, start_ms: start, duration_ms: duration });
        await putSession({ sid: r.sid, patientId: patient.id, parts: r.seq, updatedAt: Date.now() });
        drain(r.sid);
      } else r.seq--; // nothing was recorded in that part
      recorder.done?.();
    };
    recorder.start();
    r.recorder = recorder;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => { if (r.recorder === recorder && recorder.state === 'recording') { stopPart().then(() => rec.current.stream && startPart()); } }, CHUNK_MS);
  };
  const stopPart = () => new Promise((resolve) => {
    const recorder = rec.current.recorder;
    clearTimeout(rec.current.timer);
    if (!recorder || recorder.state === 'inactive') { resolve(); return; }
    recorder.done = resolve;
    rec.current.recorder = null;
    recorder.stop();
  });

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const visit = appointmentId || (await api.get(`/patients/${patient.id}/note-draft`).catch(() => null))?.appointment_id || null;
      const s = await api.post('/long-recordings', { patient_id: patient.id, appointment_id: visit, client_id: newId(), consent: true, mime: pickMime() || 'audio/webm' });
      Object.assign(rec.current, { stream, seq: 0, clockMs: 0, sid: s.id });
      await putSession({ sid: s.id, patientId: patient.id, parts: 0, updatedAt: Date.now() });
      setSession(s);
      setElapsed(0);
      setPhase('recording');
      startPart();
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? new Error('Allow the microphone for this site to record.') : e);
    }
  };
  const pause = async () => {
    await stopPart();
    setPhase('paused');
    api.post(`/long-recordings/${rec.current.sid}/pause`).catch(() => {}); // the pause is noted; the recording is safe either way
  };
  const resume = () => {
    setPhase('recording');
    startPart();
    api.post(`/long-recordings/${rec.current.sid}/resume`).catch(() => {});
  };

  // Stop: the last part, every part uploaded, then the server transcribes.
  const finish = async (sid = rec.current.sid, parts = rec.current.seq) => {
    setPhase('finishing');
    setError(null);
    try {
      if (sid === rec.current.sid) {
        await stopPart();
        rec.current.stream?.getTracks().forEach((t) => t.stop());
        rec.current.stream = null;
        parts = rec.current.seq;
      }
      await drain(sid);
      if ((await partsFor(sid)).length) throw new Error('Some parts are still on this device — they’ll upload when the connection is back. Try Stop again then.');
      await api.post(`/long-recordings/${sid}/finish`, { chunk_count: parts });
      await dropSession(sid);
      setSession(await api.get(`/long-recordings/${sid}`));
      setPhase('waiting');
      refreshLeftover();
      reloadHistory();
    } catch (e) {
      setError(e);
      setPhase(sid === rec.current.sid ? 'paused' : 'idle');
    }
  };

  // While the server transcribes: check every few seconds.
  useEffect(() => {
    if (phase !== 'waiting' || !session) return undefined;
    const t = setInterval(async () => {
      const s = await api.get(`/long-recordings/${session.id}`).catch(() => null);
      if (!s) return;
      setSession(s);
      if (s.status === 'transcribed') openDraft(s.id);
      if (s.status === 'failed') { setPhase('idle'); reloadHistory(); setError(new Error(`Transcription didn’t work yet (${s.last_error || 'unknown'}). It will try again, and it’s listed in Needs attention.`)); }
    }, 4000);
    return () => clearInterval(t);
  }, [phase, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDraft = async (sid) => {
    setError(null);
    try {
      const [d, t] = await Promise.all([api.get(`/long-recordings/${sid}/draft`), api.get(`/long-recordings/${sid}/transcript`)]);
      setDraft(d);
      setTranscript(t);
      setNote(d.note);
      setPicks({});
      setSession(await api.get(`/long-recordings/${sid}`));
      setPhase('review');
    } catch (e) {
      setError(e);
    }
  };

  // Save: the clinician's note (and the charting they ticked), then sign if they chose to. All as this person.
  const save = async (sign) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post(`/patients/${patient.id}/notes`, { body: note, ...(draft.appointment_id ? { appointment_id: draft.appointment_id } : {}) });
      const accepted = [];
      for (const [i, p] of draft.suggested.entries()) {
        if (!picks[i] || !p.known) continue;
        await api.post(`/patients/${patient.id}/procedures`, { code: p.code, tooth: p.tooth, surfaces: p.surfaces, complete: p.status === 'completed', ...(p.status === 'completed' && draft.appointment_id ? { appointment_id: draft.appointment_id } : {}) });
        accepted.push(`${p.code}${p.tooth ? ` #${p.tooth}` : ''} (${p.status})`);
      }
      await api.post(`/long-recordings/${draft.session_id}/saved`, { note_id: saved.id, edited: note !== draft.note, accepted });
      if (sign) await api.post(`/notes/${saved.id}/sign`);
      toast(sign ? 'Note saved and signed' : 'Note saved');
      setPhase('idle');
      setDraft(null);
      setTranscript(null);
      reloadHistory();
      onSaved?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (sid) => { try { await api.post(`/long-recordings/${sid}/retry`); reloadHistory(); } catch (e) { setError(e); } };
  // The reason is typed beside the button (no browser box); Enter removes it.
  const discard = async (sid, reason) => {
    await api.post(`/long-recordings/${sid}/discard`, { reason });
    await dropSession(sid).catch(() => {});
    reloadHistory();
    refreshLeftover();
  };

  if (!status?.enabled || !can('clinical:write')) return null;
  const lineText = (n) => transcript?.lines.find((l) => l.n === n);
  const refs = (lines) => (lines || []).map((n) => {
    const l = lineText(n);
    return <span key={n} className="lr-ref" title={l ? `${l.time} ${l.speaker}${l.separated ? '' : ' (guessed)'}: ${l.text}` : ''}>L{n}</span>;
  });

  return (
    <div className="card lr">
      <div className="lr-head">
        <h2>Record the whole visit</h2>
        {phase === 'recording' && <span className="lr-live" role="status"><span className="lr-dot" /> Recording {clock(elapsed)}</span>}
        {phase === 'paused' && <span className="lr-paused" role="status">Paused {clock(elapsed)}</span>}
        {(phase === 'recording' || phase === 'paused') && (pending > 0 || offline) && <span className="lr-queue">{offline && <WifiOff size={13} />} {pending} part{pending === 1 ? '' : 's'} waiting to upload — kept on this device</span>}
      </div>
      <ErrorBox error={error} />

      {leftover.length > 0 && phase === 'idle' && leftover.map((l) => (
        <div key={l.sid} className="lr-notice">
          A recording from {fmtDateTime(new Date(l.updatedAt).toISOString().slice(0, 16).replace('T', ' '))} wasn’t finished on this device.
          <button className="small primary" onClick={() => finish(l.sid, l.parts)}>Upload and finish</button>
        </div>
      ))}

      {phase === 'idle' && (
        <>
          <p className="muted lr-intro">For a full exam or procedure (an hour or more). It’s saved in 30-second parts as you go, then written up as a draft note for you to review and sign.</p>
          <label className="checkbox lr-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Patient agreed to recording</label>
          <button className="primary" disabled={!consent} onClick={start}><Mic size={15} /> Start recording</button>
        </>
      )}
      {(phase === 'recording' || phase === 'paused') && (
        <div className="lr-controls">
          {phase === 'recording' ? <button onClick={pause}><Pause size={15} /> Pause</button> : <button onClick={resume}><Play size={15} /> Resume</button>}
          <button className="primary" onClick={() => finish()}><Square size={14} /> Stop and write the note</button>
          <span className="muted lr-small">Patient agreed to recording · {rec.current.seq} part{rec.current.seq === 1 ? '' : 's'}</span>
        </div>
      )}
      {phase === 'finishing' && <p className="muted">Saving the last parts…</p>}
      {phase === 'waiting' && <p className="muted">Transcribing {session?.duration || ''} of recording — this can take a few minutes for a long visit. You can leave this page; it’ll be here when it’s done.</p>}

      {phase === 'review' && draft && (
        <div className="lr-review">
          <div className="lr-meta muted">
            Draft from {draft.lines} transcript lines{draft.templates.length ? ` · template: ${draft.templates.join(', ')}` : ''} · speakers {draft.speakers === 'separated' ? 'separated by the speech service, named by guess' : 'guessed from what was said'} · {draft.by === 'ai' ? 'written by AI' : 'written by rules'}
          </div>
          {draft.missing.length > 0 && <div className="lr-missing">Not heard, so not in the note: {draft.missing.join(' · ')}</div>}
          <textarea className="lr-note" rows={14} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Draft note" />
          <div className="lr-sections">
            {draft.sections.filter((s) => s.items.length).map((s) => (
              <div key={s.key} className="lr-section">
                <h3>{s.title}</h3>
                <ul>{s.items.map((i, k) => <li key={k}>{i.text} {refs(i.lines)}</li>)}</ul>
              </div>
            ))}
          </div>
          {draft.suggested.length > 0 && (
            <div className="lr-suggested">
              <h3>Suggested charting — tick what’s right</h3>
              {draft.suggested.map((p, i) => (
                <label key={i} className="checkbox">
                  <input type="checkbox" disabled={!p.known} checked={!!picks[i]} onChange={(e) => setPicks({ ...picks, [i]: e.target.checked })} />
                  <span><strong>{p.code}</strong>{p.tooth ? ` #${p.tooth}` : ''}{p.surfaces ? ` ${p.surfaces}` : ''} · {p.description} · {p.status === 'completed' ? 'done today' : 'plan'}{p.fee != null ? ` · ${money(p.fee)}` : ''} {refs(p.lines)}{!p.known && <span className="text-danger"> · not in your fee schedule</span>}</span>
                </label>
              ))}
            </div>
          )}
          <div className="lr-controls">
            <button disabled={busy} onClick={() => save(false)}>Save note</button>
            {can('clinical:sign') && <button className="primary" disabled={busy} onClick={() => save(true)}>Save & sign</button>}
            <button className="link" onClick={() => download(`/long-recordings/${draft.session_id}/download`, `recording-${draft.session_id}.zip`).catch(setError)}>Download audio</button>
            <button className="link" onClick={() => { setPhase('idle'); setDraft(null); }}>Close</button>
          </div>
          {transcript && (
            <details className="lr-transcript">
              <summary>Transcript ({transcript.lines.length} lines)</summary>
              <ol>{transcript.lines.map((l) => <li key={l.n} value={l.n}><span className="muted">{l.time}</span> <strong>{l.speaker}{l.separated ? '' : '?'}</strong> {l.text}</li>)}</ol>
            </details>
          )}
        </div>
      )}

      {phase === 'idle' && history?.length > 0 && (
        <div className="lr-history">
          {history.slice(0, 5).map((h) => (
            <div key={h.id} className="lr-row">
              <span>{fmtDateTime(h.created_at.replace('T', ' ').slice(0, 16))} · {h.duration} · {h.recorded_by}</span>
              <span className={`badge ${h.status === 'failed' ? 'warn' : h.status === 'transcribed' ? 'ok' : ''}`}>{h.status}</span>
              {h.status === 'transcribed' && !h.note_id && <button className="small" onClick={() => openDraft(h.id)}><FileText size={13} /> Draft note</button>}
              {h.status === 'failed' && <button className="small" onClick={() => retry(h.id)}><RotateCw size={13} /> Retry</button>}
              {!['purged', 'discarded', 'transcribing'].includes(h.status) && <AskButton className="small link" title="Remove the audio and transcript now" label="Why remove it?" placeholder="e.g. patient withdrew consent" required danger submit="Remove recording" onSubmit={(reason) => discard(h.id, reason)}><Trash2 size={13} /></AskButton>}
            </div>
          ))}
          <div className="muted lr-small">Audio and transcripts are kept {status.retention_days} days, then removed; the signed note stays.</div>
        </div>
      )}
    </div>
  );
}
