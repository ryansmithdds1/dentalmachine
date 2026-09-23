import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money } from '../../format.js';
import { ErrorBox } from '../ui.jsx';

// The ambient scribe: record the visit (the browser turns speech into text as it goes), then "Write note":
// the conversation and the chart become a draft note with the work it describes. Review, tick what to add
// to the chart, and save (and sign). The conversation itself isn't kept.
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Scribe({ patient, onSaved }) {
  const { can } = useAuth();
  const { data: status } = useApi('/scribe');
  const [phase, setPhase] = useState('idle'); // idle | recording | paused | writing | review
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [draft, setDraft] = useState(null);
  const [picks, setPicks] = useState({});
  const [note, setNote] = useState('');
  const [sendInstructions, setSendInstructions] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const rec = useRef(null);
  const live = useRef(false);

  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => () => { live.current = false; rec.current?.stop(); }, []);

  const listen = () => {
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onresult = (e) => {
      let fin = '';
      let mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += `${e.results[i][0].transcript} `;
        else mid += e.results[i][0].transcript;
      }
      if (fin) setFinalText((t) => `${t}${fin}`);
      setInterim(mid);
    };
    // The browser stops listening after a pause; keep going until the visit is done.
    r.onend = () => { if (live.current) { try { r.start(); } catch { /* already restarting */ } } };
    r.onerror = (e) => { if (e.error === 'not-allowed') { live.current = false; setError(new Error('Allow the microphone for this site to use the scribe.')); setPhase('idle'); } };
    rec.current = r;
    live.current = true;
    r.start();
  };
  const start = () => { setError(null); setDraft(null); setFinalText(''); setSeconds(0); setPhase('recording'); listen(); };
  const pause = () => { live.current = false; rec.current?.stop(); setPhase('paused'); };
  const resume = () => { setPhase('recording'); listen(); };

  const write = async () => {
    live.current = false;
    rec.current?.stop();
    setPhase('writing');
    setError(null);
    try {
      const d = await api.post('/scribe/draft', { patient_id: patient.id, transcript: `${finalText} ${interim}`.trim(), minutes: Math.round(seconds / 60) });
      setDraft(d);
      setNote(d.note);
      setPicks(Object.fromEntries([...d.completed.map((p, i) => [`c${i}`, p.known]), ...d.planned.map((p, i) => [`p${i}`, p.known]), ...d.conditions.map((_, i) => [`x${i}`, true])]));
      setSendInstructions(false);
      setPhase('review');
    } catch (e) {
      setError(e);
      setPhase('paused');
    }
  };

  const save = async (sign) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post(`/patients/${patient.id}/notes`, { body: note, ...(draft.appointment_id ? { appointment_id: draft.appointment_id } : {}) });
      for (const [list, done] of [[draft.completed, true], [draft.planned, false]]) {
        for (const [i, p] of list.entries()) {
          if (!picks[`${done ? 'c' : 'p'}${i}`] || !p.known) continue;
          await api.post(`/patients/${patient.id}/procedures`, { code: p.code, tooth: p.tooth, surfaces: p.surfaces, complete: done, ...(done && draft.appointment_id ? { appointment_id: draft.appointment_id } : {}) });
        }
      }
      for (const [i, c] of draft.conditions.entries()) if (picks[`x${i}`]) await api.post(`/patients/${patient.id}/conditions`, { tooth: c.tooth, condition: c.condition, surfaces: c.surfaces, notes: c.notes });
      if (sendInstructions && draft.patient_instructions) await api.post(`/patients/${patient.id}/messages`, { body: draft.patient_instructions });
      if (sign) await api.post(`/notes/${saved.id}/sign`);
      await api.post(`/scribe/${draft.session_id}/saved`, { note_id: saved.id, edited: note !== draft.note });
      setPhase('idle');
      setDraft(null);
      setFinalText('');
      onSaved?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!status?.enabled) return null;
  const proc = (p, key) => (
    <label key={key} className="checkbox" style={{ margin: '2px 0' }}>
      <input type="checkbox" disabled={!p.known} checked={!!picks[key]} onChange={(e) => setPicks({ ...picks, [key]: e.target.checked })} />
      <span><strong>{p.code}</strong>{p.tooth ? ` #${p.tooth}` : ''}{p.surfaces ? ` ${p.surfaces}` : ''} · {p.description}{p.fee != null ? ` · ${money(p.fee)}` : ''}{!p.known && <span className="text-danger"> · not in your fee schedule</span>}</span>
    </label>
  );
  return (
    <div className="card scribe">
      <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>AI scribe</h2>
        {phase === 'recording' && <span className="scribe-live">● Recording {clock(seconds)}</span>}
        {phase === 'paused' && <span className="muted">Paused {clock(seconds)}</span>}
      </div>
      <ErrorBox error={error} />
      {phase === 'idle' && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Record the visit and talk normally; the note is written for you from the conversation and the chart. {SR ? '' : 'This browser can’t transcribe — type or paste what was said below.'}</p>
          <div className="inline">
            {SR && <button className="primary" onClick={start}>● Record visit</button>}
            {!SR && <button className="primary" onClick={() => setPhase('paused')}>Type the visit</button>}
          </div>
        </>
      )}
      {(phase === 'recording' || phase === 'paused') && (
        <>
          <textarea className="scribe-transcript" rows={6} value={`${finalText}${interim}`} onChange={(e) => { setFinalText(e.target.value); setInterim(''); }} placeholder="What’s said shows here…" />
          <div className="inline" style={{ marginTop: 8 }}>
            {SR && phase === 'recording' && <button onClick={pause}>Pause</button>}
            {SR && phase === 'paused' && <button onClick={resume}>Resume</button>}
            <button className="primary" disabled={`${finalText}${interim}`.trim().length < 20} onClick={write}>Write note</button>
            <button className="link" onClick={() => { live.current = false; rec.current?.stop(); setPhase('idle'); setFinalText(''); }}>Discard</button>
          </div>
        </>
      )}
      {phase === 'writing' && <p className="muted">Writing the note…</p>}
      {phase === 'review' && draft && (
        <>
          {draft.summary && <div className="muted" style={{ marginBottom: 6 }}>{draft.summary}</div>}
          {draft.missing.length > 0 && <div className="public-notice" style={{ marginBottom: 8, fontSize: 13 }}>Not said, so not in the note: {draft.missing.join(' · ')}</div>}
          <textarea rows={12} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', fontFamily: 'inherit' }} />
          {draft.completed.length > 0 && <><h3>Done today</h3>{draft.completed.map((p, i) => proc(p, `c${i}`))}</>}
          {draft.planned.length > 0 && <><h3>Plan</h3>{draft.planned.map((p, i) => proc(p, `p${i}`))}</>}
          {draft.conditions.length > 0 && (
            <>
              <h3>Chart</h3>
              {draft.conditions.map((c, i) => (
                <label key={i} className="checkbox" style={{ margin: '2px 0' }}>
                  <input type="checkbox" checked={!!picks[`x${i}`]} onChange={(e) => setPicks({ ...picks, [`x${i}`]: e.target.checked })} /> #{c.tooth} {c.condition}{c.surfaces ? ` (${c.surfaces})` : ''}
                </label>
              ))}
            </>
          )}
          {draft.patient_instructions && (
            <label className="checkbox" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={sendInstructions} onChange={(e) => setSendInstructions(e.target.checked)} /> Send the patient these instructions: “{draft.patient_instructions}”
            </label>
          )}
          <div className="inline" style={{ marginTop: 10 }}>
            <button disabled={busy} onClick={() => save(false)}>Save note</button>
            {can('clinical:sign') && <button className="primary" disabled={busy} onClick={() => save(true)}>Save & sign</button>}
            <button className="link" onClick={() => setPhase('paused')}>Back to the conversation</button>
          </div>
        </>
      )}
    </div>
  );
}
